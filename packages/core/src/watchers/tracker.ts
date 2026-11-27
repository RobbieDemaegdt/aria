/**
 * Phase 7B: the task tracker's background watcher and My work integration
 * (PLAN.md §4.5, §4.6, §4.13, §4.14, §5.2, §5.4, §8, §10 Phase 7B).
 *
 * - Polls the tracker's `tasks.myTasks` tools (the first, falling back to the next) every 10 minutes through
 *   `NativeMcpClient.callTool` with zero model calls and zero AI credits spent.
 * - Respects per-tool rules in Customize › Integrations: only polls when the active tracker server is
 *   enabled/connected and the read tool's effective rule for `aria` is `"auto"`.
 * - Cold-start baseline (`watcherState.baselined` in SQLite `settings` key `"watchers.trackerState"` is the sole truth):
 *   ingests tasks into `tracker_tasks_cache`, records `assignedTaskIds`, sets `baselined: true`, and emits zero cards.
 * - Incremental diffing: detects new assignments (`"assigned"`), status transitions including `"Closed"`
 *   (`"status_changed"`), priority transitions (`"priority_changed"`), and new comments/versions (`"comment_added"`),
 *   removes tasks that disappear from the poll from `assignedTaskIds`, and emits `tracker_update` cards, attention
 *   events, and `<updates>` digest lines.
 */
import { randomUUID } from "node:crypto";
import type {
  CardItem,
  MyWorkTrackerState,
  MyWorkTrackerTask,
  TrackerTaskCacheEntry,
  TrackerUpdateCardPayload,
  TrackerUpdateEvent,
} from "@aria/protocol";
import type { AttentionEvent } from "../attention/attention.ts";
import type { Clock } from "../attention/clock.ts";
import { digestText } from "../github/text.ts";
import type { McpConfigState } from "../integrations/config.ts";
import { isMcpAuthError, type McpDirectClient } from "../integrations/mcp-client.ts";
import { viewTools, type Catalog, type StoredRule } from "../integrations/rules.ts";
import { serverWirePrefix } from "../integrations/scope.ts";
import type { Store } from "../store/store.ts";
import { SETTING_TRACKER_WATCHER } from "../trackers/data-id.ts";
import { isAllowedByServerToolsFilter, rankTrackerServers } from "../trackers/servers.ts";
import type { TaskTracker, TrackerTask, TrackerTaskFields } from "../trackers/types.ts";
import { cleanUntrustedText } from "../util/clean-text.ts";

export const TRACKER_POLL_INTERVAL_MS = 10 * 60_000;
export const TRACKER_COOLDOWN_MS = 60_000;
export const TRACKER_MAX_BACKOFF_MS = 30 * 60_000;
export { SETTING_TRACKER_WATCHER };

export interface StoredTrackerWatcherState {
  /** The tracker the state belongs to: another tracker's state reads as absent. */
  trackerId?: string;
  /** True once the initial baseline poll has completed. */
  baselined: boolean;
  /** Task IDs returned in the latest successful poll (ordered). */
  assignedTaskIds: string[];
  /** Epoch ms of the last successful poll. */
  lastCheckedAt?: number;
  /** Server name used in the last poll. */
  server?: string;
}

export interface TrackerDiffResult {
  baselined: boolean;
  wasColdStart: boolean;
  assignedTaskIds: string[];
  updates: TrackerUpdateCardPayload[];
}

/** The task fields ARIA last saw, which it keeps beside the tracker's raw object (`lastSeen._ariaSnapshot`). */
function extractAriaSnapshot(lastSeen: Record<string, unknown> | undefined): TrackerTaskFields | undefined {
  if (!lastSeen) return undefined;
  const raw = lastSeen._ariaSnapshot;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as TrackerTaskFields;
  }
  return undefined;
}

