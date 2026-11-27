/**
 * A failing job's log for Fix it (item 4, PLAN.md §4.6, the duck's points 3 and 4). GitHub answers
 * `GET /repos/{o}/{r}/actions/jobs/{id}/logs` with a redirect to a signed address on another host (an Azure blob), which
 * the read client never follows (its guard keeps the token within GitHub's API origin). So the log takes two hops of
 * its own, each pinned:
 *
 * 1. One GET to GitHub's API with gh's token, no query, `redirect: "manual"`, never retried: it must answer 302 or 307
 *    with a Location (or, from GitHub's own origin, the log itself).
 * 2. One GET of that Location, only if it's on the list below (in a test: the test's loopback origins), with no token
 *    and no cookies, following no redirect, text only, read as a stream and cut as it comes (tasks/untrusted.ts), and
 *    stopped at 32 MB of decoded body (a gzip bomb included: `Content-Length` isn't trusted).
 *
 * The Location is a signed capability: it's never logged, kept or shown; a refused one is said by its host only.
 */
import { type CutLog, LogCutter } from "../tasks/untrusted.ts";
import type { GitHubAccess } from "./access.ts";
import type { FetchLike } from "./fetch.ts";
import { ignoreCleanupFailure } from "../util/ignore.ts";

/**
 * Where GitHub's log redirects go, as ARIA assumes them (a Phase 9 check against the real GitHub): Actions' results
 * storage accounts, `productionresultssa<n>.blob.core.windows.net`, under `/actions-results/`, with the blob's own
 * signature (`sig`) and expiry (`se`) in the query. Nothing else: not any Azure storage account, not the upload host.
 */
export const LOG_HOST = /^productionresultssa\d{1,3}\.blob\.core\.windows\.net$/;
export const LOG_PATH = "/actions-results/";
/** The decoded body read at most (the cut keeps far less: a tail and the error lines). */
export const MAX_LOG_BYTES = 32 * 1024 * 1024;
const TEXT_TYPES = /^(?:text\/plain|application\/octet-stream)(?:\s*;.*)?$/i;

export type LogOutcome =
  | { status: "ok"; cut: CutLog; truncated: boolean }
  /** No log for the fix (D49): why, in ARIA's words; `host`: a refused redirect's host (never its address). */
  | { status: "none"; reason: string; host?: string };

/** Whether a Location may be fetched: its URL, or the host (only) of why not. */
export function checkLogLocation(raw: string, testOrigins?: readonly string[]): { ok: true; url: URL } | { ok: false; host: string; why: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, host: "?", why: "it isn't an address" };
  }
  const host = url.hostname || "?";
  if (url.username || url.password) return { ok: false, host, why: "it has a user name in it" };
  if (testOrigins !== undefined) {
    if (!testOrigins.includes(url.origin)) return { ok: false, host, why: "it isn't the test's log server" };
  } else {
    if (url.protocol !== "https:") return { ok: false, host, why: "it isn't https" };
    if (url.port !== "") return { ok: false, host, why: "it names a port" };
    if (!LOG_HOST.test(url.hostname)) return { ok: false, host, why: "it isn't GitHub's log storage" };
  }
  if (!url.pathname.startsWith(LOG_PATH)) return { ok: false, host, why: "it isn't a log's path" };
  if (!url.searchParams.get("sig") || !url.searchParams.get("se")) return { ok: false, host, why: "it isn't a signed log address" };
  return { ok: true, url };
}

/** Reads a text body as a stream into the cut, at most `maxBytes` of it; whether it stopped early. */
async function readCut(response: Response, maxBytes: number, signal?: AbortSignal): Promise<{ cut: CutLog; truncated: boolean }> {
  const cutter = new LogCutter();
  const body = response.body;
  if (!body) return { cut: cutter.end(), truncated: false };
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let read = 0;
  let truncated = false;
  try {
    for (;;) {
      if (signal?.aborted) throw new Error("stopped");
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        // The connection went away mid-log: what came is kept, and said to be cut.
        if (signal?.aborted) throw error;
        truncated = true;
        break;
      }
      const { done, value } = next;
      if (done) break;
      const room = maxBytes - read;
      const chunk = value.byteLength > room ? value.subarray(0, room) : value;
      read += chunk.byteLength;
      cutter.feed(decoder.decode(chunk, { stream: true }));
      if (read >= maxBytes) {
        truncated = true;
        break;
      }
    }
    cutter.feed(decoder.decode());
  } finally {
    // Stops the download (and frees the connection) when it stopped early.
    await reader.cancel().catch(ignoreCleanupFailure);
  }
  return { cut: cutter.end(), truncated };
}

