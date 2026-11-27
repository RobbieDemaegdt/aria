/**
 * My work (PLAN.md §5.2, D38–D40), in the session pane beside the chat: on your projects only, the pull requests
 * waiting for your review, your own, what's assigned to you, your inbox, and every watch. It searches when it opens,
 * every 10 minutes while it's open and the window is visible, and on Refresh (the engine waits a minute between
 * searches). Everything from GitHub is plain text; every link is ARIA's own (github.com).
 */
import type { InboxItem, MyWorkItem, MyWorkOutlookMessage, MyWorkReason, MyWorkTrackerTask, Watch } from "@aria/protocol";
import { Briefcase, CircleCheck, CircleDot, CircleX, ExternalLink, Eye, GitPullRequest, Hourglass, Mail, Pause, RefreshCw, Square, X } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { accessText, canRetry } from "../github";
import { itemOfWatch, MY_WORK_SECTIONS, reconcileByKey, reconcileSectionGroups, WATCH_ICON, watchStatus } from "../rows";
import { useHasTracker, useAria, useTracker } from "../store";
import { openPage } from "../openPage";
import { askAboutTaskPrefill, trackerLabel } from "../tracker";

const REFRESH_EVERY_MS = 10 * 60_000;
const COOLDOWN_MS = 60_000;
const ago = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s ago` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min ago` : `${Math.round(ms / 3_600_000)} h ago`);
const at = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const MORE_PAGES = { review_requested: "https://github.com/pulls/review-requested", authored: "https://github.com/pulls", assigned: "https://github.com/issues/assigned" } as const;

export function WatchIcon({ watch, className = "h-3.5 w-3.5" }: { watch: Pick<Watch, "tone">; className?: string }) {
  const kind = WATCH_ICON[watch.tone];
  if (kind === "ok") return <CircleCheck className={`${className} shrink-0 text-ok`} aria-label="passing" />;
  if (kind === "bad") return <CircleX className={`${className} shrink-0 text-bad`} aria-label="failing" />;
  if (kind === "paused") return <Pause className={`${className} shrink-0 text-warn`} aria-label="paused" />;
  if (kind === "ended") return <Square className={`${className} shrink-0 text-muted`} aria-label="ended" />;
  return <Hourglass className={`${className} shrink-0 text-accent`} aria-label="watching" />;
}

const Item = memo(function Item({ item, watch, focused }: { item: MyWorkItem; watch: Watch | undefined; focused: boolean }) {
  const watchPullRequest = useAria((s) => s.watchPullRequest);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    if (pending) return;
    setPending(true);
    setError(await watchPullRequest(item.key));
    setPending(false);
  };
  return (
    <li data-testid="my-work-item" data-key={item.key} data-watch-id={item.watchId} className={`group rounded px-2 py-1 ${focused ? "bg-accent/10" : "hover:bg-raised"}`}>
      <div className="flex items-center gap-1.5">
        {item.kind === "pr" ? <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-muted" aria-label="pull request" /> : <CircleDot className="h-3.5 w-3.5 shrink-0 text-muted" aria-label="issue" />}
        <span className="min-w-0 flex-1 truncate" data-testid="my-work-title">
          {item.title}
        </span>
        <span className="shrink-0 text-muted">#{item.number}</span>
        <button aria-label={`Open #${item.number} on GitHub`} title="Open on GitHub" onClick={() => openPage(item.url)} data-testid="my-work-open" className="shrink-0 rounded p-0.5 text-muted hover:text-fg">
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 pl-5 text-muted">
        {item.author && <span>@{item.author}</span>}
        {item.draft && <span className="rounded border border-line px-1 text-[10px]">draft</span>}
        {item.kind === "pr" && item.why.includes("authored") && (
          <>
            {watch ? (
              <span className="flex items-center gap-1" data-testid="my-work-watch" data-tone={watch.tone}>
                <WatchIcon watch={watch} className="h-3 w-3" />
                {watchStatus(watch)}
              </span>
            ) : (
              <button data-testid="my-work-watch-pr" disabled={pending} onClick={() => void start()} className="flex items-center gap-1 text-accent hover:underline disabled:opacity-50">
                <Eye className="h-3 w-3" />
                {pending ? "Starting…" : "Watch"}
              </button>
            )}
          </>
        )}
      </div>
      {error && <div className="pl-5 text-bad">{error}</div>}
    </li>
  );
});

