/**
 * The AgentRuntime adapter (PLAN.md §4.2): the rest of ARIA talks to this interface, and only `copilot.ts` imports
 * `@github/copilot-sdk` (technical preview: its API changes). `fake.ts` replays scripted turns for tests.
 */
import type {
  CloudRepo,
  DiscoveredAgentItem,
  DiscoveredSkillItem,
  InstalledPluginItem,
  MarketplaceCatalogPlugin,
  MarketplaceItem,
  TaskMode,
  TranscriptEntry,
} from "@aria/protocol";
import type { z } from "zod";
import type { McpServerTransport, RuntimeMcpServerConfig } from "../integrations/config.ts";
import type { DirectMcpTestResult } from "../integrations/mcp-client.ts";
import type { ServerEntry, ToolEntry } from "../integrations/scope.ts";

export interface RuntimeModel {
  id: string;
  name: string;
  category?: string;
  priceCategory?: string;
  inputPrice?: number;
  outputPrice?: number;
  efforts: string[];
  enabled: boolean;
}

/** A tool ARIA implements itself (custom tool). */
export interface AriaTool<TArgs = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<TArgs>;
  /** True for tools that don't change anything outside ARIA's own state; they skip the permission prompt. */
  readOnly: boolean;
  handler: (args: TArgs) => Promise<unknown> | unknown;
}

/** A list of tools with different arguments, each handler getting only what its own `parameters` parsed. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- AriaTool<unknown> won't do: its handler takes its arguments.
export type AnyAriaTool = AriaTool<any>;

/** What a session asks permission for, in ARIA's own terms (mapped from the SDK's permission request). `intention` is
 * what the agent says it's for. */
export type PermissionAsk =
  | { kind: "read"; path: string; intention?: string }
  | { kind: "write"; path: string; intention?: string }
  | {
      kind: "shell";
      command: string;
      /** The runtime's parsed segments ("git status --short", "Select-String foo"); every one is checked. */
      segments: readonly string[];
      /** Where the command runs (the runtime's resolved working directory). */
      cwd?: string;
      possiblePaths: readonly string[];
      possibleUrls: readonly string[];
      intention?: string;
      /** The tool call it's for, when the runtime says (the session view finds the step by it). */
      toolCallId?: string;
    }
  | { kind: "mcp"; server: string; tool: string; args: unknown }
  | { kind: "custom-tool"; tool: string }
  | { kind: "url"; url: string; intention?: string }
  | { kind: "other"; detail: string };

/** `unavailable`: nobody can answer (ARIA is shutting down); the runtime is told the user isn't available. */
export type PermissionVerdict = { approve: true } | { approve: false; reason: string; unavailable?: boolean };

export interface PolicyDecider {
  decide(ask: PermissionAsk): PermissionVerdict | Promise<PermissionVerdict>;
}

export interface ConductorConfig {
  sessionId: string;
  name: string;
  model: string;
  reasoningEffort?: string;
  workingDirectory: string;
  systemPrompt: string;
  tools: AnyAriaTool[];
  availableTools: string[];
  disabledMcpServers: string[];
  mcpServers?: Record<string, RuntimeMcpServerConfig>;
  pluginDirectories?: string[];
  skillDirectories?: string[];
  agentDirectories?: string[];
  disabledSkills?: string[];
  policy: PolicyDecider;
  /** Registered before the session is created or resumed, so early events (resume warnings) aren't missed. */
  onEvent: (event: RuntimeEvent) => void;
}

/** Normalized session events (root agent only). */
export type RuntimeEvent =
  | { type: "turn_start" }
  | { type: "delta"; messageId: string; text: string }
  | { type: "message"; messageId: string; text: string; model?: string }
  | { type: "tool_start"; toolCallId: string; toolName: string }
  | { type: "tool_end"; toolCallId: string; success: boolean }
  | { type: "idle" }
  | { type: "error"; message: string }
  | { type: "model_change"; model: string; previousModel?: string; reasoningEffort?: string; cause?: string }
  | { type: "warning"; warningType?: string; message: string }
  | { type: "usage"; nanoAiu: number }
  /** New or updated entries for the inspector (PLAN.md §5.3), made by the same code as `getTranscript`. */
  | { type: "transcript"; entries: TranscriptEntry[] };

