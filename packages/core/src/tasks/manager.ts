/**
 * The task manager (PLAN.md §4.4): background tasks, each one worker session in its own git worktree, at most a few at
 * a time. It owns the state machine the cards, the sidebar and the Conductor's tools read:
 *
 *   queued → starting → running ⇄ waiting_input / waiting_permission / waiting_plan → done (needs review) | failed | cancelled
 *                          ↓ budget reached
 *                    waiting_budget (its slot is freed; Continue queues it again, first in line)
 *   interrupted: ARIA closed or the runtime stopped while it ran (Resume continues it in the same session).
 *
 * A task waiting for you (a question, a permission request, a plan) keeps its slot, so answering it never takes ARIA
 * over the limit. What it waits for lives in memory only, with short ids (Q-n, P-n, L-n, B-n) you and ARIA use in
 * the chat; the runtime doesn't keep pending requests across a restart either.
 *
 * "Done" is ARIA's own call (Phase 0: task_complete only comes in autopilot and its `success` can't be trusted): the
 * root session has gone idle and stayed quiet, then the worktree is checked for commits and changes.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CardItem,
  EncodingDamage,
  EngineEvent,
  PendingPermission,
  PendingPlan,
  PendingQuestion,
  PermissionDecision,
  PermissionKind,
  PlanDecision,
  PolicyRule,
  Profile,
  Project,
  RuleOffer,
  SandboxPermission,
  Task,
  TaskDiff,
  TaskFile,
  TaskGrant,
  TaskLocation,
  TaskMode,
  TaskPr,
  TaskState,
  TranscriptEntry,
  YourWords,
} from "@aria/protocol";
import { encodingDamageText } from "@aria/protocol";
import { GIT_COMMANDS, readGhAliases } from "../policy/aliases.ts";
import { parseCommand } from "../policy/command.ts";
import { ruleOffer } from "../policy/offers.ts";
import { sanitizeAllowedPaths } from "../policy/sandbox.ts";
import { decideWorker, type PolicyDecision, type PermissionRequestDetails, type WorkerPolicyContext } from "../policy/worker.ts";
import { commandParts } from "./policy.ts";
import type {
  AgentRuntime,
  PermissionAsk,
  PermissionVerdict,
  PolicyDecider,
  RuntimeModel,
  WorkerAnswer,
  WorkerEvent,
  WorkerHandle,
  WorkerPlan,
  WorkerPlanDecision,
  WorkerQuestion,
  WorkerSandbox,
} from "../runtime/types.ts";
import type { AttentionEvent, WaitingItem } from "../attention/attention.ts";
import type { RuntimeMcpServerConfig } from "../integrations/config.ts";
import type { McpRule } from "../integrations/rules.ts";
import { isPrunedStep, type Store, type TaskRecord } from "../store/store.ts";
import type { TaskTracker } from "../trackers/types.ts";
import { renderBrief, titleFrom } from "./brief.ts";
import { adoptWorktree, checkedOutBranch, createWorktree, currentBranch, deleteAriaBranch, diff, diffStat, encodingDamage, gitAliases, gitExternals, pushSettings, readWorktreeFile, removeWorktree, slugify, type DiffStat } from "./worktrees.ts";
import { ignoreCleanupFailure, onlyWaitedFor } from "../util/ignore.ts";
import { sanitizeSessionName } from "../util/session-name.ts";

/** States in which the task's session works on a turn, or waits inside it for you; each holds a concurrency slot. */
const ACTIVE: ReadonlySet<TaskState> = new Set(["starting", "running", "waiting_input", "waiting_permission", "waiting_plan"]);
/** In a turn: running, or waiting inside it for you. */
const IN_TURN: ReadonlySet<TaskState> = new Set(["running", "waiting_input", "waiting_permission", "waiting_plan"]);
const inTurn = (state: TaskState | undefined) => state !== undefined && IN_TURN.has(state);
/** How long stopping waits for worktrees and sessions that are still being set up. */
const STOP_WAIT_MS = 10_000;
/** How long a step on a task's session (a run, an abort, a cleanup) waits for the one before it. */
const CHAIN_WAIT_MS = 60_000;
/** How long a cancel, discard or cleanup waits for one session call (abort, disconnect, delete) before going on. */
const CALL_WAIT_MS = 10_000;
const CANCELLED_ANSWER = "The user cancelled this task. Stop working on it.";
const BUDGET_ANSWER = "The task was paused because it reached its AI credit budget.";
const STOPPED_ANSWER = "The task stopped.";
const LOST_SESSION =
  "Your earlier session for this task is gone, so here is the task again. Your earlier work may already be in this worktree: check its current state and git log first, then continue.";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The id of the line that says a task's transcript was cleaned up (D1): the same each time, so a reload keeps it in place. */
export const PRUNED_NOTE_ID = "aria-transcript-pruned";

/**
 * A cleaned-up task's saved steps (D1), with a line where the clean-up was: after its older steps, before any from a
 * later run. Only for the database copy: a session that can still be opened shows everything.
 */
