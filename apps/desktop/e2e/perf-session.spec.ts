/**
 * How much the session view draws (P2), against the scripted runtime (ARIA_FAKE_RUNTIME=ui-cards): no model calls, no
 * credits. A task writes 1,950 steps, asks a question, then adds 50 more one at a time. The spec opens its session,
 * answers there, and counts React commits and component renders (through `__REACT_DEVTOOLS_GLOBAL_HOOK__`) and long
 * tasks while the new steps come in, and the steps each transcript read sends (P4). Run after `npm run build`:
 *   npx playwright test perf-session   (from apps/desktop)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { GIT_NO_FSMONITOR, GIT_TEST_ENV } from "./git-env.ts";
import { installCounters, readPerf, resetPerf } from "./perf-counters.ts";

const appDir = path.resolve(import.meta.dirname, "..");
const shots = path.join(appDir, "e2e", ".artifacts");
let base = "";
let app: ElectronApplication | undefined;

/**
 * In the main process: each transcript read (P4) is counted, with the steps it sent and how long it took, and can be
 * slowed down (`slowTranscriptReads`). It wraps the handler Electron keeps for the channel (`_invokeHandlers`,
 * internal); false when that isn't there.
 */
const countTranscriptReads = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }) => {
    type Handler = (...args: unknown[]) => unknown;
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })._invokeHandlers;
    const handler = handlers?.get("aria:get-transcript");
    if (!handlers || !handler) return false;
    const reads: Array<{ input: unknown; entries: number; omitted: number; ms: number }> = [];
    const state = globalThis as { __transcriptReads?: typeof reads; __transcriptDelayMs?: number };
    state.__transcriptReads = reads;
    handlers.set("aria:get-transcript", async (...args: unknown[]) => {
      const start = performance.now();
      const page = (await handler(...args)) as { entries: unknown[]; omitted: number };
      reads.push({ input: args[1], entries: page.entries.length, omitted: page.omitted, ms: Math.round(performance.now() - start) });
      if (state.__transcriptDelayMs) await new Promise((resolve) => setTimeout(resolve, state.__transcriptDelayMs));
      return page;
    });
    return true;
  });
const slowTranscriptReads = (app: ElectronApplication, ms: number) =>
  app.evaluate((_electron, delay) => {
    (globalThis as { __transcriptDelayMs?: number }).__transcriptDelayMs = delay;
  }, ms);
const takeTranscriptReads = (app: ElectronApplication) =>
  app.evaluate(() => {
    const reads = (globalThis as { __transcriptReads?: Array<{ input: unknown; entries: number; omitted: number; ms: number }> }).__transcriptReads ?? [];
    return reads.splice(0);
  });

test.beforeAll(() => {
  mkdirSync(shots, { recursive: true });
  base = mkdtempSync(path.join(os.tmpdir(), "aria-e2e-"));
  const repo = path.join(base, "GitHub", "Demo App");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", [...GIT_NO_FSMONITOR, "-c", "user.name=ARIA E2E", "-c", "user.email=e2e@example.invalid", ...args], { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "# Demo App\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Initial commit");
});

