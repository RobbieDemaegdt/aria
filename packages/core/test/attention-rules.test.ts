/**
 * The attention engine (PLAN.md §4.5, §5.5, D24, D25): which toasts show, Done toasts coalesced, and the "while you were
 * away" card. On a manual clock: no real waiting.
 */
import type { AttentionSettings, CardItem, EngineEvent, TaskState } from "@aria/protocol";
import { describe, expect, it } from "vitest";
import { Attention, COALESCE_MS, DEFAULT_ATTENTION, PRIORITY, SETTLE_MS, UNLOCK_SETTLE_MS, type AttentionEvent, type AttentionKind, type WaitingItem } from "../src/attention/attention.ts";
import { ManualClock } from "../src/attention/clock.ts";
import { acmeTracker } from "./helpers/acme.ts";

type Toast = Extract<EngineEvent, { type: "toast" }>;
type AwayCard = Extract<CardItem, { cardType: "away_digest" }>;
const MIN = 60_000;

function setup(initial: Partial<AttentionSettings> = {}) {
  const clock = new ManualClock(1_000_000_000);
  const settings: AttentionSettings = { ...DEFAULT_ATTENTION, ...initial };
  const toasts: Toast[] = [];
  const cards: AwayCard[] = [];
  const state = { waiting: [] as WaitingItem[], gone: new Set<string>(), states: {} as Record<string, TaskState> };
  let n = 0;
  const attention = new Attention({
    tracker: () => acmeTracker,
    clock,
    settings: () => settings,
    emit: (event) => {
      if (event.type === "toast") toasts.push(event);
    },
    addCard: (card) => cards.push(card as AwayCard),
    waiting: () => state.waiting,
    taskState: (id) => (state.gone.has(id) ? undefined : (state.states[id] ?? "done")),
    newId: () => `t${++n}`,
  });
  return { clock, settings, toasts, cards, state, attention };
}

const ev = (kind: AttentionKind, id = "a"): AttentionEvent => ({ kind, title: `${id}: ${kind}`, body: `${kind} of ${id}`, task: { id, title: `Task ${id}`, repoName: "Repo" }, cardId: `card-${kind}-${id}` });
const waiting = (taskId: string, at: number, extra: Partial<WaitingItem> = {}): WaitingItem => ({ kind: "question", shortId: "Q-1", taskId, title: `Task ${taskId}`, repoName: "Repo", text: "asks: which?", cardId: `question-${taskId}`, at, ...extra });

describe("which toasts show (D25)", () => {
  /** Every kind, and the toasts it gives while you're away (Focus mode off, on). A new kind needs a line here. */
  const EXPECTED: Record<AttentionKind, { priority?: "blocking" | "milestone"; away: number; awayFocus: number }> = {
    question: { priority: "blocking", away: 1, awayFocus: 1 },
    permission: { priority: "blocking", away: 1, awayFocus: 1 },
    plan: { priority: "blocking", away: 1, awayFocus: 1 },
    budget: { priority: "blocking", away: 1, awayFocus: 1 },
    failed: { priority: "blocking", away: 1, awayFocus: 1 },
    interrupted: { priority: "blocking", away: 1, awayFocus: 1 },
    reminder: { priority: "blocking", away: 1, awayFocus: 1 },
    done: { priority: "milestone", away: 1, awayFocus: 0 },
    started: { away: 0, awayFocus: 0 },
    // GitHub's news (Phase 4): milestones, a red CI run too (D36); a PR you merged yourself is only its card.
    ci_success: { priority: "milestone", away: 1, awayFocus: 0 },
    ci_failure: { priority: "milestone", away: 1, awayFocus: 0 },
    review: { priority: "milestone", away: 1, awayFocus: 0 },
    review_request: { priority: "milestone", away: 1, awayFocus: 0 },
    pr_closed: { priority: "milestone", away: 1, awayFocus: 0 },
    pr_closed_yours: { away: 0, awayFocus: 0 },
    watch_ended: { priority: "milestone", away: 1, awayFocus: 0 },
    github_account: { priority: "milestone", away: 1, awayFocus: 0 },
    tracker_update: { priority: "milestone", away: 1, awayFocus: 0 },
    outlook_urgent: { priority: "blocking", away: 1, awayFocus: 1 },
    outlook_important: { priority: "milestone", away: 1, awayFocus: 0 },
  };

  it.each(Object.keys(EXPECTED) as AttentionKind[])("%s: nothing while you're there; while you're away as the table says", (kind) => {
    const expected = EXPECTED[kind];
    expect(PRIORITY[kind]).toBe(expected.priority ?? "info");
    for (const [present, focusMode, count] of [
      [true, false, 0],
      [true, true, 0],
      [false, false, expected.away],
      [false, true, expected.awayFocus],
    ] as const) {
      const { attention, toasts } = setup({ focusMode });
      attention.setPresence(present);
      attention.event(ev(kind));
      expect(toasts, `present ${present}, focus mode ${focusMode}`).toHaveLength(count);
      if (count) expect(toasts[0]).toMatchObject({ priority: expected.priority, title: `a: ${kind}`, body: `${kind} of a`, taskId: "a", cardId: `card-${kind}-a`, silent: expected.priority === "milestone" });
    }
  });

  it("keeps what comes before the shell says whether you're there, and decides once it does", () => {
    const away = setup();
    away.attention.event(ev("interrupted"));
    expect(away.toasts).toHaveLength(0);
    away.attention.setPresence(false);
    expect(away.toasts.map((t) => t.title)).toEqual(["a: interrupted"]);

    const there = setup();
    there.attention.event(ev("interrupted"));
    there.attention.setPresence(true);
    expect(there.toasts).toHaveLength(0);
  });
});

