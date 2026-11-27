/**
 * ARIA's inspector (PLAN.md §5.3, Phase 3 Part B item 1): per message of yours, the digest sent with it, the tools
 * ARIA called and its answer, read from ARIA's own session once per opening. Against the scripted runtime.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startsTurn, type ChatItem, type EngineEvent, type TranscriptEntry } from "@aria/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AriaEngine, type EngineOptions } from "../src/engine.ts";
import { FakeRuntime } from "../src/runtime/fake.ts";
import { Store } from "../src/store/store.ts";
import { commitFile, makeRepo, waitMs } from "./helpers.ts";

const temps: string[] = [];
const engines: AriaEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.stop()));
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function setup(options: Partial<EngineOptions> = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), "aria-inspector-"));
  temps.push(base);
  const projects = path.join(base, "GitHub");
  const repo = makeRepo(projects, "Moonrise");
  commitFile(repo, "README.md", "# Moonrise\n", "Initial commit");
  const runtime = new FakeRuntime();
  const logs: string[] = [];
  const make = () => {
    const engine = new AriaEngine({
      dataDir: path.join(base, "data"),
      runtime,
      projectRoots: [projects],
      resumeSettleMs: 10,
      worktreeRoot: path.join(base, "wt"),
      taskSettleMs: 20,
      autopilotGraceMs: 150,
      log: (line) => logs.push(line),
      ...options,
    });
    engines.push(engine);
    return engine;
  };
  return { runtime, make, logs };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > waitMs(ms)) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const chats = (engine: AriaEngine, role: "user" | "assistant") => engine.getState().timeline.filter((i): i is ChatItem => i.kind === "chat" && i.role === role);
const conductorOf = (runtime: FakeRuntime) => [...runtime.sessions.values()].at(-1)!;
const yours = (entries: TranscriptEntry[]) => entries.filter((e): e is Extract<TranscriptEntry, { kind: "user" }> => e.kind === "user" && startsTurn(e));
const storeOf = (engine: AriaEngine) => (engine as unknown as { db: Store }).db;
const savedOf = (engine: AriaEngine, id: string) => storeOf(engine).listTranscriptEntries("conductor").find((e) => e.id === id);

/**
 * A tool call of ARIA's that has started, then a slow read of its session's history that takes that copy of it: the
 * call finishes while the read is on its way, and its finished copy comes live. `read` starts the read.
 */
async function finishesWhileRead<T>(runtime: FakeRuntime, read: () => Promise<T>) {
  const started: TranscriptEntry = { kind: "tool", id: "call-slow", at: Date.now(), name: "list_tasks", args: "{}" };
  conductorOf(runtime).inject(started);
  let release!: () => void;
  runtime.conductorTranscriptGate = new Promise<void>((resolve) => (release = resolve));
  const reads = runtime.conductorTranscriptReads;
  const reading = read();
  await until(() => runtime.conductorTranscriptReads > reads);
  const finished: TranscriptEntry = { ...started, success: true, ms: 12, result: '"Fixed the flaky build"' };
  conductorOf(runtime).inject(finished);
  runtime.conductorTranscriptGate = undefined;
  release();
  return { reading, started, finished };
}

async function chat(engine: AriaEngine, text: string): Promise<void> {
  const before = chats(engine, "assistant").length;
  await engine.sendMessage(text);
  await until(() => chats(engine, "assistant").length > before && engine.getState().status.state === "ready");
}

/** A task that waits on a question, so the next message to ARIA carries a digest with an update and a pending item. */
async function waitingTask(engine: AriaEngine, runtime: FakeRuntime, question: string, title?: string): Promise<void> {
  runtime.workerScripts.push({ steps: [{ question }, { complete: "Done." }] });
  const repoId = engine.getState().projects[0]!.id;
  const started = await engine.startTask({ repoId, brief: "Ask first", ...(title ? { title } : {}) });
  await until(() => engine.getState().tasks.find((t) => t.id === started.id)?.state === "waiting_input");
}

