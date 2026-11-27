// A task's cards: the task itself, its questions, budget, result and failure, and the tasks ARIA proposes.
import { encodingDamageText, type CardItem, type EncodingDamage, type PendingQuestion, type Task } from "@aria/protocol";
import {
  Check,
  CircleAlert,
  CircleMinus,
  CirclePause,
  CircleQuestionMark,
  Cloud,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitPullRequest,
  UserRoundCog,
  MessageSquareReply,
  Reply,
  RotateCcw,
  Sparkles,
  Square,
  TimerReset,
  Trash,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { selectAgents, useHasTracker, useAria, useTracker } from "../store";
import { AgentSelectOptions } from "./AgentOptions";
import { SaveMemory } from "./Flow";
import { Markdown } from "./Markdown";
import { credits, elapsed, isActive, modelLabel, StateChip, useNow } from "./tasks";
import { openPage } from "../openPage";
import { openTrackerTask, ownsTask, trackerLabel, trackerRef } from "../tracker";
import { Button, oneLine, Receipt, Shell, ShortId, useTask } from "./CardParts";

/**
 * R1: lines the task added that look like damaged text (`→` read as Windows-1252 is `â†’`), with the files in the
 * tooltip, and a button that has ARIA send the task the files and how to repair them (it continues in its session).
 * The button follows the task's own count, not the card's: it goes once the task was asked or finished again without
 * damage, and isn't there for a cloud task or once the worktree is gone.
 */
export function EncodingDamageNote({ damage, task, testId }: { damage: EncodingDamage; task?: Task; testId: string }) {
  const repairEncoding = useAria((s) => s.repairEncoding);
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const more = damage.files > damage.paths.length ? `\n… and ${damage.files - damage.paths.length} more` : "";
  const canRepair = !!task?.encodingDamage && !task.cleanedUp && task.where !== "cloud";
  const repair = async () => {
    if (!task) return;
    setState("sending");
    setState((await repairEncoding(task.id)) ? "sent" : "idle");
  };
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-warn" data-testid={testId}>
      <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
      <span title={`${damage.paths.join("\n")}${more}`}>{encodingDamageText(damage)}</span>
      {state === "sent" ? (
        <span className="text-muted" data-testid={`${testId}-asked`}>Asked it to repair.</span>
      ) : (
        canRepair && (
          <Button testId={`${testId}-repair`} disabled={state === "sending"} title="Send the task these files and how to repair them: it continues in its session" onClick={() => void repair()}>
            Ask it to repair
          </Button>
        )
      )}
    </div>
  );
}

/** Reply: your next chat message goes straight to the task (and answers the question it waits on), not to ARIA. */
export function ReplyButton({ task, testId = "card-reply" }: { task: Task; testId?: string }) {
  const replyTo = useAria((s) => s.replyTo);
  const setReplyTo = useAria((s) => s.setReplyTo);
  const isReplying = replyTo?.taskId === task.id;
  const question = task.question;
  return (
    <Button
      testId={testId}
      primary={isReplying}
      title={isReplying ? "Stop replying to this task" : question ? `Answer ${question.shortId} from the chat` : "Your next message goes straight to this task, not to ARIA"}
      onClick={() =>
        setReplyTo(
          isReplying
            ? null
            : { taskId: task.id, title: task.title, ...(question ? { question: { id: question.id, shortId: question.shortId } } : {}) },
        )
      }
    >
      <Reply className="h-3 w-3" /> {isReplying ? "Replying below…" : "Reply"}
    </Button>
  );
}

