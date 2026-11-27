import type { TrackerChangePreview, TrackerImportResult, TrackerSetup } from "@aria/protocol";
import { FolderOpen, TriangleAlert, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAria } from "../store";
import { activeText, configsFor, errorLines, missingRequired, PART_NAMES, partState, purgeText, serverParts, startConfig, choiceFor } from "../trackerSetup";

const button = "inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-fg disabled:opacity-40";
const field = "rounded-md border border-line bg-canvas px-2 py-1 text-xs outline-none focus:border-accent";

/** What an import left: the config's name and file, what ARIA calls on its own, and a word about trusting the file. */
export function ImportResult({ result }: { result: TrackerImportResult }) {
  if (result.status === "canceled") return null;
  if (result.status === "invalid") {
    return (
      <div className="space-y-0.5 text-xs text-bad" data-testid="tracker-import-result" data-status="invalid">
        <div>That file wasn't imported: it isn't a task tracker config ARIA can use.</div>
        {result.errors.map((line) => (
          <div key={line} className="whitespace-pre-wrap font-mono text-[11px]">
            {line}
          </div>
        ))}
      </div>
    );
  }
  if (result.status === "failed") {
    return (
      <div className="text-xs text-bad" data-testid="tracker-import-result" data-status="failed">
        {result.error}
      </div>
    );
  }
  return (
    <div className="space-y-1 text-xs" data-testid="tracker-import-result" data-status="imported">
      <div className="text-ok">
        Imported {result.label} as <span className="font-mono">{result.file}</span> ({result.hash}){result.replaced ? ", in place of the file that was there" : ""}.
        {result.note ? ` ${result.note}` : ""}
      </div>
      <Reaches reads={result.reads} reserved={result.reserved} />
      <div className="text-muted">A config is trusted like a plugin: its steps go into the Timekeeper's instructions, so import only files you trust.</div>
    </div>
  );
}

/** What a config's tools do: the reads ARIA makes without asking, and the writes only the Time view makes. */
function Reaches({ reads, reserved }: { reads: readonly string[]; reserved: readonly string[] }) {
  return (
    <>
      {reads.length > 0 && (
        <div className="text-muted" data-testid="tracker-reads">
          ARIA reads with these tools without asking: <span className="font-mono">{reads.join(", ")}</span>.
        </div>
      )}
      {reserved.length > 0 && (
        <div className="text-muted" data-testid="tracker-reserved">
          These writes are reserved for the Time view: <span className="font-mono">{reserved.join(", ")}</span>.
        </div>
      )}
    </>
  );
}

