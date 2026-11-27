/**
 * Phase 0 · 01 inventory (no model calls, no premium requests).
 * §11 #10 (models and effort levels), #7 (quota side), #16/#20 (which MCP servers and plugins the runtime discovers
 * from the CLI's own configuration), plus auth identity and built-in tools.
 *
 *   npx tsx src/01-inventory.ts [--inherit-env]
 */
import { createRunLog } from "./lib/log.ts";
import { inheritEnv, startClient, stopClient, strippedEnvKeys } from "./lib/runtime.ts";

const log = createRunLog("01-inventory");
log.info(`env: ${inheritEnv ? "inherited as-is" : `sanitized (dropped ${strippedEnvKeys().length} vars: ${strippedEnvKeys().join(", ")})`}`);

const client = await startClient();
try {
  log.section("runtime", await client.getStatus());
  const status = await client.getStatus();
  log.info(`runtime version ${status.version}, protocol ${status.protocolVersion}`);

  const auth = await client.getAuthStatus();
  log.section("auth", auth);
  log.info(`auth: authenticated=${auth.isAuthenticated} type=${auth.authType} login=${auth.login} host=${auth.host}`);

  const models = await client.listModels();
  log.section("models (client.listModels)", models);
  const rows = models.map((m) => ({
    id: m.id,
    mult: m.billing?.multiplier ?? "?",
    efforts: m.supportedReasoningEfforts?.join("/") ?? (m.capabilities.supports.reasoningEffort ? "(supported, none listed)" : "-"),
    default: m.defaultReasoningEffort ?? "-",
    policy: m.policy?.state ?? "-",
    ctx: m.capabilities.limits.max_context_window_tokens,
    vision: m.capabilities.supports.vision,
  }));
  console.table(rows);

  try {
    const raw = await client.rpc.models.list({});
    log.section("models (rpc.models.list, raw)", raw);
    log.info(`rpc.models.list keys: ${Object.keys(raw).join(", ")}`);
  } catch (e) {
    log.info(`rpc.models.list failed: ${(e as Error).message}`);
  }

  try {
    const quota = await client.rpc.account.getQuota({});
    log.section("quota (rpc.account.getQuota)", quota);
    for (const [kind, snap] of Object.entries(quota.quotaSnapshots)) {
      if (!snap) continue;
      log.info(
        `quota ${kind}: used ${snap.usedRequests}/${snap.entitlementRequests} (${snap.remainingPercentage}% left, unlimited=${snap.isUnlimitedEntitlement}, overage=${snap.overage}, resets ${snap.resetDate ?? "?"})`,
      );
    }
  } catch (e) {
    log.info(`account.getQuota failed: ${(e as Error).message}`);
  }

  // Read-only. The sibling rpc.mcp.config.add/update/remove/enable/disable methods write the user's CLI config:
  // never call them from ARIA's spike. Only a reduced view is recorded (no header values, URL paths or args).
  try {
    const userConfig = (await client.rpc.mcp.config.list()) as unknown as { servers?: Record<string, Record<string, unknown>> };
    const servers = userConfig.servers ?? {};
    const reduced = Object.fromEntries(
      Object.entries(servers).map(([name, cfg]) => {
        let origin: string | undefined;
        try {
          origin = typeof cfg.url === "string" ? new URL(cfg.url).origin : undefined;
        } catch {
          origin = "<unparsable url>";
        }
        return [
          name,
          {
            type: cfg.type ?? "stdio",
            origin,
            command: typeof cfg.command === "string" ? cfg.command : undefined,
            argCount: Array.isArray(cfg.args) ? cfg.args.length : 0,
            headerNames: cfg.headers && typeof cfg.headers === "object" ? Object.keys(cfg.headers) : [],
            envNames: cfg.env && typeof cfg.env === "object" ? Object.keys(cfg.env) : [],
            tools: Array.isArray(cfg.tools) ? `${cfg.tools.length} listed` : cfg.tools,
          },
        ];
      }),
    );
    log.section("MCP servers in the CLI user config (rpc.mcp.config.list, reduced)", reduced);
    console.table(Object.entries(reduced).map(([name, r]) => ({ name, ...r, headerNames: r.headerNames.join(","), envNames: r.envNames.join(",") })));
  } catch (e) {
    log.info(`mcp.config.list failed: ${(e as Error).message}`);
  }

  try {
    const discovered = await client.rpc.mcp.discover({ includeEffectiveSource: true });
    log.section("MCP servers discovered by the runtime (rpc.mcp.discover)", discovered);
    console.table(
      discovered.servers.map((s) => ({
        name: s.name,
        type: s.type ?? "-",
        source: s.source,
        plugin: s.sourcePlugin ?? "-",
        effective: s.effectiveSource ? `${s.effectiveSource.kind}/${s.effectiveSource.editability}` : "-",
        enabled: s.enabled,
      })),
    );
  } catch (e) {
    log.info(`mcp.discover failed: ${(e as Error).message}`);
  }

  try {
    const plugins = await client.rpc.plugins.list();
    log.section("plugins (rpc.plugins.list)", plugins);
    console.log(JSON.stringify(plugins, null, 1).slice(0, 3000));
  } catch (e) {
    log.info(`plugins.list failed: ${(e as Error).message}`);
  }

  try {
    const tools = await client.rpc.tools.list({});
    log.section("built-in tools (rpc.tools.list)", tools);
    const names = (tools as { tools?: Array<{ name: string }> }).tools?.map((t) => t.name) ?? [];
    log.info(`${names.length} tools: ${names.join(", ")}`);
  } catch (e) {
    log.info(`tools.list failed: ${(e as Error).message}`);
  }

  const sessions = await client.listSessions();
  log.info(`existing sessions in the store: ${sessions.length}`);
} finally {
  await stopClient(client);
  await log.close();
}
