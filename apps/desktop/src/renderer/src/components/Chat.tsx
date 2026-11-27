import type { Task, TimelineItem, Watch } from "@aria/protocol";
import { ArrowDown, Bell, BellOff, ChevronDown, ChevronRight, CircleAlert, Command, CornerDownRight, Info, Layers, LoaderCircle, Mic, MicOff, Pencil, Reply, ScanSearch, SendHorizontal, Settings, Star, Terminal, Trash, TriangleAlert, X } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createFollow } from "../follow";
import { dayLabel, fullDateTime, sameCalendarDay, turnTime } from "../inspector";
import { watchChips } from "../rows";
import { SidebarToggle } from "../sidebar";
import { useHasTracker, useAria, useTracker } from "../store";
import { needsYou as needsYouTargets, nextTarget, SESSION_COLORS, sessionColorIndex, sessionOwnerKey, sessionRuns, targetKey, type TimelineSegment } from "../timelineGroups";
import { prefilledText, trackerLabel } from "../tracker";
import { usePushToTalk } from "../voice";
import { Card } from "./Cards";
import { SaveMemory } from "./Flow";
import { Markdown } from "./Markdown";
import { WatchIcon } from "./MyWork";
import { CopilotErrorTroubleshooter, WelcomeSetupBanner } from "./Onboarding";
import { mentionCandidates, slashCandidates, type SlashSpec } from "./QuickPromptBar";
import { byAttention, isActive, needsYou, StateIcon } from "./tasks";

