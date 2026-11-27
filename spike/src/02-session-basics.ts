/**
 * Phase 0 · 02 session basics (2–3 short model turns on the cheapest model).
 * Phase 0 bullets 1, 5, 6 · §11 #7 (cost of a turn), #10 (effort values), #11 (setModel + effort mid-session),
 * #12 (auto tier / automatic model switching).
 *
 *   npx tsx src/02-session-basics.ts [--model <id>] [--effort <level>] [--keep]
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { defineTool, type PermissionRequest, type SessionEvent } from "@github/copilot-sdk";
import { z } from "zod";
import { createRunLog, eventPrinter, OUT_DIR } from "./lib/log.ts";
import { describeModel, hasFlag, pickModel, startClient, stopClient } from "./lib/runtime.ts";

const log = createRunLog("02-session-basics");
const scratch = path.join(OUT_DIR, "scratch-02");
mkdirSync(scratch, { recursive: true });

const client = await startClient();
let sessionId: string | undefined;
try {
  const first = await pickModel(client);
  const second = await pickModel(client, { skip: [first.model] });
  log.info(`model: ${describeModel(first)} → mid-session switch to ${describeModel(second)}`);

  const toolCalls: unknown[] = [];
  const clock = defineTool("aria_clock", {
    description: "Returns ARIA's current local time and IANA time zone. Use it whenever the user asks for the time.",
    parameters: z.object({ format: z.enum(["iso", "human"]).describe("Output format") }),
    handler: async (args, invocation) => {
      toolCalls.push({ args, toolCallId: invocation.toolCallId, toolName: invocation.toolName });
      const now = new Date();
      return {
        time: args.format === "iso" ? now.toISOString() : now.toLocaleString("en-GB"),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    },
  });

  const events: SessionEvent[] = [];
  const permissionRequests: PermissionRequest[] = [];
  const autoSwitchRequests: unknown[] = [];
  const print = eventPrinter(log, "s");

  const quotaBefore = await client.rpc.account.getQuota({});

  const session = await client.createSession({
    clientName: "aria-spike",
    model: first.model,
    ...(first.reasoningEffort ? { reasoningEffort: first.reasoningEffort } : {}),
    allowedModels: [first.model, second.model],
    streaming: true,
    workingDirectory: scratch,
    tools: [clock],
    onEvent: (event) => {
      events.push(event);
      print(event);
    },
    onPermissionRequest: (request) => {
      permissionRequests.push(request);
      if (request.kind === "custom-tool") return { kind: "approve-once" };
      return { kind: "reject", feedback: "Not allowed in this test. Only use the aria_clock tool." };
    },
    onAutoModeSwitchRequest: (request) => {
      autoSwitchRequests.push(request);
      log.info(`!! auto-mode-switch request: ${JSON.stringify(request)} → answering "no"`);
      return "no";
    },
  });
  sessionId = session.sessionId;
  log.info(`session ${session.sessionId} (workspace ${session.workspacePath ?? "-"})`);
  log.section("model.getCurrent after create", await session.rpc.model.getCurrent());
  console.log(JSON.stringify(await session.rpc.model.getCurrent()));

  try {
    const toolMeta = await session.rpc.tools.getCurrentMetadata();
    log.section("tools.getCurrentMetadata", toolMeta);
  } catch (e) {
    log.info(`tools.getCurrentMetadata failed: ${(e as Error).message}`);
  }

  log.section("turn 1: custom tool");
  const t1 = Date.now();
  const reply1 = await session.sendAndWait({ prompt: "What time is it for me? Use the aria_clock tool (format: human). Answer in one short sentence." }, 120_000);
  log.info(`reply 1 (${Date.now() - t1} ms): ${reply1?.data.content}`);
  log.info(`custom tool calls: ${JSON.stringify(toolCalls)}`);

  log.section("setModel mid-session (model + effort)");
  await session.setModel(second.model, second.reasoningEffort ? { reasoningEffort: second.reasoningEffort } : undefined);
  const afterSwitch = await session.rpc.model.getCurrent();
  log.section("model.getCurrent after setModel", afterSwitch);
  console.log(JSON.stringify(afterSwitch));

  log.section("turn 2: after switch");
  const reply2 = await session.sendAndWait({ prompt: "Reply with exactly: OK" }, 120_000);
  log.info(`reply 2: ${reply2?.data.content}`);

  log.section("effort only (rpc.model.setReasoningEffort)");
  const efforts = second.info?.supportedReasoningEfforts ?? [];
  const otherEffort = efforts.find((e) => e !== second.reasoningEffort && (e as string) !== "none");
  if (otherEffort) {
    const res = await session.rpc.model.setReasoningEffort({ reasoningEffort: otherEffort });
    log.info(`setReasoningEffort(${otherEffort}) → ${JSON.stringify(res)}; current: ${JSON.stringify(await session.rpc.model.getCurrent())}`);
  }

  log.section("allowedModels enforcement");
  const outside = (await client.listModels()).find((m) => m.id !== "auto" && m.id !== first.model && m.id !== second.model);
  if (outside) {
    try {
      await session.setModel(outside.id);
      log.info(`!! setModel(${outside.id}) outside allowedModels was ACCEPTED; current: ${JSON.stringify(await session.rpc.model.getCurrent())}`);
    } catch (e) {
      log.info(`setModel(${outside.id}) outside allowedModels rejected: ${(e as Error).message}`);
    }
  }

  log.section("auto tier on a non-auto model");
  try {
    const res = await session.setAutoTier(null);
    log.info(`setAutoTier(null) → ${JSON.stringify(res)}`);
  } catch (e) {
    log.info(`setAutoTier(null) failed: ${(e as Error).message}`);
  }

  log.section("cost");
  const usage = events.filter((e) => e.type === "assistant.usage").map((e) => e.data);
  log.section("assistant.usage events", usage);
  for (const u of usage) {
    log.info(
      `usage: model=${u.model} in=${u.inputTokens} out=${u.outputTokens} cacheRead=${u.cacheReadTokens} cost=${u.cost} initiator=${u.initiator ?? "user"} copilotUsage=${JSON.stringify(u.copilotUsage)}`,
    );
  }
  try {
    const metrics = await session.rpc.usage.getMetrics();
    log.section("usage.getMetrics", metrics);
    console.log(JSON.stringify(metrics).slice(0, 1500));
  } catch (e) {
    log.info(`usage.getMetrics failed: ${(e as Error).message}`);
  }
  const quotaAfter = await client.rpc.account.getQuota({});
  const pi = (q: typeof quotaBefore) => q.quotaSnapshots.premium_interactions?.usedRequests;
  log.info(`premium_interactions used: before=${pi(quotaBefore)} after=${pi(quotaAfter)} (quota may refresh lazily)`);
  try {
    log.section("session quota.get", await session.rpc.quota.get());
  } catch (e) {
    log.info(`session quota.get failed: ${(e as Error).message}`);
  }

  log.section("summary");
  const modelChanges = events.filter((e) => e.type === "session.model_change").map((e) => e.data);
  log.info(`model_change events: ${JSON.stringify(modelChanges)}`);
  log.info(`auto-mode-switch requests: ${autoSwitchRequests.length}`);
  log.info(`permission requests: ${JSON.stringify(permissionRequests.map((r) => ({ kind: r.kind, ...("toolName" in r ? { toolName: r.toolName } : {}) })))}`);
  log.info(`event types seen: ${[...new Set(events.map((e) => e.type))].join(", ")}`);
  const persisted = await session.getEvents();
  log.info(`getEvents(): ${persisted.length} persisted vs ${events.length} live events`);

  await session.disconnect();
} finally {
  if (sessionId && !hasFlag("--keep")) {
    await client.deleteSession(sessionId).catch((e: Error) => console.warn(`deleteSession: ${e.message}`));
  }
  await stopClient(client);
  await log.close();
}
