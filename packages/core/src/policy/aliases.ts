/**
 * git and gh aliases, which the hard rules resolve (PLAN.md §4.8): an alias for push is a push, an alias for
 * `pr merge` is a merge. git's are read through git (worktrees.ts `gitAliases`); gh's from its config file.
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * git's own commands (Git for Windows 2.53: `git --list-cmds=builtins,main`). git runs one of these whatever aliases
 * say; any other word is a `git-<word>` program on PATH (git tries those before aliases) or an alias.
 */
export const GIT_COMMANDS: ReadonlySet<string> = new Set([
  "add", "am", "annotate", "apply", "archive", "backfill", "bisect", "blame", "branch", "bugreport", "bundle", "cat-file",
  "check-attr", "check-ignore", "check-mailmap", "check-ref-format", "checkout", "checkout--worker", "checkout-index",
  "cherry", "cherry-pick", "clean", "clone", "column", "commit", "commit-graph", "commit-tree", "config",
  "count-objects", "credential", "credential-cache", "credential-cache--daemon", "credential-store", "credential-wincred",
  "describe", "diagnose", "diff", "diff-files", "diff-index", "diff-pairs", "diff-tree", "difftool", "difftool--helper",
  "fast-export", "fast-import", "fetch", "fetch-pack", "filter-branch", "fmt-merge-msg", "for-each-ref", "for-each-repo",
  "format-patch", "fsck", "fsck-objects", "fsmonitor--daemon", "gc", "get-tar-commit-id", "grep", "hash-object", "help",
  "hook", "index-pack", "init", "init-db", "interpret-trailers", "last-modified", "lfs", "log", "ls-files", "ls-remote",
  "ls-tree", "mailinfo", "mailsplit", "maintenance", "merge", "merge-base", "merge-file", "merge-index", "merge-octopus",
  "merge-one-file", "merge-ours", "merge-recursive", "merge-recursive-ours", "merge-recursive-theirs", "merge-resolve",
  "merge-subtree", "merge-tree", "mergetool", "mktag", "mktree", "multi-pack-index", "mv", "name-rev", "notes",
  "pack-objects", "pack-redundant", "pack-refs", "patch-id", "pickaxe", "prune", "prune-packed", "pull", "push",
  "quiltimport", "range-diff", "read-tree", "rebase", "receive-pack", "reflog", "refs", "remote", "remote-ext",
  "remote-fd", "repack", "replace", "replay", "repo", "request-pull", "rerere", "reset", "restore", "rev-list",
  "rev-parse", "revert", "rm", "send-pack", "shortlog", "show", "show-branch", "show-index", "show-ref",
  "sparse-checkout", "stage", "stash", "status", "stripspace", "submodule", "submodule--helper", "subtree", "survey",
  "switch", "symbolic-ref", "tag", "unpack-file", "unpack-objects", "update", "update-index", "update-ref",
  "update-server-info", "upload-archive", "upload-archive--writer", "upload-pack", "var", "verify-commit", "verify-pack",
  "verify-tag", "version", "web--browse", "whatchanged", "worktree", "write-tree",
]);

/** gh's aliases when it has no config file yet: its built-in `co`. */
export const DEFAULT_GH_ALIASES: ReadonlyMap<string, string> = new Map([["co", "pr checkout"]]);

/** gh's own top-level commands (gh 2.60–2.102+). Any other word is an alias or extension. */
export const GH_TOP_COMMANDS: ReadonlySet<string> = new Set([
  "agent-task", "alias", "api", "attestation", "auth", "browse", "cache", "codespace", "completion", "config", "copilot", "extension", "gist",
  "gpg-key", "help", "issue", "label", "org", "pr", "preview", "project", "release", "repo", "ruleset", "run", "search", "secret", "ssh-key", "status",
  "variable", "version", "workflow",
]);

/** Allowed read-only subcommands for sensitive gh top-level commands in tasks (Phase 9, D77). */
export const GH_READ_ONLY_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  auth: new Set(["status"]),
  alias: new Set(["list"]),
  config: new Set(["get", "list"]),
  extension: new Set(["list", "search"]),
  "agent-task": new Set(["list", "view"]),
  secret: new Set(["list"]),
  variable: new Set(["list"]),
  "ssh-key": new Set(["list"]),
  "gpg-key": new Set(["list"]),
  ruleset: new Set(["list", "view", "check"]),
  attestation: new Set(["verify", "download", "trusted-root"]),
};

/** Where gh keeps its config, in gh's own order: `GH_CONFIG_DIR`, `$XDG_CONFIG_HOME/gh`, `%AppData%\GitHub CLI`, `~/.config/gh`. */
export function ghConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GH_CONFIG_DIR) return path.join(env.GH_CONFIG_DIR, "config.yml");
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, "gh", "config.yml");
  const appData = env.APPDATA ?? env.AppData;
  if (process.platform === "win32" && appData) return path.join(appData, "GitHub CLI", "config.yml");
  return path.join(os.homedir(), ".config", "gh", "config.yml");
}

/**
 * gh's aliases (name as written, its words separated by single spaces → what it stands for): its defaults without a
 * config file, `null` when the file can't be read with certainty (so gh commands are refused rather than guessed).
 */
export function readGhAliases(file = ghConfigFile()): ReadonlyMap<string, string> | null {
  if (!existsSync(file)) return DEFAULT_GH_ALIASES;
  try {
    return parseGhAliases(readFileSync(file, "utf8")) ?? null;
  } catch {
    return null;
  }
}

function unquote(text: string): string | undefined {
  const value = text.trim();
  if (value.startsWith("'")) return /^'(?:[^']|'')*'$/.test(value) ? value.slice(1, -1).replace(/''/g, "'") : undefined;
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return undefined;
    }
  }
  // A plain value ends where a comment starts.
  return value.replace(/\s+#.*$/, "");
}

