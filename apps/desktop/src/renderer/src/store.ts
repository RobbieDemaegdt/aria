// The transcript helpers' own entry point: the protocol's main one would bundle zod and the IPC schemas.
import { CONDUCTOR_TRANSCRIPT_MAX_TURNS, lastTurns, mergeEntries, startsTurn, writesPlan } from "@aria/protocol/transcript";
import type {
  Activity,
  AppState,
  AttentionSettings,
  AvailableUpdateInfo,
  ConductorSettings,
  ConductorStatus,
  CreateProjectInput,
  CreateReminderInput,
  CustomizePage,
  DailyBudgetState,
  DataState,
  DoctorReport,
  EngineEvent,
  GitHubState,
  InstalledPluginItem,
  IntegrationScope,
  IntegrationsState,
  IntegrationTestResult,
  ListActivitiesInput,
  MarketplaceCatalogPlugin,
  Memory,
  MemoryState,
  ModelOption,
  MyWorkState,
  OnboardingState,
  PermissionDecision,
  PlanDecision,
  PolicyRule,
  PolicySettings,
  Profile,
  ProfilePolicy,
  Project,
  ReleaseNoteEntry,
  Reminder,
  Routine,
  RuleCheck,
  RuleOffer,
  SaveMcpServerInput,
  SaveMemoryInput,
  SaveProfileInput,
  SaveRoutineInput,
  SaveTimeRuleInput,
  SearchResults,
  SearchScope,
  SetActiveTrackerInput,
  SetBudgetSettingsInput,
  SetTranscriptRetentionInput,
  SetPhonePushSecretsInput,
  SetTimekeeperSettingsInput,
  SetUtilitySettingsInput,
  StartTaskInput,
  Task,
  TelegramRelayStatus,
  TimelineItem,
  TimeRule,
  TrackerChangePreview,
  TrackerImportResult,
  TrackerInfo,
  TimeViewState,
  TimekeeperSettings,
  TodayTimeSummary,
  ToggleRoutineInput,
  ToolRuleEffect,
  TranscriptEntry,
  TranscriptPage,
  UiState,
  UpdateCheckResult,
  UpdateRegisteredEntryInput,
  UpdateStatus,
  UpdateTimesheetEntryInput,
  UtilitySettings,
  DeleteRegisteredEntriesInput,
  Watch,
  YourWords,
} from "@aria/protocol";
import type { z } from "zod";
import { create } from "zustand";
import { speakAnnouncement } from "./voice";
import { watchTarget } from "./rows";
import { isActive } from "./components/tasks";

export type SessionTab = "transcript" | "plan" | "diff";

/** Where your next chat message goes instead of ARIA (reply-to, PLAN.md §4.5): a task, or the question it asks. */
export interface ReplyTarget {
  taskId: string;
  title: string;
  /** The question it answers (its short id shows on the badge). */
  question?: { id: string; shortId: string };
}

/** What the inspector shows of ARIA's own session (PLAN.md §5.3). */
export interface InspectorView {
  /** The session the entries are from; unset until the first answer. */
  sessionId?: string;
  entries: TranscriptEntry[];
  /** Your earlier messages it doesn't show but can ("Show more"). */
  omitted: number;
  /** Your messages older than what the engine keeps for it. */
  notKept: number;
  /** How many of your messages it shows at most (live ones push the oldest out). */
  turns: number;
  loading: boolean;
  error?: string;
}

/** Your messages the inspector shows at first, and how many more per "Show more". */
export const INSPECTOR_TURNS = 30;

const EMPTY_INSPECTOR: InspectorView = { entries: [], omitted: 0, notKept: 0, turns: INSPECTOR_TURNS, loading: true };

const turnsIn = (entries: readonly TranscriptEntry[]) => entries.filter(startsTurn).length;

/**
 * Live entries on top of what's shown, keeping only the last `turns` of your messages; the counts follow the engine's.
 * It keeps (shown + omitted) at most CONDUCTOR_TRANSCRIPT_MAX_TURNS of your messages: new ones beyond that push its
 * oldest out (not kept anymore). The ones pushed out of what's shown here are still kept, so they're omitted.
 */
function withLive(view: InspectorView, entries: readonly TranscriptEntry[]): InspectorView {
  const merged = mergeEntries(view.entries, entries);
  const shown = turnsIn(view.entries);
  const added = turnsIn(merged) - shown;
  const kept = shown + view.omitted;
  const pushedOut = Math.max(0, kept + added - CONDUCTOR_TRANSCRIPT_MAX_TURNS);
  const { from, before } = lastTurns(merged, view.turns);
  const next = before ? merged.slice(from) : merged;
  return { ...view, entries: next, omitted: Math.min(CONDUCTOR_TRANSCRIPT_MAX_TURNS, kept + added) - turnsIn(next), notKept: view.notKept + pushedOut };
}

/**
 * A task's transcript in the session view (P4): its newest steps, earlier pages as you ask for them, kept up to date
 * live. Positions count from the task's first step: `omitted + i` is where `entries[i]` is.
 */
export interface LoadedTranscript {
  /** Oldest first, one after the other, up to the newest. */
  entries: TranscriptEntry[];
  /** Steps before `entries` that aren't loaded. */
  omitted: number;
  /** The task's first step (its brief), while it's among the omitted. */
  first?: TranscriptEntry;
  /** Whether one of its steps, loaded or not, wrote the task's plan file. */
  plan: boolean;
}

const EMPTY_TRANSCRIPT: LoadedTranscript = { entries: [], omitted: 0, plan: false };

const sameEntry = (a: TranscriptEntry, b: TranscriptEntry) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Live entries into a loaded transcript: one it has is updated in place, and a new one goes at the end. One from before
 * what's loaded (a step that started earlier and has just finished) waits for its page, which brings it as it is then.
 */
export function mergeLive(current: LoadedTranscript, live: readonly TranscriptEntry[]): LoadedTranscript {
  if (live.length === 0) return current;
  const oldest = current.omitted > 0 ? current.entries[0]?.at : undefined;
  const known = oldest === undefined ? undefined : new Set(current.entries.map((e) => e.id));
  const fits = known ? live.filter((e) => known.has(e.id) || e.at >= oldest!) : live;
  const first = current.first && live.findLast((e) => e.id === current.first!.id);
  if (fits.length === 0 && !first) return current;
  return {
    ...current,
    entries: fits.length ? mergeEntries(current.entries, fits) : current.entries,
    ...(first ? { first } : {}),
    plan: current.plan || fits.some(writesPlan),
  };
}

/**
 * A page read again (the session opened again, or a jump to one of its steps): steps that didn't change stay the same
 * objects, so they aren't drawn again; and what was loaded further back stays, when the page joins up with it.
 */
export function reloaded(current: LoadedTranscript | undefined, page: TranscriptPage): LoadedTranscript {
  const old = new Map(current?.entries.map((e) => [e.id, e]));
  if (current?.first) old.set(current.first.id, current.first);
  const keep = (entry: TranscriptEntry) => {
    const before = old.get(entry.id);
    return before && sameEntry(before, entry) ? before : entry;
  };
  const entries = page.entries.map(keep);
  const join = current && entries.length ? current.entries.findIndex((e) => e.id === entries[0]!.id) : -1;
  if (current && join > 0 && current.omitted + join === page.omitted) {
    return { entries: [...current.entries.slice(0, join), ...entries], omitted: current.omitted, ...(current.first ? { first: current.first } : {}), plan: page.plan };
  }
  return { entries, omitted: page.omitted, ...(page.first ? { first: keep(page.first) } : {}), plan: page.plan };
}

/** An earlier page in front of what's loaded. */
export function withEarlier(current: LoadedTranscript, page: TranscriptPage): LoadedTranscript {
  const ids = new Set(page.entries.map((e) => e.id));
  // The brief, shown all along: the same object when it joins the rest.
  const brief = current.first;
  const earlier = brief ? page.entries.map((e) => (e.id === brief.id && sameEntry(e, brief) ? brief : e)) : page.entries;
  return {
    entries: [...earlier, ...current.entries.filter((e) => !ids.has(e.id))],
    omitted: page.omitted,
    ...(page.first ? { first: current.first ?? page.first } : {}),
    plan: current.plan || page.plan,
  };
}

const without = <T,>(map: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in map)) return map;
  const { [key]: _gone, ...rest } = map;
  return rest;
};

/** What the session view held for a task, let go when it closes or another opens (P4). */
function forget(state: Pick<AriaStore, "transcripts" | "offers" | "yours">, taskId: string | null) {
  if (!taskId) return {};
  return { transcripts: without(state.transcripts, taskId), offers: without(state.offers, taskId), yours: without(state.yours, taskId) };
}

