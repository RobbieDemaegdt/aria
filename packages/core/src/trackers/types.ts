/**
 * The task tracker ARIA reads tasks from and writes time logs to. A config of the trackers folder makes the one ARIA
 * uses (`config/tracker.ts`), or none does (`none.ts`). Optional groups (`timeLogs`, `projects`, `tasks.byId`) are
 * skipped when a tracker has none.
 */
import type { TimeRegisteredEntryResult, TimesheetEntry, TimesheetRegisteredEntry, TrackerInfo } from "@aria/protocol";
import type { McpActionOutcome } from "../runtime/types.ts";
import type { Store } from "../store/store.ts";
import type { ActivityCollector } from "../timekeeper/collectors.ts";

/** A tracker task's update, recorded as an activity on the day it happened. */
export type RecordTrackerActivityInput = Parameters<ActivityCollector["recordTrackerActivity"]>[0];

/** A task as a tracker's payload parser returns it. */
export interface TrackerTask {
  taskId: string;
  title: string;
  status?: string;
  priority?: string;
  taskType?: string;
  projectId?: string;
  projectName?: string;
  customerId?: string;
  customerName?: string;
  dueDate?: string;
  comment?: string;
  commentBy?: string;
  commentKey?: string;
  closed?: boolean;
  raw: Record<string, unknown>;
}

/** What a cached task's fields were: ARIA's own snapshot of them, or the tracker's raw object when there's none. */
export interface TrackerTaskFields {
  status?: string;
  priority?: string;
  taskType?: string;
  projectName?: string;
  customerName?: string;
  dueDate?: string;
  comment?: string;
  commentBy?: string;
  commentKey?: string;
}

/** Ordered tool names: the first one the server has and the rules allow is used, the rest are fallbacks. */
export type ToolChoice = readonly string[];

/**
 * Which reader handler gets a tool result, by its lower-cased bare tool name (without the server's prefix). The first
 * matching route per handler wins.
 */
export interface TrackerRoute {
  handler: "tasks" | "timeLogs" | "projects";
  mode?: "history" | "dateRange";
  /** Substrings of the tool name (one of `anyOf` and `equals`). */
  anyOf?: readonly string[];
  /** Exact tool names: the routes a config tracker derives from its tool lists. */
  equals?: readonly string[];
  allOf?: readonly string[];
  noneOf?: readonly string[];
}

/** What a reader made of a result: read, an empty answer, or something it can't read (a reader that returns nothing is read as "read"). */
export type ReadOutcome = "read" | "empty" | "unreadable";

/** How a `create` call went, row by row (`parseCreateTimeLogsBatchResult`). */
export interface CreateTimeLogsResult {
  results: TimeRegisteredEntryResult[];
  allRegistered: boolean;
  anyRegistered: boolean;
  needsReconcile: boolean;
  rawResponse?: string;
}

/**
 * A registered time log changed in place. `date` is the day (`YYYY-MM-DD`), `start` and `end` are `HH:mm` on it (the
 * tracker writes them in its own format). `task` is set when the task (and its project and customer) go too.
 */
export interface UpdateTimeLogInput {
  entryId: string;
  date: string;
  start: string;
  end: string;
  comment: string;
  task?: { taskId: string; projectId?: string; customerId?: string };
}

/** What a time-log call is given besides its rows: the day's time zone, which a tracker may write times in. */
export interface TimeLogContext {
  /** The day's time zone (the mailbox's once seen, else this computer's). */
  zone: string;
}

export interface TaskTracker {
  /** Stays in stored strings (external IDs `<id>:<task>:…`, card IDs, digest tags): keep it once data exists. */
  readonly id: string;
  readonly label: string;
  readonly info: TrackerInfo;

  /** Whether an MCP server is this tracker's. */
  matchesServer(serverName: string): boolean;
  /** Lower ranks first, among servers of the same connection status. */
  serverPreference(serverName: string): number;
  /** The server the Timekeeper names when none is configured yet. */
  readonly fallbackServer?: string;
  /** A raw-JSON read tool → its formatted twin: allowing the twin in a server's tools filter allows the raw one too. */
  readonly rawCompanions?: Readonly<Record<string, string>>;
  /** Called after listing the tools when testing a connection, if the server has it: it checks the token. */
  readonly testConnectionTool?: string;
  /** Write tools only the Timesheet card and Time view may call, by tool name on every server. */
  readonly reservedTools: ReadonlySet<string>;
  /** Destructive tools that need `confirm: true` even before their schema is known, by tool name on every server. */
  readonly confirmTools: ReadonlySet<string>;

