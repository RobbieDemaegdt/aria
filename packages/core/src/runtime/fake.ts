/**
 * Scripted AgentRuntime for tests: no Copilot runtime, no model calls. Each `send` plays the next scripted reply:
 * optional calls to ARIA's own tools (through the real handlers and policy), streamed deltas, the final message, idle.
 */
import type {
  InstalledPluginItem,
  MarketplaceCatalogPlugin,
  TranscriptEntry,
} from "@aria/protocol";
import { checkExactPayload } from "../integrations/actions.ts";
import type { McpServerTransport, RuntimeMcpServerConfig } from "../integrations/config.ts";
import type { DirectMcpTestResult } from "../integrations/mcp-client.ts";
import { sanitizeInputSchema, untrusted } from "../integrations/rules.ts";
import { serverWirePrefix, type ToolEntry } from "../integrations/scope.ts";
import { openFakeWorker, type FakeWorkerScript, type FakeWorkerSession } from "./fake-worker.ts";
import type {
  AgentRuntime,
  ConductorConfig,
  ConductorHandle,
  McpActionOutcome,
  McpActionRequest,
  PermissionVerdict,
  RuntimeEvent,
  RuntimeFallback,
  RuntimeModel,
  SignInOutcome,
  SignInStart,
  TimekeeperSessionRequest,
  TimekeeperSessionResult,
  ToolInventory,
  UtilitySummaryRequest,
  UtilitySummaryResult,
  WorkerConfig,
  WorkerHandle,
} from "./types.ts";

export type { FakeWorkerScript, FakeWorkerStep, FakeWorkerSession } from "./fake-worker.ts";

export interface FakeReply {
  /** Arguments can be computed from the prompt (e.g. a short id from the <pending> digest). */
  /**
   * `server`: an MCP tool of that server (its wire name in `name`): the call needs the tool in the session's
   * `availableTools` and the policy's approval, like the runtime's, and returns `mcpResults[name]`.
   */
  toolCalls?: Array<{ name: string; args: unknown | ((prompt: string) => unknown); server?: string }>;
  text: string | ((prompt: string, toolResults: unknown[]) => string);
  /** Emit a session error instead of answering. */
  error?: string;
  /**
   * Milliseconds between the reply's streamed chunks, like a model's (none: all at once). For measuring the chat: an
   * abort doesn't cut the wait short.
   */
  chunkMs?: number;
}

export interface FakeSession {
  config: ConductorConfig;
  prompts: string[];
  model: string;
  reasoningEffort?: string;
  /** What the inspector reads (kept across a resume, like the runtime's session store). */
  transcript: Map<string, TranscriptEntry>;
  /** A message the runtime adds to the conversation itself (e.g. `source: "system"`), shown live and in the history. */
  inject: (entry: TranscriptEntry) => void;
}

