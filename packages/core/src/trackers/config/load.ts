/**
 * Listing, reading and validating tracker configs (docs/trackers.md, "Setting one up" and "What the loader refuses").
 *
 * Configs live in `<dataDir>/trackers/<id>.json`; the file name must equal the config's id. A config loads whole or
 * not at all: at most 256 KB, `JSON.parse`, the schema and its cross-checks. Errors come as `path: message` lines, at
 * most 10 of at most 200 characters, with no control characters, for the Integrations view and the notice. Each config
 * has a hash: the first 8 hex digits of SHA-256 of its canonical JSON (`JSON.stringify(JSON.parse(text))`: whitespace,
 * line endings and a byte-order mark don't change it; key order does, since it is the order of the arguments sent).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { isTrackerId, TrackerConfigSchema, type TrackerConfig } from "./schema.ts";

export const MAX_CONFIG_BYTES = 256 * 1024;
export const MAX_ERROR_LINES = 10;
export const MAX_ERROR_LINE_CHARS = 200;
export const TRACKERS_FOLDER = "trackers";
const EXTENSION = ".json";
/** What an invisible character shows as in an error line. */
const REPLACEMENT = String.fromCharCode(0xfffd);

export type ParsedConfig = { ok: true; config: TrackerConfig; hash: string } | { ok: false; errors: string[] };

/** One file of the trackers folder: its config, or why it can't be used. */
export type ConfigListing =
  | { file: string; id: string; ok: true; config: TrackerConfig; hash: string }
  | { file: string; id: string; ok: false; errors: string[] };

export const trackersDir = (dataDir: string) => path.join(dataDir, TRACKERS_FOLDER);

const BAD_FILE_NAME = "the file name isn't <id>.json, with an id of 2 to 32 lower-case letters, digits or -, starting with a letter (not none or default)";

const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** The canonical JSON a hash is taken of. */
export const canonicalJson = (text: string): string => JSON.stringify(JSON.parse(stripBom(text)));

const hashOf = (canonical: string): string => createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 8);

/** The first 8 hex digits of SHA-256 of the canonical JSON. */
export const configHash = (text: string): string => hashOf(canonicalJson(text));

function formatPath(issuePath: readonly PropertyKey[]): string {
  let out = "";
  for (const part of issuePath) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One zod issue as plain words. */
function describe(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "unrecognized_keys":
      return `unknown key${issue.keys.length === 1 ? "" : "s"} ${issue.keys.map((k) => JSON.stringify(k)).join(", ")}`;
    case "invalid_type": {
      if (/received undefined$/.test(issue.message)) return "is missing";
      const kind = issue.expected === "array" ? "list" : issue.expected === "record" ? "object" : issue.expected;
      return `should be ${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`;
    }
    case "too_small": {
      const n = Number(issue.minimum);
      if (issue.origin === "string") return n === 1 ? "is empty" : `needs at least ${plural(n, "character")}`;
      if (issue.origin === "array") return `needs at least ${plural(n, "item")}`;
      return `is less than ${n}`;
    }
    case "too_big": {
      const n = Number(issue.maximum);
      if (issue.origin === "string") return `has more than ${plural(n, "character")}`;
      if (issue.origin === "array") return `has more than ${plural(n, "item")}`;
      return `is more than ${n}`;
    }
    case "invalid_value":
      return issue.values.length === 1 ? `should be ${JSON.stringify(issue.values[0])}` : `should be one of ${issue.values.map((v) => JSON.stringify(v)).join(", ")}`;
    case "invalid_format":
      // The schema's own message when it gave one (tool names); zod's start with "Invalid".
      return /^Invalid\b/.test(issue.message) ? "has characters that aren't allowed" : issue.message;
    case "invalid_key":
      return `has a key that isn't allowed: ${issue.issues.map((i) => describe(i as z.core.$ZodIssue)).join("; ")}`;
    default:
      return issue.message;
  }
}