/** Inline direct reply input on an active task card so you can message the task right from the card. */
export function TaskReplyForm({ task }: { task: Task }) {
  const sendReply = useAria((s) => s.sendReply);
  const setReplyTo = useAria((s) => s.setReplyTo);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const value = reply.trim();
    if (busy || !value) return;
    setBusy(true);
    if (useAria.getState().replyTo?.taskId !== task.id) {
      const question = task.question;
      setReplyTo({ taskId: task.id, title: task.title, ...(question ? { question: { id: question.id, shortId: question.shortId } } : {}) });
    }
    if (await sendReply(value)) setReply((current) => (current.trim() === value ? "" : current));
    setBusy(false);
  };
  return (
    <form
      className="mt-2 flex gap-1.5"
      data-testid="task-reply-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        data-testid="task-reply-input"
        aria-label={`Message ${task.title}`}
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setReplyTo(null);
          }
        }}
        placeholder={task.question ? `Answer ${task.question.shortId} for ${task.title}…` : `Message ${task.title}…`}
        className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1 text-xs outline-none focus:border-accent"
      />
      <Button testId="task-reply-send" type="submit" primary disabled={busy || !reply.trim()}>
        <MessageSquareReply className="h-3 w-3" /> Send
      </Button>
    </form>
  );
}

/** A task, drawn from its live state: it updates in place while the task runs. */
export function TaskCard({ card }: { card: Extract<CardItem, { cardType: "task" }> }) {
  const task = useTask(card.payload.taskId);
  const tracker = useTracker();
  const hasTracker = useHasTracker();
  const agents = useAria(selectAgents);
  const openTask = useAria((s) => s.openTask);
  const cancelTask = useAria((s) => s.cancelTask);
  const setTaskAgent = useAria((s) => s.setTaskAgent);
  const replyTo = useAria((s) => s.replyTo);
  const [editingAgent, setEditingAgent] = useState(false);
  const [busyAgent, setBusyAgent] = useState(false);
  const now = useNow(task ? isActive(task) : false);
  if (!task) return <Shell testId="card-task" cardId={card.id} title={<span className="text-muted">A task that was discarded</span>} />;
  const time = elapsed(task, now);
  const canReply = (isActive(task) || task.state === "queued") && task.state !== "waiting_permission" && task.state !== "waiting_plan";
  const isReplying = canReply && replyTo?.taskId === task.id;
  return (
    <Shell
      testId="card-task"
      cardId={card.id}
      tone={isReplying ? "border-accent/60" : "border-line"}
      title={
        <span>
          {task.title} <span className="font-normal text-muted">· {task.repoName}</span>
        </span>
      }
      right={<StateChip state={task.state} />}
    >
      {task.intent && isActive(task) && <div className="mt-1 truncate text-xs text-muted" data-testid="task-intent">{task.intent}</div>}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        {time && <span>{time}</span>}
        <span title={task.profileNote}>
          {task.profileName} · {modelLabel(task)}
        </span>
        {task.agent && (
          <span
            data-testid="task-agent-badge"
            className="inline-flex items-center gap-1 rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-fg"
            title={`Running with agent ${task.agent}`}
          >
            <UserRoundCog className="h-3 w-3 text-accent" /> {task.agent}
          </span>
        )}
        {!task.cleanedUp &&
          (editingAgent ? (
            <span className="inline-flex items-center gap-1" data-testid="task-agent-picker">
              <select
                aria-label="Session agent"
                data-testid="task-card-agent"
                disabled={busyAgent}
                value={task.agent ?? ""}
                onChange={async (e) => {
                  const next = e.target.value;
                  setBusyAgent(true);
                  await setTaskAgent(task.id, next || null);
                  setBusyAgent(false);
                  setEditingAgent(false);
                }}
                className="max-w-[14rem] truncate rounded border border-line bg-canvas px-1.5 py-0.5 text-[11px] text-fg outline-none focus:border-accent"
              >
                <AgentSelectOptions agents={agents} currentAgent={task.agent ?? ""} />
              </select>
              <button
                type="button"
                onClick={() => setEditingAgent(false)}
                className="px-1 text-[11px] text-muted hover:text-fg"
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              data-testid="task-agent-edit"
              onClick={() => setEditingAgent(true)}
              title={task.agent ? "Change or clear this session's agent" : "Select an agent for this session"}
              className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11px] text-muted hover:text-fg"
            >
              <UserRoundCog className="h-3 w-3" />
              {task.agent ? "Change agent" : "+ Agent"}
            </button>
          ))}
        <span>{credits(task.costCredits)}</span>
        {task.where === "cloud" && (
          <span
            data-testid="task-cloud-badge"
            className="inline-flex items-center gap-1 rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-accent"
            title="Running in the cloud on GitHub Mission Control"
          >
            <Cloud className="h-3 w-3" /> Cloud
          </span>
        )}
        {task.where !== "cloud" && task.remote && (
          <span
            data-testid="task-remote-badge"
            className="inline-flex items-center gap-1 rounded bg-raised px-1.5 py-0.5 text-[11px] font-medium text-muted"
            title="Shared to GitHub web & mobile via Mission Control"
          >
            Remote
          </span>
        )}
        {task.branch && (
          <span className="inline-flex items-center gap-1">
            <GitBranch className="h-3 w-3" />
            {task.branch}
          </span>
        )}
        {task.trackerTaskId && hasTracker && ownsTask(tracker, task.trackerId) && (
          <button
            type="button"
            data-testid="task-tracker"
            onClick={() => openTrackerTask(tracker, task.trackerTaskId!)}
            className="inline-flex items-center gap-1 rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-accent hover:underline"
            title={`Open ${trackerLabel(tracker)} task ${task.trackerTaskId}`}
          >
            {trackerRef(tracker, task.trackerTaskId)}
          </button>
        )}
        {task.trackerTaskId && hasTracker && !ownsTask(tracker, task.trackerId) && (
          // A task of another tracker: plain text, no link from this tracker's template.
          <span
            data-testid="task-tracker-plain"
            className="inline-flex items-center gap-1 rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-muted"
            title="This task is of another task tracker, so it has no link here"
          >
            #{task.trackerTaskId}
          </span>
        )}
        <span className="ml-auto flex gap-1.5">
          {(task.where === "cloud" || task.remote) && task.missionControlUrl && (
            <Button
              testId="task-mission-control"
              title="Open session on GitHub Mission Control"
              onClick={() => openPage(task.missionControlUrl!)}
            >
              <ExternalLink className="h-3 w-3" /> Mission Control
            </Button>
          )}
          <Button testId="task-open" onClick={() => openTask(task.id)}>
            Open
          </Button>
          <TaskPrLink task={task} testId="task-pr-link" />
          {/* A permission or a plan is decided with its card's buttons: a reply here would only look like a decision. */}
          {canReply && <ReplyButton task={task} testId="task-reply" />}
          {(isActive(task) || task.state === "queued") && (
            <Button testId="task-stop" onClick={() => void cancelTask(task.id)}>
              <Square className="h-3 w-3" /> Stop
            </Button>
          )}
        </span>
      </div>
      {task.profileNote && <div className="mt-1 text-xs text-muted/80">{task.profileNote}</div>}
      {task.fixing && <FixingLine task={task} />}
      {isReplying && <TaskReplyForm task={task} />}
    </Shell>
  );
}

