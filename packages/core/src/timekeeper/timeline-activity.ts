import type { Task, TimelineItem, Watch } from "@aria/protocol";
import { repoKey } from "../github/text.ts";
import { isNoTracker } from "../trackers/none.ts";
import type { TaskTracker } from "../trackers/types.ts";
import type { ActivityCollector } from "./collectors.ts";

export interface TimelineActivityDeps {
  collector: () => ActivityCollector | undefined;
  tracker: () => TaskTracker;
  task: (taskId: string) => Task | undefined;
  watch: (watchId: number) => Watch | undefined;
  projects: () => Map<string, { repoId: number; repoName: string }>;
}

/** Phase 5B: records plain-code GitHub activities when PRs are opened/updated or watches report CI/PR events. */
export function recordTimelineActivity(item: TimelineItem, deps: TimelineActivityDeps): void {
  const collector = deps.collector();
  if (!collector || item.kind !== "card") return;
  if (item.cardType === "pr_confirm" && item.payload.status === "done" && item.payload.result) {
    const p = item.payload;
    const res = p.result!;
    const task = deps.task(p.taskId);
    collector.recordGitHubActivity({
      kind: res.updated ? "pr_updated" : "pr_opened",
      externalId: `pr:${p.openOn.owner}/${p.openOn.repo}#${res.number}:${res.updated ? p.tip.slice(0, 7) : "open"}`,
      at: item.updatedAt ?? item.createdAt,
      ...(task ? { repoId: task.repoId } : {}),
      repoName: p.repoName,
      owner: p.openOn.owner,
      repo: p.openOn.repo,
      title: `PR #${res.number}: ${p.title}`,
      branch: p.remoteBranch,
      prNumber: res.number,
      url: res.url,
      taskId: p.taskId,
      extraTextForLink: p.body,
    });
    return;
  }
  if (item.cardType === "ci") {
    const p = item.payload;
    const watch = deps.watch(p.watchId);
    const repoId = watch?.repoId ?? deps.projects().get(repoKey(p.owner, p.repo))?.repoId;
    collector.recordGitHubActivity({
      kind: "ci_run",
      externalId: `ci:${p.owner}/${p.repo}:${p.runId ?? p.prNumber ?? p.watchId}:${p.headSha?.slice(0, 7) ?? item.id}`,
      at: item.createdAt,
      ...(p.durationMs !== undefined ? { durationMs: p.durationMs } : {}),
      ...(repoId !== undefined ? { repoId } : {}),
      repoName: p.repoName,
      owner: p.owner,
      repo: p.repo,
      title: `CI · ${p.title} (${p.conclusion})`,
      ...(p.branch ? { branch: p.branch } : {}),
      ...(p.prNumber !== undefined ? { prNumber: p.prNumber } : {}),
      ...(p.runId !== undefined ? { runId: p.runId } : {}),
      url: p.url,
      ...(watch?.taskId ? { taskId: watch.taskId } : {}),
    });
    return;
  }
  if (item.cardType === "pr") {
    const p = item.payload;
    const watch = deps.watch(p.watchId);
    const repoId = watch?.repoId ?? deps.projects().get(repoKey(p.owner, p.repo))?.repoId;
    const kind = p.event === "merged" ? "pr_merged" : p.event === "closed" ? "pr_closed" : "pr_review";
    collector.recordGitHubActivity({
      kind,
      externalId: `pr_event:${p.owner}/${p.repo}#${p.number}:${p.event}:${p.reviewId ?? item.id}`,
      at: item.createdAt,
      ...(repoId !== undefined ? { repoId } : {}),
      repoName: p.repoName,
      owner: p.owner,
      repo: p.repo,
      title: `PR #${p.number} (${p.event.replace(/_/g, " ")}): ${p.title}`,
      prNumber: p.number,
      url: p.url,
      ...(watch?.taskId ? { taskId: watch.taskId } : {}),
      ...(p.body ? { extraTextForLink: p.body } : {}),
    });
    return;
  }
  // With no tracker a task update isn't recorded as work (no tracker lines).
  if (item.cardType === "tracker_update" && !isNoTracker(deps.tracker())) {
    const p = item.payload;
    collector.recordTrackerActivity({
      taskId: p.taskId,
      title: p.title,
      event: p.event,
      at: item.createdAt,
      externalKey: `${deps.tracker().id}:${p.taskId}:${p.event}:${item.id}`,
      ...(p.status ? { status: p.status } : {}),
      ...(p.previousStatus ? { previousStatus: p.previousStatus } : {}),
      ...(p.priority ? { priority: p.priority } : {}),
      ...(p.previousPriority ? { previousPriority: p.previousPriority } : {}),
      ...(p.comment ? { comment: p.comment } : {}),
      ...(p.commentBy ? { commentBy: p.commentBy } : {}),
      ...(p.projectName ? { projectName: p.projectName } : {}),
      ...(p.customerName ? { customerName: p.customerName } : {}),
      url: p.url,
    });
  }
}
