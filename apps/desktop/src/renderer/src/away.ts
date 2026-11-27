/** The "while you were away" card's groups (PLAN.md §5.5). Pure, so it's unit-tested. */
import type { AwayDigestPayload, AwayLine, Task } from "@aria/protocol";

/**
 * A line as things stand now (the card itself is a snapshot): "settled" when its task no longer waits on that item
 * (you answered, decided, raised the budget, resumed), "interrupted" when the item went because ARIA closed (a
 * restart drops what was pending, and the task waits to be resumed: it still needs you), "gone" when the task was
 * discarded.
 */
export function lineStatus(line: AwayLine, task: Task | undefined): "settled" | "interrupted" | "gone" | undefined {
  // GitHub, tracker, and Outlook news are about external watches/tasks/emails, not an ARIA worker task: their cards are snapshots that are always there.
  if (line.kind === "github" || line.kind === "tracker" || line.kind === "outlook") return undefined;
  if (!task) return "gone";
  if (line.kind !== "needs_you" || !line.waits) return undefined;
  if (task.state === "interrupted" && line.waits !== "interrupted") return "interrupted";
  const waiting = {
    question: task.question?.id === line.itemId,
    permission: task.permissions?.some((p) => p.id === line.itemId) ?? false,
    plan: task.plan?.id === line.itemId,
    budget: task.state === "waiting_budget",
    interrupted: task.state === "interrupted",
  }[line.waits];
  return waiting ? undefined : "settled";
}

export interface AwayGroup {
  kind: AwayLine["kind"];
  label: string;
  lines: AwayLine[];
  /** All of this kind, the ones not shown included. */
  total: number;
}

const labels = (trackerLabel: string): Record<AwayLine["kind"], string> => ({
  needs_you: "Needs you",
  failed: "Failed",
  done: "Finished",
  github: "GitHub",
  tracker: trackerLabel,
  outlook: "Outlook",
});

/** Needs you first, then what failed, then what finished, then GitHub's news, then the tracker's updates, then Outlook emails; groups without lines are left out. */
export function awayGroups(payload: AwayDigestPayload, trackerLabel: string): AwayGroup[] {
  const label = labels(trackerLabel);
  return (["needs_you", "failed", "done", "github", "tracker", "outlook"] as const)
    .map((kind) => {
      const lines = payload.lines.filter((l) => l.kind === kind);
      return { kind, label: label[kind], lines, total: lines.length + (payload.more?.[kind] ?? 0) };
    })
    .filter((g) => g.total > 0);
}

/** "2 need you · 1 failed · 3 finished" */
export function awaySummary(groups: AwayGroup[], trackerLabel: string): string {
  const words: Record<AwayLine["kind"], (n: number) => string> = {
    needs_you: (n) => `${n} need${n === 1 ? "s" : ""} you`,
    failed: (n) => `${n} failed`,
    done: (n) => `${n} finished`,
    github: (n) => `${n} GitHub update${n === 1 ? "" : "s"}`,
    tracker: (n) => `${n} ${trackerLabel} update${n === 1 ? "" : "s"}`,
    outlook: (n) => `${n} email${n === 1 ? "" : "s"}`,
  };
  return groups.map((g) => words[g.kind](g.total)).join(" · ");
}
