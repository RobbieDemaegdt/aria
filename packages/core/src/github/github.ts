import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AttentionSettings, CardItem, EngineEvent, GitHubState, MyWorkState, NoticeItem, Project, TimelineItem, UtilitySettings, Watch } from "@aria/protocol";
import type { AttentionEvent } from "../attention/attention.ts";
import { realClock } from "../attention/clock.ts";
import type { Digest } from "../attention/digest.ts";
import type { WatchToolDeps } from "../conductor/tools.ts";
import type { EngineOptions } from "../engine-options.ts";
import { EMPTY_MCP_CONFIG } from "../integrations/config.ts";
import { isSeen, type Catalog } from "../integrations/rules.ts";
import type { Integrations } from "../integrations/integrations.ts";
import { readRepoInfo, type RepoInfo } from "../memory/repos.ts";
import type { UtilitySummaryRequest, UtilitySummaryResult } from "../runtime/types.ts";
import type { Store } from "../store/store.ts";
import { CiFixes } from "../tasks/fix.ts";
import type { TaskManager } from "../tasks/manager.ts";
import { cleanText, PullRequests } from "../tasks/pr.ts";
import type { Profiles } from "../tasks/profiles.ts";
import { writeTestPushConfig } from "../tasks/push.ts";
import { WorkflowDispatches } from "../watchers/dispatch.ts";
import { MyWork } from "../watchers/mywork.ts";
import { OutlookWatcher } from "../watchers/outlook.ts";
import type { TaskTracker } from "../trackers/types.ts";
import { TrackerWatcher } from "../watchers/tracker.ts";
import { Watchers } from "../watchers/watchers.ts";
import { findGh, GitHubAccess } from "./access.ts";
import { digestText, login as asLogin, repoKey, validName } from "./text.ts";

export interface GitHubDeps {
  db: () => Store;
  tracker: () => TaskTracker;
  options: EngineOptions;
  log: (line: string) => void;
  emit: (event: EngineEvent) => void;
  addToTimeline: (item: TimelineItem) => void;
  attention: (event: AttentionEvent) => void;
  digest: Digest;
  notice: (level: NoticeItem["level"], text: string, cause?: string) => void;
  /** The tracker and Outlook watchers' MCP tools. */
  integrations: Integrations;
  runtimeStarted?: () => boolean;
  attentionSettings?: () => AttentionSettings;
  utilitySettings?: () => UtilitySettings;
  runUtilityTriage?: (request: UtilitySummaryRequest) => Promise<UtilitySummaryResult>;
  tasks: () => TaskManager;
  profiles: () => Profiles;
  resolveProject: (ref: string) => Project;
  saveRepo: (info: RepoInfo, addedVia: Project["addedVia"]) => Project;
}

/**
 * GitHub (PLAN.md §4.6): who ARIA reads it as, the watches, the tracker watcher, the Outlook watcher, My work, and
 * what opens PRs, fixes CI and runs workflows. Everything starts with startWatchers; none of it without `options.github`
 * but the watchers.
 */
export class GitHub {
  /** GitHub (who ARIA reads it as) and the watchers (PLAN.md §4.6); none without `options.github`. */
  githubAccess: GitHubAccess | undefined;
  watchers: Watchers | undefined;
  trackerWatcher: TrackerWatcher | undefined;
  outlookWatcher: OutlookWatcher | undefined;
  myWorkList: MyWork | undefined;
  prs: PullRequests | undefined;
  fixes: CiFixes | undefined;
  dispatches: WorkflowDispatches | undefined;
  /** Watch clicks from My work on their way, by item key: one watch per key however often it's clicked. */
  private readonly watchingPr = new Map<string, Promise<Watch>>();

  constructor(private readonly deps: GitHubDeps) {}

