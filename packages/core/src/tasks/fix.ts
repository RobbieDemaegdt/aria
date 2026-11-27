/**
 * Fix it and Address comments (PLAN.md §4.6, §5.4, item 4, D45–D53). A red CI card's Fix it, and a review card's
 * Address comments, give the work to the task that owns the branch (it continues; or, when it can't, a new task adopts
 * its branch), or for a red default branch to a new task from the commit CI ran on. What GitHub says about the failure
 * (job logs, check output) or the review (its text and inline comments) is someone else's text: it goes to the worker
 * only, fenced (tasks/untrusted.ts), never into the brief ARIA sees, the digest, or "your words". Nothing is pushed:
 * the new commits go out through item 3's card (Push new commits). ARIA can only propose either (a card, D48).
 */
import { randomUUID } from "node:crypto";
import type { CardItem, CiCardPayload, FixPlan, FixProposalPayload, FixRecord, PrCardPayload, Profile, Project, Task, Watch } from "@aria/protocol";
import { execa } from "execa";
import type { GitHubAccess } from "../github/access.ts";
import { GitHubFailure } from "../github/client.ts";
import { fetchJobLog } from "../github/logs.ts";
import { digestText, githubText, id as asId, validName } from "../github/text.ts";
import type { StartTaskOptions } from "./manager.ts";
import { fetchCommit, PushRefused, pushTarget } from "./push.ts";
import { ciFixMessage, cleanBlock, cleanLine, fence, jobLogText, MAX_LOG_TEXT, MAX_REVIEW_TEXT, newNonce, reviewMessage, type UntrustedPart } from "./untrusted.ts";

type CiCard = Extract<CardItem, { cardType: "ci" }>;
type PrCard = Extract<CardItem, { cardType: "pr" }>;
type ProposalCard = Extract<CardItem, { cardType: "fix_proposal" }>;

export interface FixDeps {
  access: GitHubAccess | undefined;
  card(cardId: string): CardItem | undefined;
  cards(): CardItem[];
  saveCard(card: CardItem): void;
  watch(watchId: number): Watch | undefined;
  projects(): Project[];
  tasks: {
    get(taskId: string): Task | undefined;
    all(): Task[];
    ownerOf(repoId: number, branch: string): Task | undefined;
    message(taskId: string, text: string, steer: boolean, untrusted?: string): Promise<unknown>;
    start(options: StartTaskOptions): Promise<Task>;
    markFixing(taskId: string, fixing: { kind: "ci" | "review"; cardId: string; label: string }, fromText: "ci_log" | "review"): void;
  };
  /** The CI fix profile (D47): yours for it, else Default. */
  ciFixProfile(): Profile | undefined;
  profile(id: string | undefined): Profile | undefined;
  digest(key: string, line: string): void;
  /** D53's fetch: as item 3's push (a test run's bare repositories, or none at all). */
  testPush?: { root: string; config: string };
  noPush?: string;
  ghPath(): string | undefined;
  scratchRoot: string;
  log(line: string): void;
}

const SHA = /^[0-9a-f]{40,64}$/;
const MAX_JOBS = 3;
const MAX_COMMENTS = 50;
const ONE_CLICK = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const FAILING = new Set(["failure", "timed_out", "cancelled", "startup_failure", "action_required"]);

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const result = await execa("git", ["-c", "core.fsmonitor=false", "--no-replace-objects", "-C", cwd, ...args], { reject: false, windowsHide: true, timeout: 60_000 });
  return { ok: result.exitCode === 0, out: String(result.stdout ?? "").trim() };
}

/** A comment's path, shown as text: relative, forward slashes, no way up, no drive, nothing invisible. */
export function safePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 400) return undefined;
  if (/[\\\u0000-\u001f\u007f]/.test(value) || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.split("/").some((p) => p === ".." || p === "")) return undefined;
  return cleanLine(value, 300);
}

/** Where a fix goes and with what, worked out from ARIA's records and GitHub's answers (never the window's). */
interface Target {
  how: FixPlan["how"];
  project: Project;
  /** The task that continues, or whose branch is adopted. */
  task?: Task;
  branch: string;
  sha: string;
  /** Default branch: the commit to start from (D53: fetched first if it isn't local). */
  fetch?: boolean;
  notes: string[];
  /** For a PR. */
  pr?: { owner: string; repo: string; number: number };
  needsTick?: string;
  label: string;
  digestWhat: string;
}

export class CiFixes {
  private readonly controller = new AbortController();
  private readonly running = new Set<string>();

