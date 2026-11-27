/**
 * The only fetch Octokit gets (PLAN.md §4.6, §0.4): GitHub's token can write, so read-only is enforced here, below
 * Octokit and its plugins (and their `graphql`): a GET without a body, to the base URL's origin, on a path of the list
 * below. Anything else is refused before a byte goes out. Redirects are followed here too, only within that origin and
 * that list (a renamed repository answers 301 to `/repositories/<id>/…`), so the token never follows one away.
 */

import { MAX_QUERY_LENGTH, queryRepos, SEARCH_PER_PAGE, SEARCH_QUERY } from "./search.ts";
import { ignoreCleanupFailure } from "../util/ignore.ts";

/** What core needs of `fetch`: Node's, or Chromium's (`session.fetch` in the desktop app). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A request ARIA's GitHub code may not make. Never retried. */
export class RefusedRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusedRequest";
  }
}

const SEG = "[A-Za-z0-9_.-]+";
/** A repository by name, or by id (where GitHub redirects a renamed one). */
const REPO = `(?:/repos/${SEG}/${SEG}|/repositories/\\d+)`;
const SHA = "[0-9a-f]{40,64}";

const SEARCH_PATH = /^\/search\/issues$/;
const PULLS_PATH = new RegExp(`^${REPO}/pulls$`);
const REVIEW_COMMENTS_PATH = new RegExp(`^${REPO}/pulls/\\d+/reviews/\\d+/comments$`);

/** A review's inline comments: exactly `per_page=100` (the first page; more is said on the card). */
export function checkReviewComments(url: URL): string | undefined {
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== "per_page" || url.searchParams.get("per_page") !== "100") return "Reading a review's comments another way than ARIA's own.";
  return undefined;
}

/**
 * The paths ARIA reads: user, notifications, runs, jobs, workflows, PRs, reviews, checks and statuses (item 1), and My
 * work's search (item 2: only its own queries, checkSearch below).
 */
export const ALLOWED_PATHS: readonly RegExp[] = [
  /^\/user$/,
  /^\/notifications$/,
  SEARCH_PATH,
  new RegExp(`^${REPO}$`),
  new RegExp(`^${REPO}/releases/latest$`),
  new RegExp(`^${REPO}/actions/runs$`),
  new RegExp(`^${REPO}/actions/runs/\\d+$`),
  new RegExp(`^${REPO}/actions/runs/\\d+/jobs$`),
  new RegExp(`^${REPO}/actions/workflows$`),
  new RegExp(`^${REPO}/actions/workflows/${SEG}/runs$`),
  new RegExp(`^${REPO}/pulls/\\d+$`),
  new RegExp(`^${REPO}/pulls/\\d+/reviews$`),
  new RegExp(`^${REPO}/commits/${SHA}/check-runs$`),
  new RegExp(`^${REPO}/commits/${SHA}/status$`),
  // Item 3, before a PR is opened: a branch (its name's slashes as %2F), whether one commit is in another, and the
  // open PRs for one `aria/` head (pinned: checkPulls).
  new RegExp(`^${REPO}/branches/(?:[A-Za-z0-9_.-]|%2F){1,250}$`),
  new RegExp(`^${REPO}/compare/${SHA}\\.\\.\\.${SHA}$`),
  PULLS_PATH,
  // Item 4, for Fix it and Address comments: one job (its steps, its head, its check run), one check run (a non-Actions
  // check's output), one review and its inline comments (pinned: checkReviewComments). A job's log isn't here: its
  // two hops are github/logs.ts's own.
  new RegExp(`^${REPO}/actions/jobs/\\d+$`),
  new RegExp(`^${REPO}/check-runs/\\d+$`),
  new RegExp(`^${REPO}/pulls/\\d+/reviews/\\d+$`),
  REVIEW_COMMENTS_PATH,
];

export const allowedPath = (pathname: string): boolean => ALLOWED_PATHS.some((pattern) => pattern.test(pathname));

const SEARCH_PARAMS = ["order", "per_page", "q", "sort"];
const PULLS_PARAMS = ["head", "per_page", "state"];
/** `<owner>:aria/<name>`: a task's branch, in its repository or a fork. */
const ARIA_HEAD = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}):aria\/(?!.*\.\.)[\w./-]{1,200}$/;

/**
 * The open PRs for one of ARIA's branches (before a PR is opened, item 3), pinned like the search: exactly `head`
 * (`<owner>:aria/…`), `state=open` and `per_page` 1–5, each once. Listing a repository's PRs otherwise isn't read.
 */
export function checkPulls(url: URL): string | undefined {
  const keys = [...url.searchParams.keys()];
  if (keys.length !== PULLS_PARAMS.length || [...keys].sort().join(",") !== PULLS_PARAMS.join(",")) return "Listing pull requests has other parameters than ARIA's own.";
  if (url.searchParams.get("state") !== "open" || !/^[1-5]$/.test(url.searchParams.get("per_page") ?? "")) return "Listing pull requests another way than ARIA's own.";
  if (!ARIA_HEAD.test(url.searchParams.get("head") ?? "")) return "ARIA only looks up pull requests from its own branches.";
  return undefined;
}

/**
 * My work's search, pinned here rather than by convention: exactly `q`, `sort=updated`, `order=desc` and `per_page`
 * 1–50, each once; `q` one of search.ts's shapes with `repo:` qualifiers, every one of them a registered repository
 * (`searchRepos`, lowercased "owner/name"), within 256 characters. Returns why not, if it isn't.
 */