test.afterAll(async () => {
  await app?.close().catch(() => {
    // Teardown: the app may be gone already, and the test has its result.
  });
  if (base) rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

test("a long session draws only what's new as steps come in", async () => {
  test.setTimeout(8 * 60_000);
  const inherited = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  const launched = await electron.launch({
    args: [appDir],
    env: {
      ...inherited,
      ...GIT_TEST_ENV,
      ARIA_FAKE_RUNTIME: "ui-cards",
      ARIA_DATA_DIR: path.join(base, "data"),
      ARIA_PROJECT_ROOTS: path.join(base, "GitHub"),
      ARIA_WORKTREE_ROOT: path.join(base, "wt"),
    },
    timeout: 60_000,
  });
  app = launched;
  const page = await launched.firstWindow();
  await page.addInitScript(installCounters);
  await page.reload();
  await expect(page.getByTestId("status")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  const counting = await countTranscriptReads(launched);

  // Started here, its session opens at once and stays open while it writes its 1,950 steps and asks its question: what
  // you follow at the end stays at two pages at most, besides the brief.
  await resetPerf(page);
  await page.getByTestId("nav-new-session").click();
  const dialog = page.getByTestId("new-session");
  await dialog.getByTestId("new-session-brief").fill("Long session task: read the code base");
  await dialog.getByTestId("new-session-start").click();
  await expect(dialog).toBeHidden();
  const view = page.getByTestId("session-view");
  const transcript = view.getByTestId("transcript");
  const rows = transcript.locator("[data-entry-id]");
  await expect(view.getByTestId("session-question")).toBeVisible({ timeout: 5 * 60_000 });
  const watched = { ...(await readPerf(page)), rows: await rows.count() };
  expect(watched.rows).toBeLessThanOrEqual(2 * 200 + 1);
  expect(watched.mostSteps).toBeLessThanOrEqual(2);
  await page.getByTestId("session-close").click();
  await takeTranscriptReads(launched);

  // Opened again: its newest page arrives (P4: not the whole transcript), and the brief and the last 200 steps are
  // drawn. Closed and opened once more, the same.
  const openOnce = async () => {
    await resetPerf(page);
    const opening = Date.now();
    await page.getByTestId("card-task").filter({ hasText: "Long session task" }).getByTestId("task-open").click();
    await expect(view.getByTestId("transcript-question")).toBeVisible();
    const openMs = Date.now() - opening;
    const open = await readPerf(page);
    await expect(rows).toHaveCount(201);
    // The brief, 1,950 steps and the question make 1,952: 1,751 aren't shown.
    await expect(view.getByTestId("transcript-earlier")).toHaveAttribute("data-count", "1751");
    return { openMs, open, reads: await takeTranscriptReads(launched) };
  };
  const { openMs, open, reads: openReads } = await openOnce();
  await page.getByTestId("session-close").click();
  const again = await openOnce();
  if (counting) {
    for (const reads of [openReads, again.reads]) {
      expect(reads).toHaveLength(1);
      expect(reads[0]!.entries).toBeLessThanOrEqual(300);
    }
  }

  // Answered here, it adds 50 steps one at a time.
  await resetPerf(page);
  await view.getByTestId("session-question").getByTestId("question-choice").filter({ hasText: "Go on" }).click();
  await expect(view.getByTestId("transcript-assistant").filter({ hasText: "Read the last modules." })).toBeVisible({ timeout: 2 * 60_000 });
  const tail = await readPerf(page);
  const shown = await rows.count();
  await page.screenshot({ path: path.join(shots, "perf-session.png") });

  const result = { watched, openMs, open, openReads, again, tail, rendersPerCommit: tail.commits ? Math.round(tail.renders / tail.commits) : 0, shown };
  writeFileSync(path.join(shots, "perf-session.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`perf-session: ${JSON.stringify(result)}`);
  // Each new step draws itself (and the step it updates), not the 2,000 before it: before P2 it was every one, about
  // 11,700 component renders a commit.
  expect(tail.mostSteps).toBeLessThanOrEqual(2);
  expect(result.rendersPerCommit).toBeLessThan(100);
  // Shown from where it opened, new steps added.
  expect(shown).toBeGreaterThan(201);
  expect(shown).toBeLessThan(262);

  // "Show more" adds a page above, and the step you were looking at stays where it was (also a moment later). Where it
  // was is where it is as you click: the button is scrolled into view first (a click would do that, and the open brief
  // can push it below the panel's edge).
  const firstAfterNote = transcript.locator('[data-testid="transcript-earlier"] + [data-entry-id]');
  const showEarlier = view.getByTestId("transcript-show-earlier");
  /** Up to the note, until it stays there (a step that comes in before the scroll is noticed takes a session you follow back to its end). */
  const upToTheNote = async () => {
    for (let tries = 0; tries < 10; tries++) {
      await transcript.evaluate((el) => (el.parentElement!.scrollTop = 0));
      await showEarlier.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      if (await showEarlier.evaluate((el) => el.getBoundingClientRect().bottom <= el.closest(".overflow-y-auto")!.getBoundingClientRect().bottom)) return;
    }
    throw new Error("The transcript kept going back to its end");
  };
  /** "Show more", and where the first step below the note is before it and a moment after, and how many steps came in below meanwhile. */
  const showMoreFromTheNote = async () => {
    await upToTheNote();
    const id = (await firstAfterNote.getAttribute("data-entry-id"))!;
    const row = transcript.locator(`[data-entry-id="${id}"]`);
    const before = (await row.boundingBox())!;
    const count = await rows.count();
    await showEarlier.click();
    await expect.poll(() => rows.count(), { intervals: [10] }).toBeGreaterThanOrEqual(count + 200);
    const cameIn = (await rows.count()) - count - 200;
    await page.waitForTimeout(1_000);
    return { moved: Math.abs((await row.boundingBox())!.y - before.y), cameIn };
  };
  const stays = async () => {
    const { moved, cameIn } = await showMoreFromTheNote();
    expect(cameIn).toBe(0);
    expect(moved).toBeLessThan(2);
  };
  await stays();
  // Past the steps in the store, it read the page before them.
  const showMoreReads = await takeTranscriptReads(launched);
  if (counting) expect(showMoreReads.map((r) => r.entries)).toEqual([200]);
  console.log(`perf-session reads: ${JSON.stringify({ openReads, again: again.reads, showMoreReads })}`);

  // A jump from Search to a step further back shows it, and "Show more" then doesn't take you back to it.
  await page.getByTestId("session-close").click();
  await page.getByTestId("nav-search").click();
  const search = page.getByTestId("search-view");
  await search.getByTestId("search-input").fill("module-1500.ts");
  const hit = search.getByTestId("search-hit-transcript").first();
  await expect(hit).toBeVisible();
  const hitId = (await hit.getAttribute("data-entry-id"))!;
  await hit.getByTestId("search-open-session").click();
  await expect(transcript.locator(`[data-entry-id="${hitId}"]`)).toBeInViewport();
  await page.waitForTimeout(1_000);
  await stays();

  // On a task that's running, "Show more" is a read away while new steps come in below (P4): the step you were looking
  // at still stays where it was. The read is slowed down in the main process, so steps come in while it's on its way.
  await page.getByTestId("session-close").click();
  await page.getByTestId("nav-aria").click();
  await page.getByTestId("nav-new-session").click();
  await dialog.getByTestId("new-session-brief").fill("Long session task: read it all again");
  await dialog.getByTestId("new-session-start").click();
  await expect(dialog).toBeHidden();
  await expect(view.getByTestId("session-question")).toBeVisible({ timeout: 5 * 60_000 });
  await page.getByTestId("session-close").click();
  await page.getByTestId("card-task").filter({ hasText: "read it all again" }).getByTestId("task-open").click();
  await expect(rows).toHaveCount(201);
  await view.getByTestId("session-question").getByTestId("question-choice").filter({ hasText: "Go on" }).click();
  await expect.poll(() => rows.count()).toBeGreaterThan(205);
  // To the diff and back: the transcript opens again on its last 200 steps, some of which came after the page it read.
  // "Show more" then shows those first, and the rest when the read comes.
  await view.getByTestId("session-tab-diff").click();
  await view.getByTestId("session-tab-transcript").click();
  // (At least: steps go on coming in, and the view follows them until it's scrolled up.)
  await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(201);
  await slowTranscriptReads(launched, counting ? 800 : 0);
  const running = await showMoreFromTheNote();
  await slowTranscriptReads(launched, 0);
  console.log(`perf-session running: ${JSON.stringify(running)}`);
  if (counting) expect(running.cameIn).toBeGreaterThan(0);
  expect(running.moved).toBeLessThan(2);
});
