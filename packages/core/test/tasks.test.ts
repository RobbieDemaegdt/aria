import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CardItem, EngineEvent } from "@aria/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { AriaEngine } from "../src/engine.ts";
import { FakeRuntime, type FakeWorkerStep } from "../src/runtime/fake.ts";
import { commitFile, git, makeRepo, waitMs } from "./helpers.ts";

const temps: string[] = [];
const engines: AriaEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.stop()));
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function setup(options: { maxConcurrentTasks?: number; runtimeCheckMs?: number } = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), "aria-tasks-"));
  temps.push(base);
  const projects = path.join(base, "GitHub");
  const repo = makeRepo(projects, "Garden Castle Defense");
  commitFile(repo, "README.md", "# Tower\n", "Initial commit");
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
  return { repo, runtime, worktreeRoot, make };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > waitMs(ms)) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function record(engine: AriaEngine) {
  const events: EngineEvent[] = [];
  engine.onEvent((e) => events.push(e));
  return events;
}

const cards = <T extends CardItem["cardType"]>(engine: AriaEngine, type: T) =>
  engine.getState().timeline.filter((i): i is Extract<CardItem, { cardType: T }> => i.kind === "card" && i.cardType === type);
const only = (engine: AriaEngine) => engine.getState().tasks[0]!;

/** What a real worker does for a small change: write a file and commit it, each step through the worker policy. */
function addFile(file: string, content: string): FakeWorkerStep[] {
  const commit = `git add -A; git commit -m 'Add ${file}'`;
  return [
    { intent: `Adding ${file}` },
    { tool: "create", args: { path: file }, ask: (cwd) => ({ kind: "write", path: path.join(cwd, file) }), run: (cwd) => writeFileSync(path.join(cwd, file), content) },
    {
      tool: "powershell",
      args: { command: commit },
      ask: (cwd) => ({ kind: "shell", command: commit, segments: ["git add -A", `git commit -m 'Add ${file}'`], cwd, possiblePaths: [], possibleUrls: [] }),
      run: (cwd) => {
        git(cwd, "add", "-A");
        git(cwd, "commit", "-q", "-m", `Add ${file}`);
      },
    },
    { message: `Added ${file}.` },
    { complete: `Added ${file} and committed it.` },
  ];
}

