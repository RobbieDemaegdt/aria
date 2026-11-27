/**
 * Phase 7A unit tests:
 * - Copilot CLI MCP config parser & importer (`parseCliMcpConfigJson`, `importCliMcpConfig`, `McpConfigStore`, `keepInSync`)
 * - Secret separation (`McpSecretStore`) and redacted renderer metadata (`redactedServerMetadata`)
 * - Scoped session `mcpServers` builder (`buildScopedSdkMcpServers` — rubber duck review #3: only `source === "aria"`
 *   or token-customized servers are passed in `mcpServers` to avoid shadowing ambient CLI daemon servers)
 * - Built-in MCP client (`NativeMcpClient` over `@modelcontextprotocol/sdk`):
 *   - `InMemoryTransport` (`testServer` + `callTool` + the tracker's `get_current_user`)
 *   - `StdioClientTransport` (spawning a local Node MCP server script over stdio)
 *   - Loopback `StreamableHTTPClientTransport` + `StreamableHTTPServerTransport` (bearer token & header injection, 401
 *     needs-auth detection, non-loopback plain `http://` refusal)
 *   - Automatic fallback from `StreamableHTTPClientTransport` to `SSEClientTransport` on 405 Method Not Allowed
 * - Two-phase dispatch state machine in `NativeMcpClient.callTool` (rubber duck review #4: pre-dispatch errors set
 *   `blocked: true`; in-flight errors after `client.callTool` omit `blocked: true`)
 * - Zero-model execution in `ActionRunner.executeApprovedMcpCall`, `confirmAction`, and `TimekeeperRunner`
 *   (`submitTimesheet`, `updateRegisteredEntry`, `deleteRegisteredEntries`, and direct duplicate/task lookups).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  ActionRunner,
  buildScopedSdkMcpServers,
  createMemoryMcpSecretStore,
  EMPTY_CATALOG,
  FakeRuntime,
  hasDirectMcpAuth,
  importCliMcpConfig,
  AriaEngine,
  McpConfigStore,
  mergeCatalog,
  NativeMcpClient,
  parseCliMcpConfigJson,
  redactedServerMetadata,
  type StoredMcpServerConfig,
} from "../src/index.ts";
import { ACME_LEDGER, acmeCreated, acmeIssue, acmeIssues, acmeTracker, acmeWorklogs } from "./helpers/acme.ts";
import "./no-network.ts";

const tempDirs: string[] = [];
const httpServers: http.Server[] = [];
const engines: AriaEngine[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aria-mcp-7a-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (engines.length > 0) {
    await engines.pop()!.stop();
  }
  while (httpServers.length > 0) {
    const srv = httpServers.pop()!;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

/** Creates an in-process MCP `Server` with configurable tools and handler. */
function createTestMcpServer(options: {
  tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  onCallTool?: (name: string, args: Record<string, unknown> | undefined) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
} = {}): Server {
  const server = new Server(
    { name: "test-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const tools = options.tools ?? [
    {
      name: "list_my_issues",
      description: "Reads open tasks.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "create_issues",
      description: "Creates tasks.",
      inputSchema: {
        type: "object",
        properties: { issuesJson: { type: "string" } },
        required: ["issuesJson"],
        additionalProperties: false,
      },
    },
  ];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as {
        type: "object";
        properties?: Record<string, object>;
        required?: string[];
      },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (options.onCallTool) {
      return options.onCallTool(req.params.name, req.params.arguments as Record<string, unknown> | undefined);
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ ok: true, tool: req.params.name, received: req.params.arguments ?? {} }),
        },
      ],
    };
  });
  return server;
}

