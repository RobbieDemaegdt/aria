/**
 * Phase 2 "done when" (PLAN.md §10), end to end against the real Copilot runtime: "add X to repo Y" produces a committed
 * branch and a Done card with a diff, using the profile you chose, while you keep chatting about something else, and
 * the session can be opened from the sidebar with every step readable.
 *
 * Everything is throwaway: a temp git repo without dependencies (`npm test` runs `node test.js`), the worktree root, the
 * data folder and the sessions, all deleted afterwards. Cost: one small task on the Quick profile (the cheapest model).
 * Run after `npm run build`:  npx playwright test phase2   (from apps/desktop)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { GIT_NO_FSMONITOR, GIT_TEST_ENV } from "./git-env.ts";
import { CopilotRuntime } from "@aria/core";
import type { AppState } from "@aria/protocol";

const appDir = path.resolve(import.meta.dirname, "..");
const shots = path.join(appDir, "e2e", ".artifacts");
let base = "";
let repo = "";
let conductorId = "";
let env: Record<string, string> = {};
let app: ElectronApplication | undefined;
let taskIds: string[] = [];

const git = (cwd: string, ...args: string[]) => execFileSync("git", [...GIT_NO_FSMONITOR, "-c", "user.name=ARIA E2E", "-c", "user.email=e2e@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();
const appState = (page: Page) => page.evaluate(async () => (globalThis as unknown as { aria: { getState(): Promise<AppState> } }).aria.getState());

async function ask(page: Page, text: string): Promise<string> {
  const before = await page.getByTestId("msg-assistant").count();
  await page.getByTestId("composer").fill(text);
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("msg-assistant")).toHaveCount(before + 1, { timeout: 240_000 });
  await expect(page.getByTestId("status")).toHaveAttribute("data-state", "ready");
  return (await page.getByTestId("msg-assistant").last().innerText()).trim();
}

test.beforeAll(() => {
  mkdirSync(shots, { recursive: true });
  base = mkdtempSync(path.join(os.tmpdir(), "aria-e2e-"));
  repo = path.join(base, "GitHub", "Calc Demo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "package.json"), `${JSON.stringify({ name: "calc-demo", version: "1.0.0", private: true, scripts: { test: "node test.js" } }, null, 2)}\n`);
  writeFileSync(path.join(repo, "math.js"), "function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n");
  writeFileSync(path.join(repo, "test.js"), 'const assert = require("node:assert");\nconst { add } = require("./math");\n\nassert.strictEqual(add(2, 3), 5);\nconsole.log("all tests passed");\n');
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Calculator with add");
  conductorId = `aria-e2e-${Date.now()}`;
  const inherited = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  env = {
    ...inherited,
    ...GIT_TEST_ENV,
    // A test run: no GitHub in it (no gh token, no request to github.com; main/github-options.ts).
    ARIA_TEST_RUN: "1",
    ARIA_DATA_DIR: path.join(base, "data"),
    ARIA_PROJECT_ROOTS: path.join(base, "GitHub"),
    ARIA_WORKTREE_ROOT: path.join(base, "wt"),
    ARIA_CONDUCTOR_ID: conductorId,
    ARIA_MODEL: process.env.ARIA_E2E_MODEL ?? "claude-haiku-5.5",
  };
});

test.afterAll(async () => {
  await app?.close().catch(() => {
    // Teardown: the app may be gone already, and the test has its result.
  });
  const runtime = new CopilotRuntime();
  try {
    await runtime.start();
    for (const id of [conductorId, ...taskIds.map((t) => `aria-task-${t}`)]) {
      await runtime.deleteSession(id).catch((e: unknown) => console.warn(`Couldn't delete e2e session ${id}:`, e));
    }
  } finally {
    await runtime.stop().catch(() => {
      // Teardown: the sessions are deleted by now, and the test has its result.
    });
    if (base) rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
});

test("add X to repo Y: a committed branch and a Done card with a diff, chatting meanwhile, every step readable", async () => {
  test.setTimeout(15 * 60_000);
  app = await electron.launch({ args: [appDir], env, timeout: 60_000 });
  const page = await app.firstWindow();
  await expect(page.getByTestId("status")).toHaveAttribute("data-state", "ready", { timeout: 240_000 });
  const project = page.locator('[data-testid="project"][data-project="Calc Demo"]');
  await expect(project).toBeVisible();
  // This test run has no GitHub (ARIA_TEST_RUN): gh isn't asked for its token, github.com isn't read.
  expect((await appState(page)).github.status).toBe("off");

  // 1. Ask for a change, naming the profile.
  await ask(page, "In the Calc Demo project, add a subtract(a, b) function to math.js, export it, and add a test for it in test.js. Use the Quick profile.");
  const taskCard = page.getByTestId("card-task").first();
  await expect(taskCard).toBeVisible();
  await expect(taskCard).toContainText("Quick");
  taskIds = (await appState(page)).tasks.map((t) => t.id);
  expect(taskIds).toHaveLength(1);
  await page.screenshot({ path: path.join(shots, "p2-1-started.png") });

  // 2. Keep chatting about something else while it works.
  const stateWhileChatting = await taskCard.getByTestId("task-state").getAttribute("data-state");
  const answer = await ask(page, "Unrelated: what is 2 + 2? Answer with just the number.");
  expect(answer).toContain("4");
  console.log(`The task was ${stateWhileChatting} when the unrelated question was asked.`);

  // 3. The Done card with the change. The worker reported it finished (task_complete), it didn't just go quiet.
  const done = page.getByTestId("card-done");
  await expect(done).toBeVisible({ timeout: 10 * 60_000 });
  await expect(done.getByTestId("done-stats")).toContainText(/changed .* in \d+ commit/);
  await expect(done).not.toContainText("went quiet");
  await expect(done).not.toContainText(/task_complete.{0,20}(isn't|not) available/i);
  await page.screenshot({ path: path.join(shots, "p2-2-done.png") });

  // 4. The commit is on the task's branch, with the profile you named; your checkout of main is untouched, and the
  //    branch's tests pass when ARIA's test runs them itself.
  const task = (await appState(page)).tasks[0]!;
  expect(task).toMatchObject({ state: "done", profileName: "Quick", startedBy: "aria" });
  // Phase 3 (D20): it ran in the runtime's sandbox, and committed and tested from inside it.
  expect(task.sandboxed).toBe(true);
  expect(task.commits).toBeGreaterThan(0);
  expect(git(repo, "diff", `main...${task.branch}`, "--", "math.js")).toContain("subtract");
  expect(git(repo, "show", "main:math.js")).not.toContain("subtract");
  expect(git(repo, "branch", "--show-current")).toBe("main");
  execFileSync("node", ["test.js"], { cwd: task.worktreePath! });

  // 5. Open the session from the sidebar and read every step.
  await project.getByTestId("session").first().click();
  const view = page.getByTestId("session-view");
  await expect(view).toBeVisible();
  await expect(view.getByTestId("transcript-user").first()).toContainText("subtract");
  await expect(view.getByTestId("session-sandboxed")).toBeVisible();
  await expect(view.getByTestId("transcript-tool").first()).toBeVisible();
  const tools = await view.getByTestId("transcript-tool").evaluateAll((els) => els.map((e) => e.getAttribute("data-tool")));
  console.log(`Steps in the transcript: ${tools.join(", ")}`);
  const failed = await view.locator('[data-testid="transcript-tool"]').filter({ hasText: "failed" }).allInnerTexts();
  if (failed.length) console.log(`Steps that failed (the sandbox may have refused them): ${failed.join(" | ")}`);
  expect(tools.length).toBeGreaterThan(1);
  await page.screenshot({ path: path.join(shots, "p2-3-session.png") });

  // 6. The diff tab shows the change.
  await view.getByTestId("session-tab-diff").click();
  await expect(view.locator('[data-testid="diff-file"][data-path="math.js"]')).toContainText("subtract");
  await page.screenshot({ path: path.join(shots, "p2-4-diff.png") });

  await app.close();
  app = undefined;
});
