/**
 * The watchers' smaller guards (PLAN.md §4.6, the duck round of Phase 4 item 1): what a poll keeps (only the ETags it
 * used, under the login it read as), GitHub's own pacing (X-Poll-Interval, slow mode, SSO, a failing GitHub), an
 * expired watch GitHub can't be asked about, and what ARIA itself may start. Against the local mock, manual clock.
 */
import path from "node:path";
import type { TokenResult } from "../src/github/access.ts";
import { describe, expect, it, vi } from "vitest";
import { Store } from "../src/store/store.ts";
import type { Watchers } from "../src/watchers/watchers.ts";
import type { WatchData } from "../src/watchers/types.ts";
import { advanceUntil, cards, cleanUpAfterEach, ariaCalls, notices, pause, setupGitHub, until, watchOf } from "./github-helpers.ts";
import { MOCK_TOKEN, type MockGitHub } from "./mock-github.ts";
import type { ManualClock } from "../src/attention/clock.ts";

cleanUpAfterEach();
// Some of these step a manual clock through an hour of polls, each a real request to the mock.
vi.setConfig({ testTimeout: 60_000 });

const watchersOf = (engine: unknown) => (engine as { watchers: Watchers }).watchers;
/** No poll on its way (each takes ~170 ms through Octokit's plugins here). */
const idle = async (engine: unknown) => {
  await pause(10);
  await until(() => (watchersOf(engine) as unknown as { inFlight: Map<number, unknown> }).inFlight.size === 0);
};
/** The clock moves in steps of `stepMs`, each step's polls answered, until `check` holds. */
async function stepUntil(engine: unknown, clock: ManualClock, check: () => boolean, stepMs = 15_000, steps = 400): Promise<void> {
  for (let i = 0; i < steps && !check(); i++) {
    clock.advance(stepMs);
    await idle(engine);
  }
  if (!check()) throw new Error("condition not met");
}
const answered = (mock: MockGitHub, path: RegExp, status: number) => mock.requests.filter((r) => path.test(r.path) && r.status === status).length;

/** A setting, read from the database file (another connection). */
function setting(dataDir: string, key: string): unknown {
  const store = new Store(path.join(dataDir, "aria.db"));
  try {
    return store.getSetting<unknown>(key);
  } finally {
    store.close();
  }
}

/** A watch's stored JSON, read from the database file (another connection). */
function stored(dataDir: string, id: number): WatchData {
  const store = new Store(path.join(dataDir, "aria.db"));
  try {
    return store.getWatch(id)!.data as WatchData;
  } finally {
    store.close();
  }
}

