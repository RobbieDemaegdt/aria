/**
 * The GitHub watchers (PLAN.md §4.6): plain code, no model. Watches live in the database and survive a restart
 * (§4.10). One fixed tick (and a resume of the PC) polls whatever is due, at most 3 at a time; GitHub's pauses (offline,
 * rate limits, a refused token) hold everything back without counting against a watch. A poll commits as a whole: its
 * state and the ETags it used in one write, or nothing (so a 304 always means "what you have is current"). Then come its
 * cards, attention events and digest lines.
 *
 * Who may start what (the Conductor is read-only, D19, D22, and a watch it starts is fed by other people's words):
 * ARIA only your projects' repositories, never without an end (`forever`), for at most 7 days, 20 at a time. You can
 * also watch a branch's health and the inbox for good. A watch belongs to the GitHub login it was started as: under
 * another one it's paused, not polled (so a `gh auth switch` doesn't end your watches with 404s).
 */
import { randomUUID } from "node:crypto";
import type { CardItem, EngineEvent, GitHubState, Watch, WatchEndReason, WatchKind, WatchUntil } from "@aria/protocol";
import type { AttentionEvent } from "../attention/attention.ts";
import type { Clock } from "../attention/clock.ts";
import type { GitHubAccess } from "../github/access.ts";
import { GitHubFailure, type Params, type Route } from "../github/client.ts";
import { digestText, githubText, id as asId, links, repoKey, validName } from "../github/text.ts";
import type { Store, WatchRow } from "../store/store.ts";
import { BranchStateSchema, BranchTargetSchema, branchKey, pollBranch } from "./branch.ts";
import { InboxStateSchema, InboxTargetSchema, pollInbox } from "./inbox.ts";
import { PrStateSchema, PrTargetSchema, pollPr, prKey } from "./pr.ts";
import { nextRunKey, ownRun, pollRun, RunStateSchema, RunTargetSchema, runKey, runsFrom } from "./run.ts";
import { ago, KINDS, WatchDataSchema, type Kind, type PollApi, type PollContext, type PollOutcome, type StoredConditional, type WatchData, type WatchEvent } from "./types.ts";

export type Creator = "you" | "aria" | "task" | "system";

export interface WatchRequest {
  kind: WatchKind;
  owner?: string;
  repo?: string;
  repoId?: number;
  repoName?: string;
  /** The project's default branch, when it's known. */
  defaultBranch?: string;
  runId?: number;
  workflow?: string;
  runNumber?: number;
  branch?: string;
  next?: boolean;
  /** When `next` is true and the caller already snapshotted the latest run ID before triggering a run. */
  afterRunId?: number;
  pr?: number;
  until?: WatchUntil;
  hours?: number;
}

export type CreateOutcome =
  | { kind: "created"; watch: Watch }
  /** The same thing was watched already; `until` is set when its end condition changed to cover both. */
  | { kind: "merged"; watch: Watch; until?: WatchUntil }
  /** Nothing to wait for: it finished (or closed) already. */
  | { kind: "finished"; title: string; status: string; url?: string }
  | { kind: "refused"; reason: string };

export interface WatchersDeps {
  db: () => Store;
  clock: Clock;
  /** Undefined: this run of ARIA has no GitHub (a test). */
  access: GitHubAccess | undefined;
  emit: (event: EngineEvent) => void;
  addCard: (card: CardItem) => void;
  attention: (event: AttentionEvent) => void;
  /** A line for ARIA's next digest: the newest per key (a watch and a kind of news) is kept. */
  digest: (key: string, line: string) => void;
  notice: (level: "info" | "warning" | "error", text: string, cause?: string) => void;
  /** A repository's name as you know it (its project), and the project's id. */
  nameFor: (owner: string, repo: string) => { repoName: string; repoId?: number };
  log: (line: string) => void;
  /** Tests: how much each interval varies (default ±10 %), and the tick. */
  jitter?: number;
  tickMs?: number;
}

const TICK_MS = 5_000;
const MAX_POLLS = 3;
export const MAX_ACTIVE = 50;
export const MAX_BY_ARIA = 20;
/** Of the 50, what you (the window's clicks) and ARIA start may take this many: the rest is kept for tasks (item 3's watch of the PR it opens) and the inbox. */
export const MAX_BY_PEOPLE = 45;
const KEEP_ENDED_MS = 7 * 86_400_000;
/** An expired watch GitHub can't be asked about ends anyway this long after its time-out. */
const GRACE_MS = 86_400_000;
const NOT_FOUND_ENDS = 3;
const SSO_PAUSE_MS = 3_600_000;
/** The inbox after its third 404 or 403 in a row: it waits this long between tries (it isn't ended, D37). */
const INBOX_RETRY_MS = 3_600_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const SAY_FAILING_AFTER = 5;
/** A tick this much earlier than the last one: the PC's clock was set back. */
const CLOCK_BACK_MS = 30_000;
const INBOX_UNREADABLE = "GitHub CLI's token can't read your notifications (it needs the notifications or repo scope: `gh auth refresh -s notifications`).";

