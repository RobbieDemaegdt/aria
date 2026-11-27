/**
 * Customize › Integrations (PLAN.md §4.13, D22, D30–D34): what ARIA knows of the MCP servers in your Copilot CLI
 * setup and their tools (the catalog), your rule per tool and scope, and the scopes ARIA's and tasks' sessions get
 * from them. Plain code, no model.
 *
 * - The defaults are what the first draft did, so nothing changes until you change a rule: ARIA gets read tools
 *   (not those of a server that has the same address as a bigger one, D33 for new servers); its write and destructive
 *   tools are Ask (an action card from Phase 5, so Never until then) and unrestricted ones Never. Tasks get GitHub's
 *   read tools and nothing else (D32: the others are off until you turn them on).
 * - A rule can only make a tool stricter than its class allows (D34): a tool that changes something is Ask or Never,
 *   for ARIA (D22) and for tasks (D30); a GitHub tool that merges or writes branches, refs, files, commits, trees,
 *   blobs or tags is always Never for tasks (D31).
 * - A stored rule that isn't valid (an unknown effect, one its class doesn't allow) counts as Never, never as Auto.
 *
 * Everything a server says (names, descriptions, errors) is untrusted text: kept short, without control or invisible
 * characters. A server's address isn't kept at all (it can carry a key): only a hash of its host and path, to tell two
 * entries for the same server apart.
 */
import { createHash } from "node:crypto";
import type {
  DiscoveredAgentItem,
  DiscoveredSkillItem,
  InstalledPluginItem,
  IntegrationScope,
  MarketplaceItem,
  ToolClass,
  ToolRuleEffect,
} from "@aria/protocol";
import { z } from "zod";
import type { McpConfigState, StoredMcpServerConfig } from "./config.ts";
import { CONDUCTOR_BUILTINS, classifyTool, resolveMcpTools, serverWirePrefix, toolWords, WORKER_BUILTINS, type ServerEntry, type ToolEntry } from "./scope.ts";

export const MAX_SERVERS = 100;
export const MAX_TOOLS = 2_000;
export const MAX_RULES = 2_000;
export const MAX_SCHEMA_CHARS = 8_000;
const NAME_MAX = 200;
const WIRE_MAX = 400;
const TEXT_MAX = 300;
const SCHEMA_DESC_MAX = 200;
const SCHEMA_MAX_DEPTH = 6;
const REPLACEMENT = String.fromCharCode(0xfffd);

export interface CatalogServer {
  name: string;
  displayName?: string;
  status: string;
  source?: string;
  sourcePlugin?: string;
  installationId?: string;
  /** A hash of its address's host and path: two entries for the same server have the same one. */
  urlKey?: string;
  /** One of GitHub's servers: by its name, or its address's host (noted when it's checked, before the address is hashed). */
  github?: boolean;
  error?: string;
  firstSeen: number;
  lastSeen: number;
}

export interface CatalogTool {
  server: string;
  tool: string;
  wireName: string;
  description?: string;
  /** Cleaned, pruned JSON Schema for the tool's parameters (Phase 5A: shown by `list_action_tools`). */
  inputSchema?: Record<string, unknown>;
  firstSeen: number;
  lastSeen: number;
}

export interface Catalog {
  /** When the last check of your setup ran: what it listed has `lastSeen` equal to it. */
  checkedAt?: number;
  servers: CatalogServer[];
  tools: CatalogTool[];
  marketplaces?: MarketplaceItem[];
  plugins?: InstalledPluginItem[];
  agents?: DiscoveredAgentItem[];
  skills?: DiscoveredSkillItem[];
}

export interface StoredRule {
  server: string;
  wireName: string;
  scope: IntegrationScope;
  effect: ToolRuleEffect;
}

export const EMPTY_CATALOG: Catalog = { servers: [], tools: [] };

/** Text from an MCP server as ARIA keeps it: control and invisible characters replaced, cut. */
export function untrusted(text: string, max = TEXT_MAX): string {
  const clean = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, REPLACEMENT).trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Cleans and prunes an MCP tool's JSON Schema so untrusted server metadata cannot smuggle instructions or blow up the
 * catalog: keeps only structural keys (`type`, `description`, `properties`, `required`, `items`, `enum`,
 * `additionalProperties`), cleans every string with `untrusted()`, and caps total serialized size at MAX_SCHEMA_CHARS.
 */
