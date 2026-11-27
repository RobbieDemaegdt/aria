/**
 * Phase 3, ARIA in the loop (PLAN.md §4.3, §4.5, §4.8, §5.3): permission requests and plans waiting on cards with
 * short ids, the sandbox (D20), "Approve for this task" (D21), the digest, replies straight to a task, proposals and
 * prompts. Against the scripted runtime, with real git repositories.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CardItem, ChatItem, EngineEvent, Task } from "@aria/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { AriaEngine, type EngineOptions } from "../src/engine.ts";
import { DEFAULT_RULES } from "../src/policy/defaults.ts";
import { toolchainPaths } from "../src/policy/sandbox.ts";
import { DEFAULT_BRIEF_TEMPLATE } from "../src/prompts/templates.ts";
import { FakeRuntime, type FakeWorkerStep } from "../src/runtime/fake.ts";
import { SANDBOX_FILE_RULE } from "../src/tasks/brief.ts";
import type { PermissionAsk } from "../src/runtime/types.ts";
import { commitFile, git, makeRepo, waitMs } from "./helpers.ts";

const temps: string[] = [];
const engines: AriaEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.stop()));
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function setup(options: Partial<EngineOptions> = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), "aria-attention-"));
  temps.push(base);
  const projects = path.join(base, "GitHub");
  const repo = makeRepo(projects, "Moonrise");
  commitFile(repo, "README.md", "# Moonrise\n", "Initial commit");
  const runtime = new FakeRuntime();
  const worktreeRoot = path.join(base, "wt");
  const make = () => {
    const engine = new AriaEngine({
      dataDir: path.join(base, "data"),
      runtime,
      projectRoots: [projects],
      resumeSettleMs: 10,
      worktreeRoot,
      taskSettleMs: 20,
      autopilotGraceMs: 150,
      ...options,
    });
    engines.push(engine);
    return engine;
  };
  return { base, repo, projects, runtime, worktreeRoot, make };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > waitMs(ms)) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const task = (engine: AriaEngine, id: string) => engine.getState().tasks.find((t) => t.id === id);
const stateOf = (engine: AriaEngine, id: string) => task(engine, id)?.state;
const repoId = (engine: AriaEngine) => engine.getState().projects[0]!.id;
const cards = <T extends CardItem["cardType"]>(engine: AriaEngine, type: T) =>
  engine.getState().timeline.filter((i): i is Extract<CardItem, { cardType: T }> => i.kind === "card" && i.cardType === type);
const chats = (engine: AriaEngine, role: "user" | "assistant") => engine.getState().timeline.filter((i): i is ChatItem => i.kind === "chat" && i.role === role);
const shellAsk =
  (command: string) =>
  (cwd: string): PermissionAsk => ({ kind: "shell", command, segments: command.split(/\s*;\s*/), cwd, possiblePaths: [], possibleUrls: [] });
const shellStep = (command: string, run?: () => void): FakeWorkerStep => ({ tool: "powershell", args: { command }, ask: shellAsk(command), ...(run ? { run } : {}) });
const worker = (runtime: FakeRuntime, t: Task) => runtime.workers.get(`aria-task-${t.id}`)!;
const conductorOf = (runtime: FakeRuntime) => [...runtime.sessions.values()][0]!;

/** Sends a message to ARIA and waits for its reply. */
async function chat(engine: AriaEngine, text: string): Promise<string> {
  const before = chats(engine, "assistant").length;
  await engine.sendMessage(text);
  await until(() => chats(engine, "assistant").length > before && engine.getState().status.state === "ready");
  return chats(engine, "assistant").at(-1)!.content;
}

