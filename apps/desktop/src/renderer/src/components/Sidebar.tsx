import type { Project, Task, Watch } from "@aria/protocol";
import {
  Briefcase,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  CircleX,
  Clock,
  Cloud,
  Code,
  ExternalLink,
  Folder,
  FolderPlus,
  Link,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  Plus,
  RefreshCw,
  ScanSearch,
  Search,
  Settings,
  Square,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { expandedByDefault, projectMarks, projectWatches, rows, watchStatus } from "../rows";
import { useAria } from "../store";
import { formatHoursMinutes } from "./Cards";
import { WatchIcon } from "./MyWork";
import { SidebarHelpFooter } from "./Onboarding";
import { byAttention, credits, isActive, modelLabel, needsYou, StateIcon } from "./tasks";
import { openPage } from "../openPage";

function NavButton(props: { icon: LucideIcon; label: string; active?: boolean; disabled?: boolean; title?: string; onClick?: () => void; testId?: string }) {
  const { icon: Icon, label, active, disabled, title, onClick, testId } = props;
  return (
    <button
      data-testid={testId}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
        active ? "bg-raised text-fg" : "text-muted hover:bg-raised hover:text-fg"
      } disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * ARIA, your one conversation (PLAN.md §5.2), with its "needs you" count. Its Inspect button opens the inspector
 * (§5.3) next to the chat; it's always in the tab order and shows on hover or keyboard focus.
 */
function AriaRow() {
  const active = useAria((s) => s.ui.view === "chat");
  const inspecting = useAria((s) => s.inspecting);
  const waiting = useAria((s) => s.tasks.filter(needsYou).length);
  const setView = useAria((s) => s.setView);
  const openInspector = useAria((s) => s.openInspector);
  return (
    <div className={`group flex items-center rounded-md ${active ? "bg-raised text-fg" : "text-muted hover:bg-raised hover:text-fg"}`}>
      <button data-testid="nav-aria" onClick={() => setView("chat")} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm">
        <MessageSquare className="h-4 w-4 shrink-0" />
        <span className="truncate">ARIA</span>
      </button>
      {waiting > 0 && (
        <span data-testid="nav-needs-you" title={`${waiting} need${waiting === 1 ? "s" : ""} you`} className="shrink-0 rounded-full bg-bad/20 px-1.5 text-[11px] text-bad">
          {waiting}
        </span>
      )}
      <button
        data-testid="nav-inspect"
        aria-label="Inspect ARIA"
        title={inspecting ? "Inspect: the inspector is open; this moves the focus into it" : "Inspect: what ARIA was sent with each message, and what it did"}
        onClick={() => {
          setView("chat");
          openInspector();
        }}
        // Not drawn as "on" while the inspector is open: pressing it again doesn't close it, it moves the focus there.
        className={`mx-1 shrink-0 rounded p-0.5 hover:text-fg focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 ${inspecting ? "opacity-100" : "opacity-0"}`}
      >
        <ScanSearch className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * A watch under its project (PLAN.md §5.2): its icon and status as text; a click goes to its newest card, else My work
 * at its item (D39). Open on GitHub and Stop sit beside it (not inside), shown on hover or keyboard focus.
 */
function WatchRow({ watch }: { watch: Watch }) {
  const focusWatch = useAria((s) => s.focusWatch);
  const unwatch = useAria((s) => s.unwatch);
  const status = watchStatus(watch);
  return (
    <div className="group flex items-center rounded hover:bg-raised" data-testid="watch-row" data-watch-id={watch.id} data-tone={watch.tone}>
      <button onClick={() => focusWatch(watch.id)} title={`${watch.title} · ${status}`} className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left text-muted group-hover:text-fg">
        <WatchIcon watch={watch} />
        <span className="max-w-[55%] shrink-0 truncate" data-testid="watch-row-title">
          {watch.title}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted/80" data-testid="watch-row-status">
          · {status}
        </span>
      </button>
      {watch.url && (
        <button
          aria-label={`Open ${watch.title} on GitHub`}
          title="Open on GitHub"
          onClick={() => openPage(watch.url!)}
          data-testid="watch-row-open"
          className="hidden rounded p-0.5 text-muted hover:text-fg group-focus-within:block group-hover:block"
        >
          <ExternalLink className="h-3 w-3" />
        </button>
      )}
      {watch.state === "active" && (
        <button aria-label={`Stop watching ${watch.title}`} title="Stop watching" onClick={() => void unwatch(watch.id)} data-testid="watch-row-stop" className="mr-1 hidden rounded p-0.5 text-muted hover:text-fg group-focus-within:block group-hover:block">
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/**
 * The project menu (right-click, or ⋯): default-branch CI, Open on GitHub, Ask ARIA. A menu for the keyboard too:
 * the focus moves into it, ↑/↓ (Home/End) move between its items, Escape closes it and gives the focus back to ⋯, Tab
 * or a click outside closes it.
 */
function ProjectMenu({ project, ciWatch, close, opener }: { project: Project; ciWatch: Watch | undefined; close: () => void; opener: RefObject<HTMLButtonElement | null> }) {
  const watchDefaultBranch = useAria((s) => s.watchDefaultBranch);
  const unwatch = useAria((s) => s.unwatch);
  const removeProject = useAria((s) => s.removeProject);
  const setPrefill = useAria((s) => s.setPrefill);
  const [error, setError] = useState<string | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const onGitHub = project.host === "github.com" && project.owner && project.repo;
  const item = "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-muted hover:bg-panel hover:text-fg focus:bg-panel focus:text-fg focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";
  const items = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not([disabled])') ?? [])];
  useEffect(() => {
    items()[0]?.focus();
    const outside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !opener.current?.contains(target)) close();
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [close, opener]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number) => {
      e.preventDefault();
      all[(to + all.length) % all.length]?.focus();
    };
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(all.length - 1);
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      opener.current?.focus();
    } else if (e.key === "Tab") close();
  };
  return (
    <div ref={menu} role="menu" aria-label={`${project.name}`} data-testid="project-menu" onKeyDown={onKeyDown} className="mx-2 mb-1 rounded-md border border-line bg-raised p-1 text-xs">
      <button
        role="menuitemcheckbox"
        aria-checked={ciWatch !== undefined}
        data-testid="project-menu-ci"
        disabled={!onGitHub}
        title={onGitHub ? undefined : "This project has no github.com remote"}
        onClick={async () => {
          const failed = ciWatch ? await unwatch(ciWatch.id) : await watchDefaultBranch(project.id);
          setError(failed);
          if (!failed) close();
        }}
        className={item}
      >
        <Check className={`h-3.5 w-3.5 ${ciWatch ? "" : "invisible"}`} />
        Watch default-branch CI{onGitHub ? "" : " (no github.com remote)"}
      </button>
      {onGitHub && (
        <button
          role="menuitem"
          data-testid="project-menu-open"
          onClick={() => {
            openPage(`https://github.com/${project.owner}/${project.repo}`);
            close();
          }}
          className={item}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open on GitHub
        </button>
      )}
      <button
        role="menuitem"
        onClick={() => {
          // `@` is for tasks (PLAN.md §4.5), so a project is named in words.
          setPrefill(`About ${project.name}: `);
          close();
        }}
        className={item}
      >
        <MessageSquare className="h-3.5 w-3.5" />
        Ask ARIA about this project
      </button>
      <button
        role="menuitem"
        data-testid="project-menu-remove"
        onClick={async () => {
          const failed = await removeProject(project.id);
          setError(failed);
          if (!failed) close();
        }}
        className={`${item} hover:text-bad focus:text-bad`}
      >
        <Trash2 className="h-3.5 w-3.5" />
        Remove from projects
      </button>
      {error && <div className="px-2 py-1 text-bad">{error}</div>}
    </div>
  );
}

function SessionMenu({
  task,
  close,
  opener,
}: {
  task: Task;
  close: () => void;
  opener: RefObject<HTMLButtonElement | null>;
}) {
  const cancelTask = useAria((s) => s.cancelTask);
  const discardTask = useAria((s) => s.discardTask);
  const openInEditor = useAria((s) => s.openInEditor);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const item =
    "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-muted hover:bg-panel hover:text-fg focus:bg-panel focus:text-fg focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";
  const items = () => [
    ...(menu.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not([disabled])') ?? []),
  ];

  useEffect(() => {
    items()[0]?.focus();
    const outside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !opener.current?.contains(target)) close();
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [close, opener]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number) => {
      e.preventDefault();
      all[(to + all.length) % all.length]?.focus();
    };
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(all.length - 1);
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      opener.current?.focus();
    } else if (e.key === "Tab") close();
  };

  const active = isActive(task) || task.state === "queued";

  return (
    <div
      ref={menu}
      role="menu"
      aria-label={`${task.title}`}
      data-testid="session-menu"
      onKeyDown={onKeyDown}
      className="my-1 rounded-md border border-line bg-raised p-1 text-xs"
    >
      {active && (
        <button
          role="menuitem"
          data-testid="session-menu-stop"
          onClick={async () => {
            await cancelTask(task.id);
            close();
          }}
          className={item}
        >
          <Square className="h-3.5 w-3.5" />
          Stop session
        </button>
      )}
      {task.worktreePath && (
        <button
          role="menuitem"
          data-testid="session-menu-editor"
          onClick={async () => {
            await openInEditor(task.id);
            close();
          }}
          className={item}
        >
          <Code className="h-3.5 w-3.5" />
          Open in VS Code
        </button>
      )}
      {task.pr && (
        <button
          role="menuitem"
          data-testid="session-menu-pr"
          onClick={() => {
            openPage(task.pr!.url);
            close();
          }}
          className={item}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open PR #{task.pr.number}
        </button>
      )}
      {(task.where === "cloud" || task.remote) && task.missionControlUrl && (
        <button
          role="menuitem"
          data-testid="session-menu-mission-control"
          onClick={() => {
            openPage(task.missionControlUrl!);
            close();
          }}
          className={item}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open on Mission Control
        </button>
      )}
      {!confirmDelete ? (
        <button
          role="menuitem"
          data-testid="session-menu-delete"
          onClick={() => setConfirmDelete(true)}
          className={`${item} hover:text-bad focus:text-bad`}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete session…
        </button>
      ) : (
        <div className="space-y-1">
          <button
            role="menuitem"
            data-testid="session-menu-delete-confirm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const ok = await discardTask(task.id);
              if (ok) {
                close();
              } else {
                setBusy(false);
                setError("Failed to delete session");
              }
            }}
            className={`${item} bg-bad/10 text-bad hover:bg-bad/20 hover:text-bad focus:text-bad font-medium`}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {busy ? "Deleting…" : task.where === "cloud" ? "Delete cloud session" : "Delete worktree & branch"}
          </button>
          {!busy && (
            <button
              role="menuitem"
              data-testid="session-menu-delete-cancel"
              onClick={() => setConfirmDelete(false)}
              className={item}
            >
              Cancel
            </button>
          )}
        </div>
      )}
      {error && <div className="px-2 py-1 text-bad">{error}</div>}
    </div>
  );
}

function SessionRow({ task, testId = "session" }: { task: Task; testId?: string }) {
  const openTaskId = useAria((s) => s.openTaskId);
  const openTask = useAria((s) => s.openTask);
  const [menu, setMenu] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenu(false), []);
  const active = openTaskId === task.id;

  return (
    <div>
      <div
        className={`group flex items-center rounded ${active ? "bg-raised" : "hover:bg-raised"}`}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu(true);
        }}
      >
        <button
          data-testid={testId}
          data-state={task.state}
          onClick={() => openTask(task.id)}
          title={`${task.profileName} · ${modelLabel(task)} · ${credits(task.costCredits)}`}
          className={`flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left ${
            active ? "text-fg" : "text-muted group-hover:text-fg"
          }`}
        >
          <StateIcon state={task.state} />
          <span className="min-w-0 flex-1 truncate">{task.title}</span>
          {task.where === "cloud" && (
            <span
              data-testid="session-cloud-badge"
              className="inline-flex shrink-0 items-center gap-0.5 rounded bg-accent/15 px-1 py-px text-[10px] font-medium text-accent"
              title="Runs in the cloud on GitHub Mission Control"
            >
              <Cloud className="h-2.5 w-2.5 shrink-0" />
              Cloud
            </span>
          )}
          {task.where !== "cloud" && task.remote && (
            <span
              data-testid="session-remote-badge"
              className="inline-flex shrink-0 items-center rounded bg-raised px-1 py-px text-[10px] font-medium text-muted"
              title="Shared to GitHub web & mobile via Mission Control"
            >
              Remote
            </span>
          )}
        </button>
        <button
          ref={menuButton}
          title={`More for ${task.title}`}
          aria-label={`More for ${task.title}`}
          aria-haspopup="menu"
          aria-expanded={menu}
          data-testid={`${testId}-menu-button`}
          onClick={(e) => {
            e.stopPropagation();
            setMenu(!menu);
          }}
          className="mr-1 hidden rounded p-0.5 text-muted hover:text-fg group-focus-within:block group-hover:block"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>
      {menu && <SessionMenu task={task} close={closeMenu} opener={menuButton} />}
    </div>
  );
}

