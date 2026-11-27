/**
 * GitHub's REST API for the watchers (PLAN.md §4.6): Octokit with the throttling and retry plugins, ETags
 * (`If-None-Match`, and `If-Modified-Since` where GitHub gives `Last-Modified`), and GitHub's `X-Poll-Interval`. Reads
 * only: the client has `get()` and nothing else, every call names a route from ROUTES, and the fetch underneath
 * refuses anything else (fetch.ts). The Octokit instance never leaves this module (only `buildOctokit`'s own test
 * builds one elsewhere). Failures come back classified, with text that names no header and holds no token.
 */
import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { guardFetch, RefusedRequest, type FetchLike } from "./fetch.ts";
import { githubText } from "./text.ts";

export const ROUTES = [
  "GET /user",
  "GET /notifications",
  "GET /repos/{owner}/{repo}",
  "GET /repos/{owner}/{repo}/actions/runs",
  "GET /repos/{owner}/{repo}/actions/runs/{run_id}",
  "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs",
  "GET /repos/{owner}/{repo}/actions/workflows",
  "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
  "GET /repos/{owner}/{repo}/pulls/{pull_number}",
  "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
  "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
  "GET /repos/{owner}/{repo}/commits/{ref}/status",
  // My work (item 2): only search.ts's queries get past the fetch guard.
  "GET /search/issues",
  // Before a PR is opened (item 3): the base and the remote branch, the base commit in GitHub's base, an open PR for the head.
  "GET /repos/{owner}/{repo}/branches/{branch}",
  "GET /repos/{owner}/{repo}/compare/{basehead}",
  "GET /repos/{owner}/{repo}/pulls",
  // Fix it and Address comments (item 4): a job, a check run, a review and its inline comments.
  "GET /repos/{owner}/{repo}/actions/jobs/{job_id}",
  "GET /repos/{owner}/{repo}/check-runs/{check_run_id}",
  "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}",
  "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments",
] as const;
export type Route = (typeof ROUTES)[number];
export type Params = Record<string, string | number | boolean>;

/** What a conditional request sends: the last 200's ETag and Last-Modified. */
export interface Conditional {
  etag?: string;
  lastModified?: string;
}

export interface RateInfo {
  remaining: number;
  /** When the limit resets (ms). */
  resetAt: number;
  resource?: string;
}

export type GetResult =
  /** `ssoPartial`: GitHub left out an organisation's repositories, which want the token authorized for SSO (X-GitHub-SSO). */
  | { status: 200; data: unknown; etag?: string; lastModified?: string; pollIntervalMs?: number; rate?: RateInfo; scopes?: string[]; ssoPartial?: boolean }
  | { status: 304; pollIntervalMs?: number; rate?: RateInfo; ssoPartial?: boolean };

/**
 * auth: the token was refused (401). sso: an organisation wants the token authorized for it. not_found: 404 or 410.
 * forbidden: 403 for anything else. rate_limited / secondary_limit: wait until `retryAt`. offline: no answer (or too
 * slow). server: 5xx after the retries. invalid: 4xx otherwise. refused: ARIA's own guard said no.
 */
export type FailureType = "auth" | "sso" | "not_found" | "forbidden" | "rate_limited" | "secondary_limit" | "offline" | "server" | "invalid" | "refused" | "stopped";

export type GitHubRefusalReason = "exists" | "draft" | "base" | "head" | "trigger" | "ref" | "inputs" | "disabled";

export class GitHubFailure extends Error {
  constructor(
    readonly type: FailureType,
    message: string,
    /** `reason`: why GitHub refused opening a PR or dispatching a workflow (422), when ARIA could place it (write.ts). */
    readonly details: { status?: number; retryAt?: number; org?: string; rate?: RateInfo; scopes?: string[]; reason?: GitHubRefusalReason } = {},
  ) {
    super(message);
    this.name = "GitHubFailure";
  }
}

export interface ClientOptions {
  token: string;
  baseUrl: string;
  fetch: FetchLike;
  /** Where Octokit's own warnings go (already redacted). */
  log: (line: string) => void;
  /** Takes the token (and anything shaped like one) out of a text. */
  redact: (text: string) => string;
  /** Tests: the retry plugin's base wait (default 1 s, then 4 s). */
  retryBaseMs?: number;
  /** How long one request may take (default 20 s). */
  timeoutMs?: number;
  /** The repositories My work may search (your projects, lowercased "owner/name"); none: no search goes out. */
  searchRepos?: () => ReadonlySet<string>;
  /**
   * The throttling plugin's spacing (on unless false): searches at least 2 s apart, notifications 3 s, in real time and
   * shared by every Octokit in the process. Tests turn it off (they'd wait for it); ARIA's own pauses stay either way.
   */
  throttle?: boolean;
}

