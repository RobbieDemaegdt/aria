/**
 * How the chat ties a session's updates together (docs/chat-declutter-proposal.md, options 2a and 3-lite): which
 * session or watch a timeline item belongs to, back-to-back items of one session drawn as one run with that session's
 * colour, and what still waits on you for the "need you" button. Pure, unit-tested.
 */
import type { CardItem, Task, TimelineItem } from "@aria/protocol";

export interface SessionOwner {
  key: string;
  taskId?: string;
  watchId?: number;
}

/** Identifies which task session or watch a timeline card/notice belongs to ("notices" for a notice of no session). */
export function sessionOwnerKey(item: TimelineItem): SessionOwner | undefined {
  if (item.kind === "notice") {
    return item.taskId ? { key: `task:${item.taskId}`, taskId: item.taskId } : { key: "notices" };
  }
  if (item.kind === "card") {
    const p = item.payload as { taskId?: unknown; watchId?: unknown };
    if (typeof p.taskId === "string" && p.taskId) return { key: `task:${p.taskId}`, taskId: p.taskId };
    if (typeof p.watchId === "number") return { key: `watch:${p.watchId}`, watchId: p.watchId };
  }
  return undefined;
}

/** A session's owner, or nothing for chat messages and notices that belong to no session. */
function runOwner(item: TimelineItem): SessionOwner | undefined {
  const owner = sessionOwnerKey(item);
  return owner && owner.key !== "notices" ? owner : undefined;
}

export type TimelineSegment = { kind: "item"; item: TimelineItem } | { kind: "run"; owner: SessionOwner; items: TimelineItem[] };

/**
 * The timeline as segments: back-to-back items of one session or watch become one run (even a run of one, so every
 * session's items carry its colour), and the rest stay single. A run never crosses a day divider.
 */
export function sessionRuns(items: readonly TimelineItem[], sameDay: (a: number, b: number) => boolean): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  let run: Extract<TimelineSegment, { kind: "run" }> | undefined;
  for (const item of items) {
    const owner = runOwner(item);
    const last = run?.items[run.items.length - 1];
    if (owner && run && run.owner.key === owner.key && last && sameDay(last.createdAt, item.createdAt)) {
      run.items.push(item);
      continue;
    }
    if (owner) {
      run = { kind: "run", owner, items: [item] };
      segments.push(run);
    } else {
      run = undefined;
      segments.push({ kind: "item", item });
    }
  }
  return segments;
}

/** The session colours, as whole class names so Tailwind finds them. Red and amber stay for "needs you" and warnings. */
export const SESSION_COLORS = [
  { stripe: "border-l-sky-400", dot: "bg-sky-400" },
  { stripe: "border-l-violet-400", dot: "bg-violet-400" },
  { stripe: "border-l-teal-400", dot: "bg-teal-400" },
  { stripe: "border-l-pink-400", dot: "bg-pink-400" },
  { stripe: "border-l-lime-300", dot: "bg-lime-300" },
  { stripe: "border-l-indigo-300", dot: "bg-indigo-300" },
  { stripe: "border-l-fuchsia-300", dot: "bg-fuchsia-300" },
  { stripe: "border-l-cyan-200", dot: "bg-cyan-200" },
] as const;

/**
 * Each session's colour, by the order sessions first show up in the timeline: sessions that start one after the other
 * (the ones whose updates get mixed together) always get different colours.
 */
export function sessionColorIndex(timeline: readonly TimelineItem[]): Map<string, number> {
  const colors = new Map<string, number>();
  for (const item of timeline) {
    const owner = runOwner(item);
    if (owner && !colors.has(owner.key)) colors.set(owner.key, colors.size % SESSION_COLORS.length);
  }
  return colors;
}

/** Cards that wait for your decision but belong to no waiting task: they count on top of the tasks that need you. */
const DECISION_CARDS = new Set<CardItem["cardType"]>(["profile_proposal", "action_request", "pr_confirm", "fix_proposal", "workflow_dispatch"]);

