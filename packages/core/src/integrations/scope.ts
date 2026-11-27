/**
 * Tool classes from names and the Conductor's scope (PLAN.md §4.13).
 *
 * Phase 0 facts this relies on: MCP tool wire names are `<server>-<tool>` with spaces in the server name turned into
 * hyphens; `availableTools` only matches exact names or a bare `*`; the runtime's own `readOnly` flag is false for
 * tools without MCP annotations, so it can't decide the class.
 *
 * The class fails closed (D33): a tool reads only when its name starts with a read verb and has no word anywhere that
 * changes something; anything else is a write (or destructive, or unrestricted).
 */
import type { ToolClass } from "@aria/protocol";

export type { ToolClass };

/** First word of a read tool. (`test` isn't one: `test_webhook` sends something; only a connection test reads.) */
const READ_VERBS = new Set(["get", "list", "search", "find", "fetch", "retrieve", "read", "query", "ask", "lookup", "show", "describe", "count", "check", "view"]);
/**
 * Whole names, as their words (`toolWords`) with a space between, that read although the rules below would call them
 * writes: a connection test (`test connection`, `test connections`, `test connectivity`: `test` isn't a read verb),
 * Work IQ Calendar's `GetUserDateAndTimeZoneSettings` ("date and time zone" is one thing, not a second action), and
 * GitHub's reads named `<thing>_read`, `_get` or `_list` (spike 13, D35).
 */
const READ_NAMES = new Set([
  "test connection", "test connections", "test connectivity", "get user date and time zone settings",
  "issue read", "pull request read", "actions get", "actions list", "projects get", "projects list", "repository ruleset read",
  "custom properties read",
]);
/** A second action joined to the first: `search_and_book_flight`, `find_or_provision_vm`, `fetch_then_store`. */
const JOINS = new Set(["and", "or", "then"]);
/**
 * Verb pairs that change something, where the first word alone would read: `check_in_changes`, `check_out_branch`,
 * `check_off_item`. Only these pairs: `search_in_files` and `list_in_progress_tasks` still read. (A name that doesn't
 * start with a read verb is a write anyway, so only the first two words are looked at.)
 */
const VERB_PAIRS = new Set([
  "check in", "check out", "check off", "log in", "log on", "log out", "log off", "sign in", "sign on", "sign out",
  "sign off", "sign up", "opt in", "opt out",
]);
/** Any of these words anywhere in the name makes it a write ("HassListAddItem" is a write, not a list). */
const WRITE_WORDS = new Set([
  "create", "update", "add", "set", "send", "reply", "forward", "accept", "decline", "tentatively", "cancel", "flag",
  "upload", "post", "patch", "put", "move", "copy", "rename", "assign", "start", "stop", "turn", "toggle", "apply",
  "submit", "register", "schedule", "broadcast", "mark", "clear", "edit", "write", "save", "publish", "invite",
  "approve", "reject", "merge", "close", "open", "run", "execute", "trigger", "do", "call", "complete", "pause",
  "resume", "mute", "unmute", "unpause", "next", "previous", "clean", "return", "lock", "unlock", "enable", "disable",
  "install", "uninstall", "restart", "reset", "change", "modify", "upsert", "insert", "share", "transfer",
  // Added with Customize › Integrations (D33): verbs that only change something, wherever they are in the name.
  "replace", "overwrite", "append", "import", "restore", "rollback", "revert", "migrate", "deploy", "attach", "detach",
  "unlink", "subscribe", "unsubscribe", "unfollow", "unstar", "unwatch", "unpin", "dismiss", "resolve", "reopen",
  "increment", "decrement", "unban", "kick", "notify", "exec", "eval", "spawn", "launch", "kill", "terminate",
  "shutdown", "reboot", "reload", "rerun", "retry", "rebase", "squash", "unblock", "convert", "generate", "train", "compile",
  // Added after the first review: spending, claiming and provisioning verbs.
  "buy", "purchase", "provision", "deprovision", "init", "initialize", "ack", "acknowledge", "fix", "reserve", "refund",
  "withdraw", "deposit", "authorize", "enroll", "checkout", "upgrade", "downgrade", "resize", "rebook",
]);
/**
 * Verbs that are nouns too (`get_commit`, `get_release_notes`): a write anywhere but as the thing right after the
 * leading read verb, so `get_commit` reads and `get_and_push` or `fetch_file_and_commit` writes.
 */
