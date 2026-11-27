/**
 * A local stand-in for GitHub's REST API (only what ARIA's watchers read), on 127.0.0.1 and a free port: Vitest's
 * tests and the UI spec point ARIA at it (PLAN.md §0.4: no real GitHub while developing). Its answers follow GitHub's
 * documented shapes (written from the REST docs, not recorded from the real API). It answers like GitHub does in the
 * ways that matter here: weak ETags and 304s, Last-Modified and X-Poll-Interval on notifications, the rate-limit
 * headers, `Cache-Control: private, max-age=60`, a 301 to `/repositories/<id>/…` for a renamed repository, and only
 * GET (anything else is 405, and recorded). Switches make it fail the ways GitHub can.
 */
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";

/** A request's body (the mock's one write: opening a PR). */
const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

export const MOCK_TOKEN = "gho_ariaMockToken0000000000000000000000";

export interface MockRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  ifNoneMatch?: string;
  ifModifiedSince?: string;
  /** The request carried the token the mock expects (never the token's text: tests check it isn't recorded anywhere). */
  authorized: boolean;
  /** It carried an Authorization header at all. */
  hadAuth: boolean;
  status: number;
}

export interface MockRun {
  id: number;
  name: string;
  path: string;
  workflow_id: number;
  run_number: number;
  run_attempt?: number;
  event?: string;
  status: string;
  conclusion: string | null;
  head_branch: string;
  head_sha: string;
  head_repository?: { full_name: string };
  run_started_at?: string;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
  display_title?: string;
}

export interface MockFailure {
  /** Which paths (a regex over the path) and how often (default once). */
  path: RegExp;
  /** Only this method (else any). */
  method?: string;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  times?: number;
  /** Close the connection without an answer (offline). */
  drop?: boolean;
}

const json = (value: unknown) => JSON.stringify(value);
const etagOf = (body: string) => `W/"${createHash("sha1").update(body).digest("hex")}"`;
const sha = (seed: string) => createHash("sha1").update(seed).digest("hex");

