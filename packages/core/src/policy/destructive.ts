/**
 * Destructive commands (PLAN.md §4.8, D28, D29): a fixed class, decided here and nowhere else. The policy engine makes
 * them ask every time, sandboxed or not, whatever your rules or grants say (Approve once or Reject, never "Approve
 * for this task"); "Always allow this" is never offered for them, and an Auto rule for one can't be saved.
 *
 * - `Remove-Item` and its aliases (`rm`, `del`, `erase`, `rd`, `rmdir`, `ri`) with `-Recurse` by any prefix, `-rf`, or
 *   `/s` (which is also how cmd's `del /s`, `erase /s`, `rd /s` and `rmdir /s` read); and any `Remove-Item` in a line
 *   with a recursive `Get-ChildItem` (`gci -r | rm`);
 * - `rimraf` (also run by `npx`, `npm exec`, `pnpm dlx`…) and `robocopy` with `/MIR` or `/PURGE`;
 * - `find -delete`, and any of these run by `find -exec` or `xargs`;
 * - `git reset --hard` (git takes an unambiguous start of an option: `--ha`); `git clean` without `-n` / `--dry-run`;
 * - `git checkout` and `git restore` of the whole worktree (no path for restore, `.`, `*`, `:/`, `:(top)`, a path that
 *   is the worktree or above it from where the command runs, paths from a file), and
 *   `git checkout -f`, `git switch -f` / `--discard-changes` (D29): they throw away uncommitted changes;
 * - `git stash clear` and `git stash drop` (the stash is shared with your own checkout);
 * - `git push` with `--force` (from `--for`), `-f` (also in a cluster), `--force-with-lease`, `--force-if-includes` or a
 *   `+refspec`;
 * - `git branch -D` (and `--delete --force`, `-df`) and `git branch -M` (and `--move --force`).
 *
 * Not destructive (D29): `git restore <file>` and `git checkout -- <file>`, which a task uses to undo its own edits,
 * and `git restore --staged` (only the index). git aliases are followed the way the fixed rules follow them, and the
 * command line a shell is given (`cmd /c …`, `pwsh -Command …`, `bash -c …`) is read too: as commands where ARIA can
 * read it, else (`$x`, cmd's own syntax) by the words it mentions. Code an interpreter or a script runs isn't read.
 */
import path from "node:path";
import { scanCommand } from "../tasks/policy.ts";
import { GIT_COMMANDS, gitSplit, shlexSplit } from "./aliases.ts";
import { parseArgs, parseCommand, programName, type ParsedCommand } from "./command.ts";

