import type { Reminder, Routine, TimelineItem } from "@aria/protocol";
import {
  Bell,
  CalendarClock,
  Check,
  Clock,
  LoaderCircle,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  ScanSearch,
  Trash,
} from "lucide-react";
import { useState } from "react";
import { SidebarToggle } from "../sidebar";
import { useAria } from "../store";

const field = "rounded-md border border-line bg-canvas px-2 py-1 text-xs outline-none focus:border-accent";
const btn = "rounded-md border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-fg disabled:opacity-40";

function findRoutineTimelineItemId(routine: Routine, timeline: readonly TimelineItem[]): string | undefined {
  if (routine.kind === "morning_brief") {
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i]!;
      if (
        item.kind === "card" &&
        item.cardType === "morning_brief" &&
        item.payload.variant === "morning_brief" &&
        (!routine.lastRunDate || item.payload.date === routine.lastRunDate)
      ) {
        return item.id;
      }
    }
    return undefined;
  }
  if (routine.kind === "weekly_time_overview") {
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i]!;
      if (
        item.kind === "card" &&
        item.cardType === "morning_brief" &&
        item.payload.variant === "weekly_time_overview" &&
        (!routine.lastRunDate || item.payload.date === routine.lastRunDate)
      ) {
        return item.id;
      }
    }
    return undefined;
  }
  if (routine.kind === "daily_timesheet") {
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i]!;
      if (
        item.kind === "card" &&
        item.cardType === "timesheet_draft" &&
        (!routine.lastRunDate || item.payload.date === routine.lastRunDate)
      ) {
        return item.id;
      }
    }
    return undefined;
  }
  const prefix = `[Scheduled routine: ${routine.name}]`;
  const isFromCurrentRun = (createdAt: number): boolean =>
    routine.lastRunAt === undefined || createdAt >= routine.lastRunAt;
  const resolveTurnTarget = (userIndex: number): string => {
    let targetId = timeline[userIndex]!.id;
    for (let j = userIndex + 1; j < timeline.length; j++) {
      const next = timeline[j]!;
      if (next.kind === "chat" && next.role === "user" && !next.routedTo) break;
      if ((next.kind === "chat" && next.role === "assistant") || next.kind === "card") {
        targetId = next.id;
      }
    }
    return targetId;
  };
  // 1. Match by stable `routineId` on the user chat item from the latest run (survives renames and duplicate routine names).
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i]!;
    if (item.kind === "chat" && item.role === "user" && item.routineId === routine.id && isFromCurrentRun(item.createdAt)) {
      return resolveTurnTarget(i);
    }
  }
  // 2. Fallback for legacy timeline entries recorded without `routineId`.
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i]!;
    if (
      item.kind === "chat" &&
      item.role === "user" &&
      item.routineId === undefined &&
      item.content.startsWith(prefix) &&
      isFromCurrentRun(item.createdAt)
    ) {
      return resolveTurnTarget(i);
    }
  }
  return undefined;
}

/** True when this running prompt routine owns the active Conductor turn (as opposed to waiting for an earlier turn to finish). */
function isPromptRoutineActiveTurn(routine: Routine, routines: readonly Routine[], timeline: readonly TimelineItem[]): boolean {
  if (routine.kind !== "prompt") return false;
  const prefix = `[Scheduled routine: ${routine.name}]`;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i]!;
    // Direct replies (`routedTo`) go straight to a worker task and do not interrupt the Conductor turn.
    if (item.kind === "chat" && item.role === "user" && !item.routedTo) {
      const matchesRoutine =
        item.routineId !== undefined ? item.routineId === routine.id : item.content.startsWith(prefix);
      if (!matchesRoutine) return false;
      if (routine.lastRunAt !== undefined && item.createdAt < routine.lastRunAt) return false;
      return true;
    }
  }
  // Before the timeline event arrives: active only if no other running prompt routine started earlier (or earlier in list on tie).
  const myIndex = routines.findIndex((r) => r.id === routine.id);
  return !routines.some((other, idx) => {
    if (other.id === routine.id || other.kind !== "prompt" || other.lastStatus !== "running") return false;
    const otherStart = other.lastRunAt ?? 0;
    const myStart = routine.lastRunAt ?? Infinity;
    return otherStart < myStart || (otherStart === myStart && myIndex !== -1 && idx < myIndex);
  });
}

