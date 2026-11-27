/**
 * The pictures in the README (docs/images/*.png), made from the scripted runtime (ARIA_FAKE_RUNTIME=ui-cards) with fictional
 * data only: the fictional Acme Tracker (useAcmeTracker), the local mock GitHub of ui-mywork, a fictional git identity, and a
 * neutral folder in place of the temp folder, whose path holds the Windows user name. No model calls, no credits.
 *
 * Skipped unless ARIA_SCREENSHOTS=1, so `npm run e2e` and a bare `npx playwright test` never rewrite the images (the file's
 * name matches neither script's filter). Run after `npm run build`, from apps/desktop (PowerShell):
 *     $env:ARIA_SCREENSHOTS = "1"; npx playwright test screenshots
 * and put what the build log should check in ARIA_SHOT_TEXT_DIR: for each picture the spec writes there the page's visible
 * text (`<name>.txt`), so the same searches that clear the sources clear what is on screen. The owner still looks at every PNG.
 *
 * Where it works: ARIA_SHOT_ROOT, else C:\aria-demo. The spec makes the folder, puts the data folder, the project, the worktrees,
 * a stand-in Copilot home (so nothing of the real one is read) and the temp folder in it, and removes it at the end. It
 * refuses a folder that exists and isn't empty unless an earlier run of this spec made it (the marker file), so it never
 * removes anything else.
 *
 * Pictures: the chat (a question card and a done card), a session, My work, the Time view with a timesheet draft, and
 * Customize › Integrations with the Acme Tracker. The window is 1440 × 900 at a device scale of 1.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { MockGitHub } from "../../../packages/core/test/mock-github.ts";
import { TEST_GITHUB_TOKEN } from "../src/main/github-options.ts";
import { useAcmeTracker } from "./acme.ts";
import { GIT_NO_FSMONITOR, GIT_TEST_ENV } from "./git-env.ts";

const appDir = path.resolve(import.meta.dirname, "..");
const IMAGES = path.resolve(appDir, "..", "..", "docs", "images");
const ROOT = path.resolve(process.env.ARIA_SHOT_ROOT ?? "C:\\aria-demo");
const MARKER = ".aria-screenshots";
const TEXT_DIR = process.env.ARIA_SHOT_TEXT_DIR ? path.resolve(process.env.ARIA_SHOT_TEXT_DIR) : undefined;
const WIDTH = 1440;
const HEIGHT = 900;

/** The identity of every commit on screen. */
const SAM = {
  GIT_AUTHOR_NAME: "Sam Rivera",
  GIT_AUTHOR_EMAIL: "sam@example.com",
  GIT_COMMITTER_NAME: "Sam Rivera",
  GIT_COMMITTER_EMAIL: "sam@example.com",
};

let env: Record<string, string> = {};
let app: ElectronApplication | undefined;
const mock = new MockGitHub();

