/**
 * Opening a task's pull request (PLAN.md §4.3, §4.4, item 3, D41–D44): a card (`pr_confirm`) that shows exactly what
 * will be pushed and sent, made by the Done card's Open PR or by ARIA's `open_pr` (which only proposes: D19, D22),
 * and your click on it, which alone pushes (tasks/push.ts) and opens (github/write.ts), then watches the PR's checks
 * (a PR watch by the task, in the reserved places). Everything on the card comes from ARIA's records but the title,
 * the body, the draft switch and which repository it opens on (among the card's own choices); the worker's words (its
 * report, its commit subjects, its paths) are cleaned and shown as plain text, and its report goes into a code block.
 * A task in autopilot never gets here by itself (D44).
 */
import { randomUUID } from "node:crypto";
import type { CardItem, GitHubRepo, PrConfirmPayload, Project, Task, TaskPr } from "@aria/protocol";
import { execa } from "execa";
import type { GitHubAccess } from "../github/access.ts";
import { GitHubFailure } from "../github/client.ts";
import { id as asId, digestText, githubText, validName } from "../github/text.ts";
import { openPullRequest, refusal } from "../github/write.ts";
import { localGitEnvironment, PushRefused, pushCommit, pushTarget, withScratch } from "./push.ts";

type PrCard = Extract<CardItem, { cardType: "pr_confirm" }>;

/** What opening a PR needs of a task beyond `Task` (its base commit). */
export interface PrTaskInfo {
  task: Task;
  baseCommit?: string;
}

export interface PrDeps {
  access: GitHubAccess | undefined;
  /** The task (throws when it was discarded), with its base commit. */
  task(taskId: string): PrTaskInfo;
  project(repoId: number): Project | undefined;
  card(cardId: string): CardItem | undefined;
  /** All of the timeline's PR cards (to find a task's). */
  cards(): PrCard[];
  saveCard(card: CardItem): void;
  setPr(taskId: string, pr: TaskPr): void;
  /** A PR watch by the task, until merged (the reserved places, item 2); its id, or why not. */
  watchPr(input: { owner: string; repo: string; number: number; repoId: number; repoName: string; taskId: string }): Promise<{ watchId?: number; note?: string }>;
  digest(key: string, line: string): void;
  /** A test run's bare repositories (`pushRoot`) and its git config file; unset in normal use. */
  testPush?: { root: string; config: string };
  /** Set in a test run without `pushRoot`: no push at all (it would go to github.com). */
  noPush?: string;
  /** gh's full path, for git's credential helper (normal use). */
  ghPath(): string | undefined;
  /** ARIA's own temp folder for the push's scratch repository. */
  scratchRoot: string;
  log(line: string): void;
}

export const MAX_TITLE = 256;
export const MAX_BODY = 65_536;
const MAX_REPORT = 20_000;
const MAX_PATHS = 200;
const MAX_SUBJECTS = 50;

/** Characters that change how text reads without being seen (bidi, zero-width, tags, ANSI's escape): out, but \n and \t. */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;
export const cleanText = (text: string) =>
  text
    .replace(/\r\n?|[\p{Zl}\p{Zp}]/gu, "\n")
    .replace(INVISIBLE, (c) => (c === "\n" || c === "\t" ? c : ""));
/** A title: one line, cleaned like GitHub's other text. */
export const cleanTitle = (text: string, max = MAX_TITLE) => githubText(cleanText(text).replace(/\n/g, " "), max);

/** D43: workflows need their own tick; these other files run code in builds or CI and are flagged. */
const WORKFLOW = /^\.github\/workflows\//;
const FLAGGED = [
  /^\.github\//,
  /^\.gitmodules$/,
  /^\.gitattributes$/,
  /^\.husky\//,
  /(^|\/)package\.json$/,
  /(^|\/)(?:Makefile|makefile|GNUmakefile)$/,
  /\.mk$/,
  /(^|\/)Dockerfile$/,
  /(^|\/)Directory\.Build\.(?:props|targets)$/,
  /(^|\/)(?:NuGet\.config|global\.json|\.npmrc)$/i,
  /(^|\/)(?:build|scripts|tools)\//,
  /(^|\/)(?:build|setup|install|bootstrap)\.(?:ps1|sh|cmd|bat|py)$/i,
];

