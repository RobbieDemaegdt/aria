/**
 * The contract between the ARIA UI and the core engine (PLAN.md §4.1: the window is only a view onto the engine,
 * connected over typed IPC). Inputs that cross the boundary are validated with these zod schemas in the main process.
 */
import { z } from "zod";
import type { EncodingDamage } from "./encoding.ts";
import { CONDUCTOR_TRANSCRIPT_MAX_TURNS } from "./transcript.ts";

// ── Timeline ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A chat message from you or ARIA. Only final assistant text is stored; streaming deltas are transient. */
export interface ChatItem {
  kind: "chat";
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  /** Model that produced an assistant message, when known. */
  model?: string;
  /** Your message went straight to a task (reply-to or @mention), not to ARIA (PLAN.md §4.5). `choice`: it answered by picking one of the choices. */
  routedTo?: { taskId: string; title: string; shortId?: string; action: RouteAction; note?: string; noteTone?: "warning"; choice?: boolean };
  /** The `<updates>`/`<pending>` block ARIA got with this message (shown in the inspector, not in the chat). */
  digest?: string;
  /** Set when a user message arrived through the two-way Telegram relay (Phase 8B). */
  via?: "telegram";
  /** Routine ID when this message was triggered by a scheduled or manual prompt routine. */
  routineId?: string;
}

/** What a message sent straight to a task did. */
export type RouteAction = "answer" | "reject" | "revise" | "message";

/** A small system line in the timeline (model switched by the runtime, resumed after a crash, …). */
export interface NoticeItem {
  kind: "notice";
  id: string;
  level: "info" | "warning" | "error";
  message: string;
  /** Machine-readable reason, e.g. "refusal_fallback" or "interrupted_tools". */
  cause?: string;
  /** Task ID when this notice is about a specific worker task session. */
  taskId?: string;
  /** Number of times this notice was repeated and coalesced in place. */
  count?: number;
  createdAt: number;
  updatedAt?: number;
}

/** Cards: rich timeline items. The task card only points at its task and is drawn from the live task state, so it
 * updates in place without rewriting its row; the others keep a snapshot of what happened. */
interface CardBase {
  kind: "card";
  id: string;
  createdAt: number;
  updatedAt?: number;
}

export interface TaskDoneSnapshot {
  taskId: string;
  summary?: string;
  commits: number;
  filesChanged: number;
  additions: number;
  deletions: number;
  /** Changed paths that weren't committed. */
  uncommitted: number;
  /** An autopilot task that went quiet without saying it had finished. */
  incomplete?: boolean;
  /** R1: lines it added that look like damaged text. */
  encodingDamage?: EncodingDamage;
}

export type CardItem =
  | (CardBase & { cardType: "task"; payload: { taskId: string } })
  /** A worker asked something (D17); answered on the card or through ARIA. */
  | (CardBase & { cardType: "task_question"; payload: QuestionCardPayload })
  /** A worker wants to do something the policy doesn't allow on its own (PLAN.md §4.8). */
  | (CardBase & { cardType: "task_permission"; payload: PermissionCardPayload })
  /** A worker in plan mode finished its plan and waits for approval. */
  | (CardBase & { cardType: "task_plan"; payload: PlanCardPayload })
  /** A task paused at its budget. */
  | (CardBase & { cardType: "task_budget"; payload: { taskId: string; shortId?: string; usedCredits: number; budgetCredits: number } })
  | (CardBase & { cardType: "task_done"; payload: TaskDoneSnapshot })
  | (CardBase & { cardType: "task_failed"; payload: { taskId: string; error: string } })
  /** Tasks that were running when ARIA closed or the Copilot runtime stopped. */
  | (CardBase & { cardType: "tasks_interrupted"; payload: { taskIds: string[]; /** The Copilot runtime stopped; without it, ARIA closed. */ cause?: "runtime" } })
  /** Profile policy "ask me" (§4.12): ARIA proposes a task and its profile; nothing runs until you press Start. */
  | (CardBase & { cardType: "profile_proposal"; payload: ProposalCardPayload })
  /** "While you were away" (PLAN.md §5.5): what finished, failed and needs you, on your return. */
  | (CardBase & { cardType: "away_digest"; payload: AwayDigestPayload })
  /** A watched run, a PR's checks or a branch's CI finished (PLAN.md §4.6, §5.4): a snapshot. */
  | (CardBase & { cardType: "ci"; payload: CiCardPayload })
  /** A review on a watched PR, a review request from your inbox, or a watched PR merged or closed. */
  | (CardBase & { cardType: "pr"; payload: PrCardPayload })
  /** GitHub CLI now uses another account: the watches started as the old one are paused. */
  | (CardBase & { cardType: "github_account"; payload: GitHubAccountCardPayload })
  /** A watch stopped before its end condition (timed out, gone, no access). */
  | (CardBase & { cardType: "watch_ended"; payload: WatchEndedCardPayload })
  /** A pull request to open (PLAN.md §4.3, §4.4, D41–D44): exactly what's pushed and sent; only your click does it. */
  | (CardBase & { cardType: "pr_confirm"; payload: PrConfirmPayload })
  /** ARIA proposes Fix it or Address comments (item 4, D48): nothing starts until you press Start. */
  | (CardBase & { cardType: "fix_proposal"; payload: FixProposalPayload })
  /** An MCP action ARIA proposes (Phase 5A, PLAN.md §4.3, §4.13, §5.4, D19, D22): nothing runs until your click. */
  | (CardBase & { cardType: "action_request"; payload: ActionRequestPayload })
  /** A GitHub Actions workflow dispatch ARIA proposes: nothing runs until you click Run workflow, which also watches the run. */
  | (CardBase & { cardType: "workflow_dispatch"; payload: WorkflowDispatchPayload })
  /** Daily timesheet draft (Phase 5C, PLAN.md §4.14, §5.4): plain-code checked rows, inline editing, and rule offers. */
  | (CardBase & { cardType: "timesheet_draft"; payload: TimesheetCardPayload })
  /** Result of submitting timesheet entries to the task tracker (Phase 5D, PLAN.md §4.14, §5.4, D16). */
  | (CardBase & { cardType: "time_registered"; payload: TimeRegisteredCardPayload })
  /** Timed reminder (Phase 6B, PLAN.md §5.4, §10 Phase 6B): Snooze and Done. */
  | (CardBase & { cardType: "reminder"; payload: ReminderCardPayload })
  /** Morning brief or Friday week time overview (Phase 6B, PLAN.md §4.14, §5.4, §5.5, §10 Phase 6B). */
  | (CardBase & { cardType: "morning_brief"; payload: MorningBriefCardPayload })
  /** A change on one of your task tracker's tasks (Phase 7B, PLAN.md §4.6, §5.4, §10 Phase 7B). */
  | (CardBase & { cardType: "tracker_update"; payload: TrackerUpdateCardPayload })
  /** An unread Outlook email that requires your attention or reply. */
  | (CardBase & { cardType: "outlook_mail"; payload: OutlookMailCardPayload })
  /** Release notes shown when an update is installed. */
  | (CardBase & { cardType: "whats_new"; payload: WhatsNewCardPayload });

export type DoctorCheckStatus = "ok" | "warning" | "error" | "info";

export type DoctorCheckId =
  | "copilot_cli"
  | "copilot_runtime"
  | "environment"
  | "git_worktree"
  | "sandbox"
  | "github_cli"
  | "mcp_integrations"
  /** Only with no task tracker: an `info` line saying it is optional. */
  | "task_tracker";

export interface DoctorCheck {
  id: DoctorCheckId;
  title: string;
  category: "required" | "recommended" | "optional";
  status: DoctorCheckStatus;
  summary: string;
  detail?: string;
  /** Optional remediation hint or command (e.g. "copilot" or "gh auth login"). */
  remediation?: string;
  /** Optional action key the UI can offer as a 1-click button. */
  action?:
    | "open_copilot_login"
    | "open_gh_login"
    | "reconnect"
    | "open_models"
    | "open_integrations"
    | "open_permissions"
    | "open_logs";
}

export interface DoctorReport {
  checkedAt: number;
  overallStatus: "ok" | "warning" | "error";
  cliPath?: string;
  cliSource?: "env" | "path" | "bundled" | "missing";
  worktreeRoot?: string;
  logDir?: string;
  checks: DoctorCheck[];
}

export interface OnboardingState {
  /** Highest app version the user has opened (e.g. "0.1.0"). */
  lastSeenVersion?: string;
  /** True once the user finishes or dismisses the first-run setup checklist. */
  setupCompleted?: boolean;
  /** True once the user finishes or skips the interactive GUI tour. */
  tourCompleted?: boolean;
  /** Version string of the latest "What's new" release notes the user dismissed, if any. */
  dismissedWhatsNewVersion?: string;
  /** Version string of the latest available update popup the user dismissed, if any. No longer written (D80). */
  dismissedAvailableUpdateVersion?: string;
  /** Later on the update bar (D80): the bar stays hidden for this version until `until` (ms since the epoch). */
  updateSnooze?: { version: string; until: number };
  updatedAt: number;
}

export interface AvailableUpdateInfo {
  version: string;
  tagName: string;
  headline?: string;
  notes?: string;
  releaseUrl: string;
  installerUrl?: string;
  installerName?: string;
  /** The installer's size in bytes, as GitHub's API states it for the asset. */
  installerSize?: number;
  /** The installer's SHA-256 (lowercase hex), from the asset's `digest`. Update now needs it (D80). */
  installerSha256?: string;
  publishedAt?: string;
}

/**
 * Update now (D80): where the download and the install of an available update stand. `idle` until you start one;
 * `failed` says why, and Update now can be tried again.
 */
export type UpdateStatus =
  | { phase: "idle" }
  | { phase: "downloading"; version: string; received: number; total: number }
  | { phase: "installing"; version: string }
  | { phase: "failed"; version: string; reason: string };

export interface ReleaseFeatureItem {
  title: string;
  description: string;
  action?:
    | { kind: "view"; view: UiState["view"]; customizePage?: CustomizePage; label: string }
    | { kind: "prefill"; text: string; label: string }
    | { kind: "tour"; label: string };
}

export interface ReleaseSettingHighlight {
  title: string;
  description: string;
  customizePage: CustomizePage;
}

export interface ReleaseNoteEntry {
  version: string;
  date: string;
  headline: string;
  features: ReleaseFeatureItem[];
  fixes: string[];
  newSettings?: ReleaseSettingHighlight[];
}

export interface WhatsNewCardPayload {
  fromVersion?: string;
  toVersion: string;
  releases: ReleaseNoteEntry[];
}

export type TrackerUpdateEvent = "assigned" | "status_changed" | "priority_changed" | "comment_added";
export type OutlookMailUrgency = "urgent" | "action_needed";
export type OutlookMailTriageMode = "rules_and_utility" | "rules_only";

/**
 * An important unread Outlook email that requires your attention or reply.
 * All strings are sanitized plain text (`cleanUntrustedText`); `webLink` is validated (`https://outlook.office*.com/...` or `https://outlook.live.com/...`).
 */
export interface OutlookMailCardPayload {
  messageId: string;
  conversationId?: string;
  subject: string;
  fromName: string;
  fromAddress?: string;
  receivedAt: number;
  recipientRole?: "to" | "cc";
  importance?: "high" | "normal" | "low";
  flagged?: boolean;
  urgency: OutlookMailUrgency;
  /** 1-line summary of why this email needs your attention (from plain-code signals or Utility model triage). */
  reason: string;
  /** Sanitized plain-text preview (max 600 chars). */
  preview?: string;
  /** Linked tracker task ID if referenced in the subject or preview. */
  trackerTaskId?: string;
  /** Validated Outlook web link when provided by Graph. */
  webLink?: string;
}

/**
 * A change detected on one of your task tracker's tasks (Phase 7B, PLAN.md §4.6, §5.4, §10 Phase 7B).
 * All strings are sanitized plain text (`cleanUntrustedText`); `url` is always built by ARIA (`tracker.taskUrl(taskId)`).
 */
export interface TrackerUpdateCardPayload {
  /** The tracker's task ID (e.g. "ACME-123"). */
  taskId: string;
  /** Sanitized task title (plain text, max 200 chars). */
  title: string;
  /** Which change triggered this card. */
  event: TrackerUpdateEvent;
  /** Current task status (e.g. "In Progress", "To Be Scheduled"). */
  status?: string;
  /** Previous status when `event === "status_changed"`. */
  previousStatus?: string;
  /** Current task priority (e.g. "High", "Normal"). */
  priority?: string;
  /** Previous priority when `event === "priority_changed"`. */
  previousPriority?: string;
  /** Sanitized latest comment excerpt when `event === "comment_added"` (plain text, max 600 chars). */
  comment?: string;
  /** Comment author when the tracker reports one. */
  commentBy?: string;
  /** Tracker project ID (e.g. "28939"). */
  projectId?: string;
  /** Tracker project name/title (e.g. "Northwind Connector"). */
  projectName?: string;
  /** Tracker customer ID (e.g. "708"). */
  customerId?: string;
  /** Tracker customer name (e.g. "Acme Corp"). */
  customerName?: string;
  /** Tracker task type (e.g. "New Feature", "Software Issue"). */
  taskType?: string;
  /** The task's page on the tracker, built by ARIA. */
  url: string;
}

export interface ActionRequestPayload {
  /** A-1, A-2… */
  shortId: string;
  server: string;
  tool: string;
  wireName: string;
  cls: ToolClass;
  title: string;
  note?: string;
  /** Pretty-printed JSON object of the arguments to send. */
  argsJson: string;
  /** True when you edited the arguments on the card before sending. */
  edited?: boolean;
  /** True when the tool is destructive (or takes a confirm flag) and requires the confirmation checkbox on the card. */
  requiresConfirmTick?: boolean;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  revision: number;
  /** Server's response once done (cleaned text/JSON, up to 20,000 chars). */
  result?: string;
  /** Error or full server response on failure (D16). */
  error?: string;
  completedAt?: number;
}

export interface WorkflowDispatchPayload {
  /** WD-1, WD-2… */
  shortId: string;
  repoId?: number;
  repoName: string;
  owner: string;
  repo: string;
  workflowId: number;
  workflowName: string;
  /** e.g. ".github/workflows/issue-plans.yml" */
  workflowPath: string;
  /** Target branch or tag (defaults to the repo's default branch, e.g. "1.0.0" or "main"). */
  ref: string;
  /** String key-value inputs (GitHub accepts up to 10 string inputs). */
  inputs: Record<string, string>;
  /** True when you edited the branch or inputs on the card before running. */
  edited?: boolean;
  /** GitHub CLI's login that will trigger the run. */
  login: string;
  note?: string;
  status: "pending" | "dispatching" | "done" | "failed" | "cancelled";
  revision: number;
  /** Auto-created watch ID (e.g. W-8 exists as watchId: 8) once dispatched. */
  watchId?: number;
  /** Note if the auto-watch couldn't be started after dispatch. */
  watchNote?: string;
  /** Canonical github.com workflow page built by ARIA. */
  url: string;
  error?: string;
  dispatchedAt?: number;
}

/** Where a fix goes (item 4, D45, D46): the owning task continues, a new task adopts its branch, or a new task starts. */
export type FixHow = "continue" | "adopt" | "start";

/** What Fix it or Address comments did, on its card (and what a proposal would do). */
export interface FixRecord {
  taskId: string;
  taskTitle: string;
  how: FixHow;
  at: number;
  /** The logs that went in: all, some, none (D49: "no log" is said loudly). */
  logs?: "ok" | "partial" | "none";
  /** What the card says beside it: logs gone, a branch that moved on, local commits not on GitHub. */
  notes?: string[];
}

/** Fix it or Address comments, before it's done: where it would go, with what (counts only; never the text). */
export interface FixPlan {
  how: FixHow;
  /** The task that continues (or is adopted from). */
  taskId?: string;
  taskTitle?: string;
  /** The profile, model, effort and budget the work runs with (D46). */
  profile: string;
  model: string;
  reasoningEffort?: string;
  budgetCredits?: number;
  /** The commit it's for (the card's head). */
  sha: string;
  branch: string;
  /** ARIA's notes (logs, a moved branch, local commits ahead, the review's author). */
  notes: string[];
  /** D51: the review's author isn't an owner, member or collaborator, or is a bot: an extra tick. */
  needsTick?: string;
}

