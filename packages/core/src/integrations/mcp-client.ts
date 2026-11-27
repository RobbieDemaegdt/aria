/**
 * Phase 7A: Built-in MCP client (`NativeMcpClient`) over `@modelcontextprotocol/sdk` (PLAN.md §0.3 D8, D10, D16, D19,
 * D22, D30–D35; §0.4 #4–#6; §4.3; §4.13; §4.14; §10 Phase 7A).
 *
 * - Supports `stdio`, `http` (Streamable HTTP with automatic SSE fallback on 404/405), `sse`, and `inMemory` transports.
 * - Executes approved MCP writes (`callTool`) and server connectivity probes (`testServer`) directly from ARIA's code
 *   with zero model calls in between.
 * - Enforces a strict two-phase dispatch state machine in `callTool`:
 *   1. Pre-dispatch phase (argument validation, `checkJsonRawTokens`, `checkExactPayload`, transport setup, and MCP
 *      `initialize` handshake): any error returns `{ ok: false, error, blocked: true }`.
 *   2. In-flight phase (after `client.callTool` is dispatched): transport/timeout/abort errors return
 *      `{ ok: false, error }` (without `blocked: true`) so `TimekeeperRunner` and `ActionRunner` flag ambiguous writes.
 */
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SseError, SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { runtimeEnv } from "../runtime/copilot.ts";
import type { McpActionOutcome } from "../runtime/types.ts";
import { isAllowedByServerToolsFilter } from "../trackers/servers.ts";
import type { TaskTracker } from "../trackers/types.ts";
import { checkExactPayload, checkJsonRawTokens, DISGUISE_CHARS } from "./actions.ts";
import {
  DEFAULT_MCP_TIMEOUT_MS,
  hasDirectMcpAuth,
  isLoopbackHost,
  validateMcpUrl,
  type McpServerSecrets,
  type StoredMcpServerConfig,
} from "./config.ts";
import { sanitizeInputSchema, untrusted } from "./rules.ts";
import { serverWirePrefix } from "./scope.ts";
import { ignoreCleanupFailure, onlyWaitedFor } from "../util/ignore.ts";

export { InMemoryTransport };
export type { Transport };

const DEFAULT_TEST_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 5_000;
const MAX_STDERR_BYTES = 4_096;

