/**
 * What a watch keeps (PLAN.md §4.6, §8): the row's columns are in store.ts, the rest is this JSON, checked when it's read
 * (a row that doesn't parse ends as "unreadable" instead of breaking the others). Every poll either commits as a whole
 * (its state and the ETags of the bodies it used, in one write) or not at all, so a 304 always means "what you have is
 * current".
 */
import type { CiCardPayload, PrCardPayload, WatchEndReason, WatchTone, WatchUntil } from "@aria/protocol";
import { z } from "zod";
import type { AttentionKind } from "../attention/attention.ts";
import type { Params, Route } from "../github/client.ts";

export const UNTIL = ["completed", "success", "checks", "merged", "forever"] as const satisfies readonly WatchUntil[];
export const TONES = ["running", "waiting", "ok", "bad", "paused", "ended"] as const satisfies readonly WatchTone[];
export const END_REASONS = ["completed", "success", "merged", "closed", "timed_out", "unwatched", "not_found", "no_access", "unreadable", "merged_into"] as const satisfies readonly WatchEndReason[];
export const KINDS = ["run", "pr", "branch", "inbox"] as const;
export type Kind = (typeof KINDS)[number];

const ConditionalSchema = z.object({ etag: z.string().max(500).optional(), lastModified: z.string().max(200).optional(), login: z.string().max(100) });
export type StoredConditional = z.infer<typeof ConditionalSchema>;

export const WatchDataSchema = z.object({
  owner: z.string().max(100).optional(),
  repo: z.string().max(100).optional(),
  repoName: z.string().max(200).optional(),
  /** Per kind (run.ts, pr.ts, branch.ts, inbox.ts). */
  target: z.record(z.string(), z.unknown()),
  state: z.record(z.string(), z.unknown()),
  until: z.enum(UNTIL),
  expiresAt: z.number().optional(),
  title: z.string().max(400),
  status: z.string().max(400),
  tone: z.enum(TONES),
  /** Per request (a key the kind names): the ETag and Last-Modified of the 200 the state came from, and as whom. */
  conditional: z.record(z.string(), ConditionalSchema),
  /** The GitHub login it was started as: under another one it's paused, not polled. */
  account: z.string().max(100).optional(),
  baselined: z.boolean(),
  nextPollAt: z.number(),
  pollIntervalMs: z.number().optional(),
  lastCheckedAt: z.number().optional(),
  /** Failed polls in a row (any kind of failure of its own): the back-off. */
  failures: z.number().optional(),
  /** 404s and 403s in a row, nothing else between: three end it (the inbox waits instead). */
  missing: z.number().optional(),
  lastError: z.string().max(400).optional(),
  pausedUntil: z.number().optional(),
  ended: z.object({ reason: z.enum(END_REASONS), by: z.enum(["you", "aria"]).optional() }).optional(),
});
export type WatchData = z.infer<typeof WatchDataSchema>;

/** What a kind's poll reads through: GitHub, conditionally, by a key per request (the ETag kept for it). */
export interface PollApi {
  get(key: string, route: Route, params: Params): Promise<{ changed: true; data: unknown } | { changed: false }>;
}

export interface PollContext {
  owner: string;
  repo: string;
  /** The project's name, else owner/repo. */
  repoName: string;
  until: WatchUntil;
  /** False on the poll that starts a watch: what's there already is its baseline, not news. */
  baselined: boolean;
  now: number;
  /** Your GitHub login (your own reviews aren't news). */
  you: string | undefined;
  /** A repository's name as you know it: the project's, else owner/repo. */
  nameFor(owner: string, repo: string): string;
}

/** Something a watch has to tell: a card, an attention event, a digest line. */
export interface WatchEvent {
  kind: AttentionKind;
  card: { cardType: "ci"; payload: Omit<CiCardPayload, "watchId"> } | { cardType: "pr"; payload: Omit<PrCardPayload, "watchId"> };
  toast: { title: string; body: string };
  /** The `<updates>` line, without the watch's id (added by the scheduler). GitHub's words only through digestText. */
  digest: string;
}

export interface PollOutcome {
  target?: Record<string, unknown>;
  state: Record<string, unknown>;
  /** Shown in the window and (quoted) to ARIA; may hold GitHub's words. */
  title?: string;
  /** ARIA's own words and numbers only (it reaches ARIA as is). */
  status: string;
  tone: WatchTone;
  events: WatchEvent[];
  end?: WatchEndReason;
  nextInMs: number;
  /** What it watches now has another key (a run waiting for the next one found it). */
  rekey?: string;
  url?: string;
}

/** success, neutral and skipped pass; everything else (failure, cancelled, timed_out, …) doesn't. */
export const passes = (conclusion: string | undefined) => conclusion === "success" || conclusion === "neutral" || conclusion === "skipped";

export const CONCLUSION_WORDS: Record<string, string> = {
  success: "succeeded",
  failure: "failed",
  cancelled: "was cancelled",
  timed_out: "timed out",
  action_required: "needs an approval",
  startup_failure: "failed to start",
  neutral: "finished (neutral)",
  skipped: "was skipped",
  stale: "went stale",
};
export const conclusionWords = (conclusion: string | undefined) => (conclusion ? (CONCLUSION_WORDS[conclusion] ?? "finished") : "finished");

/** "3 min", "1 h 05 min". */
export function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}