export interface FixProposalPayload {
  kind: "ci" | "review";
  /** The CI or PR card it's for. */
  cardId: string;
  watchId: number;
  repoName: string;
  /** "Checks on PR #3", "deploy.yml #482 on main", "@bob's review of PR #3" (cleaned). */
  target: string;
  plan: FixPlan;
  status: "pending" | "started" | "dismissed" | "failed";
  revision: number;
  result?: FixRecord;
  error?: string;
}

/** A repository on github.com. */
export interface GitHubRepo {
  owner: string;
  repo: string;
}

/** A task's pull request, once it's open (no state of its own: its watch tells how it goes). */
export interface TaskPr {
  owner: string;
  repo: string;
  number: number;
  url: string;
  /** `aria/<slug>`, or `<owner>:aria/<slug>` from a fork. */
  head: string;
  base: string;
  draft: boolean;
  openedAt: number;
  watchId?: number;
}

/**
 * What the PR card shows and the click sends, worked out by ARIA from the task and the project (never from the
 * window or the model, but for the title, the body, the draft switch and which of `choices` it opens on). The worker's
 * words (its report, the commit subjects) are cleaned and shown as plain text.
 */
export interface PrConfirmPayload {
  taskId: string;
  taskTitle: string;
  repoName: string;
  proposedBy: "you" | "aria";
  /** pending → pushing → opening → done; failed or dismissed. */
  status: "pending" | "pushing" | "opening" | "done" | "failed" | "dismissed";
  /** Bumped by every change; a click on an older one is refused. */
  revision: number;
  /** Where the commits go (the project's origin). */
  pushTo: GitHubRepo;
  /** The repositories the PR can open on: the origin, and a fork's upstream. */
  choices: GitHubRepo[];
  openOn: GitHubRepo;
  /** The branch on GitHub: `aria/<slug>`, or `aria/<slug>-<7 of the sha>` when that's taken. */
  remoteBranch: string;
  /** The commit pushed (the task's branch when the card was made). */
  tip: string;
  base: string;
  draft: boolean;
  title: string;
  body: string;
  /** GitHub CLI's login: the push and the PR are made as it. */
  login: string;
  commits: number;
  filesChanged: number;
  additions: number;
  deletions: number;
  /** Changes left uncommitted (D41: not pushed). */
  uncommitted: number;
  /** R1: lines the task added that look like damaged text, as counted when it finished. */
  encodingDamage?: EncodingDamage;
  /** Whether the task ran in the sandbox (D20). */
  sandboxed?: boolean;
  /** The commits' subjects (cleaned, at most 50) and the changed paths (at most 200). */
  subjects: string[];
  paths: string[];
  /** D43: workflow files the commits change (they need the tick), and other files that run code in builds or CI. */
  workflows: string[];
  flagged: string[];
  /** An open PR for the branch already: the push adds the commits, no new PR. */
  existing?: { number: number; url: string };
  /** ARIA's notes on the card (a merged PR before this one; the fork's base without the task's commit). */
  notes?: string[];
  /**
   * D52: the task was started from someone else's text (a CI log, a review): these files need the same tick as
   * workflows (anything under .github, manifests and lockfiles, build scripts, deleted or weakened tests).
   */
  extended?: { from: "ci_log" | "review"; paths: string[] };
  result?: { number: number; url: string; draft: boolean; watchId?: number; updated?: boolean };
  error?: string;
}

/**
 * A check that didn't pass, with the ids GitHub gave for it: a run's jobs have `jobId` (and `runId`); a PR's checks
 * come from the check-runs API and have `checkRunId` and the GitHub App that made them (`github-actions` for Actions).
 */
export interface CiFailedCheck {
  name: string;
  /** success, failure, cancelled, timed_out, … (GitHub's word). */
  conclusion: string;
  jobId?: number;
  runId?: number;
  checkRunId?: number;
  app?: string;
  /** A github.com page for it, when GitHub gave one. */
  url?: string;
}

/** Text from GitHub (names, titles) is cleaned and cut before it's stored; it's shown as plain text. */
export interface CiCardPayload {
  watchId: number;
  owner: string;
  repo: string;
  /** The project's name, else owner/repo. */
  repoName: string;
  source: "run" | "checks" | "branch";
  /** "deploy.yml #482", "Checks on PR #37", "main". */
  title: string;
  /** Green (every check passed or was skipped) or not. */
  outcome: "success" | "failure";
  /** GitHub's word for a run (success, failure, cancelled, timed_out, …), or "mixed" for several checks. */
  conclusion: string;
  /** "5 of 5 passed", "1 of 3 failed", "main is green again". */
  summary: string;
  branch?: string;
  headSha?: string;
  prNumber?: number;
  runId?: number;
  runNumber?: number;
  durationMs?: number;
  /** The first 10 that didn't pass. */
  failed?: CiFailedCheck[];
  url: string;
  /** Fix it, once clicked (item 4): where it went. */
  fix?: FixRecord;
}

export interface PrCardPayload {
  watchId: number;
  owner: string;
  repo: string;
  repoName: string;
  number: number;
  title: string;
  event: "approved" | "changes_requested" | "commented" | "review_requested" | "merged" | "closed";
  /** Who reviewed, merged or asked (a login). */
  by?: string;
  /** The review's text, cut (plain text, never Markdown). */
  body?: string;
  reviewId?: number;
  /** You merged or closed it yourself. */
  yours?: boolean;
  url: string;
  /** Address comments, once clicked (item 4): where it went. */
  fix?: FixRecord;
}

export interface GitHubAccountCardPayload {
  from?: string;
  to: string;
  /** The watches it paused. */
  watchIds: number[];
  /** You pressed "Use @to for them". */
  rebound?: boolean;
  /** True when ARIA proposed switching GitHub CLI to @to (`switch_github_account`). */
  requested?: boolean;
  /** Optional context note when ARIA proposed the switch. */
  note?: string;
  /** Status of a requested or triggered `gh auth switch` on this card. */
  status?: "pending" | "switching" | "done" | "failed" | "cancelled";
  /** Error message if `gh auth switch` failed. */
  error?: string;
}

export interface WatchEndedCardPayload {
  watchId: number;
  title: string;
  repoName?: string;
  reason: WatchEndReason;
  text: string;
  url?: string;
}

/** A line of the "while you were away" card, linking to its own card in the chat. */
export interface AwayLine {
  kind: "needs_you" | "failed" | "done" | "github" | "tracker" | "outlook";
  /** The task it's about (every kind but github, tracker, and outlook). */
  taskId?: string;
  /** The watch a github line is about. */
  watchId?: number;
  title: string;
  repoName: string;
  text: string;
  cardId: string;
  /** Q-n, P-n, L-n or B-n of what waits. */
  shortId?: string;
  /** What a "needs you" line waits for, and that item's own id: the card tells whether it still waits. */
  waits?: "question" | "permission" | "plan" | "budget" | "interrupted";
  itemId?: string;
  /** It came while you were away (the other "needs you" lines were waiting before). */
  isNew?: boolean;
}

export interface AwayDigestPayload {
  /** When you left (the first away stretch), and when you came back. */
  since: number;
  until: number;
  /** How long you were away in all (stretches add up: glancing back doesn't start over). */
  awayMs: number;
  /** At most 10 per kind; `more` counts the rest. */
  lines: AwayLine[];
  more?: Partial<Record<AwayLine["kind"], number>>;
}

export type SpokenAnnouncementsScope = "off" | "blocking" | "all";
export type TtsProvider = "system" | "cloud";
export type SttProvider = "whisper.cpp" | "cloud";
export type PhonePushProvider = "off" | "ntfy" | "pushover";
export type PhonePushScope = "blocking" | "all";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface BudgetSettings {
  /** Optional daily AI-credit cap across all tasks (null or undefined = no daily cap; PLAN.md §4.11). */
  dailyBudgetCredits?: number | null;
  /** Percentage of a task's or day's budget at which ARIA emits a warning notice (50–99, default 80). */
  budgetWarningPercent: number;
}

export interface DailyBudgetState {
  /** Local calendar date ("YYYY-MM-DD"). */
  date: string;
  /** AI credits spent today across all tasks. */
  usedCredits: number;
  /** Configured daily budget cap, if enabled. */
  dailyBudgetCredits?: number | null;
  /** Percentage threshold (50–99, default 80) for budget warning alerts. */
  budgetWarningPercent: number;
  /** True when today's spend has reached `budgetWarningPercent`% of `dailyBudgetCredits`. */
  warningReached: boolean;
  /** True when today's spend has reached 100% of `dailyBudgetCredits`. */
  limitReached: boolean;
}

/** Customize › Data (D1): how long a finished task keeps its whole transcript in the database. */
export interface TranscriptRetention {
  /** ARIA trims finished tasks' transcripts by itself, once a day. */
  enabled: boolean;
  /** Days after a task finished that its tool calls, permission lines and reasoning are kept (1–3650). */
  keepDays: number;
}

/** What a clean-up of transcripts did. */
export interface TranscriptCleanup {
  at: number;
  /** Tasks whose steps were trimmed. */
  tasks: number;
  /** Steps removed. */
  steps: number;
  /** Free space in the database file afterwards: SQLite reuses it, and a start compacts the file when it's large. */
  freeBytes: number;
}

/** Compacting the database file (VACUUM) at a start, after a clean-up left a lot of it free. */
export interface DatabaseCompact {
  at: number;
  beforeBytes: number;
  afterBytes: number;
  ms: number;
  /** Why it couldn't: the file stays as it was. */
  error?: string;
}

/** Customize › Data (D1). */
export interface DataState {
  retention: TranscriptRetention;
  /** The database file, and the part of it that's free space. */
  fileBytes: number;
  freeBytes: number;
  lastCleanup?: TranscriptCleanup;
  /** A clean-up is running. */
  cleaning: boolean;
  /** The next start compacts the file. */
  compactPending: boolean;
  lastCompact?: DatabaseCompact;
}

export interface TelegramRelayStatus {
  state: "off" | "starting" | "polling" | "error";
  botUsername?: string;
  lastPollAt?: number;
  lastInboundAt?: number;
  lastOutboundAt?: number;
  error?: string;
}

/** Toasts, the "while you were away" card, desktop shortcuts, Voice, Phone push, and Telegram relay (PLAN.md §4.5, §4.7, §5.5, §10 Phase 6D & 8B, D25, D73, D74). */
export interface AttentionSettings {
  /** Only blocking events toast; the milestones it holds back wait for the away card. */
  focusMode: boolean;
  /** The away card after this many minutes away; null: only when Focus mode held something back. */
  awayMinutes: number | null;
  /** Launch ARIA automatically when you sign in to Windows (Phase 6C, PLAN.md §4.1). */
  startAtLogin?: boolean;
  /** When starting at Windows sign-in (`--startup`), keep the main window hidden in the system tray until opened (default true). */
  startMinimized?: boolean;
  /** Register the OS-wide global hotkey (`Ctrl+Alt+Space`) for the Quick prompt bar (Phase 6C, PLAN.md §4.1, §5.5). In-window shortcut remains `Ctrl+Space`. */
  quickPromptHotkey?: boolean;
  /** Which events ARIA speaks aloud (Phase 6D): "off" (default), "blocking" (needs you), or "all" (blocking + milestones). */
  spokenAnnouncements?: SpokenAnnouncementsScope;
  /** Speech synthesis engine: "system" (Windows / browser speechSynthesis, default) or "cloud" (OpenAI-compatible TTS). */
  ttsProvider?: TtsProvider;
  /** Optional preferred system voice name or cloud voice ID (e.g. "alloy"). */
  ttsVoice?: string;
  /** Speech rate multiplier (0.5 to 2.0, default 1.0). */
  ttsRate?: number;
  /** Push-to-talk speech-to-text backend: "whisper.cpp" (local CLI, default) or "cloud" (OpenAI-compatible STT). */
  sttProvider?: SttProvider;
  /** Absolute path to local whisper.cpp executable (e.g. whisper-cli.exe or main.exe). */
  whisperExecutablePath?: string;
  /** Absolute path to local whisper.cpp GGML model file (e.g. ggml-base.en.bin). */
  whisperModelPath?: string;
  /** Optional custom HTTPS endpoint base URL for cloud STT/TTS (default "https://api.openai.com/v1"). */
  voiceCloudEndpoint?: string;
  /** Model ID for cloud STT (default "whisper-1"). */
  sttCloudModel?: string;
  /** Model ID for cloud TTS (default "tts-1"). */
  ttsCloudModel?: string;
  /** True when an encrypted cloud voice API key is saved in the OS keychain (the key itself is never sent to the renderer). */
  hasVoiceCloudApiKey?: boolean;

  // ── Phase 8B: Phone push notifications (PLAN.md §4.7, §10 Phase 8B) ──
  /** Phone push provider while away: "off" (default), "ntfy", or "pushover". */
  phonePushProvider?: PhonePushProvider;
  /** Which events push to your phone while away: "blocking" (default) or "all" (blocking + milestones when Focus mode is off). */
  phonePushScope?: PhonePushScope;
  /** ntfy server base URL (default "https://ntfy.sh"). */
  ntfyServerUrl?: string;
  /** ntfy topic name (e.g. "aria-alerts"). */
  ntfyTopic?: string;
  /** True when an encrypted ntfy access token is saved in the OS keychain (never sent to the renderer). */
  hasNtfyToken?: boolean;
  /** Optional Pushover device name filter. */
  pushoverDevice?: string;
  /** True when encrypted Pushover application token and user key are saved in the OS keychain. */
  hasPushoverCredentials?: boolean;

  // ── Phase 8B: Two-way Telegram relay (PLAN.md §4.7, §10 Phase 8B) ──
  /** Enable the two-way Telegram relay into the ARIA chat. */
  telegramEnabled?: boolean;
  /** Authorized numeric Telegram chat/user ID allowed to send and receive messages (e.g. "123456789"). */
  telegramChatId?: string;
  /** Which events relay outbound to Telegram in addition to assistant replies: "all" (default) or "blocking". */
  telegramOutboundScope?: PhonePushScope;
  /** Polling interval in seconds for Telegram getUpdates (1–60, default 3). */
  telegramPollSeconds?: number;
  /** True when an encrypted Telegram bot token is saved in the OS keychain (never sent to the renderer). */
  hasTelegramBotToken?: boolean;

  // ── Proactive Outlook email watcher ──
  /** Watch Outlook unread emails via Work IQ Mail and ping when an email needs your attention (default true). */
  outlookWatchEnabled?: boolean;
  /** Polling interval in minutes for checking unread Outlook emails (1–60, default 5). */
  outlookPollMinutes?: number;
  /** How candidate emails are triaged: "rules_and_utility" (default, uses Utility model when enabled) or "rules_only" (deterministic plain-code signals only). */
  outlookTriageMode?: OutlookMailTriageMode;
  /** Sender email addresses, domains, or names always treated as high-priority VIPs (max 50). */
  outlookVipSenders?: string[];
  /** Sender email addresses, domains, or subject patterns to ignore (max 50). */
  outlookIgnoreSenders?: string[];
}

export interface QuestionCardPayload {
  taskId: string;
  questionId: string;
  shortId?: string;
  question: string;
  choices?: string[];
  answer?: string;
  /** Who answered: you (on the card, in the session view, by a reply) or ARIA (its answer_question tool). */
  answeredBy?: "you" | "aria";
  /** The answer is in the answerer's own words, not one of the choices ("Save as memory" offers only your own words). */
  freeform?: boolean;
}

export interface PermissionCardPayload {
  taskId: string;
  permissionId: string;
  shortId: string;
  kind: PermissionKind;
  /** The command, or the file. */
  what: string;
  /** Where it runs or which folder or host it touches. */
  where?: string;
  /** What the worker says it's for. */
  why?: string;
  /** Why it needs you. */
  reason: string;
  /** What "Approve for this task" would cover (D21). */
  scope: string;
  sandboxed: boolean;
  /** A sandbox boundary crossed after the ordinary policy checks. */
  sandbox?: SandboxPermission;
  /** A destructive command (D28, D29): Approve once or Reject only, every time; no "Approve for this task". */
  everyTime?: boolean;
  /** "Always allow this" (§5.3): the rules ARIA worked out for it when it was decided (`ruleOffers`). */
  offerId?: string;
  decision?: PermissionDecision | "expired";
  note?: string;
}

export interface PlanCardPayload {
  taskId: string;
  planId: string;
  shortId: string;
  summary: string;
  /** The full plan (Markdown), when the worker wrote one. */
  plan?: string;
  decision?: PlanDecision | "expired";
  feedback?: string;
}