/** ARIA's state and model. Clicking the model pill opens a dropdown to switch the ARIA chat model or default worker profile, or edit profiles with the pencil icon. */
function StatusPill() {
  const status = useAria((s) => s.status);
  const models = useAria((s) => s.models);
  const profiles = useAria((s) => s.profiles);
  const saveConductorModel = useAria((s) => s.saveConductorModel);
  const setDefaultProfile = useAria((s) => s.setDefaultProfile);
  const setCustomizePage = useAria((s) => s.setCustomizePage);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const dot = { starting: "bg-warn", ready: "bg-ok", busy: "bg-accent", error: "bg-bad" }[status.state];
  const label = { starting: status.detail ?? "Starting", ready: "Ready", busy: "Working", error: "Not connected" }[status.state];
  const model = status.model ? `${status.model}${status.reasoningEffort ? ` · ${status.reasoningEffort}` : ""}` : undefined;
  const enabledModels = models.filter((m) => m.enabled);
  const activeModelObj = enabledModels.find((m) => m.id === status.model);

  return (
    <div ref={menuRef} className="relative flex min-w-0 items-center gap-2 text-xs text-muted" data-testid="status" data-state={status.state} title={model ? `${label} · ${model}` : label}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <span className="truncate">{label}</span>
      {model && (
        <button
          type="button"
          data-testid="status-model"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title="Switch ARIA model or task profile, or edit profiles"
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-line px-1.5 py-0.5 hover:border-accent hover:text-fg @max-2xl:hidden"
        >
          <span>{model}</span>
          <ChevronDown className="h-3 w-3 opacity-70" />
        </button>
      )}
      {open && (
        <div
          role="menu"
          data-testid="status-model-menu"
          className="absolute right-0 top-full z-40 mt-1.5 w-72 space-y-2.5 rounded-lg border border-line bg-panel p-3 text-xs text-fg shadow-xl"
        >
          <div className="space-y-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">ARIA chat model</div>
            <div className="flex items-center gap-1.5">
              <select
                data-testid="header-conductor-model"
                aria-label="ARIA chat model"
                value={status.model ?? ""}
                onChange={(e) => {
                  const nextId = e.target.value;
                  const nextModel = enabledModels.find((m) => m.id === nextId);
                  const nextEffort = nextModel?.efforts.includes(status.reasoningEffort ?? "")
                    ? status.reasoningEffort
                    : nextModel?.efforts.find((ef) => ef !== "none");
                  void saveConductorModel(nextId, nextEffort);
                }}
                className="min-w-0 flex-1 rounded border border-line bg-canvas px-2 py-1 text-xs outline-none focus:border-accent"
              >
                {!enabledModels.some((m) => m.id === status.model) && status.model && (
                  <option value={status.model}>{status.model}</option>
                )}
                {enabledModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              {activeModelObj && activeModelObj.efforts.length > 0 && (
                <select
                  data-testid="header-conductor-effort"
                  aria-label="ARIA reasoning effort"
                  value={status.reasoningEffort ?? ""}
                  onChange={(e) => {
                    if (status.model) void saveConductorModel(status.model, e.target.value || undefined);
                  }}
                  className="w-24 rounded border border-line bg-canvas px-1.5 py-1 text-xs outline-none focus:border-accent"
                >
                  {activeModelObj.efforts.map((ef) => (
                    <option key={ef} value={ef}>
                      {ef}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {profiles.length > 0 && (
            <div className="space-y-1 border-t border-line pt-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Task profiles</div>
              <div className="max-h-48 space-y-1 overflow-y-auto">
                {profiles.map((p) => (
                  <div
                    key={p.id}
                    data-testid="header-profile-row"
                    data-profile={p.name}
                    className={`flex items-center gap-1.5 rounded px-2 py-1 ${
                      p.isDefault ? "bg-accent/10 text-fg" : "hover:bg-raised"
                    }`}
                  >
                    <button
                      type="button"
                      data-testid="header-profile-select"
                      onClick={() => {
                        if (!p.isDefault) void setDefaultProfile(p.id);
                        void saveConductorModel(p.model, p.reasoningEffort);
                        setOpen(false);
                      }}
                      title={`Use ${p.name} (${p.model}${p.reasoningEffort ? ` · ${p.reasoningEffort}` : ""})`}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    >
                      <Star className={`h-3.5 w-3.5 shrink-0 ${p.isDefault ? "fill-current text-warn" : "text-muted"}`} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">
                          {p.name}
                          {p.isDefault && <span className="ml-1.5 text-[10px] font-normal text-muted">default</span>}
                        </div>
                        <div className="truncate text-[11px] text-muted">
                          {p.model}
                          {p.reasoningEffort ? ` · ${p.reasoningEffort}` : ""}
                        </div>
                      </div>
                    </button>
                    <button
                      type="button"
                      data-testid="header-profile-edit"
                      title={`Edit ${p.name} profile`}
                      aria-label={`Edit ${p.name} profile`}
                      onClick={() => {
                        setOpen(false);
                        setCustomizePage("models", p.id);
                      }}
                      className="shrink-0 rounded p-1 text-muted hover:bg-canvas hover:text-fg"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="border-t border-line pt-2">
            <button
              type="button"
              data-testid="header-open-models-config"
              onClick={() => {
                setOpen(false);
                setCustomizePage("models", null);
              }}
              className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-muted hover:bg-raised hover:text-fg"
            >
              <Settings className="h-3.5 w-3.5" />
              <span>Configure models &amp; profiles…</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One message, notice or card. Memoized: the store keeps an unchanged item as the same object, so a chunk of a reply or
 * an update of some task redraws only what it changed, not every message's Markdown. `day` is today's date: the time
 * labels say the day for anything older, so they're drawn again when the day changes.
 */
const Item = memo(function Item({ item }: { item: TimelineItem; day: string }) {
  const openTask = useAria((s) => s.openTask);
  const dismissCard = useAria((s) => s.dismissCard);
  const noticeTask = useAria((s) => (item.kind === "notice" && item.taskId ? s.tasks.find((t) => t.id === item.taskId) : undefined));

  if (item.kind === "chat") {
    if (item.role === "user") {
      const routed = item.routedTo;
      return (
        <div className="flex flex-col items-end gap-0.5" data-card-id={item.id}>
          <div className="max-w-[80%] whitespace-pre-wrap wrap-anywhere rounded-2xl rounded-br-sm border border-accent/30 bg-accent/15 px-3.5 py-2" data-testid="msg-user">
            {item.content}
          </div>
          <div className="flex items-center gap-1.5 px-1 text-[11px] text-muted">
            {item.via === "telegram" && (
              <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] font-medium text-muted" data-testid="chat-via-telegram">
                via Telegram
              </span>
            )}
            <time data-testid="msg-time" dateTime={new Date(item.createdAt).toISOString()} title={fullDateTime(item.createdAt)}>
              {turnTime(item.createdAt)}
            </time>
          </div>
          {routed && (
            <div className="flex max-w-[80%] items-start gap-1 text-[11px] text-muted" data-testid="msg-routed" title="Sent straight to the task, not to ARIA">
              <CornerDownRight className="mt-px h-3 w-3 shrink-0" />
              <span className="min-w-0 wrap-anywhere">
                {routed.action === "answer" ? "Answer" : "Message"} to {routed.title}
                {routed.shortId ? ` · ${routed.shortId}` : ""}
                {routed.note ? <span className={routed.noteTone === "warning" ? "text-warn" : undefined}>{` · ${routed.note}`}</span> : null}
              </span>
            </div>
          )}
          {/* Your own words to a task (not a picked choice) can become a note for its briefs. */}
          {routed && !routed.choice && <SaveMemory text={item.content} from={{ chatItemId: item.id }} taskId={routed.taskId} />}
        </div>
      );
    }
    return (
      <div className="flex flex-col items-start gap-0.5" data-card-id={item.id}>
        <div className="min-w-0 max-w-[88%] rounded-2xl rounded-bl-sm border border-line bg-panel px-3.5 py-2.5" data-testid="msg-assistant">
          <Markdown text={item.content} />
        </div>
        <time data-testid="msg-time" dateTime={new Date(item.createdAt).toISOString()} title={fullDateTime(item.createdAt)} className="px-1 text-[11px] text-muted">
          {turnTime(item.createdAt)}
        </time>
      </div>
    );
  }
  if (item.kind === "notice") {
    const Icon = item.level === "error" ? CircleAlert : item.level === "warning" ? TriangleAlert : Info;
    const tone = item.level === "error" ? "text-bad" : item.level === "warning" ? "text-warn" : "text-muted";
    const noticeAt = item.updatedAt ?? item.createdAt;
    return (
      <div className="group/notice flex justify-center" data-testid="notice" data-cause={item.cause ?? ""} data-card-id={item.id}>
        <div className={`flex max-w-[90%] items-start gap-2 rounded-md px-2 py-1 text-xs ${tone}`}>
          <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 wrap-anywhere">{item.message}</span>
          {noticeTask && (
            <button
              type="button"
              data-testid="notice-session"
              onClick={() => openTask(noticeTask.id)}
              title={`Open session "${noticeTask.title}"`}
              className="shrink-0 rounded border border-line bg-raised px-1.5 py-px text-[10px] text-muted hover:border-accent hover:text-fg"
            >
              {noticeTask.title}
            </button>
          )}
          {item.count !== undefined && item.count > 1 && (
            <span className="shrink-0 rounded bg-raised px-1 py-px font-mono text-[10px] text-muted" data-testid="notice-count" title={`Repeated ${item.count} times`}>
              ×{item.count}
            </span>
          )}
          <time
            data-testid="notice-time"
            dateTime={new Date(noticeAt).toISOString()}
            title={
              item.updatedAt && item.updatedAt !== item.createdAt
                ? `Latest ${fullDateTime(item.updatedAt)} (first ${fullDateTime(item.createdAt)})`
                : fullDateTime(noticeAt)
            }
            className="shrink-0 text-[11px] text-muted/80"
          >
            {turnTime(noticeAt)}
          </time>
          <button
            type="button"
            data-testid="notice-dismiss"
            aria-label="Clear notice from chat"
            title="Clear notice from chat"
            onClick={() => void dismissCard(item.id)}
            className="-mr-1 shrink-0 rounded p-0.5 text-muted opacity-0 transition-opacity hover:bg-raised hover:text-fg focus-visible:opacity-100 group-focus-within/notice:opacity-100 group-hover/notice:opacity-100"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
    );
  }
  return <Card card={item} />;
});

/**
 * Returns the IDs of timeline items that are older resolved/superseded session info cards or notices, so the user can
 * collapse or clear session clutter while keeping every session's primary task card, pending actions, and latest outcome visible.
 */
export function findSupersededSessionItems(
  timeline: readonly TimelineItem[],
  tasks: readonly Task[],
  watches: readonly Watch[],
): Set<string> {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const watchById = new Map(watches.map((w) => [w.id, w]));
  // Find the newest non-`task` card index per session/watch key
  const latestCardByOwner = new Map<string, string>();
  const countByOwner = new Map<string, number>();
  for (const item of timeline) {
    const owner = sessionOwnerKey(item);
    if (!owner) continue;
    countByOwner.set(owner.key, (countByOwner.get(owner.key) ?? 0) + 1);
    if (item.kind === "card" && item.cardType !== "task") {
      latestCardByOwner.set(owner.key, item.id);
    }
  }

  const superseded = new Set<string>();
  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i]!;
    if (item.kind === "notice") {
      const next = timeline[i + 1];
      const ownerKey = item.taskId ? `task:${item.taskId}` : "notices";
      const hasMoreForOwner = (countByOwner.get(ownerKey) ?? 0) > 1;
      const task = item.taskId ? taskById.get(item.taskId) : undefined;
      const taskFinished = task && (task.state === "done" || task.state === "cancelled");
      if (hasMoreForOwner || taskFinished || (next && next.kind === "notice")) {
        superseded.add(item.id);
      }
      continue;
    }
    if (item.kind !== "card" || item.cardType === "task") continue;
    const owner = sessionOwnerKey(item);
    if (!owner) continue;
    const isLatestForOwner = latestCardByOwner.get(owner.key) === item.id;
    const task = owner.taskId ? taskById.get(owner.taskId) : undefined;

    if (item.cardType === "task_question") {
      const pending = task?.question?.id === item.payload.questionId;
      if (!pending && (!isLatestForOwner || task?.state === "done" || task?.state === "cancelled")) {
        superseded.add(item.id);
      }
    } else if (item.cardType === "task_permission") {
      const pending = task?.permissions?.some((p) => p.id === item.payload.permissionId);
      if (!pending && (!isLatestForOwner || task?.state === "done" || task?.state === "cancelled")) {
        superseded.add(item.id);
      }
    } else if (item.cardType === "task_plan") {
      const pending = task?.plan?.id === item.payload.planId;
      if (!pending && (!isLatestForOwner || task?.state === "done" || task?.state === "cancelled")) {
        superseded.add(item.id);
      }
    } else if (item.cardType === "task_budget") {
      const paused = task?.state === "waiting_budget";
      if (!paused && !isLatestForOwner) {
        superseded.add(item.id);
      }
    } else if ((item.cardType === "task_done" || item.cardType === "task_failed") && !isLatestForOwner) {
      superseded.add(item.id);
    } else if ((item.cardType === "ci" || item.cardType === "pr" || item.cardType === "watch_ended") && !isLatestForOwner) {
      const watch = owner.watchId !== undefined ? watchById.get(owner.watchId) : undefined;
      if (!isLatestForOwner || watch?.state === "ended") {
        superseded.add(item.id);
      }
    }
  }
  return superseded;
}

const segmentFirst = (segment: TimelineSegment) => (segment.kind === "item" ? segment.item : segment.items[0]!);
const segmentLast = (segment: TimelineSegment) => (segment.kind === "item" ? segment.item : segment.items[segment.items.length - 1]!);

/**
 * Back-to-back updates of one session or watch (docs/chat-declutter-proposal.md, option 2a): drawn close together
 * behind a stripe in that session's colour, so you can follow a session through the chat even when sessions mix.
 */
const SessionRun = memo(function SessionRun({ run, colorIndex, day }: { run: Extract<TimelineSegment, { kind: "run" }>; colorIndex: number; day: string }) {
  const { taskId, watchId } = run.owner;
  const title = useAria((s) => (taskId ? s.tasks.find((t) => t.id === taskId)?.title : watchId !== undefined ? s.watches.find((w) => w.id === watchId)?.title : undefined));
  const color = SESSION_COLORS[colorIndex % SESSION_COLORS.length]!;
  return (
    <div
      role="group"
      aria-label={title ? `Updates from ${title}` : "Session updates"}
      data-testid="session-run"
      data-session={run.owner.key}
      data-color={colorIndex}
      className={`-ml-3 flex flex-col gap-1.5 border-l-2 pl-2.5 ${color.stripe}`}
    >
      {run.items.map((item) => (
        <Item key={item.id} item={item} day={day} />
      ))}
    </div>
  );
});

/**
 * Active tasks and tasks that need you, then running watches and red ones you haven't looked at, as chips at the top
 * of the chat when the sidebar is collapsed (PLAN.md §5.1).
 */
function LiveStrip() {
  const tasks = useAria((s) => s.tasks);
  const timeline = useAria((s) => s.timeline);
  const watches = useAria((s) => s.watches);
  const seen = useAria((s) => s.seenWatchCards);
  const focusCard = useAria((s) => s.focusCard);
  const focusWatch = useAria((s) => s.focusWatch);
  const shown = tasks.filter((t) => isActive(t) || needsYou(t) || t.state === "queued").sort(byAttention);
  const chips = watchChips(watches, timeline, new Set(seen));
  if (shown.length === 0 && chips.length === 0) return null;
  // A chip scrolls to the task's newest card (its question, budget or task card).
  const cardFor = (taskId: string) => [...timeline].reverse().find((i) => i.kind === "card" && "taskId" in i.payload && i.payload.taskId === taskId)?.id;
  return (
    <div className="flex gap-1.5 overflow-x-auto border-b border-line px-4 py-1.5" data-testid="live-strip">
      {shown.map((t) => (
        <button
          key={t.id}
          data-testid="live-chip"
          onClick={() => focusCard(cardFor(t.id), t.id)}
          title={`${t.title} · ${t.repoName}`}
          className="flex shrink-0 items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs text-muted hover:border-accent hover:text-fg"
        >
          <StateIcon state={t.state} />
          <span className="max-w-48 truncate">{t.title}</span>
        </button>
      ))}
      {chips.map((w) => (
        <button
          key={`w${w.id}`}
          data-testid="live-watch-chip"
          data-tone={w.tone}
          onClick={() => focusWatch(w.id)}
          title={`${w.title}${w.repoName ? ` · ${w.repoName}` : ""} · ${w.status}`}
          className="flex shrink-0 items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs text-muted hover:border-accent hover:text-fg"
        >
          <WatchIcon watch={w} />
          <span className="max-w-48 truncate">{w.title}</span>
        </button>
      ))}
    </div>
  );
}

/** The starter questions; with no task tracker there is none to ask about. */
const suggestions = (tracker: string, hasTracker: boolean) => [
  "What projects do I have?",
  "What's in the README of one of my projects?",
  ...(hasTracker ? [`Which of my ${tracker} tasks are in progress?`] : []),
];

function EmptyState() {
  const setPrefill = useAria((s) => s.setPrefill);
  const tracker = useTracker();
  const hasTracker = useHasTracker();
  return (
    <div className="mx-auto mt-8 max-w-2xl text-center" data-testid="empty">
      <WelcomeSetupBanner />
      <div className="mx-auto max-w-md">
        <div className="text-lg font-semibold">What can I do for you?</div>
        <div className="mt-1 text-sm text-muted">Ask about your projects and connected services, or ask for a change: ARIA runs it in the background and tells you when it's done.</div>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {suggestions(trackerLabel(tracker), hasTracker).map((s) => (
            <button key={s} onClick={() => setPrefill(s)} className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:border-accent hover:text-fg">
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Composer({ onSent }: { onSent?: () => void }) {
  const status = useAria((s) => s.status);
  const send = useAria((s) => s.send);
  const prefill = useAria((s) => s.prefill);
  const setPrefill = useAria((s) => s.setPrefill);
  const actionError = useAria((s) => s.actionError);
  const replyTo = useAria((s) => s.replyTo);
  const setReplyTo = useAria((s) => s.setReplyTo);
  const sendReply = useAria((s) => s.sendReply);
  const composerFocus = useAria((s) => s.composerFocus);
  const tasks = useAria((s) => s.tasks);
  const tracker = useTracker();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState(0);
  // Escape closes the @mention or /slash list for what's typed so far; typing on opens it again.
  const [mentionsClosedFor, setMentionsClosedFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const isSlash = !replyTo && text.trimStart().startsWith("/");
  // A reply goes straight to its task, and deterministic /slash commands run in plain code, so both work while ARIA itself isn't ready.
  const disabled = !replyTo && !isSlash && (status.state === "starting" || status.state === "error");
  const mentions = useMemo(() => (replyTo || text === mentionsClosedFor ? [] : mentionCandidates(tasks, text)), [tasks, text, replyTo, mentionsClosedFor]);
  const slashes = useMemo(() => (replyTo || text === mentionsClosedFor ? [] : slashCandidates(text)), [text, replyTo, mentionsClosedFor]);

  useEffect(() => {
    if (prefill === null) return;
    setText((current) => prefilledText(tracker, current, prefill));
    setPrefill(null);
    input.current?.focus();
  }, [prefill, setPrefill, tracker]);

  useEffect(() => {
    if (composerFocus > 0) input.current?.focus();
  }, [composerFocus]);

  useEffect(() => {
    setPicked(0);
  }, [mentions.length, slashes.length]);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  }, [text]);

  useEffect(() => {
    if (!disabled) input.current?.focus();
  }, [disabled]);

  const submit = async () => {
    const value = text.trim();
    if (!value || disabled || busy) return;
    setBusy(true);
    setText("");
    const ok = replyTo ? await sendReply(value) : await send(value);
    // A failed send keeps your words (and the reply target) so you can try again.
    if (!ok) setText((current) => (current ? current : value));
    else onSent?.();
    setBusy(false);
  };

  const pick = (task: Task) => {
    // Another task goes by the same name (in another repository): this one is replied to by itself, not by name.
    if (tasks.some((t) => t.id !== task.id && t.slug.toLowerCase() === task.slug.toLowerCase())) {
      setText("");
      setReplyTo({ taskId: task.id, title: task.title, ...(task.question ? { question: { id: task.question.id, shortId: task.question.shortId } } : {}) });
    } else {
      setText(`@${task.slug} `);
    }
    input.current?.focus();
  };

  const pickSlash = (spec: SlashSpec) => {
    setText(`${spec.command} `);
    input.current?.focus();
  };

  const ptt = usePushToTalk((transcript) => {
    setText((current) => {
      const trimmed = current.trimEnd();
      return trimmed ? `${trimmed} ${transcript}` : transcript;
    });
    input.current?.focus();
  });

  return (
    <div className="border-t border-line px-4 py-3">
      <div className="mx-auto max-w-3xl">
        {actionError && <div className="mb-2 text-xs text-bad" data-testid="action-error">{actionError}</div>}
        {ptt.pttError && <div className="mb-2 text-xs text-bad" data-testid="composer-ptt-error">{ptt.pttError}</div>}
        {replyTo && (
          <div className="mb-1.5 flex items-center justify-between gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs" data-testid="reply-badge">
            <div className="flex min-w-0 items-center gap-2">
              <Reply className="h-3.5 w-3.5 shrink-0 text-accent" />
              <span className="min-w-0 truncate font-medium text-fg">
                Replying to <span className="font-semibold">{replyTo.title}</span>
                {replyTo.question ? " · " + replyTo.question.shortId : ""}
              </span>
              <span className="shrink-0 text-[11px] font-medium text-accent">(direct message · bypasses ARIA)</span>
            </div>
            <button data-testid="reply-clear" aria-label="Stop replying" title="Stop replying (Esc)" onClick={() => setReplyTo(null)} className="shrink-0 rounded p-0.5 text-muted hover:bg-raised hover:text-fg">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {slashes.length > 0 && (
          <div className="mb-1.5 overflow-hidden rounded-md border border-line bg-panel text-xs" role="listbox" aria-label="Slash commands" data-testid="slash-list">
            {slashes.map((s, i) => (
              <button
                key={s.command}
                type="button"
                role="option"
                aria-selected={i === picked}
                data-testid="slash-option"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickSlash(s);
                }}
                className={`flex w-full items-center justify-between gap-3 px-2.5 py-1.5 text-left ${i === picked ? "bg-raised text-fg" : "text-muted"}`}
              >
                <span className="flex items-center gap-2">
                  <Terminal className="h-3.5 w-3.5 shrink-0 text-accent" />
                  <span className="font-mono font-medium text-fg">{s.usage}</span>
                </span>
                <span className="truncate text-[11px] text-muted">{s.description}</span>
              </button>
            ))}
          </div>
        )}
        {mentions.length > 0 && (
          <div className="mb-1.5 overflow-hidden rounded-md border border-line bg-panel text-xs" role="listbox" aria-label="Tasks" data-testid="mention-list">
            {mentions.map((t, i) => (
              <button
                key={t.id}
                role="option"
                aria-selected={i === picked}
                data-testid="mention-option"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(t);
                }}
                className={`flex w-full items-center gap-2 px-2 py-1 text-left ${i === picked ? "bg-raised text-fg" : "text-muted"}`}
              >
                <StateIcon state={t.state} />
                <span className="font-mono">@{t.slug}</span>
                <span className="truncate">
                  {t.title} · {t.repoName}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className={`flex items-end gap-2 rounded-xl border bg-panel px-3 py-2 focus-within:border-accent ${replyTo ? "border-accent/60 ring-1 ring-accent/30" : "border-line"}`}>
          <textarea
            ref={input}
            data-testid="composer"
            rows={1}
            value={text}
            disabled={disabled}
            placeholder={
              replyTo
                ? replyTo.question
                  ? `Answer ${replyTo.question.shortId} for ${replyTo.title}…`
                  : `Message ${replyTo.title}…`
                : disabled
                  ? status.state === "error"
                    ? "ARIA isn't connected"
                    : "ARIA is starting…"
                  : "Ask ARIA anything, @task to message a task, or / for commands…"
            }
            onChange={(e) => {
              setText(e.target.value);
              ptt.clearPttError();
            }}
            onKeyUp={(e) => {
              ptt.handleKeyUp(e);
            }}
            onKeyDown={(e) => {
              if (ptt.handleKeyDown(e)) return;
              if (slashes.length > 0) {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMentionsClosedFor(text);
                  return;
                }
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setPicked((i) => (i + (e.key === "ArrowDown" ? 1 : slashes.length - 1)) % slashes.length);
                  return;
                }
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && text.trim().toLowerCase() !== (slashes[picked] ?? slashes[0])!.command)) {
                  e.preventDefault();
                  pickSlash(slashes[picked] ?? slashes[0]!);
                  return;
                }
              }
              if (mentions.length > 0) {
                if (e.key === "Escape") {
                  // Closes the list, and doesn't close the session view as well.
                  e.preventDefault();
                  setMentionsClosedFor(text);
                  return;
                }
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setPicked((i) => (i + (e.key === "ArrowDown" ? 1 : mentions.length - 1)) % mentions.length);
                  return;
                }
                if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
                  e.preventDefault();
                  pick(mentions[picked] ?? mentions[0]!);
                  return;
                }
              }
              if (e.key === "Escape" && replyTo) {
                // Clears the reply target, and doesn't close the session view as well.
                e.preventDefault();
                setReplyTo(null);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
            className="max-h-48 flex-1 resize-none bg-transparent py-1 outline-none placeholder:text-muted disabled:opacity-60"
          />
          <button
            type="button"
            data-testid="composer-ptt"
            data-recording={ptt.recording ? "true" : "false"}
            data-transcribing={ptt.transcribing ? "true" : "false"}
            disabled={ptt.transcribing}
            onPointerDown={() => ptt.onPointerDown()}
            onPointerUp={() => ptt.onPointerUp()}
            title={
              ptt.recording
                ? "Listening… Release or click to transcribe (Esc to cancel)"
                : ptt.transcribing
                  ? "Transcribing speech…"
                  : "Push to talk (hold or click, or Ctrl+Shift+Space)"
            }
            aria-label={ptt.recording ? "Stop recording and transcribe" : "Push to talk"}
            className={`flex items-center gap-1 rounded-lg p-1.5 text-xs ${
              ptt.recording
                ? "animate-pulse bg-bad/20 text-bad"
                : ptt.transcribing
                  ? "text-accent"
                  : "text-muted hover:bg-raised hover:text-fg"
            }`}
          >
            {ptt.transcribing ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : ptt.recording ? (
              <>
                <MicOff className="h-4 w-4 shrink-0" />
                <span className="text-[11px] font-medium">Listening…</span>
              </>
            ) : (
              <Mic className="h-4 w-4 shrink-0" />
            )}
          </button>
          <button
            data-testid="send"
            title={replyTo ? `Send to ${replyTo.title}` : "Send"}
            onClick={() => void submit()}
            disabled={disabled || busy || !text.trim()}
            className={
              replyTo
                ? "flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-white hover:bg-accent/90 disabled:opacity-50"
                : "rounded-lg p-1.5 text-accent hover:bg-accent/15 disabled:text-muted disabled:hover:bg-transparent"
            }
          >
            {replyTo && <span className="max-w-[160px] truncate text-xs font-medium">Send to {replyTo.title}</span>}
            <SendHorizontal className="h-4 w-4 shrink-0" />
          </button>
        </div>
        <div className="mt-1.5 text-[11px] text-muted">
          {replyTo
            ? "Enter to send it to the task · Shift+Enter for a new line · Esc to stop replying"
            : "Enter to send · Shift+Enter for a new line · @ to message a task · / for commands · Ctrl+Space quick prompt · Ctrl+Shift+Space voice"}
        </div>
      </div>
    </div>
  );
}

/**
 * What's still coming in, below the timeline: the reply being written, what ARIA is doing, and its start-up or
 * connection state. It reads these itself, so a chunk of a reply redraws this and not the whole chat. `onGrow` runs
 * after each change, before the window paints (the chat keeps to the bottom with it).
 */
export function ChatTail({ onGrow }: { onGrow?: () => void }) {
  const streaming = useAria((s) => s.streaming);
  const status = useAria((s) => s.status);
  const activity = useAria((s) => s.activity);
  useLayoutEffect(() => {
    onGrow?.();
  }, [streaming, activity, status.state, onGrow]);
  return (
    <>
      {streaming.map((s) => (
        <div key={s.id} className="flex">
          <div className="min-w-0 max-w-[88%] rounded-2xl rounded-bl-sm border border-line bg-panel px-3.5 py-2.5" data-testid="msg-streaming">
            <Markdown text={s.text} streaming />
          </div>
        </div>
      ))}
      {status.state === "busy" && (activity || streaming.length === 0) && (
        <div className="flex items-center gap-2 text-xs text-muted" data-testid="activity">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          {activity ?? "Thinking"}…
        </div>
      )}
      {status.state === "starting" && (
        <div className="mx-auto mt-16 flex items-center gap-2 text-sm text-muted" data-testid="starting">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          {status.detail ?? "Starting"}…
        </div>
      )}
      {status.state === "error" && <CopilotErrorTroubleshooter />}
    </>
  );
}

export function Chat() {
  const timeline = useAria((s) => s.timeline);
  // Only whether ARIA is ready (for the empty state): the reply being written and the activity are ChatTail's.
  const ready = useAria((s) => s.status.state === "ready");
  const sidebarCollapsed = useAria((s) => s.ui.sidebarCollapsed);
  const focus = useAria((s) => s.focus);
  const clearFocus = useAria((s) => s.clearFocus);
  const tasks = useAria((s) => s.tasks);
  const watches = useAria((s) => s.watches);
  const dismissCard = useAria((s) => s.dismissCard);
  const inspecting = useAria((s) => s.inspecting);
  const openInspector = useAria((s) => s.openInspector);
  const openQuickPrompt = useAria((s) => s.openQuickPrompt);
  const focusMode = useAria((s) => s.attention.focusMode);
  const setAttention = useAria((s) => s.setAttention);
  const scroller = useRef<HTMLDivElement>(null);
  // Keeps to the newest message while you're at the bottom; a scroll to a card turns that off until you scroll yourself.
  const [follow] = useState(createFollow);
  const [stuck, setStuck] = useState(true);
  const [compactSessions, setCompactSessions] = useState(false);
  const [expandedSuperseded, setExpandedSuperseded] = useState(false);
  const focusCard = useAria((s) => s.focusCard);
  const openTask = useAria((s) => s.openTask);
  const waiting = useMemo(() => needsYouTargets(timeline, tasks, needsYou), [timeline, tasks]);
  // The "need you" button takes you to the next waiting card each time, round and round.
  const lastJump = useRef<string | null>(null);
  const jumpToNext = () => {
    const next = nextTarget(waiting.targets, lastJump.current);
    if (!next) return;
    lastJump.current = targetKey(next);
    if (next.cardId) focusCard(next.cardId, next.taskId);
    else if (next.taskId) openTask(next.taskId);
  };
  const supersededIds = useMemo(() => findSupersededSessionItems(timeline, tasks, watches), [timeline, tasks, watches]);
  const visibleTimeline = useMemo(
    () => (compactSessions && !expandedSuperseded ? timeline.filter((i) => !supersededIds.has(i.id)) : timeline),
    [timeline, compactSessions, expandedSuperseded, supersededIds],
  );
  const segments = useMemo(() => sessionRuns(visibleTimeline, sameCalendarDay), [visibleTimeline]);
  const colors = useMemo(() => sessionColorIndex(timeline), [timeline]);
  const day = new Date().toDateString();
  const clearSuperseded = async () => {
    for (const id of supersededIds) {
      await dismissCard(id);
    }
    setExpandedSuperseded(false);
  };

  const scrollToBottom = useCallback(() => {
    follow.followBottom();
    setStuck(true);
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [follow]);

  const keepToBottom = useCallback(() => {
    const el = scroller.current;
    if (el && follow.stick && !useAria.getState().focus?.cardId) el.scrollTop = el.scrollHeight;
  }, [follow]);

  useLayoutEffect(() => {
    keepToBottom();
  }, [timeline, keepToBottom]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ended = () => follow.ended();
    el.addEventListener("scrollend", ended);
    return () => el.removeEventListener("scrollend", ended);
  }, [follow]);

  // A toast or a live-strip chip asked for a card: scroll to it once, clear focus so remounts don't jump back, and flash it.
  useEffect(() => {
    if (!focus?.cardId) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(focus.cardId)}"]`);
    clearFocus();
    if (!el) return;
    follow.scrollingTo();
    setStuck(false);
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.animate?.([{ outline: "2px solid rgb(47 129 247)" }, { outline: "2px solid transparent" }], { duration: 1600 });
  }, [focus, follow, clearFocus]);

  return (
    <div className="flex h-full flex-col">
      {/* A container: when the chat is narrow (a session or the inspector open), Focus and Inspect show only their icons. */}
      <header className="@container flex h-12 shrink-0 items-center justify-between gap-3 border-b border-line px-4">
        <div className="flex shrink-0 items-center gap-2">
          <SidebarToggle />
          <div className="font-semibold">ARIA</div>
          {waiting.count > 0 && (
            <button
              type="button"
              data-testid="needs-you"
              onClick={jumpToNext}
              title={waiting.targets.length > 1 ? `Go to the next of ${waiting.targets.length} things that wait for you` : "Go to what waits for you"}
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-bad/20 px-2 py-0.5 text-xs text-bad hover:bg-bad/30 focus-visible:outline focus-visible:outline-1 focus-visible:outline-bad"
            >
              {waiting.count} need{waiting.count === 1 ? "s" : ""} you
              <ArrowDown className="h-3 w-3" aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-3 @max-xl:gap-2">
          {supersededIds.size > 0 && (
            <button
              type="button"
              data-testid="chat-compact-sessions"
              aria-pressed={compactSessions}
              onClick={() => {
                setCompactSessions((v) => !v);
                setExpandedSuperseded(false);
              }}
              title={
                compactSessions
                  ? `Showing compact view (${supersededIds.size} older session update${supersededIds.size === 1 ? "" : "s"} hidden). Click to show all.`
                  : `Hide ${supersededIds.size} older resolved session update${supersededIds.size === 1 ? "" : "s"} and repeated info messages`
              }
              className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-xs hover:text-fg ${
                compactSessions ? "border-accent text-accent" : "border-line text-muted"
              }`}
            >
              <Layers className="h-3.5 w-3.5" />
              <span className="@max-xl:sr-only">Compact</span>
              <span className="rounded bg-raised px-1 font-mono text-[10px]">{supersededIds.size}</span>
            </button>
          )}
          <button
            type="button"
            data-testid="open-quick-prompt"
            onClick={openQuickPrompt}
            title="Quick prompt bar (Ctrl+Space)"
            className="inline-flex shrink-0 items-center gap-1 rounded border border-line px-1.5 py-0.5 text-xs text-muted hover:text-fg"
          >
            <Command className="h-3.5 w-3.5" />
            <span className="@max-xl:sr-only">Quick prompt</span>
          </button>
          <button
            data-testid="focus-mode"
            aria-pressed={focusMode}
            onClick={() => void setAttention({ focusMode: !focusMode })}
            title={focusMode ? "Focus mode is on: only questions, approvals, plans, budget pauses and failures pop up while you're away. Click to turn it off." : "Focus mode: only questions, approvals, plans, budget pauses and failures pop up while you're away"}
            className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-xs hover:text-fg ${focusMode ? "border-accent text-accent" : "border-line text-muted"}`}
          >
            {focusMode ? <BellOff className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
            <span className="@max-xl:sr-only">Focus</span>
          </button>
          {/* Not a switch: while the inspector is open, it takes the focus there (it doesn't close it). */}
          <button
            data-testid="inspect-aria"
            onClick={() => openInspector()}
            title={inspecting ? "Inspect: the inspector is open; this moves the focus into it" : "Inspect: what ARIA was sent with each message, and what it did"}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-line px-1.5 py-0.5 text-xs text-muted hover:text-fg"
          >
            <ScanSearch className="h-3.5 w-3.5" />
            <span className="@max-xl:sr-only">Inspect</span>
          </button>
          <StatusPill />
        </div>
      </header>
      {sidebarCollapsed && <LiveStrip />}
      <div
        ref={scroller}
        className="flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.scrolled(el.scrollHeight - el.scrollTop - el.clientHeight);
          setStuck(follow.stick);
        }}
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4" data-testid="timeline">
          {timeline.length === 0 && ready && <EmptyState />}
          {compactSessions && supersededIds.size > 0 && (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-panel px-3 py-1.5 text-xs text-muted"
              data-testid="session-collapsed-summary"
            >
              <button
                type="button"
                data-testid="session-collapsed-toggle"
                onClick={() => setExpandedSuperseded((v) => !v)}
                className="inline-flex items-center gap-1.5 text-left hover:text-fg"
              >
                {expandedSuperseded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                <span>
                  {expandedSuperseded ? "Showing" : "Hid"} {supersededIds.size} older resolved session update{supersededIds.size === 1 ? "" : "s"} &amp; info message{supersededIds.size === 1 ? "" : "s"}
                </span>
              </button>
              <button
                type="button"
                data-testid="chat-clear-old"
                onClick={() => void clearSuperseded()}
                title="Permanently remove these older resolved updates and notices from the chat"
                className="inline-flex items-center gap-1 rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:border-bad/50 hover:text-bad"
              >
                <Trash className="h-3 w-3" /> Clear {supersededIds.size} old
              </button>
            </div>
          )}
          {segments.map((segment, idx) => {
            const first = segmentFirst(segment);
            const prev = idx > 0 ? segmentLast(segments[idx - 1]!) : undefined;
            const showDayDivider = prev
              ? !sameCalendarDay(prev.createdAt, first.createdAt)
              : !sameCalendarDay(first.createdAt, Date.now());
            return (
              <div key={first.id} className="contents">
                {showDayDivider && (
                  <div className="my-1 flex items-center gap-3 text-[11px] text-muted" data-testid="timeline-day-divider">
                    <div className="h-px flex-1 bg-line" />
                    <span>{dayLabel(first.createdAt)}</span>
                    <div className="h-px flex-1 bg-line" />
                  </div>
                )}
                {segment.kind === "item" ? <Item item={segment.item} day={day} /> : <SessionRun run={segment} colorIndex={colors.get(segment.owner.key) ?? 0} day={day} />}
              </div>
            );
          })}
          <ChatTail onGrow={keepToBottom} />
        </div>
      </div>
      {!stuck && timeline.length > 0 && (
        <div className="pointer-events-none relative">
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2">
            <button
              type="button"
              data-testid="jump-to-bottom"
              onClick={scrollToBottom}
              className="pointer-events-auto inline-flex items-center gap-1 rounded-full border border-line bg-raised px-3 py-1 text-xs text-fg shadow-md hover:border-accent"
            >
              <ArrowDown className="h-3.5 w-3.5 text-accent" />
              Jump to bottom
            </button>
          </div>
        </div>
      )}
      <Composer onSent={scrollToBottom} />
    </div>
  );
}
