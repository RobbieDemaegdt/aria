/**
 * Phase 0 · 03 scopes (no model calls).
 * §11 #5 (restrict the Conductor's built-in tools), #16 (hide ambient plugins/servers per session), #20 (CLI MCP
 * servers in SDK sessions, incl. ones that need sign-in), plus the exact wire names of MCP tools.
 *
 * Every session here is created, inspected through RPC (servers, effective tool list, skills, agents) and deleted.
 * Nothing is sent to a model.
 *
 *   npx tsx src/03-scopes.ts [--inherit-env]
 *
 * Checks E and F name the task tracker's MCP server: set SPIKE_TRACKER_SERVER to it (the default, `Acme`, is made up).
 */
import { ToolSet, type CopilotClient, type SessionConfig, type SessionEvent } from "@github/copilot-sdk";
import { createRunLog } from "./lib/log.ts";
import { argValue, sleep, startClient, stopClient } from "./lib/runtime.ts";

const log = createRunLog("03-scopes");

/** The task tracker's MCP server as the runtime names it, for checks E and F. */
const TRACKER_SERVER = process.env.SPIKE_TRACKER_SERVER ?? "Acme";

interface Inspection {
  label: string;
  servers: Array<{ name: string; status: string; source?: string; error?: string }>;
  tools: Array<{ name: string; namespacedName?: string }>;
  skills: string[];
  agents: string[];
}

const SETTLED = new Set(["connected", "failed", "disabled", "needs-auth", "not_configured"]);

async function inspect(client: CopilotClient, label: string, config: Partial<SessionConfig>): Promise<Inspection> {
  const events: SessionEvent[] = [];
  const session = await client.createSession({
    clientName: "aria-spike",
    onPermissionRequest: () => ({ kind: "reject", feedback: "inspection only" }),
    onEvent: (e) => events.push(e),
    ...config,
  });
  try {
    let servers: Inspection["servers"] = [];
    const deadline = Date.now() + 30_000;
    for (;;) {
      const list = await session.rpc.mcp.list();
      servers = list.servers.map((s) => ({
        name: s.name,
        status: String(s.status),
        ...(s.source ? { source: String(s.source) } : {}),
        ...(s.error ? { error: s.error } : {}),
      }));
      if (servers.every((s) => SETTLED.has(s.status)) || Date.now() > deadline) break;
      await sleep(500);
    }
    await session.rpc.tools.initializeAndValidate();
    const meta = await session.rpc.tools.getCurrentMetadata();
    const tools = (meta.tools ?? []).map((t) => ({ name: t.name, ...(t.namespacedName ? { namespacedName: t.namespacedName } : {}) }));
    const skillsEvent = events.filter((e) => e.type === "session.skills_loaded").at(-1);
    const skills = skillsEvent && skillsEvent.type === "session.skills_loaded" ? skillsEvent.data.skills.map((s) => `${s.name}(${s.source})`) : [];
    let agents: string[] = [];
    try {
      const list = await session.rpc.agent.list();
      agents = list.agents.map((a) => `${a.name}${"source" in a && a.source ? `(${String(a.source)})` : ""}`);
    } catch (e) {
      agents = [`<agent.list failed: ${(e as Error).message}>`];
    }
    const result: Inspection = { label, servers, tools, skills, agents };
    log.record(`inspection:${label}`, { ...result, config: { ...config, onEvent: undefined } });
    return result;
  } finally {
    await session.disconnect().catch(() => {});
    await client.deleteSession(session.sessionId).catch(() => {});
  }
}

function report(r: Inspection) {
  log.section(r.label);
  console.log(`servers: ${r.servers.map((s) => `${s.name}=${s.status}${s.error ? ` (${s.error})` : ""}`).join(", ")}`);
  const builtin = r.tools.filter((t) => !t.namespacedName && !t.name.includes("-"));
  const mcp = r.tools.filter((t) => t.namespacedName || t.name.includes("-"));
  console.log(`tools: ${r.tools.length} total · ${builtin.length} without server prefix: ${builtin.map((t) => t.name).join(", ")}`);
  const byServer = new Map<string, string[]>();
  for (const t of mcp) {
    const server = r.servers.map((s) => s.name).find((s) => t.name.startsWith(`${s}-`)) ?? "(no listed server)";
    byServer.set(server, [...(byServer.get(server) ?? []), t.name]);
  }
  for (const [server, names] of byServer) console.log(`  ${server}: ${names.length} → ${names.slice(0, 6).join(", ")}${names.length > 6 ? ", …" : ""}`);
  console.log(`skills: ${r.skills.join(", ") || "-"}`);
  console.log(`agents: ${r.agents.join(", ") || "-"}`);
}

const only = argValue("--only")?.toUpperCase().split(",").map((s) => s.trim());
const want = (step: string) => !only || only.includes(step);

const client = await startClient();
try {
  // Always computed: later steps derive server and tool names from it.
  const baseline = await inspect(client, "A baseline (defaults)", {});
  if (want("A")) report(baseline);

  if (want("B")) report(await inspect(client, "B mcpOAuthTokenStorage=persistent", { mcpOAuthTokenStorage: "persistent" }));

  if (want("C")) {
    report(
      await inspect(client, "C Conductor scope (read-only built-ins + MCP + custom)", {
        availableTools: new ToolSet().addBuiltIn(["view", "glob", "grep", "web_fetch", "skill"]).addMcp("*").addCustom("*"),
        disabledMcpServers: ["example-server"],
      }),
    );
  }

  if (want("D")) {
    const workerServers = baseline.servers.map((s) => s.name).filter((n) => n !== "github-mcp-server");
    report(await inspect(client, "D Worker scope (all non-GitHub MCP servers disabled)", { disabledMcpServers: workerServers }));
  }

  if (want("E")) {
    // Timekeeper: exact wire names (`<server>-<tool>`) for some tools, wildcard patterns for others, to learn what
    // the matcher accepts.
    const mine = baseline.tools.find((t) => t.name === `${TRACKER_SERVER}-list_my_issues`);
    const timekeeperPatterns = [...(mine ? [`mcp:${mine.name}`] : []), `mcp:${TRACKER_SERVER}-get_*`, `mcp:${TRACKER_SERVER}-*`, "builtin:view"];
    log.info(`timekeeper availableTools patterns: ${JSON.stringify(timekeeperPatterns)}`);
    report(await inspect(client, "E Timekeeper allowlist (exact + wildcard patterns)", { availableTools: timekeeperPatterns }));
  }

  if (want("F")) {
    report(
      await inspect(client, `F excludedTools (builtin:powershell, mcp:${TRACKER_SERVER}-create_*)`, {
        excludedTools: ["builtin:powershell", `mcp:${TRACKER_SERVER}-create_*`, `mcp:${TRACKER_SERVER}-create_issue`],
      }),
    );
  }

  if (want("G")) report(await inspect(client, "G enableConfigDiscovery=true", { enableConfigDiscovery: true }));
} finally {
  await stopClient(client);
}

if (want("H")) {
  // Separate runtime: plugins are loaded per process, so COPILOT_PLUGIN_DIR_ONLY has to be set on the runtime's env.
  const pluginDirOnly = await startClient({ extraEnv: { COPILOT_PLUGIN_DIR_ONLY: "true" } });
  try {
    report(await inspect(pluginDirOnly, "H runtime with COPILOT_PLUGIN_DIR_ONLY=true", {}));
  } finally {
    await stopClient(pluginDirOnly);
  }
}
await log.close();