export const MAX_HOURS: Record<Creator, number> = { aria: 168, you: 720, task: 720, system: 720 };
const DEFAULT_HOURS: Record<"aria" | "other", Record<"run" | "pr" | "branch", number>> = { aria: { run: 12, pr: 168, branch: 48 }, other: { run: 12, pr: 720, branch: 168 } };
const UNTILS: Record<WatchKind, WatchUntil[]> = { run: ["completed"], pr: ["checks", "success", "merged"], branch: ["completed", "success", "forever"], inbox: ["forever"] };
/** A watch of the same thing again: the end condition that covers both (a `merged` PR watch reports every head's checks). */
const COVERS: Partial<Record<WatchKind, WatchUntil[]>> = { pr: ["checks", "success", "merged"], branch: ["completed", "success"] };
/** A branch name GitHub would take (no space or control character, no `..`, not an option). */
const BRANCH = /^(?!-)(?!.*\.\.)[^\s~^:?*[\\\p{Cc}\p{Cf}]{1,250}$/u;

/** News of one watch that replaces its earlier line in the digest: its CI, its reviews, its end. */
const DIGEST_GROUP: Partial<Record<string, string>> = { ci_success: "ci", ci_failure: "ci", review: "review", review_request: "review", pr_closed: "pr", pr_closed_yours: "pr" };

const SETTING_INBOX = "github.inbox";
const SETTING_ACCOUNT = "github.account";
const SETTING_NOTIFIED = "github.notified";

interface Loaded {
  row: WatchRow;
  data: WatchData;
  /** Bumped by anything that changes it outside a poll (a merge, a rebind): a poll that started before is dropped. */
  version: number;
}

const refused = (reason: string): CreateOutcome => ({ kind: "refused", reason });

function parsed(row: WatchRow): Loaded | undefined {
  if (!(KINDS as readonly string[]).includes(row.kind)) return undefined;
  const data = WatchDataSchema.safeParse(row.data);
  if (!data.success) return undefined;
  const kind = row.kind as Kind;
  const target = { run: RunTargetSchema, pr: PrTargetSchema, branch: BranchTargetSchema, inbox: InboxTargetSchema }[kind].safeParse(data.data.target);
  const state = { run: RunStateSchema, pr: PrStateSchema, branch: BranchStateSchema, inbox: InboxStateSchema }[kind].safeParse(data.data.state);
  if (!target.success || !state.success) return undefined;
  return { row, data: data.data, version: 0 };
}

export class Watchers {
  private readonly rows = new Map<number, Loaded>();
  private readonly inFlight = new Map<number, AbortController>();
  private readonly polls = new Set<Promise<void>>();
  private timer: unknown;
  private stopped = false;
  private started = false;
  private lastTickAt: number | undefined;
  /** How far the clock was set back while ARIA ran, in all (negative): a poll or a start on its way adds what changed. */
  private shifted = 0;

  constructor(private readonly deps: WatchersDeps) {}

  private get db(): Store {
    return this.deps.db();
  }

  private get now(): number {
    return this.deps.clock.now();
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────────────────────────────────────

  /** Loads the active watches, prunes old ended ones, starts the inbox on the first run (D37), and starts the tick. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.db.pruneWatches(this.now - KEEP_ENDED_MS);
    const now = this.now;
    for (const row of this.db.listWatches({ state: "active" })) {
      const loaded = parsed(row);
      if (loaded) {
        // A clock set back since (or another one): nothing waits longer than its longest pause from now.
        loaded.data.nextPollAt = Math.min(loaded.data.nextPollAt, now + MAX_BACKOFF_MS);
        if (loaded.data.pausedUntil !== undefined) loaded.data.pausedUntil = Math.min(loaded.data.pausedUntil, now + SSO_PAUSE_MS);
        this.rows.set(row.id, loaded);
      }
      else if ((KINDS as readonly string[]).includes(row.kind)) {
        // A row this version can't read: it ends (a later phase's kind is left as it is).
        this.db.saveWatch({ ...row, state: "ended", endedAt: this.now, updatedAt: this.now });
      }
    }
    // The inbox: started on the first run (D37), and again when it's on but has no watch (ARIA quit while starting it,
    // or the 50 were full). The setting says "on" only once its watch exists.
    const inbox = this.db.getSetting<unknown>(SETTING_INBOX);
    const first = inbox === undefined || inbox === null;
    if (this.deps.access && (first || inbox === "on") && ![...this.rows.values()].some((l) => l.row.kind === "inbox")) {
      void this.create({ kind: "inbox" }, "system").then((outcome) => {
        if (outcome.kind === "created" && first) {
          this.deps.notice(
            "info",
            "ARIA watches your GitHub notifications now: a review request shows up as a card (and pops up while you're away); the rest doesn't interrupt you. Turn it off in Customize › Notifications.",
            "github_inbox",
          );
        }
      });
    }
    this.arm(0);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer);
    this.timer = undefined;
    for (const controller of this.inFlight.values()) controller.abort();
    this.deps.access?.stop();
    // Nothing is written once stopped; the polls in flight only need to let go.
    await Promise.race([Promise.allSettled([...this.polls]), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }

  /** The PC woke up (or was unlocked), or GitHub can be read again: relative timers drifted, so look at once. */
  wake(): void {
    if (this.stopped || !this.started) return;
    try {
      this.tick();
    } finally {
      this.arm();
    }
  }

  private arm(ms = this.deps.tickMs ?? TICK_MS): void {
    if (this.stopped) return;
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer);
    this.timer = this.deps.clock.setTimeout(() => {
      this.timer = undefined;
      try {
        this.tick();
      } finally {
        this.arm();
      }
    }, ms);
  }

  /** Everything due by now (`nextPollAt <= now`, an absolute time: a sleep doesn't make anything late twice). */
  private tick(): void {
    const access = this.deps.access;
    if (this.stopped || !access) return;
    const now = this.now;
    this.checkClock(now);
    if (!access.ready(now)) {
      void access.ensure().then((ok) => {
        if (ok && access.ready()) this.wake();
      });
      this.endStale(now);
      return;
    }
    // An expired watch that's polled ends after its next poll (commit), so a result that came meanwhile beats the
    // time-out; one that isn't (paused) or whose polls fail ends now.
    this.endExpired(now);
    const due = [...this.rows.values()].filter((l) => !this.inFlight.has(l.row.id) && !this.pausedFor(l, now) && l.data.nextPollAt <= now).sort((a, b) => a.data.nextPollAt - b.data.nextPollAt);
    for (const loaded of due) {
      if (this.inFlight.size >= MAX_POLLS) break;
      this.startPoll(loaded);
    }
  }

  /**
   * The PC's clock was set back while ARIA ran (the tick's timer isn't: it fires on time): every time a watch waits for
   * moves back with it, and the access's pauses too, or nothing would be polled until the clock caught up again.
   */
  private checkClock(now: number): void {
    const last = this.lastTickAt;
    this.lastTickAt = now;
    if (last === undefined || now >= last - CLOCK_BACK_MS) return;
    const shift = now - last;
    this.shifted += shift;
    for (const loaded of this.rows.values()) {
      loaded.data.nextPollAt += shift;
      if (loaded.data.pausedUntil !== undefined) loaded.data.pausedUntil += shift;
    }
    this.deps.access?.clockMoved(shift);
    this.deps.log(`The PC's clock went back ${Math.round(-shift / 60_000)} min: GitHub's watches keep their intervals.`);
  }

  /** Expired watches GitHub can't be asked about end a day past their time-out. */
  private endStale(now: number): void {
    for (const loaded of [...this.rows.values()]) {
      if (loaded.data.expiresAt !== undefined && loaded.data.expiresAt + GRACE_MS <= now && !this.inFlight.has(loaded.row.id)) this.timeOut(loaded, now, "GitHub couldn't be read");
    }
  }

  /** Expired watches that aren't polled (paused: another account, single sign-on) or whose polls fail: they end now. */
  private endExpired(now: number): void {
    for (const loaded of [...this.rows.values()]) {
      if (loaded.data.expiresAt === undefined || loaded.data.expiresAt > now || this.inFlight.has(loaded.row.id)) continue;
      const why = this.pausedFor(loaded, now) ? "it was paused" : loaded.data.failures || loaded.data.missing ? "GitHub kept failing" : undefined;
      if (why) this.timeOut(loaded, now, why);
    }
  }

  /** Why a watch isn't polled now, if so. */
  private pausedFor(loaded: Loaded, now: number): string | undefined {
    const login = this.deps.access?.login;
    if (loaded.data.account && login && loaded.data.account !== login) return `started as @${loaded.data.account}; GitHub CLI now uses @${login}`;
    if (loaded.data.pausedUntil !== undefined && loaded.data.pausedUntil > now) return loaded.data.lastError ?? "paused for a while";
    return undefined;
  }

  // ── polling ───────────────────────────────────────────────────────────────────────────────────────────────────

  private startPoll(loaded: Loaded): void {
    const run = this.poll(loaded).catch((error: unknown) => this.deps.log(`ARIA's watcher W-${loaded.row.id} stopped on an error: ${error instanceof Error ? error.name : "unknown"}`));
    this.polls.add(run);
    void run.finally(() => this.polls.delete(run));
  }

  /** A read through the access, with this watch's ETags; new ones wait in `pending` until the poll commits. */
  private api(loaded: Loaded, pending: Record<string, StoredConditional>, intervals: number[], signal: AbortSignal): PollApi {
    const access = this.deps.access!;
    return {
      get: async (key: string, route: Route, params: Params) => {
        const login = access.login;
        const before = loaded.data.conditional[key];
        const conditional = before && login && before.login === login ? before : undefined;
        const result = await access.get(route, params, conditional ? { ...(conditional.etag ? { etag: conditional.etag } : {}), ...(conditional.lastModified ? { lastModified: conditional.lastModified } : {}) } : {}, signal);
        if (result.pollIntervalMs) intervals.push(result.pollIntervalMs);
        if (result.status === 304) {
          if (!conditional) throw new GitHubFailure("invalid", "GitHub said nothing changed about something ARIA hadn't read.");
          pending[key] = conditional;
          return { changed: false };
        }
        if (login && (result.etag || result.lastModified)) pending[key] = { ...(result.etag ? { etag: result.etag } : {}), ...(result.lastModified ? { lastModified: result.lastModified } : {}), login };
        return { changed: true, data: result.data };
      },
    };
  }

  private context(loaded: Loaded, now: number): PollContext {
    const owner = loaded.data.owner ?? "";
    const repo = loaded.data.repo ?? "";
    return {
      owner,
      repo,
      repoName: loaded.data.repoName ?? `${owner}/${repo}`,
      until: loaded.data.until,
      baselined: loaded.data.baselined,
      now,
      you: this.deps.access?.login,
      nameFor: (o, r) => this.deps.nameFor(o, r).repoName,
    };
  }

  private kindPoll(kind: Kind, data: WatchData, api: PollApi, ctx: PollContext): Promise<PollOutcome> {
    switch (kind) {
      case "run":
        return pollRun(RunTargetSchema.parse(data.target), RunStateSchema.parse(data.state), api, ctx);
      case "pr":
        return pollPr(PrTargetSchema.parse(data.target), PrStateSchema.parse(data.state), api, ctx);
      case "branch":
        return pollBranch(BranchTargetSchema.parse(data.target), BranchStateSchema.parse(data.state), api, ctx);
      case "inbox":
        return pollInbox(InboxStateSchema.parse(data.state), api, ctx);
    }
  }

  private async poll(loaded: Loaded): Promise<void> {
    const id = loaded.row.id;
    const controller = new AbortController();
    this.inFlight.set(id, controller);
    const version = loaded.version;
    const login = this.deps.access?.login;
    const now = this.now;
    const shifted = this.shifted;
    const pending: Record<string, StoredConditional> = {};
    const intervals: number[] = [];
    // Ended or changed meanwhile (you stopped it, it was rebound), or GitHub CLI's account changed while it read (what it
    // read may be another account's): this poll's result goes, and the next tick looks again.
    const stale = () => this.stopped || this.rows.get(id) !== loaded || loaded.version !== version || this.deps.access?.login !== login;
    // Its start, on the clock as it is now (set back while it read, the clock moved its times with it: checkClock).
    const started = () => now + this.shifted - shifted;
    try {
      const outcome = await this.kindPoll(loaded.row.kind as Kind, loaded.data, this.api(loaded, pending, intervals, controller.signal), this.context(loaded, now));
      if (stale()) return;
      this.commit(loaded, outcome, pending, intervals, started());
    } catch (error) {
      if (stale()) return;
      this.failed(loaded, error, started());
    } finally {
      this.inFlight.delete(id);
    }
  }

  private interval(ms: number, pollIntervals: number[], now: number): number {
    let next = Math.max(ms, ...pollIntervals, 10_000);
    if (this.deps.access?.slow(now)) next *= 4;
    const jitter = this.deps.jitter ?? 0.1;
    if (jitter > 0) next = Math.round(next * (1 + (Math.random() * 2 - 1) * jitter));
    return next;
  }

  /** The poll's state and the ETags it used, in one write; then what it has to tell. */
  private commit(loaded: Loaded, outcome: PollOutcome, pending: Record<string, StoredConditional>, intervals: number[], now: number): void {
    const pollIntervalMs = intervals.length ? Math.max(...intervals) : undefined;
    const data: WatchData = {
      ...loaded.data,
      target: outcome.target ?? loaded.data.target,
      state: outcome.state,
      title: outcome.title ?? loaded.data.title,
      status: outcome.status,
      tone: outcome.tone,
      // Only what this poll used: older heads' ETags drop out.
      conditional: pending,
      account: loaded.data.account ?? this.deps.access?.login,
      baselined: true,
      lastCheckedAt: now,
      nextPollAt: now + this.interval(outcome.nextInMs, intervals, now),
      ...(pollIntervalMs ? { pollIntervalMs } : {}),
    };
    delete data.failures;
    delete data.missing;
    delete data.lastError;
    delete data.pausedUntil;
    let row: WatchRow = { ...loaded.row, updatedAt: now };
    if (outcome.rekey && outcome.rekey !== row.targetKey) {
      const other = this.db.activeWatchByKey(outcome.rekey);
      if (other && other.id !== row.id) {
        // The run it waited for is watched already: this one ends quietly into that one.
        this.finish(loaded, "merged_into", undefined, now, `found the run, which W-${other.id} watches already`);
        return;
      }
      row = { ...row, targetKey: outcome.rekey };
    }
    const expired = !outcome.end && data.expiresAt !== undefined && data.expiresAt <= now;
    const end = outcome.end ?? (expired ? "timed_out" : undefined);
    if (end) {
      row = { ...row, state: "ended", endedAt: now };
      data.ended = { reason: end };
      if (!outcome.end) data.tone = "ended";
    }
    row.data = data;
    this.db.saveWatch(row);
    const next: Loaded = { row, data, version: loaded.version };
    if (end) this.rows.delete(row.id);
    else this.rows.set(row.id, next);
    this.emitWatch(next);
    for (const event of outcome.events) this.deliver(next, event);
    if (expired) this.timedOutEvent(next);
  }

  private failed(loaded: Loaded, error: unknown, now: number): void {
    if (!(error instanceof GitHubFailure)) {
      this.deps.log(`ARIA's watcher W-${loaded.row.id} couldn't read GitHub's answer: ${error instanceof Error ? error.name : "unknown"}`);
    }
    const type = error instanceof GitHubFailure ? error.type : "invalid";
    // GitHub's own state (offline, rate limited, the token): nothing about this watch; it goes when GitHub does.
    if (type === "auth" || type === "rate_limited" || type === "secondary_limit" || type === "offline" || type === "stopped") return;
    // Its time is up: failing doesn't keep it going.
    if (loaded.data.expiresAt !== undefined && loaded.data.expiresAt <= now) {
      this.timeOut(loaded, now, "GitHub kept failing");
      return;
    }
    const failures = (loaded.data.failures ?? 0) + 1;
    const data: WatchData = { ...loaded.data, failures };
    if (type === "not_found" || type === "forbidden") {
      // Three in a row, nothing else between (a 502 isn't a "gone"). Maybe another account by now: gh is asked again
      // before the third ends it.
      const missing = (loaded.data.missing ?? 0) + 1;
      data.missing = missing;
      this.deps.access?.noteNotFound();
      if (missing >= NOT_FOUND_ENDS && loaded.row.kind !== "inbox") {
        this.finish(loaded, type === "not_found" ? "not_found" : "no_access", undefined, now);
        return;
      }
      if (missing >= NOT_FOUND_ENDS) {
        // The inbox isn't ended for it: your switch stays on (D37), and it goes on by itself once gh's token can read
        // notifications (after `gh auth refresh`). Said once.
        data.pausedUntil = now + INBOX_RETRY_MS;
        data.nextPollAt = data.pausedUntil;
        data.lastError = INBOX_UNREADABLE;
        if (missing === NOT_FOUND_ENDS) this.deps.notice("warning", `GitHub: ${INBOX_UNREADABLE} ARIA tries again every hour.`, "github_inbox_access");
      } else {
        data.nextPollAt = now + 60_000;
      }
    } else if (type === "sso") {
      delete data.missing;
      data.pausedUntil = now + SSO_PAUSE_MS;
      data.lastError = githubText(error instanceof Error ? error.message : "single sign-on", 200);
      data.nextPollAt = data.pausedUntil;
    } else {
      delete data.missing;
      const base = Math.max(30_000, loaded.data.pollIntervalMs ?? 30_000);
      data.nextPollAt = now + Math.min(base * 2 ** Math.min(failures, 8), MAX_BACKOFF_MS);
      if (failures >= SAY_FAILING_AFTER) data.lastError = githubText(error instanceof Error ? error.message : "GitHub keeps failing", 200);
    }
    const row = { ...loaded.row, updatedAt: now, data };
    this.db.saveWatch(row);
    const next = { row, data, version: loaded.version };
    this.rows.set(row.id, next);
    this.emitWatch(next);
  }

  // ── what a watch tells ────────────────────────────────────────────────────────────────────────────────────────

  private deliver(loaded: Loaded, event: WatchEvent): void {
    const cardId = `${event.card.cardType}-${randomUUID()}`;
    const card = { kind: "card", id: cardId, cardType: event.card.cardType, payload: { ...event.card.payload, watchId: loaded.row.id }, createdAt: Date.now() } as CardItem;
    this.deps.addCard(card);
    this.deps.attention({ kind: event.kind, title: event.toast.title, body: event.toast.body, watch: { id: loaded.row.id, title: loaded.data.title, repoName: loaded.data.repoName ?? "GitHub" }, cardId });
    // A review request is about its own PR: each one keeps its line.
    const about = event.card.cardType === "pr" && event.kind === "review_request" ? `:${event.card.payload.owner}/${event.card.payload.repo}#${event.card.payload.number}` : "";
    this.deps.digest(`${loaded.row.id}:${DIGEST_GROUP[event.kind] ?? event.kind}${about}`, `${event.digest} (W-${loaded.row.id})`);
  }

  /** A watch that ended before its end condition says so: a card, an attention event, a digest line. */
  private endedEvent(loaded: Loaded, reason: WatchEndReason, text: string): void {
    const cardId = `watch-ended-${randomUUID()}`;
    const repoName = loaded.data.repoName;
    const url = this.urlOf(loaded);
    this.deps.addCard({
      kind: "card",
      id: cardId,
      cardType: "watch_ended",
      payload: { watchId: loaded.row.id, title: loaded.data.title, ...(repoName ? { repoName } : {}), reason, text, ...(url ? { url } : {}) },
      createdAt: Date.now(),
    });
    this.deps.attention({ kind: "watch_ended", title: `Stopped watching ${loaded.data.title}`, body: text, watch: { id: loaded.row.id, title: loaded.data.title, repoName: repoName ?? "GitHub" }, cardId });
    this.deps.digest(`${loaded.row.id}:watch`, `[watch] Stopped watching ${digestText(loaded.data.title, 80)}${repoName ? ` on ${repoName}` : ""} (W-${loaded.row.id}): ${text}`);
  }

  /** `why`: ARIA's own words for why it couldn't tell (never GitHub's: this reaches the digest as is). */
  private timedOutEvent(loaded: Loaded, why?: string): void {
    const hours = loaded.data.expiresAt !== undefined ? Math.round((loaded.data.expiresAt - loaded.row.createdAt) / 3_600_000) : undefined;
    this.endedEvent(loaded, "timed_out", `it was still ${loaded.data.status}${hours ? ` after ${hours} h` : ""}${why ? ` (${why})` : ""}.`);
  }

  private timeOut(loaded: Loaded, now: number, why?: string): void {
    this.finish(loaded, "timed_out", undefined, now, undefined, why);
  }

  /** Ends a watch: saved, out of the schedule, and (unless you or ARIA stopped it, or it merged) told. */
  private finish(loaded: Loaded, reason: WatchEndReason, by: "you" | "aria" | undefined, now: number, status?: string, why?: string): Watch {
    this.inFlight.get(loaded.row.id)?.abort();
    const data: WatchData = { ...loaded.data, tone: "ended", ended: { reason, ...(by ? { by } : {}) }, ...(status ? { status } : {}) };
    const row: WatchRow = { ...loaded.row, state: "ended", endedAt: now, updatedAt: now, data };
    this.db.saveWatch(row);
    this.rows.delete(row.id);
    const ended: Loaded = { row, data, version: loaded.version + 1 };
    this.emitWatch(ended);
    if (reason === "timed_out") this.timedOutEvent(ended, why);
    else if (reason === "not_found") this.endedEvent(ended, reason, "GitHub doesn't know it anymore (gone, renamed, or not visible to this account).");
    else if (reason === "no_access") this.endedEvent(ended, reason, "GitHub doesn't let this account read it.");
    if (row.kind === "inbox") {
      // Only your choice (the switch, or `unwatch`) turns it off for good (D37); nothing ARIA ends itself does.
      if (reason === "unwatched") this.db.setSetting(SETTING_INBOX, "off");
      this.emitGitHub();
    }
    return this.view(ended);
  }

  // ── starting and stopping watches ─────────────────────────────────────────────────────────────────────────────

  async create(request: WatchRequest, by: Creator, taskId?: string): Promise<CreateOutcome> {
    if (this.stopped) return refused("ARIA is stopping.");
    const access = this.deps.access;
    if (!access) return refused("GitHub isn't set up in this run of ARIA.");
    const kind = request.kind;
    const allowed = UNTILS[kind];
    const until: WatchUntil = request.until ?? (kind === "run" ? "completed" : kind === "pr" ? "merged" : kind === "inbox" ? "forever" : by === "aria" ? "completed" : "forever");
    if (!allowed.includes(until)) return refused(`A ${kind} watch can wait for ${allowed.map((u) => `"${u}"`).join(" or ")}, not "${until}".`);
    // (The inbox only waits "forever", so this also keeps ARIA from turning it on.)
    if (until === "forever" && by === "aria") return refused("A watch without an end (default-branch health, the inbox) can only be turned on by the user, in the window.");
    const maxHours = MAX_HOURS[by];
    if (request.hours !== undefined && (!Number.isInteger(request.hours) || request.hours < 1 || request.hours > maxHours)) return refused(`A watch can last between 1 and ${maxHours} hours.`);
    const hours = until === "forever" ? undefined : (request.hours ?? DEFAULT_HOURS[by === "aria" ? "aria" : "other"][kind as "run" | "pr" | "branch"]);
    let owner = "";
    let repo = "";
    if (kind !== "inbox") {
      if (!validName(request.owner) || !validName(request.repo)) return refused("That isn't a GitHub repository ARIA can watch.");
      owner = request.owner;
      repo = request.repo;
    }
    const now = this.now;
    const shifted = this.shifted;
    const ready = access.ready(now) || ((await access.ensure()) && access.ready(this.now));
    const unavailable = () => refused(`GitHub can't be read right now: ${access.view().message ?? "it isn't available"}`);
    const names = kind === "inbox" ? undefined : this.deps.nameFor(owner, repo);
    const repoName = request.repoName ?? names?.repoName;
    const repoId = request.repoId ?? names?.repoId;

    // What exactly is watched, and its key.
    let target: Record<string, unknown> = {};
    let key: string;
    let title: string;
    if (kind === "run") {
      if (request.runId !== undefined) {
        if (!asId(request.runId)) return refused("That isn't a run id.");
        target = { runId: request.runId };
        key = runKey(owner, repo, request.runId);
        title = `run ${request.runId}`;
      } else {
        if (!ready) return unavailable();
        if (request.branch !== undefined && !BRANCH.test(request.branch)) return refused("That isn't a branch name.");
        const resolved = await this.resolveRun(owner, repo, request).catch((error: unknown) => refused(error instanceof GitHubFailure ? `GitHub said: ${error.message}` : "GitHub's answer couldn't be read."));
        if ("kind" in resolved) return resolved;
        ({ target, key, title } = resolved);
      }
    } else if (kind === "pr") {
      if (!asId(request.pr)) return refused("Say which pull request (its number).");
      target = { number: request.pr };
      key = prKey(owner, repo, request.pr!);
      title = `PR #${request.pr}`;
    } else if (kind === "branch") {
      let branch = request.branch ?? request.defaultBranch;
      if (branch === undefined) {
        if (!ready) return unavailable();
        const info = await access.get("GET /repos/{owner}/{repo}", { owner, repo }, {}).catch(() => undefined);
        const named = info?.status === 200 ? (info.data as { default_branch?: unknown } | null)?.default_branch : undefined;
        if (typeof named !== "string") return refused("ARIA couldn't find that repository's default branch.");
        branch = named;
      }
      if (!BRANCH.test(branch)) return refused("That isn't a branch name.");
      target = { branch };
      key = branchKey(owner, repo, branch, until);
      title = branch;
    } else {
      key = "inbox";
      title = "GitHub inbox";
    }

    const existing = this.db.activeWatchByKey(key);
    if (existing) return this.merge(existing.id, until, hours, by, taskId);
    const full = this.capRefusal(by, kind);
    if (full) return full;

    const data: WatchData = {
      ...(kind !== "inbox" ? { owner, repo } : {}),
      ...(repoName ? { repoName } : {}),
      target,
      state: {},
      until,
      ...(hours !== undefined ? { expiresAt: now + hours * 3_600_000 } : {}),
      title,
      status: "starting",
      tone: "waiting",
      conditional: {},
      ...(access.login ? { account: access.login } : {}),
      baselined: false,
      nextPollAt: now,
    };
    const row: Omit<WatchRow, "id"> = { kind, state: "active", ...(repoId !== undefined ? { repoId } : {}), targetKey: key, createdBy: by, ...(taskId ? { taskId } : {}), createdAt: now, updatedAt: now, data };
    let loaded: Loaded = { row: { ...row, id: 0 }, data, version: 0 };

    // The first look is its baseline: what's there already isn't news (and something finished already isn't watched).
    let baseline: { outcome: PollOutcome; pending: Record<string, StoredConditional>; intervals: number[] } | undefined;
    if (ready) {
      const pending: Record<string, StoredConditional> = {};
      const intervals: number[] = [];
      try {
        const outcome = await this.kindPoll(kind, data, this.api(loaded, pending, intervals, new AbortController().signal), this.context(loaded, now));
        baseline = { outcome, pending, intervals };
      } catch (error) {
        // You and the system can start a watch that GitHub can't confirm yet (it takes its baseline later); ARIA can't.
        if (by === "aria" || by === "task" || (kind !== "inbox" && until !== "forever")) return refused(error instanceof GitHubFailure ? `GitHub said: ${error.message}` : "GitHub's answer couldn't be read.");
      }
    } else if (by === "aria" || by === "task" || (kind !== "inbox" && until !== "forever")) {
      return unavailable();
    }
    if (this.stopped) return refused("ARIA is stopping.");
    // The inbox ARIA starts by itself, which you turned off while it took its first look: off it stays.
    if (kind === "inbox" && by === "system" && this.db.getSetting<unknown>(SETTING_INBOX) === "off") return refused("You turned the inbox off.");
    if (baseline?.outcome.end) return { kind: "finished", title: baseline.outcome.title ?? title, status: baseline.outcome.status, ...(baseline.outcome.url ? { url: baseline.outcome.url } : {}) };
    // Someone else started the same meanwhile.
    const again = this.db.activeWatchByKey(baseline?.outcome.rekey ?? key);
    if (again) return this.merge(again.id, until, hours, by, taskId);
    // Others started meanwhile too (clicks at once, each waiting for its first look): the caps hold as it's written.
    const late = this.capRefusal(by, kind);
    if (late) return late;

    // The clock set back while it took its first look: its times move with it, as every watch's did (checkClock).
    const shift = this.shifted - shifted;
    data.nextPollAt += shift;
    const id = this.db.insertWatch({ ...row, ...(baseline?.outcome.rekey ? { targetKey: baseline.outcome.rekey } : {}) });
    loaded = { row: { ...row, id, ...(baseline?.outcome.rekey ? { targetKey: baseline.outcome.rekey } : {}) }, data, version: 0 };
    this.rows.set(id, loaded);
    if (baseline) this.commit(loaded, baseline.outcome, baseline.pending, baseline.intervals, now + shift);
    else this.emitWatch(loaded);
    const current = this.rows.get(id) ?? loaded;
    if (kind === "inbox") {
      this.db.setSetting(SETTING_INBOX, "on");
      // The switch is part of GitHub's state the window shows.
      this.emitGitHub();
    }
    this.wake();
    return { kind: "created", watch: this.view(current) };
  }

  /**
   * Why another watch by `by` can't start now, if so: 50 in all; ARIA's 20; yours and ARIA's 45 together (the rest
   * kept for tasks and the inbox; the inbox itself, whoever turned it on, isn't one of the 45).
   */
  private capRefusal(by: Creator, kind: WatchKind): CreateOutcome | undefined {
    const active = [...this.rows.values()];
    if (active.length >= MAX_ACTIVE) return refused(`${MAX_ACTIVE} things are watched already: stop one first.`);
    if (by === "aria" && active.filter((l) => l.row.createdBy === "aria").length >= MAX_BY_ARIA) return refused(`ARIA started ${MAX_BY_ARIA} watches already: stop one of them first (list_watches).`);
    const people = active.filter((l) => (l.row.createdBy === "you" || l.row.createdBy === "aria") && l.row.kind !== "inbox").length;
    if ((by === "you" || by === "aria") && kind !== "inbox" && people >= MAX_BY_PEOPLE) {
      return refused(`${MAX_BY_PEOPLE} watches you and ARIA started are on already (the last ${MAX_ACTIVE - MAX_BY_PEOPLE} are kept for tasks and the inbox): stop one first.`);
    }
    return undefined;
  }

  /** A run by id, by workflow (its newest: an unfinished one first; or a number), or the next one to start. */
  private async resolveRun(owner: string, repo: string, request: WatchRequest): Promise<{ target: Record<string, unknown>; key: string; title: string } | CreateOutcome> {
    const access = this.deps.access!;
    let workflowId: string | number | undefined;
    let workflowName: string | undefined;
    if (request.workflow !== undefined) {
      const wanted = request.workflow.trim();
      if (/^[A-Za-z0-9_.-]{1,200}\.ya?ml$/i.test(wanted)) {
        workflowId = wanted;
        workflowName = wanted;
      } else {
        const listed = await access.get("GET /repos/{owner}/{repo}/actions/workflows", { owner, repo, per_page: 100 }, {});
        const workflows = listed.status === 200 ? ((listed.data as { workflows?: unknown } | null)?.workflows ?? []) : [];
        const found = Array.isArray(workflows)
          ? (workflows as Array<{ id?: unknown; name?: unknown; path?: unknown }>).find(
              (w) => (typeof w.name === "string" && w.name.toLowerCase() === wanted.toLowerCase()) || (typeof w.path === "string" && w.path.split("/").pop()?.toLowerCase() === wanted.toLowerCase()),
            )
          : undefined;
        if (!found || !asId(found.id)) return refused(`There's no workflow called ${digestText(wanted, 60)} in ${owner}/${repo}.`);
        workflowId = found.id as number;
        workflowName = githubText(found.name, 100);
      }
    }
    const what = workflowName ? `${workflowName}${request.branch ? ` on ${request.branch}` : ""}` : request.branch ? `the runs on ${request.branch}` : "the runs";
    if (request.next && request.afterRunId !== undefined) {
      const target = { ...(workflowId !== undefined ? { workflowId } : {}), ...(request.branch ? { branch: request.branch } : {}), afterRunId: request.afterRunId };
      return { target, key: nextRunKey(owner, repo, workflowId, request.branch), title: `the next run of ${what}` };
    }
    const params = { owner, repo, per_page: request.runNumber !== undefined ? 100 : 20, ...(request.branch ? { branch: request.branch } : {}) };
    const listed =
      workflowId !== undefined
        ? await access.get("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs", { ...params, workflow_id: workflowId }, {})
        : await access.get("GET /repos/{owner}/{repo}/actions/runs", params, {});
    const runs = (listed.status === 200 ? runsFrom(listed.data) : []).filter((r) => ownRun(r, owner, repo) && (!request.branch || r.branch === request.branch)).sort((a, b) => b.id - a.id);
    if (request.next) {
      const target = { ...(workflowId !== undefined ? { workflowId } : {}), ...(request.branch ? { branch: request.branch } : {}), afterRunId: runs[0]?.id ?? 0 };
      return { target, key: nextRunKey(owner, repo, workflowId, request.branch), title: `the next run of ${what}` };
    }
    const run = request.runNumber !== undefined ? runs.find((r) => r.number === request.runNumber) : (runs.find((r) => r.status !== "completed") ?? runs[0]);
    if (!run) return refused(request.runNumber !== undefined ? `There's no run #${request.runNumber} among the last 100 of ${what}.` : `There's no run of ${what} yet: ask for the next one instead.`);
    return { target: { runId: run.id }, key: runKey(owner, repo, run.id), title: `${run.name} #${run.number}` };
  }

  /** The same thing asked for again: one watch, whose end condition and time-out cover both. */
  private merge(id: number, until: WatchUntil, hours: number | undefined, by: Creator, taskId: string | undefined): CreateOutcome {
    const loaded = this.rows.get(id);
    if (!loaded) return refused("That's watched already, but ARIA couldn't read that watch.");
    const order = COVERS[loaded.row.kind as WatchKind];
    const wider = order && order.indexOf(until) > order.indexOf(loaded.data.until) ? until : undefined;
    const now = this.now;
    const expiresAt = hours === undefined ? undefined : now + hours * 3_600_000;
    const later = loaded.data.expiresAt === undefined || expiresAt === undefined ? undefined : Math.max(loaded.data.expiresAt, expiresAt);
    const data: WatchData = { ...loaded.data, ...(wider ? { until: wider } : {}) };
    if (later !== undefined && later !== loaded.data.expiresAt) data.expiresAt = later;
    const row: WatchRow = { ...loaded.row, ...(taskId && !loaded.row.taskId ? { taskId } : {}), updatedAt: now, data };
    const changed = wider !== undefined || data.expiresAt !== loaded.data.expiresAt || row.taskId !== loaded.row.taskId;
    if (changed) {
      this.db.saveWatch(row);
      const next = { row, data, version: loaded.version + 1 };
      this.rows.set(id, next);
      this.emitWatch(next);
      return { kind: "merged", watch: this.view(next), ...(wider ? { until: wider } : {}) };
    }
    void by;
    return { kind: "merged", watch: this.view(loaded) };
  }

  /** Stops a watch (yours, ARIA's, the inbox: that turns its switch off). */
  end(id: number, by: "you" | "aria"): Watch {
    const loaded = this.rows.get(id);
    if (!loaded) {
      const row = this.db.getWatch(id);
      if (!row) throw new Error("That watch doesn't exist.");
      throw new Error(`W-${id} isn't watched anymore.`);
    }
    return this.finish(loaded, "unwatched", by, this.now, by === "you" ? "you stopped it" : "ARIA stopped it");
  }

  /**
   * The inbox switch (D37): on starts the inbox watch, off ends it; the setting remembers your choice ("on" once its
   * watch exists, so a refused start isn't remembered as on).
   */
  async setInbox(on: boolean): Promise<void> {
    const active = [...this.rows.values()].find((l) => l.row.kind === "inbox");
    if (on) {
      if (active) {
        this.db.setSetting(SETTING_INBOX, "on");
        this.retryInbox();
      } else {
        const outcome = await this.create({ kind: "inbox" }, "you");
        if (outcome.kind === "refused") throw new Error(outcome.reason);
      }
    } else {
      this.db.setSetting(SETTING_INBOX, "off");
      if (active) this.finish(active, "unwatched", "you", this.now, "you turned it off");
    }
    this.emitGitHub();
  }

  /**
   * The inbox waiting after 404s or 403s (its hour between tries): looked at again now, on your Try again or its switch
   * turned on. Its count of failures stays, so a failure again waits again without saying it twice.
   */
  retryInbox(): void {
    const loaded = [...this.rows.values()].find((l) => l.row.kind === "inbox");
    if (!loaded || loaded.data.pausedUntil === undefined) return;
    const now = this.now;
    const data: WatchData = { ...loaded.data, nextPollAt: now };
    delete data.pausedUntil;
    const row = { ...loaded.row, updatedAt: now, data };
    this.db.saveWatch(row);
    const next = { row, data, version: loaded.version + 1 };
    this.rows.set(row.id, next);
    this.emitWatch(next);
    this.wake();
  }

  /**
   * Default-branch health of a project, on (the project menu; you only). Off is `end` with that watch's id: a key
   * worked out again would miss it after a remote or default-branch rename.
   */
  watchBranch(request: WatchRequest): Promise<CreateOutcome> {
    return this.create({ ...request, kind: "branch", until: "forever" }, "you");
  }

  /** The active watch of a pull request, if there's one (My work shows it). */
  prWatch(owner: string, repo: string, number: number): number | undefined {
    const key = prKey(owner, repo, number);
    return [...this.rows.values()].find((l) => l.row.kind === "pr" && l.row.targetKey === key)?.row.id;
  }

  // ── GitHub's account ──────────────────────────────────────────────────────────────────────────────────────────

  storedLogin(): string | undefined {
    const value = this.db.getSetting<unknown>(SETTING_ACCOUNT);
    return typeof value === "string" ? value : undefined;
  }

  /**
   * gh's login is known, or changed (`gh auth switch`, another `gh auth login`). The watches started as another login
   * pause, and one card says so, with "Use @new for them"; gh switched back, they go on by themselves.
   */
  loginChanged(login: string, previous: string | undefined): void {
    if (this.stopped) return;
    this.db.setSetting(SETTING_ACCOUNT, login);
    const paused = [...this.rows.values()].filter((l) => l.data.account !== undefined && l.data.account !== login);
    for (const loaded of this.rows.values()) this.emitWatch(loaded);
    if (previous === undefined || previous === login || paused.length === 0) return;
    const cardId = `github-account-${randomUUID()}`;
    this.deps.addCard({ kind: "card", id: cardId, cardType: "github_account", payload: { from: previous, to: login, watchIds: paused.map((l) => l.row.id) }, createdAt: Date.now() });
    const count = `${paused.length} watch${paused.length === 1 ? " is" : "es are"} paused`;
    this.deps.attention({ kind: "github_account", title: `GitHub: ARIA now reads GitHub as @${login}`, body: `It was @${previous}: ${count}.`, cardId });
    this.deps.digest("account", `[github] GitHub CLI now uses @${login} (it was @${previous}): ${count} until the user picks an account on the card.`);
  }

  /** "Use @new for them": the paused watches go on as the login gh uses now, starting afresh (no ETags, a new baseline for the inbox). */
  rebind(watchIds: readonly number[]): number {
    const login = this.deps.access?.login;
    if (!login) throw new Error("GitHub CLI's account isn't known right now.");
    let count = 0;
    const now = this.now;
    for (const id of watchIds) {
      const loaded = this.rows.get(id);
      if (!loaded || loaded.data.account === undefined || loaded.data.account === login) continue;
      const data: WatchData = { ...loaded.data, account: login, conditional: {}, nextPollAt: now, ...(loaded.row.kind === "inbox" ? { baselined: false, state: {} } : {}) };
      delete data.failures;
      delete data.missing;
      delete data.lastError;
      delete data.pausedUntil;
      const row = { ...loaded.row, updatedAt: now, data };
      this.db.saveWatch(row);
      const next = { row, data, version: loaded.version + 1 };
      this.rows.set(id, next);
      this.emitWatch(next);
      count++;
    }
    this.wake();
    return count;
  }

  // ── access state and notices ──────────────────────────────────────────────────────────────────────────────────

  /** GitHub access changed: the window hears it, and a problem that needs you is said once per change (also across restarts). */
  accessChanged(): void {
    if (this.stopped) return;
    this.emitGitHub();
    const access = this.deps.access;
    if (!access) return;
    const view = access.view();
    const now = this.now;
    const longPause = view.status === "rate_limited" && view.pausedUntil !== undefined && view.pausedUntil - now > 10 * 60_000;
    const problem = view.status === "no_cli" || view.status === "signed_out" || view.status === "token_refused" || longPause ? view.status : undefined;
    const notified = this.db.getSetting<unknown>(SETTING_NOTIFIED);
    if (problem && problem !== notified) {
      this.db.setSetting(SETTING_NOTIFIED, problem);
      this.deps.notice("warning", `GitHub: ${view.message ?? "ARIA can't read GitHub right now."} Watches wait meanwhile.`, "github_access");
    } else if (!problem && view.status === "ok" && typeof notified === "string") {
      this.db.setSetting(SETTING_NOTIFIED, null);
      this.deps.notice("info", `GitHub works again${view.login ? ` (as @${view.login})` : ""}: watches go on.`, "github_access");
    }
    for (const loaded of this.rows.values()) this.emitWatch(loaded);
    if (access.ready()) this.wake();
  }

  githubState(): GitHubState {
    const access = this.deps.access;
    const inbox = [...this.rows.values()].some((l) => l.row.kind === "inbox");
    return access ? { ...access.view(), inbox } : { status: "off", inbox: false };
  }

  private emitGitHub(): void {
    this.deps.emit({ type: "github", github: this.githubState() });
  }

  // ── views ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private urlOf(loaded: Loaded): string | undefined {
    const { owner, repo } = loaded.data;
    const t = loaded.data.target;
    if (loaded.row.kind === "inbox") return links.notifications();
    if (!owner || !repo) return undefined;
    if (loaded.row.kind === "run") return typeof t.runId === "number" ? links.run(owner, repo, t.runId) : typeof t.branch === "string" ? links.branchRuns(owner, repo, t.branch) : links.repo(owner, repo);
    if (loaded.row.kind === "pr" && typeof t.number === "number") return links.pull(owner, repo, t.number);
    if (loaded.row.kind === "branch" && typeof t.branch === "string") return links.branchRuns(owner, repo, t.branch);
    return links.repo(owner, repo);
  }

  view(loaded: Loaded): Watch {
    const { row, data } = loaded;
    const active = row.state === "active";
    const access = this.deps.access;
    const now = this.now;
    const paused = !active ? undefined : (this.pausedFor(loaded, now) ?? (access && !access.ready(now) ? (access.view().message ?? "GitHub isn't available") : undefined));
    const url = this.urlOf(loaded);
    const items = row.kind === "inbox" ? InboxStateSchema.safeParse(data.state) : undefined;
    return {
      id: row.id,
      shortId: `W-${row.id}`,
      kind: row.kind as WatchKind,
      ...(row.repoId !== undefined ? { repoId: row.repoId } : {}),
      ...(data.repoName ? { repoName: data.repoName } : {}),
      title: data.title,
      status: data.status,
      tone: paused ? "paused" : data.tone,
      until: data.until,
      ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt } : {}),
      state: active ? "active" : "ended",
      ...(data.ended ? { endedReason: data.ended.reason } : {}),
      ...(paused ? { paused } : {}),
      ...(data.lastError ? { error: data.lastError } : {}),
      createdBy: row.createdBy as Watch["createdBy"],
      ...(row.taskId ? { taskId: row.taskId } : {}),
      ...(url ? { url } : {}),
      ...(data.account ? { account: data.account } : {}),
      ...(items?.success && items.data.items ? { inbox: items.data.items } : {}),
      ...(data.lastCheckedAt !== undefined ? { lastCheckedAt: data.lastCheckedAt } : {}),
      createdAt: row.createdAt,
      ...(row.endedAt !== undefined ? { endedAt: row.endedAt } : {}),
    };
  }

  private emitWatch(loaded: Loaded): void {
    this.deps.emit({ type: "watch", watch: this.view(loaded) });
  }

  /** Active watches and those ended in the last 7 days, newest first. */
  list(): Watch[] {
    const ended = this.db
      .listWatches({ state: "ended" })
      .filter((row) => row.endedAt !== undefined && row.endedAt >= this.now - KEEP_ENDED_MS)
      .map((row) => parsed(row))
      .filter((l): l is Loaded => l !== undefined);
    return [...this.rows.values(), ...ended].sort((a, b) => b.row.id - a.row.id).map((l) => this.view(l));
  }

  /** A watch by W-n, its number, or words in what it watches; active ones first. */
  find(ref: string): Watch | undefined {
    const match = /^\s*W\s*-?\s*(\d+)\s*$/i.exec(ref) ?? /^\s*(\d+)\s*$/.exec(ref);
    const all = this.list();
    if (match) return all.find((w) => w.id === Number(match[1]));
    const query = ref.trim().toLowerCase();
    if (!query) return undefined;
    const hits = all.filter((w) => `${w.title} ${w.repoName ?? ""} ${w.kind}`.toLowerCase().includes(query));
    return hits.find((w) => w.state === "active") ?? hits[0];
  }

  activeCount(by?: Creator): number {
    return [...this.rows.values()].filter((l) => by === undefined || l.row.createdBy === by).length;
  }

  /** For ARIA's tools: its own words as fields; GitHub's words quoted and cleaned under `fromGitHub`; no inbox titles (D37). */
  forAria(watch: Watch): Record<string, unknown> {
    const base = {
      id: watch.shortId,
      kind: watch.kind,
      ...(watch.repoName ? { project: watch.repoName } : {}),
      state: watch.state,
      status: watch.status,
      until: watch.until,
      startedBy: watch.createdBy,
      started: new Date(watch.createdAt).toISOString(),
      ...(watch.expiresAt !== undefined && watch.state === "active" ? { endsBy: new Date(watch.expiresAt).toISOString() } : {}),
      ...(watch.endedReason ? { ended: watch.endedReason } : {}),
      ...(watch.paused ? { paused: watch.paused } : {}),
      ...(watch.lastCheckedAt !== undefined ? { checked: `${ago(this.now - watch.lastCheckedAt)} ago` } : {}),
    };
    if (watch.kind === "inbox") {
      const items = watch.inbox ?? [];
      return {
        ...base,
        unread: items.length,
        reviewRequests: items.filter((i) => i.reason === "review_requested").length,
        // Where, not what: their titles are anyone's words.
        fromGitHub: { items: items.slice(0, 20).map((i) => ({ repository: digestText(i.repo, 100), ...(i.number ? { number: i.number } : {}), reason: i.reason, type: i.type })) },
      };
    }
    return { ...base, fromGitHub: { title: digestText(watch.title, 120) } };
  }
}

export { repoKey };
