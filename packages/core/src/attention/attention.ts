/**
 * The attention engine (PLAN.md §4.5, §5.5, D24, D25): a priority per event, which toasts to show (nothing while you're
 * there; blocking ones whenever you're away, also in Focus mode; milestones when you're away and Focus mode is off), Done
 * toasts within 30 s coalesced into one, and the "while you were away" card on your return. Plain code, no model. The
 * shell only reports whether you're there and shows the toasts it's sent.
 */
import { randomUUID } from "node:crypto";
import type { AttentionSettings, AwayDigestPayload, AwayLine, CardItem, EngineEvent, TaskState } from "@aria/protocol";
import { isNoTracker } from "../trackers/none.ts";
import type { TaskTracker } from "../trackers/types.ts";
import type { Clock } from "./clock.ts";
import { formatPhonePushPayload } from "./phone.ts";

export type AttentionKind =
  | "question"
  | "permission"
  | "plan"
  | "budget"
  | "failed"
  | "interrupted"
  | "reminder"
  | "done"
  | "started"
  | "ci_success"
  | "ci_failure"
  | "review"
  | "review_request"
  | "pr_closed"
  | "pr_closed_yours"
  | "watch_ended"
  | "github_account"
  | "tracker_update"
  | "outlook_urgent"
  | "outlook_important";
export type Priority = "blocking" | "milestone" | "info" | "noise";

/**
 * Every kind's priority (§4.5): a new kind (ARIA's own answers, later) can't be added without one. Noise (tool calls,
 * intents, logs) never becomes an attention event; it stays in the session view. GitHub's news is milestones: a red CI
 * run too (D36: a card always, a toast when you're away and Focus mode is off, never "needs you"). A PR you merged or
 * closed yourself is only its card.
 */
export const PRIORITY: Record<AttentionKind, Priority> = {
  question: "blocking",
  permission: "blocking",
  plan: "blocking",
  budget: "blocking",
  failed: "blocking",
  interrupted: "blocking",
  reminder: "blocking",
  done: "milestone",
  started: "info",
  ci_success: "milestone",
  ci_failure: "milestone",
  review: "milestone",
  review_request: "milestone",
  pr_closed: "milestone",
  pr_closed_yours: "info",
  watch_ended: "milestone",
  github_account: "milestone",
  tracker_update: "milestone",
  outlook_urgent: "blocking",
  outlook_important: "milestone",
};

/** GitHub's kinds: the away card puts them in a group of their own. */
const GITHUB_KINDS: ReadonlySet<AttentionKind> = new Set(["ci_success", "ci_failure", "review", "review_request", "pr_closed", "pr_closed_yours", "watch_ended", "github_account"]);

export interface AttentionEvent {
  kind: AttentionKind;
  /** The toast's words. */
  title: string;
  body: string;
  /** The task it's about (none for the interrupted-tasks card or GitHub's news). */
  task?: { id: string; title: string; repoName: string };
  /** The watch it's about (GitHub's news); a tracker task's update has no watch ID unless its ID is a number. */
  watch?: { id?: number; title: string; repoName: string };
  /** Where it shows in the chat. */
  cardId?: string;
}

/** Something that waits for you now, with the card it shows on (from the task manager). */
export interface WaitingItem {
  kind: "question" | "permission" | "plan" | "budget" | "interrupted";
  /** The question's, permission request's or plan's own id (the away card tells whether it still waits). */
  itemId?: string;
  shortId?: string;
  taskId: string;
  title: string;
  repoName: string;
  text: string;
  cardId: string;
  /** Since when it waits (for the order). */
  at: number;
}

