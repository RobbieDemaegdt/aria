/**
 * My work (PLAN.md §5.2, D38–D40): the pull requests waiting for your review, your own, and what's assigned to you, on
 * your projects only, from GitHub's search (github/search.ts: three fixed shapes, scoped by `repo:`). Fetched while My
 * work is open (the window asks: on open, every 5 minutes while it's visible, on Refresh), at most once a minute, one
 * fetch at a time. Kept in memory only: the titles are anyone's words, shown to you as plain text and never sent to
 * ARIA (no tool, no digest line). Each query's raw answer and ETag are kept, so one 304 among them still rebuilds the
 * whole list. A login change, a refused token or a signed-out gh drops it all (a generation counter: a fetch from before
 * is dropped when it answers).
 */
import type { MyWorkItem, MyWorkOutlookState, MyWorkReason, MyWorkTrackerState, MyWorkState } from "@aria/protocol";
import type { Clock } from "../attention/clock.ts";
import type { GitHubAccess } from "../github/access.ts";
import { GitHubFailure } from "../github/client.ts";
import { SEARCH_PER_PAGE, SEARCH_REASONS, searchBatches, searchQuery } from "../github/search.ts";
import { githubText, id as asId, links, login as asLogin, time, validName } from "../github/text.ts";

export const COOLDOWN_MS = 60_000;
/** A repository GitHub can't search is asked about again after this long. */
const UNSEARCHABLE_MS = 3_600_000;

export interface MyWorkProject {
  repoId: number;
  repoName: string;
}

export interface MyWorkDeps {
  access: GitHubAccess | undefined;
  clock: Clock;
  /** Your projects' repositories on github.com (lowercased "owner/name": origins first, then forks' upstreams). */
  projects: () => ReadonlyMap<string, MyWorkProject>;
  /** The active PR watch on a pull request, if there's one. */
  prWatch: (owner: string, repo: string, number: number) => number | undefined;
  /** Assigned tracker tasks and watcher status (Phase 7B). */
  tracker?: () => MyWorkTrackerState | undefined;
  /** Trigger a tracker poll when My work is opened or refreshed (Phase 7B). */
  refreshTracker?: (refresh: boolean) => Promise<void>;
  /** Actionable unread Outlook emails and watcher status. */
  outlook?: () => MyWorkOutlookState | undefined;
  /** Trigger an Outlook poll when My work is opened or refreshed. */
  refreshOutlook?: (refresh: boolean) => Promise<void>;
  emit: (state: MyWorkState) => void;
}

interface RawItem {
  owner: string;
  repo: string;
  number: number;
  kind: "pr" | "issue";
  title: string;
  author?: string;
  draft?: boolean;
  updatedAt: number;
}

interface RawAnswer {
  etag?: string;
  items: RawItem[];
  total: number;
  incomplete: boolean;
  sso: boolean;
}

const NONE: Record<MyWorkReason, number> = { review_requested: 0, authored: 0, assigned: 0 };

function sameMyWorkItemData(a: MyWorkItem, b: MyWorkItem): boolean {
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
    a.why.length === b.why.length &&
    a.why.every((w, i) => w === b.why[i])
  );
}

/**
 * Reconciles the newly merged items against the previous list:
 * - On the initial load (`!preserveOrder` or `prev.length === 0`), sorts by `updatedAt` descending.
 * - On subsequent syncs, deletes items that are gone, leaves unchanged items untouched in their existing order,
 *   updates changed items in place, and inserts brand-new items without reordering untouched items.
 */
