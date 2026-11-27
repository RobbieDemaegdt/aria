import type { CopilotClient, SessionEvent } from "@github/copilot-sdk";
import { mergeEntries, type TranscriptEntry } from "@aria/protocol";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CopilotRuntime, type WorkerEvent } from "../src/index.ts";
import { TranscriptMapper } from "../src/runtime/sdk-transcript.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");

interface EventFixture {
  note: string;
  events: SessionEvent[];
}

function loadFixture(name: string): EventFixture {
  const raw = readFileSync(path.join(fixturesDir, name), "utf8");
  return JSON.parse(raw) as EventFixture;
}

const FIXTURE_FILES = [
  "spike15-events.json",
  "autopilot-task-events.json",
  "interactive-plan-events.json",
  "crash-resume-events.json",
  "cloud-budget-events.json",
] as const;

describe("Phase 9: Recorded SDK SessionEvent[] fixture replay suite (D78)", () => {
  it.each(FIXTURE_FILES)(
    "maintains live vs history TranscriptMapper parity and zero leaked open entries for %s",
    (fileName) => {
      const fixture = loadFixture(fileName);
      expect(fixture.events.length).toBeGreaterThan(0);

      const liveMapper = new TranscriptMapper({ live: true });
      const historyMapper = new TranscriptMapper();

      let liveMerged: TranscriptEntry[] = [];
      for (const ev of fixture.events) {
        const delta = liveMapper.apply(ev);
        if (delta.length > 0) {
          liveMerged = mergeEntries(liveMerged, delta);
        }
        historyMapper.apply(ev);
      }

      const historyAll = historyMapper.all();
      expect(liveMerged).toEqual(historyAll);
      // Byte for byte, keys in the same order: a session's first read saves only the steps that differ from what was
      // saved live (P4), by comparing their JSON.
      expect(liveMerged.map((entry) => JSON.stringify(entry))).toEqual(historyAll.map((entry) => JSON.stringify(entry)));
      expect(liveMapper.tracked).toBe(0);
    },
  );

  it("replays autopilot-task-events.json through CopilotRuntime: counts sub-agent usage, filters sub-agent tools & autopilot continuation nudges, and emits task_complete", async () => {
    const fixture = loadFixture("autopilot-task-events.json");
    let onEventHandler: ((ev: SessionEvent) => void) | undefined;

    const session = {
      sessionId: "replay-autopilot-1",
      rpc: {
        options: { update: vi.fn(async () => ({ success: true })) },
        mode: { set: vi.fn(async () => ({})) },
        model: { setAllowedModels: vi.fn(async () => ({})) },
        agent: { list: vi.fn(async () => ({ agents: [] })) },
        tools: { updateSubagentSettings: vi.fn(async () => ({})) },
      },
      send: vi.fn(async () => {
        for (const ev of fixture.events) {
          onEventHandler?.(ev);
        }
        return "msg-1";
      }),
      getEvents: vi.fn(async () => fixture.events),
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

    const runtime = new CopilotRuntime(() => client as unknown as CopilotClient);
    await runtime.start();

    const emitted: WorkerEvent[] = [];
    const handle = await runtime.openWorker({
      sessionId: "replay-autopilot-1",
      name: "ARIA · Autopilot Replay",
      model: "claude-sonnet-5.5",
      mode: "autopilot",
      workingDirectory: "C:\\wt\\moonrise\\dark-mode",
      availableTools: [],
      disabledMcpServers: [],
      policy: { decide: () => ({ approve: true }) },
      onQuestion: async () => ({ answer: "", wasFreeform: true }),
      onPlan: async () => ({ approved: true }),
      onEvent: (e) => emitted.push(e),
    });

    await handle.send("Add a dark mode toggle and unit tests to Moonrise.");

    // Both sub-agent (180_000_000) and root agent (240_000_000) usage events are emitted
    const usageEvents = emitted.filter((e): e is Extract<WorkerEvent, { type: "usage" }> => e.type === "usage");
    expect(usageEvents.map((u) => u.nanoAiu)).toEqual([180_000_000, 240_000_000]);

    // Intent and task_complete are emitted
    expect(emitted).toContainEqual({ type: "intent", intent: "Inspecting repository structure" });
    expect(emitted).toContainEqual({
      type: "task_complete",
      summary: "Added dark mode toggle and unit tests.",
    });

    // Transcript excludes sub-agent grep tool call and excludes isAutopilotContinuation user message
    const transcript = await handle.getTranscript();
    expect(transcript.some((t) => t.kind === "tool" && t.name === "grep")).toBe(false);
    expect(transcript.filter((t) => t.kind === "user")).toHaveLength(1);
  });

  it("replays interactive-plan-events.json, crash-resume-events.json, and cloud-budget-events.json through CopilotRuntime", async () => {
    const planFixture = loadFixture("interactive-plan-events.json");
    const crashFixture = loadFixture("crash-resume-events.json");
    const cloudFixture = loadFixture("cloud-budget-events.json");

    let onEventHandler: ((ev: SessionEvent) => void) | undefined;
    let currentEvents: SessionEvent[] = [];
    const handleLimitsMock = vi.fn(async () => ({}));

    const session = {
      sessionId: "replay-multi-1",
      rpc: {
        options: { update: vi.fn(async () => ({ success: true })) },
        mode: { set: vi.fn(async () => ({})) },
        model: { setAllowedModels: vi.fn(async () => ({})) },
        agent: { list: vi.fn(async () => ({ agents: [] })) },
        tools: { updateSubagentSettings: vi.fn(async () => ({})) },
        ui: { handlePendingSessionLimitsExhausted: handleLimitsMock },
      },
      send: vi.fn(async () => {
        for (const ev of currentEvents) {
          onEventHandler?.(ev);
        }
        return "msg-1";
      }),
      getEvents: vi.fn(async () => currentEvents),
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

    const runtime = new CopilotRuntime(() => client as unknown as CopilotClient);
    await runtime.start();

    const emitted: WorkerEvent[] = [];
    const handle = await runtime.openWorker({
      sessionId: "replay-multi-1",
      name: "ARIA · Multi Replay",
      model: "claude-sonnet-5.5",
      mode: "plan",
      workingDirectory: "C:\\wt\\moonrise\\plan",
      availableTools: [],
      disabledMcpServers: [],
      policy: { decide: () => ({ approve: true }) },
      onQuestion: async () => ({ answer: "120", wasFreeform: false }),
      onPlan: async () => ({ approved: true, mode: "interactive" }),
      onEvent: (e) => emitted.push(e),
    });

    // 1. Replay interactive-plan-events.json
    currentEvents = planFixture.events;
    await handle.send("Plan and implement rate limiting");
    expect(emitted).toContainEqual({
      type: "model_change",
      previousModel: "claude-sonnet-5.5",
      model: "claude-haiku-5.5",
      reasoningEffort: "medium",
      cause: "refusal_fallback",
    });
    const planTranscript = await handle.getTranscript();
    expect(planTranscript.some((e) => e.kind === "question" && e.answer === "120")).toBe(true);
    expect(planTranscript.some((e) => e.kind === "permission" && e.approved === true && e.toolCallId === "toolu_perm_1")).toBe(true);

    // 2. Replay crash-resume-events.json
    emitted.length = 0;
    currentEvents = crashFixture.events;
    await handle.send("Resume after crash");
    expect(emitted).toContainEqual({
      type: "warning",
      warningType: "interrupted_tools",
      message: "1 tool call was interrupted when the session closed.",
    });
    const crashTranscript = await handle.getTranscript();
    const failedTool = crashTranscript.find((e) => e.kind === "tool" && e.id === "toolu_crash_1");
    expect(failedTool && failedTool.kind === "tool" ? failedTool.success : undefined).toBe(false);

    // 3. Replay cloud-budget-events.json
    emitted.length = 0;
    currentEvents = cloudFixture.events;
    await handle.send("Cloud budget stream");
    expect(emitted).toContainEqual({
      type: "remote_info",
      url: "https://github.com/copilot/tasks/cloud-sess-42",
      message: "Remote session available at https://github.com/copilot/tasks/cloud-sess-42",
    });
    expect(emitted).toContainEqual({
      type: "budget_exhausted",
      usedAiCredits: 30,
      maxAiCredits: 30,
    });
    expect(emitted).toContainEqual({
      type: "warning",
      warningType: "policy_blocked",
      message: "Repository policy blocked cloud execution.",
    });
  });
});
