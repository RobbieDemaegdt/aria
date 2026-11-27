/**
 * Phase 3, ARIA in the loop (PLAN.md §10 Phase 3 "done when"), against the scripted runtime (ARIA_FAKE_RUNTIME=ui-cards):
 * three tasks ask at once and are answered from the one chat (a button, a reply, and plain words through ARIA); a
 * permission request approved for the rest of its task; a plan; a changed brief template reaching the next task; a
 * proposal under "Ask me"; and Customize › Permissions. No model calls, deterministic, real git worktrees.
 * Run after `npm run build`:  npx playwright test ui-attention   (from apps/desktop)
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
async function newSession(page: Page, brief: string, options: { profile?: string; mode?: string } = {}): Promise<void> {
  await page.getByTestId("nav-new-session").click();
  const dialog = page.getByTestId("new-session");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("new-session-brief").fill(brief);
  if (options.profile) {
    const select = dialog.getByTestId("new-session-profile");
    await select.selectOption((await select.locator("option", { hasText: `${options.profile} ·` }).first().getAttribute("value"))!);
  }
  if (options.mode) await dialog.getByTestId("new-session-mode").selectOption(options.mode);
  await dialog.getByTestId("new-session-start").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("session-view")).toBeVisible();
  await page.getByTestId("session-close").click();
}

const card = (page: Page, testId: string, text: string): Locator => page.getByTestId(testId).filter({ hasText: text });

async function say(page: Page, text: string): Promise<void> {
  await page.getByTestId("composer").fill(text);
  await page.getByTestId("composer").press("Enter");
}

test.beforeAll(() => {
  mkdirSync(shots, { recursive: true });
  base = mkdtempSync(path.join(os.tmpdir(), "aria-e2e-"));
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
    // Opening ARIA's conversation takes a moment, so the inspector can be seen while it reopens.
    ARIA_FAKE_CONDUCTOR_DELAY_MS: "2500",
  };
});

test.afterAll(async () => {
  await app?.close().catch(() => {
    // Teardown: the app may be gone already, and the test has its result.
  });
  if (base) rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

test("ARIA in the loop: questions at once, a permission, a plan, prompts, a proposal", async () => {
  test.setTimeout(5 * 60_000);
  const page = await launch();
  const view = page.getByTestId("session-view");
  const composer = page.getByTestId("composer");

  // Three tasks ask at the same time; each question has its own short id.
  await newSession(page, "Header task: theme toggle");
  await newSession(page, "Name task: new service");
  await newSession(page, "Login task: fix the login");
  const header = card(page, "card-question", "Header task");
  const name = card(page, "card-question", "Name task");
  const login = card(page, "card-question", "Login task");
  for (const question of [header, name, login]) await expect(question.getByTestId("question-reply-to")).toBeVisible();
  await expect(page.getByTestId("needs-you")).toHaveText("3 need you");
  // The ARIA row in the sidebar has the same count (PLAN.md §5.2).
  await expect(page.getByTestId("nav-needs-you")).toHaveText("3");
  const [headerId, nameId, loginId] = await Promise.all([header, name, login].map((c) => c.getByTestId("short-id").innerText()));
  expect([headerId, nameId, loginId].sort()).toEqual(["Q-1", "Q-2", "Q-3"]);
  await page.screenshot({ path: path.join(shots, "ui-p3-1-questions.png") });

  // 1. A button on its card.
  await header.getByTestId("question-choice").filter({ hasText: "Header" }).click();
  await expect(header.getByTestId("question-answer")).toHaveText("→ Header");

  // 2. Reply: the badge says where your message goes, and it goes straight to the task (not to ARIA).
  await name.getByTestId("question-reply-to").click();
  const badge = page.getByTestId("reply-badge");
  await expect(badge).toContainText(`Replying to Name task: new service · ${nameId}`);
  await expect(composer).toBeFocused();
  await page.screenshot({ path: path.join(shots, "ui-p3-2-reply.png") });
  await composer.fill("Beacon");
  await composer.press("Enter");
  await expect(badge).toBeHidden();
  await expect(name.getByTestId("question-answer")).toHaveText("→ Beacon");
  await expect(page.getByTestId("msg-routed").last()).toContainText(`Answer to Name task: new service · ${nameId}`);

  // 3. Plain words to ARIA: it sees the question in its digest and answers it by its id.
  await say(page, "Use cookies for the login one");
  await expect(page.getByTestId("msg-assistant").last()).toContainText("Answered the login question");
  await expect(login.getByTestId("question-answer")).toHaveText("→ Cookies");
  for (const title of ["Header task", "Name task", "Login task"]) await expect(card(page, "card-done", title)).toBeVisible();
  await expect(page.getByTestId("needs-you")).toBeHidden();
  await expect(page.getByTestId("nav-needs-you")).toBeHidden();

  // The inspector (PLAN.md §5.3, Part B item 1): what ARIA was sent with that message, the tool it called, its answer.
  await page.getByTestId("inspect-aria").click();
  const inspector = page.getByTestId("inspector");
  await expect(inspector).toBeVisible();
  // The focus moves into it when it opens.
  await expect(inspector.getByTestId("inspector-scroller")).toBeFocused();
  const cookies =inspector.getByTestId("inspector-turn").filter({ hasText: "Use cookies for the login one" });
  await expect(cookies.getByTestId("inspector-message")).toHaveText("Use cookies for the login one");
  await expect(cookies.getByTestId("inspector-digest-toggle")).toContainText("1 waiting");
  await cookies.getByTestId("inspector-digest-toggle").click();
  await expect(cookies.getByTestId("inspector-digest-text")).toContainText(`<pending>\n- ${loginId}: "Login task: fix the login"`);
  const answered = cookies.locator('[data-testid="transcript-tool"][data-tool="answer_question"]');
  await answered.getByRole("button").first().click();
  await expect(answered).toContainText('"answer": "cookies"');
  await expect(cookies.getByTestId("inspector-answer")).toContainText("Answered the login question: cookies.");
  await expect(cookies.getByTestId("inspector-took")).toBeVisible();
  await page.screenshot({ path: path.join(shots, "ui-p3b-1-inspector.png") });
  // Live: another message to ARIA shows up as its own turn while the inspector is open, with what finished meanwhile.
  await say(page, "What's done?");
  const next = inspector.getByTestId("inspector-turn").filter({ hasText: "What's done?" });
  await expect(next.getByTestId("inspector-answer")).toContainText("echo:");
  await expect(next.getByTestId("inspector-digest-toggle")).toContainText("update");
  await expect(inspector.getByTestId("inspector-turn")).toHaveCount(2);
  // Inspect while it's open (the focus is in the composer now) brings the focus back, without reading it again.
  await expect(page.getByTestId("composer")).toBeFocused();
  await page.getByTestId("inspect-aria").click();
  await expect(inspector.getByTestId("inspector-scroller")).toBeFocused();
  await expect(inspector.getByTestId("inspector-turn")).toHaveCount(2);
  await inspector.getByTestId("inspector-close").click();
  await expect(inspector).toBeHidden();
  // The sidebar's Inspect button is reachable by keyboard: Tab from the ARIA row. Opened that way, the focus moves into
  // the pane and shows its ring.
  await page.getByTestId("nav-aria").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("nav-inspect")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(inspector.getByTestId("inspector-turn")).toHaveCount(2);
  await expect(inspector.getByTestId("inspector-scroller")).toBeFocused();
  expect(await inspector.getByTestId("inspector-scroller").evaluate((el) => el.matches(":focus-visible") && getComputedStyle(el).boxShadow !== "none")).toBe(true);
  await page.keyboard.press("Escape");
  await expect(inspector).toBeHidden();
  // Closed with Escape, the focus goes back to the Inspect button that opened it (not to the page).
  await expect(page.getByTestId("nav-inspect")).toBeFocused();

  // Opened while ARIA reopens its conversation (after an edit of its prompt): it fills in by itself once ARIA is
  // ready.
  const editAriaPrompt = async (line: string) => {
    await page.getByTestId("nav-customize").click();
    await page.getByTestId("customize-prompts").click();
    await page.locator('[data-testid="prompt-item"][data-prompt="conductor"]').click();
    const text = page.getByTestId("prompt-text");
    // Its text replaces the one shown before (the brief template) once it's picked.
    await expect(text).toHaveValue(/^You are ARIA/);
    await text.fill(`${await text.inputValue()}\n${line}`);
    await page.getByTestId("prompt-save").click();
    await expect(page.getByTestId("prompt-saved")).toBeVisible();
    await page.getByTestId("nav-aria").click();
  };
  await editAriaPrompt("Keep answers short.");
  await say(page, "After the prompt edit");
  await expect(page.getByTestId("status")).toHaveAttribute("data-state", "starting");
  await page.getByTestId("inspect-aria").click();
  // Not an error: said quietly, with nothing to retry.
  await expect(inspector.getByTestId("inspector-opening")).toHaveText("ARIA is opening its conversation. This fills in when it's ready.");
  await expect(inspector.getByTestId("inspector-error")).toHaveCount(0);
  await expect(inspector.getByTestId("inspector-turn")).toHaveCount(3);
  await expect(inspector.getByTestId("inspector-opening")).toBeHidden();
  await expect(inspector.getByTestId("inspector-error")).toBeHidden();
  // Open while it reopens again: what it shows stays, marked as from before, and the new message joins it.
  await editAriaPrompt("Use plain words.");
  await say(page, "After the second edit");
  await expect(inspector.getByTestId("inspector-reconnecting")).toHaveText("ARIA is opening its conversation: what's below is from before.");
  await expect(inspector.getByTestId("inspector-turn")).toHaveCount(3);
  await page.screenshot({ path: path.join(shots, "ui-p3b-2-inspector-reconnecting.png") });
  await expect(inspector.getByTestId("inspector-turn")).toHaveCount(4);
  await expect(inspector.getByTestId("inspector-reconnecting")).toBeHidden();
  await inspector.getByTestId("inspector-close").click();
  await expect(inspector).toBeHidden();

  // @mention: a message straight to a finished task, which continues with it. Escape closes the list; typing on opens it.
  await composer.fill("@head");
  await expect(page.getByTestId("mention-option").first()).toContainText("@header-task-theme-toggle");
  await composer.press("Escape");
  await expect(page.getByTestId("mention-list")).toBeHidden();
  await composer.pressSequentially("e");
  await expect(page.getByTestId("mention-option").first()).toContainText("@header-task-theme-toggle");
  await composer.press("Tab");
  await expect(composer).toHaveValue("@header-task-theme-toggle ");
  await composer.pressSequentially("Add a tooltip too");
  await composer.press("Enter");
  await expect(page.getByTestId("msg-routed").last()).toContainText("Message to Header task: theme toggle");

  // A permission request, approved for the rest of the task: the same request later doesn't ask again (D21).
  await newSession(page, "Permission task: pad the versions");
  const permission = card(page, "card-permission", "Permission task");
  await expect(permission.getByTestId("permission-what")).toHaveText("npm install left-pad");
  await expect(permission).toContainText("For: Pad the version numbers");
  await expect(permission.getByTestId("permission-reason")).toContainText("Adds a package");
  await expect(permission.getByTestId("short-id")).toHaveText("P-1");
  // Its task card offers no Reply meanwhile: a reply would only look like a decision.
  await expect(card(page, "card-task", "Permission task").getByTestId("task-reply")).toHaveCount(0);
  await page.screenshot({ path: path.join(shots, "ui-p3-3-permission.png") });
  await permission.getByTestId("permission-task").click();
  await expect(permission.getByTestId("permission-decision")).toHaveText("Approved for the rest of the task");
  const padded = card(page, "card-done", "Permission task");
  await expect(padded).toBeVisible();
  await expect(page.getByTestId("card-permission")).toHaveCount(1);
  await card(page, "card-task", "Permission task").getByTestId("task-open").click();
  await expect(view.getByTestId("session-sandboxed")).toBeVisible();
  await expect(view.getByTestId("session-grant")).toContainText("npm install left-pad");
  await view.getByTestId("session-close").click();

  // A plan: the task waits for your review, then carries it out.
  await newSession(page, "Plan task: dark mode", { mode: "plan" });
  const plan = card(page, "card-plan", "Plan task");
  await expect(plan.getByTestId("plan-summary")).toContainText("Add a dark mode");
  await expect(plan.getByTestId("short-id")).toHaveText("L-1");
  await expect(plan.locator("details")).toHaveCount(0);
  await page.screenshot({ path: path.join(shots, "ui-p3-4-plan.png") });
  // The whole plan is read in the session's Plan tab; the card stays a pointer to it.
  await plan.getByTestId("plan-open-session").click();
  await expect(view.getByTestId("session-plan-tab")).toBeVisible();
  await view.getByTestId("session-close").click();
  await plan.getByTestId("plan-autopilot").click();
  await expect(plan.getByTestId("plan-decision")).toContainText("Approved");
  await expect(card(page, "card-done", "Plan task")).toBeVisible();

  // Customize › Prompts: a changed brief template reaches the next task; a broken one is refused.
  await page.getByTestId("nav-customize").click();
  await page.getByTestId("customize-prompts").click();
  await page.locator('[data-testid="prompt-item"][data-prompt="brief"]').click();
  await page.getByTestId("prompt-text").fill("No brief here");
  await expect(page.getByTestId("prompt-problem")).toContainText("{{brief}}");
  await expect(page.getByTestId("prompt-save")).toBeDisabled();
  await page.getByTestId("prompt-text").fill("TEMPLATE V2 for {{title}}\n\n{{brief}}\n\n{{environment}}");
  await expect(page.getByTestId("prompt-problem")).toHaveCount(0);
  await page.getByTestId("prompt-note").fill("Shorter brief");
  await page.getByTestId("prompt-save").click();
  await expect(page.getByTestId("prompt-saved")).toBeVisible();
  await expect(page.getByTestId("prompt-version")).toHaveCount(1);
  await expect(page.getByTestId("prompt-version")).toContainText("Shorter brief");
  await page.screenshot({ path: path.join(shots, "ui-p3-5-prompts.png") });
  await page.getByTestId("nav-aria").click();
  await newSession(page, "Template task: check the brief");
  await expect(card(page, "card-done", "Template task")).toBeVisible();
  await card(page, "card-task", "Template task").getByTestId("task-open").click();
  await expect(view.getByTestId("transcript-user").first()).toContainText("TEMPLATE V2 for Template task: check the brief");
  await view.getByTestId("session-close").click();

  // "Ask me": ARIA proposes a task, and nothing runs until you press Start (with the profile you pick).
  await page.getByTestId("nav-customize").click();
  await page.getByTestId("customize-models").click();
  await page.getByTestId("policy-ask").check();
  await page.getByTestId("nav-aria").click();
  await say(page, "propose a docs task");
  const proposal = card(page, "card-proposal", "Write docs");
  await expect(proposal).toContainText("Why Deep: Docs need care.");
  await expect(proposal.getByTestId("proposal-brief")).toBeVisible();
  await expect(page.getByTestId("card-task").filter({ hasText: "Write docs" })).toHaveCount(0);
  await page.screenshot({ path: path.join(shots, "ui-p3-6-proposal.png") });
  const profile = proposal.getByTestId("proposal-profile");
  await profile.selectOption((await profile.locator("option", { hasText: "Quick ·" }).first().getAttribute("value"))!);
  await proposal.getByTestId("proposal-start").click();
  await expect(proposal.getByTestId("proposal-decision")).toContainText("With Quick");
  await expect(card(page, "card-done", "Write docs")).toBeVisible();

  // Customize › Permissions: the sandbox's state and the rules for commands.
  await page.getByTestId("nav-customize").click();
  await page.getByTestId("customize-permissions").click();
  await expect(page.getByTestId("sandbox-status")).toContainText("This PC can run the sandbox");
  await expect(page.getByTestId("sandbox-enabled")).toBeChecked();
  await page.getByTestId("rule-add").click();
  await page.getByTestId("rule-match").last().fill("curl");
  await page.getByTestId("rule-effect").last().selectOption("never");
  // A rule you haven't saved yet survives a change to the sandbox settings.
  await page.getByTestId("sandbox-enabled").uncheck();
  await expect(page.getByTestId("sandbox-enabled")).not.toBeChecked();
  await page.getByTestId("sandbox-enabled").check();
  await expect(page.getByTestId("sandbox-enabled")).toBeChecked();
  await expect(page.getByTestId("sandbox-enabled")).toBeEnabled();
  await expect(page.getByTestId("rule-match").last()).toHaveValue("curl");
  await page.getByTestId("rules-save").click();
  await expect(page.getByTestId("permissions-saved")).toHaveText("Saved. Applies to the next request of every task.");
  await page.screenshot({ path: path.join(shots, "ui-p3-7-permissions.png") });
  // Back to the defaults only once you confirm.
  await page.getByTestId("rules-reset").click();
  await page.getByTestId("rules-reset-confirm").click();
  await expect(page.getByTestId("permissions-saved")).toHaveText("Back to the default rules.");
  await expect(page.getByTestId("rule-match").last()).not.toHaveValue("curl");

  await app!.close();
  app = undefined;
});