/** What a task fixes (item 4): the CI or review card it came from (a click shows that card). */
function FixingLine({ task }: { task: Task }) {
  const focusCard = useAria((s) => s.focusCard);
  const fixing = task.fixing!;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted" data-testid="task-fixing">
      <span>
        Fixing: <button className="text-accent hover:underline" onClick={() => focusCard(fixing.cardId, task.id)}>{fixing.label}</button>
      </span>
      {task.adoptedFrom && <span>· took over another task's branch</span>}
      {task.adoptedBy && <span>· its branch went to another task</span>}
    </div>
  );
}

/** A pending question's choices as buttons, and a reply box when it accepts its own words (D17). */
export function QuestionForm({ task, question }: { task: Task; question: PendingQuestion }) {
  const answerQuestion = useAria((s) => s.answerQuestion);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (value: string, wasFreeform: boolean) => {
    if (busy || !value.trim()) return;
    setBusy(true);
    if (await answerQuestion(task.id, question.id, value.trim(), wasFreeform)) setReply((current) => (current.trim() === value.trim() ? "" : current));
    setBusy(false);
  };
  return (
    <div className="mt-2 space-y-2">
      {question.choices && question.choices.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {question.choices.map((choice) => (
            <Button key={choice} testId="question-choice" disabled={busy} onClick={() => void submit(choice, false)}>
              {choice}
            </Button>
          ))}
        </div>
      )}
      {question.allowFreeform && (
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(reply, true);
          }}
        >
          <input
            data-testid="question-reply"
            aria-label="Your answer"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Your answer…"
            className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1 text-xs outline-none focus:border-accent"
          />
          <Button testId="question-send" type="submit" primary disabled={busy || !reply.trim()}>
            <MessageSquareReply className="h-3 w-3" /> Answer
          </Button>
        </form>
      )}
    </div>
  );
}

