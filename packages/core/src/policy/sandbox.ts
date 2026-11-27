/**
 * The runtime sandbox for a worker (D20; spike 10, docs/spike-notes.md "Worker sandbox"). What a task may write, read
 * and reach, and the shell setup that makes git and lockfile installs work inside it.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { insideDir } from "../conductor/policy.ts";
import type { WorkerSandbox } from "../runtime/types.ts";
import { ghConfigFile } from "./aliases.ts";

const run = promisify(execFile);

/** ARIA's own folders next to the worktrees (short paths, D14). */
export interface AriaDirs {
  base: string;
  /** Package caches tasks share (never the user's own: a task could plant code in the user's builds through them). */
  cache: string;
  /** The runtime's temp folder: the sandbox grants the runtime's temp, so it isn't the user's %TEMP%. */
  tmp: string;
  /** The shell init script (read-only in the sandbox). */
  sandbox: string;
  initScript: string;
}

export function ariaDirs(worktreeRoot: string): AriaDirs {
  const base = path.join(worktreeRoot, ".aria");
  const sandbox = path.join(base, "sandbox");
  return { base, cache: path.join(base, "cache"), tmp: path.join(base, "tmp"), sandbox, initScript: path.join(sandbox, "aria-env.ps1") };
}

const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** The user's NuGet packages folder, used read-only as a fallback so restores don't download what's already there. */
function userNugetPackages(): string {
  return process.env.NUGET_PACKAGES || path.join(os.homedir(), ".nuget", "packages");
}

/** The shell lines that point each tool's caches and per-user state at ARIA's folder (not the user's own). */
export function sandboxEnvLines(cache: string): string[] {
  const nuget = userNugetPackages();
  const set = (name: string, value: string) => `$env:${name} = ${psQuote(value)}`;
  return [
    set("npm_config_cache", path.join(cache, "npm")),
    set("npm_config_store_dir", path.join(cache, "pnpm")),
    set("YARN_CACHE_FOLDER", path.join(cache, "yarn")),
    set("YARN_GLOBAL_FOLDER", path.join(cache, "yarn-berry")),
    set("NUGET_PACKAGES", path.join(cache, "nuget", "packages")),
    set("NUGET_HTTP_CACHE_PATH", path.join(cache, "nuget", "http")),
    set("NUGET_PLUGINS_CACHE_PATH", path.join(cache, "nuget", "plugins")),
    ...(existsSync(nuget) ? [set("NUGET_FALLBACK_PACKAGES", nuget)] : []),
    "$env:RestoreIgnoreFailedSources = 'true'",
    // The .NET CLI keeps its first-run and tool state under this instead of the user's profile.
    set("DOTNET_CLI_HOME", path.join(cache, "dotnet")),
    "$env:DOTNET_NOLOGO = 'true'",
    "$env:DOTNET_CLI_TELEMETRY_OPTOUT = 'true'",
    "$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = 'true'",
    "$env:DOTNET_ADD_GLOBAL_TOOLS_TO_PATH = 'false'",
    "$env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'",
    set("PIP_CACHE_DIR", path.join(cache, "pip")),
    set("CARGO_HOME", path.join(cache, "cargo")),
    set("GOMODCACHE", path.join(cache, "go", "mod")),
    set("GOCACHE", path.join(cache, "go", "build")),
  ];
}

/**
 * The shell lines that make the sandbox's Windows PowerShell 5.1 read text as UTF-8. Left alone, it reads a file
 * without a byte-order mark as Windows-1252 and decodes git's and node's output with the console's OEM code page, so a
 * script that reads a file and writes it back turns `→` into `â†’` (R1). Write cmdlets keep their defaults: in 5.1
 * their `UTF8` adds a byte-order mark. `$global:` because the runtime may run this script in a scope of its own;
 * the console encoding can't be set without a console, which the next command then does without.
 */
export function sandboxEncodingLines(): string[] {
  return [
    "$global:PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'",
    "try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }",
    "$global:OutputEncoding = New-Object System.Text.UTF8Encoding $false",
  ];
}

/**
 * Writes the folders and the init script every sandboxed shell command runs first: the tools use ARIA's caches, a
 * private feed outside the allowed hosts gives a warning instead of failing every restore (MSBuild reads environment
 * variables as properties), and the shell reads files and command output as UTF-8.
 */
export function prepareAriaDirs(dirs: AriaDirs): void {
  for (const dir of [dirs.cache, dirs.tmp, dirs.sandbox]) mkdirSync(dir, { recursive: true });
  const lines = ["# Written by ARIA for sandboxed tasks (D20). Changes are overwritten.", ...sandboxEnvLines(dirs.cache), ...sandboxEncodingLines(), ""];
  const text = lines.join("\r\n");
  if (!existsSync(dirs.initScript) || readFileSync(dirs.initScript, "utf8") !== text) writeFileSync(dirs.initScript, text);
}