  /**
   * Your projects' repositories on github.com, lowercased "owner/name" → the project: each project's origin, then a
   * fork's upstream; a repository two projects claim goes to the one whose origin it is, else the lower id. Hidden
   * projects aren't yours to see. This is D38's "your projects" (My work searches these) and how a watch finds its row.
   */
  githubProjects(): Map<string, { repoId: number; repoName: string }> {
    const projects = this.deps.db()
      .listRepos()
      .filter((p) => !p.hidden)
      .sort((a, b) => a.id - b.id);
    const map = new Map<string, { repoId: number; repoName: string }>();
    for (const p of projects) {
      if (p.host === "github.com" && p.owner && p.repo && validName(p.owner) && validName(p.repo) && !map.has(repoKey(p.owner, p.repo))) map.set(repoKey(p.owner, p.repo), { repoId: p.id, repoName: p.name });
    }
    for (const p of projects) {
      if (p.host !== "github.com" || !p.upstream) continue;
      const [owner, repo] = p.upstream.split("/");
      if (validName(owner) && validName(repo) && !map.has(repoKey(owner, repo))) map.set(repoKey(owner, repo), { repoId: p.id, repoName: p.name });
    }
    return map;
  }

  startWatchers(): void {
    const clock = this.deps.options.watchClock ?? this.deps.options.attentionClock ?? realClock;
    let watchers: Watchers | undefined;
    let myWork: MyWork | undefined;
    if (this.deps.options.github) {
      this.githubAccess = new GitHubAccess(this.deps.options.github, {
        clock,
        log: (line) => this.deps.log(line),
        changed: () => {
          watchers?.accessChanged();
          myWork?.accessChanged();
        },
        loginChanged: (login, previous) => watchers?.loginChanged(login, previous),
        storedLogin: () => watchers?.storedLogin(),
        ...(this.deps.options.githubRetryBaseMs !== undefined ? { retryBaseMs: this.deps.options.githubRetryBaseMs } : {}),
        ...(this.deps.options.githubTimeoutMs !== undefined ? { timeoutMs: this.deps.options.githubTimeoutMs } : {}),
        ...(this.deps.options.githubThrottle === false ? { throttle: false } : {}),
        // The fetch guard lets a search name only these (D38).
        searchRepos: () => new Set(this.githubProjects().keys()),
      });
    }
    watchers = new Watchers({
      db: () => this.deps.db(),
      clock,
      access: this.githubAccess,
      emit: (event) => this.deps.emit(event),
      addCard: (card) => this.deps.addToTimeline(card),
      attention: (event) => this.deps.attention(event),
      digest: (key, line) => this.deps.digest.addGitHub(key, line),
      notice: (level, text, cause) => this.deps.notice(level, text, cause),
      nameFor: (owner, repo) => {
        const known = this.githubProjects().get(repoKey(owner, repo));
        if (known) return { repoName: known.repoName, repoId: known.repoId };
        // A row from before hosts were kept (until the next scan fills it in).
        const project = this.deps.db().listRepos().find((p) => p.host === undefined && p.owner?.toLowerCase() === owner.toLowerCase() && p.repo?.toLowerCase() === repo.toLowerCase());
        return project ? { repoName: project.name, repoId: project.id } : { repoName: `${owner}/${repo}` };
      },
      log: (line) => this.deps.log(line),
      ...(this.deps.options.watchJitter !== undefined ? { jitter: this.deps.options.watchJitter } : {}),
      ...(this.deps.options.watchTickMs !== undefined ? { tickMs: this.deps.options.watchTickMs } : {}),
    });
    this.watchers = watchers;
    const started = watchers;
    const canCallServerTool = (server: string, _tool: string, wireName: string): boolean => {
      if (this.deps.options.mcpClient || this.deps.options.mcpTransportFactory) return true;
      if (this.deps.integrations.mcpConfigStore?.hasDirectAuth(server)) return true;
      const fakeResults = (this.deps.options.runtime as { mcpResults?: Record<string, unknown> }).mcpResults;
      if (fakeResults !== undefined && Object.hasOwn(fakeResults, wireName)) return true;
      const catalog: Catalog = this.deps.integrations.catalog;
      const catServer = catalog.servers.find((s) => s.name === server);
      if (
        fakeResults === undefined &&
        (this.deps.runtimeStarted ? this.deps.runtimeStarted() : true) &&
        catServer &&
        isSeen(catalog, catServer) &&
        catServer.status === "connected"
      ) {
        return true;
      }
      return false;
    };
    this.trackerWatcher = new TrackerWatcher({
      db: () => this.deps.db(),
      tracker: () => this.deps.tracker(),
      clock,
      mcpClient: () => this.deps.integrations.mcpClient,
      catalog: () => this.deps.integrations.catalog,
      toolRules: () => this.deps.integrations.toolRules,
      mcpConfig: () => this.deps.integrations.mcpConfigStore?.getState() ?? EMPTY_MCP_CONFIG,
      canCallServerTool,
      addCard: (card) => this.deps.addToTimeline(card),
      attention: (event) => this.deps.attention(event),
      digest: (line) => this.deps.digest.add(line),
      onStateChanged: () => this.myWorkList?.trackerChanged(),
      log: (line) => this.deps.log(line),
      ...(this.deps.options.watchJitter !== undefined ? { jitter: this.deps.options.watchJitter } : {}),
    });
    this.outlookWatcher = new OutlookWatcher({
      db: () => this.deps.db(),
      tracker: () => this.deps.tracker(),
      clock,
      mcpClient: () => this.deps.integrations.mcpClient,
      catalog: () => this.deps.integrations.catalog,
      toolRules: () => this.deps.integrations.toolRules,
      mcpConfig: () => this.deps.integrations.mcpConfigStore?.getState() ?? EMPTY_MCP_CONFIG,
      attentionSettings: () => this.deps.attentionSettings?.() ?? { focusMode: false, awayMinutes: 15 },
      ...(this.deps.utilitySettings ? { utilitySettings: () => this.deps.utilitySettings!() } : {}),
      ...(this.deps.runUtilityTriage ? { runUtilityTriage: (req) => this.deps.runUtilityTriage!(req) } : {}),
      canCallServerTool,
      addCard: (card) => this.deps.addToTimeline(card),
      attention: (event) => this.deps.attention(event),
      digest: (line) => this.deps.digest.add(line),
      onStateChanged: () => this.myWorkList?.outlookChanged(),
      log: (line) => this.deps.log(line),
      ...(this.deps.options.watchJitter !== undefined ? { jitter: this.deps.options.watchJitter } : {}),
    });
    myWork = new MyWork({
      access: this.githubAccess,
      clock,
      projects: () => this.githubProjects(),
      prWatch: (owner, repo, number) => started.prWatch(owner, repo, number),
      tracker: () => this.trackerWatcher?.view(),
      refreshTracker: async (refresh) => {
        if (!this.trackerWatcher) return;
        await this.trackerWatcher.poll({ manual: refresh });
      },
      outlook: () => this.outlookWatcher?.view(),
      refreshOutlook: async (refresh) => {
        if (!this.outlookWatcher) return;
        await this.outlookWatcher.poll({ manual: refresh });
      },
      emit: (state) => this.deps.emit({ type: "my_work", myWork: state }),
    });
    this.myWorkList = myWork;
    watchers.start();
    this.trackerWatcher.start();
    this.outlookWatcher.start();
    if (this.githubAccess) this.startPullRequests(started);
  }