describe("Phase 7A: CLI MCP config parsing, secret separation, and buildScopedSdkMcpServers", () => {
  it("parses ~/.copilot/mcp-config.json, splits secrets into McpSecretStore, and redacts URLs/tokens for the renderer", () => {
    const rawJson = JSON.stringify({
      mcpServers: {
        Acme: {
          type: "http",
          url: "https://tracker.example/mcp?api_key=TOP_SECRET_QUERY_KEY",
          headers: {
            Authorization: "Bearer SECRET_BEARER_123",
            "X-Client-Name": "ARIA",
          },
          timeout: 45_000,
        },
        LocalTools: {
          type: "stdio",
          command: "node",
          args: ["C:\\tools\\mcp-server.js", "--verbose"],
          env: {
            NODE_ENV: "production",
            SERVICE_API_TOKEN: "SECRET_ENV_TOKEN_999",
          },
        },
        DisabledOne: {
          type: "sse",
          url: "https://disabled.example/sse",
          disabled: true,
        },
      },
      disabledMcpServers: ["AcmeDisabledByList"],
      pluginDirectories: ["C:\\Users\\sam\\.copilot\\plugins\\workiq"],
    });

    const parsed = parseCliMcpConfigJson(rawJson, 1_700_000_000_000);
    expect(parsed.servers).toHaveLength(3);
    expect(parsed.pluginDirectories).toEqual(["C:\\Users\\sam\\.copilot\\plugins\\workiq"]);

    const secretStore = createMemoryMcpSecretStore();
    const imported = importCliMcpConfig(
      { keepInSync: false, servers: [], pluginDirectories: [] },
      parsed,
      secretStore,
      { now: 1_700_000_000_000 },
    );
    expect(imported.imported).toBe(3);
    expect(imported.updated).toBe(0);
    expect(imported.skipped).toBe(0);

    // 1. Stored config never holds the query key, Authorization header value, or SERVICE_API_TOKEN value
    const serializedState = JSON.stringify(imported.state);
    expect(serializedState).not.toContain("TOP_SECRET_QUERY_KEY");
    expect(serializedState).not.toContain("SECRET_BEARER_123");
    expect(serializedState).not.toContain("SECRET_ENV_TOKEN_999");

    const acme = imported.state.servers.find((s) => s.name === "Acme")!;
    expect(acme.url).toBe("https://tracker.example/mcp");
    expect(acme.headers).toEqual({ "X-Client-Name": "ARIA" });
    expect(acme.secretHeaderKeys).toEqual(["Authorization"]);

    // 2. Secrets live in McpSecretStore
    const acmeSecrets = secretStore.getServerSecrets("Acme")!;
    expect(acmeSecrets.fullUrl).toBe("https://tracker.example/mcp?api_key=TOP_SECRET_QUERY_KEY");
    expect(acmeSecrets.headers).toEqual({ Authorization: "Bearer SECRET_BEARER_123" });
    expect(hasDirectMcpAuth(acme, acmeSecrets)).toBe(true);

    const localSecrets = secretStore.getServerSecrets("LocalTools")!;
    expect(localSecrets.env).toEqual({ SERVICE_API_TOKEN: "SECRET_ENV_TOKEN_999" });

    // 3. Redacted renderer metadata never exposes URLs or secret values
    const redactedAcme = redactedServerMetadata(acme, acmeSecrets);
    expect(redactedAcme).toMatchObject({
      configuredInAria: true,
      configSource: "cli",
      transport: "http",
      enabled: true,
      hasAuthToken: true,
      headerKeys: ["Authorization", "X-Client-Name"],
      timeout: 45_000,
    });
    expect(JSON.stringify(redactedAcme)).not.toContain("tracker.example");
    expect(JSON.stringify(redactedAcme)).not.toContain("SECRET");
  });

  it("preserves 'aria'-customized servers on CLI re-import and only passes 'aria' or token-bearing servers in buildScopedSdkMcpServers (rubber duck #3)", () => {
    const store = new McpConfigStore();
    store.saveServer({
      name: "CustomAriaServer",
      transport: "http",
      url: "https://custom.example/mcp",
      bearerToken: "ARIA_TOKEN_1",
    });

    // Importing from CLI with a server of the same name skips the user's "aria" server
    const res = store.importFromCliJson(
      JSON.stringify({
        mcpServers: {
          CustomAriaServer: { type: "http", url: "https://cli-override.example/mcp" },
          AmbientCliOAuthServer: { type: "http", url: "https://ambient.example/mcp", oauthClientId: "cli-client" },
        },
      }),
    );
    expect(res.imported).toBe(1);
    expect(res.skipped).toBe(1);
    expect(store.getServer("CustomAriaServer")?.url).toBe("https://custom.example/mcp");
    expect(store.getServer("CustomAriaServer")?.source).toBe("aria");

    // Rubber duck #2: AmbientCliOAuthServer (imported from CLI without native tokens) has hasDirectAuth === false
    expect(store.hasDirectAuth("AmbientCliOAuthServer")).toBe(false);
    expect(store.hasDirectAuth("CustomAriaServer")).toBe(true);

    // Rubber duck #3: buildScopedSdkMcpServers omits AmbientCliOAuthServer so it doesn't shadow the CLI daemon's OAuth session,
    // and includes CustomAriaServer with its scoped tools and Authorization header.
    const scoped = buildScopedSdkMcpServers(store.getState(), store.secretStore, {
      allowedWireTools: [
        "mcp:CustomAriaServer-get_items",
        "mcp:AmbientCliOAuthServer-get_items",
      ],
    });
    expect(Object.keys(scoped)).toEqual(["CustomAriaServer"]);
    expect(scoped.CustomAriaServer).toEqual({
      type: "http",
      url: "https://custom.example/mcp",
      headers: { Authorization: "Bearer ARIA_TOKEN_1" },
      tools: ["get_items"],
    });

    // Once the user sets a direct bearer token on AmbientCliOAuthServer in ARIA, both direct auth and SDK session config include it
    store.setServerToken("AmbientCliOAuthServer", "DIRECT_TOKEN_2");
    expect(store.hasDirectAuth("AmbientCliOAuthServer")).toBe(true);
    const scopedWithToken = buildScopedSdkMcpServers(store.getState(), store.secretStore, {
      allowedWireTools: ["mcp:AmbientCliOAuthServer-get_items"],
    });
    expect(scopedWithToken.AmbientCliOAuthServer).toEqual({
      type: "http",
      url: "https://ambient.example/mcp",
      headers: { Authorization: "Bearer DIRECT_TOKEN_2" },
      tools: ["get_items"],
    });
  });
});

