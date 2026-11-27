/**
 * Git worktrees for tasks (PLAN.md §4.4, D14): one worktree and one `aria/<slug>` branch per task, under a short root
 * (`C:\wt`) because Windows path limits bite fast. ARIA only ever removes worktrees under that root and branches named
 * `aria/…`, so a bug can't touch your own folders or branches.
 */
import { isAscii, isUtf8 } from "node:buffer";
import { closeSync, existsSync, mkdirSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ENCODING_DAMAGE_MAX_PATHS, type EncodingDamage } from "@aria/protocol";
import { execa } from "execa";
import { insideDir } from "../conductor/policy.ts";
import { onlyWaitedFor } from "../util/ignore.ts";
import { cleanLine } from "./untrusted.ts";

const MAX_DIFF_CHARS = 1_000_000;
const MAX_FILE_PREVIEW_BYTES = 512 * 1024;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ARIA's own git runs outside the sandbox, on worktrees a task wrote: nothing in them gets to run a program through
 * it (an fsmonitor hook from worktree config; text conversion is turned off per diff).
 */
const HOST_GIT = ["-c", "core.longpaths=true", "-c", "core.fsmonitor=false"];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", [...HOST_GIT, "-C", cwd, ...args], { timeout: 120_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** A refname git accepts and that can't be read as an option. */
const SAFE_REF = /^(?!-)(?!.*\.\.)(?!.*\/\/)[\w./-]+(?<![./])$/;

/** Short, folder-safe slug from a title ("Add dark mode!" → "add-dark-mode"). */
export function slugify(title: string, max = 40): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return slug || "task";
}

/**
 * Where worktrees go: the configured root, else `C:\wt` (short paths, D14), else `~/.aria-wt` when `C:\wt` can't be
 * created (a locked-down account).
 */
export function resolveWorktreeRoot(configured?: string): string {
  const candidates = configured ? [configured] : process.platform === "win32" ? ["C:\\wt", path.join(os.homedir(), ".aria-wt")] : [path.join(os.homedir(), ".aria-wt")];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      mkdirSync(candidate, { recursive: true });
      return path.resolve(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Couldn't create a folder for task worktrees: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export interface Worktree {
  path: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
}

/** The branch a new worktree starts from when none is given: the project's default, else whatever is checked out. */
export async function currentBranch(repoPath: string): Promise<string | undefined> {
  const branch = await git(repoPath, ["branch", "--show-current"]).catch(() => "");
  return branch.trim() || undefined;
}

/** Creates `<root>\<repoSlug>\<slug>` on a new branch `aria/<slug>` from `base` (a local branch, else origin's). */
export async function createWorktree(options: {
  repoPath: string;
  root: string;
  repoName: string;
  slug: string;
  base: string;
  /** Takes a free name for this task, or says it's another task's (names are unique across repositories). */
  claim?: (name: string) => boolean;
  /** Start from this commit instead of the branch's tip (item 4: the commit a red CI run ran on). */
  baseCommit?: string;
}): Promise<Worktree> {
  const { repoPath, root, base } = options;
  if (!SAFE_REF.test(base)) throw new Error(`${base} isn't a branch name ARIA can use.`);
  const resolve = (ref: string) => git(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).then((sha) => sha.trim(), () => "");
  const baseCommit = options.baseCommit !== undefined ? (/^[0-9a-f]{40,64}$/.test(options.baseCommit) ? await resolve(options.baseCommit) : "") : (await resolve(`refs/heads/${base}`)) || (await resolve(`refs/remotes/origin/${base}`));
  if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) throw new Error(options.baseCommit !== undefined ? `The commit ${options.baseCommit.slice(0, 7)} isn't in ${repoPath}.` : `There's no branch ${base} in ${repoPath}.`);

  // One at a time per repository: two tasks with the same title would otherwise both pick the same free name.
  return oneAtATime(repoPath, async () => {
    const parent = path.join(root, slugify(options.repoName, 30));
    let name = options.slug;
    for (let i = 2; ; i++) {
      const taken = existsSync(path.join(parent, name)) || (await resolve(`refs/heads/aria/${name}`)) !== "" || (options.claim !== undefined && !options.claim(name));
      if (!taken) break;
      name = `${options.slug}-${i}`;
    }
    const dir = path.join(parent, name);
    const branch = `aria/${name}`;
    mkdirSync(parent, { recursive: true });
    await git(repoPath, ["worktree", "add", "--quiet", "-b", branch, dir, baseCommit]);
    return { path: dir, branch, baseBranch: base, baseCommit };
  });
}