describe("permission requests (PLAN.md §4.8, D21)", () => {
  it("asks on a card for what the policy can't decide, and Approve for this task covers the same command afterwards", async () => {
    const { make, runtime } = setup();
    runtime.sandboxSupported = false;
    let builds = 0;
    const build = shellStep("node build.js", () => void builds++);
    runtime.workerScripts.push({ steps: [build, build, build, { complete: "Built three times." }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Build it" });
    await until(() => stateOf(engine, started.id) === "waiting_permission");
    const first = task(engine, started.id)!.permissions![0]!;
    expect(task(engine, started.id)!.sandboxed).toBe(false);
    expect(first).toMatchObject({ shortId: "P-1", kind: "shell", what: "node build.js", reason: expect.stringMatching(/^Only tests, builds/), scope: "run node build.js" });
    expect(cards(engine, "task_permission")[0]!.payload).toMatchObject({ shortId: "P-1", what: "node build.js", sandboxed: false });
    expect(builds).toBe(0);

    engine.decidePermission(started.id, first.id, "once");
    await until(() => task(engine, started.id)?.permissions?.[0]?.shortId === "P-2");
    expect(builds).toBe(1);
    engine.decidePermission(started.id, task(engine, started.id)!.permissions![0]!.id, "task");
    await until(() => stateOf(engine, started.id) === "done");
    // The third build ran without asking.
    expect(builds).toBe(3);
    expect(cards(engine, "task_permission").map((c) => [c.payload.shortId, c.payload.decision])).toEqual([
      ["P-1", "once"],
      ["P-2", "task"],
    ]);
    const grant = task(engine, started.id)!.grants![0]!;
    expect(task(engine, started.id)!.grants).toHaveLength(1);
    expect(grant).toMatchObject({ id: expect.any(String), key: JSON.stringify("node build.js"), label: "node build.js" });

    // Revoked, it asks again next time.
    engine.revokeGrant(started.id, grant.id);
    expect(task(engine, started.id)!.grants).toBeUndefined();
  });

  it("tells the worker why when you reject, with your note", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [shellStep("npm install lodash"), { complete: "Did without lodash." }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Debounce" });
    await until(() => stateOf(engine, started.id) === "waiting_permission");
    const pending = task(engine, started.id)!.permissions![0]!;
    expect(pending.reason).toMatch(/Adds a package/);
    engine.decidePermission(started.id, pending.id, "reject", "write a small debounce yourself");
    await until(() => stateOf(engine, started.id) === "done");
    expect(worker(runtime, started).decisions.at(-1)).toMatchObject({ approved: false, reason: "The user said no: write a small debounce yourself" });
    expect(cards(engine, "task_permission")[0]!.payload).toMatchObject({ decision: "reject", note: "write a small debounce yourself" });
  });

  it("lets other requests for the same thing through with Approve for this task, and keeps waiting for the rest", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({
      steps: [{ parallel: [shellStep("npm install lodash"), shellStep("npm install lodash"), shellStep("npm install react")].map((s) => s as Extract<FakeWorkerStep, { tool: string }>) }, { complete: "ok" }],
    });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Two packages" });
    await until(() => task(engine, started.id)?.permissions?.length === 3);
    const [lodash, , react] = task(engine, started.id)!.permissions!;
    engine.decidePermission(started.id, lodash!.id, "task");
    expect(task(engine, started.id)!.permissions!.map((p) => p.what)).toEqual(["npm install react"]);
    expect(stateOf(engine, started.id)).toBe("waiting_permission");
    expect(cards(engine, "task_permission").map((c) => c.payload.decision ?? null)).toEqual(["task", "task", null]);
    expect(cards(engine, "task_permission")[1]!.payload.note).toBe("Covered by your approval of P-1.");
    engine.decidePermission(started.id, react!.id, "reject");
    await until(() => stateOf(engine, started.id) === "done");
    expect(worker(runtime, started).decisions.map((d) => d.approved)).toEqual([true, true, false]);
  });

  it("refuses what's never allowed without asking, and follows your rules", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [shellStep("git push origin aria/x"), shellStep("curl https://example.com"), { complete: "ok" }] });
    const engine = make();
    await engine.start();
    engine.savePolicyRules([...DEFAULT_RULES, { match: "curl", effect: "never", note: "No downloads." }]);
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Push" });
    await until(() => stateOf(engine, started.id) === "done");
    const decisions = worker(runtime, started).decisions;
    expect(decisions[0]).toMatchObject({ approved: false, reason: expect.stringMatching(/^Not allowed: a sandboxed task can't push/) });
    expect(decisions[1]).toMatchObject({ approved: false, reason: "Not allowed: `curl https://example.com` isn't allowed in tasks (No downloads.). Carry on without it." });
    expect(cards(engine, "task_permission")).toEqual([]);
  });

  it("reads the repository's git aliases, so an alias for push gets the same rules", async () => {
    const { make, runtime, repo } = setup();
    runtime.sandboxSupported = false;
    git(repo, "config", "alias.p", "push");
    runtime.workerScripts.push({ steps: [shellStep("git p origin HEAD:main"), { complete: "ok" }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Ship it" });
    await until(() => stateOf(engine, started.id) === "done");
    expect(worker(runtime, started).decisions[0]).toMatchObject({ approved: false, reason: expect.stringMatching(/^Not allowed: pushing to main, the default branch/) });
  });

  it("lists the git-<name> programs on PATH, so `git <name>` running one is refused", async () => {
    const { make, runtime, base } = setup();
    runtime.sandboxSupported = false;
    const bin = path.join(base, "bin");
    mkdirSync(bin, { recursive: true });
    // git runs a script with a #! line as `git flowx`.
    writeFileSync(path.join(bin, "git-flowx"), "#!/bin/sh\necho flowx\n");
    const saved = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${saved}`;
    try {
      runtime.workerScripts.push({ steps: [shellStep("git flowx release finish -p v1"), { complete: "ok" }] });
      const engine = make();
      await engine.start();
      const started = await engine.startTask({ repoId: repoId(engine), brief: "Finish the release" });
      await until(() => stateOf(engine, started.id) === "done");
      expect(worker(runtime, started).decisions[0]).toMatchObject({ approved: false, reason: expect.stringMatching(/^Not allowed: `git flowx` runs git-flowx/) });
    } finally {
      process.env.PATH = saved;
    }
  });

  it("reads git's push settings where a push runs, so one that sends the branch to main is refused", async () => {
    const { make, runtime, repo } = setup();
    runtime.sandboxSupported = false;
    git(repo, "config", "remote.origin.push", "HEAD:refs/heads/main");
    runtime.workerScripts.push({ steps: [shellStep("git push origin HEAD"), { complete: "ok" }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Push by config" });
    await until(() => stateOf(engine, started.id) === "done");
    expect(worker(runtime, started).decisions[0]).toMatchObject({ approved: false, reason: expect.stringMatching(/^Not allowed: git is set to push by `HEAD:refs\/heads\/main`/) });
    expect(cards(engine, "task_permission")).toEqual([]);
  });

  it("knows which branch the worktree has checked out, so a push of HEAD from the default branch is refused", async () => {
    const { make, runtime } = setup();
    runtime.sandboxSupported = false;
    // Without asking (no permission request), as a task could have done earlier with your approval.
    const toMain = { tool: "powershell", run: (cwd: string) => void git(cwd, "switch", "--ignore-other-worktrees", "main") } as FakeWorkerStep;
    runtime.workerScripts.push({ steps: [toMain, shellStep("git push origin HEAD"), { complete: "ok" }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Push HEAD" });
    await until(() => stateOf(engine, started.id) === "done");
    expect(worker(runtime, started).decisions[0]).toMatchObject({ approved: false, reason: expect.stringMatching(/^Not allowed: main, the default branch, is checked out here/) });
  });

  it("reads gh's aliases, so an alias for a merge is refused like the merge", async () => {
    const { make, runtime, base } = setup();
    const config = path.join(base, "gh");
    mkdirSync(config, { recursive: true });
    writeFileSync(path.join(config, "config.yml"), "version: 1\naliases:\n    co: pr checkout\n    pr finish: pr merge\n");
    const saved = process.env.GH_CONFIG_DIR;
    process.env.GH_CONFIG_DIR = config;
    try {
      runtime.workerScripts.push({ steps: [shellStep("gh pr finish 3"), { complete: "ok" }] });
      const engine = make();
      await engine.start();
      const started = await engine.startTask({ repoId: repoId(engine), brief: "Finish it" });
      await until(() => stateOf(engine, started.id) === "done");
      expect(worker(runtime, started).decisions[0]).toMatchObject({ approved: false, reason: expect.stringMatching(/^Not allowed: merging pull requests/) });
    } finally {
      if (saved === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = saved;
    }
  });

  it("checks your rules when you save them", async () => {
    const { make } = setup();
    const engine = make();
    await engine.start();
    expect(engine.getState().policy.rules).toEqual(DEFAULT_RULES);
    // D26: npx runs what it's given, so an Auto rule for it has to be exact.
    expect(() => engine.savePolicyRules([{ match: "npx vitest", effect: "auto" }])).toThrow(/Only exactly this/);
    const saved = engine.savePolicyRules([{ match: "  npx   vitest ", effect: "auto", exact: true }]);
    expect(saved.rules).toEqual([{ id: expect.any(String), match: "npx vitest", effect: "auto", exact: true }]);
    expect(() => engine.savePolicyRules([{ match: "<package>", effect: "ask" }])).toThrow(/doesn't start with a command/);
    expect(() => engine.savePolicyRules([{ match: "curl", effect: "ask" }, { match: "CURL", effect: "never" }])).toThrow(/two rules/);
    expect(engine.resetPolicyRules().rules).toEqual(DEFAULT_RULES);
  });

  it("stops waiting when the task is cancelled, paused at its budget, or ARIA shuts down", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [shellStep("npm install a"), { complete: "never" }] });
    runtime.workerScripts.push({ steps: [shellStep("npm install b"), { wait: 3000 }, { complete: "never" }] });
    runtime.workerScripts.push({ steps: [shellStep("npm install c"), { complete: "never" }] });
    const engine = make();
    await engine.start();
    const preset = engine.getState().profiles.find((p) => p.isDefault)!;
    await engine.saveProfile({ id: preset.id, name: preset.name, model: preset.model, reasoningEffort: preset.reasoningEffort!, mode: "autopilot", budgetCredits: 1 });

    const cancelled = await engine.startTask({ repoId: repoId(engine), brief: "One" });
    await until(() => stateOf(engine, cancelled.id) === "waiting_permission");
    const events: EngineEvent[] = [];
    engine.onEvent((e) => events.push(e));
    await engine.cancelTask(cancelled.id);
    expect(task(engine, cancelled.id)).toMatchObject({ state: "cancelled" });
    expect(task(engine, cancelled.id)!.permissions).toBeUndefined();
    // The window hears the same: the cancelled task has nothing left to approve.
    const last = events.filter((e): e is Extract<EngineEvent, { type: "task" }> => e.type === "task" && e.task.id === cancelled.id).at(-1)!;
    expect(last.task).toMatchObject({ state: "cancelled" });
    expect(last.task.permissions).toBeUndefined();
    await until(() => worker(runtime, cancelled).decisions.length === 1);
    expect(worker(runtime, cancelled).decisions[0]).toMatchObject({ approved: false, reason: expect.stringMatching(/cancelled/) });

    const paused = await engine.startTask({ repoId: repoId(engine), brief: "Two" });
    await until(() => stateOf(engine, paused.id) === "waiting_permission");
    worker(runtime, paused).inject({ type: "usage", nanoAiu: 1.5e9 });
    await until(() => stateOf(engine, paused.id) === "waiting_budget");
    expect(task(engine, paused.id)).toMatchObject({ budgetShortId: "B-1" });
    expect(task(engine, paused.id)!.permissions).toBeUndefined();
    expect(worker(runtime, paused).decisions[0]).toMatchObject({ approved: false, reason: expect.stringMatching(/budget/) });

    const third = await engine.startTask({ repoId: repoId(engine), brief: "Three" });
    await until(() => stateOf(engine, third.id) === "waiting_permission");
    await engine.stop();
    await until(() => worker(runtime, third).decisions.length === 1);
    expect(worker(runtime, third).decisions[0]).toMatchObject({ approved: false, unavailable: true });
  });

  it("gives a stopped task nothing more, also nothing that would run on its own, while its abort is on the way", async () => {
    const { make, runtime } = setup();
    let tests = 0;
    runtime.workerScripts.push({ steps: [shellStep("npm install lodash"), shellStep("npm test", () => void tests++), { complete: "never" }] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    runtime.workerAbortGate = () => gate;
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Add lodash" });
    await until(() => stateOf(engine, started.id) === "waiting_permission");
    const cancelling = engine.cancelTask(started.id);
    await until(() => worker(runtime, started).decisions.length === 2);
    expect(worker(runtime, started).decisions.map((d) => d.approved)).toEqual([false, false]);
    expect(tests).toBe(0);
    release();
    await cancelling;
    expect(stateOf(engine, started.id)).toBe("cancelled");
  });
});

describe("plans", () => {
  const planSteps: FakeWorkerStep[] = [{ plan: "1. Add the toggle\n2. Test it", summary: "Add a dark mode toggle" }, { message: "Building it." }, { complete: "Added the toggle." }];

  it("waits for your approval of a plan, then carries it out in the mode you pick", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: planSteps });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Dark mode", mode: "plan" });
    await until(() => stateOf(engine, started.id) === "waiting_plan");
    expect(runtime.lastWorkerConfig!.mode).toBe("plan");
    const plan = task(engine, started.id)!.plan!;
    expect(plan).toMatchObject({ shortId: "L-1", summary: "Add a dark mode toggle", plan: "1. Add the toggle\n2. Test it" });
    expect(cards(engine, "task_plan")[0]!.payload).toMatchObject({ shortId: "L-1", summary: "Add a dark mode toggle" });
    await expect(engine.reviewPlan(started.id, plan.id, "revise", "  ")).rejects.toThrow(/what to change/);
    await engine.reviewPlan(started.id, plan.id, "autopilot");
    await until(() => stateOf(engine, started.id) === "done");
    expect(task(engine, started.id)).toMatchObject({ mode: "autopilot", summary: "Added the toggle." });
    expect(worker(runtime, started).planDecisions).toEqual([{ approved: true, mode: "autopilot" }]);
    expect(cards(engine, "task_plan")[0]!.payload.decision).toBe("autopilot");
  });

  it("sends your feedback for a revision, and cancels the task when you cancel at the plan", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [planSteps[0]!, { message: "Revised." }] });
    runtime.workerScripts.push({ steps: [planSteps[0]!, { complete: "never" }] });
    const engine = make();
    await engine.start();
    const revised = await engine.startTask({ repoId: repoId(engine), brief: "Revise me", mode: "plan" });
    await until(() => stateOf(engine, revised.id) === "waiting_plan");
    await engine.reviewPlan(revised.id, task(engine, revised.id)!.plan!.id, "revise", "Put it in the header");
    await until(() => stateOf(engine, revised.id) === "done");
    expect(worker(runtime, revised).planDecisions).toEqual([{ approved: false, feedback: "Put it in the header" }]);
    expect(task(engine, revised.id)!.mode).toBe("plan");

    const cancelled = await engine.startTask({ repoId: repoId(engine), brief: "Cancel me", mode: "plan" });
    await until(() => stateOf(engine, cancelled.id) === "waiting_plan");
    expect(task(engine, cancelled.id)!.plan!.shortId).toBe("L-2");
    await engine.reviewPlan(cancelled.id, task(engine, cancelled.id)!.plan!.id, "cancel");
    expect(task(engine, cancelled.id)).toMatchObject({ state: "cancelled" });
    expect(task(engine, cancelled.id)!.plan).toBeUndefined();
  });
});

describe("the digest and replies (PLAN.md §4.3, §4.5)", () => {
  it("tells ARIA what happened and what waits, once, and lets it answer by the question's id", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [{ question: "JWT or cookies?", choices: ["JWT", "Cookies"] }, { complete: "Used cookies." }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), title: "Login", brief: "Fix login" });
    await until(() => stateOf(engine, started.id) === "waiting_input");
    expect(task(engine, started.id)!.question!.shortId).toBe("Q-1");

    runtime.replies.push({ toolCalls: [{ name: "answer_question", args: (prompt: string) => ({ task: /- (Q-\d+):/.exec(prompt)![1], answer: "cookies" }) }], text: "Answered Q-1." });
    await chat(engine, "Use cookies for that one");
    const prompt = conductorOf(runtime).prompts.at(-1)!;
    expect(prompt).toContain("<updates since your last message>\n- You started \"Login\" (Moonrise) yourself, with the Default profile.\n</updates>");
    expect(prompt).toContain('<pending>\n- Q-1: "Login" (Moonrise) asks: "JWT or cookies?" Choices: JWT, Cookies.\n</pending>');
    expect(prompt.endsWith("\n\nUse cookies for that one")).toBe(true);
    // The chat shows only your words; the digest stays with the message for the inspector.
    expect(chats(engine, "user").at(-1)).toMatchObject({ content: "Use cookies for that one", digest: expect.stringContaining("<pending>") });
    await until(() => stateOf(engine, started.id) === "done");
    // A choice keeps its own spelling.
    expect(cards(engine, "task_question")[0]!.payload.answer).toBe("Cookies");

    await chat(engine, "thanks");
    const next = conductorOf(runtime).prompts.at(-1)!;
    expect(next).not.toContain("You started");
    expect(next).toContain('[done] "Login" (Moonrise): No commits. Its summary: Used cookies.');
    expect(next).not.toContain("<pending>");
    await chat(engine, "and now?");
    expect(conductorOf(runtime).prompts.at(-1)).toBe("and now?");
  });

  it("only approves through ARIA when your own message names the item", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [shellStep("npm install lodash"), { complete: "ok" }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Add lodash" });
    await until(() => stateOf(engine, started.id) === "waiting_permission");
    const approve = { toolCalls: [{ name: "decide_permission", args: { id: "P-1", decision: "approve" } }], text: (_p: string, results: unknown[]) => JSON.stringify(results) };

    runtime.replies.push(approve);
    expect(await chat(engine, "yes, go ahead")).toMatch(/Not done: to approve P-1, the user has to name it/);
    expect(stateOf(engine, started.id)).toBe("waiting_permission");
    runtime.replies.push(approve);
    expect(await chat(engine, "ok, approve p1")).toContain('"decided":"approve"');
    await until(() => stateOf(engine, started.id) === "done");
    expect(worker(runtime, started).decisions[0]).toMatchObject({ approved: true });
  });

  it("says so when your message to a task can't decide what it waits for", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [shellStep("npm install lodash"), { complete: "ok" }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Add lodash" });
    await until(() => stateOf(engine, started.id) === "waiting_permission");
    await engine.sendMessage(`@${task(engine, started.id)!.slug} yes`);
    expect(chats(engine, "user").at(-1)!.routedTo).toMatchObject({ action: "message", note: "This doesn't decide P-1: use the buttons on its card.", noteTone: "warning" });
    expect(stateOf(engine, started.id)).toBe("waiting_permission");
    expect(worker(runtime, started).decisions).toEqual([]);
  });

  it("checks ARIA's approvals against your newest message, also one that went straight to a task", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [shellStep("npm install lodash"), { complete: "ok" }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Add lodash" });
    await until(() => stateOf(engine, started.id) === "waiting_permission");
    const slug = task(engine, started.id)!.slug;
    runtime.replies.push({
      toolCalls: [
        {
          name: "decide_permission",
          // While ARIA works on "approve P-1", you tell the task "no" directly.
          args: () => {
            void engine.sendMessage(`@${slug} no, don't add it`);
            return { id: "P-1", decision: "approve" };
          },
        },
      ],
      text: (_p: string, results: unknown[]) => JSON.stringify(results),
    });
    expect(await chat(engine, "approve P-1")).toMatch(/Not done: to approve P-1, the user has to name it/);
    expect(stateOf(engine, started.id)).toBe("waiting_permission");
  });

  it("keeps your newest words as the newest, also when an older message to ARIA was still waiting to go out", async () => {
    const { make, runtime } = setup();
    runtime.workerScriptFor = (prompt) =>
      prompt.includes("Add lodash") ? { steps: [shellStep("npm install lodash"), { complete: "ok" }] } : prompt.includes("Name it") ? { steps: [{ question: "What name?" }, { complete: "ok" }] } : undefined;
    const engine = make();
    await engine.start();
    const lodash = await engine.startTask({ repoId: repoId(engine), brief: "Add lodash" });
    const naming = await engine.startTask({ repoId: repoId(engine), brief: "Name it" });
    await until(() => stateOf(engine, lodash.id) === "waiting_permission" && stateOf(engine, naming.id) === "waiting_input");
    // An edited prompt makes the next message wait for the conversation to reopen.
    engine.savePrompt("conductor", "You are ARIA. Projects: {{projectRoots}}.");
    let release!: () => void;
    runtime.conductorOpenGate = new Promise<void>((resolve) => (release = resolve));
    runtime.replies.push({ toolCalls: [{ name: "decide_permission", args: { id: "P-1", decision: "approve" } }], text: (_p: string, results: unknown[]) => JSON.stringify(results) });
    const before = chats(engine, "assistant").length;
    const sending = engine.sendMessage("Tell me about P-1");
    await until(() => runtime.conductorOpens === 2);
    // Meanwhile you answer the other task's question on its card.
    engine.answerQuestion(naming.id, task(engine, naming.id)!.question!.id, "No", true);
    release();
    await sending;
    await until(() => chats(engine, "assistant").length > before);
    expect(chats(engine, "assistant").at(-1)!.content).toMatch(/Not done: to approve P-1/);
    expect(stateOf(engine, lodash.id)).toBe("waiting_permission");
  });

  it("names tasks uniquely across repositories, and asks which one an @mention means when two go by it", async () => {
    const { make, runtime, projects } = setup({ maxConcurrentTasks: 2 });
    const beacon = makeRepo(projects, "Beacon");
    commitFile(beacon, "README.md", "# Beacon\n", "Initial commit");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    runtime.workerScriptFor = (prompt) => (prompt.includes("Hold") ? { steps: [{ gate }, { complete: "ok" }] } : undefined);
    const engine = make();
    await engine.start();
    const [first, second] = engine.getState().projects;
    const a = await engine.startTask({ repoId: first!.id, title: "Fix login", brief: "Hold one" });
    const b = await engine.startTask({ repoId: second!.id, title: "Fix login", brief: "Hold two" });
    await until(() => stateOf(engine, a.id) === "running" && stateOf(engine, b.id) === "running");
    expect([task(engine, a.id)!.slug, task(engine, b.id)!.slug].sort()).toEqual(["fix-login", "fix-login-2"]);
    // One that hasn't started yet goes by its title, which another one's branch already uses.
    const c = await engine.startTask({ repoId: first!.id, title: "Fix login", brief: "Hold three" });
    expect(task(engine, c.id)).toMatchObject({ state: "queued", slug: "fix-login" });
    await expect(engine.sendMessage("@fix-login use cookies")).rejects.toThrow(/More than one task goes by @fix-login/);
    release();
  });

  it("answers two questions at once from the one chat: a reply and an @mention go straight to their task", async () => {
    const { make, runtime } = setup();
    runtime.workerScriptFor = (prompt) =>
      prompt.includes("Header task")
        ? { steps: [{ question: "Header or footer?", choices: ["Header", "Footer"], allowFreeform: false }, { complete: "Put it in the header." }] }
        : prompt.includes("Name task")
          ? { steps: [{ question: "What should it be called?" }, { complete: "Named it." }] }
          : undefined;
    const engine = make();
    await engine.start();
    const header = await engine.startTask({ repoId: repoId(engine), title: "Theme toggle", brief: "Header task" });
    const name = await engine.startTask({ repoId: repoId(engine), title: "New service", brief: "Name task" });
    await until(() => stateOf(engine, header.id) === "waiting_input" && stateOf(engine, name.id) === "waiting_input");
    const q1 = task(engine, header.id)!.question!;
    const q2 = task(engine, name.id)!.question!;
    expect([q1.shortId, q2.shortId].sort()).toEqual(["Q-1", "Q-2"]);
    const sentToAria = conductorOf(runtime).prompts.length;

    // A reply that isn't one of the choices is refused, and nothing shows in the chat.
    await expect(engine.reply({ taskId: header.id, item: { kind: "question", id: q1.id }, text: "sidebar" })).rejects.toThrow(/Pick one of: Header, Footer/);
    await engine.reply({ taskId: header.id, item: { kind: "question", id: q1.id }, text: "header" });
    await engine.sendMessage(`@${task(engine, name.id)!.slug} Call it Beacon`);
    await until(() => stateOf(engine, header.id) === "done" && stateOf(engine, name.id) === "done");
    expect(worker(runtime, header).transcript.size).toBeGreaterThan(0);
    expect(cards(engine, "task_question").find((c) => c.payload.taskId === header.id)!.payload.answer).toBe("Header");
    expect(cards(engine, "task_question").find((c) => c.payload.taskId === name.id)!.payload.answer).toBe("Call it Beacon");
    expect(chats(engine, "user").map((c) => [c.content, c.routedTo?.title, c.routedTo?.shortId, c.routedTo?.action])).toEqual([
      ["header", "Theme toggle", q1.shortId, "answer"],
      ["Call it Beacon", "New service", q2.shortId, "answer"],
    ]);
    // ARIA wasn't asked, but hears about both in its next digest.
    expect(conductorOf(runtime).prompts.length).toBe(sentToAria);
    await chat(engine, "status?");
    const digest = conductorOf(runtime).prompts.at(-1)!;
    expect(digest).toContain(`You answered ${q1.shortId} from "Theme toggle" directly: "Header"`);
    expect(digest).toContain(`You answered ${q2.shortId} from "New service" directly: "Call it Beacon"`);

    // A reply to a finished task continues it; a reply can't approve anything.
    await engine.reply({ taskId: header.id, text: "Also add a tooltip" });
    expect(chats(engine, "user").at(-1)!.routedTo).toMatchObject({ action: "message", note: "It continues in its session with this." });
    await expect(engine.reply({ taskId: header.id, item: { kind: "permission", id: "x" }, text: "yes" })).rejects.toThrow(/Use the card's buttons/);
  });
});

describe("profile proposals (§4.12 policy 3)", () => {
  it("proposes a task on a card and starts nothing until you press Start, with the profile you pick", async () => {
    const { make, runtime } = setup();
    const engine = make();
    await engine.start();
    await engine.setProfilePolicy("ask");
    const proposal = { toolCalls: [{ name: "start_task", args: { repo: "Moonrise", title: "Add docs", brief: "Write the docs.", profile: "Deep", reason: "Docs need care." } }], text: "Proposed." };
    runtime.replies.push(proposal, proposal);
    await chat(engine, "add docs to moonrise");
    await chat(engine, "and another one");
    expect(engine.getState().tasks).toEqual([]);
    const [card, other] = cards(engine, "profile_proposal");
    expect(card!.payload).toMatchObject({ title: "Add docs", repoName: "Moonrise", profileName: "Deep", model: "fake-strong", reason: "Docs need care." });
    const quick = engine.getState().profiles.find((p) => p.name === "Quick")!;
    runtime.workerScripts.push({ steps: [{ complete: "Wrote the docs." }] });
    const started = await engine.startProposal(card!.id, quick.id);
    expect(started).toMatchObject({ title: "Add docs", profileName: "Quick", profileNote: "You picked Quick." });
    expect(cards(engine, "profile_proposal")[0]!.payload).toMatchObject({ decision: "started", taskId: started.id, profileName: "Quick" });
    await expect(engine.startProposal(card!.id)).rejects.toThrow(/already started/);
    engine.dismissProposal(other!.id);
    expect(cards(engine, "profile_proposal")[1]!.payload.decision).toBe("dismissed");
    await expect(engine.startProposal(other!.id)).rejects.toThrow(/dismissed/);
    await until(() => stateOf(engine, started.id) === "done");
  });
});

describe("prompts (Customize › Prompts)", () => {
  it("uses an edited brief template for the next task, checks it, and keeps every version", async () => {
    const { make, runtime } = setup();
    const engine = make();
    await engine.start();
    expect(() => engine.savePrompt("brief", "Just do it.")).toThrow(/has to contain \{\{brief\}\}/);
    expect(() => engine.savePrompt("brief", "{{brief}} {{nope}}")).toThrow(/no placeholder called \{\{nope\}\}/);
    const saved = engine.savePrompt("brief", "Do this: {{brief}}\nOn {{branch}}.\n\n{{profileInstructions}}\n\n{{environment}}", "Shorter");
    expect(saved).toMatchObject({ name: "brief", version: 1 });
    runtime.workerScripts.push({ steps: [{ complete: "ok" }] });
    const started = await engine.startTask({ repoId: repoId(engine), title: "Short", brief: "Add a test." });
    await until(() => stateOf(engine, started.id) === "done");
    expect(worker(runtime, started).prompts[0]).toBe(
      `Do this: Add a test.\nOn aria/short.\n\n- You work in a sandbox: only this worktree can be changed, and the network only reaches package registries (so there's no GitHub access, and you can't push).\n- Shell commands may run in Windows PowerShell 5.1: avoid PowerShell 7-only syntax such as \`&&\`, \`||\`, \`? :\` and \`??\`.\n${SANDBOX_FILE_RULE}`,
    );

    expect(engine.resetPrompt("brief")).toMatchObject({ version: 2, text: DEFAULT_BRIEF_TEMPLATE });
    expect(engine.rollbackPrompt("brief", 1)).toMatchObject({ version: 3, text: saved.text });
    expect(engine.promptHistory("brief").map((v) => [v.version, v.note])).toEqual([
      [3, "Back to version 1"],
      [2, "Back to the built-in text"],
      [1, "Shorter"],
    ]);
    // Saving the same text again adds nothing.
    expect(engine.savePrompt("brief", saved.text).version).toBe(3);
  });

  it("reopens ARIA's conversation with an edited system prompt before your next message", async () => {
    const { make, runtime, projects } = setup();
    const engine = make();
    await engine.start();
    const session = conductorOf(runtime);
    expect(session.config.systemPrompt).toContain(`Projects live under: ${projects}.`);
    engine.savePrompt("conductor", "You are ARIA. Projects: {{projectRoots}}. Be brief.");
    await chat(engine, "hi");
    const reopened = conductorOf(runtime);
    expect(reopened.config.sessionId).toBe(session.config.sessionId);
    expect(reopened.config.systemPrompt).toBe(`You are ARIA. Projects: ${projects}. Be brief.`);
    expect(reopened.prompts.at(-1)).toBe("hi");
  });

  it("reopens ARIA's conversation only once the old one has let go of it, so a late detach can't close the new one", async () => {
    const { make, runtime } = setup({ shutdownWaitMs: 30 });
    const engine = make();
    await engine.start();
    let release!: () => void;
    runtime.conductorDisconnectGate = new Promise<void>((resolve) => (release = resolve));
    engine.savePrompt("conductor", "You are ARIA. Projects: {{projectRoots}}. Be brief.");
    await expect(engine.sendMessage("hi")).rejects.toThrow(/still closing its conversation/);
    expect(engine.getState().status.state).toBe("starting");
    expect(runtime.conductorOpens).toBe(1);
    release();
    await until(() => engine.getState().status.state === "ready");
    expect(runtime.conductorOpens).toBe(2);
    expect(conductorOf(runtime).config.systemPrompt).toContain("Be brief.");
    runtime.conductorDisconnectGate = undefined;
    expect(await chat(engine, "hi")).toBe("echo: hi");
  });

  it("doesn't reopen ARIA's conversation for a model change while the old one is still closing; the reopen uses it", async () => {
    const { make, runtime } = setup({ shutdownWaitMs: 30 });
    const engine = make();
    await engine.start();
    let release!: () => void;
    runtime.conductorDisconnectGate = new Promise<void>((resolve) => (release = resolve));
    engine.savePrompt("conductor", "You are ARIA. Projects: {{projectRoots}}. Be brief.");
    await expect(engine.sendMessage("hi")).rejects.toThrow(/still closing its conversation/);
    await engine.setConductorModel({ model: "fake-strong", reasoningEffort: "high" });
    expect(runtime.conductorOpens).toBe(1);
    release();
    await until(() => engine.getState().status.state === "ready");
    expect(runtime.conductorOpens).toBe(2);
    expect(conductorOf(runtime).config).toMatchObject({ model: "fake-strong", reasoningEffort: "high" });
  });

  it("keeps the versions of a profile's instructions, also when they're changed with the profile", async () => {
    const { make } = setup();
    const engine = make();
    await engine.start();
    const preset = engine.getState().profiles.find((p) => p.isDefault)!;
    await engine.saveProfile({ id: preset.id, name: preset.name, model: preset.model, reasoningEffort: preset.reasoningEffort!, mode: "autopilot", instructions: "Use pnpm." });
    const name = `profile:${preset.id}`;
    expect(engine.listPrompts().find((p) => p.name === name)).toMatchObject({ label: "Profile: Default", text: "Use pnpm.", version: 1 });
    engine.savePrompt(name, "Use pnpm. Run the linter.");
    expect(engine.getState().profiles.find((p) => p.id === preset.id)!.instructions).toBe("Use pnpm. Run the linter.");
    expect(engine.promptHistory(name).map((v) => v.text)).toEqual(["Use pnpm. Run the linter.", "Use pnpm."]);
  });
});

describe("the sandbox (D20)", () => {
  it("runs tasks with only their worktree, the git parts a commit needs and ARIA's caches writable", async () => {
    const { make, runtime, repo, worktreeRoot } = setup();
    runtime.workerScripts.push({ steps: [{ complete: "ok" }] });
    const engine = make();
    await engine.start();
    expect(runtime.startOptions).toEqual({ tempDir: path.join(worktreeRoot, ".aria", "tmp") });
    expect(engine.getState().policy.sandbox).toMatchObject({ supported: true, enabled: true });
    const started = await engine.startTask({ repoId: repoId(engine), title: "Boxed", brief: "Inside the box." });
    await until(() => stateOf(engine, started.id) === "done");
    const worktree = task(engine, started.id)!.worktreePath!;
    // As git names it: the long name, also when TEMP is a short 8.3 one (GitHub's runners).
    const common = realpathSync.native(path.join(repo, ".git"));
    const sandbox = runtime.lastWorkerConfig!.sandbox!;
    expect(sandbox.readwrite).toEqual([
      worktree,
      path.join(common, "objects"),
      path.join(common, "worktrees", "boxed"),
      path.join(common, "refs", "heads", "aria"),
      path.join(common, "logs", "refs", "heads", "aria"),
      path.join(worktreeRoot, ".aria", "cache"),
      path.join(os.homedir(), ".copilot", "session-state", `aria-task-${started.id}`),
    ]);
    expect(sandbox.readonly).toEqual(
      expect.arrayContaining([
        common,
        path.join(common, "worktrees", "boxed", "commondir"),
        path.join(common, "worktrees", "boxed", "gitdir"),
        path.join(common, "worktrees", "boxed", "config.worktree"),
        path.join(worktree, ".git"),
        ...toolchainPaths(),
      ]),
    );
    // Worktree config is read with extensions.worktreeConfig: there's a file for the read-only rule to hold.
    expect(existsSync(path.join(common, "worktrees", "boxed", "config.worktree"))).toBe(true);
    expect(sandbox.readonly).not.toContain(os.homedir());
    expect(sandbox.allowedHosts).toContain("registry.npmjs.org");
    expect(sandbox.blockedHosts).toEqual(["localhost", "127.0.0.1", "::1"]);
    const init = readFileSync(sandbox.initScript, "utf8");
    expect(init).toContain(`$env:npm_config_cache = '${path.join(worktreeRoot, ".aria", "cache", "npm")}'`);
    expect(init).toContain(`$env:DOTNET_CLI_HOME = '${path.join(worktreeRoot, ".aria", "cache", "dotnet")}'`);
    expect(init).toContain(`$env:CARGO_HOME = '${path.join(worktreeRoot, ".aria", "cache", "cargo")}'`);
    // R1: Windows PowerShell 5.1 reads files and command output as UTF-8 (encoding-r1.test.ts runs it).
    expect(init).toContain("$global:PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'");
    expect(task(engine, started.id)!.sandboxed).toBe(true);
    expect(worker(runtime, started).prompts[0]).toContain("You work in a sandbox");
  });

  it("grants the toolchains on PATH read-only, with the install folder above a bin folder, and nothing as wide as a drive or the profile", () => {
    const { base } = setup();
    const bin = path.join(base, "tools", "node", "bin");
    const scripts = path.join(base, "tools", "py", "Scripts");
    for (const dir of [bin, scripts]) mkdirSync(dir, { recursive: true });
    const drive = path.parse(base).root;
    const found = toolchainPaths({ PATH: [bin, `"${scripts}"`, drive, os.homedir(), "relative\\bin", path.join(base, "missing")].join(path.delimiter), JAVA_HOME: path.join(base, "tools") });
    expect(found).toEqual([bin, path.join(base, "tools", "node"), scripts, path.join(base, "tools", "py"), path.join(base, "tools"), ...(existsSync(path.join(os.homedir(), ".rustup")) ? [path.join(os.homedir(), ".rustup")] : [])]);
  });

  it("runs without it when the PC can't, or you turned it off, and says so", async () => {
    const { make, runtime } = setup();
    runtime.sandboxSupported = false;
    runtime.workerScripts.push({ steps: [{ complete: "ok" }] }, { steps: [{ complete: "ok" }] });
    const engine = make();
    await engine.start();
    expect(engine.getState().policy.sandbox).toMatchObject({ supported: false, reason: "fake: this PC has no sandbox" });
    const unsupported = await engine.startTask({ repoId: repoId(engine), brief: "No box" });
    await until(() => stateOf(engine, unsupported.id) === "done");
    expect(runtime.lastWorkerConfig!.sandbox).toBeUndefined();
    expect(task(engine, unsupported.id)!.sandboxed).toBe(false);
    expect(worker(runtime, unsupported).prompts[0]).toContain("wait for the user's approval");

    runtime.sandboxSupported = true;
    const engine2 = make();
    await engine.stop();
    await engine2.start();
    engine2.setSandbox({ enabled: false });
    const off = await engine2.startTask({ repoId: repoId(engine2), brief: "Turned off" });
    await until(() => stateOf(engine2, off.id) === "done");
    expect(runtime.lastWorkerConfig!.sandbox).toBeUndefined();
    expect(engine2.getState().policy.sandbox).toMatchObject({ supported: true, enabled: false });
  });
});