describe("what a poll keeps", () => {
  it("only the ETags of the requests it used: an old head's checks drop out, and once told they're not kept", async () => {
    const { make, mock, runtime, clock, dataDir } = await setupGitHub();
    const shaA = "a".repeat(40);
    const shaB = "b".repeat(40);
    mock.addPull("me", "moonrise", 37, { title: "Dark mode", headSha: shaA });
    mock.setChecks("me", "moonrise", shaA, [{ name: "test", status: "in_progress" }]);
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "pr", repo: "Moonrise", pr: 37 });
    const id = watchOf(engine, "pr")!.id;
    expect(Object.keys(stored(dataDir, id).conditional).sort()).toEqual(["pull", "reviews", `checks:${shaA}`, `status:${shaA}`].sort());
    (mock.pull("me", "moonrise", 37).head as { sha: string }).sha = shaB;
    mock.setChecks("me", "moonrise", shaB, [{ name: "test", status: "completed", conclusion: "success" }]);
    await advanceUntil(clock, () => cards(engine, "ci").length === 1, 20_000);
    expect(Object.keys(stored(dataDir, id).conditional).sort()).toEqual(["pull", "reviews", `checks:${shaB}`, `status:${shaB}`].sort());
    // The next poll doesn't ask for the checks it told: their ETags go too.
    await advanceUntil(clock, () => Object.keys(stored(dataDir, id).conditional).length === 2, 20_000);
    expect(Object.keys(stored(dataDir, id).conditional).sort()).toEqual(["pull", "reviews"]);
  });

  it("a 304 for something it never read isn't taken as 'nothing changed'", async () => {
    const { make, mock, runtime } = await setupGitHub();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    mock.failures.push({ path: new RegExp(`/actions/runs/${run.id}$`), status: 304 });
    const engine = make();
    await engine.start();
    const result = (await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id })) as { error?: string };
    expect(result.error).toMatch(/nothing changed about something ARIA hadn't read/);
  });

  it("a poll that was reading when GitHub CLI's account changed keeps nothing (its ETags stay the old login's)", async () => {
    let token = MOCK_TOKEN;
    const { make, mock, runtime, clock, dataDir } = await setupGitHub({ tokens: (): TokenResult => ({ ok: true, token, source: "the mock" }) });
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id });
    const id = watchOf(engine, "run")!.id;
    token = "gho_workAccountToken000000000000000000";
    mock.token = token;
    mock.login = "sam-work";
    // The other account can't see the run: what the poll read as it (a 404) isn't this watch's.
    mock.runs.delete(run.id);
    clock.advance(30_000);
    await until(() => cards(engine, "github_account").length === 1);
    // The poll that was reading (its 401 came after gh switched) finishes; it isn't made again as the other account.
    await idle(engine);
    await pause(200);
    expect(mock.requests.some((r) => r.path.endsWith(`/actions/runs/${run.id}`) && r.status === 404)).toBe(false);
    const data = stored(dataDir, id);
    expect(data.failures).toBeUndefined();
    expect(Object.values(data.conditional).every((c) => c.login === "sam-test")).toBe(true);
    expect(data.account).toBe("sam-test");
  });
});

describe("GitHub's pacing", () => {
  it("X-Poll-Interval: the inbox isn't asked again before GitHub says", async () => {
    const { make, mock, clock } = await setupGitHub();
    mock.pollInterval = 180;
    const engine = make();
    await engine.start();
    await until(() => watchOf(engine, "inbox") !== undefined && mock.count(/^\/notifications$/) === 1);
    clock.advance(125_000);
    await pause(150);
    expect(mock.count(/^\/notifications$/)).toBe(1);
    clock.advance(60_000);
    await until(() => mock.count(/^\/notifications$/) === 2);
  });

  it("few requests left: every interval is four times as long", async () => {
    const { make, mock, runtime, clock } = await setupGitHub();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    mock.remaining = 300;
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id });
    const polls = () => mock.count(new RegExp(`/actions/runs/${run.id}$`));
    const before = polls();
    clock.advance(40_000);
    await pause(150);
    expect(polls()).toBe(before);
    clock.advance(90_000);
    await until(() => polls() === before + 1);
  });

  it("an organisation wanting SSO pauses only that watch, for an hour, and says why", async () => {
    const { make, mock, runtime, clock } = await setupGitHub();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id });
    mock.failures.push({ path: new RegExp(`/actions/runs/${run.id}$`), status: 403, headers: { "x-github-sso": "required; url=https://github.com/orgs/acme/sso?authorization_request=1" } });
    const polls = () => mock.count(new RegExp(`/actions/runs/${run.id}$`));
    clock.advance(30_000);
    await until(() => watchOf(engine, "run")?.tone === "paused");
    expect(watchOf(engine, "run")!.paused).toMatch(/acme/);
    const after = polls();
    clock.advance(30 * 60_000);
    await pause(150);
    expect(polls()).toBe(after);
    clock.advance(31 * 60_000);
    await until(() => polls() === after + 1);
  });

  it("GitHub failing (5xx after the retries): the watch backs off, it doesn't end", async () => {
    const { make, mock, runtime, clock } = await setupGitHub();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id });
    mock.failures.push({ path: new RegExp(`/actions/runs/${run.id}$`), status: 502, times: 3 });
    const polls = () => mock.count(new RegExp(`/actions/runs/${run.id}$`));
    clock.advance(30_000);
    await until(() => mock.requests.filter((r) => r.status === 502).length === 3);
    await pause(100);
    const after = polls();
    clock.advance(45_000);
    await pause(150);
    expect(polls()).toBe(after);
    clock.advance(20_000);
    await until(() => polls() === after + 1);
    expect(watchOf(engine, "run")).toMatchObject({ state: "active" });
  });
});

