/**
 * The only GitHub write ARIA makes (PLAN.md §4.3, item 3): opening a pull request, after your click on its card. It
 * doesn't go through Octokit or the read guard (fetch.ts, which still refuses every write): each click gets a fetch
 * bound to one exact request (`POST /repos/{owner}/{repo}/pulls` with exactly the confirmed body) that refuses anything
 * else before a byte goes out, can be used once, follows no redirect (a 307 would resend the body elsewhere) and is
 * never retried (a retried POST could open two PRs). Failures are said in ARIA's words, with the status.
 */
import type { FetchLike } from "./fetch.ts";
import { RefusedRequest } from "./fetch.ts";
import { GitHubFailure } from "./client.ts";
import { githubPage, githubText, id as asId, validName } from "./text.ts";
import { ignoreCleanupFailure } from "../util/ignore.ts";

export interface PullRequestPayload {
  title: string;
  /** `aria/<slug>`, or `<owner>:aria/<slug>` from a fork. */
  head: string;
  base: string;
  body: string;
  draft: boolean;
}

export interface OpenedPullRequest {
  number: number;
  url: string;
  draft: boolean;
}

const SENT = new Set(["accept", "authorization", "content-type", "user-agent", "x-github-api-version"]);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A fetch for exactly one request: that method, that address (no query), that body (parsed equal, keys in the same
 * order), only GitHub's headers, once. Exported for its own test.
 */
export function exactRequest(fetch: FetchLike, expected: { method: "POST"; url: string; body: unknown }): FetchLike {
  let used = false;
  return async (input, init) => {
    if (used) throw new RefusedRequest("This write was made already: ARIA doesn't send it twice.");
    used = true;
    if (typeof input !== "string") throw new RefusedRequest("A write has to be a plain address.");
    if ((init?.method ?? "GET").toUpperCase() !== expected.method) throw new RefusedRequest("Not the write you confirmed.");
    if (input !== expected.url) throw new RefusedRequest("Not the address you confirmed.");
    let body: unknown;
    try {
      body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    } catch {
      throw new RefusedRequest("Not the content you confirmed.");
    }
    if (!sameJson(body, expected.body)) throw new RefusedRequest("Not the content you confirmed.");
    const headers = new Headers(init?.headers);
    for (const name of headers.keys()) if (!SENT.has(name.toLowerCase())) throw new RefusedRequest(`A write with a header of its own (${name}) isn't sent.`);
    const response = await fetch(expected.url, { method: expected.method, headers, body: init!.body as string, cache: "no-store", credentials: "omit", redirect: "manual", ...(init?.signal ? { signal: init.signal } : {}) });
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(ignoreCleanupFailure);
      throw new RefusedRequest("GitHub redirected the write: ARIA doesn't follow it.");
    }
    return response;
  };
}

function failure(status: number, headers: Headers, message: string): GitHubFailure {
  const details = { status };
  if (status === 401) return new GitHubFailure("auth", "GitHub refused the token.", details);
  if (status === 403 || status === 429) {
    if (headers.get("x-ratelimit-remaining") === "0") return new GitHubFailure("rate_limited", "GitHub's rate limit is used up.", details);
    if (headers.has("retry-after") || /secondary rate/i.test(message) || status === 429) return new GitHubFailure("secondary_limit", "GitHub asked ARIA to slow down.", details);
    const sso = headers.get("x-github-sso");
    if (sso) {
      const org = /\/orgs\/([A-Za-z0-9_.-]+)\/sso/.exec(sso)?.[1];
      return new GitHubFailure("sso", `An organisation${org ? ` (${org})` : ""} wants GitHub CLI's token authorized for single sign-on.`, { ...details, ...(org ? { org } : {}) });
    }
    return new GitHubFailure("forbidden", "GitHub doesn't let this account open a pull request there.", details);
  }
  if (status === 404) return new GitHubFailure("not_found", "GitHub doesn't know that repository (or this account can't see it).", details);
  if (status === 422) {
    // GitHub's reason picks ARIA's words; its text isn't kept.
    if (/already exists/i.test(message)) return new GitHubFailure("invalid", "A pull request for this branch exists already.", { ...details, reason: "exists" });
    if (/draft/i.test(message)) return new GitHubFailure("invalid", "This repository doesn't take draft pull requests.", { ...details, reason: "draft" });
    if (/base/i.test(message)) return new GitHubFailure("invalid", "GitHub doesn't have the base branch there.", { ...details, reason: "base" });
    if (/head|no commits/i.test(message)) return new GitHubFailure("invalid", "GitHub doesn't see the pushed branch (or it has no commits beyond the base).", { ...details, reason: "head" });
    return new GitHubFailure("invalid", "GitHub answered 422.", details);
  }
  if (status >= 500) return new GitHubFailure("server", `GitHub had a problem (${status}).`, details);
  return new GitHubFailure("invalid", `GitHub answered ${status}.`, details);
}

