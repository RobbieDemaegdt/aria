/**
 * Phase 3 Part B · 15 the transcript after a compaction, questions and refusals (model calls: about 0.1 AI credits on
 * Haiku 5.5, low). PLAN.md §10 Phase 9, "Needs a check with the real runtime":
 *   - Inspector: what getEvents() returns after a compaction (does what came before it stay), and is
 *     PermissionRequest.toolCallId there and equal to the tool call's id (also for a refused call);
 *   - "Save as memory": is the ask_user result's content exactly your freeform answer.
 *
 * One session in a scratch folder, every real MCP server disabled, only `powershell` and `ask_user`. The permission
 * handler approves one fixed read-only command and refuses everything else. The compaction is a manual one
 * (`session.rpc.history.compact`), in a session with infinite sessions on, as ARIA's are. Then the runtime is
 * restarted and the session resumed, to read getEvents() as ARIA does after a restart. The resume also answers
 * Integrations question 4 at no extra cost: it uses other availableTools and enables one real server (the first one the
 * runtime discovers, or --resume-server), and the tool list is read without sending anything. The session is deleted at the end. getEvents() is written to
 * .out/15-events.json (the probe's own made-up answers only) for an offline check with ARIA's transcript mapper.
 *
 *   npx tsx src/15-transcript.ts [--resume-server <server> [--resume-tool <server>-<tool>]]
 *
 * Without --resume-tool the resumed session gets `view` and `ask_user` only; with it, that one MCP tool too.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CopilotClient, CopilotSession, PermissionRequest, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { createRunLog, eventPrinter, OUT_DIR } from "./lib/log.ts";
import { realServerNames } from "./lib/policy.ts";
import { argValue, describeModel, pickModel, sleep, startClient, stopClient } from "./lib/runtime.ts";
import { waitForSettled } from "./lib/wait.ts";

const log = createRunLog("15-transcript");
const dir = path.join(OUT_DIR, "scratch-15");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

/** The made-up answers, by question. Q3's has spaces around it and a line break inside, to see what's kept. */
const ANSWERS: Record<string, { answer: string; wasFreeform: boolean }> = {
  Q1: { answer: "Green", wasFreeform: false },
  Q2: { answer: "Teal", wasFreeform: true },
  Q3: { answer: "  Moonrise uses pnpm, not npm.\n  Keep it that way.  ", wasFreeform: true },
};
const APPROVED = "Get-Date -Format yyyy";

const events: SessionEvent[] = [];
const permissions: PermissionRequest[] = [];
const asked: Array<{ question: string; choices?: string[]; allowFreeform?: boolean }> = [];

