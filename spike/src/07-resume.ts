/**
 * Phase 0 · 07 resume after a crash. Phase 0 bullet 4 · §11 #14 (is getEvents() enough to rebuild a transcript).
 *
 *   npx tsx src/07-resume.ts start    # runs one full turn, then crashes itself while a tool call is in flight
 *   npx tsx src/07-resume.ts resume   # new process: resumes, inspects getEvents(), asks a follow-up, deletes it
 *
 * The session ID is unique per run and kept in .out/07-resume-manifest.json; `resume` only touches (and deletes) the
 * session named there, never any other session in the shared Copilot session store.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineTool, type CopilotClient, type SessionConfig, type SessionEvent } from "@github/copilot-sdk";
import { z } from "zod";
import { createRunLog, eventPrinter, OUT_DIR } from "./lib/log.ts";
import { realServerNames, scratchPolicy } from "./lib/policy.ts";
import { describeModel, pickModel, sleep, startClient, stopClient } from "./lib/runtime.ts";

const MANIFEST = path.join(OUT_DIR, "07-resume-manifest.json");
const BLOCK_AT = 4;
const phase = process.argv[2];
if (phase !== "start" && phase !== "resume") throw new Error("usage: 07-resume.ts start|resume");

const dir = path.join(OUT_DIR, "scratch-07");
mkdirSync(dir, { recursive: true });
const log = createRunLog(`07-resume-${phase}`);
const notes: string[] = [];
let blocked: () => void = () => {};
const toolBlocked = new Promise<void>((resolve) => (blocked = resolve));

/** Handlers are not persisted by the runtime: both phases must pass the same ones. */
async function config(client: CopilotClient, events: SessionEvent[]): Promise<Omit<SessionConfig, "sessionId">> {
  const choice = await pickModel(client);
  log.info(`model ${describeModel(choice)}`);
  const print = eventPrinter(log, phase!);
  return {
    clientName: "aria-spike",
    model: choice.model,
    ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}),
    workingDirectory: dir,
    disabledMcpServers: await realServerNames(client),
    tools: [
      defineTool("aria_note", {
        description: "Stores a short note in ARIA.",
        parameters: z.object({ text: z.string() }),
        defer: "never",
        handler: async ({ text }) => {
          notes.push(text);
          if (phase === "start" && notes.length >= BLOCK_AT) {
            // Never resolves: guarantees a tool call is in flight when the process is killed.
            blocked();
            await new Promise(() => {});
          }
          return { stored: true, count: notes.length };
        },
      }),
    ],
    onEvent: (event) => {
      events.push(event);
      print(event);
    },
    onPermissionRequest: scratchPolicy(dir, { onDecision: (r, d, why) => log.info(`  permission ${r.kind}: ${d} (${why})`) }),
    onUserInputRequest: async (request) => {
      log.info(`  ask_user: ${JSON.stringify(request)} → Otter`);
      return { answer: "Otter", wasFreeform: false };
    },
    onAutoModeSwitchRequest: () => "no",
  };
}

const client = await startClient();
const events: SessionEvent[] = [];

if (phase === "start") {
  if (existsSync(MANIFEST)) throw new Error(`${MANIFEST} exists: run "resume" first (or delete the manifest if that session is gone).`);
  const sessionId = `aria-spike-resume-${Date.now()}`;
  writeFileSync(MANIFEST, `${JSON.stringify({ sessionId, createdAt: new Date().toISOString() })}\n`);
  const session = await client.createSession({ sessionId, ...(await config(client, events)) });
  log.info(`session ${sessionId}; runtime is a child of node pid ${process.pid}`);
  await session.sendAndWait(
    {
      prompt:
        "Use ask_user to ask me for a codename, with the choices Falcon and Otter. Then call aria_note with the codename, " +
        "then create the file codename.txt containing only the codename. Reply with one short line.",
    },
    180_000,
  );
  log.info(`turn 1 done; notes=${JSON.stringify(notes)}`);
  await session.send({
    prompt: "Now call aria_note 30 times, once per number from 1 to 30, one call per message and in order. Do not stop early.",
  });
  const watchdog = sleep(180_000).then(() => "timeout" as const);
  if ((await Promise.race([toolBlocked.then(() => "blocked" as const), watchdog])) === "timeout") {
    log.info("watchdog: the model never reached the blocking call; not a crash test. Cleaning up.");
    await client.deleteSession(sessionId).catch(() => {});
    rmSync(MANIFEST, { force: true });
    await stopClient(client);
    await log.close();
    process.exit(2);
  }
  await sleep(500);
  log.info(`notes so far: ${JSON.stringify(notes)}; aria_note call #${BLOCK_AT} is in flight → SIGKILL (simulated crash, no cleanup)`);
  await log.close();
  process.kill(process.pid, "SIGKILL");
} else {
  if (!existsSync(MANIFEST)) throw new Error(`${MANIFEST} not found: run "start" first.`);
  const { sessionId } = JSON.parse(readFileSync(MANIFEST, "utf8")) as { sessionId: string };
  const listed = (await client.listSessions()).find((s) => s.sessionId === sessionId);
  log.section("listSessions entry", listed);
  console.log(JSON.stringify(listed));
  if (!listed) throw new Error(`session ${sessionId} from the manifest is not in the store`);
  const session = await client.resumeSession(sessionId, await config(client, events));
  try {
    const history = await session.getEvents();
    const types = new Map<string, number>();
    for (const e of history) types.set(e.type, (types.get(e.type) ?? 0) + 1);
    log.section("getEvents() type counts", Object.fromEntries(types));
    console.table([...types].map(([type, count]) => ({ type, count })));
    log.record("getEvents", history);

    const has = (type: string) => history.find((e) => e.type === type);
    const toolStart = history.find((e) => e.type === "tool.execution_start");
    const toolDone = history.find((e) => e.type === "tool.execution_complete");
    log.info(`tool.execution_start sample: ${JSON.stringify(toolStart && "data" in toolStart ? toolStart.data : null).slice(0, 400)}`);
    log.info(`tool.execution_complete sample: ${JSON.stringify(toolDone && "data" in toolDone ? toolDone.data : null).slice(0, 400)}`);
    for (const t of ["user.message", "assistant.message", "permission.requested", "permission.completed", "user_input.requested", "user_input.completed", "external_tool.requested", "session.resume", "abort", "assistant.usage", "session.idle"]) {
      log.info(`  persisted ${t}: ${has(t) ? "yes" : "no"}`);
    }
    const resumeEvent = events.find((e) => e.type === "session.resume");
    log.info(`live session.resume event: ${JSON.stringify(resumeEvent && "data" in resumeEvent ? resumeEvent.data : null)}`);
    const warnings = events.filter((e) => e.type === "session.warning");
    log.info(`live warnings after resume: ${JSON.stringify(warnings.map((w) => ("data" in w ? w.data : null)))}`);

    const reply = await session.sendAndWait({ prompt: "Without calling any tools: which codename did I pick, and what was the last number you noted before you were interrupted?" }, 180_000);
    log.info(`follow-up reply: ${reply?.data.content}`);
    await session.disconnect();
  } finally {
    await client.deleteSession(sessionId).catch((e: Error) => log.info(`deleteSession: ${e.message}`));
    rmSync(MANIFEST, { force: true });
    await stopClient(client);
    await log.close();
  }
}
