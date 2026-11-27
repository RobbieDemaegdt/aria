import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statfsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  Activity,
  ActivityKind,
  ActivitySource,
  CardItem,
  ChatItem,
  DatabaseCompact,
  Memory,
  MemoryScope,
  MemorySource,
  Profile,
  Project,
  PromptVersion,
  Reminder,
  ReminderStatus,
  Routine,
  RoutineKind,
  RoutineStatus,
  RuleOffer,
  TrackerTaskCacheEntry,
  Task,
  TimelineItem,
  TimeRule,
  TimeRuleMatch,
  TimesheetConfidence,
  TimesheetEntry,
  TimesheetEntryState,
  TimesheetMappedBy,
  TimesheetSourceRef,
  TranscriptEntry,
  YourWords,
} from "@aria/protocol";
import { writesPlan } from "@aria/protocol";
import type { TrackerPurgeCounts } from "@aria/protocol";
import { SETTING_TRACKER_WATCHER } from "../trackers/data-id.ts";
import { pathKey } from "../util/paths.ts";
import { Checkpointer, type CheckpointTiming } from "./checkpointer.ts";
import { BASELINE, BASELINE_VERSION, LATEST_VERSION, MIGRATIONS, type Migration } from "./migrations.ts";

/**
 * ARIA's own state (PLAN.md §4.10, §8). Uses the built-in `node:sqlite` (Node 24 and Electron 44's Node 24.22),
 * so there is no native module to rebuild for Electron. Migrations are append-only; `PRAGMA user_version` tracks them.
 */

/** How many cards of a kind ARIA looks through. */
const CARDS_LISTED = 1000;

/** A watch as stored; `data` is checked by the watchers when they read it. */
export interface WatchRow {
  id: number;
  kind: string;
  state: string;
  repoId?: number;
  targetKey: string;
  createdBy: string;
  taskId?: string;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  data: unknown;
}

interface WatchDbRow {
  id: number;
  kind: string;
  state: string;
  repo_id: number | null;
  target_key: string;
  created_by: string;
  task_id: string | null;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
  data_json: string;
}

const toWatchRow = (r: WatchDbRow): WatchRow => {
  let data: unknown;
  try {
    data = JSON.parse(r.data_json);
  } catch {
    data = undefined;
  }
  return {
    id: r.id,
    kind: r.kind,
    state: r.state,
    ...(r.repo_id !== null ? { repoId: r.repo_id } : {}),
    targetKey: r.target_key,
    createdBy: r.created_by,
    ...(r.task_id !== null ? { taskId: r.task_id } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.ended_at !== null ? { endedAt: r.ended_at } : {}),
    data,
  };
};

/** A worker profile as stored; which one is the default is a setting. */
export type StoredProfile = Omit<Profile, "isDefault">;

/** A task as stored: the protocol's Task plus what only the core needs. What it waits for (a question, permission
 * requests, a plan) lives in memory only: the runtime doesn't keep them across a restart. */
export interface TaskRecord extends Omit<Task, "slug" | "question" | "permissions" | "plan" | "budgetShortId" | "costCredits" | "cleanedUp"> {
  /** The commit the task's branch started from, for its diff. */
  baseCommit?: string;
  /** The worktree root the task's worktree was made under; only worktrees inside it are ever removed. */
  worktreeRoot?: string;
  /** The worker's SDK session. */
  sessionId?: string;
  /** Usage in nano AI credits (1e9 = 1 credit). */
  costNano: number;
  /** Whether the worker got its brief (a session can exist without it if ARIA closed right after opening it). */
  briefSent?: boolean;
  /**
   * Messages for the worker that it hasn't got yet (sent while it waited, Continue, Retry), delivered in order when it
   * runs; each one leaves (by its id) only once the session has it, so none is lost to a restart or a failed send, and
   * none is sent twice when a Retry puts a note in front of it meanwhile.
   */
  outbox?: Array<{ id: string; text: string; untrusted?: string }>;
  /**
   * Item 4: someone else's text (a CI log, a review) for the worker, fenced, sent after the rendered brief (and on an
   * outbox entry, `untrusted`, after its text). Never in `brief` or `Task`, so ARIA never reads it and it's never
   * "your words".
   */
  untrustedBrief?: string;
  /** Item 4: the commit a new worktree starts from (a red CI run's), instead of the base branch's tip. */
  startFrom?: string;
  /** D46: the existing branch its worktree goes on (it took over another task's). */
  adoptBranch?: string;
  /** "Always allow this" offers worked out when its commands were decided (the last 30; not in `Task` events). */
  offers?: RuleOffer[];
  /** Your own words to it, from the window (the last 50; "Save as memory" is offered on them; not in `Task` events). */
  yours?: YourWords[];
  /** True when you manually set or cleared `trackerTaskId`, so automatic extraction doesn't overwrite it (Phase 5B). */
  trackerTaskManual?: boolean;
  /** Current execution stretch counter and start time for `activities` tracking (Phase 5B). */
  stretch?: number;
  stretchStartedAt?: number;
  /** Budget cap (in credits) for which the per-task 80% warning notice was already emitted (Phase 9). */
  budgetWarnedAtCredits?: number;
  /** Hidden from the lists after a discard. */
  archived: boolean;
}

interface MemoryRow {
  id: string;
  scope: string;
  repo_id: number | null;
  repo_name: string | null;
  text: string;
  source_json: string | null;
  created_at: number;
  updated_at: number;
}

