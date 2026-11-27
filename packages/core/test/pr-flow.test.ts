/**
 * Opening a task's PR (PLAN.md §4.3, §4.4, item 3, D41–D44): the card, your click, the push and the POST, the PR's
 * watch, and every way it stops. A whole engine against the mock GitHub; github.com's repositories are local bare
 * repositories (`push: true`), so the push is production's command line going to a folder.
 */
// The module's own object (the tests' guard wraps its functions there).
import childProcess from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CardItem, Task } from "@aria/protocol";
import { describe, expect, it } from "vitest";
import type { AriaEngine } from "../src/engine.ts";
import type { TokenResult } from "../src/github/access.ts";
import { DEFAULT_RULES } from "../src/policy/defaults.ts";
import { decideWorker } from "../src/policy/worker.ts";
import type { FakeRuntime, FakeWorkerStep } from "../src/runtime/fake.ts";
import { PR_NOTE } from "../src/tasks/manager.ts";
import { cleanText, cleanTitle, prBody, PullRequests, type PrDeps } from "../src/tasks/pr.ts";
import { cards, cleanUpAfterEach, ariaCalls, lastPrompt, setupGitHub, until } from "./github-helpers.ts";
import { commitFile, git } from "./helpers.ts";
import { MOCK_TOKEN } from "./mock-github.ts";

cleanUpAfterEach();

type PrCard = Extract<CardItem, { cardType: "pr_confirm" }>;
const ME = { owner: "me", repo: "moonrise" };

/** A worker that writes these files, commits them, and reports. */
function work(files: Record<string, string>, report = "Fixed the login: the session cookie is set again.", subject = "Fix the login"): FakeWorkerStep[] {
  const commit = `git add -A; git commit -m '${subject}'`;
  return [
    ...Object.entries(files).map(
      ([file, content]): FakeWorkerStep => ({
        tool: "create",
        args: { path: file },
        ask: (cwd) => ({ kind: "write", path: path.join(cwd, file) }),
        run: (cwd) => {
          mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
          writeFileSync(path.join(cwd, file), content);
        },
      }),
    ),
    {
      tool: "powershell",
      args: { command: commit },
      ask: (cwd) => ({ kind: "shell", command: commit, segments: ["git add -A", `git commit -m '${subject}'`], cwd, possiblePaths: [], possibleUrls: [] }),
      run: (cwd) => {
        git(cwd, "add", "-A");
        git(cwd, "commit", "-q", "-m", subject);
      },
    },
    { complete: report },
  ];
}

async function setup(options: { push?: boolean; tokens?: () => TokenResult } = {}) {
  const gh = await setupGitHub({ push: options.push ?? true, ...(options.tokens ? { tokens: options.tokens } : {}), engine: { taskSettleMs: 20, autopilotGraceMs: 150 } });
  const remote = gh.pushRoot ? path.join(gh.pushRoot, "me", "moonrise.git") : "";
  const remoteRef = (ref: string, dir = remote) => {
    try {
      return git(dir, "rev-parse", "--verify", "--quiet", ref);
    } catch {
      return undefined;
    }
  };
  return { ...gh, remote, remoteRef };
}

async function doneTask(engine: AriaEngine, runtime: FakeRuntime, steps: FakeWorkerStep[], extra: { mode?: "autopilot"; baseBranch?: string } = {}): Promise<Task> {
  runtime.workerScripts.push({ steps });
  const project = engine.getState().projects.find((p) => p.name === "Moonrise")!;
  const started = await engine.startTask({ repoId: project.id, brief: "Fix the login", title: "Fix the login", ...extra });
  await until(() => engine.getState().tasks.find((t) => t.id === started.id)?.state === "done", 10_000);
  return engine.getState().tasks.find((t) => t.id === started.id)!;
}

const taskOf = (engine: AriaEngine, id: string) => engine.getState().tasks.find((t) => t.id === id)!;
const prCard = (engine: AriaEngine) => cards(engine, "pr_confirm").at(-1)! as PrCard;
const click = (card: PrCard, extra: Partial<Parameters<AriaEngine["confirmPr"]>[0]> = {}) => ({
  cardId: card.id,
  revision: card.payload.revision,
  title: card.payload.title,
  body: card.payload.body,
  draft: card.payload.draft,
  openOn: card.payload.openOn,
  workflowsChecked: false,
  ...extra,
});

