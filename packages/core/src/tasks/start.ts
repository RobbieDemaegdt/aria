import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CardItem, Profile, Project, ProposalCardPayload, Task, TaskLocation, TaskMode, TimelineItem } from "@aria/protocol";
import { namesPath } from "../policy/sandbox.ts";
import type { Store } from "../store/store.ts";
import type { TaskTracker } from "../trackers/types.ts";
import type { TaskManager } from "./manager.ts";
import type { Profiles } from "./profiles.ts";

export interface TaskStartsDeps {
  db: () => Store;
  tracker: () => TaskTracker;
  profiles: () => Profiles;
  tasks: () => TaskManager;
  addToTimeline: (item: TimelineItem) => void;
  digest: (line: string) => void;
  yourPaths: (text: string) => string[];
  chatProject?: () => Project;
}

/** Starting tasks: one you start yourself, and one ARIA proposes, from its card to your Start or Dismiss. */
export class TaskStarts {
  /** Proposals being started, so a second click doesn't start the task twice. */
  private readonly startingProposals = new Set<string>();

  constructor(private readonly deps: TaskStartsDeps) {}

  private resolveProjectById(repoId: number): Project | undefined {
    if (repoId === 0) return this.deps.chatProject?.();
    return this.deps.db().getRepo(repoId);
  }

  /** A task you start yourself (New session or "Rerun with…"): your profile choice is used as is. */
  async startTask(input: {
    repoId: number;
    brief: string;
    title?: string | undefined;
    profileId?: string | undefined;
    agent?: string | undefined;
    mode?: TaskMode | undefined;
    baseBranch?: string | undefined;
    trackerTaskId?: string | undefined;
    rerunOf?: string | undefined;
    where?: TaskLocation | undefined;
    remote?: boolean | undefined;
    allowedPaths?: string[] | undefined;
    extraContext?: string | undefined;
    files?: string[] | undefined;
  }): Promise<Task> {
    const project = this.resolveProjectById(input.repoId);
    if (!project) throw new Error("That project doesn't exist anymore.");
    const { profile } = this.deps.profiles().forTask({ ...(input.profileId ? { requested: input.profileId } : {}), startedBy: "you" });
    const effectiveMode: TaskMode | undefined = input.mode ?? (project.id === 0 ? "interactive" : undefined);
    let rerunOf: string | undefined;
    let baseCommit: string | undefined;
    let baseBranch = input.baseBranch?.trim() || undefined;
    let sourceTitle: string | undefined;
    let sourceAgent: string | undefined;
    // A rerun keeps what it could read; only a path you added to the brief is new (the rest of it may be ARIA's words).
    let sourceBrief = "";
    let sourcePaths: string[] = [];
    let sourceExtraContext: string | undefined;
    let sourceFiles: string[] = [];
    if (input.rerunOf) {
      const source = this.deps.db().getTask(input.rerunOf);
      if (!source || source.archived || source.repoId !== project.id) {
        throw new Error("The task to rerun wasn't found in this project.");
      }
      if (
        source.state !== "done" &&
        source.state !== "failed" &&
        source.state !== "cancelled" &&
        source.state !== "interrupted"
      ) {
        throw new Error("Only finished, failed, cancelled or interrupted tasks can be rerun.");
      }
      rerunOf = source.rerunOf ?? source.id;
      sourceTitle = source.title;
      sourceAgent = source.agent;
      sourceBrief = source.brief;
      sourcePaths = source.allowedPaths ?? [];
      sourceExtraContext = source.extraContext;
      sourceFiles = source.files ?? [];
      if (!baseBranch || baseBranch === source.baseBranch) {
        baseBranch = source.baseBranch;
        baseCommit = source.baseCommit;
      }
    }
    const effectiveAgent = input.agent?.trim() || profile.agent?.trim() || sourceAgent;
    const extraContext = input.extraContext !== undefined ? input.extraContext : sourceExtraContext;
    const files = input.files !== undefined ? input.files : (sourceFiles.length ? sourceFiles : undefined);
    const extraContextPaths = extraContext ? this.deps.yourPaths(extraContext) : [];
    const filePaths = (files ?? []).filter((p) => path.isAbsolute(p));
    const allowedPaths = [
      ...(input.allowedPaths ?? []),
      ...filePaths,
      ...sourcePaths,
      ...this.deps.yourPaths(input.brief).filter((p) => !namesPath(sourceBrief, p)),
      ...extraContextPaths,
    ];
    const task = await this.deps.tasks().start({
      project,
      brief: input.brief,
      ...(input.title ? { title: input.title } : {}),
      profile,
      ...(effectiveAgent ? { agent: effectiveAgent } : {}),
      ...(effectiveMode ? { mode: effectiveMode } : {}),
      ...(baseBranch ? { baseBranch } : {}),
      ...(baseCommit ? { baseCommit } : {}),
      ...(rerunOf ? { rerunOf } : {}),
      ...(input.trackerTaskId ? { trackerTaskId: input.trackerTaskId } : {}),
      ...(input.where ? { where: input.where } : {}),
      ...(input.remote !== undefined ? { remote: input.remote } : {}),
      ...(allowedPaths.length ? { allowedPaths } : {}),
      ...(extraContext?.trim() ? { extraContext: extraContext.trim() } : {}),
      ...(files?.length ? { files } : {}),
      startedBy: "you",
    });
    if (rerunOf) {
      this.deps.digest(
        `You reran "${sourceTitle ?? task.title}" (${task.repoName}) in a fresh worktree with the ${task.profileName} profile.`,
      );
    } else {
      this.deps.digest(`You started "${task.title}" (${task.repoName}) yourself, with the ${task.profileName} profile.`);
    }
    return task;
  }

