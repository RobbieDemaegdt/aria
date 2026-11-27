/**
 * Triggering a GitHub Actions workflow (`workflow_dispatch`) from the chat:
 * - ARIA's `run_workflow` tool only proposes a `workflow_dispatch` card (`WD-n`) in the chat (D19, D22).
 * - Nothing is sent to GitHub until you click "Run workflow" on the card.
 * - On your click, plain code snapshots the newest run ID (`afterRunId`), sends one guarded POST to
 *   `/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` via `dispatchWorkflow` (0 model calls),
 *   and automatically starts or merges a `run` watch (`next: true`) so a CI card reports when the run finishes.
 */
import { randomUUID } from "node:crypto";
import type { CardItem } from "@aria/protocol";
import type { GitHubAccess } from "../github/access.ts";
import { GitHubFailure } from "../github/client.ts";
import { digestText, githubText, id as asId, links, validName } from "../github/text.ts";
import { dispatchWorkflow } from "../github/write.ts";
import { DISGUISE_CHARS } from "../integrations/actions.ts";
import { cleanText } from "../tasks/pr.ts";
import { within } from "../tasks/manager.ts";
import { ownRun, runsFrom } from "./run.ts";
import { onlyWaitedFor } from "../util/ignore.ts";

export type WorkflowDispatchCard = Extract<CardItem, { cardType: "workflow_dispatch" }>;

export const MAX_WORKFLOW_INPUTS = 10;
export const MAX_INPUT_KEY = 100;
export const MAX_INPUT_VALUE = 1_000;
const MAX_NOTE = 600;
const BRANCH_REF = /^(?!-)(?!.*\.\.)[^\s~^:?*[\\\p{Cc}\p{Cf}]{1,250}$/u;
const INPUT_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/;

export function validateWorkflowInputs(raw: Record<string, unknown> | undefined): Record<string, string> {
  if (!raw) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Workflow inputs must be a plain key-value object.");
  }
  const entries = Object.entries(raw).filter(([, v]) => v !== undefined);
  if (entries.length > MAX_WORKFLOW_INPUTS) {
    throw new Error(`GitHub workflow_dispatch accepts at most ${MAX_WORKFLOW_INPUTS} inputs (${entries.length} given).`);
  }
  const out: Record<string, string> = {};
  for (const [key, val] of entries) {
    const k = key.trim();
    if (!INPUT_KEY.test(k) || DISGUISE_CHARS.test(k)) {
      throw new Error(`Invalid workflow input name "${githubText(key, 60)}".`);
    }
    if (typeof val !== "string" && typeof val !== "number" && typeof val !== "boolean") {
      throw new Error(`Workflow input "${k}" must be a string, number, or boolean.`);
    }
    if (typeof val === "number" && !Number.isFinite(val)) {
      throw new Error(`Workflow input "${k}" must be a finite number.`);
    }
    const str = String(val);
    if (DISGUISE_CHARS.test(str)) {
      throw new Error(`Workflow input "${k}" contains invisible or control characters.`);
    }
    if (str.length > MAX_INPUT_VALUE) {
      throw new Error(`Workflow input "${k}" is longer than ${MAX_INPUT_VALUE} characters.`);
    }
    out[k] = str;
  }
  return out;
}

export function validateWorkflowRef(raw: string): string {
  const ref = raw.trim();
  if (!BRANCH_REF.test(ref) || DISGUISE_CHARS.test(ref)) {
    throw new Error("Give a valid branch or tag name (no spaces, control characters, or '..').");
  }
  return ref;
}

export interface WorkflowDispatchRepo {
  owner: string;
  repo: string;
  repoId?: number;
  repoName: string;
  defaultBranch?: string;
}

export interface WorkflowDispatchesDeps {
  access: GitHubAccess | undefined;
  resolveRepo(ref: string): Promise<WorkflowDispatchRepo>;
  card(cardId: string): CardItem | undefined;
  cards(): WorkflowDispatchCard[];
  saveCard(card: WorkflowDispatchCard): void;
  watchNextRun(input: {
    owner: string;
    repo: string;
    repoId?: number;
    repoName: string;
    workflowId: number;
    workflowFile: string;
    branch: string;
    afterRunId?: number;
  }): Promise<{ watchId?: number; note?: string }>;
  digest(key: string, line: string): void;
  shutdownWaitMs?: number;
}

interface GitHubWorkflowEntry {
  id: number;
  name: string;
  path: string;
  state: string;
}