export interface ConductorHandle {
  readonly sessionId: string;
  /** True when an existing session was resumed rather than created. */
  readonly resumed: boolean;
  send(text: string): Promise<void>;
  /** Everything the session did so far, read from the runtime's session store (no model call). The messages you typed
   * are whole; tool arguments and results are cut at a size limit. */
  getTranscript(): Promise<TranscriptEntry[]>;
  setModel(model: string, reasoningEffort?: string): Promise<void>;
  /** Replaces the session's custom tools (e.g. when the profiles behind start_task change). */
  setTools(tools: AnyAriaTool[]): Promise<void>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

export type SignInOutcome = { status: "connected" } | { status: "failed"; error: string } | { status: "timed_out" } | { status: "cancelled" };

export interface SignInStart {
  url?: string;
  done: Promise<SignInOutcome>;
  cancel(): Promise<void>;
}

export interface ToolInventory {
  tools: ToolEntry[];
  servers: ServerEntry[];
  marketplaces?: MarketplaceItem[];
  plugins?: InstalledPluginItem[];
  agents?: DiscoveredAgentItem[];
  skills?: DiscoveredSkillItem[];
}

export interface McpActionRequest {
  sessionId: string;
  model: string;
  reasoningEffort?: string;
  server: string;
  tool: string;
  wireName: string;
  github?: boolean;
  disabledMcpServers: string[];
  mcpServers?: Record<string, RuntimeMcpServerConfig>;
  pluginDirectories?: string[];
  approvedArgs: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type McpActionOutcome =
  | { ok: true; result: string }
  | { ok: false; error: string; blocked?: boolean };

export interface TimekeeperSessionRequest {
  sessionId: string;
  model: string;
  reasoningEffort?: string;
  systemPrompt: string;
  prompt: string;
  tools: AnyAriaTool[];
  availableTools: string[];
  disabledMcpServers: string[];
  mcpServers?: Record<string, RuntimeMcpServerConfig>;
  pluginDirectories?: string[];
  policy: PolicyDecider;
  onMcpToolResult?: (toolName: string, result: unknown) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface TimekeeperSessionResult {
  ok: boolean;
  error?: string;
}

export interface UtilitySummaryRequest {
  sessionId: string;
  model: string;
  reasoningEffort?: string;
  systemPrompt: string;
  prompt: string;
  disabledMcpServers: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type UtilitySummaryResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

// ── Workers (Phase 2) ───────────────────────────────────────────────────────────────────────────────────────────

export interface WorkerQuestion {
  question: string;
  choices?: string[];
  allowFreeform: boolean;
}

export interface WorkerAnswer {
  answer: string;
  wasFreeform: boolean;
}

/** A plan a worker in plan mode wants approved (`exit_plan_mode`). */
export interface WorkerPlan {
  summary: string;
  plan?: string;
  /** What the runtime offers, e.g. ["autopilot", "interactive", "exit_only"]. */
  actions: string[];
  recommended?: string;
}

/** approved with a mode: it continues in that mode; not approved: it revises with the feedback, or stops. */
export interface WorkerPlanDecision {
  approved: boolean;
  mode?: "autopilot" | "interactive";
  feedback?: string;
}

/** The runtime sandbox for a worker's session (D20; built by policy/sandbox.ts). */
export interface WorkerSandbox {
  readwrite: string[];
  readonly: string[];
  allowedHosts: string[];
  blockedHosts: string[];
  /** A PowerShell script every command runs first (package caches). */
  initScript: string;
  processFlags: string[];
}

export interface CloudWorkerConfig {
  repository: CloudRepo;
}

export interface WorkerConfig {
  /** Resumed when it exists, created otherwise. */
  sessionId: string;
  name: string;
  model: string;
  reasoningEffort?: string;
  /** Optional custom or plugin agent ID/name to activate for this worker session. */
  agent?: string;
  mode: TaskMode;
  /** The task's worktree (required for local tasks; omitted for cloud tasks). */
  workingDirectory?: string;
  /** Phase 8A: Run the session in the cloud through Mission Control (`PLAN.md` §4.4, Appendix A.8). */
  cloud?: CloudWorkerConfig;
  /** Phase 8A: Share a local session to GitHub web and mobile through Mission Control (`PLAN.md` §4.7). */
  remote?: boolean;
  /** Phase 8A: Timeout in ms waiting for `session.start` (`producer === "copilot-agent"`) on cloud tasks (default 60_000). */
  cloudStartTimeoutMs?: number;
  /** Phase 9: Per-task AI credit budget cap (or live getter) used when answering `session_limits_exhausted.requested`. */
  budgetCredits?: number;
  getBudgetCredits?: () => number | undefined;
  availableTools: string[];
  disabledMcpServers: string[];
  mcpServers?: Record<string, RuntimeMcpServerConfig>;
  pluginDirectories?: string[];
  skillDirectories?: string[];
  agentDirectories?: string[];
  disabledSkills?: string[];
  policy: PolicyDecider;
  /** Runs the session in the runtime's sandbox (local tasks only); opening fails if that can't be set. */
  sandbox?: WorkerSandbox;
  /** A question from the worker (`ask_user`); resolves when you answer (D17). */
  onQuestion: (question: WorkerQuestion) => Promise<WorkerAnswer>;
  /** A plan from a worker in plan mode; resolves when you approve, ask for a revision or cancel. */
  onPlan: (plan: WorkerPlan) => Promise<WorkerPlanDecision>;
  /** Registered before the session is created or resumed. */
  onEvent: (event: WorkerEvent) => void;
}

/** Normalized worker events. Transcript entries come ready-made from the adapter, so the live view and the history
 * after a restart (`getTranscript`) are built by the same code. */
export type WorkerEvent =
  /** The root agent started working (a turn, a tool, a message): an earlier idle wasn't the end. */
  | { type: "activity" }
  | { type: "intent"; intent: string }
  | { type: "message"; text: string }
  | { type: "task_complete"; summary?: string }
  | { type: "idle"; autopilot: boolean }
  | { type: "error"; message: string }
  | { type: "model_change"; model: string; previousModel?: string; reasoningEffort?: string; cause?: string }
  | { type: "warning"; warningType?: string; message: string }
  /** The agent the session was asked to run as isn't installed (renamed or removed): it runs as the default coding agent. */
  | { type: "agent_missing"; agent: string }
  /** Cost of one model call, sub-agents included, in nano AI credits. */
  | { type: "usage"; nanoAiu: number }
  | { type: "transcript"; entries: TranscriptEntry[] }
  /** Mission Control URL emitted via `session.info` (`infoType === "remote"`, PLAN.md §4.4, Appendix A.8). */
  | { type: "remote_info"; url: string; message?: string }
  /** SDK runtime reached its session AI credit limit (`session_limits_exhausted.requested`, Phase 9, D75). */
  | { type: "budget_exhausted"; usedAiCredits: number; maxAiCredits: number };

export interface WorkerHandle {
  readonly sessionId: string;
  readonly resumed: boolean;
  /** `steer` delivers it into the running turn ("immediate"); otherwise it's queued after the current work. */
  send(text: string, options?: { steer?: boolean }): Promise<void>;
  /** Validated by the caller. Also narrows the session's allowed models to this one, so it can't fall back silently. */
  setModel(model: string, reasoningEffort?: string): Promise<void>;
  /** Selects a custom/plugin agent for subsequent turns, or returns to the default coding agent when null. */
  setAgent?(agent: string | null): Promise<void>;
  /** Switches the session's execution mode (e.g. when approving a plan captured at idle). */
  setMode?(mode: TaskMode): Promise<void>;
  /** Reads the session's current `plan.md` content when available. */
  readPlan?(): Promise<string | undefined>;
  abort(): Promise<void>;
  /** Everything the session did so far (messages, tool calls with arguments and results, permissions). */
  getTranscript(): Promise<TranscriptEntry[]>;
  disconnect(): Promise<void>;
}

/**
 * The Copilot CLI ARIA found first couldn't be used, so it started the runtime bundled with its SDK instead: so far
 * only for a CLI whose wire protocol the SDK doesn't speak (a CLI that updated itself past the pinned SDK).
 */
export interface RuntimeFallback {
  /** The CLI that couldn't be used. */
  from: string;
  /** The runtime that runs instead (bundled with ARIA's SDK). */
  to: string;
  /** Why, as the SDK said it. */
  reason: string;
  /** The wire protocol `from` reported; unset when it reported none. */
  cliProtocol?: number;
  /** The wire protocols ARIA's SDK speaks, lowest and highest. */
  sdkProtocols?: { min: number; max: number };
  /** The bundled runtime's version, when it said in time. */
  version?: string;
}

export interface AgentRuntime {
  /** `tempDir`: the runtime's TEMP/TMP (the sandbox grants the runtime's temp folder, so it shouldn't be the user's). */
  start(options?: { tempDir?: string }): Promise<void>;
  /** Set while the running runtime isn't the CLI ARIA looked for first; what to tell you about it. */
  runtimeFallback?(): RuntimeFallback | undefined;
  stop(): Promise<void>;
  /** Whether it's running and answers (no model call). It says nothing by itself when it ends or hangs. */
  isAlive(): Promise<boolean>;
  listModels(): Promise<RuntimeModel[]>;
  /**
   * Every tool and server a default session would get, found without any model call, in a short-lived session with
   * this id (the caller keeps the id, so one left behind by a crash can be deleted later).
   */
  inventory(options?: {
    sessionId?: string;
    mcpServers?: Record<string, RuntimeMcpServerConfig>;
    pluginDirectories?: string[];
    skillDirectories?: string[];
    agentDirectories?: string[];
    disabledSkills?: string[];
    projectPaths?: string[];
    disabledMcpServers?: string[];
  }): Promise<ToolInventory>;
  /**
   * Starts signing in to an MCP server that needs it, in a short-lived session with this id (persistent token storage, no
   * server disabled): `url` is the sign-in page to open (none when a stored token already worked); `done` settles when
   * the server connects or fails, the time is up, or it's cancelled. The session is deleted then, and `cancel()` returns
   * only once it is. `signal` cancels it while it starts (before there's a page): it returns without one, as cancelled.
   */
  signIn(options: {
    serverName: string;
    sessionId: string;
    installationId?: string;
    mcpServers?: Record<string, RuntimeMcpServerConfig>;
    pluginDirectories?: string[];
    disabledMcpServers?: string[];
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<SignInStart>;
  /**
   * Phase 7A: Optional runtime discovery of CLI-configured MCP servers and plugin directories.
   */
  readCliMcpConfig?(): Promise<{
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
  }>;
  /**
   * Phase 7A: Optional direct tool execution hook used by `FakeRuntime` in offline tests (zero model sessions).
   */
  callMcpToolDirect?(request: {
    server: string;
    tool: string;
    wireName: string;
    approvedArgs: Record<string, unknown>;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<McpActionOutcome>;
  /**
   * Phase 7A: Optional server connectivity probe for built-in runtime servers or `FakeRuntime`.
   */
  testMcpServerDirect?(
    serverName: string,
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      mcpServers?: Record<string, RuntimeMcpServerConfig>;
      pluginDirectories?: string[];
      disabledMcpServers?: string[];
    },
  ): Promise<DirectMcpTestResult | undefined>;
  /** Whether this PC can run the runtime's sandbox (D20). */
  sandboxSupport(): Promise<{ supported: boolean; reason?: string }>;
  sessionExists(sessionId: string): Promise<boolean>;
  /** Resumes `config.sessionId` if it exists, otherwise creates it. */
  openConductor(config: ConductorConfig): Promise<ConductorHandle>;
  /** Resumes `config.sessionId` if it exists, otherwise creates it, sets its mode and pins its sub-agents' model. */
  openWorker(config: WorkerConfig): Promise<WorkerHandle>;
  /**
   * Runs one approved MCP tool call in a short-lived session with only `mcp:<wireName>` enabled, enforcing the
   * exact-payload check in the permission handler and returning the tool's own result (PLAN.md §4.13, D10, D19).
   */
  runMcpAction(request: McpActionRequest): Promise<McpActionOutcome>;
  /**
   * Runs a short-lived read-only Timekeeper session (Phase 5C, PLAN.md §4.12, §4.14) that gathers Work IQ and task-tracker
   * read data and calls `propose_timesheet`.
   */
  runTimekeeper(request: TimekeeperSessionRequest): Promise<TimekeeperSessionResult>;
  /**
   * Runs a short-lived, tool-free Utility model session (Phase 6B, PLAN.md §4.12, §10 Phase 6B) to write a brief prose
   * summary from plain-code facts.
   */
  runUtilitySummary?(request: UtilitySummaryRequest): Promise<UtilitySummaryResult>;
  deleteSession(sessionId: string): Promise<void>;

  // ── Marketplaces, Plugins, Agents & Skills ────────────────────────────────────────────────────────────────────
  addMarketplace?(source: string, workingDirectory?: string): Promise<{ name: string }>;
  removeMarketplace?(name: string, force?: boolean): Promise<{ removed: boolean; dependentPlugins?: string[] }>;
  browseMarketplace?(name: string): Promise<MarketplaceCatalogPlugin[]>;
  refreshMarketplaces?(name?: string): Promise<void>;
  installPlugin?(
    source: string,
    workingDirectory?: string,
  ): Promise<{
    plugin: InstalledPluginItem;
    skillsInstalled: number;
    postInstallMessage?: string;
    deprecationWarning?: string;
  }>;
  uninstallPlugin?(name: string, directSourceId?: string): Promise<void>;
  updatePlugin?(name?: string): Promise<{ updatedCount: number; message?: string }>;
  setPluginEnabled?(name: string, enabled: boolean, workingDirectory?: string): Promise<void>;
  setSkillEnabled?(name: string, enabled: boolean): Promise<void>;
}
