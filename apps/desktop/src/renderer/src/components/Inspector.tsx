import { CONDUCTOR_TRANSCRIPT_MAX_TURNS } from "@aria/protocol/transcript";
import { ChevronDown, ChevronRight, LoaderCircle, Maximize2, Minimize2, RefreshCw, ScanSearch, X } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { connectionNote, digestSummary, groupTurns, sameTurn, turnStatus, turnTime, type Turn } from "../inspector";
import { INSPECTOR_TURNS, useAria } from "../store";
import { Markdown } from "./Markdown";
import { CutNote, Entry, ToolEntry } from "./SessionView";
import { duration } from "./tasks";

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The `<updates>`/`<pending>` block that was sent in front of your words, collapsed to its counts. */
function DigestRow({ digest }: { digest: string }) {
  const [open, setOpen] = useState(false);
  const { updates, pending } = digestSummary(digest);
  const counts = [updates ? plural(updates, "update", "updates") : "", pending ? `${pending} waiting` : ""].filter(Boolean).join(" · ");
  return (
    <div className="text-xs" data-testid="inspector-digest">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-center gap-1 text-muted hover:text-fg" data-testid="inspector-digest-toggle">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Sent with it{counts ? `: ${counts}` : ""}
      </button>
      {open && (
        <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-canvas p-2 font-mono text-[11px] text-muted" data-testid="inspector-digest-text">
          {digest}
        </pre>
      )}
    </div>
  );
}

interface TurnProps {
  turn: Turn;
  /** When it started, as shown (today: the time; before: the day too). */
  when: string;
  working: boolean;
  tookMs: number | undefined;
  focusedEntryId?: string | undefined;
}

/** One turn. Live entries only change the newest turns, so the others skip rendering (and re-parsing their Markdown). */
const TurnView = memo(
  function TurnView({ turn, when, working, tookMs, focusedEntryId }: TurnProps) {
    const { message } = turn;
    return (
      <div className="space-y-1.5 rounded-md border border-line p-2.5" data-testid="inspector-turn">
        <div className="flex items-center gap-2 text-[11px] text-muted">
          <span className="font-medium text-fg/80">{message ? "You" : "Before your first message"}</span>
          {message && <span>{when}</span>}
          {tookMs !== undefined && <span data-testid="inspector-took">answered in {duration(tookMs)}</span>}
          {working && (
            <span className="inline-flex items-center gap-1 text-accent" data-testid="inspector-working">
              <LoaderCircle className="h-3 w-3 animate-spin" /> working…
            </span>
          )}
        </div>
        {message && (
          <div className="rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-sm" data-testid="inspector-message" data-entry-id={message.id}>
            <div className="whitespace-pre-wrap wrap-anywhere">{message.text}</div>
            <CutNote chars={message.textCut} what="message" />
          </div>
        )}
        {message?.digest && <DigestRow digest={message.digest} />}
        {turn.steps.map(({ entry, refused }) =>
          entry.kind === "assistant" ? (
            <div key={entry.id} className="px-1 text-sm" data-testid="inspector-answer" data-entry-id={entry.id}>
              <Markdown text={entry.text} />
              <CutNote chars={entry.textCut} what="answer" />
            </div>
          ) : entry.kind === "tool" ? (
            <div key={entry.id} data-entry-id={entry.id}>
              <ToolEntry entry={entry} refused={refused} focused={focusedEntryId === entry.id} />
            </div>
          ) : (
            <div key={entry.id} data-entry-id={entry.id}>
              <Entry entry={entry} first={false} focused={focusedEntryId === entry.id} />
            </div>
          ),
        )}
      </div>
    );
  },
  (a, b) => a.when === b.when && a.working === b.working && a.tookMs === b.tookMs && a.focusedEntryId === b.focusedEntryId && sameTurn(a.turn, b.turn),
);

/**
 * ARIA's inspector (PLAN.md §5.3): per message of yours, the `<updates>`/`<pending>` block sent with it, the tools
 * ARIA called with their arguments, results and time, and its answer. Read from ARIA's own session; read-only.
 */