export function withPrunedNote(entries: TranscriptEntry[], prunedAt: number): TranscriptEntry[] {
  const day = new Date(prunedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const note: TranscriptEntry = {
    kind: "info",
    id: PRUNED_NOTE_ID,
    at: prunedAt,
    level: "info",
    text: `Its tool calls, permission lines and reasoning from before ${day} were cleaned up to keep the database small (Customize › Data).`,
  };
  // Never before the first step: that's the brief, which the session view pins at the top.
  const at = entries.findIndex((entry, i) => i > 0 && entry.at >= prunedAt);
  return at < 0 ? [...entries, note] : [...entries.slice(0, at), note, ...entries.slice(at)];
}
const NO_CHANGES: DiffStat = { commits: 0, filesChanged: 0, additions: 0, deletions: 0, uncommitted: 0 };
/** Quoted text in a digest line stays short. */
const clip = (text: string, max = 200) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
/** "Always allow this" offers and your words kept per task. */
const OFFERS_KEPT = 30;
const YOURS_KEPT = 50;
/** Ends with exactly one full stop. */
const period = (text: string) => `${text.trim().replace(/[.\s]+$/, "")}.`;

/**
 * What a shell command's hard rules need to know beyond its text: when it runs a git command that isn't one of git's
 * own, git's aliases and the `git-<name>` programs on PATH (git runs those before an alias); the branch checked out and
 * git's push settings where a push (or such a command) runs; and gh's aliases when it runs gh.
 */
async function aliasesFor(
  ask: Extract<PermissionAsk, { kind: "shell" }>,
  worktree: string,
): Promise<Pick<WorkerPolicyContext, "gitAliases" | "gitExternals" | "ghAliases" | "checkedOut" | "pushSettings">> {
  const parsed = commandParts(ask).flatMap((part) => {
    const command = parseCommand(part);
    return [command, command?.withEmpty];
  });
  const where = ask.cwd ?? worktree;
  const unknownGit = parsed.some((p) => p?.program === "git" && p.words[0] !== undefined && !GIT_COMMANDS.has(p.words[0]));
  const pushing = unknownGit || parsed.some((p) => p?.program === "git" && p.words[0] === "push");
  const gh = parsed.some((p) => p?.program === "gh");
  const [aliases, externals, branch, settings] = await Promise.all([
    unknownGit ? gitAliases(where) : undefined,
    unknownGit ? gitExternals(where).then((read) => read ?? null) : undefined,
    pushing ? checkedOutBranch(where) : undefined,
    pushing ? pushSettings(where).then((read) => read ?? null) : undefined,
  ]);
  return {
    ...(aliases ? { gitAliases: aliases } : {}),
    ...(externals !== undefined ? { gitExternals: externals } : {}),
    ...(branch ? { checkedOut: branch } : {}),
    ...(settings !== undefined ? { pushSettings: settings } : {}),
    ...(gh ? { ghAliases: readGhAliases() } : {}),
  };
}

/** What a task with an open PR is told when it continues (item 3, the duck's point 8). */
export const PR_NOTE = "This branch has an open pull request: add commits, don't rewrite its history (no rebase, amend, reset or force push).";

/** It worked in a worktree that was removed since (cleanup), so its session has nowhere to continue. */
const cleanedUp = (record: TaskRecord) => Boolean(record.where !== "cloud" && record.briefSent && !record.worktreePath);

/** What a permission request wants to do, as a verb ("wants to open https://…"). */
export const PERMISSION_VERBS: Record<PermissionKind, string> = { shell: "run", write: "write", read: "read", url: "open", mcp: "use", other: "use" };

/** Its @mention name: the branch without `aria/`, or what the branch will be called. */
const taskSlug = (record: Pick<TaskRecord, "branch" | "title">) => record.branch?.replace(/^aria\//, "") || slugify(record.title);

function assertCanContinue(record: TaskRecord): void {
  if (record.adoptedBy) throw new Error("Another task took over this task's branch (Fix it), so it can't continue: continue that one.");
  if (cleanedUp(record)) throw new Error("This task's worktree was cleaned up, so it can't continue.");
}

/** An outbox entry's text as the worker gets it: ARIA's (or your) words, then the fenced untrusted part, if any. */
const outboxText = (entry: { text: string; untrusted?: string }) => (entry.untrusted ? `${entry.text}\n\n${entry.untrusted}` : entry.text);

/**
 * What became of a message: delivered to the running session, waiting for the task to start, continuing a finished
 * task, or held until you raise the budget of a task paused at it.
 */
export type MessageOutcome = "sent" | "queued" | "continuing" | "held";

/** Something a task waits for, as ARIA sees it in its `<pending>` digest. */
export interface PendingItem {
  shortId: string;
  kind: "question" | "permission" | "plan" | "budget";
  taskId: string;
  title: string;
  repoName: string;
  text: string;
}

export interface TaskManagerDeps {
  /** The task tracker a task links to (Phase 5B). */
  tracker: () => TaskTracker;
  db: () => Store;
  runtime: AgentRuntime;
  models: () => RuntimeModel[];
  profileInstructions: (profileId: string | undefined) => string | undefined;
  /** Where new worktrees go (resolved when the first task starts). */
  worktreeRoot: () => string;
  /**
   * Tasks' tool scope now (Customize › Integrations): what a session gets when it opens, and `mcp`, your rule for an
   * MCP tool by its server and wire name, read on every request (a tool you turn off is refused at once).
   */
  workerScope: () => {
    availableTools: string[];
    disabledMcpServers: string[];
    readTools: string[];
    mcpServers?: Record<string, RuntimeMcpServerConfig>;
    pluginDirectories?: string[];
    skillDirectories?: string[];
    agentDirectories?: string[];
    disabledSkills?: string[];
    readonlyRoots?: string[];
    mcp?: (server: string, wireName: string) => McpRule | undefined;
  };
  /** Your permission rules (Customize › Permissions). */
  policyRules: () => readonly PolicyRule[];
  /** The sandbox for a task's session (D20), or undefined when it runs without one; throws when it should and can't. */
  sandboxFor: (task: { repoPath: string; worktreePath: string; sessionDir?: string; allowedPaths?: string[]; nonGit?: boolean }) => Promise<WorkerSandbox | undefined>;
  /** Global allowed paths configured in sandbox settings. */
  allowedSandboxPaths?: () => readonly string[];
  /** Local roots that sandbox cards must never make readable. */
  protectedSandboxPaths?: () => readonly string[];
  /** Saves a narrow, user-confirmed sandbox path or host exception. */
  persistSandboxException?: (exception: SandboxPermission) => void;
  /** The brief template (Customize › Prompts). */
  briefTemplate: () => string;
  /** The {{memory}} block for a project's briefs: your notes for it and the global ones (D23). */
  memoryFor?: (repoId: number) => string;
  /** A line for ARIA's next `<updates>` digest (PLAN.md §4.3). */
  digest: (line: string) => void;
  emit: (event: EngineEvent) => void;
  /** What needs your attention: a toast, maybe, and the "while you were away" card (attention/attention.ts). */
  attention: (event: AttentionEvent) => void;
  addCard: (card: CardItem) => void;
  /** Removes superseded cards of the given types for `taskId` from the chat timeline. */
  removeCardsForTask?: (taskId: string, ...cardTypes: CardItem["cardType"][]) => void;
  notice: (level: "info" | "warning" | "error", text: string, cause?: string, taskId?: string) => void;
  /** For what's worth tracing afterwards, but not worth interrupting you. */
  log?: (line: string) => void;
  maxConcurrent?: number;
  /** How long a finished turn must stay quiet before the task counts as done. */
  settleMs?: number;
  /** How long an autopilot task that went idle without saying it finished waits before it counts as stopped. */
  autopilotGraceMs?: number;
  /** How long stopping waits for work in progress and for sessions to detach. */
  stopWaitMs?: number;
  /** Tests: how long a step on a session waits for the one before it, and for one session call. */
  sessionWaitMs?: number;
  /** Phase 8A: Timeout in ms waiting for `session.start` (`producer === "copilot-agent"`) on cloud tasks (default 60_000). */
  cloudStartTimeoutMs?: number;
  /** Phase 5B: records or updates a task's execution stretch in `activities`. */
  onActivity?: (record: TaskRecord, stretch: number, stretchStartedAt: number, stretchEndedAt?: number) => void;
  /** Phase 5B: updates all `aria` activities of `taskId` when its `trackerTaskId` is manually linked or cleared. */
  onTrackerLink?: (taskId: string, trackerTaskId: string | undefined) => void;
  /** Phase 9: Percentage of a task's budget at which a one-time warning notice is emitted (default 80). */
  budgetWarningPercent?: () => number;
  /** Phase 9: Reports AI credit usage deltas (in nano-AIU) for daily budget tracking across all tasks. */
  onUsageDelta?: (nanoAiu: number, task: TaskRecord) => void;
}

export interface StartTaskOptions {
  project: Project;
  brief: string;
  title?: string;
  profile: Profile;
  profileNote?: string;
  agent?: string;
  mode?: TaskMode;
  baseBranch?: string;
  /** Optional tracker task ID or task URL linked to this task (Phase 5B, PLAN.md §4.14). */
  trackerTaskId?: string;
  startedBy: "aria" | "you";
  /** Item 4: start from this commit of `baseBranch` (the commit a red CI run ran on), not its tip. */
  baseCommit?: string;
  /**
   * Item 4: someone else's text for the worker (a CI log, a review), fenced (tasks/untrusted.ts), sent after the
   * rendered brief. Kept apart from `brief`: never in ARIA's views, never "your words".
   */
  untrusted?: string;
  fromText?: "ci_log" | "review";
  fixing?: { kind: "ci" | "review"; cardId: string; label: string };
  /** D46: take over this task's branch (a new worktree on it, its PR), instead of a new branch. */
  adopt?: string;
  /** Phase 6C ("Rerun with…"): ID of the root task this task was rerun from. */
  rerunOf?: string;
  /** Phase 8A: Where the task runs ("local" default, or "cloud" on Mission Control). */
  where?: TaskLocation;
  /** Phase 8A: Share a local task's session to GitHub web and mobile through Mission Control. */
  remote?: boolean;
  /** Local directories or files outside the repository this task is allowed to read. */
  allowedPaths?: string[];
  /** Extra context provided by the user when starting the session. */
  extraContext?: string;
  /** Files provided or attached as context when starting the session. */
  files?: string[];
}

interface OpenPermission {
  pending: PendingPermission;
  cardId: string;
  request: PermissionRequestDetails;
  /** Its "Always allow this" offer, if there is one. */
  offerId?: string;
  resolve: (verdict: PermissionVerdict) => void;
}

interface Live {
  handle?: WorkerHandle;
  /** While the worktree or session is being set up, so cancel and reading can wait for it. */
  opening?: Promise<WorkerHandle | undefined>;
  question?: { pending: PendingQuestion; cardId: string; resolve: (answer: WorkerAnswer) => void };
  /** Permission requests waiting for you, in the order they came (a worker can make several at once). */
  permissions: Map<string, OpenPermission>;
  /** A plan waiting for your approval. `fromIdle`: captured when a plan-mode turn went idle without calling `exit_plan_mode`. */
  plan?: { pending: PendingPlan; cardId: string; fromIdle?: boolean; resolve: (decision: WorkerPlanDecision) => void };
  /** B-n while it's paused at its budget, and its card (unknown after a restart). */
  budgetShortId?: string;
  budgetCardId?: string;
  settleTimer?: NodeJS.Timeout;
  /** While a settle counts the task's changes (git in its worktree), so stop() can wait for it. */
  settling?: Promise<void>;
  sawTaskComplete: boolean;
  completeSummary?: string;
  lastMessage?: string;
  /** Why the current turn is being aborted, so its idle or error isn't taken for the end of the work. */
  stopping?: "cancel" | "budget";
  /**
   * The current run. Starting a run, cancelling, failing, pausing at the budget and discarding all change it, and a run
   * stops sending as soon as it sees another number: nothing it had queued reaches a session that should be quiet.
   */
  run: number;
  /** The last piece of work that drives the session (a run, an abort, a cleanup); the next one waits for it to end. */
  work?: Promise<void>;
  /** Whether that work can hang (a run or a delivery waits on the runtime), or is bounded (an abort, a cleanup). */
  workKind?: "open-ended" | "bounded";
  /** Counts signs of work (a turn starting, a tool, a message sent), so a settle that began before one doesn't end the task. */
  activity: number;
  /** Messages on their way into the session, by the run they were sent in: the task isn't done while that run has one. */
  deliveries: Array<{ run: number }>;
  /** The session went idle and hasn't started work since (so a settle can be reconsidered). */
  idle?: { autopilot: boolean };
  /**
   * Control calls (an abort, a detach) that didn't answer in time. They target the session by id, so it isn't opened
   * again until they've settled: a late abort or detach would hit the reopened session.
   */
  quarantine?: Promise<void>;
  /** Set while the task is being discarded: nothing may start or continue it anymore. */
  discarding?: Promise<void>;
  /** Whether the open session has the task's history (it was resumed, or it got the brief), else it's a fresh one. */
  history?: boolean;
  /** A model you switched to, so its model_change isn't reported as the runtime's own (D15). */
  switchingTo?: string;
  /** The model the runtime reported while a switch was on its way (D15: it can differ from the one asked for). */
  reported?: string;
  /** A model you picked while the session was opening, applied before it gets any work. */
  wanted?: { model: string; reasoningEffort?: string };
  /** An agent you picked while the session was opening (`null`: default coding agent), applied before it gets any work. */
  wantedAgent?: string | null;
  /** The agent the opening session dropped because it isn't installed (`agent_missing`): it runs as the default. */
  droppedAgent?: string;
}

export class TaskManager {
  private readonly live = new Map<string, Live>();
  private queue: string[] = [];
  /** Set once the runtime is up; until then new tasks wait in the queue. */
  private ready = false;
  private stopped = false;
  /** Counters for the short ids of what tasks wait for; they start over with every start of ARIA. */
  private readonly shortIds: Record<"Q" | "P" | "L" | "B", number> = { Q: 0, P: 0, L: 0, B: 0 };
  /** Branch names taken by tasks whose worktree is being made, before the task records them (lowercase). */
  private readonly claimedSlugs = new Set<string>();
  /**
   * Sessions whose history was checked against what's saved (P4), and whether their task was at work then: from then on
   * their steps are saved as they come, so reading them again (each page, each open) saves nothing. One checked while
   * it worked is checked once more when it's done, for the steps the live view couldn't follow (a tool that started
   * before this handle was listening finishes without a live update).
   */
  private readonly reconciled = new WeakMap<object, { active: boolean }>();
  /** While a task's history is being read: the steps saved live meanwhile, which are newer than what the read gives. */
  private readonly savedWhileReading = new Map<string, Set<Set<string>>>();
  /** The card this start of ARIA showed for the tasks it found interrupted, and those tasks (it lists only them). */
  private interruptedCard: { id: string; taskIds: ReadonlySet<string> } | undefined;

  constructor(private readonly deps: TaskManagerDeps) {}

  private nextShortId(kind: "Q" | "P" | "L" | "B"): string {
    return `${kind}-${++this.shortIds[kind]}`;
  }

  private chainWait(): number {
    return this.deps.sessionWaitMs ?? CHAIN_WAIT_MS;
  }

  private callWait(): number {
    return this.deps.sessionWaitMs ?? CALL_WAIT_MS;
  }

  /**
   * Stops the session's current turn. If the abort doesn't answer in time, this handle is let go and the session is
   * quarantined until the abort (and the detach) settle: both target the session by id, so they'd hit it reopened.
   */
  private async abortTurn(live: Live, handle: WorkerHandle): Promise<void> {
    const abort = handle.abort();
    if (await within(this.callWait(), () => abort)) return;
    if (live.handle === handle) live.handle = undefined;
    this.quarantine(live, abort, handle.disconnect());
  }

  /** Lets go of a session handle: detaches it, quarantining the session if the detach doesn't answer in time. */
  private async release(live: Live, handle: WorkerHandle): Promise<void> {
    if (live.handle === handle) live.handle = undefined;
    const detach = handle.disconnect();
    if (!(await within(this.callWait(), () => detach))) this.quarantine(live, detach);
  }

  private quarantine(live: Live, ...calls: Array<Promise<unknown>>): void {
    live.quarantine = Promise.allSettled([...(live.quarantine ? [live.quarantine] : []), ...calls]).then(() => undefined);
  }

  // ── reading ───────────────────────────────────────────────────────────────────────────────────────────────────

  /** Newest first, without discarded tasks. */
  list(): Task[] {
    return this.deps
      .db()
      .listTasks()
      .reverse()
      .map((r) => this.toTask(r));
  }

  get(id: string): Task | undefined {
    const record = this.deps.db().getTask(id);
    return record && !record.archived ? this.toTask(record) : undefined;
  }

  /** A task by id or (part of) its title; the newest match wins. */
  find(ref: string): Task {
    const records = this.deps.db().listTasks();
    const byId = records.find((r) => r.id === ref);
    if (byId) return this.toTask(byId);
    const query = ref.trim().toLowerCase();
    const exact = records.filter((r) => r.title.toLowerCase() === query);
    const partial = records.filter((r) => r.title.toLowerCase().includes(query));
    const hit = (exact.length ? exact : partial).at(-1);
    if (!hit) throw new Error(`There's no task matching "${ref}".`);
    return this.toTask(hit);
  }

  /**
   * The tasks you could mean by an @mention of this slug: those that can still take a message (their worktree is still
   * there), else whichever has it. New branch names are unique across repositories, so more than one is rare (a task
   * that hasn't started yet goes by its title, which another one's branch may already use).
   */
  bySlug(slug: string): Task[] {
    const key = slug.trim().toLowerCase();
    const matches = this.deps
      .db()
      .listTasks()
      .filter((r) => taskSlug(r).toLowerCase() === key);
    // A task whose branch another took over (D46) goes by that one now: one slug, one live task.
    const current = matches.filter((r) => !r.adoptedBy);
    const pool = current.length > 0 ? current : matches;
    const open = pool.filter((r) => !cleanedUp(r));
    return (open.length > 0 ? open : pool).map((r) => this.toTask(r));
  }

  /**
   * Takes a branch name for a task whose worktree is being made, unless another task has it already (in any repository:
   * an @mention names a task by it). Synchronous, so two tasks being set up at once can't both take the same one.
   */
  private claimSlug(id: string, name: string): boolean {
    const key = name.toLowerCase();
    if (this.claimedSlugs.has(key)) return false;
    if (this.deps.db().listTasks().some((r) => r.id !== id && r.branch !== undefined && taskSlug(r).toLowerCase() === key)) return false;
    this.claimedSlugs.add(key);
    return true;
  }

  /** What tasks wait for right now, oldest first: the `<pending>` part of ARIA's digest. */
  pendingItems(): PendingItem[] {
    const items: Array<PendingItem & { at: number }> = [];
    for (const record of this.deps.db().listTasks()) {
      const live = this.live.get(record.id);
      if (!live) continue;
      const base = { taskId: record.id, title: record.title, repoName: record.repoName };
      const question = live.question?.pending;
      if (question) {
        const choices = question.choices?.length ? ` Choices: ${question.choices.join(", ")}.` : "";
        items.push({ ...base, kind: "question", shortId: question.shortId, at: question.askedAt, text: `asks: "${clip(question.question, 300)}"${choices}` });
      }
      for (const { pending } of live.permissions.values()) {
        items.push({ ...base, kind: "permission", shortId: pending.shortId, at: pending.askedAt, text: `wants to ${PERMISSION_VERBS[pending.kind]} \`${clip(pending.what, 200)}\`: ${clip(pending.reason, 200)}` });
      }
      const plan = live.plan?.pending;
      if (plan) items.push({ ...base, kind: "plan", shortId: plan.shortId, at: plan.askedAt, text: `has a plan ready: ${clip(plan.summary, 300)}` });
      if (record.state === "waiting_budget" && live.budgetShortId) {
        items.push({ ...base, kind: "budget", shortId: live.budgetShortId, at: record.updatedAt, text: `is paused at its budget (${Math.round(record.costNano / 1e7) / 100} of ${record.budgetCredits ?? 0} credits used)` });
      }
    }
    return items.sort((a, b) => a.at - b.at).map(({ at: _at, ...item }) => item);
  }

  /**
   * What waits for you now, oldest first, each with the card it shows on, for the "while you were away" card: what
   * `pendingItems` lists, plus interrupted tasks. Without a card of its own in this start of ARIA (a budget pause or
   * an interruption from before a restart), a line points at the task's own card, which always exists.
   */
  waitingOnYou(): WaitingItem[] {
    const items: WaitingItem[] = [];
    for (const record of this.deps.db().listTasks()) {
      const base = { taskId: record.id, title: record.title, repoName: record.repoName };
      const taskCard = `task-${record.id}`;
      if (record.state === "interrupted") {
        // This start's card lists only the tasks this start found interrupted; one from an earlier start has its own card.
        const card = this.interruptedCard?.taskIds.has(record.id) ? this.interruptedCard.id : taskCard;
        items.push({ ...base, kind: "interrupted", text: "was interrupted", cardId: card, at: record.updatedAt });
        continue;
      }
      const live = this.live.get(record.id);
      if (!live) continue;
      const question = live.question;
      if (question) items.push({ ...base, kind: "question", itemId: question.pending.id, shortId: question.pending.shortId, text: `asks: ${clip(question.pending.question, 200)}`, cardId: question.cardId, at: question.pending.askedAt });
      for (const { pending, cardId } of live.permissions.values()) {
        items.push({ ...base, kind: "permission", itemId: pending.id, shortId: pending.shortId, text: `wants to ${PERMISSION_VERBS[pending.kind]} ${clip(pending.what, 200)}`, cardId, at: pending.askedAt });
      }
      const plan = live.plan;
      if (plan) items.push({ ...base, kind: "plan", itemId: plan.pending.id, shortId: plan.pending.shortId, text: `has a plan: ${clip(plan.pending.summary, 200)}`, cardId: plan.cardId, at: plan.pending.askedAt });
      if (record.state === "waiting_budget" && live.budgetShortId) {
        items.push({ ...base, kind: "budget", shortId: live.budgetShortId, text: "is paused at its budget", cardId: live.budgetCardId ?? taskCard, at: record.updatedAt });
      }
    }
    return items.sort((a, b) => a.at - b.at);
  }

  private taskRef(record: Pick<TaskRecord, "id" | "title" | "repoName">): { id: string; title: string; repoName: string } {
    return { id: record.id, title: record.title, repoName: record.repoName };
  }

  /** A pending item by its short id (Q-3, p2, L 1): which task, and the item's own id. */
  byShortId(shortId: string): { kind: PendingItem["kind"]; task: Task; itemId: string } | undefined {
    const match = /^\s*([QPLB])\s*-?\s*(\d+)\s*$/i.exec(shortId);
    if (!match) return undefined;
    const wanted = `${match[1]!.toUpperCase()}-${Number(match[2])}`;
    for (const [taskId, live] of this.live) {
      const record = this.deps.db().getTask(taskId);
      if (!record || record.archived) continue;
      if (live.question?.pending.shortId === wanted) return { kind: "question", task: this.toTask(record), itemId: live.question.pending.id };
      for (const { pending } of live.permissions.values()) if (pending.shortId === wanted) return { kind: "permission", task: this.toTask(record), itemId: pending.id };
      if (live.plan?.pending.shortId === wanted) return { kind: "plan", task: this.toTask(record), itemId: live.plan.pending.id };
      if (record.state === "waiting_budget" && live.budgetShortId === wanted) return { kind: "budget", task: this.toTask(record), itemId: wanted };
    }
    return undefined;
  }

  private toTask(record: TaskRecord): Task {
    const {
      baseCommit: _base,
      worktreeRoot: _root,
      sessionId: _session,
      briefSent: _brief,
      outbox: _outbox,
      offers: _offers,
      yours: _yours,
      trackerTaskManual: _trackerManual,
      stretch: _stretch,
      stretchStartedAt: _stretchStarted,
      budgetWarnedAtCredits: _budgetWarned,
      costNano,
      archived: _archived,
      untrustedBrief: _untrusted,
      startFrom: _from,
      adoptBranch: _adopt,
      ...task
    } = record;
    const live = this.live.get(record.id);
    const question = live?.question?.pending;
    const permissions = live && live.permissions.size > 0 ? [...live.permissions.values()].map((p) => p.pending) : undefined;
    const plan = live?.plan?.pending;
    const budgetShortId = record.state === "waiting_budget" ? live?.budgetShortId : undefined;
    return {
      ...task,
      slug: taskSlug(record),
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      costCredits: Math.round(costNano / 1e7) / 100,
      ...(question ? { question } : {}),
      ...(permissions ? { permissions } : {}),
      ...(plan ? { plan } : {}),
      ...(budgetShortId ? { budgetShortId } : {}),
      ...(cleanedUp(record) ? { cleanedUp: true } : {}),
    };
  }

  /** What opening a PR needs of a task (item 3): the task, and its base commit (which isn't in `Task`). */
  forPr(id: string): { task: Task; baseCommit?: string } {
    const record = this.record(id);
    return { task: this.toTask(record), ...(record.baseCommit ? { baseCommit: record.baseCommit } : {}) };
  }

  /** The task's pull request, once opened (no state of its own: Continue and settling leave it as it is). */
  setPr(id: string, pr: TaskPr): void {
    const updated = this.update(id, { pr });
    this.recordStretchActivity(updated);
  }

  /** Sets or clears a task's linked tracker task ID (Phase 5B, PLAN.md §4.14). */
  setTrackerTask(id: string, raw: string | null | undefined): Task {
    this.record(id);
    const trimmed = raw?.trim() ?? "";
    let trackerTaskId: string | undefined;
    if (trimmed !== "") {
      trackerTaskId = this.deps.tracker().parseTaskRef(trimmed);
      if (!trackerTaskId) {
        throw new Error(this.deps.tracker().messages.invalidTaskRef(trimmed));
      }
    }
    const updated = this.update(id, { trackerTaskId, trackerId: trackerTaskId ? this.deps.tracker().id : undefined, trackerTaskManual: true });
    this.deps.onTrackerLink?.(id, trackerTaskId);
    this.recordStretchActivity(updated);
    return this.toTask(updated);
  }

  private recordStretchActivity(record: TaskRecord, stretchEndedAt?: number): void {
    const stretch = record.stretch ?? 1;
    const stretchStartedAt = record.stretchStartedAt ?? record.startedAt ?? record.createdAt;
    this.deps.onActivity?.(record, stretch, stretchStartedAt, stretchEndedAt ?? record.finishedAt ?? Date.now());
  }

  /** Refreshes `endedAt` on the current stretch of any running or waiting task so activity queries reflect live duration. */
  refreshActiveStretches(): void {
    const now = Date.now();
    for (const record of this.deps.db().listTasks()) {
      if (ACTIVE.has(record.state)) {
        this.recordStretchActivity(record, now);
      }
    }
  }

  private record(id: string): TaskRecord {
    const record = this.deps.db().getTask(id);
    if (!record || record.archived) throw new Error("That task doesn't exist anymore.");
    return record;
  }

  /**
   * R1: the damaged text counted when it last finished, cleared as it's taken: a repair is asked for once, though both
   * the Done and the PR card offer it. The next finish counts again.
   */
  takeEncodingDamage(id: string): EncodingDamage | undefined {
    const damage = this.record(id).encodingDamage;
    if (damage) this.update(id, { encodingDamage: undefined });
    return damage;
  }

  /** Puts it back when the repair couldn't be sent, unless a finish since counted again. */
  restoreEncodingDamage(id: string, damage: EncodingDamage): void {
    if (!this.record(id).encodingDamage) this.update(id, { encodingDamage: damage });
  }

  private update(id: string, patch: Partial<TaskRecord>): TaskRecord {
    const next: TaskRecord = { ...this.record(id), ...patch, updatedAt: Date.now() };
    for (const key of Object.keys(patch) as Array<keyof TaskRecord>) if (patch[key] === undefined) delete next[key];
    this.deps.db().saveTask(next);
    this.deps.emit({ type: "task", task: this.toTask(next) });
    return next;
  }

  private liveOf(id: string): Live {
    let live = this.live.get(id);
    if (!live) {
      live = { sawTaskComplete: false, run: 0, activity: 0, deliveries: [], permissions: new Map() };
      this.live.set(id, live);
    }
    return live;
  }

  /**
   * Runs `step` once the task's previous work on its session has ended, so two never overlap. Work that can hang on the
   * runtime (a run, a delivery) is waited for at most a minute, so a call that never answers can't keep a Stop or
   * Discard from happening; bounded work (an abort, a cleanup) always to the end, so a run can't slip past a Stop.
   */
  private chain(live: Live, kind: "open-ended" | "bounded", step: () => Promise<void>): Promise<void> {
    const previous = live.work;
    const wait = !previous ? Promise.resolve() : live.workKind === "bounded" ? previous : within(this.chainWait(), () => previous).then(() => undefined);
    const result = wait.then(step);
    live.work = result.catch(onlyWaitedFor);
    live.workKind = kind;
    return result;
  }

  private assertNotDiscarding(id: string): void {
    if (this.live.get(id)?.discarding) throw new Error("That task is being discarded.");
  }

  /** Adds messages to the task's outbox: at the end, or before the others (`first`). `untrusted`: for the last one. */
  private toOutbox(id: string, texts: string[], first = false, untrusted?: string): void {
    const entries = texts.map((text, i) => ({ id: randomUUID(), text, ...(untrusted && i === texts.length - 1 ? { untrusted } : {}) }));
    const outbox = this.record(id).outbox ?? [];
    this.update(id, { outbox: first ? [...entries, ...outbox] : [...outbox, ...entries] });
  }

  // ── starting and the queue ────────────────────────────────────────────────────────────────────────────────────

  async start(options: StartTaskOptions): Promise<Task> {
    if (this.stopped) throw new Error("ARIA is shutting down.");
    // D46: a task that takes over another's branch (Fix it, when that one can't continue): the same branch, base and PR.
    const from = options.adopt ? this.record(options.adopt) : undefined;
    if (from && (!from.branch?.startsWith("aria/") || !from.baseCommit)) throw new Error("That task has no branch of its own to take over.");
    if (from?.adoptedBy || (from && this.adopting.has(from.id))) throw new Error("Another task took over that task's branch already.");
    if (from && (ACTIVE.has(from.state) || from.state === "queued")) throw new Error("That task is still working: it continues instead.");
    // Claimed now, before anything is awaited (item 4's review, finding 3): two fixes at once can't both adopt it.
    if (from) this.adopting.add(from.id);
    try {
      return await this.startNow(options, from);
    } finally {
      if (from) this.adopting.delete(from.id);
    }
  }

  /** Tasks whose branch a start is taking over right now (cleared once `adoptedBy` is on them, or it failed). */
  private readonly adopting = new Set<string>();

  private async startNow(options: StartTaskOptions, from: TaskRecord | undefined): Promise<Task> {
    const { project, profile } = options;
    const isChat = project.id === 0;
    const isFolder = !isChat && project.kind === "folder";
    const isNonGit = isChat || isFolder;
    const where: TaskLocation = options.where === "cloud" ? "cloud" : "local";
    if (where === "cloud") {
      if (isNonGit) throw new Error(`${project.name} isn't a GitHub git repository, so it can't run in the cloud.`);
      if (from) throw new Error("Cloud tasks cannot adopt a local task's worktree branch.");
      if (!project.owner || !project.repo || (project.host && project.host !== "github.com")) {
        throw new Error(`${project.name} has no GitHub repository (owner/repo), so it can't run in the cloud.`);
      }
    }
    const baseBranch = isNonGit
      ? undefined
      : (from?.baseBranch ?? options.baseBranch ?? project.defaultBranch ?? (where === "cloud" ? "main" : await currentBranch(project.path)));
    if (!isNonGit && !baseBranch) throw new Error(`Couldn't tell which branch to start from in ${project.name}.`);
    const title = options.title?.trim() || titleFrom(options.brief);
    let trackerTaskId: string | undefined;
    let trackerTaskManual: boolean | undefined;
    // Whose the task ID is: the tracker in use's, except one a continued task carries from its own tracker.
    let trackerId: string | undefined;
    if (options.trackerTaskId !== undefined && options.trackerTaskId.trim() !== "") {
      trackerTaskId = this.deps.tracker().parseTaskRef(options.trackerTaskId);
      if (!trackerTaskId) {
        throw new Error(this.deps.tracker().messages.invalidTaskRef(options.trackerTaskId.trim()));
      }
      trackerTaskManual = true;
      trackerId = this.deps.tracker().id;
    } else if (from?.trackerTaskManual) {
      trackerTaskId = from.trackerTaskId;
      trackerTaskManual = true;
      trackerId = trackerTaskId ? (from.trackerId ?? this.deps.tracker().id) : undefined;
    } else if (from?.trackerTaskId) {
      trackerTaskId = from.trackerTaskId;
      trackerId = from.trackerId ?? this.deps.tracker().id;
    } else {
      trackerTaskId = this.deps.tracker().taskRefFromBranch(from?.branch ?? baseBranch) ?? this.deps.tracker().extractTaskRef(title, options.brief);
      trackerId = trackerTaskId ? this.deps.tracker().id : undefined;
    }
    const now = Date.now();
    const agent = options.agent?.trim() || profile.agent?.trim() || from?.agent;
    const resolvedAllowedPaths = sanitizeAllowedPaths([...(options.allowedPaths ?? []), ...(from?.allowedPaths ?? [])]);
    const record: TaskRecord = {
      id: randomUUID(),
      title,
      brief: options.brief.trim(),
      repoId: project.id,
      repoName: project.name,
      repoPath: project.path,
      ...(isChat ? { kind: "chat" as const } : isFolder ? { kind: "folder" as const } : {}),
      ...(baseBranch ? { baseBranch } : {}),
      where,
      ...(where === "cloud"
        ? { cloudRepo: { owner: project.owner!, name: project.repo!, ...(baseBranch ? { branch: baseBranch } : {}) } }
        : {}),
      ...(where === "local" && options.remote ? { remote: true } : {}),
      profileId: profile.id,
      profileName: profile.name,
      model: profile.model,
      ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
      ...(agent ? { agent } : {}),
      ...(options.profileNote ? { profileNote: options.profileNote } : {}),
      ...(trackerTaskId ? { trackerTaskId } : {}),
      ...(trackerTaskId && trackerId ? { trackerId } : {}),
      ...(trackerTaskManual ? { trackerTaskManual: true } : {}),
      ...(resolvedAllowedPaths.length > 0 ? { allowedPaths: resolvedAllowedPaths } : {}),
      ...(options.extraContext?.trim() ? { extraContext: options.extraContext.trim() } : {}),
      ...(options.files?.length ? { files: options.files } : {}),
      stretch: 1,
      stretchStartedAt: now,
      mode: options.mode ?? profile.mode,
      state: "queued",
      ...(profile.budgetCredits ? { budgetCredits: profile.budgetCredits } : {}),
      startedBy: options.startedBy,
      createdAt: now,
      updatedAt: now,
      costNano: 0,
      archived: false,
      ...(options.baseCommit ? { startFrom: options.baseCommit } : {}),
      ...(options.rerunOf ? { rerunOf: options.rerunOf } : {}),
      ...(options.untrusted ? { untrustedBrief: options.untrusted } : {}),
      ...(options.fromText ? { fromText: options.fromText } : {}),
      ...(options.fixing ? { fixing: { ...options.fixing, at: now } } : {}),
      ...(from ? { adoptedFrom: from.id, adoptBranch: from.branch!, branch: from.branch!, baseCommit: from.baseCommit!, ...(from.pr ? { pr: from.pr } : {}), ...(from.fromText && !options.fromText ? { fromText: from.fromText } : {}) } : {}),
    };
    if (from) {
      // The old one can't continue on the branch from here on (a budget-held one stops first: it never resumes).
      if (from.state === "waiting_budget") await this.cancel(from.id);
      this.update(from.id, { adoptedBy: record.id });
    }
    this.deps.db().saveTask(record);
    this.recordStretchActivity(record, now);
    this.deps.emit({ type: "task", task: this.toTask(record) });
    this.deps.addCard({ kind: "card", id: `task-${record.id}`, cardType: "task", payload: { taskId: record.id }, createdAt: now });
    this.deps.attention({ kind: "started", title: `${record.title} started`, body: record.repoName, task: this.taskRef(record), cardId: `task-${record.id}` });
    this.queue.push(record.id);
    this.pump();
    return this.toTask(this.record(record.id));
  }

  private activeLocalCount(): number {
    return this.deps
      .db()
      .listTasks()
      .filter((t) => t.where !== "cloud" && ACTIVE.has(t.state)).length;
  }

  /** Starts queued tasks while there are free slots (cloud tasks don't consume local worktree slots, D71). */
  private pump(): void {
    if (this.stopped || !this.ready) return;
    const max = this.deps.maxConcurrent ?? 3;
    let i = 0;
    while (i < this.queue.length) {
      const id = this.queue[i]!;
      const record = this.deps.db().getTask(id);
      if (!record || record.archived || record.state !== "queued") {
        this.queue.splice(i, 1);
        continue;
      }
      if (record.where === "cloud" || this.activeLocalCount() < max) {
        this.queue.splice(i, 1);
        this.update(id, { state: "starting" });
        this.launch(id);
      } else {
        i++;
      }
    }
  }

  /** Puts a task back in the queue, first in line: it was already started once. */
  private requeue(id: string): void {
    assertCanContinue(this.record(id));
    this.assertNotDiscarding(id);
    this.update(id, { state: "queued", error: undefined, finishedAt: undefined });
    this.queue = [id, ...this.queue.filter((q) => q !== id)];
    this.pump();
  }

  private cancelledOrStopped(id: string): boolean {
    if (this.stopped) return true;
    const record = this.deps.db().getTask(id);
    return !record || record.archived || record.state === "cancelled";
  }

  /** Starts a run of the task, after whatever still drives its session (an earlier run, an abort) has ended. */
  private launch(id: string): void {
    const live = this.liveOf(id);
    const run = ++live.run;
    this.chain(live, "open-ended", () => this.runTask(id, run)).catch((error: unknown) => {
      // runTask handles its own errors; this is for the unexpected, so a task is never left "starting".
      try {
        if (live.run === run && !this.cancelledOrStopped(id)) this.fail(id, `Couldn't start: ${message(error)}`);
      } catch {
        // The task is gone, or ARIA is shutting down.
      }
    });
  }

  /**
   * One run: open the worktree and session if needed, then send the brief (once ever) and the outbox, one message at a
   * time. After every step it checks it's still the current run, so a cancel, failure, budget pause or newer run
   * stops it from sending anything more.
   */
  private async runTask(id: string, run: number): Promise<void> {
    const live = this.liveOf(id);
    const current = () => live.run === run && !live.stopping && !this.cancelledOrStopped(id);
    if (!current()) return;
    let handle: WorkerHandle | undefined;
    try {
      handle = await this.ensureHandle(id, { createWorktree: true });
    } catch (error) {
      if (current()) this.fail(id, `Couldn't start: ${message(error)}`);
      return;
    }
    // Cancelled while it opened: cancel closes the session again once this run has let go of it.
    if (!handle || !current()) return;
    const session = handle;
    const before = this.record(id);
    const now = Date.now();
    const stretch = before.startedAt === undefined ? 1 : (before.stretch ?? 1) + 1;
    const stretchStartedAt = now;
    const record = this.update(id, {
      sessionId: session.sessionId,
      state: "running",
      startedAt: before.startedAt ?? now,
      stretch,
      stretchStartedAt,
      // R1: counted again when this run finishes; a run that fails or is cancelled leaves none behind.
      encodingDamage: undefined,
    });
    this.recordStretchActivity(record, now);
    // A new stretch of work: what the last one reported isn't this one's result.
    live.sawTaskComplete = false;
    live.completeSummary = undefined;
    live.lastMessage = undefined;
    live.idle = undefined;
    const send = async (text: string) => {
      // It's busy again: an earlier idle's settle mustn't end it.
      this.clearSettle(live);
      live.activity++;
      await session.send(text);
    };
    try {
      // The brief once ever; again only when the session it went to is gone (deleted, or lost by the runtime), since
      // a fresh session knows nothing of the task.
      if (!before.briefSent || !live.history) {
        const rendered = renderBrief(record, this.deps.profileInstructions(record.profileId), this.deps.briefTemplate(), this.deps.memoryFor?.(record.repoId) ?? "");
        // Someone else's text (item 4) comes after everything of yours and ARIA's, between its markers.
        const brief = record.untrustedBrief ? `${rendered}\n\n${record.untrustedBrief}` : rendered;
        await send(before.briefSent ? `${LOST_SESSION}\n\n${brief}` : brief);
        live.history = true;
        // Delivered, whatever happened meanwhile: it must never be sent twice.
        this.update(id, { briefSent: true });
      } else if (!before.outbox?.length) {
        await send("Continue the task.");
      }
      for (;;) {
        if (!current()) return;
        const next = this.record(id).outbox?.[0];
        if (!next) return;
        await send(outboxText(next));
        // Delivered: it leaves the outbox wherever it is by now (a Retry may have put a note in front of it).
        const outbox = this.record(id).outbox ?? [];
        if (outbox.some((m) => m.id === next.id)) {
          const rest = outbox.filter((m) => m.id !== next.id);
          this.update(id, { outbox: rest.length > 0 ? rest : undefined });
        }
      }
    } catch (error) {
      if (current()) this.fail(id, `Couldn't reach the task's session: ${message(error)}`);
    }
  }

  /** The task's open session, opening it once (concurrent callers share the same opening). */
  private async ensureHandle(id: string, options: { createWorktree: boolean; worktreeOverride?: string }): Promise<WorkerHandle | undefined> {
    const live = this.liveOf(id);
    if (live.handle) return live.handle;
    if (live.opening) return live.opening;
    const opening = (async () => {
      // An abort or detach that didn't answer still targets this session by id: it's reopened only once they've
      // settled, else they could stop or close it again.
      const quarantine = live.quarantine;
      if (quarantine) {
        if (!(await within(this.chainWait(), () => quarantine))) {
          throw new Error("its session still hasn't answered an earlier stop, so it can't be reopened safely yet. Try again in a moment, or restart ARIA");
        }
        if (live.quarantine === quarantine) live.quarantine = undefined;
      }
      const opened = await this.open(id, options);
      if (!opened) return undefined;
      // Nobody can use it anymore (ARIA is stopping, or the task was discarded while it opened): close it again.
      const record = this.deps.db().getTask(id);
      if (this.stopped || !record || record.archived) {
        await within(this.callWait(), () => opened.handle.disconnect());
        return undefined;
      }
      await this.applyLatestModel(id, opened);
      await this.applyLatestAgent(id, opened);
      live.history = opened.handle.resumed;
      if (!opened.handle.resumed) {
        this.deps.db().markTranscriptBackfilled(`task:${id}`);
      }
      live.handle = opened.handle;
      return opened.handle;
    })();
    live.opening = opening;
    try {
      return await opening;
    } finally {
      if (live.opening === opening) live.opening = undefined;
    }
  }

  /**
   * A model you picked while the session was opening (it opened with the one before), applied before it gets any work;
   * if you pick again meanwhile, that one follows. What the runtime reports wins (D15).
   */
  private async applyLatestModel(id: string, opened: { handle: WorkerHandle; model: string; reasoningEffort?: string }): Promise<void> {
    const live = this.liveOf(id);
    let applied: { model: string; reasoningEffort?: string } = opened;
    for (;;) {
      const wanted = live.wanted;
      if (!wanted || (wanted.model === applied.model && wanted.reasoningEffort === applied.reasoningEffort)) {
        if (live.wanted === wanted) live.wanted = undefined;
        return;
      }
      live.switchingTo = wanted.model;
      live.reported = undefined;
      try {
        await opened.handle.setModel(wanted.model, wanted.reasoningEffort);
      } catch (error) {
        // You picked another model meanwhile: that one is what counts now.
        if (live.wanted !== wanted) continue;
        live.wanted = undefined;
        this.update(id, { model: applied.model, reasoningEffort: applied.reasoningEffort });
        this.deps.notice("warning", `Couldn't switch the task "${this.record(id).title}" to ${wanted.model} (${message(error)}), so it keeps ${applied.model}.`, "model_switch_failed", id);
        return;
      } finally {
        live.switchingTo = undefined;
      }
      const reported = live.reported;
      live.reported = undefined;
      if (reported && reported !== wanted.model) {
        // It runs another model than asked (its model_change already said so, with a warning): that's what it has.
        if (live.wanted === wanted) live.wanted = undefined;
        return;
      }
      applied = wanted;
      this.update(id, { model: wanted.model, reasoningEffort: wanted.reasoningEffort });
    }
  }

  /**
   * An agent you picked while the session was opening, applied before it gets any work; if you pick again meanwhile,
   * that one follows.
   */
  private async applyLatestAgent(id: string, opened: { handle: WorkerHandle; agent?: string }): Promise<void> {
    const live = this.liveOf(id);
    let applied: string | undefined = opened.agent;
    for (;;) {
      const wanted = live.wantedAgent;
      if (wanted === undefined) return;
      const next = wanted ?? undefined;
      if (next === applied) {
        if (live.wantedAgent === wanted) live.wantedAgent = undefined;
        return;
      }
      try {
        await opened.handle.setAgent?.(next ?? null);
      } catch (error) {
        if (live.wantedAgent !== wanted) continue;
        live.wantedAgent = undefined;
        this.update(id, { agent: applied });
        this.deps.notice(
          "warning",
          `Couldn't switch the task "${this.record(id).title}" to ${next ?? "the default coding agent"} (${message(error)}), so it keeps ${applied ?? "the default coding agent"}.`,
          "agent_switch_failed",
          id,
        );
        return;
      }
      if (live.wantedAgent === wanted) live.wantedAgent = undefined;
      applied = next;
      this.update(id, { agent: next });
    }
  }

  /**
   * Opens (creates or resumes) the task's worker session, with its worktree first if needed. Resolves to undefined when
   * the task was cancelled before the session existed.
   */
  private async open(id: string, { createWorktree: makeWorktree, worktreeOverride }: { createWorktree: boolean; worktreeOverride?: string }): Promise<{ handle: WorkerHandle; model: string; reasoningEffort?: string; agent?: string } | undefined> {
    // What an earlier opening that failed dropped says nothing about this one.
    this.liveOf(id).droppedAgent = undefined;
    let record = this.record(id);
    const scope = this.deps.workerScope();
    if (record.where === "cloud") {
      if (this.cancelledOrStopped(id)) return undefined;
      const project = this.deps.db().getRepo(record.repoId);
      const cloudRepo = record.cloudRepo ?? {
        owner: project?.owner ?? "owner",
        name: project?.repo ?? record.repoName,
        ...(record.baseBranch ? { branch: record.baseBranch } : {}),
      };
      const handle = await this.deps.runtime.openWorker({
        sessionId: record.sessionId ?? `aria-cloud-${record.id}`,
        name: sanitizeSessionName(`ARIA · ${record.title}`),
        model: record.model,
        ...(record.reasoningEffort ? { reasoningEffort: record.reasoningEffort } : {}),
        ...(record.agent ? { agent: record.agent } : {}),
        mode: record.mode,
        cloud: { repository: cloudRepo },
        ...(this.deps.cloudStartTimeoutMs !== undefined ? { cloudStartTimeoutMs: this.deps.cloudStartTimeoutMs } : {}),
        ...(record.budgetCredits !== undefined ? { budgetCredits: record.budgetCredits } : {}),
        getBudgetCredits: () => this.deps.db().getTask(id)?.budgetCredits,
        availableTools: scope.availableTools,
        disabledMcpServers: scope.disabledMcpServers,
        ...(scope.mcpServers && Object.keys(scope.mcpServers).length ? { mcpServers: scope.mcpServers } : {}),
        ...(scope.pluginDirectories?.length ? { pluginDirectories: scope.pluginDirectories } : {}),
        ...(scope.skillDirectories?.length ? { skillDirectories: scope.skillDirectories } : {}),
        ...(scope.agentDirectories?.length ? { agentDirectories: scope.agentDirectories } : {}),
        ...(scope.disabledSkills?.length ? { disabledSkills: scope.disabledSkills } : {}),
        policy: this.policyFor(id, "/workspaces", true, new Set(scope.readTools), true),
        onQuestion: (question) => this.ask(id, question),
        onPlan: (plan) => this.planReady(id, plan),
        onEvent: (event) => this.onWorkerEvent(id, event),
      });
      return this.opened(id, handle, record);
    }

    const isNonGit = record.kind === "chat" || record.kind === "folder";
    let wtPath = record.worktreePath ?? worktreeOverride;
    if (!wtPath && isNonGit) {
      if (!makeWorktree) return undefined;
      const directPath = record.kind === "chat" ? path.join(record.repoPath, record.id) : record.repoPath;
      if (record.kind === "chat") mkdirSync(directPath, { recursive: true });
      record = this.update(id, { worktreePath: directPath });
      wtPath = record.worktreePath;
      if (this.cancelledOrStopped(id)) return undefined;
    }
    if (!wtPath && record.adoptBranch) {
      if (!makeWorktree) return undefined;
      // D46: a new worktree on the branch it took over. The old task's worktree may still have it checked out (it was
      // held at its budget, and stopped for good): then git is told to allow it.
      const root = this.deps.worktreeRoot();
      const old = record.adoptedFrom ? this.deps.db().getTask(record.adoptedFrom) : undefined;
      const worktree = await adoptWorktree({ repoPath: record.repoPath, root, repoName: record.repoName, branch: record.adoptBranch, force: Boolean(old?.worktreePath && !old.archived) });
      record = this.update(id, { worktreePath: worktree.path, worktreeRoot: root });
      wtPath = record.worktreePath;
      if (this.cancelledOrStopped(id)) return undefined;
    }
    if (!wtPath) {
      if (!makeWorktree) return undefined;
      const root = this.deps.worktreeRoot();
      let claimed: string | undefined;
      let worktree: Awaited<ReturnType<typeof createWorktree>>;
      try {
        worktree = await createWorktree({
          repoPath: record.repoPath,
          root,
          repoName: record.repoName,
          slug: slugify(record.title),
          base: record.baseBranch!,
          ...(record.startFrom ? { baseCommit: record.startFrom } : {}),
          claim: (name) => {
            if (!this.claimSlug(id, name)) return false;
            claimed = name.toLowerCase();
            return true;
          },
        });
        if (this.cancelledOrStopped(id)) {
          // Keep it: the task shows as cancelled with its (empty) worktree, which Discard removes.
          this.update(id, { worktreePath: worktree.path, worktreeRoot: root, branch: worktree.branch, baseCommit: worktree.baseCommit });
          return undefined;
        }
        const fromBranch = !record.trackerTaskId && !record.trackerTaskManual ? this.deps.tracker().taskRefFromBranch(worktree.branch) : undefined;
        record = this.update(id, {
          worktreePath: worktree.path,
          worktreeRoot: root,
          branch: worktree.branch,
          baseCommit: worktree.baseCommit,
          ...(fromBranch ? { trackerTaskId: fromBranch, trackerId: this.deps.tracker().id } : {}),
        });
        wtPath = record.worktreePath;
      } finally {
        // Recorded on the task by now (or never made): the claim has done its job.
        if (claimed) this.claimedSlugs.delete(claimed);
      }
    }
    const sessionId = record.sessionId ?? `aria-task-${record.id}`;
    const sessionDir = path.join(os.homedir(), ".copilot", "session-state", sessionId);
    // The sandbox (D20) is decided per opening: a task that should be sandboxed and can't be doesn't open.
    const sandbox = await this.deps.sandboxFor({
      repoPath: record.repoPath,
      worktreePath: wtPath!,
      sessionDir,
      allowedPaths: record.allowedPaths,
      ...(isNonGit ? { nonGit: true } : {}),
    });
    if (record.sandboxed !== (sandbox !== undefined)) record = this.update(id, { sandboxed: sandbox !== undefined });
    const handle = await this.deps.runtime.openWorker({
      sessionId,
      name: sanitizeSessionName(`ARIA · ${record.title}`),
      model: record.model,
      ...(record.reasoningEffort ? { reasoningEffort: record.reasoningEffort } : {}),
      ...(record.agent ? { agent: record.agent } : {}),
      mode: record.mode,
      workingDirectory: wtPath!,
      ...(record.remote ? { remote: true } : {}),
      ...(record.budgetCredits !== undefined ? { budgetCredits: record.budgetCredits } : {}),
      getBudgetCredits: () => this.deps.db().getTask(id)?.budgetCredits,
      availableTools: scope.availableTools,
      disabledMcpServers: scope.disabledMcpServers,
      ...(scope.mcpServers && Object.keys(scope.mcpServers).length ? { mcpServers: scope.mcpServers } : {}),
      ...(scope.pluginDirectories?.length ? { pluginDirectories: scope.pluginDirectories } : {}),
      ...(scope.skillDirectories?.length ? { skillDirectories: scope.skillDirectories } : {}),
      ...(scope.agentDirectories?.length ? { agentDirectories: scope.agentDirectories } : {}),
      ...(scope.disabledSkills?.length ? { disabledSkills: scope.disabledSkills } : {}),
      policy: this.policyFor(id, wtPath!, sandbox !== undefined, new Set(scope.readTools), false, sessionDir),
      ...(sandbox ? { sandbox } : {}),
      onQuestion: (question) => this.ask(id, question),
      onPlan: (plan) => this.planReady(id, plan),
      onEvent: (event) => this.onWorkerEvent(id, event),
    });
    return this.opened(id, handle, record);
  }

  /**
   * What a session opened with: the model, effort and agent it was asked for, less an agent it dropped because it
   * isn't installed (`agent_missing`), so a pick made while it opened is compared with what it really runs.
   */
  private opened(id: string, handle: WorkerHandle, asked: TaskRecord): { handle: WorkerHandle; model: string; reasoningEffort?: string; agent?: string } {
    const live = this.liveOf(id);
    const agent = asked.agent && asked.agent !== live.droppedAgent ? asked.agent : undefined;
    live.droppedAgent = undefined;
    return { handle, model: asked.model, ...(asked.reasoningEffort ? { reasoningEffort: asked.reasoningEffort } : {}), ...(agent ? { agent } : {}) };
  }

  /**
   * The task's permission handler (PLAN.md §4.8): the policy engine decides, and what it can't decide on its own waits
   * for you on a permission card.
   */
  private policyFor(id: string, worktree: string, sandboxed: boolean, readTools: ReadonlySet<string>, isCloud = false, sessionDir?: string): PolicyDecider {
    const refusal = (run: number): PermissionVerdict | undefined => {
      const record = this.deps.db().getTask(id);
      if (!record || record.archived) return { approve: false, reason: STOPPED_ANSWER };
      // A task that was stopped (or is being stopped) gets nothing more, also nothing that would run on its own: its
      // session can still be finishing a step while its abort is on the way. Nor does a request from a run that ended
      // while it was being looked at, even if the task runs again by now.
      const live = this.liveOf(id);
      const refused = this.cannotAsk(id, live) ?? (live.run !== run ? STOPPED_ANSWER : undefined);
      return refused ? { approve: false, reason: refused } : undefined;
    };
    return {
      decide: async (ask: PermissionAsk) => {
        const run = this.liveOf(id).run;
        const before = refusal(run);
        if (before) return before;
        if (isCloud && (ask.kind === "read" || ask.kind === "write")) {
          const posix = path.posix;
          const normalized = posix.normalize(ask.path.replace(/\\/g, "/"));
          const isContained = (base: string, target: string) =>
            target === base || target.startsWith(base.endsWith("/") ? base : `${base}/`);
          if (
            (!posix.isAbsolute(ask.path) && !normalized.startsWith("../") && !normalized.includes("/../")) ||
            isContained("/workspaces", normalized) ||
            isContained("/home/runner/work", normalized)
          ) {
            return { approve: true };
          }
        }
        // Read when a command needs them, so an alias added meanwhile counts too.
        const aliases = !isCloud && ask.kind === "shell" ? await aliasesFor(ask, worktree) : {};
        const after = refusal(run);
        if (after) return after;
        const record = this.record(id);
        const currentScope = this.deps.workerScope();
        const configuredSandboxPaths = this.deps.allowedSandboxPaths?.() ?? [];
        const taskPaths = record.allowedPaths ?? [];
        const combinedReadonlyRoots = sanitizeAllowedPaths([
          ...(currentScope.readonlyRoots ?? []),
          ...configuredSandboxPaths,
          ...taskPaths,
        ]);
        const context: WorkerPolicyContext = {
          worktree,
          sandboxed,
          ...(sessionDir ? { sessionDir } : {}),
          ...(this.deps.protectedSandboxPaths ? { protectedDirs: this.deps.protectedSandboxPaths() } : {}),
          ...(combinedReadonlyRoots.length ? { readonlyRoots: combinedReadonlyRoots } : {}),
          readTools,
          ...(currentScope.mcp ? { mcp: (server: string, wireName: string) => currentScope.mcp?.(server, wireName) } : {}),
          rules: this.deps.policyRules(),
          grants: record.grants ?? [],
          ...aliases,
          ...this.defaultBranchOf(record),
        };
        const effectiveAsk = isCloud && ask.kind === "shell" && !ask.cwd ? { ...ask, cwd: worktree } : ask;
        const decision = decideWorker(effectiveAsk, context);
        if (decision.effect === "auto") return { approve: true };
        const offerId = this.storeOffer(id, effectiveAsk, context, decision);
        if (decision.effect === "never") return { approve: false, reason: `Not allowed: ${period(decision.reason)} Carry on without it.` };
        return this.requestPermission(id, decision.request, offerId);
      },
    };
  }

  /**
   * "Always allow this" (§5.3): worked out now, with what this decision read (aliases, push settings, your rules), and
   * kept on the task for its card or its refused step. Nothing about it can change the decision itself.
   */
  private storeOffer(id: string, ask: PermissionAsk, context: WorkerPolicyContext, decision: PolicyDecision): string | undefined {
    if (ask.kind !== "shell") return undefined;
    try {
      const result = ruleOffer(ask, context, decision);
      if ("none" in result) return undefined;
      const offer: RuleOffer = {
        id: randomUUID(),
        at: Date.now(),
        command: ask.command.trim(),
        ...(ask.cwd ? { cwd: ask.cwd } : {}),
        ...(ask.toolCallId ? { toolCallId: ask.toolCallId } : {}),
        ...result.offer,
      };
      this.update(id, { offers: [...(this.record(id).offers ?? []), offer].slice(-OFFERS_KEPT) });
      return offer.id;
    } catch {
      return undefined;
    }
  }

  /** The task's "Always allow this" offers, newest first. */
  offers(id: string): RuleOffer[] {
    return [...(this.record(id).offers ?? [])].reverse();
  }

  offer(id: string, offerId: string): RuleOffer {
    const offer = this.record(id).offers?.find((o) => o.id === offerId);
    if (!offer) throw new Error("That suggestion isn't kept anymore: add the rule in Customize › Permissions.");
    return offer;
  }

  /** Your own words to the task (from the window, never from ARIA's tools), kept for "Save as memory". */
  recordYours(id: string, words: Omit<YourWords, "id" | "at">): YourWords {
    const entry: YourWords = { id: randomUUID(), at: Date.now(), ...words, text: words.text.slice(0, 2_000) };
    this.update(id, { yours: [...(this.record(id).yours ?? []), entry].slice(-YOURS_KEPT) });
    return entry;
  }

  yours(id: string): YourWords[] {
    return this.record(id).yours ?? [];
  }

  private defaultBranchOf(record: TaskRecord): { defaultBranch?: string } {
    const branch = this.deps.db().getRepo(record.repoId)?.defaultBranch ?? record.baseBranch;
    return branch ? { defaultBranch: branch } : {};
  }

  // ── what the worker reports ───────────────────────────────────────────────────────────────────────────────────

  private onWorkerEvent(id: string, event: WorkerEvent): void {
    if (this.stopped) return;
    const record = this.deps.db().getTask(id);
    if (!record || record.archived) return;
    const live = this.liveOf(id);
    switch (event.type) {
      case "transcript":
        this.deps.db().queueTranscriptEntries(`task:${id}`, event.entries);
        for (const saved of this.savedWhileReading.get(id) ?? []) for (const entry of event.entries) saved.add(entry.id);
        this.deps.emit({ type: "transcript", taskId: id, entries: event.entries });
        return;
      case "usage": {
        const costNano = record.costNano + event.nanoAiu;
        let budgetWarnedAtCredits = record.budgetWarnedAtCredits;
        const budgetCredits = record.budgetCredits;
        const usedCredits = Math.round(costNano / 1e7) / 100;
        const warnPct = this.deps.budgetWarningPercent?.() ?? 80;
        const warnThreshold = budgetCredits ? (budgetCredits * warnPct) / 100 : undefined;

        const reachedCap = Boolean(budgetCredits && costNano / 1e9 >= budgetCredits);
        const shouldWarn =
          !reachedCap &&
          budgetCredits !== undefined &&
          warnThreshold !== undefined &&
          costNano / 1e9 >= warnThreshold &&
          budgetWarnedAtCredits !== budgetCredits;

        if (shouldWarn) {
          budgetWarnedAtCredits = budgetCredits;
        }

        const updated = this.update(id, {
          costNano,
          ...(budgetWarnedAtCredits !== undefined ? { budgetWarnedAtCredits } : {}),
        });
        this.recordStretchActivity(updated, Date.now());
        this.deps.onUsageDelta?.(event.nanoAiu, updated);

        if (shouldWarn && budgetCredits !== undefined) {
          this.deps.notice(
            "warning",
            `Task "${updated.title}" (${updated.repoName}) has used ${usedCredits} of its ${budgetCredits} AI credit budget (${Math.round((costNano / 1e9 / budgetCredits) * 100)}%).`,
            "budget_warning",
            id,
          );
          this.deps.digest(
            `[budget] "${updated.title}" (${updated.repoName}) reached ${usedCredits} of ${budgetCredits} AI credits (${warnPct}% warning).`,
          );
        }

        // Also while it waits for you: its sub-agents can still be spending.
        if (reachedCap && inTurn(record.state) && !live.stopping) {
          void this.pauseForBudget(id);
        }
        return;
      }
      case "budget_exhausted": {
        const reportedNano = Math.round(event.usedAiCredits * 1e9);
        const nextCostNano = Math.max(record.costNano, reportedNano);
        const deltaNano = Math.max(0, nextCostNano - record.costNano);
        const effectiveBudget = record.budgetCredits ?? event.maxAiCredits;
        const updated = this.update(id, {
          costNano: nextCostNano,
          budgetCredits: effectiveBudget,
          budgetWarnedAtCredits: effectiveBudget,
        });
        this.recordStretchActivity(updated, Date.now());
        if (deltaNano > 0) this.deps.onUsageDelta?.(deltaNano, updated);
        if (inTurn(updated.state) && !live.stopping) {
          void this.pauseForBudget(id);
        }
        return;
      }
      case "activity":
        // Work continues after an idle, so that idle wasn't the end.
        live.activity++;
        live.idle = undefined;
        this.clearSettle(live);
        // A session that should be quiet (stopped, finished, paused) started work anyway, e.g. on a message it accepted
        // just as you pressed Stop: it's stopped again, in turn with everything else that drives the session, so a
        // Continue right after runs only once this abort is done.
        if (!ACTIVE.has(record.state) && !live.stopping && live.handle) {
          const handle = live.handle;
          this.chain(live, "bounded", async () => {
            const now = this.deps.db().getTask(id);
            if (!now || ACTIVE.has(now.state) || live.stopping || live.handle !== handle) return;
            await this.abortTurn(live, handle);
          }).catch(() => {
            // Its next activity tries again, and a task gone meanwhile has nothing left to stop.
          });
        }
        return;
      case "intent":
        if (record.state === "running") {
          const updated = this.update(id, { intent: event.intent });
          this.recordStretchActivity(updated, Date.now());
        }
        return;
      case "message":
        live.lastMessage = event.text;
        return;
      case "task_complete":
        live.sawTaskComplete = true;
        if (event.summary) live.completeSummary = event.summary;
        return;
      case "idle":
        live.idle = { autopilot: event.autopilot };
        this.onIdle(id, event.autopilot);
        return;
      case "error":
        if (!live.stopping && ACTIVE.has(record.state)) this.fail(id, event.message);
        return;
      case "model_change": {
        const expected = live.switchingTo ?? record.model;
        if (live.switchingTo) live.reported = event.model;
        // D15: the runtime can switch models on its own; say so on the task, don't hide it.
        if (event.cause || event.model !== expected) {
          this.deps.notice(
            "warning",
            `The runtime switched the task "${record.title}" from ${event.previousModel ?? record.model} to ${event.model}${event.cause ? ` (${event.cause.replace(/_/g, " ")})` : ""}. You can switch it back in its session view.`,
            event.cause ?? "model_mismatch",
            id,
          );
        }
        this.update(id, { model: event.model, ...(event.reasoningEffort ? { reasoningEffort: event.reasoningEffort } : {}) });
        return;
      }
      case "remote_info":
        if ((record.where === "cloud" || record.remote) && event.url && event.url.startsWith("https://")) {
          this.update(id, { missionControlUrl: event.url });
        }
        return;
      case "warning":
        if (event.warningType === "policy_blocked") {
          if (!live.stopping && ACTIVE.has(record.state)) {
            this.fail(id, event.message || "Blocked by Copilot policy (policy_blocked).");
          }
        } else {
          this.deps.log?.(`Task "${record.title}": ${event.message}`);
        }
        return;
      case "agent_missing":
        // Its agent is gone (renamed or uninstalled since it was chosen): the session runs as the default coding agent.
        live.droppedAgent = event.agent;
        // You picked another one while it opened: that one follows (applyLatestAgent), nothing to tell.
        if (record.agent !== event.agent) return;
        // The task stops asking for it, so its next opening or a rerun doesn't either.
        if (live.wantedAgent === event.agent) live.wantedAgent = undefined;
        this.update(id, { agent: undefined });
        this.deps.notice(
          "warning",
          `The task "${record.title}" was set to run as agent ${event.agent}, which isn't installed anymore (it may have been renamed), so it runs as the default coding agent. Pick another one with /agents @${taskSlug(record)} <agent>.`,
          "agent_missing",
          id,
        );
        return;
    }
  }

  private onIdle(id: string, autopilot: boolean): void {
    const live = this.liveOf(id);
    if (live.stopping === "budget") {
      this.toBudgetPause(id);
      return;
    }
    if (live.stopping) return;
    if (this.record(id).state !== "running") return;
    this.clearSettle(live);
    // An autopilot idle alone can be intermediate (Phase 0); it ends the work only after task_complete, or after a
    // long quiet spell.
    const quiet = !autopilot || live.sawTaskComplete ? (this.deps.settleMs ?? 1_500) : (this.deps.autopilotGraceMs ?? 60_000);
    live.settleTimer = setTimeout(() => {
      const settling: Promise<void> = this.settle(id, autopilot && !live.sawTaskComplete).finally(() => {
        if (live.settling === settling) live.settling = undefined;
      });
      live.settling = settling;
    }, quiet);
  }

  private clearSettle(live: Live): void {
    if (live.settleTimer) clearTimeout(live.settleTimer);
    live.settleTimer = undefined;
  }

  private async settle(id: string, incomplete: boolean): Promise<void> {
    if (this.stopped) return;
    const live = this.liveOf(id);
    live.settleTimer = undefined;
    const activity = live.activity;
    const record = this.deps.db().getTask(id);
    // Messages still on their way to it mean more work is coming.
    if (!record || record.archived || record.state !== "running" || record.outbox?.length || live.deliveries.some((d) => d.run === live.run)) return;
    const stat = record.worktreePath && record.baseCommit ? await diffStat(record.worktreePath, record.baseCommit).catch(() => NO_CHANGES) : NO_CHANGES;
    // R1: lines it damaged with a wrong encoding (after diffStat, so one git at a time reads the worktree; not when it's
    // busy again already, as the check below would drop it anyway).
    const damage =
      record.worktreePath && record.baseCommit && !this.stopped && !live.settleTimer && live.activity === activity
        ? await encodingDamage(record.worktreePath, record.baseCommit).catch((error: unknown) => {
            // execa's message carries all of git's output (the diff): only what failed goes in the log.
            const why = error instanceof Error && "shortMessage" in error && typeof error.shortMessage === "string" ? error.shortMessage : message(error);
            this.deps.log?.(`Task "${record.title}": couldn't check its changes for damaged text: ${clip(why.slice(0, 1000), 300)}`);
            return undefined;
          })
        : undefined;
    // ARIA stopped while the changes were counted: the task is interrupted, not done (and the database is closed).
    if (this.stopped) return;
    // Busy again while the changes were counted (new activity, a message, another idle that rearmed the timer).
    if (live.settleTimer || live.activity !== activity || this.deps.db().getTask(id)?.state !== "running") return;
    if (record.mode === "plan" && !live.plan && stat.commits === 0) {
      const planMd = await live.handle?.readPlan?.().catch(() => undefined);
      if (this.stopped || live.settleTimer || live.activity !== activity || this.deps.db().getTask(id)?.state !== "running") return;
      if (planMd && planMd !== record.planText) {
        const planSummary = (live.completeSummary ?? live.lastMessage ?? "Plan ready for review.").trim();
        live.sawTaskComplete = false;
        live.completeSummary = undefined;
        void this.planReady(id, { summary: planSummary, plan: planMd, actions: ["autopilot", "interactive", "exit_only"] }, true);
        return;
      }
    }
    const summary = live.completeSummary ?? live.lastMessage;
    live.sawTaskComplete = false;
    live.completeSummary = undefined;
    // An earlier finish's count goes when this one finds none.
    const done = this.update(id, { state: "done", finishedAt: Date.now(), intent: undefined, ...(summary ? { summary } : {}), ...stat, encodingDamage: damage });
    this.recordStretchActivity(done, done.finishedAt);
    this.deps.removeCardsForTask?.(id, "task_done", "task_failed");
    const cardId = randomUUID();
    this.deps.addCard({
      kind: "card",
      id: cardId,
      cardType: "task_done",
      payload: { taskId: id, ...(summary ? { summary } : {}), ...stat, ...(incomplete ? { incomplete: true } : {}), ...(damage ? { encodingDamage: damage } : {}) },
      createdAt: Date.now(),
    });
    const isCloud = record.where === "cloud";
    const changes =
      stat.commits > 0
        ? `${stat.filesChanged} file${stat.filesChanged === 1 ? "" : "s"} changed in ${stat.commits} commit${stat.commits === 1 ? "" : "s"}`
        : isCloud
          ? "Finished on Mission Control"
          : record.kind === "chat"
            ? "Finished"
            : record.kind === "folder"
              ? "Finished in folder"
              : "No commits";
    this.deps.attention({ kind: "done", title: `${done.title} is done`, body: changes, task: this.taskRef(done), cardId });
    this.deps.digest(
      `[done] "${done.title}" (${done.repoName}): ${changes}.${incomplete ? " It went quiet without saying it had finished." : ""}${damage ? ` ${encodingDamageText(damage)}` : ""}${summary ? ` Its summary: ${clip(summary, 300)}` : ""}`,
    );
    this.pump();
  }

  private fail(id: string, error: string): void {
    const live = this.liveOf(id);
    // The run in progress stops sending: what's left in the outbox waits for Retry.
    live.run++;
    this.clearSettle(live);
    this.releasePending(live, "failed");
    const record = this.update(id, { state: "failed", error, finishedAt: Date.now(), intent: undefined });
    this.recordStretchActivity(record, record.finishedAt);
    this.deps.removeCardsForTask?.(id, "task_failed", "task_done");
    const cardId = randomUUID();
    this.deps.addCard({ kind: "card", id: cardId, cardType: "task_failed", payload: { taskId: id, error }, createdAt: Date.now() });
    this.deps.attention({ kind: "failed", title: `${record.title} failed`, body: error, task: this.taskRef(record), cardId });
    this.deps.digest(`[failed] "${record.title}" (${record.repoName}): ${clip(error, 300)}`);
    this.pump();
  }

  // ── what a task waits for: questions (D17), permission requests and plans ──────────────────────────────────────

  /**
   * The task's state follows what it waits for, most important first: a plan, then permission requests, then a
   * question; with nothing left it's running again. Only while it's in a turn: a stopped task stays stopped.
   */
  private refreshWaiting(id: string): void {
    const record = this.deps.db().getTask(id);
    if (!record || record.archived) return;
    if (!inTurn(record.state)) {
      this.deps.emit({ type: "task", task: this.toTask(record) });
      return;
    }
    const live = this.liveOf(id);
    const state: TaskState = live.plan ? "waiting_plan" : live.permissions.size > 0 ? "waiting_permission" : live.question ? "waiting_input" : "running";
    if (state !== record.state) {
      const updated = this.update(id, { state, ...(state !== "running" ? { intent: undefined } : {}) });
      this.recordStretchActivity(updated, Date.now());
    }
    // What it waits for changed (the lists are part of the task) even when its state didn't.
    else {
      this.recordStretchActivity(record, Date.now());
      this.deps.emit({ type: "task", task: this.toTask(record) });
    }
  }

  /** Whatever a task was waiting on goes away with its turn: the worker gets an answer that says why. */
  private releasePending(live: Live, why: "cancel" | "budget" | "failed" | "shutdown"): void {
    if (why === "shutdown") {
      // Nobody can answer anymore: the runtime is told the user isn't available (PLAN.md §4.8).
      for (const open of [...live.permissions.values()]) open.resolve({ approve: false, reason: "ARIA is shutting down.", unavailable: true });
      return;
    }
    const text = why === "budget" ? BUDGET_ANSWER : why === "cancel" ? CANCELLED_ANSWER : STOPPED_ANSWER;
    live.question?.resolve({ answer: text, wasFreeform: true });
    for (const open of [...live.permissions.values()]) open.resolve({ approve: false, reason: text });
    live.plan?.resolve({ approved: false, feedback: text });
  }

  /** Why nothing can be asked of you right now, if so. */
  private cannotAsk(id: string, live: Live): string | undefined {
    if (this.cancelledOrStopped(id)) return CANCELLED_ANSWER;
    if (live.stopping) return live.stopping === "budget" ? BUDGET_ANSWER : CANCELLED_ANSWER;
    if (!inTurn(this.deps.db().getTask(id)?.state)) return STOPPED_ANSWER;
    return undefined;
  }

  private ask(id: string, question: WorkerQuestion): Promise<WorkerAnswer> {
    const live = this.liveOf(id);
    const refused = this.cannotAsk(id, live);
    if (refused) return Promise.resolve({ answer: refused, wasFreeform: true });
    return new Promise<WorkerAnswer>((resolve) => {
      const pending: PendingQuestion = {
        id: randomUUID(),
        shortId: this.nextShortId("Q"),
        question: question.question,
        ...(question.choices?.length ? { choices: question.choices } : {}),
        allowFreeform: question.allowFreeform,
        askedAt: Date.now(),
      };
      const cardId = `question-${pending.id}`;
      live.question?.resolve({ answer: "(asked again)", wasFreeform: true });
      live.question = {
        pending,
        cardId,
        resolve: (answer) => {
          if (live.question?.pending.id === pending.id) live.question = undefined;
          resolve(answer);
        },
      };
      this.clearSettle(live);
      this.refreshWaiting(id);
      this.deps.addCard({
        kind: "card",
        id: cardId,
        cardType: "task_question",
        payload: { taskId: id, questionId: pending.id, shortId: pending.shortId, question: pending.question, ...(pending.choices ? { choices: pending.choices } : {}) },
        createdAt: Date.now(),
      });
      this.deps.attention({ kind: "question", title: `${this.record(id).title} needs you`, body: pending.question, task: this.taskRef(this.record(id)), cardId });
    });
  }

  /**
   * An answer to the task's question, by you (the window) or by ARIA (its answer_question tool). Whether it's in the
   * answerer's own words is worked out here (it isn't one of the choices, in any letter case), not taken from the window.
   */
  answer(id: string, questionId: string, answer: string, wasFreeform: boolean, by: "you" | "aria"): void {
    const live = this.live.get(id);
    const open = live?.question;
    if (!open || open.pending.id !== questionId) throw new Error("That question was already answered, or the task stopped waiting for it.");
    if (!open.pending.allowFreeform && !open.pending.choices?.includes(answer)) throw new Error(`Pick one of: ${open.pending.choices?.join(", ")}.`);
    const freeform = !(open.pending.choices ?? []).some((choice) => choice.trim().toLowerCase() === answer.trim().toLowerCase());
    this.deps.addCard({
      kind: "card",
      id: open.cardId,
      cardType: "task_question",
      payload: {
        taskId: id,
        questionId,
        shortId: open.pending.shortId,
        question: open.pending.question,
        ...(open.pending.choices ? { choices: open.pending.choices } : {}),
        answer,
        answeredBy: by,
        ...(freeform ? { freeform: true } : {}),
      },
      createdAt: open.pending.askedAt,
      updatedAt: Date.now(),
    });
    open.resolve({ answer, wasFreeform });
    this.refreshWaiting(id);
  }

  /** A request the policy can't decide on its own (§4.8): a permission card, and the task waits; never a timeout. */
  private requestPermission(id: string, request: PermissionRequestDetails, offerId?: string): Promise<PermissionVerdict> {
    const live = this.liveOf(id);
    const refused = this.cannotAsk(id, live);
    if (refused) return Promise.resolve({ approve: false, reason: refused });
    return new Promise<PermissionVerdict>((resolve) => {
      const record = this.record(id);
      const { grants: _grants, ...shown } = request;
      const pending: PendingPermission = { id: randomUUID(), shortId: this.nextShortId("P"), ...shown, askedAt: Date.now() };
      const cardId = `permission-${pending.id}`;
      live.permissions.set(pending.id, {
        pending,
        cardId,
        request,
        ...(offerId ? { offerId } : {}),
        resolve: (verdict) => {
          live.permissions.delete(pending.id);
          resolve(verdict);
        },
      });
      this.clearSettle(live);
      this.refreshWaiting(id);
      this.deps.addCard({ kind: "card", id: cardId, cardType: "task_permission", payload: this.permissionPayload(id, pending, record.sandboxed === true, offerId), createdAt: Date.now() });
      this.deps.attention({ kind: "permission", title: `${record.title} needs your approval`, body: pending.what, task: this.taskRef(record), cardId });
    });
  }

  private permissionPayload(taskId: string, pending: PendingPermission, sandboxed: boolean, offerId: string | undefined) {
    const { id: permissionId, askedAt: _at, ...rest } = pending;
    return { taskId, permissionId, ...rest, sandboxed, ...(offerId ? { offerId } : {}) };
  }

  /**
   * Your decision on a permission request. "task" also remembers the operation and its target for the rest of the task
   * (D21), which lets other requests waiting for the same thing through as well.
   */
  decidePermission(id: string, permissionId: string, decision: PermissionDecision, note?: string): void {
    const live = this.live.get(id);
    const open = live?.permissions.get(permissionId);
    if (!live || !open) throw new Error("That request was already decided, or the task stopped waiting for it.");
    // D29: a destructive command asks every time; there's nothing to approve for the rest of the task.
    if ((decision === "task" || decision === "always") && open.request.everyTime) {
      const why = open.pending.sandbox ? "can't be matched to a stable sandbox resource" : open.request.kind === "mcp" ? "changes things" : "is destructive";
      throw new Error(`${open.pending.shortId} ${why}, so it asks every time: approve it once, or reject it.`);
    }
    if (decision === "always") {
      if (!open.pending.sandbox?.persistent || !this.deps.persistSandboxException) throw new Error(`${open.pending.shortId} cannot be saved as an exact sandbox exception.`);
      this.deps.persistSandboxException(open.pending.sandbox);
    }
    const record = this.record(id);
    let grants = record.grants ?? [];
    if (decision === "task" || decision === "always") {
      const added: TaskGrant[] = open.request.grants
        .filter((g) => !grants.some((x) => x.key === g.key && x.target === g.target))
        .map((g) => ({ id: randomUUID(), key: g.key, target: g.target, label: g.label, at: Date.now() }));
      grants = [...grants, ...added];
      if (added.length) this.update(id, { grants });
    }
    const trimmed = note?.trim();
    this.closePermissionCard(id, open, decision, trimmed, record.sandboxed === true);
    open.resolve(
      decision === "reject"
        ? { approve: false, reason: trimmed ? `The user said no: ${trimmed}` : "The user said no. Carry on without it, and mention it in your summary if it mattered." }
        : { approve: true },
    );
    if (decision === "task" || decision === "always") {
      const covered = (request: PermissionRequestDetails) => request.grants.length > 0 && request.grants.every((g) => grants.some((x) => x.key === g.key && x.target === g.target));
      for (const other of [...live.permissions.values()]) {
        if (!covered(other.request)) continue;
        this.closePermissionCard(id, other, "task", `Covered by your approval of ${open.pending.shortId}.`, record.sandboxed === true);
        other.resolve({ approve: true });
      }
    }
    this.refreshWaiting(id);
  }

  private closePermissionCard(id: string, open: OpenPermission, decision: PermissionDecision, note: string | undefined, sandboxed: boolean): void {
    this.deps.addCard({
      kind: "card",
      id: open.cardId,
      cardType: "task_permission",
      payload: { ...this.permissionPayload(id, open.pending, sandboxed, open.offerId), decision, ...(note ? { note } : {}) },
      createdAt: open.pending.askedAt,
      updatedAt: Date.now(),
    });
  }

  /** Forgets an "Approve for this task" grant: the same operation asks again from now on. */
  revokeGrant(id: string, grantId: string): void {
    const record = this.record(id);
    const grants = (record.grants ?? []).filter((g) => g.id !== grantId);
    if (grants.length === (record.grants ?? []).length) return;
    this.update(id, { grants: grants.length ? grants : undefined });
  }

  /** A worker in plan mode finished its plan (`exit_plan_mode` or idle with `plan.md`): a plan card, and the task waits for your review. */
  private planReady(id: string, plan: WorkerPlan, fromIdle = false): Promise<WorkerPlanDecision> {
    const live = this.liveOf(id);
    const refused = this.cannotAsk(id, live);
    if (refused) return Promise.resolve({ approved: false, feedback: refused });
    const planText = plan.plan?.trim();
    if (planText) {
      this.update(id, { planText });
    }
    return new Promise<WorkerPlanDecision>((resolve) => {
      const pending: PendingPlan = { id: randomUUID(), shortId: this.nextShortId("L"), summary: plan.summary.trim() || "(no summary)", ...(planText ? { plan: planText } : {}), askedAt: Date.now() };
      const cardId = `plan-${pending.id}`;
      // A newer plan replaces one still waiting.
      live.plan?.resolve({ approved: false, feedback: "You wrote a newer plan." });
      live.plan = {
        pending,
        cardId,
        ...(fromIdle ? { fromIdle: true } : {}),
        resolve: (decision) => {
          if (live.plan?.pending.id === pending.id) live.plan = undefined;
          resolve(decision);
        },
      };
      this.clearSettle(live);
      this.refreshWaiting(id);
      this.deps.addCard({
        kind: "card",
        id: cardId,
        cardType: "task_plan",
        payload: { taskId: id, planId: pending.id, shortId: pending.shortId, summary: pending.summary, ...(pending.plan ? { plan: pending.plan } : {}) },
        createdAt: Date.now(),
      });
      this.deps.attention({ kind: "plan", title: `${this.record(id).title} has a plan`, body: pending.summary, task: this.taskRef(this.record(id)), cardId });
    });
  }

  /**
   * Your review of a plan: approve it to continue in autopilot or interactive mode (the task keeps that mode), ask for
   * a revision with what to change, or cancel the task.
   */
  async reviewPlan(id: string, planId: string, decision: PlanDecision, feedback?: string): Promise<void> {
    const live = this.live.get(id);
    const open = live?.plan;
    if (!open || open.pending.id !== planId) throw new Error("That plan was already reviewed, or the task stopped waiting for it.");
    const trimmed = feedback?.trim();
    if (decision === "revise" && !trimmed) throw new Error("Say what to change in the plan.");
    this.deps.addCard({
      kind: "card",
      id: open.cardId,
      cardType: "task_plan",
      payload: {
        taskId: id,
        planId,
        shortId: open.pending.shortId,
        summary: open.pending.summary,
        ...(open.pending.plan ? { plan: open.pending.plan } : {}),
        decision,
        ...(trimmed ? { feedback: trimmed } : {}),
      },
      createdAt: open.pending.askedAt,
      updatedAt: Date.now(),
    });
    if (decision === "autopilot" || decision === "interactive") {
      // The runtime continues in that mode (Phase 0); the task keeps it, so a reopened session gets it too.
      this.update(id, { mode: decision });
      open.resolve({ approved: true, mode: decision });
      this.refreshWaiting(id);
      if (open.fromIdle) {
        await live.handle?.setMode?.(decision).catch((error: unknown) => {
          this.deps.notice("warning", `Couldn't switch the task "${this.record(id).title}" to ${decision} (${message(error)}), so its session may stay in plan mode.`, "mode_switch_failed", id);
        });
        await this.message(id, "The plan is approved. Proceed with implementing the plan now.", false);
      }
      return;
    } else if (decision === "revise") {
      open.resolve({ approved: false, feedback: trimmed! });
      this.refreshWaiting(id);
      if (open.fromIdle) {
        await this.message(id, `Please revise the plan in plan.md with this feedback, then call exit_plan_mode:\n\n${trimmed!}`, false);
      }
      return;
    } else {
      open.resolve({ approved: false, feedback: CANCELLED_ANSWER });
      await this.cancel(id);
      return;
    }
  }

  // ── budget ────────────────────────────────────────────────────────────────────────────────────────────────────

  private async pauseForBudget(id: string): Promise<void> {
    const live = this.liveOf(id);
    if (live.stopping || !live.handle) return;
    live.stopping = "budget";
    // The run in progress stops sending; what's left in the outbox waits for the raise.
    live.run++;
    this.clearSettle(live);
    // What it was waiting on goes away with the turn.
    this.releasePending(live, "budget");
    this.refreshWaiting(id);
    await this.chain(live, "bounded", async () => {
      const handle = live.handle;
      if (handle) await this.abortTurn(live, handle);
      // The abort's idle may already have moved it; if not (no idle comes when nothing was running), do it now.
      if (live.stopping === "budget") this.toBudgetPause(id);
    });
  }

  private toBudgetPause(id: string): void {
    const live = this.liveOf(id);
    live.stopping = undefined;
    const record = this.record(id);
    if (!inTurn(record.state)) return;
    live.budgetShortId = this.nextShortId("B");
    const paused = this.update(id, { state: "waiting_budget", intent: undefined });
    this.recordStretchActivity(paused, Date.now());
    const used = Math.round(paused.costNano / 1e7) / 100;
    this.deps.removeCardsForTask?.(id, "task_budget");
    const cardId = randomUUID();
    live.budgetCardId = cardId;
    this.deps.addCard({
      kind: "card",
      id: cardId,
      cardType: "task_budget",
      payload: { taskId: id, shortId: live.budgetShortId, usedCredits: used, budgetCredits: paused.budgetCredits ?? 0 },
      createdAt: Date.now(),
    });
    this.deps.attention({ kind: "budget", title: `${paused.title} reached its budget`, body: `It used ${used} AI credits and is paused.`, task: this.taskRef(paused), cardId });
    this.deps.digest(`[paused] "${paused.title}" (${paused.repoName}) reached its budget: ${used} of ${paused.budgetCredits ?? 0} credits (${live.budgetShortId}).`);
    this.pump();
  }

  continueBudget(id: string, addCredits: number): void {
    const record = this.record(id);
    if (record.state !== "waiting_budget") throw new Error("That task isn't paused at its budget.");
    assertCanContinue(record);
    this.assertNotDiscarding(id);
    this.liveOf(id).budgetShortId = undefined;
    this.liveOf(id).budgetCardId = undefined;
    this.update(id, { budgetCredits: (record.budgetCredits ?? 0) + addCredits });
    // Before any messages you sent while it was paused.
    this.toOutbox(id, ["You were paused because the task reached its AI credit budget. The budget was raised; continue where you left off."], true);
    this.requeue(id);
  }

  // ── your actions ──────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Steer (into the running turn) or queue a message. A finished task continues in the same session; a task paused at
   * its budget keeps the message until you raise the budget (sending it now would only pause it again). A task waiting
   * for you inside its turn gets it after the turn goes on (the runtime queues it). `paths`: what it may read from now
   * on; the caller decides, since nothing in the text itself can grant that.
   */
  async message(id: string, text: string, steer: boolean, untrusted?: string, paths: readonly string[] = []): Promise<MessageOutcome> {
    const record = this.record(id);
    const live = this.liveOf(id);
    this.assertNotDiscarding(id);
    if (record.adoptedBy) throw new Error("Another task took over this task's branch (Fix it): message that one.");
    const newPaths = sanitizeAllowedPaths(paths);
    if (newPaths.length > 0) {
      this.update(id, { allowedPaths: sanitizeAllowedPaths([...(record.allowedPaths ?? []), ...newPaths]) });
    }
    if (inTurn(record.state)) {
      if (!live.handle && record.where === "cloud" && record.sessionId) {
        try {
          live.handle = await this.ensureHandle(id, { createWorktree: false });
        } catch {
          // No handle then: the check below says so.
        }
      }
      if (!live.handle) throw new Error("The task's session isn't open yet.");
      // Messages from before are still being delivered: this one goes after them.
      if (record.outbox?.length) {
        this.toOutbox(id, [text], false, untrusted);
        return "queued";
      }
      // It's busy again: a settle that already started mustn't end it.
      live.activity++;
      this.clearSettle(live);
      // Like everything that drives the session: after the step before it, and only into the run it was meant for while
      // the task still works. Otherwise it waits in the outbox like any other message, and a task that finished just
      // before it arrived continues with it (as a finished task does).
      const run = live.run;
      let outcome: MessageOutcome = "sent";
      // Counted for its run until it's settled (sent, or put in the outbox): that run isn't done meanwhile.
      const delivery = { run };
      live.deliveries.push(delivery);
      let sent = false;
      try {
        await this.chain(live, "open-ended", async () => {
          const handle = live.handle;
          const now = this.deps.db().getTask(id);
          if (live.run !== run || live.stopping || !inTurn(now?.state) || this.stopped || !handle) {
            this.toOutbox(id, [text], false, untrusted);
            const state = this.record(id).state;
            if (state === "done" || state === "failed" || state === "interrupted") {
              this.requeue(id);
              outcome = "continuing";
            } else {
              outcome = state === "waiting_budget" || live.stopping === "budget" ? "held" : "queued";
            }
            return;
          }
          await handle.send(outboxText({ text, ...(untrusted ? { untrusted } : {}) }), { steer });
          sent = true;
        });
      } finally {
        live.deliveries = live.deliveries.filter((d) => d !== delivery);
        // The session went idle while this was on its way and it never got there (a failed send): settle as that
        // idle would have, now nothing more is coming.
        if (!sent && live.idle && live.run === run && !live.deliveries.some((d) => d.run === run)) this.onIdle(id, live.idle.autopilot);
      }
      return outcome;
    }
    if (record.state === "done" || record.state === "failed" || record.state === "cancelled" || record.state === "interrupted") {
      assertCanContinue(record);
      // Its branch has an open PR: the worker adds commits, it doesn't rewrite what's been pushed.
      this.toOutbox(id, [record.pr ? `${PR_NOTE}\n\n${text}` : text], false, untrusted);
      this.requeue(id);
      return "continuing";
    }
    this.toOutbox(id, [text], false, untrusted);
    return record.state === "waiting_budget" ? "held" : "queued";
  }

  /**
   * Item 4: what a fix (Fix it, Address comments) records on the task it goes to. `fromText` stays once set (D52):
   * the commits it makes from here may come from that text.
   */
  markFixing(id: string, fixing: { kind: "ci" | "review"; cardId: string; label: string }, fromText: "ci_log" | "review"): void {
    this.update(id, { fixing: { ...fixing, at: Date.now() }, fromText: this.record(id).fromText ?? fromText });
  }

  /** The task Fix it goes to for a branch (D46): the newest live one with it; adopted-from and archived ones aren't. */
  ownerOf(repoId: number, branch: string): Task | undefined {
    const owners = this.deps
      .db()
      .listTasks()
      .filter((r) => r.repoId === repoId && r.branch === branch && !r.adoptedBy)
      .sort((a, b) => b.createdAt - a.createdAt);
    return owners[0] ? this.toTask(owners[0]) : undefined;
  }

  async cancel(id: string): Promise<void> {
    const record = this.record(id);
    const live = this.liveOf(id);
    if (record.state === "queued" || record.state === "interrupted" || record.state === "waiting_budget") {
      live.run++;
      live.budgetShortId = undefined;
      live.budgetCardId = undefined;
      this.queue = this.queue.filter((q) => q !== id);
      const cancelled = this.update(id, { state: "cancelled", finishedAt: Date.now() });
      this.recordStretchActivity(cancelled, cancelled.finishedAt);
      return;
    }
    if (!ACTIVE.has(record.state)) return;
    // First, synchronously: the run in progress sees it after its current step and sends nothing more, and a run
    // that's still opening the session leaves it to the step below.
    const neverStarted = record.state === "starting";
    live.run++;
    live.stopping = "cancel";
    this.clearSettle(live);
    // What it waited for goes first, so the cancelled task shows nothing left to answer.
    this.releasePending(live, "cancel");
    const cancelled = this.update(id, { state: "cancelled", finishedAt: Date.now(), intent: undefined });
    this.recordStretchActivity(cancelled, cancelled.finishedAt);
    // Then, once that run has let go of the session: stop its turn, or close a session that never got its work. Each
    // wait is bounded: a runtime that stopped answering mustn't keep Stop (or Discard) from finishing.
    await this.chain(live, "bounded", async () => {
      const opening = live.opening;
      if (opening) await within(this.chainWait(), () => opening);
      const handle = live.handle;
      if (neverStarted && handle) {
        await this.release(live, handle);
      } else if (handle) {
        await this.abortTurn(live, handle);
      } else if (record.where === "cloud" && record.sessionId) {
        await this.deps.runtime.deleteSession(record.sessionId).catch((error: unknown) => {
          this.deps.notice("warning", `Couldn't close the cloud session of "${record.title}" (${message(error)}), so it may still be running on GitHub.`, "cloud_cancel_failed", id);
        });
      }
      if (live.stopping === "cancel") live.stopping = undefined;
    });
    this.pump();
  }

  /** Continues a failed or interrupted task in its session (a task that never got going starts over from its brief). */
  retry(id: string): void {
    const record = this.record(id);
    if (record.state !== "failed" && record.state !== "interrupted") throw new Error("Only a failed or interrupted task can be retried.");
    assertCanContinue(record);
    this.assertNotDiscarding(id);
    if (record.briefSent) {
      // Before any messages it hadn't got yet.
      this.toOutbox(
        id,
        [
          record.state === "failed"
            ? `The last attempt stopped with an error: ${record.error ?? "unknown"}. Check the current state and continue the task.`
            : "ARIA was closed while you were working on this task. Check the current state of the worktree and continue.",
        ],
        true,
      );
    }
    this.requeue(id);
  }

  resumeInterrupted(): void {
    for (const record of this.deps.db().listTasks()) {
      if (record.state === "interrupted" && !cleanedUp(record) && !record.adoptedBy) {
        try {
          this.retry(record.id);
        } catch {
          // It stays interrupted, where you can see it and retry it: the rest still resume.
        }
      }
    }
  }

  dismissInterrupted(): void {
    for (const record of this.deps.db().listTasks()) if (record.state === "interrupted") this.update(record.id, { state: "cancelled", finishedAt: Date.now() });
  }

  async setModel(id: string, model: string, reasoningEffort?: string): Promise<void> {
    const option = this.deps.models().find((m) => m.id === model);
    if (!option || !option.enabled) throw new Error(`${model} isn't an available model.`);
    let effort = reasoningEffort;
    if (option.efforts.length === 0) effort = undefined;
    else if (!effort || !option.efforts.includes(effort)) throw new Error(`${option.name} supports these effort levels: ${option.efforts.join(", ")}.`);
    const live = this.liveOf(id);
    if (live.handle) {
      live.switchingTo = model;
      live.reported = undefined;
      try {
        await live.handle.setModel(model, effort);
      } finally {
        live.switchingTo = undefined;
      }
      const reported = live.reported;
      live.reported = undefined;
      // The runtime runs another model than asked (D15): its model_change put that on the task, with a warning.
      if (reported && reported !== model) return;
    } else {
      // Its session is opening (or not open): it gets this model before any work.
      live.wanted = { model, ...(effort ? { reasoningEffort: effort } : {}) };
    }
    this.update(id, { model, reasoningEffort: effort });
  }

  async setAgent(id: string, agent: string | null | undefined): Promise<Task> {
    this.record(id);
    const next = agent?.trim() || undefined;
    const live = this.liveOf(id);
    if (live.handle) {
      await live.handle.setAgent?.(next ?? null);
    } else {
      live.wantedAgent = next ?? null;
    }
    return this.toTask(this.update(id, { agent: next }));
  }

  /** Removes the worktree, the branch and the session, and hides the task (you clicked Discard and confirmed). */
  async discard(id: string): Promise<void> {
    this.record(id);
    const live = this.liveOf(id);
    if (live.discarding) return live.discarding;
    const discarding = (async () => {
      // First, synchronously: it leaves the queue and nothing starts or continues it from here on (cancel ends a run).
      live.run++;
      this.queue = this.queue.filter((q) => q !== id);
      await this.cancel(id);
      // Then, once nothing drives its session anymore: the worktree and the branch go, then the session. In that order:
      // if the worktree can't be removed (Windows still holds a file in it), the task keeps its session and can go on.
      await this.chain(live, "bounded", async () => {
        const opening = live.opening;
        if (opening) await within(this.chainWait(), () => opening);
        const handle = live.handle;
        if (handle) await this.release(live, handle);
        const record = this.record(id);
        if (record.where !== "cloud") {
          // A branch another live task took over (D46) or works on stays: only this task's worktree and session go.
          const shared = record.branch !== undefined && this.deps.db().listTasks().some((r) => r.id !== id && r.repoId === record.repoId && r.branch === record.branch && !r.adoptedBy);
          if (record.worktreePath && record.worktreeRoot) {
            await removeWorktree({ repoPath: record.repoPath, root: record.worktreeRoot, worktree: record.worktreePath, ...(record.branch ? { branch: record.branch } : {}), deleteBranch: !shared });
          } else if (record.branch && !shared) {
            // Its worktree was cleaned up already; the branch is still there.
            await deleteAriaBranch(record.repoPath, record.branch);
          }
        }
        if (record.sessionId) await within(this.callWait(), () => this.deps.runtime.deleteSession(record.sessionId!));
        this.clearSettle(live);
        this.deps.db().deleteTranscriptEntries(`task:${id}`);
        this.update(id, { archived: true, worktreePath: undefined, outbox: undefined });
      });
      this.live.delete(id);
      this.deps.emit({ type: "task_removed", taskId: id });
    })();
    live.discarding = discarding;
    try {
      await discarding;
    } catch (error) {
      // Nothing was hidden: it can be discarded again, or continued.
      if (live.discarding === discarding) live.discarding = undefined;
      throw error;
    }
  }

  /** Removes a finished task's worktree but keeps its branch (and commits) and its session. */
  async cleanup(id: string): Promise<void> {
    const record = this.record(id);
    if (ACTIVE.has(record.state) || record.state === "queued") throw new Error("Stop the task before cleaning it up.");
    this.assertNotDiscarding(id);
    const { worktreePath, worktreeRoot } = record;
    if (!worktreePath || !worktreeRoot) return;
    // First, synchronously: from here on it can't be continued (that would need the worktree).
    this.update(id, { worktreePath: undefined });
    const live = this.liveOf(id);
    try {
      await this.chain(live, "bounded", async () => {
        const ownerId = `task:${id}`;
        const needsBackfill =
          !this.deps.db().isTranscriptBackfilled(ownerId) &&
          Boolean(record.sessionId) &&
          (await this.deps.runtime.sessionExists(record.sessionId!));
        let handle = live.handle ?? (live.opening ? await live.opening.catch(() => undefined) : undefined);
        if (!handle && needsBackfill) {
          handle = await this.ensureHandle(id, { createWorktree: false, worktreeOverride: worktreePath });
          if (!handle) throw new Error("Couldn't open the task's session to archive its transcript before cleanup.");
        }
        if (handle) {
          const entries = needsBackfill
            ? await handle.getTranscript()
            : await handle.getTranscript().catch(() => []);
          if (entries.length) this.deps.db().upsertTranscriptEntries(ownerId, entries);
          this.deps.db().markTranscriptBackfilled(ownerId);
          await this.release(live, handle);
        }
        await removeWorktree({ repoPath: record.repoPath, root: worktreeRoot, worktree: worktreePath });
      });
    } catch (error) {
      // Still there, so it can be continued or cleaned up again.
      if (this.deps.db().getTask(id)?.archived === false) this.update(id, { worktreePath });
      throw error;
    }
  }

  /** Lazily backfills `session_transcripts` in SQLite for any task from before Phase 6A that has not been indexed yet. */
  async ensureTranscriptsIndexed(repoId?: number): Promise<void> {
    const records = this.deps
      .db()
      .listTasks()
      .filter((r) => !r.archived && (repoId === undefined || r.repoId === repoId));
    for (const r of records) {
      if (this.stopped) return;
      const ownerId = `task:${r.id}`;
      if (this.deps.db().isTranscriptBackfilled(ownerId)) continue;
      if (!r.sessionId || (!r.worktreePath && r.where !== "cloud")) continue;
      const live = this.liveOf(r.id);
      const hadHandle = live.handle !== undefined || live.opening !== undefined;
      try {
        await this.transcript(r.id);
      } catch {
        // Leave un-backfilled so a later search or cleanup retries.
      } finally {
        if (!hadHandle && !ACTIVE.has(this.record(r.id).state) && live.handle) {
          const opened = live.handle;
          await this.release(live, opened).catch(ignoreCleanupFailure);
        }
      }
    }
  }

  /** Everything the task's session did, for the session view (opens the session when it isn't open, without working). */
  async transcript(id: string): Promise<TranscriptEntry[]> {
    const record = this.record(id);
    const live = this.liveOf(id);
    let handle = live.handle ?? (live.opening ? await live.opening.catch(() => undefined) : undefined);
    // Only an existing session is opened for reading; opening a missing one would create it.
    if (!handle && record.sessionId && (record.worktreePath || record.where === "cloud") && (await this.deps.runtime.sessionExists(record.sessionId))) {
      handle = await this.ensureHandle(id, { createWorktree: false });
    }
    if (handle) {
      // Live steps are saved as they come, but not what the session did before this handle was listening (a run while
      // ARIA was closed, a step that finished meanwhile): the first read checks its history against what's saved and
      // writes only what's new or changed. After that, reading it again (each page, each open) writes nothing; it used
      // to write the whole history every time, in one transaction on the main process.
      const owner = `task:${id}`;
      const active = ACTIVE.has(this.record(id).state);
      const checked = this.reconciled.get(handle);
      const reconcile = !checked || (checked.active && !active) || !this.deps.db().isTranscriptBackfilled(owner);
      if (!reconcile) return handle.getTranscript();
      const savedLive = new Set<string>();
      const readers = this.savedWhileReading.get(id) ?? new Set<Set<string>>();
      readers.add(savedLive);
      this.savedWhileReading.set(id, readers);
      let entries: TranscriptEntry[];
      try {
        entries = await handle.getTranscript();
      } finally {
        readers.delete(savedLive);
        if (readers.size === 0 && this.savedWhileReading.get(id) === readers) this.savedWhileReading.delete(id);
      }
      // A step saved live while this was read is newer than the read's copy of it.
      const stored = this.deps.db().storedTranscriptJson(owner);
      // A cleaned-up task's old steps (D1) aren't saved again: the store would leave them out too.
      const pruned = this.deps.db().transcriptPrunedAt(owner);
      const changed = entries.filter((entry) => !savedLive.has(entry.id) && !isPrunedStep(entry, pruned) && stored.get(entry.id) !== JSON.stringify(entry));
      if (changed.length) this.deps.db().upsertTranscriptEntries(owner, changed);
      this.deps.db().markTranscriptBackfilled(owner);
      this.reconciled.set(handle, { active });
      return entries;
    }
    const owner = `task:${id}`;
    const saved = this.deps.db().listTranscriptEntries(owner);
    const pruned = this.deps.db().transcriptPrunedAt(owner);
    return pruned === undefined ? saved : withPrunedNote(saved, pruned);
  }

  async diff(id: string): Promise<TaskDiff> {
    const record = this.record(id);
    if (record.where === "cloud") {
      const url = record.missionControlUrl ?? (record.sessionId ? `https://github.com/copilot/tasks/${encodeURIComponent(record.sessionId)}` : undefined);
      const repo = record.cloudRepo ? `${record.cloudRepo.owner}/${record.cloudRepo.name}` : record.repoName;
      return {
        text: `Cloud task on Mission Control (${repo}).${url ? `\nView changes and pull requests on Mission Control: ${url}` : ""}`,
        truncated: false,
      };
    }
    if (record.kind === "chat") {
      return {
        text: "Standalone chat session (no git repository).",
        truncated: false,
      };
    }
    if (record.kind === "folder") {
      return {
        text: `Folder session in ${record.repoPath} (not a git repository).`,
        truncated: false,
      };
    }
    if (!record.worktreePath || !record.baseCommit) throw new Error("This task has no worktree: it hasn't started yet, or it was cleaned up.");
    return diff(record.worktreePath, record.baseCommit);
  }

  file(id: string, filePath: string): TaskFile | null {
    const record = this.record(id);
    const sessionDir = record.sessionId ? path.join(os.homedir(), ".copilot", "session-state", record.sessionId) : undefined;
    const extraRoots = sessionDir ? [sessionDir] : [];
    const hit = record.worktreePath
      ? readWorktreeFile(record.worktreePath, filePath, extraRoots)
      : sessionDir
        ? readWorktreeFile(sessionDir, filePath)
        : null;
    if (hit) return hit;
    if (/(?:^|[\\/])plan\.md$/i.test(filePath.trim())) {
      const fallback = this.live.get(id)?.plan?.pending.plan ?? record.planText;
      if (fallback) return { path: "plan.md", content: fallback, truncated: false };
    }
    return null;
  }

  // ── restart and shutdown ──────────────────────────────────────────────────────────────────────────────────────

  /**
   * At startup, before anything runs: tasks that were working are interrupted, and one card offers to resume them.
   * Tasks paused at their budget get a short id again (they start over with every start).
   */
  markInterrupted(): void {
    for (const record of this.deps.db().listTasks()) {
      if (record.state === "waiting_budget") this.liveOf(record.id).budgetShortId = this.nextShortId("B");
    }
    this.interruptWorking();
  }

  /**
   * The runtime went away while ARIA runs. As after ARIA closes: tasks that were working are interrupted (one card
   * offers to resume them), new ones wait in the queue until startQueued, and sessions are opened again when they're next
   * used. A pause at the budget stays as it is, with its B-n and card.
   */
  runtimeLost(): void {
    this.ready = false;
    for (const [id, live] of [...this.live]) {
      this.clearSettle(live);
      this.releasePending(live, "shutdown");
      // What's on its way can't finish anymore: this makes it stop quietly, instead of failing the task.
      live.run++;
      if (live.discarding) continue;
      this.live.delete(id);
      if (live.budgetShortId) {
        const fresh = this.liveOf(id);
        fresh.budgetShortId = live.budgetShortId;
        if (live.budgetCardId) fresh.budgetCardId = live.budgetCardId;
      }
    }
    this.interruptWorking("runtime");
  }

  private interruptWorking(cause?: "runtime"): void {
    const interrupted: string[] = [];
    for (const record of this.deps.db().listTasks()) {
      if (record.where === "cloud" && record.sessionId) continue;
      if (!ACTIVE.has(record.state)) continue;
      const updated = this.update(record.id, { state: "interrupted", intent: undefined });
      this.recordStretchActivity(updated, updated.updatedAt);
      interrupted.push(record.id);
    }
    if (!interrupted.length) return;
    const cardId = randomUUID();
    this.interruptedCard = { id: cardId, taskIds: new Set(interrupted) };
    this.deps.addCard({ kind: "card", id: cardId, cardType: "tasks_interrupted", payload: { taskIds: interrupted, ...(cause ? { cause } : {}) }, createdAt: Date.now() });
    this.deps.attention({
      kind: "interrupted",
      title: interrupted.length === 1 ? "A task was interrupted" : `${interrupted.length} tasks were interrupted`,
      body: cause ? "They were running when the Copilot runtime stopped. Reconnect in the chat, then resume or stop them on their card." : "They were running when ARIA closed. Resume or stop them on their card.",
      cardId,
    });
  }

  /** Once the runtime is up: tasks waiting in the queue start (oldest first), and new ones start right away. */
  startQueued(): void {
    this.ready = true;
    for (const record of this.deps.db().listTasks()) {
      if (record.state === "queued" && !this.queue.includes(record.id)) {
        this.queue.push(record.id);
      } else if (record.where === "cloud" && ACTIVE.has(record.state) && record.sessionId) {
        void this.reconcileCloudTask(record.id);
      }
    }
    this.pump();
  }

  /**
   * Before the runtime restarts (Reconnect): new tasks wait in the queue until startQueued, and the sessions of finished
   * tasks, which end with the runtime, reopen when they're next used. Refused (false) while a task is working or a
   * session is opening, because the restart would end those.
   */
  pauseForRestart(): boolean {
    const lives = [...this.live.values()];
    if (this.deps.db().listTasks().some((t) => ACTIVE.has(t.state)) || lives.some((live) => live.opening)) return false;
    this.ready = false;
    for (const live of lives) live.handle = undefined;
    return true;
  }

  private async reconcileCloudTask(id: string): Promise<void> {
    if (this.stopped) return;
    const initialRecord = this.record(id);
    if (!initialRecord || initialRecord.archived || !initialRecord.sessionId || !ACTIVE.has(initialRecord.state)) return;
    try {
      const exists = await this.deps.runtime.sessionExists(initialRecord.sessionId);
      if (this.stopped) return;
      const current = this.record(id);
      if (!current || current.archived || !ACTIVE.has(current.state)) return;
      if (!exists) {
        this.update(id, { state: "failed", error: "Cloud session no longer exists on Mission Control.", finishedAt: Date.now() });
        return;
      }
      const live = this.liveOf(id);
      const handle = await this.ensureHandle(id, { createWorktree: false });
      if (!handle || this.stopped) return;
      live.handle = handle;
      const entries = await handle.getTranscript().catch(() => []);
      if (entries.length) {
        this.deps.db().upsertTranscriptEntries(`task:${id}`, entries);
        this.deps.db().markTranscriptBackfilled(`task:${id}`);
      }
      let sawComplete = live.sawTaskComplete;
      let completedSummary = live.completeSummary;
      let lastAssistantText = live.lastMessage;
      for (const entry of entries) {
        if (entry.kind === "user" && !entry.source) {
          sawComplete = false;
          completedSummary = undefined;
        } else if (entry.kind === "assistant" && entry.text.trim()) {
          lastAssistantText = entry.text;
        } else if (entry.kind === "info" && (entry.text === "Finished" || entry.text.startsWith("Finished: "))) {
          sawComplete = true;
          completedSummary = entry.text.startsWith("Finished: ") ? entry.text.slice("Finished: ".length) : undefined;
        }
      }
      if (sawComplete) {
        this.clearSettle(live);
        live.sawTaskComplete = true;
        if (completedSummary) live.completeSummary = completedSummary;
        if (lastAssistantText) live.lastMessage = lastAssistantText;
        if (this.record(id).state !== "running") {
          this.update(id, { state: "running" });
        }
        await this.settle(id, false);
      } else if (!handle.resumed || !current.briefSent) {
        const rendered = renderBrief(current, this.deps.profileInstructions(current.profileId), this.deps.briefTemplate(), this.deps.memoryFor?.(current.repoId) ?? "");
        const brief = current.untrustedBrief ? `${rendered}\n\n${current.untrustedBrief}` : rendered;
        await handle.send(current.briefSent ? `${LOST_SESSION}\n\n${brief}` : brief);
        live.history = true;
        this.update(id, { briefSent: true });
      }
    } catch (err) {
      if (this.stopped) return;
      const current = this.record(id);
      if (!current || current.archived || !ACTIVE.has(current.state)) return;
      try {
        this.update(id, { state: "failed", error: `Failed to reconnect to cloud session: ${err instanceof Error ? err.message : String(err)}`, finishedAt: Date.now() });
      } catch {
        // The store is going away with ARIA: the task is looked at again at the next start.
      }
    }
  }

  /** Leaves task states as they are, so the next start finds the ones that were working and offers to resume them. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const live of this.live.values()) {
      this.clearSettle(live);
      // Permission requests nobody can answer anymore: the runtime is told the user isn't available.
      this.releasePending(live, "shutdown");
    }
    const lives = [...this.live.values()];
    // A worktree still being made or a message still being sent finishes first, so it's recorded (and not made or sent
    // again after a restart). A settle counting a task's changes ends too (it records nothing once ARIA stops): its git
    // would otherwise outlive ARIA in the worktree, which Windows can't delete while it's in use. Then the sessions
    // detach. All bounded: a session that never answers mustn't keep ARIA from quitting.
    await within(this.deps.stopWaitMs ?? STOP_WAIT_MS, async () => {
      await Promise.all(lives.flatMap((live) => [live.work, live.opening, live.settling]).map((busy) => busy?.catch(() => undefined)));
      await Promise.all(lives.map((live) => live.handle?.disconnect().catch(ignoreCleanupFailure)));
    });
  }
}

/** Waits for `work`, but no longer than `ms`: true when it finished in time (failing counts as finishing). */
export async function within(ms: number, work: () => Promise<unknown>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const finished = work().then(
    () => true,
    () => true,
  );
  const result = await Promise.race([finished, new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)))]);
  clearTimeout(timer);
  return result;
}
