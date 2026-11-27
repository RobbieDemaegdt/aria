/**
 * How the worker policy reads one shell command segment (PLAN.md §4.8, D21): the program, its subcommand, its options
 * and the rest of its arguments. Rules match on that, and "Approve for this task" remembers a command by it.
 */
import path from "node:path";
import { scanCommand } from "../tasks/policy.ts";

/** PowerShell aliases for Remove-Item, so a rule about the cmdlet also catches `rm -r` or `del -Recurse`. */
const ALIASES: Record<string, string> = { rm: "remove-item", del: "remove-item", erase: "remove-item", rd: "remove-item", rmdir: "remove-item", ri: "remove-item" };

/** How many subcommand words a program has before its targets (`git push`, `dotnet add package`, `gh pr merge`). */
function subcommandDepth(program: string, first: string | undefined): number {
  switch (program) {
    case "git":
      return first &&
        [
          "remote",
          "stash",
          "worktree",
          "submodule",
          "notes",
          "lfs",
          "bisect",
          "sparse-checkout",
          "maintenance",
          "refs",
          "reflog",
          "commit-graph",
          "multi-pack-index",
        ].includes(first)
        ? 2
        : 1;
    case "dotnet":
      return first && ["add", "remove", "nuget", "tool", "new", "sln", "workload", "list"].includes(first) ? 2 : 1;
    case "gh":
      return first && ["status", "browse", "version", "help", "completion"].includes(first) ? 1 : 2;
    case "npm":
    case "pnpm":
    case "yarn":
    case "cargo":
    case "go":
    case "pip":
    case "pip3":
    case "docker":
      return 1;
    default:
      return 0;
  }
}

/** Options that take the next argument as their value, before the subcommand (`git -C dir push`, `gh -R o/r pr`). */
export const GLOBAL_VALUE_OPTIONS: Record<string, string[]> = {
  git: ["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path", "--shallow-file", "--attr-source"],
  npm: ["--prefix", "-C", "--workspace", "-w"],
  pnpm: ["--dir", "-C", "--filter", "-F", "--prefix"],
  yarn: ["--cwd"],
  gh: ["-R", "--repo", "--hostname"],
};

/** gh's flags that take no value where gh looks for its command (its others take the next argument there). */
const GH_SWITCHES = new Set(["--help", "--version"]);

/**
 * How gh's flags are read while finding its command: the way gh does ("cobra": any flag without `=`, except --help and
 * --version, takes the next argument, wherever it is), or with only the flags ARIA knows taking a value ("known").
 */
export type GhReading = "cobra" | "known";

export interface ParsedCommand {
  /** The program, lowercased, without folder or extension; PowerShell aliases resolved. */
  program: string;
  /** The program as the shell reads it (quotes removed, escapes decoded), before it's reduced to a name. */
  programToken: string;
  /** Whether it's a PowerShell cmdlet (Verb-Noun), whose parameters are whole words that can be shortened. */
  cmdlet: boolean;
  /** Subcommand words, e.g. ["push"] or ["add", "package"]. */
  words: string[];
  /** Option arguments as typed (`--force`, `-fd`, `-Recurse`, `/s`), and the values of global options. */
  options: string[];
  /** The arguments after the subcommand (`origin`, `aria/x`, `lodash`). */
  values: string[];
  /** Every non-option argument after the program, in order (subcommand words included). */
  positional: string[];
  /** Where each positional argument is in `args`. */
  positionalAt: number[];
  /** Every argument after the program, in order, as the program gets them. */
  args: string[];
  /** The segment exactly as written (trimmed). */
  text: string;
  /** Why the arguments can't be told from the text (PowerShell computes part of them when it runs), if so. */
  unreadable?: string;
  /** The command as PowerShell 7 passes it, when an empty argument makes that different (Windows PowerShell 5.1 leaves it out). */
  withEmpty?: ParsedCommand;
}

export const isOption = (arg: string) => /^-./.test(arg) || /^\/[A-Za-z?]/.test(arg);

export function programName(arg: string): string {
  const base = path.win32.basename(arg).toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "");
  return ALIASES[base] ?? base;
}

