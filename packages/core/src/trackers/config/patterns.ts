/**
 * Task-ID patterns in a tracker config and the regexes the engine builds around them
 * (docs/trackers.md, "What the loader refuses"). Config text is never compiled as a regex except an ID pattern, and an ID
 * pattern is a restricted grammar, parsed here and written out again in a canonical form that is valid with and
 * without the `u` flag:
 *
 * - atoms: letters, digits, `_` and `-`; `\.`, `\-`, `\/`, `\#`, `\:`; `\d`, `\w`, `\s`; classes `[...]` and
 *   `[^...]` of letters, digits, same-kind ranges (`a-z`, `A-Z`, `0-9`), those escapes, `\[`, `\]`, `\\` and other
 *   ASCII punctuation (`-` only first or last);
 * - repeats: `?`, `{m}` and `{m,n}` with `n ≤ 64`, one per atom; no `*`, `+` or `{m,}`;
 * - no groups, alternatives, anchors, `.`, backreferences or lookaround; at most 100 characters;
 * - for the IDs of references found in text (`taskRef.id`, `taskRef.idInText`), nothing that can match whitespace or `/`.
 *
 * Structural bounds, not a timing gate: an ID matches 1 to 64 characters, and the product of the ranges of the
 * variable-length atoms is at most 256 (so `a?a?…a?aaa…` can't backtrack exponentially). The regexes built around a
 * pattern have fixed shapes with escaped literals and bounded separators (`\s{0,3}`, `\s{1,3}`); the tracker scans
 * `scanText(text, 5,000)` (branch names `scanText(branch, 300)`), which never shortens a reference. An adversarial
 * probe runs as a unit test.
 */

export const MAX_PATTERN_LENGTH = 100;
/** The longest ID a pattern may match (the `id` kind's maximum length). */
export const MAX_ID_LENGTH = 64;
const MAX_REPEAT = 64;
/** The product of the ranges of a pattern's variable-length atoms. */
export const MAX_AMBIGUITY = 256;
/** How much of a text the tracker scans for references, and of a branch name. */
export const MAX_SCAN_TEXT = 5_000;
export const MAX_BRANCH = 300;
export const MAX_URL_PATTERN = 200;
export const MAX_URL_TEMPLATE = 300;

/**
 * The part of `text` a reference scan may read: all of it up to `max` characters; for a longer text, its first `max`
 * characters, cut back to the last whitespace or `/` when the cut falls inside a word (so a reference the cut would
 * shorten, such as `task 12345` of `task 123456`, is dropped, never read as another one; a pattern for IDs in text
 * can't match whitespace or `/`, so an ID is always inside one word). However long that word is, the whole of it goes
 * (`task 123456-` and 6,000 more characters reads nothing, for a branch the segment likewise); no boundary: nothing.
 */
export function scanText(text: string, max: number): string {
  if (text.length <= max) return text;
  const window = text.slice(0, max);
  if (/[\s/]/.test(text[max]!)) return window;
  for (let i = window.length - 1; i >= 0; i--) {
    if (/[\s/]/.test(window[i]!)) return window.slice(0, i);
  }
  return "";
}

type ClassEscape = "d" | "w" | "s";
type SetItem = { kind: "char"; ch: string } | { kind: "range"; from: string; to: string } | { kind: "class"; name: ClassEscape };
type Atom = { kind: "char"; ch: string } | { kind: "class"; name: ClassEscape } | { kind: "set"; negated: boolean; items: SetItem[] };
interface Piece {
  atom: Atom;
  min: number;
  max: number;
  repeated: boolean;
}

