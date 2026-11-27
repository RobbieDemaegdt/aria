import type { PendingPermission, PendingPlan, PendingQuestion, RuleOffer, Task, TranscriptEntry, YourWords } from "@aria/protocol";
import {
  Brain,
  ChevronDown,
  ChevronRight,
  CirclePause,
  CircleQuestionMark,
  ClipboardList,
  Cloud,
  Code,
  ExternalLink,
  GitBranch,
  Maximize2,
  Minimize2,
  Paperclip,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  ShieldX,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { TRANSCRIPT_PAGE, widenTo } from "@aria/protocol/transcript";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { diffPreviewContent, extractJsonStringField, extractToolFilePreview, parseDiff, previewKind, type DiffFile } from "../filePreview";
import { offerFor, refusedBy, yourWordsIn } from "../flow";
import { errorText, selectAgents, useHasTracker, useAria, useTracker } from "../store";
import { AgentSelectOptions } from "./AgentOptions";
import { OpenPrButton, PermissionActions, PlanActions, PrConfirmCard, QuestionForm, ShortId, TaskPrLink } from "./Cards";
import { FilePreview } from "./FilePreview";
import { AlwaysAllow, SaveMemory } from "./Flow";
import { Markdown } from "./Markdown";
import { credits, duration, elapsed, isActive, StateChip, StateIcon, useNow } from "./tasks";
import { openPage } from "../openPage";
import { openTrackerTask, ownsTask, trackerLabel, trackerRef } from "../tracker";

/** The argument worth showing next to a tool's name: the command, the file, the pattern. */
function keyArg(name: string, args?: string): string | undefined {
  if (!args) return undefined;
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const pick = parsed.command ?? parsed.path ?? parsed.file_path ?? parsed.fileName ?? parsed.pattern ?? parsed.description ?? parsed.query ?? Object.values(parsed).find((v) => typeof v === "string");
    return typeof pick === "string" ? pick.split(/\r?\n/)[0] : undefined;
  } catch {
    const extracted = extractJsonStringField(args, ["command", "path", "file_path", "fileName", "pattern", "description", "query"]);
    if (extracted) return extracted.value.split(/\r?\n/)[0];
    return name === "powershell" ? args.split(/\r?\n/)[0] : undefined;
  }
}

/** Says, below the text, how much of it was cut off at the size limit (a box of it scrolls, so it can't be at its end). */
export function CutNote({ chars, what }: { chars?: number | undefined; what: string }) {
  if (!chars) return null;
  return (
    <div className="text-[11px] text-warn" data-testid="transcript-cut">
      {chars.toLocaleString()} more characters of the {what} aren't shown.
    </div>
  );
}

/**
 * A tool call. `refused`: ARIA's policy refused it (the inspector folds the refusal into the call). Memoized, like
 * `Entry`: the store keeps an unchanged step as the same object, so a new step doesn't draw the others again.
 */