export interface ProposalCardPayload {
  repoId: number;
  repoName: string;
  title: string;
  brief: string;
  profileId: string;
  profileName: string;
  model: string;
  reasoningEffort?: string;
  /** Optional custom or plugin agent ID/name proposed for this task. */
  agent?: string;
  /** ARIA's reason for this profile. */
  reason?: string;
  mode?: TaskMode;
  baseBranch?: string;
  /** Optional tracker task ID linked to this task (Phase 5B, PLAN.md §4.14). */
  trackerTaskId?: string;
  /** Where the proposed task will run ("local" default, or "cloud", Phase 8A). */
  where?: TaskLocation;
  /** Whether a local task is shared to Mission Control (`remote: true`, Phase 8A). */
  remote?: boolean;
  /** What the task may read outside its repository: only paths named in your own message. */
  allowedPaths?: string[];
  decision?: "started" | "dismissed";
  /** The task it became. */
  taskId?: string;
}

export type CardType = CardItem["cardType"];

export type TimelineItem = ChatItem | NoticeItem | CardItem;

// ── Conductor, models, projects ─────────────────────────────────────────────────────────────────────────────────

export type ConductorState = "starting" | "ready" | "busy" | "error";

export interface ConductorStatus {
  state: ConductorState;
  model?: string;
  reasoningEffort?: string;
  /** Human-readable detail: what's starting, or the error. */
  detail?: string;
}

export interface ModelOption {
  id: string;
  name: string;
  /** Runtime picker category: lightweight, versatile, powerful. */
  category?: string;
  /** Runtime price category: low, medium, high, very_high. */
  priceCategory?: string;
  /** AI credits per 1M input / output tokens (billing is token-based; PLAN.md §4.11). */
  inputPrice?: number;
  outputPrice?: number;
  /** Supported reasoning-effort levels, e.g. ["low", "medium", "high"]. Empty when the model has no effort setting. */
  efforts: string[];
  enabled: boolean;
}

export interface Project {
  id: number;
  name: string;
  path: string;
  /** The origin remote's host (github.com, …); unset for an old row until the next rescan. */
  host?: string;
  owner?: string;
  repo?: string;
  /** A fork's `upstream` remote, "owner/repo", only when it's on github.com. */
  upstream?: string;
  defaultBranch?: string;
  /** "git" (default) for a git repository, or "folder" for a plain local directory without git. */
  kind?: "git" | "folder";
  addedVia: "scan" | "local" | "url";
  pinned: boolean;
  hidden: boolean;
}

export interface ConductorSettings {
  model?: string;
  reasoningEffort?: string;
}

export interface UiState {
  sidebarCollapsed: boolean;
  view: "chat" | "customize" | "time" | "search" | "automations";
  /** Which Customize page is open. */
  customizePage?: CustomizePage;
  /** Profile ID pre-opened for editing in Customize › Models. */
  editingProfileId?: string | null;
  /** Selected ISO date YYYY-MM-DD in the Time view (Phase 5D). */
  selectedTimeDate?: string;
}

export type CustomizePage = "models" | "permissions" | "prompts" | "notifications" | "memory" | "integrations" | "data";

export interface TodayTimeSummary {
  date: string;
  draftMinutes: number;
  registeredMinutes: number;
  dayTotalMinutes: number;
  expectedMinutes: number;
}

export interface AppState {
  status: ConductorStatus;
  /** The task tracker: optional, so a window that has no state yet paints neutral text. */
  tracker?: TrackerInfo;
  timeline: TimelineItem[];
  projects: Project[];
  /** Configured root directories scanned for projects and used for cloning/creating repositories. */
  projectRoots?: string[];
  /** The runtime's model catalog; empty until the engine has loaded it (a `models` event follows). */
  models: ModelOption[];
  conductor: ConductorSettings;
  ui: UiState;
  /** Background tasks, newest first (archived ones left out). */
  tasks: Task[];
  profiles: Profile[];
  profilePolicy: ProfilePolicy;
  /** The profile Fix it's new tasks use (D47); unset: the default profile. */
  ciFixProfileId?: string;
  /** Worker permission rules and the sandbox (PLAN.md §4.8, D20). */
  policy: PolicySettings;
  /** Focus mode and the away card's threshold. */
  attention: AttentionSettings;
  /** "Save as memory" notes for task briefs (D23). */
  memory: MemoryState;
  /** MCP servers and tools from your Copilot CLI setup, and your rule per tool (Customize › Integrations). */
  integrations: IntegrationsState;
  /** GitHub watches: the active ones and those that ended in the last 7 days, newest first (PLAN.md §4.6). */
  watches: Watch[];
  /** Whether ARIA can read GitHub, as whom, and the inbox switch. */
  github: GitHubState;
  /** Your mapping rules for time registration (Phase 5B, PLAN.md §4.14). */
  timeRules?: TimeRule[];
  /** Timekeeper model, effort, and daily preferences (Phase 5C, PLAN.md §4.12, §4.14). */
  timekeeper?: TimekeeperSettings;
  /** Today's draft + registered time summary for the Sidebar Time row (Phase 5D, PLAN.md §5.1, §5.2). */
  todayTime?: TodayTimeSummary;
  /** Optional Utility model slot for AI-written morning brief summaries (Phase 6B, PLAN.md §4.12). */
  utility?: UtilitySettings;
  /** Scheduled routines and built-in automations (Phase 6B, PLAN.md §5.2, §10 Phase 6B). */
  routines?: Routine[];
  /** Active and recent reminders (Phase 6B, PLAN.md §4.3, §5.4, §10 Phase 6B). */
  reminders?: Reminder[];
  /** Live status of the two-way Telegram relay (Phase 8B). */
  telegram?: TelegramRelayStatus;
  /** Daily AI-credit budget settings and today's usage (Phase 9, PLAN.md §4.11). */
  budget?: DailyBudgetState;
  /** Current ARIA application version (e.g. "0.1.0"). */
  appVersion?: string;
  /** First-run onboarding, setup checklist, and last-seen version state. */
  onboarding?: OnboardingState;
  /** Structured release notes history (newest first). */
  releases?: ReleaseNoteEntry[];
  /** Newer release available to download from GitHub Releases, if any. */
  availableUpdate?: AvailableUpdateInfo;
  /** Update now's progress (D80). */
  updateStatus?: UpdateStatus;
  /** Whether this build can install an update itself (an installed build; not a development one). */
  canInstallUpdates?: boolean;
  /** Latest Copilot CLI & system doctor report, if run. */
  doctor?: DoctorReport;
}

// ── GitHub watches (Phase 4, PLAN.md §4.6) ──────────────────────────────────────────────────────────────────────

export type WatchKind = "run" | "pr" | "branch" | "inbox";
/**
 * When a watch ends: completed (a run, or a branch's next run, finished), success (green), checks (a PR's current
 * checks finished), merged (a PR merged or closed), forever (only when you stop it: default-branch health, the inbox).
 */
export type WatchUntil = "completed" | "success" | "checks" | "merged" | "forever";
export type WatchTone = "running" | "waiting" | "ok" | "bad" | "paused" | "ended";
export type WatchEndReason = "completed" | "success" | "merged" | "closed" | "timed_out" | "unwatched" | "not_found" | "no_access" | "unreadable" | "merged_into";

/** An unread notification, for My work. Its title is anyone's words: shown to you, never sent to ARIA (D37). */
export interface InboxItem {
  id: string;
  /** review_requested, mention, assign, … */
  reason: string;
  /** PullRequest, Issue, … */
  type: string;
  title: string;
  /** owner/repo */
  repo: string;
  number?: number;
  url: string;
  updatedAt: number;
}

export interface Watch {
  id: number;
  /** W-12: stable across restarts. */
  shortId: string;
  kind: WatchKind;
  repoId?: number;
  /** The project's name, else owner/repo; none for the inbox. */
  repoName?: string;
  title: string;
  /** What it's at, in ARIA's words ("in progress for 3 min"). */
  status: string;
  tone: WatchTone;
  until: WatchUntil;
  expiresAt?: number;
  state: "active" | "ended";
  endedReason?: WatchEndReason;
  /** Why it isn't checked right now (GitHub unavailable, another account, SSO). */
  paused?: string;
  /** The last problem it had, if it keeps having it. */
  error?: string;
  createdBy: "you" | "aria" | "task" | "system";
  taskId?: string;
  /** Its page on github.com, built by ARIA. */
  url?: string;
  /** The GitHub login it was started as. */
  account?: string;
  /** The inbox watch only: its unread notifications. */
  inbox?: InboxItem[];
  lastCheckedAt?: number;
  createdAt: number;
  endedAt?: number;
}

/** Why a My work item is yours. */
export type MyWorkReason = "review_requested" | "authored" | "assigned";

/**
 * A pull request or issue in My work (PLAN.md §5.2, D38: your projects only). Its title is anyone's words: shown to
 * you as plain text, never sent to ARIA.
 */
export interface MyWorkItem {
  /** "owner/repo#12": a key to name it by, never parsed. */
  key: string;
  kind: "pr" | "issue";
  owner: string;
  repo: string;
  /** The project it belongs to (its origin, or a fork's upstream). */
  repoId: number;
  repoName: string;
  number: number;
  title: string;
  author?: string;
  draft?: boolean;
  why: MyWorkReason[];
  updatedAt: number;
  /** Its page on github.com, built by ARIA. */
  url: string;
  /** An active PR watch on it. */
  watchId?: number;
}

/**
 * An assigned tracker task in My work (Phase 7B, PLAN.md §4.6, §5.2, §10 Phase 7B).
 * Kept as sanitized plain text; `url` is built by ARIA from the tracker's task URL template.
 */
export interface MyWorkTrackerTask {
  taskId: string;
  title: string;
  status?: string;
  priority?: string;
  taskType?: string;
  projectId?: string;
  projectName?: string;
  customerId?: string;
  customerName?: string;
  dueDate?: string;
  comment?: string;
  updatedAt: number;
  url: string;
}

export interface MyWorkTrackerState {
  /**
   * - "off": no task tracker MCP server is configured/enabled, or its task-list tools are set to Ask/Never.
   * - "needs_auth": the task tracker MCP server needs signing in or a bearer token in Customize › Integrations.
   * - "loading": a poll is currently in flight.
   * - "ok": tasks were fetched (or loaded from cache).
   * - "error": the last poll failed (`message` says why; previously cached assigned tasks remain visible).
   */
  status: "off" | "needs_auth" | "loading" | "ok" | "error";
  server?: string;
  checkedAt?: number;
  message?: string;
  tasks: MyWorkTrackerTask[];
}

export interface MyWorkOutlookMessage {
  messageId: string;
  subject: string;
  fromName: string;
  fromAddress?: string;
  receivedAt: number;
  urgency: OutlookMailUrgency;
  reason: string;
  preview?: string;
  trackerTaskId?: string;
  webLink?: string;
}

export interface MyWorkOutlookState {
  status: "off" | "needs_auth" | "loading" | "ok" | "error";
  server?: string;
  checkedAt?: number;
  message?: string;
  messages: MyWorkOutlookMessage[];
}

export interface MyWorkState {
  /** off: no GitHub in this run; waiting: GitHub can't be searched now (`message` says why); loading; ok; error. */
  status: "off" | "waiting" | "loading" | "ok" | "error";
  /** Who it searched as. */
  login?: string;
  checkedAt?: number;
  message?: string;
  /** Waiting for GitHub's search limit to reset: when. */
  until?: number;
  items: MyWorkItem[];
  /** How many more GitHub found than are shown, per reason (from its total counts). */
  more: Record<MyWorkReason, number>;
  /**
   * Why the list may lack items: an organisation's SSO (partial results), GitHub's search timing out, projects not
   * searched (too many), searches that failed (their last answers stand in), projects GitHub can't search ("Name
   * (owner/repo)": gone, renamed or not visible to this login).
   */
  partial?: { sso?: boolean; incomplete?: boolean; unsearched?: number; failed?: number; unsearchable?: string[] };
  /** Assigned tracker tasks and watcher status (Phase 7B, PLAN.md §4.6, §5.2). */
  tracker?: MyWorkTrackerState;
  /** Important unread Outlook emails needing your attention and watcher status. */
  outlook?: MyWorkOutlookState;
}

export type GitHubStatus = "off" | "starting" | "ok" | "no_cli" | "signed_out" | "token_refused" | "offline" | "rate_limited" | "unavailable";

export interface GitHubState {
  /**
   * off: this run of ARIA has no GitHub (a test); starting: not checked yet; unavailable: GitHub didn't confirm whose
   * token it is (a 5xx, a proxy's page), asked again in a while.
   */
  status: GitHubStatus;
  login?: string;
  /** Where the token comes from ("GitHub CLI's sign-in"). */
  source?: string;
  /** Variables set in ARIA's environment that it doesn't use for GitHub (GH_TOKEN, GITHUB_TOKEN). */
  ignored?: string[];
  /** What's wrong and what to do. */
  message?: string;
  /** Rate limited or backing off until then. */
  pausedUntil?: number;
  /** The inbox watch is on (D37). */
  inbox: boolean;
}

// ── Background tasks (Phase 2, PLAN.md §4.4) ────────────────────────────────────────────────────────────────────

/**
 * queued → starting → running ⇄ waiting_input / waiting_permission / waiting_plan / waiting_budget → done (needs
 * review) | failed | cancelled. interrupted: ARIA closed while it ran; it can be resumed.
 */
export type TaskState =
  | "queued"
  | "starting"
  | "running"
  | "waiting_input"
  | "waiting_permission"
  | "waiting_plan"
  | "waiting_budget"
  | "done"
  | "failed"
  | "cancelled"
  | "interrupted";

/** plan: the worker plans first and waits for your approval (a plan card), then works in the mode you pick. */
export type TaskMode = "interactive" | "autopilot" | "plan";

export type TaskLocation = "local" | "cloud";

/** GitHub repository target for a cloud session on Mission Control (Phase 8A, PLAN.md §4.4, Appendix A.8). */
export interface CloudRepo {
  owner: string;
  name: string;
  branch?: string;
}

/** A question a worker asked (`ask_user`), waiting for your answer (D17). */
export interface PendingQuestion {
  id: string;
  /** Q-n: how you and ARIA refer to it in the chat. */
  shortId: string;
  question: string;
  choices?: string[];
  allowFreeform: boolean;
  askedAt: number;
}

export type PermissionKind = "shell" | "write" | "read" | "url" | "mcp" | "other";

/** A narrow resource the runtime sandbox blocked and ARIA can safely identify. */
export interface SandboxPermission {
  access: "read" | "write" | "execute" | "network";
  target: string;
  label: string;
  /** Safe target class that may be saved globally as an exact exception. */
  persistent?: "path" | "host";
}

/** once: this request only; task: the same operation on the same target for the rest of the task (D21). */
export type PermissionDecision = "once" | "task" | "always" | "reject";
export type PlanDecision = "autopilot" | "interactive" | "revise" | "cancel";

/** Something a worker wants to do that needs your approval (PLAN.md §4.8). */
export interface PendingPermission {
  id: string;
  /** P-n */
  shortId: string;
  kind: PermissionKind;
  what: string;
  where?: string;
  why?: string;
  reason: string;
  /** What "Approve for this task" would cover. */
  scope: string;
  /** A sandbox boundary crossed after the ordinary policy checks. */
  sandbox?: SandboxPermission;
  /** A destructive command: it asks every time, so "Approve for this task" isn't offered (D29). */
  everyTime?: boolean;
  askedAt: number;
}

/** A worker's plan waiting for approval. */
export interface PendingPlan {
  id: string;
  /** L-n */
  shortId: string;
  summary: string;
  plan?: string;
  askedAt: number;
}

/** "Approve for this task" (D21): the same operation on the same target is approved for the rest of the task. */
export interface TaskGrant {
  /** Its own id, for Revoke. */
  id: string;
  /** The operation: a command as written, or "url", "read", "write". */
  key: string;
  /** Its target: the folder a command runs in, a host, or a folder for files. */
  target: string;
  /** How it reads, e.g. "npm install lodash". */
  label: string;
  at: number;
}

