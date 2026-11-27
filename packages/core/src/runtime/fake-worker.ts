/**
 * Scripted worker sessions for tests (part of the fake runtime): each `send` plays the next script. Steps can run real
 * code in the worktree (e.g. write a file and commit with git), ask the policy like a tool call would, ask you a
 * question, report usage, finish or fail. No Copilot runtime, no model calls.
 */
import type { TaskMode, TranscriptEntry } from "@aria/protocol";
import type { PermissionAsk, WorkerConfig, WorkerEvent, WorkerHandle, WorkerPlanDecision } from "./types.ts";

export type FakeWorkerToolStep = { tool: string; args?: Record<string, unknown>; ask?: PermissionAsk | ((cwd: string) => PermissionAsk); run?: (cwd: string) => unknown | Promise<unknown> };

export type FakeWorkerStep =
  | { intent: string }
  /** A tool call. With `ask`, the policy decides first (a refusal fails the call); `run` does the work in the worktree. */
  | FakeWorkerToolStep
  /** Tool calls the model makes at once: their permission requests are open at the same time. */
  | { parallel: FakeWorkerToolStep[] }
  | { question: string; choices?: string[]; allowFreeform?: boolean }
  /** exit_plan_mode: waits for your decision; approving with a mode switches the session to it (as the runtime does). */
  | { plan: string; summary: string }
  /** What the session's plan.md says from here on (a plan-mode turn can go idle without calling exit_plan_mode). */
  | { planFile: string }
  | { message: string }
  /** Cost of a model call, in AI credits. */
  | { usage: number }
  | { error: string }
  /** task_complete with this summary (autopilot). */
  | { complete: string }
  | { wait: number }
  /** Waits until the test resolves it. */
  | { gate: Promise<void> };

export interface FakeWorkerScript {
  steps: FakeWorkerStep[];
}

