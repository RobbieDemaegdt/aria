/** D1: finished tasks' transcripts trimmed after a while, the mark that keeps them trimmed, and compacting the file. */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { transcriptPage, type TranscriptEntry } from "@aria/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManualClock } from "../src/attention/clock.ts";
import { AriaEngine } from "../src/engine.ts";
import { FakeRuntime } from "../src/runtime/fake.ts";
import { CLEANUP_BATCH, CLEANUP_CHECK_MS, CLEANUP_START_DELAY_MS, DEFAULT_RETENTION, TranscriptRetentionRunner } from "../src/store/retention.ts";
import { Store, type StoreOptions, type TaskRecord } from "../src/store/store.ts";
import { PRUNED_NOTE_ID, withPrunedNote } from "../src/tasks/manager.ts";
import { commitFile, makeRepo, waitMs } from "./helpers.ts";

const DAY = 24 * 60 * 60 * 1000;
const temps: string[] = [];
const stores: Store[] = [];
const engines: AriaEngine[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(engines.splice(0).map((e) => e.stop()));
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // Closed by the test.
    }
  }
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aria-retention-"));
  temps.push(dir);
  return dir;
}

function open(file = path.join(tempDir(), "aria.db"), options: StoreOptions = {}): Store {
  const store = new Store(file, options);
  stores.push(store);
  return store;
}

const said = (id: string, at: number): TranscriptEntry => ({ kind: "user", id, at, text: `you said ${id}` });
const replied = (id: string, at: number): TranscriptEntry => ({ kind: "assistant", id, at, text: `it replied ${id}` });
const asked = (id: string, at: number): TranscriptEntry => ({ kind: "question", id, at, question: `which ${id}?`, answer: "this one" });
const noted = (id: string, at: number): TranscriptEntry => ({ kind: "info", id, at, level: "info", text: `notice ${id}` });
const tool = (id: string, at: number): TranscriptEntry => ({ kind: "tool", id, at, name: "powershell", args: `{"command":"echo ${id}"}`, result: `output of ${id}` });
const allowed = (id: string, at: number): TranscriptEntry => ({ kind: "permission", id, at, detail: `run echo ${id}`, approved: true });
const thought = (id: string, at: number): TranscriptEntry => ({ kind: "reasoning", id, at, text: `thinking about ${id}` });
/** The step that wrote the task's plan: the session view's Plan tab comes from it. */
const wrotePlan = (id: string, at: number): TranscriptEntry => ({ kind: "tool", id, at, name: "create", args: JSON.stringify({ path: "C:\\state\\plan.md", file_text: "# Plan" }), success: true });

/** A step of each kind, at `at`, `at + 1`, …, with ids `${prefix}-<kind>`. */
const everyKind = (prefix: string, at: number): TranscriptEntry[] =>
  [said, tool, allowed, thought, replied, asked, noted].map((make, i) => make(`${prefix}-${["user", "tool", "permission", "reasoning", "assistant", "question", "info"][i]}`, at + i));

const ids = (entries: readonly TranscriptEntry[]) => entries.map((entry) => entry.id);

function task(id: string, state: TaskRecord["state"], finishedAt: number | undefined, extra: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    title: id,
    brief: id,
    repoId: 1,
    repoName: "Repo",
    repoPath: "C:/repo",
    profileId: "default",
    profileName: "Default",
    model: "fake-light",
    mode: "autopilot",
    state,
    startedBy: "you",
    createdAt: 1,
    updatedAt: 1,
    costNano: 0,
    archived: false,
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...extra,
  };
}

