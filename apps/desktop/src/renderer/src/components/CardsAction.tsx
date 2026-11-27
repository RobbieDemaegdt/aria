// Calls ARIA proposes and you send: an MCP tool with its exact payload, and a GitHub workflow to dispatch.
import type { CardItem } from "@aria/protocol";
import { Check, ExternalLink, GitBranch, Workflow, ShieldAlert, Sparkles } from "lucide-react";
import { useState } from "react";
import { useAria } from "../store";
import { openPage } from "../openPage";
import { Button, Shell, ShortId, visibleJsonText } from "./CardParts";
import { Markdown } from "./Markdown";

/** Decodes any top-level `*Json` string fields (such as a `tasksJson` argument) for readable inspection on the card. */
function decodedJsonFields(argsJson: string): Array<{ key: string; formatted: string }> {
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const out: Array<{ key: string; formatted: string }> = [];
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (/json$/i.test(key) && typeof val === "string") {
        try {
          out.push({ key, formatted: visibleJsonText(JSON.stringify(JSON.parse(val), null, 2)) });
        } catch {
          // Invalid inner JSON is shown raw in the payload box.
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

const ACTION_CLASS_TONE: Record<"read" | "write" | "destructive" | "unrestricted", string> = {
  read: "text-ok",
  write: "text-warn",
  destructive: "text-bad",
  unrestricted: "text-bad",
};

const ACTION_STATUS_LABEL: Record<"pending" | "running" | "done" | "failed" | "cancelled", string> = {
  pending: "Needs your click",
  running: "Running…",
  done: "Sent",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * Action-request card (Phase 5A, PLAN.md §4.3, §4.13, §5.4, D19, D22): shows the exact MCP tool and payload ARIA
 * proposes. Nothing runs until you click Send; the short-lived session checks the exact payload before the call runs.
 */
export function ActionRequestCard({ card }: { card: Extract<CardItem, { cardType: "action_request" }> }) {
  const p = card.payload;
  const confirmAction = useAria((s) => s.confirmAction);
  const cancelAction = useAria((s) => s.cancelAction);
  const [editing, setEditing] = useState(false);
  const [draftJson, setDraftJson] = useState(p.argsJson);
  const [lastSyncedJson, setLastSyncedJson] = useState(p.argsJson);
  /** Binds the confirmation tick to the exact JSON text: editing the JSON automatically clears the tick. */
  const [tickedForJson, setTickedForJson] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (p.argsJson !== lastSyncedJson) {
    setLastSyncedJson(p.argsJson);
    if (!editing) setDraftJson(p.argsJson);
  }

  const activeJson = editing ? draftJson : p.argsJson;
  const ticked = tickedForJson === activeJson;
  const actionable = p.status === "pending" || p.status === "failed";
  const needsTick = p.cls === "destructive" || p.requiresConfirmTick === true;
  const decoded = decodedJsonFields(activeJson);
  const tone =
    p.status === "done"
      ? "border-ok/50"
      : p.status === "failed"
        ? "border-bad/50"
        : p.status === "cancelled"
          ? "border-line"
          : p.cls === "destructive"
            ? "border-bad/60"
            : "border-accent/60";

  const submit = async () => {
    if (busy || p.status === "running" || (needsTick && !ticked)) return;
    setBusy(true);
    setError(null);
    const failed = await confirmAction({
      cardId: card.id,
      revision: p.revision,
      ...(editing || draftJson !== p.argsJson ? { argsJson: draftJson } : {}),
      ...(needsTick ? { confirmedDestructive: ticked } : {}),
    });
    setBusy(false);
    if (failed) setError(failed);
    else setEditing(false);
  };

  const cancel = async () => {
    if (busy || p.status === "running") return;
    setBusy(true);
    setError(await cancelAction(card.id));
    setBusy(false);
  };

  return (
    <Shell
      testId="card-action-request"
      cardId={card.id}
      tone={tone}
      icon={
        p.status === "done" ? (
          <Check className="h-4 w-4 text-ok" />
        ) : p.cls === "destructive" ? (
          <ShieldAlert className="h-4 w-4 text-bad" />
        ) : (
          <Sparkles className="h-4 w-4 text-accent" />
        )
      }
      title={
        <span data-testid="action-title" data-status={p.status}>
          <ShortId id={p.shortId} />
          {p.title}{" "}
          <span className="font-normal text-muted" data-testid="action-tool">
            · {p.server} · {p.tool}
          </span>{" "}
          <span className={`font-mono text-xs font-normal ${ACTION_CLASS_TONE[p.cls]}`} data-testid="action-class">
            ({p.cls})
          </span>
        </span>
      }
      right={
        <span className="shrink-0 text-xs text-muted" data-testid="action-status">
          {ACTION_STATUS_LABEL[p.status]}
          {p.edited ? " · edited" : ""}
        </span>
      }
    >
      {p.note && (
        <div className="mt-1 wrap-anywhere text-xs text-muted" data-testid="action-note">
          <Markdown text={p.note} />
        </div>
      )}
      {decoded.map((item) => (
        <div key={item.key} className="mt-1.5" data-testid="action-json-preview">
          <div className="text-[11px] text-muted">{item.key} (decoded preview)</div>
          <pre className="mt-0.5 max-h-52 overflow-auto whitespace-pre-wrap rounded bg-canvas px-2 py-1 font-mono text-xs">{item.formatted}</pre>
        </div>
      ))}
      <div className="mt-1.5">
        <div className="text-[11px] text-muted">Exact payload sent to {p.wireName}</div>
        {editing && actionable ? (
          <textarea
            aria-label="Action arguments JSON"
            data-testid="action-args-input"
            value={draftJson}
            onChange={(e) => setDraftJson(e.target.value)}
            rows={Math.min(14, Math.max(4, draftJson.split("\n").length + 1))}
            className="mt-0.5 w-full rounded border border-line bg-canvas px-2 py-1 font-mono text-xs outline-none focus:border-accent"
          />
        ) : (
          <pre className="mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-canvas px-2 py-1 font-mono text-xs" data-testid="action-args">
            {visibleJsonText(p.argsJson)}
          </pre>
        )}
      </div>
      {needsTick && actionable && (
        <label className="mt-2 flex items-center gap-1.5 text-xs text-warn">
          <input
            type="checkbox"
            data-testid="action-confirm-tick"
            checked={ticked}
            onChange={(e) => setTickedForJson(e.target.checked ? activeJson : null)}
          />
          I confirm this permanent action and the exact arguments above
        </label>
      )}
      {p.result !== undefined && (
        <div className="mt-2">
          <div className="text-[11px] text-ok">Server response</div>
          <pre className="mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-canvas px-2 py-1 font-mono text-xs" data-testid="action-result">
            {p.result}
          </pre>
        </div>
      )}
      {(error ?? p.error) && (
        <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-canvas px-2 py-1 font-mono text-xs text-bad" data-testid="action-error">
          {error ?? p.error}
        </pre>
      )}
      {actionable && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button
            testId="action-send"
            primary
            disabled={busy || (needsTick && !ticked)}
            onClick={() => void submit()}
          >
            {busy ? "Running…" : p.status === "failed" ? "Try again" : p.cls === "destructive" ? "Confirm and run" : "Send"}
          </Button>
          <Button
            testId="action-edit"
            disabled={busy}
            onClick={() => {
              if (!editing) setDraftJson(p.argsJson);
              setEditing(!editing);
            }}
          >
            {editing ? "Done editing" : "Edit"}
          </Button>
          <Button testId="action-cancel" disabled={busy} onClick={() => void cancel()}>
            Cancel
          </Button>
        </div>
      )}
    </Shell>
  );
}

const WORKFLOW_DISPATCH_STATUS_LABEL: Record<"pending" | "dispatching" | "done" | "failed" | "cancelled", string> = {
  pending: "Needs your click",
  dispatching: "Dispatching…",
  done: "Dispatched",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function WorkflowDispatchCard({ card }: { card: Extract<CardItem, { cardType: "workflow_dispatch" }> }) {
  const p = card.payload;
  const confirmWorkflowDispatch = useAria((s) => s.confirmWorkflowDispatch);
  const dismissWorkflowDispatch = useAria((s) => s.dismissWorkflowDispatch);
  const watch = useAria((s) => (p.watchId !== undefined ? s.watches.find((w) => w.id === p.watchId) : undefined));
  const [editing, setEditing] = useState(false);
  const [draftRef, setDraftRef] = useState(p.ref);
  const [draftInputsJson, setDraftInputsJson] = useState(() => JSON.stringify(p.inputs, null, 2));
  const [lastSyncedRev, setLastSyncedRev] = useState(p.revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (p.revision !== lastSyncedRev) {
    setLastSyncedRev(p.revision);
    if (!editing) {
      setDraftRef(p.ref);
      setDraftInputsJson(JSON.stringify(p.inputs, null, 2));
    }
  }

  const actionable = p.status === "pending" || p.status === "failed";
  const inputCount = Object.keys(p.inputs).length;
  const tone =
    p.status === "done"
      ? "border-ok/50"
      : p.status === "failed"
        ? "border-bad/50"
        : p.status === "cancelled"
          ? "border-line"
          : "border-accent/60";

  const submit = async () => {
    if (busy || p.status === "dispatching") return;
    setError(null);
    let parsedInputs: Record<string, string> | undefined;
    const nextRef = editing ? draftRef.trim() : p.ref;
    if (!nextRef) {
      setError("Give a branch or tag name.");
      return;
    }
    if (editing || draftInputsJson !== JSON.stringify(p.inputs, null, 2)) {
      let raw: unknown;
      try {
        raw = JSON.parse(draftInputsJson);
      } catch {
        setError("Workflow inputs must be valid JSON.");
        return;
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        setError("Workflow inputs must be a JSON object of key-value pairs.");
        return;
      }
      parsedInputs = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (v === undefined) continue;
        if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
          setError(`Input "${k}" must be a string, number, or boolean.`);
          return;
        }
        parsedInputs[k] = String(v);
      }
    }
    setBusy(true);
    const failed = await confirmWorkflowDispatch({
      cardId: card.id,
      revision: p.revision,
      ...(nextRef !== p.ref ? { ref: nextRef } : {}),
      ...(parsedInputs !== undefined ? { inputs: parsedInputs } : {}),
    });
    setBusy(false);
    if (failed) setError(failed);
    else setEditing(false);
  };

  const cancel = async () => {
    if (busy || p.status === "dispatching") return;
    setBusy(true);
    setError(await dismissWorkflowDispatch(card.id));
    setBusy(false);
  };

  return (
    <Shell
      testId="card-workflow-dispatch"
      cardId={card.id}
      tone={tone}
      icon={p.status === "done" ? <Check className="h-4 w-4 text-ok" /> : <Workflow className="h-4 w-4 text-accent" />}
      title={
        <span data-testid="workflow-dispatch-title" data-status={p.status}>
          <ShortId id={p.shortId} />
          Run workflow: {p.workflowName} <span className="font-normal text-muted">· {p.repoName}</span>
        </span>
      }
      right={
        <span className="shrink-0 text-xs text-muted" data-testid="workflow-dispatch-status">
          {WORKFLOW_DISPATCH_STATUS_LABEL[p.status]}
          {p.edited ? " · edited" : ""}
        </span>
      }
    >
      {p.note && (
        <div className="mt-1 wrap-anywhere text-xs text-muted" data-testid="workflow-dispatch-note">
          <Markdown text={p.note} />
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted" data-testid="workflow-dispatch-meta">
        <span className="font-mono text-[11px]">{p.workflowPath}</span>
        <span>
          {p.owner}/{p.repo}
        </span>
        <span className="inline-flex items-center gap-1" data-testid="workflow-dispatch-ref">
          <GitBranch className="h-3 w-3" />
          {p.ref}
        </span>
        <span>as @{p.login}</span>
      </div>
      {editing && actionable ? (
        <div className="mt-2 space-y-1.5">
          <label className="block text-xs">
            <span className="text-muted">Branch or tag (ref)</span>
            <input
              aria-label="Workflow branch or tag"
              data-testid="workflow-dispatch-ref-input"
              value={draftRef}
              maxLength={250}
              onChange={(e) => setDraftRef(e.target.value)}
              className="mt-0.5 block w-full rounded border border-line bg-canvas px-2 py-1 font-mono text-xs outline-none focus:border-accent"
            />
          </label>
          <label className="block text-xs">
            <span className="text-muted">Workflow inputs JSON (key-value pairs, or {"{}"} for default settings)</span>
            <textarea
              aria-label="Workflow inputs JSON"
              data-testid="workflow-dispatch-inputs-input"
              value={draftInputsJson}
              onChange={(e) => setDraftInputsJson(e.target.value)}
              rows={Math.min(10, Math.max(3, draftInputsJson.split("\n").length + 1))}
              className="mt-0.5 block w-full rounded border border-line bg-canvas px-2 py-1 font-mono text-xs outline-none focus:border-accent"
            />
          </label>
        </div>
      ) : (
        <div className="mt-1.5">
          {inputCount === 0 ? (
            <div className="text-xs text-muted" data-testid="workflow-dispatch-inputs-default">
              Inputs: default settings (no custom inputs)
            </div>
          ) : (
            <div>
              <div className="text-[11px] text-muted">Workflow inputs</div>
              <pre
                className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-canvas px-2 py-1 font-mono text-xs"
                data-testid="workflow-dispatch-inputs"
              >
                {visibleJsonText(JSON.stringify(p.inputs, null, 2))}
              </pre>
            </div>
          )}
        </div>
      )}
      {p.status === "done" && (
        <div className="mt-1.5 text-xs text-ok" data-testid="workflow-dispatch-result">
          Dispatched on <span className="font-mono">{p.ref}</span>
          {watch
            ? ` · ARIA watches for the run (${watch.shortId}: ${watch.status}).`
            : p.watchId !== undefined
              ? ` · ARIA watches for the run (W-${p.watchId}).`
              : "."}
        </div>
      )}
      {p.watchNote && (
        <div className="mt-1 text-xs text-warn" data-testid="workflow-dispatch-watch-note">
          {p.watchNote}
        </div>
      )}
      {(error ?? p.error) && (
        <div className="mt-1.5 text-xs text-bad" data-testid="workflow-dispatch-error">
          {error ?? p.error}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {actionable && (
          <>
            <Button
              testId="workflow-dispatch-run"
              primary
              disabled={busy}
              onClick={() => void submit()}
            >
              <Workflow className="h-3 w-3" /> {busy ? "Dispatching…" : p.status === "failed" ? "Try again" : "Run workflow"}
            </Button>
            <Button
              testId="workflow-dispatch-edit"
              disabled={busy}
              onClick={() => {
                if (!editing) {
                  setDraftRef(p.ref);
                  setDraftInputsJson(JSON.stringify(p.inputs, null, 2));
                }
                setEditing(!editing);
              }}
            >
              {editing ? "Done editing" : "Edit"}
            </Button>
            <Button testId="workflow-dispatch-cancel" disabled={busy} onClick={() => void cancel()}>
              Cancel
            </Button>
          </>
        )}
        <Button testId="workflow-dispatch-open" onClick={() => openPage(p.url)}>
          <ExternalLink className="h-3 w-3" /> Open on GitHub
        </Button>
      </div>
    </Shell>
  );
}
