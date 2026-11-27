/**
 * The Phase 2 worker policy (PLAN.md §4.8 "auto" rows): what a task may do on its own when it isn't sandboxed. From
 * Phase 3 the policy engine (policy/worker.ts) turns its refusals into permission cards; `decide` is the standalone
 * verdict.
 *
 * Ported from the Phase 0 strict policy (spike/src/lib/policy.ts). It is NOT a sandbox: an allowed `npm test` runs
 * whatever code the agent wrote (Phase 0). It keeps a task's tools inside its worktree and away from the network,
 * except lockfile installs (D18).
 */
import path from "node:path";
import { insideDir } from "../conductor/policy.ts";
import type { PermissionAsk, PermissionVerdict, PolicyDecider } from "../runtime/types.ts";

const LATER = "It needs your approval.";

/** Read-only or folder-local PowerShell segments (paths are checked separately). No cmdlets that take script blocks:
 * a script block runs arbitrary .NET code without showing up as another segment (Phase 0). */
const LOCAL = /^(Get-Content|Get-ChildItem|Test-Path|Select-String|Select-Object|Sort-Object|Measure-Object|Out-Null|Out-String|Format-Table|Format-List|Write-Output|Write-Host|echo|cat|type|ls|dir|pwd|Get-Location|New-Item|mkdir|md)(\s|$)/i;
const INSTALL_FLAGS = String.raw`(\s+--(no-audit|no-fund|prefer-offline|ignore-scripts|silent|no-progress|loglevel(=\w+)?))*`;

/** Exact operations a task may run in its worktree. Programs alone (`git`, `node`, `npx`) are never allowed: they reach
 * the network or run anything (Phase 0). */
export const WORKER_SHELL_ALLOW: RegExp[] = [
  LOCAL,
  /^git (status|diff|log|show|add|commit|restore|mv|rm|ls-files|rev-parse|grep|blame)(\s|$)/i,
  /^git branch( --show-current| --list)?\s*$/i,
  /^npm (test|t)(\s|$)/i,
  /^npm run(-script)? [\w:.-]+(\s|$)/i,
  // D18: dependencies from the lockfile only, no package names.
  new RegExp(String.raw`^npm (ci|install|i)${INSTALL_FLAGS}\s*$`, "i"),
  /^pnpm (test|run [\w:.-]+)(\s|$)/i,
  /^pnpm (install|i) --frozen-lockfile\s*$/i,
  /^yarn (test|run [\w:.-]+)(\s|$)/i,
  /^yarn( install)? --frozen-lockfile\s*$/i,
  /^dotnet (build|test|restore)(\s|$)/i,
  /^cargo (build|test|check)(\s|$)/i,
  /^go (build|test|vet)(\s|$)/i,
  /^(python3?|py) -m pytest(\s|$)/i,
  /^pytest(\s|$)/i,
];

/**
 * Text that lets an allowed operation reach outside its folder: variables and subexpressions ($env:…, $(…)), script
 * blocks, type literals, escapes, redirection to files, and arguments that move a tool's target or config (--prefix,
 * -C, -c, --git-dir, --output, …). `2>&1` is allowed. Quoted text is ignored, except that `$` and backticks still count
 * inside double quotes, where PowerShell expands them.
 */
const EXPANDING = /[$`]/;
const STRUCTURAL = /[{}[\]<>]/;
const TARGET_FLAGS = /(^|\s)(--prefix|--output|--output-file|-o|--git-dir|--work-tree|--config|--global|--system|--exec|--exec-path|--upload-pack|--receive-pack|--ext-diff|--userconfig|--registry|--cache)(\s|=|$)/i;

export function hasEscapeHatch(command: string): boolean {
  const withoutSingle = command.replace(/'(?:[^']|'')*'/g, "''");
  const withoutQuotes = withoutSingle.replace(/"(?:[^"`]|`.)*"/g, '""').replace(/\s2>&1(?=\s|$|\|)/g, " ");
  return EXPANDING.test(withoutSingle) || STRUCTURAL.test(withoutQuotes) || TARGET_FLAGS.test(withoutQuotes);
}

/** PowerShell's quote characters, typographic ones included (it treats ‘ ’ “ ” like ' and "). */
const SINGLE_QUOTES = new Set(["'", "\u2018", "\u2019", "\u201a", "\u201b"]);
const DOUBLE_QUOTES = new Set(['"', "\u201c", "\u201d", "\u201e"]);
/** Dashes PowerShell reads as `-` in front of a parameter (`–Path:..` is `-Path:..`). */
const DASHES = new Set(["\u2013", "\u2014", "\u2015"]);

/** What PowerShell makes of a backtick followed by this character (`` `n `` is a new line); others are the character. */
const BACKTICK_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", a: "\x07", b: "\b", f: "\f", v: "\v", e: "\x1b" };
const backtick = (c: string) => BACKTICK_ESCAPES[c] ?? c;

