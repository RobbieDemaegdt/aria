/**
 * Your GitHub notifications (PLAN.md §4.6, D37): `GET /notifications` no more often than GitHub's `X-Poll-Interval`
 * (60 s or more), with `If-Modified-Since`. Only a review request makes a card (and a toast when you're away); the rest
 * is listed for My work. Their titles are anyone's words: they're shown to you, and never reach ARIA (its digest line
 * names the repository and number only).
 */
import { z } from "zod";
import type { InboxItem } from "@aria/protocol";
import { fullName, githubText, links, subjectPage, time } from "../github/text.ts";
import type { PollApi, PollContext, PollOutcome, WatchEvent } from "./types.ts";

export const InboxTargetSchema = z.object({});

const ItemSchema = z.object({
  id: z.string(),
  reason: z.string(),
  type: z.string(),
  title: z.string(),
  repo: z.string(),
  number: z.number().optional(),
  url: z.string(),
  updatedAt: z.number(),
});

export const InboxStateSchema = z.object({
  /** Threads seen (id → updated_at), the newest 500. */
  seen: z.record(z.string(), z.number()).optional(),
  /** Review requests already told, by thread (a comment later updates the thread, not the request). */
  requested: z.array(z.string()).optional(),
  /** The unread ones, for My work (the first 50). */
  items: z.array(ItemSchema).optional(),
});
export type InboxState = z.infer<typeof InboxStateSchema>;

const SEEN_KEPT = 500;
const REQUESTED_KEPT = 200;
export const INBOX_MIN_MS = 120_000;

function itemsFrom(value: unknown): InboxItem[] {
  if (!Array.isArray(value)) return [];
  const items: InboxItem[] = [];
  for (const t of value as Array<Record<string, unknown>>) {
    const threadId = typeof t?.id === "string" && /^\d{1,30}$/.test(t.id) ? t.id : undefined;
    const repo = fullName((t?.repository as { full_name?: unknown } | null | undefined)?.full_name);
    const updatedAt = time(t?.updated_at);
    const subject = t?.subject as { title?: unknown; url?: unknown; type?: unknown } | null | undefined;
    if (!threadId || !repo || updatedAt === undefined) continue;
    const page = subjectPage(subject?.url, repo.owner, repo.repo);
    items.push({
      id: threadId,
      reason: githubText(t.reason, 40) || "subscribed",
      type: githubText(subject?.type, 40) || "Notification",
      title: githubText(subject?.title, 200) || "(no title)",
      repo: `${repo.owner}/${repo.repo}`,
      ...(page.number ? { number: page.number } : {}),
      url: page.url,
      updatedAt,
    });
    if (items.length >= 50) break;
  }
  return items;
}

function requestEvent(ctx: PollContext, item: InboxItem): WatchEvent {
  const [owner, repo] = item.repo.split("/") as [string, string];
  const repoName = ctx.nameFor(owner, repo);
  const where = `${repoName} PR #${item.number}`;
  return {
    kind: "review_request",
    card: { cardType: "pr", payload: { owner, repo, repoName, number: item.number!, title: item.title, event: "review_requested", url: item.url } },
    toast: { title: `Review requested · ${where}`, body: item.title },
    // D37: no title (anyone can write one), only where it is.
    digest: `[github] You were asked to review ${where}.`,
  };
}

export async function pollInbox(stateIn: InboxState, api: PollApi, ctx: PollContext): Promise<PollOutcome> {
  const answer = await api.get("notifications", "GET /notifications", { per_page: 50 });
  let state: InboxState = { ...stateIn };
  const events: WatchEvent[] = [];
  if (answer.changed) {
    const items = itemsFrom(answer.data);
    const seen = { ...(state.seen ?? {}) };
    const requested = new Set(state.requested ?? []);
    for (const item of items) {
      const before = seen[item.id];
      const isNew = before === undefined || item.updatedAt > before;
      seen[item.id] = item.updatedAt;
      // The first look is the baseline: what's already in the inbox isn't news.
      if (!ctx.baselined || !isNew) continue;
      if (item.reason === "review_requested" && item.type === "PullRequest" && item.number && !requested.has(item.id)) {
        requested.add(item.id);
        events.push(requestEvent(ctx, item));
      }
    }
    if (!ctx.baselined) for (const item of items) if (item.reason === "review_requested") requested.add(item.id);
    const kept = Object.entries(seen)
      .sort((a, b) => b[1] - a[1])
      .slice(0, SEEN_KEPT);
    state = { seen: Object.fromEntries(kept), requested: [...requested].slice(-REQUESTED_KEPT), items };
  }
  const items = state.items ?? [];
  const reviews = items.filter((i) => i.reason === "review_requested").length;
  const status = `${items.length} unread${reviews ? ` · ${reviews} review request${reviews === 1 ? "" : "s"}` : ""}`;
  return { state, title: "GitHub inbox", status, tone: "ok", events, nextInMs: INBOX_MIN_MS, url: links.notifications() };
}