export class FakeRuntime implements AgentRuntime {
  started = false;
  /** What start() was given (the runtime's temp folder). */
  startOptions: { tempDir?: string } | undefined;
  /** Whether the fake PC can run the sandbox (D20); like this PC, it can unless a test says otherwise. */
  sandboxSupported = true;
  readonly sessions = new Map<string, FakeSession>();
  models: RuntimeModel[] = [
    { id: "fake-light", name: "Fake Light", category: "lightweight", priceCategory: "low", inputPrice: 10, outputPrice: 50, efforts: ["low", "medium", "high"], enabled: true },
    { id: "fake-strong", name: "Fake Strong", category: "powerful", priceCategory: "high", inputPrice: 400, outputPrice: 2000, efforts: ["low", "medium", "high", "xhigh"], enabled: true },
    { id: "fake-off", name: "Fake Disabled", category: "powerful", priceCategory: "very_high", efforts: [], enabled: false },
  ];
  inventoryResult: ToolInventory = {
    tools: [{ name: "view" }, { name: "glob" }, { name: "grep" }, { name: "powershell" }, { name: "Svc-get_items" }, { name: "Svc-create_item" }],
    servers: [{ name: "Svc", status: "connected", url: "https://svc.example/mcp" }],
    marketplaces: [
      { name: "copilot-plugins", source: "GitHub: github/copilot-plugins", isDefault: true, available: true },
    ],
    plugins: [],
    agents: [
      {
        id: "explore",
        name: "explore",
        displayName: "Explore",
        description: "Fast read-only codebase exploration agent.",
        source: "builtin",
        userInvocable: true,
      },
    ],
    skills: [
      {
        name: "customize-cloud-agent",
        commandName: "customize-cloud-agent",
        description: "Customize cloud agent instructions and setup.",
        source: "builtin",
        userInvocable: true,
        enabled: true,
      },
    ],
  };
  /** Catalog plugins advertised by each marketplace in `browseMarketplace(name)`. */
  marketplaceCatalogs: Record<string, MarketplaceCatalogPlugin[]> = {
    "copilot-plugins": [
      { name: "workiq", description: "Microsoft 365 Work IQ MCP server & skills" },
    ],
  };
  /** What each inventory was asked for (its helper session's id, mcpServers, pluginDirectories, skillDirectories, agentDirectories, disabledSkills). */
  inventoryCalls: Array<{
    sessionId?: string;
    mcpServers?: Record<string, RuntimeMcpServerConfig>;
    pluginDirectories?: string[];
    skillDirectories?: string[];
    agentDirectories?: string[];
    disabledSkills?: string[];
    projectPaths?: string[];
    disabledMcpServers?: string[];
  }> = [];
  /** Optional CLI MCP config returned by `readCliMcpConfig()` when testing `importCliMcp`. */
  cliMcpConfig:
    | {
        servers?: Array<{
          name: string;
          displayName?: string;
          transport?: McpServerTransport;
          url?: string;
          command?: string;
          args?: string[];
          cwd?: string;
          env?: Record<string, string>;
          headers?: Record<string, string>;
          enabled?: boolean;
          sourcePlugin?: string;
        }>;
        pluginDirectories?: string[];
      }
    | undefined;
  /**
   * Sign-in per server: how long it takes to start (the real runtime loads the session's servers first), the page to
   * open (none: a stored token works), how it ends (`waits`: only on cancel or time-out), after how long, and the tools
   * the server lists once connected. Without one: a page, then connected after 50 ms.
   */
  signInScripts = new Map<string, { startMs?: number; url?: string; outcome?: SignInOutcome["status"] | "waits"; error?: string; afterMs?: number; tools?: ToolEntry[] }>();
  signInCalls: Array<{ serverName: string; sessionId: string; installationId?: string }> = [];
  /** Sessions deleted (helpers included), in order. */
  deletedSessions: string[] = [];
  /** What an MCP tool call in a scripted reply returns, by wire name. */
  mcpResults: Record<string, unknown> = {};
  /** Recorded calls that passed the exact-payload check in `runMcpAction`. */
  actionCalls: Array<{ sessionId: string; server: string; tool: string; wireName: string; args: Record<string, unknown>; model: string; reasoningEffort?: string }> = [];
  /** Recorded Timekeeper session runs (Phase 5C). */
  timekeeperCalls: Array<{
    sessionId: string;
    model: string;
    reasoningEffort?: string;
    availableTools: string[];
    disabledMcpServers: string[];
    mcpServers?: Record<string, RuntimeMcpServerConfig>;
    pluginDirectories?: string[];
    prompt: string;
  }> = [];
  /** Recorded Utility summary session runs (Phase 6B). */
  utilityCalls: Array<{ sessionId: string; model: string; reasoningEffort?: string; prompt: string }> = [];
  /** Optional scripted handler for `runUtilitySummary` in tests and E2E specs. */
  utilityHandler:
    | ((request: UtilitySummaryRequest) => Promise<UtilitySummaryResult> | UtilitySummaryResult)
    | undefined;
  /** Optional scripted handler for `runTimekeeper` in tests and E2E specs. */
  timekeeperHandler:
    | ((request: TimekeeperSessionRequest) => Promise<{
        mcpCalls?: Array<{ server: string; wireName: string; args?: Record<string, unknown>; result: unknown }>;
        proposal?: unknown;
        error?: string;
      }> | {
        mcpCalls?: Array<{ server: string; wireName: string; args?: Record<string, unknown>; result: unknown }>;
        proposal?: unknown;
        error?: string;
      })
    | undefined;
  /**
   * Optional per-call behavior in `runMcpAction`: can tamper with the arguments the fake model sends, try calling the
   * tool twice, skip calling the tool, wait on a gate, or return a server failure/result.
   */
  actionHandler:
    | ((request: McpActionRequest) => Promise<{
        sentArgs?: unknown;
        sentTool?: string;
        sentServer?: string;
        callCount?: number;
        serverError?: string;
        result?: unknown;
      }> | {
        sentArgs?: unknown;
        sentTool?: string;
        sentServer?: string;
        callCount?: number;
        serverError?: string;
        result?: unknown;
      })
    | undefined;
  /** Consumed in order; when empty, the fake model echoes the prompt. */
  replies: FakeReply[] = [];
  /** Picks a reply by the prompt (checked before the queue); for scripted UI runs where the test can't push replies. */
  replyFor: ((prompt: string) => FakeReply | undefined) | undefined;
  /** Emitted shortly after a session is resumed (e.g. an interrupted_tools warning). */
  resumeEvents: RuntimeEvent[] = [];
  /** Emitted once, on the next openConductor attempt, before it fails or returns (e.g. a model_change). */
  openEvents: RuntimeEvent[] = [];
  /** When set, a model switch runs this model instead and reports it, like the runtime's silent substitution. */
  substituteModel: string | undefined;
  /** How many of the next start calls fail (simulates a Copilot CLI that's missing or signed out). */
  failStarts = 0;
  /** When set, the runtime starts on its bundled runtime instead of the CLI it found first, and says why. */
  fallback: RuntimeFallback | undefined;
  /** How many of the next openConductor calls fail (simulates a damaged session, or a runtime that can't open any). */
  failOpens = 0;
  /** Make the next model switch fail (e.g. the runtime rejects the model). */
  failNextSetModel = false;
  /** Delay before a model switch takes effect, to overlap switches in tests. */
  setModelDelayMs = 0;
  /** Worker sessions by id (they survive a disconnect, like the runtime's session store). */
  readonly workers = new Map<string, FakeWorkerSession>();
  /** Played by worker sends, in order; when empty, the worker echoes the prompt. */
  workerScripts: FakeWorkerScript[] = [];
  /** Picks a script by what the worker was told (checked before the queue); for scenarios where tasks overlap. */
  workerScriptFor: ((prompt: string) => FakeWorkerScript | undefined) | undefined;
  /** How many of the next openWorker calls fail. */
  failWorkerOpens = 0;
  /** Worker session IDs whose stored session is corrupted on resume (simulating SDK session file recovery, Phase 9). */
  corruptedWorkerSessions = new Set<string>();
  /** Delay before openWorker returns (to cancel a task while it starts). */
  workerOpenDelayMs = 0;
  /** Awaited by openWorker before the session exists (to act while a task is starting). */
  workerOpenGate: Promise<void> | undefined;
  /** How many times openWorker was called (it counts as soon as it starts, before any gate). */
  workerOpens = 0;
  /** What the last openWorker call got (its sandbox, mode, …). */
  lastWorkerConfig: WorkerConfig | undefined;
  /** All WorkerConfigs passed to openWorker in order. */
  workerConfigs: WorkerConfig[] = [];
  /** Phase 8A: Optional delay before `session.start` (`producer: "copilot-agent"`) resolves on a new cloud worker. */
  cloudStartDelayMs = 0;
  /** Phase 8A: When true, simulates a cloud session where `session.start` never arrives so the timeout triggers. */
  cloudStartTimeout = false;
  /** Phase 8A: When set, emits `{ type: "warning", warningType: "policy_blocked", message }` on cloud workers. */
  cloudPolicyBlocked: string | undefined;
  /** Phase 8A: Custom URL generator for `remote_info` on cloud/remote workers. */
  missionControlUrlFor: ((sessionId: string, config: WorkerConfig) => string | undefined) | undefined;
  /** Awaited before a worker send is accepted (to act while a message is on its way). */
  workerSendGate: ((text: string) => Promise<void> | undefined) | undefined;
  /** Awaited before a worker's model switch takes effect (to act while one is on its way). */
  workerSetModelGate: (() => Promise<void> | undefined) | undefined;
  /** When set, a worker's model switch runs this model instead and reports it with a cause (D15). */
  workerSubstituteModel: string | undefined;
  /** When it returns true for a model, a worker's switch to it fails. */
  workerFailSetModel: ((model: string) => boolean) | undefined;
  /** When it returns true for an agent, a worker's switch to it fails. */
  workerFailSetAgent: ((agent: string | null) => boolean) | undefined;
  /** Agents a worker is opened with that aren't installed: like the runtime, it says so and runs as the default. */
  workerMissingAgents = new Set<string>();
  /** A worker's mode switch fails. */
  workerFailSetMode = false;
  /** Deleting a session fails. */
  failDeleteSession = false;
  /** Awaited before a worker's abort takes effect (to act while one is on its way). */
  workerAbortGate: (() => Promise<void> | undefined) | undefined;
  /** Worker and Conductor sessions never finish disconnecting (a runtime that stopped answering). */
  hangDisconnects = false;
  /** Awaited before a Conductor session finishes disconnecting (a detach that takes a while). */
  conductorDisconnectGate: Promise<void> | undefined;
  /** How many times openConductor was called. */
  conductorOpens = 0;
  /** Awaited by openConductor before the session exists (to act while the conversation is opening). */
  conductorOpenGate: Promise<void> | undefined;
  /** How many times a Conductor's history was read (the inspector reads it once per opening). */
  conductorTranscriptReads = 0;
  /** Awaited by a Conductor's history read after it took its copy (a slow read: live entries can come meanwhile). */
  conductorTranscriptGate: Promise<void> | undefined;
  /** Make the next Conductor send fail (the message never reaches the session). */
  failNextSend = false;
  /** What the session records of a prompt you sent (the real runtime might not keep it exactly). */
  recordedPrompt: ((prompt: string) => string) | undefined;

