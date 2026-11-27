/**
 * "Save as memory" notes (PLAN.md §5.3, D23): one line of your own words each, for a project's task briefs or every
 * brief. A worker reads its brief as instructions, so a note is kept small and plain: one line of 1–300 characters,
 * no control or invisible characters (bidi overrides, tags, line and paragraph separators), no `{{` or `}}`; at most
 * 100 notes. A brief gets the project's notes newest first, then the global ones newest first, at most 30 lines and
 * 3,000 characters (the oldest are left out), framed as the user's notes.
 */
import type { Memory } from "@aria/protocol";

export const MEMORY_MAX_CHARS = 300;
export const MEMORIES_MAX = 100;
export const BRIEF_NOTES_MAX_LINES = 30;
export const BRIEF_NOTES_MAX_CHARS = 3_000;

/** Why a note can't be saved, or undefined when it can. */
export function memoryProblem(text: string): string | undefined {
  const note = text.trim();
  if (!note) return "Write the note first.";
  if (/[\r\n\u2028\u2029\u0085]/.test(note)) return "Keep it to one line.";
  if (note.length > MEMORY_MAX_CHARS) return `Keep it to ${MEMORY_MAX_CHARS} characters (it has ${note.length}).`;
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(note)) return "It has a control or invisible character in it: type it again without that.";
  if (note.includes("{{") || note.includes("}}")) return "Leave out {{ and }}: in a brief they read like a placeholder.";
  return undefined;
}

const newestFirst = (a: Memory, b: Memory) => b.createdAt - a.createdAt;

/**
 * The notes a brief gets for a project (null: one without notes of its own) and the ones that don't fit. Once one
 * doesn't fit, the older ones after it are left out too.
 */
export function briefNotes(memories: readonly Memory[], repoId: number | null): { shown: Memory[]; leftOut: Memory[] } {
  const own = repoId === null ? [] : memories.filter((m) => m.scope === "project" && m.repoId === repoId).sort(newestFirst);
  const global = memories.filter((m) => m.scope === "global").sort(newestFirst);
  const shown: Memory[] = [];
  const leftOut: Memory[] = [];
  let chars = 0;
  for (const memory of [...own, ...global]) {
    const length = memory.text.length + 3;
    if (leftOut.length === 0 && shown.length < BRIEF_NOTES_MAX_LINES && chars + length <= BRIEF_NOTES_MAX_CHARS) {
      shown.push(memory);
      chars += length;
    } else {
      leftOut.push(memory);
    }
  }
  return { shown, leftOut };
}

/** The brief's {{memory}} block: the user's notes between two `---` lines, or nothing without notes. */
export function memoryBlock(notes: readonly Memory[]): string {
  if (notes.length === 0) return "";
  return ["Notes from the user (saved in ARIA, in their own words)", "---", ...notes.map((m) => `- ${m.text}`), "---"].join("\n");
}

function formatConductorLine(memory: Memory): string {
  return memory.scope === "project" && memory.repoName ? `- [${memory.repoName}] ${memory.text}` : `- ${memory.text}`;
}

/**
 * The notes ARIA's own system prompt gets (Phase 6A, completing D23): global notes newest first, then non-hidden
 * project notes newest first, at most 30 lines and 3,000 characters. Notes for hidden or deleted projects stay out.
 */
export function conductorNotes(
  memories: readonly Memory[],
  visibleRepoIds?: ReadonlySet<number>,
): { shown: Memory[]; leftOut: Memory[] } {
  const global = memories.filter((m) => m.scope === "global").sort(newestFirst);
  const project = memories
    .filter(
      (m) =>
        m.scope === "project" &&
        m.repoId !== undefined &&
        Boolean(m.repoName) &&
        (!visibleRepoIds || visibleRepoIds.has(m.repoId)),
    )
    .sort(newestFirst);
  const shown: Memory[] = [];
  const leftOut: Memory[] = [];
  let chars = 0;
  for (const memory of [...global, ...project]) {
    const line = formatConductorLine(memory);
    const length = line.length + 1;
    if (leftOut.length === 0 && shown.length < BRIEF_NOTES_MAX_LINES && chars + length <= BRIEF_NOTES_MAX_CHARS) {
      shown.push(memory);
      chars += length;
    } else {
      leftOut.push(memory);
    }
  }
  return { shown, leftOut };
}

/** The Conductor system prompt's {{memory}} block: global and [Project] notes between `---` lines, or empty string. */
export function conductorMemoryBlock(notes: readonly Memory[]): string {
  if (notes.length === 0) return "";
  return ["Notes from the user (saved in ARIA, in their own words)", "---", ...notes.map(formatConductorLine), "---"].join("\n");
}