describe("an expired watch GitHub can't be asked about", () => {
  it("ends a day past its time-out, with its card", async () => {
    let result: TokenResult = { ok: true, token: MOCK_TOKEN, source: "the mock" };
    const { make, mock, runtime, clock } = await setupGitHub({ tokens: () => result });
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id, hours: 1 });
    // GitHub CLI signed out: the next 401 asks gh, which has no token now.
    result = { ok: false, reason: "signed_out", message: "GitHub CLI isn't signed in." };
    mock.token = "gho_revokedTokenNow0000000000000000000000";
    clock.advance(30_000);
    // What gh said, not "refused": signing in again is what helps.
    await until(() => engine.getState().github.status === "signed_out");
    expect(engine.getState().github.message).toBe("GitHub CLI isn't signed in.");
    clock.jump(3_600_000);
    clock.advance(5_000);
    await pause(100);
    expect(watchOf(engine, "run")).toBeDefined();
    clock.jump(86_400_000);
    clock.advance(5_000);
    await until(() => cards(engine, "watch_ended").length === 1);
    expect(cards(engine, "watch_ended")[0]!.payload).toMatchObject({ reason: "timed_out" });
  });
});

describe("what ARIA may start (its own call, past the tool's schema)", () => {
  it("never without an end, never the inbox, never past 168 hours; you can", async () => {
    const { make, mock } = await setupGitHub();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const engine = make();
    await engine.start();
    await until(() => watchOf(engine, "inbox") !== undefined);
    const watchers = watchersOf(engine);
    const repo = { owner: "me", repo: "moonrise" };
    expect(await watchers.create({ kind: "branch", ...repo, branch: "main", until: "forever" }, "aria")).toMatchObject({ kind: "refused", reason: expect.stringMatching(/only be turned on by the user/) });
    await engine.setInboxWatch(false);
    expect(await watchers.create({ kind: "inbox" }, "aria")).toMatchObject({ kind: "refused", reason: expect.stringMatching(/only be turned on by the user/) });
    expect(await watchers.create({ kind: "run", ...repo, runId: run.id, hours: 500 }, "aria")).toMatchObject({ kind: "refused", reason: expect.stringMatching(/between 1 and 168 hours/) });
    expect(await watchers.create({ kind: "run", ...repo, runId: run.id, hours: 500 }, "you")).toMatchObject({ kind: "created" });
    expect(await watchers.create({ kind: "branch", ...repo, branch: "main", until: "forever" }, "you")).toMatchObject({ kind: "created" });
  });
});

// Review round 1 of Phase 4 item 1: a time-out nothing reached, one counter for every failure, the inbox setting, the
// clock set back while running, GitHub not confirming the token at the start.

