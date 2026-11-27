/**
 * D1: transcript retention. A finished task keeps its whole transcript in the database for `keepDays`; after that its
 * tool calls, permission lines and reasoning go (about nine tenths of its bytes) and your messages, its replies, its
 * questions, its notices and the step that wrote its plan stay, for the session view and Search. Once a day, about a
 * minute after ARIA starts and then every day it runs, and whenever you click "Clean up now" in Customize › Data.
 *
 * A task whose Copilot session still exists still shows its whole history when its session can be opened (its worktree
 * is there): the session is the source, and the database copy serves Search. A task whose session is gone shows what the
 * database kept. Either way the store's mark (`markTranscriptPruned`) keeps the removed steps from being saved again.
 */
import type { DataState, TaskState, TranscriptCleanup, TranscriptRetention } from "@aria/protocol";
import type { Clock } from "../attention/clock.ts";
import type { Store, TaskRecord } from "./store.ts";

export const DEFAULT_RETENTION: TranscriptRetention = { enabled: true, keepDays: 30 };
export const MAX_KEEP_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The first clean-up after a start waits this long, so it doesn't add to the start. */
export const CLEANUP_START_DELAY_MS = 60_000;
/** How often ARIA looks whether a day has passed since the last clean-up (a sleeping PC delays timers). */
export const CLEANUP_CHECK_MS = 60 * 60_000;
/** Steps deleted in one transaction: a batch takes a few ms, so the window never waits long for one. */
export const CLEANUP_BATCH = 500;
/** Going through the tasks gives the window and the tasks their turn this often, however many tasks there are. */
const SLICE_MS = 8;
const RETENTION = "transcripts.retention";
const LAST_CLEANUP = "transcripts.lastCleanup";
/** The states a task is finished in. One that's queued, working, waiting or interrupted keeps everything. */
const FINISHED: ReadonlySet<TaskState> = new Set(["done", "failed", "cancelled"]);

/** A finished task (and not archived: an archived one keeps everything, as it was). */
const finished = (task: TaskRecord): task is TaskRecord & { finishedAt: number } => !task.archived && FINISHED.has(task.state) && task.finishedAt !== undefined;
/** A finished task that finished before `cutoff`. */
const finishedBefore = (task: TaskRecord, cutoff: number): task is TaskRecord & { finishedAt: number } => finished(task) && task.finishedAt < cutoff;

export interface RetentionDeps {
  db: () => Store;
  /** For the timers only. */
  clock: Clock;
  /** The time the cut-off and the marks are in: a task's `finishedAt` and its steps' `at` are wall-clock times. */
  now?: () => number;
  /** ARIA is quitting: a clean-up stops between batches. */
  stopped: () => boolean;
  /** A clean-up that failed (the next one tries again). */
  failed: (error: unknown) => void;
  /** Between batches, so the window and the tasks get their turn. */
  yieldTurn?: () => Promise<void>;
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

export class TranscriptRetentionRunner {
  private timer: unknown;
  private running: Promise<TranscriptCleanup> | undefined;
  private started = false;

  constructor(private readonly deps: RetentionDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  settings(): TranscriptRetention {
    const stored = this.deps.db().getSetting<Partial<TranscriptRetention>>(RETENTION);
    const days = stored?.keepDays;
    return {
      enabled: typeof stored?.enabled === "boolean" ? stored.enabled : DEFAULT_RETENTION.enabled,
      keepDays: typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= MAX_KEEP_DAYS ? days : DEFAULT_RETENTION.keepDays,
    };
  }

  setSettings(patch: { enabled?: boolean | undefined; keepDays?: number | undefined }): TranscriptRetention {
    const next = { ...this.settings() };
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.keepDays !== undefined) {
      if (!Number.isInteger(patch.keepDays) || patch.keepDays < 1 || patch.keepDays > MAX_KEEP_DAYS) throw new Error(`Keep transcripts for 1 to ${MAX_KEEP_DAYS} days.`);
      next.keepDays = patch.keepDays;
    }
    this.deps.db().setSetting(RETENTION, next);
    return next;
  }

  lastCleanup(): TranscriptCleanup | undefined {
    return this.deps.db().getSetting<TranscriptCleanup>(LAST_CLEANUP);
  }

  /** Customize › Data. */
  state(): DataState {
    const db = this.deps.db();
    const lastCleanup = this.lastCleanup();
    const lastCompact = db.lastCompact();
    return {
      retention: this.settings(),
      fileBytes: db.fileBytes(),
      freeBytes: db.freeBytes(),
      ...(lastCleanup ? { lastCleanup } : {}),
      cleaning: this.running !== undefined,
      compactPending: db.compactPending(),
      ...(lastCompact ? { lastCompact } : {}),
    };
  }