/** The Task tracker panel at the top of Customize › Integrations: the tracker in use, the configs in the trackers folder, Import and Open folder. */
export function TrackerPanel({
  setup,
  importing,
  result,
  onImport,
  onOpenFolder,
}: {
  setup: TrackerSetup | undefined;
  importing: boolean;
  result: TrackerImportResult | undefined;
  onImport: () => void;
  onOpenFolder: () => void;
}) {
  const active = setup?.active;
  return (
    <section className="space-y-2 rounded-lg border border-line bg-panel p-4" data-testid="tracker-panel">
      <div className="flex flex-wrap items-center gap-2">
        <div className="font-medium">Task tracker</div>
        <button data-testid="tracker-import" className={button} disabled={importing} title="Checks a config file and copies it into ARIA's trackers folder" onClick={onImport}>
          <Upload className="h-3 w-3" /> {importing ? "Importing…" : "Import config…"}
        </button>
        <button data-testid="tracker-open-folder" className={button} title="Opens ARIA's trackers folder" onClick={onOpenFolder}>
          <FolderOpen className="h-3 w-3" /> Open folder
        </button>
      </div>
      {setup && (
        <div className="text-sm" data-testid="tracker-active" data-tracker={active?.id ?? ""}>
          {activeText(active)}
        </div>
      )}
      {setup?.error && (
        <div className="space-y-0.5 text-xs text-bad" data-testid="tracker-error">
          {errorLines(setup.error).map((line) => (
            <div key={line} className="whitespace-pre-wrap">
              {line}
            </div>
          ))}
        </div>
      )}
      {result && <ImportResult result={result} />}
      {setup && setup.configs.length > 0 && (
        <ul className="space-y-1 border-t border-line/60 pt-2 text-xs" data-testid="tracker-configs">
          {setup.configs.map((config) => (
            <li key={config.file} data-testid="tracker-config" data-file={config.file} data-id={config.id}>
              {config.error === undefined ? (
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{config.label}</span>
                  <span className="font-mono text-muted">
                    {config.file} ({config.hash})
                  </span>
                  {active && !active.builtIn && active.id === config.id && <span className="text-ok">In use</span>}
                </div>
              ) : (
                <div className="space-y-0.5 text-bad">
                  <div className="font-mono">{config.file} can't be used:</div>
                  {errorLines(config.error).map((line) => (
                    <div key={line} className="whitespace-pre-wrap pl-3 text-[11px]">
                      {line}
                    </div>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {setup && setup.configs.length === 0 && (
        <div className="text-xs text-muted" data-testid="tracker-no-configs">
          No configs in ARIA's trackers folder yet. Import one, or put a file there by hand, then Refresh.
        </div>
      )}
    </section>
  );
}

/** The panel with its buttons wired to the engine. */
export function TrackerSection() {
  const setup = useAria((s) => s.integrations.tracker);
  const importTrackerConfig = useAria((s) => s.importTrackerConfig);
  const openTrackerFolder = useAria((s) => s.openTrackerFolder);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<TrackerImportResult | undefined>();
  const handleImport = async () => {
    setImporting(true);
    const res = await importTrackerConfig();
    setImporting(false);
    // Canceling the file dialog leaves what was shown before.
    if (res.status !== "canceled") setResult(res);
  };
  return <TrackerPanel setup={setup} importing={importing} result={result} onImport={() => void handleImport()} onOpenFolder={() => void openTrackerFolder()} />;
}

/** The choice in the "Use as task tracker" dialog: the config, what its tools reach on this server, and what ARIA would call. */
export function TrackerChoice({
  server,
  setup,
  configId,
  preview,
  checking,
  error,
  using,
  purge = "keep",
  onConfig,
  onPurge,
  onUse,
  onCancel,
}: {
  server: string;
  setup: TrackerSetup;
  configId: string | undefined;
  preview: TrackerChangePreview | undefined;
  checking: boolean;
  error: string | null;
  using: boolean;
  /** What to do with another tracker's data, when the preview asks: keep it (dormant) or clear it. */
  purge?: "keep" | "clear";
  onConfig: (id: string) => void;
  onPurge?: (answer: "keep" | "clear") => void;
  onUse: () => void;
  onCancel: () => void;
}) {
  const configs = configsFor(setup.configs, server);
  const parts = preview ? serverParts(preview.tools, server) : [];
  const missing = missingRequired(parts);
  const blocked = configId === undefined || checking || using || preview === undefined || preview.refusal !== undefined;
  return (
    <div className="w-[34rem] max-w-[92vw] space-y-3 rounded-lg border border-line bg-panel p-4 text-sm" data-testid="tracker-choice">
      <h2 id="tracker-dialog-heading" className="font-medium">
        Use {server} as task tracker
      </h2>
      {configs.length === 0 ? (
        <div className="text-xs text-muted" data-testid="tracker-dialog-no-configs">
          There is no config to pick yet. Import one with Import config…, or put a file in ARIA's trackers folder and Refresh.
        </div>
      ) : (
        <label className="block space-y-1 text-xs">
          <span className="text-muted">Config</span>
          <select data-testid="tracker-dialog-config" className={`${field} w-full`} value={configId ?? ""} onChange={(e) => onConfig(e.target.value)}>
            {configs.map((config) => (
              <option key={config.id} value={config.id}>
                {config.label} — {config.file} ({config.hash}){config.suggestedServers.includes(server) ? " — suggested" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {checking && (
        <div className="text-xs text-muted" data-testid="tracker-dialog-checking">
          Checking its tools on {server}…
        </div>
      )}
      {preview?.refusal && (
        <div className="flex items-start gap-1 text-xs text-bad" data-testid="tracker-dialog-refusal">
          <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
          {preview.refusal}
        </div>
      )}
      {preview && !preview.refusal && (
        <>
          <ul className="space-y-0.5 text-xs" data-testid="tracker-dialog-parts">
            {parts.map((part) => {
              const state = partState(part);
              return (
                <li key={part.part} className="flex flex-wrap items-baseline gap-x-2" data-testid="tracker-dialog-part" data-part={part.part} data-state={state}>
                  <span className="w-32 shrink-0">{PART_NAMES[part.part]}</span>
                  {state === "missing" ? (
                    <span className={part.required ? "text-warn" : "text-muted"}>
                      <span className="font-mono">{part.tools.join(" or ")}</span> isn't on this server{part.required ? " (needed)" : " (optional)"}
                    </span>
                  ) : (
                    <>
                      <span className="font-mono text-ok">{part.found}</span>
                      {state === "direct-only" && (
                        <span className="text-warn">reachable only with direct access: a saved token, a key in the address, or a local server</span>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          {missing.length > 0 && (
            <div className="flex items-start gap-1 text-xs text-warn" data-testid="tracker-dialog-missing">
              <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
              {server} doesn't have the tools for {missing.join(", ")}, so they won't work. You can still use it.
            </div>
          )}
          <div className="space-y-1 text-xs">
            <Reaches reads={preview.reads} reserved={preview.reserved} />
          </div>
          {preview.purge && (
            <fieldset className="space-y-1 rounded border border-line p-2 text-xs" data-testid="tracker-dialog-purge">
              <legend className="px-1 text-muted">Another tracker's data</legend>
              <div data-testid="tracker-dialog-purge-text">{purgeText(preview.purge)}</div>
              <label className="flex items-center gap-1.5">
                <input type="radio" name="tracker-purge" data-testid="tracker-dialog-purge-keep" checked={purge === "keep"} onChange={() => onPurge?.("keep")} />
                Keep them
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" name="tracker-purge" data-testid="tracker-dialog-purge-clear" checked={purge === "clear"} onChange={() => onPurge?.("clear")} />
                Clear them (ARIA copies its database first, and doesn't clear anything if it can't)
              </label>
            </fieldset>
          )}
        </>
      )}
      {error && (
        <div className="text-xs text-bad" data-testid="tracker-dialog-error">
          {error}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button data-testid="tracker-dialog-use" className={button} disabled={blocked} onClick={onUse}>
          {using ? "Using…" : "Use"}
        </button>
        <button data-testid="tracker-dialog-cancel" className={button} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The "Use as task tracker" dialog of a server card: pick a config, see its tools on the server, Use. */
export function UseAsTrackerDialog({ server, onClose }: { server: string; onClose: () => void }) {
  const setup = useAria((s) => s.integrations.tracker);
  const previewTrackerChange = useAria((s) => s.previewTrackerChange);
  const setActiveTracker = useAria((s) => s.setActiveTracker);
  const [configId, setConfigId] = useState<string | undefined>(() => (setup ? startConfig(setup, server) : undefined));
  const [preview, setPreview] = useState<TrackerChangePreview | undefined>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [using, setUsing] = useState(false);
  // The answer to the question about another tracker's data: keep it unless told to clear it.
  const [purge, setPurge] = useState<"keep" | "clear">("keep");
  const element = useRef<HTMLDialogElement>(null);
  const asked = useRef(0);

  // Modal, as the other dialogs: the rest of the window is inert and Escape cancels it.
  useEffect(() => {
    if (element.current && !element.current.open) element.current.showModal();
  }, []);

  // What the chosen config reaches on this server (and, for the same config, the servers already chosen), again when the choice changes.
  useEffect(() => {
    if (!setup || configId === undefined) return;
    const mine = ++asked.current;
    setChecking(true);
    setPreview(undefined);
    setPurge("keep");
    void previewTrackerChange(choiceFor(setup, configId, server)).then((res) => {
      if (asked.current !== mine) return;
      setChecking(false);
      if ("error" in res) setError(res.error);
      else setPreview(res);
    });
    // The setup changes with every event; the question is about the config and the server.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configId, server]);

  if (!setup) return null;
  const handleUse = async () => {
    if (configId === undefined) return;
    setUsing(true);
    setError(null);
    // Only a switch that asked about another tracker's data carries an answer.
    const res = await setActiveTracker({ ...choiceFor(setup, configId, server), ...(preview?.purge ? { purge: purge === "clear" } : {}) });
    setUsing(false);
    if (res.ok) onClose();
    else setError(res.error);
  };
  return (
    <dialog
      ref={element}
      data-testid="tracker-dialog"
      aria-labelledby="tracker-dialog-heading"
      className="m-auto max-h-[92vh] max-w-[92vw] overflow-auto border-0 bg-transparent p-0 text-fg backdrop:bg-black/50"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <TrackerChoice
        server={server}
        setup={setup}
        configId={configId}
        preview={preview}
        checking={checking}
        error={error}
        using={using}
        purge={purge}
        onPurge={setPurge}
        onConfig={(id) => {
          setError(null);
          setConfigId(id);
        }}
        onUse={() => void handleUse()}
        onCancel={onClose}
      />
    </dialog>
  );
}