function extractPreviousFields(tracker: TaskTracker, entry: TrackerTaskCacheEntry | undefined): TrackerTaskFields {
  if (!entry) return {};
  const snap = extractAriaSnapshot(entry.lastSeen);
  const raw = tracker.tasks.lastSeenFields(entry.lastSeen);
  const status = entry.status ?? snap?.status ?? raw.status;
  const priority = snap?.priority ?? raw.priority;
  const taskType = snap?.taskType ?? raw.taskType;
  const projectName = snap?.projectName ?? raw.projectName;
  const customerName = snap?.customerName ?? raw.customerName;
  const dueDate = snap?.dueDate ?? raw.dueDate;
  const comment = snap?.comment ?? raw.comment;
  const commentBy = snap?.commentBy ?? raw.commentBy;
  const commentKey = snap?.commentKey ?? raw.commentKey;

  return {
    ...(status ? { status } : {}),
    ...(priority ? { priority } : {}),
    ...(taskType ? { taskType } : {}),
    ...(projectName ? { projectName } : {}),
    ...(customerName ? { customerName } : {}),
    ...(dueDate ? { dueDate } : {}),
    ...(comment ? { comment } : {}),
    ...(commentBy ? { commentBy } : {}),
    ...(commentKey ? { commentKey } : {}),
  };
}

function upsertTaskSnapshot(
  tracker: TaskTracker,
  db: Store,
  task: TrackerTask,
  prev: TrackerTaskCacheEntry | undefined,
  now: number,
): void {
  const prevSnap = extractPreviousFields(tracker, prev);
  const snapshot: TrackerTaskFields = {
    ...(task.status ?? prevSnap.status ? { status: task.status ?? prevSnap.status } : {}),
    ...(task.priority ?? prevSnap.priority ? { priority: task.priority ?? prevSnap.priority } : {}),
    ...(task.taskType ?? prevSnap.taskType ? { taskType: task.taskType ?? prevSnap.taskType } : {}),
    ...(task.projectName ?? prevSnap.projectName ? { projectName: task.projectName ?? prevSnap.projectName } : {}),
    ...(task.customerName ?? prevSnap.customerName ? { customerName: task.customerName ?? prevSnap.customerName } : {}),
    ...(task.dueDate ?? prevSnap.dueDate ? { dueDate: task.dueDate ?? prevSnap.dueDate } : {}),
    ...(task.comment ?? prevSnap.comment ? { comment: task.comment ?? prevSnap.comment } : {}),
    ...(task.commentBy ?? (task.comment ? undefined : prevSnap.commentBy)
      ? { commentBy: task.commentBy ?? prevSnap.commentBy }
      : {}),
    ...(task.commentKey ?? prevSnap.commentKey ? { commentKey: task.commentKey ?? prevSnap.commentKey } : {}),
  };

  const lastSeen: Record<string, unknown> = {
    ...(prev?.lastSeen ?? {}),
    ...task.raw,
    _ariaSnapshot: snapshot,
  };

  const nextProjectId = task.projectId ?? prev?.projectId;
  const nextCustomerId = task.customerId ?? prev?.customerId;
  const nextStatus = task.status ?? prev?.status;
  const unchanged =
    prev !== undefined &&
    prev.title === task.title &&
    prev.projectId === nextProjectId &&
    prev.customerId === nextCustomerId &&
    prev.status === nextStatus &&
    prevSnap.status === snapshot.status &&
    prevSnap.priority === snapshot.priority &&
    prevSnap.taskType === snapshot.taskType &&
    prevSnap.projectName === snapshot.projectName &&
    prevSnap.customerName === snapshot.customerName &&
    prevSnap.dueDate === snapshot.dueDate &&
    prevSnap.comment === snapshot.comment &&
    prevSnap.commentBy === snapshot.commentBy &&
    prevSnap.commentKey === snapshot.commentKey;

  db.upsertTrackerTaskCache(tracker.id, {
    taskId: task.taskId,
    title: task.title,
    ...(nextProjectId ? { projectId: nextProjectId } : {}),
    ...(nextCustomerId ? { customerId: nextCustomerId } : {}),
    ...(nextStatus ? { status: nextStatus } : {}),
    lastSeen,
    fetchedAt: unchanged ? prev.fetchedAt : now,
  });
}

const norm = (value: string) => value.trim().toLowerCase();

/** The watcher's stored state, or undefined when there's none or it belongs to another tracker (a cold start). */
export function readStoredTrackerWatcherState(db: Store, tracker: TaskTracker): StoredTrackerWatcherState | undefined {
  const state = db.getSetting<StoredTrackerWatcherState>(SETTING_TRACKER_WATCHER);
  if (state?.trackerId !== undefined && state.trackerId !== tracker.id) return undefined;
  return state;
}