/**
 * Turns a refusal from the guard back into itself (Octokit wraps fetch errors as a retryable 500), so a refusal is
 * never retried. Registered before the other plugins, so it's the innermost hook. (What's refused is the guard's call.)
 */
function guardPlugin(octokit: Octokit) {
  octokit.hook.error("request", (error: unknown) => {
    const cause = (error as { cause?: unknown } | undefined)?.cause;
    if (cause instanceof RefusedRequest) throw cause;
    throw error;
  });
  return {};
}

/** The Octokit behind GitHubClient. Exported for the guard's own test only; nothing else may hold one. */
export function buildOctokit(options: Omit<ClientOptions, "timeoutMs">): Octokit {
  const AriaOctokit = Octokit.plugin(guardPlugin, throttling, retry);
  const noop = () => {
    // Octokit's debug and info lines aren't kept: its warnings and errors are.
  };
  const log = { debug: noop, info: noop, warn: (text: unknown) => options.log(options.redact(String(text))), error: (text: unknown) => options.log(options.redact(String(text))) };
  return new AriaOctokit({
    auth: options.token,
    baseUrl: options.baseUrl,
    userAgent: "aria-desktop",
    log,
    request: { fetch: guardFetch(options.fetch, { baseUrl: options.baseUrl, ...(options.searchRepos ? { searchRepos: options.searchRepos } : {}) }), log },
    // ARIA's scheduler owns every pause (watchers.ts): the plugin never waits inside a request.
    throttle: { enabled: options.throttle !== false, onRateLimit: () => false, onSecondaryRateLimit: () => false },
    retry: { retries: 2, retryAfterBaseValue: options.retryBaseMs ?? 1_000, doNotRetry: [304, 400, 401, 403, 404, 410, 422, 429, 451] },
  });
}

const header = (headers: Record<string, unknown> | undefined, name: string): string | undefined => {
  const value = headers?.[name];
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
};

function rateOf(headers: Record<string, unknown> | undefined): RateInfo | undefined {
  const remaining = Number(header(headers, "x-ratelimit-remaining"));
  const reset = Number(header(headers, "x-ratelimit-reset"));
  if (!Number.isFinite(remaining) || !Number.isFinite(reset) || header(headers, "x-ratelimit-remaining") === undefined) return undefined;
  const resource = header(headers, "x-ratelimit-resource");
  return { remaining, resetAt: reset * 1000, ...(resource ? { resource } : {}) };
}

