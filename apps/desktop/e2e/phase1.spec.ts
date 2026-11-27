/**
 * Phase 1 "done when" check, end to end against the real Copilot runtime (PLAN.md §10): chat with ARIA about your
 * repos with the model you picked, close the app, reopen it, and continue the same conversation.
 *
 * Uses a throwaway data folder and Conductor session id (deleted afterwards) and the cheapest model. Run after
 * `npm run build`:  npx playwright test   (from apps/desktop)
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { GIT_TEST_ENV } from "./git-env.ts";
import { CopilotRuntime } from "@aria/core";

const appDir = path.resolve(import.meta.dirname, "..");
const shots = path.join(appDir, "e2e", ".artifacts");
// Set in beforeAll: Playwright also loads this file in the runner process, which must not create anything.
let dataDir = "";
let conductorId = "";
let env: Record<string, string> = {};
let current: ElectronApplication | undefined;

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [appDir], env, timeout: 60_000 });
  current = app;
  const page = await app.firstWindow();
  await expect(page.getByTestId("status")).toHaveAttribute("data-state", "ready", { timeout: 240_000 });
  return { app, page };
}

async function ask(page: Page, text: string): Promise<string> {
  const before = await page.getByTestId("msg-assistant").count();
  await page.getByTestId("composer").fill(text);
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("msg-assistant")).toHaveCount(before + 1);
  await expect(page.getByTestId("status")).toHaveAttribute("data-state", "ready");
  return (await page.getByTestId("msg-assistant").last().innerText()).trim();
}

test.beforeAll(() => {
  mkdirSync(shots, { recursive: true });
  dataDir = mkdtempSync(path.join(os.tmpdir(), "aria-e2e-"));
  conductorId = `aria-e2e-${Date.now()}`;
  const inherited = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  env = {
    ...inherited,
    ...GIT_TEST_ENV,
    // A test run: no GitHub in it (no gh token, no request to github.com; main/github-options.ts).
    ARIA_TEST_RUN: "1",
    ARIA_DATA_DIR: dataDir,
    // ARIA's task folders (and the runtime's temp folder in them) stay in this run's folder, not C:\wt.
    ARIA_WORKTREE_ROOT: path.join(dataDir, "wt"),
    ARIA_CONDUCTOR_ID: conductorId,
    ARIA_MODEL: process.env.ARIA_E2E_MODEL ?? "claude-haiku-5.5",
  };
});

test.afterAll(async () => {
  await current?.close().catch(() => {
    // Teardown: the app may be gone already, and the test has its result.
  });
  const runtime = new CopilotRuntime();
  try {
    await runtime.start();
    await runtime.deleteSession(conductorId).catch((e: unknown) => console.warn(`Couldn't delete e2e session ${conductorId}:`, e));
  } finally {
    await runtime.stop().catch(() => {
      // Teardown: the sessions are deleted by now, and the test has its result.
    });
    if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
});

test("chat about my repos, restart, same conversation, change the model", async () => {
  let { app, page } = await launch();
  // This test run has no GitHub (ARIA_TEST_RUN): gh isn't asked for its token, github.com isn't read.
  expect(await page.evaluate(async () => (await (globalThis as unknown as { aria: { getState(): Promise<{ github: { status: string } }> } }).aria.getState()).github.status)).toBe("off");
  await expect(page.getByTestId("project").first()).toBeVisible();
  await page.screenshot({ path: path.join(shots, "1-ready.png") });

  const first = await ask(page, "Which of my projects has 'Tower' in its name? Use list_repos and answer with just the project name.");
  expect(first).toContain("Castle Defense");
  await page.screenshot({ path: path.join(shots, "2-answer.png") });

  // The sidebar can be hidden and restored with the mouse, not only with Ctrl+B.
  await page.getByTestId("toggle-sidebar").click();
  await expect(page.getByRole("navigation")).toBeHidden();
  await page.getByTestId("toggle-sidebar").click();
  await expect(page.getByRole("navigation")).toBeVisible();
  await app.close();

  ({ app, page } = await launch());
  await expect(page.getByTestId("msg-user").first()).toContainText("Tower");
  const second = await ask(page, "Without using tools: which project did you just name for me? One short sentence.");
  expect(second).toContain("Tower");
  await page.screenshot({ path: path.join(shots, "3-after-restart.png") });

  await page.getByTestId("nav-customize").click();
  await expect(page.getByTestId("model-select")).toBeVisible();
  await expect(page.locator('[data-testid="model-select"] option:not([value=""])').first()).toBeAttached();
  await page.getByTestId("model-select").selectOption("gpt-6-luna");
  await page.getByTestId("effort-select").selectOption("low");
  await page.getByTestId("save-model").click();
  await expect(page.getByTestId("saved")).toBeVisible();
  await page.screenshot({ path: path.join(shots, "4-customize.png") });

  await page.getByTestId("nav-aria").click();
  await expect(page.getByTestId("status-model")).toContainText("gpt-6-luna · low");
  const third = await ask(page, "Reply with exactly: OK");
  expect(third).toContain("OK");
  await page.screenshot({ path: path.join(shots, "5-new-model.png") });
  await app.close();
  current = undefined;
});