describe("a watch whose time is up while it isn't polled, or while its polls fail", () => {
  const SSO = { "x-github-sso": "required; url=https://github.com/orgs/acme/sso?authorization_request=1" };

  it("paused for single sign-on: it ends at its time-out, with its card", async () => {
    const { make, mock, runtime, clock } = await setupGitHub();
    mock.addPull("me", "moonrise", 5, { title: "Some PR" });
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "pr", repo: "Moonrise", pr: 5, hours: 1 });
    mock.failures.push({ path: /\/pulls\/5$/, status: 403, headers: SSO, times: 100_000 });
    await stepUntil(engine, clock, () => watchOf(engine, "pr")?.tone === "paused", 20_000);
    // Past its time-out, still within the hour of the SSO pause: nothing polls it, yet it ends.
    clock.jump(59 * 60_000);
    clock.advance(5_000);
    await until(() => cards(engine, "watch_ended").length === 1);
    expect(cards(engine, "watch_ended")[0]!.payload).toMatchObject({ reason: "timed_out", text: expect.stringMatching(/\(it was paused\)/) });
    expect(watchOf(engine, "pr")).toBeUndefined();
  });

  it("paused under another GitHub account: it ends at its time-out too", async () => {
    let token = MOCK_TOKEN;
    const { make, mock, runtime, clock } = await setupGitHub({ tokens: (): TokenResult => ({ ok: true, token, source: "the mock" }) });
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id, hours: 1 });
    token = "gho_workAccountToken000000000000000000";
    mock.token = token;
    mock.login = "sam-work";
    clock.advance(30_000);
    await until(() => cards(engine, "github_account").length === 1);
    await idle(engine);
    expect(watchOf(engine, "run")).toMatchObject({ tone: "paused" });
    clock.jump(3_600_000);
    clock.advance(5_000);
    await until(() => cards(engine, "watch_ended").length === 1);
    expect(cards(engine, "watch_ended")[0]!.payload).toMatchObject({ reason: "timed_out", text: expect.stringMatching(/\(it was paused\)/) });
  });

  it("its last poll at its time-out fails: it ends then, without backing off first", async () => {
    const { make, mock, runtime, clock } = await setupGitHub();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const runPath = new RegExp(`/actions/runs/${run.id}$`);
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id, hours: 1 });
    clock.jump(3_600_000);
    // One poll's worth of 502s (the retry plugin tries three times).
    mock.failures.push({ path: runPath, status: 502, times: 3 });
    clock.advance(5_000);
    await until(() => answered(mock, runPath, 502) === 3);
    await idle(engine);
    // No other tick: the failed poll itself ended it.
    expect(cards(engine, "watch_ended")).toHaveLength(1);
    expect(cards(engine, "watch_ended")[0]!.payload).toMatchObject({ reason: "timed_out", text: expect.stringMatching(/\(GitHub kept failing\)/) });
  });

  it("failing since before its time-out, its next try far off: it ends at the first tick past its time-out, without another request", async () => {
    const { make, mock, runtime, clock } = await setupGitHub();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const runPath = new RegExp(`/actions/runs/${run.id}$`);
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id, hours: 1 });
    clock.jump(40 * 60_000);
    clock.advance(5_000);
    await idle(engine);
    // From 40 minutes on, every poll fails: tries at about 40, 41, 43, 47 and 55 minutes, the next at about 70.
    mock.failures.push({ path: runPath, status: 502, times: 100_000 });
    await stepUntil(engine, clock, () => answered(mock, runPath, 502) === 5 * 3);
    const requests = mock.count(runPath);
    await stepUntil(engine, clock, () => cards(engine, "watch_ended").length === 1, 5_000);
    expect(mock.count(runPath)).toBe(requests);
    expect(cards(engine, "watch_ended")[0]!.payload).toMatchObject({ reason: "timed_out", text: expect.stringMatching(/\(GitHub kept failing\)/) });
  });
});

describe("404s and 403s in a row", () => {
  it("only three in a row end a watch: anything else between (a 502) starts the count again", async () => {
    const { make, mock, runtime, clock } = await setupGitHub();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const runPath = new RegExp(`/actions/runs/${run.id}$`);
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id });
    const answer = async (status: number) => {
      const before = answered(mock, runPath, status);
      // A 502 is tried three times (the retry plugin); a 404 once.
      const times = status === 502 ? 3 : 1;
      mock.failures.push({ path: runPath, status, times });
      await stepUntil(engine, clock, () => answered(mock, runPath, status) === before + times);
    };
    for (const status of [502, 502, 404, 404, 502, 404, 404]) await answer(status);
    expect(watchOf(engine, "run")).toMatchObject({ state: "active" });
    expect(cards(engine, "watch_ended")).toHaveLength(0);
    await answer(404);
    await until(() => cards(engine, "watch_ended").length === 1);
    expect(cards(engine, "watch_ended")[0]!.payload).toMatchObject({ reason: "not_found" });
  });

  it("the inbox isn't ended by them: it waits an hour at a time, says why once, its switch stays on, and goes on by itself", async () => {
    const { make, mock, clock, dataDir } = await setupGitHub();
    const inboxPath = /^\/notifications$/;
    let engine = make();
    await engine.start();
    await until(() => watchOf(engine, "inbox") !== undefined && mock.count(inboxPath) === 1);
    mock.failures.push({ path: inboxPath, status: 403, times: 100_000 });
    await stepUntil(engine, clock, () => answered(mock, inboxPath, 403) === 3);
    expect(watchOf(engine, "inbox")).toMatchObject({ state: "active", tone: "paused", paused: expect.stringMatching(/gh auth refresh -s notifications/) });
    expect(notices(engine, "github_inbox_access")).toHaveLength(1);
    expect(engine.getState().github.inbox).toBe(true);
    expect(setting(dataDir, "github.inbox")).toBe("on");
    // Not asked again within the hour; after it, asked again (still refused: not said again).
    clock.advance(30 * 60_000);
    await idle(engine);
    expect(answered(mock, inboxPath, 403)).toBe(3);
    await stepUntil(engine, clock, () => answered(mock, inboxPath, 403) === 4, 5 * 60_000);
    expect(notices(engine, "github_inbox_access")).toHaveLength(1);
    // `gh auth refresh -s notifications`: the token can read them now, and the inbox goes on by itself.
    mock.failures.splice(0);
    await stepUntil(engine, clock, () => watchOf(engine, "inbox")?.tone === "ok", 5 * 60_000);
    await engine.stop();
    engine = make();
    await engine.start();
    await until(() => watchOf(engine, "inbox") !== undefined);
    expect(watchOf(engine, "inbox")).toMatchObject({ createdBy: "system" });
  });
});

