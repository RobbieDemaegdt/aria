import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CopilotClient } from "@github/copilot-sdk";
import type { ChatItem } from "@aria/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONDUCTOR_BUILTINS,
  CopilotRuntime,
  copilotExtensionReadonlyPaths,
  FakeRuntime,
  AriaEngine,
  WORKER_BUILTINS,
  type WorkerEvent,
} from "../src/index.ts";
import { DEFAULT_RULES } from "../src/policy/defaults.ts";
import { decideWorker } from "../src/policy/worker.ts";
import { commitFile, makeRepo, waitMs } from "./helpers.ts";
import "./no-network.ts";

/** A task starting spawns git: about 1 s on an idle PC, vi.waitFor's own limit. */
const soon = { timeout: waitMs(5_000) };

const tempDirs: string[] = [];
const engines: AriaEngine[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aria-plugins-agents-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (engines.length > 0) {
    await engines.pop()!.stop();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("Built-in skill tool & read-only extension paths", () => {
  it("includes builtin:skill in both CONDUCTOR_BUILTINS and WORKER_BUILTINS", () => {
    expect(CONDUCTOR_BUILTINS).toContain("skill");
    expect(WORKER_BUILTINS).toContain("skill");
  });

  it("grants read-only access to Copilot plugin/skill/agent folders while keeping config.json and writes blocked", () => {
    const fakeHome = makeTempDir();
    const installedPlugins = path.join(fakeHome, ".copilot", "installed-plugins");
    const personalSkills = path.join(fakeHome, ".copilot", "skills");
    const customSkills = path.join(fakeHome, "my-custom-skills");
    mkdirSync(installedPlugins, { recursive: true });
    mkdirSync(personalSkills, { recursive: true });
    mkdirSync(customSkills, { recursive: true });
    writeFileSync(path.join(fakeHome, ".copilot", "config.json"), "{}");

    const roots = copilotExtensionReadonlyPaths([customSkills], fakeHome);
    expect(roots).toEqual(expect.arrayContaining([installedPlugins, personalSkills, customSkills]));
    expect(roots).not.toContain(path.join(fakeHome, ".copilot"));

    const worktree = "C:\\wt\\repo\\task";
    const ctx = {
      worktree,
      sandboxed: true,
      readonlyRoots: roots,
      readTools: new Set<string>(),
      rules: DEFAULT_RULES,
      grants: [],
    };

    // Reading a skill or plugin file inside readonlyRoots is auto-approved
    expect(
      decideWorker({ kind: "read", path: path.join(installedPlugins, "example", "SKILL.md") }, ctx).effect,
    ).toBe("auto");
    expect(
      decideWorker({ kind: "read", path: path.join(customSkills, "my-skill", "SKILL.md") }, ctx).effect,
    ).toBe("auto");

    // Writing to a skill or plugin directory is refused
    expect(
      decideWorker({ kind: "write", path: path.join(installedPlugins, "example", "SKILL.md") }, ctx).effect,
    ).toBe("never");

    // Reading ~/.copilot/config.json outside those subdirectories remains refused
    expect(
      decideWorker({ kind: "read", path: path.join(fakeHome, ".copilot", "config.json") }, ctx).effect,
    ).toBe("never");
  });
});

describe("CopilotRuntime: config discovery, skills, agent selection, and marketplace/plugin RPCs", () => {
  it("enables config discovery and skills, selects the requested agent on workers, and wraps marketplace/plugin RPCs", async () => {
    const createdConfigs: Array<Record<string, unknown>> = [];
    const session = {
      sessionId: "aria-session-1",
      rpc: {
        mcp: { list: vi.fn(async () => ({ servers: [] })) },
        tools: {
          initializeAndValidate: vi.fn(async () => ({})),
          getCurrentMetadata: vi.fn(async () => ({ tools: [{ name: "view" }, { name: "skill" }] })),
          updateSubagentSettings: vi.fn(async () => ({})),
        },
        options: { update: vi.fn(async () => ({ success: true })) },
        mode: { set: vi.fn(async () => ({})) },
        agent: {
          list: vi.fn(async () => ({
            agents: [
              {
                id: "example-connector:example-connector-orchestrator",
                name: "example-connector-orchestrator",
                displayName: "Example Connector Orchestrator",
                description: "Orchestrates example connector tasks.",
                source: "plugin",
                userInvocable: true,
                skills: ["example-connector-core"],
              },
            ],
          })),
          select: vi.fn(async () => ({})),
          deselect: vi.fn(async () => {}),
        },
        skills: {
          list: vi.fn(async () => ({
            skills: [
              {
                name: "example-connector-core",
                commandName: "example-connector-core",
                description: "Foundation skill for example connectors.",
                source: "plugin",
                pluginName: "example-connector",
                userInvocable: true,
                enabled: true,
              },
            ],
          })),
        },
      },
      disconnect: vi.fn(async () => {}),
    };

    const client = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => []),
      forceStop: vi.fn(async () => {}),
      getSessionMetadata: vi.fn(async () => undefined),
      createSession: vi.fn(async (cfg: Record<string, unknown>) => {
        createdConfigs.push(cfg);
        return session;
      }),
      resumeSession: vi.fn(async () => session),
      deleteSession: vi.fn(async () => {}),
      rpc: {
        plugins: {
          list: vi.fn(async () => ({
            plugins: [
              {
                name: "example-connector",
                marketplace: "example-agent-marketplace",
                version: "0.3.0",
                enabled: true,
              },
            ],
          })),
          install: vi.fn(async ({ source }: { source: string }) => ({
            plugin: {
              name: source.split("@")[0] ?? source,
              marketplace: source.split("@")[1] ?? "",
              version: "1.2.0",
              enabled: true,
            },
            skillsInstalled: 3,
            postInstallMessage: "Plugin ready.",
          })),
          uninstall: vi.fn(async () => {}),
          update: vi.fn(async () => ({ newVersion: "1.3.0" })),
          updateAll: vi.fn(async () => ({ results: [{ name: "example-connector", marketplace: "example", success: true }] })),
          enable: vi.fn(async () => {}),
          disable: vi.fn(async () => {}),
          marketplaces: {
            list: vi.fn(async () => ({
              marketplaces: [
                { name: "example-agent-marketplace", source: "GitHub: acme/marketplace", isDefault: false, available: true },
              ],
            })),
            add: vi.fn(async () => ({ name: "example-agent-marketplace" })),
            remove: vi.fn(async () => ({ removed: true })),
            browse: vi.fn(async () => ({
              plugins: [{ name: "example-connector", description: "Connector development suite" }],
            })),
            refresh: vi.fn(async () => ({ results: [] })),
          },
        },
        agents: {
          discover: vi.fn(async () => ({ agents: [] })),
        },
        skills: {
          discover: vi.fn(async () => ({ skills: [] })),
          config: {
            setSkillDisabled: vi.fn(async () => {}),
          },
        },
      },
    };

    const runtime = new CopilotRuntime(() => client as unknown as CopilotClient);
    await runtime.start();

    // 1. Inventory discovers marketplaces, plugins, agents, and skills with enableConfigDiscovery & enableSkills
    const inv = await runtime.inventory({
      sessionId: "inv-1",
      skillDirectories: ["C:\\skills"],
      agentDirectories: ["C:\\agents"],
      disabledSkills: ["disabled-skill"],
    });
    expect(createdConfigs[0]).toMatchObject({
      enableConfigDiscovery: true,
      enableSkills: true,
      skillDirectories: ["C:\\skills"],
      agentDirectories: ["C:\\agents"],
      disabledSkills: ["disabled-skill"],
    });
    expect(inv.marketplaces).toEqual([
      { name: "example-agent-marketplace", source: "GitHub: acme/marketplace", isDefault: false, available: true },
    ]);
    expect(inv.plugins).toEqual([
      { name: "example-connector", marketplace: "example-agent-marketplace", version: "0.3.0", enabled: true },
    ]);
    expect(inv.agents?.[0]).toMatchObject({
      id: "example-connector:example-connector-orchestrator",
      displayName: "Example Connector Orchestrator",
      source: "plugin",
    });
    expect(inv.skills?.[0]).toMatchObject({
      name: "example-connector-core",
      pluginName: "example-connector",
      enabled: true,
    });

    // 2. openWorker passes agent, enableConfigDiscovery, enableSkills, and calls session.rpc.agent.select
    const workerHandle = await runtime.openWorker({
      sessionId: "worker-1",
      name: "ARIA · Connector task",
      model: "claude-haiku-5.5",
      agent: "example-connector:example-connector-orchestrator",
      mode: "autopilot",
      workingDirectory: "C:\\wt\\repo\\task",
      availableTools: ["builtin:view", "builtin:skill"],
      disabledMcpServers: [],
      skillDirectories: ["C:\\skills"],
      agentDirectories: ["C:\\agents"],
      disabledSkills: ["disabled-skill"],
      policy: { decide: () => ({ approve: true }) },
      onQuestion: async () => ({ answer: "", wasFreeform: true }),
      onPlan: async () => ({ approved: true }),
      onEvent: () => {},
    });
    expect(createdConfigs[1]).toMatchObject({
      enableConfigDiscovery: true,
      enableSkills: true,
      agent: "example-connector:example-connector-orchestrator",
      skillDirectories: ["C:\\skills"],
      agentDirectories: ["C:\\agents"],
      disabledSkills: ["disabled-skill"],
    });
    expect(session.rpc.agent.select).toHaveBeenCalledWith({
      name: "example-connector:example-connector-orchestrator",
    });

    // Live agent switch & deselect on an open worker handle
    await workerHandle.setAgent?.("explore");
    expect(session.rpc.agent.select).toHaveBeenLastCalledWith({ name: "explore" });
    await workerHandle.setAgent?.(null);
    expect(session.rpc.agent.deselect).toHaveBeenCalledTimes(1);

    // 3. Marketplace, plugin, and skill RPC methods
    expect(await runtime.addMarketplace("acme/marketplace")).toEqual({
      name: "example-agent-marketplace",
    });
    expect(await runtime.browseMarketplace("example-agent-marketplace")).toEqual([
      { name: "example-connector", description: "Connector development suite" },
    ]);
    expect(await runtime.installPlugin("example-connector@example-agent-marketplace")).toMatchObject({
      plugin: { name: "example-connector", marketplace: "example-agent-marketplace", version: "1.2.0" },
      skillsInstalled: 3,
      postInstallMessage: "Plugin ready.",
    });
    await runtime.setPluginEnabled("example-connector@example-agent-marketplace", false);
    expect(client.rpc.plugins.disable).toHaveBeenCalled();
    await runtime.setSkillEnabled("example-connector-core", false);
    expect(client.rpc.skills.config.setSkillDisabled).toHaveBeenCalledWith({
      name: "example-connector-core",
      disabled: true,
    });

    await runtime.stop();
  });
});

