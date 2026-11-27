/**
 * The transcript mapper (runtime/sdk-transcript.ts) over SDK-shaped events: what the session view and ARIA's inspector
 * show (PLAN.md §5.3).
 */
import { readFileSync } from "node:fs";
import type { SessionEvent } from "@github/copilot-sdk";
import { describe, expect, it } from "vitest";
import { TranscriptMapper } from "../src/runtime/sdk-transcript.ts";

let n = 0;
const event = (type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ id: `e${++n}`, parentId: null, timestamp: new Date(1_000_000 + n * 1000).toISOString(), type, data, ...extra }) as unknown as SessionEvent;

describe("TranscriptMapper", () => {
  it("keeps messages whole only when asked, cuts them without a marker in the text, and marks what the runtime added", () => {
    const long = "a".repeat(10_000);
    const typed = event("user.message", { content: long, transformedContent: `<current_datetime/>\n${long}` });
    expect(new TranscriptMapper().apply(typed)[0]).toMatchObject({ kind: "user", text: "a".repeat(4_000), textCut: 6_000 });
    const whole = new TranscriptMapper({ maxMessageText: Number.POSITIVE_INFINITY });
    expect(whole.apply(typed)[0]).toEqual({ kind: "user", id: typed.id, at: Date.parse((typed as { timestamp: string }).timestamp), text: long });
    const added = whole.apply(event("user.message", { content: "<system_notification>done</system_notification>", source: "system" }))[0];
    expect(added).toMatchObject({ kind: "user", source: "system", text: "<system_notification>done</system_notification>" });
    // Answers: a cut never lands inside the Markdown (it could be inside a code block).
    const answer = event("assistant.message", { messageId: "m1", content: "```ts\n" + "x".repeat(6_000) });
    expect(new TranscriptMapper().apply(answer)[0]).toEqual(expect.objectContaining({ kind: "assistant", text: ("```ts\n" + "x".repeat(6_000)).slice(0, 4_000), textCut: 2_006 }));
    expect(whole.apply(answer)[0]).not.toHaveProperty("textCut");
  });

  it("cuts a tool's arguments and result at its limit and says how much is left out", () => {
    const mapper = new TranscriptMapper({ maxToolText: 20_000 });
    const [start] = mapper.apply(event("tool.execution_start", { toolCallId: "t1", toolName: "Svc-get_items", mcpServerName: "Svc", mcpToolName: "get_items", arguments: { q: "x".repeat(25_000) } }));
    expect(start).toMatchObject({ kind: "tool", name: "Svc/get_items", argsCut: expect.any(Number) });
    expect((start as { args: string }).args).toHaveLength(20_000);
    const [done] = mapper.apply(event("tool.execution_complete", { toolCallId: "t1", success: true, result: { content: "r".repeat(25_000) } }));
    expect(done).toMatchObject({ kind: "tool", success: true, result: "r".repeat(20_000), resultCut: 5_000, ms: 1000 });
    // Workers keep the 4,000 limit; a failed call's error is cut the same way.
    const worker = new TranscriptMapper();
    worker.apply(event("tool.execution_start", { toolCallId: "t2", toolName: "view", arguments: { path: "a" } }));
    expect(worker.apply(event("tool.execution_complete", { toolCallId: "t2", success: true, result: { content: "r".repeat(5_000) } }))[0]).toMatchObject({ resultCut: 1_000 });
    worker.apply(event("tool.execution_start", { toolCallId: "t3", toolName: "view", arguments: { path: "b" } }));
    const [failed] = worker.apply(event("tool.execution_complete", { toolCallId: "t3", success: false, error: { message: "e".repeat(4_500) } }));
    expect(failed).toMatchObject({ success: false, error: "e".repeat(4_000), errorCut: 500 });
  });

  it("ties a permission request to its tool call when the runtime says which one", () => {
    const mapper = new TranscriptMapper();
    mapper.apply(event("permission.requested", { requestId: "p1", permissionRequest: { kind: "custom-tool", toolName: "start_task", toolCallId: "t1" } }));
    expect(mapper.apply(event("permission.completed", { requestId: "p1", result: { kind: "denied-interactively-by-user", feedback: "No." } }))[0]).toEqual(
      expect.objectContaining({ kind: "permission", approved: false, reason: "No.", toolCallId: "t1" }),
    );
    mapper.apply(event("permission.requested", { requestId: "p2", permissionRequest: { kind: "url", url: "https://x.example" } }));
    expect(mapper.apply(event("permission.completed", { requestId: "p2", toolCallId: "t9", result: { kind: "approved" } }))[0]).toMatchObject({ approved: true, toolCallId: "t9" });
  });

  it("says when the session summarized its older messages, and doesn't call a failed attempt a success", () => {
    const mapper = new TranscriptMapper();
    const [ok] = mapper.apply(event("session.compaction_complete", { success: true, messagesRemoved: 12, summaryContent: "The user prefers pnpm." }));
    expect(ok).toMatchObject({ kind: "info", level: "info", text: expect.stringContaining("12 earlier messages: yours, the answers and the tool calls"), detail: "The user prefers pnpm." });
    const [long] = mapper.apply(event("session.compaction_complete", { success: true, summaryContent: "s".repeat(4_100) }));
    expect(long).toMatchObject({ detail: "s".repeat(4_000), detailCut: 100 });
    const [failed] = mapper.apply(event("session.compaction_complete", { success: false, error: "context too large" }));
    expect(failed).toMatchObject({ kind: "info", level: "warning", text: expect.stringContaining("failed: context too large") });
    expect(failed).not.toHaveProperty("detail");
    // Sub-agents' compactions aren't the session's.
    expect(mapper.apply(event("session.compaction_complete", { success: true }, { agentId: "sub" }))).toEqual([]);
  });

  it("over the real runtime's events (spike 15): answers as you gave them, and a refusal tied to its step", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/spike15-events.json", import.meta.url), "utf8")) as { events: SessionEvent[] };
    const mapper = new TranscriptMapper();
    for (const e of fixture.events) mapper.apply(e);
    const entries = mapper.all();
    // The runtime's result is "User selected: Green" / "User responded: <your words>": the answer is what follows.
    expect(entries.filter((e) => e.kind === "question").map((e) => (e as { answer?: string }).answer)).toEqual([
      "Green",
      "Teal",
      "  Moonrise uses pnpm, not npm.\n  Keep it that way.  ",
    ]);
    const refused = entries.find((e) => e.kind === "permission" && e.approved === false) as { toolCallId?: string; detail: string };
    expect(refused.detail).toBe("Run Get-Location");
    expect(entries.find((e) => e.kind === "tool" && e.id === refused.toolCallId)).toMatchObject({ name: "powershell", success: false });
    expect(entries.at(-1)).toMatchObject({ kind: "info", text: expect.stringContaining("13 earlier messages") });
  });

  it("takes off only the runtime's own prefix of an answer", () => {
    const mapper = new TranscriptMapper();
    const answer = (content: string, id: string) => {
      mapper.apply(event("tool.execution_start", { toolCallId: id, toolName: "ask_user", arguments: { question: "Which?" } }));
      return (mapper.apply(event("tool.execution_complete", { toolCallId: id, success: true, result: { content } }))[0] as { answer?: string }).answer;
    };
    expect(answer("User responded: User selected: both", "a1")).toBe("User selected: both");
    expect(answer("Something else", "a2")).toBe("Something else");
    expect(answer("user responded: lower case isn't the runtime's", "a3")).toBe("user responded: lower case isn't the runtime's");
  });

  it("live, remembers only what can still change, so a session that runs for months doesn't pile up entries", () => {
    const mapper = new TranscriptMapper({ live: true });
    mapper.apply(event("user.message", { content: "hi" }));
    mapper.apply(event("assistant.message", { messageId: "m1", content: "Hello" }));
    expect(mapper.tracked).toBe(0);
    mapper.apply(event("tool.execution_start", { toolCallId: "t1", toolName: "list_repos", arguments: {} }));
    mapper.apply(event("permission.requested", { requestId: "p1", permissionRequest: { kind: "custom-tool", toolName: "list_repos" } }));
    mapper.apply(event("tool.execution_start", { toolCallId: "q1", toolName: "ask_user", arguments: { question: "Which?" } }));
    expect(mapper.tracked).toBe(3);
    expect(mapper.apply(event("permission.completed", { requestId: "p1", result: { kind: "approved" } }))[0]).toMatchObject({ approved: true });
    expect(mapper.apply(event("tool.execution_complete", { toolCallId: "t1", success: true, result: { content: "[]" } }))[0]).toMatchObject({ success: true, result: "[]" });
    expect(mapper.apply(event("tool.execution_complete", { toolCallId: "q1", success: true, result: { content: "That one" } }))[0]).toMatchObject({ answer: "That one" });
    expect(mapper.tracked).toBe(0);
    expect(() => mapper.all()).toThrow(/keeps no history/);
  });
});
