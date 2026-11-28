/**
 * Phase 3 Part B, item 3 (PLAN.md §5.3, D23, D26–D29) through the engine: "Always allow this" from a decided card and
 * from a refused step, destructive commands on their cards, "Save as memory" on your own words only, the memories
 * table, and briefs with {{memory}}. Against the scripted runtime, with real git repositories.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CardItem, ChatItem, Memory, Task } from "@aria/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { AriaEngine, type EngineOptions } from "../src/engine.ts";
import { briefNotes, memoryBlock, memoryProblem } from "../src/memory/memories.ts";
import { canonicalPath } from "../src/policy/command.ts";
import { DEFAULT_RULES } from "../src/policy/defaults.ts";
import { FakeRuntime, type FakeWorkerStep } from "../src/runtime/fake.ts";
import type { PermissionAsk } from "../src/runtime/types.ts";
import { BASELINE, BASELINE_VERSION } from "../src/store/migrations.ts";
import { Store } from "../src/store/store.ts";
import { commitFile, makeRepo, waitMs } from "./helpers.ts";

const temps: string[] = [];
const engines: AriaEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.stop()));
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function setup(options: Partial<EngineOptions> = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), "aria-flow-"));
  temps.push(base);
  const projects = path.join(base, "GitHub");
  for (const name of ["Moonrise", "Other"]) commitFile(makeRepo(projects, name), "README.md", `# ${name}\n`, "Initial commit");
  const runtime = new FakeRuntime();
  const make = () => {
    const engine = new AriaEngine({ dataDir: path.join(base, "data"), runtime, projectRoots: [projects], resumeSettleMs: 10, worktreeRoot: path.join(base, "wt"), taskSettleMs: 20, autopilotGraceMs: 150, ...options });
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

const task = (engine: AriaEngine, id: string) => engine.getState().tasks.find((t) => t.id === id);
const stateOf = (engine: AriaEngine, id: string) => task(engine, id)?.state;
const project = (engine: AriaEngine, name: string) => engine.getState().projects.find((p) => p.name === name)!;
const cards = <T extends CardItem["cardType"]>(engine: AriaEngine, type: T) =>
  engine.getState().timeline.filter((i): i is Extract<CardItem, { cardType: T }> => i.kind === "card" && i.cardType === type);
const chats = (engine: AriaEngine, role: "user" | "assistant") => engine.getState().timeline.filter((i): i is ChatItem => i.kind === "chat" && i.role === role);
const shellAsk =
  (command: string) =>
  (cwd: string): PermissionAsk => ({ kind: "shell", command, segments: [command], cwd, possiblePaths: [], possibleUrls: [] });
const shellStep = (command: string): FakeWorkerStep => ({ tool: "powershell", args: { command }, ask: shellAsk(command) });
const worker = (runtime: FakeRuntime, t: Task) => runtime.workers.get(`aria-task-${t.id}`)!;
const conductorOf = (runtime: FakeRuntime) => [...runtime.sessions.values()][0]!;

async function chat(engine: AriaEngine, text: string): Promise<string> {
  const before = chats(engine, "assistant").length;
  await engine.sendMessage(text);
  await until(() => chats(engine, "assistant").length > before && engine.getState().status.state === "ready");
  return chats(engine, "assistant").at(-1)!.content;
}

describe("Always allow this (§5.3, D26–D28)", () => {
  it("offers an exact rule on a decided card; saved, the next request of every sandboxed task runs on its own", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [shellStep("npm install left-pad"), shellStep("npm install left-pad"), { complete: "Added it." }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: project(engine, "Moonrise").id, title: "Pad", brief: "Pad the versions" });
    await until(() => stateOf(engine, started.id) === "waiting_permission");
    const card = cards(engine, "task_permission")[0]!;
    expect(card.payload.offerId).toEqual(expect.any(String));
    const [offer] = engine.ruleOffers(started.id);
    expect(offer).toMatchObject({ id: card.payload.offerId, command: "npm install left-pad", scope: "sandboxed", decided: "ask", rules: [{ match: "npm install left-pad", exact: true }], toolCallId: expect.any(String) });
    // Offers aren't part of the task the window gets.
    expect(task(engine, started.id)).not.toHaveProperty("offers");
    engine.decidePermission(started.id, task(engine, started.id)!.permissions![0]!.id, "once");
    await until(() => task(engine, started.id)?.permissions?.[0]?.shortId === "P-2");

    // Edited into something broad, it's refused (D26), and an offer that isn't kept can't be saved.
    expect(() => engine.acceptOffer({ taskId: started.id, offerId: offer!.id, rules: [{ match: "npm install <package>", exact: false }] })).toThrow(/Only exactly this/);
    // "Only exactly this" still ticked, but with a word in angle brackets: as broad (round 1).
    expect(() => engine.acceptOffer({ taskId: started.id, offerId: offer!.id, rules: [{ match: "npm <x>", exact: true }] })).toThrow(/angle brackets/);
    expect(() => engine.acceptOffer({ taskId: started.id, offerId: "gone", rules: [{ match: "npm install left-pad", exact: true }] })).toThrow(/isn't kept/);
    const policy = engine.acceptOffer({ taskId: started.id, offerId: offer!.id, rules: [{ match: "npm install left-pad", exact: true }] });
    expect(policy.rules.at(-1)).toMatchObject({ match: "npm install left-pad", effect: "auto", exact: true, scope: "sandboxed", note: expect.stringMatching(/^Allowed with “Always allow”, \d+ \w+$/) });
    expect(policy.rules.slice(0, -1)).toEqual(DEFAULT_RULES);
    // The rule names no task or anything a worker wrote.
    expect(policy.rules.at(-1)!.note).not.toContain("Pad");
    engine.decidePermission(started.id, task(engine, started.id)!.permissions![0]!.id, "once");
    await until(() => stateOf(engine, started.id) === "done");

    runtime.workerScripts.push({ steps: [shellStep("npm install left-pad"), { complete: "Added it again." }] });
    const next = await engine.startTask({ repoId: project(engine, "Other").id, title: "Pad more", brief: "Pad more" });
    await until(() => stateOf(engine, next.id) === "done");
    expect(worker(runtime, next).decisions).toMatchObject([{ approved: true }]);
    expect(cards(engine, "task_permission")).toHaveLength(2);
    // ARIA hears about it.
    await chat(engine, "hi");
    expect(conductorOf(runtime).prompts.at(-1)).toContain('You let `npm install left-pad` run on its own in every sandboxed task ("Always allow this").');
  });

  it("offers one on a step your Never rule refused, by its tool call; running past that rule needs your confirmation", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [shellStep("curl https://example.com"), { complete: "Did without it." }] });
    const engine = make();
    await engine.start();
    engine.savePolicyRules([...DEFAULT_RULES, { match: "curl", effect: "never", note: "No downloads." }]);
    const started = await engine.startTask({ repoId: project(engine, "Moonrise").id, brief: "Fetch it" });
    await until(() => stateOf(engine, started.id) === "done");
    const [offer] = engine.ruleOffers(started.id);
    const transcript = await engine.getTranscript(started.id);
    const step = transcript.find((e) => e.kind === "tool" && e.success === false)!;
    expect(offer).toMatchObject({ decided: "never", toolCallId: step.id, overrides: [{ match: "curl", sameRule: false }] });
    expect(() => engine.acceptOffer({ taskId: started.id, offerId: offer!.id, rules: offer!.rules })).toThrow(/confirm/);
    const policy = engine.acceptOffer({ taskId: started.id, offerId: offer!.id, rules: offer!.rules, confirmOverride: true });
    expect(policy.rules.map((r) => [r.match, r.effect])).toContainEqual(["curl", "never"]);
    expect(policy.rules.at(-1)).toMatchObject({ match: "curl https://example.com", effect: "auto", exact: true });
  });

  it("checks rules typed in Customize › Permissions the same way, keeping an old rule that didn't change (D26)", async () => {
    const { make } = setup();
    const engine = make();
    await engine.start();
    expect(() => engine.savePolicyRules([{ match: "git", effect: "auto" }])).toThrow(/Only exactly this/);
    expect(() => engine.savePolicyRules([{ match: "git reset --hard", effect: "auto", exact: true }])).toThrow(/destructive/);
    expect(() => engine.savePolicyRules([{ match: "pwsh -Command <x>", effect: "auto", exact: true }])).toThrow(/angle brackets/);
    expect(() => engine.savePolicyRules([{ match: "git checkout .", effect: "auto", exact: true }])).toThrow(/destructive/);
    const saved = engine.savePolicyRules([{ match: "git status", effect: "auto", exact: true, scope: "sandboxed" }, { match: "git", effect: "ask" }]);
    expect(saved.rules[0]).toMatchObject({ match: "git status", effect: "auto", exact: true, scope: "sandboxed" });
    // Exactness and scope are part of what a rule is: these are three rules, and an exact one's letter case counts.
    const three = engine.savePolicyRules([
      { match: "git status", effect: "auto", exact: true },
      { match: "git status", effect: "ask" },
      { match: "git status", effect: "never", scope: "sandboxed" },
      { match: "GIT STATUS", effect: "auto", exact: true },
    ]);
    expect(three.rules).toHaveLength(4);
    expect(() => engine.savePolicyRules([{ match: "git status", effect: "ask" }, { match: "GIT STATUS", effect: "never" }])).toThrow(/two rules/);
    expect(engine.checkRule({ match: "git status", effect: "auto" }).problems).toHaveLength(1);
  });

  it("keeps a stored Auto rule from before the checks when it didn't change, and checks it once it does", async () => {
    const { make, base } = setup();
    const engine = make();
    await engine.start();
    await engine.stop();
    // A rule list saved before item 3, with a broad Auto rule.
    const db = new Store(path.join(base, "data", "aria.db"));
    db.setSetting("policy.rules", [{ id: "old", match: "node build.js", effect: "auto" }]);
    db.close();
    const again = make();
    await again.start();
    const kept = again.savePolicyRules([{ id: "old", match: "node build.js", effect: "auto", note: "A note added" }, { match: "npm test", effect: "auto" }]);
    expect(kept.rules.map((r) => r.match)).toEqual(["node build.js", "npm test"]);
    expect(() => again.savePolicyRules([{ id: "old", match: "node build.js --watch", effect: "auto" }])).toThrow(/Only exactly this/);
  });
});

describe("sandbox boundary recovery", () => {
  it("offers a one-time, task and persistent scope without weakening ordinary policy", async () => {
    const { base, make, runtime } = setup();
    const reference = path.join(base, "reference.txt");
    writeFileSync(reference, "reference\n");
    const step: FakeWorkerStep = {
      tool: "view",
      args: { path: reference },
      ask: { kind: "read", path: reference, sandboxBlock: true },
    };
    runtime.workerScripts.push({ steps: [step, step, { complete: "Read it twice." }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: project(engine, "Moonrise").id, brief: "Read the reference" });
    await until(() => stateOf(engine, started.id) === "waiting_permission");
    const pending = task(engine, started.id)!.permissions![0]!;
    const worktree = started.worktreePath!;
    expect(pending).toMatchObject({ sandbox: { access: "read", target: canonicalPath(realpathSync.native(reference), worktree), persistent: "path" } });
    expect(cards(engine, "task_permission")[0]!.payload.sandbox).toEqual(pending.sandbox);
    expect(() => engine.decidePermission(started.id, pending.id, "task")).not.toThrow();
    await until(() => stateOf(engine, started.id) === "done");
    expect(worker(runtime, started).decisions).toEqual([{ approved: true }, { approved: true }]);

    runtime.workerScripts.push({ steps: [step, { complete: "Read it again." }] });
    const again = await engine.startTask({ repoId: project(engine, "Other").id, brief: "Read it again" });
    await until(() => stateOf(engine, again.id) === "waiting_permission");
    const againPending = task(engine, again.id)!.permissions![0]!;
    engine.decidePermission(again.id, againPending.id, "always");
    await until(() => stateOf(engine, again.id) === "done");
    expect(engine.policySettings().sandbox.allowedPaths).toContain(realpathSync.native(reference));
    expect(cards(engine, "task_permission").some((card) => card.payload.decision === "always")).toBe(true);
  });
});

describe("destructive commands on their cards (D28, D29)", () => {
  it("offers Approve once and Reject only, every time, and no Always allow", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [shellStep("git reset --hard"), shellStep("git reset --hard"), { complete: "Reset twice." }] });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: project(engine, "Moonrise").id, brief: "Reset" });
    await until(() => stateOf(engine, started.id) === "waiting_permission");
    const pending = task(engine, started.id)!.permissions![0]!;
    expect(pending).toMatchObject({ shortId: "P-1", everyTime: true });
    expect(cards(engine, "task_permission")[0]!.payload).toMatchObject({ everyTime: true });
    expect(cards(engine, "task_permission")[0]!.payload.offerId).toBeUndefined();
    expect(engine.ruleOffers(started.id)).toEqual([]);
    expect(() => engine.decidePermission(started.id, pending.id, "task")).toThrow(/destructive, so it asks every time/);
    // Not through ARIA either.
    runtime.replies.push({ toolCalls: [{ name: "decide_permission", args: { id: "P-1", decision: "approve_for_task" } }], text: (_p: string, results: unknown[]) => JSON.stringify(results) });
    expect(await chat(engine, "approve P-1 for the task")).toMatch(/asks every time/);
    expect(task(engine, started.id)!.grants).toBeUndefined();
    engine.decidePermission(started.id, pending.id, "once");
    // The same command asks again.
    await until(() => task(engine, started.id)?.permissions?.[0]?.shortId === "P-2");
    engine.decidePermission(started.id, task(engine, started.id)!.permissions![0]!.id, "once");
    await until(() => stateOf(engine, started.id) === "done");
  });
});

describe("your own words (§5.3, concern 8)", () => {
  it("records your messages and answers in your words from the window, never a picked choice or ARIA's answer", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({
      steps: [
        { question: "Which name?", choices: ["Atlas", "Borealis"] },
        { question: "Which color?", choices: ["Red", "Blue"] },
        { question: "Which font?", choices: ["Inter", "Roboto"] },
        { question: "Which size?" },
        { gate: new Promise<void>(() => {}) },
      ],
    });
    const engine = make();
    await engine.start();
    const started = await engine.startTask({ repoId: project(engine, "Moonrise").id, title: "Brand", brief: "Brand it" });
    const asked = (n: number) => until(() => task(engine, started.id)?.question?.shortId === `Q-${n}`);
    await asked(1);
    // A reply in your own words.
    await engine.reply({ taskId: started.id, item: { kind: "question", id: task(engine, started.id)!.question!.id }, text: "Call it Comet, it's shorter" });
    await asked(2);
    // A reply that picks a choice (in another letter case).
    await engine.reply({ taskId: started.id, item: { kind: "question", id: task(engine, started.id)!.question!.id }, text: "blue" });
    await asked(3);
    // On the card, with the window saying it was its own words: still a choice.
    engine.answerQuestion(started.id, task(engine, started.id)!.question!.id, "INTER", true);
    await asked(4);
    runtime.replies.push({ toolCalls: [{ name: "answer_question", args: { task: "Q-4", answer: "Medium, as usual" } }], text: "Answered." });
    await chat(engine, "answer Q-4 for me");
    await until(() => stateOf(engine, started.id) === "running");
    await engine.messageTask(started.id, "Also keep the logo", false);

    const answers = cards(engine, "task_question").map((c) => [c.payload.answer, c.payload.answeredBy, c.payload.freeform ?? false]);
    expect(answers).toEqual([
      ["Call it Comet, it's shorter", "you", true],
      ["Blue", "you", false],
      ["INTER", "you", false],
      ["Medium, as usual", "aria", true],
    ]);
    expect(engine.yourWords(started.id).map((w) => [w.kind, w.text])).toEqual([
      ["answer", "Call it Comet, it's shorter"],
      ["message", "Also keep the logo"],
    ]);
    expect(task(engine, started.id)).not.toHaveProperty("yours");
    const routed = chats(engine, "user").filter((c) => c.routedTo);
    expect(routed.map((c) => c.routedTo!.choice ?? false)).toEqual([false, true]);

    // Save as memory takes only those.
    const moonrise = project(engine, "Moonrise").id;
    const fromCard = cards(engine, "task_question");
    expect(() => engine.saveMemory({ text: "Blue", scope: "global", from: { chatItemId: routed[1]!.id } })).toThrow(/Only your own words/);
    expect(() => engine.saveMemory({ text: "Medium", scope: "global", from: { cardId: fromCard[3]!.id } })).toThrow(/Only your own words/);
    expect(() => engine.saveMemory({ text: "Inter", scope: "global", from: { cardId: fromCard[2]!.id } })).toThrow(/Only your own words/);
    expect(() => engine.saveMemory({ text: "x", scope: "global", from: { taskId: started.id, wordsId: "nope" } })).toThrow(/Only your own words/);
    const a = engine.saveMemory({ text: "The service is called Comet", scope: "project", repoId: moonrise, from: { chatItemId: routed[0]!.id } });
    expect(a).toMatchObject({ scope: "project", repoId: moonrise, repoName: "Moonrise", source: { kind: "answer", taskId: started.id, taskTitle: "Brand" } });
    const b = engine.saveMemory({ text: "Keep the logo", scope: "global", from: { taskId: started.id, wordsId: engine.yourWords(started.id)[1]!.id } });
    expect(b.source).toMatchObject({ kind: "message", taskTitle: "Brand" });
    const c = engine.saveMemory({ text: "Prefer short names", scope: "global", from: { cardId: fromCard[0]!.id } });
    expect(c.source).toMatchObject({ kind: "answer", taskId: started.id });
    await engine.cancelTask(started.id);
  });

  it("gives ARIA remember and forget (Phase 6A, completing D23), while workers still get no memory tools", async () => {
    const { make, runtime } = setup();
    runtime.workerScripts.push({ steps: [{ complete: "ok" }] });
    const engine = make();
    await engine.start();
    await chat(engine, "hi");
    const names = conductorOf(runtime).config.tools.map((t) => t.name);
    expect(names.length).toBeGreaterThan(5);
    expect(names.filter((name) => /memor|remember|forget|note/i.test(name))).toEqual(["remember", "forget"]);
    const started = await engine.startTask({ repoId: project(engine, "Moonrise").id, brief: "Nothing" });
    await until(() => stateOf(engine, started.id) === "done");
    // Workers get the runtime's own tools only, no handlers of ARIA's.
    expect(runtime.lastWorkerConfig).not.toHaveProperty("tools");
  });
});

describe("memory notes (D23)", () => {
  it("refuses what a brief shouldn't get: line breaks, control and invisible characters, placeholders, too long", () => {
    const ch = (code: number) => String.fromCodePoint(code);
    expect(memoryProblem("Moonrise uses pnpm")).toBeUndefined();
    expect(memoryProblem("  ")).toMatch(/Write the note/);
    expect(memoryProblem("one\ntwo")).toMatch(/one line/);
    expect(memoryProblem(`one${ch(0x2028)}two`)).toMatch(/one line/);
    expect(memoryProblem(`one${ch(0x2029)}two`)).toMatch(/one line/);
    expect(memoryProblem(`one${ch(0x85)}two`)).toMatch(/one line/);
    expect(memoryProblem("x".repeat(301))).toMatch(/300 characters/);
    expect(memoryProblem("x".repeat(300))).toBeUndefined();
    for (const code of [0x09, 0x1b, 0x202e, 0x200b, 0xe0041, 0x2066]) expect(memoryProblem(`a${ch(code)}b`), code.toString(16)).toMatch(/control or invisible/);
    expect(memoryProblem("use {{brief}} here")).toMatch(/\{\{/);
    expect(memoryProblem("a }} b")).toMatch(/\{\{/);
  });

  it("gives a brief this project's notes newest first, then the global ones, at most 30 lines and 3,000 characters", () => {
    const note = (id: string, scope: Memory["scope"], at: number, text = id, repoId?: number): Memory => ({ id, scope, ...(repoId ? { repoId } : {}), text, createdAt: at, updatedAt: at });
    const memories = [note("g-old", "global", 1), note("p-old", "project", 2, "p-old", 1), note("g-new", "global", 3), note("p-new", "project", 4, "p-new", 1), note("other", "project", 5, "other", 2)];
    expect(briefNotes(memories, 1).shown.map((m) => m.id)).toEqual(["p-new", "p-old", "g-new", "g-old"]);
    expect(briefNotes(memories, null).shown.map((m) => m.id)).toEqual(["g-new", "g-old"]);
    expect(memoryBlock(briefNotes(memories, 2).shown)).toBe("Notes from the user (saved in ARIA, in their own words)\n---\n- other\n- g-new\n- g-old\n---");
    expect(memoryBlock([])).toBe("");
    const many = Array.from({ length: 35 }, (_, i) => note(`n${i}`, "project", i, `n${i}`, 1));
    const lines = briefNotes(many, 1);
    expect(lines.shown).toHaveLength(30);
    expect(lines.leftOut.map((m) => m.id)).toEqual(["n4", "n3", "n2", "n1", "n0"]);
    const long = Array.from({ length: 12 }, (_, i) => note(`l${i}`, "global", i, `${i}`.padEnd(300, "x")));
    const chars = briefNotes(long, null);
    expect(chars.shown.map((m) => m.id)).toEqual(["l11", "l10", "l9", "l8", "l7", "l6", "l5", "l4", "l3"]);
    expect(chars.shown.reduce((sum, m) => sum + m.text.length + 3, 0)).toBeLessThanOrEqual(3000);
  });

  it("puts the notes into the next task's brief after the goal; edited and deleted in Customize › Memory; not without {{memory}}", async () => {
    const { make, runtime } = setup();
    const engine = make();
    await engine.start();
    const events: string[] = [];
    engine.onEvent((e) => {
      if (e.type === "memories") events.push(e.memory.memories.map((m) => m.text).join("|"));
    });
    const moonrise = project(engine, "Moonrise").id;
    const other = project(engine, "Other").id;
    expect(() => engine.saveMemory({ text: "x", scope: "project" })).toThrow(/Pick the project/);
    expect(() => engine.saveMemory({ text: "x", scope: "project", repoId: 999 })).toThrow(/Pick the project/);
    expect(() => engine.saveMemory({ text: "two\nlines", scope: "global" })).toThrow(/one line/);
    const own = engine.saveMemory({ text: "Moonrise uses pnpm", scope: "project", repoId: moonrise });
    expect(own.source).toMatchObject({ kind: "typed" });
    engine.saveMemory({ text: "Write commit messages in English", scope: "global" });
    engine.saveMemory({ text: "Other uses yarn", scope: "project", repoId: other });
    expect(events).toHaveLength(3);
    expect(engine.getState().memory).toMatchObject({ templateUsesMemory: true, leftOut: [] });

    runtime.workerScripts.push({ steps: [{ complete: "ok" }] });
    const first = await engine.startTask({ repoId: moonrise, brief: "Fix the login" });
    await until(() => stateOf(engine, first.id) === "done");
    const brief = worker(runtime, first).prompts[0]!;
    expect(brief).toContain("Goal\nFix the login\n\nNotes from the user (saved in ARIA, in their own words)\n---\n- Moonrise uses pnpm\n- Write commit messages in English\n---\n");
    expect(brief).not.toContain("Other uses yarn");

    // Edited and deleted.
    engine.saveMemory({ id: own.id, text: "Moonrise uses pnpm 9", scope: "project", repoId: moonrise });
    expect(engine.getState().memory.memories.find((m) => m.id === own.id)).toMatchObject({ text: "Moonrise uses pnpm 9", source: { kind: "typed" } });
    engine.deleteMemory(own.id);
    expect(() => engine.deleteMemory(own.id)).toThrow(/doesn't exist/);
    expect(engine.getState().memory.memories.map((m) => m.text)).toEqual(["Other uses yarn", "Write commit messages in English"]);

    // A brief template without {{memory}}: the notes stay out, and Customize › Memory says so.
    engine.savePrompt("brief", "Do this: {{brief}}\n\n{{environment}}");
    expect(engine.getState().memory.templateUsesMemory).toBe(false);
    runtime.workerScripts.push({ steps: [{ complete: "ok" }] });
    const second = await engine.startTask({ repoId: moonrise, brief: "Fix the logout" });
    await until(() => stateOf(engine, second.id) === "done");
    expect(worker(runtime, second).prompts[0]).not.toContain("Notes from the user");
  });

  it("keeps at most 100 notes and says which don't fit in a project's briefs", async () => {
    const { make } = setup();
    const engine = make();
    await engine.start();
    const moonrise = project(engine, "Moonrise").id;
    for (let i = 0; i < 100; i++) engine.saveMemory({ text: `note ${i}`, scope: i < 40 ? "project" : "global", ...(i < 40 ? { repoId: moonrise } : {}) });
    expect(() => engine.saveMemory({ text: "one more", scope: "global" })).toThrow(/100 notes/);
    const { leftOut } = engine.getState().memory;
    expect(leftOut.find((l) => l.repoId === moonrise)!.ids).toHaveLength(70);
    expect(leftOut.find((l) => l.repoId === null)!.ids).toHaveLength(30);
  });

  it("keeps the notes and settings of an existing database when it is migrated to the latest version", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "aria-migrate-"));
    temps.push(dir);
    const file = path.join(dir, "aria.db");
    // As a database at the baseline (version 14): what the app wrote before the step that stamps tracker ids.
    const raw = new DatabaseSync(file);
    BASELINE.run(raw, []);
    raw.exec(`PRAGMA user_version = ${BASELINE_VERSION}`);
    raw.exec(`INSERT INTO settings (key, value_json) VALUES ('kept', '{"yes":true}')`);
    raw.exec(`INSERT INTO memories (id, scope, text, created_at, updated_at) VALUES ('m', 'global', 'kept', 1, 1)`);
    raw.close();
    const store = new Store(file);
    expect(store.getSetting("kept")).toEqual({ yes: true });
    expect(store.listMemories()).toMatchObject([{ id: "m", scope: "global", text: "kept" }]);
    store.saveMemory({ id: "n", scope: "global", text: "new" });
    expect(store.listMemories().map((m) => m.id).sort()).toEqual(["m", "n"]);
    store.close();
  });
});