  async openWorker(config: WorkerConfig): Promise<WorkerHandle> {
    this.workerOpens++;
    this.lastWorkerConfig = config;
    this.workerConfigs.push(config);
    if (this.workerOpenDelayMs) await new Promise((resolve) => setTimeout(resolve, this.workerOpenDelayMs));
    if (this.workerOpenGate) await this.workerOpenGate;
    if (this.failWorkerOpens > 0) {
      this.failWorkerOpens--;
      throw new Error("fake: could not open the worker session");
    }
    let existing = this.workers.get(config.sessionId);
    if (existing && this.corruptedWorkerSessions.has(config.sessionId)) {
      this.corruptedWorkerSessions.delete(config.sessionId);
      this.workers.delete(config.sessionId);
      this.deletedSessions.push(config.sessionId);
      existing = undefined;
      config.onEvent({
        type: "warning",
        warningType: "resume_failed",
        message: `Couldn't resume worker session ${config.sessionId} (corrupted session file); starting a fresh session.`,
      });
    }
    let opening = config;
    if (config.agent && this.workerMissingAgents.has(config.agent)) {
      config.onEvent({ type: "agent_missing", agent: config.agent });
      const { agent: _missing, ...withoutAgent } = config;
      opening = withoutAgent;
    }
    return openFakeWorker({
      config: opening,
      existing,
      nextScript: (prompt) => this.workerScriptFor?.(prompt) ?? this.workerScripts.shift(),
      register: (session) => this.workers.set(config.sessionId, session),
      beforeSend: (text) => this.workerSendGate?.(text),
      beforeSetModel: () => this.workerSetModelGate?.(),
      failSetModel: (model) => this.workerFailSetModel?.(model) ?? false,
      failSetAgent: (agent) => this.workerFailSetAgent?.(agent) ?? false,
      failSetMode: () => this.workerFailSetMode,
      beforeAbort: () => this.workerAbortGate?.(),
      substituteModel: () => this.workerSubstituteModel,
      hangDisconnect: () => this.hangDisconnects,
      cloudStartDelayMs: () => this.cloudStartDelayMs,
      cloudStartTimeout: () => this.cloudStartTimeout,
      cloudPolicyBlocked: () => this.cloudPolicyBlocked,
      missionControlUrlFor: (sessionId, cfg) =>
        this.missionControlUrlFor ? this.missionControlUrlFor(sessionId, cfg) : `https://github.com/copilot/tasks/${encodeURIComponent(sessionId)}`,
    });
  }

