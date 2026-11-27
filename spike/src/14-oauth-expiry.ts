/**
 * Phase 3 Part B · 14 an expired sign-in (no model calls, no real servers, no browser).
 * PLAN.md §10 Phase 9, Integrations question 6: is a server whose token expired reported as `needs-auth`, or as
 * `failed` with an error? Also, with the same server: question 7 for a `needs-auth` server (its url), and the first half
 * of question 3 (does `session.mcp_server_status_changed` arrive on the session that signed in).
 *
 * The server is a local mock behind OAuth (lib/mock-oauth-mcp.ts) that approves every sign-in at once; the probe
 * follows the sign-in page's redirect itself. Tokens stay in memory (`mcpOAuthTokenStorage: "in-memory"`), so nothing
 * reaches the OS keychain, and every real server is disabled. Sign-in and status calls are made as ARIA makes them
 * (runtime.signIn: `mcp.oauth.login` without forceReauth).
 *
 *   npx tsx src/14-oauth-expiry.ts
 */
import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";
import { createRunLog, eventPrinter } from "./lib/log.ts";
import { startMockOAuthServer } from "./lib/mock-oauth-mcp.ts";
import { realServerNames } from "./lib/policy.ts";
import { sleep, startClient, stopClient } from "./lib/runtime.ts";

const SERVER = "aria-spike-oauth";
const log = createRunLog("14-oauth-expiry");
const mock = await startMockOAuthServer();
const client = await startClient();
const sessions: string[] = [];
const summary: Array<{ step: string; status: string; url: boolean; error?: string; events: string; requests: string }> = [];

const QUIET = new Set(["session.mcp_server_status_changed", "session.mcp_servers_loaded", "mcp.oauth_required", "mcp.oauth_completed", "session.mcp_server_needs_reconnect", "session.tools_updated", "session.info", "session.warning", "session.error"]);

async function open(label: string, events: SessionEvent[]): Promise<CopilotSession> {
  const print = eventPrinter(log, label);
  const session = await client.createSession({
    clientName: "aria-spike",
    mcpOAuthTokenStorage: "in-memory",
    disabledMcpServers: await realServerNames(client),
    mcpServers: { [SERVER]: { type: "http", url: mock.url, tools: ["*"] } },
    onPermissionRequest: () => ({ kind: "reject", feedback: "Inspection only." }),
    onEvent: (e) => {
      events.push(e);
      if (QUIET.has(e.type)) print(e);
      else log.record(`event:${label}`, e);
    },
  });
  sessions.push(session.sessionId);
  return session;
}

async function serverStatus(session: CopilotSession) {
  return (await session.rpc.mcp.list()).servers.find((s) => s.name === SERVER);
}

/** Waits until the server leaves `pending` (and stays out of it for a second), or the timeout. */
async function settle(session: CopilotSession, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = await serverStatus(session);
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await sleep(250);
    const now = await serverStatus(session);
    if (now?.status !== last?.status) stableSince = Date.now();
    last = now;
    if (last && last.status !== "pending" && Date.now() - stableSince >= 1000) break;
  }
  return last;
}

/** Records one step: the server's status, its url, and what happened since the marks. */
async function record(step: string, session: CopilotSession, events: SessionEvent[], eventMark: number, requestMark: number) {
  const status = await settle(session);
  const newEvents = events.slice(eventMark).filter((e) => QUIET.has(e.type));
  const eventText = newEvents
    .map((e) => {
      if (e.type === "session.mcp_server_status_changed") return `status_changed ${e.data.status}${e.data.errorClassification ? `/${e.data.errorClassification}` : ""}`;
      if (e.type === "mcp.oauth_required") return `oauth_required(${e.data.reason})`;
      if (e.type === "session.mcp_servers_loaded") return `servers_loaded ${e.data.servers.find((s) => s.name === SERVER)?.status ?? "?"}`;
      return e.type;
    })
    .join(", ");
  const requestText = mock.requests
    .slice(requestMark)
    .map((r) => `${r.route} ${r.status}${r.note ? ` (${r.note})` : ""}`)
    .join("; ");
  let probe: unknown;
  try {
    probe = await session.rpc.mcp.oauth.probe({ serverName: SERVER });
  } catch (error) {
    probe = `probe failed: ${(error as Error).message}`;
  }
  const row = { step, status: String(status?.status ?? "(not listed)"), url: Boolean(status?.url), ...(status?.error ? { error: status.error } : {}), events: eventText || "-", requests: requestText || "-" };
  summary.push(row);
  log.section(step, { ...row, probe, server: status });
  console.log(`${step}: ${row.status}${row.error ? ` (${row.error})` : ""}; url ${row.url ? "yes" : "no"}`);
  console.log(`  events: ${row.events}`);
  console.log(`  mock: ${row.requests}`);
  console.log(`  oauth.probe: ${JSON.stringify(probe)}`);
}

/** ARIA's Sign in (runtime.signIn): login, then the page. The mock approves at once, so the probe follows its redirect. */
async function signIn(session: CopilotSession): Promise<string> {
  const result = await session.rpc.mcp.oauth.login({ serverName: SERVER, clientName: "ARIA (spike 14)", callbackSuccessMessage: "Spike 14: signed in." });
  log.record("login result", { ...result, authorizationUrl: result.authorizationUrl ? "(present)" : undefined });
  if (!result.authorizationUrl) return `no page (login result ${JSON.stringify({ ...result })}; server now ${(await serverStatus(session))?.status})`;
  const page = await fetch(result.authorizationUrl, { redirect: "manual" });
  const callback = page.headers.get("location");
  if (!callback) return `the sign-in page didn't redirect (${page.status})`;
  const done = await fetch(callback);
  return `page → ${new URL(callback).host} callback ${done.status}`;
}