export function sanitizeInputSchema(raw: unknown): Record<string, unknown> | undefined {
  const cleanNode = (node: unknown, depth: number): Record<string, unknown> | undefined => {
    if (!node || typeof node !== "object" || Array.isArray(node) || depth > SCHEMA_MAX_DEPTH) return undefined;
    const src = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (typeof src.type === "string") out.type = untrusted(src.type, 40);
    else if (Array.isArray(src.type) && src.type.every((t) => typeof t === "string")) out.type = src.type.slice(0, 6).map((t) => untrusted(t, 40));
    if (typeof src.description === "string" && src.description.trim()) out.description = untrusted(src.description, SCHEMA_DESC_MAX);
    if (typeof src.additionalProperties === "boolean") out.additionalProperties = src.additionalProperties;
    if (Array.isArray(src.required) && src.required.every((r) => typeof r === "string")) {
      out.required = src.required.slice(0, 60).map((r) => untrusted(r, 80));
    }
    if (Array.isArray(src.enum) && src.enum.length <= 50 && src.enum.every((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null)) {
      out.enum = src.enum.map((v) => (typeof v === "string" ? untrusted(v, 80) : v));
    }
    if (src.properties && typeof src.properties === "object" && !Array.isArray(src.properties)) {
      const props: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(src.properties as Record<string, unknown>).slice(0, 60)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        const cleaned = cleanNode(val, depth + 1);
        if (cleaned) props[untrusted(key, 80)] = cleaned;
      }
      out.properties = props;
    }
    if (src.items && typeof src.items === "object" && !Array.isArray(src.items)) {
      const cleaned = cleanNode(src.items, depth + 1);
      if (cleaned) out.items = cleaned;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };
  const cleaned = cleanNode(raw, 0);
  if (!cleaned) return undefined;
  try {
    const text = JSON.stringify(cleaned);
    return text.length <= MAX_SCHEMA_CHARS ? cleaned : undefined;
  } catch {
    return undefined;
  }
}

/** A hash of an address's host and path (its query and any key in it left out), for the duplicate check. */
export function urlKey(url: string): string {
  let basis = url;
  try {
    const parsed = new URL(url);
    basis = `${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    // Not an address: its hash still tells two equal ones apart, and nothing of it is kept.
  }
  return createHash("sha256").update(basis.toLowerCase()).digest("hex").slice(0, 32);
}

// ── stored data, checked (a settings row is only JSON) ──────────────────────────────────────────────────────────

const ServerSchema = z.object({
  name: z.string().max(NAME_MAX),
  displayName: z.string().max(NAME_MAX).optional(),
  status: z.string().max(40),
  source: z.string().max(40).optional(),
  sourcePlugin: z.string().max(NAME_MAX).optional(),
  installationId: z.string().max(NAME_MAX).optional(),
  urlKey: z.string().max(64).optional(),
  github: z.boolean().optional(),
  error: z.string().max(TEXT_MAX).optional(),
  firstSeen: z.number(),
  lastSeen: z.number(),
});
const ToolSchema = z.object({
  server: z.string().max(NAME_MAX),
  tool: z.string().max(NAME_MAX),
  wireName: z.string().max(WIRE_MAX),
  description: z.string().max(TEXT_MAX).optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  firstSeen: z.number(),
  lastSeen: z.number(),
});
const MarketplaceSchema = z.object({
  name: z.string().max(NAME_MAX),
  source: z.string().max(TEXT_MAX),
  isDefault: z.boolean().optional(),
  managed: z.boolean().optional(),
  available: z.boolean().optional(),
});
const PluginSchema = z.object({
  name: z.string().max(NAME_MAX),
  marketplace: z.string().max(NAME_MAX),
  version: z.string().max(80).optional(),
  enabled: z.boolean(),
  directSourceId: z.string().max(NAME_MAX).optional(),
  installedFrom: z.string().max(WIRE_MAX).optional(),
  source: z.string().max(80).optional(),
  managed: z.boolean().optional(),
  installed: z.boolean().optional(),
});
const AgentSchema = z.object({
  id: z.string().max(NAME_MAX),
  name: z.string().max(NAME_MAX),
  displayName: z.string().max(NAME_MAX),
  description: z.string().max(WIRE_MAX),
  source: z.string().max(80).optional(),
  userInvocable: z.boolean().optional(),
  disableModelInvocation: z.boolean().optional(),
  tools: z.array(z.string().max(NAME_MAX)).max(200).optional(),
  skills: z.array(z.string().max(NAME_MAX)).max(200).optional(),
  model: z.string().max(NAME_MAX).optional(),
  reasoningEffort: z.string().max(40).optional(),
  path: z.string().max(WIRE_MAX).optional(),
});
const SkillSchema = z.object({
  name: z.string().max(NAME_MAX),
  commandName: z.string().max(NAME_MAX).optional(),
  description: z.string().max(WIRE_MAX),
  source: z.string().max(80),
  pluginName: z.string().max(NAME_MAX).optional(),
  userInvocable: z.boolean(),
  enabled: z.boolean(),
  argumentHint: z.string().max(NAME_MAX).optional(),
  path: z.string().max(WIRE_MAX).optional(),
});
const CatalogSchema = z.object({
  checkedAt: z.number().optional(),
  servers: z.array(ServerSchema).max(MAX_SERVERS),
  tools: z.array(ToolSchema).max(MAX_TOOLS),
  marketplaces: z.array(MarketplaceSchema).max(100).optional(),
  plugins: z.array(PluginSchema).max(200).optional(),
  agents: z.array(AgentSchema).max(500).optional(),
  skills: z.array(SkillSchema).max(500).optional(),
});
const RuleKeySchema = z.object({ server: z.string().min(1).max(NAME_MAX), wireName: z.string().min(1).max(WIRE_MAX), scope: z.enum(["aria", "tasks"]) });
const EFFECTS: readonly ToolRuleEffect[] = ["auto", "ask", "never"];

/** The stored catalog, or an empty one when it doesn't check out. */
export function loadCatalog(raw: unknown): Catalog {
  const parsed = CatalogSchema.safeParse(raw);
  if (!parsed.success) return { servers: [], tools: [] };
  return {
    ...parsed.data,
    tools: parsed.data.tools.map((t) => {
      const schema = t.inputSchema ? sanitizeInputSchema(t.inputSchema) : undefined;
      const { inputSchema: _rawSchema, ...rest } = t;
      return schema ? { ...rest, inputSchema: schema } : rest;
    }),
  };
}

/** The stored rules: one that names a tool and scope but has an effect ARIA doesn't know counts as Never. */
export function loadRules(raw: unknown): StoredRule[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((item: unknown): StoredRule[] => {
      const key = RuleKeySchema.safeParse(item);
      if (!key.success) return [];
      const effect = (item as { effect?: unknown }).effect;
      return [{ ...key.data, effect: EFFECTS.includes(effect as ToolRuleEffect) ? (effect as ToolRuleEffect) : "never" }];
    })
    .slice(0, MAX_RULES);
}

// ── the catalog ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The catalog after a check of your setup: what it listed is seen now; what it didn't is kept with when it was last
 * seen (a server that needs signing in lists no tools, so its tools from before stay). Bounded: the tools of the
 * latest check first, then the most recently seen of the others.
 */
export function mergeCatalog(
  previous: Catalog,
  inventory: {
    tools: ToolEntry[];
    servers: ServerEntry[];
    marketplaces?: MarketplaceItem[];
    plugins?: InstalledPluginItem[];
    agents?: DiscoveredAgentItem[];
    skills?: DiscoveredSkillItem[];
  },
  now: number,
): Catalog {
  const oldServers = new Map(previous.servers.map((s) => [s.name, s]));
  const listed = inventory.servers.slice(0, MAX_SERVERS).map((s): CatalogServer => {
    const name = untrusted(s.name, NAME_MAX);
    const before = oldServers.get(name);
    // GitHub's once seen stays GitHub's (the flag only goes from false to true): a check that lists the server
    // without its address doesn't drop it.
    const github = before?.github === true || isGithubName(s.name) || (s.url !== undefined && githubAddress(s.url));
    return {
      name,
      ...(s.displayName ? { displayName: untrusted(s.displayName, NAME_MAX) } : {}),
      status: untrusted(s.status, 40),
      ...(s.source ? { source: untrusted(s.source, 40) } : {}),
      ...(s.sourcePlugin ? { sourcePlugin: untrusted(s.sourcePlugin, NAME_MAX) } : {}),
      ...(s.installationId ? { installationId: s.installationId.slice(0, NAME_MAX) } : {}),
      ...(s.url ? { urlKey: urlKey(s.url) } : {}),
      ...(github ? { github: true } : {}),
      ...(s.error ? { error: untrusted(s.error) } : {}),
      firstSeen: before?.firstSeen ?? now,
      lastSeen: now,
    };
  });
  const names = new Set(listed.map((s) => s.name));
  const servers = [...listed, ...previous.servers.filter((s) => !names.has(s.name)).sort((a, b) => b.lastSeen - a.lastSeen)].slice(0, MAX_SERVERS);

  const oldTools = new Map(previous.tools.map((t) => [`${t.server}\n${t.wireName}`, t]));
  const byWire = new Map(inventory.tools.map((t) => [t.name, t]));
  const seen = resolveMcpTools(inventory.tools, inventory.servers).map((ref): CatalogTool => {
    const item = byWire.get(ref.wireName);
    const description = item?.description;
    const before = oldTools.get(`${ref.server}\n${ref.wireName}`);
    const schema = item?.inputSchema ? sanitizeInputSchema(item.inputSchema) : before?.inputSchema;
    return {
      server: ref.server,
      tool: ref.tool,
      wireName: ref.wireName,
      ...(description ? { description: untrusted(description) } : before?.description ? { description: before.description } : {}),
      ...(schema ? { inputSchema: schema } : {}),
      firstSeen: before?.firstSeen ?? now,
      lastSeen: now,
    };
  });
  const keys = new Set(seen.map((t) => `${t.server}\n${t.wireName}`));
  const kept = new Set(servers.map((s) => s.name));
  const unseen = previous.tools.filter((t) => !keys.has(`${t.server}\n${t.wireName}`) && kept.has(t.server)).sort((a, b) => b.lastSeen - a.lastSeen);
  const marketplaces = inventory.marketplaces ?? previous.marketplaces;
  const plugins = inventory.plugins ?? previous.plugins;
  const agents = inventory.agents ?? previous.agents;
  const skills = inventory.skills ?? previous.skills;
  return {
    checkedAt: now,
    servers,
    tools: [...seen, ...unseen].slice(0, MAX_TOOLS),
    ...(marketplaces ? { marketplaces: marketplaces.slice(0, 100) } : {}),
    ...(plugins ? { plugins: plugins.slice(0, 200) } : {}),
    ...(agents ? { agents: agents.slice(0, 500) } : {}),
    ...(skills ? { skills: skills.slice(0, 500) } : {}),
  };
}

/**
 * Incorporates servers configured in ARIA's own `McpConfigState` into the catalog so newly added or imported servers
 * appear immediately in Customize › Integrations and keep their discovered tools across refreshes.
 */
export function mergeMcpConfigIntoCatalog(previous: Catalog, mcpConfig: McpConfigState, now: number): Catalog {
  if (mcpConfig.servers.length === 0) return previous;
  const effectiveSeenAt = previous.checkedAt ?? now;
  const byName = new Map(previous.servers.map((s) => [s.name, s]));
  const nextServers = [...previous.servers];

  for (const cfg of mcpConfig.servers) {
    const existing = byName.get(cfg.name);
    const github = existing?.github === true || cfg.github === true || isGithubName(cfg.name);
    const status = !cfg.enabled
      ? "disabled"
      : existing?.status && existing.status !== "disabled"
        ? existing.status
        : "connected";
    const source =
      cfg.source === "aria"
        ? "aria"
        : cfg.sourcePlugin
          ? "plugin"
          : existing?.source ?? "user";
    const merged: CatalogServer = {
      name: cfg.name,
      ...(cfg.displayName ? { displayName: untrusted(cfg.displayName, NAME_MAX) } : existing?.displayName ? { displayName: existing.displayName } : {}),
      status,
      source,
      ...(cfg.sourcePlugin ? { sourcePlugin: untrusted(cfg.sourcePlugin, NAME_MAX) } : existing?.sourcePlugin ? { sourcePlugin: existing.sourcePlugin } : {}),
      ...(existing?.installationId ? { installationId: existing.installationId } : {}),
      ...(cfg.urlKey ? { urlKey: cfg.urlKey } : existing?.urlKey ? { urlKey: existing.urlKey } : {}),
      ...(github ? { github: true } : {}),
      ...(existing?.error && status === "failed" ? { error: existing.error } : {}),
      firstSeen: existing?.firstSeen ?? effectiveSeenAt,
      lastSeen: effectiveSeenAt,
    };
    if (existing) {
      const idx = nextServers.findIndex((s) => s.name === cfg.name);
      if (idx >= 0) nextServers[idx] = merged;
    } else if (nextServers.length < MAX_SERVERS) {
      nextServers.push(merged);
      byName.set(cfg.name, merged);
    }
  }

  const configuredNames = new Set(mcpConfig.servers.map((s) => s.name));
  const nextTools = previous.tools.map((t) =>
    configuredNames.has(t.server) && t.lastSeen < effectiveSeenAt ? { ...t, lastSeen: effectiveSeenAt } : t,
  );

  return {
    ...previous,
    checkedAt: effectiveSeenAt,
    servers: nextServers.slice(0, MAX_SERVERS),
    tools: nextTools.slice(0, MAX_TOOLS),
  };
}

/**
 * Updates `catalog` with the live result of `NativeMcpClient.testServer(serverName)`: marks the server connected (or
 * needs-auth / failed) and merges any discovered tool definitions and sanitized `inputSchema`s.
 */
export function mergeServerProbeIntoCatalog(
  previous: Catalog,
  serverName: string,
  probe: {
    ok: boolean;
    tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    needsAuth?: boolean;
    error?: string;
  },
  now: number,
  serverConfig?: StoredMcpServerConfig,
): Catalog {
  const effectiveSeenAt = Math.max(previous.checkedAt ?? 0, now);
  const existingServer = previous.servers.find((s) => s.name === serverName);
  const github = existingServer?.github === true || serverConfig?.github === true || isGithubName(serverName);
  const status = probe.ok ? "connected" : probe.needsAuth ? "needs-auth" : "failed";
  const source =
    serverConfig?.source === "aria"
      ? "aria"
      : serverConfig?.sourcePlugin
        ? "plugin"
        : existingServer?.source ?? "user";

  const updatedServer: CatalogServer = {
    name: serverName,
    ...(serverConfig?.displayName
      ? { displayName: untrusted(serverConfig.displayName, NAME_MAX) }
      : existingServer?.displayName
        ? { displayName: existingServer.displayName }
        : {}),
    status,
    source,
    ...(serverConfig?.sourcePlugin
      ? { sourcePlugin: untrusted(serverConfig.sourcePlugin, NAME_MAX) }
      : existingServer?.sourcePlugin
        ? { sourcePlugin: existingServer.sourcePlugin }
        : {}),
    ...(existingServer?.installationId ? { installationId: existingServer.installationId } : {}),
    ...(serverConfig?.urlKey ? { urlKey: serverConfig.urlKey } : existingServer?.urlKey ? { urlKey: existingServer.urlKey } : {}),
    ...(github ? { github: true } : {}),
    ...(!probe.ok && probe.error ? { error: untrusted(probe.error) } : {}),
    firstSeen: existingServer?.firstSeen ?? effectiveSeenAt,
    lastSeen: effectiveSeenAt,
  };

  const nextServers = existingServer
    ? previous.servers.map((s) => (s.name === serverName ? updatedServer : isSeen(previous, s) ? { ...s, lastSeen: effectiveSeenAt } : s))
    : [updatedServer, ...previous.servers.map((s) => (isSeen(previous, s) ? { ...s, lastSeen: effectiveSeenAt } : s))].slice(0, MAX_SERVERS);

  if (!probe.ok) {
    const refreshedTools = previous.tools.map((t) => (isSeen(previous, t) ? { ...t, lastSeen: effectiveSeenAt } : t));
    return {
      ...previous,
      checkedAt: effectiveSeenAt,
      servers: nextServers,
      tools: refreshedTools,
    };
  }

  const prefix = serverWirePrefix(serverName);
  const oldToolsByWire = new Map(previous.tools.filter((t) => t.server === serverName).map((t) => [t.wireName, t]));
  const allowedTools =
    serverConfig?.tools !== undefined && !serverConfig.tools.includes("*")
      ? new Set(serverConfig.tools)
      : undefined;
  const filteredTools = allowedTools
    ? probe.tools.filter((t) => allowedTools.has(t.name))
    : probe.tools;
  const probedTools: CatalogTool[] = filteredTools.slice(0, MAX_TOOLS).map((t) => {
    const cleanToolName = untrusted(t.name, NAME_MAX);
    const wireName = `${prefix}${cleanToolName}`.slice(0, WIRE_MAX);
    const before = oldToolsByWire.get(wireName);
    const schema = t.inputSchema ? sanitizeInputSchema(t.inputSchema) : before?.inputSchema;
    return {
      server: serverName,
      tool: cleanToolName,
      wireName,
      ...(t.description ? { description: untrusted(t.description) } : before?.description ? { description: before.description } : {}),
      ...(schema ? { inputSchema: schema } : {}),
      firstSeen: before?.firstSeen ?? effectiveSeenAt,
      lastSeen: effectiveSeenAt,
    };
  });

  const otherServerTools = previous.tools
    .filter((t) => t.server !== serverName)
    .map((t) => (isSeen(previous, t) ? { ...t, lastSeen: effectiveSeenAt } : t));

  return {
    ...previous,
    checkedAt: effectiveSeenAt,
    servers: nextServers,
    tools: [...probedTools, ...otherServerTools].slice(0, MAX_TOOLS),
  };
}

export const isSeen = (catalog: Catalog, item: { lastSeen: number }) => catalog.checkedAt !== undefined && item.lastSeen >= catalog.checkedAt;

/** Servers with the same address as a server with more tools (a CLI config can list a server twice): which one ARIA uses instead. */
export function duplicates(catalog: Catalog): Map<string, string> {
  const count = new Map<string, number>();
  for (const tool of catalog.tools) if (isSeen(catalog, tool)) count.set(tool.server, (count.get(tool.server) ?? 0) + 1);
  const byKey = new Map<string, string>();
  const result = new Map<string, string>();
  for (const server of catalog.servers.filter((s) => isSeen(catalog, s)).sort((a, b) => (count.get(b.name) ?? 0) - (count.get(a.name) ?? 0))) {
    if (!server.urlKey) continue;
    const first = byKey.get(server.urlKey);
    if (first) result.set(server.name, first);
    else byKey.set(server.urlKey, server.name);
  }
  return result;
}

// ── rules ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A server named for GitHub (the runtime's built-in one is `github-mcp-server`). */
export const isGithubName = (server: string) => /github/i.test(server);
/** GitHub's own MCP hosts: the hosted server (api.githubcopilot.com), github.com, GitHub Enterprise Cloud (*.ghe.com). */
const GITHUB_HOSTS = /(?:^|\.)(?:github\.com|githubcopilot\.com|ghe\.com)$/i;
/** Whether a server's address is one of GitHub's, whatever the server is called in your setup. */
export function githubAddress(url: string): boolean {
  try {
    return GITHUB_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** What a GitHub tool must never do for a task (D31): merge, push, or write branches, refs, files, commits, trees, blobs or tags. */
const GITHUB_REFS = new Set([
  "merge", "merged", "push", "branch", "branches", "ref", "refs", "commit", "commits", "file", "files", "tree", "trees", "blob", "blobs",
  "tag", "tags", "contents", "content", "fork", "repository", "repositories", "repo", "repos", "release", "releases",
  "rebase", "squash", "revert", "cherry", "pick", "secret", "secrets", "deployment", "deployments", "environment",
  // Handing work to GitHub's coding agent, which pushes a branch of its own (assign_copilot_to_issue, …_with_copilot).
  "copilot", "agent", "agents", "delegate",
]);
/** GitHub writes ARIA can place outside D31 (issues, comments, reviews, pull requests' details, notifications, gists, workflow runs/dispatches). */
const GITHUB_PLACED = new Set([
  "issue", "issues", "comment", "comments", "review", "reviews", "reviewer", "reviewers", "pull", "request", "notification",
  "notifications", "subscription", "label", "labels", "gist", "gists", "discussion", "discussions", "assignee", "assignees",
  "milestone", "reaction", "reactions", "workflow", "workflows", "actions",
]);

/**
 * D31, failing closed: a GitHub tool that changes something is always Never for tasks when its name has any word for
 * merging, pushing or writing branches, refs, files, commits, trees, blobs or tags, and also when it has none of the
 * words ARIA can place (so an unknown GitHub write is refused rather than allowed).
 */
export function githubFixed(tool: string, cls: ToolClass, github: boolean): boolean {
  if (!github || cls === "read") return false;
  const words = toolWords(tool);
  if (words.some((w) => GITHUB_REFS.has(w))) return true;
  return !words.some((w) => GITHUB_PLACED.has(w));
}

/** What you may pick for a tool in a scope (D22, D30, D31, D34). */
export function allowedRules(scope: IntegrationScope, cls: ToolClass, fixed: boolean): ToolRuleEffect[] {
  if (scope === "tasks" && fixed) return ["never"];
  return cls === "read" ? ["auto", "ask", "never"] : ["ask", "never"];
}

/** The first draft's rule for a tool (D33: a new server's read tools reach ARIA; tasks get GitHub reads only). */
export function defaultRule(scope: IntegrationScope, cls: ToolClass, github: boolean, duplicate: boolean, fixed: boolean): ToolRuleEffect {
  if (scope === "aria") {
    if (cls === "read") return duplicate ? "never" : "auto";
    return cls === "unrestricted" ? "never" : "ask";
  }
  return cls === "read" && github && !fixed ? "auto" : "never";
}

/** Why a scope doesn't offer every rule for a tool, or what its Ask means. */
export function ruleNote(scope: IntegrationScope, cls: ToolClass, fixed: boolean): string | undefined {
  if (scope === "tasks" && fixed) return "Always refused for tasks: it merges or writes branches, refs, files, commits or tags on GitHub, which tasks never do (ARIA's fixed rules).";
  if (scope === "aria") {
    if (cls !== "read") return "ARIA can't change things on its own: a tool like this needs an action card (Ask), and runs only after your click.";
    return "Ask needs an action card: ARIA proposes it in the chat instead of running it on its own.";
  }
  if (cls !== "read") return "A task can use a tool that changes things only after your approval, every time: Approve once or Reject.";
  return undefined;
}

export interface ToolRuleView {
  effect: ToolRuleEffect;
  isDefault: boolean;
  allowed: ToolRuleEffect[];
  note?: string;
}

export interface ToolView {
  entry: CatalogTool;
  cls: ToolClass;
  /** Its server is one of GitHub's. */
  github: boolean;
  fixed: boolean;
  seen: boolean;
  rules: Record<IntegrationScope, ToolRuleView>;
}

const ruleKey = (server: string, wireName: string, scope: IntegrationScope) => `${scope}\n${server}\n${wireName}`;

/** Each tool of the catalog with its class and its rule per scope: yours where it's allowed, else Never; the default without one. */
export function viewTools(catalog: Catalog, stored: readonly StoredRule[]): ToolView[] {
  const dupes = duplicates(catalog);
  const mine = new Map(stored.map((r) => [ruleKey(r.server, r.wireName, r.scope), r.effect]));
  const githubServers = new Set(catalog.servers.filter((s) => s.github).map((s) => s.name));
  return catalog.tools.map((entry) => {
    const cls = classifyTool(entry.tool);
    const github = githubServers.has(entry.server) || isGithubName(entry.server);
    const fixed = githubFixed(entry.tool, cls, github);
    const rule = (scope: IntegrationScope): ToolRuleView => {
      const allowed = allowedRules(scope, cls, fixed);
      const yours = mine.get(ruleKey(entry.server, entry.wireName, scope));
      const fallback = defaultRule(scope, cls, github, dupes.has(entry.server), fixed);
      const effect = yours === undefined ? (allowed.includes(fallback) ? fallback : "never") : allowed.includes(yours) ? yours : "never";
      const note = ruleNote(scope, cls, fixed);
      return { effect, isDefault: yours === undefined, allowed, ...(note ? { note } : {}) };
    };
    return { entry, cls, github, fixed, seen: isSeen(catalog, entry), rules: { aria: rule("aria"), tasks: rule("tasks") } };
  });
}

export interface McpRule {
  /** The MCP tool's own name, as the catalog has it. */
  tool: string;
  cls: ToolClass;
  effect: ToolRuleEffect;
  /** Its server is one of GitHub's (by name or address): the handler's D31 check takes it with the server's name. */
  github: boolean;
  fixed: boolean;
}

export interface SessionScope {
  availableTools: string[];
  disabledMcpServers: string[];
  /** Wire names of the tools that run on their own in it. */
  readTools: string[];
}

export interface Scopes {
  aria: SessionScope;
  tasks: SessionScope;
  /** The rule for a tool by its server and wire name (both have to match the catalog), for the permission handlers. */
  lookup(scope: IntegrationScope, server: string, wireName: string): McpRule | undefined;
}

/**
 * The sessions' scopes from the catalog and your rules: ARIA gets the read tools whose rule is Auto (Ask is an action
 * card, Phase 5); tasks get the ones that are Auto or Ask (Ask: the runtime has to ask ARIA's handler, which shows a
 * card), never a D31 tool. Only tools of the latest check, and a server none of whose tools is in goes into
 * `disabledMcpServers`.
 */
export function computeScopes(catalog: Catalog, stored: readonly StoredRule[], mcpConfig?: McpConfigState): Scopes {
  const views = viewTools(catalog, stored);
  const disabledInConfig = new Set(
    [
      ...(mcpConfig?.servers ?? []).filter((s) => !s.enabled).map((s) => s.name),
      ...catalog.servers.filter((s) => isSeen(catalog, s) && s.status === "disabled").map((s) => s.name),
    ],
  );
  const servers = [
    ...new Set([
      ...catalog.servers.filter((s) => isSeen(catalog, s)).map((s) => s.name),
      ...(mcpConfig?.servers ?? []).map((s) => s.name),
    ]),
  ];
  const scopeOf = (scope: IntegrationScope, builtins: string[]): SessionScope => {
    // An effect is one its class allows (viewTools): Auto only for a read tool, Never only for a D31 tool.
    const inScope = views.filter(
      (v) =>
        v.seen &&
        !disabledInConfig.has(v.entry.server) &&
        (scope === "aria" ? v.rules.aria.effect === "auto" : v.rules.tasks.effect !== "never"),
    );
    const auto = inScope.filter((v) => v.rules[scope].effect === "auto");
    const used = new Set(inScope.map((v) => v.entry.server));
    return {
      availableTools: [...builtins, ...inScope.map((v) => `mcp:${v.entry.wireName}`)],
      disabledMcpServers: servers.filter((name) => !used.has(name) || disabledInConfig.has(name)),
      readTools: auto.map((v) => v.entry.wireName),
    };
  };
  const index = new Map(views.map((v) => [`${v.entry.server}\n${v.entry.wireName}`, v]));
  return {
    aria: scopeOf("aria", [...CONDUCTOR_BUILTINS.map((b) => `builtin:${b}`), "custom:*"]),
    tasks: scopeOf("tasks", WORKER_BUILTINS.map((b) => `builtin:${b}`)),
    lookup(scope, server, wireName) {
      const view = index.get(`${server}\n${wireName}`);
      if (!view) return undefined;
      if (disabledInConfig.has(server)) {
        return { tool: view.entry.tool, cls: view.cls, effect: "never", github: view.github, fixed: view.fixed };
      }
      return { tool: view.entry.tool, cls: view.cls, effect: view.rules[scope].effect, github: view.github, fixed: view.fixed };
    },
  };
}

// ── changing rules ──────────────────────────────────────────────────────────────────────────────────────────────

/** Your rules with one set (or, `effect: null`, back to the default). The tool has to be in the catalog, the rule allowed for it. */
export function setRule(catalog: Catalog, stored: readonly StoredRule[], input: { server: string; wireName: string; scope: IntegrationScope; effect: ToolRuleEffect | null }): StoredRule[] {
  const rest = stored.filter((r) => ruleKey(r.server, r.wireName, r.scope) !== ruleKey(input.server, input.wireName, input.scope));
  if (input.effect === null) return rest;
  const view = viewTools(catalog, []).find((v) => v.entry.server === input.server && v.entry.wireName === input.wireName);
  if (!view) throw new Error("ARIA hasn't seen that tool in your setup.");
  const allowed = view.rules[input.scope].allowed;
  if (!allowed.includes(input.effect)) throw new Error(`${input.effect === "auto" ? "Auto" : input.effect} isn't possible for this tool: ${view.rules[input.scope].note ?? "its class doesn't allow it"}`);
  if (rest.length >= MAX_RULES) throw new Error(`You have ${MAX_RULES} rules, the most ARIA keeps: set some back to their default first.`);
  return [...rest, { server: input.server, wireName: input.wireName, scope: input.scope, effect: input.effect }];
}

/**
 * Your rules for a server that's gone (renamed in the CLI) moved to another server: a rule moves when the other server
 * has a tool of the same name, and replaces your rule there. Returns how many moved and how many stayed.
 */
export function moveRules(catalog: Catalog, stored: readonly StoredRule[], from: string, to: string): { rules: StoredRule[]; moved: number; left: number } {
  const target = catalog.servers.find((s) => s.name === to);
  if (!target || !isSeen(catalog, target)) throw new Error("Pick a server from your current setup.");
  if (from === to) throw new Error("Pick another server.");
  const toolOf = new Map(catalog.tools.filter((t) => t.server === from).map((t) => [t.wireName, t.tool]));
  const there = new Map(catalog.tools.filter((t) => t.server === to).map((t) => [t.tool, t.wireName]));
  let moved = 0;
  let left = 0;
  const result: StoredRule[] = stored.filter((r) => r.server !== from);
  for (const rule of stored.filter((r) => r.server === from)) {
    const tool = toolOf.get(rule.wireName) ?? (rule.wireName.startsWith(serverWirePrefix(from)) ? rule.wireName.slice(serverWirePrefix(from).length) : undefined);
    const wireName = tool !== undefined ? there.get(tool) : undefined;
    if (wireName === undefined) {
      result.push(rule);
      left++;
      continue;
    }
    const at = result.findIndex((r) => r.server === to && r.wireName === wireName && r.scope === rule.scope);
    if (at >= 0) result.splice(at, 1);
    result.push({ ...rule, server: to, wireName });
    moved++;
  }
  return { rules: result, moved, left };
}

/** Forgets a server that's gone: it, its tools and your rules for them. */
export function forgetServer(catalog: Catalog, stored: readonly StoredRule[], server: string): { catalog: Catalog; rules: StoredRule[] } {
  const entry = catalog.servers.find((s) => s.name === server);
  if (entry && isSeen(catalog, entry)) throw new Error("That server is in your setup: remove it in the Copilot CLI first.");
  return {
    catalog: { ...catalog, servers: catalog.servers.filter((s) => s.name !== server), tools: catalog.tools.filter((t) => t.server !== server) },
    rules: stored.filter((r) => r.server !== server),
  };
}

// ── signing in ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The sign-in page to open, from the runtime (the server's identity provider, whose host differs from the server's by
 * design): `https:` only, no user name or password in it. Its host is what the window shows (punycode, as `URL` gives
 * it); the address itself goes only to the browser.
 */
export function signInPage(raw: string): { url: string; host: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || !parsed.hostname) return undefined;
  return { url: parsed.toString(), host: parsed.hostname };
}
