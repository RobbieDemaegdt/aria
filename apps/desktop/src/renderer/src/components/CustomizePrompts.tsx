import type { PromptInfo, PromptVersion } from "@aria/protocol";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { diffLines } from "../lineDiff";
import { errorText, useAria } from "../store";

const WHEN: Record<string, string> = {
  conductor: "ARIA's own instructions. A change applies from your next message: ARIA reopens the conversation with it.",
  brief: "What every new task gets as its first message. A change applies to the next task you or ARIA start.",
};

const when = (name: string) => WHEN[name] ?? "Added to the brief of every task that uses this profile (the {{profileInstructions}} part). Applies to the next task.";
const dated = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function VersionDiff({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const changed = lines.some((l) => l.kind !== " ");
  return (
    <pre className="mt-1 max-h-72 overflow-auto rounded bg-canvas py-1 font-mono text-[11px] leading-[1.45]" data-testid="prompt-diff">
      {!changed && <div className="px-2 text-muted">No changes.</div>}
      {lines.map((line, i) => (
        <div key={i} className={`whitespace-pre-wrap px-2 ${line.kind === "+" ? "bg-ok/10 text-ok" : line.kind === "-" ? "bg-bad/10 text-bad" : "text-muted"}`}>
          {line.kind}
          {line.text || " "}
        </div>
      ))}
    </pre>
  );
}

/** Customize › Prompts (PLAN.md §5.3): ARIA's system prompt, the worker brief template and profile instructions, with every version. */
export function CustomizePrompts() {
  const profiles = useAria((s) => s.profiles);
  const [prompts, setPrompts] = useState<PromptInfo[] | null>(null);
  const [name, setName] = useState("brief");
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [history, setHistory] = useState<PromptVersion[]>([]);
  const [diffOf, setDiffOf] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = prompts?.find((p) => p.name === name);
  // The prompt on screen now: a save or a history load that answers after you picked another one leaves it alone.
  const selected = useRef(name);
  selected.current = name;

  const loadHistory = useCallback(async (prompt: string) => {
    try {
      const versions = await window.aria.promptHistory(prompt);
      if (selected.current === prompt) setHistory(versions);
    } catch (e) {
      if (selected.current === prompt) setError(errorText(e));
    }
  }, []);

  // The list follows your profiles (their instructions are prompts too).
  useEffect(() => {
    void window.aria.listPrompts().then(setPrompts, (e: unknown) => setError(errorText(e)));
  }, [profiles]);

  useEffect(() => {
    const info = prompts?.find((p) => p.name === name);
    if (!info && prompts) setName("brief");
  }, [prompts, name]);

  // Picking another prompt (or the list's first load) starts from that prompt's text in use. A save, or the list
  // refreshing, keeps what's on screen (the save already put its result there).
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!current || loadedFor.current === name) return;
    loadedFor.current = name;
    setText(current.text);
    setNote("");
    setDiffOf(null);
    setSaved(null);
    setError(null);
    void loadHistory(name);
  }, [name, current, loadHistory]);

  const apply = async (action: () => Promise<PromptInfo>, done: string) => {
    const prompt = name;
    // What's on screen when you pressed it: anything you type while it's on its way is kept.
    const before = { text, note };
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const info = await action();
      setPrompts((all) => all?.map((p) => (p.name === info.name ? info : p)) ?? all);
      if (selected.current !== prompt) return;
      setText((current) => (current === before.text ? info.text : current));
      setNote((current) => (current === before.note ? "" : current));
      setSaved(done);
      await loadHistory(info.name);
    } catch (e) {
      if (selected.current === prompt) setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!prompts) return <div className="p-6 text-sm text-muted">{error ?? "Loading…"}</div>;
  const changed = current !== undefined && text !== current.text;
  const isDefault = current !== undefined && current.defaultText !== "" && current.text === current.defaultText;
  // The same checks the save makes (templateProblem), shown while you type.
  const used = current ? [...new Set([...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!))] : [];
  const unknown = current ? used.filter((p) => !current.placeholders.includes(p)) : [];
  const missing = current ? current.required.filter((p) => !used.includes(p)) : [];
  const braces = (names: string[]) => names.map((p) => `{{${p}}}`).join(", ");

  return (
    <div className="flex h-full min-h-0">
      <nav className="w-56 shrink-0 space-y-0.5 overflow-y-auto border-r border-line p-3" aria-label="Prompts">
        {prompts.map((p) => (
          <button
            key={p.name}
            data-testid="prompt-item"
            data-prompt={p.name}
            aria-current={p.name === name ? "true" : undefined}
            onClick={() => setName(p.name)}
            className={`block w-full rounded-md px-2 py-1.5 text-left text-sm ${p.name === name ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}
          >
            <span className="block truncate">{p.label}</span>
            <span className="block text-[11px] text-muted">{p.version === 0 ? (p.defaultText ? "built-in" : "empty") : `version ${p.version}`}</span>
          </button>
        ))}
      </nav>
      {current && (
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-3 p-6">
            <div>
              <div className="font-medium" data-testid="prompt-label">
                {current.label}
              </div>
              <div className="text-xs text-muted">{when(current.name)}</div>
              {current.placeholders.length > 0 && (
                <div className="mt-1 text-xs text-muted">
                  Placeholders:{" "}
                  {current.placeholders.map((p) => (
                    <code key={p} className={`mr-1 rounded bg-raised px-1 ${current.required.includes(p) ? "text-fg" : ""}`} title={current.required.includes(p) ? "Required" : undefined}>
                      {`{{${p}}}`}
                    </code>
                  ))}
                  {current.required.length > 0 && <span>({current.required.map((p) => `{{${p}}}`).join(", ")} required)</span>}
                </div>
              )}
            </div>
            <textarea
              data-testid="prompt-text"
              aria-label={current.label}
              rows={18}
              spellCheck={false}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setSaved(null);
              }}
              className="w-full resize-y rounded-md border border-line bg-canvas px-2 py-1.5 font-mono text-xs outline-none focus:border-accent"
            />
            {unknown.length > 0 && (
              <div className="text-xs text-bad" data-testid="prompt-problem">
                There's no placeholder called {braces(unknown)} here.{current.placeholders.length ? ` You can use ${braces(current.placeholders)}.` : ""}
              </div>
            )}
            {missing.length > 0 && (
              <div className="text-xs text-bad" data-testid="prompt-problem">
                It has to contain {braces(missing)}.
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <input
                data-testid="prompt-note"
                aria-label="What you changed (optional)"
                value={note}
                maxLength={200}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What you changed (optional)"
                className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1 text-sm outline-none focus:border-accent"
              />
              <button
                data-testid="prompt-save"
                disabled={busy || !changed || unknown.length > 0 || missing.length > 0}
                onClick={() => void apply(() => window.aria.savePrompt({ name: current.name, text, ...(note.trim() ? { note: note.trim() } : {}) }), "Saved as a new version.")}
                className="rounded-md bg-accent px-3 py-1 text-sm text-white disabled:opacity-40"
              >
                {busy ? "Saving…" : "Save"}
              </button>
              {changed && (
                <button onClick={() => setText(current.text)} className="rounded-md px-2 py-1 text-xs text-muted hover:text-fg">
                  Undo my edits
                </button>
              )}
              {current.defaultText !== "" && !isDefault && (
                <button
                  data-testid="prompt-reset"
                  disabled={busy}
                  onClick={() => void apply(() => window.aria.resetPrompt(current.name), "Back to the built-in text (saved as a new version).")}
                  className="rounded-md px-2 py-1 text-xs text-muted hover:text-fg"
                >
                  Reset to the built-in text
                </button>
              )}
            </div>
            {saved && (
              <div className="text-xs text-ok" data-testid="prompt-saved">
                {saved}
              </div>
            )}
            {error && (
              <div className="text-xs text-bad" data-testid="prompt-error">
                {error}
              </div>
            )}

            <section className="space-y-1.5 pt-2" data-testid="prompt-history">
              <div className="text-sm font-medium">Versions</div>
              {history.length === 0 && <div className="text-xs text-muted">No saved versions yet: it's {current.defaultText ? "the built-in text" : "empty"}.</div>}
              {history.map((v, i) => {
                const previous = history[i + 1]?.text ?? current.defaultText;
                return (
                  <div key={v.version} className="rounded-md border border-line px-2 py-1.5 text-xs" data-testid="prompt-version">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">Version {v.version}</span>
                      {i === 0 && <span className="rounded bg-ok/15 px-1 text-ok">in use</span>}
                      <span className="text-muted">{dated(v.createdAt)}</span>
                      {v.note && <span className="truncate text-muted">· {v.note}</span>}
                      <span className="ml-auto flex gap-1.5">
                        <button aria-expanded={diffOf === v.version} onClick={() => setDiffOf(diffOf === v.version ? null : v.version)} className="text-muted hover:text-fg">
                          {diffOf === v.version ? "Hide changes" : "Changes"}
                        </button>
                        {i > 0 && (
                          <button
                            data-testid="prompt-rollback"
                            disabled={busy}
                            onClick={() => void apply(() => window.aria.rollbackPrompt({ name: current.name, version: v.version }), `Back to version ${v.version} (saved as a new version).`)}
                            className="inline-flex items-center gap-1 text-muted hover:text-fg disabled:opacity-40"
                          >
                            <RotateCcw className="h-3 w-3" /> Use this one
                          </button>
                        )}
                      </span>
                    </div>
                    {diffOf === v.version && <VersionDiff before={previous} after={v.text} />}
                  </div>
                );
              })}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
