import type { Memory, MemoryScope } from "@aria/protocol";
import { Plus, Trash, TriangleAlert } from "lucide-react";
import { useRef, useState, type RefObject } from "react";
import { leftOutIds, memoryHint, shortDate } from "../flow";
import { useFocusLater } from "../focus";
import { useAria } from "../store";

const field = "rounded-md border border-line bg-canvas px-2 py-1 text-sm outline-none focus:border-accent";
const button = "rounded-md border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-fg disabled:opacity-40";

/** "global", or a project's id: where a note goes, as the select's value. */
type Where = "global" | `${number}`;
const whereOf = (memory: Pick<Memory, "scope" | "repoId">): Where => (memory.scope === "global" || memory.repoId === undefined ? "global" : `${memory.repoId}`);
const scopeOf = (where: Where): { scope: MemoryScope; repoId?: number } => (where === "global" ? { scope: "global" } : { scope: "project", repoId: Number(where) });

function source(memory: Memory): string {
  const s = memory.source;
  if (!s || s.kind === "typed") return `Typed here, ${shortDate(memory.createdAt)}`;
  if (s.kind === "aria") return `Saved by ARIA in chat, ${shortDate(s.at)}`;
  const what = s.kind === "answer" ? "your answer to" : "your message to";
  return `From ${what} ${s.taskTitle ?? "a task"}, ${shortDate(s.at)}`;
}

function WhereSelect({ value, onChange, extra }: { value: Where; onChange: (where: Where) => void; extra?: { value: Where; label: string } | undefined }) {
  // The list itself (a filtered copy would be a new value on every read of the store).
  const projects = useAria((s) => s.projects).filter((p) => !p.hidden);
  return (
    <select aria-label="For which tasks" data-testid="memory-where" className={`${field} text-xs`} value={value} onChange={(e) => onChange(e.target.value as Where)}>
      <option value="global">Every project</option>
      {projects.map((p) => (
        <option key={p.id} value={`${p.id}`}>
          {p.name}
        </option>
      ))}
      {extra && !projects.some((p) => `${p.id}` === extra.value) && <option value={extra.value}>{extra.label}</option>}
    </select>
  );
}

/** `onDeleted`: the row is gone, so the focus needs somewhere to go (the page puts it in "Add a note"). */
function MemoryRow({ memory, leftOut, onDeleted }: { memory: Memory; leftOut: boolean; onDeleted: () => void }) {
  const saveMemory = useAria((s) => s.saveMemory);
  const deleteMemory = useAria((s) => s.deleteMemory);
  const [text, setText] = useState(memory.text);
  const [where, setWhere] = useState<Where>(whereOf(memory));
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The trash button and Keep swap places: the focus follows to whichever shows.
  const [keep, focusKeep] = useFocusLater<HTMLButtonElement>();
  const [trash, focusTrash] = useFocusLater<HTMLButtonElement>();
  const changed = text.trim() !== memory.text || where !== whereOf(memory);
  const hint = memoryHint(text);
  const act = async (action: () => Promise<string | null | undefined>) => {
    setBusy(true);
    setError(null);
    const failed = await action();
    setBusy(false);
    if (failed) setError(failed);
  };
  return (
    <div className="space-y-0.5" data-testid="memory-row" data-memory-id={memory.id}>
      <div className="flex items-center gap-1.5">
        <input aria-label="The note" data-testid="memory-row-text" className={`${field} min-w-0 flex-1 text-xs`} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
        <WhereSelect value={where} onChange={setWhere} extra={memory.repoId !== undefined ? { value: `${memory.repoId}`, label: memory.repoName ?? "A project that's gone" } : undefined} />
        {changed && (
          <button
            data-testid="memory-row-save"
            className={button}
            disabled={busy || Boolean(hint)}
            title={hint}
            onClick={() => void act(async () => (await saveMemory({ id: memory.id, text, ...scopeOf(where) })).error)}
          >
            Save
          </button>
        )}
        {confirm ? (
          <>
            <button
              data-testid="memory-row-delete-confirm"
              className={`${button} hover:border-bad hover:text-bad`}
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const failed = await deleteMemory(memory.id);
                  if (!failed) onDeleted();
                  return failed;
                })
              }
            >
              Delete
            </button>
            <button
              ref={keep}
              className={button}
              onClick={() => {
                focusTrash();
                setConfirm(false);
              }}
            >
              Keep
            </button>
          </>
        ) : (
          <button
            ref={trash}
            aria-label={`Delete the note "${memory.text}"`}
            data-testid="memory-row-delete"
            className="rounded p-1 text-muted hover:text-bad"
            onClick={() => {
              focusKeep();
              setConfirm(true);
            }}
          >
            <Trash className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-x-2 text-[11px] text-muted">
        <span>{source(memory)}</span>
        {leftOut && (
          <span className="text-warn" data-testid="memory-left-out">
            Doesn't fit in the briefs (too many notes): it's left out.
          </span>
        )}
      </div>
      {changed && hint && text.trim() && <div className="text-[11px] text-warn">{hint}</div>}
      {error && (
        <div className="text-[11px] text-bad" data-testid="memory-row-error">
          {error}
        </div>
      )}
    </div>
  );
}

