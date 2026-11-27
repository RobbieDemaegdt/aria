/**
 * GitHub's news in the attention loop (PLAN.md §4.3, §4.5, D24, D36, D37): its own bucket in the digest (a flapping
 * branch can't push a task's news out), the away card's GitHub group, the coalesced toast's words, notices said once
 * per change (also across restarts), and the caps on what's watched.
 */
import path from "node:path";
import type { CardItem, EngineEvent } from "@aria/protocol";
import { describe, expect, it } from "vitest";
import { Attention, COALESCE_MS, DEFAULT_ATTENTION, type AttentionEvent } from "../src/attention/attention.ts";
import { ManualClock } from "../src/attention/clock.ts";
import { acmeTracker } from "./helpers/acme.ts";
import { Digest, DIGEST_LINES, GITHUB_LINES } from "../src/attention/digest.ts";
import { Store } from "../src/store/store.ts";
import { MAX_ACTIVE, MAX_BY_ARIA, MAX_BY_PEOPLE } from "../src/watchers/watchers.ts";
import { cleanUpAfterEach, ariaCalls, notices, pause, setupGitHub, until, watchOf } from "./github-helpers.ts";
import { MOCK_TOKEN } from "./mock-github.ts";

cleanUpAfterEach();

describe("the digest's GitHub bucket", () => {
  const digest = () => {
    const store = new Store(":memory:");
    return new Digest({ db: () => store, pending: () => [] });
  };

  it("keeps the newest line per watch and kind of news, at most 8, after the task lines (which keep their 20)", () => {
    const d = digest();
    for (let i = 0; i < 25; i++) d.add(`[done] task ${i}`);
    // A flapping branch: one line, with how many came before it.
    for (let i = 0; i < 5; i++) d.addGitHub("1:ci", `[ci] main is ${i % 2 ? "green" : "red"} (W-1)`);
    // A PR's checks and its review are two lines.
    d.addGitHub("2:ci", "[ci] checks on PR #3 failed (W-2)");
    d.addGitHub("2:review", "[review] PR #3: approved (W-2)");
    for (let i = 3; i < 13; i++) d.addGitHub(`${i}:ci`, `[ci] run ${i} succeeded (W-${i})`);
    const text = d.build().text!;
    const lines = text.split("\n");
    expect(lines.filter((l) => l.startsWith("- [done]"))).toHaveLength(DIGEST_LINES);
    expect(lines.filter((l) => /^- \[(ci|review)\]/.test(l))).toHaveLength(GITHUB_LINES);
    expect(text).toContain("- (5 more GitHub updates left out: list_watches has the current state)");
    // The newest eight: the flapping branch's line was among the older ones.
    expect(text).not.toContain("main is");
    const d2 = digest();
    for (let i = 0; i < 5; i++) d2.addGitHub("1:ci", `[ci] main is ${i % 2 ? "green" : "red"} (W-1)`);
    d2.addGitHub("2:ci", "[ci] checks on PR #3 failed (W-2)");
    d2.addGitHub("2:review", "[review] PR #3: approved (W-2)");
    const two = d2.build().text!;
    expect(two).toContain("- [ci] main is red (W-1) (and 4 earlier updates of it)");
    expect(two).toContain("- [ci] checks on PR #3 failed (W-2)");
    expect(two).toContain("- [review] PR #3: approved (W-2)");
  });

  it("drains what a message carried; a line that came after the digest was built waits for the next one", () => {
    const d = digest();
    d.addGitHub("1:ci", "[ci] first (W-1)");
    const block = d.build();
    d.addGitHub("1:ci", "[ci] second (W-1)");
    d.addGitHub("2:ci", "[ci] other (W-2)");
    d.drain(block.upTo);
    const next = d.build().text!;
    expect(next).toContain("[ci] second (W-1) (and 1 earlier update of it)");
    expect(next).toContain("[ci] other (W-2)");
    d.drain(d.build().upTo);
    expect(d.build().text).toBeUndefined();
  });
});

