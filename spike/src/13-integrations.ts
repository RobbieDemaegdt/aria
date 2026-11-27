/**
 * Phase 3 Part B · 13 integrations (no model calls, except step C with --with-message).
 * PLAN.md §10 Phase 9, "Needs a check with the real runtime", Integrations questions:
 *   1. does getCurrentMetadata() fill mcpServerName, mcpToolName and description for every MCP tool;
 *   4. does a resumed session take new availableTools and disabledMcpServers;
 *   5. which tools the built-in GitHub server lists, and under which names;
 *   7. does mcp.list report a server's url on every check, also for needs-auth and failed servers.
 *
 * Sessions are created, inspected through RPC and deleted. The console shows names, statuses and counts only: an
 * address can carry a key, so only whether it's there and its host. No tool is ever called.
 *
 *   npx tsx src/13-integrations.ts [--only A,B,C,D] [--repo <a clone with a GitHub remote>] [--with-message]
 *
 * A  ARIA's inventory (runtime.inventory): every mcp.list check until settled, and the tool metadata.
 * B  The GitHub server: looked for in mcp.list, events and tool metadata, with and without githubMcpToolConfig.
 * C  Resume with other availableTools and disabledMcpServers (the Conductor's reopen). A session is stored only from
 *    its first message, so this step needs --with-message: two short model calls (about 0.02 AI credits on Haiku).
 * D  A failed server: a session-only HTTP server at a closed loopback port (the CLI config isn't touched).
 */
import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CopilotClient, CopilotSession, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { createRunLog, OUT_DIR } from "./lib/log.ts";
import { argValue, describeModel, hasFlag, pickModel, sleep, startClient, stopClient } from "./lib/runtime.ts";

const log = createRunLog("13-integrations");
const only = argValue("--only")?.toUpperCase().split(",").map((s) => s.trim());
const want = (step: string) => !only || only.includes(step);
const repo = argValue("--repo") ?? path.join(os.homedir(), "Documents", "GitHub", "Moonrise");

interface Check {
  at: number;
  servers: Array<{ name: string; status: string; url: boolean; host?: string; source?: string; plugin?: string; owned: boolean; error?: string }>;
}

const hostOf = (url: string | undefined) => {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return "<unparsable>";
  }
};

async function check(session: CopilotSession, started: number): Promise<Check> {
  const list = await session.rpc.mcp.list();
  return {
    at: Date.now() - started,
    servers: list.servers.map((s) => ({
      name: s.name,
      status: String(s.status),
      url: typeof s.url === "string" && s.url.length > 0,
      ...(s.url ? { host: hostOf(s.url) } : {}),
      ...(s.source ? { source: String(s.source) } : {}),
      ...(s.sourcePlugin ? { plugin: s.sourcePlugin } : {}),
      owned: Boolean(s.owned?.installationId),
      ...(s.error ? { error: s.error } : {}),
    })),
  };
}

/** Every mcp.list check from the session's start until nothing is pending (as runtime.inventory polls), then two more. */
async function checksUntilSettled(session: CopilotSession, started: number, timeoutMs = 30_000): Promise<Check[]> {
  const checks: Check[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const c = await check(session, started);
    checks.push(c);
    if (!c.servers.some((s) => s.status === "pending") || Date.now() > deadline) break;
    await sleep(250);
  }
  for (let i = 0; i < 2; i++) {
    await sleep(1000);
    checks.push(await check(session, started));
  }
  return checks;
}

/** Per server: the statuses it went through and in how many checks its url was there. */
function urlReport(label: string, checks: Check[]) {
  const names = [...new Set(checks.flatMap((c) => c.servers.map((s) => s.name)))];
  const rows = names.map((name) => {
    const seen = checks.map((c) => c.servers.find((s) => s.name === name)).filter((s) => s !== undefined);
    const byStatus = new Map<string, { checks: number; withUrl: number }>();
    for (const s of seen) {
      const row = byStatus.get(s.status) ?? { checks: 0, withUrl: 0 };
      row.checks++;
      if (s.url) row.withUrl++;
      byStatus.set(s.status, row);
    }
    const last = seen.at(-1);
    return {
      server: name,
      source: last?.source ?? "-",
      plugin: last?.plugin ?? "-",
      owned: last?.owned ?? false,
      host: seen.find((s) => s.host)?.host ?? "-",
      "status: checks with url / checks": [...byStatus].map(([status, r]) => `${status} ${r.withUrl}/${r.checks}`).join(", "),
      error: last?.error ? last.error.slice(0, 80) : "",
    };
  });
  log.section(`${label}: mcp.list checks (${checks.length})`, { checks, rows });
  console.table(rows);
}