/**
 * A new worktree on an existing `aria/` branch (item 4, D46: a task adopting another's branch). Stale registrations
 * go first (`worktree prune`: a cleaned-up task's folder that's gone). `force`: the branch is still checked out in the
 * adopted-from task's worktree (it's held at its budget and stopped; it never continues on it again).
 */
export async function adoptWorktree(options: { repoPath: string; root: string; repoName: string; branch: string; force: boolean }): Promise<{ path: string }> {
  const { repoPath, root, branch } = options;
  if (!branch.startsWith("aria/") || !SAFE_REF.test(branch)) throw new Error(`${branch} isn't an ARIA branch.`);
  const tip = await git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]).then((sha) => sha.trim(), () => "");
  if (!/^[0-9a-f]{40,64}$/.test(tip)) throw new Error(`The branch ${branch} isn't in ${repoPath} anymore.`);
  return oneAtATime(repoPath, async () => {
    await git(repoPath, ["worktree", "prune"]);
    const parent = path.join(root, slugify(options.repoName, 30));
    const base = branch.slice("aria/".length).replace(/[\\/]/g, "-");
    let dir = path.join(parent, base);
    for (let i = 2; existsSync(dir); i++) dir = path.join(parent, `${base}-${i}`);
    mkdirSync(parent, { recursive: true });
    await git(repoPath, ["worktree", "add", "--quiet", ...(options.force ? ["--force"] : []), dir, branch]);
    return { path: dir };
  });
}

const repoLocks = new Map<string, Promise<unknown>>();

async function oneAtATime<T>(repoPath: string, work: () => Promise<T>): Promise<T> {
  const key = pathKey(repoPath);
  const result = (repoLocks.get(key) ?? Promise.resolve()).then(work);
  const settled = result.catch(onlyWaitedFor);
  repoLocks.set(key, settled);
  try {
    return await result;
  } finally {
    if (repoLocks.get(key) === settled) repoLocks.delete(key);
  }
}

/** Paths compare without case on Windows. */
const pathKey = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));

export interface DiffStat {
  /** Commits on the task's branch since its base. */
  commits: number;
  /** Committed changes since the base. */
  filesChanged: number;
  additions: number;
  deletions: number;
  /** Paths with changes that aren't committed (modified, staged or new). */
  uncommitted: number;
}

export async function diffStat(worktree: string, baseCommit: string): Promise<DiffStat> {
  const commits = Number((await git(worktree, ["rev-list", "--count", `${baseCommit}..HEAD`])).trim()) || 0;
  let filesChanged = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of (await git(worktree, ["diff", "--numstat", "--no-ext-diff", "--no-textconv", baseCommit, "HEAD"])).split(/\r?\n/)) {
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!match) continue;
    filesChanged++;
    additions += Number(match[1]) || 0;
    deletions += Number(match[2]) || 0;
  }
  const status = await git(worktree, ["status", "--porcelain", "--untracked-files=all"]);
  const uncommitted = status.split(/\r?\n/).filter((line) => line.trim()).length;
  return { commits, filesChanged, additions, deletions, uncommitted };
}

// ── R1: text damaged by a wrong encoding ──────────────────────────────────────────────────────────────────────────

/** What Windows-1252 shows for the bytes 0x80–0x9F (`€`, `†`), besides U+0080–U+009F for the five it leaves undefined. */
const CP1252_HIGH =
  "\\u0152\\u0153\\u0160\\u0161\\u0178\\u017D\\u017E\\u0192\\u02C6\\u02DC\\u2013\\u2014\\u2018-\\u201A\\u201C-\\u201E\\u2020-\\u2022\\u2026\\u2030\\u2039\\u203A\\u20AC\\u2122";
/** A UTF-8 continuation byte (0x80–0xBF) as Windows-1252 shows it. */
const C = `[\\u0080-\\u00BF${CP1252_HIGH}]`;
/** The same without a non-breaking space (0xA0). */
const C_NO_NBSP = `[\\u0080-\\u009F\\u00A1-\\u00BF${CP1252_HIGH}]`;
/**
 * A UTF-8 character read as Windows-1252: its lead byte, then its continuation bytes.
 * - Two bytes: only after `Â` or `Ã` (Latin-1 letters and signs: `é` is `Ã©`, `à` is `Ã` and a non-breaking space).
 *   `ß“` is German, not damage.
 * - Three bytes: once after `â` (dashes, quotes, arrows, `✓`, `€`) or `ï` (a byte-order mark, the replacement
 *   character), unless a non-breaking space follows it: `Hawaï »` is French, and E2 A0 and EF A0 start only Braille and
 *   private-use characters. After the other leads only twice in a row (damaged Chinese or Hindi), because one alone is
 *   often real text: `é`, a non-breaking space and `»` is French typography.
 * - Four bytes (emoji): after `ð` to `ô`.
 * The longest alternative first, so the same damage matches the same way in a file and on its base.
 */