interface AriaStore {
  loaded: boolean;
  /** The task tracker: undefined until the state arrives. */
  tracker?: TrackerInfo;
  status: ConductorStatus;
  timeline: TimelineItem[];
  /** Assistant messages still streaming, by message id, in arrival order. Chunks go in once a frame. */
  streaming: Array<{ id: string; text: string }>;
  activity: string | null;
  projects: Project[];
  projectRoots: string[];
  conductor: ConductorSettings;
  ui: UiState;
  models: ModelOption[];
  /** Background tasks, newest first. */
  tasks: Task[];
  profiles: Profile[];
  profilePolicy: ProfilePolicy;
  /** "Fix it uses" (D47); unset: the default profile. */
  ciFixProfileId?: string | undefined;
  /** Permission rules and the sandbox (Customize › Permissions). */
  policy: PolicySettings;
  /** Focus mode and the away card's threshold (PLAN.md §4.5, §5.5). */
  attention: AttentionSettings;
  /** "Save as memory" notes (Customize › Memory, D23). */
  memory: MemoryState;
  /** MCP servers and tools, and your rules for them (Customize › Integrations). */
  integrations: IntegrationsState;
  /** GitHub watches, newest first (PLAN.md §4.6). */
  watches: Watch[];
  /** Whether ARIA can read GitHub, as whom, and the inbox switch. */
  github: GitHubState;
  /** Mapping rules for time registration (Phase 5B). */
  timeRules: TimeRule[];
  /** Timekeeper model, effort, and daily preferences (Phase 5C). */
  timekeeper: TimekeeperSettings;
  /** Today's draft + registered time summary for the Sidebar Time row (Phase 5D). */
  todayTime?: TodayTimeSummary | undefined;
  /** Current Time view state when loaded (Phase 5D). */
  timeView: TimeViewState | null;
  /** Optional Utility model slot for AI-written summaries (Phase 6B). */
  utility: UtilitySettings;
  /** Scheduled routines and built-in automations (Phase 6B). */
  routines: Routine[];
  /** Active and recent reminders (Phase 6B). */
  reminders: Reminder[];
  /** Live status of the two-way Telegram relay (Phase 8B). */
  telegram: TelegramRelayStatus;
  /** Daily AI-credit budget settings and today's usage (Phase 9). */
  budget?: DailyBudgetState | undefined;
  /** Current ARIA application version (e.g. "0.1.0"). */
  appVersion: string;
  /** First-run onboarding, setup checklist, and last-seen version state. */
  onboarding: OnboardingState;
  /** Structured release notes history (newest first). */
  releases: ReleaseNoteEntry[];
  /** Newer release available to download from GitHub Releases, if any. */
  availableUpdate: AvailableUpdateInfo | null;
  /** Update now's progress (D80). */
  updateStatus: UpdateStatus;
  /** Whether this build can install an update itself (an installed build). */
  canInstallUpdates: boolean;
  /** The update bar asks whether to restart (tasks are in progress, or the tray's Update to v… asked for it). */
  updateConfirming: boolean;
  /** Latest Copilot CLI & system doctor report. */
  doctor: DoctorReport | null;
  doctorLoading: boolean;
  onboardingModalOpen: boolean;
  whatsNewModalOpen: boolean;
  tourActive: boolean;
  tourStep: number;
  /** My work's list (PLAN.md §5.2, D38): fetched while it's open. */
  myWork: MyWorkState;
  /** My work is open in the session pane (its third mode, beside a task and the inspector). */
  myWorkOpen: boolean;
  /** A watch My work brings into view (a watch row's click with no card of its own, D39). */
  myWorkFocus: { watchId: number; at: number } | null;
  /** Red watches' newest cards you've looked at (the live strip's red chip goes then). */
  seenWatchCards: string[];
  /** "Always allow this" offers of the tasks opened or asked about, newest first. */
  offers: Record<string, RuleOffer[]>;
  /** Your own words to the tasks opened in the session view ("Save as memory"). */
  yours: Record<string, YourWords[]>;
  /** Last error from an action (send, save, add project, a task button), shown near where it happened. */
  actionError: string | null;
  /** Text to put in the composer (e.g. "@Moonrise "), consumed by the composer. */
  prefill: string | null;
  /** The task open in the session view, next to the chat. */
  openTaskId: string | null;
  /** The session view shows ARIA's inspector instead of a task (never both). */
  inspecting: boolean;
  inspector: InspectorView | null;
  /** Bumped to put the focus in the inspector (Inspect while it's already open). */
  inspectorFocus: number;
  sessionTab: SessionTab;
  /** The session view takes the whole width (the chat is hidden). */
  sessionFull: boolean;
  /** A task whose session composer should take the focus (Continue on a Done card), until it has. */
  composeFor: string | null;
  /** The transcript of the task open in the session view, in pages, kept up to date live (P4: dropped when it closes). */
  transcripts: Record<string, LoadedTranscript>;
  /** A card or task to bring into view (a toast or a live-strip chip was clicked). */
  focus: { cardId?: string; taskId?: string; at: number } | null;
  /** A transcript entry inside the open task or inspector to scroll to and expand (from Search, Phase 6A). */
  transcriptFocus: { taskId?: string; entryId: string; at: number } | null;
  /** Search state (Phase 6A, PLAN.md §5.2, §10 Phase 6A). */
  searchQuery: string;
  searchScope: SearchScope;
  searchRepoId: number | null;
  searchResults: SearchResults | null;
  searchLoading: boolean;
  searchError: string | null;
  searchFocus: number;
  /** Spotlight-style Quick prompt bar (Phase 6C, PLAN.md §4.1, §5.5). */
  quickPromptOpen: boolean;
  quickPromptFocus: number;
  /** The New session dialog, optionally for one project, preselected agent, or rerunning a finished task ("Rerun with…", Phase 6C). */
  newSession: { projectId?: number; rerunTaskId?: string; agent?: string; extraContext?: string; files?: string[] } | null;
  replyTo: ReplyTarget | null;
  /** Bumped to put the focus in the chat's composer (Reply on a card). */
  composerFocus: number;

  load(): Promise<void>;
  apply(event: EngineEvent): void;
  send(text: string): Promise<boolean>;
  setView(view: UiState["view"]): void;
  setCustomizePage(page: CustomizePage, editingProfileId?: string | null): void;
  setSidebarCollapsed(collapsed: boolean): void;
  saveConductorModel(model: string, reasoningEffort?: string): Promise<boolean>;
  reconnect(): Promise<boolean>;
  rescanProjects(): Promise<void>;
  addProjectFolder(): Promise<void>;
  removeProject(repoId: number): Promise<string | null>;
  addProjectRoot(path: string): Promise<string | null>;
  removeProjectRoot(path: string): Promise<string | null>;
  pickProjectRoot(): Promise<string | null>;
  createProject(input: CreateProjectInput): Promise<boolean>;
  cloneProject(url: string): Promise<boolean>;
  setPrefill(text: string | null): void;
  clearError(): void;

  openTask(taskId: string, tab?: SessionTab, entryId?: string): void;
  /** Opens the task's session with the composer focused, to send it more instructions. */
  continueTask(taskId: string): void;
  composed(): void;
  /** Closes the session view, whether it shows a task or the inspector. */
  closeTask(): void;
  /** Opens ARIA's inspector in the session view (its session is read afresh), or focuses it when it's open. */
  openInspector(entryId?: string): void;
  clearTranscriptFocus(): void;
  openSearch(): void;
  runSearch(options?: { query?: string; scope?: SearchScope; repoId?: number | null }): Promise<void>;
  openQuickPrompt(): void;
  closeQuickPrompt(): void;
  toggleQuickPrompt(): void;
  openRerunTask(taskId: string): void;
  /** `reload`: read the session again; otherwise more of what the engine holds ("Show more"). */
  loadInspector(options: { turns?: number; reload: boolean }): Promise<void>;
  /** Shows 30 more of your earlier messages, from what the engine holds (no new read). */
  showMoreInspector(): Promise<void>;
  setSessionTab(tab: SessionTab): void;
  setSessionFull(full: boolean): void;
  /** Reads the task's newest steps (or, with `through`, the page that has that step and those after it). */
  loadTranscript(taskId: string, through?: string): Promise<void>;
  /** Reads the steps before the loaded ones ("Show 200 more"); false when it couldn't. */
  loadEarlierSteps(taskId: string): Promise<boolean>;
  focusCard(cardId: string | undefined, taskId?: string): void;
  clearFocus(): void;
  openNewSession(projectId?: number, agent?: string, extraContext?: string, files?: string[]): void;
  closeNewSession(): void;
  pickFiles(): Promise<string[]>;

  startTask(input: z.infer<typeof StartTaskInput>): Promise<Task | null>;
  messageTask(taskId: string, text: string, steer: boolean): Promise<boolean>;
  answerQuestion(taskId: string, questionId: string, answer: string, wasFreeform: boolean): Promise<boolean>;
  cancelTask(taskId: string): Promise<boolean>;
  /** R1: the Done and PR cards' "Ask it to repair" (ARIA's message from the task's record, not your words). */
  repairEncoding(taskId: string): Promise<boolean>;
  discardTask(taskId: string): Promise<boolean>;
  retryTask(taskId: string): Promise<boolean>;
  resumeInterrupted(): Promise<boolean>;
  dismissInterrupted(): Promise<boolean>;
  continueBudget(taskId: string, addCredits: number): Promise<boolean>;
  setTaskModel(taskId: string, model: string, reasoningEffort?: string): Promise<boolean>;
  setTaskAgent(taskId: string, agent: string | null): Promise<boolean>;
  openInEditor(taskId: string): Promise<boolean>;

  saveProfile(input: z.infer<typeof SaveProfileInput>): Promise<Profile | null>;
  deleteProfile(profileId: string): Promise<boolean>;
  setDefaultProfile(profileId: string): Promise<boolean>;
  setProfilePolicy(policy: ProfilePolicy): Promise<boolean>;

  /** Reply on a card: your next chat message goes straight to that task (or answers its question). */
  setReplyTo(target: ReplyTarget | null): void;
  /** Sends text to the reply target; the target stays until it went, so a failed send can be tried again. */
  sendReply(text: string): Promise<boolean>;
  decidePermission(taskId: string, permissionId: string, decision: PermissionDecision, note?: string): Promise<boolean>;
  reviewPlan(taskId: string, planId: string, decision: PlanDecision, feedback?: string): Promise<boolean>;
  revokeGrant(taskId: string, grantId: string): Promise<boolean>;
  startProposal(cardId: string, profileId?: string, agent?: string | null): Promise<boolean>;
  dismissProposal(cardId: string): Promise<boolean>;
  dismissCard(cardId: string): Promise<string | null>;
  savePolicyRules(rules: Array<Omit<PolicyRule, "id"> & { id?: string }>): Promise<boolean>;
  resetPolicyRules(): Promise<boolean>;
  setSandbox(patch: { enabled?: boolean; allowedHosts?: string[]; allowedPaths?: string[] }): Promise<boolean>;
  setAttention(patch: Partial<AttentionSettings>): Promise<boolean>;
  setVoiceCloudApiKey(apiKey: string | null): Promise<boolean>;
  setPhonePushSecrets(input: z.infer<typeof SetPhonePushSecretsInput>): Promise<boolean>;
  testPhonePush(): Promise<{ ok: boolean; error?: string }>;
  setTelegramBotToken(botToken: string | null): Promise<boolean>;
  testTelegramRelay(): Promise<{ ok: boolean; botUsername?: string; error?: string }>;

  // "Always allow this" and "Save as memory" (§5.3). The forms show their own errors: these return the error text, or null.
  checkRule(input: { match: string; effect: PolicyRule["effect"]; exact?: boolean; scope?: PolicyRule["scope"] }): Promise<RuleCheck | null>;
  loadOffers(taskId: string): Promise<void>;
  acceptOffer(taskId: string, offerId: string, rules: Array<{ match: string; exact: boolean }>, confirmOverride: boolean): Promise<string | null>;
  loadYourWords(taskId: string): Promise<void>;
  saveMemory(input: z.infer<typeof SaveMemoryInput>): Promise<{ memory?: Memory; error?: string }>;
  deleteMemory(id: string): Promise<string | null>;