  /** Item 3: opening PRs. A test's GitHub pushes to its bare repositories, through a git config ARIA writes here. */
  private startPullRequests(watchers: Watchers): void {
    const github = this.deps.options.github;
    let testPush: { root: string; config: string } | undefined;
    if (github?.kind === "test" && github.pushRoot) {
      const config = path.join(this.deps.options.dataDir, "push-test.gitconfig");
      writeTestPushConfig(config, github.pushRoot);
      testPush = { root: github.pushRoot, config };
    }
    const cards = () => this.deps.db().listCards("pr_confirm");
    this.prs = new PullRequests({
      access: this.githubAccess,
      task: (taskId) => this.deps.tasks().forPr(taskId),
      project: (repoId) => this.deps.db().getRepo(repoId),
      card: (cardId) => {
        const item = this.deps.db().getTimelineItem(cardId);
        return item?.kind === "card" ? item : undefined;
      },
      cards,
      saveCard: (card) => this.deps.addToTimeline(card),
      setPr: (taskId, pr) => this.deps.tasks().setPr(taskId, pr),
      watchPr: async ({ owner, repo, number, repoId, repoName, taskId }) => {
        const outcome = await watchers.create({ kind: "pr", owner, repo, pr: number, repoId, repoName, until: "merged" }, "task", taskId);
        if (outcome.kind === "created" || outcome.kind === "merged") return { watchId: outcome.watch.id };
        return { note: outcome.kind === "refused" ? `Its checks aren't watched: ${outcome.reason}` : "Its checks aren't watched: it's closed already." };
      },
      digest: (key, line) => this.deps.digest.addGitHub(key, line),
      ...(testPush ? { testPush } : {}),
      // A test run pushes only to its bare repositories: without them, not at all (never to github.com).
      ...(github?.kind === "test" && !testPush ? { noPush: "This test run has nowhere to push to (no pushRoot)." } : {}),
      ghPath: () => findGh(process.env)[0],
      scratchRoot: path.join(this.deps.options.dataDir, "push"),
      log: (line) => this.deps.log(line),
    });
    this.prs.recover();
    // Item 4: Fix it and Address comments (D45–D53), with the same push setup for D53's fetch.
    this.fixes = new CiFixes({
      access: this.githubAccess,
      card: (cardId) => {
        const item = this.deps.db().getTimelineItem(cardId);
        return item?.kind === "card" ? item : undefined;
      },
      cards: () => this.deps.db().listCards("ci", "pr", "fix_proposal"),
      saveCard: (card) => this.deps.addToTimeline(card),
      watch: (watchId) => watchers.list().find((w) => w.id === watchId),
      projects: () => this.deps.db().listRepos(),
      tasks: {
        get: (taskId) => this.deps.tasks().get(taskId),
        all: () => this.deps.tasks().list(),
        ownerOf: (repoId, branch) => this.deps.tasks().ownerOf(repoId, branch),
        message: (taskId, text, steer, untrusted) => this.deps.tasks().message(taskId, text, steer, untrusted),
        start: (options) => this.deps.tasks().start(options),
        markFixing: (taskId, fixing, fromText) => this.deps.tasks().markFixing(taskId, fixing, fromText),
      },
      ciFixProfile: () => this.deps.profiles().ciFix(),
      profile: (id) => (id ? this.deps.profiles().get(id) : undefined),
      digest: (key, line) => this.deps.digest.addGitHub(key, line),
      ...(testPush ? { testPush } : {}),
      ...(github?.kind === "test" && !testPush ? { noPush: "This test run has nowhere to push to (no pushRoot)." } : {}),
      ghPath: () => findGh(process.env)[0],
      scratchRoot: path.join(this.deps.options.dataDir, "push"),
      log: (line) => this.deps.log(line),
    });
    const dispatchCards = () => this.deps.db().listCards("workflow_dispatch");
    this.dispatches = new WorkflowDispatches({
      access: this.githubAccess,
      resolveRepo: (ref) => this.githubRepoOf(ref),
      card: (cardId) => {
        const item = this.deps.db().getTimelineItem(cardId);
        return item?.kind === "card" ? item : undefined;
      },
      cards: dispatchCards,
      saveCard: (card) => this.deps.addToTimeline(card),
      watchNextRun: async ({ owner, repo, repoId, repoName, workflowFile, branch, afterRunId }) => {
        const outcome = await watchers.create(
          {
            kind: "run",
            owner,
            repo,
            ...(repoId !== undefined ? { repoId } : {}),
            repoName,
            workflow: workflowFile,
            branch,
            next: true,
            ...(afterRunId !== undefined ? { afterRunId } : {}),
          },
          "you",
        );
        if (outcome.kind === "created" || outcome.kind === "merged") return { watchId: outcome.watch.id };
        return { note: outcome.kind === "refused" ? outcome.reason : `The run ${outcome.status} already.` };
      },
      digest: (key, line) => this.deps.digest.addGitHub(key, line),
      ...(this.deps.options.shutdownWaitMs !== undefined ? { shutdownWaitMs: this.deps.options.shutdownWaitMs } : {}),
    });
    this.dispatches.markInterrupted();
  }

