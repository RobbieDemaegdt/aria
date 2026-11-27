import type { TranscriptEntry } from "@aria/protocol";
import { describe, expect, it } from "vitest";
import { connectionNote, digestSummary, groupTurns, sameTurn, turnStatus, turnTime } from "../src/renderer/src/inspector";

const user = (id: string, at: number, extra: Partial<Extract<TranscriptEntry, { kind: "user" }>> = {}): TranscriptEntry => ({ kind: "user", id, at, text: id, ...extra });
const answer = (id: string, at: number): TranscriptEntry => ({ kind: "assistant", id, at, text: id });
const tool = (id: string, at: number, ms?: number): TranscriptEntry => ({ kind: "tool", id, at, name: "list_tasks", ...(ms !== undefined ? { success: true, ms } : {}) });
const permission = (id: string, approved: boolean | undefined, toolCallId?: string): TranscriptEntry => ({
  kind: "permission",
  id,
  at: 1,
  detail: "Use list_tasks",
  ...(approved !== undefined ? { approved } : {}),
  ...(approved === false ? { reason: "Not allowed." } : {}),
  ...(toolCallId ? { toolCallId } : {}),
});

describe("the inspector's turns", () => {
  it("groups everything under the message of yours it followed; what the runtime added is a step, not a turn", () => {
    const turns = groupTurns([
      { kind: "info", id: "i0", at: 1, level: "info", text: "Model: a → b" },
      user("u1", 1_000),
      tool("t1", 2_000, 500),
      answer("a1", 4_000),
      user("s1", 4_500, { source: "system" }),
      user("u2", 10_000, { digest: "<pending>\n- Q-1\n</pending>" }),
      tool("t2", 11_000, 3_000),
      tool("t3", 12_000),
    ]);
    expect(turns.map((t) => [t.message?.id ?? "before", t.steps.map((s) => s.entry.id), t.answered])).toEqual([
      ["before", ["i0"], false],
      ["u1", ["t1", "a1", "s1"], true],
      ["u2", ["t2", "t3"], false],
    ]);
    // "answered in": from your message to its last step (here, the system message after the answer); a tool call counts
    // until it ended.
    expect(turns[1]!.endAt).toBe(4_500);
    expect(turns[2]!.endAt).toBe(14_000);
  });

  it("leaves ARIA's own approvals out and folds a refusal into the tool call it was about", () => {
    const [turn] = groupTurns([user("u1", 1), tool("t1", 2, 1), permission("p1", true, "t1"), tool("t2", 3, 1), permission("p2", false, "t2"), permission("p3", false), permission("p4", undefined)]);
    expect(turn!.steps.map((s) => [s.entry.id, s.refused])).toEqual([
      ["t1", undefined],
      ["t2", "Not allowed."],
      // A refusal that names no tool call of this turn stays a step.
      ["p3", undefined],
    ]);
  });

  it("keeps the newest turn working while ARIA is busy, even after a first line of text", () => {
    const [turn] = groupTurns([user("u1", 1_000), answer("a1", 1_500), tool("t1", 2_000, 8_000)]);
    // "Let me check your calendar." then a long tool call: still working, no "answered in" yet.
    expect(turnStatus(turn!, true, true)).toEqual({ working: true });
    expect(turnStatus(turn!, true, false)).toEqual({ working: false, tookMs: 9_000 });
    // An earlier turn is over, whatever ARIA is doing now.
    expect(turnStatus(turn!, false, true)).toEqual({ working: false, tookMs: 9_000 });
    const [unanswered] = groupTurns([user("u2", 1), tool("t2", 2, 1)]);
    expect(turnStatus(unanswered!, false, false)).toEqual({ working: false });
  });

  it("says when what's shown is from before, differently while the conversation opens and when not connected", () => {
    expect(connectionNote("starting", true)).toBe("ARIA is opening its conversation: what's below is from before.");
    expect(connectionNote("error", true)).toMatch(/isn't connected/);
    expect(connectionNote("error", true)).not.toMatch(/opening/);
    expect(connectionNote("ready", true)).toBeUndefined();
    expect(connectionNote("busy", true)).toBeUndefined();
  });

  it("says, with nothing shown yet, that it fills in once the conversation is open (not an error)", () => {
    expect(connectionNote("starting", false)).toBe("ARIA is opening its conversation. This fills in when it's ready.");
    // Not connected with nothing shown: the failed read says so itself, with Retry.
    expect(connectionNote("error", false)).toBeUndefined();
    expect(connectionNote("ready", false)).toBeUndefined();
  });

  it("gives a turn's time, with the day when it isn't today", () => {
    const now = new Date(2026, 9, 17, 15, 0).getTime();
    const today = new Date(2026, 9, 17, 9, 5).getTime();
    const earlier = new Date(2026, 8, 30, 9, 5).getTime();
    const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    expect(turnTime(today, now)).toBe(time(today));
    expect(turnTime(earlier, now)).toBe(`${new Date(earlier).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${time(earlier)}`);
    const lastYear = new Date(2025, 11, 31, 9, 5).getTime();
    expect(turnTime(lastYear, now)).toContain("2025");
  });

  it("tells a turn that didn't change from one that did, so unchanged turns skip rendering", () => {
    const entries = [user("u1", 1), tool("t1", 2, 1), answer("a1", 4)];
    const [before] = groupTurns(entries);
    const [same] = groupTurns([...entries]);
    expect(sameTurn(before!, same!)).toBe(true);
    const [changed] = groupTurns([entries[0]!, { ...entries[1]!, ms: 2 } as TranscriptEntry, entries[2]!]);
    expect(sameTurn(before!, changed!)).toBe(false);
    const [longer] = groupTurns([...entries, answer("a2", 5)]);
    expect(sameTurn(before!, longer!)).toBe(false);
  });

  it("counts the update lines and waiting items in a digest", () => {
    const digest = [
      "<updates since your last message>",
      "- (12 earlier updates left out: list_tasks has the current state)",
      '- [done] "A" (R): No commits.',
      '- You told "B" directly: "x"',
      "</updates>",
      "<pending>",
      '- Q-1: "A" (R) asks: "Which?"',
      "</pending>",
    ].join("\n");
    expect(digestSummary(digest)).toEqual({ updates: 14, pending: 1 });
    expect(digestSummary("<pending>\n- P-1: x\n- Q-2: y\n</pending>")).toEqual({ updates: 0, pending: 2 });
  });
});