  // Customize › Integrations: these return the error text, or null (the page shows its own).
  refreshIntegrations(): Promise<string | null>;
  setIntegrationRule(server: string, wireName: string, scope: IntegrationScope, effect: ToolRuleEffect | null): Promise<string | null>;
  signIn(server: string): Promise<string | null>;
  cancelSignIn(): Promise<string | null>;
  moveIntegrationRules(from: string, to: string): Promise<string | null>;
  forgetIntegrationServer(server: string): Promise<string | null>;
  importCliMcp(overwriteAriaEdits?: boolean): Promise<{ imported?: number; updated?: number; skipped?: number; error?: string }>;
  setMcpKeepInSync(keepInSync: boolean): Promise<string | null>;
  testMcpServer(server: string): Promise<{ result?: IntegrationTestResult; error?: string }>;
  saveMcpServer(input: z.infer<typeof SaveMcpServerInput>): Promise<string | null>;
  removeMcpServer(server: string): Promise<string | null>;
  setMcpServerToken(server: string, bearerToken: string | null): Promise<string | null>;
  // The task tracker
  setActiveTracker(input: z.infer<typeof SetActiveTrackerInput>): Promise<{ ok: true; message: string } | { ok: false; error: string }>;
  previewTrackerChange(input: z.infer<typeof SetActiveTrackerInput>): Promise<TrackerChangePreview | { error: string }>;
  importTrackerConfig(): Promise<TrackerImportResult>;
  openTrackerFolder(): Promise<void>;
  addMarketplace(source: string): Promise<{ name?: string; error?: string }>;
  removeMarketplace(name: string, force?: boolean): Promise<{ removed?: boolean; dependentPlugins?: string[]; error?: string }>;
  browseMarketplace(name: string): Promise<{ plugins?: MarketplaceCatalogPlugin[]; error?: string }>;
  refreshMarketplaces(name?: string): Promise<string | null>;
  installPlugin(source: string): Promise<{ plugin?: InstalledPluginItem; skillsInstalled?: number; postInstallMessage?: string; deprecationWarning?: string; error?: string }>;
  uninstallPlugin(name: string, directSourceId?: string): Promise<string | null>;
  updatePlugin(name?: string): Promise<{ updatedCount?: number; message?: string; error?: string }>;
  setPluginEnabled(name: string, enabled: boolean): Promise<string | null>;
  setSkillEnabled(name: string, enabled: boolean): Promise<string | null>;
  addPluginDirectory(path: string): Promise<string | null>;
  removePluginDirectory(path: string): Promise<string | null>;
  addSkillDirectory(path: string): Promise<string | null>;
  removeSkillDirectory(path: string): Promise<string | null>;
  addAgentDirectory(path: string): Promise<string | null>;
  removeAgentDirectory(path: string): Promise<string | null>;

  // GitHub watches: these return the error text, or null.
  unwatch(watchId: number): Promise<string | null>;
  retryGitHub(): Promise<string | null>;
  retryInbox(): Promise<string | null>;
  setInboxWatch(on: boolean): Promise<string | null>;
  useGitHubAccount(cardId: string): Promise<string | null>;
  switchGitHubAccount(cardId: string): Promise<string | null>;
  watchPullRequest(key: string): Promise<string | null>;
  watchDefaultBranch(repoId: number): Promise<string | null>;

  // Pull requests (item 3, D41–D44): these return the error text, or null.
  /** Open PR (the Done card's), or Try again on a PR card: the task's card, worked out again. */
  proposePr(taskId: string): Promise<string | null>;
  /** Push and open: exactly the card at `revision`, with your edits. */
  confirmPr(input: { cardId: string; revision: number; title: string; body: string; draft: boolean; openOn: { owner: string; repo: string }; workflowsChecked: boolean }): Promise<string | null>;
  dismissPr(cardId: string): Promise<string | null>;

  // Fix it and Address comments (item 4, D45–D53): these return the error text, or null.
  fixCi(cardId: string): Promise<string | null>;
  addressReview(cardId: string, ticked: boolean): Promise<string | null>;
  startFixProposal(cardId: string, revision: number, ticked: boolean): Promise<string | null>;
  dismissFixProposal(cardId: string): Promise<string | null>;
  setCiFixProfile(profileId: string | null): Promise<string | null>;

  // Action-request cards (Phase 5A, PLAN.md §4.3, §4.13, D19, D22): return the error text, or null.
  confirmAction(input: { cardId: string; revision: number; argsJson?: string; confirmedDestructive?: boolean }): Promise<string | null>;
  cancelAction(cardId: string): Promise<string | null>;

  // Workflow dispatch cards: return the error text, or null.
  confirmWorkflowDispatch(input: { cardId: string; revision: number; ref?: string; inputs?: Record<string, string> }): Promise<string | null>;
  dismissWorkflowDispatch(cardId: string): Promise<string | null>;

  // Work tracking, tracker linking and mapping rules (Phase 5B, PLAN.md §4.14)
  setTaskTracker(taskId: string, trackerTaskId: string | null): Promise<string | null>;
  listActivities(input?: z.infer<typeof ListActivitiesInput>): Promise<Activity[]>;
  saveTimeRule(input: z.infer<typeof SaveTimeRuleInput>): Promise<{ rule?: TimeRule; error?: string }>;
  deleteTimeRule(id: string): Promise<string | null>;

  // Timekeeper and Timesheet draft card (Phase 5C, PLAN.md §4.12, §4.14, §5.4)
  saveTimekeeperSettings(input: z.infer<typeof SetTimekeeperSettingsInput>): Promise<boolean>;
  prepareTimesheet(date?: string): Promise<string | null>;
  updateTimesheetEntry(input: z.infer<typeof UpdateTimesheetEntryInput>): Promise<string | null>;
  confirmTimesheetEntry(date: string, entryId: string): Promise<string | null>;
  deleteTimesheetEntry(date: string, entryId: string): Promise<string | null>;
  acceptTimesheetRuleOffer(date: string, offerId: string): Promise<string | null>;
  dismissTimesheetRuleOffer(date: string, offerId: string): Promise<string | null>;

  // Time view and tracker Submit, Update and Delete (Phase 5D, PLAN.md §4.14, §5.2, §5.4, D16)
  openTimeView(date?: string): void;
  loadTimeView(date?: string): Promise<string | null>;
  submitTimesheet(date: string, entryIds?: string[]): Promise<string | null>;
  updateRegisteredEntry(input: z.infer<typeof UpdateRegisteredEntryInput>): Promise<string | null>;
  deleteRegisteredEntries(input: z.infer<typeof DeleteRegisteredEntriesInput>): Promise<string | null>;

  // Automations, Reminders, Morning Brief and Utility Model (Phase 6B, PLAN.md §4.12, §5.2, §5.4, §10 Phase 6B)
  openAutomations(): void;
  saveUtilitySettings(input: z.infer<typeof SetUtilitySettingsInput>): Promise<boolean>;
  saveBudgetSettings(input: z.infer<typeof SetBudgetSettingsInput>): Promise<boolean>;

  // Customize › Data (D1): read when the page opens, not kept in the store. Null when it failed (the error shows).
  loadDataState(): Promise<DataState | null>;
  setTranscriptRetention(input: z.infer<typeof SetTranscriptRetentionInput>): Promise<DataState | null>;
  cleanUpTranscripts(): Promise<DataState | null>;
  saveRoutine(input: z.infer<typeof SaveRoutineInput>): Promise<{ routine?: Routine; error?: string }>;
  toggleRoutine(input: z.infer<typeof ToggleRoutineInput>): Promise<string | null>;
  runRoutine(id: string): Promise<string | null>;
  deleteRoutine(id: string): Promise<string | null>;
  createReminder(input: z.infer<typeof CreateReminderInput>): Promise<{ reminder?: Reminder; error?: string }>;
  snoozeReminder(reminderId: string, minutes: number): Promise<string | null>;
  dismissReminder(reminderId: string): Promise<string | null>;
  deleteReminder(reminderId: string): Promise<string | null>;

  // My work (PLAN.md §5.2, D38–D40)
  openMyWork(focus?: { watchId: number }): void;
  /** `refresh`: search again (the engine waits a minute between searches). */
  loadMyWork(refresh: boolean): Promise<void>;
  /** D39: a watch row's (or chip's) click: its newest card, else My work at its item. */
  focusWatch(watchId: number): void;

  // Onboarding, Copilot CLI Doctor & Release Notes
  runDoctor(): Promise<DoctorReport | null>;
  setOnboardingState(patch: {
    setupCompleted?: boolean;
    tourCompleted?: boolean;
    lastSeenVersion?: string;
    dismissedWhatsNewVersion?: string;
    dismissedAvailableUpdateVersion?: string;
  }): Promise<boolean>;
  openCliTerminal(target: "copilot" | "gh_login"): Promise<string | null>;
  openLogsFolder(): Promise<void>;
  openOnboardingModal(): void;
  closeOnboardingModal(): void;
  openWhatsNewModal(): void;
  closeWhatsNewModal(): void;
  /** Update now (D80): asks first when tasks are in progress (updating restarts ARIA), else starts the download. */
  requestUpdate(): void;
  /** The tray's Update to v…: the update bar asks, whatever Later said. */
  promptUpdate(): void;
  /**
   * Update now, after the question (or without one): the engine downloads, checks and installs. `whenIdle`: Update
   * when they're done. While an update waits for the tasks, a call without it restarts at once.
   */
  confirmUpdate(options?: { whenIdle?: boolean }): Promise<void>;
  cancelUpdateConfirm(): void;
  /** Cancel on an update that waits for the tasks. */
  cancelUpdate(): Promise<void>;
  /** Later (D80): the update bar goes for a day. */
  snoozeUpdate(): Promise<void>;
  /** Check now (D80): what GitHub says, or null when the call itself failed (actionError says why). */
  checkForUpdates(): Promise<UpdateCheckResult | null>;
  startTour(step?: number): void;
  nextTourStep(totalSteps?: number): void;
  prevTourStep(): void;
  stopTour(completed?: boolean): void;
}

export const errorText = (error: unknown) => {
  const text = error instanceof Error ? error.message : String(error);
  // Errors thrown in main arrive as "Error invoking remote method '…': Error: <message>".
  return text.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "");
};

/** Runs a call whose error its page shows itself: the error text, or null. (The state follows from the engine's events.) */
async function failure(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call();
    return null;
  } catch (error) {
    return errorText(error);
  }
}

let unsubscribe: (() => void) | undefined;
/** Bumped by every load(); only the newest load installs its snapshot. */
let loads = 0;
/**
 * Transcript reads on their way, by task: the live entries that arrive meanwhile (replayed on top of the answer), and a
 * step to bring into view that was asked for meanwhile (read next).
 */
