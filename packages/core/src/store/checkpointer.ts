import { Worker } from "node:worker_threads";

/**
 * Checkpoints the store's WAL from a worker thread with its own connection, so no commit on the main thread does it.
 * SQLite's automatic checkpoint runs inside whichever commit takes the WAL past 1,000 pages: on a 200 MB database that
 * one commit took 86–157 ms (a normal one about 0.05 ms), and the engine runs in Electron's main process.
 *
 * The worker only runs PASSIVE checkpoints, which take no lock that a write waits on. The other modes hold the write
 * lock while they copy and sync, and a write that came meanwhile waited up to 170 ms (measured). A WAL starts over at
 * the first write after a checkpoint that copied all of it, so it needs a pause in the writes as long as one
 * checkpoint (a few ms); the app's writes have those. Writes that never pause that long would make it grow without
 * end: past `WAL_FRAMES_BEFORE_HELP` the worker asks the store to copy the last pages itself, the worker having copied
 * the rest, and the next write starts the WAL over.
 *
 * SQLite syncs the database file only after a checkpoint that reaches the WAL's end, so in that case the store's would
 * sync all the worker had copied meanwhile: 60–175 ms (measured). On Windows the worker syncs the file first, and then
 * the store's copy and sync of the last pages took a few ms.
 */

/** How often the worker checkpoints. */
export const CHECKPOINT_EVERY_MS = 1_000;
/** After a checkpoint that found new pages: how soon the next one, which copies what was written meanwhile. */
export const CHECKPOINT_CATCH_UP_MS = 20;
/** Pages in the WAL (64 MB at 4 KB) after which the store is asked to copy the last ones itself. */
export const WAL_FRAMES_BEFORE_HELP = 16_384;
/** At most this many pages left for the store to copy when it's asked (about 0.04 ms a page, measured). */
export const HELP_UP_TO_FRAMES = 100;
/**
 * At close: how long to wait for a checkpoint that's running (one of 40 MB took about 100 ms). It goes on alone after
 * that, and closes its connection when it ends. A worker that died without saying so is waited for this long too.
 */
const STOP_WAIT_MS = 2_000;

// The slots of the state the store and the worker share.
const STATE = 0;
/** Bumped to wake the worker: by `wake()` and by `stop()`. A worker that's checkpointing sees it before it waits. */
const SIGNAL = 1;
const PASSES = 2;
const CHECKPOINTING = 3;
const LOG = 4;
const CHECKPOINTED = 5;
/** 1 once the worker has opened the database. */
const OPENED = 6;
const SLOTS = 7;

// Values of STATE. Only the worker moves it from STARTING to RUNNING, and only if `stop()` hasn't moved it to STOPPED first.
const STARTING = 0;
const RUNNING = 1;
const STOPPING = 2;
const STOPPED = 3;

export interface CheckpointTiming {
  everyMs?: number;
  catchUpMs?: number;
  framesBeforeHelp?: number;
  helpUpToFrames?: number;
}

/** What the worker tells the store. */
export interface CheckpointEvents {
  /** The WAL is past `WAL_FRAMES_BEFORE_HELP` and writes keep coming: copy the last pages. */
  behind(): void;
  /** The worker failed or stopped by itself. It's told once; nothing else is after it. */
  failed(error: unknown): void;
}

type Message = { kind: "behind" } | { kind: "failed"; error: unknown };

// The worker's code, run as a script: the main bundle has no separate file for it (electron-vite bundles the core), and
// a script needs no loader in vitest or Electron.
const WORKER = `
const { workerData, parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const { file, state, everyMs, catchUpMs, framesBeforeHelp, helpUpToFrames } = workerData;
let db;
let fd;
// Syncs the database file, which the checkpoints wrote to (Windows flushes a file's cache through any handle). Not
// elsewhere: closing another descriptor of the file would drop SQLite's POSIX locks on it.
function syncDatabase() {
  if (process.platform !== "win32") return false;
  try {
    fd ??= fs.openSync(file, "r+");
    fs.fsyncSync(fd);
    return true;
  } catch {
    return false;
  }
}
try {
  if (Atomics.compareExchange(state, ${STATE}, ${STARTING}, ${RUNNING}) === ${STARTING}) {
    db = new DatabaseSync(file);
    Atomics.store(state, ${OPENED}, 1);
    // Waiting is fine here, off the main thread; a PASSIVE checkpoint never waits, but reading the schema can.
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
    let lastLog = 0;
    let lastStart = -1;
    let synced = false;
    for (;;) {
      const signal = Atomics.load(state, ${SIGNAL});
      if (Atomics.load(state, ${STATE}) !== ${RUNNING}) break;
      const start = performance.now();
      Atomics.store(state, ${CHECKPOINTING}, 1);
      let result;
      try {
        result = checkpoint.get();
      } finally {
        Atomics.store(state, ${CHECKPOINTING}, 0);
      }
      const took = performance.now() - start;
      // The WAL's pages when the checkpoint started, and how many are in the database file now (both -1 when another
      // connection was checkpointing). Writes during it don't show until the next one.
      const { log, checkpointed } = result;
      Atomics.store(state, ${LOG}, log);
      Atomics.store(state, ${CHECKPOINTED}, checkpointed);
      Atomics.add(state, ${PASSES}, 1);
      // Pages written since the last checkpoint started (or the WAL started over): there may be more by now, so check again soon.
      const grew = log > 0 && log !== lastLog;
      let help = false;
      if (grew && log > lastLog && log >= framesBeforeHelp && lastStart >= 0) {
        // Still no start over: ask for help once the pages written during this checkpoint, at the rate they came in
        // since the last one, are few enough for the store to copy in a few ms.
        help = ((log - lastLog) / (start - lastStart)) * took <= helpUpToFrames;
      }
      if (log >= 0) lastLog = log;
      lastStart = start;
      if (help && !synced && syncDatabase()) {
        // What the checkpoints copied is on disk now; copy what came in meanwhile, and ask then.
        synced = true;
        continue;
      }
      synced = false;
      if (help) parentPort.postMessage({ kind: "behind" });
      Atomics.wait(state, ${SIGNAL}, signal, grew ? catchUpMs : everyMs);
    }
  }
} catch (error) {
  parentPort.postMessage({ kind: "failed", error });
} finally {
  try {
    if (fd !== undefined) fs.closeSync(fd);
  } catch {}
  try {
    db?.close();
  } catch {}
  Atomics.store(state, ${STATE}, ${STOPPED});
  Atomics.notify(state, ${STATE});
}
`;

