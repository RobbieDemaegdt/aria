import type {
  SearchMemoryHit,
  SearchProjectHit,
  SearchScope,
  SearchTaskHit,
  SearchTranscriptHit,
  TranscriptEntry,
} from "@aria/protocol";
import {
  Brain,
  CircleQuestionMark,
  ExternalLink,
  Folder,
  Info,
  MessageSquare,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { shortDate } from "../flow";
import { SidebarToggle } from "../sidebar";
import { useHasTracker, useAria, useTracker } from "../store";
import { trackerRef } from "../tracker";
import { StateIcon } from "./tasks";

const SCOPES: Array<{ id: SearchScope; label: string }> = [
  { id: "all", label: "All" },
  { id: "transcripts", label: "Session transcripts" },
  { id: "tasks", label: "Tasks" },
  { id: "projects", label: "Projects" },
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const tokens = useMemo(
    () =>
      [...new Set(query.trim().split(/\s+/).filter(Boolean))]
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp),
    [query],
  );
  if (!text || tokens.length === 0) return text;
  const regex = new RegExp(`(${tokens.join("|")})`, "gi");
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-accent/25 px-0.5 text-fg">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

function entryKindBadge(kind: TranscriptEntry["kind"], toolName?: string): { label: string; icon: typeof Wrench } {
  switch (kind) {
    case "tool":
      return { label: toolName ? `Tool · ${toolName}` : "Tool", icon: Wrench };
    case "user":
      return { label: "User", icon: MessageSquare };
    case "assistant":
      return { label: "Assistant", icon: Sparkles };
    case "reasoning":
      return { label: "Thinking", icon: Brain };
    case "question":
      return { label: "Question", icon: CircleQuestionMark };
    case "permission":
      return { label: "Permission", icon: ShieldCheck };
    case "info":
      return { label: "Info", icon: Info };
  }
}

function ProjectHitRow({ hit, query }: { hit: SearchProjectHit; query: string }) {
  const openTask = useAria((s) => s.openTask);
  const openNewSession = useAria((s) => s.openNewSession);
  const setPrefill = useAria((s) => s.setPrefill);
  const remote = hit.owner && hit.repo ? `${hit.owner}/${hit.repo}` : undefined;
  return (
    <div
      data-testid="search-hit-project"
      data-project-id={hit.id}
      className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-line bg-panel p-3 hover:border-accent/60"
    >
      <button
        type="button"
        onClick={() => (hit.latestTaskId ? openTask(hit.latestTaskId) : openNewSession(hit.id))}
        className="min-w-0 flex-1 text-left"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Folder className="h-4 w-4 shrink-0 text-accent" />
          <span className="font-medium text-fg">
            <Highlight text={hit.name} query={query} />
          </span>
          {remote && <span className="text-xs text-muted">{remote}</span>}
          {hit.defaultBranch && (
            <span className="rounded border border-line px-1.5 py-px font-mono text-[11px] text-muted">
              {hit.defaultBranch}
            </span>
          )}
          <span className="rounded bg-raised px-1.5 py-px text-[11px] text-muted">
            matched {hit.matchedField}
          </span>
          {hit.taskCount > 0 && (
            <span className="text-xs text-muted">
              {hit.taskCount} session{hit.taskCount === 1 ? "" : "s"}
              {hit.activeTaskCount > 0 ? ` (${hit.activeTaskCount} active)` : ""}
            </span>
          )}
        </div>
        {hit.snippet && (
          <div className="mt-1 truncate text-xs text-muted">
            <Highlight text={hit.snippet} query={query} />
          </div>
        )}
      </button>
      <div className="flex shrink-0 items-center gap-1.5 text-xs">
        {hit.latestTaskId && (
          <button
            type="button"
            data-testid="search-open-session"
            onClick={() => openTask(hit.latestTaskId!)}
            className="rounded border border-line px-2 py-1 text-muted hover:border-accent hover:text-fg"
          >
            Open session
          </button>
        )}
        <button
          type="button"
          data-testid="search-project-new-session"
          onClick={() => openNewSession(hit.id)}
          className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-muted hover:border-accent hover:text-fg"
        >
          <Plus className="h-3 w-3" /> New session
        </button>
        <button
          type="button"
          data-testid="search-project-ask"
          onClick={() => setPrefill(`About ${hit.name}: `)}
          className="rounded border border-line px-2 py-1 text-muted hover:border-accent hover:text-fg"
        >
          Ask ARIA
        </button>
      </div>
    </div>
  );
}

function TaskHitRow({ hit, query }: { hit: SearchTaskHit; query: string }) {
  const openTask = useAria((s) => s.openTask);
  const tracker = useTracker();
  const hasTracker = useHasTracker();
  const focusCard = useAria((s) => s.focusCard);
  return (
    <div
      data-testid="search-hit-task"
      data-task-id={hit.taskId}
      className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-line bg-panel p-3 hover:border-accent/60"
    >
      <button
        type="button"
        onClick={() => openTask(hit.taskId)}
        className="min-w-0 flex-1 text-left"
      >
        <div className="flex flex-wrap items-center gap-2">
          <StateIcon state={hit.state} />
          <span className="font-medium text-fg">
            <Highlight text={hit.title} query={query} />
          </span>
          <span className="rounded border border-line px-1.5 py-px text-[11px] text-muted">
            {hit.repoName}
          </span>
          {hit.branch && (
            <span className="rounded bg-canvas px-1.5 py-px font-mono text-[11px] text-muted">
              <Highlight text={hit.branch} query={query} />
            </span>
          )}
          {hasTracker && hit.trackerTaskId && (
            <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-px font-mono text-[11px] text-accent">
              {trackerRef(tracker, hit.trackerTaskId)}
            </span>
          )}
          {hit.prNumber !== undefined && (
            <span className="rounded border border-line px-1.5 py-px text-[11px] text-muted">
              PR #{hit.prNumber}
            </span>
          )}
          <span className="rounded bg-raised px-1.5 py-px text-[11px] text-muted">
            matched {hit.matchedField}
          </span>
        </div>
        {hit.snippet && (
          <div className="mt-1 line-clamp-2 text-xs text-muted">
            <Highlight text={hit.snippet} query={query} />
          </div>
        )}
      </button>
      <div className="flex shrink-0 items-center gap-1.5 text-xs">
        <button
          type="button"
          data-testid="search-open-session"
          onClick={() => openTask(hit.taskId)}
          className="rounded border border-line px-2 py-1 text-muted hover:border-accent hover:text-fg"
        >
          Open session
        </button>
        {hit.cardId && (
          <button
            type="button"
            data-testid="search-open-card"
            onClick={() => focusCard(hit.cardId, hit.taskId)}
            className="rounded border border-line px-2 py-1 text-muted hover:border-accent hover:text-fg"
          >
            Open card
          </button>
        )}
      </div>
    </div>
  );
}

function TranscriptHitRow({ hit, query }: { hit: SearchTranscriptHit; query: string }) {
  const openTask = useAria((s) => s.openTask);
  const openInspector = useAria((s) => s.openInspector);
  const focusCard = useAria((s) => s.focusCard);
  const { label, icon: Icon } = entryKindBadge(hit.entryKind, hit.toolName);
  const openSession = () => {
    if (hit.taskId) openTask(hit.taskId, "transcript", hit.entryId);
    else openInspector(hit.entryId);
  };
  return (
    <div
      data-testid="search-hit-transcript"
      data-entry-id={hit.entryId}
      data-task-id={hit.taskId ?? ""}
      className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-line bg-panel p-3 hover:border-accent/60"
    >
      <button type="button" onClick={openSession} className="min-w-0 flex-1 text-left">
        <div className="flex flex-wrap items-center gap-2">
          {hit.taskState ? <StateIcon state={hit.taskState} /> : <MessageSquare className="h-3.5 w-3.5 shrink-0 text-accent" />}
          <span className="font-medium text-fg">
            <Highlight text={hit.sessionTitle} query={query} />
          </span>
          {hit.repoName && (
            <span className="rounded border border-line px-1.5 py-px text-[11px] text-muted">
              {hit.repoName}
            </span>
          )}
          <span className="inline-flex items-center gap-1 rounded bg-raised px-1.5 py-px text-[11px] text-muted">
            <Icon className="h-3 w-3" />
            <Highlight text={label} query={query} />
          </span>
          <span className="text-[11px] text-muted">{shortDate(hit.at)}</span>
        </div>
        {hit.snippet && (
          <div className="mt-1 line-clamp-2 font-mono text-xs text-muted">
            <Highlight text={hit.snippet} query={query} />
          </div>
        )}
      </button>
      <div className="flex shrink-0 items-center gap-1.5 text-xs">
        <button
          type="button"
          data-testid="search-open-session"
          onClick={openSession}
          className="rounded border border-line px-2 py-1 text-muted hover:border-accent hover:text-fg"
        >
          {hit.taskId ? "Open session" : "Open inspector"}
        </button>
        {hit.cardId && (
          <button
            type="button"
            data-testid="search-open-card"
            onClick={() => focusCard(hit.cardId, hit.taskId)}
            className="rounded border border-line px-2 py-1 text-muted hover:border-accent hover:text-fg"
          >
            Open card
          </button>
        )}
      </div>
    </div>
  );
}

function MemoryHitRow({ hit, query }: { hit: SearchMemoryHit; query: string }) {
  const setCustomizePage = useAria((s) => s.setCustomizePage);
  return (
    <div
      data-testid="search-hit-memory"
      data-memory-id={hit.id}
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-xs hover:border-accent/60"
    >
      <div className="min-w-0 flex-1">
        <span className="mr-2 rounded border border-line px-1.5 py-px text-[11px] text-muted">
          {hit.scope === "global" ? "Every project" : (hit.repoName ?? "Project")}
        </span>
        <span className="text-fg">
          <Highlight text={hit.text} query={query} />
        </span>
      </div>
      <button
        type="button"
        data-testid="search-open-memory"
        onClick={() => setCustomizePage("memory")}
        className="inline-flex shrink-0 items-center gap-1 rounded border border-line px-2 py-1 text-muted hover:border-accent hover:text-fg"
      >
        Customize › Memory <ExternalLink className="h-3 w-3" />
      </button>
    </div>
  );
}

/**
 * Search view (Phase 6A, PLAN.md §5.1, §5.2, §10 Phase 6A): search across session transcripts, tasks, projects, and
 * memories, opening the matching session view or card.
 */
export function SearchView() {
  const projects = useAria((s) => s.projects).filter((p) => !p.hidden);
  const tasks = useAria((s) => s.tasks);
  const query = useAria((s) => s.searchQuery);
  const scope = useAria((s) => s.searchScope);
  const repoId = useAria((s) => s.searchRepoId);
  const results = useAria((s) => s.searchResults);
  const loading = useAria((s) => s.searchLoading);
  const error = useAria((s) => s.searchError);
  const searchFocus = useAria((s) => s.searchFocus);
  const runSearch = useAria((s) => s.runSearch);
  const openTask = useAria((s) => s.openTask);
  const focusCard = useAria((s) => s.focusCard);
  const timeline = useAria((s) => s.timeline);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [searchFocus]);

  const trimmed = query.trim();
  const cardFor = (taskId: string) =>
    [...timeline].reverse().find((i) => i.kind === "card" && "taskId" in i.payload && i.payload.taskId === taskId)?.id;

  return (
    <div className="flex h-full flex-col" data-testid="search-view">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-2">
        <div className="flex items-center gap-2">
          <SidebarToggle />
          <Search className="h-4 w-4 text-accent" />
          <h1 className="font-semibold">Search</h1>
        </div>
        <div className="text-xs text-muted">
          Search across session transcripts, tasks and projects · <kbd className="rounded border border-line px-1 py-0.5 font-mono text-[11px]">Ctrl+K</kbd>
        </div>
      </header>

      <div className="border-b border-line bg-panel/50 px-6 py-3">
        <div className="mx-auto max-w-4xl space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex min-w-60 flex-1 items-center">
              <Search className="pointer-events-none absolute left-3 h-4 w-4 text-muted" />
              <input
                ref={inputRef}
                type="text"
                aria-label="Search across session transcripts, tasks and projects"
                data-testid="search-input"
                value={query}
                onChange={(e) => void runSearch({ query: e.target.value })}
                placeholder="Search across session transcripts, tasks and projects…"
                className="w-full rounded-lg border border-line bg-canvas py-1.5 pl-9 pr-8 text-sm outline-none focus:border-accent"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear search"
                  data-testid="search-clear"
                  onClick={() => {
                    void runSearch({ query: "" });
                    inputRef.current?.focus();
                  }}
                  className="absolute right-2 rounded p-0.5 text-muted hover:text-fg"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <select
              aria-label="Filter by project"
              data-testid="search-project-filter"
              value={repoId ?? ""}
              onChange={(e) => void runSearch({ repoId: e.target.value ? Number(e.target.value) : null })}
              className="rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-xs outline-none focus:border-accent"
            >
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {SCOPES.map((s) => {
              const count =
                results && trimmed
                  ? s.id === "all"
                    ? results.counts.total
                    : s.id === "transcripts"
                      ? results.counts.transcripts
                      : s.id === "tasks"
                        ? results.counts.tasks
                        : results.counts.projects
                  : undefined;
              const active = scope === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  data-testid={`search-scope-${s.id}`}
                  aria-pressed={active}
                  onClick={() => void runSearch({ scope: s.id })}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 ${
                    active ? "bg-accent text-white" : "border border-line bg-canvas text-muted hover:text-fg"
                  }`}
                >
                  <span>{s.label}</span>
                  {count !== undefined && (
                    <span className={`rounded-full px-1.5 text-[11px] ${active ? "bg-white/20 text-white" : "bg-raised text-muted"}`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto max-w-4xl space-y-6">
          {error && (
            <div className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad" data-testid="search-error">
              {error}
            </div>
          )}

          {!trimmed && (
            <div className="space-y-5" data-testid="search-empty-prompt">
              <div className="rounded-lg border border-line bg-panel p-4 text-xs text-muted">
                Type a word or phrase above to search across your session transcripts (briefs, messages, tool calls and outputs), background tasks, projects and saved memories.
              </div>
              {tasks.length > 0 && (
                <section className="space-y-2">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Recent tasks</h2>
                  <div className="space-y-1.5">
                    {tasks.slice(0, 6).map((t) => {
                      const cardId = cardFor(t.id);
                      return (
                        <div
                          key={t.id}
                          data-testid="search-recent-task"
                          className="flex items-center justify-between gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-xs"
                        >
                          <button
                            type="button"
                            onClick={() => openTask(t.id)}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-fg"
                          >
                            <StateIcon state={t.state} />
                            <span className="truncate font-medium text-fg">{t.title}</span>
                            <span className="shrink-0 text-muted">· {t.repoName}</span>
                          </button>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => openTask(t.id)}
                              className="rounded border border-line px-2 py-0.5 text-muted hover:border-accent hover:text-fg"
                            >
                              Open session
                            </button>
                            {cardId && (
                              <button
                                type="button"
                                onClick={() => focusCard(cardId, t.id)}
                                className="rounded border border-line px-2 py-0.5 text-muted hover:border-accent hover:text-fg"
                              >
                                Open card
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}
            </div>
          )}

          {trimmed && results && results.counts.total === 0 && !loading && (
            <div className="rounded-lg border border-line bg-panel p-6 text-center text-sm text-muted" data-testid="search-no-results">
              No matches found for “{trimmed}”.
            </div>
          )}

          {trimmed && results && (
            <>
              {(scope === "all" || scope === "projects") && results.projects.length > 0 && (
                <section className="space-y-2" data-testid="search-section-projects">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
                    Projects ({results.counts.projects})
                  </h2>
                  <div className="space-y-2">
                    {results.projects.map((hit) => (
                      <ProjectHitRow key={hit.id} hit={hit} query={trimmed} />
                    ))}
                  </div>
                </section>
              )}

              {(scope === "all" || scope === "tasks") && results.tasks.length > 0 && (
                <section className="space-y-2" data-testid="search-section-tasks">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
                    Tasks ({results.counts.tasks})
                  </h2>
                  <div className="space-y-2">
                    {results.tasks.map((hit) => (
                      <TaskHitRow key={hit.taskId} hit={hit} query={trimmed} />
                    ))}
                  </div>
                </section>
              )}

              {(scope === "all" || scope === "transcripts") && results.transcripts.length > 0 && (
                <section className="space-y-2" data-testid="search-section-transcripts">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
                    Session transcripts ({results.counts.transcripts})
                  </h2>
                  <div className="space-y-2">
                    {results.transcripts.map((hit) => (
                      <TranscriptHitRow key={`${hit.taskId ?? "conductor"}:${hit.entryId}`} hit={hit} query={trimmed} />
                    ))}
                  </div>
                </section>
              )}

              {(scope === "all" || scope === "projects") && results.memories.length > 0 && (
                <section className="space-y-2" data-testid="search-section-memories">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
                    Memories ({results.counts.memories})
                  </h2>
                  <div className="space-y-1.5">
                    {results.memories.map((hit) => (
                      <MemoryHitRow key={hit.id} hit={hit} query={trimmed} />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
