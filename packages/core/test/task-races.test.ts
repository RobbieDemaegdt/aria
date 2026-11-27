/**
 * The task manager's races (Phase 2 review): work that overlaps a cancel, a discard, a settle, a budget pause, a model
 * switch, a restart or a shutdown. Each test holds one step open (a gate) and acts while it is.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CardItem } from "@aria/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AriaEngine, type EngineOptions } from "../src/engine.ts";
import { FakeRuntime } from "../src/runtime/fake.ts";
import { checkedOutBranch, diffStat, removeWorktree } from "../src/tasks/worktrees.ts";
import { commitFile, makeRepo, waitMs } from "./helpers.ts";

vi.mock("../src/tasks/worktrees.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tasks/worktrees.ts")>();
  return { ...actual, diffStat: vi.fn(actual.diffStat), removeWorktree: vi.fn(actual.removeWorktree), checkedOutBranch: vi.fn(actual.checkedOutBranch) };
});

const temps: string[] = [];
const engines: AriaEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.stop()));
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function setup(options: Partial<EngineOptions> = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), "aria-races-"));
  temps.push(base);
  const projects = path.join(base, "GitHub");
  const repo = makeRepo(projects, "Race Track");
  commitFile(repo, "README.md", "# Track\n", "Initial commit");
  const runtime = new FakeRuntime();
  const make = () => {
    const engine = new AriaEngine({
      dataDir: path.join(base, "data"),
      runtime,
      projectRoots: [projects],
      resumeSettleMs: 10,
      worktreeRoot: path.join(base, "wt"),
      taskSettleMs: 20,
      autopilotGraceMs: 150,
      ...options,
    });
    engines.push(engine);
    return engine;
  };
  return { runtime, make };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > waitMs(ms)) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

const task = (engine: AriaEngine, id: string) => engine.getState().tasks.find((t) => t.id === id);
const stateOf = (engine: AriaEngine, id: string) => task(engine, id)?.state;
const repoId = (engine: AriaEngine) => engine.getState().projects[0]!.id;
const cards = <T extends CardItem["cardType"]>(engine: AriaEngine, type: T) =>
  engine.getState().timeline.filter((i): i is Extract<CardItem, { cardType: T }> => i.kind === "card" && i.cardType === type);

describe("task races", () => {
  it("sends nothing more once a task is cancelled while its brief is on its way", async () => {
    const { make, runtime } = setup();
    const brief = gate();
    runtime.workerSendGate = (text) => (text.includes("Slow brief") ? brief.promise : undefined);
    runtime.workerScripts.push({ steps: [{ gate: new Promise<void>(() => {}) }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Slow brief" });
    await engine.messageTask(started.id, "Also do Y", false);
    await until(() => stateOf(engine, started.id) === "running");
    const cancelling = engine.cancelTask(started.id);
    brief.open();
    await cancelling;
    await new Promise((r) => setTimeout(r, 100));
    const worker = runtime.workers.get(`aria-task-${started.id}`)!;
    expect(worker.prompts).toEqual([expect.stringContaining("Slow brief")]);
    expect(stateOf(engine, started.id)).toBe("cancelled");
  });

  it("sends the brief once when a task is cancelled while it starts and then continued right away", async () => {
    const { make, runtime } = setup();
    const opening = gate();
    runtime.workerOpenGate = opening.promise;
    runtime.workerScripts.push({ steps: [{ complete: "Done after all." }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Starts slowly" });
    await until(() => task(engine, started.id)?.worktreePath !== undefined);
    const cancelling = engine.cancelTask(started.id);
    const continuing = engine.messageTask(started.id, "Go ahead after all", false);
    runtime.workerOpenGate = undefined;
    opening.open();
    await Promise.all([cancelling, continuing]);
    await until(() => stateOf(engine, started.id) === "done");
    expect(runtime.workers.get(`aria-task-${started.id}`)!.prompts).toEqual([expect.stringContaining("Starts slowly"), "Go ahead after all"]);
  });

  it("never starts a queued task that's being discarded, even when a slot frees up meanwhile", async () => {
    const { make, runtime } = setup({ maxConcurrentTasks: 1 });
    const engine = make();
    await engine.start();
    // It ran once, so it has a worktree and a session to remove; then it waits for a slot with a follow-up.
    runtime.workerScripts.push({ steps: [{ complete: "first round" }] });
    const second = await engine.startTask({ repoId: repoId(engine), brief: "Second" });
    await until(() => stateOf(engine, second.id) === "done");
    const worktree = task(engine, second.id)!.worktreePath!;
    const holder = gate();
    runtime.workerScripts.push({ steps: [{ gate: holder.promise }, { complete: "first" }] });
    const first = await engine.startTask({ repoId: repoId(engine), brief: "First" });
    await until(() => stateOf(engine, first.id) === "running");
    await engine.messageTask(second.id, "Follow-up", false);
    expect(stateOf(engine, second.id)).toBe("queued");

    // Its worktree is being removed when the slot frees up.
    const actual = await vi.importActual<typeof import("../src/tasks/worktrees.ts")>("../src/tasks/worktrees.ts");
    const removing = gate();
    const remove = gate();
    vi.mocked(removeWorktree).mockImplementationOnce(async (...args) => {
      removing.open();
      await remove.promise;
      return actual.removeWorktree(...args);
    });
    const states: string[] = [];
    engine.onEvent((e) => {
      if (e.type === "task" && e.task.id === second.id) states.push(e.task.state);
    });
    const discarding = engine.discardTask(second.id);
    await removing.promise;
    holder.open();
    await until(() => stateOf(engine, first.id) === "done");
    remove.open();
    await discarding;
    await new Promise((r) => setTimeout(r, 100));
    expect(states).not.toContain("starting");
    expect(states).not.toContain("running");
    expect(runtime.workers.has(`aria-task-${second.id}`)).toBe(false);
    expect(existsSync(worktree)).toBe(false);
    expect(engine.getState().tasks.map((t) => t.id)).toEqual([first.id]);
  });

  it("doesn't call a task done when it got busy again while its changes were being counted", async () => {
    const { make, runtime } = setup();
    const actual = await vi.importActual<typeof import("../src/tasks/worktrees.ts")>("../src/tasks/worktrees.ts");
    const counting = gate();
    const settling = gate();
    vi.mocked(diffStat).mockImplementationOnce(async (...args) => {
      settling.open();
      await counting.promise;
      return actual.diffStat(...args);
    });
    runtime.workerScripts.push({ steps: [{ message: "First part done." }] }, { steps: [{ wait: 50 }, { message: "All done." }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Two parts", mode: "interactive" });
    await settling.promise;
    await engine.messageTask(started.id, "Now the second part", false);
    counting.open();
    await new Promise((r) => setTimeout(r, 30));
    expect(stateOf(engine, started.id)).toBe("running");
    await until(() => stateOf(engine, started.id) === "done");
    expect(task(engine, started.id)!.summary).toBe("All done.");
    expect(cards(engine, "task_done")).toHaveLength(1);
  });

  it("pauses a task at its budget while it waits for an answer (its sub-agents still spend)", async () => {
    const { make, runtime } = setup();
    const engine = make();
    await engine.start();
    const preset = engine.getState().profiles.find((p) => p.isDefault)!;
    await engine.saveProfile({ id: preset.id, name: preset.name, model: preset.model, reasoningEffort: preset.reasoningEffort!, mode: "autopilot", budgetCredits: 1 });
    runtime.workerScripts.push({ steps: [{ question: "Which one?" }, { complete: "unreachable" }] });
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Ask, then spend" });
    await until(() => stateOf(engine, started.id) === "waiting_input");
    runtime.workers.get(`aria-task-${started.id}`)!.inject({ type: "usage", nanoAiu: 1.5e9 });
    await until(() => stateOf(engine, started.id) === "waiting_budget");
    expect(task(engine, started.id)!.question).toBeUndefined();
    expect(cards(engine, "task_budget")).toHaveLength(1);
  });

  it("uses a model you switch to while the task's session opens, from its very first message", async () => {
    const { make, runtime } = setup();
    const opening = gate();
    runtime.workerOpenGate = opening.promise;
    runtime.workerScripts.push({ steps: [{ complete: "ok" }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Switch me" });
    expect(started.model).toBe("fake-light");
    await until(() => task(engine, started.id)?.worktreePath !== undefined);
    await engine.setTaskModel(started.id, "fake-strong", "high");
    opening.open();
    await until(() => stateOf(engine, started.id) === "done");
    const worker = runtime.workers.get(`aria-task-${started.id}`)!;
    expect(worker.promptModels[0]).toBe("fake-strong");
    expect(worker).toMatchObject({ model: "fake-strong", reasoningEffort: "high" });
    expect(engine.getState().timeline.filter((i) => i.kind === "notice")).toEqual([]);
  });

  it("keeps messages for a task waiting in the queue across a restart", async () => {
    const { make, runtime } = setup({ maxConcurrentTasks: 1 });
    runtime.workerScripts.push({ steps: [{ gate: new Promise<void>(() => {}) }] });
    const first = make();
    await first.start();
    const holder = await first.startTask({ repoId: repoId(first), brief: "Hold the slot" });
    await until(() => stateOf(first, holder.id) === "running");
    const waiting = await first.startTask({ repoId: repoId(first), brief: "Wait in line" });
    await first.messageTask(waiting.id, "Use tabs, not spaces", false);
    await first.stop();

    runtime.workerScripts.push({ steps: [{ message: "On it." }] }, { steps: [{ complete: "Waited, with tabs." }] });
    const second = make();
    await second.start();
    await until(() => stateOf(second, waiting.id) === "done");
    expect(runtime.workers.get(`aria-task-${waiting.id}`)!.prompts).toEqual([expect.stringContaining("Wait in line"), "Use tabs, not spaces"]);
  });

  it("quits in time even when sessions never finish disconnecting", async () => {
    const { make, runtime } = setup({ shutdownWaitMs: 100 });
    runtime.workerScripts.push({ steps: [{ gate: new Promise<void>(() => {}) }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Never ends" });
    await until(() => stateOf(engine, started.id) === "running");
    runtime.hangDisconnects = true;
    const begin = Date.now();
    await engine.stop();
    expect(Date.now() - begin).toBeLessThan(2000);
    expect(runtime.started).toBe(false);
  });

  it("waits at shutdown for a task's changes being counted, so no git of ARIA's is left in the worktree", async () => {
    const { make, runtime } = setup();
    const actual = await vi.importActual<typeof import("../src/tasks/worktrees.ts")>("../src/tasks/worktrees.ts");
    const counting = gate();
    const settling = gate();
    let counted = false;
    vi.mocked(diffStat).mockImplementationOnce(async (...args) => {
      settling.open();
      await counting.promise;
      const stat = await actual.diffStat(...args);
      counted = true;
      return stat;
    });
    runtime.workerScripts.push({ steps: [{ complete: "Done." }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Finish as ARIA quits" });
    await settling.promise;
    const worktree = task(engine, started.id)!.worktreePath!;
    let stopped = false;
    const stopping = engine.stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 100));
    expect(stopped).toBe(false);
    counting.open();
    await stopping;
    expect(counted).toBe(true);
    // No retries: on Windows a git still running in it would make this fail.
    rmSync(worktree, { recursive: true });
  });

  it("gives ARIA the latest profiles when they change while its conversation opens", async () => {
    const { make, runtime } = setup();
    const opening = gate();
    runtime.conductorOpenGate = opening.promise;
    const engine = make();
    const starting = engine.start();
    await until(() => engine.getState().status.detail === "Opening the conversation");
    await engine.saveProfile({ name: "Docs", model: "fake-light", reasoningEffort: "low", mode: "interactive" });
    opening.open();
    await starting;
    const conductor = [...runtime.sessions.values()][0]!;
    const startTask = conductor.config.tools.find((t) => t.name === "start_task")!;
    const options = (startTask.parameters as unknown as { shape: { profile: { unwrap(): { options: string[] } } } }).shape.profile.unwrap().options;
    expect(options).toEqual(["Default", "Quick", "Deep", "CI fix", "Docs"]);
  });

  // ── round 2 ────────────────────────────────────────────────────────────────────────────────────────────────

  it("keeps a message sent just before you pressed Stop for later instead of starting work", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [{ gate: new Promise<void>(() => {}) }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Keep going" });
    await until(() => stateOf(engine, started.id) === "running");
    const messaging = engine.messageTask(started.id, "One more thing", false);
    await engine.cancelTask(started.id);
    await messaging;
    await new Promise((r) => setTimeout(r, 100));
    const worker = runtime.workers.get(`aria-task-${started.id}`)!;
    expect(worker.prompts).toEqual([expect.stringContaining("Keep going")]);
    expect(stateOf(engine, started.id)).toBe("cancelled");
  });

  it("doesn't let a message that was already on its way when you pressed Stop start work", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [{ gate: new Promise<void>(() => {}) }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Keep going" });
    await until(() => stateOf(engine, started.id) === "running");
    const held = gate();
    const sending = gate();
    runtime.workerSendGate = (text) => {
      if (text !== "One more thing") return undefined;
      sending.open();
      return held.promise;
    };
    const messaging = engine.messageTask(started.id, "One more thing", false);
    await sending.promise;
    const cancelling = engine.cancelTask(started.id);
    held.open();
    await Promise.all([messaging, cancelling]);
    await new Promise((r) => setTimeout(r, 100));
    const worker = runtime.workers.get(`aria-task-${started.id}`)!;
    expect(worker.prompts).toContain("One more thing");
    const replies = [...worker.transcript.values()].filter((e) => e.kind === "assistant");
    expect(replies).toEqual([]);
    expect(stateOf(engine, started.id)).toBe("cancelled");
  });

  it("doesn't send a message twice when a Retry puts its note in front of it while it's on its way", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [{ complete: "first" }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Retry me" });
    await until(() => stateOf(engine, started.id) === "done");
    const held = gate();
    runtime.workerSendGate = (text) => (text === "Follow-up X" ? held.promise : undefined);
    await engine.messageTask(started.id, "Follow-up X", false);
    await until(() => stateOf(engine, started.id) === "running");
    // The session fails while X is on its way, and you retry right away.
    runtime.workers.get(`aria-task-${started.id}`)!.inject({ type: "error", message: "boom" });
    await until(() => stateOf(engine, started.id) === "failed");
    engine.retryTask(started.id);
    held.open();
    await until(() => stateOf(engine, started.id) === "done");
    const prompts = runtime.workers.get(`aria-task-${started.id}`)!.prompts;
    expect(prompts.filter((p) => p === "Follow-up X")).toHaveLength(1);
    expect(prompts.at(-1)).toMatch(/stopped with an error: boom/);
  });

  it("ends on the model you picked last when you pick twice while the session opens", async () => {
    const { make, runtime } = setup();
    const opening = gate();
    runtime.workerOpenGate = opening.promise;
    runtime.workerScripts.push({ steps: [{ complete: "ok" }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Pick twice" });
    // Picked while the session itself opens (before that, a pick is simply what it opens with).
    await until(() => runtime.workerOpens > 0);
    await engine.setTaskModel(started.id, "fake-strong", "high");
    const switching = gate();
    const switchStarted = gate();
    runtime.workerSetModelGate = () => {
      switchStarted.open();
      return switching.promise;
    };
    opening.open();
    await switchStarted.promise;
    runtime.workerSetModelGate = undefined;
    await engine.setTaskModel(started.id, "fake-light", "high");
    switching.open();
    await until(() => stateOf(engine, started.id) === "done");
    const worker = runtime.workers.get(`aria-task-${started.id}`)!;
    expect(worker.promptModels[0]).toBe("fake-light");
    expect(worker).toMatchObject({ model: "fake-light", reasoningEffort: "high" });
    expect(task(engine, started.id)).toMatchObject({ model: "fake-light", reasoningEffort: "high" });
  });

  it("keeps the model the runtime reports when it runs another one than you switched to (D15)", async () => {
    const { make, runtime } = setup();
    const holder = gate();
    runtime.workerScripts.push({ steps: [{ gate: holder.promise }, { complete: "ok" }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Fallback" });
    await until(() => stateOf(engine, started.id) === "running");
    runtime.workerSubstituteModel = "fake-light";
    await engine.setTaskModel(started.id, "fake-strong", "high");
    expect(task(engine, started.id)!.model).toBe("fake-light");
    expect(engine.getState().timeline.filter((i) => i.kind === "notice")).toHaveLength(1);
    holder.open();
  });

  it("discards a task whose session never finishes opening", async () => {
    const { make, runtime } = setup({ sessionWaitMs: 100, shutdownWaitMs: 100 });
    runtime.workerOpenGate = new Promise<void>(() => {});
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Never opens" });
    await until(() => task(engine, started.id)?.worktreePath !== undefined);
    const worktree = task(engine, started.id)!.worktreePath!;
    await engine.discardTask(started.id);
    expect(engine.getState().tasks).toEqual([]);
    expect(existsSync(worktree)).toBe(false);
  });

  it("keeps the session when Discard can't remove the worktree, so the task can go on where it was", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [{ complete: "first" }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Locked" });
    await until(() => stateOf(engine, started.id) === "done");
    vi.mocked(removeWorktree).mockImplementationOnce(async () => {
      throw new Error("EBUSY: a file in it is open");
    });
    await expect(engine.discardTask(started.id)).rejects.toThrow(/EBUSY/);
    expect(runtime.workers.has(`aria-task-${started.id}`)).toBe(true);
    await engine.messageTask(started.id, "Carry on", false);
    await until(() => stateOf(engine, started.id) === "done");
    expect(runtime.workers.get(`aria-task-${started.id}`)!.prompts).toEqual([expect.stringContaining("Locked"), "Carry on"]);
  });

  it("gives a task its brief again when its session is gone", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [{ complete: "first" }] });
    const first = make();
    await first.start();
    const started = await first.startTask({ repoId: repoId(first), brief: "Remember me" });
    await until(() => stateOf(first, started.id) === "done");
    await first.stop();
    await runtime.deleteSession(`aria-task-${started.id}`);
    const second = make();
    await second.start();
    await second.messageTask(started.id, "Carry on", false);
    await until(() => stateOf(second, started.id) === "done");
    expect(runtime.workers.get(`aria-task-${started.id}`)!.prompts).toEqual([expect.stringMatching(/session for this task is gone[\s\S]*Remember me/), "Carry on"]);
  });

  // ── round 3 ────────────────────────────────────────────────────────────────────────────────────────────────

  it("runs a Continue only once it has stopped a finished task's stray turn", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [{ complete: "first" }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Stray turn" });
    await until(() => stateOf(engine, started.id) === "done");
    const aborting = gate();
    const abortStarted = gate();
    runtime.workerAbortGate = () => {
      abortStarted.open();
      return aborting.promise;
    };
    // The finished task's session starts work anyway (a message it accepted late, say): ARIA stops it.
    const worker = runtime.workers.get(`aria-task-${started.id}`)!;
    worker.inject({ type: "activity" });
    await abortStarted.promise;
    runtime.workerAbortGate = undefined;
    // You continue it while that abort is still on its way: the follow-up waits for it.
    await engine.messageTask(started.id, "Follow-up", false);
    await new Promise((r) => setTimeout(r, 50));
    expect(worker.prompts).not.toContain("Follow-up");
    aborting.open();
    await until(() => stateOf(engine, started.id) === "done");
    expect([...worker.transcript.values()].some((e) => e.kind === "assistant" && e.text === "echo: Follow-up")).toBe(true);
  });

  it("doesn't call a task done while a message for it is still on its way", async () => {
    const { make, runtime } = setup();
    const turn = gate();
    runtime.workerScripts.push({ steps: [{ gate: turn.promise }, { message: "First part." }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Two messages", mode: "interactive" });
    await until(() => stateOf(engine, started.id) === "running");
    const held = gate();
    const sending = gate();
    runtime.workerSendGate = (text) => {
      if (text !== "Message A") return undefined;
      sending.open();
      return held.promise;
    };
    const messaging = engine.messageTask(started.id, "Message A", false);
    await sending.promise;
    // The current turn ends while A is on its way: long after a settle would have finished, it isn't done.
    turn.open();
    const worker = runtime.workers.get(`aria-task-${started.id}`)!;
    await until(() => [...worker.transcript.values()].some((e) => e.kind === "assistant" && e.text === "First part."));
    await new Promise((r) => setTimeout(r, 1000));
    expect(stateOf(engine, started.id)).toBe("running");
    held.open();
    await messaging;
    await until(() => stateOf(engine, started.id) === "done");
    expect([...worker.transcript.values()].some((e) => e.kind === "assistant" && e.text === "echo: Message A")).toBe(true);
  });

  it("goes on to the model you picked last when switching to an earlier pick fails", async () => {
    const { make, runtime } = setup();
    const opening = gate();
    runtime.workerOpenGate = opening.promise;
    runtime.workerScripts.push({ steps: [{ complete: "ok" }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Pick, fail, pick" });
    await until(() => runtime.workerOpens > 0);
    await engine.setTaskModel(started.id, "fake-strong", "high");
    const switching = gate();
    const switchStarted = gate();
    runtime.workerSetModelGate = () => {
      switchStarted.open();
      return switching.promise;
    };
    runtime.workerFailSetModel = (model) => model === "fake-strong";
    opening.open();
    await switchStarted.promise;
    runtime.workerSetModelGate = undefined;
    await engine.setTaskModel(started.id, "fake-light", "high");
    switching.open();
    await until(() => stateOf(engine, started.id) === "done");
    const worker = runtime.workers.get(`aria-task-${started.id}`)!;
    expect(worker).toMatchObject({ model: "fake-light", reasoningEffort: "high" });
    expect(task(engine, started.id)).toMatchObject({ model: "fake-light", reasoningEffort: "high" });
    expect(engine.getState().timeline.filter((i) => i.kind === "notice")).toEqual([]);
  });

  // ── round 4 ────────────────────────────────────────────────────────────────────────────────────────────────

  it("doesn't reopen a session while an abort that didn't answer in time is still on its way", async () => {
    const { make, runtime } = setup({ sessionWaitMs: 100 });
    runtime.workerScripts.push({ steps: [{ gate: new Promise<void>(() => {}) }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Slow stop" });
    await until(() => stateOf(engine, started.id) === "running");
    const aborting = gate();
    runtime.workerAbortGate = () => aborting.promise;
    await engine.cancelTask(started.id);
    runtime.workerAbortGate = undefined;
    runtime.workerScripts.push({ steps: [{ complete: "After the stop." }] });
    const opens = vi.spyOn(runtime, "openWorker");
    const continuing = engine.messageTask(started.id, "Go on", false);
    await new Promise((r) => setTimeout(r, 50));
    expect(opens).not.toHaveBeenCalled();
    aborting.open();
    await continuing;
    await until(() => stateOf(engine, started.id) === "done");
    expect(opens).toHaveBeenCalledTimes(1);
  });

  it("starts a task continued right after Stop once the stop is done, even when its session is slow to open", async () => {
    const { make, runtime } = setup({ sessionWaitMs: 100 });
    const opening = gate();
    runtime.workerOpenGate = opening.promise;
    runtime.workerScripts.push({ steps: [{ complete: "Done after all." }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Slow to open" });
    await until(() => task(engine, started.id)?.worktreePath !== undefined);
    const cancelling = engine.cancelTask(started.id);
    await engine.messageTask(started.id, "Go ahead after all", false);
    await cancelling;
    await new Promise((r) => setTimeout(r, 300));
    runtime.workerOpenGate = undefined;
    opening.open();
    await until(() => stateOf(engine, started.id) === "done");
    expect(runtime.workers.get(`aria-task-${started.id}`)!.prompts).toEqual([expect.stringContaining("Slow to open"), "Go ahead after all"]);
  });

  it("lets a continued task finish although a message from before Stop never got through", async () => {
    const { make, runtime } = setup({ sessionWaitMs: 100 });
    runtime.workerScripts.push({ steps: [{ gate: new Promise<void>(() => {}) }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Hung message" });
    await until(() => stateOf(engine, started.id) === "running");
    const sending = gate();
    runtime.workerSendGate = (text) => {
      if (text !== "Lost in transit") return undefined;
      sending.open();
      return new Promise<void>(() => {});
    };
    void engine.messageTask(started.id, "Lost in transit", false).catch(() => {
      // Lost on purpose: what's tested is the cancel that follows.
    });
    await sending.promise;
    await engine.cancelTask(started.id);
    runtime.workerSendGate = undefined;
    runtime.workerScripts.push({ steps: [{ complete: "Finished anyway." }] });
    await engine.messageTask(started.id, "Start over", false);
    await until(() => stateOf(engine, started.id) === "done");
    expect(task(engine, started.id)!.summary).toBe("Finished anyway.");
  });

  it("finishes a task that went quiet while its last message was on its way and then failed to arrive", async () => {
    const { make, runtime } = setup();
    const turn = gate();
    runtime.workerScripts.push({ steps: [{ gate: turn.promise }, { message: "All done." }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Quiet, then a failed send", mode: "interactive" });
    await until(() => stateOf(engine, started.id) === "running");
    const failing = gate();
    const sending = gate();
    runtime.workerSendGate = (text) => {
      if (text !== "One more") return undefined;
      sending.open();
      return failing.promise.then(() => {
        throw new Error("connection lost");
      });
    };
    const messaging = engine.messageTask(started.id, "One more", false);
    await sending.promise;
    turn.open();
    const worker = runtime.workers.get(`aria-task-${started.id}`)!;
    await until(() => [...worker.transcript.values()].some((e) => e.kind === "assistant" && e.text === "All done."));
    await new Promise((r) => setTimeout(r, 100));
    expect(stateOf(engine, started.id)).toBe("running");
    failing.open();
    await expect(messaging).rejects.toThrow(/connection lost/);
    await until(() => stateOf(engine, started.id) === "done");
    expect(task(engine, started.id)!.summary).toBe("All done.");
  });

  // ── Phase 3 ────────────────────────────────────────────────────────────────────────────────────────────────

  it("refuses a permission request from before Stop that's still being looked at when the task runs again", async () => {
    const { make, runtime } = setup();
    runtime.sandboxSupported = false;
    const looking = gate();
    const looked = gate();
    vi.mocked(checkedOutBranch).mockImplementationOnce(async () => {
      looking.open();
      await looked.promise;
      return "aria/push-then-stop";
    });
    const push = "git push origin aria/push-then-stop";
    const ask = (cwd: string) => ({ kind: "shell" as const, command: push, segments: [push], cwd, possiblePaths: [], possibleUrls: [] });
    runtime.workerScripts.push({ steps: [{ tool: "powershell", args: { command: push }, ask }, { complete: "Pushed." }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Push then stop" });
    await looking.promise;
    await engine.cancelTask(started.id);
    const again = gate();
    runtime.workerScripts.push({ steps: [{ gate: again.promise }, { complete: "Second run." }] });
    await engine.messageTask(started.id, "Go on", false);
    await until(() => stateOf(engine, started.id) === "running");
    looked.open();
    const worker = runtime.workers.get(`aria-task-${started.id}`)!;
    await until(() => worker.decisions.length > 0 || cards(engine, "task_permission").length > 0);
    expect(cards(engine, "task_permission")).toEqual([]);
    expect(worker.decisions).toEqual([expect.objectContaining({ approved: false, reason: "The task stopped." })]);
    again.open();
    await until(() => stateOf(engine, started.id) === "done");
  });
});
