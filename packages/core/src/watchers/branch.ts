/**
 * A branch's CI (PLAN.md §4.6). Default-branch health (`forever`, only you start it: every 5 minutes, a card only when
 * it goes red or green again, and once if it's red when the watch starts), or the next push's runs on a branch
 * (`completed`, `success`: every minute, a card when all the runs of that commit finished).
 */
import { z } from "zod";
import type { CiFailedCheck } from "@aria/protocol";
import { digestText, links, repoKey } from "../github/text.ts";
import { ownRun, runsFrom, type RunInfo } from "./run.ts";
import { passes, type PollApi, type PollContext, type PollOutcome, type WatchEvent } from "./types.ts";

export const BranchTargetSchema = z.object({ branch: z.string().min(1).max(300) });
export type BranchTarget = z.infer<typeof BranchTargetSchema>;

export const BranchStateSchema = z.object({
  /** forever: the health, and per workflow its latest finished run (cancelled and skipped ones don't count). */
  health: z.enum(["green", "red", "none"]).optional(),
  latest: z.record(z.string(), z.object({ runId: z.number(), number: z.number(), name: z.string(), conclusion: z.string() })).optional(),
  running: z.number().optional(),
  /** completed / success: the newest run there was when it started (or when the last commit's runs were told). */
  afterRunId: z.number().optional(),
  /** The commit whose runs it waits for, and what they were at. */
  sha: z.string().optional(),
  progress: z.string().optional(),
});
export type BranchState = z.infer<typeof BranchStateSchema>;

/** Conclusions that don't say anything about the branch's health. */
const NOT_HEALTH = new Set(["cancelled", "skipped", "neutral", "stale"]);

function health(runs: RunInfo[]): Pick<BranchState, "health" | "latest" | "running"> {
  const latest: NonNullable<BranchState["latest"]> = {};
  // Newest first, so the first finished run of each workflow is its latest.
  for (const run of [...runs].sort((a, b) => b.id - a.id)) {
    if (run.status !== "completed" || !run.conclusion || NOT_HEALTH.has(run.conclusion)) continue;
    const key = run.name.toLowerCase();
    if (!latest[key]) latest[key] = { runId: run.id, number: run.number, name: run.name, conclusion: run.conclusion };
  }
  const values = Object.values(latest);
  const value = values.length === 0 ? "none" : values.some((r) => !passes(r.conclusion)) ? "red" : "green";
  return { health: value, latest, running: runs.filter((r) => r.status !== "completed").length };
}

function healthEvent(ctx: PollContext, branch: string, state: BranchState): WatchEvent {
  const red = state.health === "red";
  const failing = Object.values(state.latest ?? {}).filter((r) => !passes(r.conclusion));
  const failed: CiFailedCheck[] = failing.slice(0, 10).map((r) => ({ name: `${r.name} #${r.number}`, conclusion: r.conclusion, runId: r.runId, url: links.run(ctx.owner, ctx.repo, r.runId) }));
  const summary = red ? `${failing.length} workflow${failing.length === 1 ? "" : "s"} failing` : `${branch} is green again`;
  return {
    kind: red ? "ci_failure" : "ci_success",
    card: {
      cardType: "ci",
      payload: {
        owner: ctx.owner,
        repo: ctx.repo,
        repoName: ctx.repoName,
        source: "branch",
        title: branch,
        outcome: red ? "failure" : "success",
        conclusion: red ? (failing[0]?.conclusion ?? "failure") : "success",
        summary,
        branch,
        ...(failed.length ? { failed } : {}),
        url: links.branchRuns(ctx.owner, ctx.repo, branch),
      },
    },
    toast: { title: red ? `CI · ${ctx.repoName} · ${branch} is red` : `CI · ${ctx.repoName} · ${branch} is green again`, body: red ? failing.map((r) => `${r.name} #${r.number}`).join(", ") : ctx.repoName },
    digest: red
      ? `[ci] ${ctx.repoName}: ${digestText(branch, 80)} is red: ${failing.slice(0, 5).map((r) => `${digestText(r.name, 60)} #${r.number}`).join(", ")} failing.`
      : `[ci] ${ctx.repoName}: ${digestText(branch, 80)} is green again.`,
  };
}

