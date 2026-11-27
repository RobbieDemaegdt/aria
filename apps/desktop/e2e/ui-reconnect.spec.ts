/**
 * Reconnect in the chat, against the scripted runtime, so without restarting ARIA:
 * - The Copilot runtime can't start when ARIA does (`ARIA_FAKE_RUNTIME=ui-offline`): the chat says so and offers it.
 * - The runtime ends while a task works (`ARIA_FAKE_RUNTIME=ui-cards`, `ARIA_E2E_HOOKS=1`): the chat says so within
 *   the check's interval, the task is interrupted, and it resumes once ARIA has reconnected.
 * Run after `npm run build`:  npx playwright test ui-reconnect   (from apps/desktop)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { GIT_NO_FSMONITOR, GIT_TEST_ENV } from "./git-env.ts";

const appDir = path.resolve(import.meta.dirname, "..");
const shots = path.join(appDir, "e2e", ".artifacts");
let base = "";
let env: Record<string, string> = {};
let app: ElectronApplication | undefined;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...GIT_NO_FSMONITOR, "-c", "user.name=ARIA E2E", "-c", "user.email=e2e@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

/** A run of its own: each test starts with an empty data folder. */
async function launch(name: string, extra: Record<string, string>): Promise<Page> {
  app = await electron.launch({ args: [appDir], env: { ...env, ARIA_DATA_DIR: path.join(base, name), ...extra }, timeout: 60_000 });
  return app.firstWindow();
}

test.beforeAll(() => {
  mkdirSync(shots, { recursive: true });
  base = mkdtempSync(path.join(os.tmpdir(), "aria-e2e-reconnect-"));
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
    ARIA_PROJECT_ROOTS: path.join(base, "GitHub"),
    ARIA_WORKTREE_ROOT: path.join(base, "wt"),
  };
});

test.afterEach(async () => {
  await app?.close().catch(() => {
    // Teardown: the app may be gone already, and the test has its result.
  });
  app = undefined;
});

test.afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

test("reconnects after the Copilot runtime wasn't available at startup", async () => {
  test.setTimeout(3 * 60_000);
  const page = await launch("offline", { ARIA_FAKE_RUNTIME: "ui-offline" });

  const status = page.getByTestId("status");
  await expect(status).toHaveAttribute("data-state", "error", { timeout: 60_000 });
  const error = page.getByTestId("error");
  await expect(error).toContainText("ARIA couldn't connect to the Copilot runtime.");
  await expect(error).toContainText("Copilot CLI isn't signed in");
  await expect(page.getByTestId("composer")).toBeDisabled();
  await page.screenshot({ path: path.join(shots, "ui-reconnect-1-error.png") });

  await page.getByTestId("reconnect").click();
  await expect(status).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  await expect(error).toBeHidden();
  await expect(page.getByTestId("reconnect")).toBeHidden();
  await expect(page.getByTestId("composer")).toBeEnabled();
  await page.screenshot({ path: path.join(shots, "ui-reconnect-2-ready.png") });
});

test("shows the runtime ending while a task works, and the task resumes after reconnecting", async () => {
  test.setTimeout(3 * 60_000);
  const page = await launch("dropped", { ARIA_FAKE_RUNTIME: "ui-cards", ARIA_E2E_HOOKS: "1" });
  const status = page.getByTestId("status");
  await expect(status).toHaveAttribute("data-state", "ready", { timeout: 60_000 });

  await page.getByTestId("nav-new-session").click();
  const dialog = page.getByTestId("new-session");
  await dialog.getByTestId("new-session-brief").fill("Slow task: take your time");
  await dialog.getByTestId("new-session-start").click();
  await expect(dialog).toBeHidden();
  await page.getByTestId("session-close").click();
  const task = page.getByTestId("card-task").filter({ hasText: "Slow task" });
  await expect(task.getByTestId("task-state")).toHaveAttribute("data-state", "running");

  // The process ends: nothing tells ARIA, so the regular check finds out.
  await app!.evaluate(() => {
    (globalThis as unknown as { __ariaE2E: { runtime: { started: boolean } } }).__ariaE2E.runtime.started = false;
  });
  await expect(status).toHaveAttribute("data-state", "error", { timeout: 60_000 });
  const error = page.getByTestId("error");
  await expect(error).toContainText("stopped answering");
  const interrupted = page.getByTestId("card-interrupted");
  await expect(interrupted).toContainText("interrupted when the Copilot runtime stopped");
  await expect(interrupted).toContainText("Slow task");
  await page.screenshot({ path: path.join(shots, "ui-reconnect-3-dropped.png") });

  await page.getByTestId("reconnect").click();
  await expect(status).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  await expect(error).toBeHidden();

  await interrupted.getByTestId("interrupted-resume").click();
  await expect(interrupted.getByTestId("interrupted-resume")).toBeHidden();
  await expect(task.getByTestId("task-state")).toHaveAttribute("data-state", "running", { timeout: 60_000 });
  await page.screenshot({ path: path.join(shots, "ui-reconnect-4-resumed.png") });
});