  constructor(private readonly deps: FixDeps) {}

  private get access(): GitHubAccess {
    if (!this.deps.access) throw new Error("GitHub isn't set up in this run of ARIA.");
    return this.deps.access;
  }

  private async read(route: Parameters<GitHubAccess["get"]>[0], params: Record<string, string | number>): Promise<unknown> {
    try {
      const result = await this.access.get(route, params, {}, this.controller.signal);
      return result.status === 200 ? result.data : undefined;
    } catch (error) {
      if (error instanceof GitHubFailure && error.type === "not_found") return undefined;
      throw error;
    }
  }

  stop(): void {
    this.controller.abort();
  }

  // ── where it goes ─────────────────────────────────────────────────────────────────────────────────────────────

  private projectOf(owner: string, repo: string): { project: Project; origin: boolean } | undefined {
    const key = `${owner}/${repo}`.toLowerCase();
    const projects = this.deps.projects().filter((p) => !p.hidden && p.host === "github.com");
    const origin = projects.find((p) => `${p.owner}/${p.repo}`.toLowerCase() === key);
    if (origin) return { project: origin, origin: true };
    const fork = projects.find((p) => p.upstream?.toLowerCase() === key);
    return fork ? { project: fork, origin: false } : undefined;
  }

  /** The task a PR belongs to: its own record (`task.pr`), its watch's task, or the task on its head branch. */
  private prTask(owner: string, repo: string, number: number, watch: Watch | undefined, project: Project, branch: string | undefined): Task | undefined {
    const byPr = this.deps.tasks
      .all()
      .filter((t) => t.pr && t.pr.owner.toLowerCase() === owner.toLowerCase() && t.pr.repo.toLowerCase() === repo.toLowerCase() && t.pr.number === number && !t.adoptedBy)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (byPr) return byPr;
    const byWatch = watch?.taskId ? this.deps.tasks.get(watch.taskId) : undefined;
    if (byWatch && !byWatch.adoptedBy) return byWatch;
    return branch?.startsWith("aria/") ? this.deps.tasks.ownerOf(project.id, branch) : undefined;
  }

  /** D46: continue the owner when it can; else adopt its branch (its worktree is gone, or it's held at its budget). */
  private howFor(task: Task): { how: "continue" | "adopt" } {
    if (task.cleanedUp || task.state === "waiting_budget") return { how: "adopt" };
    return { how: "continue" };
  }