const MOJIBAKE_SOURCE = `(?:[\\u00E0-\\u00EF]${C}{2}){2}|[\\u00E2\\u00EF]${C_NO_NBSP}${C}|[\\u00F0-\\u00F4]${C}{3}|[\\u00C2\\u00C3]${C}`;
const MOJIBAKE_ANY = new RegExp(MOJIBAKE_SOURCE);
const MOJIBAKE_ALL = new RegExp(MOJIBAKE_SOURCE, "g");
const BOM = "\uFEFF";
const REPLACEMENT = "\uFFFD";
const REPLACEMENT_BYTES = Buffer.from(REPLACEMENT, "utf8");
const NON_ASCII = /[\u0080-\uFFFF]/;
/** How far git looks for a NUL to call a file binary. */
const NUL_SCAN = 8000;
/** New files the check reads, at most, and how big: a finished task isn't held up by build output. */
const MAX_UNTRACKED_CHECKED = 200;
const MAX_NEW_FILE_BYTES = 512 * 1024;
/** Changed files git shows as binary whose first bytes are read, at most, to find those turned into UTF-16. */
const MAX_BINARY_CHECKED = 1000;
/** How much of a file turned into UTF-16 is read to count its lines. */
const MAX_UTF16_BYTES = 2 * 1024 * 1024;
/** A base bigger than this isn't read (a generated file), and how much `git cat-file` hands over at a time. */
const MAX_BASE_BYTES = 16 * 1024 * 1024;
const BASE_CHUNK_BYTES = 64 * 1024 * 1024;

/**
 * A line a diff adds: its text, whether its bytes were UTF-8 (where they weren't, the text has U+FFFD), and the line it
 * replaced when its run of changes removes as many lines as it adds (as `-U0` shows a rewrite).
 */
export interface AddedLine {
  text: string;
  utf8: boolean;
  was?: string;
}

/**
 * One file of a diff: its path on the base (unless it's new), the lines it adds that could be damaged text (any but
 * plain ASCII without a `?`), and `binary` when git showed none.
 */
export interface FileAdditions {
  path: string;
  basePath?: string;
  added: AddedLine[];
  binary?: true;
}

const decode = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");

