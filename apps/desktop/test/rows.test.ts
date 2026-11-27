import type { MyWorkItem, Task, TimelineItem, Watch } from "@aria/protocol";
import { describe, expect, it } from "vitest";
import { ENDED_SHOWN_MS, expandedByDefault, itemOfWatch, projectMarks, projectWatches, reconcileByKey, reconcileSectionGroups, rows, sectionGroups, WATCH_ICON, watchChips, watchStatus, watchTarget } from "../src/renderer/src/rows";

const NOW = 1_800_000_000_000;
const task = (id: string, state: Task["state"], createdAt = NOW): Task => ({ id, state, createdAt, repoId: 1, title: id }) as unknown as Task;
const watch = (id: number, over: Partial<Watch> = {}): Watch => ({
  id,
  shortId: `W-${id}`,
  kind: "branch",
  repoId: 1,
  title: "main",
  status: "green",
  tone: "ok",
  until: "forever",
  state: "active",
  createdBy: "you",
  createdAt: NOW - id,
  ...over,
});
const card = (id: string, watchId?: number): TimelineItem => ({ kind: "card", id, cardType: "ci", payload: { ...(watchId !== undefined ? { watchId } : {}) }, createdAt: NOW }) as unknown as TimelineItem;
const needsYou = (t: Task) => t.state === "waiting_input";
const isActive = (t: Task) => t.state === "running";

describe("a project's rows (PLAN.md §5.2: needs you, running, queued, watching, done)", () => {
  it("puts its active watches after the queued sessions and before the finished ones; ended watches last", () => {
    const order = rows(
      [task("done", "done"), task("queued", "queued"), task("asks", "waiting_input"), task("runs", "running")],
      [watch(1), watch(2, { state: "ended", endedAt: NOW })],
    ).map((r) => (r.kind === "task" ? r.task.id : `W-${r.watch.id}`));
    expect(order).toEqual(["asks", "runs", "queued", "W-1", "done", "W-2"]);
  });

  it("a project's watches: its own (not the inbox), active, or ended within the last day", () => {
    // (The inbox has no project; even one that named one isn't a project's row.)
    const all = [watch(1), watch(2, { repoId: 2 }), watch(3, { kind: "inbox", repoId: 1 }), watch(4, { state: "ended", endedAt: NOW - 1000 }), watch(5, { state: "ended", endedAt: NOW - ENDED_SHOWN_MS - 1 })];
    expect(projectWatches(all, 1, NOW).map((w) => w.id)).toEqual([1, 4]);
  });

  it("a red watch isn't 'needs you' (D36): no red dot, a quiet ✗ instead; it counts as busy while it runs", () => {
    expect(projectMarks([], [watch(1, { tone: "bad" })], needsYou, isActive)).toEqual({ needsYou: false, busy: false, red: true });
    expect(projectMarks([task("asks", "waiting_input")], [watch(1, { tone: "running" })], needsYou, isActive)).toEqual({ needsYou: true, busy: true, red: false });
    // An ended red watch isn't a mark.
    expect(projectMarks([], [watch(1, { tone: "bad", state: "ended" })], needsYou, isActive).red).toBe(false);
  });

  it("a project with active watches (and no sessions) is expanded, so a red main can't hide", () => {
    expect(expandedByDefault([], [watch(1, { tone: "bad" })])).toBe(true);
    expect(expandedByDefault([], [watch(1, { state: "ended" })])).toBe(false);
    expect(expandedByDefault([task("a", "done")], [])).toBe(true);
  });

  it("each tone has its icon, and the status is text: why it waits, else what it's at", () => {
    expect(WATCH_ICON).toEqual({ running: "watching", waiting: "watching", ok: "ok", bad: "bad", paused: "paused", ended: "ended" });
    expect(watchStatus(watch(1, { status: "red: test failing" }))).toBe("red: test failing");
    expect(watchStatus(watch(1, { paused: "started as @a; GitHub CLI now uses @b" }))).toBe("started as @a; GitHub CLI now uses @b");
  });
});

describe("a watch row's click (D39)", () => {
  it("goes to the watch's newest card; with none in the timeline, to My work at its item", () => {
    const timeline = [card("c1", 7), card("other", 8), card("c2", 7), card("plain")];
    expect(watchTarget(timeline, 7)).toEqual({ cardId: "c2" });
    expect(watchTarget(timeline, 9)).toEqual({ myWork: 9 });
  });
});

