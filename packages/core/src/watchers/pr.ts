/**
 * A pull request (PLAN.md §4.6): every 60 s while it's open, the PR itself, its reviews, and while its latest commit's
 * checks run, those checks (check runs, and the older commit statuses other CI posts). It tells when the checks of a
 * head finish (one card per head), each new review that isn't yours, and when it's merged or closed (which ends it).
 */
import { z } from "zod";
import type { CiFailedCheck, PrCardPayload } from "@aria/protocol";
import { digestText, fullName, githubBlock, githubPage, githubText, id, links, login, repoKey } from "../github/text.ts";
import { passes, type PollApi, type PollContext, type PollOutcome, type WatchEvent } from "./types.ts";

export const PrTargetSchema = z.object({ number: z.number().int().positive() });
export type PrTarget = z.infer<typeof PrTargetSchema>;

const CheckSchema = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().optional(),
  checkRunId: z.number().optional(),
  app: z.string().optional(),
  url: z.string().optional(),
  /** A commit status (not a check run): its state is success, pending, failure or error. */
  isStatus: z.boolean().optional(),
});
type Check = z.infer<typeof CheckSchema>;

export const PrStateSchema = z.object({
  pr: z
    .object({
      title: z.string(),
      state: z.string(),
      merged: z.boolean(),
      mergedBy: z.string().optional(),
      draft: z.boolean(),
      headSha: z.string().optional(),
      headRef: z.string().optional(),
      headRepo: z.string().optional(),
    })
    .optional(),
  /** The checks of the current head: what they were at the last poll, and whether they were told. */
  checks: z
    .object({
      sha: z.string(),
      firstSeenAt: z.number(),
      reported: z.boolean(),
      none: z.boolean().optional(),
      runs: z.array(CheckSchema).optional(),
      statuses: z.array(CheckSchema).optional(),
    })
    .optional(),
  /** Reviews already seen (the newest 300). */
  reviewIds: z.array(z.number()).optional(),
});
export type PrState = z.infer<typeof PrStateSchema>;

/** No check at all this long after a head was first seen: "no checks reported", and nothing more for that head. */
export const NO_CHECKS_MS = 10 * 60_000;
const REVIEWS_KEPT = 300;
const FAILED_SHOWN = 10;

function checkRunsFrom(value: unknown): Check[] {
  const list = (value as { check_runs?: unknown } | null)?.check_runs;
  if (!Array.isArray(list)) return [];
  return (list as Array<Record<string, unknown>>).slice(0, 100).map((c) => {
    const checkRunId = id(c?.id);
    const app = (c?.app as { slug?: unknown } | null | undefined)?.slug;
    const url = githubPage(c?.html_url);
    return {
      name: githubText(c?.name, 120) || "check",
      status: githubText(c?.status, 40),
      ...(typeof c?.conclusion === "string" ? { conclusion: githubText(c.conclusion, 40) } : {}),
      ...(checkRunId ? { checkRunId } : {}),
      ...(typeof app === "string" ? { app: githubText(app, 60) } : {}),
      ...(url ? { url } : {}),
    };
  });
}

/** Commit statuses (other CI): an empty list is "none", not pending (GitHub says "pending" for none at all). */
function statusesFrom(value: unknown): Check[] {
  const list = (value as { statuses?: unknown } | null)?.statuses;
  if (!Array.isArray(list)) return [];
  return (list as Array<Record<string, unknown>>).slice(0, 100).map((s) => {
    const state = typeof s?.state === "string" ? s.state : "pending";
    return { name: githubText(s?.context, 120) || "status", status: state === "pending" ? "pending" : "completed", ...(state !== "pending" ? { conclusion: state === "success" ? "success" : "failure" } : {}), isStatus: true };
  });
}

function prFrom(value: unknown): NonNullable<PrState["pr"]> | undefined {
  const p = value as Record<string, unknown> | null;
  if (!p || typeof p.state !== "string") return undefined;
  const head = p.head as { sha?: unknown; ref?: unknown; repo?: { full_name?: unknown } | null } | undefined;
  const headRepo = fullName(head?.repo?.full_name);
  const mergedBy = login((p.merged_by as { login?: unknown } | null | undefined)?.login);
  return {
    title: githubText(p.title, 200) || "untitled",
    state: githubText(p.state, 20),
    merged: p.merged === true || typeof p.merged_at === "string",
    ...(mergedBy ? { mergedBy } : {}),
    draft: p.draft === true,
    ...(typeof head?.sha === "string" && /^[0-9a-f]{40,64}$/.test(head.sha) ? { headSha: head.sha } : {}),
    ...(typeof head?.ref === "string" ? { headRef: githubText(head.ref, 250) } : {}),
    ...(headRepo ? { headRepo: repoKey(headRepo.owner, headRepo.repo) } : {}),
  };
}

interface Review {
  id: number;
  state: string;
  by?: string;
  body: string;
}