  async start(options: { tempDir?: string } = {}): Promise<void> {
    if (this.failStarts > 0) {
      this.failStarts--;
      throw new Error("fake: Copilot CLI isn't signed in");
    }
    this.startOptions = options;
    this.started = true;
  }

  runtimeFallback(): RuntimeFallback | undefined {
    return this.started ? this.fallback : undefined;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  /** A test that sets `started` to false has the runtime end on its own. */
  async isAlive(): Promise<boolean> {
    return this.started;
  }

  async sandboxSupport(): Promise<{ supported: boolean; reason?: string }> {
    return this.sandboxSupported ? { supported: true } : { supported: false, reason: "fake: this PC has no sandbox" };
  }

  async listModels(): Promise<RuntimeModel[]> {
    return this.models;
  }

  async inventory(
    options: {
      sessionId?: string;
      mcpServers?: Record<string, RuntimeMcpServerConfig>;
      pluginDirectories?: string[];
      skillDirectories?: string[];
      agentDirectories?: string[];
      disabledSkills?: string[];
      projectPaths?: string[];
      disabledMcpServers?: string[];
    } = {},
  ): Promise<ToolInventory> {
    this.inventoryCalls.push({
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.mcpServers ? { mcpServers: structuredClone(options.mcpServers) } : {}),
      ...(options.pluginDirectories ? { pluginDirectories: [...options.pluginDirectories] } : {}),
      ...(options.skillDirectories ? { skillDirectories: [...options.skillDirectories] } : {}),
      ...(options.agentDirectories ? { agentDirectories: [...options.agentDirectories] } : {}),
      ...(options.disabledSkills ? { disabledSkills: [...options.disabledSkills] } : {}),
      ...(options.projectPaths ? { projectPaths: [...options.projectPaths] } : {}),
      ...(options.disabledMcpServers ? { disabledMcpServers: [...options.disabledMcpServers] } : {}),
    });
    if (options.sessionId) this.deletedSessions.push(options.sessionId);
    const disabledSet = new Set(options.disabledSkills ?? []);
    const cloned = structuredClone(this.inventoryResult);
    if (cloned.skills) {
      cloned.skills = cloned.skills.map((s) => ({
        ...s,
        enabled: s.enabled !== false && !disabledSet.has(s.name),
      }));
    }
    return cloned;
  }