describe("Done toasts within 30 s become one (D24)", () => {
  it("shows the first at once and the rest as one toast in its place when the 30 s are up", () => {
    const { attention, toasts, clock } = setup();
    attention.setPresence(false);
    attention.event(ev("done", "a"));
    expect(toasts.map((t) => t.title)).toEqual(["a: done"]);
    clock.advance(10_000);
    attention.event(ev("done", "b"));
    clock.advance(10_000);
    attention.event(ev("done", "c"));
    // A failure isn't grouped: it shows at once.
    attention.event(ev("failed", "d"));
    expect(toasts.map((t) => t.title)).toEqual(["a: done", "d: failed"]);
    clock.advance(COALESCE_MS - 20_000);
    expect(toasts.at(-1)).toEqual({ type: "toast", id: "t3", priority: "milestone", title: "3 tasks finished", body: "Task a, Task b and Task c", silent: true, taskId: "a", cardId: "card-done-a", replaces: "t1" });
    // After the window, a new group.
    clock.advance(1_000);
    attention.event(ev("done", "e"));
    expect(toasts.at(-1)).toMatchObject({ title: "e: done" });
    expect(toasts.at(-1)).not.toHaveProperty("replaces");
  });

  it("drops the combined toast when you're back or turned Focus mode on before the window ends, and a lone one stays", () => {
    const back = setup();
    back.attention.setPresence(false);
    back.attention.event(ev("done", "a"));
    back.attention.event(ev("done", "b"));
    back.attention.setPresence(true);
    back.clock.advance(COALESCE_MS);
    expect(back.toasts.map((t) => t.title)).toEqual(["a: done"]);

    const focus = setup();
    focus.attention.setPresence(false);
    focus.attention.event(ev("done", "a"));
    focus.attention.event(ev("done", "b"));
    focus.settings.focusMode = true;
    focus.clock.advance(COALESCE_MS);
    expect(focus.toasts.map((t) => t.title)).toEqual(["a: done"]);

    const lone = setup();
    lone.attention.setPresence(false);
    lone.attention.event(ev("done", "a"));
    lone.clock.advance(COALESCE_MS);
    expect(lone.toasts).toHaveLength(1);
  });

  it("names at most four tasks", () => {
    const { attention, toasts, clock } = setup();
    attention.setPresence(false);
    for (const id of ["a", "b", "c", "d", "e", "f"]) attention.event(ev("done", id));
    clock.advance(COALESCE_MS);
    expect(toasts.at(-1)).toMatchObject({ title: "6 tasks finished", body: "Task a, Task b, Task c, Task d and 2 more" });
  });
});

