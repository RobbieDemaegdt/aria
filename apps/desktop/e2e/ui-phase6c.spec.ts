/**
 * Phase 6C E2E spec (PLAN.md §4.1, §5.3, §5.5, §10 Phase 6C), against the scripted runtime
 * (`ARIA_FAKE_RUNTIME=ui-cards` and `ARIA_E2E_HOOKS=1`):
 * - Global hotkey (`__ariaE2E.openQuickPrompt()` and `Ctrl+Space`) opening the Spotlight-style Quick prompt bar
 *   (`quick-prompt`) from anywhere, completing and running `/focus on`, and sending a prompt to ARIA.
 * - Optional **Start at login** (`start-at-login`) in Customize › Notifications updating `__ariaE2E.startAtLogin`.
 * - Slash command autocomplete (`slash-list`) and deterministic execution of `/status`, `/tasks`, `/budget`, and
 *   `/pause-all` in the chat.
 * - **"Rerun with…"** (`session-rerun`) in the session view: rerunning a finished task's brief in a fresh worktree
 *   with another profile (`Deep`) and tweaked prompt, and comparing the runs side by side in `session-reruns`.
 * Run after `npm run build`:  npx playwright test ui-phase6c   (from apps/desktop)
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

test.beforeAll(() => {
  base = mkdtempSync(path.join(os.tmpdir(), "aria-e2e-6c-"));
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

test("Quick prompt bar (Ctrl+Space), Start at login, slash commands and Rerun with…", async () => {
  test.setTimeout(5 * 60_000);
  const page = await launch();

  // 1. Navigate to Customize › Notifications and toggle Start at login & Start minimized
  await page.getByTestId("nav-customize").click();
  await page.getByTestId("customize-notifications").click();
  const startAtLoginCheckbox = page.getByTestId("start-at-login");
  const startMinimizedCheckbox = page.getByTestId("start-minimized");
  await expect(startAtLoginCheckbox).not.toBeChecked();
  await expect(startMinimizedCheckbox).toBeChecked();
  await expect(startMinimizedCheckbox).toBeDisabled();
  await startAtLoginCheckbox.check();
  await expect(page.getByTestId("notifications-saved")).toContainText("ARIA will start when you sign in to Windows.");
  await expect(startMinimizedCheckbox).toBeEnabled();
  const hookStartup1 = await app!.evaluate(() => {
    const hooks = (globalThis as { __ariaE2E?: { startAtLogin?: boolean; startMinimized?: boolean; loginItemArgs?: string[] } }).__ariaE2E;
    return { startAtLogin: hooks?.startAtLogin, startMinimized: hooks?.startMinimized, loginItemArgs: hooks?.loginItemArgs };
  });
  expect(hookStartup1).toEqual({
    startAtLogin: true,
    startMinimized: true,
    loginItemArgs: ["--startup", "--hidden"],
  });

  await startMinimizedCheckbox.uncheck();
  await expect(page.getByTestId("notifications-saved")).toContainText("ARIA will open its main window on sign-in.");
  const hookStartup2 = await app!.evaluate(() => {
    const hooks = (globalThis as { __ariaE2E?: { startAtLogin?: boolean; startMinimized?: boolean; loginItemArgs?: string[] } }).__ariaE2E;
    return { startAtLogin: hooks?.startAtLogin, startMinimized: hooks?.startMinimized, loginItemArgs: hooks?.loginItemArgs };
  });
  expect(hookStartup2).toEqual({
    startAtLogin: true,
    startMinimized: false,
    loginItemArgs: ["--startup"],
  });
  await startMinimizedCheckbox.check();

  // 2. Trigger the global hotkey from the main process while on Customize -> opens Quick prompt bar
  await app!.evaluate(() => {
    const hooks = (globalThis as { __ariaE2E?: { openQuickPrompt: () => void } }).__ariaE2E;
    hooks?.openQuickPrompt();
  });
  const quickPrompt = page.getByTestId("quick-prompt");
  await expect(quickPrompt).toBeVisible();
  const qpInput = quickPrompt.getByTestId("quick-prompt-input");
  await expect(qpInput).toBeFocused();

  // Type `/fo` in Quick prompt bar -> slash autocomplete appears; Tab completes `/focus `, then type `on` and Enter
  await qpInput.fill("/fo");
  await expect(quickPrompt.getByTestId("quick-prompt-slash-list")).toBeVisible();
  await qpInput.press("Tab");
  await expect(qpInput).toHaveValue("/focus ");
  await qpInput.fill("/focus on");
  await qpInput.press("Enter");

  // Quick prompt bar closes, switches to Chat, and Focus mode is now on!
  await expect(quickPrompt).toBeHidden();
  await expect(page.getByTestId("focus-mode")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("msg-assistant").last()).toContainText("Focus mode is on");

  // 3. Slash command autocomplete in Chat composer (`/status`)
  const composer = page.getByTestId("composer");
  await composer.fill("/st");
  await expect(page.getByTestId("slash-list")).toBeVisible();
  await composer.press("Tab");
  await expect(composer).toHaveValue("/status ");
  await composer.press("Enter");
  await expect(page.getByTestId("msg-assistant").last()).toContainText("ARIA status:");

  // 4. Start a task ("Preview task"), wait for it to finish, then use "Rerun with…" in SessionView
  await page.getByTestId("nav-new-session").click();
  const dialog = page.getByTestId("new-session");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("new-session-title").fill("Sprint report");
  await dialog.getByTestId("new-session-brief").fill("Preview task: generate sprint report");
  await dialog.getByTestId("new-session-start").click();
  await expect(dialog).toBeHidden();

  const sessionView = page.getByTestId("session-view");
  await expect(sessionView).toBeVisible();
  await expect(page.getByTestId("card-done").filter({ hasText: "Sprint report" })).toBeVisible();

  // Click "Rerun with…" in SessionView header
  const rerunBtn = sessionView.getByTestId("session-rerun");
  await expect(rerunBtn).toBeVisible();
  await rerunBtn.click();

  // NewSessionDialog opens in Rerun mode, prefilled with the original brief and title
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("new-session-heading")).toContainText("Rerun “Sprint report”");
  await expect(dialog.getByTestId("new-session-project")).toBeDisabled();
  await expect(dialog.getByTestId("new-session-brief")).toHaveValue("Preview task: generate sprint report");

  // Pick the "Deep" profile and tweak the brief
  const profileSelect = dialog.getByTestId("new-session-profile");
  const deepValue = await profileSelect.locator("option", { hasText: /^Deep ·/ }).getAttribute("value");
  await profileSelect.selectOption(deepValue!);
  await dialog.getByTestId("new-session-brief").fill("Preview task: generate sprint report with Deep profile");
  await dialog.getByTestId("new-session-start").click();
  await expect(dialog).toBeHidden();

  // Wait for the rerun to finish and verify the "Compare runs" bar (`session-reruns`) shows both runs (#1 Default, #2 Deep)
  await expect(sessionView.getByTestId("session-reruns")).toBeVisible();
  const switches = sessionView.getByTestId("session-rerun-switch");
  await expect(switches).toHaveCount(2);
  await expect(switches.nth(0)).toContainText("#1 · Default");
  await expect(switches.nth(1)).toContainText("#2 · Deep");

  // Switch to the Diff tab and click between Run #1 and Run #2 -> preserves the Diff tab!
  await expect(page.getByTestId("card-done")).toHaveCount(2);
  await sessionView.getByTestId("session-tab-diff").click();
  await expect(sessionView.getByTestId("diff")).toBeVisible();
  await switches.nth(0).click();
  await expect(sessionView.getByTestId("diff")).toBeVisible();
  await expect(switches.nth(0)).toHaveAttribute("aria-current", "true");
});
