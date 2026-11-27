/**
 * Phase 0 · 08 sub-agent models. §11 #13 (can a worker's sub-agents be pinned to a model and effort).
 *
 * Main session on the cheapest model; a custom agent pinned through customAgents[].model/reasoningEffort, and the
 * built-in "explore" agent pinned through rpc.tools.updateSubagentSettings. The subagent.* and assistant.usage events
 * show which model each one actually used.
 *
 *   npx tsx src/08-subagents.ts [--sub-model <id>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SessionEvent } from "@github/copilot-sdk";
import { createRunLog, eventPrinter, OUT_DIR } from "./lib/log.ts";
import { realServerNames, scratchPolicy } from "./lib/policy.ts";
import { argValue, describeModel, pickModel, startClient, stopClient } from "./lib/runtime.ts";

const dir = path.join(OUT_DIR, "scratch-08");
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "alpha.txt"), "alpha\n");
writeFileSync(path.join(dir, "beta.md"), "# beta\n");

const log = createRunLog("08-subagents");
const client = await startClient();
const events: SessionEvent[] = [];
let sessionId: string | undefined;
try {
  const main = await pickModel(client);
  const sub = argValue("--sub-model") ?? (await pickModel(client, { skip: [main.model] })).model;
  log.info(`main ${describeModel(main)}; sub-agents pinned to ${sub} · low`);

  const session = await client.createSession({
    clientName: "aria-spike",
    model: main.model,
    ...(main.reasoningEffort ? { reasoningEffort: main.reasoningEffort } : {}),
    workingDirectory: dir,
    disabledMcpServers: await realServerNames(client),
    customAgents: [
      {
        name: "letter-counter",
        displayName: "Letter counter",
        description: "Counts the letters in a word. Use it whenever a letter count is needed.",
        prompt: "You count the letters in the word you are given. Reply with only the number.",
        tools: [],
        model: sub,
        reasoningEffort: "low",
      },
    ],
    onEvent: (event) => {
      events.push(event);
      eventPrinter(log, "s")(event);
    },
    onPermissionRequest: scratchPolicy(dir, { onDecision: (r, d, why) => log.info(`  permission ${r.kind}: ${d} (${why})`) }),
    onAutoModeSwitchRequest: () => "no",
  });
  sessionId = session.sessionId;

  const settings = await session.rpc.tools.updateSubagentSettings({ subagents: { agents: { explore: { model: sub, effortLevel: "low" } } } });
  log.info(`updateSubagentSettings → ${JSON.stringify(settings)}`);
  try {
    log.section("agent.list", await session.rpc.agent.list());
  } catch (e) {
    log.info(`agent.list failed: ${(e as Error).message}`);
  }

  const reply = await session.sendAndWait(
    {
      prompt:
        "Do two delegations with the task tool, then answer: (1) ask the letter-counter agent how many letters are in 'ARIA'; " +
        "(2) ask the explore agent to list the files in the current folder. Reply with both answers in one line.",
    },
    300_000,
  );
  log.info(`reply: ${reply?.data.content}`);

  log.section("sub-agent events");
  for (const e of events) {
    if (e.type === "subagent.started" || e.type === "subagent.completed" || e.type === "subagent.failed") {
      console.log(`${e.type}: ${JSON.stringify(e.data)}`);
    }
  }
  log.section("model calls (assistant.usage)");
  for (const e of events) {
    if (e.type === "assistant.usage") {
      console.log(`model=${e.data.model} agent=${e.agentId?.slice(0, 8) ?? "main"} initiator=${e.data.initiator ?? "-"} in=${e.data.inputTokens} out=${e.data.outputTokens}`);
    }
  }
  await session.disconnect();
} finally {
  if (sessionId) await client.deleteSession(sessionId).catch(() => {});
  await stopClient(client);
  await log.close();
}