export interface Task {
  id: string;
  sessionId?: string;
  title: string;
  /** How you @mention it in the chat: its branch name without `aria/` (from its title until it has a branch). */
  slug: string;
  /** What the task was asked to do (the brief ARIA or you wrote). */
  brief: string;
  repoId: number;
  repoName: string;
  repoPath: string;
  /** "git" (default) for a git worktree/cloud task, "folder" for a non-git folder session, or "chat" for a standalone generic chat. */
  kind?: "git" | "folder" | "chat";
  branch?: string;
  baseBranch?: string;
  /** Unset once the worktree is cleaned up. */
  worktreePath?: string;
  /** Its worktree was cleaned up after it had started: it can't continue, but its branch keeps the commits. */
  cleanedUp?: boolean;
  profileId?: string;
  profileName: string;
  model: string;
  reasoningEffort?: string;
  /** Optional custom or plugin agent ID/name running this task. */
  agent?: string;
  /** Why this profile: ARIA's reason, or why it fell back to the default. */
  profileNote?: string;
  /** Tracker task ID linked to this task (Phase 5B, PLAN.md §4.14). */
  trackerTaskId?: string;
  /** The id of the tracker `trackerTaskId` belongs to; the window links it only when that is the tracker in use. */
  trackerId?: string;
  mode: TaskMode;
  state: TaskState;
  /** What the worker says it's doing right now ("Editing src/theme.ts"). */
  intent?: string;
  /** The worker's report when it finished. */
  summary?: string;
  error?: string;
  question?: PendingQuestion;
  /** Permission requests waiting for you (a worker can make several at once). */
  permissions?: PendingPermission[];
  plan?: PendingPlan;
  /** The latest plan written by the worker in plan mode (Markdown), kept so you can open and read it in the session view. */
  planText?: string;
  /** B-n of its budget pause, while it's paused. */
  budgetShortId?: string;
  /** What you approved for the rest of this task (D21). */
  grants?: TaskGrant[];
  /** Its pull request, once opened (PLAN.md §4.4). */
  pr?: TaskPr;
  /** Local directories or files outside the repository this task is allowed to read. */
  allowedPaths?: string[];
  /** Extra context provided by the user when starting the session. */
  extraContext?: string;
  /** Files attached or referenced as context when starting the session. */
  files?: string[];
  /**
   * D52: someone else's text went into it (a CI log, a review), so its PR card's tick covers more. Kept once set: the
   * commits it made since may come from that text.
   */
  fromText?: "ci_log" | "review";
  /** What it's fixing now (item 4): the card it came from, in ARIA's words with cleaned names; shown in the window only. */
  fixing?: { kind: "ci" | "review"; cardId: string; label: string; at: number };
  /** It took over this task's branch (D46). */
  adoptedFrom?: string;
  /** A task adopted its branch: this one can't continue on it anymore, and @mentions go to the other. */
  adoptedBy?: string;
  /** ID of the root task this task was rerun from ("Rerun with…", Phase 6C, PLAN.md §5.3). */
  rerunOf?: string;
  /** Where the task runs (Phase 8A, PLAN.md §4.4): "local" (default, in a git worktree) or "cloud" (Mission Control). */
  where?: TaskLocation;
  /** True when a local task shares its session to GitHub web and mobile through Mission Control (`remote: true`). */
  remote?: boolean;
  /** Mission Control URL from `session.info` (`infoType === "remote"`), e.g. `https://github.com/copilot/tasks/<id>`. */
  missionControlUrl?: string;
  /** Target GitHub repository when `where === "cloud"`. */
  cloudRepo?: CloudRepo;
  /** Whether its session runs in the runtime's sandbox (D20); unset until it opened. */
  sandboxed?: boolean;
  commits?: number;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
  uncommitted?: number;
  /** R1: lines it added that look like damaged text, counted when it last finished. */
  encodingDamage?: EncodingDamage;
  /** AI credits used so far (from the session's usage events). */
  costCredits: number;
  /** Pause the task when it has used this many credits. */
  budgetCredits?: number;
  startedBy: "aria" | "you";
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;
}

/** A named model + effort preset for workers (PLAN.md §4.12). */
export interface Profile {
  id: string;
  name: string;
  /** When to use it; also shown to ARIA in list_profiles. */
  description?: string;
  model: string;
  reasoningEffort?: string;
  /** Optional custom or plugin agent ID/name bound to this profile. */
  agent?: string;
  mode: TaskMode;
  /** Extra instructions added to every brief that uses this profile. */
  instructions?: string;
  budgetCredits?: number;
  isDefault: boolean;
}

/**
 * Who picks a task's profile: "me" = Default unless you name one; "aria" = ARIA picks among yours and says why;
 * "ask" = ARIA proposes one on a card and the task starts when you press Start.
 */
export type ProfilePolicy = "me" | "aria" | "ask";

// ── Permissions and the sandbox (Phase 3, PLAN.md §4.8, D20, D21) ───────────────────────────────────────────────

export type RuleEffect = "auto" | "ask" | "never";

/** Which tasks a rule applies to (D27): all of them, or only tasks in the sandbox. */
export type RuleScope = "everywhere" | "sandboxed";

/** A rule for workers' shell commands: `match` is the command and any arguments it must have ("git reset --hard"); a
 * `<package>` (or any `<…>`) word stands for one argument, and more may follow ("npm install <package>"). */
export interface PolicyRule {
  id: string;
  match: string;
  effect: RuleEffect;
  note?: string;
  /** Only exactly this command: the same arguments in the same order, letter case included, nothing more (a `<…>` word is one argument). */
  exact?: boolean;
  /** Absent: every task (as rules always applied). */
  scope?: RuleScope;
}

/** What ARIA says about a rule before it's saved (D26): `problems` keep it from being saved, `warnings` don't. */
export interface RuleCheck {
  problems: string[];
  warnings: string[];
}

/**
 * "Always allow this" (§5.3): exact Auto rules that would let this command run on its own, worked out (and checked)
 * when ARIA decided it. Never offered for a fixed rule's refusal or a destructive command.
 */
export interface RuleOffer {
  id: string;
  at: number;
  /** The command as the task asked to run it. */
  command: string;
  cwd?: string;
  /** The tool call it was for (the session view finds its step by it). */
  toolCallId?: string;
  /** Rules saved from a sandboxed task apply only to sandboxed tasks (D27). */
  scope: RuleScope;
  /** What the task got: it asked you, or your rule refused it. */
  decided: "ask" | "never";
  rules: Array<{ match: string; exact: boolean }>;
  /**
   * Your Never rules that refuse this command now: saving makes it run anyway, so it needs your confirmation. `sameRule`:
   * the rule is exactly this command, and saving turns it into a rule that lets it run.
   */
  overrides?: Array<{ ruleId: string; match: string; sameRule: boolean }>;
}

// ── Integrations (Phase 3 Part B & Phase 7A, PLAN.md §4.13, D22, D30–D34) ──────────────────────────────────────

/** A tool's class from its name (§4.13); a name that doesn't clearly read counts as a write. */
export type ToolClass = "read" | "write" | "destructive" | "unrestricted";
/** Which sessions a rule is for: ARIA's own, or tasks'. (The Timekeeper's comes with it, Phase 5.) */
export type IntegrationScope = "aria" | "tasks";
export type ToolRuleEffect = "auto" | "ask" | "never";
export type McpServerTransport = "stdio" | "http" | "sse";

export interface IntegrationTestResult {
  status: "testing" | "ok" | "failed";
  latencyMs?: number;
  toolCount?: number;
  /** Sanitized human-readable summary, e.g. "Connected (56 tools, 42 ms)" or "401 Unauthorized: needs sign-in". */
  message?: string;
  at: number;
}

/** A server from your Copilot CLI setup or ARIA's own MCP config as ARIA's runtime sees it. Its URL isn't kept (it can carry keys). */
export interface IntegrationServer {
  name: string;
  displayName?: string;
  /** connected, needs-auth, failed, pending, disabled, stopped, not_configured (the runtime's words). */
  status: string;
  /** user, workspace, plugin, builtin, managed, account, aria. */
  source?: string;
  sourcePlugin?: string;
  error?: string;
  /** In the last check of your setup (else it's shown as gone, with when it was last seen). */
  seen: boolean;
  lastSeen: number;
  toolCount: number;
  /** Another server with the same address, whose tools ARIA uses instead. */
  duplicateOf?: string;
  /** One of GitHub's servers (by its name or its address): D31 applies to its tools. */
  github: boolean;
  /** A server of the active task tracker (`TaskTracker.matchesServer`): the UI says what its read tools reach. */
  tracker?: boolean;

  // ── Phase 7A: Native MCP configuration & Test status ──
  /** True when this server is stored in ARIA's own MCP configuration. */
  configuredInAria?: boolean;
  /** Whether the server entry in ARIA's config was imported from CLI ("cli") or added/edited in ARIA ("aria"). */
  configSource?: "cli" | "aria";
  /** Transport type when known ("stdio", "http", or "sse"). */
  transport?: McpServerTransport;
  /** Whether the server is enabled in ARIA's own config (default true). */
  enabled?: boolean;
  /** For stdio servers: the executable basename/command (e.g. "node", "npx"), sanitized. */
  command?: string;
  /** Number of command-line arguments configured for a stdio server. */
  argCount?: number;
  /** Names of configured environment variables (values are never sent to the renderer). */
  envKeys?: string[];
  /** Names of configured HTTP headers (values are never sent to the renderer). */
  headerKeys?: string[];
  /** True when an encrypted bearer token or secret header is saved for this server. */
  hasAuthToken?: boolean;
  /** Timeout in ms configured for this server. */
  timeout?: number;
  /** Latest result of clicking the "Test" button in Customize › Integrations. */
  testResult?: IntegrationTestResult;
}

export interface IntegrationToolRule {
  effect: ToolRuleEffect;
  /** No rule of yours: the default for its class and server. */
  isDefault: boolean;
  /** What you can pick for it (D22, D30, D31, D34). */
  allowed: ToolRuleEffect[];
  /** Why some aren't offered, or what Ask means here. */
  note?: string;
}

export interface IntegrationTool {
  server: string;
  /** The MCP tool's own name. */
  tool: string;
  /** The runtime's name for it (`<server>-<tool>`). */
  wireName: string;
  description?: string;
  cls: ToolClass;
  /** Its server is one of GitHub's. */
  github: boolean;
  seen: boolean;
  lastSeen: number;
  rules: Record<IntegrationScope, IntegrationToolRule>;
}

export interface SignInState {
  server: string;
  /** starting: before there's a page (the runtime loads the session's servers first); waiting: the page is open. */
  state: "starting" | "waiting" | "connected" | "failed" | "timed_out" | "cancelled";
  /** The sign-in page's host (punycode), not its address. */
  host?: string;
  message?: string;
  at: number;
}

export interface MarketplaceItem {
  name: string;
  source: string;
  isDefault?: boolean;
  managed?: boolean;
  available?: boolean;
}

export interface MarketplaceCatalogPlugin {
  name: string;
  description?: string;
}

export interface InstalledPluginItem {
  name: string;
  marketplace: string;
  version?: string;
  enabled: boolean;
  directSourceId?: string;
  installedFrom?: string;
  source?: string;
  managed?: boolean;
  installed?: boolean;
}

export type AgentSource = "user" | "project" | "plugin" | "builtin" | "remote" | string;

export interface DiscoveredAgentItem {
  /** Stable selection ID (e.g. "example-connector:example-connector-orchestrator" or "explore"). */
  id: string;
  name: string;
  displayName: string;
  description: string;
  source?: AgentSource;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
  tools?: string[];
  skills?: string[];
  model?: string;
  reasoningEffort?: string;
  path?: string;
}

export type DiscoveredSkillSource = "builtin" | "personal-copilot" | "project-copilot" | "plugin" | "custom" | string;

export interface DiscoveredSkillItem {
  name: string;
  commandName?: string;
  description: string;
  source: DiscoveredSkillSource;
  pluginName?: string;
  userInvocable: boolean;
  enabled: boolean;
  argumentHint?: string;
  path?: string;
}

export interface IntegrationsState {
  servers: IntegrationServer[];
  tools: IntegrationTool[];
  /** When ARIA last checked your setup; unset before the first check. */
  checkedAt?: number;
  /** Whether ARIA's runtime is up (else what's shown is the last check). */
  runtimeUp: boolean;
  refreshing: boolean;
  refreshError?: string;
  signIn?: SignInState;
  /** The task tracker: the one in use, the configs in the trackers folder, and which of its tools each server has. */
  tracker?: TrackerSetup;

  // ── Phase 7A: Native MCP configuration state ──
  /** When true, ARIA re-imports ~/.copilot/mcp-config.json on startup and on Refresh. */
  keepInSync?: boolean;
  /** When ARIA last imported servers from Copilot CLI. */
  lastImportedAt?: number;
  /** Count of servers currently stored in ARIA's own MCP configuration. */
  configuredServerCount?: number;
  /** Plugin directories configured in ARIA (sanitized paths). */
  pluginDirectories?: string[];

  // ── Marketplaces, Plugins, Agents & Skills ──
  /** Registered plugin marketplaces (defaults + user-added). */
  marketplaces?: MarketplaceItem[];
  /** Installed agent/skill/MCP plugins. */
  plugins?: InstalledPluginItem[];
  /** Discovered custom, plugin, project, and built-in agents. */
  agents?: DiscoveredAgentItem[];
  /** Discovered built-in, personal, project, and plugin skills. */
  skills?: DiscoveredSkillItem[];
  /** Explicit skill directories configured in ARIA. */
  skillDirectories?: string[];
  /** Explicit agent directories configured in ARIA. */
  agentDirectories?: string[];
  /** Skills disabled in ARIA. */
  disabledSkills?: string[];
}

// ── Memory (Phase 3 Part B, D23) ─────────────────────────────────────────────────────────────────────────────────

export type MemoryScope = "global" | "project";

/** Where a note came from, for the list in Customize › Memory. */
export interface MemorySource {
  kind: "message" | "answer" | "typed" | "aria";
  taskId?: string;
  taskTitle?: string;
  at: number;
}

