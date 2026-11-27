import type { CopilotClient } from "@github/copilot-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CopilotRuntime,
  FakeRuntime,
  AriaEngine,
  Store,
  type WorkerEvent,
} from "../src/index.ts";
import { commitFile, makeRepo, waitMs } from "./helpers.ts";

const temps: string[] = [];
const engines: AriaEngine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.stop()));
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > waitMs(ms)) throw new Error("Condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function setupEnv() {
  const base = mkdtempSync(path.join(os.tmpdir(), "aria-phase9-crash-"));
  temps.push(base);
  const projectsRoot = path.join(base, "GitHub");
  const repoPath = makeRepo(projectsRoot, "Moonrise", "https://github.com/contoso/moonrise.git");
  commitFile(repoPath, "README.md", "# Moonrise\n", "Initial commit");

  const runtime = new FakeRuntime();
  const worktreeRoot = path.join(base, "wt");
  const dataDir = path.join(base, "data");

  const createEngine = () => {
    const engine = new AriaEngine({
      dataDir,
      runtime,
      projectRoots: [projectsRoot],
      worktreeRoot,
      resumeSettleMs: 10,
      taskSettleMs: 20,
      autopilotGraceMs: 150,
    });
    engines.push(engine);
    return engine;
  };

  return { base, projectsRoot, repoPath, runtime, worktreeRoot, dataDir, createEngine };
}