describe("the while-you-were-away card (§5.5)", () => {
  it("sums up what finished, failed and needs you, each line linking to its card, after 15 minutes or more away", () => {
    const { attention, cards, clock, state } = setup();
    attention.setPresence(true);
    state.waiting = [waiting("old", clock.now() - MIN, { shortId: "Q-1" })];
    clock.advance(MIN);
    const left = clock.now();
    attention.setPresence(false);
    clock.advance(2 * MIN);
    attention.event(ev("done", "a"));
    attention.event(ev("failed", "b"));
    attention.event(ev("permission", "c"));
    state.waiting = [...state.waiting, waiting("c", clock.now(), { kind: "permission", shortId: "P-1", text: "wants to run npm install", cardId: "card-permission-c" })];
    clock.advance(14 * MIN);
    attention.setPresence(true);
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card).toMatchObject({ kind: "card", cardType: "away_digest", id: "away-t4" });
    expect(card.payload).toMatchObject({ since: left, until: clock.now(), awayMs: 16 * MIN });
    expect(card.payload.lines).toEqual([
      { kind: "needs_you", taskId: "old", title: "Task old", repoName: "Repo", text: "asks: which?", cardId: "question-old", shortId: "Q-1", waits: "question" },
      { kind: "needs_you", taskId: "c", title: "Task c", repoName: "Repo", text: "wants to run npm install", cardId: "card-permission-c", shortId: "P-1", waits: "permission", isNew: true },
      { kind: "failed", taskId: "b", title: "Task b", repoName: "Repo", text: "failed of b", cardId: "card-failed-b" },
      { kind: "done", taskId: "a", title: "Task a", repoName: "Repo", text: "done of a", cardId: "card-done-a" },
    ]);
    // Shown: the next return starts afresh.
    attention.setPresence(false);
    clock.advance(20 * MIN);
    attention.setPresence(true);
    expect(cards).toHaveLength(1);
  });

  it("adds up glances back, until you've stayed long enough to have seen the chat", () => {
    const { attention, cards, clock } = setup();
    attention.setPresence(false);
    attention.event(ev("done", "a"));
    clock.advance(10 * MIN);
    attention.setPresence(true);
    expect(cards).toHaveLength(0);
    // A glance: back to work elsewhere a minute later, 6 minutes more away makes 16.
    clock.advance(MIN);
    attention.setPresence(false);
    clock.advance(6 * MIN);
    attention.setPresence(true);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.payload).toMatchObject({ awayMs: 16 * MIN, lines: [{ kind: "done", taskId: "a" }] });

    // Back for real after 10 minutes, and staying: after 5 minutes it's cleared, so a short absence later shows no card.
    attention.setPresence(false);
    attention.event(ev("done", "b"));
    clock.advance(10 * MIN);
    attention.setPresence(true);
    clock.advance(SETTLE_MS);
    attention.setPresence(false);
    clock.advance(6 * MIN);
    attention.setPresence(true);
    expect(cards).toHaveLength(1);
  });

  it("makes no card without news: a question that was already waiting doesn't make one", () => {
    const { attention, cards, clock, state } = setup();
    state.waiting = [waiting("old", clock.now())];
    attention.setPresence(false);
    clock.advance(60 * MIN);
    attention.setPresence(true);
    expect(cards).toHaveLength(0);
  });

  it("shows what Focus mode held back on return, whatever the time away, also with the summary off", () => {
    for (const awayMinutes of [15, null]) {
      const { attention, cards, toasts, clock } = setup({ focusMode: true, awayMinutes });
      attention.setPresence(false);
      attention.event(ev("done", "a"));
      expect(toasts).toHaveLength(0);
      clock.advance(MIN);
      attention.setPresence(true);
      expect(cards.map((c) => c.payload.lines.map((l) => l.taskId))).toEqual([["a"]]);
    }
    // Off, and nothing held: no card, however long.
    const off = setup({ awayMinutes: null });
    off.attention.setPresence(false);
    off.attention.event(ev("done", "a"));
    off.clock.advance(120 * MIN);
    off.attention.setPresence(true);
    expect(off.cards).toHaveLength(0);
  });

  it("counts an away period from when you went idle, with what happened since then", () => {
    const { attention, cards, toasts, clock } = setup();
    attention.setPresence(true);
    const idleFrom = clock.now();
    clock.advance(2 * MIN);
    attention.event(ev("done", "a"));
    expect(toasts).toHaveLength(0);
    clock.advance(3 * MIN);
    // The shell sees 5 minutes without input: away since then.
    attention.setPresence(false, idleFrom);
    clock.advance(11 * MIN);
    attention.setPresence(true);
    expect(cards[0]!.payload).toMatchObject({ since: idleFrom, awayMs: 16 * MIN, lines: [{ kind: "done", taskId: "a" }] });
  });

  it("toasts what still needs you from the minutes you were idle before you counted as away, also in Focus mode", () => {
    const { attention, toasts, clock, state, settings } = setup({ focusMode: true });
    attention.setPresence(true);
    const idleFrom = clock.now();
    clock.advance(MIN);
    attention.event(ev("question", "q"));
    attention.event(ev("permission", "p"));
    attention.event(ev("failed", "f"));
    attention.event(ev("failed", "retried"));
    attention.event(ev("done", "d"));
    expect(toasts).toHaveLength(0);
    // The question still waits, the permission was decided meanwhile; one failure stands, the other was retried.
    state.waiting = [waiting("q", clock.now(), { cardId: "card-question-q" })];
    state.states = { f: "failed", retried: "running" };
    clock.advance(4 * MIN);
    attention.setPresence(false, idleFrom);
    expect(toasts.map((t) => [t.priority, t.title])).toEqual([
      ["blocking", "q: question"],
      ["blocking", "f: failed"],
    ]);
    expect(settings.focusMode).toBe(true);
    // A leave from now on (not idle) toasts nothing that happened before it.
    const plain = setup();
    plain.attention.setPresence(true);
    plain.attention.event(ev("question", "q"));
    plain.state.waiting = [waiting("q", plain.clock.now(), { cardId: "card-question-q" })];
    plain.attention.setPresence(false);
    expect(plain.toasts).toHaveLength(0);
  });

  it("toasts nothing twice when you turn out to have gone idle before you were last back", () => {
    const { attention, toasts, cards, clock, state } = setup();
    const idleFrom = clock.now();
    attention.setPresence(false);
    clock.advance(2 * MIN);
    attention.event(ev("question", "q"));
    state.waiting = [waiting("q", clock.now(), { cardId: "card-question-q" })];
    expect(toasts).toHaveLength(1);
    clock.advance(18 * MIN);
    // Back (the window got focus) without touching anything: the card shows, and the question still waits.
    attention.setPresence(true);
    expect(cards).toHaveLength(1);
    clock.advance(10_000);
    // The shell's idle check: no input since before you left.
    attention.setPresence(false, idleFrom);
    expect(toasts).toHaveLength(1);
    clock.advance(20 * MIN);
    attention.setPresence(true);
    expect(cards, "nothing new while away").toHaveLength(1);
  });

  it("toasts nothing twice also when it came the very moment you were back", () => {
    const { attention, toasts, clock, state } = setup();
    const idleFrom = clock.now();
    attention.setPresence(false);
    clock.advance(2 * MIN);
    attention.event(ev("question", "q"));
    state.waiting = [waiting("q", clock.now(), { cardId: "card-question-q" })];
    attention.setPresence(true);
    clock.advance(10_000);
    attention.setPresence(false, idleFrom);
    expect(toasts).toHaveLength(1);
  });

  it("starts an away period that turns out to have started earlier no earlier than you were last back", () => {
    const { attention, toasts, cards, clock } = setup();
    const left = clock.now();
    attention.setPresence(false);
    clock.advance(MIN);
    attention.event(ev("done", "a"));
    expect(toasts).toHaveLength(1);
    clock.advance(9 * MIN);
    // A glance back: 10 minutes away isn't enough for a card.
    attention.setPresence(true);
    expect(cards).toHaveLength(0);
    clock.advance(MIN);
    attention.setPresence(false, left);
    clock.advance(5 * MIN);
    attention.setPresence(true);
    // 10 minutes, then 6 more from when you were back: not 10 plus the 16 since you first left.
    expect(cards[0]!.payload).toMatchObject({ since: left, awayMs: 16 * MIN });
  });

  it("leaves out tasks discarded since, and shows at most 10 lines of a kind", () => {
    const { attention, cards, clock, state } = setup();
    attention.setPresence(false);
    for (let i = 0; i < 13; i++) attention.event(ev("done", `t${i}`));
    attention.event(ev("failed", "gone"));
    state.gone.add("gone");
    clock.advance(20 * MIN);
    attention.setPresence(true);
    const payload = cards[0]!.payload;
    expect(payload.lines.map((l) => l.taskId)).toEqual(["t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11", "t12"]);
    expect(payload.more).toEqual({ done: 3 });
  });
});