/** Programs that run the command line they're given. */
const SHELLS = new Set(["cmd", "powershell", "pwsh", "bash", "sh", "wsl", "invoke-expression", "iex", "invoke-command", "icm", "start-job", "start-process", "saps", "start"]);
/** PowerShell's commands that list files, and the ones that run a package's program by name. */
const LISTERS = new Set(["get-childitem", "gci", "ls", "dir"]);
const PACKAGE_RUNNERS = new Set(["npx", "bunx", "pnpx"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** Commands that print what follows them: a command line after one is text, not a command (`cmd /c echo git reset --hard`). */
const PRINTERS = new Set(["echo", "echo.", "write-output", "write-host", "write", "printf", "print"]);
/** `find`'s actions that run a command on what it finds, and what ends that command. */
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const FIND_END = new Set([";", "\\;", "+", "{}"]);
const MAX_DEPTH = 4;
const MAX_ALIASES = 10;

const REMOVES_FOLDER = "deletes a folder and everything in it";
const DISCARDS = "throws away uncommitted changes";

/**
 * Where a command starts in a command line: its beginning, after a separator or an opening quote, or after cmd's and
 * sh's conditions and loops (`if exist build rd /s …`, `do rm -rf …`, `then`, `else`).
 */
const START = String.raw`(?:^|[;&|({]\s*|["'\x60]\s*|\b(?:if\s+(?:not\s+)?(?:exist\s+[^\s;&|]+|defined\s+[^\s;&|]+|errorlevel\s+\d+)|do|then|else)\s+)(?:&\s*)?(?:[^\s;&|]*[\\/])?`;
/** git and its own options (`-C dir`, `-c x=y`, `--git-dir=…`) before its command. */
const GIT = START + String.raw`git(?:\.exe)?(?:\s+(?:-[cC]\s+[^\s;&|]+|--?[\w-]+(?:=[^\s;&|]+)?))*\s+`;

/**
 * The class mentioned as words, for a command line ARIA can't read as commands (`$x`, cmd's `&`, `if exist …`). Each
 * one is tied to where a command starts, so `git commit -m "clean up"` or `git rm -r --cached` don't read as one.
 */
const MENTIONS: Array<[RegExp, string]> = [
  [new RegExp(START + String.raw`(?:rm|del|erase|rd|rmdir|ri|remove-item)(?:\.exe)?\s(?:[^;&|]*\s)?(?:-r\w*|-rf|-fr|--recursive)(?=[\s;&|)"',]|$)`, "i"), REMOVES_FOLDER],
  // cmd's `/s`, also in a cluster or right after the command (`rd/s/q`, `rmdir /S/Q`).
  [new RegExp(START + String.raw`(?:del|erase|rd|rmdir|rm|ri)(?:\.exe)?(?:\s[^;&|]*?)?\/s(?=[\s;&|)"',/:]|$)`, "i"), REMOVES_FOLDER],
  [new RegExp(START + String.raw`(?:(?:npx|bunx|pnpx)\s+(?:-[^\s;&|]+\s+)*)?rimraf\b`, "i"), REMOVES_FOLDER],
  [new RegExp(START + String.raw`robocopy(?:\.exe)?\s[^;&|]*\/(?:mir|purge)\b`, "i"), "deletes the files the source doesn't have"],
  [new RegExp(GIT + String.raw`reset\b[^;&|]*\s--ha`, "i"), DISCARDS],
  [new RegExp(GIT + String.raw`clean\b(?![^;&|]*(?:\s-\w*n|\s--dry))`, "i"), "deletes untracked files"],
  [new RegExp(GIT + String.raw`(?:checkout|restore)\b[^;&|]*\s(?:\.|\*|:\/?)(?=[\s;&|)"']|$)`, "i"), DISCARDS],
  [new RegExp(GIT + String.raw`(?:checkout\b[^;&|]*\s(?:-\w*f|--fo)|switch\b[^;&|]*\s(?:-\w*f|--fo|--di))`, "i"), DISCARDS],
  [new RegExp(GIT + String.raw`stash\s+(?:clear|drop)\b`, "i"), "deletes stashed changes"],
  [new RegExp(GIT + String.raw`push\b[^;&|]*(?:\s--for|\s-\w*f|\s\+\S)`, "i"), "overwrites the branch on the remote (a force push)"],
  [new RegExp(GIT + String.raw`branch\b[^;&|]*\s-\w*[DM]`), "deletes or overwrites a branch"],
  [new RegExp(GIT + String.raw`reflog\s+(?:expire|delete)\b`, "i"), "deletes reflog history"],
  [new RegExp(GIT + String.raw`prune\b`, "i"), "deletes unreachable git objects"],
  [new RegExp(GIT + String.raw`filter-branch\b`, "i"), "rewrites repository history"],
];

export interface DestructiveOptions {
  /** git aliases (lowercase name → what it stands for), so `git rh` for `reset --hard` counts too. */
  gitAliases?: ReadonlyMap<string, string> | undefined;
  /** gh aliases (lowercase name → what it stands for). */
  ghAliases?: ReadonlyMap<string, string> | undefined;
  /** Where the command runs and the task's worktree, so a path naming the whole worktree (`..`, its own path) counts. */
  place?: { cwd: string; worktree: string } | undefined;
}

/** What the command destroys ("throws away uncommitted changes"), or undefined when it isn't destructive. */
export function destructive(parsed: ParsedCommand | undefined, options: DestructiveOptions = {}, depth = 0): string | undefined {
  if (!parsed || depth > MAX_DEPTH) return undefined;
  if (parsed.program === "remove-item") return removeItem(parsed);
  if (parsed.program === "git") return gitDestructive(parsed, options, depth);
  if (parsed.program === "gh") return ghWithAliases(parsed, options, depth);
  if (parsed.program === "rimraf" || /^rimraf(?:@|$)/i.test(packageProgram(parsed) ?? "")) return REMOVES_FOLDER;
  if (parsed.program === "robocopy") return parsed.options.some((o) => /^\/(?:mir|purge)$/i.test(o)) ? "deletes the files the source doesn't have" : undefined;
  if (parsed.program === "find") return findDestructive(parsed, options, depth);
  if (parsed.program === "xargs") return fromEachPosition(parsed.args, options, depth);
  if (SHELLS.has(parsed.program)) return shellDestructive(parsed, options, depth);
  return undefined;
}

function ghWithAliases(first: ParsedCommand, options: DestructiveOptions, depth: number): string | undefined {
  let parsed = first;
  const seen = new Set<string>();
  for (;;) {
    const what = ghDestructive(parsed);
    if (what) return what;
    const [word] = parsed.words;
    if (!word || !options.ghAliases) return undefined;
    const expansion = options.ghAliases.get(word);
    if (expansion === undefined || seen.has(word) || seen.size >= MAX_ALIASES) return undefined;
    seen.add(word);
    const at = parsed.positionalAt[0]!;
    const rest = parsed.args.slice(at + 1);
    if (expansion.startsWith("!")) return commandLine([expansion.slice(1), ...rest].join(" "), options, depth);
    const tokens = shlexSplit(expansion);
    if (!tokens) return undefined;
    parsed = { ...parseArgs("gh", [...tokens, ...rest]), programToken: parsed.programToken, text: parsed.text };
  }
}

function ghDestructive(parsed: ParsedCommand): string | undefined {
  const [word, sub] = parsed.words;
  switch (word) {
    case "api": {
      for (let i = 0; i < parsed.args.length; i++) {
        const arg = parsed.args[i]!;
        if (arg === "--") break;
        if (/^(?:-X|--method)=delete$/i.test(arg) || /^-Xdelete$/i.test(arg)) {
          return "deletes a resource through the GitHub API";
        }
        if (/^(?:-X|--method)$/i.test(arg) && /^delete$/i.test(parsed.args[i + 1] ?? "")) {
          return "deletes a resource through the GitHub API";
        }
      }
      return undefined;
    }
    case "repo":
      return sub === "delete" || sub === "archive" ? "deletes or archives a GitHub repository" : undefined;
    case "release":
      return sub === "delete" || sub === "delete-asset" ? "deletes a GitHub release or asset" : undefined;
    case "project":
      return sub === "delete" || sub === "close" || sub === "field-delete" || sub === "item-delete"
        ? "deletes or closes a GitHub project item"
        : undefined;
    case "gist":
      return sub === "delete" ? "deletes a GitHub gist" : undefined;
    case "codespace":
      return sub === "delete" ? "deletes a GitHub codespace" : undefined;
    case "cache":
      return sub === "delete" ? "deletes GitHub Actions caches" : undefined;
    case "run":
      return sub === "delete" || sub === "cancel" ? "deletes or cancels a GitHub Actions workflow run" : undefined;
    case "pr":
      return sub === "close" ? "closes a pull request" : undefined;
    case "issue":
      return sub === "delete" || sub === "close" ? "deletes or closes a GitHub issue" : undefined;
    default:
      return undefined;
  }
}

/** A command given as words (`xargs rm -rf`, `find … -exec rm -rf {} +`), read as that program with its arguments. */
function asCommand(words: readonly string[], options: DestructiveOptions, depth: number): string | undefined {
  const [first, ...rest] = words;
  if (!first) return undefined;
  return destructive({ ...parseArgs(programName(first), rest), programToken: first, text: words.join(" ") }, options, depth + 1);
}

/**
 * xargs runs the command its arguments name; its own options (some with a value) come first, so it's read from each
 * argument, up to a command that prints (what follows that is its text).
 */
function fromEachPosition(args: readonly string[], options: DestructiveOptions, depth: number): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith("-")) continue;
    const what = asCommand(args.slice(i), options, depth);
    if (what) return what;
    if (PRINTERS.has(programName(args[i]!))) break;
  }
  return undefined;
}

