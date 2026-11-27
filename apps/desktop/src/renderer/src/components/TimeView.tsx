/**
 * Phase 5D: Time view (PLAN.md §4.14, §5.1, §5.2, §10 Phase 5D):
 * - Monday–Sunday ISO week overview strip with Prev / Today / Next week controls
 * - Selected day's draft and registered entries, with the activity behind each entry
 * - One-click Submit, inline registered-entry Update, and explicit ID-confirmed Delete, through the tracker's time-log
 *   tools
 * - Collected day activities with local git scan and the Mapping rules editor (`time_rules`)
 */
import type { Activity, TimeRule, TimeRuleKind, TimeRuleMatchMode, TimesheetEntry, TimesheetOverlapDetail, TimesheetRegisteredEntry } from "@aria/protocol";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Trash,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAria, useTracker, useTracksTime } from "../store";
import { formatHoursMinutes } from "./Cards";
import { deleteCall, openTrackerTask, ownsTask, trackerLabel, trackerRef, viaCreateTool } from "../tracker";

const COMPLETE_ISO_DATE = /^[1-9]\d{3}-\d{2}-\d{2}$/;

/** An activity without the task an earlier tracker linked or a rule mapped: with no tracker there is no task to show. */
function withoutTask(a: Activity): Activity {
  const { linkedTrackerTaskId: _linked, resolvedTask: _resolved, ...rest } = a;
  return rest;
}

function shiftIsoDate(date: string, deltaDays: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + deltaDays, 12, 0, 0));
  return dt.toISOString().slice(0, 10);
}

function formatEpochHHMM(ms: number, timeZone?: string): string {
  try {
    return new Date(ms).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(timeZone ? { timeZone } : {}),
    });
  } catch {
    return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  }
}

interface DraftEditorState {
  entryId?: string;
  start: string;
  end: string;
  trackerTaskId: string;
  trackerTaskTitle: string;
  trackerProjectId: string;
  trackerCustomerId: string;
  comment: string;
}

interface RegisteredEditorState {
  trackerEntryId: string;
  start: string;
  end: string;
  trackerTaskId: string;
  trackerTaskTitle: string;
  trackerProjectId: string;
  trackerCustomerId: string;
  comment: string;
}

interface RuleFormState {
  id?: string;
  kind: TimeRuleKind;
  repoId?: number;
  pattern: string;
  matchMode: TimeRuleMatchMode;
  trackerTaskId: string;
  trackerTaskTitle: string;
  defaultMinutes: string;
  enabled: boolean;
}

const RULE_KIND_LABELS: Record<TimeRuleKind, string> = {
  repo: "Project / repo",
  branch: "Git branch",
  meeting_title: "Meeting title",
  meeting_organizer: "Meeting organizer",
  teams_channel: "Teams channel",
  mail_subject: "Email subject",
  mail_recipient: "Email recipient",
};

function roundTo15Min(ms: number): number {
  const rawMin = Math.max(15, Math.round(ms / 60_000));
  return Math.max(15, Math.round(rawMin / 15) * 15);
}

function normalizeHHMM(raw: string): string {
  const trimmed = raw.trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!m) return trimmed;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh === 24 && mm === 0) return "24:00";
  if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  return trimmed;
}

function addMinutesHHMM(startHhmm: string, deltaMin: number): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(startHhmm.trim());
  const base = m ? Number(m[1]) * 60 + Number(m[2]) : 540;
  const total = Math.min(1440, Math.max(base + 15, base + deltaMin));
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function effectiveDraftComment(d: DraftEditorState): string {
  return (
    d.comment.trim() ||
    d.trackerTaskTitle.trim() ||
    (d.trackerTaskId.trim() ? `Task #${d.trackerTaskId.trim().replace(/^#/, "")}` : "")
  );
}

function toDraftEditor(entry?: TimesheetEntry, defaultStart = "09:00", defaultEnd = "10:00"): DraftEditorState {
  return {
    ...(entry ? { entryId: entry.id } : {}),
    start: entry?.start ?? defaultStart,
    end: entry?.end ?? defaultEnd,
    trackerTaskId: entry?.trackerTaskId ?? "",
    trackerTaskTitle: entry?.trackerTaskTitle ?? "",
    trackerProjectId: entry?.trackerProjectId ?? "",
    trackerCustomerId: entry?.trackerCustomerId ?? "",
    comment: entry?.comment ?? "",
  };
}

function toRegisteredEditor(reg: TimesheetRegisteredEntry): RegisteredEditorState {
  return {
    trackerEntryId: reg.id,
    start: reg.start,
    end: reg.end,
    trackerTaskId: reg.trackerTaskId,
    trackerTaskTitle: reg.trackerTaskTitle ?? "",
    trackerProjectId: reg.trackerProjectId ?? "",
    trackerCustomerId: reg.trackerCustomerId ?? "",
    comment: reg.comment ?? "",
  };
}