describe("the attention engine with GitHub's news", () => {
  function setup() {
    const clock = new ManualClock(1_000_000_000);
    const toasts: Array<Extract<EngineEvent, { type: "toast" }>> = [];
    const cards: CardItem[] = [];
    let n = 0;
    const attention = new Attention({
      tracker: () => acmeTracker,
      clock,
      settings: () => DEFAULT_ATTENTION,
      emit: (e) => {
        if (e.type === "toast") toasts.push(e);
      },
      addCard: (c) => cards.push(c),
      waiting: () => [],
      taskState: () => "done",
      newId: () => `t${++n}`,
    });
    return { clock, toasts, cards, attention };
  }
  const github = (kind: AttentionEvent["kind"], id: number, title: string): AttentionEvent => ({ kind, title: `CI · ${title}`, body: "4m12s", watch: { id, title, repoName: "Moonrise" }, cardId: `ci-${id}` });

  it("a toast group with GitHub's news says how many updates, with their names (only Done says 'tasks finished')", () => {
    const { attention, toasts, clock } = setup();
    attention.setPresence(false);
    attention.event(github("ci_failure", 1, "deploy #482"));
    attention.event({ kind: "done", title: "Docs is done", body: "1 file", task: { id: "t", title: "Docs", repoName: "Moonrise" }, cardId: "done-t" });
    attention.event(github("review", 2, "PR #37 Dark mode"));
    clock.advance(COALESCE_MS);
    expect(toasts.at(-1)).toMatchObject({ title: "3 updates", body: "CI · deploy #482, Docs and CI · PR #37 Dark mode", replaces: "t1" });
  });

  it("GitHub's news in a group is named by its own toast's title, each once (two review requests from the inbox, a PR's checks and review)", () => {
    const { attention, toasts, clock } = setup();
    attention.setPresence(false);
    const inbox = { id: 9, title: "GitHub inbox", repoName: "GitHub" };
    attention.event({ kind: "review_request", title: "Review requested · me/moonrise#12", body: "Fix login", watch: inbox, cardId: "pr-a" });
    attention.event({ kind: "review_request", title: "Review requested · me/moonrise#13", body: "Dark mode", watch: inbox, cardId: "pr-b" });
    attention.event({ kind: "ci_success", title: "CI · Moonrise · checks on PR #37 passed", body: "", watch: { id: 3, title: "PR #37", repoName: "Moonrise" }, cardId: "pr-c" });
    attention.event({ kind: "ci_success", title: "CI · Moonrise · checks on PR #37 passed", body: "", watch: { id: 3, title: "PR #37", repoName: "Moonrise" }, cardId: "pr-d" });
    clock.advance(COALESCE_MS);
    expect(toasts.at(-1)).toMatchObject({ title: "4 updates", body: "Review requested · me/moonrise#12, Review requested · me/moonrise#13 and CI · Moonrise · checks on PR #37 passed" });
  });

  it("the away card has a GitHub group, each line taking you to its card; a PR you merged yourself isn't news", () => {
    const { attention, clock, cards } = setup();
    attention.setPresence(true);
    attention.setPresence(false);
    attention.event(github("ci_failure", 1, "deploy #482"));
    attention.event(github("pr_closed_yours", 2, "PR #37"));
    attention.event({ kind: "github_account", title: "GitHub: ARIA now reads GitHub as @work", body: "2 watches are paused.", cardId: "account-1" });
    clock.advance(20 * 60_000);
    attention.setPresence(true);
    const away = cards.find((c) => c.cardType === "away_digest") as Extract<CardItem, { cardType: "away_digest" }>;
    expect(away.payload.lines).toEqual([
      { kind: "github", watchId: 1, title: "CI · deploy #482", repoName: "Moonrise", text: "4m12s", cardId: "ci-1" },
      { kind: "github", title: "GitHub: ARIA now reads GitHub as @work", repoName: "GitHub", text: "2 watches are paused.", cardId: "account-1" },
    ]);
  });
});

describe("notices about GitHub access", () => {
  it("say a problem once per change, also across restarts, and once when it works again", async () => {
    let result: { ok: true; token: string; source: string } | { ok: false; reason: "no_cli"; message: string } = { ok: false, reason: "no_cli", message: "ARIA can't find GitHub CLI." };
    const { make, clock } = await setupGitHub({ tokens: () => result });
    let engine = make();
    await engine.start();
    clock.advance(0);
    await until(() => notices(engine, "github_access").length === 1);
    expect(engine.getState().github).toMatchObject({ status: "no_cli", message: "ARIA can't find GitHub CLI." });
    // Nothing tries again on its own, and Try again with the same answer says nothing new.
    clock.advance(3_600_000);
    await engine.retryGitHub();
    await pause();
    expect(notices(engine, "github_access")).toHaveLength(1);
    await engine.stop();
    engine = make();
    await engine.start();
    clock.advance(0);
    await pause(150);
    expect(engine.getState().github.status).toBe("no_cli");
    expect(notices(engine, "github_access")).toHaveLength(1);
    result = { ok: true, token: MOCK_TOKEN, source: "the mock" };
    await engine.retryGitHub();
    await until(() => notices(engine, "github_access").length === 2);
    expect(engine.getState().timeline.filter((i) => i.kind === "notice" && i.cause === "github_access").at(-1)).toMatchObject({ level: "info", message: "GitHub works again (as @sam-test): watches go on." });
  });
});

