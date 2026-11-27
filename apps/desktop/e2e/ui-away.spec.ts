/**
 * Phase 3 Part B item 2, attention (PLAN.md §4.5, §5.5, D24, D25), against the scripted runtime with the test hooks
 * (ARIA_E2E_HOOKS=1): toasts are recorded instead of shown, the attention engine's clock moves only when the test
 * says, and the test sets what the window and the system report about you (Windows doesn't let a test give a window the
 * focus reliably). Covers: no toasts while you're there, toasts while away, coalescing, Focus mode (kept across a
 * restart), idle and a locked screen as away (a toast while locked waits for the unlock), the "while you were away"
 * card and its links, and a toast click.
 * Run after `npm run build`:  npx playwright test ui-away   (from apps/desktop)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AriaApi } from "@aria/protocol";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { GIT_NO_FSMONITOR, GIT_TEST_ENV } from "./git-env.ts";

const appDir = path.resolve(import.meta.dirname, "..");
const shots = path.join(appDir, "e2e", ".artifacts");
let base = "";
let env: Record<string, string> = {};
let app: ElectronApplication | undefined;
const MIN = 60_000;

interface RecordedToast {
  id: string;
  priority: string;
  title: string;
  body: string;
  replaces?: string;
  cardId?: string;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", [...GIT_NO_FSMONITOR, "-c", "user.name=ARIA E2E", "-c", "user.email=e2e@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();

async function launch(): Promise<Page> {
  app = await electron.launch({ args: [appDir], env, timeout: 60_000 });
  const page = await app.firstWindow();
  await expect(page.getByTestId("status")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  return page;
}

// The hooks live in the main process (globalThis.__ariaE2E); each call runs there.
const toasts = (): Promise<RecordedToast[]> => app!.evaluate(() => (globalThis as unknown as { __ariaE2E: { toasts: RecordedToast[] } }).__ariaE2E.toasts);
const advance = (ms: number) => app!.evaluate((_electron, by) => (globalThis as unknown as { __ariaE2E: { clock: { advance(ms: number): void } } }).__ariaE2E.clock.advance(by), ms);
/** You're at the window (it's in front and focused), or not: what the window would report, and its event. */
const setPresent = (present: boolean) =>
  app!.evaluate(({ BrowserWindow }, there) => {
    (globalThis as unknown as { __ariaE2E: { window: unknown } }).__ariaE2E.window = { exists: true, visible: true, minimized: false, focused: there };
    BrowserWindow.getAllWindows()[0]!.emit(there ? "focus" : "blur");
  }, present);
const setIdle = (state: "active" | "idle", seconds: number) =>
  app!.evaluate((_electron, idle) => {
    const hooks = (globalThis as unknown as { __ariaE2E: { idle: unknown; presence: { poll(): void } } }).__ariaE2E;
    hooks.idle = idle;
    hooks.presence.poll();
  }, { state, seconds });
/** The screen locks or unlocks: the event, and what the system's idle state then says (as Windows does while locked). */
const power = (event: "lock-screen" | "unlock-screen") =>
  app!.evaluate(({ powerMonitor }, name) => {
    (globalThis as unknown as { __ariaE2E: { idle: unknown } }).__ariaE2E.idle = { state: name === "lock-screen" ? "locked" : "active", seconds: 0 };
    powerMonitor.emit(name as "lock-screen");
  }, event);
const clickToast = (id: string) => app!.evaluate((_electron, toastId) => (globalThis as unknown as { __ariaE2E: { clickToast(id: string): void } }).__ariaE2E.clickToast(toastId), id);

/**
 * Starts a task without touching the window: a click can make Windows send the window a real focus event, which (by
 * design) means you're back, so idle and locked-screen steps start their tasks this way.
 */
async function startQuietly(page: Page, brief: string): Promise<void> {
  await page.evaluate(async (text) => {
    const aria = (window as unknown as { aria: AriaApi }).aria;
    const state = await aria.getState();
    await aria.startTask({ repoId: state.projects[0]!.id, brief: text });
  }, brief);
}

async function newSession(page: Page, brief: string): Promise<void> {
  await page.getByTestId("nav-new-session").click();
  const dialog = page.getByTestId("new-session");
  await dialog.getByTestId("new-session-brief").fill(brief);
  await dialog.getByTestId("new-session-start").click();
  await expect(dialog).toBeHidden();
  await page.getByTestId("session-close").click();
}