/**
 * A line of text the file shaped (a key, a value, a parser's message): one line, control characters as spaces,
 * invisible format characters (zero-width, bidirectional) shown as U+FFFD, so what the file holds can't hide, cut.
 */
function tidy(line: string): string {
  const flat = line.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").replace(/\p{Cf}/gu, REPLACEMENT);
  if (flat.length <= MAX_ERROR_LINE_CHARS) return flat;
  return `${[...flat].slice(0, MAX_ERROR_LINE_CHARS - 1).join("")}…`;
}

/** Error lines, at most 10, the last saying how many more there are. */
function capped(lines: string[]): string[] {
  if (lines.length <= MAX_ERROR_LINES) return lines;
  return [...lines.slice(0, MAX_ERROR_LINES - 1), `… and ${lines.length - (MAX_ERROR_LINES - 1)} more`];
}

function fail(errors: readonly string[]): { ok: false; errors: string[] } {
  return { ok: false, errors: capped(errors.map(tidy)) };
}

/** The text of a config file, checked: JSON, the schema, and (when given) the id its file name says. */
export function parseTrackerConfig(text: string, expectedId?: string): ParsedConfig {
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) return fail([`the file is larger than ${MAX_CONFIG_BYTES / 1024} KB`]);
  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(text));
  } catch (error) {
    return fail([`the file isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`]);
  }
  const result = TrackerConfigSchema.safeParse(raw);
  if (!result.success) return fail(result.error.issues.map((issue) => `${formatPath(issue.path) || "the config"}: ${describe(issue)}`));
  if (expectedId !== undefined && result.data.id !== expectedId) {
    return fail([`id: is "${result.data.id}", but the file is called ${expectedId}.json; they must be the same`]);
  }
  return { ok: true, config: result.data, hash: hashOf(JSON.stringify(raw)) };
}

function readConfigFile(file: string, id: string): ParsedConfig {
  let stat: Stats;
  try {
    stat = statSync(file);
  } catch {
    return fail([`there is no ${id}${EXTENSION} in the trackers folder`]);
  }
  if (!stat.isFile()) return fail([`${id}${EXTENSION} isn't a file`]);
  if (stat.size > MAX_CONFIG_BYTES) return fail([`the file is larger than ${MAX_CONFIG_BYTES / 1024} KB`]);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return fail([`the file can't be read: ${error instanceof Error ? error.message : String(error)}`]);
  }
  return parseTrackerConfig(text, id);
}

/**
 * The config with this id (`choice.config`), from `<dataDir>/trackers/<id>.json`. The id is checked against
 * `TRACKER_ID` before it becomes a file path.
 */
export function loadTrackerConfig(dataDir: string, id: string): ParsedConfig & { file?: string } {
  if (!isTrackerId(id)) return fail([`${JSON.stringify(id)} isn't a tracker id`]);
  const dir = trackersDir(dataDir);
  const name = `${id}${EXTENSION}`;
  const file = path.join(dir, name);
  // A case-insensitive disk would open `ACME.json` for `acme.json`; the listing calls that file misnamed, so don't.
  if (!hasExactName(dir, name)) return { ...fail([`there is no ${name} in the trackers folder`]), file };
  return { ...readConfigFile(file, id), file };
}

function hasExactName(dir: string, name: string): boolean {
  try {
    return readdirSync(dir).includes(name);
  } catch {
    return false;
  }
}

/**
 * Every file whose name ends in `.json` directly in the trackers folder (a link to a file counts), by file name;
 * none when the folder isn't there. A name other than `<id>.json` is listed with an error, so a misnamed file shows.
 */
export function listTrackerConfigs(dataDir: string): ConfigListing[] {
  const dir = trackersDir(dataDir);
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase().endsWith(EXTENSION))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  return names.map((file): ConfigListing => {
    const id = file.slice(0, -EXTENSION.length);
    if (!file.endsWith(EXTENSION) || !isTrackerId(id)) return { file, id, ...fail([BAD_FILE_NAME]) };
    return { file, id, ...readConfigFile(path.join(dir, file), id) };
  });
}