export interface DirectMcpCallRequest {
  server: string | StoredMcpServerConfig;
  tool: string;
  wireName?: string;
  approvedArgs?: Record<string, unknown>;
  /** Alias for `approvedArgs` in direct unit tests. */
  args?: Record<string, unknown>;
  secrets?: McpServerSecrets;
  transport?: Transport;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DirectMcpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface DirectMcpTestResult {
  ok: boolean;
  latencyMs: number;
  toolCount: number;
  tools: DirectMcpToolInfo[];
  needsAuth?: boolean;
  error?: string;
}

export type TransportFactory = (
  serverName: string,
  config?: StoredMcpServerConfig,
  secrets?: McpServerSecrets,
) => Promise<Transport | undefined> | Transport | undefined;

export interface McpDirectClient {
  /** Whether `serverName` can be called directly by `NativeMcpClient` (without needing an LLM session). */
  canCallDirectly?(serverName: string): boolean;
  /**
   * Executes one approved MCP tool call directly against `request.server` with no model in between.
   * Enforces `checkExactPayload` and `checkJsonRawTokens` on the serialized wire arguments before dispatch.
   */
  callTool(request: DirectMcpCallRequest): Promise<McpActionOutcome>;
  /**
   * Tests connectivity to a server: performs MCP initialize + optional ping + listTools (and the tracker's
   * `testConnectionTool` when testing its server and the server has it), returning latency, discovered tools/schemas, or
   * a specific error.
   */
  testServer(
    serverOrName: string | StoredMcpServerConfig,
    secretsOrOptions?: McpServerSecrets | { timeoutMs?: number; signal?: AbortSignal; secrets?: McpServerSecrets; transport?: Transport },
    signalOrOptions?: AbortSignal | { timeoutMs?: number; signal?: AbortSignal; transport?: Transport },
  ): Promise<DirectMcpTestResult>;
  /** Closes any active transports and child processes. */
  stop(): Promise<void>;
}

export interface NativeMcpClientDeps {
  /** The task tracker: its raw read twins pass a server's tools filter, and its connection test runs on its servers. */
  tracker: () => TaskTracker;
  /** Resolves a stored server configuration by name from `McpConfigStore`. */
  getServerConfig?: (serverName: string) => StoredMcpServerConfig | undefined;
  /** Resolves decrypted server secrets by name from `McpSecretStore`. */
  getServerSecrets?: (serverName: string) => McpServerSecrets | undefined;
  /** Optional custom transport factory (e.g. `InMemoryTransport` in unit tests). */
  transportFactory?: TransportFactory;
  /** Optional custom `fetch` implementation for HTTP/SSE transports. */
  fetch?: FetchLike;
  /**
   * Optional direct runtime bridge (used by `FakeRuntime` for fake non-loopback catalog servers in offline tests, or
   * by `CopilotRuntime` fallback when a remote CLI server has no native token in `McpSecretStore`).
   */
  fallbackCallTool?: (request: {
    server: string;
    tool: string;
    wireName: string;
    approvedArgs: Record<string, unknown>;
    timeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<McpActionOutcome>;
  /** Optional runtime fallback for `testServer` when a server is only in the runtime (e.g. built-in `GitHub` or `FakeRuntime`). */
  fallbackTestServer?: (
    serverName: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<DirectMcpTestResult | undefined>;
  /** True when the runtime provides a zero-model direct handler (`FakeRuntime.callMcpToolDirect`). */
  hasZeroModelFallback?: () => boolean;
  /** Callback invoked when a server returns HTTP 401 / `UnauthorizedError`. */
  onServerNeedsAuth?: (serverName: string) => void;
}

async function boundedClose(ms: number, work: () => Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    work().catch(ignoreCleanupFailure),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

/** Builds validated HTTP request headers from `StoredMcpServerConfig` and `McpServerSecrets`. */
export function buildMcpRequestHeaders(
  serverConfig: StoredMcpServerConfig,
  secrets?: McpServerSecrets,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...(serverConfig.headers ?? {}), ...(secrets?.headers ?? {}) })) {
    const key = k.trim();
    const val = String(v ?? "").trim();
    if (!key) continue;
    if (/[\r\n\0]/.test(key) || /[\r\n\0]/.test(val) || DISGUISE_CHARS.test(key) || DISGUISE_CHARS.test(val)) {
      throw new Error(`Invalid characters in HTTP header "${untrusted(key, 40)}".`);
    }
    headers[key] = val;
  }
  if (secrets?.bearerToken?.trim()) {
    const token = secrets.bearerToken.trim().replace(/^Bearer\s+/i, "").trim();
    if (/[\r\n\0]/.test(token) || DISGUISE_CHARS.test(token)) {
      throw new Error("Invalid characters in bearer token.");
    }
    const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
    if (!hasAuth && token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }
  return headers;
}

function wrapFetchWithHeaders(baseFetch: FetchLike | undefined, extraHeaders: Record<string, string>): FetchLike {
  const underlying: FetchLike = baseFetch ?? ((url, init) => globalThis.fetch(url, init));
  if (Object.keys(extraHeaders).length === 0) return underlying;
  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const merged = new Headers(init?.headers);
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (!merged.has(k)) merged.set(k, v);
    }
    return underlying(url, { ...init, headers: merged });
  };
}

export function isMcpAuthError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof UnauthorizedError) return true;
  if (error instanceof StreamableHTTPError && error.code === 401) return true;
  if (error instanceof SseError && error.code === 401) return true;
  const code = (error as { code?: unknown; status?: unknown }).code ?? (error as { status?: unknown }).status;
  if (code === 401) return true;
  const msg = error instanceof Error ? error.message : String(error);
  return /\b401\b|unauthorized|needs[- ]auth|needs signing in|bearer token|authentication required|invalid[ _]token/i.test(msg);
}

function shouldFallbackToSse(error: unknown): boolean {
  if (error instanceof StreamableHTTPError && (error.code === 404 || error.code === 405)) {
    return true;
  }
  const code = (error as { code?: unknown; status?: unknown }).code ?? (error as { status?: unknown }).status;
  if (code === 404 || code === 405) return true;
  const msg = error instanceof Error ? error.message : String(error);
  return /\b(?:404|405)\b|method not allowed/i.test(msg);
}

