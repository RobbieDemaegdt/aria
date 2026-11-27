/**
 * Phase 5C: Work IQ and task-tracker read-tool scoping and permission policy for the Timekeeper session
 * (PLAN.md §4.12, §4.13, §4.14, §10 Phase 5C).
 *
 * - Only read-class (`cls === "read"`) MCP tools whose effective rule for `aria` is `"auto"`, on non-duplicate
 *   connected servers in the Timekeeper's scope:
 *   - the task tracker's server read tools, **excluding** `api_get` (§4.13 table: `api_get` is `never` for
 *     Timekeeper);
 *   - Work IQ Calendar (`GetUserDateAndTimeZoneSettings`, `ListCalendarView`, `ListEvents`) and Work IQ Teams
 *     (`ListChats`, `ListChatMessages`) read tools (explicitly excluding `Work IQ Mail` and generic `workiq` plugin
 *     write/fetch tools);
 *   - GitHub read tools.
 * - No built-in file or shell tools (`view`, `glob`, `grep`, `powershell`, `write`, `web_fetch` are all excluded).
 * - Only the `propose_timesheet` custom tool (`custom:*`) is available for returning the draft.
 */
import type { McpConfigState } from "../integrations/config.ts";
import { duplicates, isSeen, viewTools, type Catalog, type StoredRule } from "../integrations/rules.ts";
import { classifyTool, serverWirePrefix } from "../integrations/scope.ts";
import type { PermissionAsk, PermissionVerdict, PolicyDecider } from "../runtime/types.ts";
import type { TaskTracker } from "../trackers/types.ts";

/** Exact Work IQ Calendar, Teams, and Mail read tools the Timekeeper may use (§4.14, spike 09). */
const ALLOWED_WORKIQ_TOOLS = new Set([
  "getuserdateandtimezonesettings",
  "listcalendarview",
  "listevents",
  "listchats",
  "listchatmessages",
  "searchmessages",
  "searchmessagesqueryparameters",
  "getmessage",
]);

function isWorkIqReadServer(server: string): boolean {
  return /work\s*-?\s*iq\s*-?\s*(?:calendar|teams|mail)/i.test(server);
}

function isApiGet(tool: string, wireName: string): boolean {
  const t = tool.trim().toLowerCase();
  const w = wireName.trim().toLowerCase();
  return t === "api_get" || w === "api_get" || w.endsWith("-api_get");
}

export interface TimekeeperScope {
  availableTools: string[];
  disabledMcpServers: string[];
  readTools: ReadonlySet<string>;
}

/**
 * Computes the Timekeeper session's `availableTools` and `disabledMcpServers` from the catalog and your rules.
 */
export function timekeeperScope(
  tracker: TaskTracker,
  catalog: Catalog,
  storedRules: readonly StoredRule[],
  mcpConfig?: McpConfigState,
): TimekeeperScope {
  const views = viewTools(catalog, storedRules);
  const dupes = duplicates(catalog);
  const disabledInConfig = new Set(
    [
      ...(mcpConfig?.servers ?? []).filter((s) => !s.enabled).map((s) => s.name),
      ...catalog.servers.filter((s) => isSeen(catalog, s) && s.status === "disabled").map((s) => s.name),
    ],
  );
  const seenServers = [
    ...new Set([
      ...catalog.servers.filter((s) => isSeen(catalog, s)).map((s) => s.name),
      ...(mcpConfig?.servers ?? []).map((s) => s.name),
    ]),
  ];

  const allowedRefs = views.filter((v) => {
    if (!v.seen || dupes.has(v.entry.server) || disabledInConfig.has(v.entry.server)) return false;
    if (v.cls !== "read" || classifyTool(v.entry.tool) !== "read") return false;
    if (v.rules.aria.effect !== "auto") return false;
    if (isApiGet(v.entry.tool, v.entry.wireName)) return false;

    if (tracker.matchesServer(v.entry.server)) return true;
    if (isWorkIqReadServer(v.entry.server)) {
      const normalized = v.entry.tool.replace(/[\s_-]+/g, "").toLowerCase();
      return ALLOWED_WORKIQ_TOOLS.has(normalized);
    }
    if (v.github) return true;
    return false;
  });

  const usedServers = new Set(allowedRefs.map((v) => v.entry.server));
  const readTools = new Set(allowedRefs.map((v) => v.entry.wireName));

  return {
    availableTools: ["custom:*", ...allowedRefs.map((v) => `mcp:${v.entry.wireName}`)],
    disabledMcpServers: seenServers.filter((name) => !usedServers.has(name) || disabledInConfig.has(name)),
    readTools,
  };
}

/**
 * Permission handler for the Timekeeper session: second line of defense behind `availableTools` and
 * `disabledMcpServers`. Approves only `propose_timesheet` and the scoped read MCP tools; rejects all writes, `api_get`,
 * shell, file, and URL requests.
 */
export class TimekeeperPolicy implements PolicyDecider {
  constructor(private readonly allowedMcpWires: ReadonlySet<string>) {}

  decide(ask: PermissionAsk): PermissionVerdict {
    if (ask.kind === "custom-tool") {
      return ask.tool === "propose_timesheet"
        ? { approve: true }
        : { approve: false, reason: "The Timekeeper may only call propose_timesheet." };
    }
    if (ask.kind === "mcp") {
      const prefix = serverWirePrefix(ask.server);
      const tool = ask.tool.startsWith(prefix) ? ask.tool.slice(prefix.length) : ask.tool;
      if (isApiGet(tool, ask.tool)) {
        return { approve: false, reason: "Generic api_get is not allowed in the Timekeeper session." };
      }
      if (classifyTool(tool) !== "read") {
        return { approve: false, reason: "The Timekeeper session is strictly read-only." };
      }
      if (!this.allowedMcpWires.has(ask.tool)) {
        return { approve: false, reason: `${ask.tool} is not in the Timekeeper's read-only scope.` };
      }
      return { approve: true };
    }
    return { approve: false, reason: "The Timekeeper session is read-only and may only use its scoped MCP read tools and propose_timesheet." };
  }
}