describe("Phase 7A: NativeMcpClient over InMemory, Stdio, Streamable HTTP, and SSE transports", () => {
  it("connects over InMemoryTransport for testServer (including the tracker's get_current_user) and callTool", async () => {
    let testConnectionCalled = false;
    const mcpServer = createTestMcpServer({
      tools: [
        { name: "get_current_user", description: "Verifies the token." },
        { name: "list_my_issues", description: "Gets tasks." },
        {
          name: "create_issues",
          description: "Creates tasks.",
          inputSchema: {
            type: "object",
            properties: { issuesJson: { type: "string" } },
            required: ["issuesJson"],
          },
        },
      ],
      onCallTool: async (name, args) => {
        if (name === "get_current_user") {
          testConnectionCalled = true;
          return { content: [{ type: "text", text: "Connection OK" }] };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ created: [{ ID: "300500" }], received: args }) }],
        };
      },
    });

    const client = new NativeMcpClient({
      tracker: () => acmeTracker,
      transportFactory: async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);
        return clientTransport;
      },
    });

    try {
      const probe = await client.testServer("Acme");
      expect(probe.ok).toBe(true);
      expect(probe.toolCount).toBe(3);
      expect(testConnectionCalled).toBe(true);
      expect(probe.tools.find((t) => t.name === "create_issues")?.inputSchema).toMatchObject({
        type: "object",
        required: ["issuesJson"],
      });

      const payload = { issuesJson: JSON.stringify([{ Title: "Ship Phase 7A" }]) };
      const outcome = await client.callTool({
        server: "Acme",
        tool: "create_issues",
        approvedArgs: payload,
      });
      expect(outcome).toEqual({
        ok: true,
        result: expect.stringContaining("300500"),
      });
    } finally {
      await client.stop();
      await mcpServer.close();
    }
  });

  it("spawns a local stdio MCP server process via StdioClientTransport, lists tools, calls a tool, and cleans up", async () => {
    const dir = makeTempDir();
    const serverScript = path.join(dir, "stdio-mcp-server.mjs");
    const sdkServerUrl = new URL("../../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js", import.meta.url).href;
    const sdkStdioUrl = new URL("../../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js", import.meta.url).href;
    const sdkTypesUrl = new URL("../../../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js", import.meta.url).href;

    writeFileSync(
      serverScript,
      `
import { Server } from ${JSON.stringify(sdkServerUrl)};
import { StdioServerTransport } from ${JSON.stringify(sdkStdioUrl)};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(sdkTypesUrl)};

const server = new Server({ name: "stdio-test", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "echo_env", description: "Echoes secret env", inputSchema: { type: "object", properties: { msg: { type: "string" } } } }]
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: "text", text: JSON.stringify({ msg: req.params.arguments?.msg, tokenPresent: Boolean(process.env.API_TOKEN) }) }]
}));
await server.connect(new StdioServerTransport());
`,
      "utf8",
    );

    const serverConfig: StoredMcpServerConfig = {
      name: "StdioEcho",
      transport: "stdio",
      enabled: true,
      source: "aria",
      command: process.execPath,
      args: [serverScript],
      updatedAt: Date.now(),
    };

    const client = new NativeMcpClient({ tracker: () => acmeTracker });
    try {
      const testRes = await client.testServer(serverConfig, { env: { API_TOKEN: "sec-123" } });
      expect(testRes.ok).toBe(true);
      expect(testRes.toolCount).toBe(1);
      expect(testRes.tools[0]?.name).toBe("echo_env");

      const callRes = await client.callTool({
        server: serverConfig,
        secrets: { env: { API_TOKEN: "sec-123" } },
        tool: "echo_env",
        approvedArgs: { msg: "hello stdio" },
      });
      expect(callRes.ok).toBe(true);
      if (callRes.ok) {
        expect(JSON.parse(callRes.result)).toEqual({ msg: "hello stdio", tokenPresent: true });
      }
    } finally {
      await client.stop();
    }
  });

  it("connects to loopback Streamable HTTP server with bearer token, detects 401 needs-auth, and falls back to SSE on 405", async () => {
    // 1. Streamable HTTP server requiring Bearer token
    let lastAuthHeader: string | undefined;
    const httpSrv = http.createServer(async (req, res) => {
      lastAuthHeader = req.headers.authorization;
      if (req.headers.authorization !== "Bearer VALID_TOKEN") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const mcp = createTestMcpServer();
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    });
    httpServers.push(httpSrv);
    await new Promise<void>((resolve) => httpSrv.listen(0, "127.0.0.1", resolve));
    const httpPort = (httpSrv.address() as AddressInfo).port;
    const httpUrl = `http://127.0.0.1:${httpPort}/mcp`;

    const needsAuthServers: string[] = [];
    const client = new NativeMcpClient({
      tracker: () => acmeTracker,
      onServerNeedsAuth: (name) => needsAuthServers.push(name),
    });

    const serverConfig: StoredMcpServerConfig = {
      name: "LoopbackHttp",
      transport: "http",
      enabled: true,
      source: "aria",
      url: httpUrl,
      updatedAt: Date.now(),
    };

    try {
      // Without token -> 401 needsAuth
      const unauthProbe = await client.testServer(serverConfig, { bearerToken: "WRONG_TOKEN" });
      expect(unauthProbe.ok).toBe(false);
      expect(unauthProbe.needsAuth).toBe(true);
      expect(needsAuthServers).toContain("LoopbackHttp");

      const unauthCall = await client.callTool({
        server: serverConfig,
        secrets: { bearerToken: "WRONG_TOKEN" },
        tool: "create_issues",
        approvedArgs: { issuesJson: "[]" },
      });
      expect(unauthCall).toMatchObject({
        ok: false,
        blocked: true,
        error: expect.stringMatching(/needs signing in or a bearer token/),
      });

      // With valid token -> succeeds
      const okProbe = await client.testServer(serverConfig, { bearerToken: "VALID_TOKEN" });
      expect(okProbe.ok).toBe(true);
      expect(okProbe.toolCount).toBe(2);
      expect(lastAuthHeader).toBe("Bearer VALID_TOKEN");

      const okCall = await client.callTool({
        server: serverConfig,
        secrets: { bearerToken: "VALID_TOKEN" },
        tool: "create_issues",
        approvedArgs: { issuesJson: JSON.stringify([{ Title: "HTTP task" }]) },
      });
      expect(okCall.ok).toBe(true);

      // Non-loopback plain http:// URL is refused before any network call
      const insecureCall = await client.callTool({
        server: { ...serverConfig, name: "InsecureRemote", url: "http://remote.example.com/mcp" },
        tool: "create_issues",
        approvedArgs: { issuesJson: "[]" },
      });
      expect(insecureCall).toMatchObject({
        ok: false,
        blocked: true,
        error: expect.stringMatching(/must use https:\/\//),
      });
    } finally {
      await client.stop();
    }

    // 2. Legacy SSE server that returns 405 to POST /sse (Streamable HTTP init) and accepts GET /sse + POST /messages
    const sseTransports = new Map<string, SSEServerTransport>();
    const sseHttpSrv = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (reqUrl.pathname === "/sse" && req.method === "POST") {
        // Reject Streamable HTTP POST so client falls back to SSE
        res.writeHead(405, { Allow: "GET" });
        res.end("Method Not Allowed");
        return;
      }
      if (reqUrl.pathname === "/sse" && req.method === "GET") {
        const transport = new SSEServerTransport("/messages", res);
        sseTransports.set(transport.sessionId, transport);
        const mcp = createTestMcpServer();
        await mcp.connect(transport);
        return;
      }
      if (reqUrl.pathname === "/messages" && req.method === "POST") {
        const sessionId = reqUrl.searchParams.get("sessionId") ?? "";
        const transport = sseTransports.get(sessionId);
        if (!transport) {
          res.writeHead(404);
          res.end();
          return;
        }
        await transport.handlePostMessage(req, res);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    httpServers.push(sseHttpSrv);
    await new Promise<void>((resolve) => sseHttpSrv.listen(0, "127.0.0.1", resolve));
    const ssePort = (sseHttpSrv.address() as AddressInfo).port;

    const sseFallbackClient = new NativeMcpClient({ tracker: () => acmeTracker });
    try {
      const sseFallbackProbe = await sseFallbackClient.testServer({
        name: "LegacySseServer",
        transport: "http", // Configured as "http", falls back automatically to SSE on 405!
        enabled: true,
        source: "aria",
        url: `http://127.0.0.1:${ssePort}/sse`,
        updatedAt: Date.now(),
      });
      expect(sseFallbackProbe.ok).toBe(true);
      expect(sseFallbackProbe.toolCount).toBe(2);
    } finally {
      await sseFallbackClient.stop();
      for (const t of sseTransports.values()) {
        await t.close().catch(() => {
          // Teardown: the client's stop may have closed it already.
        });
      }
    }
  });
});