describe("background tasks", () => {
  it("starts a task from the chat in its own worktree and branch, and reports a Done card with the changes", async () => {
    const { make, runtime, repo, worktreeRoot } = setup();
    runtime.replies.push({ toolCalls: [{ name: "start_task", args: { repo: "castle defense", title: "Add notes", brief: "Add a NOTES.md with build notes." } }], text: "Started Add notes." });
    runtime.workerScripts.push({
      steps: [
        ...addFile("NOTES.md", "build notes\n").slice(0, 3),
        // A push isn't allowed in a sandboxed task (D20): refused with feedback, and the task carries on.
        { tool: "powershell", args: { command: "git push" }, ask: (cwd) => ({ kind: "shell", command: "git push", segments: ["git push"], cwd, possiblePaths: [], possibleUrls: [] }) },
        ...addFile("NOTES.md", "").slice(3),
      ],
    });
    const engine = make();
    await engine.start();
    const events = record(engine);
    // You are away, so it toasts (D25).
    engine.setPresence(false);
    await engine.sendMessage("Add build notes to the castle defense game");
    await until(() => only(engine)?.state === "done");

    const task = only(engine);
    expect(task).toMatchObject({
      title: "Add notes",
      repoName: "Garden Castle Defense",
      profileName: "Default",
      model: "fake-light",
      reasoningEffort: "medium",
      startedBy: "aria",
      branch: "aria/add-notes",
      commits: 1,
      filesChanged: 1,
      additions: 1,
      uncommitted: 0,
      summary: "Added NOTES.md and committed it.",
    });
    expect(task.worktreePath).toBe(path.join(worktreeRoot, "garden-castle-defense", "add-notes"));
    // The commit is on the task's branch; your own checkout isn't touched.
    expect(git(repo, "log", "-1", "--format=%s", "aria/add-notes")).toBe("Add NOTES.md");
    expect(git(repo, "branch", "--show-current")).toBe("main");
    expect(existsSync(path.join(repo, "NOTES.md"))).toBe(false);

    expect(cards(engine, "task")).toHaveLength(1);
    expect(cards(engine, "task_done")[0]!.payload).toMatchObject({ taskId: task.id, commits: 1, filesChanged: 1, summary: "Added NOTES.md and committed it." });
    expect(events).toContainEqual(expect.objectContaining({ type: "toast", priority: "milestone", title: "Add notes is done", taskId: task.id, cardId: cards(engine, "task_done")[0]!.id, silent: true }));

    const worker = runtime.workers.get(`aria-task-${task.id}`)!;
    expect(worker.prompts[0]).toContain("Add a NOTES.md with build notes.");
    expect(worker.prompts[0]).toContain("branch aria/add-notes");
    expect(worker.config.availableTools).toContain("builtin:edit");
    // The runtime only adds these for autopilot, a question handler and plan mode; an allowlist without them removes them.
    expect(worker.config.availableTools).toEqual(expect.arrayContaining(["builtin:task_complete", "builtin:ask_user", "builtin:exit_plan_mode"]));
    expect(worker.config.availableTools).not.toContain("builtin:web_fetch");
    expect(worker.config.disabledMcpServers).toEqual(["Svc"]);
    expect(worker.decisions.map((d) => d.approved)).toEqual([true, true, false]);

    const transcript = await engine.getTranscript(task.id);
    expect(transcript.map((e) => e.kind)).toEqual(["user", "tool", "tool", "tool", "assistant"]);
    expect(transcript[3]).toMatchObject({ kind: "tool", success: false, error: expect.stringMatching(/^Not allowed: a sandboxed task can't push .*ARIA pushes the branch/) });
    expect((await engine.getTaskDiff(task.id)).text).toContain("+build notes");
  });

  it("runs at most N tasks at once and starts the next when a slot frees up", async () => {
    const { make, runtime } = setup({ maxConcurrentTasks: 1 });
    let release!: () => void;
    runtime.workerScripts.push({ steps: [{ gate: new Promise<void>((r) => (release = r)) }, { complete: "first" }] }, { steps: [{ complete: "second" }] });
    const engine = make();
    await engine.start();
    const project = engine.getState().projects[0]!;
    const first = await engine.startTask({ repoId: project.id, brief: "First task" });
    const second = await engine.startTask({ repoId: project.id, brief: "Second task" });
    const state = (id: string) => engine.getState().tasks.find((t) => t.id === id)!.state;
    await until(() => state(first.id) === "running");
    expect(state(second.id)).toBe("queued");
    release();
    await until(() => state(first.id) === "done" && state(second.id) === "done");
    expect(only(engine).startedBy).toBe("you");
  });

  it("shows a worker's question and continues with your answer (D17)", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [{ question: "Settings or header?", choices: ["Settings", "Header"], allowFreeform: false }, { message: "Put it in the header." }, { complete: "Done, in the header." }] });
    const engine = make();
    await engine.start();
    const events = record(engine);
    // You are away, so it toasts (D25).
    engine.setPresence(false);
    await engine.startTask({ repoId: engine.getState().projects[0]!.id, brief: "Add a dark mode toggle" });
    await until(() => only(engine).state === "waiting_input");

    const task = only(engine);
    expect(task.question).toMatchObject({ question: "Settings or header?", choices: ["Settings", "Header"], allowFreeform: false });
    expect(cards(engine, "task_question")[0]!.payload).toMatchObject({ taskId: task.id, questionId: task.question!.id, question: "Settings or header?" });
    expect(events).toContainEqual(expect.objectContaining({ type: "toast", priority: "blocking", taskId: task.id, body: "Settings or header?", cardId: `question-${task.question!.id}`, silent: false }));

    expect(() => engine.answerQuestion(task.id, task.question!.id, "Sidebar", true)).toThrow(/Pick one of: Settings, Header/);
    engine.answerQuestion(task.id, task.question!.id, "Header", false);
    expect(() => engine.answerQuestion(task.id, task.question!.id, "Header", false)).toThrow(/already answered/);
    await until(() => only(engine).state === "done");
    expect(only(engine).question).toBeUndefined();
    expect(cards(engine, "task_question")).toHaveLength(1);
    expect(cards(engine, "task_question")[0]!.payload).toMatchObject({ answer: "Header" });
    expect((await engine.getTranscript(task.id)).find((e) => e.kind === "question")).toMatchObject({ answer: "Header" });
  });

  it("pauses a task at its budget, frees its slot, and continues when you raise the budget", async () => {
    const { make, runtime } = setup({ maxConcurrentTasks: 1 });
    const engine = make();
    await engine.start();
    const preset = engine.getState().profiles.find((p) => p.isDefault)!;
    await engine.saveProfile({ id: preset.id, name: preset.name, model: preset.model, reasoningEffort: preset.reasoningEffort!, mode: "autopilot", budgetCredits: 1 });
    const project = engine.getState().projects[0]!;
    const events = record(engine);
    // You are away, so it toasts (D25).
    engine.setPresence(false);

    runtime.workerScripts.push({ steps: [{ usage: 0.6 }, { wait: 20 }, { usage: 0.6 }, { wait: 3000 }, { complete: "too far" }] });
    const pricey = await engine.startTask({ repoId: project.id, brief: "A long job" });
    const state = (id: string) => engine.getState().tasks.find((t) => t.id === id)!;
    await until(() => state(pricey.id).state === "waiting_budget");
    expect(state(pricey.id).costCredits).toBe(1.2);
    expect(cards(engine, "task_budget")[0]!.payload).toEqual({ taskId: pricey.id, shortId: "B-1", usedCredits: 1.2, budgetCredits: 1 });
    expect(state(pricey.id).budgetShortId).toBe("B-1");
    expect(events).toContainEqual(expect.objectContaining({ type: "toast", priority: "blocking", taskId: pricey.id, cardId: cards(engine, "task_budget")[0]!.id }));

    // A message for it waits for the raise: sending it now would only pause it again.
    const conductor = [...runtime.sessions.values()][0]!;
    const messageTool = conductor.config.tools.find((t) => t.name === "message_task")!;
    expect(await messageTool.handler({ task: pricey.id, text: "Also add docs" })).toMatchObject({ outcome: "held" });
    expect(state(pricey.id).state).toBe("waiting_budget");
    const sentBefore = runtime.workers.get(`aria-task-${pricey.id}`)!.prompts.length;

    // Its slot is free: another task runs meanwhile.
    runtime.workerScripts.push({ steps: [{ complete: "small one" }] });
    const small = await engine.startTask({ repoId: project.id, brief: "A small job" });
    await until(() => state(small.id).state === "done");
    expect(state(pricey.id).state).toBe("waiting_budget");
    expect(cards(engine, "task_budget")).toHaveLength(1);

    runtime.workerScripts.push({ steps: [{ message: "Picking it up again." }] }, { steps: [{ complete: "Finished after the raise." }] });
    engine.continueBudget(pricey.id, 2);
    await until(() => state(pricey.id).state === "done");
    expect(state(pricey.id)).toMatchObject({ budgetCredits: 3, summary: "Finished after the raise." });
    expect(runtime.workers.get(`aria-task-${pricey.id}`)!.prompts.slice(sentBefore)).toEqual([expect.stringMatching(/budget was raised/), "Also add docs"]);
  });

  it("can't continue a task whose worktree was cleaned up, and leaves it as it was", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: addFile("NOTES.md", "x\n") });
    const engine = make();
    await engine.start();
    await engine.startTask({ repoId: engine.getState().projects[0]!.id, brief: "Add notes" });
    await until(() => only(engine)?.state === "done");
    const task = only(engine);
    expect(task.cleanedUp).toBeUndefined();
    const conductor = [...runtime.sessions.values()][0]!;
    await conductor.config.tools.find((t) => t.name === "cleanup_task")!.handler({ task: task.id });
    expect(existsSync(task.worktreePath!)).toBe(false);
    expect(only(engine)).toMatchObject({ state: "done", cleanedUp: true });
    expect(only(engine).worktreePath).toBeUndefined();

    await expect(engine.messageTask(task.id, "One more thing", false)).rejects.toThrow(/cleaned up, so it can't continue/);
    expect(only(engine).state).toBe("done");
    expect(runtime.workers.get(`aria-task-${task.id}`)!.prompts).toHaveLength(1);
  });

  it("cancels a task that is still starting without leaving its session open", async () => {
    const { make, runtime } = setup();
    runtime.workerOpenDelayMs = 100;
    const engine = make();
    await engine.start();
    const task = await engine.startTask({ repoId: engine.getState().projects[0]!.id, brief: "Never mind" });
    expect(task.state).toBe("starting");
    await engine.cancelTask(task.id);
    expect(only(engine).state).toBe("cancelled");
    const worker = runtime.workers.get(`aria-task-${task.id}`);
    expect(worker?.connected ?? false).toBe(false);
    expect(worker?.prompts ?? []).toEqual([]);
  });

  it("finishes setting up a task before ARIA stops, so its worktree is kept track of and its session closed", async () => {
    const { make, runtime } = setup();
    runtime.workerOpenDelayMs = 150;
    const first = make();
    await first.start();
    const task = await first.startTask({ repoId: first.getState().projects[0]!.id, brief: "Slow to set up" });
    expect(task.state).toBe("starting");
    await first.stop();
    // Stopped while its worktree was being made: its session isn't opened (or is closed again).
    const worker = runtime.workers.get(`aria-task-${task.id}`);
    expect(worker?.connected ?? false).toBe(false);
    expect(worker?.prompts ?? []).toEqual([]);

    const second = make();
    await second.start();
    expect(only(second).state).toBe("interrupted");
    expect(only(second).worktreePath).toBeDefined();
    expect(existsSync(only(second).worktreePath!)).toBe(true);
  });

  it("cancels a running task that waits for an answer", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [{ question: "Which file?" }, { complete: "unreachable" }] });
    const engine = make();
    await engine.start();
    await engine.startTask({ repoId: engine.getState().projects[0]!.id, brief: "Edit a file" });
    await until(() => only(engine).state === "waiting_input");
    await engine.cancelTask(only(engine).id);
    expect(only(engine)).toMatchObject({ state: "cancelled" });
    expect(only(engine).question).toBeUndefined();
    await new Promise((r) => setTimeout(r, 200));
    expect(only(engine).state).toBe("cancelled");
  });

  it("marks tasks that were running as interrupted after a restart, and resumes them in the same session", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [{ gate: new Promise<void>(() => {}) }] });
    const first = make();
    await first.start();
    const started = await first.startTask({ repoId: first.getState().projects[0]!.id, brief: "Long running" });
    await until(() => only(first).state === "running");
    await first.stop();

    const second = make();
    await second.start();
    expect(only(second).state).toBe("interrupted");
    expect(cards(second, "tasks_interrupted")[0]!.payload).toEqual({ taskIds: [started.id] });
    runtime.workerScripts.push({ steps: [{ complete: "Picked up where I left off." }] });
    second.resumeInterrupted();
    await until(() => only(second).state === "done");
    const worker = runtime.workers.get(`aria-task-${started.id}`)!;
    expect(worker.prompts).toHaveLength(2);
    expect(worker.prompts[1]).toMatch(/ARIA was closed/);
  });

  it("discards a task: its worktree, branch and session are gone", async () => {
    const { make, runtime, repo } = setup();
    runtime.workerScripts.push({ steps: addFile("NOTES.md", "x\n") });
    const engine = make();
    await engine.start();
    await engine.startTask({ repoId: engine.getState().projects[0]!.id, brief: "Add notes" });
    await until(() => only(engine)?.state === "done");
    const task = only(engine);
    const events = record(engine);
    await engine.discardTask(task.id);
    expect(existsSync(task.worktreePath!)).toBe(false);
    expect(git(repo, "branch", "--list", "aria/*")).toBe("");
    expect(runtime.workers.has(`aria-task-${task.id}`)).toBe(false);
    expect(engine.getState().tasks).toEqual([]);
    expect(events).toContainEqual({ type: "task_removed", taskId: task.id });
  });

  it("fails on a session error and continues in the same session on Retry", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [{ error: "rate limited" }] }, { steps: [{ complete: "Recovered." }] });
    const engine = make();
    await engine.start();
    const events = record(engine);
    // You are away, so it toasts (D25).
    engine.setPresence(false);
    await engine.startTask({ repoId: engine.getState().projects[0]!.id, brief: "Flaky job" });
    await until(() => only(engine).state === "failed");
    expect(only(engine).error).toBe("rate limited");
    expect(cards(engine, "task_failed")[0]!.payload).toEqual({ taskId: only(engine).id, error: "rate limited" });
    expect(events).toContainEqual(expect.objectContaining({ type: "toast", priority: "blocking", title: "Flaky job failed", body: "rate limited" }));
    engine.retryTask(only(engine).id);
    await until(() => only(engine).state === "done");
    expect(runtime.workers.get(`aria-task-${only(engine).id}`)!.prompts[1]).toMatch(/stopped with an error: rate limited/);
    // Retrying and finishing supersedes the earlier failed card so the chat isn't cluttered with stale failure cards for the same session.
    expect(cards(engine, "task_failed")).toHaveLength(0);
    expect(cards(engine, "task_done")).toHaveLength(1);
  });

  it("supersedes earlier task_done cards and coalesces repeated notices for the same session across turns", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push(
      { steps: [{ complete: "Turn 1 done." }] },
      { steps: [{ complete: "Turn 2 done." }] },
    );
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: engine.getState().projects[0]!.id, brief: "Multi-turn session" });
    await until(() => only(engine).state === "done");
    expect(cards(engine, "task_done")).toHaveLength(1);
    expect(cards(engine, "task_done")[0]!.payload.summary).toBe("Turn 1 done.");

    // Emit two model_change events on the same worker session -> coalesced into a single notice with count: 2
    const worker = runtime.workers.get(`aria-task-${started.id}`)!;
    worker.config.onEvent({ type: "model_change", model: "fake-strong", previousModel: "fake-light", cause: "refusal_fallback" });
    worker.config.onEvent({ type: "model_change", model: "fake-strong", previousModel: "fake-light", cause: "refusal_fallback" });
    const sessionNotices = engine.getState().timeline.filter((i) => i.kind === "notice" && i.taskId === started.id);
    expect(sessionNotices).toHaveLength(1);
    expect(sessionNotices[0]).toMatchObject({ kind: "notice", taskId: started.id, cause: "refusal_fallback", count: 2 });

    // Continue the session for a second turn -> replaces the first task_done card instead of leaving two task_done cards
    await engine.messageTask(started.id, "Now do turn 2", false);
    await until(() => only(engine).state === "done" && only(engine).summary === "Turn 2 done.");
    expect(cards(engine, "task_done")).toHaveLength(1);
    expect(cards(engine, "task_done")[0]!.payload.summary).toBe("Turn 2 done.");
  });

  it("marks an autopilot task that went quiet without finishing as done but incomplete", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [{ message: "I'm not sure how to continue." }] });
    const engine = make();
    await engine.start();
    await engine.startTask({ repoId: engine.getState().projects[0]!.id, brief: "Vague job" });
    await until(() => only(engine).state === "done");
    expect(cards(engine, "task_done")[0]!.payload).toMatchObject({ incomplete: true, commits: 0, summary: "I'm not sure how to continue." });
  });

  it("puts text a task damaged with a wrong encoding on its Done card, and drops it when the repair leaves none (R1)", async () => {
    const { make, runtime } = setup();
    // UTF-8 read as Windows-1252 and written back, as Windows PowerShell 5.1 does: `→` becomes `â†’`.
    const damaged = new TextDecoder("windows-1252").decode(Buffer.from("Arrow → here\n", "utf8"));
    runtime.workerScripts.push({ steps: addFile("NOTES.md", damaged) }, { steps: addFile("NOTES.md", "Arrow → here\n") });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: engine.getState().projects[0]!.id, brief: "Add notes" });
    await until(() => only(engine).state === "done");
    const damage = cards(engine, "task_done")[0]!.payload.encodingDamage;
    expect(damage).toEqual({ lines: 1, files: 1, paths: ["NOTES.md"], base: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(only(engine).encodingDamage).toEqual(damage);

    // "Ask it to repair": ARIA's message from the record, and the task continues with it. The file names are the
    // task's own, so the message isn't your words (nothing to save as a memory) and grants no paths.
    await engine.repairEncoding(started.id);
    await until(() => only(engine).state === "done" && only(engine).commits === 2);
    const prompt = runtime.workers.get(`aria-task-${started.id}`)!.prompts[1]!;
    expect(prompt).toContain("ARIA found 1 line in 1 file that look like damaged text");
    expect(prompt).toContain("`NOTES.md`");
    expect(prompt).toContain(`git diff ${damage!.base} -- <file>`);
    expect(engine.yourWords(started.id)).toEqual([]);
    expect(only(engine).allowedPaths).toBeUndefined();
    expect(cards(engine, "task_done")).toHaveLength(1);
    expect(cards(engine, "task_done")[0]!.payload.encodingDamage).toBeUndefined();
    expect(only(engine).encodingDamage).toBeUndefined();
    await expect(engine.repairEncoding(started.id)).rejects.toThrow(/no damaged text/);
  });

  it("uses a profile only when your message names it (policy: me)", async () => {
    const { make, runtime } = setup();
    const start = (title: string) => ({ toolCalls: [{ name: "start_task", args: { repo: "Garden Castle Defense", title, brief: title, profile: "Deep" } }], text: "Started." });
    runtime.replies.push(start("Named"), start("Not named"));
    runtime.workerScripts.push({ steps: [{ complete: "a" }] }, { steps: [{ complete: "b" }] });
    const engine = make();
    await engine.start();
    await engine.sendMessage("Add notes, use Deep for this");
    await until(() => engine.getState().status.state === "ready" && engine.getState().tasks.length === 1);
    await engine.sendMessage("And another one");
    await until(() => engine.getState().tasks.length === 2);
    const byTitle = (title: string) => engine.getState().tasks.find((t) => t.title === title)!;
    expect(byTitle("Named")).toMatchObject({ profileName: "Deep", model: "fake-strong", profileNote: "You asked for Deep." });
    expect(byTitle("Not named")).toMatchObject({ profileName: "Default", profileNote: expect.stringMatching(/didn't name a profile/) });
  });

  it("steers a running task and switches its model without a runtime-switch warning", async () => {
    const { make, runtime } = setup();
    let release!: () => void;
    runtime.workerScripts.push({ steps: [{ gate: new Promise<void>((r) => (release = r)) }, { complete: "ok" }] }, { steps: [{ complete: "steered" }] });
    const engine = make();
    await engine.start();
    const task = await engine.startTask({ repoId: engine.getState().projects[0]!.id, brief: "Steerable" });
    await until(() => only(engine).state === "running");
    await engine.messageTask(task.id, "Also update the README", true);
    await engine.setTaskModel(task.id, "fake-strong", "high");
    await expect(engine.setTaskModel(task.id, "fake-off")).rejects.toThrow(/isn't an available model/);
    const worker = runtime.workers.get(`aria-task-${task.id}`)!;
    expect(worker.prompts.at(-1)).toBe("Also update the README");
    expect(worker).toMatchObject({ model: "fake-strong", reasoningEffort: "high" });
    expect(only(engine)).toMatchObject({ model: "fake-strong", reasoningEffort: "high" });
    release();
    await until(() => only(engine).state === "done");
    expect(engine.getState().timeline.filter((i) => i.kind === "notice")).toEqual([]);
  });

  it("refreshes the Conductor's task tools when profiles change", async () => {
    const { make, runtime } = setup();
    const engine = make();
    await engine.start();
    const conductor = [...runtime.sessions.values()][0]!;
    const profileEnum = () => {
      const tool = conductor.config.tools.find((t) => t.name === "start_task")!;
      return (tool.parameters as unknown as { shape: { profile: { unwrap(): { options: string[] } } } }).shape.profile.unwrap().options;
    };
    expect(profileEnum()).toEqual(["Default", "Quick", "Deep", "CI fix"]);
    await engine.saveProfile({ name: "Docs", model: "fake-light", reasoningEffort: "low", mode: "interactive" });
    expect(profileEnum()).toEqual(["Default", "Quick", "Deep", "CI fix", "Docs"]);
    await engine.setProfilePolicy("aria");
    expect(conductor.config.tools.find((t) => t.name === "start_task")!.description).toMatch(/pick the profile/);
  });

  it("offloads read-only investigations via start_task and finishes with a summary and no commits", async () => {
    const { make, runtime } = setup();
    runtime.replies.push({
      toolCalls: [{ name: "start_task", args: { repo: "castle defense", title: "Investigate tower script casing", brief: "Investigate why tower script parameters have wrong casing." } }],
      text: "Started Investigate tower script casing.",
    });
    runtime.workerScripts.push({
      steps: [
        { intent: "Investigating tower script generation" },
        { message: "The script writer does not inspect TowerScript_Helper.cs." },
        { complete: "Findings: the script writer guesses PascalCase instead of reading TowerScript_Helper.cs." },
      ],
    });
    const engine = make();
    await engine.start();
    const conductor = [...runtime.sessions.values()][0]!;
    expect(conductor.config.systemPrompt).toMatch(/investigation,\s+audit or multi-file analysis.*call start_task/s);
    expect(conductor.config.tools.find((t) => t.name === "start_task")!.description).toMatch(/investigations or audits/);

    await engine.sendMessage("Can you start an investigation in Garden Castle Defense why tower script parameters fail to compile?");
    await until(() => only(engine)?.state === "done");
    const task = only(engine);
    expect(task).toMatchObject({
      title: "Investigate tower script casing",
      repoName: "Garden Castle Defense",
      commits: 0,
      filesChanged: 0,
      summary: "Findings: the script writer guesses PascalCase instead of reading TowerScript_Helper.cs.",
    });
    const worker = runtime.workers.get(`aria-task-${task.id}`)!;
    expect(worker.prompts[0]).toMatch(/For read-only investigations, do not modify or commit files/);
  });

  describe("reconnect", () => {
    const stateOf = (engine: AriaEngine, id: string) => engine.getState().tasks.find((t) => t.id === id)?.state;

    it("keeps the runtime while a task is working, and says so when the conversation still can't open", async () => {
      const { make, runtime } = setup();
      const stop = runtime.stop.bind(runtime);
      let stops = 0;
      runtime.stop = () => {
        stops++;
        return stop();
      };
      runtime.failOpens = 2;
      runtime.workerScripts.push({ steps: [{ wait: 60_000 }] });
      const engine = make();
      await engine.start();
      const task = await engine.startTask({ repoId: engine.getState().projects[0]!.id, title: "Slow", brief: "Take your time" });
      await until(() => stateOf(engine, task.id) === "running");

      runtime.failOpens = 2;
      await engine.reconnect();
      expect(engine.getState().status.state).toBe("error");
      expect(engine.getState().status.detail).toMatch(/A task is still working/);
      expect(stops).toBe(0);

      await engine.reconnect();
      expect(engine.getState().status.state).toBe("ready");
      expect(stops).toBe(0);
      expect(stateOf(engine, task.id)).toBe("running");
    });

    it("keeps a new task in the queue until the restarted runtime is up", async () => {
      const { make, runtime } = setup();
      runtime.failOpens = 2;
      runtime.workerScripts.push({ steps: [{ complete: "Done." }] });
      const engine = make();
      await engine.start();
      const start = runtime.start.bind(runtime);
      let release: (() => void) | undefined;
      runtime.start = async (options) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return start(options);
      };
      const reconnecting = engine.reconnect();
      await until(() => release !== undefined);
      const task = await engine.startTask({ repoId: engine.getState().projects[0]!.id, title: "Next", brief: "Do it" });
      expect(stateOf(engine, task.id)).toBe("queued");
      release!();
      await reconnecting;
      await until(() => stateOf(engine, task.id) === "done");
    });

    it("reopens a finished task's session after the restart instead of using the one that ended", async () => {
      const { make, runtime } = setup();
      runtime.failOpens = 2;
      runtime.workerScripts.push({ steps: [{ complete: "Done." }] }, { steps: [{ complete: "Done again." }] });
      const openWorker = runtime.openWorker.bind(runtime);
      let opens = 0;
      runtime.openWorker = (config) => {
        opens++;
        return openWorker(config);
      };
      const engine = make();
      await engine.start();
      const task = await engine.startTask({ repoId: engine.getState().projects[0]!.id, title: "Quick", brief: "Do it" });
      await until(() => stateOf(engine, task.id) === "done");
      expect(opens).toBe(1);

      await engine.reconnect();
      expect(engine.getState().status.state).toBe("ready");
      await engine.messageTask(task.id, "One more thing", false);
      await until(() => opens === 2);
    });

    it("sanitizes session name when question/brief or title contains double quotes", async () => {
      const { make, runtime } = setup();
      runtime.workerScripts.push({ steps: [{ complete: "Done." }] });
      const openWorker = runtime.openWorker.bind(runtime);
      let sessionName: string | undefined;
      runtime.openWorker = (config) => {
        sessionName = config.name;
        return openWorker(config);
      };
      const engine = make();
      await engine.start();
      const task = await engine.startTask({
        repoId: engine.getState().projects[0]!.id,
        brief: 'Why does the DepencyResolver.cs have "framework-orchestrator" mentioned?',
      });
      await until(() => stateOf(engine, task.id) === "done");
      expect(sessionName).toBe("ARIA · Why does the DepencyResolver.cs have 'framework-orchestra…");
      expect(sessionName).not.toContain('"');
    });

    it("interrupts working tasks when the runtime ends, and a resume waits until it's back", async () => {
      const { make, runtime } = setup({ runtimeCheckMs: 5 });
      runtime.workerScripts.push({ steps: [{ wait: 60_000 }] });
      const engine = make();
      await engine.start();
      const task = await engine.startTask({ repoId: engine.getState().projects[0]!.id, brief: "Long running" });
      await until(() => stateOf(engine, task.id) === "running");

      runtime.started = false;
      await until(() => engine.getState().status.state === "error");
      expect(stateOf(engine, task.id)).toBe("interrupted");
      expect(cards(engine, "tasks_interrupted")[0]!.payload).toEqual({ taskIds: [task.id], cause: "runtime" });

      runtime.workerScripts.push({ steps: [{ complete: "Picked up where I left off." }] });
      engine.resumeInterrupted();
      expect(stateOf(engine, task.id)).toBe("queued");
      await engine.reconnect();
      expect(engine.getState().status.state).toBe("ready");
      await until(() => stateOf(engine, task.id) === "done");
      const worker = runtime.workers.get(`aria-task-${task.id}`)!;
      expect(worker.prompts).toHaveLength(2);
      expect(worker.prompts[1]).toMatch(/ARIA was closed/);
    });

    it("doesn't fail a resumed task over a start from before the runtime ended", async () => {
      const { make, runtime } = setup({ runtimeCheckMs: 5 });
      const openWorker = runtime.openWorker.bind(runtime);
      let fail: ((error: Error) => void) | undefined;
      runtime.openWorker = () =>
        new Promise((_, reject) => {
          fail = reject;
        });
      const engine = make();
      await engine.start();
      const task = await engine.startTask({ repoId: engine.getState().projects[0]!.id, brief: "Long running" });
      await until(() => fail !== undefined);

      runtime.started = false;
      await until(() => stateOf(engine, task.id) === "interrupted");
      runtime.openWorker = openWorker;
      runtime.workerScripts.push({ steps: [{ wait: 60_000 }] });
      await engine.reconnect();
      engine.resumeInterrupted();
      await until(() => stateOf(engine, task.id) === "running");

      fail!(new Error("Session disconnected"));
      await new Promise((r) => setTimeout(r, 50));
      expect(stateOf(engine, task.id)).toBe("running");
    });

    it("leaves a pause at the budget as it is when the runtime ends", async () => {
      const { make, runtime } = setup({ runtimeCheckMs: 5 });
      runtime.workerScripts.push({ steps: [{ usage: 2 }, { wait: 60_000 }] });
      const engine = make();
      await engine.start();
      const preset = engine.getState().profiles.find((p) => p.isDefault)!;
      await engine.saveProfile({ id: preset.id, name: preset.name, model: preset.model, reasoningEffort: preset.reasoningEffort!, mode: "autopilot", budgetCredits: 1 });
      const task = await engine.startTask({ repoId: engine.getState().projects[0]!.id, brief: "A long job" });
      await until(() => stateOf(engine, task.id) === "waiting_budget");
      const shortId = cards(engine, "task_budget")[0]!.payload.shortId;
      expect(shortId).toBeDefined();

      runtime.started = false;
      await until(() => engine.getState().status.state === "error");
      expect(stateOf(engine, task.id)).toBe("waiting_budget");
      expect(cards(engine, "tasks_interrupted")).toHaveLength(0);
      expect(engine.getState().tasks.find((t) => t.id === task.id)?.budgetShortId).toBe(shortId);
    });

    it("starts a task with extra context and files, passes them to the brief, and preserves them on rerun", async () => {
      const { make, runtime, repo } = setup();
      runtime.workerScripts.push({ steps: [{ complete: "ok" }] });
      const engine = make();
      await engine.start();

      const contextFile = path.join(repo, "README.md");
      const task = await engine.startTask({
        repoId: engine.getState().projects[0]!.id,
        title: "Context task",
        brief: "Use the extra context.",
        extraContext: "API endpoint: https://example.com/v1\nConstraint: do not use lodash",
        files: [contextFile],
      });

      await until(() => stateOf(engine, task.id) === "done");
      expect(task.extraContext).toBe("API endpoint: https://example.com/v1\nConstraint: do not use lodash");
      expect(task.files).toEqual([contextFile]);

      const workerSession = runtime.workers.get(`aria-task-${task.id}`)!;
      expect(workerSession.prompts[0]).toContain("Extra context");
      expect(workerSession.prompts[0]).toContain("API endpoint: https://example.com/v1");
      expect(workerSession.prompts[0]).toContain("Provided files");
      expect(workerSession.prompts[0]).toContain(contextFile);

      // Rerunning preserves extraContext and files
      runtime.workerScripts.push({ steps: [{ complete: "ok" }] });
      const rerun = await engine.startTask({
        repoId: engine.getState().projects[0]!.id,
        brief: "Rerun task.",
        rerunOf: task.id,
      });

      await until(() => stateOf(engine, rerun.id) === "done");
      expect(rerun.extraContext).toBe("API endpoint: https://example.com/v1\nConstraint: do not use lodash");
      expect(rerun.files).toEqual([contextFile]);
    });
  });
});