export function TimeView() {
  const timeView = useAria((s) => s.timeView);
  const tracker = useTracker();
  // Whether the day's rows have tasks and go to a tracker: with no tracker, or one without time logs, they have times and comments only.
  const tracksTime = useTracksTime();
  const trackerName = trackerLabel(tracker);
  const selectedTimeDate = useAria((s) => s.ui.selectedTimeDate);
  const timeRules = useAria((s) => s.timeRules);
  const projects = useAria((s) => s.projects).filter((p) => !p.hidden);
  const trackerTasks = useAria((s) => s.myWork?.tracker?.tasks);
  const loadTimeView = useAria((s) => s.loadTimeView);
  const prepareTimesheet = useAria((s) => s.prepareTimesheet);
  const updateTimesheetEntry = useAria((s) => s.updateTimesheetEntry);
  const confirmTimesheetEntry = useAria((s) => s.confirmTimesheetEntry);
  const deleteTimesheetEntry = useAria((s) => s.deleteTimesheetEntry);
  const acceptRuleOffer = useAria((s) => s.acceptTimesheetRuleOffer);
  const dismissRuleOffer = useAria((s) => s.dismissTimesheetRuleOffer);
  const submitTimesheet = useAria((s) => s.submitTimesheet);
  const updateRegisteredEntry = useAria((s) => s.updateRegisteredEntry);
  const deleteRegisteredEntries = useAria((s) => s.deleteRegisteredEntries);
  const listActivities = useAria((s) => s.listActivities);
  const saveTimeRule = useAria((s) => s.saveTimeRule);
  const deleteTimeRule = useAria((s) => s.deleteTimeRule);

  const [draftEditor, setDraftEditor] = useState<DraftEditorState | null>(null);
  const [regEditor, setRegEditor] = useState<RegisteredEditorState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TimesheetRegisteredEntry | null>(null);
  const deleteTargetCall = deleteTarget ? deleteCall(tracker, deleteTarget.id) : undefined;
  const [deleteTickedForId, setDeleteTickedForId] = useState<string | null>(null);
  const [ruleForm, setRuleForm] = useState<RuleFormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [prepareProgress, setPrepareProgress] = useState(0);
  const [prepareStage, setPrepareStage] = useState("");
  const prepareTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const [error, setError] = useState<string | null>(null);
  const dateInputRef = useRef<HTMLInputElement | null>(null);
  const isDateFocusedRef = useRef(false);
  const lastKeyDownAtRef = useRef(0);
  const dateCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timeView && (!selectedTimeDate || timeView.selectedDate === selectedTimeDate)) return;
    void loadTimeView(selectedTimeDate);
  }, [loadTimeView, selectedTimeDate, timeView]);

  useEffect(() => {
    const el = dateInputRef.current;
    if (!el || !timeView?.selectedDate) return;
    if (!isDateFocusedRef.current && dateCommitTimerRef.current === null && el.value !== timeView.selectedDate) {
      el.value = timeView.selectedDate;
    }
  }, [timeView?.selectedDate]);

  useEffect(
    () => () => {
      if (dateCommitTimerRef.current !== null) {
        clearTimeout(dateCommitTimerRef.current);
        dateCommitTimerRef.current = null;
      }
      prepareTimersRef.current.forEach(clearTimeout);
      prepareTimersRef.current = [];
    },
    [],
  );

  if (!timeView) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted" data-testid="time-view-loading">
        Loading Time view…
      </div>
    );
  }

  const { selectedDate, days, day } = timeView;
  // With no tracker the day's activities have no task: a tracker's own updates are left out, and what an earlier tracker linked isn't shown.
  const activities = tracksTime ? timeView.activities : timeView.activities.filter((a) => a.source !== "tracker").map(withoutTask);

  const conflicts: Array<{
    id: string;
    sourceId: string;
    sourceType: "draft" | "tracker";
    sourceStart: string;
    sourceEnd: string;
    sourceLabel: string;
    targetId: string;
    targetType: "draft" | "tracker";
    targetStart: string;
    targetEnd: string;
    targetLabel: string;
    overlapStart: string;
    overlapEnd: string;
    overlapMinutes: number;
  }> = [];

  const seenConflictPairs = new Set<string>();
  const recordConflict = (
    sId: string,
    sType: "draft" | "tracker",
    sStart: string,
    sEnd: string,
    sLabel: string,
    od: TimesheetOverlapDetail,
  ) => {
    const pairKey = [sId, od.targetId].sort().join("::");
    if (seenConflictPairs.has(pairKey)) return;
    seenConflictPairs.add(pairKey);
    conflicts.push({
      id: pairKey,
      sourceId: sId,
      sourceType: sType,
      sourceStart: sStart,
      sourceEnd: sEnd,
      sourceLabel: sLabel,
      targetId: od.targetId,
      targetType: od.targetType,
      targetStart: od.targetStart,
      targetEnd: od.targetEnd,
      targetLabel: od.targetLabel ?? (od.targetType === "tracker" ? `#${od.targetId}` : "draft"),
      overlapStart: od.overlapStart,
      overlapEnd: od.overlapEnd,
      overlapMinutes: od.overlapMinutes,
    });
  };

  for (const e of day.entries) {
    if (e.overlapDetails) {
      for (const od of e.overlapDetails) {
        recordConflict(
          e.id,
          "draft",
          e.start,
          e.end,
          e.comment || (e.trackerTaskId ? `#${e.trackerTaskId}` : "Draft"),
          od,
        );
      }
    }
  }

  for (const r of day.registered) {
    if (r.overlapDetails) {
      for (const od of r.overlapDetails) {
        recordConflict(
          r.id,
          "tracker",
          r.start,
          r.end,
          r.comment || (r.trackerTaskId ? trackerRef(tracker, r.trackerTaskId) : trackerRef(tracker, r.id)),
          od,
        );
      }
    }
  }

  for (const e of day.entries) {
    if ((e.overlap || e.overlapsTrackerId) && (!e.overlapDetails || e.overlapDetails.length === 0)) {
      const fallbackKey = `fallback-overlap-${e.id}`;
      if (!seenConflictPairs.has(fallbackKey)) {
        seenConflictPairs.add(fallbackKey);
        conflicts.push({
          id: fallbackKey,
          sourceId: e.id,
          sourceType: "draft",
          sourceStart: e.start,
          sourceEnd: e.end,
          sourceLabel: e.comment || (e.trackerTaskId ? `#${e.trackerTaskId}` : "Draft"),
          targetId: e.overlapsTrackerId ? `${tracker?.id ?? "tracker"}-${e.overlapsTrackerId}` : "other-draft",
          targetType: e.overlapsTrackerId ? "tracker" : "draft",
          targetStart: "?",
          targetEnd: "?",
          targetLabel: e.overlapsTrackerId ? trackerRef(tracker, e.overlapsTrackerId) : "another draft row",
          overlapStart: e.start,
          overlapEnd: e.end,
          overlapMinutes: e.minutes,
        });
      }
    }
  }

  const canSubmit =
    day.entries.length > 0 &&
    day.uncertainCount === 0 &&
    day.overlapCount === 0 &&
    day.duplicateCount === 0 &&
    day.entries.every((e) => Boolean(e.trackerTaskId));

  const lookupKnownTask = (rawTask: string): { title: string; projectId: string; customerId: string } | null => {
    const idMatch = /(\d+)\s*$/.exec(rawTask.trim());
    const id = idMatch ? idMatch[1]! : rawTask.trim();
    if (!id) return null;
    const fromMyWork = trackerTasks?.find((t) => t.taskId === id);
    if (fromMyWork && (fromMyWork.projectId || fromMyWork.customerId || fromMyWork.title)) {
      return {
        title: fromMyWork.title ?? "",
        projectId: fromMyWork.projectId ?? "",
        customerId: fromMyWork.customerId ?? "",
      };
    }
    const fromDraft = day.entries.find((e) => e.trackerTaskId === id && (e.trackerProjectId || e.trackerCustomerId || e.trackerTaskTitle));
    if (fromDraft) {
      return {
        title: fromDraft.trackerTaskTitle ?? "",
        projectId: fromDraft.trackerProjectId ?? "",
        customerId: fromDraft.trackerCustomerId ?? "",
      };
    }
    const fromReg = day.registered.find((r) => r.trackerTaskId === id && (r.trackerProjectId || r.trackerCustomerId || r.trackerTaskTitle));
    if (fromReg) {
      return {
        title: fromReg.trackerTaskTitle ?? "",
        projectId: fromReg.trackerProjectId ?? "",
        customerId: fromReg.trackerCustomerId ?? "",
      };
    }
    return null;
  };

  const defaultNewEntrySlot = (): { start: string; end: string } => {
    if (day.gaps.length > 0) {
      return { start: day.gaps[0]!.start, end: day.gaps[0]!.end };
    }
    const allEnds = [...day.entries.map((e) => e.end), ...day.registered.map((r) => r.end)];
    let maxEndMin = -1;
    for (const endStr of allEnds) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(endStr.trim());
      if (m) {
        const mins = Number(m[1]) * 60 + Number(m[2]);
        if (mins > maxEndMin) maxEndMin = mins;
      }
    }
    if (maxEndMin >= 0 && maxEndMin <= 1440 - 15) {
      const start = `${String(Math.floor(maxEndMin / 60)).padStart(2, "0")}:${String(maxEndMin % 60).padStart(2, "0")}`;
      return { start, end: addMinutesHHMM(start, 60) };
    }
    return { start: "09:00", end: "10:00" };
  };

  const runAction = async (fn: () => Promise<string | null>, onSuccess?: () => void) => {
    setBusy(true);
    setError(null);
    const err = await fn();
    setBusy(false);
    if (err) setError(err);
    else onSuccess?.();
  };

  const handlePrepareDraft = async () => {
    if (busy || preparing) return;
    setPreparing(true);
    setBusy(true);
    setError(null);
    setPrepareProgress(15);
    setPrepareStage("Scanning git commits and calendar events…");

    prepareTimersRef.current.forEach(clearTimeout);
    prepareTimersRef.current = [];

    const schedule = (ms: number, progress: number, stage: string) => {
      const timer = setTimeout(() => {
        setPrepareProgress(progress);
        setPrepareStage(stage);
      }, ms);
      prepareTimersRef.current.push(timer);
    };

    schedule(800, 35, tracksTime ? "Reading activities & matching rules…" : "Reading activities…");
    schedule(2000, 60, tracksTime ? `Querying ${trackerName} tasks & time logs…` : "Reading your calendar & mail…");
    schedule(4000, 80, "Clustering activities & drafting rows…");
    schedule(6500, 92, "Finalizing timesheet draft…");

    const err = await prepareTimesheet(selectedDate);
    prepareTimersRef.current.forEach(clearTimeout);
    prepareTimersRef.current = [];

    if (err) {
      setPreparing(false);
      setBusy(false);
      setError(err);
    } else {
      setPrepareProgress(100);
      setPrepareStage("Draft ready!");
      const finishTimer = setTimeout(() => {
        setPreparing(false);
        setBusy(false);
      }, 350);
      prepareTimersRef.current.push(finishTimer);
    }
  };

  const selectDate = (date?: string, options?: { fromDateInput?: boolean }) => {
    if (dateCommitTimerRef.current !== null) {
      clearTimeout(dateCommitTimerRef.current);
      dateCommitTimerRef.current = null;
    }
    if (!options?.fromDateInput && date && dateInputRef.current && dateInputRef.current.value !== date) {
      dateInputRef.current.value = date;
    }
    setDraftEditor(null);
    setRegEditor(null);
    setDeleteTarget(null);
    setDeleteTickedForId(null);
    setError(null);
    void loadTimeView(date).then(() => {
      const latest = useAria.getState().timeView?.selectedDate;
      if (!options?.fromDateInput && !isDateFocusedRef.current && dateCommitTimerRef.current === null && latest && dateInputRef.current && dateInputRef.current.value !== latest) {
        dateInputRef.current.value = latest;
      }
    });
  };

  const field = "rounded border border-line bg-canvas px-1.5 py-0.5 text-xs text-fg outline-none focus:border-accent";
  const btn = "inline-flex items-center gap-1 rounded border border-line bg-raised px-2 py-1 text-xs text-fg hover:border-accent disabled:opacity-50";
  const btnPrimary = "inline-flex items-center gap-1 rounded bg-accent px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50";

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-canvas text-xs" data-testid="time-view">
      {/* Top header & Week strip */}
      <header className="border-b border-line bg-panel px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-accent" />
            <h1 className="text-sm font-semibold">{tracksTime ? <>Time &amp; {trackerName} Registration</> : "Time"}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              data-testid="time-prev-week"
              disabled={busy}
              onClick={() => selectDate(shiftIsoDate(selectedDate, -7))}
              className={btn}
              title="Previous week"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Prev week
            </button>
            <button
              type="button"
              data-testid="time-today"
              disabled={busy}
              onClick={() => selectDate(undefined)}
              className={btn}
            >
              Today
            </button>
            <button
              type="button"
              data-testid="time-next-week"
              disabled={busy}
              onClick={() => selectDate(shiftIsoDate(selectedDate, 7))}
              className={btn}
              title="Next week"
            >
              Next week <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <input
              ref={dateInputRef}
              type="date"
              aria-label="Selected date"
              data-testid="time-date-picker"
              defaultValue={selectedDate}
              onFocus={() => {
                isDateFocusedRef.current = true;
              }}
              onKeyDown={(e) => {
                lastKeyDownAtRef.current = Date.now();
                if (e.key === "Enter") {
                  const val = e.currentTarget.value;
                  if (COMPLETE_ISO_DATE.test(val) && val !== selectedDate) {
                    selectDate(val, { fromDateInput: true });
                  }
                } else if (e.key === "Escape") {
                  if (dateCommitTimerRef.current !== null) {
                    clearTimeout(dateCommitTimerRef.current);
                    dateCommitTimerRef.current = null;
                  }
                  e.currentTarget.value = selectedDate;
                }
              }}
              onChange={(e) => {
                const next = e.target.value;
                if (dateCommitTimerRef.current !== null) {
                  clearTimeout(dateCommitTimerRef.current);
                  dateCommitTimerRef.current = null;
                }
                if (!COMPLETE_ISO_DATE.test(next) || next === selectedDate) return;
                const isKeyboardEdit = Date.now() - lastKeyDownAtRef.current < 250;
                if (isKeyboardEdit) {
                  dateCommitTimerRef.current = setTimeout(() => {
                    dateCommitTimerRef.current = null;
                    selectDate(next, { fromDateInput: true });
                  }, 700);
                } else {
                  selectDate(next, { fromDateInput: true });
                }
              }}
              onBlur={(e) => {
                isDateFocusedRef.current = false;
                if (dateCommitTimerRef.current !== null) {
                  clearTimeout(dateCommitTimerRef.current);
                  dateCommitTimerRef.current = null;
                }
                const val = e.currentTarget.value;
                if (COMPLETE_ISO_DATE.test(val)) {
                  if (val !== selectedDate) {
                    selectDate(val, { fromDateInput: true });
                  }
                } else {
                  e.currentTarget.value = selectedDate;
                }
              }}
              className={field}
            />
          </div>
        </div>

        {/* 7-day Monday-Sunday week strip */}
        <div className="mt-3 grid grid-cols-7 gap-1.5" data-testid="time-week-strip">
          {days.map((d) => {
            const isSelected = d.date === selectedDate;
            const hasIssues = d.uncertainCount > 0 || d.overlapCount > 0 || d.duplicateCount > 0 || d.failedCount > 0;
            const isComplete = !d.isWeekend && d.expectedMinutes > 0 && d.registeredMinutes >= d.expectedMinutes && d.draftCount === 0;
            return (
              <button
                key={d.date}
                type="button"
                data-testid="time-week-day"
                data-date={d.date}
                data-selected={isSelected}
                onClick={() => selectDate(d.date)}
                className={`flex flex-col items-start rounded border p-2 text-left transition-colors ${
                  isSelected
                    ? "border-accent bg-accent/10"
                    : "border-line bg-canvas hover:border-accent/50"
                }`}
              >
                <div className="flex w-full items-center justify-between gap-1">
                  <span className={`font-medium ${d.isToday ? "text-accent" : "text-fg"}`}>{d.dateLabel}</span>
                  {isComplete && <Check className="h-3 w-3 text-ok" />}
                  {!isComplete && hasIssues && <TriangleAlert className="h-3 w-3 text-warn" />}
                </div>
                <div className="mt-1 font-mono text-[11px] text-muted" data-testid="time-week-day-total">
                  {formatHoursMinutes(d.dayTotalMinutes)}
                  {d.expectedMinutes > 0 ? ` / ${formatHoursMinutes(d.expectedMinutes)}` : ""}
                </div>
                <div className="mt-0.5 text-[10px] text-muted">
                  {d.registeredMinutes > 0 ? `${formatHoursMinutes(d.registeredMinutes)} reg` : ""}
                  {d.registeredMinutes > 0 && d.draftMinutes > 0 ? " · " : ""}
                  {d.draftMinutes > 0 ? `${formatHoursMinutes(d.draftMinutes)} draft` : ""}
                  {d.registeredMinutes === 0 && d.draftMinutes === 0 ? (d.isWeekend ? "Weekend" : "No entries") : ""}
                </div>
              </button>
            );
          })}
        </div>
      </header>

      <div className="mx-auto w-full max-w-5xl space-y-5 p-4">
        {/* Selected Day Summary & Actions */}
        <section className="rounded-md border border-line bg-panel p-3" data-testid="time-day-section">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold" data-testid="time-day-summary">
                {day.dateLabel} ({day.date}) ·{" "}
                <span className="font-normal text-muted">
                  draft {formatHoursMinutes(day.draftMinutes)}
                  {day.registeredMinutes > 0 ? ` + ${formatHoursMinutes(day.registeredMinutes)} registered` : ""} of{" "}
                  {formatHoursMinutes(day.expectedMinutes)}
                  {day.gaps.length > 0 ? ` · ${day.gaps.length} gap${day.gaps.length === 1 ? "" : "s"}` : ""}
                  {day.uncertainCount > 0 ? ` · ${day.uncertainCount} uncertain` : ""}
                  {day.overlapCount > 0 ? ` · ${day.overlapCount} overlap${day.overlapCount === 1 ? "" : "s"}` : ""}
                  {day.duplicateCount > 0 ? ` · ${day.duplicateCount} duplicate${day.duplicateCount === 1 ? "" : "s"}` : ""}
                </span>
              </div>
              <div className="mt-0.5 text-[11px] text-muted">Time zone: {day.timeZone}</div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                data-testid="time-prepare"
                disabled={busy}
                onClick={() => void handlePrepareDraft()}
                className={btn}
              >
                <RotateCcw className={`h-3.5 w-3.5 ${preparing ? "animate-spin text-accent" : ""}`} />{" "}
                {preparing ? "Preparing draft…" : day.entries.length > 0 ? "Refresh draft" : "Prepare draft"}
              </button>
              <button
                type="button"
                data-testid="time-add-entry"
                disabled={busy}
                onClick={() => {
                  const slot = defaultNewEntrySlot();
                  setDraftEditor(toDraftEditor(undefined, slot.start, slot.end));
                }}
                className={btn}
              >
                <Plus className="h-3.5 w-3.5" /> Add entry
              </button>
              {tracksTime && day.entries.length > 0 && (
                <button
                  type="button"
                  data-testid="time-submit"
                  disabled={busy || !canSubmit}
                  title={
                    canSubmit
                      ? `Submit approved draft rows to ${trackerName}${viaCreateTool(tracker)}`
                      : "Confirm uncertain rows and resolve overlaps/duplicates before submitting"
                  }
                  onClick={() => void runAction(() => submitTimesheet(selectedDate))}
                  className={btnPrimary}
                >
                  <Check className="h-3.5 w-3.5" /> {busy ? "Submitting…" : `Submit to ${trackerName}`}
                </button>
              )}
            </div>
          </div>

          {/* Preparing draft progress bar */}
          {preparing && (
            <div
              className="mt-3 rounded-md border border-accent/40 bg-accent/5 p-3 text-xs"
              data-testid="time-prepare-progress"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 font-medium text-accent">
                  <RotateCcw className="h-3.5 w-3.5 animate-spin" />
                  Preparing timesheet draft…
                </span>
                <span className="font-mono text-[11px] font-semibold text-accent">
                  {Math.round(prepareProgress)}%
                </span>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-raised">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-300 ease-out"
                  style={{ width: `${Math.min(100, Math.max(0, prepareProgress))}%` }}
                />
              </div>
              <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted">
                <span className="truncate">{prepareStage}</span>
                <span className="shrink-0 text-[10px]">AI-assisted clustering</span>
              </div>
            </div>
          )}

          {error && (
            <div className="mt-2 rounded border border-bad/50 bg-bad/10 px-2.5 py-1.5 text-xs text-bad" data-testid="time-view-error">
              {error}
            </div>
          )}

          {/* Uncovered gaps */}
          {day.gaps.length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5" data-testid="time-gaps">
              <span className="text-warn">Uncovered gaps:</span>
              {day.gaps.map((gap) => (
                <button
                  key={`${gap.start}-${gap.end}`}
                  type="button"
                  data-testid="time-fill-gap"
                  disabled={busy}
                  onClick={() => setDraftEditor(toDraftEditor(undefined, gap.start, gap.end))}
                  className="inline-flex items-center gap-1 rounded border border-warn/50 bg-warn/10 px-1.5 py-0.5 font-mono text-[11px] text-warn hover:border-warn"
                >
                  <Plus className="h-3 w-3" /> {gap.start}–{gap.end} ({formatHoursMinutes(gap.minutes)})
                </button>
              ))}
            </div>
          )}

          {/* Overlaps detected banner */}
          {conflicts.length > 0 && (
            <div className="mt-2.5 rounded border border-bad/50 bg-bad/10 p-2.5 text-xs" data-testid="time-overlaps-banner">
              <div className="flex items-center gap-1.5 font-semibold text-bad">
                <TriangleAlert className="h-4 w-4 shrink-0" />
                <span>
                  {conflicts.length} overlapping time slot{conflicts.length === 1 ? "" : "s"} detected:
                </span>
              </div>
              <div className="mt-2 space-y-1.5">
                {conflicts.map((c) => {
                  const draftTarget = day.entries.find((e) => e.id === c.sourceId || e.id === c.targetId);
                  return (
                    <div
                      key={c.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded border border-bad/30 bg-canvas/70 px-2.5 py-1.5"
                      data-testid="time-overlap-item"
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium text-fg">
                          {c.sourceType === "tracker" ? trackerRef(tracker, c.sourceId) : "Draft"} ({c.sourceStart}–{c.sourceEnd})
                          {c.sourceLabel ? ` · ${c.sourceLabel}` : ""}
                        </span>
                        <span className="text-bad">overlaps with</span>
                        <span className="font-medium text-fg">
                          {c.targetType === "tracker" ? trackerRef(tracker, c.targetId) : "Draft"} ({c.targetStart}–{c.targetEnd})
                          {c.targetLabel ? ` · ${c.targetLabel}` : ""}
                        </span>
                        <span className="rounded bg-bad/20 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-bad">
                          {c.overlapStart}–{c.overlapEnd} ({formatHoursMinutes(c.overlapMinutes)})
                        </span>
                      </div>
                      {draftTarget && (
                        <button
                          type="button"
                          data-testid="time-overlap-fix"
                          disabled={busy}
                          onClick={() => setDraftEditor(toDraftEditor(draftTarget))}
                          className={btn}
                        >
                          <Pencil className="h-3 w-3" /> Edit {draftTarget.start}–{draftTarget.end}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Learning rule offers */}
          {(tracksTime ? day.ruleOffers : []).map((offer) => (
            <div
              key={offer.id}
              data-testid="time-rule-offer"
              className="mt-2.5 flex flex-wrap items-center gap-2 rounded border border-accent/50 bg-accent/10 px-2.5 py-1.5"
            >
              <span className="min-w-0 flex-1">{offer.prompt}</span>
              <button
                type="button"
                data-testid="time-rule-offer-accept"
                disabled={busy}
                onClick={() => void runAction(() => acceptRuleOffer(selectedDate, offer.id))}
                className={btnPrimary}
              >
                Save rule
              </button>
              <button
                type="button"
                data-testid="time-rule-offer-dismiss"
                disabled={busy}
                onClick={() => void runAction(() => dismissRuleOffer(selectedDate, offer.id))}
                className={btn}
              >
                Dismiss
              </button>
            </div>
          ))}

          {/* Draft Entries */}
          <div className="mt-3 space-y-1.5" data-testid="time-draft-section">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Draft entries ({formatHoursMinutes(day.draftMinutes)})
            </div>
            {day.entries.length === 0 && !draftEditor && (
              <div className="text-muted">
                {preparing ? (
                  <span className="inline-flex items-center gap-1.5 text-accent">
                    <RotateCcw className="h-3.5 w-3.5 animate-spin" />
                    Generating draft entries from your activity…
                  </span>
                ) : (
                  "No draft rows for this day."
                )}
              </div>
            )}
            {day.entries.map((entry) => {
              const isEditingThis = draftEditor?.entryId === entry.id;
              if (isEditingThis && draftEditor) {
                const saveExistingDraft = () => {
                  const commentToSave = effectiveDraftComment(draftEditor);
                  if (busy || !commentToSave) return;
                  void runAction(
                    () =>
                      updateTimesheetEntry({
                        date: selectedDate,
                        entryId: entry.id,
                        start: normalizeHHMM(draftEditor.start),
                        end: normalizeHHMM(draftEditor.end),
                        ...(draftEditor.trackerTaskId.trim() ? { trackerTaskId: draftEditor.trackerTaskId.trim() } : {}),
                        ...(draftEditor.trackerTaskTitle.trim() ? { trackerTaskTitle: draftEditor.trackerTaskTitle.trim() } : {}),
                        ...(draftEditor.trackerProjectId.trim() ? { trackerProjectId: draftEditor.trackerProjectId.trim() } : {}),
                        ...(draftEditor.trackerCustomerId.trim() ? { trackerCustomerId: draftEditor.trackerCustomerId.trim() } : {}),
                        comment: commentToSave,
                      }),
                    () => setDraftEditor(null),
                  );
                };
                return (
                  <div
                    key={entry.id}
                    className="space-y-2 rounded border border-accent/60 bg-canvas p-2.5"
                    data-testid="time-draft-editor"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        saveExistingDraft();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setDraftEditor(null);
                      }
                    }}
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-muted">Rough duration (±15m):</span>
                      {[15, 30, 45, 60, 90, 120, 240].map((presetMin) => (
                        <button
                          key={presetMin}
                          type="button"
                          onClick={() =>
                            setDraftEditor({
                              ...draftEditor,
                              end: addMinutesHHMM(draftEditor.start, presetMin),
                            })
                          }
                          className={btn}
                        >
                          ~{formatHoursMinutes(presetMin)}
                        </button>
                      ))}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="inline-flex items-center gap-1">
                        <span className="text-muted">Start</span>
                        <input
                          data-testid="time-draft-edit-start"
                          value={draftEditor.start}
                          onChange={(e) => setDraftEditor({ ...draftEditor, start: e.target.value })}
                          onBlur={(e) => setDraftEditor({ ...draftEditor, start: normalizeHHMM(e.target.value) })}
                          className={`${field} w-16 font-mono`}
                        />
                      </label>
                      <label className="inline-flex items-center gap-1">
                        <span className="text-muted">End</span>
                        <input
                          data-testid="time-draft-edit-end"
                          value={draftEditor.end}
                          onChange={(e) => setDraftEditor({ ...draftEditor, end: e.target.value })}
                          onBlur={(e) => setDraftEditor({ ...draftEditor, end: normalizeHHMM(e.target.value) })}
                          className={`${field} w-16 font-mono`}
                        />
                      </label>
                      {tracksTime && (
                        <>
                      <label className="inline-flex items-center gap-1">
                        <span className="text-muted">{trackerName} task</span>
                        <input
                          data-testid="time-draft-edit-task"
                          value={draftEditor.trackerTaskId}
                          onChange={(e) => {
                            const nextTask = e.target.value;
                            const changed = nextTask.trim() !== draftEditor.trackerTaskId.trim();
                            const resolved = changed ? lookupKnownTask(nextTask) : null;
                            const clearFromOriginal =
                              changed && !resolved && nextTask.trim() !== (entry.trackerTaskId ?? "").trim();
                            setDraftEditor({
                              ...draftEditor,
                              trackerTaskId: nextTask,
                              ...(resolved
                                ? {
                                    trackerTaskTitle: resolved.title,
                                    trackerProjectId: resolved.projectId,
                                    trackerCustomerId: resolved.customerId,
                                  }
                                : clearFromOriginal
                                  ? {
                                      ...(draftEditor.trackerTaskTitle === (entry.trackerTaskTitle ?? "")
                                        ? { trackerTaskTitle: "" }
                                        : {}),
                                      ...(draftEditor.trackerProjectId === (entry.trackerProjectId ?? "")
                                        ? { trackerProjectId: "" }
                                        : {}),
                                      ...(draftEditor.trackerCustomerId === (entry.trackerCustomerId ?? "")
                                        ? { trackerCustomerId: "" }
                                        : {}),
                                    }
                                  : {}),
                            });
                          }}
                          placeholder="Task ID"
                          className={`${field} w-28 font-mono`}
                        />
                      </label>
                      <label className="inline-flex items-center gap-1">
                        <span className="text-muted">Task title</span>
                        <input
                          data-testid="time-draft-edit-task-title"
                          value={draftEditor.trackerTaskTitle}
                          onChange={(e) => setDraftEditor({ ...draftEditor, trackerTaskTitle: e.target.value })}
                          placeholder="Auto"
                          className={`${field} w-36`}
                        />
                      </label>
                      <label className="inline-flex items-center gap-1">
                        <span className="text-muted">Project ID</span>
                        <input
                          data-testid="time-draft-edit-project"
                          value={draftEditor.trackerProjectId}
                          onChange={(e) => setDraftEditor({ ...draftEditor, trackerProjectId: e.target.value })}
                          placeholder="Auto"
                          className={`${field} w-20 font-mono`}
                        />
                      </label>
                      <label className="inline-flex items-center gap-1">
                        <span className="text-muted">Customer ID</span>
                        <input
                          data-testid="time-draft-edit-customer"
                          value={draftEditor.trackerCustomerId}
                          onChange={(e) => setDraftEditor({ ...draftEditor, trackerCustomerId: e.target.value })}
                          placeholder="Auto"
                          className={`${field} w-20 font-mono`}
                        />
                      </label>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        data-testid="time-draft-edit-comment"
                        value={draftEditor.comment}
                        onChange={(e) => setDraftEditor({ ...draftEditor, comment: e.target.value })}
                        placeholder="Comment describing work done…"
                        className={`${field} min-w-0 flex-1`}
                      />
                      <button
                        type="button"
                        data-testid="time-draft-save"
                        disabled={busy || !effectiveDraftComment(draftEditor)}
                        onClick={saveExistingDraft}
                        className={btnPrimary}
                      >
                        Save
                      </button>
                      <button type="button" onClick={() => setDraftEditor(null)} className={btn}>
                        Cancel
                      </button>
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={entry.id}
                  data-testid="time-draft-row"
                  data-entry-id={entry.id}
                  className={`flex flex-wrap items-center gap-2 rounded border px-2.5 py-1.5 ${
                    entry.state === "failed" || entry.overlap || entry.overlapsTrackerId || entry.duplicateTrackerId
                      ? "border-bad/50 bg-bad/5"
                      : entry.confidence === "uncertain"
                        ? "border-warn/50 bg-warn/5"
                        : "border-line bg-canvas"
                  }`}
                >
                  <div className="inline-flex items-center gap-1 rounded border border-line bg-raised px-1.5 py-0.5">
                    <button
                      type="button"
                      data-testid="time-draft-minus-15"
                      disabled={busy || entry.minutes <= 15}
                      title="Decrease by 15 minutes"
                      onClick={() =>
                        void runAction(() =>
                          updateTimesheetEntry({
                            date: selectedDate,
                            entryId: entry.id,
                            minutes: Math.max(15, entry.minutes - 15),
                            comment: entry.comment,
                          }),
                        )
                      }
                      className="px-1 font-mono text-[11px] text-muted hover:text-fg disabled:opacity-40"
                    >
                      −15m
                    </button>
                    <span className="font-mono font-semibold text-accent" data-testid="time-draft-duration">
                      ~{formatHoursMinutes(entry.minutes)}
                    </span>
                    <button
                      type="button"
                      data-testid="time-draft-plus-15"
                      disabled={busy || entry.minutes >= 720}
                      title="Increase by 15 minutes"
                      onClick={() =>
                        void runAction(() =>
                          updateTimesheetEntry({
                            date: selectedDate,
                            entryId: entry.id,
                            minutes: Math.min(720, entry.minutes + 15),
                            comment: entry.comment,
                          }),
                        )
                      }
                      className="px-1 font-mono text-[11px] text-muted hover:text-fg disabled:opacity-40"
                    >
                      +15m
                    </button>
                  </div>
                  <span className="font-mono text-[11px] text-muted" {...(tracksTime ? { title: `Slot used when submitting to ${trackerName}` } : {})}>
                    {entry.start}–{entry.end}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{entry.comment}</span>
                  {tracksTime && (
                    <>
                  {entry.trackerTaskId && !ownsTask(tracker, entry.trackerId) ? (
                    // A task of another tracker: plain text, no link from this tracker's template; the row needs a task of this one.
                    <span
                      className="rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-muted"
                      data-testid="time-row-task-plain"
                      title="This task is of another task tracker: pick one of this tracker's before submitting"
                    >
                      #{entry.trackerTaskId}
                      {entry.trackerTaskTitle ? ` · ${entry.trackerTaskTitle}` : ""}
                    </span>
                  ) : entry.trackerTaskId ? (
                    <button
                      type="button"
                      onClick={() => openTrackerTask(tracker, entry.trackerTaskId!)}
                      className="rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-accent hover:underline"
                    >
                      #{entry.trackerTaskId}
                      {entry.trackerTaskTitle ? ` · ${entry.trackerTaskTitle}` : ""}
                    </button>
                  ) : (
                    <span className="rounded bg-bad/20 px-1.5 py-0.5 text-[11px] text-bad">No {trackerName} task</span>
                  )}
                  <span className="rounded bg-raised px-1 py-0.5 text-[10px] text-muted">{entry.mappedBy}</span>
                  {entry.confidence === "uncertain" && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-warn" title={entry.uncertaintyReason}>
                      <TriangleAlert className="h-3 w-3" /> uncertain
                    </span>
                  )}
                    </>
                  )}
                  {tracksTime && (
                    <>
                  {entry.duplicateTrackerId && (
                    <span
                      className="inline-flex items-center gap-1 rounded bg-bad/20 px-1.5 py-0.5 text-[11px] font-medium text-bad"
                      data-testid="time-draft-duplicate-badge"
                      title={`Duplicates registered ${trackerName} entry #${entry.duplicateTrackerId}`}
                    >
                      <TriangleAlert className="h-3 w-3" /> duplicate of {trackerName} #{entry.duplicateTrackerId}
                    </span>
                  )}
                    </>
                  )}
                  {(entry.overlap || entry.overlapsTrackerId) && !entry.duplicateTrackerId && (
                    <span
                      className="inline-flex items-center gap-1 rounded bg-bad/20 px-1.5 py-0.5 text-[11px] font-medium text-bad"
                      data-testid="time-draft-overlap-badge"
                      title="This entry overlaps another entry on this day"
                    >
                      <TriangleAlert className="h-3 w-3" /> overlap
                    </span>
                  )}
                  {entry.state === "failed" && entry.error && (
                    <span className="text-[11px] text-bad">{entry.error}</span>
                  )}
                  {tracksTime && entry.confidence === "uncertain" && entry.trackerTaskId && (
                    <button
                      type="button"
                      data-testid="time-draft-confirm"
                      disabled={busy}
                      onClick={() => void runAction(() => confirmTimesheetEntry(selectedDate, entry.id))}
                      className={btn}
                    >
                      <Check className="h-3 w-3" /> Confirm
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="time-draft-edit"
                    disabled={busy}
                    onClick={() => setDraftEditor(toDraftEditor(entry))}
                    className={btn}
                  >
                    <Pencil className="h-3 w-3" /> Edit
                  </button>
                  <button
                    type="button"
                    data-testid="time-draft-duplicate"
                    disabled={busy}
                    title="Duplicate this entry into the next free time slot"
                    onClick={() =>
                      void runAction(() =>
                        updateTimesheetEntry({
                          date: selectedDate,
                          minutes: Math.max(15, entry.minutes),
                          ...(entry.trackerTaskId ? { trackerTaskId: entry.trackerTaskId } : {}),
                          ...(entry.trackerTaskTitle ? { trackerTaskTitle: entry.trackerTaskTitle } : {}),
                          ...(entry.trackerProjectId ? { trackerProjectId: entry.trackerProjectId } : {}),
                          ...(entry.trackerCustomerId ? { trackerCustomerId: entry.trackerCustomerId } : {}),
                          comment: entry.comment,
                        }),
                      )
                    }
                    className={btn}
                  >
                    <Copy className="h-3 w-3" /> Duplicate
                  </button>
                  <button
                    type="button"
                    data-testid="time-draft-delete"
                    disabled={busy}
                    onClick={() => void runAction(() => deleteTimesheetEntry(selectedDate, entry.id))}
                    className={btn}
                  >
                    <Trash className="h-3 w-3" />
                  </button>
                  {entry.overlapDetails && entry.overlapDetails.length > 0 && (
                    <div className="flex w-full flex-wrap items-center gap-1.5 pt-0.5 text-[11px] text-bad" data-testid="time-draft-overlap-details">
                      <TriangleAlert className="h-3 w-3 shrink-0" />
                      <span>
                        Overlaps {entry.overlapDetails.map((od, idx) => (
                          <span key={`${od.targetId}-${idx}`}>
                            {idx > 0 ? "; " : ""}
                            <strong className="font-mono">{od.overlapStart}–{od.overlapEnd}</strong> ({formatHoursMinutes(od.overlapMinutes)}) with{" "}
                            {od.targetType === "tracker" ? trackerRef(tracker, od.targetId) : "draft"}{" "}
                            {od.targetLabel ? `"${od.targetLabel}"` : `${od.targetStart}–${od.targetEnd}`}
                          </span>
                        ))}
                      </span>
                    </div>
                  )}
                  {entry.sources.length > 0 && (
                    <div className="flex w-full flex-wrap items-center gap-1 pt-0.5 text-[11px] text-muted" data-testid="time-draft-sources">
                      {entry.sources.map((src, idx) => (
                        <span key={`${src.source}-${src.title ?? idx}`} className="rounded bg-raised px-1.5 py-0.5">
                          {src.source}: {src.title ?? src.branch ?? src.repoName ?? "activity"}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {draftEditor && !draftEditor.entryId && (
              <div
                className="space-y-2 rounded border border-accent/60 bg-canvas p-2.5"
                data-testid="time-draft-editor"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const commentToSave = effectiveDraftComment(draftEditor);
                    if (busy || !commentToSave) return;
                    void runAction(
                      () =>
                        updateTimesheetEntry({
                          date: selectedDate,
                          addNew: true,
                          start: normalizeHHMM(draftEditor.start),
                          end: normalizeHHMM(draftEditor.end),
                          ...(draftEditor.trackerTaskId.trim() ? { trackerTaskId: draftEditor.trackerTaskId.trim() } : {}),
                          ...(draftEditor.trackerTaskTitle.trim() ? { trackerTaskTitle: draftEditor.trackerTaskTitle.trim() } : {}),
                          ...(draftEditor.trackerProjectId.trim() ? { trackerProjectId: draftEditor.trackerProjectId.trim() } : {}),
                          ...(draftEditor.trackerCustomerId.trim() ? { trackerCustomerId: draftEditor.trackerCustomerId.trim() } : {}),
                          comment: commentToSave,
                        }),
                      () => setDraftEditor(null),
                    );
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setDraftEditor(null);
                  }
                }}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-muted">Rough duration (±15m):</span>
                  {[15, 30, 45, 60, 90, 120, 240].map((presetMin) => (
                    <button
                      key={presetMin}
                      type="button"
                      onClick={() =>
                        setDraftEditor({
                          ...draftEditor,
                          end: addMinutesHHMM(draftEditor.start, presetMin),
                        })
                      }
                      className={btn}
                    >
                      ~{formatHoursMinutes(presetMin)}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-1">
                    <span className="text-muted">Start</span>
                    <input
                      data-testid="time-draft-edit-start"
                      value={draftEditor.start}
                      onChange={(e) => setDraftEditor({ ...draftEditor, start: e.target.value })}
                      onBlur={(e) => setDraftEditor({ ...draftEditor, start: normalizeHHMM(e.target.value) })}
                      className={`${field} w-16 font-mono`}
                    />
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <span className="text-muted">End</span>
                    <input
                      data-testid="time-draft-edit-end"
                      value={draftEditor.end}
                      onChange={(e) => setDraftEditor({ ...draftEditor, end: e.target.value })}
                      onBlur={(e) => setDraftEditor({ ...draftEditor, end: normalizeHHMM(e.target.value) })}
                      className={`${field} w-16 font-mono`}
                    />
                  </label>
                  {tracksTime && (
                    <>
                  <label className="inline-flex items-center gap-1">
                    <span className="text-muted">{trackerName} task</span>
                    <input
                      data-testid="time-draft-edit-task"
                      value={draftEditor.trackerTaskId}
                      onChange={(e) => {
                        const nextTask = e.target.value;
                        const changed = nextTask.trim() !== draftEditor.trackerTaskId.trim();
                        const resolved = changed ? lookupKnownTask(nextTask) : null;
                        setDraftEditor({
                          ...draftEditor,
                          trackerTaskId: nextTask,
                          ...(resolved
                            ? {
                                trackerTaskTitle: resolved.title,
                                trackerProjectId: resolved.projectId,
                                trackerCustomerId: resolved.customerId,
                              }
                            : {}),
                        });
                      }}
                      placeholder="Task ID"
                      className={`${field} w-28 font-mono`}
                    />
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <span className="text-muted">Task title</span>
                    <input
                      data-testid="time-draft-edit-task-title"
                      value={draftEditor.trackerTaskTitle}
                      onChange={(e) => setDraftEditor({ ...draftEditor, trackerTaskTitle: e.target.value })}
                      placeholder="Auto"
                      className={`${field} w-36`}
                    />
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <span className="text-muted">Project ID</span>
                    <input
                      data-testid="time-draft-edit-project"
                      value={draftEditor.trackerProjectId}
                      onChange={(e) => setDraftEditor({ ...draftEditor, trackerProjectId: e.target.value })}
                      placeholder="Auto"
                      className={`${field} w-20 font-mono`}
                    />
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <span className="text-muted">Customer ID</span>
                    <input
                      data-testid="time-draft-edit-customer"
                      value={draftEditor.trackerCustomerId}
                      onChange={(e) => setDraftEditor({ ...draftEditor, trackerCustomerId: e.target.value })}
                      placeholder="Auto"
                      className={`${field} w-20 font-mono`}
                    />
                  </label>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    data-testid="time-draft-edit-comment"
                    value={draftEditor.comment}
                    onChange={(e) => setDraftEditor({ ...draftEditor, comment: e.target.value })}
                    placeholder="Comment describing work done…"
                    className={`${field} min-w-0 flex-1`}
                  />
                  <button
                    type="button"
                    data-testid="time-draft-save"
                    disabled={busy || !effectiveDraftComment(draftEditor)}
                    onClick={() => {
                      const commentToSave = effectiveDraftComment(draftEditor);
                      if (!commentToSave) return;
                      void runAction(
                        () =>
                          updateTimesheetEntry({
                            date: selectedDate,
                            addNew: true,
                            start: normalizeHHMM(draftEditor.start),
                            end: normalizeHHMM(draftEditor.end),
                            ...(draftEditor.trackerTaskId.trim() ? { trackerTaskId: draftEditor.trackerTaskId.trim() } : {}),
                            ...(draftEditor.trackerTaskTitle.trim() ? { trackerTaskTitle: draftEditor.trackerTaskTitle.trim() } : {}),
                            ...(draftEditor.trackerProjectId.trim() ? { trackerProjectId: draftEditor.trackerProjectId.trim() } : {}),
                            ...(draftEditor.trackerCustomerId.trim() ? { trackerCustomerId: draftEditor.trackerCustomerId.trim() } : {}),
                            comment: commentToSave,
                          }),
                        () => setDraftEditor(null),
                      );
                    }}
                    className={btnPrimary}
                  >
                    Add row
                  </button>
                  <button type="button" onClick={() => setDraftEditor(null)} className={btn}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Registered in the tracker */}
          {tracksTime && (
          <div className="mt-4 space-y-1.5 border-t border-line pt-3" data-testid="time-registered-section">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Registered in {trackerName} ({formatHoursMinutes(day.registeredMinutes)})
            </div>
            {day.registered.length === 0 && (
              <div className="text-muted">No entries registered in {trackerName} for this day yet.</div>
            )}
            {day.registered.map((reg) => {
              const isEditingReg = regEditor?.trackerEntryId === reg.id;
              if (isEditingReg && regEditor) {
                return (
                  <div
                    key={reg.id}
                    data-testid="time-registered-editor"
                    className="space-y-2 rounded border border-accent/60 bg-canvas p-2.5"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[11px] text-ok">{trackerName} #{reg.id}</span>
                      <label className="inline-flex items-center gap-1">
                        <span className="text-muted">Start</span>
                        <input
                          data-testid="time-reg-edit-start"
                          value={regEditor.start}
                          onChange={(e) => setRegEditor({ ...regEditor, start: e.target.value })}
                          onBlur={(e) => setRegEditor({ ...regEditor, start: normalizeHHMM(e.target.value) })}
                          className={`${field} w-16 font-mono`}
                        />
                      </label>
                      <label className="inline-flex items-center gap-1">
                        <span className="text-muted">End</span>
                        <input
                          data-testid="time-reg-edit-end"
                          value={regEditor.end}
                          onChange={(e) => setRegEditor({ ...regEditor, end: e.target.value })}
                          onBlur={(e) => setRegEditor({ ...regEditor, end: normalizeHHMM(e.target.value) })}
                          className={`${field} w-16 font-mono`}
                        />
                      </label>
                      <label className="inline-flex items-center gap-1">
                        <span className="text-muted">{trackerName} task</span>
                        <input
                          data-testid="time-reg-edit-task"
                          value={regEditor.trackerTaskId}
                          onChange={(e) => {
                            const nextTask = e.target.value;
                            const changed = nextTask.trim() !== regEditor.trackerTaskId.trim();
                            const resolved = changed ? lookupKnownTask(nextTask) : null;
                            setRegEditor({
                              ...regEditor,
                              trackerTaskId: nextTask,
                              ...(resolved
                                ? {
                                    trackerTaskTitle: resolved.title,
                                    trackerProjectId: resolved.projectId,
                                    trackerCustomerId: resolved.customerId,
                                  }
                                : {}),
                            });
                          }}
                          className={`${field} w-28 font-mono`}
                        />
                      </label>
                      <label className="inline-flex items-center gap-1">
                        <span className="text-muted">Project ID</span>
                        <input
                          data-testid="time-reg-edit-project"
                          value={regEditor.trackerProjectId}
                          onChange={(e) => setRegEditor({ ...regEditor, trackerProjectId: e.target.value })}
                          placeholder="Auto"
                          className={`${field} w-20 font-mono`}
                        />
                      </label>
                      <label className="inline-flex items-center gap-1">
                        <span className="text-muted">Customer ID</span>
                        <input
                          data-testid="time-reg-edit-customer"
                          value={regEditor.trackerCustomerId}
                          onChange={(e) => setRegEditor({ ...regEditor, trackerCustomerId: e.target.value })}
                          placeholder="Auto"
                          className={`${field} w-20 font-mono`}
                        />
                      </label>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        data-testid="time-reg-edit-comment"
                        value={regEditor.comment}
                        onChange={(e) => setRegEditor({ ...regEditor, comment: e.target.value })}
                        placeholder="Comment…"
                        className={`${field} min-w-0 flex-1`}
                      />
                      <button
                        type="button"
                        data-testid="time-registered-save"
                        disabled={busy || !regEditor.comment.trim() || !regEditor.trackerTaskId.trim()}
                        onClick={() =>
                          void runAction(
                            () =>
                              updateRegisteredEntry({
                                date: selectedDate,
                                trackerEntryId: reg.id,
                                start: normalizeHHMM(regEditor.start),
                                end: normalizeHHMM(regEditor.end),
                                trackerTaskId: regEditor.trackerTaskId.trim(),
                                ...(regEditor.trackerTaskTitle.trim() ? { trackerTaskTitle: regEditor.trackerTaskTitle.trim() } : {}),
                                ...(regEditor.trackerProjectId.trim() ? { trackerProjectId: regEditor.trackerProjectId.trim() } : {}),
                                ...(regEditor.trackerCustomerId.trim() ? { trackerCustomerId: regEditor.trackerCustomerId.trim() } : {}),
                                comment: regEditor.comment.trim(),
                              }),
                            () => setRegEditor(null),
                          )
                        }
                        className={btnPrimary}
                      >
                        {busy ? "Updating…" : `Save & update in ${trackerName}`}
                      </button>
                      <button type="button" onClick={() => setRegEditor(null)} className={btn}>
                        Cancel
                      </button>
                    </div>
                  </div>
                );
              }

              // Registered in another tracker: history, with no Edit, Duplicate or Delete.
              const history = tracker !== undefined && reg.trackerId !== undefined && reg.trackerId !== tracker.id;
              return (
                <div
                  key={reg.id}
                  data-testid="time-registered-item"
                  data-entry-id={reg.id}
                  className={`flex flex-wrap items-center gap-2 rounded border px-2.5 py-1.5 ${
                    reg.overlap
                      ? "border-bad/50 bg-bad/5"
                      : "border-line bg-canvas"
                  }`}
                >
                  <span className="font-mono font-medium">
                    {reg.start}–{reg.end}
                  </span>
                  <span className="text-muted">({formatHoursMinutes(reg.minutes)})</span>
                  <span className="min-w-0 flex-1 truncate font-medium" data-testid="time-registered-comment">
                    {reg.comment ?? ""}
                  </span>
                  {ownsTask(tracker, reg.trackerId) ? (
                    <button
                      type="button"
                      onClick={() => openTrackerTask(tracker, reg.trackerTaskId)}
                      className="rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-accent hover:underline"
                    >
                      #{reg.trackerTaskId}
                      {reg.trackerTaskTitle ? ` · ${reg.trackerTaskTitle}` : ""}
                    </button>
                  ) : (
                    // Registered in another tracker: history, plain text.
                    <span className="rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-muted" data-testid="time-registered-task-plain">
                      #{reg.trackerTaskId}
                      {reg.trackerTaskTitle ? ` · ${reg.trackerTaskTitle}` : ""}
                    </span>
                  )}
                  {history ? (
                    <span
                      className="rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-muted"
                      data-testid="time-registered-history"
                      title="Registered in another task tracker: it stays here as history and can't be changed or deleted through this one"
                    >
                      history · #{reg.id}
                    </span>
                  ) : (
                    <span className="rounded bg-ok/15 px-1.5 py-0.5 font-mono text-[11px] text-ok" data-testid="time-registered-id">
                      {trackerName} #{reg.id}
                    </span>
                  )}
                  {reg.overlap && (
                    <span
                      className="inline-flex items-center gap-1 rounded bg-bad/20 px-1.5 py-0.5 text-[11px] font-medium text-bad"
                      data-testid="time-registered-overlap-badge"
                      title="This registered entry overlaps another entry on this day"
                    >
                      <TriangleAlert className="h-3 w-3 shrink-0" /> overlap
                    </span>
                  )}
                  {!history && (
                    <>
                  <button
                    type="button"
                    data-testid="time-registered-edit"
                    disabled={busy}
                    onClick={() => {
                      setDeleteTarget(null);
                      setRegEditor(toRegisteredEditor(reg));
                    }}
                    className={btn}
                  >
                    <Pencil className="h-3 w-3" /> Edit
                  </button>
                  <button
                    type="button"
                    data-testid="time-registered-duplicate"
                    disabled={busy}
                    title="Duplicate this registered entry into a new draft row in the next free time slot"
                    onClick={() =>
                      void runAction(() =>
                        updateTimesheetEntry({
                          date: selectedDate,
                          minutes: Math.max(15, reg.minutes),
                          trackerTaskId: reg.trackerTaskId,
                          ...(reg.trackerTaskTitle ? { trackerTaskTitle: reg.trackerTaskTitle } : {}),
                          ...(reg.trackerProjectId ? { trackerProjectId: reg.trackerProjectId } : {}),
                          ...(reg.trackerCustomerId ? { trackerCustomerId: reg.trackerCustomerId } : {}),
                          comment: reg.comment || reg.trackerTaskTitle || `Task #${reg.trackerTaskId}`,
                        }),
                      )
                    }
                    className={btn}
                  >
                    <Copy className="h-3 w-3" /> Duplicate
                  </button>
                  <button
                    type="button"
                    data-testid="time-registered-delete"
                    disabled={busy}
                    onClick={() => {
                      setRegEditor(null);
                      setDeleteTarget(reg);
                      setDeleteTickedForId(null);
                    }}
                    className={btn}
                    title={`Delete from ${trackerName}`}
                  >
                    <Trash className="h-3 w-3" /> Delete
                  </button>
                    </>
                  )}
                  {reg.overlapDetails && reg.overlapDetails.length > 0 && (
                    <div className="flex w-full flex-wrap items-center gap-1.5 pt-0.5 text-[11px] text-bad" data-testid="time-registered-overlap-details">
                      <TriangleAlert className="h-3 w-3 shrink-0" />
                      <span>
                        Overlaps {reg.overlapDetails.map((od, idx) => (
                          <span key={`${od.targetId}-${idx}`}>
                            {idx > 0 ? "; " : ""}
                            <strong className="font-mono">{od.overlapStart}–{od.overlapEnd}</strong> ({formatHoursMinutes(od.overlapMinutes)}) with{" "}
                            {od.targetType === "tracker" ? trackerRef(tracker, od.targetId) : "draft"}{" "}
                            {od.targetLabel ? `"${od.targetLabel}"` : `${od.targetStart}–${od.targetEnd}`}
                          </span>
                        ))}
                      </span>
                    </div>
                  )}
                  {reg.sources && reg.sources.length > 0 && (
                    <div className="flex w-full flex-wrap items-center gap-1 pt-0.5 text-[11px] text-muted">
                      {reg.sources.map((src, idx) => (
                        <span key={`${src.source}-${src.title ?? idx}`} className="rounded bg-raised px-1.5 py-0.5">
                          {src.source}: {src.title ?? src.branch ?? src.repoName ?? "activity"}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Explicit delete confirmation box showing the exact tracker ID (PLAN.md §0.4 #5, §4.14 #6) */}
            {deleteTarget && (
              <div
                data-testid="time-delete-confirm-box"
                className="mt-2 space-y-2 rounded border border-bad/60 bg-bad/5 p-3"
              >
                <div className="flex items-center gap-1.5 font-semibold text-bad">
                  <ShieldAlert className="h-4 w-4" />
                  Delete {trackerName} time log #{deleteTarget.id}?
                </div>
                <div className="text-muted">
                  {deleteTargetCall ? (
                    <>
                      This calls <span className="font-mono text-fg">{deleteTargetCall.tool}</span> with{" "}
                      <span className="font-mono text-fg">{deleteTargetCall.args}</span> for{" "}
                    </>
                  ) : (
                    <>This deletes it in {trackerName} for </>
                  )}
                  <span className="font-mono">{deleteTarget.start}–{deleteTarget.end}</span> (#{deleteTarget.trackerTaskId}
                  {deleteTarget.comment ? ` · ${deleteTarget.comment}` : ""}).
                </div>
                <label className="flex items-center gap-1.5 text-warn">
                  <input
                    type="checkbox"
                    data-testid="time-delete-confirm-tick"
                    checked={deleteTickedForId === deleteTarget.id}
                    onChange={(e) => setDeleteTickedForId(e.target.checked ? deleteTarget.id : null)}
                  />
                  I confirm permanently deleting {trackerName} time log #{deleteTarget.id}
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="time-delete-confirm-run"
                    disabled={busy || deleteTickedForId !== deleteTarget.id}
                    onClick={() =>
                      void runAction(
                        () =>
                          deleteRegisteredEntries({
                            date: selectedDate,
                            trackerEntryIds: [deleteTarget.id],
                            confirmed: true,
                          }),
                        () => {
                          setDeleteTarget(null);
                          setDeleteTickedForId(null);
                        },
                      )
                    }
                    className="inline-flex items-center gap-1 rounded bg-bad px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {busy ? "Deleting…" : `Confirm delete #${deleteTarget.id}`}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setDeleteTarget(null);
                      setDeleteTickedForId(null);
                    }}
                    className={btn}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
          )}
        </section>

        {/* Daily Work Digest: Meetings, Tasks worked on, Sent emails, and tracker updates */}
        <section className="rounded-md border border-line bg-panel p-3" data-testid="time-activities-section">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold">Daily Digest on {day.dateLabel} (what to punch in on)</h2>
              <p className="text-[11px] text-muted">
                {tracksTime
                  ? `Meetings you had, tasks you worked on (~±15m rough time), emails you sent, and ${trackerName} tasks updated on ${selectedDate}.`
                  : `Meetings you had, tasks you worked on (~±15m rough time) and emails you sent on ${selectedDate}.`}
              </p>
            </div>
            <button
              type="button"
              data-testid="time-scan-git"
              disabled={busy}
              onClick={() =>
                void runAction(async () => {
                  await listActivities({ scanGit: true });
                  return loadTimeView(selectedDate);
                })
              }
              className={btn}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Scan local git
            </button>
          </div>

          {(() => {
            const meetingActs = activities.filter((a) => a.source === "calendar");
            const mailActs = activities.filter((a) => a.source === "mail");
            const trackerActs = activities.filter((a) => a.source === "tracker");
            const workActs = activities.filter(
              (a) => a.source === "aria" || a.source === "git" || a.source === "github" || a.source === "teams",
            );

            // Group workActs by resolved task or project for rough ±15m summary
            const workGroups = new Map<
              string,
              {
                key: string;
                label: string;
                trackerTaskId?: string;
                roughMinutes: number;
                items: typeof workActs;
              }
            >();
            for (const act of workActs) {
              const taskId = act.resolvedTask?.trackerTaskId ?? act.linkedTrackerTaskId;
              const repoName = typeof act.metadata.repoName === "string" ? act.metadata.repoName : undefined;
              const key = taskId ? `task:${taskId}` : repoName ? `repo:${repoName}` : `act:${act.id}`;
              const durMin = act.endedAt > act.startedAt ? roundTo15Min(act.endedAt - act.startedAt) : 15;
              const existing = workGroups.get(key);
              if (existing) {
                existing.roughMinutes = Math.min(480, existing.roughMinutes + durMin);
                existing.items.push(act);
              } else {
                workGroups.set(key, {
                  key,
                  label: taskId ? `Task #${taskId}${repoName ? ` · ${repoName}` : ""}` : repoName ?? act.title,
                  ...(taskId ? { trackerTaskId: taskId } : {}),
                  roughMinutes: durMin,
                  items: [act],
                });
              }
            }

            return (
              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                {/* 1. Meetings had that day */}
                <div className="rounded border border-line bg-canvas p-2.5" data-testid="time-digest-meetings">
                  <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted">
                    <span>Meetings ({meetingActs.length})</span>
                    <span>
                      ~{formatHoursMinutes(meetingActs.reduce((acc, m) => acc + roundTo15Min(m.endedAt - m.startedAt), 0))}
                    </span>
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {meetingActs.length === 0 && <div className="text-muted">No meetings recorded on this day.</div>}
                    {meetingActs.map((m) => {
                      const roughMin = roundTo15Min(m.endedAt - m.startedAt);
                      const taskId = m.resolvedTask?.trackerTaskId ?? m.linkedTrackerTaskId;
                      return (
                        <div
                          key={m.id}
                          data-testid="time-activity-row"
                          className="flex flex-wrap items-center gap-1.5 rounded border border-line bg-panel px-2 py-1"
                        >
                          <span className="rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[11px] font-medium text-accent">
                            ~{formatHoursMinutes(roughMin)}
                          </span>
                          <span className="font-mono text-[11px] text-muted">
                            {formatEpochHHMM(m.startedAt, day.timeZone)}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-medium">{m.title}</span>
                          {taskId && (
                            <button
                              type="button"
                              onClick={() => openTrackerTask(tracker, taskId)}
                              className="rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-accent hover:underline"
                            >
                              #{taskId}
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void runAction(() =>
                                updateTimesheetEntry({
                                  date: selectedDate,
                                  minutes: roughMin,
                                  ...(taskId ? { trackerTaskId: taskId } : {}),
                                  comment: m.title,
                                  sources: [{ source: "calendar", kind: "meeting", externalId: m.externalId, title: m.title }],
                                }),
                              )
                            }
                            className={btn}
                            title="Add meeting to punch list"
                          >
                            <Plus className="h-3 w-3" /> Punch ~{formatHoursMinutes(roughMin)}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 2. Tasks worked on & rough time spent */}
                <div className="rounded border border-line bg-canvas p-2.5" data-testid="time-digest-tasks">
                  <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted">
                    <span>Tasks worked on ({workGroups.size})</span>
                    <span>
                      ~{formatHoursMinutes([...workGroups.values()].reduce((acc, g) => acc + g.roughMinutes, 0))}
                    </span>
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {workGroups.size === 0 && <div className="text-muted">No task, commit, PR, or Teams activity recorded yet.</div>}
                    {[...workGroups.values()].map((grp) => {
                      const summaryComment = grp.items
                        .map((i) => i.title)
                        .filter((v, idx, arr) => Boolean(v) && arr.indexOf(v) === idx)
                        .slice(0, 2)
                        .join("; ");
                      return (
                        <div key={grp.key} className="space-y-1 rounded border border-line bg-panel px-2 py-1.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[11px] font-medium text-accent">
                              ~{formatHoursMinutes(grp.roughMinutes)}
                            </span>
                            <span className="min-w-0 flex-1 truncate font-medium">{grp.label}</span>
                            {grp.trackerTaskId && (
                              <button
                                type="button"
                                onClick={() => openTrackerTask(tracker, grp.trackerTaskId!)}
                                className="rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-accent hover:underline"
                              >
                                #{grp.trackerTaskId}
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void runAction(() =>
                                  updateTimesheetEntry({
                                    date: selectedDate,
                                    minutes: grp.roughMinutes,
                                    ...(grp.trackerTaskId ? { trackerTaskId: grp.trackerTaskId } : {}),
                                    comment: summaryComment || grp.label,
                                  }),
                                )
                              }
                              className={btn}
                            >
                              <Plus className="h-3 w-3" /> Punch ~{formatHoursMinutes(grp.roughMinutes)}
                            </button>
                          </div>
                          {grp.items.map((act) => (
                            <div
                              key={act.id}
                              data-testid="time-activity-row"
                              className="flex flex-wrap items-center gap-1.5 pl-2 text-[11px] text-muted"
                            >
                              <span className="rounded bg-raised px-1 py-0.5 font-mono text-[10px] uppercase">
                                {act.source}
                              </span>
                              <span className="min-w-0 flex-1 truncate">{act.title}</span>
                              {act.resolvedTask && (
                                <span className="font-mono text-accent">
                                  #{act.resolvedTask.trackerTaskId} ({act.resolvedTask.mappedBy})
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 3. Emails sent (linked to a task) */}
                <div className="rounded border border-line bg-canvas p-2.5" data-testid="time-digest-emails">
                  <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted">
                    <span>Emails sent ({mailActs.length})</span>
                    <span>
                      ~{formatHoursMinutes(mailActs.reduce((acc, m) => acc + (m.resolvedMinutes ?? 15), 0))}
                    </span>
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {mailActs.length === 0 && <div className="text-muted">No sent emails recorded on this day.</div>}
                    {mailActs.map((mail) => {
                      const taskId = mail.resolvedTask?.trackerTaskId ?? mail.linkedTrackerTaskId;
                      const mailMinutes = mail.resolvedMinutes ?? 15;
                      const recipient = typeof mail.metadata.recipient === "string" ? mail.metadata.recipient : undefined;
                      return (
                        <div
                          key={mail.id}
                          data-testid="time-activity-row"
                          className="flex flex-wrap items-center gap-1.5 rounded border border-line bg-panel px-2 py-1"
                        >
                          <span className="rounded bg-raised px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted">
                            mail
                          </span>
                          <span className="min-w-0 flex-1 truncate font-medium">
                            {mail.title}
                            {recipient ? <span className="font-normal text-muted"> · To: {recipient}</span> : null}
                          </span>
                          {mail.resolvedMinutes && (
                            <span
                              className="rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-accent"
                              title="Configured duration from email rule"
                            >
                              rule: {formatHoursMinutes(mail.resolvedMinutes)}
                            </span>
                          )}
                          {taskId ? (
                            <button
                              type="button"
                              onClick={() => openTrackerTask(tracker, taskId)}
                              className="rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-accent hover:underline"
                            >
                              #{taskId}
                            </button>
                          ) : (
                            tracksTime && <span className="text-[10px] text-muted">unlinked</span>
                          )}
                          {tracksTime && (
                          <button
                            type="button"
                            data-testid="time-mail-set-rule"
                            disabled={busy}
                            title={`Configure automatic duration (and/or ${trackerName} task) for emails matching this title or part of it`}
                            onClick={() =>
                              setRuleForm({
                                kind: "mail_subject",
                                pattern: mail.title,
                                matchMode: "contains",
                                trackerTaskId: taskId ?? "",
                                trackerTaskTitle: "",
                                defaultMinutes: String(mail.resolvedMinutes ?? 60),
                                enabled: true,
                              })
                            }
                            className={btn}
                          >
                            <Clock className="h-3 w-3" /> Set duration rule…
                          </button>
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void runAction(() =>
                                updateTimesheetEntry({
                                  date: selectedDate,
                                  minutes: mailMinutes,
                                  ...(taskId ? { trackerTaskId: taskId } : {}),
                                  comment: `Email: ${mail.title}`,
                                  sources: [
                                    {
                                      source: "mail",
                                      kind: "mail",
                                      externalId: mail.externalId,
                                      title: mail.title,
                                      ...(recipient ? { recipient } : {}),
                                    },
                                  ],
                                }),
                              )
                            }
                            className={btn}
                          >
                            <Plus className="h-3 w-3" /> +{formatHoursMinutes(mailMinutes)}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 4. Tracker tasks updated */}
                {tracksTime && (
                <div className="rounded border border-line bg-canvas p-2.5" data-testid="time-digest-tracker">
                  <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted">
                    <span>{trackerName} tasks updated ({trackerActs.length})</span>
                    <span>{trackerName}</span>
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {trackerActs.length === 0 && (
                      <div className="text-muted">No {trackerName} task updates recorded on this day.</div>
                    )}
                    {trackerActs.map((col) => {
                      const taskId =
                        col.resolvedTask?.trackerTaskId ??
                        col.linkedTrackerTaskId ??
                        (typeof col.metadata.taskId === "string" ? col.metadata.taskId : undefined);
                      return (
                        <div
                          key={col.id}
                          data-testid="time-activity-row"
                          className="flex flex-wrap items-center gap-1.5 rounded border border-line bg-panel px-2 py-1"
                        >
                          <span className="rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] uppercase text-accent">
                            tracker
                          </span>
                          <span className="min-w-0 flex-1 truncate font-medium">{col.title}</span>
                          {taskId && (
                            <button
                              type="button"
                              onClick={() => openTrackerTask(tracker, taskId)}
                              className="inline-flex items-center gap-0.5 rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-accent hover:underline"
                            >
                              #{taskId} <ExternalLink className="h-2.5 w-2.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void runAction(() =>
                                updateTimesheetEntry({
                                  date: selectedDate,
                                  minutes: 15,
                                  ...(taskId ? { trackerTaskId: taskId } : {}),
                                  comment: col.title,
                                  sources: [{ source: "tracker", kind: "task_updated", externalId: col.externalId, title: col.title }],
                                }),
                              )
                            }
                            className={btn}
                          >
                            <Plus className="h-3 w-3" /> +15m
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
                )}
              </div>
            );
          })()}
        </section>

        {/* Mapping rules editor */}
        {tracksTime && (
        <section className="rounded-md border border-line bg-panel p-3" data-testid="time-rules-section">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold">Mapping rules</h2>
              <p className="text-[11px] text-muted">
                Automatically map projects, branches, meetings, Teams channels, and email titles/substrings to {trackerName} tasks and default durations.
              </p>
            </div>
            {!ruleForm && (
              <button
                type="button"
                data-testid="time-rule-new"
                disabled={busy}
                onClick={() =>
                  setRuleForm({
                    kind: "meeting_title",
                    pattern: "",
                    matchMode: "contains",
                    trackerTaskId: "",
                    trackerTaskTitle: "",
                    defaultMinutes: "",
                    enabled: true,
                  })
                }
                className={btn}
              >
                <Plus className="h-3.5 w-3.5" /> New rule
              </button>
            )}
          </div>

          {ruleForm && (
            <div className="mt-2.5 space-y-2 rounded border border-accent/60 bg-canvas p-2.5" data-testid="time-rule-form">
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-1">
                  <span className="text-muted">Source</span>
                  <select
                    data-testid="time-rule-kind"
                    value={ruleForm.kind}
                    onChange={(e) => {
                      const nextKind = e.target.value as TimeRuleKind;
                      const firstProj = projects[0];
                      setRuleForm({
                        ...ruleForm,
                        kind: nextKind,
                        ...(nextKind === "repo" && firstProj
                          ? { repoId: firstProj.id, pattern: firstProj.name, matchMode: "exact" }
                          : { matchMode: nextKind === "branch" ? "prefix" : "contains" }),
                      });
                    }}
                    className={field}
                  >
                    {(Object.keys(RULE_KIND_LABELS) as TimeRuleKind[]).map((k) => (
                      <option key={k} value={k}>
                        {RULE_KIND_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </label>

                {ruleForm.kind === "repo" && projects.length > 0 ? (
                  <label className="inline-flex items-center gap-1">
                    <span className="text-muted">Project</span>
                    <select
                      data-testid="time-rule-repo"
                      value={ruleForm.repoId ?? ""}
                      onChange={(e) => {
                        const pid = Number(e.target.value);
                        const proj = projects.find((p) => p.id === pid);
                        setRuleForm({
                          ...ruleForm,
                          ...(proj ? { repoId: proj.id, pattern: proj.name } : {}),
                        });
                      }}
                      className={field}
                    >
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label className="inline-flex items-center gap-1">
                    <span className="text-muted">{ruleForm.kind === "mail_subject" ? "Title / part of title" : "Pattern"}</span>
                    <input
                      data-testid="time-rule-pattern"
                      value={ruleForm.pattern}
                      onChange={(e) => setRuleForm({ ...ruleForm, pattern: e.target.value })}
                      placeholder={ruleForm.kind === "mail_subject" ? "e.g. Release notes or [Support]" : "e.g. Standup or feature/dark-mode"}
                      className={`${field} w-44`}
                    />
                  </label>
                )}

                <label className="inline-flex items-center gap-1">
                  <span className="text-muted">Match</span>
                  <select
                    data-testid="time-rule-mode"
                    value={ruleForm.matchMode}
                    onChange={(e) => setRuleForm({ ...ruleForm, matchMode: e.target.value as TimeRuleMatchMode })}
                    className={field}
                  >
                    <option value="exact">Exact</option>
                    <option value="contains">Contains</option>
                    <option value="prefix">Prefix</option>
                  </select>
                </label>

                <label className="inline-flex items-center gap-1">
                  <span className="text-muted">{trackerName} task</span>
                  <input
                    data-testid="time-rule-task"
                    value={ruleForm.trackerTaskId}
                    onChange={(e) => setRuleForm({ ...ruleForm, trackerTaskId: e.target.value })}
                    placeholder={ruleForm.defaultMinutes.trim() ? "Optional if duration set" : "e.g. 410001"}
                    className={`${field} w-32 font-mono`}
                  />
                </label>

                <label className="inline-flex items-center gap-1">
                  <span className="text-muted">Task title</span>
                  <input
                    data-testid="time-rule-task-title"
                    value={ruleForm.trackerTaskTitle}
                    onChange={(e) => setRuleForm({ ...ruleForm, trackerTaskTitle: e.target.value })}
                    placeholder="Optional title"
                    className={`${field} w-36`}
                  />
                </label>

                <label className="inline-flex items-center gap-1">
                  <span className="text-muted">Duration (min)</span>
                  <input
                    data-testid="time-rule-minutes"
                    inputMode="numeric"
                    value={ruleForm.defaultMinutes}
                    onChange={(e) => setRuleForm({ ...ruleForm, defaultMinutes: e.target.value })}
                    placeholder="Auto"
                    className={`${field} w-20 font-mono`}
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="text-muted">Duration presets:</span>
                {[15, 30, 45, 60, 90, 120, 240].map((presetMin) => (
                  <button
                    key={presetMin}
                    type="button"
                    data-testid={`time-rule-preset-${presetMin}`}
                    onClick={() => setRuleForm({ ...ruleForm, defaultMinutes: String(presetMin) })}
                    className={`${btn} ${Number(ruleForm.defaultMinutes) === presetMin ? "border-accent text-accent" : ""}`}
                  >
                    ~{formatHoursMinutes(presetMin)}
                  </button>
                ))}
                {ruleForm.defaultMinutes.trim() !== "" && (
                  <button
                    type="button"
                    onClick={() => setRuleForm({ ...ruleForm, defaultMinutes: "" })}
                    className="px-1.5 text-muted hover:text-fg"
                  >
                    Clear duration
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="time-rule-save"
                  disabled={
                    busy ||
                    !ruleForm.pattern.trim() ||
                    (!ruleForm.trackerTaskId.trim() && !ruleForm.defaultMinutes.trim())
                  }
                  onClick={() =>
                    void runAction(
                      async () => {
                        const parsedMin = ruleForm.defaultMinutes.trim() ? Math.round(Number(ruleForm.defaultMinutes.trim())) : null;
                        const res = await saveTimeRule({
                          ...(ruleForm.id ? { id: ruleForm.id } : {}),
                          kind: ruleForm.kind,
                          ...(ruleForm.kind === "repo" && ruleForm.repoId !== undefined ? { repoId: ruleForm.repoId } : {}),
                          pattern: ruleForm.pattern.trim(),
                          matchMode: ruleForm.matchMode,
                          trackerTaskId: ruleForm.trackerTaskId.trim(),
                          ...(ruleForm.trackerTaskTitle.trim() ? { trackerTaskTitle: ruleForm.trackerTaskTitle.trim() } : {}),
                          defaultMinutes: parsedMin,
                          enabled: ruleForm.enabled,
                        });
                        if (res.error) return res.error;
                        return loadTimeView(selectedDate);
                      },
                      () => setRuleForm(null),
                    )
                  }
                  className={btnPrimary}
                >
                  Save rule
                </button>
                <button type="button" onClick={() => setRuleForm(null)} className={btn}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="mt-2.5 space-y-1">
            {timeRules.length === 0 && (
              <div className="text-muted">No mapping rules yet.</div>
            )}
            {timeRules.map((rule: TimeRule) => {
              const ruleMins = rule.defaultMinutes ?? rule.match.defaultMinutes;
              return (
                <div
                  key={rule.id}
                  data-testid="time-rule-row"
                  className="flex flex-wrap items-center gap-2 rounded border border-line bg-canvas px-2.5 py-1.5"
                >
                  <input
                    type="checkbox"
                    data-testid="time-rule-toggle"
                    checked={rule.enabled}
                    onChange={(e) =>
                      void runAction(async () => {
                        const res = await saveTimeRule({
                          id: rule.id,
                          kind: rule.match.kind,
                          ...(rule.match.repoId !== undefined ? { repoId: rule.match.repoId } : {}),
                          pattern: rule.match.pattern,
                          ...(rule.match.matchMode ? { matchMode: rule.match.matchMode } : {}),
                          trackerTaskId: rule.trackerTaskId,
                          ...(rule.trackerTaskTitle ? { trackerTaskTitle: rule.trackerTaskTitle } : {}),
                          ...(ruleMins !== undefined ? { defaultMinutes: ruleMins } : {}),
                          enabled: e.target.checked,
                        });
                        if (res.error) return res.error;
                        return loadTimeView(selectedDate);
                      })
                    }
                    title="Enable or disable rule"
                  />
                  <span className="rounded bg-raised px-1.5 py-0.5 font-mono text-[10px] text-muted">
                    {RULE_KIND_LABELS[rule.match.kind]} ({rule.match.matchMode ?? "exact"})
                  </span>
                  <span className="font-medium">{rule.match.pattern}</span>
                  <span className="text-muted">→</span>
                  {rule.trackerTaskId ? (
                    <span className="font-mono text-accent">
                      #{rule.trackerTaskId}
                      {rule.trackerTaskTitle ? ` · ${rule.trackerTaskTitle}` : ""}
                    </span>
                  ) : (
                    <span className="text-xs text-muted">Any task</span>
                  )}
                  {ruleMins !== undefined && (
                    <span
                      data-testid="time-rule-duration-badge"
                      className="rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[11px] font-medium text-accent"
                    >
                      ~{formatHoursMinutes(ruleMins)}
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      data-testid="time-rule-edit"
                      disabled={busy}
                      onClick={() =>
                        setRuleForm({
                          id: rule.id,
                          kind: rule.match.kind,
                          ...(rule.match.repoId !== undefined ? { repoId: rule.match.repoId } : {}),
                          pattern: rule.match.pattern,
                          matchMode: rule.match.matchMode ?? "exact",
                          trackerTaskId: rule.trackerTaskId,
                          trackerTaskTitle: rule.trackerTaskTitle ?? "",
                          defaultMinutes: ruleMins !== undefined ? String(ruleMins) : "",
                          enabled: rule.enabled,
                        })
                      }
                      className={btn}
                    >
                      <Pencil className="h-3 w-3" /> Edit
                    </button>
                    <button
                      type="button"
                      data-testid="time-rule-delete"
                      disabled={busy}
                      onClick={() =>
                        void runAction(async () => {
                          const err = await deleteTimeRule(rule.id);
                          if (err) return err;
                          return loadTimeView(selectedDate);
                        })
                      }
                      className={btn}
                    >
                      <Trash className="h-3 w-3" />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </section>
        )}
      </div>
    </div>
  );
}