/** Parses one segment ("git push origin aria/x"); a leading call or dot-source operator (`&`, `.`) is skipped. */
export function parseCommand(segment: string): ParsedCommand | undefined {
  const text = segment.trim();
  const statements = scanCommand(text);
  const first = statements[0];
  if (!first) return undefined;
  const unreadable = statements.length > 1 ? "it holds more than one command" : first.unreadable;
  const parsed = fromArgs(first.args, text, unreadable);
  const withEmpty = first.withEmpty ? fromArgs(first.withEmpty, text, unreadable) : undefined;
  return parsed && withEmpty ? { ...parsed, withEmpty } : (parsed ?? withEmpty);
}

function fromArgs(all: readonly string[], text: string, unreadable: string | undefined): ParsedCommand | undefined {
  let args = all;
  while (args[0] === "&" || args[0] === ".") args = args.slice(1);
  const [first, ...rest] = args;
  if (!first) return undefined;
  return { ...parseArgs(programName(first), rest), programToken: first, text, ...(unreadable ? { unreadable } : {}) };
}

/** Whether a flag takes the next argument as its value where it stands. */
function takesValue(program: string, arg: string, beforeSubcommand: boolean, gh: GhReading): boolean {
  if (program !== "gh") return beforeSubcommand && (GLOBAL_VALUE_OPTIONS[program] ?? []).includes(arg);
  if (arg.includes("=")) return false;
  if (gh === "known") return GLOBAL_VALUE_OPTIONS.gh!.includes(arg);
  // Like cobra, which gh uses: a flag it doesn't know as an on/off switch takes a value (`-R o/r`; a cluster `-ab` doesn't).
  return arg.startsWith("--") ? !GH_SWITCHES.has(arg) : arg.length === 2;
}

/** A program's arguments read the way parseCommand reads them (also for a git or gh alias's expansion). */
export function parseArgs(program: string, rest: string[], gh: GhReading = "cobra"): Omit<ParsedCommand, "programToken" | "text"> {
  const cmdlet = /^[a-z]+-[a-z]+$/i.test(program);
  const options: string[] = [];
  const positional: string[] = [];
  const positionalAt: number[] = [];
  let afterDoubleDash = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (afterDoubleDash) {
      positional.push(arg);
      positionalAt.push(i);
    } else if (arg === "--") {
      afterDoubleDash = true;
    } else if (arg === "" && program === "gh") {
      // gh (cobra) passes over an empty argument when it looks for its command.
    } else if (isOption(arg)) {
      options.push(arg);
      // A global option's value (before the subcommand, or anywhere for gh) isn't the subcommand.
      if (takesValue(program, arg, positional.length === 0, gh) && i + 1 < rest.length) options.push(rest[++i]!);
    } else {
      positional.push(arg);
      positionalAt.push(i);
    }
  }
  const depth = subcommandDepth(program, positional[0]?.toLowerCase());
  const words = positional.slice(0, depth).map((w) => w.toLowerCase());
  return { program, cmdlet, words, options, values: positional.slice(depth), positional, positionalAt, args: rest };
}

// ── rules ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Whether an option the rule names was given: `--force` (also `--force-with-lease`, `--force=…`), `-f` in a cluster
 * like `-fdx` (letter case matters), a PowerShell parameter by any prefix (`-r`, `-Rec` for `-Recurse`), or a `/s`
 * switch.
 */
function hasOption(parsed: ParsedCommand, wanted: string): boolean {
  const want = wanted.toLowerCase();
  return parsed.options.some((raw) => {
    const arg = raw.toLowerCase();
    if (want.startsWith("--")) return arg.startsWith(want);
    if (want.startsWith("/")) return arg === want || arg.startsWith(`${want}:`);
    if (parsed.cmdlet) {
      const name = arg.slice(1).split(":")[0]!;
      return name.length > 0 && want.slice(1).startsWith(name);
    }
    // A short option: one letter, possibly in a cluster.
    if (wanted.length === 2) return /^-[A-Za-z0-9]+$/.test(raw) && raw.slice(1).includes(wanted[1]!);
    return arg === want || arg.startsWith(`${want}=`);
  });
}