describe("the pruned mark in the store (D1)", () => {
  it("removes old tool calls, permission lines and reasoning, and keeps your words, replies, questions and notices", () => {
    const store = open();
    store.upsertTranscriptEntries("task:a", everyKind("old", 1_000));
    store.upsertTranscriptEntries("task:b", everyKind("other", 1_000));
    store.markTranscriptPruned("task:a", 5_000);
    expect(store.deletePrunedSteps("task:a", 5_000, 100)).toBe(3);
    expect(ids(store.listTranscriptEntries("task:a"))).toEqual(["old-user", "old-assistant", "old-question", "old-info"]);
    // Another task keeps everything.
    expect(store.listTranscriptEntries("task:b")).toHaveLength(7);
    expect(store.transcriptPrunedAt("task:a")).toBe(5_000);
    expect(store.transcriptPrunedAt("task:b")).toBeUndefined();
  });

  it("deletes at most a batch at a time, and only steps from before the mark", () => {
    const store = open();
    store.upsertTranscriptEntries("task:a", [said("brief", 1), ...Array.from({ length: 7 }, (_, i) => tool(`t${i}`, 10 + i)), tool("late", 9_000)]);
    store.markTranscriptPruned("task:a", 5_000);
    expect(store.deletePrunedSteps("task:a", 5_000, 3)).toBe(3);
    expect(store.deletePrunedSteps("task:a", 5_000, 3)).toBe(3);
    expect(store.deletePrunedSteps("task:a", 5_000, 3)).toBe(1);
    expect(store.deletePrunedSteps("task:a", 5_000, 3)).toBe(0);
    expect(ids(store.listTranscriptEntries("task:a"))).toEqual(["brief", "late"]);
  });

  it("never saves an old step of those kinds again, from a read of the session or from the live queue; a later run's are saved", () => {
    const store = open();
    const history = everyKind("old", 1_000);
    store.upsertTranscriptEntries("task:a", history);
    store.markTranscriptPruned("task:a", 5_000);
    store.deletePrunedSteps("task:a", 5_000, 100);

    // Opening the task's session writes its history again (P4's check): the old steps stay out.
    store.upsertTranscriptEntries("task:a", history);
    store.queueTranscriptEntries("task:a", [tool("old-tool", 1_001), thought("old-reasoning", 1_003)]);
    expect(ids(store.listTranscriptEntries("task:a"))).toEqual(["old-user", "old-assistant", "old-question", "old-info"]);

    // You continued the task: its new steps are saved, after the old ones.
    store.queueTranscriptEntries("task:a", everyKind("new", 6_000));
    expect(ids(store.listTranscriptEntries("task:a"))).toEqual([
      "old-user",
      "old-assistant",
      "old-question",
      "old-info",
      "new-user",
      "new-tool",
      "new-permission",
      "new-reasoning",
      "new-assistant",
      "new-question",
      "new-info",
    ]);
  });

  it("keeps the step that wrote the plan, so the Plan tab stays", () => {
    const store = open();
    const history = [said("brief", 1), tool("look", 10), wrotePlan("plan", 20), tool("after", 30)];
    store.upsertTranscriptEntries("task:a", history);
    expect(store.hasPrunedSteps("task:a", 5_000)).toBe(true);
    store.markTranscriptPruned("task:a", 5_000);
    expect(store.deletePrunedSteps("task:a", 5_000, 100)).toBe(2);
    expect(ids(store.listTranscriptEntries("task:a"))).toEqual(["brief", "plan"]);
    expect(store.hasPrunedSteps("task:a", 5_000)).toBe(false);
    // Its history written again: the plan's step is kept as it was, the others stay out.
    store.upsertTranscriptEntries("task:a", history);
    expect(ids(store.listTranscriptEntries("task:a"))).toEqual(["brief", "plan"]);
    expect(transcriptPage(store.listTranscriptEntries("task:a"), {}).plan).toBe(true);
    // Its session read for the first time after the clean-up: the plan's step is saved, the others aren't.
    store.markTranscriptPruned("task:b", 5_000);
    store.upsertTranscriptEntries("task:b", history);
    expect(ids(store.listTranscriptEntries("task:b"))).toEqual(["brief", "plan"]);
  });

  it("a discarded task still removes everything, the mark too", () => {
    const store = open();
    store.upsertTranscriptEntries("task:a", everyKind("old", 1_000));
    store.markTranscriptPruned("task:a", 5_000);
    store.deleteTranscriptEntries("task:a");
    expect(store.listTranscriptEntries("task:a")).toEqual([]);
    expect(store.hasTranscriptEntries("task:a")).toBe(false);
    expect(store.transcriptPrunedAt("task:a")).toBeUndefined();
    // Nothing of it holds back what's saved under that owner afterwards.
    store.upsertTranscriptEntries("task:a", [tool("again", 1_000)]);
    expect(ids(store.listTranscriptEntries("task:a"))).toEqual(["again"]);
  });

  it("keeps the mark across a restart", () => {
    const file = path.join(tempDir(), "aria.db");
    const first = open(file);
    first.upsertTranscriptEntries("task:a", [said("brief", 1)]);
    first.markTranscriptPruned("task:a", 5_000);
    first.close();
    const second = open(file);
    second.upsertTranscriptEntries("task:a", [tool("old", 10)]);
    expect(ids(second.listTranscriptEntries("task:a"))).toEqual(["brief"]);
  });
});