/** A name git quoted (with core.quotePath off, only names with quotes, backslashes or control characters are). */
const unquote = (name: string) => (name.length > 1 && name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1).replace(/\\(["\\])/g, "$1") : name);

/** A `---`/`+++` header's path without its `a/` or `b/` (and the tab git adds after a name with a space); undefined for /dev/null. */
function headerPath(raw: string, prefix: string): string | undefined {
  const name = unquote(raw.replace(/\t$/, ""));
  if (name === "/dev/null") return undefined;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** The name in `diff --git a/x b/x` when both are the same (no rename); undefined when it can't be told (quoted names). */
function samePath(rest: string): string | undefined {
  const length = (rest.length - 5) / 2;
  if (!Number.isInteger(length) || length < 1 || !rest.startsWith("a/")) return undefined;
  const name = rest.slice(2, 2 + length);
  return rest.slice(2 + length) === ` b/${name}` ? name : undefined;
}

/**
 * What each file of a unified diff adds that could be damaged text, read from its bytes by the hunk headers' counts
 * (so an added `+++ x` is a line), and the files git showed as binary (`Binary files … differ`). A line of plain ASCII
 * without a `?` can't be damaged (see `suspect`), so it's skipped without being decoded, and a removed line is decoded
 * only to pair it with one that's kept: a big generated diff doesn't hold up ARIA.
 */
export function addedLines(diff: Uint8Array | string): FileAdditions[] {
  const bytes = typeof diff === "string" ? Buffer.from(diff, "utf8") : Buffer.from(diff.buffer, diff.byteOffset, diff.byteLength);
  const files: FileAdditions[] = [];
  let file: FileAdditions | undefined;
  let basePath: string | undefined;
  let header: { same?: string; from?: string; to?: string; isNew?: boolean; deleted?: boolean } = {};
  let oldLeft = 0;
  let newLeft = 0;
  // The current run of removed and added lines (a hunk, or its part between context lines); undefined for one skipped.
  let removed: Buffer[] = [];
  let added: Array<AddedLine | undefined> = [];
  const endRun = () => {
    if (removed.length === added.length) {
      added.forEach((line, i) => {
        if (line) line.was = decode(removed[i]!);
      });
    }
    removed = [];
    added = [];
  };
  for (let start = 0; start <= bytes.length; ) {
    let end = bytes.indexOf(0x0a, start);
    if (end < 0) end = bytes.length;
    let raw = bytes.subarray(start, end);
    start = end + 1;
    if (raw.at(-1) === 0x0d) raw = raw.subarray(0, -1);
    if (oldLeft > 0 || newLeft > 0) {
      const sign = raw[0];
      // "\ No newline at end of file".
      if (sign === 0x5c) continue;
      // An empty line is an empty context line under diff.suppressBlankEmpty (hunks fused by diff.interHunkContext).
      if (sign === undefined || sign === 0x2b || sign === 0x2d || sign === 0x20) {
        const body = raw.subarray(1);
        if (sign === 0x2b) {
          const line = isAscii(body) && !body.includes(0x3f) ? undefined : { text: decode(body), utf8: isUtf8(body) };
          added.push(line);
          if (line) file?.added.push(line);
          newLeft--;
        } else if (sign === 0x2d) {
          removed.push(body);
          oldLeft--;
        } else {
          endRun();
          oldLeft--;
          newLeft--;
        }
        if (oldLeft <= 0 && newLeft <= 0) endRun();
        continue;
      }
      // A diff cut off inside a hunk: what follows is read as headers again.
      oldLeft = 0;
      newLeft = 0;
      endRun();
    }
    const line = decode(raw);
    if (line.startsWith("diff --git ")) {
      file = undefined;
      basePath = undefined;
      header = { same: samePath(line.slice(11)) };
    } else if (line.startsWith("new file mode")) {
      header.isNew = true;
    } else if (line.startsWith("deleted file mode")) {
      header.deleted = true;
    } else if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
      header.from = unquote(line.slice(line.indexOf(" from ") + 6));
    } else if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
      header.to = unquote(line.slice(line.indexOf(" to ") + 4));
    } else if (line.startsWith("Binary files ")) {
      const name = header.to ?? header.same;
      if (name !== undefined && !header.deleted) files.push({ path: name, ...(header.isNew ? {} : { basePath: header.from ?? name }), added: [], binary: true });
    } else if (line.startsWith("--- ")) {
      basePath = headerPath(line.slice(4), "a/");
    } else if (line.startsWith("+++ ")) {
      const name = headerPath(line.slice(4), "b/");
      file = name === undefined ? undefined : { path: name, ...(basePath !== undefined ? { basePath } : {}), added: [] };
      if (file) files.push(file);
    } else {
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (hunk) {
        oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
        newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      }
    }
  }
  return files;
}

/** The line it replaced, with each non-ASCII character (each UTF-16 unit, as .NET writes them) as `?`. */
const questionMarked = (line: AddedLine) => line.was !== undefined && line.was !== line.text && NON_ASCII.test(line.was) && line.was.replace(/[\u0080-\uFFFF]/g, "?") === line.text;

/** Worth a closer look: one of `damagedLineCount`'s marks without its base. */
const suspect = (line: AddedLine) =>
  !line.utf8 || MOJIBAKE_ANY.test(line.text) || line.text.includes(REPLACEMENT) || line.text.includes(BOM) || questionMarked(line);

/**
 * How many of a file's added lines look damaged, given the file's bytes on the base (undefined for a new file):
 * - text that went through Windows-1252 (`â†’`), or a replacement character, that the base didn't have (a page about
 *   encodings, a test of this check);
 * - bytes that aren't UTF-8 in a file that was UTF-8: written back as Windows-1252 (`Set-Content` in 5.1). A file kept
 *   in a legacy encoding, or a new one, may mean them;
 * - the line it replaced with each non-ASCII character as `?` (`Set-Content` again, for characters 1252 doesn't have);
 * - a byte-order mark in a file that was there without one (a new file may want one: a Visual Studio solution has one).
 */
export function damagedLineCount(added: readonly AddedLine[], base?: Uint8Array): number {
  const baseText = base === undefined ? "" : decode(base);
  const known = new Set(baseText.match(MOJIBAKE_ALL) ?? []);
  const baseReplacement = base !== undefined && Buffer.from(base.buffer, base.byteOffset, base.byteLength).includes(REPLACEMENT_BYTES);
  const baseUtf8 = base !== undefined && isUtf8(base);
  const bom = base !== undefined && !baseText.includes(BOM);
  return added.filter((line) => {
    if (!line.utf8) return baseUtf8;
    if ((line.text.match(MOJIBAKE_ALL) ?? []).some((found) => !known.has(found))) return true;
    if (line.text.includes(REPLACEMENT) && !baseReplacement) return true;
    return questionMarked(line) || (bom && line.text.includes(BOM));
  }).length;
}

/** Starts with a UTF-16 byte-order mark. */
const startsUtf16 = (b: Uint8Array) => (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff);

/**
 * The lines of a text file the task turned into UTF-16 (`>` and `Out-File` in 5.1, which git then shows as binary);
 * 0 when it isn't that.
 */
export function utf16Lines(now: Uint8Array, base: Uint8Array): number {
  if (!startsUtf16(now) || startsUtf16(base) || base.subarray(0, NUL_SCAN).includes(0)) return 0;
  let text = new TextDecoder(now[0] === 0xff ? "utf-16le" : "utf-16be").decode(now);
  if (text.endsWith("\n")) text = text.slice(0, -1);
  return text.split("\n").length;
}

/** A plain file inside the worktree (no link out of it), read asynchronously up to `max` bytes; null otherwise. */
async function readInside(worktree: string, realWorktree: string, name: string, max: number): Promise<{ bytes: Buffer; size: number } | null> {
  const full = path.resolve(worktree, name);
  if (!insideDir(full, worktree)) return null;
  const info = await lstat(full);
  if (!info.isFile()) return null;
  const real = await realpath(full);
  if (!insideDir(real, realWorktree)) return null;
  const handle = await open(real, "r");
  try {
    const bytes = Buffer.alloc(Math.min(info.size, max));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return { bytes: bytes.subarray(0, bytesRead), size: info.size };
  } finally {
    await handle.close();
  }
}

/**
 * Hands `visit` each file's bytes on the base, from `git cat-file`, a chunk at a time so they're never all in memory.
 * A name it can't look up, or whose base is over MAX_BASE_BYTES, is left out.
 */
async function forEachBase(worktree: string, baseCommit: string, names: readonly string[], visit: (name: string, bytes: Buffer) => Promise<void>): Promise<void> {
  const wanted = [...new Set(names)].filter((name) => !/[\r\n]/.test(name));
  if (wanted.length === 0) return;
  const cat = async (mode: string, input: string, maxBuffer: number) => {
    const { stdout } = await execa("git", [...HOST_GIT, "-C", worktree, "cat-file", mode], { input, encoding: "buffer", timeout: 120_000, windowsHide: true, maxBuffer });
    return Buffer.from(stdout.buffer, stdout.byteOffset, stdout.byteLength);
  };
  // One line for each: "<sha> blob <size>", or "<what was asked> missing".
  const checked = (await cat("--batch-check", wanted.map((name) => `${baseCommit}:${name}\n`).join(""), 16 * 1024 * 1024)).toString("utf8").split("\n");
  const blobs: Array<{ name: string; sha: string; size: number }> = [];
  wanted.forEach((name, i) => {
    const found = /^([0-9a-f]+) blob (\d+)$/.exec(checked[i] ?? "");
    if (found && Number(found[2]) <= MAX_BASE_BYTES) blobs.push({ name, sha: found[1]!, size: Number(found[2]) });
  });
  for (let next = 0; next < blobs.length; ) {
    const chunk: typeof blobs = [];
    let total = 0;
    while (next < blobs.length && (chunk.length === 0 || total + blobs[next]!.size <= BASE_CHUNK_BYTES)) {
      total += blobs[next]!.size;
      chunk.push(blobs[next++]!);
    }
    // Each: "<sha> blob <size>", the content and a newline.
    const out = await cat("--batch", chunk.map((blob) => `${blob.sha}\n`).join(""), total + chunk.length * 128 + 1024);
    let at = 0;
    for (const blob of chunk) {
      const end = out.indexOf(0x0a, at);
      if (end < 0) break;
      const found = /^[0-9a-f]+ (\w+) (\d+)$/.exec(out.subarray(at, end).toString("utf8"));
      at = end + 1;
      if (!found) continue;
      const size = Number(found[2]);
      if (found[1] === "blob") await visit(blob.name, out.subarray(at, at + size));
      at += size + 1;
    }
  }
}

/**
 * R1: the lines a task added since its base, committed or not, that look like text damaged by a wrong encoding (`→`
 * read as Windows-1252 is `â†’`; see `damagedLineCount` and `utf16Lines`). Plain code, no model; undefined when there
 * are none.
 */
export async function encodingDamage(worktree: string, baseCommit: string): Promise<EncodingDamage | undefined> {
  let lines = 0;
  const paths: string[] = [];
  const note = (name: string, count: number) => {
    if (count === 0) return;
    lines += count;
    paths.push(name);
  };
  // Bytes, not text: which lines aren't UTF-8 is part of the answer. Names as they are, and the prefixes pinned
  // whatever diff.mnemonicPrefix or diff.noprefix say.
  const { stdout } = await execa(
    "git",
    [...HOST_GIT, "-c", "core.quotePath=false", "-C", worktree, "diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", baseCommit],
    { encoding: "buffer", timeout: 120_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  const realWorktree = await realpath(worktree);
  const parsed = addedLines(stdout);
  const texts = parsed.filter((file) => !file.binary && file.added.some(suspect));
  // Of the files git shows as binary (images too), only those that were there before and start as UTF-16 now.
  const binaries = parsed.filter((file) => file.binary && file.basePath !== undefined).slice(0, MAX_BINARY_CHECKED);
  const utf16: FileAdditions[] = [];
  for (let i = 0; i < binaries.length; i += 16) {
    const heads = await Promise.all(binaries.slice(i, i + 16).map((file) => readInside(worktree, realWorktree, file.path, 2).catch(() => null)));
    heads.forEach((head, j) => {
      if (head && startsUtf16(head.bytes)) utf16.push(binaries[i + j]!);
    });
  }
  // Counted as each base comes, then noted in the diff's order.
  const counts = new Map<FileAdditions, number>();
  const byBase = new Map<string, FileAdditions[]>();
  for (const file of [...texts, ...utf16]) if (file.basePath !== undefined) byBase.set(file.basePath, [...(byBase.get(file.basePath) ?? []), file]);
  await forEachBase(worktree, baseCommit, [...byBase.keys()], async (name, base) => {
    for (const file of byBase.get(name) ?? []) {
      if (!file.binary) {
        counts.set(file, damagedLineCount(file.added, base));
      } else {
        const now = await readInside(worktree, realWorktree, file.path, MAX_UTF16_BYTES).catch(() => null);
        if (now) counts.set(file, utf16Lines(now.bytes, base));
      }
    }
  });
  // A file that was there but whose base wasn't read (it can't be, or it's too big) isn't counted: what's new in it
  // can't be told from what was there.
  for (const file of texts) note(file.path, file.basePath === undefined ? damagedLineCount(file.added) : (counts.get(file) ?? 0));
  for (const file of utf16) note(file.path, counts.get(file) ?? 0);
  const untracked = (await git(worktree, ["ls-files", "-z", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
  for (const name of untracked.slice(0, MAX_UNTRACKED_CHECKED)) {
    const read = await readInside(worktree, realWorktree, name, MAX_NEW_FILE_BYTES).catch(() => null);
    // Too big to be text the task wrote, binary by git's own test (a NUL near the start: UTF-16 too), or not UTF-8:
    // with no base, a new file's encoding may be meant (a legacy .properties file).
    if (!read || read.size > MAX_NEW_FILE_BYTES || read.bytes.subarray(0, NUL_SCAN).includes(0) || !isUtf8(read.bytes)) continue;
    note(name, damagedLineCount(decode(read.bytes).split("\n").map((text) => ({ text: text.replace(/\r$/, ""), utf8: true }))));
  }
  // The task named these files: shown on cards and sent back to it, so without control or format characters.
  const shown = paths.slice(0, ENCODING_DAMAGE_MAX_PATHS).map((p) => cleanLine(p, 300));
  return lines > 0 ? { lines, files: paths.length, paths: shown, base: baseCommit } : undefined;
}

/** Everything the task changed since its base, committed or not, new files included; LF line endings; capped. */
export async function diff(worktree: string, baseCommit: string): Promise<{ text: string; truncated: boolean }> {
  // Names as they are (café.md), not C-quoted ("caf\303\251.md").
  let text = await git(worktree, ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", baseCommit]);
  const untracked = (await git(worktree, ["ls-files", "-z", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
  for (const file of untracked) {
    if (text.length > MAX_DIFF_CHARS) break;
    // --no-index exits with 1 when the files differ, which is the point here; above 1 it failed.
    const result = await execa("git", [...HOST_GIT, "-c", "core.quotePath=false", "-C", worktree, "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-index", "--", "/dev/null", file], {
      reject: false,
      timeout: 60_000,
      windowsHide: true,
    });
    const separator = text && !text.endsWith("\n") ? "\n" : "";
    if (typeof result.exitCode === "number" && result.exitCode <= 1) {
      if (result.stdout) text += `${separator}${result.stdout}`;
    } else {
      const why = String(result.stderr ?? "").split(/\r?\n/)[0] || `git exited with ${result.exitCode ?? "a signal"}`;
      text += `${separator}diff --git a/${file} b/${file}\nnew file, which couldn't be shown: ${why}\n`;
    }
  }
  text = text.replace(/\r\n/g, "\n");
  const truncated = text.length > MAX_DIFF_CHARS;
  return { text: truncated ? text.slice(0, MAX_DIFF_CHARS) : text, truncated };
}

/**
 * Reads a file from a task's worktree for previewing (e.g. `.md` or `.html` files), confined strictly inside `worktree`
 * (including after resolving symlinks) and capped at `MAX_FILE_PREVIEW_BYTES`. Returns `null` when the file or worktree
 * is no longer on disk.
 */
export function readWorktreeFile(
  worktree: string,
  filePath: string,
  extraRoots: readonly string[] = [],
): { path: string; content: string; truncated: boolean } | null {
  const trimmed = filePath.trim();
  if (!trimmed || trimmed.includes("\0")) throw new Error("Invalid file path.");
  const readRoot = (root: string): { path: string; content: string; truncated: boolean } | "outside" | null => {
  const resolvedWorktree = path.resolve(root);
  // Treat a single leading slash ("/docs/report.md") as worktree-relative rather than drive-root on Windows.
  const normalizedInput = /^\/(?!\/)/.test(trimmed) && /^[A-Za-z]:/.test(resolvedWorktree) ? trimmed.replace(/^\/+/, "") : trimmed;
  const target = path.resolve(resolvedWorktree, normalizedInput);
  if (!insideDir(target, resolvedWorktree) || pathKey(target) === pathKey(resolvedWorktree)) {
    return "outside";
  }
  if (!existsSync(resolvedWorktree) || !existsSync(target)) return null;
  const realWorktree = realpathSync(resolvedWorktree);
  const realTarget = realpathSync(target);
  if (!insideDir(realTarget, realWorktree) || pathKey(realTarget) === pathKey(realWorktree)) {
    throw new Error("That file points outside the task's worktree.");
  }
  const stat = statSync(realTarget);
  if (!stat.isFile()) return null;
  const truncated = stat.size > MAX_FILE_PREVIEW_BYTES;
  const toRead = Math.min(stat.size, MAX_FILE_PREVIEW_BYTES);
  const buffer = Buffer.alloc(toRead);
  const fd = openSync(realTarget, "r");
  let bytesRead: number;
  try {
    bytesRead = readSync(fd, buffer, 0, toRead, 0);
  } finally {
    closeSync(fd);
  }
  let rawContent = buffer.subarray(0, bytesRead).toString("utf8");
  if (truncated && rawContent.endsWith("\uFFFD")) {
    rawContent = rawContent.slice(0, -1);
  }
  const content = rawContent.replace(/\r\n/g, "\n");
  return {
    path: path.relative(resolvedWorktree, target).replace(/\\/g, "/"),
    content,
    truncated,
  };
  };
  const primary = worktree ? readRoot(worktree) : "outside";
  if (primary && primary !== "outside") return primary;
  let insideAnyExtra = false;
  for (const extra of extraRoots) {
    if (!extra) continue;
    const hit = readRoot(extra);
    if (hit && hit !== "outside") return hit;
    if (hit === null) insideAnyExtra = true;
  }
  if (primary === null || insideAnyExtra) return null;
  throw new Error("That file is outside the task's worktree.");
}

/**
 * The git aliases a command in this worktree would use (yours and the repository's): lowercase name → what it stands
 * for, a multi-line one in full. Read as NUL-separated records, since a value can hold line breaks.
 */
export async function gitAliases(worktree: string): Promise<Map<string, string>> {
  // No alias at all makes git exit with 1.
  const listed = await git(worktree, ["config", "--null", "--get-regexp", "^alias\\."]).catch(() => "");
  const aliases = new Map<string, string>();
  for (const record of listed.split("\0")) {
    // Each record is the key, a line break, then the value.
    const match = /^alias\.([^\n]+)\n([\s\S]*)$/.exec(record);
    if (match) aliases.set(match[1]!.toLowerCase(), match[2]!);
  }
  return aliases;
}

/** The branch checked out in a folder's repository; undefined when HEAD is detached or it isn't a repository. */
export async function checkedOutBranch(dir: string): Promise<string | undefined> {
  const branch = await git(dir, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "");
  return branch.trim() || undefined;
}

/** The `git-<name>` programs on PATH that git runs as its commands (lowercase names); undefined when git can't list them. */
export async function gitExternals(dir: string): Promise<Set<string> | undefined> {
  try {
    const listed = await git(dir, ["--list-cmds=others"]);
    return new Set(listed.split(/\r?\n/).map((name) => name.trim().toLowerCase()).filter(Boolean));
  } catch {
    return undefined;
  }
}

/** git's settings that decide what a push sends, and where. */
export interface PushSettings {
  /** push.default, when set (matching, upstream and tracking push other branches, or under another name). */
  pushDefault?: string;
  /** Every remote.<name>.push refspec: git pushes by them when a push names no destination. */
  refspecs: string[];
  /** Whether a remote is set to mirror (remote.<name>.mirror): a push sends every branch. */
  mirror: boolean;
}

/** The push settings a push in this folder's repository would use; undefined when they can't be read. */
export async function pushSettings(dir: string): Promise<PushSettings | undefined> {
  let listed: string;
  try {
    listed = await git(dir, ["config", "--null", "--get-regexp", "^(push\\.default|remote\\..*\\.(push|mirror))$"]);
  } catch (error) {
    // None of them set makes git exit with 1.
    if ((error as { exitCode?: number }).exitCode === 1) return { refspecs: [], mirror: false };
    return undefined;
  }
  const settings: PushSettings = { refspecs: [], mirror: false };
  for (const record of listed.split("\0")) {
    // The key, a line break and the value; just the key for one written without a value (true, for a switch).
    const at = record.indexOf("\n");
    const key = at < 0 ? record : record.slice(0, at);
    const value = at < 0 ? undefined : record.slice(at + 1);
    if (!key) continue;
    if (key === "push.default") settings.pushDefault = value ?? "";
    else if (key.endsWith(".push")) settings.refspecs.push(value ?? "");
    // git reads true, yes, on and 1 (and a key without a value) as true.
    else if (value === undefined || !/^(?:false|no|off|0)$/i.test(value)) settings.mirror = true;
  }
  return settings;
}

/** Whether git still knows `worktree` as one of the repository's worktrees. */
async function registered(repoPath: string, worktree: string): Promise<boolean> {
  const list = await git(repoPath, ["worktree", "list", "--porcelain"]).catch(() => "");
  return list.split(/\r?\n/).some((line) => line.startsWith("worktree ") && pathKey(line.slice("worktree ".length)) === pathKey(worktree));
}

/**
 * Removes a task's worktree (and with `deleteBranch`, its branch). Refuses anything outside `root` or a branch not
 * named `aria/…`. Retries while Windows still holds files open in it. Only this worktree is unregistered, also when
 * its folder is gone already: never `git worktree prune`, which would drop any of the repository's missing worktrees.
 */
export async function removeWorktree(options: { repoPath: string; root: string; worktree: string; branch?: string; deleteBranch?: boolean }): Promise<void> {
  const { repoPath, root, worktree, branch } = options;
  if (!insideDir(worktree, root) || path.resolve(worktree) === path.resolve(root)) throw new Error(`${worktree} isn't an ARIA worktree.`);
  if (options.deleteBranch && (!branch || !branch.startsWith("aria/") || !SAFE_REF.test(branch))) throw new Error(`${branch ?? "(none)"} isn't an ARIA branch.`);
  for (let attempt = 1; ; attempt++) {
    try {
      await git(repoPath, ["worktree", "remove", "--force", worktree]);
      break;
    } catch (error) {
      // Already gone (or never got made): nothing left to remove.
      if (!(await registered(repoPath, worktree))) break;
      if (attempt >= 5) throw error;
      await sleep(400 * attempt);
    }
  }
  if (options.deleteBranch && branch) await deleteAriaBranch(repoPath, branch);
}

/** Deletes a task's `aria/…` branch, if it's there; any other branch is refused. */
export async function deleteAriaBranch(repoPath: string, branch: string): Promise<void> {
  if (!branch.startsWith("aria/") || !SAFE_REF.test(branch)) throw new Error(`${branch} isn't an ARIA branch.`);
  const exists = await git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
  if (exists) await git(repoPath, ["branch", "-D", branch]);
}