describe("AriaEngine: marketplaces, plugins, agents, skills, and agent selection in profiles & tasks", () => {
  it("manages marketplaces, plugins, skills, and runs tasks with a selected or profile-bound agent", async () => {
    const dir = makeTempDir();
    const repoDir = makeRepo(dir, "Moonrise");
    commitFile(repoDir, "README.md", "# Moonrise\n", "Initial commit");

    const runtime = new FakeRuntime();
    const engine = new AriaEngine({
      dataDir: path.join(dir, "data"),
      runtime,
      projectRoots: [dir],
      worktreeRoot: path.join(dir, "wt"),
      taskSettleMs: 20,
    });
    engines.push(engine);
    await engine.start();

    // 1. Add a marketplace, browse it, and install a plugin
    const addedMp = await engine.addMarketplace({ source: "acme/example-marketplace" });
    expect(addedMp.name).toBe("example-marketplace");
    expect(addedMp.state.marketplaces?.some((m) => m.name === "example-marketplace")).toBe(true);

    const browsed = await engine.browseMarketplace({ name: "example-marketplace" });
    expect(browsed.plugins).toEqual([
      { name: "example-marketplace-agent", description: "Agent plugin from example-marketplace" },
    ]);

    const installed = await engine.installPlugin({ source: "example-connector@example-marketplace" });
    expect(installed.plugin.name).toBe("example-connector");
    expect(installed.state.plugins?.some((p) => p.name === "example-connector")).toBe(true);
    expect(
      installed.state.agents?.some((a) => a.id === "example-connector:example-connector-orchestrator"),
    ).toBe(true);
    expect(installed.state.skills?.some((s) => s.name === "example-connector-core" && s.enabled)).toBe(true);

    // 2. Toggle a skill off and back on
    const afterDisableSkill = await engine.setSkillEnabled({ name: "example-connector-core", enabled: false });
    expect(afterDisableSkill.disabledSkills).toContain("example-connector-core");
    expect(afterDisableSkill.skills?.find((s) => s.name === "example-connector-core")?.enabled).toBe(false);

    const afterEnableSkill = await engine.setSkillEnabled({ name: "example-connector-core", enabled: true });
    expect(afterEnableSkill.disabledSkills ?? []).not.toContain("example-connector-core");
    expect(afterEnableSkill.skills?.find((s) => s.name === "example-connector-core")?.enabled).toBe(true);

    // 3. Add custom skill and agent directories
    const customSkillDir = path.join(dir, "custom-skills");
    const customAgentDir = path.join(dir, "custom-agents");
    await engine.addSkillDirectory(customSkillDir);
    const withDirs = await engine.addAgentDirectory(customAgentDir);
    expect(withDirs.skillDirectories).toContain(customSkillDir);
    expect(withDirs.agentDirectories).toContain(customAgentDir);

    // 4. Bind an agent to a worker profile and verify tasks started with that profile inherit the agent
    const connectorProfile = await engine.saveProfile({
      name: "Connector",
      description: "example connector tasks",
      model: "fake-strong",
      reasoningEffort: "high",
      agent: "example-connector:example-connector-orchestrator",
      mode: "autopilot",
      budgetCredits: 25,
    });
    expect(connectorProfile.agent).toBe("example-connector:example-connector-orchestrator");

    const repo = engine.getState().projects[0]!;
    const taskFromProfile = await engine.startTask({
      repoId: repo.id,
      brief: "Add SNMP polling table",
      profileId: connectorProfile.id,
    });
    expect(taskFromProfile.agent).toBe("example-connector:example-connector-orchestrator");
    await vi.waitFor(() => expect(runtime.lastWorkerConfig?.agent).toBe("example-connector:example-connector-orchestrator"), soon);
    expect(runtime.lastWorkerConfig?.skillDirectories).toContain(customSkillDir);
    expect(runtime.lastWorkerConfig?.agentDirectories).toContain(customAgentDir);

    // 5. Override agent explicitly on startTask
    const taskWithExplicitAgent = await engine.startTask({
      repoId: repo.id,
      brief: "Audit catalog docs",
      profileId: connectorProfile.id,
      agent: "explore",
    });
    expect(taskWithExplicitAgent.agent).toBe("explore");

    // 6. Slash commands /agents and /skills list the discovered agents and skills in chat
    await engine.sendMessage("/agents example");
    const lastAgentReply = engine
      .getState()
      .timeline.filter((i): i is ChatItem => i.kind === "chat" && i.role === "assistant")
      .at(-1);
    expect(lastAgentReply?.content).toContain("example-connector:example-connector-orchestrator");

    await engine.sendMessage("/skills example");
    const lastSkillReply = engine
      .getState()
      .timeline.filter((i): i is ChatItem => i.kind === "chat" && i.role === "assistant")
      .at(-1);
    expect(lastSkillReply?.content).toContain("example-connector-core");

    // 7. Live agent switching on an existing session via setTaskAgent, /agents @task, and Conductor tools
    const switchedToPlugin = await engine.setTaskAgent(
      taskWithExplicitAgent.id,
      "example-connector:example-connector-orchestrator",
    );
    expect(switchedToPlugin.agent).toBe("example-connector:example-connector-orchestrator");
    expect(
      engine.getState().tasks.find((t) => t.id === taskWithExplicitAgent.id)?.agent,
    ).toBe("example-connector:example-connector-orchestrator");

    const clearedAgent = await engine.setTaskAgent(taskWithExplicitAgent.id, null);
    expect(clearedAgent.agent).toBeUndefined();

    // Switch via /agents @slug <agent> and /agents @slug default
    await engine.sendMessage(`/agents @${taskWithExplicitAgent.slug} explore`);
    expect(
      engine.getState().tasks.find((t) => t.id === taskWithExplicitAgent.id)?.agent,
    ).toBe("explore");

    await engine.sendMessage(`/agents @${taskWithExplicitAgent.slug} default`);
    expect(
      engine.getState().tasks.find((t) => t.id === taskWithExplicitAgent.id)?.agent,
    ).toBeUndefined();

    // Switch via Conductor set_task_agent and message_task tools
    runtime.replies.push({
      toolCalls: [
        {
          name: "set_task_agent",
          args: {
            task: taskWithExplicitAgent.id,
            agent: "example-connector:example-connector-orchestrator",
          },
        },
      ],
      text: "Switched the session agent.",
    });
    await engine.sendMessage("Switch the audit task to the connector orchestrator agent.");
    await vi.waitFor(() =>
      expect(
        engine.getState().tasks.find((t) => t.id === taskWithExplicitAgent.id)?.agent,
      ).toBe("example-connector:example-connector-orchestrator"),
      soon,
    );

    // 8. Proposal card agent override under "ask" profile policy
    await engine.setProfilePolicy("ask");
    runtime.replies.push({
      toolCalls: [
        {
          name: "start_task",
          args: {
            repo: "Moonrise",
            title: "Proposed connector review",
            brief: "Review the connector XML.",
            profile: "Connector",
            reason: "Needs connector profile.",
          },
        },
      ],
      text: "Proposed.",
    });
    await engine.sendMessage("Propose a connector review task.");
    const proposalCard = await vi.waitFor(() => {
      const found = engine
        .getState()
        .timeline.find((i) => i.kind === "card" && i.cardType === "profile_proposal");
      expect(found).toBeDefined();
      return found!;
    }, soon);
    const startedFromProposal = await engine.startProposal(proposalCard.id, connectorProfile.id, "explore");
    expect(startedFromProposal.agent).toBe("explore");
  });
});