function ProjectRow({ project }: { project: Project }) {
  const allTasks = useAria((s) => s.tasks);
  const allWatches = useAria((s) => s.watches);
  const setPrefill = useAria((s) => s.setPrefill);
  const openNewSession = useAria((s) => s.openNewSession);
  const now = Date.now();
  const tasks = allTasks.filter((t) => t.repoId === project.id).sort(byAttention);
  const watches = projectWatches(allWatches, project.id, now);
  const [open, setOpen] = useState<boolean | null>(null);
  const [showOlder, setShowOlder] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenu(false), []);
  // Projects with sessions or active watches are expanded until you collapse them.
  const expanded = open ?? expandedByDefault(tasks, watches);
  const marks = projectMarks(tasks, watches, needsYou, isActive);
  const recentTasks = tasks.filter((t) => !["done", "failed", "cancelled"].includes(t.state) || now - (t.finishedAt ?? t.updatedAt) < 3 * 86_400_000);
  const activeWatches = watches.filter((w) => w.state === "active");
  const older = tasks.length - recentTasks.length + (watches.length - activeWatches.length);
  const shown = rows(showOlder ? tasks : recentTasks, showOlder ? watches : activeWatches);
  const ciWatch = activeWatches.find((w) => w.kind === "branch" && w.until === "forever");
  const remote =
    project.kind === "folder"
      ? "local folder (non-git)"
      : project.owner && project.repo
        ? `${project.owner}/${project.repo}`
        : "no GitHub remote";
  return (
    <div data-testid="project" data-project={project.name}>
      <div
        className="group flex items-center rounded-md hover:bg-raised"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu(true);
        }}
      >
        <button
          onClick={() => setOpen(!expanded)}
          aria-expanded={expanded}
          title={`${project.path}\n${remote}${project.defaultBranch ? ` · ${project.defaultBranch}` : ""}`}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left text-sm text-muted group-hover:text-fg"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
          <Folder className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{project.name}</span>
          {marks.needsYou && <span className="ml-1 h-1.5 w-1.5 shrink-0 rounded-full bg-bad" aria-label="needs you" data-testid="project-needs-you" />}
          {/* A red watch isn't "needs you" (D36): a quiet ✗ when the project is collapsed, and its row when it isn't. */}
          {!expanded && marks.red && <CircleX className="ml-1 h-3 w-3 shrink-0 text-bad/70" aria-label="CI failing" data-testid="project-ci-red" />}
          {!marks.needsYou && marks.busy && <LoaderCircle className="ml-1 h-3 w-3 shrink-0 animate-spin text-accent" aria-label="running" />}
        </button>
        <button
          title={`New session in ${project.name}`}
          aria-label={`New session in ${project.name}`}
          data-testid="project-new-session"
          onClick={() => openNewSession(project.id)}
          className="hidden rounded p-0.5 text-muted hover:text-fg group-focus-within:block group-hover:block"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          ref={menuButton}
          title={`More for ${project.name}`}
          aria-label={`More for ${project.name}`}
          aria-haspopup="menu"
          aria-expanded={menu}
          data-testid="project-menu-button"
          onClick={() => setMenu(!menu)}
          className="mr-1 hidden rounded p-0.5 text-muted hover:text-fg group-focus-within:block group-hover:block"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>
      {menu && <ProjectMenu project={project} ciWatch={ciWatch} close={closeMenu} opener={menuButton} />}
      {expanded && (
        <div className="mb-1 ml-5 space-y-0.5 text-xs">
          {shown.map((row) =>
            row.kind === "watch" ? (
              <WatchRow key={`w${row.watch.id}`} watch={row.watch} />
            ) : (
              <SessionRow key={row.task.id} task={row.task} testId="session" />
            ),
          )}
          {older > 0 && !showOlder && (
            <button className="px-2 py-0.5 text-muted/80 hover:text-fg" onClick={() => setShowOlder(true)}>
              Show older ({older})
            </button>
          )}
          {tasks.length === 0 && watches.length === 0 && (
            <>
              <div className="px-2 text-muted">{remote}</div>
              <div className="px-2 text-muted/70">No sessions yet</div>
            </>
          )}
          {/* `@` is for tasks (PLAN.md §4.5), so a project is named in words. */}
          <button className="px-2 text-accent hover:underline" onClick={() => setPrefill(`About ${project.name}: `)}>
            Ask ARIA about this project
          </button>
        </div>
      )}
    </div>
  );
}