async function config(client: CopilotClient, label: string): Promise<Omit<SessionConfig, "sessionId">> {
  const choice = await pickModel(client);
  log.info(`[${label}] model ${describeModel(choice)}`);
  const print = eventPrinter(log, label);
  return {
    clientName: "aria-spike",
    model: choice.model,
    ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}),
    workingDirectory: dir,
    infiniteSessions: { enabled: true },
    disabledMcpServers: await realServerNames(client),
    availableTools: ["builtin:powershell", "builtin:ask_user"],
    onEvent: (event) => {
      events.push(event);
      print(event);
    },
    onPermissionRequest: (request) => {
      permissions.push(request);
      const ok = request.kind === "shell" && request.fullCommandText.trim() === APPROVED;
      log.info(`  permission ${request.kind}${request.kind === "shell" ? ` \`${request.fullCommandText}\`` : ""}: ${ok ? "approve" : "reject"}`);
      return ok ? { kind: "approve-once" } : { kind: "reject", feedback: "Refused by the spike: only the first command may run." };
    },
    onUserInputRequest: async (request) => {
      asked.push(request);
      const key = Object.keys(ANSWERS).find((k) => request.question.includes(k)) ?? `Q${asked.length}`;
      const reply = ANSWERS[key] ?? { answer: "(no answer)", wasFreeform: true };
      log.info(`  ask_user ${JSON.stringify(request)} → ${JSON.stringify(reply)}`);
      return reply;
    },
    onAutoModeSwitchRequest: () => "no",
  };
}

async function turn(session: CopilotSession, prompt: string) {
  const start = events.length;
  await session.send({ prompt });
  const settled = await waitForSettled(events, start, { timeoutMs: 180_000 });
  await sleep(1000);
  log.info(`turn settled (${settled.outcome}, ${settled.ms} ms): ${settled.lastMessage?.slice(0, 120) ?? "-"}`);
}

type Data<T extends SessionEvent["type"]> = Extract<SessionEvent, { type: T }>["data"];
const of = <T extends SessionEvent["type"]>(list: SessionEvent[], type: T) => list.filter((e) => e.type === type).map((e) => e.data as unknown as Data<T>);

function checkQuestions(label: string, list: SessionEvent[]) {
  const starts = list.filter((e) => e.type === "tool.execution_start" && e.data.toolName === "ask_user");
  const rows = starts.map((s) => {
    const start = s.data as Data<"tool.execution_start">;
    const done = of(list, "tool.execution_complete").find((d) => d.toolCallId === start.toolCallId);
    const question = String((start.arguments as { question?: unknown } | undefined)?.question ?? "");
    const key = Object.keys(ANSWERS).find((k) => question.includes(k)) ?? "?";
    const content = done?.result?.content;
    return {
      question: key,
      answer: JSON.stringify(ANSWERS[key]?.answer),
      "result.content": JSON.stringify(content),
      "detailedContent same": done?.result?.detailedContent === content,
      exact: content === ANSWERS[key]?.answer,
    };
  });
  log.section(`${label}: ask_user results`, rows);
  console.log(`${label}: ask_user results`);
  console.table(rows);
}

function checkPermissions(label: string, list: SessionEvent[]) {
  const starts = new Map(of(list, "tool.execution_start").map((s) => [s.toolCallId, s.toolName]));
  const completes = new Map(of(list, "tool.execution_complete").map((c) => [c.toolCallId, c.success]));
  const rows = of(list, "permission.requested").map((p) => {
    const request = p.permissionRequest as PermissionRequest & { toolCallId?: string };
    const done = of(list, "permission.completed").find((c) => c.requestId === p.requestId);
    return {
      kind: request.kind,
      command: request.kind === "shell" ? request.fullCommandText : "-",
      "has toolCallId": typeof request.toolCallId === "string",
      "= tool.execution_start": request.toolCallId !== undefined && starts.has(request.toolCallId),
      "completed.toolCallId same": done?.toolCallId === request.toolCallId,
      decision: (done?.result as { kind?: string } | undefined)?.kind ?? "-",
      "tool succeeded": request.toolCallId ? String(completes.get(request.toolCallId)) : "-",
    };
  });
  log.section(`${label}: permission requests`, rows);
  console.log(`${label}: permission requests`);
  console.table(rows);
}

const client = await startClient();
const sessionId = `aria-spike-15-${Date.now()}`;
let cleanup: CopilotClient = client;
try {
  const session = await client.createSession({ sessionId, ...(await config(client, "live")) });
  await turn(
    session,
    [
      "Call the ask_user tool exactly three times, one call per message, in this order, and wait for each answer:",
      '1. question "Q1: which colour?" with the choices Red, Green, Blue;',
      '2. question "Q2: and a second colour?" with the choices Red, Green, Blue;',
      '3. question "Q3: one fact about your project?" with no choices.',
      "Then reply with the single word DONE.",
    ].join("\n"),
  );
  await turn(session, `Run these two PowerShell commands, each in its own powershell tool call, one after the other: \`${APPROVED}\` and then \`Get-Location\`. Then reply with the single word DONE.`);
  checkQuestions("live events", events);
  checkPermissions("live events", events);

  const before = await session.getEvents();
  const beforeIds = new Set(before.map((e) => e.id));
  log.info(`getEvents() before the compaction: ${before.length} events`);

  const compact = await session.rpc.history.compact({ trigger: "manual" });
  log.section("history.compact result", compact);
  console.log(`compaction: success=${compact.success} messagesRemoved=${compact.messagesRemoved} tokensRemoved=${compact.tokensRemoved} summary=${compact.summaryContent ? `${compact.summaryContent.length} chars` : "-"}`);
  await sleep(1500);

  const report = (label: string, after: SessionEvent[]) => {
    const kept = before.filter((e) => after.some((a) => a.id === e.id)).length;
    const types = (list: SessionEvent[]) => {
      const counts = new Map<string, number>();
      for (const e of list) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
      return counts;
    };
    const b = types(before);
    const a = types(after.filter((e) => beforeIds.has(e.id)));
    const added = after.filter((e) => !beforeIds.has(e.id)).map((e) => e.type);
    console.log(`${label}: ${after.length} events; ${kept} of the ${before.length} from before the compaction are still there; new: ${added.join(", ") || "-"}`);
    console.table(
      [...b].map(([type, count]) => ({ type, before: count, "still there": a.get(type) ?? 0 })).filter((r) => r.before !== r["still there"] || /message|tool\.|permission/.test(r.type)),
    );
    const compaction = after.find((e) => e.type === "session.compaction_complete");
    log.section(`${label}: getEvents()`, { kept, total: after.length, added, compaction });
    return after;
  };
  report("getEvents() after the compaction", await session.getEvents());

  const firstMetrics = await session.rpc.usage.getMetrics();
  log.info(`cost so far (two turns and the compaction): ${firstMetrics.totalPremiumRequestCost} premium requests, ${((firstMetrics.totalNanoAiu ?? 0) / 1e9).toFixed(3)} AI credits`);

  // As after a restart of ARIA: a new runtime, the session resumed, its events read. It resumes with other tools and
  // one real server enabled (question 4: does a resumed session take new availableTools and disabledMcpServers, which
  // ARIA's reopen relies on). Nothing is sent after the resume, so no tool can be called.
  await session.disconnect();
  await stopClient(client);
  const second = await startClient();
  cleanup = second;
  const resumeConfig = await config(second, "resumed");
  const all = await realServerNames(second);
  const resumeServer = argValue("--resume-server") ?? all[0];
  const resumeTool = argValue("--resume-tool");
  const resumed = await second.resumeSession(sessionId, {
    ...resumeConfig,
    availableTools: ["builtin:view", "builtin:ask_user", ...(resumeTool ? [`mcp:${resumeTool}`] : [])],
    disabledMcpServers: all.filter((n) => n !== resumeServer),
  });
  for (let i = 0; i < 60; i++) {
    const status = (await resumed.rpc.mcp.list()).servers.find((s) => s.name === resumeServer)?.status;
    if (status !== "pending") break;
    await sleep(500);
  }
  await resumed.rpc.tools.initializeAndValidate();
  const resumedTools = ((await resumed.rpc.tools.getCurrentMetadata()).tools ?? []).map((t) => t.name).sort();
  const servers = (await resumed.rpc.mcp.list()).servers.filter((s) => s.status !== "disabled").map((s) => `${s.name}=${s.status}`);
  const expected = ["ask_user", "view", ...(resumeTool ? [resumeTool] : [])].sort();
  log.section("resume with other tools", { resumedTools, servers, expected });
  console.log(`resumed with [view, ask_user${resumeTool ? `, ${resumeTool}` : ""}] and only ${resumeServer ?? "no server"} enabled (created with [powershell, ask_user], every server disabled):`);
  console.log(`  tools now: [${resumedTools.join(", ")}] → ${JSON.stringify(resumedTools) === JSON.stringify(expected) ? "the new ones" : "NOT the new ones"}; servers not disabled: ${servers.join(", ") || "none"}`);
  const afterRestart = report("getEvents() after a restart and resume", await resumed.getEvents());
  checkQuestions("after restart", afterRestart);
  checkPermissions("after restart", afterRestart);
  writeFileSync(path.join(OUT_DIR, "15-events.json"), `${JSON.stringify(afterRestart, null, 1)}\n`);
  console.log(`events written to ${path.join(OUT_DIR, "15-events.json")}`);
  await resumed.disconnect();
} finally {
  await cleanup.deleteSession(sessionId).catch((e: Error) => log.info(`deleteSession: ${e.message}`));
  await stopClient(cleanup).catch(() => {});
  await log.close();
}