export class Checkpointer {
  private readonly state = new Int32Array(new SharedArrayBuffer(SLOTS * Int32Array.BYTES_PER_ELEMENT));
  private readonly worker: Worker;
  private readonly events: CheckpointEvents;
  /** Stopped by `stop()`, or failed: the store hears nothing more. */
  private done = false;

  constructor(file: string, events: CheckpointEvents, timing: CheckpointTiming = {}) {
    this.events = events;
    this.worker = new Worker(WORKER, {
      eval: true,
      name: "aria-checkpoint",
      workerData: {
        file,
        state: this.state,
        everyMs: timing.everyMs ?? CHECKPOINT_EVERY_MS,
        catchUpMs: timing.catchUpMs ?? CHECKPOINT_CATCH_UP_MS,
        framesBeforeHelp: timing.framesBeforeHelp ?? WAL_FRAMES_BEFORE_HELP,
        helpUpToFrames: timing.helpUpToFrames ?? HELP_UP_TO_FRAMES,
      },
    });
    // It never keeps the process running: whoever forgets to close the store loses nothing (SQLite replays the WAL).
    this.worker.unref();
    this.worker.on("message", (message: Message) => {
      if (this.done) return;
      if (message.kind === "behind") this.events.behind();
      else this.fail(message.error);
    });
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => this.fail(new Error(`The checkpoint worker stopped (exit code ${code}).`)));
  }

  /** Whether the worker has its connection open and checkpoints. */
  get running(): boolean {
    return Atomics.load(this.state, STATE) === RUNNING;
  }

  /** Whether the worker ever opened the database. */
  get opened(): boolean {
    return Atomics.load(this.state, OPENED) === 1;
  }

  /** Whether a checkpoint is running now. */
  get checkpointing(): boolean {
    return Atomics.load(this.state, CHECKPOINTING) === 1;
  }

  /** How many checkpoints the worker has run. */
  get passes(): number {
    return Atomics.load(this.state, PASSES);
  }

  /** What the last checkpoint found: the pages in the WAL, and how many of them are in the database file. */
  get last(): { log: number; checkpointed: number } {
    return { log: Atomics.load(this.state, LOG), checkpointed: Atomics.load(this.state, CHECKPOINTED) };
  }

  /** Checkpoints now rather than at the next turn (or right after the one that's running). */
  wake(): void {
    this.signal();
  }

  /**
   * Stops the worker and waits until its connection is closed, so the files can be deleted (Windows) and the store's
   * own last checkpoint isn't refused: a checkpoint that's running ends first. A worker still starting never opens one.
   * Blocks the thread for that long, which a close may: Node and Electron's main process allow `Atomics.wait`.
   */
  stop(): void {
    if (this.done) return;
    this.done = true;
    // Still starting: it sees this and ends without opening the database.
    if (Atomics.compareExchange(this.state, STATE, STARTING, STOPPED) === STARTING) return;
    Atomics.compareExchange(this.state, STATE, RUNNING, STOPPING);
    this.signal();
    for (let state = Atomics.load(this.state, STATE); state !== STOPPED; state = Atomics.load(this.state, STATE)) {
      if (Atomics.wait(this.state, STATE, state, STOP_WAIT_MS) === "timed-out") break;
    }
  }

  private signal(): void {
    Atomics.add(this.state, SIGNAL, 1);
    Atomics.notify(this.state, SIGNAL);
  }

  private fail(error: unknown): void {
    if (this.done) return;
    this.done = true;
    this.events.failed(error);
  }
}
