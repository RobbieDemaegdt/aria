import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { findGh, ghEnvironment } from "../github/access.ts";
import { APP_GIT_EMAIL, APP_GIT_NAME } from "../util/app-identity.ts";
import { samePath } from "../util/paths.ts";

export { samePath };

/**
 * Repo registry scanning (PLAN.md §4.9): finds git repos directly under the configured roots and reads their GitHub
 * remote and default branch. Paths can contain spaces ("Garden Castle Defense"); git gets them as separate arguments.
 */
export interface RepoInfo {
  name: string;
  path: string;
  /** The origin remote's host, lowercased (github.com, gitlab.com, an SSH host alias, …). */
  host?: string;
  owner?: string;
  repo?: string;
  /** A fork's `upstream` remote, "owner/repo", only when it's on github.com (read locally, nothing is fetched). */
  upstream?: string;
  defaultBranch?: string;
  /** "git" (default) for a git repository, or "folder" for a non-git local folder. */
  kind?: "git" | "folder";
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", ["-C", cwd, ...args], { timeout: 15_000, windowsHide: true });
  return stdout.trim();
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const s = await stat(path.join(dir, ".git"));
    return s.isDirectory() || s.isFile();
  } catch {
    return false;
  }
}

/** host/owner/repo from https, ssh:// or scp-style (git@host:owner/repo) remotes, or shorthand owner/repo. */
export function parseRemote(url: string): { host?: string; owner?: string; repo?: string } {
  const trimmed = url.trim();
  const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(trimmed);
  if (shorthand) {
    return { host: "github.com", owner: shorthand[1], repo: shorthand[2] };
  }
  const match = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/\s]+@)([^/:]+)(?::\d+)?[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (!match) return {};
  return { host: match[1]!.toLowerCase(), owner: match[2]!, repo: match[3]! };
}

/**
 * Whether the repository may have a remote by that name: its `.git/config` names it, or ARIA can't tell without git
 * (a worktree's or submodule's `.git` file, an `[include]`). Only a read of the file, nothing runs.
 */
async function mayHaveRemote(dir: string, name: string): Promise<boolean> {
  try {
    const text = await readFile(path.join(dir, ".git", "config"), "utf8");
    if (/^\s*\[include/im.test(text)) return true;
    return new RegExp(`^\\s*\\[remote\\s+"${name}"\\]`, "im").test(text);
  } catch {
    return true;
  }
}

export async function readRepoInfo(dir: string): Promise<RepoInfo> {
  const info: RepoInfo = { name: path.basename(dir), path: dir };
  const remote = await git(dir, ["remote", "get-url", "origin"]).catch(() => "");
  const parsed = remote ? parseRemote(remote) : {};
  if (parsed.owner && parsed.repo) {
    if (parsed.host) info.host = parsed.host;
    info.owner = parsed.owner;
    info.repo = parsed.repo;
  }
  // git is asked only when the repository's config names an upstream remote (most don't: one process less a project).
  const upstream = (await mayHaveRemote(dir, "upstream")) ? await git(dir, ["remote", "get-url", "upstream"]).catch(() => "") : "";
  const up = upstream ? parseRemote(upstream) : {};
  const name = /^[A-Za-z0-9_.-]{1,100}$/;
  if (up.host === "github.com" && up.owner && up.repo && name.test(up.owner) && name.test(up.repo)) info.upstream = `${up.owner}/${up.repo}`;
  const originHead = await git(dir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");
  const branch = originHead ? originHead.replace(/^origin\//, "") : await git(dir, ["branch", "--show-current"]).catch(() => "");
  if (branch) info.defaultBranch = branch;
  return info;
}

/** Reads folder metadata for either a git repository (`readRepoInfo`) or a plain non-git local folder (`kind: "folder"`). */
export async function readFolderInfo(dir: string): Promise<RepoInfo> {
  const s = await stat(dir).catch(() => null);
  if (!s || !s.isDirectory()) {
    throw new Error(`${dir} isn't an existing folder.`);
  }
  if (await isGitRepo(dir)) {
    return readRepoInfo(dir);
  }
  return { name: path.basename(dir) || dir, path: dir, kind: "folder" };
}

/** Git repos directly under each root (not recursive), skipping hidden folders and `exclude` paths. */
export async function scanRoots(roots: string[], { exclude = [] as string[], concurrency = 6 } = {}): Promise<RepoInfo[]> {
  const candidates: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = path.join(root, entry.name);
      if (exclude.some((x) => samePath(x, dir))) continue;
      candidates.push(dir);
    }
  }
  const found: RepoInfo[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
      while (next < candidates.length) {
        const dir = candidates[next++]!;
        if (await isGitRepo(dir)) found.push(await readRepoInfo(dir));
      }
    }),
  );
  return found.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** Clones into `<root>/<repo name>`; refuses to overwrite an existing folder. Accepts URLs or 'owner/repo'. */
