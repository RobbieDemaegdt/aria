/** The inspector's view of ARIA's session (PLAN.md §5.3), grouped per message of yours. Pure, so it's unit-tested. */
import type { ConductorState, TranscriptEntry } from "@aria/protocol";
// The transcript helpers' own entry point: the protocol's main one would bundle zod and the IPC schemas.
import { startsTurn } from "@aria/protocol/transcript";

type UserEntry = Extract<TranscriptEntry, { kind: "user" }>;

export interface Turn {
  /** The message you typed; unset for what came before your first one. */
  message?: UserEntry;
  /** Everything after it until your next message, as shown (approved permission requests left out). */
  steps: Step[];
  /** Whether ARIA answered in words (it may still be working: it often writes a line, then calls a tool). */
  answered: boolean;
  /** When the last of it happened (a tool call counts until it ended). */
  endAt: number;
}

/** A step, with a policy refusal folded into the tool call it was about. */
export interface Step {
  entry: TranscriptEntry;
  refused?: string;
}

const endOf = (entry: TranscriptEntry) => entry.at + (entry.kind === "tool" ? (entry.ms ?? 0) : 0);

/**
 * Splits ARIA's session into turns, one per message you typed (the shared `startsTurn`, so the counts agree with the
 * engine's). ARIA's own policy decides its permission requests on the spot, so an approval would only repeat the tool
 * call: it's left out. A refusal shows on its tool call when it names one, else as a step of its own. The entries stay
 * the same objects, so a turn that didn't change can skip rendering (`sameTurn`).
 */
export function groupTurns(entries: readonly TranscriptEntry[]): Turn[] {
  const groups: Array<{ message?: UserEntry; entries: TranscriptEntry[] }> = [];
  for (const entry of entries) {
    if (entry.kind === "user" && startsTurn(entry)) groups.push({ message: entry, entries: [] });
    else if (groups.length === 0) groups.push({ entries: [entry] });
    else groups.at(-1)!.entries.push(entry);
  }
  return groups.map(({ message, entries: inTurn }) => {
    const tools = new Set(inTurn.filter((e) => e.kind === "tool").map((e) => e.id));
    const refusals = new Map<string, string>();
    for (const e of inTurn) if (e.kind === "permission" && e.approved === false && e.toolCallId && tools.has(e.toolCallId)) refusals.set(e.toolCallId, e.reason ?? "");
    const steps: Step[] = [];
    for (const e of inTurn) {
      if (e.kind === "permission" && (e.approved !== false || (e.toolCallId && tools.has(e.toolCallId)))) continue;
      const refused = e.kind === "tool" ? refusals.get(e.id) : undefined;
      steps.push(refused !== undefined ? { entry: e, refused } : { entry: e });
    }
    const endAt = Math.max(message?.at ?? 0, ...inTurn.map(endOf));
    return { ...(message ? { message } : {}), steps, answered: inTurn.some((e) => e.kind === "assistant"), endAt };
  });
}

/** Whether a turn shows the same as before: the same entries (by identity) in the same order. */
export function sameTurn(a: Turn, b: Turn): boolean {
  return (
    a.message === b.message &&
    a.answered === b.answered &&
    a.endAt === b.endAt &&
    a.steps.length === b.steps.length &&
    a.steps.every((step, i) => step.entry === b.steps[i]!.entry && step.refused === b.steps[i]!.refused)
  );
}

/**
 * The newest turn is still going while ARIA is busy, even after a first line of text (it often writes "Let me check
 * your calendar", then calls a tool). "Answered in" only once it's over.
 */
export function turnStatus(turn: Turn, last: boolean, busy: boolean): { working: boolean; tookMs?: number } {
  const working = last && busy;
  if (working || !turn.answered || !turn.message) return { working };
  return { working, tookMs: turn.endAt - turn.message.at };
}

/** A turn's time: just the time today, with the day before that (ARIA's session spans months). */
export function turnTime(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date(now).toDateString()) return time;
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return `${date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) })} ${time}`;
}

/** Whether two epoch ms timestamps fall on the same local calendar day. */
export function sameCalendarDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** Human-readable calendar day label for chat timeline date separators ("Today", "Yesterday", or "Thu, 5 Nov"). */
export function dayLabel(at: number, now = Date.now()): string {
  const date = new Date(at);
  const nowDate = new Date(now);
  if (date.toDateString() === nowDate.toDateString()) return "Today";
  const yesterday = new Date(nowDate);
  yesterday.setDate(nowDate.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  const sameYear = date.getFullYear() === nowDate.getFullYear();
  return date.toLocaleDateString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Full local date and time string for hover tooltips. */
export function fullDateTime(at: number): string {
  return new Date(at).toLocaleString([], {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * What to say while ARIA's conversation isn't open: above turns shown, that they're from before; with none shown yet
 * while it opens, that they come by themselves (not an error: nothing to retry). The header says "Opening the
 * conversation" then, so this says the same.
 */
export function connectionNote(state: ConductorState, shown: boolean): string | undefined {
  if (state === "starting") return shown ? "ARIA is opening its conversation: what's below is from before." : "ARIA is opening its conversation. This fills in when it's ready.";
  if (state === "error" && shown) return "ARIA isn't connected: what's below is from before it stopped.";
  return undefined;
}

/** How many update lines and waiting items a digest holds, for its collapsed row. */
export function digestSummary(digest: string): { updates: number; pending: number } {
  let block: "updates" | "pending" | undefined;
  let updates = 0;
  let pending = 0;
  for (const line of digest.split("\n")) {
    if (line.startsWith("<updates")) block = "updates";
    else if (line === "<pending>") block = "pending";
    else if (line === "</updates>" || line === "</pending>") block = undefined;
    else if (line.startsWith("- ") && block === "updates") {
      // "- (12 earlier updates left out: …)"
      const left = /^- \((\d+) earlier updates? left out/.exec(line);
      updates += left ? Number(left[1]) : 1;
    } else if (line.startsWith("- ") && block === "pending") pending++;
  }
  return { updates, pending };
}
