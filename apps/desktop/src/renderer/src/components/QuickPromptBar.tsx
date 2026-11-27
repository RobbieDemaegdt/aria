import type { Task } from "@aria/protocol";
import { Command, LoaderCircle, Mic, MicOff, SendHorizontal, Terminal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { errorText, useAria } from "../store";
import { usePushToTalk } from "../voice";
import { byAttention, StateIcon } from "./tasks";

export interface SlashSpec {
  command:
    | "/status"
    | "/tasks"
    | "/watch"
    | "/focus"
    | "/pause-all"
    | "/budget"
    | "/agents"
    | "/skills"
    | "/doctor"
    | "/tracker"
    | "/setup"
    | "/tour"
    | "/whats-new";
  usage: string;
  description: string;
}

export const SLASH_SPECS: readonly SlashSpec[] = [
  {
    command: "/status",
    usage: "/status",
    description: "Show ARIA status, active tasks, waiting items, watches and reminders",
  },
  {
    command: "/tasks",
    usage: "/tasks [running | waiting | done | failed | project]",
    description: "List background tasks, their state, branch and credit usage",
  },
  {
    command: "/watch",
    usage: "/watch [list | stop W-n | target]",
    description: "List active GitHub watches, stop a watch, or ask ARIA to watch a target",
  },
  {
    command: "/focus",
    usage: "/focus [on | off]",
    description: "Toggle Focus mode (only blocking items toast while away)",
  },
  {
    command: "/pause-all",
    usage: "/pause-all",
    description: "Stop all running and queued background tasks",
  },
  {
    command: "/budget",
    usage: "/budget [+credits] [B-n | @task]",
    description: "Show task credit budgets or add credits to a paused task",
  },
  {
    command: "/agents",
    usage: "/agents [filter | @task <agent | default>]",
    description: "List installed agents, or switch a task's agent (/agents @task <agent>)",
  },
  {
    command: "/skills",
    usage: "/skills [filter]",
    description: "List installed built-in, personal, project, and plugin skills",
  },
  {
    command: "/doctor",
    usage: "/doctor",
    description: "Check Copilot CLI, runtime, git worktrees, GitHub CLI and MCP integrations",
  },
  {
    command: "/tracker",
    usage: "/tracker [none | default | config id]",
    description: "Show the task tracker configs and the active tracker, or switch between them",
  },
  {
    command: "/setup",
    usage: "/setup",
    description: "Open the Getting Started & configuration checklist",
  },
  {
    command: "/tour",
    usage: "/tour",
    description: "Start the interactive 1-minute GUI tour of ARIA",
  },
  {
    command: "/whats-new",
    usage: "/whats-new",
    description: "Show new features and bug fixes in this version of ARIA",
  },
];

/** Tasks you can @mention while typing `@…` at the start of a message: the ones that are working or wait for you first. */
export function mentionCandidates(tasks: Task[], text: string): Task[] {
  const match = /^@([\w.-]*)$/.exec(text);
  if (!match) return [];
  const query = match[1]!.toLowerCase();
  return tasks
    .filter((t) => t.state !== "cancelled" && (t.slug.toLowerCase().includes(query) || t.title.toLowerCase().includes(query)))
    .sort(byAttention)
    .slice(0, 6);
}

/** Slash commands matching `/…` before a space is typed. */
export function slashCandidates(text: string): SlashSpec[] {
  const match = /^\/([a-z-]*)$/i.exec(text);
  if (!match) return [];
  const query = `/${match[1]!.toLowerCase()}`;
  return SLASH_SPECS.filter((s) => s.command.startsWith(query));
}

/**
 * Spotlight-style Quick prompt bar (Phase 6C, PLAN.md §4.1, §5.5, §10 Phase 6C): opened from anywhere with `Ctrl+Alt+Space`
 * (or `Ctrl+Space` in-window, the tray menu, or header button). Type a prompt, `@task` message, or `/slash` command, press Enter, and it's gone.
 */
export function QuickPromptBar() {
  const open = useAria((s) => s.quickPromptOpen);
  const focusCount = useAria((s) => s.quickPromptFocus);
  const close = useAria((s) => s.closeQuickPrompt);
  const setView = useAria((s) => s.setView);
  const tasks = useAria((s) => s.tasks);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState(0);
  const [pickedTask, setPickedTask] = useState<{ id: string; slug: string; questionId?: string } | null>(null);
  const [closedPopupFor, setClosedPopupFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const ptt = usePushToTalk((transcript) => {
    setText((current) => {
      const trimmed = current.trimEnd();
      return trimmed ? `${trimmed} ${transcript}` : transcript;
    });
    inputRef.current?.focus();
  });

  useEffect(() => {
    if (!open) {
      ptt.cancel();
      return;
    }
    setError(null);
    setClosedPopupFor(null);
    setPicked(0);
    setTimeout(() => inputRef.current?.focus(), 0);
    // Only when the bar opens or closes: `ptt` is a new object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focusCount]);

  const mentions = useMemo(
    () => (text === closedPopupFor ? [] : mentionCandidates(tasks, text)),
    [tasks, text, closedPopupFor],
  );
  const slashes = useMemo(
    () => (text === closedPopupFor ? [] : slashCandidates(text)),
    [text, closedPopupFor],
  );
  const totalOptions = slashes.length > 0 ? slashes.length : mentions.length;

  useEffect(() => {
    setPicked(0);
  }, [totalOptions]);

  if (!open) return null;

  const pickMention = (task: Task) => {
    setPickedTask({ id: task.id, slug: task.slug, ...(task.question ? { questionId: task.question.id } : {}) });
    setText(`@${task.slug} `);
    setError(null);
    inputRef.current?.focus();
  };

  const pickSlash = (spec: SlashSpec) => {
    setPickedTask(null);
    setText(`${spec.command} `);
    setError(null);
    inputRef.current?.focus();
  };

  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const mention = /^@([\w.-]+)\s+([\s\S]*\S[\s\S]*)$/.exec(value);
      if (mention && pickedTask && mention[1]!.toLowerCase() === pickedTask.slug.toLowerCase()) {
        await window.aria.reply({
          taskId: pickedTask.id,
          ...(pickedTask.questionId ? { item: { kind: "question" as const, id: pickedTask.questionId } } : {}),
          text: mention[2]!.trim(),
        });
      } else {
        const lower = value.toLowerCase();
        if (lower === "/tour") useAria.getState().startTour(0);
        else if (lower === "/setup") useAria.getState().openOnboardingModal();
        else if (lower === "/whats-new" || lower === "/changelog") useAria.getState().openWhatsNewModal();
        await window.aria.sendMessage(value);
      }
      setText("");
      setPickedTask(null);
      setView("chat");
      close();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="quick-prompt"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-24 backdrop-blur-[1px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="w-[38rem] max-w-[92vw] overflow-hidden rounded-xl border border-line bg-panel shadow-2xl">
        <div className="flex items-center gap-2.5 border-b border-line px-3.5 py-2.5">
          <Command className="h-4 w-4 shrink-0 text-accent" />
          <input
            ref={inputRef}
            type="text"
            aria-label="Quick prompt"
            data-testid="quick-prompt-input"
            value={text}
            disabled={busy}
            placeholder="Ask ARIA, @task to message a task, or / for commands…"
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
              ptt.clearPttError();
            }}
            onKeyUp={(e) => {
              ptt.handleKeyUp(e);
            }}
            onKeyDown={(e) => {
              if (ptt.handleKeyDown(e)) return;
              if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "Space") {
                e.preventDefault();
                e.stopPropagation();
                close();
                return;
              }
              if (slashes.length > 0) {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setClosedPopupFor(text);
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
                  e.preventDefault();
                  e.stopPropagation();
                  setClosedPopupFor(text);
                  return;
                }
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setPicked((i) => (i + (e.key === "ArrowDown" ? 1 : mentions.length - 1)) % mentions.length);
                  return;
                }
                if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
                  e.preventDefault();
                  pickMention(mentions[picked] ?? mentions[0]!);
                  return;
                }
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-muted"
          />
          <button
            type="button"
            data-testid="quick-prompt-ptt"
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
            type="button"
            data-testid="quick-prompt-send"
            disabled={busy || !text.trim()}
            onClick={() => void submit()}
            title="Send (Enter)"
            className="rounded-lg p-1.5 text-accent hover:bg-accent/15 disabled:text-muted disabled:hover:bg-transparent"
          >
            <SendHorizontal className="h-4 w-4" />
          </button>
          <button
            type="button"
            data-testid="quick-prompt-close"
            onClick={close}
            aria-label="Close quick prompt"
            title="Close (Esc)"
            className="rounded-lg p-1 text-muted hover:bg-raised hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {slashes.length > 0 && (
          <div
            role="listbox"
            aria-label="Slash commands"
            data-testid="quick-prompt-slash-list"
            className="border-b border-line bg-canvas/60 p-1 text-xs"
          >
            {slashes.map((s, i) => (
              <button
                key={s.command}
                type="button"
                role="option"
                aria-selected={i === picked}
                data-testid="quick-prompt-slash-option"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickSlash(s);
                }}
                className={`flex w-full items-center justify-between gap-3 rounded px-2.5 py-1.5 text-left ${
                  i === picked ? "bg-raised text-fg" : "text-muted hover:bg-raised hover:text-fg"
                }`}
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
          <div
            role="listbox"
            aria-label="Tasks"
            data-testid="quick-prompt-mention-list"
            className="border-b border-line bg-canvas/60 p-1 text-xs"
          >
            {mentions.map((t, i) => (
              <button
                key={t.id}
                type="button"
                role="option"
                aria-selected={i === picked}
                data-testid="quick-prompt-mention-option"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickMention(t);
                }}
                className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left ${
                  i === picked ? "bg-raised text-fg" : "text-muted hover:bg-raised hover:text-fg"
                }`}
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

        {(error || ptt.pttError) && (
          <div className="border-b border-line bg-bad/10 px-3.5 py-1.5 text-xs text-bad" data-testid="quick-prompt-error">
            {error ?? ptt.pttError}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-1.5 text-[11px] text-muted">
          <span>
            <kbd className="rounded border border-line px-1 py-px font-mono">Enter</kbd> to send ·{" "}
            <kbd className="rounded border border-line px-1 py-px font-mono">Tab</kbd> to complete ·{" "}
            <kbd className="rounded border border-line px-1 py-px font-mono">Ctrl+Shift+Space</kbd> voice ·{" "}
            <kbd className="rounded border border-line px-1 py-px font-mono">Esc</kbd> to close
          </span>
          <span className="font-mono">/status · /tasks · /watch · /focus · /pause-all · /budget</span>
        </div>
      </div>
    </div>
  );
}