describe("compacting the file at a start (D1)", () => {
  /** A file with `count` big tool steps for `task:a`, which a clean-up then removes. */
  function bloated(file: string, count: number, options: StoreOptions): Store {
    const store = open(file, options);
    const big = "x".repeat(4_000);
    store.upsertTranscriptEntries("task:a", [said("brief", 1), ...Array.from({ length: count }, (_, i): TranscriptEntry => ({ kind: "tool", id: `t${i}`, at: 10 + i, name: "read", result: big }))]);
    store.markTranscriptPruned("task:a", 1_000_000);
    while (store.deletePrunedSteps("task:a", 1_000_000, 500) > 0);
    return store;
  }

  it("runs at the next start after a clean-up left more free space than the threshold, once", () => {
    const file = path.join(tempDir(), "aria.db");
    const options = { compactFreeBytes: 256 * 1024 };
    const store = bloated(file, 300, options);
    const free = store.freeBytes();
    expect(free).toBeGreaterThan(options.compactFreeBytes);
    expect(store.compactAtNextStartIfFree()).toBe(true);
    expect(store.compactPending()).toBe(true);
    const before = store.fileBytes();
    expect(store.compactedAtOpen).toBeUndefined();
    store.close();

    const reopened = open(file, options);
    const compact = reopened.compactedAtOpen;
    expect(compact).toMatchObject({ beforeBytes: before });
    expect(compact!.error).toBeUndefined();
    expect(compact!.afterBytes).toBeLessThan(before - free / 2);
    expect(reopened.fileBytes()).toBe(compact!.afterBytes);
    expect(reopened.freeBytes()).toBe(0);
    expect(reopened.compactPending()).toBe(false);
    expect(reopened.lastCompact()).toEqual(compact);
    // What's kept is all there.
    expect(ids(reopened.listTranscriptEntries("task:a"))).toEqual(["brief"]);
    reopened.close();

    // Once only.
    const third = open(file, options);
    expect(third.compactedAtOpen).toBeUndefined();
  });

  it("opens all the same when compacting fails or the file's size can't be read, and doesn't try again", () => {
    const file = path.join(tempDir(), "aria.db");
    const options = { compactFreeBytes: 256 * 1024 };
    const store = bloated(file, 300, options);
    expect(store.compactAtNextStartIfFree()).toBe(true);
    const before = store.fileBytes();
    store.close();

    const exec = DatabaseSync.prototype.exec;
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "VACUUM") throw new Error("disk full");
      return exec.call(this, sql);
    });
    const failed = open(file, options);
    spy.mockRestore();
    expect(failed.compactedAtOpen).toMatchObject({ beforeBytes: before, afterBytes: before, error: "disk full" });
    expect(failed.lastCompact()).toEqual(failed.compactedAtOpen);
    expect(failed.compactPending()).toBe(false);
    expect(ids(failed.listTranscriptEntries("task:a"))).toEqual(["brief"]);
    failed.close();
    expect(open(file, options).compactedAtOpen).toBeUndefined();
  });

  it("opens all the same when the file's size can't be read at the start", () => {
    const file = path.join(tempDir(), "aria.db");
    const options = { compactFreeBytes: 256 * 1024 };
    const store = bloated(file, 300, options);
    expect(store.compactAtNextStartIfFree()).toBe(true);
    store.close();
    vi.spyOn(Store.prototype, "fileBytes").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    const reopened = open(file, options);
    expect(reopened.compactedAtOpen).toMatchObject({ beforeBytes: 0, error: "database is locked" });
    expect(reopened.compactPending()).toBe(false);
    expect(ids(reopened.listTranscriptEntries("task:a"))).toEqual(["brief"]);
  });

  it("isn't asked for when little is free, and is skipped when SQLite reused the space before the start", () => {
    const file = path.join(tempDir(), "aria.db");
    const store = bloated(file, 300, { compactFreeBytes: 64 * 1024 * 1024 });
    expect(store.compactAtNextStartIfFree()).toBe(false);
    expect(store.compactPending()).toBe(false);
    store.close();

    const options = { compactFreeBytes: 256 * 1024 };
    const again = open(file, options);
    expect(again.compactAtNextStartIfFree()).toBe(true);
    // New steps fill the free pages again before ARIA restarts.
    const big = "y".repeat(4_000);
    again.upsertTranscriptEntries("task:b", Array.from({ length: 300 }, (_, i): TranscriptEntry => ({ kind: "assistant", id: `b${i}`, at: i, text: big })));
    expect(again.freeBytes()).toBeLessThanOrEqual(options.compactFreeBytes);
    again.close();
    const reopened = open(file, options);
    expect(reopened.compactedAtOpen).toBeUndefined();
    expect(reopened.compactPending()).toBe(false);
  });
});

