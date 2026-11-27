/**
 * Transcript helpers shared by the engine and the window, so both count, cut and merge the same way. Its own entry point
 * (`@aria/protocol/transcript`), so the window doesn't bundle zod and the IPC schemas.
 */
import type { TranscriptEntry, TranscriptPage } from "./index.ts";

/** The most of your messages the inspector asks for, and the most the engine keeps for it. */
export const CONDUCTOR_TRANSCRIPT_MAX_TURNS = 1000;

/** Steps in a page of a task's transcript: the session view opens on one, and "Show more" adds one. */
export const TRANSCRIPT_PAGE = 200;

/** `start` moved back by whole pages until it takes in `focus` (an index, or -1), when that's before it. */
export function widenTo(start: number, focus: number, page = TRANSCRIPT_PAGE): number {
  if (focus < 0 || focus >= start) return start;
  return Math.max(0, start - Math.ceil((start - focus) / page) * page);
}

/**
 * Where the last page of `length` steps starts, moved back by whole pages until it takes in `focus`. The session view
 * counts its window the same way (`transcriptStart`), so a jump reads the steps it will show.
 */
export function pageStart(length: number, focus = -1, page = TRANSCRIPT_PAGE): number {
  return widenTo(Math.max(0, length - page), focus, page);
}

/** Whether a step wrote the task's plan file (the session view then has a Plan tab). */
export const writesPlan = (entry: TranscriptEntry): boolean => entry.kind === "tool" && Boolean(entry.args?.includes("plan.md"));

/**
 * A page of a task's steps (`all`, oldest first): the last `last` of them; or the `last` just before the step `before`
 * (the oldest one the window has); or, for a jump to the step `through`, from the page that holds it up to the newest.
 * A jump to the brief is the newest page: the brief comes with every page (`first`), and the window shows it above
 * them. A `before` that isn't there any more (the steps changed) throws: the window reads the session again.
 */
export function transcriptPage(all: readonly TranscriptEntry[], input: { last?: number | undefined; before?: string | undefined; through?: string | undefined }): TranscriptPage {
  const page = input.last ?? TRANSCRIPT_PAGE;
  let start: number;
  let end = all.length;
  if (input.before !== undefined) {
    end = all.findIndex((entry) => entry.id === input.before);
    if (end < 0) throw new Error("The session's steps changed since they were read: open it again.");
    start = Math.max(0, end - page);
  } else {
    const focus = input.through === undefined ? -1 : all.findIndex((entry) => entry.id === input.through);
    start = pageStart(end, focus === 0 && all[0]?.kind === "user" ? -1 : focus, page);
  }
  const first = all[0];
  return { entries: all.slice(start, end), omitted: start, ...(start > 0 && first ? { first } : {}), plan: all.some(writesPlan) };
}

/**
 * Whether this entry starts one of your turns in ARIA's inspector: a message you typed. A message the runtime added
 * itself (it has a `source`) is a step inside the turn it arrived in.
 */
export const startsTurn = (entry: TranscriptEntry): boolean => entry.kind === "user" && !entry.source;

/** Where the last `turns` of your messages start in `entries`, and how many of yours come before that. */
export function lastTurns(entries: readonly TranscriptEntry[], turns: number): { from: number; before: number } {
  const starts: number[] = [];
  entries.forEach((entry, i) => {
    if (startsTurn(entry)) starts.push(i);
  });
  if (starts.length <= turns) return { from: 0, before: 0 };
  return { from: starts[starts.length - turns]!, before: starts.length - turns };
}

/** Entries with a known id replace it; new ones go at the end. Entries that didn't change stay the same objects. */
export function mergeEntries(current: readonly TranscriptEntry[], entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  const next = [...current];
  const index = new Map(next.map((entry, i) => [entry.id, i]));
  for (const entry of entries) {
    const at = index.get(entry.id);
    if (at !== undefined) {
      next[at] = entry;
    } else {
      index.set(entry.id, next.length);
      next.push(entry);
    }
  }
  return next;
}
