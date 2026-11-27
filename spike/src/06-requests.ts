/**
 * Phase 0 · 06 requests: ask_user, a long-pending permission, plan mode, autopilot completion, session budget.
 * Phase 0 bullet 3 · §11 #2 (user-input payload), #3 (permission pending for minutes), #4 (plan/autopilot from the SDK),
 * #6 (session limits), #8 (task_complete vs idle).
 *
 * Sessions run in scratch folders under .out/scratch-06 with every real MCP server disabled.
 *
 *   npx tsx src/06-requests.ts [--only ask,hold,plan,autopilot,budget] [--hold-seconds 300] [--keep]
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { defineTool, type CopilotSession, type ExitPlanModeRequest, type SessionConfig, type SessionEvent } from "@github/copilot-sdk";
import { z } from "zod";
import { createRunLog, eventPrinter, OUT_DIR } from "./lib/log.ts";
import { realServerNames, scratchPolicy } from "./lib/policy.ts";
import { argValue, describeModel, hasFlag, pickModel, sleep, startClient, stopClient } from "./lib/runtime.ts";
import { waitForSettled } from "./lib/wait.ts";

const only = argValue("--only")?.split(",").map((s) => s.trim());
const want = (part: string) => !only || only.includes(part);
const holdSeconds = Number(argValue("--hold-seconds") ?? 300);
// The runtime rejects session limits below 30 AI credits (Phase 0 finding). Exhausting 30 credits takes far more
// than a few cheap calls, so this case only checks that a limit is accepted unless you raise the workload yourself.
const budgetCredits = Number(argValue("--budget-credits") ?? 30);

const log = createRunLog(`06-requests${only ? `-${only.join("+")}` : ""}`);
const client = await startClient();
const results: Record<string, unknown> = {};

const choice = await pickModel(client);
const realServers = await realServerNames(client);
log.info(`model ${describeModel(choice)}; real MCP servers disabled: ${realServers.join(", ")}`);

interface Ctx {
  dir: string;
  events: SessionEvent[];
}

async function withSession(part: string, extra: Partial<SessionConfig>, fn: (session: CopilotSession, ctx: Ctx) => Promise<void>) {
  log.section(part);
  const dir = path.join(OUT_DIR, "scratch-06", part);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const events: SessionEvent[] = [];
  const print = eventPrinter(log, part);
  const session = await client.createSession({
    clientName: "aria-spike",
    model: choice.model,
    ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}),
    workingDirectory: dir,
    disabledMcpServers: realServers,
    onEvent: (event) => {
      events.push(event);
      print(event);
    },
    onPermissionRequest: scratchPolicy(dir, { onDecision: (r, d, why) => log.info(`  [${part}] permission ${r.kind}: ${d} (${why})`) }),
    onAutoModeSwitchRequest: () => "no",
    ...extra,
  });
  try {
    await fn(session, { dir, events });
  } finally {
    await session.disconnect().catch(() => {});
    if (!hasFlag("--keep")) await client.deleteSession(session.sessionId).catch(() => {});
  }
}

/** send() + wait until the root session has really finished (see lib/wait.ts), then a short grace period. */
async function sendAndSettle(session: CopilotSession, events: SessionEvent[], prompt: string, timeoutMs: number) {
  const start = events.length;
  await session.send({ prompt });
  const settled = await waitForSettled(events, start, { timeoutMs });
  await sleep(1500);
  return settled;
}

type DataOf<T extends SessionEvent["type"]> = Extract<SessionEvent, { type: T }>["data"];

function pick<T extends SessionEvent["type"]>(events: SessionEvent[], type: T): Array<DataOf<T>> {
  return events.filter((e) => e.type === type).map((e) => e.data as unknown as DataOf<T>);
}

