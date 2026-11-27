/**
 * Phase 3 Part B, item 3 (PLAN.md §5.3, D23, D26–D29), against the scripted runtime (ARIA_FAKE_RUNTIME=ui-cards):
 * "Always allow this" on a decided permission card and on a step your Never rule refused, saved to Customize ›
 * Permissions; a destructive command that asks every time; "Save as memory" on your reply to a task, edited in
 * Customize › Memory and seen in the next task's brief. No model calls, deterministic, real git worktrees.
 * Run after `npm run build`:  npx playwright test ui-flow   (from apps/desktop)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { GIT_NO_FSMONITOR, GIT_TEST_ENV } from "./git-env.ts";

const appDir = path.resolve(import.meta.dirname, "..");
const shots = path.join(appDir, "e2e", ".artifacts");
let base = "";
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
async function newSession(page: Page, brief: string): Promise<void> {
  await page.getByTestId("nav-new-session").click();
  const dialog = page.getByTestId("new-session");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("new-session-brief").fill(brief);
  await dialog.getByTestId("new-session-start").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("session-view")).toBeVisible();
  await page.getByTestId("session-close").click();
}

const card = (page: Page, testId: string, text: string): Locator => page.getByTestId(testId).filter({ hasText: text });

async function customize(page: Page, which: string): Promise<void> {
  await page.getByTestId("nav-customize").click();
  await page.getByTestId(`customize-${which}`).click();
}

test.beforeAll(() => {
  mkdirSync(shots, { recursive: true });
  base = mkdtempSync(path.join(os.tmpdir(), "aria-e2e-flow-"));
  const repo = path.join(base, "GitHub", "Demo App");
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

test("Always allow this and Save as memory", async () => {
  test.setTimeout(5 * 60_000);
  const page = await launch();
  const view = page.getByTestId("session-view");

  // A permission card offers "Always allow…" once it's decided, prefilled with the exact command.
  await newSession(page, "Permission task: pad the versions");
  const first = card(page, "card-permission", "Permission task").filter({ has: page.getByText("P-1", { exact: true }) });
  await expect(first.getByTestId("permission-what")).toHaveText("npm install left-pad");
  await expect(first.getByTestId("always-allow")).toHaveCount(0);
  await first.getByTestId("permission-once").click();
  await expect(first.getByTestId("permission-decision")).toHaveText("Approved once");
  const second = card(page, "card-permission", "Permission task").filter({ has: page.getByText("P-2", { exact: true }) });
  await expect(second.getByTestId("permission-once")).toBeVisible();
  await first.getByTestId("always-allow").click();
  const form = first.getByTestId("always-allow-form");
  await expect(form.getByTestId("offer-match")).toHaveValue("npm install left-pad");
  await expect(form.getByTestId("offer-exact")).toBeChecked();
  await expect(form).toContainText("in every sandboxed task");
  // Made broad, it can't be saved (D26).
  await form.getByTestId("offer-exact").uncheck();
  await expect(form.getByTestId("rule-problem")).toContainText("Only exactly this");
  await expect(form.getByTestId("offer-save")).toBeDisabled();
  await form.getByTestId("offer-exact").check();
  await expect(form.getByTestId("rule-problem")).toHaveCount(0);
  await page.screenshot({ path: path.join(shots, "ui-flow-1-always-allow.png") });
  await form.getByTestId("offer-save").click();
  await expect(first.getByTestId("always-allow-saved")).toBeVisible();
  // A request already waiting still waits for you; the rule counts from the next one.
  await second.getByTestId("permission-once").click();
  await expect(card(page, "card-done", "Permission task")).toBeVisible();

  // In Customize › Permissions: exact, for sandboxed tasks, with a note that names no task.
  await customize(page, "permissions");
  const saved = page.getByTestId("policy-rule").filter({ has: page.locator('[data-testid="rule-match"][value="npm install left-pad"]') });
  await expect(saved).toHaveCount(1);
  await expect(saved.getByTestId("rule-exact")).toBeChecked();
  await expect(saved.getByTestId("rule-scope")).toHaveValue("sandboxed");
  await expect(saved.getByLabel("Why (shown on the card)")).toHaveValue(/^Allowed with “Always allow”, /);
  // A broad Auto rule typed here is refused the same way; a Never rule isn't limited.
  await page.getByTestId("rule-add").click();
  const added = page.getByTestId("policy-rule").last();
  await added.getByTestId("rule-match").fill("curl");
  await added.getByTestId("rule-effect").selectOption("auto");
  await expect(added.getByTestId("rule-problem")).toContainText("Only exactly this");
  await expect(page.getByTestId("rules-save")).toBeDisabled();
  await added.getByTestId("rule-effect").selectOption("never");
  await expect(added.getByTestId("rule-problem")).toHaveCount(0);
  await page.getByTestId("rules-save").click();
  await expect(page.getByTestId("permissions-saved")).toBeVisible();
  await page.getByTestId("nav-aria").click();

  // The next task asking for the same thing runs it on its own.
  await newSession(page, "Permission task: pad again");
  await expect(page.getByTestId("card-done").filter({ hasText: "Permission task" })).toHaveCount(2);
  await expect(page.getByTestId("card-permission")).toHaveCount(2);

  // A step your Never rule refused offers it too, in the session view; running past your rule needs a confirmation.
  await newSession(page, "Fetch task: get the page");
  await expect(card(page, "card-done", "Fetch task")).toBeVisible();
  await card(page, "card-task", "Fetch task").getByTestId("task-open").click();
  const step = view.getByTestId("step-offer");
  // The step says your rule refused it, not that it failed.
  await expect(view.getByTestId("transcript-refused")).toContainText("your rule “curl” (Never)");
  await step.getByTestId("always-allow").click();
  // The form takes the focus; Escape cancels it (the session view stays) and the focus goes back to its button.
  await expect(step.getByTestId("offer-match")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(step.getByTestId("always-allow-form")).toHaveCount(0);
  await expect(view).toBeVisible();
  await expect(step.getByTestId("always-allow")).toBeFocused();
  await step.getByTestId("always-allow").click();
  await expect(step.getByTestId("offer-match")).toHaveValue("curl https://example.com");
  await expect(step.getByTestId("offer-override")).toContainText("`curl` (Never) stays for everything else");
  await expect(step.getByTestId("offer-save")).toBeDisabled();
  await step.getByTestId("offer-confirm").check();
  await page.screenshot({ path: path.join(shots, "ui-flow-2-refused-step.png") });
  await step.getByTestId("offer-save").click();
  await expect(step.getByTestId("always-allow-saved")).toBeVisible();
  await view.getByTestId("session-close").click();

  // A destructive command asks every time: Approve once or Reject, and no Always allow.
  await newSession(page, "Reset task: start over");
  const reset = card(page, "card-permission", "Reset task");
  await expect(reset.getByTestId("permission-what")).toHaveText("git reset --hard");
  await expect(reset.getByTestId("permission-every-time")).toBeVisible();
  await expect(reset.getByTestId("permission-task")).toHaveCount(0);
  await page.screenshot({ path: path.join(shots, "ui-flow-3-destructive.png") });
  await reset.getByTestId("permission-once").click();
  await expect(card(page, "card-done", "Reset task")).toBeVisible();
  await expect(reset.getByTestId("always-allow")).toHaveCount(0);

  // Save as memory on your reply to a task: your words, for its project.
  await newSession(page, "Name task: new service");
  const question = card(page, "card-question", "Name task");
  await question.getByTestId("question-reply-to").click();
  await page.getByTestId("composer").fill("Call it Comet");
  await page.getByTestId("composer").press("Enter");
  await expect(question.getByTestId("question-answer")).toContainText("Call it Comet");
  const reply = page.locator("div", { has: page.getByTestId("msg-user").filter({ hasText: "Call it Comet" }) }).last();
  await reply.getByTestId("save-memory").click();
  const note = reply.getByTestId("memory-form");
  await expect(note.getByTestId("memory-text")).toHaveValue("Call it Comet");
  await expect(note.getByTestId("memory-scope")).toHaveValue("project");
  await note.getByTestId("memory-text").fill("The new service is called Comet");
  await note.getByTestId("memory-save").click();
  await expect(reply.getByTestId("memory-saved")).toContainText("the next tasks in Demo App get it in their brief");
  // Your own answer on the card offers it as well.
  await expect(question.getByTestId("save-memory")).toBeVisible();

  // Customize › Memory: where it came from, edited there.
  await customize(page, "memory");
  const row = page.getByTestId("memory-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("From your answer to Name task");
  await row.getByTestId("memory-row-text").fill("The new service is called Comet (not Atlas)");
  await row.getByTestId("memory-row-save").click();
  await expect(page.getByTestId("memory-row").getByTestId("memory-row-save")).toHaveCount(0);
  await page.screenshot({ path: path.join(shots, "ui-flow-4-memory.png") });
  await page.getByTestId("nav-aria").click();

  // The next task's brief has it.
  await newSession(page, "Docs task: write the docs");
  await expect(card(page, "card-done", "Docs task")).toBeVisible();
  await card(page, "card-task", "Docs task").getByTestId("task-open").click();
  await expect(view.getByTestId("transcript-user").first()).toContainText("Notes from the user (saved in ARIA, in their own words)");
  await expect(view.getByTestId("transcript-user").first()).toContainText("- The new service is called Comet (not Atlas)");
  await view.getByTestId("session-close").click();

  // Deleted, with a confirmation.
  await customize(page, "memory");
  await page.getByTestId("memory-row-delete").click();
  // The focus follows the confirmation (Keep), and goes to "Add a note" once the row is gone.
  await expect(page.getByRole("button", { name: "Keep" })).toBeFocused();
  await page.getByTestId("memory-row-delete-confirm").click();
  await expect(page.getByTestId("memory-row")).toHaveCount(0);
  await expect(page.getByTestId("memory-add-text")).toBeFocused();
});