/** A checked ID pattern: its canonical source and how long a match can be. */
export interface IdPattern {
  readonly source: string;
  readonly minLength: number;
  readonly maxLength: number;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const LETTER_OR_DIGIT = /^[A-Za-z0-9]$/;
const LITERAL = /^[A-Za-z0-9_-]$/;
const ESCAPES = new Set([".", "-", "/", "#", ":"]);
const SET_ESCAPES = new Set([".", "-", "/", "#", ":", "[", "]", "\\"]);
const SET_PUNCTUATION = new Set([..."!\"#$%&'()*+,./:;<=>?@^_`{|}~"]);

const kindOf = (ch: string) => (/[0-9]/.test(ch) ? "digit" : /[a-z]/.test(ch) ? "lower" : "upper");
const fail = <T>(error: string): Parsed<T> => ({ ok: false, error });
const at = (i: number) => `at character ${i + 1}`;

function parseSet(text: string, start: number): Parsed<{ atom: Atom; end: number }> {
  let i = start + 1;
  const negated = text[i] === "^";
  if (negated) i++;
  const first = i;
  const items: SetItem[] = [];
  while (i < text.length && text[i] !== "]") {
    const ch = text[i]!;
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === "d" || next === "w" || next === "s") items.push({ kind: "class", name: next });
      else if (next !== undefined && SET_ESCAPES.has(next)) items.push({ kind: "char", ch: next });
      else return fail(`${at(i)}: "\\${next ?? ""}" isn't an escape a class can hold`);
      i += 2;
      continue;
    }
    if (ch === "-") {
      if (i !== first && text[i + 1] !== "]") return fail(`${at(i)}: "-" in a class goes first or last, or between the ends of a range`);
      items.push({ kind: "char", ch });
      i++;
      continue;
    }
    if (LETTER_OR_DIGIT.test(ch) && text[i + 1] === "-" && text[i + 2] !== undefined && text[i + 2] !== "]") {
      const to = text[i + 2]!;
      if (!LETTER_OR_DIGIT.test(to) || kindOf(ch) !== kindOf(to) || to < ch) {
        return fail(`${at(i)}: "${ch}-${to}" isn't a range: use a-z, A-Z, 0-9 or part of one`);
      }
      items.push({ kind: "range", from: ch, to });
      i += 3;
      continue;
    }
    if (LETTER_OR_DIGIT.test(ch) || SET_PUNCTUATION.has(ch)) {
      items.push({ kind: "char", ch });
      i++;
      continue;
    }
    if (ch === "[") return fail(`${at(i)}: "[" inside a class is written \\[`);
    return fail(`${at(i)}: ${JSON.stringify(ch)} can't be in a class`);
  }
  if (i >= text.length) return fail(`${at(start)}: the class isn't closed with "]"`);
  if (items.length === 0) return fail(`${at(start)}: an empty class matches nothing`);
  return { ok: true, value: { atom: { kind: "set", negated, items }, end: i + 1 } };
}

function parsePieces(text: string): Parsed<Piece[]> {
  const pieces: Piece[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "?" || ch === "{") {
      const last = pieces.at(-1);
      if (!last) return fail(`${at(i)}: "${ch}" repeats what comes before it, and nothing does`);
      if (last.repeated) return fail(`${at(i)}: only one repeat per character or class`);
      if (ch === "?") {
        last.min = 0;
        last.max = 1;
        i++;
      } else {
        const m = /^\{(\d{1,2})(?:,(\d{1,2}))?\}/.exec(text.slice(i));
        if (!m) return fail(`${at(i)}: a repeat is written {m} or {m,n}, with n at most ${MAX_REPEAT}`);
        const min = Number(m[1]);
        const max = m[2] === undefined ? min : Number(m[2]);
        if (max > MAX_REPEAT) return fail(`${at(i)}: a repeat goes up to ${MAX_REPEAT} at most`);
        if (min > max) return fail(`${at(i)}: in {m,n}, m can't be more than n`);
        last.min = min;
        last.max = max;
        i += m[0].length;
      }
      last.repeated = true;
      continue;
    }
    let atom: Atom;
    if (ch === "[") {
      const set = parseSet(text, i);
      if (!set.ok) return set;
      atom = set.value.atom;
      i = set.value.end;
    } else if (ch === "\\") {
      const next = text[i + 1];
      if (next === "d" || next === "w" || next === "s") atom = { kind: "class", name: next };
      else if (next !== undefined && ESCAPES.has(next)) atom = { kind: "char", ch: next };
      else return fail(`${at(i)}: "\\${next ?? ""}" isn't allowed; the escapes are \\d \\w \\s \\. \\- \\/ \\# \\:`);
      i += 2;
    } else if (LITERAL.test(ch)) {
      atom = { kind: "char", ch };
      i++;
    } else if (ch === "*" || ch === "+") {
      return fail(`${at(i)}: "${ch}" isn't allowed: write {m,n} with n at most ${MAX_REPEAT}`);
    } else if (ch === "(" || ch === ")" || ch === "|") {
      return fail(`${at(i)}: groups and alternatives aren't allowed`);
    } else if (ch === "^" || ch === "$") {
      return fail(`${at(i)}: anchors aren't needed: a pattern always matches a whole ID`);
    } else if (ch === ".") {
      return fail(`${at(i)}: "." is written \\. (any character isn't allowed: use a class such as [^\\s,])`);
    } else {
      return fail(`${at(i)}: ${JSON.stringify(ch)} isn't allowed${ch === "#" || ch === ":" || ch === "/" ? ` (write \\${ch})` : ""}`);
    }
    pieces.push({ atom, min: 1, max: 1, repeated: false });
  }
  return { ok: true, value: pieces };
}

