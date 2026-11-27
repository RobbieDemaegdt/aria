/**
 * The worker policy engine (PLAN.md §4.8, D20, D21): for each permission request of a task, `auto` (it runs), `ask`
 * (a permission card; the task waits for you) or `never` (refused with the reason, so the worker carries on without
 * it).
 *
 * - Built-in hard rules, whatever the settings: no push to the default branch, no deleting or mirroring remote
 *   branches, no merging pull requests; and a sandboxed task can't push at all (no access to GitHub).
 * - Destructive commands (policy/destructive.ts, D28, D29) ask every time, whatever your rules or grants say.
 * - Your rules (Customize › Permissions) match single commands; the most specific one wins. A rule can be exact (only
 *   that command), and apply to sandboxed tasks only (D27); an Auto rule never matches a program named by its folder.
 * - A sandboxed task runs every other command on its own: the sandbox confines it to its worktree and the network to
 *   package registries. Files outside the worktree are refused (the sandbox would block them anyway).
 * - A task that isn't sandboxed runs on its own only what the Phase 2 checks allow (tests, builds, lockfile installs,
 *   git basics, read-only commands, inside the worktree) plus your Auto rules; anything else is asked.
 * - "Approve for this task" (D21) stores the command, argument for argument, and the folder it ran in (or a web host, or
 *   a folder for files); the same ones later run without asking.
 */
import path from "node:path";
import type { PermissionKind, PolicyRule, RuleEffect, TaskGrant } from "@aria/protocol";
import { insideDir } from "../conductor/policy.ts";
import { githubFixed, isGithubName, type McpRule } from "../integrations/rules.ts";
import { classifyTool, serverWirePrefix } from "../integrations/scope.ts";
import type { PermissionAsk } from "../runtime/types.ts";
import { commandParts, insideWorktree, WorkerPolicy } from "../tasks/policy.ts";
import type { PushSettings } from "../tasks/worktrees.ts";
import { DEFAULT_GH_ALIASES, GH_TOP_COMMANDS, GIT_COMMANDS, gitSplit, shlexSplit } from "./aliases.ts";
import {
  canonicalPath,
  commandIdentity,
  parseArgs,
  parseCommand,
  ruleMatches,
  ruleShape,
  ruleWeight,
  type GhReading,
  type Identity,
  type ParsedCommand,
  type RuleShape,
} from "./command.ts";
import { destructive, destructiveTogether } from "./destructive.ts";

export interface WorkerPolicyContext {
  worktree: string;
  sandboxed: boolean;
  /** The task's Copilot session folder (`~/.copilot/session-state/<sessionId>`), where plan mode stores `plan.md`. */
  sessionDir?: string;
  /** Read-only skill, plugin, and agent directories that a task may read (`view`, `glob`, `grep`) without writing. */
  readonlyRoots?: readonly string[];
  /**
   * Your rule for a task's MCP tool, by its server and wire name (Customize › Integrations). Without it (older callers),
   * the tools in `readTools` run and nothing else does.
   */
  mcp?: (server: string, wireName: string) => McpRule | undefined;
  /** Wire names of the MCP tools the task may use. */
  readTools: ReadonlySet<string>;
  rules: readonly PolicyRule[];
  grants: readonly TaskGrant[];
  /** The repository's default branch, which is never pushed to. */
  defaultBranch?: string;
  /** git aliases from your config and the repository's (lowercase name → what it stands for), so `git p` is a push too. */
  gitAliases?: ReadonlyMap<string, string>;
  /** The `git-<name>` programs on PATH (git runs them before an alias of that name); null when they couldn't be listed. */
  gitExternals?: ReadonlySet<string> | null;
  /** gh's aliases (gh's defaults when not given); null when they couldn't be read, so gh commands are refused. */
  ghAliases?: ReadonlyMap<string, string> | null;
  /** The branch checked out where the command runs: a push of HEAD (or without a destination) pushes it. */
  checkedOut?: string;
  /** git's push settings where the command runs (read for a push); null when they couldn't be read, so pushes are refused. */
  pushSettings?: PushSettings | null;
}

/** What a permission card shows, and what "Approve for this task" stores. */
export interface PermissionRequestDetails {
  kind: PermissionKind;
  what: string;
  /** Where it acts, when that isn't simply the task's worktree. */
  where?: string;
  why?: string;
  reason: string;
  /** What "Approve for this task" lets it do again, as a phrase ("run npm install lodash"). */
  scope: string;
  grants: Array<Identity & { label: string }>;
  /** A destructive command (D28): it asks every time; no grant covers it and "Approve for this task" isn't offered (D29). */
  everyTime?: boolean;
}

/** `rule`: the rule of yours that refused it (otherwise a fixed rule or a check did). */
export type PolicyDecision = { effect: "auto" } | { effect: "never"; reason: string; rule?: PolicyRule } | { effect: "ask"; request: PermissionRequestDetails };

const AUTO: PolicyDecision = { effect: "auto" };
const never = (reason: string): PolicyDecision => ({ effect: "never", reason });
const STRICTNESS: Record<RuleEffect, number> = { auto: 0, ask: 1, never: 2 };

interface CompiledRule {
  rule: PolicyRule;
  shape: RuleShape;
  weight: number;
}

/** Rules that can't be read (an empty match) are left out. */
export function compileRules(rules: readonly PolicyRule[]): CompiledRule[] {
  return rules.flatMap((rule) => {
    const shape = ruleShape(rule.match, rule.exact === true);
    return shape ? [{ rule, shape, weight: ruleWeight(shape) }] : [];
  });
}

/** A program named by its folder (`.\npm.cmd`, `C:\wt\…\node.exe`, `C:npm`): a task can put its own program there. */
export const namesFolder = (programToken: string) => /[\\/:]/.test(programToken);

/**
 * The rule for a command: the most specific match, the strictest one among equally specific ones. A sandboxed-only
 * rule doesn't apply to a task without the sandbox (D27), and an Auto rule never to a program named by its folder.
 */
export function ruleFor(rules: readonly CompiledRule[], parsed: ParsedCommand | undefined, sandboxed: boolean): PolicyRule | undefined {
  if (!parsed) return undefined;
  let best: CompiledRule | undefined;
  for (const candidate of rules) {
    if (candidate.rule.scope === "sandboxed" && !sandboxed) continue;
    if (candidate.rule.effect === "auto" && namesFolder(parsed.programToken)) continue;
    if (!ruleMatches(candidate.shape, parsed)) continue;
    if (!best || candidate.weight > best.weight || (candidate.weight === best.weight && STRICTNESS[candidate.rule.effect] > STRICTNESS[best.rule.effect])) best = candidate;
  }
  return best?.rule;
}

const granted = (grants: readonly TaskGrant[], identity: Identity) => grants.some((g) => g.key === identity.key && g.target === identity.target);