  /** A PR's checks (and its task's branch) as GitHub has them now: open, at the card's head, in the local branch. */
  private async checkPr(owner: string, repo: string, number: number, cardSha: string | undefined, task: Task, notes: string[]): Promise<void> {
    const pull = (await this.read("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: number })) as { state?: unknown; merged?: unknown; head?: { sha?: unknown } } | undefined;
    if (!pull) throw new Error(`GitHub doesn't have PR #${number} (or this account can't see it).`);
    if (pull.state !== "open") throw new Error(`PR #${number} is ${pull.merged === true ? "merged" : "closed"}: there's nothing to fix on it.`);
    const head = typeof pull.head?.sha === "string" && SHA.test(pull.head.sha) ? pull.head.sha : "";
    if (cardSha && head && head !== cardSha) throw new Error(`PR #${number} has newer commits than this card (${head.slice(0, 7)}): its checks will tell. Fix it works on the newest red card.`);
    const tip = (await git(task.repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${task.branch}^{commit}`])).out;
    if (!SHA.test(tip)) throw new Error("The task's branch isn't in the project anymore.");
    if (head && tip !== head) {
      if (!(await git(task.repoPath, ["merge-base", "--is-ancestor", head, tip])).ok) {
        throw new Error(`PR #${number} has commits on GitHub that the task's branch doesn't have (compared with the local branch only): pull them in the task's worktree first.`);
      }
      const ahead = Number((await git(task.repoPath, ["rev-list", "--count", `${head}..${tip}`])).out) || 0;
      notes.push(`${ahead} local commit${ahead === 1 ? " isn't" : "s aren't"} on GitHub yet: the task may already have the fix (compared with the local branch only).`);
    }
  }

  /** Fix it's target for a red CI card (D45, D46, D53), or why it has none. */
  async ciTarget(card: CiCard): Promise<Target> {
    const p = card.payload;
    if (p.outcome !== "failure") throw new Error("This CI card isn't red: there's nothing to fix.");
    const found = this.projectOf(p.owner, p.repo);
    if (!found) throw new Error(`${p.owner}/${p.repo} isn't one of your projects.`);
    const { project } = found;
    const watch = this.deps.watch(p.watchId);
    const notes: string[] = [];
    // A PR's checks: its task's branch.
    if (p.source === "checks" && p.prNumber) {
      const task = this.prTask(p.owner, p.repo, p.prNumber, watch, project, p.branch);
      if (!task || !task.branch?.startsWith("aria/")) throw new Error("Fix it works on ARIA's own PRs and your default branch (D45): this PR isn't one of ARIA's tasks'.");
      await this.checkPr(p.owner, p.repo, p.prNumber, p.headSha, task, notes);
      const { how } = this.howFor(task);
      return { how, project, task, branch: task.branch, sha: p.headSha ?? "", notes, pr: { owner: p.owner, repo: p.repo, number: p.prNumber }, label: `CI · checks on PR #${p.prNumber}`, digestWhat: `the failing checks on PR #${p.prNumber}` };
    }
    const branch = p.branch ?? "";
    // A run on a task's branch: that task (its PR's head, if it has one, must be in it).
    if (branch.startsWith("aria/") && found.origin) {
      const task = this.deps.tasks.ownerOf(project.id, branch);
      if (!task) throw new Error(`No task of ARIA's has the branch ${branch} anymore (it was discarded).`);
      if (task.pr) await this.checkPr(task.pr.owner, task.pr.repo, task.pr.number, p.headSha, task, notes);
      const { how } = this.howFor(task);
      return { how, project, task, branch, sha: p.headSha ?? "", notes, ...(task.pr ? { pr: { owner: task.pr.owner, repo: task.pr.repo, number: task.pr.number } } : {}), label: `CI · ${githubText(p.title, 80)}`, digestWhat: `the failing run on ${branch}` };
    }
    // The default branch: a new task from the commit CI ran on (D45, D53).
    const defaultBranch = project.defaultBranch;
    if (!found.origin || !defaultBranch || branch !== defaultBranch) throw new Error("Fix it works on ARIA's own PRs and your default branch (D45): not on this branch.");
    let sha = p.headSha;
    if (!sha && p.failed?.[0]?.runId) {
      const run = (await this.read("GET /repos/{owner}/{repo}/actions/runs/{run_id}", { owner: p.owner, repo: p.repo, run_id: p.failed[0].runId })) as { head_sha?: unknown; head_branch?: unknown } | undefined;
      if (run?.head_branch !== defaultBranch) throw new Error("GitHub doesn't say that run was on the default branch.");
      sha = typeof run.head_sha === "string" ? run.head_sha : undefined;
    }
    if (!sha || !SHA.test(sha)) throw new Error("GitHub didn't say which commit CI ran on.");
    // D53: has the branch moved on since?
    const now = (await this.read("GET /repos/{owner}/{repo}/branches/{branch}", { owner: p.owner, repo: p.repo, branch: defaultBranch })) as { commit?: { sha?: unknown } } | undefined;
    const current = typeof now?.commit?.sha === "string" ? now.commit.sha : undefined;
    if (current && current !== sha) notes.push(`${defaultBranch} has moved on since (it's at ${current.slice(0, 7)} on GitHub now): the fix starts from ${sha.slice(0, 7)}, the commit CI ran on. Check whether it's still red there.`);
    const local = (await git(project.path, ["cat-file", "-e", `${sha}^{commit}`])).ok;
    if (!local) notes.push(`ARIA fetched ${sha.slice(0, 7)} from GitHub first (it wasn't on this PC).`);
    return { how: "start", project, branch: defaultBranch, sha, fetch: !local, notes, label: `CI · ${githubText(p.title, 80)}`, digestWhat: `${digestText(defaultBranch, 60)} being red` };
  }

  /** Address comments' target for a review card (D50, D51), or why it has none. */
  async reviewTarget(card: PrCard): Promise<Target & { review: { id: number; by: string; association: string; body: string; commit?: string } }> {
    const p = card.payload;
    if ((p.event !== "changes_requested" && p.event !== "commented") || !p.reviewId) throw new Error("Address comments is for a review that asks for changes or comments.");
    const found = this.projectOf(p.owner, p.repo);
    if (!found) throw new Error(`${p.owner}/${p.repo} isn't one of your projects.`);
    const watch = this.deps.watch(p.watchId);
    const task = this.prTask(p.owner, p.repo, p.number, watch, found.project, undefined);
    if (!task || !task.branch?.startsWith("aria/")) throw new Error("Address comments works on ARIA's own PRs: this PR isn't one of ARIA's tasks'.");
    const review = (await this.read("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}", { owner: p.owner, repo: p.repo, pull_number: p.number, review_id: p.reviewId })) as
      | { id?: unknown; state?: unknown; body?: unknown; commit_id?: unknown; author_association?: unknown; user?: { login?: unknown; type?: unknown } }
      | undefined;
    if (!review || asId(review.id) !== p.reviewId) throw new Error("GitHub doesn't have that review anymore.");
    if (review.state === "DISMISSED") throw new Error("That review was dismissed: there's nothing to address.");
    const notes: string[] = [];
    await this.checkPr(p.owner, p.repo, p.number, undefined, task, notes);
    const by = githubText(typeof review.user?.login === "string" ? review.user.login : "someone", 60);
    const association = typeof review.author_association === "string" ? review.author_association.toUpperCase() : "NONE";
    const bot = review.user?.type !== "User";
    // D51: the repository's own people work with one click; anyone else (or a bot) is said, with an extra tick.
    const needsTick = bot ? `@${by} is a bot, not a person with write access to the repository.` : !ONE_CLICK.has(association) ? `@${by} has no write access to the repository (${association.toLowerCase().replace(/_/g, " ")}).` : undefined;
    const commit = typeof review.commit_id === "string" && SHA.test(review.commit_id) ? review.commit_id : undefined;
    const tip = (await git(task.repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${task.branch}^{commit}`])).out;
    if (commit && commit !== tip) notes.push(`The review was on ${commit.slice(0, 7)}: the code may have changed since.`);
    notes.push("Only this review's text and its inline comments go to the task: the PR's conversation comments don't.");
    const { how } = this.howFor(task);
    return {
      how,
      project: found.project,
      task,
      branch: task.branch,
      sha: tip,
      notes,
      pr: { owner: p.owner, repo: p.repo, number: p.number },
      ...(needsTick ? { needsTick } : {}),
      label: `Review · @${by} on PR #${p.number}`,
      digestWhat: `a review of PR #${p.number}`,
      review: { id: p.reviewId, by, association: bot ? "a bot" : association.toLowerCase().replace(/_/g, " "), body: typeof review.body === "string" ? review.body : "", ...(commit ? { commit } : {}) },
    };
  }

  private plan(target: Target): FixPlan {
    const profile = target.how === "continue" ? this.deps.profile(target.task?.profileId) : this.deps.ciFixProfile();
    const model = target.how === "continue" ? target.task!.model : (profile?.model ?? "?");
    const effort = target.how === "continue" ? target.task!.reasoningEffort : profile?.reasoningEffort;
    const budget = target.how === "continue" ? target.task!.budgetCredits : profile?.budgetCredits;
    return {
      how: target.how,
      ...(target.task ? { taskId: target.task.id, taskTitle: target.task.title } : {}),
      profile: target.how === "continue" ? target.task!.profileName : (profile?.name ?? "Default"),
      model,
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(budget !== undefined ? { budgetCredits: budget } : {}),
      sha: target.sha,
      branch: target.branch,
      notes: target.notes,
      ...(target.needsTick ? { needsTick: target.needsTick } : {}),
    };
  }

  // ── what goes to the worker ───────────────────────────────────────────────────────────────────────────────────

  /** The failed jobs' logs (at most 3), and the other checks' output: the untrusted parts, and whether any log came. */
  private async ciParts(card: CiCard, sha: string): Promise<{ parts: UntrustedPart[]; logs: "ok" | "partial" | "none"; notes: string[]; run?: number }> {
    const p = card.payload;
    const parts: UntrustedPart[] = [];
    const notes: string[] = [];
    let withLog = 0;
    let tried = 0;
    const jobs: Array<{ id: number; checkRun?: number }> = [];
    const others: number[] = [];
    for (const f of p.failed ?? []) {
      if (f.jobId) jobs.push({ id: f.jobId });
      else if (f.checkRunId && f.app === "github-actions") jobs.push({ id: f.checkRunId, checkRun: f.checkRunId });
      else if (f.checkRunId) others.push(f.checkRunId);
      else if (f.runId && p.source !== "checks") {
        // A run (the branch's health): its failed jobs.
        const list = (await this.read("GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", { owner: p.owner, repo: p.repo, run_id: f.runId, per_page: 30 })) as { jobs?: Array<{ id?: unknown; conclusion?: unknown; head_sha?: unknown }> } | undefined;
        for (const job of list?.jobs ?? []) {
          const id = asId(job.id);
          // Its commit is checked with the job's own read below.
          if (id && typeof job.conclusion === "string" && FAILING.has(job.conclusion) && (job.head_sha === undefined || job.head_sha === sha)) jobs.push({ id });
        }
      }
    }
    for (const job of jobs.slice(0, MAX_JOBS)) {
      tried++;
      const info = (await this.read("GET /repos/{owner}/{repo}/actions/jobs/{job_id}", { owner: p.owner, repo: p.repo, job_id: job.id })) as
        | { id?: unknown; head_sha?: unknown; name?: unknown; conclusion?: unknown; check_run_url?: unknown; steps?: Array<{ name?: unknown; conclusion?: unknown }> }
        | undefined;
      // The job must be the card's: its commit, and (for a PR's check) the check run it says it is.
      if (!info || asId(info.id) !== job.id || (sha && info.head_sha !== sha) || (job.checkRun !== undefined && !(typeof info.check_run_url === "string" && info.check_run_url.endsWith(`/check-runs/${job.checkRun}`)))) {
        notes.push(`A failed check (${job.id}) isn't an Actions job of this commit: left out.`);
        continue;
      }
      const name = cleanLine(typeof info.name === "string" ? info.name : `job ${job.id}`, 120);
      const failedSteps = (info.steps ?? []).filter((s) => typeof s.conclusion === "string" && FAILING.has(s.conclusion)).map((s) => cleanLine(String(s.name ?? "?"), 120));
      const label = `job "${name}" (id ${job.id})${failedSteps.length ? ` · failed step${failedSteps.length === 1 ? "" : "s"}: ${failedSteps.map((s) => `"${s}"`).join(", ")}` : ""}`;
      const log = await fetchJobLog({ access: this.access, owner: p.owner, repo: p.repo, jobId: job.id, signal: this.controller.signal });
      if (log.status === "ok") {
        withLog++;
        parts.push({ kind: "log", label, text: jobLogText(log.cut, { truncated: log.truncated }) });
      } else {
        // The job's name stays inside the fence (a workflow file wrote it): the note outside says the id only.
        parts.push({ kind: "log", label, text: `(NO LOG: ${log.reason})` });
        notes.push(`No log for job ${job.id}: ${log.reason}${log.host ? ` (the address was on ${digestText(log.host, 80)})` : ""}`);
      }
    }
    if (jobs.length > MAX_JOBS) notes.push(`${jobs.length - MAX_JOBS} more failed job${jobs.length - MAX_JOBS === 1 ? "" : "s"}: open the run on GitHub.`);
    for (const checkRun of others.slice(0, MAX_JOBS)) {
      const info = (await this.read("GET /repos/{owner}/{repo}/check-runs/{check_run_id}", { owner: p.owner, repo: p.repo, check_run_id: checkRun })) as { name?: unknown; head_sha?: unknown; conclusion?: unknown; output?: { title?: unknown; summary?: unknown } } | undefined;
      if (!info || (sha && info.head_sha !== sha)) continue;
      const text = [typeof info.output?.title === "string" ? cleanBlock(info.output.title, 300) : "", typeof info.output?.summary === "string" ? cleanBlock(info.output.summary, 2_000) : ""].filter(Boolean).join("\n\n");
      parts.push({ kind: "log", label: `check "${cleanLine(String(info.name ?? "?"), 120)}" (not GitHub Actions: no log ARIA can read) · ${cleanLine(String(info.conclusion ?? "?"), 40)}`, text: text || "(It said nothing more.)" });
    }
    const logs = tried === 0 || withLog === 0 ? "none" : withLog < tried ? "partial" : "ok";
    return { parts, logs, notes, ...(p.runNumber ? { run: p.runNumber } : {}) };
  }

  /** The review's text and its inline comments (D50): the untrusted part. */
  private async reviewPart(card: PrCard, review: { id: number; by: string; body: string }): Promise<{ part: UntrustedPart; notes: string[] }> {
    const p = card.payload;
    const notes: string[] = [];
    const list = (await this.read("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments", { owner: p.owner, repo: p.repo, pull_number: p.number, review_id: review.id, per_page: 100 })) as Array<Record<string, unknown>> | undefined;
    const comments = (Array.isArray(list) ? list : []).filter((c) => asId(c.pull_request_review_id) === review.id);
    if (Array.isArray(list) && list.length >= 100) notes.push("The review has more than 100 inline comments: the first 100 went to the task; the rest are on GitHub.");
    const byId = new Map<number, Record<string, unknown>>();
    for (const c of comments) if (asId(c.id)) byId.set(asId(c.id)!, c);
    const lines: string[] = [];
    if (review.body.trim()) lines.push(`The review's text:\n${markSuggestions(cleanBlock(review.body, 4_000))}`);
    let shown = 0;
    let odd = 0;
    for (const c of comments.filter((c) => !asId(c.in_reply_to_id) || !byId.has(asId(c.in_reply_to_id)!))) {
      if (shown >= MAX_COMMENTS) break;
      shown++;
      const path = safePath(c.path);
      if (!path) odd++;
      const line = asId(c.line) ?? asId(c.original_line);
      const start = asId(c.start_line);
      const where = `${path ?? "(an odd path)"}${line ? `:${start && start !== line ? `${start}–` : ""}${line}` : ""}${c.line === null || c.line === undefined ? " (on an older version of the file)" : ""}`;
      const replies = comments.filter((r) => asId(r.in_reply_to_id) === asId(c.id)).map((r) => `  reply by @${cleanLine(String((r.user as { login?: unknown } | undefined)?.login ?? "someone"), 60)}: ${markSuggestions(cleanBlock(String(r.body ?? ""), 1_500))}`);
      lines.push(`${where}\n${markSuggestions(cleanBlock(String(c.body ?? ""), 1_500))}${replies.length ? `\n${replies.join("\n")}` : ""}`);
    }
    if (odd > 0) notes.push(`${odd} comment${odd === 1 ? " has" : "s have"} a path ARIA doesn't show (a backslash, a drive, a way up): shown as "(an odd path)".`);
    const text = lines.join("\n\n").slice(0, MAX_REVIEW_TEXT) || "(The review has no text and no inline comments.)";
    return { part: { kind: "review", label: `review by @${review.by} (${shown} inline comment${shown === 1 ? "" : "s"})`, text }, notes };
  }

  // ── your click ────────────────────────────────────────────────────────────────────────────────────────────────

  /** Fix it on a red CI card (your click, or Start on ARIA's proposal). */
  async fixCi(cardId: string): Promise<FixRecord> {
    const card = this.deps.card(cardId);
    if (!card || card.kind !== "card" || card.cardType !== "ci") throw new Error("That card doesn't exist anymore.");
    return this.once(cardId, async () => {
      const target = await this.ciTarget(card);
      if (target.fetch) await this.fetchFor(target);
      const { parts, logs, notes, run } = await this.ciParts(card, target.sha);
      const nonce = newNonce();
      const message = ciFixMessage({ repo: `${card.payload.owner}/${card.payload.repo}`, branch: target.branch, sha: target.sha || "?", ...(run ? { run } : {}), notes: [...target.notes, ...notes], noLog: logs === "none", nonce });
      const untrusted = `${fence(parts, nonce, MAX_LOG_TEXT)}\n\n${message.after}`;
      // The title is ARIA's own words: a run's name can carry a commit message or a PR title (anyone's), and a
      // task's title reaches ARIA (list_tasks, get_task, digest lines). The run's name stays in the window.
      const watch = this.deps.watch(card.payload.watchId);
      const title = `Fix CI on ${target.pr ? `PR #${target.pr.number}` : target.branch}${watch ? ` (${watch.shortId})` : ""}`;
      const record = await this.deliver(card.id, target, { kind: "ci", fromText: "ci_log", brief: message.before, untrusted, title }, logs, [...target.notes, ...notes]);
      this.deps.saveCard({ ...card, payload: { ...card.payload, fix: record } as CiCardPayload, updatedAt: Date.now() });
      return record;
    });
  }

  /** Address comments on a review card. `ticked`: D51's extra tick. */
  async addressReview(cardId: string, ticked: boolean): Promise<FixRecord> {
    const card = this.deps.card(cardId);
    if (!card || card.kind !== "card" || card.cardType !== "pr") throw new Error("That card doesn't exist anymore.");
    return this.once(cardId, async () => {
      const target = await this.reviewTarget(card);
      if (target.needsTick && !ticked) throw new Error(`${target.needsTick} Tick that you've read the review and it's safe to hand to the task.`);
      const { part, notes } = await this.reviewPart(card, target.review);
      const nonce = newNonce();
      const message = reviewMessage({ repo: `${card.payload.owner}/${card.payload.repo}`, branch: target.branch, pr: card.payload.number, by: target.review.by, association: target.review.association, notes: [...target.notes, ...notes], nonce });
      const untrusted = `${fence([part], nonce, MAX_REVIEW_TEXT)}\n\n${message.after}`;
      const record = await this.deliver(card.id, target, { kind: "review", fromText: "review", brief: message.before, untrusted, title: `Address review on PR #${card.payload.number}` }, undefined, [...target.notes, ...notes]);
      this.deps.saveCard({ ...card, payload: { ...card.payload, fix: record } as PrCardPayload, updatedAt: Date.now() });
      return record;
    });
  }

  /** One fix at a time for a card (a double click gives one task). */
  private async once<T>(cardId: string, run: () => Promise<T>): Promise<T> {
    if (this.running.has(cardId)) throw new Error("It's on its way already.");
    this.running.add(cardId);
    try {
      return await run();
    } finally {
      this.running.delete(cardId);
    }
  }

  /** D53: the red commit into the project, the locked-down way. */
  private async fetchFor(target: Target): Promise<void> {
    if (this.deps.noPush !== undefined) throw new Error(this.deps.noPush.replace("push", "fetch"));
    const project = target.project;
    const gitDir = (await git(project.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).out;
    const ghPath = this.deps.testPush ? "gh-isnt-used-in-a-test-run" : this.deps.ghPath();
    if (!ghPath) throw new Error("GitHub CLI isn't found: ARIA fetches with its sign-in.");
    const fetchTarget = pushTarget(project.owner!, project.repo!, { ...(this.deps.testPush ? { testRoot: this.deps.testPush.root, testConfig: this.deps.testPush.config } : {}), ghPath });
    try {
      await fetchCommit({ gitDir, sha: target.sha, target: fetchTarget, scratchRoot: this.deps.scratchRoot, signal: this.controller.signal });
    } catch (error) {
      throw new Error(`ARIA couldn't fetch ${target.sha.slice(0, 7)} from GitHub: ${error instanceof PushRefused || error instanceof Error ? error.message : "it didn't work"} Pull ${target.branch} yourself, then Fix it.`, { cause: error });
    }
    if (!(await git(project.path, ["cat-file", "-e", `${target.sha}^{commit}`])).ok) throw new Error(`${target.sha.slice(0, 7)} still isn't in ${project.name}: pull ${target.branch} yourself, then Fix it.`);
  }

  /** Continue the owner, adopt its branch, or start a new task; record it on the task and the card; tell ARIA. */
  private async deliver(
    cardId: string,
    target: Target,
    what: { kind: "ci" | "review"; fromText: "ci_log" | "review"; brief: string; untrusted: string; title: string },
    logs: FixRecord["logs"],
    notes: string[],
  ): Promise<FixRecord> {
    const fixing = { kind: what.kind, cardId, label: target.label };
    let task: Task;
    if (target.how === "continue" && target.task) {
      task = target.task;
      await this.deps.tasks.message(task.id, what.brief, false, what.untrusted);
      this.deps.tasks.markFixing(task.id, fixing, what.fromText);
    } else {
      const profile = this.deps.ciFixProfile();
      if (!profile) throw new Error("There's no profile to start the fix with: add one in Customize › Models.");
      task = await this.deps.tasks.start({
        project: target.project,
        brief: what.brief,
        title: target.task ? target.task.title : what.title,
        profile,
        profileNote: `Fix it uses ${profile.name} (Customize › Models).`,
        startedBy: "you",
        untrusted: what.untrusted,
        fromText: what.fromText,
        fixing,
        ...(target.how === "adopt" && target.task ? { adopt: target.task.id } : { baseBranch: target.branch, baseCommit: target.sha }),
      });
    }
    const record: FixRecord = { taskId: task.id, taskTitle: task.title, how: target.how, at: Date.now(), ...(logs ? { logs } : {}), ...(notes.length ? { notes } : {}) };
    const watch = this.cardWatch(cardId);
    this.deps.digest(`fix:${cardId}`, `[${what.kind === "ci" ? "ci" : "review"}] You gave ${target.digestWhat} to ${digestText(task.title, 80)}${target.how === "start" ? " (a new task)" : target.how === "adopt" ? " (a new task on its branch)" : ""}${watch ? ` (${watch.shortId})` : ""}.`);
    return record;
  }

  private cardWatch(cardId: string): Watch | undefined {
    const card = this.deps.card(cardId);
    const watchId = card?.kind === "card" && (card.cardType === "ci" || card.cardType === "pr") ? card.payload.watchId : undefined;
    return watchId !== undefined ? this.deps.watch(watchId) : undefined;
  }

  // ── ARIA's proposals (D48) ──────────────────────────────────────────────────────────────────────────────────

  /** The newest red CI card, or review card, of a watch. */
  private newestFor(watchId: number, kind: "ci" | "review"): CiCard | PrCard | undefined {
    let newest: CiCard | PrCard | undefined;
    for (const c of this.deps.cards()) {
      if (c.kind !== "card") continue;
      if (kind === "ci" && c.cardType === "ci" && c.payload.outcome === "failure" && c.payload.watchId === watchId) newest = c;
      if (kind === "review" && c.cardType === "pr" && (c.payload.event === "changes_requested" || c.payload.event === "commented") && c.payload.watchId === watchId) newest = c;
    }
    return newest;
  }

  /** `fix_ci` / `address_review`: a card that proposes it; nothing starts until your Start. */
  async propose(kind: "ci" | "review", watchRef: Watch): Promise<ProposalCard> {
    const card = this.newestFor(watchRef.id, kind);
    if (!card) throw new Error(kind === "ci" ? `${watchRef.shortId} has no red CI card to fix.` : `${watchRef.shortId} has no review asking for changes.`);
    const target = card.cardType === "ci" ? await this.ciTarget(card) : await this.reviewTarget(card);
    const existing = this.deps.cards().find((c): c is ProposalCard => c.kind === "card" && c.cardType === "fix_proposal" && c.payload.cardId === card.id && c.payload.status === "pending");
    const payload: FixProposalPayload = {
      kind,
      cardId: card.id,
      watchId: watchRef.id,
      repoName: card.payload.repoName,
      target: target.label,
      plan: this.plan(target),
      status: "pending",
      revision: (existing?.payload.revision ?? 0) + 1,
    };
    const proposal: ProposalCard = { kind: "card", id: existing?.id ?? `fix-proposal-${randomUUID()}`, cardType: "fix_proposal", payload, createdAt: existing?.createdAt ?? Date.now(), ...(existing ? { updatedAt: Date.now() } : {}) };
    this.deps.saveCard(proposal);
    return proposal;
  }

  /** Start on a proposal: the target and the logs are worked out again now (the duck's point 5). */
  async startProposal(cardId: string, revision: number, ticked: boolean): Promise<FixRecord> {
    const card = this.deps.card(cardId);
    if (!card || card.kind !== "card" || card.cardType !== "fix_proposal") throw new Error("That card doesn't exist anymore.");
    if (card.payload.status !== "pending") throw new Error("This proposal isn't waiting for you anymore.");
    if (card.payload.revision !== revision) throw new Error("The proposal changed since you looked at it: look again, then Start.");
    this.deps.saveCard({ ...card, payload: { ...card.payload, status: "started", revision: revision + 1 }, updatedAt: Date.now() });
    try {
      const result = card.payload.kind === "ci" ? await this.fixCi(card.payload.cardId) : await this.addressReview(card.payload.cardId, ticked);
      const now = this.deps.card(cardId) as ProposalCard;
      this.deps.saveCard({ ...now, payload: { ...now.payload, result, revision: now.payload.revision + 1 }, updatedAt: Date.now() });
      return result;
    } catch (error) {
      const now = this.deps.card(cardId) as ProposalCard;
      const text = githubText(error instanceof Error ? error.message : String(error), 600);
      // A missing tick: it waits for you again.
      const pending = /Tick that you've read/.test(text);
      this.deps.saveCard({ ...now, payload: { ...now.payload, status: pending ? "pending" : "failed", error: text, revision: now.payload.revision + 1 }, updatedAt: Date.now() });
      throw error;
    }
  }

  dismissProposal(cardId: string): void {
    const card = this.deps.card(cardId);
    if (!card || card.kind !== "card" || card.cardType !== "fix_proposal") throw new Error("That card doesn't exist anymore.");
    if (card.payload.status === "pending" || card.payload.status === "failed") this.deps.saveCard({ ...card, payload: { ...card.payload, status: "dismissed", revision: card.payload.revision + 1 }, updatedAt: Date.now() });
  }
}

/** A ```suggestion block, marked as the reviewer's own proposed code (D51, the duck's point 1). */
function markSuggestions(text: string): string {
  return text.replace(/```suggestion\b[^\n]*\n/g, "(a suggested change, as the reviewer wrote it:)\n```\n");
}

export const validRepo = (owner: unknown, repo: unknown) => validName(owner) && validName(repo);
