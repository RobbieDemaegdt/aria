/** P5: live transcript entries written together, statements prepared once, commits that don't wait for the disk. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TranscriptEntry } from "@aria/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AriaEngine } from "../src/engine.ts";
import { FakeRuntime } from "../src/runtime/fake.ts";
import { reportSlowCalls } from "../src/store/slow-calls.ts";
import { Store, TRANSCRIPT_QUEUE_MS, TRANSCRIPT_RETRY_MS } from "../src/store/store.ts";

const temps: string[] = [];
const stores: Store[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // Closed by the test.
    }
  }
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** On disk, so another connection can see what's written and what isn't yet. */
function open(): { store: Store; file: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aria-store-queue-"));
  temps.push(dir);
  const file = path.join(dir, "aria.db");
  const store = new Store(file);
  stores.push(store);
  return { store, file };
}

/** What another connection sees of `owner`'s entries: their ids, in order. */
function written(file: string, owner: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5_000 });
  try {
    const rows = db.prepare("SELECT entry_id FROM session_transcripts WHERE owner_id = ? ORDER BY seq").all(owner) as Array<{ entry_id: string }>;
    return rows.map((r) => r.entry_id);
  } finally {
    db.close();
  }
}

const info = (id: string, at: number, text = id): TranscriptEntry => ({ kind: "info", id, at, level: "info", text });
const said = (id: string, at: number, text: string): TranscriptEntry => ({ kind: "user", id, at, text });
const ids = (entries: TranscriptEntry[]) => entries.map((e) => e.id);
const owner = "task:t1";

/** The store's own connection, for counting what it runs. */
const connection = (store: Store) => (store as unknown as { db: DatabaseSync }).db;