describe("the daily clean-up (D1)", () => {
  function runner(store: Store, clock: ManualClock, stopped = () => false) {
    const failures: unknown[] = [];
    const turns: number[] = [];
    const retention = new TranscriptRetentionRunner({
      db: () => store,
      clock,
      now: () => clock.now(),
      stopped,
      failed: (error) => failures.push(error),
      yieldTurn: async () => {
        turns.push(1);
      },
    });
    return { retention, failures, turns };
  }

  it("trims only finished tasks that finished more than the days set ago", async () => {
    const now = Date.UTC(2026, 11, 17, 12);
    const clock = new ManualClock(now);
    const store = open();
    const old = now - 31 * DAY;
    const tasks = [
      task("old-done", "done", old),
      task("old-failed", "failed", old),
      task("old-cancelled", "cancelled", old),
      task("recent", "done", now - 29 * DAY),
      // Continued after it finished long ago: it's working, so it keeps everything.
      task("continued", "running", old),
      task("queued", "queued", old),
      task("interrupted", "interrupted", old),
      task("never-finished", "done", undefined),
      task("archived", "done", old, { archived: true }),
    ];
    for (const record of tasks) {
      store.saveTask(record);
      store.upsertTranscriptEntries(`task:${record.id}`, everyKind(record.id, old - DAY));
    }
    // Nothing to remove (it only talked): not marked, so its session view doesn't say it was cleaned up.
    store.saveTask(task("chat", "done", old));
    store.upsertTranscriptEntries("task:chat", [said("chat-user", old - DAY), replied("chat-assistant", old - DAY + 1)]);
    const { retention, failures } = runner(store, clock);
    expect(retention.settings()).toEqual(DEFAULT_RETENTION);
    const result = await retention.cleanUp();
    expect(failures).toEqual([]);
    expect(result).toMatchObject({ at: now, tasks: 3, steps: 9 });
    for (const id of ["old-done", "old-failed", "old-cancelled"]) {
      expect(store.listTranscriptEntries(`task:${id}`).map((e) => e.kind)).toEqual(["user", "assistant", "question", "info"]);
      expect(store.transcriptPrunedAt(`task:${id}`)).toBe(now);
    }
    for (const id of ["recent", "continued", "queued", "interrupted", "never-finished", "archived"]) {
      expect(store.listTranscriptEntries(`task:${id}`)).toHaveLength(7);
      expect(store.transcriptPrunedAt(`task:${id}`)).toBeUndefined();
    }
    expect(store.listTranscriptEntries("task:chat")).toHaveLength(2);
    expect(store.transcriptPrunedAt("task:chat")).toBeUndefined();
    expect(retention.lastCleanup()).toEqual(result);

    // With fewer days set, the recent one goes too; the others aren't looked at again.
    retention.setSettings({ keepDays: 7 });
    clock.advance(1_000);
    const deletes = vi.spyOn(store, "deletePrunedSteps");
    const looks = vi.spyOn(store, "hasPrunedSteps");
    expect(await retention.cleanUp()).toMatchObject({ tasks: 1, steps: 3 });
    expect(deletes.mock.calls.map(([owner]) => owner)).toEqual(["task:recent"]);
    // The ones it trimmed all of aren't even read again; the chat with nothing to remove is.
    expect(looks.mock.calls.map(([owner]) => owner).sort()).toEqual(["task:chat", "task:recent"]);
    expect(store.transcriptPrunedAt("task:old-done")).toBe(now);
    expect(store.transcriptPrunedAt("task:recent")).toBe(now + 1_000);

    // You continued an old one, and it finished again long ago: its new run's steps go too, under a new mark.
    const continued = store.getTask("old-done")!;
    store.saveTask({ ...continued, finishedAt: now + 2_000 });
    store.upsertTranscriptEntries("task:old-done", everyKind("rerun", now + 1_500));
    clock.advance(30 * DAY);
    expect(await retention.cleanUp()).toMatchObject({ tasks: 1, steps: 3 });
    expect(store.transcriptPrunedAt("task:old-done")).toBe(clock.now());
    expect(store.listTranscriptEntries("task:old-done").map((e) => e.kind)).toEqual(["user", "assistant", "question", "info", "user", "assistant", "question", "info"]);
  });

  it("deletes in batches with a turn between them, and a quit carries on at the next clean-up", async () => {
    const now = Date.UTC(2026, 11, 17, 12);
    const clock = new ManualClock(now);
    const store = open();
    store.saveTask(task("big", "done", now - 40 * DAY));
    const count = CLEANUP_BATCH * 2 + 10;
    store.upsertTranscriptEntries("task:big", [said("brief", 1), ...Array.from({ length: count }, (_, i) => tool(`t${i}`, 10 + i))]);

    let quitting = false;
    const first = runner(store, clock, () => quitting);
    const turns = first.turns;
    // Quits during the first batch's turn.
    const yieldTurn = async () => {
      turns.push(1);
      quitting = true;
    };
    const quit = new TranscriptRetentionRunner({ db: () => store, clock, now: () => clock.now(), stopped: () => quitting, failed: () => undefined, yieldTurn });
    const partial = await quit.cleanUp();
    expect(partial.steps).toBe(0);
    expect(store.listTranscriptEntries("task:big")).toHaveLength(1 + count - CLEANUP_BATCH);
    // A clean-up that didn't finish isn't noted as done, so the next look runs one.
    expect(quit.lastCleanup()).toBeUndefined();
    expect(store.transcriptPrunedAt("task:big")).toBe(now);

    quitting = false;
    clock.advance(60_000);
    const rest = await first.retention.cleanUp();
    // The same mark: what was left from before it goes, in batches.
    expect(store.transcriptPrunedAt("task:big")).toBe(now);
    expect(rest).toMatchObject({ tasks: 1, steps: count - CLEANUP_BATCH });
    expect(ids(store.listTranscriptEntries("task:big"))).toEqual(["brief"]);
    // A turn after each full batch: one in the clean-up that quit, one between the two batches of this one.
    expect(turns.length).toBeGreaterThanOrEqual(2);
  });

  it("runs a minute after the start, then once a day, and not while it's off; Clean up now runs anyway", async () => {
    const now = Date.UTC(2026, 11, 17, 12);
    const clock = new ManualClock(now);
    const store = open();
    store.saveTask(task("old", "done", now - 40 * DAY));
    const { retention } = runner(store, clock);
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    retention.start();
    clock.advance(CLEANUP_START_DELAY_MS - 1);
    await settle();
    expect(retention.lastCleanup()).toBeUndefined();
    clock.advance(1);
    await settle();
    expect(retention.lastCleanup()?.at).toBe(now + CLEANUP_START_DELAY_MS);
    expect(retention.isDue()).toBe(false);

    // Hourly looks (each sets the next once it's done): not again until a day has passed.
    const hours = async (count: number) => {
      for (let i = 0; i < count; i++) {
        clock.advance(CLEANUP_CHECK_MS);
        await settle();
      }
    };
    const looks = vi.spyOn(retention, "isDue");
    await hours(23);
    expect(looks).toHaveBeenCalledTimes(23);
    expect(retention.lastCleanup()?.at).toBe(now + CLEANUP_START_DELAY_MS);
    await hours(1);
    expect(retention.lastCleanup()?.at).toBe(now + CLEANUP_START_DELAY_MS + 24 * CLEANUP_CHECK_MS);

    // Off: the hourly looks don't run it.
    retention.setSettings({ enabled: false });
    await hours(72);
    expect(looks).toHaveBeenCalledTimes(96);
    const last = retention.lastCleanup()!.at;
    expect(last).toBe(now + CLEANUP_START_DELAY_MS + 24 * CLEANUP_CHECK_MS);
    expect(retention.isDue()).toBe(false);
    // "Clean up now" does, with the days set.
    expect((await retention.cleanUp()).at).toBe(clock.now());

    retention.stop();
  });

  it("refuses days out of range and reads a bad saved setting as the default", () => {
    const store = open();
    const { retention } = runner(store, new ManualClock());
    expect(() => retention.setSettings({ keepDays: 0 })).toThrow(/1 to 3650/);
    expect(() => retention.setSettings({ keepDays: 2.5 })).toThrow(/1 to 3650/);
    store.setSetting("transcripts.retention", { enabled: "yes", keepDays: -4 });
    expect(retention.settings()).toEqual(DEFAULT_RETENTION);
    expect(retention.setSettings({ keepDays: 14 })).toEqual({ enabled: true, keepDays: 14 });
    expect(retention.setSettings({ enabled: false })).toEqual({ enabled: false, keepDays: 14 });
  });

  it("asks for a compact at the next start when the clean-up left a lot free", async () => {
    const now = Date.UTC(2026, 11, 17, 12);
    const store = open(path.join(tempDir(), "aria.db"), { compactFreeBytes: 256 * 1024 });
    store.saveTask(task("big", "done", now - 40 * DAY));
    const big = "z".repeat(4_000);
    store.upsertTranscriptEntries("task:big", [said("brief", 1), ...Array.from({ length: 300 }, (_, i): TranscriptEntry => ({ kind: "reasoning", id: `r${i}`, at: 10 + i, text: big }))]);
    const { retention } = runner(store, new ManualClock(now));
    const result = await retention.cleanUp();
    expect(result.freeBytes).toBeGreaterThan(256 * 1024);
    expect(store.compactPending()).toBe(true);
    expect(retention.state()).toMatchObject({ retention: DEFAULT_RETENTION, compactPending: true, cleaning: false, lastCleanup: result, freeBytes: result.freeBytes });
  });

  it("asks for it too when ARIA quit right after the last batch, so the next clean-up has nothing left to remove", async () => {
    const now = Date.UTC(2026, 11, 17, 12);
    const clock = new ManualClock(now);
    const store = open(path.join(tempDir(), "aria.db"), { compactFreeBytes: 256 * 1024 });
    store.saveTask(task("big", "done", now - 40 * DAY));
    store.saveTask(task("next", "done", now - 40 * DAY));
    const big = "z".repeat(4_000);
    store.upsertTranscriptEntries("task:big", [said("brief", 1), ...Array.from({ length: 300 }, (_, i): TranscriptEntry => ({ kind: "reasoning", id: `r${i}`, at: 10 + i, text: big }))]);
    let quitting = false;
    const quit = new TranscriptRetentionRunner({ db: () => store, clock, now: () => clock.now(), stopped: () => quitting, failed: () => undefined, yieldTurn: async () => undefined });
    // ARIA quits just as the first task is done: the clean-up stops before the next one.
    const complete = store.completeTranscriptPrune.bind(store);
    vi.spyOn(store, "completeTranscriptPrune").mockImplementation((owner) => {
      complete(owner);
      quitting = true;
    });
    await quit.cleanUp();
    expect(ids(store.listTranscriptEntries("task:big"))).toEqual(["brief"]);
    expect(quit.lastCleanup()).toBeUndefined();
    expect(store.compactPending()).toBe(false);
    vi.restoreAllMocks();

    const { retention } = runner(store, clock);
    expect(await retention.cleanUp()).toMatchObject({ tasks: 0, steps: 0 });
    expect(store.compactPending()).toBe(true);
  });

  it("carries on a clean-up ARIA quit during, after the days were raised or the clock set back", async () => {
    const now = Date.UTC(2026, 11, 17, 12);
    const clock = new ManualClock(now);
    const store = open();
    const steps = (prefix: string) => [said(`${prefix}-brief`, 1), ...Array.from({ length: CLEANUP_BATCH + 100 }, (_, i) => tool(`${prefix}-t${i}`, 10 + i))];
    let quitting = false;
    const quit = new TranscriptRetentionRunner({
      db: () => store,
      clock,
      now: () => clock.now(),
      stopped: () => quitting,
      failed: () => undefined,
      yieldTurn: async () => {
        quitting = true;
      },
    });
    const { retention } = runner(store, clock);

    // A 7-day clean-up of a task that finished 10 days ago, quit after its first batch; then you raise the days to 30.
    store.saveTask(task("x", "done", now - 10 * DAY));
    store.upsertTranscriptEntries("task:x", steps("x"));
    retention.setSettings({ keepDays: 7 });
    await quit.cleanUp();
    expect(store.listTranscriptEntries("task:x")).toHaveLength(101);
    expect(store.transcriptPrunes().get("task:x")).toEqual({ at: now, complete: false });
    retention.setSettings({ keepDays: 30 });
    // It's too recent for the days now, but what was started on it is finished.
    expect(await retention.cleanUp()).toMatchObject({ tasks: 1, steps: 100 });
    expect(ids(store.listTranscriptEntries("task:x"))).toEqual(["x-brief"]);
    expect(store.transcriptPrunes().get("task:x")).toEqual({ at: now, complete: true });

    // The clock set back a day after that clean-up finished, and the next one quit during.
    store.saveTask(task("y", "done", now - 40 * DAY));
    store.upsertTranscriptEntries("task:y", steps("y"));
    clock.advance(-DAY);
    quitting = false;
    await quit.cleanUp();
    expect(store.listTranscriptEntries("task:y")).toHaveLength(101);
    expect(retention.lastCleanup()!.at).toBeGreaterThan(store.transcriptPrunes().get("task:y")!.at);
    expect(await retention.cleanUp()).toMatchObject({ tasks: 1, steps: 100 });
    expect(ids(store.listTranscriptEntries("task:y"))).toEqual(["y-brief"]);
  });

  it("reports a failing look, and looks again an hour later", async () => {
    const clock = new ManualClock(Date.UTC(2026, 11, 17, 12));
    const store = open();
    const { retention, failures } = runner(store, clock);
    const read = vi.spyOn(store, "getSetting").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    retention.start();
    clock.advance(CLEANUP_START_DELAY_MS);
    await new Promise((resolve) => setImmediate(resolve));
    expect(failures).toEqual([new Error("database is locked")]);
    read.mockRestore();
    clock.advance(CLEANUP_CHECK_MS);
    await new Promise((resolve) => setImmediate(resolve));
    expect(retention.lastCleanup()).toBeDefined();
    retention.stop();
  });
});