function AddMemory({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const saveMemory = useAria((s) => s.saveMemory);
  const [text, setText] = useState("");
  const [where, setWhere] = useState<Where>("global");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hint = memoryHint(text);
  return (
    <form
      className="space-y-1"
      onSubmit={async (e) => {
        e.preventDefault();
        if (hint || busy) return;
        setBusy(true);
        setError(null);
        const result = await saveMemory({ text, ...scopeOf(where) });
        setBusy(false);
        if (result.error) setError(result.error);
        else setText("");
      }}
    >
      <div className="flex items-center gap-1.5">
        <input ref={inputRef} aria-label="A new note" data-testid="memory-add-text" className={`${field} min-w-0 flex-1 text-xs`} value={text} maxLength={2000} placeholder="Moonrise uses pnpm" onChange={(e) => setText(e.target.value)} />
        <WhereSelect value={where} onChange={setWhere} />
        <button type="submit" data-testid="memory-add" className={button} disabled={busy || Boolean(hint)}>
          <Plus className="inline h-3 w-3" /> Add
        </button>
      </div>
      {text.trim() && hint && <div className="text-[11px] text-warn">{hint}</div>}
      {error && <div className="text-[11px] text-bad">{error}</div>}
    </form>
  );
}

/** Customize › Memory (PLAN.md §5.3, D23): the notes task briefs get, grouped by where they go; edit and delete them. */
export function CustomizeMemory() {
  const memory = useAria((s) => s.memory);
  const setCustomizePage = useAria((s) => s.setCustomizePage);
  const addInput = useRef<HTMLInputElement>(null);
  const global = memory.memories.filter((m) => m.scope === "global");
  const projectIds = [...new Set(memory.memories.flatMap((m) => (m.scope === "project" && m.repoId !== undefined ? [m.repoId] : [])))];
  const groups = [
    { key: "global", title: "Every project", repoId: null as number | null, items: global },
    ...projectIds.map((repoId) => {
      const items = memory.memories.filter((m) => m.scope === "project" && m.repoId === repoId);
      return { key: `${repoId}`, title: items[0]?.repoName ?? "A project that's gone", repoId: repoId as number | null, items };
    }),
  ];
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <div className="text-xs text-muted">
          Notes in your own words that go into task briefs and ARIA's own system prompt: a project's notes into that project's tasks (and marked with the project's name for
          ARIA), the others into every task and into ARIA. A brief (and ARIA's prompt) gets at most 30 notes and 3,000 characters, newest first. ARIA can also save and
          remove notes when you ask in the chat (<code>remember</code> / <code>forget</code>).
        </div>
        {!memory.templateUsesMemory && (
          <div className="flex items-start gap-1.5 rounded-md border border-warn/50 bg-warn/5 px-3 py-2 text-xs text-warn" data-testid="memory-no-placeholder">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Your brief template doesn't use {"{{memory}}"}, so tasks don't get these notes.{" "}
              <button className="text-accent hover:underline" onClick={() => setCustomizePage("prompts")}>
                Customize › Prompts
              </button>
            </span>
          </div>
        )}
        {memory.conductorUsesMemory === false && (
          <div className="flex items-start gap-1.5 rounded-md border border-warn/50 bg-warn/5 px-3 py-2 text-xs text-warn" data-testid="memory-conductor-no-placeholder">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Your ARIA system prompt doesn't use {"{{memory}}"}, so ARIA's own prompt doesn't get these notes.{" "}
              <button className="text-accent hover:underline" onClick={() => setCustomizePage("prompts")}>
                Customize › Prompts
              </button>
            </span>
          </div>
        )}
        {groups.map((group) => {
          const leftOut = leftOutIds(memory, group.repoId);
          if (group.repoId === null && group.items.length === 0) return null;
          return (
            <section key={group.key} className="space-y-2 rounded-lg border border-line bg-panel p-4" data-testid="memory-group">
              <div className="flex items-baseline gap-2">
                <div className="font-medium">{group.title}</div>
                {leftOut.size > 0 && (
                  <div className="text-xs text-warn" data-testid="memory-group-left-out">
                    {leftOut.size} note{leftOut.size === 1 ? " doesn't" : "s don't"} fit in {group.repoId === null ? "the briefs of a project without notes of its own" : "this project's briefs"}
                  </div>
                )}
              </div>
              {group.items.map((m) => (
                <MemoryRow key={`${m.id}-${m.updatedAt}`} memory={m} leftOut={leftOut.has(m.id)} onDeleted={() => addInput.current?.focus()} />
              ))}
            </section>
          );
        })}
        <section className="space-y-2 rounded-lg border border-line bg-panel p-4">
          <div className="font-medium">Add a note</div>
          <AddMemory inputRef={addInput} />
        </section>
        {memory.memories.length === 0 && <div className="text-xs text-muted">No notes yet. Use “Save as memory” on your message to a task or on your answer to its question, or add one here.</div>}
      </div>
    </div>
  );
}