/** A worker's question (D17): choices as buttons, and a reply box when it accepts its own words. */
export function QuestionCard({ card }: { card: Extract<CardItem, { cardType: "task_question" }> }) {
  const task = useTask(card.payload.taskId);
  const [expanded, setExpanded] = useState(false);
  const { question, answer, questionId, shortId } = card.payload;
  const pending = task?.question?.id === questionId ? task.question : undefined;
  // Your own answer (not a choice, not ARIA's answer) can become a note.
  const saveMemory = answer && card.payload.answeredBy === "you" && card.payload.freeform ? <SaveMemory text={answer} from={{ cardId: card.id }} taskId={card.payload.taskId} /> : null;
  if (!pending && !expanded) {
    return (
      <Receipt
        testId="card-question"
        cardId={card.id}
        icon={answer ? <Check className="h-3.5 w-3.5 text-ok" /> : <CircleMinus className="h-3.5 w-3.5" />}
        shortId={shortId}
        title={task?.title ?? "A task"}
        summary={
          <>
            <span data-testid="question-text">{oneLine(question)}</span>{" "}
            {answer ? (
              <>
                <span data-testid="question-answer" className="text-fg">
                  → {answer}
                </span>
                {card.payload.answeredBy === "aria" && <span data-testid="question-answered-by"> (ARIA answered)</span>}
              </>
            ) : (
              <span>· no longer waiting</span>
            )}
          </>
        }
        extras={saveMemory}
        onExpand={() => setExpanded(true)}
      />
    );
  }
  return (
    <Shell
      testId="card-question"
      cardId={card.id}
      onCollapse={pending ? undefined : () => setExpanded(false)}
      tone={pending ? "border-bad/60" : "border-line"}
      icon={<CircleQuestionMark className={`h-4 w-4 ${pending ? "text-bad" : "text-muted"}`} />}
      title={
        <span>
          <ShortId id={shortId} />
          {pending ? `${task?.title ?? "A task"} needs you` : `${task?.title ?? "A task"} asked`}
          {task && <span className="font-normal text-muted"> · {task.repoName}</span>}
        </span>
      }
      right={task && pending && <ReplyButton task={task} testId="question-reply-to" />}
    >
      <div className="mt-1 wrap-anywhere text-sm" data-testid="question-text">
        <Markdown text={question} />
      </div>
      {answer && (
        <div className="mt-1.5 flex items-baseline gap-1 text-xs text-muted">
          <span data-testid="question-answer">→ {answer}</span>
          {card.payload.answeredBy === "aria" && <span data-testid="question-answered-by">(ARIA answered)</span>}
        </div>
      )}
      {saveMemory}
      {!answer && !pending && <div className="mt-1.5 text-xs text-muted">No longer waiting for an answer.</div>}
      {task && pending && <QuestionForm key={pending.id} task={task} question={pending} />}
    </Shell>
  );
}

