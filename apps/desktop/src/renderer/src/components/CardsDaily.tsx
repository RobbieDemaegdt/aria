// Catching you up: while you were away, reminders, and the morning brief.
import type { AwayLine, CardItem } from "@aria/protocol";
import {
  Bell,
  Briefcase,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleQuestionMark,
  Clock,
  Coffee,
  Mail,
  Workflow,
  Sparkles,
} from "lucide-react";
import { useState } from "react";
import { awayGroups, awaySummary, lineStatus } from "../away";
import { useAria, useTracker } from "../store";
import { trackerLabel } from "../tracker";
import { Markdown } from "./Markdown";
import { duration } from "./tasks";
import { Button, formatHoursMinutes, Shell, ShortId } from "./CardParts";

const AWAY_ICONS = {
  needs_you: <CircleQuestionMark className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bad" />,
  failed: <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bad" />,
  done: <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" />,
  github: <Workflow className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />,
  tracker: <Briefcase className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />,
  outlook: <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />,
};

/** The newest "interrupted" card with this task on it: that's where it's resumed. */
function interruptedCardFor(taskId: string): string | undefined {
  const timeline = useAria.getState().timeline;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i]!;
    if (item.kind === "card" && item.cardType === "tasks_interrupted" && item.payload.taskIds.includes(taskId)) return item.id;
  }
  return undefined;
}

/** "While you were away" (PLAN.md §5.5): each line takes you to its own card (those keep their buttons, D24). */
export function AwayCard({ card }: { card: Extract<CardItem, { cardType: "away_digest" }> }) {
  const focusCard = useAria((s) => s.focusCard);
  const tasks = useAria((s) => s.tasks);
  const trackerName = trackerLabel(useTracker());
  const groups = awayGroups(card.payload, trackerName);
  // A line whose task was interrupted takes you to the card that resumes it; any other, to its own card.
  const show = (line: AwayLine, status: ReturnType<typeof lineStatus>) => focusCard((status === "interrupted" && line.taskId && interruptedCardFor(line.taskId)) || line.cardId, line.taskId);
  return (
    <Shell
      testId="card-away"
      cardId={card.id}
      icon={<Coffee className="h-4 w-4 text-muted" />}
      title={`While you were away · ${duration(card.payload.awayMs)}`}
      right={<span className="shrink-0 text-xs text-muted">{awaySummary(groups, trackerName)}</span>}
    >
      {groups.map((group) => (
        <div key={group.kind} className="mt-1.5" data-testid="away-group" data-kind={group.kind}>
          <div className="text-[11px] font-medium text-muted">{group.label}</div>
          <ul>
            {group.lines.map((line) => {
              // As things stand now: what you settled since, a task that's gone, or one that still needs you, to be resumed.
              const status = lineStatus(line, tasks.find((t) => t.id === line.taskId));
              const done = status === "settled" || status === "gone";
              return (
                <li key={`${line.kind}-${line.taskId ?? line.watchId ?? ""}-${line.cardId}`}>
                  <button
                    data-testid="away-line"
                    data-status={status ?? "open"}
                    onClick={() => show(line, status)}
                    title={status === "interrupted" ? "Show the card that resumes it" : "Show its card"}
                    className={`flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-raised ${done ? "opacity-60" : ""}`}
                  >
                    {AWAY_ICONS[line.kind]}
                    <span className="min-w-0">
                      <ShortId id={line.shortId} />
                      <span className={done ? "text-muted line-through" : "text-fg"}>{line.title}</span>
                      <span className="text-muted"> · {line.repoName} · {line.text}</span>
                      {line.kind === "needs_you" && !line.isNew && !status && <span className="text-muted"> (was waiting before)</span>}
                      {status === "settled" && <span className="text-ok"> · settled</span>}
                      {status === "interrupted" && <span className="text-warn"> · interrupted: resume it on its card</span>}
                      {status === "gone" && <span className="text-muted"> · discarded</span>}
                    </span>
                  </button>
                </li>
              );
            })}
            {group.total > group.lines.length && <li className="px-1 text-xs text-muted">and {group.total - group.lines.length} more</li>}
          </ul>
        </div>
      ))}
    </Shell>
  );
}