export class MockGitHub {
  token = MOCK_TOKEN;
  login = "sam-test";
  readonly requests: MockRequest[] = [];
  /** Repositories by "owner/repo" (lowercased). */
  readonly repos = new Map<string, { id: number; full_name: string; default_branch: string }>();
  /** A renamed repository: its old "owner/repo" answers 301 to /repositories/<id>/…. */
  readonly renamed = new Map<string, number>();
  readonly runs = new Map<number, MockRun>();
  readonly jobs = new Map<number, Array<{ id: number; name: string; status: string; conclusion: string | null; html_url?: string }>>();
  readonly workflows = new Map<string, Array<{ id: number; name: string; path: string; state?: string }>>();
  readonly pulls = new Map<string, Record<string, unknown>>();
  readonly reviews = new Map<string, Array<Record<string, unknown>>>();
  readonly checkRuns = new Map<string, Array<Record<string, unknown>>>();
  readonly statuses = new Map<string, Array<Record<string, unknown>>>();
  readonly issues = new Map<string, Record<string, unknown>>();
  notifications: Array<Record<string, unknown>> = [];
  /** The search limit (its own resource, 30 a minute on GitHub), and how search answers look. */
  searchRemaining = 30;
  searchResetAt = Math.floor(Date.now() / 1000) + 60;
  /** A 200 with `X-GitHub-SSO: partial-results` (an organisation's repositories left out). */
  searchSsoPartial = false;
  searchIncomplete = false;
  /** Whether search answers carry ETags (a Phase 9 question about the real GitHub). */
  searchEtags = true;
  /** A search that ignores its `repo:` qualifiers (to check that what comes back is checked too). */
  searchIgnoresRepos = false;
  /** As GitHub: a search naming a repository it doesn't know (or the token can't see) is refused, 422. */
  searchRejectsUnknownRepos = false;
  private notificationsModified = new Date("2026-10-20T08:00:00Z").getTime();
  pollInterval = 60;
  failures: MockFailure[] = [];
  /** How long each answer takes (ms). */
  delayMs = 0;
  /** Requests kept waiting until the test lets them go (`hold`). */
  private readonly holds: { path: RegExp; arrived: () => void; released: Promise<void> }[] = [];
  remaining = 5000;
  resetAt = Math.floor(Date.now() / 1000) + 3600;
  private server: http.Server | undefined;
  private readonly sockets = new Set<Socket>();
  baseUrl = "";
  private nextId = 1000;

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    // Item 4: the log storage GitHub's log redirects point at (another origin, as GitHub's blob host is).
    this.blobServer = http.createServer((req, res) => this.serveBlob(req, res));
    this.blobServer.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.blobServer!.listen(0, "127.0.0.1", resolve));
    this.blobUrl = `http://127.0.0.1:${(this.blobServer!.address() as AddressInfo).port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (this.blobServer ? this.blobServer.close(() => resolve()) : resolve()));
  }

  // ── item 4: jobs and their logs, check runs, reviews and their comments ─────────────────────────────────────

  private blobServer: http.Server | undefined;
  /** The log storage's origin (a test's `logHosts`). */
  blobUrl = "";
  /** What reached the log storage: never a token, never a cookie. */
  readonly blobRequests: Array<{ path: string; hadAuth: boolean; hadCookie: boolean }> = [];
  /** Actions jobs by id (their id is their check run's, as on GitHub). */
  readonly actionJobs = new Map<number, { repoKey: string; id: number; runId: number; name: string; headSha: string; conclusion: string; steps: Array<{ name: string; conclusion: string | null }>; checkRunId?: number }>();
  /**
   * How each job's log is served. `log`: its text (or a Buffer); `mode`: redirect (to the log storage, the default),
   * inline (a 200 from the API), gone (410), missing (404), offList (a Location the test's list doesn't have), or a
   * status for the storage itself; `gzip`, `contentType`, `chunks` (written apart, to split a character), `closeAfter`
   * (bytes, then the socket goes), `storageRedirect` (the storage answers 302).
   */
  readonly jobLogs = new Map<number, { log?: string | Buffer; mode?: "redirect" | "inline" | "gone" | "missing" | "offList"; offList?: string; storageStatus?: number; gzip?: boolean; contentType?: string | null; chunks?: Buffer[]; closeAfter?: number; storageRedirect?: string; endless?: boolean }>();
  /** An endless log's connection was closed (by the reader stopping). */
  blobClosed = false;
  /** Inline comments by review: "owner/repo#n/reviewId". */
  readonly reviewComments = new Map<string, Array<Record<string, unknown>>>();

  addJob(owner: string, repo: string, job: { id: number; runId?: number; name: string; headSha: string; conclusion?: string; steps?: Array<{ name: string; conclusion: string | null }>; checkRunId?: number; log?: string }): void {
    this.actionJobs.set(job.id, { repoKey: `${owner}/${repo}`.toLowerCase(), runId: job.runId ?? 1, conclusion: job.conclusion ?? "failure", steps: job.steps ?? [], ...job });
    if (job.log !== undefined) this.jobLogs.set(job.id, { ...(this.jobLogs.get(job.id) ?? {}), log: job.log });
  }

  addReviewComments(owner: string, repo: string, number: number, reviewId: number, comments: Array<{ path: string; line?: number | null; startLine?: number; body: string; by?: string; inReplyTo?: number; reviewId?: number }>): number[] {
    const key = `${owner}/${repo}#${number}/${reviewId}`.toLowerCase();
    const ids: number[] = [];
    const list = comments.map((c) => {
      const id = ++this.nextId;
      ids.push(id);
      return {
        id,
        pull_request_review_id: c.reviewId ?? reviewId,
        path: c.path,
        line: c.line === undefined ? 10 : c.line,
        original_line: 10,
        ...(c.startLine ? { start_line: c.startLine } : {}),
        side: "RIGHT",
        body: c.body,
        user: { login: c.by ?? "bob", type: "User" },
        ...(c.inReplyTo ? { in_reply_to_id: c.inReplyTo } : {}),
      };
    });
    this.reviewComments.set(key, [...(this.reviewComments.get(key) ?? []), ...list]);
    return ids;
  }

  private jobLogAnswer(repoKey: string, id: number): { status: number; headers: Record<string, string>; body?: string | Buffer } | undefined {
    const job = this.actionJobs.get(id);
    if (!job || job.repoKey !== repoKey) return undefined;
    const how = this.jobLogs.get(id) ?? {};
    if (how.mode === "gone") return { status: 410, headers: {}, body: JSON.stringify({ message: "Gone" }) };
    if (how.mode === "missing" || how.log === undefined) return { status: 404, headers: {}, body: JSON.stringify({ message: "Not Found" }) };
    if (how.mode === "inline") return { status: 200, headers: { "content-type": "text/plain; charset=utf-8" }, body: how.log };
    const signed = `/actions-results/${createHash("sha1").update(String(id)).digest("hex")}/job-${id}.txt?sv=2023&se=2026-10-21T12%3A00%3A00Z&sp=r&sig=${createHash("sha1").update(`sig-${id}`).digest("hex")}`;
    const location = how.mode === "offList" ? (how.offList ?? `https://productionresultssa1.blob.core.windows.net.aria-evil.invalid${signed}`) : `${this.blobUrl}${signed}`;
    return { status: 302, headers: { location }, body: "" };
  }

  private serveBlob(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    this.blobRequests.push({ path: url.pathname, hadAuth: req.headers.authorization !== undefined, hadCookie: req.headers.cookie !== undefined });
    const id = Number(/job-(\d+)\.txt$/.exec(url.pathname)?.[1]);
    const how = this.jobLogs.get(id);
    if (!how || how.log === undefined || !url.searchParams.get("sig")) {
      res.writeHead(403, { "content-type": "application/xml" });
      res.end("<Error>AuthenticationFailed</Error>");
      return;
    }
    if (how.storageRedirect) {
      res.writeHead(302, { location: how.storageRedirect });
      res.end();
      return;
    }
    if (how.storageStatus) {
      res.writeHead(how.storageStatus);
      res.end();
      return;
    }
    const headers: Record<string, string> = {};
    if (how.contentType !== null) headers["content-type"] = how.contentType ?? "text/plain";
    if (how.gzip) headers["content-encoding"] = "gzip";
    const body = typeof how.log === "string" ? Buffer.from(how.log, "utf8") : how.log;
    res.writeHead(200, headers);
    if (how.chunks) {
      // Written apart, with pauses: a character split across two chunks.
      const chunks = [...how.chunks];
      const next = () => {
        const chunk = chunks.shift();
        if (!chunk) return void res.end();
        res.write(chunk);
        setTimeout(next, 20);
      };
      next();
      return;
    }
    if (how.closeAfter !== undefined) {
      res.write(body.subarray(0, how.closeAfter), () => setTimeout(() => req.socket.destroy(), 30));
      return;
    }
    if (how.endless) {
      // A log that never ends: `body` again and again until the reader goes away.
      const more = () => {
        if (res.destroyed || req.socket.destroyed) return;
        res.write(body, () => setTimeout(more, 2));
      };
      res.on("close", () => (this.blobClosed = true));
      more();
      return;
    }
    res.end(body);
  }

  // ── building GitHub's state ───────────────────────────────────────────────────────────────────────────────────

  addRepo(owner: string, repo: string, defaultBranch = "main"): number {
    const id = ++this.nextId;
    this.repos.set(`${owner}/${repo}`.toLowerCase(), { id, full_name: `${owner}/${repo}`, default_branch: defaultBranch });
    return id;
  }

  addWorkflow(owner: string, repo: string, name: string, file: string, extra?: { path?: string; state?: string }): number {
    const id = ++this.nextId;
    const key = `${owner}/${repo}`.toLowerCase();
    this.workflows.set(key, [
      ...(this.workflows.get(key) ?? []),
      { id, name, path: extra?.path ?? `.github/workflows/${file}`, ...(extra?.state ? { state: extra.state } : {}) },
    ]);
    return id;
  }

  /** A workflow run; `at` is when it started (ISO). */
  addRun(owner: string, repo: string, run: Partial<MockRun> & { name: string; status: string }): MockRun {
    const id = run.id ?? ++this.nextId;
    const workflows = this.workflows.get(`${owner}/${repo}`.toLowerCase()) ?? [];
    const workflow = workflows.find((w) => w.name === run.name);
    const full: MockRun = {
      id,
      path: workflow?.path ?? `.github/workflows/${run.name.toLowerCase()}.yml`,
      workflow_id: workflow?.id ?? 1,
      run_number: [...this.runs.values()].filter((r) => r.name === run.name).length + 1,
      run_attempt: 1,
      event: "push",
      conclusion: null,
      head_branch: "main",
      head_sha: sha(`run-${id}`),
      head_repository: { full_name: `${owner}/${repo}` },
      run_started_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      html_url: `https://github.com/${owner}/${repo}/actions/runs/${id}`,
      ...run,
    } as MockRun;
    (full as MockRun & { repoKey: string }).repoKey = `${owner}/${repo}`.toLowerCase();
    this.runs.set(id, full);
    return full;
  }

  /** A run finishes (after `ms` of running). */
  finishRun(id: number, conclusion: string, ms = 252_000): void {
    const run = this.runs.get(id)!;
    run.status = "completed";
    run.conclusion = conclusion;
    run.updated_at = new Date(new Date(run.run_started_at ?? Date.now()).getTime() + ms).toISOString();
  }

  addPull(
    owner: string,
    repo: string,
    number: number,
    fields: { title: string; headSha?: string; headRef?: string; headRepo?: string; base?: string; draft?: boolean; author?: string; reviewers?: string[]; assignees?: string[]; updatedAt?: string },
  ): Record<string, unknown> {
    const headRepo = fields.headRepo ?? `${owner}/${repo}`;
    const headRef = fields.headRef ?? `feature-${number}`;
    const pull: Record<string, unknown> = {
      number,
      title: fields.title,
      state: "open",
      merged: false,
      merged_at: null,
      merged_by: null,
      draft: fields.draft ?? false,
      head: { sha: fields.headSha ?? sha(`pr-${number}`), ref: headRef, label: `${headRepo.split("/")[0]}:${headRef}`, repo: { full_name: headRepo } },
      base: { ref: fields.base ?? "main" },
      html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
      user: { login: fields.author ?? this.login },
      requested_reviewers: (fields.reviewers ?? []).map((login) => ({ login })),
      assignees: (fields.assignees ?? []).map((login) => ({ login })),
      updated_at: fields.updatedAt ?? new Date().toISOString(),
    };
    this.pulls.set(`${owner}/${repo}#${number}`.toLowerCase(), pull);
    return pull;
  }

  /** An open issue (search only). */
  addIssue(owner: string, repo: string, number: number, fields: { title: string; author?: string; assignees?: string[]; updatedAt?: string }): Record<string, unknown> {
    const issue: Record<string, unknown> = {
      number,
      title: fields.title,
      state: "open",
      html_url: `https://github.com/${owner}/${repo}/issues/${number}`,
      user: { login: fields.author ?? "someone" },
      assignees: (fields.assignees ?? []).map((login) => ({ login })),
      updated_at: fields.updatedAt ?? new Date().toISOString(),
    };
    this.issues.set(`${owner}/${repo}#${number}`.toLowerCase(), issue);
    return issue;
  }

  /** What `GET /search/issues` would find for a query (the qualifiers My work uses), newest first. */
  private searchResults(q: string): Array<Record<string, unknown>> {
    const tokens = q.split(/\s+/).filter(Boolean);
    const repos = new Set(tokens.filter((t) => t.startsWith("repo:")).map((t) => t.slice(5).toLowerCase()));
    const me = (who: string) => (who === "@me" ? this.login : who);
    const wants = (name: string) => tokens.find((t) => t.startsWith(`${name}:`))?.slice(name.length + 1);
    const prsOnly = tokens.includes("is:pr");
    const where = (page: unknown) => /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:pull|issues)\/\d+$/.exec(String(page));
    const candidates = [...[...this.pulls.values()].map((p) => ({ item: p, pr: true })), ...(prsOnly ? [] : [...this.issues.values()].map((i) => ({ item: i, pr: false })))];
    return candidates
      .filter(({ item }) => {
        const at = where(item.html_url);
        if (!at || (repos.size && !this.searchIgnoresRepos && !repos.has(`${at[1]}/${at[2]}`.toLowerCase()))) return false;
        if (tokens.includes("is:open") && item.state !== "open") return false;
        const author = wants("author");
        if (author && (item.user as { login: string }).login !== me(author)) return false;
        const reviewer = wants("review-requested");
        if (reviewer && !((item.requested_reviewers as Array<{ login: string }> | undefined) ?? []).some((r) => r.login === me(reviewer))) return false;
        const assignee = wants("assignee");
        if (assignee && !((item.assignees as Array<{ login: string }> | undefined) ?? []).some((a) => a.login === me(assignee))) return false;
        return true;
      })
      .map(({ item, pr }) => {
        const at = where(item.html_url)!;
        return {
          number: item.number,
          title: item.title,
          state: item.state,
          user: item.user,
          ...(pr ? { draft: item.draft, pull_request: { url: `${this.baseUrl}/repos/${at[1]}/${at[2]}/pulls/${String(item.number)}` } } : {}),
          repository_url: `${this.baseUrl || "https://api.github.com"}/repos/${at[1]}/${at[2]}`,
          html_url: item.html_url,
          updated_at: item.updated_at,
        };
      })
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }

  pull(owner: string, repo: string, number: number): Record<string, unknown> {
    return this.pulls.get(`${owner}/${repo}#${number}`.toLowerCase())!;
  }

  addReview(owner: string, repo: string, number: number, review: { by: string; state: string; body?: string; association?: string; userType?: string; commitId?: string }): number {
    const key = `${owner}/${repo}#${number}`.toLowerCase();
    const id = ++this.nextId;
    this.reviews.set(key, [
      ...(this.reviews.get(key) ?? []),
      {
        id,
        user: { login: review.by, type: review.userType ?? "User" },
        state: review.state,
        body: review.body ?? "",
        author_association: review.association ?? "COLLABORATOR",
        ...(review.commitId ? { commit_id: review.commitId } : {}),
        submitted_at: new Date().toISOString(),
        html_url: `https://github.com/${owner}/${repo}/pull/${number}#pullrequestreview-${id}`,
      },
    ]);
    return id;
  }

  /** `id`: a check run's id (an Actions job's is the same); `output`: what a non-Actions check said. */
  setChecks(owner: string, repo: string, headSha: string, checks: Array<{ name: string; status: string; conclusion?: string | null; app?: string; id?: number; output?: { title?: string; summary?: string } }>): void {
    this.checkRuns.set(
      `${owner}/${repo}@${headSha}`.toLowerCase(),
      checks.map((c, i) => ({ id: c.id ?? 5000 + i, name: c.name, status: c.status, conclusion: c.conclusion ?? null, app: { slug: c.app ?? "github-actions" }, html_url: `https://github.com/${owner}/${repo}/runs/${c.id ?? 5000 + i}`, ...(c.output ? { output: c.output } : {}) })),
    );
  }

  setStatuses(owner: string, repo: string, headSha: string, statuses: Array<{ context: string; state: string; target_url?: string }>): void {
    this.statuses.set(`${owner}/${repo}@${headSha}`.toLowerCase(), statuses.map((s, i) => ({ id: 9000 + i, ...s })));
  }

  /** A notification thread (unread); returns its id. */
  addNotification(n: { repo: string; reason: string; type?: string; title: string; number?: number; updatedAt?: string }): string {
    const id = String(++this.nextId);
    const kind = n.type ?? "PullRequest";
    this.notifications.unshift({
      id,
      unread: true,
      reason: n.reason,
      updated_at: n.updatedAt ?? new Date().toISOString(),
      subject: { title: n.title, type: kind, url: n.number ? `${this.baseUrl || "https://api.github.com"}/repos/${n.repo}/${kind === "PullRequest" ? "pulls" : "issues"}/${n.number}` : null },
      repository: { full_name: n.repo },
    });
    this.touchNotifications();
    return id;
  }

  touchNotifications(): void {
    this.notificationsModified = Math.max(this.notificationsModified + 1000, Date.now());
  }

  /** The rate limit is used up until `resetAt` (seconds). */
  exhaust(resetAt: number): void {
    this.remaining = 0;
    this.resetAt = resetAt;
  }

  count(path: RegExp, method = "GET"): number {
    return this.requests.filter((r) => r.method === method && path.test(r.path)).length;
  }

  /**
   * Keeps every request to `path` waiting, unanswered, until `release()`. `arrived` resolves once the first one is in.
   * Unlike `delayMs`, a slow machine can't outrun it: the test decides when the answer goes.
   */
  hold(path: RegExp): { arrived: Promise<void>; release: () => void } {
    let arrived!: () => void;
    let release!: () => void;
    const arrival = new Promise<void>((resolve) => (arrived = resolve));
    const hold = { path, arrived, released: new Promise<void>((resolve) => (release = resolve)) };
    this.holds.push(hold);
    return {
      arrived: arrival,
      release: () => {
        const at = this.holds.indexOf(hold);
        if (at >= 0) this.holds.splice(at, 1);
        release();
      },
    };
  }

  // ── item 3: branches, compares, opening a PR ──────────────────────────────────────────────────────────────────

  /** Where a test's pushes go (bare repositories `<owner>/<repo>.git`): branches and compares are read from there. */
  gitRoot: string | undefined;
  /** Branches set by hand ("owner/repo@branch" lowercased → sha), over what the bare repositories have. */
  readonly branches = new Map<string, string>();
  /** The PRs opened, with exactly what was sent. */
  readonly opened: Array<{ owner: string; repo: string; body: Record<string, unknown> }> = [];
  /** The workflows dispatched (`POST .../actions/workflows/{id}/dispatches`), with exactly what was sent. */
  readonly dispatched: Array<{ owner: string; repo: string; workflowId: string; body: Record<string, unknown> }> = [];
  /** When true, dispatching a workflow automatically creates an `in_progress` MockRun on that branch. */
  spawnRunOnDispatch = false;
  /** A repository that doesn't take draft PRs (GitHub: some plans). */
  draftsUnsupported = false;

  private git(repoKey: string, args: string[]): { ok: boolean; out: string } {
    if (!this.gitRoot) return { ok: false, out: "" };
    const dir = `${this.gitRoot}/${repoKey}.git`;
    const result = childProcess.spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true });
    return { ok: result.status === 0, out: String(result.stdout ?? "").trim() };
  }

  branchSha(repoKey: string, name: string): string | undefined {
    const set = this.branches.get(`${repoKey}@${name}`.toLowerCase());
    if (set) return set;
    const read = this.git(repoKey, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`]);
    return read.ok && /^[0-9a-f]{40,64}$/.test(read.out) ? read.out : undefined;
  }

  /** GitHub's compare status of `head` against `base` (behind: head is in base). */
  private compare(repoKey: string, base: string, head: string): string | undefined {
    if (base === head) return "identical";
    const known = (sha: string) => this.git(repoKey, ["cat-file", "-e", `${sha}^{commit}`]).ok;
    if (!known(base) || !known(head)) return undefined;
    if (this.git(repoKey, ["merge-base", "--is-ancestor", head, base]).ok) return "behind";
    if (this.git(repoKey, ["merge-base", "--is-ancestor", base, head]).ok) return "ahead";
    return "diverged";
  }

  private openPull(owner: string, repo: string, text: string): { status: number; body: unknown } {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { status: 400, body: { message: "Problems parsing JSON" } };
    }
    this.opened.push({ owner, repo, body: payload });
    const repoKey = `${owner}/${repo}`.toLowerCase();
    if (!this.repos.has(repoKey)) return { status: 404, body: { message: "Not Found" } };
    const invalid = (message: string) => ({ status: 422, body: { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message }] } });
    if (payload.draft === true && this.draftsUnsupported) return invalid("Draft pull requests are not supported in this repository.");
    const head = String(payload.head ?? "");
    const [headOwner, headRef] = head.includes(":") ? (head.split(":") as [string, string]) : [owner, head];
    const label = `${headOwner}:${headRef}`;
    if ([...this.pulls.values()].some((p) => p.state === "open" && (p.head as { label?: string }).label === label)) return invalid(`A pull request already exists for ${label}.`);
    const base = String(payload.base ?? "");
    if (!this.branchSha(repoKey, base)) return { status: 422, body: { message: "Validation Failed", errors: [{ resource: "PullRequest", field: "base", code: "invalid" }] } };
    const headSha = this.branchSha(`${headOwner}/${repo}`.toLowerCase(), headRef);
    if (!headSha) return { status: 422, body: { message: "Validation Failed", errors: [{ resource: "PullRequest", field: "head", code: "invalid" }] } };
    const number = Math.max(0, ...[...this.pulls.keys()].filter((k) => k.startsWith(`${repoKey}#`)).map((k) => Number(k.split("#")[1]))) + 1;
    const pull: Record<string, unknown> = {
      number,
      title: payload.title,
      body: payload.body,
      state: "open",
      merged: false,
      merged_at: null,
      merged_by: null,
      draft: payload.draft === true,
      head: { sha: headSha, ref: headRef, label, repo: { full_name: `${headOwner}/${repo}` } },
      base: { ref: base },
      html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
      user: { login: this.login },
      requested_reviewers: [],
      assignees: [],
      updated_at: new Date().toISOString(),
    };
    this.pulls.set(`${repoKey}#${number}`, pull);
    return { status: 201, body: pull };
  }

  private dispatchWorkflow(owner: string, repo: string, workflowId: string, text: string): { status: number; body: unknown } {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { status: 400, body: { message: "Problems parsing JSON" } };
    }
    this.dispatched.push({ owner, repo, workflowId, body: payload });
    const repoKey = `${owner}/${repo}`.toLowerCase();
    if (!this.repos.has(repoKey)) return { status: 404, body: { message: "Not Found" } };
    const workflows = this.workflows.get(repoKey) ?? [];
    const workflow = workflows.find((w) => String(w.id) === workflowId || w.path.endsWith(`/${workflowId}`));
    if (!workflow) return { status: 404, body: { message: "Not Found" } };
    if (workflow.state === "disabled_manually" || workflow.state === "disabled_inactivity") {
      return { status: 422, body: { message: "Workflow is disabled" } };
    }
    const ref = String(payload.ref ?? "");
    if (!this.branchSha(repoKey, ref)) {
      return { status: 422, body: { message: `No ref found for: ${ref}` } };
    }
    if (this.spawnRunOnDispatch) {
      this.addRun(owner, repo, {
        name: workflow.name,
        workflow_id: workflow.id,
        path: workflow.path,
        status: "in_progress",
        head_branch: ref,
        event: "workflow_dispatch",
      });
    }
    return { status: 204, body: undefined };
  }

  // ── answering ─────────────────────────────────────────────────────────────────────────────────────────────────

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const query = Object.fromEntries(url.searchParams.entries());
    const auth = req.headers.authorization;
    const authorized = auth === `token ${this.token}` || auth === `bearer ${this.token}`;
    const record = (status: number) =>
      this.requests.push({
        method: req.method ?? "?",
        path: url.pathname,
        query,
        ...(typeof req.headers["if-none-match"] === "string" ? { ifNoneMatch: req.headers["if-none-match"] } : {}),
        ...(typeof req.headers["if-modified-since"] === "string" ? { ifModifiedSince: req.headers["if-modified-since"] } : {}),
        authorized,
        hadAuth: auth !== undefined,
        status,
      });
    const held = this.holds.find((h) => h.path.test(url.pathname));
    if (held) {
      held.arrived();
      await held.released;
    }
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const rate = () => ({ "x-ratelimit-limit": "5000", "x-ratelimit-remaining": String(this.remaining), "x-ratelimit-reset": String(this.resetAt), "x-ratelimit-resource": "core" });
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      record(status);
      const text = body === undefined ? "" : json(body);
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "private, max-age=60, s-maxage=60", ...rate(), ...headers });
      res.end(text);
    };
    // Writes GitHub answers here: opening a pull request (item 3) and dispatching a workflow. Anything else that isn't a GET is 405.
    const opening = req.method === "POST" && /^\/repos\/[^/]+\/[^/]+\/pulls$/.test(url.pathname);
    const dispatching = req.method === "POST" && /^\/repos\/[^/]+\/[^/]+\/actions\/workflows\/[^/]+\/dispatches$/.test(url.pathname);
    if (req.method !== "GET" && !opening && !dispatching) return send(405, { message: "Not allowed by the mock" });
    const bodyText = opening || dispatching ? await readBody(req) : "";
    const failure = this.failures.find((f) => f.path.test(url.pathname) && (!f.method || f.method === req.method));
    if (failure) {
      failure.times = (failure.times ?? 1) - 1;
      if (failure.times <= 0) this.failures.splice(this.failures.indexOf(failure), 1);
      if (failure.drop) {
        record(0);
        req.socket.destroy();
        return;
      }
      return send(failure.status, failure.body ?? { message: `mock failure ${failure.status}` }, failure.headers);
    }
    if (!authorized) return send(401, { message: "Bad credentials" });
    if (opening) {
      const [, owner, repo] = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(url.pathname)!;
      const answer = this.openPull(owner!, repo!, bodyText);
      return send(answer.status, answer.body);
    }
    if (dispatching) {
      const [, owner, repo, wf] = /^\/repos\/([^/]+)\/([^/]+)\/actions\/workflows\/([^/]+)\/dispatches$/.exec(url.pathname)!;
      const answer = this.dispatchWorkflow(owner!, repo!, decodeURIComponent(wf!), bodyText);
      return send(answer.status, answer.body);
    }
    if (url.pathname === "/search/issues") {
      // Search has its own limit, named in x-ratelimit-resource.
      const searchRate = { "x-ratelimit-limit": "30", "x-ratelimit-remaining": String(this.searchRemaining), "x-ratelimit-reset": String(this.searchResetAt), "x-ratelimit-resource": "search" };
      if (this.searchRemaining <= 0) return send(403, { message: "API rate limit exceeded" }, searchRate);
      const named = (url.searchParams.get("q") ?? "").split(/\s+/).filter((t) => t.startsWith("repo:")).map((t) => t.slice(5).toLowerCase());
      if (this.searchRejectsUnknownRepos && named.some((repo) => !this.repos.has(repo))) {
        this.searchRemaining = Math.max(0, this.searchRemaining - 1);
        return send(
          422,
          { message: "Validation Failed", errors: [{ message: "The listed users and repositories cannot be searched either because the resources do not exist or you do not have permission to view them.", resource: "Search", field: "q", code: "invalid" }] },
          searchRate,
        );
      }
      const all = this.searchResults(url.searchParams.get("q") ?? "");
      const body = json({ total_count: all.length, incomplete_results: this.searchIncomplete, items: all.slice(0, Number(url.searchParams.get("per_page") ?? 30)) });
      const etag = etagOf(body);
      const extra: Record<string, string> = { ...searchRate, ...(this.searchEtags ? { etag } : {}), ...(this.searchSsoPartial ? { "x-github-sso": "partial-results; organizations=21955855" } : {}) };
      if (this.searchEtags && req.headers["if-none-match"] === etag) {
        record(304);
        res.writeHead(304, { "cache-control": "no-cache", ...extra });
        res.end();
        return;
      }
      this.searchRemaining = Math.max(0, this.searchRemaining - 1);
      record(200);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache", ...extra, "x-ratelimit-remaining": String(this.searchRemaining) });
      res.end(body);
      return;
    }
    if (this.remaining <= 0) return send(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" });
    // A job's log: GitHub answers with a redirect to its storage (another host), not with JSON.
    const logs = /^\/repos\/([^/]+)\/([^/]+)\/actions\/jobs\/(\d+)\/logs$/.exec(url.pathname);
    if (logs) {
      const answer = this.jobLogAnswer(`${logs[1]}/${logs[2]}`.toLowerCase(), Number(logs[3]));
      if (!answer) return send(404, { message: "Not Found" });
      record(answer.status);
      res.writeHead(answer.status, { ...rate(), ...answer.headers });
      res.end(answer.body ?? "");
      return;
    }

    // A renamed repository: GitHub answers 301 to the repository's id.
    const named = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (named) {
      const moved = this.renamed.get(`${named[1]}/${named[2]}`.toLowerCase());
      if (moved !== undefined) {
        record(301);
        res.writeHead(301, { location: `${this.baseUrl}/repositories/${moved}${named[3] ?? ""}${url.search}`, "content-type": "application/json" });
        res.end(json({ message: "Moved Permanently" }));
        return;
      }
    }
    const byId = /^\/repositories\/(\d+)(\/.*)?$/.exec(url.pathname);
    let repoKey: string | undefined;
    let rest = "";
    if (named) {
      repoKey = `${named[1]}/${named[2]}`.toLowerCase();
      rest = named[3] ?? "";
    } else if (byId) {
      repoKey = [...this.repos.entries()].find(([, r]) => r.id === Number(byId[1]))?.[0];
      rest = byId[2] ?? "";
    }
    const answer = this.route(url.pathname, repoKey, rest, query);
    if (answer === undefined) return send(404, { message: "Not Found" });
    const body = json(answer.body);
    const etag = etagOf(body);
    const headers: Record<string, string> = { etag };
    if (answer.lastModified) headers["last-modified"] = new Date(answer.lastModified).toUTCString();
    if (answer.poll) headers["x-poll-interval"] = String(this.pollInterval);
    const notModified =
      req.headers["if-none-match"] === etag || (answer.lastModified !== undefined && typeof req.headers["if-modified-since"] === "string" && Date.parse(req.headers["if-modified-since"]) >= Math.floor(answer.lastModified / 1000) * 1000);
    if (notModified) {
      record(304);
      res.writeHead(304, { "cache-control": "private, max-age=60, s-maxage=60", ...rate(), ...headers });
      res.end();
      return;
    }
    // A 304 doesn't count against the limit; a 200 does.
    this.remaining = Math.max(0, this.remaining - 1);
    record(200);
    const cut = this.cutAfterHeaders.findIndex((c) => c.test(url.pathname));
    if (cut >= 0) {
      // Item 4's review, finding 1: the headers (with the new answer's ETag) and half the body, then the connection
      // goes. Once a path.
      this.cutAfterHeaders.splice(cut, 1);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(body)), ...rate(), ...headers });
      res.write(body.slice(0, Math.floor(body.length / 2)), () => setTimeout(() => req.socket.destroy(), 30));
      return;
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "private, max-age=60, s-maxage=60", ...rate(), ...headers });
    res.end(body);
  }

  /** Paths whose next 200 is cut off after its headers (once each). */
  readonly cutAfterHeaders: RegExp[] = [];

  private route(pathname: string, repoKey: string | undefined, rest: string, query: Record<string, string>): { body: unknown; lastModified?: number; poll?: boolean } | undefined {
    if (pathname === "/user") return { body: { login: this.login, id: 42 } };
    if (pathname === "/notifications") return { body: this.notifications.slice(0, Number(query.per_page ?? 50)), lastModified: this.notificationsModified, poll: true };
    if (!repoKey) return undefined;
    const repo = this.repos.get(repoKey);
    if (!repo) return undefined;
    const runsOf = () => [...this.runs.values()].filter((r) => (r as MockRun & { repoKey?: string }).repoKey === repoKey && (!query.branch || r.head_branch === query.branch));
    const page = <T>(list: T[]) => list.slice(0, Number(query.per_page ?? 30));
    const strip = (run: MockRun) => {
      const { repoKey: _key, ...plain } = run as MockRun & { repoKey?: string };
      return plain;
    };
    if (rest === "") return { body: repo };
    if (rest === "/actions/runs") {
      const runs = runsOf().sort((a, b) => b.id - a.id);
      return { body: { total_count: runs.length, workflow_runs: page(runs).map(strip) } };
    }
    let m = /^\/actions\/runs\/(\d+)$/.exec(rest);
    if (m) {
      const run = this.runs.get(Number(m[1]));
      return run && (run as MockRun & { repoKey?: string }).repoKey === repoKey ? { body: strip(run) } : undefined;
    }
    m = /^\/actions\/runs\/(\d+)\/jobs$/.exec(rest);
    if (m) {
      const jobs = this.jobs.get(Number(m[1])) ?? [];
      return { body: { total_count: jobs.length, jobs } };
    }
    if (rest === "/actions/workflows") {
      const workflows = this.workflows.get(repoKey) ?? [];
      return { body: { total_count: workflows.length, workflows } };
    }
    m = /^\/actions\/workflows\/([^/]+)\/runs$/.exec(rest);
    if (m) {
      const wanted = decodeURIComponent(m[1]!);
      const workflow = (this.workflows.get(repoKey) ?? []).find((w) => String(w.id) === wanted || w.path.endsWith(`/${wanted}`));
      if (!workflow) return undefined;
      const runs = runsOf()
        .filter((r) => r.workflow_id === workflow.id)
        .sort((a, b) => b.id - a.id);
      return { body: { total_count: runs.length, workflow_runs: page(runs).map(strip) } };
    }
    // Item 3's reads: a branch, a compare of two commits, the open PRs for a head (from the test's bare repositories).
    m = /^\/branches\/(.+)$/.exec(rest);
    if (m) {
      const name = decodeURIComponent(m[1]!);
      const commit = this.branchSha(repoKey, name);
      return commit ? { body: { name, commit: { sha: commit } } } : undefined;
    }
    m = /^\/compare\/([0-9a-f]{40,64})\.\.\.([0-9a-f]{40,64})$/.exec(rest);
    if (m) {
      const status = this.compare(repoKey, m[1]!, m[2]!);
      return status ? { body: { status } } : undefined;
    }
    if (rest === "/pulls") {
      const open = [...this.pulls.entries()].filter(([key, p]) => key.startsWith(`${repoKey}#`) && p.state === "open" && (p.head as { label?: string }).label === query.head).map(([, p]) => p);
      return { body: open.slice(0, Number(query.per_page ?? 30)) };
    }
    // Item 4's reads: a job, a check run, a review, its inline comments.
    m = /^\/actions\/jobs\/(\d+)$/.exec(rest);
    if (m) {
      const job = this.actionJobs.get(Number(m[1]));
      if (!job || job.repoKey !== repoKey) return undefined;
      return {
        body: {
          id: job.id,
          run_id: job.runId,
          head_sha: job.headSha,
          name: job.name,
          status: "completed",
          conclusion: job.conclusion,
          check_run_url: `${this.baseUrl}/repos/${repo.full_name}/check-runs/${job.checkRunId ?? job.id}`,
          html_url: `https://github.com/${repo.full_name}/actions/runs/${job.runId}/job/${job.id}`,
          steps: job.steps.map((s, i) => ({ name: s.name, status: "completed", conclusion: s.conclusion, number: i + 1 })),
        },
      };
    }
    m = /^\/check-runs\/(\d+)$/.exec(rest);
    if (m) {
      for (const [key, runs] of this.checkRuns) {
        if (!key.startsWith(`${repoKey}@`)) continue;
        const found = runs.find((r) => r.id === Number(m![1]));
        if (found) return { body: { ...found, head_sha: key.slice(repoKey.length + 1) } };
      }
      return undefined;
    }
    m = /^\/pulls\/(\d+)\/reviews\/(\d+)$/.exec(rest);
    if (m) {
      const review = (this.reviews.get(`${repoKey}#${m[1]}`) ?? []).find((r) => r.id === Number(m![2]));
      return review ? { body: review } : undefined;
    }
    m = /^\/pulls\/(\d+)\/reviews\/(\d+)\/comments$/.exec(rest);
    if (m) return { body: page(this.reviewComments.get(`${repoKey}#${m[1]}/${m[2]}`) ?? []) };
    m = /^\/pulls\/(\d+)$/.exec(rest);
    if (m) return this.pulls.has(`${repoKey}#${m[1]}`) ? { body: this.pulls.get(`${repoKey}#${m[1]}`) } : undefined;
    m = /^\/pulls\/(\d+)\/reviews$/.exec(rest);
    if (m) return { body: page(this.reviews.get(`${repoKey}#${m[1]}`) ?? []) };
    m = /^\/commits\/([0-9a-f]+)\/check-runs$/.exec(rest);
    if (m) {
      const checks = this.checkRuns.get(`${repoKey}@${m[1]}`) ?? [];
      return { body: { total_count: checks.length, check_runs: checks } };
    }
    m = /^\/commits\/([0-9a-f]+)\/status$/.exec(rest);
    if (m) {
      const statuses = this.statuses.get(`${repoKey}@${m[1]}`) ?? [];
      const state = statuses.length === 0 ? "pending" : statuses.some((s) => s.state === "failure" || s.state === "error") ? "failure" : statuses.some((s) => s.state === "pending") ? "pending" : "success";
      return { body: { state, total_count: statuses.length, statuses } };
    }
    return undefined;
  }
}