describe("Phase 7A: Two-phase dispatch state machine in NativeMcpClient.callTool (rubber duck #4)", () => {
  it("returns blocked: true on pre-dispatch errors and omits blocked: true on in-flight errors after tools/call is sent", async () => {
    const abortInFlight = new AbortController();
    const mcpServer = createTestMcpServer({
      onCallTool: async () => {
        // Abort while the tool call is already in flight on the server
        abortInFlight.abort();
        await new Promise((r) => setTimeout(r, 200));
        return { content: [{ type: "text", text: "done" }] };
      },
    });

    const client = new NativeMcpClient({
      tracker: () => acmeTracker,
      transportFactory: async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);
        return clientTransport;
      },
    });

    try {
      // 1. Pre-dispatch validation error (bidi disguise character) -> blocked: true
      const preDispatch1 = await client.callTool({
        server: "Acme",
        tool: "create_issues",
        approvedArgs: { issuesJson: '[{"Title":"Bad\u202eTitle"}]' },
      });
      expect(preDispatch1.ok).toBe(false);
      if (!preDispatch1.ok) {
        expect(preDispatch1.blocked).toBe(true);
        expect(preDispatch1.error).toMatch(/Blocked by ARIA's exact-payload check/);
      }

      // 2. Pre-dispatch already-aborted signal -> blocked: true
      const preAborted = new AbortController();
      preAborted.abort();
      const preDispatch2 = await client.callTool({
        server: "Acme",
        tool: "create_issues",
        approvedArgs: { issuesJson: "[]" },
        signal: preAborted.signal,
      });
      expect(preDispatch2).toEqual({
        ok: false,
        error: "The action was cancelled.",
        blocked: true,
      });

      // 3. In-flight abort/interruption AFTER client.callTool was dispatched -> blocked is undefined!
      const inFlightRes = await client.callTool({
        server: "Acme",
        tool: "create_issues",
        approvedArgs: { issuesJson: "[]" },
        signal: abortInFlight.signal,
      });
      expect(inFlightRes.ok).toBe(false);
      if (!inFlightRes.ok) {
        expect(inFlightRes.blocked).toBeUndefined();
        expect(inFlightRes.error).toMatch(/The approved call was sent to Acme.*Check whether it went through/);
      }
    } finally {
      await client.stop();
      await mcpServer.close();
    }
  });
});

