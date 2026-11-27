/**
 * Phase 5B: Plain-code activity collectors for ARIA tasks, GitHub events, and local git commits
 * (PLAN.md §4.14, §8, §10 Phase 5B).
 *
 * - ARIA task collector: records one `aria` activity per execution stretch (`task:<taskId>:run:<stretch>`) so a
 *   task continued on another day never creates a multi-day block.
 * - GitHub collector: records `github` activities when you open or update a PR (`pr_opened`, `pr_updated`) and when
 *   watches report CI runs, reviews, or PR merges/closures (`ci_run`, `pr_review`, `pr_merged`, `pr_closed`).
 * - Local git collector (`scanLocalGitActivities`): runs a single locked-down `git log --branches --source` per
 *   registered project (at most 3 in parallel), filters to commits that are yours (see `isYours` in `scanOneProject`: on a
 *   `aria/*` branch, made under the app's own commit email, authored under your git or GitHub identity, or by a name or email
 *   in the Timekeeper setting `ownAuthors`: exact matches only), marks unpushed commits, resolves each commit's branch without $N+1$ git spawns, and extracts any tracker task ID from the
 *   commit message or branch name without storing untrusted commit bodies.
 */
import type { Activity, Project, Task, TimeRule } from "@aria/protocol";
import { execa } from "execa";
import type { Store } from "../store/store.ts";
import { cleanTitle } from "../tasks/pr.ts";
import { localGitEnvironment } from "../tasks/push.ts";
import { isNoTracker } from "../trackers/none.ts";
import { ownedBy } from "../trackers/owner.ts";
import type { TaskTracker } from "../trackers/types.ts";
import { resolveActivityDuration, resolveActivityTask } from "./rules.ts";
import { APP_GIT_EMAIL } from "../util/app-identity.ts";
import { onlyWaitedFor } from "../util/ignore.ts";

const GIT_SCAN_CONCURRENCY = 3;
const GIT_SCAN_COOLDOWN_MS = 30_000;
const DEFAULT_LOOKBACK_MS = 7 * 86_400_000;
const MAX_COMMITS_PER_REPO = 300;
const MAX_TITLE = 160;

export interface ActivityCollectorDeps {
  db: () => Store;
  tracker: () => TaskTracker;
  projects: () => Project[];
  tasks: () => Task[];
  refreshActiveTasks?: () => void;
  githubLogin?: () => string | undefined;
  /** Extra author names and emails that count as yours (the Timekeeper's `ownAuthors`): exact matches, case ignored. Read at each scan. */
  ownAuthors?: () => readonly string[];
  now?: () => number;
}