export function BudgetCard({ card }: { card: Extract<CardItem, { cardType: "task_budget" }> }) {
  const task = useTask(card.payload.taskId);
  const continueBudget = useAria((s) => s.continueBudget);
  const cancelTask = useAria((s) => s.cancelTask);
  const paused = task?.state === "waiting_budget";
  const add = Math.max(1, card.payload.budgetCredits);
  // Short ids start over with every start of ARIA: while it's paused, the task's own is the one that counts.
  const shortId = paused ? (task?.budgetShortId ?? card.payload.shortId) : card.payload.shortId;
  const raised = task?.budgetCredits !== undefined && task.budgetCredits > card.payload.budgetCredits;
  const outcome = paused ? " and is paused." : raised ? `. You raised its budget to ${credits(task!.budgetCredits!)}.` : task?.state === "cancelled" ? ", and you stopped it." : ".";
  return (
    <Shell
      testId="card-budget"
      cardId={card.id}
      tone={paused ? "border-warn/60" : "border-line"}
      icon={<CirclePause className="h-4 w-4 text-warn" />}
      title={
        <span>
          <ShortId id={shortId} />
          {task?.title ?? "A task"} reached its budget
        </span>
      }
    >
      <div className="mt-1 text-xs text-muted" data-testid="budget-status">
        It used {credits(card.payload.usedCredits)} of its {credits(card.payload.budgetCredits)}
        {outcome}
      </div>
      {paused && task && (
        <div className="mt-2 flex gap-1.5">
          <Button testId="budget-continue" primary onClick={() => void continueBudget(task.id, add)}>
            Continue (+{credits(add)})
          </Button>
          <Button testId="budget-stop" onClick={() => void cancelTask(task.id)}>
            Stop
          </Button>
        </div>
      )}
    </Shell>
  );
}

/** Discard, once you confirm: removes the worktree, the branch and the session (that can take a few seconds). */
function DiscardButton({ task, testId }: { task: Task; testId: string }) {
  const discardTask = useAria((s) => s.discardTask);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!confirm) {
    return (
      <Button testId={testId} onClick={() => setConfirm(true)}>
        Discard
      </Button>
    );
  }
  return (
    <>
      <Button
        testId={`${testId}-confirm`}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          // On success the task (and with it this button) goes away.
          if (!(await discardTask(task.id))) setBusy(false);
        }}
      >
        <Trash className="h-3 w-3" /> {busy ? "Deleting…" : task.where === "cloud" ? "Delete cloud session" : "Delete worktree, branch and session"}
      </Button>
      {!busy && <Button onClick={() => setConfirm(false)}>Keep</Button>}
      {/* The duck's point 9: only what's on this PC goes. */}
      {task.pr && (
        <div className="basis-full text-xs text-muted" data-testid={`${testId}-pr-note`}>
          PR #{task.pr.number} and its watch stay on GitHub ({task.pr.owner}/{task.pr.repo}): only the local branch, worktree and session go.
        </div>
      )}
    </>
  );
}

/** Open PR on a done task (or push its new commits to its PR): the task's PR card, to confirm (D19, D22, D44). */
export function OpenPrButton({ task, testId = "done-open-pr" }: { task: Task; testId?: string }) {
  const project = useAria((s) => s.projects.find((p) => p.id === task.repoId));
  const githubOff = useAria((s) => s.github.status === "off");
  const proposePr = useAria((s) => s.proposePr);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (task.state !== "done" || task.cleanedUp || githubOff || project?.host !== "github.com" || !task.branch?.startsWith("aria/") || !task.commits) return null;
  // Its PR has what it did: the button comes back when it finishes again (Continue) with more to push.
  if (task.pr && (task.finishedAt ?? 0) <= task.pr.openedAt) return null;
  return (
    <>
      <Button
        testId={testId}
        title={task.pr ? `Push the new commits to PR #${task.pr.number}: a card shows what goes first` : "A card shows exactly what's pushed and sent; nothing goes until you click there"}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(await proposePr(task.id));
          setBusy(false);
        }}
      >
        <GitPullRequest className="h-3 w-3" /> {busy ? "Looking at GitHub…" : task.pr ? "Push new commits" : "Open PR"}
      </Button>
      {error && (
        <div className="basis-full text-xs text-bad" data-testid={`${testId}-error`}>
          {error}
        </div>
      )}
    </>
  );
}

/** A task's PR, once opened: a link (its page on github.com, built by ARIA). */
export function TaskPrLink({ task, testId }: { task: Task; testId: string }) {
  if (!task.pr) return null;
  const pr = task.pr;
  return (
    <Button testId={testId} title={`${pr.owner}/${pr.repo} · ${pr.head} → ${pr.base}`} onClick={() => openPage(pr.url)}>
      <ExternalLink className="h-3 w-3" /> {pr.draft ? "Draft PR" : "PR"} #{pr.number}
    </Button>
  );
}

