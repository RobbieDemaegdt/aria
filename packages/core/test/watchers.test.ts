/**
 * GitHub's watchers inside ARIA (PLAN.md §4.6, §4.10, D36, D37): the scheduler on a manual clock, against the local
 * mock GitHub, through the engine (its cards, attention, digest and ARIA's tools). Nothing leaves this PC.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/store/store.ts";
import { MOCK_TOKEN } from "./mock-github.ts";
import { cards, cleanUpAfterEach, ariaCalls, lastPrompt, notices, pause, record, setupGitHub as setup, until, watchOf } from "./github-helpers.ts";

cleanUpAfterEach();

describe("the inbox (D37)", () => {
  it("is on from the first start, with one notice; your choice to turn it off lasts", async () => {
    const { make, mock } = await setup();
    let engine = make();
    const events = record(engine);
    const lastGitHub = () => events.filter((e) => e.type === "github").at(-1);
    await engine.start();
    await until(() => watchOf(engine, "inbox") !== undefined);
    expect(notices(engine, "github_inbox")).toHaveLength(1);
    expect(engine.getState().github).toMatchObject({ inbox: true });
    // The window hears the switch too (it's part of GitHub's state), with the login.
    await until(() => lastGitHub()?.type === "github");
    expect(lastGitHub()).toMatchObject({ github: { status: "ok", login: "sam-test", inbox: true } });
    const inbox = watchOf(engine, "inbox")!;
    expect(inbox).toMatchObject({ createdBy: "system", until: "forever", title: "GitHub inbox" });
    await engine.setInboxWatch(false);
    expect(watchOf(engine, "inbox")).toBeUndefined();
    expect(lastGitHub()).toMatchObject({ github: { inbox: false } });
    await engine.stop();
    const looked = mock.count(/^\/notifications$/);
    engine = make();
    await engine.start();
    await pause(400);
    expect(watchOf(engine, "inbox")).toBeUndefined();
    expect(notices(engine, "github_inbox")).toHaveLength(1);
    // Off: GitHub isn't even asked for your notifications.
    expect(mock.count(/^\/notifications$/)).toBe(looked);
    await engine.setInboxWatch(true);
    expect(watchOf(engine, "inbox")).toMatchObject({ createdBy: "you" });
    expect(mock.requests.every((r) => r.method === "GET" && r.authorized)).toBe(true);
  });
});

describe("watching a run", () => {
  it("ARIA watches the deploy workflow; when it finishes there's one card, a toast while you're away, and an [ci] line", async () => {
    const { make, mock, runtime, clock } = await setup();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress", run_started_at: new Date(clock.now() - 180_000).toISOString() });
    const engine = make();
    await engine.start();
    const events = record(engine);
    engine.setPresence(false);
    const result = (await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", workflow: "deploy.yml" })) as Record<string, unknown>;
    expect(result).toMatchObject({ watching: expect.stringMatching(/^W-\d+$/), watch: { kind: "run", project: "Moonrise", status: "in progress for 3 min", until: "completed", startedBy: "aria", fromGitHub: { title: `"deploy #${run.run_number}"` } } });
    const watch = watchOf(engine, "run")!;
    expect(watch).toMatchObject({ repoName: "Moonrise", tone: "running", url: `https://github.com/me/moonrise/actions/runs/${run.id}` });
    // Nothing more until it's due.
    const before = mock.count(/\/actions\/runs\/\d+$/);
    clock.advance(20_000);
    await pause();
    expect(mock.count(/\/actions\/runs\/\d+$/)).toBe(before);
    mock.finishRun(run.id, "success");
    clock.advance(11_000);
    await until(() => cards(engine, "ci").length === 1);
    expect(cards(engine, "ci")[0]!.payload).toMatchObject({ watchId: watch.id, source: "run", outcome: "success", repoName: "Moonrise", runId: run.id });
    expect(events.filter((e) => e.type === "toast")).toEqual([expect.objectContaining({ priority: "milestone", title: `CI · Moonrise · deploy #${run.run_number} succeeded` })]);
    expect(engine.getState().watches.find((w) => w.id === watch.id)).toMatchObject({ state: "ended", endedReason: "completed" });
    // It reported once: later ticks ask nothing more.
    const after = mock.requests.length;
    clock.advance(60_000);
    await pause();
    expect(mock.requests.length - after).toBeLessThanOrEqual(1);
    runtime.replies.push({ text: "noted" });
    await engine.sendMessage("anything new?");
    await until(() => lastPrompt(runtime).endsWith("anything new?"));
    expect(lastPrompt(runtime)).toContain(`[ci] Moonrise: "deploy" #${run.run_number} on "main" succeeded in 4m12s. (${watch.shortId})`);
  });

  it("an answer cut off after its headers isn't taken (nor its ETag): the poll is made again and the finished run is told", async () => {
    const { make, mock, runtime, clock } = await setup();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id });
    mock.finishRun(run.id, "success");
    // The finished run's 200, with its new ETag, cut after the headers (and after Octokit's retries' first try).
    const path = new RegExp(`/actions/runs/${run.id}$`);
    mock.cutAfterHeaders.push(path);
    const before = mock.requests.filter((r) => path.test(r.path)).length;
    clock.advance(30_000);
    await until(() => cards(engine, "ci").length === 1);
    expect(cards(engine, "ci")[0]!.payload).toMatchObject({ outcome: "success", runId: run.id });
    // The cut one was asked for again (not answered by a 304 for an ETag it never really got).
    const after = mock.requests.filter((r) => path.test(r.path)).slice(before);
    expect(after.length).toBeGreaterThanOrEqual(2);
    expect(after.every((r) => r.status === 200)).toBe(true);
  });

  it("an already finished run isn't watched: ARIA is told how it went", async () => {
    const { make, mock, runtime } = await setup();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    mock.finishRun(run.id, "failure");
    const engine = make();
    await engine.start();
    const result = (await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id })) as Record<string, unknown>;
    expect(result).toMatchObject({ nothingToWatch: expect.stringMatching(/^finished: it failed/) });
    expect(watchOf(engine, "run")).toBeUndefined();
  });

  it("survives a restart: a run that finished while ARIA was closed makes one card at the start", async () => {
    const { make, mock, runtime, clock } = await setup();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    let engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id });
    await engine.stop();
    mock.finishRun(run.id, "failure");
    mock.jobs.set(run.id, [{ id: 7001, name: "test", status: "completed", conclusion: "failure" }]);
    engine = make();
    await engine.start();
    // Its next poll was due while ARIA was closed.
    clock.advance(30_000);
    await until(() => cards(engine, "ci").length === 1);
    expect(cards(engine, "ci")[0]!.payload).toMatchObject({ outcome: "failure", failed: [{ name: "test", jobId: 7001, runId: run.id }] });
    clock.advance(60_000);
    await pause();
    expect(cards(engine, "ci")).toHaveLength(1);
  });

  it("a clock set back since the last start doesn't keep a watch waiting: its next look is at most 15 minutes away", async () => {
    const { make, mock, runtime, clock } = await setup();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    let engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id });
    await engine.stop();
    // The clock goes back a day.
    clock.jump(-86_400_000);
    mock.finishRun(run.id, "success");
    engine = make();
    await engine.start();
    clock.advance(15 * 60_000);
    await until(() => cards(engine, "ci").length === 1);
  });
});

describe("a poll commits as a whole", () => {
  it("a PR poll whose later request fails keeps nothing of it: the next poll still sees the change and tells it", async () => {
    const { make, mock, runtime, clock } = await setup();
    const shaA = "1".repeat(40);
    const shaB = "2".repeat(40);
    mock.addPull("me", "moonrise", 37, { title: "Dark mode", headSha: shaA });
    mock.setChecks("me", "moonrise", shaA, [{ name: "test", status: "completed", conclusion: "success" }]);
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "pr", repo: "Moonrise", pr: 37 });
    const pullEtag = mock.requests.filter((r) => r.path.endsWith("/pulls/37") && r.status === 200).length;
    expect(pullEtag).toBe(1);
    // A push: a new head with finished checks, but the checks request fails this time (the retry plugin tries 3 times).
    (mock.pull("me", "moonrise", 37).head as { sha: string }).sha = shaB;
    mock.setChecks("me", "moonrise", shaB, [{ name: "test", status: "completed", conclusion: "failure" }]);
    mock.failures.push({ path: /\/check-runs$/, status: 500, times: 3 });
    clock.advance(121_000);
    await until(() => mock.count(/\/check-runs$/) >= 4);
    await pause();
    expect(cards(engine, "ci")).toHaveLength(0);
    const polled = mock.requests.filter((r) => r.path.endsWith("/pulls/37"));
    // The start (no ETag yet), then the failed poll (the start's ETag; GitHub's new answer and its ETag thrown away).
    expect(polled).toHaveLength(2);
    expect(polled[0]!.ifNoneMatch).toBeUndefined();
    expect(polled[1]).toMatchObject({ status: 200, ifNoneMatch: expect.stringMatching(/^W\//) });
    clock.advance(61_000);
    await until(() => cards(engine, "ci").length === 1);
    // The next poll sent the start's ETag again, not the one from the failed poll, so the change came again (a 200).
    const next = mock.requests.filter((r) => r.path.endsWith("/pulls/37"))[2]!;
    expect(next).toMatchObject({ status: 200, ifNoneMatch: polled[1]!.ifNoneMatch });
    expect(cards(engine, "ci")[0]!.payload).toMatchObject({ source: "checks", headSha: shaB, outcome: "failure" });
  });
});

describe("time, sleep and resume", () => {
  it("after a sleep (relative timers didn't fire), the next tick or a resume polls each due watch once", async () => {
    const { make, mock, runtime, clock } = await setup();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id });
    const before = mock.count(new RegExp(`/actions/runs/${run.id}$`));
    const polls = () => mock.count(new RegExp(`/actions/runs/${run.id}$`));
    clock.jump(3_600_000);
    await pause();
    expect(polls()).toBe(before);
    // The PC is back: the shell says so, and what's due is looked at right away (no timer needed).
    engine.systemResumed();
    await until(() => polls() === before + 1);
    await pause();
    expect(polls()).toBe(before + 1);
    // Without a resume, the next tick does it (once).
    clock.jump(3_600_000);
    await pause();
    expect(polls()).toBe(before + 1);
    clock.advance(5_000);
    await until(() => polls() === before + 2);
    await pause();
    expect(polls()).toBe(before + 2);
  });

  it("an expired watch gets one last poll: a result beats its time-out; otherwise it ends timed out, with a card", async () => {
    const { make, mock, runtime, clock } = await setup();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const other = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id, hours: 1 });
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: other.id, hours: 1 });
    mock.finishRun(run.id, "success");
    clock.jump(2 * 3_600_000);
    clock.advance(5_000);
    await until(() => cards(engine, "ci").length === 1 && cards(engine, "watch_ended").length === 1);
    expect(cards(engine, "watch_ended")[0]!.payload).toMatchObject({ reason: "timed_out", text: expect.stringMatching(/still in progress/) });
    expect(engine.getState().watches.filter((w) => w.state === "ended").map((w) => w.endedReason).sort()).toEqual(["completed", "timed_out"]);
  });
});

describe("GitHub's own state doesn't count against a watch", () => {
  it("offline: the watch waits (no failure), GitHub's state says so, and it goes on when GitHub is back", async () => {
    const { make, mock, runtime, clock } = await setup();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id });
    mock.failures.push({ path: /\/actions\/runs\//, status: 0, drop: true, times: 3 });
    clock.advance(30_000);
    await until(() => engine.getState().github.status === "offline");
    const watch = watchOf(engine, "run")!;
    expect(watch.error).toBeUndefined();
    expect(watch.tone).toBe("paused");
    mock.finishRun(run.id, "success");
    clock.advance(30_000);
    await until(() => cards(engine, "ci").length === 1);
    expect(engine.getState().github.status).toBe("ok");
  });

  it("three 404s end it, with a card; the first one asks gh again (it may be another account)", async () => {
    const { make, mock, runtime, clock, asked } = await setup();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id });
    const askedBefore = asked();
    mock.runs.delete(run.id);
    // Each 404 waits a minute before the next look: the clock moves 20 s per check.
    await until(() => {
      clock.advance(20_000);
      return cards(engine, "watch_ended").length === 1;
    });
    expect(mock.requests.filter((r) => r.path.endsWith(`/actions/runs/${run.id}`) && r.status === 404)).toHaveLength(3);
    expect(cards(engine, "watch_ended")[0]!.payload).toMatchObject({ reason: "not_found" });
    expect(asked()).toBeGreaterThan(askedBefore);
  });
});

describe("another GitHub account (gh auth switch)", () => {
  it("pauses the watches started as the old one (no 404s, no ends), with one card; Use @new resumes them", async () => {
    let token = MOCK_TOKEN;
    const { make, mock, runtime, clock } = await setup({ tokens: () => ({ ok: true, token, source: "the mock" }) });
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id });
    expect(watchOf(engine, "run")).toMatchObject({ account: "sam-test" });
    // gh now uses another account; a 401 makes ARIA ask gh again.
    token = "gho_workAccountToken000000000000000000";
    mock.token = token;
    mock.login = "sam-work";
    clock.advance(30_000);
    await until(() => cards(engine, "github_account").length === 1);
    const card = cards(engine, "github_account")[0]!;
    expect(card.payload).toMatchObject({ from: "sam-test", to: "sam-work" });
    expect(card.payload.watchIds.length).toBeGreaterThanOrEqual(1);
    expect(watchOf(engine, "run")).toMatchObject({ tone: "paused", paused: expect.stringMatching(/started as @sam-test/) });
    const asked = mock.count(/\/actions\/runs\//);
    clock.advance(120_000);
    await pause();
    expect(mock.count(/\/actions\/runs\//)).toBe(asked);
    expect(cards(engine, "watch_ended")).toHaveLength(0);
    mock.finishRun(run.id, "success");
    engine.useGitHubAccount(card.id);
    expect(watchOf(engine, "run")).toMatchObject({ account: "sam-work" });
    // It goes on, as @sam-work, at the next tick.
    await until(() => {
      clock.advance(5_000);
      return cards(engine, "ci").length === 1;
    });
    expect(mock.requests.filter((r) => r.path.endsWith(`/actions/runs/${run.id}`)).at(-1)).toMatchObject({ authorized: true, status: 200 });
    expect(cards(engine, "github_account")[0]!.payload.rebound).toBe(true);
  });

  it("ARIA can request switching GitHub CLI's account on a github_account card (switch_github_account), and clicking Switch runs gh auth switch and refreshes the login", async () => {
    let token = MOCK_TOKEN;
    const switchedTo: string[] = [];
    const { make, mock, runtime } = await setup({
      tokens: () => ({ ok: true, token, source: "the mock" }),
      switchAccount: async (user) => {
        switchedTo.push(user);
        token = "******";
        mock.token = token;
        mock.login = user;
        return { ok: true };
      },
    });
    const engine = make();
    await engine.start();
    await until(() => engine.getState().github.login === "sam-test");

    const proposed = (await ariaCalls(engine, runtime, "switch_github_account", {
      user: "@octocat-work",
      note: "Needed for the Contoso enterprise remote repository.",
    })) as Record<string, unknown>;
    expect(proposed).toMatchObject({
      to: "octocat-work",
      from: "sam-test",
      command: "gh auth switch --user octocat-work",
    });

    const accountCards = cards(engine, "github_account");
    expect(accountCards).toHaveLength(1);
    expect(accountCards[0]!.payload).toMatchObject({
      from: "sam-test",
      to: "octocat-work",
      requested: true,
      status: "pending",
      note: "Needed for the Contoso enterprise remote repository.",
    });

    // Nothing ran before the user's click.
    expect(switchedTo).toEqual([]);
    expect(engine.getState().github.login).toBe("sam-test");

    await engine.switchGitHubAccount(accountCards[0]!.id);
    expect(switchedTo).toEqual(["octocat-work"]);
    expect(engine.getState().github.login).toBe("octocat-work");
    expect(cards(engine, "github_account")[0]!.payload).toMatchObject({
      to: "octocat-work",
      requested: true,
      status: "done",
    });
  });
});

describe("what ARIA may watch (it reads other people's words: D19, D22)", () => {
  it("only the user's projects on github.com, never without an end, never the inbox, at most 168 hours", async () => {
    const { make, runtime } = await setup();
    const engine = make();
    await engine.start();
    const refusal = async (args: unknown) => {
      const result = (await ariaCalls(engine, runtime, "watch", args)) as { error?: string };
      return result.error ?? "";
    };
    expect(await refusal({ what: "pr", repo: "attacker/repo", pr: 1 })).toMatch(/isn't the repository of one of the user's projects/);
    expect(await refusal({ what: "pr", repo: "Elsewhere", pr: 1 })).toMatch(/not github\.com/);
    expect(await refusal({ what: "pr", repo: "Local only", pr: 1 })).toMatch(/no GitHub remote/);
    expect(await refusal({ what: "branch", repo: "Moonrise", until: "forever" })).toBeTruthy();
    expect(await refusal({ what: "run", repo: "Moonrise", runId: 1, hours: 500 })).toBeTruthy();
    expect(await refusal({ what: "pr", repo: "Moonrise", pr: 1, until: "completed" })).toMatch(/can wait for/);
    expect(engine.getState().watches.filter((w) => w.createdBy === "aria")).toEqual([]);
  });

  it("ARIA can stop the inbox (D37), and the chat says so", async () => {
    const { make, runtime } = await setup();
    const engine = make();
    await engine.start();
    await until(() => watchOf(engine, "inbox") !== undefined);
    const inbox = watchOf(engine, "inbox")!;
    expect(await ariaCalls(engine, runtime, "unwatch", { watch: inbox.shortId })).toMatchObject({ stopped: inbox.shortId });
    expect(notices(engine, "watch_stopped")).toHaveLength(1);
    expect(engine.getState().github.inbox).toBe(false);
  });
});

describe("the same thing watched again", () => {
  it("merges: the end condition widens to cover both, nothing is watched twice", async () => {
    const { make, mock, runtime } = await setup();
    mock.addPull("me", "moonrise", 37, { title: "Dark mode", headSha: "3".repeat(40) });
    mock.setChecks("me", "moonrise", "3".repeat(40), [{ name: "test", status: "in_progress" }]);
    const engine = make();
    await engine.start();
    const first = (await ariaCalls(engine, runtime, "watch", { what: "pr", repo: "Moonrise", pr: 37, until: "checks" })) as Record<string, string>;
    // Found by what it watches before anything is asked of GitHub.
    const asked = mock.requests.length;
    const second = (await ariaCalls(engine, runtime, "watch", { what: "pr", repo: "Moonrise", pr: 37, until: "success" })) as Record<string, string>;
    expect(mock.requests.slice(asked).filter((r) => r.path.includes("/pulls/37"))).toEqual([]);
    expect(second).toMatchObject({ alreadyWatching: first.watching, nowUntil: "success" });
    const third = (await ariaCalls(engine, runtime, "watch", { what: "pr", repo: "Moonrise", pr: 37, until: "checks" })) as Record<string, string>;
    expect(third).toMatchObject({ alreadyWatching: first.watching });
    expect(third).not.toHaveProperty("nowUntil");
    expect(engine.getState().watches.filter((w) => w.kind === "pr" && w.state === "active")).toHaveLength(1);
    expect(watchOf(engine, "pr")!.until).toBe("success");
  });
});

describe("quitting", () => {
  it("a poll still on its way when ARIA stops writes nothing after (read back from the database)", async () => {
    const { make, mock, runtime, clock, dataDir } = await setup();
    const run = mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: run.id });
    mock.finishRun(run.id, "success");
    mock.delayMs = 400;
    clock.advance(30_000);
    await pause(50);
    await engine.stop();
    await pause(700);
    const store = new Store(path.join(dataDir, "aria.db"));
    try {
      expect(store.listTimeline().filter((i) => i.kind === "card" && i.cardType === "ci")).toEqual([]);
      expect(store.listWatches({ state: "active" }).some((w) => w.kind === "run")).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("triggering a workflow from chat (run_workflow → workflow_dispatch card → auto-watch)", () => {
  it("proposes a workflow_dispatch card (WD-1), dispatches on confirm, and auto-watches the resulting run until completion", async () => {
    const { make, mock, runtime, clock } = await setup();
    const wfId = mock.addWorkflow("me", "moonrise", "Issue plans with comment approval", "issue-plans.yml");
    mock.addWorkflow("me", "moonrise", "Copilot cloud agent", "copilot", { path: "dynamic/copilot-swe-agent/copilot" });
    mock.branches.set("me/moonrise@main", "a".repeat(40));
    mock.spawnRunOnDispatch = true;

    const engine = make();
    await engine.start();

    // Dynamic workflows cannot be triggered with workflow_dispatch.
    const dynamicAttempt = (await ariaCalls(engine, runtime, "run_workflow", {
      repo: "Moonrise",
      workflow: "Copilot cloud agent",
    })) as { error?: string };
    expect(dynamicAttempt.error).toMatch(/dynamic GitHub workflow/);
    expect(mock.dispatched).toHaveLength(0);

    // Proposing the workflow creates a pending WD-1 card and does NOT dispatch yet (D19, D22).
    const proposed = (await ariaCalls(engine, runtime, "run_workflow", {
      repo: "Moonrise",
      workflow: "issue-plans.yml",
      note: "Run with default settings",
    })) as { proposed: string; card: string; ref: string; inputs: Record<string, string> };

    expect(proposed).toMatchObject({
      proposed: "WD-1",
      ref: "main",
      inputs: {},
    });
    expect(mock.dispatched).toHaveLength(0);

    const cardBefore = cards(engine, "workflow_dispatch")[0]!;
    expect(cardBefore.payload).toMatchObject({
      shortId: "WD-1",
      repoName: "Moonrise",
      owner: "me",
      repo: "moonrise",
      workflowId: wfId,
      workflowName: "Issue plans with comment approval",
      workflowPath: ".github/workflows/issue-plans.yml",
      ref: "main",
      inputs: {},
      status: "pending",
      revision: 1,
    });

    // User clicks "Run workflow" on the card (optionally editing inputs).
    await engine.confirmWorkflowDispatch({
      cardId: cardBefore.id,
      revision: cardBefore.payload.revision,
      inputs: { dry_run: "false" },
    });

    expect(mock.dispatched).toEqual([
      {
        owner: "me",
        repo: "moonrise",
        workflowId: String(wfId),
        body: { ref: "main", inputs: { dry_run: "false" } },
      },
    ]);

    const cardAfter = cards(engine, "workflow_dispatch")[0]!;
    expect(cardAfter.payload).toMatchObject({
      status: "done",
      edited: true,
      inputs: { dry_run: "false" },
      watchId: expect.any(Number),
    });

    // A run watch was automatically created and picked up the newly spawned run.
    const activeWatch = watchOf(engine, "run");
    expect(activeWatch).toBeDefined();
    expect(activeWatch!.id).toBe(cardAfter.payload.watchId);

    // Finish the spawned run and verify the CI card arrives.
    const spawnedRun = [...mock.runs.values()][0]!;
    mock.finishRun(spawnedRun.id, "success");
    await until(() => {
      clock.advance(15_000);
      return cards(engine, "ci").length === 1;
    });
    expect(cards(engine, "ci")[0]!.payload).toMatchObject({
      outcome: "success",
      runId: spawnedRun.id,
    });
  });

  it("doesn't take an older run for the one it triggered when it can't read the runs beforehand", async () => {
    const { make, mock, runtime, clock } = await setup();
    mock.addWorkflow("me", "moonrise", "Release", "release.yml");
    mock.branches.set("me/moonrise@main", "a".repeat(40));
    mock.addRun("me", "moonrise", { name: "Release", status: "completed", conclusion: "failure" });

    const engine = make();
    await engine.start();
    await ariaCalls(engine, runtime, "run_workflow", { repo: "Moonrise", workflow: "release.yml" });
    const card = cards(engine, "workflow_dispatch")[0]!;

    // The read before the dispatch fails; the watch's own, after it, doesn't.
    const runsRead = /\/actions\/workflows\/[^/]+\/runs$/;
    mock.failures.push({ path: runsRead, status: 404 });
    await engine.confirmWorkflowDispatch({ cardId: card.id, revision: card.payload.revision, inputs: {} });
    expect(cards(engine, "workflow_dispatch")[0]!.payload).toMatchObject({ status: "done", watchId: expect.any(Number) });

    // The older run is there all along, and it isn't this dispatch's.
    const reads = mock.count(runsRead);
    await until(() => {
      clock.advance(15_000);
      return mock.count(runsRead) >= reads + 2;
    });
    expect(cards(engine, "ci")).toHaveLength(0);

    const triggered = mock.addRun("me", "moonrise", { name: "Release", status: "completed", conclusion: "success" });
    await until(() => {
      clock.advance(15_000);
      return cards(engine, "ci").length === 1;
    });
    expect(cards(engine, "ci")[0]!.payload).toMatchObject({ outcome: "success", runId: triggered.id });
  });

  it("lets the user cancel a pending workflow_dispatch card", async () => {
    const { make, mock, runtime } = await setup();
    mock.addWorkflow("me", "moonrise", "Deploy", "deploy.yml");
    mock.branches.set("me/moonrise@main", "a".repeat(40));
    const engine = make();
    await engine.start();

    const proposed = (await ariaCalls(engine, runtime, "run_workflow", {
      repo: "Moonrise",
      workflow: "deploy.yml",
    })) as { card: string };

    engine.dismissWorkflowDispatch(proposed.card);
    expect(cards(engine, "workflow_dispatch")[0]!.payload.status).toBe("cancelled");
    expect(mock.dispatched).toHaveLength(0);
  });
});