function ChatsSection() {
  const allTasks = useAria((s) => s.tasks);
  const openNewSession = useAria((s) => s.openNewSession);
  const [showOlder, setShowOlder] = useState(false);
  const now = Date.now();
  const chatTasks = allTasks.filter((t) => t.repoId === 0 || t.kind === "chat").sort(byAttention);
  const recentChats = chatTasks.filter(
    (t) => !["done", "failed", "cancelled"].includes(t.state) || now - (t.finishedAt ?? t.updatedAt) < 7 * 86_400_000,
  );
  const older = chatTasks.length - recentChats.length;
  const shown = showOlder ? chatTasks : recentChats;

  return (
    <div data-testid="chats-section">
      <div className="flex items-center justify-between px-3 pb-1 pt-2 text-[11px] font-semibold tracking-wide text-muted">
        <span>CHATS</span>
        <button
          title="New chat"
          aria-label="New chat"
          data-testid="add-chat"
          onClick={() => openNewSession(0)}
          className="rounded p-0.5 hover:bg-raised hover:text-fg"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="space-y-0.5 px-2 pb-1 text-xs">
        {shown.map((task) => (
          <SessionRow key={task.id} task={task} testId="chat-session" />
        ))}
        {older > 0 && !showOlder && (
          <button className="px-2 py-0.5 text-muted/80 hover:text-fg" onClick={() => setShowOlder(true)}>
            Show older ({older})
          </button>
        )}
        {chatTasks.length === 0 && (
          <div className="px-2 py-0.5 text-muted/70">Generic questions &amp; notes (+ to start)</div>
        )}
      </div>
    </div>
  );
}