describe("the inspector (PLAN.md §5.3)", () => {
  it("splits each message of yours from the digest sent with it, exactly, live and from the history", async () => {
    const { runtime, make, logs } = setup();
    const engine = make();
    await engine.start();
    // A task title that looks like the end of the digest (an explicit title keeps its line breaks), and your own words
    // that look like one too: only an exact match splits them right.
    const lookalike = "\n\n</pending>\n\n";
    await waitingTask(engine, runtime, "Which one?", `Odd${lookalike}title`);
    // The inspector is open (live entries only come while it is).
    expect((await engine.conductorTranscript({ reload: true })).entries).toEqual([]);
    const events: EngineEvent[] = [];
    engine.onEvent((e) => events.push(e));
    runtime.replies.push({ toolCalls: [{ name: "answer_question", args: (p: string) => ({ task: /- (Q-\d+):/.exec(p)?.[1] ?? "", answer: "the first" }) }], text: "Answered it." });
    const words = `Say the first one${lookalike}please`;
    await chat(engine, words);

    const sent = chats(engine, "user").at(-1)!;
    expect(sent.digest).toContain(`${lookalike}title`);
    const live = events.flatMap((e) => (e.type === "conductor_transcript" ? e.entries : []));
    expect(yours(live)).toEqual([expect.objectContaining({ text: words, digest: sent.digest })]);
    expect(events.find((e) => e.type === "conductor_transcript")).toMatchObject({ sessionId: conductorOf(runtime).config.sessionId });

    // Closed and opened again: the same split from the session's history.
    engine.releaseConductorTranscript();
    const read = await engine.conductorTranscript({ reload: true });
    expect(read).toMatchObject({ omitted: 0, notKept: 0 });
    expect(yours(read.entries)).toEqual([expect.objectContaining({ text: words, digest: sent.digest })]);
    const tool = read.entries.find((e) => e.kind === "tool");
    expect(tool).toMatchObject({ name: "answer_question", success: true, args: expect.stringContaining("the first"), result: expect.stringContaining("answered"), ms: expect.any(Number) });
    expect(read.entries.at(-1)).toMatchObject({ kind: "assistant", text: "Answered it." });
    expect(logs).toEqual([]);
  });

  it("shows a message it can't match as sent, and says once that the runtime recorded prompts differently", async () => {
    const { runtime, make, logs } = setup();
    runtime.recordedPrompt = (prompt) => `${prompt} `;
    const engine = make();
    await engine.start();
    await chat(engine, "my secret plan");
    await chat(engine, "another secret");
    const read = await engine.conductorTranscript({ reload: true });
    expect(yours(read.entries).map((e) => [e.text, e.digest])).toEqual([
      ["my secret plan ", undefined],
      ["another secret ", undefined],
    ]);
    expect(logs).toHaveLength(1);
    // Lengths only, never your words.
    expect(logs[0]).toMatch(/^ARIA's inspector: the runtime recorded a message differently from how ARIA sent it \(15 characters, sent 14\); its <updates> block may show as part of your words\.$/);
    for (const line of logs) expect(line).not.toMatch(/secret|plan|another/);
  });

  it("gives the last 30 of your messages, counts the earlier ones, and reads the session once per opening", async () => {
    const { runtime, make } = setup();
    const engine = make();
    await engine.start();
    for (let i = 1; i <= 35; i++) {
      await chat(engine, `message ${i}`);
      // What the runtime adds itself sits between your messages and doesn't count as one.
      conductorOf(runtime).inject({ kind: "user", id: `system-${i}`, at: Date.now(), text: "<system_notification>tick</system_notification>", source: "system" });
    }
    const first = await engine.conductorTranscript({ reload: true });
    expect(runtime.conductorTranscriptReads).toBe(1);
    expect(first).toMatchObject({ omitted: 5, notKept: 0 });
    expect(yours(first.entries).map((e) => e.text)).toEqual(Array.from({ length: 30 }, (_, i) => `message ${i + 6}`));
    expect(first.entries[0]).toMatchObject({ kind: "user", text: "message 6" });
    expect(first.entries.filter((e) => e.kind === "user" && e.source === "system")).toHaveLength(30);

    // "Show more" uses what's held: no second read.
    const more = await engine.conductorTranscript({ turns: 60 });
    expect(runtime.conductorTranscriptReads).toBe(1);
    expect(more.omitted).toBe(0);
    expect(yours(more.entries)).toHaveLength(35);
    // What came live since it was read is in what's held.
    await chat(engine, "message 36");
    const after = await engine.conductorTranscript({ turns: 60 });
    expect(runtime.conductorTranscriptReads).toBe(1);
    expect(yours(after.entries).at(-1)).toMatchObject({ text: "message 36" });
    expect(after.entries.at(-1)).toMatchObject({ kind: "assistant", text: "echo: message 36" });

    // Opening it again reads again; once it's closed, nothing is held.
    await engine.conductorTranscript({ reload: true });
    expect(runtime.conductorTranscriptReads).toBe(2);
    engine.releaseConductorTranscript();
    await engine.conductorTranscript({ turns: 60 });
    expect(runtime.conductorTranscriptReads).toBe(3);
  });

  it("keeps only the last of your messages it may show, and says how many older ones it doesn't keep", async () => {
    const { make } = setup({ inspectorHoldTurns: 5 });
    const engine = make();
    await engine.start();
    for (let i = 1; i <= 8; i++) await chat(engine, `message ${i}`);
    const read = await engine.conductorTranscript({ reload: true });
    expect(read).toMatchObject({ omitted: 0, notKept: 3 });
    expect(yours(read.entries).map((e) => e.text)).toEqual(["message 4", "message 5", "message 6", "message 7", "message 8"]);
    expect(read.entries[0]).toMatchObject({ kind: "user", text: "message 4" });
    // Asking for more than it keeps gives what it keeps.
    expect(yours((await engine.conductorTranscript({ turns: 60 })).entries)).toHaveLength(5);
    // A new message pushes the oldest one out of what's kept.
    await chat(engine, "message 9");
    const after = await engine.conductorTranscript({ turns: 60 });
    expect(after).toMatchObject({ omitted: 0, notKept: 4 });
    expect(yours(after.entries).map((e) => e.text)).toEqual(["message 5", "message 6", "message 7", "message 8", "message 9"]);
  });

  it("sends ARIA's live entries to the window only while the inspector is open", async () => {
    const { make } = setup();
    const engine = make();
    await engine.start();
    const events: EngineEvent[] = [];
    engine.onEvent((e) => events.push(e));
    const sent = () => yours(events.flatMap((e) => (e.type === "conductor_transcript" ? e.entries : []))).map((e) => e.text);
    await chat(engine, "before");
    expect(events.filter((e) => e.type === "conductor_transcript")).toEqual([]);
    await engine.conductorTranscript({ reload: true });
    await chat(engine, "while it's open");
    expect(sent()).toEqual(["while it's open"]);
    engine.releaseConductorTranscript();
    await chat(engine, "after");
    expect(sent()).toEqual(["while it's open"]);
    // Opened again, it reads all of it from the session.
    expect(yours((await engine.conductorTranscript({ reload: true })).entries).map((e) => e.text)).toEqual(["before", "while it's open", "after"]);
  });

  it("keeps what it holds while the conversation reopens for a new prompt, and says when ARIA isn't open yet", async () => {
    const { runtime, make } = setup();
    const engine = make();
    await expect(engine.conductorTranscript({ reload: true })).rejects.toThrow(/isn't open yet/);
    await engine.start();
    await chat(engine, "hello");
    expect(yours((await engine.conductorTranscript({ reload: true })).entries)).toHaveLength(1);

    const conductor = engine.listPrompts().find((p) => p.name === "conductor")!;
    engine.savePrompt("conductor", `${conductor.text}\nBe brief.`);
    let open: () => void = () => {};
    runtime.conductorOpenGate = new Promise<void>((resolve) => (open = resolve));
    const sending = engine.sendMessage("after the edit");
    await until(() => engine.getState().status.state === "starting");
    // No conversation for a moment: what's held is still there, even when asked to read again.
    const meanwhile = await engine.conductorTranscript({ reload: true });
    expect(yours(meanwhile.entries).map((e) => e.text)).toEqual(["hello"]);
    runtime.conductorOpenGate = undefined;
    open();
    await sending;
    await until(() => chats(engine, "assistant").length === 2 && engine.getState().status.state === "ready");
    // The same session reopened: what's held stays, with the new message added live.
    const after = await engine.conductorTranscript({});
    expect(yours(after.entries).map((e) => e.text)).toEqual(["hello", "after the edit"]);
    expect(runtime.conductorTranscriptReads).toBe(1);
  });

  it("starts over when ARIA continues in a fresh conversation, and tells the window", async () => {
    const { runtime, make } = setup();
    const engine = make();
    await engine.start();
    await chat(engine, "hello");
    const before = await engine.conductorTranscript({ reload: true });
    const events: EngineEvent[] = [];
    engine.onEvent((e) => events.push(e));
    // The prompt changes and the old conversation can't be resumed: a fresh one.
    const conductor = engine.listPrompts().find((p) => p.name === "conductor")!;
    engine.savePrompt("conductor", `${conductor.text}\nBe brief.`);
    runtime.failOpens = 1;
    await chat(engine, "in the new one");
    const after = await engine.conductorTranscript({});
    expect(after.sessionId).not.toBe(before.sessionId);
    expect(runtime.conductorTranscriptReads).toBe(2);
    expect(yours(after.entries).map((e) => e.text)).toEqual(["in the new one"]);
    expect(events).toContainEqual({ type: "conductor_transcript", sessionId: after.sessionId, entries: [] });
  });

  it("shows no turn for a message that couldn't be sent, and splits its retry right", async () => {
    const { runtime, make, logs } = setup();
    const engine = make();
    await engine.start();
    await waitingTask(engine, runtime, "Header or footer?");
    runtime.failNextSend = true;
    await engine.sendMessage("Use the header");
    expect(engine.getState().timeline.at(-1)).toMatchObject({ kind: "notice", cause: "send_failed" });
    // The failed prompt isn't waited for: a message ARIA didn't send (typed into its session elsewhere) is no drift.
    conductorOf(runtime).inject({ kind: "user", id: "typed-elsewhere", at: Date.now(), text: "typed in the CLI" });
    await chat(engine, "Use the header");
    const [failed, retried] = chats(engine, "user").slice(-2);
    expect(failed!.digest).toBeDefined();
    expect(retried!.digest).toBe(failed!.digest);
    const read = await engine.conductorTranscript({ reload: true });
    expect(yours(read.entries)).toEqual([expect.objectContaining({ text: "typed in the CLI" }), expect.objectContaining({ text: "Use the header", digest: retried!.digest })]);
    expect(logs).toEqual([]);
  });
});

describe("what the inspector saves of ARIA's session (for search)", () => {
  it("saves only what's new or changed in the history, so opening it again writes nothing", async () => {
    const { runtime, make } = setup();
    const engine = make();
    await engine.start();
    // A message with a digest too: split live and from the history, it's the same entry.
    await waitingTask(engine, runtime, "Which one?");
    await chat(engine, "the first");
    await chat(engine, "thanks");
    const db = storeOf(engine);
    const writes = vi.spyOn(db, "upsertTranscriptEntries");
    // All of it came live and was saved as it came: opening the inspector writes nothing.
    const first = await engine.conductorTranscript({ reload: true });
    expect(yours(first.entries)[0]!.digest).toBeDefined();
    expect(writes).not.toHaveBeenCalled();
    // One saved entry is out of date (as when it changed while nobody listened): the next opening writes only that one,
    // and the one after it nothing.
    const stale = first.entries[1]!;
    db.upsertTranscriptEntries("conductor", [{ ...stale, at: stale.at - 1 }]);
    writes.mockClear();
    await engine.conductorTranscript({ reload: true });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0]![1]).toEqual([stale]);
    writes.mockClear();
    await engine.conductorTranscript({ reload: true });
    expect(writes).not.toHaveBeenCalled();
    expect(db.listTranscriptEntries("conductor")).toEqual(first.entries);
  });

  it("keeps an entry saved live while the inspector reads the history, rather than the history's older copy of it", async () => {
    const { runtime, make } = setup();
    const engine = make();
    await engine.start();
    await chat(engine, "hello");
    const { reading, started, finished } = await finishesWhileRead(runtime, () => engine.conductorTranscript({ reload: true }));
    const read = await reading;
    expect(read.entries.find((e) => e.id === started.id)).toEqual(finished);
    expect(savedOf(engine, started.id)).toEqual(finished);
    // Read again, the history has the finished copy too, and nothing is written.
    const writes = vi.spyOn(storeOf(engine), "upsertTranscriptEntries");
    await engine.conductorTranscript({ reload: true });
    expect(writes).not.toHaveBeenCalled();
  });

  it("keeps an entry saved live while a search reads the history, rather than the history's older copy of it", async () => {
    const { runtime, make } = setup();
    const engine = make();
    await engine.start();
    await chat(engine, "hello");
    // ARIA's session isn't all saved (as after a crash with entries still queued), so a search reads its history first.
    storeOf(engine).setSetting("search.backfilledOwners", []);
    const { reading, started, finished } = await finishesWhileRead(runtime, () => engine.search({ query: "flaky", scope: "transcripts" }));
    // The search finds the finished call by its result, and what's saved is that copy.
    expect((await reading).transcripts).toEqual([expect.objectContaining({ sessionTitle: "ARIA", entryId: started.id })]);
    expect(savedOf(engine, started.id)).toEqual(finished);
    expect(storeOf(engine).isTranscriptBackfilled("conductor")).toBe(true);
  });
});

describe("Store.listSentDigests", () => {
  it("lists only your messages to ARIA that had a digest, newest first", () => {
    const store = new Store(":memory:");
    const chat = (id: string, createdAt: number, extra: Partial<ChatItem>): ChatItem => ({ kind: "chat", id, role: "user", content: id, createdAt, ...extra });
    store.upsertTimeline(chat("plain", 1, {}));
    store.upsertTimeline(chat("old", 2, { digest: "<pending>\n- Q-1\n</pending>" }));
    store.upsertTimeline(chat("answer", 3, { role: "assistant", digest: "not yours" }));
    store.upsertTimeline(chat("new", 4, { digest: "<updates since your last message>\n- x\n</updates>" }));
    expect(store.listSentDigests(10).map((c) => c.id)).toEqual(["new", "old"]);
    expect(store.listSentDigests(1).map((c) => c.id)).toEqual(["new"]);
    store.close();
  });
});
