import type { MemoryState, RuleOffer, TranscriptEntry, YourWords } from "@aria/protocol";
import { describe, expect, it } from "vitest";
import { leftOutIds, memoryHint, memoryPrefill, offerFor, refusedBy, yourWordsIn } from "../src/renderer/src/flow";

const offer = (id: string, over: Partial<RuleOffer> = {}): RuleOffer => ({ id, at: 1, command: "curl https://example.com", scope: "sandboxed", decided: "never", rules: [{ match: "curl https://example.com", exact: true }], ...over });

describe("Always allow this on refused steps", () => {
  it("finds a refused step's offer by its tool call, else a permission row by its command, each offer once", () => {
    const offers = [offer("a", { toolCallId: "call-1" }), offer("b"), offer("asked", { toolCallId: "call-2", decided: "ask" })];
    const used = new Set<string>();
    const tool = (id: string, success: boolean): TranscriptEntry => ({ kind: "tool", id, at: 1, name: "powershell", success });
    const permission = (id: string, toolCallId?: string, detail = "Run curl https://example.com"): TranscriptEntry => ({ kind: "permission", id, at: 1, detail, approved: false, ...(toolCallId ? { toolCallId } : {}) });
    expect(offerFor(tool("call-1", true), offers, used)).toBeUndefined();
    // The runtime's permission row for the call takes it; the call's own row then has nothing more.
    expect(offerFor(permission("p1", "call-1"), offers, used)?.id).toBe("a");
    expect(offerFor(tool("call-1", false), offers, used)).toBeUndefined();
    // Without a tool call id: by the command it ran.
    expect(offerFor(permission("p2", undefined, "Run something else"), offers, used)).toBeUndefined();
    expect(offerFor(permission("p3"), offers, used)?.id).toBe("b");
    expect(offerFor(permission("p4"), offers, used)).toBeUndefined();
    // One that asked is on its card, not on a step.
    expect(offerFor(tool("call-2", false), offers, new Set())).toBeUndefined();
    expect(offerFor(tool("call-1", false), offers, new Set())?.id).toBe("a");
  });

  it("says which of your Never rules refused the step (it says refused, not failed)", () => {
    expect(refusedBy(offer("a", { overrides: [{ ruleId: "r1", match: "curl", sameRule: false }] }))).toBe("your rule “curl” (Never)");
    expect(refusedBy(offer("a", { overrides: [{ ruleId: "r1", match: "curl", sameRule: false }, { ruleId: "r2", match: "curl <url>", sameRule: false }] }))).toBe("your rules “curl”, “curl <url>” (Never)");
    // The rule changed since: still yours, though it can't be named.
    expect(refusedBy(offer("a"))).toBe("a Never rule of yours");
  });
});

describe("Save as memory", () => {
  it("is offered on your messages and on your own answers in the session view", () => {
    const words: YourWords[] = [
      { id: "w1", kind: "message", text: "Keep the logo", at: 1 },
      { id: "w2", kind: "answer", text: "Comet", at: 2, questionId: "q" },
    ];
    expect(yourWordsIn({ kind: "user", id: "u", at: 1, text: "Keep the logo\n" }, words)?.id).toBe("w1");
    expect(yourWordsIn({ kind: "user", id: "u", at: 1, text: "Keep the logo", source: "system" }, words)).toBeUndefined();
    expect(yourWordsIn({ kind: "user", id: "u", at: 1, text: "Comet" }, words)).toBeUndefined();
    expect(yourWordsIn({ kind: "question", id: "q", at: 1, question: "Name?", answer: "Comet" }, words)?.id).toBe("w2");
    expect(yourWordsIn({ kind: "question", id: "q", at: 1, question: "Name?" }, words)).toBeUndefined();
    expect(yourWordsIn({ kind: "assistant", id: "a", at: 1, text: "Keep the logo" }, words)).toBeUndefined();
  });

  it("starts the note from the first line of your words, cut to 300 characters, and says what the engine will refuse", () => {
    expect(memoryPrefill("  Use pnpm here.\nAnd more  ")).toBe("Use pnpm here.");
    expect(memoryPrefill("x".repeat(400))).toHaveLength(300);
    expect(memoryHint("ok")).toBeUndefined();
    expect(memoryHint(" ")).toMatch(/Write the note/);
    expect(memoryHint("x".repeat(301))).toMatch(/300 characters/);
    expect(memoryHint("a {{b}}")).toMatch(/\{\{/);
  });

  it("marks the notes a project's briefs leave out", () => {
    const state: MemoryState = { memories: [], templateUsesMemory: true, leftOut: [{ repoId: 3, ids: ["a"] }, { repoId: null, ids: ["b"] }] };
    expect([...leftOutIds(state, 3)]).toEqual(["a"]);
    expect([...leftOutIds(state, null)]).toEqual(["b"]);
    expect(leftOutIds(state, 4).size).toBe(0);
  });
});