try {
  if (want("ask")) {
    const handlerCalls: unknown[] = [];
    await withSession(
      "ask",
      {
        onUserInputRequest: async (request, invocation) => {
          handlerCalls.push({ request, invocation });
          log.info(`  ask_user handler got: ${JSON.stringify(request)}`);
          return { answer: "Green", wasFreeform: false };
        },
      },
      async (session, { events }) => {
        const r = await sendAndSettle(
          session,
          events,
          "Use the ask_user tool to ask me which color I prefer, offering exactly the choices Red, Green and Blue. Then reply with only the color I chose.",
          180_000,
        );
        results.ask = {
          handlerCalls,
          requested: pick(r.events, "user_input.requested"),
          completed: pick(r.events, "user_input.completed"),
          reply: r.lastMessage,
        };
      },
    );
  }

  if (want("plan")) {
    const planRequests: ExitPlanModeRequest[] = [];
    await withSession(
      "plan",
      {
        onExitPlanModeRequest: async (request) => {
          planRequests.push(request);
          log.info(`  exit_plan_mode handler: actions=${JSON.stringify(request.actions)} recommended=${request.recommendedAction} summary=${request.summary.slice(0, 120)}`);
          return { approved: true, selectedAction: request.recommendedAction };
        },
      },
      async (session, { dir, events }) => {
        const modeBefore = await session.rpc.mode.get();
        const setResult = await session.rpc.mode.set({ mode: "plan" });
        log.info(`  mode before=${JSON.stringify(modeBefore)} set(plan) → ${JSON.stringify(setResult)}`);
        const r = await sendAndSettle(session, events, "Add a file NOTES.md containing the single line 'Hello from ARIA' to the current folder. Keep the plan to two steps.", 300_000);
        let plan: unknown;
        try {
          plan = await session.rpc.plan.read();
        } catch (e) {
          plan = `plan.read failed: ${(e as Error).message}`;
        }
        results.plan = {
          modeBefore,
          setResult,
          planRequests,
          exitRequested: pick(r.events, "exit_plan_mode.requested"),
          exitCompleted: pick(r.events, "exit_plan_mode.completed"),
          modeAfter: await session.rpc.mode.get(),
          plan,
          fileCreated: existsSync(path.join(dir, "NOTES.md")),
          taskComplete: pick(r.events, "session.task_complete"),
          idle: pick(r.events, "session.idle"),
          reply: r.lastMessage,
        };
      },
    );
  }

  if (want("autopilot")) {
    for (const [label, mode] of [
      ["autopilot-1", "autopilot"],
      ["autopilot-2", "autopilot"],
      ["interactive", "interactive"],
    ] as const) {
      await withSession(label, {}, async (session, { dir, events }) => {
        if (mode === "autopilot") await session.rpc.mode.set({ mode: "autopilot" });
        const r = await sendAndSettle(session, events, "Create a file hello.txt containing exactly the text hi in the current folder. Then you are done.", 300_000);
        const order = r.events.map((e) => e.type).filter((t) => t === "session.task_complete" || t === "session.idle" || t === "assistant.turn_end");
        results[label] = {
          mode,
          ms: r.ms,
          outcome: r.outcome,
          taskComplete: pick(r.events, "session.task_complete"),
          idle: pick(r.events, "session.idle"),
          order,
          fileCreated: existsSync(path.join(dir, "hello.txt")),
          premiumRequests: (await session.rpc.usage.getMetrics()).totalPremiumRequestCost,
          reply: r.lastMessage?.slice(0, 200),
        };
      });
    }
  }

  if (want("budget")) {
    // Below-minimum limits are rejected at session creation; record that instead of aborting the remaining cases.
    for (const credits of [0.02, budgetCredits]) {
      const budgetRequests: unknown[] = [];
      const countLetters = defineTool("count_letters", {
        description: "Counts the letters in one word.",
        parameters: z.object({ word: z.string() }),
        defer: "never",
        skipPermission: true,
        handler: ({ word }) => ({ word, letters: word.length }),
      });
      try {
        await withSession(`budget-${credits}`, { sessionLimits: { maxAiCredits: credits }, tools: [countLetters] }, async (session, { events }) => {
          session.on("session_limits_exhausted.requested", (event) => {
            budgetRequests.push(event.data);
            const response = budgetRequests.length === 1 ? ({ action: "add", additionalAiCredits: 5 } as const) : ({ action: "cancel" } as const);
            log.info(`  budget exhausted: ${JSON.stringify(event.data)} → ${JSON.stringify(response)}`);
            void session.rpc.ui
              .handlePendingSessionLimitsExhausted({ requestId: event.data.requestId, response })
              .catch((e: Error) => log.info(`  handlePending failed: ${e.message}`));
          });
          const r = await sendAndSettle(
            session,
            events,
            "Call count_letters for the words alpha, beta, gamma and delta, one call at a time (four separate calls, waiting for each result), then reply with the four counts.",
            300_000,
          );
          results[`budget-${credits}`] = {
            budgetRequests,
            limitsAtStart: pick(events, "session.start").map((d) => (d as { sessionLimits?: unknown }).sessionLimits),
            completed: pick(r.events, "session_limits_exhausted.completed"),
            limitsChanged: pick(r.events, "session.session_limits_changed"),
            metrics: await session.rpc.usage.getMetrics(),
            reply: r.lastMessage,
          };
        });
      } catch (e) {
        results[`budget-${credits}`] = { createError: (e as Error).message };
        log.info(`  budget ${credits}: ${(e as Error).message}`);
      }
    }
  }

  if (want("hold")) {
    let heldMs = 0;
    await withSession(
      "hold",
      {
        onPermissionRequest: async (request) => {
          if (request.kind === "shell" && /^git --version$/.test(request.fullCommandText.trim())) {
            log.info(`  holding the shell permission request for ${holdSeconds}s (fields: ${Object.keys(request).join(", ")})`);
            const t0 = Date.now();
            await sleep(holdSeconds * 1000);
            heldMs = Date.now() - t0;
            log.info(`  releasing after ${heldMs} ms → approve-once`);
            return { kind: "approve-once" };
          }
          return { kind: "reject", feedback: "Only `git --version` is allowed in this session." };
        },
      },
      async (session, { events }) => {
        const r = await sendAndSettle(session, events, "Run exactly `git --version` in the shell and reply with only its output.", (holdSeconds + 240) * 1000);
        results.hold = {
          holdSeconds,
          heldMs,
          permissionCompleted: pick(r.events, "permission.completed"),
          toolComplete: pick(r.events, "tool.execution_complete").map((d) => ({ success: d.success, error: d.error })),
          errors: pick(r.events, "session.error"),
          warnings: pick(r.events, "session.warning"),
          reply: r.lastMessage,
        };
      },
    );
  }
} finally {
  log.section("results", results);
  console.log(JSON.stringify(results, null, 1).slice(0, 12000));
  await stopClient(client);
  await log.close();
}