/** A one-line note in your own words that goes into task briefs and ARIA's own prompt (D23, Phase 6A). */
export interface Memory {
  id: string;
  scope: MemoryScope;
  repoId?: number;
  repoName?: string;
  text: string;
  source?: MemorySource;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryState {
  memories: Memory[];
  /** Whether the brief template in use has {{memory}} (without it, briefs get no notes). */
  templateUsesMemory: boolean;
  /** Whether ARIA's own system prompt template in use has {{memory}} (Phase 6A). */
  conductorUsesMemory?: boolean;
  /** Notes that don't fit in a brief (at most 30 lines and 3,000 characters): per project, and for a project without notes of its own (null). */
  leftOut: Array<{ repoId: number | null; ids: string[] }>;
  /** Notes that don't fit in ARIA's own system prompt (at most 30 lines and 3,000 characters). */
  conductorLeftOut?: string[];
}

/** Your own words to a task (a message, or an answer in your words), which "Save as memory" is offered on. */
export interface YourWords {
  id: string;
  kind: "message" | "answer";
  text: string;
  at: number;
  questionId?: string;
}

export interface SandboxStatus {
  /** Whether this PC can run the runtime's sandbox. */
  supported: boolean;
  /** Why not, when it can't. */
  reason?: string;
  /** Your setting: run tasks in the sandbox when the PC can. */
  enabled: boolean;
  /** Hosts sandboxed tasks may reach (package registries by default). */
  allowedHosts: string[];
  /** Local directories or files sandboxed tasks may read outside their worktrees. */
  allowedPaths: string[];
}

export interface PolicySettings {
  rules: PolicyRule[];
  /** Your rules are still the defaults (they follow new defaults until you save any rule). */
  usesDefaults?: boolean;
  sandbox: SandboxStatus;
}

// ── Prompts (Phase 3, PLAN.md §5.3) ─────────────────────────────────────────────────────────────────────────────

/** "conductor" (ARIA's system prompt), "brief" (the worker brief template) or "profile:<id>" (a profile's
 * instructions). */
export type PromptName = string;

export interface PromptInfo {
  name: PromptName;
  label: string;
  /** The active text. */
  text: string;
  /** The built-in text ("Reset" restores it); empty for profile instructions. */
  defaultText: string;
  /** Saved versions so far (0: never edited). */
  version: number;
  /** Placeholders it may use, e.g. {{brief}}. */
  placeholders: string[];
  /** Placeholders it must contain. */
  required: string[];
}

export interface PromptVersion {
  version: number;
  text: string;
  note?: string;
  createdAt: number;
}

/**
 * One step of a session, for the session view. Long text is cut at a size limit; the `…Cut` fields say how many
 * characters were left out (the text itself carries no marker, so Markdown isn't broken by one).
 */
export type TranscriptEntry =
  | {
      kind: "user";
      id: string;
      at: number;
      text: string;
      textCut?: number;
      /** In ARIA's own session: the `<updates>`/`<pending>` block that was sent in front of your words (`text`). */
      digest?: string;
      /** Set when the runtime added the message itself (e.g. "system"); a message you typed has none. */
      source?: string;
    }
  | { kind: "assistant"; id: string; at: number; text: string; textCut?: number }
  | { kind: "reasoning"; id: string; at: number; text: string; textCut?: number }
  | {
      kind: "tool";
      id: string;
      at: number;
      name: string;
      args?: string;
      result?: string;
      error?: string;
      success?: boolean;
      ms?: number;
      argsCut?: number;
      resultCut?: number;
      errorCut?: number;
    }
  | { kind: "permission"; id: string; at: number; detail: string; approved?: boolean; reason?: string; toolCallId?: string }
  | { kind: "question"; id: string; at: number; question: string; choices?: string[]; answer?: string }
  | { kind: "info"; id: string; at: number; level: "info" | "warning" | "error"; text: string; detail?: string; detailCut?: number };

/** ARIA's own session for the inspector (PLAN.md §5.3): the last of your messages, each with what followed it. */
export interface ConductorTranscript {
  sessionId: string;
  /** Oldest first; starts at one of your messages, unless nothing is left out (then it starts at the beginning). */
  entries: TranscriptEntry[];
  /** Your earlier messages the engine keeps that aren't included (more can be asked for). */
  omitted: number;
  /** Your messages older than what the engine keeps for the inspector (they can't be shown). */
  notKept: number;
}

/** Part of a task's transcript for the session view: it opens on the newest steps and asks for earlier ones (P4). */
export interface TranscriptPage {
  /** Oldest first, one after the other. */
  entries: TranscriptEntry[];
  /** Steps before these that aren't included. */
  omitted: number;
  /** The task's first step (its brief), when it's among the omitted. */
  first?: TranscriptEntry;
  /** Whether one of all its steps, included or not, wrote the task's plan file. */
  plan: boolean;
}

export { CONDUCTOR_TRANSCRIPT_MAX_TURNS, lastTurns, mergeEntries, pageStart, startsTurn, TRANSCRIPT_PAGE, transcriptPage, widenTo, writesPlan } from "./transcript.ts";
export { ENCODING_DAMAGE_MAX_PATHS, encodingDamageText, type EncodingDamage } from "./encoding.ts";
export {
  trackerTaskUrl,
  type TrackerChangePreview,
  type TrackerConfigListing,
  type TrackerImportResult,
  type TrackerInfo,
  type TrackerPurgeCounts,
  type TrackerSetup,
  type TrackerToolPart,
  type TrackerToolStatus,
} from "./tracker.ts";
import type { TrackerChangePreview, TrackerImportResult, TrackerInfo, TrackerSetup } from "./tracker.ts";

export interface TaskDiff {
  /** Unified diff of everything the task changed since its base, committed or not (LF line endings). */
  text: string;
  /** True when the diff was cut off at the size limit. */
  truncated: boolean;
}

export interface TaskFile {
  /** Worktree-relative path (forward slashes). */
  path: string;
  /** UTF-8 file text (LF line endings). */
  content: string;
  /** True when the file was cut off at the preview size limit. */
  truncated: boolean;
}

// ── Events (core → UI, one channel) ─────────────────────────────────────────────────────────────────────────────

export type EngineEvent =
  | { type: "status"; status: ConductorStatus }
  | { type: "timeline"; item: TimelineItem }
  /** A card was cleared from the chat timeline. */
  | { type: "timeline_removed"; id: string }
  /** A streaming chunk of an assistant message that isn't final yet. */
  | { type: "delta"; itemId: string; text: string }
  /** What the Conductor is doing right now ("Reading files"), or null when it stopped. */
  | { type: "activity"; label: string | null }
  | { type: "projects"; projects: Project[] }
  | { type: "project_roots"; projectRoots: string[] }
  | { type: "models"; models: ModelOption[] }
  /** The Conductor's model settings, also sent once the default is known at startup. */
  | { type: "settings"; conductor: ConductorSettings }
  /** A task was added or changed (the whole task). */
  | { type: "task"; task: Task }
  /** A task was discarded and is gone from the lists. */
  | { type: "task_removed"; taskId: string }
  | { type: "profiles"; profiles: Profile[]; policy: ProfilePolicy; ciFixProfileId?: string }
  /** The permission rules or the sandbox settings changed. */
  | { type: "policy"; policy: PolicySettings }
  /** New or updated transcript entries of a task (an entry with a known id replaces it). */
  | { type: "transcript"; taskId: string; entries: TranscriptEntry[] }
  /** New or updated entries of ARIA's own session, for the inspector; sent empty when its session (re)opens. */
  | { type: "conductor_transcript"; sessionId: string; entries: TranscriptEntry[] }
  /**
   * A toast to show now: the engine already decided (D25, Focus mode, coalescing). `cardId` is where it shows in the
   * chat; `replaces` is an earlier toast this one takes the place of (close that one first).
   */
  | { type: "toast"; id: string; priority: "blocking" | "milestone"; title: string; body: string; silent: boolean; taskId?: string; cardId?: string; replaces?: string }
  /** Focus mode or the away threshold changed. */
  | { type: "attention"; settings: AttentionSettings }
  /** The memory notes changed (or the brief template, which decides whether briefs get them). */
  | { type: "memories"; memory: MemoryState }
  /** The servers, tools or rules of Customize › Integrations changed (or a sign-in moved on). */
  | { type: "integrations"; integrations: IntegrationsState }
  /** A watch was added or changed (the whole watch). */
  | { type: "watch"; watch: Watch }
  /** GitHub access or the inbox switch changed. */
  | { type: "github"; github: GitHubState }
  /** My work's list or its state changed. */
  | { type: "my_work"; myWork: MyWorkState }
  /** The active task tracker changed (a config was chosen, reloaded or left): the window's `tracker`, absent for none. */
  | { type: "tracker"; tracker?: TrackerInfo }
  /** Your time-mapping rules changed (Phase 5B). */
  | { type: "time_rules"; timeRules: TimeRule[] }
  /** Timekeeper model or daily timesheet preferences changed (Phase 5C). */
  | { type: "timekeeper"; timekeeper: TimekeeperSettings }
  /** Today's draft + registered time summary changed (Phase 5D). */
  | { type: "today_time"; todayTime: TodayTimeSummary }
  /** Utility model settings changed (Phase 6B). */
  | { type: "utility"; utility: UtilitySettings }
  /** Scheduled routines changed (Phase 6B). */
  | { type: "routines"; routines: Routine[] }
  /** Reminders changed (Phase 6B). */
  | { type: "reminders"; reminders: Reminder[] }
  /** From the desktop shell (a toast was clicked): bring this card or task into view. */
  | { type: "focus"; cardId?: string; taskId?: string }
  /** From the desktop shell (Ctrl+Space global hotkey or tray menu): open the Spotlight-style quick prompt bar (Phase 6C). */
  | { type: "quick_prompt" }
  /** A short spoken announcement for a blocking or milestone event (Phase 6D, PLAN.md §4.7, §10 Phase 6D). */
  | {
      type: "speak";
      id: string;
      priority: "blocking" | "milestone";
      text: string;
      taskId?: string;
      cardId?: string;
    }
  /** Live status of the two-way Telegram relay changed (Phase 8B). */
  | { type: "telegram"; telegram: TelegramRelayStatus }
  /** Daily AI-credit budget settings or today's usage changed (Phase 9). */
  | { type: "budget"; budget: DailyBudgetState }
  /** First-run onboarding or last-seen version state changed. */
  | { type: "onboarding"; onboarding: OnboardingState }
  /** A newer release of ARIA is available to download. */
  | { type: "available_update"; availableUpdate: AvailableUpdateInfo | null }
  /** Update now's download or install moved on (D80). */
  | { type: "update_status"; updateStatus: UpdateStatus }
  /** System & Copilot CLI doctor report updated. */
  | { type: "doctor"; doctor: DoctorReport };

// ── Work tracking, tracker linking and mapping rules (Phase 5B, PLAN.md §4.14, §8) ──────────────────────────────

export type ActivitySource = "github" | "git" | "aria" | "calendar" | "teams" | "mail" | "tracker";

export type ActivityKind =
  | "task"
  | "commit"
  | "pr_opened"
  | "pr_updated"
  | "pr_merged"
  | "pr_closed"
  | "pr_review"
  | "ci_run"
  | "meeting"
  | "chat"
  | "mail"
  | "time_log"
  | "task_updated";

export interface Activity {
  id: string;
  source: ActivitySource;
  kind: ActivityKind;
  startedAt: number;
  endedAt: number;
  repoId?: number;
  externalId: string;
  title: string;
  /** Explicit tracker task ID linked on the activity, or cleared (`undefined`). */
  linkedTrackerTaskId?: string;
  /** The id of the tracker `linkedTrackerTaskId` belongs to: a link of another tracker is dormant. */
  linkedTrackerId?: string;
  /** True when the user explicitly linked or cleared `linkedTrackerTaskId`, so automatic scans don't overwrite it. */
  manualLink?: boolean;
  metadata: Record<string, unknown>;
  /** Resolved tracker task from explicit link or mapping rule (`resolveActivityTask`). */
  resolvedTask?: {
    trackerTaskId: string;
    mappedBy: "link" | "rule";
    ruleId?: string;
  };
  /** Resolved duration in minutes from a matching `TimeRule` (e.g. for an email matching a subject rule). */
  resolvedMinutes?: number;
  createdAt: number;
  updatedAt: number;
}

export type TimeRuleKind =
  | "repo"
  | "branch"
  | "meeting_title"
  | "meeting_organizer"
  | "teams_channel"
  | "mail_subject"
  | "mail_recipient";
export type TimeRuleMatchMode = "exact" | "contains" | "prefix";

export interface TimeRuleMatch {
  kind: TimeRuleKind;
  /** For `repo`: the project's numeric id (and optional name in `pattern`). */
  repoId?: number;
  pattern: string;
  matchMode?: TimeRuleMatchMode;
  /** Optional fixed/default duration in minutes (15..480) when this rule matches an activity (e.g. a sent email). */
  defaultMinutes?: number;
}

export interface TimeRule {
  id: string;
  match: TimeRuleMatch;
  trackerTaskId: string;
  trackerTaskTitle?: string;
  /** The tracker the rule's task belongs to; a rule of another tracker is dormant. Absent for a rule that names no task. */
  trackerId?: string;
  /** Optional fixed/default duration in minutes (15..480) when this rule matches an activity (e.g. a sent email). */
  defaultMinutes?: number;
  createdFrom: "you" | "correction";
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TrackerTaskCacheEntry {
  taskId: string;
  title: string;
  projectId?: string;
  customerId?: string;
  status?: string;
  lastSeen: Record<string, unknown>;
  fetchedAt: number;
}

// ── Timekeeper session and Timesheet draft (Phase 5C, PLAN.md §4.12, §4.14, §5.4, §8) ───────────────────────────

export type TimesheetRounding = 1 | 5 | 10 | 15 | 30;

export interface TimekeeperSettings {
  model?: string;
  reasoningEffort?: string;
  /** Expected work minutes per day (default 480 = 8h). */
  expectedMinutes: number;
  /** Rounding step in minutes (default 15). */
  roundingMinutes: TimesheetRounding;
  /** Start of working day in HH:mm (default "09:00"). */
  workStart: string;
  /** End of working day in HH:mm (default "17:00"). */
  workEnd: string;
  /** Local HH:mm time for the daily timesheet draft routine (default "16:30", Phase 6B). */
  timesheetTime?: string;
  /** Default duration in minutes for discovered sent emails when no specific rule sets `defaultMinutes` (default 15). */
  defaultMailMinutes?: number;
  /**
   * Extra commit author names and emails that count as yours when the local git scan decides which commits are yours
   * (a work identity, a bot account). Empty by default (then absent). Each is matched exactly, case ignored: "Sam R." is not
   * "Sam R.-Lopez". Your git `user.name` and `user.email`, your GitHub login, `aria/*` branches and the email the app
   * commits under itself always count, so they need no entry.
   */
  ownAuthors?: string[];
}

export type TimesheetMappedBy = "link" | "rule" | "suggestion" | "you";
export type TimesheetConfidence = "certain" | "uncertain";
export type TimesheetEntryState = "draft" | "approved" | "submitted" | "failed";

export interface TimesheetSourceRef {
  source: ActivitySource;
  kind?: ActivityKind;
  externalId?: string;
  title?: string;
  repoId?: number;
  repoName?: string;
  branch?: string;
  organizer?: string;
  topic?: string;
  recipient?: string;
}

export interface TimesheetEntry {
  id: string;
  /** ISO date YYYY-MM-DD in your local time zone. */
  date: string;
  /** Start time in HH:mm (local time). */
  start: string;
  /** End time in HH:mm (local time). */
  end: string;
  /** Duration in minutes (plain-code computed from start..end). */
  minutes: number;
  trackerTaskId?: string;
  /** The tracker `trackerTaskId` (and a registered entry) belongs to: only the tracker in use can submit it or be linked to. */
  trackerId?: string;
  trackerTaskTitle?: string;
  trackerProjectId?: string;
  trackerCustomerId?: string;
  comment: string;
  sources: TimesheetSourceRef[];
  mappedBy: TimesheetMappedBy;
  confidence: TimesheetConfidence;
  uncertaintyReason?: string;
  /** True when this draft entry overlaps another draft entry on the same day. */
  overlap?: boolean;
  /** Detailed breakdown of which entries this draft entry overlaps with. */
  overlapDetails?: TimesheetOverlapDetail[];
  /** Set when this draft entry duplicates or overlaps an entry already registered in the tracker. */
  duplicateTrackerId?: string;
  overlapsTrackerId?: string;
  state: TimesheetEntryState;
  trackerEntryId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TimesheetGap {
  start: string;
  end: string;
  minutes: number;
}

export interface TimesheetOverlapDetail {
  /** The conflicting entry's ID. */
  targetId: string;
  /** Whether the conflicting entry is a draft row or already registered in the tracker. */
  targetType: "draft" | "tracker";
  /** The conflicting entry's start time (HH:mm). */
  targetStart: string;
  /** The conflicting entry's end time (HH:mm). */
  targetEnd: string;
  /** Descriptive label or task title/ID of the conflicting entry. */
  targetLabel?: string;
  /** The overlap interval start (HH:mm). */
  overlapStart: string;
  /** The overlap interval end (HH:mm). */
  overlapEnd: string;
  /** Duration of the overlap in minutes. */
  overlapMinutes: number;
}

export interface TimesheetRegisteredEntry {
  id: string;
  start: string;
  end: string;
  minutes: number;
  trackerTaskId: string;
  /** The tracker the entry was registered in; one of another tracker is history (no link, Update or Delete). */
  trackerId?: string;
  trackerTaskTitle?: string;
  trackerProjectId?: string;
  trackerCustomerId?: string;
  comment?: string;
  sources?: TimesheetSourceRef[];
  /** True when this registered entry overlaps another entry on the same day. */
  overlap?: boolean;
  /** Detailed breakdown of which entries this registered entry overlaps with. */
  overlapDetails?: TimesheetOverlapDetail[];
}

export interface TimeRegisteredEntryResult {
  entryId: string;
  start: string;
  end: string;
  minutes: number;
  trackerTaskId: string;
  trackerTaskTitle?: string;
  trackerProjectId: string;
  trackerCustomerId: string;
  comment: string;
  status: "registered" | "failed" | "unknown";
  trackerEntryId?: string;
  error?: string;
}

export interface TimeRegisteredCardPayload {
  date: string;
  dateLabel: string;
  status: "submitting" | "registered" | "partial" | "failed";
  revision: number;
  totalMinutes: number;
  registeredMinutes: number;
  entries: TimeRegisteredEntryResult[];
  /** True when the submit outcome was ambiguous/interrupted and the tracker's logs must be refreshed before retrying. */
  needsReconcile?: boolean;
  /** Full server response shown when the batch fails fully or partly (D16). */
  rawResponse?: string;
  error?: string;
}

export interface TimeDaySummary {
  date: string;
  dateLabel: string;
  isToday: boolean;
  isWeekend: boolean;
  draftMinutes: number;
  registeredMinutes: number;
  dayTotalMinutes: number;
  expectedMinutes: number;
  uncertainCount: number;
  overlapCount: number;
  duplicateCount: number;
  gapCount: number;
  draftCount: number;
  failedCount: number;
  registeredCount: number;
}

export interface TimeViewState {
  selectedDate: string;
  /** Monday of the ISO week (YYYY-MM-DD). */
  weekStart: string;
  days: TimeDaySummary[];
  day: TimesheetCardPayload;
  activities: Activity[];
}

/** "Always map X to task Y?" learning offer when you assign or correct a row's tracker task (§4.14). */
export interface TimesheetRuleOffer {
  id: string;
  entryId: string;
  kind: TimeRuleKind;
  repoId?: number;
  pattern: string;
  matchMode: TimeRuleMatchMode;
  trackerTaskId: string;
  trackerTaskTitle?: string;
  defaultMinutes?: number;
  /** Human-readable label, e.g. 'Always map meeting "Standup" to task #ACME-123?' */
  prompt: string;
}

export interface TimesheetCardPayload {
  /** ISO date YYYY-MM-DD. */
  date: string;
  /** Formatted label, e.g. "Fri 23 Oct". */
  dateLabel: string;
  timeZone: string;
  status: "preparing" | "draft" | "error";
  revision: number;
  /** Sum of draft entry minutes. */
  draftMinutes: number;
  /** Sum of already-registered tracker log minutes on this day. */
  registeredMinutes: number;
  /** Total non-overlapping minutes covered by draft + registered entries. */
  dayTotalMinutes: number;
  expectedMinutes: number;
  uncertainCount: number;
  overlapCount: number;
  duplicateCount: number;
  gaps: TimesheetGap[];
  entries: TimesheetEntry[];
  registered: TimesheetRegisteredEntry[];
  ruleOffers: TimesheetRuleOffer[];
  notes?: string[];
  error?: string;
}

// ── Inputs (UI → core), validated in main ───────────────────────────────────────────────────────────────────────

export const SendMessageInput = z.object({ text: z.string().trim().min(1).max(50_000) });
export const SetConductorModelInput = z.object({
  model: z.string().min(1).max(200),
  reasoningEffort: z.string().min(1).max(20).optional(),
});
export const CreateProjectInput = z.object({
  name: z.string().trim().min(1).max(200),
  visibility: z.enum(["private", "public", "internal"]).optional(),
  description: z.string().trim().max(500).optional(),
  addReadme: z.boolean().optional(),
  gitignore: z.string().trim().max(100).optional(),
  license: z.string().trim().max(100).optional(),
  localOnly: z.boolean().optional(),
  rootFolder: z.string().trim().optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;
export const CloneProjectInput = z.object({
  url: z
    .string()
    .trim()
    .max(500)
    .regex(/^(https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+?(\.git)?\/?|git@[\w.-]+:[\w.-]+\/[\w.-]+?(\.git)?|[\w.-]+\/[\w.-]+)$/, "Expected an https://, git@, or owner/repo repository"),
});
export const UiPatchInput = z.object({
  sidebarCollapsed: z.boolean().optional(),
  view: z.enum(["chat", "customize", "time", "search", "automations"]).optional(),
  customizePage: z.enum(["models", "permissions", "prompts", "notifications", "memory", "integrations", "data"]).optional(),
  editingProfileId: z.string().min(1).max(100).nullable().optional(),
  selectedTimeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export const OpenExternalInput = z.object({ url: z.string().url().max(2000) });

const taskId = z.string().min(1).max(100);
const itemId = z.string().min(1).max(100);
const modelId = z.string().min(1).max(200);
const effort = z.string().min(1).max(20);
const taskMode = z.enum(["interactive", "autopilot", "plan"]);
/** Branch names git would accept, without anything that reads as an option or a path escape. */
const branchName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^(?!-)(?!.*\.\.)(?!.*\/\/)[\w./-]+(?<![./])$/, "Not a valid branch name");

export const TaskIdInput = z.object({ taskId });
export const TaskFileInput = z.object({
  taskId,
  path: z.string().trim().min(1).max(1_000),
});
export const StartTaskInput = z.object({
  repoId: z.number().int().nonnegative(),
  brief: z.string().trim().min(1).max(20_000),
  title: z.string().trim().min(1).max(120).optional(),
  profileId: z.string().min(1).max(100).optional(),
  agent: z.string().trim().min(1).max(200).optional(),
  mode: taskMode.optional(),
  baseBranch: branchName.optional(),
  trackerTaskId: z.string().trim().max(300).optional(),
  rerunOf: taskId.optional(),
  where: z.enum(["local", "cloud"]).optional(),
  remote: z.boolean().optional(),
  allowedPaths: z.array(z.string().trim().max(1_000)).max(50).optional(),
  extraContext: z.string().trim().max(50_000).optional(),
  files: z.array(z.string().trim().max(1_000)).max(100).optional(),
});
export const MessageTaskInput = z.object({ taskId, text: z.string().trim().min(1).max(20_000), steer: z.boolean() });
export const AnswerQuestionInput = z.object({
  taskId,
  questionId: z.string().min(1).max(100),
  answer: z.string().trim().min(1).max(5_000),
  wasFreeform: z.boolean(),
});
export const SetTaskModelInput = z.object({ taskId, model: modelId, reasoningEffort: effort.optional() });
export const SetTaskAgentInput = z.object({ taskId, agent: z.string().trim().max(200).nullable() });
export const ContinueBudgetInput = z.object({ taskId, addCredits: z.number().positive().max(10_000) });
export const SaveProfileInput = z.object({
  id: z.string().min(1).max(100).optional(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u, "Use letters, digits, spaces, dots, dashes or underscores"),
  description: z.string().trim().max(300).optional(),
  model: modelId,
  reasoningEffort: effort.optional(),
  agent: z.string().trim().max(200).nullable().optional(),
  mode: taskMode,
  instructions: z.string().trim().max(4_000).optional(),
  budgetCredits: z.number().positive().max(10_000).nullable().optional(),
});
export const ProfileIdInput = z.object({ profileId: z.string().min(1).max(100) });
export const SetProfilePolicyInput = z.object({ policy: z.enum(["me", "aria", "ask"]) });

export const DecidePermissionInput = z.object({
  taskId,
  permissionId: itemId,
  decision: z.enum(["once", "task", "always", "reject"]),
  note: z.string().trim().max(2_000).optional(),
});
export const ReviewPlanInput = z.object({
  taskId,
  planId: itemId,
  decision: z.enum(["autopilot", "interactive", "revise", "cancel"]),
  feedback: z.string().trim().max(5_000).optional(),
});
/** A message straight to a task (reply-to): what it does depends on what the task is waiting for (PLAN.md §4.5). */
export const ReplyInput = z.object({
  taskId,
  /** The card's pending item, if it was a question, permission or plan card. */
  item: z.object({ kind: z.enum(["question", "permission", "plan"]), id: itemId }).optional(),
  text: z.string().trim().min(1).max(20_000),
});
export const ProposalInput = z.object({
  cardId: itemId,
  profileId: z.string().min(1).max(100).optional(),
  agent: z.string().trim().max(200).nullable().optional(),
});
export const RevokeGrantInput = z.object({ taskId, grantId: z.string().min(1).max(100) });
export const SetAttentionInput = z.object({
  focusMode: z.boolean().optional(),
  awayMinutes: z.number().int().min(1).max(1440).nullable().optional(),
  startAtLogin: z.boolean().optional(),
  startMinimized: z.boolean().optional(),
  quickPromptHotkey: z.boolean().optional(),
  spokenAnnouncements: z.enum(["off", "blocking", "all"]).optional(),
  ttsProvider: z.enum(["system", "cloud"]).optional(),
  ttsVoice: z.string().trim().max(200).optional(),
  ttsRate: z.number().min(0.5).max(2.0).optional(),
  sttProvider: z.enum(["whisper.cpp", "cloud"]).optional(),
  whisperExecutablePath: z.string().trim().max(1_000).optional(),
  whisperModelPath: z.string().trim().max(1_000).optional(),
  voiceCloudEndpoint: z.string().trim().max(500).optional(),
  sttCloudModel: z.string().trim().max(200).optional(),
  ttsCloudModel: z.string().trim().max(200).optional(),
  phonePushProvider: z.enum(["off", "ntfy", "pushover"]).optional(),
  phonePushScope: z.enum(["blocking", "all"]).optional(),
  ntfyServerUrl: z.string().trim().max(500).optional(),
  ntfyTopic: z.string().trim().max(200).optional(),
  pushoverDevice: z.string().trim().max(100).optional(),
  telegramEnabled: z.boolean().optional(),
  telegramChatId: z.string().trim().max(64).optional(),
  telegramOutboundScope: z.enum(["blocking", "all"]).optional(),
  telegramPollSeconds: z.number().int().min(1).max(60).optional(),
  outlookWatchEnabled: z.boolean().optional(),
  outlookPollMinutes: z.number().int().min(1).max(60).optional(),
  outlookTriageMode: z.enum(["rules_and_utility", "rules_only"]).optional(),
  outlookVipSenders: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  outlookIgnoreSenders: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
});
export const SetPhonePushSecretsInput = z.object({
  ntfyToken: z.string().max(500).nullable().optional(),
  pushoverAppToken: z.string().max(200).nullable().optional(),
  pushoverUserKey: z.string().max(200).nullable().optional(),
});
export const SetTelegramBotTokenInput = z.object({
  botToken: z.string().max(300).nullable(),
});
export const TranscribeAudioInput = z.object({
  audioBase64: z.string().min(1).max(15_000_000),
  mimeType: z.string().trim().min(1).max(100).optional(),
});
export const SynthesizeSpeechInput = z.object({
  text: z.string().trim().min(1).max(500),
});
export const SetVoiceCloudApiKeyInput = z.object({
  apiKey: z.string().max(500).nullable(),
});
/** `turns`: how many of your messages; `reload`: read the session again (when the inspector opens). */
export const ConductorTranscriptInput = z.object({ turns: z.number().int().min(1).max(CONDUCTOR_TRANSCRIPT_MAX_TURNS).optional(), reload: z.boolean().optional() });
/** A page of a task's transcript (`transcriptPage`): the newest steps, the ones before `before`, or a jump's `through`. */
export const TranscriptPageInput = z.object({
  taskId,
  last: z.number().int().min(1).max(1_000).optional(),
  before: z.string().min(1).max(1_000).optional(),
  through: z.string().min(1).max(1_000).optional(),
});

const promptName = z.string().regex(/^(conductor|brief|profile:[\w-]{1,100})$/, "Unknown prompt");
export const PromptNameInput = z.object({ name: promptName });
export const SavePromptInput = z.object({ name: promptName, text: z.string().max(50_000), note: z.string().trim().max(200).optional() });
export const RollbackPromptInput = z.object({ name: promptName, version: z.number().int().positive() });

const ruleScope = z.enum(["everywhere", "sandboxed"]);
const ruleMatch = z.string().trim().min(1).max(200);
export const PolicyRuleInput = z.object({
  id: z.string().min(1).max(100).optional(),
  match: ruleMatch,
  effect: z.enum(["auto", "ask", "never"]),
  note: z.string().trim().max(300).optional(),
  exact: z.boolean().optional(),
  scope: ruleScope.optional(),
});
export const CheckRuleInput = z.object({ match: ruleMatch, effect: z.enum(["auto", "ask", "never"]), exact: z.boolean().optional(), scope: ruleScope.optional() });
/** Saving an "Always allow" offer: its rules as you edited them; the scope comes from the offer. */
export const AcceptOfferInput = z.object({
  taskId,
  offerId: itemId,
  rules: z.array(z.object({ match: ruleMatch, exact: z.boolean() })).min(1).max(10),
  /** You confirmed that it runs past your Never rule. */
  confirmOverride: z.boolean().optional(),
});
/** "Save as memory": the note as you edited it. `from`: the words of yours it came from; `id`: a note you're editing. */
export const SaveMemoryInput = z.object({
  id: itemId.optional(),
  text: z.string().max(2_000),
  scope: z.enum(["global", "project"]),
  repoId: z.number().int().positive().optional(),
  from: z.union([z.object({ chatItemId: itemId }), z.object({ taskId, wordsId: itemId }), z.object({ cardId: itemId })]).optional(),
});
export const MemoryIdInput = z.object({ id: itemId });
const serverName = z.string().min(1).max(200);
/** A rule for one tool and scope; `effect: null` goes back to the default. */
export const SetIntegrationRuleInput = z.object({
  server: serverName,
  wireName: z.string().min(1).max(400),
  scope: z.enum(["aria", "tasks"]),
  effect: z.enum(["auto", "ask", "never"]).nullable(),
});
export const IntegrationServerInput = z.object({ server: serverName });
/** Your rules for a server that's gone (renamed in the CLI) moved to another one. */
export const MoveIntegrationRulesInput = z.object({ from: serverName, to: serverName });

export const ImportCliMcpInput = z.object({
  overwriteAriaEdits: z.boolean().optional(),
});

export const SetMcpKeepInSyncInput = z.object({
  keepInSync: z.boolean(),
});

/**
 * Which task tracker to use (Customize › Integrations): `config` is the id of a config in
 * the trackers folder, `null` for no tracker, left out for the tracker of ARIA's data; `servers` are the tracker's MCP servers,
 * the preferred one first (left out: the config finds its own by name).
 */
export const SetActiveTrackerInput = z.object({
  config: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,31}$/)
    .nullable()
    .optional(),
  servers: z.array(serverName).max(20).optional(),
  /**
   * Only for a switch that `previewTrackerChange` says has another tracker's data to ask about: `true` clears it
   * (after a backup), `false` or left out keeps it, dormant, for when you switch back.
   */
  purge: z.boolean().optional(),
});

export const TestMcpServerInput = z.object({
  server: serverName,
});

const envOrHeaderKey = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_.-]+$/, "Use letters, digits, dots, dashes or underscores for key names");

export const SaveMcpServerInput = z.object({
  name: serverName,
  displayName: z.string().trim().max(200).optional(),
  transport: z.enum(["stdio", "http", "sse"]),
  enabled: z.boolean().optional(),
  tools: z.array(z.string().max(200)).max(500).optional(),
  command: z.string().trim().max(500).optional(),
  args: z.array(z.string().max(1_000)).max(50).optional(),
  cwd: z.string().trim().max(1_000).optional(),
  env: z.record(envOrHeaderKey, z.string().max(2_000)).optional(),
  url: z.string().trim().max(2_000).optional(),
  headers: z.record(envOrHeaderKey, z.string().max(2_000)).optional(),
  timeout: z.number().int().min(1_000).max(300_000).optional(),
  bearerToken: z.string().max(4_000).nullable().optional(),
});

export const RemoveMcpServerInput = z.object({
  server: serverName,
});

export const SetMcpServerTokenInput = z.object({
  server: serverName,
  bearerToken: z.string().max(4_000).nullable(),
});

export const AddMarketplaceInput = z.object({
  source: z.string().trim().min(1).max(1_000),
});

export const RemoveMarketplaceInput = z.object({
  name: z.string().trim().min(1).max(200),
  force: z.boolean().optional(),
});

export const BrowseMarketplaceInput = z.object({
  name: z.string().trim().min(1).max(200),
});

export const RefreshMarketplacesInput = z.object({
  name: z.string().trim().min(1).max(200).optional(),
});

export const InstallPluginInput = z.object({
  source: z.string().trim().min(1).max(1_000),
});

export const UninstallPluginInput = z.object({
  name: z.string().trim().min(1).max(200),
  directSourceId: z.string().trim().max(200).optional(),
});

export const UpdatePluginInput = z.object({
  name: z.string().trim().min(1).max(200).optional(),
});

export const SetPluginEnabledInput = z.object({
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean(),
});

export const SetSkillEnabledInput = z.object({
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean(),
});

export const DirectoryPathInput = z.object({
  path: z.string().trim().min(1).max(1_000),
});
export const RemoveProjectInput = z.object({
  repoId: z.number().int().positive(),
});
export const SavePolicyRulesInput = z.object({ rules: z.array(PolicyRuleInput).max(200) });
const host = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/, "Not a host name");
export const SetSandboxInput = z.object({
  enabled: z.boolean().optional(),
  allowedHosts: z.array(host).max(100).optional(),
  allowedPaths: z.array(z.string().trim().max(1_000)).max(100).optional(),
});
export const WatchIdInput = z.object({ watchId: z.number().int().positive() });
export const SetInboxWatchInput = z.object({ on: z.boolean() });
export const MyWorkInput = z.object({ refresh: z.boolean() });
/** A My work item by its key: the engine looks it up in its own last list (the window can't name a repository). */
export const WatchPullRequestInput = z.object({ key: z.string().min(3).max(220) });
export const WatchDefaultBranchInput = z.object({ repoId: z.number().int().positive() });
export const ProposePrInput = z.object({ taskId: z.string().min(1).max(100) });
const repoName = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);
export const ConfirmPrInput = z.object({
  cardId: itemId,
  revision: z.number().int().nonnegative(),
  title: z.string().max(1_000),
  body: z.string().max(70_000),
  draft: z.boolean(),
  openOn: z.object({ owner: repoName, repo: repoName }),
  workflowsChecked: z.boolean(),
});
export const DismissPrInput = z.object({ cardId: itemId });
export const CardIdInput = z.object({ cardId: itemId });
/**
 * Fix it on a CI card, Address comments on a PR card, Start on ARIA's proposal (item 4). The window names the card;
 * `revision` is the proposal's; `ticked`: D51's extra tick for a review from outside the repository's people.
 */
