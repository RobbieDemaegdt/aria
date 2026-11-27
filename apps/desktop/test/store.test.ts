import type { AppState, ChatItem, ConductorTranscript, EngineEvent, AriaApi, NoticeItem, Task, TranscriptEntry, TranscriptPage } from "@aria/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeLive, reloaded, selectAgents, useAria, withEarlier, type LoadedTranscript } from "../src/renderer/src/store";

// A stand-in for the preload bridge: the test decides when getState() answers and which events arrive meanwhile.
const listeners = new Set<(event: EngineEvent) => void>();
const answers: Array<(state: AppState) => void> = [];
const transcriptAsks: Array<{ input: Parameters<AriaApi["getTranscript"]>[0]; answer: (page: TranscriptPage) => void; fail: (error: Error) => void }> = [];
const inspectorAsks: Array<{ input: { turns?: number; reload?: boolean }; answer: (result: ConductorTranscript) => void; fail: (error: Error) => void }> = [];
let releases = 0;
const api: Partial<AriaApi> = {
  onEvent(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getState: () => new Promise<AppState>((resolve) => answers.push(resolve)),
  getTranscript: (input) => new Promise<TranscriptPage>((answer, fail) => transcriptAsks.push({ input, answer, fail })),
  getConductorTranscript: (input) => new Promise<ConductorTranscript>((answer, fail) => inspectorAsks.push({ input, answer, fail })),
  releaseConductorTranscript: async () => {
    releases++;
  },
};
(globalThis as { window?: unknown }).window = { aria: api };

const emit = (event: EngineEvent) => listeners.forEach((listener) => listener(event));
const snapshot = (over: Partial<AppState> = {}): AppState => ({
  status: { state: "starting", detail: "Starting" },
  timeline: [],
  projects: [],
  models: [],
  conductor: {},
  ui: { sidebarCollapsed: false, view: "chat" },
  tasks: [],
  profiles: [],
  profilePolicy: "me",
  policy: { rules: [], sandbox: { supported: true, enabled: true, allowedHosts: [], allowedPaths: [] } },
  attention: { focusMode: false, awayMinutes: 15 },
  memory: { memories: [], templateUsesMemory: true, leftOut: [] },
  integrations: { servers: [], tools: [], runtimeUp: true, refreshing: false },
  watches: [],
  github: { status: "off", inbox: false },
  ...over,
});
const chat = (id: string, role: ChatItem["role"], content = id): ChatItem => ({ kind: "chat", id, role, content, createdAt: 1 });
const notice = (id: string, message: string): NoticeItem => ({ kind: "notice", id, level: "info", message, createdAt: 1 });

describe("renderer store", () => {
  it("keeps events that arrive while the snapshot is on its way instead of letting the snapshot overwrite them", async () => {
    const loading = useAria.getState().load();
    emit({ type: "status", status: { state: "ready", model: "m" } });
    emit({ type: "timeline", item: chat("a1", "assistant", "Hello") });
    emit({ type: "models", models: [{ id: "m", name: "M", efforts: [], enabled: true }] });
    answers.shift()!(snapshot());
    await loading;
    const state = useAria.getState();
    expect(state.loaded).toBe(true);
    expect(state.status).toMatchObject({ state: "ready", model: "m" });
    expect(state.timeline.map((i) => i.id)).toEqual(["a1"]);
    expect(state.models.map((m) => m.id)).toEqual(["m"]);
  });

  it("installs only the newest snapshot when loads overlap, with one event subscription", async () => {
    const first = useAria.getState().load();
    const second = useAria.getState().load();
    const [answerFirst, answerSecond] = [answers.shift()!, answers.shift()!];
    answerSecond(snapshot({ status: { state: "ready", model: "new" } }));
    await second;
    answerFirst(snapshot({ status: { state: "starting", detail: "old" } }));
    await first;
    expect(useAria.getState().status).toMatchObject({ state: "ready", model: "new" });
    expect(listeners.size).toBe(1);
  });

  it("keeps watches up to date in place, newest first, and GitHub's state", () => {
    const watch = (id: number, status: string) => ({ id, shortId: `W-${id}`, kind: "run" as const, title: `run ${id}`, status, tone: "running" as const, until: "completed" as const, state: "active" as const, createdBy: "aria" as const, createdAt: id });
    useAria.setState({ watches: [] });
    const { apply } = useAria.getState();
    apply({ type: "watch", watch: watch(1, "queued") });
    apply({ type: "watch", watch: watch(2, "queued") });
    apply({ type: "watch", watch: { ...watch(1, "in progress"), tone: "ok" } });
    expect(useAria.getState().watches.map((w) => [w.id, w.status])).toEqual([
      [2, "queued"],
      [1, "in progress"],
    ]);
    apply({ type: "github", github: { status: "ok", login: "me", inbox: true } });
    expect(useAria.getState().github).toEqual({ status: "ok", login: "me", inbox: true });
  });

  it("updates timeline items in place", () => {
    useAria.setState({ timeline: [chat("u1", "user"), notice("n1", "before"), chat("a1", "assistant")], streaming: [] });
    useAria.getState().apply({ type: "timeline", item: notice("n1", "after") });
    const state = useAria.getState();
    expect(state.timeline.map((i) => i.id)).toEqual(["u1", "n1", "a1"]);
    expect(state.timeline[1]).toMatchObject({ message: "after" });
  });

  describe("streamed chunks", () => {
    let updates = 0;
    let stop: () => void = () => {};
    /** Frames booked with requestAnimationFrame: frame() runs them. */
    let frames: Array<(time: number) => void> = [];
    const frame = () => frames.splice(0).forEach((run) => run(0));
    const streaming = () => useAria.getState().streaming;
    beforeEach(() => {
      frames = [];
      vi.stubGlobal("requestAnimationFrame", (run: (time: number) => void) => frames.push(run));
      useAria.setState({ timeline: [], streaming: [], status: { state: "busy" }, activity: null });
      updates = 0;
      stop = useAria.subscribe(() => updates++);
    });
    afterEach(() => {
      stop();
      // Runs a frame still booked, so the next test starts with none.
      frame();
      vi.unstubAllGlobals();
    });

    it("go in once a frame, in one update", () => {
      const { apply } = useAria.getState();
      for (let i = 0; i < 100; i++) apply({ type: "delta", itemId: "a1", text: `${i % 10}` });
      expect(frames).toHaveLength(1);
      expect(updates).toBe(0);
      expect(streaming()).toEqual([]);
      frame();
      expect(updates).toBe(1);
      expect(streaming()).toEqual([{ id: "a1", text: "0123456789".repeat(10) }]);
      // The next frame adds to it, also in one update, as a new object (the one before stays as it was).
      const before = streaming()[0];
      for (let i = 0; i < 100; i++) apply({ type: "delta", itemId: "a1", text: "x" });
      frame();
      expect(updates).toBe(2);
      expect(streaming()).toEqual([{ id: "a1", text: `${"0123456789".repeat(10)}${"x".repeat(100)}` }]);
      expect(before).toEqual({ id: "a1", text: "0123456789".repeat(10) });
      // Nothing new: no frame is booked.
      expect(frames).toHaveLength(0);
    });

    it("keep the messages in the order they started", () => {
      const { apply } = useAria.getState();
      apply({ type: "delta", itemId: "a1", text: "One" });
      apply({ type: "delta", itemId: "a2", text: "Two" });
      apply({ type: "delta", itemId: "a1", text: " more" });
      frame();
      expect(streaming()).toEqual([
        { id: "a1", text: "One more" },
        { id: "a2", text: "Two" },
      ]);
    });

    it("go in before an event that changes the timeline or what's streaming, and wait for their frame otherwise", () => {
      const { apply } = useAria.getState();
      apply({ type: "delta", itemId: "a1", text: "Hel" });
      apply({ type: "delta", itemId: "a2", text: "Other" });
      apply({ type: "delta", itemId: "a1", text: "lo" });
      // Something else in the timeline: the chunks before it are in, without waiting for the frame.
      apply({ type: "timeline", item: notice("n1", "Note") });
      expect(streaming()).toEqual([
        { id: "a1", text: "Hello" },
        { id: "a2", text: "Other" },
      ]);
      // The final message replaces its chunks.
      apply({ type: "delta", itemId: "a1", text: "!" });
      apply({ type: "timeline", item: chat("a1", "assistant", "Hello!") });
      expect(useAria.getState().timeline.map((i) => i.id)).toEqual(["n1", "a1"]);
      expect(streaming()).toEqual([{ id: "a2", text: "Other" }]);
      // An event that doesn't touch the reply leaves the chunks to their frame.
      apply({ type: "delta", itemId: "a2", text: " one" });
      apply({ type: "activity", label: "Reading" });
      expect(useAria.getState().activity).toBe("Reading");
      expect(streaming()).toEqual([{ id: "a2", text: "Other" }]);
      frame();
      expect(streaming()).toEqual([{ id: "a2", text: "Other one" }]);
      // Done: what's streaming goes, with the chunks just before it (going in after it, they'd bring the reply back).
      apply({ type: "delta", itemId: "a2", text: " late" });
      apply({ type: "status", status: { state: "ready" } });
      expect(streaming()).toEqual([]);
      const seen = updates;
      frame();
      expect(updates).toBe(seen);
      expect(streaming()).toEqual([]);
    });

    it("of a message that's already final change nothing, also once it's removed or after a snapshot", async () => {
      useAria.setState({ timeline: [chat("a1", "assistant", "Hello")] });
      updates = 0;
      const { apply } = useAria.getState();
      for (let i = 0; i < 100; i++) apply({ type: "delta", itemId: "a1", text: "late" });
      frame();
      expect(updates).toBe(0);
      expect(streaming()).toEqual([]);
      // Removed afterwards: the chunks that came while it was final stay out.
      apply({ type: "delta", itemId: "a1", text: "late" });
      apply({ type: "timeline_removed", id: "a1" });
      frame();
      expect(streaming()).toEqual([]);

      // Across a snapshot, a reply still streaming keeps its chunks, and one that's final in it gets none.
      apply({ type: "delta", itemId: "a2", text: "Still " });
      const loading = useAria.getState().load();
      emit({ type: "delta", itemId: "a2", text: "going" });
      emit({ type: "delta", itemId: "a3", text: "Hi" });
      answers.shift()!(snapshot({ status: { state: "busy" }, timeline: [chat("a3", "assistant", "Hi")] }));
      await loading;
      frame();
      expect(useAria.getState().timeline.map((i) => i.id)).toEqual(["a3"]);
      expect(streaming()).toEqual([{ id: "a2", text: "Still going" }]);
    });

    it("that came before a snapshot are checked against the timeline they came with", async () => {
      // Final when its late chunk came, and gone from the snapshot: the chunk doesn't bring it back as a reply.
      useAria.setState({ timeline: [chat("x1", "assistant", "Done")] });
      useAria.getState().apply({ type: "delta", itemId: "x1", text: "late" });
      const loading = useAria.getState().load();
      answers.shift()!(snapshot({ status: { state: "busy" }, timeline: [] }));
      await loading;
      frame();
      expect(streaming()).toEqual([]);
    });

    it("go in 16 ms later where there's no requestAnimationFrame", () => {
      vi.unstubAllGlobals();
      vi.useFakeTimers();
      try {
        useAria.getState().apply({ type: "delta", itemId: "a1", text: "Hi" });
        vi.advanceTimersByTime(15);
        expect(streaming()).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(streaming()).toEqual([{ id: "a1", text: "Hi" }]);
      } finally {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
      }
    });
  });

  it("keeps tasks newest first, updates them in place, and closes the session view when its task goes", () => {
    const task = (id: string, state: Task["state"] = "running"): Task =>
      ({ id, title: id, brief: id, repoId: 1, repoName: "R", repoPath: "C:\\r", profileName: "Default", model: "m", mode: "autopilot", state, costCredits: 0, startedBy: "you", createdAt: 1, updatedAt: 1 }) as Task;
    useAria.setState({ tasks: [], openTaskId: null, transcripts: {} });
    const { apply } = useAria.getState();
    apply({ type: "task", task: task("t1") });
    apply({ type: "task", task: task("t2") });
    apply({ type: "task", task: task("t1", "done") });
    expect(useAria.getState().tasks.map((t) => `${t.id}:${t.state}`)).toEqual(["t2:running", "t1:done"]);
    useAria.setState({ openTaskId: "t1", sessionFull: true, transcripts: { t1: { entries: [], omitted: 0, plan: false } } });
    apply({ type: "task_removed", taskId: "t1" });
    expect(useAria.getState()).toMatchObject({ openTaskId: null, sessionFull: false, transcripts: {} });
    expect(useAria.getState().tasks.map((t) => t.id)).toEqual(["t2"]);
  });

  it("keeps the reply target until the reply went, and drops it when its task goes", async () => {
    let fail = true;
    const replies: unknown[] = [];
    api.reply = async (input) => {
      replies.push(input);
      if (fail) throw new Error("Error invoking remote method 'aria:reply': Error: Pick one of: Header, Footer.");
    };
    useAria.setState({ replyTo: null, actionError: null });
    useAria.getState().setReplyTo({ taskId: "t1", title: "Theme", question: { id: "q1", shortId: "Q-1" } });
    expect(await useAria.getState().sendReply("sidebar")).toBe(false);
    // A failed reply keeps its target: the retry can't end up with ARIA by accident.
    expect(useAria.getState().replyTo).toMatchObject({ taskId: "t1" });
    expect(useAria.getState().actionError).toBe("Pick one of: Header, Footer.");
    fail = false;
    expect(await useAria.getState().sendReply("Header")).toBe(true);
    expect(useAria.getState().replyTo).toBeNull();
    expect(replies).toEqual([
      { taskId: "t1", item: { kind: "question", id: "q1" }, text: "sidebar" },
      { taskId: "t1", item: { kind: "question", id: "q1" }, text: "Header" },
    ]);
    useAria.getState().setReplyTo({ taskId: "t2", title: "Other" });
    useAria.getState().apply({ type: "task_removed", taskId: "t2" });
    expect(useAria.getState().replyTo).toBeNull();
  });

  it("merges live transcript entries with the loaded history, including ones that arrive while it loads", async () => {
    useAria.setState({ transcripts: {}, openTaskId: "t9" });
    const entry = (id: string, text: string): TranscriptEntry => ({ kind: "assistant", id, at: 1, text });
    // Not loaded: live entries are ignored (the history will have them).
    emit({ type: "transcript", taskId: "t9", entries: [entry("e0", "ignored")] });
    expect(useAria.getState().transcripts.t9).toBeUndefined();
    const loading = useAria.getState().loadTranscript("t9");
    emit({ type: "transcript", taskId: "t9", entries: [entry("e2", "live while loading")] });
    const ask = transcriptAsks.pop()!;
    expect(ask.input).toEqual({ taskId: "t9" });
    ask.answer({ entries: [entry("e1", "history"), entry("e2", "older copy")], omitted: 0, plan: false });
    await loading;
    expect(useAria.getState().transcripts.t9).toEqual({ entries: [entry("e1", "history"), entry("e2", "live while loading")], omitted: 0, plan: false });
    emit({ type: "transcript", taskId: "t9", entries: [entry("e3", "after"), entry("e1", "history, updated")] });
    expect(useAria.getState().transcripts.t9!.entries.map((e) => (e.kind === "assistant" ? e.text : ""))).toEqual(["history, updated", "live while loading", "after"]);
    useAria.setState({ openTaskId: null, transcripts: {} });
  });

  describe("transcript pages (P4)", () => {
    const step = (id: string, at: number, text = id): TranscriptEntry => ({ kind: "assistant", id, at, text });
    const brief: TranscriptEntry = { kind: "user", id: "s0", at: 0, text: "The brief" };
    /** Steps s<from> to s<to - 1>, step i starting at i. */
    const run = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => step(`s${from + i}`, from + i));
    const page = (entries: TranscriptEntry[], omitted: number, over: Partial<TranscriptPage> = {}): TranscriptPage => ({ entries, omitted, ...(omitted > 0 ? { first: brief } : {}), plan: false, ...over });
    const task = (id: string): Task =>
      ({ id, title: id, brief: id, repoId: 1, repoName: "R", repoPath: "C:\\r", profileName: "Default", model: "m", mode: "autopilot", state: "done", costCredits: 0, startedBy: "you", createdAt: 1, updatedAt: 1 }) as Task;
    /** Answers the first read of `taskId` on its way (with `which`, the first that asks for one of those). */
    const answer = async (taskId: string, answered: TranscriptPage, which?: "before" | "through") => {
      const index = transcriptAsks.findIndex((a) => a.input.taskId === taskId && (which === undefined || a.input[which] !== undefined));
      expect(index).toBeGreaterThanOrEqual(0);
      const [ask] = transcriptAsks.splice(index, 1);
      ask!.answer(answered);
      await new Promise((r) => setTimeout(r, 0));
      return ask!.input;
    };

    beforeEach(() => {
      transcriptAsks.length = 0;
      api.ruleOffers = async () => [];
      api.yourWords = async () => [];
      useAria.setState({ tasks: [task("p1"), task("p2")], openTaskId: null, inspecting: false, transcripts: {}, offers: {}, yours: {}, actionError: null });
    });

    it("lets go of a task's transcript, offers and words when it closes or another task opens", async () => {
      useAria.getState().openTask("p1");
      expect(await answer("p1", page(run(300, 500), 300))).toEqual({ taskId: "p1" });
      await useAria.getState().loadOffers("p1");
      await useAria.getState().loadYourWords("p1");
      expect(Object.keys(useAria.getState().transcripts)).toEqual(["p1"]);
      expect(useAria.getState().offers.p1).toEqual([]);
      expect(useAria.getState().yours.p1).toEqual([]);
      // Opened again: it's kept (and read again).
      useAria.getState().openTask("p1");
      expect(useAria.getState().transcripts.p1).toBeDefined();
      await answer("p1", page(run(300, 500), 300));
      // Another task: the first one's go.
      useAria.getState().openTask("p2");
      expect(useAria.getState()).toMatchObject({ transcripts: {}, offers: {}, yours: {} });
      await answer("p2", page(run(1, 10), 0));
      await useAria.getState().loadOffers("p2");
      useAria.getState().closeTask();
      expect(useAria.getState()).toMatchObject({ openTaskId: null, transcripts: {}, offers: {} });
      // The same for the inspector and My work taking the session view.
      for (const away of [() => useAria.getState().openInspector(), () => useAria.getState().openMyWork()]) {
        useAria.getState().continueTask("p1");
        await answer("p1", page(run(1, 10), 0));
        expect(useAria.getState().transcripts.p1).toBeDefined();
        away();
        expect(useAria.getState().transcripts).toEqual({});
      }
      useAria.getState().closeTask();
      // An answer that comes after it closed is dropped.
      useAria.getState().openTask("p2");
      useAria.getState().closeTask();
      await answer("p2", page(run(1, 10), 0));
      expect(useAria.getState().transcripts).toEqual({});
      // A task that goes takes what was kept for it.
      useAria.getState().openTask("p1");
      await answer("p1", page(run(1, 10), 0));
      await useAria.getState().loadOffers("p1");
      emit({ type: "task_removed", taskId: "p1" });
      expect(useAria.getState()).toMatchObject({ openTaskId: null, transcripts: {}, offers: {} });
      // Your words that come after it closed aren't kept (they'd be read again after each message to it).
      let words!: (value: Awaited<ReturnType<AriaApi["yourWords"]>>) => void;
      api.yourWords = () => new Promise((resolve) => (words = resolve));
      useAria.getState().openTask("p2");
      const reading = useAria.getState().loadYourWords("p2");
      useAria.getState().closeTask();
      words([{ id: "w1", kind: "message", text: "Keep the logo", at: 1 }]);
      await reading;
      expect(useAria.getState().yours).toEqual({});
    });

    it("reads earlier pages in front of what's loaded, down to the brief", async () => {
      useAria.getState().openTask("p1");
      await answer("p1", page(run(300, 500), 300));
      const loaded = useAria.getState().transcripts.p1!;
      const earlier = useAria.getState().loadEarlierSteps("p1");
      // Asked again while it's on its way: the same read.
      expect(useAria.getState().loadEarlierSteps("p1")).toBe(earlier);
      expect(transcriptAsks).toHaveLength(1);
      expect(transcriptAsks[0]!.input).toEqual({ taskId: "p1", before: "s300" });
      // A step of that page changes meanwhile (it was running, and finished): the live one is the newer one. A new step
      // goes at the end.
      emit({ type: "transcript", taskId: "p1", entries: [step("s150", 150, "finished"), step("s500", 500)] });
      await answer("p1", page(run(100, 300), 100));
      expect(await earlier).toBe(true);
      const joined = useAria.getState().transcripts.p1!;
      expect(joined).toMatchObject({ omitted: 100, first: brief });
      expect(joined.entries.map((e) => e.id)).toEqual(run(100, 501).map((e) => e.id));
      expect(joined.entries[50]).toMatchObject({ text: "finished" });
      // What was loaded is still the same objects.
      expect(joined.entries[200]).toBe(loaded.entries[0]);
      // The rest: the brief joins the steps, as the object shown all along.
      const rest = useAria.getState().loadEarlierSteps("p1");
      expect(transcriptAsks[0]!.input).toEqual({ taskId: "p1", before: "s100" });
      await answer("p1", page([{ ...brief }, ...run(1, 100)], 0));
      expect(await rest).toBe(true);
      const all = useAria.getState().transcripts.p1!;
      expect(all.omitted).toBe(0);
      expect(all.first).toBeUndefined();
      expect(all.entries).toHaveLength(501);
      expect(all.entries[0]).toBe(brief);
      // Nothing more to read.
      expect(await useAria.getState().loadEarlierSteps("p1")).toBe(false);
      expect(transcriptAsks).toHaveLength(0);
    });

    it("keeps the steps that didn't change as the same objects when it's read again, and the earlier pages it joins up with", async () => {
      useAria.getState().openTask("p1");
      await answer("p1", page(run(300, 500), 300));
      const earlier = useAria.getState().loadEarlierSteps("p1");
      await answer("p1", page(run(100, 300), 100));
      await earlier;
      const before = useAria.getState().transcripts.p1!;
      // Opened again (a card clicked): its newest page, one step later, with one that changed.
      useAria.getState().openTask("p1");
      const newest = run(301, 501).map((e) => (e.id === "s499" ? step("s499", 499, "changed") : e));
      await answer("p1", page(newest, 301));
      const after = useAria.getState().transcripts.p1!;
      expect(after.omitted).toBe(100);
      expect(after.entries.map((e) => e.id)).toEqual(run(100, 501).map((e) => e.id));
      // Each step that didn't change is the object it was (so it isn't drawn again); the changed one is new.
      expect(after.entries.slice(0, 400).every((e, i) => e === before.entries[i] || e.id === "s499")).toBe(true);
      expect(after.entries[399]).toMatchObject({ text: "changed" });
      expect(after.first).toBe(before.first);
      // A page that doesn't join up (the steps before it aren't the loaded ones) takes their place.
      expect(reloaded(after, page(run(450, 501), 449)).entries[0]).toBe(after.entries[350]);
      expect(reloaded(after, page(run(450, 501), 449)).omitted).toBe(449);
    });

    it("reads the page with a step to bring into view, also when it's asked for while a read is on its way", async () => {
      useAria.getState().openTask("p1");
      useAria.getState().openTask("p1", "transcript", "s40");
      expect(transcriptAsks).toHaveLength(1);
      await answer("p1", page(run(300, 500), 300));
      expect(useAria.getState().transcripts.p1!.omitted).toBe(300);
      // Then the page with that step (and all after it, as the session view shows them).
      expect(await answer("p1", page([brief, ...run(1, 500)], 0))).toEqual({ taskId: "p1", through: "s40" });
      expect(useAria.getState().transcripts.p1!.entries).toHaveLength(500);
      // A jump that replaces what's loaded while an earlier page is on its way: that page doesn't join up any more.
      useAria.getState().closeTask();
      useAria.getState().openTask("p1");
      await answer("p1", page(run(300, 500), 300));
      const earlier = useAria.getState().loadEarlierSteps("p1");
      useAria.getState().openTask("p1", "transcript", "s250");
      expect(await answer("p1", page(run(200, 500), 200), "through")).toEqual({ taskId: "p1", through: "s250" });
      expect(await answer("p1", page(run(100, 300), 100), "before")).toEqual({ taskId: "p1", before: "s300" });
      expect(await earlier).toBe(false);
      expect(useAria.getState().transcripts.p1!.omitted).toBe(200);
      // A jump to a step that's loaded already: the newest page, which joins what's there.
      useAria.getState().openTask("p1", "transcript", "s250");
      expect(await answer("p1", page(run(300, 500), 300))).toEqual({ taskId: "p1" });
      expect(useAria.getState().transcripts.p1!.omitted).toBe(200);
      expect(useAria.getState().transcriptFocus).toMatchObject({ taskId: "p1", entryId: "s250" });
      // The same for the brief, which comes with every page.
      useAria.getState().openTask("p1", "transcript", "s0");
      expect(await answer("p1", page(run(300, 500), 300))).toEqual({ taskId: "p1" });
    });

    it("says why it couldn't read the steps", async () => {
      useAria.getState().openTask("p1");
      transcriptAsks.pop()!.fail(new Error("Error invoking remote method 'aria:get-transcript': Error: The session is gone."));
      await new Promise((r) => setTimeout(r, 0));
      expect(useAria.getState()).toMatchObject({ actionError: "The session is gone.", transcripts: { p1: { entries: [], omitted: 0, plan: false } } });
      useAria.setState({ actionError: null, transcripts: { p1: { entries: run(300, 500), omitted: 300, first: brief, plan: false } } });
      const earlier = useAria.getState().loadEarlierSteps("p1");
      transcriptAsks.pop()!.fail(new Error("Error invoking remote method 'aria:get-transcript': Error: The session's steps changed since they were read: open it again."));
      expect(await earlier).toBe(false);
      expect(useAria.getState().actionError).toMatch(/open it again/);
      expect(useAria.getState().transcripts.p1!.omitted).toBe(300);
    });

    it("takes live steps into what's loaded, leaving out the ones before it", () => {
      const loaded: LoadedTranscript = { entries: run(300, 302), omitted: 300, first: brief, plan: false };
      const writesPlan: TranscriptEntry = { kind: "tool", id: "s303", at: 303, name: "create", args: JSON.stringify({ path: "plan.md" }), success: true };
      const next = mergeLive(loaded, [step("s5", 5, "finished"), step("s301", 301, "updated"), step("s302", 302), writesPlan, { ...brief, text: "The brief, edited" }]);
      expect(next.entries.map((e) => e.id)).toEqual(["s300", "s301", "s302", "s303"]);
      expect(next.entries[0]).toBe(loaded.entries[0]);
      expect(next.entries[1]).toMatchObject({ text: "updated" });
      expect(next.first).toMatchObject({ text: "The brief, edited" });
      expect(next.plan).toBe(true);
      // Only a step from before what's loaded: nothing changes.
      expect(mergeLive(loaded, [step("s5", 5)])).toBe(loaded);
      // All of it loaded: every step goes in.
      expect(mergeLive({ entries: run(1, 3), omitted: 0, plan: false }, [step("x", 0)]).entries.map((e) => e.id)).toEqual(["s1", "s2", "x"]);
      // An earlier page in front: the ones it has aren't there twice.
      expect(withEarlier(loaded, page(run(100, 301), 100)).entries.map((e) => e.id)).toEqual(run(100, 302).map((e) => e.id));
    });
  });

  it("shows the inspector or a task in the session view, never both, and keeps it up to date live", async () => {
    const entry = (id: string, text: string): TranscriptEntry => ({ kind: "assistant", id, at: 1, text });
    const texts = () => useAria.getState().inspector!.entries.map((e) => (e.kind === "assistant" ? e.text : ""));
    useAria.setState({ openTaskId: "t1", inspecting: false, inspector: null, transcripts: {} });
    releases = 0;
    inspectorAsks.length = 0;
    useAria.getState().openInspector();
    expect(useAria.getState()).toMatchObject({ openTaskId: null, inspecting: true, inspector: { loading: true } });
    // Opening it reads ARIA's session afresh; what arrives meanwhile goes on top of the answer.
    expect(inspectorAsks[0]!.input).toEqual({ turns: 30, reload: true });
    emit({ type: "conductor_transcript", sessionId: "s1", entries: [entry("e2", "live while loading")] });
    inspectorAsks[0]!.answer({ sessionId: "s1", entries: [entry("e1", "history"), entry("e2", "older copy")], omitted: 4, notKept: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(texts()).toEqual(["history", "live while loading"]);
    expect(useAria.getState().inspector).toMatchObject({ sessionId: "s1", omitted: 4, loading: false });
    emit({ type: "conductor_transcript", sessionId: "s1", entries: [entry("e3", "after")] });
    expect(texts()).toEqual(["history", "live while loading", "after"]);
    // Inspect while it's open takes the focus there, and reads nothing again.
    const focus = useAria.getState().inspectorFocus;
    useAria.getState().openInspector();
    expect(inspectorAsks).toHaveLength(1);
    expect(useAria.getState().inspectorFocus).toBe(focus + 1);
    expect(texts()).toEqual(["history", "live while loading", "after"]);

    // Show more asks for what the engine holds, without reading again.
    const more = useAria.getState().showMoreInspector();
    expect(inspectorAsks[1]!.input).toEqual({ turns: 60, reload: false });
    inspectorAsks[1]!.answer({ sessionId: "s1", entries: [entry("e0", "older"), entry("e1", "history"), entry("e2", "live while loading"), entry("e3", "after")], omitted: 0, notKept: 0 });
    await more;
    expect(useAria.getState().inspector).toMatchObject({ turns: 60, omitted: 0, notKept: 0 });

    // ARIA continues in a fresh conversation: the inspector reads that one.
    emit({ type: "conductor_transcript", sessionId: "s2", entries: [] });
    expect(inspectorAsks).toHaveLength(3);
    expect(inspectorAsks[2]!.input).toEqual({ turns: 30, reload: true });
    expect(useAria.getState().inspector!.entries).toEqual([]);

    // A task opened in the session view replaces the inspector; the engine lets go of what it held, and a late answer
    // is ignored.
    useAria.getState().openTask("t2");
    expect(useAria.getState()).toMatchObject({ openTaskId: "t2", inspecting: false, inspector: null });
    expect(releases).toBe(1);
    inspectorAsks[2]!.answer({ sessionId: "s2", entries: [entry("x", "late")], omitted: 0, notKept: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(useAria.getState().inspector).toBeNull();
    emit({ type: "conductor_transcript", sessionId: "s2", entries: [entry("y", "not shown")] });
    expect(useAria.getState().inspector).toBeNull();
  });

  it("reads the new session when ARIA switches to one while the inspector is loading", async () => {
    const entry = (id: string): TranscriptEntry => ({ kind: "assistant", id, at: 1, text: id });
    inspectorAsks.length = 0;
    useAria.setState({ openTaskId: null, inspecting: false, inspector: null });
    useAria.getState().openInspector();
    emit({ type: "conductor_transcript", sessionId: "s2", entries: [] });
    inspectorAsks[0]!.answer({ sessionId: "s1", entries: [entry("old")], omitted: 0, notKept: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(inspectorAsks).toHaveLength(2);
    expect(inspectorAsks[1]!.input).toEqual({ turns: 30, reload: true });
    inspectorAsks[1]!.answer({ sessionId: "s2", entries: [entry("new")], omitted: 0, notKept: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(useAria.getState().inspector).toMatchObject({ sessionId: "s2", entries: [entry("new")] });
    useAria.getState().closeTask();
  });

  it("never asks for more than the engine keeps, and lets live messages push the oldest out", async () => {
    const user = (id: string): TranscriptEntry => ({ kind: "user", id, at: 1, text: id });
    inspectorAsks.length = 0;
    useAria.setState({ openTaskId: null, inspecting: true, inspector: { sessionId: "s1", entries: [user("u1")], omitted: 40, notKept: 0, turns: 990, loading: false } });
    const more = useAria.getState().showMoreInspector();
    expect(inspectorAsks[0]!.input).toEqual({ turns: 1000, reload: false });
    inspectorAsks[0]!.answer({ sessionId: "s1", entries: [user("u1")], omitted: 0, notKept: 30 });
    await more;
    expect(useAria.getState().inspector).toMatchObject({ turns: 1000, omitted: 0, notKept: 30 });
    // It already asks for all there can be.
    useAria.setState({ inspector: { ...useAria.getState().inspector!, omitted: 5 } });
    void useAria.getState().showMoreInspector();
    expect(inspectorAsks).toHaveLength(1);

    // Showing two of your messages, a third arrives: the oldest goes, and can be shown again.
    useAria.setState({ inspector: { sessionId: "s1", entries: [user("u1"), user("u2")], omitted: 0, notKept: 0, turns: 2, loading: false } });
    emit({ type: "conductor_transcript", sessionId: "s1", entries: [user("u3"), { kind: "assistant", id: "a3", at: 2, text: "ok" }] });
    expect(useAria.getState().inspector).toMatchObject({ entries: [user("u2"), user("u3"), { id: "a3" }], omitted: 1, notKept: 0 });
    // At the most it can show, the oldest is gone from what the engine keeps too.
    useAria.setState({ inspector: { sessionId: "s1", entries: [user("u1")], omitted: 0, notKept: 0, turns: 1000, loading: false } });
    emit({ type: "conductor_transcript", sessionId: "s1", entries: Array.from({ length: 1000 }, (_, i) => user(`n${i}`)) });
    expect(useAria.getState().inspector).toMatchObject({ omitted: 0, notKept: 1 });
    expect(useAria.getState().inspector!.entries).toHaveLength(1000);
    // The engine is full (30 shown, 970 more kept, 5 older not kept): three new messages push its three oldest out, and
    // the three pushed out of what's shown here are still kept.
    const shown = Array.from({ length: 30 }, (_, i) => user(`s${i}`));
    useAria.setState({ inspector: { sessionId: "s1", entries: shown, omitted: 970, notKept: 5, turns: 30, loading: false } });
    emit({ type: "conductor_transcript", sessionId: "s1", entries: [user("m1"), user("m2"), user("m3")] });
    expect(useAria.getState().inspector).toMatchObject({ omitted: 970, notKept: 8 });
    expect(useAria.getState().inspector!.entries.map((e) => e.id).slice(-4)).toEqual(["s29", "m1", "m2", "m3"]);
    expect(useAria.getState().inspector!.entries).toHaveLength(30);
    // Showing more than it holds, nothing pushed out of view: the engine's oldest still go.
    useAria.setState({ inspector: { sessionId: "s1", entries: shown, omitted: 970, notKept: 0, turns: 60, loading: false } });
    emit({ type: "conductor_transcript", sessionId: "s1", entries: [user("n1")] });
    expect(useAria.getState().inspector).toMatchObject({ omitted: 969, notKept: 1 });
    useAria.getState().closeTask();
  });

  it("opens a card's task when the card is older than the loaded timeline, else scrolls to it", () => {
    const task = (id: string): Task =>
      ({ id, title: id, brief: id, repoId: 1, repoName: "R", repoPath: "C:\\r", profileName: "Default", model: "m", mode: "autopilot", state: "done", costCredits: 0, startedBy: "you", createdAt: 1, updatedAt: 1 }) as Task;
    useAria.setState({ timeline: [chat("recent-card", "assistant")], tasks: [task("t1")], openTaskId: null, inspecting: false, inspector: null, focus: null, transcripts: {} });
    useAria.getState().focusCard("recent-card", "t1");
    expect(useAria.getState()).toMatchObject({ focus: { cardId: "recent-card", taskId: "t1" }, openTaskId: null });
    // Not loaded (beyond the last 1000 items): the task's session view instead of a scroll that finds nothing.
    useAria.setState({ focus: null });
    useAria.getState().focusCard("task-t1", "t1");
    expect(useAria.getState()).toMatchObject({ focus: null, openTaskId: "t1" });
    // The same for a toast clicked in the shell.
    useAria.setState({ openTaskId: null });
    emit({ type: "focus", cardId: "budget-old", taskId: "t1" });
    expect(useAria.getState().openTaskId).toBe("t1");
    useAria.getState().closeTask();

    // Clearing focus prevents re-scrolling when Chat remounts, and timeline_removed drops the card and marks its watch seen.
    const ciCard = {
      kind: "card" as const,
      id: "ci-red-1",
      cardType: "ci" as const,
      payload: {
        watchId: 42,
        owner: "me",
        repo: "r",
        repoName: "R",
        source: "branch" as const,
        title: "main",
        outcome: "failure" as const,
        conclusion: "failure",
        summary: "1 workflow failing",
        url: "https://github.com/me/r/actions",
      },
      createdAt: 2,
    };
    useAria.setState({ timeline: [ciCard], seenWatchCards: [], focus: null });
    useAria.getState().focusCard("ci-red-1");
    expect(useAria.getState().focus?.cardId).toBe("ci-red-1");
    expect(useAria.getState().seenWatchCards).toContain("ci-red-1");
    useAria.getState().clearFocus();
    expect(useAria.getState().focus).toBeNull();

    useAria.getState().focusCard("ci-red-1");
    emit({ type: "timeline_removed", id: "ci-red-1" });
    expect(useAria.getState().timeline).toEqual([]);
    expect(useAria.getState().focus).toBeNull();
    expect(useAria.getState().seenWatchCards).toEqual(expect.arrayContaining(["ci-red-1", "w:42"]));
  });

  it("follows Focus mode and the away threshold from the engine, and asks it to change them", async () => {
    const asked: unknown[] = [];
    api.setAttention = async (input) => {
      asked.push(input);
      return { focusMode: true, awayMinutes: 15 };
    };
    useAria.setState({ attention: { focusMode: false, awayMinutes: 15 } });
    expect(await useAria.getState().setAttention({ focusMode: true })).toBe(true);
    expect(asked).toEqual([{ focusMode: true }]);
    // What shows comes from the engine's event (the header, the tray and Customize all follow it).
    expect(useAria.getState().attention.focusMode).toBe(false);
    emit({ type: "attention", settings: { focusMode: true, awayMinutes: null } });
    expect(useAria.getState().attention).toEqual({ focusMode: true, awayMinutes: null });
  });

  it("keeps a task's offers and your words, reads your words again after you send it something, and follows the notes", async () => {
    let words: Array<{ id: string; kind: "message"; text: string; at: number }> = [];
    api.ruleOffers = async (taskId) => [{ id: `o-${taskId}`, at: 1, command: "npm install left-pad", scope: "sandboxed", decided: "ask", rules: [{ match: "npm install left-pad", exact: true }] }];
    api.yourWords = async () => words;
    api.messageTask = async (input) => {
      words = [...words, { id: `w${words.length}`, kind: "message", text: input.text, at: 1 }];
    };
    api.acceptOffer = async () => {
      throw new Error("Error invoking remote method 'aria:accept-offer': Error: `npm install <package>`: Without “Only exactly this”, it would let tasks run any…");
    };
    await useAria.getState().loadOffers("t1");
    expect(useAria.getState().offers.t1?.map((o) => o.id)).toEqual(["o-t1"]);
    // The form shows its own error; the store's general one stays clear.
    expect(await useAria.getState().acceptOffer("t1", "o-t1", [{ match: "npm install <package>", exact: false }], false)).toMatch(/^`npm install <package>`: Without/);
    expect(useAria.getState().actionError).toBeNull();
    // Your words are read for a task the session view opened, and again once you send it something.
    expect(await useAria.getState().messageTask("t1", "before it opened", false)).toBe(true);
    expect(useAria.getState().yours.t1).toBeUndefined();
    useAria.setState({ openTaskId: "t1" });
    await useAria.getState().loadYourWords("t1");
    await useAria.getState().messageTask("t1", "Keep the logo", false);
    await new Promise((r) => setTimeout(r, 0));
    expect(useAria.getState().yours.t1?.map((w) => w.text)).toEqual(["before it opened", "Keep the logo"]);
    emit({ type: "memories", memory: { memories: [{ id: "m", scope: "global", text: "Keep the logo", createdAt: 1, updatedAt: 1 }], templateUsesMemory: false, leftOut: [] } });
    expect(useAria.getState().memory).toMatchObject({ templateUsesMemory: false, memories: [{ id: "m" }] });
  });

  it("follows Customize › Integrations from the engine, and gives the page its own errors", async () => {
    api.refreshIntegrations = async () => {
      throw new Error("Error invoking remote method 'aria:refresh-integrations': Error: Checked a moment ago: try again in 12 s.");
    };
    api.signIn = async () => ({ host: "login.example.invalid" });
    expect(await useAria.getState().refreshIntegrations()).toBe("Checked a moment ago: try again in 12 s.");
    expect(useAria.getState().actionError).toBeNull();
    expect(await useAria.getState().signIn("Work IQ Mail")).toBeNull();
    emit({ type: "integrations", integrations: { servers: [], tools: [], runtimeUp: true, refreshing: false, signIn: { server: "Work IQ Mail", state: "waiting", host: "login.example.invalid", at: 1 } } });
    expect(useAria.getState().integrations.signIn).toMatchObject({ state: "waiting", host: "login.example.invalid" });
  });

  it("selects the same list while no agents are known, so the window doesn't re-render forever", () => {
    const integrations = { servers: [], tools: [], runtimeUp: false, refreshing: false };
    expect(selectAgents({ integrations })).toBe(selectAgents({ integrations: { ...integrations } }));
  });

  it("shows why the inspector couldn't load, and closing it lets the engine go", async () => {
    inspectorAsks.length = 0;
    releases = 0;
    useAria.setState({ openTaskId: null, inspecting: false, inspector: null });
    useAria.getState().openInspector();
    inspectorAsks[0]!.fail(new Error("Error invoking remote method 'aria:get-conductor-transcript': Error: ARIA's conversation isn't open yet."));
    await new Promise((r) => setTimeout(r, 0));
    expect(useAria.getState().inspector).toMatchObject({ loading: false, error: "ARIA's conversation isn't open yet." });
    useAria.getState().closeTask();
    expect(useAria.getState()).toMatchObject({ inspecting: false, inspector: null });
    expect(releases).toBe(1);
  });

  it("ignores stale loadTimeView responses when a newer date request is in flight", async () => {
    const pending: Array<{ date?: string; resolve: (v: any) => void }> = [];
    api.getTimeView = (input) =>
      new Promise((resolve) => {
        pending.push({ ...(input.date ? { date: input.date } : {}), resolve });
      });

    const first = useAria.getState().loadTimeView("2026-10-02");
    const second = useAria.getState().loadTimeView("2026-10-21");
    expect(pending).toHaveLength(2);

    pending[1]!.resolve({ selectedDate: "2026-10-21", weekStart: "2026-10-19", weekEnd: "2026-10-25", days: [], day: { date: "2026-10-21" }, activities: [] });
    await second;
    expect(useAria.getState().timeView?.selectedDate).toBe("2026-10-21");
    expect(useAria.getState().ui.selectedTimeDate).toBe("2026-10-21");

    pending[0]!.resolve({ selectedDate: "2026-10-02", weekStart: "2026-09-28", weekEnd: "2026-10-04", days: [], day: { date: "2026-10-02" }, activities: [] });
    await first;
    expect(useAria.getState().timeView?.selectedDate).toBe("2026-10-21");
    expect(useAria.getState().ui.selectedTimeDate).toBe("2026-10-21");
  });

  it("removes a project and clears any open search or new-session filter for it", async () => {
    const p1 = { id: 1, name: "Moonrise", path: "C:\\Moonrise", addedVia: "scan" as const, pinned: false, hidden: false };
    const p2 = { id: 2, name: "Scratch", path: "C:\\Scratch", kind: "folder" as const, addedVia: "local" as const, pinned: false, hidden: false };
    api.removeProject = async ({ repoId }) => [p1, { ...p2, hidden: repoId === 2 }];
    useAria.setState({ projects: [p1, p2], searchRepoId: 2, newSession: { projectId: 2 } });

    const err = await useAria.getState().removeProject(2);
    expect(err).toBeNull();
    expect(useAria.getState().projects.filter((p) => !p.hidden).map((p) => p.name)).toEqual(["Moonrise"]);
    expect(useAria.getState().searchRepoId).toBeNull();
    expect(useAria.getState().newSession).toBeNull();
  });

  it("opens the update popup automatically on startup when an update is available or installed, and records dismissal", async () => {
    const onboardingPatches: unknown[] = [];
    api.setOnboardingState = async (patch) => {
      onboardingPatches.push(patch);
      return {
        ...useAria.getState().onboarding,
        ...patch,
        updatedAt: 2000,
      };
    };

    useAria.setState({ whatsNewModalOpen: false, availableUpdate: null });
    const loading = useAria.getState().load();
    answers.shift()!(
      snapshot({
        appVersion: "0.2.0",
        onboarding: {
          lastSeenVersion: "0.2.0",
          dismissedWhatsNewVersion: "0.1.0",
          setupCompleted: true,
          tourCompleted: true,
          updatedAt: 1000,
        },
        availableUpdate: {
          version: "0.3.0",
          tagName: "v0.3.0",
          releaseUrl: "https://github.com/RobbieDemaegdt/aria/releases/tag/v0.3.0",
        },
      }),
    );
    await loading;

    expect(useAria.getState().whatsNewModalOpen).toBe(true);
    useAria.getState().closeWhatsNewModal();
    await new Promise((r) => setTimeout(r, 0));
    expect(useAria.getState().whatsNewModalOpen).toBe(false);
    expect(onboardingPatches).toEqual([
      {
        dismissedWhatsNewVersion: "0.2.0",
        dismissedAvailableUpdateVersion: "0.3.0",
      },
    ]);
  });

  it("handles new session with extra context and files, and preserves them on rerun", async () => {
    let startedInput: unknown = null;
    api.startTask = async (input) => {
      startedInput = input;
      return {
        id: "t-new",
        title: "With context",
        brief: input.brief,
        repoId: input.repoId,
        repoName: "R",
        repoPath: "C:\\r",
        profileName: "Fast",
        model: "m",
        mode: "autopilot",
        state: "queued",
        costCredits: 0,
        startedBy: "you",
        createdAt: 1,
        updatedAt: 1,
        extraContext: input.extraContext,
        files: input.files,
      } as Task;
    };
    api.pickFiles = async () => ["C:\\docs\\spec.pdf", "C:\\data\\config.json"];

    // 1. pickFiles invokes api.pickFiles
    const picked = await useAria.getState().pickFiles();
    expect(picked).toEqual(["C:\\docs\\spec.pdf", "C:\\data\\config.json"]);

    // 2. openNewSession sets extraContext and files in newSession
    useAria.getState().openNewSession(1, "my-agent", "Extra details", ["C:\\doc.txt"]);
    expect(useAria.getState().newSession).toEqual({
      projectId: 1,
      agent: "my-agent",
      extraContext: "Extra details",
      files: ["C:\\doc.txt"],
    });

    // 3. startTask passes extraContext and files
    await useAria.getState().startTask({
      repoId: 1,
      brief: "Do something",
      extraContext: "Extra details",
      files: ["C:\\doc.txt"],
    });
    expect(startedInput).toMatchObject({
      repoId: 1,
      brief: "Do something",
      extraContext: "Extra details",
      files: ["C:\\doc.txt"],
    });

    // 4. openRerunTask copies extraContext and files from source task
    const sourceTask: Task = {
      id: "source-1",
      slug: "source-1",
      title: "Source",
      brief: "Initial work",
      repoId: 2,
      repoName: "Repo",
      repoPath: "C:\\repo",
      profileName: "Fast",
      model: "m",
      mode: "autopilot",
      state: "done",
      costCredits: 0,
      startedBy: "you",
      createdAt: 1,
      updatedAt: 1,
      extraContext: "Preserved context",
      files: ["C:\\preserved.ts"],
    };
    useAria.setState({ tasks: [sourceTask] });
    useAria.getState().openRerunTask("source-1");
    expect(useAria.getState().newSession).toEqual({
      projectId: 2,
      rerunTaskId: "source-1",
      extraContext: "Preserved context",
      files: ["C:\\preserved.ts"],
    });
  });
});
