/**
 * Phase 3 Part B · 16 Sign in from a short-lived session (no model calls; needs your sign-in in the browser once).
 * PLAN.md §10 Phase 9, Integrations questions:
 *   2. does Sign in from a short-lived session of its own work for Work IQ (plugin-provided; an owned installation goes
 *      through prepareLogin);
 *   3. does session.mcp_server_status_changed arrive on that session, and does the token then reach the other
 *      sessions (one already open, a new one, one in a new runtime process: ARIA's, the tasks', after a restart).
 *
 * The sign-in is made as ARIA makes it (runtime.signIn): a session of its own with persistent token storage,
 * `mcp.oauth.login` (or prepareLogin + login for an owned installation), the page opened in your browser, then the
 * session's status events. The token is stored in the OS keychain, as with ARIA's own Sign in. No tool is called and
 * nothing is sent to a model; every session is deleted at the end.
 *
 *   npx tsx src/16-signin.ts [--server workiq]
 *   npx tsx src/16-signin.ts --server workiq --timing   # when login works after createSession (a connected server: no page)
 *   npx tsx src/16-signin.ts --server "Work IQ Mail" --url-check   # the page's client_session vs the session id (not opened)
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { CopilotClient, CopilotSession, SessionEvent } from "@github/copilot-sdk";
import { createRunLog } from "./lib/log.ts";
import { argValue, hasFlag, sleep, startClient, stopClient } from "./lib/runtime.ts";

const SERVER = argValue("--server") ?? "workiq";
const log = createRunLog("16-signin");
const opened: Array<{ client: CopilotClient; id: string }> = [];

async function open(client: CopilotClient, label: string, events: SessionEvent[] = [], sessionId?: string): Promise<CopilotSession> {
  const session = await client.createSession({
    ...(sessionId ? { sessionId } : {}),
    clientName: "aria-spike",
    mcpOAuthTokenStorage: "persistent",
    onPermissionRequest: () => ({ kind: "reject", feedback: "Sign-in check only." }),
    onEvent: (e) => {
      events.push(e);
      if (e.type.startsWith("session.mcp") || e.type.startsWith("mcp.")) log.record(`event:${label}`, e);
    },
  });
  opened.push({ client, id: session.sessionId });
  return session;
}

async function state(session: CopilotSession, settleMs = 30_000) {
  const deadline = Date.now() + settleMs;
  let server = (await session.rpc.mcp.list()).servers.find((s) => s.name === SERVER);
  while (server?.status === "pending" && Date.now() < deadline) {
    await sleep(250);
    server = (await session.rpc.mcp.list()).servers.find((s) => s.name === SERVER);
  }
  await session.rpc.tools.initializeAndValidate();
  const tools = ((await session.rpc.tools.getCurrentMetadata()).tools ?? []).filter((t) => t.mcpServerName === SERVER).length;
  return { status: String(server?.status ?? "(not listed)"), tools, ...(server?.error ? { error: server.error } : {}), installationId: server?.owned?.installationId };
}

const statusEvents = (events: SessionEvent[]) =>
  events
    .filter((e) => e.type === "session.mcp_server_status_changed" && e.data.serverName === SERVER)
    .map((e) => (e.type === "session.mcp_server_status_changed" ? e.data.status : ""))
    .join(" → ");

const client = await startClient();
try {
  if (hasFlag("--url-check")) {
    // Microsoft refused ARIA's sign-in page: "client_session … must be 20-50 characters" (AADSTS901001). Is it the
    // session's id? The page is asked for and read, never opened (a needs-auth server; nothing signs in).
    for (const sessionId of [`aria-spike-16-${Date.now()}`, `aria-integrations-${randomUUID()}`]) {
      const s = await open(client, "U", [], sessionId);
      await state(s);
      try {
        const result = await s.rpc.mcp.oauth.login({ serverName: SERVER, clientName: "ARIA (spike 16)" });
        if (!result.authorizationUrl) {
          console.log(`${sessionId.length}-character session id: no page (the server is connected)`);
          continue;
        }
        const params = new URL(result.authorizationUrl).searchParams;
        const cs = params.get("client_session");
        console.log(
          `${sessionId.length}-character session id: page on ${new URL(result.authorizationUrl).host}; client_session ${cs === null ? "absent" : `${cs.length} characters, ${cs === sessionId ? "= the session id" : "not the session id"}, ${/^[A-Za-z0-9._~-]{20,50}$/.test(cs) ? "valid" : "INVALID"} for Microsoft`}; parameters: ${[...params.keys()].join(", ")}`,
        );
      } catch (error) {
        console.log(`${sessionId.length}-character session id: ${(error as Error).message}`);
      }
    }
  } else if (hasFlag("--timing")) {
    // When does login stop failing with "MCP host is not available on this session"? For a connected server, login
    // returns no page (a stored token), so this needs no sign-in. Fresh sessions, each waiting differently first.
    const waits: Array<[string, (s: CopilotSession) => Promise<void>]> = [
      ["at once", async () => {}],
      ["after mcp.list has the server out of pending", async (s) => {
        for (let i = 0; i < 120; i++) {
          const server = (await s.rpc.mcp.list()).servers.find((x) => x.name === SERVER);
          if (server && server.status !== "pending") return;
          await sleep(250);
        }
      }],
      ["after tools.initializeAndValidate only", async (s) => void (await s.rpc.tools.initializeAndValidate())],
      ["after a 2 s pause only", async () => sleep(2000)],
    ];
    for (const [label, wait] of waits) {
      const s = await open(client, `T ${label}`);
      const started = Date.now();
      await wait(s);
      const waited = Date.now() - started;
      try {
        const result = await s.rpc.mcp.oauth.login({ serverName: SERVER, clientName: "ARIA (spike 16)" });
        console.log(`login ${label} (${waited} ms): ok, ${result.authorizationUrl ? "a page (not opened)" : "no page"}`);
      } catch (error) {
        console.log(`login ${label} (${waited} ms): ${(error as Error).message}`);
      }
    }
    process.exitCode = 0;
  } else {
  // P: a session that's already open when you sign in (like ARIA's own, or a running task's).
  const eventsP: SessionEvent[] = [];
  const p = await open(client, "P", eventsP);
  const before = await state(p);
  log.section("before", before);
  console.log(`before: ${SERVER}=${before.status}, ${before.tools} tools${before.installationId ? `, owned installation ${before.installationId}` : ""}`);
  if (before.status === "(not listed)") throw new Error(`${SERVER} isn't in your Copilot CLI setup`);
  if (before.status === "connected") console.log("already connected: the sign-in below may finish without a page (a stored token).");

  // S: ARIA's sign-in session.
  const eventsS: SessionEvent[] = [];
  const s = await open(client, "S", eventsS, `aria-spike-16-signin-${Date.now()}`);
  const texts = { clientName: "ARIA (spike 16)", callbackSuccessMessage: "ARIA spike 16: signed in. You can close this tab." };
  let loginId: string | undefined;
  if (before.installationId) {
    loginId = (await s.rpc.mcp.oauth.prepareLogin({ serverName: SERVER, expectedInstallationId: before.installationId, ...texts })).loginId;
    console.log("owned installation: prepareLogin returned a login handle");
  }
  // ARIA calls login right after createSession (runtime.signIn). A first run got "MCP host is not available on this
  // session" doing that: if so, it's recorded, and login is tried again once the session's servers have loaded.
  const login = () => s.rpc.mcp.oauth.login(before.installationId && loginId ? { serverName: SERVER, loginId, expectedInstallationId: before.installationId } : { serverName: SERVER, ...texts });
  let result: Awaited<ReturnType<typeof login>>;
  try {
    result = await login();
    console.log("login right after createSession: ok");
  } catch (error) {
    console.log(`login right after createSession failed: ${(error as Error).message}`);
    log.record("login at once", (error as Error).message);
    const loaded = Date.now();
    await state(s);
    console.log(`  the session's servers loaded in ${Date.now() - loaded} ms; trying again`);
    result = await login();
    console.log("login after the servers loaded: ok");
  }
  log.section("login", { status: result.status, page: result.authorizationUrl ? new URL(result.authorizationUrl).host : undefined });
  const started = Date.now();
  if (result.authorizationUrl) {
    const page = new URL(result.authorizationUrl);
    console.log(`\n>>> Sign in in your browser (${page.host}). Waiting up to 5 minutes…\n    If no browser opened, open this address yourself:\n    ${result.authorizationUrl}\n`);
    if (page.protocol === "https:") execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Start-Process '${result.authorizationUrl.replace(/'/g, "''")}'`], { windowsHide: true }, () => {});
  } else {
    console.log(`login returned no page (status ${result.status ?? "-"}): a stored token was used.`);
  }
  let outcome = "timed out";
  while (Date.now() - started < 300_000) {
    const event = eventsS.find((e) => e.type === "session.mcp_server_status_changed" && e.data.serverName === SERVER && (e.data.status === "connected" || e.data.status === "failed"));
    if (event && event.type === "session.mcp_server_status_changed") {
      outcome = `${event.data.status}${event.data.error ? ` (${event.data.error})` : ""}`;
      break;
    }
    await sleep(500);
  }
  const afterS = await state(s);
  console.log(`S (the sign-in session): status events ${statusEvents(eventsS) || "none"}; outcome ${outcome}; now ${afterS.status}, ${afterS.tools} tools`);

  // The token elsewhere: the session that was already open, a new one, and one in a new runtime process.
  const rows: Array<Record<string, unknown>> = [{ session: "S sign-in session", events: statusEvents(eventsS) || "-", ...afterS }];
  for (const wait of [0, 10_000]) {
    if (wait) await sleep(wait);
    rows.push({ session: `P already open (+${wait / 1000} s)`, events: statusEvents(eventsP) || "-", ...(await state(p)) });
  }
  const eventsN: SessionEvent[] = [];
  const n = await open(client, "N", eventsN);
  rows.push({ session: "N new session, same runtime", events: statusEvents(eventsN) || "-", ...(await state(n)) });
  const other = await startClient();
  const eventsR: SessionEvent[] = [];
  const r = await open(other, "R", eventsR);
  rows.push({ session: "R new runtime process", events: statusEvents(eventsR) || "-", ...(await state(r)) });
  log.section("after", rows);
  console.table(rows.map(({ installationId: _, ...row }) => row));
  }
} finally {
  for (const { client: c, id } of opened) await c.deleteSession(id).catch(() => {});
  for (const c of new Set(opened.map((o) => o.client))) await stopClient(c).catch(() => {});
  await stopClient(client).catch(() => {});
  await log.close();
}