export const ToolEntry = memo(function ToolEntry({
  entry,
  refused,
  taskId,
  focused,
}: {
  entry: Extract<TranscriptEntry, { kind: "tool" }>;
  refused?: string | undefined;
  taskId?: string | undefined;
  focused?: boolean | undefined;
}) {
  const preview = useMemo(() => (refused === undefined && entry.success !== false ? extractToolFilePreview(entry) : undefined), [entry, refused]);
  const [open, setOpen] = useState(() => Boolean(preview?.isWrite || focused));
  const [mode, setMode] = useState<"preview" | "raw">("preview");
  useEffect(() => {
    if (focused) setOpen(true);
  }, [focused]);
  const arg = keyArg(entry.name, entry.args);
  const tone = entry.success === false || refused !== undefined ? "text-bad" : "text-muted";
  const hasPreview = Boolean(preview && (preview.content !== undefined || taskId));
  return (
    <div className="text-xs" data-testid="transcript-tool" data-tool={entry.name}>
      <div className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 hover:bg-raised">
        <button onClick={() => setOpen(!open)} aria-expanded={open} className={`flex min-w-0 flex-1 items-center gap-1.5 text-left ${tone}`}>
          {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          <Wrench className="h-3 w-3 shrink-0" />
          <span className="shrink-0 font-medium text-fg/90">{entry.name}</span>
          {arg && <span className="truncate font-mono">{arg}</span>}
        </button>
        {hasPreview && preview && (
          <div className="inline-flex shrink-0 rounded border border-line bg-canvas p-0.5 text-[10px]" data-testid="tool-preview-toggle">
            <button
              type="button"
              data-testid="tool-mode-preview"
              aria-pressed={open && mode === "preview"}
              onClick={() => {
                setMode("preview");
                setOpen(true);
              }}
              className={`rounded px-1.5 py-px ${open && mode === "preview" ? "bg-accent text-white" : "text-muted hover:text-fg"}`}
            >
              {preview.kind === "markdown" ? "Markdown" : "HTML"} preview
            </button>
            <button
              type="button"
              data-testid="tool-mode-raw"
              aria-pressed={open && mode === "raw"}
              onClick={() => {
                setMode("raw");
                setOpen(true);
              }}
              className={`rounded px-1.5 py-px ${open && mode === "raw" ? "bg-accent text-white" : "text-muted hover:text-fg"}`}
            >
              Raw
            </button>
          </div>
        )}
        <span className={`shrink-0 ${tone}`}>
          {refused !== undefined ? "refused" : entry.success === undefined ? "running…" : entry.success ? (entry.ms !== undefined ? duration(entry.ms) : "") : "failed"}
        </span>
      </div>
      {refused !== undefined && (
        <div className="ml-5 flex items-start gap-1 text-warn" data-testid="transcript-refused">
          <ShieldX className="mt-0.5 h-3 w-3 shrink-0" />
          <span>Refused by the policy{refused ? `: ${refused}` : ""}</span>
        </div>
      )}
      {open && (
        <div className="ml-5 mt-1 space-y-1">
          {hasPreview && preview && mode === "preview" ? (
            <FilePreview
              path={preview.path}
              kind={preview.kind}
              fallbackContent={preview.content}
              taskId={taskId}
              loadFromWorktree={Boolean(taskId && (preview.partial || preview.content === undefined))}
              reloadKey={`${entry.success ?? ""}-${entry.ms ?? ""}`}
            />
          ) : (
            <>
              {entry.args && <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-canvas p-2 font-mono text-[11px] text-muted">{entry.args}</pre>}
              <CutNote chars={entry.argsCut} what="arguments" />
              {(entry.result ?? entry.error) && (
                <pre className={`max-h-64 overflow-auto whitespace-pre-wrap rounded bg-canvas p-2 font-mono text-[11px] ${entry.error ? "text-bad" : "text-muted"}`}>{entry.error ?? entry.result}</pre>
              )}
              {entry.error ? <CutNote chars={entry.errorCut} what="error" /> : <CutNote chars={entry.resultCut} what="result" />}
            </>
          )}
        </div>
      )}
    </div>
  );
});

/** `refused`: for a tool call, why the policy refused it (the step then says "refused", not "failed"). */
export const Entry = memo(function Entry({
  entry,
  first,
  refused,
  taskId,
  focused,
}: {
  entry: TranscriptEntry;
  first: boolean;
  refused?: string | undefined;
  taskId?: string | undefined;
  focused?: boolean | undefined;
}) {
  const [open, setOpen] = useState(() => Boolean(first || focused));
  useEffect(() => {
    if (focused) setOpen(true);
  }, [focused]);
  switch (entry.kind) {
    case "user":
      return (
        <div className="rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-sm" data-testid="transcript-user">
          <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-center gap-1 text-xs font-medium text-muted">
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {entry.source ? `Added by the runtime (${entry.source})` : first ? "Brief" : "Message"}
          </button>
          {open ? <div className="mt-1 whitespace-pre-wrap wrap-anywhere">{entry.text}</div> : <div className="mt-1 truncate text-muted">{entry.text.split(/\r?\n/)[0]}</div>}
          {open && <CutNote chars={entry.textCut} what="message" />}
        </div>
      );
    case "assistant":
      return (
        <div className="px-1 text-sm" data-testid="transcript-assistant">
          <Markdown text={entry.text} />
          <CutNote chars={entry.textCut} what="answer" />
        </div>
      );
    case "reasoning":
      return (
        <div className="text-xs text-muted">
          <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-center gap-1 px-1">
            <Brain className="h-3 w-3" /> Thinking {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
          {open && (
            <div className="ml-5 mt-1">
              <Markdown text={entry.text} />
              <CutNote chars={entry.textCut} what="reasoning" />
            </div>
          )}
        </div>
      );
    case "tool":
      return <ToolEntry entry={entry} refused={refused} taskId={taskId} focused={focused} />;
    case "permission":
      return (
        <div className={`flex items-start gap-1.5 px-1 text-xs ${entry.approved === false ? "text-warn" : "text-muted"}`} data-testid="transcript-permission">
          {entry.approved === false ? <ShieldX className="mt-0.5 h-3 w-3 shrink-0" /> : <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" />}
          <span>
            {entry.approved === undefined ? "Asked: " : entry.approved ? "Allowed: " : "Refused: "}
            <span className="font-mono">{entry.detail}</span>
            {entry.reason && <span className="block text-muted">{entry.reason}</span>}
          </span>
        </div>
      );
    case "question":
      return (
        <div className="rounded-md border border-line px-3 py-2 text-sm" data-testid="transcript-question">
          <div className="flex items-start gap-1.5">
            <CircleQuestionMark className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bad" />
            <div className="min-w-0 flex-1 wrap-anywhere">
              <Markdown text={entry.question} />
            </div>
          </div>
          <div className="mt-1 text-xs text-muted">{entry.answer ? `→ ${entry.answer}` : "Waiting for your answer."}</div>
        </div>
      );
    case "info": {
      const tone = entry.level === "error" ? "text-bad" : entry.level === "warning" ? "text-warn" : "text-muted";
      if (!entry.detail) return <div className={`px-1 text-xs ${tone}`} data-testid="transcript-info">{entry.text}</div>;
      return (
        <div className={`px-1 text-xs ${tone}`} data-testid="transcript-info">
          {entry.text}
          <details className="mt-0.5">
            <summary className="cursor-pointer">What it kept</summary>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-canvas p-2 font-mono text-[11px] text-muted">{entry.detail}</pre>
            <CutNote chars={entry.detailCut} what="summary" />
          </details>
        </div>
      );
    }
  }
});

/** How many steps a session shows when it opens, and how many more each "Show more" adds (one page, P4). */
export { TRANSCRIPT_PAGE };

/** What a step shows below itself: the "Always allow" offer for it, and your words in it to save as a note. */
export interface StepExtras {
  offer?: RuleOffer;
  words?: YourWords;
}

/**
 * Each step's offer and words, worked out once for the loaded steps: each offer goes with the first step it fits
 * (`offerFor`), so this runs over every loaded step in order, shown or not. Both are the store's own objects, so a step
 * whose extras didn't change gets the same props. `notBefore`, while earlier steps aren't loaded: when the first loaded
 * one started. An offer from before then is for one of those steps, so it waits for their page rather than going with
 * a later step that fits it as well.
 */
export function stepExtras(
  entries: readonly TranscriptEntry[],
  offers: readonly RuleOffer[] | undefined,
  yours: readonly YourWords[] | undefined,
  notBefore?: number,
): Map<string, StepExtras> {
  const extras = new Map<string, StepExtras>();
  if (!offers?.length && !yours?.length) return extras;
  const used = new Set<string>(notBefore === undefined ? [] : (offers ?? []).filter((o) => o.at < notBefore).map((o) => o.id));
  for (const entry of entries) {
    const offer = offers ? offerFor(entry, offers, used) : undefined;
    const words = yours ? yourWordsIn(entry, yours) : undefined;
    if (offer || words) extras.set(entry.id, { ...(offer ? { offer } : {}), ...(words ? { words } : {}) });
  }
  return extras;
}

/**
 * Where the shown steps start. When they first come, the last page. From then on it stays put, so a new step adds to
 * what's shown and nothing moves under you; `from` is that start. A step that a jump from Search or a card focuses on
 * further back brings in whole pages until it's shown: the same pages a jump reads (`pageStart` in the protocol).
 */
export function transcriptStart(length: number, from: number | undefined, focusIndex: number): number {
  return widenTo(from !== undefined && from < length ? from : Math.max(0, length - TRANSCRIPT_PAGE), focusIndex);
}

/** Where a step is in the scrolling box, from its top edge. */
function topIn(box: HTMLElement, entryId: string): number | undefined {
  const row = box.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(entryId)}"]`);
  return row ? row.getBoundingClientRect().top - box.getBoundingClientRect().top : undefined;
}

/**
 * After a new step: the start that keeps a session you follow at its end to two pages at most (the steps far above go
 * again), or `start` as it is when you've scrolled up or jumped to a step.
 */
export function followedStart(length: number, start: number, following: boolean): number {
  return following && length - start > 2 * TRANSCRIPT_PAGE ? length - TRANSCRIPT_PAGE : start;
}

/** One step with what goes below it. Memoized: each prop stays the same object while the step doesn't change. */
export const TranscriptStep = memo(function TranscriptStep({
  entry,
  first,
  offer,
  words,
  taskId,
  focused,
}: {
  entry: TranscriptEntry;
  first: boolean;
  offer: RuleOffer | undefined;
  words: YourWords | undefined;
  taskId: string;
  focused: boolean;
}) {
  return (
    // Read when clicked, not subscribed to: a long session has hundreds of these.
    <div data-entry-id={entry.id} onClick={focused ? () => useAria.getState().clearTranscriptFocus() : undefined}>
      {/* A step with an offer is one your own Never rule refused: it says so, rather than "failed". */}
      <Entry entry={entry} first={first} refused={offer && entry.kind === "tool" ? refusedBy(offer) : undefined} taskId={taskId} focused={focused} />
      {offer && (
        <div className="ml-5" data-testid="step-offer">
          <AlwaysAllow taskId={taskId} offer={offer} />
        </div>
      )}
      {words && <SaveMemory text={words.text} from={{ taskId, wordsId: words.id }} taskId={taskId} />}
    </div>
  );
});

const NO_ENTRIES: readonly TranscriptEntry[] = [];

export function Transcript({ task }: { task: Task }) {
  const loaded = useAria((s) => s.transcripts[task.id]);
  const offers = useAria((s) => s.offers[task.id]);
  const yours = useAria((s) => s.yours[task.id]);
  const transcriptFocus = useAria((s) => s.transcriptFocus);
  const loadOffers = useAria((s) => s.loadOffers);
  const loadYourWords = useAria((s) => s.loadYourWords);
  const loadEarlierSteps = useAria((s) => s.loadEarlierSteps);
  const entries = loaded?.entries;
  const all = entries ?? NO_ENTRIES;
  // Positions count from the task's first step; the loaded ones start at `offset` (the steps before aren't read yet).
  const offset = loaded?.omitted ?? 0;
  const length = offset + all.length;
  const firstStep = offset > 0 ? loaded?.first : all[0];
  // "Always allow" for steps your rules refused: read when the view opens, and again when a refused step comes in.
  const refused = all.filter((e) => (e.kind === "tool" && e.success === false) || (e.kind === "permission" && e.approved === false)).map((e) => e.id).join(",");
  useEffect(() => {
    void loadOffers(task.id);
  }, [task.id, refused, loadOffers]);
  // Your words to it (the store reads them again after you send it something).
  useEffect(() => {
    void loadYourWords(task.id);
  }, [task.id, loadYourWords]);
  // The brief is worked out with the loaded steps: it's shown above them, loaded or not.
  const counted = useMemo(() => (offset > 0 && loaded?.first ? [loaded.first, ...all] : all), [offset, loaded?.first, all]);
  const notBefore = offset > 0 ? all[0]?.at : undefined;
  const extras = useMemo(() => stepExtras(counted, offers, yours, notBefore), [counted, offers, yours, notBefore]);
  const focusId = transcriptFocus?.taskId === task.id ? transcriptFocus.entryId : undefined;
  // A jump to the brief brings in no pages: it's shown above the rest, wherever they start (and core reads none, P4).
  const briefFocused = focusId !== undefined && firstStep?.kind === "user" && firstStep.id === focusId;
  const focusIndex = useMemo(() => {
    const at = focusId === undefined || briefFocused ? -1 : all.findIndex((e) => e.id === focusId);
    return at < 0 ? -1 : offset + at;
  }, [all, focusId, offset, briefFocused]);
  const [from, setFrom] = useState<number | undefined>(undefined);
  const start = transcriptStart(length, from, focusIndex);
  // What's shown starts at `start` once its steps are loaded; until then, at the first loaded one.
  const shownFrom = Math.max(start, offset);
  const loadingEarlier = start < offset;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Kept once there are steps, so later ones add to what's shown (and what a jump brought in stays); while you follow
  // the end without a jump, the steps far above go again.
  useEffect(() => {
    if (length === 0) return;
    const next = followedStart(length, start, stick.current && focusId === undefined);
    if (next !== from) setFrom(next);
  }, [length, start, from, focusId]);
  // "Show more" keeps what you were looking at where it was: the first step below the note stays at the same height
  // once the steps above it are there. They can be a read away (P4), while a running task adds steps below and you
  // may scroll: the step's place is noted again as you do.
  const keep = useRef<{ id: string; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    const kept = keep.current;
    if (!el || !kept) return;
    const top = topIn(el, kept.id);
    if (top !== undefined) el.scrollTop += top - kept.top;
    // Some of the steps were loaded and are shown now, and the rest is a read away: held on to until they come.
    keep.current = loadingEarlier && top !== undefined ? { id: kept.id, top: topIn(el, kept.id) ?? kept.top } : null;
  }, [shownFrom, loadingEarlier]);
  // The steps to show from aren't all loaded ("Show more", or a jump further back): their page is read. If it can't
  // be, what's loaded is what's shown, and "Show more" can be clicked again.
  useEffect(() => {
    if (!loadingEarlier) return;
    let current = true;
    void loadEarlierSteps(task.id).then((ok) => {
      if (ok) return;
      keep.current = null;
      if (current) setFrom(useAria.getState().transcripts[task.id]?.omitted ?? 0);
    });
    return () => {
      current = false;
    };
  }, [loadingEarlier, offset, task.id, loadEarlierSteps]);
  // The brief stays above the rest, so what the task was asked is always there.
  const brief = shownFrom > 0 && firstStep?.kind === "user" ? firstStep : undefined;
  const hidden = shownFrom - (brief ? 1 : 0);
  const showMore = () => {
    if (loadingEarlier) return;
    const el = scroller.current;
    const below = all[shownFrom - offset];
    if (el) {
      const top = below ? topIn(el, below.id) : undefined;
      keep.current = below && top !== undefined ? { id: below.id, top } : null;
      // The last "Show more" takes its button away: the keyboard stays in the transcript.
      if (hidden <= TRANSCRIPT_PAGE) el.focus({ preventScroll: true });
    }
    setFrom(Math.max(0, start - TRANSCRIPT_PAGE));
  };
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current && focusId === undefined) el.scrollTop = el.scrollHeight;
  }, [entries, focusId, shownFrom]);
  // To a step you jumped to, once: when the jump comes, or when its step does. Not again for a new step or "Show more",
  // which would take you back to it.
  const focusAt = transcriptFocus?.at;
  const focusShown = focusIndex >= 0 || briefFocused;
  useEffect(() => {
    const box = scroller.current;
    if (focusId === undefined || !focusShown || !box) return;
    const find = () => box.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(focusId)}"]`);
    const el = find();
    if (!el) return;
    stick.current = false;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.animate?.([{ outline: "2px solid rgb(47 129 247)" }, { outline: "2px solid transparent" }], { duration: 1600 });
    // A panel that just opened is still finding its width, and the steps wrap again: for a moment, unless you scroll
    // yourself, a change of size brings the step back to the middle.
    if (typeof ResizeObserver === "undefined") return;
    const width = box.clientWidth;
    const height = box.clientHeight;
    const observer = new ResizeObserver(() => {
      if (box.clientWidth !== width || box.clientHeight !== height) find()?.scrollIntoView({ block: "center" });
    });
    observer.observe(box);
    const stop = () => observer.disconnect();
    const timer = setTimeout(stop, 1_000);
    const userInput = ["wheel", "pointerdown", "keydown", "touchstart"] as const;
    for (const type of userInput) box.addEventListener(type, stop, { passive: true });
    return () => {
      stop();
      clearTimeout(timer);
      for (const type of userInput) box.removeEventListener(type, stop);
    };
  }, [focusId, focusAt, focusShown]);
  const step = (entry: TranscriptEntry, index: number) => {
    const extra = extras.get(entry.id);
    return (
      <TranscriptStep
        key={entry.id}
        entry={entry}
        first={index === 0 && entry.kind === "user"}
        offer={extra?.offer}
        words={extra?.words}
        taskId={task.id}
        focused={focusId === entry.id}
      />
    );
  };
  return (
    <div
      ref={scroller}
      tabIndex={-1}
      className="flex-1 overflow-y-auto outline-none"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        const kept = keep.current;
        if (kept) kept.top = topIn(el, kept.id) ?? kept.top;
      }}
    >
      <div className="space-y-2 p-3" data-testid="transcript">
        {!entries && <div className="text-xs text-muted">Loading…</div>}
        {entries?.length === 0 && <div className="text-xs text-muted">{task.cleanedUp ? "Its worktree was cleaned up, so its session can't be opened anymore." : "Nothing yet: the task hasn't started."}</div>}
        {/* One keyed list, so the brief keeps its state (folded, a note being written) when it joins the rest. */}
        {[
          ...(brief ? [step(brief, 0)] : []),
          ...(hidden > 0
            ? [
                <div key="earlier" className="flex items-center gap-2 text-xs text-muted" data-testid="transcript-earlier" data-count={hidden}>
                  <span>
                    {hidden.toLocaleString()} earlier {hidden === 1 ? "step isn't" : "steps aren't"} shown.
                  </span>
                  <button
                    type="button"
                    data-testid="transcript-show-earlier"
                    onClick={showMore}
                    aria-disabled={loadingEarlier || undefined}
                    className={loadingEarlier ? "text-muted" : "text-accent hover:underline"}
                  >
                    {loadingEarlier ? "Loading…" : `Show ${Math.min(TRANSCRIPT_PAGE, hidden)} more`}
                  </button>
                </div>,
              ]
            : []),
          ...all.slice(shownFrom - offset).map((entry, i) => step(entry, shownFrom + i)),
        ]}
      </div>
    </div>
  );
}

