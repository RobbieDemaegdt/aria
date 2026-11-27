/**
 * The config tracker's Timekeeper reader (docs/trackers.md, "The reference"): what the Timekeeper learns from the
 * tracker's tool results, in one pass per result, from the config's fields. It reads JSON only; a result it can't read
 * is `unreadable` (so ARIA's own reads can try the next tool), a result that says there is nothing is `empty`.
 *
 * - tasks: ID and title from the item (else the cached title), the cache row, the names learned for the name index, the
 *   IDs the index can fill in, and an update activity when the task changed on the day (`history`: activities only);
 * - time logs: the tasks they name go to the cache; in date-range mode the day's registered entries are replaced;
 * - project lookups: names and IDs go to the name index, which then fills in the cache.
 */
import type { TimesheetRegisteredEntry } from "@aria/protocol";
import { epochToLocalWallTime, intervalMinutesOnDate, minutesToHHMM } from "../../timekeeper/checks.ts";
import type { ReadOutcome, ReaderInput, TimekeeperReaderContext, TrackerTimekeeperReader } from "../types.ts";
import { isPlainObject, type JsonObject } from "./fields.ts";
import { createReaders, STATUS_MAX } from "./read.ts";
import type { TrackerConfig } from "./schema.ts";

const isDigits = (text: string) => /^\d+$/.test(text);

