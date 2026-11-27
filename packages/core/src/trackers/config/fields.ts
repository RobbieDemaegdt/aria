/**
 * Reading a tracker's JSON objects by the paths in its config (docs/trackers.md, "The reference").
 *
 * A field is a list of dot paths of own properties; the engine walks them in order and the first one whose value its
 * kind can read wins ("first valid", where the code adapter this replaced took the first present value). The
 * kinds are the engine's, not the config's, and each reads exactly what that adapter's helper for the field read:
 *
 * | Kind | Reads | Adapter |
 * | --- | --- | --- |
 * | `id` | a trimmed string or finite number; an object's first present `objectKeys.id`, 3 objects deep; then the pattern | `asIdString` + `parse…Id` |
 * | `scalar` | a string, finite number or boolean, cleaned | `cleanUntrustedText` (titles, comment text) |
 * | `text` | a string or finite number, cleaned; an object's first present `objectKeys.text`, cleaned | `extractFieldText` |
 * | `entityName` | a string that isn't all digits; an object's first present `objectKeys.name` | `extractEntityName` |
 * | `person` | `entityName`, else `text`, of the same value | a comment's author |
 * | `date` | `scalar` with 40 characters; `0001-01-01`, `1900-01-01`, `1970-01-01` dropped before a word edge (so not with a `T…` time, as today); an ISO date prefix kept | `extractDueDate` |
 * | `plain` | strings only, `cleanTitle` (no HTML decoding); the comment keeps `""` | time-log titles and comments |
 * | `time` | a string in the day's zone, or epoch milliseconds | time-log start and end |
 *
 * The name fields (`projectName`, `customerName`) read a path that is also one of the entity's ID paths as the entity
 * itself (`entityName`: an object's name, or nothing for an ID) and any other path as `text`, as the adapter's
 * `extractEntityName(Project) ?? extractFieldText(ProjectName)` does.
 */
import { cleanTitle } from "../../tasks/pr.ts";
import { parseDateTimeInZone } from "../../timekeeper/checks.ts";
import { cleanUntrustedText } from "../../util/clean-text.ts";

export type JsonObject = Record<string, unknown>;

export const isPlainObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
export const isPrototypeKey = (key: string): boolean => PROTOTYPE_KEYS.has(key);

/** An object key a config may name: a letter, `_` or `$`, then up to 63 word characters, `$` or `-`. */
const KEY = /^[A-Za-z_$][\w$-]{0,63}$/;
export const MAX_PATH_SEGMENTS = 5;
export const MAX_PATH_LENGTH = 200;

export const isKey = (key: string): boolean => KEY.test(key) && !isPrototypeKey(key);

/** `Key(.Key){0,4}`: no array indexes, no wildcards, no prototype keys. */
export function isDotPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  const segments = path.split(".");
  return segments.length <= MAX_PATH_SEGMENTS && segments.every(isKey);
}