export const FixInput = z.object({ cardId: itemId, ticked: z.boolean().optional() });
export const StartFixProposalInput = z.object({ cardId: itemId, revision: z.number().int().nonnegative(), ticked: z.boolean().optional() });
export const CiFixProfileInput = z.object({ profileId: z.string().min(1).max(100).nullable() });
export const ConfirmActionInput = z.object({
  cardId: itemId,
  revision: z.number().int().nonnegative(),
  argsJson: z.string().max(25_000).optional(),
  confirmedDestructive: z.boolean().optional(),
});
export const ConfirmWorkflowDispatchInput = z.object({
  cardId: itemId,
  revision: z.number().int().nonnegative(),
  ref: z.string().trim().min(1).max(250).optional(),
  inputs: z.record(z.string().min(1).max(100), z.string().max(1_000)).optional(),
});
export const SetTaskTrackerInput = z.object({
  taskId,
  trackerTaskId: z.string().trim().max(300).nullable(),
});
export const SaveTimeRuleInput = z.object({
  id: itemId.optional(),
  kind: z.enum(["repo", "branch", "meeting_title", "meeting_organizer", "teams_channel", "mail_subject", "mail_recipient"]),
  repoId: z.number().int().positive().optional(),
  pattern: z.string().max(300),
  matchMode: z.enum(["exact", "contains", "prefix"]).optional(),
  trackerTaskId: z.string().trim().max(300).optional().default(""),
  trackerTaskTitle: z.string().trim().max(200).optional(),
  defaultMinutes: z.number().int().min(15).max(480).nullable().optional(),
  createdFrom: z.enum(["you", "correction"]).optional(),
  enabled: z.boolean().optional(),
});
export const DeleteTimeRuleInput = z.object({ id: itemId });
export const ListActivitiesInput = z.object({
  since: z.number().int().nonnegative().optional(),
  until: z.number().int().nonnegative().optional(),
  repoId: z.number().int().positive().optional(),
  source: z.enum(["github", "git", "aria", "calendar", "teams", "mail", "tracker"]).optional(),
  scanGit: z.boolean().optional(),
});

