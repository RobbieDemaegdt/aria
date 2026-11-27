/**
 * "Always allow this" and "Save as memory" in the window (PLAN.md §5.3): which transcript step an offer belongs to,
 * which entries are your own words, and what a note's form starts with. The engine decides and checks everything;
 * these only place the buttons.
 */
import type { Memory, MemoryState, RuleOffer, TranscriptEntry, YourWords } from "@aria/protocol";

/** A note is at most this long (the engine checks it again). */
export const MEMORY_MAX_CHARS = 300;

/** The note's form starts with the first line of your words, cut to the limit. */
export function memoryPrefill(text: string): string {
  const first = (text.trim().split(/\r?\n/)[0] ?? "").replace(/\s+/g, " ").trim();
  return first.length > MEMORY_MAX_CHARS ? first.slice(0, MEMORY_MAX_CHARS).trimEnd() : first;
}

/** What the form says before you save (the engine's check is the one that counts). */
export function memoryHint(text: string): string | undefined {
  const note = text.trim();
  if (!note) return "Write the note first.";
  if (/[\r\n]/.test(note)) return "Keep it to one line.";
  if (note.length > MEMORY_MAX_CHARS) return `Keep it to ${MEMORY_MAX_CHARS} characters (it has ${note.length}).`;
  if (note.includes("{{") || note.includes("}}")) return "Leave out {{ and }}: in a brief they read like a placeholder.";
  return undefined;
}

/**
 * The offer for a refused step: by the tool call it was for (the step itself, or the runtime's permission row for
 * it), else a permission row by its command. Each offer goes with one step only (`used`), and only offers for what a
 * rule of yours refused show on steps (an asked one is on its card).
 */
export function offerFor(entry: TranscriptEntry, offers: readonly RuleOffer[], used: Set<string>): RuleOffer | undefined {
  const refused = offers.filter((o) => o.decided === "never" && !used.has(o.id));
  let offer: RuleOffer | undefined;
  if (entry.kind === "permission" && entry.approved === false) {
    offer = refused.find((o) => o.toolCallId !== undefined && o.toolCallId === entry.toolCallId) ?? refused.find((o) => o.toolCallId === undefined && entry.detail.trim() === `Run ${o.command}`);
  } else if (entry.kind === "tool" && entry.success === false) {
    offer = refused.find((o) => o.toolCallId === entry.id);
  }
  if (offer) used.add(offer.id);
  return offer;
}

/**
 * Why a step with an offer was refused, in words: an offer on a step is only made for what your own Never rule refused,
 * and the offer names that rule (its `overrides`). "your rule “curl” (Never)".
 */
export function refusedBy(offer: Pick<RuleOffer, "overrides">): string {
  const rules = offer.overrides ?? [];
  if (rules.length === 0) return "a Never rule of yours";
  return `your ${rules.length === 1 ? "rule" : "rules"} ${rules.map((r) => `“${r.match}”`).join(", ")} (Never)`;
}

/** Your words a transcript entry shows (your message, or your answer to its question), if it's yours. */
export function yourWordsIn(entry: TranscriptEntry, words: readonly YourWords[]): YourWords | undefined {
  if (entry.kind === "user" && !entry.source) return [...words].reverse().find((w) => w.kind === "message" && w.text.trim() === entry.text.trim());
  if (entry.kind === "question" && entry.answer !== undefined) return [...words].reverse().find((w) => w.kind === "answer" && w.text.trim() === entry.answer!.trim());
  return undefined;
}

/** Where the note goes, in words: "This project (Moonrise)" or "Every project". */
export const scopeLabel = (memory: Pick<Memory, "scope" | "repoName">) => (memory.scope === "global" ? "Every project" : `This project (${memory.repoName ?? "a project that's gone"})`);

/** The notes a project's briefs leave out (they don't fit), for marking rows. */
export function leftOutIds(state: MemoryState, repoId: number | null): ReadonlySet<string> {
  return new Set(state.leftOut.find((entry) => entry.repoId === repoId)?.ids ?? []);
}

/** "17 Oct": when a note's words were written. */
export const shortDate = (at: number) => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