/** A dollar sign PowerShell expands: a variable or a subexpression (`$x`, `$env:X`, `$(…)`, `${x}`, `$_`, `$?`). */
const EXPANDS = /[\w?^$:{(]/;
/** A redirection at the start of a word (`>`, `>>`, `2>`, `*>`, `2>&1`): neither it nor its file is an argument. */
const REDIRECTION = /^[1-6*]?>>?(?:&[1-6])?/;
const isQuote = (c: string | undefined) => c !== undefined && (SINGLE_QUOTES.has(c) || DOUBLE_QUOTES.has(c));
const isNewline = (c: string | undefined) => c === "\n" || c === "\r";
const COMPUTED = {
  dollar: "PowerShell fills in `$…` when it runs",
  paren: "PowerShell runs `(…)` as an expression",
  at: "PowerShell expands `@…` when it runs",
  list: "PowerShell reads a comma between words as a list",
};

/** One command of a PowerShell line: its text, its arguments as the program gets them, and why those can't be told from the text, if so. */
export interface ShellStatement {
  text: string;
  /** The arguments as Windows PowerShell 5.1 (the sandbox's shell) passes them: an empty one ('', "", an empty here-string) left out. */
  args: string[];
  /** The arguments as PowerShell 7 passes them, empty ones included, when that's different. */
  withEmpty?: string[];
  unreadable?: string;
}

/**
 * A PowerShell line read the way PowerShell reads it (Windows PowerShell 5.1 in the sandbox, PowerShell 7 outside it):
 * its commands (split at `;`, `|`, `&&`, `||`, line ends, and the braces of a script block, whose commands run too),
 * and each one's arguments as the program gets them:
 * - quotes removed and backtick escapes decoded (`` g`it `` is `git`; none inside single quotes); typographic quotes
 *   and dashes outside quotes count as plain ones;
 * - a word that starts with a quote ends with it (`'a'b` is two arguments); a bare word takes quoted parts in
 *   (`HEAD:ma'in'` is one);
 * - `#` starting a word starts a comment, `<#…#>` is one too, a redirection (`2>&1`, `> file`) isn't an argument, and
 *   a here-string (`@'…'@`) is one.
 * `unreadable` says why the text alone doesn't tell what the program gets: PowerShell computes part of it when it runs
 * (`$x`, `${x}`, `$(…)`, `(…)`, `@x`, a list `a, b`), `--%`, or it's text PowerShell 5.1 doesn't run (an unclosed quote,
 * `<`, a stray `&`).
 */
export function scanCommand(line: string): ShellStatement[] {
  const statements: ShellStatement[] = [];
  const n = line.length;
  let start = 0;
  let args: string[] = [];
  let withEmpty: string[] = [];
  let unreadable: string | undefined;
  const why = (reason: string | undefined) => {
    if (reason) unreadable ??= reason;
  };
  const close = (at: number, next: number) => {
    const text = line.slice(start, at).trim();
    if (text) statements.push({ text, args, ...(withEmpty.length !== args.length ? { withEmpty } : {}), ...(unreadable ? { unreadable } : {}) });
    args = [];
    withEmpty = [];
    unreadable = undefined;
    start = next;
  };
  /** An argument; an empty one only in the reading where PowerShell 7 passes it. */
  const add = (arg: string, empty: boolean) => {
    if (!empty) args.push(arg);
    withEmpty.push(arg);
  };

  /** A quoted part from its opening quote: its text, where it ends (after the closing quote), and whether it's computed. */
  const quoted = (from: number): { text: string; end: number; computed?: string } => {
    const single = SINGLE_QUOTES.has(line[from]!);
    const quotes = single ? SINGLE_QUOTES : DOUBLE_QUOTES;
    let text = "";
    let computed: string | undefined;
    for (let k = from + 1; k < n; k++) {
      const c = line[k]!;
      if (!single && c === "`" && k + 1 < n) {
        text += backtick(line[++k]!);
        continue;
      }
      if (!single && c === "$" && EXPANDS.test(line[k + 1] ?? "")) computed ??= COMPUTED.dollar;
      if (quotes.has(c)) {
        // A doubled quote is a literal quote.
        if (quotes.has(line[k + 1] ?? "")) {
          text += c;
          k++;
          continue;
        }
        return { text, end: k + 1, ...(computed ? { computed } : {}) };
      }
      text += c;
    }
    return { text, end: n, computed: computed ?? "a quote isn't closed" };
  };

  /** A here-string from its `@'` or `@"`, through the `'@` or `"@` that starts a line. */
  const hereString = (from: number): { text: string; end: number; computed?: string } => {
    const single = SINGLE_QUOTES.has(line[from + 1]!);
    const quotes = single ? SINGLE_QUOTES : DOUBLE_QUOTES;
    const body: string[] = [];
    let k = line.indexOf("\n", from) + 1;
    while (k > 0) {
      const lineEnd = line.indexOf("\n", k);
      const text = line.slice(k, lineEnd < 0 ? n : lineEnd).replace(/\r$/, "");
      if (quotes.has(text[0] ?? "") && text[1] === "@") {
        const content = body.join("\n");
        const computed = !single && /(^|[^`])\$[\w?^$:{(]/.test(content) ? COMPUTED.dollar : undefined;
        return { text: single ? content : content.replace(/`(.)/g, (_, c: string) => backtick(c)), end: k + 2, ...(computed ? { computed } : {}) };
      }
      body.push(text);
      if (lineEnd < 0) break;
      k = lineEnd + 1;
    }
    return { text: body.join("\n"), end: n, computed: "a here-string isn't closed" };
  };

  /** A word from its first character: a quoted one ends with its quote; a bare one takes quoted parts in. */
  const word = (from: number): { text: string; raw: string; end: number; computed?: string; list?: boolean } => {
    if (isQuote(line[from])) {
      const part = quoted(from);
      return { ...part, raw: line.slice(from, part.end) };
    }
    let text = "";
    let computed: string | undefined;
    let last = "";
    let k = from;
    while (k < n) {
      const c = line[k]!;
      // A brace opens or closes a script block, whose commands are commands of their own.
      if (/\s/.test(c) || c === ";" || c === "|" || c === "&" || c === "{" || c === "}") break;
      if (c === "`") {
        // At a word's start it continues the command on the next line; inside a word it escapes the line break.
        if (isNewline(line[k + 1]) && k === from) break;
        if (line[k + 1] === "\r" && line[k + 2] === "\n") {
          text += "\r\n";
          k += 3;
        } else {
          if (k + 1 < n) text += backtick(line[k + 1]!);
          k += 2;
        }
        last = "";
        continue;
      }
      if (isQuote(c)) {
        const part = quoted(k);
        computed ??= part.computed;
        text += part.text;
        k = part.end;
        last = "";
        continue;
      }
      if (c === "$" && line[k + 1] === "{") {
        // A variable written with braces (`${x}`): its name runs to the closing brace.
        const end = line.indexOf("}", k + 2);
        computed ??= COMPUTED.dollar;
        text += line.slice(k, end < 0 ? n : end + 1);
        k = end < 0 ? n : end + 1;
        last = "";
        continue;
      }
      if (c === "$" && EXPANDS.test(line[k + 1] ?? "")) computed ??= COMPUTED.dollar;
      else if (c === "(" || c === ")") computed ??= COMPUTED.paren;
      text += DASHES.has(c) ? "-" : c;
      last = c;
      k++;
    }
    return { text, raw: line.slice(from, k), end: Math.min(k, n), ...(computed ? { computed } : {}), ...(last === "," ? { list: true } : {}) };
  };

  let i = 0;
  while (i < n) {
    const c = line[i]!;
    if (isNewline(c)) {
      close(i, i + 1);
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "`" && isNewline(line[i + 1])) {
      i += line[i + 1] === "\r" && line[i + 2] === "\n" ? 3 : 2;
      continue;
    }
    if (c === ";" || c === "|" || c === "{" || c === "}") {
      const length = c === "|" && line[i + 1] === "|" ? 2 : 1;
      close(i, i + length);
      i += length;
      continue;
    }
    if (c === "&") {
      if (line[i + 1] === "&") {
        close(i, i + 2);
        i += 2;
        continue;
      }
      // The call operator, in front of the program; anywhere else PowerShell 5.1 doesn't run it.
      if (args.length === 0) add("&", false);
      else why("PowerShell 5.1 doesn't run a `&` there");
      i++;
      continue;
    }
    // At the start of a word.
    if (c === "#") {
      while (i < n && !isNewline(line[i])) i++;
      continue;
    }
    if (c === "<") {
      if (line[i + 1] === "#") {
        const end = line.indexOf("#>", i + 2);
        i = end < 0 ? n : end + 2;
      } else {
        why("PowerShell 5.1 doesn't run `<`");
        i++;
      }
      continue;
    }
    const redirection = REDIRECTION.exec(line.slice(i, i + 4))?.[0];
    if (redirection) {
      i += redirection.length;
      if (!redirection.includes("&")) {
        // Its file: attached, or the next word ($null is the usual one).
        while (i < n && (line[i] === " " || line[i] === "\t")) i++;
        if (i < n && !isNewline(line[i]) && !";|&".includes(line[i]!)) {
          const target = word(i);
          if (target.raw.toLowerCase() !== "$null") why(target.computed);
          i = target.end;
        }
      }
      continue;
    }
    if (c === "@" && isQuote(line[i + 1]) && /^[ \t]*\r?\n/.test(line.slice(i + 2))) {
      const here = hereString(i);
      add(here.text, here.text === "");
      why(here.computed);
      i = here.end;
      continue;
    }
    if (c === "@" && /[\w$({@]/.test(line[i + 1] ?? "")) why(COMPUTED.at);
    if (c === ",") why(COMPUTED.list);
    if (line.startsWith("--%", i) && (i + 3 >= n || /\s/.test(line[i + 3]!))) why("`--%` passes the rest as written, with %VARIABLES% filled in");
    const next = word(i);
    // Windows PowerShell 5.1 leaves an empty argument ('' or "") out; PowerShell 7 passes it.
    add(next.text, next.text === "" && isQuote(line[i]));
    why(next.computed);
    if (next.list) why(COMPUTED.list);
    i = next.end > i ? next.end : i + 1;
  }
  close(n, n);
  return statements;
}

/** Every argument of a line's commands as the programs get them (see scanCommand). */
export function shellArgs(segment: string): string[] {
  return scanCommand(segment).flatMap((statement) => statement.args);
}

/**
 * The commands a shell request runs, each on its own: ARIA's reading of the whole line and the runtime's segments
 * (split further where one holds more than one command). Both count, so a command one of them misses is still seen.
 */
export function commandParts(ask: { command: string; segments: readonly string[] }): string[] {
  return [...new Set([ask.command, ...ask.segments].flatMap((text) => scanCommand(text).map((statement) => statement.text)))];
}

/** Options that move where a tool reads, writes or connects (git also accepts any unambiguous prefix of a long one). */
const TARGET_LONG = ["--prefix", "--output", "--output-file", "--git-dir", "--work-tree", "--config", "--global", "--system", "--exec", "--exec-path", "--upload-pack", "--receive-pack", "--ext-diff", "--userconfig", "--registry", "--cache"];
const TARGET_SHORT = new Set(["-o"]);

function isTargetOption(arg: string, cmdlet: boolean): boolean {
  const name = arg.split(/[=:]/)[0]!.toLowerCase();
  if (name.startsWith("--")) return name.length > 3 && TARGET_LONG.some((option) => option.startsWith(name));
  // A program's short option can carry its value attached (`-o../out`); PowerShell's parameters are whole words.
  return TARGET_SHORT.has(cmdlet ? name : name.slice(0, 2));
}

/**
 * The values in an argument that can name a file: the argument itself (unless it's an option or a dotnet `/switch`),
 * and whatever follows any `=` (and, after an option or switch, any `:`: `-Path:x`, MSBuild's `-p:OutputPath=x`), and
 * each item of a list.
 */
function argValues(arg: string, switchLike: boolean): string[] {
  const values = new Set<string>();
  const option = arg.startsWith("-") || switchLike;
  if (!option) values.add(arg);
  for (let i = 0; i < arg.length; i++) if (arg[i] === "=" || (option && arg[i] === ":")) values.add(arg.slice(i + 1));
  return [...values].flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
}

/**
 * A program's short options can be clustered, the first one that takes a value taking the rest of the argument
 * (`-nf../x`, `-aF../x`). Without knowing which letters take values, every tail of the option letters (up to the first
 * `=` or `:`, which end an option's name) could be that value.
 */
function clusterTails(arg: string): string[] {
  if (!/^-[^-]/.test(arg)) return [];
  const end = arg.search(/[=:]/);
  const tails: string[] = [];
  for (let i = 2; i < (end === -1 ? arg.length : end); i++) tails.push(arg.slice(i));
  return tails.filter(Boolean);
}

/** PowerShell drives that aren't folders: environment variables, the registry, certificates, functions and so on. */
const PROVIDER_DRIVE = /^(alias|cert|env|function|hkcc|hkcr|hkcu|hklm|hku|temp|variable|wsman):/i;
/** A provider-qualified path (`FileSystem::C:\…`, `Microsoft.PowerShell.Core\Registry::…`), which ignores the current folder. */
const PROVIDER_PATH = /^(?:[\w.]+\\)?(filesystem|registry|alias|environment|function|variable|certificate|wsman)::/i;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * New-Item's item type, which PowerShell takes as any prefix (`-it j` makes a junction): only files and folders, since
 * a link inside the worktree could point anywhere. The parameter itself can be shortened too (`-It`, `-Ty`).
 */
function newItemTypeAllowed(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) continue;
    const [rawName = "", ...rest] = arg.slice(1).split(":");
    const name = rawName.toLowerCase();
    const isType = (name.length >= 2 && "itemtype".startsWith(name)) || (name.length >= 1 && "type".startsWith(name));
    if (!isType) continue;
    const attached = rest.join(":");
    const value = (arg.includes(":") && attached ? attached : (args[i + 1] ?? "")).toLowerCase();
    if (!value || !("file".startsWith(value) || "directory".startsWith(value))) return false;
  }
  return true;
}

/**
 * Inside the worktree, but not its `.git` link: rewriting it would point git at another repository's history. Windows
 * names it in other ways too: with trailing dots or spaces (`.git.`), with a stream (`.git:x`), or by its short 8.3
 * name (`GIT~1`, or `GI` + a hash + `~1` once names collide), so those are refused for the first folder level as well.
 */
export function insideWorktree(target: string, worktree: string): boolean {
  if (!insideDir(target, worktree)) return false;
  const first = path.relative(path.resolve(worktree), path.resolve(worktree, target)).split(/[\\/]/)[0] ?? "";
  const name = first.replace(/:.*$/, "").replace(/[. ]+$/, "").toLowerCase();
  return name !== ".git" && !/^gi[^.]*~\d/.test(name);
}

export class WorkerPolicy implements PolicyDecider {
  constructor(
    private readonly deps: {
      /** The task's worktree. */
      worktree: string;
      /** Wire names of the MCP tools the task may use. */
      readTools: ReadonlySet<string>;
      /** More commands that run on their own (your Auto rules); their arguments are still checked. */
      extraAllow?: (segment: string) => boolean;
    },
  ) {}

  /** The standalone verdict (Phase 2): refusals explain themselves to the worker. */
  decide(ask: PermissionAsk): PermissionVerdict {
    const why = this.check(ask);
    if (why === undefined) return { approve: true };
    const text = ask.kind === "shell" ? `\`${ask.command.trim()}\` isn't allowed here: ${why}` : why[0]!.toUpperCase() + why.slice(1);
    return { approve: false, reason: `${text}. ${LATER}` };
  }

  /** Why the request isn't fine on its own (inside the worktree, an allowed operation), or undefined when it is. */
  check(ask: PermissionAsk): string | undefined {
    const { worktree } = this.deps;
    switch (ask.kind) {
      case "read":
        return insideWorktree(ask.path, worktree) ? undefined : `reading ${ask.path} is outside this task's worktree`;
      case "write":
        return insideWorktree(ask.path, worktree) ? undefined : `writing ${ask.path} is outside this task's worktree`;
      case "shell":
        return this.shell(ask);
      case "mcp":
        return this.deps.readTools.has(ask.tool) ? undefined : `${ask.tool} isn't available to tasks`;
      case "custom-tool":
        return undefined;
      case "url":
        return `opening ${ask.url} needs network access`;
      default:
        return `${ask.detail} isn't allowed in a task`;
    }
  }

  private shell(ask: Extract<PermissionAsk, { kind: "shell" }>): string | undefined {
    const { worktree } = this.deps;
    const text = ask.command.trim();
    const deny = (why: string) => why;
    if (ask.segments.length === 0) return deny("ARIA couldn't tell what it runs");
    const allowed = (segment: string) => WORKER_SHELL_ALLOW.some((re) => re.test(segment)) || (this.deps.extraAllow?.(segment) ?? false);
    const unknown = ask.segments.find((segment) => !allowed(segment.trim()));
    if (unknown !== undefined) return deny(`only tests, builds, lockfile installs, git status/diff/add/commit and read-only commands run without asking (not \`${unknown.trim()}\`)`);
    if (hasEscapeHatch(text)) return deny("variables, script blocks, redirection and options that change where a tool works aren't allowed");
    if (ask.cwd !== undefined && !insideWorktree(ask.cwd, worktree)) return deny("it would run outside the worktree");
    if (/(^|[\s"'\\/])\.\.([\\/]|$)/.test(text)) return deny("it refers to a parent folder");
    // A drive path anywhere in the text (not the `s://` inside a URL).
    const absolute = text.match(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"';|]*/g) ?? [];
    if (!absolute.every((p) => insideWorktree(p, worktree)) || !ask.possiblePaths.every((p) => insideWorktree(p, worktree))) {
      return deny("it refers to files outside the worktree");
    }
    if (ask.possibleUrls.length > 0) return deny("it contacts a URL");
    // Each argument as the program gets it (quotes removed): options that move a tool's target, and every value that can
    // name a file, which must stay inside the worktree and off its .git link.
    const cwd = ask.cwd ?? worktree;
    for (const segment of ask.segments) {
      const [command = "", ...args] = shellArgs(segment.trim());
      const cmdlet = LOCAL.test(segment.trim());
      if (/^new-item$/i.test(command) && !newItemTypeAllowed(args)) return deny("only files and folders can be created, not links");
      for (const arg of args) {
        if (arg === "--%") return deny("PowerShell's stop-parsing token isn't allowed");
        // PowerShell turns a leading ~ into your home folder, for programs too.
        if (arg.startsWith("~")) return deny("it refers to your home folder");
        if (arg.startsWith("-") && isTargetOption(arg, cmdlet)) return deny("options that change where a tool works aren't allowed");
        // dotnet (MSBuild) also takes switches as `/p:Name=Value`, `/nologo`.
        const switchLike = /^dotnet$/i.test(command) && /^\/[A-Za-z][\w-]*(?=[:=]|$)/.test(arg);
        for (const value of argValues(arg, switchLike)) {
          const why = this.outside(value, cwd, cmdlet);
          if (why) return deny(why);
        }
        if (cmdlet) continue;
        for (const tail of clusterTails(arg)) {
          const why = this.outside(tail, cwd, false);
          if (why) return deny(`${why} (if that's a short option's value, write it apart, as in \`-f file\`, so the path can be checked)`);
        }
      }
    }
    return undefined;
  }

  /** Why a value from a command's arguments reaches outside the worktree, if it does. */
  private outside(value: string, cwd: string, cmdlet: boolean): string | undefined {
    if (URL_LIKE.test(value)) return "it contacts a URL";
    if (value.split(/[\\/]/).includes("..")) return "it refers to a parent folder";
    // PowerShell's own commands also read `~` and drives like env: or HKLM:; programs get those as plain text.
    if (cmdlet && (value.startsWith("~") || PROVIDER_PATH.test(value) || PROVIDER_DRIVE.test(value))) return "it reads something other than the worktree's files";
    if (!insideWorktree(path.resolve(cwd, value), this.deps.worktree)) return "it refers to files outside the worktree, or to its .git link";
    return undefined;
  }
}
