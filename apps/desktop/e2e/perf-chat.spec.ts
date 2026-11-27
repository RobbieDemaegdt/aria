/**
 * How much the chat draws while ARIA writes a reply (P1, P3, P6), against the scripted runtime
 * (ARIA_FAKE_RUNTIME=ui-cards): no model calls, no credits. The chat holds 200 synthetic messages, made here in a
 * throwaway data folder. The spec sends "Stream a long reply" (a 20-part Markdown reply in 8-character chunks, 4 ms
 * apart in the script, about 15 ms on Windows), then "Stream a long reply at once", and counts React commits and component
 * renders (through `__REACT_DEVTOOLS_GLOBAL_HOOK__`), animation frames and long tasks until each reply is final and the
 * window has gone quiet. Run after `npm run build`:
 *   npx playwright test perf-chat   (from apps/desktop)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "@aria/core";
import type { ChatItem } from "@aria/protocol";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { GIT_TEST_ENV } from "./git-env.ts";
import { installCounters, readPerf, resetPerf, type Commit } from "./perf-counters.ts";

const appDir = path.resolve(import.meta.dirname, "..");
const shots = path.join(appDir, "e2e", ".artifacts");
let base = "";
let app: ElectronApplication | undefined;

const SEEDED = 200;
/** Every fifth reply has a code block, so whatever code blocks start (highlighting) has run once before the spec counts. */
const withCode = (index: number) => index % 10 === 1;

/** A made-up conversation, a minute apart up to now: your question, then ARIA's Markdown answer. */
function seedChat(dataDir: string): void {
  const store = new Store(path.join(dataDir, "aria.db"));
  try {
    const start = Date.now() - SEEDED * 60_000;
    for (let index = 0; index < SEEDED; index++) {
      const n = Math.floor(index / 2) + 1;
      const createdAt = start + index * 60_000;
      const item: ChatItem =
        index % 2 === 0
          ? { kind: "chat", id: `seed-${index}`, role: "user", content: `Synthetic question ${n}: what changed in module ${n}?`, createdAt }
          : {
              kind: "chat",
              id: `seed-${index}`,
              role: "assistant",
              content: [
                `Synthetic answer ${n}. Module ${n} changed in **three** places:`,
                "",
                `- \`module-${n}.ts\` reads its settings once`,
                "- the cache keeps the newest 200 entries",
                "- errors are logged once per streak",
                ...(withCode(index) ? ["", "```ts", `export const module${n} = { cached: 200 };`, "```"] : []),
              ].join("\n"),
              createdAt,
              model: "synthetic",
            };
      store.upsertTimeline(item);
    }
  } finally {
    store.close();
  }
}

test.beforeAll(() => {
  mkdirSync(shots, { recursive: true });
  base = mkdtempSync(path.join(os.tmpdir(), "aria-e2e-chat-"));
  // No projects: the chat needs none.
  mkdirSync(path.join(base, "GitHub"), { recursive: true });
  seedChat(path.join(base, "data"));
});

