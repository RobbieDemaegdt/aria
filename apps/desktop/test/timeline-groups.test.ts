import type { Task, TimelineItem } from "@aria/protocol";
import { describe, expect, it } from "vitest";
import { needsYou, nextTarget, pendingCards, SESSION_COLORS, sessionColorIndex, sessionRuns, targetKey } from "../src/renderer/src/timelineGroups";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const task = (id: string, state: Task["state"], over: Partial<Task> = {}): Task => ({ id, state, title: id, createdAt: NOW, ...over }) as unknown as Task;
const chat = (id: string, at = NOW): TimelineItem => ({ kind: "chat", id, role: "user", content: id, createdAt: at });
const notice = (id: string, taskId?: string, at = NOW): TimelineItem => ({ kind: "notice", id, level: "info", message: id, ...(taskId ? { taskId } : {}), createdAt: at });
const taskCard = (id: string, taskId: string, at = NOW): TimelineItem => ({ kind: "card", id, cardType: "task", payload: { taskId }, createdAt: at });
const question = (id: string, taskId: string, questionId: string): TimelineItem => ({ kind: "card", id, cardType: "task_question", payload: { taskId, questionId, shortId: "Q-1", question: "Which?" }, createdAt: NOW });
const permission = (id: string, taskId: string, permissionId: string): TimelineItem =>
  ({ kind: "card", id, cardType: "task_permission", payload: { taskId, permissionId, shortId: "P-1", kind: "shell", what: "npm i", reason: "r", scope: "s", sandboxed: true }, createdAt: NOW }) as TimelineItem;
const plan = (id: string, taskId: string, planId: string): TimelineItem => ({ kind: "card", id, cardType: "task_plan", payload: { taskId, planId, shortId: "L-1", summary: "s" }, createdAt: NOW });
const budget = (id: string, taskId: string): TimelineItem => ({ kind: "card", id, cardType: "task_budget", payload: { taskId, usedCredits: 5, budgetCredits: 5 }, createdAt: NOW });
const ci = (id: string, watchId: number): TimelineItem => ({ kind: "card", id, cardType: "ci", payload: { watchId }, createdAt: NOW }) as unknown as TimelineItem;
const proposal = (id: string, decision?: "started" | "dismissed"): TimelineItem =>
  ({ kind: "card", id, cardType: "profile_proposal", payload: { repoId: 1, repoName: "r", title: "t", brief: "b", profileId: "p", profileName: "P", model: "m", ...(decision ? { decision } : {}) }, createdAt: NOW }) as TimelineItem;
const action = (id: string, status: "pending" | "done"): TimelineItem => ({ kind: "card", id, cardType: "action_request", payload: { shortId: "A-1", status }, createdAt: NOW }) as unknown as TimelineItem;
const sameDay = (a: number, b: number) => Math.floor(a / DAY) === Math.floor(b / DAY);
const shape = (items: TimelineItem[]) => sessionRuns(items, sameDay).map((s) => (s.kind === "item" ? s.item.id : `[${s.items.map((i) => i.id).join(",")}]`));

describe("session runs (option 2a)", () => {
  it("draws back-to-back items of one session as one run, and breaks it on a chat message or another session", () => {
    const timeline = [taskCard("a-task", "a"), question("a-q", "a", "q1"), notice("a-n", "a"), taskCard("b-task", "b"), chat("you"), notice("a-n2", "a")];
    expect(shape(timeline)).toEqual(["[a-task,a-q,a-n]", "[b-task]", "you", "[a-n2]"]);
  });

  it("keeps notices of no session single, and groups a watch's cards", () => {
    expect(shape([notice("general"), ci("c1", 7), ci("c2", 7), ci("c3", 8)])).toEqual(["general", "[c1,c2]", "[c3]"]);
  });

  it("never runs across a day divider", () => {
    expect(shape([taskCard("t", "a", NOW - DAY), notice("n", "a", NOW)])).toEqual(["[t]", "[n]"]);
  });

  it("colours sessions by the order they first show up, so neighbours differ, and wraps round the palette", () => {
    const timeline: TimelineItem[] = [chat("you"), taskCard("a1", "a"), ci("w", 3), notice("a2", "a"), notice("plain")];
    for (let i = 0; i < SESSION_COLORS.length; i++) timeline.push(taskCard(`x${i}`, `x${i}`));
    const colors = sessionColorIndex(timeline);
    expect(colors.get("task:a")).toBe(0);
    expect(colors.get("watch:3")).toBe(1);
    expect(colors.has("notices")).toBe(false);
    // Session number 9 shares the first colour again.
    expect(colors.get(`task:x${SESSION_COLORS.length - 2}`)).toBe(0);
  });
});

