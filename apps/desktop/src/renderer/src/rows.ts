/**
 * The sidebar's rows under a project (PLAN.md §5.2: needs you, running, queued, watching, done), the project's marks,
 * the live strip's watch chips, where a watch row's click goes (D39), and My work's sections. Pure, unit-tested.
 */
import type { MyWorkItem, MyWorkReason, Task, TaskState, TimelineItem, Watch, WatchTone } from "@aria/protocol";

/** How long an ended watch stays among a project's rows ("Show older" after that). */
export const ENDED_SHOWN_MS = 86_400_000;

/** Sessions first by what they need (§5.2), the active watches after the queued sessions, the finished sessions last. */
const TASK_RANK: Record<TaskState, number> = {
  waiting_input: 0,
  waiting_permission: 0,
  waiting_plan: 0,
  waiting_budget: 0,
  interrupted: 1,
  starting: 2,
  running: 2,
  queued: 3,
  done: 5,
  failed: 6,
  cancelled: 7,
};
const WATCH_RANK = 4;
const ENDED_WATCH_RANK = 8;

export type Row = { kind: "task"; task: Task } | { kind: "watch"; watch: Watch };

/** A project's watches: what's watched for it now, and what ended in the last day (the inbox belongs to no project). */
export function projectWatches(watches: readonly Watch[], projectId: number, now: number): Watch[] {
  return watches.filter((w) => w.kind !== "inbox" && w.repoId === projectId && (w.state === "active" || (w.endedAt !== undefined && now - w.endedAt < ENDED_SHOWN_MS)));
}

export function rows(tasks: readonly Task[], watches: readonly Watch[]): Row[] {
  const rank = (row: Row) => (row.kind === "task" ? TASK_RANK[row.task.state] : row.watch.state === "active" ? WATCH_RANK : ENDED_WATCH_RANK);
  const created = (row: Row) => (row.kind === "task" ? row.task.createdAt : row.watch.createdAt);
  return [...tasks.map((task): Row => ({ kind: "task", task })), ...watches.map((watch): Row => ({ kind: "watch", watch }))].sort((a, b) => rank(a) - rank(b) || created(b) - created(a));
}

/** What a collapsed project row shows: a red dot when something needs you; a quiet ✗ for a red watch (D36: not "needs you"). */
export function projectMarks(tasks: readonly Task[], watches: readonly Watch[], needsYou: (t: Task) => boolean, isActive: (t: Task) => boolean) {
  const active = watches.filter((w) => w.state === "active");
  return {
    needsYou: tasks.some(needsYou),
    busy: tasks.some(isActive) || active.some((w) => w.tone === "running"),
    red: active.some((w) => w.tone === "bad"),
  };
}

/** Expanded until you collapse it: a project with sessions or active watches. */
export const expandedByDefault = (tasks: readonly Task[], watches: readonly Watch[]) => tasks.length > 0 || watches.some((w) => w.state === "active");

/** A watch row's icon. */
export const WATCH_ICON: Record<WatchTone, "watching" | "ok" | "bad" | "paused" | "ended"> = { running: "watching", waiting: "watching", ok: "ok", bad: "bad", paused: "paused", ended: "ended" };

/** The short status a row shows as text (not only in its `title`): why it waits, else what it's at. */
export const watchStatus = (watch: Watch) => watch.paused ?? watch.status;

/** The watch's newest card in the timeline the window has. */
export function newestWatchCard(timeline: readonly TimelineItem[], watchId: number): string | undefined {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i]!;
    if (item.kind === "card" && (item.payload as { watchId?: unknown }).watchId === watchId) return item.id;
  }
  return undefined;
}

/** D39: a watch row's click goes to its newest card; with none, My work, at that watch's item. */
export function watchTarget(timeline: readonly TimelineItem[], watchId: number): { cardId: string } | { myWork: number } {
  const cardId = newestWatchCard(timeline, watchId);
  return cardId ? { cardId } : { myWork: watchId };
}

/** Live strip chips for watches: each running one, and each red one until you've seen its newest card. */
export function watchChips(watches: readonly Watch[], timeline: readonly TimelineItem[], seen: ReadonlySet<string>): Watch[] {
  return watches.filter((w) => {
    if (w.state !== "active" || w.kind === "inbox") return false;
    if (w.tone === "running") return true;
    if (w.tone !== "bad") return false;
    const card = newestWatchCard(timeline, w.id);
    return card === undefined ? !seen.has(`w:${w.id}`) : !seen.has(card);
  });
}

export const MY_WORK_SECTIONS: Array<{ reason: MyWorkReason; title: string }> = [
  { reason: "review_requested", title: "Waiting for your review" },
  { reason: "authored", title: "Your pull requests" },
  { reason: "assigned", title: "Assigned to you" },
];

