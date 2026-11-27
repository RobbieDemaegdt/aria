/**
 * ARIA's own push of a task's commits (PLAN.md §4.3, item 3), on your click, outside the sandbox (a sandboxed task
 * can't push at all, D20). Pushed by commit, not by branch: `<tip>:refs/heads/aria/<x>`, the tip being the commit the
 * card showed (another task can move an `aria/` branch). From a scratch repository ARIA makes (`git init --bare
 * --template=`), which borrows the project's objects (`objects/info/alternates`), so none of the project's config is read
 * (no remote section under any name, no `http.*`, `core.askPass`, `include.path`, `url.*`) and no hook exists; the
 * project's own alternates (a task could write them) are checked first. The address is a remote of the scratch
 * repository under a name made up for the push, so none of your remote sections applies. Never force, mirror, all,
 * tags or delete. Only https (`GIT_ALLOW_PROTOCOL`), and a rewrite of the address by your global config (insteadOf or
 * pushInsteadOf, to SSH: another identity) refuses it. Credentials are gh's, through git (`gh auth git-credential`, after clearing the other helpers). A test run is the
 * same command with other configuration (a global config that points github.com at its bare repositories, file only).
 */
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { ghEnvironment } from "../github/access.ts";
import { githubText, validName } from "../github/text.ts";

export interface PushTarget {
  /** `https://github.com/<owner>/<repo>.git`: the only address a push goes to. */
  url: string;
  /** What git makes of it after your global config: the address itself, or (a test run) its bare repository. */
  expectedUrl: string;
  /** GIT_ALLOW_PROTOCOL: `https`, or `file` in a test run. */
  protocols: "https" | "file";
  /** A test run's git configuration (GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM); nothing in normal use. */
  env: Record<string, string>;
  /** gh's full path, for git's credential helper. */
  ghPath: string;
}

export type PushFailure = "alternates" | "lfs" | "rewritten" | "missing" | "non_fast_forward" | "push_protection" | "no_permission" | "sso" | "auth" | "offline" | "stopped" | "failed";

export class PushRefused extends Error {
  constructor(
    readonly reason: PushFailure,
    message: string,
  ) {
    super(message);
    this.name = "PushRefused";
  }
}

const SHA = /^[0-9a-f]{40,64}$/;
const REMOTE_BRANCH = /^aria\/(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[\w.-]+(?:\/[\w.-]+)*$/;
const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git$/;
const SLASHES = (p: string) => p.replace(/\\/g, "/");

/** The address a push to owner/repo goes to, and what git must make of it. A test run's goes to its bare repository. */
export function pushTarget(owner: string, repo: string, options: { testRoot?: string; testConfig?: string; ghPath: string }): PushTarget {
  if (!validName(owner) || !validName(repo)) throw new PushRefused("failed", "That isn't a repository ARIA can push to.");
  const url = `https://github.com/${owner}/${repo}.git`;
  if (options.testRoot !== undefined) {
    if (!options.testConfig) throw new PushRefused("failed", "This test run can't push.");
    return { url, expectedUrl: `${SLASHES(options.testRoot)}/${owner}/${repo}.git`, protocols: "file", env: { GIT_CONFIG_GLOBAL: options.testConfig, GIT_CONFIG_NOSYSTEM: "1" }, ghPath: options.ghPath };
  }
  return { url, expectedUrl: url, protocols: "https", env: {}, ghPath: options.ghPath };
}

/** A test run's global git config: github.com's addresses go to its folder of bare repositories. Written by the engine. */
export function writeTestPushConfig(file: string, root: string): void {
  writeFileSync(file, `[url "${SLASHES(root)}/"]\n\tinsteadOf = https://github.com/\n`);
}

/**
 * git's environment for the push: ARIA's own without any `GIT_*` variable (any letter case: `GIT_DIR`,
 * `GIT_CONFIG_*`, `GIT_ASKPASS`, `GIT_SSH*`, `GIT_EXEC_PATH`, `GIT_TRACE*`, …) or `SSH_ASKPASS`, and without the
 * variables gh would take a token from (as for `gh auth token`); then no prompts, and only `protocols`.
 */
export function pushEnvironment(source: NodeJS.ProcessEnv, target: Pick<PushTarget, "protocols" | "env">): Record<string, string> {
  const { env } = ghEnvironment(source);
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith("GIT_") || upper === "SSH_ASKPASS" || upper.startsWith("GCM_")) delete env[key];
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ALLOW_PROTOCOL: target.protocols, ...target.env };
}