describe("what waits for you (option 3-lite)", () => {
  it("finds open questions, permissions and plans by the task's live state, not answered ones", () => {
    const tasks = [
      task("q", "waiting_input", { question: { id: "q2" } } as Partial<Task>),
      task("p", "waiting_permission", { permissions: [{ id: "p1" }] } as Partial<Task>),
      task("l", "running"),
    ];
    const timeline = [question("old-q", "q", "q1"), question("new-q", "q", "q2"), permission("perm", "p", "p1"), plan("plan", "l", "l1")];
    expect(pendingCards(timeline, tasks).map((c) => c.id)).toEqual(["new-q", "perm"]);
  });

  it("counts only a paused task's newest budget card, and decisions nobody made yet", () => {
    const tasks = [task("b", "waiting_budget")];
    const timeline = [budget("b1", "b"), budget("b2", "b"), proposal("open"), proposal("started", "started"), action("a-open", "pending"), action("a-done", "done")];
    expect(pendingCards(timeline, tasks).map((c) => c.id)).toEqual(["b2", "open", "a-open"]);
  });

  it("points at the newest restart card of a task that's still interrupted", () => {
    const interrupted = (id: string, taskIds: string[]): TimelineItem => ({ kind: "card", id, cardType: "tasks_interrupted", payload: { taskIds }, createdAt: NOW });
    const tasks = [task("i", "interrupted"), task("j", "running")];
    expect(pendingCards([interrupted("r1", ["i"]), interrupted("r2", ["i", "j"]), interrupted("r3", ["j"])], tasks).map((c) => c.id)).toEqual(["r2"]);
  });

  it("counts the tasks that need you plus open decisions, and jumps to their cards, then to tasks with no card in the chat", () => {
    const tasks = [task("q", "waiting_input", { question: { id: "q1" } } as Partial<Task>), task("p", "waiting_permission", { permissions: [{ id: "p1" }, { id: "p2" }] } as Partial<Task>), task("gone", "waiting_input")];
    const timeline = [question("q-card", "q", "q1"), permission("p1-card", "p", "p1"), proposal("prop"), permission("p2-card", "p", "p2")];
    const waiting = needsYou(timeline, tasks, (t) => t.state.startsWith("waiting"));
    // Three tasks need you, and one proposal waits.
    expect(waiting.count).toBe(4);
    expect(waiting.targets).toEqual([{ cardId: "q-card", taskId: "q" }, { cardId: "p1-card", taskId: "p" }, { cardId: "prop" }, { cardId: "p2-card", taskId: "p" }, { taskId: "gone" }]);
  });

  it("goes round the targets, and starts over when the last one is gone", () => {
    const targets = [{ cardId: "a" }, { cardId: "b" }, { taskId: "t" }];
    expect(nextTarget(targets, null)).toEqual({ cardId: "a" });
    expect(nextTarget(targets, "a")).toEqual({ cardId: "b" });
    expect(targetKey(nextTarget(targets, "b")!)).toBe("task:t");
    expect(nextTarget(targets, "task:t")).toEqual({ cardId: "a" });
    expect(nextTarget(targets, "answered")).toEqual({ cardId: "a" });
    expect(nextTarget([], null)).toBeUndefined();
  });
});