const WRITE_NOUNS = new Set([
  "push", "commit", "sync", "fork", "release", "tag", "label", "comment", "review", "build", "link", "backup", "grant",
  "block", "follow", "react", "vote", "refresh", "dispatch", "transition", "render", "ban",
  "book", "order", "pay", "charge", "claim", "scale", "store", "cache", "sign", "like",
]);
const DESTRUCTIVE_WORDS = new Set(["delete", "remove", "purge", "drop", "destroy", "erase", "archive", "wipe", "revoke"]);

/** "todo__HassListAddItem" → ["list", "add", "item"]; "get_open_items" → ["get", "open", "items"]. */
export function toolWords(toolName: string): string[] {
  const afterDomain = toolName.includes("__") ? toolName.slice(toolName.lastIndexOf("__") + 2) : toolName;
  const words = afterDomain
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  return words[0] === "hass" ? words.slice(1) : words;
}

/** Class of an MCP tool by its MCP-level name (without the `<server>-` prefix). Unknown shapes fail closed as writes. */
export function classifyTool(toolName: string): ToolClass {
  const hasInvisible = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\ufffd]/u.test(toolName);
  const stripped = toolName.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\ufffd]/gu, "");
  const name = stripped.toLowerCase();
  if (!hasInvisible && name === "api_get") return "read";
  if (name === "api_post" || name === "api_patch" || name === "api_delete" || name === "api_put") return "unrestricted";
  const words = toolWords(stripped);
  if (words.some((w) => DESTRUCTIVE_WORDS.has(w))) return "destructive";
  // A tool name with control, format or replacement characters never passes as a read.
  if (hasInvisible) return "write";
  if (words.some((w, i) => WRITE_WORDS.has(w) || (WRITE_NOUNS.has(w) && i !== 1))) return "write";
  if (READ_NAMES.has(words.join(" "))) return "read";
  // A second action ARIA can't tell (`and`, `or`, `then` after the read verb), or a read verb that's part of another
  // verb (`check in`): a write, failing closed.
  if (words.slice(1).some((w) => JOINS.has(w)) || VERB_PAIRS.has(words.slice(0, 2).join(" "))) return "write";
  if (words.length > 0 && READ_VERBS.has(words[0]!)) return "read";
  return "write";
}

export const serverWirePrefix = (serverName: string) => `${serverName.replace(/\s+/g, "-")}-`;

export interface ToolEntry {
  /** Runtime wire name, e.g. "Work-IQ-Mail-SearchMessages" or "view". */
  name: string;
  /** For an MCP tool, its server and its own name, when the runtime says (`mcpServerName`, `mcpToolName`). */
  server?: string;
  tool?: string;
  /** What the server says it does: untrusted text. */
  description?: string;
  /** What arguments the server says the tool takes (JSON Schema): untrusted text inside. */
  inputSchema?: Record<string, unknown>;
}

export interface ServerEntry {
  name: string;
  status: string;
  /** Kept in memory only: a server's address can carry a key in its query. */
  url?: string;
  source?: string;
  sourcePlugin?: string;
  displayName?: string;
  error?: string;
  /** The owned installation it came from (signing in to it goes through `prepareLogin`). */
  installationId?: string;
}

export interface McpToolRef {
  wireName: string;
  server: string;
  tool: string;
  cls: ToolClass;
}

/** Splits MCP wire names into server + tool using the known server names (longest prefix wins). */
export function resolveMcpTools(tools: ToolEntry[], servers: ServerEntry[]): McpToolRef[] {
  const prefixes = servers.map((s) => ({ server: s.name, prefix: serverWirePrefix(s.name) })).sort((a, b) => b.prefix.length - a.prefix.length);
  const refs: McpToolRef[] = [];
  for (const t of tools) {
    // The runtime's own split when it gives one for a server it lists, else the longest server prefix.
    const named = t.server !== undefined && t.tool !== undefined && servers.some((s) => s.name === t.server) && t.name === `${serverWirePrefix(t.server)}${t.tool}`;
    const hit = named ? { server: t.server!, prefix: serverWirePrefix(t.server!) } : prefixes.find((p) => t.name.startsWith(p.prefix));
    if (!hit) continue;
    const tool = t.name.slice(hit.prefix.length);
    refs.push({ wireName: t.name, server: hit.server, tool, cls: classifyTool(tool) });
  }
  return refs;
}

