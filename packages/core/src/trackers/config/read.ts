/**
 * What a config's field lists, patterns and phrases read out of a tracker's JSON (docs/trackers.md, "The reference"),
 * shared by the tracker (`parse`, `lastSeenFields`), the Timekeeper's reader and the create-result parser.
 * One place, so the watcher, the reader and the cache read a task object the same way.
 */
import type { TrackerTaskFields } from "../types.ts";
import {
  firstValid,
  isPlainObject,
  readComment,
  readDate,
  readId,
  readNameField,
  readPlain,
  readScalar,
  readText,
  readTime,
  type CommentPaths,
  type JsonObject,
  type ObjectKeys,
} from "./fields.ts";
import { idMatcher } from "./patterns.ts";
import { configPatterns, type TrackerConfig } from "./schema.ts";

/** The length limits of the fields. */
export const TITLE_MAX = 200;
export const STATUS_MAX = 80;
export const PRIORITY_MAX = 60;
export const TASK_TYPE_MAX = 80;
export const NAME_MAX = 120;
export const PLAIN_MAX = 200;
const ID_MAX = 64;

const escapeRegex = (text: string) => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
const isWordChar = (ch: string | undefined) => ch !== undefined && /\w/.test(ch);

/** Whether an answer says "nothing": nothing at all, an empty list or envelope, or one of the config's phrases. */
export function emptyAnswerCheck(phrases: readonly string[], listKeys: readonly string[]): (raw: unknown) => boolean {
  const pattern = phrases.length > 0 ? new RegExp(`^(?:${phrases.map(escapeRegex).join("|")})\\.?$`, "i") : undefined;
  const keys = [...listKeys, "content"];
  return (raw) => {
    if (raw === null || raw === undefined || raw === "") return true;
    if (Array.isArray(raw)) return raw.length === 0;
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      return !trimmed || trimmed === "[]" || (pattern?.test(trimmed) ?? false);
    }
    if (isPlainObject(raw)) return keys.some((key) => Object.hasOwn(raw, key) && Array.isArray(raw[key]) && (raw[key] as unknown[]).length === 0);
    return false;
  };
}

/** A payload's items: the first present array among `lists`, or the payload itself when it is one. */
function listOf(payload: unknown, lists: readonly string[]): unknown[] | undefined {
  if (Array.isArray(payload)) return payload;
  if (!isPlainObject(payload)) return undefined;
  for (const key of lists) {
    const list = Object.hasOwn(payload, key) ? payload[key] : undefined;
    if (Array.isArray(list)) return list;
  }
  return undefined;
}

export interface ConfigReaders {
  readonly keys: ObjectKeys;
  /** `ids.task` (case as `taskRef.caseInsensitive`), `ids.entity`, `ids.timeLog`. */
  readonly taskIdMatcher: RegExp;
  readonly entityIdMatcher: RegExp;
  readonly timeLogIdMatcher: RegExp;

  // Tasks
  taskId(item: JsonObject): string | undefined;
  title(item: JsonObject): string | undefined;
  projectId(item: JsonObject): string | undefined;
  customerId(item: JsonObject): string | undefined;
  /** Everything besides the ID and the title that a task object gives (what `lastSeenFields` gives too). */
  fields(item: JsonObject): TrackerTaskFields;
  /** When the task last changed, as epoch milliseconds in the day's zone: the first `modifiedAt` path that is a time. */
  modifiedAt(item: JsonObject, zone: string): number | undefined;
  /** The task objects of a payload (a list, or the payload itself as one). */
  taskItems(payload: unknown): unknown[];
  isEmptyTasksAnswer(raw: unknown): boolean;
  isClosedStatus(status: string | undefined): boolean;
  statusRank(status: string | undefined): number;

  // Time logs (when the config has them)
  /** A payload's time logs; undefined when it isn't a list (an object without a list key is unreadable, D4). */
  timeLogItems(payload: unknown): unknown[] | undefined;
  isEmptyTimeLogsAnswer(raw: unknown): boolean;
  timeLogId(item: JsonObject): string | undefined;
  timeLogTaskId(item: JsonObject): string | undefined;
  timeLogProjectId(item: JsonObject): string | undefined;
  timeLogCustomerId(item: JsonObject): string | undefined;
  timeLogTaskTitle(item: JsonObject): string | undefined;
  timeLogComment(item: JsonObject): string | undefined;
  timeLogStart(item: JsonObject, zone: string): number | undefined;
  timeLogEnd(item: JsonObject, zone: string): number | undefined;

  // Project lookups (when the config has them)
  projectItems(payload: unknown): unknown[] | undefined;
  projectLookup(item: JsonObject): { id?: string; name?: string; customerId?: string; customerName?: string };
}