/** Why GitHub refused a 422, when ARIA could place it (the failure's message is ARIA's own). */
export const refusal = (error: unknown): "exists" | "draft" | "base" | "head" | "trigger" | "ref" | "inputs" | "disabled" | undefined =>
  error instanceof GitHubFailure ? error.details.reason : undefined;

export interface WorkflowDispatchRequest {
  ref: string;
  inputs?: Record<string, string>;
}

const WORKFLOW_ID_SEG = /^[A-Za-z0-9_.-]{1,200}$/;

function dispatchFailure(status: number, headers: Headers, message: string): GitHubFailure {
  const details = { status };
  if (status === 401) return new GitHubFailure("auth", "GitHub refused the token.", details);
  if (status === 403 || status === 429) {
    if (headers.get("x-ratelimit-remaining") === "0") return new GitHubFailure("rate_limited", "GitHub's rate limit is used up.", details);
    if (headers.has("retry-after") || /secondary rate/i.test(message) || status === 429) return new GitHubFailure("secondary_limit", "GitHub asked ARIA to slow down.", details);
    const sso = headers.get("x-github-sso");
    if (sso) {
      const org = /\/orgs\/([A-Za-z0-9_.-]+)\/sso/.exec(sso)?.[1];
      return new GitHubFailure("sso", `An organisation${org ? ` (${org})` : ""} wants GitHub CLI's token authorized for single sign-on.`, { ...details, ...(org ? { org } : {}) });
    }
    return new GitHubFailure(
      "forbidden",
      "GitHub doesn't let this account trigger workflows there (check that GitHub CLI's token has the workflow and repo scopes).",
      details,
    );
  }
  if (status === 404) return new GitHubFailure("not_found", "GitHub doesn't know that workflow or repository (or this account can't see it).", details);
  if (status === 422) {
    if (/workflow_dispatch/i.test(message)) {
      return new GitHubFailure("invalid", "This workflow doesn't have a workflow_dispatch trigger.", { ...details, reason: "trigger" });
    }
    if (/disabled/i.test(message)) {
      return new GitHubFailure("invalid", "This workflow is disabled on GitHub.", { ...details, reason: "disabled" });
    }
    if (/input|required|unexpected/i.test(message)) {
      return new GitHubFailure("invalid", "GitHub rejected the workflow inputs (check required inputs and allowed options).", { ...details, reason: "inputs" });
    }
    if (/no ref found|reference.*not found|branch.*not found|tag.*not found|\bref\b/i.test(message)) {
      return new GitHubFailure("invalid", "GitHub doesn't have that branch or tag there.", { ...details, reason: "ref" });
    }
    return new GitHubFailure("invalid", "GitHub answered 422.", details);
  }
  if (status >= 500) return new GitHubFailure("server", `GitHub had a problem (${status}).`, details);
  return new GitHubFailure("invalid", `GitHub answered ${status}.`, details);
}

/**
 * Triggers a `workflow_dispatch` event on GitHub: one POST to `/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches`
 * with `{ ref, inputs? }`, bound to `exactRequest` (single-use, no redirects, no retries). GitHub answers 204 No Content.
 */