describe("Phase 7A: Zero-model execution in ActionRunner and AriaEngine (rubber duck #5)", () => {
  it("executes ActionRunner.executeApprovedMcpCall directly via mcpClient with no runtime or model configured", async () => {
    const receivedCalls: Array<{ name: string; args: unknown }> = [];
    const mcpServer = createTestMcpServer({
      tools: [
        {
          name: "delete_worklogs",
          inputSchema: {
            type: "object",
            properties: { ids: { type: "string" }, confirm: { type: "boolean" } },
            required: ["ids"],
            additionalProperties: false,
          },
        },
      ],
      onCallTool: async (name, args) => {
        receivedCalls.push({ name, args });
        return { content: [{ type: "text", text: JSON.stringify({ deleted: ["901"] }) }] };
      },
    });

    const mcpClient = new NativeMcpClient({
      tracker: () => acmeTracker,
      transportFactory: async () => {
        const [c, s] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(s);
        return c;
      },
    });

    const catalog = mergeCatalog(
      EMPTY_CATALOG,
      {
        servers: [{ name: "Acme", status: "connected", source: "aria" }],
        tools: [
          {
            name: "Acme-delete_worklogs",
            server: "Acme",
            tool: "delete_worklogs",
            inputSchema: {
              type: "object",
              properties: { ids: { type: "string" }, confirm: { type: "boolean" } },
              required: ["ids"],
              additionalProperties: false,
            },
          },
        ],
      },
      Date.now(),
    );

    const runner = new ActionRunner({
      tracker: () => acmeTracker,
      mcpClient,
      catalog: () => catalog,
      rules: () => [],
      runtimeReady: () => true,
      card: () => undefined,
      cards: () => [],
      saveCard: () => {},
      digest: () => {},
    });

    try {
      const { approvedArgs, outcome } = await runner.executeApprovedMcpCall({
        server: "Acme",
        tool: "delete_worklogs",
        args: { ids: "901" },
        confirmedDestructive: true,
        allowTimeLogTools: true,
      });
      expect(approvedArgs).toEqual({ ids: "901", confirm: true });
      expect(outcome).toEqual({ ok: true, result: JSON.stringify({ deleted: ["901"] }) });
      expect(receivedCalls).toEqual([{ name: "delete_worklogs", args: { ids: "901", confirm: true } }]);
    } finally {
      await runner.stop();
      await mcpClient.stop();
      await mcpServer.close();
    }
  });

  it("wires CLI import, keepInSync, testMcpServer, and zero-model action & timesheet execution in AriaEngine", async () => {
    const dir = makeTempDir();
    const cliConfigPath = path.join(dir, "mcp-config.json");

    const directCalls: Array<{ name: string; args: Record<string, unknown> | undefined }> = [];
    const mcpServer = createTestMcpServer({
      tools: [
        { name: "get_current_user", description: "Checks the connection." },
        { name: "list_my_issues", description: "Reads issues." },
        { name: "get_issues", description: "Reads issues by key." },
        { name: "list_worklogs", description: "Reads worklogs." },
        {
          name: "create_issues",
          description: "Creates issues.",
          inputSchema: {
            type: "object",
            properties: { issuesJson: { type: "string" } },
            required: ["issuesJson"],
            additionalProperties: false,
          },
        },
        {
          name: "add_worklogs",
          description: "Registers worklogs.",
          inputSchema: {
            type: "object",
            properties: { worklogs: { type: "array" } },
            required: ["worklogs"],
            additionalProperties: false,
          },
        },
      ],
      onCallTool: async (name, args) => {
        directCalls.push({ name, args });
        if (name === "list_worklogs") {
          const existing = acmeWorklogs("2026-10-26", [{ id: "77001", issueKey: "ACME-101", issueSummary: "Morning Standup", start: "09:00", end: "10:00", comment: "Existing worklog" }]);
          return { content: [{ type: "text", text: JSON.stringify(existing) }] };
        }
        if (name === "get_issues") {
          return { content: [{ type: "text", text: JSON.stringify(acmeIssues(acmeIssue("ACME-123", "Native MCP Client", ACME_LEDGER))) }] };
        }
        if (name === "add_worklogs") {
          const rows = (args?.worklogs ?? []) as unknown[];
          return { content: [{ type: "text", text: JSON.stringify(acmeCreated(rows.map((_, index) => String(9_500_000 + index)))) }] };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, tool: name, received: args }) }],
        };
      },
    });

    writeFileSync(
      cliConfigPath,
      JSON.stringify({
        mcpServers: {
          Acme: {
            type: "http",
            url: "https://tracker.example/mcp?key=CLI_SECRET_KEY",
          },
        },
        pluginDirectories: [path.join(dir, "plugins", "workiq")],
      }),
      "utf8",
    );

    const runtime = new FakeRuntime();
    runtime.inventoryResult = {
      servers: [{ name: "Acme", status: "connected", source: "user", url: "https://tracker.example/mcp" }],
      tools: [{ name: "Acme-list_my_issues", server: "Acme", tool: "list_my_issues" }],
    };

    const engine = new AriaEngine({
      dataDir: path.join(dir, "data"),
      runtime,
      projectRoots: [],
      tracker: acmeTracker,
      cliMcpConfigPath: cliConfigPath,
      mcpTransportFactory: async () => {
        const [c, s] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(s);
        return c;
      },
    });
    engines.push(engine);
    await engine.start();

    // 1. Import from Copilot CLI and enable Keep in sync
    const importRes = await engine.importCliMcp();
    expect(importRes.imported).toBe(1);
    expect(importRes.state.configuredServerCount).toBe(1);
    expect(importRes.state.pluginDirectories).toEqual([path.join(dir, "plugins", "workiq")]);

    const syncedState = await engine.setMcpKeepInSync({ keepInSync: true });
    expect(syncedState.keepInSync).toBe(true);

    // 2. Test server via built-in MCP client -> discovers all 6 tools and schemas
    const testResult = await engine.testMcpServer({ server: "Acme" });
    expect(testResult.status).toBe("ok");
    expect(testResult.toolCount).toBe(6);
    expect(engine.getState().integrations.tools.filter((t) => t.server === "Acme")).toHaveLength(6);

    // 3. Propose and confirm an action card -> executes directly via NativeMcpClient with zero runtime action sessions!
    runtime.replies.push({
      toolCalls: [
        {
          name: "request_action",
          args: {
            server: "Acme",
            tool: "create_issues",
            title: "Create Phase 7A task",
            args: { issuesJson: JSON.stringify([{ Title: "Phase 7A" }]) },
          },
        },
      ],
      text: "Proposed A-1.",
    });
    await engine.sendMessage("create phase 7a task");
    await new Promise((r) => setTimeout(r, 30));

    const actionCard = engine.getState().timeline.find((i) => i.kind === "card" && i.cardType === "action_request")!;
    if (actionCard.kind !== "card" || actionCard.cardType !== "action_request") throw new Error("missing card");
    await engine.confirmAction({ cardId: actionCard.id, revision: actionCard.payload.revision });

    // Zero FakeRuntime.runMcpAction calls — went directly to NativeMcpClient!
    expect(runtime.actionCalls).toHaveLength(0);
    expect(directCalls.some((c) => c.name === "create_issues")).toBe(true);

    // 4. Add a timesheet row for uncached task ACME-123 and submit -> refreshTrackerDataForDate fetches
    //    list_worklogs (catching the 09:00–10:00 registered worklog) and get_issues (resolving its project LED and
    //    account ACC7), then submits 10:00–12:00 via NativeMcpClient with zero model sessions!
    engine.updateTimesheetEntry({
      date: "2026-10-26",
      start: "10:00",
      end: "12:00",
      trackerTaskId: "ACME-123",
      comment: "Built NativeMcpClient",
    });

    const submitted = await engine.submitTimesheet("2026-10-26");
    expect(submitted.status).toBe("registered");
    expect(submitted.entries[0]?.trackerEntryId).toBe("9500000");
    expect(runtime.actionCalls).toHaveLength(0);
    expect(directCalls.map((c) => c.name)).toContain("list_worklogs");
    expect(directCalls.map((c) => c.name)).toContain("get_issues");
    expect(directCalls.map((c) => c.name)).toContain("add_worklogs");
    const dateRangeCall = directCalls.find((c) => c.name === "list_worklogs");
    expect(dateRangeCall?.args).toEqual({ from: "2026-10-26", to: "2026-10-27" });

    await mcpServer.close();
  });

  it("enforces configured tools filter in callTool and testServer", async () => {
    const mcpServer = createTestMcpServer({
      tools: [
        { name: "allowed_tool", inputSchema: { type: "object", properties: {} } },
        { name: "forbidden_tool", inputSchema: { type: "object", properties: {} } },
      ],
    });

    const mcpClient = new NativeMcpClient({
      tracker: () => acmeTracker,
      transportFactory: async () => {
        const [c, s] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(s);
        return c;
      },
    });

    try {
      const probe = await mcpClient.testServer({
        name: "FilteredTest",
        transport: "stdio",
        enabled: true,
        source: "aria",
        tools: ["allowed_tool"],
        updatedAt: Date.now(),
      });
      expect(probe.ok).toBe(true);
      expect(probe.tools.map((t) => t.name)).toEqual(["allowed_tool"]);

      const rejectedCall = await mcpClient.callTool({
        server: {
          name: "FilteredTest",
          transport: "stdio",
          enabled: true,
          source: "aria",
          tools: ["allowed_tool"],
          updatedAt: Date.now(),
        },
        tool: "forbidden_tool",
        approvedArgs: {},
      });
      expect(rejectedCall).toMatchObject({
        ok: false,
        blocked: true,
        error: expect.stringMatching(/not allowed by "FilteredTest"'s configured tools filter/),
      });
    } finally {
      await mcpClient.stop();
      await mcpServer.close();
    }
  });

  it("clears saved bearer token when imported server URL changes", () => {
    const secretStore = createMemoryMcpSecretStore();
    secretStore.setServerSecrets("RemoteApi", { bearerToken: "SECRET_TOKEN", fullUrl: "https://api.old.example/mcp" });

    const initialConfig = {
      mcpServers: {
        RemoteApi: {
          type: "http",
          url: "https://api.old.example/mcp",
        },
      },
    };
    const parsed1 = parseCliMcpConfigJson(JSON.stringify(initialConfig));
    const res1 = importCliMcpConfig(undefined, parsed1, secretStore);
    expect(res1.imported).toBe(1);
    expect(secretStore.getServerSecrets("RemoteApi")?.bearerToken).toBe("SECRET_TOKEN");

    // Endpoint URL changes in CLI config
    const updatedConfig = {
      mcpServers: {
        RemoteApi: {
          type: "http",
          url: "https://api.new.example/mcp",
        },
      },
    };
    const parsed2 = parseCliMcpConfigJson(JSON.stringify(updatedConfig));
    const res2 = importCliMcpConfig(res1.state, parsed2, secretStore);
    expect(res2.updated).toBe(1);
    // Token is cleared because endpoint changed!
    expect(secretStore.getServerSecrets("RemoteApi")?.bearerToken).toBeUndefined();
  });
});