const reasons: Record<number, string> = {
  404: "GitHub doesn't have that job's log, or this account can't see it (a private repository needs GitHub CLI's repo scope).",
  410: "The log is gone: GitHub keeps logs only for the repository's retention period (90 days unless it was changed).",
  401: "GitHub refused the token.",
};

/** The log of one job of `owner/repo`, cut; or why there's none (D49). Never throws for GitHub's answers. */
export async function fetchJobLog(options: { access: GitHubAccess; owner: string; repo: string; jobId: number; signal?: AbortSignal; maxBytes?: number; timeoutMs?: number }): Promise<LogOutcome> {
  const { access, owner, repo, jobId } = options;
  const maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || !Number.isSafeInteger(jobId) || jobId <= 0) return { status: "none", reason: "That isn't a job ARIA can read." };
  let first: { location?: string; inline?: { cut: CutLog; truncated: boolean }; failed?: string };
  try {
    first = await access.once(async ({ baseUrl, token, fetch }) => {
      const url = `${baseUrl}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`;
      const response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/vnd.github+json", authorization: `token ${token}`, "user-agent": "aria-desktop", "x-github-api-version": "2022-11-28" },
        cache: "no-store",
        credentials: "omit",
        redirect: "manual",
        signal,
      });
      if (response.status === 302 || response.status === 307) {
        const location = response.headers.get("location") ?? "";
        await response.body?.cancel().catch(ignoreCleanupFailure);
        return { location };
      }
      if (response.status === 200) {
        // From GitHub's own origin (a small log served inline): read the same way.
        if (!TEXT_TYPES.test(response.headers.get("content-type") ?? "text/plain")) {
          await response.body?.cancel().catch(ignoreCleanupFailure);
          return { failed: "GitHub's answer for the log wasn't text." };
        }
        return { inline: await readCut(response, maxBytes, signal) };
      }
      await response.body?.cancel().catch(ignoreCleanupFailure);
      if (response.status === 301 || response.status === 308) return { failed: "GitHub moved this repository (it was renamed or transferred): open the run on GitHub." };
      if (response.status === 403 || response.status === 429) {
        if (response.headers.get("x-github-sso")) return { failed: "An organisation wants GitHub CLI's token authorized for single sign-on." };
        if (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")) return { failed: "GitHub's rate limit is used up: try again later." };
        return { failed: "GitHub doesn't let this account read the log." };
      }
      if (response.status >= 500) return { failed: `GitHub had a problem (${response.status}).` };
      return { failed: reasons[response.status] ?? `GitHub answered ${response.status}.` };
    });
  } catch (error) {
    if (options.signal?.aborted) return { status: "none", reason: "ARIA is stopping." };
    if (timeout.aborted) return { status: "none", reason: "GitHub took too long to answer for the log." };
    return { status: "none", reason: error instanceof Error && /GitHub/.test(error.message) ? error.message : "GitHub can't be reached." };
  }
  if (first.failed) return { status: "none", reason: first.failed };
  if (first.inline) return { status: "ok", ...first.inline };
  const checked = checkLogLocation(first.location ?? "", access.testLogHosts);
  if (!checked.ok) return { status: "none", reason: `GitHub sent the log to an address ARIA doesn't read (${checked.why}).`, host: checked.host };
  return secondHop(access.rawFetch, checked.url, maxBytes, signal, options.signal);
}

async function secondHop(fetch: FetchLike, url: URL, maxBytes: number, signal: AbortSignal, outer?: AbortSignal): Promise<LogOutcome> {
  let response: Response;
  try {
    // No token, no cookies, no cache, no redirect: the signature in the address is the blob's own.
    response = await fetch(url.href, { method: "GET", headers: { accept: "text/plain", "user-agent": "aria-desktop" }, cache: "no-store", credentials: "omit", redirect: "manual", signal });
  } catch {
    return { status: "none", reason: outer?.aborted ? "ARIA is stopping." : "The log's storage can't be reached." };
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(ignoreCleanupFailure);
    return { status: "none", reason: "The log's storage redirected: ARIA doesn't follow it." };
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(ignoreCleanupFailure);
    return { status: "none", reason: response.status === 403 || response.status === 404 ? "The log's link expired or was refused: try again." : `The log's storage answered ${response.status}.` };
  }
  const type = response.headers.get("content-type");
  if (type !== null && !TEXT_TYPES.test(type)) {
    await response.body?.cancel().catch(ignoreCleanupFailure);
    return { status: "none", reason: "The log's storage didn't send text." };
  }
  try {
    return { status: "ok", ...(await readCut(response, maxBytes, signal)) };
  } catch {
    return { status: "none", reason: outer?.aborted ? "ARIA is stopping." : "The log stopped coming in." };
  }
}