  /** At the start: the first look is a minute away, then one every hour. */
  start(): void {
    if (this.started || this.deps.stopped()) return;
    this.started = true;
    this.schedule(CLEANUP_START_DELAY_MS);
  }

  stop(): void {
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(ms: number): void {
    this.stop();
    if (this.deps.stopped()) return;
    const timer = this.deps.clock.setTimeout(() => {
      if (this.timer !== timer) return;
      this.timer = undefined;
      void this.cleanUpIfDue().finally(() => {
        if (this.timer === undefined) this.schedule(CLEANUP_CHECK_MS);
      });
    }, ms);
    (timer as { unref?: () => void } | undefined)?.unref?.();
    this.timer = timer;
  }

  /** Whether the daily clean-up is on and a day has passed since the last one (or there hasn't been one). */
  isDue(now = this.now()): boolean {
    if (!this.settings().enabled) return false;
    const last = this.lastCleanup()?.at;
    // A clock set back (or a bad note) doesn't stop it for good.
    return last === undefined || now - last >= DAY_MS || last > now;
  }

  /** The daily clean-up, when it's due. A failure is reported, and the next look tries again. */
  async cleanUpIfDue(): Promise<TranscriptCleanup | undefined> {
    try {
      if (this.deps.stopped() || !this.isDue()) return undefined;
      return await this.cleanUp();
    } catch (error) {
      this.deps.failed(error);
      return undefined;
    }
  }

  /** "Clean up now", or the daily one: with the days set, also when the daily one is off. One at a time. */
  cleanUp(): Promise<TranscriptCleanup> {
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Waits for a clean-up that's running to see that ARIA is quitting: it stops at its next batch. */
  async finish(): Promise<void> {
    this.stop();
    await this.running?.catch(() => undefined);
  }

  private async run(): Promise<TranscriptCleanup> {
    const yieldTurn = this.deps.yieldTurn ?? nextTurn;
    const startedAt = this.now();
    const cutoff = startedAt - this.settings().keepDays * DAY_MS;
    const result: TranscriptCleanup = { at: startedAt, tasks: 0, steps: 0, freeBytes: 0 };
    // Only this marks a task, one clean-up at a time, and only a discard (which deletes the task) takes a mark off.
    const marks = this.deps.db().transcriptPrunes();
    let slice = performance.now();
    for (const listed of this.deps.db().listTasks()) {
      if (performance.now() - slice > SLICE_MS) {
        await yieldTurn();
        slice = performance.now();
      }
      if (this.deps.stopped()) return result;
      const owner = `task:${listed.id}`;
      const mark = marks.get(owner);
      // Cleaned up since it last finished, by a clean-up ARIA quit during: this one carries on, whatever the days are now.
      const resumes = (task: TaskRecord) => mark !== undefined && !mark.complete && finished(task) && mark.at > task.finishedAt;
      // Cleaned up since it last finished, all of it: most old tasks, every day.
      const done = mark?.complete === true && finished(listed) && mark.at > listed.finishedAt;
      if (done || !(resumes(listed) || finishedBefore(listed, cutoff))) continue;
      const db = this.deps.db();
      // Read again after the waits: a task you continued since the list was read is skipped. One you continue while its
      // own steps are being removed loses its old steps all the same; its new run's are newer than the mark, and stay.
      const task = db.getTask(listed.id);
      if (!task) continue;
      let before: number;
      if (resumes(task)) {
        before = mark!.at;
      } else {
        if (!finishedBefore(task, cutoff)) continue;
        // Never cleaned up, or continued since. A task with nothing to remove (a chat) isn't marked, so its session view
        // doesn't say it was cleaned up.
        if (!db.hasPrunedSteps(owner, startedAt)) continue;
        before = startedAt;
        db.markTranscriptPruned(owner, before);
      }
      let removed = 0;
      for (;;) {
        const deleted = this.deps.db().deletePrunedSteps(owner, before, CLEANUP_BATCH);
        removed += deleted;
        if (deleted < CLEANUP_BATCH) {
          this.deps.db().completeTranscriptPrune(owner);
          break;
        }
        await yieldTurn();
        slice = performance.now();
        // Quitting: the store closes soon. What's left goes in the next clean-up (the mark stays, not complete).
        if (this.deps.stopped()) return result;
      }
      if (removed > 0) {
        result.tasks++;
        result.steps += removed;
      }
    }
    const db = this.deps.db();
    result.freeBytes = db.freeBytes();
    // After every clean-up that finishes, removed something or not: one ARIA quit during may have freed the space.
    db.compactAtNextStartIfFree();
    db.setSetting(LAST_CLEANUP, result);
    return result;
  }
}