/** `find -delete` deletes what it finds; `-exec` (and `-execdir`, `-ok`) runs a command on it, up to `;` or `+`. */
function findDestructive(parsed: ParsedCommand, options: DestructiveOptions, depth: number): string | undefined {
  if (parsed.args.some((arg) => arg.toLowerCase() === "-delete")) return "deletes what it finds";
  for (let i = 0; i < parsed.args.length; i++) {
    if (!FIND_EXEC.has(parsed.args[i]!.toLowerCase())) continue;
    const words: string[] = [];
    for (let k = i + 1; k < parsed.args.length && !FIND_END.has(parsed.args[k]!); k++) words.push(parsed.args[k]!);
    const what = asCommand(words, options, depth);
    if (what) return what;
  }
  return undefined;
}

/**
 * Commands of one line that destroy together: a `Remove-Item` with a recursive `Get-ChildItem` in the same line
 * (`Get-ChildItem dist -Recurse | Remove-Item -Force`), whichever way it's fed.
 */
export function destructiveTogether(commands: ReadonlyArray<ParsedCommand | undefined>): string | undefined {
  const listing = commands.some((c) => c !== undefined && LISTERS.has(c.program) && c.options.some((o) => parameter(o, "recurse", 1) || parameter(o, "depth", 3)));
  const removal = commands.some((c) => c?.program === "remove-item");
  return listing && removal ? "deletes everything a recursive listing finds" : undefined;
}