const hhmm = z
  .string()
  .trim()
  .regex(/^(?:[01]?\d|2[0-3]):[0-5]\d$|^24:00$/, "Expected time in HH:mm format")
  .transform((v) => (/^\d:\d{2}$/.test(v) ? `0${v}` : v));
const clockHhmm = z
  .string()
  .trim()
  .regex(/^(?:[01]?\d|2[0-3]):[0-5]\d$/, "Expected time of day 00:00–23:59")
  .transform((v) => (/^\d:\d{2}$/.test(v) ? `0${v}` : v));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date YYYY-MM-DD");

export const SetTimekeeperSettingsInput = z.object({
  model: z.string().min(1).max(200).optional(),
  reasoningEffort: z.string().min(1).max(20).optional(),
  expectedMinutes: z.number().int().min(60).max(1440).optional(),
  roundingMinutes: z.union([z.literal(1), z.literal(5), z.literal(10), z.literal(15), z.literal(30)]).optional(),
  workStart: hhmm.optional(),
  workEnd: hhmm.optional(),
  timesheetTime: clockHhmm.optional(),
  defaultMailMinutes: z.number().int().min(15).max(480).optional(),
  ownAuthors: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
});
export const PrepareTimesheetInput = z.object({
  date: isoDate.optional(),
});
export const UpdateTimesheetEntryInput = z.object({
  date: isoDate,
  entryId: itemId.optional(),
  addNew: z.boolean().optional(),
  start: hhmm.optional(),
  end: hhmm.optional(),
  minutes: z.number().int().min(15).max(1440).optional(),
  trackerTaskId: z.string().trim().max(300).optional(),
  trackerTaskTitle: z.string().trim().max(200).optional(),
  trackerProjectId: z.string().trim().max(100).optional(),
  trackerCustomerId: z.string().trim().max(100).optional(),
  comment: z.string().trim().max(500),
  sources: z
    .array(
      z.object({
        source: z.enum(["github", "git", "aria", "calendar", "teams", "mail", "tracker"]),
        kind: z
          .enum([
            "task",
            "commit",
            "pr_opened",
            "pr_updated",
            "pr_merged",
            "pr_closed",
            "pr_review",
            "ci_run",
            "meeting",
            "chat",
            "mail",
            "time_log",
            "task_updated",
          ])
          .optional(),
        externalId: z.string().max(300).optional(),
        title: z.string().max(200).optional(),
        repoId: z.number().int().positive().optional(),
        repoName: z.string().max(200).optional(),
        branch: z.string().max(200).optional(),
        organizer: z.string().max(200).optional(),
        topic: z.string().max(200).optional(),
        recipient: z.string().max(200).optional(),
      }),
    )
    .max(20)
    .optional(),
});
export const ConfirmTimesheetEntryInput = z.object({
  date: isoDate,
  entryId: itemId,
});
export const DeleteTimesheetEntryInput = z.object({
  date: isoDate,
  entryId: itemId,
});
export const TimesheetRuleOfferInput = z.object({
  date: isoDate,
  offerId: itemId,
});
export const TimeViewGetInput = z.object({
  date: isoDate.optional(),
});
export const SubmitTimesheetInput = z.object({
  date: isoDate,
  entryIds: z.array(itemId).min(1).max(60).optional(),
});
export const UpdateRegisteredEntryInput = z.object({
  date: isoDate,
  trackerEntryId: z.string().trim().min(1).max(100),
  start: hhmm,
  end: hhmm,
  trackerTaskId: z.string().trim().min(1).max(300),
  trackerTaskTitle: z.string().trim().max(200).optional(),
  trackerProjectId: z.string().trim().max(100).optional(),
  trackerCustomerId: z.string().trim().max(100).optional(),
  comment: z.string().trim().min(1).max(500),
});
export const DeleteRegisteredEntriesInput = z.object({
  date: isoDate,
  trackerEntryIds: z.array(z.string().trim().min(1).max(100)).min(1).max(50),
  confirmed: z.literal(true),
});

// ── Search (Phase 6A, PLAN.md §5.1, §5.2, §10 Phase 6A) ──────────────────────────────────────────────────────────

export type SearchScope = "all" | "transcripts" | "tasks" | "projects";

export interface SearchProjectHit {
  id: number;
  name: string;
  path: string;
  owner?: string;
  repo?: string;
  defaultBranch?: string;
  taskCount: number;
  activeTaskCount: number;
  latestTaskId?: string;
  matchedField: "name" | "path" | "remote" | "branch" | "memory";
  snippet: string;
}

export interface SearchTaskHit {
  taskId: string;
  title: string;
  repoId: number;
  repoName: string;
  state: TaskState;
  branch?: string;
  profileName: string;
  model: string;
  reasoningEffort?: string;
  trackerTaskId?: string;
  prNumber?: number;
  updatedAt: number;
  matchedField: "title" | "brief" | "summary" | "branch" | "error" | "question" | "permission" | "plan" | "budget" | "tracker" | "pr";
  snippet: string;
  /** The newest card in the timeline for this task, when present. */
  cardId?: string;
}

export interface SearchTranscriptHit {
  /** Set for a worker task's session; undefined for ARIA's own Conductor conversation. */
  taskId?: string;
  sessionTitle: string;
  repoId?: number;
  repoName?: string;
  taskState?: TaskState;
  entryId: string;
  entryKind: TranscriptEntry["kind"];
  toolName?: string;
  at: number;
  snippet: string;
  /** Card ID in the chat timeline (for a task, its newest card; for a Conductor chat turn, the ChatItem ID). */
  cardId?: string;
}

export interface SearchMemoryHit {
  id: string;
  scope: MemoryScope;
  repoId?: number;
  repoName?: string;
  text: string;
  updatedAt: number;
}

export interface SearchResults {
  query: string;
  projects: SearchProjectHit[];
  tasks: SearchTaskHit[];
  transcripts: SearchTranscriptHit[];
  memories: SearchMemoryHit[];
  counts: {
    projects: number;
    tasks: number;
    transcripts: number;
    memories: number;
    total: number;
  };
}