interface ToolMeta {
  name: string;
  namespacedName?: string;
  mcpServerName?: string;
  mcpToolName?: string;
  description: string;
}

async function metadata(session: CopilotSession): Promise<ToolMeta[]> {
  await session.rpc.tools.initializeAndValidate();
  const meta = await session.rpc.tools.getCurrentMetadata();
  return (meta.tools ?? []).map((t) => ({
    name: t.name,
    ...(t.namespacedName ? { namespacedName: t.namespacedName } : {}),
    ...(t.mcpServerName ? { mcpServerName: t.mcpServerName } : {}),
    ...(t.mcpToolName ? { mcpToolName: t.mcpToolName } : {}),
    description: t.description ?? "",
  }));
}

const wirePrefix = (server: string) => `${server.replace(/\s+/g, "-")}-`;

/** Servers a session's events name (session.mcp_servers_loaded, session.mcp_server_status_changed), with their last status. */
function eventServers(events: SessionEvent[], except: string[] = []): string[] {
  const last = new Map<string, string>();
  for (const e of events) {
    if (e.type === "session.mcp_servers_loaded") for (const s of e.data.servers) last.set(s.name, `${s.status}${s.source ? ` (${s.source})` : ""}`);
    if (e.type === "session.mcp_server_status_changed") last.set(e.data.serverName, String(e.data.status));
  }
  return [...last].filter(([name]) => !except.includes(name)).map(([name, status]) => `${name}=${status}`);
}

/** Which server a tool is from: the runtime's mcpServerName, else the longest listed server prefix of its name. */
function serverOf(tool: ToolMeta, servers: string[]): string | undefined {
  if (tool.mcpServerName) return tool.mcpServerName;
  return servers
    .map((s) => ({ s, p: wirePrefix(s) }))
    .sort((a, b) => b.p.length - a.p.length)
    .find(({ p }) => tool.name.startsWith(p))?.s;
}

function metadataReport(label: string, tools: ToolMeta[], servers: string[]) {
  const byServer = new Map<string, ToolMeta[]>();
  const builtins: string[] = [];
  for (const t of tools) {
    const server = serverOf(t, servers);
    if (server) byServer.set(server, [...(byServer.get(server) ?? []), t]);
    else builtins.push(t.name);
  }
  const rows = [...byServer].map(([server, list]) => ({
    server,
    tools: list.length,
    "no mcpServerName": list.filter((t) => !t.mcpServerName).length,
    "no mcpToolName": list.filter((t) => !t.mcpToolName).length,
    "no description": list.filter((t) => !t.description.trim()).length,
    "name ≠ prefix+mcpToolName": list.filter((t) => t.mcpServerName && t.mcpToolName && t.name !== `${wirePrefix(t.mcpServerName)}${t.mcpToolName}`).length,
    "namespacedName ≠ server/tool": list.filter((t) => t.mcpServerName && t.mcpToolName && t.namespacedName !== undefined && t.namespacedName !== `${t.mcpServerName}/${t.mcpToolName}`).length,
  }));
  log.section(`${label}: tool metadata`, { tools, rows, builtins });
  console.log(`${label}: ${tools.length} tools; ${builtins.length} without a server: ${builtins.join(", ")}`);
  console.table(rows);
  const odd = tools.filter((t) => serverOf(t, servers) && (!t.mcpServerName || !t.mcpToolName || !t.description.trim())).slice(0, 10);
  if (odd.length) console.log(`  first MCP tools with a field missing: ${odd.map((t) => `${t.name} {server:${t.mcpServerName ? "y" : "n"}, tool:${t.mcpToolName ? "y" : "n"}, description:${t.description.trim() ? "y" : "n"}}`).join("; ")}`);
}

const sessions: string[] = [];
async function open(client: CopilotClient, config: Partial<SessionConfig>, events: SessionEvent[] = []): Promise<CopilotSession> {
  const session = await client.createSession({
    clientName: "aria-spike",
    mcpOAuthTokenStorage: "persistent",
    onPermissionRequest: () => ({ kind: "reject", feedback: "Inspection only." }),
    onEvent: (e) => events.push(e),
    ...config,
  });
  sessions.push(session.sessionId);
  return session;
}

async function close(client: CopilotClient, session: CopilotSession) {
  await session.disconnect().catch(() => {});
  await client.deleteSession(session.sessionId).catch((e: Error) => log.info(`deleteSession ${session.sessionId}: ${e.message}`));
}