/**
 * Diffs a poll's parsed tracker tasks against `tracker_tasks_cache` and the persisted watcher baseline state
 * (`"watchers.trackerState"` in SQLite `settings`).
 *
 * 1. Cold start (`!watcherState?.baselined`): ingests all tasks into `tracker_tasks_cache`, records `assignedTaskIds`,
 *    sets `baselined: true`, and emits ZERO cards.
 * 2. Incremental poll (`watcherState?.baselined === true`):
 *    - Any task in the poll whose `taskId` is not in `previouslyAssigned` emits `event: "assigned"`.
 *    - Status transitions (including to `"Closed"`) emit `event: "status_changed"`.
 *    - Priority transitions emit `event: "priority_changed"`.
 *    - Comment / version changes emit `event: "comment_added"`.
 *    - Tasks that disappear from the poll (or close) are removed from `assignedTaskIds`.
 *    - Updates `tracker_tasks_cache` with the latest task metadata.
 */
export function diffTrackerTasks(
  tracker: TaskTracker,
  db: Store,
  pollTasks: readonly TrackerTask[],
  options: { now?: number; server?: string } = {},
): TrackerDiffResult {
  const now = options.now ?? Date.now();
  const existingCache = db.listTrackerTaskCache(tracker.id);
  const cacheById = new Map(existingCache.map((e) => [e.taskId, e]));
  const watcherState = readStoredTrackerWatcherState(db, tracker);
  const isBaselined = watcherState?.baselined === true;

  if (!isBaselined) {
    for (const task of pollTasks) {
      upsertTaskSnapshot(tracker, db, task, cacheById.get(task.taskId), now);
    }
    const assignedTaskIds = pollTasks.filter((t) => !t.closed).map((t) => t.taskId);
    const nextState: StoredTrackerWatcherState = {
      trackerId: tracker.id,
      baselined: true,
      assignedTaskIds,
      lastCheckedAt: now,
      ...(options.server ? { server: options.server } : watcherState?.server ? { server: watcherState.server } : {}),
    };
    db.setSetting(SETTING_TRACKER_WATCHER, nextState);
    return {
      baselined: true,
      wasColdStart: true,
      assignedTaskIds,
      updates: [],
    };
  }

  const previouslyAssigned = new Set(watcherState.assignedTaskIds ?? []);
  const updates: TrackerUpdateCardPayload[] = [];

  for (const curr of pollTasks) {
    const prev = cacheById.get(curr.taskId);
    const prevFields = extractPreviousFields(tracker, prev);

    const makePayload = (
      event: TrackerUpdateEvent,
      extra: Partial<TrackerUpdateCardPayload> = {},
    ): TrackerUpdateCardPayload => {
      const projectId = curr.projectId ?? prev?.projectId;
      const projectName = curr.projectName ?? prevFields.projectName;
      const customerId = curr.customerId ?? prev?.customerId;
      const customerName = curr.customerName ?? prevFields.customerName;
      const taskType = curr.taskType ?? prevFields.taskType;
      const status = curr.status ?? prevFields.status;
      const priority = curr.priority ?? prevFields.priority;

      return {
        taskId: curr.taskId,
        title: curr.title,
        event,
        ...(status ? { status } : {}),
        ...(priority ? { priority } : {}),
        ...(projectId ? { projectId } : {}),
        ...(projectName ? { projectName } : {}),
        ...(customerId ? { customerId } : {}),
        ...(customerName ? { customerName } : {}),
        ...(taskType ? { taskType } : {}),
        url: tracker.taskUrl(curr.taskId),
        ...extra,
      };
    };

    if (!previouslyAssigned.has(curr.taskId)) {
      if (!curr.closed) {
        updates.push(makePayload("assigned"));
      }
      upsertTaskSnapshot(tracker, db, curr, prev, now);
      continue;
    }

    if (curr.status && prevFields.status && norm(curr.status) !== norm(prevFields.status)) {
      updates.push(
        makePayload("status_changed", {
          previousStatus: prevFields.status,
          status: curr.status,
        }),
      );
    }

    if (curr.priority && prevFields.priority && norm(curr.priority) !== norm(prevFields.priority)) {
      updates.push(
        makePayload("priority_changed", {
          previousPriority: prevFields.priority,
          priority: curr.priority,
        }),
      );
    }

    if (curr.comment) {
      const commentChanged =
        curr.commentKey && prevFields.commentKey
          ? curr.commentKey !== prevFields.commentKey
          : curr.comment !== prevFields.comment;
      if (commentChanged) {
        updates.push(
          makePayload("comment_added", {
            comment: curr.comment,
            ...(curr.commentBy ? { commentBy: curr.commentBy } : {}),
          }),
        );
      }
    }

    upsertTaskSnapshot(tracker, db, curr, prev, now);
  }

  const assignedTaskIds = pollTasks.filter((t) => !t.closed).map((t) => t.taskId);
  const nextState: StoredTrackerWatcherState = {
    trackerId: tracker.id,
    baselined: true,
    assignedTaskIds,
    lastCheckedAt: now,
    ...(options.server ? { server: options.server } : watcherState?.server ? { server: watcherState.server } : {}),
  };
  db.setSetting(SETTING_TRACKER_WATCHER, nextState);

  return {
    baselined: true,
    wasColdStart: false,
    assignedTaskIds,
    updates,
  };
}