  get watch(): Watchers {
    if (!this.watchers) throw new Error("ARIA engine isn't started");
    return this.watchers;
  }

  /**
   * One of your projects' repositories on github.com, for a watch ARIA starts (by the project's name, or its
   * owner/repo): ARIA watches nothing else, so a mail or an issue can't make it follow a stranger's repository.
   */
  async githubRepoOf(ref: string): Promise<{ owner: string; repo: string; repoId: number; repoName: string; defaultBranch?: string }> {
    const projects = this.deps.db().listRepos().filter((p) => !p.hidden);
    const slash = /^\s*([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\s*$/.exec(ref);
    const project = slash ? projects.find((p) => p.owner?.toLowerCase() === slash[1]!.toLowerCase() && p.repo?.toLowerCase() === slash[2]!.toLowerCase()) : undefined;
    if (slash && !project) throw new Error(`${ref.trim()} isn't the repository of one of the user's projects: ARIA only watches the projects in list_repos.`);
    return this.githubRepoOfProject(project ?? this.deps.resolveProject(ref));
  }

  /** A project's origin on github.com (its host read again when an old row has none). */
  private async githubRepoOfProject(found: Project): Promise<{ owner: string; repo: string; repoId: number; repoName: string; defaultBranch?: string }> {
    let project = found;
    if (!project.owner || !project.repo) throw new Error(`${project.name} has no GitHub remote, so there's nothing on GitHub to watch.`);
    let host = project.host;
    if (!host) {
      // A row from before hosts were kept: read its remote again.
      const info = await readRepoInfo(project.path).catch(() => undefined);
      if (info) {
        project = this.deps.saveRepo(info, project.addedVia);
        host = info.host;
      }
    }
    if (host !== "github.com" || !project.owner || !project.repo) throw new Error(`${project.name}'s remote is on ${host ?? "a host ARIA can't tell"}, not github.com: only github.com is watched in this version.`);
    return { owner: project.owner, repo: project.repo, repoId: project.id, repoName: project.name, ...(project.defaultBranch ? { defaultBranch: project.defaultBranch } : {}) };
  }

  watchToolDeps(): WatchToolDeps {
    return {
      watch: async (input) => {
        const repo = await this.githubRepoOf(input.repo);
        return this.watch.create(
          {
            kind: input.what,
            ...repo,
            ...(input.runId !== undefined ? { runId: input.runId } : {}),
            ...(input.workflow !== undefined ? { workflow: input.workflow } : {}),
            ...(input.runNumber !== undefined ? { runNumber: input.runNumber } : {}),
            ...(input.branch !== undefined ? { branch: input.branch } : {}),
            ...(input.next !== undefined ? { next: input.next } : {}),
            ...(input.pr !== undefined ? { pr: input.pr } : {}),
            ...(input.until !== undefined ? { until: input.until } : {}),
            ...(input.hours !== undefined ? { hours: input.hours } : {}),
          },
          "aria",
        );
      },
      list: () => this.watch.list(),
      github: () => this.watch.githubState(),
      unwatch: (ref) => {
        const found = this.watch.find(ref);
        if (!found) throw new Error(`There's no watch matching "${ref}": list_watches has them.`);
        const ended = this.watch.end(found.id, "aria");
        // A watch ARIA didn't start (yours, the inbox, a task's) stopped by ARIA is said in the chat, so it's never silent.
        if (found.createdBy !== "aria") this.deps.notice("info", `ARIA stopped watching ${found.shortId}: ${found.kind === "inbox" ? "your GitHub inbox" : `${found.title}${found.repoName ? ` (${found.repoName})` : ""}`}.`, "watch_stopped");
        return ended;
      },
      forAria: (watch) => this.watch.forAria(watch),
      // Item 4, D48: only a card; the user's Start does it.
      ...(this.fixes
        ? {
            proposeFix: async (kind: "ci" | "review", ref: string) => {
              const found = this.watch.find(ref);
              if (!found) throw new Error(`There's no watch matching "${ref}": list_watches has them.`);
              const card = await this.fixes!.propose(kind, found);
              const plan = card.payload.plan;
              const goesTo = plan.how === "continue" ? `continues the task "${plan.taskTitle}"` : plan.how === "adopt" ? `a new task on "${plan.taskTitle}"'s branch` : `a new task on a new branch from ${plan.branch}`;
              // In ARIA's own words: a workflow's or a reviewer's text (the card's target) stays in the window.
              return { card: card.id, target: `${kind === "ci" ? "the newest red CI card" : "the newest review asking for changes"} of ${found.shortId}`, goesTo };
            },
          }
        : {}),
      ...(this.dispatches
        ? {
            dispatchWorkflow: async (input) => {
              const card = await this.dispatches!.propose(input);
              return {
                shortId: card.payload.shortId,
                cardId: card.id,
                repoName: card.payload.repoName,
                workflowName: card.payload.workflowName,
                workflowPath: card.payload.workflowPath,
                ref: card.payload.ref,
                inputs: card.payload.inputs,
              };
            },
          }
        : {}),
      ...(this.githubAccess
        ? {
            proposeAccountSwitch: (input) => this.proposeAccountSwitch(input),
          }
        : {}),
    };
  }

  /**
   * Proposes switching GitHub CLI's active account (`gh auth switch --user <user>`) on a `github_account` card in the
   * chat. Nothing runs until the user clicks the button on the card.
   */
  proposeAccountSwitch(input: { user: string; note?: string }): { cardId: string; from?: string; to: string } {
    if (!this.githubAccess) throw new Error("GitHub isn't set up in this run of ARIA.");
    const to = asLogin(input.user.trim().replace(/^@/, ""));
    if (!to) throw new Error("Give a valid GitHub username (for example 'octocat-work').");
    const note = input.note !== undefined ? cleanText(input.note).trim().slice(0, 600) : undefined;
    const from = this.githubAccess.login;
    const cardId = `github-account-${randomUUID()}`;
    const card: Extract<CardItem, { cardType: "github_account" }> = {
      kind: "card",
      id: cardId,
      cardType: "github_account",
      payload: {
        ...(from ? { from } : {}),
        to,
        watchIds: [],
        requested: true,
        status: "pending",
        ...(note ? { note } : {}),
      },
      createdAt: Date.now(),
    };
    this.deps.addToTimeline(card);
    return { cardId, ...(from ? { from } : {}), to };
  }

  /** Your click on Run workflow on a `workflow_dispatch` card. */
  async confirmWorkflowDispatch(input: { cardId: string; revision: number; ref?: string; inputs?: Record<string, string> }): Promise<void> {
    if (!this.dispatches) throw new Error("GitHub isn't set up in this run of ARIA.");
    await this.dispatches.confirm(input);
  }

  /** Your click on Cancel on a `workflow_dispatch` card. */
  dismissWorkflowDispatch(cardId: string): void {
    if (!this.dispatches) throw new Error("GitHub isn't set up in this run of ARIA.");
    this.dispatches.dismiss(cardId);
  }

  /** Stop watching, from the window. */
  unwatch(watchId: number): void {
    const watch = this.watch.end(watchId, "you");
    this.deps.digest.addGitHub(`${watchId}:watch`, `[watch] You stopped watching ${watch.kind === "inbox" ? "the GitHub inbox" : digestText(watch.title, 80)}${watch.repoName ? ` on ${watch.repoName}` : ""} (${watch.shortId}).`);
  }

  async retryGitHub(): Promise<GitHubState> {
    await this.githubAccess?.retry();
    return this.watch.githubState();
  }

  /** The inbox's own Try again (it waits an hour after 403s: gh's token couldn't read notifications). */
  retryInbox(): void {
    this.watch.retryInbox();
  }

  async setInboxWatch(on: boolean): Promise<GitHubState> {
    await this.watch.setInbox(on);
    this.deps.digest.addGitHub("inbox-switch", `[watch] You turned the GitHub inbox watch ${on ? "on" : "off"}.`);
    return this.watch.githubState();
  }

  /** "Use @new for them" on a github_account card. */
  useGitHubAccount(cardId: string): void {
    const card = this.deps.db().getTimelineItem(cardId);
    if (!card || card.kind !== "card" || card.cardType !== "github_account") throw new Error("That card doesn't exist anymore.");
    if (card.payload.rebound) return;
    if (this.githubAccess?.login !== card.payload.to) throw new Error(`GitHub CLI doesn't use @${card.payload.to} anymore, so the watches can't go on as that account.`);
    const count = this.watch.rebind(card.payload.watchIds);
    this.deps.addToTimeline({ ...card, payload: { ...card.payload, rebound: true }, updatedAt: Date.now() });
    this.deps.digest.addGitHub("account", `[github] You let ${count} paused watch${count === 1 ? "" : "es"} go on as @${card.payload.to}.`);
  }

  /**
   * Your click on Switch to @user (or Switch back to @from) on a `github_account` card: runs `gh auth switch --user …`
   * and refreshes ARIA's GitHub access.
   */
  async switchGitHubAccount(cardId: string): Promise<void> {
    if (!this.githubAccess) throw new Error("GitHub isn't set up in this run of ARIA.");
    const card = this.deps.db().getTimelineItem(cardId);
    if (!card || card.kind !== "card" || card.cardType !== "github_account") throw new Error("That card doesn't exist anymore.");
    if (card.payload.status === "switching") throw new Error("GitHub CLI is already switching accounts.");
    const target = card.payload.requested ? card.payload.to : card.payload.from;
    if (!target) throw new Error("That card doesn't name an account to switch to.");

    const switchingPayload = { ...card.payload, status: "switching" as const };
    delete switchingPayload.error;
    this.deps.addToTimeline({ ...card, payload: switchingPayload, updatedAt: Date.now() });

    try {
      await this.githubAccess.switchAccount(target);
      const donePayload = { ...card.payload, status: "done" as const };
      delete donePayload.error;
      this.deps.addToTimeline({ ...card, payload: donePayload, updatedAt: Date.now() });
      this.deps.digest.addGitHub("account", `[github] You switched GitHub CLI to @${target}.`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.deps.addToTimeline({
        ...card,
        payload: { ...card.payload, status: "failed", error: errMsg },
        updatedAt: Date.now(),
      });
      throw error;
    }
  }

  /**
   * Default-branch health of a project, on (yours only; the project menu). By the project's id, never its name (folder
   * names aren't unique). Off is `unwatch` with that watch's id.
   */
  async watchDefaultBranch(repoId: number): Promise<Watch> {
    const project = this.deps.db().getRepo(repoId);
    if (!project || project.hidden) throw new Error("That project doesn't exist anymore.");
    const repo = await this.githubRepoOfProject(project);
    const outcome = await this.watch.watchBranch({ kind: "branch", ...repo });
    if (outcome.kind === "refused") throw new Error(outcome.reason);
    if (outcome.kind === "finished") throw new Error("That branch can't be watched.");
    return outcome.watch;
  }

  /** My work's list (PLAN.md §5.2, D38–D40); the window asks while it's open. */
  async myWork(refresh: boolean): Promise<MyWorkState> {
    const myWork = this.myWorkList;
    if (!myWork) return { status: "off", items: [], more: { review_requested: 0, authored: 0, assigned: 0 } };
    return myWork.get(refresh);
  }

  /**
   * Watch a pull request from My work, until it's merged: yours, and only one of My work's own items (by its key, a
   * lookup: the window can't name a repository). A click again while it starts gets the same watch.
   */
  watchPullRequest(key: string): Promise<Watch> {
    const pending = this.watchingPr.get(key);
    if (pending) return pending;
    const run = (async () => {
      const item = this.myWorkList?.item(key);
      if (!item || item.kind !== "pr") throw new Error("That pull request isn't in My work anymore: refresh it.");
      const outcome = await this.watch.create({ kind: "pr", owner: item.owner, repo: item.repo, pr: item.number, repoId: item.repoId, repoName: item.repoName, until: "merged" }, "you");
      if (outcome.kind === "refused") throw new Error(outcome.reason);
      if (outcome.kind === "finished") throw new Error(`It's ${outcome.status} already.`);
      // The list shows its watch.
      this.deps.emit({ type: "my_work", myWork: this.myWorkList!.view() });
      return outcome.watch;
    })().finally(() => this.watchingPr.delete(key));
    this.watchingPr.set(key, run);
    return run;
  }
}
