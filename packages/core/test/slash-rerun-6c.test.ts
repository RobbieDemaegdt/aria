/**
 * Phase 6C unit tests: deterministic slash commands (`/status`, `/tasks`, `/watch`, `/focus`, `/pause-all`, `/budget`),
 * "Rerun with…" (`rerunOf` root canonicalization and `baseCommit` inheritance), and `startAtLogin` / `quickPromptHotkey`
 * settings (PLAN.md §4.1, §5.3, §5.5, §10 Phase 6C).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatItem } from "@aria/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { AriaEngine, type EngineOptions } from "../src/index.ts";
import { FakeRuntime } from "../src/runtime/fake.ts";
import { commitFile, makeRepo, waitMs } from "./helpers.ts";

const temps: string[] = [];
const engines: AriaEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.stop()));
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function setup(options: Partial<EngineOptions> = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), "aria-6c-"));
  temps.push(base);
  const projects = path.join(base, "GitHub");
  const moonrisePath = makeRepo(projects, "Moonrise");
  commitFile(moonrisePath, "README.md", "# Moonrise\n", "Initial commit");
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
  return { base, moonrisePath, runtime, make };
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
const conductorOf = (runtime: FakeRuntime) => [...runtime.sessions.values()].at(-1)!;

describe("Deterministic slash commands (Phase 6C, PLAN.md §5.5, §10 Phase 6C)", () => {
  it("runs /status, /tasks, /focus, /watch, /budget, and /pause-all in plain code with zero model calls", async () => {
    const { make, runtime } = setup();
    const engine = make();
    await engine.start();

    const promptsBefore = conductorOf(runtime).prompts.length;

    // 1. /status
    await engine.sendMessage("/status");
    expect(conductorOf(runtime).prompts).toHaveLength(promptsBefore);
    expect(chats(engine, "assistant").at(-1)).toMatchObject({
      model: "slash",
      content: expect.stringContaining("**ARIA status:** ready"),
    });

    // 2. /focus on, /focus off, and /focus toggle
    expect(engine.getState().attention.focusMode).toBe(false);
    await engine.sendMessage("/focus on");
    expect(engine.getState().attention.focusMode).toBe(true);
    expect(chats(engine, "assistant").at(-1)!.content).toContain("Focus mode is **on**");

    await engine.sendMessage("/focus");
    expect(engine.getState().attention.focusMode).toBe(false);
    expect(chats(engine, "assistant").at(-1)!.content).toContain("Focus mode is **off**");

    // 3. /watch list (deterministic) and /watch <target> (delegated to Conductor)
    await engine.sendMessage("/watch");
    expect(chats(engine, "assistant").at(-1)!.content).toContain("**Active watches:** none.");
    expect(conductorOf(runtime).prompts).toHaveLength(promptsBefore);

    // 4. Start two tasks: one pauses at budget (B-1), one stays running
    const moonrise = project(engine, "Moonrise");
    const defaultProfile = engine.getState().profiles.find((p) => p.isDefault)!;
    const cappedProfile = await engine.saveProfile({
      name: "Capped",
      model: defaultProfile.model,
      ...(defaultProfile.reasoningEffort ? { reasoningEffort: defaultProfile.reasoningEffort } : {}),
      mode: "autopilot",
      budgetCredits: 5,
    });

    let releaseTask2!: () => void;
    const gate2 = new Promise<void>((r) => (releaseTask2 = r));

    // Each task gets its script by its brief, once: the two start side by side, and on a busy PC the second can send
    // first, so a queue would hand it the budget script and neither would reach the state waited for below.
    const firstScripts = new Map([
      ["Spend budget", { steps: [{ usage: 6 }, { wait: 10_000 }, { complete: "unreachable" }] }],
      ["Keep running", { steps: [{ intent: "Long work" }, { gate: gate2 }, { complete: "Done 2" }] }],
    ]);
    runtime.workerScriptFor = (prompt) => {
      for (const [brief, script] of firstScripts) {
        if (prompt.includes(brief)) {
          firstScripts.delete(brief);
          return script;
        }
      }
      return undefined;
    };

    const t1 = await engine.startTask({
      repoId: moonrise.id,
      title: "Budget task",
      brief: "Spend budget",
      profileId: cappedProfile.id,
    });
    const t2 = await engine.startTask({
      repoId: moonrise.id,
      title: "Running task",
      brief: "Keep running",
    });

    await until(() => stateOf(engine, t1.id) === "waiting_budget" && stateOf(engine, t2.id) === "running");

    // 5. /tasks and /tasks waiting
    await engine.sendMessage("/tasks");
    expect(chats(engine, "assistant").at(-1)!.content).toContain("Budget task");
    expect(chats(engine, "assistant").at(-1)!.content).toContain("Running task");

    await engine.sendMessage("/tasks waiting");
    expect(chats(engine, "assistant").at(-1)!.content).toContain("Budget task");
    expect(chats(engine, "assistant").at(-1)!.content).not.toContain("Running task");

    // 6. /budget summary and /budget +5 to resume the paused task
    await engine.sendMessage("/budget");
    expect(chats(engine, "assistant").at(-1)!.content).toContain("Paused at budget (1)");
    expect(chats(engine, "assistant").at(-1)!.content).toContain("B-1");

    runtime.workerScripts.push({ steps: [{ complete: "Finished after /budget +5" }] });
    await engine.sendMessage("/budget +5");
    expect(chats(engine, "assistant").at(-1)!.content).toContain("Added **+5 cr** to **Budget task**");
    await until(() => stateOf(engine, t1.id) === "done");

    // 7. /pause-all stops all active/queued tasks
    await engine.sendMessage("/pause-all");
    expect(chats(engine, "assistant").at(-1)!.content).toContain("Stopped 1 task: **Running task**");
    expect(stateOf(engine, t2.id)).toBe("cancelled");
    releaseTask2();

    // Still zero model calls to the Conductor!
    expect(conductorOf(runtime).prompts).toHaveLength(promptsBefore);

    // Unknown slash command throws a helpful error
    await expect(engine.sendMessage("/nonexistent")).rejects.toThrow(/Unknown slash command/);
  });

  it("disambiguates /budget +N when multiple tasks are paused at their budget (D68)", async () => {
    const { make, runtime } = setup();
    const engine = make();
    await engine.start();

    const moonrise = project(engine, "Moonrise");
    const defaultProfile = engine.getState().profiles.find((p) => p.isDefault)!;
    const capped = await engine.saveProfile({
      name: "Cap2",
      model: defaultProfile.model,
      ...(defaultProfile.reasoningEffort ? { reasoningEffort: defaultProfile.reasoningEffort } : {}),
      mode: "autopilot",
      budgetCredits: 2,
    });

    runtime.workerScripts.push(
      { steps: [{ usage: 3 }, { wait: 10_000 }] },
      { steps: [{ usage: 3 }, { wait: 10_000 }] },
    );

    const a = await engine.startTask({ repoId: moonrise.id, title: "Alpha", brief: "A", profileId: capped.id });
    const b = await engine.startTask({ repoId: moonrise.id, title: "Beta", brief: "B", profileId: capped.id });
    await until(() => stateOf(engine, a.id) === "waiting_budget" && stateOf(engine, b.id) === "waiting_budget");

    // Ambiguous `/budget +5` without naming which paused task
    await expect(engine.sendMessage("/budget +5")).rejects.toThrow(/Multiple tasks are paused at their budget/);

    // Naming B-2 (or @beta) works in either argument order (`/budget B-2 +5` or `/budget +5 @alpha`)
    runtime.workerScripts.push(
      { steps: [{ complete: "Beta done" }] },
      { steps: [{ complete: "Alpha done" }] },
    );
    const bShort = engine.getState().tasks.find((t) => t.id === b.id)!.budgetShortId!;
    await engine.sendMessage(`/budget ${bShort} +5`);
    await until(() => stateOf(engine, b.id) === "done");

    await engine.sendMessage("/budget +5 @alpha");
    await until(() => stateOf(engine, a.id) === "done");
  });
});

describe("Rerun with… and desktop attention settings (Phase 6C, D67)", () => {
  it("reruns a finished task in a fresh worktree off the original baseCommit, canonicalizing rerunOf across multi-generation reruns", async () => {
    const { make, moonrisePath, runtime } = setup();
    const engine = make();
    await engine.start();

    const moonrise = project(engine, "Moonrise");
    const deepProfile = engine.getState().profiles.find((p) => p.name === "Deep") ?? engine.getState().profiles[0]!;

    runtime.workerScripts.push({
      steps: [
        {
          tool: "create",
          args: { path: "run1.txt" },
          run: (cwd) => writeFileSync(path.join(cwd, "run1.txt"), "run 1\n"),
        },
        { complete: "Finished run 1." },
      ],
    });

    const run1 = await engine.startTask({
      repoId: moonrise.id,
      title: "Refactor parser",
      brief: "Refactor the parser module",
    });
    await until(() => stateOf(engine, run1.id) === "done");

    // Advance the main branch in the main repo after run1 started, to verify run2 branches from run1's baseCommit!
    commitFile(moonrisePath, "later-on-main.txt", "new commit on main\n", "Advance main");

    runtime.workerScripts.push({
      steps: [
        {
          tool: "create",
          args: { path: "run2.txt" },
          run: (cwd) => writeFileSync(path.join(cwd, "run2.txt"), "run 2\n"),
        },
        { complete: "Finished run 2." },
      ],
    });

    const run2 = await engine.startTask({
      repoId: moonrise.id,
      title: "Refactor parser",
      brief: "Refactor the parser module with strict types",
      profileId: deepProfile.id,
      rerunOf: run1.id,
    });
    await until(() => stateOf(engine, run2.id) === "done");

    expect(run2.rerunOf).toBe(run1.id);
    const finished1 = engine.getState().tasks.find((t) => t.id === run1.id)!;
    const finished2 = engine.getState().tasks.find((t) => t.id === run2.id)!;
    expect(finished2.worktreePath).toBeDefined();
    expect(finished2.worktreePath).not.toBe(finished1.worktreePath);
    // Because run2 inherited run1's baseCommit, `later-on-main.txt` is not in run2's worktree
    expect(await engine.getTaskFile(run2.id, "later-on-main.txt")).toBeNull();

    // Multi-generation rerun (Run 3 rerun from Run 2) canonicalizes `rerunOf` to `run1.id` (D67)
    runtime.workerScripts.push({ steps: [{ complete: "Finished run 3." }] });
    const run3 = await engine.startTask({
      repoId: moonrise.id,
      title: "Refactor parser",
      brief: "Refactor the parser module v3",
      rerunOf: run2.id,
    });
    await until(() => stateOf(engine, run3.id) === "done");
    expect(run3.rerunOf).toBe(run1.id);

    // Rerunning a non-terminal (running) task is rejected
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((r) => (releaseActive = r));
    runtime.workerScripts.push({
      steps: [{ intent: "Working" }, { gate: activeGate }, { complete: "Done." }],
    });
    const activeRun = await engine.startTask({
      repoId: moonrise.id,
      title: "Active task",
      brief: "Active task brief",
    });
    await until(() => stateOf(engine, activeRun.id) === "running");
    await expect(
      engine.startTask({
        repoId: moonrise.id,
        title: "Active task",
        brief: "Attempt rerun while running",
        rerunOf: activeRun.id,
      }),
    ).rejects.toThrow(/Only finished, failed, cancelled or interrupted tasks can be rerun/i);
    releaseActive();
    await until(() => stateOf(engine, activeRun.id) === "done");

    // Persists startAtLogin, startMinimized, and quickPromptHotkey in AttentionSettings
    expect(engine.getState().attention.startMinimized).toBe(true);
    const updatedAtt = engine.setAttention({ startAtLogin: true, startMinimized: false, quickPromptHotkey: false });
    expect(updatedAtt).toMatchObject({ startAtLogin: true, startMinimized: false, quickPromptHotkey: false });
  });
});
