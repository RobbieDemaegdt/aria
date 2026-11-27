/**
 * Phase 3 Part B, item 4 (PLAN.md §4.13, D22, D30–D34), against the scripted runtime (ARIA_FAKE_RUNTIME=ui-cards) with
 * the test hooks (ARIA_E2E_HOOKS=1: the sign-in page is recorded, no browser opens): Customize › Integrations lists
 * the servers with their source and status, signs in to one that needs it, shows each tool's class and the rules its
 * class allows, and the rules hold for ARIA and for tasks. No model calls, no real sign-in, deterministic.
 * Run after `npm run build`:  npx playwright test ui-integrations   (from apps/desktop)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { GIT_NO_FSMONITOR, GIT_TEST_ENV } from "./git-env.ts";
import { useAcmeTracker } from "./acme.ts";

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
const server = (page: Page, name: string) => page.locator(`[data-testid="integrations-server"][data-server="${name}"]`);
const toolRow = (page: Page, wire: string) => page.locator(`[data-testid="integration-tool"][data-wire="${wire}"]`);
async function openGroup(page: Page, name: string): Promise<void> {
  const group = page.locator(`[data-testid="integrations-group"][data-server="${name}"] > button`);
  if ((await group.getAttribute("aria-expanded")) !== "true") await group.click();
}
async function integrationsPage(page: Page): Promise<void> {
  await page.getByTestId("nav-customize").click();
  await page.getByTestId("customize-integrations").click();
  await expect(page.getByTestId("integrations-servers")).toBeVisible();
}
const options = (select: Locator) => select.locator("option").evaluateAll((all) => all.map((o) => (o as HTMLOptionElement).value));

test.beforeAll(() => {
  mkdirSync(shots, { recursive: true });
  base = mkdtempSync(path.join(os.tmpdir(), "aria-e2e-integrations-"));
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
    ARIA_E2E_HOOKS: "1",
    ARIA_DATA_DIR: path.join(base, "data"),
    ...useAcmeTracker(path.join(base, "data")),
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

test("Customize › Integrations: servers, Sign in, and rules that hold for ARIA and for tasks", async () => {
  test.setTimeout(5 * 60_000);
  const page = await launch();
  await integrationsPage(page);

  // The servers, with where they come from and how they are; no address (they can carry keys).
  await expect(server(page, "Acme").getByTestId("server-source")).toHaveText("Copilot CLI config");
  await expect(server(page, "Acme").getByTestId("server-status")).toHaveText("Connected");
  await expect(server(page, "AcmeApi")).toContainText("Same server as Acme");
  await expect(server(page, "Work IQ Mail").getByTestId("server-source")).toHaveText("Plugin workiq");
  await expect(server(page, "Work IQ Mail").getByTestId("server-status")).toHaveText("Needs sign-in");
  await expect(server(page, "GitHub").getByTestId("server-source")).toHaveText("Built into the runtime");
  await expect(page.locator("body")).not.toContainText("SECRET");
  await expect(page.locator("body")).not.toContainText("acme.example");

  // Sign in: main gets the page (recorded by the hooks), the window only its host; then the server's tools.
  await server(page, "Work IQ Mail").getByTestId("sign-in").click();
  await expect(server(page, "Work IQ Mail").getByTestId("sign-in-state")).toHaveAttribute("data-state", "connected");
  const opened = await app!.evaluate(() => (globalThis as unknown as { __ariaE2E: { opened: string[] } }).__ariaE2E.opened);
  expect(opened).toEqual(["https://login.example.invalid/oauth2/authorize?client_id=aria&state=abc"]);
  await expect(page.locator("body")).not.toContainText("client_id=aria");
  await expect(server(page, "Work IQ Mail").getByTestId("server-status")).toHaveText("Connected");
  await openGroup(page, "Work IQ Mail");
  await expect(toolRow(page, "Work-IQ-Mail-SearchMessages").getByTestId("tool-class")).toHaveText("read");
  await expect(toolRow(page, "Work-IQ-Mail-SendMail").getByTestId("tool-class")).toHaveText("write");

  // What a server says is shown as text, without the characters that could disguise it.
  await openGroup(page, "Odd");
  const odd = await toolRow(page, "Odd-get_notes").innerText();
  expect(odd).not.toContain(String.fromCharCode(0x202e));
  expect(odd).toContain(String.fromCharCode(0xfffd));

  // ARIA: a read tool can be Auto, Ask or Never; one that changes things only Ask or Never (D22, D34), and it says why.
  await openGroup(page, "Acme");
  const read = toolRow(page, "Acme-list_my_issues");
  expect(await options(read.getByTestId("rule-aria"))).toEqual(["auto", "ask", "never"]);
  const write = toolRow(page, "Acme-create_issues");
  expect(await options(write.getByTestId("rule-aria"))).toEqual(["ask", "never"]);
  // Why it can't be Auto (D34): said once above the list, and on the row behind "Why?" (not repeated on every write).
  await expect(page.getByTestId("integrations-tools")).toContainText("a tool that changes things is never Auto");
  await expect(write.getByTestId("rule-aria-note")).toHaveCount(0);
  await write.getByTestId("rule-aria-why").click();
  await expect(write.getByTestId("rule-aria-note")).toContainText("action card");
  await expect(toolRow(page, "Acme-api_post").getByTestId("rule-aria")).toHaveValue("never");
  // The ARIA and Tasks columns line up from a read row to a write row (one grid for the group).
  const left = async (row: Locator, scope: "aria" | "tasks") => (await row.getByTestId(`rule-${scope}`).boundingBox())!.x;
  expect(Math.abs((await left(read, "aria")) - (await left(write, "aria")))).toBeLessThan(1);
  expect(Math.abs((await left(read, "tasks")) - (await left(write, "tasks")))).toBeLessThan(1);
  await page.screenshot({ path: path.join(shots, "ui-integrations-1-page.png") });

  // Turned off for ARIA: its next message no longer gets it.
  await read.getByTestId("rule-aria").selectOption("never");
  await expect(read.getByTestId("rule-aria-reset")).toBeVisible();
  await page.getByTestId("nav-aria").click();
  await page.getByTestId("composer").fill("what's on my plate?");
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("msg-assistant").last()).toContainText("I couldn't check");

  // Tasks: a GitHub write asks every time (D30); a merge is always refused (D31).
  await integrationsPage(page);
  await openGroup(page, "GitHub");
  const issue = toolRow(page, "GitHub-create_issue");
  expect(await options(issue.getByTestId("rule-tasks"))).toEqual(["ask", "never"]);
  await issue.getByTestId("rule-tasks").selectOption("ask");
  const merge = toolRow(page, "GitHub-merge_pull_request");
  await expect(merge.getByTestId("rule-tasks")).toBeDisabled();
  await expect(merge.getByTestId("rule-tasks-note")).toContainText("Always refused");
  // D35: GitHub's read tools are on for tasks by default, and the row says how far they reach and what to do.
  const getIssue = toolRow(page, "GitHub-get_issue");
  await expect(getIssue.getByTestId("rule-tasks")).toHaveValue("auto");
  await expect(getIssue.getByTestId("rule-warning")).toContainText("another repository your GitHub account can see");
  await expect(getIssue.getByTestId("rule-warning")).toContainText("Ask or Never");
  await expect(merge.getByTestId("rule-warning")).toHaveCount(0);
  // D32: reading mail from a task is off by default, and turning it on says what that means.
  await openGroup(page, "Work IQ Mail");
  const mail = toolRow(page, "Work-IQ-Mail-SearchMessages");
  await expect(mail.getByTestId("rule-tasks")).toHaveValue("never");
  await mail.getByTestId("rule-tasks").selectOption("auto");
  await expect(mail.getByTestId("rule-warning")).toContainText("repository's instructions");
  await expect(mail.getByTestId("rule-warning")).toContainText("your mail, chats and calendar");
  await expect(mail.getByTestId("rule-warning")).toContainText("Set Tasks back to Never unless a task needs it.");
  // ARIA's Ask on a read tool proposes an action card instead of running on its own: the row says so.
  await expect(mail.getByTestId("rule-aria-note")).toHaveCount(0);
  await mail.getByTestId("rule-aria").selectOption("ask");
  await expect(mail.getByTestId("rule-aria-note")).toContainText("action card");
  await mail.getByTestId("rule-aria-reset").click();
  await mail.getByTestId("rule-tasks-reset").click();
  await expect(mail.getByTestId("rule-warning")).toHaveCount(0);
  await page.screenshot({ path: path.join(shots, "ui-integrations-2-tasks.png") });
  await page.getByTestId("nav-aria").click();

  await newSession(page, "Issue task: file the flaky test");
  const permission = card(page, "card-permission", "Issue task");
  await expect(permission.getByTestId("permission-what")).toContainText("GitHub-create_issue");
  await expect(permission.getByTestId("permission-what")).toContainText("Flaky login test");
  await expect(permission.getByTestId("permission-every-time")).toContainText("changes things outside the task");
  await expect(permission.getByTestId("permission-task")).toHaveCount(0);
  await permission.getByTestId("permission-once").click();
  await expect(card(page, "card-done", "Issue task")).toBeVisible();

  await newSession(page, "Merge task: merge pull request 7");
  await expect(card(page, "card-done", "Merge task")).toBeVisible();
  await expect(card(page, "card-permission", "Merge task")).toHaveCount(0);

  // Back to the default.
  await integrationsPage(page);
  await openGroup(page, "Acme");
  await toolRow(page, "Acme-list_my_issues").getByTestId("rule-aria-reset").click();
  await expect(toolRow(page, "Acme-list_my_issues").getByTestId("rule-aria")).toHaveValue("auto");

  // Marketplaces, Plugins, Agents & Skills: add a marketplace, browse it, install a plugin, toggle a skill, and launch a session with the installed agent.
  await expect(page.getByTestId("integrations-marketplaces")).toBeVisible();
  await page.getByTestId("marketplace-add-input").fill("acme/example-marketplace");
  await page.getByTestId("marketplace-add-btn").click();
  const mpRow = page.locator(`[data-testid="marketplace-row"][data-marketplace="example-marketplace"]`);
  await expect(mpRow).toBeVisible();

  await mpRow.getByTestId("marketplace-browse").click();
  await expect(mpRow.getByTestId("marketplace-catalog")).toBeVisible();
  await mpRow.getByTestId("marketplace-install-plugin").click();

  const pluginRow = page.locator(`[data-testid="plugin-row"][data-plugin="example-marketplace-agent"]`);
  await expect(pluginRow).toBeVisible();

  const skillRow = page.locator(`[data-testid="skill-row"][data-skill="example-marketplace-agent-core"]`);
  await expect(skillRow).toBeVisible();
  await expect(skillRow.getByTestId("skill-enabled-state")).toHaveText("enabled");
  await skillRow.getByTestId("skill-toggle").click();
  await expect(skillRow.getByTestId("skill-enabled-state")).toHaveText("disabled");
  await skillRow.getByTestId("skill-toggle").click();
  await expect(skillRow.getByTestId("skill-enabled-state")).toHaveText("enabled");

  const agentId = "example-marketplace-agent:example-marketplace-agent-orchestrator";
  const agentRow = page.locator(`[data-testid="agent-row"][data-agent="${agentId}"]`);
  await expect(agentRow).toBeVisible();
  await agentRow.getByTestId("agent-start-session").click();

  const dialog = page.getByTestId("new-session");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("new-session-agent")).toHaveValue(agentId);
  // Changing the profile in New session preserves an explicitly selected agent.
  await dialog.getByTestId("new-session-profile").selectOption({ index: 0 });
  await expect(dialog.getByTestId("new-session-agent")).toHaveValue(agentId);
  await dialog.getByTestId("new-session-brief").fill("Template task: scaffold connector");
  await dialog.getByTestId("new-session-start").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("session-view")).toBeVisible();
  await expect(page.getByTestId("session-agent-badge")).toHaveText(agentId);
  // Switch the ongoing/existing session's agent in SessionView.
  await page.getByTestId("task-agent").selectOption("explore");
  await page.getByTestId("task-model-apply").click();
  await expect(page.getByTestId("session-agent-badge")).toHaveText("explore");
  await page.getByTestId("session-close").click();
  await page.getByTestId("nav-aria").click();
  const taskCard = card(page, "card-task", "Template task");
  await expect(taskCard.getByTestId("task-agent-badge")).toContainText("explore");
  // Switch the session's agent directly from the task card in chat.
  await taskCard.getByTestId("task-agent-edit").click();
  await taskCard.getByTestId("task-card-agent").selectOption(agentId);
  await expect(taskCard.getByTestId("task-agent-badge")).toContainText(agentId);
});