/** Extracts text or structured JSON from an MCP `CallToolResult`. */
export function formatMcpCallToolResult(result: unknown): { text: string; isError: boolean } {
  if (!result || typeof result !== "object") {
    return { text: String(result ?? "Done"), isError: false };
  }
  const obj = result as {
    content?: unknown;
    structuredContent?: unknown;
    toolResult?: unknown;
    isError?: unknown;
  };
  const isError = obj.isError === true;

  if (Array.isArray(obj.content) && obj.content.length > 0) {
    const textParts: string[] = [];
    for (const part of obj.content) {
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string") {
        textParts.push((part as { text: string }).text);
      } else if (
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "resource" &&
        (part as { resource?: unknown }).resource &&
        typeof (part as { resource: { text?: unknown } }).resource.text === "string"
      ) {
        textParts.push((part as { resource: { text: string } }).resource.text);
      }
    }
    if (textParts.length > 0) {
      return { text: textParts.join("\n"), isError };
    }
    try {
      return {
        text: JSON.stringify(obj.structuredContent ?? obj.content, null, 2),
        isError,
      };
    } catch {
      return { text: String(obj.content), isError };
    }
  }

  if (obj.structuredContent !== undefined) {
    try {
      return { text: JSON.stringify(obj.structuredContent, null, 2), isError };
    } catch {
      return { text: String(obj.structuredContent), isError };
    }
  }

  if (obj.toolResult !== undefined) {
    return {
      text: typeof obj.toolResult === "string" ? obj.toolResult : JSON.stringify(obj.toolResult, null, 2),
      isError,
    };
  }

  try {
    return { text: JSON.stringify(result, null, 2), isError };
  } catch {
    return { text: String(result), isError };
  }
}