describe("the live strip's watch chips", () => {
  it("each running watch, and each red one until its newest card was seen; the inbox and ended ones never", () => {
    const watches = [watch(1, { tone: "running" }), watch(2, { tone: "bad" }), watch(3, { tone: "bad" }), watch(4, { tone: "ok" }), watch(5, { tone: "running", state: "ended" }), watch(6, { kind: "inbox", tone: "running" })];
    const timeline = [card("c2", 2), card("c3", 3)];
    expect(watchChips(watches, timeline, new Set()).map((w) => w.id)).toEqual([1, 2, 3]);
    expect(watchChips(watches, timeline, new Set(["c2"])).map((w) => w.id)).toEqual([1, 3]);
    // A new red card brings it back.
    expect(watchChips(watches, [...timeline, card("c2b", 2)], new Set(["c2"])).map((w) => w.id)).toEqual([1, 2, 3]);
    // When a watch's card was dismissed from the timeline, `w:<id>` in seen keeps the red chip hidden until a new card arrives.
    expect(watchChips(watches, [card("c3", 3)], new Set(["c2", "w:2"])).map((w) => w.id)).toEqual([1, 3]);
    expect(watchChips(watches, [card("c3", 3), card("c2-new", 2)], new Set(["c2", "w:2"])).map((w) => w.id)).toEqual([1, 2, 3]);
  });
});

describe("My work's sections", () => {
  const item = (key: string, repoId: number, why: MyWorkItem["why"], updatedAt: number, watchId?: number): MyWorkItem => ({
    key,
    kind: "pr",
    owner: "me",
    repo: "r",
    repoId,
    repoName: `P${repoId}`,
    number: 1,
    title: key,
    why,
    updatedAt,
    url: "https://github.com/me/r/pull/1",
    ...(watchId !== undefined ? { watchId } : {}),
  });
  it("a section's items by project, newest first; an item in two sections shows in both", () => {
    const items = [item("a", 1, ["authored"], 1), item("b", 2, ["authored", "assigned"], 3), item("c", 1, ["authored"], 2), item("d", 1, ["review_requested"], 4)];
    expect(sectionGroups(items, "authored").map((g) => [g.repoName, g.items.map((i) => i.key)])).toEqual([
      ["P2", ["b"]],
      ["P1", ["c", "a"]],
    ]);
    expect(sectionGroups(items, "assigned").map((g) => g.items.map((i) => i.key))).toEqual([["b"]]);
    expect(itemOfWatch(items.concat(item("w", 1, ["authored"], 0, 42)), watch(42))?.key).toBe("w");
  });

  it("reconciles section groups in place: removes deleted items, keeps unchanged items in place by reference, and appends new items", () => {
    const itemA = item("a", 1, ["authored"], 10);
    const itemB = item("b", 2, ["authored"], 30);
    const itemC = item("c", 1, ["authored"], 20);
    const initialGroups = reconcileSectionGroups([], [itemA, itemB, itemC], "authored");
    expect(initialGroups.map((g) => [g.repoName, g.items.map((i) => i.key)])).toEqual([
      ["P2", ["b"]],
      ["P1", ["c", "a"]],
    ]);

    // Next sync: "c" is deleted, "a" and "b" are unchanged (even as new object clones), and "d" is added to P1.
    const itemAClone = item("a", 1, ["authored"], 10);
    const itemBClone = item("b", 2, ["authored"], 30);
    const itemD = item("d", 1, ["authored"], 40);
    const nextGroups = reconcileSectionGroups(initialGroups, [itemAClone, itemBClone, itemD], "authored");

    expect(nextGroups.map((g) => [g.repoName, g.items.map((i) => i.key)])).toEqual([
      ["P2", ["b"]],
      ["P1", ["a", "d"]],
    ]);
    // Group P2 and item "b" and "a" kept their exact object references
    expect(nextGroups[0]).toBe(initialGroups[0]);
    expect(nextGroups[0]!.items[0]).toBe(itemB);
    expect(nextGroups[1]!.items[0]).toBe(itemA);
    expect(nextGroups[1]!.items[1]).toBe(itemD);

    // Generic reconcileByKey also preserves order and reference for unchanged items
    const list1 = [{ id: "1", v: "x" }, { id: "2", v: "y" }];
    const list2 = reconcileByKey(list1, [{ id: "2", v: "y" }, { id: "3", v: "z" }], (x) => x.id, (a, b) => a.v === b.v);
    expect(list2.map((x) => x.id)).toEqual(["2", "3"]);
    expect(list2[0]).toBe(list1[1]);
  });
});