const STOPWORDS = new Set([
  "in",
  "on",
  "at",
  "to",
  "of",
  "by",
  "as",
  "or",
  "if",
  "is",
  "be",
  "do",
  "no",
  "so",
  "up",
  "we",
  "it",
  "my",
  "me",
  "an",
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "have",
  "has",
  "had",
  "are",
  "was",
  "were",
  "will",
  "would",
  "should",
  "could",
  "can",
  "may",
  "not",
  "but",
  "all",
  "any",
  "our",
  "your",
  "their",
  "its",
  "when",
  "where",
  "what",
  "which",
  "who",
  "how",
  "why",
  "about",
  "over",
  "under",
  "after",
  "before",
  "between",
  "through",
  "during",
  "also",
  "only",
  "just",
  "more",
  "most",
  "some",
  "such",
  "than",
  "too",
  "very",
  "every",
  "each",
  "always",
  "never",
  "use",
  "uses",
  "using",
  "remember",
  "memory",
  "memories",
  "note",
  "notes",
  "save",
  "prefer",
  "preference",
  "project",
  "projects",
  "repo",
  "repository",
  "task",
  "tasks",
]);

function contentTokens(text: string, excludeText?: string): string[] {
  const excluded = new Set(
    excludeText
      ? [...excludeText.toLowerCase().matchAll(/[\p{L}\p{N}_.-]{2,}/gu)].map((m) => m[0])
      : [],
  );
  const tokens = [...text.toLowerCase().matchAll(/[\p{L}\p{N}_.-]{2,}/gu)]
    .map((m) => m[0])
    .filter((w) => !STOPWORDS.has(w) && !excluded.has(w));
  return [...new Set(tokens)];
}

const REMEMBER_CUE =
  /\b(remember|memor(?:y|ies|ize|ise)|note|save|keep in mind|prefer|preference|always|never|from now on|default to)\b/iu;

const NEGATED_REMEMBER_CUE =
  /\b(?:don't|do not|never|stop)\b[\s\S]{0,40}\b(?:remember(?:ing)?|memor(?:ize|ise)|save|saving|note|keep(?:ing)?)\b/iu;

const FORGET_CUE =
  /\b(?:forget|stop remembering|don't remember|do not remember|no longer remember)\b|\b(?:remove|delete|drop|clear|erase)\b[\s\S]{0,50}\b(?:memor(?:y|ies)|notes?|preferences?|facts?)\b|\b(?:memor(?:y|ies)|notes?|preferences?|facts?)\b[\s\S]{0,50}\b(?:remove|delete|drop|clear|erase)\b/iu;

/**
 * Injection guard for `remember` (D63): ensures the proposed memory is grounded in the user's own latest message
 * rather than instructions inside untrusted files, mails, issues, or tool results.
 * Requires an explicit save/preference cue (not negated) AND majority content-token grounding from `lastUserMessage`.
 */
export function assertMemoryGrounded(lastUserMessage: string, text: string, repoName?: string): void {
  const user = lastUserMessage.trim().toLowerCase();
  if (!user || NEGATED_REMEMBER_CUE.test(lastUserMessage)) {
    throw new Error("Not saved: ARIA only saves a memory when the user states it or asks to remember it in their own message.");
  }
  const userWords = new Set([...user.matchAll(/[\p{L}\p{N}_.-]{2,}/gu)].map((m) => m[0]));
  const tokens = contentTokens(text, repoName);
  const matched = tokens.filter((t) => userWords.has(t)).length;
  const hasCue = REMEMBER_CUE.test(lastUserMessage);
  const requiredMatches = tokens.length <= 1 ? tokens.length : Math.max(1, Math.ceil(tokens.length * 0.6));
  const ok =
    tokens.length === 0
      ? hasCue
      : hasCue
        ? matched >= requiredMatches
        : tokens.length >= 2 && matched === tokens.length;
  if (!ok) {
    throw new Error("Not saved: ARIA only saves a memory when the user states it or asks to remember it in their own message.");
  }
}

/**
 * Injection guard for `forget` (D63): requires an explicit forget/remove cue in the user's latest message and token
 * or ID overlap with the target memory.
 */
export function assertForgetGrounded(lastUserMessage: string, target: Pick<Memory, "id" | "text" | "repoName">): void {
  const user = lastUserMessage.trim().toLowerCase();
  if (!user || !FORGET_CUE.test(lastUserMessage)) {
    throw new Error("Not removed: ARIA only forgets a memory when the user asks to forget or remove it in their own message.");
  }
  const userWords = new Set([...user.matchAll(/[\p{L}\p{N}_.-]{2,}/gu)].map((m) => m[0]));
  const tokens = contentTokens(target.text);
  const matchedToken = tokens.some((t) => userWords.has(t));
  const matchedId = userWords.has(target.id.toLowerCase()) || user.includes(target.id.toLowerCase());
  const matchedRepo = target.repoName ? user.includes(target.repoName.toLowerCase()) : false;
  const explicitRepoMemoryRef = /\b(memor(?:y|ies)|notes?|preferences?)\b/iu.test(lastUserMessage);
  if (!matchedToken && !matchedId && !(matchedRepo && explicitRepoMemoryRef)) {
    throw new Error("Not removed: ARIA only forgets a memory when the user asks to forget or remove it in their own message.");
  }
}

