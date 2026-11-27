import type { Task, TaskState } from "@aria/protocol";
import { Ban, Check, CircleDashed, CirclePause, CircleQuestionMark, ClipboardList, LoaderCircle, Play, ShieldAlert, TimerReset, X, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";

/** How each task state looks everywhere (cards, sidebar, session view). */
export const STATE_META: Record<TaskState, { label: string; icon: LucideIcon; tone: string; spin?: boolean }> = {
  queued: { label: "Queued", icon: CircleDashed, tone: "text-muted" },
  starting: { label: "Starting", icon: LoaderCircle, tone: "text-accent", spin: true },
  running: { label: "Running", icon: Play, tone: "text-accent" },
  waiting_input: { label: "Needs you", icon: CircleQuestionMark, tone: "text-bad" },
  waiting_permission: { label: "Needs approval", icon: ShieldAlert, tone: "text-bad" },
  waiting_plan: { label: "Plan ready", icon: ClipboardList, tone: "text-bad" },
  waiting_budget: { label: "Paused: budget", icon: CirclePause, tone: "text-warn" },
  done: { label: "Done · review", icon: Check, tone: "text-ok" },
  failed: { label: "Failed", icon: X, tone: "text-bad" },
  cancelled: { label: "Stopped", icon: Ban, tone: "text-muted" },
  interrupted: { label: "Interrupted", icon: TimerReset, tone: "text-warn" },
};

/** Waiting on you: an answer, an approval, a plan review, a budget, or a resume. */
export const needsYou = (task: Task) =>
  task.state === "waiting_input" || task.state === "waiting_permission" || task.state === "waiting_plan" || task.state === "waiting_budget" || task.state === "interrupted";
/** Its session works on a turn, or waits inside it for you. */
export const isActive = (task: Task) =>
  task.state === "starting" || task.state === "running" || task.state === "waiting_input" || task.state === "waiting_permission" || task.state === "waiting_plan";

/** Sidebar order (PLAN.md §5.2): needs you, running, queued, done, then the rest. */
const ORDER: Record<TaskState, number> = {
  waiting_input: 0,
  waiting_permission: 0,
  waiting_plan: 0,
  waiting_budget: 0,
  interrupted: 1,
  starting: 2,
  running: 2,
  queued: 3,
  done: 4,
  failed: 5,
  cancelled: 6,
};
export const byAttention = (a: Task, b: Task) => ORDER[a.state] - ORDER[b.state] || b.createdAt - a.createdAt;

export function StateChip({ state, className = "" }: { state: TaskState; className?: string }) {
  const meta = STATE_META[state];
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${meta.tone} ${className}`} data-testid="task-state" data-state={state}>
      <Icon className={`h-3.5 w-3.5 ${meta.spin ? "animate-spin" : ""}`} />
      {meta.label}
    </span>
  );
}

export function StateIcon({ state }: { state: TaskState }) {
  const meta = STATE_META[state];
  const Icon = meta.icon;
  return <Icon className={`h-3.5 w-3.5 shrink-0 ${meta.tone} ${meta.spin ? "animate-spin" : ""}`} aria-label={meta.label} />;
}

export const credits = (value: number) => `${value < 10 ? value.toFixed(2) : Math.round(value)} credits`;

export function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Re-renders every `ms` while `active`, for elapsed times. */
export function useNow(active: boolean, ms = 10_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return now;
}

export function elapsed(task: Task, now: number): string | null {
  if (!task.startedAt) return null;
  return duration((task.finishedAt ?? now) - task.startedAt);
}

export const modelLabel = (task: { model: string; reasoningEffort?: string }) => `${task.model}${task.reasoningEffort ? ` · ${task.reasoningEffort}` : ""}`;