  async addMarketplace(source: string): Promise<{ name: string }> {
    const clean = source.trim();
    const slug = clean.split(/[/:\\#]/).filter(Boolean).at(-1)?.replace(/\.git$/i, "") || "custom-marketplace";
    const list = this.inventoryResult.marketplaces ?? [];
    const existing = list.find((m) => m.name === slug);
    if (!existing) {
      list.push({ name: slug, source: clean, isDefault: false, available: true });
      this.inventoryResult.marketplaces = list;
    }
    if (!this.marketplaceCatalogs[slug]) {
      this.marketplaceCatalogs[slug] = [
        { name: `${slug}-agent`, description: `Agent plugin from ${slug}` },
      ];
    }
    return { name: slug };
  }

  async removeMarketplace(name: string, force?: boolean): Promise<{ removed: boolean; dependentPlugins?: string[] }> {
    const target = name.trim();
    const mp = (this.inventoryResult.marketplaces ?? []).find((m) => m.name === target);
    if (!mp) throw new Error(`Marketplace "${target}" is not registered.`);
    if (mp.isDefault) throw new Error(`Default marketplace "${target}" cannot be removed.`);
    const deps = (this.inventoryResult.plugins ?? []).filter((p) => p.marketplace === target).map((p) => p.name);
    if (deps.length > 0 && !force) {
      return { removed: false, dependentPlugins: deps };
    }
    if (force && deps.length > 0) {
      this.inventoryResult.plugins = (this.inventoryResult.plugins ?? []).filter((p) => p.marketplace !== target);
    }
    this.inventoryResult.marketplaces = (this.inventoryResult.marketplaces ?? []).filter((m) => m.name !== target);
    return { removed: true };
  }

  async browseMarketplace(name: string): Promise<MarketplaceCatalogPlugin[]> {
    const target = name.trim();
    const mp = (this.inventoryResult.marketplaces ?? []).find((m) => m.name === target);
    if (!mp) throw new Error(`Marketplace "${target}" is not registered.`);
    return structuredClone(this.marketplaceCatalogs[target] ?? []);
  }

  async refreshMarketplaces(_name?: string): Promise<void> {
    // Nothing to refresh: the catalogs are the test's.
  }

  async installPlugin(source: string): Promise<{
    plugin: InstalledPluginItem;
    skillsInstalled: number;
    postInstallMessage?: string;
    deprecationWarning?: string;
  }> {
    const clean = source.trim();
    let pluginName = clean;
    let marketplace = "";
    if (clean.includes("@") && !clean.startsWith("git@")) {
      const at = clean.lastIndexOf("@");
      pluginName = clean.slice(0, at).trim();
      marketplace = clean.slice(at + 1).trim();
    } else {
      pluginName = clean.split(/[/:\\]/).filter(Boolean).at(-1)?.replace(/\.git$/i, "") || clean;
    }
    const item: InstalledPluginItem = {
      name: pluginName,
      marketplace,
      version: "1.0.0",
      enabled: true,
      installed: true,
    };
    const list = this.inventoryResult.plugins ?? [];
    const idx = list.findIndex((p) => p.name === pluginName && p.marketplace === marketplace);
    if (idx >= 0) list[idx] = item;
    else list.push(item);
    this.inventoryResult.plugins = list;

    // Contribute a discovered agent and skill from the installed plugin for realistic testing
    const agents = this.inventoryResult.agents ?? [];
    const agentId = `${pluginName}:${pluginName}-orchestrator`;
    if (!agents.some((a) => a.id === agentId)) {
      agents.push({
        id: agentId,
        name: `${pluginName}-orchestrator`,
        displayName: `${pluginName} Orchestrator`,
        description: `Specialist agent from plugin ${pluginName}.`,
        source: "plugin",
        userInvocable: true,
        skills: [`${pluginName}-core`],
      });
      this.inventoryResult.agents = agents;
    }
    const skills = this.inventoryResult.skills ?? [];
    const skillName = `${pluginName}-core`;
    if (!skills.some((s) => s.name === skillName)) {
      skills.push({
        name: skillName,
        commandName: skillName,
        description: `Core skill contributed by ${pluginName}.`,
        source: "plugin",
        pluginName,
        userInvocable: true,
        enabled: true,
      });
      this.inventoryResult.skills = skills;
    }
    return {
      plugin: structuredClone(item),
      skillsInstalled: 1,
    };
  }

  async uninstallPlugin(name: string, directSourceId?: string): Promise<void> {
    const clean = name.trim();
    const at = clean.includes("@") ? clean.lastIndexOf("@") : -1;
    const targetName = at > 0 ? clean.slice(0, at).trim() : clean;
    const targetMp = at > 0 ? clean.slice(at + 1).trim() : undefined;
    this.inventoryResult.plugins = (this.inventoryResult.plugins ?? []).filter((p) => {
      if (directSourceId && p.directSourceId === directSourceId) return false;
      if (targetMp !== undefined) return !(p.name === targetName && p.marketplace === targetMp);
      return p.name !== targetName;
    });
  }

  async updatePlugin(name?: string): Promise<{ updatedCount: number; message?: string }> {
    const list = this.inventoryResult.plugins ?? [];
    if (name && name.trim()) {
      const target = list.find((p) => p.name === name.trim() || `${p.name}@${p.marketplace}` === name.trim());
      if (target) target.version = "1.0.1";
      return { updatedCount: target ? 1 : 0, message: target ? `Updated ${target.name} to 1.0.1.` : `Plugin "${name}" not found.` };
    }
    for (const p of list) p.version = "1.0.1";
    return { updatedCount: list.length, message: list.length > 0 ? `Updated ${list.length} plugin${list.length === 1 ? "" : "s"}.` : "All plugins are up to date." };
  }

  async setPluginEnabled(name: string, enabled: boolean): Promise<void> {
    const clean = name.trim();
    const at = clean.includes("@") ? clean.lastIndexOf("@") : -1;
    const targetName = at > 0 ? clean.slice(0, at).trim() : clean;
    const targetMp = at > 0 ? clean.slice(at + 1).trim() : undefined;
    for (const p of this.inventoryResult.plugins ?? []) {
      if (targetMp !== undefined ? p.name === targetName && p.marketplace === targetMp : p.name === targetName) {
        p.enabled = enabled;
      }
    }
  }

  async setSkillEnabled(name: string, enabled: boolean): Promise<void> {
    const target = name.trim();
    for (const s of this.inventoryResult.skills ?? []) {
      if (s.name === target) s.enabled = enabled;
    }
  }

  async readCliMcpConfig() {
    if (this.cliMcpConfig) return structuredClone(this.cliMcpConfig);
    const servers = this.inventoryResult.servers
      .filter((s) => s.source === "user" && s.url)
      .map((s) => ({
        name: s.name,
        ...(s.displayName ? { displayName: s.displayName } : {}),
        transport: "http" as const,
        url: s.url!,
        enabled: s.status !== "disabled",
      }));
    return { ...(servers.length > 0 ? { servers } : {}) };
  }

  async callMcpToolDirect(request: {
    server: string;
    tool: string;
    wireName: string;
    approvedArgs: Record<string, unknown>;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<McpActionOutcome> {
    if (request.signal?.aborted) return { ok: false, error: "The action was cancelled.", blocked: true };
    const syntheticReq: McpActionRequest = {
      sessionId: "direct-mcp",
      model: "none",
      server: request.server,
      tool: request.tool,
      wireName: request.wireName,
      disabledMcpServers: [],
      approvedArgs: request.approvedArgs,
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    };
    const script = (await this.actionHandler?.(syntheticReq)) ?? {};
    if (request.signal?.aborted) return { ok: false, error: "The action was cancelled." };
    const count = script.callCount ?? 1;
    if (count === 0) {
      return { ok: false, error: "The session finished without calling the approved tool.", blocked: true };
    }
    const sentServer = script.sentServer ?? request.server;
    const sentTool = script.sentTool ?? request.wireName;
    const sentArgs = "sentArgs" in script ? script.sentArgs : structuredClone(request.approvedArgs);

    let attempts = 0;
    let rejectedReason: string | undefined;
    for (let i = 0; i < count; i++) {
      attempts++;
      if (attempts > 1) {
        rejectedReason ??= "only one tool call was approved for this action";
        break;
      }
      if (sentServer !== request.server || (sentTool !== request.wireName && sentTool !== request.tool)) {
        rejectedReason ??= `only ${request.wireName} on ${request.server} was approved`;
        break;
      }
      const check = checkExactPayload(sentArgs, request.approvedArgs);
      if (!check.ok) {
        rejectedReason ??= check.reason;
        break;
      }
    }
    if (rejectedReason !== undefined) {
      return { ok: false, error: `Blocked by ARIA's exact-payload check: ${rejectedReason}.`, blocked: true };
    }
    this.actionCalls.push({
      sessionId: "direct-mcp",
      server: request.server,
      tool: request.tool,
      wireName: request.wireName,
      args: structuredClone(request.approvedArgs),
      model: "none",
    });
    if (script.serverError) {
      return { ok: false, error: script.serverError };
    }
    const raw = script.result ?? this.mcpResults[request.wireName] ?? { ok: true, tool: request.wireName, received: request.approvedArgs };
    return { ok: true, result: typeof raw === "string" ? raw : JSON.stringify(raw, null, 2) };
  }

  async testMcpServerDirect(
    serverName: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<DirectMcpTestResult | undefined> {
    if (options.signal?.aborted) {
      return { ok: false, latencyMs: 0, toolCount: 0, tools: [], error: "Test cancelled." };
    }
    const srv = this.inventoryResult.servers.find((s) => s.name === serverName);
    if (!srv) return undefined;
    if (srv.status === "needs-auth") {
      return {
        ok: false,
        latencyMs: 5,
        toolCount: 0,
        tools: [],
        needsAuth: true,
        error: "401 Unauthorized: needs sign-in",
      };
    }
    if (srv.status === "failed") {
      return {
        ok: false,
        latencyMs: 5,
        toolCount: 0,
        tools: [],
        error: srv.error ?? "Connection failed",
      };
    }
    const prefix = serverWirePrefix(serverName);
    const tools = this.inventoryResult.tools
      .filter((t) => t.server === serverName || t.name.startsWith(prefix))
      .map((t) => {
        const name = t.tool ?? t.name.slice(prefix.length);
        const schema = t.inputSchema ? sanitizeInputSchema(t.inputSchema) : undefined;
        return {
          name: untrusted(name, 200),
          ...(t.description ? { description: untrusted(t.description, 300) } : {}),
          ...(schema ? { inputSchema: schema } : {}),
        };
      });
    return {
      ok: true,
      latencyMs: 8,
      toolCount: tools.length,
      tools,
    };
  }

  async signIn(options: {
    serverName: string;
    sessionId: string;
    installationId?: string;
    mcpServers?: Record<string, RuntimeMcpServerConfig>;
    pluginDirectories?: string[];
    disabledMcpServers?: string[];
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<SignInStart> {
    this.signInCalls.push({
      serverName: options.serverName,
      sessionId: options.sessionId,
      ...(options.installationId ? { installationId: options.installationId } : {}),
      ...(options.disabledMcpServers ? { disabledMcpServers: options.disabledMcpServers } : {}),
    });
    const script = this.signInScripts.get(options.serverName) ?? { url: `https://login.example.invalid/authorize?client=aria&server=${encodeURIComponent(options.serverName)}`, outcome: "connected", afterMs: 50 };
    let settle!: (outcome: SignInOutcome) => void;
    const done = new Promise<SignInOutcome>((resolve) => (settle = resolve));
    let finished = false;
    const timers: NodeJS.Timeout[] = [];
    const finish = (outcome: SignInOutcome) => {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      if (outcome.status === "connected") {
        const server = this.inventoryResult.servers.find((s) => s.name === options.serverName);
        if (server) server.status = "connected";
        for (const tool of script.tools ?? []) if (!this.inventoryResult.tools.some((t) => t.name === tool.name)) this.inventoryResult.tools.push(tool);
      }
      this.deletedSessions.push(options.sessionId);
      settle(outcome);
    };
    const ended: SignInStart = { done, cancel: async () => finish({ status: "cancelled" }) };
    timers.push(setTimeout(() => finish({ status: "timed_out" }), options.timeoutMs ?? 5 * 60_000));
    // Starting (the real runtime's servers loading): cancelled meanwhile, it ends without a page.
    if (script.startMs) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, script.startMs);
        options.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
    if (options.signal?.aborted) finish({ status: "cancelled" });
    if (finished) return ended;
    if (!script.url) finish({ status: "connected" });
    else if (script.outcome !== "waits") {
      const status = script.outcome ?? "connected";
      timers.push(setTimeout(() => finish(status === "failed" ? { status, error: script.error ?? "fake: the sign-in failed" } : ({ status } as SignInOutcome)), script.afterMs ?? 50));
    }
    return { ...(script.url ? { url: script.url } : {}), done, cancel: async () => finish({ status: "cancelled" }) };
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId) || this.workers.has(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (this.failDeleteSession) throw new Error("fake: can't delete the session");
    this.deletedSessions.push(sessionId);
    this.sessions.delete(sessionId);
    this.workers.delete(sessionId);
  }

  async runMcpAction(request: McpActionRequest): Promise<McpActionOutcome> {
    try {
      if (request.signal?.aborted) return { ok: false, error: "The action was cancelled." };
      const script = (await this.actionHandler?.(request)) ?? {};
      if (request.signal?.aborted) return { ok: false, error: "The action was cancelled." };
      const count = script.callCount ?? 1;
      if (count === 0) {
        return { ok: false, error: "The session finished without calling the approved tool." };
      }
      const sentServer = script.sentServer ?? request.server;
      const sentTool = script.sentTool ?? request.wireName;
      const sentArgs = "sentArgs" in script ? script.sentArgs : structuredClone(request.approvedArgs);

      let attempts = 0;
      let rejectedReason: string | undefined;
      for (let i = 0; i < count; i++) {
        attempts++;
        if (attempts > 1) {
          rejectedReason ??= "only one tool call was approved for this action";
          break;
        }
        if (sentServer !== request.server || (sentTool !== request.wireName && sentTool !== request.tool)) {
          rejectedReason ??= `only ${request.wireName} on ${request.server} was approved`;
          break;
        }
        const check = checkExactPayload(sentArgs, request.approvedArgs);
        if (!check.ok) {
          rejectedReason ??= check.reason;
          break;
        }
      }
      if (rejectedReason !== undefined) {
        return { ok: false, error: `Blocked by ARIA's exact-payload check: ${rejectedReason}.`, blocked: true };
      }
      this.actionCalls.push({
        sessionId: request.sessionId,
        server: request.server,
        tool: request.tool,
        wireName: request.wireName,
        args: structuredClone(request.approvedArgs),
        model: request.model,
        ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
      });
      if (script.serverError) {
        return { ok: false, error: script.serverError };
      }
      const raw = script.result ?? this.mcpResults[request.wireName] ?? { ok: true, tool: request.wireName, received: request.approvedArgs };
      return { ok: true, result: typeof raw === "string" ? raw : JSON.stringify(raw, null, 2) };
    } finally {
      this.deletedSessions.push(request.sessionId);
    }
  }

  async runTimekeeper(request: TimekeeperSessionRequest): Promise<TimekeeperSessionResult> {
    try {
      if (request.signal?.aborted) return { ok: false, error: "Cancelled." };
      this.timekeeperCalls.push({
        sessionId: request.sessionId,
        model: request.model,
        ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
        availableTools: [...request.availableTools],
        disabledMcpServers: [...request.disabledMcpServers],
        ...(request.mcpServers ? { mcpServers: structuredClone(request.mcpServers) } : {}),
        ...(request.pluginDirectories ? { pluginDirectories: [...request.pluginDirectories] } : {}),
        prompt: request.prompt,
      });
      const scripted = (await this.timekeeperHandler?.(request)) ?? {};
      if (request.signal?.aborted) return { ok: false, error: "Cancelled." };
      if (scripted.error) return { ok: false, error: scripted.error };

      for (const call of scripted.mcpCalls ?? []) {
        const inScope = request.availableTools.includes(`mcp:${call.wireName}`);
        const verdict = inScope
          ? await request.policy.decide({ kind: "mcp", server: call.server, tool: call.wireName, args: call.args ?? {} })
          : { approve: false, reason: "not in availableTools" };
        if (verdict.approve) {
          request.onMcpToolResult?.(call.wireName, call.result);
        }
      }

      if (scripted.proposal !== undefined) {
        const proposeTool = request.tools.find((t) => t.name === "propose_timesheet");
        if (proposeTool) {
          const verdict = await request.policy.decide({ kind: "custom-tool", tool: "propose_timesheet" });
          if (verdict.approve) {
            await proposeTool.handler(proposeTool.parameters.parse(scripted.proposal));
          }
        }
      }
      return { ok: true };
    } finally {
      this.deletedSessions.push(request.sessionId);
    }
  }

  async runUtilitySummary(request: UtilitySummaryRequest): Promise<UtilitySummaryResult> {
    try {
      if (request.signal?.aborted) return { ok: false, error: "Cancelled." };
      this.utilityCalls.push({
        sessionId: request.sessionId,
        model: request.model,
        ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
        prompt: request.prompt,
      });
      if (this.utilityHandler) {
        return await this.utilityHandler(request);
      }
      return {
        ok: true,
        text: `Utility summary (${request.model}): ${request.prompt.split("\n")[0]?.slice(0, 120) ?? "Morning brief ready."}`,
      };
    } finally {
      this.deletedSessions.push(request.sessionId);
    }
  }

  async openConductor(config: ConductorConfig): Promise<ConductorHandle> {
    this.conductorOpens++;
    if (this.conductorOpenGate) await this.conductorOpenGate;
    for (const event of this.openEvents.splice(0)) config.onEvent(event);
    if (this.failOpens > 0) {
      this.failOpens--;
      throw new Error("fake: could not open session");
    }
    const existing = this.sessions.get(config.sessionId);
    // Like the real runtime, a resumed session keeps its history and takes the model it's opened with.
    const transcript = existing?.transcript ?? new Map<string, TranscriptEntry>();
    const record = (entry: TranscriptEntry) => {
      transcript.set(entry.id, entry);
      session.config.onEvent({ type: "transcript", entries: [entry] });
    };
    const session: FakeSession = {
      config,
      prompts: existing?.prompts ?? [],
      model: config.model,
      ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
      transcript,
      inject: (entry) => record(entry),
    };
    this.sessions.set(config.sessionId, session);
    if (existing) setTimeout(() => this.resumeEvents.forEach((e) => config.onEvent(e)), 5);
    // Ids stay unique across a resume (the transcript keeps the earlier ones).
    let counter = transcript.size;

    const play = async (prompt: string) => {
      const emit = (e: RuntimeEvent) => session.config.onEvent(e);
      const reply: FakeReply = this.replyFor?.(prompt) ?? this.replies.shift() ?? { text: (p) => `echo: ${p}` };
      record({ kind: "user", id: `user-${session.config.sessionId}-${++counter}`, at: Date.now(), text: this.recordedPrompt?.(prompt) ?? prompt });
      emit({ type: "turn_start" });
      if (reply.error) {
        record({ kind: "info", id: `error-${session.config.sessionId}-${++counter}`, at: Date.now(), level: "error", text: reply.error });
        emit({ type: "error", message: reply.error });
        emit({ type: "idle" });
        return;
      }
      const results: unknown[] = [];
      for (const call of reply.toolCalls ?? []) {
        const id = `call-${session.config.sessionId}-${++counter}`;
        const at = Date.now();
        const tool = session.config.tools.find((t) => t.name === call.name);
        const args = typeof call.args === "function" ? (call.args as (prompt: string) => unknown)(prompt) : call.args;
        const step: TranscriptEntry = { kind: "tool", id, at, name: call.name, args: JSON.stringify(args, null, 1) };
        record(step);
        emit({ type: "tool_start", toolCallId: id, toolName: call.name });
        if (call.server !== undefined) {
          // An MCP tool: only one in the session's scope can be called at all, and the policy decides each call.
          const offered = session.config.availableTools.includes(`mcp:${call.name}`);
          const decided: PermissionVerdict = offered ? await session.config.policy.decide({ kind: "mcp", server: call.server, tool: call.name, args }) : { approve: false, reason: "no such tool" };
          const outcome = decided.approve ? (this.mcpResults[call.name] ?? { ok: true }) : { error: decided.reason };
          results.push(outcome);
          record({ ...step, success: decided.approve, ms: Date.now() - at, ...(decided.approve ? { result: JSON.stringify(outcome, null, 1) } : { error: (outcome as { error: string }).error }) });
          emit({ type: "tool_end", toolCallId: id, success: decided.approve });
          continue;
        }
        const verdict: PermissionVerdict = !tool ? { approve: false, reason: "no such tool" } : tool.readOnly ? { approve: true } : await session.config.policy.decide({ kind: "custom-tool", tool: call.name });
        let ok = false;
        if (tool && verdict.approve) {
          try {
            results.push(await tool.handler(tool.parameters.parse(args)));
            ok = true;
          } catch (error) {
            results.push({ error: (error as Error).message });
          }
        } else {
          results.push({ error: verdict.approve ? "no such tool" : verdict.reason });
        }
        const outcome = results.at(-1);
        record({ ...step, success: ok, ms: Date.now() - at, ...(ok ? { result: JSON.stringify(outcome ?? null, null, 1) } : { error: (outcome as { error: string }).error }) });
        emit({ type: "tool_end", toolCallId: id, success: ok });
      }
      const text = typeof reply.text === "function" ? reply.text(prompt, results) : reply.text;
      const messageId = `fake-${session.config.sessionId}-${session.prompts.length}-${++counter}`;
      const chunks = text.match(/[\s\S]{1,8}/g) ?? [];
      for (const [index, chunk] of chunks.entries()) {
        if (index > 0 && reply.chunkMs) await new Promise((resolve) => setTimeout(resolve, reply.chunkMs));
        emit({ type: "delta", messageId, text: chunk });
      }
      if (text.trim()) record({ kind: "assistant", id: messageId, at: Date.now(), text });
      emit({ type: "message", messageId, text, model: session.model });
      emit({ type: "idle" });
    };

    return {
      sessionId: config.sessionId,
      resumed: existing !== undefined,
      send: async (text) => {
        if (this.failNextSend) {
          this.failNextSend = false;
          throw new Error("fake: the message didn't reach the session");
        }
        session.prompts.push(text);
        setTimeout(() => void play(text), 0);
      },
      getTranscript: async () => {
        this.conductorTranscriptReads++;
        const entries = [...transcript.values()];
        if (this.conductorTranscriptGate) await this.conductorTranscriptGate;
        return entries;
      },
      setModel: async (model, reasoningEffort) => {
        if (this.failNextSetModel) {
          this.failNextSetModel = false;
          throw new Error("fake: model switch rejected");
        }
        if (this.setModelDelayMs) await new Promise((resolve) => setTimeout(resolve, this.setModelDelayMs));
        const previousModel = session.model;
        session.model = this.substituteModel ?? model;
        if (reasoningEffort) session.reasoningEffort = reasoningEffort;
        else delete session.reasoningEffort;
        session.config.onEvent({ type: "model_change", model: session.model, previousModel, ...(reasoningEffort ? { reasoningEffort } : {}) });
      },
      setTools: async (tools) => {
        session.config = { ...session.config, tools };
      },
      abort: async () => {
        // A scripted reply has no turn to stop.
      },
      disconnect: async () => {
        if (this.hangDisconnects) {
          await new Promise<void>(() => {
            // Never settles: a disconnect that hangs is what the test asked for.
          });
        }
        if (this.conductorDisconnectGate) await this.conductorDisconnectGate;
      },
    };
  }
}