/** A read grant this wide would show a task far more than toolchains: a drive root, the user's profile or above it. */
export function tooBroad(dir: string): boolean {
  const resolved = path.resolve(dir);
  if (path.parse(resolved).root === resolved) return true;
  const toHome = path.relative(resolved, path.resolve(os.homedir()));
  return toHome === "" || (!toHome.startsWith("..") && !path.isAbsolute(toHome));
}

/**
 * Normalizes and validates local paths (files or directories) configured or provided for sandbox read access.
 * Rejects non-absolute paths, paths that don't exist, and paths that are too broad (e.g. drive roots or home directory).
 */
export function sanitizeAllowedPaths(
  paths: readonly string[] = [],
  exists: (p: string) => boolean = existsSync,
): string[] {
  const out = new Map<string, string>();
  for (const raw of paths) {
    const trimmed = raw?.trim().replace(/^"(.*)"$/, "$1");
    if (!trimmed || !path.isAbsolute(trimmed) || tooBroad(trimmed) || !exists(trimmed)) continue;
    const resolved = path.resolve(trimmed);
    out.set(process.platform === "win32" ? resolved.toLowerCase() : resolved, resolved);
  }
  return [...out.values()];
}

/**
 * Scans a brief or message for candidate absolute file or directory paths.
 * Matches quoted Windows/POSIX paths, or unquoted Windows drive paths.
 */
