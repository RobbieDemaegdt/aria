/**
 * AriaEngine: the UI-agnostic core (PLAN.md §3, §4.2–4.4, §4.9–4.12). The one chat with the Conductor, the repo
 * registry, model settings, worker profiles and background tasks. The desktop app (or a test) drives it and listens
 * to events.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  Activity,
  ActivitySource,
  AppState,
  AttentionSettings,
  AvailableUpdateInfo,
  BudgetSettings,
  CardItem,
  ChatItem,
  ConductorSettings,
  ConductorStatus,
  ConductorTranscript,
  DailyBudgetState,
  DataState,
  DoctorReport,
  EngineEvent,
  GitHubState,
  InstalledPluginItem,
  IntegrationScope,
  IntegrationsState,
  IntegrationTestResult,
  MarketplaceCatalogPlugin,
  Memory,
  MemoryScope,
  MemorySource,
  MemoryState,
  ModelOption,
  MyWorkState,
  NoticeItem,
  OnboardingState,
  PermissionDecision,
  PlanDecision,
  PolicySettings,
  Profile,
  ProfilePolicy,
  Project,
  PromptInfo,
  PromptVersion,
  ReleaseNoteEntry,
  Reminder,
  Routine,
  RouteAction,
  RuleCheck,
  RuleOffer,
  RuleScope,
  SandboxPermission,
  SaveMcpServerInput,
  SearchResults,
  SearchScope,
  SetPhonePushSecretsInput,
  Task,
  TaskDiff,
  TaskFile,
  TelegramRelayStatus,
  TrackerChangePreview,
  TrackerImportResult,
  TrackerPurgeCounts,
  TimelineItem,
  TimeRegisteredCardPayload,
  TimeRule,
  TimeRuleKind,
  TimeRuleMatchMode,
  TimeViewState,
  TimekeeperSettings,
  TimesheetCardPayload,
  TimesheetSourceRef,
  ToolRuleEffect,
  TranscriptEntry,
  TranscriptPage,
  TranscriptPageInput,
  UiState,
  UtilitySettings,
  Watch,
  YourWords,
} from "@aria/protocol";
import { encodingDamageText, transcriptPage } from "@aria/protocol";
import type { z } from "zod";
import { Attention, DEFAULT_ATTENTION } from "./attention/attention.ts";
import { realClock } from "./attention/clock.ts";
import { DailyBudget } from "./attention/daily-budget.ts";
import { Digest, withDigest } from "./attention/digest.ts";
import {
  normalizeNtfyServerUrl,
  PhoneNotifier,
} from "./attention/phone.ts";
import {
  TelegramRelay,
  type TelegramWaitingContext,
} from "./relay/telegram.ts";
import { ConductorPolicy } from "./conductor/policy.ts";
import { ConductorInspector, type SentPrompt } from "./conductor/inspector.ts";
import { conductorPrompt } from "./conductor/prompt.ts";
import { conductorSettingsFrom, patchedTimekeeperSettings, patchedUtilitySettings, timekeeperSettingsFrom, utilitySettingsFrom } from "./conductor/model-settings.ts";
import { executeSlashCommand, type SlashCommandDeps } from "./conductor/slash.ts";
import {
  conductorTools,
  type ActionToolDeps,
  type MemoryToolDeps,
  type SchedulerToolDeps,
  type TaskToolDeps,
  type TimeToolDeps,
} from "./conductor/tools.ts";
import { findGh, type GitHubAccess } from "./github/access.ts";
import { ActionRunner, type ActionTracker } from "./integrations/actions.ts";
import { EMPTY_MCP_CONFIG, type McpConfigStore } from "./integrations/config.ts";
import type { McpDirectClient } from "./integrations/mcp-client.ts";
import { ActivityCollector } from "./timekeeper/collectors.ts";
import { MAX_TIME_RULES, validateTimeRuleInput } from "./timekeeper/rules.ts";
import { recordTimelineActivity } from "./timekeeper/timeline-activity.ts";
import { DEFAULT_TIMEKEEPER_SETTINGS, TimekeeperRunner } from "./timekeeper/session.ts";
import type { PullRequests } from "./tasks/pr.ts";
import type { CiFixes } from "./tasks/fix.ts";
import { digestText } from "./github/text.ts";
import { GitHub } from "./github/github.ts";
import type { MyWork } from "./watchers/mywork.ts";
import type { OutlookWatcher } from "./watchers/outlook.ts";
import type { TrackerWatcher } from "./watchers/tracker.ts";
import {
  builtInActive,
  chooseConfig,
  chooseDataTracker,
  chooseTracker,
  dataTrackerId,
  expectedConfigFile,
  describeActive,
  describeListing,
  noneActive,
  readTrackerChoice,
  writeTrackerChoice,
  type ActiveTracker,
  type TrackerChoice,
} from "./trackers/active.ts";
import { listTrackerConfigs, trackersDir, type ConfigListing } from "./trackers/config/load.ts";
import { createConfigTracker } from "./trackers/config/tracker.ts";
import { importTrackerConfigText, type ImportExists } from "./trackers/import.ts";
import { windowTrackerInfo } from "./trackers/info.ts";
import { isNoTracker, NO_TRACKER } from "./trackers/none.ts";
import { trackerReads, trackerReserved, trackerServers, trackerToolStatus } from "./trackers/setup.ts";
import { unionToolSets } from "./trackers/tool-sets.ts";
import type { TaskTracker } from "./trackers/types.ts";
import type { Watchers } from "./watchers/watchers.ts";
import type { WorkflowDispatches } from "./watchers/dispatch.ts";
import { isSeen, type Catalog, type Scopes, type StoredRule } from "./integrations/rules.ts";
import { Integrations } from "./integrations/integrations.ts";
import { Plugins } from "./integrations/plugins.ts";
import { serverWirePrefix } from "./integrations/scope.ts";
import { assertForgetGrounded, assertMemoryGrounded, briefNotes, conductorMemoryBlock, conductorNotes, MEMORIES_MAX, memoryBlock, memoryProblem } from "./memory/memories.ts";
import { assertCloneGrounded, assertCreateGrounded, cloneRepo, createRepo, readFolderInfo, samePath, scanRoots, type RepoInfo } from "./memory/repos.ts";
import {
  assertReminderGrounded,
  assertRoutineGrounded,
  Scheduler,
} from "./scheduler/scheduler.ts";
import { searchAria } from "./search/search.ts";
import {
  normalizeVoiceCloudEndpoint,
  VoiceService,
} from "./voice/voice.ts";
import { checkRule } from "./policy/breadth.ts";
import { applyOffer } from "./policy/offers.ts";
import { copilotExtensionReadonlyPaths, extractBriefPaths, grantablePaths, ariaDirs, namesPath, prepareAriaDirs, sandboxSpec, type AriaDirs } from "./policy/sandbox.ts";
import { PolicyStore, type RuleInput, type SandboxSettings } from "./policy/settings.ts";
import { PromptLibrary } from "./prompts/library.ts";
import { describeRuntimeFallback } from "./runtime/fallback.ts";
import { HelperSessions } from "./runtime/helper-sessions.ts";
import type { AnyAriaTool, ConductorHandle, RuntimeEvent, RuntimeModel, WorkerSandbox } from "./runtime/types.ts";
import { TranscriptRetentionRunner } from "./store/retention.ts";
import { reportSlowCalls } from "./store/slow-calls.ts";
import { Store } from "./store/store.ts";
import { encodingRepairMessage } from "./tasks/brief.ts";
import { TaskManager, within, type MessageOutcome } from "./tasks/manager.ts";
import { Profiles, type ProfileInput } from "./tasks/profiles.ts";
import { TaskStarts } from "./tasks/start.ts";
import { resolveWorktreeRoot } from "./tasks/worktrees.ts";
import { FileLogger, parseLogLevel, type Logger } from "./util/logger.ts";
import { redactText } from "./util/redact.ts";
import { runDoctor } from "./doctor/doctor.ts";
import {
  DEFAULT_APP_VERSION,
  ARIA_LATEST_RELEASE_URL,
  parseLatestGitHubRelease,
  RELEASES,
  resolveOnboardingStartup,
} from "./releases/releases.ts";
import type { EngineOptions } from "./engine-options.ts";
import { ignoreCleanupFailure, onlyWaitedFor } from "./util/ignore.ts";

export const DEFAULT_CONDUCTOR_SESSION_ID = "aria-conductor";

/**
 * A model's answer that ended before it was finished. Gemini 4 Hydrogen does this on every turn of a long conversation
 * whose history holds a runtime instruction update (the sandbox reminder the runtime adds on resume), while it answers
 * in a fresh conversation and other models answer in that one: a model you just switched to can't read the history.
 */
const UNFINISHED_ANSWER = /missing_finish_reason|ended without completing/i;

/** Before your message in a fresh conversation, so ARIA knows it starts without the earlier one. */
const FRESH_CONVERSATION_NOTE =
  "<fresh_conversation>\nThis is a fresh conversation: the previous one couldn't continue on this model, so you don't have its history. list_tasks and your memories have the current state; ask the user for anything else you need from before.\n</fresh_conversation>";

export type { EngineOptions } from "./engine-options.ts";

/** How often a routine's turn looks again when no status change woke it (a turn can end without one). */
const ROUTINE_RECHECK_MS = 250;

