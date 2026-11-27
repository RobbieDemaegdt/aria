import type { SessionEvent } from "@github/copilot-sdk";
import { sleep } from "./runtime.ts";

export type SettleOutcome = "idle" | "task_complete" | "autopilot_idle_without_task_complete";

export interface Settled {
  ms: number;
  outcome: SettleOutcome;
  /** Root-session events since the send (sub-agent events excluded). */
  events: SessionEvent[];
  lastMessage?: string;
}

/** Root events that mean the session started (or is waiting on) new work after an idle. */
const ACTIVITY = new Set([
  "assistant.turn_start",
  "assistant.message",
  "tool.execution_start",
  "permission.requested",
  "user_input.requested",
  "exit_plan_mode.requested",
  "external_tool.requested",
  "subagent.started",
  "session_limits_exhausted.requested",
]);

/**
 * Waits until the root session has really finished the work started at `events[start]`.
 *
 * - Sub-agent events (agentId set) are ignored, as the SDK's own sendAndWait does.
 * - Only the latest idle counts, and only if no new work started after it.
 * - An idle in interactive or plan mode is terminal.
 * - In autopilot an idle alone can be intermediate (the SDK's sendAndWait ignores autopilot idles), so it is terminal
 *   only after session.task_complete. If an autopilot idle stays the last activity for `autopilotGraceMs` without
 *   task_complete, the wait ends with outcome "autopilot_idle_without_task_complete".
 * - session.error rejects.
 */
export async function waitForSettled(
  events: SessionEvent[],
  start: number,
  { timeoutMs, autopilotGraceMs = 60_000 }: { timeoutMs: number; autopilotGraceMs?: number },
): Promise<Settled> {
  const started = Date.now();
  for (;;) {
    const mine = events.slice(start).filter((e) => !e.agentId);
    const error = mine.find((e) => e.type === "session.error");
    if (error && error.type === "session.error") throw new Error(`session.error: ${error.data.message}`);
    let lastIdle = -1;
    for (let i = mine.length - 1; i >= 0; i--) {
      if (mine[i]!.type === "session.idle") {
        lastIdle = i;
        break;
      }
    }
    const workAfterIdle = lastIdle >= 0 && mine.slice(lastIdle + 1).some((e) => ACTIVITY.has(e.type));
    if (lastIdle >= 0 && !workAfterIdle) {
      const idle = mine[lastIdle]!;
      const autopilot = idle.type === "session.idle" && idle.data.mode === "autopilot";
      let previousIdle = -1;
      for (let i = lastIdle - 1; i >= 0; i--) {
        if (mine[i]!.type === "session.idle") {
          previousIdle = i;
          break;
        }
      }
      // Only a task_complete from this stretch of work counts, not one from an earlier, reopened cycle.
      const completed = mine.slice(previousIdle + 1, lastIdle).some((e) => e.type === "session.task_complete");
      const quietFor = Date.now() - Date.parse(idle.timestamp);
      if (!autopilot || completed || quietFor > autopilotGraceMs) {
        const outcome: SettleOutcome = !autopilot ? "idle" : completed ? "task_complete" : "autopilot_idle_without_task_complete";
        const last = mine.filter((e) => e.type === "assistant.message").at(-1);
        return {
          ms: Date.now() - started,
          outcome,
          events: mine,
          ...(last && last.type === "assistant.message" ? { lastMessage: last.data.content } : {}),
        };
      }
    }
    if (Date.now() - started > timeoutMs) throw new Error(`not settled within ${timeoutMs} ms`);
    await sleep(250);
  }
}