describe("live transcript entries (P5)", () => {
  it("are written together a moment after they come in, in one transaction", () => {
    const { store, file } = open();
    const exec = vi.spyOn(connection(store), "exec");
    for (let i = 0; i < 100; i++) store.queueTranscriptEntries(owner, [info(`e${i}`, i)]);
    expect(written(file, owner)).toEqual([]);
    vi.advanceTimersByTime(TRANSCRIPT_QUEUE_MS - 1);
    expect(written(file, owner)).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(written(file, owner)).toEqual(Array.from({ length: 100 }, (_, i) => `e${i}`));
    expect(exec.mock.calls.filter(([sql]) => sql === "BEGIN")).toHaveLength(1);
  });

  it("are written before anything reads that owner's entries, and only that owner's", () => {
    const reads: Array<[string, (store: Store) => unknown, unknown]> = [
      ["listTranscriptEntries", (s) => ids(s.listTranscriptEntries(owner)), ["e1", "e2"]],
      ["storedTranscriptJson", (s) => [...s.storedTranscriptJson(owner).keys()], ["e1", "e2"]],
      ["hasTranscriptEntries", (s) => s.hasTranscriptEntries(owner), true],
      ["hasTranscriptMessage", (s) => s.hasTranscriptMessage(owner, "user", "Fix the build"), true],
      ["searchTranscriptEntries", (s) => s.searchTranscriptEntries(["build"], { ownerIds: [owner] }).total, 1],
    ];
    for (const [name, read, expected] of reads) {
      const { store, file } = open();
      store.queueTranscriptEntries(owner, [info("e1", 1)]);
      store.queueTranscriptEntries(owner, [said("e2", 2, "Fix the build")]);
      store.queueTranscriptEntries("task:other", [info("o1", 1)]);
      expect(read(store), name).toEqual(expected);
      expect(written(file, owner), name).toEqual(["e1", "e2"]);
      expect(written(file, "task:other"), name).toEqual([]);
    }
  });

  it("are all written before a search across every owner", () => {
    const { store } = open();
    store.queueTranscriptEntries(owner, [said("e1", 1, "Fix the build")]);
    store.queueTranscriptEntries("task:other", [said("o1", 2, "Build it again")]);
    expect(store.searchTranscriptEntries(["build"]).total).toBe(2);
  });

  it("keep their order and each step's newest copy, as writing each as it came did", () => {
    const steps: Array<["queue" | "now", TranscriptEntry]> = [
      ["queue", info("a", 1)],
      ["queue", info("b", 2)],
      // The same step again (a tool call that finished): it keeps its place.
      ["queue", info("a", 1, "a, finished")],
      ["now", info("c", 3)],
      ["queue", info("d", 4)],
      ["queue", info("b", 2, "b, finished")],
      ["now", info("a", 1, "a, read again")],
      ["queue", info("e", 5)],
    ];
    const queued = open();
    const each = open();
    for (const [how, entry] of steps) {
      if (how === "queue") queued.store.queueTranscriptEntries(owner, [entry]);
      else queued.store.upsertTranscriptEntries(owner, [entry]);
      each.store.upsertTranscriptEntries(owner, [entry]);
    }
    vi.advanceTimersByTime(TRANSCRIPT_QUEUE_MS);
    expect(written(queued.file, owner)).toEqual(["a", "b", "c", "d", "e"]);
    expect(queued.store.listTranscriptEntries(owner)).toEqual(each.store.listTranscriptEntries(owner));
    expect(queued.store.listTranscriptEntries(owner).map((e) => (e.kind === "info" ? e.text : ""))).toEqual(["a, read again", "b, finished", "c", "d", "e"]);
  });

  it("are written when the store closes", () => {
    const { store, file } = open();
    store.queueTranscriptEntries(owner, [info("e1", 1), info("e2", 2)]);
    store.close();
    expect(written(file, owner)).toEqual(["e1", "e2"]);
    const reopened = new Store(file);
    stores.push(reopened);
    expect(ids(reopened.listTranscriptEntries(owner))).toEqual(["e1", "e2"]);
  });

  it("can't be queued once the store is closed", () => {
    const { store } = open();
    store.close();
    expect(() => store.queueTranscriptEntries(owner, [info("e1", 1)])).toThrow("The store is closed.");
  });

  it("go with the rest when the owner's entries are deleted", () => {
    const { store, file } = open();
    store.upsertTranscriptEntries(owner, [info("e1", 1)]);
    store.queueTranscriptEntries(owner, [info("e2", 2)]);
    store.deleteTranscriptEntries(owner);
    vi.advanceTimersByTime(TRANSCRIPT_QUEUE_MS);
    expect(written(file, owner)).toEqual([]);
  });

  it("are written before the owner is marked as saved", () => {
    const { store, file } = open();
    store.queueTranscriptEntries(owner, [info("e1", 1)]);
    store.markTranscriptBackfilled(owner);
    expect(written(file, owner)).toEqual(["e1"]);
    expect(store.isTranscriptBackfilled(owner)).toBe(true);
  });

  it("stay queued when their write fails, are tried again later, and a failing streak is reported once", () => {
    const { store, file } = open();
    const errors: unknown[] = [];
    store.onQueueError = (error) => errors.push(error);
    const failing = failWrites(store);
    store.upsertTranscriptEntries(owner, [info("e0", 0)]);
    failing.now = "disk I/O error";
    store.queueTranscriptEntries(owner, [info("e1", 1)]);
    vi.advanceTimersByTime(TRANSCRIPT_QUEUE_MS);
    expect(errors).toEqual([new Error("disk I/O error")]);
    store.queueTranscriptEntries(owner, [info("e2", 2)]);
    // A read still shows what's saved, as it did when each step was written as it came.
    expect(ids(store.listTranscriptEntries(owner))).toEqual(["e0"]);
    vi.advanceTimersByTime(TRANSCRIPT_RETRY_MS);
    expect(errors).toHaveLength(1);
    expect(written(file, owner)).toEqual(["e0"]);
    // It works again: the next try writes them, with nothing new coming in.
    failing.now = undefined;
    vi.advanceTimersByTime(TRANSCRIPT_RETRY_MS);
    expect(written(file, owner)).toEqual(["e0", "e1", "e2"]);
    // Failing again is news again.
    failing.now = "disk full";
    store.queueTranscriptEntries(owner, [info("e3", 3)]);
    vi.advanceTimersByTime(TRANSCRIPT_QUEUE_MS);
    expect(errors).toEqual([new Error("disk I/O error"), new Error("disk full")]);
  });

  it("report a full disk as a full disk", () => {
    const { store } = open();
    const errors: unknown[] = [];
    store.onQueueError = (error) => errors.push(error);
    const db = connection(store);
    const { page_count } = db.prepare("PRAGMA page_count").get() as { page_count: number };
    db.exec(`PRAGMA max_page_count = ${page_count + 2}`);
    store.queueTranscriptEntries(owner, [info("big", 1, "x".repeat(200_000))]);
    vi.advanceTimersByTime(TRANSCRIPT_QUEUE_MS);
    // SQLite rolled the transaction back itself: not "cannot rollback - no transaction is active".
    expect(String(errors[0])).toMatch(/full/);
  });

  it("are reported when the close can't write them, even in a failing streak, and the store still closes", () => {
    const { store } = open();
    const errors: unknown[] = [];
    store.onQueueError = (error) => errors.push(error);
    failWrites(store, "disk full");
    store.queueTranscriptEntries(owner, [info("e1", 1)]);
    vi.advanceTimersByTime(TRANSCRIPT_QUEUE_MS);
    store.close();
    expect(errors).toEqual([new Error("disk full"), new Error("disk full")]);
    expect(() => store.getSetting("x")).toThrow();
  });

  it("left unwritten (ARIA stopped without closing the store) leave their owner marked as not all saved", () => {
    const { store, file } = open();
    store.upsertTranscriptEntries(owner, [info("e1", 1)]);
    store.markTranscriptBackfilled(owner);
    store.markTranscriptBackfilled("task:other");
    store.queueTranscriptEntries(owner, [info("e2", 2)]);
    // Gone without a close: its queue is never written.
    connection(store).close();
    const reopened = new Store(file);
    stores.push(reopened);
    expect(reopened.isTranscriptBackfilled(owner)).toBe(false);
    expect(reopened.isTranscriptBackfilled("task:other")).toBe(true);
    expect(ids(reopened.listTranscriptEntries(owner))).toEqual(["e1"]);
    // Noted once: after this start, it's like any owner that isn't all saved.
    reopened.markTranscriptBackfilled(owner);
    reopened.close();
    const again = new Store(file);
    stores.push(again);
    expect(again.isTranscriptBackfilled(owner)).toBe(true);
  });

  it("left unwritten count as not all saved for the whole run when the start can't unmark them, and the next start tries again", () => {
    const { store, file } = open();
    store.markTranscriptBackfilled(owner);
    store.markTranscriptBackfilled("task:done");
    store.queueTranscriptEntries(owner, [info("e1", 1)]);
    store.queueTranscriptEntries("task:done", [info("d1", 1)]);
    connection(store).close();
    // The start's unmarking fails (a full disk, a lock).
    const transaction = vi.spyOn(Store.prototype as unknown as { inTransaction: () => void }, "inTransaction").mockImplementationOnce(() => {
      throw new Error("disk I/O error");
    });
    const second = new Store(file);
    stores.push(second);
    transaction.mockRestore();
    const errors: unknown[] = [];
    second.onQueueError = (error) => errors.push(error);
    expect(errors).toEqual([new Error("disk I/O error")]);
    expect(second.isTranscriptBackfilled(owner)).toBe(false);
    // One is checked again and saved in this run; the other isn't.
    second.markTranscriptBackfilled("task:done");
    expect(second.isTranscriptBackfilled("task:done")).toBe(true);
    // Another owner's steps come and are written, which notes whose aren't all saved: still the unchecked one.
    second.queueTranscriptEntries("conductor", [info("c1", 1)]);
    vi.advanceTimersByTime(TRANSCRIPT_QUEUE_MS);
    connection(second).close();
    const third = new Store(file);
    stores.push(third);
    expect(third.isTranscriptBackfilled(owner)).toBe(false);
    expect(third.isTranscriptBackfilled("task:done")).toBe(true);
  });

  it("written, or closed with the store, leave their owner marked as it was", () => {
    const { store, file } = open();
    store.markTranscriptBackfilled(owner);
    store.queueTranscriptEntries(owner, [info("e1", 1)]);
    vi.advanceTimersByTime(TRANSCRIPT_QUEUE_MS);
    store.queueTranscriptEntries(owner, [info("e2", 2)]);
    store.close();
    const reopened = new Store(file);
    stores.push(reopened);
    expect(reopened.isTranscriptBackfilled(owner)).toBe(true);
    expect(ids(reopened.listTranscriptEntries(owner))).toEqual(["e1", "e2"]);
  });
});