function reviewsFrom(value: unknown): Review[] {
  if (!Array.isArray(value)) return [];
  return (value as Array<Record<string, unknown>>).flatMap((r) => {
    const reviewId = id(r?.id);
    if (!reviewId || typeof r.state !== "string") return [];
    const by = login((r.user as { login?: unknown } | null | undefined)?.login);
    return [{ id: reviewId, state: r.state, ...(by ? { by } : {}), body: githubBlock(r.body, 1_000) }];
  });
}

const REVIEW_EVENT: Record<string, PrCardPayload["event"]> = { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", COMMENTED: "commented" };
/** Of several reviews by one person in one poll, the one that says the most. */
const REVIEW_RANK: Record<string, number> = { CHANGES_REQUESTED: 3, APPROVED: 2, COMMENTED: 1 };
const REVIEW_WORDS: Record<PrCardPayload["event"], string> = {
  approved: "approved",
  changes_requested: "changes requested",
  commented: "commented",
  review_requested: "review requested",
  merged: "merged",
  closed: "closed",
};

const complete = (c: Check) => c.status === "completed";

function checksEvent(ctx: PollContext, number: number, pr: NonNullable<PrState["pr"]>, sha: string, all: Check[]): WatchEvent {
  const failing = all.filter((c) => !passes(c.conclusion));
  const ok = failing.length === 0;
  const failed: CiFailedCheck[] = failing.slice(0, FAILED_SHOWN).map((c) => ({
    name: c.name,
    conclusion: c.conclusion ?? "unknown",
    ...(c.checkRunId ? { checkRunId: c.checkRunId } : {}),
    ...(c.app ? { app: c.app } : {}),
    ...(c.url ? { url: c.url } : {}),
  }));
  const summary = ok ? `${all.length} of ${all.length} passed` : `${failing.length} of ${all.length} didn't pass`;
  return {
    kind: ok ? "ci_success" : "ci_failure",
    card: {
      cardType: "ci",
      payload: {
        owner: ctx.owner,
        repo: ctx.repo,
        repoName: ctx.repoName,
        source: "checks",
        title: `Checks on PR #${number}`,
        outcome: ok ? "success" : "failure",
        conclusion: ok ? "success" : failing.length === all.length ? (failing[0]?.conclusion ?? "failure") : "mixed",
        summary,
        ...(pr.headRef ? { branch: pr.headRef } : {}),
        headSha: sha,
        prNumber: number,
        ...(failed.length ? { failed } : {}),
        url: links.checks(ctx.owner, ctx.repo, number),
      },
    },
    toast: { title: `CI · ${ctx.repoName} · checks on PR #${number} ${ok ? "passed" : "failed"}`, body: ok ? `${pr.title} · ${summary}` : `${failing.map((c) => c.name).slice(0, 4).join(", ")} · ${summary}` },
    digest: `[ci] ${ctx.repoName}: the checks on PR #${number} ${digestText(pr.title, 80)} ${ok ? "passed" : "failed"} (${summary}).${failing.length ? ` Not passing: ${failing.slice(0, 5).map((c) => digestText(c.name, 60)).join(", ")}.` : ""}`,
  };
}

function prEvent(ctx: PollContext, number: number, title: string, event: PrCardPayload["event"], extra: { by?: string; body?: string; reviewId?: number; yours?: boolean }): WatchEvent {
  const words = REVIEW_WORDS[event];
  const who = extra.by ?? "someone";
  const toastTitle = {
    merged: `PR #${number} was merged · ${ctx.repoName}`,
    closed: `PR #${number} was closed · ${ctx.repoName}`,
    commented: `${who} commented on PR #${number} · ${ctx.repoName}`,
    approved: `PR #${number} approved by ${who} · ${ctx.repoName}`,
    changes_requested: `PR #${number}: changes requested by ${who} · ${ctx.repoName}`,
    review_requested: `Review requested · ${ctx.repoName} PR #${number}`,
  }[event];
  const digest =
    event === "merged" || event === "closed"
      ? `[pr] ${ctx.repoName} PR #${number} ${digestText(title, 80)} was ${words}${extra.yours ? " (by you)" : ""}; stopped watching it.`
      : `[review] ${ctx.repoName} PR #${number} ${digestText(title, 80)}: ${words}${extra.by ? ` by ${digestText(extra.by, 40)}` : ""}.`;
  return {
    kind: event === "merged" || event === "closed" ? (extra.yours ? "pr_closed_yours" : "pr_closed") : "review",
    card: {
      cardType: "pr",
      payload: {
        owner: ctx.owner,
        repo: ctx.repo,
        repoName: ctx.repoName,
        number,
        title,
        event,
        ...(extra.by ? { by: extra.by } : {}),
        ...(extra.body ? { body: extra.body } : {}),
        ...(extra.reviewId ? { reviewId: extra.reviewId } : {}),
        ...(extra.yours ? { yours: true } : {}),
        url: links.pull(ctx.owner, ctx.repo, number),
      },
    },
    toast: { title: toastTitle, body: extra.body ? githubText(extra.body, 200) : title },
    digest,
  };
}

export async function pollPr(target: PrTarget, stateIn: PrState, api: PollApi, ctx: PollContext): Promise<PollOutcome> {
  const { owner, repo } = ctx;
  const number = target.number;
  const state: PrState = { ...stateIn };
  const url = links.pull(owner, repo, number);
  const events: WatchEvent[] = [];
  const pull = await api.get("pull", "GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: number });
  if (pull.changed) {
    const pr = prFrom(pull.data);
    if (pr) state.pr = pr;
  }
  const pr = state.pr;
  if (!pr) return { state, status: "waiting for GitHub's answer", tone: "waiting", events, nextInMs: 120_000, url };
  const title = `PR #${number} ${pr.title}`;
  if (pr.state === "closed") {
    const event = pr.merged ? "merged" : "closed";
    if (!ctx.baselined) return { state, title, status: `already ${event}`, tone: "ended", events, end: pr.merged ? "merged" : "closed", nextInMs: 0, url };
    const yours = pr.merged && pr.mergedBy !== undefined && pr.mergedBy === ctx.you;
    events.push(prEvent(ctx, number, pr.title, event, { ...(pr.mergedBy ? { by: pr.mergedBy } : {}), ...(yours ? { yours: true } : {}) }));
    return { state, title, status: event, tone: "ended", events, end: pr.merged ? "merged" : "closed", nextInMs: 0, url };
  }

  // The checks of the current head; a new push starts over.
  let checksStatus = "";
  let end: PollOutcome["end"];
  if (pr.headSha) {
    let checks = state.checks && state.checks.sha === pr.headSha ? { ...state.checks } : { sha: pr.headSha, firstSeenAt: ctx.now, reported: false };
    if (!checks.reported && !checks.none) {
      const runs = await api.get(`checks:${pr.headSha}`, "GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { owner, repo, ref: pr.headSha, filter: "latest", per_page: 100 });
      const statuses = await api.get(`status:${pr.headSha}`, "GET /repos/{owner}/{repo}/commits/{ref}/status", { owner, repo, ref: pr.headSha, per_page: 100 });
      if (runs.changed) checks.runs = checkRunsFrom(runs.data);
      if (statuses.changed) checks.statuses = statusesFrom(statuses.data);
      const all = [...(checks.runs ?? []), ...(checks.statuses ?? [])];
      if (all.length === 0) {
        if (ctx.now - checks.firstSeenAt >= NO_CHECKS_MS) checks.none = true;
        checksStatus = checks.none ? "no checks reported for its latest commit" : "waiting for its checks to start";
      } else if (all.every(complete)) {
        checks.reported = true;
        const ok = all.every((c) => passes(c.conclusion));
        // What was there when the watch started is its baseline, not news.
        if (ctx.baselined) events.push(checksEvent(ctx, number, pr, pr.headSha, all));
        checksStatus = ok ? `checks passed (${all.length})` : `checks failed (${all.filter((c) => !passes(c.conclusion)).length} of ${all.length})`;
        if (ctx.until === "checks") end = "completed";
        if (ctx.until === "success" && ok) end = "success";
      } else {
        checksStatus = `checks running: ${all.filter(complete).length} of ${all.length} done`;
      }
      // Drop the lists once told: they're only needed while the checks run.
      if (checks.reported) checks = { sha: checks.sha, firstSeenAt: checks.firstSeenAt, reported: true };
    } else {
      checksStatus = checks.none ? "no checks reported for its latest commit" : "checks done";
    }
    state.checks = checks;
  }

  const reviews = await api.get("reviews", "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", { owner, repo, pull_number: number, per_page: 100 });
  if (reviews.changed) {
    const seen = new Set(state.reviewIds ?? []);
    const fresh = reviewsFrom(reviews.data).filter((r) => !seen.has(r.id));
    // One card per reviewer per poll: the review that says the most.
    const byPerson = new Map<string, Review>();
    for (const review of fresh) {
      seen.add(review.id);
      if (!ctx.baselined || !REVIEW_EVENT[review.state] || (review.by !== undefined && review.by === ctx.you)) continue;
      const key = review.by ?? `#${review.id}`;
      const before = byPerson.get(key);
      if (!before || (REVIEW_RANK[review.state] ?? 0) >= (REVIEW_RANK[before.state] ?? 0)) byPerson.set(key, review);
    }
    for (const review of byPerson.values()) {
      events.push(prEvent(ctx, number, pr.title, REVIEW_EVENT[review.state]!, { ...(review.by ? { by: review.by } : {}), ...(review.body ? { body: review.body } : {}), reviewId: review.id }));
    }
    state.reviewIds = [...seen].slice(-REVIEWS_KEPT);
  }

  const status = [pr.draft ? "draft" : "open", checksStatus].filter(Boolean).join(" · ");
  const tone = /failed/.test(checksStatus) ? "bad" : /passed/.test(checksStatus) ? "ok" : "running";
  // Asked to wait for green or for its checks when they're already there: the tool says so instead of watching.
  return { state, title, status, tone, events, ...(end ? { end } : {}), nextInMs: 120_000, url };
}

export const prKey = (owner: string, repo: string, number: number) => `pr:${repoKey(owner, repo)}:${number}`;