export interface RuleShape {
  program: string;
  /** The program as the rule writes it. */
  programToken: string;
  /** The arguments the rule names, in order: a word, or `undefined` for a placeholder (`<package>`: any one argument). */
  pattern: Array<string | undefined>;
  options: string[];
  /** An exact rule: only exactly these arguments (`tokens`), nothing more. */
  exact: boolean;
  /** Every argument after the program as written (a placeholder is `undefined`), for exact matching. */
  tokens: Array<string | undefined>;
}

const isPlaceholder = (token: string) => /^<[^>]*>$/.test(token);

/**
 * "npm install <package>" → program npm, then `install` and one more argument (further arguments are fine);
 * "dotnet add <project> package" → `add`, any one argument, `package`. Undefined for an empty match. An exact rule
 * matches only its own arguments, in order and letter case (exactMatches).
 */
export function ruleShape(match: string, exact = false): RuleShape | undefined {
  const [first, ...rest] = match.trim().split(/\s+/).filter(Boolean);
  if (!first) return undefined;
  const pattern: Array<string | undefined> = [];
  const options: string[] = [];
  for (const token of rest) {
    if (isPlaceholder(token)) pattern.push(undefined);
    else if (isOption(token)) options.push(token);
    else pattern.push(token.toLowerCase());
  }
  return { program: programName(first), programToken: first, pattern, options, exact, tokens: rest.map((token) => (isPlaceholder(token) ? undefined : token)) };
}

/**
 * How specific a rule is: more words and options win over fewer. An exact rule without placeholders weighs one more
 * than the same words without "exact", so it decides for exactly its own command; the strictest still wins among
 * equals (an exact Auto and an exact Never for the same command: Never).
 */
export const ruleWeight = (shape: RuleShape) =>
  1 + shape.pattern.reduce((sum, word) => sum + (word === undefined ? 1 : 2), 0) + shape.options.length * 2 + (shape.exact && shape.tokens.every((t) => t !== undefined) ? 1 : 0);

/**
 * An exact rule matches when the program gets exactly the rule's arguments: the same count, in the same order, letter
 * case included (`Left-Pad` isn't `left-pad`, `--` is one more argument); a placeholder is one argument that isn't an
 * option. Never a command PowerShell computes part of (`$x`): its arguments can't be told from the text.
 */
function exactMatches(shape: RuleShape, parsed: ParsedCommand): boolean {
  if (shape.program !== parsed.program || parsed.unreadable !== undefined) return false;
  if (parsed.args.length !== shape.tokens.length) return false;
  return shape.tokens.every((token, i) => {
    const arg = parsed.args[i]!;
    return token === undefined ? arg !== "" && !isOption(arg) : arg === token;
  });
}

export function ruleMatches(shape: RuleShape, parsed: ParsedCommand): boolean {
  if (shape.exact) return exactMatches(shape, parsed);
  if (shape.program !== parsed.program) return false;
  // Words are the command's first arguments, so `git log --grep push` isn't a push.
  const positional = parsed.positional.map((p) => p.toLowerCase());
  if (positional.length < shape.pattern.length) return false;
  if (shape.pattern.some((word, i) => word !== undefined && positional[i] !== word)) return false;
  return shape.options.every((option) => hasOption(parsed, option));
}

// ── identity (D21) ───────────────────────────────────────────────────────────────────────────────────────────────

const caseless = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);

/** A path the way Windows compares them: absolute, one kind of slash, any letter case. */
export function canonicalPath(value: string, cwd: string): string {
  return caseless(path.resolve(cwd, value));
}

export interface Identity {
  /** The operation: the whole command as written. */
  key: string;
  /** Where it acts: the folder it runs in (canonical), a host, or a folder for files. */
  target: string;
}

/**
 * A command's identity for "Approve for this task" (D21): the same command text, character for character, run in the
 * same folder. Nothing in it is normalized: what looks like a path can be code (`node -e "…//../…"`), `node` isn't
 * `.\node.cmd`, `'$(x)'` is text where `"$(x)"` runs x, and a line break can end a comment where a space doesn't.
 */
export function commandIdentity(parsed: ParsedCommand, cwd: string): Identity {
  return { key: JSON.stringify(parsed.text), target: canonicalPath(cwd, cwd) };
}