/**
 * D52: for a task started from someone else's text (a CI log, a review), these need the tick too: anything under
 * `.github`, package manifests and lockfiles, build scripts (FLAGGED above), and deleted or weakened tests.
 */
const EXTENDED = [
  /^\.github\//,
  /(^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.yarnrc(?:\.yml)?|bun\.lockb?)$/i,
  /\.(?:csproj|fsproj|vbproj|props|targets)$/i,
  /(^|\/)(?:packages\.config|packages\.lock\.json|Directory\.Packages\.props)$/i,
  /(^|\/)(?:requirements[^/]*\.txt|Pipfile(?:\.lock)?|pyproject\.toml|poetry\.lock|uv\.lock|setup\.py|setup\.cfg|tox\.ini|noxfile\.py)$/i,
  /(^|\/)(?:Cargo\.(?:toml|lock)|go\.(?:mod|sum)|Gemfile(?:\.lock)?|composer\.(?:json|lock)|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties|gradlew(?:\.bat)?)$/i,
  /(^|\/)(?:CMakeLists\.txt|meson\.build|BUILD(?:\.bazel)?|WORKSPACE|justfile|Taskfile\.ya?ml|\.pre-commit-config\.yaml)$/i,
  /(^|\/)(?:vitest|jest|playwright|karma|cypress|webpack|vite|rollup|babel|tsconfig)[^/]*\.(?:[cm]?[jt]s|json)$/i,
];
const TEST_FILE = /(^|\/)(?:tests?|__tests__|specs?|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py)$|(^|\/)test_[^/]+\.py$|Tests?\.cs$/i;

/**
 * The PR's body: one line of ARIA's (numbers only) and, in a code block, the task's title and the worker's report
 * (anyone's words: GitHub links, mentions, closes and renders nothing in a fence). The fence is longer than any run of
 * backticks inside.
 */