export function createReaders(config: TrackerConfig): ConfigReaders {
  const keys = config.objectKeys as ObjectKeys;
  const patterns = configPatterns(config);
  const taskIdMatcher = idMatcher(patterns.task, config.taskRef.caseInsensitive);
  const entityIdMatcher = idMatcher(patterns.entity, false);
  const timeLogIdMatcher = idMatcher(patterns.timeLog, false);
  const f = config.tasks.fields;
  const commentPaths: CommentPaths = config.tasks.comments ?? { text: [] };
  const text = (item: JsonObject, paths: readonly string[] | undefined, max: number) => firstValid(item, paths, (v) => readText(v, max, keys));
  const entityId = (item: JsonObject, paths: readonly string[] | undefined) => firstValid(item, paths, (v) => readId(v, keys, { pattern: entityIdMatcher, max: ID_MAX }));

  const closedWords = config.tasks.closedStatuses.map((word) => word.toLowerCase());
  const rankWords = config.tasks.statusRank.map((word) => word.toLowerCase());
  const emptyTasks = emptyAnswerCheck(config.tasks.emptyText, config.tasks.lists);

  const timeLogs = config.timeLogs;
  const tl = timeLogs?.fields;
  const emptyTimeLogs = emptyAnswerCheck(timeLogs?.emptyText ?? [], timeLogs?.lists ?? []);
  const projects = config.projects;
  const pf = projects?.fields;

  return {
    keys,
    taskIdMatcher,
    entityIdMatcher,
    timeLogIdMatcher,

    taskId: (item) => firstValid(item, f.id, (v) => readId(v, keys, { pattern: taskIdMatcher, max: ID_MAX })),
    title: (item) => firstValid(item, f.title, (v) => readScalar(v, TITLE_MAX)),
    projectId: (item) => entityId(item, f.projectId),
    customerId: (item) => entityId(item, f.customerId),
    fields: (item) => ({
      status: text(item, f.status, STATUS_MAX),
      priority: text(item, f.priority, PRIORITY_MAX),
      taskType: text(item, f.taskType, TASK_TYPE_MAX),
      projectName: readNameField(item, f.projectName, f.projectId, NAME_MAX, keys),
      customerName: readNameField(item, f.customerName, f.customerId, NAME_MAX, keys),
      dueDate: firstValid(item, f.dueDate, (v) => readDate(v)),
      ...readComment(item, commentPaths, keys),
    }),
    modifiedAt: (item, zone) => firstValid(item, f.modifiedAt, (v) => readTime(v, zone)),
    taskItems: (payload) => listOf(payload, config.tasks.lists) ?? (isPlainObject(payload) ? [payload] : []),
    isEmptyTasksAnswer: emptyTasks,
    isClosedStatus: (status) => {
      const s = status?.trim().toLowerCase();
      if (s === undefined) return false;
      return closedWords.some((word) => s.startsWith(word) && !(isWordChar(word.at(-1)) && isWordChar(s[word.length])));
    },
    statusRank: (status) => {
      if (!status) return rankWords.length;
      const index = rankWords.indexOf(status.trim().toLowerCase());
      return index === -1 ? rankWords.length : index;
    },

    timeLogItems: (payload) => listOf(payload, timeLogs?.lists ?? []),
    isEmptyTimeLogsAnswer: emptyTimeLogs,
    timeLogId: (item) => firstValid(item, tl?.id, (v) => readId(v, keys, { pattern: timeLogIdMatcher, max: ID_MAX })),
    timeLogTaskId: (item) => firstValid(item, tl?.taskId, (v) => readId(v, keys, { pattern: taskIdMatcher, max: ID_MAX })),
    timeLogProjectId: (item) => entityId(item, tl?.projectId),
    timeLogCustomerId: (item) => entityId(item, tl?.customerId),
    timeLogTaskTitle: (item) => firstValid(item, tl?.taskTitle, (v) => readPlain(v, PLAIN_MAX)),
    timeLogComment: (item) => firstValid(item, tl?.comment, (v) => readPlain(v, PLAIN_MAX, true)),
    timeLogStart: (item, zone) => firstValid(item, tl?.start, (v) => readTime(v, zone)),
    timeLogEnd: (item, zone) => firstValid(item, tl?.end, (v) => readTime(v, zone)),

    projectItems: (payload) => {
      const list = listOf(payload, projects?.lists ?? []);
      if (list) return list;
      // A single project: an object that has its ID.
      return isPlainObject(payload) && pf && firstValid(payload, pf.id, (v) => readId(v, keys, { pattern: entityIdMatcher, max: ID_MAX })) ? [payload] : undefined;
    },
    projectLookup: (item) => ({
      id: pf ? entityId(item, pf.id) : undefined,
      name: pf ? text(item, pf.name, NAME_MAX) : undefined,
      customerId: pf ? entityId(item, pf.customerId) : undefined,
      customerName: pf ? text(item, pf.customerName, NAME_MAX) : undefined,
    }),
  };
}