describe("the inbox waiting after 403s", () => {
  it("Try again, or its switch turned on, asks it at once; still refused, it waits again without saying it twice", async () => {
    const { make, mock, clock } = await setupGitHub();
    const inboxPath = /^\/notifications$/;
    const engine = make();
    await engine.start();
    await until(() => watchOf(engine, "inbox") !== undefined && mock.count(inboxPath) === 1);
    mock.failures.push({ path: inboxPath, status: 403, times: 100_000 });
    await stepUntil(engine, clock, () => answered(mock, inboxPath, 403) === 3);
    expect(watchOf(engine, "inbox")).toMatchObject({ tone: "paused", paused: expect.stringMatching(/gh auth refresh -s notifications/) });
    // The inbox's own Try again: no hour's wait (the clock doesn't move).
    engine.retryInbox();
    await until(() => answered(mock, inboxPath, 403) === 4);
    await idle(engine);
    expect(watchOf(engine, "inbox")).toMatchObject({ tone: "paused" });
    expect(notices(engine, "github_inbox_access")).toHaveLength(1);
    // gh's token can read notifications now; the switch turned on (it's on already) asks at once too.
    mock.failures.splice(0);
    await engine.setInboxWatch(true);
    await until(() => watchOf(engine, "inbox")?.tone === "ok");
    expect(watchOf(engine, "inbox")!.paused).toBeUndefined();
  });
});

describe("the inbox's setting says on only once its watch exists (D37)", () => {
  it("ARIA quits while it starts the inbox on the first run: the next start starts it, with its notice", async () => {
    const { make, mock, dataDir } = await setupGitHub();
    const inboxPath = /^\/notifications$/;
    // The inbox's first look stays unanswered until ARIA has quit, however slow the machine.
    const firstLook = mock.hold(inboxPath);
    let engine = make();
    await engine.start();
    await firstLook.arrived;
    await engine.stop();
    // Its answer comes after the quit: nothing of it is kept.
    firstLook.release();
    await until(() => mock.count(inboxPath) === 1);
    await pause(400);
    expect(setting(dataDir, "github.inbox")).toBeUndefined();
    engine = make();
    await engine.start();
    await until(() => watchOf(engine, "inbox") !== undefined);
    expect(notices(engine, "github_inbox")).toHaveLength(1);
    expect(setting(dataDir, "github.inbox")).toBe("on");
  });

  it("on, but without its watch (a start that didn't finish, all 50 taken): the next start starts it, without another notice", async () => {
    const { make, dataDir } = await setupGitHub();
    let engine = make();
    await engine.start();
    await until(() => watchOf(engine, "inbox") !== undefined);
    await engine.setInboxWatch(false);
    await engine.stop();
    const store = new Store(path.join(dataDir, "aria.db"));
    store.setSetting("github.inbox", "on");
    store.close();
    engine = make();
    await engine.start();
    await until(() => watchOf(engine, "inbox") !== undefined);
    expect(watchOf(engine, "inbox")).toMatchObject({ createdBy: "system" });
    expect(notices(engine, "github_inbox")).toHaveLength(1);
  });

  it("turned off while ARIA takes the inbox's first look on the first run: off it stays", async () => {
    const { make, mock, dataDir } = await setupGitHub();
    mock.delayMs = 300;
    let engine = make();
    await engine.start();
    await until(() => mock.count(/^\/user$/) >= 1);
    await engine.setInboxWatch(false);
    // The first look answers meanwhile.
    await until(() => mock.count(/^\/notifications$/) >= 1);
    await pause(100);
    expect(watchOf(engine, "inbox")).toBeUndefined();
    expect(engine.getState().github.inbox).toBe(false);
    await engine.stop();
    expect(setting(dataDir, "github.inbox")).toBe("off");
    mock.delayMs = 0;
    engine = make();
    await engine.start();
    await pause(300);
    expect(watchOf(engine, "inbox")).toBeUndefined();
  });
});