/**
 * The command line of the push (the same in a test run: only the configuration differs). `remote`: a name of ARIA's
 * own for the address in the scratch repository's config, made up for this push (`aria-<random>`), so no remote
 * section of yours applies (not even one named by the address itself) and the address git will push to can be asked
 * first (`remote get-url --push`).
 */
export function pushArgs(scratch: string, noHooks: string, target: Pick<PushTarget, "ghPath">, tip: string, remoteBranch: string, remote: string): string[] {
  return [
    "-c", "core.fsmonitor=false",
    "-c", "core.longpaths=true",
    "-c", `core.hooksPath=${SLASHES(noHooks)}`,
    "-c", "core.askPass=",
    "-c", "push.followTags=false",
    "-c", "push.gpgSign=false",
    "-c", "push.recurseSubmodules=no",
    // gh's credentials for github.com, and no other helper (your credential manager isn't asked).
    "-c", "credential.helper=",
    "-c", `credential.https://github.com.helper=!"${SLASHES(target.ghPath)}" auth git-credential`,
    "-C", scratch,
    "push", "--porcelain", "--no-verify", "--no-follow-tags", "--recurse-submodules=no",
    remote,
    `${tip}:refs/heads/${remoteBranch}`,
  ];
}

/** A remote name for one push: nothing in your config can be under it. */
export const pushRemoteName = () => `aria-${randomBytes(6).toString("hex")}`;

