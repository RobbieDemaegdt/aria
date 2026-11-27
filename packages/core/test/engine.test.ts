import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EngineEvent } from "@aria/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ConductorPolicy } from "../src/conductor/policy.ts";
import { AriaEngine } from "../src/engine.ts";
import { FakeRuntime } from "../src/runtime/fake.ts";
import type { RuntimeEvent } from "../src/runtime/types.ts";
import { makeRepo, waitMs } from "./helpers.ts";

const temps: string[] = [];
const engines: AriaEngine[] = [];
afterEach(async () => {
  // Stop engines a failed test left running first: Windows can't delete a folder with the database still open.
  await Promise.all(engines.splice(0).map((e) => e.stop()));
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function setup(runtime = new FakeRuntime()) {
  const base = mkdtempSync(path.join(os.tmpdir(), "aria-engine-"));
  temps.push(base);
  const projects = path.join(base, "GitHub");
  makeRepo(projects, "Garden Castle Defense", "https://github.com/me/tower.git");
  makeRepo(projects, "Moonrise", "https://github.com/me/moonrise.git");
  const dataDir = path.join(base, "data");
  const make = (options: { runtimeCheckMs?: number } = {}) => {
    const engine = new AriaEngine({ dataDir, runtime, projectRoots: [projects], resumeSettleMs: 30, worktreeRoot: path.join(base, "wt"), ...options });
    engines.push(engine);
    return engine;
  };
  return { runtime, projects, dataDir, make };
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > waitMs(ms)) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function record(engine: AriaEngine) {
  const events: EngineEvent[] = [];
  engine.onEvent((e) => events.push(e));
  return events;
}

describe("AriaEngine", () => {
  it("starts with the cheapest lightweight model and the scanned projects", async () => {
    const { make } = setup();
    const engine = make();
    await engine.start();
    const state = engine.getState();
    expect(state.status).toMatchObject({ state: "ready", model: "fake-light", reasoningEffort: "low" });
    expect(state.projects.map((p) => p.name)).toEqual(["Garden Castle Defense", "Moonrise"]);
    expect(state.timeline).toEqual([]);
    await engine.stop();
  });

  it("chats: stores your message and the final answer, streams deltas, and goes busy → ready", async () => {
    const { make, runtime } = setup();
    runtime.replies.push({ text: "Hello! How can I help?" });
    const engine = make();
    await engine.start();
    const events = record(engine);
    await engine.sendMessage("hi");
    await until(() => engine.getState().timeline.length === 2 && engine.getState().status.state === "ready");
    const timeline = engine.getState().timeline;
    expect(timeline.map((i) => (i.kind === "chat" ? `${i.role}:${i.content}` : i.kind))).toEqual(["user:hi", "assistant:Hello! How can I help?"]);
    expect(events.filter((e) => e.type === "delta").map((e) => (e.type === "delta" ? e.text : "")).join("")).toBe("Hello! How can I help?");
    expect(events.some((e) => e.type === "status" && e.status.state === "busy")).toBe(true);
    await engine.stop();
  });

  it("lets the Conductor list projects through its own tool and shows the activity", async () => {
    const { make, runtime } = setup();
    runtime.replies.push({
      toolCalls: [{ name: "list_repos", args: { query: "tower" } }],
      text: (_p, results) => `Found: ${(results[0] as Array<{ name: string }>).map((r) => r.name).join(", ")}`,
    });
    const engine = make();
    await engine.start();
    const events = record(engine);
    await engine.sendMessage("which project is the tower game?");
    await until(() => engine.getState().timeline.length === 2);
    expect(engine.getState().timeline[1]).toMatchObject({ role: "assistant", content: "Found: Garden Castle Defense" });
    expect(events).toContainEqual({ type: "activity", label: "Checking your projects" });
    expect(events.filter((e) => e.type === "activity").at(-1)).toEqual({ type: "activity", label: null });
    await engine.stop();
  });

  it("lets the Conductor create a repository through create_repo tool and registers it", async () => {
    const { make, runtime, projects } = setup();
    runtime.replies.push({
      toolCalls: [{ name: "create_repo", args: { name: "plugin-marketplace", localOnly: true, description: "New plugin catalog" } }],
      text: (_p, results) => `Created: ${(results[0] as { created: string }).created}`,
    });
    const engine = make();
    await engine.start();
    await engine.sendMessage("create a repository called plugin-marketplace");
    await until(() => engine.getState().timeline.length === 2);
    expect(engine.getState().timeline[1]).toMatchObject({ role: "assistant", content: "Created: plugin-marketplace" });
    const createdProject = engine.getState().projects.find((p) => p.name === "plugin-marketplace");
    expect(createdProject).toBeDefined();
    expect(createdProject?.path).toBe(path.join(projects, "plugin-marketplace"));
    await engine.stop();
  });

  it("removes a project folder from the visible projects list and restores it if added again", async () => {
    const { make, projects } = setup();
    const engine = make();
    await engine.start();
    const folderPath = path.join(projects, "..", "scratch-folder");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(folderPath, { recursive: true });

    const added = await engine.addProjectFolder(folderPath);
    expect(added).toMatchObject({ name: "scratch-folder", kind: "folder", hidden: false });

    const afterRemove = engine.removeProject(added.id);
    expect(afterRemove.find((p) => p.id === added.id)?.hidden).toBe(true);
    expect(engine.getState().projects.filter((p) => !p.hidden).map((p) => p.name)).not.toContain("scratch-folder");

    // Re-adding the same folder un-hides it.
    const readded = await engine.addProjectFolder(folderPath);
    expect(readded.hidden).toBe(false);
    expect(engine.getState().projects.filter((p) => !p.hidden).map((p) => p.name)).toContain("scratch-folder");
    await engine.stop();
  });

  it("comes back to the same conversation after a restart, and reports interrupted tools", async () => {
    const { make, runtime } = setup();
    const first = make();
    await first.start();
    await first.sendMessage("remember Otter");
    await until(() => first.getState().timeline.length === 2);
    await first.stop();

    runtime.resumeEvents = [{ type: "warning", warningType: "interrupted_tools", message: "1 tool call(s) had no recorded result" }];
    const second = make();
    await second.start();
    expect(runtime.sessions.size).toBe(1);
    const session = [...runtime.sessions.values()][0]!;
    expect(session.prompts).toEqual(["remember Otter"]);
    const timeline = second.getState().timeline;
    expect(timeline.slice(0, 2).map((i) => (i.kind === "chat" ? i.content : ""))).toEqual(["remember Otter", "echo: remember Otter"]);
    expect(timeline.at(-1)).toMatchObject({ kind: "notice", cause: "interrupted_tools" });
    await second.stop();
  });

  it("starts a fresh conversation when the old one can't be resumed, keeping the timeline", async () => {
    const { make, runtime } = setup();
    const first = make();
    await first.start();
    await first.sendMessage("hello");
    await until(() => first.getState().timeline.length === 2);
    await first.stop();

    runtime.failOpens = 1;
    const second = make();
    await second.start();
    expect(second.getState().status.state).toBe("ready");
    expect(runtime.sessions.size).toBe(2);
    expect(second.getState().timeline.at(-1)).toMatchObject({ kind: "notice", cause: "resume_failed" });
    await second.stop();
  });

  it("says so when it runs on its bundled runtime because your Copilot CLI speaks a newer protocol, and still opens the conversation", async () => {
    const { make, runtime } = setup();
    runtime.fallback = {
      from: "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\copilot.exe",
      to: "C:\\ARIA\\resources\\app.asar.unpacked\\node_modules\\@github\\copilot-sdk-win32-x64\\prebuilds\\win32-x64\\copilot-runtime.exe",
      reason: "SDK protocol version mismatch: SDK supports versions 3-3, but server reports version 4.",
      cliProtocol: 4,
      sdkProtocols: { min: 3, max: 3 },
      version: "1.0.98",
    };
    const engine = make();
    await engine.start();
    expect(engine.getState().status.state).toBe("ready");
    const notice = engine.getState().timeline.find((i) => i.kind === "notice" && i.cause === "runtime_fallback");
    expect(notice).toMatchObject({ level: "warning" });
    expect(notice?.kind === "notice" && notice.message).toMatch(/WinGet\\Links\\copilot\.exe speaks wire protocol 4, but ARIA's Copilot SDK only speaks protocol 3, so ARIA is running on its bundled Copilot runtime 1\.0\.98 instead/);
    const doctor = await engine.runDoctor();
    expect(doctor.cliSource).toBe("bundled");
    expect(doctor.checks.find((c) => c.id === "copilot_cli")).toMatchObject({ status: "warning", summary: expect.stringMatching(/^Using the Copilot runtime bundled with ARIA \(1\.0\.98\): the Copilot CLI found on PATH speaks wire protocol 4/) });
    await engine.stop();
  });

  it("validates model choices in its own code and applies them to the session", async () => {
    const { make, runtime } = setup();
    const engine = make();
    await engine.start();
    await expect(engine.setConductorModel({ model: "nope" })).rejects.toThrow(/isn't an available model/);
    await expect(engine.setConductorModel({ model: "fake-off" })).rejects.toThrow(/isn't an available model/);
    await expect(engine.setConductorModel({ model: "fake-strong", reasoningEffort: "max" })).rejects.toThrow(/effort levels/);
    await engine.setConductorModel({ model: "fake-strong", reasoningEffort: "high" });
    expect(engine.getState().conductor).toEqual({ model: "fake-strong", reasoningEffort: "high" });
    const session = [...runtime.sessions.values()][0]!;
    expect(session).toMatchObject({ model: "fake-strong", reasoningEffort: "high" });
    expect(engine.getState().timeline).toEqual([]);
    await engine.stop();
  });

  it("doesn't save a model choice the runtime refused to switch to", async () => {
    const { make, runtime } = setup();
    const engine = make();
    await engine.start();
    runtime.failNextSetModel = true;
    await expect(engine.setConductorModel({ model: "fake-strong", reasoningEffort: "high" })).rejects.toThrow(/rejected/);
    expect(engine.getState().conductor).toEqual({ model: "fake-light", reasoningEffort: "low" });
    expect(engine.getState().status).toMatchObject({ model: "fake-light", reasoningEffort: "low" });
    await engine.stop();
  });

  it("applies overlapping model changes one at a time, without false runtime-switch warnings (D15)", async () => {
    const { make, runtime } = setup();
    const engine = make();
    await engine.start();
    runtime.setModelDelayMs = 20;
    await Promise.all([
      engine.setConductorModel({ model: "fake-strong", reasoningEffort: "high" }),
      engine.setConductorModel({ model: "fake-light", reasoningEffort: "medium" }),
    ]);
    expect(engine.getState().timeline).toEqual([]);
    expect(engine.getState().conductor).toEqual({ model: "fake-light", reasoningEffort: "medium" });
    expect([...runtime.sessions.values()][0]).toMatchObject({ model: "fake-light", reasoningEffort: "medium" });
    await engine.stop();
  });

  it("replaces a saved model the runtime no longer offers, says so, and saves the replacement", async () => {
    const { make, runtime } = setup();
    const first = make();
    await first.start();
    await first.setConductorModel({ model: "fake-strong", reasoningEffort: "xhigh" });
    await first.stop();

    runtime.models = runtime.models.filter((m) => m.id !== "fake-strong");
    const second = make();
    await second.start();
    expect(second.getState().status).toMatchObject({ state: "ready", model: "fake-light", reasoningEffort: "low" });
    expect(second.getState().conductor).toEqual({ model: "fake-light", reasoningEffort: "low" });
    expect([...runtime.sessions.values()][0]).toMatchObject({ model: "fake-light", reasoningEffort: "low" });
    expect(second.getState().timeline.at(-1)).toMatchObject({ kind: "notice", level: "warning", cause: "model_unavailable" });
    await second.stop();

    const third = make();
    await third.start();
    expect(third.getState().timeline.filter((i) => i.kind === "notice")).toHaveLength(1);
    await third.stop();
  });

  it("falls back to the model's default effort when a saved effort isn't offered anymore", async () => {
    const { make, runtime } = setup();
    const first = make();
    await first.start();
    await first.setConductorModel({ model: "fake-strong", reasoningEffort: "xhigh" });
    await first.stop();

    runtime.models = runtime.models.map((m) => (m.id === "fake-strong" ? { ...m, efforts: ["low", "high"] } : m));
    const second = make();
    await second.start();
    expect(second.getState().conductor).toEqual({ model: "fake-strong", reasoningEffort: "low" });
    expect(second.getState().timeline.at(-1)).toMatchObject({ kind: "notice", cause: "effort_unavailable" });
    await second.stop();
  });

  it("publishes the model catalog and the default model once they're known", async () => {
    const { make } = setup();
    const engine = make();
    const events = record(engine);
    await engine.start();
    expect(events.find((e) => e.type === "models")).toMatchObject({ models: [{ id: "fake-light" }, { id: "fake-strong" }, { id: "fake-off" }] });
    expect(events).toContainEqual({ type: "settings", conductor: { model: "fake-light", reasoningEffort: "low" } });
    expect(engine.getState().models.map((m) => m.id)).toEqual(["fake-light", "fake-strong", "fake-off"]);
    await engine.stop();
  });

  it("applies a model you pick while the conversation is still opening", async () => {
    const { make, runtime } = setup();
    const open = runtime.openConductor.bind(runtime);
    let release: (() => void) | undefined;
    runtime.openConductor = async (config) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return open(config);
    };
    const engine = make();
    const starting = engine.start();
    await until(() => release !== undefined);
    const change = engine.setConductorModel({ model: "fake-strong", reasoningEffort: "high" });
    release!();
    await Promise.all([starting, change]);
    expect(engine.getState().status).toMatchObject({ state: "ready", model: "fake-strong", reasoningEffort: "high" });
    expect(engine.getState().conductor).toEqual({ model: "fake-strong", reasoningEffort: "high" });
    expect([...runtime.sessions.values()][0]).toMatchObject({ model: "fake-strong", reasoningEffort: "high" });
    expect(engine.getState().timeline).toEqual([]);
    await engine.stop();
  });

  it("shows the model the runtime reports while opening, not the one it asked for (D15)", async () => {
    const { make, runtime } = setup();
    runtime.openEvents = [{ type: "model_change", model: "fake-strong", previousModel: "fake-light" }];
    const engine = make();
    await engine.start();
    expect(engine.getState().status).toMatchObject({ state: "ready", model: "fake-strong" });
    expect(engine.getState().timeline.at(-1)).toMatchObject({ kind: "notice", level: "warning", cause: "model_mismatch" });
    await engine.stop();
  });

  it("keeps showing the model the runtime actually switched to when it differs from your pick (D15)", async () => {
    const { make, runtime } = setup();
    const engine = make();
    await engine.start();
    runtime.substituteModel = "fake-light";
    await engine.setConductorModel({ model: "fake-strong", reasoningEffort: "high" });
    expect(engine.getState().status.model).toBe("fake-light");
    expect(engine.getState().timeline.at(-1)).toMatchObject({ kind: "notice", cause: "model_mismatch" });
    expect(engine.getState().conductor).toEqual({ model: "fake-strong", reasoningEffort: "high" });
    await engine.stop();
  });

  it("doesn't carry what a failed opening attempt reported over to the session that replaces it", async () => {
    const { make, runtime } = setup();
    const open = runtime.openConductor.bind(runtime);
    const callbacks: Array<(event: RuntimeEvent) => void> = [];
    runtime.openConductor = (config) => {
      callbacks.push(config.onEvent);
      return open(config);
    };
    runtime.openEvents = [{ type: "model_change", model: "fake-strong", previousModel: "fake-light" }];
    runtime.failOpens = 1;
    const engine = make();
    await engine.start();
    expect(callbacks).toHaveLength(2);
    expect(engine.getState().status).toMatchObject({ state: "ready", model: "fake-light", reasoningEffort: "low" });

    // A late event from the failed attempt is ignored; so is anything after shutdown.
    callbacks[0]!({ type: "model_change", model: "fake-strong" });
    expect(engine.getState().status.model).toBe("fake-light");
    await engine.stop();
    expect(() => callbacks[1]!({ type: "message", messageId: "late", text: "too late" })).not.toThrow();
  });

  it("opens the conversation when you pick a model after it couldn't be opened at startup", async () => {
    const { make, runtime } = setup();
    runtime.failOpens = 2;
    const engine = make();
    await engine.start();
    expect(engine.getState().status.state).toBe("error");
    await engine.setConductorModel({ model: "fake-strong", reasoningEffort: "high" });
    expect(engine.getState().status).toMatchObject({ state: "ready", model: "fake-strong", reasoningEffort: "high" });
    await engine.sendMessage("hi");
    await until(() => engine.getState().timeline.length === 2);
    await engine.stop();
  });

  describe("a model you switched to that can't finish its first answer in this conversation", () => {
    // What the runtime says when Gemini 4 Hydrogen can't read a long conversation's history.
    const UNFINISHED = "Execution failed: The model's response ended without completing (missing_finish_reason). Try again, or switch to a different model.";
    const userMessages = (engine: AriaEngine) => engine.getState().timeline.flatMap((i) => (i.kind === "chat" && i.role === "user" ? [i.content] : []));
    const replied = (engine: AriaEngine, text: string) => engine.getState().timeline.some((i) => i.kind === "chat" && i.role === "assistant" && i.content === text);
    const notices = (engine: AriaEngine) => engine.getState().timeline.flatMap((i) => (i.kind === "notice" ? [i.cause] : []));

    async function switchedAfterAChat() {
      const env = setup();
      const opened: string[] = [];
      const open = env.runtime.openConductor.bind(env.runtime);
      env.runtime.openConductor = (config) => {
        opened.push(config.sessionId);
        return open(config);
      };
      const engine = env.make();
      await engine.start();
      env.runtime.replies.push({ text: "Hi." });
      await engine.sendMessage("hello");
      await until(() => replied(engine, "Hi.") && engine.getState().status.state === "ready");
      await engine.setConductorModel({ model: "fake-strong", reasoningEffort: "high" });
      return { ...env, engine, opened };
    }

    it("continues in a fresh conversation on that model and sends your message again", async () => {
      const { engine, runtime, opened, make } = await switchedAfterAChat();
      runtime.replies.push({ text: "", error: UNFINISHED }, { text: "Here's the task." });
      await engine.sendMessage("Read task 313214");
      await until(() => replied(engine, "Here's the task.") && engine.getState().status.state === "ready");

      expect(opened).toEqual(["aria-conductor", expect.stringMatching(/^aria-conductor-\d+$/)]);
      const fresh = runtime.sessions.get(opened[1]!)!;
      expect(fresh).toMatchObject({ model: "fake-strong", reasoningEffort: "high" });
      expect(fresh.prompts).toHaveLength(1);
      expect(fresh.prompts[0]).toMatch(/^<fresh_conversation>[\s\S]*\n\nRead task 313214$/);
      // Sent again, not asked again: the chat shows your message once, and one notice says what happened.
      expect(userMessages(engine)).toEqual(["hello", "Read task 313214"]);
      expect(notices(engine)).toEqual(["fresh_conversation"]);
      expect(engine.getState().status).toMatchObject({ state: "ready", model: "fake-strong", reasoningEffort: "high" });
      await engine.stop();

      // The fresh conversation is the one ARIA continues after a restart.
      const again = make();
      await again.start();
      expect(opened.at(-1)).toBe(opened[1]);
      await again.stop();
    });

    it("keeps the conversation when the model already answered in it", async () => {
      const { engine, runtime, opened } = await switchedAfterAChat();
      runtime.replies.push({ text: "Sure." }, { text: "", error: UNFINISHED });
      await engine.sendMessage("first");
      await until(() => replied(engine, "Sure.") && engine.getState().status.state === "ready");
      await engine.sendMessage("second");
      await until(() => notices(engine).length === 1 && engine.getState().status.state === "ready");
      expect(notices(engine)).toEqual(["session_error"]);
      expect(opened).toEqual(["aria-conductor"]);
      await engine.stop();
    });

    it("keeps the conversation for another failure", async () => {
      const { engine, runtime, opened } = await switchedAfterAChat();
      runtime.replies.push({ text: "", error: "Rate limit exceeded. Try again later." });
      await engine.sendMessage("Read task 313214");
      await until(() => notices(engine).length === 1 && engine.getState().status.state === "ready");
      expect(notices(engine)).toEqual(["session_error"]);
      expect(opened).toEqual(["aria-conductor"]);
      await engine.stop();
    });
  });

  it("opens and writes nothing when it's stopped while still starting", async () => {
    const { make, runtime } = setup();
    let release: (() => void) | undefined;
    runtime.start = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const engine = make();
    const events = record(engine);
    const starting = engine.start();
    await until(() => release !== undefined);
    await engine.stop();
    release!();
    await starting;
    expect(runtime.sessions.size).toBe(0);
    expect(events.filter((e) => e.type === "status").map((e) => (e.type === "status" ? e.status.state : ""))).toEqual(["starting"]);
  });

  it("shows a warning when the runtime switches models on its own (D15)", async () => {
    const { make, runtime } = setup();
    const engine = make();
    await engine.start();
    const session = [...runtime.sessions.values()][0]!;
    session.config.onEvent({ type: "model_change", model: "fake-strong", previousModel: "fake-light", cause: "refusal_fallback" });
    expect(engine.getState().timeline.at(-1)).toMatchObject({ kind: "notice", level: "warning", cause: "refusal_fallback" });
    expect(engine.getState().status.model).toBe("fake-strong");
    await engine.stop();
  });

  it("refuses to send before it's ready and reports runtime start failures", async () => {
    const runtime = new FakeRuntime();
    runtime.start = async () => {
      throw new Error("not signed in");
    };
    const { make } = setup(runtime);
    const engine = make();
    await engine.start();
    expect(engine.getState().status).toMatchObject({ state: "error", detail: "not signed in" });
    await expect(engine.sendMessage("hi")).rejects.toThrow(/isn't ready/);
    await engine.stop();
  });

  describe("reconnect", () => {
    /** Counts the runtime's stops: a restart is one, reopening only the conversation is none. */
    function countStops(runtime: FakeRuntime) {
      const stop = runtime.stop.bind(runtime);
      const counted = { stops: 0 };
      runtime.stop = () => {
        counted.stops++;
        return stop();
      };
      return counted;
    }

    it("connects once the runtime can start, without restarting ARIA", async () => {
      const { make, runtime } = setup();
      runtime.failStarts = 1;
      runtime.replies.push({ text: "Back." });
      const engine = make();
      await engine.start();
      expect(engine.getState().status).toMatchObject({ state: "error", detail: "fake: Copilot CLI isn't signed in" });
      const events = record(engine);
      await engine.reconnect();
      expect(engine.getState().status).toMatchObject({ state: "ready", model: "fake-light" });
      expect(events.find((e) => e.type === "status")).toMatchObject({ status: { state: "starting" } });
      expect(events.some((e) => e.type === "models")).toBe(true);
      await engine.sendMessage("hi");
      await until(() => engine.getState().timeline.length === 2);
      await engine.stop();
    });

    it("goes back to the error status with the reason when it fails, and can try again", async () => {
      const { make, runtime } = setup();
      runtime.failStarts = 2;
      const engine = make();
      await engine.start();
      await engine.reconnect();
      expect(engine.getState().status).toMatchObject({ state: "error", detail: "fake: Copilot CLI isn't signed in" });
      await engine.reconnect();
      expect(engine.getState().status.state).toBe("ready");
      await engine.stop();
    });

    it("restarts a runtime that came up when a later step failed, so a new sign-in counts", async () => {
      const { make, runtime } = setup();
      const counted = countStops(runtime);
      const listModels = runtime.listModels.bind(runtime);
      let signedIn = false;
      runtime.listModels = async () => {
        if (!signedIn) throw new Error("not signed in");
        return listModels();
      };
      const engine = make();
      await engine.start();
      expect(engine.getState().status).toMatchObject({ state: "error", detail: "not signed in" });
      signedIn = true;
      await engine.reconnect();
      expect(engine.getState().status.state).toBe("ready");
      expect(counted.stops).toBe(1);
      await engine.stop();
    });

    it("restarts the runtime when only the conversation couldn't open, and starts what waited for it", async () => {
      const { make, runtime } = setup();
      const counted = countStops(runtime);
      runtime.failOpens = 2;
      const engine = make();
      await engine.start();
      expect(engine.getState().status.state).toBe("error");
      const events = record(engine);
      await engine.reconnect();
      expect(engine.getState().status.state).toBe("ready");
      expect(counted.stops).toBe(1);
      expect(events.some((e) => e.type === "routines")).toBe(true);
      await engine.stop();
    });

    it("shows a runtime that ended while ARIA ran, stops what's left of it, and brings it back", async () => {
      const { make, runtime } = setup();
      const counted = countStops(runtime);
      runtime.replies.push({ text: "Back." });
      const engine = make({ runtimeCheckMs: 5 });
      await engine.start();
      expect(engine.getState().status.state).toBe("ready");

      runtime.started = false;
      await until(() => engine.getState().status.state === "error");
      expect(engine.getState().status.detail).toMatch(/stopped answering/);
      expect(counted.stops).toBe(1);
      await expect(engine.sendMessage("hi")).rejects.toThrow(/isn't ready/);

      await engine.reconnect();
      expect(engine.getState().status.state).toBe("ready");
      await engine.sendMessage("hi");
      await until(() => engine.getState().timeline.length === 2);
      await engine.stop();
    });

    it("starts a new runtime only when what's left of the old one has stopped", async () => {
      const { make, runtime } = setup();
      const stop = runtime.stop.bind(runtime);
      let release: (() => void) | undefined;
      runtime.stop = async () => {
        if (!release) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return stop();
      };
      const engine = make({ runtimeCheckMs: 5 });
      await engine.start();
      runtime.started = false;
      await until(() => engine.getState().status.state === "error");
      await until(() => release !== undefined);

      const start = runtime.start.bind(runtime);
      let starts = 0;
      runtime.start = (options) => {
        starts++;
        return start(options);
      };
      const reconnecting = engine.reconnect();
      await new Promise((r) => setTimeout(r, 30));
      expect(starts).toBe(0);
      release!();
      await reconnecting;
      expect(starts).toBe(1);
      expect(engine.getState().status.state).toBe("ready");
      await engine.stop();
    });

    it("doesn't take a missed answer or two for a runtime that's gone", async () => {
      const { make, runtime } = setup();
      const counted = countStops(runtime);
      let asked = 0;
      runtime.isAlive = async () => ++asked % 3 === 0;
      const engine = make({ runtimeCheckMs: 5 });
      await engine.start();
      await until(() => asked >= 9);
      expect(engine.getState().status.state).toBe("ready");
      expect(counted.stops).toBe(0);
      await engine.stop();
    });

    it("checks at once when a message can't be sent, instead of at the next check", async () => {
      const { make, runtime } = setup();
      const engine = make();
      await engine.start();
      runtime.started = false;
      runtime.failNextSend = true;
      await engine.sendMessage("hi");
      await until(() => engine.getState().status.state === "error", 5000);
      await engine.stop();
    });

    it("stays not connected when a message on its way fails after the runtime is gone", async () => {
      const { make, runtime } = setup();
      const open = runtime.openConductor.bind(runtime);
      let fail: ((error: Error) => void) | undefined;
      runtime.openConductor = async (config) => {
        const handle = await open(config);
        handle.send = () =>
          new Promise<void>((_, reject) => {
            fail = reject;
          });
        return handle;
      };
      const engine = make({ runtimeCheckMs: 5 });
      await engine.start();
      const sending = engine.sendMessage("hi");
      await until(() => fail !== undefined);

      runtime.started = false;
      await until(() => engine.getState().status.state === "error");
      fail!(new Error("Session disconnected"));
      await sending;
      expect(engine.getState().status.state).toBe("error");
      await engine.stop();
    });

    it("ignores what the old session still reports once the runtime is gone", async () => {
      const { make, runtime } = setup();
      const engine = make({ runtimeCheckMs: 5 });
      await engine.start();
      const session = [...runtime.sessions.values()][0]!;
      runtime.started = false;
      await until(() => engine.getState().status.state === "error");
      session.config.onEvent({ type: "turn_start" });
      expect(engine.getState().status.state).toBe("error");
      await engine.stop();
    });

    it("records a routine that was running as failed, with the reason, when the runtime goes", async () => {
      const { make, runtime } = setup();
      const open = runtime.openConductor.bind(runtime);
      runtime.openConductor = async (config) => {
        const handle = await open(config);
        // Accepted, and never answered: the routine's turn stays on its way.
        handle.send = async () => {};
        return handle;
      };
      const engine = make({ runtimeCheckMs: 5 });
      await engine.start();
      const saved = engine.saveRoutine({ name: "Check", cron: "0 11 * * 1-5", prompt: "Run the check" });
      const running = engine.runRoutine(saved.id);
      await until(() => engine.getState().status.state === "busy");
      runtime.started = false;
      const after = await running;
      expect(after.lastStatus).toBe("error");
      expect(after.lastError).toContain("stopped answering");
      await engine.stop();
    });

    it("stays not connected when the runtime goes while the conversation opens", async () => {
      const { make, runtime } = setup();
      const open = runtime.openConductor.bind(runtime);
      let release: (() => void) | undefined;
      runtime.openConductor = async (config) => {
        const handle = await open(config);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return handle;
      };
      const engine = make({ runtimeCheckMs: 5 });
      const starting = engine.start();
      await until(() => release !== undefined);

      runtime.started = false;
      await until(() => engine.getState().status.state === "error");
      release!();
      await starting;
      expect(engine.getState().status.state).toBe("error");
      await expect(engine.sendMessage("hi")).rejects.toThrow(/isn't ready/);
      await engine.stop();
    });

    it("ignores a check that was on its way when Reconnect restarted the runtime", async () => {
      const { make, runtime } = setup();
      runtime.failOpens = 2;
      let asked = 0;
      let answer: ((alive: boolean) => void) | undefined;
      runtime.isAlive = () =>
        ++asked < 3
          ? Promise.resolve(false)
          : new Promise<boolean>((resolve) => {
              answer = resolve;
            });
      const engine = make({ runtimeCheckMs: 5 });
      await engine.start();
      await until(() => answer !== undefined);

      runtime.isAlive = async () => true;
      await engine.reconnect();
      expect(engine.getState().status.state).toBe("ready");
      answer!(false);
      await new Promise((r) => setTimeout(r, 30));
      expect(engine.getState().status.state).toBe("ready");
      await engine.stop();
    });

    it("says nothing about the runtime once ARIA quits", async () => {
      const { make, runtime } = setup();
      let asked = 0;
      let answer: ((alive: boolean) => void) | undefined;
      runtime.isAlive = () =>
        ++asked < 3
          ? Promise.resolve(false)
          : new Promise<boolean>((resolve) => {
              answer = resolve;
            });
      const engine = make({ runtimeCheckMs: 5 });
      await engine.start();
      await until(() => answer !== undefined);
      const events = record(engine);
      await engine.stop();
      answer!(false);
      await new Promise((r) => setTimeout(r, 30));
      expect(events.some((e) => e.type === "status" && e.status.state === "error")).toBe(false);
    });

    it("does nothing unless ARIA is in the error status", async () => {
      const { make, runtime } = setup();
      const counted = countStops(runtime);
      const engine = make();
      await engine.start();
      await engine.reconnect();
      expect(counted.stops).toBe(0);
      expect(engine.getState().status.state).toBe("ready");
      await engine.stop();
    });

    it("opens nothing when ARIA quits while it reconnects", async () => {
      const { make, runtime } = setup();
      runtime.failStarts = 1;
      const engine = make();
      await engine.start();
      let release: (() => void) | undefined;
      runtime.start = () =>
        new Promise<void>((resolve) => {
          release = resolve;
        });
      const reconnecting = engine.reconnect();
      await until(() => release !== undefined);
      await engine.stop();
      release!();
      await reconnecting;
      expect(runtime.sessions.size).toBe(0);
    });
  });

  it("clears a card from the timeline and emits timeline_removed without deleting chat messages", async () => {
    const { make } = setup();
    const engine = make();
    await engine.start();
    const events = record(engine);
    await engine.sendMessage("hi");
    await until(() => engine.getState().timeline.length === 2);
    const chatId = engine.getState().timeline[0]!.id;
    engine.dismissCard(chatId);
    expect(engine.getState().timeline).toHaveLength(2);

    const task = await engine.startTask({ repoId: engine.getState().projects[0]!.id, title: "Fix CI", brief: "Fix it" });
    const card = engine.getState().timeline.find((i) => i.kind === "card" && i.cardType === "task" && i.payload.taskId === task.id);
    expect(card).toBeDefined();
    engine.dismissCard(card!.id);
    expect(engine.getState().timeline.some((i) => i.id === card!.id)).toBe(false);
    expect(events).toContainEqual({ type: "timeline_removed", id: card!.id });
    await engine.stop();
  });
});

describe("ConductorPolicy", () => {
  const policy = new ConductorPolicy({
    mcp: (server, wireName) => (server === "Acme" && wireName === "Acme-list_my_issues" ? { tool: "list_my_issues", cls: "read", effect: "auto", github: false, fixed: false } : undefined),
    readableRoots: () => ["C:\\Users\\me\\Documents\\GitHub\\Moonrise"],
  });

  it.each([
    [{ kind: "mcp", server: "Acme", tool: "Acme-list_my_issues", args: {} }, true],
    [{ kind: "mcp", server: "Acme", tool: "Acme-create_issues", args: {} }, false],
    [{ kind: "read", path: "C:\\Users\\me\\Documents\\GitHub\\Moonrise\\src\\a.ts" }, true],
    [{ kind: "read", path: "C:\\Users\\me\\Documents\\GitHub\\Moonrise\\..\\Other\\a.ts" }, false],
    [{ kind: "read", path: "C:\\Users\\me\\.copilot\\config.json" }, false],
    [{ kind: "write", path: "C:\\Users\\me\\Documents\\GitHub\\Moonrise\\a.ts" }, false],
    [{ kind: "shell", command: "git status", segments: ["git status"], possiblePaths: [], possibleUrls: [] }, false],
    [{ kind: "url", url: "https://example.com" }, false],
    [{ kind: "custom-tool", tool: "list_repos" }, true],
  ] as const)("%j → %s", (ask, approve) => {
    expect(policy.decide(ask).approve).toBe(approve);
  });
});