test.describe.configure({ mode: "serial" });

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...GIT_NO_FSMONITOR, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...GIT_TEST_ENV, ...SAM, GIT_CONFIG_GLOBAL: path.join(ROOT, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" } }).trim();

/** Makes the working folder, or stops: only an empty folder or one an earlier run of this spec made is used. */
function makeRoot(): void {
  if (path.parse(ROOT).root === ROOT) throw new Error(`${ROOT} is a drive's root: set ARIA_SHOT_ROOT to a folder of its own.`);
  if (existsSync(ROOT) && readdirSync(ROOT).length > 0) {
    if (!existsSync(path.join(ROOT, MARKER))) throw new Error(`${ROOT} exists and this spec didn't make it: remove it, or set ARIA_SHOT_ROOT to a folder that doesn't exist.`);
    rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(path.join(ROOT, MARKER), "made by apps/desktop/e2e/screenshots.spec.ts; the spec removes this folder\n");
}

async function launch(): Promise<Page> {
  app = await electron.launch({ args: [appDir, "--force-device-scale-factor=1"], env, timeout: 60_000 });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, [w, h]) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(w!, h!);
  }, [WIDTH, HEIGHT]);
  await expect(page.getByTestId("status")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`)).toBe(`${WIDTH}x${HEIGHT}`);
  return page;
}

/** One picture: the page as it is, and its visible text in ARIA_SHOT_TEXT_DIR. */
async function shoot(page: Page, name: string): Promise<void> {
  mkdirSync(IMAGES, { recursive: true });
  // The composer sizes itself when its text changes, and may have done it before the layout settled: change the text and put it back.
  const composer = page.getByTestId("composer");
  if (await composer.isVisible()) {
    await composer.fill("x");
    await composer.fill("");
  }
  await page.mouse.move(WIDTH - 1, HEIGHT - 1);
  const png = await page.screenshot({ path: path.join(IMAGES, `${name}.png`), animations: "disabled", caret: "hide" });
  expect([png.readUInt32BE(16), png.readUInt32BE(20)], `${name}.png is ${WIDTH} × ${HEIGHT}`).toEqual([WIDTH, HEIGHT]);
  if (TEXT_DIR) {
    mkdirSync(TEXT_DIR, { recursive: true });
    writeFileSync(path.join(TEXT_DIR, `${name}.txt`), await page.evaluate(() => document.body.innerText));
  }
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
async function say(page: Page, text: string): Promise<void> {
  await page.getByTestId("nav-aria").click();
  await page.getByTestId("composer").fill(text);
  await page.getByTestId("composer").press("Enter");
}

test.describe("the README's pictures", () => {
  test.skip(process.env.ARIA_SCREENSHOTS !== "1", "set ARIA_SCREENSHOTS=1 to make the README's pictures");

  test.beforeAll(async () => {
    makeRoot();
    const repo = path.join(ROOT, "GitHub", "Demo App");
    const copilot = path.join(ROOT, "copilot");
    for (const dir of [repo, copilot, path.join(ROOT, "tmp")]) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(ROOT, "gitconfig"), "");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", SAM.GIT_AUTHOR_NAME);
    git(repo, "config", "user.email", SAM.GIT_AUTHOR_EMAIL);
    writeFileSync(path.join(repo, "README.md"), "# Demo App\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "--date=2026-10-23T11:00:00Z", "-m", "Add dark mode toggle (task ACME-123)");
    // Only the remote's address: nothing is fetched from it.
    git(repo, "remote", "add", "origin", "https://github.com/demo/demo-app.git");
    await mock.start();
    mock.token = TEST_GITHUB_TOKEN;
    mock.addRepo("demo", "demo-app");
    mock.addPull("demo", "demo-app", 12, { title: "Add dark mode", author: "sam-test" });
    mock.addPull("demo", "demo-app", 13, { title: "Fix login", author: "alice", reviewers: ["sam-test"] });
    mock.addIssue("demo", "demo-app", 20, { title: "Crash on start", assignees: ["sam-test"] });
    // What the app starts with: the ones of this PC that name the owner or the account are dropped, then the fictional ones set.
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !/^(ELECTRON_RUN_AS_NODE|GH_|GITHUB_|COPILOT_|GIT_)/i.test(e[0])),
    );
    const data = path.join(ROOT, "data");
    env = {
      ...inherited,
      ...GIT_TEST_ENV,
      ...SAM,
      GIT_CONFIG_GLOBAL: path.join(ROOT, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      // The temp folder of the app is in the neutral folder too, so no temp path on screen holds the Windows user name. (The
      // profile folder can't move: Windows finds the app's data folders through it and the app doesn't start.)
      TEMP: path.join(ROOT, "tmp"),
      TMP: path.join(ROOT, "tmp"),      // Nothing of the real Copilot CLI: no `~\.copilot` (its servers, plugins and sessions) is read.
      COPILOT_HOME: copilot,
      ARIA_CLI_MCP_CONFIG: path.join(copilot, "mcp-config.json"),
      ARIA_FAKE_RUNTIME: "ui-cards",
      ARIA_E2E_HOOKS: "1",
      ARIA_FAKE_GITHUB: mock.baseUrl,
      ARIA_DATA_DIR: data,
      ...useAcmeTracker(data),
      ARIA_PROJECT_ROOTS: path.join(ROOT, "GitHub"),
      ARIA_WORKTREE_ROOT: path.join(ROOT, "wt"),
    };
  });

  test.afterAll(async () => {
    await app?.close().catch(() => {
      // Teardown: the app may be gone already, and the test has its result.
    });
    await mock.stop();
    if (existsSync(path.join(ROOT, MARKER))) rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  });

  test("the chat, a session, My work, the Time view and Customize › Integrations", async () => {
    test.setTimeout(6 * 60_000);
    const page = await launch();
    const view = page.getByTestId("session-view");

    // The chat: a task that asked a question, was answered and is done, and one that is waiting on its question.
    await newSession(page, "Question task: add a theme toggle");
    const asked = card(page, "card-question", "Question task");
    await expect(asked).toBeVisible();
    await asked.getByTestId("question-choice").filter({ hasText: "Header" }).click();
    const done = card(page, "card-done", "Question task");
    await expect(done).toBeVisible();
    await expect(done.getByTestId("done-stats")).toContainText("1 file changed");
    // The worker's commit carries the fictional identity, not the one of this PC's git (author and committer).
    expect(git(path.join(ROOT, "GitHub", "Demo App"), "log", "-1", "--format=%an <%ae> / %cn <%ce>", "aria/question-task-add-a-theme-toggle")).toBe(
      "Sam Rivera <sam@example.com> / Sam Rivera <sam@example.com>",
    );
    await newSession(page, "Login task: sign users in");
    await expect(card(page, "card-question", "Login task")).toBeVisible();
    await page.getByTestId("nav-aria").click();
    await shoot(page, "chat");

    // A session: the finished task's transcript, with the question and its answer.
    await done.getByTestId("done-diff").click();
    await expect(view.locator('[data-testid="diff-file"][data-path="theme.txt"]')).toContainText("toggle: header");
    await view.getByTestId("session-tab-transcript").click();
    await expect(view.getByTestId("transcript-question")).toContainText("→ Header");
    await view.getByRole("button", { name: "Full width" }).click();
    await shoot(page, "session");
    await view.getByTestId("session-close").click();
    await expect(view).toBeHidden();

    // My work: the pull requests and issues of the mock GitHub, and the Acme Tracker's tasks.
    await page.getByTestId("nav-my-work").click();
    await expect(page.getByTestId("my-work-searched")).toContainText("Searched as @sam-test");
    await expect(page.getByTestId("my-work-review_requested")).toContainText("Fix login");
    await expect(page.getByTestId("my-work-authored")).toContainText("Add dark mode", { timeout: 30_000 });
    await expect(page.getByTestId("my-work-assigned")).toContainText("Crash on start", { timeout: 30_000 });
    await expect(page.getByTestId("my-work-tracker").getByTestId("my-work-tracker-item")).toHaveCount(2);
    await shoot(page, "my-work");
    await page.getByTestId("my-work-close").click();
    await expect(page.getByTestId("my-work")).toBeHidden();

    // The Time view with a timesheet draft: the Timekeeper's model, the draft for a day, its gap filled by a message.
    await page.getByTestId("nav-customize").click();
    const slot = page.getByTestId("timekeeper-model");
    await expect(slot).toBeVisible();
    await slot.getByTestId("timekeeper-model-select").selectOption("fake-strong");
    await slot.getByTestId("timekeeper-effort-select").selectOption("high");
    await slot.getByTestId("save-timekeeper-model").click();
    await expect(slot.getByTestId("timekeeper-saved")).toBeVisible();
    await say(page, "prepare my timesheet for 2026-10-23");
    const draft = page.getByTestId("card-timesheet");
    await expect(draft.getByTestId("timesheet-summary")).toContainText("draft 7h of 8h · 1 gap · 1 uncertain");
    await say(page, "the 14:00 to 15:00 block was Design sync on task ACME-456");
    await expect(draft.getByTestId("timesheet-summary")).toContainText("draft 8h of 8h");
    await page.getByTestId("nav-time").click();
    const time = page.getByTestId("time-view");
    await expect(time).toBeVisible();
    await time.getByTestId("time-date-picker").fill("2026-10-23");
    await expect(time.getByTestId("time-draft-row").first()).toBeVisible({ timeout: 30_000 });
    await time.getByTestId("time-date-picker").blur();
    await shoot(page, "time");

    // Customize › Integrations: the Acme Tracker in use, and its server.
    await page.getByTestId("nav-customize").click();
    await page.getByTestId("customize-integrations").click();
    await expect(page.getByTestId("integrations-servers")).toBeVisible();
    await expect(page.locator('[data-testid="tracker-config"][data-file="acme.json"]')).toBeVisible();
    await shoot(page, "integrations");
  });
});
