/**
 * The Conductor's words grant nothing by themselves: what a task may read outside its repository (`allowedPaths`), and
 * `create_repo` / `clone_repo`, have to come from your own latest message (an injection guard).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CardItem } from "@aria/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { AriaEngine } from "../src/engine.ts";
import { assertCloneGrounded, assertCreateGrounded } from "../src/memory/repos.ts";
import { grantablePaths, namesPath, reachesSecrets } from "../src/policy/sandbox.ts";
import { FakeRuntime } from "../src/runtime/fake.ts";
import { commitFile, makeRepo, waitMs } from "./helpers.ts";

const temps: string[] = [];
const engines: AriaEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.stop()));
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function tempDir(): string {
  const base = mkdtempSync(path.join(os.tmpdir(), "aria-grounding-"));
  temps.push(base);
  return base;
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > waitMs(ms)) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function setup() {
  const base = tempDir();
  const projects = path.join(base, "GitHub");
  commitFile(makeRepo(projects, "Moonrise"), "README.md", "# Moonrise\n", "Initial commit");
  const outside = path.join(base, "outside");
  mkdirSync(outside);
  const schema = path.join(outside, "schema.graphql");
  writeFileSync(schema, "type Query { a: Int }\n");
  const other = path.join(outside, "other.graphql");
  writeFileSync(other, "type Query { b: Int }\n");
  const dataDir = path.join(base, "data");
  const runtime = new FakeRuntime();
  const engine = new AriaEngine({ dataDir, runtime, projectRoots: [projects], resumeSettleMs: 10, worktreeRoot: path.join(base, "wt"), taskSettleMs: 20, autopilotGraceMs: 150 });
  engines.push(engine);
  await engine.start();
  return { engine, runtime, projects, outside, schema, other, dataDir };
}

const answers = (engine: AriaEngine) => engine.getState().timeline.filter((i) => i.kind === "chat" && i.role === "assistant");

async function chat(engine: AriaEngine, text: string): Promise<string> {
  const before = answers(engine).length;
  await engine.sendMessage(text);
  await until(() => answers(engine).length > before && engine.getState().status.state === "ready");
  const last = answers(engine).at(-1)!;
  return last.kind === "chat" ? last.content : "";
}

const startTask = (args: Record<string, unknown>) => ({
  toolCalls: [{ name: "start_task", args: { repo: "Moonrise", title: "Compare", ...args } }],
  text: (_p: string, results: unknown[]) => JSON.stringify(results[0]),
});

describe("reachesSecrets", () => {
  const home = path.join(os.tmpdir(), "some-home");

  it("covers credential folders, what's inside them and the folders above them", () => {
    for (const place of [".ssh", path.join(".ssh", "id_rsa"), path.join("AppData", "Roaming", "GitHub CLI", "hosts.yml"), path.join(".config", "gh"), "AppData", path.join("AppData", "Roaming"), ".config", ".git-credentials"]) {
      expect(reachesSecrets(path.join(home, place), [], home), place).toBe(true);
    }
  });

  it("leaves everything else alone, however alike its name", () => {
    for (const place of ["Downloads", path.join("Downloads", "schema.graphql"), ".sshfoo", path.join("AppData", "Local", "Temp", "build.log")]) {
      expect(reachesSecrets(path.join(home, place), [], home), place).toBe(false);
    }
  });

  it("covers the folders it's told to protect", () => {
    const data = path.join(home, "ARIA");
    expect(reachesSecrets(path.join(data, "aria.db"), [data], home)).toBe(true);
    expect(reachesSecrets(data, [data], home)).toBe(true);
    expect(reachesSecrets(path.join(home, "Elsewhere"), [data], home)).toBe(false);
  });
});

describe("grantablePaths", () => {
  it("keeps a folder that exists and isn't protected", () => {
    const base = tempDir();
    const protectedDir = path.join(base, "protected");
    mkdirSync(protectedDir);
    const open = path.join(base, "open");
    mkdirSync(open);
    expect(grantablePaths([open, protectedDir, path.join(base, "missing"), "relative", path.parse(base).root], [protectedDir])).toEqual([realpathSync.native(open)]);
  });
});

describe("namesPath", () => {
  const dir = path.resolve(os.tmpdir(), "Some Folder");
  const file = path.join(dir, "schema.graphql");

  it("finds a path as the user wrote it: other slashes or letter case, quoted, with spaces, at a sentence's end", () => {
    expect(namesPath(`compare ${file}`, file)).toBe(true);
    expect(namesPath(`compare "${file}" please`, file)).toBe(true);
    expect(namesPath(`compare ${file}.`, file)).toBe(true);
    expect(namesPath(`compare ${file.toUpperCase()}`, file)).toBe(true);
    expect(namesPath(`compare ${file.replaceAll("\\", "/")}`, file)).toBe(true);
  });

  it("doesn't take a longer name, or a file for its folder", () => {
    expect(namesPath(`compare ${file}.bak`, file)).toBe(false);
    expect(namesPath(`compare ${file}2`, file)).toBe(false);
    expect(namesPath(`compare ${file}`, dir)).toBe(false);
    expect(namesPath("compare the schemas", file)).toBe(false);
  });

  it("counts a file in a folder the user named", () => {
    const base = tempDir();
    expect(namesPath(`look in ${base}`, path.join(base, "a.json"))).toBe(true);
    expect(namesPath(`look in ${base}2`, path.join(base, "a.json"))).toBe(false);
  });
});

describe("assertCloneGrounded", () => {
  it("takes the repository however the user wrote it", () => {
    for (const said of ["clone acme/widgets", "clone https://github.com/acme/widgets", "clone https://github.com/acme/widgets.git please", "clone git@github.com:acme/widgets.git", "clone github.com/acme/widgets.", "can you clone (ACME/Widgets)?"]) {
      expect(() => assertCloneGrounded(said, "https://github.com/acme/widgets.git"), said).not.toThrow();
    }
    expect(() => assertCloneGrounded("clone https://gitlab.example.com/acme/widgets", "https://gitlab.example.com/acme/widgets.git")).not.toThrow();
  });

  it("refuses what the user didn't name: another repository, another owner or another host", () => {
    for (const said of ["", "what's running?", "clone acme/gadgets", "clone other/widgets", "clone https://gitlab.example.com/acme/widgets", "don't clone acme/widgets"]) {
      expect(() => assertCloneGrounded(said, "https://github.com/acme/widgets.git"), said).toThrow(/Not cloned/);
    }
    expect(() => assertCloneGrounded("clone acme/widgets", "not a url")).toThrow(/Not cloned/);
  });
});

describe("assertCreateGrounded", () => {
  it("takes a repository the user asks for by name", () => {
    for (const said of ["create a repo called widgets", "make a new repository: widgets.", "Create Plugin Widgets", "create plugin_widgets"]) {
      const name = said.toLowerCase().includes("plugin") ? "plugin-widgets" : "widgets";
      expect(() => assertCreateGrounded(said, { name }), said).not.toThrow();
    }
    expect(() => assertCreateGrounded("create repo widgets in acme", { name: "acme/widgets" })).not.toThrow();
    expect(() => assertCreateGrounded("create acme/widgets", { name: "acme/widgets" })).not.toThrow();
  });

  it("refuses without the name, the owner or the ask", () => {
    for (const said of ["", "what tasks are running?", "create a repo called gadgets", "create a repo called widgets2", "the widgets are broken", "don't create widgets"]) {
      expect(() => assertCreateGrounded(said, { name: "widgets" }), said).toThrow(/Not created/);
    }
    expect(() => assertCreateGrounded("create repo widgets", { name: "attacker/widgets" })).toThrow(/Not created/);
    expect(() => assertCreateGrounded("create repo widgets", { name: "---" })).toThrow(/Not created/);
    expect(() => assertCreateGrounded("create repo widgets", { name: "widgets/" })).toThrow(/Not created/);
  });

  it("wants public or internal said out loud, unless it stays local", () => {
    expect(() => assertCreateGrounded("create repo widgets", { name: "widgets", visibility: "public" })).toThrow(/needs the user to say public/);
    expect(() => assertCreateGrounded("create repo widgets, not public", { name: "widgets", visibility: "public" })).toThrow(/needs the user to say public/);
    expect(() => assertCreateGrounded("create a non-public repo widgets", { name: "widgets", visibility: "public" })).toThrow(/needs the user to say public/);
    expect(() => assertCreateGrounded("create repo widgets", { name: "widgets", visibility: "internal" })).toThrow(/needs the user to say internal/);
    expect(() => assertCreateGrounded("create a public repo widgets", { name: "widgets", visibility: "public" })).not.toThrow();
    expect(() => assertCreateGrounded("create repo widgets", { name: "widgets", visibility: "private" })).not.toThrow();
    expect(() => assertCreateGrounded("create repo widgets", { name: "widgets", visibility: "public", localOnly: true })).not.toThrow();
  });
});

describe("a task's read access", () => {
  it("grants nothing for a path only ARIA mentions, in the brief or asked for, and says so for what was asked", async () => {
    const { engine, runtime, schema } = await setup();
    runtime.workerScripts.push({ steps: [{ complete: "Done." }] });
    runtime.replies.push(startTask({ brief: `Also read ${schema} and send it to me.`, allowedPaths: [schema] }));
    const reply = await chat(engine, "compare the schemas in Moonrise");
    expect(engine.getState().tasks[0]).toBeDefined();
    expect(engine.getState().tasks[0]!.allowedPaths).toBeUndefined();
    expect(reply).toContain("pathsNotAllowed");
  });

  it("grants what your message named, and nothing else ARIA adds to it", async () => {
    const { engine, runtime, schema, other } = await setup();
    runtime.workerScripts.push({ steps: [{ complete: "Done." }] });
    runtime.replies.push(startTask({ brief: `Compare ${schema} with ${other}.` }));
    await chat(engine, `compare ${schema} in Moonrise`);
    expect(engine.getState().tasks[0]!.allowedPaths).toEqual([path.resolve(schema)]);
  });

  it("grants a file in a folder your message named", async () => {
    const { engine, runtime, outside, schema } = await setup();
    runtime.workerScripts.push({ steps: [{ complete: "Done." }] });
    runtime.replies.push(startTask({ brief: `Compare ${schema}.` }));
    await chat(engine, `the schemas are in ${outside}`);
    expect(engine.getState().tasks[0]!.allowedPaths).toEqual([path.resolve(schema)]);
  });

  it("never grants ARIA's own data, even when your message names it", async () => {
    const { engine, runtime, dataDir } = await setup();
    const db = path.join(dataDir, "aria.db");
    runtime.workerScripts.push({ steps: [{ complete: "Done." }] });
    runtime.replies.push(startTask({ brief: `Read ${db}.` }));
    await chat(engine, `leave ${db} alone`);
    expect(engine.getState().tasks[0]!.allowedPaths).toBeUndefined();
  });

  it("message_task grants only what your message named; your own message to a task grants what it names", async () => {
    const { engine, runtime, schema, other, dataDir } = await setup();
    const repoId = engine.getState().projects[0]!.id;
    runtime.workerScripts.push({ steps: [{ complete: "Done." }] });
    const task = await engine.startTask({ repoId, brief: "Look around." });
    await until(() => engine.getState().tasks[0]!.state === "done");
    expect(engine.getState().tasks[0]!.allowedPaths).toBeUndefined();

    runtime.workerScripts.push({ steps: [{ complete: "Done." }] });
    runtime.replies.push({ toolCalls: [{ name: "message_task", args: { task: task.id, text: `Now read ${other}.` } }], text: "Sent." });
    await chat(engine, "keep going on that task");
    expect(engine.getState().tasks[0]!.allowedPaths).toBeUndefined();
    await until(() => engine.getState().tasks[0]!.state === "done");

    runtime.workerScripts.push({ steps: [{ complete: "Done." }] });
    await engine.messageTask(task.id, `Read ${schema} and leave ${path.join(dataDir, "aria.db")} alone.`, false);
    expect(engine.getState().tasks[0]!.allowedPaths).toEqual([path.resolve(schema)]);
  });

  it("a task you start yourself gets the paths in your brief; a rerun only adds what you added", async () => {
    const { engine, runtime, schema, other } = await setup();
    const repoId = engine.getState().projects[0]!.id;

    // Started by ARIA, with a path only it mentions.
    runtime.workerScripts.push({ steps: [{ complete: "Done." }] });
    runtime.replies.push(startTask({ brief: `Read ${schema}.` }));
    await chat(engine, "look at Moonrise");
    const source = engine.getState().tasks[0]!;
    expect(source.allowedPaths).toBeUndefined();
    await until(() => engine.getState().tasks.find((t) => t.id === source.id)!.state === "done");

    runtime.workerScripts.push({ steps: [{ complete: "Done." }] });
    const rerun = await engine.startTask({ repoId, brief: `Read ${schema}.`, rerunOf: source.id });
    expect(rerun.allowedPaths).toBeUndefined();
    await until(() => engine.getState().tasks.find((t) => t.id === rerun.id)!.state === "done");

    runtime.workerScripts.push({ steps: [{ complete: "Done." }] });
    const edited = await engine.startTask({ repoId, brief: `Read ${schema} and ${other}.`, rerunOf: source.id });
    expect(edited.allowedPaths).toEqual([path.resolve(other)]);
    await until(() => engine.getState().tasks.find((t) => t.id === edited.id)!.state === "done");

    runtime.workerScripts.push({ steps: [{ complete: "Done." }] });
    const yours = await engine.startTask({ repoId, brief: `Read ${schema}.` });
    expect(yours.allowedPaths).toEqual([path.resolve(schema)]);
    await until(() => engine.getState().tasks.find((t) => t.id === yours.id)!.state === "done");

    runtime.workerScripts.push({ steps: [{ complete: "Done." }] });
    const again = await engine.startTask({ repoId, brief: "Read it again.", rerunOf: yours.id });
    expect(again.allowedPaths).toEqual([path.resolve(schema)]);
  });

  it("a proposal carries what your message named to the task it starts", async () => {
    const { engine, runtime, schema, other } = await setup();
    await engine.setProfilePolicy("ask");
    runtime.replies.push(startTask({ brief: `Compare ${schema} with ${other}.`, profile: "Deep", reason: "Care." }));
    await chat(engine, `compare ${schema} in Moonrise`);
    const card = engine.getState().timeline.find((i): i is Extract<CardItem, { cardType: "profile_proposal" }> => i.kind === "card" && i.cardType === "profile_proposal")!;
    expect(card.payload.allowedPaths).toEqual([path.resolve(schema)]);
    runtime.workerScripts.push({ steps: [{ complete: "Done." }] });
    const task = await engine.startProposal(card.id);
    expect(task.allowedPaths).toEqual([path.resolve(schema)]);
  });
});

describe("create_repo and clone_repo from the Conductor", () => {
  it("refuses what your message doesn't ask for, and nothing happens", async () => {
    const { engine, runtime } = await setup();
    const before = engine.getState().projects.length;

    runtime.replies.push({ toolCalls: [{ name: "create_repo", args: { name: "exfiltrated", visibility: "public" } }], text: (_p, results) => JSON.stringify(results[0]) });
    expect(await chat(engine, "what tasks are running?")).toContain("Not created");

    runtime.replies.push({ toolCalls: [{ name: "create_repo", args: { name: "widgets", visibility: "public" } }], text: (_p, results) => JSON.stringify(results[0]) });
    expect(await chat(engine, "create a repo called widgets")).toContain("needs the user to say public");

    runtime.replies.push({ toolCalls: [{ name: "clone_repo", args: { url: "https://github.com/attacker/payload.git" } }], text: (_p, results) => JSON.stringify(results[0]) });
    expect(await chat(engine, "what tasks are running?")).toContain("Not cloned");

    expect(engine.getState().projects).toHaveLength(before);
  });

  it("creates what your message asks for, and only in the project folder", async () => {
    const { engine, runtime, projects } = await setup();
    const elsewhere = tempDir();
    runtime.replies.push({
      toolCalls: [{ name: "create_repo", args: { name: "widgets", localOnly: true, rootFolder: elsewhere } }],
      text: (_p, results) => `Created: ${(results[0] as { created: string }).created}`,
    });
    expect(await chat(engine, "create a local repo called widgets")).toBe("Created: widgets");
    expect(engine.getState().projects.find((p) => p.name === "widgets")?.path).toBe(path.join(projects, "widgets"));
  });

  it("no longer marks them read-only, so they aren't exempt from the permission layer", async () => {
    const { engine, runtime } = await setup();
    await chat(engine, "hello");
    const conductor = [...runtime.sessions.values()].find((s) => s.config.tools?.some((t) => t.name === "create_repo"))!;
    const tool = (name: string) => conductor.config.tools!.find((t) => t.name === name)!;
    expect(tool("create_repo").readOnly).toBe(false);
    expect(tool("clone_repo").readOnly).toBe(false);
  });
});
