/**
 * Phase 7A: ARIA's own MCP server configuration, Copilot CLI config parser/importer (`~/.copilot/mcp-config.json`),
 * OS keychain secret separation (`McpSecretStore`), and per-scope SDK `mcpServers` builder (PLAN.md §0.3 D8, D10, D16,
 * D19, D22, D30–D35; §0.4 #6; §4.13; §10 Phase 7A).
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IntegrationServer, McpServerTransport, SaveMcpServerInput } from "@aria/protocol";
import { z } from "zod";
import { checkJsonRawTokens, DISGUISE_CHARS } from "./actions.ts";
import { githubAddress, isGithubName, MAX_SERVERS, untrusted, urlKey } from "./rules.ts";
import { serverWirePrefix } from "./scope.ts";

export type { McpServerTransport };

export const MAX_PLUGIN_DIRS = 50;
const NAME_MAX = 200;
const CMD_MAX = 500;
const ARG_MAX = 1_000;
const MAX_ARGS = 50;
const ENV_KEY_MAX = 120;
const ENV_VAL_MAX = 2_000;
const URL_MAX = 2_000;
export const DEFAULT_MCP_TIMEOUT_MS = 30_000;
export const MIN_MCP_TIMEOUT_MS = 1_000;
export const MAX_MCP_TIMEOUT_MS = 300_000;

const SECRET_HEADER_RE = /authorization|token|key|secret|password|cookie|credential/i;
const SECRET_ENV_RE = /token|key|secret|password|credential|pat|auth/i;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export const isSecretHeaderName = (name: string): boolean => SECRET_HEADER_RE.test(name.trim());
export const isSecretEnvName = (name: string): boolean => SECRET_ENV_RE.test(name.trim());
export const isLoopbackHost = (hostname: string): boolean => LOOPBACK_HOSTS.has(hostname.trim().toLowerCase());

export interface StoredMcpServerConfig {
  name: string;
  displayName?: string;
  transport: McpServerTransport;
  /** Whether this server is enabled in ARIA (default true). When false, added to disabledMcpServers everywhere. */
  enabled: boolean;
  /** Where this server definition came from: imported from Copilot CLI or added/edited in ARIA. */
  source: "cli" | "aria";
  /** Optional plugin name when imported from a CLI plugin. */
  sourcePlugin?: string;
  /** Tool filter from config (`["*"]` or specific tool names; default `["*"]`). */
  tools?: string[];
  /** Timeout in ms for tool calls and test probes (default 30_000, range 1_000..300_000). */
  timeout?: number;

  // ── Stdio transport fields (`transport === "stdio"`) ──
  command?: string;
  args?: string[];
  cwd?: string;
  /** Non-secret environment variable keys/values. */
  env?: Record<string, string>;
  /** Keys of environment variables stored in the encrypted McpSecretStore. */
  secretEnvKeys?: string[];

  // ── HTTP / SSE transport fields (`transport === "http" | "sse"`) ──
  /**
   * Base URL without secret query parameters when secrets are split out.
   * Never sent across IPC to the renderer (preserving Phase 3 Part B's urlKey redaction rule).
   */
  url?: string;
  /** Hash of host + path (`urlKey(url)`), used for duplicate detection and safe identity checks. */
  urlKey?: string;
  /** True when the server's name or URL host matches GitHub (`isGithubName` / `githubAddress`). */
  github?: boolean;
  /** Non-secret HTTP headers. Secret headers live in McpSecretStore. */
  headers?: Record<string, string>;
  /** Names of HTTP headers stored in the encrypted McpSecretStore. */
  secretHeaderKeys?: string[];
  /** Optional OAuth client metadata from CLI config. */
  oauthClientId?: string;
  oauthScopes?: string[];
  oauthPublicClient?: boolean;

  importedAt?: number;
  updatedAt: number;
}

export interface McpConfigState {
  /** When true, ARIA re-imports ~/.copilot/mcp-config.json on startup and on Refresh. */
  keepInSync: boolean;
  /** Epoch ms when ARIA last imported from the Copilot CLI configuration. */
  lastImportedAt?: number;
  /** Ordered list of configured servers (max 100, matching MAX_SERVERS). */
  servers: StoredMcpServerConfig[];
  /** Explicit Open-Plugins directories to pass to sessions (max 50). */
  pluginDirectories: string[];
  /** Explicit skill discovery directories to pass to sessions (max 50). */
  skillDirectories?: string[];
  /** Explicit agent discovery directories to pass to sessions (max 50). */
  agentDirectories?: string[];
  /** Skills explicitly disabled in ARIA (max 500). */
  disabledSkills?: string[];
}

export const EMPTY_MCP_CONFIG: McpConfigState = {
  keepInSync: false,
  servers: [],
  pluginDirectories: [],
};

export interface McpServerSecrets {
  bearerToken?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  /** Full URL when the configured URL contained query parameters (so query keys are encrypted at rest). */
  fullUrl?: string;
}

export interface McpSecretStore {
  getServerSecrets(serverName: string): McpServerSecrets | undefined;
  setServerSecrets(serverName: string, secrets: McpServerSecrets | null): void;
  hasSecrets(serverName: string): boolean;
}

export function createMemoryMcpSecretStore(initial?: Record<string, McpServerSecrets>): McpSecretStore {
  const map = new Map<string, McpServerSecrets>();
  if (initial) {
    for (const [k, v] of Object.entries(initial)) {
      if (v && typeof v === "object") map.set(k, structuredClone(v));
    }
  }
  return {
    getServerSecrets(serverName: string): McpServerSecrets | undefined {
      const found = map.get(serverName);
      return found ? structuredClone(found) : undefined;
    },
    setServerSecrets(serverName: string, secrets: McpServerSecrets | null): void {
      if (!secrets || (!secrets.bearerToken && !secrets.fullUrl && !Object.keys(secrets.headers ?? {}).length && !Object.keys(secrets.env ?? {}).length)) {
        map.delete(serverName);
        return;
      }
      map.set(serverName, structuredClone(secrets));
    },
    hasSecrets(serverName: string): boolean {
      const s = map.get(serverName);
      if (!s) return false;
      return Boolean(
        s.bearerToken?.trim() ||
          (s.headers && Object.keys(s.headers).length > 0) ||
          (s.env && Object.keys(s.env).length > 0) ||
          (s.fullUrl && safeHasQueryParams(s.fullUrl)),
      );
    },
  };
}

function safeHasQueryParams(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).search !== "";
  } catch {
    return false;
  }
}

export interface RuntimeMcpStdioServerConfig {
  type?: "local" | "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  workingDirectory?: string;
  tools?: string[];
  timeout?: number;
}

export interface RuntimeMcpHttpServerConfig {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  tools?: string[];
  timeout?: number;
}

export type RuntimeMcpServerConfig = RuntimeMcpStdioServerConfig | RuntimeMcpHttpServerConfig;

// ── Zod validation for stored McpConfigState ──────────────────────────────────────────────────────────────────