function DiffFileView({ file, taskId, reloadKey }: { file: DiffFile; taskId: string; reloadKey: string }) {
  const kind = !file.isDeleted ? previewKind(file.path) : undefined;
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const [mode, setMode] = useState<"preview" | "diff">(kind ? "preview" : "diff");
  const lines = all ? file.lines : file.lines.slice(0, 1500);
  const fallbackContent = useMemo(() => (kind ? diffPreviewContent(file) : undefined), [kind, file]);
  return (
    <div className="rounded-md border border-line" data-testid="diff-file" data-path={file.path}>
      <div className="flex w-full items-center gap-1.5 border-b border-line bg-raised px-2 py-1 text-xs">
        <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          <span className="truncate font-mono">{file.path}</span>
        </button>
        {kind && (
          <div className="inline-flex shrink-0 rounded border border-line bg-canvas p-0.5 text-[11px]" data-testid="diff-file-mode">
            <button
              type="button"
              data-testid="diff-mode-preview"
              aria-pressed={open && mode === "preview"}
              onClick={() => {
                setMode("preview");
                setOpen(true);
              }}
              className={`rounded px-1.5 py-px ${open && mode === "preview" ? "bg-accent text-white" : "text-muted hover:text-fg"}`}
            >
              Preview
            </button>
            <button
              type="button"
              data-testid="diff-mode-diff"
              aria-pressed={open && mode === "diff"}
              onClick={() => {
                setMode("diff");
                setOpen(true);
              }}
              className={`rounded px-1.5 py-px ${open && mode === "diff" ? "bg-accent text-white" : "text-muted hover:text-fg"}`}
            >
              Diff
            </button>
          </div>
        )}
        <span className="shrink-0 text-ok">+{file.additions}</span>
        <span className="shrink-0 text-bad">−{file.deletions}</span>
      </div>
      {open &&
        (kind && mode === "preview" ? (
          <div className="p-2">
            <FilePreview
              path={file.path}
              kind={kind}
              fallbackContent={fallbackContent}
              taskId={taskId}
              loadFromWorktree={!file.isNew}
              reloadKey={reloadKey}
            />
          </div>
        ) : (
          <pre className="overflow-x-auto font-mono text-[11px] leading-[1.45]">
            {lines.map((line, i) => (
              <div
                key={i}
                className={`whitespace-pre px-2 ${line.startsWith("+") ? "bg-ok/10 text-ok" : line.startsWith("-") ? "bg-bad/10 text-bad" : line.startsWith("@@") ? "bg-accent/10 text-accent" : "text-muted"}`}
              >
                {line || " "}
              </div>
            ))}
            {!all && file.lines.length > lines.length && (
              <button onClick={() => setAll(true)} className="px-2 py-1 text-accent hover:underline">
                Show {file.lines.length - lines.length} more lines
              </button>
            )}
          </pre>
        ))}
    </div>
  );
}