/** A PowerShell parameter by any start of its name at least `min` letters long, with or without `:value`. */
const parameter = (option: string, name: string, min: number) => {
  if (!option.startsWith("-")) return false;
  const given = option.slice(1).split(":")[0]!.toLowerCase();
  return given.length >= min && name.startsWith(given);
};

function removeItem(parsed: ParsedCommand): string | undefined {
  const recurse = parsed.options.some((raw) => {
    const option = raw.toLowerCase();
    // cmd's switches, also written together (`/s/q`, `/q/s`).
    if (option.startsWith("/")) return option.split("/").some((part) => part === "s" || part.startsWith("s:"));
    // PowerShell takes a parameter by any start of its name (`-r`, `-Rec`), also with a value (`-Recurse:…`).
    return parameter(option, "recurse", 1) || option === "-rf" || option === "-fr";
  });
  return recurse ? REMOVES_FOLDER : undefined;
}

/** The package program a package manager runs by name (`npx rimraf`, `npm exec rimraf`, `pnpm dlx rimraf`, `yarn rimraf`). */
function packageProgram(parsed: ParsedCommand): string | undefined {
  if (PACKAGE_RUNNERS.has(parsed.program)) return parsed.positional[0];
  if (!PACKAGE_MANAGERS.has(parsed.program)) return undefined;
  const [first, second] = parsed.positional;
  if (first !== undefined && ["exec", "dlx", "x"].includes(first.toLowerCase())) return second;
  return parsed.program === "yarn" ? first : undefined;
}

/** A git long option by any start of its name at least `min` characters long (`--ha` for `--hard`), with or without `=value`. */
const long = (option: string, name: string, min: number) => {
  const given = option.split("=")[0]!.toLowerCase();
  return given.startsWith("--") && given.length >= min && name.startsWith(given);
};

/** A short option in a cluster (`-df`), letter case counting; `stop`: a letter that takes the rest of the cluster as its value. */
const short = (option: string, letter: string, stop?: string) => /^-[^-]/.test(option) && (stop ? option.slice(1).split(stop)[0]! : option.slice(1)).includes(letter);

/** A path the way Windows compares them: absolute, backslashes, any letter case, no trailing separator. */
function comparable(value: string): string {
  const full = path.win32.resolve(value).toLowerCase();
  return full.length > 3 ? full.replace(/[\\/]+$/, "") : full;
}

/**
 * A pathspec for the whole worktree, not a file or folder in it (D29): `.`, `*`, `:/`, `:(top)`, or a path that
 * resolves, from where the command runs, to the worktree or a folder above it (`..` from a subfolder, its own path).
 */
