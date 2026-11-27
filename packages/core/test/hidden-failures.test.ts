/**
 * Failures that used to go nowhere: each one is logged or shown now, and what it belonged to carries on. A push or a
 * Telegram message that doesn't go out, and a workflow dispatch that can't read the runs first, are with the rest of
 * their tests (phase8b-phone-telegram.test.ts, watchers.test.ts).
 */
import type { CopilotClient } from "@github/copilot-sdk";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Task } from "@aria/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopilotRuntime, FakeRuntime, AriaEngine, type EngineOptions, type WorkerConfig, type WorkerEvent } from "../src/index.ts";
import { commitFile, makeRepo, waitMs } from "./helpers.ts";

const temps: string[] = [];
const engines: AriaEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.stop()));
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function setup() {
  const base = mkdtempSync(path.join(os.tmpdir(), "aria-silent-failures-"));
  temps.push(base);
  const projects = path.join(base, "GitHub");
  const repo = makeRepo(projects, "Moonrise", "https://github.com/contoso/moonrise.git");
  commitFile(repo, "README.md", "# Moonrise\n", "Initial commit");
  const runtime = new FakeRuntime();
  const logs: string[] = [];
  const make = (options: Partial<EngineOptions> = {}) => {
    const engine = new AriaEngine({
      dataDir: path.join(base, "data"),
      runtime,
      projectRoots: [projects],
      worktreeRoot: path.join(base, "wt"),
      resumeSettleMs: 10,
      taskSettleMs: 20,
      autopilotGraceMs: 150,
      shutdownWaitMs: 50,
      sessionWaitMs: 50,
      log: (line) => logs.push(line),
      ...options,
    });
    engines.push(engine);
    return engine;
  };
  return { base, runtime, logs, make };
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > waitMs(ms)) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const repoId = (engine: AriaEngine) => engine.getState().projects[0]!.id;
const task = (engine: AriaEngine, id: string) => engine.getState().tasks.find((t) => t.id === id);
const stateOf = (engine: AriaEngine, id: string) => task(engine, id)?.state;
const worker = (runtime: FakeRuntime, t: Task) => runtime.workers.get(`aria-task-${t.id}`)!;
const notices = (engine: AriaEngine, cause: string) => engine.getState().timeline.filter((i) => i.kind === "notice" && i.cause === cause);

describe("tasks", () => {
  it("tells you when a session stays in plan mode after you approved its plan, and it still gets on with it", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [{ planFile: "1. Add the toggle" }, { message: "Here's the plan." }] });
    runtime.workerScripts.push({ steps: [{ complete: "Added the toggle." }] });
    runtime.workerFailSetMode = true;
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Dark mode", mode: "plan" });
    await until(() => stateOf(engine, started.id) === "waiting_plan");

    await engine.reviewPlan(started.id, task(engine, started.id)!.plan!.id, "autopilot");

    expect(notices(engine, "mode_switch_failed")).toHaveLength(1);
    expect(worker(runtime, started).mode).toBe("plan");
    expect(worker(runtime, started).prompts.at(-1)).toMatch(/plan is approved/);
  });

  it("logs a session's warning", async () => {
    const { make, runtime, logs } = setup();
    let release!: () => void;
    runtime.workerScripts.push({ steps: [{ gate: new Promise<void>((resolve) => (release = resolve)) }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: repoId(engine), brief: "Dark mode" });
    await until(() => stateOf(engine, started.id) === "running");

    worker(runtime, started).inject({ type: "warning", message: "Couldn't pin the sub-agents to a-model" });

    expect(logs.filter((line) => line.includes("Couldn't pin the sub-agents to a-model"))).toHaveLength(1);
    release();
  });

  it("tells you when stopping a cloud task can't close its session, which may still be running", async () => {
    const { make, runtime } = setup();
    let releaseTurn!: () => void;
    runtime.workerScripts.push({ steps: [{ gate: new Promise<void>((resolve) => (releaseTurn = resolve)) }] });
    const first = make();
    await first.start();
    const started = await first.startTask({ repoId: repoId(first), brief: "Audit the telemetry", where: "cloud" });
    await until(() => stateOf(first, started.id) === "running");
    await first.stop();

    // Its session stays on GitHub across the restart, and this time ARIA doesn't get as far as opening it.
    let releaseOpen!: () => void;
    runtime.workerOpenGate = new Promise<void>((resolve) => (releaseOpen = resolve));
    runtime.failDeleteSession = true;
    const second = make();
    await second.start();
    await until(() => runtime.workerOpens === 2);

    await second.cancelTask(started.id);

    expect(notices(second, "cloud_cancel_failed")).toHaveLength(1);
    releaseOpen();
    releaseTurn();
  });
});