/** Built-in tools the Conductor may use: read-only file access and skills. No shell, no writes, no web, no sub-agents. */
export const CONDUCTOR_BUILTINS = ["view", "glob", "grep", "skill"] as const;

export interface ConductorScope {
  availableTools: string[];
  disabledMcpServers: string[];
  /** Wire names of the MCP tools the Conductor may call (all read-class). */
  readTools: string[];
  /** Servers left out because another server has the same URL. */
  duplicates: string[];
}

/**
 * The Conductor's scope: read-only built-ins, ARIA's own tools, and the read-class tools of every connected MCP
 * server. Servers with the same URL as another one (a CLI config can list a server twice) are dropped in favor of the one
 * exposing the most tools; servers with no read tools are disabled for the session.
 */
export function conductorScope(tools: ToolEntry[], servers: ServerEntry[]): ConductorScope {
  const refs = resolveMcpTools(tools, servers);
  const toolCount = new Map<string, number>();
  for (const r of refs) toolCount.set(r.server, (toolCount.get(r.server) ?? 0) + 1);

  const duplicates: string[] = [];
  const byUrl = new Map<string, string>();
  for (const s of [...servers].sort((a, b) => (toolCount.get(b.name) ?? 0) - (toolCount.get(a.name) ?? 0))) {
    if (!s.url) continue;
    const key = s.url.replace(/\/+$/, "").toLowerCase();
    if (byUrl.has(key)) duplicates.push(s.name);
    else byUrl.set(key, s.name);
  }

  const readTools = refs.filter((r) => r.cls === "read" && !duplicates.includes(r.server)).map((r) => r.wireName);
  const serversWithReads = new Set(refs.filter((r) => readTools.includes(r.wireName)).map((r) => r.server));
  const disabledMcpServers = servers.map((s) => s.name).filter((n) => !serversWithReads.has(n));

  return {
    availableTools: [...CONDUCTOR_BUILTINS.map((b) => `builtin:${b}`), "custom:*", ...readTools.map((t) => `mcp:${t}`)],
    disabledMcpServers,
    readTools,
    duplicates,
  };
}

/**
 * Built-in tools a worker may use in Phase 2: files, the shell (every command checked by the worker policy), its
 * session database, and sub-agents (pinned to the task's model). No web_fetch (network; asked for in Phase 3), no
 * skills or workflows. `availableTools` is an allowlist, so it also has to name the tools the runtime only adds for a
 * mode or a handler (Phase 2 probe): `task_complete` (autopilot), `ask_user` (with a question handler, D17) and
 * `exit_plan_mode` (plan mode; without it the worker ends its turn with the plan and never asks for a review, spike 12).
 */
export const WORKER_BUILTINS = [
  "view",
  "glob",
  "grep",
  "create",
  "edit",
  "powershell",
  "read_powershell",
  "stop_powershell",
  "list_powershell",
  "sql",
  "skill",
  "task",
  "read_agent",
  "list_agents",
  "write_agent",
  "task_complete",
  "ask_user",
  "exit_plan_mode",
] as const;

export interface WorkerScope {
  availableTools: string[];
  disabledMcpServers: string[];
  /** Wire names of the MCP tools a worker may call (read-class tools of GitHub servers). */
  readTools: string[];
}

/** Workers get GitHub read tools and nothing else from MCP: no task tracker, Work IQ or home automation (PLAN.md §4.13). */
export function workerScope(tools: ToolEntry[], servers: ServerEntry[]): WorkerScope {
  const refs = resolveMcpTools(tools, servers).filter((r) => r.cls === "read" && /github/i.test(r.server));
  const allowed = new Set(refs.map((r) => r.server));
  return {
    availableTools: [...WORKER_BUILTINS.map((b) => `builtin:${b}`), ...refs.map((r) => `mcp:${r.wireName}`)],
    disabledMcpServers: servers.map((s) => s.name).filter((n) => !allowed.has(n)),
    readTools: refs.map((r) => r.wireName),
  };
}
