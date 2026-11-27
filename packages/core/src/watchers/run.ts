/**
 * A workflow run (PLAN.md §4.6): `GET …/actions/runs/{id}` every 15 s while it runs, then one card when it finishes,
 * with the jobs that didn't pass (`…/runs/{id}/jobs`, which give each job's real id). A watch for "the next run" first
 * looks for a run newer than the one there was, then follows that one.
 */
import { z } from "zod";
import type { CiFailedCheck } from "@aria/protocol";
import { digestText, durationText, fullName, githubPage, githubText, id, links, repoKey, time } from "../github/text.ts";
import { ago, conclusionWords, passes, type PollApi, type PollContext, type PollOutcome, type WatchEvent } from "./types.ts";

export const RunTargetSchema = z.object({
  runId: z.number().int().positive().optional(),
  /** For the next run: a workflow file name or id, a branch, and the newest run id there was. */
  workflowId: z.union([z.string().max(200), z.number().int().positive()]).optional(),
  branch: z.string().max(300).optional(),
  afterRunId: z.number().int().nonnegative().optional(),
});
export type RunTarget = z.infer<typeof RunTargetSchema>;

const RunInfoSchema = z.object({
  id: z.number(),
  number: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().optional(),
  branch: z.string().optional(),
  sha: z.string().optional(),
  headRepo: z.string().optional(),
  attempt: z.number().optional(),
  startedAt: z.number().optional(),
  updatedAt: z.number().optional(),
  url: z.string().optional(),
});
export type RunInfo = z.infer<typeof RunInfoSchema>;

export const RunStateSchema = z.object({ run: RunInfoSchema.optional(), reported: z.boolean().optional() });
export type RunState = z.infer<typeof RunStateSchema>;

/** A run from GitHub's JSON, its words cleaned; undefined when it isn't one. */
export function runFrom(value: unknown): RunInfo | undefined {
  const r = value as Record<string, unknown> | null;
  const runId = id(r?.id);
  const number = id(r?.run_number);
  if (!r || !runId || !number || typeof r.status !== "string") return undefined;
  const headRepo = fullName((r.head_repository as { full_name?: unknown } | null | undefined)?.full_name);
  const started = time(r.run_started_at) ?? time(r.created_at);
  const updated = time(r.updated_at);
  const attempt = id(r.run_attempt);
  const url = githubPage(r.html_url);
  return {
    id: runId,
    number,
    name: githubText(r.name ?? r.display_title ?? "workflow", 100) || "workflow",
    status: githubText(r.status, 40),
    ...(typeof r.conclusion === "string" ? { conclusion: githubText(r.conclusion, 40) } : {}),
    ...(typeof r.head_branch === "string" ? { branch: githubText(r.head_branch, 250) } : {}),
    ...(typeof r.head_sha === "string" && /^[0-9a-f]{40,64}$/.test(r.head_sha) ? { sha: r.head_sha } : {}),
    ...(headRepo ? { headRepo: repoKey(headRepo.owner, headRepo.repo) } : {}),
    ...(attempt ? { attempt } : {}),
    ...(started ? { startedAt: started } : {}),
    ...(updated ? { updatedAt: updated } : {}),
    ...(url ? { url } : {}),
  };
}

/** The runs of a list answer (`workflow_runs`). */
export function runsFrom(value: unknown): RunInfo[] {
  const list = (value as { workflow_runs?: unknown } | null)?.workflow_runs;
  return Array.isArray(list) ? list.map(runFrom).filter((r): r is RunInfo => r !== undefined) : [];
}

/** The jobs of a run that didn't pass, with their real ids (the first 10). */
export function failedJobs(value: unknown, owner: string, repo: string, runId: number): CiFailedCheck[] {
  const jobs = (value as { jobs?: unknown } | null)?.jobs;
  if (!Array.isArray(jobs)) return [];
  const out: CiFailedCheck[] = [];
  for (const job of jobs as Array<Record<string, unknown>>) {
    const jobId = id(job?.id);
    const conclusion = typeof job?.conclusion === "string" ? job.conclusion : undefined;
    if (!jobId || !conclusion || passes(conclusion)) continue;
    out.push({ name: githubText(job.name, 120) || `job ${jobId}`, conclusion: githubText(conclusion, 40), jobId, runId, url: links.job(owner, repo, runId, jobId) });
    if (out.length >= 10) break;
  }
  return out;
}

const RUNNING_WORDS: Record<string, string> = { queued: "queued", requested: "about to start", pending: "about to start", waiting: "waiting (for an approval, maybe)" };

/** A run's own: in the repository itself, not a fork's branch of the same name. */
export const ownRun = (run: RunInfo, owner: string, repo: string) => run.headRepo === undefined || run.headRepo === repoKey(owner, repo);