/** A root key of gh's config as gh writes it (`aliases`, `git_protocol`), or the aliases key quoted. */
const ROOT_KEY = /^(?:([A-Za-z_][\w-]*)|'aliases'|"aliases")[ \t]*:(?:[ \t]+(.*))?$/;
/** An alias name ARIA reads as gh does: words of letters, digits, `_`, `.` and `-`, one space apart. */
const PLAIN_NAME = /^[\w][\w.-]*(?: [\w.-]+)*$/;
/** YAML characters that make a plain value something else: a tag, an anchor, an alias, a collection, a block, a directive. */
const INDICATOR = /^(?:[!&*[\]{}|>%@`,#]|[-?:](?:\s|$))/;

/**
 * The aliases in gh's config.yml, as gh writes it: a mapping of plain keys, and under `aliases:` one `name: expansion`
 * per indented line, names and values plain or quoted, and block scalars (`|`, `>`) for long shell aliases. Undefined for
 * anything else (a key written another way, JSON-style YAML, tags, anchors, two aliases of the same name): what gh
 * would read there can't be told for sure, and "no aliases" mustn't be a guess.
 */
export function parseGhAliases(file: string): Map<string, string> | undefined {
  const lines = file.replace(/^\uFEFF/, "").split(/\r?\n/);
  const aliases = new Map<string, string>();
  let section: "none" | "other" | "aliases" = "none";
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) {
      // Every root key has to be a plain one at the start of its line, so no other way of writing one hides the aliases.
      const root = ROOT_KEY.exec(line);
      if (!root) return undefined;
      if (root[1] !== undefined && root[1] !== "aliases") {
        section = "other";
        continue;
      }
      // Two aliases blocks: gh would use one of them.
      if (found) return undefined;
      found = true;
      const inline = (root[2] ?? "").replace(/\s+#.*$/, "").trim();
      if (inline !== "" && inline !== "{}") return undefined;
      section = inline === "" ? "aliases" : "other";
      continue;
    }
    // An indented line belongs to the root key above it.
    if (section === "none") return undefined;
    if (section === "other") continue;
    const indent = /^\s*/.exec(line)![0].length;
    const entry = /^\s+('(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^\s'"#][^:#]*?)[ \t]*:(?:[ \t]+(.*))?$/.exec(line);
    if (!entry) return undefined;
    const quoted = /^['"]/.test(entry[1]!);
    const written = quoted ? unquote(entry[1]!) : entry[1]!.trim();
    // gh reads a name like a command line: quotes, escapes or YAML's indicators in it aren't guessed at.
    if (written === undefined || (!quoted && !PLAIN_NAME.test(written)) || /['"\\#]/.test(written)) return undefined;
    const name = written.trim().split(/\s+/).join(" ");
    // Two of the same name: gh would use one of them.
    if (!name || aliases.has(name)) return undefined;
    const raw = (entry[2] ?? "").trim();
    let value: string | undefined;
    if (/^[|>](?:[-+][1-9]?|[1-9][-+]?)?$/.test(raw)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (!lines[i + 1]!.trim() || /^\s*/.exec(lines[i + 1]!)![0].length > indent)) block.push(lines[++i]!.trim());
      value = block.join(raw.startsWith(">") ? " " : "\n").trim();
    } else if (/^['"]/.test(raw)) {
      value = unquote(raw);
    } else if (!INDICATOR.test(raw)) {
      // A plain value ends where a comment starts.
      value = raw.replace(/\s+#.*$/, "");
    }
    if (value === undefined) return undefined;
    aliases.set(name, value);
  }
  return aliases;
}

/**
 * A git alias's expansion split into arguments the way git does (`split_cmdline`): whitespace separates, single and
 * double quotes group, a backslash takes the next character as it is (not inside single quotes). Undefined where git
 * refuses it too (an unclosed quote, a trailing backslash).
 */
export function gitSplit(text: string): string[] | undefined {
  const args = [""];
  let quoted: string | undefined;
  for (let i = 0; i < text.length; ) {
    let c = text[i++]!;
    if (!quoted && /\s/.test(c)) {
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (i < text.length) args.push("");
    } else if (!quoted && (c === "'" || c === '"')) {
      quoted = c;
    } else if (c === quoted) {
      quoted = undefined;
    } else {
      if (c === "\\" && quoted !== "'") {
        if (i >= text.length) return undefined;
        c = text[i++]!;
      }
      args[args.length - 1] += c;
    }
  }
  return quoted ? undefined : args;
}

/**
 * A gh alias's expansion split into arguments the way gh does (a POSIX-shell-like split): whitespace separates, single
 * quotes keep everything, double quotes and a bare backslash escape the next character, `#` at the start of a word
 * starts a comment. Undefined for an unclosed quote or a trailing backslash.
 */
export function shlexSplit(text: string): string[] | undefined {
  const args: string[] = [];
  let current = "";
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      if (inWord) args.push(current);
      current = "";
      inWord = false;
    } else if (!inWord && c === "#") {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
    } else if (c === "\\") {
      if (i + 1 >= text.length) return undefined;
      current += text[++i]!;
      inWord = true;
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return undefined;
      current += text.slice(i + 1, end);
      i = end;
      inWord = true;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === "\\") {
          if (j + 1 >= text.length) return undefined;
          current += text[++j]!;
        } else {
          current += text[j]!;
        }
      }
      if (j >= text.length) return undefined;
      i = j;
      inWord = true;
    } else {
      current += c;
      inWord = true;
    }
  }
  if (inWord) args.push(current);
  return args;
}