/** The value at a dot path, through plain objects' own properties only; undefined when any step is missing. */
export function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (!isPlainObject(current) || isPrototypeKey(key) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/** The keys that hold an ID, a text or a name when a field's value is an object (`objectKeys`). */
export interface ObjectKeys {
  readonly id: readonly string[];
  readonly text: readonly string[];
  readonly name: readonly string[];
}

export const DEFAULT_OBJECT_KEYS: ObjectKeys = { id: ["id"], text: ["value", "name"], name: ["name"] };

/** The first of `keys` an object has as an own property with a value other than null (as `a ?? b` reads them). */
function firstPresent(obj: JsonObject, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (isPrototypeKey(key) || !Object.hasOwn(obj, key)) continue;
    const value = obj[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** How deep the `id` kind looks into nested objects (`{ ID: { ID: "1" } }`). */
const MAX_ID_DEPTH = 3;

export interface IdOptions {
  /** A whole-ID check (`idMatcher`); none for a comment's ID or version. */
  pattern?: RegExp;
  /** The longest ID kept (64 for the task, entity and time-log IDs). */
  max?: number;
}

/** Kind `id`. */
export function readId(value: unknown, keys: ObjectKeys, options: IdOptions = {}, depth = MAX_ID_DEPTH): string | undefined {
  if (isPlainObject(value)) return depth > 0 ? readId(firstPresent(value, keys.id), keys, options, depth - 1) : undefined;
  const id = typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  if (!id) return undefined;
  if (options.max !== undefined && id.length > options.max) return undefined;
  return options.pattern && !options.pattern.test(id) ? undefined : id;
}

/** Kind `scalar`. */
export function readScalar(value: unknown, max: number): string | undefined {
  return cleanUntrustedText(value, max) || undefined;
}

/** Kind `text`. */
export function readText(value: unknown, max: number, keys: ObjectKeys): string | undefined {
  if (typeof value === "string" || typeof value === "number") return cleanUntrustedText(value, max) || undefined;
  if (isPlainObject(value)) return cleanUntrustedText(firstPresent(value, keys.text), max) || undefined;
  return undefined;
}

/** Kind `entityName`. */
export function readEntityName(value: unknown, max: number, keys: ObjectKeys): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || /^\d+$/.test(trimmed)) return undefined;
    return cleanUntrustedText(trimmed, max) || undefined;
  }
  if (isPlainObject(value)) return cleanUntrustedText(firstPresent(value, keys.name), max) || undefined;
  return undefined;
}

/** Kind `person`. */
export function readPerson(value: unknown, max: number, keys: ObjectKeys): string | undefined {
  return readEntityName(value, max, keys) ?? readText(value, max, keys);
}

const NULL_DATE = /^(?:0001|1900|1970)-01-01\b/;

/** Kind `date`. */
export function readDate(value: unknown): string | undefined {
  const cleaned = cleanUntrustedText(value, 40);
  if (!cleaned || NULL_DATE.test(cleaned)) return undefined;
  return /^(\d{4}-\d{2}-\d{2})/.exec(cleaned)?.[1] ?? cleaned;
}

/** Kind `plain`: `keepEmpty` for a time log's comment, where a present `""` stays `""`. */
export function readPlain(value: unknown, max: number, keepEmpty = false): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = cleanTitle(value, max);
  return cleaned || keepEmpty ? cleaned : undefined;
}