/** git push's long options that delete, mirror or push every branch (git takes any unambiguous start of one). */
const DESTRUCTIVE_PUSH = ["--delete", "--mirror", "--all", "--branches", "--prune"];

/** A git push or a gh pr merge inside a command another program runs (cmd /c, pwsh -Command, Start-Process, node -e…). */
const WRAPPED = /\bgit(?:\.exe)?\b[\s\S]*\bpush\b|\bgh(?:\.exe)?\b[\s\S]*\bpr\b[\s\S]*\bmerge\b/i;
/** A push or a merge mentioned anywhere. */
const PUSH_OR_MERGE = /\bpush\b|\bmerge\b|mergePullRequest/i;
/** A program written as an expression (`& ('g'+'it')`, `& $x`): which one runs can't be told from the text. */
const EXPRESSION = /[$(){}@+]/;
/** Programs that run the text they're given as commands: a push or a merge anywhere in it is refused. */
const SHELLS = new Set(["cmd", "powershell", "pwsh", "bash", "sh", "wsl", "invoke-expression", "iex", "invoke-command", "icm", "start-job", "start-process", "saps", "start"]);
/** Defining a PowerShell alias or function: one for git or gh hides a push or a merge behind another name. */
const DEFINITIONS = new Set(["set-alias", "new-alias", "sal", "nal", "function", "filter"]);
const GIT_OR_GH = /\b(?:git|gh)(?:\.exe)?\b/i;
/** How many aliases deep ARIA follows one (git stops alias loops itself, much sooner). */
const MAX_ALIASES = 10;

/** gh's own top-level commands. Any other word is an alias ARIA doesn't know or an extension, which could merge. */
const GH_COMMANDS = GH_TOP_COMMANDS;