const DEFAULT_UI: UiState = { sidebarCollapsed: false, view: "chat" };
/** What the window shows while ARIA runs one of its own tools. */
const builtinActivity = (trackerLabel: string): Record<string, string> => ({
  view: "Reading a file",
  glob: "Looking for files",
  grep: "Searching files",
  list_repos: "Checking your projects",
  register_repo: "Adding a project",
  start_task: "Starting a task",
  list_tasks: "Checking your tasks",
  get_task: "Checking a task",
  message_task: "Messaging a task",
  set_task_agent: "Switching a task's agent",
  answer_question: "Answering a task",
  decide_permission: "Deciding a request",
  review_plan: "Reviewing a plan",
  continue_budget: "Raising a budget",
  cancel_task: "Stopping a task",
  cleanup_task: "Cleaning up a task",
  list_profiles: "Checking your profiles",
  watch: "Setting up a watch",
  list_watches: "Checking your watches",
  unwatch: "Stopping a watch",
  run_workflow: "Proposing a workflow run",
  switch_github_account: "Proposing a GitHub account switch",
  list_action_tools: "Checking action tools",
  request_action: "Proposing an action",
  link_task_tracker: `Linking a ${trackerLabel} task`,
  list_activities: "Checking your work activity",
  list_time_rules: "Checking your time rules",
  save_time_rule: "Saving a time rule",
  delete_time_rule: "Deleting a time rule",
  prepare_timesheet: "Preparing your timesheet",
  get_timesheet: "Checking your timesheet",
  update_timesheet_entry: "Updating your timesheet",
  remember: "Saving a memory",
  forget: "Removing a memory",
  remind_me: "Setting a reminder",
  schedule_routine: "Scheduling a routine",
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What a purge cleared, for the notice: only what there was. Registered entries stay as history, so they aren't in it. */
function describeCleared(counts: TrackerPurgeCounts, fromLabel: string): string {
  const count = (n: number, one: string, many: string) => (n > 0 ? [`${n} ${n === 1 ? one : many}`] : []);
  const parts = [
    ...count(counts.cachedTasks, "cached task", "cached tasks"),
    ...count(counts.rules, "rule", "rules"),
    ...count(counts.draftRowsWithTasks, "draft row's task", "draft rows' tasks"),
    ...count(counts.linkedActivities, "activity link", "activity links"),
  ];
  return `Cleared ${parts.join(", ")} from ${fromLabel}; a backup of the database was made first.`;
}
/** How long quitting waits for the Conductor's session to detach. */
const DISCONNECT_WAIT_MS = 5_000;
/** How often the runtime is asked whether it still answers, and how soon again after it didn't. */
const RUNTIME_CHECK_MS = 15_000;
const RUNTIME_RECHECK_MS = 1_000;
/** No answer this many times in a row and it's gone: one can be the PC waking from sleep. */
const RUNTIME_MISSES = 3;
/** Your words in a digest line, quoted and kept short. */
const quote = (text: string, max = 200) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return `"${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}"`;
};
const MESSAGE_ROUTE_NOTES: Partial<Record<MessageOutcome, string>> = {
  queued: "It gets this once it's ready for it.",
  continuing: "It continues in its session with this.",
  held: "It's paused at its budget: it gets this when you raise the budget.",
};

export class AriaEngine {
  private readonly emitter = new EventEmitter();
  private readonly options: EngineOptions;
  /** The task tracker: every part that needs it gets `tracker: () => this.tracker`. Chosen at start, swapped by `setActiveTracker`. */
  private tracker: TaskTracker;
  /** Where the active tracker came from: the code that made the engine (tests), or a config file and its hash. */
  private activeTracker: ActiveTracker;
  /** The trackers folder as last read: at start, on a listing, an import and Integrations' Refresh. */
  private trackerListing: ConfigListing[] = [];
  /** Why the config the setting names isn't the one in use: it didn't load at start. A switch clears it. */
  private trackerError: string | undefined;
  /** The reserved and confirm tools the action checks read: the union over every config in the folder. */
  private toolSets: ActionTracker = { reservedTools: new Set(), confirmTools: new Set() };
  private store: Store | undefined;
  private fileLogger: FileLogger | undefined;
  private conductor: ConductorHandle | undefined;
  private status: ConductorStatus = { state: "starting", detail: "Starting" };
  /**
   * What ARIA's session opened with (its tools and the servers it leaves out): it reopens before your next message
   * only when the scopes now say otherwise, not for a rule for tasks or a check that found the same.
   */
  private conductorOpenedWith = "";
  /** The Integrations' sign-ins that connected, when ARIA's session opened: it reopens when that moved. */
  private conductorSignIns = 0;
  /** The runtime has started (Refresh and Sign in need it). */
  private runtimeStarted = false;
  private models: RuntimeModel[] = [];
  private readonly activeTools = new Map<string, string>();
  /**
   * The user-initiated switch in flight, so its model_change event isn't reported as a runtime switch (D15), and
   * the model the runtime reported while it ran.
   */
  private pendingModel: { id: string; reported?: string } | undefined;
  /**
   * A model you switched ARIA to, until it has answered once in this conversation, and the last message of yours it
   * was given (to which session). If that answer ends before it's finished, ARIA continues in a fresh conversation on
   * the model and sends your message again.
   */
  private modelOnTrial: { model: string; sent?: SentPrompt & { sessionId: string } } | undefined;
  /**
   * Opening the Conductor and changing its model happen one at a time, in order: a choice made while the conversation
   * is still opening is applied to the opened session, and each switch's model_change event matches its own request.
   */
  private conductorQueue: Promise<void> = Promise.resolve();
  /** A Conductor session that's still letting go of its id after a reopen timed out: nothing opens it again until then. */
  private conductorClosing: Promise<void> | undefined;
  /** The runtime is up and the model catalog and tool scope are loaded, so the Conductor can be (re)opened. */
  private runtimeReady = false;
  /** The next check whether the runtime still answers, while it's up. */
  private runtimeWatch: NodeJS.Timeout | undefined;
  /** The stop of a runtime that stopped answering: the next start or stop waits for it. */
  private runtimeStopping: Promise<void> | undefined;
  /** Of the Conductor's newest session: once closed, what that session still reports is ignored. */
  private conductorGate: { open: boolean } | undefined;
  private stopped = false;
  /** Bumped by every change to the Conductor's tools (profiles, policy). */
  private toolsVersion = 0;
  private profilesStore: Profiles | undefined;
  private taskManager: TaskManager | undefined;
  private worktreeRootPath: string | undefined;
  private latestDoctorReport: DoctorReport | undefined;
  /** What's waiting for the status to change. */
  private readonly statusWaiters = new Set<() => void>();

  /** What happened since your last message, for ARIA's next digest (PLAN.md §4.3). */
  private readonly digest = new Digest({ db: () => this.db, pending: () => this.taskManager?.pendingItems() ?? [] });
  private readonly policyStore = new PolicyStore({ db: () => this.db });
  private readonly prompts = new PromptLibrary({
    db: () => this.db,
    profiles: () => this.profiles.list(),
    setInstructions: (id, text) => this.profiles.setInstructions(id, text),
  });
  /** Whether this PC can run the runtime's sandbox (D20); checked when the runtime has started. */
  private sandboxSupport: { supported: boolean; reason?: string } = { supported: false, reason: "ARIA hasn't checked yet." };
  /** ARIA's own folders next to the worktrees (caches, the runtime's temp folder, the sandbox's shell script). */
  private dirs: AriaDirs | undefined;
  private dirsError: string | undefined;
  /** The system prompt the open conversation has: after an edit in Customize › Prompts it's reopened with the new one. */
  private conductorPromptText: string | undefined;
  /** Toasts and the "while you were away" card (PLAN.md §4.5, §5.5); it lives before start(), so the shell can report
   * whether you're there at any time. */
  private readonly attention: Attention;
  private actions: ActionRunner | undefined;
  private collector: ActivityCollector | undefined;
  private timekeeper: TimekeeperRunner | undefined;
  private scheduler: Scheduler | undefined;
  /** D1: trims finished tasks' transcripts once a day (Customize › Data). */
  private retention: TranscriptRetentionRunner | undefined;
  private readonly voice: VoiceService;
  private readonly phone: PhoneNotifier;
  private readonly telegram: TelegramRelay;
  private readonly helperSessions: HelperSessions;
  private readonly dailyBudget: DailyBudget;
  private readonly inspector: ConductorInspector;
  private readonly taskStarts: TaskStarts;
  /** Customize › Integrations: what ARIA knows of your MCP servers and tools, your rules, and the scopes from them. */
  private readonly integrations: Integrations;
  private readonly plugins: Plugins;
  /** GitHub (who ARIA reads it as) and the watchers (PLAN.md §4.6). */
  private readonly github: GitHub;

  constructor(options: EngineOptions) {
    this.options = options;
    // None until `start()` chooses one, so nothing reads an unset tracker.
    this.tracker = options.tracker ?? NO_TRACKER;
    this.activeTracker = isNoTracker(this.tracker) ? noneActive() : builtInActive(this.tracker);
    this.emitter.setMaxListeners(50);
    this.helperSessions = new HelperSessions({
      db: () => this.db,
      isOpen: () => this.isOpen(),
      runtime: options.runtime,
      stopped: () => this.stopped,
    });
    this.dailyBudget = new DailyBudget({
      db: () => this.db,
      isOpen: () => this.isOpen(),
      clock: options.attentionClock ?? realClock,
      timekeeper: () => this.timekeeper,
      emit: (event) => this.emit(event),
      notice: (level, text, cause) => this.notice(level, text, cause),
      digest: (line) => this.digest.add(line),
      attention: (event) => this.attention.event(event),
    });
    this.inspector = new ConductorInspector({
      db: () => this.db,
      log: (text) => this.log(text),
      emit: (event) => this.emit(event),
      holdTurns: options.inspectorHoldTurns,
    });
    this.taskStarts = new TaskStarts({
      db: () => this.db,
      tracker: () => this.tracker,
      profiles: () => this.profiles,
      tasks: () => this.tasks,
      addToTimeline: (item) => this.addToTimeline(item),
      digest: (line) => this.digest.add(line),
      yourPaths: (text) => this.yourPaths(text),
      chatProject: () => this.chatProject(),
    });
    this.integrations = new Integrations({
      db: () => this.db,
      tracker: () => this.tracker,
      trackerState: () => ({
        active: isNoTracker(this.tracker) ? undefined : this.activeTracker,
        choice: this.store ? readTrackerChoice(this.db) : {},
        listing: this.trackerListing,
        error: this.trackerProblem(),
      }),
      relistTrackers: () => {
        this.listTrackers();
      },
      isOpen: () => this.isOpen(),
      options,
      emit: (event) => this.emit(event),
      log: (text) => this.log(text),
      logFailure: (step) => this.logFailure(step),
      notice: (level, text, cause) => this.notice(level, text, cause),
      runtimeStarted: () => this.runtimeStarted,
      stopped: () => this.stopped,
      wakeTracker: () => {
        this.trackerWatcher?.wake();
        this.outlookWatcher?.wake();
      },
      refreshConductorTools: () => this.refreshConductorTools(),
      conductorSettings: () => this.conductorSettings(),
      timekeeperSettings: () => this.timekeeperSettings(),
      helperSessions: this.helperSessions,
    });
    this.plugins = new Plugins({
      integrations: this.integrations,
      options,
      runtimeStarted: () => this.runtimeStarted,
      projectRoots: () => this.projectRoots,
      refreshConductorTools: () => this.refreshConductorTools(),
      logFailure: (step) => this.logFailure(step),
      notice: (level, text, cause) => this.notice(level, text, cause),
    });
    this.github = new GitHub({
      db: () => this.db,
      tracker: () => this.tracker,
      options,
      log: (line) => this.log(line),
      emit: (event) => this.emit(event),
      addToTimeline: (item) => this.addToTimeline(item),
      attention: (event) => this.attention.event(event),
      digest: this.digest,
      notice: (level, text, cause) => this.notice(level, text, cause),
      integrations: this.integrations,
      runtimeStarted: () => this.runtimeStarted && !this.stopped,
      attentionSettings: () => this.attentionSettings(),
      utilitySettings: () => this.utilitySettings(),
      ...(options.runtime.runUtilitySummary
        ? { runUtilityTriage: (req) => options.runtime.runUtilitySummary!(req) }
        : {}),
      tasks: () => this.tasks,
      profiles: () => this.profiles,
      resolveProject: (ref) => this.resolveProject(ref),
      saveRepo: (info, addedVia) => this.saveRepo(info, addedVia),
    });
    this.voice = new VoiceService({
      settings: () => this.attentionSettings(),
      ...(options.voiceSecretStore ? { secretStore: options.voiceSecretStore } : {}),
      ...(options.voiceTranscriber ? { transcriber: options.voiceTranscriber } : {}),
      ...(options.voiceSynthesizer ? { synthesizer: options.voiceSynthesizer } : {}),
      ...(options.voiceFetch ? { fetch: options.voiceFetch } : {}),
    });
    this.phone = new PhoneNotifier({
      settings: () => this.attentionSettings(),
      ...(options.phoneSecretStore ? { secretStore: options.phoneSecretStore } : {}),
      ...(options.pushoverEndpoint ? { pushoverEndpoint: options.pushoverEndpoint } : {}),
      ...(options.phoneFetch ? { fetch: options.phoneFetch } : {}),
      log: (msg) => this.log(msg),
    });
    this.telegram = new TelegramRelay({
      settings: () => this.attentionSettings(),
      ...(options.telegramSecretStore ? { secretStore: options.telegramSecretStore } : {}),
      getLastUpdateId: () => (this.store ? this.db.getSetting<number>("telegram.lastUpdateId") : undefined),
      setLastUpdateId: (id) => {
        if (this.store) this.db.setSetting("telegram.lastUpdateId", id);
      },
      onInboundMessage: (text) => this.sendMessage(text, { via: "telegram" }),
      findWaitingForCard: (cardId) => this.findTelegramWaitingForCard(cardId),
      onStatusChange: (telegram) => this.emit({ type: "telegram", telegram }),
      ...(options.telegramApiBaseUrl ? { apiBaseUrl: options.telegramApiBaseUrl } : {}),
      ...(options.telegramPollIntervalMs !== undefined ? { pollIntervalMs: options.telegramPollIntervalMs } : {}),
      ...(options.telegramLongPollTimeoutSeconds !== undefined ? { longPollTimeoutSeconds: options.telegramLongPollTimeoutSeconds } : {}),
      ...(options.telegramRetryBaseMs !== undefined ? { retryBaseMs: options.telegramRetryBaseMs } : {}),
      ...(options.telegramFetch ? { fetch: options.telegramFetch } : {}),
      log: (msg) => this.log(msg),
    });
    this.attention = new Attention({
      tracker: () => this.tracker,
      clock: options.attentionClock ?? realClock,
      settings: () => this.attentionSettings(),
      emit: (event) => this.emit(event),
      addCard: (card) => this.addToTimeline(card),
      waiting: () => this.taskManager?.waitingOnYou() ?? [],
      taskState: (taskId) => this.taskManager?.get(taskId)?.state,
      reminderActive: (cardId) => this.scheduler?.isReminderCardActive(cardId) ?? false,
      outlookCardActive: (cardId) => {
        if (!cardId || !this.store) return false;
        const item = this.db.getTimelineItem(cardId);
        return Boolean(item && item.kind === "card" && item.cardType === "outlook_mail");
      },
      phonePush: (event) => {
        void this.phone.send(event).catch(this.logFailure("Phone push"));
      },
      relayEvent: (event, priority) => {
        void this.telegram.onAttentionEvent(event, priority).catch(this.logFailure("Telegram alert"));
      },
    });
  }

  private findTelegramWaitingForCard(cardId: string | undefined): TelegramWaitingContext | undefined {
    if (!cardId || !this.taskManager) return undefined;
    const item = this.taskManager.waitingOnYou().find((w) => w.cardId === cardId);
    if (!item) return undefined;
    const task = this.taskManager.get(item.taskId);
    return {
      ...item,
      ...(task?.question?.choices ? { choices: task.question.choices } : {}),
      ...(task?.slug ? { slug: task.slug } : {}),
    };
  }

  // ── events ──────────────────────────────────────────────────────────────────────────────────────────────────

  onEvent(listener: (event: EngineEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  private emit(event: EngineEvent): void {
    this.emitter.emit("event", event);
  }

  private setStatus(status: ConductorStatus): void {
    this.status = status;
    this.emit({ type: "status", status });
    this.wakeStatusWaiters();
  }

  private wakeStatusWaiters(): void {
    for (const wake of [...this.statusWaiters]) wake();
  }

  /** Until the status changes, the engine stops, or `ms` have passed. */
  private statusChange(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.statusWaiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.statusWaiters.add(wake);
    });
  }

  private get db(): Store {
    if (!this.store) throw new Error("ARIA engine isn't started");
    return this.store;
  }

  private get profiles(): Profiles {
    if (!this.profilesStore) throw new Error("ARIA engine isn't started");
    return this.profilesStore;
  }

  private get tasks(): TaskManager {
    if (!this.taskManager) throw new Error("ARIA engine isn't started");
    return this.taskManager;
  }

  private worktreeRoot(): string {
    this.worktreeRootPath ??= resolveWorktreeRoot(this.options.worktreeRoot);
    return this.worktreeRootPath;
  }

  get projectRoots(): string[] {
    if (this.store) {
      const stored = this.db.getSetting<unknown>("projects.roots");
      if (Array.isArray(stored)) {
        return stored.filter((r): r is string => typeof r === "string" && r.trim().length > 0);
      }
    }
    if (this.options.projectRoots) return this.options.projectRoots;
    const fallback = path.join(os.homedir(), "Documents", "GitHub");
    return existsSync(fallback) ? [fallback] : [];
  }

  private chatProject(): Project {
    return {
      id: 0,
      name: "Chats",
      path: path.join(this.options.dataDir, "chats"),
      kind: "folder",
      addedVia: "local",
      pinned: false,
      hidden: false,
    };
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.stopped) return;
    this.store = new Store(path.join(this.options.dataDir, "aria.db"), this.options.storeBackup ? { backup: this.options.storeBackup } : {});
    const storedLogLevel = this.db.getSetting<string>("log.level");
    const effectiveLogLevel = this.options.logLevel ?? parseLogLevel(storedLogLevel ?? process.env.ARIA_LOG_LEVEL, "info");
    this.fileLogger = new FileLogger({
      logDir: path.join(this.options.dataDir, "logs"),
      level: effectiveLogLevel,
    });
    this.fileLogger.info("engine", "Starting AriaEngine", { dataDir: this.options.dataDir, logLevel: effectiveLogLevel });
    // P5: a store call long enough to hold up the window goes in the log (at debug level).
    reportSlowCalls(this.db, (call, ms) => this.fileLogger?.debug("store", "A store call took longer than a frame", { call, ms: Math.round(ms) }));
    // Live session steps are written together a moment after they come in; nothing waits on that write to hear it failed.
    this.db.onQueueError = this.logFailure("Saving the steps a session sent");
    // The WAL is checkpointed in a worker; if that stops, the commits do it again (and can stall the window for it).
    this.db.onCheckpointError = this.logFailure("Checkpointing the database in a worker");
    // D1: a clean-up that left much of the file free is followed by a compact as the store opens.
    for (const note of this.db.migrationNotes) this.fileLogger.info("store", "Migrated the database", { note });
    const compact = this.db.compactedAtOpen;
    if (compact?.error) this.fileLogger.warn("store", "Couldn't compact the database", { error: compact.error });
    else if (compact) this.fileLogger.info("store", "Compacted the database", { beforeBytes: compact.beforeBytes, afterBytes: compact.afterBytes, ms: compact.ms });
    // The task tracker is chosen as soon as the store is open, before anything reads it.
    this.chooseTrackerAtStart();
    this.retention = new TranscriptRetentionRunner({
      db: () => this.db,
      clock: this.options.attentionClock ?? realClock,
      stopped: () => this.stopped,
      failed: this.logFailure("Cleaning up old transcripts"),
    });
    this.retention.start();
    this.profilesStore = new Profiles({ db: () => this.db, models: () => this.models });
    this.collector = new ActivityCollector({
      db: () => this.db,
      tracker: () => this.tracker,
      projects: () => this.db.listRepos(),
      tasks: () => this.tasks.list(),
      refreshActiveTasks: () => this.taskManager?.refreshActiveStretches(),
      githubLogin: () => this.githubAccess?.login,
      ownAuthors: () => this.timekeeperSettings().ownAuthors ?? [],
    });
    this.taskManager = new TaskManager({
      db: () => this.db,
      tracker: () => this.tracker,
      runtime: this.options.runtime,
      models: () => this.models,
      profileInstructions: (id) => (id ? this.profiles.get(id)?.instructions : undefined),
      worktreeRoot: () => this.worktreeRoot(),
      workerScope: () => {
        const mcpServers = this.mcpConfigStore?.buildScopedServers({
          disabledMcpServers: this.scopes.tasks.disabledMcpServers,
          allowedWireTools: this.scopes.tasks.availableTools,
        });
        const mcpState = this.mcpConfigStore?.getState();
        const pluginDirectories = mcpState?.pluginDirectories;
        const skillDirectories = mcpState?.skillDirectories;
        const agentDirectories = mcpState?.agentDirectories;
        const disabledSkills = mcpState?.disabledSkills;
        const readonlyRoots = this.extensionReadableRoots();
        return {
          ...this.scopes.tasks,
          ...(mcpServers && Object.keys(mcpServers).length ? { mcpServers } : {}),
          ...(pluginDirectories?.length ? { pluginDirectories } : {}),
          ...(skillDirectories?.length ? { skillDirectories } : {}),
          ...(agentDirectories?.length ? { agentDirectories } : {}),
          ...(disabledSkills?.length ? { disabledSkills } : {}),
          ...(readonlyRoots.length ? { readonlyRoots } : {}),
          mcp: (server: string, wireName: string) => this.scopes.lookup("tasks", server, wireName),
        };
      },
      policyRules: () => this.policyStore.rules(),
      sandboxFor: (task) => this.sandboxFor(task),
      allowedSandboxPaths: () => this.policyStore.sandbox().allowedPaths,
      persistSandboxException: (exception) => this.persistSandboxException(exception),
      briefTemplate: () => this.prompts.active("brief"),
      memoryFor: (repoId) => memoryBlock(briefNotes(this.db.listMemories(), repoId).shown),
      digest: (line) => this.digest.add(line),
      emit: (event) => this.emit(event),
      attention: (event) => this.attention.event(event),
      addCard: (card) => this.addToTimeline(card),
      removeCardsForTask: (taskId, ...cardTypes) => this.removeCardsForTask(taskId, ...cardTypes),
      notice: (level, text, cause, taskId) => this.notice(level, text, cause, taskId),
      log: (line) => this.log(line),
      onActivity: (record, stretch, stretchStartedAt, stretchEndedAt) =>
        this.collector?.recordTaskStretch({
          task: record,
          stretch,
          stretchStartedAt,
          ...(stretchEndedAt !== undefined ? { stretchEndedAt } : {}),
          ...(record.trackerTaskManual ? { trackerTaskManual: true } : {}),
        }),
      onTrackerLink: (taskId, trackerTaskId) => this.collector?.syncTaskTrackerLink(taskId, trackerTaskId),
      budgetWarningPercent: () => this.budgetSettings().budgetWarningPercent,
      onUsageDelta: (nanoAiu) => this.dailyBudget.recordDailyUsage(nanoAiu),
      ...(this.options.maxConcurrentTasks ? { maxConcurrent: this.options.maxConcurrentTasks } : {}),
      ...(this.options.taskSettleMs !== undefined ? { settleMs: this.options.taskSettleMs } : {}),
      ...(this.options.autopilotGraceMs !== undefined ? { autopilotGraceMs: this.options.autopilotGraceMs } : {}),
      ...(this.options.shutdownWaitMs !== undefined ? { stopWaitMs: this.options.shutdownWaitMs } : {}),
      ...(this.options.sessionWaitMs !== undefined ? { sessionWaitMs: this.options.sessionWaitMs } : {}),
      ...(this.options.cloudStartTimeoutMs !== undefined ? { cloudStartTimeoutMs: this.options.cloudStartTimeoutMs } : {}),
    });
    // Tasks that were working when ARIA closed are interrupted (one card offers to resume them).
    this.tasks.markInterrupted();
    // ARIA's own MCP configuration and client, and what Customize › Integrations showed last time (Phase 7A).
    this.integrations.open();
    this.actions = new ActionRunner({
      tracker: () => this.toolSets,
      mcpClient: this.mcpClient,
      runtime: this.options.runtime,
      catalog: () => this.catalog,
      rules: () => this.toolRules,
      conductorSettings: () => this.conductorSettings(),
      runtimeReady: () => this.runtimeStarted && !this.stopped,
      helperId: () => this.helperSessions.helperId(),
      helperDone: (id) => this.helperSessions.helperDone(id),
      card: (cardId) => {
        const item = this.db.getTimelineItem(cardId);
        return item?.kind === "card" ? item : undefined;
      },
      cards: () => this.db.listCards("action_request"),
      saveCard: (card) => this.addToTimeline(card),
      digest: (line) => this.digest.add(line),
      ...(this.options.shutdownWaitMs !== undefined ? { shutdownWaitMs: this.options.shutdownWaitMs } : {}),
    });
    this.actions.markInterrupted();
    const clock = this.options.attentionClock ?? realClock;
    this.timekeeper = new TimekeeperRunner({
      db: () => this.db,
      tracker: () => this.tracker,
      runtime: this.options.runtime,
      collector: () => this.activityCollector,
      catalog: () => this.catalog,
      toolRules: () => this.toolRules,
      mcpConfig: () => this.mcpConfigStore?.getState() ?? EMPTY_MCP_CONFIG,
      mcpServersForScope: (opts) => this.mcpConfigStore?.buildScopedServers(opts) ?? {},
      settings: () => this.timekeeperSettings(),
      runtimeReady: () => this.runtimeStarted && !this.stopped,
      helperId: () => this.helperSessions.helperId(),
      helperDone: (id) => this.helperSessions.helperDone(id),
      cards: () => this.db.listCards("timesheet_draft"),
      registeredCards: () => this.db.listCards("time_registered"),
      saveCard: (card) => this.addToTimeline(card),
      executeApprovedMcpCall: (input) => this.actionRunner.executeApprovedMcpCall(input),
      callReadMcpTool: async (input) => {
        if (!this.mcpClient) return undefined;
        const hasRealDirect =
          Boolean(this.options.mcpClient) ||
          Boolean(this.options.mcpTransportFactory) ||
          Boolean(this.mcpConfigStore?.hasDirectAuth(input.server));
        const fakeResults = (this.options.runtime as { mcpResults?: Record<string, unknown> }).mcpResults;
        const hasExplicitFakeResult = fakeResults !== undefined && Object.hasOwn(fakeResults, input.wireName);
        const catServer = this.catalog.servers.find((s) => s.name === input.server);
        const canFallbackToRuntime =
          fakeResults === undefined &&
          Boolean(catServer && isSeen(this.catalog, catServer) && catServer.status !== "disabled" && catServer.status !== "needs-auth");
        if (!hasRealDirect && !hasExplicitFakeResult && !canFallbackToRuntime) return undefined;
        return this.mcpClient.callTool({
          server: input.server,
          tool: input.tool,
          wireName: input.wireName,
          approvedArgs: input.args,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      },
      onTimeChanged: () => this.emit({ type: "today_time", todayTime: this.timekeeperRunner.todaySummary() }),
      saveTimeRule: (input) => this.saveTimeRule(input),
      digest: (line) => this.digest.add(line),
      now: () => clock.now(),
      ...(this.options.shutdownWaitMs !== undefined ? { shutdownWaitMs: this.options.shutdownWaitMs } : {}),
    });
    this.timekeeper.recover();
    this.scheduler = new Scheduler({
      db: () => this.db,
      clock,
      timesheetTime: () => this.timekeeperSettings().timesheetTime ?? "16:30",
      tracksTime: () => this.tracker.info.capabilities.timeLogs,
      trackerId: () => this.tracker.id,
      onSyncTimesheetTime: (hhmm) => {
        const current = this.timekeeperSettings();
        if (current.timesheetTime !== hhmm) {
          const next = { ...current, timesheetTime: hhmm };
          this.db.setSetting("timekeeper.settings", next);
          this.emit({ type: "timekeeper", timekeeper: next });
        }
      },
      utilitySettings: () => this.utilitySettings(),
      disabledMcpServers: () => this.catalog.servers.map((s) => s.name),
      helperId: () => this.helperSessions.helperId(),
      helperDone: (id) => this.helperSessions.helperDone(id),
      ...(this.options.runtime.runUtilitySummary
        ? { runUtilitySummary: (req) => this.options.runtime.runUtilitySummary!(req) }
        : {}),
      prepareTimesheet: (date) => this.prepareTimesheet(date),
      getTimeView: (date) => this.getTimeView(date),
      getDaySummary: (date, today) => this.timekeeperRunner.getDaySummary(date, today),
      tasks: () => this.tasks.list(),
      timeline: () => this.db.listTimeline(),
      saveCard: (card) => this.addToTimeline(card),
      attention: (event) => this.attention.event(event),
      digest: (line) => this.digest.add(line),
      notice: (level, text, cause) => this.notice(level, text, cause),
      emitRoutines: (routines) => this.emit({ type: "routines", routines }),
      emitReminders: (reminders) => this.emit({ type: "reminders", reminders }),
      runPromptRoutine: (routine) => this.runPromptRoutine(routine),
    });
    this.scheduler.seedBuiltins();
    this.reconcileOnboardingAndReleases();
    if (this.options.updateCheckFetch) {
      void this.checkForAppUpdate().catch(this.logFailure("Checking for ARIA updates"));
    }
    // GitHub's watchers don't need the Copilot runtime: they start now, and resume what was watched (§4.10).
    this.github.startWatchers();
    await this.connectRuntime();
  }

  private reconcileOnboardingAndReleases(): void {
    if (!this.store) return;
    const now = (this.options.attentionClock ?? realClock).now();
    const stored = this.db.getSetting<OnboardingState>("onboarding.state");
    const resolved = resolveOnboardingStartup(stored, this.appVersion(), now, this.releases());
    if (resolved.changed) {
      this.db.setSetting("onboarding.state", resolved.state);
      this.emit({ type: "onboarding", onboarding: resolved.state });
    }
    if (resolved.whatsNewReleases.length > 0) {
      this.addToTimeline({
        kind: "card",
        id: `whats-new-${this.appVersion()}-${now}`,
        cardType: "whats_new",
        createdAt: now,
        payload: {
          ...(resolved.previousVersion ? { fromVersion: resolved.previousVersion } : {}),
          toVersion: this.appVersion(),
          releases: resolved.whatsNewReleases,
        },
      });
    }
  }

  /** Starts the runtime and everything that needs it, at startup and again on Reconnect. Trouble ends in the error status. */
  private async connectRuntime(): Promise<void> {
    // stop() can arrive at any await below (the window closed while starting): then nothing else is opened or written.
    try {
      // ARIA's folders next to the worktrees: package caches for sandboxed tasks, and the runtime's temp folder. The
      // sandbox lets tasks use the runtime's temp folder, so that mustn't be your own %TEMP% (spike 10).
      let tempDir: string | undefined;
      try {
        this.dirs = ariaDirs(this.worktreeRoot());
        prepareAriaDirs(this.dirs);
        tempDir = this.dirs.tmp;
      } catch (error) {
        this.dirs = undefined;
        this.dirsError = message(error);
      }
      this.setStatus({ state: "starting", detail: "Starting the Copilot runtime" });
      await this.options.runtime.start(tempDir ? { tempDir } : {});
      if (this.stopped) return;
      this.runtimeStarted = true;
      // Your Copilot CLI updated itself past what ARIA's SDK speaks: ARIA runs, on its bundled runtime, and says so.
      const fallback = this.options.runtime.runtimeFallback?.();
      if (fallback) {
        this.fileLogger?.warn("engine", "Using the bundled Copilot runtime", { cli: fallback.from, runtime: fallback.to, reason: fallback.reason });
        this.notice("warning", describeRuntimeFallback(fallback).text, "runtime_fallback");
      }
      await this.helperSessions.sweepHelpers();
      if (this.stopped) return;
      this.sandboxSupport = await this.options.runtime.sandboxSupport();
      if (this.stopped) return;
      this.emitPolicy();
      this.setStatus({ state: "starting", detail: "Scanning your projects" });
      await this.rescanProjects();
      if (this.stopped) return;
      this.setStatus({ state: "starting", detail: "Loading models and tools" });
      this.models = await this.options.runtime.listModels();
      if (this.stopped) return;
      this.emit({ type: "models", models: this.listModels() });
      this.emit({ type: "timekeeper", timekeeper: this.timekeeperSettings() });
      this.emit({ type: "utility", utility: this.utilitySettings() });
      this.emit({ type: "budget", budget: this.dailyBudgetState() });
      if (this.profiles.seedIfEmpty()) this.emitProfiles();
      await this.integrations.checkIntegrations();
      if (this.stopped) return;
      this.runtimeReady = true;
      this.trackerWatcher?.wake();
      this.outlookWatcher?.wake();
      this.watchRuntime();
      // Tasks still in the queue start now.
      this.tasks.startQueued();
      await this.inConductorQueue(() => this.openConductor());
      if (!this.stopped) this.conversationOpened();
    } catch (error) {
      if (!this.stopped) {
        this.setStatus({ state: "error", detail: message(error) });
        void this.runDoctor().catch(ignoreCleanupFailure);
      }
    }
  }

  /** What waited for the conversation starts. Safe to repeat on Reconnect: what's already running stays as it is. */
  private conversationOpened(): void {
    this.scheduler?.start();
    this.emit({ type: "routines", routines: this.scheduler?.listRoutines() ?? [] });
    this.emit({ type: "reminders", reminders: this.scheduler?.listReminders() ?? [] });
    this.telegram.sync();
  }

  /**
   * Reconnect in the chat: tries again after ARIA couldn't connect, so fixing Copilot CLI doesn't take a restart of
   * ARIA. The runtime starts over (one that's running may not notice a new sign-in) and the startup's steps run again.
   * A task that's working would end with the runtime, so then only the conversation is opened again. How it went shows
   * in the status.
   */
  async reconnect(): Promise<void> {
    if (this.stopped || this.status.state !== "error") return;
    this.setStatus({ state: "starting", detail: "Reconnecting to the Copilot runtime" });
    if (this.runtimeReady && !this.tasks.pauseForRestart()) {
      try {
        await this.inConductorQueue(async () => {
          if (this.stopped) return;
          // Already open: it was checking its tools that failed.
          if (this.conductor) this.setStatus({ state: "ready", ...this.conductorSettings() });
          else await this.openConductor();
        });
        if (!this.stopped) this.conversationOpened();
      } catch (error) {
        if (!this.stopped) this.setStatus({ state: "error", detail: `${message(error)} A task is still working, so the Copilot runtime wasn't restarted: stop the task and reconnect to restart it too.` });
      }
      return;
    }
    this.runtimeReady = false;
    this.unwatchRuntime();
    // As when ARIA quits: what uses the runtime goes first, no longer than a runtime that doesn't answer allows.
    const wait = this.options.shutdownWaitMs ?? DISCONNECT_WAIT_MS;
    const signIn = this.integrations.signInRun;
    if (signIn) await within(wait, () => signIn.cancel());
    const conductor = this.dropConductor();
    if (conductor) await within(wait, () => conductor.disconnect());
    this.runtimeStarted = false;
    await this.runtimeStopping;
    await this.options.runtime.stop().catch(this.logFailure("Stopping the runtime"));
    if (!this.stopped) await this.connectRuntime();
  }

  /** Asks the runtime now and then whether it still answers, because it says nothing by itself when it ends or hangs. */
  private watchRuntime(delay = this.options.runtimeCheckMs ?? RUNTIME_CHECK_MS, misses = 0): void {
    clearTimeout(this.runtimeWatch);
    const watch = setTimeout(() => {
      void this.options.runtime
        .isAlive()
        .catch(() => false)
        .then((alive) => {
          // Reconnect or quitting took over while it asked.
          if (this.runtimeWatch !== watch) return;
          if (alive) this.watchRuntime();
          else if (misses + 1 < RUNTIME_MISSES) this.watchRuntime(Math.min(RUNTIME_RECHECK_MS, this.options.runtimeCheckMs ?? RUNTIME_RECHECK_MS), misses + 1);
          else this.runtimeLost();
        });
    }, delay);
    watch.unref();
    this.runtimeWatch = watch;
  }

  private unwatchRuntime(): void {
    clearTimeout(this.runtimeWatch);
    this.runtimeWatch = undefined;
  }

  /** The conversation's session is no use anymore: nothing it still reports counts. Returns it, to let go of it. */
  private dropConductor(): ConductorHandle | undefined {
    if (this.conductorGate) this.conductorGate.open = false;
    const conductor = this.conductor;
    this.conductor = undefined;
    this.activeTools.clear();
    return conductor;
  }

  /**
   * The runtime stopped answering while ARIA runs: the chat shows it with Reconnect, and the tasks working on it are
   * interrupted, as when ARIA closes. It's stopped too, so one that only hangs doesn't hold on to its sessions.
   */
  private runtimeLost(): void {
    this.unwatchRuntime();
    if (this.stopped || !this.runtimeReady) return;
    const detail = "The Copilot runtime stopped answering while ARIA was running.";
    this.fileLogger?.warn("engine", detail);
    this.runtimeReady = false;
    this.runtimeStarted = false;
    if (this.activeRoutineTurn) this.activeRoutineTurn.error = detail;
    this.activeRoutineTurn = undefined;
    this.dropConductor();
    this.tasks.runtimeLost();
    this.setStatus({ state: "error", detail });
    this.integrations.emitIntegrations();
    this.runtimeStopping = this.options.runtime.stop().catch(this.logFailure("Stopping the runtime"));
  }

  private inConductorQueue(work: () => Promise<void>): Promise<void> {
    const run = this.conductorQueue.then(work);
    this.conductorQueue = run.catch(onlyWaitedFor);
    return run;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.wakeStatusWaiters();
    this.runtimeReady = false;
    this.unwatchRuntime();
    // A sign-in, starting or waiting for the browser, ends with ARIA (its session is deleted), but no longer than the
    // other steps: a runtime that doesn't answer mustn't keep ARIA from quitting. A session left then is swept at the
    // next start (its id stays noted).
    const signIn = this.integrations.signInRun;
    if (signIn) await within(this.options.shutdownWaitMs ?? DISCONNECT_WAIT_MS, () => signIn.cancel());
    this.runtimeStarted = false;
    this.inspector.release();
    // First: tasks stopping now (failed, cancelled) mustn't toast while ARIA quits.
    this.attention.stop();
    await this.telegram.stop().catch(this.logFailure("Stopping the Telegram relay"));
    this.scheduler?.stop();
    // No poll writes after this, and none waits long; My work's list (and a search on its way) goes, and a push on its
    // way is ended (its process tree too).
    this.myWorkList?.stop();
    this.trackerWatcher?.stop();
    this.outlookWatcher?.stop();
    this.prs?.stop();
    this.fixes?.stop();
    await this.dispatches?.stop().catch(this.logFailure("Stopping workflow dispatches"));
    await this.actions?.stop().catch(this.logFailure("Stopping actions"));
    await this.timekeeper?.stop().catch(this.logFailure("Stopping the timekeeper"));
    await this.mcpClient?.stop().catch(this.logFailure("Stopping the MCP client"));
    await this.watchers?.stop().catch(this.logFailure("Stopping the watchers"));
    // Each step is bounded (the task manager bounds its own): a session that never answers mustn't keep ARIA from
    // quitting, and the runtime's stop ends whatever is left.
    await this.taskManager?.stop().catch(this.logFailure("Stopping the task manager"));
    const conductor = this.conductor;
    this.conductor = undefined;
    if (conductor) await within(this.options.shutdownWaitMs ?? DISCONNECT_WAIT_MS, () => conductor.disconnect());
    await this.runtimeStopping;
    await this.options.runtime.stop().catch(this.logFailure("Stopping the runtime"));
    // A clean-up of transcripts stops at its next batch, before the store closes (D1).
    await this.retention?.finish();
    // Before the log closes: closing writes the session steps still queued, and a failure to is logged (P5).
    this.store?.close();
    this.store = undefined;
    this.fileLogger?.info("engine", "Stopped AriaEngine");
    this.fileLogger?.close();
    this.fileLogger = undefined;
  }

  /** `fresh`: a new session instead of resuming the saved one (the model you switched to can't continue that one). */
  private async openConductor(options: { fresh?: boolean } = {}): Promise<void> {
    // It stopped answering since this was asked for: Reconnect opens the conversation.
    if (!this.runtimeReady) throw new Error("The Copilot runtime isn't running.");
    // Its session id is still being let go of: opening it now would let that late detach close the new conversation.
    if (this.conductorClosing) throw new Error("ARIA is still closing its previous conversation. Try again in a moment.");
    const stored = this.db.getSetting<ConductorSettings>("conductor.settings");
    const settings = this.conductorSettings();
    const model = settings.model;
    if (!model) throw new Error("No model is available for ARIA.");
    // A saved choice the runtime no longer offers (model gone or disabled, effort dropped) is replaced, and said so.
    if (stored?.model && (stored.model !== settings.model || stored.reasoningEffort !== settings.reasoningEffort)) {
      this.db.setSetting("conductor.settings", settings);
      if (stored.model !== settings.model) {
        this.notice("warning", `Your saved model for ARIA, ${stored.model}, isn't available anymore, so ARIA uses ${settings.model} now. You can pick another one in Customize › Models.`, "model_unavailable");
      } else if (stored.reasoningEffort) {
        this.notice("warning", `${settings.model} doesn't offer ${stored.reasoningEffort} reasoning effort anymore, so ARIA uses ${settings.reasoningEffort ?? "its default"} now. You can change it in Customize › Models.`, "effort_unavailable");
      }
    }
    this.emit({ type: "settings", conductor: settings });
    const preferred = options.fresh
      ? `${DEFAULT_CONDUCTOR_SESSION_ID}-${Date.now()}`
      : (this.options.conductorSessionId ?? this.db.getSetting<string>("conductor.sessionId") ?? DEFAULT_CONDUCTOR_SESSION_ID);
    const toolsVersion = this.toolsVersion;
    // A change of the scope while it opens: the next message reopens it (ensureCurrentPrompt), as for a changed prompt.
    const opensWith = this.integrations.ariaOpensWith();
    const signIns = this.integrations.signInsConnected;
    const systemPrompt = this.conductorSystemPrompt();
    const mcpConfigState = this.mcpConfigStore?.getState() ?? EMPTY_MCP_CONFIG;
    const mcpServers = this.mcpConfigStore?.buildScopedServers({
      disabledMcpServers: this.scopes.aria.disabledMcpServers,
      allowedWireTools: this.scopes.aria.availableTools,
    });
    const config = {
      name: "ARIA",
      model,
      ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
      workingDirectory: this.projectRoots[0] ?? this.options.dataDir,
      systemPrompt,
      tools: this.conductorToolset(),
      availableTools: this.scopes.aria.availableTools,
      disabledMcpServers: this.scopes.aria.disabledMcpServers,
      ...(mcpServers && Object.keys(mcpServers).length ? { mcpServers } : {}),
      ...(mcpConfigState.pluginDirectories.length ? { pluginDirectories: mcpConfigState.pluginDirectories } : {}),
      ...(mcpConfigState.skillDirectories?.length ? { skillDirectories: mcpConfigState.skillDirectories } : {}),
      ...(mcpConfigState.agentDirectories?.length ? { agentDirectories: mcpConfigState.agentDirectories } : {}),
      ...(mcpConfigState.disabledSkills?.length ? { disabledSkills: mcpConfigState.disabledSkills } : {}),
      // Your rules are read on every request: a tool you turn off is refused at once, also before the reopen.
      policy: new ConductorPolicy({
        mcp: (server, wireName) => this.scopes.lookup("aria", server, wireName),
        readableRoots: () => [...this.db.listRepos().filter((p) => !p.hidden).map((p) => p.path), ...this.extensionReadableRoots()],
      }),
    };
    // Each attempt starts from a status without a model and gets its own event gate, so nothing a failed attempt
    // reported (or reports later) ends up on the session that replaces it.
    const attempt = async (sessionId: string): Promise<ConductorHandle> => {
      this.setStatus({ state: "starting", detail: "Opening the conversation" });
      const gate = { open: true };
      this.conductorGate = gate;
      try {
        return await this.options.runtime.openConductor({
          ...config,
          sessionId,
          onEvent: (event: RuntimeEvent) => {
            if (gate.open) this.onRuntimeEvent(event, sessionId);
          },
        });
      } catch (error) {
        gate.open = false;
        throw error;
      }
    };
    let handle: ConductorHandle;
    let resumeError: unknown;
    try {
      handle = await attempt(preferred);
    } catch (error) {
      if (this.stopped || !this.runtimeReady) throw error;
      // A damaged or incompatible session: continue in a fresh one; the timeline above stays visible.
      resumeError = error;
      handle = await attempt(`${DEFAULT_CONDUCTOR_SESSION_ID}-${Date.now()}`);
    }
    if (this.stopped || !this.runtimeReady) {
      await handle.disconnect().catch(ignoreCleanupFailure);
      return;
    }
    if (resumeError !== undefined) {
      this.notice("warning", `ARIA couldn't resume the previous conversation (${message(resumeError)}), so it started a fresh one. Your messages above are kept.`, "resume_failed");
    }
    this.conductor = handle;
    if (!handle.resumed) {
      this.db.markTranscriptBackfilled("conductor");
    }
    this.conductorPromptText = systemPrompt;
    this.conductorOpenedWith = opensWith;
    this.conductorSignIns = signIns;
    this.db.setSetting("conductor.sessionId", handle.sessionId);
    // The window hears which session this is: after a fresh one (the old one couldn't be resumed), the inspector reads
    // that one (what the engine held of the old one is read again too: it's another session).
    this.emit({ type: "conductor_transcript", sessionId: handle.sessionId, entries: [] });
    // Profiles or the policy changed while it opened: it opened with the tools from before.
    if (this.toolsVersion !== toolsVersion) await this.refreshConductorTools();
    if (this.stopped || this.conductor !== handle) return;
    // After a crash the runtime reports interrupted tool calls shortly after resuming (Phase 0: ~160 ms).
    if (handle.resumed) await sleep(this.options.resumeSettleMs ?? 600);
    if (this.stopped || this.conductor !== handle) return;
    // What actually runs: a different model the runtime reported while this attempt opened (the status was reset for
    // it, and the D15 warning is already shown), else the requested settings.
    const reported = this.status.model;
    const running: ConductorSettings =
      reported && reported !== model ? { model: reported, ...(this.status.reasoningEffort ? { reasoningEffort: this.status.reasoningEffort } : {}) } : settings;
    this.setStatus({ state: "ready", ...running });
  }

  // ── conductor events ────────────────────────────────────────────────────────────────────────────────────────

  private onRuntimeEvent(event: RuntimeEvent, sessionId: string): void {
    // Late events while shutting down (the store is closed by then) change nothing.
    if (this.stopped) return;
    switch (event.type) {
      case "transcript":
        this.inspector.onTranscript(event.entries, sessionId);
        break;
      case "usage":
        this.dailyBudget.recordDailyUsage(event.nanoAiu);
        break;
      case "turn_start":
        if (this.status.state !== "busy") this.setStatus({ ...this.status, state: "busy" });
        break;
      case "delta":
        this.emit({ type: "delta", itemId: event.messageId, text: event.text });
        break;
      case "message":
        // It answered (text or a tool call), so it can read this conversation.
        if (this.modelOnTrial && sessionId === this.conductor?.sessionId) this.modelOnTrial = undefined;
        if (event.text.trim()) {
          if (this.activeRoutineTurn) this.activeRoutineTurn.reply = event.text;
          const item: ChatItem = { kind: "chat", id: event.messageId, role: "assistant", content: event.text, createdAt: Date.now(), ...(event.model ? { model: event.model } : {}) };
          this.addToTimeline(item);
        }
        break;
      case "tool_start":
        this.activeTools.set(event.toolCallId, this.activityLabel(event.toolName));
        this.emit({ type: "activity", label: this.activeTools.get(event.toolCallId)! });
        break;
      case "tool_end":
        this.activeTools.delete(event.toolCallId);
        this.emit({ type: "activity", label: [...this.activeTools.values()].at(-1) ?? null });
        break;
      case "idle":
        this.activeTools.clear();
        this.emit({ type: "activity", label: null });
        this.activeRoutineTurn = undefined;
        if (this.status.state === "busy") this.setStatus({ ...this.status, state: "ready" });
        break;
      case "error":
        if (this.leaveForFreshConversation(event.message, sessionId)) break;
        if (this.activeRoutineTurn) {
          this.activeRoutineTurn.error = event.message;
        }
        this.activeRoutineTurn = undefined;
        this.notice("error", `Something went wrong: ${event.message}`, "session_error");
        if (this.status.state === "busy") this.setStatus({ ...this.status, state: "ready" });
        break;
      case "model_change": {
        const wanted = this.pendingModel?.id ?? this.conductorSettings().model;
        if (this.pendingModel) this.pendingModel.reported = event.model;
        // D15: the runtime can switch models on its own (refusal fallback); show it, don't hide it.
        if (event.cause || (wanted && event.model !== wanted)) {
          this.notice("warning", `The runtime switched ARIA from ${event.previousModel ?? "its model"} to ${event.model}${event.cause ? ` (${event.cause.replace(/_/g, " ")})` : ""}. Pick a model in Customize › Models to switch back.`, event.cause ?? "model_mismatch");
        }
        this.setStatus({ ...this.status, model: event.model, ...(event.reasoningEffort ? { reasoningEffort: event.reasoningEffort } : {}) });
        break;
      }
      case "warning":
        if (event.warningType === "interrupted_tools") {
          this.notice("info", "ARIA was interrupted in the middle of an answer last time, so that answer may be incomplete.", "interrupted_tools");
        } else {
          this.notice("warning", event.message, event.warningType);
        }
        break;
    }
  }

  /**
   * The model you switched to failed its first answer in this conversation because its answer ended before it was
   * finished: ARIA leaves this conversation for a fresh one on the same model and sends your message again (your
   * messages stay in the chat). False when it's another failure, a routine's turn, or not the conversation in use.
   */
  private leaveForFreshConversation(error: string, sessionId: string): boolean {
    const trial = this.modelOnTrial;
    const sent = trial?.sent;
    if (!trial || !sent || this.activeRoutineTurn || sent.sessionId !== sessionId || this.conductor?.sessionId !== sessionId || !UNFINISHED_ANSWER.test(error)) return false;
    this.modelOnTrial = undefined;
    // Nothing more from the session being left (it may still report its turn's end); no message goes to it meanwhile.
    if (this.conductorGate) this.conductorGate.open = false;
    this.activeTools.clear();
    this.emit({ type: "activity", label: null });
    const name = this.models.find((m) => m.id === trial.model)?.name ?? trial.model;
    this.notice(
      "warning",
      `${name}'s answer ended before it was finished: it can't continue this conversation. ARIA continues in a fresh conversation on ${name} and sends your message again. Your messages above stay here, but ARIA doesn't remember the earlier conversation.`,
      "fresh_conversation",
    );
    this.setStatus({ state: "starting", detail: "Continuing in a fresh conversation" });
    void this.continueInFreshConversation(sessionId, sent);
    return true;
  }

  private async continueInFreshConversation(left: string, sent: SentPrompt): Promise<void> {
    try {
      await this.inConductorQueue(async () => {
        // ARIA stopped, or the runtime went (Reconnect opens the conversation then).
        if (this.stopped || this.conductor?.sessionId !== left) return;
        const old = this.dropConductor();
        // The fresh one has its own id, so the old one's detach can't close it: nothing to wait for.
        void old?.disconnect().catch(this.logFailure("Closing ARIA's previous conversation"));
        await this.openConductor({ fresh: true });
      });
    } catch (error) {
      if (!this.stopped) this.setStatus({ state: "error", detail: message(error) });
      return;
    }
    const conductor = this.conductor;
    if (this.stopped || !conductor || conductor.sessionId === left || this.status.state !== "ready") return;
    const digest = sent.digest ? `${FRESH_CONVERSATION_NOTE}\n\n${sent.digest}` : FRESH_CONVERSATION_NOTE;
    const again: SentPrompt = { prompt: withDigest(sent.text, digest), text: sent.text, digest };
    this.inspector.promptSent(again);
    this.setStatus({ ...this.status, state: "busy" });
    try {
      await conductor.send(again.prompt);
    } catch (error) {
      this.inspector.promptNotSent(again);
      this.notice("error", `ARIA couldn't send your message again: ${message(error)}`, "send_failed");
      this.turnNotSent();
    }
  }

  private activityLabel(toolName: string): string {
    const builtin = builtinActivity(this.tracker.label)[toolName];
    if (builtin) return builtin;
    const server = this.catalog.servers.find((s) => toolName.startsWith(serverWirePrefix(s.name)));
    return server ? `Checking ${server.name}` : `Using ${toolName}`;
  }

  private addToTimeline(item: TimelineItem): void {
    this.db.upsertTimeline(item);
    recordTimelineActivity(item, {
      collector: () => this.collector,
      tracker: () => this.tracker,
      task: (taskId) => this.taskManager?.get(taskId),
      watch: (watchId) => this.watchers?.list().find((w) => w.id === watchId),
      projects: () => this.github.githubProjects(),
    });
    this.emit({ type: "timeline", item });
    if (item.kind === "chat" && item.role === "assistant") {
      const isTelegramTurn = this.db.lastUserChat()?.via === "telegram";
      if (isTelegramTurn || this.attention.isAway()) {
        void this.telegram.onAssistantReply(item.content).catch(this.logFailure("Telegram reply"));
      }
    }
  }

  private removeCardsForTask(taskId: string, ...cardTypes: CardItem["cardType"][]): void {
    if (!this.store || cardTypes.length === 0) return;
    const matching = this.db
      .listCards(...cardTypes)
      .filter((c) => "taskId" in c.payload && (c.payload as { taskId?: unknown }).taskId === taskId);
    for (const card of matching) {
      if (this.db.deleteTimelineItem(card.id)) {
        this.emit({ type: "timeline_removed", id: card.id });
      }
    }
  }

  private notice(level: NoticeItem["level"], text: string, cause?: string, taskId?: string): void {
    const now = Date.now();
    if (this.store) {
      const timeline = this.db.listTimeline(100);
      let lastUserIdx = -1;
      for (let i = timeline.length - 1; i >= 0; i--) {
        const it = timeline[i]!;
        if (it.kind === "chat" && it.role === "user") {
          lastUserIdx = i;
          break;
        }
      }
      const searchFrom = taskId ? 0 : Math.max(0, lastUserIdx + 1);
      for (let i = timeline.length - 1; i >= searchFrom; i--) {
        const existing = timeline[i]!;
        if (existing.kind !== "notice" || existing.taskId !== taskId) continue;
        const sameSessionRuntimeNotice =
          taskId !== undefined &&
          cause !== undefined &&
          existing.cause === cause &&
          existing.level === level &&
          (cause === "model_mismatch" ||
            cause === "refusal_fallback" ||
            cause === "model_switch_failed" ||
            cause === "agent_switch_failed" ||
            cause === "mode_switch_failed" ||
            cause === "cloud_cancel_failed");
        const sameMessage = existing.level === level && existing.cause === cause && existing.message === text;
        if (sameSessionRuntimeNotice || sameMessage) {
          const updated: NoticeItem = {
            ...existing,
            level,
            message: text,
            ...(cause ? { cause } : {}),
            ...(taskId ? { taskId } : {}),
            updatedAt: now,
            count: (existing.count ?? 1) + 1,
          };
          this.addToTimeline(updated);
          return;
        }
      }
    }
    this.addToTimeline({
      kind: "notice",
      id: randomUUID(),
      level,
      message: text,
      ...(cause ? { cause } : {}),
      ...(taskId ? { taskId } : {}),
      createdAt: now,
    });
  }

  // ── chat ────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Your message in the chat. `@slug text` goes straight to that task (PLAN.md §4.5); anything else goes to ARIA, with
   * what happened since your last message and what tasks wait for in front of it (the digest, §4.3).
   */
  async sendMessage(text: string, options?: { via?: "telegram" }): Promise<void> {
    const via = options?.via;
    const mention = /^@([\w.-]+)\s+([\s\S]*\S[\s\S]*)$/.exec(text.trim());
    const targets = mention && this.store ? this.tasks.bySlug(mention[1]!) : [];
    if (targets.length > 1) {
      throw new Error(`More than one task goes by @${mention![1]}: ${targets.map((t) => `"${t.title}" (${t.repoName})`).join(", ")}. Pick one in the @ list, or use Reply on its card.`);
    }
    if (mention && targets[0]) {
      await this.reply({ taskId: targets[0].id, text: mention[2]!.trim(), ...(via ? { via } : {}) });
      return;
    }

    let conductorText = text;
    if (text.trim().startsWith("/") && this.store) {
      const slash = await executeSlashCommand(text, this.slashDeps());
      if (slash.handled) {
        const now = Date.now();
        this.addToTimeline({ kind: "chat", id: randomUUID(), role: "user", content: text.trim(), createdAt: now, ...(via ? { via } : {}) });
        this.addToTimeline({ kind: "chat", id: randomUUID(), role: "assistant", content: slash.reply, model: "slash", createdAt: now });
        if (slash.digestLine) this.digest.add(slash.digestLine);
        return;
      }
      if (slash.rewritePrompt) {
        conductorText = slash.rewritePrompt;
      }
    }

    if (!this.conductor || !this.conductorUsable()) throw new Error("ARIA isn't ready yet.");
    if (this.inAutomatedTurn) {
      throw new Error("ARIA is finishing a scheduled routine right now. Send your message again in a moment.");
    }
    this.lastUserMessage = conductorText;
    await this.ensureCurrentPrompt();
    const conductor = this.conductor;
    // Reopening for a new prompt can fail, or ARIA can stop or enter a routine turn meanwhile.
    if (!conductor || !this.conductorUsable() || this.inAutomatedTurn) throw new Error("ARIA isn't ready yet.");
    this.lastConductorUserMessage = conductorText;
    const digest = this.digest.build();
    const prompt = withDigest(conductorText, digest.text);
    this.addToTimeline({
      kind: "chat",
      id: randomUUID(),
      role: "user",
      content: text,
      createdAt: Date.now(),
      ...(digest.text ? { digest: digest.text } : {}),
      ...(via ? { via } : {}),
    });
    const sent = { prompt, text: conductorText, ...(digest.text ? { digest: digest.text } : {}) };
    this.inspector.promptSent(sent);
    // Before it's sent: the session can report its answer before send returns.
    if (this.modelOnTrial) this.modelOnTrial.sent = { ...sent, sessionId: conductor.sessionId };
    this.setStatus({ ...this.status, state: "busy" });
    try {
      await conductor.send(prompt);
      this.digest.drain(digest.upTo);
    } catch (error) {
      // It never reached the session, so no entry will match it (a retry is a message of its own).
      this.inspector.promptNotSent(sent);
      if (this.modelOnTrial?.sent?.prompt === prompt) delete this.modelOnTrial.sent;
      this.notice("error", `ARIA couldn't send that: ${message(error)}`, "send_failed");
      this.turnNotSent();
      // If the runtime is gone, that shows now instead of at the next check.
      if (this.runtimeWatch) this.watchRuntime(0);
    }
  }

  /** A prompt didn't reach the session, so no turn is coming. If the runtime went meanwhile, the status stays as it says. */
  private turnNotSent(): void {
    if (this.status.state === "busy") this.setStatus({ ...this.status, state: "ready" });
  }

  private slashDeps(): SlashCommandDeps {
    return {
      tracker: () => this.tracker,
      status: () => this.status,
      attention: () => this.attentionSettings(),
      setFocusMode: (focusMode) => this.setAttention({ focusMode }),
      tasks: () => this.tasks.list(),
      pendingItems: () => this.tasks.pendingItems(),
      cancelTask: async (taskId) => {
        const task = this.tasks.get(taskId);
        await this.tasks.cancel(taskId);
        if (task) this.digest.add(`You stopped "${task.title}" (${task.repoName}).`);
      },
      continueBudget: (ref, addCredits) => {
        const shortItem = this.tasks.byShortId(ref);
        let task: Task;
        if (shortItem) {
          if (shortItem.kind !== "budget") {
            throw new Error(`${ref} isn't a budget pause (it's a ${shortItem.kind}).`);
          }
          task = shortItem.task;
        } else {
          const slugMatch = /^@?([\w.-]+)$/.exec(ref.trim());
          const bySlug = slugMatch ? this.tasks.bySlug(slugMatch[1]!) : [];
          if (bySlug.length === 1) task = bySlug[0]!;
          else if (bySlug.length > 1) {
            throw new Error(`More than one task goes by @${slugMatch![1]}: ${bySlug.map((t) => `"${t.title}" (${t.repoName})`).join(", ")}.`);
          } else {
            task = this.tasks.find(ref);
          }
        }
        this.continueBudget(task.id, addCredits);
        return this.tasks.get(task.id)!;
      },
      watches: () => (this.watchers ? this.watchers.list() : []),
      github: () => this.watchers?.githubState() ?? { status: "off", inbox: false },
      unwatch: (ref) => {
        const found = this.watch.find(ref);
        if (!found) throw new Error(`There's no watch matching "${ref}".`);
        const ended = this.watch.end(found.id, "you");
        this.digest.addGitHub(`${found.id}:watch`, `[watch] You stopped watching ${ended.kind === "inbox" ? "the GitHub inbox" : digestText(ended.title, 80)}${ended.repoName ? ` on ${ended.repoName}` : ""} (${ended.shortId}).`);
        return ended;
      },
      reminders: () => (this.scheduler ? this.scheduler.listReminders() : []),
      todayTime: () => (this.timekeeper ? this.timekeeper.todaySummary() : undefined),
      dailyBudget: () => this.dailyBudgetState(),
      setDailyBudget: (credits) => this.setBudgetSettings({ dailyBudgetCredits: credits }),
      agents: () => this.catalog.agents ?? [],
      setTaskAgent: async (ref, agent) => {
        const slugMatch = /^@?([\w.-]+)$/.exec(ref.trim());
        const bySlug = slugMatch ? this.tasks.bySlug(slugMatch[1]!) : [];
        let target: Task;
        if (bySlug.length === 1) target = bySlug[0]!;
        else if (bySlug.length > 1) {
          throw new Error(`More than one task goes by @${slugMatch![1]}: ${bySlug.map((t) => `"${t.title}" (${t.repoName})`).join(", ")}.`);
        } else {
          target = this.tasks.find(ref);
        }
        return this.tasks.setAgent(target.id, agent);
      },
      skills: () => {
        const disabledSet = new Set(this.mcpConfigStore?.getState().disabledSkills ?? []);
        return (this.catalog.skills ?? []).map((s) => ({
          ...s,
          enabled: s.enabled !== false && !disabledSet.has(s.name),
        }));
      },
      runDoctor: () => this.runDoctor(),
      trackerCommand: (arg) => this.trackerCommand(arg),
      releases: () => this.releases(),
      appVersion: () => this.appVersion(),
    };
  }

  /** ARIA's system prompt from the template in use (Customize › Prompts) and your saved memories (Phase 6A, D23). */
  private conductorSystemPrompt(): string {
    const visibleIds = new Set(this.db.listRepos().filter((r) => !r.hidden).map((r) => r.id));
    const memory = conductorMemoryBlock(conductorNotes(this.db.listMemories(), visibleIds).shown);
    return conductorPrompt({ projectRoots: this.projectRoots, memory }, this.prompts.active("conductor"));
  }

  private conductorUsable(): boolean {
    return this.status.state !== "starting" && this.status.state !== "error";
  }

  /**
   * After you edit ARIA's system prompt, the conversation is reopened with it before your next message (resuming a
   * session applies a changed system message: spike 11). Only between turns: reopening would end a turn in progress.
   */
  private async ensureCurrentPrompt(): Promise<void> {
    // Its prompt changed, the tools you let it use (Customize › Integrations), or you signed in to one of its servers:
    // the session gets them when it opens.
    const outdated = () =>
      this.conductor !== undefined &&
      this.status.state === "ready" &&
      (this.conductorPromptText !== this.conductorSystemPrompt() || this.conductorOpenedWith !== this.integrations.ariaOpensWith() || this.conductorSignIns !== this.integrations.signInsConnected);
    if (!outdated()) return;
    await this.inConductorQueue(async () => {
      if (!outdated()) return;
      const old = this.conductor!;
      this.conductor = undefined;
      // The same session is resumed, so only once the old one has let go of it: a detach still on its way would close
      // the reopened conversation. One that takes too long reopens it when it's done (ARIA says it's reopening).
      const closing = old.disconnect().catch(this.logFailure("Closing ARIA's old session"));
      const closed = await within(this.options.shutdownWaitMs ?? DISCONNECT_WAIT_MS, () => closing);
      if (this.stopped) return;
      if (!closed) {
        // Every way of opening it waits for this (openConductor refuses until then).
        this.conductorClosing = closing;
        this.setStatus({ state: "starting", detail: "Reopening the conversation with your new settings" });
        void closing.then(() =>
          this.inConductorQueue(async () => {
            if (this.conductorClosing === closing) this.conductorClosing = undefined;
            if (this.stopped || this.conductor) return;
            await this.openConductor().catch((error: unknown) => {
              if (!this.stopped) this.setStatus({ state: "error", detail: message(error) });
            });
          }),
        );
        throw new Error("ARIA is still closing its conversation to reopen it with your new settings. Send it again in a moment.");
      }
      try {
        await this.openConductor();
      } catch (error) {
        if (!this.stopped) this.setStatus({ state: "error", detail: message(error) });
        throw error;
      }
    });
  }

  /**
   * Your message straight to a task, without ARIA (reply-to or @mention, PLAN.md §4.5): it answers the question the
   * task waits on, or else it's a message to the task. Approvals and rejections only happen with the card's buttons.
   * The chat shows it with where it went, and ARIA hears about it in its next digest.
   */
  async reply(input: { taskId: string; item?: { kind: "question" | "permission" | "plan"; id: string } | undefined; text: string; via?: "telegram" | undefined }): Promise<void> {
    const task = this.tasks.get(input.taskId);
    if (!task) throw new Error("That task doesn't exist anymore.");
    const text = input.text.trim();
    if (!text) throw new Error("Write something first.");
    if (input.item && input.item.kind !== "question") throw new Error("Use the card's buttons for that: a reply can't approve or reject.");
    const question = task.question;
    if (input.item && question?.id !== input.item.id) throw new Error("That question was already answered, or the task stopped waiting for it.");
    // Your newest message, wherever it went, is what ARIA's approvals are checked against.
    this.lastUserMessage = text;
    let routed: { action: RouteAction; shortId?: string; note?: string; noteTone?: "warning"; choice?: boolean };
    if (question) {
      // A choice in other letter case is that choice.
      const choice = question.choices?.find((c) => c.trim().toLowerCase() === text.toLowerCase());
      this.tasks.answer(task.id, question.id, choice ?? text, choice === undefined, "you");
      if (choice === undefined) this.rememberYours(task.id, { kind: "answer", text, questionId: question.id });
      routed = { action: "answer", shortId: question.shortId, ...(choice !== undefined ? { choice: true } : {}) };
      this.digest.add(`You answered ${question.shortId} from "${task.title}" directly: ${quote(choice ?? text)}`);
    } else {
      const outcome = await this.tasks.message(task.id, text, false, undefined, this.yourPaths(text));
      this.rememberYours(task.id, { kind: "message", text });
      // A "yes" to a task that waits for a decision is only a message: say so, next to it.
      const undecided = [task.plan?.shortId, ...(task.permissions ?? []).map((p) => p.shortId)].filter((id): id is string => Boolean(id));
      const note = undecided.length
        ? `This doesn't decide ${undecided.join(" or ")}: use the buttons on ${undecided.length === 1 ? "its card" : "their cards"}.`
        : MESSAGE_ROUTE_NOTES[outcome];
      routed = { action: "message", ...(note ? { note } : {}), ...(undecided.length ? { noteTone: "warning" as const } : {}) };
      this.digest.add(`You told "${task.title}" directly: ${quote(text)}`);
    }
    this.addToTimeline({
      kind: "chat",
      id: randomUUID(),
      role: "user",
      content: text,
      createdAt: Date.now(),
      routedTo: { taskId: task.id, title: task.title, ...routed },
      ...(input.via ? { via: input.via } : {}),
    });
    if (input.via === "telegram") {
      const confirmText =
        routed.action === "answer"
          ? `↩ Answered ${routed.shortId ?? "question"} on "${task.title}".`
          : `↩ Sent to "${task.title}"${routed.note ? ` (${routed.note})` : ""}.`;
      void this.telegram.onAssistantReply(confirmText);
    }
  }

  getState(): AppState {
    const trackerInfo = windowTrackerInfo(this.tracker);
    return {
      status: this.status,
      ...(trackerInfo ? { tracker: trackerInfo } : {}),
      timeline: this.store ? this.db.listTimeline() : [],
      projects: this.store ? this.db.listRepos() : [],
      projectRoots: this.projectRoots,
      models: this.listModels(),
      conductor: this.store ? this.conductorSettings() : {},
      ui: this.store ? (this.db.getSetting<UiState>("ui") ?? DEFAULT_UI) : DEFAULT_UI,
      tasks: this.store ? this.tasks.list() : [],
      profiles: this.store ? this.profiles.list() : [],
      profilePolicy: this.store ? this.profiles.policy() : "me",
      ...(this.store && this.profiles.ciFixId() ? { ciFixProfileId: this.profiles.ciFixId()! } : {}),
      policy: this.store ? this.policySettings() : { rules: [], sandbox: { ...this.sandboxSupport, enabled: true, allowedHosts: [], allowedPaths: [] } },
      attention: this.attentionSettings(),
      memory: this.store ? this.memoryState() : { memories: [], templateUsesMemory: true, leftOut: [] },
      integrations: this.integrationsState(),
      watches: this.store && this.watchers ? this.watchers.list() : [],
      github: this.watchers?.githubState() ?? { status: "off", inbox: false },
      timeRules: this.store ? this.db.listTimeRules(this.tracker.id) : [],
      timekeeper: this.store ? this.timekeeperSettings() : DEFAULT_TIMEKEEPER_SETTINGS,
      ...(this.store && this.timekeeper ? { todayTime: this.timekeeper.todaySummary() } : {}),
      utility: this.store ? this.utilitySettings() : { enabled: false },
      routines: this.store && this.scheduler ? this.scheduler.listRoutines() : [],
      reminders: this.store && this.scheduler ? this.scheduler.listReminders() : [],
      telegram: this.telegram.getStatus(),
      ...(this.store ? { budget: this.dailyBudgetState() } : {}),
      appVersion: this.appVersion(),
      onboarding: this.onboardingState(),
      releases: [...this.releases()],
      ...(this.availableUpdateInfo ? { availableUpdate: this.availableUpdateInfo } : {}),
      ...(this.latestDoctorReport ? { doctor: this.latestDoctorReport } : {}),
    };
  }

  // ── GitHub watches (PLAN.md §4.6) ───────────────────────────────────────────────────────────────────────────
  // The work is in github/github.ts; the rest of the engine (stopping, the tools, the tests) reaches it through these.

  private get githubAccess(): GitHubAccess | undefined {
    return this.github.githubAccess;
  }

  private get watchers(): Watchers | undefined {
    return this.github.watchers;
  }

  private get trackerWatcher(): TrackerWatcher | undefined {
    return this.github.trackerWatcher;
  }

  private get outlookWatcher(): OutlookWatcher | undefined {
    return this.github.outlookWatcher;
  }

  private get myWorkList(): MyWork | undefined {
    return this.github.myWorkList;
  }

  private get prs(): PullRequests | undefined {
    return this.github.prs;
  }

  private get fixes(): CiFixes | undefined {
    return this.github.fixes;
  }

  private get dispatches(): WorkflowDispatches | undefined {
    return this.github.dispatches;
  }

  private get watch(): Watchers {
    return this.github.watch;
  }

  confirmWorkflowDispatch(input: { cardId: string; revision: number; ref?: string; inputs?: Record<string, string> }): Promise<void> {
    return this.github.confirmWorkflowDispatch(input);
  }

  dismissWorkflowDispatch(cardId: string): void {
    this.github.dismissWorkflowDispatch(cardId);
  }

  unwatch(watchId: number): void {
    this.github.unwatch(watchId);
  }

  retryGitHub(): Promise<GitHubState> {
    return this.github.retryGitHub();
  }

  retryInbox(): void {
    this.github.retryInbox();
  }

  setInboxWatch(on: boolean): Promise<GitHubState> {
    return this.github.setInboxWatch(on);
  }

  useGitHubAccount(cardId: string): void {
    this.github.useGitHubAccount(cardId);
  }

  switchGitHubAccount(cardId: string): Promise<void> {
    return this.github.switchGitHubAccount(cardId);
  }

  watchDefaultBranch(repoId: number): Promise<Watch> {
    return this.github.watchDefaultBranch(repoId);
  }

  myWork(refresh: boolean): Promise<MyWorkState> {
    return this.github.myWork(refresh);
  }

  watchPullRequest(key: string): Promise<Watch> {
    return this.github.watchPullRequest(key);
  }

  /** The PC woke up or was unlocked (from the shell): the watchers and scheduler look at what's due at once. */
  systemResumed(): void {
    if (this.stopped) return;
    this.watchers?.wake();
    this.trackerWatcher?.wake();
    this.outlookWatcher?.wake();
    this.scheduler?.wake();
  }

  // ── attention (PLAN.md §4.5, §5.5, D25) ─────────────────────────────────────────────────────────────────────

  /**
   * From the shell: whether you're there (the window in front and focused, the screen unlocked, the PC awake, not
   * idle). `since`: when that changed, if earlier than now (you went idle a while ago). `locked`: away because the
   * screen is locked (toasts wait for the unlock). Fine before start().
   */
  setPresence(present: boolean, since?: number, locked = false): void {
    if (this.stopped) return;
    this.attention.setPresence(present, since, locked);
  }

  /** Whether the database is open, so what's read from it is what you've set rather than the defaults. */
  isOpen(): boolean {
    return this.store !== undefined;
  }

  attentionSettings(): AttentionSettings {
    const stored = this.store ? this.db.getSetting<Partial<AttentionSettings>>("attention.settings") : undefined;
    const {
      hasVoiceCloudApiKey: _ignoreVoice,
      hasNtfyToken: _ignoreNtfy,
      hasPushoverCredentials: _ignorePushover,
      hasTelegramBotToken: _ignoreTelegram,
      ...rest
    } = stored ?? {};
    return {
      ...DEFAULT_ATTENTION,
      ...rest,
      hasVoiceCloudApiKey: this.voice.hasCloudApiKey(),
      hasNtfyToken: this.phone.hasNtfyToken(),
      hasPushoverCredentials: this.phone.hasPushoverCredentials(),
      hasTelegramBotToken: this.telegram.hasBotToken(),
    };
  }

  setAttention(patch: Partial<AttentionSettings>): AttentionSettings {
    const cleanPatch = { ...patch };
    delete cleanPatch.hasVoiceCloudApiKey;
    delete cleanPatch.hasNtfyToken;
    delete cleanPatch.hasPushoverCredentials;
    delete cleanPatch.hasTelegramBotToken;
    if (cleanPatch.voiceCloudEndpoint !== undefined) {
      const trimmed = cleanPatch.voiceCloudEndpoint.trim();
      cleanPatch.voiceCloudEndpoint = trimmed ? normalizeVoiceCloudEndpoint(trimmed) : "";
    }
    if (cleanPatch.ntfyServerUrl !== undefined) {
      const trimmed = cleanPatch.ntfyServerUrl.trim();
      cleanPatch.ntfyServerUrl = trimmed ? normalizeNtfyServerUrl(trimmed) : DEFAULT_ATTENTION.ntfyServerUrl ?? "https://ntfy.sh";
    }
    const {
      hasVoiceCloudApiKey: _ignoreVoice,
      hasNtfyToken: _ignoreNtfy,
      hasPushoverCredentials: _ignorePushover,
      hasTelegramBotToken: _ignoreTelegram,
      ...current
    } = this.attentionSettings();
    const toStore = { ...current, ...cleanPatch };
    this.db.setSetting("attention.settings", toStore);
    const settings = this.attentionSettings();
    this.emit({ type: "attention", settings });
    if (this.runtimeReady && !this.stopped) {
      this.telegram.sync();
    }
    if (!this.stopped) {
      this.outlookWatcher?.wake();
    }
    return settings;
  }

  /** Reads or writes an encrypted setting blob (used by the desktop main process for `safeStorage` ciphertext). */
  getEncryptedSetting(key: string): string | undefined {
    if (!this.store) return undefined;
    const val = this.db.getSetting<{ ciphertext?: string }>(`encrypted.${key}`);
    return typeof val?.ciphertext === "string" && val.ciphertext.length > 0 ? val.ciphertext : undefined;
  }

  setEncryptedSetting(key: string, ciphertext: string | null): void {
    const storageKey = `encrypted.${key}`;
    if (ciphertext && ciphertext.length > 0) {
      this.db.setSetting(storageKey, { ciphertext });
    } else {
      this.db.setSetting(storageKey, {});
    }
  }

  setVoiceCloudApiKey(apiKey: string | null): AttentionSettings {
    this.voice.setCloudApiKey(apiKey);
    const settings = this.attentionSettings();
    this.emit({ type: "attention", settings });
    return settings;
  }

  setPhonePushSecrets(input: z.infer<typeof SetPhonePushSecretsInput>): AttentionSettings {
    this.phone.setSecrets(input);
    const settings = this.attentionSettings();
    this.emit({ type: "attention", settings });
    return settings;
  }

  testPhonePush(): Promise<{ ok: boolean; error?: string }> {
    return this.phone.test();
  }

  setTelegramBotToken(botToken: string | null): AttentionSettings {
    this.telegram.setBotToken(botToken);
    const settings = this.attentionSettings();
    this.emit({ type: "attention", settings });
    return settings;
  }

  testTelegramRelay(): Promise<{ ok: boolean; botUsername?: string; error?: string }> {
    return this.telegram.test();
  }

  telegramStatus(): TelegramRelayStatus {
    return this.telegram.getStatus();
  }

  transcribeAudio(input: { audioBase64: string; mimeType?: string }): Promise<{ text: string }> {
    return this.voice.transcribeAudio(input);
  }

  synthesizeSpeech(input: { text: string }): Promise<{ audioBase64: string; mimeType: string }> {
    return this.voice.synthesizeSpeech(input);
  }

  // ── the inspector (PLAN.md §5.3) ────────────────────────────────────────────────────────────────────────────

  /**
   * The last `turns` of your messages and what followed each. `reload` reads the session again (the inspector opens);
   * otherwise what's held is used ("Show more"). While the conversation reopens (a new prompt), what's held is kept.
   */
  conductorTranscript(input: { turns?: number | undefined; reload?: boolean | undefined } = {}): Promise<ConductorTranscript> {
    return this.inspector.conductorTranscript(this.conductor, input);
  }

  /** The inspector closed: nothing is held anymore. */
  releaseConductorTranscript(): void {
    this.inspector.release();
  }

  private log(text: string): void {
    const cleaned = redactText(text);
    this.fileLogger?.warn("engine", cleaned);
    if (this.options.log) {
      this.options.log(cleaned);
    } else if (!this.fileLogger) {
      console.warn(cleaned);
    }
  }

  /** For a step whose failure mustn't stop what called it: it's logged, so it can be traced afterwards. */
  private logFailure(step: string): (error: unknown) => void {
    return (error) => this.log(`${step} failed: ${message(error)}`);
  }

  /** Returns a subsystem-scoped diagnostic logger (Phase 9). */
  logger(subsystem = "aria"): Logger | undefined {
    return this.fileLogger?.child(subsystem);
  }

  budgetSettings(): BudgetSettings {
    return this.dailyBudget.budgetSettings();
  }

  dailyBudgetState(): DailyBudgetState {
    return this.dailyBudget.dailyBudgetState();
  }

  setBudgetSettings(patch: { dailyBudgetCredits?: number | null; budgetWarningPercent?: number }): DailyBudgetState {
    return this.dailyBudget.setBudgetSettings(patch);
  }

  // ── Customize › Data (D1) ───────────────────────────────────────────────────────────────────────────────────

  private get retentionRunner(): TranscriptRetentionRunner {
    if (!this.retention) throw new Error("ARIA engine isn't started");
    return this.retention;
  }

  dataState(): DataState {
    return this.retentionRunner.state();
  }

  setTranscriptRetention(patch: { enabled?: boolean | undefined; keepDays?: number | undefined }): DataState {
    this.retentionRunner.setSettings(patch);
    return this.dataState();
  }

  /** "Clean up now": with the days set, also when the daily clean-up is off. */
  async cleanUpTranscripts(): Promise<DataState> {
    await this.retentionRunner.cleanUp();
    return this.dataState();
  }

  // ── models ──────────────────────────────────────────────────────────────────────────────────────────────────

  listModels(): ModelOption[] {
    return this.models.map((m) => ({ ...m }));
  }

  /**
   * The Conductor's model and effort: the stored choice if the runtime still offers it (an unsupported effort falls back
   * to the model's default), else the configured default, else the cheapest enabled lightweight model at its lowest
   * effort. Before the catalog is loaded, the stored choice as is.
   */
  conductorSettings(): ConductorSettings {
    const stored = this.store ? this.db.getSetting<ConductorSettings>("conductor.settings") : undefined;
    const defaultProfileModel = this.store && this.profilesStore ? this.profilesStore.default()?.model : undefined;
    return conductorSettingsFrom(stored, this.models, this.options.defaultModel ?? defaultProfileModel);
  }

  /**
   * Validated in ARIA's own code: the runtime's allowedModels silently substitutes instead of rejecting (Phase 0).
   * Changes are applied one at a time, in the order they were asked for, after the conversation has opened.
   */
  setConductorModel(input: { model: string; reasoningEffort?: string }): Promise<void> {
    return this.inConductorQueue(() => this.applyConductorModel(input));
  }

  private async applyConductorModel(input: { model: string; reasoningEffort?: string }): Promise<void> {
    const model = this.models.find((m) => m.id === input.model);
    if (!model || !model.enabled) throw new Error(`${input.model} isn't an available model.`);
    let effort = input.reasoningEffort;
    if (model.efforts.length === 0) effort = undefined;
    else if (!effort || !model.efforts.includes(effort)) throw new Error(`${model.name} supports these effort levels: ${model.efforts.join(", ")}.`);
    const settings: ConductorSettings = { model: model.id, ...(effort ? { reasoningEffort: effort } : {}) };
    // Switch the live session first so a failed switch isn't saved as the choice.
    let reported: string | undefined;
    const switchedFrom = this.conductor ? this.status.model : undefined;
    if (this.conductor) {
      const switching: { id: string; reported?: string } = { id: model.id };
      this.pendingModel = switching;
      try {
        await this.conductor.setModel(model.id, effort);
      } finally {
        this.pendingModel = undefined;
      }
      reported = switching.reported;
    }
    if (this.stopped) return;
    this.db.setSetting("conductor.settings", settings);
    this.emit({ type: "settings", conductor: settings });
    if (this.conductor) {
      // If the runtime reported a different model during the switch, the status already shows it (with a D15 warning).
      if (!reported || reported === model.id) {
        this.setStatus({ ...this.status, model: model.id, ...(effort ? { reasoningEffort: effort } : { reasoningEffort: undefined }) } as ConductorStatus);
        // Another model now continues this conversation: until it has answered once, a failed first answer moves it to a
        // fresh conversation (leaveForFreshConversation).
        if (switchedFrom !== model.id) this.modelOnTrial = { model: model.id };
      }
    } else if (this.runtimeReady && !this.conductorClosing) {
      // No conversation although the runtime is up: opening it failed (opening only happens in this queue, so it isn't
      // still in progress). Try again with the new choice instead of asking for a restart. (While the previous one is
      // still closing, the reopen that follows picks up the new choice.)
      try {
        await this.openConductor();
      } catch (error) {
        if (!this.stopped) this.setStatus({ state: "error", detail: message(error) });
        throw error;
      }
    }
  }

  // ── projects ────────────────────────────────────────────────────────────────────────────────────────────────

  private saveRepo(info: RepoInfo, addedVia: Project["addedVia"]): Project {
    return this.db.upsertRepo({
      name: info.name,
      path: info.path,
      ...(info.host ? { host: info.host } : {}),
      ...(info.owner ? { owner: info.owner } : {}),
      ...(info.repo ? { repo: info.repo } : {}),
      ...(info.upstream ? { upstream: info.upstream } : {}),
      ...(info.defaultBranch ? { defaultBranch: info.defaultBranch } : {}),
      ...(info.kind === "folder" ? { kind: "folder" as const } : {}),
      addedVia,
    });
  }

  private emitProjects(): Project[] {
    const projects = this.db.listRepos();
    this.emit({ type: "projects", projects });
    return projects;
  }

  async rescanProjects(): Promise<Project[]> {
    const found = await scanRoots(this.projectRoots, { exclude: this.options.excludePaths ?? [] });
    for (const info of found) this.saveRepo(info, "scan");
    return this.emitProjects();
  }

  async addProjectRoot(folder: string): Promise<string[]> {
    const trimmed = folder.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) throw new Error("Give an absolute folder path for the project folder.");
    const resolved = path.resolve(trimmed);
    if (!existsSync(resolved)) throw new Error(`${resolved} doesn't exist.`);
    if ((this.options.excludePaths ?? []).some((x) => samePath(x, resolved))) throw new Error("That's ARIA's own repository.");
    const current = this.projectRoots;
    const next = [resolved, ...current.filter((r) => !samePath(r, resolved))];
    this.db.setSetting("projects.roots", next);
    this.emit({ type: "project_roots", projectRoots: next });
    await this.rescanProjects();
    return next;
  }

  async removeProjectRoot(folder: string): Promise<string[]> {
    const trimmed = folder.trim();
    const resolved = path.resolve(trimmed);
    const next = this.projectRoots.filter((r) => !samePath(r, resolved));
    this.db.setSetting("projects.roots", next);
    this.emit({ type: "project_roots", projectRoots: next });
    return next;
  }

  async addProjectFolder(folder: string): Promise<Project> {
    const resolved = path.resolve(folder);
    if ((this.options.excludePaths ?? []).some((x) => samePath(x, resolved))) throw new Error("That's ARIA's own repository.");
    const info = await readFolderInfo(resolved);
    const project = this.saveRepo(info, "local");
    this.emitProjects();
    return project;
  }

  removeProject(repoId: number): Project[] {
    const project = this.db.getRepo(repoId);
    if (!project) throw new Error("That project doesn't exist.");
    if (!project.hidden) {
      this.db.setRepoHidden(repoId, true);
      if (this.watchers) {
        for (const w of this.watchers.list()) {
          if (w.repoId === repoId && w.state === "active") {
            this.watchers.end(w.id, "you");
          }
        }
      }
      this.emitMemories();
    }
    return this.emitProjects();
  }

  async cloneProject(url: string): Promise<Project> {
    const root = this.projectRoots[0];
    if (!root) throw new Error("No project folder is configured to clone into.");
    const project = this.saveRepo(await cloneRepo(url, root), "url");
    this.emitProjects();
    return project;
  }

  async createProject(options: {
    name: string;
    visibility?: "private" | "public" | "internal";
    description?: string;
    addReadme?: boolean;
    gitignore?: string;
    license?: string;
    localOnly?: boolean;
    rootFolder?: string;
  }): Promise<Project> {
    const root = options.rootFolder ? path.resolve(options.rootFolder) : this.projectRoots[0];
    if (!root) throw new Error("No project folder is configured to create repositories in.");
    if (!existsSync(root)) {
      await mkdir(root, { recursive: true });
    }
    const ghCandidates = findGh(process.env);
    const ghPath = ghCandidates[0];
    const info = await createRepo({
      ...options,
      root,
      ghPath,
      env: process.env,
    });
    const project = this.saveRepo(info, options.localOnly ? "local" : "url");
    this.emitProjects();
    return project;
  }

  // ── UI state ────────────────────────────────────────────────────────────────────────────────────────────────

  setUiState(patch: Partial<UiState>): UiState {
    const next = { ...(this.db.getSetting<UiState>("ui") ?? DEFAULT_UI), ...patch };
    this.db.setSetting("ui", next);
    return next;
  }

  // ── guards: what needs your own words (grounding and policy) ────────────────────────────────────────────────
  // Whatever ARIA reads can end up in what it writes, so its tools act only on your latest message, and never during a
  // scheduled routine's turn. Every check on its tools is in this section, and the tools below it call them. Your
  // message is noted by sendMessage, reply, messageTask and answerQuestion; a routine's turn is set by runPromptRoutine
  // and ends on the session's idle or error, or when the runtime is lost. The grounding rules: memory/ and scheduler/.

  /** Your latest chat message: under the "me" profile policy, ARIA may only use a profile you named in it. */
  private lastUserMessage = "";
  /** Your latest message sent to ARIA (the Conductor), used to ground `remember`, `forget`, `remind_me`, and `schedule_routine` calls (D63, D65). */
  private lastConductorUserMessage = "";
  /** Active scheduled `"prompt"` routine turn on the Conductor, blocking user-gated actions and capturing session errors (D65). */
  private activeRoutineTurn: { error?: string; reply?: string } | undefined;

  private get inAutomatedTurn(): boolean {
    return this.activeRoutineTurn !== undefined;
  }

  /**
   * Approvals through ARIA need your own words: your latest message (to ARIA, or straight to a task) has to name the
   * item ("approve P-2"). Content ARIA reads (files, mails, task output) can't approve anything on your behalf (an
   * injection guard).
   */
  private assertNamedByUser(shortId: string, verb: string): void {
    if (this.inAutomatedTurn) {
      throw new Error(`Not done: automated routine turns cannot ${verb} ${shortId}.`);
    }
    const [kind, number] = shortId.split("-");
    const named = new RegExp(`(^|[^\\p{L}\\p{N}])${kind}\\s*-?\\s*${number}($|[^\\p{L}\\p{N}])`, "iu").test(this.lastUserMessage);
    if (!named) {
      throw new Error(
        `Not done: to ${verb} ${shortId}, the user has to name it in their own message (for example "${verb} ${shortId}"), or press the button on its card. Ask them; don't do it on your own.`,
      );
    }
  }

  /** A pending item of this kind by its short id, for ARIA's tools. */
  private pendingOf(id: string, kind: "permission" | "plan" | "budget") {
    const item = this.tasks.byShortId(id);
    if (!item || item.kind !== kind) throw new Error(`${id} isn't a ${kind === "permission" ? "permission request" : kind === "plan" ? "plan" : "budget pause"} that's waiting. What's waiting is in <pending>.`);
    const shortId = kind === "permission" ? item.task.permissions?.find((p) => p.id === item.itemId)?.shortId : kind === "plan" ? item.task.plan?.shortId : item.task.budgetShortId;
    return { ...item, shortId: shortId ?? id };
  }

  /** The paths in your own words that a task gets to read (never your credentials or ARIA's own data). */
  private yourPaths(text: string): string[] {
    return grantablePaths(extractBriefPaths(text), [this.options.dataDir]);
  }

  /**
   * What ARIA may hand a task to read: only what your latest message to it named. What ARIA writes can carry words
   * from a file, a mail or a web page, so a path in it grants nothing by itself (an injection guard).
   */
  private groundedPaths(asked: readonly string[]): string[] {
    if (this.inAutomatedTurn) return [];
    return grantablePaths(asked, [this.options.dataDir]).filter((p) => namesPath(this.lastConductorUserMessage, p));
  }

  /** create_repo: your latest message has to ask for it by name (an injection guard). The window's own form doesn't come through here. */
  private async createProjectTool(input: Parameters<AriaEngine["createProject"]>[0]): Promise<Project> {
    if (this.inAutomatedTurn) throw new Error("Not created: automated routine turns cannot create repositories.");
    assertCreateGrounded(this.lastConductorUserMessage, input);
    const { rootFolder: _windowOnly, ...options } = input;
    return this.createProject(options);
  }

  /** clone_repo: your latest message has to name the repository (an injection guard). */
  private async cloneProjectTool(url: string): Promise<Project> {
    if (this.inAutomatedTurn) throw new Error("Not cloned: automated routine turns cannot clone repositories.");
    assertCloneGrounded(this.lastConductorUserMessage, url);
    return this.cloneProject(url);
  }

  /**
   * Phase 6A (`remember` tool, completing D23): ARIA saves or updates a one-line preference or project fact in
   * response to your message. Grounded against `lastUserMessage` (D63) and announced with a timeline notice so no
   * memory change is ever silent.
   */
  rememberMemory(input: { text: string; repo?: string; id?: string }): { memory: Memory; updated: boolean } {
    if (this.inAutomatedTurn) {
      throw new Error("Not saved: automated routine turns cannot modify memories.");
    }
    const text = input.text.trim();
    const problem = memoryProblem(text);
    if (problem) throw new Error(problem);
    const project = input.repo ? this.resolveProject(input.repo) : undefined;
    assertMemoryGrounded(this.lastConductorUserMessage, text, project?.name);
    const scope: MemoryScope = project ? "project" : "global";
    const repoId = project?.id;
    const source: MemorySource = { kind: "aria", at: Date.now() };
    let saved: Memory;
    let updated = false;
    if (input.id) {
      const existing = this.db.getMemory(input.id.trim());
      if (!existing) throw new Error(`There's no memory with id "${input.id.trim()}".`);
      saved = this.db.saveMemory({ id: existing.id, scope, repoId, text, source });
      updated = true;
    } else {
      const existing = this.db
        .listMemories()
        .find((m) => m.scope === scope && m.repoId === repoId && m.text.toLowerCase() === text.toLowerCase());
      if (existing) {
        saved = this.db.saveMemory({ id: existing.id, scope, repoId, text, source });
        updated = true;
      } else {
        if (this.db.listMemories().length >= MEMORIES_MAX) {
          throw new Error(`You have ${MEMORIES_MAX} notes, the most ARIA keeps: delete or forget one first.`);
        }
        saved = this.db.saveMemory({ id: randomUUID(), scope, repoId, text, source });
      }
    }
    this.emitMemories();
    this.notice(
      "info",
      `ARIA ${updated ? "updated the memory" : "remembered"}${project ? ` for ${project.name}` : ""}: “${saved.text}”.`,
      "memory_remembered",
    );
    return { memory: saved, updated };
  }

  /**
   * Phase 6A (`forget` tool, completing D23): ARIA removes a saved memory by its `id` or matching `query` text.
   * Grounded against `lastUserMessage` (D63) and announced with a timeline notice.
   */
  forgetMemory(input: { id?: string; query?: string; repo?: string }): Memory {
    if (this.inAutomatedTurn) {
      throw new Error("Not removed: automated routine turns cannot modify memories.");
    }
    const id = input.id?.trim();
    const query = input.query?.trim();
    if (!id && !query) throw new Error("Give the memory's id or text to forget.");
    const project = input.repo ? this.resolveProject(input.repo) : undefined;
    const all = this.db.listMemories();
    const pool = project ? all.filter((m) => m.scope === "project" && m.repoId === project.id) : all;
    let target: Memory | undefined;
    if (id) {
      target = pool.find((m) => m.id === id);
      if (!target) throw new Error(`There's no saved memory${project ? ` for ${project.name}` : ""} with id "${id}".`);
    } else if (query) {
      const q = query.toLowerCase();
      const exact = pool.filter((m) => m.text.toLowerCase() === q);
      const matches = exact.length > 0 ? exact : pool.filter((m) => m.text.toLowerCase().includes(q));
      if (matches.length === 0) {
        throw new Error(`No saved memory${project ? ` for ${project.name}` : ""} matches "${query}".`);
      }
      if (matches.length > 1) {
        const list = matches.map((m) => `[${m.id}] (${m.repoName ?? "global"}) "${m.text}"`).join("; ");
        throw new Error(`Several memories match "${query}": ${list}. Pass the id of the one to forget.`);
      }
      target = matches[0]!;
    }
    assertForgetGrounded(this.lastConductorUserMessage, target!);
    this.db.deleteMemory(target!.id);
    this.emitMemories();
    this.notice(
      "info",
      `ARIA forgot${target!.repoName ? ` (${target!.repoName})` : ""}: “${target!.text}”.`,
      "memory_forgotten",
    );
    return target!;
  }

  private remindMeTool(input: { text: string; inMinutes?: number; at?: string }): Reminder {
    if (this.inAutomatedTurn) {
      throw new Error("Not scheduled: automated routine turns cannot schedule reminders.");
    }
    assertReminderGrounded(this.lastConductorUserMessage, input.text, {
      ...(input.inMinutes !== undefined ? { inMinutes: input.inMinutes } : {}),
      ...(input.at !== undefined ? { at: input.at } : {}),
    });
    return this.schedulerRunner.createReminder({ ...input, createdBy: "aria" });
  }

  private scheduleRoutineTool(input: {
    id?: string;
    name: string;
    cron: string;
    prompt?: string;
    enabled?: boolean;
  }): Routine {
    if (this.inAutomatedTurn) {
      throw new Error("Not scheduled: automated routine turns cannot schedule or modify routines.");
    }
    assertRoutineGrounded(this.lastConductorUserMessage, input.name, input.prompt);
    return this.schedulerRunner.saveRoutine({ ...input, createdBy: "aria" });
  }

  // ── the Conductor's tools ───────────────────────────────────────────────────────────────────────────────────

  private conductorToolset(): AnyAriaTool[] {
    return conductorTools({
      tracker: () => this.tracker,
      listProjects: () => this.db.listRepos(),
      registerProject: (folder) => this.addProjectFolder(folder),
      createProject: (options) => this.createProjectTool(options),
      cloneProject: (url) => this.cloneProjectTool(url),
      tasks: this.taskToolDeps(),
      watches: this.github.watchToolDeps(),
      actions: this.actionToolDeps(),
      time: this.timeToolDeps(),
      memory: this.memoryToolDeps(),
      scheduler: this.schedulerToolDeps(),
    });
  }

  private schedulerToolDeps(): SchedulerToolDeps {
    return {
      remindMe: (input) => this.remindMeTool(input),
      scheduleRoutine: (input) => this.scheduleRoutineTool(input),
    };
  }

  private memoryToolDeps(): MemoryToolDeps {
    return {
      remember: (input) => this.rememberMemory(input),
      forget: (input) => this.forgetMemory(input),
    };
  }

  private timeToolDeps(): TimeToolDeps {
    return {
      listActivities: (input) => {
        const repoId = input.repo ? this.resolveProject(input.repo).id : undefined;
        return this.listActivities({
          ...(input.since !== undefined ? { since: input.since } : {}),
          ...(input.until !== undefined ? { until: input.until } : {}),
          ...(repoId !== undefined ? { repoId } : {}),
          ...(input.source ? { source: input.source } : {}),
          ...(input.scanGit !== undefined ? { scanGit: input.scanGit } : {}),
        });
      },
      listRules: () => this.listTimeRules(),
      saveRule: (input) => {
        const project = input.repo ? this.resolveProject(input.repo) : undefined;
        return this.saveTimeRule({
          ...(input.id ? { id: input.id } : {}),
          kind: input.kind,
          ...(project ? { repoId: project.id } : {}),
          pattern: project && !input.pattern.trim() ? project.name : input.pattern,
          ...(input.matchMode ? { matchMode: input.matchMode } : {}),
          ...(input.trackerTaskId !== undefined ? { trackerTaskId: input.trackerTaskId } : {}),
          ...(input.trackerTaskTitle ? { trackerTaskTitle: input.trackerTaskTitle } : {}),
          ...(input.defaultMinutes !== undefined ? { defaultMinutes: input.defaultMinutes } : {}),
          createdFrom: "you",
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        });
      },
      deleteRule: (id) => this.deleteTimeRule(id),
      prepareTimesheet: (date) => this.prepareTimesheet(date),
      getTimesheet: (date) => this.timekeeperRunner.getTimesheet(date),
      updateTimesheetEntry: (input) =>
        this.updateTimesheetEntry({
          date: input.date ?? this.timekeeperRunner.todayIso(),
          ...(input.entryId ? { entryId: input.entryId } : {}),
          ...(input.start ? { start: input.start } : {}),
          ...(input.end ? { end: input.end } : {}),
          ...(input.minutes !== undefined ? { minutes: input.minutes } : {}),
          ...(input.trackerTaskId ? { trackerTaskId: input.trackerTaskId } : {}),
          ...(input.trackerTaskTitle ? { trackerTaskTitle: input.trackerTaskTitle } : {}),
          ...(input.trackerProjectId ? { trackerProjectId: input.trackerProjectId } : {}),
          ...(input.trackerCustomerId ? { trackerCustomerId: input.trackerCustomerId } : {}),
          comment: input.comment,
        }),
    };
  }

  private actionToolDeps(): ActionToolDeps {
    return {
      list: (filter) => this.actionRunner.listTools(filter),
      propose: (input) => {
        const card = this.actionRunner.propose(input);
        return {
          shortId: card.payload.shortId,
          cardId: card.id,
          server: card.payload.server,
          tool: card.payload.tool,
          wireName: card.payload.wireName,
          cls: card.payload.cls,
        };
      },
    };
  }

  private get actionRunner(): ActionRunner {
    if (!this.actions) throw new Error("ARIA engine isn't started");
    return this.actions;
  }

  /** Your click on Send / Run on an Action-request card (Phase 5A, PLAN.md §4.13, D19, D22). */
  async confirmAction(input: { cardId: string; revision: number; argsJson?: string; confirmedDestructive?: boolean }): Promise<void> {
    await this.actionRunner.confirm(input);
  }

  /** Your click on Cancel on an Action-request card. */
  cancelAction(cardId: string): void {
    this.actionRunner.cancel(cardId, "you");
  }

  /** Picks the active tracker from the saved choice. A tracker given in the options (tests) is used as it is. */
  private chooseTrackerAtStart(): void {
    this.readTrackerFolder();
    if (!this.options.tracker) {
      const chosen = chooseTracker(this.options.dataDir, readTrackerChoice(this.db), dataTrackerId(this.db), this.options.trackerConfig);
      this.activeTracker = chosen.active;
      this.tracker = chosen.active.tracker;
      this.trackerError = chosen.error;
      if (chosen.notice) this.notice("warning", chosen.notice, "tracker_config");
    }
    this.refreshToolSets();
    this.noteDataTracker();
  }

  /** Reads the trackers folder again, and with it the tool sets that are the union over its configs. */
  private readTrackerFolder(): ConfigListing[] {
    this.trackerListing = listTrackerConfigs(this.options.dataDir);
    this.refreshToolSets();
    return this.trackerListing;
  }

  private refreshToolSets(): void {
    this.toolSets = unionToolSets([this.tracker], this.trackerListing);
  }

  /**
   * What the Integrations view says is wrong with the config the setting names: it didn't load at start, or its file has
   * gone wrong since (the version that was loaded stays in use). Undefined when nothing is.
   */
  private trackerProblem(): string | undefined {
    if (this.trackerError) return this.trackerError;
    const file = this.activeTracker.source === "config" ? this.activeTracker.file : undefined;
    if (!file) return undefined;
    const current = this.trackerListing.find((c) => c.file === file);
    if (!current) return `${file} is no longer in the trackers folder. The version that was loaded stays in use.`;
    return current.ok ? undefined : `${file} has an error: ${current.errors[0] ?? "it is invalid"}. The version that was loaded stays in use.`;
  }

  /** Records the active tracker's id as the one whose data the store holds, keeping the rest of the choice. */
  private noteDataTracker(): void {
    // No tracker stores nothing: `none` is never a tracker's id, and the id of the last real one stays.
    if (isNoTracker(this.tracker)) return;
    const choice = readTrackerChoice(this.db);
    if (choice.dataId !== this.tracker.id) writeTrackerChoice(this.db, { ...choice, dataId: this.tracker.id });
  }

  /**
   * What a switch to `choice` would give: the tracker, or why it is refused, and what another tracker's data
   * would come to (`purge`: the window asks whether to keep it, dormant, or clear it). Nothing changes. It can be the
   * tracker of ARIA's data (no `config`), any config of the trackers folder, or none (`config: null`, which never asks); the
   * whole switch is refused while the Timekeeper is working, since a prepare or a submit finishes with the reader it
   * started with.
   */
  private planTrackerChange(
    choice: TrackerChoice,
  ): { ok: true; next: ActiveTracker; servers: string[] | undefined; purge?: NonNullable<TrackerChangePreview["purge"]> } | { ok: false; error: string } {
    if (!this.store) return { ok: false, error: "ARIA is still starting." };
    if (this.timekeeperRunner.isBusy()) return { ok: false, error: "Wait until the timesheet is done." };
    if (choice.config === null) return { ok: true, next: noneActive(), servers: undefined };
    // The servers of the tracker being left stay only for the same tracker (no `config` is the tracker of the data, whose id that is).
    const saved = readTrackerChoice(this.db);
    const dataId = dataTrackerId(this.db);
    const idOf = (config: string | null | undefined) => (config === undefined ? dataId : config);
    const servers = choice.servers ?? (idOf(saved.config) === idOf(choice.config) ? saved.servers : undefined);
    let next: ActiveTracker;
    if (choice.config === undefined) {
      const chosen = chooseDataTracker(this.options.dataDir, dataId, servers);
      if (chosen.error) return { ok: false, error: `${chosen.error} It is the tracker of ARIA's data: its config is expected in ${expectedConfigFile(this.options.dataDir, dataId!)}.` };
      next = chosen.active;
    } else {
      const chosen = chooseConfig(this.options.dataDir, choice.config, servers);
      if (!chosen.ok) return chosen;
      next = chosen.active;
    }
    return { ok: true, next, servers, ...this.purgeQuestion(next.tracker) };
  }

  /**
   * The question a switch to `tracker` asks when the store holds another tracker's data: what there is to clear
   * (cached tasks, rules that name a task, draft rows with a task, linked activities; registered entries stay as history
   * either way) and whose it is. Nothing to clear, nothing to ask.
   */
  private purgeQuestion(tracker: TaskTracker): { purge?: NonNullable<TrackerChangePreview["purge"]> } {
    // The same tracker with other servers (or a reloaded config) changes no one's data: nothing to ask.
    if (tracker.id === this.tracker.id) return {};
    const counts = this.db.trackerPurgeCounts(tracker.id);
    if (counts.cachedTasks + counts.rules + counts.draftRowsWithTasks + counts.linkedActivities === 0) return {};
    const others = this.db.otherTrackerIds(tracker.id);
    const recorded = dataTrackerId(this.db);
    const from = recorded !== undefined && others.includes(recorded) ? recorded : (others[0] ?? "");
    const listed = this.trackerListing.find((c) => c.id === from);
    const fromLabel = (listed?.ok ? listed.config.label : undefined) || from || "an earlier tracker";
    return { purge: { from, fromLabel, counts } };
  }

  /**
   * Switches the active tracker: the tracker of ARIA's data (no `config`), a config of the trackers folder, or none
   * (`config: null`). Refused while the Timekeeper is working, since a prepare or a submit finishes with the reader it
   * started with.
   */
  setActiveTracker(choice: TrackerChoice, options: { purge?: boolean } = {}): { ok: true; message: string } | { ok: false; error: string } {
    const plan = this.planTrackerChange(choice);
    if (!plan.ok) return plan;
    const { next, servers } = plan;
    const none = isNoTracker(next.tracker);
    // Another tracker's data is kept, dormant, unless the question was answered "clear it": then it goes in one
    // transaction after a backup, and a backup that can't be made (no room) refuses the switch with the data untouched.
    let cleared: TrackerPurgeCounts | undefined;
    if (options.purge === true && plan.purge) {
      try {
        cleared = this.db.purgeTrackerData(next.tracker.id);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    // Whose data the store holds, before the switch: another tracker's entries and lookups aren't this one's.
    const kept = dataTrackerId(this.db);
    const dataChangesHands = !none && (kept ?? next.tracker.id) !== next.tracker.id;
    const dataId = none ? kept : next.tracker.id;
    writeTrackerChoice(this.db, {
      ...(choice.config !== undefined ? { config: choice.config } : {}),
      ...(servers ? { servers } : {}),
      ...(dataId !== undefined ? { dataId } : {}),
    });
    this.tracker = next.tracker;
    this.activeTracker = next;
    this.trackerError = undefined;
    this.refreshToolSets();
    // What the Timekeeper keeps in memory is the old tracker's (its registered entries, its lookups): none has none.
    if (dataChangesHands || none) this.timekeeperRunner.forgetTrackerState();
    this.trackerWatcher?.trackerChanged();
    void this.refreshConductorTools();
    this.integrations.emitIntegrations();
    this.emit({ type: "tracker", tracker: windowTrackerInfo(this.tracker) });
    // The rules in use are this tracker's (and the ones that name no task): the window's list changes with it.
    this.emit({ type: "time_rules", timeRules: this.db.listTimeRules(this.tracker.id) });
    const message = (none ? "No task tracker." : `Task tracker: ${describeActive(next)}.`) + (cleared && plan.purge ? ` ${describeCleared(cleared, plan.purge.fromLabel)}` : "");
    this.notice("info", message, "tracker_changed");
    return { ok: true, message };
  }

  /**
   * The trackers folder and the active tracker. When the active config's file has changed since it was loaded
   * the new version is swapped in the way a switch is (the same id, so nothing is cleared); if the Timekeeper is busy
   * that waits for the next listing, and says so.
   */
  listTrackers(): { active: ActiveTracker; configs: ConfigListing[]; notice?: string } {
    const configs = this.readTrackerFolder();
    const notice = this.reloadActiveConfig();
    return { active: this.activeTracker, configs, ...(notice ? { notice } : {}) };
  }

  /** The active config's file changed since it was loaded: the new version is swapped in, and a notice says so or why not. */
  private reloadActiveConfig(): string | undefined {
    const active = this.activeTracker;
    const current = active.source === "config" ? this.trackerListing.find((c) => c.file === active.file) : undefined;
    if (!current?.ok || current.hash === active.hash) return undefined;
    const saved = readTrackerChoice(this.db);
    const swapped = this.setActiveTracker({ config: current.id, ...(saved.servers ? { servers: saved.servers } : {}) });
    return swapped.ok ? `${current.file} had changed, so the new version is in use.` : `${current.file} has changed; the new version is loaded the next time this list is shown. ${swapped.error}`;
  }

  /** What choosing `choice` would do: why it is refused, or which of the config's tools its servers have, and what ARIA would call without asking. */
  previewTrackerChange(choice: TrackerChoice): TrackerChangePreview {
    const plan = this.planTrackerChange(choice);
    if (!plan.ok) return { refusal: plan.error, tools: [], reads: [], reserved: [] };
    const tracker = plan.next.tracker;
    // No tracker reaches nothing and has no name.
    if (isNoTracker(tracker)) return { tools: [], reads: [], reserved: [] };
    const context = this.integrations.trackerContext();
    const servers = plan.servers && plan.servers.length > 0 ? plan.servers : trackerServers(tracker, context);
    return {
      label: tracker.label,
      tools: trackerToolStatus(tracker, servers, context),
      reads: trackerReads(tracker),
      reserved: trackerReserved(tracker),
      ...(plan.purge ? { purge: plan.purge } : {}),
    };
  }

  /**
   * Imports a config file's text into the trackers folder: checked as a whole, then copied in as `<id>.json`.
   * A file of that name is replaced only with `replace` (the caller asks first); the config in use is loaded again then.
   */
  importTrackerConfig(text: string, options: { replace?: boolean } = {}): TrackerImportResult | ImportExists {
    const outcome = importTrackerConfigText(this.options.dataDir, text, options);
    if (outcome.status === "invalid") return { status: "invalid", errors: outcome.errors };
    if (outcome.status === "failed") return { status: "failed", error: outcome.error };
    if (outcome.status === "exists") {
      return {
        status: "exists",
        id: outcome.config.id,
        label: outcome.config.label,
        file: outcome.file,
        hash: outcome.hash,
        ...(outcome.existingHash ? { existingHash: outcome.existingHash } : {}),
        active: this.activeTracker.source === "config" && this.activeTracker.file === outcome.file,
      };
    }
    this.readTrackerFolder();
    const note = this.store ? this.reloadActiveConfig() : undefined;
    this.integrations.emitIntegrations();
    const tracker = createConfigTracker(outcome.config, { hash: outcome.hash });
    return {
      status: "imported",
      id: outcome.config.id,
      label: outcome.config.label,
      file: outcome.file,
      hash: outcome.hash,
      replaced: outcome.replaced,
      reads: trackerReads(tracker),
      reserved: trackerReserved(tracker),
      ...(note ? { note } : {}),
    };
  }

  /** The trackers folder (`<data folder>/trackers`), for the window's Open folder. */
  trackersFolder(): string {
    return trackersDir(this.options.dataDir);
  }

  /** `/tracker`: the configs and the active tracker, or `/tracker <id>`, `/tracker none` and `/tracker default` to switch. */
  private trackerCommand(arg: string): string {
    const word = arg.trim();
    if (word) {
      const lower = word.toLowerCase();
      const result = this.setActiveTracker(lower === "default" ? {} : lower === "none" ? { config: null } : { config: word });
      return result.ok ? result.message : result.error;
    }
    const { active, configs, notice } = this.listTrackers();
    const lines = ["**Task tracker**", `Active: ${describeActive(active)}`, ""];
    lines.push(...(configs.length > 0 ? ["Configs in ARIA's trackers folder:", ...describeListing(configs, active.file)] : ["No configs in ARIA's trackers folder."]));
    if (notice) lines.push("", notice);
    lines.push("", "`/tracker <id>` switches to a config, `/tracker none` to no tracker, `/tracker default` to the tracker of your task data (or none, with no data).");
    return lines.join("\n");
  }

  /** start_task's profile list and rule live in the tool's schema and description, so they're refreshed on change. */
  private async refreshConductorTools(): Promise<void> {
    // Counted, so a Conductor that was still opening with the old tools gets the new ones once it's open.
    this.toolsVersion++;
    await this.conductor?.setTools(this.conductorToolset()).catch((error: unknown) => this.notice("warning", `ARIA couldn't update its task tools: ${message(error)}`, "tools_refresh_failed"));
  }

  private taskToolDeps(): TaskToolDeps {
    return {
      profiles: () => this.profiles.list(),
      policy: () => this.profiles.policy(),
      agents: () => this.catalog.agents ?? [],
      skills: () => {
        const disabledSet = new Set(this.mcpConfigStore?.getState().disabledSkills ?? []);
        return (this.catalog.skills ?? []).map((s) => ({
          ...s,
          enabled: s.enabled !== false && !disabledSet.has(s.name),
        }));
      },
      startTask: async (input) => {
        const project = this.resolveProject(input.repo);
        const { profile, note } = this.profiles.forTask({
          ...(input.profile ? { requested: input.profile } : {}),
          startedBy: "aria",
          lastUserMessage: this.lastUserMessage,
          ...(input.reason ? { reason: input.reason } : {}),
        });
        const allowedPaths = this.groundedPaths([...(input.allowedPaths ?? []), ...extractBriefPaths(input.brief)]);
        const refused = (input.allowedPaths ?? []).filter((p) => !allowedPaths.some((allowed) => samePath(allowed, p)));
        const notAllowed = refused.length ? { pathsNotAllowed: refused } : {};
        // Profile policy "ask" (§4.12): a proposal card, and nothing runs until you press Start.
        if (this.profiles.policy() === "ask") return { proposal: this.taskStarts.propose(project, { ...input, allowedPaths }, profile), ...notAllowed };
        const task = await this.tasks.start({
          project,
          brief: input.brief,
          title: input.title,
          profile,
          ...(note ? { profileNote: note } : {}),
          ...(input.agent?.trim() ? { agent: input.agent.trim() } : {}),
          ...(input.mode ? { mode: input.mode } : {}),
          ...(input.base ? { baseBranch: input.base } : {}),
          ...(input.trackerTaskId ? { trackerTaskId: input.trackerTaskId } : {}),
          ...(input.where ? { where: input.where } : {}),
          ...(input.remote !== undefined ? { remote: input.remote } : {}),
          ...(allowedPaths.length ? { allowedPaths } : {}),
          ...(input.extraContext ? { extraContext: input.extraContext } : {}),
          ...(input.files?.length ? { files: input.files } : {}),
          startedBy: "aria",
        });
        return { task, ...notAllowed };
      },
      listTasks: () => this.tasks.list(),
      findTask: (ref) => this.tasks.find(ref),
      messageTask: async (ref, text, steer, agent) => {
        const found = this.tasks.find(ref);
        if (agent !== undefined) await this.tasks.setAgent(found.id, agent);
        return this.tasks.message(found.id, text, steer, undefined, this.groundedPaths(extractBriefPaths(text)));
      },
      setTaskAgent: (ref, agent) => this.tasks.setAgent(this.tasks.find(ref).id, agent),
      answerQuestion: (ref, answer) => {
        const item = this.tasks.byShortId(ref);
        if (item && item.kind !== "question") throw new Error(`${ref} isn't a question. Use the tool for that kind of item.`);
        const task = item?.task ?? this.tasks.find(ref);
        if (!task.question) throw new Error(`${task.title} isn't waiting for an answer.`);
        const choice = task.question.choices?.find((c) => c.trim().toLowerCase() === answer.trim().toLowerCase());
        // ARIA's words, not yours: they're never offered for "Save as memory".
        this.tasks.answer(task.id, task.question.id, choice ?? answer, choice === undefined, "aria");
      },
      decidePermission: (id, decision, note) => {
        const item = this.pendingOf(id, "permission");
        if (decision !== "reject") this.assertNamedByUser(item.shortId, "approve");
        this.tasks.decidePermission(item.task.id, item.itemId, decision === "approve_for_task" ? "task" : decision === "approve" ? "once" : "reject", note);
      },
      reviewPlan: async (id, decision, mode, feedback) => {
        const item = this.pendingOf(id, "plan");
        if (decision === "approve") this.assertNamedByUser(item.shortId, "approve");
        await this.tasks.reviewPlan(item.task.id, item.itemId, decision === "approve" ? (mode ?? "autopilot") : decision, feedback);
      },
      continueBudget: (id, credits) => {
        const item = this.pendingOf(id, "budget");
        this.assertNamedByUser(item.shortId, "continue");
        this.tasks.continueBudget(item.task.id, credits);
      },
      cancelTask: (ref) => this.tasks.cancel(this.tasks.find(ref).id),
      cleanupTask: (ref) => this.tasks.cleanup(this.tasks.find(ref).id),
      setTrackerTask: (ref, trackerTaskId) => this.tasks.setTrackerTask(this.tasks.find(ref).id, trackerTaskId),
      // Only proposes (D19, D22): a card you confirm; nothing is pushed or opened by this.
      ...(this.prs
        ? {
            openPr: async (ref: string, title?: string) => {
              const card = await this.prs!.propose(this.tasks.find(ref).id, "aria", title);
              return { card: card.id };
            },
          }
        : {}),
    };
  }

  // ── pull requests (PLAN.md §4.3, §4.4, item 3, D41–D44) ─────────────────────────────────────────────────────

  /** Open PR on a task's Done card: its PR card (made, or worked out again). */
  async proposePr(taskId: string): Promise<void> {
    if (!this.prs) throw new Error("GitHub isn't set up in this run of ARIA.");
    await this.prs.propose(taskId, "you");
  }

  /** Your click on the PR card: push and open, exactly as the card shows it with your edits. */
  async confirmPr(input: { cardId: string; revision: number; title: string; body: string; draft: boolean; openOn: { owner: string; repo: string }; workflowsChecked: boolean }): Promise<void> {
    if (!this.prs) throw new Error("GitHub isn't set up in this run of ARIA.");
    await this.prs.confirm(input);
  }

  dismissPr(cardId: string): void {
    if (!this.prs) throw new Error("GitHub isn't set up in this run of ARIA.");
    this.prs.dismiss(cardId);
  }

  // ── Fix it and Address comments (item 4, D45–D53) ────────────────────────────────────────────────────────────

  private get fix(): CiFixes {
    if (!this.fixes) throw new Error("GitHub isn't set up in this run of ARIA.");
    return this.fixes;
  }

  /** Fix it on a red CI card: your click. */
  async fixCi(cardId: string): Promise<void> {
    await this.fix.fixCi(cardId);
  }

  /** Address comments on a review card: your click (`ticked`: D51's extra tick). */
  async addressReview(cardId: string, ticked: boolean): Promise<void> {
    await this.fix.addressReview(cardId, ticked);
  }

  /** Start on ARIA's proposal (D48). */
  async startFixProposal(cardId: string, revision: number, ticked: boolean): Promise<void> {
    await this.fix.startProposal(cardId, revision, ticked);
  }

  dismissFixProposal(cardId: string): void {
    this.fix.dismissProposal(cardId);
  }

  /** "Fix it uses" (D47). */
  setCiFixProfile(profileId: string | null): void {
    this.profiles.setCiFix(profileId);
    this.emitProfiles();
  }

  /** You pressed Start on a proposal, with its profile or another one (and optional agent) you picked. */
  startProposal(cardId: string, profileId?: string, agent?: string | null): Promise<Task> {
    return this.taskStarts.startProposal(cardId, profileId, agent);
  }

  dismissProposal(cardId: string): void {
    this.taskStarts.dismissProposal(cardId);
  }

  /** Clears a card or notice from the chat timeline. */
  dismissCard(cardId: string): void {
    const item = this.db.getTimelineItem(cardId);
    if (!item || (item.kind !== "card" && item.kind !== "notice")) return;
    if (item.kind === "card" && item.cardType === "outlook_mail") {
      this.outlookWatcher?.dismissMessage(item.payload.messageId);
    }
    if (this.db.deleteTimelineItem(cardId)) {
      this.emit({ type: "timeline_removed", id: cardId });
    }
  }

  /** A project by name (any letter case), folder, or a unique part of its name. */
  private resolveProject(ref: string): Project {
    const query = ref.trim().toLowerCase();
    if (query === "chats" || query === "chat" || query === "general" || query === "general chat") {
      return this.chatProject();
    }
    const projects = this.db.listRepos().filter((p) => !p.hidden);
    const exact = projects.find((p) => p.name.toLowerCase() === query || (path.isAbsolute(ref) && samePath(p.path, ref)));
    if (exact) return exact;
    const partial = projects.filter((p) => p.name.toLowerCase().includes(query));
    if (partial.length === 1) return partial[0]!;
    if (partial.length > 1) throw new Error(`"${ref}" matches several projects: ${partial.map((p) => p.name).join(", ")}. Which one?`);
    throw new Error(`There's no project called "${ref}". Use list_repos to see the projects.`);
  }

  // ── tasks (from the window) ─────────────────────────────────────────────────────────────────────────────────
  // What you do on cards and in the session view goes into ARIA's next digest, so it never contradicts you.

  /** A task you start yourself (New session or "Rerun with…"): your profile choice is used as is. */
  startTask(input: Parameters<TaskStarts["startTask"]>[0]): Promise<Task> {
    return this.taskStarts.startTask(input);
  }

  /** Links or clears a tracker task ID on an ARIA task (from the window, Phase 5B). */
  setTaskTracker(taskId: string, trackerTaskId: string | null): Task {
    const updated = this.tasks.setTrackerTask(taskId, trackerTaskId);
    // With no tracker only an unlink gets here (a link can't be read), and it names no tracker.
    this.digest.add(
      updated.trackerTaskId
        ? `You linked "${updated.title}" (${updated.repoName}) to ${this.tracker.label} task ${updated.trackerTaskId}.`
        : isNoTracker(this.tracker)
          ? `You unlinked the task tracker task from "${updated.title}" (${updated.repoName}).`
          : `You unlinked the ${this.tracker.label} task from "${updated.title}" (${updated.repoName}).`,
    );
    return updated;
  }

  // ── Work tracking, activities and mapping rules (Phase 5B, PLAN.md §4.14, §8) ────────────────────────────────

  private get activityCollector(): ActivityCollector {
    if (!this.collector) throw new Error("ARIA engine isn't started");
    return this.collector;
  }

  async listActivities(input: { since?: number; until?: number; repoId?: number; source?: ActivitySource; scanGit?: boolean } = {}): Promise<Activity[]> {
    if (input.scanGit !== false && (!input.source || input.source === "git")) {
      await this.activityCollector.scanLocalGitActivities({
        ...(input.since !== undefined ? { since: input.since } : {}),
        ...(input.until !== undefined ? { until: input.until } : {}),
        ...(input.repoId !== undefined ? { repoId: input.repoId } : {}),
      }).catch(this.logFailure("Scanning local git activity"));
    }
    return this.activityCollector.listActivities({
      ...(input.since !== undefined ? { since: input.since } : {}),
      ...(input.until !== undefined ? { until: input.until } : {}),
      ...(input.repoId !== undefined ? { repoId: input.repoId } : {}),
      ...(input.source ? { source: input.source } : {}),
    });
  }

  async scanGitActivities(options: { since?: number; until?: number; repoId?: number; force?: boolean } = {}): Promise<number> {
    return this.activityCollector.scanLocalGitActivities(options);
  }

  listTimeRules(): TimeRule[] {
    return this.db.listTimeRules(this.tracker.id);
  }

  saveTimeRule(input: {
    id?: string;
    kind: TimeRuleKind;
    repoId?: number;
    pattern: string;
    matchMode?: TimeRuleMatchMode;
    trackerTaskId?: string;
    trackerTaskTitle?: string;
    defaultMinutes?: number | null;
    createdFrom?: "you" | "correction";
    enabled?: boolean;
  }): TimeRule {
    if (input.kind === "repo" && input.repoId !== undefined && !this.db.getRepo(input.repoId)) {
      throw new Error("That project doesn't exist anymore.");
    }
    const validated = validateTimeRuleInput(this.tracker, input);
    let id = input.id;
    if (id) {
      if (!this.db.getTimeRule(id)) throw new Error("That mapping rule doesn't exist anymore.");
    } else {
      const existing = this.db.listTimeRules(this.tracker.id);
      if (existing.length >= MAX_TIME_RULES) {
        throw new Error(`You have ${MAX_TIME_RULES} mapping rules, the most ARIA keeps: delete one first.`);
      }
      id = randomUUID();
    }
    const saved = this.db.saveTimeRule(this.tracker.id, { id, ...validated });
    this.emit({ type: "time_rules", timeRules: this.db.listTimeRules(this.tracker.id) });
    return saved;
  }

  deleteTimeRule(id: string): void {
    if (!this.db.deleteTimeRule(id)) throw new Error("That mapping rule doesn't exist anymore.");
    this.emit({ type: "time_rules", timeRules: this.db.listTimeRules(this.tracker.id) });
  }

  // ── Timekeeper and Timesheet draft (Phase 5C, PLAN.md §4.12, §4.14, §5.4) ────────────────────────────────────

  private get timekeeperRunner(): TimekeeperRunner {
    if (!this.timekeeper) throw new Error("ARIA engine isn't started");
    return this.timekeeper;
  }

  timekeeperSettings(): TimekeeperSettings {
    const stored = this.store ? this.db.getSetting<Partial<TimekeeperSettings>>("timekeeper.settings") : undefined;
    return timekeeperSettingsFrom(stored, this.models, this.options.defaultModel);
  }

  setTimekeeperSettings(patch: Partial<TimekeeperSettings>): TimekeeperSettings {
    const next = patchedTimekeeperSettings(this.timekeeperSettings(), patch, this.models);
    this.db.setSetting("timekeeper.settings", next);
    this.emit({ type: "timekeeper", timekeeper: next });
    if (patch.timesheetTime && next.timesheetTime) {
      this.scheduler?.syncDailyTimesheetTime(next.timesheetTime);
    }
    if (this.timekeeper) {
      this.emit({ type: "today_time", todayTime: this.timekeeper.todaySummary() });
    }
    return next;
  }

  prepareTimesheet(date?: string): Promise<TimesheetCardPayload> {
    return this.timekeeperRunner.prepare(date);
  }

  updateTimesheetEntry(given: {
    date: string;
    entryId?: string;
    addNew?: boolean;
    start?: string;
    end?: string;
    minutes?: number;
    trackerTaskId?: string;
    trackerTaskTitle?: string;
    trackerProjectId?: string;
    trackerCustomerId?: string;
    comment: string;
    sources?: TimesheetSourceRef[];
  }): TimesheetCardPayload {
    // With no tracker a row has times and a comment only: a task named anyway is left out, not an error.
    const input = isNoTracker(this.tracker) ? Object.fromEntries(Object.entries(given).filter(([key]) => !key.startsWith("tracker"))) as typeof given : given;
    const payload = this.timekeeperRunner.updateEntry(input);
    const updated = input.entryId
      ? payload.entries.find((e) => e.id === input.entryId)
      : payload.entries.reduce<TimesheetCardPayload["entries"][number] | undefined>(
          (latest, e) => (!latest || e.createdAt >= latest.createdAt ? e : latest),
          undefined,
        );
    const span = input.start && input.end ? `${input.start}–${input.end}` : updated ? `${updated.minutes}m (${updated.start}–${updated.end})` : `${input.minutes ?? 15}m`;
    this.digest.add(
      `[timesheet] You updated your timesheet draft for ${input.date} (${span}${input.trackerTaskId ? ` → ${this.tracker.label} task ${input.trackerTaskId}` : ""}).`,
    );
    return payload;
  }

  confirmTimesheetEntry(date: string, entryId: string): TimesheetCardPayload {
    const payload = this.timekeeperRunner.confirmEntry(date, entryId);
    this.digest.add(`[timesheet] You confirmed a row on your timesheet draft for ${date}.`);
    return payload;
  }

  deleteTimesheetEntry(date: string, entryId: string): TimesheetCardPayload {
    const payload = this.timekeeperRunner.deleteEntry(date, entryId);
    this.digest.add(`[timesheet] You removed a row from your timesheet draft for ${date}.`);
    return payload;
  }

  acceptTimesheetRuleOffer(date: string, offerId: string): TimesheetCardPayload {
    return this.timekeeperRunner.acceptRuleOffer(date, offerId);
  }

  dismissTimesheetRuleOffer(date: string, offerId: string): TimesheetCardPayload {
    return this.timekeeperRunner.dismissRuleOffer(date, offerId);
  }

  getTimeView(date?: string): TimeViewState {
    return this.timekeeperRunner.getTimeView(date);
  }

  resolveTimesheetTasks(date?: string): Promise<TimesheetCardPayload> {
    return this.timekeeperRunner.resolveMissingTaskIdsForDate(date);
  }

  submitTimesheet(date: string, entryIds?: string[]): Promise<TimeRegisteredCardPayload> {
    return this.timekeeperRunner.submit(date, entryIds);
  }

  updateRegisteredEntry(input: {
    date: string;
    trackerEntryId: string;
    start: string;
    end: string;
    trackerTaskId: string;
    trackerTaskTitle?: string;
    trackerProjectId?: string;
    trackerCustomerId?: string;
    comment: string;
  }): Promise<TimesheetCardPayload> {
    return this.timekeeperRunner.updateRegisteredEntry(input);
  }

  deleteRegisteredEntries(input: {
    date: string;
    trackerEntryIds: string[];
    confirmed: boolean;
  }): Promise<TimesheetCardPayload> {
    return this.timekeeperRunner.deleteRegisteredEntries(input);
  }

  /** A message you typed in a task's session view. */
  async messageTask(taskId: string, text: string, steer: boolean): Promise<void> {
    const task = this.tasks.get(taskId);
    this.lastUserMessage = text;
    await this.tasks.message(taskId, text, steer, undefined, this.yourPaths(text));
    this.rememberYours(taskId, { kind: "message", text });
    if (task) this.digest.add(`You told "${task.title}" directly${steer ? " (steering its current step)" : ""}: ${quote(text)}`);
  }

  /**
   * R1: "Ask it to repair" on a Done or PR card. The message is ARIA's, built from what it counted on the task's record,
   * so the task's own file names never pass as your words: they aren't remembered, offered as a memory, put in the
   * digest, or granted to the sandbox as paths (as paths in your messages are). Taken from the record as it's sent, so
   * the other card's button asks nothing again.
   */
  async repairEncoding(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("That task doesn't exist anymore.");
    const damage = this.tasks.takeEncodingDamage(taskId);
    if (!damage) throw new Error("There's nothing to repair: ARIA already asked this task, or found no damaged text when it last finished.");
    try {
      await this.tasks.message(taskId, encodingRepairMessage(damage), false);
    } catch (error) {
      this.tasks.restoreEncodingDamage(taskId, damage);
      throw error;
    }
    this.digest.add(`You asked "${task.title}" to repair text it damaged with a wrong encoding: ${encodingDamageText(damage)}`);
  }

  answerQuestion(taskId: string, questionId: string, answer: string, wasFreeform: boolean): void {
    const task = this.tasks.get(taskId);
    this.tasks.answer(taskId, questionId, answer, wasFreeform, "you");
    // Your own words when it's none of the choices (worked out here: the window's wasFreeform isn't what counts).
    const choices = task?.question?.id === questionId ? (task.question.choices ?? []) : [];
    if (!choices.some((c) => c.trim().toLowerCase() === answer.trim().toLowerCase())) this.rememberYours(taskId, { kind: "answer", text: answer, questionId });
    this.lastUserMessage = answer;
    const shortId = task?.question?.id === questionId ? task.question.shortId : "its question";
    if (task) this.digest.add(`You answered ${shortId} from "${task.title}" on its card: ${quote(answer)}`);
  }

  decidePermission(taskId: string, permissionId: string, decision: PermissionDecision, note?: string): void {
    const task = this.tasks.get(taskId);
    const pending = task?.permissions?.find((p) => p.id === permissionId);
    this.tasks.decidePermission(taskId, permissionId, decision, note);
    if (task && pending) {
      const verb = decision === "reject" ? "rejected" : decision === "task" ? "approved for the rest of the task" : decision === "always" ? "saved as an exact sandbox exception" : "approved";
      this.digest.add(`You ${verb} ${pending.shortId} from "${task.title}" (${quote(pending.what)})${note?.trim() ? `, saying ${quote(note)}` : ""}.`);
    }
  }

  async reviewPlan(taskId: string, planId: string, decision: PlanDecision, feedback?: string): Promise<void> {
    const task = this.tasks.get(taskId);
    const plan = task?.plan?.id === planId ? task.plan : undefined;
    await this.tasks.reviewPlan(taskId, planId, decision, feedback);
    if (task && plan) {
      const what =
        decision === "revise"
          ? `asked "${task.title}" to revise its plan ${plan.shortId}: ${quote(feedback ?? "")}`
          : decision === "cancel"
            ? `cancelled "${task.title}" at its plan ${plan.shortId}`
            : `approved the plan ${plan.shortId} of "${task.title}"; it carries it out in ${decision} mode`;
      this.digest.add(`You ${what}.`);
    }
  }

  revokeGrant(taskId: string, grantId: string): void {
    this.tasks.revokeGrant(taskId, grantId);
  }

  /** Your words to a task from the window (never ARIA's): what "Save as memory" is offered on. */
  private rememberYours(taskId: string, words: Omit<YourWords, "id" | "at">): void {
    try {
      this.tasks.recordYours(taskId, words);
    } catch {
      // The task is gone meanwhile: nothing to offer it on.
    }
  }

  yourWords(taskId: string): YourWords[] {
    return this.tasks.yours(taskId);
  }

  async cancelTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    await this.tasks.cancel(taskId);
    if (task && !["done", "failed", "cancelled"].includes(task.state)) this.digest.add(`You stopped "${task.title}".`);
  }

  async discardTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    await this.tasks.discard(taskId);
    if (task) this.digest.add(`You discarded "${task.title}" (${task.repoName}): its worktree, branch and session are gone.`);
  }

  retryTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    this.tasks.retry(taskId);
    if (task) this.digest.add(`You retried "${task.title}".`);
  }

  resumeInterrupted(): void {
    this.tasks.resumeInterrupted();
    this.digest.add("You resumed the interrupted tasks.");
  }

  dismissInterrupted(): void {
    this.tasks.dismissInterrupted();
    this.digest.add("You stopped the interrupted tasks.");
  }

  continueBudget(taskId: string, addCredits: number): void {
    const task = this.tasks.get(taskId);
    this.tasks.continueBudget(taskId, addCredits);
    if (task) this.digest.add(`You raised the budget of "${task.title}"${task.budgetShortId ? ` (${task.budgetShortId})` : ""} by ${addCredits} credits; it continues.`);
  }

  async setTaskModel(taskId: string, model: string, reasoningEffort?: string): Promise<void> {
    const task = this.tasks.get(taskId);
    await this.tasks.setModel(taskId, model, reasoningEffort);
    if (task) this.digest.add(`You switched "${task.title}" to ${model}${reasoningEffort ? ` · ${reasoningEffort}` : ""}.`);
  }

  async setTaskAgent(taskId: string, agent: string | null): Promise<Task> {
    const updated = await this.tasks.setAgent(taskId, agent);
    this.digest.add(
      `You switched "${updated.title}" to ${updated.agent ? `agent ${updated.agent}` : "the default coding agent"}.`,
    );
    return updated;
  }

  getTranscript(taskId: string): Promise<TranscriptEntry[]> {
    return this.tasks.transcript(taskId);
  }

  /** A page of a task's transcript for the session view (P4): read whole, sent a page at a time. */
  async getTranscriptPage(input: z.infer<typeof TranscriptPageInput>): Promise<TranscriptPage> {
    return transcriptPage(await this.tasks.transcript(input.taskId), input);
  }

  getTaskDiff(taskId: string): Promise<TaskDiff> {
    return this.tasks.diff(taskId);
  }

  getTaskFile(taskId: string, filePath: string): Promise<TaskFile | null> {
    return Promise.resolve(this.tasks.file(taskId, filePath));
  }

  /** The folder to open in an editor (main opens it). */
  taskWorktree(taskId: string): string {
    const task = this.tasks.get(taskId);
    if (!task?.worktreePath) throw new Error("This task has no worktree.");
    return task.worktreePath;
  }

  // ── worker profiles ─────────────────────────────────────────────────────────────────────────────────────────

  private emitProfiles(): void {
    const ciFix = this.profiles.ciFixId();
    this.emit({ type: "profiles", profiles: this.profiles.list(), policy: this.profiles.policy(), ...(ciFix ? { ciFixProfileId: ciFix } : {}) });
  }

  async saveProfile(input: ProfileInput): Promise<Profile> {
    const before = input.id ? (this.profiles.get(input.id)?.instructions ?? "") : "";
    const profile = this.profiles.save(input);
    // Its instructions are a prompt too (Customize › Prompts keeps their versions).
    this.prompts.recordProfileEdit(profile.id, before, profile.instructions ?? "");
    this.emitProfiles();
    await this.refreshConductorTools();
    return profile;
  }

  async deleteProfile(profileId: string): Promise<void> {
    this.profiles.delete(profileId);
    this.emitProfiles();
    await this.refreshConductorTools();
  }

  setDefaultProfile(profileId: string): void {
    this.profiles.setDefault(profileId);
    this.emitProfiles();
  }

  async setProfilePolicy(policy: ProfilePolicy): Promise<void> {
    this.profiles.setPolicy(policy);
    this.emitProfiles();
    await this.refreshConductorTools();
  }

  // ── permissions and the sandbox (Customize › Permissions; PLAN.md §4.8, D20) ───────────────────────────────

  /**
   * The sandbox for a task's session: none when this PC can't run it or you turned it off; an error (so the task doesn't
   * run unconfined) when it should be sandboxed and ARIA can't set it up.
   */
  private extensionReadableRoots(): string[] {
    const mcpState = this.mcpConfigStore?.getState() ?? EMPTY_MCP_CONFIG;
    const extra = [
      ...mcpState.pluginDirectories,
      ...(mcpState.skillDirectories ?? []),
      ...(mcpState.agentDirectories ?? []),
    ];
    return copilotExtensionReadonlyPaths(extra);
  }

  private async sandboxFor(task: { repoPath: string; worktreePath: string; sessionDir?: string; allowedPaths?: string[]; nonGit?: boolean }): Promise<WorkerSandbox | undefined> {
    const settings = this.policyStore.sandbox();
    if (!settings.enabled || !this.sandboxSupport.supported) return undefined;
    if (!this.dirs) throw new Error(`ARIA's folder for tasks couldn't be set up${this.dirsError ? ` (${this.dirsError})` : ""}, so the task can't be sandboxed`);
    // The shell script points at the caches; written again in case your NuGet folder moved.
    prepareAriaDirs(this.dirs);
    return sandboxSpec({
      repoPath: task.repoPath,
      worktree: task.worktreePath,
      dirs: this.dirs,
      allowedHosts: settings.allowedHosts,
      allowedPaths: [...settings.allowedPaths, ...(task.allowedPaths ?? [])],
      ...(task.sessionDir ? { sessionDir: task.sessionDir } : {}),
      ...(task.nonGit ? { nonGit: true } : {}),
      extraReadonly: this.extensionReadableRoots(),
    });
  }

  private persistSandboxException(exception: SandboxPermission): void {
    if (!exception.persistent) throw new Error("That sandbox block cannot be saved safely.");
    const settings = this.policyStore.sandbox();
    if (exception.persistent === "path") {
      if (exception.access !== "read") throw new Error("Only read-only sandbox paths can be saved.");
      const safe = grantablePaths([exception.target], [this.options.dataDir]);
      if (safe.length !== 1) throw new Error("That path is too broad or reaches protected data, so it cannot be saved.");
      this.policyStore.setSandbox({ allowedPaths: [...settings.allowedPaths, safe[0]!] });
    } else {
      if (exception.access !== "network") throw new Error("Only exact sandbox hosts can be saved.");
      const host = exception.target.trim().toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) || host.includes("..") || host === "localhost" || host === "127.0.0.1") {
        throw new Error("That host cannot be saved as an exact sandbox exception.");
      }
      this.policyStore.setSandbox({ allowedHosts: [...settings.allowedHosts, host] });
    }
    this.emitPolicy();
  }

  policySettings(): PolicySettings {
    const settings = this.policyStore.sandbox();
    return {
      rules: this.policyStore.rules(),
      ...(this.policyStore.usesDefaults() ? { usesDefaults: true } : {}),
      sandbox: {
        supported: this.sandboxSupport.supported,
        ...(this.sandboxSupport.reason ? { reason: this.sandboxSupport.reason } : {}),
        enabled: settings.enabled,
        allowedHosts: settings.allowedHosts,
        allowedPaths: settings.allowedPaths,
      },
    };
  }

  private emitPolicy(): PolicySettings {
    const policy = this.policySettings();
    this.emit({ type: "policy", policy });
    return policy;
  }

  /** Your rules apply to the next permission request; sandbox changes to sessions opened from now on. */
  savePolicyRules(rules: readonly RuleInput[]): PolicySettings {
    this.policyStore.saveRules(rules);
    return this.emitPolicy();
  }

  resetPolicyRules(): PolicySettings {
    this.policyStore.resetRules();
    return this.emitPolicy();
  }

  /** What saving this rule would say (D26), with your other rules (a Never rule it runs past). */
  checkRule(input: { match: string; effect: "auto" | "ask" | "never"; exact?: boolean | undefined; scope?: RuleScope | undefined }): RuleCheck {
    return checkRule(input, this.policyStore.rules());
  }

  ruleOffers(taskId: string): RuleOffer[] {
    return this.tasks.offers(taskId);
  }

  /**
   * "Always allow this": the offer's rules as you edited them, saved to your rules. The scope and what it overrides
   * come from the stored offer, not the window, and every save check runs again (D26–D28); running past a Never rule
   * of yours needs your confirmation.
   */
  acceptOffer(input: { taskId: string; offerId: string; rules: Array<{ match: string; exact: boolean }>; confirmOverride?: boolean | undefined }): PolicySettings {
    const offer = this.tasks.offer(input.taskId, input.offerId);
    if (offer.overrides?.length && !input.confirmOverride) {
      throw new Error(`It runs although your Never rule ${offer.overrides.map((o) => `\`${o.match}\``).join(" and ")} refuses it now: confirm that first.`);
    }
    const existing = this.policyStore.rules();
    for (const rule of input.rules) {
      const { problems } = checkRule({ match: rule.match, effect: "auto", exact: rule.exact, scope: offer.scope }, existing);
      if (problems.length > 0) throw new Error(`\`${rule.match.trim()}\`: ${problems[0]}`);
    }
    const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    this.policyStore.saveRules(applyOffer(existing, offer, input.rules, { note: `Allowed with “Always allow”, ${date}` }));
    const where = offer.scope === "sandboxed" ? "every sandboxed task" : "every task";
    this.digest.add(`You let ${input.rules.map((r) => `\`${r.match.trim()}\``).join(" and ")} run on its own in ${where} ("Always allow this").`);
    return this.emitPolicy();
  }

  // ── memory (D23 & Phase 6A: notes for task briefs and ARIA's own prompt; Customize › Memory) ────────────────

  memoryState(): MemoryState {
    const memories = this.db.listMemories();
    const visibleIds = new Set(this.db.listRepos().filter((r) => !r.hidden).map((r) => r.id));
    const projects = [...new Set(memories.flatMap((m) => (m.scope === "project" && m.repoId !== undefined ? [m.repoId] : [])))];
    const leftOut = [...projects, null]
      .map((repoId) => ({ repoId, ids: briefNotes(memories, repoId).leftOut.map((m) => m.id) }))
      .filter((entry) => entry.ids.length > 0);
    const conductorLeftOut = conductorNotes(memories, visibleIds).leftOut.map((m) => m.id);
    return {
      memories,
      templateUsesMemory: /\{\{\s*memory\s*\}\}/.test(this.prompts.active("brief")),
      conductorUsesMemory: /\{\{\s*memory\s*\}\}/.test(this.prompts.active("conductor")),
      leftOut,
      ...(conductorLeftOut.length > 0 ? { conductorLeftOut } : {}),
    };
  }

  private emitMemories(): void {
    this.emit({ type: "memories", memory: this.memoryState() });
  }

  /**
   * "Save as memory" (or a note typed in Customize › Memory, or an edit there): one line in your own words. Where it
   * came from is worked out here, from your words the engine kept; nothing the window says about it is taken as is.
   */
  saveMemory(input: { id?: string | undefined; text: string; scope: MemoryScope; repoId?: number | undefined; from?: { chatItemId: string } | { taskId: string; wordsId: string } | { cardId: string } | undefined }): Memory {
    const text = input.text.trim();
    const problem = memoryProblem(text);
    if (problem) throw new Error(problem);
    if (input.scope === "project" && (input.repoId === undefined || !this.db.getRepo(input.repoId))) throw new Error("Pick the project it's for.");
    const repoId = input.scope === "project" ? input.repoId : undefined;
    let saved: Memory;
    if (input.id) {
      const existing = this.db.getMemory(input.id);
      if (!existing) throw new Error("That note doesn't exist anymore.");
      saved = this.db.saveMemory({ id: existing.id, scope: input.scope, repoId, text, source: existing.source });
    } else {
      if (this.db.listMemories().length >= MEMORIES_MAX) throw new Error(`You have ${MEMORIES_MAX} notes, the most ARIA keeps: delete one first.`);
      saved = this.db.saveMemory({ id: randomUUID(), scope: input.scope, repoId, text, source: this.memorySource(input.from) });
    }
    this.emitMemories();
    return saved;
  }

  private memorySource(from: { chatItemId: string } | { taskId: string; wordsId: string } | { cardId: string } | undefined): MemorySource {
    const notYours = "Only your own words to a task can be saved as a note.";
    const titleOf = (taskId: string, fallback?: string) => this.tasks.get(taskId)?.title ?? fallback;
    const source = (kind: MemorySource["kind"], at: number, taskId?: string, title?: string): MemorySource => ({ kind, at, ...(taskId ? { taskId } : {}), ...(title ? { taskTitle: title } : {}) });
    if (!from) return source("typed", Date.now());
    if ("chatItemId" in from) {
      const item = this.db.getTimelineItem(from.chatItemId);
      // Only your messages straight to a task (reply-to, @mention) are routed; a picked choice isn't your words.
      if (!item || item.kind !== "chat" || item.role !== "user" || !item.routedTo || item.routedTo.choice) throw new Error(notYours);
      return source(item.routedTo.action === "answer" ? "answer" : "message", item.createdAt, item.routedTo.taskId, titleOf(item.routedTo.taskId, item.routedTo.title));
    }
    if ("wordsId" in from) {
      const words = this.tasks.yours(from.taskId).find((w) => w.id === from.wordsId);
      if (!words) throw new Error(notYours);
      return source(words.kind, words.at, from.taskId, titleOf(from.taskId));
    }
    const card = this.db.getTimelineItem(from.cardId);
    if (!card || card.kind !== "card" || card.cardType !== "task_question" || card.payload.answeredBy !== "you" || !card.payload.freeform) throw new Error(notYours);
    return source("answer", card.updatedAt ?? card.createdAt, card.payload.taskId, titleOf(card.payload.taskId));
  }

  deleteMemory(id: string): void {
    if (!this.db.deleteMemory(id)) throw new Error("That note doesn't exist anymore.");
    this.emitMemories();
  }

  setSandbox(patch: Partial<SandboxSettings>): PolicySettings {
    this.policyStore.setSandbox(patch);
    return this.emitPolicy();
  }

  // ── integrations (Customize › Integrations; PLAN.md §4.13, D22, D30–D34) ─────────────────────────────────────
  // The work is in integrations/integrations.ts; the rest of the engine reads what it knows through these getters.

  private get catalog(): Catalog {
    return this.integrations.catalog;
  }

  private get toolRules(): StoredRule[] {
    return this.integrations.toolRules;
  }

  private get scopes(): Scopes {
    return this.integrations.scopes;
  }

  private get mcpConfigStore(): McpConfigStore | undefined {
    return this.integrations.mcpConfigStore;
  }

  private get mcpClient(): McpDirectClient | undefined {
    return this.integrations.mcpClient;
  }

  integrationsState(): IntegrationsState {
    return this.integrations.integrationsState();
  }

  refreshIntegrations(): Promise<IntegrationsState> {
    return this.integrations.refreshIntegrations();
  }

  setIntegrationRule(input: { server: string; wireName: string; scope: IntegrationScope; effect: ToolRuleEffect | null }): IntegrationsState {
    return this.integrations.setIntegrationRule(input);
  }

  moveIntegrationRules(input: { from: string; to: string }): IntegrationsState {
    return this.integrations.moveIntegrationRules(input);
  }

  forgetIntegrationServer(input: { server: string }): IntegrationsState {
    return this.integrations.forgetIntegrationServer(input);
  }

  importCliMcp(input: { overwriteAriaEdits?: boolean } = {}): Promise<{
    state: IntegrationsState;
    imported: number;
    updated: number;
    skipped: number;
  }> {
    return this.integrations.importCliMcp(input);
  }

  setMcpKeepInSync(input: { keepInSync: boolean } | boolean): Promise<IntegrationsState> {
    return this.integrations.setMcpKeepInSync(input);
  }

  saveMcpServer(input: z.infer<typeof SaveMcpServerInput>): IntegrationsState {
    return this.integrations.saveMcpServer(input);
  }

  removeMcpServer(input: { server: string } | string): IntegrationsState {
    return this.integrations.removeMcpServer(input);
  }

  setMcpServerToken(input: { server: string; bearerToken: string | null }): IntegrationsState {
    return this.integrations.setMcpServerToken(input);
  }

  testMcpServer(input: { server: string } | string): Promise<IntegrationTestResult> {
    return this.integrations.testMcpServer(input);
  }

  signIn(server: string): Promise<{ url?: string; host?: string; connected?: boolean }> {
    return this.integrations.signIn(server);
  }

  cancelSignIn(): Promise<void> {
    return this.integrations.cancelSignIn();
  }

  // ── marketplaces, plugins, agents & skills (Customize › Integrations) ────────────────────────────────────────

  addMarketplace(input: { source: string } | string): Promise<{ state: IntegrationsState; name: string }> {
    return this.plugins.addMarketplace(input);
  }

  removeMarketplace(input: { name: string; force?: boolean }): Promise<{
    state: IntegrationsState;
    removed: boolean;
    dependentPlugins?: string[];
  }> {
    return this.plugins.removeMarketplace(input);
  }

  browseMarketplace(input: { name: string } | string): Promise<{ plugins: MarketplaceCatalogPlugin[] }> {
    return this.plugins.browseMarketplace(input);
  }

  refreshMarketplaces(input: { name?: string } = {}): Promise<IntegrationsState> {
    return this.plugins.refreshMarketplaces(input);
  }

  installPlugin(input: { source: string } | string): Promise<{
    state: IntegrationsState;
    plugin: InstalledPluginItem;
    skillsInstalled: number;
    postInstallMessage?: string;
    deprecationWarning?: string;
  }> {
    return this.plugins.installPlugin(input);
  }

  uninstallPlugin(input: { name: string; directSourceId?: string }): Promise<IntegrationsState> {
    return this.plugins.uninstallPlugin(input);
  }

  updatePlugin(input: { name?: string } = {}): Promise<{
    state: IntegrationsState;
    updatedCount: number;
    message?: string;
  }> {
    return this.plugins.updatePlugin(input);
  }

  setPluginEnabled(input: { name: string; enabled: boolean }): Promise<IntegrationsState> {
    return this.plugins.setPluginEnabled(input);
  }

  setSkillEnabled(input: { name: string; enabled: boolean }): Promise<IntegrationsState> {
    return this.plugins.setSkillEnabled(input);
  }

  addPluginDirectory(input: { path: string } | string): Promise<IntegrationsState> {
    return this.plugins.addPluginDirectory(input);
  }

  removePluginDirectory(input: { path: string } | string): Promise<IntegrationsState> {
    return this.plugins.removePluginDirectory(input);
  }

  addSkillDirectory(input: { path: string } | string): Promise<IntegrationsState> {
    return this.plugins.addSkillDirectory(input);
  }

  removeSkillDirectory(input: { path: string } | string): Promise<IntegrationsState> {
    return this.plugins.removeSkillDirectory(input);
  }

  addAgentDirectory(input: { path: string } | string): Promise<IntegrationsState> {
    return this.plugins.addAgentDirectory(input);
  }

  removeAgentDirectory(input: { path: string } | string): Promise<IntegrationsState> {
    return this.plugins.removeAgentDirectory(input);
  }

  // ── prompts (Customize › Prompts; PLAN.md §5.3) ─────────────────────────────────────────────────────────────
  // The brief template applies to the next task; ARIA's prompt from your next message on (ensureCurrentPrompt).

  listPrompts(): PromptInfo[] {
    return this.prompts.list();
  }

  promptHistory(name: string): PromptVersion[] {
    return this.prompts.history(name);
  }

  savePrompt(name: string, text: string, note?: string): PromptInfo {
    return this.afterPromptChange(name, this.prompts.save(name, text, note));
  }

  rollbackPrompt(name: string, version: number): PromptInfo {
    return this.afterPromptChange(name, this.prompts.rollback(name, version));
  }

  resetPrompt(name: string): PromptInfo {
    return this.afterPromptChange(name, this.prompts.reset(name));
  }

  private afterPromptChange(name: string, info: PromptInfo): PromptInfo {
    // A profile's instructions are part of the profile.
    if (name.startsWith("profile:")) this.emitProfiles();
    // Whether briefs or ARIA's own prompt get your notes depends on {{memory}} in their templates.
    if (name === "brief" || name === "conductor") this.emitMemories();
    return info;
  }

  // ── search (Phase 6A, PLAN.md §5.2, §10 Phase 6A) ────────────────────────────────────────────────────────────

  /**
   * Searches across session transcripts (tasks and ARIA's own conversation), tasks, projects, and memories.
   * Plain code over SQLite (`session_transcripts`, `tasks`, `repos`, `memories`): zero model calls.
   * Lazily backfills `session_transcripts` once for any pre-Phase-6A session that hasn't been indexed yet.
   */
  async search(input: { query: string; scope?: SearchScope; repoId?: number; limit?: number }): Promise<SearchResults> {
    if (input.query.trim() && (!input.scope || input.scope === "all" || input.scope === "transcripts")) {
      await this.tasks.ensureTranscriptsIndexed(input.repoId);
      if (input.repoId === undefined && this.conductor && !this.db.isTranscriptBackfilled("conductor")) {
        try {
          await this.inspector.readHistory(this.conductor);
        } catch {
          // Leave un-backfilled so a subsequent search retries.
        }
      }
    }
    return searchAria(input, {
      tracker: () => this.tracker,
      projects: () => this.db.listRepos(),
      tasks: () => this.tasks.list(),
      memories: () => this.db.listMemories(),
      timeline: () => this.db.listTimeline(),
      searchTranscriptEntries: (tokens, options) => this.db.searchTranscriptEntries(tokens, options),
      hasTranscriptMessage: (ownerId, kind, text) => this.db.hasTranscriptMessage(ownerId, kind, text),
    });
  }

  // ── Automations, Reminders, Morning Brief and Utility Model (Phase 6B, PLAN.md §4.12, §5.2, §5.4, §10 Phase 6B)

  private get schedulerRunner(): Scheduler {
    if (!this.scheduler) throw new Error("ARIA engine isn't started");
    return this.scheduler;
  }

  utilitySettings(): UtilitySettings {
    const stored = this.store ? this.db.getSetting<Partial<UtilitySettings>>("utility.settings") : undefined;
    return utilitySettingsFrom(stored, this.models, this.options.defaultModel);
  }

  setUtilitySettings(patch: Partial<UtilitySettings>): UtilitySettings {
    const next = patchedUtilitySettings(this.utilitySettings(), patch, this.models);
    this.db.setSetting("utility.settings", next);
    this.emit({ type: "utility", utility: next });
    return next;
  }

  listRoutines(): Routine[] {
    return this.schedulerRunner.listRoutines();
  }

  saveRoutine(input: {
    id?: string;
    name: string;
    cron: string;
    prompt?: string;
    enabled?: boolean;
    runOnFirstOpen?: boolean;
  }): Routine {
    return this.schedulerRunner.saveRoutine({ ...input, createdBy: "you" });
  }

  toggleRoutine(input: { id: string; enabled?: boolean; runOnFirstOpen?: boolean }): Routine {
    return this.schedulerRunner.toggleRoutine(input);
  }

  runRoutine(id: string): Promise<Routine> {
    return this.schedulerRunner.runRoutine(id);
  }

  deleteRoutine(id: string): void {
    this.schedulerRunner.deleteRoutine(id);
  }

  listReminders(): Reminder[] {
    return this.schedulerRunner.listReminders();
  }

  createReminder(input: { text: string; inMinutes?: number; at?: string }): Reminder {
    return this.schedulerRunner.createReminder({ ...input, createdBy: "you" });
  }

  snoozeReminder(reminderId: string, minutes: number): Reminder {
    return this.schedulerRunner.snoozeReminder(reminderId, minutes);
  }

  dismissReminder(reminderId: string): Reminder {
    return this.schedulerRunner.dismissReminder(reminderId);
  }

  deleteReminder(reminderId: string): void {
    this.schedulerRunner.deleteReminder(reminderId);
  }

  // ── Onboarding, Copilot CLI Doctor & Release Notes ───────────────────────────────────────────────────────────

  private availableUpdateInfo: AvailableUpdateInfo | undefined;

  appVersion(): string {
    return this.options.appVersion?.trim() || DEFAULT_APP_VERSION;
  }

  releases(): readonly ReleaseNoteEntry[] {
    return this.options.releases ?? RELEASES;
  }

  availableUpdate(): AvailableUpdateInfo | undefined {
    return this.availableUpdateInfo;
  }

  async checkForAppUpdate(): Promise<AvailableUpdateInfo | null> {
    const fetchFn = this.options.updateCheckFetch;
    if (!fetchFn || this.stopped) return null;
    const response = await fetchFn(ARIA_LATEST_RELEASE_URL, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "ARIA",
      },
      cache: "no-store",
      credentials: "omit",
    });
    if (!response.ok || this.stopped) return null;
    const raw = (await response.json()) as unknown;
    if (this.stopped) return null;
    const found = parseLatestGitHubRelease(raw, this.appVersion());
    this.availableUpdateInfo = found ?? undefined;
    if (found) {
      this.emit({ type: "available_update", availableUpdate: found });
    }
    return found;
  }

  logDir(): string {
    return path.join(this.options.dataDir, "logs");
  }

  onboardingState(): OnboardingState {
    if (!this.store) {
      return {
        lastSeenVersion: this.appVersion(),
        dismissedWhatsNewVersion: this.appVersion(),
        setupCompleted: false,
        tourCompleted: false,
        updatedAt: Date.now(),
      };
    }
    const stored = this.db.getSetting<OnboardingState>("onboarding.state");
    return (
      stored ?? {
        lastSeenVersion: this.appVersion(),
        dismissedWhatsNewVersion: this.appVersion(),
        setupCompleted: false,
        tourCompleted: false,
        updatedAt: Date.now(),
      }
    );
  }

  setOnboardingState(patch: {
    setupCompleted?: boolean;
    tourCompleted?: boolean;
    lastSeenVersion?: string;
    dismissedWhatsNewVersion?: string;
    dismissedAvailableUpdateVersion?: string;
  }): OnboardingState {
    const current = this.onboardingState();
    const now = (this.options.attentionClock ?? realClock).now();
    const next: OnboardingState = {
      ...current,
      ...(patch.setupCompleted !== undefined ? { setupCompleted: patch.setupCompleted } : {}),
      ...(patch.tourCompleted !== undefined ? { tourCompleted: patch.tourCompleted } : {}),
      ...(patch.lastSeenVersion !== undefined ? { lastSeenVersion: patch.lastSeenVersion } : {}),
      ...(patch.dismissedWhatsNewVersion !== undefined
        ? { dismissedWhatsNewVersion: patch.dismissedWhatsNewVersion }
        : {}),
      ...(patch.dismissedAvailableUpdateVersion !== undefined
        ? { dismissedAvailableUpdateVersion: patch.dismissedAvailableUpdateVersion }
        : {}),
      updatedAt: now,
    };
    this.db.setSetting("onboarding.state", next);
    this.emit({ type: "onboarding", onboarding: next });
    return next;
  }

  async runDoctor(): Promise<DoctorReport> {
    let wtPath: string | undefined;
    let wtError: string | undefined;
    try {
      wtPath = this.worktreeRoot();
    } catch (error) {
      wtError = message(error);
    }
    const report = await runDoctor({
      tracker: () => this.tracker,
      now: () => (this.options.attentionClock ?? realClock).now(),
      status: () => this.status,
      conductorSettings: () => (this.store ? this.conductorSettings() : {}),
      models: () => this.listModels(),
      runtimeAlive: async () => (this.runtimeStarted ? this.options.runtime.isAlive().catch(() => false) : false),
      runtimeFallback: () => (this.runtimeStarted ? this.options.runtime.runtimeFallback?.() : undefined),
      worktreeRoot: () => ({
        ...(wtPath ? { path: wtPath } : {}),
        ...(this.dirsError ?? wtError ? { error: this.dirsError ?? wtError } : {}),
      }),
      projectsCount: () => (this.store ? this.db.listRepos().filter((r) => !r.hidden).length : 0),
      sandbox: () =>
        this.store
          ? this.policySettings().sandbox
          : { ...this.sandboxSupport, enabled: true, allowedHosts: [], allowedPaths: [] },
      github: () => this.watchers?.githubState() ?? { status: "off", inbox: false },
      integrations: () => this.integrationsState(),
      logDir: this.logDir(),
    });
    this.latestDoctorReport = report;
    if (!this.stopped) {
      this.emit({ type: "doctor", doctor: report });
    }
    return report;
  }

  /**
   * Executes a custom `"prompt"` routine on the Conductor when idle, with `this.activeRoutineTurn` set so user-gated
   * tools (`decide_permission` approve, `review_plan` approve, `continue_budget`, `remember`, `forget`, `remind_me`,
   * `schedule_routine`) are refused during the automated turn (D65).
   */
  private async runPromptRoutine(routine: Routine): Promise<string> {
    const promptText = routine.prompt?.trim();
    if (!promptText) throw new Error("This routine has no prompt configured.");

    const waitDeadline = Date.now() + 30_000;
    while ((this.status.state !== "ready" || this.inAutomatedTurn) && !this.stopped) {
      if (Date.now() > waitDeadline) {
        throw new Error("ARIA was busy with another conversation turn.");
      }
      await this.statusChange(ROUTINE_RECHECK_MS);
    }
    if (this.stopped || !this.conductor || this.status.state !== "ready" || this.inAutomatedTurn) {
      throw new Error("ARIA isn't ready right now.");
    }

    const turnState: { error?: string; reply?: string } = {};
    this.activeRoutineTurn = turnState;
    let timedOut = false;
    try {
      await this.ensureCurrentPrompt();
      const conductor = this.conductor;
      if (!conductor || this.status.state !== "ready") {
        throw new Error("ARIA isn't ready right now.");
      }

      const text = `[Scheduled routine: ${routine.name}] ${promptText}`;
      const digest = this.digest.build();
      const prompt = withDigest(text, digest.text);
      this.addToTimeline({
        kind: "chat",
        id: randomUUID(),
        role: "user",
        content: text,
        createdAt: Date.now(),
        routineId: routine.id,
        ...(digest.text ? { digest: digest.text } : {}),
      });
      const sent = { prompt, text, ...(digest.text ? { digest: digest.text } : {}) };
      this.inspector.promptSent(sent);

      this.setStatus({ ...this.status, state: "busy" });
      try {
        await conductor.send(prompt);
        this.digest.drain(digest.upTo);
      } catch (error) {
        this.inspector.promptNotSent(sent);
        this.turnNotSent();
        throw error;
      }

      const isBusy = () => this.status.state === "busy";
      const turnDeadline = Date.now() + 60_000;
      while (isBusy() && !this.stopped) {
        if (Date.now() > turnDeadline) {
          timedOut = true;
          await conductor.abort().catch(ignoreCleanupFailure);
          const abortDeadline = Date.now() + 5_000;
          while (isBusy() && !this.stopped && Date.now() <= abortDeadline) {
            await this.statusChange(ROUTINE_RECHECK_MS);
          }
          throw new Error("The scheduled routine timed out after 60 seconds and was aborted.");
        }
        await this.statusChange(ROUTINE_RECHECK_MS);
      }

      if (turnState.error) {
        throw new Error(turnState.error);
      }

      return turnState.reply ?? "Completed.";
    } finally {
      if (!timedOut || (this.status.state as string) !== "busy") {
        if (this.activeRoutineTurn === turnState) {
          this.activeRoutineTurn = undefined;
        }
      }
    }
  }
}