const transcriptLoads = new Map<string, { live: TranscriptEntry[]; through?: string | undefined }>();
/** Reads of a task's earlier steps on their way, with the live entries that arrive meanwhile. */
const earlierLoads = new Map<string, { live: TranscriptEntry[]; done: Promise<boolean> }>();
/** Bumped by every inspector load and by closing it; only the newest load installs its answer. */
let inspectorLoads = 0;
/** Live entries of ARIA's session that arrive while the inspector loads: replayed on top of its answer. */
let inspectorLive: Array<{ sessionId: string; entries: TranscriptEntry[] }> | null = null;
/** Bumped by every search request so out-of-order responses never overwrite newer ones. */
let searchSeq = 0;
/** Bumped by every loadTimeView() request so out-of-order responses never overwrite newer ones. */
let timeViewSeq = 0;
/**
 * Chunks of replies still streaming that aren't in the store yet, by message id in arrival order. A reply can bring
 * several chunks a frame: they go in together once a frame, so the chat redraws (and parses the reply) once a frame.
 */
const pendingChunks = new Map<string, string>();
/** Whether a frame is booked to apply them. */
let chunkFrame = false;

/**
 * Runs `run` before the next paint (in a test without a window, 16 ms later). Not while the window is hidden: Chromium
 * holds frames back, and the chunks go in when it's shown again or with the next event that needs them.
 */
function nextFrame(run: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => run());
  else setTimeout(run, 16);
}

function compareVersion(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/i.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return a.trim().localeCompare(b.trim());
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  }
  return 0;
}

/**
 * Whether What's New opens by itself at start: after ARIA was updated, until you've seen its notes. An update that's
 * available doesn't open it: the update bar says so (D80).
 */