const StoredServerSchema = z.object({
  name: z.string().min(1).max(NAME_MAX),
  displayName: z.string().max(NAME_MAX).optional(),
  transport: z.enum(["stdio", "http", "sse"]),
  enabled: z.boolean(),
  source: z.enum(["cli", "aria"]),
  sourcePlugin: z.string().max(NAME_MAX).optional(),
  tools: z.array(z.string().max(NAME_MAX)).max(500).optional(),
  timeout: z.number().int().min(MIN_MCP_TIMEOUT_MS).max(MAX_MCP_TIMEOUT_MS).optional(),
  command: z.string().max(CMD_MAX).optional(),
  args: z.array(z.string().max(ARG_MAX)).max(MAX_ARGS).optional(),
  cwd: z.string().max(ARG_MAX).optional(),
  env: z.record(z.string().max(ENV_KEY_MAX), z.string().max(ENV_VAL_MAX)).optional(),
  secretEnvKeys: z.array(z.string().max(ENV_KEY_MAX)).max(100).optional(),
  url: z.string().max(URL_MAX).optional(),
  urlKey: z.string().max(64).optional(),
  github: z.boolean().optional(),
  headers: z.record(z.string().max(ENV_KEY_MAX), z.string().max(ENV_VAL_MAX)).optional(),
  secretHeaderKeys: z.array(z.string().max(ENV_KEY_MAX)).max(100).optional(),
  oauthClientId: z.string().max(NAME_MAX).optional(),
  oauthScopes: z.array(z.string().max(NAME_MAX)).max(50).optional(),
  oauthPublicClient: z.boolean().optional(),
  importedAt: z.number().optional(),
  updatedAt: z.number(),
});

const McpConfigStateSchema = z.object({
  keepInSync: z.boolean(),
  lastImportedAt: z.number().optional(),
  servers: z.array(StoredServerSchema).max(MAX_SERVERS),
  pluginDirectories: z.array(z.string().min(1).max(ARG_MAX)).max(MAX_PLUGIN_DIRS),
  skillDirectories: z.array(z.string().min(1).max(ARG_MAX)).max(MAX_PLUGIN_DIRS).optional(),
  agentDirectories: z.array(z.string().min(1).max(ARG_MAX)).max(MAX_PLUGIN_DIRS).optional(),
  disabledSkills: z.array(z.string().min(1).max(NAME_MAX)).max(500).optional(),
});

export function loadMcpConfig(raw: unknown): McpConfigState {
  const parsed = McpConfigStateSchema.safeParse(raw);
  if (!parsed.success) {
    return { keepInSync: false, servers: [], pluginDirectories: [] };
  }
  const skillDirs = parsed.data.skillDirectories ? [...new Set(parsed.data.skillDirectories)] : [];
  const agentDirs = parsed.data.agentDirectories ? [...new Set(parsed.data.agentDirectories)] : [];
  const disabledSkills = parsed.data.disabledSkills ? [...new Set(parsed.data.disabledSkills)] : [];
  return {
    keepInSync: parsed.data.keepInSync,
    ...(parsed.data.lastImportedAt !== undefined ? { lastImportedAt: parsed.data.lastImportedAt } : {}),
    servers: parsed.data.servers.map((s) => ({ ...s })),
    pluginDirectories: [...new Set(parsed.data.pluginDirectories)],
    ...(skillDirs.length > 0 ? { skillDirectories: skillDirs } : {}),
    ...(agentDirs.length > 0 ? { agentDirectories: agentDirs } : {}),
    ...(disabledSkills.length > 0 ? { disabledSkills } : {}),
  };
}

/** Validates an HTTP/SSE MCP server URL: must be https://, or http:// only for loopback hosts, with no embedded credentials. */
export function validateMcpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error("Enter a valid server URL (https://… or http://127.0.0.1:…).");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("Server URLs cannot include embedded usernames or passwords.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Server URLs must use https:// (or http:// for local loopback servers).");
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error("Remote MCP servers must use https:// (http:// is only allowed for 127.0.0.1 or localhost).");
  }
  return parsed;
}

/** Validates a server name: non-empty, max 200 chars, no control or invisible characters. */
export function validateMcpServerName(rawName: string): string {
  const name = rawName.trim();
  if (!name || name.length > NAME_MAX) {
    throw new Error(`Server name must be between 1 and ${NAME_MAX} characters.`);
  }
  if (DISGUISE_CHARS.test(name) || /[\r\n\t\0]/.test(name)) {
    throw new Error("Server name cannot contain control or invisible characters.");
  }
  return name;
}