function pollIntervalOf(headers: Record<string, unknown> | undefined): number | undefined {
  const seconds = Number(header(headers, "x-poll-interval"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : undefined;
}

export class GitHubClient {
  private readonly octokit: Octokit;

  constructor(private readonly options: ClientOptions) {
    this.octokit = buildOctokit(options);
  }

  /** One read. Throws a GitHubFailure. `signal` ends it (ARIA quitting). */
  async get(route: Route, params: Params, conditional: Conditional = {}, signal?: AbortSignal): Promise<GetResult> {
    if (!(ROUTES as readonly string[]).includes(route)) throw new GitHubFailure("refused", "ARIA doesn't read that from GitHub.");
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 20_000);
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
    if (conditional.etag) headers["if-none-match"] = conditional.etag;
    if (conditional.lastModified) headers["if-modified-since"] = conditional.lastModified;
    // The routes are a fixed list of strings; Octokit's typed overloads can't take a union of them.
    const request = this.octokit.request as unknown as (route: string, options: object) => Promise<{ status?: number; data: unknown; headers: Record<string, unknown> }>;
    try {
      const response = await request(route, { ...params, headers, request: { signal: signal ? AbortSignal.any([timeout, signal]) : timeout } });
      const h = response.headers as Record<string, unknown>;
      // A second layer under the whole-body read (fetch.ts): a JSON answer with nothing in it isn't an answer, nor is
      // one that isn't JSON (Octokit hands its text back as a string). Neither's ETag is kept, and the poll is made
      // again. A 204 or 205 has no body by design.
      if (/json/i.test(header(h, "content-type") ?? "") && response.status !== 204 && response.status !== 205) {
        if (response.data === "" || response.data === undefined || response.data === null) throw new GitHubFailure("offline", "GitHub's answer was cut off.");
        if (typeof response.data === "string") throw new GitHubFailure("invalid", "GitHub's answer wasn't valid JSON.");
      }
      const etag = header(h, "etag");
      const lastModified = header(h, "last-modified");
      const pollIntervalMs = pollIntervalOf(h);
      const rate = rateOf(h);
      const scopes = header(h, "x-oauth-scopes");
      const ssoPartial = /\bpartial-results\b/i.test(header(h, "x-github-sso") ?? "");
      return {
        status: 200,
        data: response.data,
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
        ...(pollIntervalMs ? { pollIntervalMs } : {}),
        ...(rate ? { rate } : {}),
        ...(scopes !== undefined ? { scopes: scopes.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
        ...(ssoPartial ? { ssoPartial } : {}),
      };
    } catch (error) {
      const result = this.classify(error, signal);
      if (result instanceof GitHubFailure) throw result;
      return result;
    }
  }

  private classify(error: unknown, signal: AbortSignal | undefined): GetResult | GitHubFailure {
    const redact = (text: string) => this.options.redact(githubText(text, 200));
    if (error instanceof RefusedRequest) return new GitHubFailure("refused", redact(error.message));
    if (error instanceof GitHubFailure) return error;
    if (signal?.aborted) return new GitHubFailure("stopped", "ARIA is stopping.");
    const e = error as { status?: unknown; name?: unknown; message?: unknown; response?: { headers?: Record<string, unknown>; data?: unknown } };
    const status = typeof e.status === "number" ? e.status : undefined;
    const headers = e.response?.headers;
    const rate = rateOf(headers);
    if (status === 304) {
      const pollIntervalMs = pollIntervalOf(headers);
      // What was left out (SSO) is the answer's, not the body's: a 304 says it too.
      const ssoPartial = /\bpartial-results\b/i.test(header(headers, "x-github-sso") ?? "");
      return { status: 304, ...(pollIntervalMs ? { pollIntervalMs } : {}), ...(rate ? { rate } : {}), ...(ssoPartial ? { ssoPartial } : {}) };
    }
    // No answer at all: Octokit makes a network error (or a time-out) a 500 without a response.
    if (!e.response) return new GitHubFailure("offline", e.name === "AbortError" || e.name === "TimeoutError" ? "GitHub didn't answer in time." : "GitHub can't be reached.");
    const message = redact(typeof e.message === "string" ? e.message : "GitHub refused the request.");
    const details = { ...(status !== undefined ? { status } : {}), ...(rate ? { rate } : {}) };
    if (status === 401) return new GitHubFailure("auth", "GitHub refused the token.", details);
    if (status === 403 || status === 429) {
      if (header(headers, "x-ratelimit-remaining") === "0") return new GitHubFailure("rate_limited", "GitHub's rate limit is used up.", { ...details, retryAt: (rate?.resetAt ?? Date.now() + 60_000) + 5_000 });
      const retryAfter = Number(header(headers, "retry-after"));
      if (/secondary rate|abuse/i.test(message) || Number.isFinite(retryAfter) || status === 429) {
        return new GitHubFailure("secondary_limit", "GitHub asked ARIA to slow down.", { ...details, retryAt: Date.now() + Math.max(60, Number.isFinite(retryAfter) ? retryAfter : 60) * 1000 });
      }
      const sso = header(headers, "x-github-sso");
      if (sso !== undefined) {
        const org = /\/orgs\/([A-Za-z0-9_.-]+)\/sso/.exec(sso)?.[1];
        return new GitHubFailure("sso", `An organisation${org ? ` (${org})` : ""} wants the token authorized for single sign-on.`, { ...details, ...(org ? { org } : {}) });
      }
      const scopes = header(headers, "x-oauth-scopes");
      return new GitHubFailure("forbidden", "GitHub doesn't let this account read that.", { ...details, ...(scopes !== undefined ? { scopes: scopes.split(",").map((s) => s.trim()).filter(Boolean) } : {}) });
    }
    if (status === 404 || status === 410) return new GitHubFailure("not_found", "GitHub doesn't know it (gone, renamed, or not visible to this account).", details);
    if (status !== undefined && status >= 500) return new GitHubFailure("server", `GitHub had a problem (${status}).`, details);
    // ARIA's own words with the status, never the answer's text (a proxy's page, anyone's words): this one reaches the
    // window, a watch's status and, through them, ARIA.
    return new GitHubFailure("invalid", status !== undefined ? `GitHub answered ${status}.` : "GitHub's answer couldn't be read.", details);
  }
}
