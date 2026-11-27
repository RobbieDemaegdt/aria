/**
 * My work (watchers/mywork.ts, PLAN.md §5.2, D38–D40) through the engine, against the local mock GitHub: searches on
 * your projects only (forks' upstreams included), the merged list, GitHub's counts and flags, ETags per query, the
 * cooldown, a login change, the search limit, Watch by key, the default branch by project id, and that nothing of the
 * list reaches ARIA. Nothing leaves this PC.
 */
import path from "node:path";
import type { MyWorkState } from "@aria/protocol";
import { describe, expect, it, vi } from "vitest";
import type { TokenResult } from "../src/github/access.ts";
import { queryRepos, SEARCH_QUERY } from "../src/github/search.ts";
import { cleanUpAfterEach, ariaCalls, lastPrompt, pause, record, setupGitHub, until, watchOf } from "./github-helpers.ts";
import { git, makeRepo } from "./helpers.ts";
import { MOCK_TOKEN, type MockGitHub } from "./mock-github.ts";

cleanUpAfterEach();
vi.setConfig({ testTimeout: 30_000 });

const searches = (mock: MockGitHub) => mock.requests.filter((r) => r.path === "/search/issues");
const item = (state: MyWorkState, key: string) => state.items.find((i) => i.key === key);

async function started(options: Parameters<typeof setupGitHub>[0] = {}) {
  const setup = await setupGitHub(options);
  return setup;
}

describe("My work searches your projects only (D38)", () => {
  it("three shapes, scoped by repo:, merged into one list with why each is yours; a review request elsewhere doesn't show", async () => {
    const { make, mock } = await started();
    mock.addPull("me", "moonrise", 5, { title: "Dark mode", author: "sam-test", assignees: ["sam-test"] });
    mock.addPull("me", "moonrise", 6, { title: "Fix login", author: "alice", reviewers: ["sam-test"] });
    mock.addIssue("me", "moonrise", 9, { title: "Crash on start", assignees: ["sam-test"] });
    mock.addPull("stranger", "elsewhere", 1, { title: "Not one of yours", author: "bob", reviewers: ["sam-test"] });
    const engine = make();
    await engine.start();
    const state = await engine.myWork(true);
    expect(state).toMatchObject({ status: "ok", login: "sam-test" });
    expect(state.items.map((i) => i.key).sort()).toEqual(["me/moonrise#5", "me/moonrise#6", "me/moonrise#9"]);
    expect(item(state, "me/moonrise#5")).toMatchObject({ kind: "pr", repoName: "Moonrise", why: ["authored", "assigned"], url: "https://github.com/me/moonrise/pull/5" });
    expect(item(state, "me/moonrise#6")).toMatchObject({ kind: "pr", why: ["review_requested"], author: "alice" });
    expect(item(state, "me/moonrise#9")).toMatchObject({ kind: "issue", why: ["assigned"], url: "https://github.com/me/moonrise/issues/9" });
    // Exactly the three shapes, each for your one project on github.com (Elsewhere is on gitlab.com, Local only has no remote).
    const sent = searches(mock);
    expect(sent).toHaveLength(3);
    for (const r of sent) {
      expect(SEARCH_QUERY.test(r.query.q!), r.query.q).toBe(true);
      expect(queryRepos(r.query.q!)).toEqual(["me/moonrise"]);
      expect(r.query).toMatchObject({ sort: "updated", order: "desc", per_page: "50" });
    }
  });

  it("what comes back is checked too: an item on another repository is left out, even if GitHub sent it", async () => {
    const { make, mock } = await started();
    mock.addPull("me", "moonrise", 6, { title: "Fix login", author: "alice", reviewers: ["sam-test"] });
    mock.addPull("stranger", "elsewhere", 1, { title: "Not one of yours", author: "bob", reviewers: ["sam-test"] });
    mock.searchIgnoresRepos = true;
    const engine = make();
    await engine.start();
    expect((await engine.myWork(true)).items.map((i) => i.key)).toEqual(["me/moonrise#6"]);
  });

  it("a fork's PR to its upstream is under the fork; a project whose origin that repository is wins it", async () => {
    const { base, make, mock, clock } = await started();
    const roots = path.join(base, "GitHub");
    const fork = makeRepo(roots, "Widget", "https://github.com/me/widget.git");
    git(fork, "remote", "add", "upstream", "https://github.com/acme/widget.git");
    const mirror = makeRepo(roots, "Mirror", "https://github.com/me/mirror.git");
    git(mirror, "remote", "add", "upstream", "https://gitlab.com/acme/mirror.git");
    mock.addPull("acme", "widget", 3, { title: "Widget fix", author: "sam-test" });
    const engine = make();
    await engine.start();
    let state = await engine.myWork(true);
    expect(item(state, "acme/widget#3")).toMatchObject({ repoName: "Widget" });
    const repos = new Set(searches(mock).flatMap((r) => queryRepos(r.query.q!)));
    expect([...repos].sort()).toEqual(["acme/widget", "me/mirror", "me/moonrise", "me/widget"]);
    // A clone of the upstream itself: its origin wins over the fork's upstream.
    makeRepo(roots, "Widget Upstream", "https://github.com/acme/widget.git");
    await engine.rescanProjects();
    clock.advance(61_000);
    state = await engine.myWork(true);
    expect(item(state, "acme/widget#3")).toMatchObject({ repoName: "Widget Upstream" });
  });

  it("says how many more GitHub found, and when the list may lack items (SSO partial results, an incomplete search)", async () => {
    const { make, mock } = await started();
    for (let n = 1; n <= 60; n++) mock.addPull("me", "moonrise", n, { title: `PR ${n}`, author: "sam-test", updatedAt: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString() });
    mock.searchSsoPartial = true;
    mock.searchIncomplete = true;
    const engine = make();
    await engine.start();
    const state = await engine.myWork(true);
    expect(state.items.filter((i) => i.why.includes("authored"))).toHaveLength(50);
    expect(state.more).toEqual({ review_requested: 0, authored: 10, assigned: 0 });
    expect(state.partial).toEqual({ sso: true, incomplete: true });
    // Newest first.
    expect(state.items[0]!.key).toBe("me/moonrise#60");
  });
});