export interface FakeWorkerSession {
  config: WorkerConfig;
  prompts: string[];
  /** The session's model when each prompt arrived. */
  promptModels: string[];
  /** The session's active agent when each prompt arrived. */
  promptAgents: Array<string | undefined>;
  model: string;
  reasoningEffort?: string;
  agent?: string;
  connected: boolean;
  aborted: boolean;
  transcript: Map<string, TranscriptEntry>;
  /** What the policy decided, in order (for tests). */
  decisions: Array<{ ask: PermissionAsk; approved: boolean; reason?: string; unavailable?: boolean }>;
  /** Your decisions on its plans, in order. */
  planDecisions: WorkerPlanDecision[];
  /** The session's mode now (a plan approval switches it). */
  mode: TaskMode;
  planFile?: string;
  /** Reports an event from the session right now (e.g. a sub-agent's usage while the worker waits for an answer). */
  inject: (event: WorkerEvent) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function openFakeWorker(options: {
  config: WorkerConfig;
  existing: FakeWorkerSession | undefined;
  nextScript: (prompt: string) => FakeWorkerScript | undefined;
  register: (session: FakeWorkerSession) => void;
  /** Awaited before a send is accepted (to act while one is on its way). */
  beforeSend?: (text: string) => Promise<void> | undefined;
  /** Awaited before a model switch takes effect (to act while one is on its way). */
  beforeSetModel?: () => Promise<void> | undefined;
  /** When it returns true for a model, switching to it fails. */
  failSetModel?: (model: string) => boolean;
  /** When it returns true for an agent, switching to it fails. */
  failSetAgent?: (agent: string | null) => boolean;
  /** When it returns true, switching the session's mode fails. */
  failSetMode?: () => boolean;
  /** Awaited before an abort takes effect (to act while one is on its way). */
  beforeAbort?: () => Promise<void> | undefined;
  /** A model the session falls back to instead of the one asked for, reported with a cause (D15). */
  substituteModel?: () => string | undefined;
  /** When it returns true, disconnecting never finishes (a session that doesn't answer). */
  hangDisconnect?: () => boolean;
  /** Phase 8A: Optional delay before `session.start` (`producer: "copilot-agent"`) resolves on a new cloud worker. */
  cloudStartDelayMs?: () => number;
  /** Phase 8A: When true, simulates a cloud session where `session.start` never arrives so the timeout triggers. */
  cloudStartTimeout?: () => boolean;
  /** Phase 8A: When set, emits `{ type: "warning", warningType: "policy_blocked", message }` on cloud workers. */
  cloudPolicyBlocked?: () => string | undefined;
  /** Phase 8A: Custom URL generator for `remote_info` on cloud/remote workers. */
  missionControlUrlFor?: (sessionId: string, config: WorkerConfig) => string | undefined;
}): WorkerHandle {
  const { config, existing } = options;
  const session: FakeWorkerSession = {
    config,
    prompts: existing?.prompts ?? [],
    promptModels: existing?.promptModels ?? [],
    promptAgents: existing?.promptAgents ?? [],
    model: config.model,
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(config.agent ? { agent: config.agent } : {}),
    connected: true,
    aborted: false,
    transcript: existing?.transcript ?? new Map(),
    decisions: existing?.decisions ?? [],
    planDecisions: existing?.planDecisions ?? [],
    mode: config.mode,
    inject: (event) => emit(event),
  };
  options.register(session);
  let counter = session.transcript.size;
  const emit = (event: WorkerEvent) => {
    if (session.connected) config.onEvent(event);
  };
  const entry = (value: TranscriptEntry) => {
    session.transcript.set(value.id, value);
    emit({ type: "transcript", entries: [value] });
  };
  const nextId = (prefix: string) => `${prefix}-${config.sessionId}-${++counter}`;

  const runTool = async (step: FakeWorkerToolStep) => {
    emit({ type: "activity" });
    const id = nextId("tool");
    const at = Date.now();
    const cwd = config.workingDirectory ?? "/workspaces";
    entry({ kind: "tool", id, at, name: step.tool, ...(step.args ? { args: JSON.stringify(step.args) } : {}) });
    let error: string | undefined;
    let result: string | undefined;
    if (step.ask) {
      const asked = typeof step.ask === "function" ? step.ask(cwd) : step.ask;
      // Like the runtime: a command's request names the tool call it's for.
      const ask = asked.kind === "shell" && !asked.toolCallId ? { ...asked, toolCallId: id } : asked;
      const verdict = await config.policy.decide(ask);
      session.decisions.push({ ask, approved: verdict.approve, ...(verdict.approve ? {} : { reason: verdict.reason, ...(verdict.unavailable ? { unavailable: true } : {}) }) });
      if (!verdict.approve) error = verdict.reason;
    }
    if (!error && step.run && !session.aborted && session.connected) {
      try {
        const value = await step.run(cwd);
        result = value === undefined ? "ok" : String(value);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    }
    entry({ kind: "tool", id, at, name: step.tool, ...(step.args ? { args: JSON.stringify(step.args) } : {}), success: !error, ms: Date.now() - at, ...(error ? { error } : { result: result ?? "ok" }) });
  };

  const play = async (prompt: string) => {
    session.aborted = false;
    entry({ kind: "user", id: nextId("user"), at: Date.now(), text: prompt });
    emit({ type: "activity" });
    const script = options.nextScript(prompt) ?? { steps: [{ message: `echo: ${prompt}` }] };
    for (const step of script.steps) {
      // Each step takes a moment, as a model's does, so an abort sent on the turn's first event lands before it acts.
      await sleep(0);
      if (session.aborted || (!session.connected && !isCloud)) break;
      if ("intent" in step) {
        emit({ type: "intent", intent: step.intent });
      } else if ("tool" in step) {
        await runTool(step);
      } else if ("parallel" in step) {
        await Promise.all(step.parallel.map(runTool));
      } else if ("question" in step) {
        emit({ type: "activity" });
        const id = nextId("question");
        entry({ kind: "question", id, at: Date.now(), question: step.question, ...(step.choices ? { choices: step.choices } : {}) });
        const answer = await config.onQuestion({ question: step.question, ...(step.choices ? { choices: step.choices } : {}), allowFreeform: step.allowFreeform ?? true });
        entry({ kind: "question", id, at: Date.now(), question: step.question, ...(step.choices ? { choices: step.choices } : {}), answer: answer.answer });
      } else if ("plan" in step) {
        emit({ type: "activity" });
        const decision = await config.onPlan({ summary: step.summary, plan: step.plan, actions: ["autopilot", "interactive", "exit_only"], recommended: "autopilot" });
        session.planDecisions.push(decision);
        if (decision.approved && decision.mode) session.mode = decision.mode;
        entry({ kind: "info", id: nextId("plan"), at: Date.now(), level: "info", text: decision.approved ? `Plan approved (${decision.mode ?? "same mode"})` : `Plan not approved${decision.feedback ? `: ${decision.feedback}` : ""}` });
      } else if ("planFile" in step) {
        session.planFile = step.planFile;
      } else if ("message" in step) {
        emit({ type: "activity" });
        entry({ kind: "assistant", id: nextId("message"), at: Date.now(), text: step.message });
        emit({ type: "message", text: step.message });
      } else if ("usage" in step) {
        emit({ type: "usage", nanoAiu: Math.round(step.usage * 1e9) });
      } else if ("error" in step) {
        emit({ type: "error", message: step.error });
        break;
      } else if ("complete" in step) {
        if (isCloud) {
          entry({ kind: "info", id: nextId("complete"), at: Date.now(), level: "info", text: `Finished${step.complete ? `: ${step.complete}` : ""}` });
        }
        emit({ type: "task_complete", summary: step.complete });
      } else if ("wait" in step) {
        const until = Date.now() + step.wait;
        while (Date.now() < until && !session.aborted && (session.connected || isCloud)) await sleep(5);
      } else {
        await Promise.race([step.gate, (async () => {
          while (!session.aborted && (session.connected || isCloud)) await sleep(5);
        })()]);
      }
    }
    emit({ type: "idle", autopilot: session.mode === "autopilot" });
  };

  const isCloud = Boolean(config.cloud);
  const isRemote = Boolean(config.remote);
  const resumed = existing !== undefined;
  let cloudStarted = !isCloud || resumed;

  if (isCloud || isRemote) {
    const url = options.missionControlUrlFor
      ? options.missionControlUrlFor(config.sessionId, config)
      : `https://github.com/copilot/tasks/${encodeURIComponent(config.sessionId)}`;
    if (url) {
      emit({ type: "remote_info", url, message: `Remote session available at ${url}` });
    }
  }

  // One turn at a time, like the runtime's queue.
  let turns: Promise<void> = Promise.resolve();
  return {
    sessionId: config.sessionId,
    resumed,
    send: async (text) => {
      await options.beforeSend?.(text);
      if (isCloud) {
        const blocked = options.cloudPolicyBlocked?.();
        if (blocked) {
          emit({ type: "warning", warningType: "policy_blocked", message: blocked });
          throw new Error(blocked);
        }
        if (!cloudStarted) {
          const timeoutMs = config.cloudStartTimeoutMs ?? 60_000;
          if (options.cloudStartTimeout?.()) {
            await sleep(Math.min(timeoutMs, 100));
            throw new Error("Timed out waiting for the cloud session to start on Mission Control.");
          }
          const delayMs = options.cloudStartDelayMs?.() ?? 0;
          if (delayMs > 0) {
            if (delayMs > timeoutMs) {
              await sleep(timeoutMs);
              throw new Error("Timed out waiting for the cloud session to start on Mission Control.");
            }
            await sleep(delayMs);
          }
          cloudStarted = true;
        }
      }
      session.prompts.push(text);
      session.promptModels.push(session.model);
      session.promptAgents.push(session.agent);
      turns = turns.then(() => play(text)).catch(() => {
        // A scripted turn that throws is the test's own doing, and the next turn still plays.
      });
    },
    setModel: async (model, reasoningEffort) => {
      await options.beforeSetModel?.();
      if (options.failSetModel?.(model)) throw new Error(`fake: can't switch to ${model}`);
      const previousModel = session.model;
      const actual = options.substituteModel?.() ?? model;
      session.model = actual;
      if (reasoningEffort) session.reasoningEffort = reasoningEffort;
      else delete session.reasoningEffort;
      emit({ type: "model_change", model: actual, previousModel, ...(reasoningEffort ? { reasoningEffort } : {}), ...(actual !== model ? { cause: "refusal_fallback" } : {}) });
    },
    setAgent: async (agent) => {
      const trimmed = agent?.trim() || undefined;
      if (options.failSetAgent?.(trimmed ?? null)) throw new Error(`fake: can't switch agent to ${trimmed ?? "default"}`);
      if (trimmed) session.agent = trimmed;
      else delete session.agent;
    },
    setMode: async (mode) => {
      if (options.failSetMode?.()) throw new Error("fake: can't switch the mode");
      session.mode = mode;
    },
    readPlan: async () => session.planFile,
    abort: async () => {
      await options.beforeAbort?.();
      session.aborted = true;
    },
    getTranscript: async () => [...session.transcript.values()],
    disconnect: async () => {
      session.connected = false;
      if (options.hangDisconnect?.()) await new Promise<void>(() => {
        // Never settles: a disconnect that hangs is what the test asked for.
      });
    },
  };
}