/** Makes the store's transcript writes throw `now` while it's set. */
function failWrites(store: Store, now?: string): { now: string | undefined } {
  const failing = { now };
  const own = store as unknown as { writeTranscriptEntries: (...args: unknown[]) => void };
  const write = own.writeTranscriptEntries;
  own.writeTranscriptEntries = function (this: unknown, ...args: unknown[]) {
    if (failing.now) throw new Error(failing.now);
    write.apply(this, args);
  };
  return failing;
}

describe("the store's connection (P5)", () => {
  it("commits without waiting for the disk, with WAL", () => {
    const { store } = open();
    const db = connection(store);
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    // 1 is NORMAL (2, FULL, was SQLite's default).
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
  });

  it("prepares the statements of the busiest calls once", () => {
    const { store } = open();
    const prepare = vi.spyOn(connection(store), "prepare");
    const task = { id: "t1", repoId: 1, title: "A task", state: "running", archived: false, createdAt: 1, updatedAt: 1, costNano: 0 } as never;
    for (let i = 0; i < 3; i++) {
      store.saveTask(task);
      store.getTask("t1");
      store.setSetting("k", i);
      store.getSetting("k");
      store.upsertTimeline({ kind: "chat", id: `c${i}`, role: "assistant", content: "Hi", createdAt: i });
      store.upsertTranscriptEntries(owner, [info(`e${i}`, i)]);
      store.queueTranscriptEntries(owner, [info(`q${i}`, i)]);
      store.listTranscriptEntries(owner);
      store.storedTranscriptJson(owner);
    }
    const counts = new Map<string, number>();
    for (const [sql] of prepare.mock.calls) counts.set(sql, (counts.get(sql) ?? 0) + 1);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    // getSetting's was prepared as the store opened, before this counted. A transcript write also reads the owner's
    // pruned mark (D1).
    expect(counts.size).toBe(9);
  });
});