/** An agent a plugin update renamed: the id the tasks still have, and what the runtime answers when asked for it. */
const RENAMED_AGENT = "example-connector:example-connector-orchestrator";
const agentNotFound = (agent: string) =>
  new Error(`Request session.create failed with message: session construction failed: Custom agent '${agent}' not found`);

describe("CopilotRuntime: a worker whose agent isn't installed anymore", () => {
  function sdkSession(sessionId: string, select: (name: string) => Promise<unknown> = async () => ({})) {
    return {
      sessionId,
      rpc: {
        options: { update: vi.fn(async () => ({ success: true })) },
        mode: { set: vi.fn(async () => ({})) },
        model: { setAllowedModels: vi.fn(async () => ({})) },
        agent: {
          list: vi.fn(async () => ({ agents: [] })),
          select: vi.fn(async ({ name }: { name: string }) => select(name)),
          deselect: vi.fn(async () => {}),
        },
        tools: { updateSubagentSettings: vi.fn(async () => ({})) },
      },
      send: vi.fn(async () => "msg-1"),
      getEvents: vi.fn(async () => []),
      abort: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
    };
  }

  function sdkClient(options: {
    exists: boolean;
    create?: (cfg: Record<string, unknown>) => Promise<unknown>;
    resume?: (id: string, cfg: Record<string, unknown>) => Promise<unknown>;
  }) {
    return {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => []),
      forceStop: vi.fn(async () => {}),
      getSessionMetadata: vi.fn(async (id: string) => (options.exists ? { id } : undefined)),
      createSession: vi.fn(options.create ?? (async (_cfg: Record<string, unknown>) => Promise.reject(new Error("no session to create")))),
      resumeSession: vi.fn(options.resume ?? (async (_id: string, _cfg: Record<string, unknown>) => Promise.reject(new Error("no session to resume")))),
      deleteSession: vi.fn(async () => {}),
    };
  }

  async function openWorker(client: ReturnType<typeof sdkClient>, sessionId: string) {
    const runtime = new CopilotRuntime(() => client as unknown as CopilotClient);
    await runtime.start();
    const events: WorkerEvent[] = [];
    try {
      const handle = await runtime.openWorker({
        sessionId,
        name: "ARIA · Chassis failure",
        model: "claude-haiku-5.5",
        agent: RENAMED_AGENT,
        mode: "autopilot",
        workingDirectory: "C:\\wt\\repo\\task",
        availableTools: [],
        disabledMcpServers: [],
        policy: { decide: () => ({ approve: true }) },
        onQuestion: async () => ({ answer: "", wasFreeform: true }),
        onPlan: async () => ({ approved: true }),
        onEvent: (event) => events.push(event),
      });
      return { handle, events };
    } catch (error) {
      return { error: error as Error, events };
    } finally {
      await runtime.stop();
    }
  }

  it("creates the session as the default coding agent and says which agent it dropped", async () => {
    const session = sdkSession("worker-new");
    const client = sdkClient({
      exists: false,
      create: async (cfg) => (cfg.agent ? Promise.reject(agentNotFound(String(cfg.agent))) : session),
    });

    const { handle, events } = await openWorker(client, "worker-new");

    expect(handle?.resumed).toBe(false);
    expect(client.createSession).toHaveBeenCalledTimes(2);
    expect(client.createSession.mock.calls[0]![0]).toMatchObject({ agent: RENAMED_AGENT, sessionId: "worker-new" });
    expect(client.createSession.mock.calls[1]![0]).not.toHaveProperty("agent");
    expect(client.createSession.mock.calls[1]![0]).toMatchObject({ sessionId: "worker-new" });
    expect(events).toContainEqual({ type: "agent_missing", agent: RENAMED_AGENT });
    expect(session.rpc.agent.select).not.toHaveBeenCalled();
  });

  it("resumes the same session without the agent instead of deleting its history", async () => {
    const session = sdkSession("worker-old");
    const client = sdkClient({
      exists: true,
      resume: async (_id, cfg) => (cfg.agent ? Promise.reject(agentNotFound(String(cfg.agent))) : session),
    });

    const { handle, events } = await openWorker(client, "worker-old");

    expect(handle?.resumed).toBe(true);
    expect(client.resumeSession).toHaveBeenCalledTimes(2);
    expect(client.resumeSession.mock.calls[1]![1]).not.toHaveProperty("agent");
    expect(client.deleteSession).not.toHaveBeenCalled();
    expect(client.createSession).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: "agent_missing", agent: RENAMED_AGENT });
    expect(events.some((e) => e.type === "warning" && e.warningType === "resume_failed")).toBe(false);
    // It may still have run as that agent before: back to the default.
    expect(session.rpc.agent.deselect).toHaveBeenCalledTimes(1);
  });

  it("drops the agent when the session opens but can't select it", async () => {
    const session = sdkSession("worker-select", async (name) => Promise.reject(agentNotFound(name)));
    const client = sdkClient({ exists: true, resume: async () => session });

    const { handle, events } = await openWorker(client, "worker-select");

    expect(handle?.resumed).toBe(true);
    expect(session.rpc.agent.select).toHaveBeenCalledWith({ name: RENAMED_AGENT });
    expect(events).toContainEqual({ type: "agent_missing", agent: RENAMED_AGENT });
    expect(events.some((e) => e.type === "warning" && e.message.includes("Couldn't select agent"))).toBe(false);
    expect(session.rpc.agent.deselect).toHaveBeenCalledTimes(1);
  });

  it("still fails when the agent is installed but doesn't load, or another agent is missing", async () => {
    for (const failure of [
      new Error(`Custom agent '${RENAMED_AGENT}' failed to load: invalid front matter`),
      agentNotFound("some-other-agent"),
    ]) {
      const client = sdkClient({ exists: false, create: async () => Promise.reject(failure) });

      const { error, events } = await openWorker(client, "worker-broken");

      expect(error?.message).toBe(failure.message);
      expect(client.createSession).toHaveBeenCalledTimes(1);
      expect(events.some((e) => e.type === "agent_missing")).toBe(false);
    }
  });
});