function formatTimestamp(ms: number | undefined): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function describeCron(cron: string): string {
  const m = /^\s*(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(1-5|mon-fri|\*|5|fri)\s*$/i.exec(cron);
  if (!m) return cron;
  const hh = String(Number(m[2])).padStart(2, "0");
  const mm = String(Number(m[1])).padStart(2, "0");
  const dow = m[3]!.toLowerCase();
  if (dow === "1-5" || dow === "mon-fri") return `Weekdays at ${hh}:${mm} (${cron})`;
  if (dow === "5" || dow === "fri") return `Fridays at ${hh}:${mm} (${cron})`;
  return `Daily at ${hh}:${mm} (${cron})`;
}

function RoutineRow({ routine }: { routine: Routine }) {
  const toggleRoutine = useAria((s) => s.toggleRoutine);
  const runRoutine = useAria((s) => s.runRoutine);
  const saveRoutine = useAria((s) => s.saveRoutine);
  const deleteRoutine = useAria((s) => s.deleteRoutine);
  const routines = useAria((s) => s.routines);
  const timeline = useAria((s) => s.timeline);
  const activity = useAria((s) => s.activity);
  const streaming = useAria((s) => s.streaming);
  const focusCard = useAria((s) => s.focusCard);
  const setView = useAria((s) => s.setView);
  const openInspector = useAria((s) => s.openInspector);
  const openTimeView = useAria((s) => s.openTimeView);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(routine.name);
  const [cron, setCron] = useState(routine.cron);
  const [prompt, setPrompt] = useState(routine.prompt ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isRunning = routine.lastStatus === "running" || busy;
  const ownsActiveTurn = isRunning && isPromptRoutineActiveTurn(routine, routines, timeline);
  const targetItemId = findRoutineTimelineItemId(routine, timeline);
  const hasExecution = Boolean(routine.lastRunAt || routine.lastResult || routine.lastError || targetItemId);
  const hasTimeView = routine.kind === "daily_timesheet" || routine.kind === "weekly_time_overview";
  const latestStream = ownsActiveTurn ? streaming.at(-1)?.text : undefined;
  const openInChat = () => {
    if (targetItemId) focusCard(targetItemId);
    else setView("chat");
  };

  const act = async (fn: () => Promise<string | null | undefined>) => {
    setBusy(true);
    setError(null);
    try {
      const err = await fn();
      if (err) setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="routine-row"
      data-routine-id={routine.id}
      className="space-y-2 rounded-lg border border-line bg-panel p-3.5"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-fg" data-testid="routine-name">
              {routine.name}
            </span>
            <span className="rounded border border-line px-1.5 py-px text-[11px] text-muted">
              {routine.createdBy === "builtin" ? "Built-in" : "Custom"}
            </span>
            <span
              data-testid="routine-cron"
              className="rounded bg-canvas px-1.5 py-px font-mono text-[11px] text-muted"
            >
              {describeCron(routine.cron)}
            </span>
            {routine.lastStatus && (
              <span
                data-testid="routine-last-status"
                className={`rounded px-1.5 py-px text-[11px] ${
                  routine.lastStatus === "ok"
                    ? "bg-ok/15 text-ok"
                    : routine.lastStatus === "error"
                      ? "bg-bad/15 text-bad"
                      : "bg-accent/15 text-accent"
                }`}
              >
                {routine.lastStatus === "running"
                  ? "running…"
                  : routine.lastStatus === "ok"
                    ? "last run ok"
                    : "last run failed"}
              </span>
            )}
          </div>

          {routine.prompt && !editing && (
            <div className="line-clamp-2 text-xs text-muted">{routine.prompt}</div>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
            <span data-testid="routine-next-run">
              Next run: {routine.enabled ? formatTimestamp(routine.nextRunAt) : "Disabled"}
            </span>
            {routine.lastRunAt && <span>Last run: {formatTimestamp(routine.lastRunAt)}</span>}
            {routine.kind === "morning_brief" && (
              <label className="inline-flex cursor-pointer items-center gap-1 text-muted hover:text-fg">
                <input
                  type="checkbox"
                  data-testid="routine-first-open-toggle"
                  checked={routine.runOnFirstOpen !== false}
                  onChange={(e) =>
                    void act(() =>
                      toggleRoutine({ id: routine.id, runOnFirstOpen: e.target.checked }),
                    )
                  }
                />
                <span>Also run on first open of the day</span>
              </label>
            )}
          </div>

          {isRunning && (
            <div
              data-testid="routine-running-banner"
              className="mt-1 space-y-1.5 rounded-md border border-accent/40 bg-accent/10 px-2.5 py-2 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 font-medium text-accent">
                  <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  {routine.kind === "prompt"
                    ? ownsActiveTurn
                      ? `Running in ARIA chat · ${activity ?? "Thinking"}…`
                      : "Waiting for ARIA chat to finish current turn…"
                    : routine.kind === "daily_timesheet"
                      ? "Preparing today's timesheet draft in ARIA chat & Time view…"
                      : routine.kind === "weekly_time_overview"
                        ? "Building weekly time overview card in ARIA chat…"
                        : "Building morning brief card in ARIA chat…"}
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    data-testid="routine-watch-in-chat"
                    onClick={openInChat}
                    className="inline-flex items-center gap-1 rounded border border-accent/50 bg-canvas px-2 py-0.5 text-[11px] text-accent hover:border-accent hover:text-fg"
                  >
                    <MessageSquare className="h-3 w-3" /> Watch in chat
                  </button>
                  {routine.kind === "prompt" && (
                    <button
                      type="button"
                      data-testid="routine-inspect"
                      onClick={() => openInspector()}
                      className="inline-flex items-center gap-1 rounded border border-line bg-canvas px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-fg"
                    >
                      <ScanSearch className="h-3 w-3" /> Inspect
                    </button>
                  )}
                </div>
              </div>
              {routine.kind === "prompt" && latestStream && (
                <div className="line-clamp-2 whitespace-pre-wrap wrap-anywhere text-[11px] text-muted" data-testid="routine-running-stream">
                  {latestStream}
                </div>
              )}
            </div>
          )}

          {(routine.lastResult || routine.lastError) && (
            <div
              data-testid="routine-last-result"
              className={`whitespace-pre-wrap wrap-anywhere text-xs ${routine.lastStatus === "error" ? "text-bad" : "text-muted"}`}
            >
              {routine.lastStatus === "error" ? routine.lastError : routine.lastResult}
            </div>
          )}

          {!isRunning && hasExecution && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-[11px]" data-testid="routine-execution-links">
              <button
                type="button"
                data-testid="routine-view-in-chat"
                onClick={openInChat}
                className="inline-flex items-center gap-1 rounded border border-line bg-canvas px-2 py-0.5 text-accent hover:border-accent hover:text-fg"
                title="Open ARIA chat at this routine's card or message"
              >
                <MessageSquare className="h-3 w-3" /> View in chat
              </button>
              {routine.kind === "prompt" && (
                <button
                  type="button"
                  data-testid="routine-inspect"
                  onClick={() => openInspector()}
                  className="inline-flex items-center gap-1 rounded border border-line bg-canvas px-2 py-0.5 text-muted hover:border-accent hover:text-fg"
                  title="Inspect the prompt and tools ARIA ran for this routine"
                >
                  <ScanSearch className="h-3 w-3" /> Inspect
                </button>
              )}
              {hasTimeView && (
                <button
                  type="button"
                  data-testid="routine-open-time"
                  onClick={() => openTimeView(routine.lastRunDate)}
                  className="inline-flex items-center gap-1 rounded border border-line bg-canvas px-2 py-0.5 text-muted hover:border-accent hover:text-fg"
                  title="Open the Time view for this run"
                >
                  <Clock className="h-3 w-3" /> Open Time view
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 text-xs">
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-muted hover:text-fg">
            <input
              type="checkbox"
              data-testid="routine-toggle"
              checked={routine.enabled}
              disabled={busy}
              onChange={(e) =>
                void act(() => toggleRoutine({ id: routine.id, enabled: e.target.checked }))
              }
            />
            <span>{routine.enabled ? "Enabled" : "Off"}</span>
          </label>

          <button
            type="button"
            data-testid="routine-run-now"
            disabled={isRunning}
            onClick={() => void act(() => runRoutine(routine.id))}
            className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-white disabled:opacity-40"
          >
            {isRunning ? (
              <LoaderCircle className="h-3 w-3 animate-spin" />
            ) : (
              <Play className="h-3 w-3" />
            )}
            Run now
          </button>

          <button
            type="button"
            data-testid="routine-edit"
            onClick={() => {
              setName(routine.name);
              setCron(routine.cron);
              setPrompt(routine.prompt ?? "");
              setEditing(!editing);
            }}
            className={btn}
          >
            <Pencil className="inline h-3 w-3" /> Edit
          </button>

          {routine.createdBy !== "builtin" && (
            <button
              type="button"
              data-testid="routine-delete"
              disabled={isRunning}
              onClick={() => void act(() => deleteRoutine(routine.id))}
              className={`${btn} hover:border-bad hover:text-bad`}
            >
              <Trash className="inline h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {editing && (
        <form
          className="space-y-2 rounded-md border border-line bg-canvas p-3 text-xs"
          onSubmit={async (e) => {
            e.preventDefault();
            await act(async () => {
              const res = await saveRoutine({
                id: routine.id,
                name,
                cron,
                ...(routine.kind === "prompt" ? { prompt } : {}),
                enabled: routine.enabled,
              });
              if (!res.error) setEditing(false);
              return res.error;
            });
          }}
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {routine.createdBy !== "builtin" && (
              <label className="block space-y-1">
                <span className="text-muted">Name</span>
                <input
                  data-testid="routine-edit-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={`${field} w-full`}
                />
              </label>
            )}
            <label className="block space-y-1">
              <span className="text-muted">CRON schedule (min hour dom mon dow)</span>
              <input
                data-testid="routine-edit-cron"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                className={`${field} w-full font-mono`}
              />
            </label>
          </div>
          {routine.kind === "prompt" && (
            <label className="block space-y-1">
              <span className="text-muted">Prompt sent to ARIA</span>
              <textarea
                data-testid="routine-edit-prompt"
                rows={2}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className={`${field} w-full`}
              />
            </label>
          )}
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              data-testid="routine-edit-cancel"
              onClick={() => setEditing(false)}
              className={btn}
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="routine-edit-save"
              disabled={busy}
              className="rounded-md bg-accent px-2.5 py-1 text-white disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </form>
      )}

      {error && (
        <div className="text-xs text-bad" data-testid="routine-error">
          {error}
        </div>
      )}
    </div>
  );
}

function AddRoutineForm() {
  const saveRoutine = useAria((s) => s.saveRoutine);
  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 9 * * 1-5");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      data-testid="routine-add-form"
      className="space-y-2.5 rounded-lg border border-line bg-panel p-4 text-xs"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim() || !cron.trim() || !prompt.trim()) return;
        setBusy(true);
        setError(null);
        const res = await saveRoutine({ name, cron, prompt, enabled: true });
        setBusy(false);
        if (res.error) setError(res.error);
        else {
          setName("");
          setPrompt("");
        }
      }}
    >
      <div className="font-medium text-sm text-fg">Add a custom routine</div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-muted">Routine name</span>
          <input
            data-testid="routine-add-name"
            placeholder="Weekday PR & CI check"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={`${field} w-full`}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-muted">CRON schedule</span>
          <input
            data-testid="routine-add-cron"
            placeholder="0 9 * * 1-5"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            className={`${field} w-full font-mono`}
          />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-muted">Prompt sent to ARIA when scheduled</span>
        <textarea
          data-testid="routine-add-prompt"
          rows={2}
          placeholder="Check my active watches and tasks and summarize anything waiting on me."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className={`${field} w-full`}
        />
      </label>
      <div className="flex items-center justify-between gap-2">
        {error ? <span className="text-bad">{error}</span> : <span className="text-muted">Minimum interval: 15 minutes.</span>}
        <button
          type="submit"
          data-testid="routine-add-submit"
          disabled={busy || !name.trim() || !cron.trim() || !prompt.trim()}
          className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1 text-white disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" /> Add routine
        </button>
      </div>
    </form>
  );
}

function ReminderRow({ reminder }: { reminder: Reminder }) {
  const snoozeReminder = useAria((s) => s.snoozeReminder);
  const dismissReminder = useAria((s) => s.dismissReminder);
  const deleteReminder = useAria((s) => s.deleteReminder);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const badgeTone =
    reminder.status === "fired"
      ? "bg-bad/20 text-bad"
      : reminder.status === "done"
        ? "bg-ok/20 text-ok"
        : "bg-raised text-muted";
  const badgeText =
    reminder.status === "fired"
      ? "Due now"
      : reminder.status === "snoozed"
        ? `Snoozed (${reminder.snoozedCount}×)`
        : reminder.status === "done"
          ? "Done"
          : "Scheduled";

  return (
    <div
      data-testid="reminder-row"
      data-reminder-id={reminder.id}
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-panel px-3.5 py-2.5 text-xs"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-raised px-1.5 py-px font-mono text-[11px] text-muted">
            {reminder.shortId}
          </span>
          <span className={`font-medium ${reminder.status === "done" ? "text-muted line-through" : "text-fg"}`}>
            {reminder.text}
          </span>
          <span className={`rounded px-1.5 py-px text-[11px] ${badgeTone}`}>{badgeText}</span>
        </div>
        <div className="text-[11px] text-muted">
          Due: {formatTimestamp(reminder.dueAt)}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {reminder.status !== "done" && (
          <>
            <button
              type="button"
              data-testid="automation-reminder-snooze-15m"
              disabled={busy}
              onClick={() => void act(() => snoozeReminder(reminder.id, 15))}
              className={btn}
            >
              Snooze 15m
            </button>
            <button
              type="button"
              data-testid="automation-reminder-snooze-1h"
              disabled={busy}
              onClick={() => void act(() => snoozeReminder(reminder.id, 60))}
              className={btn}
            >
              Snooze 1h
            </button>
            <button
              type="button"
              data-testid="automation-reminder-done"
              disabled={busy}
              onClick={() => void act(() => dismissReminder(reminder.id))}
              className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-white disabled:opacity-40"
            >
              <Check className="h-3 w-3" /> Done
            </button>
          </>
        )}
        <button
          type="button"
          data-testid="automation-reminder-delete"
          disabled={busy}
          onClick={() => void act(() => deleteReminder(reminder.id))}
          className={`${btn} hover:border-bad hover:text-bad`}
        >
          <Trash className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function AddReminderForm() {
  const createReminder = useAria((s) => s.createReminder);
  const [text, setText] = useState("");
  const [minutes, setMinutes] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      data-testid="reminder-add-form"
      className="space-y-2 rounded-lg border border-line bg-panel p-4 text-xs"
      onSubmit={async (e) => {
        e.preventDefault();
        const inMinutes = Number(minutes);
        if (!text.trim() || !Number.isFinite(inMinutes) || inMinutes < 1) return;
        setBusy(true);
        setError(null);
        const res = await createReminder({ text, inMinutes });
        setBusy(false);
        if (res.error) setError(res.error);
        else setText("");
      }}
    >
      <div className="font-medium text-sm text-fg">Add a reminder</div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          data-testid="reminder-add-text"
          placeholder="Check deployment status before lunch"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className={`${field} min-w-48 flex-1`}
        />
        <label className="inline-flex items-center gap-1.5 text-muted">
          <span>In</span>
          <input
            type="number"
            min={1}
            max={43200}
            data-testid="reminder-add-minutes"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            className={`${field} w-20`}
          />
          <span>min</span>
        </label>
        <button
          type="submit"
          data-testid="reminder-add-submit"
          disabled={busy || !text.trim()}
          className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1 text-white disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" /> Add reminder
        </button>
      </div>
      {error && <div className="text-bad">{error}</div>}
    </form>
  );
}

/**
 * Automations view (Phase 6B, PLAN.md §5.1, §5.2, §10 Phase 6B): manage built-in and custom routines, trigger Run now,
 * and manage reminders.
 */
export function AutomationsView() {
  const routines = useAria((s) => s.routines);
  const reminders = useAria((s) => s.reminders);

  return (
    <div className="flex h-full flex-col" data-testid="automations-view">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarToggle />
          <CalendarClock className="h-4 w-4 text-accent" />
          <h1 className="font-semibold">Automations</h1>
        </div>
        <div className="text-xs text-muted">
          Scheduled routines, daily time-tracking drafts, morning brief and reminders
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-4xl space-y-6">
          <section className="space-y-3" data-testid="automations-routines-section">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-accent" />
              <h2 className="font-medium">Routines ({routines.length})</h2>
            </div>
            <div className="space-y-2.5">
              {routines.map((r) => (
                <RoutineRow key={r.id} routine={r} />
              ))}
            </div>
            <AddRoutineForm />
          </section>

          <section className="space-y-3" data-testid="automations-reminders-section">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-accent" />
              <h2 className="font-medium">Reminders ({reminders.length})</h2>
            </div>
            {reminders.length === 0 ? (
              <div className="rounded-lg border border-line bg-panel p-4 text-xs text-muted">
                No reminders yet. Ask ARIA “remind me in 30 minutes to…” in the chat or add one below.
              </div>
            ) : (
              <div className="space-y-2">
                {reminders.map((rem) => (
                  <ReminderRow key={rem.id} reminder={rem} />
                ))}
              </div>
            )}
            <AddReminderForm />
          </section>
        </div>
      </div>
    </div>
  );
}