export function createConfigReader(config: TrackerConfig, ctx: TimekeeperReaderContext): TrackerTimekeeperReader {
  const readers = createReaders(config);
  const knownCustomers = new Map(Object.entries(config.knownIds?.customers ?? {}).map(([name, id]) => [name.trim().toLowerCase(), id]));
  /** Learned project name (lower-cased) → its ID and customer, from tasks and project lookups. */
  const projectByName = new Map<string, { projectId: string; customerId?: string }>();
  /** Learned customer name (lower-cased) → its ID. */
  const customerByName = new Map<string, string>();

  /** A cached task's project and customer names: its fields as the tracker gave them, else ARIA's snapshot of them. */
  const cachedNames = (lastSeen: Record<string, unknown> | undefined): { projectName?: string; customerName?: string } => {
    if (!lastSeen) return {};
    const read = readers.fields(lastSeen);
    const snapshot = isPlainObject(lastSeen._ariaSnapshot) ? lastSeen._ariaSnapshot : undefined;
    const clean = (value: unknown): string | undefined => (typeof value === "string" && value.trim() && !isDigits(value.trim()) ? value.trim() : undefined);
    const projectName = clean(read.projectName) ?? clean(snapshot?.projectName);
    const customerName = clean(read.customerName) ?? clean(snapshot?.customerName);
    return { ...(projectName ? { projectName } : {}), ...(customerName ? { customerName } : {}) };
  };

  const recordNames = (projectName?: string, projectId?: string, customerName?: string, customerId?: string): void => {
    const projectKey = projectName?.trim().toLowerCase();
    const customerKey = customerName?.trim().toLowerCase();
    if (customerKey && customerId) customerByName.set(customerKey, customerId);
    if (projectKey && projectId) {
      const previous = projectByName.get(projectKey);
      projectByName.set(projectKey, { projectId, ...(customerId ? { customerId } : previous?.customerId ? { customerId: previous.customerId } : {}) });
    }
  };

  /** The IDs the name index gives for these names (after learning from every cached task), the last resort `knownIds`. */
  const inferIds = (projectName?: string, customerName?: string): { projectId?: string; customerId?: string } => {
    for (const entry of ctx.db().listTrackerTaskCache(config.id)) {
      const names = cachedNames(entry.lastSeen);
      recordNames(names.projectName, entry.projectId, names.customerName, entry.customerId);
    }
    const projectKey = projectName?.trim().toLowerCase();
    const customerKey = customerName?.trim().toLowerCase();
    const project = projectKey ? projectByName.get(projectKey) : undefined;
    const customerId = (customerKey ? customerByName.get(customerKey) : undefined) ?? project?.customerId ?? (customerKey ? knownCustomers.get(customerKey) : undefined);
    return { ...(project?.projectId ? { projectId: project.projectId } : {}), ...(customerId ? { customerId } : {}) };
  };

  const backfillTaskCache = (): void => {
    const db = ctx.db();
    for (const entry of db.listTrackerTaskCache(config.id)) {
      if (entry.projectId && entry.customerId) continue;
      const names = cachedNames(entry.lastSeen);
      const inferred = inferIds(names.projectName, names.customerName);
      const projectId = entry.projectId ?? inferred.projectId;
      const customerId = entry.customerId ?? inferred.customerId;
      if (projectId !== entry.projectId || customerId !== entry.customerId) {
        db.upsertTrackerTaskCache(config.id, {
          taskId: entry.taskId,
          title: entry.title,
          ...(projectId ? { projectId } : {}),
          ...(customerId ? { customerId } : {}),
          ...(entry.status ? { status: entry.status } : {}),
          lastSeen: entry.lastSeen,
        });
      }
    }
  };

  /** What a tool result made of: read something, said there is nothing, or couldn't be read. */
  const outcomeOf = (input: ReaderInput, read: boolean, emptyList: boolean, isEmptyAnswer: (raw: unknown) => boolean): ReadOutcome =>
    read ? "read" : emptyList || (input.payloads.length === 0 && isEmptyAnswer(input.rawResult)) ? "empty" : "unreadable";

  const tasks = (input: ReaderInput, mode?: "history"): ReadOutcome => {
    const history = mode === "history";
    const db = ctx.db();
    const zone = ctx.zone(input.date);
    let read = false;
    let emptyList = false;
    /** One item of a task list: whether it was a task. */
    const readTask = (item: unknown): boolean => {
      if (!isPlainObject(item)) return false;
      const taskId = readers.taskId(item);
      if (!taskId) return false;
      const prev = db.getTrackerTaskCache(config.id, taskId);
      const title = readers.title(item) ?? prev?.title;
      if (!title) return false;
      const fields = readers.fields(item);
      const projectId = readers.projectId(item);
      const customerId = readers.customerId(item);
      if (!history) {
        recordNames(fields.projectName, projectId, fields.customerName, customerId);
        const inferred = inferIds(fields.projectName, fields.customerName);
        const nextProject = projectId ?? prev?.projectId ?? inferred.projectId;
        const nextCustomer = customerId ?? prev?.customerId ?? inferred.customerId;
        db.upsertTrackerTaskCache(config.id, {
          taskId,
          title,
          ...(nextProject ? { projectId: nextProject } : {}),
          ...(nextCustomer ? { customerId: nextCustomer } : {}),
          ...(fields.status ? { status: fields.status } : prev?.status ? { status: prev.status } : {}),
          lastSeen: item,
        });
      }
      // Did the task change on the day (an update, or a new status)?
      const changedAt = readers.modifiedAt(item, zone);
      if (changedAt !== undefined && epochToLocalWallTime(changedAt, zone).date === input.date) {
        const event = prev?.status && fields.status && prev.status.toLowerCase() !== fields.status.toLowerCase() ? "status_changed" : "updated";
        ctx.recordTaskUpdate({
          taskId,
          title,
          event,
          at: changedAt,
          externalKey: `${config.id}:${taskId}:${input.date}`,
          ...(fields.status ? { status: fields.status, statusMax: STATUS_MAX } : {}),
          ...(prev?.status && event === "status_changed" ? { previousStatus: prev.status } : {}),
        });
      }
      return true;
    };
    for (const payload of input.payloads) {
      const items = readers.taskItems(payload);
      if (Array.isArray(payload) || (isPlainObject(payload) && items[0] !== payload)) emptyList ||= items.length === 0;
      for (const item of items) {
        try {
          if (readTask(item)) read = true;
        } catch {
          // An error in one item doesn't stop the others.
        }
      }
    }
    if (!history) backfillTaskCache();
    return outcomeOf(input, read, emptyList, readers.isEmptyTasksAnswer);
  };

  const timeLogs = (input: ReaderInput, mode?: "dateRange"): ReadOutcome => {
    const isDateRange = mode === "dateRange";
    const db = ctx.db();
    const zone = ctx.zone(input.date);
    let read = false;
    let emptyList = false;
    for (const payload of input.payloads) {
      const items = readers.timeLogItems(payload);
      if (!items) continue;
      if (items.length === 0) emptyList = true;
      else read = true;
      const registered: TimesheetRegisteredEntry[] = [];
      for (const item of items) {
        try {
          if (!isPlainObject(item)) continue;
          const logId = readers.timeLogId(item);
          const taskId = readers.timeLogTaskId(item);
          const projectId = readers.timeLogProjectId(item);
          const customerId = readers.timeLogCustomerId(item);
          const taskTitle = readers.timeLogTaskTitle(item);
          if (taskId && (projectId || customerId || taskTitle)) {
            const existing = db.getTrackerTaskCache(config.id, taskId);
            db.upsertTrackerTaskCache(config.id, {
              taskId,
              title: taskTitle ?? existing?.title ?? `Task ${taskId}`,
              ...(projectId ? { projectId } : existing?.projectId ? { projectId: existing.projectId } : {}),
              ...(customerId ? { customerId } : existing?.customerId ? { customerId: existing.customerId } : {}),
            });
          }
          if (isDateRange && logId && taskId) {
            const startMs = readers.timeLogStart(item, zone);
            const endMs = readers.timeLogEnd(item, zone);
            if (startMs !== undefined && endMs !== undefined) {
              const interval = intervalMinutesOnDate(startMs, endMs, input.date, zone);
              if (interval && interval.endMinutes > interval.startMinutes) {
                const comment = readers.timeLogComment(item);
                const entry: TimesheetRegisteredEntry = {
                  id: logId,
                  start: minutesToHHMM(interval.startMinutes),
                  end: minutesToHHMM(interval.endMinutes),
                  minutes: interval.endMinutes - interval.startMinutes,
                  trackerTaskId: taskId,
                  ...(taskTitle ? { trackerTaskTitle: taskTitle } : {}),
                  ...(projectId ? { trackerProjectId: projectId } : {}),
                  ...(customerId ? { trackerCustomerId: customerId } : {}),
                  ...(comment !== undefined ? { comment } : {}),
                };
                const index = registered.findIndex((r) => r.id === logId);
                if (index >= 0) registered[index] = entry;
                else registered.push(entry);
              }
            }
          }
        } catch {
          // An error in one item doesn't stop the others.
        }
      }
      // The day's authoritative list: with several payloads the last one's wins, as it did.
      if (isDateRange) ctx.setRegistered(input.date, registered, { clearNeedsReconcile: true, reconcileStored: true });
    }
    // An empty day said in words (no JSON): the registered list is empty.
    if (isDateRange && input.payloads.length === 0 && readers.isEmptyTimeLogsAnswer(input.rawResult)) {
      ctx.setRegistered(input.date, [], { clearNeedsReconcile: true, reconcileStored: true });
    }
    return outcomeOf(input, read, emptyList, readers.isEmptyTimeLogsAnswer);
  };

  const projects = (input: ReaderInput): ReadOutcome => {
    let read = false;
    let emptyList = false;
    for (const payload of input.payloads) {
      const items = readers.projectItems(payload);
      if (!items) continue;
      if (items.length === 0) emptyList = true;
      for (const item of items) {
        try {
          if (!isPlainObject(item)) continue;
          const project = readers.projectLookup(item as JsonObject);
          if (project.id || project.name) read = true;
          recordNames(project.name, project.id, project.customerName, project.customerId);
        } catch {
          // An error in one item doesn't stop the others.
        }
      }
    }
    backfillTaskCache();
    return outcomeOf(input, read, emptyList, () => false);
  };

  return {
    tasks,
    timeLogs,
    projects,
    backfillTaskCache,
    unknownProjectNames(taskIds: readonly string[]): string[] {
      const db = ctx.db();
      const unresolved = new Set<string>();
      for (const id of taskIds) {
        const names = cachedNames(db.getTrackerTaskCache(config.id, id)?.lastSeen);
        if (names.projectName && !projectByName.has(names.projectName.toLowerCase())) unresolved.add(names.projectName);
      }
      return [...unresolved];
    },
  };
}