/** My work's items of one section, grouped by project (projects by their newest item), newest first in each. */
export function sectionGroups(items: readonly MyWorkItem[], reason: MyWorkReason): Array<{ repoId: number; repoName: string; items: MyWorkItem[] }> {
  const groups = new Map<number, { repoId: number; repoName: string; items: MyWorkItem[] }>();
  for (const item of [...items].filter((i) => i.why.includes(reason)).sort((a, b) => b.updatedAt - a.updatedAt)) {
    const group = groups.get(item.repoId) ?? { repoId: item.repoId, repoName: item.repoName, items: [] };
    group.items.push(item);
    groups.set(item.repoId, group);
  }
  return [...groups.values()];
}

export function sameMyWorkItem(a: MyWorkItem, b: MyWorkItem): boolean {
  return (
    a.key === b.key &&
    a.kind === b.kind &&
    a.owner === b.owner &&
    a.repo === b.repo &&
    a.repoId === b.repoId &&
    a.repoName === b.repoName &&
    a.number === b.number &&
    a.title === b.title &&
    a.author === b.author &&
    a.draft === b.draft &&
    a.updatedAt === b.updatedAt &&
    a.url === b.url &&
    a.watchId === b.watchId &&
    a.why.length === b.why.length &&
    a.why.every((w, i) => w === b.why[i])
  );
}

/**
 * Reconciles a list by key in place: removes items that are gone, leaves unchanged items in their exact position and
 * object reference, updates modified items in place, and appends new items.
 */
export function reconcileByKey<T>(
  prev: readonly T[],
  next: readonly T[],
  getKey: (item: T) => string | number,
  isSame: (a: T, b: T) => boolean,
): T[] {
  if (prev.length === 0) return [...next];
  const nextByKey = new Map<string | number, T>();
  for (const item of next) nextByKey.set(getKey(item), item);
  const keptKeys = new Set<string | number>();
  const result: T[] = [];
  for (const existing of prev) {
    const k = getKey(existing);
    const candidate = nextByKey.get(k);
    if (!candidate) continue;
    keptKeys.add(k);
    result.push(isSame(existing, candidate) ? existing : candidate);
  }
  for (const item of next) {
    const k = getKey(item);
    if (!keptKeys.has(k)) result.push(item);
  }
  return result;
}

/**
 * Reconciles a My work section's project groups in place across syncs:
 * - Deletes only items (and empty project groups) that are actually gone.
 * - Keeps unchanged items in their exact existing order and reference so nothing jumps under the cursor.
 * - Updates changed items in place and adds new items/groups.
 */
export function reconcileSectionGroups(
  prevGroups: ReadonlyArray<{ repoId: number; repoName: string; items: MyWorkItem[] }>,
  items: readonly MyWorkItem[],
  reason: MyWorkReason,
): Array<{ repoId: number; repoName: string; items: MyWorkItem[] }> {
  if (prevGroups.length === 0) return sectionGroups(items, reason);
  const matching = items.filter((i) => i.why.includes(reason));
  if (matching.length === 0) return [];
  const byRepo = new Map<number, { repoId: number; repoName: string; items: MyWorkItem[] }>();
  for (const item of matching) {
    const group = byRepo.get(item.repoId) ?? { repoId: item.repoId, repoName: item.repoName, items: [] };
    group.items.push(item);
    byRepo.set(item.repoId, group);
  }
  const seenRepos = new Set<number>();
  const result: Array<{ repoId: number; repoName: string; items: MyWorkItem[] }> = [];
  for (const prevGroup of prevGroups) {
    const nextGroup = byRepo.get(prevGroup.repoId);
    if (!nextGroup) continue;
    seenRepos.add(prevGroup.repoId);
    const reconciledItems = reconcileByKey(prevGroup.items, nextGroup.items, (i) => i.key, sameMyWorkItem);
    const unchangedGroup =
      prevGroup.repoName === nextGroup.repoName &&
      reconciledItems.length === prevGroup.items.length &&
      reconciledItems.every((item, idx) => item === prevGroup.items[idx]);
    result.push(unchangedGroup ? prevGroup : { repoId: nextGroup.repoId, repoName: nextGroup.repoName, items: reconciledItems });
  }
  for (const freshGroup of sectionGroups(matching, reason)) {
    if (!seenRepos.has(freshGroup.repoId)) {
      result.push(freshGroup);
    }
  }
  return result;
}

/** The My work item a watch is about (a PR watch's PR), if the list has it. */
export function itemOfWatch(items: readonly MyWorkItem[], watch: Watch): MyWorkItem | undefined {
  return items.find((i) => i.watchId === watch.id);
}