export function Sidebar() {
  const ui = useAria((s) => s.ui);
  const projects = useAria((s) => s.projects);
  const projectRoots = useAria((s) => s.projectRoots);
  const todayTime = useAria((s) => s.todayTime);
  const reminders = useAria((s) => s.reminders);
  const setView = useAria((s) => s.setView);
  const openTimeView = useAria((s) => s.openTimeView);
  const openAutomations = useAria((s) => s.openAutomations);
  const openSearch = useAria((s) => s.openSearch);
  const firedReminders = reminders.filter((r) => r.status === "fired").length;
  const rescanProjects = useAria((s) => s.rescanProjects);
  const addProjectFolder = useAria((s) => s.addProjectFolder);
  const addProjectRoot = useAria((s) => s.addProjectRoot);
  const removeProjectRoot = useAria((s) => s.removeProjectRoot);
  const pickProjectRoot = useAria((s) => s.pickProjectRoot);
  const createProject = useAria((s) => s.createProject);
  const cloneProject = useAria((s) => s.cloneProject);
  const openNewSession = useAria((s) => s.openNewSession);
  const myWorkOpen = useAria((s) => s.myWorkOpen);
  const openMyWork = useAria((s) => s.openMyWork);
  const [menu, setMenu] = useState(false);
  const [configureRootsOpen, setConfigureRootsOpen] = useState(false);
  const [rootInput, setRootInput] = useState("");
  const [rootError, setRootError] = useState<string | null>(null);
  const [newRepoName, setNewRepoName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [cloneUrl, setCloneUrl] = useState<string | null>(null);
  const [cloning, setCloning] = useState(false);
  // Projects stay alphabetically ordered (active sessions don't move a project to the top).
  const ranked = projects
    .filter((p) => !p.hidden)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  return (
    <nav className="flex h-full flex-col border-r border-line bg-panel" data-testid="sidebar" hidden={ui.sidebarCollapsed}>
      <div className="space-y-0.5 p-2">
        <NavButton icon={Plus} label="New session" onClick={() => openNewSession()} testId="nav-new-session" />
        <AriaRow />
        {/* No count (D40): My work searches only while it's open. */}
        <NavButton icon={Briefcase} label="My work" active={myWorkOpen} onClick={() => openMyWork()} testId="nav-my-work" />
        <button
          data-testid="nav-automations"
          onClick={() => openAutomations()}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
            ui.view === "automations" ? "bg-raised text-fg" : "text-muted hover:bg-raised hover:text-fg"
          }`}
        >
          <CalendarClock className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Automations</span>
          {firedReminders > 0 && (
            <span
              data-testid="nav-automations-due"
              className="shrink-0 rounded-full bg-bad/20 px-1.5 text-[11px] text-bad"
              title={`${firedReminders} reminder${firedReminders === 1 ? "" : "s"} due`}
            >
              {firedReminders}
            </span>
          )}
        </button>
        <button
          data-testid="nav-time"
          onClick={() => openTimeView()}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
            ui.view === "time" ? "bg-raised text-fg" : "text-muted hover:bg-raised hover:text-fg"
          }`}
        >
          <Clock className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Time</span>
          {todayTime && todayTime.dayTotalMinutes > 0 && (
            <span
              data-testid="nav-time-total"
              className="shrink-0 font-mono text-[11px] text-muted"
              title={`Today: ${formatHoursMinutes(todayTime.dayTotalMinutes)} of ${formatHoursMinutes(todayTime.expectedMinutes)}`}
            >
              {formatHoursMinutes(todayTime.dayTotalMinutes)}
            </span>
          )}
        </button>
        <NavButton icon={Settings} label="Customize" active={ui.view === "customize"} onClick={() => setView("customize")} testId="nav-customize" />
        <NavButton icon={Search} label="Search" active={ui.view === "search"} onClick={() => openSearch()} testId="nav-search" />
      </div>

      <ChatsSection />

      <div className="flex items-center justify-between px-3 pb-1 pt-3 text-[11px] font-semibold tracking-wide text-muted">
        <span>PROJECTS</span>
        <button title="Add project" aria-label="Add project" data-testid="add-project" onClick={() => setMenu(!menu)} className="rounded p-0.5 hover:bg-raised hover:text-fg">
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {menu && (
        <div className="mx-2 mb-2 rounded-md border border-line bg-raised p-1 text-sm">
          {[
            {
              icon: Plus,
              label: "New repository…",
              run: () => {
                setCloneUrl(null);
                setConfigureRootsOpen(false);
                setNewRepoName("");
              },
            },
            { icon: FolderPlus, label: "Local folder or repository…", run: () => void addProjectFolder() },
            {
              icon: Link,
              label: "Repository URL…",
              run: () => {
                setNewRepoName(null);
                setConfigureRootsOpen(false);
                setCloneUrl("");
              },
            },
            {
              icon: Settings,
              label: "Configure project folders…",
              run: () => {
                setNewRepoName(null);
                setCloneUrl(null);
                setRootError(null);
                setConfigureRootsOpen((v) => !v);
              },
            },
            { icon: RefreshCw, label: "Rescan project folder", run: () => void rescanProjects() },
          ].map(({ icon: Icon, label, run }) => (
            <button
              key={label}
              onClick={() => {
                setMenu(false);
                run();
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-muted hover:bg-panel hover:text-fg"
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
      )}

      {configureRootsOpen && (
        <div className="mx-2 mb-2 space-y-2 rounded-md border border-line bg-raised p-2 text-xs" data-testid="sidebar-project-roots">
          <div className="flex items-center justify-between font-medium text-fg">
            <span>Project folders</span>
            <button
              type="button"
              onClick={() => setConfigureRootsOpen(false)}
              className="rounded p-0.5 text-muted hover:text-fg"
              title="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="text-[11px] text-muted">
            ARIA scans these folders for repositories and clones new projects into the first folder.
          </div>
          <div className="space-y-1">
            {projectRoots.length === 0 && (
              <div className="text-muted">No project folder configured yet.</div>
            )}
            {projectRoots.map((root, idx) => (
              <div key={root} className="flex items-center gap-1 rounded border border-line bg-canvas px-1.5 py-1" data-testid="sidebar-project-root-row">
                <Folder className="h-3 w-3 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={root}>
                  {root}
                </span>
                {idx === 0 && (
                  <span className="rounded bg-accent/15 px-1 py-px text-[10px] text-accent">default</span>
                )}
                <button
                  type="button"
                  data-testid="sidebar-project-root-remove"
                  onClick={async () => {
                    const err = await removeProjectRoot(root);
                    setRootError(err);
                  }}
                  className="rounded p-0.5 text-muted hover:text-bad"
                  title="Remove project folder"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
          <form
            className="flex gap-1"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!rootInput.trim()) return;
              const err = await addProjectRoot(rootInput.trim());
              setRootError(err);
              if (!err) setRootInput("");
            }}
          >
            <input
              data-testid="sidebar-project-root-input"
              value={rootInput}
              onChange={(e) => setRootInput(e.target.value)}
              placeholder="C:\Users\...\Repos"
              className="min-w-0 flex-1 rounded border border-line bg-canvas px-1.5 py-1 font-mono text-[11px] outline-none focus:border-accent"
            />
            <button
              type="submit"
              data-testid="sidebar-project-root-add"
              disabled={!rootInput.trim()}
              className="rounded bg-accent px-2 py-1 text-white disabled:opacity-50"
            >
              Add
            </button>
          </form>
          <div className="flex items-center justify-between gap-1">
            <button
              type="button"
              data-testid="sidebar-project-root-browse"
              onClick={async () => {
                const err = await pickProjectRoot();
                setRootError(err);
              }}
              className="inline-flex items-center gap-1 rounded border border-line bg-canvas px-2 py-1 text-muted hover:text-fg"
            >
              <FolderPlus className="h-3 w-3" /> Browse folder…
            </button>
            <button
              type="button"
              onClick={() => void rescanProjects()}
              className="inline-flex items-center gap-1 rounded border border-line bg-canvas px-2 py-1 text-muted hover:text-fg"
            >
              <RefreshCw className="h-3 w-3" /> Rescan
            </button>
          </div>
          {rootError && <div className="text-[11px] text-bad">{rootError}</div>}
        </div>
      )}

      {newRepoName !== null && (
        <form
          className="mx-2 mb-2 space-y-1.5 rounded-md border border-line bg-raised p-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setCreating(true);
            const ok = await createProject({ name: newRepoName });
            setCreating(false);
            if (ok) setNewRepoName(null);
          }}
        >
          <input
            autoFocus
            value={newRepoName}
            onChange={(e) => setNewRepoName(e.target.value)}
            placeholder="owner/repo or repo-name"
            className="w-full rounded border border-line bg-canvas px-2 py-1 text-xs outline-none focus:border-accent"
          />
          <div className="flex justify-end gap-1.5 text-xs">
            <button type="button" onClick={() => setNewRepoName(null)} className="rounded px-2 py-1 text-muted hover:text-fg">
              Cancel
            </button>
            <button type="submit" disabled={creating || !newRepoName.trim()} className="rounded bg-accent px-2 py-1 text-white disabled:opacity-50">
              {creating ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      )}

      {cloneUrl !== null && (
        <form
          className="mx-2 mb-2 space-y-1.5 rounded-md border border-line bg-raised p-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setCloning(true);
            const ok = await cloneProject(cloneUrl);
            setCloning(false);
            if (ok) setCloneUrl(null);
          }}
        >
          <input
            autoFocus
            value={cloneUrl}
            onChange={(e) => setCloneUrl(e.target.value)}
            placeholder="https://github.com/owner/repo"
            className="w-full rounded border border-line bg-canvas px-2 py-1 text-xs outline-none focus:border-accent"
          />
          <div className="flex justify-end gap-1.5 text-xs">
            <button type="button" onClick={() => setCloneUrl(null)} className="rounded px-2 py-1 text-muted hover:text-fg">
              Cancel
            </button>
            <button type="submit" disabled={cloning || !cloneUrl.trim()} className="rounded bg-accent px-2 py-1 text-white disabled:opacity-50">
              {cloning ? "Cloning…" : "Clone"}
            </button>
          </div>
        </form>
      )}

      <div className="flex-1 overflow-y-auto px-1 pb-2" data-testid="projects">
        {ranked.map((p) => (
          <ProjectRow key={p.id} project={p} />
        ))}
        {ranked.length === 0 && <div className="px-3 py-2 text-xs text-muted">No projects yet. Add one with +.</div>}
      </div>
      <SidebarHelpFooter />
    </nav>
  );
}
