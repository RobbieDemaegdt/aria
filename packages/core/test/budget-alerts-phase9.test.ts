import type { CopilotClient } from "@github/copilot-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CopilotRuntime,
  FakeRuntime,
  AriaEngine,
  ManualClock,
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

function setupTestEnv(clock = new ManualClock(Date.parse("2026-10-27T09:00:00Z"))) {
  const base = mkdtempSync(path.join(os.tmpdir(), "aria-phase9-budget-"));
  temps.push(base);
  const projectsRoot = path.join(base, "GitHub");
  const repoPath = makeRepo(projectsRoot, "Moonrise", "https://github.com/contoso/moonrise.git");
  commitFile(repoPath, "README.md", "# Moonrise\n", "Initial commit");

  const runtime = new FakeRuntime();
  const worktreeRoot = path.join(base, "wt");
  const dataDir = path.join(base, "data");

  const engine = new AriaEngine({
    dataDir,
    runtime,
    projectRoots: [projectsRoot],
    worktreeRoot,
    attentionClock: clock,
    resumeSettleMs: 10,
    taskSettleMs: 20,
    autopilotGraceMs: 150,
  });
  engines.push(engine);
  return { base, projectsRoot, repoPath, runtime, worktreeRoot, dataDir, clock, engine };
}

describe("Phase 9: Per-task 80% budget warnings, daily budget caps, session_limits_exhausted, and /budget (D75)", () => {
  it("emits a one-time 80% budget_warning notice before pausing at 100%, and re-arms the warning after continueBudget", async () => {
    const { runtime, engine } = setupTestEnv();
    await engine.start();

    const defaultProfile = engine.getState().profiles.find((p) => p.isDefault)!;
    await engine.saveProfile({
      id: defaultProfile.id,
      name: defaultProfile.name,
      model: defaultProfile.model,
      ...(defaultProfile.reasoningEffort ? { reasoningEffort: defaultProfile.reasoningEffort } : {}),
      mode: "autopilot",
      budgetCredits: 10,
    });

    let stepGateResolve!: () => void;
    const stepGate = new Promise<void>((res) => {
      stepGateResolve = res;
    });

    runtime.workerScripts.push({
      steps: [
        { intent: "Working on part 1" },
        { usage: 8.2 }, // 82% of 10 cr -> triggers 80% warning once
        { usage: 0.5 }, // 87% of 10 cr -> does NOT duplicate warning
        { usage: 1.5 }, // 102% of 10 cr -> pauses at budget (waiting_budget, B-1)
        { gate: stepGate },
      ],
    });

    const project = engine.getState().projects[0]!;
    const task = await engine.startTask({
      repoId: project.id,
      title: "Refactor auth",
      brief: "Refactor authentication module",
    });

    await until(() => engine.getState().tasks.find((t) => t.id === task.id)?.state === "waiting_budget");

    const warnings = engine
      .getState()
      .timeline.filter((i) => i.kind === "notice" && i.cause === "budget_warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind === "notice" ? warnings[0].message : "").toContain("8.2 of its 10 AI credit budget");

    const pausedTask = engine.getState().tasks.find((t) => t.id === task.id)!;
    expect(pausedTask.budgetShortId).toBe("B-1");
    expect(pausedTask.costCredits).toBeCloseTo(10.2, 1);

    // Raise budget by +10 credits (new cap = 20 credits); 80% of 20 = 16 credits
    runtime.workerScripts.push({
      steps: [
        { usage: 6.0 }, // 10.2 + 6.0 = 16.2 credits (>= 16, 80% of new 20 cr cap) -> fires warning a second time!
        { complete: "Finished refactoring auth." },
      ],
    });
    engine.continueBudget(task.id, 10);
    stepGateResolve();

    await until(() => engine.getState().tasks.find((t) => t.id === task.id)?.state === "done");
    const warningsAfter = engine
      .getState()
      .timeline.filter((i) => i.kind === "notice" && i.cause === "budget_warning");
    expect(warningsAfter).toHaveLength(2);
    expect(warningsAfter[1]?.kind === "notice" ? warningsAfter[1].message : "").toContain("of its 20 AI credit budget");
  });

  it("handles session_limits_exhausted.requested dynamically: adds credits when budgetCredits > maxAiCredits, and cancels + emits budget_exhausted when no headroom exists", async () => {
    let onEventHandler: ((ev: any) => void) | undefined;
    const handleLimitsMock = vi.fn(async () => ({}));
    const session = {
      sessionId: "worker-limits-1",
      rpc: {
        options: { update: vi.fn(async () => ({ success: true })) },
        mode: { set: vi.fn(async () => ({})) },
        model: { setAllowedModels: vi.fn(async () => ({})) },
        agent: { list: vi.fn(async () => ({ agents: [] })) },
        tools: { updateSubagentSettings: vi.fn(async () => ({})) },
        ui: { handlePendingSessionLimitsExhausted: handleLimitsMock },
      },
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
      createSession: vi.fn(async (cfg: Record<string, any>) => {
        onEventHandler = cfg.onEvent;
        return session;
      }),
      resumeSession: vi.fn(async () => session),
      deleteSession: vi.fn(async () => {}),
    };

    const copilotRuntime = new CopilotRuntime(() => client as unknown as CopilotClient);
    await copilotRuntime.start();

    const dynamicBudget: number | undefined = 45;
    const workerEvents: WorkerEvent[] = [];

    await copilotRuntime.openWorker({
      sessionId: "worker-limits-1",
      name: "ARIA · Limits Task",
      model: "claude-haiku-5.5",
      mode: "autopilot",
      workingDirectory: "C:\\wt\\moonrise\\limits",
      getBudgetCredits: () => dynamicBudget,
      availableTools: [],
      disabledMcpServers: [],
      policy: { decide: () => ({ approve: true }) },
      onQuestion: async () => ({ answer: "", wasFreeform: true }),
      onPlan: async () => ({ approved: true }),
      onEvent: (e) => workerEvents.push(e),
    });

    // 1. When budgetCredits (45) > maxAiCredits (30), responds with { action: "add", additionalAiCredits: 15 }
    onEventHandler?.({
      id: "lim-ev-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "session_limits_exhausted.requested",
      data: {
        requestId: "req-add-1",
        usedAiCredits: 30,
        maxAiCredits: 30,
      },
    });

    expect(handleLimitsMock).toHaveBeenCalledWith({
      requestId: "req-add-1",
      response: { action: "add", additionalAiCredits: 15 },
    });
    expect(workerEvents.some((e) => e.type === "budget_exhausted")).toBe(false);

    // 2. When no headroom exists (budgetCredits = 45, maxAiCredits = 45), responds with { action: "cancel" } and emits budget_exhausted
    onEventHandler?.({
      id: "lim-ev-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "session_limits_exhausted.requested",
      data: {
        requestId: "req-cancel-2",
        usedAiCredits: 45,
        maxAiCredits: 45,
      },
    });

    expect(handleLimitsMock).toHaveBeenCalledWith({
      requestId: "req-cancel-2",
      response: { action: "cancel" },
    });
    expect(workerEvents).toContainEqual({
      type: "budget_exhausted",
      usedAiCredits: 45,
      maxAiCredits: 45,
    });
  });

  it("transitions a task to waiting_budget (B-1) when budget_exhausted worker event fires", async () => {
    const { runtime, engine } = setupTestEnv();
    await engine.start();

    const defaultProfile = engine.getState().profiles.find((p) => p.isDefault)!;
    await engine.saveProfile({
      id: defaultProfile.id,
      name: defaultProfile.name,
      model: defaultProfile.model,
      ...(defaultProfile.reasoningEffort ? { reasoningEffort: defaultProfile.reasoningEffort } : {}),
      mode: "autopilot",
      budgetCredits: null,
    });

    let gateResolve!: () => void;
    const gate = new Promise<void>((res) => {
      gateResolve = res;
    });

    runtime.workerScripts.push({
      steps: [{ intent: "Long cloud or local run" }, { gate }],
    });

    const project = engine.getState().projects[0]!;
    const task = await engine.startTask({
      repoId: project.id,
      title: "Exhausted session task",
      brief: "Run until SDK session limit hits",
    });

    await until(() => engine.getState().tasks.find((t) => t.id === task.id)?.state === "running");

    const workerSession = runtime.workers.get(`aria-task-${task.id}`)!;
    workerSession.inject({
      type: "budget_exhausted",
      usedAiCredits: 30,
      maxAiCredits: 30,
    });

    await until(() => engine.getState().tasks.find((t) => t.id === task.id)?.state === "waiting_budget");
    const paused = engine.getState().tasks.find((t) => t.id === task.id)!;
    expect(paused.state).toBe("waiting_budget");
    expect(paused.budgetShortId).toBe("B-1");
    expect(paused.costCredits).toBe(30);
    expect(paused.budgetCredits).toBe(30);
    gateResolve();
  });

  it("tracks daily budget spend across tasks, emits 80% warning and 100% alert notices, resets on new calendar day, and supports /budget daily", async () => {
    const clock = new ManualClock(Date.parse("2026-10-27T10:00:00Z"));
    const { runtime, engine } = setupTestEnv(clock);
    await engine.start();

    const defaultProfile = engine.getState().profiles.find((p) => p.isDefault)!;
    await engine.saveProfile({
      id: defaultProfile.id,
      name: defaultProfile.name,
      model: defaultProfile.model,
      ...(defaultProfile.reasoningEffort ? { reasoningEffort: defaultProfile.reasoningEffort } : {}),
      mode: "autopilot",
      budgetCredits: 50,
    });

    // Configure daily budget via /budget daily 20
    await engine.sendMessage("/budget daily 20");
    expect(engine.dailyBudgetState()).toMatchObject({
      usedCredits: 0,
      dailyBudgetCredits: 20,
      budgetWarningPercent: 80,
      warningReached: false,
      limitReached: false,
    });

    runtime.workerScripts.push({
      steps: [
        { usage: 16.5 }, // 82.5% of 20 cr daily cap -> daily_budget_warning
        { usage: 4.0 },  // 20.5 cr (>= 20 cr daily cap) -> daily_budget_reached
        { complete: "Finished daily budget task." },
      ],
    });

    const project = engine.getState().projects[0]!;
    const task = await engine.startTask({
      repoId: project.id,
      title: "Heavy analysis",
      brief: "Analyze all modules",
    });

    await until(() => engine.getState().tasks.find((t) => t.id === task.id)?.state === "done");

    const dailyState = engine.dailyBudgetState();
    expect(dailyState.usedCredits).toBeCloseTo(20.5, 1);
    expect(dailyState.warningReached).toBe(true);
    expect(dailyState.limitReached).toBe(true);

    const timeline = engine.getState().timeline;
    expect(timeline.some((i) => i.kind === "notice" && i.cause === "daily_budget_warning")).toBe(true);
    expect(timeline.some((i) => i.kind === "notice" && i.cause === "daily_budget_reached")).toBe(true);

    // Check /budget status output includes daily budget reached badge
    await engine.sendMessage("/budget");
    const lastReply = engine
      .getState()
      .timeline.filter((i) => i.kind === "chat" && i.role === "assistant")
      .at(-1);
    const replyText = lastReply && lastReply.kind === "chat" ? lastReply.content : "";
    expect(replyText).toContain("Today's AI credits");
    expect(replyText).toContain("20.5 cr / 20 cr daily budget");
    expect(replyText).toContain("daily budget reached");

    // Advance clock to next calendar day -> daily usage resets to 0
    clock.advance(24 * 60 * 60 * 1000);
    const nextDayState = engine.dailyBudgetState();
    expect(nextDayState.usedCredits).toBe(0);
    expect(nextDayState.warningReached).toBe(false);
    expect(nextDayState.limitReached).toBe(false);

    // Clear daily budget via /budget daily off
    await engine.sendMessage("/budget daily off");
    expect(engine.dailyBudgetState().dailyBudgetCredits).toBeNull();
  });
});