const sameInboxItem = (a: InboxItem, b: InboxItem) =>
  a.id === b.id && a.reason === b.reason && a.type === b.type && a.title === b.title && a.repo === b.repo && a.number === b.number && a.url === b.url && a.updatedAt === b.updatedAt;

const sameWatch = (a: Watch, b: Watch) =>
  a.id === b.id && a.state === b.state && a.tone === b.tone && a.status === b.status && a.paused === b.paused && a.title === b.title && a.repoName === b.repoName && a.url === b.url;

const sameTrackerTask = (a: MyWorkTrackerTask, b: MyWorkTrackerTask) =>
  a.taskId === b.taskId &&
  a.title === b.title &&
  a.status === b.status &&
  a.priority === b.priority &&
  a.taskType === b.taskType &&
  a.projectId === b.projectId &&
  a.projectName === b.projectName &&
  a.customerId === b.customerId &&
  a.customerName === b.customerName &&
  a.dueDate === b.dueDate &&
  a.comment === b.comment &&
  a.url === b.url;

const sameOutlookMessage = (a: MyWorkOutlookMessage, b: MyWorkOutlookMessage) =>
  a.messageId === b.messageId &&
  a.subject === b.subject &&
  a.fromName === b.fromName &&
  a.fromAddress === b.fromAddress &&
  a.receivedAt === b.receivedAt &&
  a.urgency === b.urgency &&
  a.reason === b.reason &&
  a.preview === b.preview &&
  a.trackerTaskId === b.trackerTaskId &&
  a.webLink === b.webLink;

