/**
 * Customize › Integrations in words (PLAN.md §4.13): where a server comes from, its status, what a rule means for a
 * scope, and when to warn. Names and descriptions come from MCP servers: the engine cleaned and cut them, and the page
 * shows them as plain text only.
 */
import type { IntegrationScope, IntegrationServer, IntegrationTool, Task, ToolClass, ToolRuleEffect, TrackerInfo } from "@aria/protocol";
import { trackerLabel } from "./tracker";

export function sourceLabel(server: Pick<IntegrationServer, "source" | "sourcePlugin">): string {
  switch (server.source) {
    case "user":
      return "Copilot CLI config";
    case "aria":
      return "ARIA config";
    case "plugin":
      return server.sourcePlugin ? `Plugin ${server.sourcePlugin}` : "A plugin";
    case "builtin":
      return "Built into the runtime";
    case "workspace":
      return "This workspace";
    case "managed":
      return "Managed";
    case "account":
      return "Your account";
    default:
      return server.source ?? "Unknown";
  }
}

export function statusLabel(server: Pick<IntegrationServer, "status" | "error" | "configuredInAria">): string {
  switch (server.status) {
    case "connected":
      return "Connected";
    case "needs-auth":
      return "Needs sign-in";
    case "failed":
      return server.error ? `Failed: ${server.error}` : "Failed";
    case "pending":
      return "Starting";
    case "disabled":
      return server.configuredInAria ? "Disabled in ARIA" : "Turned off in Copilot CLI";
    case "stopped":
      return "Stopped";
    case "not_configured":
      return "Not configured";
    default:
      return server.status;
  }
}

export const canSignIn = (server: IntegrationServer) => server.seen && (server.status === "needs-auth" || server.status === "failed");

export function effectLabel(effect: ToolRuleEffect, scope: IntegrationScope, cls: ToolClass): string {
  if (effect === "auto") return "Runs on its own";
  if (effect === "never") return "Never";
  if (scope === "aria") return "Ask (action card)";
  return cls === "read" ? "Asks you" : "Asks you every time";
}

/** What a server's read tools reach, in words, where ARIA knows the server (Work IQ, the task tracker); else undefined. */
export function serverReaches(server: Pick<IntegrationServer, "name" | "sourcePlugin" | "tracker"> | undefined, tracker?: TrackerInfo): string | undefined {
  if (!server) return undefined;
  if (/work\s*-?\s*iq/i.test(server.name) || server.sourcePlugin?.toLowerCase() === "workiq") return "your mail, chats and calendar";
  // A server of the task tracker (core matches it by name: `IntegrationServer.tracker`).
  if (server.tracker) return `your ${trackerLabel(tracker)} tasks and time`;
  return undefined;
}

/**
 * A task's read tool that's on (Auto or Ask), and what it could reach. D32: a server other than GitHub's, which tasks
 * don't read by default. D35: GitHub's, which they do, across every repository the account can see.
 */
export function workDataWarning(tool: IntegrationTool, server?: Pick<IntegrationServer, "name" | "sourcePlugin" | "tracker">, tracker?: TrackerInfo): string | undefined {
  const rule = tool.rules.tasks;
  if (tool.cls !== "read" || rule.effect === "never") return undefined;
  if (tool.github) {
    // Already on Ask, the advice left is Never.
    const instead = rule.effect === "ask" ? "Never" : "Ask or Never";
    return `Tasks follow a repository's instructions too: those could steer a task to read another repository your GitHub account can see (private ones and other organisations' included) and copy it into its work. Set Tasks to ${instead} for this tool if that's a risk.`;
  }
  const reaches = serverReaches(server, tracker);
  const read = reaches ? `read ${reaches} through this tool` : "read whatever this tool can reach";
  return `Tasks follow a repository's instructions too: those could steer a task to ${read}, and put it in the repository. Set Tasks back to Never unless a task needs it.`;
}

/**
 * Whether a rule's note shows under its select. The general rules are said once above the list (m4); a note shows for
 * what's different on this row: a select locked by a fixed rule (D31), or ARIA's Ask on a read tool, which works like
 * Never until the action cards (D22) although the class would let it run on its own.
 */
export function noteShown(scope: IntegrationScope, tool: Pick<IntegrationTool, "cls" | "rules">): boolean {
  const rule = tool.rules[scope];
  if (!rule.note) return false;
  if (rule.allowed.length === 1) return true;
  return scope === "aria" && tool.cls === "read" && rule.effect === "ask";
}

/** Your rules (not the defaults) for a server's tools: which tool, for which scope. */
export function yourRules(tools: readonly IntegrationTool[], server: string): Array<{ tool: string; scope: IntegrationScope }> {
  return tools.filter((t) => t.server === server).flatMap((t) => (["aria", "tasks"] as const).filter((scope) => !t.rules[scope].isDefault).map((scope) => ({ tool: t.tool, scope })));
}

/** Tasks whose session is open now: they keep the tools they opened with until they start again. */
export const runningTasks = (tasks: readonly Task[]) => tasks.filter((t) => ["starting", "running", "waiting_input", "waiting_permission", "waiting_plan"].includes(t.state)).length;

/** The servers in their order on the page: the ones in your setup by name, then the ones that are gone. */
export function orderedServers(servers: readonly IntegrationServer[]): IntegrationServer[] {
  return [...servers].sort((a, b) => Number(b.seen) - Number(a.seen) || a.name.localeCompare(b.name));
}

/** The tools to show: by a filter on the server's and tool's names, and optionally only those with a rule of yours. */
export function filterTools(tools: readonly IntegrationTool[], query: string, onlyChanged: boolean): IntegrationTool[] {
  const q = query.trim().toLowerCase();
  return tools.filter((t) => (!onlyChanged || !t.rules.aria.isDefault || !t.rules.tasks.isDefault) && (!q || t.tool.toLowerCase().includes(q) || t.server.toLowerCase().includes(q)));
}

export const shortDate = (at: number) => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
