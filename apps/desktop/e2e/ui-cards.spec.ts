/**
 * Every task card and the views around them, against a scripted runtime (ARIA_FAKE_RUNTIME=ui-cards): no model calls,
 * no credits, deterministic. The scripted workers still do real work in real worktrees of a throwaway repo, through the
 * real task manager and worker policy. Run after `npm run build`:  npx playwright test ui-cards   (from apps/desktop)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { GIT_NO_FSMONITOR, GIT_TEST_ENV } from "./git-env.ts";

const appDir = path.resolve(import.meta.dirname, "..");
const shots = path.join(appDir, "e2e", ".artifacts");
let base = "";
let repo = "";
let env: Record<string, string> = {};
let app: ElectronApplication | undefined;

const git = (cwd: string, ...args: string[]) => execFileSync("git", [...GIT_NO_FSMONITOR, "-c", "user.name=ARIA E2E", "-c", "user.email=e2e@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();

async function launch(): Promise<Page> {
  app = await electron.launch({ args: [appDir], env, timeout: 60_000 });
  const page = await app.firstWindow();
  await expect(page.getByTestId("status")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  return page;
}

/** Starts a task yourself through the New session dialog, then closes the session view it opens. */
async function newSession(page: Page, brief: string, profile?: string): Promise<void> {
  await page.getByTestId("nav-new-session").click();
  const dialog = page.getByTestId("new-session");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("new-session-brief").fill(brief);
  if (profile) {
    const select = dialog.getByTestId("new-session-profile");
    await select.selectOption((await select.locator("option", { hasText: `${profile} ·` }).first().getAttribute("value"))!);
  }
  await dialog.getByTestId("new-session-start").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("session-view")).toBeVisible();
  await page.getByTestId("session-close").click();
}

const card = (page: Page, testId: string, text: string): Locator => page.getByTestId(testId).filter({ hasText: text });

test.beforeAll(() => {
  mkdirSync(shots, { recursive: true });
  base = mkdtempSync(path.join(os.tmpdir(), "aria-e2e-"));
  repo = path.join(base, "GitHub", "Demo App");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "# Demo App\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Initial commit");
  const inherited = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  env = {
    ...inherited,
    ...GIT_TEST_ENV,
    ARIA_FAKE_RUNTIME: "ui-cards",
    ARIA_DATA_DIR: path.join(base, "data"),
    ARIA_PROJECT_ROOTS: path.join(base, "GitHub"),
    ARIA_WORKTREE_ROOT: path.join(base, "wt"),
  };
});