describe("the line that says what was cleaned up (D1)", () => {
  it("goes before a later run's steps, or at the end", () => {
    const old = [said("brief", 1), replied("reply", 2)];
    const rerun = [said("again", 9_000), tool("t", 9_001)];
    expect(ids(withPrunedNote([...old, ...rerun], 5_000))).toEqual(["brief", "reply", PRUNED_NOTE_ID, "again", "t"]);
    expect(ids(withPrunedNote(old, 5_000))).toEqual(["brief", "reply", PRUNED_NOTE_ID]);
    // Never before the brief.
    expect(ids(withPrunedNote([said("brief", 9_000), replied("reply", 9_001)], 5_000))).toEqual(["brief", PRUNED_NOTE_ID, "reply"]);
    expect(withPrunedNote(old, 5_000).at(-1)).toMatchObject({ kind: "info", at: 5_000 });
  });
});

describe("a cleaned-up task in the app (D1)", () => {
  async function until(check: () => boolean, ms = 10_000): Promise<void> {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > waitMs(ms)) throw new Error("condition not met in time");
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  async function finishedTask() {
    const base = tempDir();
    const projects = path.join(base, "GitHub");
    const repo = makeRepo(projects, "Trim");
    commitFile(repo, "README.md", "# Trim\n", "Initial commit");
    const runtime = new FakeRuntime();
    runtime.workerScripts.push({ steps: [{ tool: "view", args: { path: "README.md" } }, { message: "Read it." }, { tool: "view", args: { path: "docs" } }, { complete: "Done." }] });
    const engine = new AriaEngine({ dataDir: path.join(base, "data"), runtime, projectRoots: [projects], resumeSettleMs: 10, worktreeRoot: path.join(base, "wt"), taskSettleMs: 20, autopilotGraceMs: 150 });
    engines.push(engine);
    await engine.start();
    const started = await engine.startTask({ repoId: engine.getState().projects[0]!.id, brief: "Read the readme" });
    await until(() => engine.getState().tasks.find((t) => t.id === started.id)?.state === "done");
    const db = (engine as unknown as { db: Store }).db;
    // It finished 40 days ago.
    db.saveTask({ ...db.getTask(started.id)!, finishedAt: Date.now() - 40 * DAY });
    const tasks = (engine as unknown as { tasks: { cleanup(id: string): Promise<void> } }).tasks;
    /** ARIA restarted: the same data and runtime, so the task's session opens again with a new handle. */
    const restart = async () => {
      await engine.stop();
      const again = new AriaEngine({ dataDir: path.join(base, "data"), runtime, projectRoots: [projects], resumeSettleMs: 10, worktreeRoot: path.join(base, "wt"), taskSettleMs: 20, autopilotGraceMs: 150 });
      engines.push(again);
      await again.start();
      return { engine: again, db: (again as unknown as { db: Store }).db };
    };
    return { engine, db, taskId: started.id, runtime, cleanup: () => tasks.cleanup(started.id), restart };
  }

  const kinds = (entries: readonly TranscriptEntry[]) => entries.map((e) => e.kind);

  it("still opens: from its session while that's there, from what was kept once it isn't", async () => {
    const { engine, db, taskId, cleanup } = await finishedTask();
    const full = await engine.getTranscript(taskId);
    expect(kinds(full)).toContain("tool");

    const state = await engine.cleanUpTranscripts();
    expect(state.lastCleanup).toMatchObject({ tasks: 1 });
    expect(kinds(db.listTranscriptEntries(`task:${taskId}`))).not.toContain("tool");

    // Its session and worktree are still there: the session view shows everything, and the database stays trimmed.
    const fromSession = await engine.getTranscript(taskId);
    expect(kinds(fromSession)).toContain("tool");
    expect(kinds(db.listTranscriptEntries(`task:${taskId}`))).not.toContain("tool");

    // Once its worktree is cleaned up, what was kept, with a line that says what went.
    await cleanup();
    const kept = await engine.getTranscript(taskId);
    expect(kinds(kept)).not.toContain("tool");
    expect(kept[0]).toMatchObject({ kind: "user" });
    expect(kept.at(-1)).toMatchObject({ kind: "info", id: PRUNED_NOTE_ID });
    expect(kept.some((e) => e.kind === "assistant" && e.text === "Read it.")).toBe(true);
    const page = await engine.getTranscriptPage({ taskId });
    expect(page.entries.at(-1)?.id).toBe(PRUNED_NOTE_ID);
    expect(page.omitted).toBe(0);
    // Cleaning up the worktree didn't write the steps back.
    expect(kinds(db.listTranscriptEntries(`task:${taskId}`))).not.toContain("tool");

    // Search finds what was kept, not what went.
    expect((await engine.search({ query: "Read it." })).transcripts.some((hit) => hit.taskId === taskId)).toBe(true);
    expect((await engine.search({ query: "README.md" })).transcripts.some((hit) => hit.taskId === taskId && hit.entryKind === "tool")).toBe(false);
  });

  it("after a restart, reading its session again doesn't save the removed steps back", async () => {
    const { engine, taskId, restart } = await finishedTask();
    await engine.cleanUpTranscripts();
    const { engine: again, db } = await restart();
    const upserts = vi.spyOn(db, "upsertTranscriptEntries");
    expect(kinds(await again.getTranscript(taskId))).toContain("tool");
    // Nothing of the old steps is even sent to the store.
    expect(upserts.mock.calls.flatMap(([, entries]) => entries).filter((e) => e.kind === "tool")).toEqual([]);
    expect(kinds(db.listTranscriptEntries(`task:${taskId}`))).not.toContain("tool");
    expect(db.isTranscriptBackfilled(`task:${taskId}`)).toBe(true);
  });

  it("a discarded one still removes everything", async () => {
    const { engine, db, taskId } = await finishedTask();
    await engine.cleanUpTranscripts();
    expect(db.transcriptPrunedAt(`task:${taskId}`)).toBeDefined();
    await engine.discardTask(taskId);
    expect(db.hasTranscriptEntries(`task:${taskId}`)).toBe(false);
    expect(db.transcriptPrunedAt(`task:${taskId}`)).toBeUndefined();
  });

  it("Customize › Data says how big the database is and keeps the setting", async () => {
    const { engine } = await finishedTask();
    const state = engine.dataState();
    expect(state.fileBytes).toBeGreaterThan(0);
    expect(state.retention).toEqual(DEFAULT_RETENTION);
    expect(state.cleaning).toBe(false);
    expect(engine.setTranscriptRetention({ keepDays: 60 }).retention).toEqual({ enabled: true, keepDays: 60 });
    expect(engine.setTranscriptRetention({ enabled: false }).retention).toEqual({ enabled: false, keepDays: 60 });
    // 60 days: nothing of a task 40 days old goes.
    expect((await engine.cleanUpTranscripts()).lastCleanup).toMatchObject({ tasks: 0, steps: 0 });
  });
});
