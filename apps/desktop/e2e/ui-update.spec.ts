/**
 * Update now or later (D80), against a made-up release (`ARIA_FAKE_UPDATE`, fake-update.ts: nothing goes on the
 * network) and the scripted runtime:
 * - The update bar says ARIA v99.0.0 is out; Later hides it, also after a restart.
 * - Update now asks first while a task is in progress, then downloads the installer, checks it, and hands it over
 *   (the hooks record it instead of starting it).
 * - A download whose checksum doesn't match is refused and said so, with Download instead.
 * Run after `npm run build`:  npx playwright test ui-update   (from apps/desktop)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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

async function launch(name: string, extra: Record<string, string> = {}): Promise<Page> {
  app = await electron.launch({
    args: [appDir],
    env: { ...env, ARIA_DATA_DIR: path.join(base, name), ARIA_FAKE_RUNTIME: "ui-cards", ARIA_E2E_HOOKS: "1", ARIA_FAKE_UPDATE: "99.0.0", ...extra },
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  await expect(page.getByTestId("status")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  return page;
}

async function close(): Promise<void> {
  await app?.close().catch(() => {
    // Teardown: the app may be gone already, and the test has its result.
  });
  app = undefined;
}

const recordedInstaller = () =>
  app!.evaluate(() => (globalThis as unknown as { __ariaE2E: { updateInstaller?: string } }).__ariaE2E.updateInstaller ?? null);

test.beforeAll(() => {
  mkdirSync(shots, { recursive: true });
  base = mkdtempSync(path.join(os.tmpdir(), "aria-e2e-update-"));
  const repo = path.join(base, "GitHub", "Demo App");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "# Demo App\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Initial commit");
  const inherited = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  env = { ...inherited, ...GIT_TEST_ENV, ARIA_PROJECT_ROOTS: path.join(base, "GitHub"), ARIA_WORKTREE_ROOT: path.join(base, "wt") };
});

test.afterEach(close);

test.afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

test("shows the update bar, and Later hides it, also after a restart", async () => {
  test.setTimeout(3 * 60_000);
  let page = await launch("later");
  const bar = page.getByTestId("update-bar");
  await expect(bar).toHaveAttribute("data-phase", "idle");
  await expect(bar).toContainText("ARIA v99.0.0 is available");
  await expect(page.getByTestId("whats-new-modal")).toBeHidden();
  await expect(page.getByTestId("sidebar-update-dot")).toBeVisible();
  await page.screenshot({ path: path.join(shots, "ui-update-1-bar.png") });

  await bar.getByTestId("update-bar-whats-new").click();
  const modal = page.getByTestId("whats-new-modal");
  await expect(modal.getByTestId("update-available-install")).toBeVisible();
  await modal.getByTestId("whats-new-close").click();
  // Reading the notes isn't Later.
  await expect(bar).toBeVisible();

  await bar.getByTestId("update-bar-later").click();
  await expect(bar).toBeHidden();
  await expect(page.getByTestId("sidebar-update-dot")).toBeVisible();

  await close();
  page = await launch("later");
  await expect(page.getByTestId("sidebar-update-dot")).toBeVisible();
  await expect(page.getByTestId("update-bar")).toBeHidden();
});

test("Update now asks while a task is in progress, then downloads, checks and hands over the installer", async () => {
  test.setTimeout(3 * 60_000);
  const page = await launch("install");
  await page.getByTestId("nav-new-session").click();
  const dialog = page.getByTestId("new-session");
  await dialog.getByTestId("new-session-brief").fill("Slow task: take your time");
  await dialog.getByTestId("new-session-start").click();
  await expect(dialog).toBeHidden();
  await page.getByTestId("session-close").click();
  const task = page.getByTestId("card-task").filter({ hasText: "Slow task" });
  await expect(task.getByTestId("task-state")).toHaveAttribute("data-state", "running");

  const bar = page.getByTestId("update-bar");
  await bar.getByTestId("update-bar-update").click();
  await expect(bar).toHaveAttribute("data-phase", "confirming");
  await expect(bar.getByTestId("update-bar-question")).toHaveText(
    "1 task is in progress. Updating restarts ARIA: it stops, and you can resume it after the restart.",
  );
  await page.screenshot({ path: path.join(shots, "ui-update-2-confirm.png") });
  await bar.getByTestId("update-bar-cancel").click();
  await expect(bar).toHaveAttribute("data-phase", "idle");
  expect(await recordedInstaller()).toBeNull();

  await bar.getByTestId("update-bar-update").click();
  await bar.getByTestId("update-bar-confirm").click();
  await expect(bar).toHaveAttribute("data-phase", "installing", { timeout: 30_000 });
  await expect(bar).toContainText("Restarting ARIA to install v99.0.0");
  await page.screenshot({ path: path.join(shots, "ui-update-3-installing.png") });
  const installer = await recordedInstaller();
  expect(installer && path.basename(installer)).toBe("ARIA-Setup-99.0.0.exe");
  expect(statSync(installer!).size).toBeGreaterThan(100_000);
});

test("refuses a download whose checksum doesn't match, and offers Download instead", async () => {
  test.setTimeout(3 * 60_000);
  const page = await launch("bad", { ARIA_FAKE_UPDATE: "99.0.0:bad-checksum" });
  const bar = page.getByTestId("update-bar");
  await bar.getByTestId("update-bar-update").click();
  await expect(bar).toHaveAttribute("data-phase", "failed", { timeout: 30_000 });
  await expect(bar.getByTestId("update-bar-error")).toContainText("doesn't match the installer's checksum");
  await expect(bar.getByTestId("update-bar-download")).toBeVisible();
  await expect(bar.getByTestId("update-bar-retry")).toBeVisible();
  expect(await recordedInstaller()).toBeNull();
  await page.screenshot({ path: path.join(shots, "ui-update-4-failed.png") });
});