function wholeTree(arg: string, place: { cwd: string; worktree: string } | undefined): boolean {
  let spec = arg.replace(/\\/g, "/");
  while (spec.startsWith("./") && spec.length > 2) spec = spec.slice(2);
  if (spec.length > 2 && spec.endsWith("/")) spec = spec.slice(0, -1);
  if ([".", "./", "*", "**", "*.*", ":", ":/", ":/.", ":/*", ":(top)", ":(top).", ":(top)*"].includes(spec.toLowerCase())) return true;
  if (!place || arg.startsWith(":")) return false;
  const target = comparable(path.win32.resolve(place.cwd, arg));
  const worktree = comparable(place.worktree);
  return worktree === target || worktree.startsWith(target.endsWith("\\") ? target : `${target}\\`);
}

/** Where a git command works: its folder, moved by its own `-C <dir>` options. */
function gitPlace(parsed: ParsedCommand, place: DestructiveOptions["place"]): DestructiveOptions["place"] {
  if (!place) return undefined;
  let cwd = place.cwd;
  const first = parsed.positionalAt[0] ?? parsed.args.length;
  for (let i = 0; i < first; i++) {
    const arg = parsed.args[i]!;
    if (arg === "-C" && i + 1 < parsed.args.length) cwd = path.win32.resolve(cwd, parsed.args[++i]!);
    else if (arg.startsWith("-C") && arg.length > 2) cwd = path.win32.resolve(cwd, arg.slice(2));
  }
  return { cwd, worktree: place.worktree };
}

function gitCommand(parsed: ParsedCommand, place: DestructiveOptions["place"]): string | undefined {
  const [word, sub] = parsed.words;
  const options = parsed.options;
  // Its paths: the arguments after the command (after `--` too).
  const paths = parsed.positional.slice(1);
  const here = gitPlace(parsed, place);
  const whole = (arg: string) => wholeTree(arg, here);
  const fromFile = options.some((o) => long(o, "--pathspec-from-file", 4));
  switch (word) {
    case "reset":
      return options.some((o) => long(o, "--hard", 4)) ? DISCARDS : undefined;
    case "clean":
      // -e takes the rest of a cluster as its pattern, so an `n` after it isn't -n.
      return options.some((o) => long(o, "--dry-run", 3) || short(o, "n", "e")) ? undefined : "deletes untracked files";
    case "checkout":
      // A branch to switch to keeps your changes (git refuses when it can't); forced, or of the whole worktree, it doesn't.
      // Paths read from a file can't be told from the command, so they count as the whole worktree.
      return options.some((o) => long(o, "--force", 4) || short(o, "f")) || fromFile || paths.some(whole) ? DISCARDS : undefined;
    case "restore": {
      // Only the index (`--staged` without `--worktree`) keeps your changes; a file of yours is yours to undo (D29).
      const staged = options.some((o) => long(o, "--staged", 4) || short(o, "S"));
      const worktree = options.some((o) => long(o, "--worktree", 4) || short(o, "W"));
      if (staged && !worktree) return undefined;
      return fromFile || paths.length === 0 || paths.some(whole) ? DISCARDS : undefined;
    }
    case "switch":
      return options.some((o) => long(o, "--discard-changes", 4) || long(o, "--force", 4) || short(o, "f")) ? DISCARDS : undefined;
    case "stash":
      return sub === "clear" || sub === "drop" ? "deletes stashed changes (the stash is shared with your own checkout)" : undefined;
    case "push": {
      // -o takes the rest of a cluster as its value; `--fo` is ambiguous for git (`--follow-tags`), so it takes `--for`.
      const force = options.some((o) => ["--force", "--force-with-lease", "--force-if-includes"].some((name) => long(o, name, 5)) || short(o, "f", "o"));
      return force || paths.some((arg) => arg.startsWith("+")) ? "overwrites the branch on the remote (a force push)" : undefined;
    }
    case "branch": {
      const forced = options.some((o) => long(o, "--force", 4) || short(o, "f"));
      if (options.some((o) => short(o, "D")) || (forced && options.some((o) => long(o, "--delete", 4) || short(o, "d")))) return "deletes a branch even if it isn't merged";
      if (options.some((o) => short(o, "M")) || (forced && options.some((o) => long(o, "--move", 4) || short(o, "m")))) return "overwrites a branch with another one";
      return undefined;
    }
    case "reflog":
      return sub === "expire" || sub === "delete" || options.some((o) => long(o, "--expire", 4) || long(o, "--rewrite", 4))
        ? "deletes reflog history"
        : undefined;
    case "prune":
      return "deletes unreachable git objects";
    case "gc":
      return options.some((o) => /^--prune=(?:now|all)$/i.test(o) || long(o, "--force", 4)) ||
        parsed.args.some((a) => /^--prune=(?:now|all)$/i.test(a))
        ? "prunes unreachable objects immediately"
        : undefined;
    case "update-ref":
      return options.some((o) => short(o, "d") || long(o, "--delete", 4) || long(o, "--stdin", 4))
        ? "deletes or rewrites git refs directly"
        : undefined;
    case "filter-branch":
      return "rewrites repository history";
    default:
      return undefined;
  }
}