/** The branch a refspec pushes to: `HEAD:refs/heads/main`, `HEAD:heads/main` and `main` all push to main. */
function pushedBranch(spec: string): string {
  const destination = spec.includes(":") ? spec.slice(spec.lastIndexOf(":") + 1) : spec;
  return destination.replace(/^refs\//i, "").replace(/^heads\//i, "");
}

/**
 * The ways a shell may read a command's words: as written, without cmd's `^` escapes, quotes and backslash escapes,
 * and with a backslash read as a folder separator (`C:\…\git.exe`).
 */
function readings(text: string): string[] {
  const unquoted = text.replace(/[\^"'`]/g, "");
  return [text, unquoted.replace(/\\/g, ""), unquoted.replace(/\\/g, " ")];
}
const mentions = (pattern: RegExp, text: string) => readings(text).some((reading) => pattern.test(reading));

/** A git alias's arguments in place of the word that called it, git's own options before it and the arguments after it. */
function expandGit(parsed: ParsedCommand, tokens: string[]): ParsedCommand {
  const at = parsed.positionalAt[0]!;
  return { ...parseArgs("git", [...parsed.args.slice(0, at), ...tokens, ...parsed.args.slice(at + 1)]), programToken: parsed.programToken, text: parsed.text };
}

/** The arguments after an alias's words. */
const restAfter = (parsed: ParsedCommand, words: number) => parsed.args.slice(parsed.positionalAt[words - 1]! + 1);

/** PowerShell's commands that change the folder the commands after them run in. */
const CHANGES_FOLDER = new Set(["cd", "chdir", "sl", "set-location", "pushd", "push-location", "popd", "pop-location"]);
/** Environment variables that change which settings, aliases or repository git and gh use. */
const GIT_ENVIRONMENT = /env:(?:GIT_(?:CONFIG|DIR\b|WORK_TREE|COMMON_DIR|EXEC_PATH|NAMESPACE)|GH_CONFIG_DIR)/i;
/** Moving the folders git and gh find their settings in. */
const CONFIG_HOMES = /env:(?:XDG_CONFIG_HOME|HOME|USERPROFILE|APPDATA)\s*=/i;
/** PowerShell's commands that set an item, an environment variable too (`Set-Item env:X`). */
const ITEM_WRITERS = new Set(["set-item", "si", "new-item", "ni"]);
/** git settings that change what a push sends or where, what a git command stands for, or what programs/hooks git executes (Phase 9, D77). */
const PUSH_SETTINGS =
  /^(?:alias\.|include\.|includeif\.|remote\..+\.(?:push|mirror)$|push\.default$|branch\..+\.merge$|core\.(?:hookspath|fsmonitor|sshcommand|askpass|editor|pager|gitproxy)$|credential\.|protocol\.(?:allow$|[^=]+\.allow$)|uploadpack\.|receivepack\.|(?:transfer|fetch)\.fsckobjects$|filter\.[^=]+\.(?:clean|smudge|process)$|diff\.[^=]+\.(?:command|textconv)$|maintenance\.)/i;
/** push.default values that push only the branch that's checked out, under its own name (or nothing). */
const SAFE_PUSH_DEFAULTS = new Set(["simple", "current", "nothing"]);
/** gh api endpoints that change branches, rulesets, branch protection, secrets, keys or hooks (Phase 9, D77). */
const BRANCH_ENDPOINTS =
  /\/(?:merges?|merge-upstream|git\/refs?|contents|rename|rulesets?|protection|secrets|variables|keys|hooks)(?:[/?#]|$)/i;
/** gh api endpoints that trigger or rerun GitHub Actions workflows (require user approval). */
const WORKFLOW_DISPATCH_ENDPOINTS =
  /\/(?:workflows\/[^/?#]+\/dispatches|actions\/runs\/[^/?#]+\/rerun(?:-failed-jobs)?)(?:[/?#]|$)/i;
/** The GraphQL endpoint, by name (`graphql`) or by path (`/graphql`, a full URL). */
const GRAPHQL = /(?:^|\/)graphql\/?(?:[?#].*)?$/i;
/** A repository itself (`repos/o/r`): a PATCH/DELETE/POST/PUT to it changes its settings or deletes the repository. */
const REPOSITORY = /(?:^|\/)repos\/[^/?#\s]+\/[^/?#\s]+\/?(?:[?#].*)?$/i;
/** gh api's flags that take a value: short ones (in a cluster, the rest of it or the next argument), long ones. */
const API_VALUE_SHORT = new Set(["F", "f", "H", "p", "q", "t", "X"]);
const API_VALUE_LONG = new Set(["--field", "--raw-field", "--header", "--method", "--input", "--preview", "--jq", "--template", "--cache", "--hostname"]);
/** gh api's flags that send a body, which makes the request a POST when no method is given. */
const API_BODY = new Set(["-F", "-f", "--field", "--raw-field", "--input"]);
/** Settings for one git command (`-c key=value`, `--config-env=key=VAR`) that define aliases, include config, execute programs/hooks, or change pushes. */
const INLINE_SETTINGS =
  /^(?:alias\.|include\.|includeif\.|remote\.[^=]*\.(?:push|mirror)(?:=|$)|push\.default(?:=|$)|branch\.[^=]*\.merge(?:=|$)|core\.(?:hookspath|fsmonitor|sshcommand|askpass|editor|pager|gitproxy)(?:=|$)|credential\.|protocol\.(?:allow(?:=|$)|[^=]*\.allow(?:=|$))|uploadpack\.|receivepack\.|(?:transfer|fetch)\.fsckobjects(?:=|$)|filter\.[^=]*\.(?:clean|smudge|process)(?:=|$)|diff\.[^=]*\.(?:command|textconv)(?:=|$)|maintenance\.)/i;
/** git commands that push without being `git push`. */
const OTHER_PUSHES = new Set(["send-pack", "http-push"]);

type RuleContext = WorkerPolicyContext & {
  /** An earlier command in the same line changed folders, so this one may run in another repository. */
  moved?: boolean;
};

/**
 * Rules ARIA never breaks (§4.8), whatever your settings or grants say: no push to the default branch, no deleting,
 * mirroring or pushing every branch, no merging pull requests, and a sandboxed task doesn't push at all. They read a
 * command the way PowerShell passes it (quotes, escapes, comments, redirections), refuse a git or gh command whose
 * words PowerShell computes when it runs (`$x`, `(…)`, `@x`), and follow git and gh aliases and git's push settings the
 * way git and gh do. A push or a merge they can't see through (run by another program, by a shell alias, or by a
 * program written as an expression) is refused as well, and so are changes to what git and gh read (their aliases and
 * push settings, the environment they read them from). Code inside scripts and interpreters isn't read: in the
 * sandbox that can't reach GitHub, and without it the command asks first.
 */
function hardRule(parsed: ParsedCommand | undefined, ctx: RuleContext): string | undefined {
  if (!parsed) return undefined;
  if (parsed.program === "git" || parsed.program === "gh") {
    // The rules read the words the program gets, so those have to be in the text.
    if (parsed.unreadable) return `ARIA can't tell what this ${parsed.program} command does: ${parsed.unreadable}. Write it out (single quotes keep text as it is)`;
    if (parsed.program === "git") return gitRule(parsed, ctx);
    // Windows PowerShell 5.1, the sandbox's shell, passes a `"` inside an argument on unescaped: gh splits it again.
    if (ctx.sandboxed && parsed.args.some((arg) => arg.includes('"'))) {
      return "Windows PowerShell 5.1 (the sandbox's shell) passes a \" inside an argument on as it is, so gh may read it as more than one argument: leave it out";
    }
    // As gh finds its command, and with only the flags ARIA knows taking a value: both readings have to pass.
    return ghRule(parsed, ctx, "cobra") ?? ghRule({ ...parseArgs("gh", parsed.args, "known"), programToken: parsed.programToken, text: parsed.text }, ctx, "known");
  }
  const decoded = [parsed.programToken, ...parsed.args].join(" ");
  if (
    mentions(GIT_ENVIRONMENT, parsed.text) ||
    mentions(CONFIG_HOMES, parsed.text) ||
    mentions(/SetEnvironmentVariable/i, parsed.text) ||
    (ITEM_WRITERS.has(parsed.program) && parsed.args.some((arg) => /^env:/i.test(arg)))
  ) {
    return "changing the environment git and gh read their settings from isn't allowed in tasks";
  }
  if (SHELLS.has(parsed.program) && mentions(PUSH_OR_MERGE, decoded)) return "running a push or a merge through another program isn't allowed: run git directly";
  if (mentions(WRAPPED, parsed.text) || mentions(WRAPPED, decoded)) return "running git push or gh pr merge through another program isn't allowed: run it directly";
  if ((DEFINITIONS.has(parsed.program) || mentions(/\b(?:function|alias):/i, decoded)) && mentions(GIT_OR_GH, decoded)) {
    return "defining a PowerShell alias or function for git or gh in a command isn't allowed";
  }
  if (EXPRESSION.test(parsed.programToken) && mentions(PUSH_OR_MERGE, decoded)) return "ARIA can't tell which program this runs, and it mentions a push or a merge: run git directly";
  return undefined;
}

function gitRule(first: ParsedCommand, ctx: RuleContext): string | undefined {
  let parsed = first;
  const seen = new Set<string>();
  for (;;) {
    if (parsed.options.some((o) => longOption(o, "--exec-path"))) {
      return "changing git's exec-path isn't allowed in tasks (it can run other programs as git commands)";
    }
    // Settings for this one command (an alias's too) can define an alias, include config that does, execute hooks/helpers, or change pushes.
    if (parsed.options.some((o) => INLINE_SETTINGS.test(o.replace(/^(?:-c|--config-env=)/i, "")))) {
      return "changing git's aliases, includes, hooks, credentials or push settings for a command isn't allowed";
    }
    const [word, sub] = parsed.words;
    if (word === "push") return pushRule(parsed, ctx);
    if ((word && OTHER_PUSHES.has(word)) || (word === "subtree" && parsed.positional.includes("push"))) return `pushing with git ${word} isn't allowed in tasks: use git push`;
    // It runs the git command it's given in each repository listed in a setting, where ARIA reads nothing.
    if (word === "for-each-repo") return "running a git command in other repositories isn't allowed in tasks";
    if (word === "config") return configRule(parsed, ctx);
    if (word === "maintenance" && (sub === undefined || ["register", "unregister", "start", "stop"].includes(sub))) {
      return `running git maintenance${sub ? ` ${sub}` : ""} isn't allowed in tasks (it changes your global git config and OS scheduled tasks)`;
    }
    if (word === "hook") {
      return "running git hooks directly isn't allowed in tasks";
    }
    if (word === "archive" && parsed.options.some((o) => longOption(o, "--exec") || longOption(o, "--remote"))) {
      return "running git archive with --exec or --remote isn't allowed in tasks";
    }
    if (word === "replay") {
      const def = ctx.defaultBranch?.toLowerCase();
      const tail = parsed.args.slice(parsed.positionalAt[0]! + 1);
      const touchesDefault =
        tail.some((a) => longOption(a, "--contained")) ||
        (def !== undefined &&
          tail.some((a) => {
            const lower = a.toLowerCase();
            const val = lower.includes("=") ? lower.slice(lower.indexOf("=") + 1) : lower;
            const clean = val.replace(/^refs\/heads\//, "").replace(/^heads\//, "");
            return clean === def;
          }));
      if (touchesDefault) {
        return "replaying commits onto or advancing the default branch isn't allowed in tasks";
      }
    }
    if (word === "update-ref" && ctx.defaultBranch) {
      const def = ctx.defaultBranch.toLowerCase();
      const tail = parsed.args.slice(parsed.positionalAt[0]! + 1);
      const touchesDefault = tail.some((a) => {
        if (a.startsWith("-")) return false;
        const clean = a.toLowerCase().replace(/^refs\/heads\//, "").replace(/^heads\//, "");
        return clean === def;
      });
      if (touchesDefault) {
        return `updating or deleting ${ctx.defaultBranch}, the default branch, with git update-ref isn't allowed in tasks`;
      }
    }
    if (word === "branch" && ctx.defaultBranch) {
      const def = ctx.defaultBranch.toLowerCase();
      const tail = parsed.args.slice(parsed.positionalAt[0]! + 1);
      const hasForceOrMutate = parsed.options.some(
        (o) =>
          longOption(o, "--force") ||
          longOption(o, "--delete") ||
          longOption(o, "--move") ||
          longOption(o, "--copy") ||
          /^-[A-Za-z0-9]*[fFDMmCc]/.test(o),
      );
      if (
        hasForceOrMutate &&
        tail.some((a) => {
          if (a.startsWith("-")) return false;
          const clean = a.toLowerCase().replace(/^refs\/heads\//, "").replace(/^heads\//, "");
          return clean === def;
        })
      ) {
        return `overwriting, moving or deleting ${ctx.defaultBranch}, the default branch, isn't allowed in tasks`;
      }
    }
    // git takes an option by any start of its name (`--mir`).
    if (word === "remote" && sub === "add" && parsed.options.some((o) => longOption(o, "--mirror"))) return "adding a remote that mirrors isn't allowed in tasks (a push to it sends every branch)";
    const runs = runsCommands(parsed);
    if (runs && mentions(runs === "setting" ? WRAPPED : PUSH_OR_MERGE, [parsed.programToken, ...parsed.args].join(" "))) {
      return "a git command that runs another command mentions a push or a merge, which isn't allowed: run git push directly";
    }
    // git runs its own command whatever aliases say.
    if (word === undefined || GIT_COMMANDS.has(word)) return undefined;
    // Any other word is a git-<word> program on PATH (git tries those before aliases), which could push, or an alias.
    if (ctx.gitExternals === null || ctx.gitExternals?.has(word)) return `\`git ${word}\` runs git-${word}, a program that isn't part of git (it could push)`;
    // In another repository its aliases are that repository's, which ARIA didn't read.
    if (parsed.options.some((o) => /^-C/.test(o) || o.startsWith("--git-dir") || o.startsWith("--work-tree"))) return `ARIA can't tell what \`git ${word}\` does in another repository`;
    const expansion = ctx.gitAliases?.get(word);
    if (expansion === undefined) return `\`git ${word}\` isn't one of git's commands or your aliases (another program could push)`;
    if (seen.has(word) || seen.size >= MAX_ALIASES) return `the git alias \`${word}\` doesn't resolve (it loops)`;
    seen.add(word);
    if (expansion.startsWith("!")) {
      // git runs it with sh, the command's remaining arguments after it.
      const shell = [expansion.slice(1), ...restAfter(parsed, 1)].join(" ");
      return mentions(WRAPPED, shell) ? `the git alias \`${word}\` runs a push or a merge through the shell, which isn't allowed here: run git push directly` : undefined;
    }
    const tokens = gitSplit(expansion);
    if (!tokens) return `the git alias \`${word}\` can't be read`;
    parsed = expandGit(parsed, tokens);
  }
}

/** Whether a git option is this long option, by any start of its name (`--ex` for `--exec`), with or without `=value`. */
const longOption = (option: string, name: string) => {
  const given = option.split("=")[0]!;
  return given.length > 2 && name.startsWith(given);
};

/**
 * Whether a git command runs another command: one it's given (`rebase -x`, `bisect run`, `submodule foreach`,
 * `filter-branch`, `difftool -x`), or a program a setting for the command names (`-c core.editor=…`).
 */
function runsCommands(parsed: ParsedCommand): "command" | "setting" | undefined {
  const [word, sub] = parsed.words;
  const options = parsed.options.map((o) => o.split("=")[0]!);
  if (options.some((o) => /^-c/.test(o) || o === "--config-env")) return "setting";
  if (word === "rebase" && options.some((o) => longOption(o, "--exec") || /^-[A-Za-z]*x/.test(o))) return "command";
  if ((word === "bisect" && sub === "run") || (word === "submodule" && sub === "foreach") || word === "filter-branch") return "command";
  if ((word === "difftool" || word === "mergetool") && options.some((o) => longOption(o, "--extcmd") || /^-[A-Za-z]*x/.test(o))) return "command";
  return undefined;
}

/** `git config` may read local config, but not use --global/--system, point --file outside the worktree, or change aliases, includes, hooks or push settings. */
function configRule(parsed: ParsedCommand, ctx: RuleContext): string | undefined {
  const args = parsed.args.slice(parsed.positionalAt[0]! + 1);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (longOption(arg, "--global") || longOption(arg, "--system")) {
      return "reading or changing global or system git config (--global / --system) isn't allowed in tasks";
    }
    if (longOption(arg, "--file") || arg === "-f" || (/^-f.+/.test(arg) && !arg.startsWith("--"))) {
      let filePath: string;
      if (arg.startsWith("--")) {
        filePath = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : (args[++i] ?? "");
      } else {
        filePath = arg.length > 2 ? arg.slice(2) : (args[++i] ?? "");
      }
      if (!filePath || !insideWorktree(path.resolve(ctx.worktree, filePath), ctx.worktree)) {
        return "using git config --file outside the task's worktree isn't allowed";
      }
    }
  }
  // git takes a long option by any start of its name (`--ren`) and short ones in a cluster (`-le`).
  const rewrites = (arg: string) => {
    const name = arg.split("=")[0]!.toLowerCase();
    if (name === "rename-section" || name === "edit") return true;
    if (name.startsWith("--")) return name.length > 2 && ["--rename-section", "--edit"].some((option) => option.startsWith(name));
    return /^-[a-z]*e/.test(name);
  };
  if (args.some((arg) => PUSH_SETTINGS.test(arg.split("=")[0]!) || rewrites(arg))) {
    return "changing git's aliases, includes, hooks, credentials or push settings in a task isn't allowed";
  }
  return undefined;
}

function ghRule(first: ParsedCommand, ctx: RuleContext, reading: GhReading): string | undefined {
  if (ctx.ghAliases === null) return "ARIA couldn't read your gh aliases, so it can't tell what this gh command does";
  const aliases = ctx.ghAliases ?? DEFAULT_GH_ALIASES;
  let parsed = first;
  const seen = new Set<string>();
  for (;;) {
    // The longest alias the command's first words spell (gh aliases can be several words: "pr finish"). gh ignores one
    // with the name of one of its commands (`pr`), and one of several words that isn't under one of them.
    let name: string | undefined;
    let length = 0;
    for (const alias of aliases.keys()) {
      const parts = alias.split(" ");
      if (parts.length === 1 ? GH_COMMANDS.has(parts[0]!) : !GH_COMMANDS.has(parts[0]!)) continue;
      if (parts.length > length && parts.length <= parsed.positional.length && parts.every((part, i) => part === parsed.positional[i])) {
        name = alias;
        length = parts.length;
      }
    }
    if (!name) break;
    // gh also ignores one with the name of a subcommand (`pr merge`). ARIA doesn't know them all: the command has to
    // pass without the alias as well.
    const without = length > 1 ? ghCommandRule(parsed, ctx) : undefined;
    if (without) return without;
    if (seen.has(name) || seen.size >= MAX_ALIASES) return `the gh alias \`${name}\` doesn't resolve (it loops)`;
    seen.add(name);
    const expansion = aliases.get(name)!;
    // Like gh: the alias gets every argument but its own words, flags in front of them too.
    const own = new Set(parsed.positionalAt.slice(0, length));
    const rest = parsed.args.filter((_, i) => !own.has(i));
    if (expansion.startsWith("!")) {
      const shell = [expansion.slice(1), ...rest].join(" ");
      return mentions(WRAPPED, shell) || mentions(/\bmerge\b/i, shell) ? `the gh alias \`${name}\` runs a merge through the shell, which isn't allowed` : undefined;
    }
    // Like gh: while the expansion has a `$` in it, each argument fills its $1, $2…; the ones after that go at the end.
    let text = expansion;
    const extra: string[] = [];
    rest.forEach((arg, i) => {
      if (text.includes("$")) text = text.split(`$${i + 1}`).join(arg);
      else extra.push(arg);
    });
    if (/\$\d/.test(text)) return `the gh alias \`${name}\` needs more arguments than it got`;
    const tokens = shlexSplit(text);
    if (!tokens) return `the gh alias \`${name}\` can't be read`;
    // gh runs the expansion as its whole command line.
    parsed = { ...parseArgs("gh", [...tokens, ...extra], reading), programToken: first.programToken, text: first.text };
  }
  return ghCommandRule(parsed, ctx);
}

/** What gh itself does with a command, aliases resolved (Phase 9, D77). */
function ghCommandRule(parsed: ParsedCommand, ctx: RuleContext): string | undefined {
  const [word, sub] = parsed.words;
  if (word === "pr" && sub === "merge") return "merging pull requests isn't allowed";
  if (word === "pr" && sub === "create" && ctx.sandboxed) {
    return "a sandboxed task can't open a pull request directly: commit your work, and ARIA opens the pull request through its confirmation card";
  }
  if (word === "api") return ghApiRule(parsed);
  if (word === "auth") {
    if (sub !== "status") {
      return "reading tokens or changing accounts with `gh auth` isn't allowed in tasks (only `gh auth status` is allowed)";
    }
    return undefined;
  }
  if (word === "alias") {
    if (sub !== "list") {
      return "changing gh aliases in a task isn't allowed";
    }
    return undefined;
  }
  if (word === "config") {
    if (sub !== "get" && sub !== "list") {
      return "changing gh settings in a task isn't allowed";
    }
    return undefined;
  }
  if (word === "extension") {
    if ((sub !== "list" && sub !== "search") || parsed.positional.includes("exec")) {
      return "installing, removing or running a gh extension isn't allowed in tasks (it could merge a pull request or run arbitrary code)";
    }
    return undefined;
  }
  if (word === "agent-task") {
    if (sub !== "list" && sub !== "view") {
      return "starting a cloud coding-agent task with `gh agent-task` isn't allowed in tasks";
    }
    return undefined;
  }
  if (word === "secret" || word === "variable" || word === "ssh-key" || word === "gpg-key") {
    if (sub !== "list") {
      return `changing GitHub secrets, variables or keys with \`gh ${word}\` isn't allowed in tasks`;
    }
    return undefined;
  }
  if (word === "ruleset") {
    if (sub !== "list" && sub !== "view" && sub !== "check") {
      return "only reading and checking rulesets (`gh ruleset list/view/check`) is allowed in tasks";
    }
    return undefined;
  }
  if (word === "attestation") {
    if (sub !== "verify" && sub !== "download" && sub !== "trusted-root") {
      return "only verifying and downloading attestations (`gh attestation verify/download/trusted-root`) is allowed in tasks";
    }
    return undefined;
  }
  if (word === "repo" && sub === "sync") return "syncing a repository with gh can update a branch on GitHub, the default branch too: use git fetch or git pull";
  if (word === "repo" && sub === "edit" && parsed.args.some((arg) => arg.startsWith("--default-branch"))) return "changing the repository's default branch isn't allowed in tasks";
  if (word === "repo" && sub !== undefined && ["delete", "archive", "unarchive", "rename", "deploy-key", "autolink", "set-default"].includes(sub)) {
    return `changing or deleting a repository with \`gh repo ${sub}\` isn't allowed in tasks`;
  }
  if (word !== undefined && !GH_COMMANDS.has(word)) return `\`gh ${word}\` isn't one of gh's own commands (an alias ARIA doesn't know or an extension could merge a pull request)`;
  return undefined;
}

/**
 * `gh api` reads anything, but doesn't merge, and doesn't change branches, rulesets, protection, secrets, keys, hooks,
 * or the repository root itself (`repos/:owner/:repo`).
 */
function ghApiRule(parsed: ParsedCommand): string | undefined {
  const args = parsed.args;
  const flags = apiFlags(args);
  const valuesOf = (...names: string[]) => flags.filter((f) => names.includes(f.flag)).map((f) => f.value);
  const decoded = decodedApiArgs(args);
  const text = [...args, ...decoded].join(" ");
  // A body from a file or from input, which ARIA doesn't read.
  const unreadBody = valuesOf("--input").length > 0 || valuesOf("-F", "--field").some((value) => value.includes("=@"));
  if (decoded.some((arg) => GRAPHQL.test(arg))) {
    if (/mutation/i.test(text)) return "changing things through gh api graphql isn't allowed in tasks (a mutation can merge or write to the default branch): use gh's own commands";
    if (unreadBody) return "ARIA can't read a gh api graphql query from a file or from input";
  }
  if (!apiWrites(flags)) return undefined;
  if (decoded.some((arg) => BRANCH_ENDPOINTS.test(arg)) || /default_branch/i.test(text)) {
    return "changing branches, rulesets, protection, secrets or hooks through gh api isn't allowed in tasks: use git and gh's own commands";
  }
  if (decoded.some((arg) => REPOSITORY.test(arg))) {
    return "modifying or deleting a repository through gh api (repos/:owner/:repo) isn't allowed in tasks";
  }
  return undefined;
}

/** Whether a `gh api` command triggers or reruns a workflow, requiring user approval when not covered by an Auto rule. */
function ghApiWorkflowAsk(parsed: ParsedCommand | undefined): string | undefined {
  if (!parsed || parsed.program !== "gh" || parsed.words[0] !== "api") return undefined;
  if (!apiWrites(apiFlags(parsed.args))) return undefined;
  if (decodedApiArgs(parsed.args).some((arg) => WORKFLOW_DISPATCH_ENDPOINTS.test(arg))) {
    return "Triggers a GitHub Actions workflow run.";
  }
  return undefined;
}

/** gh api's arguments the way GitHub reads them, an endpoint's escaped letters too. */
function decodedApiArgs(args: readonly string[]): string[] {
  return args.map((arg) => {
    try {
      return decodeURIComponent(arg);
    } catch {
      return arg;
    }
  });
}

/** Whether a `gh api` request changes something: its method says so, or with none given, sending a body makes it a POST. */
function apiWrites(flags: ReadonlyArray<{ flag: string; value: string }>): boolean {
  const methods = flags.filter((f) => f.flag === "-X" || f.flag === "--method").map((f) => f.value);
  return methods.length > 0 ? methods.some((method) => !/^(?:GET|HEAD)$/i.test(method)) : flags.some((f) => API_BODY.has(f.flag));
}

/** gh api's flags with their values, the way gh (pflag) reads them: `-iFquery=@q` is -i, and -F with `query=@q`. */
function apiFlags(args: readonly string[]): Array<{ flag: string; value: string }> {
  const flags: Array<{ flag: string; value: string }> = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const flag = eq < 0 ? arg : arg.slice(0, eq);
      flags.push({ flag, value: eq >= 0 ? arg.slice(eq + 1) : API_VALUE_LONG.has(flag) ? (args[++i] ?? "") : "" });
    } else if (/^-./.test(arg)) {
      for (let k = 1; k < arg.length; k++) {
        const flag = `-${arg[k]}`;
        if (!API_VALUE_SHORT.has(arg[k]!)) {
          flags.push({ flag, value: "" });
          continue;
        }
        // It takes the rest of the cluster (after an `=`), or the next argument.
        const rest = arg.slice(k + 1);
        flags.push({ flag, value: rest.startsWith("=") ? rest.slice(1) : rest || (args[++i] ?? "") });
        break;
      }
    }
  }
  return flags;
}

/** git push's options that take a value, which can also be the next argument (`--repo origin`, `-o ci.skip`). */
const PUSH_VALUE_OPTIONS = ["--repo", "--push-option", "--receive-pack", "--exec", "--recurse-submodules"];

/**
 * git push's options and arguments the way git reads them: options anywhere, a valued option's value next to it (even
 * `--`), `--` ending the options, and a long option by any start of its name (git refuses an ambiguous one).
 */
function pushParse(parsed: ParsedCommand): { options: string[]; args: string[] } {
  const tokens = parsed.args.slice(parsed.positionalAt[0]! + 1);
  const options: string[] = [];
  const args: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--") {
      args.push(...tokens.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      options.push(token);
      if (!token.includes("=") && PUSH_VALUE_OPTIONS.some((o) => o.startsWith(token))) i++;
    } else if (/^-./.test(token)) {
      options.push(token);
      // Short options can be clustered (`-fo`): -o takes the rest of the cluster, or the next argument when it's last.
      if (token.indexOf("o", 1) === token.length - 1) i++;
    } else {
      args.push(token);
    }
  }
  return { options, args };
}

/** Why pushing by this refspec isn't allowed, if it isn't. */
function refspecRule(spec: string, ctx: WorkerPolicyContext): string | undefined {
  const plain = spec.replace(/^\+/, "");
  if (plain === ":") return "pushing every matching branch isn't allowed";
  if (plain.startsWith(":")) return "deleting remote branches isn't allowed";
  if (plain.includes("*")) return "pushing many branches at once isn't allowed";
  if (ctx.defaultBranch && pushedBranch(plain).toLowerCase() === ctx.defaultBranch.toLowerCase()) return `pushing to ${ctx.defaultBranch}, the default branch, isn't allowed`;
  return undefined;
}

function pushRule(parsed: ParsedCommand, ctx: RuleContext): string | undefined {
  if (ctx.sandboxed) return "a sandboxed task can't push (it has no access to GitHub). Commit your work: ARIA pushes the branch when the user opens a pull request";
  if (ctx.moved) return "pushing after changing folders in the same command isn't allowed: ARIA checks a push against the folder the command starts in";
  const push = pushParse(parsed);
  // Both readings count: git's own, and the plain one (where `--` always ends the options).
  for (const option of [...parsed.options, ...push.options]) {
    const name = option.split("=")[0]!;
    // Settings given for this one command can push elsewhere too (remote.origin.push, remote.origin.mirror).
    if (/^-c/.test(name) || name.startsWith("--config-env")) return "pushing with git settings changed for the command isn't allowed";
    // Also attached (`-C..\other`): the repository the rules know about wouldn't be the one that pushes.
    if (/^-C/.test(name) || name.startsWith("--git-dir") || name.startsWith("--work-tree")) return "pushing from another repository isn't allowed";
    const destructive = name.startsWith("--") ? name.length > 2 && DESTRUCTIVE_PUSH.some((o) => o.startsWith(name.toLowerCase())) : /^-[A-Za-z0-9]*d/i.test(name);
    if (destructive) return "deleting, mirroring or pruning remote branches, or pushing all of them, isn't allowed";
  }
  // Every argument is read as a refspec, the repository's too.
  for (const spec of [...parsed.values, ...push.args]) {
    const why = refspecRule(spec, ctx);
    if (why) return why;
  }
  const settings = ctx.pushSettings;
  if (settings === null) return "ARIA couldn't read git's push settings here, so it can't tell where this push goes";
  if (settings?.mirror) return "a remote here is set to mirror (remote.<name>.mirror), so a push sends every branch";
  // The first argument is the repository (a name, a URL, a path), also with `--repo=`: git lets an argument override that.
  const refspecs = push.args.slice(1);
  // What a push names without a destination (or a push without a refspec) goes where remote.<name>.push says.
  if (settings && settings.refspecs.length > 0 && (refspecs.length === 0 || refspecs.some((spec) => !spec.includes(":")))) {
    for (const spec of settings.refspecs) {
      const why = refspecRule(spec, ctx);
      if (why) return `git is set to push by \`${spec}\` here (remote.<name>.push): ${why}`;
    }
  }
  if (refspecs.length === 0 && settings?.pushDefault !== undefined && !SAFE_PUSH_DEFAULTS.has(settings.pushDefault.toLowerCase())) {
    return `with push.default set to ${settings.pushDefault || "nothing readable"}, a push that doesn't name its branch can push other branches, or under another name: name it, as in \`git push origin HEAD:<branch>\``;
  }
  // With the default branch checked out, a push without a refspec (or with HEAD) pushes the default branch.
  if (ctx.checkedOut && ctx.defaultBranch && ctx.checkedOut.toLowerCase() === ctx.defaultBranch.toLowerCase()) {
    if (refspecs.length === 0 || refspecs.some((v) => /^\+?(?:HEAD|@)$/i.test(v))) return `${ctx.defaultBranch}, the default branch, is checked out here, and pushing it isn't allowed`;
  }
  return undefined;
}

export function decideWorker(ask: PermissionAsk, ctx: WorkerPolicyContext): PolicyDecision {
  switch (ask.kind) {
    case "custom-tool":
      return AUTO;
    case "mcp":
      return mcp(ask, ctx);
    case "read":
    case "write":
      return files(ask, ctx);
    case "shell":
      return shell(ask, ctx);
    case "url":
      if (ctx.sandboxed) return never(`a sandboxed task can't open ${ask.url}: its network only reaches package registries`);
      return askFor(ctx, {
        kind: "url",
        what: ask.url,
        ...(ask.intention ? { why: ask.intention } : {}),
        reason: "it opens a web address",
        scope: `open pages on ${hostOf(ask.url)}`,
        identities: [{ key: "url", target: hostOf(ask.url), label: `open pages on ${hostOf(ask.url)}` }],
      });
    default:
      return never(`${ask.detail} isn't allowed in a task`);
  }
}

/** The most a permission card shows of a tool's arguments: a call with more is refused, never cut (D30: the exact arguments). */
export const MAX_SHOWN_ARGS = 20_000;

/**
 * A tool's arguments as the card shows them: all of them, as JSON (the card scrolls). Undefined when they can't be
 * written as JSON (nested too deep, circular, a big integer): then nothing honest can be shown, and the call is refused.
 */
function argsText(args: unknown): string | undefined {
  try {
    return JSON.stringify(args ?? {}, null, 1) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * A task's MCP tool (PLAN.md §4.13, D30, D31): the tool's name is the wire name without the prefix of the server the
 * request names, and that server and wire name have to be the catalog's (else it's refused). Then:
 * - a GitHub tool that merges or writes branches, refs, files, commits, trees, blobs or tags: always refused (D31);
 * - your rule: Never refuses; Auto runs, but only a tool whose own name reads (a write can't be Auto, D30);
 * - Ask, a card with the exact arguments: for a tool that changes something, Approve once or Reject, every time (D30);
 *   for a read tool, "Approve for this task" covers that tool for the rest of the task.
 */
function mcp(ask: Extract<PermissionAsk, { kind: "mcp" }>, ctx: WorkerPolicyContext): PolicyDecision {
  if (!ctx.mcp) return ctx.readTools.has(ask.tool) ? AUTO : never(`${ask.tool} isn't available to tasks`);
  const prefix = serverWirePrefix(ask.server);
  const tool = ask.tool.startsWith(prefix) ? ask.tool.slice(prefix.length) : undefined;
  const rule = tool !== undefined ? ctx.mcp(ask.server, ask.tool) : undefined;
  if (tool === undefined || !rule || rule.tool !== tool) return never(`${ask.tool} isn't available to tasks`);
  const cls = classifyTool(tool);
  // GitHub's by the catalog (its name or address when it was checked) or by the name the request gives: either counts.
  if (githubFixed(tool, cls, rule.github || isGithubName(ask.server))) return never(`${ask.tool} merges or writes branches, files, commits or tags on GitHub, which tasks never do: commit your work, and ARIA pushes when the user opens a pull request`);
  if (rule.effect === "never") return never(`the user turned ${ask.tool} off for tasks`);
  if (rule.effect === "auto" && cls === "read") return AUTO;
  const writes = cls !== "read";
  const label = `use ${ask.tool}`;
  // The card shows every argument; arguments it can't show you, or too long to, aren't asked about (the worker is told why).
  const args = argsText(ask.args);
  if (args === undefined) return never(`${ask.tool}'s arguments can't be written out as JSON (nested too deep, or a value JSON can't hold), so the user can't be shown them for approval: send plain JSON values`);
  if (args.length > MAX_SHOWN_ARGS) return never(`${ask.tool}'s arguments are ${args.length.toLocaleString("en-US")} characters, more than the ${MAX_SHOWN_ARGS.toLocaleString("en-US")} a card can show the user for approval: send less in one call`);
  return askFor(ctx, {
    kind: "mcp",
    what: `${ask.tool}\n${args}`,
    reason: writes ? `It's a tool of ${ask.server} that changes things (${cls}), so it asks every time.` : `Your rule for ${ask.tool} is Ask.`,
    scope: label,
    identities: writes ? [] : [{ key: "mcp", target: `${ask.server}\n${ask.tool}`, label }],
    ...(writes ? { everyTime: true } : {}),
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url;
  }
}

function files(ask: Extract<PermissionAsk, { kind: "read" | "write" }>, ctx: WorkerPolicyContext): PolicyDecision {
  const verb = ask.kind === "read" ? "reading" : "writing";
  if (insideWorktree(ask.path, ctx.worktree)) return AUTO;
  // Inside the worktree but its .git link: rewriting it points git (ARIA's own git too) at another repository.
  if (insideDir(ask.path, ctx.worktree)) return never(`${verb} the worktree's .git link isn't allowed`);
  // A task's own Copilot session folder (`~/.copilot/session-state/<sessionId>`), where plan mode reads/writes `plan.md`.
  const resolved = path.resolve(ctx.worktree, ask.path);
  if (
    ctx.sessionDir &&
    insideDir(resolved, ctx.sessionDir) &&
    canonicalPath(resolved, ctx.sessionDir) !== canonicalPath(ctx.sessionDir, ctx.sessionDir)
  ) {
    return AUTO;
  }
  if (
    ask.kind === "read" &&
    ctx.readonlyRoots?.some((root) => {
      const canonicalRoot = canonicalPath(root, root);
      const canonicalResolved = canonicalPath(resolved, resolved);
      return canonicalResolved === canonicalRoot || (insideDir(resolved, root) && canonicalResolved !== canonicalRoot);
    })
  ) {
    return AUTO;
  }
  if (ctx.sandboxed) return never(`${verb} ${ask.path} is outside this task's sandbox: allow this path in Customize › Permissions (Sandbox settings) or specify it when starting the task`);
  const dir = path.dirname(path.resolve(ctx.worktree, ask.path));
  const scope = `${ask.kind} files in ${dir}`;
  return askFor(ctx, {
    kind: ask.kind,
    what: ask.path,
    where: dir,
    ...(ask.intention ? { why: ask.intention } : {}),
    reason: `${verb} files outside the task's worktree`,
    scope,
    identities: [{ key: ask.kind, target: canonicalPath(dir, ctx.worktree), label: scope }],
  });
}

/** A command as Windows PowerShell 5.1 passes it and, when an empty argument makes it different, as PowerShell 7 does. */
export const readingsOf = (parsed: ParsedCommand | undefined): Array<ParsedCommand | undefined> => (parsed?.withEmpty ? [parsed, parsed.withEmpty] : [parsed]);
/** How strict a rule is; no rule at all is stricter than Auto (not allowed on its own) and looser than Ask. */
const strictness = (rule: PolicyRule | undefined) => (rule ? STRICTNESS[rule.effect] * 2 : 1);

type ShellAsk = Extract<PermissionAsk, { kind: "shell" }>;

/**
 * The fixed rules' refusal of a command line, if they refuse it (§4.8): every command in it, as ARIA reads it and as
 * the runtime split it, in both ways PowerShell may pass it. Nothing you set changes this, and "Always allow this" is
 * never offered for what it refuses (it's the same code).
 */
export function fixedRefusal(ask: ShellAsk, ctx: WorkerPolicyContext): string | undefined {
  const texts = commandParts(ask);
  if (texts.length === 0) return "ARIA couldn't tell what this command runs";
  let moved = false;
  for (const text of texts) {
    const parsed = parseCommand(text);
    // Both ways PowerShell may pass it: without empty arguments (Windows PowerShell 5.1) and with them (PowerShell 7).
    for (const reading of readingsOf(parsed)) {
      const why = hardRule(reading, moved ? { ...ctx, moved } : ctx);
      if (why) return why;
    }
    if (parsed && CHANGES_FOLDER.has(parsed.program)) moved = true;
  }
  return undefined;
}

/**
 * What a command destroys (D28), in either reading, git aliases followed, a path read from `cwd` (where it runs);
 * undefined when it isn't destructive.
 */
export function destructiveIn(
  parsed: ParsedCommand | undefined,
  ctx: Pick<WorkerPolicyContext, "gitAliases" | "ghAliases" | "worktree">,
  cwd: string = ctx.worktree,
): string | undefined {
  for (const reading of readingsOf(parsed)) {
    const what = destructive(reading, {
      gitAliases: ctx.gitAliases,
      ghAliases: ctx.ghAliases ?? undefined,
      place: { cwd, worktree: ctx.worktree },
    });
    if (what) return what;
  }
  return undefined;
}

/**
 * What each command of a line destroys (D28): on its own, or together with the others in the line (a `Remove-Item` fed
 * by a recursive `Get-ChildItem`, which then counts as the destructive one).
 */
export function destroysOf(
  segments: ReadonlyArray<{ parsed: ParsedCommand | undefined }>,
  ctx: Pick<WorkerPolicyContext, "gitAliases" | "ghAliases" | "worktree">,
  cwd: string = ctx.worktree,
): Array<string | undefined> {
  const together = destructiveTogether(segments.flatMap((segment) => readingsOf(segment.parsed)));
  return segments.map((segment) => destructiveIn(segment.parsed, ctx, cwd) ?? (together && readingsOf(segment.parsed).some((reading) => reading?.program === "remove-item") ? together : undefined));
}

function shell(ask: ShellAsk, ctx: WorkerPolicyContext): PolicyDecision {
  const cwd = ask.cwd ?? ctx.worktree;
  const fixed = fixedRefusal(ask, ctx);
  if (fixed) return never(fixed);
  // Each command of the line on its own, as ARIA reads it and as the runtime split it.
  const texts = commandParts(ask);
  const segments = texts.map((text) => ({ text, parsed: parseCommand(text) }));
  const rules = compileRules(ctx.rules);
  // Your rules see both readings as well, and the stricter one counts (one no rule matches isn't allowed on its own).
  const ruleOf = (parsed: ParsedCommand | undefined) =>
    readingsOf(parsed)
      .map((reading) => ruleFor(rules, reading, ctx.sandboxed))
      .reduce((a, b) => (strictness(b) > strictness(a) ? b : a));
  const destroys = destroysOf(segments, ctx, cwd);
  const ruled = segments.map((segment, i) => ({
    ...segment,
    rule: ruleOf(segment.parsed),
    destroys: destroys[i],
    ghAsk: readingsOf(segment.parsed).map(ghApiWorkflowAsk).find(Boolean),
  }));
  const refused = ruled.find((segment) => segment.rule?.effect === "never");
  if (refused) return { effect: "never", reason: `\`${refused.text}\` isn't allowed in tasks${refused.rule!.note ? ` (${refused.rule!.note})` : ""}`, rule: refused.rule! };

  // A destructive command asks, sandboxed or not, whatever an Auto rule says (a Never rule still refuses: above).
  let asking = ruled.filter((segment) => segment.rule?.effect === "ask" || segment.destroys !== undefined || (segment.ghAsk !== undefined && segment.rule?.effect !== "auto"));
  let reason = asking
    .map((segment) =>
      segment.rule?.effect === "ask"
        ? (segment.rule.note ?? `\`${segment.rule.match}\` needs your approval`)
        : segment.destroys !== undefined
          ? `\`${segment.text}\` ${segment.destroys}.`
          : segment.ghAsk!,
    )
    .join(" ");
  const everyTime = ruled.some((segment) => segment.destroys !== undefined);
  if (!ctx.sandboxed) {
    // Not sandboxed: only what the Phase 2 checks allow runs on its own (your Auto rules count as allowed commands, but
    // their arguments are still checked).
    const autoRule = (segment: string) => readingsOf(parseCommand(segment)).every((reading) => ruleFor(rules, reading, false)?.effect === "auto");
    const why = new WorkerPolicy({ worktree: ctx.worktree, readTools: ctx.readTools, extraAllow: autoRule }).check({ ...ask, segments: texts });
    if (why) {
      asking = ruled;
      // A rule's own explanation says more than "not one of the commands that run on their own".
      if (!reason) reason = why[0]!.toUpperCase() + why.slice(1);
    }
  }
  if (asking.length === 0) return AUTO;
  // Not where the task's commands usually run: say where, on the card and in what "Approve for this task" covers.
  const elsewhere = ask.cwd !== undefined && canonicalPath(ask.cwd, ctx.worktree) !== canonicalPath(ctx.worktree, ctx.worktree);
  const identities = asking.map((segment) => ({
    ...(segment.parsed ? commandIdentity(segment.parsed, cwd) : { key: JSON.stringify([segment.text]), target: canonicalPath(cwd, cwd) }),
    label: elsewhere ? `${segment.text} (in ${cwd})` : segment.text,
  }));
  return askFor(ctx, {
    kind: "shell",
    what: ask.command.trim(),
    ...(elsewhere ? { where: ask.cwd } : {}),
    ...(ask.intention ? { why: ask.intention } : {}),
    reason,
    scope: `run ${identities.map((i) => i.label).join(" and ")}`,
    // Every time (D29): nothing to approve for the task, and no grant from before covers it.
    identities: everyTime ? [] : identities,
    ...(everyTime ? { everyTime: true } : {}),
  });
}

function askFor(ctx: WorkerPolicyContext, details: Omit<PermissionRequestDetails, "grants"> & { identities: Array<Identity & { label: string }> }): PolicyDecision {
  // No identities: nothing a grant could cover (a destructive command), so it asks.
  const { identities, ...rest } = details;
  if (identities.length > 0 && identities.every((identity) => granted(ctx.grants, identity))) return AUTO;
  return { effect: "ask", request: { ...rest, grants: identities } };
}