export function DoneCard({ card }: { card: Extract<CardItem, { cardType: "task_done" }> }) {
  const task = useTask(card.payload.taskId);
  const openTask = useAria((s) => s.openTask);
  const continueTask = useAria((s) => s.continueTask);
  const openRerunTask = useAria((s) => s.openRerunTask);
  const { summary, commits, filesChanged, additions, deletions, uncommitted, incomplete, encodingDamage } = card.payload;
  const isCloud = task?.where === "cloud";
  return (
    <Shell
      testId="card-done"
      cardId={card.id}
      tone="border-ok/50"
      icon={<span className="text-ok">✓</span>}
      title={`${task?.title ?? "A task"} is done`}
      right={task && <StateChip state={task.state} />}
    >
      {summary && (
        <div className="mt-1 wrap-anywhere text-sm" data-testid="done-summary">
          <Markdown text={summary} />
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted" data-testid="done-stats">
        {isCloud && (
          <span
            data-testid="done-cloud-badge"
            className="inline-flex items-center gap-1 rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-accent"
          >
            <Cloud className="h-3 w-3" /> Cloud
          </span>
        )}
        <span>
          {commits > 0 ? (
            <>
              {filesChanged} file{filesChanged === 1 ? "" : "s"} changed <span className="text-ok">+{additions}</span> <span className="text-bad">−{deletions}</span> in {commits} commit{commits === 1 ? "" : "s"}
            </>
          ) : isCloud ? (
            "Finished on Mission Control."
          ) : (
            "No commits."
          )}
        </span>
      </div>
      {(uncommitted > 0 || incomplete || (!isCloud && commits === 0 && !summary)) && (
        <div className="mt-1 flex items-start gap-1.5 text-xs text-warn">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {[
              incomplete ? "It went quiet without saying it had finished." : "",
              uncommitted > 0 ? `${uncommitted} change${uncommitted === 1 ? " isn't" : "s aren't"} committed.` : "",
              !isCloud && commits === 0 && !incomplete && !summary ? "It didn't commit anything." : "",
            ]
              .filter(Boolean)
              .join(" ")}
          </span>
        </div>
      )}
      {encodingDamage && <EncodingDamageNote damage={encodingDamage} task={task} testId="done-encoding" />}
      {task && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(task.where === "cloud" || task.remote) && task.missionControlUrl && (
            <Button testId="done-mission-control" onClick={() => openPage(task.missionControlUrl!)}>
              <ExternalLink className="h-3 w-3" /> Mission Control
            </Button>
          )}
          {!isCloud && (
            <Button testId="done-diff" onClick={() => openTask(task.id, "diff")}>
              <FileDiff className="h-3 w-3" /> View diff
            </Button>
          )}
          <TaskPrLink task={task} testId="done-pr-link" />
          {!isCloud && <OpenPrButton task={task} />}
          {!task.cleanedUp && (
            <Button testId="done-continue" title="Send it more instructions: it continues in its session" onClick={() => continueTask(task.id)}>
              Continue
            </Button>
          )}
          <Button testId="done-rerun" title="Rerun this brief in a fresh session with another profile or prompt" onClick={() => openRerunTask(task.id)}>
            <RotateCcw className="h-3 w-3" /> Rerun with…
          </Button>
          {!task.cleanedUp && <ReplyButton task={task} testId="done-reply" />}
          <DiscardButton task={task} testId="done-discard" />
        </div>
      )}
    </Shell>
  );
}