async function runLockedGit(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  const res = await execa(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.longpaths=true",
      "-c",
      "log.showSignature=false",
      "-c",
      "log.mailmap=false",
      "--no-replace-objects",
      "-C",
      cwd,
      ...args,
    ],
    {
      env: localGitEnvironment(process.env),
      reject: false,
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return { ok: res.exitCode === 0, stdout: String(res.stdout ?? "") };
}

function normalizeBranchRef(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const trimmed = ref.trim().replace(/\^.*$/, "").replace(/~.*$/, "");
  if (!trimmed) return undefined;
  return trimmed
    .replace(/^refs\/heads\//i, "")
    .replace(/^refs\/remotes\/origin\//i, "")
    .replace(/^origin\//i, "");
}

/** Picks the best branch name from `git log --source`'s `%S` ref and `%D` decorations, preferring feature/`aria/*` branches over `main`/`master`. */
function chooseBranch(sourceRef: string, decorations: string, defaultBranch?: string): string | undefined {
  const candidates: string[] = [];
  const fromSource = normalizeBranchRef(sourceRef);
  if (fromSource) candidates.push(fromSource);
  if (decorations.trim()) {
    for (const part of decorations.split(",")) {
      const cleaned = part.trim().replace(/^HEAD ->\s*/i, "");
      if (!cleaned || cleaned.startsWith("tag:")) continue;
      const norm = normalizeBranchRef(cleaned);
      if (norm && !candidates.includes(norm)) candidates.push(norm);
    }
  }
  const def = defaultBranch?.toLowerCase() ?? "main";
  const feature = candidates.find((b) => b.toLowerCase() !== def && b.toLowerCase() !== "main" && b.toLowerCase() !== "master" && b !== "HEAD");
  return feature ?? candidates.find((b) => b !== "HEAD");
}

export class ActivityCollector {
  private readonly lastGitScanByKey = new Map<string, number>();
  private inFlightScan: { key: string; promise: Promise<number> } | undefined;
  private scanChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ActivityCollectorDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * Records or updates an ARIA task's execution stretch (`task:<taskId>:run:<stretch>`).
   * Each run stretch gets its own row so continuing a task the next day creates a new stretch on that day.
   */
  recordTaskStretch(input: {
    task: Pick<
      Task,
      | "id"
      | "title"
      | "brief"
      | "repoId"
      | "repoName"
      | "branch"
      | "state"
      | "commits"
      | "pr"
      | "trackerTaskId"
      | "trackerId"
      | "startedAt"
      | "finishedAt"
      | "createdAt"
    >;
    stretch: number;
    stretchStartedAt: number;
    stretchEndedAt?: number;
    trackerTaskManual?: boolean;
  }): Activity {
    const { task, stretch, stretchStartedAt, stretchEndedAt, trackerTaskManual } = input;
    const now = this.now();
    const startedAt = stretchStartedAt || task.startedAt || task.createdAt || now;
    const endedAt = Math.max(startedAt, stretchEndedAt ?? now);
    const tracker = this.deps.tracker();
    const autoLinked =
      tracker.taskRefFromBranch(task.branch) ??
      tracker.extractTaskRef(task.title, task.brief);
    const linkedTrackerTaskId = task.trackerTaskId ?? (trackerTaskManual ? undefined : autoLinked);

    return this.deps.db().upsertActivity({
      source: "aria",
      kind: "task",
      startedAt,
      endedAt,
      repoId: task.repoId,
      externalId: `task:${task.id}:run:${Math.max(1, stretch)}`,
      title: cleanTitle(task.title, MAX_TITLE) || "ARIA task",
      linkedTrackerTaskId,
      // The link a task carries is its tracker's (`trackerId`); one found in its branch or brief is the tracker in use's.
      ...(linkedTrackerTaskId ? { linkedTrackerId: task.trackerTaskId ? (task.trackerId ?? tracker.id) : tracker.id } : {}),
      ...(trackerTaskManual ? { manualLink: true } : {}),
      metadata: {
        taskId: task.id,
        stretch: Math.max(1, stretch),
        repoName: task.repoName,
        state: task.state,
        ...(task.branch ? { branch: task.branch } : {}),
        ...(task.commits !== undefined ? { commits: task.commits } : {}),
        ...(task.pr ? { prNumber: task.pr.number } : {}),
      },
    });
  }

  /** Updates all recorded stretches of an ARIA task when its `trackerTaskId` is manually linked or cleared. */
  syncTaskTrackerLink(taskId: string, trackerTaskId: string | undefined): void {
    this.deps.db().setTaskActivitiesTracker(taskId, trackerTaskId, this.deps.tracker().id);
  }

  /** Records a GitHub activity (PR opened/updated/merged/closed, PR review, or CI run). */
  recordGitHubActivity(input: {
    kind: "pr_opened" | "pr_updated" | "pr_merged" | "pr_closed" | "pr_review" | "ci_run";
    externalId: string;
    at?: number;
    durationMs?: number;
    repoId?: number;
    repoName: string;
    owner: string;
    repo: string;
    title: string;
    branch?: string;
    prNumber?: number;
    runId?: number;
    url?: string;
    taskId?: string;
    extraTextForLink?: string;
  }): Activity {
    const end = input.at ?? this.now();
    const start = input.durationMs && input.durationMs > 0 ? Math.max(0, end - input.durationMs) : end;
    const task = input.taskId ? this.deps.tasks().find((t) => t.id === input.taskId) : undefined;
    const tracker = this.deps.tracker();
    const linkedTrackerTaskId =
      task?.trackerTaskId ??
      tracker.taskRefFromBranch(input.branch) ??
      tracker.extractTaskRef(input.title, input.extraTextForLink);

    return this.deps.db().upsertActivity({
      source: "github",
      kind: input.kind,
      startedAt: start,
      endedAt: end,
      ...(input.repoId !== undefined ? { repoId: input.repoId } : {}),
      externalId: input.externalId,
      title: cleanTitle(input.title, MAX_TITLE) || "GitHub activity",
      ...(linkedTrackerTaskId ? { linkedTrackerTaskId, linkedTrackerId: task?.trackerTaskId ? (task.trackerId ?? tracker.id) : tracker.id } : {}),
      metadata: {
        repoName: input.repoName,
        repo: `${input.owner}/${input.repo}`,
        ...(input.branch ? { branch: cleanTitle(input.branch, 120) } : {}),
        ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        ...(input.url ? { url: input.url } : {}),
        ...(input.taskId ? { taskId: input.taskId } : {}),
      },
    });
  }

  /** Records a tracker task update activity (`assigned`, `status_changed`, `priority_changed`, `comment_added`, `updated`). */
  recordTrackerActivity(input: {
    taskId: string;
    title: string;
    event: "assigned" | "status_changed" | "priority_changed" | "comment_added" | "updated";
    at?: number;
    externalKey?: string;
    status?: string;
    /** How many characters of `status` the activity keeps (default 60). A tracker whose readers keep longer statuses says so. */
    statusMax?: number;
    previousStatus?: string;
    priority?: string;
    previousPriority?: string;
    comment?: string;
    commentBy?: string;
    projectName?: string;
    customerName?: string;
    url?: string;
  }): Activity {
    // Its external ID would carry no tracker's id: with no tracker a task update isn't recorded.
    if (isNoTracker(this.deps.tracker())) throw new Error("No task tracker is set up, so a task update isn't recorded.");
    const start = input.at ?? this.now();
    const end = start + 15 * 60_000;
    const dayKey = new Date(start).toISOString().slice(0, 10);
    const extId = input.externalKey ?? `${this.deps.tracker().id}:${input.taskId}:${input.event}:${dayKey}`;
    const cleanTaskTitle = cleanTitle(input.title, 120) || `Task #${input.taskId}`;
    let summary: string;
    switch (input.event) {
      case "assigned":
        summary = `Assigned #${input.taskId}: ${cleanTaskTitle}`;
        break;
      case "status_changed":
        summary = `#${input.taskId} (${cleanTaskTitle}) · status → ${input.status ?? "updated"}`;
        break;
      case "priority_changed":
        summary = `#${input.taskId} (${cleanTaskTitle}) · priority → ${input.priority ?? "updated"}`;
        break;
      case "comment_added":
        summary = `#${input.taskId} (${cleanTaskTitle}) · new comment${input.commentBy ? ` by ${input.commentBy}` : ""}`;
        break;
      case "updated":
        summary = `#${input.taskId}: ${cleanTaskTitle}${input.status ? ` [${input.status}]` : ""}`;
        break;
    }

    return this.deps.db().upsertActivity({
      source: "tracker",
      kind: "task_updated",
      startedAt: start,
      endedAt: end,
      externalId: extId,
      title: cleanTitle(summary, MAX_TITLE),
      linkedTrackerTaskId: input.taskId,
      linkedTrackerId: this.deps.tracker().id,
      metadata: {
        taskId: input.taskId,
        taskTitle: cleanTaskTitle,
        event: input.event,
        ...(input.status ? { status: cleanTitle(input.status, input.statusMax ?? 60) } : {}),
        ...(input.previousStatus ? { previousStatus: cleanTitle(input.previousStatus, 60) } : {}),
        ...(input.priority ? { priority: cleanTitle(input.priority, 60) } : {}),
        ...(input.previousPriority ? { previousPriority: cleanTitle(input.previousPriority, 60) } : {}),
        ...(input.comment ? { comment: cleanTitle(input.comment, 200) } : {}),
        ...(input.commentBy ? { commentBy: cleanTitle(input.commentBy, 80) } : {}),
        ...(input.projectName ? { projectName: cleanTitle(input.projectName, 100) } : {}),
        ...(input.customerName ? { customerName: cleanTitle(input.customerName, 100) } : {}),
        ...(input.url ? { url: input.url } : {}),
      },
    });
  }

  /** Records a sent email activity (`Work IQ Mail`). */
  recordMailActivity(input: {
    externalId: string;
    subject: string;
    at?: number;
    recipient?: string;
    bodyPreview?: string;
    linkedTrackerTaskId?: string;
  }): Activity {
    const start = input.at ?? this.now();
    const end = start + 15 * 60_000;
    const cleanSubject = cleanTitle(input.subject, MAX_TITLE) || "(No subject)";
    const cleanRecipient = input.recipient ? cleanTitle(input.recipient, 120) : undefined;
    const linked = input.linkedTrackerTaskId ?? this.deps.tracker().extractTaskRef(input.subject, input.bodyPreview);

    return this.deps.db().upsertActivity({
      source: "mail",
      kind: "mail",
      startedAt: start,
      endedAt: end,
      externalId: input.externalId,
      title: cleanSubject,
      ...(linked ? { linkedTrackerTaskId: linked, linkedTrackerId: this.deps.tracker().id } : {}),
      metadata: {
        subject: cleanSubject,
        ...(cleanRecipient ? { recipient: cleanRecipient, to: cleanRecipient } : {}),
      },
    });
  }

  /**
   * Scans local git repositories for commits authored by you within `[since, until]` (default: last 7 days), bounded to
   * 3 repositories in parallel. Returns how many commit activities were recorded or updated.
   */
  async scanLocalGitActivities(options: { since?: number; until?: number; repoId?: number; force?: boolean } = {}): Promise<number> {
    const now = this.now();
    const since = options.since ?? Math.floor((now - DEFAULT_LOOKBACK_MS) / 60_000) * 60_000;
    const until = options.until ?? Math.ceil((now + 60_000) / 60_000) * 60_000;
    const cacheKey = `${options.repoId ?? "all"}:${since}:${until}`;
    const lastAt = this.lastGitScanByKey.get(cacheKey);
    if (!options.force && lastAt !== undefined && now - lastAt < GIT_SCAN_COOLDOWN_MS) {
      return 0;
    }
    if (!options.force && this.inFlightScan?.key === cacheKey) {
      return this.inFlightScan.promise;
    }

    const execute = async (): Promise<number> => {
      const allProjects = this.deps.projects().filter((p) => !p.hidden && p.kind !== "folder" && (options.repoId === undefined || p.id === options.repoId));
      if (allProjects.length === 0) return 0;

      const tasksByBranch = new Map<string, Task>();
      for (const task of this.deps.tasks()) {
        if (task.branch) tasksByBranch.set(`${task.repoId}:${task.branch.toLowerCase()}`, task);
      }

      let recorded = 0;
      const queue = [...allProjects];
      const workers = Array.from({ length: Math.min(GIT_SCAN_CONCURRENCY, queue.length) }, async () => {
        while (queue.length > 0) {
          const project = queue.shift();
          if (!project) break;
          recorded += await this.scanOneProject(project, since, until, tasksByBranch);
        }
      });
      await Promise.all(workers);
      this.lastGitScanByKey.set(cacheKey, this.now());
      return recorded;
    };

    const run = this.scanChain.then(execute, execute);
    const tracked = { key: cacheKey, promise: run };
    this.inFlightScan = tracked;
    this.scanChain = run.then(onlyWaitedFor, onlyWaitedFor);
    return run.finally(() => {
      if (this.inFlightScan === tracked) this.inFlightScan = undefined;
    });
  }

  private async scanOneProject(
    project: Project,
    since: number,
    until: number,
    tasksByBranch: ReadonlyMap<string, Task>,
  ): Promise<number> {
    const [emailRes, nameRes, unpushedRes] = await Promise.all([
      runLockedGit(project.path, ["config", "user.email"]),
      runLockedGit(project.path, ["config", "user.name"]),
      runLockedGit(project.path, ["rev-list", "--branches", "--not", "--remotes", `--max-count=${MAX_COMMITS_PER_REPO}`]),
    ]);

    const userEmail = emailRes.ok ? emailRes.stdout.trim().toLowerCase() : "";
    const userName = nameRes.ok ? nameRes.stdout.trim().toLowerCase() : "";
    const ghLogin = this.deps.githubLogin?.()?.trim().toLowerCase() ?? "";
    const ownAuthors = new Set((this.deps.ownAuthors?.() ?? []).map((v) => v.trim().toLowerCase()).filter(Boolean));
    const unpushedShas = new Set(
      unpushedRes.ok
        ? unpushedRes.stdout
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    );

    // Use %at (author timestamp) and filter [since, until] on author timestamp in JS so rebased or cherry-picked
    // commits stay on the day they were authored (committer timestamp is >= author timestamp).
    const sinceSec = Math.max(0, Math.floor(since / 1000));
    const logRes = await runLockedGit(project.path, [
      "log",
      "--branches",
      "--source",
      "--no-merges",
      "--no-show-signature",
      `--since=@${sinceSec}`,
      `--max-count=${MAX_COMMITS_PER_REPO}`,
      "--format=%H%x1f%at%x1f%an%x1f%ae%x1f%S%x1f%D%x1f%s%x1f%b%x1e",
    ]);
    if (!logRes.ok || !logRes.stdout.trim()) return 0;

    let count = 0;
    const records = logRes.stdout.split("\x1e");
    for (const rawRecord of records) {
      const trimmed = rawRecord.trim();
      if (!trimmed) continue;
      const parts = trimmed.split("\x1f");
      if (parts.length < 7) continue;
      const [sha, ctStr, authorName, authorEmail, sourceRef, decorations, subject, body = ""] = parts as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string?,
      ];
      if (!/^[0-9a-f]{40,64}$/i.test(sha)) continue;
      const commitMs = Number(ctStr) * 1000;
      if (!Number.isFinite(commitMs) || commitMs < since || commitMs > until) continue;

      const branch = chooseBranch(sourceRef, decorations, project.defaultBranch);
      const isAriaBranch = branch !== undefined && /^aria\//i.test(branch);
      const aName = authorName.trim().toLowerCase();
      const aEmail = authorEmail.trim().toLowerCase();
      // Exact matches only. A name that merely contains the app's name is somebody else (a colleague called ARIA Smith).
      const isYours =
        isAriaBranch ||
        aEmail === APP_GIT_EMAIL ||
        ownAuthors.has(aName) ||
        ownAuthors.has(aEmail) ||
        (userEmail !== "" && aEmail === userEmail) ||
        (userName !== "" && aName === userName) ||
        (ghLogin !== "" && (aName === ghLogin || aEmail.startsWith(`${ghLogin}@`) || aEmail.endsWith(`+${ghLogin}@users.noreply.github.com`)));
      if (!isYours) continue;

      const owningTask = branch ? tasksByBranch.get(`${project.id}:${branch.toLowerCase()}`) : undefined;
      const tracker = this.deps.tracker();
      // A task id found in the commit or its branch is the tracker in use's; the owning ARIA task's own is its tracker's.
      const found = tracker.extractTaskRef(subject, body) ?? tracker.taskRefFromBranch(branch);
      const linkedTrackerTaskId = found ?? owningTask?.trackerTaskId;
      const linkedTrackerId = found ? tracker.id : (owningTask?.trackerId ?? tracker.id);

      this.deps.db().upsertActivity({
        source: "git",
        kind: "commit",
        startedAt: commitMs,
        endedAt: commitMs,
        repoId: project.id,
        externalId: `commit:${sha.toLowerCase()}`,
        title: cleanTitle(subject, MAX_TITLE) || sha.slice(0, 7),
        ...(linkedTrackerTaskId ? { linkedTrackerTaskId, linkedTrackerId } : {}),
        metadata: {
          sha: sha.toLowerCase(),
          shortSha: sha.slice(0, 7).toLowerCase(),
          repoName: project.name,
          ...(branch ? { branch: cleanTitle(branch, 120) } : {}),
          unpushed: unpushedShas.has(sha),
          ...(owningTask ? { taskId: owningTask.id } : {}),
        },
      });
      count++;
    }
    return count;
  }

  /**
   * Lists activities overlapping `[since, until]`, decorating each activity with its `resolvedTask` from explicit link
   * or enabled `TimeRule`s.
   */
  listActivities(filter: { since?: number; until?: number; repoId?: number; source?: Activity["source"]; limit?: number } = {}): Activity[] {
    if (!filter.source || filter.source === "aria") {
      this.deps.refreshActiveTasks?.();
    }
    const db = this.deps.db();
    const rules: TimeRule[] = db.listTimeRules(this.deps.tracker().id);
    const tracker = this.deps.tracker();
    // With no tracker, the updates an earlier one recorded aren't work to account for: they are left out.
    const rows = db.listActivities(filter).filter((activity) => !isNoTracker(tracker) || activity.source !== "tracker");
    return rows.map((stored) => {
      // A link to another tracker's task is dormant: it isn't followed, and the window gets no task ID to show of it.
      const dormant = stored.linkedTrackerTaskId !== undefined && !ownedBy(tracker, stored.linkedTrackerId);
      const { linkedTrackerTaskId: _task, linkedTrackerId: _tracker, ...rest } = stored;
      const activity: Activity = dormant ? rest : stored;
      const resolved = resolveActivityTask(tracker, activity, rules);
      const resolvedMinutes = resolveActivityDuration(activity, rules);
      return {
        ...activity,
        ...(resolved ? { resolvedTask: resolved } : {}),
        ...(resolvedMinutes !== undefined ? { resolvedMinutes } : {}),
      };
    });
  }
}