/** What git said, in ARIA's words with GitHub's own lines (cleaned) where they explain a refusal. */
function classify(output: string, exitCode: number | undefined): PushRefused {
  const text = output.replace(/\b(?:gh[opsu]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, "[token]");
  const remote = text
    .split(/\r?\n/)
    .filter((line) => /^remote:/.test(line))
    .map((line) => githubText(line.replace(/^remote:\s*/, ""), 200))
    .filter(Boolean)
    .slice(0, 8);
  if (/GH013|repository rule violations|push protection|secret scanning/i.test(text)) {
    return new PushRefused("push_protection", `GitHub's push protection refused it${remote.length ? `: ${remote.join(" · ")}` : "."} ARIA doesn't bypass it.`);
  }
  if (/\[rejected\].*\((?:non-fast-forward|fetch first)\)|non-fast-forward|fetch first/i.test(text)) return new PushRefused("non_fast_forward", "The branch on GitHub has commits these don't: ARIA doesn't overwrite it.");
  if (/SAML|single sign-on|\bSSO\b/i.test(text)) return new PushRefused("sso", "An organisation wants GitHub CLI's token authorized for single sign-on.");
  if (/Permission to .* denied|403|access denied|not allowed to push|protected branch/i.test(text)) return new PushRefused("no_permission", `This account can't push there${remote.length ? `: ${remote.join(" · ")}` : "."}`);
  if (/Authentication failed|could not read Username|terminal prompts disabled|invalid credentials/i.test(text)) return new PushRefused("auth", "GitHub didn't take GitHub CLI's credentials for the push. Run `gh auth status` in a terminal.");
  if (/Could not resolve host|Failed to connect|Connection timed out|Couldn't connect|unable to access|Connection reset/i.test(text)) return new PushRefused("offline", "GitHub can't be reached.");
  return new PushRefused("failed", `git push failed (exit ${exitCode ?? "unknown"}).`);
}

/** Ends the push and what it started (on Windows, git-remote-https outlives git.exe otherwise). */
function killTree(pid: number | undefined, kill: () => void): void {
  if (process.platform === "win32" && pid) void execa("taskkill", ["/PID", String(pid), "/T", "/F"], { reject: false, windowsHide: true });
  else kill();
}

export interface PushOutcome {
  /** It was on GitHub already at that commit. */
  upToDate: boolean;
}

/** git's environment for a scratch repository's local commands (no network): ARIA's own, without any `GIT_*`. */
export function localGitEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return pushEnvironment(source, { protocols: "file", env: {} });
}

/** A scratch repository's git: replace refs and grafts off, paths unquoted, fsmonitor off. */
export interface Scratch {
  dir: string;
  git(args: string[], options?: { input?: string; timeoutMs?: number }): Promise<{ ok: boolean; stdout: string; stderr: string }>;
}

/**
 * A scratch bare repository (`git init --bare --template=` in ARIA's temp folder) that borrows the project's objects
 * (`objects/info/alternates`), for `run`, then removed. Nothing of the project's but its objects is read: no config, no
 * refs (so no `refs/replace/*`), no `info/grafts` (and `--no-replace-objects` besides). Item 3's card and its push both
 * look through one, so the card shows what the push sends. The project's own alternates (a task can write them) refuse.
 */
export async function withScratch<T>(options: { gitDir: string; scratchRoot: string; env: Record<string, string>; prefix?: string }, run: (scratch: Scratch) => Promise<T>): Promise<T> {
  const objects = path.join(options.gitDir, "objects");
  if (!existsSync(objects)) throw new PushRefused("missing", "The project's git objects aren't where ARIA looked.");
  // The project's own alternates: borrowed objects from elsewhere (a share, another folder).
  const alternates = path.join(objects, "info", "alternates");
  if (existsSync(alternates) && readFileSync(alternates, "utf8").trim() !== "") {
    throw new PushRefused("alternates", "The project's repository borrows objects from elsewhere (objects/info/alternates): ARIA doesn't push from it. Push it yourself.");
  }
  mkdirSync(options.scratchRoot, { recursive: true });
  const dir = mkdtempSync(path.join(options.scratchRoot, options.prefix ?? "push-"));
  const env = options.env;
  try {
    const made = await execa("git", ["init", "--bare", "--quiet", "--template=", dir], { env, extendEnv: false, reject: false, windowsHide: true, timeout: 60_000, stdin: "ignore" });
    if (made.exitCode !== 0) throw new PushRefused("failed", "ARIA couldn't make its folder for the push.");
    mkdirSync(path.join(dir, "objects", "info"), { recursive: true });
    writeFileSync(path.join(dir, "objects", "info", "alternates"), `${SLASHES(path.resolve(objects))}\n`);
    const git: Scratch["git"] = async (args, runOptions = {}) => {
      const result = await execa("git", ["-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "-c", "core.longpaths=true", "--no-replace-objects", "-C", dir, ...args], {
        env,
        extendEnv: false,
        reject: false,
        windowsHide: true,
        timeout: runOptions.timeoutMs ?? 120_000,
        maxBuffer: 64 * 1024 * 1024,
        ...(runOptions.input !== undefined ? { input: runOptions.input } : { stdin: "ignore" as const }),
      });
      return { ok: result.exitCode === 0, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
    };
    return await run({ dir, git });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** Git LFS anywhere in the tip's tree: a `.gitattributes` (any folder) with `filter=lfs`. Its upload is a hook. */
export async function usesLfs(scratch: Scratch, tip: string): Promise<boolean> {
  const tree = await scratch.git(["ls-tree", "-r", "-z", "--name-only", tip]);
  if (!tree.ok) return false;
  const files = tree.stdout.split("\0").filter((p) => p === ".gitattributes" || p.endsWith("/.gitattributes")).slice(0, 500);
  if (files.length === 0) return false;
  // One process for all of them: `<tip>:<path>` a line (a path with a newline can't be named this way: refused).
  if (files.some((f) => /[\r\n]/.test(f))) return true;
  const contents = await scratch.git(["cat-file", "--batch"], { input: files.map((f) => `${tip}:${f}`).join("\n") + "\n" });
  return /filter\s*=\s*lfs/i.test(contents.stdout);
}

/**
 * Pushes `tip` to `refs/heads/<remoteBranch>` at `target`, from a scratch repository borrowing `gitDir`'s objects (the
 * project's own `.git`, never a worktree's). `scratchRoot`: ARIA's own temp folder.
 */
export async function pushCommit(options: { gitDir: string; tip: string; remoteBranch: string; target: PushTarget; scratchRoot: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv }): Promise<PushOutcome> {
  const { gitDir, tip, remoteBranch, target } = options;
  if (!SHA.test(tip)) throw new PushRefused("failed", "That isn't a commit ARIA can push.");
  if (!REMOTE_BRANCH.test(remoteBranch)) throw new PushRefused("failed", "ARIA only pushes to its own aria/ branches.");
  if (!GITHUB_URL.test(target.url)) throw new PushRefused("failed", "ARIA only pushes to github.com.");
  const env = pushEnvironment(options.env ?? process.env, target);
  return withScratch({ gitDir, scratchRoot: options.scratchRoot, env }, (s) => pushFrom(s, { ...options, env }));
}

/**
 * D53 (item 4): one commit from GitHub into the project's objects, the way ARIA pushes: from a scratch repository
 * (none of the project's config, no hooks), gh's helper only, https only (file in a test run), a remote name of its own
 * whose address is checked for rewrites first. git offers the project's own commits as what it has (the alternates'
 * refs), so only the missing ones come. The new objects are then copied into the project's object folder: no git runs
 * in the project with the network.
 */
export async function fetchCommit(options: { gitDir: string; sha: string; target: PushTarget; scratchRoot: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv }): Promise<{ fetched: boolean }> {
  const { gitDir, sha, target } = options;
  if (!SHA.test(sha)) throw new PushRefused("failed", "That isn't a commit ARIA can fetch.");
  if (!GITHUB_URL.test(target.url)) throw new PushRefused("failed", "ARIA only fetches from github.com.");
  const env = pushEnvironment(options.env ?? process.env, target);
  return withScratch({ gitDir, scratchRoot: options.scratchRoot, env, prefix: "fetch-" }, async (s) => {
    if ((await s.git(["cat-file", "-e", `${sha}^{commit}`])).ok) return { fetched: false };
    const remote = pushRemoteName();
    if (!(await s.git(["config", `remote.${remote}.url`, target.url])).ok) throw new PushRefused("failed", "ARIA couldn't make its folder for the fetch.");
    const asked = await s.git(["remote", "get-url", remote]);
    const resolved = asked.stdout.trim();
    const same = process.platform === "win32" ? SLASHES(resolved).toLowerCase() === SLASHES(target.expectedUrl).toLowerCase() : resolved === target.expectedUrl;
    if (!asked.ok || !same) throw new PushRefused("rewritten", "Your git config rewrites github.com's address (url.<…>.insteadOf): ARIA only fetches over https as GitHub CLI's account. Pull the branch yourself, or drop the rewrite.");
    if (options.signal?.aborted) throw new PushRefused("stopped", "ARIA is stopping.");
    const noHooks = path.join(s.dir, "no-hooks");
    mkdirSync(noHooks, { recursive: true });
    const child = execa(
      "git",
      [
        "-c", "core.fsmonitor=false",
        "-c", `core.hooksPath=${SLASHES(noHooks)}`,
        "-c", "core.askPass=",
        "-c", "credential.helper=",
        "-c", `credential.https://github.com.helper=!"${SLASHES(target.ghPath)}" auth git-credential`,
        "-c", "fetch.recurseSubmodules=no",
        "-c", "transfer.fsckObjects=true",
        "-C", s.dir,
        "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--recurse-submodules=no", remote, sha,
      ],
      { env, extendEnv: false, reject: false, windowsHide: true, timeout: 5 * 60_000, stdin: "ignore", all: true },
    );
    const onAbort = () => killTree(child.pid, () => child.kill());
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const result = await child.finally(() => options.signal?.removeEventListener("abort", onAbort));
    if (options.signal?.aborted) throw new PushRefused("stopped", "ARIA is stopping.");
    if (result.exitCode !== 0) {
      const failed = classify(String(result.all ?? ""), result.exitCode);
      throw failed.reason === "failed" ? new PushRefused("failed", `git fetch failed (exit ${result.exitCode ?? "unknown"}): GitHub may not have that commit anymore.`) : failed;
    }
    if (!(await s.git(["cat-file", "-e", `${sha}^{commit}`])).ok) throw new PushRefused("missing", "GitHub didn't send that commit.");
    copyNewObjects(path.join(s.dir, "objects"), path.join(gitDir, "objects"));
    return { fetched: true };
  });
}

/** Packs and loose objects the fetch wrote into the scratch repository, into the project's object folder (only new files). */
function copyNewObjects(from: string, to: string): void {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "info") continue;
    const source = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.name !== "pack" && !/^[0-9a-f]{2}$/.test(entry.name)) continue;
    mkdirSync(dest, { recursive: true });
    // A pack's .idx last (git finds packs by their .idx: it must never see one before its .pack is there).
    const order = (f: string) => (f.endsWith(".pack") ? 0 : f.endsWith(".rev") ? 1 : 2);
    for (const file of readdirSync(source).sort((a, b) => order(a) - order(b))) {
      if (entry.name === "pack" && !/^pack-[0-9a-f]+\.(?:pack|idx|rev)$/.test(file)) continue;
      const target = path.join(dest, file);
      if (!existsSync(target)) copyFileSync(path.join(source, file), target);
    }
  }
}

async function pushFrom(scratchRepo: Scratch, options: { tip: string; remoteBranch: string; target: PushTarget; signal?: AbortSignal; env: Record<string, string> }): Promise<PushOutcome> {
  const { tip, remoteBranch, target, env } = options;
  const scratch = scratchRepo.dir;
  const noHooks = path.join(scratch, "no-hooks");
  const git = (args: string[]) => execa("git", ["-c", "core.fsmonitor=false", "-C", scratch, ...args], { env, extendEnv: false, reject: false, windowsHide: true, timeout: 60_000, stdin: "ignore" });
  mkdirSync(noHooks, { recursive: true });
  if (!(await scratchRepo.git(["cat-file", "-e", `${tip}^{commit}`])).ok) throw new PushRefused("missing", "The commit isn't in the project's repository anymore.");
  // Git LFS: its pre-push hook uploads the files; with hooks off they'd never reach GitHub.
  if (await usesLfs(scratchRepo, tip)) {
    throw new PushRefused("lfs", "This repository uses Git LFS, whose upload ARIA's push leaves out (no hooks): push this branch yourself.");
  }
  // Your global config may rewrite github.com's address for a push (url.<…>.insteadOf or pushInsteadOf; to SSH:
  // another identity than GitHub CLI's). git says where it would push, without connecting.
  const remote = pushRemoteName();
  if ((await git(["config", `remote.${remote}.url`, target.url])).exitCode !== 0) throw new PushRefused("failed", "ARIA couldn't make its folder for the push.");
  const asked = await git(["remote", "get-url", "--push", remote]);
  const resolved = String(asked.stdout).trim();
  const same = process.platform === "win32" ? SLASHES(resolved).toLowerCase() === SLASHES(target.expectedUrl).toLowerCase() : resolved === target.expectedUrl;
  if (asked.exitCode !== 0 || !same) throw new PushRefused("rewritten", "Your git config rewrites github.com's address for this push (url.<…>.insteadOf or pushInsteadOf): ARIA only pushes over https as GitHub CLI's account. Push it yourself, or drop the rewrite.");
  if (options.signal?.aborted) throw new PushRefused("stopped", "ARIA is stopping.");
  const child = execa("git", pushArgs(scratch, noHooks, target, tip, remoteBranch, remote), { env, extendEnv: false, reject: false, windowsHide: true, timeout: 5 * 60_000, stdin: "ignore", all: true });
  const onAbort = () => killTree(child.pid, () => child.kill());
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const result = await child.finally(() => options.signal?.removeEventListener("abort", onAbort));
  if (options.signal?.aborted) throw new PushRefused("stopped", "ARIA is stopping.");
  const all = String(result.all ?? `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  if (result.exitCode !== 0) throw classify(all, result.exitCode);
  // --porcelain: "=" is "up to date".
  const line = all.split(/\r?\n/).find((l) => l.includes(`refs/heads/${remoteBranch}`));
  return { upToDate: line !== undefined && /^=\t/.test(line) };
}
