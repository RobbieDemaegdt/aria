/**
 * Choosing and setting up the task tracker in the window, against the scripted runtime
 * (ARIA_FAKE_RUNTIME=ui-tracker: a fictional server "Acme Cloud" with the tools of acme.json) with the test hooks
 * (ARIA_E2E_HOOKS=1: the file Import config… picks is set by the test, no dialog opens). Fictional trackers only.
 *
 * 1. Customize › Integrations: the folder's configs (one that loads, one that doesn't), "Use as task tracker" on the
 *    server (the config suggested for it, its tools found, what ARIA reads and what is reserved), My work and the new
 *    session dialog follow, Import config… (a new file, the same file again, a file that isn't a config), Stop using.
 * 2. After a restart there is still no tracker, and the window is without one: My work, the new session dialog, the Time
 *    view (draft rows with times and comments, no Submit), the chat's questions, the setup guide and the doctor say a
 *    task tracker is optional and name none; `/tracker acme` brings it back.
 * Run after `npm run build`:  npx playwright test ui-tracker   (from apps/desktop)
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { GIT_TEST_ENV } from "./git-env.ts";

const appDir = path.resolve(import.meta.dirname, "..");
const shots = path.join(appDir, "e2e", ".artifacts");
const ACME_FIXTURE = path.resolve(appDir, "..", "..", "packages", "core", "test", "fixtures", "trackers", "acme.json");
let base = "";
let env: Record<string, string> = {};
let app: ElectronApplication | undefined;

test.describe.configure({ mode: "serial" });

type Hooks = { external: string[]; trackerImportFile?: string; trackerReplace?: boolean };
const opened = () => app!.evaluate(() => (globalThis as unknown as { __ariaE2E: Hooks }).__ariaE2E.external);
const importFile = (file: string | undefined) =>
  app!.evaluate((_electron, picked) => {
    const h = (globalThis as unknown as { __ariaE2E: Hooks }).__ariaE2E;
    if (picked === undefined) delete h.trackerImportFile;
    else h.trackerImportFile = picked;
  }, file);

async function launch(): Promise<Page> {
  app = await electron.launch({ args: [appDir], env, timeout: 60_000 });
  const page = await app.firstWindow();
  // A restart opens the view it was left on: the chat is where the status is.
  await page.getByTestId("nav-aria").click();
  await expect(page.getByTestId("status")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  return page;
}

const server = (page: Page, name: string): Locator => page.locator(`[data-testid="integrations-server"][data-server="${name}"]`);
const configRow = (page: Page, file: string): Locator => page.locator(`[data-testid="tracker-config"][data-file="${file}"]`);
async function integrationsPage(page: Page): Promise<void> {
  await page.getByTestId("nav-customize").click();
  await page.getByTestId("customize-integrations").click();
  await expect(page.getByTestId("integrations-servers")).toBeVisible();
}
/** Clears every notice or card of the chat that has this dismiss button, one at a time. */
async function clearAll(page: Page, testId: string): Promise<void> {
  const buttons = page.getByTestId(testId);
  for (let left = await buttons.count(); left > 0; left--) {
    await buttons.first().click();
    await expect(buttons).toHaveCount(left - 1);
  }
}
async function say(page: Page, text: string): Promise<void> {
  await page.getByTestId("nav-aria").click();
  await page.getByTestId("composer").fill(text);
  await page.getByTestId("composer").press("Enter");
}

