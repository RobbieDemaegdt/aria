// Time registration (PLAN.md §4.14): the day's timesheet draft to check, and what the task tracker registered.
import type { CardItem, TimesheetEntry } from "@aria/protocol";
import { Check, CircleX, Clock, Copy, Pencil, Plus, RotateCcw, Trash, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useAria, useTracker, useTracksTime } from "../store";
import { openTrackerTask, ownsTask, trackerLabel, trackerRef, viaCreateTool } from "../tracker";
import { Button, formatHoursMinutes, Shell, visibleJsonText } from "./CardParts";

interface TimesheetRowEditorState {
  entryId?: string;
  start: string;
  end: string;
  trackerTaskId: string;
  trackerTaskTitle: string;
  trackerProjectId: string;
  trackerCustomerId: string;
  comment: string;
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

function effectiveRowComment(editor: TimesheetRowEditorState): string {
  return (
    editor.comment.trim() ||
    editor.trackerTaskTitle.trim() ||
    (editor.trackerTaskId.trim() ? `Task #${editor.trackerTaskId.trim().replace(/^#/, "")}` : "")
  );
}

function toRowEditorState(entry?: TimesheetEntry, defaultStart = "09:00", defaultEnd = "10:00"): TimesheetRowEditorState {
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

/**
 * Timesheet draft card (Phase 5C, PLAN.md §4.14, §5.4): plain-code checked daily timesheet draft with summary header,
 * working-hour gaps, inline row editing, uncertain row confirmation, and "Always map X to task Y?" learning offers.
 */
export function TimesheetDraftCard({ card }: { card: Extract<CardItem, { cardType: "timesheet_draft" }> }) {
  const p = card.payload;
  const tracker = useTracker();
  const tracksTime = useTracksTime();
  const label = trackerLabel(tracker);
  const prepareTimesheet = useAria((s) => s.prepareTimesheet);
  const updateTimesheetEntry = useAria((s) => s.updateTimesheetEntry);
  const confirmTimesheetEntry = useAria((s) => s.confirmTimesheetEntry);
  const deleteTimesheetEntry = useAria((s) => s.deleteTimesheetEntry);
  const acceptRuleOffer = useAria((s) => s.acceptTimesheetRuleOffer);
  const dismissRuleOffer = useAria((s) => s.dismissTimesheetRuleOffer);
  const submitTimesheet = useAria((s) => s.submitTimesheet);
  const openTimeView = useAria((s) => s.openTimeView);

  const [editor, setEditor] = useState<TimesheetRowEditorState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    p.entries.length > 0 &&
    p.uncertainCount === 0 &&
    p.overlapCount === 0 &&
    p.duplicateCount === 0 &&
    p.entries.every((e) => Boolean(e.trackerTaskId));

  const runAction = async (fn: () => Promise<string | null>, closeEditor = false) => {
    setBusy(true);
    setError(null);
    const err = await fn();
    setBusy(false);
    if (err) setError(err);
    else if (closeEditor) setEditor(null);
  };

  const summaryParts: string[] = [
    `draft ${formatHoursMinutes(p.draftMinutes)}${p.registeredMinutes > 0 ? ` + ${formatHoursMinutes(p.registeredMinutes)} registered` : ""} of ${formatHoursMinutes(p.expectedMinutes)}`,
  ];
  if (p.gaps.length > 0) summaryParts.push(`${p.gaps.length} gap${p.gaps.length === 1 ? "" : "s"}`);
  if (p.uncertainCount > 0) summaryParts.push(`${p.uncertainCount} uncertain`);
  if (p.overlapCount > 0) summaryParts.push(`${p.overlapCount} overlap${p.overlapCount === 1 ? "" : "s"}`);
  if (p.duplicateCount > 0) summaryParts.push(`${p.duplicateCount} duplicate${p.duplicateCount === 1 ? "" : "s"}`);

  const hasIssues = p.uncertainCount > 0 || p.overlapCount > 0 || p.duplicateCount > 0 || p.gaps.length > 0;
  const field = "rounded border border-line bg-canvas px-1.5 py-0.5 text-xs text-fg outline-none focus:border-accent";

  return (
    <Shell
      testId="card-timesheet"
      cardId={card.id}
      tone={hasIssues ? "border-warn/60" : "border-ok/50"}
      icon={<Clock className={`h-4 w-4 ${hasIssues ? "text-warn" : "text-ok"}`} />}
      title={
        <span data-testid="timesheet-summary">
          Timesheet · {p.dateLabel}{" "}
          <span className="font-normal text-muted">· {summaryParts.join(" · ")}</span>
        </span>
      }
      right={
        <span className="shrink-0 font-mono text-[11px] text-muted" data-testid="timesheet-date">
          {p.date}
        </span>
      }
    >
      {p.gaps.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs" data-testid="timesheet-gaps">
          <span className="text-warn">Uncovered gaps:</span>
          {p.gaps.map((gap) => (
            <button
              key={`${gap.start}-${gap.end}`}
              type="button"
              data-testid="timesheet-fill-gap"
              disabled={busy}
              onClick={() => setEditor(toRowEditorState(undefined, gap.start, gap.end))}
              className="inline-flex items-center gap-1 rounded border border-warn/50 bg-warn/10 px-1.5 py-0.5 font-mono text-[11px] text-warn hover:border-warn"
              title="Click to add an entry for this gap"
            >
              <Plus className="h-3 w-3" /> {gap.start}–{gap.end} ({formatHoursMinutes(gap.minutes)})
            </button>
          ))}
        </div>
      )}

      {tracksTime && p.registered.length > 0 && (
        <div className="mt-1.5 space-y-1" data-testid="timesheet-registered">
          <div className="text-[11px] text-muted">Already registered in {label} ({formatHoursMinutes(p.registeredMinutes)})</div>
          {p.registered.map((reg) => (
            <div
              key={reg.id}
              className={`flex flex-wrap items-center gap-2 rounded px-2 py-1 text-xs ${
                reg.overlap ? "border border-bad/50 bg-bad/5 text-bad" : "bg-canvas/50 text-muted"
              }`}
            >
              <span className="font-mono">
                {reg.start}–{reg.end}
              </span>
              <span>({formatHoursMinutes(reg.minutes)})</span>
              <span className="font-mono text-fg">#{reg.trackerTaskId}</span>
              {reg.trackerTaskTitle && <span className="truncate">{reg.trackerTaskTitle}</span>}
              {reg.comment && <span className="min-w-0 flex-1 truncate text-muted">· {reg.comment}</span>}
              {reg.overlap && (
                <span className="inline-flex items-center gap-1 rounded bg-bad/20 px-1 py-0.5 text-[10px] font-medium text-bad">
                  <TriangleAlert className="h-3 w-3 shrink-0" /> overlap
                </span>
              )}
              <Button
                testId="timesheet-registered-duplicate-btn"
                disabled={busy}
                title="Duplicate this registered entry into the next free time slot"
                onClick={() =>
                  void runAction(() =>
                    updateTimesheetEntry({
                      date: p.date,
                      minutes: Math.max(15, reg.minutes),
                      trackerTaskId: reg.trackerTaskId,
                      ...(reg.trackerTaskTitle ? { trackerTaskTitle: reg.trackerTaskTitle } : {}),
                      ...(reg.trackerProjectId ? { trackerProjectId: reg.trackerProjectId } : {}),
                      ...(reg.trackerCustomerId ? { trackerCustomerId: reg.trackerCustomerId } : {}),
                      comment: reg.comment || reg.trackerTaskTitle || `Task #${reg.trackerTaskId}`,
                    }),
                  )
                }
              >
                <Copy className="h-3 w-3" /> Duplicate
              </Button>
              {reg.overlapDetails && reg.overlapDetails.length > 0 && (
                <div className="flex w-full flex-wrap items-center gap-1 pt-0.5 text-[11px] text-bad">
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
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 space-y-1.5" data-testid="timesheet-rows">
        {p.entries.length === 0 && <div className="text-xs text-muted">No draft rows for this day yet.</div>}
        {p.entries.map((entry) => {
          const isEditingThis = editor?.entryId === entry.id;
          if (isEditingThis && editor) {
            return (
              <div key={entry.id} className="space-y-2 rounded border border-accent/60 bg-canvas p-2 text-xs" data-testid="timesheet-row-editor">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-1">
                    <span className="text-muted">Start</span>
                    <input
                      data-testid="timesheet-edit-start"
                      value={editor.start}
                      onChange={(e) => setEditor({ ...editor, start: e.target.value })}
                      className={`${field} w-16 font-mono`}
                    />
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <span className="text-muted">End</span>
                    <input
                      data-testid="timesheet-edit-end"
                      value={editor.end}
                      onChange={(e) => setEditor({ ...editor, end: e.target.value })}
                      className={`${field} w-16 font-mono`}
                    />
                  </label>
                  {tracksTime && (
                    <>
                  <label className="inline-flex items-center gap-1">
                    <span className="text-muted">{label} task</span>
                    <input
                      data-testid="timesheet-edit-task"
                      value={editor.trackerTaskId}
                      onChange={(e) => {
                        const nextTask = e.target.value;
                        const changed = nextTask.trim() !== editor.trackerTaskId.trim();
                        setEditor({
                          ...editor,
                          trackerTaskId: nextTask,
                          ...(changed ? { trackerTaskTitle: "", trackerProjectId: "", trackerCustomerId: "" } : {}),
                        });
                      }}
                      placeholder="Task ID"
                      className={`${field} w-28 font-mono`}
                    />
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <span className="text-muted">Task title</span>
                    <input
                      data-testid="timesheet-edit-task-title"
                      value={editor.trackerTaskTitle}
                      onChange={(e) => setEditor({ ...editor, trackerTaskTitle: e.target.value })}
                      placeholder="Optional title"
                      className={`${field} w-36`}
                    />
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <span className="text-muted">Project ID</span>
                    <input
                      data-testid="timesheet-edit-project"
                      value={editor.trackerProjectId}
                      onChange={(e) => setEditor({ ...editor, trackerProjectId: e.target.value })}
                      placeholder="e.g. 27583"
                      className={`${field} w-20 font-mono`}
                    />
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <span className="text-muted">Customer ID</span>
                    <input
                      data-testid="timesheet-edit-customer"
                      value={editor.trackerCustomerId}
                      onChange={(e) => setEditor({ ...editor, trackerCustomerId: e.target.value })}
                      placeholder="e.g. 708"
                      className={`${field} w-20 font-mono`}
                    />
                  </label>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    data-testid="timesheet-edit-comment"
                    aria-label="Comment"
                    value={editor.comment}
                    onChange={(e) => setEditor({ ...editor, comment: e.target.value })}
                    placeholder="Comment describing work done…"
                    className={`${field} min-w-0 flex-1`}
                  />
                  <Button
                    testId="timesheet-row-save"
                    primary
                    disabled={busy || !effectiveRowComment(editor)}
                    onClick={() =>
                      void runAction(
                        () =>
                          updateTimesheetEntry({
                            date: p.date,
                            entryId: entry.id,
                            start: normalizeHHMM(editor.start),
                            end: normalizeHHMM(editor.end),
                            ...(editor.trackerTaskId.trim() ? { trackerTaskId: editor.trackerTaskId.trim() } : {}),
                            ...(editor.trackerTaskTitle.trim() ? { trackerTaskTitle: editor.trackerTaskTitle.trim() } : {}),
                            ...(editor.trackerProjectId.trim() ? { trackerProjectId: editor.trackerProjectId.trim() } : {}),
                            ...(editor.trackerCustomerId.trim() ? { trackerCustomerId: editor.trackerCustomerId.trim() } : {}),
                            comment: effectiveRowComment(editor),
                          }),
                        true,
                      )
                    }
                  >
                    Save
                  </Button>
                  <Button testId="timesheet-row-cancel" disabled={busy} onClick={() => setEditor(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            );
          }

          return (
            <div
              key={entry.id}
              data-testid="timesheet-row"
              data-entry-id={entry.id}
              data-confidence={entry.confidence}
              className={`flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded border px-2.5 py-1.5 text-xs ${
                entry.overlap || entry.overlapsTrackerId || entry.duplicateTrackerId
                  ? "border-bad/50 bg-bad/5"
                  : entry.confidence === "uncertain"
                    ? "border-warn/50 bg-warn/5"
                    : "border-line bg-canvas"
              }`}
            >
              <div className="inline-flex items-center gap-1 rounded border border-line bg-raised px-1.5 py-0.5">
                <button
                  type="button"
                  data-testid="timesheet-row-minus-15"
                  disabled={busy || entry.minutes <= 15}
                  title="Decrease by 15 minutes"
                  onClick={() =>
                    void runAction(() =>
                      updateTimesheetEntry({
                        date: p.date,
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
                <span className="font-mono font-semibold text-accent">~{formatHoursMinutes(entry.minutes)}</span>
                <button
                  type="button"
                  data-testid="timesheet-row-plus-15"
                  disabled={busy || entry.minutes >= 720}
                  title="Increase by 15 minutes"
                  onClick={() =>
                    void runAction(() =>
                      updateTimesheetEntry({
                        date: p.date,
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
              <span className="font-mono text-[11px] text-muted" data-testid="timesheet-row-time">
                {entry.start}–{entry.end}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium" data-testid="timesheet-row-comment" title={entry.comment}>
                {entry.comment}
              </span>
              {tracksTime && (
                <>
              {entry.trackerTaskId && !ownsTask(tracker, entry.trackerId) ? (
                // A task of another tracker: plain text, no link from this tracker's template; the row needs a task of this one.
                <span
                  className="inline-flex items-center gap-1 rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-muted"
                  data-testid="timesheet-row-task-plain"
                  title="This task is of another task tracker: pick one of this tracker's before submitting"
                >
                  #{entry.trackerTaskId}
                  {entry.trackerTaskTitle ? ` · ${entry.trackerTaskTitle}` : ""}
                </span>
              ) : entry.trackerTaskId ? (
                <button
                  type="button"
                  data-testid="timesheet-row-task"
                  onClick={() => openTrackerTask(tracker, entry.trackerTaskId!)}
                  className="inline-flex items-center gap-1 rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-accent hover:underline"
                  title={
                    entry.trackerProjectId && entry.trackerCustomerId
                      ? `Project ${entry.trackerProjectId} · Customer ${entry.trackerCustomerId}`
                      : "Project / customer ID not yet in cache"
                  }
                >
                  #{entry.trackerTaskId}
                  {entry.trackerTaskTitle ? ` · ${entry.trackerTaskTitle}` : ""}
                </button>
              ) : (
                <span className="rounded bg-bad/20 px-1.5 py-0.5 text-[11px] text-bad" data-testid="timesheet-row-unmapped">
                  No {label} task
                </span>
              )}
              <span className="rounded bg-raised px-1 py-0.5 text-[10px] text-muted" data-testid="timesheet-row-mapped-by">
                {entry.mappedBy}
              </span>
              {entry.confidence === "uncertain" && (
                <span className="inline-flex items-center gap-1 text-[11px] text-warn" data-testid="timesheet-row-uncertain" title={entry.uncertaintyReason}>
                  <TriangleAlert className="h-3 w-3 shrink-0" /> uncertain
                </span>
              )}
                </>
              )}
              {entry.overlap && (
                <span className="text-[11px] text-bad" data-testid="timesheet-row-overlap">
                  overlap
                </span>
              )}
              {tracksTime && (
                <>
              {entry.overlapsTrackerId && !entry.duplicateTrackerId && (
                <span className="text-[11px] text-bad" data-testid="timesheet-row-tracker-overlap">
                  overlaps {trackerRef(tracker, entry.overlapsTrackerId)}
                </span>
              )}
              {entry.duplicateTrackerId && (
                <span className="text-[11px] text-bad" data-testid="timesheet-row-duplicate">
                  duplicate of #{entry.duplicateTrackerId}
                </span>
              )}
              {entry.confidence === "uncertain" && entry.trackerTaskId && (
                <Button
                  testId="timesheet-row-confirm"
                  disabled={busy}
                  onClick={() => void runAction(() => confirmTimesheetEntry(p.date, entry.id))}
                >
                  <Check className="h-3 w-3" /> Confirm
                </Button>
              )}
                </>
              )}
              <Button
                testId="timesheet-row-edit"
                disabled={busy}
                onClick={() => setEditor(toRowEditorState(entry))}
              >
                <Pencil className="h-3 w-3" /> Edit
              </Button>
              <Button
                testId="timesheet-row-duplicate-btn"
                disabled={busy}
                title="Duplicate this entry into the next free time slot"
                onClick={() =>
                  void runAction(() =>
                    updateTimesheetEntry({
                      date: p.date,
                      minutes: Math.max(15, entry.minutes),
                      ...(entry.trackerTaskId ? { trackerTaskId: entry.trackerTaskId } : {}),
                      ...(entry.trackerTaskTitle ? { trackerTaskTitle: entry.trackerTaskTitle } : {}),
                      ...(entry.trackerProjectId ? { trackerProjectId: entry.trackerProjectId } : {}),
                      ...(entry.trackerCustomerId ? { trackerCustomerId: entry.trackerCustomerId } : {}),
                      comment: entry.comment,
                    }),
                  )
                }
              >
                <Copy className="h-3 w-3" /> Duplicate
              </Button>
              <Button
                testId="timesheet-row-delete"
                disabled={busy}
                onClick={() => void runAction(() => deleteTimesheetEntry(p.date, entry.id))}
                title="Remove this row"
              >
                <Trash className="h-3 w-3" />
              </Button>
              {entry.overlapDetails && entry.overlapDetails.length > 0 && (
                <div className="flex w-full flex-wrap items-center gap-1 text-[11px] text-bad" data-testid="timesheet-row-overlap-details">
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
                <div className="flex w-full flex-wrap items-center gap-1 pt-0.5 text-[11px] text-muted" data-testid="timesheet-row-sources">
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

        {editor && !editor.entryId && (
          <div className="space-y-2 rounded border border-accent/60 bg-canvas p-2 text-xs" data-testid="timesheet-row-editor">
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-1">
                <span className="text-muted">Start</span>
                <input
                  data-testid="timesheet-edit-start"
                  value={editor.start}
                  onChange={(e) => setEditor({ ...editor, start: e.target.value })}
                  className={`${field} w-16 font-mono`}
                />
              </label>
              <label className="inline-flex items-center gap-1">
                <span className="text-muted">End</span>
                <input
                  data-testid="timesheet-edit-end"
                  value={editor.end}
                  onChange={(e) => setEditor({ ...editor, end: e.target.value })}
                  className={`${field} w-16 font-mono`}
                />
              </label>
              {tracksTime && (
                <>
              <label className="inline-flex items-center gap-1">
                <span className="text-muted">{label} task</span>
                <input
                  data-testid="timesheet-edit-task"
                  value={editor.trackerTaskId}
                  onChange={(e) => setEditor({ ...editor, trackerTaskId: e.target.value })}
                  placeholder="Task ID"
                  className={`${field} w-28 font-mono`}
                />
              </label>
              <label className="inline-flex items-center gap-1">
                <span className="text-muted">Task title</span>
                <input
                  data-testid="timesheet-edit-task-title"
                  value={editor.trackerTaskTitle}
                  onChange={(e) => setEditor({ ...editor, trackerTaskTitle: e.target.value })}
                  placeholder="Optional title"
                  className={`${field} w-36`}
                />
              </label>
              <label className="inline-flex items-center gap-1">
                <span className="text-muted">Project ID</span>
                <input
                  data-testid="timesheet-edit-project"
                  value={editor.trackerProjectId}
                  onChange={(e) => setEditor({ ...editor, trackerProjectId: e.target.value })}
                  placeholder="e.g. 27583"
                  className={`${field} w-20 font-mono`}
                />
              </label>
              <label className="inline-flex items-center gap-1">
                <span className="text-muted">Customer ID</span>
                <input
                  data-testid="timesheet-edit-customer"
                  value={editor.trackerCustomerId}
                  onChange={(e) => setEditor({ ...editor, trackerCustomerId: e.target.value })}
                  placeholder="e.g. 708"
                  className={`${field} w-20 font-mono`}
                />
              </label>
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input
                data-testid="timesheet-edit-comment"
                aria-label="Comment"
                value={editor.comment}
                onChange={(e) => setEditor({ ...editor, comment: e.target.value })}
                placeholder="Comment describing work done…"
                className={`${field} min-w-0 flex-1`}
              />
              <Button
                testId="timesheet-row-save"
                primary
                disabled={busy || !effectiveRowComment(editor)}
                onClick={() =>
                  void runAction(
                    () =>
                      updateTimesheetEntry({
                        date: p.date,
                        addNew: true,
                        start: normalizeHHMM(editor.start),
                        end: normalizeHHMM(editor.end),
                        ...(editor.trackerTaskId.trim() ? { trackerTaskId: editor.trackerTaskId.trim() } : {}),
                        ...(editor.trackerTaskTitle.trim() ? { trackerTaskTitle: editor.trackerTaskTitle.trim() } : {}),
                        ...(editor.trackerProjectId.trim() ? { trackerProjectId: editor.trackerProjectId.trim() } : {}),
                        ...(editor.trackerCustomerId.trim() ? { trackerCustomerId: editor.trackerCustomerId.trim() } : {}),
                        comment: effectiveRowComment(editor),
                      }),
                    true,
                  )
                }
              >
                Add row
              </Button>
              <Button testId="timesheet-row-cancel" disabled={busy} onClick={() => setEditor(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>

      {(tracksTime ? p.ruleOffers : []).map((offer) => (
        <div
          key={offer.id}
          data-testid="timesheet-rule-offer"
          className="mt-2 flex flex-wrap items-center gap-2 rounded border border-accent/50 bg-accent/10 px-2.5 py-1.5 text-xs"
        >
          <span className="min-w-0 flex-1">{offer.prompt}</span>
          <Button
            testId="timesheet-rule-accept"
            primary
            disabled={busy}
            onClick={() => void runAction(() => acceptRuleOffer(p.date, offer.id))}
          >
            Save rule
          </Button>
          <Button
            testId="timesheet-rule-dismiss"
            disabled={busy}
            onClick={() => void runAction(() => dismissRuleOffer(p.date, offer.id))}
          >
            Dismiss
          </Button>
        </div>
      ))}

      {(error ?? p.error) && (
        <div className="mt-2 text-xs text-bad" data-testid="timesheet-error">
          {error ?? p.error}
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-1.5">
        {tracksTime && p.entries.length > 0 && (
          <Button
            testId="timesheet-submit"
            primary={canSubmit}
            disabled={busy || !canSubmit}
            title={
              canSubmit
                ? `Register these entries in ${label}${viaCreateTool(tracker)}`
                : "Confirm uncertain rows and resolve any overlaps or duplicates before submitting"
            }
            onClick={() => void runAction(() => submitTimesheet(p.date))}
          >
            <Check className="h-3 w-3" /> {busy ? "Submitting…" : "Submit"}
          </Button>
        )}
        {!editor && (
          <Button
            testId="timesheet-add-row"
            disabled={busy}
            onClick={() => setEditor(toRowEditorState(undefined, p.gaps[0]?.start ?? "09:00", p.gaps[0]?.end ?? "10:00"))}
          >
            <Plus className="h-3 w-3" /> Add row
          </Button>
        )}
        <Button
          testId="timesheet-refresh"
          disabled={busy}
          onClick={() => void runAction(() => prepareTimesheet(p.date))}
        >
          <RotateCcw className="h-3 w-3" /> Refresh draft
        </Button>
        <Button
          testId="timesheet-open-time-view"
          disabled={busy}
          onClick={() => openTimeView(p.date)}
        >
          <Clock className="h-3 w-3" /> Open in Time view
        </Button>
      </div>
    </Shell>
  );
}

/**
 * Time registered card (Phase 5D, PLAN.md §4.14 #5, §5.4, D16): reports per-entry tracker registration status and IDs
 * from the tracker's create tool, and displays the server's full response on partial or full failure.
 */
export function TimeRegisteredCard({ card }: { card: Extract<CardItem, { cardType: "time_registered" }> }) {
  const p = card.payload;
  const label = trackerLabel(useTracker());
  const tracksTime = useTracksTime();
  const submitTimesheet = useAria((s) => s.submitTimesheet);
  const prepareTimesheet = useAria((s) => s.prepareTimesheet);
  const updateTimesheetEntry = useAria((s) => s.updateTimesheetEntry);
  const openTimeView = useAria((s) => s.openTimeView);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const failedIds = p.entries.filter((e) => e.status === "failed").map((e) => e.entryId);
  const hasUnknown = p.needsReconcile === true || p.entries.some((e) => e.status === "unknown");
  const isOk = p.status === "registered";
  const isFailed = p.status === "failed" || p.status === "partial";
  const tone = isOk ? "border-ok/50" : isFailed ? "border-bad/50" : "border-accent/60";

  const statusText =
    p.status === "submitting"
      ? `Submitting ${formatHoursMinutes(p.totalMinutes)}…`
      : p.status === "registered"
        ? `Registered ${formatHoursMinutes(p.registeredMinutes)}`
        : p.status === "partial"
          ? `Partially registered (${formatHoursMinutes(p.registeredMinutes)} of ${formatHoursMinutes(p.totalMinutes)})`
          : hasUnknown
            ? `Outcome unknown — check ${label}`
            : "Submit failed";

  const retryFailed = async () => {
    if (busy || failedIds.length === 0 || hasUnknown) return;
    setBusy(true);
    setError(null);
    const err = await submitTimesheet(p.date, failedIds);
    setBusy(false);
    if (err) setError(err);
  };

  const reconcileWithTracker = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const err = await prepareTimesheet(p.date);
    setBusy(false);
    if (err) setError(err);
  };

  return (
    <Shell
      testId="card-time-registered"
      cardId={card.id}
      tone={tone}
      icon={
        isOk ? (
          <Check className="h-4 w-4 text-ok" />
        ) : isFailed ? (
          <CircleX className="h-4 w-4 text-bad" />
        ) : (
          <Clock className="h-4 w-4 text-accent" />
        )
      }
      title={
        <span data-testid="time-registered-title" data-status={p.status}>
          Time registered · {p.dateLabel} <span className="font-normal text-muted">· {statusText}</span>
        </span>
      }
      right={
        <span className="shrink-0 font-mono text-[11px] text-muted" data-testid="time-registered-date">
          {p.date}
        </span>
      }
    >
      <div className="mt-2 space-y-1" data-testid="time-registered-entries">
        {p.entries.map((entry) => (
          <div
            key={entry.entryId}
            data-testid="time-registered-row"
            data-status={entry.status}
            className={`flex flex-wrap items-center gap-2 rounded border px-2.5 py-1 text-xs ${
              entry.status === "registered" ? "border-line bg-canvas" : "border-bad/50 bg-bad/5"
            }`}
          >
            <span className="font-mono font-medium">
              {entry.start}–{entry.end}
            </span>
            <span className="text-muted">({formatHoursMinutes(entry.minutes)})</span>
            <span className="min-w-0 flex-1 truncate">{entry.comment}</span>
            <span className="font-mono text-muted">#{entry.trackerTaskId}</span>
            {entry.status === "registered" && entry.trackerEntryId ? (
              <span className="rounded bg-ok/15 px-1.5 py-0.5 font-mono text-[11px] text-ok" data-testid="time-registered-entry-id">
                {label} #{entry.trackerEntryId}
              </span>
            ) : entry.status === "unknown" ? (
              <span className="text-[11px] text-warn" data-testid="time-registered-entry-unknown">
                {entry.error ?? `Outcome unknown — check ${label} before retrying`}
              </span>
            ) : entry.status === "failed" ? (
              <span className="text-[11px] text-bad" data-testid="time-registered-entry-error">
                {entry.error ?? "Failed"}
              </span>
            ) : (
              <span className="text-[11px] text-muted">Submitting…</span>
            )}
            {p.status !== "submitting" && (
              <Button
                testId="time-registered-duplicate-btn"
                disabled={busy}
                title="Duplicate this entry into the next free time slot on the timesheet draft"
                onClick={async () => {
                  if (busy) return;
                  setBusy(true);
                  setError(null);
                  const err = await updateTimesheetEntry({
                    date: p.date,
                    minutes: Math.max(15, entry.minutes),
                    trackerTaskId: entry.trackerTaskId,
                    ...(entry.trackerTaskTitle ? { trackerTaskTitle: entry.trackerTaskTitle } : {}),
                    ...(entry.trackerProjectId ? { trackerProjectId: entry.trackerProjectId } : {}),
                    ...(entry.trackerCustomerId ? { trackerCustomerId: entry.trackerCustomerId } : {}),
                    comment: entry.comment,
                  });
                  setBusy(false);
                  if (err) setError(err);
                }}
              >
                <Copy className="h-3 w-3" /> Duplicate
              </Button>
            )}
          </div>
        ))}
      </div>

      {p.rawResponse && (
        <div className="mt-2">
          <div className="text-[11px] text-muted">Full {label} server response (D16)</div>
          <pre
            data-testid="time-registered-raw-response"
            className="mt-0.5 max-h-52 overflow-auto whitespace-pre-wrap rounded bg-canvas px-2 py-1 font-mono text-xs text-bad"
          >
            {visibleJsonText(p.rawResponse)}
          </pre>
        </div>
      )}

      {(error ?? p.error) && (
        <div className="mt-2 text-xs text-bad" data-testid="time-registered-error">
          {error ?? p.error}
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button testId="time-registered-open-time-view" disabled={busy} onClick={() => openTimeView(p.date)}>
          <Clock className="h-3 w-3" /> Open in Time view
        </Button>
        {tracksTime && hasUnknown && p.status !== "submitting" && (
          <Button testId="time-registered-reconcile" primary disabled={busy} onClick={() => void reconcileWithTracker()}>
            <RotateCcw className="h-3 w-3" /> {busy ? `Checking ${label}…` : `Refresh & check ${label}`}
          </Button>
        )}
        {tracksTime && !hasUnknown && failedIds.length > 0 && p.status !== "submitting" && (
          <Button testId="time-registered-retry" primary disabled={busy} onClick={() => void retryFailed()}>
            <RotateCcw className="h-3 w-3" /> {busy ? "Retrying…" : "Retry failed"}
          </Button>
        )}
      </div>
    </Shell>
  );
}
