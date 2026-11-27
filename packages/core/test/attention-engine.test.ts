/**
 * The attention engine inside ARIA (PLAN.md §4.5, §5.5, D25): toasts from real task events, the away card with the
 * cards it links to, startup, settings that last, and shutdown. Scripted runtime, manual clock for the attention engine.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CardItem, EngineEvent } from "@aria/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ManualClock } from "../src/attention/clock.ts";
import { AriaEngine, type EngineOptions } from "../src/engine.ts";
import { FakeRuntime } from "../src/runtime/fake.ts";
import { commitFile, makeRepo, waitMs } from "./helpers.ts";

const temps: string[] = [];
const engines: AriaEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.stop()));
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const MIN = 60_000;

function setup(options: Partial<EngineOptions> = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), "aria-attention-engine-"));
  temps.push(base);
  const projects = path.join(base, "GitHub");
  const repo = makeRepo(projects, "Moonrise");
  commitFile(repo, "README.md", "# Moonrise\n", "Initial commit");
  const runtime = new FakeRuntime();
  const clock = new ManualClock();
  const make = () => {
    const engine = new AriaEngine({
      dataDir: path.join(base, "data"),
      runtime,
      projectRoots: [projects],
      resumeSettleMs: 10,
      worktreeRoot: path.join(base, "wt"),
      taskSettleMs: 20,
      autopilotGraceMs: 150,
      attentionClock: clock,
      ...options,
    });
    engines.push(engine);
    return engine;
  };
  return { runtime, clock, make };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > waitMs(ms)) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const toasts = (events: EngineEvent[]) => events.filter((e): e is Extract<EngineEvent, { type: "toast" }> => e.type === "toast");
const cardsOf = <T extends CardItem["cardType"]>(engine: AriaEngine, type: T) =>
  engine.getState().timeline.filter((i): i is Extract<CardItem, { cardType: T }> => i.kind === "card" && i.cardType === type);
const stateOf = (engine: AriaEngine, id: string) => engine.getState().tasks.find((t) => t.id === id)?.state;

describe("attention in ARIA (PLAN.md §4.5, §5.5)", () => {
  it("toasts a task's question and its end while you're away, and sums them up when you're back", async () => {
    const { runtime, clock, make } = setup();
    runtime.workerScripts.push({ steps: [{ question: "Header or footer?", choices: ["Header", "Footer"], allowFreeform: false }, { complete: "Done." }] }, { steps: [{ complete: "Docs written." }] });
    const engine = make();
    await engine.start();
    const events: EngineEvent[] = [];
    engine.onEvent((e) => events.push(e));
    engine.setPresence(true);
    const repoId = engine.getState().projects[0]!.id;
    // Started while you're there: nothing toasts (D25), whatever the priority.
    const asking = await engine.startTask({ repoId, brief: "Theme toggle" });
    await until(() => stateOf(engine, asking.id) === "waiting_input");
    expect(toasts(events)).toEqual([]);

    engine.setPresence(false);
    const docs = await engine.startTask({ repoId, brief: "Write docs" });
    await until(() => stateOf(engine, docs.id) === "done");
    const done = cardsOf(engine, "task_done").find((c) => c.payload.taskId === docs.id)!;
    expect(toasts(events)).toEqual([expect.objectContaining({ priority: "milestone", title: "Write docs is done", taskId: docs.id, cardId: done.id })]);
    clock.advance(20 * MIN);
    engine.setPresence(true);
    const [away] = cardsOf(engine, "away_digest");
    const question = engine.getState().tasks.find((t) => t.id === asking.id)!.question!;
    expect(away!.payload.lines).toEqual([
      // It was waiting before you left: listed, not new.
      { kind: "needs_you", taskId: asking.id, title: "Theme toggle", repoName: "Moonrise", text: "asks: Header or footer?", cardId: `question-${question.id}`, shortId: question.shortId, waits: "question", itemId: question.id },
      { kind: "done", taskId: docs.id, title: "Write docs", repoName: "Moonrise", text: "No commits", cardId: done.id },
    ]);
    // The card isn't news for ARIA: nothing about it goes into its next <updates>.
    await engine.sendMessage("hello");
    await until(() => engine.getState().status.state === "ready");
    expect([...runtime.sessions.values()][0]!.prompts.at(-1)).not.toMatch(/away/i);
  });

  it("links a budget pause and interrupted tasks to their own cards", async () => {
    const { runtime, clock, make } = setup();
    runtime.workerScripts.push({ steps: [{ usage: 2 }, { wait: 5_000 }, { complete: "too far" }] });
    const engine = make();
    await engine.start();
    engine.setPresence(false);
    const project = engine.getState().projects[0]!;
    const preset = engine.getState().profiles.find((p) => p.isDefault)!;
    await engine.saveProfile({ id: preset.id, name: preset.name, model: preset.model, reasoningEffort: preset.reasoningEffort!, mode: "autopilot", budgetCredits: 1 });
    const pricey = await engine.startTask({ repoId: project.id, brief: "A long job" });
    await until(() => stateOf(engine, pricey.id) === "waiting_budget");
    clock.advance(16 * MIN);
    engine.setPresence(true);
    const budgetCard = cardsOf(engine, "task_budget")[0]!;
    expect(cardsOf(engine, "away_digest")[0]!.payload.lines).toEqual([expect.objectContaining({ kind: "needs_you", taskId: pricey.id, shortId: "B-1", cardId: budgetCard.id, isNew: true })]);
  });

  it("toasts the interrupted card at startup only when you're not there, also when told before it starts", async () => {
    const { runtime, make } = setup();
    runtime.workerScripts.push({ steps: [{ wait: 60_000 }] }, { steps: [{ wait: 60_000 }] });
    const first = make();
    await first.start();
    const repoId = first.getState().projects[0]!.id;
    const task = await first.startTask({ repoId, brief: "Slow job" });
    await until(() => stateOf(first, task.id) === "running");
    await first.stop();

    // Away before ARIA has even started: the interrupted card toasts.
    const away = make();
    const awayEvents: EngineEvent[] = [];
    away.onEvent((e) => awayEvents.push(e));
    away.setPresence(false);
    await away.start();
    const interrupted = cardsOf(away, "tasks_interrupted")[0]!;
    expect(toasts(awayEvents)).toEqual([expect.objectContaining({ priority: "blocking", title: "A task was interrupted", cardId: interrupted.id })]);
    await away.stop();

    // There at the first report after start: it doesn't (and an interrupted task links to that run's card, else its own).
    const there = make();
    const thereEvents: EngineEvent[] = [];
    there.onEvent((e) => thereEvents.push(e));
    await there.start();
    there.setPresence(true);
    expect(toasts(thereEvents)).toEqual([]);
  });

  it("links a task interrupted at an earlier start to its own card, and marks only this start's as new", async () => {
    const { runtime, clock, make } = setup();
    runtime.workerScripts.push({ steps: [{ wait: 60_000 }] }, { steps: [{ wait: 60_000 }] });
    const first = make();
    await first.start();
    const repoId = first.getState().projects[0]!.id;
    const t1 = await first.startTask({ repoId, brief: "First slow job" });
    await until(() => stateOf(first, t1.id) === "running");
    await first.stop();
    // Interrupts T1; T1 stays interrupted (not resumed) while T2 runs.
    const second = make();
    await second.start();
    const t2 = await second.startTask({ repoId, brief: "Second slow job" });
    await until(() => stateOf(second, t2.id) === "running");
    await second.stop();
    // Interrupts T2: this start's card lists only T2.
    const third = make();
    third.setPresence(false);
    await third.start();
    const card = cardsOf(third, "tasks_interrupted").at(-1)!;
    expect(card.payload.taskIds).toEqual([t2.id]);
    clock.advance(16 * MIN);
    third.setPresence(true);
    const lines = cardsOf(third, "away_digest")[0]!.payload.lines;
    expect(lines).toEqual([
      expect.objectContaining({ taskId: t1.id, waits: "interrupted", cardId: `task-${t1.id}` }),
      expect.objectContaining({ taskId: t2.id, waits: "interrupted", cardId: card.id, isNew: true }),
    ]);
    expect(lines[0]).not.toHaveProperty("isNew");
  });

  it("says what a permission request wants to do with the right verb, on the card and in ARIA's digest", async () => {
    const { runtime, clock, make } = setup();
    runtime.sandboxSupported = false;
    runtime.workerScripts.push({ steps: [{ tool: "web_fetch", ask: { kind: "url", url: "https://example.com/docs" } }, { complete: "Read it." }] });
    const engine = make();
    await engine.start();
    engine.setPresence(false);
    const task = await engine.startTask({ repoId: engine.getState().projects[0]!.id, brief: "Read the docs" });
    await until(() => stateOf(engine, task.id) === "waiting_permission");
    clock.advance(16 * MIN);
    engine.setPresence(true);
    expect(cardsOf(engine, "away_digest")[0]!.payload.lines).toEqual([expect.objectContaining({ waits: "permission", text: "wants to open https://example.com/docs" })]);
    await engine.sendMessage("what's waiting?");
    await until(() => engine.getState().status.state === "ready");
    expect([...runtime.sessions.values()][0]!.prompts.at(-1)).toContain("wants to open `https://example.com/docs`");
  });

  it("keeps Focus mode and the away threshold across a restart, and tells the window when they change", async () => {
    const { make } = setup();
    const first = make();
    await first.start();
    expect(first.getState().attention).toMatchObject({ focusMode: false, awayMinutes: 15 });
    const events: EngineEvent[] = [];
    first.onEvent((e) => events.push(e));
    expect(first.setAttention({ focusMode: true })).toMatchObject({ focusMode: true, awayMinutes: 15 });
    first.setAttention({ awayMinutes: null });
    expect(events.filter((e) => e.type === "attention")).toEqual([
      { type: "attention", settings: expect.objectContaining({ focusMode: true, awayMinutes: 15 }) },
      { type: "attention", settings: expect.objectContaining({ focusMode: true, awayMinutes: null }) },
    ]);
    await first.stop();
    const second = make();
    await second.start();
    expect(second.getState().attention).toMatchObject({ focusMode: true, awayMinutes: null });
  });

  it("shows nothing more once ARIA stops: a held combined toast doesn't fire", async () => {
    const { runtime, clock, make } = setup();
    runtime.workerScripts.push({ steps: [{ complete: "One." }] }, { steps: [{ complete: "Two." }] });
    const engine = make();
    await engine.start();
    const events: EngineEvent[] = [];
    engine.onEvent((e) => events.push(e));
    engine.setPresence(false);
    const repoId = engine.getState().projects[0]!.id;
    const a = await engine.startTask({ repoId, brief: "First" });
    const b = await engine.startTask({ repoId, brief: "Second" });
    await until(() => stateOf(engine, a.id) === "done" && stateOf(engine, b.id) === "done");
    expect(toasts(events)).toHaveLength(1);
    await engine.stop();
    clock.advance(30_000);
    engine.setPresence(true);
    expect(toasts(events)).toHaveLength(1);
  });
});