describe("fetching", () => {
  it("each query keeps its ETag: 304s rebuild the list from the raw answers, one changed query brings its news", async () => {
    const { make, mock, clock } = await started();
    mock.addPull("me", "moonrise", 5, { title: "Dark mode", author: "sam-test" });
    mock.addIssue("me", "moonrise", 9, { title: "Crash on start", assignees: ["sam-test"] });
    const engine = make();
    await engine.start();
    expect((await engine.myWork(true)).items).toHaveLength(2);
    clock.advance(61_000);
    const again = await engine.myWork(true);
    expect(searches(mock).slice(3).map((r) => r.status)).toEqual([304, 304, 304]);
    expect(again.items.map((i) => i.key).sort()).toEqual(["me/moonrise#5", "me/moonrise#9"]);
    mock.addPull("me", "moonrise", 6, { title: "Fix login", author: "alice", reviewers: ["sam-test"] });
    clock.advance(61_000);
    const third = await engine.myWork(true);
    expect(searches(mock).slice(6).map((r) => r.status).sort()).toEqual([200, 304, 304]);
    expect(third.items.map((i) => i.key).sort()).toEqual(["me/moonrise#5", "me/moonrise#6", "me/moonrise#9"]);
    // An organisation's repositories left out (SSO) is said by a 304 too.
    mock.searchSsoPartial = true;
    clock.advance(61_000);
    const fourth = await engine.myWork(true);
    expect(searches(mock).slice(9).map((r) => r.status)).toEqual([304, 304, 304]);
    expect(fourth.partial).toEqual({ sso: true });
  });

  it("one fetch at a time, at most once a minute; without refresh the last list is kept", async () => {
    const { make, mock, clock } = await started();
    mock.addPull("me", "moonrise", 5, { title: "Dark mode", author: "sam-test" });
    const engine = make();
    await engine.start();
    const [a, b] = await Promise.all([engine.myWork(true), engine.myWork(true)]);
    expect(searches(mock)).toHaveLength(3);
    expect(a.items).toEqual(b.items);
    const soon = await engine.myWork(true);
    expect(searches(mock)).toHaveLength(3);
    expect(soon.checkedAt).toBe(a.checkedAt);
    clock.advance(61_000);
    await engine.myWork(false);
    expect(searches(mock)).toHaveLength(3);
    await engine.myWork(true);
    expect(searches(mock)).toHaveLength(6);
  });

  it("a fetch that answers after GitHub CLI's account changed is dropped, and the list is fetched as the new one", async () => {
    let token = MOCK_TOKEN;
    const { make, mock, clock } = await started({ tokens: (): TokenResult => ({ ok: true, token, source: "the mock" }) });
    mock.addPull("me", "moonrise", 5, { title: "Dark mode", author: "sam-test" });
    const engine = make();
    await engine.start();
    await until(() => engine.getState().github.status === "ok");
    mock.delayMs = 300;
    const fetching = engine.myWork(true);
    await pause(100);
    token = "gho_workAccountToken000000000000000000";
    mock.token = token;
    mock.login = "sam-work";
    await engine.retryGitHub();
    const dropped = await fetching;
    expect(dropped.items).toEqual([]);
    expect(dropped.login).not.toBe("sam-test");
    mock.delayMs = 0;
    clock.advance(61_000);
    expect(await engine.myWork(true)).toMatchObject({ status: "ok", login: "sam-work" });
  });

  it("a project GitHub can't search (gone, renamed, not visible: a 422): found, left out and named; the rest is searched", async () => {
    const { base, make, mock, clock } = await started();
    makeRepo(path.join(base, "GitHub"), "Gone", "https://github.com/me/gone.git");
    mock.addPull("me", "moonrise", 5, { title: "Dark mode", author: "sam-test" });
    mock.searchRejectsUnknownRepos = true;
    const engine = make();
    await engine.start();
    const state = await engine.myWork(true);
    expect(state).toMatchObject({ status: "ok", partial: { unsearchable: ["Gone (me/gone)"] } });
    expect(state.items.map((i) => i.key)).toEqual(["me/moonrise#5"]);
    // GitHub was asked about the batch's repositories (a read each).
    expect(mock.count(/^\/repos\/me\/gone$/)).toBe(1);
    // The next refresh leaves it out without asking again, and still names it.
    clock.advance(61_000);
    const before = searches(mock).filter((r) => r.status === 422).length;
    const again = await engine.myWork(true);
    expect(searches(mock).filter((r) => r.status === 422).length).toBe(before);
    expect(again.partial).toMatchObject({ unsearchable: ["Gone (me/gone)"] });
    expect(searches(mock).slice(-3).every((r) => !queryRepos(r.query.q!).includes("me/gone"))).toBe(true);
  });

  it("a search that fails (a 5xx) doesn't fail the others: what answered is merged, the list says one failed, and the minute holds", async () => {
    const { make, mock } = await started();
    mock.addPull("me", "moonrise", 5, { title: "Dark mode", author: "sam-test" });
    // The first search (waiting for your review) fails all three tries.
    mock.failures.push({ path: /^\/search\/issues$/, status: 502, times: 3 });
    const engine = make();
    await engine.start();
    const state = await engine.myWork(true);
    expect(state).toMatchObject({ status: "ok", partial: { failed: 1 } });
    expect(state.items.map((i) => i.key)).toEqual(["me/moonrise#5"]);
    const sent = searches(mock).length;
    await engine.myWork(true);
    expect(searches(mock).length).toBe(sent);
  });

  it("what answered shows at once (status loading), before the last search answers", async () => {
    const { make, mock } = await started();
    mock.addPull("me", "moonrise", 6, { title: "Fix login", author: "alice", reviewers: ["sam-test"] });
    const engine = make();
    const events = record(engine);
    await engine.start();
    await engine.myWork(true);
    const lists = events.filter((e): e is Extract<typeof e, { type: "my_work" }> => e.type === "my_work").map((e) => e.myWork);
    expect(lists.some((s) => s.status === "loading" && s.items.some((i) => i.key === "me/moonrise#6"))).toBe(true);
    expect(lists.at(-1)).toMatchObject({ status: "ok" });
  });

  it("subsequent refreshes keep unpolled sections populated during loading and reconcile items in place without moving unchanged items", async () => {
    const { make, mock, clock } = await started();
    mock.addPull("me", "moonrise", 5, { title: "Dark mode", author: "sam-test", updatedAt: "2026-10-01T10:00:00Z" });
    mock.addPull("me", "moonrise", 6, { title: "Fix login", author: "alice", reviewers: ["sam-test"], updatedAt: "2026-10-01T09:00:00Z" });
    mock.addIssue("me", "moonrise", 9, { title: "Crash on start", assignees: ["sam-test"], updatedAt: "2026-10-01T08:00:00Z" });
    const engine = make();
    await engine.start();
    const first = await engine.myWork(true);
    expect(first.items.map((i) => i.key)).toEqual(["me/moonrise#5", "me/moonrise#6", "me/moonrise#9"]);

    // On the next sync:
    // - #6 (review_requested) is gone (removed from reviewers)
    // - #5 (authored) and #9 (assigned) are unchanged
    // - #11 (authored) is newly added
    mock.addPull("me", "moonrise", 6, { title: "Fix login", author: "alice", reviewers: [], updatedAt: "2026-10-01T09:00:00Z" });
    mock.addPull("me", "moonrise", 11, { title: "New feature", author: "sam-test", updatedAt: "2026-10-01T11:00:00Z" });

    const events = record(engine);
    clock.advance(61_000);
    const second = await engine.myWork(true);

    const loadingSnapshots = events
      .filter((e): e is Extract<typeof e, { type: "my_work" }> => e.type === "my_work")
      .map((e) => e.myWork)
      .filter((s) => s.status === "loading");

    // Every intermediate loading snapshot keeps #5 (authored) and #9 (assigned) instead of clearing them while #6 is polled first!
    expect(loadingSnapshots.length).toBeGreaterThanOrEqual(2);
    for (const snap of loadingSnapshots) {
      expect(snap.items.map((i) => i.key)).toContain("me/moonrise#5");
      expect(snap.items.map((i) => i.key)).toContain("me/moonrise#9");
    }

    // Final reconciled list has removed #6, added #11, and kept #5 and #9 in their relative order.
    expect(second.items.map((i) => i.key)).toEqual(["me/moonrise#11", "me/moonrise#5", "me/moonrise#9"]);
  });

  it("stopping ARIA aborts the fetch: no search goes out after", async () => {
    const { make, mock } = await started();
    const engine = make();
    await engine.start();
    await until(() => engine.getState().github.status === "ok");
    // The search on its way takes 1.5 s; stopping aborts it: the fetch ends well before GitHub would have answered.
    mock.delayMs = 1_500;
    const fetching = engine.myWork(true);
    await pause(150);
    const stoppedAt = Date.now();
    const stopping = engine.stop();
    await fetching;
    expect(Date.now() - stoppedAt).toBeLessThan(900);
    await stopping;
    await pause(1_800);
    expect(searches(mock).length).toBeLessThanOrEqual(1);
  });

  it("GitHub CLI signed out: the list and its ETags go", async () => {
    let result: TokenResult = { ok: true, token: MOCK_TOKEN, source: "the mock" };
    const { make, mock } = await started({ tokens: () => result });
    mock.addPull("me", "moonrise", 5, { title: "Dark mode", author: "sam-test" });
    const engine = make();
    await engine.start();
    expect((await engine.myWork(true)).items).toHaveLength(1);
    result = { ok: false, reason: "signed_out", message: "GitHub CLI isn't signed in." };
    await engine.retryGitHub();
    await until(() => engine.getState().github.status === "signed_out");
    expect((await engine.myWork(false)).items).toEqual([]);
  });

  it("the search limit used up: My work waits for its reset and says so; the watchers go on", async () => {
    const { make, mock, runtime, clock } = await started();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id });
    mock.searchRemaining = 0;
    mock.searchResetAt = Math.floor(clock.now() / 1000) + 60;
    const state = await engine.myWork(true);
    expect(state).toMatchObject({ status: "waiting", message: expect.stringMatching(/search limit/), until: expect.any(Number) });
    expect(engine.getState().github.status).toBe("ok");
    const polls = mock.count(new RegExp(`/actions/runs/${run.id}$`));
    clock.advance(30_000);
    await until(() => mock.count(new RegExp(`/actions/runs/${run.id}$`)) > polls);
  });
});