describe("AriaEngine: a task whose agent isn't installed anymore", () => {
  async function setup() {
    const dir = makeTempDir();
    const repoDir = makeRepo(dir, "Moonrise");
    commitFile(repoDir, "README.md", "# Moonrise\n", "Initial commit");
    const runtime = new FakeRuntime();
    const engine = new AriaEngine({
      dataDir: path.join(dir, "data"),
      runtime,
      projectRoots: [dir],
      worktreeRoot: path.join(dir, "wt"),
      taskSettleMs: 20,
    });
    engines.push(engine);
    await engine.start();
    const repoId = engine.getState().projects[0]!.id;
    const task = (id: string) => engine.getState().tasks.find((t) => t.id === id);
    const agentNotices = () => engine.getState().timeline.filter((i) => i.kind === "notice" && i.cause === "agent_missing");
    return { runtime, engine, repoId, task, agentNotices };
  }

  it("runs a rerun that copied the agent as the default coding agent, forgets the agent and says so once", async () => {
    const { runtime, engine, repoId, task, agentNotices } = await setup();

    // It failed to start before the plugin renamed its agent, so it still has the old id.
    runtime.failWorkerOpens = 1;
    const failed = await engine.startTask({ repoId, brief: "Investigate the chassis failure", agent: RENAMED_AGENT });
    await vi.waitFor(() => expect(task(failed.id)?.state).toBe("failed"), { timeout: 10_000 });
    expect(task(failed.id)?.agent).toBe(RENAMED_AGENT);

    runtime.workerMissingAgents.add(RENAMED_AGENT);
    const rerun = await engine.startTask({ repoId, brief: "Investigate the chassis failure", rerunOf: failed.id });
    expect(rerun.agent).toBe(RENAMED_AGENT);

    await vi.waitFor(() => expect(runtime.workers.get(`aria-task-${rerun.id}`)?.prompts.length).toBe(1), { timeout: 10_000 });
    expect(runtime.workers.get(`aria-task-${rerun.id}`)?.promptAgents).toEqual([undefined]);
    expect(task(rerun.id)?.agent).toBeUndefined();
    expect(task(rerun.id)?.state).not.toBe("failed");
    expect(agentNotices()).toHaveLength(1);
    const notice = agentNotices()[0]!;
    expect(notice.kind === "notice" ? notice.message : "").toContain(RENAMED_AGENT);
    expect(notice.kind === "notice" ? notice.message : "").toContain(`/agents @${task(rerun.id)!.slug}`);
  });

  it("keeps an agent you picked while the session was opening, without a notice", async () => {
    const { runtime, engine, repoId, task, agentNotices } = await setup();
    runtime.workerMissingAgents.add(RENAMED_AGENT);
    let open!: () => void;
    runtime.workerOpenGate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const started = await engine.startTask({ repoId, brief: "Investigate the chassis failure", agent: RENAMED_AGENT });
    await vi.waitFor(() => expect(runtime.workerOpens).toBe(1), { timeout: 10_000 });
    await engine.setTaskAgent(started.id, "explore");
    open();

    await vi.waitFor(() => expect(runtime.workers.get(`aria-task-${started.id}`)?.prompts.length).toBe(1), { timeout: 10_000 });
    expect(runtime.workers.get(`aria-task-${started.id}`)?.promptAgents).toEqual(["explore"]);
    expect(task(started.id)?.agent).toBe("explore");
    expect(agentNotices()).toHaveLength(0);
  });
});