describe("integrations", () => {
  it("tells you when keeping in sync with the Copilot CLI can't read its servers", async () => {
    const { base, make } = setup();
    const cliConfig = path.join(base, "mcp-config.json");
    writeFileSync(cliConfig, "{ not json");
    const engine = make({ cliMcpConfigPath: cliConfig });
    await engine.start();

    const state = await engine.setMcpKeepInSync({ keepInSync: true });

    expect(state.keepInSync).toBe(true);
    expect(notices(engine, "mcp_sync_failed")).toHaveLength(1);
  });

  it("tells you when the running session can't follow a skill you turned off, and keeps your choice", async () => {
    const { make, runtime } = setup();
    runtime.setSkillEnabled = async () => {
      throw new Error("fake: can't change skills");
    };
    const engine = make();
    await engine.start();

    const state = await engine.setSkillEnabled({ name: "some-skill", enabled: false });

    expect(state.disabledSkills).toContain("some-skill");
    expect(notices(engine, "skill_toggle_failed")).toHaveLength(1);
  });
});

describe("the engine's steps", () => {
  it("logs a runtime that fails to stop", async () => {
    const { make, runtime, logs } = setup();
    runtime.stop = async () => {
      throw new Error("fake: stuck");
    };
    const engine = make();
    await engine.start();

    await engine.stop();

    expect(logs.some((line) => line.includes("Stopping the runtime failed: fake: stuck"))).toBe(true);
  });
});

describe("the Copilot runtime", () => {
  async function open(config: Partial<WorkerConfig> = {}, modeSet = vi.fn(async () => ({}))) {
    let onEvent: ((event: unknown) => void) | undefined;
    const session = {
      sessionId: "worker-1",
      rpc: {
        options: { update: vi.fn(async () => ({ success: true })) },
        mode: { set: modeSet },
        model: { setAllowedModels: vi.fn(async () => ({})) },
        agent: { list: vi.fn(async () => ({ agents: [] as Array<{ name: string }> })) },
        tools: { updateSubagentSettings: vi.fn(async () => ({})) },
        ui: { handlePendingSessionLimitsExhausted: vi.fn(async () => ({})) },
      },
      setModel: vi.fn(async () => {}),
      send: vi.fn(async () => "msg-1"),
      getEvents: vi.fn(async () => []),
      abort: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
    };
    const client = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => []),
      forceStop: vi.fn(async () => {}),
      getSessionMetadata: vi.fn(async () => undefined),
      createSession: vi.fn(async (cfg: { onEvent?: (event: unknown) => void }) => {
        onEvent = cfg.onEvent;
        return session;
      }),
      resumeSession: vi.fn(async () => session),
      deleteSession: vi.fn(async () => {}),
    };
    const runtime = new CopilotRuntime(() => client as unknown as CopilotClient);
    await runtime.start();
    const events: WorkerEvent[] = [];
    const handle = await runtime.openWorker({
      sessionId: "worker-1",
      name: "ARIA · A task",
      model: "a-model",
      mode: "plan",
      workingDirectory: "C:\\wt\\moonrise\\task",
      availableTools: [],
      disabledMcpServers: [],
      policy: { decide: () => ({ approve: true }) },
      onQuestion: async () => ({ answer: "", wasFreeform: true }),
      onPlan: async () => ({ approved: true }),
      onEvent: (event) => events.push(event),
      ...config,
    });
    const warnings = () => events.flatMap((event) => (event.type === "warning" ? [event.message] : []));
    return { session, handle, warnings, emit: (event: unknown) => onEvent?.(event) };
  }

  it("lets the caller know a mode switch failed", async () => {
    const { session, handle } = await open();
    session.rpc.mode.set.mockRejectedValueOnce(new Error("fake: no such mode"));
    await expect(handle.setMode!("autopilot")).rejects.toThrow("fake: no such mode");
  });

  it("warns when a model switch can't pin the sub-agents, as opening a session does", async () => {
    const { session, handle, warnings } = await open();
    session.rpc.agent.list.mockRejectedValueOnce(new Error("fake: no agents"));
    await handle.setModel("another-model");
    expect(warnings()).toEqual(["Couldn't pin the sub-agents to another-model: fake: no agents"]);
  });

  it("warns when it can't add AI credits to a session that ran out", async () => {
    const { session, warnings, emit } = await open({ getBudgetCredits: () => 45 });
    session.rpc.ui.handlePendingSessionLimitsExhausted.mockRejectedValueOnce(new Error("fake: no credits"));
    emit({ id: "ev-1", parentId: null, timestamp: new Date().toISOString(), type: "session_limits_exhausted.requested", data: { requestId: "req-1", usedAiCredits: 30, maxAiCredits: 30 } });
    await until(() => warnings().length > 0);
    expect(warnings()).toEqual(["Couldn't add AI credits to the session: fake: no credits"]);
  });

  it("warns when a cloud session can't take the mode it was opened in", async () => {
    const modeSet = vi.fn(async (): Promise<object> => {
      throw new Error("fake: no such mode");
    });
    const { warnings } = await open({ cloud: { repository: { owner: "contoso", name: "moonrise", branch: "main" } } }, modeSet);
    expect(warnings()).toEqual(["Couldn't set the cloud session's mode to plan: fake: no such mode"]);
  });
});