// These tests push and run git dozens of times: 8 to 20 s each on an idle PC. Each gets about three times that, as it
// runs two to three times slower with other test runs on the PC or on GitHub's Windows runners.
describe("Open PR: the card, your click, the push, the PR and its watch", () => {
  it("shows exactly what goes, pushes the commit, opens a draft PR as shown, records it on the task and watches its checks", { timeout: 45_000 }, async () => {
    const { make, runtime, mock, repo, remoteRef, clock } = await setup();
    const engine = make();
    await engine.start();
    const task = await doneTask(engine, runtime, work({ "login.ts": "export const ok = true;\n" }));
    expect(cards(engine, "pr_confirm")).toHaveLength(0);
    await engine.proposePr(task.id);
    const card = prCard(engine);
    expect(card.payload).toMatchObject({
      taskId: task.id,
      status: "pending",
      revision: 1,
      proposedBy: "you",
      pushTo: ME,
      choices: [ME],
      openOn: ME,
      remoteBranch: task.branch,
      base: "main",
      draft: true,
      title: "Fix the login",
      login: "sam-test",
      commits: 1,
      filesChanged: 1,
      additions: 1,
      deletions: 0,
      uncommitted: 0,
      subjects: ["Fix the login"],
      paths: ["login.ts"],
      workflows: [],
      flagged: [],
    });
    expect(card.payload.tip).toBe(git(repo, "rev-parse", task.branch!));
    expect(card.payload.body).toBe("Opened by ARIA from a task: 1 commit, 1 file, +1 −0. The task's title and its report:\n\n```text\nFix the login\n\nFixed the login: the session cookie is set again.\n```\n");
    expect(card.payload.existing).toBeUndefined();
    // Nothing pushed or sent before the click.
    expect(remoteRef(`refs/heads/${task.branch}`)).toBeUndefined();
    expect(mock.opened).toEqual([]);

    await engine.confirmPr(click(card));
    const done = prCard(engine);
    expect(done.id).toBe(card.id);
    expect(done.payload.status).toBe("done");
    expect(mock.opened).toEqual([{ owner: "me", repo: "moonrise", body: { title: "Fix the login", head: task.branch, base: "main", body: card.payload.body, draft: true } }]);
    expect(mock.count(/\/pulls$/, "POST")).toBe(1);
    expect(remoteRef(`refs/heads/${task.branch}`)).toBe(card.payload.tip);
    expect(remoteRef("refs/heads/main")).toBe(git(repo, "rev-parse", "main"));
    const after = taskOf(engine, task.id);
    expect(after.state).toBe("done");
    const watch = engine.getState().watches.find((w) => w.kind === "pr" && w.state === "active")!;
    expect(watch).toMatchObject({ createdBy: "task", taskId: task.id, repoName: "Moonrise" });
    expect(after.pr).toMatchObject({ owner: "me", repo: "moonrise", number: 1, url: "https://github.com/me/moonrise/pull/1", head: task.branch, base: "main", draft: true, watchId: watch.id });
    expect(done.payload.result).toEqual({ number: 1, url: "https://github.com/me/moonrise/pull/1", draft: true, watchId: watch.id });
    // The token was sent only as the header (never in what the mock recorded).
    expect(JSON.stringify(mock.requests)).not.toContain(MOCK_TOKEN);

    // ARIA hears of it in its digest.
    await engine.sendMessage("What's new?");
    await until(() => lastPrompt(runtime).includes("What's new?"));
    expect(lastPrompt(runtime)).toContain(`[pr] You opened draft PR #1 for "Fix the login" on me/moonrise; ARIA watches its checks (${watch.shortId}).`);

    // The PR's checks go green: a CI card.
    mock.setChecks("me", "moonrise", card.payload.tip, [{ name: "test", status: "completed", conclusion: "success" }]);
    clock.advance(121_000);
    await until(() => cards(engine, "ci").length === 1);
    expect(cards(engine, "ci")[0]!.payload).toMatchObject({ source: "checks", outcome: "success", headSha: card.payload.tip });
  });

  it("a second click while it's on its way does nothing; an old revision of the card is refused", { timeout: 45_000 }, async () => {
    const { make, runtime, mock } = await setup();
    const engine = make();
    await engine.start();
    const task = await doneTask(engine, runtime, work({ "login.ts": "x\n" }));
    await engine.proposePr(task.id);
    const card = prCard(engine);
    await expect(engine.confirmPr(click(card, { revision: 0 }))).rejects.toThrow(/changed since/);
    const both = await Promise.allSettled([engine.confirmPr(click(card)), engine.confirmPr(click(card))]);
    expect(both.map((b) => b.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(String((both.find((b) => b.status === "rejected") as PromiseRejectedResult).reason)).toMatch(/on its way already|changed since/);
    expect(mock.count(/\/pulls$/, "POST")).toBe(1);
    expect(prCard(engine).payload.status).toBe("done");
    // Done: a click on it again is refused, and Open PR again doesn't make another PR without your click.
    await expect(engine.confirmPr(click(prCard(engine)))).rejects.toThrow(/isn't waiting/);
  });

  it("two Open PRs at once make one card", { timeout: 45_000 }, async () => {
    const { make, runtime } = await setup();
    const engine = make();
    await engine.start();
    const task = await doneTask(engine, runtime, work({ "login.ts": "x\n" }));
    await Promise.all([engine.proposePr(task.id), engine.proposePr(task.id)]);
    expect(cards(engine, "pr_confirm")).toHaveLength(1);
  });
});

describe("what the card shows (D41, D43) and what's sent (the duck's point 6)", () => {
  it("lists workflow changes, which need their own tick, and flags build files; uncommitted changes are said and stay (D41)", { timeout: 45_000 }, async () => {
    const { make, runtime, mock, remote, remoteRef } = await setup();
    const engine = make();
    await engine.start();
    const steps = work({ ".github/workflows/ci.yml": "on: push\n", "package.json": "{}\n", ".gitmodules": "", "src/app.ts": "x\n" });
    // A file the worker left uncommitted.
    steps.splice(-1, 0, { tool: "create", args: { path: "notes.txt" }, ask: (cwd) => ({ kind: "write", path: path.join(cwd, "notes.txt") }), run: (cwd) => writeFileSync(path.join(cwd, "notes.txt"), "draft\n") });
    const task = await doneTask(engine, runtime, steps);
    await engine.proposePr(task.id);
    const card = prCard(engine);
    expect(card.payload.workflows).toEqual([".github/workflows/ci.yml"]);
    expect(card.payload.flagged.sort()).toEqual([".gitmodules", "package.json"]);
    expect(card.payload.uncommitted).toBe(1);
    // Without the tick: refused, and the card waits as it was (nothing pushed).
    await expect(engine.confirmPr(click(card))).rejects.toThrow(/tick/);
    expect(prCard(engine).payload).toMatchObject({ status: "pending", revision: card.payload.revision });
    expect(remoteRef(`refs/heads/${task.branch}`)).toBeUndefined();
    await engine.confirmPr(click(card, { workflowsChecked: true }));
    expect(prCard(engine).payload.status).toBe("done");
    expect(mock.opened).toHaveLength(1);
    // The uncommitted file wasn't pushed; the committed ones were.
    expect(git(remote, "ls-tree", "-r", "--name-only", card.payload.tip).split("\n").sort()).toEqual([".github/workflows/ci.yml", ".gitmodules", "README.md", "package.json", "src/app.ts"]);
  });

  it("the worker's words are cleaned and fenced: no mention, closing word or invisible character works on GitHub", { timeout: 45_000 }, async () => {
    const { make, runtime, mock } = await setup();
    const engine = make();
    await engine.start();
    const report = "Done.\r\n```\n@octocat closes #1\u202e\u200b\u001b[31m red\n````\nend";
    const task = await doneTask(engine, runtime, work({ "login.ts": "x\n" }, report, "Fix it"));
    await engine.proposePr(task.id);
    const card = prCard(engine);
    expect(card.payload.body).toContain("`````text\nFix the login\n\nDone.\n```\n@octocat closes #1[31m red\n````\nend\n`````\n");
    expect(card.payload.body).not.toMatch(/[\u202e\u200b\u001b\r]/);
    // Your edit in the window (a textarea's \r\n, a bidi character typed in) is cleaned the same way before it's sent.
    await engine.confirmPr(click(card, { title: "Fix\u202e the login\n(now)", body: "Edited\r\nby you\u200b" }));
    expect(mock.opened[0]!.body).toMatchObject({ title: "Fix the login (now)", body: "Edited\nby you" });
  });

  it("prBody, cleanText and cleanTitle", () => {
    const body = prBody("A ``` title", "Report with ```` four", { commits: 2, filesChanged: 3, additions: 4, deletions: 5 });
    expect(body.startsWith("Opened by ARIA from a task: 2 commits, 3 files, +4 −5.")).toBe(true);
    expect(body).toContain("`````text\nA ``` title\n\nReport with ```` four\n`````\n");
    expect(prBody("T", undefined, { commits: 1, filesChanged: 1, additions: 0, deletions: 0 })).toContain("```text\nT\n\n(The worker left no report.)\n```");
    expect(cleanText("a\r\nb\rc\u2028d\u2029e\tf\u0000\u200d\u2066g")).toBe("a\nb\nc\nd\ne\tfg");
    expect(cleanTitle("  one\ntwo\u202e  ")).toBe("one two");
    expect(cleanTitle("x".repeat(300))).toHaveLength(256);
  });
});

/**
 * A commit made with git's plumbing (no checkout: a path Windows can't hold, like one with a tab or a quote): `files`
 * added to `parent`'s tree. Its sha.
 */
function plumbingCommit(repo: string, parent: string, files: Record<string, string>, message: string): string {
  const index = path.join(repo, ".git", `aria-test-index-${Math.random().toString(16).slice(2)}`);
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  // protectNTFS off: on Windows git refuses such names in an index otherwise (GitHub takes them; Linux has them).
  const run = (args: string[], input?: string) => childProcess.execFileSync("git", ["-c", "core.protectNTFS=false", "-C", repo, ...args], { env, encoding: "utf8", ...(input !== undefined ? { input } : {}) }).trim();
  run(["read-tree", parent]);
  for (const [file, content] of Object.entries(files)) {
    const blob = run(["hash-object", "-w", "--stdin"], content);
    run(["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`]);
  }
  const tree = run(["write-tree"]);
  rmSync(index, { force: true });
  return run(["commit-tree", tree, "-p", parent, "-m", message]);
}

describe("review round 1 of item 3", () => {
  it("D43 holds for a workflow whose name git would quote: non-ASCII, a tab, a quote (raw paths, -z)", { timeout: 45_000 }, async () => {
    const { make, runtime, mock, repo, remoteRef } = await setup();
    const engine = make();
    await engine.start();
    const task = await doneTask(engine, runtime, work({ ".github/workflows/déploy.yml": "on: push\n", "src/app.ts": "x\n" }));
    // Two more paths through plumbing on the task's branch: a tab and a quote (Windows can't have them as files).
    const tip = git(repo, "rev-parse", task.branch!);
    const odd = plumbingCommit(repo, tip, { ".github/workflows/a\tb.yml": "on: push\n", '.github/workflows/q"uote.yml': "on: push\n", 'build/x"y.sh': "echo\n" }, "Odd names");
    git(repo, "update-ref", `refs/heads/${task.branch}`, odd);
    await engine.proposePr(task.id);
    const card = prCard(engine);
    expect(card.payload.workflows.sort()).toEqual([".github/workflows/a b.yml", ".github/workflows/déploy.yml", '.github/workflows/q"uote.yml']);
    expect(card.payload.flagged).toEqual(['build/x"y.sh']);
    expect(card.payload.paths).toContain("src/app.ts");
    await expect(engine.confirmPr(click(card))).rejects.toThrow(/tick/);
    expect(remoteRef(`refs/heads/${task.branch}`)).toBeUndefined();
    expect(mock.opened).toEqual([]);
  });

  it("the card shows what the push sends: a replace ref or a graft in the project changes neither", { timeout: 45_000 }, async () => {
    const { make, runtime, repo } = await setup();
    const engine = make();
    await engine.start();
    const task = await doneTask(engine, runtime, work({ "login.ts": "x\n", ".github/workflows/ci.yml": "on: push\n" }));
    const tip = git(repo, "rev-parse", task.branch!);
    const base = git(repo, "rev-parse", "main");
    // A commit that looks innocent, put in the tip's place for every git that honours replace refs.
    const innocent = plumbingCommit(repo, base, { "login.ts": "x\n" }, "Only the login");
    git(repo, "replace", tip, innocent);
    expect(git(repo, "show", "--name-only", "--format=", task.branch!)).toBe("login.ts");
    // And a graft that puts that commit under the tip: the project's git now counts two commits.
    writeFileSync(path.join(repo, ".git", "info", "grafts"), `${tip} ${innocent}\n`);
    expect(git(repo, "rev-list", "--count", `${base}..${tip}`)).toBe("2");
    await engine.proposePr(task.id);
    const card = prCard(engine);
    expect(card.payload).toMatchObject({ tip, commits: 1, workflows: [".github/workflows/ci.yml"] });
    expect(card.payload.paths.sort()).toEqual([".github/workflows/ci.yml", "login.ts"]);
  });

  it("Push new commits after the branch was rewritten under an open PR: refused, never a second PR", { timeout: 45_000 }, async () => {
    const { make, runtime, mock } = await setup();
    const engine = make();
    await engine.start();
    const task = await doneTask(engine, runtime, work({ "login.ts": "x\n" }));
    await engine.proposePr(task.id);
    await engine.confirmPr(click(prCard(engine)));
    expect(taskOf(engine, task.id).pr).toMatchObject({ number: 1 });
    git(task.worktreePath!, "commit", "-q", "--amend", "-m", "Rewritten");
    await expect(engine.proposePr(task.id)).rejects.toThrow(/PR #1's commits \([0-9a-f]{7}\) aren't in the task's branch anymore.*doesn't open a second PR/);
    expect(mock.count(/\/pulls$/, "POST")).toBe(1);
    expect(taskOf(engine, task.id).pr).toMatchObject({ number: 1 });
  });

  it("new commits after the PR was merged: a new PR, and the card says so; while it's open, more commits go to it", { timeout: 60_000 }, async () => {
    const { make, runtime, mock } = await setup();
    const engine = make();
    await engine.start();
    const task = await doneTask(engine, runtime, work({ "login.ts": "x\n" }));
    await engine.proposePr(task.id);
    await engine.confirmPr(click(prCard(engine)));
    // More commits while #1 is open: the same branch, no new PR.
    git(task.worktreePath!, "commit", "-q", "--allow-empty", "-m", "More");
    await engine.proposePr(task.id);
    expect(prCard(engine).payload).toMatchObject({ remoteBranch: task.branch, existing: { number: 1 } });
    expect(prCard(engine).payload.notes).toBeUndefined();
    await engine.confirmPr(click(prCard(engine)));
    expect(mock.count(/\/pulls$/, "POST")).toBe(1);
    // #1 merged: the next commits open a new PR, said on the card.
    Object.assign(mock.pull("me", "moonrise", 1), { state: "closed", merged: true });
    git(task.worktreePath!, "commit", "-q", "--allow-empty", "-m", "Later still");
    await engine.proposePr(task.id);
    expect(prCard(engine).payload.notes).toEqual(["PR #1 is merged: this opens a new PR for the new commits."]);
    expect(prCard(engine).payload.existing).toBeUndefined();
    await engine.confirmPr(click(prCard(engine)));
    expect(taskOf(engine, task.id).pr).toMatchObject({ number: 2 });
  });

  it("a fork whose base lacks the task's starting commit: the card opens on the upstream, and says why", { timeout: 45_000 }, async () => {
    const { make, runtime, mock, repo, pushRoot } = await setup();
    // The upstream has a commit the fork (me/moonrise on GitHub) doesn't; local main has it too.
    commitFile(repo, "upstream.txt", "x\n", "From upstream");
    git(repo, "remote", "add", "upstream", "https://github.com/acme/moonrise.git");
    mock.addRepo("acme", "moonrise");
    mkdirSync(path.join(pushRoot!, "acme"), { recursive: true });
    git(repo, "clone", "-q", "--bare", repo, path.join(pushRoot!, "acme", "moonrise.git"));
    const engine = make();
    await engine.start();
    const task = await doneTask(engine, runtime, work({ "login.ts": "x\n" }));
    await engine.proposePr(task.id);
    const card = prCard(engine);
    expect(card.payload.openOn).toEqual({ owner: "acme", repo: "moonrise" });
    expect(card.payload.notes).toEqual(["main on your fork me/moonrise doesn't have the commit the task started from; acme/moonrise's does, so the PR is set to open there."]);
    // Switched back to the fork: refused at the click.
    await engine.confirmPr(click(card, { openOn: ME }));
    expect(prCard(engine).payload).toMatchObject({ status: "failed", error: expect.stringMatching(/commits that aren't on me\/moonrise's main/) });
    expect(mock.opened).toEqual([]);
    await engine.proposePr(task.id);
    await engine.confirmPr(click(prCard(engine)));
    expect(mock.opened).toEqual([{ owner: "acme", repo: "moonrise", body: expect.objectContaining({ head: `me:${task.branch}` }) }]);
  });
});

describe("GitHub's side: an existing PR, a taken branch name, the base, refusals", () => {
  it("an open PR for the branch already: the push adds the commits, no new PR, and it's linked", { timeout: 45_000 }, async () => {
    const { make, runtime, mock } = await setup();
    const engine = make();
    await engine.start();
    const task = await doneTask(engine, runtime, work({ "login.ts": "x\n" }));
    mock.addPull("me", "moonrise", 9, { title: "Earlier", headRef: task.branch!, base: "main", draft: false });
    await engine.proposePr(task.id);
    expect(prCard(engine).payload.existing).toEqual({ number: 9, url: "https://github.com/me/moonrise/pull/9" });
    await engine.confirmPr(click(prCard(engine)));
    expect(mock.count(/\/pulls$/, "POST")).toBe(0);
    expect(prCard(engine).payload.result).toMatchObject({ number: 9, draft: false, updated: true });
    expect(taskOf(engine, task.id).pr).toMatchObject({ number: 9, draft: false });
  });

  it("a 422 'already exists' (made meanwhile) finds it and links it, only on the card's base", { timeout: 45_000 }, async () => {
    const { make, runtime, mock } = await setup();
    const engine = make();
    await engine.start();
    const task = await doneTask(engine, runtime, work({ "login.ts": "x\n" }));
    mock.addPull("me", "moonrise", 7, { title: "Meanwhile", headRef: task.branch!, base: "main" });
    // The lookups at the card and at the click don't see it yet.
    mock.failures.push({ path: /\/pulls$/, method: "GET", status: 200, body: [], times: 2 });
    await engine.proposePr(task.id);
    await engine.confirmPr(click(prCard(engine)));
    expect(mock.count(/\/pulls$/, "POST")).toBe(1);
    expect(prCard(engine).payload).toMatchObject({ status: "done", result: { number: 7, updated: true } });
    expect(taskOf(engine, task.id).pr).toMatchObject({ number: 7 });
  });

  it("a PR found on another base isn't linked", { timeout: 45_000 }, async () => {
    const { make, runtime, mock } = await setup();
    const engine = make();
    await engine.start();
    const task = await doneTask(engine, runtime, work({ "login.ts": "x\n" }));
    mock.addPull("me", "moonrise", 7, { title: "Elsewhere", headRef: task.branch!, base: "develop" });
    mock.failures.push({ path: /\/pulls$/, method: "GET", status: 200, body: [], times: 2 });
    await engine.proposePr(task.id);
    await engine.confirmPr(click(prCard(engine)));
    expect(prCard(engine).payload).toMatchObject({ status: "failed", error: expect.stringMatching(/exists already/) });
    expect(taskOf(engine, task.id).pr).toBeUndefined();
  });

  it("an aria/ branch on GitHub with other commits (an old PR's) isn't overwritten: the push goes to <branch>-<7 of the sha>", { timeout: 45_000 }, async () => {
    const { make, runtime, mock, repo, remote, remoteRef } = await setup();
    const engine = make();
    await engine.start();
    const task = await doneTask(engine, runtime, work({ "login.ts": "x\n" }));
    // Someone's commits on GitHub under the task's branch name.
    git(repo, "checkout", "-q", "-b", "old", "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "An old PR");
    const old = git(repo, "rev-parse", "HEAD");
    git(repo, "push", "-q", remote, `old:refs/heads/${task.branch}`);
    git(repo, "checkout", "-q", "main");
    await engine.proposePr(task.id);
    const card = prCard(engine);
    expect(card.payload.remoteBranch).toBe(`${task.branch}-${card.payload.tip.slice(0, 7)}`);
    await engine.confirmPr(click(card));
    expect(remoteRef(`refs/heads/${task.branch}`)).toBe(old);
    expect(remoteRef(`refs/heads/${card.payload.remoteBranch}`)).toBe(card.payload.tip);
    expect(mock.opened[0]!.body).toMatchObject({ head: card.payload.remoteBranch });
  });

  it("refuses a base GitHub doesn't have, and a base with local commits GitHub doesn't have (they'd be in the PR)", { timeout: 45_000 }, async () => {
    const { make, runtime, repo, mock } = await setup();
    git(repo, "branch", "develop");
    const engine = make();
    await engine.start();
    const onDevelop = await doneTask(engine, runtime, work({ "a.ts": "x\n" }, "Done.", "Add a"), { baseBranch: "develop" });
    await expect(engine.proposePr(onDevelop.id)).rejects.toThrow(/develop isn't on me\/moonrise/);
    // A commit on main that was never pushed, then a task from it.
    git(repo, "commit", "-q", "--allow-empty", "-m", "Local only");
    const ahead = await doneTask(engine, runtime, work({ "b.ts": "x\n" }, "Done.", "Add b"));
    await expect(engine.proposePr(ahead.id)).rejects.toThrow(/commits that aren't on me\/moonrise's main/);
    expect(cards(engine, "pr_confirm")).toHaveLength(0);
    expect(mock.opened).toEqual([]);
  });

  it("draft PRs not taken there: the card waits for you to switch Draft off", { timeout: 45_000 }, async () => {
    const { make, runtime, mock } = await setup();
    mock.draftsUnsupported = true;
    const engine = make();
    await engine.start();
    const task = await doneTask(engine, runtime, work({ "login.ts": "x\n" }));
    await engine.proposePr(task.id);
    await engine.confirmPr(click(prCard(engine)));
    const waiting = prCard(engine);
    expect(waiting.payload).toMatchObject({ status: "pending", error: expect.stringMatching(/Switch Draft off/) });
    await engine.confirmPr(click(waiting, { draft: false }));
    expect(prCard(engine).payload).toMatchObject({ status: "done", result: { draft: false } });
    expect(mock.opened.map((o) => o.body.draft)).toEqual([true, false]);
  });

  it("SSO and a failed POST after the push: said on the card, never retried; Try again looks again and opens it", { timeout: 45_000 }, async () => {
    const { make, runtime, mock, remoteRef } = await setup();
    const engine = make();
    await engine.start();
    const task = await doneTask(engine, runtime, work({ "login.ts": "x\n" }));
    await engine.proposePr(task.id);
    mock.failures.push({ path: /\/pulls$/, method: "POST", status: 403, headers: { "x-github-sso": "required; url=https://github.com/orgs/acme/sso?authorization_request=x" } });
    await engine.confirmPr(click(prCard(engine)));
    expect(prCard(engine).payload).toMatchObject({ status: "failed", error: expect.stringMatching(/\(acme\) wants GitHub CLI's token authorized for single sign-on/) });
    // The push itself went.
    expect(remoteRef(`refs/heads/${task.branch}`)).toBe(prCard(engine).payload.tip);
    await engine.proposePr(task.id);
    mock.failures.push({ path: /\/pulls$/, method: "POST", status: 502 });
    await engine.confirmPr(click(prCard(engine)));
    expect(prCard(engine).payload).toMatchObject({ status: "failed", error: "GitHub had a problem (502)." });
    expect(mock.count(/\/pulls$/, "POST")).toBe(2);
    // Try again: the same card, worked out again (the branch is on GitHub at these commits: the same name).
    await engine.proposePr(task.id);
    const again = prCard(engine);
    expect(cards(engine, "pr_confirm")).toHaveLength(1);
    expect(again.payload).toMatchObject({ status: "pending", remoteBranch: task.branch });
    expect(again.payload.error).toBeUndefined();
    await engine.confirmPr(click(again));
    expect(prCard(engine).payload).toMatchObject({ status: "done", result: { number: 1 } });
    expect(mock.count(/\/pulls$/, "POST")).toBe(3);
  });

  it("a fork: the PR goes to the fork by default (D42); switched to the upstream, its head is the fork's owner", { timeout: 45_000 }, async () => {
    const { make, runtime, mock, repo, pushRoot, remoteRef } = await setup();
    git(repo, "remote", "add", "upstream", "https://github.com/acme/moonrise.git");
    mock.addRepo("acme", "moonrise");
    mkdirSync(path.join(pushRoot!, "acme"), { recursive: true });
    git(repo, "clone", "-q", "--bare", repo, path.join(pushRoot!, "acme", "moonrise.git"));
    const engine = make();
    await engine.start();
    const task = await doneTask(engine, runtime, work({ "login.ts": "x\n" }));
    await engine.proposePr(task.id);
    const card = prCard(engine);
    expect(card.payload.choices).toEqual([ME, { owner: "acme", repo: "moonrise" }]);
    expect(card.payload.openOn).toEqual(ME);
    await expect(engine.confirmPr(click(card, { openOn: { owner: "stranger", repo: "moonrise" } }))).rejects.toThrow(/isn't one of the repositories/);
    await engine.confirmPr(click(card, { openOn: { owner: "acme", repo: "moonrise" } }));
    expect(mock.opened).toEqual([{ owner: "acme", repo: "moonrise", body: expect.objectContaining({ head: `me:${task.branch}`, base: "main" }) }]);
    // Pushed to the fork (origin), not to the upstream.
    expect(remoteRef(`refs/heads/${task.branch}`)).toBe(card.payload.tip);
    expect(remoteRef(`refs/heads/${task.branch}`, path.join(pushRoot!, "acme", "moonrise.git"))).toBeUndefined();
    expect(taskOf(engine, task.id).pr).toMatchObject({ owner: "acme", repo: "moonrise", head: `me:${task.branch}` });
  });
});

describe("a card that's stale by the click (the duck's points 7 and 9)", () => {
  it("the branch moved since the card: refused, nothing pushed or sent", { timeout: 45_000 }, async () => {
    const { make, runtime, mock, remoteRef } = await setup();
    const engine = make();
    await engine.start();
    const task = await doneTask(engine, runtime, work({ "login.ts": "x\n" }));
    await engine.proposePr(task.id);
    git(task.worktreePath!, "commit", "-q", "--allow-empty", "-m", "Later");
    await engine.confirmPr(click(prCard(engine)));
    expect(prCard(engine).payload).toMatchObject({ status: "failed", error: expect.stringMatching(/moved since this card/) });
    expect(remoteRef(`refs/heads/${task.branch}`)).toBeUndefined();
    expect(mock.opened).toEqual([]);
  });

  it("GitHub CLI switched accounts since the card: refused", { timeout: 45_000 }, async () => {
    let token = MOCK_TOKEN;
    const { make, runtime, mock, remoteRef } = await setup({ tokens: () => ({ ok: true, token, source: "the mock" }) });
    const engine = make();
    await engine.start();
    const task = await doneTask(engine, runtime, work({ "login.ts": "x\n" }));
    await engine.proposePr(task.id);
    token = "gho_ariaMockTokenOtherAccount000000000";
    mock.token = token;
    mock.login = "someone-else";
    await engine.confirmPr(click(prCard(engine)));
    expect(prCard(engine).payload).toMatchObject({ status: "failed", error: expect.stringMatching(/now uses @someone-else, not @sam-test/) });
    expect(remoteRef(`refs/heads/${task.branch}`)).toBeUndefined();
    expect(mock.opened).toEqual([]);
  });

  it("a task discarded or cleaned up since the card: refused", { timeout: 60_000 }, async () => {
    const { make, runtime, mock } = await setup();
    const engine = make();
    await engine.start();
    const discarded = await doneTask(engine, runtime, work({ "a.ts": "x\n" }, "Done.", "Add a"));
    await engine.proposePr(discarded.id);
    const first = prCard(engine);
    await engine.discardTask(discarded.id);
    await engine.confirmPr(click(first));
    expect(cards(engine, "pr_confirm").find((c) => c.id === first.id)!.payload).toMatchObject({ status: "failed", error: expect.stringMatching(/doesn't exist anymore/) });
    const cleaned = await doneTask(engine, runtime, work({ "b.ts": "x\n" }, "Done.", "Add b"));
    await engine.proposePr(cleaned.id);
    const second = prCard(engine);
    await ariaCalls(engine, runtime, "cleanup_task", { task: cleaned.id });
    await until(() => taskOf(engine, cleaned.id).cleanedUp === true);
    await engine.confirmPr(click(second));
    expect(prCard(engine).payload).toMatchObject({ status: "failed", error: expect.stringMatching(/cleaned up/) });
    expect(mock.opened).toEqual([]);
    // Open PR on a cleaned task says why it can't.
    await expect(engine.proposePr(cleaned.id)).rejects.toThrow(/cleaned up/);
  });

  it("a test run without bare repositories never pushes (it would go to github.com)", { timeout: 45_000 }, async () => {
    const { make, runtime, mock, repo } = await setup({ push: false });
    mock.branches.set("me/moonrise@main", git(repo, "rev-parse", "main"));
    const engine = make();
    await engine.start();
    const task = await doneTask(engine, runtime, work({ "login.ts": "x\n" }));
    await engine.proposePr(task.id);
    await engine.confirmPr(click(prCard(engine)));
    expect(prCard(engine).payload).toMatchObject({ status: "failed", error: expect.stringMatching(/nowhere to push/) });
    expect(mock.opened).toEqual([]);
  });
});

describe("ARIA only proposes (D19, D22, D44)", () => {
  it("open_pr makes the card (a title of ARIA's, cleaned) and pushes nothing; it can't ask for a ready PR", { timeout: 45_000 }, async () => {
    const { make, runtime, mock, remoteRef } = await setup();
    const engine = make();
    await engine.start();
    const task = await doneTask(engine, runtime, work({ "login.ts": "x\n" }));
    const result = (await ariaCalls(engine, runtime, "open_pr", { task: task.id, title: "Fix the login\u202e cookie" })) as { proposed?: string; note?: string };
    expect(result.note).toMatch(/Nothing is pushed or opened until the user clicks/);
    const card = prCard(engine);
    expect(result.proposed).toBe(card.id);
    expect(card.payload).toMatchObject({ proposedBy: "aria", status: "pending", draft: true, title: "Fix the login cookie" });
    expect(remoteRef(`refs/heads/${task.branch}`)).toBeUndefined();
    expect(mock.opened).toEqual([]);
    const refused = await ariaCalls(engine, runtime, "open_pr", { task: task.id, draft: false });
    expect(JSON.stringify(refused)).toMatch(/error/i);
    // A pending card stays as it is when ARIA proposes again.
    await ariaCalls(engine, runtime, "open_pr", { task: task.id, title: "Another title" });
    expect(prCard(engine).payload).toMatchObject({ title: "Fix the login cookie", revision: card.payload.revision });
    expect(cards(engine, "pr_confirm")).toHaveLength(1);
  });

  it("a task in autopilot never opens a PR by itself (D44)", { timeout: 45_000 }, async () => {
    const { make, runtime, mock, remoteRef } = await setup();
    const engine = make();
    await engine.start();
    const task = await doneTask(engine, runtime, work({ "login.ts": "x\n" }), { mode: "autopilot" });
    expect(task.mode).toBe("autopilot");
    await new Promise((r) => setTimeout(r, 300));
    expect(cards(engine, "pr_confirm")).toHaveLength(0);
    expect(remoteRef(`refs/heads/${task.branch}`)).toBeUndefined();
    expect(mock.opened).toEqual([]);
    expect(mock.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("a worker's own git push still asks (unsandboxed) or is refused (sandboxed)", () => {
    const ask = { kind: "shell" as const, command: "git push origin aria/fix-login", segments: ["git push origin aria/fix-login"], cwd: "C:\\wt\\moonrise\\fix-login", possiblePaths: [], possibleUrls: [] };
    const ctx = { worktree: "C:\\wt\\moonrise\\fix-login", readTools: new Set<string>(), rules: DEFAULT_RULES, grants: [], defaultBranch: "main" };
    expect(decideWorker(ask, { ...ctx, sandboxed: false }).effect).toBe("ask");
    expect(decideWorker(ask, { ...ctx, sandboxed: true }).effect).toBe("never");
  });

  it("Continue on a task with a PR tells the worker to add commits, not rewrite them", { timeout: 45_000 }, async () => {
    const { make, runtime } = await setup();
    const engine = make();
    await engine.start();
    const task = await doneTask(engine, runtime, work({ "login.ts": "x\n" }));
    await engine.proposePr(task.id);
    await engine.confirmPr(click(prCard(engine)));
    runtime.workerScripts.push({ steps: [{ complete: "Handled the logout too." }] });
    await engine.messageTask(task.id, "Also handle the logout", false);
    await until(() => [...runtime.workers.values()].some((w) => w.prompts.some((p) => p.includes("Also handle the logout"))));
    const prompt = [...runtime.workers.values()].flatMap((w) => w.prompts).find((p) => p.includes("Also handle the logout"))!;
    expect(prompt.startsWith(PR_NOTE)).toBe(true);
    await until(() => taskOf(engine, task.id).state === "done", 10_000);
    // The PR stays recorded: no state of its own to undo.
    expect(taskOf(engine, task.id).pr).toMatchObject({ number: 1 });
  });
});

describe("PullRequests on its own", () => {
  const card = (status: PrCard["payload"]["status"]): PrCard => ({
    kind: "card",
    id: `pr-${status}`,
    cardType: "pr_confirm",
    createdAt: 1,
    payload: {
      taskId: "t1",
      taskTitle: "T",
      repoName: "Moonrise",
      proposedBy: "you",
      status,
      revision: 3,
      pushTo: ME,
      choices: [ME],
      openOn: ME,
      remoteBranch: "aria/t",
      tip: "a".repeat(40),
      base: "main",
      draft: true,
      title: "T",
      body: "B",
      login: "me",
      commits: 1,
      filesChanged: 1,
      additions: 1,
      deletions: 0,
      uncommitted: 0,
      subjects: [],
      paths: [],
      workflows: [],
      flagged: [],
    },
  });
  const deps = (list: PrCard[], saved: PrCard[]): PrDeps => ({
    access: undefined,
    task: () => {
      throw new Error("not used");
    },
    project: () => undefined,
    card: (id) => list.find((c) => c.id === id),
    cards: () => list,
    saveCard: (c) => {
      saved.push(c as PrCard);
      const i = list.findIndex((x) => x.id === c.id);
      if (i >= 0) list[i] = c as PrCard;
    },
    setPr: () => {},
    watchPr: async () => ({}),
    digest: () => {},
    ghPath: () => undefined,
    scratchRoot: "unused",
    log: () => {},
  });

  it("at the start, a card that was on its way when ARIA closed says so (Try again looks again first)", () => {
    const list = [card("pushing"), card("opening"), card("pending"), card("done")];
    const saved: PrCard[] = [];
    new PullRequests(deps(list, saved)).recover();
    expect(saved.map((c) => [c.id, c.payload.status, c.payload.revision])).toEqual([
      ["pr-pushing", "failed", 4],
      ["pr-opening", "failed", 4],
    ]);
    expect(saved[0]!.payload.error).toMatch(/closed while it was on its way/);
  });

  it("Dismiss: a waiting or failed card goes; one on its way can't", () => {
    const list = [card("pending"), card("failed"), card("pushing")];
    const saved: PrCard[] = [];
    const prs = new PullRequests(deps(list, saved));
    prs.dismiss("pr-pending");
    prs.dismiss("pr-failed");
    expect(() => prs.dismiss("pr-pushing")).toThrow(/on its way/);
    expect(saved.map((c) => c.payload.status)).toEqual(["dismissed", "dismissed"]);
  });
});