/** Splits secret headers, secret env vars, and query-bearing URLs out of a server definition into `McpServerSecrets`. */
export function splitServerSecrets(input: {
  name: string;
  displayName?: string;
  transport: McpServerTransport;
  enabled?: boolean;
  source: "cli" | "aria";
  sourcePlugin?: string;
  tools?: string[];
  timeout?: number;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  bearerToken?: string | null;
  oauthClientId?: string;
  oauthScopes?: string[];
  oauthPublicClient?: boolean;
  importedAt?: number;
  updatedAt?: number;
}): { config: StoredMcpServerConfig; secrets?: McpServerSecrets } {
  const now = input.updatedAt ?? Date.now();
  const name = validateMcpServerName(input.name);
  const enabled = input.enabled !== false;
  const timeout =
    input.timeout !== undefined
      ? Math.max(MIN_MCP_TIMEOUT_MS, Math.min(MAX_MCP_TIMEOUT_MS, Math.round(input.timeout)))
      : undefined;

  if (input.transport === "stdio") {
    const command = input.command?.trim() ?? "";
    if (!command || command.length > CMD_MAX || DISGUISE_CHARS.test(command) || command.includes("\0")) {
      throw new Error(`Stdio MCP server "${name}" requires a valid command.`);
    }
    const args = (input.args ?? []).slice(0, MAX_ARGS).map((a) => String(a).slice(0, ARG_MAX));
    const cwd = input.cwd?.trim() ? input.cwd.trim().slice(0, ARG_MAX) : undefined;
    const cleanEnv: Record<string, string> = {};
    const secretEnv: Record<string, string> = {};
    const secretEnvKeys: string[] = [];

    for (const [rawKey, rawVal] of Object.entries(input.env ?? {})) {
      const k = rawKey.trim();
      if (!k || k.length > ENV_KEY_MAX || DISGUISE_CHARS.test(k) || /[\r\n\0=]/.test(k)) continue;
      const v = String(rawVal ?? "").slice(0, ENV_VAL_MAX);
      if (isSecretEnvName(k)) {
        secretEnv[k] = v;
        secretEnvKeys.push(k);
      } else {
        cleanEnv[k] = v;
      }
    }

    const config: StoredMcpServerConfig = {
      name,
      ...(input.displayName?.trim() ? { displayName: untrusted(input.displayName.trim(), NAME_MAX) } : {}),
      transport: "stdio",
      enabled,
      source: input.source,
      ...(input.sourcePlugin?.trim() ? { sourcePlugin: untrusted(input.sourcePlugin.trim(), NAME_MAX) } : {}),
      ...(Array.isArray(input.tools) ? { tools: input.tools.slice(0, 500) } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(cwd ? { cwd } : {}),
      ...(Object.keys(cleanEnv).length > 0 ? { env: cleanEnv } : {}),
      ...(secretEnvKeys.length > 0 ? { secretEnvKeys } : {}),
      github: isGithubName(name),
      ...(input.importedAt !== undefined ? { importedAt: input.importedAt } : {}),
      updatedAt: now,
    };
    const secrets: McpServerSecrets | undefined =
      Object.keys(secretEnv).length > 0 ? { env: secretEnv } : undefined;
    return { config, ...(secrets ? { secrets } : {}) };
  }

  // HTTP / SSE transport
  if (!input.url?.trim()) {
    throw new Error(`${input.transport.toUpperCase()} MCP server "${name}" requires a URL.`);
  }
  const parsedUrl = validateMcpUrl(input.url);
  const hasQuery = parsedUrl.search !== "" || parsedUrl.hash !== "";
  const baseUrl = `${parsedUrl.origin}${parsedUrl.pathname}`;
  const fullUrl = hasQuery ? parsedUrl.toString() : undefined;
  const computedUrlKey = urlKey(parsedUrl.toString());
  const github = isGithubName(name) || githubAddress(parsedUrl.toString());

  const cleanHeaders: Record<string, string> = {};
  const secretHeaders: Record<string, string> = {};
  const secretHeaderKeys: string[] = [];

  for (const [rawKey, rawVal] of Object.entries(input.headers ?? {})) {
    const k = rawKey.trim();
    if (!k || k.length > ENV_KEY_MAX || DISGUISE_CHARS.test(k) || /[\r\n\0:]/.test(k)) continue;
    const v = String(rawVal ?? "").trim().slice(0, ENV_VAL_MAX);
    if (/[\r\n\0]/.test(v) || DISGUISE_CHARS.test(v)) {
      throw new Error(`Header "${k}" contains invalid control characters.`);
    }
    if (isSecretHeaderName(k)) {
      secretHeaders[k] = v;
      secretHeaderKeys.push(k);
    } else {
      cleanHeaders[k] = v;
    }
  }

  let bearerToken: string | undefined;
  if (input.bearerToken !== undefined && input.bearerToken !== null) {
    const trimmed = input.bearerToken.trim().replace(/^Bearer\s+/i, "").trim();
    if (trimmed) {
      if (/[\r\n\0]/.test(trimmed) || DISGUISE_CHARS.test(trimmed)) {
        throw new Error("Bearer token cannot contain control or invisible characters.");
      }
      bearerToken = trimmed;
    }
  }

  const config: StoredMcpServerConfig = {
    name,
    ...(input.displayName?.trim() ? { displayName: untrusted(input.displayName.trim(), NAME_MAX) } : {}),
    transport: input.transport,
    enabled,
    source: input.source,
    ...(input.sourcePlugin?.trim() ? { sourcePlugin: untrusted(input.sourcePlugin.trim(), NAME_MAX) } : {}),
    ...(Array.isArray(input.tools) ? { tools: input.tools.slice(0, 500) } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    url: baseUrl,
    urlKey: computedUrlKey,
    ...(github ? { github: true } : {}),
    ...(Object.keys(cleanHeaders).length > 0 ? { headers: cleanHeaders } : {}),
    ...(secretHeaderKeys.length > 0 ? { secretHeaderKeys } : {}),
    ...(input.oauthClientId ? { oauthClientId: input.oauthClientId.slice(0, NAME_MAX) } : {}),
    ...(input.oauthScopes?.length ? { oauthScopes: input.oauthScopes.slice(0, 50) } : {}),
    ...(input.oauthPublicClient !== undefined ? { oauthPublicClient: input.oauthPublicClient } : {}),
    ...(input.importedAt !== undefined ? { importedAt: input.importedAt } : {}),
    updatedAt: now,
  };

  const secrets: McpServerSecrets = {
    ...(bearerToken ? { bearerToken } : {}),
    ...(Object.keys(secretHeaders).length > 0 ? { headers: secretHeaders } : {}),
    ...(fullUrl ? { fullUrl } : {}),
  };
  const hasAnySecret = Boolean(secrets.bearerToken || secrets.headers || secrets.fullUrl);
  return { config, ...(hasAnySecret ? { secrets } : {}) };
}

/**
 * Determines whether a configured MCP server can be called directly via `NativeMcpClient` without falling back to the
 * Copilot CLI runtime's OAuth session.
 * - Stdio servers: always direct when `command` is set.
 * - Loopback HTTP/SSE servers (`127.0.0.1`, `localhost`, `::1`): always direct.
 * - Remote HTTP/SSE servers: direct when a bearerToken, secret header, or secret query parameter is present in
 *   `McpSecretStore`, or when explicitly added in ARIA (`source === "aria"`) without CLI OAuth-only config.
 *   For remote servers imported from CLI (`source === "cli"`) without native tokens/headers, returns `false` unless
 *   tokens are set in `McpSecretStore`, so ARIA can bridge/fallback to `runtime.runMcpAction`.
 */
export function hasDirectMcpAuth(server: StoredMcpServerConfig, secrets?: McpServerSecrets): boolean {
  if (!server.enabled) return false;
  if (server.transport === "stdio") {
    return Boolean(server.command?.trim());
  }
  const effectiveUrl = secrets?.fullUrl ?? server.url;
  if (!effectiveUrl) return false;
  try {
    const parsed = new URL(effectiveUrl);
    if (isLoopbackHost(parsed.hostname)) return true;
    if (parsed.search !== "") return true;
  } catch {
    return false;
  }
  if (secrets?.bearerToken?.trim()) return true;
  if (secrets?.headers && Object.keys(secrets.headers).length > 0) return true;
  if (server.headers && Object.keys(server.headers).some(isSecretHeaderName)) return true;
  if (server.source === "aria" && !server.oauthClientId) return true;
  return false;
}

// ── Copilot CLI ~/.copilot/mcp-config.json parser & importer ───────────────────────────────────────────────────

export interface ParsedCliMcpConfig {
  servers: Array<{
    config: StoredMcpServerConfig;
    secrets?: McpServerSecrets;
  }>;
  disabledMcpServers: string[];
  pluginDirectories: string[];
}

export function defaultCliMcpConfigPath(env: NodeJS.ProcessEnv = process.env, homedir: string = os.homedir()): string {
  if (env.ARIA_CLI_MCP_CONFIG?.trim()) return path.resolve(env.ARIA_CLI_MCP_CONFIG.trim());
  if (env.COPILOT_HOME?.trim()) return path.join(path.resolve(env.COPILOT_HOME.trim()), "mcp-config.json");
  return path.join(homedir, ".copilot", "mcp-config.json");
}

/**
 * Parses a `~/.copilot/mcp-config.json` document (accepting `{ mcpServers: { ... } }` or `{ servers: { ... } }`, plus
 * optional `disabledMcpServers` and `pluginDirectories`).
 */
export function parseCliMcpConfigJson(rawText: string, now = Date.now()): ParsedCliMcpConfig {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { servers: [], disabledMcpServers: [], pluginDirectories: [] };
  }
  const rawTokenProblem = checkJsonRawTokens(trimmed);
  if (rawTokenProblem && rawTokenProblem.includes("duplicate or forbidden")) {
    throw new Error(`Invalid mcp-config.json: ${rawTokenProblem}.`);
  }
  let root: unknown;
  try {
    root = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`Couldn't parse mcp-config.json: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new Error("Invalid mcp-config.json: expected a JSON object at the top level.");
  }
  const obj = root as Record<string, unknown>;
  const disabledList = Array.isArray(obj.disabledMcpServers)
    ? obj.disabledMcpServers.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())
    : [];
  const disabledSet = new Set(disabledList);

  const pluginDirectories = Array.isArray(obj.pluginDirectories)
    ? [
        ...new Set(
          obj.pluginDirectories
            .filter((x): x is string => typeof x === "string" && x.trim() !== "" && !DISGUISE_CHARS.test(x))
            .map((x) => x.trim())
            .slice(0, MAX_PLUGIN_DIRS),
        ),
      ]
    : [];

  const rawServersObj =
    obj.mcpServers && typeof obj.mcpServers === "object" && !Array.isArray(obj.mcpServers)
      ? (obj.mcpServers as Record<string, unknown>)
      : obj.servers && typeof obj.servers === "object" && !Array.isArray(obj.servers)
        ? (obj.servers as Record<string, unknown>)
        : {};

  const servers: Array<{ config: StoredMcpServerConfig; secrets?: McpServerSecrets }> = [];
  for (const [rawName, rawDef] of Object.entries(rawServersObj).slice(0, MAX_SERVERS)) {
    if (!rawDef || typeof rawDef !== "object" || Array.isArray(rawDef)) continue;
    const def = rawDef as Record<string, unknown>;
    const rawType = typeof def.type === "string" ? def.type.trim().toLowerCase() : undefined;
    let transport: McpServerTransport | undefined;
    if (rawType === "http" || rawType === "streamable-http" || rawType === "streamable_http" || rawType === "streamablehttp") {
      transport = "http";
    } else if (rawType === "sse") {
      transport = "sse";
    } else if (rawType === "stdio" || rawType === "local") {
      transport = "stdio";
    } else if (typeof def.url === "string" && def.url.trim()) {
      transport = "http";
    } else if (typeof def.command === "string" && def.command.trim()) {
      transport = "stdio";
    }
    if (!transport) continue;

    const enabled = def.disabled !== true && def.enabled !== false && !disabledSet.has(rawName.trim());
    const command = typeof def.command === "string" ? def.command : undefined;
    const args = Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === "string") : undefined;
    const cwd =
      typeof def.cwd === "string"
        ? def.cwd
        : typeof def.workingDirectory === "string"
          ? def.workingDirectory
          : undefined;
    const env =
      def.env && typeof def.env === "object" && !Array.isArray(def.env)
        ? Object.fromEntries(
            Object.entries(def.env as Record<string, unknown>)
              .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
              .map(([k, v]) => [k, String(v)]),
          )
        : undefined;
    const url = typeof def.url === "string" ? def.url : undefined;
    const headers =
      def.headers && typeof def.headers === "object" && !Array.isArray(def.headers)
        ? Object.fromEntries(
            Object.entries(def.headers as Record<string, unknown>)
              .filter(([, v]) => typeof v === "string")
              .map(([k, v]) => [k, String(v)]),
          )
        : undefined;
    const tools = Array.isArray(def.tools) ? def.tools.filter((t): t is string => typeof t === "string") : undefined;
    const timeout = typeof def.timeout === "number" && Number.isFinite(def.timeout) ? def.timeout : undefined;
    const displayName = typeof def.displayName === "string" ? def.displayName : undefined;
    const sourcePlugin = typeof def.sourcePlugin === "string" ? def.sourcePlugin : undefined;
    const oauthObj = def.oauth && typeof def.oauth === "object" && !Array.isArray(def.oauth) ? (def.oauth as Record<string, unknown>) : undefined;
    const oauthClientId =
      typeof def.oauthClientId === "string"
        ? def.oauthClientId
        : typeof oauthObj?.clientId === "string"
          ? oauthObj.clientId
          : undefined;
    const oauthScopes = Array.isArray(oauthObj?.scopes)
      ? oauthObj.scopes.filter((s): s is string => typeof s === "string")
      : undefined;
    const oauthPublicClient =
      typeof def.oauthPublicClient === "boolean"
        ? def.oauthPublicClient
        : typeof oauthObj?.publicClient === "boolean"
          ? oauthObj.publicClient
          : undefined;

    try {
      const split = splitServerSecrets({
        name: rawName,
        ...(displayName ? { displayName } : {}),
        transport,
        enabled,
        source: "cli",
        ...(sourcePlugin ? { sourcePlugin } : {}),
        ...(tools ? { tools } : {}),
        ...(timeout !== undefined ? { timeout } : {}),
        ...(command ? { command } : {}),
        ...(args ? { args } : {}),
        ...(cwd ? { cwd } : {}),
        ...(env ? { env } : {}),
        ...(url ? { url } : {}),
        ...(headers ? { headers } : {}),
        ...(oauthClientId ? { oauthClientId } : {}),
        ...(oauthScopes ? { oauthScopes } : {}),
        ...(oauthPublicClient !== undefined ? { oauthPublicClient } : {}),
        importedAt: now,
        updatedAt: now,
      });
      servers.push(split);
    } catch {
      // Skip malformed individual server entries without aborting the entire CLI import.
    }
  }

  return { servers, disabledMcpServers: disabledList, pluginDirectories };
}

/**
 * Merges a parsed Copilot CLI MCP configuration into ARIA's `McpConfigState` and `McpSecretStore`.
 * Preserves any `"aria"`-customized server entries unless `options.overwriteAriaEdits === true`, and preserves
 * any user-supplied `bearerToken` in `McpSecretStore` for `"cli"` servers.
 */
export function importCliMcpConfig(
  current: McpConfigState | undefined,
  parsed: ParsedCliMcpConfig,
  secretStore?: McpSecretStore,
  options: { overwriteAriaEdits?: boolean; now?: number } = {},
): { state: McpConfigState; imported: number; updated: number; skipped: number } {
  const effectiveCurrent = current ?? EMPTY_MCP_CONFIG;
  const now = options.now ?? Date.now();
  const byName = new Map(effectiveCurrent.servers.map((s) => [s.name, s]));
  const nextServers = [...effectiveCurrent.servers];
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  for (const item of parsed.servers) {
    const existing = byName.get(item.config.name);
    if (existing && existing.source === "aria" && options.overwriteAriaEdits !== true) {
      skipped++;
      continue;
    }
    const preservedEnabled =
      existing && existing.source === "cli"
        ? item.config.enabled === false
          ? false
          : existing.enabled
        : item.config.enabled;

    const mergedConfig: StoredMcpServerConfig = {
      ...item.config,
      enabled: preservedEnabled,
      source: "cli",
      importedAt: now,
      updatedAt: now,
    };

    if (existing) {
      const idx = nextServers.findIndex((s) => s.name === existing.name);
      if (idx >= 0) nextServers[idx] = mergedConfig;
      updated++;
    } else {
      if (nextServers.length >= MAX_SERVERS) {
        skipped++;
        continue;
      }
      nextServers.push(mergedConfig);
      byName.set(mergedConfig.name, mergedConfig);
      imported++;
    }

    if (secretStore) {
      const prevSecrets = secretStore.getServerSecrets(mergedConfig.name);
      // Bind credentials to the server's endpoint: only preserve bearerToken and secrets if the endpoint hasn't changed.
      const sameEndpoint =
        !existing ||
        (existing.transport === mergedConfig.transport &&
          (mergedConfig.transport === "stdio"
            ? existing.command === mergedConfig.command
            : existing.urlKey === mergedConfig.urlKey));
      const preservedBearerToken = sameEndpoint ? prevSecrets?.bearerToken : undefined;
      const mergedSecrets: McpServerSecrets = {
        ...(preservedBearerToken ? { bearerToken: preservedBearerToken } : {}),
        ...(item.secrets?.headers ? { headers: item.secrets.headers } : sameEndpoint && prevSecrets?.headers ? { headers: prevSecrets.headers } : {}),
        ...(item.secrets?.env ? { env: item.secrets.env } : sameEndpoint && prevSecrets?.env ? { env: prevSecrets.env } : {}),
        ...(item.secrets?.fullUrl ? { fullUrl: item.secrets.fullUrl } : sameEndpoint && prevSecrets?.fullUrl ? { fullUrl: prevSecrets.fullUrl } : {}),
      };
      const hasAny = Boolean(mergedSecrets.bearerToken || (mergedSecrets.headers && Object.keys(mergedSecrets.headers).length > 0) || (mergedSecrets.env && Object.keys(mergedSecrets.env).length > 0) || mergedSecrets.fullUrl);
      secretStore.setServerSecrets(mergedConfig.name, hasAny ? mergedSecrets : null);
    }
  }

  // Also apply disabledMcpServers to any existing "cli" server
  if (parsed.disabledMcpServers.length > 0) {
    const disabledSet = new Set(parsed.disabledMcpServers);
    for (let i = 0; i < nextServers.length; i++) {
      const srv = nextServers[i]!;
      if (srv.source === "cli" && disabledSet.has(srv.name) && srv.enabled) {
        nextServers[i] = { ...srv, enabled: false, updatedAt: now };
      }
    }
  }

  const mergedPluginDirs = [...new Set([...effectiveCurrent.pluginDirectories, ...parsed.pluginDirectories])].slice(0, MAX_PLUGIN_DIRS);
  const state: McpConfigState = {
    keepInSync: effectiveCurrent.keepInSync,
    lastImportedAt: now,
    servers: nextServers,
    pluginDirectories: mergedPluginDirs,
    ...(effectiveCurrent.skillDirectories?.length ? { skillDirectories: [...effectiveCurrent.skillDirectories] } : {}),
    ...(effectiveCurrent.agentDirectories?.length ? { agentDirectories: [...effectiveCurrent.agentDirectories] } : {}),
    ...(effectiveCurrent.disabledSkills?.length ? { disabledSkills: [...effectiveCurrent.disabledSkills] } : {}),
  };
  return { state, imported, updated, skipped };
}

function resolveSecretsGetter(
  secrets: ((serverName: string) => McpServerSecrets | undefined) | McpSecretStore | undefined,
): (serverName: string) => McpServerSecrets | undefined {
  if (!secrets) return () => undefined;
  if (typeof secrets === "function") return secrets;
  return (serverName: string) => secrets.getServerSecrets(serverName);
}

/**
 * Builds the `mcpServers` map to pass to Copilot SDK session creation (`openConductor`, `openWorker`, `runTimekeeper`,
 * `inventory`, `signIn`).
 *
 * Rubber duck review fix #3: By default (`includeCliServers !== true`), only passes `source === "aria"` servers (or
 * servers where the user explicitly configured a `bearerToken` in ARIA) to session `mcpServers` so ambient Copilot
 * CLI daemon servers (whose OAuth tokens are managed by the CLI daemon) are never shadowed by unauthenticated URLs.
 * Ambient CLI servers are still strictly gated by `disabledMcpServers` and `availableTools`.
 */
export function buildScopedSdkMcpServers(
  mcpConfig: McpConfigState,
  secrets?: ((serverName: string) => McpServerSecrets | undefined) | McpSecretStore,
  options: {
    disabledMcpServers?: readonly string[];
    allowedWireTools?: readonly string[];
    includeCliServers?: boolean;
  } = {},
): Record<string, RuntimeMcpServerConfig> {
  const getSecrets = resolveSecretsGetter(secrets);
  const disabledSet = new Set(options.disabledMcpServers ?? []);
  const out: Record<string, RuntimeMcpServerConfig> = {};

  for (const s of mcpConfig.servers) {
    if (!s.enabled || disabledSet.has(s.name)) continue;
    const sec = getSecrets(s.name);
    const isCustomizedInAria = s.source === "aria" || Boolean(sec?.bearerToken?.trim());
    if (!options.includeCliServers && !isCustomizedInAria) continue;

    let tools: string[];
    if (options.allowedWireTools !== undefined) {
      const prefix = serverWirePrefix(s.name);
      const allowedForServer: string[] = [];
      for (const entry of options.allowedWireTools) {
        const raw = entry.startsWith("mcp:") ? entry.slice(4) : entry;
        if (raw.startsWith(prefix)) {
          const toolName = raw.slice(prefix.length);
          if (toolName) allowedForServer.push(toolName);
        }
      }
      if (allowedForServer.length === 0) continue;
      tools = allowedForServer;
    } else {
      tools = s.tools !== undefined ? [...s.tools] : ["*"];
    }

    if (s.transport === "stdio") {
      if (!s.command) continue;
      const mergedEnv: Record<string, string> = {
        ...(s.env ?? {}),
        ...(sec?.env ?? {}),
      };
      out[s.name] = {
        type: "stdio",
        command: s.command,
        ...(s.args?.length ? { args: [...s.args] } : {}),
        ...(s.cwd ? { workingDirectory: s.cwd } : {}),
        ...(Object.keys(mergedEnv).length > 0 ? { env: mergedEnv } : {}),
        ...(s.timeout ? { timeout: s.timeout } : {}),
        tools,
      };
      continue;
    }

    const effectiveUrl = sec?.fullUrl ?? s.url;
    if (!effectiveUrl) continue;
    const mergedHeaders: Record<string, string> = {
      ...(s.headers ?? {}),
      ...(sec?.headers ?? {}),
    };
    if (sec?.bearerToken?.trim() && !Object.keys(mergedHeaders).some((k) => k.toLowerCase() === "authorization")) {
      mergedHeaders.Authorization = `Bearer ${sec.bearerToken.trim()}`;
    }
    out[s.name] = {
      type: s.transport,
      url: effectiveUrl,
      ...(Object.keys(mergedHeaders).length > 0 ? { headers: mergedHeaders } : {}),
      ...(s.timeout ? { timeout: s.timeout } : {}),
      tools,
    };
  }

  return out;
}

/** Deterministic fingerprint of the active MCP config and pluginDirectories for `ariaOpensWith()`. */
export function mcpConfigFingerprint(
  mcpConfig: McpConfigState,
  secrets?: ((serverName: string) => McpServerSecrets | undefined) | McpSecretStore,
  disabledMcpServers?: readonly string[],
): string {
  const scoped = buildScopedSdkMcpServers(mcpConfig, secrets, {
    ...(disabledMcpServers ? { disabledMcpServers } : {}),
  });
  const sortedNames = Object.keys(scoped).sort();
  const entries = sortedNames.map((name) => [name, scoped[name]]);
  const disabledInAria = mcpConfig.servers
    .filter((s) => !s.enabled)
    .map((s) => s.name)
    .sort();
  const pluginDirs = [...mcpConfig.pluginDirectories].sort();
  const skillDirs = [...(mcpConfig.skillDirectories ?? [])].sort();
  const agentDirs = [...(mcpConfig.agentDirectories ?? [])].sort();
  const disabledSkills = [...(mcpConfig.disabledSkills ?? [])].sort();
  const allServersFp = mcpConfig.servers
    .map((s) => [s.name, s.transport, s.urlKey ?? s.command ?? "", s.tools ? [...s.tools].sort() : "*", s.enabled])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify({
    entries,
    disabledInAria,
    pluginDirs,
    ...(skillDirs.length > 0 ? { skillDirs } : {}),
    ...(agentDirs.length > 0 ? { agentDirs } : {}),
    ...(disabledSkills.length > 0 ? { disabledSkills } : {}),
    allServersFp,
  });
}

/** Projects safe, redacted configuration fields onto an `IntegrationServer` for the renderer (never exposing URLs or secret values). */
export function redactedServerMetadata(
  server: StoredMcpServerConfig,
  secrets?: McpServerSecrets,
): Pick<
  IntegrationServer,
  | "configuredInAria"
  | "configSource"
  | "transport"
  | "enabled"
  | "command"
  | "argCount"
  | "envKeys"
  | "headerKeys"
  | "hasAuthToken"
  | "timeout"
> {
  const envKeys = [...new Set([...Object.keys(server.env ?? {}), ...(server.secretEnvKeys ?? []), ...Object.keys(secrets?.env ?? {})])].sort();
  const headerKeys = [...new Set([...Object.keys(server.headers ?? {}), ...(server.secretHeaderKeys ?? []), ...Object.keys(secrets?.headers ?? {})])].sort();
  const hasAuthToken = Boolean(
    secrets?.bearerToken?.trim() ||
      (secrets?.headers && Object.keys(secrets.headers).some(isSecretHeaderName)) ||
      (server.secretHeaderKeys && server.secretHeaderKeys.some(isSecretHeaderName)) ||
      (secrets?.fullUrl && safeHasQueryParams(secrets.fullUrl)),
  );
  const sanitizedCmd = server.transport === "stdio" && server.command ? untrusted(path.basename(server.command.trim()) || server.command.trim(), 120) : undefined;
  return {
    configuredInAria: true,
    configSource: server.source,
    transport: server.transport,
    enabled: server.enabled,
    ...(sanitizedCmd ? { command: sanitizedCmd } : {}),
    ...(server.transport === "stdio" ? { argCount: server.args?.length ?? 0 } : {}),
    ...(envKeys.length > 0 ? { envKeys } : {}),
    ...(headerKeys.length > 0 ? { headerKeys } : {}),
    ...(hasAuthToken ? { hasAuthToken: true } : {}),
    ...(server.timeout !== undefined ? { timeout: server.timeout } : {}),
  };
}

// ── McpConfigStore ────────────────────────────────────────────────────────────────────────────────────────────

export interface McpConfigStoreDeps {
  loadState?: () => unknown;
  saveState?: (state: McpConfigState) => void;
  secretStore?: McpSecretStore;
  cliConfigPath?: string;
}

export class McpConfigStore {
  private state: McpConfigState;
  readonly secretStore: McpSecretStore;
  private readonly saveStateFn: ((state: McpConfigState) => void) | undefined;
  private readonly cliConfigPath: string | undefined;

  constructor(deps: McpConfigStoreDeps = {}) {
    this.state = loadMcpConfig(deps.loadState?.());
    this.secretStore = deps.secretStore ?? createMemoryMcpSecretStore();
    this.saveStateFn = deps.saveState;
    this.cliConfigPath = deps.cliConfigPath;
  }

  private persist(): void {
    this.saveStateFn?.(this.state);
  }

  getState(): McpConfigState {
    return {
      keepInSync: this.state.keepInSync,
      ...(this.state.lastImportedAt !== undefined ? { lastImportedAt: this.state.lastImportedAt } : {}),
      servers: this.state.servers.map((s) => ({ ...s })),
      pluginDirectories: [...this.state.pluginDirectories],
      ...(this.state.skillDirectories?.length ? { skillDirectories: [...this.state.skillDirectories] } : {}),
      ...(this.state.agentDirectories?.length ? { agentDirectories: [...this.state.agentDirectories] } : {}),
      ...(this.state.disabledSkills?.length ? { disabledSkills: [...this.state.disabledSkills] } : {}),
    };
  }

  reload(raw: unknown): McpConfigState {
    this.state = loadMcpConfig(raw);
    return this.getState();
  }

  getServer(serverName: string): StoredMcpServerConfig | undefined {
    const found = this.state.servers.find((s) => s.name === serverName);
    return found ? { ...found } : undefined;
  }

  getServerSecrets(serverName: string): McpServerSecrets | undefined {
    return this.secretStore.getServerSecrets(serverName);
  }

  hasDirectAuth(serverName: string): boolean {
    const server = this.state.servers.find((s) => s.name === serverName);
    if (!server) return false;
    return hasDirectMcpAuth(server, this.secretStore.getServerSecrets(serverName));
  }

  setKeepInSync(keepInSync: boolean): McpConfigState {
    this.state = { ...this.state, keepInSync };
    this.persist();
    return this.getState();
  }

  importFromCliJson(
    rawJson: string,
    options: { overwriteAriaEdits?: boolean; now?: number } = {},
  ): { state: McpConfigState; imported: number; updated: number; skipped: number } {
    const parsed = parseCliMcpConfigJson(rawJson, options.now);
    const result = importCliMcpConfig(this.state, parsed, this.secretStore, options);
    this.state = result.state;
    this.persist();
    return { state: this.getState(), imported: result.imported, updated: result.updated, skipped: result.skipped };
  }

  importFromCliFile(
    filePath = this.cliConfigPath ?? defaultCliMcpConfigPath(),
    options: {
      overwriteAriaEdits?: boolean;
      now?: number;
      fallbackServers?: Array<{
        name: string;
        displayName?: string;
        transport?: McpServerTransport;
        url?: string;
        command?: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        headers?: Record<string, string>;
        enabled?: boolean;
        sourcePlugin?: string;
      }>;
      fallbackPluginDirectories?: string[];
    } = {},
  ): { state: McpConfigState; imported: number; updated: number; skipped: number } {
    const now = options.now ?? Date.now();
    let parsed: ParsedCliMcpConfig = { servers: [], disabledMcpServers: [], pluginDirectories: [] };
    if (filePath && existsSync(filePath)) {
      const rawText = readFileSync(filePath, "utf8");
      parsed = parseCliMcpConfigJson(rawText, now);
    }
    if (options.fallbackServers?.length) {
      const seenNames = new Set(parsed.servers.map((s) => s.config.name));
      for (const fb of options.fallbackServers) {
        if (seenNames.has(fb.name)) continue;
        const transport: McpServerTransport | undefined =
          fb.transport ?? (fb.url ? "http" : fb.command ? "stdio" : undefined);
        if (!transport) continue;
        try {
          const split = splitServerSecrets({
            name: fb.name,
            ...(fb.displayName ? { displayName: fb.displayName } : {}),
            transport,
            enabled: fb.enabled !== false,
            source: "cli",
            ...(fb.sourcePlugin ? { sourcePlugin: fb.sourcePlugin } : {}),
            ...(fb.command ? { command: fb.command } : {}),
            ...(fb.args ? { args: fb.args } : {}),
            ...(fb.cwd ? { cwd: fb.cwd } : {}),
            ...(fb.env ? { env: fb.env } : {}),
            ...(fb.url ? { url: fb.url } : {}),
            ...(fb.headers ? { headers: fb.headers } : {}),
            importedAt: now,
            updatedAt: now,
          });
          parsed.servers.push(split);
          seenNames.add(fb.name);
        } catch {
          // One bad fallback entry mustn't cost the others.
        }
      }
    }
    if (options.fallbackPluginDirectories?.length) {
      parsed.pluginDirectories = [
        ...new Set([...parsed.pluginDirectories, ...options.fallbackPluginDirectories.filter((d) => d.trim() !== "")]),
      ].slice(0, MAX_PLUGIN_DIRS);
    }
    const result = importCliMcpConfig(this.state, parsed, this.secretStore, {
      ...(options.overwriteAriaEdits !== undefined ? { overwriteAriaEdits: options.overwriteAriaEdits } : {}),
      now,
    });
    this.state = result.state;
    this.persist();
    return { state: this.getState(), imported: result.imported, updated: result.updated, skipped: result.skipped };
  }

  saveServer(input: z.infer<typeof SaveMcpServerInput>, now = Date.now()): StoredMcpServerConfig {
    const name = validateMcpServerName(input.name);
    const existing = this.state.servers.find((s) => s.name === name);
    const prevSecrets = this.secretStore.getServerSecrets(name);

    const effectiveUrl =
      input.transport === "http" || input.transport === "sse"
        ? input.url?.trim() || prevSecrets?.fullUrl || existing?.url
        : undefined;
    const effectiveCommand =
      input.transport === "stdio"
        ? input.command?.trim() || existing?.command
        : undefined;

    const source = existing ? existing.source : "aria";
    const transportChanged = existing !== undefined && existing.transport !== input.transport;

    const split = splitServerSecrets({
      name,
      ...(input.displayName !== undefined ? (input.displayName ? { displayName: input.displayName } : {}) : existing?.displayName ? { displayName: existing.displayName } : {}),
      transport: input.transport,
      enabled: input.enabled ?? existing?.enabled ?? true,
      source,
      ...(input.tools !== undefined ? { tools: input.tools } : existing?.tools !== undefined ? { tools: existing.tools } : {}),
      ...(input.timeout !== undefined ? { timeout: input.timeout } : existing?.timeout !== undefined ? { timeout: existing.timeout } : {}),
      ...(effectiveCommand ? { command: effectiveCommand } : {}),
      ...(input.args !== undefined ? { args: input.args } : existing?.args ? { args: existing.args } : {}),
      ...(input.cwd !== undefined ? (input.cwd ? { cwd: input.cwd } : {}) : existing?.cwd ? { cwd: existing.cwd } : {}),
      ...(input.env !== undefined ? { env: input.env } : existing?.env ? { env: existing.env } : {}),
      ...(effectiveUrl ? { url: effectiveUrl } : {}),
      ...(input.headers !== undefined ? { headers: input.headers } : existing?.headers ? { headers: existing.headers } : {}),
      ...(input.bearerToken !== undefined
        ? { bearerToken: input.bearerToken }
        : !transportChanged && prevSecrets?.bearerToken
          ? { bearerToken: prevSecrets.bearerToken }
          : {}),
      ...(existing?.importedAt !== undefined ? { importedAt: existing.importedAt } : {}),
      updatedAt: now,
    });

    const nextSecrets: McpServerSecrets = input.transport === "stdio"
      ? {
          ...(input.env !== undefined
            ? split.secrets?.env
            : prevSecrets?.env
              ? { env: prevSecrets.env }
              : {}),
        }
      : {
          ...(split.secrets?.bearerToken ? { bearerToken: split.secrets.bearerToken } : {}),
          ...(input.headers !== undefined
            ? split.secrets?.headers
              ? { headers: split.secrets.headers }
              : {}
            : !transportChanged && prevSecrets?.headers
              ? { headers: prevSecrets.headers }
              : {}),
          ...(split.secrets?.fullUrl ? { fullUrl: split.secrets.fullUrl } : {}),
        };
    const hasAnySecrets = Boolean(nextSecrets.bearerToken || nextSecrets.headers || nextSecrets.env || nextSecrets.fullUrl);
    this.secretStore.setServerSecrets(name, hasAnySecrets ? nextSecrets : null);

    // Keep secretHeaderKeys and secretEnvKeys accurate when preserving existing secrets
    if (nextSecrets.headers && Object.keys(nextSecrets.headers).length > 0) {
      split.config.secretHeaderKeys = Object.keys(nextSecrets.headers);
    }
    if (nextSecrets.env && Object.keys(nextSecrets.env).length > 0) {
      split.config.secretEnvKeys = Object.keys(nextSecrets.env);
    }

    const nextServers = [...this.state.servers];
    const idx = nextServers.findIndex((s) => s.name === name);
    if (idx >= 0) {
      nextServers[idx] = split.config;
    } else {
      if (nextServers.length >= MAX_SERVERS) {
        throw new Error(`You have ${MAX_SERVERS} MCP servers configured, the maximum ARIA stores.`);
      }
      nextServers.push(split.config);
    }
    this.state = { ...this.state, servers: nextServers };
    this.persist();
    return { ...split.config };
  }

  removeServer(serverName: string): boolean {
    const name = serverName.trim();
    const before = this.state.servers.length;
    const nextServers = this.state.servers.filter((s) => s.name !== name);
    this.secretStore.setServerSecrets(name, null);
    if (nextServers.length === before) return false;
    this.state = { ...this.state, servers: nextServers };
    this.persist();
    return true;
  }

  setServerToken(serverName: string, bearerToken: string | null, now = Date.now()): StoredMcpServerConfig {
    const name = validateMcpServerName(serverName);
    const existing = this.state.servers.find((s) => s.name === name);
    const prevSecrets = this.secretStore.getServerSecrets(name) ?? {};

    let cleanToken: string | undefined;
    if (bearerToken !== null && bearerToken.trim() !== "") {
      cleanToken = bearerToken.trim().replace(/^Bearer\s+/i, "").trim();
      if (/[\r\n\0]/.test(cleanToken) || DISGUISE_CHARS.test(cleanToken)) {
        throw new Error("Bearer token cannot contain control or invisible characters.");
      }
    }

    const nextSecrets: McpServerSecrets = {
      ...prevSecrets,
    };
    if (cleanToken) {
      nextSecrets.bearerToken = cleanToken;
    } else {
      delete nextSecrets.bearerToken;
    }
    const hasAny = Boolean(nextSecrets.bearerToken || nextSecrets.headers || nextSecrets.env || nextSecrets.fullUrl);
    this.secretStore.setServerSecrets(name, hasAny ? nextSecrets : null);

    if (existing) {
      const updated: StoredMcpServerConfig = { ...existing, updatedAt: now };
      this.state = {
        ...this.state,
        servers: this.state.servers.map((s) => (s.name === name ? updated : s)),
      };
      this.persist();
      return { ...updated };
    }

    // If the server was only in the runtime catalog, create a minimal entry for it
    const created: StoredMcpServerConfig = {
      name,
      transport: "http",
      enabled: true,
      source: "aria",
      github: isGithubName(name),
      updatedAt: now,
    };
    this.state = {
      ...this.state,
      servers: [...this.state.servers, created].slice(0, MAX_SERVERS),
    };
    this.persist();
    return { ...created };
  }

  buildScopedServers(
    options: {
      disabledMcpServers?: readonly string[];
      allowedWireTools?: readonly string[];
      includeCliServers?: boolean;
    } = {},
  ): Record<string, RuntimeMcpServerConfig> {
    return buildScopedSdkMcpServers(this.state, this.secretStore, options);
  }

  private validateDirectoryPath(rawPath: string): string {
    const clean = rawPath.trim();
    if (!clean || clean.length > ARG_MAX || DISGUISE_CHARS.test(clean) || /[\r\n\0]/.test(clean)) {
      throw new Error("Enter a valid directory path.");
    }
    return clean;
  }

  addPluginDirectory(dir: string): McpConfigState {
    const clean = this.validateDirectoryPath(dir);
    const next = [...new Set([...this.state.pluginDirectories, clean])].slice(0, MAX_PLUGIN_DIRS);
    this.state = { ...this.state, pluginDirectories: next };
    this.persist();
    return this.getState();
  }

  removePluginDirectory(dir: string): McpConfigState {
    const clean = dir.trim();
    const next = this.state.pluginDirectories.filter((d) => d !== clean);
    this.state = { ...this.state, pluginDirectories: next };
    this.persist();
    return this.getState();
  }

  addSkillDirectory(dir: string): McpConfigState {
    const clean = this.validateDirectoryPath(dir);
    const next = [...new Set([...(this.state.skillDirectories ?? []), clean])].slice(0, MAX_PLUGIN_DIRS);
    this.state = { ...this.state, ...(next.length > 0 ? { skillDirectories: next } : {}) };
    if (next.length === 0) delete this.state.skillDirectories;
    this.persist();
    return this.getState();
  }

  removeSkillDirectory(dir: string): McpConfigState {
    const clean = dir.trim();
    const next = (this.state.skillDirectories ?? []).filter((d) => d !== clean);
    const { skillDirectories: _prev, ...rest } = this.state;
    this.state = next.length > 0 ? { ...rest, skillDirectories: next } : rest;
    this.persist();
    return this.getState();
  }

  addAgentDirectory(dir: string): McpConfigState {
    const clean = this.validateDirectoryPath(dir);
    const next = [...new Set([...(this.state.agentDirectories ?? []), clean])].slice(0, MAX_PLUGIN_DIRS);
    this.state = { ...this.state, ...(next.length > 0 ? { agentDirectories: next } : {}) };
    if (next.length === 0) delete this.state.agentDirectories;
    this.persist();
    return this.getState();
  }

  removeAgentDirectory(dir: string): McpConfigState {
    const clean = dir.trim();
    const next = (this.state.agentDirectories ?? []).filter((d) => d !== clean);
    const { agentDirectories: _prev, ...rest } = this.state;
    this.state = next.length > 0 ? { ...rest, agentDirectories: next } : rest;
    this.persist();
    return this.getState();
  }

  setSkillDisabled(skillName: string, disabled: boolean): McpConfigState {
    const clean = skillName.trim();
    if (!clean || clean.length > NAME_MAX || DISGUISE_CHARS.test(clean) || /[\r\n\0]/.test(clean)) {
      throw new Error("Invalid skill name.");
    }
    const current = new Set(this.state.disabledSkills ?? []);
    if (disabled) current.add(clean);
    else current.delete(clean);
    const next = [...current].slice(0, 500);
    const { disabledSkills: _prev, ...rest } = this.state;
    this.state = next.length > 0 ? { ...rest, disabledSkills: next } : rest;
    this.persist();
    return this.getState();
  }

  setDisabledSkills(disabledSkills: readonly string[]): McpConfigState {
    const next = [
      ...new Set(
        disabledSkills
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && s.length <= NAME_MAX && !DISGUISE_CHARS.test(s) && !/[\r\n\0]/.test(s)),
      ),
    ].slice(0, 500);
    const { disabledSkills: _prev, ...rest } = this.state;
    this.state = next.length > 0 ? { ...rest, disabledSkills: next } : rest;
    this.persist();
    return this.getState();
  }

  fingerprint(disabledMcpServers?: readonly string[]): string {
    return mcpConfigFingerprint(this.state, this.secretStore, disabledMcpServers);
  }
}
