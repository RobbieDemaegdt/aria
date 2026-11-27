import type { AwayLine, Task } from "@aria/protocol";
import { describe, expect, it } from "vitest";
import { awayGroups, awaySummary, lineStatus } from "../src/renderer/src/away";

const line = (kind: AwayLine["kind"], id: string): AwayLine => ({ kind, taskId: id, title: id, repoName: "R", text: "t", cardId: `c-${id}` });

describe("the while-you-were-away card", () => {
  it("groups needs you, failed and finished in that order, counting the lines not shown", () => {
    const groups = awayGroups({ since: 1, until: 2, awayMs: 1, lines: [line("done", "d1"), line("needs_you", "n1"), line("done", "d2")], more: { done: 5 } }, "Acme");
    expect(groups.map((g) => [g.kind, g.label, g.lines.map((l) => l.taskId), g.total])).toEqual([
      ["needs_you", "Needs you", ["n1"], 1],
      ["done", "Finished", ["d1", "d2"], 7],
    ]);
    expect(awaySummary(groups, "Acme")).toBe("1 needs you · 7 finished");
    expect(awaySummary(awayGroups({ since: 1, until: 2, awayMs: 1, lines: [line("needs_you", "a"), line("needs_you", "b"), line("failed", "f")] }, "Acme"), "Acme")).toBe("2 need you · 1 failed");
  });

  it("shows a line as things stand now: settled once its task no longer waits on that item, gone once discarded", () => {
    const task = (over: Partial<Task>): Task => ({ id: "t", title: "T", brief: "b", repoId: 1, repoName: "R", repoPath: "C:\\r", profileName: "Default", model: "m", mode: "autopilot", state: "running", costCredits: 0, startedBy: "you", createdAt: 1, updatedAt: 1, slug: "t", ...over }) as Task;
    const waits = (kind: NonNullable<AwayLine["waits"]>, itemId?: string): AwayLine => ({ ...line("needs_you", "t"), waits: kind, ...(itemId ? { itemId } : {}) });
    const question = { id: "q1", shortId: "Q-1", question: "?", allowFreeform: true, askedAt: 1 };
    expect(lineStatus(waits("question", "q1"), task({ state: "waiting_input", question }))).toBeUndefined();
    // Answered, or asked something else since (short ids start again after a restart: the item's own id tells).
    expect(lineStatus(waits("question", "q1"), task({}))).toBe("settled");
    expect(lineStatus(waits("question", "q1"), task({ state: "waiting_input", question: { ...question, id: "q2" } }))).toBe("settled");
    const permission = { id: "p1", shortId: "P-1", kind: "shell" as const, what: "x", reason: "r", scope: "s", askedAt: 1 };
    expect(lineStatus(waits("permission", "p1"), task({ permissions: [permission] }))).toBeUndefined();
    expect(lineStatus(waits("permission", "p1"), task({ permissions: [] }))).toBe("settled");
    expect(lineStatus(waits("plan", "l1"), task({ plan: { id: "l1", shortId: "L-1", summary: "s", askedAt: 1 } }))).toBeUndefined();
    expect(lineStatus(waits("plan", "l1"), task({}))).toBe("settled");
    expect(lineStatus(waits("budget"), task({ state: "waiting_budget" }))).toBeUndefined();
    expect(lineStatus(waits("budget"), task({ state: "running" }))).toBe("settled");
    expect(lineStatus(waits("interrupted"), task({ state: "interrupted" }))).toBeUndefined();
    expect(lineStatus(waits("interrupted"), task({ state: "running" }))).toBe("settled");
    // A restart dropped what it waited on: not settled, it still needs you (to be resumed).
    expect(lineStatus(waits("question", "q1"), task({ state: "interrupted" }))).toBe("interrupted");
    expect(lineStatus(waits("permission", "p1"), task({ state: "interrupted" }))).toBe("interrupted");
    expect(lineStatus(waits("budget"), task({ state: "interrupted" }))).toBe("interrupted");
    // Resumed since: it no longer waits on the dropped item.
    expect(lineStatus(waits("question", "q1"), task({ state: "running" }))).toBe("settled");
    expect(lineStatus(line("done", "t"), task({ state: "done" }))).toBeUndefined();
    expect(lineStatus(line("done", "t"), undefined)).toBe("gone");
    expect(lineStatus(waits("question", "q1"), undefined)).toBe("gone");
  });

  it("puts GitHub's news and the tracker's updates in groups of their own, under the tracker's name; neither is ever 'gone' (they're about external watches/tasks, not a worker task)", () => {
    const github: AwayLine = { kind: "github", watchId: 3, title: "CI · deploy #482 failed", repoName: "Moonrise", text: "4m12s", cardId: "ci-1" };
    const tracker: AwayLine = { kind: "tracker", title: "New Acme task · #100789", repoName: "Northwind Connector", text: "Usage Report Export", cardId: "acme-1" };
    const groups = awayGroups({ since: 1, until: 2, awayMs: 1, lines: [tracker, github, line("done", "d1")], more: { github: 2, tracker: 1 } }, "Acme");
    expect(groups.map((g) => [g.kind, g.label, g.total])).toEqual([
      ["done", "Finished", 1],
      ["github", "GitHub", 3],
      ["tracker", "Acme", 2],
    ]);
    expect(awaySummary(groups, "Acme")).toBe("1 finished · 3 GitHub updates · 2 Acme updates");
    expect(lineStatus(github, undefined)).toBeUndefined();
    expect(lineStatus(tracker, undefined)).toBeUndefined();
  });
});