export const SearchQueryInput = z.object({
  query: z.string().max(500),
  scope: z.enum(["all", "transcripts", "tasks", "projects"]).optional(),
  repoId: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

// ── Automations, Reminders, Morning Brief and Utility Model (Phase 6B, PLAN.md §4.12, §4.14, §5.2, §5.4, §10 Phase 6B)

export type RoutineKind = "morning_brief" | "daily_timesheet" | "weekly_time_overview" | "prompt";
export type RoutineStatus = "idle" | "running" | "ok" | "error";

export interface Routine {
  id: string;
  name: string;
  kind: RoutineKind;
  cron: string;
  /** Prompt sent to ARIA when `kind === "prompt"`. */
  prompt?: string;
  enabled: boolean;
  /** For `morning_brief`: also trigger on the first open of a new workday (after 05:00 local time). */
  runOnFirstOpen?: boolean;
  createdBy: "builtin" | "you" | "aria";
  nextRunAt?: number;
  lastRunAt?: number;
  lastRunDate?: string;
  lastStatus?: RoutineStatus;
  lastResult?: string;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export type ReminderStatus = "scheduled" | "snoozed" | "fired" | "done";

export interface Reminder {
  id: string;
  /** R-1, R-2… persisted in SQLite. */
  shortId: string;
  text: string;
  dueAt: number;
  status: ReminderStatus;
  snoozedCount: number;
  cardId?: string;
  createdBy: "you" | "aria";
  createdAt: number;
  updatedAt: number;
}

export interface ReminderCardPayload {
  reminderId: string;
  shortId: string;
  text: string;
  dueAt: number;
  firedAt: number;
  status: "fired" | "snoozed" | "done";
  snoozedUntil?: number;
  snoozedCount: number;
}

export interface MorningBriefUnregisteredDay {
  date: string;
  dateLabel: string;
  registeredMinutes: number;
  draftMinutes: number;
  expectedMinutes: number;
  missingMinutes: number;
}

export interface MorningBriefTaskLine {
  taskId: string;
  title: string;
  repoName: string;
  kind: "needs_you" | "done" | "failed" | "running";
  detail: string;
  cardId?: string;
}

export interface MorningBriefGitHubLine {
  cardId: string;
  repoName: string;
  title: string;
  detail: string;
}

export interface MorningBriefCardPayload {
  variant: "morning_brief" | "weekly_time_overview";
  date: string;
  dateLabel: string;
  headline: string;
  /** Optional prose summary written by the Utility model when enabled in Customize › Models (§4.12). */
  aiSummary?: string;
  aiModel?: string;
  unregisteredDays: MorningBriefUnregisteredDay[];
  /** All 5 weekdays (Mon–Fri) for `weekly_time_overview`. */
  weekDays?: MorningBriefUnregisteredDay[];
  tasks: MorningBriefTaskLine[];
  github: MorningBriefGitHubLine[];
  reminders: Array<{ reminderId: string; shortId: string; text: string; dueAt: number }>;
  generatedAt: number;
}

export interface UtilitySettings {
  enabled: boolean;
  model?: string;
  reasoningEffort?: string;
}

export const SetUtilitySettingsInput = z.object({
  enabled: z.boolean().optional(),
  model: z.string().min(1).max(200).optional(),
  reasoningEffort: z.string().min(1).max(20).optional(),
});

export const SetBudgetSettingsInput = z.object({
  dailyBudgetCredits: z.number().min(0.1).max(100_000).nullable().optional(),
  budgetWarningPercent: z.number().int().min(50).max(99).optional(),
});

export const SetTranscriptRetentionInput = z.object({
  enabled: z.boolean().optional(),
  keepDays: z.number().int().min(1).max(3650).optional(),
});

export const SaveRoutineInput = z.object({
  id: itemId.optional(),
  name: z.string().trim().min(1).max(120),
  cron: z.string().trim().min(5).max(120),
  prompt: z.string().trim().max(4_000).optional(),
  enabled: z.boolean().optional(),
  runOnFirstOpen: z.boolean().optional(),
});

export const ToggleRoutineInput = z.object({
  id: itemId,
  enabled: z.boolean().optional(),
  runOnFirstOpen: z.boolean().optional(),
});

export const RoutineIdInput = z.object({ id: itemId });

export const CreateReminderInput = z.object({
  text: z.string().trim().min(1).max(300),
  inMinutes: z.number().int().min(1).max(43_200).optional(),
  at: z.string().trim().min(4).max(60).optional(),
});

export const SnoozeReminderInput = z.object({
  reminderId: itemId,
  minutes: z.number().int().min(1).max(10_080),
});

export const ReminderIdInput = z.object({ reminderId: itemId });

// ── IPC channels and the API the preload script exposes as `window.aria` ─────────────────────────────────────

export { CHANNELS } from "./channels.ts";

export interface AriaApi {
  /** Everything the window shows, including the model catalog. Later changes arrive as events (`onEvent`). */
  getState(): Promise<AppState>;
  sendMessage(text: string): Promise<void>;
  setConductorModel(input: z.infer<typeof SetConductorModelInput>): Promise<void>;
  /** Tries again after ARIA couldn't connect to the Copilot runtime. How it went arrives as `status` events. */
  reconnect(): Promise<void>;
  /** The updated list arrives as a `projects` event. */
  rescanProjects(): Promise<Project[]>;
  /** Opens a folder picker in the main process; null when cancelled. */
  addProjectFolder(): Promise<Project | null>;
  removeProject(input: z.infer<typeof RemoveProjectInput>): Promise<Project[]>;
  addProjectRoot(input: z.infer<typeof DirectoryPathInput>): Promise<string[]>;
  removeProjectRoot(input: z.infer<typeof DirectoryPathInput>): Promise<string[]>;
  pickProjectRoot(): Promise<string[] | null>;
  /** Opens a file picker in the main process to select files to provide as context. */
  pickFiles?(): Promise<string[]>;
  createProject(input: z.infer<typeof CreateProjectInput>): Promise<Project>;
  cloneProject(url: string): Promise<Project>;
  setUiState(patch: z.infer<typeof UiPatchInput>): Promise<void>;
  openExternal(url: string): Promise<void>;
  onEvent(listener: (event: EngineEvent) => void): () => void;

  // Tasks: the results arrive as `task` events; these resolve when the engine accepted the request.
  startTask(input: z.infer<typeof StartTaskInput>): Promise<Task>;
  messageTask(input: z.infer<typeof MessageTaskInput>): Promise<void>;
  answerQuestion(input: z.infer<typeof AnswerQuestionInput>): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  /**
   * R1: "Ask it to repair" on a Done or PR card. ARIA sends the task the damaged files it counted and how to repair
   * them, in its own words from the task's record: not your words, no memory offer, no paths granted.
   */
  repairEncoding(taskId: string): Promise<void>;
  /** Removes the worktree, the branch and the session (the UI confirms first). */
  discardTask(taskId: string): Promise<void>;
  /** Continues a failed or interrupted task in its session. */
  retryTask(taskId: string): Promise<void>;
  resumeInterrupted(): Promise<void>;
  dismissInterrupted(): Promise<void>;
  continueBudget(input: z.infer<typeof ContinueBudgetInput>): Promise<void>;
  setTaskModel(input: z.infer<typeof SetTaskModelInput>): Promise<void>;
  setTaskAgent(input: z.infer<typeof SetTaskAgentInput>): Promise<Task>;
  /** A page of a task's transcript (P4): its newest steps, or earlier ones as you ask for them. */
  getTranscript(input: z.infer<typeof TranscriptPageInput>): Promise<TranscriptPage>;
  getTaskDiff(taskId: string): Promise<TaskDiff>;
  getTaskFile(taskId: string, path: string): Promise<TaskFile | null>;
  /** The inspector (PLAN.md §5.3): ARIA's session is read once per opening and held until it's released. */
  getConductorTranscript(input: z.infer<typeof ConductorTranscriptInput>): Promise<ConductorTranscript>;
  releaseConductorTranscript(): Promise<void>;
  openInEditor(taskId: string): Promise<void>;

  // Worker profiles (PLAN.md §4.12)
  saveProfile(input: z.infer<typeof SaveProfileInput>): Promise<Profile>;
  deleteProfile(profileId: string): Promise<void>;
  setDefaultProfile(profileId: string): Promise<void>;
  setProfilePolicy(policy: ProfilePolicy): Promise<void>;

  // Phase 3: what tasks wait for, and messages straight to them (PLAN.md §4.5, §4.8)
  decidePermission(input: z.infer<typeof DecidePermissionInput>): Promise<void>;
  reviewPlan(input: z.infer<typeof ReviewPlanInput>): Promise<void>;
  reply(input: z.infer<typeof ReplyInput>): Promise<void>;
  revokeGrant(input: z.infer<typeof RevokeGrantInput>): Promise<void>;
  /** Starts the proposed task, with another profile if you changed it. */
  startProposal(input: z.infer<typeof ProposalInput>): Promise<Task>;
  dismissProposal(input: z.infer<typeof ProposalInput>): Promise<void>;
  /** Clears a card from the chat timeline. */
  dismissCard(input: z.infer<typeof CardIdInput>): Promise<void>;

  // Customize › Permissions
  savePolicyRules(input: z.infer<typeof SavePolicyRulesInput>): Promise<PolicySettings>;
  /** What saving this rule would say (D26), for the form while you type. */
  checkRule(input: z.infer<typeof CheckRuleInput>): Promise<RuleCheck>;
  /** "Always allow this" offers stored on the task, newest first. */
  ruleOffers(taskId: string): Promise<RuleOffer[]>;
  acceptOffer(input: z.infer<typeof AcceptOfferInput>): Promise<PolicySettings>;
  resetPolicyRules(): Promise<PolicySettings>;
  setSandbox(input: z.infer<typeof SetSandboxInput>): Promise<PolicySettings>;

  // Focus mode and the away card (Customize › Notifications, the chat header)
  setAttention(input: z.infer<typeof SetAttentionInput>): Promise<AttentionSettings>;

  // "Save as memory" and Customize › Memory (D23)
  /** Your own words to a task, newest last (the session view offers "Save as memory" on them). */
  yourWords(taskId: string): Promise<YourWords[]>;
  saveMemory(input: z.infer<typeof SaveMemoryInput>): Promise<Memory>;
  deleteMemory(input: z.infer<typeof MemoryIdInput>): Promise<void>;

  // Customize › Integrations (§4.13)
  /** Checks your Copilot CLI setup again (one at a time, not more often than every 30 s). */
  refreshIntegrations(): Promise<IntegrationsState>;
  setIntegrationRule(input: z.infer<typeof SetIntegrationRuleInput>): Promise<IntegrationsState>;
  /** Starts signing in to a server that needs it: main opens the sign-in page; the window only gets its host. */
  signIn(input: z.infer<typeof IntegrationServerInput>): Promise<{ host?: string; connected?: boolean }>;
  cancelSignIn(): Promise<void>;
  moveIntegrationRules(input: z.infer<typeof MoveIntegrationRulesInput>): Promise<IntegrationsState>;
  /** Forgets a server that's gone, its tools and your rules for them. */
  forgetIntegrationServer(input: z.infer<typeof IntegrationServerInput>): Promise<IntegrationsState>;
  // Phase 7A: Native MCP configuration & built-in client test
  importCliMcp(input?: z.infer<typeof ImportCliMcpInput>): Promise<{ state: IntegrationsState; imported: number; updated: number; skipped: number }>;
  setMcpKeepInSync(input: z.infer<typeof SetMcpKeepInSyncInput>): Promise<IntegrationsState>;
  testMcpServer(input: z.infer<typeof TestMcpServerInput>): Promise<IntegrationTestResult>;
  saveMcpServer(input: z.infer<typeof SaveMcpServerInput>): Promise<IntegrationsState>;
  removeMcpServer(input: z.infer<typeof RemoveMcpServerInput>): Promise<IntegrationsState>;
  setMcpServerToken(input: z.infer<typeof SetMcpServerTokenInput>): Promise<IntegrationsState>;
  // Marketplaces, Plugins, Agents & Skills
  addMarketplace(input: z.infer<typeof AddMarketplaceInput>): Promise<{ state: IntegrationsState; name: string }>;
  removeMarketplace(input: z.infer<typeof RemoveMarketplaceInput>): Promise<{ state: IntegrationsState; removed: boolean; dependentPlugins?: string[] }>;
  browseMarketplace(input: z.infer<typeof BrowseMarketplaceInput>): Promise<{ plugins: MarketplaceCatalogPlugin[] }>;
  refreshMarketplaces(input?: z.infer<typeof RefreshMarketplacesInput>): Promise<IntegrationsState>;
  installPlugin(input: z.infer<typeof InstallPluginInput>): Promise<{ state: IntegrationsState; plugin: InstalledPluginItem; skillsInstalled: number; postInstallMessage?: string; deprecationWarning?: string }>;
  uninstallPlugin(input: z.infer<typeof UninstallPluginInput>): Promise<IntegrationsState>;
  updatePlugin(input?: z.infer<typeof UpdatePluginInput>): Promise<{ state: IntegrationsState; updatedCount: number; message?: string }>;
  setPluginEnabled(input: z.infer<typeof SetPluginEnabledInput>): Promise<IntegrationsState>;
  setSkillEnabled(input: z.infer<typeof SetSkillEnabledInput>): Promise<IntegrationsState>;
  addPluginDirectory(input: z.infer<typeof DirectoryPathInput>): Promise<IntegrationsState>;
  removePluginDirectory(input: z.infer<typeof DirectoryPathInput>): Promise<IntegrationsState>;
  addSkillDirectory(input: z.infer<typeof DirectoryPathInput>): Promise<IntegrationsState>;
  removeSkillDirectory(input: z.infer<typeof DirectoryPathInput>): Promise<IntegrationsState>;
  addAgentDirectory(input: z.infer<typeof DirectoryPathInput>): Promise<IntegrationsState>;
  removeAgentDirectory(input: z.infer<typeof DirectoryPathInput>): Promise<IntegrationsState>;
  // The task tracker (Customize › Integrations)
  /** Uses a config of the trackers folder as the task tracker (or none); refused, with why, while the timesheet is busy or the choice can't be used. */
  setActiveTracker(input: z.infer<typeof SetActiveTrackerInput>): Promise<{ ok: true; message: string } | { ok: false; error: string }>;
  /** What choosing it would do: why it is refused, or which of its tools its servers have and what ARIA would call without asking. */
  previewTrackerChange(input: z.infer<typeof SetActiveTrackerInput>): Promise<TrackerChangePreview>;
  /** Picks a config file (main shows the dialog), checks it and copies it into the trackers folder, asking before it replaces one. */
  importTrackerConfig(): Promise<TrackerImportResult>;
  /** Opens the trackers folder in the file manager. */
  openTrackerFolder(): Promise<void>;

  // GitHub watches (PLAN.md §4.6)
  /** Stops a watch (the inbox's too: that turns the inbox switch off). */
  unwatch(watchId: number): Promise<void>;
  /** Asks GitHub CLI for its token again and checks it (Try again). */
  retryGitHub(): Promise<GitHubState>;
  /** The inbox watch waiting after 403s is asked again now (its own Try again). */
  retryInbox(): Promise<void>;
  /** The inbox switch (D37). */
  setInboxWatch(on: boolean): Promise<GitHubState>;
  /** "Use @new for them" on a github_account card: the paused watches go on as the account gh uses now. */
  useGitHubAccount(cardId: string): Promise<void>;
  /** Switches GitHub CLI (`gh auth switch --user …`) for a github_account card and refreshes GitHub access. */
  switchGitHubAccount(cardId: string): Promise<void>;
  /** My work's list (PLAN.md §5.2, D38–D40): `refresh` searches again unless the last search is under a minute old. */
  myWork(input: z.infer<typeof MyWorkInput>): Promise<MyWorkState>;
  /** Watch a pull request from My work, by its item's key, until it's merged. */
  watchPullRequest(input: z.infer<typeof WatchPullRequestInput>): Promise<Watch>;
  /** A project's default-branch CI, on (off is `unwatch` with its watch's id). */
  watchDefaultBranch(input: z.infer<typeof WatchDefaultBranchInput>): Promise<Watch>;

  // Pull requests (PLAN.md §4.3, §4.4, D41–D44): the card shows exactly what's pushed and sent; only confirm does it.
  /** Open PR on a done task: makes (or finds) its PR card. */
  proposePr(input: z.infer<typeof ProposePrInput>): Promise<void>;
  /** Push and open, as the card (at that revision) shows it with your edits. */
  confirmPr(input: z.infer<typeof ConfirmPrInput>): Promise<void>;
  dismissPr(input: z.infer<typeof DismissPrInput>): Promise<void>;
  /** Fix it on a red CI card (item 4, D45–D49, D53). */
  fixCi(input: z.infer<typeof FixInput>): Promise<void>;
  /** Address comments on a review card (item 4, D50, D51). */
  addressReview(input: z.infer<typeof FixInput>): Promise<void>;
  /** Start on ARIA's proposal (D48): it works the target out again first. */
  startFixProposal(input: z.infer<typeof StartFixProposalInput>): Promise<void>;
  dismissFixProposal(input: z.infer<typeof CardIdInput>): Promise<void>;
  /** "Fix it uses" (D47); null: the default profile. */
  setCiFixProfile(input: z.infer<typeof CiFixProfileInput>): Promise<void>;

  // Action-request cards (Phase 5A, PLAN.md §4.3, §4.13, D19, D22)
  confirmAction(input: z.infer<typeof ConfirmActionInput>): Promise<void>;
  cancelAction(input: z.infer<typeof CardIdInput>): Promise<void>;

  // Workflow dispatch cards
  confirmWorkflowDispatch(input: z.infer<typeof ConfirmWorkflowDispatchInput>): Promise<void>;
  dismissWorkflowDispatch(input: z.infer<typeof CardIdInput>): Promise<void>;

  // Work tracking, tracker linking and mapping rules (Phase 5B, PLAN.md §4.14)
  setTaskTracker(input: z.infer<typeof SetTaskTrackerInput>): Promise<Task>;
  listActivities(input: z.infer<typeof ListActivitiesInput>): Promise<Activity[]>;
  saveTimeRule(input: z.infer<typeof SaveTimeRuleInput>): Promise<TimeRule>;
  deleteTimeRule(input: z.infer<typeof DeleteTimeRuleInput>): Promise<void>;

  // Timekeeper and Timesheet draft card (Phase 5C, PLAN.md §4.12, §4.14, §5.4)
  setTimekeeperSettings(input: z.infer<typeof SetTimekeeperSettingsInput>): Promise<TimekeeperSettings>;
  prepareTimesheet(input: z.infer<typeof PrepareTimesheetInput>): Promise<TimesheetCardPayload>;
  updateTimesheetEntry(input: z.infer<typeof UpdateTimesheetEntryInput>): Promise<TimesheetCardPayload>;
  confirmTimesheetEntry(input: z.infer<typeof ConfirmTimesheetEntryInput>): Promise<TimesheetCardPayload>;
  deleteTimesheetEntry(input: z.infer<typeof DeleteTimesheetEntryInput>): Promise<TimesheetCardPayload>;
  acceptTimesheetRuleOffer(input: z.infer<typeof TimesheetRuleOfferInput>): Promise<TimesheetCardPayload>;
  dismissTimesheetRuleOffer(input: z.infer<typeof TimesheetRuleOfferInput>): Promise<TimesheetCardPayload>;

  // Time view and tracker Submit, Update and Delete (Phase 5D, PLAN.md §4.14, §5.2, §5.4, D16)
  getTimeView(input: z.infer<typeof TimeViewGetInput>): Promise<TimeViewState>;
  submitTimesheet(input: z.infer<typeof SubmitTimesheetInput>): Promise<TimeRegisteredCardPayload>;
  updateRegisteredEntry(input: z.infer<typeof UpdateRegisteredEntryInput>): Promise<TimesheetCardPayload>;
  deleteRegisteredEntries(input: z.infer<typeof DeleteRegisteredEntriesInput>): Promise<TimesheetCardPayload>;

  // Search (Phase 6A, PLAN.md §5.2, §10 Phase 6A)
  search(input: z.infer<typeof SearchQueryInput>): Promise<SearchResults>;

  // Automations, Reminders, Morning Brief and Utility Model (Phase 6B, PLAN.md §4.12, §5.2, §5.4, §10 Phase 6B)
  setUtilitySettings(input: z.infer<typeof SetUtilitySettingsInput>): Promise<UtilitySettings>;
  setBudgetSettings(input: z.infer<typeof SetBudgetSettingsInput>): Promise<DailyBudgetState>;
  saveRoutine(input: z.infer<typeof SaveRoutineInput>): Promise<Routine>;
  toggleRoutine(input: z.infer<typeof ToggleRoutineInput>): Promise<Routine>;
  runRoutine(input: z.infer<typeof RoutineIdInput>): Promise<Routine>;
  deleteRoutine(input: z.infer<typeof RoutineIdInput>): Promise<void>;
  createReminder(input: z.infer<typeof CreateReminderInput>): Promise<Reminder>;
  snoozeReminder(input: z.infer<typeof SnoozeReminderInput>): Promise<Reminder>;
  dismissReminder(input: z.infer<typeof ReminderIdInput>): Promise<Reminder>;
  deleteReminder(input: z.infer<typeof ReminderIdInput>): Promise<void>;

  // Voice: spoken announcements & push-to-talk (Phase 6D, PLAN.md §4.7, §5.5, §10 Phase 6D)
  transcribeAudio(input: z.infer<typeof TranscribeAudioInput>): Promise<{ text: string }>;
  synthesizeSpeech(input: z.infer<typeof SynthesizeSpeechInput>): Promise<{ audioBase64: string; mimeType: string }>;
  setVoiceCloudApiKey(input: z.infer<typeof SetVoiceCloudApiKeyInput>): Promise<AttentionSettings>;

  // Phase 8B: Phone push notifications & two-way Telegram relay
  setPhonePushSecrets(input: z.infer<typeof SetPhonePushSecretsInput>): Promise<AttentionSettings>;
  testPhonePush(): Promise<{ ok: boolean; error?: string }>;
  setTelegramBotToken(input: z.infer<typeof SetTelegramBotTokenInput>): Promise<AttentionSettings>;
  testTelegramRelay(): Promise<{ ok: boolean; botUsername?: string; error?: string }>;

  // Customize › Prompts
  listPrompts(): Promise<PromptInfo[]>;
  promptHistory(name: PromptName): Promise<PromptVersion[]>;
  savePrompt(input: z.infer<typeof SavePromptInput>): Promise<PromptInfo>;
  rollbackPrompt(input: z.infer<typeof RollbackPromptInput>): Promise<PromptInfo>;
  resetPrompt(name: PromptName): Promise<PromptInfo>;

  // Customize › Data (D1)
  getDataState(): Promise<DataState>;
  setTranscriptRetention(input: z.infer<typeof SetTranscriptRetentionInput>): Promise<DataState>;
  /** Trims finished tasks' transcripts now, with the days set (also when it's off). */
  cleanUpTranscripts(): Promise<DataState>;

  // Onboarding, Copilot CLI Doctor & Release Notes
  runDoctor(): Promise<DoctorReport>;
  setOnboardingState(input: z.infer<typeof SetOnboardingStateInput>): Promise<OnboardingState>;
  /**
   * Update now (D80): downloads the available update's installer, checks its size and SHA-256, and restarts ARIA into
   * it. It takes nothing: what is downloaded is the release the engine found, never something the window names.
   */
  installUpdate(): Promise<void>;
  /** Later (D80): hides the update bar for the available version for a day. */
  snoozeUpdate(): Promise<OnboardingState>;
  openCliTerminal(input: z.infer<typeof OpenCliTerminalInput>): Promise<{ launched: boolean; error?: string }>;
  openLogsFolder(): Promise<void>;
}

export const SetOnboardingStateInput = z.object({
  setupCompleted: z.boolean().optional(),
  tourCompleted: z.boolean().optional(),
  lastSeenVersion: z.string().trim().min(1).max(50).optional(),
  dismissedWhatsNewVersion: z.string().trim().min(1).max(50).optional(),
  dismissedAvailableUpdateVersion: z.string().trim().min(1).max(50).optional(),
});

export const OpenCliTerminalInput = z.object({
  target: z.enum(["copilot", "gh_login"]),
});
