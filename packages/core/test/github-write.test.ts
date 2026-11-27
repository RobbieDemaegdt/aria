/**
 * The one GitHub write (github/write.ts, item 3): opening a PR, bound to exactly the request you confirmed. Against a
 * recording fake fetch and the local mock GitHub; nothing here leaves this PC.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHubFailure } from "../src/github/client.ts";
import { RefusedRequest, type FetchLike } from "../src/github/fetch.ts";
import { dispatchWorkflow, exactRequest, openPullRequest, refusal, type PullRequestPayload } from "../src/github/write.ts";
import { MOCK_TOKEN, MockGitHub } from "./mock-github.ts";

const BASE = "http://127.0.0.1:9";
const URL = `${BASE}/repos/me/moonrise/pulls`;
const PAYLOAD: PullRequestPayload = { title: "Fix the login", head: "aria/fix-login", base: "main", body: "```text\nFix the login\n```\n", draft: true };

function recording(answers: Array<() => Response> = []) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    const next = answers.shift();
    return next ? next() : new Response(JSON.stringify({ number: 3, html_url: "https://github.com/me/moonrise/pull/3", draft: true }), { status: 201 });
  };
  return { calls, fetch };
}

const headers = { accept: "application/vnd.github+json", authorization: "token t", "content-type": "application/json", "user-agent": "aria-desktop", "x-github-api-version": "2022-11-28" };

describe("exactRequest: one request, exactly", () => {
  it("sends the confirmed request once, with no-store, no credentials and no redirects", async () => {
    const { calls, fetch } = recording();
    const once = exactRequest(fetch, { method: "POST", url: URL, body: PAYLOAD });
    await once(URL, { method: "POST", headers, body: JSON.stringify(PAYLOAD) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init).toMatchObject({ method: "POST", cache: "no-store", credentials: "omit", redirect: "manual" });
    // A second use, even of the same request, is refused: a write isn't sent twice.
    await expect(once(URL, { method: "POST", headers, body: JSON.stringify(PAYLOAD) })).rejects.toThrow(/made already/);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["another method", URL, { method: "PATCH", headers, body: JSON.stringify(PAYLOAD) }],
    ["a GET", URL, { headers }],
    ["another repository", `${BASE}/repos/me/other/pulls`, { method: "POST", headers, body: JSON.stringify(PAYLOAD) }],
    ["a query", `${URL}?x=1`, { method: "POST", headers, body: JSON.stringify(PAYLOAD) }],
    ["another origin", "http://127.0.0.1:10/repos/me/moonrise/pulls", { method: "POST", headers, body: JSON.stringify(PAYLOAD) }],
    ["another title", URL, { method: "POST", headers, body: JSON.stringify({ ...PAYLOAD, title: "Something else" }) }],
    ["draft turned off", URL, { method: "POST", headers, body: JSON.stringify({ ...PAYLOAD, draft: false }) }],
    ["another head", URL, { method: "POST", headers, body: JSON.stringify({ ...PAYLOAD, head: "main" }) }],
    ["a key of its own", URL, { method: "POST", headers, body: JSON.stringify({ ...PAYLOAD, maintainer_can_modify: true }) }],
    ["no body", URL, { method: "POST", headers }],
    ["a body that isn't JSON", URL, { method: "POST", headers, body: "title=x" }],
    ["a header of its own", URL, { method: "POST", headers: { ...headers, cookie: "a=b" }, body: JSON.stringify(PAYLOAD) }],
  ])("refuses %s before anything goes out", async (_what, url, init) => {
    const { calls, fetch } = recording();
    await expect(exactRequest(fetch, { method: "POST", url: URL, body: PAYLOAD })(url, init as RequestInit)).rejects.toBeInstanceOf(RefusedRequest);
    expect(calls).toHaveLength(0);
  });

  it.each([301, 302, 307, 308])("refuses a %s: the body isn't sent anywhere else", async (status) => {
    const { calls, fetch } = recording([() => new Response(null, { status, headers: { location: "http://127.0.0.1:10/x" } })]);
    await expect(exactRequest(fetch, { method: "POST", url: URL, body: PAYLOAD })(URL, { method: "POST", headers, body: JSON.stringify(PAYLOAD) })).rejects.toThrow(/redirected/);
    expect(calls).toHaveLength(1);
  });
});

describe("openPullRequest", () => {
  it("sends one POST with exactly the payload, and says which PR it opened", async () => {
    const { calls, fetch } = recording();
    const opened = await openPullRequest({ baseUrl: BASE, token: "t", fetch, owner: "me", repo: "moonrise", payload: PAYLOAD });
    expect(opened).toEqual({ number: 3, url: "https://github.com/me/moonrise/pull/3", draft: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ title: PAYLOAD.title, head: PAYLOAD.head, base: PAYLOAD.base, body: PAYLOAD.body, draft: true });
    expect([...new Headers(calls[0]!.init.headers).keys()].sort()).toEqual(["accept", "authorization", "content-type", "user-agent", "x-github-api-version"]);
  });

  it("refuses a repository name that isn't one, sending nothing", async () => {
    const { calls, fetch } = recording();
    await expect(openPullRequest({ baseUrl: BASE, token: "t", fetch, owner: "me/../x", repo: "moonrise", payload: PAYLOAD })).rejects.toBeInstanceOf(RefusedRequest);
    expect(calls).toHaveLength(0);
  });

  it("isn't retried: a 500 is one request, said in ARIA's words", async () => {
    const { calls, fetch } = recording([() => new Response(JSON.stringify({ message: "boom <script>" }), { status: 502 })]);
    const failed = await openPullRequest({ baseUrl: BASE, token: "t", fetch, owner: "me", repo: "moonrise", payload: PAYLOAD }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(GitHubFailure);
    expect((failed as GitHubFailure).message).toBe("GitHub had a problem (502).");
    expect(calls).toHaveLength(1);
  });

  it.each([
    [422, { message: "Validation Failed", errors: [{ message: "A pull request already exists for me:aria/fix-login." }] }, {}, "exists", /exists already/],
    [422, { message: "Validation Failed", errors: [{ message: "Draft pull requests are not supported in this repository." }] }, {}, "draft", /draft/],
    [422, { message: "Validation Failed", errors: [{ field: "base", code: "invalid" }] }, {}, "base", /base branch/],
    [422, { message: "Validation Failed", errors: [{ field: "head", code: "invalid" }] }, {}, "head", /pushed branch/],
    [403, { message: "Resource protected by organization SAML enforcement." }, { "x-github-sso": "required; url=https://github.com/orgs/acme/sso?authorization_request=x" }, undefined, /single sign-on/],
    [403, { message: "Must have push access" }, {}, undefined, /doesn't let this account/],
    [404, { message: "Not Found" }, {}, undefined, /doesn't know that repository/],
    [401, { message: "Bad credentials" }, {}, undefined, /refused the token/],
  ])("a %s is said in ARIA's words (GitHub's text isn't kept)", async (status, body, extra, reason, words) => {
    const { fetch } = recording([() => new Response(JSON.stringify(body), { status, headers: extra })]);
    const failed = await openPullRequest({ baseUrl: BASE, token: "t", fetch, owner: "me", repo: "moonrise", payload: PAYLOAD }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(GitHubFailure);
    expect((failed as GitHubFailure).message).toMatch(words);
    expect((failed as GitHubFailure).message).not.toMatch(/SAML|Must have|Bad credentials/);
    expect(refusal(failed)).toBe(reason);
  });

  it("a 201 that doesn't say which PR is a failure; a page outside github.com isn't kept", async () => {
    const none = recording([() => new Response(JSON.stringify({}), { status: 201 })]);
    await expect(openPullRequest({ baseUrl: BASE, token: "t", fetch: none.fetch, owner: "me", repo: "moonrise", payload: PAYLOAD })).rejects.toThrow(/didn't say/);
    const elsewhere = recording([() => new Response(JSON.stringify({ number: 4, html_url: "https://evil.example/pull/4" }), { status: 201 })]);
    const opened = await openPullRequest({ baseUrl: BASE, token: "t", fetch: elsewhere.fetch, owner: "me", repo: "moonrise", payload: PAYLOAD });
    expect(opened.url).toBe("https://github.com/me/moonrise/pull/4");
  });
});

describe("openPullRequest against the mock GitHub", () => {
  let mock: MockGitHub;
  beforeEach(async () => {
    mock = new MockGitHub();
    await mock.start();
    mock.addRepo("me", "moonrise");
    mock.branches.set("me/moonrise@main", "a".repeat(40));
    mock.branches.set("me/moonrise@aria/fix-login", "b".repeat(40));
  });
  afterEach(() => mock.stop());

  it("opens it as sent; a second one for the branch is 'exists'; the token isn't in what the mock kept", async () => {
    const opened = await openPullRequest({ baseUrl: mock.baseUrl, token: MOCK_TOKEN, fetch: (u, i) => fetch(u, i), owner: "me", repo: "moonrise", payload: PAYLOAD });
    expect(opened).toEqual({ number: 1, url: "https://github.com/me/moonrise/pull/1", draft: true });
    expect(mock.opened).toEqual([{ owner: "me", repo: "moonrise", body: { ...PAYLOAD } }]);
    const again = await openPullRequest({ baseUrl: mock.baseUrl, token: MOCK_TOKEN, fetch: (u, i) => fetch(u, i), owner: "me", repo: "moonrise", payload: PAYLOAD }).catch((e: unknown) => e);
    expect(refusal(again)).toBe("exists");
    expect(mock.count(/\/pulls$/, "POST")).toBe(2);
    expect(JSON.stringify(mock.requests)).not.toContain(MOCK_TOKEN);
  });
});

describe("dispatchWorkflow", () => {
  it("sends one POST to /dispatches with ref and optional inputs, and expects 204 No Content", async () => {
    const { calls, fetch } = recording([() => new Response(null, { status: 204 })]);
    await dispatchWorkflow({
      baseUrl: BASE,
      token: "t",
      fetch,
      owner: "me",
      repo: "moonrise",
      workflowId: 1001,
      payload: { ref: "1.0.0", inputs: { dry_run: "true" } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/repos/me/moonrise/actions/workflows/1001/dispatches`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ ref: "1.0.0", inputs: { dry_run: "true" } });
  });

  it("omits inputs when empty, and refuses invalid repository, workflow, or ref before sending", async () => {
    const { calls, fetch } = recording([() => new Response(null, { status: 204 })]);
    await dispatchWorkflow({
      baseUrl: BASE,
      token: "t",
      fetch,
      owner: "me",
      repo: "moonrise",
      workflowId: "issue-plans.yml",
      payload: { ref: "main", inputs: {} },
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ ref: "main" });

    const bad = recording();
    await expect(
      dispatchWorkflow({
        baseUrl: BASE,
        token: "t",
        fetch: bad.fetch,
        owner: "me",
        repo: "moonrise",
        workflowId: "../secret",
        payload: { ref: "main" },
      }),
    ).rejects.toBeInstanceOf(RefusedRequest);
    await expect(
      dispatchWorkflow({
        baseUrl: BASE,
        token: "t",
        fetch: bad.fetch,
        owner: "me",
        repo: "moonrise",
        workflowId: 123,
        payload: { ref: "main..evil" },
      }),
    ).rejects.toBeInstanceOf(RefusedRequest);
    expect(bad.calls).toHaveLength(0);
  });

  it.each([
    [422, { message: "Workflow does not have 'workflow_dispatch' trigger" }, {}, "trigger", /workflow_dispatch trigger/],
    [422, { message: "No ref found for: missing-branch" }, {}, "ref", /branch or tag/],
    [422, { message: "Required input 'environment' not provided" }, {}, "inputs", /workflow inputs/],
    [422, { message: "Workflow is disabled" }, {}, "disabled", /disabled/],
    [403, { message: "Resource not accessible by integration" }, {}, undefined, /trigger workflows/],
    [404, { message: "Not Found" }, {}, undefined, /doesn't know that workflow/],
  ])("classifies %s workflow dispatch errors in ARIA's words", async (status, body, extra, reason, words) => {
    const { fetch } = recording([() => new Response(JSON.stringify(body), { status, headers: extra })]);
    const failed = await dispatchWorkflow({
      baseUrl: BASE,
      token: "t",
      fetch,
      owner: "me",
      repo: "moonrise",
      workflowId: 42,
      payload: { ref: "main" },
    }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(GitHubFailure);
    expect((failed as GitHubFailure).message).toMatch(words);
    expect(refusal(failed)).toBe(reason);
  });
});