test.afterAll(async () => {
  await app?.close().catch(() => {
    // Teardown: the app may be gone already, and the test has its result.
  });
  if (base) rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

test("task cards: question, budget, failure, restart, discard; session view; profiles", async () => {
  test.setTimeout(5 * 60_000);
  let page = await launch();
  const project = page.locator('[data-testid="project"][data-project="Demo App"]');
  await expect(project).toBeVisible();
  const view = page.getByTestId("session-view");

  // The New session dialog is modal and Escape cancels it.
  await page.getByTestId("nav-new-session").click();
  await expect(page.getByTestId("new-session-brief")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("new-session")).toHaveCount(0);

  // A reply's code blocks are highlighted, each with its grammar's colours (`const` is a keyword). The window's CSP
  // refuses WebAssembly, so Shiki runs on its JavaScript regex engine: on its default engine every block stayed plain.
  await page.getByTestId("composer").fill("Stream a long reply at once");
  await page.getByTestId("composer").press("Enter");
  const reply = page.getByTestId("msg-assistant").filter({ hasText: "Part 20 of a long answer" });
  await expect(reply.locator(".shiki-wrap")).toHaveCount(20);
  await expect(reply.locator("pre:not(.shiki)")).toHaveCount(0);
  await expect(reply.locator(".shiki-wrap").first().locator("span", { hasText: /^const$/ })).toHaveAttribute("style", /color:#F97583/i);

  // A question: the card shows its choices, the header counts it, and the answer lets the task finish (D17).
  await newSession(page, "Question task: add a theme toggle");
  const question = card(page, "card-question", "Question task");
  await expect(question).toBeVisible();
  await expect(page.getByTestId("needs-you")).toHaveText("1 needs you");
  await expect(project.getByTestId("session")).toHaveAttribute("data-state", "waiting_input");
  await page.screenshot({ path: path.join(shots, "ui-1-question.png") });
  // It can be answered in its session too, where a message can't slip past the question.
  await card(page, "card-task", "Question task").getByTestId("task-open").click();
  const ask = view.getByTestId("session-question");
  await expect(ask).toContainText("Should the toggle live in Settings or in the header?");
  await expect(view.getByTestId("session-composer")).toBeDisabled();
  await page.screenshot({ path: path.join(shots, "ui-1b-session-question.png") });
  await ask.getByTestId("question-choice").filter({ hasText: "Header" }).click();
  await expect(question.getByTestId("question-answer")).toHaveText("→ Header");
  await expect(ask).toBeHidden();
  await expect(page.getByTestId("needs-you")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(view).toBeHidden();
  const questionDone = card(page, "card-done", "Question task");
  await expect(questionDone).toBeVisible();
  await expect(questionDone.getByTestId("done-stats")).toContainText("1 file changed");
  await expect(questionDone.getByTestId("done-stats")).toContainText("in 1 commit");

  // The session view: the question and its answer in the transcript, and the change in the diff.
  await questionDone.getByTestId("done-diff").click();
  await expect(view.locator('[data-testid="diff-file"][data-path="theme.txt"]')).toContainText("toggle: header");
  await view.getByTestId("session-tab-transcript").click();
  await expect(view.getByTestId("transcript-question")).toContainText("→ Header");
  await expect(view.locator('[data-testid="transcript-tool"][data-tool="powershell"]')).toBeVisible();
  await page.screenshot({ path: path.join(shots, "ui-2-session.png") });
  await view.getByTestId("session-close").click();
  // Continue opens its session ready for more instructions.
  await questionDone.getByTestId("done-continue").click();
  await expect(view.getByTestId("session-composer")).toBeFocused();
  await expect(view.getByTestId("session-continue")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(view).toBeHidden();

  // A budget pause: its card, the live strip while the sidebar is collapsed, its session, and Continue.
  await newSession(page, "Budget task: a long job", "Default");
  const budget = card(page, "card-budget", "Budget task");
  await expect(budget).toBeVisible();
  await expect(budget).toContainText("It used 24 credits of its 20 credits");
  await page.getByTestId("toggle-sidebar").click();
  await expect(page.getByTestId("live-strip").getByTestId("live-chip")).toHaveCount(1);
  await page.screenshot({ path: path.join(shots, "ui-3-budget.png") });
  await page.getByTestId("live-chip").click();
  await page.getByTestId("toggle-sidebar").click();
  await card(page, "card-task", "Budget task").getByTestId("task-open").click();
  await expect(view.getByTestId("session-budget")).toContainText("It used 24 credits of its 20 credits");
  await expect(view.getByTestId("session-queue")).toBeVisible();
  await page.screenshot({ path: path.join(shots, "ui-3b-session-budget.png") });
  // What you type goes along when you continue from the session.
  await expect(budget.getByTestId("budget-continue")).toBeVisible();
  await view.getByTestId("session-composer").fill("Also note it in the changelog");
  await expect(view.getByTestId("session-budget-continue")).toHaveText("Send and continue (+20 credits)");
  await view.getByTestId("session-budget-continue").click();
  await expect(view.getByTestId("session-composer")).toHaveValue("");
  await expect(card(page, "card-done", "Budget task")).toBeVisible();
  await expect(card(page, "card-done", "Budget task")).toContainText("Finished the long job");
  // The pause card says how it ended, not that it's still paused.
  await expect(budget.getByTestId("budget-status")).toHaveText("It used 24 credits of its 20 credits. You raised its budget to 40 credits.");
  await expect(view.getByTestId("transcript-user").filter({ hasText: "Also note it in the changelog" })).toHaveCount(1);
  await view.getByTestId("session-close").click();

  // A failure, then Retry continues it in the same session.
  await newSession(page, "Failing task: call a flaky API");
  const failed = card(page, "card-failed", "Failing task");
  await expect(failed).toContainText("The model is overloaded");
  await failed.getByTestId("failed-retry").click();
  await expect(card(page, "card-done", "Failing task")).toContainText("Succeeded on the second try");

  // Closing ARIA while a task works: it's interrupted, and Resume finishes it.
  await newSession(page, "Slow task: take your time");
  await expect(card(page, "card-task", "Slow task").getByTestId("task-state")).toHaveAttribute("data-state", "running");
  await app!.close();
  page = await launch();
  const interrupted = page.getByTestId("card-interrupted");
  await expect(interrupted).toContainText("Slow task");
  await page.screenshot({ path: path.join(shots, "ui-4-interrupted.png") });
  await interrupted.getByTestId("interrupted-resume").click();
  await expect(card(page, "card-done", "Slow task")).toContainText("Picked up where it left off");

  // Discard removes the worktree, the branch and the session.
  const doneQuestion = card(page, "card-done", "Question task");
  const worktree = path.join(base, "wt", "demo-app", "question-task-add-a-theme-toggle");
  expect(existsSync(worktree)).toBe(true);
  await doneQuestion.getByTestId("done-discard").click();
  await doneQuestion.getByTestId("done-discard-confirm").click();
  await expect(page.getByTestId("card-task").filter({ hasText: "A task that was discarded" })).toHaveCount(1);
  await expect(page.locator('[data-testid="project"][data-project="Demo App"] [data-testid="session"]')).toHaveCount(3);
  expect(existsSync(worktree)).toBe(false);
  expect(git(repo, "branch", "--list", "aria/question-task-add-a-theme-toggle")).toBe("");
  expect(git(repo, "branch", "--show-current")).toBe("main");

  // Worker profiles in Customize: add one, make it the default, pick the policy, delete it.
  await page.getByTestId("nav-customize").click();
  const profiles = page.getByTestId("worker-profiles");
  // Default, Quick, Deep and (item 4, D47: new installs) CI fix, which "Fix it uses" names.
  await expect(profiles.getByTestId("profile")).toHaveCount(4);
  await expect(profiles.getByTestId("fix-it-uses-select").locator("option:checked")).toHaveText("CI fix");
  await profiles.getByTestId("profile-add").click();
  const form = profiles.getByTestId("profile-form");
  await form.getByTestId("profile-name").fill("Docs");
  await form.getByTestId("profile-model").selectOption("fake-light");
  await form.getByTestId("profile-budget").fill("abc");
  await expect(form.getByTestId("profile-budget-error")).toBeVisible();
  await expect(form.getByTestId("profile-save")).toBeDisabled();
  await form.getByTestId("profile-budget").fill("5");
  await expect(form.getByTestId("profile-budget-error")).toHaveCount(0);
  await form.getByTestId("profile-save").click();
  const docs = profiles.locator('[data-testid="profile"][data-profile="Docs"]');
  await expect(docs).toContainText("pauses at 5 credits");
  await docs.getByTestId("profile-default").click();
  await expect(docs).toContainText("default");
  await profiles.getByTestId("policy-aria").check();
  await expect(profiles.getByTestId("policy-aria")).toBeChecked();
  await page.screenshot({ path: path.join(shots, "ui-5-profiles.png") });
  await docs.getByTestId("profile-delete").click();
  await expect(profiles.getByTestId("profile")).toHaveCount(4);

  await app!.close();
  app = undefined;
});
