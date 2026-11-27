import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createWorktree, diff, diffStat, gitAliases, pushSettings, readWorktreeFile, removeWorktree, resolveWorktreeRoot, slugify } from "../src/tasks/worktrees.ts";
import { commitFile, git, makeRepo } from "./helpers.ts";

const base = mkdtempSync(path.join(os.tmpdir(), "aria-wt-"));
afterAll(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function repoWithCommit(name: string): string {
  const repo = makeRepo(path.join(base, "repos"), name);
  commitFile(repo, "README.md", "# Hello\r\n", "Initial commit");
  return repo;
}

describe("slugify", () => {
  it.each([
    ["Add dark mode!", "add-dark-mode"],
    ["  Fix   the café's login  ", "fix-the-cafe-s-login"],
    ["!!!", "task"],
    ["a".repeat(60), "a".repeat(40)],
  ])("%s → %s", (title, slug) => {
    expect(slugify(title)).toBe(slug);
  });
});

describe("worktrees", () => {
  const root = resolveWorktreeRoot(path.join(base, "wt"));

  it("creates a worktree on an aria/ branch from the base, and picks a free name when it's taken", async () => {
    const repo = repoWithCommit("Garden Castle Defense");
    const head = git(repo, "rev-parse", "HEAD");
    const first = await createWorktree({ repoPath: repo, root, repoName: "Garden Castle Defense", slug: "add-notes", base: "main" });
    expect(first).toMatchObject({ branch: "aria/add-notes", baseBranch: "main", baseCommit: head });
    expect(first.path).toBe(path.join(root, "garden-castle-defense", "add-notes"));
    expect(readFileSync(path.join(first.path, "README.md"), "utf8")).toContain("Hello");
    const second = await createWorktree({ repoPath: repo, root, repoName: "Garden Castle Defense", slug: "add-notes", base: "main" });
    expect(second.branch).toBe("aria/add-notes-2");
    await expect(createWorktree({ repoPath: repo, root, repoName: "x", slug: "y", base: "nope" })).rejects.toThrow(/no branch nope/);
    await expect(createWorktree({ repoPath: repo, root, repoName: "x", slug: "y", base: "--upload-pack=evil" })).rejects.toThrow(/isn't a branch name/);
  });

  it("skips a name another task has (in any repository), so an @mention names one task", async () => {
    const repo = repoWithCommit("Claims");
    const taken = new Set(["fix-login"]);
    const wt = await createWorktree({ repoPath: repo, root, repoName: "Claims", slug: "fix-login", base: "main", claim: (name) => !taken.has(name) });
    expect(wt.branch).toBe("aria/fix-login-2");
  });

  it("lists the git aliases a command in the worktree would use, a multi-line one in full", async () => {
    const repo = repoWithCommit("Aliased");
    git(repo, "config", "alias.p", "push");
    git(repo, "config", "alias.Ship", "!git push origin HEAD");
    git(repo, "config", "alias.multi", "!f(){\n  git push origin HEAD:main\n}; f");
    const wt = await createWorktree({ repoPath: repo, root, repoName: "Aliased", slug: "aliases", base: "main" });
    const aliases = await gitAliases(wt.path);
    expect(aliases.get("p")).toBe("push");
    expect(aliases.get("ship")).toBe("!git push origin HEAD");
    expect(aliases.get("multi")).toBe("!f(){\n  git push origin HEAD:main\n}; f");
  });

  it("reads the push settings a push in the worktree would use, a mirror written without a value too", async () => {
    const repo = repoWithCommit("Pushy");
    const wt = await createWorktree({ repoPath: repo, root, repoName: "Pushy", slug: "push-settings", base: "main" });
    expect(await pushSettings(wt.path)).toEqual({ refspecs: [], mirror: false });
    git(repo, "config", "push.default", "upstream");
    git(repo, "config", "--add", "remote.origin.push", "HEAD:refs/heads/main");
    git(repo, "config", "--add", "remote.Backup.push", "refs/heads/*:refs/heads/*");
    git(repo, "config", "remote.other.mirror", "false");
    expect(await pushSettings(wt.path)).toEqual({ pushDefault: "upstream", refspecs: ["HEAD:refs/heads/main", "refs/heads/*:refs/heads/*"], mirror: false });
    // `[remote "m"] mirror` on its own line is true.
    appendFileSync(path.join(repo, ".git", "config"), '[remote "m"]\n\tmirror\n');
    expect((await pushSettings(wt.path))?.mirror).toBe(true);
    expect(await pushSettings(path.join(base, "no-such-folder"))).toBeUndefined();
  });

  it("doesn't run a program from the task's worktree config when ARIA's own git looks at the worktree", async () => {
    // Some shells inject git settings through the environment (fsmonitor off among them), which would hide the attack.
    const injected = Object.keys(process.env).filter((key) => /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(key));
    const saved = Object.fromEntries(injected.map((key) => [key, process.env[key]]));
    for (const key of injected) delete process.env[key];
    try {
      const repo = repoWithCommit("Monitored");
      git(repo, "config", "core.repositoryformatversion", "1");
      git(repo, "config", "extensions.worktreeConfig", "true");
      const wt = await createWorktree({ repoPath: repo, root, repoName: "Monitored", slug: "fsmon", base: "main" });
      // What a task could put there if its worktree config weren't read-only in the sandbox.
      writeFileSync(path.join(repo, ".git", "worktrees", "fsmon", "config.worktree"), "[core]\n\tfsmonitor = touch fsmonitor-ran\n");
      expect(git(wt.path, "config", "--get", "core.fsmonitor")).toBe("touch fsmonitor-ran");
      writeFileSync(path.join(wt.path, "changed.txt"), "x\n");
      await diffStat(wt.path, wt.baseCommit);
      await diff(wt.path, wt.baseCommit);
      expect(existsSync(path.join(wt.path, "fsmonitor-ran"))).toBe(false);
    } finally {
      Object.assign(process.env, saved);
    }
  });

  it("reports commits, committed changes and uncommitted ones, and a diff with new files and LF endings", async () => {
    const repo = repoWithCommit("Moonrise");
    const wt = await createWorktree({ repoPath: repo, root, repoName: "Moonrise", slug: "notes", base: "main" });
    expect(await diffStat(wt.path, wt.baseCommit)).toEqual({ commits: 0, filesChanged: 0, additions: 0, deletions: 0, uncommitted: 0 });
    commitFile(wt.path, "NOTES.md", "one\r\ntwo\r\n", "Add notes");
    writeFileSync(path.join(wt.path, "scratch.txt"), "draft\r\n");
    expect(await diffStat(wt.path, wt.baseCommit)).toEqual({ commits: 1, filesChanged: 1, additions: 2, deletions: 0, uncommitted: 1 });
    const { text, truncated } = await diff(wt.path, wt.baseCommit);
    expect(truncated).toBe(false);
    expect(text).toContain("+++ b/NOTES.md");
    expect(text).toContain("+++ b/scratch.txt");
    expect(text).toContain("+draft");
    expect(text).not.toContain("\r");
  });

  it("removes a worktree and its branch, and refuses anything that isn't ARIA's", async () => {
    const repo = repoWithCommit("StarHarvester");
    const wt = await createWorktree({ repoPath: repo, root, repoName: "StarHarvester", slug: "cleanup", base: "main" });
    writeFileSync(path.join(wt.path, "untracked.txt"), "x");
    await expect(removeWorktree({ repoPath: repo, root, worktree: repo, branch: wt.branch, deleteBranch: true })).rejects.toThrow(/isn't an ARIA worktree/);
    await expect(removeWorktree({ repoPath: repo, root, worktree: wt.path, branch: "main", deleteBranch: true })).rejects.toThrow(/isn't an ARIA branch/);
    await expect(removeWorktree({ repoPath: repo, root, worktree: root })).rejects.toThrow(/isn't an ARIA worktree/);
    await removeWorktree({ repoPath: repo, root, worktree: wt.path, branch: wt.branch, deleteBranch: true });
    expect(existsSync(wt.path)).toBe(false);
    expect(git(repo, "branch", "--list", "aria/*")).toBe("");
    expect(git(repo, "branch", "--show-current")).toBe("main");
  });

  it("gives two tasks with the same title started at once their own worktrees", async () => {
    const repo = repoWithCommit("Twin Peaks");
    const make = () => createWorktree({ repoPath: repo, root, repoName: "Twin Peaks", slug: "same-title", base: "main" });
    const [a, b] = await Promise.all([make(), make()]);
    expect(new Set([a.branch, b.branch])).toEqual(new Set(["aria/same-title", "aria/same-title-2"]));
    expect(a.path).not.toBe(b.path);
  });

  it("removes only its own worktree, leaving another missing worktree of the repository registered", async () => {
    const repo = repoWithCommit("Keeper");
    // Yours, outside ARIA's root, on a drive that isn't there right now (here: its folder is gone).
    const yours = path.join(base, "elsewhere", "yours");
    git(repo, "worktree", "add", "--quiet", "-b", "feature/yours", yours, "main");
    rmSync(yours, { recursive: true, force: true });
    const wt = await createWorktree({ repoPath: repo, root, repoName: "Keeper", slug: "mine", base: "main" });
    await removeWorktree({ repoPath: repo, root, worktree: wt.path, branch: wt.branch, deleteBranch: true });
    const list = git(repo, "worktree", "list", "--porcelain");
    expect(list).toContain("elsewhere/yours");
    expect(list).not.toContain("keeper/mine");
    // A worktree whose folder is gone already is unregistered too, and removing it twice is fine.
    const gone = await createWorktree({ repoPath: repo, root, repoName: "Keeper", slug: "gone", base: "main" });
    rmSync(gone.path, { recursive: true, force: true });
    await removeWorktree({ repoPath: repo, root, worktree: gone.path });
    await removeWorktree({ repoPath: repo, root, worktree: gone.path });
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("keeper/gone");
  });

  it("shows new files with non-ASCII names in the diff", async () => {
    const repo = repoWithCommit("Cafe");
    const wt = await createWorktree({ repoPath: repo, root, repoName: "Cafe", slug: "menu", base: "main" });
    writeFileSync(path.join(wt.path, "café.md"), "croissant\n");
    const { text } = await diff(wt.path, wt.baseCommit);
    expect(text).toContain("+++ b/café.md");
    expect(text).toContain("+croissant");
  });

  it("reads files inside the worktree for preview and refuses path traversal or symlink escapes", async () => {
    const repo = repoWithCommit("PreviewRepo");
    const wt = await createWorktree({ repoPath: repo, root, repoName: "PreviewRepo", slug: "preview", base: "main" });
    mkdirSync(path.join(wt.path, "docs"), { recursive: true });
    writeFileSync(path.join(wt.path, "docs", "guide.md"), "# Guide\r\nLine 2\r\n");
    writeFileSync(path.join(wt.path, "index.html"), "<h1>Dashboard</h1>\r\n");

    expect(readWorktreeFile(wt.path, "docs/guide.md")).toEqual({
      path: "docs/guide.md",
      content: "# Guide\nLine 2\n",
      truncated: false,
    });
    expect(readWorktreeFile(wt.path, "/docs/guide.md")).toEqual({
      path: "docs/guide.md",
      content: "# Guide\nLine 2\n",
      truncated: false,
    });
    expect(readWorktreeFile(wt.path, path.join(wt.path, "index.html"))).toEqual({
      path: "index.html",
      content: "<h1>Dashboard</h1>\n",
      truncated: false,
    });
    const sessionDir = path.join(base, "session-state", "task-1");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(path.join(sessionDir, "plan.md"), "# Plan\r\n1. Step one\r\n");
    expect(readWorktreeFile(wt.path, "plan.md", [sessionDir])).toEqual({
      path: "plan.md",
      content: "# Plan\n1. Step one\n",
      truncated: false,
    });
    expect(readWorktreeFile(wt.path, path.join(sessionDir, "plan.md"), [sessionDir])).toEqual({
      path: "plan.md",
      content: "# Plan\n1. Step one\n",
      truncated: false,
    });
    expect(readWorktreeFile(wt.path, "missing.md")).toBeNull();
    expect(readWorktreeFile(wt.path, "docs")).toBeNull();

    expect(() => readWorktreeFile(wt.path, "../outside.md")).toThrow(/outside the task's worktree/);
    expect(() => readWorktreeFile(wt.path, path.join(base, "outside.md"))).toThrow(/outside the task's worktree/);
    expect(() => readWorktreeFile(wt.path, ".")).toThrow(/outside the task's worktree/);
    expect(() => readWorktreeFile(wt.path, "bad\0path.md")).toThrow(/Invalid file path/);

    const secret = path.join(base, "secret.md");
    writeFileSync(secret, "top secret");
    const linkPath = path.join(wt.path, "escape.md");
    let linked = false;
    try {
      symlinkSync(secret, linkPath);
      linked = true;
    } catch {
      // Windows without Developer Mode may disallow file symlinks; directory junctions still work.
    }
    if (linked) {
      expect(() => readWorktreeFile(wt.path, "escape.md")).toThrow(/outside the task's worktree/);
    }
  });
});