describe("a locked screen (Windows drops a toast shown meanwhile, Phase 9)", () => {
  it("toasts nothing while locked, and on the unlock, if you're still away, what still needs you", () => {
    const { attention, toasts, clock, state } = setup();
    attention.setPresence(false, clock.now(), true);
    attention.event(ev("question", "q"));
    attention.event(ev("permission", "p"));
    attention.event(ev("failed", "f"));
    attention.event(ev("done", "d"));
    expect(toasts).toHaveLength(0);
    // Meanwhile the permission was decided (through ARIA); the question and the failure stand.
    state.waiting = [waiting("q", clock.now(), { cardId: "card-question-q" })];
    state.states = { f: "failed" };
    clock.advance(COALESCE_MS);
    attention.setPresence(false, clock.now(), false);
    // A moment later, if you're still away (Windows gives a window the focus back just after the unlock).
    expect(toasts).toHaveLength(0);
    clock.advance(UNLOCK_SETTLE_MS);
    expect(toasts.map((t) => [t.priority, t.title])).toEqual([
      ["blocking", "q: question"],
      ["blocking", "f: failed"],
    ]);
    // Once only, and what comes after the unlock toasts as ever.
    attention.setPresence(false, clock.now(), false);
    attention.event(ev("done", "e"));
    expect(toasts.map((t) => t.title)).toEqual(["q: question", "f: failed", "e: done"]);
  });

  it("toasts nothing on an unlock that brings you back to ARIA: its cards show it", () => {
    const { attention, toasts, clock, state } = setup();
    attention.setPresence(true);
    attention.setPresence(false, clock.now(), true);
    attention.event(ev("question", "q"));
    state.waiting = [waiting("q", clock.now(), { cardId: "card-question-q" })];
    attention.setPresence(true);
    attention.setPresence(false);
    clock.advance(UNLOCK_SETTLE_MS);
    expect(toasts).toHaveLength(0);
  });

  it("toasts nothing when the window gets the focus back just after the unlock (as Windows does, 0.2 s later)", () => {
    const { attention, toasts, clock, state } = setup();
    attention.setPresence(false, clock.now(), true);
    attention.event(ev("question", "q"));
    state.waiting = [waiting("q", clock.now(), { cardId: "card-question-q" })];
    attention.setPresence(false, clock.now(), false);
    clock.advance(200);
    attention.setPresence(true);
    clock.advance(UNLOCK_SETTLE_MS);
    expect(toasts).toHaveLength(0);
    // Locked again before the moment is up: it waits for that unlock.
    const again = setup();
    again.attention.setPresence(false, again.clock.now(), true);
    again.attention.event(ev("question", "q"));
    again.state.waiting = [waiting("q", again.clock.now(), { cardId: "card-question-q" })];
    again.attention.setPresence(false, again.clock.now(), false);
    again.attention.setPresence(false, again.clock.now(), true);
    again.clock.advance(UNLOCK_SETTLE_MS);
    expect(again.toasts).toHaveLength(0);
    again.attention.setPresence(false, again.clock.now(), false);
    again.clock.advance(UNLOCK_SETTLE_MS);
    expect(again.toasts.map((t) => t.title)).toEqual(["q: question"]);
  });

  it("holds what toasts when you went idle before the lock, and no combined Done toast shows while locked", () => {
    const { attention, toasts, clock, state } = setup();
    attention.setPresence(true);
    const idleFrom = clock.now();
    clock.advance(MIN);
    attention.event(ev("question", "q"));
    state.waiting = [waiting("q", clock.now(), { cardId: "card-question-q" })];
    clock.advance(4 * MIN);
    // The poll finds the screen locked, and you idle since before the question.
    attention.setPresence(false, idleFrom, true);
    expect(toasts).toHaveLength(0);
    attention.setPresence(false, clock.now(), false);
    clock.advance(UNLOCK_SETTLE_MS);
    expect(toasts.map((t) => t.title)).toEqual(["q: question"]);

    const group = setup();
    group.attention.setPresence(false);
    group.attention.event(ev("done", "a"));
    group.attention.event(ev("done", "b"));
    group.attention.setPresence(false, group.clock.now(), true);
    group.clock.advance(COALESCE_MS);
    expect(group.toasts.map((t) => t.title)).toEqual(["a: done"]);
  });
});

describe("stopping", () => {
  it("shows nothing more once stopped: no held toast, no card, no new toasts", () => {
    const { attention, toasts, cards, clock } = setup();
    attention.setPresence(false);
    attention.event(ev("done", "a"));
    attention.event(ev("done", "b"));
    attention.stop();
    clock.advance(30 * MIN);
    attention.event(ev("failed", "c"));
    attention.setPresence(true);
    expect(toasts.map((t) => t.title)).toEqual(["a: done"]);
    expect(cards).toHaveLength(0);
  });
});