export function formatTrackerToastTitle(tracker: TaskTracker, payload: TrackerUpdateCardPayload): string {
  const label = tracker.label;
  switch (payload.event) {
    case "assigned":
      return `New ${label} task · #${payload.taskId}`;
    case "status_changed":
      return `${label} #${payload.taskId} · status → ${payload.status ?? "updated"}`;
    case "priority_changed":
      return `${label} #${payload.taskId} · priority → ${payload.priority ?? "updated"}`;
    case "comment_added":
      return `New comment · ${label} #${payload.taskId}`;
  }
}

/** A digest line, tagged with the tracker's ID. `wirePrefix` is the polled server's, for the comment hint. */
export function formatTrackerDigestLine(tracker: TaskTracker, payload: TrackerUpdateCardPayload, wirePrefix: string): string {
  const tag = `[${tracker.id}]`;
  switch (payload.event) {
    case "assigned":
      return `${tag} Task #${payload.taskId} (${digestText(payload.title, 80)}) was assigned to you${payload.status ? ` [${digestText(payload.status, 40)}]` : ""}.`;
    case "status_changed":
      return `${tag} Task #${payload.taskId} (${digestText(payload.title, 80)}) status changed from ${digestText(payload.previousStatus ?? "unspecified", 40)} to ${digestText(payload.status ?? "unspecified", 40)}.`;
    case "priority_changed":
      return `${tag} Task #${payload.taskId} (${digestText(payload.title, 80)}) priority changed from ${digestText(payload.previousPriority ?? "unspecified", 40)} to ${digestText(payload.priority ?? "unspecified", 40)}.`;
    case "comment_added": {
      const hint = tracker.tasks.commentHint?.(wirePrefix);
      return `${tag} New comment on ${tracker.label} task #${payload.taskId} (${digestText(payload.title, 80)})${hint ? `: ${hint}` : ""}.`;
    }
  }
}

export function cacheEntryToMyWorkTask(tracker: TaskTracker, entry: TrackerTaskCacheEntry): MyWorkTrackerTask | undefined {
  const fields = extractPreviousFields(tracker, entry);
  const status = entry.status ?? fields.status;
  if (tracker.tasks.isClosedStatus(status)) return undefined;
  const title = cleanUntrustedText(entry.title, 200);
  if (!title) return undefined;

  return {
    taskId: entry.taskId,
    title,
    ...(status ? { status } : {}),
    ...(fields.priority ? { priority: fields.priority } : {}),
    ...(fields.taskType ? { taskType: fields.taskType } : {}),
    ...(entry.projectId ? { projectId: entry.projectId } : {}),
    ...(fields.projectName ? { projectName: fields.projectName } : {}),
    ...(entry.customerId ? { customerId: entry.customerId } : {}),
    ...(fields.customerName ? { customerName: fields.customerName } : {}),
    ...(fields.dueDate ? { dueDate: fields.dueDate } : {}),
    ...(fields.comment ? { comment: fields.comment } : {}),
    updatedAt: entry.fetchedAt,
    url: tracker.taskUrl(entry.taskId),
  };
}