describe("caps on what's watched", () => {
  it(`ARIA starts at most ${MAX_BY_ARIA}; ${MAX_ACTIVE} in all`, async () => {
    const { make, mock, runtime, dataDir } = await setupGitHub();
    const runs = Array.from({ length: MAX_BY_ARIA + 1 }, () => mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" }));
    const engine = make();
    await engine.start();
    await until(() => watchOf(engine, "inbox") !== undefined);
    const watchers = (engine as unknown as { watchers: { create(r: unknown, by: string, taskId?: string): Promise<{ kind: string; reason?: string }> } }).watchers;
    for (const run of runs.slice(0, MAX_BY_ARIA)) expect((await watchers.create({ kind: "run", owner: "me", repo: "moonrise", runId: run.id }, "aria")).kind).toBe("created");
    const refused = (await ariaCalls(engine, runtime, "watch", { what: "run", repo: "Moonrise", runId: runs.at(-1)!.id })) as { error?: string };
    expect(refused.error).toMatch(/started 20 watches already/);
    // You can still start more, up to the 45 you and ARIA may take together (the duck's point 4: a reserve).
    const newRun = () => mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const yours = Array.from({ length: MAX_BY_PEOPLE - MAX_BY_ARIA }, newRun);
    for (const run of yours) expect((await watchers.create({ kind: "run", owner: "me", repo: "moonrise", runId: run.id }, "you")).kind).toBe("created");
    expect(await watchers.create({ kind: "run", owner: "me", repo: "moonrise", runId: newRun().id }, "you")).toMatchObject({ kind: "refused", reason: expect.stringMatching(/kept for tasks and the inbox/) });
    // The last places are for tasks (item 3's watch of the PR it opens) and the inbox, up to the cap of all of them.
    const forTasks = Array.from({ length: MAX_ACTIVE - MAX_BY_PEOPLE - 1 }, newRun);
    for (const run of forTasks) expect((await watchers.create({ kind: "run", owner: "me", repo: "moonrise", runId: run.id }, "task", "t-1")).kind).toBe("created");
    expect(engine.getState().watches.filter((w) => w.state === "active")).toHaveLength(MAX_ACTIVE);
    const one = newRun();
    expect(await watchers.create({ kind: "run", owner: "me", repo: "moonrise", runId: one.id }, "task", "t-1")).toMatchObject({ kind: "refused", reason: expect.stringMatching(/50 things are watched/) });
    // The inbox off, its place taken: turning it on again is refused, and isn't remembered as on (D37).
    await engine.setInboxWatch(false);
    expect((await watchers.create({ kind: "run", owner: "me", repo: "moonrise", runId: one.id }, "task", "t-1")).kind).toBe("created");
    await expect(engine.setInboxWatch(true)).rejects.toThrow(/50 things are watched/);
    expect(engine.getState().github.inbox).toBe(false);
    const store = new Store(path.join(dataDir, "aria.db"));
    try {
      expect(store.getSetting("github.inbox")).toBe("off");
    } finally {
      store.close();
    }
  }, 60_000);
});

describe("the caps under clicks at once (item 2, review round 1)", () => {
  it("three watches started at once with one place left: one starts; the inbox you turn on isn't one of your 45", async () => {
    const { make, mock } = await setupGitHub();
    const newRun = () => mock.addRun("me", "moonrise", { name: "deploy", status: "in_progress" });
    const engine = make();
    await engine.start();
    await until(() => watchOf(engine, "inbox") !== undefined);
    const watchers = (engine as unknown as { watchers: { create(r: unknown, by: string): Promise<{ kind: string; reason?: string }> } }).watchers;
    for (let i = 0; i < MAX_BY_PEOPLE - 1; i++) expect((await watchers.create({ kind: "run", owner: "me", repo: "moonrise", runId: newRun().id }, "you")).kind).toBe("created");
    // Each waits for its first look before it's written: the caps are checked again as it's written.
    const outcomes = await Promise.all([newRun(), newRun(), newRun()].map((run) => watchers.create({ kind: "run", owner: "me", repo: "moonrise", runId: run.id }, "you")));
    expect(outcomes.map((o) => o.kind).sort()).toEqual(["created", "refused", "refused"]);
    expect(engine.getState().watches.filter((w) => w.state === "active" && w.createdBy === "you")).toHaveLength(MAX_BY_PEOPLE);
    // The inbox off and on again, by you, with your 45 on.
    await engine.setInboxWatch(false);
    await engine.setInboxWatch(true);
    expect(watchOf(engine, "inbox")).toMatchObject({ createdBy: "you" });
    // Your inbox isn't counted among your 45 either: with one run stopped, one more starts.
    engine.unwatch(engine.getState().watches.find((w) => w.state === "active" && w.kind === "run")!.id);
    expect((await watchers.create({ kind: "run", owner: "me", repo: "moonrise", runId: newRun().id }, "you")).kind).toBe("created");
  }, 60_000);
});

describe("list_repos names only github.com as GitHub", () => {
  it("another host's remote is named with its host, and a project without one has neither", async () => {
    const { make, runtime } = await setupGitHub();
    const engine = make();
    await engine.start();
    const repos = (await ariaCalls(engine, runtime, "list_repos", {})) as Array<Record<string, string>>;
    expect(repos.find((r) => r.name === "Moonrise")).toMatchObject({ github: "me/moonrise" });
    expect(repos.find((r) => r.name === "Elsewhere")).toMatchObject({ remote: "gitlab.com/me/elsewhere" });
    expect(repos.find((r) => r.name === "Elsewhere")).not.toHaveProperty("github");
    expect(repos.find((r) => r.name === "Local only")).not.toHaveProperty("github");
    expect(repos.find((r) => r.name === "Local only")).not.toHaveProperty("remote");
  });
});
