import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pageStart, TRANSCRIPT_PAGE, type TranscriptEntry } from "@aria/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AriaEngine } from "../src/engine.ts";
import { FakeRuntime } from "../src/runtime/fake.ts";
import type { Store } from "../src/store/store.ts";
import { commitFile, makeRepo, waitMs } from "./helpers.ts";

const temps: string[] = [];
const engines: AriaEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.stop()));
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > waitMs(ms)) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A finished task whose session has the brief, `messages` messages and its summary; with `gate`, one still at work. */
async function longTask(messages: number, gate?: Promise<void>) {
  const base = mkdtempSync(path.join(os.tmpdir(), "aria-pages-"));
  temps.push(base);
  const projects = path.join(base, "GitHub");
  const repo = makeRepo(projects, "Pages");
  commitFile(repo, "README.md", "# Pages\n", "Initial commit");
  const runtime = new FakeRuntime();
  runtime.workerScripts.push({ steps: [...Array.from({ length: messages }, (_, i) => ({ message: `Step ${i + 1}` })), ...(gate ? [{ gate }] : []), { complete: "Done." }] });
  /** An engine on the same data and runtime: a start of ARIA (its sessions are opened anew). */
  const make = async () => {
    const engine = new AriaEngine({ dataDir: path.join(base, "data"), runtime, projectRoots: [projects], resumeSettleMs: 10, worktreeRoot: path.join(base, "wt"), taskSettleMs: 20, autopilotGraceMs: 150 });
    engines.push(engine);
    await engine.start();
    return { engine, db: (engine as unknown as { db: Store }).db };
  };
  const { engine, db } = await make();
  const task = await engine.startTask({ repoId: engine.getState().projects[0]!.id, brief: "A long task" });
  const state = () => engine.getState().tasks.find((t) => t.id === task.id)?.state;
  await until(() => state() === (gate ? "running" : "done"));
  return { engine, taskId: task.id, db, make, state };
}

/** The task manager's handle on a task's session, and the way its live steps come in (white-box, for the race). */
function internals(engine: AriaEngine, taskId: string) {
  type Handle = { getTranscript(): Promise<TranscriptEntry[]> };
  const tasks = (engine as unknown as { tasks: { live: Map<string, { handle?: Handle }>; reconciled: WeakMap<object, unknown>; onWorkerEvent(id: string, event: unknown): void } }).tasks;
  return {
    handle: () => tasks.live.get(taskId)?.handle,
    unreconcile: (handle: Handle) => tasks.reconciled.delete(handle),
    live: (entries: TranscriptEntry[]) => tasks.onWorkerEvent(taskId, { type: "transcript", entries }),
  };
}