export interface TrackerWatcherDeps {
  db: () => Store;
  tracker: () => TaskTracker;
  clock: Clock;
  mcpClient: () => McpDirectClient | undefined;
  catalog: () => Catalog;
  toolRules: () => readonly StoredRule[];
  mcpConfig: () => McpConfigState;
  canCallServerTool?: (server: string, tool: string, wireName: string) => boolean;
  addCard: (card: Extract<CardItem, { cardType: "tracker_update" }>) => void;
  attention: (event: AttentionEvent) => void;
  digest: (line: string) => void;
  onStateChanged?: () => void;
  log?: (line: string) => void;
  jitter?: number;
  pollIntervalMs?: number;
}

type ResolvedTarget =
  | { kind: "off"; server?: string }
  | { kind: "needs_auth"; server: string }
  | {
      kind: "ready";
      server: string;
      tool: string;
      wireName: string;
      fallbackTool?: { tool: string; wireName: string };
    };

export class TrackerWatcher {
  private stopped = false;
  private timer: unknown;
  private inFlight: Promise<MyWorkTrackerState> | undefined;
  private abortController: AbortController | undefined;
  private lastPollAt: number | undefined;
  private consecutiveFailures = 0;
  private status: MyWorkTrackerState["status"] = "off";
  private activeServer: string | undefined;
  private errorMessage: string | undefined;

  constructor(private readonly deps: TrackerWatcherDeps) {}

  private get pollIntervalMs(): number {
    return this.deps.pollIntervalMs ?? TRACKER_POLL_INTERVAL_MS;
  }

  private storedState(): StoredTrackerWatcherState | undefined {
    try {
      return readStoredTrackerWatcherState(this.deps.db(), this.deps.tracker());
    } catch {
      return undefined;
    }
  }

  resolveTarget(): ResolvedTarget {
    const tracker = this.deps.tracker();
    const catalog = this.deps.catalog();
    const mcpConfig = this.deps.mcpConfig();
    const rules = this.deps.toolRules();

    // The same ranking as the Timekeeper's: connected first, the tracker's preferred server among them. A server that
    // has left the setup (the catalog only remembers it) isn't polled: with none in the setup the watcher is off.
    const enabledNames = rankTrackerServers(tracker, catalog, mcpConfig, { remembered: false });

    if (enabledNames.length === 0) {
      return { kind: "off" };
    }

    const serverName = enabledNames[0]!;
    const catServer = catalog.servers.find((s) => s.name === serverName);
    const cfgServer = mcpConfig.servers.find((s) => s.name === serverName);
    const client = this.deps.mcpClient();

    const canCallDirect = (tool: string, wireName: string): boolean => {
      if (this.deps.canCallServerTool) {
        return this.deps.canCallServerTool(serverName, tool, wireName);
      }
      return Boolean(client?.canCallDirectly ? client.canCallDirectly(serverName) : client);
    };

    const views = viewTools(catalog, rules).filter((v) => v.entry.server === serverName && v.seen);
    const myTasks = tracker.tasks.myTasks;

    // Check explicit user rules for the tracker's task-list tools
    const explicitBlocked = (toolName: string): boolean => {
      const rule = rules.find(
        (r) =>
          r.server === serverName &&
          r.scope === "aria" &&
          (r.wireName === `${serverWirePrefix(serverName)}${toolName}` || r.wireName === toolName),
      );
      if (rule && rule.effect !== "auto") return true;
      const v = views.find((x) => x.entry.tool === toolName);
      if (v && v.rules.aria.effect !== "auto") return true;
      return false;
    };

    const firstTool = myTasks[0];
    const hasDirectAuth = firstTool !== undefined && canCallDirect(firstTool, `${serverWirePrefix(serverName)}${firstTool}`);
    if (catServer?.status === "needs-auth" && !hasDirectAuth) {
      return { kind: "needs_auth", server: serverName };
    }

    // In order: a tool the catalog lists is used when its rule is "auto"; an unlisted one when nothing blocks it, the
    // server's filter allows it, and the server's tools aren't known yet, it's configured, or (for a raw-JSON tool)
    // the catalog lists its formatted twin.
    const candidates: Array<{ tool: string; wireName: string }> = [];
    for (const toolName of myTasks) {
      const view = views.find((v) => v.entry.tool === toolName);
      if (view) {
        if (view.rules.aria.effect === "auto") {
          candidates.push({ tool: toolName, wireName: view.entry.wireName });
        }
        continue;
      }
      if (explicitBlocked(toolName)) continue;
      const allowedByFilter = isAllowedByServerToolsFilter(tracker, serverName, cfgServer?.tools, toolName);
      const companions = tracker.rawCompanions;
      const twin = companions && Object.hasOwn(companions, toolName) ? companions[toolName] : undefined;
      const twinListed = twin !== undefined && views.some((v) => v.entry.tool === twin);
      if (allowedByFilter && (views.length === 0 || cfgServer !== undefined || twinListed)) {
        candidates.push({ tool: toolName, wireName: `${serverWirePrefix(serverName)}${toolName}` });
      }
    }

    if (candidates.length === 0) {
      return { kind: "off", server: serverName };
    }

    const callable = candidates.filter((c) => canCallDirect(c.tool, c.wireName));
    if (callable.length === 0) {
      return { kind: "off", server: serverName };
    }

    const primary = callable[0]!;
    const fallback = callable[1];

    return {
      kind: "ready",
      server: serverName,
      tool: primary.tool,
      wireName: primary.wireName,
      ...(fallback ? { fallbackTool: fallback } : {}),
    };
  }