export function prBody(title: string, report: string | undefined, stats: { commits: number; filesChanged: number; additions: number; deletions: number }): string {
  const inner = `${cleanTitle(title, MAX_TITLE)}\n\n${cleanText(report ?? "").trim().slice(0, MAX_REPORT) || "(The worker left no report.)"}`;
  const longest = Math.max(0, ...[...inner.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `Opened by ARIA from a task: ${plural(stats.commits, "commit")}, ${plural(stats.filesChanged, "file")}, +${stats.additions} −${stats.deletions}. The task's title and its report:\n\n${fence}text\n${inner}\n${fence}\n`;
}

/** The project's git, for its refs only (the branch's tip, the common dir): what the card shows comes from a scratch view. */
async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const result = await execa("git", ["-c", "core.fsmonitor=false", "-c", "core.longpaths=true", "--no-replace-objects", "-C", cwd, ...args], { reject: false, windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  return { ok: result.exitCode === 0, out: String(result.stdout ?? "") };
}

const SHA = /^[0-9a-f]{40,64}$/;
const same = (a: GitHubRepo, b: GitHubRepo) => a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();

export class PullRequests {
  private readonly controller = new AbortController();
  private readonly proposing = new Map<string, Promise<PrCard>>();

  constructor(private readonly deps: PrDeps) {}

  private get access(): GitHubAccess {
    if (!this.deps.access) throw new Error("GitHub isn't set up in this run of ARIA.");
    return this.deps.access;
  }

  /** A read for the card's checks; a 404 is `undefined`. */
  private async read(route: Parameters<GitHubAccess["get"]>[0], params: Record<string, string | number>): Promise<unknown> {
    try {
      const result = await this.access.get(route, params, {}, this.controller.signal);
      return result.status === 200 ? result.data : undefined;
    } catch (error) {
      if (error instanceof GitHubFailure && error.type === "not_found") return undefined;
      throw error;
    }
  }

  private cardOf(taskId: string): PrCard | undefined {
    return this.deps.cards().find((c) => c.payload.taskId === taskId && (c.payload.status === "pending" || c.payload.status === "failed" || c.payload.status === "pushing" || c.payload.status === "opening"));
  }

  private save(card: PrCard, patch: Partial<PrConfirmPayload>): PrCard {
    const next: PrCard = { ...card, payload: { ...card.payload, ...patch, revision: card.payload.revision + 1 }, updatedAt: Date.now() };
    if (patch.error === undefined && "error" in patch) delete next.payload.error;
    this.deps.saveCard(next);
    return next;
  }

  /**
   * Open PR (the Done card's) or `open_pr` (ARIA's: it can propose a title, never `draft: false`): the task's card,
   * made or worked out again (a failed one: Try again). Every check that doesn't need your click happens here.
   */
  propose(taskId: string, by: "you" | "aria", title?: string): Promise<PrCard> {
    // One at a time for a task (two clicks, or a click and ARIA's tool, make one card).
    const running = this.proposing.get(taskId);
    if (running) return running;
    const made = this.proposeNow(taskId, by, title).finally(() => this.proposing.delete(taskId));
    this.proposing.set(taskId, made);
    return made;
  }

  private async proposeNow(taskId: string, by: "you" | "aria", title?: string): Promise<PrCard> {
    const existing = this.cardOf(taskId);
    if (existing && (existing.payload.status === "pushing" || existing.payload.status === "opening")) return existing;
    if (existing?.payload.status === "pending" && by === "aria") return existing;
    let payload: Omit<PrConfirmPayload, "revision">;
    try {
      payload = await this.work(taskId, by, title ?? (existing?.payload.proposedBy === "aria" ? existing.payload.title : undefined));
    } catch (error) {
      // The card says why it can't go now (a card that was waiting for your click can't be clicked anymore).
      const now = existing ? this.deps.card(existing.id) : undefined;
      if (now?.kind === "card" && now.cardType === "pr_confirm" && (now.payload.status === "pending" || now.payload.status === "failed")) this.save(now as PrCard, { status: "failed", error: githubText(error instanceof Error ? error.message : String(error), 600) });
      throw error;
    }
    if (existing) {
      // Read again: a click may have come while GitHub was asked (then that one goes on, and this changes nothing).
      const now = this.deps.card(existing.id) as PrCard | undefined;
      if (!now || now.payload.status === "pushing" || now.payload.status === "opening" || now.payload.status === "done") return now ?? existing;
      return this.save(now, { ...payload, status: "pending", error: undefined } as Partial<PrConfirmPayload>);
    }
    const card: PrCard = { kind: "card", id: `pr-confirm-${randomUUID()}`, cardType: "pr_confirm", payload: { ...payload, revision: 1 }, createdAt: Date.now() };
    this.deps.saveCard(card);
    return card;
  }

  /** The card's content, from the task and the project and GitHub's answers (base, branch, an open PR). */
  private async work(taskId: string, by: "you" | "aria", proposedTitle?: string): Promise<Omit<PrConfirmPayload, "revision">> {
    const { task, baseCommit } = this.deps.task(taskId);
    if (task.where === "cloud") {
      throw new Error(`This task ran in the cloud on Mission Control${task.missionControlUrl ? ` (${task.missionControlUrl})` : ""}: open or review its pull request there.`);
    }
    if (task.state !== "done") throw new Error(task.state === "failed" || task.state === "cancelled" || task.state === "interrupted" ? "The task didn't finish: Continue it first." : "The task is still working: a PR waits for it to be done.");
    if (task.cleanedUp) throw new Error("The task's worktree was cleaned up: open the PR from its branch yourself.");
    if (!task.branch?.startsWith("aria/") || !baseCommit || !SHA.test(baseCommit) || !task.baseBranch) throw new Error("The task has no branch of its own to push.");
    const branch = task.branch;
    const baseBranch = task.baseBranch;
    const project = this.deps.project(task.repoId);
    if (!project || project.hidden) throw new Error("The task's project isn't one of yours anymore.");
    if (project.host !== "github.com" || !validName(project.owner) || !validName(project.repo)) throw new Error(`${project.name}'s remote isn't on github.com.`);
    const access = this.access;
    if (!(await access.ensure()) || !access.ready() || !access.login) throw new Error(`GitHub can't be read right now: ${access.view().message ?? "it isn't available"}`);
    const login = access.login;
    const tip = (await git(task.repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`])).out.trim();
    if (!SHA.test(tip)) throw new Error("The task's branch isn't in the project anymore.");
    const gitDir = (await git(task.repoPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).out.trim();

    const pushTo: GitHubRepo = { owner: project.owner!, repo: project.repo! };
    const upstream = project.upstream ? (() => {
      const [owner, repo] = project.upstream!.split("/");
      return validName(owner) && validName(repo) ? { owner, repo } : undefined;
    })() : undefined;
    const choices = upstream && !same(upstream, pushTo) ? [pushTo, upstream] : [pushTo];
    const notes: string[] = [];

    // One view of the commits for the card and the push: a scratch repository borrowing the project's objects, so
    // nothing of the project's (replace refs, grafts, config) changes what the card shows (review round 1, finding 2).
    const view = await withScratch({ gitDir, scratchRoot: this.deps.scratchRoot, env: localGitEnvironment(process.env), prefix: "card-" }, async (s) => {
      for (const sha of [tip, baseCommit]) if (!(await s.git(["cat-file", "-e", `${sha}^{commit}`])).ok) throw new Error("The task's commits aren't in the project's repository anymore.");
      const isAncestor = async (sha: string) => SHA.test(sha) && (await s.git(["merge-base", "--is-ancestor", sha, tip])).ok;
      const commits = Number((await s.git(["rev-list", "--count", `${baseCommit}..${tip}`])).stdout.trim()) || 0;
      if (commits === 0) throw new Error("The task has no commits to push.");
      // Raw paths (-z, quotePath off): a quoted name ("d\303\251ploy.yml") would slip past D43's patterns.
      const numstat = (await s.git(["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", baseCommit, tip])).stdout;
      const subjects = (await s.git(["log", "--format=%s", `${baseCommit}..${tip}`])).stdout;
      // D52's deleted tests: the files the commits remove.
      const deleted = task.fromText ? (await s.git(["diff", "--name-only", "-z", "--no-renames", "--diff-filter=D", baseCommit, tip])).stdout.split("\0").filter(Boolean) : [];
      // The task's PR, if it's still open: its branch is where the commits go, and only as more commits on it.
      let openPr: { number: number; remoteBranch: string; openOn: GitHubRepo } | undefined;
      if (task.pr) {
        const pull = (await this.read("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner: task.pr.owner, repo: task.pr.repo, pull_number: task.pr.number })) as { state?: unknown; merged?: unknown; head?: { sha?: unknown } } | undefined;
        const prRepo = choices.find((c) => same(c, { owner: task.pr!.owner, repo: task.pr!.repo }));
        const prBranch = task.pr.head.includes(":") ? task.pr.head.slice(task.pr.head.indexOf(":") + 1) : task.pr.head;
        if (pull?.state === "open" && prRepo) {
          const head = typeof pull.head?.sha === "string" ? pull.head.sha : "";
          // Review round 1, finding 4: never a second PR beside an open one. Its head must be in the task's branch.
          if (!(await isAncestor(head))) {
            throw new Error(
              `PR #${task.pr.number}'s commits (${head.slice(0, 7) || "?"}) aren't in the task's branch anymore: the branch was rewritten, or someone pushed to the PR on GitHub. ARIA doesn't force-push, and doesn't open a second PR beside #${task.pr.number}. Continue the task to redo its change on top of the PR's commits, or push it yourself.`,
            );
          }
          openPr = { number: task.pr.number, remoteBranch: prBranch, openOn: prRepo };
        } else if (pull) {
          notes.push(`PR #${task.pr.number} is ${pull.merged === true ? "merged" : "closed"}: this opens a new PR for the new commits.`);
        }
      }
      const remoteBranch = openPr?.remoteBranch ?? (await this.remoteName(pushTo, branch, tip, isAncestor));
      return { commits, numstat, subjects, deleted, openPr, remoteBranch };
    });

    let additions = 0;
    let deletions = 0;
    const raw: string[] = [];
    const weakened: string[] = [];
    for (const record of view.numstat.split("\0").filter(Boolean)) {
      const first = record.indexOf("\t");
      const second = record.indexOf("\t", first + 1);
      if (first < 0 || second < 0) continue;
      const added = Number(record.slice(0, first)) || 0;
      const removed = Number(record.slice(first + 1, second)) || 0;
      additions += added;
      deletions += removed;
      const file = record.slice(second + 1);
      raw.push(file);
      // D52: a test file that lost more lines than it gained.
      if (TEST_FILE.test(file) && removed > added) weakened.push(file);
    }
    // D43 on the raw paths, before they're cleaned for showing.
    const shown = (p: string) => githubText(cleanText(p), 300);
    const workflows = raw.filter((p) => WORKFLOW.test(p)).map(shown);
    const flagged = raw.filter((p) => !WORKFLOW.test(p) && FLAGGED.some((f) => f.test(p))).map(shown);
    // D52: a task started from someone else's text gets the tick on more than workflows.
    const extendedPaths = task.fromText
      ? [...new Set([...raw.filter((p) => !WORKFLOW.test(p) && (EXTENDED.some((f) => f.test(p)) || FLAGGED.some((f) => f.test(p)))), ...view.deleted.filter((p) => TEST_FILE.test(p)), ...weakened])].map(shown)
      : [];
    const paths = raw.map(shown);
    const subjects = view.subjects
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, MAX_SUBJECTS)
      .map((s) => githubText(cleanText(s), 200));

    // D42: a fork's PR goes to the fork itself, unless the fork's base doesn't have the task's starting commit and the
    // upstream's does (review round 1, finding 5): then the card opens on the upstream, and says why.
    let openOn = view.openPr?.openOn ?? pushTo;
    if (!view.openPr) {
      try {
        await this.checkBase(pushTo, baseBranch, baseCommit);
      } catch (error) {
        if (!upstream || same(upstream, pushTo)) throw error;
        await this.checkBase(upstream, baseBranch, baseCommit).catch(() => {
          throw error;
        });
        openOn = upstream;
        notes.push(`${baseBranch} on your fork ${pushTo.owner}/${pushTo.repo} doesn't have the commit the task started from; ${upstream.owner}/${upstream.repo}'s does, so the PR is set to open there.`);
      }
    }
    const found = view.openPr ? { number: view.openPr.number, url: `https://github.com/${openOn.owner}/${openOn.repo}/pull/${view.openPr.number}` } : await this.openPr(openOn, pushTo, view.remoteBranch);
    const titleText = cleanTitle(proposedTitle !== undefined ? cleanTitle(proposedTitle, 120) : task.title) || cleanTitle(task.title);
    return {
      taskId,
      taskTitle: task.title,
      repoName: project.name,
      proposedBy: by,
      status: "pending",
      pushTo,
      choices,
      openOn,
      remoteBranch: view.remoteBranch,
      tip,
      base: baseBranch,
      draft: true,
      title: titleText,
      body: prBody(task.title, task.summary, { commits: view.commits, filesChanged: paths.length, additions, deletions }),
      login,
      commits: view.commits,
      filesChanged: paths.length,
      additions,
      deletions,
      uncommitted: task.uncommitted ?? 0,
      // R1: as counted when the task finished (uncommitted lines included); its paths are the worker's names too.
      ...(task.encodingDamage ? { encodingDamage: { ...task.encodingDamage, paths: task.encodingDamage.paths.map(shown) } } : {}),
      ...(task.sandboxed !== undefined ? { sandboxed: task.sandboxed } : {}),
      subjects,
      paths: paths.slice(0, MAX_PATHS),
      workflows,
      flagged,
      ...(notes.length ? { notes } : {}),
      ...(task.fromText ? { extended: { from: task.fromText, paths: extendedPaths } } : {}),
      ...(found ? { existing: { number: found.number, url: found.url } } : {}),
    };
  }

  /**
   * The branch's name on GitHub: `aria/<slug>` when it's free there, or already at these commits (an earlier push of
   * this task); else `aria/<slug>-<7 of the sha>` (an old merged PR's branch stays on GitHub). `isAncestor` looks in
   * the card's scratch view.
   */
  private async remoteName(pushTo: GitHubRepo, branch: string, tip: string, isAncestor: (sha: string) => Promise<boolean>): Promise<string> {
    const candidates = [branch, `${branch}-${tip.slice(0, 7)}`];
    for (const name of candidates) {
      const data = (await this.read("GET /repos/{owner}/{repo}/branches/{branch}", { owner: pushTo.owner, repo: pushTo.repo, branch: name })) as { commit?: { sha?: unknown } } | undefined;
      if (!data) return name;
      const sha = typeof data.commit?.sha === "string" ? data.commit.sha : "";
      if (sha === tip) return name;
      // The task's own earlier push: GitHub's commit is in the task's branch, so this push only adds commits.
      if (await isAncestor(sha)) return name;
    }
    throw new Error(`The branches ${candidates.join(" and ")} on ${pushTo.owner}/${pushTo.repo} have other commits: ARIA doesn't overwrite them.`);
  }

  /** The base must be on the repository the PR opens on, with the task's base commit in it (else they'd be in the PR). */
  private async checkBase(openOn: GitHubRepo, base: string, baseCommit: string): Promise<void> {
    const branch = (await this.read("GET /repos/{owner}/{repo}/branches/{branch}", { owner: openOn.owner, repo: openOn.repo, branch: base })) as { commit?: { sha?: unknown } } | undefined;
    const remote = typeof branch?.commit?.sha === "string" ? branch.commit.sha : undefined;
    if (!remote || !SHA.test(remote)) throw new Error(`${base} isn't on ${openOn.owner}/${openOn.repo}: the PR would have no base there.`);
    if (remote === baseCommit) return;
    const compared = (await this.read("GET /repos/{owner}/{repo}/compare/{basehead}", { owner: openOn.owner, repo: openOn.repo, basehead: `${remote}...${baseCommit}` })) as { status?: unknown } | undefined;
    if (compared?.status === "behind" || compared?.status === "identical") return;
    throw new Error(`The task started from a ${base} with commits that aren't on ${openOn.owner}/${openOn.repo}'s ${base}: they'd be in the PR too. Push ${base} yourself first, or start the task from GitHub's ${base}.`);
  }

  /** An open PR for the branch on `openOn`, if there's one. */
  private async openPr(openOn: GitHubRepo, pushTo: GitHubRepo, remoteBranch: string): Promise<{ number: number; url: string; base?: string; draft?: boolean } | undefined> {
    const list = (await this.read("GET /repos/{owner}/{repo}/pulls", { owner: openOn.owner, repo: openOn.repo, head: `${pushTo.owner}:${remoteBranch}`, state: "open", per_page: 1 })) as Array<{ number?: unknown; draft?: unknown; base?: { ref?: unknown } }> | undefined;
    const first = Array.isArray(list) ? list[0] : undefined;
    const number = asId(first?.number);
    if (!first || !number) return undefined;
    // The address is ARIA's own (GitHub's html_url isn't taken from a list).
    return { number, url: `https://github.com/${openOn.owner}/${openOn.repo}/pull/${number}`, ...(typeof first.base?.ref === "string" ? { base: first.base.ref } : {}), ...(typeof first.draft === "boolean" ? { draft: first.draft } : {}) };
  }

  /**
   * Your click: push and open exactly as the card at `revision` shows it, with your edits. The card turns `pushing` at
   * once (a second click finds it so); a card that changed, a branch that moved, another GitHub account, refuse.
   */
  async confirm(input: { cardId: string; revision: number; title: string; body: string; draft: boolean; openOn: GitHubRepo; workflowsChecked: boolean }): Promise<PrCard> {
    const found = this.deps.card(input.cardId);
    if (!found || found.kind !== "card" || found.cardType !== "pr_confirm") throw new Error("That card doesn't exist anymore.");
    let card = found as PrCard;
    if (card.payload.status !== "pending") throw new Error(card.payload.status === "pushing" || card.payload.status === "opening" ? "It's on its way already." : "This card isn't waiting for a click: Open PR again.");
    if (input.revision !== card.payload.revision) throw new Error("The card changed since you looked at it: look again, then click.");
    // Your edits, checked before anything moves (the card stays as it is for you to fix them).
    const title = cleanTitle(input.title);
    if (!title) throw new Error("The PR needs a title.");
    const body = cleanText(input.body);
    if (body.length > MAX_BODY) throw new Error(`The body is longer than GitHub takes (${MAX_BODY} characters).`);
    const openOn = card.payload.choices.find((c) => same(c, input.openOn));
    if (!openOn) throw new Error("That isn't one of the repositories this PR can open on.");
    if (card.payload.workflows.length > 0 && !input.workflowsChecked) throw new Error("The commits change GitHub workflows: tick that you've checked them first.");
    // D52: the same tick covers what a task started from someone else's text changed in builds, CI and tests.
    if ((card.payload.extended?.paths.length ?? 0) > 0 && !input.workflowsChecked) throw new Error("The task worked from someone else's text and changed build, CI or test files: tick that you've checked them first.");
    // Then, before any await: the card is on its way (a second click finds it so).
    card = this.save(card, { status: "pushing", error: undefined } as Partial<PrConfirmPayload>);
    try {
      const p = card.payload;
      // The task and its branch as the card showed them.
      const { task, baseCommit } = this.deps.task(p.taskId);
      if (task.cleanedUp) throw new Error("The task's worktree was cleaned up since: open the PR from its branch yourself.");
      if (task.state !== "done" || !task.branch || !baseCommit) throw new Error("The task isn't done anymore (it continued): Open PR again when it is.");
      const tip = (await git(task.repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${task.branch}^{commit}`])).out.trim();
      if (tip !== p.tip) throw new Error("The task's branch moved since this card was made: Open PR again to see what it has now.");
      // The account the card named.
      const access = this.access;
      await access.ensure(true);
      if (!access.ready() || access.login !== p.login) throw new Error(access.login && access.login !== p.login ? `GitHub CLI now uses @${access.login}, not @${p.login}: Open PR again.` : `GitHub can't be read right now: ${access.view().message ?? "it isn't available"}`);
      if (!same(openOn, p.openOn)) await this.checkBase(openOn, p.base, baseCommit);
      const head = same(openOn, p.pushTo) ? p.remoteBranch : `${p.pushTo.owner}:${p.remoteBranch}`;
      const existing = await this.openPr(openOn, p.pushTo, p.remoteBranch);
      if (existing?.base && existing.base !== p.base) throw new Error(`PR #${existing.number} is open for this branch on another base (${existing.base}).`);

      if (this.deps.noPush !== undefined) throw new Error(this.deps.noPush);
      const gitDir = (await git(task.repoPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).out.trim();
      const ghPath = this.deps.testPush ? "gh-isnt-used-in-a-test-run" : this.deps.ghPath();
      if (!ghPath) throw new Error("GitHub CLI isn't found: ARIA pushes with its sign-in.");
      const target = pushTarget(p.pushTo.owner, p.pushTo.repo, { ...(this.deps.testPush ? { testRoot: this.deps.testPush.root, testConfig: this.deps.testPush.config } : {}), ghPath });
      await pushCommit({ gitDir, tip, remoteBranch: p.remoteBranch, target, scratchRoot: this.deps.scratchRoot, signal: this.controller.signal });
      card = this.save(card, { status: "opening" });

      let opened: { number: number; url: string; draft: boolean; updated?: boolean };
      if (existing) {
        opened = { number: existing.number, url: existing.url, draft: existing.draft ?? input.draft, updated: true };
      } else {
        try {
          opened = await access.write((ctx) => openPullRequest({ ...ctx, owner: openOn.owner, repo: openOn.repo, payload: { title, head, base: p.base, body, draft: input.draft }, signal: this.controller.signal }));
        } catch (error) {
          // It exists already (made meanwhile): find it and link it, when it's on the card's base.
          if (refusal(error) !== "exists") throw error;
          const again = await this.openPr(openOn, p.pushTo, p.remoteBranch);
          if (!again || (again.base && again.base !== p.base)) throw error;
          opened = { number: again.number, url: again.url, draft: again.draft ?? input.draft, updated: true };
        }
      }
      const pr: TaskPr = { owner: openOn.owner, repo: openOn.repo, number: opened.number, url: opened.url, head, base: p.base, draft: opened.draft, openedAt: Date.now() };
      const watched = await this.deps.watchPr({ owner: openOn.owner, repo: openOn.repo, number: opened.number, repoId: task.repoId, repoName: task.repoName, taskId: task.id });
      this.deps.setPr(task.id, { ...pr, ...(watched.watchId !== undefined ? { watchId: watched.watchId } : {}) });
      const kind = opened.draft ? "draft PR" : "PR";
      this.deps.digest(
        `pr:${task.id}`,
        `[pr] You ${opened.updated ? `pushed new commits to ${kind}` : `opened ${kind}`} #${opened.number} for ${digestText(task.title, 80)} on ${openOn.owner}/${openOn.repo}${watched.watchId !== undefined ? `; ARIA watches its checks (W-${watched.watchId})` : ""}.`,
      );
      return this.save(card, { status: "done", title, body, draft: input.draft, openOn, result: { number: opened.number, url: opened.url, draft: opened.draft, ...(watched.watchId !== undefined ? { watchId: watched.watchId } : {}), ...(opened.updated ? { updated: true } : {}) }, ...(watched.note ? { error: watched.note } : {}) });
    } catch (error) {
      const message = error instanceof PushRefused || error instanceof GitHubFailure || error instanceof Error ? error.message : "It didn't work.";
      const text = githubText(message.replace(/\b(?:gh[opsu]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, "[token]"), 600);
      // Draft PRs not taken there: the card waits for your click again (switch Draft off).
      // Your edits stay on it (the card shows what the next click sends).
      if (refusal(error) === "draft") return this.save(card, { status: "pending", title, body, openOn, error: `${text} Switch Draft off to open it as a ready PR.` });
      this.deps.log(`ARIA couldn't open the PR for ${card.payload.taskId}: ${text}`);
      return this.save(card, { status: "failed", error: text });
    }
  }

  dismiss(cardId: string): void {
    const card = this.deps.card(cardId);
    if (!card || card.kind !== "card" || card.cardType !== "pr_confirm") throw new Error("That card doesn't exist anymore.");
    if (card.payload.status === "pushing" || card.payload.status === "opening") throw new Error("It's on its way: it can't be dismissed now.");
    if (card.payload.status === "pending" || card.payload.status === "failed") this.save(card as PrCard, { status: "dismissed" });
  }

  /** At the start: a card ARIA closed during says so (Try again looks again first: the branch, an open PR). */
  recover(): void {
    for (const card of this.deps.cards()) {
      if (card.payload.status === "pushing" || card.payload.status === "opening") this.save(card, { status: "failed", error: "ARIA closed while it was on its way: Try again (it looks for the pushed branch and an open PR first)." });
    }
  }

  stop(): void {
    this.controller.abort();
  }
}