describe("the PC's clock set back while ARIA runs", () => {
  // ARIA's tick runs on a timer, which fires on time whatever the clock says; the manual clock's timers follow its
  // time, so a resume stands in for the first tick after the clock went back.
  it("watches keep their intervals", async () => {
    const { make, mock, runtime, clock } = await setupGitHub();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const runPath = new RegExp(`/actions/runs/${run.id}$`);
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id });
    clock.advance(5_000);
    await idle(engine);
    clock.jump(-2 * 3_600_000);
    engine.systemResumed();
    await idle(engine);
    const before = mock.count(runPath);
    for (let i = 0; i < 24; i++) {
      clock.advance(5_000);
      await idle(engine);
    }
    // A poll every 30 s: about 4 in 2 minutes (none at all if they waited for the clock to catch up).
    expect(mock.count(runPath) - before).toBeGreaterThanOrEqual(3);
  });

  it("a poll on its way when the clock goes back keeps its interval too", async () => {
    const { make, mock, runtime, clock } = await setupGitHub();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const runPath = new RegExp(`/actions/runs/${run.id}$`);
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id });
    await idle(engine);
    const id = watchOf(engine, "run")!.id;
    const inFlight = () => (watchersOf(engine) as unknown as { inFlight: Map<number, unknown> }).inFlight;
    // Its next poll starts; GitHub takes 800 ms to answer, and the clock goes back meanwhile.
    mock.delayMs = 800;
    clock.advance(30_000);
    await until(() => inFlight().has(id));
    clock.jump(-2 * 3_600_000);
    engine.systemResumed();
    await idle(engine);
    mock.delayMs = 0;
    const after = mock.count(runPath);
    for (let i = 0; i < 24; i++) {
      clock.advance(5_000);
      await idle(engine);
    }
    expect(mock.count(runPath) - after).toBeGreaterThanOrEqual(3);
  });

  it("a poll on its way that fails when the clock goes back backs off on the new clock", async () => {
    const { make, mock, runtime, clock } = await setupGitHub();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const runPath = new RegExp(`/actions/runs/${run.id}$`);
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id });
    await idle(engine);
    const id = watchOf(engine, "run")!.id;
    const inFlight = () => (watchersOf(engine) as unknown as { inFlight: Map<number, unknown> }).inFlight;
    mock.delayMs = 800;
    mock.failures.push({ path: runPath, status: 502, times: 3 });
    clock.advance(30_000);
    await until(() => inFlight().has(id));
    clock.jump(-2 * 3_600_000);
    engine.systemResumed();
    await until(() => answered(mock, runPath, 502) === 3);
    await idle(engine);
    mock.delayMs = 0;
    const after = mock.count(runPath);
    // Its back-off is a minute: on the new clock, not two hours on.
    for (let i = 0; i < 24; i++) {
      clock.advance(5_000);
      await idle(engine);
    }
    expect(mock.count(runPath) - after).toBeGreaterThanOrEqual(1);
  });

  it("a watch starting when the clock goes back gets its interval on the new clock", async () => {
    const { make, mock, clock } = await setupGitHub();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const runPath = new RegExp(`/actions/runs/${run.id}$`);
    const engine = make();
    await engine.start();
    await until(() => watchOf(engine, "inbox") !== undefined);
    await idle(engine);
    // Its first look takes 800 ms; the clock goes back meanwhile.
    mock.delayMs = 800;
    const creating = watchersOf(engine).create({ kind: "run", owner: "me", repo: "moonrise", runId: run.id }, "you");
    await pause(300);
    clock.jump(-2 * 3_600_000);
    engine.systemResumed();
    expect(await creating).toMatchObject({ kind: "created" });
    await idle(engine);
    mock.delayMs = 0;
    const after = mock.count(runPath);
    for (let i = 0; i < 24; i++) {
      clock.advance(5_000);
      await idle(engine);
    }
    expect(mock.count(runPath) - after).toBeGreaterThanOrEqual(3);
  });

  it("GitHub's own pause (offline) moves back with it", async () => {
    const { make, mock, runtime, clock } = await setupGitHub();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id });
    mock.failures.push({ path: /\/actions\/runs\//, status: 0, drop: true, times: 3 });
    await stepUntil(engine, clock, () => engine.getState().github.status === "offline", 5_000);
    clock.jump(-2 * 3_600_000);
    engine.systemResumed();
    mock.finishRun(run.id, "success");
    // Its 30 s pause is over 30 s later, not 2 hours later.
    await stepUntil(engine, clock, () => cards(engine, "ci").length === 1, 5_000, 24);
    expect(engine.getState().github.status).toBe("ok");
  });

  it("a signed-out GitHub CLI is asked again 10 minutes later by the clock that went back", async () => {
    let result: TokenResult = { ok: true, token: MOCK_TOKEN, source: "the mock" };
    const { make, mock, runtime, clock } = await setupGitHub({ tokens: () => result });
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id });
    result = { ok: false, reason: "signed_out", message: "GitHub CLI isn't signed in." };
    mock.token = "gho_revokedTokenNow0000000000000000000000";
    await stepUntil(engine, clock, () => engine.getState().github.status === "signed_out", 5_000);
    clock.jump(-2 * 3_600_000);
    engine.systemResumed();
    // `gh auth login` again.
    result = { ok: true, token: MOCK_TOKEN, source: "the mock" };
    mock.token = MOCK_TOKEN;
    for (let i = 0; i < 22; i++) {
      clock.advance(30_000);
      await idle(engine);
    }
    // 11 minutes on: gh was asked again (not 2 hours and 10 minutes on), and GitHub took its token.
    await until(() => engine.getState().github.status === "ok");
  });
});