const toMemory = (r: MemoryRow): Memory => ({
  id: r.id,
  scope: r.scope as MemoryScope,
  ...(r.repo_id !== null ? { repoId: r.repo_id } : {}),
  ...(r.repo_name !== null ? { repoName: r.repo_name } : {}),
  text: r.text,
  ...(r.source_json ? { source: JSON.parse(r.source_json) as MemorySource } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

interface RepoRow {
  id: number;
  name: string;
  path: string;
  host: string | null;
  owner: string | null;
  repo: string | null;
  upstream: string | null;
  default_branch: string | null;
  kind: string | null;
  added_via: string;
  pinned: number;
  hidden: number;
}

const toProject = (r: RepoRow): Project => ({
  id: r.id,
  name: r.name,
  path: r.path,
  ...(r.host ? { host: r.host } : {}),
  ...(r.owner ? { owner: r.owner } : {}),
  ...(r.repo ? { repo: r.repo } : {}),
  ...(r.upstream ? { upstream: r.upstream } : {}),
  ...(r.default_branch ? { defaultBranch: r.default_branch } : {}),
  ...(r.kind === "folder" ? { kind: "folder" as const } : {}),
  addedVia: r.added_via as Project["addedVia"],
  pinned: r.pinned === 1,
  hidden: r.hidden === 1,
});

interface ActivityDbRow {
  id: string;
  source: string;
  kind: string;
  started_at: number;
  ended_at: number;
  repo_id: number | null;
  external_id: string;
  title: string;
  linked_tracker_task_id: string | null;
  linked_tracker_id: string | null;
  manual_link: number;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}

const toActivity = (r: ActivityDbRow): Activity => {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(r.metadata_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
  } catch {
    metadata = {};
  }
  return {
    id: r.id,
    source: r.source as ActivitySource,
    kind: r.kind as ActivityKind,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    ...(r.repo_id !== null ? { repoId: r.repo_id } : {}),
    externalId: r.external_id,
    title: r.title,
    ...(r.linked_tracker_task_id !== null ? { linkedTrackerTaskId: r.linked_tracker_task_id } : {}),
    ...(r.linked_tracker_task_id !== null && r.linked_tracker_id !== null ? { linkedTrackerId: r.linked_tracker_id } : {}),
    ...(r.manual_link === 1 ? { manualLink: true } : {}),
    metadata,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
};

interface TimeRuleDbRow {
  id: string;
  source: string;
  match_json: string;
  tracker_task_id: string;
  tracker_task_title: string | null;
  tracker_id: string | null;
  created_from: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

const toTimeRule = (r: TimeRuleDbRow): TimeRule[] => {
  try {
    const match = JSON.parse(r.match_json) as TimeRuleMatch;
    if (!match || typeof match !== "object" || typeof match.kind !== "string" || typeof match.pattern !== "string") return [];
    const defaultMinutes =
      typeof match.defaultMinutes === "number" && Number.isFinite(match.defaultMinutes) && match.defaultMinutes >= 15
        ? Math.min(480, Math.round(match.defaultMinutes))
        : undefined;
    return [
      {
        id: r.id,
        match: {
          ...match,
          ...(defaultMinutes !== undefined ? { defaultMinutes } : {}),
        },
        trackerTaskId: r.tracker_task_id,
        ...(r.tracker_task_title ? { trackerTaskTitle: r.tracker_task_title } : {}),
        ...(r.tracker_id ? { trackerId: r.tracker_id } : {}),
        ...(defaultMinutes !== undefined ? { defaultMinutes } : {}),
        createdFrom: r.created_from === "correction" ? "correction" : "you",
        enabled: r.enabled === 1,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      },
    ];
  } catch {
    return [];
  }
};

interface TrackerTaskCacheDbRow {
  task_id: string;
  title: string;
  project_id: string | null;
  customer_id: string | null;
  status: string | null;
  last_seen_json: string;
  fetched_at: number;
}

const toTrackerTaskCache = (r: TrackerTaskCacheDbRow): TrackerTaskCacheEntry => {
  let lastSeen: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(r.last_seen_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) lastSeen = parsed as Record<string, unknown>;
  } catch {
    lastSeen = {};
  }
  return {
    taskId: r.task_id,
    title: r.title,
    ...(r.project_id ? { projectId: r.project_id } : {}),
    ...(r.customer_id ? { customerId: r.customer_id } : {}),
    ...(r.status ? { status: r.status } : {}),
    lastSeen,
    fetchedAt: r.fetched_at,
  };
};

interface TimesheetEntryDbRow {
  id: string;
  date: string;
  start_time: string;
  end_time: string;
  minutes: number;
  tracker_task_id: string | null;
  tracker_task_title: string | null;
  tracker_project_id: string | null;
  tracker_customer_id: string | null;
  comment: string;
  sources_json: string;
  mapped_by: string;
  confidence: string;
  uncertainty_reason: string | null;
  state: string;
  tracker_entry_id: string | null;
  error: string | null;
  tracker_id: string | null;
  created_at: number;
  updated_at: number;
}

const toTimesheetEntry = (r: TimesheetEntryDbRow): TimesheetEntry => {
  let sources: TimesheetSourceRef[] = [];
  try {
    const parsed = JSON.parse(r.sources_json) as unknown;
    if (Array.isArray(parsed)) sources = parsed as TimesheetSourceRef[];
  } catch {
    sources = [];
  }
  return {
    id: r.id,
    date: r.date,
    start: r.start_time,
    end: r.end_time,
    minutes: r.minutes,
    ...(r.tracker_task_id ? { trackerTaskId: r.tracker_task_id } : {}),
    ...(r.tracker_id ? { trackerId: r.tracker_id } : {}),
    ...(r.tracker_task_title ? { trackerTaskTitle: r.tracker_task_title } : {}),
    ...(r.tracker_project_id ? { trackerProjectId: r.tracker_project_id } : {}),
    ...(r.tracker_customer_id ? { trackerCustomerId: r.tracker_customer_id } : {}),
    comment: r.comment,
    sources,
    mappedBy: r.mapped_by as TimesheetMappedBy,
    confidence: r.confidence as TimesheetConfidence,
    ...(r.uncertainty_reason ? { uncertaintyReason: r.uncertainty_reason } : {}),
    state: r.state as TimesheetEntryState,
    ...(r.tracker_entry_id ? { trackerEntryId: r.tracker_entry_id } : {}),
    ...(r.error ? { error: r.error } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
};

export type NewProject = Omit<Project, "id" | "pinned" | "hidden">;

/** How long live transcript entries wait to be written together (P5). */
export const TRANSCRIPT_QUEUE_MS = 250;
/** After a write of them failed, how long until it's tried again. */
export const TRANSCRIPT_RETRY_MS = 5_000;
/**
 * The owners with entries queued, in settings while they are: when ARIA stops without writing them (a crash, Windows
 * shutting down), the next start knows whose history isn't all saved.
 */
const QUEUED_OWNERS = "transcripts.queuedOwners";
/** SQLite's own default: a commit that takes the WAL past this many pages checkpoints it. */
const AUTOCHECKPOINT_PAGES = 1000;
/** How long a statement waits for a lock another connection holds before it fails with "database is locked". */
const BUSY_TIMEOUT_MS = 5_000;
/** The steps a clean-up removes from a finished task's transcript (D1); your words, replies, questions and notices stay. */
export const PRUNED_KINDS: ReadonlySet<TranscriptEntry["kind"]> = new Set(["tool", "permission", "reasoning"]);
/** `PRUNED_KINDS` in SQL, but for the step that wrote the task's plan (`writesPlan`): the session view's Plan tab needs it. */
const PRUNED_STEP_SQL = `kind IN (${[...PRUNED_KINDS].map((kind) => `'${kind}'`).join(", ")})
  AND NOT (kind = 'tool' AND instr(COALESCE(json_extract(entry_json, '$.args'), ''), 'plan.md') > 0)`;

/** Whether a clean-up (D1) at `prunedAt` removed this step, so it isn't saved again: one of `PRUNED_KINDS` from before then, but for the plan's. */
export const isPrunedStep = (entry: TranscriptEntry, prunedAt: number | undefined): boolean =>
  prunedAt !== undefined && entry.at < prunedAt && PRUNED_KINDS.has(entry.kind) && !writesPlan(entry);
/** Free space in the file after a clean-up above which the next start compacts it (D1). */
export const COMPACT_FREE_BYTES = 50 * 1024 * 1024;
const MB = 1024 * 1024;

/**
 * The free space the backup before a flagged migration (and before a purge) asks for: the copy (`copyBytes`), plus room
 * for the step's own writes (its WAL, about the rows it rewrites): 10% of the copy, at least 16 MB.
 */
export const backupRoom = (copyBytes: number): number => copyBytes + Math.max(16 * MB, Math.ceil(copyBytes / 10));

/** Bytes free on the drive holding `folder`; undefined when the system can't tell (the copy is tried then). */
const driveFreeBytes = (folder: string): number | undefined => {
  try {
    const { bavail, bsize } = statfsSync(folder);
    return bavail * bsize;
  } catch {
    return undefined;
  }
};

/** Where the backup needs room, for the message: `on C:`, or the folder when the file isn't on a drive letter. */
const backupDrive = (file: string): string => {
  const { root, dir } = path.parse(path.resolve(file));
  return /^[A-Za-z]:[\\/]?$/.test(root) ? `on ${root.slice(0, 2).toUpperCase()}` : `on the drive with ${dir}`;
};

/** SQLite's "database or disk is full" (SQLITE_FULL), or the system's ENOSPC. */
const isDiskFull = (error: unknown): boolean =>
  (error as { code?: unknown } | null | undefined)?.code === "ENOSPC" ||
  /disk is full|SQLITE_FULL|ENOSPC|not enough space on the disk/i.test(error instanceof Error ? error.message : String(error));

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A copy of the database taken before a step that rewrites it: where it goes, and what the notes and the errors call the step. */
interface BackupPlan {
  /** The name a copy that can't take `target` falls back to is `<file>.<label>.<yyyyMMdd-HHmmss>.bak`: `pre-v15`. */
  label: string;
  /** Where the copy goes. */
  target: string;
  /** What it is taken before: `migration 15`, `clearing another tracker's data`. */
  before: string;
  /** The errors: `updating it` (before ...), `update it` (so it didn't ...), `start ARIA again`. */
  doing: string;
  skipped: string;
  retry: string;
}

/** `yyyyMMdd-HHmmss` in local time: names a backup that couldn't take the usual name. */
const backupStamp = (at: Date): string => {
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
};

/** Set when the next start should compact the file; cleared as that start begins it, so a failing one isn't retried every start. */
const COMPACT_PENDING = "store.compactPending";
const LAST_COMPACT = "store.lastCompact";

export interface StoreOptions {
  /** How often the worker checkpoints the WAL (tests). */
  checkpoint?: CheckpointTiming;
  /** Free space after a clean-up above which the next start compacts the file (tests; `COMPACT_FREE_BYTES`). */
  compactFreeBytes?: number;
  /** Stand-ins for what a backup (before a flagged migration, before a purge) asks the system (tests). */
  backup?: BackupHooks;
}

/** What a backup asks the system, replaced in tests (a full disk isn't filled to test it). */
export interface BackupHooks {
  /** Bytes free on the drive holding `folder` (`statfsSync`); undefined when that can't be told. */
  freeBytes?: (folder: string) => number | undefined;
  /** Writes a complete copy of the database to `target` (`VACUUM INTO`). */
  copy?: (target: string) => void;
}

export class Store {
  readonly file: string;
  private readonly db: DatabaseSync;
  /** Statements prepared once (P5): `prepare` parses and plans its SQL again on every call. */
  private readonly statements = new Map<string, StatementSync>();
  /** Transcript entries that came in live and aren't written yet, by owner: the newest copy of each, in the order they first came (P5). */
  private readonly queued = new Map<string, Map<string, TranscriptEntry>>();
  private queueTimer: ReturnType<typeof setTimeout> | undefined;
  /** Whether the last write of queued entries failed, so a failing disk is reported once rather than on every try. */
  private queueFailing = false;
  private closed = false;
  /** An earlier run's owners whose steps were never written, still marked as all saved: that couldn't be undone yet. */
  private unforgotten = new Set<string>();
  private queueErrorReport: ((error: unknown) => void) | undefined;
  /** Failures from before anyone was told about them (at the start), told as soon as someone is. */
  private readonly untold: unknown[] = [];
  /** Checkpoints the WAL off the main thread; none for a database in memory, or after it failed. */
  private checkpointer: Checkpointer | undefined;
  /** Told when the WAL can't be checkpointed in a worker: SQLite does it in the commits again, as before. */
  onCheckpointError: ((error: unknown) => void) | undefined;
  /** What compacting the file did as this store opened, if it did (D1): for the log. */
  readonly compactedAtOpen: DatabaseCompact | undefined;
  /** What the migrations that ran as this store opened said they did (the backup, rows stamped): for the log. */
  readonly migrationNotes: string[] = [];
  private readonly compactFreeBytes: number;
  private readonly backupHooks: BackupHooks;

  /** Told when queued transcript entries couldn't be written. They stay queued and are tried again, except at `close()`. */
  get onQueueError(): ((error: unknown) => void) | undefined {
    return this.queueErrorReport;
  }

  set onQueueError(report: ((error: unknown) => void) | undefined) {
    this.queueErrorReport = report;
    for (const error of this.untold.splice(0)) this.tellQueueError(error);
  }

  constructor(file: string, options: StoreOptions = {}) {
    this.file = file;
    this.compactFreeBytes = options.compactFreeBytes ?? COMPACT_FREE_BYTES;
    this.backupHooks = options.backup ?? {};
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    // The busy timeout is set as it opens, so the first statement waits too: another connection (the checkpoint worker's,
    // or another store's on this file) can hold a lock at that moment, such as the last one to close while it checkpoints.
    this.db = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS });
    try {
      // P5: a commit no longer waits for the disk (about 0.5 ms each). With WAL, `synchronous = NORMAL` can't corrupt the
      // database, and ARIA crashing loses no commit. A power loss (or Windows crashing) can lose the last ones, those
      // Windows hadn't written to disk yet: a task's state, a card, a setting, a session's last steps.
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
      this.migrate();
      this.forgetUnwrittenOwners();
      // Before the checkpoint worker opens its connection, and before the window can ask for anything.
      this.compactedAtOpen = this.compactIfPending();
    } catch (error) {
      // Nothing can use a store that didn't open; don't leave the file locked (Windows can't delete or replace it).
      this.db.close();
      throw error;
    }
    if (file !== ":memory:") this.checkpointInWorker(file, options.checkpoint);
  }

  /**
   * The WAL is checkpointed in a worker, so no commit here stalls on it (checkpointer.ts). If the worker can't start,
   * SQLite goes on checkpointing in the commits, as before.
   */
  private checkpointInWorker(file: string, timing: CheckpointTiming | undefined): void {
    try {
      this.checkpointer = new Checkpointer(
        file,
        { behind: () => this.checkpointBehind(), failed: (error) => this.checkpointFailed(error) },
        timing,
      );
      this.db.exec("PRAGMA wal_autocheckpoint = 0");
    } catch (error) {
      this.checkpointer?.stop();
      this.checkpointer = undefined;
      // Whoever opened the store sets `onCheckpointError` right after.
      queueMicrotask(() => this.tellCheckpointError(error));
    }
  }

  /**
   * Writes that never paused long enough for the worker's checkpoints to catch up: it has copied all but the last
   * pages, which this copies (a few ms), so the next write starts the WAL over instead of making it longer.
   */
  private checkpointBehind(): void {
    if (this.closed) return;
    try {
      this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    } catch {
      // The worker's next checkpoint copies them.
    }
  }

  /** The worker failed or stopped: SQLite checkpoints in the commits again. */
  private checkpointFailed(error: unknown): void {
    this.checkpointer = undefined;
    if (this.closed) return;
    try {
      this.db.exec(`PRAGMA wal_autocheckpoint = ${AUTOCHECKPOINT_PAGES}`);
    } catch {
      // Then the WAL is checkpointed at close, and replayed at the next open if not.
    }
    this.tellCheckpointError(error);
  }

  private tellCheckpointError(error: unknown): void {
    try {
      this.onCheckpointError?.(error);
    } catch {
      // Only a report.
    }
  }

  /**
   * Brings the database to `LATEST_VERSION`. A new one gets the baseline in one
   * step (no backup), then the steps after it. One at version 14 or more is migrated step by step, copied once before the
   * first pending step flagged `backup`. One from before the baseline (1 to 13) is left as it is and refused, with no
   * release named; so is one a newer ARIA wrote.
   */
  private migrate(): void {
    const { user_version: current } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (current > LATEST_VERSION) {
      throw new Error(
        `This database is version ${current}, written by a newer ARIA (this one knows up to version ${LATEST_VERSION}). ` +
          "Update ARIA, or restore a backup from before the update.",
      );
    }
    if (current > 0 && current < BASELINE_VERSION) {
      throw new Error(`This database is version ${current}, and this version of ARIA can't update it.`);
    }
    const existing = current > 0;
    if (!existing) this.runMigration(BASELINE, BASELINE_VERSION, undefined);
    let backedUp = false;
    for (let version = BASELINE_VERSION; version < LATEST_VERSION; version++) {
      if (version < current) continue;
      const step = MIGRATIONS[version - BASELINE_VERSION]!;
      // An existing database is copied once, before the first pending step that rewrites what going back would need:
      // going back means restoring the copy. `room` is what the copy asked for, set for that step only: the one right
      // after the backup.
      const room =
        step.backup && !backedUp && existing && this.file !== ":memory:"
          ? this.backUp({
              label: `pre-v${version + 1}`,
              target: `${this.file}.pre-v${version + 1}.bak`,
              before: `migration ${version + 1}`,
              doing: "updating it",
              skipped: "update it",
              retry: "start ARIA again",
            })
          : undefined;
      if (room !== undefined) backedUp = true;
      this.runMigration(step, version + 1, room);
    }
  }

  /** One step in its own transaction; `version` is the user_version it ends at, `room` what the backup before it asked for. */
  private runMigration(step: Migration, version: number, room: number | undefined): void {
    this.db.exec("BEGIN");
    try {
      step.run(this.db, this.migrationNotes);
      this.db.exec(`PRAGMA user_version = ${version}`);
      this.db.exec("COMMIT");
    } catch (error) {
      // A failed statement can have rolled the transaction back already; a second ROLLBACK would hide the real error.
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      // The step right after the backup is rolled back, so the next start backs up again before it and needs that room
      // again. A later one fails after that step committed: the next start makes no backup, so its error says which step
      // failed, as any other.
      if (room !== undefined && isDiskFull(error)) throw this.noRoomError(room, error, { doing: "updating it", retry: "start ARIA again" });
      throw new Error(`Migration ${version} (${step.name}) failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  /**
   * `VACUUM INTO` copies a consistent database (the WAL's pages included) next to it, as `<file>.<label>.bak` (before a
   * migration: `pre-v15`) or as the plan's own name. The copy goes to a `.tmp` file first and is renamed over the backup
   * only once it's complete, so a copy that was cut off (ARIA killed, a full disk) is never taken for a backup; an
   * unfinished one an earlier start left is removed first. A backup that's already there is replaced: a migration's only
   * runs while the database is still at the version before, so the newest copy of that is the one to keep (after going
   * back to an older build for a while, an older copy would miss that work).
   *
   * A complete copy is a backup whatever its name: when the old backup can't be replaced (open in another program,
   * read-only), the copy takes a name of its own, and stays the `.tmp` if even that fails (`keepBackup`); a note says
   * where it is, and the step goes ahead. Only when no complete copy could be written is the database left as it
   * was, and the step doesn't run (the store doesn't open; a purge is refused): a drive without room (checked first, and a
   * copy that filled it) says how much to free, any other failure what it was. The room asked for is the copy plus
   * `backupRoom`'s margin for the step's own writes, so a step that fills the drive after a good copy is rare. Returns that
   * room.
   */
  private backUp(plan: BackupPlan): number {
    const backup = plan.target;
    const partial = `${backup}.tmp`;
    const replacing = existsSync(backup);
    // What `VACUUM INTO` writes is the database's pages but the free ones; the step's WAL comes on top.
    const room = backupRoom(this.fileBytes() - this.freeBytes());
    let tooFull = false;
    try {
      if (existsSync(partial)) {
        rmSync(partial, { force: true });
        this.migrationNotes.push(`Removed an unfinished backup at ${partial}.`);
      }
      // A copy that can't fit, with the step after it, isn't started: it would only fill the drive.
      const free = (this.backupHooks.freeBytes ?? driveFreeBytes)(path.dirname(this.file));
      if (free !== undefined && free < room) {
        tooFull = true;
        throw new Error(`${free} bytes free, about ${room} needed`);
      }
      if (this.backupHooks.copy) this.backupHooks.copy(partial);
      else this.db.exec(`VACUUM INTO '${partial.replaceAll("'", "''")}'`);
    } catch (error) {
      try {
        rmSync(partial, { force: true });
      } catch {
        // The next start removes it before it copies again.
      }
      if (tooFull || isDiskFull(error)) throw this.noRoomError(room, error, plan);
      throw new Error(
        `ARIA couldn't back up its database before ${plan.doing}, so it didn't ${plan.skipped}; your data hasn't changed. ` +
          `Details: backing it up to ${partial} before ${plan.before} failed: ${messageOf(error)}`,
        { cause: error },
      );
    }
    this.migrationNotes.push(this.keepBackup(partial, plan, replacing));
    return room;
  }

  /** The error when the drive hasn't `room` free for the backup and the step after it. */
  private noRoomError(room: number, cause: unknown, plan: Pick<BackupPlan, "doing" | "retry">): Error {
    return new Error(
      `ARIA needs about ${Math.ceil(room / MB)} MB free ${backupDrive(this.file)} to back up its database before ${plan.doing}. ` +
        `Free some space and ${plan.retry}; your data hasn't changed.`,
      { cause },
    );
  }

  /**
   * Keeps the complete copy at `partial`: as the plan's `target`, else as `<file>.<label>.<yyyyMMdd-HHmmss>.bak`, else where
   * it is (a later start removes a `.tmp` only while the database is still unmigrated, and copies again). Returns the note.
   */
  private keepBackup(partial: string, plan: BackupPlan, replacing: boolean): string {
    const backup = plan.target;
    try {
      renameSync(partial, backup);
      return replacing
        ? `Backed up the database to ${backup} before ${plan.before}, replacing the older backup there.`
        : `Backed up the database to ${backup} before ${plan.before}.`;
    } catch (error) {
      const why = `${backup} couldn't be ${replacing ? "replaced" : "written"}: ${messageOf(error)}`;
      const named = `${this.file}.${plan.label}.${backupStamp(new Date())}.bak`;
      try {
        renameSync(partial, named);
        return `Backed up the database to ${named} before ${plan.before}, since ${why}.`;
      } catch (second) {
        return (
          `Backed up the database to ${partial} before ${plan.before}; it's a complete copy, left under that name since ${why}, ` +
          `and it couldn't be renamed to ${named} either: ${messageOf(second)}.`
        );
      }
    }
  }

  /**
   * D1: after a clean-up left more than `COMPACT_FREE_BYTES` of the file free, the next start gives it back to the disk
   * (VACUUM, then the WAL is emptied): 0.6 s for a copy of a real 175 MB file, 75 MB after. The note is cleared first, so a compact
   * that fails (a full disk) isn't tried again at every start, and the store opens all the same.
   */
  private compactIfPending(): DatabaseCompact | undefined {
    if (this.file === ":memory:" || this.getSetting<unknown>(COMPACT_PENDING) !== true) return undefined;
    try {
      this.setSetting(COMPACT_PENDING, false);
    } catch {
      // Not now, then: a compact the note can't be taken off for would run at every start.
      return undefined;
    }
    const started = performance.now();
    let beforeBytes = 0;
    let error: string | undefined;
    try {
      beforeBytes = this.fileBytes();
      // Free space SQLite reused since the clean-up isn't worth a compact any more.
      if (this.freeBytes() <= this.compactFreeBytes) return undefined;
      this.db.exec("VACUUM");
      // VACUUM writes the whole file through the WAL: this copies it back and empties the WAL file.
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    let afterBytes = beforeBytes;
    try {
      afterBytes = this.fileBytes();
    } catch {
      // The size from before, then.
    }
    const result: DatabaseCompact = { at: Date.now(), beforeBytes, afterBytes, ms: Math.round(performance.now() - started), ...(error ? { error } : {}) };
    try {
      this.setSetting(LAST_COMPACT, result);
    } catch {
      // Only shown in Customize › Data; the log gets it too.
    }
    return result;
  }

  /** The database file's size (D1): its pages, without the WAL. */
  fileBytes(): number {
    const { page_count: pages } = this.stmt("PRAGMA page_count").get() as { page_count: number };
    const { page_size: size } = this.stmt("PRAGMA page_size").get() as { page_size: number };
    return pages * size;
  }

  /** The part of the file that's free pages (D1): SQLite reuses them, and a compact gives them back to the disk. */
  freeBytes(): number {
    const { freelist_count: pages } = this.stmt("PRAGMA freelist_count").get() as { freelist_count: number };
    const { page_size: size } = this.stmt("PRAGMA page_size").get() as { page_size: number };
    return pages * size;
  }

  /** After a clean-up: the next start compacts the file when more than `COMPACT_FREE_BYTES` of it is free. */
  compactAtNextStartIfFree(): boolean {
    const pending = this.freeBytes() > this.compactFreeBytes;
    if (pending) this.setSetting(COMPACT_PENDING, true);
    return pending;
  }

  compactPending(): boolean {
    return this.getSetting<unknown>(COMPACT_PENDING) === true;
  }

  lastCompact(): DatabaseCompact | undefined {
    return this.getSetting<DatabaseCompact>(LAST_COMPACT);
  }

  /** `sql` prepared, once per store: for SQL that is the same on every call. */
  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) this.statements.set(sql, (statement = this.db.prepare(sql)));
    return statement;
  }

  /** Runs `write` in one transaction. */
  private inTransaction(write: () => void): void {
    this.db.exec("BEGIN");
    try {
      write();
      this.db.exec("COMMIT");
    } catch (error) {
      // A full disk or an I/O error has rolled it back already; a ROLLBACK then would throw, and hide why it failed.
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.stmt("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as T) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.stmt("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json").run(
      key,
      JSON.stringify(value),
    );
  }

  /** Oldest first; the newest `limit` items. */
  listTimeline(limit = 1000): TimelineItem[] {
    const rows = this.db
      .prepare(
        "SELECT content_json FROM (SELECT rowid AS r, content_json, created_at FROM timeline ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at, r",
      )
      .all(limit) as Array<{ content_json: string }>;
    return rows.map((r) => JSON.parse(r.content_json) as TimelineItem);
  }

  /** Oldest first; the newest cards of these types, however far back in the timeline they are. */
  listCards<T extends CardItem["cardType"]>(...cardTypes: T[]): Array<Extract<CardItem, { cardType: T }>> {
    const rows = this.db
      .prepare(
        `SELECT content_json FROM timeline
         WHERE kind = 'card' AND json_extract(content_json, '$.cardType') IN (${cardTypes.map(() => "?").join(", ")})
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...cardTypes, CARDS_LISTED) as Array<{ content_json: string }>;
    return rows.reverse().map((r) => JSON.parse(r.content_json) as Extract<CardItem, { cardType: T }>);
  }

  /** Your newest message to ARIA, however far back in the timeline it is. */
  lastUserChat(): ChatItem | undefined {
    const row = this.db
      .prepare(
        `SELECT content_json FROM timeline
         WHERE kind = 'chat' AND json_extract(content_json, '$.role') = 'user'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get() as { content_json: string } | undefined;
    return row ? (JSON.parse(row.content_json) as ChatItem) : undefined;
  }

  upsertTimeline(item: TimelineItem): void {
    this.stmt(
      `INSERT INTO timeline (id, kind, content_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET content_json = excluded.content_json, updated_at = excluded.updated_at`,
    ).run(item.id, item.kind, JSON.stringify(item), item.createdAt, Date.now());
  }

  /** Your messages to ARIA that had a digest in front of them, newest first (for the inspector, PLAN.md §5.3). */
  listSentDigests(limit: number): ChatItem[] {
    const rows = this.db
      .prepare(
        `SELECT content_json FROM timeline
         WHERE kind = 'chat' AND json_extract(content_json, '$.role') = 'user' AND json_extract(content_json, '$.digest') IS NOT NULL
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(limit) as Array<{ content_json: string }>;
    return rows.map((r) => JSON.parse(r.content_json) as ChatItem);
  }

  getTimelineItem(id: string): TimelineItem | undefined {
    const row = this.db.prepare("SELECT content_json FROM timeline WHERE id = ?").get(id) as { content_json: string } | undefined;
    return row ? (JSON.parse(row.content_json) as TimelineItem) : undefined;
  }

  deleteTimelineItem(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM timeline WHERE id = ?").run(id).changes) > 0;
  }

  listRepos(): Project[] {
    const rows = this.db.prepare("SELECT * FROM repos ORDER BY name COLLATE NOCASE, id").all() as unknown as RepoRow[];
    return rows.map(toProject);
  }

  getRepoByPath(repoPath: string): Project | undefined {
    const row = this.db.prepare("SELECT * FROM repos WHERE path_key = ?").get(pathKey(repoPath)) as unknown as RepoRow | undefined;
    return row ? toProject(row) : undefined;
  }

  /** Inserts or refreshes a repo by folder; keeps the first path spelling, the user's pinned/hidden/sort choices (unless explicitly re-added) and how it was added. */
  upsertRepo(project: NewProject): Project {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO repos (name, path, path_key, host, owner, repo, upstream, default_branch, kind, added_via, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (path_key) DO UPDATE SET name = excluded.name, host = excluded.host, owner = excluded.owner, repo = excluded.repo,
           upstream = excluded.upstream, default_branch = excluded.default_branch, kind = excluded.kind,
           hidden = CASE WHEN excluded.added_via = 'scan' THEN repos.hidden ELSE 0 END,
           updated_at = excluded.updated_at`,
      )
      .run(
        project.name,
        project.path,
        pathKey(project.path),
        project.host ?? null,
        project.owner ?? null,
        project.repo ?? null,
        project.upstream ?? null,
        project.defaultBranch ?? null,
        project.kind === "folder" ? "folder" : null,
        project.addedVia,
        now,
        now,
      );
    return this.getRepoByPath(project.path)!;
  }

  setRepoHidden(id: number, hidden: boolean): Project | undefined {
    const now = Date.now();
    this.db.prepare("UPDATE repos SET hidden = ?, updated_at = ? WHERE id = ?").run(hidden ? 1 : 0, now, id);
    return this.getRepo(id);
  }

  getRepo(id: number): Project | undefined {
    const row = this.db.prepare("SELECT * FROM repos WHERE id = ?").get(id) as unknown as RepoRow | undefined;
    return row ? toProject(row) : undefined;
  }

  // ── profiles ──────────────────────────────────────────────────────────────────────────────────────────────────

  listProfiles(): StoredProfile[] {
    const rows = this.db.prepare("SELECT data_json FROM profiles ORDER BY sort_order, name_key").all() as Array<{ data_json: string }>;
    return rows.map((r) => JSON.parse(r.data_json) as StoredProfile);
  }

  /** Inserts or replaces a profile; throws if another profile already has that name (any letter case). */
  saveProfile(profile: StoredProfile, sortOrder = 0): void {
    const now = Date.now();
    const clash = this.db.prepare("SELECT id FROM profiles WHERE name_key = ? AND id <> ?").get(profile.name.toLowerCase(), profile.id) as { id: string } | undefined;
    if (clash) throw new Error(`There's already a profile called ${profile.name}.`);
    this.db
      .prepare(
        `INSERT INTO profiles (id, name_key, sort_order, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name_key = excluded.name_key, data_json = excluded.data_json, updated_at = excluded.updated_at`,
      )
      .run(profile.id, profile.name.toLowerCase(), sortOrder, JSON.stringify(profile), now, now);
  }

  deleteProfile(id: string): void {
    this.db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
  }

  // ── tasks ─────────────────────────────────────────────────────────────────────────────────────────────────────

  saveTask(task: TaskRecord): void {
    this.stmt(
      `INSERT INTO tasks (id, repo_id, state, archived, created_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET state = excluded.state, archived = excluded.archived, updated_at = excluded.updated_at,
         data_json = excluded.data_json`,
    ).run(task.id, task.repoId, task.state, task.archived ? 1 : 0, task.createdAt, task.updatedAt, JSON.stringify(task));
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.stmt("SELECT data_json FROM tasks WHERE id = ?").get(id) as { data_json: string } | undefined;
    return row ? (JSON.parse(row.data_json) as TaskRecord) : undefined;
  }

  /** Oldest first. */
  listTasks({ includeArchived = false }: { includeArchived?: boolean } = {}): TaskRecord[] {
    const rows = this.db
      .prepare(`SELECT data_json FROM tasks ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY created_at, rowid`)
      .all() as Array<{ data_json: string }>;
    return rows.map((r) => JSON.parse(r.data_json) as TaskRecord);
  }

  // ── memories (D23) ────────────────────────────────────────────────────────────────────────────────────────────

  /** Newest first, with the project's name for project notes. */
  listMemories(): Memory[] {
    const rows = this.db
      .prepare("SELECT m.*, r.name AS repo_name FROM memories m LEFT JOIN repos r ON r.id = m.repo_id ORDER BY m.created_at DESC, m.rowid DESC")
      .all() as unknown as MemoryRow[];
    return rows.map(toMemory);
  }

  getMemory(id: string): Memory | undefined {
    const row = this.db.prepare("SELECT m.*, r.name AS repo_name FROM memories m LEFT JOIN repos r ON r.id = m.repo_id WHERE m.id = ?").get(id) as unknown as MemoryRow | undefined;
    return row ? toMemory(row) : undefined;
  }

  /** Inserts or updates a note by id (an update keeps when it was made, and updates source_json when provided). */
  saveMemory(memory: { id: string; scope: MemoryScope; repoId?: number | undefined; text: string; source?: MemorySource | undefined }): Memory {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO memories (id, scope, repo_id, text, source_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET scope = excluded.scope, repo_id = excluded.repo_id, text = excluded.text,
           source_json = COALESCE(excluded.source_json, memories.source_json), updated_at = excluded.updated_at`,
      )
      .run(memory.id, memory.scope, memory.scope === "project" ? (memory.repoId ?? null) : null, memory.text, memory.source ? JSON.stringify(memory.source) : null, now, now);
    return this.getMemory(memory.id)!;
  }

  deleteMemory(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes) > 0;
  }

  // ── watches (Phase 4) ─────────────────────────────────────────────────────────────────────────────────────────

  /** A new watch; returns its id. Throws when another active watch has the same target_key. */
  insertWatch(row: Omit<WatchRow, "id">): number {
    const result = this.db
      .prepare(
        `INSERT INTO watches (kind, state, repo_id, target_key, created_by, task_id, created_at, updated_at, ended_at, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.kind, row.state, row.repoId ?? null, row.targetKey, row.createdBy, row.taskId ?? null, row.createdAt, row.updatedAt, row.endedAt ?? null, JSON.stringify(row.data));
    return Number(result.lastInsertRowid);
  }

  /** Writes a watch as a whole: its state and everything a poll read go together (one statement). */
  saveWatch(row: WatchRow): void {
    this.db
      .prepare(
        `UPDATE watches SET kind = ?, state = ?, repo_id = ?, target_key = ?, created_by = ?, task_id = ?, updated_at = ?, ended_at = ?, data_json = ?
         WHERE id = ?`,
      )
      .run(row.kind, row.state, row.repoId ?? null, row.targetKey, row.createdBy, row.taskId ?? null, row.updatedAt, row.endedAt ?? null, JSON.stringify(row.data), row.id);
  }

  getWatch(id: number): WatchRow | undefined {
    const row = this.db.prepare("SELECT * FROM watches WHERE id = ?").get(id) as unknown as WatchDbRow | undefined;
    return row ? toWatchRow(row) : undefined;
  }

  /** Newest first. */
  listWatches({ state }: { state?: string } = {}): WatchRow[] {
    const rows = (state ? this.db.prepare("SELECT * FROM watches WHERE state = ? ORDER BY id DESC").all(state) : this.db.prepare("SELECT * FROM watches ORDER BY id DESC").all()) as unknown as WatchDbRow[];
    return rows.map(toWatchRow);
  }

  activeWatchByKey(targetKey: string): WatchRow | undefined {
    const row = this.db.prepare("SELECT * FROM watches WHERE target_key = ? AND state = 'active'").get(targetKey) as unknown as WatchDbRow | undefined;
    return row ? toWatchRow(row) : undefined;
  }

  /** Deletes watches that ended before `before`; returns how many. */
  pruneWatches(before: number): number {
    return Number(this.db.prepare("DELETE FROM watches WHERE state <> 'active' AND ended_at IS NOT NULL AND ended_at < ?").run(before).changes);
  }

  // ── prompt versions ───────────────────────────────────────────────────────────────────────────────────────────

  /** Newest first. */
  listPromptVersions(name: string): PromptVersion[] {
    const rows = this.db.prepare("SELECT version, text, note, created_at FROM prompt_versions WHERE name = ? ORDER BY version DESC").all(name) as Array<{
      version: number;
      text: string;
      note: string | null;
      created_at: number;
    }>;
    return rows.map((r) => ({ version: r.version, text: r.text, ...(r.note ? { note: r.note } : {}), createdAt: r.created_at }));
  }

  latestPrompt(name: string): PromptVersion | undefined {
    const row = this.db.prepare("SELECT version, text, note, created_at FROM prompt_versions WHERE name = ? ORDER BY version DESC LIMIT 1").get(name) as
      | { version: number; text: string; note: string | null; created_at: number }
      | undefined;
    return row ? { version: row.version, text: row.text, ...(row.note ? { note: row.note } : {}), createdAt: row.created_at } : undefined;
  }

  addPromptVersion(name: string, text: string, note?: string): PromptVersion {
    const createdAt = Date.now();
    const { next } = this.db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS next FROM prompt_versions WHERE name = ?").get(name) as { next: number };
    this.db.prepare("INSERT INTO prompt_versions (name, version, text, note, created_at) VALUES (?, ?, ?, ?, ?)").run(name, next, text, note ?? null, createdAt);
    return { version: next, text, ...(note ? { note } : {}), createdAt };
  }

  // ── activities, time_rules and tracker_tasks_cache (Phase 5B, PLAN.md §4.14, §8) ──────────────────────────────

  /**
   * Inserts or updates an activity by `(source, external_id)`. If the existing row has `manual_link = 1` and the caller
   * didn't pass `manualLink: true`, the user's manual `linked_tracker_task_id` (even when `NULL` because they cleared it)
   * is preserved across automatic collector re-scans.
   */
  upsertActivity(input: {
    source: ActivitySource;
    kind: ActivityKind;
    startedAt: number;
    endedAt: number;
    repoId?: number;
    externalId: string;
    title: string;
    linkedTrackerTaskId?: string;
    /** The tracker `linkedTrackerTaskId` belongs to; without a task it is not stored. */
    linkedTrackerId?: string;
    manualLink?: boolean;
    metadata?: Record<string, unknown>;
  }): Activity {
    const now = Date.now();
    const id = randomUUID();
    const manual = input.manualLink === true ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO activities (id, source, kind, started_at, ended_at, repo_id, external_id, title, linked_tracker_task_id, linked_tracker_id, manual_link, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source, external_id) DO UPDATE SET
           kind = excluded.kind,
           started_at = MIN(activities.started_at, excluded.started_at),
           ended_at = MAX(activities.ended_at, excluded.ended_at),
           repo_id = COALESCE(excluded.repo_id, activities.repo_id),
           title = excluded.title,
           linked_tracker_task_id = CASE
             WHEN excluded.manual_link = 1 THEN excluded.linked_tracker_task_id
             WHEN activities.manual_link = 1 THEN activities.linked_tracker_task_id
             ELSE COALESCE(excluded.linked_tracker_task_id, activities.linked_tracker_task_id)
           END,
           linked_tracker_id = CASE
             WHEN excluded.manual_link = 1 THEN excluded.linked_tracker_id
             WHEN activities.manual_link = 1 THEN activities.linked_tracker_id
             WHEN excluded.linked_tracker_task_id IS NOT NULL THEN excluded.linked_tracker_id
             ELSE activities.linked_tracker_id
           END,
           manual_link = CASE
             WHEN excluded.manual_link = 1 OR activities.manual_link = 1 THEN 1
             ELSE 0
           END,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.source,
        input.kind,
        input.startedAt,
        Math.max(input.startedAt, input.endedAt),
        input.repoId ?? null,
        input.externalId,
        input.title,
        input.linkedTrackerTaskId ?? null,
        input.linkedTrackerTaskId !== undefined ? (input.linkedTrackerId ?? null) : null,
        manual,
        JSON.stringify(input.metadata ?? {}),
        now,
        now,
      );
    const row = this.db
      .prepare("SELECT * FROM activities WHERE source = ? AND external_id = ?")
      .get(input.source, input.externalId) as unknown as ActivityDbRow;
    return toActivity(row);
  }

  /**
   * Sets or clears `linked_tracker_task_id` (with `manual_link = 1`) on all `aria` stretch activities of `taskId`;
   * `trackerId` is the tracker the task is of (cleared with the task).
   */
  setTaskActivitiesTracker(taskId: string, trackerTaskId: string | undefined, trackerId: string | undefined): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE activities SET linked_tracker_task_id = ?, linked_tracker_id = ?, manual_link = 1, updated_at = ?
         WHERE source = 'aria' AND (external_id = ? OR external_id LIKE ?)`,
      )
      .run(trackerTaskId ?? null, trackerTaskId !== undefined ? (trackerId ?? null) : null, now, `task:${taskId}`, `task:${taskId}:run:%`);
  }

  deleteActivity(source: ActivitySource, externalId: string): boolean {
    return Number(this.db.prepare("DELETE FROM activities WHERE source = ? AND external_id = ?").run(source, externalId).changes) > 0;
  }

  /** The external ID of the newest activity (by start time) of a source, if there is one. */
  newestActivityExternalId(source: ActivitySource): string | undefined {
    const row = this.db.prepare("SELECT external_id FROM activities WHERE source = ? ORDER BY started_at DESC, created_at DESC LIMIT 1").get(source) as
      | { external_id: string }
      | undefined;
    return row?.external_id;
  }

  /**
   * Lists activities overlapping `[since, until]` (`ended_at >= since AND started_at <= until`), ordered by `started_at`
   * ascending (chronological order for building a day's timeline).
   */
  listActivities(filter: { since?: number; until?: number; repoId?: number; source?: ActivitySource; limit?: number } = {}): Activity[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.since !== undefined) {
      clauses.push("ended_at >= ?");
      params.push(filter.since);
    }
    if (filter.until !== undefined) {
      clauses.push("started_at <= ?");
      params.push(filter.until);
    }
    if (filter.repoId !== undefined) {
      clauses.push("repo_id = ?");
      params.push(filter.repoId);
    }
    if (filter.source !== undefined) {
      clauses.push("source = ?");
      params.push(filter.source);
    }
    const limit = Math.min(Math.max(1, filter.limit ?? 200), 1000);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM activities ${where} ORDER BY started_at ASC, created_at ASC LIMIT ?`)
      .all(...params, limit) as unknown as ActivityDbRow[];
    return rows.map(toActivity);
  }

  /**
   * The rules in use with this tracker: its own, and the ones that name no task (a rule of minutes only isn't a
   * tracker's). The rules of another tracker are dormant: kept, not listed.
   */
  listTimeRules(trackerId: string): TimeRule[] {
    const rows = this.db
      .prepare("SELECT * FROM time_rules WHERE tracker_task_id = '' OR tracker_id = ? ORDER BY created_at DESC, rowid DESC")
      .all(trackerId) as unknown as TimeRuleDbRow[];
    return rows.flatMap(toTimeRule);
  }

  getTimeRule(id: string): TimeRule | undefined {
    const row = this.db.prepare("SELECT * FROM time_rules WHERE id = ?").get(id) as unknown as TimeRuleDbRow | undefined;
    return row ? toTimeRule(row)[0] : undefined;
  }

  /** `trackerId` is the tracker the rule's task is of; a rule that names no task belongs to none and keeps no id. */
  saveTimeRule(
    trackerId: string,
    rule: {
      id: string;
      match: TimeRuleMatch;
      trackerTaskId: string;
      trackerTaskTitle?: string;
      defaultMinutes?: number;
      createdFrom: "you" | "correction";
      enabled: boolean;
    },
  ): TimeRule {
    const now = Date.now();
    const matchToStore: TimeRuleMatch = {
      ...rule.match,
      ...(rule.defaultMinutes !== undefined ? { defaultMinutes: rule.defaultMinutes } : {}),
    };
    if (rule.defaultMinutes === undefined && rule.match.defaultMinutes === undefined) {
      delete matchToStore.defaultMinutes;
    }
    this.db
      .prepare(
        `INSERT INTO time_rules (id, source, match_json, tracker_task_id, tracker_task_title, tracker_id, created_from, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           source = excluded.source,
           match_json = excluded.match_json,
           tracker_task_id = excluded.tracker_task_id,
           tracker_task_title = excluded.tracker_task_title,
           tracker_id = excluded.tracker_id,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(
        rule.id,
        rule.match.kind,
        JSON.stringify(matchToStore),
        rule.trackerTaskId,
        rule.trackerTaskTitle ?? null,
        rule.trackerTaskId ? trackerId : null,
        rule.createdFrom,
        rule.enabled ? 1 : 0,
        now,
        now,
      );
    return this.getTimeRule(rule.id)!;
  }

  deleteTimeRule(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM time_rules WHERE id = ?").run(id).changes) > 0;
  }

  /**
   * The tasks cache is one tracker's at a time: every call names the tracker whose tasks it holds, so two
   * trackers' tasks with the same ID are two rows, and one tracker's never answer for the other's.
   */
  upsertTrackerTaskCache(
    trackerId: string,
    entry: {
      taskId: string;
      title: string;
      projectId?: string;
      customerId?: string;
      status?: string;
      lastSeen?: Record<string, unknown>;
      fetchedAt?: number;
    },
  ): TrackerTaskCacheEntry {
    const fetchedAt = entry.fetchedAt ?? Date.now();
    const hasLastSeen = entry.lastSeen !== undefined && Object.keys(entry.lastSeen).length > 0;
    const lastSeenJson = hasLastSeen ? JSON.stringify(entry.lastSeen) : "{}";
    this.db
      .prepare(
        `INSERT INTO tracker_tasks_cache (tracker_id, task_id, title, project_id, customer_id, status, last_seen_json, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tracker_id, task_id) DO UPDATE SET
           title = excluded.title,
           project_id = COALESCE(excluded.project_id, tracker_tasks_cache.project_id),
           customer_id = COALESCE(excluded.customer_id, tracker_tasks_cache.customer_id),
           status = COALESCE(excluded.status, tracker_tasks_cache.status),
           last_seen_json = CASE
             WHEN ? = 1 THEN excluded.last_seen_json
             ELSE tracker_tasks_cache.last_seen_json
           END,
           fetched_at = excluded.fetched_at`,
      )
      .run(
        trackerId,
        entry.taskId,
        entry.title,
        entry.projectId ?? null,
        entry.customerId ?? null,
        entry.status ?? null,
        lastSeenJson,
        fetchedAt,
        hasLastSeen ? 1 : 0,
      );
    return this.getTrackerTaskCache(trackerId, entry.taskId)!;
  }

  getTrackerTaskCache(trackerId: string, taskId: string): TrackerTaskCacheEntry | undefined {
    const row = this.db
      .prepare("SELECT * FROM tracker_tasks_cache WHERE tracker_id = ? AND task_id = ?")
      .get(trackerId, taskId) as unknown as TrackerTaskCacheDbRow | undefined;
    return row ? toTrackerTaskCache(row) : undefined;
  }

  listTrackerTaskCache(trackerId: string): TrackerTaskCacheEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM tracker_tasks_cache WHERE tracker_id = ? ORDER BY fetched_at DESC, task_id ASC")
      .all(trackerId) as unknown as TrackerTaskCacheDbRow[];
    return rows.map(toTrackerTaskCache);
  }

  /**
   * What the store holds that isn't `keepTrackerId`'s: cached tasks (the rows of no known tracker, `''`, included),
   * mapping rules that name a task, time entries with a task, registered entries and activities linked to a task. A rule
   * of minutes only isn't a tracker's, so it isn't counted (nor cleared). What `dataTrackerId` names owns it.
   */
  trackerPurgeCounts(keepTrackerId: string): TrackerPurgeCounts {
    const count = (sql: string): number => Number((this.db.prepare(sql).get(keepTrackerId) as { n: number | bigint }).n);
    return {
      cachedTasks: count("SELECT COUNT(*) AS n FROM tracker_tasks_cache WHERE tracker_id <> ?"),
      rules: count("SELECT COUNT(*) AS n FROM time_rules WHERE tracker_task_id <> '' AND tracker_id IS NOT ?"),
      draftRowsWithTasks: count("SELECT COUNT(*) AS n FROM timesheet_entries WHERE tracker_id IS NOT NULL AND tracker_id <> ? AND tracker_entry_id IS NULL"),
      registeredRows: count("SELECT COUNT(*) AS n FROM timesheet_entries WHERE tracker_id IS NOT NULL AND tracker_id <> ? AND tracker_entry_id IS NOT NULL"),
      linkedActivities: count("SELECT COUNT(*) AS n FROM activities WHERE linked_tracker_id IS NOT NULL AND linked_tracker_id <> ?"),
    };
  }

  /**
   * The ids of the other trackers whose data the store holds, in order; `''` stands for data that doesn't say
   * whose it is (the cache rows migration 15 found no evidence for, and rules with a task and no id).
   */
  otherTrackerIds(keepTrackerId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT tracker_id AS id FROM tracker_tasks_cache WHERE tracker_id <> ?1
         UNION SELECT '' FROM time_rules WHERE tracker_task_id <> '' AND tracker_id IS NULL
         UNION SELECT tracker_id FROM time_rules WHERE tracker_task_id <> '' AND tracker_id IS NOT NULL AND tracker_id <> ?1
         UNION SELECT tracker_id FROM timesheet_entries WHERE tracker_id IS NOT NULL AND tracker_id <> ?1
         UNION SELECT linked_tracker_id FROM activities WHERE linked_tracker_id IS NOT NULL AND linked_tracker_id <> ?1
         ORDER BY id`,
      )
      .all(keepTrackerId) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /**
   * Clears every other tracker's data, in one transaction, after a backup of the whole database
   * (`<file>.pre-purge.<yyyyMMdd-HHmmss>.bak`, the same room check and failure handling as the one before a migration):
   * their cached tasks; their rules; the task, project and customer of their draft rows (the rows stay, with their times
   * and comments); the link of their activities. Registered entries stay as history. The watcher's state goes when it is
   * another tracker's. A backup that can't be made (no room) throws before anything is changed. Returns what was cleared.
   */
  purgeTrackerData(keepTrackerId: string): TrackerPurgeCounts {
    const counts = this.trackerPurgeCounts(keepTrackerId);
    if (this.file !== ":memory:") {
      this.backUp({
        label: "pre-purge",
        target: `${this.file}.pre-purge.${backupStamp(new Date())}.bak`,
        before: "clearing another tracker's data",
        doing: "clearing another tracker's data",
        skipped: "clear it",
        retry: "try again",
      });
    }
    this.inTransaction(() => {
      this.db.prepare("DELETE FROM tracker_tasks_cache WHERE tracker_id <> ?").run(keepTrackerId);
      this.db.prepare("DELETE FROM time_rules WHERE tracker_task_id <> '' AND tracker_id IS NOT ?").run(keepTrackerId);
      this.db
        .prepare(
          `UPDATE timesheet_entries SET tracker_task_id = NULL, tracker_task_title = NULL, tracker_project_id = NULL,
             tracker_customer_id = NULL, tracker_id = NULL
           WHERE tracker_id IS NOT NULL AND tracker_id <> ? AND tracker_entry_id IS NULL`,
        )
        .run(keepTrackerId);
      this.db
        .prepare("UPDATE activities SET linked_tracker_task_id = NULL, linked_tracker_id = NULL WHERE linked_tracker_id IS NOT NULL AND linked_tracker_id <> ?")
        .run(keepTrackerId);
      const state = this.getSetting<{ trackerId?: unknown }>(SETTING_TRACKER_WATCHER);
      if (state && typeof state === "object" && typeof state.trackerId === "string" && state.trackerId !== keepTrackerId) {
        this.db.prepare("DELETE FROM settings WHERE key = ?").run(SETTING_TRACKER_WATCHER);
      }
    });
    return counts;
  }

  // ── timesheet_entries (Phase 5C, PLAN.md §4.14, §8) ───────────────────────────────────────────────────────────

  listTimesheetEntries(date: string): TimesheetEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM timesheet_entries WHERE date = ? ORDER BY start_time ASC, created_at ASC")
      .all(date) as unknown as TimesheetEntryDbRow[];
    return rows.map(toTimesheetEntry);
  }

  getTimesheetEntry(id: string): TimesheetEntry | undefined {
    const row = this.db
      .prepare("SELECT * FROM timesheet_entries WHERE id = ?")
      .get(id) as unknown as TimesheetEntryDbRow | undefined;
    return row ? toTimesheetEntry(row) : undefined;
  }

  saveTimesheetEntry(entry: TimesheetEntry): TimesheetEntry {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO timesheet_entries (
           id, date, start_time, end_time, minutes, tracker_task_id, tracker_task_title, tracker_project_id,
           tracker_customer_id, comment, sources_json, mapped_by, confidence, uncertainty_reason, state,
           tracker_entry_id, error, tracker_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           date = excluded.date,
           start_time = excluded.start_time,
           end_time = excluded.end_time,
           minutes = excluded.minutes,
           tracker_task_id = excluded.tracker_task_id,
           tracker_task_title = excluded.tracker_task_title,
           tracker_project_id = excluded.tracker_project_id,
           tracker_customer_id = excluded.tracker_customer_id,
           comment = excluded.comment,
           sources_json = excluded.sources_json,
           mapped_by = excluded.mapped_by,
           confidence = excluded.confidence,
           uncertainty_reason = excluded.uncertainty_reason,
           state = excluded.state,
           tracker_entry_id = excluded.tracker_entry_id,
           error = excluded.error,
           tracker_id = excluded.tracker_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        entry.id,
        entry.date,
        entry.start,
        entry.end,
        entry.minutes,
        entry.trackerTaskId ?? null,
        entry.trackerTaskTitle ?? null,
        entry.trackerProjectId ?? null,
        entry.trackerCustomerId ?? null,
        entry.comment,
        JSON.stringify(entry.sources ?? []),
        entry.mappedBy,
        entry.confidence,
        entry.uncertaintyReason ?? null,
        entry.state,
        entry.trackerEntryId ?? null,
        entry.error ?? null,
        // Only a row that has a task or a registered entry belongs to a tracker.
        entry.trackerTaskId || entry.trackerEntryId ? (entry.trackerId ?? null) : null,
        entry.createdAt,
        now,
      );
    return this.getTimesheetEntry(entry.id)!;
  }

  /**
   * Atomically replaces all entries for `date` with `entries` (after plain-code checks have merged preserved user-edited
   * and submitted rows with newly generated draft rows).
   */
  replaceTimesheetEntriesForDate(date: string, entries: readonly TimesheetEntry[]): TimesheetEntry[] {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM timesheet_entries WHERE date = ?").run(date);
      for (const entry of entries) {
        this.saveTimesheetEntry(entry);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.listTimesheetEntries(date);
  }

  deleteTimesheetEntry(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM timesheet_entries WHERE id = ?").run(id).changes) > 0;
  }

  // ── session_transcripts (Phase 6A, PLAN.md §5.2, §10 Phase 6A) ────────────────────────────────────────────────

  /**
   * Upserts transcript entries for `ownerId` (`"task:<id>"` or `"conductor"`) now, keeping each entry's initial sequence
   * order. The owner's queued entries are written first: they came first.
   */
  upsertTranscriptEntries(ownerId: string, entries: readonly TranscriptEntry[]): void {
    if (entries.length === 0) return;
    this.writeQueued([ownerId]);
    this.inTransaction(() => this.writeTranscriptEntries(ownerId, entries));
  }

  /**
   * Transcript entries that come in live (P5): each event was its own transaction. They're written together
   * `TRANSCRIPT_QUEUE_MS` later, on `close()`, and before anything reads or replaces this owner's entries, with the same
   * result as writing each as it came. If ARIA stops without writing them, the next start marks the owner as not all
   * saved, so its history is checked against its session again (see `forgetUnwrittenOwners`).
   */
  queueTranscriptEntries(ownerId: string, entries: readonly TranscriptEntry[]): void {
    if (entries.length === 0) return;
    if (this.closed) throw new Error("The store is closed.");
    let owner = this.queued.get(ownerId);
    if (!owner) {
      this.queued.set(ownerId, (owner = new Map()));
      try {
        this.setSetting(QUEUED_OWNERS, this.noted(this.queued.keys()));
      } catch (error) {
        // The entries are queued all the same; the write of them will most likely fail too, and say so.
        this.queueFailed(error);
      }
    }
    // A step that comes again (a tool call that finished) keeps the place it first came in, as it does in the table.
    for (const entry of entries) owner.set(entry.id, entry);
    this.armQueue(TRANSCRIPT_QUEUE_MS);
  }

  private armQueue(ms: number): void {
    if (this.queueTimer) return;
    this.queueTimer = setTimeout(() => this.writeQueuedNow(), ms);
    this.queueTimer.unref?.();
  }

  /** The queue's own write: nothing waits on it, so a failure is reported, and it's tried again a little later. */
  private writeQueuedNow(): void {
    this.queueTimer = undefined;
    try {
      this.writeQueued();
    } catch (error) {
      this.queueFailed(error);
      this.armQueue(TRANSCRIPT_RETRY_MS);
    }
  }

  /** Writes the queued entries of `owners` (all by default) in one transaction, with the note of whose are queued. */
  private writeQueued(owners: readonly string[] = [...this.queued.keys()]): void {
    const due = owners.filter((owner) => this.queued.has(owner));
    if (due.length === 0) return;
    this.inTransaction(() => {
      for (const owner of due) this.writeTranscriptEntries(owner, this.queued.get(owner)!.values());
      this.setSetting(QUEUED_OWNERS, this.noted([...this.queued.keys()].filter((owner) => !due.includes(owner))));
    });
    for (const owner of due) this.queued.delete(owner);
    this.queueFailing = false;
  }

  /** Before a read: it sees what's queued, or, when that can't be written, still what's saved (as before P5). */
  private writeQueuedBeforeRead(owners?: readonly string[]): void {
    try {
      this.writeQueued(owners);
    } catch (error) {
      this.queueFailed(error);
    }
  }

  /** Reported once until a write works again, so a failing disk doesn't fill the log. */
  private queueFailed(error: unknown): void {
    if (this.queueFailing) return;
    this.queueFailing = true;
    this.tellQueueError(error);
  }

  private tellQueueError(error: unknown): void {
    if (!this.queueErrorReport) {
      this.untold.push(error);
      return;
    }
    try {
      this.queueErrorReport(error);
    } catch {
      // Only a report.
    }
  }

  /** The note of whose entries aren't all saved: `owners`, and an earlier run's still to be taken off the saved list. */
  private noted(owners: Iterable<string>): string[] {
    return [...new Set([...this.unforgotten, ...owners])];
  }

  /**
   * At the start: owners whose queued entries were never written (ARIA stopped without closing the store) aren't all
   * saved, so they're no longer marked as such. Opening the task's session, cleaning it up or a search checks its
   * history against what's saved again, and writes what's missing. If that can't be written now, they count as not all
   * saved in this run anyway, and stay in the note for the next start to try again.
   */
  private forgetUnwrittenOwners(): void {
    const owners = this.getSetting<unknown>(QUEUED_OWNERS);
    if (!Array.isArray(owners) || owners.length === 0) return;
    this.unforgotten = new Set(owners.filter((owner): owner is string => typeof owner === "string"));
    try {
      this.inTransaction(() => {
        const saved = this.backfilledTranscriptOwners();
        for (const owner of this.unforgotten) saved.delete(owner);
        this.setSetting("search.backfilledOwners", [...saved]);
        this.setSetting(QUEUED_OWNERS, []);
      });
      this.unforgotten.clear();
    } catch (error) {
      this.tellQueueError(error);
    }
  }

  /** Inside a transaction: a new entry goes after the owner's last one, and one that's there already keeps its place. */
  private writeTranscriptEntries(ownerId: string, entries: Iterable<TranscriptEntry>): void {
    const last = this.stmt("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM session_transcripts WHERE owner_id = ?").get(ownerId) as { max_seq: number };
    let seq = last.max_seq;
    const upsert = this.stmt(
      `INSERT INTO session_transcripts (owner_id, seq, entry_id, at, kind, search_text, entry_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_id, entry_id) DO UPDATE SET
         at = excluded.at,
         kind = excluded.kind,
         search_text = excluded.search_text,
         entry_json = excluded.entry_json`,
    );
    const pruned = this.transcriptPrunedAt(ownerId);
    for (const entry of entries) {
      // D1: a cleaned-up task's old steps never come back from its session (opening it, cleaning it up, a reconnect);
      // the steps of a run after the clean-up are saved as usual.
      if (isPrunedStep(entry, pruned)) continue;
      upsert.run(ownerId, ++seq, entry.id, entry.at, entry.kind, transcriptEntrySearchText(entry), JSON.stringify(entry));
    }
  }

  /** When `ownerId`'s old tool calls, permission lines and reasoning were cleaned up (D1), if they were. */
  transcriptPrunedAt(ownerId: string): number | undefined {
    const row = this.stmt("SELECT pruned_at FROM transcript_pruned WHERE owner_id = ?").get(ownerId) as { pruned_at: number } | undefined;
    return row?.pruned_at;
  }

  /**
   * D1: from now on, steps of the pruned kinds from before `at` aren't saved for `ownerId`. Marked before they're
   * deleted (`deletePrunedSteps`, in batches), so nothing writes them back in between.
   */
  markTranscriptPruned(ownerId: string, at: number): void {
    this.stmt(
      "INSERT INTO transcript_pruned (owner_id, pruned_at, complete) VALUES (?, ?, 0) ON CONFLICT (owner_id) DO UPDATE SET pruned_at = excluded.pruned_at, complete = 0",
    ).run(ownerId, at);
  }

  /** All of `ownerId`'s steps from before its mark are deleted (D1). */
  completeTranscriptPrune(ownerId: string): void {
    this.stmt("UPDATE transcript_pruned SET complete = 1 WHERE owner_id = ?").run(ownerId);
  }

  /** Every owner's mark (D1): when, and whether its clean-up finished. */
  transcriptPrunes(): Map<string, { at: number; complete: boolean }> {
    const rows = this.stmt("SELECT owner_id, pruned_at, complete FROM transcript_pruned").all() as Array<{ owner_id: string; pruned_at: number; complete: number }>;
    return new Map(rows.map((row) => [row.owner_id, { at: row.pruned_at, complete: row.complete === 1 }]));
  }

  /** Whether `ownerId` has steps a clean-up removes from before `before` (D1). */
  hasPrunedSteps(ownerId: string, before: number): boolean {
    return this.stmt(`SELECT 1 FROM session_transcripts WHERE owner_id = ? AND at < ? AND ${PRUNED_STEP_SQL} LIMIT 1`).get(ownerId, before) !== undefined;
  }

  /** Deletes up to `limit` of `ownerId`'s steps a clean-up removes from before `before`, in one transaction; how many it did. */
  deletePrunedSteps(ownerId: string, before: number, limit: number): number {
    return Number(
      this.stmt(
        `DELETE FROM session_transcripts WHERE rowid IN (
           SELECT rowid FROM session_transcripts WHERE owner_id = ? AND at < ? AND ${PRUNED_STEP_SQL} LIMIT ?
         )`,
      ).run(ownerId, before, limit).changes,
    );
  }

  listTranscriptEntries(ownerId: string): TranscriptEntry[] {
    this.writeQueuedBeforeRead([ownerId]);
    const rows = this.stmt("SELECT entry_json FROM session_transcripts WHERE owner_id = ? ORDER BY seq ASC").all(ownerId) as Array<{ entry_json: string }>;
    return rows.flatMap((r) => {
      try {
        return [JSON.parse(r.entry_json) as TranscriptEntry];
      } catch {
        return [];
      }
    });
  }

  /** The entries of `ownerId` as stored (their JSON), by entry id: to save only what's new or changed. */
  storedTranscriptJson(ownerId: string): Map<string, string> {
    this.writeQueuedBeforeRead([ownerId]);
    const rows = this.stmt("SELECT entry_id, entry_json FROM session_transcripts WHERE owner_id = ?").all(ownerId) as Array<{ entry_id: string; entry_json: string }>;
    return new Map(rows.map((r) => [r.entry_id, r.entry_json]));
  }

  hasTranscriptEntries(ownerId: string): boolean {
    this.writeQueuedBeforeRead([ownerId]);
    const row = this.stmt("SELECT 1 AS found FROM session_transcripts WHERE owner_id = ? LIMIT 1").get(ownerId) as { found: number } | undefined;
    return row !== undefined;
  }

  private backfilledTranscriptOwners(): Set<string> {
    const list = this.getSetting<unknown>("search.backfilledOwners");
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  }

  isTranscriptBackfilled(ownerId: string): boolean {
    return !this.unforgotten.has(ownerId) && this.backfilledTranscriptOwners().has(ownerId);
  }

  /** Marks all of `ownerId`'s history as saved: what's queued for it is written first, so the mark never comes before it. */
  markTranscriptBackfilled(ownerId: string): void {
    this.writeQueued([ownerId]);
    this.unforgotten.delete(ownerId);
    const set = this.backfilledTranscriptOwners();
    if (set.has(ownerId)) return;
    set.add(ownerId);
    this.setSetting("search.backfilledOwners", [...set]);
  }

  hasTranscriptMessage(ownerId: string, kind: "user" | "assistant", text: string): boolean {
    const norm = text.trim().toLowerCase();
    if (!norm) return false;
    this.writeQueuedBeforeRead([ownerId]);
    const rows = this.db
      .prepare(
        kind === "user"
          ? "SELECT kind, search_text, entry_json FROM session_transcripts WHERE owner_id = ? AND kind IN ('user', 'question')"
          : "SELECT kind, search_text, entry_json FROM session_transcripts WHERE owner_id = ? AND kind = ?",
      )
      .all(...(kind === "user" ? [ownerId] : [ownerId, kind])) as Array<{ kind: string; search_text: string; entry_json: string }>;
    return rows.some((r) => {
      if (r.kind === "question") {
        try {
          const parsed = JSON.parse(r.entry_json) as Extract<TranscriptEntry, { kind: "question" }>;
          return parsed.answer?.trim().toLowerCase() === norm;
        } catch {
          return false;
        }
      }
      return r.search_text.trim() === norm;
    });
  }

  /**
   * Searches stored transcript entries in SQLite using parameterized `LIKE` clauses on `search_text` so non-matching
   * rows are filtered before parsing JSON in Node.js (D64). Returns both the limited rows and the exact total match count.
   */
  searchTranscriptEntries(
    tokens: readonly string[],
    options: { ownerIds?: readonly string[]; limit?: number } = {},
  ): { rows: Array<{ ownerId: string; entry: TranscriptEntry }>; total: number } {
    const cleaned = tokens.map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (cleaned.length === 0) return { rows: [], total: 0 };
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    for (const token of cleaned) {
      const escaped = token.replace(/[\\%_]/g, "\\$&");
      clauses.push("search_text LIKE ? ESCAPE '\\'");
      params.push(`%${escaped}%`);
    }
    if (options.ownerIds) {
      if (options.ownerIds.length === 0) return { rows: [], total: 0 };
      clauses.push(`owner_id IN (${options.ownerIds.map(() => "?").join(", ")})`);
      params.push(...options.ownerIds);
    }
    this.writeQueuedBeforeRead(options.ownerIds);
    const where = clauses.join(" AND ");
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS total FROM session_transcripts WHERE ${where}`)
      .get(...params) as { total: number };
    const limit = Math.min(Math.max(1, options.limit ?? 300), 1000);
    const dbRows = this.db
      .prepare(
        `SELECT owner_id, entry_json FROM session_transcripts
         WHERE ${where}
         ORDER BY at DESC, seq DESC
         LIMIT ?`,
      )
      .all(...params, limit) as Array<{ owner_id: string; entry_json: string }>;
    const rows = dbRows.flatMap((r) => {
      try {
        return [{ ownerId: r.owner_id, entry: JSON.parse(r.entry_json) as TranscriptEntry }];
      } catch {
        return [];
      }
    });
    return { rows, total: countRow.total };
  }

  deleteTranscriptEntries(ownerId: string): void {
    this.db.prepare("DELETE FROM session_transcripts WHERE owner_id = ?").run(ownerId);
    this.stmt("DELETE FROM transcript_pruned WHERE owner_id = ?").run(ownerId);
    // What's queued would have gone with the rest.
    const wasNoted = this.unforgotten.delete(ownerId);
    if (this.queued.delete(ownerId) || wasNoted) this.setSetting(QUEUED_OWNERS, this.noted(this.queued.keys()));
    const set = this.backfilledTranscriptOwners();
    if (set.delete(ownerId)) {
      this.setSetting("search.backfilledOwners", [...set]);
    }
  }

  // ── routines & reminders (Phase 6B, PLAN.md §8, §10 Phase 6B) ──────────────────────────────────────────────────

  listRoutines(): Routine[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM routines
         ORDER BY CASE WHEN created_by = 'builtin' THEN 0 ELSE 1 END, created_at ASC, rowid ASC`,
      )
      .all() as unknown as RoutineDbRow[];
    return rows.map(toRoutine);
  }

  getRoutine(id: string): Routine | undefined {
    const row = this.db.prepare("SELECT * FROM routines WHERE id = ?").get(id) as unknown as RoutineDbRow | undefined;
    return row ? toRoutine(row) : undefined;
  }

  saveRoutine(
    routine: Omit<Routine, "nextRunAt" | "createdAt" | "updatedAt"> & { createdAt?: number; updatedAt?: number },
  ): Routine {
    const now = Date.now();
    const createdAt = routine.createdAt ?? now;
    const updatedAt = routine.updatedAt ?? now;
    this.db
      .prepare(
        `INSERT INTO routines (
           id, name, kind, cron, prompt, enabled, run_on_first_open, created_by,
           last_run_at, last_run_date, last_status, last_result, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name,
           kind = excluded.kind,
           cron = excluded.cron,
           prompt = excluded.prompt,
           enabled = excluded.enabled,
           run_on_first_open = excluded.run_on_first_open,
           last_run_at = excluded.last_run_at,
           last_run_date = excluded.last_run_date,
           last_status = excluded.last_status,
           last_result = excluded.last_result,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`,
      )
      .run(
        routine.id,
        routine.name,
        routine.kind,
        routine.cron,
        routine.prompt ?? null,
        routine.enabled ? 1 : 0,
        routine.runOnFirstOpen ? 1 : 0,
        routine.createdBy,
        routine.lastRunAt ?? null,
        routine.lastRunDate ?? null,
        routine.lastStatus ?? null,
        routine.lastResult ?? null,
        routine.lastError ?? null,
        createdAt,
        updatedAt,
      );
    return this.getRoutine(routine.id)!;
  }

  deleteRoutine(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM routines WHERE id = ?").run(id).changes) > 0;
  }

  nextReminderShortId(): string {
    const current = this.getSetting<number>("reminders.nextShortId") ?? 1;
    this.setSetting("reminders.nextShortId", current + 1);
    return `R-${current}`;
  }

  listReminders(): Reminder[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM reminders
         ORDER BY CASE status WHEN 'fired' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'snoozed' THEN 2 ELSE 3 END,
         due_at ASC, created_at DESC`,
      )
      .all() as unknown as ReminderDbRow[];
    return rows.map(toReminder);
  }

  getReminder(id: string): Reminder | undefined {
    const row = this.db.prepare("SELECT * FROM reminders WHERE id = ?").get(id) as unknown as ReminderDbRow | undefined;
    return row ? toReminder(row) : undefined;
  }

  saveReminder(
    reminder: Omit<Reminder, "createdAt" | "updatedAt"> & { createdAt?: number; updatedAt?: number },
  ): Reminder {
    const now = Date.now();
    const createdAt = reminder.createdAt ?? now;
    const updatedAt = reminder.updatedAt ?? now;
    this.db
      .prepare(
        `INSERT INTO reminders (
           id, short_id, text, due_at, status, snoozed_count, card_id, created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           short_id = excluded.short_id,
           text = excluded.text,
           due_at = excluded.due_at,
           status = excluded.status,
           snoozed_count = excluded.snoozed_count,
           card_id = excluded.card_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        reminder.id,
        reminder.shortId,
        reminder.text,
        reminder.dueAt,
        reminder.status,
        reminder.snoozedCount,
        reminder.cardId ?? null,
        reminder.createdBy,
        createdAt,
        updatedAt,
      );
    return this.getReminder(reminder.id)!;
  }

  deleteReminder(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM reminders WHERE id = ?").run(id).changes) > 0;
  }

  close(): void {
    clearTimeout(this.queueTimer);
    this.queueTimer = undefined;
    try {
      this.writeQueued();
    } catch (error) {
      // Dropped now, and said so even in a failing streak. Their owners are still noted as queued, so the next start has
      // their history checked against their sessions again.
      this.queueFailing = false;
      this.queueFailed(error);
    }
    this.queued.clear();
    this.closed = true;
    // Its connection closes first: the checkpoint below then isn't refused, and the files can be deleted after this.
    this.checkpointer?.stop();
    this.checkpointer = undefined;
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // Already closed, or it can't checkpoint now: SQLite replays the WAL at the next open.
    }
    this.db.close();
  }
}

interface RoutineDbRow {
  id: string;
  name: string;
  kind: string;
  cron: string;
  prompt: string | null;
  enabled: number;
  run_on_first_open: number;
  created_by: string;
  last_run_at: number | null;
  last_run_date: string | null;
  last_status: string | null;
  last_result: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

const toRoutine = (r: RoutineDbRow): Routine => ({
  id: r.id,
  name: r.name,
  kind: (["morning_brief", "daily_timesheet", "weekly_time_overview", "prompt"].includes(r.kind) ? r.kind : "prompt") as RoutineKind,
  cron: r.cron,
  ...(r.prompt !== null ? { prompt: r.prompt } : {}),
  enabled: r.enabled !== 0,
  ...(r.kind === "morning_brief" ? { runOnFirstOpen: r.run_on_first_open !== 0 } : {}),
  createdBy: (["builtin", "you", "aria"].includes(r.created_by) ? r.created_by : "you") as Routine["createdBy"],
  ...(r.last_run_at !== null ? { lastRunAt: r.last_run_at } : {}),
  ...(r.last_run_date !== null ? { lastRunDate: r.last_run_date } : {}),
  ...(r.last_status !== null && ["idle", "running", "ok", "error"].includes(r.last_status)
    ? { lastStatus: r.last_status as RoutineStatus }
    : {}),
  ...(r.last_result !== null ? { lastResult: r.last_result } : {}),
  ...(r.last_error !== null ? { lastError: r.last_error } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

interface ReminderDbRow {
  id: string;
  short_id: string;
  text: string;
  due_at: number;
  status: string;
  snoozed_count: number;
  card_id: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

const toReminder = (r: ReminderDbRow): Reminder => ({
  id: r.id,
  shortId: r.short_id,
  text: r.text,
  dueAt: r.due_at,
  status: (["scheduled", "snoozed", "fired", "done"].includes(r.status) ? r.status : "scheduled") as ReminderStatus,
  snoozedCount: r.snoozed_count,
  ...(r.card_id !== null ? { cardId: r.card_id } : {}),
  createdBy: r.created_by === "aria" ? "aria" : "you",
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function transcriptEntrySearchText(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case "user":
    case "assistant":
    case "reasoning":
      return entry.text.toLowerCase();
    case "tool":
      return [entry.name, entry.args ?? "", entry.result ?? "", entry.error ?? ""].join("\n").toLowerCase();
    case "question":
      return [entry.question, ...(entry.choices ?? []), entry.answer ?? ""].join("\n").toLowerCase();
    case "permission":
      return [entry.detail, entry.reason ?? ""].join("\n").toLowerCase();
    case "info":
      return [entry.text, entry.detail ?? ""].join("\n").toLowerCase();
  }
}