describe("a task's transcript in pages (P4)", () => {
  it("reads the newest page, the pages before a step, and the page with a step further back", async () => {
    const { engine, taskId } = await longTask(420);
    const all = await engine.getTranscript(taskId);
    expect(all.length).toBeGreaterThan(2 * TRANSCRIPT_PAGE);
    expect(all[0]).toMatchObject({ kind: "user" });

    const last = await engine.getTranscriptPage({ taskId });
    expect(last).toEqual({ entries: all.slice(-TRANSCRIPT_PAGE), omitted: all.length - TRANSCRIPT_PAGE, first: all[0], plan: false });
    expect((await engine.getTranscriptPage({ taskId, last: 5 })).entries).toEqual(all.slice(-5));

    // The page before the first loaded step, then the rest: the brief comes with them, not beside them.
    const earlier = await engine.getTranscriptPage({ taskId, before: last.entries[0]!.id });
    expect(earlier.entries).toEqual(all.slice(-2 * TRANSCRIPT_PAGE, -TRANSCRIPT_PAGE));
    expect(earlier.omitted).toBe(all.length - 2 * TRANSCRIPT_PAGE);
    const rest = await engine.getTranscriptPage({ taskId, before: earlier.entries[0]!.id });
    expect(rest).toEqual({ entries: all.slice(0, all.length - 2 * TRANSCRIPT_PAGE), omitted: 0, plan: false });

    // A jump to a step: whole pages from the newest back to it, as the session view counts them.
    const jump = await engine.getTranscriptPage({ taskId, through: all[10]!.id });
    expect(jump.omitted).toBe(pageStart(all.length, 10));
    expect(jump.entries).toEqual(all.slice(jump.omitted));
    expect(jump.entries).toContainEqual(all[10]);
    // A step it doesn't know: the newest page. The brief: the newest page too, since it comes with every page.
    expect((await engine.getTranscriptPage({ taskId, through: "gone" })).omitted).toBe(last.omitted);
    expect(await engine.getTranscriptPage({ taskId, through: all[0]!.id })).toEqual(last);
    expect((await engine.getTranscriptPage({ taskId, through: all[1]!.id })).omitted).toBe(0);
    await expect(engine.getTranscriptPage({ taskId, before: "gone" })).rejects.toThrow(/open it again/);
  });

  it("saves only what's new or changed, so opening it again writes nothing", async () => {
    const { engine, taskId, db, make } = await longTask(30);
    const owner = `task:${taskId}`;
    const all = await engine.getTranscript(taskId);
    const writes = vi.spyOn(db, "upsertTranscriptEntries");
    for (const input of [{ taskId }, { taskId }, { taskId, before: all.at(-1)!.id }, { taskId, through: all[3]!.id }]) await engine.getTranscriptPage(input);
    expect(writes).not.toHaveBeenCalled();
    // One saved step is out of date, as when the session went on while ARIA was closed. Started again, ARIA opens
    // the session anew; its first read writes only that step, and the reads after it nothing.
    const stale = all[5]!;
    db.upsertTranscriptEntries(owner, [{ ...stale, at: stale.at - 1 }]);
    await engine.stop();
    const restarted = await make();
    const rewrites = vi.spyOn(restarted.db, "upsertTranscriptEntries");
    await restarted.engine.getTranscriptPage({ taskId });
    expect(rewrites).toHaveBeenCalledTimes(1);
    expect(rewrites.mock.calls[0]![1]).toEqual([stale]);
    rewrites.mockClear();
    await restarted.engine.getTranscriptPage({ taskId });
    await restarted.engine.getTranscriptPage({ taskId, before: all.at(-1)!.id });
    expect(rewrites).not.toHaveBeenCalled();
    // What's saved is the whole session, in its order.
    expect(restarted.db.listTranscriptEntries(owner)).toEqual(all);
  });

  it("keeps a step saved live while the history is read, rather than the read's older copy of it", async () => {
    const { engine, taskId, db } = await longTask(10);
    const owner = `task:${taskId}`;
    const all = await engine.getTranscript(taskId);
    const task = internals(engine, taskId);
    const handle = task.handle()!;
    expect(handle).toBeDefined();
    // A read that checks the history (as a session's first read does), and is slow: a step changes while it's on its
    // way, and is saved as it comes.
    task.unreconcile(handle);
    const read = handle.getTranscript.bind(handle);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    handle.getTranscript = async () => {
      const entries = await read();
      await gate;
      return entries;
    };
    const reading = engine.getTranscriptPage({ taskId });
    await new Promise((r) => setTimeout(r, 0));
    const newer = { ...all[4]!, at: all[4]!.at + 1 };
    task.live([newer]);
    expect(db.listTranscriptEntries(owner)[4]).toEqual(newer);
    release();
    await reading;
    expect(db.listTranscriptEntries(owner)[4]).toEqual(newer);
  });

  it("checks the history once more when a task it first read at work is done", async () => {
    let release!: () => void;
    const { engine, taskId, db, state } = await longTask(5, new Promise<void>((r) => (release = r)));
    const owner = `task:${taskId}`;
    // Read while it works: checked then.
    await engine.getTranscriptPage({ taskId });
    // A saved step the live view didn't follow (as a tool that started before ARIA listened finishes unseen).
    const [brief] = db.listTranscriptEntries(owner);
    db.upsertTranscriptEntries(owner, [{ ...brief!, at: brief!.at - 1 }]);
    const writes = vi.spyOn(db, "upsertTranscriptEntries");
    await engine.getTranscriptPage({ taskId });
    expect(writes).not.toHaveBeenCalled();
    release();
    await until(() => state() === "done");
    // Done: the next read checks again, and puts it right; the ones after don't.
    writes.mockClear();
    await engine.getTranscriptPage({ taskId });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0]![1]).toEqual([brief]);
    writes.mockClear();
    await engine.getTranscriptPage({ taskId });
    expect(writes).not.toHaveBeenCalled();
  });
});