export function MyWork() {
  const myWork = useAria((s) => s.myWork);
  const github = useAria((s) => s.github);
  const watches = useAria((s) => s.watches);
  const projects = useAria((s) => s.projects);
  const focus = useAria((s) => s.myWorkFocus);
  const load = useAria((s) => s.loadMyWork);
  const close = useAria((s) => s.closeTask);
  const unwatch = useAria((s) => s.unwatch);
  const retry = useAria((s) => s.retryGitHub);
  const setPrefill = useAria((s) => s.setPrefill);
  const trackerInfo = useTracker();
  const hasTracker = useHasTracker();
  const trackerName = trackerLabel(trackerInfo);
  const [now, setNow] = useState(Date.now());
  const root = useRef<HTMLDivElement>(null);

  // Searches when it opens, every 10 minutes while it's open and visible (D40), and when it's shown again after that.
  useEffect(() => {
    void load(true);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, REFRESH_EVERY_MS);
    const visible = () => {
      const currentMyWork = useAria.getState().myWork;
      const checked = currentMyWork.checkedAt ?? currentMyWork.tracker?.checkedAt;
      if (document.visibilityState === "visible" && (checked === undefined || Date.now() - checked >= REFRESH_EVERY_MS)) void load(true);
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [load]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);
  // A watch row's click with no card: its item comes into view.
  useEffect(() => {
    if (!focus) return;
    const element = root.current?.querySelector(`[data-watch-id="${focus.watchId}"]`);
    element?.scrollIntoView({ block: "center" });
  }, [focus, myWork.items]);

  const activeRaw = watches.filter((w) => w.state === "active");
  const githubProjects = projects.filter((p) => !p.hidden && p.host === "github.com" && p.owner && p.repo);
  const yours = useMemo(() => new Set(githubProjects.flatMap((p) => [`${p.owner}/${p.repo}`.toLowerCase(), ...(p.upstream ? [p.upstream.toLowerCase()] : [])])), [githubProjects]);
  const inbox = activeRaw.find((w) => w.kind === "inbox");
  const inboxItemsRaw = (inbox?.inbox ?? []).filter((i) => yours.has(i.repo.toLowerCase()));
  const inboxOthers = (inbox?.inbox?.length ?? 0) - inboxItemsRaw.length;
  const tracker = myWork.tracker;
  const outlook = myWork.outlook;

  const sectionGroupsRef = useRef<Record<MyWorkReason, Array<{ repoId: number; repoName: string; items: MyWorkItem[] }>>>({
    review_requested: [],
    authored: [],
    assigned: [],
  });
  const inboxItemsRef = useRef<InboxItem[]>([]);
  const activeWatchesRef = useRef<Watch[]>([]);
  const trackerTasksRef = useRef<MyWorkTrackerTask[]>([]);
  const outlookMessagesRef = useRef<MyWorkOutlookMessage[]>([]);

  const reconciledSections = useMemo(() => {
    const next = {} as Record<MyWorkReason, Array<{ repoId: number; repoName: string; items: MyWorkItem[] }>>;
    for (const { reason } of MY_WORK_SECTIONS) {
      next[reason] = reconcileSectionGroups(sectionGroupsRef.current[reason], myWork.items, reason);
    }
    sectionGroupsRef.current = next;
    return next;
  }, [myWork.items]);

  const inboxItems = useMemo(() => {
    const next = reconcileByKey(inboxItemsRef.current, inboxItemsRaw, (i) => i.id, sameInboxItem);
    inboxItemsRef.current = next;
    return next;
  }, [inboxItemsRaw]);

  const active = useMemo(() => {
    const next = reconcileByKey(activeWatchesRef.current, activeRaw, (w) => w.id, sameWatch);
    activeWatchesRef.current = next;
    return next;
  }, [activeRaw]);

  const trackerTasks = useMemo(() => {
    const next = reconcileByKey(trackerTasksRef.current, tracker?.tasks ?? [], (t) => t.taskId, sameTrackerTask);
    trackerTasksRef.current = next;
    return next;
  }, [tracker?.tasks]);

  const outlookMessages = useMemo(() => {
    const next = reconcileByKey(outlookMessagesRef.current, outlook?.messages ?? [], (m) => m.messageId, sameOutlookMessage);
    outlookMessagesRef.current = next;
    return next;
  }, [outlook?.messages]);
  const isLoading = myWork.status === "loading" || tracker?.status === "loading" || outlook?.status === "loading";
  const lastCheckedAt =
    myWork.checkedAt !== undefined && tracker?.checkedAt !== undefined
      ? Math.max(myWork.checkedAt, tracker.checkedAt)
      : (myWork.checkedAt ?? tracker?.checkedAt ?? outlook?.checkedAt);
  const needsExtraRefresh =
    (tracker !== undefined && tracker.status !== "off" && (tracker.checkedAt === undefined || tracker.status !== "ok")) ||
    (outlook !== undefined && outlook.status !== "off" && (outlook.checkedAt === undefined || outlook.status !== "ok"));
  const cooling = !needsExtraRefresh && lastCheckedAt !== undefined && now - lastCheckedAt < COOLDOWN_MS;
  const partial = myWork.partial;
  const accessProblem = github.status !== "ok" && github.status !== "starting";
  const focusedWatch = focus?.watchId;

  return (
    <div ref={root} className="flex h-full flex-col bg-canvas text-xs" data-testid="my-work">
      <header className="space-y-1 border-b border-line px-3 py-2">
        <div className="flex items-center gap-2 text-sm">
          <Briefcase className="h-4 w-4 shrink-0 text-muted" />
          <div className="min-w-0 flex-1 truncate font-semibold">My work</div>
          <button
            data-testid="my-work-refresh"
            disabled={cooling || isLoading}
            onClick={() => void load(true)}
            title={cooling ? "GitHub was searched less than a minute ago" : "Search GitHub again"}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted hover:bg-raised hover:text-fg disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <button data-testid="my-work-close" aria-label="Close My work" title="Close (Esc)" onClick={close} className="rounded p-1 text-muted hover:bg-raised hover:text-fg">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="text-muted" data-testid="my-work-searched">
          {myWork.login ? `Searched as @${myWork.login}` : "Not searched yet"}
          {myWork.checkedAt !== undefined ? ` · checked ${ago(now - myWork.checkedAt)}` : ""}
          {" · your projects only"}
        </div>
        {accessProblem && (
          <div className="flex items-center gap-2 text-warn" data-testid="my-work-access">
            <span className="min-w-0 flex-1">{accessText(github)}</span>
            {canRetry(github.status) && (
              <button onClick={() => void retry()} className="shrink-0 rounded border border-line px-1.5 text-muted hover:text-fg">
                Try again
              </button>
            )}
          </div>
        )}
        {(myWork.status === "waiting" || myWork.status === "error") && myWork.message && !accessProblem && (
          <div className="text-warn" data-testid="my-work-message">
            {myWork.message}
            {myWork.until ? ` (until ${at(myWork.until)})` : ""}
          </div>
        )}
        {partial && (
          <div className="space-y-0.5 text-warn" data-testid="my-work-partial">
            {partial.sso && <div>GitHub left out an organisation's repositories: authorize GitHub CLI's token for its single sign-on to see them.</div>}
            {partial.incomplete && <div>GitHub's search didn't finish in time: some items may be missing.</div>}
            {partial.unsearched ? <div>{partial.unsearched} of your repositories weren't searched (too many for one refresh).</div> : null}
            {partial.failed ? <div>{partial.failed === 1 ? "A search" : `${partial.failed} searches`} failed this time: their last answers are shown.</div> : null}
            {partial.unsearchable?.length ? <div>GitHub can't search {partial.unsearchable.join(", ")} (gone, renamed, or not visible to this account): left out for an hour.</div> : null}
          </div>
        )}
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-3 py-3">
        {MY_WORK_SECTIONS.map(({ reason, title }) => {
          const groups = reconciledSections[reason];
          const more = myWork.more[reason];
          const hasSearchedOnce = myWork.checkedAt !== undefined;
          return (
            <section key={reason} data-testid={`my-work-${reason}`}>
              <h3 className="mb-1 font-semibold text-muted">{title}</h3>
              {groups.length === 0 && (
                <div className="px-2 text-muted/80">
                  {myWork.status === "ok" || (myWork.status === "loading" && hasSearchedOnce)
                    ? partial
                      ? "None found (the list may lack items: see above)."
                      : "None found."
                    : myWork.status === "loading"
                      ? "Searching…"
                      : "Not searched yet."}
                </div>
              )}
              {groups.map((group) => (
                <div key={group.repoId} className="mb-1">
                  <div className="px-2 text-[11px] font-medium text-muted">{group.repoName}</div>
                  <ul>
                    {group.items.map((item) => {
                      const watch = item.watchId !== undefined ? active.find((w) => w.id === item.watchId) : undefined;
                      return <Item key={item.key} item={item} watch={watch} focused={focusedWatch !== undefined && item.watchId === focusedWatch} />;
                    })}
                  </ul>
                </div>
              ))}
              {more > 0 && (
                <button onClick={() => openPage(MORE_PAGES[reason])} className="px-2 text-accent hover:underline" data-testid="my-work-more">
                  and {more} more on GitHub
                </button>
              )}
            </section>
          );
        })}

        <section data-testid="my-work-inbox">
          <h3 className="mb-1 font-semibold text-muted">Inbox</h3>
          {!inbox && <div className="px-2 text-muted/80">Your GitHub inbox isn't watched (Customize › Notifications).</div>}
          {inbox && inboxItems.length === 0 && <div className="px-2 text-muted/80">Nothing unread on your projects.</div>}
          <ul>
            {inboxItems.map((item) => (
              <li key={item.id} className="flex items-center gap-1.5 rounded px-2 py-1 hover:bg-raised" data-testid="my-work-inbox-item">
                <span className="shrink-0 text-muted">{item.reason.replace(/_/g, " ")}</span>
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <span className="shrink-0 text-muted">{item.repo}</span>
                <button aria-label="Open on GitHub" title="Open on GitHub" onClick={() => openPage(item.url)} className="shrink-0 rounded p-0.5 text-muted hover:text-fg">
                  <ExternalLink className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
          {inboxOthers > 0 && (
            <button onClick={() => openPage("https://github.com/notifications")} className="px-2 text-accent hover:underline">
              {inboxOthers} more in your GitHub inbox
            </button>
          )}
        </section>

        <section data-testid="my-work-watches">
          <h3 className="mb-1 font-semibold text-muted">Watches</h3>
          {active.length === 0 && <div className="px-2 text-muted/80">Nothing is watched.</div>}
          <ul>
            {active.map((watch) => (
              <li
                key={watch.id}
                data-testid="my-work-watch-line"
                data-watch-id={itemOfWatch(myWork.items, watch) ? undefined : watch.id}
                className={`group flex items-center gap-1.5 rounded px-2 py-1 ${focusedWatch === watch.id ? "bg-accent/10" : "hover:bg-raised"}`}
              >
                <WatchIcon watch={watch} />
                <span className="min-w-0 flex-1 truncate">
                  {watch.kind === "inbox" ? "GitHub inbox" : watch.title}
                  {watch.repoName ? <span className="text-muted"> · {watch.repoName}</span> : null}
                  <span className="text-muted"> · {watchStatus(watch)}</span>
                </span>
                {watch.url && (
                  <button aria-label="Open on GitHub" title="Open on GitHub" onClick={() => openPage(watch.url!)} className="shrink-0 rounded p-0.5 text-muted hover:text-fg">
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                )}
                <button aria-label={`Stop watching ${watch.title}`} title="Stop watching" onClick={() => void unwatch(watch.id)} className="shrink-0 rounded px-1 text-muted hover:text-fg" data-testid="my-work-stop">
                  Stop
                </button>
              </li>
            ))}
          </ul>
        </section>

        {hasTracker && (
        <section data-testid="my-work-tracker">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="font-semibold text-muted">
              {trackerName} tasks
              {trackerTasks.length > 0 ? ` (${trackerTasks.length})` : ""}
            </h3>
            {tracker?.checkedAt !== undefined && (
              <span className="text-[11px] text-muted" data-testid="my-work-tracker-checked">
                checked {ago(now - tracker.checkedAt)}
              </span>
            )}
          </div>
          {(!tracker || (tracker.status === "off" && trackerTasks.length === 0)) && (
            <div className="px-2 text-muted/80" data-testid="my-work-tracker-status-msg">
              {trackerName} isn't connected (Customize › Integrations).
            </div>
          )}
          {tracker?.status === "needs_auth" && (
            <div className="px-2 text-warn" data-testid="my-work-tracker-status-msg">
              {tracker.message ?? `Sign in or add a bearer token for ${tracker.server ?? trackerName} in Customize › Integrations.`}
            </div>
          )}
          {tracker?.status === "error" && tracker.message && (
            <div className="px-2 text-warn" data-testid="my-work-tracker-error">
              {tracker.message}
            </div>
          )}
          {tracker?.status === "loading" && trackerTasks.length === 0 && tracker.checkedAt === undefined && (
            <div className="px-2 text-muted/80" data-testid="my-work-tracker-status-msg">
              Checking {trackerName} tasks…
            </div>
          )}
          {(tracker?.status === "ok" || (tracker?.status === "loading" && tracker.checkedAt !== undefined)) && trackerTasks.length === 0 && (
            <div className="px-2 text-muted/80" data-testid="my-work-tracker-status-msg">
              No open {trackerName} tasks assigned to you.
            </div>
          )}
          {trackerTasks.length > 0 && (
            <ul>
              {trackerTasks.map((task) => (
                <li
                  key={task.taskId}
                  data-testid="my-work-tracker-item"
                  data-task-id={task.taskId}
                  className="group rounded px-2 py-1 hover:bg-raised"
                >
                  <div className="flex items-center gap-1.5">
                    <Briefcase className="h-3.5 w-3.5 shrink-0 text-accent" aria-label={`${trackerName} task`} />
                    <span className="min-w-0 flex-1 truncate font-medium text-fg" data-testid="my-work-tracker-title">
                      {task.title}
                    </span>
                    <span className="shrink-0 font-mono text-muted">#{task.taskId}</span>
                    <button
                      type="button"
                      data-testid="my-work-tracker-ask"
                      aria-label={`Ask ARIA about #${task.taskId}`}
                      title="Ask ARIA about this task"
                      onClick={() => setPrefill(askAboutTaskPrefill(trackerInfo, task.taskId, task.title))}
                      className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent/15 hover:underline"
                    >
                      Ask ARIA
                    </button>
                    <button
                      type="button"
                      data-testid="my-work-tracker-open"
                      aria-label={`Open #${task.taskId} on ${trackerName}`}
                      title={`Open on ${trackerName}`}
                      onClick={() => openPage(task.url)}
                      className="shrink-0 rounded p-0.5 text-muted hover:text-fg"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-5 text-[11px] text-muted">
                    {task.status && (
                      <span
                        className="rounded border border-line bg-panel px-1.5 py-px text-[10px] text-fg"
                        data-testid="my-work-tracker-status"
                      >
                        {task.status}
                      </span>
                    )}
                    {task.priority && <span data-testid="my-work-tracker-priority">{task.priority}</span>}
                    {(task.projectName ?? task.customerName) && (
                      <span className="truncate" data-testid="my-work-tracker-project">
                        {task.projectName ?? task.customerName}
                      </span>
                    )}
                    {task.dueDate && <span data-testid="my-work-tracker-due">due {task.dueDate}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        )}

        <section data-testid="my-work-outlook">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="font-semibold text-muted">
              Outlook emails needing you
              {outlookMessages.length > 0 ? ` (${outlookMessages.length})` : ""}
            </h3>
            {outlook?.checkedAt !== undefined && (
              <span className="text-[11px] text-muted" data-testid="my-work-outlook-checked">
                checked {ago(now - outlook.checkedAt)}
              </span>
            )}
          </div>
          {(!outlook || (outlook.status === "off" && outlookMessages.length === 0)) && (
            <div className="px-2 text-muted/80" data-testid="my-work-outlook-status-msg">
              Work IQ Mail isn't connected or Outlook watching is off (Customize › Integrations / Notifications).
            </div>
          )}
          {outlook?.status === "needs_auth" && (
            <div className="px-2 text-warn" data-testid="my-work-outlook-status-msg">
              {outlook.message ?? `Sign in to ${outlook.server ?? "Work IQ Mail"} in Customize › Integrations.`}
            </div>
          )}
          {outlook?.status === "error" && outlook.message && (
            <div className="px-2 text-warn" data-testid="my-work-outlook-error">
              {outlook.message}
            </div>
          )}
          {outlook?.status === "loading" && outlookMessages.length === 0 && outlook.checkedAt === undefined && (
            <div className="px-2 text-muted/80" data-testid="my-work-outlook-status-msg">
              Checking unread Outlook emails…
            </div>
          )}
          {(outlook?.status === "ok" || (outlook?.status === "loading" && outlook.checkedAt !== undefined)) && outlookMessages.length === 0 && (
            <div className="px-2 text-muted/80" data-testid="my-work-outlook-status-msg">
              No unread emails needing your attention.
            </div>
          )}
          {outlookMessages.length > 0 && (
            <ul>
              {outlookMessages.map((msg) => (
                <li
                  key={msg.messageId}
                  data-testid="my-work-outlook-item"
                  data-message-id={msg.messageId}
                  className="group rounded px-2 py-1 hover:bg-raised"
                >
                  <div className="flex items-center gap-1.5">
                    <Mail
                      className={`h-3.5 w-3.5 shrink-0 ${msg.urgency === "urgent" ? "text-bad" : "text-accent"}`}
                      aria-label="Outlook email"
                    />
                    <span className="min-w-0 flex-1 truncate font-medium text-fg" data-testid="my-work-outlook-subject">
                      {msg.subject}
                    </span>
                    <button
                      type="button"
                      data-testid="my-work-outlook-ask"
                      aria-label={`Ask ARIA about email "${msg.subject}"`}
                      title="Draft reply or ask ARIA about this email"
                      onClick={() => setPrefill(`About the email from ${msg.fromName} ("${msg.subject}"): `)}
                      className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent/15 hover:underline"
                    >
                      Ask ARIA
                    </button>
                    {msg.webLink && (
                      <button
                        type="button"
                        data-testid="my-work-outlook-open"
                        aria-label={`Open "${msg.subject}" in Outlook`}
                        title="Open in Outlook"
                        onClick={() => openPage(msg.webLink!)}
                        className="shrink-0 rounded p-0.5 text-muted hover:text-fg"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-5 text-[11px] text-muted">
                    <span
                      className={`rounded px-1.5 py-px text-[10px] font-medium ${msg.urgency === "urgent" ? "bg-bad/15 text-bad" : "bg-accent/15 text-accent"}`}
                      data-testid="my-work-outlook-urgency"
                    >
                      {msg.urgency === "urgent" ? "Urgent" : "Action needed"}
                    </span>
                    <span className="font-medium text-fg">{msg.fromName}</span>
                    <span className="truncate">{msg.reason}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