export function FailedCard({ card }: { card: Extract<CardItem, { cardType: "task_failed" }> }) {
  const task = useTask(card.payload.taskId);
  const openTask = useAria((s) => s.openTask);
  const retryTask = useAria((s) => s.retryTask);
  const openRerunTask = useAria((s) => s.openRerunTask);
  return (
    <Shell testId="card-failed" cardId={card.id} tone="border-bad/50" icon={<CircleAlert className="h-4 w-4 text-bad" />} title={`${task?.title ?? "A task"} failed`} right={task && <StateChip state={task.state} />}>
      <div className="mt-1 whitespace-pre-wrap wrap-anywhere text-xs text-muted">{card.payload.error}</div>
      {task && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(task.where === "cloud" || task.remote) && task.missionControlUrl && (
            <Button testId="failed-mission-control" onClick={() => openPage(task.missionControlUrl!)}>
              <ExternalLink className="h-3 w-3" /> Mission Control
            </Button>
          )}
          {task.state === "failed" && !task.cleanedUp && (
            <Button testId="failed-retry" primary onClick={() => void retryTask(task.id)}>
              <RotateCcw className="h-3 w-3" /> Retry
            </Button>
          )}
          <Button testId="failed-rerun" onClick={() => openRerunTask(task.id)}>
            Rerun with…
          </Button>
          <Button onClick={() => openTask(task.id)}>Open</Button>
          <DiscardButton task={task} testId="failed-discard" />
        </div>
      )}
    </Shell>
  );
}

export function InterruptedCard({ card }: { card: Extract<CardItem, { cardType: "tasks_interrupted" }> }) {
  const all = useAria((s) => s.tasks);
  const resume = useAria((s) => s.resumeInterrupted);
  const dismiss = useAria((s) => s.dismissInterrupted);
  const tasks = all.filter((t) => card.payload.taskIds.includes(t.id));
  const waiting = tasks.filter((t) => t.state === "interrupted");
  const count = card.payload.taskIds.length;
  return (
    <Shell testId="card-interrupted" cardId={card.id} tone={waiting.length ? "border-warn/60" : "border-line"} icon={<TimerReset className="h-4 w-4 text-warn" />} title={`${count} task${count === 1 ? " was" : "s were"} interrupted when ${card.payload.cause === "runtime" ? "the Copilot runtime stopped" : "ARIA closed"}`}>
      <ul className="mt-1 list-inside list-disc text-xs text-muted">
        {tasks.map((t: Task) => (
          <li key={t.id}>
            {t.title} · {t.repoName}
          </li>
        ))}
      </ul>
      {waiting.length > 0 && (
        <div className="mt-2 flex gap-1.5">
          <Button testId="interrupted-resume" primary onClick={() => void resume()}>
            Resume {waiting.length === 1 ? "it" : "all"}
          </Button>
          <Button testId="interrupted-dismiss" onClick={() => void dismiss()}>
            Stop {waiting.length === 1 ? "it" : "them"}
          </Button>
        </div>
      )}
    </Shell>
  );
}