function parseWorkflows(data: unknown): GitHubWorkflowEntry[] {
  const list = (data as { workflows?: unknown } | null)?.workflows;
  if (!Array.isArray(list)) return [];
  const out: GitHubWorkflowEntry[] = [];
  for (const item of list as Array<Record<string, unknown>>) {
    const id = asId(item?.id);
    const name = typeof item?.name === "string" ? githubText(item.name, 120) : "";
    const path = typeof item?.path === "string" ? githubText(item.path, 250) : "";
    const state = typeof item?.state === "string" ? githubText(item.state, 40) : "active";
    if (id && path) {
      out.push({ id, name: name || path.split("/").pop() || `workflow ${id}`, path, state });
    }
  }
  return out;
}

function matchWorkflow(workflows: GitHubWorkflowEntry[], query: string): GitHubWorkflowEntry | undefined {
  const q = query.trim();
  const qLower = q.toLowerCase();
  const asNum = /^\d+$/.test(q) ? Number(q) : undefined;
  if (asNum !== undefined) {
    const byId = workflows.find((w) => w.id === asNum);
    if (byId) return byId;
  }
  const exactPath = workflows.find((w) => w.path.toLowerCase() === qLower);
  if (exactPath) return exactPath;
  const exactFile = workflows.find((w) => w.path.split("/").pop()?.toLowerCase() === qLower);
  if (exactFile) return exactFile;
  const exactName = workflows.find((w) => w.name.toLowerCase() === qLower);
  if (exactName) return exactName;
  const partial = workflows.filter(
    (w) => w.name.toLowerCase().includes(qLower) || (w.path.split("/").pop()?.toLowerCase().includes(qLower) ?? false),
  );
  if (partial.length === 1) return partial[0];
  return undefined;
}

export class WorkflowDispatches {
  private nextNumber = 1;
  private stopped = false;
  private readonly inFlight = new Map<string, { abort: AbortController; done: Promise<void> }>();

  constructor(private readonly deps: WorkflowDispatchesDeps) {}

  private get access(): GitHubAccess {
    if (!this.deps.access) throw new Error("GitHub isn't set up in this run of ARIA.");
    return this.deps.access;
  }

  /**
   * Startup recovery: any workflow dispatch card that was `"dispatching"` when ARIA closed is marked `"failed"` so
   * you can check GitHub Actions before retrying, and `nextNumber` continues past existing `WD-n` cards.
   */
  markInterrupted(): void {
    let highest = 0;
    for (const card of this.deps.cards()) {
      const m = /^WD-(\d+)$/.exec(card.payload.shortId);
      if (m) highest = Math.max(highest, Number(m[1]));
      if (card.payload.status === "dispatching") {
        this.deps.saveCard({
          ...card,
          payload: {
            ...card.payload,
            status: "failed",
            revision: card.payload.revision + 1,
            error: "ARIA closed while this workflow was being triggered. Check GitHub Actions before trying again.",
          },
          updatedAt: Date.now(),
        });
      }
    }
    this.nextNumber = highest + 1;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const running = [...this.inFlight.values()];
    for (const item of running) item.abort.abort();
    if (running.length > 0) {
      await within(this.deps.shutdownWaitMs ?? 5_000, () => Promise.all(running.map((r) => r.done)));
    }
  }

  pendingItems(): Array<{ shortId: string; cardId: string; repoName: string; workflowName: string; ref: string }> {
    return this.deps
      .cards()
      .filter((c) => c.payload.status === "pending")
      .map((c) => ({
        shortId: c.payload.shortId,
        cardId: c.id,
        repoName: c.payload.repoName,
        workflowName: c.payload.workflowName,
        ref: c.payload.ref,
      }));
  }

