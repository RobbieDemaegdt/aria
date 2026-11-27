import type { CopilotClient } from "@github/copilot-sdk";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CopilotRuntime,
  extractMissionControlUrl,
  FakeRuntime,
  AriaEngine,
  type WorkerConfig,
  type WorkerEvent,
  type WorkerSandbox,
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

function createMockCloudClient(options: {
  existingSession?: boolean;
  preExistingEvents?: unknown[];
} = {}) {
  const sentPrompts: Array<{ prompt: string; mode?: string }> = [];
  let onEventHandler: ((event: any) => void) | undefined;
  let createConfig: Record<string, any> | undefined;
  let resumeConfig: Record<string, any> | undefined;
  const eventsLog: unknown[] = [...(options.preExistingEvents ?? [])];

  const session = {
    sessionId: "cloud-session-42",
    rpc: {
      options: { update: vi.fn(async () => ({ success: true })) },
      mode: { set: vi.fn(async () => ({})) },
      model: { setAllowedModels: vi.fn(async () => ({})) },
      agent: { list: vi.fn(async () => ({ agents: [] })) },
      tools: { updateSubagentSettings: vi.fn(async () => ({})) },
    },
    send: vi.fn(async (arg: { prompt: string; mode?: string }) => {
      sentPrompts.push(arg);
      return "msg-id";
    }),
    getEvents: vi.fn(async () => eventsLog),
    abort: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  };

  const client = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => []),
    forceStop: vi.fn(async () => {}),
    getSessionMetadata: vi.fn(async () => (options.existingSession ? { id: session.sessionId } : undefined)),
    createSession: vi.fn(async (cfg: Record<string, any>) => {
      createConfig = cfg;
      onEventHandler = cfg.onEvent;
      return session;
    }),
    resumeSession: vi.fn(async (_id: string, cfg: Record<string, any>) => {
      resumeConfig = cfg;
      onEventHandler = cfg.onEvent;
      return session;
    }),
    deleteSession: vi.fn(async () => {}),
  };

  return {
    client,
    session,
    sentPrompts,
    createConfig: () => createConfig,
    resumeConfig: () => resumeConfig,
    emitSdkEvent: (ev: any) => {
      eventsLog.push(ev);
      onEventHandler?.(ev);
    },
  };
}

function baseWorkerConfig(extra: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    sessionId: "cloud-session-42",
    name: "ARIA · Cloud Task",
    model: "claude-haiku-5.5",
    mode: "autopilot",
    availableTools: [],
    disabledMcpServers: [],
    policy: { decide: () => ({ approve: true }) },
    onQuestion: async () => ({ answer: "", wasFreeform: true }),
    onPlan: async () => ({ approved: true }),
    onEvent: () => {},
    ...extra,
  };
}