function gitDestructive(first: ParsedCommand, options: DestructiveOptions, depth: number): string | undefined {
  let parsed = first;
  const seen = new Set<string>();
  for (;;) {
    const what = gitCommand(parsed, options.place);
    if (what) return what;
    const [word] = parsed.words;
    // git runs its own command whatever aliases say; one it doesn't know is refused by the fixed rules.
    if (word === undefined || GIT_COMMANDS.has(word)) return undefined;
    const expansion = options.gitAliases?.get(word);
    if (expansion === undefined || seen.has(word) || seen.size >= MAX_ALIASES) return undefined;
    seen.add(word);
    const at = parsed.positionalAt[0]!;
    const rest = parsed.args.slice(at + 1);
    // A shell alias: git runs it with sh, the command's remaining arguments after it.
    if (expansion.startsWith("!")) return commandLine([expansion.slice(1), ...rest].join(" "), options, depth);
    const tokens = gitSplit(expansion);
    if (!tokens) return undefined;
    parsed = { ...parseArgs("git", [...parsed.args.slice(0, at), ...tokens, ...rest]), programToken: parsed.programToken, text: parsed.text };
  }
}

/**
 * The command line a shell is given. Its own switches come first, and some take a value (`-ExecutionPolicy Bypass`,
 * `-WorkingDirectory sub`), so the line is read from every argument but a switch: `-x`, and for cmd `/x` or `/x:…`
 * (for bash, sh and wsl a `/` starts a program's path: `/bin/rm`). After a command that prints, the rest is its text.
 */
function shellDestructive(parsed: ParsedCommand, options: DestructiveOptions, depth: number): string | undefined {
  // cmd's own syntax (`if exist …`, `&`, `%x%`) isn't PowerShell's, so what ARIA reads of it may miss a command.
  const cmd = parsed.program === "cmd";
  let unreadable = parsed.unreadable !== undefined || cmd;
  for (let i = 0; i < parsed.args.length; i++) {
    const arg = parsed.args[i]!;
    if (arg.startsWith("-") || (cmd && /^\/[a-z?](?::|$)/i.test(arg))) continue;
    const read = readLine(parsed.args.slice(i).join(" "), options, depth);
    if (read.what) return read.what;
    unreadable ||= read.unreadable;
    if (PRINTERS.has(programName(arg))) break;
  }
  return unreadable ? mentioned([parsed.text, ...parsed.args]) : undefined;
}

/** A command line run by another program or a shell alias: its commands, else (when ARIA can't read it) its words. */
function commandLine(text: string, options: DestructiveOptions, depth: number): string | undefined {
  const read = readLine(text, options, depth);
  return read.what ?? (read.unreadable ? mentioned([text]) : undefined);
}

function readLine(text: string, options: DestructiveOptions, depth: number): { what?: string; unreadable: boolean } {
  const statements = scanCommand(text);
  const unreadable = statements.length === 0 || statements.some((s) => s.unreadable !== undefined);
  const commands = statements.flatMap((s) => {
    const parsed = parseCommand(s.text);
    return parsed?.withEmpty ? [parsed, parsed.withEmpty] : [parsed];
  });
  for (const command of commands) {
    const what = destructive(command, options, depth + 1);
    if (what) return { what, unreadable };
  }
  const together = destructiveTogether(commands);
  return together ? { what: together, unreadable } : { unreadable };
}

const mentioned = (texts: readonly string[]) => MENTIONS.find(([pattern]) => texts.some((text) => pattern.test(text)))?.[1];
