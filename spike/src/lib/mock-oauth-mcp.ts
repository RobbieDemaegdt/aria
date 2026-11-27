/**
 * A local MCP server behind OAuth, for spike 14 (how the runtime reports a server whose token expired). Everything
 * runs on 127.0.0.1 in the spike's own process: the protected resource metadata, an authorization server with dynamic
 * client registration and PKCE, an authorize endpoint that approves at once (no browser, no account), a token
 * endpoint (authorization code and refresh token grants), and the MCP endpoint itself (Streamable HTTP, stateless,
 * one read tool). The probe can then make the server reject its access tokens and refuse refreshes.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface MockOAuthServer {
  /** The MCP endpoint, for a session's `mcpServers` config. */
  readonly url: string;
  /** Requests so far, in order: route and status (no tokens). */
  readonly requests: Array<{ route: string; status: number; note?: string }>;
  /** Every access token issued so far stops working (as if it expired or was revoked at the server). */
  rejectAccessTokens(): void;
  /** Refresh token grants fail with invalid_grant from now on (as if the refresh token expired too). */
  refuseRefresh(refuse: boolean): void;
  /** Lifetime of access tokens issued from now on. */
  setAccessTtl(seconds: number): void;
  close(): Promise<void>;
}

const base64url = (buffer: Buffer) => buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(value));
}

export async function startMockOAuthServer(): Promise<MockOAuthServer> {
  const requests: MockOAuthServer["requests"] = [];
  const access = new Map<string, number>(); // token → expiry (epoch ms)
  const refresh = new Set<string>();
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  let refuse = false;
  let ttl = 3600;
  let origin = "";

  const issue = () => {
    const accessToken = `mock-at-${randomUUID()}`;
    const refreshToken = `mock-rt-${randomUUID()}`;
    access.set(accessToken, Date.now() + ttl * 1000);
    refresh.add(refreshToken);
    return { access_token: accessToken, token_type: "Bearer", expires_in: ttl, refresh_token: refreshToken, scope: "mcp" };
  };

  const mcp = async (req: IncomingMessage, res: ServerResponse, route: string) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const expiry = token ? access.get(token) : undefined;
    const metadata = `${origin}/.well-known/oauth-protected-resource/mcp`;
    if (!token || expiry === undefined || expiry < Date.now()) {
      const note = !token ? "no token" : expiry === undefined ? "token rejected" : "token expired";
      requests.push({ route, status: 401, note });
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": token ? `Bearer error="invalid_token", error_description="${note}", resource_metadata="${metadata}"` : `Bearer resource_metadata="${metadata}"`,
      });
      res.end(JSON.stringify({ error: token ? "invalid_token" : "unauthorized" }));
      return;
    }
    if (req.method !== "POST") {
      requests.push({ route, status: 405 });
      json(res, 405, { error: "method not allowed" }, { Allow: "POST" });
      return;
    }
    requests.push({ route, status: 200 });
    const server = new Server({ name: "aria-mock-oauth", version: "0.0.1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "get_probe_value", description: "[MOCK] Returns a fixed value.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "42" }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    const text = await body(req);
    await transport.handleRequest(req, res, text ? JSON.parse(text) : undefined);
  };

  const http = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", origin);
      const route = `${req.method} ${url.pathname}`;
      try {
        if (url.pathname === "/mcp") return await mcp(req, res, route);
        if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
          requests.push({ route, status: 200 });
          return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["mcp"], bearer_methods_supported: ["header"] });
        }
        if (url.pathname.startsWith("/.well-known/oauth-authorization-server") || url.pathname.startsWith("/.well-known/openid-configuration")) {
          requests.push({ route, status: 200 });
          return json(res, 200, {
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            scopes_supported: ["mcp"],
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          });
        }
        if (url.pathname === "/register" && req.method === "POST") {
          const registration = JSON.parse((await body(req)) || "{}") as Record<string, unknown>;
          requests.push({ route, status: 201 });
          return json(res, 201, {
            ...registration,
            client_id: `mock-client-${randomUUID()}`,
            client_id_issued_at: Math.floor(Date.now() / 1000),
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
          });
        }
        if (url.pathname === "/authorize") {
          // Approves at once: no page, no account. The redirect goes to the runtime's loopback callback.
          const redirectUri = url.searchParams.get("redirect_uri") ?? "";
          const challenge = url.searchParams.get("code_challenge") ?? "";
          const code = `mock-code-${randomUUID()}`;
          codes.set(code, { challenge, redirectUri });
          const target = new URL(redirectUri);
          target.searchParams.set("code", code);
          const state = url.searchParams.get("state");
          if (state) target.searchParams.set("state", state);
          requests.push({ route, status: 302, note: `redirect to ${target.host}` });
          res.writeHead(302, { Location: target.toString() });
          return res.end();
        }
        if (url.pathname === "/token" && req.method === "POST") {
          const text = await body(req);
          const form = (req.headers["content-type"] ?? "").includes("json") ? new URLSearchParams(JSON.parse(text) as Record<string, string>) : new URLSearchParams(text);
          const grant = form.get("grant_type");
          if (grant === "authorization_code") {
            const entry = codes.get(form.get("code") ?? "");
            const verifier = form.get("code_verifier") ?? "";
            codes.delete(form.get("code") ?? "");
            if (!entry || base64url(createHash("sha256").update(verifier).digest()) !== entry.challenge) {
              requests.push({ route, status: 400, note: "authorization_code: invalid_grant" });
              return json(res, 400, { error: "invalid_grant" });
            }
            requests.push({ route, status: 200, note: "authorization_code" });
            return json(res, 200, issue());
          }
          if (grant === "refresh_token") {
            const token = form.get("refresh_token") ?? "";
            if (refuse || !refresh.has(token)) {
              requests.push({ route, status: 400, note: "refresh_token: invalid_grant" });
              return json(res, 400, { error: "invalid_grant", error_description: "The refresh token expired." });
            }
            refresh.delete(token);
            requests.push({ route, status: 200, note: "refresh_token" });
            return json(res, 200, issue());
          }
          requests.push({ route, status: 400, note: `unsupported grant ${grant}` });
          return json(res, 400, { error: "unsupported_grant_type" });
        }
        requests.push({ route, status: 404 });
        return json(res, 404, { error: "not found" });
      } catch (error) {
        requests.push({ route, status: 500, note: (error as Error).message });
        if (!res.headersSent) json(res, 500, { error: "server_error" });
      }
    })();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return {
    url: `${origin}/mcp`,
    requests,
    rejectAccessTokens: () => access.clear(),
    refuseRefresh: (value) => {
      refuse = value;
    },
    setAccessTtl: (seconds) => {
      ttl = seconds;
    },
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