export function hasStartupUpdateToNotify(state: {
  appVersion?: string;
  onboarding?: OnboardingState;
  timeline?: readonly TimelineItem[];
}): boolean {
  const current = state.appVersion ?? "0.1.0";
  const onboarding = state.onboarding;
  if (
    onboarding?.dismissedWhatsNewVersion &&
    compareVersion(current, onboarding.dismissedWhatsNewVersion) > 0
  ) {
    return true;
  }
  if (
    onboarding?.dismissedWhatsNewVersion !== current &&
    state.timeline?.some(
      (i) => i.kind === "card" && i.cardType === "whats_new" && i.payload.toVersion === current,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * The update bar (D80): an update is available and you haven't picked Later for it, or it asks whether to restart
 * (Update now from the modal or the tray), or Update now is on its way, waits for the tasks, or failed. `now`: ms
 * since the epoch.
 */
export function updateBarShown(
  state: Pick<AriaStore, "availableUpdate" | "appVersion" | "onboarding" | "updateStatus"> & Partial<Pick<AriaStore, "updateConfirming">>,
  now: number,
): boolean {
  const update = state.availableUpdate;
  if (!update || compareVersion(update.version, state.appVersion) <= 0) return false;
  if (state.updateConfirming) return true;
  if (state.updateStatus.phase !== "idle" && state.updateStatus.version === update.version) return true;
  const snooze = state.onboarding.updateSnooze;
  return !(snooze && snooze.version === update.version && now < snooze.until);
}

/**
 * Update now installs in the app: an installed build, and a release whose installer GitHub states the size and
 * checksum of. Otherwise the bar offers Download (the browser).
 */
export function canUpdateNow(state: Pick<AriaStore, "availableUpdate" | "canInstallUpdates">): boolean {
  const update = state.availableUpdate;
  return Boolean(
    state.canInstallUpdates && update?.installerUrl && update.installerName && update.installerSize && update.installerSha256,
  );
}

/** The tasks an update's restart stops (they can be resumed after it). */
export const tasksStoppedByRestart = (tasks: readonly Task[]): number => tasks.filter(isActive).length;

const NO_AGENTS: NonNullable<IntegrationsState["agents"]> = [];
/** Your agents. Always the same list when there are none (no check yet): a new one each time would re-render forever. */
export const selectAgents = (s: Pick<AriaStore, "integrations">) => s.integrations.agents ?? NO_AGENTS;

/** The active task tracker; undefined until the state arrives (the helpers in `tracker.ts` take that). */
export const useTracker = (): TrackerInfo | undefined => useAria((s) => s.tracker);

/**
 * Whether there is a task tracker. False only once the state has loaded and has none: the parts that need a
 * tracker are left out then. Before the state arrives they show, with the neutral words of `tracker.ts`.
 */
export const useHasTracker = (): boolean => useAria((s) => !s.loaded || s.tracker !== undefined);

/** Whether the tracker registers time: `useHasTracker`, and the tracker has time logs (else the Time view's task parts go too). */
export const useTracksTime = (): boolean => useAria((s) => !s.loaded || (s.tracker !== undefined && s.tracker.capabilities.timeLogs));

export const useAria = create<AriaStore>((set, get) => {
  /** Runs an action; on failure shows its error and returns the fallback. */
  async function attempt<T>(action: () => Promise<T>, fallback: T): Promise<T> {
    set({ actionError: null });
    try {
      return await action();
    } catch (error) {
      set({ actionError: errorText(error) });
      return fallback;
    }
  }
  const ok = (action: () => Promise<unknown>) =>
    attempt(async () => {
      await action();
      return true;
    }, false);
  /** Leaves the inspector: a load on its way is ignored, and the engine lets go of what it held. */
  function closeInspector(): void {
    if (!get().inspecting && !get().inspector) return;
    inspectorLoads++;
    inspectorLive = null;
    set({ inspecting: false, inspector: null });
    void window.aria.releaseConductorTranscript().catch(() => {
      // It only lets go of the inspector's copy, and the next read replaces it anyway.
    });
  }
  /**
   * Adds the chunks collected since the last frame in one update. Chunks of a message that's already final (e.g.
   * replayed after the snapshot) change nothing. Called first by anything that changes the timeline or what's
   * streaming, so each chunk is checked against the timeline it arrived with and events keep their order.
   */
  function flushChunks(): void {
    if (pendingChunks.size === 0) return;
    const { timeline } = get();
    let streaming: Array<{ id: string; text: string }> | undefined;
    for (const [id, text] of pendingChunks) {
      if (timeline.some((i) => i.id === id)) continue;
      streaming ??= [...get().streaming];
      const index = streaming.findIndex((s) => s.id === id);
      if (index >= 0) streaming[index] = { id, text: streaming[index]!.text + text };
      else streaming.push({ id, text });
    }
    pendingChunks.clear();
    if (streaming) set({ streaming });
  }

  return {
    loaded: false,
    status: { state: "starting", detail: "Starting" },
    timeline: [],
    streaming: [],
    activity: null,
    projects: [],
    projectRoots: [],
    conductor: {},
    ui: { sidebarCollapsed: false, view: "chat" },
    models: [],
    tasks: [],
    profiles: [],
    profilePolicy: "me",
    policy: { rules: [], sandbox: { supported: false, enabled: true, allowedHosts: [], allowedPaths: [] } },
    attention: { focusMode: false, awayMinutes: 15 },
    memory: { memories: [], templateUsesMemory: true, leftOut: [] },
    integrations: { servers: [], tools: [], runtimeUp: false, refreshing: false },
    watches: [],
    github: { status: "off", inbox: false },
    timeRules: [],
    timekeeper: { expectedMinutes: 480, roundingMinutes: 15, workStart: "09:00", workEnd: "17:00", timesheetTime: "16:30" },
    todayTime: undefined,
    timeView: null,
    utility: { enabled: false },
    routines: [],
    reminders: [],
    telegram: { state: "off" },
    budget: undefined,
    appVersion: "0.1.0",
    onboarding: { lastSeenVersion: "0.1.0", dismissedWhatsNewVersion: "0.1.0", setupCompleted: false, tourCompleted: false, updatedAt: 0 },
    releases: [],
    availableUpdate: null,
    updateStatus: { phase: "idle" },
    canInstallUpdates: false,
    updateConfirming: false,
    doctor: null,
    doctorLoading: false,
    onboardingModalOpen: false,
    whatsNewModalOpen: false,
    tourActive: false,
    tourStep: 0,
    myWork: { status: "off", items: [], more: { review_requested: 0, authored: 0, assigned: 0 } },
    myWorkOpen: false,
    myWorkFocus: null,
    seenWatchCards: [],
    offers: {},
    yours: {},
    actionError: null,
    prefill: null,
    openTaskId: null,
    inspecting: false,
    inspector: null,
    inspectorFocus: 0,
    sessionTab: "transcript",
    sessionFull: false,
    composeFor: null,
    transcripts: {},
    focus: null,
    transcriptFocus: null,
    searchQuery: "",
    searchScope: "all",
    searchRepoId: null,
    searchResults: null,
    searchLoading: false,
    searchError: null,
    searchFocus: 0,
    quickPromptOpen: false,
    quickPromptFocus: 0,
    newSession: null,
    replyTo: null,
    composerFocus: 0,

    async load() {
      const load = ++loads;
      unsubscribe?.();
      // Events that arrive while the snapshot is on its way are newer than it or already in it: keep them and replay
      // them on top, instead of letting the snapshot overwrite them.
      let early: EngineEvent[] | null = [];
      unsubscribe = window.aria.onEvent((event) => (early ? early.push(event) : get().apply(event)));
      const state: AppState = await window.aria.getState();
      if (load !== loads) return;
      const autoOpenUpdatePopup = hasStartupUpdateToNotify(state);
      flushChunks();
      set({
        ...state,
        availableUpdate: state.availableUpdate ?? null,
        updateStatus: state.updateStatus ?? { phase: "idle" },
        canInstallUpdates: state.canInstallUpdates ?? false,
        loaded: true,
        ...(autoOpenUpdatePopup ? { whatsNewModalOpen: true } : {}),
      });
      const replay = early;
      early = null;
      for (const event of replay) get().apply(event);
    },

    apply(event) {
      if (event.type === "delta") {
        pendingChunks.set(event.itemId, (pendingChunks.get(event.itemId) ?? "") + event.text);
        if (!chunkFrame) {
          chunkFrame = true;
          nextFrame(() => {
            chunkFrame = false;
            flushChunks();
          });
        }
        return;
      }
      // The chunks before an event that changes the timeline or what's streaming go in first (a final message then
      // drops its own). Other events leave the chunks to their frame: they don't change the reply.
      if (event.type === "status" || event.type === "timeline" || event.type === "timeline_removed") flushChunks();
      switch (event.type) {
        case "status": {
          const streaming = event.status.state === "busy" ? get().streaming : [];
          set({ status: event.status, streaming, ...(event.status.state !== "busy" ? { activity: null } : {}) });
          break;
        }
        case "timeline": {
          // Replace in place: items that update (task cards, answered questions) keep their spot in the conversation.
          const timeline = [...get().timeline];
          const index = timeline.findIndex((i) => i.id === event.item.id);
          if (index >= 0) timeline[index] = event.item;
          else timeline.push(event.item);
          set({ timeline, streaming: get().streaming.filter((s) => s.id !== event.item.id) });
          break;
        }
        case "timeline_removed": {
          const removed = get().timeline.find((i) => i.id === event.id);
          const watchId = removed?.kind === "card" ? (removed.payload as { watchId?: unknown }).watchId : undefined;
          const seen = [
            ...get().seenWatchCards.filter((c) => c !== event.id && c !== `w:${watchId}`),
            event.id,
            ...(typeof watchId === "number" ? [`w:${watchId}`] : []),
          ].slice(-200);
          set({
            timeline: get().timeline.filter((i) => i.id !== event.id),
            seenWatchCards: seen,
            ...(get().focus?.cardId === event.id ? { focus: null } : {}),
          });
          break;
        }
        case "activity":
          set({ activity: event.label });
          break;
        case "projects":
          set({ projects: event.projects });
          break;
        case "project_roots":
          set({ projectRoots: event.projectRoots });
          break;
        case "models":
          set({ models: event.models });
          break;
        case "settings":
          set({ conductor: event.conductor });
          break;
        case "task": {
          const tasks = [...get().tasks];
          const index = tasks.findIndex((t) => t.id === event.task.id);
          if (index >= 0) tasks[index] = event.task;
          else tasks.unshift(event.task);
          set({ tasks });
          break;
        }
        case "task_removed": {
          set({
            tasks: get().tasks.filter((t) => t.id !== event.taskId),
            ...forget(get(), event.taskId),
            ...(get().openTaskId === event.taskId ? { openTaskId: null, sessionFull: false } : {}),
            ...(get().replyTo?.taskId === event.taskId ? { replyTo: null } : {}),
          });
          break;
        }
        case "profiles":
          set({ profiles: event.profiles, profilePolicy: event.policy, ciFixProfileId: event.ciFixProfileId });
          break;
        case "policy":
          set({ policy: event.policy });
          break;
        case "transcript": {
          transcriptLoads.get(event.taskId)?.live.push(...event.entries);
          earlierLoads.get(event.taskId)?.live.push(...event.entries);
          const current = get().transcripts[event.taskId];
          if (current) {
            const next = mergeLive(current, event.entries);
            if (next !== current) set({ transcripts: { ...get().transcripts, [event.taskId]: next } });
          }
          break;
        }
        case "conductor_transcript": {
          if (inspectorLive) {
            inspectorLive.push({ sessionId: event.sessionId, entries: event.entries });
            break;
          }
          const view = get().inspector;
          if (!view?.sessionId) break;
          if (view.sessionId === event.sessionId) {
            if (event.entries.length) set({ inspector: withLive(view, event.entries) });
          } else if (get().inspecting) {
            // ARIA continues in a fresh conversation (the old one couldn't be resumed): show that one instead.
            set({ inspector: EMPTY_INSPECTOR });
            void get().loadInspector({ turns: INSPECTOR_TURNS, reload: true });
          }
          break;
        }
        case "focus":
          get().focusCard(event.cardId, event.taskId);
          break;
        case "attention":
          set({ attention: event.settings });
          break;
        case "memories":
          set({ memory: event.memory });
          break;
        case "integrations":
          set({ integrations: event.integrations });
          break;
        case "watch": {
          const watches = [...get().watches];
          const index = watches.findIndex((w) => w.id === event.watch.id);
          if (index >= 0) watches[index] = event.watch;
          else watches.unshift(event.watch);
          set({ watches: watches.sort((a, b) => b.id - a.id) });
          break;
        }
        case "my_work":
          set({ myWork: event.myWork });
          break;
        case "tracker":
          set({ tracker: event.tracker });
          break;
        case "github":
          set({ github: event.github });
          break;
        case "time_rules":
          set({ timeRules: event.timeRules });
          break;
        case "timekeeper":
          set({ timekeeper: event.timekeeper });
          break;
        case "today_time":
          set({ todayTime: event.todayTime });
          break;
        case "utility":
          set({ utility: event.utility });
          break;
        case "routines":
          set({ routines: event.routines });
          break;
        case "reminders":
          set({ reminders: event.reminders });
          break;
        case "telegram":
          set({ telegram: event.telegram });
          break;
        case "budget":
          set({ budget: event.budget });
          break;
        case "onboarding":
          set({ onboarding: event.onboarding });
          break;
        case "available_update":
          // The update bar shows it (D80); What's New no longer opens by itself for it.
          set({ availableUpdate: event.availableUpdate });
          break;
        case "update_status":
          set({ updateStatus: event.updateStatus });
          break;
        case "doctor":
          set({ doctor: event.doctor, doctorLoading: false });
          break;
        case "quick_prompt":
          get().openQuickPrompt();
          break;
        case "update_prompt":
          get().promptUpdate();
          break;
        case "speak":
          void speakAnnouncement(event, get().attention);
          break;
        case "toast":
          // Toasts are the desktop shell's job; the card itself is already in the timeline.
          break;
      }
    },

    async send(text) {
      const cmd = text.trim().toLowerCase();
      if (cmd === "/tour") {
        get().startTour(0);
      } else if (cmd === "/setup") {
        get().openOnboardingModal();
      } else if (cmd === "/whats-new" || cmd === "/changelog") {
        get().openWhatsNewModal();
      }
      return ok(() => window.aria.sendMessage(text));
    },

    setView(view) {
      set({ ui: { ...get().ui, view }, sessionFull: false });
      void window.aria.setUiState({ view });
    },

    setCustomizePage(page, editingProfileId) {
      const nextUi: UiState = {
        ...get().ui,
        view: "customize",
        customizePage: page,
        ...(editingProfileId !== undefined ? { editingProfileId } : {}),
      };
      set({ ui: nextUi, sessionFull: false });
      void window.aria.setUiState({
        view: "customize",
        customizePage: page,
        ...(editingProfileId !== undefined ? { editingProfileId } : {}),
      });
    },

    setSidebarCollapsed(collapsed) {
      if (get().ui.sidebarCollapsed === collapsed) return;
      set({ ui: { ...get().ui, sidebarCollapsed: collapsed } });
      void window.aria.setUiState({ sidebarCollapsed: collapsed });
    },

    async saveConductorModel(model, reasoningEffort) {
      return ok(() => window.aria.setConductorModel({ model, ...(reasoningEffort ? { reasoningEffort } : {}) }));
    },

    async reconnect() {
      return ok(() => window.aria.reconnect());
    },

    async rescanProjects() {
      // The `projects` event updates the list; the reply itself can be older than events that arrived before it.
      await ok(() => window.aria.rescanProjects());
    },

    async addProjectFolder() {
      await ok(() => window.aria.addProjectFolder());
    },

    async removeProject(repoId) {
      try {
        const projects = await window.aria.removeProject({ repoId });
        set({
          projects,
          ...(get().searchRepoId === repoId ? { searchRepoId: null } : {}),
          ...(get().newSession?.projectId === repoId ? { newSession: null } : {}),
        });
        return null;
      } catch (error) {
        return errorText(error);
      }
    },

    async addProjectRoot(folderPath) {
      try {
        const roots = await window.aria.addProjectRoot({ path: folderPath });
        set({ projectRoots: roots });
        return null;
      } catch (error) {
        return errorText(error);
      }
    },

    async removeProjectRoot(folderPath) {
      try {
        const roots = await window.aria.removeProjectRoot({ path: folderPath });
        set({ projectRoots: roots });
        return null;
      } catch (error) {
        return errorText(error);
      }
    },

    async pickProjectRoot() {
      try {
        const roots = await window.aria.pickProjectRoot();
        if (roots) set({ projectRoots: roots });
        return null;
      } catch (error) {
        return errorText(error);
      }
    },

    async createProject(input) {
      return ok(() => window.aria.createProject(input));
    },

    async cloneProject(url) {
      return ok(() => window.aria.cloneProject(url));
    },

    setPrefill(text) {
      set({
        prefill: text,
        ...(text
          ? {
              ui: { ...get().ui, view: "chat" as const },
              sessionFull: false,
              composerFocus: get().composerFocus + 1,
            }
          : {}),
      });
    },

    clearError() {
      set({ actionError: null });
    },

    openTask(taskId, tab = "transcript", entryId) {
      closeInspector();
      const previous = get().openTaskId;
      // A step that's loaded already (or the brief) needs no page of its own: the newest page is read again, and joins
      // what's there.
      const current = previous === taskId ? get().transcripts[taskId] : undefined;
      const loaded = entryId !== undefined && current !== undefined && (current.first?.id === entryId || current.entries.some((e) => e.id === entryId));
      set({
        ...(previous !== taskId ? forget(get(), previous) : {}),
        openTaskId: taskId,
        sessionTab: tab,
        myWorkOpen: false,
        transcriptFocus: entryId ? { taskId, entryId, at: Date.now() } : null,
      });
      void get().loadTranscript(taskId, loaded ? undefined : entryId);
    },

    continueTask(taskId) {
      closeInspector();
      const previous = get().openTaskId;
      set({
        ...(previous !== taskId ? forget(get(), previous) : {}),
        openTaskId: taskId,
        sessionTab: "transcript",
        composeFor: taskId,
        myWorkOpen: false,
        transcriptFocus: null,
      });
      void get().loadTranscript(taskId);
    },

    composed() {
      set({ composeFor: null });
    },

    closeTask() {
      closeInspector();
      set({ ...forget(get(), get().openTaskId), openTaskId: null, sessionFull: false, composeFor: null, myWorkOpen: false, myWorkFocus: null, transcriptFocus: null });
    },

    openInspector(entryId) {
      const targetEntryId = typeof entryId === "string" && entryId ? entryId : undefined;
      // Already open: reading it again would throw away what you scrolled to and "Show more"; it takes the focus.
      if (get().inspecting && !targetEntryId) {
        set({ inspectorFocus: get().inspectorFocus + 1 });
        return;
      }
      const turns = targetEntryId ? CONDUCTOR_TRANSCRIPT_MAX_TURNS : INSPECTOR_TURNS;
      set({
        ...forget(get(), get().openTaskId),
        openTaskId: null,
        composeFor: null,
        inspecting: true,
        inspector: { ...EMPTY_INSPECTOR, turns },
        myWorkOpen: false,
        transcriptFocus: targetEntryId ? { entryId: targetEntryId, at: Date.now() } : null,
      });
      void get().loadInspector({ turns, reload: true });
    },

    clearTranscriptFocus() {
      set({ transcriptFocus: null });
    },

    openSearch() {
      set({
        ui: { ...get().ui, view: "search" },
        sessionFull: false,
        searchFocus: get().searchFocus + 1,
      });
      void window.aria.setUiState({ view: "search" });
      if (get().searchQuery.trim()) void get().runSearch();
    },

    async runSearch(options) {
      const query = options?.query !== undefined ? options.query : get().searchQuery;
      const scope = options?.scope !== undefined ? options.scope : get().searchScope;
      const repoId = options?.repoId !== undefined ? options.repoId : get().searchRepoId;
      const seq = ++searchSeq;
      set({
        searchQuery: query,
        searchScope: scope,
        searchRepoId: repoId,
        searchError: null,
        ...(query.trim() ? { searchLoading: true } : { searchResults: null, searchLoading: false }),
      });
      if (!query.trim()) return;
      try {
        const results = await window.aria.search({
          query,
          scope,
          ...(repoId !== null ? { repoId } : {}),
        });
        if (seq !== searchSeq) return;
        set({ searchResults: results, searchLoading: false });
      } catch (error) {
        if (seq !== searchSeq) return;
        set({ searchError: errorText(error), searchLoading: false });
      }
    },

    async loadInspector({ turns, reload }) {
      const load = ++inspectorLoads;
      const live: Array<{ sessionId: string; entries: TranscriptEntry[] }> = [];
      inspectorLive = live;
      const view = get().inspector ?? EMPTY_INSPECTOR;
      const wanted = Math.min(turns ?? view.turns, CONDUCTOR_TRANSCRIPT_MAX_TURNS);
      const { error: _error, ...rest } = view;
      set({ inspector: { ...rest, turns: wanted, loading: true } });
      try {
        const result = await window.aria.getConductorTranscript({ turns: wanted, reload });
        if (load !== inspectorLoads || !get().inspecting) return;
        // Live entries of the same session that came meanwhile are newer than (or the same as) the answer.
        let next: InspectorView = { sessionId: result.sessionId, entries: result.entries, omitted: result.omitted, notKept: result.notKept, turns: wanted, loading: false };
        for (const batch of live) if (batch.sessionId === result.sessionId) next = withLive(next, batch.entries);
        set({ inspector: next });
        // ARIA switched to another session while this was on its way: read that one.
        if (live.some((batch) => batch.sessionId !== result.sessionId)) void get().loadInspector({ turns: wanted, reload: true });
      } catch (error) {
        if (load !== inspectorLoads || !get().inspecting) return;
        set({ inspector: { ...(get().inspector ?? rest), turns: wanted, loading: false, error: errorText(error) } });
      } finally {
        if (inspectorLive === live) inspectorLive = null;
      }
    },

    async showMoreInspector() {
      const view = get().inspector;
      // Nothing more is kept, or it already asks for all there can be.
      if (!view || view.omitted === 0 || view.turns >= CONDUCTOR_TRANSCRIPT_MAX_TURNS) return;
      await get().loadInspector({ turns: view.turns + INSPECTOR_TURNS, reload: false });
    },

    setSessionTab(tab) {
      set({ sessionTab: tab });
    },

    setSessionFull(full) {
      set({ sessionFull: full });
    },

    async loadTranscript(taskId, through) {
      const running = transcriptLoads.get(taskId);
      if (running) {
        // A step to bring into view, asked for while a read is on its way: read its page after.
        if (through) running.through = through;
        return;
      }
      const load: { live: TranscriptEntry[]; through?: string | undefined } = { live: [] };
      transcriptLoads.set(taskId, load);
      try {
        const page = await window.aria.getTranscript({ taskId, ...(through ? { through } : {}) });
        // Closed (or another opened) meanwhile: what it held is let go, and so is this.
        if (get().openTaskId !== taskId) return;
        set({ transcripts: { ...get().transcripts, [taskId]: mergeLive(reloaded(get().transcripts[taskId], page), load.live) } });
      } catch (error) {
        if (get().openTaskId !== taskId) return;
        set({ actionError: errorText(error), transcripts: { ...get().transcripts, [taskId]: get().transcripts[taskId] ?? EMPTY_TRANSCRIPT } });
      } finally {
        transcriptLoads.delete(taskId);
        if (load.through && get().openTaskId === taskId) void get().loadTranscript(taskId, load.through);
      }
    },

    loadEarlierSteps(taskId) {
      const running = earlierLoads.get(taskId);
      if (running) return running.done;
      const current = get().transcripts[taskId];
      const before = current?.entries[0];
      if (!current || current.omitted === 0 || !before) return Promise.resolve(false);
      // Noted before it's asked for, so live entries from the start are kept and a second ask joins this one.
      const load: { live: TranscriptEntry[]; done: Promise<boolean> } = { live: [], done: Promise.resolve(false) };
      const { live } = load;
      earlierLoads.set(taskId, load);
      load.done = (async () => {
        try {
          const page = await window.aria.getTranscript({ taskId, before: before.id });
          const now = get().transcripts[taskId];
          // Closed meanwhile, or read again from somewhere else (a jump to a step): this page doesn't join up.
          if (get().openTaskId !== taskId || !now || now.entries[0]?.id !== before.id || now.omitted !== page.omitted + page.entries.length) return false;
          // Steps of this page that changed while it was on its way: the live view of them is the newer one.
          const latest = new Map(live.map((e) => [e.id, e]));
          const entries = page.entries.map((e) => latest.get(e.id) ?? e);
          set({ transcripts: { ...get().transcripts, [taskId]: withEarlier(now, { ...page, entries }) } });
          return true;
        } catch (error) {
          if (get().openTaskId === taskId) set({ actionError: errorText(error) });
          return false;
        } finally {
          if (earlierLoads.get(taskId) === load) earlierLoads.delete(taskId);
        }
      })();
      return load.done;
    },

    focusCard(cardId, taskId) {
      // A card older than the timeline the window loaded (its last 1000 items) can't be scrolled to: its task opens.
      if (cardId && taskId && !get().timeline.some((i) => i.id === cardId) && get().tasks.some((t) => t.id === taskId)) {
        get().openTask(taskId);
        return;
      }
      const seenWatchCards = cardId ? [...get().seenWatchCards.filter((c) => c !== cardId), cardId].slice(-200) : get().seenWatchCards;
      set({ focus: { ...(cardId ? { cardId } : {}), ...(taskId ? { taskId } : {}), at: Date.now() }, seenWatchCards, ui: { ...get().ui, view: "chat" }, sessionFull: false });
      void window.aria.setUiState?.({ view: "chat" });
    },

    clearFocus() {
      set({ focus: null });
    },

    openNewSession(projectId, agent, extraContext, files) {
      set({
        newSession: {
          ...(projectId !== undefined ? { projectId } : {}),
          ...(agent ? { agent } : {}),
          ...(extraContext ? { extraContext } : {}),
          ...(files?.length ? { files } : {}),
        },
        actionError: null,
      });
    },

    openRerunTask(taskId) {
      const source = get().tasks.find((t) => t.id === taskId);
      if (!source) return;
      set({
        newSession: {
          projectId: source.repoId,
          rerunTaskId: source.id,
          ...(source.extraContext ? { extraContext: source.extraContext } : {}),
          ...(source.files?.length ? { files: source.files } : {}),
        },
        actionError: null,
      });
    },

    closeNewSession() {
      set({ newSession: null });
    },

    async pickFiles() {
      if (typeof window === "undefined" || !window.aria?.pickFiles) return [];
      return attempt(() => window.aria.pickFiles!(), []);
    },

    openQuickPrompt() {
      set({ quickPromptOpen: true, quickPromptFocus: get().quickPromptFocus + 1, actionError: null });
    },

    closeQuickPrompt() {
      set({ quickPromptOpen: false });
    },

    toggleQuickPrompt() {
      if (get().quickPromptOpen) get().closeQuickPrompt();
      else get().openQuickPrompt();
    },

    async startTask(input) {
      return attempt(() => window.aria.startTask(input), null);
    },
    async messageTask(taskId, text, steer) {
      const sent = await ok(() => window.aria.messageTask({ taskId, text, steer }));
      // Your words to it: the session view offers "Save as memory" on them.
      if (sent && get().yours[taskId]) void get().loadYourWords(taskId);
      return sent;
    },
    async answerQuestion(taskId, questionId, answer, wasFreeform) {
      const sent = await ok(() => window.aria.answerQuestion({ taskId, questionId, answer, wasFreeform }));
      if (sent && get().yours[taskId]) void get().loadYourWords(taskId);
      return sent;
    },
    async cancelTask(taskId) {
      return ok(() => window.aria.cancelTask(taskId));
    },
    async repairEncoding(taskId) {
      return ok(() => window.aria.repairEncoding(taskId));
    },
    async discardTask(taskId) {
      return ok(() => window.aria.discardTask(taskId));
    },
    async retryTask(taskId) {
      return ok(() => window.aria.retryTask(taskId));
    },
    async resumeInterrupted() {
      return ok(() => window.aria.resumeInterrupted());
    },
    async dismissInterrupted() {
      return ok(() => window.aria.dismissInterrupted());
    },
    async continueBudget(taskId, addCredits) {
      return ok(() => window.aria.continueBudget({ taskId, addCredits }));
    },
    async setTaskModel(taskId, model, reasoningEffort) {
      return ok(() => window.aria.setTaskModel({ taskId, model, ...(reasoningEffort ? { reasoningEffort } : {}) }));
    },
    async setTaskAgent(taskId, agent) {
      return ok(() => window.aria.setTaskAgent({ taskId, agent: agent?.trim() ? agent.trim() : null }));
    },
    async openInEditor(taskId) {
      return ok(() => window.aria.openInEditor(taskId));
    },

    async saveProfile(input) {
      return attempt(() => window.aria.saveProfile(input), null);
    },
    async deleteProfile(profileId) {
      return ok(() => window.aria.deleteProfile(profileId));
    },
    async setDefaultProfile(profileId) {
      return ok(() => window.aria.setDefaultProfile(profileId));
    },
    async setProfilePolicy(policy) {
      return ok(() => window.aria.setProfilePolicy(policy));
    },

    setReplyTo(target) {
      set({ replyTo: target, composerFocus: get().composerFocus + 1, ...(target ? { ui: { ...get().ui, view: "chat" as const } } : {}) });
    },
    async sendReply(text) {
      const target = get().replyTo;
      if (!target) return false;
      const sent = await ok(() => window.aria.reply({ taskId: target.taskId, ...(target.question ? { item: { kind: "question" as const, id: target.question.id } } : {}), text }));
      // Only once it went: a failed reply keeps its target, so it can't end up with ARIA by accident.
      if (sent && get().replyTo === target) set({ replyTo: null });
      if (sent && get().yours[target.taskId]) void get().loadYourWords(target.taskId);
      return sent;
    },
    async decidePermission(taskId, permissionId, decision, note) {
      return ok(() => window.aria.decidePermission({ taskId, permissionId, decision, ...(note?.trim() ? { note: note.trim() } : {}) }));
    },
    async reviewPlan(taskId, planId, decision, feedback) {
      return ok(() => window.aria.reviewPlan({ taskId, planId, decision, ...(feedback?.trim() ? { feedback: feedback.trim() } : {}) }));
    },
    async revokeGrant(taskId, grantId) {
      return ok(() => window.aria.revokeGrant({ taskId, grantId }));
    },
    async startProposal(cardId, profileId, agent) {
      return ok(() =>
        window.aria.startProposal({
          cardId,
          ...(profileId ? { profileId } : {}),
          ...(agent !== undefined ? { agent: agent?.trim() ? agent.trim() : null } : {}),
        }),
      );
    },
    async dismissProposal(cardId) {
      return ok(() => window.aria.dismissProposal({ cardId }));
    },
    async dismissCard(cardId) {
      return failure(() => window.aria.dismissCard({ cardId }));
    },
    async savePolicyRules(rules) {
      return ok(() => window.aria.savePolicyRules({ rules }));
    },
    async resetPolicyRules() {
      return ok(() => window.aria.resetPolicyRules());
    },
    async setAttention(patch) {
      return ok(() => window.aria.setAttention(patch));
    },
    async setVoiceCloudApiKey(apiKey) {
      return ok(() => window.aria.setVoiceCloudApiKey({ apiKey }));
    },
    async setPhonePushSecrets(input) {
      return ok(() => window.aria.setPhonePushSecrets(input));
    },
    async testPhonePush() {
      try {
        return await window.aria.testPhonePush();
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    },
    async setTelegramBotToken(botToken) {
      return ok(() => window.aria.setTelegramBotToken({ botToken }));
    },
    async testTelegramRelay() {
      try {
        return await window.aria.testTelegramRelay();
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    },
    async setSandbox(patch) {
      return ok(() => window.aria.setSandbox(patch));
    },

    async checkRule(input) {
      try {
        return await window.aria.checkRule(input);
      } catch {
        return null;
      }
    },
    async loadOffers(taskId) {
      try {
        const offers = await window.aria.ruleOffers(taskId);
        set({ offers: { ...get().offers, [taskId]: offers } });
      } catch {
        // The task is gone: nothing to offer.
      }
    },
    async acceptOffer(taskId, offerId, rules, confirmOverride) {
      try {
        await window.aria.acceptOffer({ taskId, offerId, rules, ...(confirmOverride ? { confirmOverride: true } : {}) });
        return null;
      } catch (error) {
        return errorText(error);
      }
    },
    async loadYourWords(taskId) {
      try {
        const words = await window.aria.yourWords(taskId);
        // Read for the session view: closed meanwhile, they're let go (P4), and so is this.
        if (get().openTaskId !== taskId) return;
        set({ yours: { ...get().yours, [taskId]: words } });
      } catch {
        // The task is gone.
      }
    },
    async saveMemory(input) {
      try {
        return { memory: await window.aria.saveMemory(input) };
      } catch (error) {
        return { error: errorText(error) };
      }
    },
    async deleteMemory(id) {
      try {
        await window.aria.deleteMemory({ id });
        return null;
      } catch (error) {
        return errorText(error);
      }
    },

    async refreshIntegrations() {
      return failure(() => window.aria.refreshIntegrations());
    },
    async setIntegrationRule(server, wireName, scope, effect) {
      return failure(() => window.aria.setIntegrationRule({ server, wireName, scope, effect }));
    },
    async signIn(server) {
      return failure(() => window.aria.signIn({ server }));
    },
    async cancelSignIn() {
      return failure(() => window.aria.cancelSignIn());
    },
    async moveIntegrationRules(from, to) {
      return failure(() => window.aria.moveIntegrationRules({ from, to }));
    },
    async forgetIntegrationServer(server) {
      return failure(() => window.aria.forgetIntegrationServer({ server }));
    },
    async importCliMcp(overwriteAriaEdits) {
      try {
        const res = await window.aria.importCliMcp(
          overwriteAriaEdits !== undefined ? { overwriteAriaEdits } : {},
        );
        return { imported: res.imported, updated: res.updated, skipped: res.skipped };
      } catch (error) {
        return { error: errorText(error) };
      }
    },
    async setMcpKeepInSync(keepInSync) {
      return failure(() => window.aria.setMcpKeepInSync({ keepInSync }));
    },
    async testMcpServer(server) {
      try {
        const result = await window.aria.testMcpServer({ server });
        return { result };
      } catch (error) {
        return { error: errorText(error) };
      }
    },
    async saveMcpServer(input) {
      return failure(() => window.aria.saveMcpServer(input));
    },
    async removeMcpServer(server) {
      return failure(() => window.aria.removeMcpServer({ server }));
    },
    async setMcpServerToken(server, bearerToken) {
      return failure(() => window.aria.setMcpServerToken({ server, bearerToken }));
    },
    async setActiveTracker(input) {
      try {
        return await window.aria.setActiveTracker(input);
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    },
    async previewTrackerChange(input) {
      try {
        return await window.aria.previewTrackerChange(input);
      } catch (error) {
        return { error: errorText(error) };
      }
    },
    async importTrackerConfig() {
      try {
        return await window.aria.importTrackerConfig();
      } catch (error) {
        return { status: "failed", error: errorText(error) };
      }
    },
    async openTrackerFolder() {
      await window.aria.openTrackerFolder().catch(() => {
        // Best-effort shell open.
      });
    },
    async addMarketplace(source) {
      try {
        const res = await window.aria.addMarketplace({ source });
        return { name: res.name };
      } catch (error) {
        return { error: errorText(error) };
      }
    },
    async removeMarketplace(name, force) {
      try {
        const res = await window.aria.removeMarketplace({ name, ...(force !== undefined ? { force } : {}) });
        return { removed: res.removed, ...(res.dependentPlugins ? { dependentPlugins: res.dependentPlugins } : {}) };
      } catch (error) {
        return { error: errorText(error) };
      }
    },
    async browseMarketplace(name) {
      try {
        const res = await window.aria.browseMarketplace({ name });
        return { plugins: res.plugins };
      } catch (error) {
        return { error: errorText(error) };
      }
    },
    async refreshMarketplaces(name) {
      return failure(() => window.aria.refreshMarketplaces(name ? { name } : {}));
    },
    async installPlugin(source) {
      try {
        const res = await window.aria.installPlugin({ source });
        return {
          plugin: res.plugin,
          skillsInstalled: res.skillsInstalled,
          ...(res.postInstallMessage ? { postInstallMessage: res.postInstallMessage } : {}),
          ...(res.deprecationWarning ? { deprecationWarning: res.deprecationWarning } : {}),
        };
      } catch (error) {
        return { error: errorText(error) };
      }
    },
    async uninstallPlugin(name, directSourceId) {
      return failure(() => window.aria.uninstallPlugin({ name, ...(directSourceId ? { directSourceId } : {}) }));
    },
    async updatePlugin(name) {
      try {
        const res = await window.aria.updatePlugin(name ? { name } : {});
        return { updatedCount: res.updatedCount, ...(res.message ? { message: res.message } : {}) };
      } catch (error) {
        return { error: errorText(error) };
      }
    },
    async setPluginEnabled(name, enabled) {
      return failure(() => window.aria.setPluginEnabled({ name, enabled }));
    },
    async setSkillEnabled(name, enabled) {
      return failure(() => window.aria.setSkillEnabled({ name, enabled }));
    },
    async addPluginDirectory(path) {
      return failure(() => window.aria.addPluginDirectory({ path }));
    },
    async removePluginDirectory(path) {
      return failure(() => window.aria.removePluginDirectory({ path }));
    },
    async addSkillDirectory(path) {
      return failure(() => window.aria.addSkillDirectory({ path }));
    },
    async removeSkillDirectory(path) {
      return failure(() => window.aria.removeSkillDirectory({ path }));
    },
    async addAgentDirectory(path) {
      return failure(() => window.aria.addAgentDirectory({ path }));
    },
    async removeAgentDirectory(path) {
      return failure(() => window.aria.removeAgentDirectory({ path }));
    },

    async unwatch(watchId) {
      return failure(() => window.aria.unwatch(watchId));
    },
    async retryGitHub() {
      return failure(() => window.aria.retryGitHub());
    },
    async retryInbox() {
      return failure(() => window.aria.retryInbox());
    },
    async setInboxWatch(on) {
      return failure(() => window.aria.setInboxWatch(on));
    },
    async useGitHubAccount(cardId) {
      return failure(() => window.aria.useGitHubAccount(cardId));
    },
    async switchGitHubAccount(cardId) {
      return failure(() => window.aria.switchGitHubAccount(cardId));
    },
    async watchPullRequest(key) {
      return failure(() => window.aria.watchPullRequest({ key }));
    },
    async watchDefaultBranch(repoId) {
      return failure(() => window.aria.watchDefaultBranch({ repoId }));
    },

    async proposePr(taskId) {
      return failure(() => window.aria.proposePr({ taskId }));
    },
    async confirmPr(input) {
      return failure(() => window.aria.confirmPr(input));
    },
    async dismissPr(cardId) {
      return failure(() => window.aria.dismissPr({ cardId }));
    },

    async fixCi(cardId) {
      return failure(() => window.aria.fixCi({ cardId }));
    },
    async addressReview(cardId, ticked) {
      return failure(() => window.aria.addressReview({ cardId, ticked }));
    },
    async startFixProposal(cardId, revision, ticked) {
      return failure(() => window.aria.startFixProposal({ cardId, revision, ticked }));
    },
    async dismissFixProposal(cardId) {
      return failure(() => window.aria.dismissFixProposal({ cardId }));
    },
    async setCiFixProfile(profileId) {
      return failure(() => window.aria.setCiFixProfile({ profileId }));
    },

    async confirmAction(input) {
      return failure(() => window.aria.confirmAction(input));
    },
    async cancelAction(cardId) {
      return failure(() => window.aria.cancelAction({ cardId }));
    },

    async confirmWorkflowDispatch(input) {
      return failure(() => window.aria.confirmWorkflowDispatch(input));
    },
    async dismissWorkflowDispatch(cardId) {
      return failure(() => window.aria.dismissWorkflowDispatch({ cardId }));
    },

    async setTaskTracker(taskId, trackerTaskId) {
      return failure(() => window.aria.setTaskTracker({ taskId, trackerTaskId }));
    },
    async listActivities(input = {}) {
      try {
        return await window.aria.listActivities(input);
      } catch {
        return [];
      }
    },
    async saveTimeRule(input) {
      try {
        return { rule: await window.aria.saveTimeRule(input) };
      } catch (error) {
        return { error: errorText(error) };
      }
    },
    async deleteTimeRule(id) {
      return failure(() => window.aria.deleteTimeRule({ id }));
    },

    async saveTimekeeperSettings(input) {
      return ok(() => window.aria.setTimekeeperSettings(input));
    },
    async prepareTimesheet(date) {
      const err = await failure(() => window.aria.prepareTimesheet(date ? { date } : {}));
      if (!err && get().ui.view === "time") void get().loadTimeView(date ?? get().timeView?.selectedDate);
      return err;
    },
    async updateTimesheetEntry(input) {
      const err = await failure(() => window.aria.updateTimesheetEntry(input));
      if (!err && get().ui.view === "time") void get().loadTimeView(get().timeView?.selectedDate ?? input.date);
      return err;
    },
    async confirmTimesheetEntry(date, entryId) {
      const err = await failure(() => window.aria.confirmTimesheetEntry({ date, entryId }));
      if (!err && get().ui.view === "time") void get().loadTimeView(get().timeView?.selectedDate ?? date);
      return err;
    },
    async deleteTimesheetEntry(date, entryId) {
      const err = await failure(() => window.aria.deleteTimesheetEntry({ date, entryId }));
      if (!err && get().ui.view === "time") void get().loadTimeView(get().timeView?.selectedDate ?? date);
      return err;
    },
    async acceptTimesheetRuleOffer(date, offerId) {
      const err = await failure(() => window.aria.acceptTimesheetRuleOffer({ date, offerId }));
      if (!err && get().ui.view === "time") void get().loadTimeView(get().timeView?.selectedDate ?? date);
      return err;
    },
    async dismissTimesheetRuleOffer(date, offerId) {
      const err = await failure(() => window.aria.dismissTimesheetRuleOffer({ date, offerId }));
      if (!err && get().ui.view === "time") void get().loadTimeView(get().timeView?.selectedDate ?? date);
      return err;
    },

    openTimeView(date) {
      const nextDate = date ?? get().ui.selectedTimeDate ?? get().todayTime?.date;
      set({
        ui: {
          ...get().ui,
          view: "time",
          ...(nextDate ? { selectedTimeDate: nextDate } : {}),
        },
        sessionFull: false,
      });
      void window.aria.setUiState({
        view: "time",
        ...(nextDate ? { selectedTimeDate: nextDate } : {}),
      });
      void get().loadTimeView(nextDate);
    },

    async loadTimeView(date) {
      const seq = ++timeViewSeq;
      try {
        const timeView = await window.aria.getTimeView(date ? { date } : {});
        if (seq !== timeViewSeq) return null;
        set({
          timeView,
          ui: { ...get().ui, selectedTimeDate: timeView.selectedDate },
        });
        return null;
      } catch (error) {
        return errorText(error);
      }
    },

    async submitTimesheet(date, entryIds) {
      const err = await failure(() => window.aria.submitTimesheet({ date, ...(entryIds ? { entryIds } : {}) }));
      if (!err && get().ui.view === "time") void get().loadTimeView(get().timeView?.selectedDate ?? date);
      return err;
    },

    async updateRegisteredEntry(input) {
      const err = await failure(() => window.aria.updateRegisteredEntry(input));
      if (!err && get().ui.view === "time") void get().loadTimeView(get().timeView?.selectedDate ?? input.date);
      return err;
    },

    async deleteRegisteredEntries(input) {
      const err = await failure(() => window.aria.deleteRegisteredEntries(input));
      if (!err && get().ui.view === "time") void get().loadTimeView(get().timeView?.selectedDate ?? input.date);
      return err;
    },

    openAutomations() {
      set({
        ui: { ...get().ui, view: "automations" },
        sessionFull: false,
      });
      void window.aria.setUiState({ view: "automations" });
    },

    async saveUtilitySettings(input) {
      return ok(() => window.aria.setUtilitySettings(input));
    },

    async saveBudgetSettings(input) {
      return ok(() => window.aria.setBudgetSettings(input));
    },

    loadDataState() {
      return attempt<DataState | null>(() => window.aria.getDataState(), null);
    },

    setTranscriptRetention(input) {
      return attempt<DataState | null>(() => window.aria.setTranscriptRetention(input), null);
    },

    cleanUpTranscripts() {
      return attempt<DataState | null>(() => window.aria.cleanUpTranscripts(), null);
    },

    async saveRoutine(input) {
      try {
        return { routine: await window.aria.saveRoutine(input) };
      } catch (error) {
        return { error: errorText(error) };
      }
    },

    async toggleRoutine(input) {
      return failure(() => window.aria.toggleRoutine(input));
    },

    async runRoutine(id) {
      return failure(() => window.aria.runRoutine({ id }));
    },

    async deleteRoutine(id) {
      return failure(() => window.aria.deleteRoutine({ id }));
    },

    async createReminder(input) {
      try {
        return { reminder: await window.aria.createReminder(input) };
      } catch (error) {
        return { error: errorText(error) };
      }
    },

    async snoozeReminder(reminderId, minutes) {
      return failure(() => window.aria.snoozeReminder({ reminderId, minutes }));
    },

    async dismissReminder(reminderId) {
      return failure(() => window.aria.dismissReminder({ reminderId }));
    },

    async deleteReminder(reminderId) {
      return failure(() => window.aria.deleteReminder({ reminderId }));
    },

    openMyWork(focus) {
      closeInspector();
      set({ ...forget(get(), get().openTaskId), openTaskId: null, composeFor: null, myWorkOpen: true, ...(focus ? { myWorkFocus: { watchId: focus.watchId, at: Date.now() } } : {}) });
    },

    async loadMyWork(refresh) {
      try {
        const myWork = await window.aria.myWork({ refresh });
        set({ myWork });
      } catch (error) {
        set({ myWork: { ...get().myWork, status: "error", message: errorText(error) } });
      }
    },

    focusWatch(watchId) {
      const target = watchTarget(get().timeline, watchId);
      if ("cardId" in target) {
        set({ seenWatchCards: [...get().seenWatchCards.filter((c) => c !== target.cardId), target.cardId].slice(-200) });
        get().focusCard(target.cardId);
      } else get().openMyWork({ watchId: target.myWork });
    },

    async runDoctor() {
      set({ doctorLoading: true });
      try {
        const report = await window.aria.runDoctor();
        set({ doctor: report, doctorLoading: false });
        return report;
      } catch (error) {
        set({ doctorLoading: false, actionError: errorText(error) });
        return null;
      }
    },

    async setOnboardingState(patch) {
      if (!("setOnboardingState" in window.aria)) return false;
      const next = await attempt(() => window.aria.setOnboardingState(patch), null);
      if (next) {
        set({ onboarding: next });
        return true;
      }
      return false;
    },

    async openCliTerminal(target) {
      try {
        const res = await window.aria.openCliTerminal({ target });
        return res.launched ? null : (res.error ?? "Couldn't open terminal.");
      } catch (error) {
        return errorText(error);
      }
    },

    async openLogsFolder() {
      await window.aria.openLogsFolder().catch(() => {
        // Best-effort shell open.
      });
    },

    openOnboardingModal() {
      set({ onboardingModalOpen: true, whatsNewModalOpen: false, tourActive: false });
      void get().runDoctor();
    },

    closeOnboardingModal() {
      set({ onboardingModalOpen: false });
    },

    openWhatsNewModal() {
      set({ whatsNewModalOpen: true, onboardingModalOpen: false, tourActive: false });
    },

    closeWhatsNewModal() {
      const currentVersion = get().appVersion;
      set({ whatsNewModalOpen: false });
      // This version's notes are seen. An available update isn't put off by this: Later on the bar does that.
      if (get().onboarding.dismissedWhatsNewVersion !== currentVersion) {
        void get().setOnboardingState({ dismissedWhatsNewVersion: currentVersion });
      }
    },

    requestUpdate() {
      set({ whatsNewModalOpen: false });
      if (tasksStoppedByRestart(get().tasks) > 0) set({ updateConfirming: true });
      else void get().confirmUpdate();
    },

    promptUpdate() {
      set({ whatsNewModalOpen: false, updateConfirming: true });
    },

    async confirmUpdate(options) {
      set({ updateConfirming: false });
      await ok(() => window.aria.installUpdate(options?.whenIdle ? { whenIdle: true } : {}));
    },

    cancelUpdateConfirm() {
      set({ updateConfirming: false });
    },

    async cancelUpdate() {
      await ok(() => window.aria.cancelUpdate());
    },

    async checkForUpdates() {
      return attempt(() => window.aria.checkForUpdates(), null);
    },

    async snoozeUpdate() {
      set({ updateConfirming: false, whatsNewModalOpen: false });
      const next = await attempt(() => window.aria.snoozeUpdate(), null);
      if (next) set({ onboarding: next });
    },

    startTour(step = 0) {
      set({
        tourActive: true,
        tourStep: step,
        onboardingModalOpen: false,
        whatsNewModalOpen: false,
        ui: { ...get().ui, view: "chat", sidebarCollapsed: false },
        sessionFull: false,
      });
      void window.aria.setUiState?.({ view: "chat", sidebarCollapsed: false });
    },

    nextTourStep(totalSteps = 6) {
      const next = get().tourStep + 1;
      if (next >= totalSteps) {
        get().stopTour(true);
      } else {
        set({ tourStep: next });
      }
    },

    prevTourStep() {
      set({ tourStep: Math.max(0, get().tourStep - 1) });
    },

    stopTour(completed = false) {
      set({ tourActive: false });
      if (completed) {
        void get().setOnboardingState({ tourCompleted: true });
      }
    },
  };
});