  /** A task ARIA proposes under the "ask" profile policy: a card with Start, Change profile and Dismiss. */
  propose(
    project: Project,
    input: {
      title: string;
      brief: string;
      agent?: string | undefined;
      reason?: string | undefined;
      mode?: TaskMode | undefined;
      base?: string | undefined;
      trackerTaskId?: string | undefined;
      where?: TaskLocation | undefined;
      remote?: boolean | undefined;
      allowedPaths?: string[] | undefined;
    },
    profile: Profile,
  ): ProposalCardPayload {
    let trackerTaskId: string | undefined;
    if (input.trackerTaskId !== undefined && input.trackerTaskId.trim() !== "") {
      trackerTaskId = this.deps.tracker().parseTaskRef(input.trackerTaskId);
      if (!trackerTaskId) {
        throw new Error(this.deps.tracker().messages.invalidTaskRef(input.trackerTaskId.trim()));
      }
    }
    const agent = input.agent?.trim() || profile.agent?.trim();
    const payload: ProposalCardPayload = {
      repoId: project.id,
      repoName: project.name,
      title: input.title.trim(),
      brief: input.brief.trim(),
      profileId: profile.id,
      profileName: profile.name,
      model: profile.model,
      ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
      ...(agent ? { agent } : {}),
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.base ? { baseBranch: input.base } : {}),
      ...(trackerTaskId ? { trackerTaskId } : {}),
      ...(input.where ? { where: input.where } : {}),
      ...(input.remote ? { remote: true } : {}),
      ...(input.allowedPaths?.length ? { allowedPaths: input.allowedPaths } : {}),
    };
    this.deps.addToTimeline({ kind: "card", id: `proposal-${randomUUID()}`, cardType: "profile_proposal", payload, createdAt: Date.now() });
    return payload;
  }

  private proposalCard(cardId: string): Extract<CardItem, { cardType: "profile_proposal" }> {
    const card = this.deps.db().getTimelineItem(cardId);
    if (!card || card.kind !== "card" || card.cardType !== "profile_proposal") throw new Error("That proposal doesn't exist anymore.");
    if (card.payload.decision === "started") throw new Error("That task was already started.");
    if (card.payload.decision === "dismissed") throw new Error("That proposal was dismissed.");
    return card;
  }

  /** You pressed Start on a proposal, with its profile or another one (and optional agent) you picked. */
  async startProposal(cardId: string, profileId?: string, agent?: string | null): Promise<Task> {
    const card = this.proposalCard(cardId);
    if (this.startingProposals.has(cardId)) throw new Error("That task is already starting.");
    const { payload } = card;
    const project = this.resolveProjectById(payload.repoId);
    if (!project) throw new Error("That project doesn't exist anymore.");
    const profile = this.deps.profiles().get(profileId ?? payload.profileId);
    if (!profile) throw new Error("That profile doesn't exist anymore. Pick another one.");
    this.startingProposals.add(cardId);
    try {
      const picked = profile.id !== payload.profileId;
      const effectiveAgent =
        agent !== undefined
          ? agent?.trim() || undefined
          : picked
            ? profile.agent?.trim() || payload.agent
            : payload.agent;
      const task = await this.deps.tasks().start({
        project,
        brief: payload.brief,
        title: payload.title,
        profile,
        ...(effectiveAgent ? { agent: effectiveAgent } : {}),
        profileNote: picked ? `You picked ${profile.name}.` : (payload.reason ?? `ARIA proposed ${profile.name}.`),
        ...(payload.mode ? { mode: payload.mode } : {}),
        ...(payload.baseBranch ? { baseBranch: payload.baseBranch } : {}),
        ...(payload.trackerTaskId ? { trackerTaskId: payload.trackerTaskId } : {}),
        ...(payload.where ? { where: payload.where } : {}),
        ...(payload.remote ? { remote: payload.remote } : {}),
        ...(payload.allowedPaths?.length ? { allowedPaths: payload.allowedPaths } : {}),
        startedBy: "aria",
      });
      const { reasoningEffort: _effort, agent: _oldAgent, ...rest } = payload;
      this.deps.addToTimeline({
        ...card,
        payload: {
          ...rest,
          profileId: profile.id,
          profileName: profile.name,
          model: profile.model,
          ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
          ...(effectiveAgent ? { agent: effectiveAgent } : {}),
          decision: "started",
          taskId: task.id,
        },
        updatedAt: Date.now(),
      });
      this.deps.digest(`You started the task ARIA proposed, "${task.title}" (${task.repoName}), with the ${profile.name} profile.`);
      return task;
    } finally {
      this.startingProposals.delete(cardId);
    }
  }

  dismissProposal(cardId: string): void {
    const card = this.proposalCard(cardId);
    if (this.startingProposals.has(cardId)) throw new Error("That task is already starting.");
    this.deps.addToTimeline({ ...card, payload: { ...card.payload, decision: "dismissed" }, updatedAt: Date.now() });
    this.deps.digest(`You dismissed the task ARIA proposed, "${card.payload.title}" (${card.payload.repoName}).`);
  }
}