describe("the engine's store (P5)", () => {
  it("logs a call that took longer than a frame, at debug level, and live steps it couldn't save as it stopped", async () => {
    vi.useRealTimers();
    const dir = mkdtempSync(path.join(os.tmpdir(), "aria-store-log-"));
    temps.push(dir);
    const engine = new AriaEngine({ dataDir: dir, runtime: new FakeRuntime(), projectRoots: [], logLevel: "debug" });
    try {
      await engine.start();
      const db = (engine as unknown as { db: Store }).db;
      // By this clock every call takes 20 ms.
      let now = 0;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => (now += 20));
      db.getSetting("anything");
      clock.mockRestore();
      // The last steps can't be written when ARIA stops: that's in the log, which closes after the store.
      failWrites(db, "disk full");
      db.queueTranscriptEntries(owner, [info("e1", 1)]);
    } finally {
      await engine.stop();
    }
    const log = readFileSync(path.join(dir, "logs", "aria.log"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { level: string; subsystem: string; msg: string; data?: unknown });
    expect(log).toContainEqual(expect.objectContaining({ level: "debug", subsystem: "store", data: { call: "getSetting", ms: expect.any(Number) } }));
    expect(log).toContainEqual(expect.objectContaining({ level: "warn", msg: "Saving the steps a session sent failed: disk full" }));
  });
});

describe("slow store calls (P5)", () => {
  it("are reported by the call you made, not the store calls it made itself", () => {
    const { store } = open();
    const calls: string[] = [];
    reportSlowCalls(store, (call) => calls.push(call), -1);
    store.markTranscriptBackfilled(owner);
    expect(calls).toEqual(["markTranscriptBackfilled"]);
    calls.length = 0;
    store.queueTranscriptEntries(owner, [info("e1", 1)]);
    vi.advanceTimersByTime(TRANSCRIPT_QUEUE_MS);
    // The queue's own write is timed too.
    expect(calls).toEqual(["queueTranscriptEntries", "writeQueuedNow"]);
  });

  it("aren't reported when they're quick, and a report that throws changes no call's result", () => {
    const { store } = open();
    const calls: string[] = [];
    reportSlowCalls(store, (call) => calls.push(call), 10_000);
    store.setSetting("k", 1);
    expect(calls).toEqual([]);
    reportSlowCalls(
      store,
      () => {
        throw new Error("broken log");
      },
      -1,
    );
    expect(store.getSetting("k")).toBe(1);
    store.close();
    expect(() => store.queueTranscriptEntries(owner, [info("e1", 1)])).toThrow("The store is closed.");
  });
});