export function runEvent(run: RunInfo, ctx: Pick<PollContext, "owner" | "repo" | "repoName">, failed: CiFailedCheck[]): WatchEvent {
  const ok = passes(run.conclusion);
  const duration = run.startedAt !== undefined && run.updatedAt !== undefined ? run.updatedAt - run.startedAt : undefined;
  const title = `${run.name} #${run.number}`;
  const words = conclusionWords(run.conclusion);
  const notPassing = failed.length ? ` Not passing: ${failed.map((f) => digestText(f.name, 60)).join(", ")}.` : "";
  return {
    kind: ok ? "ci_success" : "ci_failure",
    card: {
      cardType: "ci",
      payload: {
        owner: ctx.owner,
        repo: ctx.repo,
        repoName: ctx.repoName,
        source: "run",
        title,
        outcome: ok ? "success" : "failure",
        conclusion: run.conclusion ?? "unknown",
        summary: failed.length ? `${failed.length} job${failed.length === 1 ? "" : "s"} didn't pass` : `It ${words}.`,
        ...(run.branch ? { branch: run.branch } : {}),
        ...(run.sha ? { headSha: run.sha } : {}),
        runId: run.id,
        runNumber: run.number,
        ...(duration !== undefined && duration >= 0 ? { durationMs: duration } : {}),
        ...(failed.length ? { failed } : {}),
        url: links.run(ctx.owner, ctx.repo, run.id),
      },
    },
    toast: { title: `CI · ${ctx.repoName} · ${title} ${words}`, body: [duration !== undefined && duration >= 0 ? durationText(duration) : "", failed.map((f) => f.name).join(", ")].filter(Boolean).join(" · ") || ctx.repoName },
    digest: `[ci] ${ctx.repoName}: ${digestText(run.name, 80)} #${run.number}${run.branch ? ` on ${digestText(run.branch, 80)}` : ""} ${words}${duration !== undefined && duration >= 0 ? ` in ${durationText(duration)}` : ""}.${notPassing}`,
  };
}

function running(run: RunInfo, now: number): { status: string; nextInMs: number } {
  const since = run.startedAt !== undefined ? now - run.startedAt : 0;
  const words = run.status === "in_progress" ? `in progress for ${ago(since)}` : (RUNNING_WORDS[run.status] ?? run.status);
  // Long runs and runs waiting for an approval are looked at less often.
  const nextInMs = run.status === "waiting" || since > 2 * 3_600_000 ? 60_000 : 30_000;
  return { status: words, nextInMs };
}

export async function pollRun(targetIn: RunTarget, stateIn: RunState, api: PollApi, ctx: PollContext): Promise<PollOutcome> {
  let target = targetIn;
  let state = stateIn;
  let rekey: string | undefined;
  const { owner, repo } = ctx;
  if (target.runId === undefined) {
    // Waiting for the next run: one newer than the newest there was, of the workflow and branch asked for.
    const params = { owner, repo, per_page: 20, ...(target.branch ? { branch: target.branch } : {}) };
    const list =
      target.workflowId !== undefined
        ? await api.get("runs", "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs", { ...params, workflow_id: target.workflowId })
        : await api.get("runs", "GET /repos/{owner}/{repo}/actions/runs", params);
    const after = target.afterRunId ?? 0;
    const found = list.changed ? runsFrom(list.data).filter((r) => ownRun(r, owner, repo) && (!target.branch || r.branch === target.branch) && r.id > after).sort((a, b) => a.id - b.id)[0] : undefined;
    if (!found) return { target, state, status: "waiting for the next run to start", tone: "waiting", events: [], nextInMs: 60_000, url: target.branch ? links.branchRuns(owner, repo, target.branch) : links.repo(owner, repo) };
    target = { runId: found.id };
    state = { run: found };
    rekey = runKey(owner, repo, found.id);
  } else {
    const answer = await api.get("run", "GET /repos/{owner}/{repo}/actions/runs/{run_id}", { owner, repo, run_id: target.runId });
    if (answer.changed) {
      const run = runFrom(answer.data);
      if (run) state = { ...state, run };
    }
  }
  const run = state.run;
  const url = links.run(owner, repo, target.runId!);
  if (!run) return { target, state, status: "waiting for GitHub's answer", tone: "waiting", events: [], nextInMs: 30_000, url, ...(rekey ? { rekey } : {}) };
  const title = `${run.name} #${run.number}`;
  if (run.status === "completed") {
    const words = conclusionWords(run.conclusion);
    const finished = `finished: it ${words}${run.updatedAt !== undefined ? ` ${ago(ctx.now - run.updatedAt)} ago` : ""}`;
    // Asked about once it had finished: there's nothing to watch (the tool says how it went).
    if (!ctx.baselined) return { target, state, title, status: finished, tone: passes(run.conclusion) ? "ok" : "bad", events: [], end: "completed", nextInMs: 0, url, ...(rekey ? { rekey } : {}) };
    if (state.reported) return { target, state, title, status: finished, tone: passes(run.conclusion) ? "ok" : "bad", events: [], end: "completed", nextInMs: 0, url };
    let failed: CiFailedCheck[] = [];
    if (!passes(run.conclusion)) {
      const jobs = await api.get("jobs", "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", { owner, repo, run_id: run.id, filter: "latest", per_page: 100 });
      if (jobs.changed) failed = failedJobs(jobs.data, owner, repo, run.id);
    }
    return { target, state: { ...state, reported: true }, title, status: `it ${words}`, tone: passes(run.conclusion) ? "ok" : "bad", events: [runEvent(run, ctx, failed)], end: "completed", nextInMs: 0, url, ...(rekey ? { rekey } : {}) };
  }
  const { status, nextInMs } = running(run, ctx.now);
  return { target, state, title, status, tone: "running", events: [], nextInMs, url, ...(rekey ? { rekey } : {}) };
}

export const runKey = (owner: string, repo: string, runId: number) => `run:${repoKey(owner, repo)}:${runId}`;
export const nextRunKey = (owner: string, repo: string, workflow: string | number | undefined, branch: string | undefined) =>
  `run-next:${repoKey(owner, repo)}:${workflow === undefined ? "*" : String(workflow).toLowerCase()}:${branch ?? "*"}`;