/** Reconnects the server (as a new session or a resume would connect it); the runtime may refuse with an error. */
async function restart(session: CopilotSession) {
  try {
    await session.rpc.mcp.restartServer({ serverName: SERVER });
    console.log("  restartServer: ok");
  } catch (error) {
    console.log(`  restartServer refused: ${(error as Error).message}`);
    log.record("restartServer error", (error as Error).message);
  }
}

try {
  log.info(`mock server at ${mock.url}`);

  // 0. ARIA's Sign in calls login right after createSession (runtime.signIn). Spike 16 got "MCP host is not
  // available on this session" doing that, so: login at once, then again once the session's servers have loaded.
  const events0: SessionEvent[] = [];
  const zero = await open("0", events0);
  for (const when of ["right after createSession", "after the servers loaded"]) {
    if (when !== "right after createSession") await settle(zero);
    try {
      const result = await zero.rpc.mcp.oauth.login({ serverName: SERVER, clientName: "ARIA (spike 14)" });
      console.log(`0 login ${when}: ok (${result.authorizationUrl ? "a page" : "no page"})`);
      summary.push({ step: `0 login ${when}`, status: "ok", url: true, events: "-", requests: "-" });
    } catch (error) {
      console.log(`0 login ${when}: ${(error as Error).message}`);
      summary.push({ step: `0 login ${when}`, status: "error", url: false, error: (error as Error).message, events: "-", requests: "-" });
    }
  }
  await client.deleteSession(zero.sessionId).catch(() => {});

  const eventsA: SessionEvent[] = [];
  const a = await open("A", eventsA);

  // 1. Never signed in.
  await record("1 new, never signed in", a, eventsA, 0, 0);

  // 2. Sign in from this session (the mock approves at once).
  let e = eventsA.length;
  let r = mock.requests.length;
  console.log(`sign-in: ${await signIn(a)}`);
  await record("2 after sign-in", a, eventsA, e, r);
  const listed = async () => (await a.rpc.tools.getCurrentMetadata()).tools?.filter((t) => t.mcpServerName === SERVER).map((t) => t.mcpToolName) ?? [];
  console.log(`  tools listed: ${(await listed()).join(", ") || "none"}`);
  await a.rpc.tools.initializeAndValidate();
  console.log(`  tools listed after tools.initializeAndValidate: ${(await listed()).join(", ") || "none"}`);

  // 3. Another session of the same runtime (in-memory tokens).
  const eventsB: SessionEvent[] = [];
  const b = await open("B", eventsB);
  await record("3 another session, same runtime", b, eventsB, 0, mock.requests.length);

  // 4. The access token stops working at the server; refreshing still works.
  mock.rejectAccessTokens();
  e = eventsA.length;
  r = mock.requests.length;
  await restart(a);
  await record("4 token rejected, refresh works, restart", a, eventsA, e, r);

  // 5. The access token stops working and the refresh token is refused too.
  mock.rejectAccessTokens();
  mock.refuseRefresh(true);
  e = eventsA.length;
  r = mock.requests.length;
  await restart(a);
  await record("5 token rejected, refresh refused, restart", a, eventsA, e, r);

  // 6. Signing in again from there, as ARIA's Sign in would (login without forceReauth), the refresh token still
  // refused. ARIA counts a login without a page as connected (runtime.signIn).
  e = eventsA.length;
  r = mock.requests.length;
  console.log(`sign-in again, refresh still refused: ${await signIn(a)}`);
  await record("6 sign-in again (refresh refused)", a, eventsA, e, r);
  if ((await serverStatus(a))?.status !== "connected") {
    e = eventsA.length;
    r = mock.requests.length;
    const result = await a.rpc.mcp.oauth.login({ serverName: SERVER, forceReauth: true, clientName: "ARIA (spike 14)" });
    console.log(`sign-in with forceReauth: ${result.authorizationUrl ? "page" : `no page (status ${result.status ?? "-"})`}`);
    if (result.authorizationUrl) {
      const callback = (await fetch(result.authorizationUrl, { redirect: "manual" })).headers.get("location");
      if (callback) await fetch(callback);
    }
    await record("6b sign-in with forceReauth", a, eventsA, e, r);
  }

  // 6c. Signing in again when a refresh would work: the runtime refreshes instead of showing a page.
  mock.rejectAccessTokens();
  mock.refuseRefresh(false);
  await restart(a);
  await settle(a);
  e = eventsA.length;
  r = mock.requests.length;
  console.log(`sign-in again, refresh works: ${await signIn(a)}`);
  await record("6c sign-in again (refresh works)", a, eventsA, e, r);

  // 7. A token that expires by its lifetime (the runtime knows when), refresh refused.
  mock.setAccessTtl(3);
  mock.rejectAccessTokens();
  mock.refuseRefresh(false);
  await restart(a); // refresh works: a token with a 3 s lifetime
  await settle(a);
  await sleep(5000);
  mock.refuseRefresh(true);
  e = eventsA.length;
  r = mock.requests.length;
  await restart(a);
  await record("7 token past its lifetime, refresh refused, restart", a, eventsA, e, r);

  log.section("summary", summary);
  console.table(summary.map((s) => ({ step: s.step, status: s.status, url: s.url, error: s.error?.slice(0, 70) ?? "" })));
} finally {
  for (const id of sessions) await client.deleteSession(id).catch(() => {});
  await stopClient(client);
  await mock.close();
  await log.close();
}