  /** An explicit task reference (an ID or a task URL), normalized; undefined if it isn't one. */
  parseTaskRef(input: string | undefined | null): string | undefined;
  /** The first task reference in free text (commits, PRs, briefs, meetings). */
  extractTaskRef(...texts: Array<string | undefined | null>): string | undefined;
  /** A task reference in a branch name. */
  taskRefFromBranch(branch: string | undefined | null): string | undefined;
  taskUrl(taskId: string): string;
  readonly messages: { invalidTaskRef(input: string): string; invalidRuleTaskRef(input: string): string };

  readonly tasks: {
    /** The watcher's poll: the first is tried first, the next one if it fails. */
    myTasks: ToolChoice;
    byId?: { tools: ToolChoice; args(ids: readonly string[]): Record<string, unknown> };
    /** A task-list result's tasks; throws when it isn't one (an empty list is fine). */
    parse(rawResult: unknown): TrackerTask[];
    /** The fields a cached task's raw object gives (the fallbacks when ARIA has no snapshot of them). */
    lastSeenFields(lastSeen: Record<string, unknown>): TrackerTaskFields;
    isClosedStatus(status: string | undefined): boolean;
    statusRank(status: string | undefined): number;
    /** How the model reads a task's new comment, with the server's wire prefix. */
    commentHint?(wirePrefix: string): string;
  };
  readonly timeLogs?: {
    byRange: { tools: ToolChoice; args(fromDate: string, untilDate: string): Record<string, unknown> };
    create: {
      tool: string;
      args(rows: readonly TimesheetEntry[], ctx: TimeLogContext): Record<string, unknown>;
      /** `ctx` is the one the rows' call was built with: the response is matched to the rows by their formatted times. */
      parseResult(rows: readonly TimesheetEntry[], outcome: McpActionOutcome, ctx: TimeLogContext): CreateTimeLogsResult;
    };
    update: { tool: string; args(input: UpdateTimeLogInput, ctx: TimeLogContext): Record<string, unknown> };
    /** `mode: "display"` builds the Delete confirmation's text (`{id}` as the ID) without checking the IDs. */
    delete: { tool: string; args(entryIds: readonly string[], mode?: "display"): Record<string, unknown> };
    /** Rows can't be submitted without project and customer IDs. */
    requiresProjectCustomer: boolean;
  };
  readonly projects?: { search: { tool: string; args(query: string): Record<string, unknown> } };
  readonly timekeeper: {
    routes: readonly TrackerRoute[];
    createReader(ctx: TimekeeperReaderContext): TrackerTimekeeperReader;
    /** The Timekeeper prompt's tracker steps, with the resolved server's wire prefix. */
    steps(wirePrefix: string): readonly string[];
    dateRangeHint?(date: string, nextDay: string): string;
    resolveIdsHint?(wirePrefix: string, ids: readonly string[]): string;
    /** What the prompt calls the tracker's task updates among the work to consolidate. */
    taskUpdatesName: string;
  };
  /** Config trackers: the first 8 hex digits of SHA-256 of the canonical config JSON. */
  readonly configHash?: string;
}

/** What the Timekeeper gives a tracker's reader. */
export interface TimekeeperReaderContext {
  db(): Store;
  /** The day's time zone (the mailbox's, once seen). */
  zone(date: string): string;
  recordTaskUpdate(input: RecordTrackerActivityInput): void;
  /** The day's registered entries as last read from the tracker (in memory). */
  registered(date: string): readonly TimesheetRegisteredEntry[] | undefined;
  /** Replaces the day's registered entries, as `mode` says. */
  setRegistered(date: string, entries: TimesheetRegisteredEntry[], mode: { clearNeedsReconcile: boolean; reconcileStored: boolean }): void;
}

/** One tool result, as the Timekeeper read it. */
export interface ReaderInput {
  date: string;
  /** The wire name, lower-cased. */
  toolName: string;
  rawResult: unknown;
  /** The JSON in the result (`extractJsonPayloads`). */
  payloads: readonly unknown[];
  /** Each payload's list of items (`value`, `tasks`, `messages`, `entries`, or the payload itself). */
  items: ReadonlyArray<readonly unknown[]>;
}

export interface TrackerTimekeeperReader {
  tasks(input: ReaderInput, mode?: "history"): ReadOutcome | void;
  timeLogs(input: ReaderInput, mode?: "dateRange"): ReadOutcome | void;
  projects(input: ReaderInput): ReadOutcome | void;
  /** Fills in project and customer IDs from names the reader has seen. */
  backfillTaskCache(): void;
  /** Project names of these cached tasks the reader can't map to an ID yet. */
  unknownProjectNames(taskIds: readonly string[]): string[];
}
