/**
 * ARIA's digest (PLAN.md §4.3, §4.5): events don't each cost a Conductor turn. They collect as `<updates>` lines and
 * go along with your next message, once; what tasks wait for right now goes along as `<pending>`, with the short ids
 * you and ARIA use (Q-n, P-n, L-n, B-n).
 *
 * GitHub's news has a bucket of its own: one line per watch (its newest, with a count of the ones before), at most 8 per
 * message after the task lines, so a flapping branch or a busy inbox can't push a task's news out.
 */
import type { Store } from "../store/store.ts";
import type { PendingItem } from "../tasks/manager.ts";

const KEY = "digest.updates";
const GITHUB_KEY = "digest.github";
/** Update lines shown per message; older ones are summarized as a count. */
export const DIGEST_LINES = 20;
/** GitHub lines shown per message (one per watch). */
export const GITHUB_LINES = 8;
/** Lines kept while nobody writes to ARIA. */
const KEPT = 200;
const GITHUB_KEPT = 100;

/** The waiting lines, and the number of the first one (lines are numbered from the start, so draining is exact). */
interface Stored {
  first: number;
  lines: string[];
}

/** GitHub's lines: per watch and kind of news its newest, numbered so a line that came after the message was built stays. */
interface StoredGitHub {
  seq: number;
  entries: Array<{ key: string; line: string; earlier: number; seq: number }>;
}

/** What ARIA is sent: the digest in front of your words. The inspector splits a message of yours back the same way. */
export const withDigest = (text: string, digest?: string): string => (digest ? `${digest}\n\n${text}` : text);

export interface DigestBlock {
  /** The text to put before your message, if there's anything to tell. */
  text?: string;
  /** Drain up to here once the message is sent. */
  upTo: { updates: number; github: number };
}

export class Digest {
  constructor(private readonly deps: { db: () => Store; pending: () => PendingItem[] }) {}

  private stored(): Stored {
    const value = this.deps.db().getSetting<Stored>(KEY);
    return value && Array.isArray(value.lines) ? value : { first: 0, lines: [] };
  }

  private storedGitHub(): StoredGitHub {
    const value = this.deps.db().getSetting<StoredGitHub>(GITHUB_KEY);
    return value && Array.isArray(value.entries) && typeof value.seq === "number" ? { seq: value.seq, entries: value.entries.filter((e) => typeof e?.key === "string" && typeof e.line === "string") } : { seq: 0, entries: [] };
  }

  /** A line for the next digest. Kept in the database, so a restart doesn't lose it. */
  add(line: string): void {
    const { first, lines } = this.stored();
    const next = [...lines, line];
    const dropped = Math.max(0, next.length - KEPT);
    this.deps.db().setSetting(KEY, { first: first + dropped, lines: next.slice(dropped) });
  }

  /**
   * A watch's news: it replaces the line waiting with the same key (a watch and a kind of news: its CI, its reviews),
   * counted as an earlier update. So a flapping branch is one line, and a PR's checks and its review are two.
   */
  addGitHub(key: string, line: string): void {
    const { seq, entries } = this.storedGitHub();
    const before = entries.find((e) => e.key === key);
    const next = [...entries.filter((e) => e.key !== key), { key, line, earlier: before ? before.earlier + 1 : 0, seq: seq + 1 }].slice(-GITHUB_KEPT);
    this.deps.db().setSetting(GITHUB_KEY, { seq: seq + 1, entries: next });
  }

  build(): DigestBlock {
    const { first, lines } = this.stored();
    const github = this.storedGitHub();
    const pending = this.deps.pending();
    const parts: string[] = [];
    const shownGitHub = github.entries.slice(-GITHUB_LINES);
    const olderGitHub = github.entries.length - shownGitHub.length;
    if (lines.length > 0 || github.entries.length > 0) {
      const shown = lines.slice(-DIGEST_LINES);
      const older = lines.length - shown.length;
      parts.push(
        [
          "<updates since your last message>",
          ...(older > 0 ? [`- (${older} earlier update${older === 1 ? "" : "s"} left out: list_tasks has the current state)`] : []),
          ...shown.map((line) => `- ${line}`),
          ...(olderGitHub > 0 ? [`- (${olderGitHub} more GitHub update${olderGitHub === 1 ? "" : "s"} left out: list_watches has the current state)`] : []),
          ...shownGitHub.map((e) => `- ${e.line}${e.earlier > 0 ? ` (and ${e.earlier} earlier update${e.earlier === 1 ? "" : "s"} of it)` : ""}`),
          "</updates>",
        ].join("\n"),
      );
    }
    if (pending.length > 0) {
      parts.push(["<pending>", ...pending.map((item) => `- ${item.shortId}: "${item.title}" (${item.repoName}) ${item.text}`), "</pending>"].join("\n"));
    }
    return { ...(parts.length > 0 ? { text: parts.join("\n") } : {}), upTo: { updates: first + lines.length, github: github.seq } };
  }

  /** The lines a sent message carried are told; lines that came in meanwhile wait for the next one. */
  drain(upTo: DigestBlock["upTo"]): void {
    const { first, lines } = this.stored();
    const drop = Math.min(lines.length, upTo.updates - first);
    if (drop > 0) this.deps.db().setSetting(KEY, { first: first + drop, lines: lines.slice(drop) });
    const github = this.storedGitHub();
    const rest = github.entries.filter((e) => e.seq > upTo.github);
    if (rest.length !== github.entries.length) this.deps.db().setSetting(GITHUB_KEY, { seq: github.seq, entries: rest });
  }
}