const client = await startClient();
try {
  const discovered = (await client.rpc.mcp.discover({ includeEffectiveSource: true })).servers;
  log.section("mcp.discover", discovered);
  console.log(`discover: ${discovered.map((s) => `${s.name} (${s.source}${s.enabled ? "" : ", disabled"})`).join(", ")}`);

  // ── A: ARIA's inventory session (runtime.inventory), checked from its start ───────────────────────────────────
  const startedA = Date.now();
  const eventsA: SessionEvent[] = [];
  const inventory = await open(client, {}, eventsA);
  const checksA = await checksUntilSettled(inventory, startedA);
  const toolsA = await metadata(inventory);
  checksA.push(await check(inventory, startedA));
  await close(client, inventory);
  const serverNames = [...new Set(checksA.flatMap((c) => c.servers.map((s) => s.name)))];
  if (want("A")) {
    urlReport("A inventory", checksA);
    metadataReport("A inventory", toolsA, serverNames);
    console.log(`A servers in its events: ${eventServers(eventsA).join(", ")}`);
  }

  const lastA = checksA.at(-1)!.servers;

  // ── B: the built-in GitHub server's tools ─────────────────────────────────────────────────────────────────────
  // mcp.list didn't list it in the inventory session; Phase 0's sessions with a model and a message saw it in
  // session.mcp_servers_loaded. So it's looked for in mcp.list, the events and the tool metadata, per variant.
  if (want("B")) {
    log.section("B GitHub server");
    const model = (await client.listModels()).filter((m) => m.id !== "auto").sort((a, b) => (a.billing?.tokenPrices?.outputPrice ?? 1e9) - (b.billing?.tokenPrices?.outputPrice ?? 1e9))[0]?.id;
    const clone = existsSync(repo) ? { workingDirectory: repo } : {};
    const variants: Array<{ label: string; config: Partial<SessionConfig> }> = [
      { label: "B1 the inventory's config", config: {} },
      { label: "B2 in-memory tokens (the SDK default)", config: { mcpOAuthTokenStorage: "in-memory" } },
      { label: `B3 model ${model} set (no message sent)`, config: model ? { model } : {} },
      { label: `B4 workingDirectory = ${path.basename(repo)} (a GitHub clone)`, config: clone },
      { label: "B5 githubMcpToolConfig.enableAllTools", config: { githubMcpToolConfig: { enableAllTools: true } } },
      { label: "B6 all of B3–B5", config: { ...(model ? { model } : {}), ...clone, githubMcpToolConfig: { enableAllTools: true } } },
      { label: "B7 githubMcpToolConfig: {} (the default toolsets?)", config: { githubMcpToolConfig: {} } },
      { label: "B8 githubMcpToolConfig.enableAllTools: false", config: { githubMcpToolConfig: { enableAllTools: false } } },
    ];
    const names: Record<string, string[]> = {};
    for (const v of variants) {
      const started = Date.now();
      const events: SessionEvent[] = [];
      const session = await open(client, { disabledMcpServers: serverNames, ...v.config }, events);
      const checks = await checksUntilSettled(session, started, 15_000);
      const tools = (await metadata(session)).filter((t) => /github/i.test(t.mcpServerName ?? "") || /^github/i.test(t.name));
      await sleep(1000);
      await close(client, session);
      const listed = checks.at(-1)!.servers.filter((s) => !serverNames.includes(s.name));
      names[v.label] = tools.map((t) => t.mcpToolName ?? t.name);
      log.record(`B:${v.label}`, { listed, events: events.filter((e) => e.type.startsWith("session.mcp")), tools });
      console.log(
        `${v.label}: mcp.list [${listed.map((s) => `${s.name}=${s.status}${s.url ? ` url ${s.host}` : ""}`).join(", ") || "-"}]; events [${eventServers(events, serverNames).join(", ") || "-"}]; ${tools.length} GitHub tools`,
      );
      if (tools.length) console.log(`  ${names[v.label]!.join(", ")}`);
    }
    const file = path.join(OUT_DIR, "13-github-tools.json");
    writeFileSync(file, `${JSON.stringify({ variants: names }, null, 1)}\n`);
    console.log(`GitHub tool names written to ${file}`);
  }

  // ── C: resume with other availableTools and disabledMcpServers ─────────────────────────────────────────────────
  if (want("C") && !hasFlag("--with-message")) {
    log.section("C resume");
    console.log("skipped: a session is stored only from its first message, so this step makes two model calls. Run it with --with-message.");
  } else if (want("C")) {
    log.section("C resume");
    const choice = await pickModel(client);
    const model = { model: choice.model, ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}) };
    log.info(`C model ${describeModel(choice)}`);
    const connected =lastA.filter((s) => s.status === "connected" && toolsA.some((t) => serverOf(t, serverNames) === s.name));
    const [s1, s2] = connected;
    if (!s1 || !s2) {
      console.log(`needs two connected servers with tools; have ${connected.map((s) => s.name).join(", ") || "none"}`);
    } else {
      // Only listed, never called (no model in this script); a read tool all the same.
      const pick = (server: string) => {
        const own = toolsA.filter((t) => serverOf(t, serverNames) === server);
        return (own.find((t) => /^(get|list)/i.test(t.mcpToolName ?? "")) ?? own[0]!).name;
      };
      const t1 = pick(s1.name);
      const t2 = pick(s2.name);
      const first = { availableTools: ["builtin:view", `mcp:${t1}`], disabledMcpServers: serverNames.filter((n) => n !== s1.name) };
      const second = { availableTools: ["builtin:grep", `mcp:${t2}`], disabledMcpServers: serverNames.filter((n) => n !== s2.name) };
      const sessionId = `aria-spike-13-resume-${Date.now()}`;
      const events: SessionEvent[] = [];
      const describe = async (label: string, session: CopilotSession, started: number) => {
        const checks = await checksUntilSettled(session, started);
        const tools = (await metadata(session)).map((t) => t.name).sort();
        const status = (name: string) => checks.at(-1)!.servers.find((s) => s.name === name)?.status ?? "(not listed)";
        log.record(`C:${label}`, { tools, checks });
        console.log(`${label}: tools [${tools.join(", ")}]; ${s1.name}=${status(s1.name)}, ${s2.name}=${status(s2.name)}`);
        return tools;
      };
      const handlers = {
        clientName: "aria-spike",
        mcpOAuthTokenStorage: "persistent" as const,
        // Nothing may run: the model is only asked to name its tools.
        onPermissionRequest: () => ({ kind: "reject" as const, feedback: "Inspection only: don't call tools." }),
        onAutoModeSwitchRequest: () => "no" as const,
        onEvent: (e: SessionEvent) => events.push(e),
      };
      const startedC = Date.now();
      const created = await client.createSession({ sessionId, ...model, ...handlers, ...first });
      sessions.push(sessionId);
      console.log(`created with availableTools ${JSON.stringify(first.availableTools)}, only ${s1.name} enabled`);
      const before = await describe("C1 created", created, startedC);
      // A session is stored only from its first message: one that was only created can't be resumed ("Session not
      // found"), not even after an info entry (session.log) flushed with sessions.save. So this step needs one model
      // call, and a second one asks the resumed model which tools it has.
      log.info(`C: getSessionMetadata before any message: ${(await client.getSessionMetadata(sessionId)) ? "found" : "not found"}`);
      const askTools = "Without calling any tool, list the exact names of the tools you can call, comma-separated, nothing else.";
      const reply1 = await created.sendAndWait({ prompt: askTools }, 120_000);
      console.log(`C1 the model says it has: ${reply1?.data.content.trim() ?? "(no reply)"}`);
      await created.disconnect();
      const startedR = Date.now();
      const resumed = await client.resumeSession(sessionId, { ...model, ...handlers, ...second });
      console.log(`resumed with availableTools ${JSON.stringify(second.availableTools)}, only ${s2.name} enabled`);
      const after = await describe("C2 resumed", resumed, startedR);
      const expected = ["grep", t2].sort();
      console.log(`resumed session took the new tools: ${JSON.stringify(after) === JSON.stringify(expected) ? "YES" : `NO (expected ${expected.join(", ")}, before ${before.join(", ")})`}`);
      const reply2 = await resumed.sendAndWait({ prompt: askTools }, 120_000);
      console.log(`C2 the model says it has: ${reply2?.data.content.trim() ?? "(no reply)"}`);
      const resumeEvent = events.find((e) => e.type === "session.resume");
      log.record("C:session.resume", resumeEvent);
      console.log(`tool calls: ${events.filter((e) => e.type === "tool.execution_start").length}; events: ${[...new Set(events.map((e) => e.type))].join(", ")}`);
      const metrics = await resumed.rpc.usage.getMetrics();
      log.info(`C cost: ${metrics.totalPremiumRequestCost} premium requests, ${((metrics.totalNanoAiu ?? 0) / 1e9).toFixed(3)} AI credits`);
      await close(client, resumed);
    }
  }

  // ── D: a failed server (session-only HTTP server at a closed loopback port) ────────────────────────────────────
  if (want("D")) {
    const started = Date.now();
    const session = await open(client, {
      disabledMcpServers: serverNames,
      mcpServers: { "aria-spike-dead": { type: "http", url: "http://127.0.0.1:9/mcp", tools: ["*"] } },
    });
    const checks = await checksUntilSettled(session, started);
    await close(client, session);
    urlReport("D failed server", checks);
  }
} finally {
  for (const id of sessions) await client.deleteSession(id).catch(() => {});
  await stopClient(client);
  await log.close();
}
