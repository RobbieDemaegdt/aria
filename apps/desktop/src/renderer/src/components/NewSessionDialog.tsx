import type { TaskLocation, TaskMode } from "@aria/protocol";
import { FileText, Paperclip, Plus, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { selectAgents, useHasTracker, useAria, useTracker } from "../store";
import { trackerLabel, trackerTaskRefPlaceholder } from "../tracker";
import { AgentSelectOptions } from "./AgentOptions";

/** Start a task yourself (PLAN.md §5.2 "+ New session"): it skips ARIA but reports back into the chat. */
export function NewSessionDialog() {
  const dialog = useAria((s) => s.newSession);
  const projects = useAria((s) => s.projects);
  const profiles = useAria((s) => s.profiles);
  const agents = useAria(selectAgents);
  const tracker = useTracker();
  const hasTracker = useHasTracker();
  const refreshingIntegrations = useAria((s) => s.integrations.refreshing);
  const refreshIntegrations = useAria((s) => s.refreshIntegrations);
  const tasks = useAria((s) => s.tasks);
  const close = useAria((s) => s.closeNewSession);
  const startTask = useAria((s) => s.startTask);
  const openTask = useAria((s) => s.openTask);
  const actionError = useAria((s) => s.actionError);
  const visible = projects
    .filter((p) => !p.hidden)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const fallbackProfile = profiles.find((p) => p.isDefault) ?? profiles[0];
  const sourceTask = dialog?.rerunTaskId ? tasks.find((t) => t.id === dialog.rerunTaskId) : undefined;
  const [projectId, setProjectId] = useState<number | "">(() =>
    sourceTask ? sourceTask.repoId : (dialog?.projectId !== undefined ? dialog.projectId : (visible[0]?.id ?? 0))
  );
  const [brief, setBrief] = useState(() => sourceTask?.brief ?? "");
  const [title, setTitle] = useState(() => sourceTask?.title ?? "");
  const [profileId, setProfileId] = useState(() => {
    if (sourceTask) {
      const matched = profiles.find((p) => p.id === sourceTask.profileId) ?? fallbackProfile;
      return matched?.id ?? "";
    }
    return fallbackProfile?.id ?? "";
  });
  const [agent, setAgent] = useState(() => {
    if (sourceTask) return dialog?.agent ?? sourceTask.agent ?? fallbackProfile?.agent ?? "";
    return dialog?.agent ?? fallbackProfile?.agent ?? "";
  });
  const [agentTouched, setAgentTouched] = useState(() => Boolean(dialog?.agent || sourceTask?.agent));
  const [agentFilter, setAgentFilter] = useState("");
  const [mode, setMode] = useState<TaskMode>(() => {
    if (sourceTask) return sourceTask.mode;
    const initialProjectId = dialog?.projectId !== undefined ? dialog.projectId : (visible[0]?.id ?? 0);
    return initialProjectId === 0 ? "interactive" : (fallbackProfile?.mode ?? "autopilot");
  });
  const [base, setBase] = useState(() => sourceTask?.baseBranch ?? "");
  const [trackerTask, setTrackerTask] = useState(() => sourceTask?.trackerTaskId ?? "");
  const [where, setWhere] = useState<TaskLocation>(() => sourceTask?.where ?? "local");
  const [remote, setRemote] = useState(() => Boolean(sourceTask?.remote));
  const [busy, setBusy] = useState(false);
  const [extraContext, setExtraContext] = useState(() => sourceTask?.extraContext ?? dialog?.extraContext ?? "");
  const [files, setFiles] = useState<string[]>(() => (sourceTask?.files ? [...sourceTask.files] : (dialog?.files ? [...dialog.files] : [])));
  const [manualFile, setManualFile] = useState("");
  const element = useRef<HTMLDialogElement>(null);
  const briefInput = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!dialog) return;
    setAgentFilter("");
    setManualFile("");
    if (sourceTask) {
      setProjectId(sourceTask.repoId);
      setBrief(sourceTask.brief);
      setTitle(sourceTask.title);
      const matchedProfile = profiles.find((p) => p.id === sourceTask.profileId) ?? fallbackProfile;
      setProfileId(matchedProfile?.id ?? "");
      setAgent(dialog.agent ?? sourceTask.agent ?? matchedProfile?.agent ?? "");
      setAgentTouched(Boolean(dialog.agent || sourceTask.agent));
      setMode(sourceTask.mode);
      setBase(sourceTask.baseBranch ?? "");
      setTrackerTask(sourceTask.trackerTaskId ?? "");
      setWhere(sourceTask.where ?? "local");
      setRemote(Boolean(sourceTask.remote));
      setExtraContext(sourceTask.extraContext ?? "");
      setFiles(sourceTask.files ? [...sourceTask.files] : []);
    } else {
      const initialProjectId = dialog.projectId !== undefined ? dialog.projectId : (visible[0]?.id ?? 0);
      setProjectId(initialProjectId);
      setBrief("");
      setTitle("");
      setProfileId(fallbackProfile?.id ?? "");
      setAgent(dialog.agent ?? fallbackProfile?.agent ?? "");
      setAgentTouched(Boolean(dialog.agent));
      setMode(initialProjectId === 0 ? "interactive" : (fallbackProfile?.mode ?? "autopilot"));
      setBase("");
      setTrackerTask("");
      setWhere("local");
      setRemote(false);
      setExtraContext(dialog.extraContext ?? "");
      setFiles(dialog.files ? [...dialog.files] : []);
    }
    // Modal: the rest of the window is inert, so Tab stays in the dialog, and Escape cancels it.
    if (element.current && !element.current.open) element.current.showModal();
    briefInput.current?.focus();
    // Only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog]);

  if (!dialog) return null;
  const isChat = projectId === 0;
  const project = isChat ? undefined : visible.find((p) => p.id === projectId);
  const isFolder = Boolean(project?.kind === "folder");
  const isNonGit = isChat || isFolder;
  const canRunInCloud = Boolean(!isNonGit && project?.owner && project?.repo && (!project.host || project.host === "github.com"));
  const effectiveWhere: TaskLocation = where === "cloud" && canRunInCloud ? "cloud" : "local";
  const profile = profiles.find((p) => p.id === profileId);
  const invocableAgents = agents.filter((a) => a.userInvocable !== false);
  const selectedAgent = invocableAgents.find((a) => a.id === agent || a.name === agent);
  const field = "w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-sm outline-none focus:border-accent";

  const handlePickFiles = async () => {
    if (typeof window !== "undefined" && window.aria?.pickFiles) {
      try {
        const picked = await window.aria.pickFiles();
        if (picked && picked.length > 0) {
          setFiles((prev) => [...new Set([...prev, ...picked])]);
          return;
        }
      } catch {
        // Fall back to hidden file input
      }
    }
    fileInputRef.current?.click();
  };

  const addManualFile = () => {
    const trimmed = manualFile.trim();
    if (!trimmed) return;
    setFiles((prev) => [...new Set([...prev, trimmed])]);
    setManualFile("");
  };

  return (
    <dialog
      ref={element}
      data-testid="new-session"
      aria-labelledby="new-session-heading"
      className="m-auto max-h-[92vh] max-w-[92vw] overflow-auto border-0 bg-transparent p-0 text-fg backdrop:bg-black/50"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClose={() => {
        if (useAria.getState().newSession) close();
      }}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <form
        className="w-[34rem] max-w-full space-y-3 rounded-lg border border-line bg-panel p-4 shadow-xl"
        onSubmit={async (e) => {
          e.preventDefault();
          if ((!isChat && !project) || !brief.trim()) return;
          setBusy(true);
          const task = await startTask({
            repoId: isChat ? 0 : project!.id,
            brief: brief.trim(),
            ...(title.trim() ? { title: title.trim() } : {}),
            ...(profileId ? { profileId } : {}),
            ...(agent.trim() ? { agent: agent.trim() } : {}),
            mode,
            ...(!isNonGit && base.trim() ? { baseBranch: base.trim() } : {}),
            ...(hasTracker && trackerTask.trim() ? { trackerTaskId: trackerTask.trim() } : {}),
            ...(sourceTask ? { rerunOf: sourceTask.id } : {}),
            where: effectiveWhere,
            ...(effectiveWhere === "local" && remote ? { remote: true } : {}),
            ...(extraContext.trim() ? { extraContext: extraContext.trim() } : {}),
            ...(files.length > 0 ? { files } : {}),
          });
          setBusy(false);
          if (task) {
            close();
            openTask(task.id);
          }
        }}
      >
        <div id="new-session-heading" data-testid="new-session-heading" className="text-base font-semibold">
          {sourceTask ? `Rerun “${sourceTask.title}”` : isChat ? "New chat" : "New session"}
        </div>
        {sourceTask && (
          <div className="rounded-md border border-accent/30 bg-accent/5 px-3 py-1.5 text-xs text-muted" data-testid="new-session-rerun-note">
            Starts a fresh worktree off the same base commit so you can compare results side by side with another profile or prompt.
          </div>
        )}
        <label className="block space-y-1">
          <span className="text-xs text-muted">Project</span>
          <select
            data-testid="new-session-project"
            className={`${field} disabled:opacity-60`}
            disabled={Boolean(sourceTask)}
            value={projectId}
            onChange={(e) => {
              const nextId = Number(e.target.value);
              setProjectId(nextId);
              if (nextId === 0) setMode("interactive");
            }}
          >
            {visible.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}{p.kind === "folder" ? " (folder)" : ""}
              </option>
            ))}
            <option value={0}>Chats (general questions)</option>
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-muted">{isChat ? "Question or topic" : "What should it do?"}</span>
          <textarea
            ref={briefInput}
            data-testid="new-session-brief"
            rows={5}
            className={`${field} resize-y`}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder={
              isChat
                ? "Ask a general question, brainstorm an approach, or draft notes in a dedicated chat thread…"
                : "Add a dark mode toggle to the settings page. Run the tests before finishing."
            }
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-muted">Extra context (optional)</span>
          <textarea
            data-testid="new-session-extra-context"
            rows={3}
            className={`${field} resize-y text-xs`}
            value={extraContext}
            onChange={(e) => setExtraContext(e.target.value)}
            placeholder="Additional background, constraints, API specs, logs, or reference notes…"
          />
        </label>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted">Files &amp; context documents (optional)</span>
            <button
              type="button"
              data-testid="new-session-add-files"
              onClick={handlePickFiles}
              className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
            >
              <Paperclip className="h-3 w-3" /> Attach files…
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              data-testid="new-session-hidden-file-input"
              onChange={(e) => {
                if (e.target.files) {
                  const paths = Array.from(e.target.files).map((f) => (f as { path?: string }).path || f.name);
                  setFiles((prev) => [...new Set([...prev, ...paths])]);
                }
              }}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <input
              data-testid="new-session-file-input"
              className={`${field} text-xs py-1`}
              value={manualFile}
              onChange={(e) => setManualFile(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addManualFile();
                }
              }}
              placeholder="Or enter file path (e.g. src/index.ts or C:\data\schema.sql)…"
            />
            <button
              type="button"
              data-testid="new-session-add-file-btn"
              onClick={addManualFile}
              disabled={!manualFile.trim()}
              className="inline-flex items-center gap-0.5 rounded border border-line px-2 py-1 text-xs text-muted hover:text-fg disabled:opacity-40 shrink-0"
            >
              <Plus className="h-3 w-3" /> Add
            </button>
          </div>
          {files.length > 0 && (
            <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto rounded border border-line bg-canvas p-1.5" data-testid="new-session-file-list">
              {files.map((file, idx) => (
                <span
                  key={`${file}-${idx}`}
                  className="inline-flex items-center gap-1 rounded border border-line bg-panel px-2 py-0.5 text-xs font-mono text-fg"
                  title={file}
                >
                  <FileText className="h-3 w-3 text-muted shrink-0" />
                  <span className="max-w-[200px] truncate">{file.split(/[/\\]/).pop() || file}</span>
                  <button
                    type="button"
                    data-testid={`new-session-remove-file-${idx}`}
                    aria-label={`Remove ${file}`}
                    onClick={() => setFiles(files.filter((_, i) => i !== idx))}
                    className="text-muted hover:text-bad ml-0.5"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="text-xs text-muted">Title (optional)</span>
            <input data-testid="new-session-title" className={field} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="From the first line" maxLength={120} />
          </label>
          {!isNonGit && (
            <label className="block space-y-1">
              <span className="text-xs text-muted">Start from branch</span>
              <input className={field} value={base} onChange={(e) => setBase(e.target.value)} placeholder={project?.defaultBranch ?? "default branch"} />
            </label>
          )}
          <label className="block space-y-1">
            <span className="text-xs text-muted">Profile</span>
            <select
              data-testid="new-session-profile"
              className={field}
              value={profileId}
              onChange={(e) => {
                setProfileId(e.target.value);
                const next = profiles.find((p) => p.id === e.target.value);
                if (next) {
                  setMode(next.mode);
                  if (!agentTouched) setAgent(next.agent ?? "");
                }
              }}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.model}
                  {p.reasoningEffort ? ` · ${p.reasoningEffort}` : ""}
                  {p.agent ? ` · ${p.agent}` : ""}
                  {p.budgetCredits ? ` · pauses at ${p.budgetCredits} credits` : " · no budget"}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted">Mode</span>
            <select data-testid="new-session-mode" className={field} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              <option value="autopilot">Autopilot: works until it's done</option>
              <option value="interactive">Interactive: stops after each reply</option>
              <option value="plan">Plan first: you approve its plan before it starts</option>
            </select>
          </label>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="new-session-agent-select" className="text-xs text-muted">
              Agent (optional)
            </label>
            <div className="flex items-center gap-2 text-xs">
              {invocableAgents.length > 5 && (
                <input
                  type="search"
                  data-testid="new-session-agent-filter"
                  aria-label="Filter agents"
                  value={agentFilter}
                  onChange={(e) => setAgentFilter(e.target.value)}
                  placeholder="Filter agents…"
                  className="w-36 rounded border border-line bg-canvas px-1.5 py-0.5 text-xs outline-none focus:border-accent"
                />
              )}
              {agentTouched && (profile?.agent ?? "") !== agent && (
                <button
                  type="button"
                  data-testid="new-session-agent-reset"
                  onClick={() => {
                    setAgentTouched(false);
                    setAgent(profile?.agent ?? "");
                  }}
                  className="text-accent hover:underline"
                >
                  {profile?.agent ? `Use profile default (${profile.agent})` : "Reset to default"}
                </button>
              )}
              <button
                type="button"
                data-testid="new-session-agent-refresh"
                disabled={refreshingIntegrations}
                onClick={() => void refreshIntegrations()}
                title="Refresh installed plugins and discovered agents"
                className="inline-flex items-center gap-1 text-muted hover:text-fg disabled:opacity-40"
              >
                <RefreshCw className={`h-3 w-3 ${refreshingIntegrations ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>
          </div>
          <select
            id="new-session-agent-select"
            data-testid="new-session-agent"
            className={field}
            value={agent}
            onChange={(e) => {
              setAgentTouched(true);
              setAgent(e.target.value);
            }}
          >
            <AgentSelectOptions agents={invocableAgents} currentAgent={agent} filterQuery={agentFilter} />
          </select>
          {selectedAgent?.description && (
            <span className="block text-xs text-muted" data-testid="new-session-agent-description">
              {selectedAgent.description}
            </span>
          )}
        </div>
        <label className="block space-y-1">
          <span className="text-xs text-muted">Where to run</span>
          <select
            data-testid="new-session-where"
            className={field}
            value={effectiveWhere}
            onChange={(e) => setWhere(e.target.value as TaskLocation)}
          >
            <option value="local">Local worktree (on this PC)</option>
            <option value="cloud" disabled={!canRunInCloud}>
              GitHub Cloud (Mission Control — keeps running when PC sleeps){!canRunInCloud ? " (requires GitHub remote)" : ""}
            </option>
          </select>
        </label>
        {effectiveWhere === "local" && (
          <label className="flex items-center gap-2 text-xs text-fg">
            <input
              type="checkbox"
              data-testid="new-session-remote"
              checked={remote}
              onChange={(e) => setRemote(e.target.checked)}
            />
            Share session to GitHub web & mobile (Mission Control)
          </label>
        )}
        {hasTracker && (
        <label className="block space-y-1">
          <span className="text-xs text-muted">{trackerLabel(tracker)} task (optional)</span>
          <input
            data-testid="new-session-tracker"
            className={field}
            value={trackerTask}
            onChange={(e) => setTrackerTask(e.target.value)}
            placeholder={trackerTaskRefPlaceholder(tracker)}
            maxLength={300}
          />
        </label>
        )}
        {profile?.description && <div className="text-xs text-muted">{profile.description}</div>}
        <div className="text-xs text-muted">
          {isChat
            ? "Runs as an interactive chat session under CHATS in the sidebar so general questions and notes stay organized outside the main ARIA chat."
            : isFolder
              ? "Runs directly in this local folder (non-git folder). What needs your approval, its questions and its plan show up in the chat and in its session."
              : "It runs in its own worktree and branch (in the sandbox when this PC can), commits its work and never pushes. What needs your approval, its questions and its plan show up in the chat and in its session."}
        </div>
        {actionError && <div className="text-xs text-bad">{actionError}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={close} className="rounded-md px-3 py-1.5 text-sm text-muted hover:text-fg">
            Cancel
          </button>
          <button data-testid="new-session-start" type="submit" disabled={busy || (!isChat && !project) || !brief.trim() || profiles.length === 0} className="rounded-md bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40">
            {busy ? "Starting…" : "Start"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