export async function dispatchWorkflow(options: {
  baseUrl: string;
  token: string;
  fetch: FetchLike;
  owner: string;
  repo: string;
  workflowId: number | string;
  payload: WorkflowDispatchRequest;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const { owner, repo, workflowId, payload } = options;
  const wf = typeof workflowId === "number" ? (asId(workflowId) ? String(workflowId) : "") : workflowId.trim();
  if (!validName(owner) || !validName(repo) || !WORKFLOW_ID_SEG.test(wf) || wf === "." || wf === "..") {
    throw new RefusedRequest("That isn't a workflow or repository ARIA can trigger on GitHub.");
  }
  const ref = payload.ref.trim();
  if (!ref || ref.length > 250 || /[\s~^:?*[\\\p{Cc}\p{Cf}]/u.test(ref) || ref.startsWith("-") || ref.includes("..")) {
    throw new RefusedRequest("That isn't a valid branch or tag ref.");
  }
  const url = `${options.baseUrl}/repos/${owner}/${repo}/actions/workflows/${wf}/dispatches`;
  const hasInputs = payload.inputs !== undefined && Object.keys(payload.inputs).length > 0;
  const body = hasInputs ? { ref, inputs: payload.inputs } : { ref };
  const fetch = exactRequest(options.fetch, { method: "POST", url, body });
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `token ${options.token}`,
        "content-type": "application/json",
        "user-agent": "aria-desktop",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify(body),
      signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
    });
  } catch (error) {
    if (error instanceof RefusedRequest) throw new GitHubFailure("refused", error.message);
    if (options.signal?.aborted) throw new GitHubFailure("stopped", "ARIA is stopping.");
    throw new GitHubFailure("offline", "GitHub can't be reached.");
  }
  if (response.status === 204) return;
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    data = undefined;
  }
  const message = typeof (data as { message?: unknown } | undefined)?.message === "string" ? (data as { message: string }).message : "";
  const errors = Array.isArray((data as { errors?: unknown } | undefined)?.errors) ? JSON.stringify((data as { errors: unknown[] }).errors) : "";
  throw dispatchFailure(response.status, response.headers, githubText(`${message} ${errors}`, 2_000));
}

/** Opens the pull request: one POST, exactly `payload`, with gh's token (the caller gets it for this one request). */
export async function openPullRequest(options: {
  baseUrl: string;
  token: string;
  fetch: FetchLike;
  owner: string;
  repo: string;
  payload: PullRequestPayload;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<OpenedPullRequest> {
  const { owner, repo, payload } = options;
  if (!validName(owner) || !validName(repo)) throw new RefusedRequest("That isn't a repository ARIA can open a pull request on.");
  const url = `${options.baseUrl}/repos/${owner}/${repo}/pulls`;
  const body = { title: payload.title, head: payload.head, base: payload.base, body: payload.body, draft: payload.draft };
  const fetch = exactRequest(options.fetch, { method: "POST", url, body });
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", authorization: `token ${options.token}`, "content-type": "application/json", "user-agent": "aria-desktop", "x-github-api-version": "2022-11-28" },
      body: JSON.stringify(body),
      signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
    });
  } catch (error) {
    if (error instanceof RefusedRequest) throw new GitHubFailure("refused", error.message);
    if (options.signal?.aborted) throw new GitHubFailure("stopped", "ARIA is stopping.");
    throw new GitHubFailure("offline", "GitHub can't be reached.");
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    data = undefined;
  }
  if (response.status !== 201) {
    const message = typeof (data as { message?: unknown } | undefined)?.message === "string" ? (data as { message: string }).message : "";
    const errors = Array.isArray((data as { errors?: unknown } | undefined)?.errors) ? JSON.stringify((data as { errors: unknown[] }).errors) : "";
    throw failure(response.status, response.headers, githubText(`${message} ${errors}`, 2_000));
  }
  const number = asId((data as { number?: unknown } | undefined)?.number);
  const page = githubPage((data as { html_url?: unknown } | undefined)?.html_url);
  if (!number) throw new GitHubFailure("invalid", "GitHub's answer didn't say which pull request it opened.");
  return { number, url: page ?? `https://github.com/${owner}/${repo}/pull/${number}`, draft: (data as { draft?: unknown }).draft === true };
}