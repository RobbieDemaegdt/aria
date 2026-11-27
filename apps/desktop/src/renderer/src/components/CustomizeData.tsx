import type { DataState, TranscriptRetention } from "@aria/protocol";
import { useEffect, useState } from "react";
import { useAria } from "../store";

const field = "w-20 rounded-md border border-line bg-canvas px-2 py-1 text-sm outline-none focus:border-accent";
const button = "rounded-md border border-line px-2.5 py-1 text-xs text-muted hover:border-accent hover:text-fg disabled:opacity-40";

/** "175 MB", "820 KB": sizes in the units Windows Explorer shows. */
export function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

const when = (at: number) => new Date(at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Whole days from 1 to 3650, as typed; undefined when it isn't one. */
export function parseKeepDays(text: string): number | undefined {
  if (!/^\s*\d{1,4}\s*$/.test(text)) return undefined;
  const days = Number(text);
  return days >= 1 && days <= 3650 ? days : undefined;
}

export interface DataPanelProps {
  state: DataState;
  /** A change to the setting is being saved. */
  saving: boolean;
  /** "Clean up now" was clicked and hasn't finished. */
  cleaning: boolean;
  /** Whether it was saved. */
  onRetention: (patch: Partial<TranscriptRetention>) => Promise<boolean>;
  onCleanUp: () => void;
}

/** Customize › Data's content, from its state: the database's size, how long transcripts are kept, and "Clean up now". */
export function DataPanel({ state, saving, cleaning, onRetention, onCleanUp }: DataPanelProps) {
  const { retention, lastCleanup, lastCompact } = state;
  const [days, setDays] = useState(String(retention.keepDays));
  useEffect(() => setDays(String(retention.keepDays)), [retention.keepDays]);
  const parsed = parseKeepDays(days);
  const saveDays = () => {
    if (parsed === undefined || parsed === retention.keepDays) return;
    const saved = retention.keepDays;
    // Not saved: the field shows what's kept again, not a number that isn't.
    void onRetention({ keepDays: parsed }).then((ok) => {
      if (!ok) setDays(String(saved));
    });
  };
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <section className="space-y-2 rounded-lg border border-line bg-panel p-4" data-testid="data-size">
        <div className="font-medium">Database</div>
        <div className="text-sm">
          <span data-testid="data-file-size">{sizeText(state.fileBytes)}</span>
          {state.freeBytes > 0 && <span className="text-muted">, of which {sizeText(state.freeBytes)} is free space SQLite reuses</span>}
        </div>
        {state.compactPending && (
          <div className="text-xs text-muted" data-testid="data-compact-pending">
            ARIA gives the free space back to the disk the next time it starts.
          </div>
        )}
        {lastCompact && (
          <div className={`text-xs ${lastCompact.error ? "text-warn" : "text-muted"}`} data-testid="data-last-compact">
            {lastCompact.error
              ? `Compacting it at the start on ${when(lastCompact.at)} didn't work: ${lastCompact.error}`
              : `Compacted at the start on ${when(lastCompact.at)}: ${sizeText(lastCompact.beforeBytes)} to ${sizeText(lastCompact.afterBytes)}, in ${(lastCompact.ms / 1000).toFixed(1)} s.`}
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-line bg-panel p-4" data-testid="data-retention">
        <div>
          <div className="font-medium">Task transcripts</div>
          <p className="text-xs text-muted">
            A finished task keeps everything it did for the days you set. After that, its tool calls, permission lines and reasoning are removed, and your messages, its replies, its questions and its
            notices stay, for the session view and Search. A task whose session and worktree are still there shows everything from its session.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" data-testid="data-retention-enabled" checked={retention.enabled} disabled={saving} onChange={(e) => void onRetention({ enabled: e.target.checked })} />
          Clean up once a day
        </label>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>Keep everything for</span>
          <input
            data-testid="data-keep-days"
            aria-label="Days to keep a finished task's whole transcript"
            aria-invalid={parsed === undefined}
            inputMode="numeric"
            className={field}
            value={days}
            disabled={saving}
            onChange={(e) => setDays(e.target.value)}
            onBlur={saveDays}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveDays();
            }}
          />
          <span>days after a task finished</span>
        </div>
        {parsed === undefined && (
          <div className="text-xs text-bad" data-testid="data-keep-days-error">
            Enter a whole number of days, from 1 to 3650.
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          {/* A clean-up already running (the daily one) doesn't disable it: clicking waits for it and shows what it did. */}
          <button data-testid="data-clean-up" className={button} disabled={cleaning} onClick={onCleanUp}>
            {cleaning ? "Cleaning up…" : "Clean up now"}
          </button>
          <span className="text-xs text-muted" data-testid="data-last-cleanup">
            {state.cleaning && !cleaning
              ? "A clean-up is running."
              : lastCleanup
              ? lastCleanup.steps > 0
                ? `Last clean-up ${when(lastCleanup.at)}: ${lastCleanup.steps.toLocaleString("en-GB")} steps from ${lastCleanup.tasks} task${lastCleanup.tasks === 1 ? "" : "s"}.`
                : `Last clean-up ${when(lastCleanup.at)}: nothing was old enough.`
              : "No clean-up yet."}
          </span>
        </div>
      </section>
    </div>
  );
}

/** Customize › Data (D1): read when the page opens, after each change, and every 2 s while a clean-up runs. */
export function CustomizeData() {
  const loadDataState = useAria((s) => s.loadDataState);
  const setTranscriptRetention = useAria((s) => s.setTranscriptRetention);
  const cleanUpTranscripts = useAria((s) => s.cleanUpTranscripts);
  const [state, setState] = useState<DataState | null>(null);
  const [saving, setSaving] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [polls, setPolls] = useState(0);
  useEffect(() => {
    let live = true;
    void loadDataState().then((next) => {
      if (live && next) setState(next);
    });
    return () => {
      live = false;
    };
  }, [loadDataState]);
  // While the daily clean-up runs, read again every 2 s, so the page shows what it did once it's done. Straight from the
  // main process: through the store, each read would clear an error another action is showing. One that fails tries again.
  useEffect(() => {
    if (!state?.cleaning) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      window.aria.getDataState().then(
        (next) => {
          if (live) setState(next);
        },
        () => {
          if (live) setPolls((n) => n + 1);
        },
      );
    }, 2_000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [state, polls]);
  const save = async (patch: Partial<TranscriptRetention>) => {
    setSaving(true);
    const next = await setTranscriptRetention(patch);
    setSaving(false);
    if (next) setState(next);
    return next !== null;
  };
  const cleanUp = async () => {
    setCleaning(true);
    const next = await cleanUpTranscripts();
    setCleaning(false);
    if (next) setState(next);
  };
  return (
    <div className="h-full overflow-y-auto" data-testid="customize-data-page">
      {state ? (
        <DataPanel state={state} saving={saving} cleaning={cleaning} onRetention={save} onCleanUp={() => void cleanUp()} />
      ) : (
        <div className="p-6 text-xs text-muted">Reading the database…</div>
      )}
    </div>
  );
}