  /** Proposes triggering a workflow on a confirmation card (`WD-n`). Never dispatches the workflow itself. */
  async propose(input: {
    repo: string;
    workflow: string;
    ref?: string;
    inputs?: Record<string, unknown>;
    note?: string;
  }): Promise<WorkflowDispatchCard> {
    if (this.stopped) throw new Error("ARIA is stopping.");
    const access = this.access;
    if (!(await access.ensure()) || !access.ready() || !access.login) {
      throw new Error(`GitHub can't be read right now: ${access.view().message ?? "it isn't available"}`);
    }
    const login = access.login;
    const repoInfo = await this.deps.resolveRepo(input.repo);
    const { owner, repo, repoId, repoName } = repoInfo;
    if (!validName(owner) || !validName(repo)) {
      throw new Error("That isn't a GitHub repository ARIA can trigger workflows on.");
    }

    const inputs = validateWorkflowInputs(input.inputs);
    const note = input.note !== undefined ? cleanText(input.note).trim().slice(0, MAX_NOTE) : undefined;

    const listed = await access.get("GET /repos/{owner}/{repo}/actions/workflows", { owner, repo, per_page: 100 }, {});
    const workflows = listed.status === 200 ? parseWorkflows(listed.data) : [];
    const matched = matchWorkflow(workflows, input.workflow);
    if (!matched) {
      const available = workflows
        .filter((w) => !w.path.startsWith("dynamic/") && /\.ya?ml$/i.test(w.path))
        .slice(0, 10)
        .map((w) => `${digestText(w.name, 60)} (${w.path.split("/").pop()})`);
      throw new Error(
        `There's no workflow matching ${digestText(input.workflow, 60)} in ${owner}/${repo}.${available.length ? ` Available workflows: ${available.join(", ")}.` : ""}`,
      );
    }
    if (matched.path.startsWith("dynamic/") || !/\.ya?ml$/i.test(matched.path)) {
      throw new Error(
        `${digestText(matched.name, 80)} (${matched.path}) is a dynamic GitHub workflow and cannot be triggered with workflow_dispatch.`,
      );
    }
    if (matched.state === "disabled_manually" || matched.state === "disabled_inactivity") {
      throw new Error(`${digestText(matched.name, 80)} is disabled on GitHub.`);
    }

    let ref: string;
    if (input.ref !== undefined && input.ref.trim() !== "") {
      ref = validateWorkflowRef(input.ref);
    } else if (repoInfo.defaultBranch) {
      ref = validateWorkflowRef(repoInfo.defaultBranch);
    } else {
      const info = await access.get("GET /repos/{owner}/{repo}", { owner, repo }, {});
      const defaultBranch = info.status === 200 ? (info.data as { default_branch?: unknown } | null)?.default_branch : undefined;
      if (typeof defaultBranch !== "string" || !defaultBranch.trim()) {
        throw new Error(`ARIA couldn't find ${owner}/${repo}'s default branch: pass ref explicitly.`);
      }
      ref = validateWorkflowRef(defaultBranch);
    }

    // Verify the branch exists on GitHub before offering the card (when it's a branch; tags or SHAs may 404 on /branches).
    try {
      await access.get("GET /repos/{owner}/{repo}/branches/{branch}", { owner, repo, branch: encodeURIComponent(ref) }, {});
    } catch (error) {
      if (error instanceof GitHubFailure && error.type === "not_found") {
        throw new Error(`GitHub doesn't have a branch called ${digestText(ref, 80)} in ${owner}/${repo}.`, { cause: error });
      }
      throw error;
    }

    const workflowFile = matched.path.split("/").pop() ?? `${matched.id}`;
    const shortId = `WD-${this.nextNumber++}`;
    const card: WorkflowDispatchCard = {
      kind: "card",
      id: `workflow-dispatch-${randomUUID()}`,
      cardType: "workflow_dispatch",
      payload: {
        shortId,
        ...(repoId !== undefined ? { repoId } : {}),
        repoName,
        owner,
        repo,
        workflowId: matched.id,
        workflowName: matched.name,
        workflowPath: matched.path,
        ref,
        inputs,
        login,
        ...(note ? { note } : {}),
        status: "pending",
        revision: 1,
        url: links.workflow(owner, repo, workflowFile),
      },
      createdAt: Date.now(),
    };
    this.deps.saveCard(card);
    return card;
  }

