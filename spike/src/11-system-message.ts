/**
 * Phase 3 · 11 Conductor prompt on resume. Customize › Prompts edits ARIA's system prompt: does `resumeSession` with
 * a changed `systemMessage` apply it to the existing conversation (so an edit takes effect without losing the chat)?
 *
 * A session is created with "your codename is ALPHA", asked for it, detached, resumed with "BRAVO", and asked again.
 * Two cheap model calls, no tools.
 *
 *   npx tsx src/11-system-message.ts [--keep]
 */
import type { SessionEvent } from "@github/copilot-sdk";
import { createRunLog } from "./lib/log.ts";
import { realServerNames } from "./lib/policy.ts";
import { describeModel, hasFlag, pickModel, startClient, stopClient } from "./lib/runtime.ts";
import { waitForSettled } from "./lib/wait.ts";

const log = createRunLog("11-system-message");
const client = await startClient();
const out: Record<string, unknown> = {};
const sessionId = `aria-spike-sysmsg-${Date.now()}`;
try {
  const choice = await pickModel(client);
  const realServers = await realServerNames(client);
  log.info(`model ${describeModel(choice)}`);
  const config = (codename: string, events: SessionEvent[]) => ({
    clientName: "aria-spike",
    model: choice.model,
    ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}),
    availableTools: [],
    disabledMcpServers: realServers,
    systemMessage: { mode: "append" as const, content: `Your codename is ${codename}. When asked for your codename, reply with only the codename.` },
    onPermissionRequest: () => ({ kind: "reject" as const, feedback: "No tools in this probe." }),
    onEvent: (event: SessionEvent) => {
      events.push(event);
    },
  });
  const ask = async (session: { send(o: { prompt: string }): Promise<unknown> }, events: SessionEvent[], prompt: string) => {
    const start = events.length;
    await session.send({ prompt });
    return (await waitForSettled(events, start, { timeoutMs: 120_000 })).lastMessage?.trim();
  };

  const first: SessionEvent[] = [];
  const created = await client.createSession({ ...config("ALPHA", first), sessionId, name: "aria-spike system message probe" });
  out.created = await ask(created, first, "What's your codename?");
  log.info(`created with ALPHA → ${String(out.created)}`);
  await created.disconnect();

  const second: SessionEvent[] = [];
  const resumed = await client.resumeSession(sessionId, config("BRAVO", second));
  out.resumed = await ask(resumed, second, "Read your system instructions again now and reply with only the codename they give you.");
  log.info(`resumed with BRAVO → ${String(out.resumed)}`);
  out.applied = typeof out.resumed === "string" && /BRAVO/i.test(out.resumed) && !/ALPHA/i.test(out.resumed);
  const metrics = await resumed.rpc.usage.getMetrics();
  out.credits = Number(metrics.totalNanoAiu ?? 0) / 1e9;
  await resumed.disconnect();
} finally {
  if (!hasFlag("--keep")) await client.deleteSession(sessionId).catch(() => {});
  log.section("results", out);
  console.log(JSON.stringify(out, null, 1));
  await stopClient(client);
  await log.close();
}
