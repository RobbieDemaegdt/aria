/**
 * Phase 6A E2E spec (PLAN.md §4.3, §4.9, §5.1, §5.2, §10 Phase 6A), against the scripted runtime
 * (ARIA_FAKE_RUNTIME=ui-cards):
 * - Conductor `remember` and `forget` tools saving and removing global and project memories, posting notices,
 *   showing "Saved by ARIA in chat" in Customize › Memory, and injecting into briefs and ARIA's prompt.
 * - Customize › Data (D1): the database size, the transcript retention setting, and Clean up now.
 * - Sidebar **Search** view (`nav-search` and `Ctrl+K`): searching across session transcripts, tasks, projects,
 *   and memories, filtering by scope, and opening the matching session view (scrolled to the matched entry) or card.
 * Run after `npm run build`:  npx playwright test ui-search-memory   (from apps/desktop)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { GIT_NO_FSMONITOR, GIT_TEST_ENV } from "./git-env.ts";

const appDir = path.resolve(import.meta.dirname, "..");
let base = "";
let env: Record<string, string> = {};
let app: ElectronApplication | undefined;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...GIT_NO_FSMONITOR, "-c", "user.name=ARIA E2E", "-c", "user.email=e2e@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

async function launch(): Promise<Page> {
  app = await electron.launch({ args: [appDir], env, timeout: 60_000 });
  const page = await app.firstWindow();
  await expect(page.getByTestId("status")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  return page;
}

async function sendChat(page: Page, text: string): Promise<void> {
  await page.getByTestId("composer").fill(text);
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("status")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
}

test.beforeAll(() => {
  base = mkdtempSync(path.join(os.tmpdir(), "aria-e2e-6a-"));
  const repo = path.join(base, "GitHub", "Demo App");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "# Demo App\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Initial commit");
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
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

test("Conductor remember/forget tools and Search across session transcripts, tasks and projects", async () => {
  test.setTimeout(5 * 60_000);
  const page = await launch();

  // 1. Ask ARIA to remember a project fact and a global preference
  await sendChat(page, "remember that Demo App uses pnpm");
  await expect(page.getByTestId("msg-assistant").last()).toContainText("Remembered for Demo App: Demo App uses pnpm.");
  await expect(
    page.getByTestId("notice").filter({ hasText: "ARIA remembered for Demo App: “Demo App uses pnpm”." }),
  ).toBeVisible();

  await sendChat(page, "remember to always open draft PRs");
  await expect(page.getByTestId("msg-assistant").last()).toContainText("Remembered: Always open draft PRs.");

  // Check Customize › Memory shows both notes with "Saved by ARIA in chat"
  await page.getByTestId("nav-customize").click();
  await page.getByTestId("customize-memory").click();
  await expect(page.getByTestId("memory-row")).toHaveCount(2);
  await expect(page.getByTestId("memory-row").first()).toContainText("Saved by ARIA in chat");

  // Customize › Data (D1): the database's size, the retention setting kept across a page switch, and Clean up now.
  await page.getByTestId("customize-data").click();
  await expect(page.getByTestId("data-file-size")).toHaveText(/\d+ (KB|MB)/);
  await expect(page.getByTestId("data-last-cleanup")).toHaveText("No clean-up yet.");
  await expect(page.getByTestId("data-retention-enabled")).toBeChecked();
  await page.getByTestId("data-keep-days").fill("0");
  await expect(page.getByTestId("data-keep-days-error")).toBeVisible();
  await page.getByTestId("data-keep-days").fill("14");
  await page.getByTestId("data-keep-days").press("Enter");
  await expect(page.getByTestId("data-keep-days-error")).toBeHidden();
  await page.getByTestId("data-clean-up").click();
  await expect(page.getByTestId("data-last-cleanup")).toContainText("nothing was old enough");
  await page.getByTestId("customize-memory").click();
  await page.getByTestId("customize-data").click();
  await expect(page.getByTestId("data-keep-days")).toHaveValue("14");

  // 2. Start a task and verify its brief receives the remembered notes
  await page.getByTestId("nav-new-session").click();
  const dialog = page.getByTestId("new-session");
  await dialog.getByTestId("new-session-brief").fill("Preview task: create sprint report");
  await dialog.getByTestId("new-session-start").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("session-view")).toBeVisible();
  await expect(page.getByTestId("transcript-user").first()).toContainText("- Demo App uses pnpm");
  await expect(page.getByTestId("transcript-user").first()).toContainText("- Always open draft PRs");
  await page.getByTestId("session-close").click();

  await page.getByTestId("nav-aria").click();
  await expect(page.getByTestId("card-done").filter({ hasText: "Preview task" })).toBeVisible();

  // 3. Ask ARIA to forget the Demo App pnpm note
  await sendChat(page, "forget that Demo App uses pnpm");
  await expect(page.getByTestId("msg-assistant").last()).toContainText("Forgot the note about pnpm for Demo App.");
  await expect(
    page.getByTestId("notice").filter({ hasText: "ARIA forgot (Demo App): “Demo App uses pnpm”." }),
  ).toBeVisible();

  // 4. Open Search via sidebar (`nav-search`) and search across projects, tasks, and session transcripts
  await page.getByTestId("nav-search").click();
  const searchView = page.getByTestId("search-view");
  await expect(searchView).toBeVisible();
  await expect(searchView.getByTestId("search-input")).toBeFocused();

  // Search for Project
  await searchView.getByTestId("search-input").fill("Demo App");
  await expect(searchView.getByTestId("search-hit-project")).toHaveCount(1);
  await expect(searchView.getByTestId("search-hit-project")).toContainText("Demo App");

  // Search for session transcript content ("Sprint Report" written by Preview task)
  await searchView.getByTestId("search-input").fill("Sprint Report");
  await expect(searchView.getByTestId("search-hit-task")).toHaveCount(1);
  await expect(searchView.getByTestId("search-hit-transcript").first()).toBeVisible();

  // Filter to Session transcripts scope only
  await searchView.getByTestId("search-scope-transcripts").click();
  await expect(searchView.getByTestId("search-section-tasks")).toHaveCount(0);
  await expect(searchView.getByTestId("search-section-transcripts")).toBeVisible();

  // Click Open session on the transcript hit -> opens SessionView on the right
  await searchView.getByTestId("search-hit-transcript").first().getByTestId("search-open-session").click();
  await expect(page.getByTestId("session-view")).toBeVisible();
  await expect(page.getByTestId("session-view")).toContainText("Preview task");

  // Switch back to All scope and click Open card on the Task hit -> switches to Chat and focuses the card
  await searchView.getByTestId("search-scope-all").click();
  await searchView.getByTestId("search-hit-task").first().getByTestId("search-open-card").click();
  await expect(page.getByTestId("composer")).toBeVisible();

  // Test Ctrl+K shortcut opens Search from Chat
  await page.keyboard.press("Control+k");
  await expect(searchView).toBeVisible();
});