const CLASS_SOURCE: Record<ClassEscape, string> = { d: "\\d", w: "\\w", s: "\\s" };

function emitChar(ch: string): string {
  if (ch === ".") return "\\.";
  if (ch === "/") return "\\/";
  return ch; // letters, digits, _, -, #, : are literals outside a class with and without the u flag
}

function emitSetChar(ch: string): string {
  if (ch === "-" || ch === "\\" || ch === "]" || ch === "[" || ch === "^") return `\\${ch}`;
  return ch;
}

function emitAtom(atom: Atom): string {
  if (atom.kind === "char") return emitChar(atom.ch);
  if (atom.kind === "class") return CLASS_SOURCE[atom.name];
  const items = atom.items.map((item) =>
    item.kind === "char" ? emitSetChar(item.ch) : item.kind === "range" ? `${item.from}-${item.to}` : CLASS_SOURCE[item.name],
  );
  return `[${atom.negated ? "^" : ""}${items.join("")}]`;
}

function emitRepeat(piece: Piece): string {
  if (piece.min === 1 && piece.max === 1) return "";
  if (piece.min === 0 && piece.max === 1) return "?";
  return piece.min === piece.max ? `{${piece.min}}` : `{${piece.min},${piece.max}}`;
}

/**
 * Whether an atom can match whitespace or `/`: `\s`, `/`, a class holding either, or a negated class that doesn't leave
 * out both. A reference in text is cut back at whitespace and `/` (`scanText`), so an ID that could hold them could be
 * shortened by the cut and still match.
 */
function canMatchBreak(atom: Atom): boolean {
  if (atom.kind === "char") return atom.ch === "/";
  if (atom.kind === "class") return atom.name === "s";
  const hasSpace = atom.items.some((item) => item.kind === "class" && item.name === "s");
  const hasSlash = atom.items.some((item) => item.kind === "char" && item.ch === "/");
  return atom.negated ? !(hasSpace && hasSlash) : hasSpace || hasSlash;
}

/**
 * Checks an ID pattern against the grammar and the bounds, and gives its canonical source. A pattern for IDs found in
 * text (`scanned`) can't match whitespace or `/` (see `canMatchBreak`).
 */