function Diff({ task }: { task: Task }) {
  const [diff, setDiff] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Only the newest request's answer is shown (an older one can arrive last).
  const latest = useRef(0);
  const load = async () => {
    const request = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const result = await window.aria.getTaskDiff(task.id);
      if (request === latest.current) setDiff(result);
    } catch (e) {
      if (request === latest.current) setError(errorText(e));
    } finally {
      if (request === latest.current) setLoading(false);
    }
  };
  // Reload when the task changes state (e.g. it finished) or commits.
  useEffect(() => {
    void load();
    // `load` is new every render, and reads the task's id as of then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, task.state, task.commits]);
  const files = useMemo(() => (diff ? parseDiff(diff.text) : []), [diff]);
  return (
    <div className="flex-1 overflow-y-auto p-3" data-testid="diff">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted">
        <span>
          {files.length} file{files.length === 1 ? "" : "s"} changed since {task.baseBranch ?? "the base"}
          {diff?.truncated ? " (cut off at 1 MB: open it in VS Code to see everything)" : ""}
        </span>
        <button onClick={() => void load()} className="ml-auto inline-flex items-center gap-1 hover:text-fg" title="Refresh">
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>
      {error && <div className="text-xs text-bad">{error}</div>}
      {diff && files.length === 0 && (
        <div className="whitespace-pre-wrap text-xs text-muted">
          {task.where === "cloud" ? diff.text || "Changes for cloud tasks live on Mission Control." : "No changes yet."}
        </div>
      )}
      <div className="space-y-2">
        {files.map((file) => (
          <DiffFileView key={file.path} file={file} taskId={task.id} reloadKey={`${task.state}-${task.commits ?? 0}-${task.updatedAt}`} />
        ))}
      </div>
    </div>
  );
}

function ModelSwitcher({ task }: { task: Task }) {
  const models = useAria((s) => s.models);
  const agents = useAria(selectAgents);
  const setTaskModel = useAria((s) => s.setTaskModel);
  const setTaskAgent = useAria((s) => s.setTaskAgent);
  const [model, setModel] = useState(task.model);
  const [effort, setEffort] = useState(task.reasoningEffort ?? "");
  const [agent, setAgent] = useState(task.agent ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setModel(task.model);
    setEffort(task.reasoningEffort ?? "");
  }, [task.model, task.reasoningEffort]);
  useEffect(() => {
    setAgent(task.agent ?? "");
  }, [task.agent]);
  const selected = models.find((m) => m.id === model);
  useEffect(() => {
    if (!selected) return;
    if (selected.efforts.length === 0) setEffort("");
    else if (!selected.efforts.includes(effort)) setEffort(selected.efforts.find((e) => e !== "none") ?? selected.efforts[0]!);
  }, [selected, effort]);
  const modelChanged = model !== task.model || effort !== (task.reasoningEffort ?? "");
  const agentChanged = agent !== (task.agent ?? "");
  const changed = modelChanged || agentChanged;
  const select = "rounded border border-line bg-canvas px-1.5 py-0.5 text-xs outline-none focus:border-accent";
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
      <span title={task.profileNote}>Profile {task.profileName}</span>
      {task.agent && (
        <span
          data-testid="session-agent-badge"
          className="rounded border border-line bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-fg"
          title={`Agent: ${task.agent}`}
        >
          {task.agent}
        </span>
      )}
      <select
        aria-label="Agent"
        data-testid="task-agent"
        disabled={Boolean(task.cleanedUp)}
        className={`${select} max-w-[16rem] truncate disabled:opacity-50`}
        value={agent}
        onChange={(e) => setAgent(e.target.value)}
      >
        <AgentSelectOptions agents={agents} currentAgent={agent} />
      </select>
      <select aria-label="Model" data-testid="task-model" className={select} value={model} onChange={(e) => setModel(e.target.value)}>
        {!models.some((m) => m.id === task.model) && <option value={task.model}>{task.model}</option>}
        {models
          .filter((m) => m.enabled)
          .map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
      </select>
      {selected && selected.efforts.length > 0 && (
        <select aria-label="Reasoning effort" data-testid="task-effort" className={select} value={effort} onChange={(e) => setEffort(e.target.value)}>
          {selected.efforts.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      )}
      {changed && (
        <button
          data-testid="task-model-apply"
          disabled={busy}
          title={isActive(task) ? "Switch the running session now" : "Used when it continues"}
          onClick={async () => {
            setBusy(true);
            if (modelChanged) await setTaskModel(task.id, model, effort || undefined);
            if (agentChanged) await setTaskAgent(task.id, agent || null);
            setBusy(false);
          }}
          className="rounded bg-accent px-2 py-0.5 text-white disabled:opacity-50"
        >
          {busy ? "Switching…" : isActive(task) ? "Switch" : "Use when it continues"}
        </button>
      )}
    </div>
  );
}

/** The composer's words by the task's state: steer or queue while it works, queue while it waits, continue a finished one. */
const COMPOSER: Partial<Record<Task["state"], { placeholder: string; button: string }>> = {
  queued: { placeholder: "It gets this when it starts…", button: "Queue" },
  starting: { placeholder: "It gets this when it starts…", button: "Queue" },
  waiting_input: { placeholder: "Answer its question above first…", button: "Queue" },
  waiting_permission: { placeholder: "It gets this after you decide above…", button: "Queue" },
  waiting_plan: { placeholder: "It gets this after you review its plan above…", button: "Queue" },
  waiting_budget: { placeholder: "It gets this when you raise its budget…", button: "Queue" },
};

/** The draft lives in SessionFooter, so the budget bar's Continue can send it along with the raise. */
function SessionComposer({ task, text, setText }: { task: Task; text: string; setText: (update: (current: string) => string) => void }) {
  const messageTask = useAria((s) => s.messageTask);
  const composeFor = useAria((s) => s.composeFor);
  const composed = useAria((s) => s.composed);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const working = isActive(task) && task.state !== "starting";
  // Steering only reaches a turn that's moving; one waiting for you gets it after you decide.
  const canSteer = task.state === "running";
  // A question has to be answered first: a message wouldn't reach the worker while it waits for the answer.
  const blocked = Boolean(task.question);
  const copy = COMPOSER[task.state] ?? (working ? { placeholder: "Message this session…", button: "Queue" } : { placeholder: "Ask for more: the task continues in its worktree…", button: "Continue" });
  useEffect(() => {
    if (composeFor !== task.id) return;
    input.current?.focus();
    composed();
  }, [composeFor, task.id, composed]);
  const submit = async (steer: boolean) => {
    const value = text.trim();
    if (!value || blocked) return;
    setBusy(true);
    // Clears only what was sent, not something typed since.
    if (await messageTask(task.id, value, steer)) setText((current) => (current.trim() === value ? "" : current));
    setBusy(false);
  };
  const disabled = busy || blocked || !text.trim();
  return (
    <div className="border-t border-line p-2">
      <textarea
        ref={input}
        data-testid="session-composer"
        aria-label="Message this session"
        rows={2}
        value={text}
        disabled={blocked}
        onChange={(e) => {
          const value = e.target.value;
          setText(() => value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit(false);
          }
        }}
        placeholder={copy.placeholder}
        className="w-full resize-none rounded-md border border-line bg-canvas px-2 py-1.5 text-sm outline-none focus:border-accent disabled:opacity-50"
      />
      <div className="mt-1 flex justify-end gap-1.5 text-xs">
        {canSteer && (
          <button data-testid="session-steer" disabled={disabled} onClick={() => void submit(true)} className="rounded border border-line px-2 py-1 text-muted hover:text-fg disabled:opacity-40" title="Deliver it into the current step right away">
            Steer now
          </button>
        )}
        <button
          data-testid={copy.button === "Continue" ? "session-continue" : "session-queue"}
          disabled={disabled}
          onClick={() => void submit(false)}
          className="rounded bg-accent px-2 py-1 text-white disabled:opacity-40"
          title={working ? "After the current step" : undefined}
        >
          {copy.button}
        </button>
      </div>
    </div>
  );
}

/** The worker's question, answerable right here as well as on its card in the chat (D17). */
function QuestionBar({ task, question }: { task: Task; question: PendingQuestion }) {
  return (
    <div className="border-t border-bad/50 bg-bad/5 px-3 py-2 text-sm" data-testid="session-question">
      <div className="flex items-start gap-1.5">
        <CircleQuestionMark className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bad" />
        <div className="min-w-0 flex-1 wrap-anywhere">
          <ShortId id={question.shortId} />
          <Markdown text={question.question} />
        </div>
      </div>
      <QuestionForm key={question.id} task={task} question={question} />
    </div>
  );
}

/** Its permission requests, decided right here as well as on their cards in the chat. */
function PermissionBar({ task, permissions }: { task: Task; permissions: PendingPermission[] }) {
  return (
    <div className="max-h-72 space-y-2 overflow-y-auto border-t border-bad/50 bg-bad/5 px-3 py-2 text-sm" data-testid="session-permissions">
      {permissions.map((p) => (
        <div key={p.id} data-testid="session-permission">
          <div className="flex items-start gap-1.5">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bad" />
            <span className="min-w-0">
              <ShortId id={p.shortId} />
              {/* All of it (a tool's whole arguments, D30), in a box of its own that scrolls. */}
              <span className="block max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs" data-testid="session-permission-what">
                {p.what}
              </span>
              <span className="block text-xs text-muted">{p.reason}</span>
            </span>
          </div>
          <PermissionActions task={task} pending={p} />
        </div>
      ))}
    </div>
  );
}

function PlanTab({ task, fallbackPlan }: { task: Task; fallbackPlan?: string | undefined }) {
  const [planFile, setPlanFile] = useState<{ content: string; truncated: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    if (!window.aria?.getTaskFile) return;
    setLoading(true);
    try {
      const res = await window.aria.getTaskFile(task.id, "plan.md");
      if (res) setPlanFile({ content: res.content, truncated: res.truncated });
    } catch {
      // ignore if plan.md is not on disk yet
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // `load` is new every render, and reads the task's id as of then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, task.state, task.updatedAt, task.plan?.id, task.planText]);
  const content = task.plan
    ? (task.plan.plan ?? task.plan.summary)
    : (task.planText ?? planFile?.content ?? fallbackPlan);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="session-plan-tab">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted">
        <span>
          {task.plan ? `Waiting for your review (${task.plan.shortId})` : "Implementation plan"}
        </span>
        <button onClick={() => void load()} className="ml-auto inline-flex items-center gap-1 hover:text-fg" title="Refresh">
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>
      {content ? (
        <div className="rounded-md border border-line bg-panel/60 p-4 text-sm" data-testid="session-plan-markdown">
          <Markdown text={content} />
        </div>
      ) : (
        <div className="text-xs text-muted" data-testid="session-plan-empty">
          {isActive(task) ? "The task hasn't written plan.md yet." : "No plan was saved for this session."}
        </div>
      )}
    </div>
  );
}

function PlanBar({ task, plan, savedDraft }: { task: Task; plan: PendingPlan; savedDraft?: string }) {
  const tab = useAria((s) => s.sessionTab);
  const setTab = useAria((s) => s.setSessionTab);
  const fullPlanText = (plan.plan ?? "").trim();
  const summaryText = plan.summary.trim();
  const hasDistinctSummary = Boolean(fullPlanText && summaryText && summaryText !== fullPlanText);
  return (
    <div className="flex max-h-[45vh] shrink-0 flex-col border-t border-bad/50 bg-bad/5 px-3 py-2 text-sm" data-testid="session-plan">
      <div className="flex shrink-0 items-center gap-1.5">
        <ClipboardList className="h-3.5 w-3.5 shrink-0 text-bad" />
        <span className="min-w-0 flex-1 font-medium text-fg">
          <ShortId id={plan.shortId} />
          Review plan to continue
        </span>
        {tab !== "plan" && (
          <button
            type="button"
            data-testid="session-plan-open"
            onClick={() => setTab("plan")}
            className="shrink-0 rounded border border-line bg-canvas px-2 py-0.5 text-xs text-accent hover:border-accent hover:text-fg"
          >
            Open plan
          </button>
        )}
      </div>
      {tab === "plan" ? (
        hasDistinctSummary && (
          <details className="mt-1.5 min-h-0 overflow-y-auto" data-testid="session-plan-summary">
            <summary className="cursor-pointer text-xs text-muted hover:text-fg">Agent's summary of this plan</summary>
            <div className="mt-1 max-h-24 overflow-y-auto rounded border border-line bg-canvas px-2.5 py-1.5 text-xs">
              <Markdown text={plan.summary} />
            </div>
          </details>
        )
      ) : (
        <div className="mt-1.5 min-h-0 flex-1 space-y-1.5 overflow-y-auto">
          {summaryText && (
            <div className="rounded border border-line bg-canvas px-2.5 py-1.5 text-xs" data-testid="session-plan-summary">
              <Markdown text={plan.summary} />
            </div>
          )}
          {plan.plan && (
            <details open>
              <summary className="cursor-pointer text-xs text-muted">The plan</summary>
              <div className="mt-1 max-h-40 overflow-y-auto rounded bg-canvas px-2 py-1" data-testid="session-plan-preview">
                <Markdown text={plan.plan} />
              </div>
            </details>
          )}
        </div>
      )}
      {savedDraft && (
        <div className="mt-1 shrink-0 truncate text-xs text-muted" data-testid="session-saved-draft-note">
          Unsent message draft saved for after plan review: “{savedDraft}”
        </div>
      )}
      <div className="shrink-0">
        <PlanActions key={plan.id} task={task} plan={plan} />
      </div>
    </div>
  );
}

function BudgetBar({ task, draft, sent }: { task: Task; draft: string; sent: (text: string) => void }) {
  const continueBudget = useAria((s) => s.continueBudget);
  const messageTask = useAria((s) => s.messageTask);
  const cancelTask = useAria((s) => s.cancelTask);
  const [busy, setBusy] = useState(false);
  const add = Math.max(1, task.budgetCredits ?? 0);
  const text = draft.trim();
  const resume = async () => {
    setBusy(true);
    // What you typed goes with it: it waits in the task's outbox and follows the note about the raise.
    if (text) {
      if (!(await messageTask(task.id, text, false))) {
        setBusy(false);
        return;
      }
      sent(text);
    }
    await continueBudget(task.id, add);
    setBusy(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-warn/50 bg-warn/5 px-3 py-2 text-xs" data-testid="session-budget">
      <CirclePause className="h-3.5 w-3.5 shrink-0 text-warn" />
      <span className="min-w-0 flex-1 text-muted">
        It used {credits(task.costCredits)} of its {credits(task.budgetCredits ?? 0)} and is paused.
      </span>
      <button disabled={busy} onClick={() => void cancelTask(task.id)} className="rounded border border-line px-2 py-1 text-muted hover:text-fg disabled:opacity-40">
        Stop
      </button>
      <button data-testid="session-budget-continue" disabled={busy} onClick={() => void resume()} className="rounded bg-accent px-2 py-1 text-white disabled:opacity-40">
        {text ? "Send and continue" : "Continue"} (+{credits(add)})
      </button>
    </div>
  );
}

const sessionDrafts = new Map<string, string>();

function SessionFooter({ task }: { task: Task }) {
  const [draft, setDraftState] = useState(() => sessionDrafts.get(task.id) ?? "");
  const setDraft = (update: (current: string) => string) => {
    setDraftState((current) => {
      const next = update(current);
      if (next) sessionDrafts.set(task.id, next);
      else sessionDrafts.delete(task.id);
      return next;
    });
  };
  const timeline = useAria((s) => s.timeline);
  const prCard = useMemo(() => {
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i]!;
      if (
        item.kind === "card" &&
        item.cardType === "pr_confirm" &&
        item.payload.taskId === task.id &&
        (item.payload.status === "pending" ||
          item.payload.status === "pushing" ||
          item.payload.status === "opening" ||
          item.payload.status === "failed")
      ) {
        return item;
      }
    }
    return undefined;
  }, [timeline, task.id]);
  if (task.cleanedUp) {
    return (
      <div className="border-t border-line px-3 py-2 text-xs text-muted" data-testid="session-cleaned-up">
        Its worktree was cleaned up, so it can't continue.{task.branch ? ` Its commits are on ${task.branch}.` : ""}
      </div>
    );
  }
  return (
    <>
      {prCard && (
        <div className="max-h-96 overflow-y-auto border-t border-accent/50 bg-accent/5 p-2" data-testid="session-pr-confirm">
          <PrConfirmCard card={prCard} />
        </div>
      )}
      {task.plan && <PlanBar task={task} plan={task.plan} savedDraft={draft.trim() || undefined} />}
      {task.permissions && task.permissions.length > 0 && <PermissionBar task={task} permissions={task.permissions} />}
      {task.question && <QuestionBar task={task} question={task.question} />}
      {task.state === "waiting_budget" && <BudgetBar task={task} draft={draft} sent={(text) => setDraft((current) => (current.trim() === text ? "" : current))} />}
      {!task.plan && <SessionComposer task={task} text={draft} setText={setDraft} />}
    </>
  );
}

/** Whether its session runs in the runtime's sandbox (D20), and what you approved for the rest of the task (D21). */
function SafetyLine({ task }: { task: Task }) {
  const revokeGrant = useAria((s) => s.revokeGrant);
  if (task.sandboxed === undefined && !task.grants?.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted" data-testid="session-safety">
      {task.sandboxed === true && (
        <span className="inline-flex items-center gap-1 text-ok" data-testid="session-sandboxed" title="It can only change its worktree, and only reach package registries">
          <ShieldCheck className="h-3 w-3" /> Sandboxed
        </span>
      )}
      {task.sandboxed === false && (
        <span className="inline-flex items-center gap-1 text-warn" data-testid="session-not-sandboxed" title="This PC can't run the sandbox, or it's turned off in Customize › Permissions: commands outside the safe list ask you first">
          <ShieldOff className="h-3 w-3" /> Not sandboxed
        </span>
      )}
      {task.grants?.map((g) => (
        <span key={g.id} className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-px" data-testid="session-grant">
          Approved for this task: <span className="font-mono">{g.label}</span>
          <button aria-label={`Ask again for ${g.label}`} title="Ask again next time" onClick={() => void revokeGrant(task.id, g.id)} className="hover:text-fg">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

/** Displays and lets you link, change, or clear the task's tracker task ID (Phase 5B, PLAN.md §4.14). */
function TrackerTaskBadge({ task }: { task: Task }) {
  const setTaskTracker = useAria((s) => s.setTaskTracker);
  const tracker = useTracker();
  const hasTracker = useHasTracker();
  const label = trackerLabel(tracker);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.trackerTaskId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (val: string | null) => {
    setBusy(true);
    setError(null);
    const err = await setTaskTracker(task.id, val);
    setBusy(false);
    if (err) {
      setError(err);
    } else {
      setEditing(false);
    }
  };

  // With no task tracker a session has nothing to be linked to.
  if (!hasTracker) return null;
  if (editing) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1" data-testid="session-tracker-form">
        <input
          data-testid="session-tracker-input"
          aria-label={`${label} task ID or URL`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save(draft.trim() || null);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
              setError(null);
            }
          }}
          placeholder="Task ID or URL"
          className="w-44 rounded border border-line bg-canvas px-1.5 py-0.5 font-mono text-xs text-fg outline-none focus:border-accent"
        />
        <button
          type="button"
          data-testid="session-tracker-save"
          disabled={busy}
          onClick={() => void save(draft.trim() || null)}
          className="rounded bg-accent px-1.5 py-0.5 text-xs text-white disabled:opacity-40"
        >
          Save
        </button>
        {task.trackerTaskId && (
          <button
            type="button"
            data-testid="session-tracker-unlink"
            disabled={busy}
            onClick={() => void save(null)}
            className="rounded border border-line px-1.5 py-0.5 text-xs text-muted hover:text-fg disabled:opacity-40"
          >
            Unlink
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setError(null);
          }}
          className="px-1 text-xs text-muted hover:text-fg"
        >
          Cancel
        </button>
        {error && (
          <span className="text-xs text-bad" data-testid="session-tracker-error">
            {error}
          </span>
        )}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1" data-testid="session-tracker">
      {task.trackerTaskId ? (
        <>
          {ownsTask(tracker, task.trackerId) ? (
            <button
              type="button"
              data-testid="session-tracker-link"
              onClick={() => openTrackerTask(tracker, task.trackerTaskId!)}
              className="rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-accent hover:underline"
              title={`Open ${label} task ${task.trackerTaskId}`}
            >
              {trackerRef(tracker, task.trackerTaskId)}
            </button>
          ) : (
            // A task of another tracker: no link from this tracker's template.
            <span
              data-testid="session-tracker-plain"
              className="rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-muted"
              title="This task is of another task tracker, so it has no link here"
            >
              #{task.trackerTaskId}
            </span>
          )}
          <button
            type="button"
            data-testid="session-tracker-edit"
            onClick={() => {
              setDraft(task.trackerTaskId ?? "");
              setError(null);
              setEditing(true);
            }}
            className="text-[11px] text-muted hover:text-fg"
          >
            Change
          </button>
        </>
      ) : (
        <button
          type="button"
          data-testid="session-tracker-edit"
          onClick={() => {
            setDraft("");
            setError(null);
            setEditing(true);
          }}
          className="rounded border border-line px-1.5 py-0.5 text-[11px] text-muted hover:text-fg"
          title={`Link this session to a ${label} task for time registration`}
        >
          + Link {label} task
        </button>
      )}
    </span>
  );
}

/** Resolves the full family of sibling runs (original + all reruns) in chronological order (D67). */
function getRunFamily(taskId: string, allTasks: readonly Task[]): Task[] {
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  const rootOf = (id: string): string => {
    let cur = id;
    const seen = new Set<string>();
    while (byId.get(cur)?.rerunOf && !seen.has(cur)) {
      seen.add(cur);
      cur = byId.get(cur)!.rerunOf!;
    }
    return cur;
  };
  const targetRoot = rootOf(taskId);
  return allTasks
    .filter((t) => rootOf(t.id) === targetRoot)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function SessionView() {
  const openTaskId = useAria((s) => s.openTaskId);
  const allTasks = useAria((s) => s.tasks);
  const task = allTasks.find((t) => t.id === openTaskId);
  const tab = useAria((s) => s.sessionTab);
  const full = useAria((s) => s.sessionFull);
  const setTab = useAria((s) => s.setSessionTab);
  const setFull = useAria((s) => s.setSessionFull);
  const openTask = useAria((s) => s.openTask);
  const openRerunTask = useAria((s) => s.openRerunTask);
  const closeTask = useAria((s) => s.closeTask);
  const cancelTask = useAria((s) => s.cancelTask);
  const discardTask = useAria((s) => s.discardTask);
  const openInEditor = useAria((s) => s.openInEditor);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const actionError = useAria((s) => s.actionError);
  const timeline = useAria((s) => s.timeline);
  // Whether one of its steps, loaded or not, wrote plan.md: a yes/no, so a new step doesn't draw this again.
  const wrotePlan = useAria((s) => (openTaskId ? s.transcripts[openTaskId]?.plan === true : false));
  const now = useNow(task ? isActive(task) : false);
  const taskId = task?.id;
  const runFamily = useMemo(() => (taskId ? getRunFamily(taskId, allTasks) : []), [taskId, allTasks]);
  useEffect(() => {
    setConfirmDiscard(false);
    setDiscarding(false);
  }, [taskId]);
  const latestPlanCard = useMemo(() => {
    if (!taskId) return undefined;
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i]!;
      if (item.kind === "card" && item.cardType === "task_plan" && item.payload.taskId === taskId) {
        return item;
      }
    }
    return undefined;
  }, [timeline, taskId]);
  if (!openTaskId || !task) return null;
  const hasPlan =
    task.mode === "plan" ||
    Boolean(task.plan) ||
    Boolean(task.planText) ||
    Boolean(latestPlanCard) ||
    wrotePlan;
  const time = elapsed(task, now);
  const tabButton = (value: typeof tab, label: string, testId: string) => (
    <button data-testid={testId} onClick={() => setTab(value)} className={`border-b-2 px-2 py-1.5 text-xs ${tab === value ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"}`}>
      {label}
    </button>
  );
  return (
    <div className="flex h-full flex-col bg-canvas" data-testid="session-view" data-task-id={task.id}>
      <header className="space-y-1.5 border-b border-line px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate font-semibold" data-testid="session-title">
            {task.title} <span className="font-normal text-muted">· {task.repoName}</span>
          </div>
          <StateChip state={task.state} />
          <button aria-label={full ? "Show the chat" : "Full width"} title={full ? "Show the chat" : "Full width"} onClick={() => setFull(!full)} className="rounded p-1 text-muted hover:bg-raised hover:text-fg">
            {full ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          <button data-testid="session-close" aria-label="Close the session view" title="Close (Esc)" onClick={closeTask} className="rounded p-1 text-muted hover:bg-raised hover:text-fg">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <ModelSwitcher key={task.id} task={task} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          {task.where === "cloud" && (
            <span
              data-testid="session-view-cloud-badge"
              className="inline-flex items-center gap-1 rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-accent"
              title="Runs in the cloud on GitHub Mission Control"
            >
              <Cloud className="h-3 w-3" /> Cloud
              {task.cloudRepo ? ` · ${task.cloudRepo.owner}/${task.cloudRepo.name}` : ""}
            </span>
          )}
          {task.where !== "cloud" && task.remote && (
            <span
              data-testid="session-view-remote-badge"
              className="inline-flex items-center gap-1 rounded bg-raised px-1.5 py-0.5 text-[11px] font-medium text-muted"
              title="Shared to GitHub web & mobile via Mission Control"
            >
              Remote
            </span>
          )}
          <span>{task.mode === "plan" ? "plan first" : task.mode}</span>
          {task.branch && (
            <span className="inline-flex items-center gap-1">
              <GitBranch className="h-3 w-3" />
              {task.branch}
            </span>
          )}
          {task.files && task.files.length > 0 && (
            <span
              className="inline-flex items-center gap-1 text-muted"
              title={`Context files:\n${task.files.join("\n")}`}
              data-testid="session-files-badge"
            >
              <Paperclip className="h-3 w-3" />
              {task.files.length} {task.files.length === 1 ? "file" : "files"}
            </span>
          )}
          <TrackerTaskBadge key={task.id} task={task} />
          {time && <span>{time}</span>}
          <span>{credits(task.costCredits)}{task.budgetCredits ? ` of ${credits(task.budgetCredits)}` : ""}</span>
          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            {(task.where === "cloud" || task.remote) && task.missionControlUrl && (
              <button
                type="button"
                data-testid="session-view-mission-control"
                onClick={() => openPage(task.missionControlUrl!)}
                title="Open session on GitHub Mission Control"
                className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-accent hover:border-accent hover:text-fg"
              >
                <ExternalLink className="h-3 w-3" /> Mission Control
              </button>
            )}
            <TaskPrLink task={task} testId="session-pr-link" />
            {task.where !== "cloud" && task.kind !== "chat" && task.kind !== "folder" && <OpenPrButton task={task} testId="session-open-pr" />}
            {(task.state === "done" || task.state === "failed" || task.state === "cancelled" || task.state === "interrupted") && (
              <button
                type="button"
                data-testid="session-rerun"
                onClick={() => openRerunTask(task.id)}
                title="Rerun this task's brief in a fresh worktree with another profile or prompt"
                className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 hover:border-accent hover:text-fg"
              >
                <RefreshCw className="h-3 w-3" /> Rerun with…
              </button>
            )}
            {(task.state === "done" || task.state === "failed" || task.state === "cancelled" || task.state === "interrupted") && (
              !confirmDiscard ? (
                <button
                  type="button"
                  data-testid="session-discard"
                  onClick={() => setConfirmDiscard(true)}
                  title="Discard and delete this session"
                  className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-muted hover:border-bad/60 hover:text-bad"
                >
                  <Trash2 className="h-3 w-3" /> Discard
                </button>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <button
                    type="button"
                    data-testid="session-discard-confirm"
                    disabled={discarding}
                    onClick={async () => {
                      setDiscarding(true);
                      if (!(await discardTask(task.id))) setDiscarding(false);
                    }}
                    className="inline-flex items-center gap-1 rounded border border-bad/50 bg-bad/10 px-1.5 py-0.5 text-bad hover:bg-bad/20"
                  >
                    <Trash2 className="h-3 w-3" /> {discarding ? "Deleting…" : "Confirm delete"}
                  </button>
                  {!discarding && (
                    <button
                      type="button"
                      data-testid="session-discard-cancel"
                      onClick={() => setConfirmDiscard(false)}
                      className="rounded border border-line px-1.5 py-0.5 hover:text-fg"
                    >
                      Keep
                    </button>
                  )}
                </span>
              )
            )}
            {task.worktreePath && (
              <button data-testid="session-editor" onClick={() => void openInEditor(task.id)} className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 hover:text-fg" title={task.worktreePath}>
                <Code className="h-3 w-3" /> Open in VS Code
              </button>
            )}
            {(isActive(task) || task.state === "queued") && (
              <button data-testid="session-stop" onClick={() => void cancelTask(task.id)} className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 hover:text-fg">
                <Square className="h-3 w-3" /> Stop
              </button>
            )}
          </span>
        </div>
        {runFamily.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-xs" data-testid="session-reruns">
            <span className="text-[11px] font-medium text-muted">Compare runs:</span>
            {runFamily.map((r, idx) => {
              const active = r.id === task.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  data-testid="session-rerun-switch"
                  data-task-id={r.id}
                  aria-current={active ? "true" : undefined}
                  onClick={() => openTask(r.id, tab)}
                  className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] ${
                    active ? "border-accent bg-accent/15 text-fg" : "border-line bg-panel text-muted hover:border-accent/60 hover:text-fg"
                  }`}
                >
                  <StateIcon state={r.state} />
                  <span className="font-medium">#{idx + 1} · {r.profileName}</span>
                  <span className="text-muted">({r.model}{r.reasoningEffort ? ` · ${r.reasoningEffort}` : ""})</span>
                  {r.commits !== undefined && r.commits > 0 && (
                    <span className="font-mono">
                      <span className="text-ok">+{r.additions ?? 0}</span> <span className="text-bad">−{r.deletions ?? 0}</span>
                    </span>
                  )}
                  <span className="text-muted">{credits(r.costCredits)}</span>
                </button>
              );
            })}
          </div>
        )}
        <SafetyLine task={task} />
        {task.error && <div className="text-xs text-bad">{task.error}</div>}
      </header>
      <div className="flex gap-1 border-b border-line px-2">
        {tabButton("transcript", "Transcript", "session-tab-transcript")}
        {(hasPlan || tab === "plan") && tabButton("plan", "Plan", "session-tab-plan")}
        {task.kind !== "chat" && task.kind !== "folder" && tabButton("diff", "Diff", "session-tab-diff")}
      </div>
      {/* Keyed by task: switching tasks starts their state (a draft, a diff on its way) afresh. */}
      {tab === "transcript" ? (
        <Transcript key={`transcript-${task.id}`} task={task} />
      ) : tab === "plan" ? (
        <PlanTab key={`plan-${task.id}`} task={task} fallbackPlan={latestPlanCard?.payload.plan} />
      ) : (
        <Diff key={`diff-${task.id}`} task={task} />
      )}
      {actionError && <div className="px-3 pb-1 text-xs text-bad">{actionError}</div>}
      <SessionFooter key={`footer-${task.id}`} task={task} />
    </div>
  );
}