/**
 * The cards in the timeline that still wait for you, oldest first: a task's open question, permission, plan or budget
 * pause, the restart card of a task that's still interrupted, and proposals and requests nobody decided yet.
 */
export function pendingCards(timeline: readonly TimelineItem[], tasks: readonly Task[]): CardItem[] {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  // Only a task's newest budget card, and the newest restart card a task is on, still stand for its pause.
  const newestBudget = new Map<string, string>();
  const newestInterrupted = new Map<string, string>();
  for (const item of timeline) {
    if (item.kind !== "card") continue;
    if (item.cardType === "task_budget") newestBudget.set(item.payload.taskId, item.id);
    if (item.cardType === "tasks_interrupted") for (const id of item.payload.taskIds) newestInterrupted.set(id, item.id);
  }
  const pending: CardItem[] = [];
  for (const item of timeline) {
    if (item.kind !== "card") continue;
    const waits = (() => {
      switch (item.cardType) {
        case "task_question":
          return taskById.get(item.payload.taskId)?.question?.id === item.payload.questionId;
        case "task_permission":
          return taskById.get(item.payload.taskId)?.permissions?.some((p) => p.id === item.payload.permissionId) === true;
        case "task_plan":
          return taskById.get(item.payload.taskId)?.plan?.id === item.payload.planId;
        case "task_budget":
          return taskById.get(item.payload.taskId)?.state === "waiting_budget" && newestBudget.get(item.payload.taskId) === item.id;
        case "tasks_interrupted":
          return item.payload.taskIds.some((id) => taskById.get(id)?.state === "interrupted" && newestInterrupted.get(id) === item.id);
        case "profile_proposal":
          return !item.payload.decision;
        case "action_request":
        case "pr_confirm":
        case "fix_proposal":
        case "workflow_dispatch":
          return item.payload.status === "pending";
        default:
          return false;
      }
    })();
    if (waits) pending.push(item);
  }
  return pending;
}

/** Where the "need you" button can take you: a card, or the session of a task whose waiting card isn't in the chat. */
export interface NeedsYouTarget {
  cardId?: string;
  taskId?: string;
}

/**
 * What the "need you" button counts and where it jumps: every task that needs you plus every proposal or request still
 * waiting (the count), and the waiting cards oldest first, then the waiting tasks that have no card in the chat (the
 * jumps).
 */
export function needsYou(timeline: readonly TimelineItem[], tasks: readonly Task[], taskNeedsYou: (t: Task) => boolean): { count: number; targets: NeedsYouTarget[] } {
  const cards = pendingCards(timeline, tasks);
  const waitingTasks = tasks.filter(taskNeedsYou);
  const covered = new Set<string>();
  const targets: NeedsYouTarget[] = cards.map((card) => {
    const owner = sessionOwnerKey(card);
    if (owner?.taskId) covered.add(owner.taskId);
    if (card.cardType === "tasks_interrupted") for (const id of card.payload.taskIds) covered.add(id);
    return { cardId: card.id, ...(owner?.taskId ? { taskId: owner.taskId } : {}) };
  });
  for (const task of waitingTasks) if (!covered.has(task.id)) targets.push({ taskId: task.id });
  const decisions = cards.filter((c) => DECISION_CARDS.has(c.cardType)).length;
  return { count: waitingTasks.length + decisions, targets };
}

/** The target after `last` (wrapping round), or the first one when `last` isn't among them anymore. */
export function nextTarget(targets: readonly NeedsYouTarget[], last: string | null): NeedsYouTarget | undefined {
  if (targets.length === 0) return undefined;
  const at = last === null ? -1 : targets.findIndex((t) => targetKey(t) === last);
  return targets[(at + 1) % targets.length];
}

export const targetKey = (t: NeedsYouTarget) => t.cardId ?? `task:${t.taskId}`;