test.beforeAll(() => {
  mkdirSync(shots, { recursive: true });
  base = mkdtempSync(path.join(os.tmpdir(), "aria-e2e-away-"));
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

test("attention: toasts only while away, coalescing, Focus mode, idle and lock, the away card", async () => {
  test.setTimeout(5 * 60_000);
  let page = await launch();
  // Test switches don't go unnoticed: the window says so.
  expect(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getTitle())).toBe("ARIA (fake runtime, test hooks)");
  const done = (title: string) => page.getByTestId("card-done").filter({ hasText: title });

  // There: nothing toasts, whatever the priority (D25).
  await setPresent(true);
  await newSession(page, "Docs task: while you're there");
  await expect(done("Docs task: while you're there")).toBeVisible();
  await newSession(page, "Name task: asked while there");
  await expect(page.getByTestId("card-question").filter({ hasText: "Name task: asked while there" })).toBeVisible();
  expect(await toasts()).toEqual([]);

  // Away: two tasks finish at once: the first toasts now, both become one toast when the 30 s are up (D24).
  await setPresent(false);
  await newSession(page, "Docs task: one");
  await newSession(page, "Docs task: two");
  await expect(done("Docs task: two")).toBeVisible();
  await expect(done("Docs task: one")).toBeVisible();
  let shown = await toasts();
  expect(shown).toHaveLength(1);
  expect(shown[0]).toMatchObject({ priority: "milestone", title: expect.stringMatching(/^Docs task: (one|two) is done$/) });
  await advance(30_000);
  shown = await toasts();
  expect(shown[1]).toMatchObject({ priority: "milestone", title: "2 tasks finished", replaces: shown[0]!.id });

  // Focus mode (the header): a Done doesn't toast, a question does.
  await page.getByTestId("focus-mode").click();
  await expect(page.getByTestId("focus-mode")).toHaveAttribute("aria-pressed", "true");
  await newSession(page, "Docs task: in focus mode");
  await expect(done("Docs task: in focus mode")).toBeVisible();
  await newSession(page, "Name task: asked in focus mode");
  await expect(page.getByTestId("card-question").filter({ hasText: "Name task: asked in focus mode" })).toBeVisible();
  shown = await toasts();
  expect(shown.slice(2).map((t) => [t.priority, t.title])).toEqual([["blocking", "Name task: asked in focus mode needs you"]]);

  // Back after 20 minutes: one card, with what needs you (new and from before), what finished, each line to its card.
  await advance(20 * MIN);
  await setPresent(true);
  const away = page.getByTestId("card-away");
  await expect(away).toHaveCount(1);
  await expect(away).toContainText("While you were away · 20m");
  await expect(away.getByTestId("away-group")).toHaveCount(2);
  const needs = away.locator('[data-testid="away-group"][data-kind="needs_you"] [data-testid="away-line"]');
  await expect(needs).toHaveCount(2);
  await expect(needs.first()).toContainText("Name task: asked while there");
  await expect(needs.first()).toContainText("(was waiting before)");
  await expect(needs.last()).toContainText("Name task: asked in focus mode");
  const finished = away.locator('[data-testid="away-group"][data-kind="done"] [data-testid="away-line"]');
  await expect(finished).toHaveCount(3);
  await page.screenshot({ path: path.join(shots, "ui-p3b-3-away.png") });
  await finished.filter({ hasText: "Docs task: one" }).click();
  await expect(done("Docs task: one")).toBeInViewport();
  await page.getByTestId("focus-mode").click();
  await expect(page.getByTestId("focus-mode")).toHaveAttribute("aria-pressed", "false");

  // Idle with the window in front counts as away (from the last input); input again brings you back.
  await setIdle("idle", 400);
  await startQuietly(page, "Docs task: while idle");
  await expect(done("Docs task: while idle")).toBeVisible();
  expect((await toasts()).at(-1)).toMatchObject({ title: "Docs task: while idle is done" });
  await setIdle("active", 0);
  // A locked screen is away too, but Windows drops a toast shown while it's locked (checked on real Windows, Phase 9):
  // the question toasts after you unlock, as you're still away from ARIA a moment later (1.5 s on its clock).
  const before = (await toasts()).length;
  await power("lock-screen");
  await startQuietly(page, "Name task: asked while locked");
  await expect(page.getByTestId("card-question").filter({ hasText: "Name task: asked while locked" })).toBeVisible();
  expect((await toasts()).slice(before)).toEqual([]);
  await setPresent(false);
  await power("unlock-screen");
  expect((await toasts()).slice(before)).toEqual([]);
  await advance(2_000);
  await expect.poll(async () => (await toasts()).slice(before).map((t) => t.title)).toEqual(["Name task: asked while locked needs you"]);
  await setPresent(true);
  // Answered, so the three tasks waiting on you free their slots (a waiting task holds one, Part A's known limit).
  const open = page.getByTestId("card-question").filter({ has: page.getByTestId("question-reply") });
  for (let left = 3; left > 0; left--) {
    await expect(open).toHaveCount(left);
    await open.first().getByTestId("question-reply").fill("Beacon");
    await open.first().getByTestId("question-send").click();
  }
  await expect(open).toHaveCount(0);
  // The away card shows its "needs you" lines as settled now (it's a snapshot, the lines aren't).
  await expect(needs).toHaveCount(2);
  for (const settled of await needs.all()) await expect(settled).toHaveAttribute("data-status", "settled");
  await expect(finished.first()).toHaveAttribute("data-status", "open");
  await expect(page.getByTestId("card-done").filter({ hasText: "Name task" })).toHaveCount(3);

  // A toast clicked after a long time away: its card is what you see, and the away card comes too, at the bottom.
  await advance(10 * MIN);
  await setPresent(false);
  await newSession(page, "Docs task: clicked toast");
  await expect(done("Docs task: clicked toast")).toBeVisible();
  for (const text of ["First thing", "Second thing", "Third thing"]) {
    await page.getByTestId("composer").fill(text);
    await page.getByTestId("composer").press("Enter");
    await expect(page.getByTestId("msg-assistant").last()).toContainText(text);
  }
  const clicked = (await toasts()).find((t) => t.title === "Docs task: clicked toast is done")!;
  await advance(20 * MIN);
  const cards = await page.getByTestId("card-away").count();
  await clickToast(clicked.id);
  await setPresent(true);
  await expect(page.getByTestId("card-away")).toHaveCount(cards + 1);
  await expect(done("Docs task: clicked toast")).toBeInViewport();
  await expect(page.getByTestId("card-away").last()).not.toBeInViewport();

  // Focus mode is kept across a restart.
  await page.getByTestId("focus-mode").click();
  await expect(page.getByTestId("focus-mode")).toHaveAttribute("aria-pressed", "true");
  await app!.close();
  page = await launch();
  await expect(page.getByTestId("focus-mode")).toHaveAttribute("aria-pressed", "true");
  await app!.close();
  app = undefined;
});