describe("GitHub not confirming GitHub CLI's token at the start (a 5xx, a proxy's 403 page)", () => {
  it.each([500, 403])("%i: gh is asked at most twice a minute, the window says why (with Try again), and Try again goes on", async (status) => {
    const { make, mock, clock, asked } = await setupGitHub();
    mock.failures.push({ path: /^\/user$/, status, times: 100_000 });
    const engine = make();
    await engine.start();
    await until(() => engine.getState().github.status === "unavailable");
    expect(engine.getState().github).toMatchObject({ message: expect.stringMatching(/couldn't check GitHub CLI's sign-in/), pausedUntil: expect.any(Number) });
    const askedBefore = asked();
    const userBefore = mock.count(/^\/user$/);
    for (let i = 0; i < 12; i++) {
      clock.advance(5_000);
      await pause(60);
    }
    expect(asked() - askedBefore).toBeLessThanOrEqual(2);
    expect(mock.count(/^\/user$/) - userBefore).toBeLessThanOrEqual(6);
    expect(engine.getState().github.status).toBe("unavailable");
    // Its watches wait, saying why.
    expect(watchOf(engine, "inbox")).toMatchObject({ tone: "paused", paused: expect.stringMatching(/couldn't check/) });
    mock.failures.splice(0);
    await engine.retryGitHub();
    await until(() => engine.getState().github.status === "ok");
    expect(engine.getState().github).toMatchObject({ login: "sam-test" });
  });
});