  start(): void {
    if (this.stopped) return;
    const stored = this.storedState();
    if (stored?.lastCheckedAt !== undefined) {
      this.lastPollAt = stored.lastCheckedAt;
    }
    if (stored?.server) {
      this.activeServer = stored.server;
    }
    const target = this.resolveTarget();
    if (target.kind === "ready") {
      this.status = stored?.baselined ? "ok" : "loading";
      this.activeServer = target.server;
      void this.poll({ force: true });
    } else if (target.kind === "needs_auth") {
      this.status = "needs_auth";
      this.activeServer = target.server;
      this.errorMessage = `${target.server} needs signing in or a bearer token in Customize › Integrations.`;
    } else {
      this.status = stored?.baselined && stored.assignedTaskIds.length > 0 ? "ok" : "off";
    }
  }

  wake(): void {
    if (this.stopped) return;
    const prevView = JSON.stringify(this.view());
    const target = this.resolveTarget();
    if (target.kind === "off") {
      this.clearTimer();
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = undefined;
      }
      this.status = "off";
      this.errorMessage = undefined;
      if (JSON.stringify(this.view()) !== prevView) {
        this.deps.onStateChanged?.();
      }
      return;
    }
    if (target.kind === "needs_auth") {
      this.clearTimer();
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = undefined;
      }
      this.status = "needs_auth";
      this.activeServer = target.server;
      this.errorMessage = `${target.server} needs signing in or a bearer token in Customize › Integrations.`;
      if (JSON.stringify(this.view()) !== prevView) {
        this.deps.onStateChanged?.();
      }
      return;
    }

    const now = this.deps.clock.now();
    const lastPollAt = this.lastPollAt;
    const due =
      lastPollAt === undefined ||
      !this.storedState()?.baselined ||
      this.status !== "ok" ||
      now - lastPollAt >= this.pollIntervalMs;

    if (due) {
      void this.poll({ force: true });
    } else if (this.timer === undefined) {
      this.scheduleNext(Math.max(1_000, this.pollIntervalMs - (now - lastPollAt)));
    }
  }

  /**
   * The active tracker was swapped: the poll of the old one is aborted and forgotten, its failures and status
   * reset, and the new tracker is polled at once, so the watcher is never left idle on the old run.
   */
  trackerChanged(): void {
    if (this.stopped) return;
    this.clearTimer();
    this.abortController?.abort();
    this.abortController = undefined;
    this.inFlight = undefined;
    this.consecutiveFailures = 0;
    this.lastPollAt = undefined;
    this.status = "off";
    this.errorMessage = undefined;
    this.deps.onStateChanged?.();
    this.wake();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      this.deps.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleNext(customDelayMs?: number): void {
    this.clearTimer();
    if (this.stopped) return;
    const target = this.resolveTarget();
    if (target.kind !== "ready") return;

    let delay =
      customDelayMs ??
      (this.consecutiveFailures > 0
        ? Math.min(TRACKER_MAX_BACKOFF_MS, this.pollIntervalMs * 2 ** Math.min(this.consecutiveFailures, 4))
        : this.pollIntervalMs);

    const jitter = this.deps.jitter ?? 0;
    if (jitter > 0 && customDelayMs === undefined) {
      delay = Math.max(1_000, Math.round(delay * (1 + (Math.random() * 2 - 1) * jitter)));
    }

    this.timer = this.deps.clock.setTimeout(() => {
      this.timer = undefined;
      if (!this.stopped) {
        void this.poll({ force: true });
      }
    }, delay);
  }

  async poll(options: { manual?: boolean; force?: boolean } = {}): Promise<MyWorkTrackerState> {
    if (this.stopped) return this.view();
    if (this.inFlight) return this.inFlight;

    const target = this.resolveTarget();
    if (target.kind === "off") {
      const changed = this.status !== "off";
      this.status = "off";
      this.errorMessage = undefined;
      this.clearTimer();
      if (changed) this.deps.onStateChanged?.();
      return this.view();
    }
    if (target.kind === "needs_auth") {
      const changed = this.status !== "needs_auth" || this.activeServer !== target.server;
      this.status = "needs_auth";
      this.activeServer = target.server;
      this.errorMessage = `${target.server} needs signing in or a bearer token in Customize › Integrations.`;
      this.clearTimer();
      if (changed) this.deps.onStateChanged?.();
      return this.view();
    }

    const now = this.deps.clock.now();
    const lastAt = this.lastPollAt ?? this.storedState()?.lastCheckedAt;
    if (!options.force && options.manual && lastAt !== undefined && now - lastAt < TRACKER_COOLDOWN_MS && this.status === "ok") {
      return this.view();
    }
    if (!options.force && !options.manual && this.status === "ok" && lastAt !== undefined && now - lastAt < this.pollIntervalMs) {
      return this.view();
    }

    const run = this.executePoll(target).finally(() => {
      if (this.inFlight === run) {
        this.inFlight = undefined;
        this.deps.onStateChanged?.();
      }
    });
    this.inFlight = run;
    return run;
  }

  private async executePoll(target: Extract<ResolvedTarget, { kind: "ready" }>): Promise<MyWorkTrackerState> {
    const client = this.deps.mcpClient();
    if (!client) return this.view();

    const abort = new AbortController();
    this.abortController = abort;
    // A poll belongs to the tracker it started with: if another one is active when the answer comes, it's dropped.
    const polled = this.deps.tracker();
    this.status = "loading";
    this.activeServer = target.server;
    this.deps.onStateChanged?.();

    try {
      let outcome = await client.callTool({
        server: target.server,
        tool: target.tool,
        wireName: target.wireName,
        approvedArgs: {},
        signal: abort.signal,
      });

      if (
        !outcome.ok &&
        target.fallbackTool &&
        !isMcpAuthError(outcome.error) &&
        /unknown tool|not found|not implemented|no tool|not allowed/i.test(outcome.error)
      ) {
        outcome = await client.callTool({
          server: target.server,
          tool: target.fallbackTool.tool,
          wireName: target.fallbackTool.wireName,
          approvedArgs: {},
          signal: abort.signal,
        });
      }

      if (this.stopped || abort.signal.aborted || this.deps.tracker() !== polled) {
        return this.view();
      }
      const currentTarget = this.resolveTarget();
      if (currentTarget.kind !== "ready" || currentTarget.server !== target.server) {
        return this.view();
      }

      const now = this.deps.clock.now();
      if (!outcome.ok) {
        this.consecutiveFailures++;
        this.lastPollAt = now;
        if (isMcpAuthError(outcome.error)) {
          this.status = "needs_auth";
          this.errorMessage = `${target.server} needs signing in or a bearer token in Customize › Integrations.`;
        } else {
          this.status = "error";
          this.errorMessage = cleanUntrustedText(outcome.error, 240) || `Couldn't read ${this.deps.tracker().label} tasks.`;
        }
        this.scheduleNext();
        this.deps.onStateChanged?.();
        return this.view();
      }

      const tracker = this.deps.tracker();
      const parsedTasks = tracker.tasks.parse(outcome.result);
      const diff = diffTrackerTasks(tracker, this.deps.db(), parsedTasks, {
        now,
        server: target.server,
      });

      for (const payload of diff.updates) {
        const cardId = `${tracker.id}-${payload.taskId}-${payload.event}-${randomUUID()}`;
        const card: Extract<CardItem, { cardType: "tracker_update" }> = {
          kind: "card",
          id: cardId,
          cardType: "tracker_update",
          payload,
          createdAt: now,
        };
        this.deps.addCard(card);
        this.deps.attention({
          kind: "tracker_update",
          title: formatTrackerToastTitle(tracker, payload),
          body: payload.title,
          watch: {
            // A watch ID is a number: only an ID of digits has one to give.
            ...(/^\d+$/.test(payload.taskId) ? { id: Number(payload.taskId) } : {}),
            title: `#${payload.taskId}`,
            repoName: payload.projectName ?? payload.customerName ?? tracker.label,
          },
          cardId,
        });
        this.deps.digest(formatTrackerDigestLine(tracker, payload, serverWirePrefix(target.server)));
      }

      this.consecutiveFailures = 0;
      this.lastPollAt = now;
      this.status = "ok";
      this.errorMessage = undefined;
      this.scheduleNext();
      this.deps.onStateChanged?.();
      return this.view();
    } catch (error) {
      if (this.stopped || abort.signal.aborted) return this.view();
      this.consecutiveFailures++;
      this.lastPollAt = this.deps.clock.now();
      if (isMcpAuthError(error)) {
        this.status = "needs_auth";
        this.errorMessage = `${target.server} needs signing in or a bearer token in Customize › Integrations.`;
      } else {
        this.status = "error";
        this.errorMessage =
          cleanUntrustedText(error instanceof Error ? error.message : String(error), 240) ||
          `Couldn't read ${this.deps.tracker().label} tasks.`;
      }
      this.scheduleNext();
      this.deps.onStateChanged?.();
      return this.view();
    } finally {
      if (this.abortController === abort) {
        this.abortController = undefined;
      }
    }
  }

  view(): MyWorkTrackerState {
    const stored = this.storedState();
    let cacheEntries: TrackerTaskCacheEntry[];
    try {
      cacheEntries = this.deps.db().listTrackerTaskCache(this.deps.tracker().id);
    } catch {
      cacheEntries = [];
    }
    const cacheById = new Map(cacheEntries.map((e) => [e.taskId, e]));
    const tracker = this.deps.tracker();

    const assignedIds = stored?.baselined ? stored.assignedTaskIds : [];
    const tasks: MyWorkTrackerTask[] = [];
    for (const id of assignedIds) {
      const entry = cacheById.get(id);
      if (!entry) continue;
      const mapped = cacheEntryToMyWorkTask(tracker, entry);
      if (mapped) tasks.push(mapped);
    }

    tasks.sort((a, b) => {
      const rankDiff = tracker.tasks.statusRank(a.status) - tracker.tasks.statusRank(b.status);
      if (rankDiff !== 0) return rankDiff;
      return b.updatedAt - a.updatedAt;
    });

    const target = this.resolveTarget();
    let effectiveStatus: MyWorkTrackerState["status"];
    if (this.inFlight) {
      effectiveStatus = "loading";
    } else if (target.kind === "needs_auth" || this.status === "needs_auth") {
      effectiveStatus = "needs_auth";
    } else if (target.kind === "off") {
      effectiveStatus = "off";
    } else if (this.status === "error") {
      effectiveStatus = "error";
    } else if (this.status === "ok" || stored?.baselined) {
      effectiveStatus = "ok";
    } else {
      effectiveStatus = "loading";
    }

    const server =
      (target.kind !== "off" ? target.server : undefined) ??
      this.activeServer ??
      stored?.server;
    const checkedAt = this.lastPollAt ?? stored?.lastCheckedAt;
    const message =
      effectiveStatus === "needs_auth"
        ? (this.errorMessage ?? `${server ?? tracker.label} needs signing in or a bearer token in Customize › Integrations.`)
        : effectiveStatus === "error"
          ? this.errorMessage
          : undefined;

    return {
      status: effectiveStatus,
      ...(server ? { server } : {}),
      ...(checkedAt !== undefined ? { checkedAt } : {}),
      ...(message ? { message } : {}),
      tasks,
    };
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.abortController?.abort();
    this.abortController = undefined;
  }
}