  /** Your click on "Run workflow" on a `workflow_dispatch` card. */
  async confirm(input: {
    cardId: string;
    revision: number;
    ref?: string;
    inputs?: Record<string, string>;
  }): Promise<void> {
    if (this.stopped) throw new Error("ARIA is stopping.");
    const item = this.deps.card(input.cardId);
    if (!item || item.kind !== "card" || item.cardType !== "workflow_dispatch") {
      throw new Error("That workflow card doesn't exist anymore.");
    }
    const card = item as WorkflowDispatchCard;
    if (card.payload.status === "dispatching" || this.inFlight.has(card.id)) {
      throw new Error("That workflow is already being triggered.");
    }
    if (card.payload.status === "done") {
      throw new Error("That workflow card was already triggered.");
    }
    if (card.payload.status === "cancelled") {
      throw new Error("That workflow card was cancelled.");
    }
    if (card.payload.revision !== input.revision) {
      throw new Error("That card changed since you looked at it. Check the settings and try again.");
    }

    const access = this.access;
    if (!(await access.ensure()) || !access.ready() || !access.login) {
      throw new Error(`GitHub can't be reached right now: ${access.view().message ?? "it isn't available"}`);
    }

    const nextRef = input.ref !== undefined ? validateWorkflowRef(input.ref) : card.payload.ref;
    const nextInputs = input.inputs !== undefined ? validateWorkflowInputs(input.inputs) : card.payload.inputs;
    const edited =
      card.payload.edited === true ||
      nextRef !== card.payload.ref ||
      JSON.stringify(nextInputs) !== JSON.stringify(card.payload.inputs);

    // Flip synchronously to "dispatching" before the network call so a double click is refused.
    const dispatchingCard: WorkflowDispatchCard = {
      ...card,
      payload: {
        ...card.payload,
        ref: nextRef,
        inputs: nextInputs,
        login: access.login,
        ...(edited ? { edited: true } : {}),
        status: "dispatching",
        revision: card.payload.revision + 1,
      },
      updatedAt: Date.now(),
    };
    delete dispatchingCard.payload.error;
    this.deps.saveCard(dispatchingCard);

    const abort = new AbortController();
    const { owner, repo, repoId, repoName, workflowId, workflowName, workflowPath } = dispatchingCard.payload;
    const workflowFile = workflowPath.split("/").pop() ?? String(workflowId);

    const run = (async () => {
      try {
        // Snapshot the latest run ID before dispatching so the auto-watch never misses a fast-starting run. Left out when
        // it can't be read, because counting from 0 would report an older run as this one's: watchers.create reads the
        // current runs instead. A run fast enough to be among them then goes unwatched, which beats a wrong result.
        let afterRunId: number | undefined;
        try {
          const runsRes = await access.get(
            "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
            { owner, repo, workflow_id: workflowId, branch: nextRef, per_page: 20 },
            {},
            abort.signal,
          );
          if (runsRes.status === 200) {
            const existingRuns = runsFrom(runsRes.data).filter((r) => ownRun(r, owner, repo));
            afterRunId = existingRuns.reduce((newest, r) => Math.max(newest, r.id), 0);
          }
        } catch {
          // Left out: see above.
        }

        await access.write((ctx) =>
          dispatchWorkflow({
            ...ctx,
            owner,
            repo,
            workflowId,
            payload: {
              ref: nextRef,
              ...(Object.keys(nextInputs).length > 0 ? { inputs: nextInputs } : {}),
            },
            signal: abort.signal,
          }),
        );

        if (this.stopped) return;

        const watched = await this.deps
          .watchNextRun({
            owner,
            repo,
            ...(repoId !== undefined ? { repoId } : {}),
            repoName,
            workflowId,
            workflowFile,
            branch: nextRef,
            ...(afterRunId !== undefined ? { afterRunId } : {}),
          })
          .catch((err: unknown) => ({
            watchId: undefined,
            note: `Triggered, but couldn't start a watch: ${err instanceof Error ? err.message : String(err)}`,
          }));

        const now = Date.now();
        const doneCard: WorkflowDispatchCard = {
          ...dispatchingCard,
          payload: {
            ...dispatchingCard.payload,
            status: "done",
            revision: dispatchingCard.payload.revision + 1,
            ...(watched.watchId !== undefined ? { watchId: watched.watchId } : {}),
            ...(watched.note ? { watchNote: githubText(watched.note, 240) } : {}),
            dispatchedAt: now,
          },
          updatedAt: now,
        };
        this.deps.saveCard(doneCard);
        this.deps.digest(
          `workflow-dispatch:${card.id}`,
          `[ci] You triggered ${digestText(workflowName, 80)} on ${repoName} (${digestText(nextRef, 80)})${watched.watchId !== undefined ? `; watching for the run (W-${watched.watchId})` : ""}.`,
        );
      } catch (error) {
        if (this.stopped) return;
        const errText = githubText(error instanceof Error ? error.message : String(error), 400);
        this.deps.saveCard({
          ...dispatchingCard,
          payload: {
            ...dispatchingCard.payload,
            status: "failed",
            revision: dispatchingCard.payload.revision + 1,
            error: errText,
          },
          updatedAt: Date.now(),
        });
        throw error;
      }
    })();

    const done = run.then(onlyWaitedFor, onlyWaitedFor);
    this.inFlight.set(card.id, { abort, done });
    try {
      await run;
    } finally {
      this.inFlight.delete(card.id);
    }
  }

  /** Cancels a pending or failed `workflow_dispatch` card. */
  dismiss(cardId: string): void {
    const item = this.deps.card(cardId);
    if (!item || item.kind !== "card" || item.cardType !== "workflow_dispatch") {
      throw new Error("That workflow card doesn't exist anymore.");
    }
    const card = item as WorkflowDispatchCard;
    if (card.payload.status === "dispatching" || this.inFlight.has(card.id)) {
      throw new Error("That workflow is already being triggered.");
    }
    if (card.payload.status === "done") {
      throw new Error("That workflow was already triggered.");
    }
    if (card.payload.status === "cancelled") return;
    this.deps.saveCard({
      ...card,
      payload: {
        ...card.payload,
        status: "cancelled",
        revision: card.payload.revision + 1,
      },
      updatedAt: Date.now(),
    });
    this.deps.digest(
      `workflow-dispatch:${card.id}`,
      `[ci] You cancelled workflow card ${card.payload.shortId} (${digestText(card.payload.workflowName, 80)} on ${card.payload.repoName}).`,
    );
  }
}