export const DEFAULT_ATTENTION: AttentionSettings = {
  focusMode: false,
  awayMinutes: 15,
  startAtLogin: false,
  startMinimized: true,
  quickPromptHotkey: true,
  spokenAnnouncements: "off",
  ttsProvider: "system",
  ttsRate: 1,
  sttProvider: "whisper.cpp",
  phonePushProvider: "off",
  phonePushScope: "blocking",
  ntfyServerUrl: "https://ntfy.sh",
  telegramEnabled: false,
  telegramOutboundScope: "all",
  telegramPollSeconds: 3,
  outlookWatchEnabled: true,
  outlookPollMinutes: 5,
  outlookTriageMode: "rules_and_utility",
  outlookVipSenders: [],
  outlookIgnoreSenders: [],
  autoUpdateCheck: true,
};

const SPOKEN_MAX_CHARS = 180;
const SPOKEN_STRIP_CHARS = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/gu;

function cleanSpeechFragment(raw: string, maxChars = 110): string {
  const cleaned = raw
    .replace(SPOKEN_STRIP_CHARS, " ")
    .replace(/https?:\/\/\S+/giu, "")
    .replace(/`{1,3}[^`]*`{1,3}/gu, " ")
    .replace(/[*_~#>[\]]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Formats a short, sanitized spoken announcement for an attention event (Phase 6D, PLAN.md §4.7, D69).
 * Strips control/invisible characters, markdown, and URLs, and omits raw error stack traces (`failed`) and external
 * GitHub review bodies (`review`, `review_request`, `pr_closed`).
 */
export function formatSpokenText(event: AttentionEvent): string {
  const taskName = cleanSpeechFragment(event.task?.title ?? event.title, 70) || "A task";
  const shortBody = cleanSpeechFragment(event.body, 90);
  let text: string;
  switch (event.kind) {
    case "done":
      text = shortBody ? `${taskName} is done. ${shortBody}` : `${taskName} is done.`;
      break;
    case "question":
      text = shortBody ? `${taskName} has a question: ${shortBody}` : `${taskName} has a question for you.`;
      break;
    case "permission":
      text = shortBody ? `${taskName} needs approval: ${shortBody}` : `${taskName} needs approval.`;
      break;
    case "plan":
      text = `${taskName} has a plan ready for review.`;
      break;
    case "budget":
      text = `${taskName} paused at its credit budget.`;
      break;
    case "failed":
      text = `${taskName} failed.`;
      break;
    case "interrupted":
      text = `${cleanSpeechFragment(event.title, 120) || "Tasks were interrupted"}.`;
      break;
    case "reminder":
      text = shortBody ? `Reminder: ${shortBody}` : cleanSpeechFragment(event.title, 120) || "Reminder.";
      break;
    case "ci_success":
    case "ci_failure":
    case "review":
    case "review_request":
    case "pr_closed":
    case "pr_closed_yours":
    case "watch_ended":
    case "github_account": {
      const title = cleanSpeechFragment(event.title, 110);
      const repo = event.watch?.repoName ? cleanSpeechFragment(event.watch.repoName, 50) : "";
      text = repo && !title.toLowerCase().includes(repo.toLowerCase()) ? `${title} in ${repo}.` : `${title}.`;
      break;
    }
    case "tracker_update":
    case "outlook_urgent":
    case "outlook_important": {
      const title = cleanSpeechFragment(event.title, 90);
      text = shortBody ? `${title}: ${shortBody}.` : `${title}.`;
      break;
    }
    default:
      text = cleanSpeechFragment(event.title, 120);
      break;
  }
  const normalized = text.replace(/\.\.+$/u, ".").trim();
  return normalized.length <= SPOKEN_MAX_CHARS ? normalized : `${normalized.slice(0, SPOKEN_MAX_CHARS - 1).trimEnd()}…`;
}

/** Done toasts within this long of the first become one. */
export const COALESCE_MS = 30_000;
/**
 * After an unlock, what waited for it toasts only if you're still away this long after: Windows gives a window the
 * focus back about 0.2 s after it reports the unlock (seen on real Windows), so an unlock back at ARIA would toast.
 */
export const UNLOCK_SETTLE_MS = 1_500;
/** Back for this long in a row: the away time so far no longer adds up (you've seen the chat). */
export const SETTLE_MS = 5 * 60_000;
/** Events of your present stretch kept for a while, for an away period that turns out to have started earlier (you went idle). */
const RECENT_MS = 15 * 60_000;
const RECENT_KEPT = 100;
const LINES_PER_KIND = 10;
const NAMES_SHOWN = 4;

export interface AttentionDeps {
  /** The task tracker: its name heads a task update with no project. */
  tracker(): TaskTracker;
  clock: Clock;
  settings(): AttentionSettings;
  emit(event: EngineEvent): void;
  addCard(card: CardItem): void;
  waiting(): WaitingItem[];
  /** The task's state now; undefined once it's gone (a discarded one gets no line). */
  taskState(taskId: string): TaskState | undefined;
  /** Whether a reminder card is still firing (not yet snoozed or marked done). */
  reminderActive?(cardId: string | undefined): boolean;
  /** Whether an Outlook email card is still in the timeline (not dismissed). */
  outlookCardActive?(cardId: string | undefined): boolean;
  /** Dispatches a phone push notification when away (Phase 8B, PLAN.md §4.7, D73). */
  phonePush?(event: {
    id: string;
    priority: "blocking" | "milestone";
    title: string;
    body: string;
    kind: AttentionKind;
    taskId?: string;
    cardId?: string;
    shortId?: string;
  }): void;
  /** Relays a blocking or milestone attention event to the two-way Telegram relay (Phase 8B, PLAN.md §4.7). */
  relayEvent?(event: AttentionEvent, priority: "blocking" | "milestone"): void;
  newId?: () => string;
}

interface Recorded {
  event: AttentionEvent;
  at: number;
  /** A milestone Focus mode kept from toasting: it makes the away card show on return, whatever the time away. */
  held: boolean;
}

interface AwayRecord {
  /** When the first away stretch began. */
  firstAt: number;
  /** When the current stretch began; unset while you're back. */
  since: number | undefined;
  /** Away time of the stretches that ended. */
  awayMs: number;
  events: Recorded[];
  settle: unknown;
}

const joinNames = (names: string[]) => {
  const shown = names.slice(0, NAMES_SHOWN);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : (shown[0] ?? "");
};

export class Attention {
  /** Unknown until the shell's first report: what comes before (the interrupted card at startup) waits for it. */
  private presence: "unknown" | "present" | "away" = "unknown";
  private stopped = false;
  private early: AttentionEvent[] = [];
  /** What came since you were last back: never what came while you were away (it toasted, or Focus mode held it). */
  private recent: Recorded[] = [];
  /** When you were last back: an away period that turns out to have started earlier can't start before it. */
  private backAt: number | undefined;
  private group: { firstId: string; items: AttentionEvent[]; timer: unknown } | undefined;
  private phoneGroup: { items: AttentionEvent[]; timer: unknown } | undefined;
  private away: AwayRecord | undefined;
  /**
   * The screen is locked. Windows drops a toast shown meanwhile at once, also from the notification panel (checked on
   * real Windows, Phase 9): nothing toasts, and what needs you toasts when you unlock, if you're still away and it still
   * waits. (Back at ARIA, its card shows it.)
   */
  private locked = false;
  private whileLocked: AttentionEvent[] = [];
  private unlockTimer: unknown;

  constructor(private readonly deps: AttentionDeps) {}

  isAway(): boolean {
    return this.presence === "away";
  }

  private id(): string {
    return this.deps.newId?.() ?? randomUUID();
  }

  /** An event from the task manager. */
  event(event: AttentionEvent): void {
    if (this.stopped) return;
    if (this.presence === "unknown") {
      this.early.push(event);
      return;
    }
    this.handle(event, this.deps.clock.now());
  }

  /**
   * Whether you're there (the window in front and focused, the screen unlocked, the PC awake, not idle). `at`: when it
   * changed, which can be earlier than now (you went idle a while ago). `locked`: away because the screen is locked.
   */
  setPresence(present: boolean, at = this.deps.clock.now(), locked = false): void {
    if (this.stopped) return;
    const unlocked = this.locked && !locked;
    this.locked = !present && locked;
    const first = this.presence === "unknown";
    const next = present ? "present" : "away";
    if (!first && next === this.presence) {
      // Unlocked, and still away from ARIA a moment later: what waited for the unlock toasts then.
      if (unlocked && next === "away") this.afterUnlock();
      return;
    }
    this.presence = next;
    const now = this.deps.clock.now();
    if (next === "away") this.leave(Math.max(Math.min(at, now), this.backAt ?? Number.NEGATIVE_INFINITY));
    else {
      this.backAt = now;
      this.recent = [];
      this.phoneGroup = undefined;
      const lockedEvents = unlocked ? this.whileLocked.splice(0) : [];
      this.whileLocked = [];
      this.back();
      if (lockedEvents.length > 0) {
        const waiting = new Set(this.deps.waiting().map((w) => w.cardId));
        for (const event of lockedEvents) {
          if (this.stillNeedsYou(event, waiting)) this.maybeSpeak(event, "blocking");
        }
      }
    }
    if (first) {
      const early = this.early;
      this.early = [];
      for (const event of early) this.handle(event, this.deps.clock.now());
    }
  }

  /** ARIA is quitting: nothing is shown anymore (tasks stopping now mustn't toast). */
  stop(): void {
    this.stopped = true;
    if (this.group) this.deps.clock.clearTimeout(this.group.timer);
    if (this.phoneGroup) this.deps.clock.clearTimeout(this.phoneGroup.timer);
    if (this.away?.settle) this.deps.clock.clearTimeout(this.away.settle);
    if (this.unlockTimer !== undefined) this.deps.clock.clearTimeout(this.unlockTimer);
    this.group = undefined;
    this.phoneGroup = undefined;
    this.away = undefined;
    this.early = [];
    this.whileLocked = [];
  }

  private handle(event: AttentionEvent, at: number): void {
    const priority = PRIORITY[event.kind];
    if (priority === "info" || priority === "noise") return;
    this.remember({ event, at, held: false });
    this.deps.relayEvent?.(event, priority);
    if (!this.locked) {
      this.maybeSpeak(event, priority);
    }
    // D25: nothing toasts while you're there; the card and the badge show it.
    if (this.presence !== "away") return;
    const focusMode = this.deps.settings().focusMode;
    const held = priority === "milestone" && focusMode;
    this.away?.events.push({ event, at, held });
    // D73: Phone push fires whenever away, including while the PC screen is locked.
    if (priority === "blocking") this.maybePhonePush(event, "blocking");
    else if (!focusMode) this.maybePhoneMilestone(event);
    if (this.locked) {
      // A desktop toast now would be dropped: what needs you waits for the unlock; a Done is in its card and the away card.
      if (priority === "blocking") this.whileLocked.push(event);
      return;
    }
    if (priority === "blocking") this.toast(event, "blocking");
    else if (!focusMode) this.milestone(event);
  }

  private maybePhonePush(event: AttentionEvent, priority: "blocking" | "milestone"): void {
    if (!this.deps.phonePush) return;
    const settings = this.deps.settings();
    const provider = settings.phonePushProvider ?? "off";
    if (provider === "off") return;
    const scope = settings.phonePushScope ?? "blocking";
    if (scope === "blocking" && priority !== "blocking") return;
    if (priority === "milestone" && settings.focusMode) return;
    const waitingItem = event.cardId ? this.deps.waiting().find((w) => w.cardId === event.cardId) : undefined;
    const formatted = formatPhonePushPayload(event, priority, waitingItem?.shortId);
    this.deps.phonePush({
      id: this.id(),
      priority,
      title: formatted.title,
      body: formatted.body,
      kind: event.kind,
      ...(event.task ? { taskId: event.task.id } : {}),
      ...(event.cardId ? { cardId: event.cardId } : {}),
      ...(waitingItem?.shortId ? { shortId: waitingItem.shortId } : {}),
    });
  }

  /** Coalesces milestone phone pushes over COALESCE_MS (30 s) so your phone is never flooded (D73). */
  private maybePhoneMilestone(event: AttentionEvent): void {
    if (!this.deps.phonePush) return;
    const settings = this.deps.settings();
    if ((settings.phonePushProvider ?? "off") === "off") return;
    if ((settings.phonePushScope ?? "blocking") !== "all" || settings.focusMode) return;
    if (this.phoneGroup) {
      this.phoneGroup.items.push(event);
      return;
    }
    const group = { items: [event], timer: undefined as unknown };
    group.timer = this.deps.clock.setTimeout(() => this.closePhoneGroup(group), COALESCE_MS);
    this.phoneGroup = group;
  }

  private closePhoneGroup(group: { items: AttentionEvent[] }): void {
    if (this.phoneGroup !== group) return;
    this.phoneGroup = undefined;
    if (this.presence !== "away" || this.stopped || this.deps.settings().focusMode) return;
    if (group.items.length === 1) {
      this.maybePhonePush(group.items[0]!, "milestone");
      return;
    }
    const first = group.items[0]!;
    const onlyDone = group.items.every((e) => e.kind === "done");
    this.maybePhonePush(
      {
        kind: first.kind,
        title: onlyDone ? `${group.items.length} tasks finished` : `${group.items.length} updates`,
        body: joinNames([...new Set(group.items.map((e) => e.task?.title ?? e.title))]),
        ...(first.task ? { task: first.task } : {}),
        ...(first.cardId ? { cardId: first.cardId } : {}),
      },
      "milestone",
    );
  }

  private maybeSpeak(event: AttentionEvent, priority: "blocking" | "milestone"): void {
    const settings = this.deps.settings();
    const scope = settings.spokenAnnouncements ?? "off";
    if (scope === "off") return;
    if (scope === "blocking" && priority !== "blocking") return;
    if (priority === "milestone" && settings.focusMode) return;
    const text = formatSpokenText(event);
    if (!text) return;
    this.deps.emit({
      type: "speak",
      id: this.id(),
      priority,
      text,
      ...(event.task ? { taskId: event.task.id } : {}),
      ...(event.cardId ? { cardId: event.cardId } : {}),
    });
  }

  /** Whether a blocking event still needs you: a question, permission or plan not answered, a failure not retried, or a reminder not yet done/snoozed. */
  private stillNeedsYou(event: AttentionEvent, waiting: ReadonlySet<string | undefined>): boolean {
    if (event.kind === "failed") return event.task !== undefined && this.deps.taskState(event.task.id) === "failed";
    if (event.kind === "reminder") return Boolean(this.deps.reminderActive?.(event.cardId));
    if (event.kind === "outlook_urgent") {
      return this.deps.outlookCardActive ? this.deps.outlookCardActive(event.cardId) : event.cardId !== undefined;
    }
    return event.cardId !== undefined && waiting.has(event.cardId);
  }

  private afterUnlock(): void {
    if (this.unlockTimer !== undefined) this.deps.clock.clearTimeout(this.unlockTimer);
    this.unlockTimer = this.deps.clock.setTimeout(() => {
      this.unlockTimer = undefined;
      // Back at ARIA by now, the list was cleared; locked again, it waits for the next unlock.
      if (this.presence === "away" && !this.locked && !this.stopped) this.showWhileLocked();
    }, UNLOCK_SETTLE_MS);
  }

  private showWhileLocked(): void {
    const waiting = new Set(this.deps.waiting().map((w) => w.cardId));
    for (const event of this.whileLocked.splice(0)) {
      if (this.stillNeedsYou(event, waiting)) {
        this.toast(event, "blocking");
        this.maybeSpeak(event, "blocking");
      }
    }
  }

  private remember(recorded: Recorded): void {
    this.recent = [...this.recent.filter((r) => recorded.at - r.at <= RECENT_MS), recorded].slice(-RECENT_KEPT);
  }

  private toast(event: AttentionEvent, priority: "blocking" | "milestone", extra: { replaces?: string } = {}): string {
    const id = this.id();
    this.deps.emit({
      type: "toast",
      id,
      priority,
      title: event.title,
      body: event.body,
      silent: priority === "milestone",
      ...(event.task ? { taskId: event.task.id } : {}),
      ...(event.cardId ? { cardId: event.cardId } : {}),
      ...extra,
    });
    return id;
  }

  /** The first Done toast shows at once; the ones within 30 s of it become one toast in its place (D24). */
  private milestone(event: AttentionEvent): void {
    if (this.group) {
      this.group.items.push(event);
      return;
    }
    const firstId = this.toast(event, "milestone");
    const group = { firstId, items: [event], timer: undefined as unknown };
    group.timer = this.deps.clock.setTimeout(() => this.closeGroup(group), COALESCE_MS);
    this.group = group;
  }

  private closeGroup(group: { firstId: string; items: AttentionEvent[] }): void {
    if (this.group !== group) return;
    this.group = undefined;
    // Back meanwhile, or Focus mode on: the cards are there for you. Locked: it would be dropped.
    if (group.items.length < 2 || this.presence !== "away" || this.locked || this.deps.settings().focusMode) return;
    const first = group.items[0]!;
    // Only Done toasts: "3 tasks finished" (D24); GitHub's news among them: "3 updates".
    const onlyDone = group.items.every((e) => e.kind === "done");
    this.toast(
      {
        kind: first.kind,
        title: onlyDone ? `${group.items.length} tasks finished` : `${group.items.length} updates`,
        // A task by its title; GitHub's news by its own toast's title (which says what happened where); each once.
        body: joinNames([...new Set(group.items.map((e) => e.task?.title ?? e.title))]),
        ...(first.task ? { task: first.task } : {}),
        ...(first.cardId ? { cardId: first.cardId } : {}),
      },
      "milestone",
      { replaces: group.firstId },
    );
  }

  private leave(at: number): void {
    const away = this.away ?? { firstAt: at, since: undefined, awayMs: 0, events: [], settle: undefined };
    if (away.settle) this.deps.clock.clearTimeout(away.settle);
    away.settle = undefined;
    away.since = at;
    this.away = away;
    // Gone since earlier than now (idle): what happened since then, while you seemed to be there, belongs in it too,
    // and what of it still needs you toasts now, as it would have (Focus mode lets it through too).
    // Never earlier than you were last back, and never what came while you were away before that: none of it toasts twice.
    if (at < this.deps.clock.now()) {
      const backfill = this.recent.filter((r) => r.at >= at);
      away.events.push(...backfill);
      const waiting = new Set(this.deps.waiting().map((w) => w.cardId));
      for (const { event } of backfill) {
        if (PRIORITY[event.kind] !== "blocking" || !this.stillNeedsYou(event, waiting)) continue;
        this.maybePhonePush(event, "blocking");
        if (this.locked) this.whileLocked.push(event);
        else this.toast(event, "blocking");
      }
    }
  }

  private back(): void {
    const away = this.away;
    if (!away || away.since === undefined) return;
    const now = this.deps.clock.now();
    away.awayMs += Math.max(0, now - away.since);
    away.since = undefined;
    const { awayMinutes } = this.deps.settings();
    const held = away.events.some((r) => r.held);
    const long = awayMinutes !== null && away.awayMs >= awayMinutes * 60_000;
    // Only news makes a card: an unchanged set of things waiting doesn't.
    if (away.events.length > 0 && (held || long)) {
      this.away = undefined;
      const card = this.card(away, now);
      if (card) this.deps.addCard(card);
      return;
    }
    // Not yet: it adds up over glances back, until you've stayed long enough to have seen the chat.
    away.settle = this.deps.clock.setTimeout(() => {
      if (this.away === away && this.presence === "present") this.away = undefined;
    }, SETTLE_MS);
  }

  private card(away: AwayRecord, now: number): CardItem | undefined {
    const lines: AwayLine[] = [];
    const more: Partial<Record<AwayLine["kind"], number>> = {};
    const add = (kind: AwayLine["kind"], items: AwayLine[], keep: "first" | "last") => {
      const shown = keep === "first" ? items.slice(0, LINES_PER_KIND) : items.slice(-LINES_PER_KIND);
      lines.push(...shown);
      if (items.length > shown.length) more[kind] = items.length - shown.length;
    };
    // What came while you were away: its card was in an event of the away period.
    const arrived = new Set(away.events.filter((r) => PRIORITY[r.event.kind] === "blocking" && r.event.cardId).map((r) => r.event.cardId));
    add(
      "needs_you",
      this.deps.waiting().map((w) => ({
        kind: "needs_you",
        taskId: w.taskId,
        title: w.title,
        repoName: w.repoName,
        text: w.text,
        cardId: w.cardId,
        waits: w.kind,
        ...(w.itemId ? { itemId: w.itemId } : {}),
        ...(w.shortId ? { shortId: w.shortId } : {}),
        ...(arrived.has(w.cardId) ? { isNew: true } : {}),
      })),
      "first",
    );
    for (const kind of ["failed", "done"] as const) {
      const items = away.events
        .filter((r) => r.event.kind === kind && r.event.task && this.deps.taskState(r.event.task.id) !== undefined)
        .map(({ event }) => ({ kind, taskId: event.task!.id, title: event.task!.title, repoName: event.task!.repoName, text: event.body, cardId: event.cardId ?? `task-${event.task!.id}` }));
      add(kind, items, "last");
    }
    // GitHub's news (a CI result, a review, a merge, a watch that stopped, another account): each line takes you to its card.
    const github: AwayLine[] = away.events
      .filter((r) => GITHUB_KINDS.has(r.event.kind) && r.event.cardId !== undefined && PRIORITY[r.event.kind] === "milestone")
      .map(({ event }) => ({ kind: "github", ...(event.watch ? { watchId: event.watch.id } : {}), title: event.title, repoName: event.watch?.repoName ?? "GitHub", text: event.body, cardId: event.cardId! }));
    add("github", github, "last");
    // Tracker task updates: each line takes you to its tracker_update card.
    const tracker: AwayLine[] = away.events
      .filter((r) => r.event.kind === "tracker_update" && r.event.cardId !== undefined && PRIORITY[r.event.kind] === "milestone")
      .map(({ event }) => ({
        kind: "tracker",
        title: event.title,
        repoName: event.watch?.repoName ?? (isNoTracker(this.deps.tracker()) ? "Task tracker" : this.deps.tracker().label),
        text: event.body,
        cardId: event.cardId!,
      }));
    add("tracker", tracker, "last");
    // Important Outlook emails: each line takes you to its outlook_mail card.
    const outlook: AwayLine[] = away.events
      .filter((r) => (r.event.kind === "outlook_urgent" || r.event.kind === "outlook_important") && r.event.cardId !== undefined)
      .map(({ event }) => ({
        kind: "outlook",
        title: event.title,
        repoName: event.watch?.repoName ?? "Outlook",
        text: event.body,
        cardId: event.cardId!,
      }));
    add("outlook", outlook, "last");
    if (lines.length === 0) return undefined;
    const payload: AwayDigestPayload = { since: away.firstAt, until: now, awayMs: away.awayMs, lines, ...(Object.keys(more).length ? { more } : {}) };
    return { kind: "card", id: `away-${this.id()}`, cardType: "away_digest", payload, createdAt: now };
  }
}