test.beforeAll(() => {
  mkdirSync(shots, { recursive: true });
  base = mkdtempSync(path.join(os.tmpdir(), "aria-e2e-tracker-"));
  // The trackers folder: the fictional Acme Tracker, and a file that isn't JSON.
  const trackers = path.join(base, "data", "trackers");
  mkdirSync(trackers, { recursive: true });
  writeFileSync(path.join(trackers, "acme.json"), readFileSync(ACME_FIXTURE, "utf8"));
  writeFileSync(path.join(trackers, "broken.json"), '{ "schema": 1, ');
  // Files for Import config…: a second fictional tracker (Acme's with its own names) and one that isn't a config.
  const picks = path.join(base, "picks");
  mkdirSync(picks, { recursive: true });
  const orbit = JSON.parse(readFileSync(ACME_FIXTURE, "utf8")) as { id: string; label: string; info: Record<string, string>; servers: { match: string[]; fallback: string }; taskRef: { urls: string[] } };
  orbit.id = "orbit";
  orbit.label = "Orbit Desk";
  orbit.info.urlTemplate = "https://orbit.example/browse/{id}";
  orbit.info.serverHint = "Orbit Desk";
  orbit.servers = { match: ["orbit"], fallback: "Orbit" };
  orbit.taskRef.urls = ["orbit.example/browse/{id}"];
  writeFileSync(path.join(picks, "orbit.json"), JSON.stringify(orbit, null, 2));
  writeFileSync(path.join(picks, "odd.json"), JSON.stringify({ schema: 1, id: "odd" }));
  const inherited = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  mkdirSync(path.join(base, "GitHub"), { recursive: true });
  env = {
    ...inherited,
    ...GIT_TEST_ENV,
    ARIA_FAKE_RUNTIME: "ui-tracker",
    ARIA_E2E_HOOKS: "1",
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

test("Customize › Integrations: configs, Use as task tracker, My work, Import config…, Stop using", async () => {
  test.setTimeout(5 * 60_000);
  const page = await launch();
  await integrationsPage(page);
  const panel = page.getByTestId("tracker-panel");
  const active = panel.getByTestId("tracker-active");

  // The trackers folder: the file that loads (label, file, hash) and the one that doesn't (why).
  await expect(configRow(page, "acme.json")).toContainText("Acme Tracker");
  await expect(configRow(page, "acme.json")).toContainText(/acme\.json \([0-9a-f]{8}\)/);
  await expect(configRow(page, "broken.json")).toContainText("can't be used");
  await expect(configRow(page, "acme.json")).not.toContainText("In use");
  // Nothing has been chosen and the store holds no tracker's data: there is no tracker, and no server of yours is one.
  await expect(active).toContainText("None. ARIA works without one");
  await expect(active).toHaveAttribute("data-tracker", "");
  await expect(server(page, "Acme Cloud").getByTestId("server-tracker-badge")).toHaveCount(0);

  // A server without the config's tools: what is missing, as a warning and not a block (Use stays on); Cancel changes nothing.
  await server(page, "Odd").getByTestId("tracker-use").click();
  const dialog = page.getByTestId("tracker-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-testid="tracker-dialog-part"][data-part="myWork"]')).toHaveAttribute("data-state", "missing");
  await expect(dialog.locator('[data-testid="tracker-dialog-part"][data-part="myWork"]')).toContainText("list_my_issues");
  await expect(dialog.getByTestId("tracker-dialog-missing")).toContainText("Odd doesn't have the tools for");
  await expect(dialog.getByTestId("tracker-dialog-use")).toBeEnabled();
  await dialog.getByTestId("tracker-dialog-cancel").click();
  await expect(dialog).toBeHidden();
  await expect(active).toHaveAttribute("data-tracker", "");

  // Use as task tracker: the config suggested for the server, the server's tools part by part, what is read and what is reserved.
  await server(page, "Acme Cloud").getByTestId("tracker-use").click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("tracker-dialog-config")).toHaveValue("acme");
  await expect(dialog.getByTestId("tracker-dialog-config")).toContainText("suggested");
  await expect(dialog.locator('[data-testid="tracker-dialog-part"][data-part="myWork"]')).toHaveAttribute("data-state", "found");
  await expect(dialog.locator('[data-testid="tracker-dialog-part"][data-part="myWork"]')).toContainText("list_my_issues");
  await expect(dialog.locator('[data-testid="tracker-dialog-part"][data-part="submit"]')).toContainText("add_worklogs");
  await expect(dialog.locator('[data-testid="tracker-dialog-part"][data-part="projects"]')).toHaveCount(0);
  await expect(dialog.getByTestId("tracker-reads")).toContainText("list_my_issues");
  await expect(dialog.getByTestId("tracker-reserved")).toContainText("add_worklogs");
  await expect(dialog.getByTestId("tracker-reserved")).toContainText("delete_worklogs");
  await page.screenshot({ path: path.join(shots, "ui-tracker-1-use.png") });
  await dialog.getByTestId("tracker-dialog-use").click();
  await expect(dialog).toBeHidden();
  await expect(active).toHaveText(/^Acme Tracker, through Acme Cloud — acme\.json \([0-9a-f]{8}\)$/);
  await expect(active).toHaveAttribute("data-tracker", "acme");
  await expect(configRow(page, "acme.json")).toContainText("In use");
  await expect(server(page, "Acme Cloud").getByTestId("server-tracker-badge")).toHaveText("Task tracker");
  await expect(server(page, "Acme Cloud").getByTestId("tracker-stop")).toBeVisible();
  await expect(server(page, "Acme Cloud").getByTestId("tracker-use")).toHaveCount(0);

  // My work reads its issues through the server, under the tracker's label and task pages; Ask ARIA names it.
  await page.getByTestId("nav-my-work").click();
  const section = page.getByTestId("my-work-tracker");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("my-work-tracker-item")).toHaveCount(2);
  await expect(section).toContainText("Acme Tracker tasks");
  const issue = section.locator('[data-testid="my-work-tracker-item"][data-task-id="ACME-12"]');
  await expect(issue).toContainText("Billing export");
  await issue.getByTestId("my-work-tracker-open").click();
  await expect.poll(opened).toContain("https://acme.example/browse/ACME-12");
  await issue.getByTestId("my-work-tracker-ask").click();
  await expect(page.getByTestId("composer")).toHaveValue('About Acme Tracker task #ACME-12 ("Billing export"): ');
  await page.getByTestId("composer").fill("");

  // The new session dialog has the tracker's task field, under its name and its placeholder.
  await page.getByTestId("nav-new-session").click();
  await expect(page.getByTestId("new-session")).toBeVisible();
  await expect(page.getByTestId("new-session")).toContainText("Acme Tracker task (optional)");
  await expect(page.getByTestId("new-session-tracker")).toHaveAttribute("placeholder", "Issue key (e.g. ACME-123) or acme.example link");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("new-session")).toBeHidden();

  // The Time view says whose registration it is.
  await page.getByTestId("nav-time").click();
  await expect(page.getByTestId("time-view")).toContainText("Time & Acme Tracker Registration");

  // Import config…: a file that is a config (named, with what it reaches), the same file again (replaces), one that isn't.
  await integrationsPage(page);
  const result = page.getByTestId("tracker-import-result");
  await importFile(path.join(base, "picks", "orbit.json"));
  await panel.getByTestId("tracker-import").click();
  await expect(result).toHaveAttribute("data-status", "imported");
  await expect(result).toContainText("Imported Orbit Desk as orbit.json");
  await expect(result).not.toContainText("in place of");
  await expect(result.getByTestId("tracker-reads")).toContainText("list_my_issues");
  await expect(result).toContainText("trusted like a plugin");
  await expect(configRow(page, "orbit.json")).toContainText("Orbit Desk");
  await expect(configRow(page, "orbit.json")).not.toContainText("In use");
  await expect(active).toHaveAttribute("data-tracker", "acme");
  await panel.getByTestId("tracker-import").click();
  await expect(result).toContainText("in place of the file that was there");
  await importFile(path.join(base, "picks", "odd.json"));
  await panel.getByTestId("tracker-import").click();
  await expect(result).toHaveAttribute("data-status", "invalid");
  await expect(result).toContainText("it isn't a task tracker config ARIA can use");
  await expect(panel.getByTestId("tracker-config")).toHaveCount(3);
  await page.screenshot({ path: path.join(shots, "ui-tracker-2-import.png") });

  // Stop using the last server: no tracker; the badge, My work's section and the panel say so.
  await server(page, "Acme Cloud").getByTestId("tracker-stop").click();
  await expect(active).toHaveText(/^None\. ARIA works without one; pick an MCP server below to read tasks and register time\.$/);
  await expect(active).toHaveAttribute("data-tracker", "");
  await expect(server(page, "Acme Cloud").getByTestId("server-tracker-badge")).toHaveCount(0);
  await expect(server(page, "Acme Cloud").getByTestId("tracker-use")).toBeVisible();
  await expect(configRow(page, "acme.json")).not.toContainText("In use");
  await page.getByTestId("nav-my-work").click();
  await expect(page.getByTestId("my-work")).toBeVisible();
  await expect(page.getByTestId("my-work-tracker")).toHaveCount(0);
  await page.screenshot({ path: path.join(shots, "ui-tracker-3-none.png") });
});

test("With no task tracker, kept over a restart: nothing names one, and /tracker brings one back", async () => {
  test.setTimeout(5 * 60_000);
  await app?.close().catch(() => {
    // The first test's app: it may be gone already.
  });
  const page = await launch();

  // Still none after the restart.
  await integrationsPage(page);
  await expect(page.getByTestId("tracker-active")).toHaveAttribute("data-tracker", "");
  await expect(server(page, "Acme Cloud").getByTestId("tracker-use")).toBeVisible();

  // The chat: what the first run left in it (the notices of the tracker's changes, the morning brief) is cleared, and the
  // welcome and the starter questions name no tracker.
  await page.getByTestId("nav-aria").click();
  await clearAll(page, "notice-dismiss");
  await clearAll(page, "card-dismiss");
  const welcome = page.getByTestId("welcome-banner");
  await expect(welcome).toContainText("to unlock GitHub watches and Microsoft 365 Work IQ.");
  await expect(welcome).toContainText("4. Work IQ MCP");
  await expect(page.getByTestId("empty")).toContainText("What projects do I have?");
  await expect(page.getByTestId("empty")).not.toContainText("in progress?");
  await expect(page.getByTestId("empty")).not.toContainText("Tracker");

  // My work has no tracker part, the new session dialog no task field, a session no link.
  await page.getByTestId("nav-my-work").click();
  await expect(page.getByTestId("my-work")).toBeVisible();
  await expect(page.getByTestId("my-work-tracker")).toHaveCount(0);
  await expect(page.getByTestId("my-work-outlook")).toBeVisible();
  await page.getByTestId("nav-new-session").click();
  await expect(page.getByTestId("new-session-brief")).toBeVisible();
  await expect(page.getByTestId("new-session-tracker")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("new-session")).toBeHidden();

  // The Time view: a draft row has times and a comment and nothing of a task or a registration.
  await page.getByTestId("nav-time").click();
  const time = page.getByTestId("time-view");
  await expect(time.getByRole("heading", { name: "Time", exact: true })).toBeVisible();
  await expect(time).not.toContainText("Registration");
  await page.getByTestId("time-add-entry").click();
  const editor = page.getByTestId("time-draft-editor");
  await expect(editor).toBeVisible();
  await expect(editor.getByTestId("time-draft-edit-task")).toHaveCount(0);
  await editor.getByTestId("time-draft-edit-comment").fill("Design review");
  await editor.getByTestId("time-draft-save").click();
  await expect(page.getByTestId("time-draft-row")).toHaveCount(1);
  await expect(page.getByTestId("time-draft-row")).toContainText("Design review");
  await expect(page.getByTestId("time-submit")).toHaveCount(0);
  await expect(page.getByTestId("time-draft-confirm")).toHaveCount(0);
  await expect(page.getByTestId("time-registered-section")).toHaveCount(0);
  await expect(page.getByTestId("time-rules-section")).toHaveCount(0);
  await expect(page.getByTestId("time-digest-tracker")).toHaveCount(0);
  await expect(time).not.toContainText("Tracker");
  await page.screenshot({ path: path.join(shots, "ui-tracker-4-time.png") });

  // /tracker says there is none.
  await say(page, "/tracker");
  await expect(page.getByTestId("msg-assistant").last()).toContainText("Active: No task tracker");

  // The setup guide: a task tracker is optional, and none is named; the doctor lists it as information.
  await page.getByTestId("sidebar-open-setup").click();
  const modal = page.getByTestId("onboarding-modal");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("4. MCP Integrations (Microsoft 365 Work IQ)");
  await expect(modal).toContainText("pick a task tracker in Customize › Integrations (optional).");
  await expect(modal).toContainText("Set expected daily hours and the 16:30 draft schedule.");
  await expect(modal).not.toContainText("Tracker");
  await page.getByTestId("onboarding-tab-doctor").click();
  const check = page.getByTestId("doctor-check-task_tracker");
  await expect(check).toBeVisible({ timeout: 60_000 });
  await expect(check).toContainText("No task tracker (optional).");
  await page.screenshot({ path: path.join(shots, "ui-tracker-5-setup.png") });
  await page.getByTestId("onboarding-close").click();
  await expect(modal).toBeHidden();

  // /tracker acme brings the tracker back: the server it finds by name, the section in My work, the label in the Time view.
  await say(page, "/tracker acme");
  await expect(page.getByTestId("msg-assistant").last()).toContainText("Task tracker: Acme Tracker");
  await page.getByTestId("nav-my-work").click();
  await expect(page.getByTestId("my-work-tracker").getByTestId("my-work-tracker-item")).toHaveCount(2);
  await page.getByTestId("nav-time").click();
  await expect(page.getByTestId("time-view")).toContainText("Time & Acme Tracker Registration");
  await expect(page.getByTestId("time-submit")).toBeVisible();
});