export async function cloneRepo(url: string, root: string): Promise<RepoInfo> {
  let targetUrl = url.trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetUrl)) {
    targetUrl = `https://github.com/${targetUrl}.git`;
  }
  const { repo } = parseRemote(targetUrl);
  if (!repo || !/^[\w.-]+$/.test(repo) || repo === "." || repo === "..") throw new Error(`Not a repository URL: ${url}`);
  const dest = path.join(root, repo);
  if (existsSync(dest)) throw new Error(`${dest} already exists`);
  await execa("git", ["clone", "--", targetUrl, dest], { timeout: 15 * 60_000, windowsHide: true });
  return readRepoInfo(dest);
}

/** A remote by what it points at (host, owner, repository), however it's written. */
function remoteKey(url: string): string | undefined {
  const { host, owner, repo } = parseRemote(url);
  return owner && repo ? `${host}/${owner}/${repo.replace(/\.git$/i, "")}`.toLowerCase() : undefined;
}

const NEGATED_REPO_CUE = /\b(?:don['’]t|do not|never|stop)\b[\s\S]{0,40}\b(?:creat(?:e|ing)|mak(?:e|ing)|clon(?:e|ing)|repo|repos|repositor(?:y|ies))\b/iu;

const CREATE_REPO_CUE = /\b(?:creat(?:e|ing)|mak(?:e|ing)|new|init|initiali[sz]e|set\s*up|setup)\b/iu;

/** Injection guard for `clone_repo`: the user's latest message has to name this very repository (its URL or owner/repo). */
export function assertCloneGrounded(lastUserMessage: string, url: string): void {
  const wanted = remoteKey(url);
  const words = lastUserMessage.split(/\s+/).map((word) => word.replace(/^[("'`<[]+|[)"'`>\],;:!?.]+$/g, ""));
  const named = wanted !== undefined && words.some((word) => remoteKey(word) === wanted || remoteKey(`https://${word}`) === wanted);
  if (!named || NEGATED_REPO_CUE.test(lastUserMessage)) {
    throw new Error("Not cloned: ARIA only clones a repository the user names in their own message (its URL or owner/repo). Ask them; don't do it on your own.");
  }
}

/**
 * Injection guard for `create_repo`: the user's latest message has to ask for a repository and name it, owner included
 * (a space, `-` or `_` between words doesn't count), and say so for anything but a private one.
 */
export function assertCreateGrounded(lastUserMessage: string, options: { name: string; visibility?: "private" | "public" | "internal"; localOnly?: boolean }): void {
  const named = (name: string) => {
    const words = name.split(/[\s_-]+/).filter(Boolean).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return words.length > 0 && new RegExp(`(?<![\\w.-])${words.join("[\\s_-]+")}(?![\\w-]|\\.\\w)`, "iu").test(lastUserMessage);
  };
  if (!options.name.trim().split("/").every(named) || !CREATE_REPO_CUE.test(lastUserMessage) || NEGATED_REPO_CUE.test(lastUserMessage)) {
    throw new Error("Not created: ARIA only creates a repository the user asks for by name in their own message. Ask them; don't do it on your own.");
  }
  const { visibility = "private", localOnly } = options;
  if (!localOnly && visibility !== "private" && !new RegExp(`(?<!\\b(?:not|non)[\\s-])\\b${visibility}\\b`, "iu").test(lastUserMessage)) {
    throw new Error(`Not created: a ${visibility} repository needs the user to say ${visibility} in their own message. Ask them, or leave it private.`);
  }
}

export interface CreateRepoOptions {
  /** Repository name, e.g. "my-project" or "owner/my-project". */
  name: string;
  /** Root directory where the repo folder should live. */
  root: string;
  /** Visibility on GitHub: "private", "public", or "internal". Defaults to "private". */
  visibility?: "private" | "public" | "internal";
  /** Optional description for the repository. */
  description?: string;
  /** Whether to initialize with a README. Defaults to true. */
  addReadme?: boolean;
  /** Optional .gitignore template (e.g. "Node", "VisualStudio"). */
  gitignore?: string;
  /** Optional license (e.g. "MIT", "Apache-2.0"). */
  license?: string;
  /** If true, creates a local-only git repository (git init) without provisioning on GitHub. Defaults to false. */
  localOnly?: boolean;
  /** Optional full path to gh.exe / gh. */
  ghPath?: string;
  /** Environment to pass to commands. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Optional custom command runner for tests. */
  exec?: (
    file: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string>; timeout?: number },
  ) => Promise<{ exitCode?: number; stdout?: string; stderr?: string }>;
}

/**
 * Creates a new git repository: by default on GitHub using GitHub CLI (`gh repo create --clone`),
 * or locally only with `git init` when `localOnly: true`. Clones/initializes directly under `root`.
 */
export async function createRepo(options: CreateRepoOptions): Promise<RepoInfo> {
  const trimmed = options.name.trim();
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(trimmed);
  const repoName = match ? match[2]! : trimmed;
  if (!/^[\w.-]+$/.test(repoName) || repoName === "." || repoName === "..") {
    throw new Error(`Invalid repository name: ${options.name}`);
  }
  const dest = path.join(options.root, repoName);
  if (existsSync(dest)) {
    throw new Error(`${dest} already exists`);
  }

  if (options.localOnly) {
    const run =
      options.exec ??
      (async (file, args, opts) => {
        const res = await execa(file, args, { cwd: opts.cwd, env: opts.env, timeout: opts.timeout ?? 15_000, windowsHide: true });
        return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
      });

    await mkdir(dest, { recursive: true });
    await run("git", ["-C", dest, "init"], { cwd: dest, timeout: 15_000 });
    await run("git", ["-C", dest, "checkout", "-B", "main"], { cwd: dest, timeout: 15_000 }).catch(() => {
      // It keeps git's own default branch then, and that's the one read back below.
    });

    if (options.addReadme !== false) {
      const readmePath = path.join(dest, "README.md");
      await writeFile(readmePath, `# ${repoName}\n${options.description ? `\n${options.description}\n` : ""}`, "utf8");
      const identity = ["-c", `user.name=${APP_GIT_NAME}`, "-c", `user.email=${APP_GIT_EMAIL}`];
      await run("git", ["-C", dest, ...identity, "add", "README.md"], { cwd: dest, timeout: 15_000 });
      await run("git", ["-C", dest, ...identity, "commit", "-m", "Initial commit"], { cwd: dest, timeout: 15_000 });
    }

    return readRepoInfo(dest);
  }

  const envSource = options.env ?? process.env;
  const gh = options.ghPath ?? findGh(envSource)[0];
  if (!gh) {
    throw new Error("GitHub CLI (gh) was not found. Install gh and sign in with `gh auth login`, or set localOnly: true to create a local repository.");
  }

  const ghEnv = ghEnvironment(envSource);
  const args = ["repo", "create", trimmed, `--${options.visibility ?? "private"}`, "--clone"];
  if (options.description) {
    args.push("--description", options.description);
  }
  if (options.addReadme !== false) {
    args.push("--add-readme");
  }
  if (options.gitignore) {
    args.push("--gitignore", options.gitignore);
  }
  if (options.license) {
    args.push("--license", options.license);
  }

  const run =
    options.exec ??
    (async (file, cmdArgs, opts) => {
      const res = await execa(file, cmdArgs, { cwd: opts.cwd, env: opts.env, timeout: opts.timeout ?? 120_000, windowsHide: true });
      return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
    });

  try {
    await run(gh, args, { cwd: options.root, env: ghEnv.env, timeout: 120_000 });
  } catch (error) {
    const failed = error as { stderr?: string; stdout?: string; message?: string };
    const msg = (failed.stderr || failed.stdout || failed.message || "").trim();
    throw new Error(`Failed to create repository on GitHub: ${msg || "unknown error"}`, { cause: error });
  }

  if (!existsSync(dest)) {
    throw new Error(`Repository was created on GitHub but local folder ${dest} was not found.`);
  }

  return readRepoInfo(dest);
}