export class NativeMcpClient implements McpDirectClient {
  private stopped = false;
  private readonly activeConnections = new Set<{ close: () => Promise<void>; abort: AbortController }>();
  private readonly serverLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: NativeMcpClientDeps) {}

  private async withServerLock<T>(serverName: string, work: () => Promise<T>): Promise<T> {
    const key = serverName.trim().toLowerCase();
    const prev = this.serverLocks.get(key) ?? Promise.resolve();
    const run = prev.then(work, work);
    const tracked = run.then(onlyWaitedFor, onlyWaitedFor);
    this.serverLocks.set(key, tracked);
    try {
      return await run;
    } finally {
      if (this.serverLocks.get(key) === tracked) {
        this.serverLocks.delete(key);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const active = [...this.activeConnections];
    for (const conn of active) {
      conn.abort.abort();
    }
    if (active.length > 0) {
      await Promise.allSettled(active.map((conn) => boundedClose(CLOSE_TIMEOUT_MS, conn.close)));
    }
    this.activeConnections.clear();
  }

  private resolveServerAndSecrets(
    serverOrName: string | StoredMcpServerConfig,
    explicitSecrets?: McpServerSecrets,
  ): { serverName: string; config?: StoredMcpServerConfig; secrets?: McpServerSecrets } {
    if (typeof serverOrName === "string") {
      const serverName = serverOrName.trim();
      const config = this.deps.getServerConfig?.(serverName);
      const secrets = explicitSecrets ?? this.deps.getServerSecrets?.(serverName);
      return { serverName, ...(config ? { config } : {}), ...(secrets ? { secrets } : {}) };
    }
    const serverName = serverOrName.name.trim();
    const secrets = explicitSecrets ?? this.deps.getServerSecrets?.(serverName);
    return { serverName, config: serverOrName, ...(secrets ? { secrets } : {}) };
  }

  /**
   * Returns true when `NativeMcpClient` can execute calls for `serverName` directly without spawning an LLM session:
   * - If a custom `transportFactory` is configured, true;
   * - If `serverName` is in `McpConfigStore` (`config.enabled === true`) and either `hasDirectMcpAuth(config, secrets)`
   *   is true or `hasZeroModelFallback()` is true (`FakeRuntime`), true.
   */
  canCallDirectly(serverName: string): boolean {
    if (this.deps.transportFactory) return true;
    const config = this.deps.getServerConfig?.(serverName);
    if (!config || !config.enabled) return false;
    const secrets = this.deps.getServerSecrets?.(serverName);
    if (hasDirectMcpAuth(config, secrets)) return true;
    return false;
  }

  /**
   * Opens and connects an `@modelcontextprotocol/sdk` `Client` to `config` (or `customTransport`).
   * For `transport === "http"`, automatically falls back to `SSEClientTransport` if `StreamableHTTPClientTransport`
   * fails during handshake with HTTP 404 or 405.
   */
  private async connectClient(options: {
    serverName: string;
    config?: StoredMcpServerConfig;
    secrets?: McpServerSecrets;
    customTransport?: Transport;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<{ client: Client; getStderr: () => string; cleanup: () => Promise<void> }> {
    const { serverName, config, secrets, customTransport, timeoutMs, signal } = options;

    const factoryTransport =
      customTransport ?? (await this.deps.transportFactory?.(serverName, config, secrets));

    if (factoryTransport) {
      const client = new Client({ name: "aria-mcp-client", version: "0.1.0" }, { capabilities: {} });
      await client.connect(factoryTransport, { timeout: timeoutMs, signal });
      return {
        client,
        getStderr: () => "",
        cleanup: async () => {
          await client.close().catch(ignoreCleanupFailure);
          await factoryTransport.close().catch(ignoreCleanupFailure);
        },
      };
    }

    if (!config) {
      throw new Error(`MCP server "${serverName}" has no direct transport configuration in ARIA.`);
    }
    if (!config.enabled) {
      throw new Error(`${serverName} is disabled in Customize › Integrations.`);
    }

    if (config.transport === "stdio") {
      const command = config.command?.trim();
      if (!command || DISGUISE_CHARS.test(command) || command.includes("\0")) {
        throw new Error(`Stdio MCP server "${serverName}" has an invalid command.`);
      }
      const env: Record<string, string> = {
        ...runtimeEnv(process.env),
        ...(config.env ?? {}),
        ...(secrets?.env ?? {}),
      };
      const transport = new StdioClientTransport({
        command,
        args: config.args ?? [],
        env,
        ...(config.cwd ? { cwd: config.cwd } : {}),
        stderr: "pipe",
      });

      const stderrChunks: Buffer[] = [];
      let stderrBytes = 0;
      const stderrStream = transport.stderr;
      if (stderrStream) {
        stderrStream.on("data", (chunk: Buffer | string) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          if (stderrBytes < MAX_STDERR_BYTES) {
            const slice = buf.subarray(0, MAX_STDERR_BYTES - stderrBytes);
            stderrChunks.push(slice);
            stderrBytes += slice.length;
          }
        });
      }
      const getStderr = () => {
        if (stderrChunks.length === 0) return "";
        return untrusted(Buffer.concat(stderrChunks).toString("utf8").trim(), 240);
      };

      const client = new Client({ name: "aria-mcp-client", version: "0.1.0" }, { capabilities: {} });
      try {
        await client.connect(transport, { timeout: timeoutMs, signal });
      } catch (err) {
        await client.close().catch(ignoreCleanupFailure);
        await transport.close().catch(ignoreCleanupFailure);
        const tail = getStderr();
        const baseMsg = err instanceof Error ? err.message : String(err);
        throw new Error(tail ? `${baseMsg} (${tail})` : baseMsg, { cause: err });
      }

      return {
        client,
        getStderr,
        cleanup: async () => {
          await client.close().catch(ignoreCleanupFailure);
          await transport.close().catch(ignoreCleanupFailure);
        },
      };
    }

    // HTTP or SSE transport
    const rawUrl = secrets?.fullUrl ?? config.url;
    if (!rawUrl) {
      throw new Error(`MCP server "${serverName}" has no URL configured.`);
    }
    const parsedUrl = validateMcpUrl(rawUrl);
    const headers = buildMcpRequestHeaders(config, secrets);
    const fetchWithHeaders = wrapFetchWithHeaders(this.deps.fetch, headers);

    if (config.transport === "http") {
      const httpTransport = new StreamableHTTPClientTransport(parsedUrl, {
        requestInit: { headers },
        fetch: fetchWithHeaders,
        redirectPolicy: "same-origin",
        reconnectionOptions: {
          maxRetries: 1,
          initialReconnectionDelay: 250,
          maxReconnectionDelay: 1_000,
          reconnectionDelayGrowFactor: 1.5,
        },
      });
      const httpClient = new Client({ name: "aria-mcp-client", version: "0.1.0" }, { capabilities: {} });
      try {
        await httpClient.connect(httpTransport, { timeout: timeoutMs, signal });
        return {
          client: httpClient,
          getStderr: () => "",
          cleanup: async () => {
            await httpTransport.terminateSession().catch(ignoreCleanupFailure);
            await httpClient.close().catch(ignoreCleanupFailure);
            await httpTransport.close().catch(ignoreCleanupFailure);
          },
        };
      } catch (err) {
        await httpClient.close().catch(ignoreCleanupFailure);
        await httpTransport.close().catch(ignoreCleanupFailure);
        if (!shouldFallbackToSse(err) || signal.aborted) {
          throw err;
        }
        // Fallback to legacy HTTP+SSE transport when Streamable HTTP returns 404 or 405 during handshake
      }
    }

    const sseTransport = new SSEClientTransport(parsedUrl, {
      requestInit: { headers },
      eventSourceInit: { fetch: fetchWithHeaders as never },
      fetch: fetchWithHeaders,
      redirectPolicy: "same-origin",
    });
    const sseClient = new Client({ name: "aria-mcp-client", version: "0.1.0" }, { capabilities: {} });
    try {
      await sseClient.connect(sseTransport, { timeout: timeoutMs, signal });
      return {
        client: sseClient,
        getStderr: () => "",
        cleanup: async () => {
          await sseClient.close().catch(ignoreCleanupFailure);
          await sseTransport.close().catch(ignoreCleanupFailure);
        },
      };
    } catch (err) {
      await sseClient.close().catch(ignoreCleanupFailure);
      await sseTransport.close().catch(ignoreCleanupFailure);
      throw err;
    }
  }

  /**
   * Executes one approved MCP tool call directly.
   *
   * Two-phase dispatch state machine (Rubber duck review #4):
   * - Phase 1 (Pre-dispatch): Before `client.callTool` is called, any validation, exact-payload, auth, or connection
   *   failure returns `{ ok: false, error, blocked: true }`.
   * - Phase 2 (In-flight): Once `client.callTool` is invoked, any transport/timeout/abort failure returns
   *   `{ ok: false, error }` (without `blocked: true`).
   */
  async callTool(request: DirectMcpCallRequest): Promise<McpActionOutcome> {
    if (this.stopped) {
      return { ok: false, error: "ARIA's MCP client is stopped.", blocked: true };
    }
    if (request.signal?.aborted) {
      return { ok: false, error: "The action was cancelled.", blocked: true };
    }

    const rawApprovedArgs = request.approvedArgs ?? request.args;
    if (rawApprovedArgs === undefined || rawApprovedArgs === null || typeof rawApprovedArgs !== "object" || Array.isArray(rawApprovedArgs)) {
      return {
        ok: false,
        error: "Blocked by ARIA's exact-payload check: arguments are not a plain JSON object.",
        blocked: true,
      };
    }

    // 1. Serialize and check raw JSON tokens (duplicate keys, lossy numbers)
    let serialized: string;
    try {
      serialized = JSON.stringify(rawApprovedArgs);
    } catch {
      return {
        ok: false,
        error: "Blocked by ARIA's exact-payload check: arguments cannot be serialized as JSON.",
        blocked: true,
      };
    }
    const rawTokenProblem = checkJsonRawTokens(serialized);
    if (rawTokenProblem) {
      return {
        ok: false,
        error: `Blocked by ARIA's exact-payload check: arguments ${rawTokenProblem}.`,
        blocked: true,
      };
    }
    const wireArgs = JSON.parse(serialized) as Record<string, unknown>;

    // 2. Run checkExactPayload on the wire object against rawApprovedArgs
    const exactCheck = checkExactPayload(wireArgs, rawApprovedArgs);
    if (!exactCheck.ok) {
      return {
        ok: false,
        error: `Blocked by ARIA's exact-payload check: ${exactCheck.reason}.`,
        blocked: true,
      };
    }

    const { serverName, config, secrets } = this.resolveServerAndSecrets(request.server, request.secrets);
    const wireName = request.wireName ?? `${serverWirePrefix(serverName)}${request.tool}`;

    if (config && !config.enabled) {
      return {
        ok: false,
        error: `${serverName} is disabled in Customize › Integrations.`,
        blocked: true,
      };
    }

    // Validate tool against server's configured tools filter if present (allowing the tracker's raw read twins)
    if (!isAllowedByServerToolsFilter(this.deps.tracker(), serverName, config?.tools, request.tool)) {
      return {
        ok: false,
        error: `Tool "${request.tool}" is not allowed by "${serverName}"'s configured tools filter.`,
        blocked: true,
      };
    }

    // Determine whether to use direct SDK transport or runtime bridge/fallback:
    // - Use direct SDK transport if `request.transport` or `this.deps.transportFactory` is provided,
    //   OR if `config` is stdio,
    //   OR if `config` is HTTP/SSE on loopback (or custom `fetch` is provided) or has direct auth (when not running
    //   against a non-loopback fake URL under `FakeRuntime`).
    const effectiveUrl = secrets?.fullUrl ?? config?.url;
    let isLoopbackUrl = false;
    if (effectiveUrl) {
      try {
        isLoopbackUrl = isLoopbackHost(new URL(effectiveUrl).hostname);
      } catch {
        isLoopbackUrl = false;
      }
    }

    const useRuntimeFallback =
      !request.transport &&
      !this.deps.transportFactory &&
      (!config ||
        (config.transport !== "stdio" &&
          ((!isLoopbackUrl && !this.deps.fetch && Boolean(this.deps.hasZeroModelFallback?.())) ||
            !hasDirectMcpAuth(config, secrets))));

    if (useRuntimeFallback) {
      if (this.deps.fallbackCallTool) {
        return this.deps.fallbackCallTool({
          server: serverName,
          tool: request.tool,
          wireName,
          approvedArgs: wireArgs,
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        });
      }
      return {
        ok: false,
        error: `${serverName} needs signing in or a bearer token first (Customize › Integrations).`,
        blocked: true,
      };
    }

    const timeoutMs = request.timeoutMs ?? config?.timeout ?? DEFAULT_MCP_TIMEOUT_MS;
    const abort = new AbortController();
    const onCallerAbort = () => abort.abort();
    request.signal?.addEventListener("abort", onCallerAbort, { once: true });

    let cleanupFn: (() => Promise<void>) | undefined;
    let getStderrFn: (() => string) | undefined;
    const connEntry = {
      abort,
      close: async () => {
        await cleanupFn?.();
      },
    };
    this.activeConnections.add(connEntry);

    return this.withServerLock(serverName, async () => {
      let dispatched = false;
      try {
        // Phase 1: Connect and initialize (pre-dispatch)
        const connected = await this.connectClient({
          serverName,
          ...(config ? { config } : {}),
          ...(secrets ? { secrets } : {}),
          ...(request.transport ? { customTransport: request.transport } : {}),
          timeoutMs,
          signal: abort.signal,
        });
        cleanupFn = connected.cleanup;
        getStderrFn = connected.getStderr;

        if (abort.signal.aborted || this.stopped) {
          return { ok: false, error: "The action was cancelled.", blocked: true };
        }

        // Final pre-dispatch check right before sending tools/call over the wire
        const finalCheck = checkExactPayload(wireArgs, rawApprovedArgs);
        if (!finalCheck.ok) {
          return {
            ok: false,
            error: `Blocked by ARIA's exact-payload check: ${finalCheck.reason}.`,
            blocked: true,
          };
        }

        // Phase 2: Dispatch tools/call over the transport (in-flight)
        dispatched = true;
        const result = await connected.client.callTool(
          { name: request.tool, arguments: wireArgs },
          CallToolResultSchema,
          { timeout: timeoutMs, signal: abort.signal },
        );

        const formatted = formatMcpCallToolResult(result);
        if (formatted.isError) {
          return {
            ok: false,
            error: formatted.text || "The MCP server rejected the tool call.",
          };
        }
        return {
          ok: true,
          result: formatted.text,
        };
      } catch (err) {
        if (isMcpAuthError(err)) {
          this.deps.onServerNeedsAuth?.(serverName);
          return {
            ok: false,
            error: `${serverName} needs signing in or a bearer token first (Customize › Integrations).`,
            blocked: true,
          };
        }

        const stderrTail = getStderrFn?.() ?? "";
        const rawMsg = err instanceof Error ? err.message : String(err);
        const errDetail = untrusted(stderrTail && !rawMsg.includes(stderrTail) ? `${rawMsg} (${stderrTail})` : rawMsg, 300);

        if (!dispatched) {
          return {
            ok: false,
            error: abort.signal.aborted ? "The action was cancelled." : `Couldn't connect to ${serverName}: ${errDetail}`,
            blocked: true,
          };
        }

        // Dispatched in-flight error: do NOT set blocked: true so callers know the write may have reached the server.
        return {
          ok: false,
          error: `The approved call was sent to ${serverName}, but the connection closed or timed out before the server answered (${errDetail}). Check whether it went through before trying again.`,
        };
      } finally {
        request.signal?.removeEventListener("abort", onCallerAbort);
        this.activeConnections.delete(connEntry);
        if (cleanupFn) {
          await boundedClose(CLOSE_TIMEOUT_MS, cleanupFn);
        }
      }
    });
  }

  /**
   * Tests connectivity to an MCP server:
   * 1. Connects (`initialize` handshake)
   * 2. Runs optional `ping()`
   * 3. Runs `listTools()` and captures tool names, descriptions, and sanitized `inputSchema`s
   * 4. If testing the tracker's server and it exposes the tracker's `testConnectionTool`, calls it to verify the token.
   */
  async testServer(
    serverOrName: string | StoredMcpServerConfig,
    secretsOrOptions?: McpServerSecrets | { timeoutMs?: number; signal?: AbortSignal; secrets?: McpServerSecrets; transport?: Transport },
    signalOrOptions?: AbortSignal | { timeoutMs?: number; signal?: AbortSignal; transport?: Transport },
  ): Promise<DirectMcpTestResult> {
    const startMs = Date.now();
    if (this.stopped) {
      return { ok: false, latencyMs: 0, toolCount: 0, tools: [], error: "ARIA's MCP client is stopped." };
    }

    let explicitSecrets: McpServerSecrets | undefined;
    let timeoutMs: number | undefined;
    let callerSignal: AbortSignal | undefined;
    let customTransport: Transport | undefined;

    if (secretsOrOptions && typeof secretsOrOptions === "object") {
      if ("timeoutMs" in secretsOrOptions || "signal" in secretsOrOptions || "secrets" in secretsOrOptions || "transport" in secretsOrOptions) {
        const opts = secretsOrOptions as { timeoutMs?: number; signal?: AbortSignal; secrets?: McpServerSecrets; transport?: Transport };
        explicitSecrets = opts.secrets;
        timeoutMs = opts.timeoutMs;
        callerSignal = opts.signal;
        customTransport = opts.transport;
      } else {
        explicitSecrets = secretsOrOptions as McpServerSecrets;
      }
    }
    if (signalOrOptions) {
      if (signalOrOptions instanceof AbortSignal || "aborted" in signalOrOptions) {
        callerSignal = signalOrOptions as AbortSignal;
      } else if (typeof signalOrOptions === "object") {
        if (signalOrOptions.timeoutMs !== undefined) timeoutMs = signalOrOptions.timeoutMs;
        if (signalOrOptions.signal) callerSignal = signalOrOptions.signal;
        if (signalOrOptions.transport) customTransport = signalOrOptions.transport;
      }
    }

    const { serverName, config, secrets } = this.resolveServerAndSecrets(serverOrName, explicitSecrets);
    if (callerSignal?.aborted) {
      return { ok: false, latencyMs: 0, toolCount: 0, tools: [], error: "Test cancelled." };
    }
    if (config && !config.enabled) {
      return {
        ok: false,
        latencyMs: 0,
        toolCount: 0,
        tools: [],
        error: `${serverName} is disabled in Customize › Integrations.`,
      };
    }

    const effectiveUrl = secrets?.fullUrl ?? config?.url;
    let isLoopbackUrl = false;
    if (effectiveUrl) {
      try {
        isLoopbackUrl = isLoopbackHost(new URL(effectiveUrl).hostname);
      } catch {
        isLoopbackUrl = false;
      }
    }

    const shouldTryDirect =
      Boolean(customTransport) ||
      Boolean(this.deps.transportFactory) ||
      (config !== undefined &&
        (config.transport === "stdio" ||
          isLoopbackUrl ||
          Boolean(this.deps.fetch) ||
          (!this.deps.hasZeroModelFallback?.() && hasDirectMcpAuth(config, secrets))));

    if (!shouldTryDirect && this.deps.fallbackTestServer) {
      const fb = await this.deps.fallbackTestServer(serverName, {
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(callerSignal ? { signal: callerSignal } : {}),
      });
      if (fb) return fb;
    }

    const effectiveTimeout = timeoutMs ?? config?.timeout ?? DEFAULT_TEST_TIMEOUT_MS;
    const abort = new AbortController();
    const timeoutTimer = setTimeout(() => abort.abort(), effectiveTimeout);
    const onCallerAbort = () => abort.abort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    let cleanupFn: (() => Promise<void>) | undefined;
    let getStderrFn: (() => string) | undefined;
    const connEntry = {
      abort,
      close: async () => {
        await cleanupFn?.();
      },
    };
    this.activeConnections.add(connEntry);

    return this.withServerLock(serverName, async () => {
      const remainingTimeout = () => Math.max(100, effectiveTimeout - (Date.now() - startMs));

      try {
        const connected = await this.connectClient({
          serverName,
          ...(config ? { config } : {}),
          ...(secrets ? { secrets } : {}),
          ...(customTransport ? { customTransport } : {}),
          timeoutMs: remainingTimeout(),
          signal: abort.signal,
        });
        cleanupFn = connected.cleanup;
        getStderrFn = connected.getStderr;

        await connected.client.ping({ timeout: Math.min(remainingTimeout(), 5_000), signal: abort.signal }).catch(() => {
          // Not every server answers a ping: listing its tools below is what decides.
        });

        const listed = await connected.client.listTools(undefined, {
          timeout: remainingTimeout(),
          signal: abort.signal,
        });

        let tools: DirectMcpToolInfo[] = (listed.tools ?? []).map((t) => {
          const schema = t.inputSchema ? sanitizeInputSchema(t.inputSchema) : undefined;
          return {
            name: untrusted(t.name, 200),
            ...(t.description ? { description: untrusted(t.description, 300) } : {}),
            ...(schema ? { inputSchema: schema } : {}),
          };
        });

        if (config?.tools !== undefined && !config.tools.includes("*")) {
          const toolSet = new Set(config.tools);
          tools = tools.filter((t) => toolSet.has(t.name));
        }

        // If testing the tracker's server and it has the tracker's connection test, call it to verify the bearer token.
        const tracker = this.deps.tracker();
        const testTool = tracker.testConnectionTool;
        if (testTool && tracker.matchesServer(serverName) && tools.some((t) => t.name === testTool)) {
          const connRes = await connected.client.callTool(
            { name: testTool, arguments: {} },
            CallToolResultSchema,
            { timeout: remainingTimeout(), signal: abort.signal },
          );
          const formatted = formatMcpCallToolResult(connRes);
          if (formatted.isError) {
            const authFailed = isMcpAuthError(formatted.text);
            if (authFailed) this.deps.onServerNeedsAuth?.(serverName);
            return {
              ok: false,
              latencyMs: Math.max(1, Date.now() - startMs),
              toolCount: tools.length,
              tools,
              ...(authFailed ? { needsAuth: true } : {}),
              error: untrusted(formatted.text || `${testTool} failed`, 240),
            };
          }
        }

        return {
          ok: true,
          latencyMs: Math.max(1, Date.now() - startMs),
          toolCount: tools.length,
          tools,
        };
      } catch (err) {
        // If a CLI-imported server failed direct connection because its OAuth token lives in the runtime, try runtime fallback
        if (!customTransport && config?.source === "cli" && this.deps.fallbackTestServer && !callerSignal?.aborted) {
          const fb = await this.deps.fallbackTestServer(serverName, {
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            ...(callerSignal ? { signal: callerSignal } : {}),
          }).catch(() => undefined);
          if (fb) return fb;
        }

        const needsAuth = isMcpAuthError(err);
        if (needsAuth) {
          this.deps.onServerNeedsAuth?.(serverName);
        }
        const stderrTail = getStderrFn?.() ?? "";
        const rawMsg = err instanceof Error ? err.message : String(err);
        const errDetail = untrusted(stderrTail && !rawMsg.includes(stderrTail) ? `${rawMsg} (${stderrTail})` : rawMsg, 240);
        return {
          ok: false,
          latencyMs: Math.max(1, Date.now() - startMs),
          toolCount: 0,
          tools: [],
          ...(needsAuth ? { needsAuth: true } : {}),
          error: needsAuth ? "401 Unauthorized: needs sign-in or bearer token" : errDetail,
        };
      } finally {
        clearTimeout(timeoutTimer);
        callerSignal?.removeEventListener("abort", onCallerAbort);
        this.activeConnections.delete(connEntry);
        if (cleanupFn) {
          await boundedClose(CLOSE_TIMEOUT_MS, cleanupFn);
        }
      }
    });
  }
}