/** Profile policy "Ask me" (§4.12): ARIA proposes a task and a profile; it starts when you press Start. */
export function ProposalCard({ card }: { card: Extract<CardItem, { cardType: "profile_proposal" }> }) {
  const profiles = useAria((s) => s.profiles);
  const agents = useAria(selectAgents);
  const startProposal = useAria((s) => s.startProposal);
  const dismissProposal = useAria((s) => s.dismissProposal);
  const openTask = useAria((s) => s.openTask);
  const p = card.payload;
  const [profileId, setProfileId] = useState(p.profileId);
  const chosen = profiles.find((x) => x.id === profileId);
  const [agent, setAgent] = useState(p.agent ?? chosen?.agent ?? "");
  const [agentTouched, setAgentTouched] = useState(Boolean(p.agent));
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const act = async (action: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true);
    await action();
    setBusy(false);
  };
  const openStarted =
    p.decision === "started" && p.taskId ? (
      <Button testId="proposal-open" onClick={() => openTask(p.taskId!)}>
        Open
      </Button>
    ) : null;
  const agentBadge =
    p.decision === "started" && p.agent ? (
      <span data-testid="proposal-agent-badge" className="inline-flex items-center gap-1 rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-fg">
        <UserRoundCog className="h-3 w-3 text-accent" /> {p.agent}
      </span>
    ) : null;
  if (p.decision && !expanded) {
    return (
      <Receipt
        testId="card-proposal"
        cardId={card.id}
        icon={p.decision === "started" ? <Check className="h-3.5 w-3.5 text-ok" /> : <CircleMinus className="h-3.5 w-3.5" />}
        title={`${p.decision === "started" ? "Started" : "Dismissed"}: ${p.title}`}
        summary={
          <>
            <span>{p.repoName}</span>
            <span> · </span>
            <span data-testid="proposal-decision">{p.decision === "started" ? `With ${p.profileName} (${modelLabel(p)}).` : "Nothing was started."}</span>
          </>
        }
        actions={
          (agentBadge || openStarted) && (
            <span className="flex shrink-0 items-center gap-1.5">
              {agentBadge}
              {openStarted}
            </span>
          )
        }
        onExpand={() => setExpanded(true)}
      />
    );
  }
  return (
    <Shell
      testId="card-proposal"
      cardId={card.id}
      onCollapse={p.decision ? () => setExpanded(false) : undefined}
      tone={p.decision ? "border-line" : "border-accent/60"}
      icon={<Sparkles className="h-4 w-4 text-accent" />}
      title={
        <span>
          {p.decision === "started" ? "Started" : p.decision === "dismissed" ? "Dismissed" : "ARIA proposes"}: {p.title}
          <span className="font-normal text-muted"> · {p.repoName}</span>
          {p.where === "cloud" && (
            <span
              data-testid="proposal-cloud-badge"
              className="ml-2 inline-flex items-center gap-1 rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-accent"
            >
              <Cloud className="h-3 w-3" /> Cloud
            </span>
          )}
        </span>
      }
    >
      <details className="mt-1 text-sm" open={!p.decision}>
        <summary className="cursor-pointer text-xs text-muted">The brief</summary>
        <div className="mt-1 max-h-60 overflow-auto wrap-anywhere rounded bg-canvas px-2.5 py-1.5 text-xs" data-testid="proposal-brief">
          <Markdown text={p.brief} />
        </div>
      </details>
      {p.allowedPaths?.length ? (
        <div className="mt-1 wrap-anywhere text-xs text-muted" data-testid="proposal-paths">
          Can also read: <span className="font-mono">{p.allowedPaths.join(", ")}</span>
        </div>
      ) : null}
      {p.decision ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted" data-testid="proposal-decision">
          <span>{p.decision === "started" ? `With ${p.profileName} (${modelLabel(p)}).` : "Nothing was started."}</span>
          {agentBadge}
          {openStarted}
        </div>
      ) : (
        <div className="mt-2 space-y-1.5">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-muted">
              Profile
              <select
                data-testid="proposal-profile"
                value={profileId}
                onChange={(e) => {
                  const nextId = e.target.value;
                  setProfileId(nextId);
                  const nextProfile = profiles.find((x) => x.id === nextId);
                  if (nextProfile && !agentTouched) {
                    setAgent(nextProfile.agent ?? "");
                  }
                }}
                className="rounded border border-line bg-canvas px-1.5 py-0.5 text-xs text-fg outline-none focus:border-accent"
              >
                {!profiles.some((x) => x.id === p.profileId) && <option value={p.profileId}>{p.profileName}</option>}
                {profiles.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} · {modelLabel(x)}
                  </option>
                ))}
              </select>
              {chosen?.budgetCredits ? <span>pauses at {credits(chosen.budgetCredits)}</span> : null}
            </label>
            <label className="flex items-center gap-2 text-xs text-muted">
              Agent
              <select
                data-testid="proposal-agent"
                value={agent}
                onChange={(e) => {
                  setAgentTouched(true);
                  setAgent(e.target.value);
                }}
                className="max-w-[16rem] truncate rounded border border-line bg-canvas px-1.5 py-0.5 text-xs text-fg outline-none focus:border-accent"
              >
                <AgentSelectOptions agents={agents} currentAgent={agent} />
              </select>
            </label>
          </div>
          {p.reason && profileId === p.profileId && <div className="text-xs text-muted">Why {p.profileName}: {p.reason}</div>}
          <div className="flex gap-1.5">
            <Button
              testId="proposal-start"
              primary
              disabled={busy}
              onClick={() => void act(() => startProposal(card.id, profileId, agent || null))}
            >
              Start
            </Button>
            <Button testId="proposal-dismiss" disabled={busy} onClick={() => void act(() => dismissProposal(card.id))}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
    </Shell>
  );
}