export function reconcileMyWorkItems(
  prev: readonly MyWorkItem[],
  nextMap: ReadonlyMap<string, MyWorkItem>,
  preserveOrder: boolean,
): MyWorkItem[] {
  if (!preserveOrder || prev.length === 0) {
    return [...nextMap.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  const prevKeys = new Set<string>();
  const kept: MyWorkItem[] = [];
  for (const existing of prev) {
    const next = nextMap.get(existing.key);
    if (!next) continue; // Deleted: item is actually gone
    prevKeys.add(existing.key);
    // Unchanged: keep the exact existing item object in place
    kept.push(sameMyWorkItemData(existing, next) ? existing : next);
  }
  const added = [...nextMap.values()]
    .filter((item) => !prevKeys.has(item.key))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (added.length === 0) return kept;
  const result = [...kept];
  for (const item of added) {
    const insertIdx = result.findIndex((existing) => existing.updatedAt < item.updatedAt);
    if (insertIdx === -1) result.push(item);
    else result.splice(insertIdx, 0, item);
  }
  return result;
}

/** One search item, from checked parts only (its repository from `repository_url`, its link built by ARIA). */
function rawItem(value: unknown): RawItem | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as { number?: unknown; title?: unknown; repository_url?: unknown; user?: { login?: unknown }; draft?: unknown; pull_request?: unknown; updated_at?: unknown };
  const number = asId(v.number);
  const where = typeof v.repository_url === "string" ? /\/repos\/([^/]+)\/([^/]+)$/.exec(v.repository_url) : null;
  if (!number || !where || !validName(where[1]) || !validName(where[2])) return undefined;
  const author = asLogin(v.user?.login);
  return {
    owner: where[1]!,
    repo: where[2]!,
    number,
    kind: v.pull_request !== undefined && v.pull_request !== null ? "pr" : "issue",
    title: githubText(v.title, 300),
    ...(author ? { author } : {}),
    ...(v.draft === true ? { draft: true } : {}),
    updatedAt: time(v.updated_at) ?? 0,
  };
}

export class MyWork {
  private generation = 0;
  private state: MyWorkState;
  /** Per query: its last answer and ETag. */
  private raw = new Map<string, RawAnswer>();
  /** Queries from the last completed refresh, so in-flight refreshes keep unpolled sections populated. */
  private lastQueries: Array<{ reason: MyWorkReason; q: string }> = [];
  /** The last list's items by key (Watch looks one up; a key is never parsed). */
  private byKey = new Map<string, MyWorkItem>();
  private fetching: Promise<MyWorkState> | undefined;
  private lastFetchAt: number | undefined;
  /** The login the list (and its ETags) belongs to. */
  private login: string | undefined;
  private stopped = false;
  /** The fetch on its way: stopping, or a login change, aborts it. */
  private controller: AbortController | undefined;
  /** Repositories GitHub can't search for this login ("owner/name" → until when they're left out). */
  private readonly unsearchable = new Map<string, number>();

  constructor(private readonly deps: MyWorkDeps) {
    this.state = { status: deps.access ? "waiting" : "off", items: [], more: { ...NONE } };
  }

  /** The list as it is, with each PR's watch as it is now. */
  view(): MyWorkState {
    const tracker = this.deps.tracker?.();
    const includeTracker = tracker !== undefined && (tracker.status !== "off" || tracker.tasks.length > 0);
    const outlook = this.deps.outlook?.();
    const includeOutlook = outlook !== undefined && (outlook.status !== "off" || outlook.messages.length > 0);
    return {
      ...this.state,
      items: this.state.items.map((item) => this.withWatch(item)),
      ...(includeTracker ? { tracker } : {}),
      ...(includeOutlook ? { outlook } : {}),
    };
  }

  /** Emits the updated My work state when the tracker or Outlook watcher state changes in the background. */
  trackerChanged(): void {
    if (this.stopped) return;
    this.deps.emit(this.view());
  }

  outlookChanged(): void {
    if (this.stopped) return;
    this.deps.emit(this.view());
  }

  /** An item of the last list, by its key. */
  item(key: string): MyWorkItem | undefined {
    const item = this.byKey.get(key);
    return item ? this.withWatch(item) : undefined;
  }

  private withWatch(item: MyWorkItem): MyWorkItem {
    const rest: MyWorkItem = { ...item };
    delete rest.watchId;
    const watchId = item.kind === "pr" ? this.deps.prWatch(item.owner, item.repo, item.number) : undefined;
    return watchId !== undefined ? { ...rest, watchId } : rest;
  }

  /** The window asks (on open, every 5 minutes while it's open and visible, on Refresh). */
  async get(refresh: boolean): Promise<MyWorkState> {
    if (this.stopped) return this.view();
    const access = this.deps.access;
    const extraRefreshes = async () => {
      await Promise.all([
        this.deps.refreshTracker ? this.deps.refreshTracker(refresh) : Promise.resolve(),
        this.deps.refreshOutlook ? this.deps.refreshOutlook(refresh) : Promise.resolve(),
      ]);
    };
    if (!access) {
      if (this.deps.refreshTracker || this.deps.refreshOutlook) {
        await extraRefreshes();
        const view = this.view();
        this.deps.emit(view);
        return view;
      }
      return this.view();
    }
    const extraPromise = this.deps.refreshTracker || this.deps.refreshOutlook ? extraRefreshes() : undefined;
    if (this.fetching) {
      if (extraPromise) await extraPromise;
      return this.fetching;
    }
    const now = this.deps.clock.now();
    const fresh = this.lastFetchAt !== undefined && now - this.lastFetchAt < COOLDOWN_MS;
    if (fresh || (!refresh && this.state.status === "ok")) {
      if (extraPromise) {
        await extraPromise;
        const view = this.view();
        this.deps.emit(view);
        return view;
      }
      return this.view();
    }
    const run = (extraPromise
      ? Promise.all([this.fetch(access), extraPromise]).then(() => this.view())
      : this.fetch(access)
    ).finally(() => {
      if (this.fetching === run) this.fetching = undefined;
    });
    this.fetching = run;
    return run;
  }

  private set(state: MyWorkState): MyWorkState {
    this.state = state;
    const view = this.view();
    this.deps.emit(view);
    return view;
  }

  private async fetch(access: GitHubAccess): Promise<MyWorkState> {
    if (!access.ready(this.deps.clock.now(), "search")) await access.ensure();
    const now = this.deps.clock.now();
    if (!access.ready(now, "search")) {
      const until = access.searchPause(now);
      const why = until !== undefined ? "GitHub's search limit is used up: My work waits for its reset." : (access.view().message ?? "GitHub can't be searched right now.");
      return this.set({ ...this.state, status: "waiting", message: why, ...(until !== undefined ? { until } : {}) });
    }
    // Another login than the list's: what's kept (the list, its ETags) was the other one's.
    const login = access.login;
    if (login !== this.login) this.forget();
    this.login = login;
    const generation = this.generation;
    // Stopping (or a login change) aborts what's on its way, a search waiting in Octokit's queue too.
    const controller = new AbortController();
    this.controller = controller;
    this.set({ ...this.state, status: "loading" });
    const projects = this.deps.projects();
    const start = this.deps.clock.now();
    // Repositories GitHub can't search (gone, renamed, not visible to this login) are left out for an hour, and named.
    for (const [repo, until] of this.unsearchable) if (until <= start) this.unsearchable.delete(repo);
    const { batches, unsearched } = searchBatches([...projects.keys()].filter((repo) => !this.unsearchable.has(repo)));
    const stale = () => this.stopped || generation !== this.generation || access.login !== login || controller.signal.aborted;
    const done: Array<{ reason: MyWorkReason; q: string }> = [];
    const activeBatches: string[][] = batches.map((b) => [...b]);
    const polledSlots = new Set<string>();
    let failed = 0;
    let stop: { status: "waiting" | "error"; message: string; until?: number } | undefined;
    const isSubsequentRefresh = this.lastFetchAt !== undefined;
    const effectiveQueries = () => {
      const merged = [...done];
      const includedQ = new Set(done.map((d) => d.q));
      const coveredReasons = new Set(done.map((d) => d.reason));
      for (let bIdx = 0; bIdx < activeBatches.length; bIdx++) {
        const b = activeBatches[bIdx]!;
        if (b.length === 0) continue;
        for (const reason of SEARCH_REASONS) {
          if (polledSlots.has(`${bIdx}:${reason}`)) continue;
          const q = searchQuery(reason, b);
          if (!includedQ.has(q) && this.raw.has(q)) {
            merged.push({ reason, q });
            includedQ.add(q);
            coveredReasons.add(reason);
          }
        }
      }
      // If the project list changed between refreshes, fall back to previous cached queries for reasons not yet polled.
      for (const prev of this.lastQueries) {
        if (!coveredReasons.has(prev.reason) && !includedQ.has(prev.q) && this.raw.has(prev.q)) {
          merged.push(prev);
          includedQ.add(prev.q);
        }
      }
      return merged;
    };
    const partialNow = () => this.merge(effectiveQueries(), projects, unsearched, failed, login, isSubsequentRefresh);

    batching: for (let bIdx = 0; bIdx < activeBatches.length; bIdx++) {
      let batch = activeBatches[bIdx]!;
      for (let i = 0; i < SEARCH_REASONS.length; i++) {
        const reason = SEARCH_REASONS[i]!;
        const q = searchQuery(reason, batch);
        try {
          await this.search(access, q, controller.signal);
          done.push({ reason, q });
          polledSlots.add(`${bIdx}:${reason}`);
        } catch (error) {
          if (stale()) return this.view();
          const type = error instanceof GitHubFailure ? error.type : "invalid";
          const until = access.searchPause();
          if (until !== undefined) {
            stop = { status: "waiting", message: "GitHub's search limit is used up: My work waits for its reset.", until };
            break batching;
          }
          if (type === "offline" || type === "auth" || type === "rate_limited" || type === "secondary_limit" || type === "stopped") {
            stop = { status: "error", message: error instanceof GitHubFailure ? error.message : "GitHub's answer couldn't be read." };
            break batching;
          }
          // 422: GitHub can't search one of the batch's repositories. Which: GitHub is asked about each (a read), they're
          // left out (and named), and the batch's searches go on without them.
          if (error instanceof GitHubFailure && error.details.status === 422) {
            const gone = await this.unsearchableIn(access, batch, controller.signal);
            if (stale()) return this.view();
            const rest = batch.filter((repo) => !gone.includes(repo));
            activeBatches[bIdx] = rest;
            if (gone.length > 0 && rest.length > 0) {
              batch = rest;
              i--;
              continue;
            }
            if (gone.length > 0) continue batching;
          }
          // Anything else (a 5xx after the retries): this search failed; the others go on, and the list says so.
          failed++;
          polledSlots.add(`${bIdx}:${reason}`);
          // Its last answer (this login's) stands in for it.
          if (this.raw.has(q)) done.push({ reason, q });
        }
        if (stale()) return this.view();
        // What answered shows at once (the rest comes in as it answers: searches are spaced 2 s apart).
        this.set({ ...partialNow(), status: "loading" });
      }
    }
    if (stale()) return this.view();
    const finalQueries = stop ? effectiveQueries() : done;
    // Only this refresh's queries (a project list that changed leaves old ones behind).
    const current = new Set(finalQueries.map((x) => x.q));
    for (const q of [...this.raw.keys()]) if (!current.has(q)) this.raw.delete(q);
    this.lastQueries = [...finalQueries];
    // A minute between searches, after a failure too.
    this.lastFetchAt = this.deps.clock.now();
    const merged = this.merge(finalQueries, projects, unsearched, failed, login, isSubsequentRefresh);
    return this.set(stop ? { ...merged, status: stop.status, message: stop.message, ...(stop.until !== undefined ? { until: stop.until } : {}) } : merged);
  }

  /** One search, conditionally (its last ETag); its answer (or the last one, on a 304) is kept for the merge. */
  private async search(access: GitHubAccess, q: string, signal: AbortSignal): Promise<void> {
    const before = this.raw.get(q);
    const result = await access.get("GET /search/issues", { q, sort: "updated", order: "desc", per_page: SEARCH_PER_PAGE }, before?.etag ? { etag: before.etag } : {}, signal);
    if (result.status === 304) {
      if (!before) throw new GitHubFailure("invalid", "GitHub said nothing changed about a search ARIA hadn't made.");
      // The same items; whether an organisation's were left out is this answer's to say.
      this.raw.set(q, { ...before, sso: result.ssoPartial === true });
      return;
    }
    const data = (result.data ?? {}) as { items?: unknown; total_count?: unknown; incomplete_results?: unknown };
    const items = (Array.isArray(data.items) ? data.items : []).map(rawItem).filter((i): i is RawItem => i !== undefined);
    this.raw.set(q, {
      ...(result.etag ? { etag: result.etag } : {}),
      items,
      total: typeof data.total_count === "number" && Number.isFinite(data.total_count) ? data.total_count : items.length,
      incomplete: data.incomplete_results === true,
      sso: result.ssoPartial === true,
    });
  }

  /** Of a batch GitHub refused to search (422), the repositories it doesn't let this login see (a 404 or 403 each). */
  private async unsearchableIn(access: GitHubAccess, batch: readonly string[], signal: AbortSignal): Promise<string[]> {
    const gone: string[] = [];
    for (const repo of batch) {
      const [owner, name] = repo.split("/") as [string, string];
      try {
        await access.get("GET /repos/{owner}/{repo}", { owner, repo: name }, {}, signal);
      } catch (error) {
        if (error instanceof GitHubFailure && (error.type === "not_found" || error.type === "forbidden" || error.type === "sso")) gone.push(repo);
        else if (error instanceof GitHubFailure && (error.type === "offline" || error.type === "stopped" || error.type === "auth" || error.type === "rate_limited" || error.type === "secondary_limit")) break;
      }
    }
    const until = this.deps.clock.now() + UNSEARCHABLE_MS;
    for (const repo of gone) this.unsearchable.set(repo, until);
    return gone;
  }

  private merge(queries: Array<{ reason: MyWorkReason; q: string }>, projects: ReadonlyMap<string, MyWorkProject>, unsearched: number, failed: number, login: string | undefined, preserveOrder = false): MyWorkState {
    const now = this.deps.clock.now();
    const items = new Map<string, MyWorkItem>();
    const more = { ...NONE };
    let sso = false;
    let incomplete = false;
    for (const { reason, q } of queries) {
      const answer = this.raw.get(q);
      if (!answer) continue;
      more[reason] += Math.max(0, answer.total - answer.items.length);
      sso ||= answer.sso;
      incomplete ||= answer.incomplete;
      for (const raw of answer.items) {
        const project = projects.get(`${raw.owner}/${raw.repo}`.toLowerCase());
        // D38: your projects only (the queries say so already; what comes back is checked too).
        if (!project) continue;
        const key = `${raw.owner}/${raw.repo}#${raw.number}`.toLowerCase();
        const known = items.get(key);
        if (known) {
          if (!known.why.includes(reason)) known.why.push(reason);
          continue;
        }
        items.set(key, {
          key,
          kind: raw.kind,
          owner: raw.owner,
          repo: raw.repo,
          repoId: project.repoId,
          repoName: project.repoName,
          number: raw.number,
          title: raw.title,
          ...(raw.author ? { author: raw.author } : {}),
          ...(raw.draft ? { draft: true } : {}),
          why: [reason],
          updatedAt: raw.updatedAt,
          url: raw.kind === "pr" ? links.pull(raw.owner, raw.repo, raw.number) : links.issue(raw.owner, raw.repo, raw.number),
        });
      }
    }
    const list = reconcileMyWorkItems(this.state.items, items, preserveOrder);
    this.byKey = new Map(list.map((item) => [item.key, item]));
    const unsearchable = [...this.unsearchable.keys()].filter((repo) => projects.has(repo)).map((repo) => `${projects.get(repo)!.repoName} (${repo})`);
    const partial = {
      ...(sso ? { sso } : {}),
      ...(incomplete ? { incomplete } : {}),
      ...(unsearched ? { unsearched } : {}),
      ...(failed ? { failed } : {}),
      ...(unsearchable.length ? { unsearchable } : {}),
    };
    return { status: "ok", ...(login ? { login } : {}), checkedAt: now, items: list, more, ...(Object.keys(partial).length ? { partial } : {}) };
  }

  /** The list, its raw answers and their ETags go (they were another login's, or GitHub can't be read as this one). */
  private forget(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
    this.unsearchable.clear();
    this.raw.clear();
    this.lastQueries = [];
    this.byKey.clear();
    this.lastFetchAt = undefined;
    this.login = undefined;
    this.state = { status: this.deps.access && !this.stopped ? "waiting" : "off", items: [], more: { ...NONE } };
  }

  /** GitHub access changed: another login, a refused token, a signed-out or missing gh drop the list. */
  accessChanged(): void {
    const access = this.deps.access;
    if (!access || this.stopped) return;
    const status = access.view().status;
    const gone = status === "token_refused" || status === "signed_out" || status === "no_cli";
    const another = this.login !== undefined && access.login !== undefined && access.login !== this.login;
    if (!gone && !another) return;
    if (this.state.items.length === 0 && this.raw.size === 0 && !this.fetching) return;
    this.forget();
    this.deps.emit(this.view());
  }

  stop(): void {
    this.stopped = true;
    this.forget();
  }
}
