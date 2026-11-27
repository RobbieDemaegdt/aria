/** The WAL is checkpointed by a worker thread with its own connection, not in the store's commits on the main thread. */
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Checkpointer } from "../src/store/checkpointer.ts";
import { Store, type StoreOptions } from "../src/store/store.ts";

const temps: string[] = [];
const stores: Store[] = [];
afterEach(() => {
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

function open(options?: StoreOptions): { store: Store; dir: string; file: string; checkpointer: Checkpointer } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aria-checkpoint-"));
  temps.push(dir);
  const file = path.join(dir, "aria.db");
  const store = new Store(file, options);
  stores.push(store);
  return { store, dir, file, checkpointer: internals(store).checkpointer! };
}

const internals = (store: Store) => store as unknown as { db: DatabaseSync; checkpointer: Checkpointer | undefined };
const threadOf = (checkpointer: Checkpointer) => (checkpointer as unknown as { worker: Worker }).worker;
const autocheckpoint = (store: Store) =>
  (internals(store).db.prepare("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number }).wal_autocheckpoint;
/** A worker starts in tens of ms, longer with the other test files running beside this one. */
const soon = { timeout: 10_000 };

const value = "x".repeat(3500);
/** About `mb` MB of pages into the WAL: a row of its own page in each commit. */
function fill(store: Store, mb: number): number {
  const rows = mb * 256;
  for (let i = 0; i < rows; i++) store.setSetting(`fill.${i}`, value);
  return rows;
}

/** No checkpoint after the first, unless woken. */
const onlyWhenWoken: StoreOptions = { checkpoint: { everyMs: 600_000, catchUpMs: 600_000 } };

describe("checkpoints in a worker", () => {
  it("are made by a worker that opens its own connection, and never in the store's commits", async () => {
    const { store, file, checkpointer } = open(onlyWhenWoken);
    expect(autocheckpoint(store)).toBe(0);
    await vi.waitFor(() => expect(checkpointer.passes).toBe(1), soon);
    expect(checkpointer.running).toBe(true);

    fill(store, 8);
    // Every page is still in the WAL: SQLite's own checkpoints would have started it over at 1,000 pages (4 MB).
    expect(statSync(`${file}-wal`).size).toBeGreaterThan(7 * 1024 * 1024);

    checkpointer.wake();
    await vi.waitFor(() => expect(checkpointer.passes).toBe(2), soon);
    expect(checkpointer.last.log).toBeGreaterThan(2000);
    expect(checkpointer.last.checkpointed).toBe(checkpointer.last.log);

    // Copied in full, so the next write starts the WAL over.
    store.setSetting("after", true);
    checkpointer.wake();
    await vi.waitFor(() => expect(checkpointer.passes).toBe(3), soon);
    expect(checkpointer.last.log).toBeLessThan(10);
  });

  it("stop at close(), whose connection closes first: the files can be deleted right after", async () => {
    const { store, dir, file, checkpointer } = open();
    // Opened, not only running: the worker says it runs before it opens the database.
    await vi.waitFor(() => expect(checkpointer.opened).toBe(true), soon);
    expect(checkpointer.running).toBe(true);
    fill(store, 1);
    store.close();
    expect(checkpointer.running).toBe(false);
    // The store's connection was the last one, so SQLite checkpointed the WAL and removed it.
    expect(existsSync(`${file}-wal`)).toBe(false);
    // No retries: on Windows a connection still open would make this fail.
    rmSync(dir, { recursive: true });
  });

  it("never open the database when close() comes while the worker is still starting", async () => {
    const { store, dir, checkpointer } = open();
    const exited = once(threadOf(checkpointer), "exit");
    store.close();
    // It starts all the same, sees the store closed, and ends.
    await exited;
    expect(checkpointer.opened).toBe(false);
    expect(checkpointer.passes).toBe(0);
    rmSync(dir, { recursive: true });
  });

  it("end before close() goes on when it comes during one, and nothing is lost", async () => {
    const { store, dir, file, checkpointer } = open(onlyWhenWoken);
    await vi.waitFor(() => expect(checkpointer.passes).toBe(1), soon);
    const rows = fill(store, 16);

    checkpointer.wake();
    const deadline = Date.now() + 10_000;
    while (!checkpointer.checkpointing && Date.now() < deadline) {
      // Until it's copying the 16 MB.
    }
    expect(checkpointer.checkpointing).toBe(true);
    store.close();
    expect(checkpointer.checkpointing).toBe(false);
    expect(checkpointer.passes).toBe(2);
    expect(checkpointer.running).toBe(false);
    expect(existsSync(`${file}-wal`)).toBe(false);

    const reopened = new Store(file);
    try {
      expect(reopened.getSetting("fill.0")).toBe(value);
      expect(reopened.getSetting(`fill.${rows - 1}`)).toBe(value);
    } finally {
      reopened.close();
    }
    rmSync(dir, { recursive: true });
  });

  it("go back into the commits when the worker stops by itself, which is told once", async () => {
    const { store, checkpointer } = open();
    const told = vi.fn();
    store.onCheckpointError = told;
    await vi.waitFor(() => expect(checkpointer.running).toBe(true), soon);

    await threadOf(checkpointer).terminate();
    await vi.waitFor(() => expect(told).toHaveBeenCalledOnce(), soon);
    expect(String(told.mock.calls[0]![0])).toContain("The checkpoint worker stopped");
    expect(autocheckpoint(store)).toBe(1000);
    expect(internals(store).checkpointer).toBeUndefined();

    store.setSetting("still", "works");
    expect(store.getSetting("still")).toBe("works");
  });

  it("are finished by the store when writes never pause long enough for the worker to catch up", async () => {
    // Asked as soon as the WAL passes 50 pages, however many were written during the worker's last checkpoint.
    const { store, checkpointer } = open({ checkpoint: { framesBeforeHelp: 50, helpUpToFrames: Number.MAX_SAFE_INTEGER } });
    await vi.waitFor(() => expect(checkpointer.running).toBe(true), soon);
    // The store's checkpoints, with what each found.
    const db = internals(store).db;
    const exec = db.exec.bind(db);
    const helps: Array<{ busy: number; log: number; checkpointed: number }> = [];
    vi.spyOn(db, "exec").mockImplementation((sql: string) => {
      if (sql !== "PRAGMA wal_checkpoint(PASSIVE)") return exec(sql);
      helps.push(db.prepare(sql).get() as { busy: number; log: number; checkpointed: number });
    });
    // One that copied the WAL to its end (none does when the worker's checkpoint is running at that moment).
    const finished = () => helps.some((r) => r.busy === 0 && r.log >= 50 && r.checkpointed === r.log);

    const deadline = Date.now() + 10_000;
    for (let i = 0; !finished() && Date.now() < deadline; i++) {
      // A new value each time: SQLite writes no page for a row that stays the same.
      store.setSetting(`k${i % 100}`, `${i}${value}`);
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(finished()).toBe(true);

    // Nothing was written after it, so the next write starts the WAL over: the worker finds only that write's pages.
    store.setSetting("after", true);
    const passes = checkpointer.passes;
    checkpointer.wake();
    await vi.waitFor(() => expect(checkpointer.passes).toBeGreaterThan(passes), soon);
    expect(checkpointer.last.log).toBeLessThan(10);
  });

  it("aren't made for a database in memory, which has no WAL", () => {
    const store = new Store(":memory:");
    stores.push(store);
    expect(internals(store).checkpointer).toBeUndefined();
  });
});

// The slots of the state the test and the holder below share.
/** Set when the test starts opening the store. */
const OPENING = 0;
/** Set by the holder just before it lets go of the lock. */
const RELEASING = 1;

/**
 * Another thread's connection, which keeps the database file locked until `holdMs` after the test starts opening a
 * store: as the last connection to close does while it checkpoints the WAL (a checkpoint worker that outlasted the
 * close's wait, say). In exclusive locking mode it locks the file itself, so a new connection can't even read it.
 */
const HOLDER = `
const { workerData, parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { file, state, holdMs } = workerData;
const db = new DatabaseSync(file);
db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;");
parentPort.postMessage("locked");
Atomics.wait(state, ${OPENING}, 0);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
Atomics.store(state, ${RELEASING}, 1);
db.exec("COMMIT");
db.close();
`;

describe("a store that opens a file another connection has locked", () => {
  it("waits for the lock from its first statement on, instead of failing at once with 'database is locked'", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "aria-checkpoint-"));
    temps.push(dir);
    const file = path.join(dir, "aria.db");
    const first = new Store(file);
    first.setSetting("kept", "yes");
    first.close();

    const state = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
    const holder = new Worker(HOLDER, { eval: true, workerData: { file, state, holdMs: 300 } });
    const exited = once(holder, "exit");
    try {
      await once(holder, "message");
      // The holder keeps the lock 300 ms more from here: the store's first statement comes long before that.
      Atomics.store(state, OPENING, 1);
      Atomics.notify(state, OPENING);
      const store = new Store(file);
      stores.push(store);
      // It opened only once the lock was let go.
      expect(Atomics.load(state, RELEASING)).toBe(1);
      expect(store.getSetting("kept")).toBe("yes");
    } finally {
      // The holder lets go of the lock and ends, whatever happened above.
      Atomics.store(state, OPENING, 1);
      Atomics.notify(state, OPENING);
      await exited;
    }
  });
});