describe("watching from My work", () => {
  it("Watch by an item's key: one PR watch, yours, until merged, however often it's clicked; only My work's own PRs", async () => {
    const { make, mock } = await started();
    mock.addPull("me", "moonrise", 5, { title: "Dark mode", author: "sam-test" });
    mock.addIssue("me", "moonrise", 9, { title: "Crash on start", assignees: ["sam-test"] });
    const engine = make();
    await engine.start();
    await engine.myWork(true);
    const [a, b] = await Promise.all([engine.watchPullRequest("me/moonrise#5"), engine.watchPullRequest("me/moonrise#5")]);
    expect(a.id).toBe(b.id);
    expect(engine.getState().watches.filter((w) => w.kind === "pr" && w.state === "active")).toHaveLength(1);
    expect(watchOf(engine, "pr")).toMatchObject({ createdBy: "you", until: "merged", repoName: "Moonrise" });
    expect(item(await engine.myWork(false), "me/moonrise#5")).toMatchObject({ watchId: a.id });
    await expect(engine.watchPullRequest("me/moonrise#9")).rejects.toThrow(/isn't in My work/);
    await expect(engine.watchPullRequest("attacker/repo#1")).rejects.toThrow(/isn't in My work/);
  });

  it("default-branch CI by the project's id: of two projects with the same folder name, the one asked for; off by its watch's id", async () => {
    const { base, make, mock } = await started();
    const other = makeRepo(path.join(base, "Work"), "Moonrise", "https://github.com/me/moonrise-two.git");
    mock.addRepo("me", "moonrise-two");
    const engine = make();
    await engine.start();
    // Another folder called Moonrise, added by hand: two projects with one name.
    await engine.addProjectFolder(other);
    const second = engine.getState().projects.find((p) => p.name === "Moonrise" && p.repo === "moonrise-two")!;
    expect(engine.getState().projects.filter((p) => p.name === "Moonrise")).toHaveLength(2);
    const watch = await engine.watchDefaultBranch(second.id);
    expect(watch).toMatchObject({ kind: "branch", until: "forever", repoId: second.id, url: expect.stringContaining("me/moonrise-two") });
    engine.unwatch(watch.id);
    expect(engine.getState().watches.find((w) => w.id === watch.id)).toMatchObject({ state: "ended", endedReason: "unwatched" });
  });
});

describe("ARIA never sees My work (D37's reasoning; the duck's point 7)", () => {
  it("nothing of the list is in its prompt or a tool's result; a PR you watch is, as a watch, quoted", async () => {
    const { make, mock, runtime } = await started();
    mock.addPull("me", "moonrise", 5, { title: "ZEBRA authored title", author: "sam-test" });
    mock.addPull("me", "moonrise", 6, { title: "ZEBRA review title", author: "zebra-author", reviewers: ["sam-test"] });
    mock.addIssue("me", "moonrise", 9, { title: "ZEBRA issue title", author: "zebra-author", assignees: ["sam-test"] });
    const engine = make();
    await engine.start();
    expect((await engine.myWork(true)).items).toHaveLength(3);
    runtime.replies.push({ text: "ok" });
    await engine.sendMessage("What's new?");
    await until(() => lastPrompt(runtime).includes("What's new?"));
    expect(lastPrompt(runtime)).not.toMatch(/ZEBRA|zebra-author/);
    expect(JSON.stringify(await ariaCalls(engine, runtime, "list_watches", {}))).not.toMatch(/ZEBRA|zebra-author/);
    expect(JSON.stringify(await ariaCalls(engine, runtime, "list_repos", {}))).not.toMatch(/ZEBRA|zebra-author/);
    // You watch one: that PR is a watch now, which ARIA sees quoted (as for any watch you start); the rest still isn't.
    await engine.watchPullRequest("me/moonrise#5");
    const listed = JSON.stringify(await ariaCalls(engine, runtime, "list_watches", {}));
    expect(listed).toContain("ZEBRA authored title");
    expect(listed).not.toMatch(/ZEBRA review title|ZEBRA issue title|zebra-author/);
    runtime.replies.push({ text: "ok" });
    await engine.sendMessage("And now?");
    await until(() => lastPrompt(runtime).includes("And now?"));
    expect(lastPrompt(runtime)).not.toMatch(/ZEBRA review title|ZEBRA issue title|zebra-author/);
  });
});
