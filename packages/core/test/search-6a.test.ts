/**
 * Phase 6A unit tests: `session_transcripts` SQLite indexing and `engine.search()` across session transcripts, tasks,
 * projects, and memories (PLAN.md §5.2, §10 Phase 6A, D64).
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatItem } from "@aria/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { AriaEngine, type EngineOptions } from "../src/index.ts";
import { FakeRuntime } from "../src/runtime/fake.ts";
import { commitFile, makeRepo, waitMs } from "./helpers.ts";
import { acmeTracker } from "./helpers/acme.ts";

const temps: string[] = [];
const engines: AriaEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.stop()));
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function setup(options: Partial<EngineOptions> = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), "aria-search6a-"));
  temps.push(base);
  const projects = path.join(base, "GitHub");
  for (const name of ["Moonrise", "GerbilBreederTracker"]) {
    commitFile(makeRepo(projects, name), "README.md", `# ${name}\n`, "Initial commit");
  }
  const runtime = new FakeRuntime();
  const make = () => {
    const engine = new AriaEngine({
      dataDir: path.join(base, "data"),
      runtime,
      projectRoots: [projects],
      resumeSettleMs: 10,
      worktreeRoot: path.join(base, "wt"),
      taskSettleMs: 20,
      autopilotGraceMs: 150,
      ...options,
    });
    engines.push(engine);
    return engine;
  };
  return { base, runtime, make };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > waitMs(ms)) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const project = (engine: AriaEngine, name: string) => engine.getState().projects.find((p) => p.name === name)!;
const stateOf = (engine: AriaEngine, id: string) => engine.getState().tasks.find((t) => t.id === id)?.state;
const chats = (engine: AriaEngine, role: "user" | "assistant") =>
  engine.getState().timeline.filter((i): i is ChatItem => i.kind === "chat" && i.role === role);

async function chat(engine: AriaEngine, text: string): Promise<string> {
  const before = chats(engine, "assistant").length;
  await engine.sendMessage(text);
  await until(() => chats(engine, "assistant").length > before && engine.getState().status.state === "ready");
  return chats(engine, "assistant").at(-1)!.content;
}

describe("Search across session transcripts, tasks, projects, and memories (Phase 6A)", () => {
  it("finds matches across projects, tasks, worker session transcripts, Conductor transcripts, and memories", async () => {
    const { make, runtime } = setup({ tracker: acmeTracker });
    runtime.workerScripts.push({
      steps: [
        { intent: "Adding ThemeProvider" },
        {
          tool: "edit",
          args: { path: "src/theme/ThemeProvider.tsx", new_str: "prefersDarkScheme" },
        },
        { message: "Implemented dark mode toggle using prefersDarkScheme." },
        { complete: "Added ThemeProvider and header toggle." },
      ],
    });
    const engine = make();
    await engine.start();

    const pft = project(engine, "GerbilBreederTracker");
    const moonrise = project(engine, "Moonrise");

    engine.saveMemory({ text: "Moonrise uses pnpm workspaces", scope: "project", repoId: moonrise.id });
    engine.saveMemory({ text: "Always open draft PRs", scope: "global" });

    const task = await engine.startTask({
      repoId: pft.id,
      title: "Dark mode toggle",
      brief: "Add a dark mode toggle to the header for task ACME-123",
      trackerTaskId: "ACME-123",
    });
    await until(() => stateOf(engine, task.id) === "done");

    runtime.replies.push({
      toolCalls: [{ name: "list_repos", args: { query: "Moonrise" } }],
      text: "Moonrise is in your GitHub folder.",
    });
    await chat(engine, "Where is Moonrise located?");

    // 1. Project search by name and by memory
    const projRes = await engine.search({ query: "GerbilBreeder" });
    expect(projRes.projects).toHaveLength(1);
    expect(projRes.projects[0]).toMatchObject({
      id: pft.id,
      name: "GerbilBreederTracker",
      matchedField: "name",
      taskCount: 1,
      latestTaskId: task.id,
    });

    const memProjRes = await engine.search({ query: "pnpm workspaces" });
    expect(memProjRes.projects[0]).toMatchObject({
      id: moonrise.id,
      name: "Moonrise",
      matchedField: "memory",
    });
    expect(memProjRes.memories[0]).toMatchObject({
      scope: "project",
      repoName: "Moonrise",
      text: "Moonrise uses pnpm workspaces",
    });

    // Global memory hit
    const globalMemRes = await engine.search({ query: "draft PRs" });
    expect(globalMemRes.memories).toHaveLength(1);
    expect(globalMemRes.memories[0]).toMatchObject({
      scope: "global",
      text: "Always open draft PRs",
    });

    // 2. Task search by title, tracker ID, and summary
    const taskByTitle = await engine.search({ query: "Dark mode toggle", scope: "tasks" });
    expect(taskByTitle.tasks).toHaveLength(1);
    expect(taskByTitle.tasks[0]).toMatchObject({
      taskId: task.id,
      title: "Dark mode toggle",
      repoName: "GerbilBreederTracker",
      matchedField: "title",
      cardId: expect.any(String),
    });

    const taskByTracker = await engine.search({ query: "ACME-123", scope: "tasks" });
    expect(taskByTracker.tasks[0]).toMatchObject({
      taskId: task.id,
      matchedField: "tracker",
    });

    // 3. Worker session transcript search (matches tool args and assistant message)
    const transcriptRes = await engine.search({ query: "prefersDarkScheme", scope: "transcripts" });
    expect(transcriptRes.transcripts.length).toBeGreaterThanOrEqual(2);
    expect(transcriptRes.transcripts.map((h) => h.entryKind)).toEqual(
      expect.arrayContaining(["tool", "assistant"]),
    );
    const toolHit = transcriptRes.transcripts.find((h) => h.entryKind === "tool")!;
    expect(toolHit).toMatchObject({
      taskId: task.id,
      sessionTitle: "Dark mode toggle",
      repoName: "GerbilBreederTracker",
      toolName: "edit",
      cardId: expect.any(String),
    });
    expect(toolHit.snippet).toContain("prefersDarkScheme");

    // Review round 1: exact total count even when limit < matching entries
    const limitedRes = await engine.search({ query: "prefersDarkScheme", scope: "transcripts", limit: 1 });
    expect(limitedRes.transcripts).toHaveLength(1);
    expect(limitedRes.counts.transcripts).toBeGreaterThanOrEqual(2);

    // 4. Conductor session transcript search (matches Conductor tool call and message)
    const conductorHit = await engine.search({ query: "list_repos", scope: "transcripts" });
    expect(conductorHit.transcripts.some((h) => h.sessionTitle === "ARIA" && h.toolName === "list_repos")).toBe(true);

    // 5. Project filter (`repoId`) isolates hits to that project
    const filtered = await engine.search({ query: "prefersDarkScheme", repoId: moonrise.id });
    expect(filtered.counts.total).toBe(0);
    const filteredPft = await engine.search({ query: "prefersDarkScheme", repoId: pft.id });
    expect(filteredPft.transcripts.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps a task's transcript searchable and readable after cleanup_task removes its worktree, and deletes it on discardTask", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({
      steps: [
        {
          tool: "create",
          args: { path: "src/uniqueToken42.ts" },
        },
        { complete: "Created uniqueToken42." },
      ],
    });
    const engine = make();
    await engine.start();
    const moonrise = project(engine, "Moonrise");
    const task = await engine.startTask({
      repoId: moonrise.id,
      title: "Token task",
      brief: "Create uniqueToken42",
    });
    await until(() => stateOf(engine, task.id) === "done");

    // Clean up the worktree via Conductor tool `cleanup_task`
    runtime.replies.push({
      toolCalls: [{ name: "cleanup_task", args: { task: task.id } }],
      text: "Cleaned up worktree.",
    });
    await chat(engine, "Clean up the token task worktree");
    expect(engine.getState().tasks.find((t) => t.id === task.id)?.cleanedUp).toBe(true);

    // Even with the worktree gone, `getTranscript` and `search` still return the stored SQLite transcript!
    const storedTranscript = await engine.getTranscript(task.id);
    expect(storedTranscript.some((e) => e.kind === "tool" && e.args?.includes("uniqueToken42"))).toBe(true);

    const searchAfterCleanup = await engine.search({ query: "uniqueToken42", scope: "transcripts" });
    expect(searchAfterCleanup.transcripts.some((h) => h.taskId === task.id)).toBe(true);

    // Discarding the task removes its transcript from SQLite too
    await engine.discardTask(task.id);
    const searchAfterDiscard = await engine.search({ query: "uniqueToken42" });
    expect(searchAfterDiscard.counts.total).toBe(0);
  });

  it("lazily backfills unindexed pre-6A task transcripts on search and before cleanup after a restart", async () => {
    const { base, make, runtime } = setup();
    runtime.workerScripts.push({
      steps: [
        { message: "LegacySessionFact99" },
        { complete: "Done." },
      ],
    });
    const engine = make();
    await engine.start();
    const moonrise = project(engine, "Moonrise");
    const task = await engine.startTask({
      repoId: moonrise.id,
      title: "Legacy task",
      brief: "Run legacy check",
    });
    await until(() => stateOf(engine, task.id) === "done");
    await engine.stop();

    // Simulate a pre-6A database where `session_transcripts` was empty for this task
    const { Store } = await import("../src/store/store.ts");
    const rawStore = new Store(path.join(base, "data", "aria.db"));
    rawStore.deleteTranscriptEntries(`task:${task.id}`);
    // Even if one new live entry arrived before full backfill, `isTranscriptBackfilled` is still false
    rawStore.upsertTranscriptEntries(`task:${task.id}`, [{ kind: "info", id: "partial-1", at: Date.now(), level: "info", text: "partial" }]);
    expect(rawStore.isTranscriptBackfilled(`task:${task.id}`)).toBe(false);
    rawStore.close();

    // Restart engine (so `live.handle` is not open in memory) and run `cleanup_task`
    const restarted = make();
    await restarted.start();
    runtime.replies.push({
      toolCalls: [{ name: "cleanup_task", args: { task: task.id } }],
      text: "Cleaned up.",
    });
    await chat(restarted, "Clean up legacy task");

    // Cleanup opened the session before deleting the worktree and saved the full transcript to SQLite!
    const hit = await restarted.search({ query: "LegacySessionFact99", scope: "transcripts" });
    expect(hit.transcripts.some((h) => h.taskId === task.id)).toBe(true);
  });

  it("does not double-count routed task messages or truncated transcript matches against timeline chat items", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({
      steps: [
        { question: "Which port should we bind?" },
        { complete: "Bound port." },
      ],
    });
    const engine = make();
    await engine.start();
    const moonrise = project(engine, "Moonrise");
    const task = await engine.startTask({
      repoId: moonrise.id,
      title: "Port task",
      brief: "Bind port",
    });
    await until(() => stateOf(engine, task.id) === "waiting_input");
    const qId = engine.getState().tasks.find((t) => t.id === task.id)!.question!.id;
    await engine.reply({ taskId: task.id, item: { kind: "question", id: qId }, text: "Use port 9876UniquePort" });
    await until(() => stateOf(engine, task.id) === "done");

    const res = await engine.search({ query: "9876UniquePort", scope: "transcripts" });
    expect(res.transcripts).toHaveLength(1);
    expect(res.counts.transcripts).toBe(1);
  });

  it("escapes SQL LIKE wildcards (% and _) in search queries", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({
      steps: [
        { message: "Completed 100% of the work_item_alpha check." },
        { complete: "Done." },
      ],
    });
    const engine = make();
    await engine.start();
    const moonrise = project(engine, "Moonrise");
    const task = await engine.startTask({
      repoId: moonrise.id,
      title: "Wildcard task",
      brief: "Run check",
    });
    await until(() => stateOf(engine, task.id) === "done");

    expect((await engine.search({ query: "100%", scope: "transcripts" })).transcripts).toHaveLength(1);
    expect((await engine.search({ query: "99%", scope: "transcripts" })).transcripts).toHaveLength(0);
    expect((await engine.search({ query: "work_item_alpha", scope: "transcripts" })).transcripts).toHaveLength(1);
    expect((await engine.search({ query: "workXitemXalpha", scope: "transcripts" })).transcripts).toHaveLength(0);
  });
});
