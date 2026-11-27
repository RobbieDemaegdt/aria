/**
 * ARIA's own push (tasks/push.ts, item 3, the duck's points 3–5 and 10): production's command line, with a test's
 * configuration (a global git config that points github.com at local bare repositories, file protocol only). Every push
 * here goes to a bare repository in a temp folder; a case that has to be refused is on a `.invalid` host or never runs
 * git at all.
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
// The module's own object (the tests' guard wraps its functions there).
import childProcess from "node:child_process";
import { fetchCommit, PushRefused, pushArgs, pushCommit, pushEnvironment, pushRemoteName, pushTarget, writeTestPushConfig } from "../src/tasks/push.ts";
import { commitFile, git, makeRepo } from "./helpers.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/**
 * Made once with git, copied for each test (git's own files have no absolute path in them here): a project with a
 * task's branch (one commit beyond main) and its github.com remote as a bare repository.
 */
let template: { dir: string; tip: string } | undefined;
beforeAll(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aria-push-template-"));
  const project = makeRepo(dir, "Moonrise", "https://github.com/me/moonrise.git");
  commitFile(project, "README.md", "# Moonrise\n", "Initial commit");
  mkdirSync(path.join(dir, "remote", "me"), { recursive: true });
  git(dir, "clone", "-q", "--bare", "--no-local", project, path.join(dir, "remote", "me", "moonrise.git"));
  git(project, "checkout", "-q", "-b", "aria/fix-login");
  commitFile(project, "login.ts", "export const ok = true;\n", "Fix the login");
  const tip = git(project, "rev-parse", "HEAD");
  git(project, "checkout", "-q", "main");
  template = { dir, tip };
});
afterAll(() => {
  if (template) rmSync(template.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A copy of the template, and a test config pointing github.com at its bare repositories. */
function setup() {
  const base = mkdtempSync(path.join(os.tmpdir(), "aria-push-"));
  temps.push(base);
  cpSync(template!.dir, base, { recursive: true });
  const project = path.join(base, "Moonrise");
  const root = path.join(base, "remote");
  const tip = template!.tip;
  const config = path.join(base, "push-test.gitconfig");
  writeTestPushConfig(config, root);
  const target = pushTarget("me", "moonrise", { testRoot: root, testConfig: config, ghPath: "gh-isnt-used-in-a-test-run" });
  const remote = path.join(root, "me", "moonrise.git");
  const remoteRef = (ref: string, dir = remote) => {
    try {
      return git(dir, "rev-parse", "--verify", "--quiet", ref);
    } catch {
      return undefined;
    }
  };
  return { base, project, gitDir: path.join(project, ".git"), root, remote, remoteRef, tip, config, target, scratchRoot: path.join(base, "scratch") };
}

/** Somewhere else a planted setting would push to: `<evilRoot>/me/moonrise.git`, a bare repository (forward slashes). */
function evilRemote(base: string): { evilRoot: string; evil: string } {
  const evilRoot = path.join(base, "evil-root");
  mkdirSync(path.join(evilRoot, "me"), { recursive: true });
  const evil = path.join(evilRoot, "me", "moonrise.git");
  git(base, "init", "-q", "--bare", evil);
  return { evilRoot: evilRoot.replace(/\\/g, "/"), evil: evil.replace(/\\/g, "/") };
}

describe("pushCommit", () => {
  it("pushes the commit to the aria/ branch on the bare repository, nothing else, and leaves no scratch behind", async () => {
    const s = setup();
    git(s.project, "tag", "v1");
    const mainBefore = s.remoteRef("refs/heads/main");
    const outcome = await pushCommit({ gitDir: s.gitDir, tip: s.tip, remoteBranch: "aria/fix-login", target: s.target, scratchRoot: s.scratchRoot });
    expect(outcome).toEqual({ upToDate: false });
    expect(s.remoteRef("refs/heads/aria/fix-login")).toBe(s.tip);
    expect(s.remoteRef("refs/heads/main")).toBe(mainBefore);
    expect(s.remoteRef("refs/tags/v1")).toBeUndefined();
    expect(readdirSync(s.scratchRoot)).toEqual([]);
    // Again: up to date, nothing changes.
    expect(await pushCommit({ gitDir: s.gitDir, tip: s.tip, remoteBranch: "aria/fix-login", target: s.target, scratchRoot: s.scratchRoot })).toEqual({ upToDate: true });
  });

  it("pushes by commit: the branch moving after the card doesn't change what goes (D-duck 1)", async () => {
    const s = setup();
    git(s.project, "checkout", "-q", "aria/fix-login");
    commitFile(s.project, "later.ts", "x\n", "Later");
    git(s.project, "checkout", "-q", "main");
    await pushCommit({ gitDir: s.gitDir, tip: s.tip, remoteBranch: "aria/fix-login", target: s.target, scratchRoot: s.scratchRoot });
    expect(s.remoteRef("refs/heads/aria/fix-login")).toBe(s.tip);
  });

  it("never overwrites: a branch on GitHub with other commits is non-fast-forward, and stays as it was", async () => {
    const s = setup();
    git(s.project, "checkout", "-q", "-b", "other", "main");
    commitFile(s.project, "other.ts", "x\n", "Someone else's");
    const theirs = git(s.project, "rev-parse", "HEAD");
    git(s.project, "push", "-q", s.remote, "other:refs/heads/aria/fix-login");
    git(s.project, "checkout", "-q", "main");
    const failed = await pushCommit({ gitDir: s.gitDir, tip: s.tip, remoteBranch: "aria/fix-login", target: s.target, scratchRoot: s.scratchRoot }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(PushRefused);
    expect((failed as PushRefused).reason).toBe("non_fast_forward");
    expect(s.remoteRef("refs/heads/aria/fix-login")).toBe(theirs);
  });

  it("GitHub's push protection (GH013) is passed on in its own words, cleaned, with no bypass offered", async () => {
    const s = setup();
    // GitHub's side, played by the bare repository's pre-receive hook.
    const lines = [
      "error: GH013: Repository rule violations found for refs/heads/aria/fix-login.",
      "- GITHUB PUSH PROTECTION",
      `  Push cannot contain secrets: ghp_${"A".repeat(36)}\u202e evil\u001b[31m`,
    ];
    writeFileSync(path.join(s.remote, "hooks", "pre-receive"), `#!/bin/sh\n${lines.map((l) => `printf '%s\\n' '${l}' >&2`).join("\n")}\nexit 1\n`);
    const failed = await pushCommit({ gitDir: s.gitDir, tip: s.tip, remoteBranch: "aria/fix-login", target: s.target, scratchRoot: s.scratchRoot }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(PushRefused);
    const refused = failed as PushRefused;
    expect(refused.reason).toBe("push_protection");
    expect(refused.message).toMatch(/^GitHub's push protection refused it: error: GH013: Repository rule violations found for refs\/heads\/aria\/fix-login\. · - GITHUB PUSH PROTECTION · Push cannot contain secrets: \[token\]/);
    expect(refused.message).toMatch(/ARIA doesn't bypass it\.$/);
    expect(refused.message).not.toMatch(/ghp_|[\u202e\u001b]/);
    expect(s.remoteRef("refs/heads/aria/fix-login")).toBeUndefined();
  });

  it("reads none of the project's config and runs none of its hooks (pushes from a scratch repository)", async () => {
    const s = setup();
    // Another folder of bare repositories the planted config would send the push to instead.
    const { evilRoot, evil } = evilRemote(s.base);
    const marker = path.join(s.base, "hook-ran.txt");
    const hooks = path.join(s.base, "planted-hooks");
    mkdirSync(hooks, { recursive: true });
    const hook = `#!/bin/sh\necho ran > "${marker.replace(/\\/g, "/")}"\n`;
    writeFileSync(path.join(hooks, "pre-push"), hook);
    writeFileSync(path.join(s.gitDir, "hooks", "pre-push"), hook);
    writeFileSync(path.join(s.gitDir, "hooks", "reference-transaction"), hook);
    const included = path.join(s.base, "included.gitconfig");
    writeFileSync(included, `[url "${evilRoot}/"]\n\tinsteadOf = https://github.com/\n`);
    const planted = [
      // A remote section named by the URL itself: `git push <url>` would use its pushurl.
      `[remote "https://github.com/me/moonrise.git"]\n\tpushurl = ${evil}\n`,
      `[url "${evilRoot}/"]\n\tpushInsteadOf = https://github.com/\n`,
      `[core]\n\thooksPath = ${hooks.replace(/\\/g, "/")}\n\taskPass = "${marker.replace(/\\/g, "/")}"\n`,
      `[http]\n\tproxy = http://aria-proxy.invalid:9\n\textraHeader = X-Planted: 1\n`,
      `[include]\n\tpath = ${included.replace(/\\/g, "/")}\n`,
      `[push]\n\tfollowTags = true\n`,
    ].join("");
    appendFileSync(path.join(s.gitDir, "config"), planted);
    git(s.project, "tag", "planted-tag");
    await pushCommit({ gitDir: s.gitDir, tip: s.tip, remoteBranch: "aria/fix-login", target: s.target, scratchRoot: s.scratchRoot });
    expect(s.remoteRef("refs/heads/aria/fix-login")).toBe(s.tip);
    expect(s.remoteRef("refs/heads/aria/fix-login", evil)).toBeUndefined();
    expect(s.remoteRef("refs/tags/planted-tag")).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  });

  it("runs no hook from your global config's hooksPath either (ARIA's own empty folder, and --no-verify)", async () => {
    const s = setup();
    const marker = path.join(s.base, "global-hook-ran.txt");
    const hooks = path.join(s.base, "global-hooks");
    mkdirSync(hooks, { recursive: true });
    // pre-push: the client's own hook. (The bare repository's side reads this config too in a test, as GitHub's side
    // would run GitHub's hooks: those aren't ARIA's to stop, so they're left out here.)
    writeFileSync(path.join(hooks, "pre-push"), `#!/bin/sh\necho pre-push >> "${marker.replace(/\\/g, "/")}"\n`);
    writeFileSync(s.config, `[url "${s.root.replace(/\\/g, "/")}/"]\n\tinsteadOf = https://github.com/\n[core]\n\thooksPath = ${hooks.replace(/\\/g, "/")}\n`);
    await pushCommit({ gitDir: s.gitDir, tip: s.tip, remoteBranch: "aria/fix-login", target: s.target, scratchRoot: s.scratchRoot });
    expect(s.remoteRef("refs/heads/aria/fix-login")).toBe(s.tip);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a project whose repository borrows objects from elsewhere (a UNC path), before running git", async () => {
    const s = setup();
    mkdirSync(path.join(s.gitDir, "objects", "info"), { recursive: true });
    writeFileSync(path.join(s.gitDir, "objects", "info", "alternates"), "\\\\aria-share.invalid\\share\\objects\n");
    const failed = await pushCommit({ gitDir: s.gitDir, tip: s.tip, remoteBranch: "aria/fix-login", target: s.target, scratchRoot: s.scratchRoot }).catch((e: unknown) => e);
    expect((failed as PushRefused).reason).toBe("alternates");
    expect(existsSync(s.scratchRoot)).toBe(false);
    expect(s.remoteRef("refs/heads/aria/fix-login")).toBeUndefined();
  });

  it("refuses Git LFS set in any folder's .gitattributes, not only the root's", async () => {
    const s = setup();
    git(s.project, "checkout", "-q", "aria/fix-login");
    commitFile(s.project, "assets/textures/.gitattributes", "*.png filter=lfs diff=lfs merge=lfs -text\n", "Track textures with LFS");
    const tip = git(s.project, "rev-parse", "HEAD");
    git(s.project, "checkout", "-q", "main");
    const failed = await pushCommit({ gitDir: s.gitDir, tip, remoteBranch: "aria/fix-login", target: s.target, scratchRoot: s.scratchRoot }).catch((e: unknown) => e);
    expect((failed as PushRefused).reason).toBe("lfs");
    expect(s.remoteRef("refs/heads/aria/fix-login")).toBeUndefined();
  });

  it("refuses Git LFS (its upload is a hook, which ARIA's push doesn't run)", async () => {
    const s = setup();
    git(s.project, "checkout", "-q", "aria/fix-login");
    commitFile(s.project, ".gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n", "Track binaries with LFS");
    const tip = git(s.project, "rev-parse", "HEAD");
    git(s.project, "checkout", "-q", "main");
    const failed = await pushCommit({ gitDir: s.gitDir, tip, remoteBranch: "aria/fix-login", target: s.target, scratchRoot: s.scratchRoot }).catch((e: unknown) => e);
    expect((failed as PushRefused).reason).toBe("lfs");
    expect(s.remoteRef("refs/heads/aria/fix-login")).toBeUndefined();
  });

  it.each([
    ["insteadOf", "insteadOf = https://github.com/me/"],
    ["pushInsteadOf (the usual way to push over SSH)", "pushInsteadOf = https://github.com/"],
  ])("refuses when your global config rewrites github.com's address with %s (to SSH: another identity)", async (_what, rule) => {
    const s = setup();
    writeFileSync(s.config, `[url "${s.root.replace(/\\/g, "/")}/"]\n\tinsteadOf = https://github.com/\n[url "ssh://git@aria-ssh.invalid/"]\n\t${rule}\n`);
    const failed = await pushCommit({ gitDir: s.gitDir, tip: s.tip, remoteBranch: "aria/fix-login", target: s.target, scratchRoot: s.scratchRoot }).catch((e: unknown) => e);
    expect((failed as PushRefused).reason).toBe("rewritten");
    expect(s.remoteRef("refs/heads/aria/fix-login")).toBeUndefined();
  });

  it("a remote section of your global config named by the address doesn't apply (the push uses a name of its own)", async () => {
    const s = setup();
    const { evil } = evilRemote(s.base);
    writeFileSync(s.config, `[url "${s.root.replace(/\\/g, "/")}/"]\n\tinsteadOf = https://github.com/\n[remote "https://github.com/me/moonrise.git"]\n\tpushurl = ${evil}\n`);
    await pushCommit({ gitDir: s.gitDir, tip: s.tip, remoteBranch: "aria/fix-login", target: s.target, scratchRoot: s.scratchRoot });
    expect(s.remoteRef("refs/heads/aria/fix-login")).toBe(s.tip);
    expect(s.remoteRef("refs/heads/aria/fix-login", evil)).toBeUndefined();
  });

  it("takes every GIT_* variable and SSH_ASKPASS out of git's environment (any letter case)", async () => {
    const s = setup();
    const { evilRoot, evil } = evilRemote(s.base);
    const marker = path.join(s.base, "askpass-ran.txt");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_DIR: evil,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${evilRoot}/.pushInsteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/",
      GIT_CONFIG_PARAMETERS: `'remote.https://github.com/me/moonrise.git.pushurl'='${evil}'`,
      git_askpass: marker,
      GIT_SSH_COMMAND: `echo > "${marker}"`,
      SSH_ASKPASS: marker,
      GIT_TRACE: path.join(s.base, "trace.txt"),
    };
    await pushCommit({ gitDir: s.gitDir, tip: s.tip, remoteBranch: "aria/fix-login", target: s.target, scratchRoot: s.scratchRoot, env });
    expect(s.remoteRef("refs/heads/aria/fix-login")).toBe(s.tip);
    expect(s.remoteRef("refs/heads/aria/fix-login", evil)).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(path.join(s.base, "trace.txt"))).toBe(false);
    const clean = pushEnvironment(env, s.target);
    expect(Object.keys(clean).filter((k) => /^git_|^ssh_askpass$|^gcm_/i.test(k)).sort()).toEqual(["GCM_INTERACTIVE", "GIT_ALLOW_PROTOCOL", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT"]);
    expect(clean.GIT_ALLOW_PROTOCOL).toBe("file");
    // Normal use: https only, and your own global config (none of a test's).
    const real = pushEnvironment(env, pushTarget("me", "moonrise", { ghPath: "C:\\Program Files\\GitHub CLI\\gh.exe" }));
    expect(real.GIT_ALLOW_PROTOCOL).toBe("https");
    expect(real.GIT_CONFIG_GLOBAL).toBeUndefined();
  });

  it("a test run allows only the file protocol: an address that git would send over https isn't sent", async () => {
    const s = setup();
    // As if the test config pointed github.com at a server: the rewrite check passes, git refuses the transport.
    writeFileSync(s.config, `[url "https://aria-push.invalid/"]\n\tinsteadOf = https://github.com/\n`);
    const target = { ...s.target, expectedUrl: "https://aria-push.invalid/me/moonrise.git" };
    const failed = await pushCommit({ gitDir: s.gitDir, tip: s.tip, remoteBranch: "aria/fix-login", target, scratchRoot: s.scratchRoot }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(PushRefused);
    // Not "offline" (no host was looked up): git refused the protocol itself.
    expect((failed as PushRefused).reason).toBe("failed");
  });

  it.each([
    ["the default branch", "main"],
    ["another branch", "feature/x"],
    ["a full ref", "refs/heads/aria/x"],
    ["a force refspec", "+aria/x"],
    ["a way up", "aria/../main"],
    ["a lock name", "aria/x.lock"],
    ["a refspec", "aria/x:refs/heads/main"],
  ])("refuses %s as the branch, before running git", async (_what, remoteBranch) => {
    const s = setup();
    const failed = await pushCommit({ gitDir: s.gitDir, tip: s.tip, remoteBranch, target: s.target, scratchRoot: s.scratchRoot }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(PushRefused);
    expect(existsSync(s.scratchRoot)).toBe(false);
  });

  it("refuses a tip that isn't a commit's sha, an address off github.com, and a stopped ARIA", async () => {
    const s = setup();
    await expect(pushCommit({ gitDir: s.gitDir, tip: "main", remoteBranch: "aria/fix-login", target: s.target, scratchRoot: s.scratchRoot })).rejects.toBeInstanceOf(PushRefused);
    // Refused before git runs (no scratch folder made), whatever the rewrite check would say.
    const elsewhere = "https://aria-elsewhere.invalid/me/moonrise.git";
    await expect(pushCommit({ gitDir: s.gitDir, tip: s.tip, remoteBranch: "aria/fix-login", target: { ...s.target, url: elsewhere, expectedUrl: elsewhere }, scratchRoot: s.scratchRoot })).rejects.toThrow("ARIA only pushes to github.com.");
    expect(existsSync(s.scratchRoot)).toBe(false);
    const stopped = new AbortController();
    stopped.abort();
    const failed = await pushCommit({ gitDir: s.gitDir, tip: s.tip, remoteBranch: "aria/fix-login", target: s.target, scratchRoot: s.scratchRoot, signal: stopped.signal }).catch((e: unknown) => e);
    expect((failed as PushRefused).reason).toBe("stopped");
    expect(s.remoteRef("refs/heads/aria/fix-login")).toBeUndefined();
  });
});

describe("fetchCommit (item 4, D53): one commit from GitHub, the way ARIA pushes", () => {
  /** A commit on the bare repository (GitHub's) only. */
  function remoteOnly(s: ReturnType<typeof setup>): string {
    const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid" };
    const main = git(s.remote, "rev-parse", "main");
    const sha = childProcess.execFileSync("git", ["-C", s.remote, "commit-tree", `${main}^{tree}`, "-p", main, "-m", "On GitHub only"], { encoding: "utf8", env }).trim();
    git(s.remote, "update-ref", "refs/heads/main", sha);
    return sha;
  }

  it("brings the commit into the project's objects (nothing else of the project's is read or changed)", async () => {
    const s = setup();
    const sha = remoteOnly(s);
    expect(() => git(s.project, "cat-file", "-e", `${sha}^{commit}`)).toThrow();
    const refsBefore = git(s.project, "for-each-ref");
    expect(await fetchCommit({ gitDir: s.gitDir, sha, target: s.target, scratchRoot: s.scratchRoot })).toEqual({ fetched: true });
    expect(git(s.project, "cat-file", "-t", sha)).toBe("commit");
    expect(git(s.project, "for-each-ref")).toBe(refsBefore);
    expect(readdirSync(s.scratchRoot)).toEqual([]);
    // Already there: nothing to do.
    expect(await fetchCommit({ gitDir: s.gitDir, sha, target: s.target, scratchRoot: s.scratchRoot })).toEqual({ fetched: false });
  });

  it("refuses a rewrite of github.com's address (to SSH), a sha that isn't one, and an address off github.com", async () => {
    const s = setup();
    const sha = remoteOnly(s);
    writeFileSync(s.config, `[url "${s.root.replace(/\\/g, "/")}/"]\n\tinsteadOf = https://github.com/\n[url "ssh://git@aria-ssh.invalid/"]\n\tinsteadOf = https://github.com/me/\n`);
    await expect(fetchCommit({ gitDir: s.gitDir, sha, target: s.target, scratchRoot: s.scratchRoot })).rejects.toMatchObject({ reason: "rewritten" });
    await expect(fetchCommit({ gitDir: s.gitDir, sha: "main", target: s.target, scratchRoot: s.scratchRoot })).rejects.toBeInstanceOf(PushRefused);
    await expect(fetchCommit({ gitDir: s.gitDir, sha, target: { ...s.target, url: "https://aria-elsewhere.invalid/me/moonrise.git" }, scratchRoot: s.scratchRoot })).rejects.toThrow(/github\.com/);
    expect(() => git(s.project, "cat-file", "-e", `${sha}^{commit}`)).toThrow();
  });

  it("a commit GitHub doesn't have: refused, nothing copied", async () => {
    const s = setup();
    await expect(fetchCommit({ gitDir: s.gitDir, sha: "e".repeat(40), target: s.target, scratchRoot: s.scratchRoot })).rejects.toBeInstanceOf(PushRefused);
  });
});

describe("pushArgs and pushTarget", () => {
  it("production's command line: by commit, no force, no hooks, gh's credentials after the helper list is cleared", () => {
    const remote = pushRemoteName();
    expect(remote).toMatch(/^aria-[0-9a-f]{12}$/);
    expect(pushRemoteName()).not.toBe(remote);
    const args = pushArgs("C:\\scratch", "C:\\scratch\\no-hooks", { ghPath: "C:\\Program Files\\GitHub CLI\\gh.exe" }, "a".repeat(40), "aria/fix-login", remote);
    expect(args.slice(-9)).toEqual(["-C", "C:\\scratch", "push", "--porcelain", "--no-verify", "--no-follow-tags", "--recurse-submodules=no", remote, `${"a".repeat(40)}:refs/heads/aria/fix-login`]);
    const reset = args.indexOf("credential.helper=");
    const gh = args.indexOf('credential.https://github.com.helper=!"C:/Program Files/GitHub CLI/gh.exe" auth git-credential');
    expect(reset).toBeGreaterThan(0);
    expect(gh).toBeGreaterThan(reset);
    expect(args).toContain("core.hooksPath=C:/scratch/no-hooks");
    expect(args).toContain("core.askPass=");
    expect(args.join(" ")).not.toMatch(/--force|--mirror|--all|--tags|--delete|--prune|(^|\s)\+/);
  });

  it("a test run has the same command line; only the configuration differs", () => {
    const real = pushTarget("me", "moonrise", { ghPath: "gh" });
    const test = pushTarget("me", "moonrise", { testRoot: "C:\\t\\remote", testConfig: "C:\\t\\push.gitconfig", ghPath: "gh" });
    expect(pushArgs("s", "n", real, "a".repeat(40), "aria/x", "aria-1")).toEqual(pushArgs("s", "n", test, "a".repeat(40), "aria/x", "aria-1"));
    expect(real).toMatchObject({ url: "https://github.com/me/moonrise.git", expectedUrl: "https://github.com/me/moonrise.git", protocols: "https", env: {} });
    expect(test).toMatchObject({ url: "https://github.com/me/moonrise.git", expectedUrl: "C:/t/remote/me/moonrise.git", protocols: "file", env: { GIT_CONFIG_GLOBAL: "C:\\t\\push.gitconfig", GIT_CONFIG_NOSYSTEM: "1" } });
    expect(() => pushTarget("me/../x", "moonrise", { ghPath: "gh" })).toThrow(PushRefused);
    expect(() => pushTarget("me", "moonrise", { testRoot: "C:\\t", ghPath: "gh" })).toThrow(PushRefused);
  });
});