export function Inspector() {
  const view = useAria((s) => s.inspector);
  const status = useAria((s) => s.status);
  const full = useAria((s) => s.sessionFull);
  const focus = useAria((s) => s.inspectorFocus);
  const transcriptFocus = useAria((s) => s.transcriptFocus);
  const setFull = useAria((s) => s.setSessionFull);
  const close = useAria((s) => s.closeTask);
  const load = useAria((s) => s.loadInspector);
  const showMore = useAria((s) => s.showMoreInspector);
  const turns = useMemo(() => groupTurns(view?.entries ?? []), [view?.entries]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const busy = status.state === "busy";
  const starting = status.state === "starting";
  const note = connectionNote(status.state, turns.length > 0);
  const canShowMore = Boolean(view && view.omitted > 0 && view.turns < CONDUCTOR_TRANSCRIPT_MAX_TURNS);
  // What had the focus when it opened (Inspect in the header or the sidebar): it gets it back when the inspector closes.
  const opener = useRef(document.activeElement);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current && (!transcriptFocus || transcriptFocus.taskId !== undefined)) el.scrollTop = el.scrollHeight;
  }, [turns, transcriptFocus]);

  useEffect(() => {
    if (!transcriptFocus || transcriptFocus.taskId !== undefined || view?.loading || !turns.length) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(transcriptFocus.entryId)}"]`);
    if (!el) return;
    stick.current = false;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.animate?.([{ outline: "2px solid rgb(47 129 247)" }, { outline: "2px solid transparent" }], { duration: 1600 });
  }, [turns, transcriptFocus, view?.loading]);

  // The focus comes here when it opens, and again on Inspect while it's open (nothing is read again then).
  useEffect(() => {
    scroller.current?.focus();
  }, [focus]);

  // Closed (Esc, ✕): the focus was in here and would fall back to the page; it goes back to where it came from instead.
  // Closed by opening something else (a task), the focus is already there and stays.
  useEffect(
    () => () => {
      const back = opener.current;
      const lost = document.activeElement === null || document.activeElement === document.body;
      if (lost && back instanceof HTMLElement && back.isConnected) back.focus();
    },
    [],
  );

  // Opened while ARIA wasn't ready (or reopening): it fills in once ARIA is.
  useEffect(() => {
    if (view?.error && !view.loading && (status.state === "ready" || busy)) void load({ reload: true });
    // Only when ARIA's status changes: the view changes with every read, which would read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.state]);

  return (
    <div className="flex h-full flex-col bg-canvas" data-testid="inspector">
      <header className="space-y-1 border-b border-line px-3 py-2">
        <div className="flex items-center gap-2">
          <ScanSearch className="h-4 w-4 shrink-0 text-muted" />
          <div className="min-w-0 flex-1 truncate font-semibold">
            ARIA <span className="font-normal text-muted">· what it was sent and did</span>
          </div>
          <button aria-label={full ? "Show the chat" : "Full width"} title={full ? "Show the chat" : "Full width"} onClick={() => setFull(!full)} className="rounded p-1 text-muted hover:bg-raised hover:text-fg">
            {full ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          <button data-testid="inspector-close" aria-label="Close the inspector" title="Close (Esc)" onClick={close} className="rounded p-1 text-muted hover:bg-raised hover:text-fg">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex flex-wrap gap-x-3 text-xs text-muted">
          {status.model && (
            <span>
              {status.model}
              {status.reasoningEffort ? ` · ${status.reasoningEffort}` : ""}
            </span>
          )}
          <span>Each message of yours as sent, with the tools ARIA called. Read-only: looking costs no credits.</span>
        </div>
      </header>
      <div
        ref={scroller}
        tabIndex={-1}
        aria-label="ARIA's messages and steps"
        data-testid="inspector-scroller"
        className="flex-1 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        <div className="space-y-2 p-3" data-testid="inspector-turns">
          {note && turns.length === 0 ? (
            // Opened while ARIA's conversation opens: it fills in by itself, so it's said quietly, with nothing to retry.
            <div className="flex items-center gap-1.5 text-xs text-muted" data-testid="inspector-opening">
              <LoaderCircle className="h-3 w-3 animate-spin" /> {note}
            </div>
          ) : (
            note && (
              <div className="text-xs text-warn" data-testid="inspector-reconnecting" data-state={status.state}>
                {note}
              </div>
            )
          )}
          {view && view.notKept > 0 && (
            <div className="text-xs text-muted" data-testid="inspector-not-kept">
              {plural(view.notKept, "older message of yours isn't", "older messages of yours aren't")} kept here (it keeps your last {CONDUCTOR_TRANSCRIPT_MAX_TURNS.toLocaleString()}).
            </div>
          )}
          {view && canShowMore && (
            <div className="flex items-center gap-2 text-xs text-muted">
              <span>{plural(view.omitted, "earlier message of yours isn't", "earlier messages of yours aren't")} shown.</span>
              <button data-testid="inspector-more" disabled={view.loading} onClick={() => void showMore()} className="text-accent hover:underline disabled:opacity-50">
                Show {Math.min(INSPECTOR_TURNS, view.omitted, CONDUCTOR_TRANSCRIPT_MAX_TURNS - view.turns)} more
              </button>
            </div>
          )}
          {/* While ARIA's conversation opens, a failed read is expected and read again once it's ready (above). */}
          {view?.error && !starting && (
            <div className="flex items-center gap-2 text-xs text-bad" data-testid="inspector-error">
              <span>{view.error}</span>
              <button onClick={() => void load({ reload: true })} className="inline-flex items-center gap-1 text-accent hover:underline">
                <RefreshCw className="h-3 w-3" /> Retry
              </button>
            </div>
          )}
          {view?.loading && !starting && turns.length === 0 && <div className="text-xs text-muted">Loading…</div>}
          {view && !view.loading && !view.error && !starting && turns.length === 0 && <div className="text-xs text-muted">Nothing yet: say something to ARIA and it shows up here.</div>}
          {turns.map((turn, i) => {
            const { working, tookMs } = turnStatus(turn, i === turns.length - 1, busy);
            const focusedEntryId = transcriptFocus?.taskId === undefined ? transcriptFocus?.entryId : undefined;
            return (
              <TurnView
                key={turn.message?.id ?? "before"}
                turn={turn}
                when={turn.message ? turnTime(turn.message.at) : ""}
                working={working}
                tookMs={tookMs}
                focusedEntryId={focusedEntryId}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