export function checkSearch(url: URL, searchRepos: (() => ReadonlySet<string>) | undefined): string | undefined {
  if (!searchRepos) return "ARIA doesn't search GitHub in this setup.";
  const keys = [...url.searchParams.keys()];
  if (keys.length !== SEARCH_PARAMS.length || [...keys].sort().join(",") !== SEARCH_PARAMS.join(",")) return "A search has other parameters than ARIA's own.";
  if (url.searchParams.get("sort") !== "updated" || url.searchParams.get("order") !== "desc") return "A search is sorted another way than ARIA's own.";
  const perPage = url.searchParams.get("per_page") ?? "";
  if (!/^\d{1,2}$/.test(perPage) || Number(perPage) < 1 || Number(perPage) > SEARCH_PER_PAGE) return "A search asks for more at once than ARIA does.";
  const q = url.searchParams.get("q") ?? "";
  if (q.length > MAX_QUERY_LENGTH || !SEARCH_QUERY.test(q)) return "A search isn't one of ARIA's own queries.";
  const allowed = searchRepos();
  if (!queryRepos(q).every((repo) => allowed.has(repo))) return "A search names a repository that isn't one of your projects.";
  return undefined;
}

/** Request headers that go out; anything else Octokit (or a plugin) adds stays behind. */
const SENT_HEADERS = new Set(["accept", "authorization", "user-agent", "x-github-api-version", "if-none-match", "if-modified-since"]);
const FOLLOWED = new Set([301, 302, 307, 308]);
const MAX_HOPS = 3;

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * A read's whole answer, read here (item 4's review, finding 1): the fetch under it streams (Chromium's answers at the
 * headers), and a body cut off after them must reject (offline) rather than reach Octokit, which takes a failed read
 * of the body as "" and would keep the answer's new ETag (then every poll after it is a 304: the change is lost). The
 * logs' second hop doesn't come here: it streams on purpose (github/logs.ts).
 */
async function whole(response: Response): Promise<Response> {
  if (NULL_BODY.has(response.status) || response.body === null) return response;
  const body = await response.arrayBuffer();
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const source = init?.headers;
  if (!source) return out;
  const entries: Array<[string, string]> = source instanceof Headers ? [...source.entries()] : Array.isArray(source) ? source.map(([k, v]) => [String(k), String(v)]) : Object.entries(source).map(([k, v]) => [k, String(v)]);
  for (const [name, value] of entries) {
    const key = name.toLowerCase();
    if (SENT_HEADERS.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Wraps `fetch` for GitHub's API at `baseUrl` (its origin, path "/"). Every request goes out with `cache: "no-store"`
 * (a browser's HTTP cache mustn't answer a poll), `credentials: "omit"` and `redirect: "manual"`.
 */
export function guardFetch(fetch: FetchLike, options: { baseUrl: string; searchRepos?: () => ReadonlySet<string> }): FetchLike {
  const base = new URL(options.baseUrl);
  if (base.pathname !== "/" || base.search || base.hash || base.username || base.password) throw new Error("GitHub's base URL must be an origin, with nothing after it.");
  const check = (url: URL, what: string) => {
    if (url.origin !== base.origin) throw new RefusedRequest(`${what} goes to another host than GitHub's API.`);
    if (url.username || url.password) throw new RefusedRequest(`${what} has a user name in it.`);
    if (!allowedPath(url.pathname)) throw new RefusedRequest(`${what} is for a path ARIA doesn't read.`);
    if (SEARCH_PATH.test(url.pathname)) {
      const why = checkSearch(url, options.searchRepos);
      if (why) throw new RefusedRequest(why);
    }
    if (PULLS_PATH.test(url.pathname)) {
      const why = checkPulls(url);
      if (why) throw new RefusedRequest(why);
    }
    if (REVIEW_COMMENTS_PATH.test(url.pathname)) {
      const why = checkReviewComments(url);
      if (why) throw new RefusedRequest(why);
    }
  };
  return async (input, init) => {
    if (typeof input !== "string" && !((input as unknown) instanceof URL)) throw new RefusedRequest("A request has to be a plain address.");
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") throw new RefusedRequest(`ARIA only reads GitHub: a ${method} request isn't made.`);
    if (init?.body !== undefined && init.body !== null) throw new RefusedRequest("A read has no body.");
    const headers = headersOf(init);
    let url = new URL(String(input));
    check(url, "The request");
    for (let hop = 0; ; hop++) {
      const response = await fetch(url.toString(), { method: "GET", headers, ...(init?.signal ? { signal: init.signal } : {}), cache: "no-store", credentials: "omit", redirect: "manual" });
      if (response.type === "opaqueredirect" || response.status === 0) throw new RefusedRequest("GitHub redirected the request in a way ARIA can't follow.");
      // Any other redirect (a 303 turns into another request) isn't followed; 304 is the answer to a conditional read.
      if (response.status >= 300 && response.status < 400 && response.status !== 304 && !FOLLOWED.has(response.status)) {
        await response.body?.cancel().catch(ignoreCleanupFailure);
        throw new RefusedRequest(`GitHub answered ${response.status}, a redirect ARIA doesn't follow.`);
      }
      if (!FOLLOWED.has(response.status)) return whole(response);
      const location = response.headers.get("location");
      await response.body?.cancel().catch(ignoreCleanupFailure);
      if (!location) throw new RefusedRequest("GitHub redirected the request without saying where.");
      if (hop + 1 >= MAX_HOPS) throw new RefusedRequest("GitHub redirected the request too many times.");
      url = new URL(location, url);
      check(url, "A redirect");
    }
  };
}