describe("Phase 8A: CopilotRuntime cloud & remote sessions (D71, D72)", () => {
  it("extracts and validates Mission Control URLs with sessionId fallback", () => {
    expect(
      extractMissionControlUrl("https://github.com/copilot/tasks/abc-123", undefined, "abc-123"),
    ).toBe("https://github.com/copilot/tasks/abc-123");

    expect(
      extractMissionControlUrl(undefined, "View session at https://github.com/copilot/tasks/xyz-99.", "xyz-99"),
    ).toBe("https://github.com/copilot/tasks/xyz-99");

    // Rejects non-https or embedded credentials and falls back to canonical Mission Control task URL
    expect(
      extractMissionControlUrl("http://evil.example/task", undefined, "sess-77"),
    ).toBe("https://github.com/copilot/tasks/sess-77");
    expect(
      extractMissionControlUrl("https://user:pass@github.com/copilot/tasks/sess-77", undefined, "sess-77"),
    ).toBe("https://github.com/copilot/tasks/sess-77");
  });

  it("opens cloud sessions with cloud repository & streaming, omits name/workingDirectory/sandbox, and waits for copilot-agent session.start", async () => {
    const mock = createMockCloudClient();
    const runtime = new CopilotRuntime(() => mock.client as unknown as CopilotClient);
    await runtime.start();

    const workerEvents: WorkerEvent[] = [];
    const handle = await runtime.openWorker(
      baseWorkerConfig({
        cloud: { repository: { owner: "contoso", name: "moonrise", branch: "main" } },
        onEvent: (e) => workerEvents.push(e),
      }),
    );

    const cfg = mock.createConfig()!;
    expect(cfg.cloud).toEqual({ repository: { owner: "contoso", name: "moonrise", branch: "main" } });
    expect(cfg.streaming).toBe(true);
    expect(cfg.name).toBeUndefined();
    expect(cfg.workingDirectory).toBeUndefined();
    expect(mock.session.rpc.options.update).not.toHaveBeenCalled();

    // First send waits for session.start with producer === "copilot-agent"
    let sendResolved = false;
    const sendPromise = handle.send("Implement feature X").then(() => {
      sendResolved = true;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(sendResolved).toBe(false);
    expect(mock.sentPrompts).toHaveLength(0);

    // Non-copilot-agent session.start does not release the gate
    mock.emitSdkEvent({
      id: "ev-0",
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "session.start",
      data: { producer: "local-host" },
    });
    await new Promise((r) => setTimeout(r, 15));
    expect(sendResolved).toBe(false);

    // Emit remote_info event via session.info (infoType === "remote")
    mock.emitSdkEvent({
      id: "ev-info",
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "session.info",
      data: {
        infoType: "remote",
        url: "https://github.com/copilot/tasks/cloud-session-42",
        message: "Running on Mission Control",
      },
    });
    expect(workerEvents).toContainEqual({
      type: "remote_info",
      url: "https://github.com/copilot/tasks/cloud-session-42",
      message: "Running on Mission Control",
    });

    // Emit session.start from copilot-agent -> unblocks send()
    mock.emitSdkEvent({
      id: "ev-start",
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "session.start",
      data: { producer: "copilot-agent" },
    });
    await sendPromise;
    expect(sendResolved).toBe(true);
    expect(mock.sentPrompts).toEqual([{ prompt: "Implement feature X", mode: "enqueue" }]);
  });

  it("checks live.getEvents() first so if session.start already arrived during createSession, send() resolves immediately without freezing", async () => {
    const mock = createMockCloudClient({
      preExistingEvents: [
        {
          id: "ev-pre-start",
          parentId: null,
          timestamp: new Date().toISOString(),
          type: "session.start",
          data: { producer: "copilot-agent" },
        },
        {
          id: "ev-pre-info",
          parentId: null,
          timestamp: new Date().toISOString(),
          type: "session.info",
          data: {
            infoType: "remote",
            url: "https://github.com/copilot/tasks/pre-existing-42",
          },
        },
      ],
    });
    const runtime = new CopilotRuntime(() => mock.client as unknown as CopilotClient);
    await runtime.start();

    const workerEvents: WorkerEvent[] = [];
    const handle = await runtime.openWorker(
      baseWorkerConfig({
        cloud: { repository: { owner: "contoso", name: "moonrise" } },
        cloudStartTimeoutMs: 60_000,
        onEvent: (e) => workerEvents.push(e),
      }),
    );

    expect(workerEvents).toContainEqual({
      type: "remote_info",
      url: "https://github.com/copilot/tasks/pre-existing-42",
    });

    const t0 = Date.now();
    await handle.send("Immediate prompt");
    expect(Date.now() - t0).toBeLessThan(500);
    expect(mock.sentPrompts).toEqual([{ prompt: "Immediate prompt", mode: "enqueue" }]);
  });

  it("rejects send() when session.start (producer === 'copilot-agent') does not arrive within cloudStartTimeoutMs", async () => {
    const mock = createMockCloudClient();
    const runtime = new CopilotRuntime(() => mock.client as unknown as CopilotClient);
    await runtime.start();

    const handle = await runtime.openWorker(
      baseWorkerConfig({
        cloud: { repository: { owner: "contoso", name: "moonrise" } },
        cloudStartTimeoutMs: 40,
      }),
    );

    await expect(handle.send("Will time out")).rejects.toThrow(
      /Timed out waiting for the cloud session to start on Mission Control/i,
    );
    expect(mock.sentPrompts).toHaveLength(0);
  });

  it("resumes an existing cloud session without re-passing cloud config", async () => {
    const mock = createMockCloudClient({ existingSession: true });
    const runtime = new CopilotRuntime(() => mock.client as unknown as CopilotClient);
    await runtime.start();

    const handle = await runtime.openWorker(
      baseWorkerConfig({
        cloud: { repository: { owner: "contoso", name: "moonrise" } },
      }),
    );

    expect(handle.resumed).toBe(true);
    expect(mock.client.resumeSession).toHaveBeenCalledTimes(1);
    expect(mock.resumeConfig()?.cloud).toBeUndefined();
    expect(mock.resumeConfig()?.streaming).toBe(true);

    await handle.send("Continue work");
    expect(mock.sentPrompts).toEqual([{ prompt: "Continue work", mode: "enqueue" }]);
  });

  it("passes remote: true and remoteSession: 'on' for local remote-enabled tasks while keeping worktree and sandbox", async () => {
    const mock = createMockCloudClient();
    const runtime = new CopilotRuntime(() => mock.client as unknown as CopilotClient);
    await runtime.start();

    const sandbox: WorkerSandbox = {
      readwrite: ["C:\\wt\\repo\\task"],
      readonly: ["C:\\repo\\.git"],
      allowedHosts: ["registry.npmjs.org"],
      blockedHosts: ["127.0.0.1"],
      initScript: "C:\\wt\\.aria\\sandbox\\aria-env.ps1",
      processFlags: ["-NoProfile"],
    };

    const workerEvents: WorkerEvent[] = [];
    await runtime.openWorker(
      baseWorkerConfig({
        workingDirectory: "C:\\wt\\repo\\task",
        remote: true,
        sandbox,
        onEvent: (e) => workerEvents.push(e),
      }),
    );

    const cfg = mock.createConfig()!;
    expect(cfg.remote).toBe(true);
    expect(cfg.remoteSession).toBe("on");
    expect(cfg.workingDirectory).toBe("C:\\wt\\repo\\task");
    expect(cfg.name).toBe("ARIA · Cloud Task");
    expect(mock.session.rpc.options.update).toHaveBeenCalledTimes(1);

    mock.emitSdkEvent({
      id: "ev-remote-local",
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "session.info",
      data: {
        infoType: "remote",
        url: "https://github.com/copilot/tasks/local-remote-1",
      },
    });
    expect(workerEvents).toContainEqual({
      type: "remote_info",
      url: "https://github.com/copilot/tasks/local-remote-1",
    });
  });

  it("passes remoteSession: 'off' for local tasks when remote is not enabled", async () => {
    const mock = createMockCloudClient();
    const runtime = new CopilotRuntime(() => mock.client as unknown as CopilotClient);
    await runtime.start();

    await runtime.openWorker(
      baseWorkerConfig({
        workingDirectory: "C:\\wt\\repo\\task",
      }),
    );

    const cfg = mock.createConfig()!;
    expect(cfg.remote).toBeUndefined();
    expect(cfg.remoteSession).toBe("off");
  });
});

describe("Phase 8A: TaskManager & AriaEngine cloud & remote task lifecycle", () => {
  function setupEngine(options: { maxConcurrentTasks?: number } = {}) {
    const base = mkdtempSync(path.join(os.tmpdir(), "aria-phase8a-"));
    temps.push(base);
    const projectsRoot = path.join(base, "GitHub");
    const ghRepo = makeRepo(projectsRoot, "Moonrise", "https://github.com/contoso/moonrise.git");
    commitFile(ghRepo, "README.md", "# Moonrise\n", "Initial commit");
    const localOnlyRepo = makeRepo(projectsRoot, "LocalOnly");
    commitFile(localOnlyRepo, "README.md", "# LocalOnly\n", "Initial commit");

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
        ...options,
      });
      engines.push(engine);
      return engine;
    };

    return { base, projectsRoot, ghRepo, localOnlyRepo, runtime, worktreeRoot, dataDir, createEngine };
  }

  it("runs a cloud task without creating a local worktree, records missionControlUrl, supports transcript & synthetic diff, and handles open_pr", async () => {
    const { runtime, worktreeRoot, createEngine } = setupEngine();
    runtime.workerScripts.push({
      steps: [
        { intent: "Running tests in cloud container" },
        {
          tool: "powershell",
          args: { command: "npm test" },
          ask: (cwd) => ({
            kind: "shell",
            command: "npm test",
            segments: ["npm test"],
            cwd,
            possiblePaths: [],
            possibleUrls: [],
          }),
        },
        { message: "All cloud tests passed." },
        { complete: "Implemented cloud feature and verified tests on Mission Control." },
      ],
    });

    const engine = createEngine();
    await engine.start();

    const moonrise = engine.getState().projects.find((p) => p.name === "Moonrise")!;
    const localOnly = engine.getState().projects.find((p) => p.name === "LocalOnly")!;

    // Local-only project without GitHub owner/repo is rejected for cloud execution
    await expect(
      engine.startTask({
        repoId: localOnly.id,
        title: "Invalid cloud task",
        brief: "Try running in cloud",
        where: "cloud",
      }),
    ).rejects.toThrow(/has no GitHub repository/i);

    // Start valid cloud task on Moonrise
    const started = await engine.startTask({
      repoId: moonrise.id,
      title: "Cloud telemetry audit",
      brief: "Audit telemetry spans in the cloud.",
      where: "cloud",
    });

    await until(() => engine.getState().tasks.find((t) => t.id === started.id)?.state === "done");

    const doneTask = engine.getState().tasks.find((t) => t.id === started.id)!;
    expect(doneTask.where).toBe("cloud");
    expect(doneTask.worktreePath).toBeUndefined();
    expect(doneTask.cleanedUp).toBeFalsy();
    expect(doneTask.cloudRepo).toEqual({
      owner: "contoso",
      name: "moonrise",
      branch: "main",
    });
    expect(doneTask.missionControlUrl).toMatch(/^https:\/\/github\.com\/copilot\/tasks\//);
    expect(existsSync(path.join(worktreeRoot, "moonrise"))).toBe(false);

    // Transcript works without worktreePath
    const transcript = await engine.getTranscript(doneTask.id);
    expect(transcript.some((e) => e.kind === "assistant" && e.text.includes("All cloud tests passed."))).toBe(true);

    // Search indexes cloud task transcripts
    const searchRes = await engine.search({ query: "All cloud tests passed", scope: "transcripts" });
    expect(searchRes.transcripts.some((h) => h.taskId === doneTask.id)).toBe(true);

    // Diff returns synthetic TaskDiff pointing to Mission Control URL
    const diff = await engine.getTaskDiff(doneTask.id);
    expect(diff.truncated).toBe(false);
    expect(diff.text).toContain("Mission Control");
    expect(diff.text).toContain(doneTask.missionControlUrl!);

    // Conductor open_pr tool directs user to Mission Control for cloud tasks
    runtime.replies.push({
      toolCalls: [{ name: "open_pr", args: { task: "Cloud telemetry audit" } }],
      text: (_p, results) => JSON.stringify(results[0]),
    });
    await engine.sendMessage("Open a PR for Cloud telemetry audit");
    await until(() => engine.getState().status.state === "ready");
    const lastChat = engine
      .getState()
      .timeline.filter((i) => i.kind === "chat" && i.role === "assistant")
      .at(-1);
    expect(lastChat && lastChat.kind === "chat" ? lastChat.content : "").toContain("Mission Control");

    // Discarding a cloud task deletes its session without touching local git worktrees
    await engine.discardTask(doneTask.id);
    expect(engine.getState().tasks.find((t) => t.id === doneTask.id)).toBeUndefined();
    expect(runtime.deletedSessions.some((s) => s.includes(doneTask.id))).toBe(true);
  });

  it("does not block cloud tasks on local worktree concurrency limits, excludes active cloud tasks from markInterrupted, and fails on policy_blocked", async () => {
    const { runtime, createEngine } = setupEngine({ maxConcurrentTasks: 1 });

    let releaseLocal!: () => void;
    const localGate = new Promise<void>((res) => {
      releaseLocal = res;
    });
    let releaseCloud!: () => void;
    const cloudGate = new Promise<void>((res) => {
      releaseCloud = res;
    });

    runtime.workerScriptFor = (prompt) => {
      if (prompt.includes("Local blocker")) {
        return { steps: [{ intent: "Working locally" }, { gate: localGate }, { complete: "Local done" }] };
      }
      if (prompt.includes("Cloud runner")) {
        return { steps: [{ intent: "Working in cloud" }, { gate: cloudGate }, { complete: "Cloud done" }] };
      }
      return { steps: [{ complete: "Done" }] };
    };

    const engine = createEngine();
    await engine.start();
    const moonrise = engine.getState().projects.find((p) => p.name === "Moonrise")!;

    const localTask = await engine.startTask({
      repoId: moonrise.id,
      title: "Local blocker",
      brief: "Local blocker task",
      where: "local",
      remote: true,
    });
    await until(() => engine.getState().tasks.find((t) => t.id === localTask.id)?.state === "running");
    expect(engine.getState().tasks.find((t) => t.id === localTask.id)?.remote).toBe(true);
    expect(engine.getState().tasks.find((t) => t.id === localTask.id)?.missionControlUrl).toContain(
      "https://github.com/copilot/tasks/",
    );

    // Even with maxConcurrentTasks = 1 and localTask running, cloudTask launches immediately!
    const cloudTask = await engine.startTask({
      repoId: moonrise.id,
      title: "Cloud runner",
      brief: "Cloud runner task",
      where: "cloud",
    });
    await until(() => engine.getState().tasks.find((t) => t.id === cloudTask.id)?.state === "running");

    // Stop engine while both localTask and cloudTask are running, then restart:
    // markInterrupted() marks localTask as "interrupted" but leaves cloudTask untouched!
    await engine.stop();
    engines.pop();

    const engine2 = createEngine();
    await engine2.start();
    const tasksAfterRestart = engine2.getState().tasks;
    expect(tasksAfterRestart.find((t) => t.id === localTask.id)?.state).toBe("interrupted");
    expect(tasksAfterRestart.find((t) => t.id === cloudTask.id)?.state).toBe("running");

    releaseLocal();
    releaseCloud();

    // Verify policy_blocked warning fails a cloud task immediately
    runtime.cloudPolicyBlocked = "Cloud agent execution is disabled by organization policy.";
    const blockedTask = await engine2.startTask({
      repoId: moonrise.id,
      title: "Blocked cloud task",
      brief: "Should fail on policy_blocked",
      where: "cloud",
    });
    await until(() => engine2.getState().tasks.find((t) => t.id === blockedTask.id)?.state === "failed");
    expect(engine2.getState().tasks.find((t) => t.id === blockedTask.id)?.error).toContain(
      "disabled by organization policy",
    );
  });
});