function commitEvent(ctx: PollContext, branch: string, runs: RunInfo[]): WatchEvent {
  const failing = runs.filter((r) => !passes(r.conclusion));
  const ok = failing.length === 0;
  const summary = ok ? `${runs.length} of ${runs.length} passed` : `${failing.length} of ${runs.length} didn't pass`;
  const failed: CiFailedCheck[] = failing.slice(0, 10).map((r) => ({ name: `${r.name} #${r.number}`, conclusion: r.conclusion ?? "unknown", runId: r.id, url: links.run(ctx.owner, ctx.repo, r.id) }));
  const sha = runs[0]?.sha;
  return {
    kind: ok ? "ci_success" : "ci_failure",
    card: {
      cardType: "ci",
      payload: {
        owner: ctx.owner,
        repo: ctx.repo,
        repoName: ctx.repoName,
        source: "branch",
        title: branch,
        outcome: ok ? "success" : "failure",
        conclusion: ok ? "success" : failing.length === runs.length ? (failing[0]?.conclusion ?? "failure") : "mixed",
        summary,
        branch,
        ...(sha ? { headSha: sha } : {}),
        ...(failed.length ? { failed } : {}),
        url: links.branchRuns(ctx.owner, ctx.repo, branch),
      },
    },
    toast: { title: `CI · ${ctx.repoName} · ${branch} ${ok ? "passed" : "failed"}`, body: summary },
    digest: `[ci] ${ctx.repoName}: the runs on ${digestText(branch, 80)} ${ok ? "passed" : "failed"} (${summary}).${failing.length ? ` Not passing: ${failing.slice(0, 5).map((r) => `${digestText(r.name, 60)} #${r.number}`).join(", ")}.` : ""}`,
  };
}

export async function pollBranch(target: BranchTarget, stateIn: BranchState, api: PollApi, ctx: PollContext): Promise<PollOutcome> {
  const { owner, repo } = ctx;
  const branch = target.branch;
  const url = links.branchRuns(owner, repo, branch);
  const answer = await api.get("runs", "GET /repos/{owner}/{repo}/actions/runs", { owner, repo, branch, per_page: 30, exclude_pull_requests: true });
  // Only the repository's own runs on that branch: a fork's PR from a branch of the same name isn't this branch.
  const runs = answer.changed ? runsFrom(answer.data).filter((r) => ownRun(r, owner, repo) && r.branch === branch) : undefined;
  const events: WatchEvent[] = [];
  let state: BranchState = { ...stateIn };
  let end: PollOutcome["end"];

  if (ctx.until === "forever") {
    if (runs) {
      const next = health(runs);
      // Told only when it turns red or green again (and once when it's red at the start), not for every run.
      const turned = ctx.baselined ? next.health !== state.health && next.health !== "none" && state.health !== undefined && (next.health === "red" || state.health === "red") : next.health === "red";
      state = { ...state, ...next };
      if (turned) events.push(healthEvent(ctx, branch, state));
    }
    const running = state.running ? ` · ${state.running} running` : "";
    const status = state.health === "red" ? `red${running}` : state.health === "green" ? `green${running}` : state.health === "none" ? `no finished CI runs yet${running}` : "not checked yet";
    return { state, title: branch, status, tone: state.health === "red" ? "bad" : state.health === "green" ? "ok" : "waiting", events, nextInMs: 10 * 60_000, url };
  }

  // completed / success: the runs of the next commit pushed to the branch.
  if (runs) {
    if (!ctx.baselined) {
      state = { afterRunId: runs.reduce((max, r) => Math.max(max, r.id), 0) };
    } else {
      const after = state.afterRunId ?? 0;
      const fresh = runs.filter((r) => r.id > after);
      const newest = [...fresh].sort((a, b) => b.id - a.id)[0];
      if (!newest) {
        state = { ...state, sha: undefined, progress: undefined };
      } else {
        const commit = fresh.filter((r) => r.sha !== undefined && r.sha === newest.sha);
        const group = commit.length ? commit : [newest];
        if (group.every((r) => r.status === "completed")) {
          const ok = group.every((r) => passes(r.conclusion));
          events.push(commitEvent(ctx, branch, group));
          if (ctx.until === "completed" || ok) end = ok && ctx.until === "success" ? "success" : "completed";
          state = { afterRunId: Math.max(...runs.map((r) => r.id)), progress: undefined };
        } else {
          state = { ...state, ...(newest.sha ? { sha: newest.sha } : {}), progress: `${group.filter((r) => r.status === "completed").length} of ${group.length} runs done` };
        }
      }
    }
  }
  const status = state.progress ? `running: ${state.progress}` : "waiting for the next run";
  return { state, title: branch, status, tone: state.progress ? "running" : "waiting", events, ...(end ? { end } : {}), nextInMs: 120_000, url };
}

/** Default-branch health (forever) and a branch until its next runs finish are two watches of their own. */
export const branchKey = (owner: string, repo: string, branch: string, until: string) => `${until === "forever" ? "branch" : "branch-next"}:${repoKey(owner, repo)}:${branch}`;