export function parseIdPattern(text: string, scanned = false): Parsed<IdPattern> {
  if (typeof text !== "string" || text.length === 0) return fail("is empty");
  if (text.length > MAX_PATTERN_LENGTH) return fail(`is longer than ${MAX_PATTERN_LENGTH} characters`);
  const parsed = parsePieces(text);
  if (!parsed.ok) return parsed;
  const pieces = parsed.value;
  if (scanned && pieces.some((p) => canMatchBreak(p.atom))) {
    return fail("can match whitespace or \"/\": an ID found in text must be one word, so a text cut at either never shortens it (use \\d, \\w or a class without them; a negated class must leave out \\s and /)");
  }
  const minLength = pieces.reduce((sum, p) => sum + p.min, 0);
  const maxLength = pieces.reduce((sum, p) => sum + p.max, 0);
  const ambiguity = pieces.reduce((product, p) => product * (p.max - p.min + 1), 1);
  if (minLength < 1) return fail("matches an empty ID");
  if (maxLength > MAX_ID_LENGTH) return fail(`matches IDs of up to ${maxLength} characters; the most is ${MAX_ID_LENGTH}`);
  if (ambiguity > MAX_AMBIGUITY) {
    return fail(`has too many ways to match (${ambiguity}; the most is ${MAX_AMBIGUITY}): use fewer optional or {m,n} parts`);
  }
  const source = pieces.map((p) => emitAtom(p.atom) + emitRepeat(p)).join("");
  return { ok: true, value: { source, minLength, maxLength } };
}

/** A whole-ID check (no `u` flag: with it, `i` would fold the long s and the Kelvin sign into `s` and `k`). */
export function idMatcher(pattern: IdPattern, caseInsensitive: boolean): RegExp {
  return new RegExp(`^(?:${pattern.source})$`, caseInsensitive ? "i" : "");
}

// ---------------------------------------------------------------------------------------------------------------------
// URLs

/** A task-reference URL pattern (`host/path/{id}`): the literal text around `{id}`. */
export interface UrlPattern {
  readonly before: string;
  readonly after: string;
}

const HOST = "[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\\d{1,5})?";
const PATH_CHARS = "[A-Za-z0-9._~!$&'()*+,;=:@%/-]";
const URL_BEFORE = new RegExp(`^${HOST}/${PATH_CHARS}*$`);
const URL_AFTER = new RegExp(`^${PATH_CHARS}*$`);

/** `host/path/{id}`: no scheme (both are read), exactly one `{id}`, in the path. */
export function parseUrlPattern(text: string): Parsed<UrlPattern> {
  if (typeof text !== "string" || text.length === 0) return fail("is empty");
  if (text.length > MAX_URL_PATTERN) return fail(`is longer than ${MAX_URL_PATTERN} characters`);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return fail("starts with a scheme: write the host and path only (http and https are both read)");
  const parts = text.split("{id}");
  if (parts.length !== 2) return fail("needs exactly one {id}");
  const [before, after] = parts as [string, string];
  if (!URL_BEFORE.test(before)) return fail("needs a host, then a path that holds {id} (letters, digits and URL punctuation only)");
  if (!URL_AFTER.test(after)) return fail("has characters after {id} that a URL path can't hold");
  return { ok: true, value: { before, after } };
}

const SAMPLE_ID = "ID-12345";