describe("Phase 9: Crash recovery, WAL checkpoint, cloud reconciliation, and corrupted session recovery", () => {
  it("runs PRAGMA wal_checkpoint(TRUNCATE) in Store.close() and preserves tasks, outbox, and waiting_budget B-1 across restarts", async () => {
    const { runtime, createEngine } = setupEnv();

    let releaseTask1!: () => void;
    const gate1 = new Promise<void>((res) => {
      releaseTask1 = res;
    });
    let releaseTask2!: () => void;
    const gate2 = new Promise<void>((res) => {
      releaseTask2 = res;
    });

    runtime.workerScriptFor = (prompt) => {
      if (prompt.includes("ARIA was closed while you were working")) {
        return { steps: [{ message: "Recovered and finished." }, { complete: "Recovered task 1" }] };
      }
      if (prompt.includes("Follow-up after crash")) {
        return { steps: [{ complete: "Processed queued outbox message" }] };
      }
      if (prompt.includes("Running local task")) {
        return { steps: [{ intent: "Editing files" }, { gate: gate1 }] };
      }
      if (prompt.includes("Budget paused task")) {
        return { steps: [{ usage: 5 }, { gate: gate2 }] };
      }
      return { steps: [{ complete: "Done" }] };
    };

    const engine1 = createEngine();
    await engine1.start();

    const defaultProfile = engine1.getState().profiles.find((p) => p.isDefault)!;
    await engine1.saveProfile({
      id: defaultProfile.id,
      name: defaultProfile.name,
      model: defaultProfile.model,
      ...(defaultProfile.reasoningEffort ? { reasoningEffort: defaultProfile.reasoningEffort } : {}),
      mode: "autopilot",
      budgetCredits: 5,
    });

    const project = engine1.getState().projects[0]!;
    const task1 = await engine1.startTask({
      repoId: project.id,
      title: "Running local task",
      brief: "Running local task brief",
    });
    const task2 = await engine1.startTask({
      repoId: project.id,
      title: "Budget paused task",
      brief: "Budget paused task brief",
    });

    await until(() => engine1.getState().tasks.find((t) => t.id === task1.id)?.state === "running");
    await until(() => engine1.getState().tasks.find((t) => t.id === task2.id)?.state === "waiting_budget");

    // Queue an outbox message on task2 while it is paused at budget
    await engine1.messageTask(task2.id, "Follow-up after crash", false);

    // Stop engine1 (simulating app close / crash while task1 is running and task2 is waiting_budget)
    await engine1.stop();
    engines.pop();
    releaseTask1();
    releaseTask2();

    // Restart engine2
    const engine2 = createEngine();
    await engine2.start();

    const state2 = engine2.getState();
    const recovered1 = state2.tasks.find((t) => t.id === task1.id)!;
    const recovered2 = state2.tasks.find((t) => t.id === task2.id)!;

    // task1 is marked interrupted and listed in tasks_interrupted card
    expect(recovered1.state).toBe("interrupted");
    expect(recovered1.intent).toBeUndefined();
    const interruptedCards = state2.timeline.filter(
      (i) => i.kind === "card" && i.cardType === "tasks_interrupted",
    );
    expect(interruptedCards).toHaveLength(1);
    expect(
      interruptedCards[0]?.kind === "card" && interruptedCards[0].cardType === "tasks_interrupted"
        ? interruptedCards[0].payload.taskIds
        : [],
    ).toContain(task1.id);

    // task2 stays waiting_budget and receives a fresh B-1 shortId
    expect(recovered2.state).toBe("waiting_budget");
    expect(recovered2.budgetShortId).toBe("B-1");

    // Resume interrupted task1 -> prepends continuation prompt and completes
    engine2.resumeInterrupted();
    await until(() => engine2.getState().tasks.find((t) => t.id === task1.id)?.state === "done");
  });

  it("marks cloud tasks in state 'starting' without a sessionId as interrupted, while reconciling cloud tasks with a sessionId (including those completed while offline)", async () => {
    const { runtime, dataDir, createEngine } = setupEnv();

    let releaseCloudRunning!: () => void;
    const cloudGate = new Promise<void>((res) => {
      releaseCloudRunning = res;
    });

    runtime.workerScriptFor = (prompt) => {
      if (prompt.includes("Cloud task completing offline")) {
        return { steps: [{ intent: "Running in cloud" }, { gate: cloudGate }, { complete: "Finished on Mission Control while PC was off" }] };
      }
      return { steps: [{ complete: "Done" }] };
    };

    const engine1 = createEngine();
    await engine1.start();
    const project = engine1.getState().projects[0]!;

    const cloudTask = await engine1.startTask({
      repoId: project.id,
      title: "Cloud task completing offline",
      brief: "Cloud task completing offline",
      where: "cloud",
    });
    await until(() => engine1.getState().tasks.find((t) => t.id === cloudTask.id)?.state === "running");

    // Stop engine1 while cloudTask is running
    await engine1.stop();
    engines.pop();

    // Seed a cloud task in state "starting" WITHOUT a sessionId directly in SQLite (simulating crash before openWorker returned)
    const store = new Store(path.join(dataDir, "aria.db"));
    const now = Date.now();
    store.saveTask({
      id: "cloud-starting-no-session",
      title: "Cloud task crashed during start",
      brief: "Start cloud task",
      repoId: project.id,
      repoName: project.name,
      repoPath: project.path,
      baseBranch: "main",
      where: "cloud",
      cloudRepo: { owner: "contoso", name: "moonrise", branch: "main" },
      profileId: "default",
      profileName: "Default",
      model: "fake-light",
      mode: "autopilot",
      state: "starting",
      startedBy: "you",
      createdAt: now,
      updatedAt: now,
      costNano: 0,
      archived: false,
    });
    store.close();

    // Let the running cloud task finish on Mission Control while ARIA is offline!
    releaseCloudRunning();
    await new Promise((r) => setTimeout(r, 40));

    // Start engine2 -> cloud-starting-no-session is marked interrupted; cloudTask with sessionId reconciles and transitions to done!
    const engine2 = createEngine();
    await engine2.start();

    await until(() => engine2.getState().tasks.find((t) => t.id === cloudTask.id)?.state === "done");

    const tasksAfter = engine2.getState().tasks;
    const noSessionTask = tasksAfter.find((t) => t.id === "cloud-starting-no-session")!;
    expect(noSessionTask.state).toBe("interrupted");

    const finishedCloud = tasksAfter.find((t) => t.id === cloudTask.id)!;
    expect(finishedCloud.state).toBe("done");
    expect(finishedCloud.summary).toContain("Finished on Mission Control while PC was off");
  });

  it("recovers from a corrupted SDK worker session in CopilotRuntime.openWorker by deleting the session, emitting resume_failed warning, and creating a fresh session (resumed = false)", async () => {
    const createSessionMock = vi.fn();
    const deleteSessionMock = vi.fn(async () => {});
    const resumeSessionMock = vi.fn(async () => {
      throw new Error("Unexpected end of JSON input in session file");
    });

    const freshSession = {
      sessionId: "corrupted-worker-1",
      rpc: {
        options: { update: vi.fn(async () => ({ success: true })) },
        mode: { set: vi.fn(async () => ({})) },
        model: { setAllowedModels: vi.fn(async () => ({})) },
        agent: { list: vi.fn(async () => ({ agents: [] })) },
        tools: { updateSubagentSettings: vi.fn(async () => ({})) },
      },
      send: vi.fn(async () => "msg-fresh"),
      getEvents: vi.fn(async () => []),
      abort: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
    };
    createSessionMock.mockResolvedValue(freshSession);

    const client = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => []),
      forceStop: vi.fn(async () => {}),
      getSessionMetadata: vi.fn(async () => ({ id: "corrupted-worker-1" })), // exists!
      createSession: createSessionMock,
      resumeSession: resumeSessionMock,
      deleteSession: deleteSessionMock,
    };

    const copilotRuntime = new CopilotRuntime(() => client as unknown as CopilotClient);
    await copilotRuntime.start();

    const events: WorkerEvent[] = [];
    const handle = await copilotRuntime.openWorker({
      sessionId: "corrupted-worker-1",
      name: "ARIA · Corrupted Task",
      model: "claude-haiku-5.5",
      mode: "autopilot",
      workingDirectory: "C:\\wt\\moonrise\\corrupted",
      availableTools: [],
      disabledMcpServers: [],
      policy: { decide: () => ({ approve: true }) },
      onQuestion: async () => ({ answer: "", wasFreeform: true }),
      onPlan: async () => ({ approved: true }),
      onEvent: (e) => events.push(e),
    });

    expect(resumeSessionMock).toHaveBeenCalledTimes(1);
    expect(deleteSessionMock).toHaveBeenCalledWith("corrupted-worker-1");
    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(handle.resumed).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        warningType: "resume_failed",
      }),
    );
  });

  it("sends LOST_SESSION + brief when retrying a task whose SDK session was corrupted/recreated, and sweeps orphaned helper sessions on startup", async () => {
    const { runtime, dataDir, createEngine } = setupEnv();

    let gateResolve!: () => void;
    const gate = new Promise<void>((res) => {
      gateResolve = res;
    });

    const receivedPrompts: string[] = [];
    runtime.workerScriptFor = (prompt) => {
      receivedPrompts.push(prompt);
      if (receivedPrompts.length === 1) {
        return { steps: [{ intent: "Initial run" }, { gate }] };
      }
      return { steps: [{ complete: "Completed after session recovery" }] };
    };

    const engine1 = createEngine();
    await engine1.start();
    const project = engine1.getState().projects[0]!;
    const task = await engine1.startTask({
      repoId: project.id,
      title: "Corrupted session task",
      brief: "Implement feature Z in Moonrise",
    });

    await until(() => engine1.getState().tasks.find((t) => t.id === task.id)?.state === "running");
    await engine1.stop();
    engines.pop();
    gateResolve();

    // Mark the worker session as corrupted in FakeRuntime and plant an orphaned helper session ID in settings
    runtime.corruptedWorkerSessions.add(`aria-task-${task.id}`);
    const store = new Store(path.join(dataDir, "aria.db"));
    store.setSetting("integrations.helpers", ["aria-integrations-deadbeef1234567890abcdef"]);
    store.close();

    const engine2 = createEngine();
    await engine2.start();

    // Orphaned helper session was swept on startup
    expect(runtime.deletedSessions).toContain("aria-integrations-deadbeef1234567890abcdef");

    // Resume interrupted task -> openWorker recovers from corrupted session (resumed = false) and sends LOST_SESSION + brief
    engine2.retryTask(task.id);
    await until(() => engine2.getState().tasks.find((t) => t.id === task.id)?.state === "done");

    expect(receivedPrompts.length).toBeGreaterThanOrEqual(2);
    expect(receivedPrompts[1]).toContain("Your earlier session for this task is gone");
    expect(receivedPrompts[1]).toContain("Implement feature Z in Moonrise");
  });
});