test.afterAll(async () => {
  await app?.close().catch(() => {
    // Teardown: the app may be gone already, and the test has its result.
  });
  if (base) rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

/** Until nothing in the window has been drawn for half a second. */
async function settled(page: Page): Promise<void> {
  let commits = -1;
  await expect
    .poll(
      async () => {
        const before = commits;
        commits = (await readPerf(page)).commits;
        return commits === before;
      },
      { intervals: [500], timeout: 30_000 },
    )
    .toBe(true);
}

/** How often each frame drew the reply being written, in frame order. */
function replyFrames(log: Commit[]): Array<{ frame: number; draws: number }> {
  const draws = new Map<number, number>();
  for (const commit of log) if (commit.streaming) draws.set(commit.frame, (draws.get(commit.frame) ?? 0) + 1);
  return [...draws].sort((a, b) => a[0] - b[0]).map(([frame, count]) => ({ frame, draws: count }));
}

test("a streamed reply draws once a frame, and not the messages before it", async () => {
  test.setTimeout(4 * 60_000);
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
  await page.addInitScript(installCounters, { log: true });
  await page.reload();
  await expect(page.getByTestId("status")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });

  // All 200 are drawn (besides what ARIA adds at start-up, such as the morning brief), and what they start (code
  // highlighting) is done before the spec counts.
  const timeline = page.getByTestId("timeline");
  await expect(timeline.locator('[data-card-id^="seed-"]')).toHaveCount(SEEDED);
  await settled(page);

  /** Sends `prompt`, and counts until its reply is final and what that starts is done. */
  const turn = async (prompt: string) => {
    const replies = timeline.getByTestId("msg-assistant");
    const before = await replies.count();
    await resetPerf(page);
    const composer = page.getByTestId("composer");
    await composer.fill(prompt);
    await composer.press("Enter");
    await expect(replies).toHaveCount(before + 1);
    await expect(replies.last()).toContainText("Part 20 of a long answer");
    await expect(timeline.getByTestId("msg-streaming")).toHaveCount(0);
    await expect(page.getByTestId("status")).toHaveAttribute("data-state", "ready");
    // What the final reply starts (its code blocks ask to be highlighted 120 ms after they're drawn) is part of it too.
    await settled(page);
    const perf = await readPerf(page);
    const log = perf.log ?? [];
    const frames = replyFrames(log);
    const between = frames.slice(1, -1);
    return {
      result: {
        commits: perf.commits,
        renders: perf.renders,
        rendersPerCommit: perf.commits ? Math.round(perf.renders / perf.commits) : 0,
        mostRenders: Math.max(0, ...log.map((c) => c.renders)),
        mostItems: Math.max(0, ...log.map((c) => c.items)),
        longTasks: perf.longTasks,
        longMs: Math.round(perf.longMs),
        replyDraws: frames.reduce((sum, f) => sum + f.draws, 0),
        replyFrames: frames.length,
        framesSpanned: frames.length ? frames.at(-1)!.frame - frames[0]!.frame + 1 : 0,
        firstFrameDraws: frames[0]?.draws ?? 0,
        lastFrameDraws: frames.at(-1)?.draws ?? 0,
        mostDrawsBetween: Math.max(0, ...between.map((f) => f.draws)),
        framesDrawnTwiceBetween: between.filter((f) => f.draws > 1).length,
      },
      longs: perf.longs ?? [],
      frames,
    };
  };

  // Chunks a few milliseconds apart, like a model's, then all at once (chunks that arrive together).
  const streamed = await turn("Stream a long reply");
  const atOnce = await turn("Stream a long reply at once");
  await page.screenshot({ path: path.join(shots, "perf-chat.png") });
  writeFileSync(path.join(shots, "perf-chat.json"), `${JSON.stringify({ streamed, atOnce }, null, 2)}
`);
  console.log(`perf-chat: ${JSON.stringify({ streamed: streamed.result, atOnce: atOnce.result })}`);

  for (const { result, longs } of [streamed, atOnce]) {
    // A frame draws the reply once (P3): before, each chunk drew it, up to 93 times in a frame. The turn's first and last
    // frames may draw it once more, for the status and the final message.
    expect(result.mostDrawsBetween).toBeLessThanOrEqual(1);
    expect(result.firstFrameDraws).toBeLessThanOrEqual(2);
    expect(result.lastFrameDraws).toBeLessThanOrEqual(2);
    // A new message draws itself, not the 200 before it (P1): before, every message was drawn again on every event. Your
    // message and the reply each draw one, so a renamed `item` prop, which the counter would no longer see, fails here.
    expect(result.mostItems).toBeGreaterThanOrEqual(1);
    expect(result.mostItems).toBeLessThanOrEqual(2);
    expect(result.longTasks, `long tasks: ${JSON.stringify(longs)}`).toBe(0);
    // Measured on main at 144: the final reply's whole Markdown tree (20 parts) and the chat around it.
    expect(result.mostRenders).toBeLessThanOrEqual(200);
  }
  // The streamed reply was drawn as it came, not only at the end (a hidden window draws no frames, and measures nothing).
  expect(streamed.result.replyFrames).toBeGreaterThanOrEqual(10);
  // Chunks that arrive together are drawn together: on main, usually not at all before the final message replaces them.
  // This is what catches P3 undone on a fast display, where streamed chunks seldom share a frame.
  expect(atOnce.result.replyDraws).toBeLessThanOrEqual(2);
  // Measured on main at 57-59: each frame draws the reply's whole Markdown again, about 58 renders (P3). Memoizing its
  // blocks, so only the last one is parsed again, would bring this down.
  expect(streamed.result.rendersPerCommit).toBeLessThanOrEqual(80);
});