/** Phase 6B (PLAN.md §5.4, §10 Phase 6B): Reminder card with Snooze and Done. */
export function ReminderCardView({ card }: { card: Extract<CardItem, { cardType: "reminder" }> }) {
  const snoozeReminder = useAria((s) => s.snoozeReminder);
  const dismissReminder = useAria((s) => s.dismissReminder);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = card.payload;

  const act = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    const err = await fn();
    setBusy(false);
    if (err) setError(err);
  };

  const rightLabel =
    p.status === "done"
      ? "Done"
      : p.status === "snoozed" && p.snoozedUntil
        ? `Snoozed until ${new Date(p.snoozedUntil).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
        : "Due now";

  return (
    <Shell
      testId="card-reminder"
      cardId={card.id}
      icon={<Bell className={`h-4 w-4 ${p.status === "fired" ? "text-bad" : p.status === "done" ? "text-ok" : "text-muted"}`} />}
      title={
        <span className="inline-flex items-center gap-1.5">
          <ShortId id={p.shortId} />
          <span>Reminder</span>
        </span>
      }
      right={
        <span
          data-testid="reminder-status"
          className={`shrink-0 text-xs ${p.status === "fired" ? "text-bad" : p.status === "done" ? "text-ok" : "text-muted"}`}
        >
          {rightLabel}
        </span>
      }
    >
      <div className={`text-sm ${p.status === "done" ? "text-muted line-through" : "text-fg"}`} data-testid="reminder-text">
        {p.text}
      </div>

      {error && (
        <div className="mt-1.5 text-xs text-bad" data-testid="reminder-error">
          {error}
        </div>
      )}

      {p.status !== "done" && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <Button testId="reminder-snooze-15m" disabled={busy} onClick={() => void act(() => snoozeReminder(p.reminderId, 15))}>
            <Clock className="h-3 w-3" /> Snooze 15m
          </Button>
          <Button testId="reminder-snooze-1h" disabled={busy} onClick={() => void act(() => snoozeReminder(p.reminderId, 60))}>
            <Clock className="h-3 w-3" /> Snooze 1h
          </Button>
          <Button testId="reminder-done" primary disabled={busy} onClick={() => void act(() => dismissReminder(p.reminderId))}>
            <Check className="h-3 w-3" /> Done
          </Button>
        </div>
      )}
    </Shell>
  );
}

/** Phase 6B (PLAN.md §4.14, §5.4, §5.5, §10 Phase 6B): Morning brief & Friday week time overview card. */
export function MorningBriefCardView({ card }: { card: Extract<CardItem, { cardType: "morning_brief" }> }) {
  const openTimeView = useAria((s) => s.openTimeView);
  const openTask = useAria((s) => s.openTask);
  const focusCard = useAria((s) => s.focusCard);
  const [expanded, setExpanded] = useState(true);
  const p = card.payload;
  const isWeekly = p.variant === "weekly_time_overview";

  const hasDetails =
    (p.weekDays?.length ?? 0) > 0 ||
    p.unregisteredDays.length > 0 ||
    p.tasks.length > 0 ||
    p.github.length > 0 ||
    p.reminders.length > 0;

  return (
    <Shell
      testId="card-morning-brief"
      cardId={card.id}
      icon={<CalendarClock className="h-4 w-4 text-accent" />}
      title={`${isWeekly ? "Week time overview" : "Morning brief"} · ${p.dateLabel}`}
      right={
        hasDetails ? (
          <button
            type="button"
            data-testid="morning-brief-toggle"
            onClick={() => setExpanded(!expanded)}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted hover:bg-raised hover:text-fg"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {expanded ? "Collapse" : "Expand"}
          </button>
        ) : undefined
      }
    >
      <div className="text-xs text-fg" data-testid="morning-brief-headline">
        {p.headline}
      </div>

      {p.aiSummary && (
        <div
          data-testid="morning-brief-ai-summary"
          className="mt-1.5 rounded-md border border-accent/30 bg-accent/5 px-2.5 py-1.5 text-xs text-fg"
        >
          <div className="mb-0.5 flex items-center gap-1 text-[10px] text-muted">
            <Sparkles className="h-3 w-3 text-accent" />
            <span>Summary{p.aiModel ? ` · ${p.aiModel}` : ""}</span>
          </div>
          <Markdown text={p.aiSummary} />
        </div>
      )}

      {expanded && (
        <div className="mt-2 space-y-2 text-xs">
          {isWeekly && p.weekDays && p.weekDays.length > 0 && (
            <div className="space-y-1" data-testid="morning-brief-weekdays">
              <div className="text-[11px] font-medium text-muted">Monday – Friday</div>
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-5">
                {p.weekDays.map((d) => (
                  <button
                    key={d.date}
                    type="button"
                    data-testid="morning-brief-weekday"
                    data-date={d.date}
                    onClick={() => openTimeView(d.date)}
                    className={`rounded border px-2 py-1 text-left ${
                      d.missingMinutes > 0
                        ? "border-warn/50 bg-warn/5 text-warn hover:border-warn"
                        : "border-line bg-canvas text-muted hover:border-accent hover:text-fg"
                    }`}
                  >
                    <div className="font-medium text-fg">{d.dateLabel}</div>
                    <div className="font-mono text-[11px]">
                      {formatHoursMinutes(d.registeredMinutes)} / {formatHoursMinutes(d.expectedMinutes)}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {p.unregisteredDays.length > 0 && (
            <div className="space-y-1" data-testid="morning-brief-unregistered">
              <div className="text-[11px] font-medium text-warn">Unregistered workdays</div>
              {p.unregisteredDays.map((d) => (
                <div
                  key={d.date}
                  data-testid="morning-brief-unregistered-day"
                  data-date={d.date}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-warn/40 bg-warn/5 px-2.5 py-1"
                >
                  <span>
                    <span className="font-medium text-fg">{d.dateLabel}</span>
                    <span className="text-muted">
                      {" "}
                      · {formatHoursMinutes(d.registeredMinutes)} of {formatHoursMinutes(d.expectedMinutes)} registered
                      {d.draftMinutes > 0 ? ` (${formatHoursMinutes(d.draftMinutes)} draft)` : ""}
                    </span>
                  </span>
                  <button
                    type="button"
                    data-testid="morning-brief-open-time"
                    onClick={() => openTimeView(d.date)}
                    className="rounded border border-line bg-panel px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-fg"
                  >
                    Open in Time view
                  </button>
                </div>
              ))}
            </div>
          )}

          {p.tasks.length > 0 && (
            <div className="space-y-1" data-testid="morning-brief-tasks">
              <div className="text-[11px] font-medium text-muted">Tasks</div>
              {p.tasks.map((t) => (
                <button
                  key={t.taskId}
                  type="button"
                  data-testid="morning-brief-task"
                  onClick={() => (t.cardId ? focusCard(t.cardId, t.taskId) : openTask(t.taskId))}
                  className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-0.5 text-left hover:bg-raised"
                >
                  <span className="min-w-0 truncate">
                    <span className="font-medium text-fg">{t.title}</span>
                    <span className="text-muted">
                      {" "}
                      · {t.repoName} · {t.detail}
                    </span>
                  </span>
                  <span
                    className={`shrink-0 text-[11px] ${
                      t.kind === "needs_you" || t.kind === "failed"
                        ? "text-bad"
                        : t.kind === "done"
                          ? "text-ok"
                          : "text-accent"
                    }`}
                  >
                    {t.kind.replace(/_/g, " ")}
                  </span>
                </button>
              ))}
            </div>
          )}

          {p.github.length > 0 && (
            <div className="space-y-1" data-testid="morning-brief-github">
              <div className="text-[11px] font-medium text-muted">GitHub</div>
              {p.github.map((g) => (
                <button
                  key={g.cardId}
                  type="button"
                  data-testid="morning-brief-github-line"
                  onClick={() => focusCard(g.cardId)}
                  className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-0.5 text-left hover:bg-raised"
                >
                  <span className="min-w-0 truncate">
                    <span className="font-medium text-fg">{g.title}</span>
                    <span className="text-muted"> · {g.repoName}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-muted">{g.detail}</span>
                </button>
              ))}
            </div>
          )}

          {p.reminders.length > 0 && (
            <div className="space-y-1" data-testid="morning-brief-reminders">
              <div className="text-[11px] font-medium text-muted">Reminders today</div>
              {p.reminders.map((r) => (
                <div key={r.reminderId} className="flex items-center gap-2 px-1.5 py-0.5">
                  <ShortId id={r.shortId} />
                  <span className="text-fg">{r.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Shell>
  );
}