/** Kind `time`: epoch milliseconds. */
export function readTime(value: unknown, timeZone?: string | null): number | undefined {
  if (typeof value === "string") return parseDateTimeInZone(value, timeZone);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

/** First valid wins: the first path whose value (not null) `read` makes something of. */
export function firstValid<T>(obj: unknown, paths: readonly string[] | undefined, read: (value: unknown, path: string) => T | undefined): T | undefined {
  for (const path of paths ?? []) {
    const value = readPath(obj, path);
    if (value === undefined || value === null) continue;
    const result = read(value, path);
    if (result !== undefined) return result;
  }
  return undefined;
}

/** `projectName` / `customerName`: a path shared with the entity's ID paths is the entity, any other is its name. */
export function readNameField(
  obj: unknown,
  namePaths: readonly string[] | undefined,
  idPaths: readonly string[] | undefined,
  max: number,
  keys: ObjectKeys,
): string | undefined {
  const entityPaths = new Set(idPaths ?? []);
  return firstValid(obj, namePaths, (value, path) => (entityPaths.has(path) ? readEntityName(value, max, keys) : readText(value, max, keys)));
}

// ---------------------------------------------------------------------------------------------------------------------
// The comment reader

/** Task-level paths a `latest` or `single` comment object falls back to for its author and ID. */
export interface CommentFallback {
  readonly by?: readonly string[];
  readonly id?: readonly string[];
}

/** `tasks.comments`: where a task's latest comment is, and what its parts are called. */
export interface CommentPaths {
  /** Arrays of comments: the last item is the latest. */
  readonly list?: readonly string[];
  /** The latest comment, a string or an object. */
  readonly latest?: readonly string[];
  /** A single comment, a string or an object. */
  readonly single?: readonly string[];
  /** In a comment object: its text, author and ID. */
  readonly text: readonly string[];
  readonly by?: readonly string[];
  readonly id?: readonly string[];
  /** On the task, for a comment that is a string: its author and version. */
  readonly taskBy?: readonly string[];
  readonly taskVersion?: readonly string[];
  readonly latestFallback?: CommentFallback;
  readonly singleFallback?: CommentFallback;
}

export interface CommentFields {
  comment?: string;
  commentBy?: string;
  commentKey?: string;
}

const COMMENT_MAX = 600;
const BY_MAX = 80;

const isComment = (value: unknown): boolean => typeof value === "string" || isPlainObject(value);

function fields(comment: string | undefined, commentBy: string | undefined, commentKey: string | undefined): CommentFields {
  return { ...(comment ? { comment } : {}), ...(commentBy ? { commentBy } : {}), ...(commentKey ? { commentKey } : {}) };
}

function readCommentObject(obj: JsonObject, paths: CommentPaths, keys: ObjectKeys) {
  return {
    comment: firstValid(obj, paths.text, (v) => readScalar(v, COMMENT_MAX)),
    by: firstValid(obj, paths.by, (v) => readPerson(v, BY_MAX, keys)),
    id: firstValid(obj, paths.id, (v) => readId(v, keys)),
  };
}

/**
 * A task's latest comment and the key the watcher compares: byte-identical to the adapter's
 * `extractCommentFields` when the paths are its key lists, except that the first valid path wins (D6).
 *
 * 1. `list`: a non-empty array whose last item is a string or an object. A string gives the key `<n>:<comment>`; an
 *    object gives `<n>:<id>:<comment or "">` or `<n>:<comment>`.
 * 2. Else `latest`, else `single`, when the value is a string or an object. A string takes its author and version from
 *    the task (`taskBy`, `taskVersion`): `<version>:<comment>` or `<comment>`. An object is read like a list item,
 *    its author and ID falling back to the task-level paths of `latestFallback` or `singleFallback`:
 *    `<id>:<comment or "">` or `<comment>`.
 */
export function readComment(task: JsonObject, paths: CommentPaths, keys: ObjectKeys): CommentFields {
  const list = firstValid(task, paths.list, (v) => (Array.isArray(v) && v.length > 0 && isComment(v.at(-1)) ? v : undefined));
  if (list) {
    const last: unknown = list.at(-1);
    if (typeof last === "string") {
      const comment = readScalar(last, COMMENT_MAX);
      return fields(comment, undefined, comment ? `${list.length}:${comment}` : undefined);
    }
    const { comment, by, id } = readCommentObject(last as JsonObject, paths, keys);
    return fields(comment, by, id ? `${list.length}:${id}:${comment ?? ""}` : comment ? `${list.length}:${comment}` : undefined);
  }

  const slots: Array<[readonly string[] | undefined, CommentFallback | undefined]> = [
    [paths.latest, paths.latestFallback],
    [paths.single, paths.singleFallback],
  ];
  for (const [slot, fallback] of slots) {
    const value = firstValid(task, slot, (v) => (isComment(v) ? v : undefined));
    if (value === undefined) continue;
    if (typeof value === "string") {
      const comment = readScalar(value, COMMENT_MAX);
      const by = firstValid(task, paths.taskBy, (v) => readText(v, BY_MAX, keys));
      const version = firstValid(task, paths.taskVersion, (v) => readId(v, keys));
      return fields(comment, by, version && comment ? `${version}:${comment}` : comment);
    }
    const read = readCommentObject(value as JsonObject, paths, keys);
    const by = read.by ?? firstValid(task, fallback?.by, (v) => readText(v, BY_MAX, keys));
    const id = read.id ?? firstValid(task, fallback?.id, (v) => readId(v, keys));
    return fields(read.comment, by, id ? `${id}:${read.comment ?? ""}` : read.comment);
  }
  return {};
}