export function extractBriefPaths(text: string): string[] {
  const candidates: string[] = [];
  const quoted = /["`']([a-zA-Z]:[\\/][^"'`\r\n<>|*?]+|\/(?:Users|home|tmp|var|opt|etc)[\\/][^"'`\r\n<>|*?]+)["`']/g;
  for (const match of text.matchAll(quoted)) {
    if (match[1]) candidates.push(match[1].trim());
  }
  const win = /\b([a-zA-Z]:[\\/][^\s"'`\r\n<>|*?]+)/g;
  for (const match of text.matchAll(win)) {
    if (match[1]) {
      const clean = match[1].replace(/[.,;:!?)]+$/, "").trim();
      candidates.push(clean);
    }
  }
  const posix = /(?:^|[\s(])(\/(?:Users|home|tmp|var|opt|etc)[\\/][^\s"'`\r\n<>|*?]+)/g;
  for (const match of text.matchAll(posix)) {
    if (match[1]) {
      const clean = match[1].replace(/[.,;:!?)]+$/, "").trim();
      candidates.push(clean);
    }
  }
  return [...new Set(candidates)];
}

/** Where credentials live, from the user's profile. */
const CREDENTIAL_LOCATIONS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".copilot",
  ".git-credentials",
  ".netrc",
  "_netrc",
  ".npmrc",
  ".pypirc",
  ".config/gh",
  ".config/git",
  ".config/google-chrome",
  ".mozilla",
  "AppData/Roaming/GitHub CLI",
  "AppData/Roaming/NuGet",
  "AppData/Roaming/Microsoft/Credentials",
  "AppData/Roaming/Microsoft/Protect",
  "AppData/Roaming/Mozilla/Firefox",
  "AppData/Local/Microsoft/Credentials",
  "AppData/Local/Google/Chrome/User Data",
  "AppData/Local/Microsoft/Edge/User Data",
  "Library/Keychains",
  "Library/Application Support/Google/Chrome",
];

/** Whether a read grant here would reach the user's credentials or `protectedDirs`: inside one, or a folder above one. */
export function reachesSecrets(target: string, protectedDirs: readonly string[] = [], home: string = os.homedir()): boolean {
  const places = [...CREDENTIAL_LOCATIONS.map((place) => path.join(home, place)), path.dirname(ghConfigFile()), ...protectedDirs];
  const seen = [path.resolve(target)];
  try {
    // Through a link or a short (8.3) name it's still the same place.
    seen.push(realpathSync.native(target));
  } catch {
    // Not there: its name is all there is to check.
  }
  return seen.some((p) => places.some((place) => insideDir(p, place) || insideDir(place, p)));
}

/**
 * The real existing paths a task may read because they were granted. Resolving the target binds a grant to the checked
 * resource; replacing a symlink changes the identity on the next request.
 */
export function grantablePaths(paths: readonly string[], protectedDirs: readonly string[] = []): string[] {
  return sanitizeAllowedPaths(paths)
    .filter((p) => !reachesSecrets(p, protectedDirs))
    .flatMap((p) => {
      try {
        return [realpathSync.native(p)];
      } catch {
        return [];
      }
    });
}

/** Whether these words name this path, or a folder it's in. Slashes and letter case don't count; a longer name isn't it. */
export function namesPath(words: string, target: string): boolean {
  const spelled = (text: string) => text.replaceAll("\\", "/").toLowerCase();
  const escaped = spelled(path.resolve(target)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(?<![\\w./-])${escaped}(?![\\w/-]|\\.\\w)`).test(spelled(words))) return true;
  return sanitizeAllowedPaths(extractBriefPaths(words)).some((dir) => insideDir(target, dir));
}

const TOOLCHAIN_VARIABLES =["DOTNET_ROOT", "JAVA_HOME", "GOROOT", "VIRTUAL_ENV", "CONDA_PREFIX", "NVM_HOME", "NVM_SYMLINK", "PNPM_HOME", "VOLTA_HOME", "PYTHONHOME", "RUSTUP_HOME"];

/**
 * The toolchains a task's commands run, read-only: the folders on PATH (with the install folder above a bin, cmd or
 * Scripts folder, where a tool keeps the rest of itself) and in the usual toolchain variables. The runtime's own
 * dev-tool grants would give these too, but also make some of the user's caches writable (Cargo's among them), where a
 * task could plant code for the user's next build.
 */
export function toolchainPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const found = new Map<string, string>();
  const add = (value: string | undefined) => {
    const dir = value?.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !path.isAbsolute(dir) || tooBroad(dir) || !existsSync(dir)) return;
    const resolved = path.resolve(dir);
    found.set(process.platform === "win32" ? resolved.toLowerCase() : resolved, resolved);
  };
  for (const entry of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    add(entry);
    const trimmed = entry.trim().replace(/^"(.*)"$/, "$1").replace(/[\\/]+$/, "");
    if (/[\\/](bin|cmd|scripts)$/i.test(trimmed)) add(path.dirname(trimmed));
  }
  for (const name of TOOLCHAIN_VARIABLES) add(env[name]);
  add(path.join(os.homedir(), ".rustup"));
  return [...found.values()];
}

/** The user's package caches and tool settings a task may read but never change (a restore's fallback, feeds, gh config.yml). */
function userToolSettings(): string[] {
  const appData = process.env.APPDATA;
  const ghConfig = ghConfigFile();
  const safeGhConfig = !tooBroad(path.dirname(ghConfig)) ? [ghConfig] : [];
  return [
    userNugetPackages(),
    ...(appData ? [path.join(appData, "NuGet")] : []),
    path.join(os.homedir(), ".npmrc"),
    ...safeGhConfig,
  ].filter((p) => existsSync(p));
}

/**
 * Copilot CLI plugin, marketplace, skill, and agent directories on disk, plus any explicitly configured plugin/skill/agent
 * directories. Skills and plugin agents read their supporting reference files (`SKILL.md`, templates, docs) from these
 * folders during a turn, while `.copilot/config.json` and `.copilot/mcp-config.json` remain outside the read grant.
 */
export function copilotExtensionReadonlyPaths(
  extraDirs: readonly string[] = [],
  homedir: string = os.homedir(),
  exists: (p: string) => boolean = existsSync,
): string[] {
  const copilotHome = process.env.COPILOT_HOME?.trim() ? path.resolve(process.env.COPILOT_HOME.trim()) : path.join(homedir, ".copilot");
  const candidates = [
    path.join(copilotHome, "installed-plugins"),
    path.join(copilotHome, "marketplaces"),
    path.join(copilotHome, "local-plugins"),
    path.join(copilotHome, "plugins"),
    path.join(copilotHome, "skills"),
    path.join(copilotHome, "agents"),
    ...extraDirs,
  ];
  const out = new Map<string, string>();
  for (const raw of candidates) {
    const dir = raw?.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !path.isAbsolute(dir) || tooBroad(dir) || !exists(dir)) continue;
    const resolved = path.resolve(dir);
    out.set(process.platform === "win32" ? resolved.toLowerCase() : resolved, resolved);
  }
  return [...out.values()];
}

/** The repository's shared .git folder (`git rev-parse --git-common-dir`). */
export async function gitCommonDir(repoPath: string): Promise<string> {
  const { stdout } = await run("git", ["-C", repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir"], { windowsHide: true });
  return path.resolve(stdout.trim());
}

/**
 * Where a worktree's `.git` link is, the same however its folder is spelled (a short 8.3 name, as TEMP is on GitHub's
 * runners, or a link): git writes the long name. Only the folder is resolved, never the link itself, which a task could
 * point at another worktree's.
 */
const linkKey = (link: string) => {
  const resolved = path.resolve(link);
  let folder = path.dirname(resolved);
  try {
    folder = realpathSync.native(folder);
  } catch {
    // Not there: its name is all there is to compare.
  }
  const key = path.join(folder, path.basename(resolved));
  return process.platform === "win32" ? key.toLowerCase() : key;
};

/**
 * The worktree's own folder in the shared .git (`.git/worktrees/<name>`), found from the repository's side (each one's
 * `gitdir` file names the worktree's `.git` link), not from the link inside the worktree, which the task could have
 * changed while it wasn't sandboxed.
 */
export function worktreeAdminDir(commonDir: string, worktree: string): string | undefined {
  const root = path.join(commonDir, "worktrees");
  if (!existsSync(root)) return undefined;
  const wanted = linkKey(path.join(worktree, ".git"));
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const gitdir = path.join(root, entry.name, "gitdir");
    try {
      const target = readFileSync(gitdir, "utf8").trim();
      // A relative one (worktree.useRelativePaths) is from the worktree's folder here.
      if (linkKey(path.resolve(root, entry.name, target)) === wanted) return path.join(root, entry.name);
    } catch {
      // Not a worktree folder.
    }
  }
  return undefined;
}

/** The runtime's own git (the sandboxed shell uses it; it stops when it can't read its etc/gitconfig). */
function bundledGitDirs(): string[] {
  const local = process.env.LOCALAPPDATA;
  if (!local || !existsSync(local)) return [];
  try {
    return readdirSync(local, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("github-copilot-git-"))
      .map((d) => path.join(local, d.name));
  } catch {
    return [];
  }
}

/** What the runtime gets for one task's session (types.ts `WorkerSandbox`). */
export type SandboxSpec = WorkerSandbox;

/**
 * The sandbox for a task's session. Read-write: its worktree, ARIA's caches, and only the parts of the repository's
 * .git a commit needs (objects, its own worktree folder, the aria/ branches and their reflogs). Read-only: the rest
 * of .git (hooks and config would run code on the PC the next time anyone uses git there; commondir, gitdir and the
 * worktree's .git link would point git at another folder), its own worktree config (core.fsmonitor there would run
 * when ARIA's git looks at the worktree), the user's git identity, the toolchains and the user's tool settings. No
 * automatic dev-tool grants. Network: the allowed hosts only; loopback blocked (Windows filtering needs local-network
 * access, which opens it).
 */
export async function sandboxSpec(options: {
  repoPath: string;
  worktree: string;
  dirs: AriaDirs;
  allowedHosts: string[];
  sessionDir?: string;
  extraReadonly?: readonly string[];
  allowedPaths?: readonly string[];
  nonGit?: boolean;
}): Promise<SandboxSpec> {
  const { worktree, dirs, sessionDir, extraReadonly, allowedPaths } = options;
  const gitconfig = path.join(os.homedir(), ".gitconfig");
  if (options.nonGit) {
    return {
      readwrite: [
        worktree,
        dirs.cache,
        ...(sessionDir ? [sessionDir] : []),
      ],
      readonly: [
        ...(existsSync(gitconfig) ? [gitconfig] : []),
        ...bundledGitDirs(),
        dirs.sandbox,
        ...toolchainPaths(),
        ...userToolSettings(),
        ...copilotExtensionReadonlyPaths(extraReadonly),
        ...sanitizeAllowedPaths(allowedPaths ?? []),
      ],
      allowedHosts: options.allowedHosts,
      blockedHosts: ["localhost", "127.0.0.1", "::1"],
      initScript: dirs.initScript,
      processFlags: ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "RemoteSigned"],
    };
  }
  const common = await gitCommonDir(options.repoPath);
  const admin = worktreeAdminDir(common, worktree);
  if (!admin) throw new Error(`couldn't find the worktree's folder in ${common}, so the task can't be sandboxed`);
  const branches = path.join(common, "refs", "heads", "aria");
  const reflogs = path.join(common, "logs", "refs", "heads", "aria");
  for (const dir of [branches, reflogs]) mkdirSync(dir, { recursive: true });
  // Read with extensions.worktreeConfig; made (empty) when missing, so the read-only rule has a file to hold.
  const worktreeConfig = path.join(admin, "config.worktree");
  if (!existsSync(worktreeConfig)) writeFileSync(worktreeConfig, "");
  return {
    readwrite: [
      worktree,
      path.join(common, "objects"),
      admin,
      branches,
      reflogs,
      dirs.cache,
      ...(sessionDir ? [sessionDir] : []),
    ],
    readonly: [
      common,
      path.join(admin, "commondir"),
      path.join(admin, "gitdir"),
      worktreeConfig,
      path.join(worktree, ".git"),
      ...(existsSync(gitconfig) ? [gitconfig] : []),
      ...bundledGitDirs(),
      dirs.sandbox,
      ...toolchainPaths(),
      ...userToolSettings(),
      ...copilotExtensionReadonlyPaths(extraReadonly),
      ...sanitizeAllowedPaths(allowedPaths ?? []),
    ],
    allowedHosts: options.allowedHosts,
    blockedHosts: ["localhost", "127.0.0.1", "::1"],
    initScript: dirs.initScript,
    processFlags: ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "RemoteSigned"],
  };
}