/** `info.urlTemplate`: https only, exactly one `{id}`, in the path or query, never in the host. */
export function checkUrlTemplate(text: string): string | undefined {
  if (text.length > MAX_URL_TEMPLATE) return `is longer than ${MAX_URL_TEMPLATE} characters`;
  if (/[\s\p{C}]/u.test(text)) return "has spaces or control characters";
  const parts = text.split("{id}");
  if (parts.length !== 2) return "needs exactly one {id}";
  if (/[{}]/.test(parts.join(""))) return "has a brace that isn't part of {id}";
  if (!/^https:\/\/[^/?#{}]+[/?#]/i.test(parts[0]!)) return "must start with https:// and a host, with {id} after the host";
  let url: URL;
  try {
    url = new URL(text.replace("{id}", SAMPLE_ID));
  } catch {
    return "isn't a valid URL";
  }
  if (url.protocol !== "https:") return "must start with https://";
  if (url.username || url.password) return "can't hold a user name or password";
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// The regexes around an ID pattern

/** A literal for a regex, valid with and without `u`: syntax characters escaped, a run of whitespace as `\s{1,3}`. */
export function escapeLiteral(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&"))
    .join("\\s{1,3}");
}

const alternation = (words: readonly string[]) =>
  [...new Set(words.map((w) => w.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map(escapeLiteral)
    .join("|");

/** Not a letter, digit or `_` (Unicode-aware): the edges of a reference in free text. */
const EDGE_BEFORE = "(?:^|[^\\p{L}\\p{N}_])";
const EDGE_AFTER = "(?=$|[^\\p{L}\\p{N}_])";
const SEPARATOR = "\\s{0,3}(?:[:#/-]|\\s)\\s{0,3}#?";

export interface TaskRefInput {
  id: IdPattern;
  idInText: IdPattern;
  prefixes: readonly string[];
  keywords: readonly string[];
  bare: boolean;
  urls: readonly UrlPattern[];
  caseInsensitive: boolean;
}

export interface TaskRefRegexes {
  /** A whole input that is a task URL (`parseTaskRef`). One group per URL; `firstGroup` reads the one that matched. */
  urlExact?: RegExp;
  /** Task URLs in free text, the first by position winning (global). */
  urlInText?: RegExp;
  /** A whole input that is an ID, with `#` or a prefix. */
  directId: RegExp;
  /** A keyword, a separator and an ID in free text (global). */
  keywordInText?: RegExp;
  /** An ID on its own in free text, for self-describing keys (global). */
  bare?: RegExp;
  /** A branch-name segment that starts with an ID. */
  branchSegment: RegExp;
  /** Whole-ID checks: matching is case-insensitive, then a capture is checked with these. */
  id: RegExp;
  idInText: RegExp;
}

/** Every regex `parseTaskRef`, `extractTaskRef` and `taskRefFromBranch` use, built from the config's checked parts. */
export function buildTaskRefRegexes(input: TaskRefInput): TaskRefRegexes {
  const id = `(${input.id.source})`;
  const idInText = `(${input.idInText.source})`;
  // In text, a link ends at a word edge when it ends in a word character (the ID, or `.html`); a link that ends in
  // another character (a trailing `/`) already ends there, and `\b` after it would demand a word character next.
  const urlEnd = (u: UrlPattern) => (u.after === "" || /\w$/.test(u.after) ? "\\b" : "");
  const urlAlternatives = (group: string, inText = false) =>
    input.urls.map((u) => `${escapeLiteral(u.before)}${group}${escapeLiteral(u.after)}${inText ? urlEnd(u) : ""}`).join("|");
  const prefixes = alternation(input.prefixes);
  const keywords = alternation(input.keywords);
  return {
    ...(input.urls.length > 0
      ? {
          urlExact: new RegExp(`^(?:https?://)?(?:${urlAlternatives(id)})(?:[/?#].*)?$`, "i"),
          urlInText: new RegExp(`(?:https?://|\\b)(?:${urlAlternatives(id, true)})`, "gi"),
        }
      : {}),
    directId: new RegExp(prefixes ? `^(?:#|(?:${prefixes})\\s{0,3}[:#/-]?\\s{0,3}#?)?${id}$` : `^#?${id}$`, "i"),
    ...(keywords ? { keywordInText: new RegExp(`${EDGE_BEFORE}(?:${keywords})${SEPARATOR}${idInText}${EDGE_AFTER}`, "giu") } : {}),
    ...(input.bare ? { bare: new RegExp(`${EDGE_BEFORE}${idInText}${EDGE_AFTER}`, "giu") } : {}),
    branchSegment: new RegExp(`^${idInText}(?:[-_].*|$)`, "i"),
    id: idMatcher(input.id, input.caseInsensitive),
    idInText: idMatcher(input.idInText, input.caseInsensitive),
  };
}

/** The group that matched, for a regex with one group per alternative. */
export const firstGroup = (match: RegExpExecArray | null): string | undefined => match?.slice(1).find((g) => g !== undefined);
