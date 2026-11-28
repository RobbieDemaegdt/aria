// A worker's asks for your decision: something the policy doesn't allow on its own, and a plan to review.
import type { CardItem, PendingPermission, PendingPlan, PermissionDecision, PlanDecision, Task } from "@aria/protocol";
import { Check, CircleMinus, ClipboardList, ShieldAlert, Square } from "lucide-react";
import { useState } from "react";
import { useAria } from "../store";
import { AlwaysAllow } from "./Flow";
import { Markdown } from "./Markdown";
import { Button, oneLine, Receipt, Shell, ShortId, useTask } from "./CardParts";

const PERMISSION_DECIDED: Record<PermissionDecision | "expired", string> = {
  once: "Approved once",
  task: "Approved for the rest of the task",
  always: "Saved as an exact sandbox exception",
  reject: "Rejected",
  expired: "No longer waiting",
};

/** Approve once, for the task, a persistent sandbox resource, or reject with a note. */
export function PermissionActions({ task, pending }: { task: Task; pending: PendingPermission }) {
  const decide = useAria((s) => s.decidePermission);
  const [rejecting, setRejecting] = useState(false);
  const [confirmingAlways, setConfirmingAlways] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (decision: PermissionDecision) => {
    if (busy) return;
    setBusy(true);
    // On success the request goes away (and these buttons with it).
    await decide(task.id, pending.id, decision, decision === "reject" ? note : undefined);
    setBusy(false);
  };
  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        <Button testId="permission-once" primary disabled={busy} title="It may do this now, and asks again next time" onClick={() => void act("once")}>
          Approve once
        </Button>
        {/* A destructive command asks every time (D29): there's nothing to approve for the task. */}
        {!pending.everyTime && (
          <Button testId="permission-task" disabled={busy} title={`It may ${pending.scope} again without asking, until the task ends`} onClick={() => void act("task")}>
            Approve for this task
          </Button>
        )}
        {pending.sandbox?.persistent && !pending.everyTime && !confirmingAlways && (
          <Button testId="permission-always" disabled={busy} title="Save this exact sandbox resource, then confirm it" onClick={() => setConfirmingAlways(true)}>
            Always allow this…
          </Button>
        )}
        {!rejecting && (
          <Button testId="permission-reject" disabled={busy} title="It carries on without it" onClick={() => setRejecting(true)}>
            Reject…
          </Button>
        )}
      </div>
      {confirmingAlways && pending.sandbox && (
        <div className="rounded-md border border-warn/40 bg-canvas p-2 text-xs text-muted" data-testid="permission-always-confirm">
          Save an exact exception for <span className="break-all font-mono text-fg">{pending.sandbox.target}</span>? This applies to future sandboxed tasks and can be removed in Customize › Permissions.
          <div className="mt-2 flex gap-1.5">
            <Button testId="permission-always-confirm-button" primary disabled={busy} onClick={() => void act("always")}>Save and allow</Button>
            <Button onClick={() => setConfirmingAlways(false)}>Back</Button>
          </div>
        </div>
      )}
      {rejecting && (
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void act("reject");
          }}
        >
          <input
            data-testid="permission-note"
            aria-label="What it should do instead (optional)"
            autoFocus
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setRejecting(false);
              }
            }}
            placeholder="What it should do instead (optional)"
            className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1 text-xs outline-none focus:border-accent"
          />
          <Button testId="permission-reject-confirm" type="submit" disabled={busy}>
            Reject
          </Button>
          <Button onClick={() => setRejecting(false)}>Back</Button>
        </form>
      )}
      {pending.everyTime ? (
        <div className="text-[11px] text-warn" data-testid="permission-every-time">
          {pending.sandbox ? "ARIA can't identify a stable resource for this sandbox block, so it asks every time: approve this exact attempt once, or reject it." : pending.kind === "mcp" ? "This tool changes things outside the task, so it asks every time: approve it once, or reject it." : "It's destructive, so it asks every time: approve it once, or reject it."}
        </div>
      ) : (
        <div className="text-[11px] text-muted">Approve for this task lets it {pending.scope} again without asking, until the task ends. You can undo that in the task's view.</div>
      )}
    </div>
  );
}

/** A worker wants to do something the policy doesn't allow on its own (§4.8): what, where, why, and your decision. */
export function PermissionCard({ card }: { card: Extract<CardItem, { cardType: "task_permission" }> }) {
  const task = useTask(card.payload.taskId);
  const openTask = useAria((s) => s.openTask);
  const p = card.payload;
  const [expanded, setExpanded] = useState(false);
  const pending = task?.permissions?.find((x) => x.id === p.permissionId);
  const decided = p.decision ?? (pending ? undefined : "expired");
  const decision = decided && (
    <span data-testid="permission-decision">
      {PERMISSION_DECIDED[decided]}
      {p.note ? `: ${p.note}` : ""}
    </span>
  );
  const undo =
    decided === "task" && task && !task.cleanedUp && task.grants?.length ? (
      <button data-testid="permission-undo" className="ml-2 shrink-0 text-accent hover:underline" onClick={() => openTask(task.id)}>
        Undo in the task's view
      </button>
    ) : null;
  // Offered only where ARIA worked out a rule: never for a fixed rule's refusal or a destructive command.
  const alwaysAllow = decided && p.offerId && task ? <AlwaysAllow taskId={task.id} offerId={p.offerId} /> : null;
  if (decided && !expanded) {
    return (
      <Receipt
        testId="card-permission"
        cardId={card.id}
        icon={decided === "once" || decided === "task" || decided === "always" ? <Check className="h-3.5 w-3.5 text-ok" /> : <CircleMinus className="h-3.5 w-3.5" />}
        shortId={p.shortId}
        title={task?.title ?? "A task"}
        summary={
          <>
            {decision} <span className="font-mono text-fg/80">{oneLine(p.what)}</span>
          </>
        }
        actions={undo}
        extras={alwaysAllow}
        onExpand={() => setExpanded(true)}
      />
    );
  }
  return (
    <Shell
      testId="card-permission"
      cardId={card.id}
      onCollapse={decided ? () => setExpanded(false) : undefined}
      tone={pending ? "border-bad/60" : "border-line"}
      icon={<ShieldAlert className={`h-4 w-4 ${pending ? "text-bad" : "text-muted"}`} />}
      title={
        <span>
          <ShortId id={p.shortId} />
          {task?.title ?? "A task"} {pending ? (p.sandbox ? "was blocked by the sandbox" : "needs your approval") : (p.sandbox ? "hit a sandbox block" : "asked for approval")}
          {task && <span className="font-normal text-muted"> · {task.repoName}</span>}
        </span>
      }
    >
      <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-canvas px-2 py-1 font-mono text-xs" data-testid="permission-what">
        {p.what}
      </pre>
      <div className="mt-1 space-y-0.5 text-xs text-muted">
        {p.why && <div>For: {p.why}</div>}
        {p.where && <div className="truncate">In: {p.where}</div>}
        <div data-testid="permission-reason">{p.reason}</div>
        {p.sandbox && <div className="text-warn" data-testid="permission-sandbox-risk">Allowing this exception would {p.sandbox.label}.</div>}
        {!p.sandboxed && <div className="text-warn">This task isn't sandboxed: what you approve runs with your own access to this PC.</div>}
      </div>
      {decided && (
        <div className="mt-1.5 text-xs text-muted">
          {decision}
          {undo}
        </div>
      )}
      {alwaysAllow}
      {task && pending && <PermissionActions key={pending.id} task={task} pending={pending} />}
    </Shell>
  );
}

const PLAN_DECIDED: Record<PlanDecision | "expired", string> = {
  autopilot: "Approved: it carries it out on autopilot",
  interactive: "Approved: it carries it out step by step",
  revise: "You asked for a revision",
  cancel: "You stopped the task",
  expired: "No longer waiting",
};

/** Approve a plan (autopilot or step by step), ask for a revision, or cancel the task. */
export function PlanActions({ task, plan }: { task: Task; plan: PendingPlan }) {
  const review = useAria((s) => s.reviewPlan);
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (decision: PlanDecision) => {
    if (busy) return;
    setBusy(true);
    await review(task.id, plan.id, decision, decision === "revise" ? feedback : undefined);
    setBusy(false);
  };
  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        <Button testId="plan-autopilot" primary disabled={busy} title="It carries out the plan until it's done" onClick={() => void act("autopilot")}>
          Approve
        </Button>
        <Button testId="plan-interactive" disabled={busy} title="It carries out the plan and stops after each reply" onClick={() => void act("interactive")}>
          Approve, step by step
        </Button>
        {!revising && (
          <Button testId="plan-revise" disabled={busy} title="Ask the agent to revise the plan before implementation" onClick={() => setRevising(true)}>
            Revise…
          </Button>
        )}
        <Button testId="plan-cancel" disabled={busy} title="Stop the task (you can continue it later from its view)" onClick={() => void act("cancel")}>
          <Square className="h-3 w-3" /> Stop
        </Button>
      </div>
      {revising && (
        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (feedback.trim()) void act("revise");
          }}
        >
          <textarea
            data-testid="plan-feedback"
            aria-label="What to change in the plan"
            autoFocus
            rows={2}
            value={feedback}
            maxLength={5000}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setRevising(false);
              } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (feedback.trim()) void act("revise");
              }
            }}
            placeholder="What to change in the plan (Enter to send, Shift+Enter for new line)"
            className="w-full resize-y rounded-md border border-line bg-canvas px-2 py-1 text-xs outline-none focus:border-accent"
          />
          <div className="flex gap-1.5">
            <Button testId="plan-revise-send" type="submit" primary disabled={busy || !feedback.trim()}>
              Send for revision
            </Button>
            <Button onClick={() => setRevising(false)}>Back</Button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * A worker in plan mode wrote its plan. While it waits: a three-line preview, "Open plan" (the Plan tab, where you read
 * the whole plan) and your review (docs/chat-compact-cards-option-1-plan.md). Once handled: a receipt that opens to
 * the summary and the plan, so an older, revised plan stays readable.
 */
export function PlanCard({ card }: { card: Extract<CardItem, { cardType: "task_plan" }> }) {
  const task = useTask(card.payload.taskId);
  const openTask = useAria((s) => s.openTask);
  const p = card.payload;
  const [expanded, setExpanded] = useState(false);
  const pending = task?.plan?.id === p.planId ? task.plan : undefined;
  const decided = p.decision ?? (pending ? undefined : "expired");
  const hasSummary = p.summary.trim() !== "" && p.summary.trim() !== "(no summary)";
  if (decided && !expanded) {
    return (
      <Receipt
        testId="card-plan"
        cardId={card.id}
        icon={decided === "autopilot" || decided === "interactive" ? <Check className="h-3.5 w-3.5 text-ok" /> : <CircleMinus className="h-3.5 w-3.5" />}
        shortId={p.shortId}
        title={task?.title ?? "A task"}
        summary={
          <>
            <span data-testid="plan-decision">
              {PLAN_DECIDED[decided]}
              {p.feedback && decided === "revise" ? `: ${oneLine(p.feedback, 80)}` : ""}
            </span>
            <span> · </span>
            <span data-testid="plan-summary">{oneLine(p.summary)}</span>
          </>
        }
        onExpand={() => setExpanded(true)}
      />
    );
  }
  return (
    <Shell
      testId="card-plan"
      cardId={card.id}
      onCollapse={decided ? () => setExpanded(false) : undefined}
      tone={pending ? "border-bad/60" : "border-line"}
      icon={<ClipboardList className={`h-4 w-4 ${pending ? "text-bad" : "text-muted"}`} />}
      title={
        <span>
          <ShortId id={p.shortId} />
          {task?.title ?? "A task"} {pending ? "has a plan for you to review" : "made a plan"}
          {task && <span className="font-normal text-muted"> · {task.repoName}</span>}
        </span>
      }
      right={
        task && (
          <Button testId="plan-open-session" accent={Boolean(pending)} title="Read the whole plan in the session's Plan tab" onClick={() => openTask(task.id, "plan")}>
            Open plan
          </Button>
        )
      }
    >
      {pending ? (
        <div className="mt-1 line-clamp-3 wrap-anywhere text-sm text-muted" data-testid="plan-summary">
          {oneLine(hasSummary ? p.summary : (p.plan ?? p.summary), 400)}
        </div>
      ) : (
        <>
          <div className="mt-1 max-h-48 overflow-y-auto text-sm" data-testid="plan-summary">
            <Markdown text={p.summary} />
          </div>
          {p.plan && (
            <details className="mt-1.5 text-sm">
              <summary className="cursor-pointer text-xs text-muted">The plan</summary>
              <div className="mt-1 max-h-80 overflow-auto rounded bg-canvas px-2 py-1">
                <Markdown text={p.plan} />
              </div>
            </details>
          )}
        </>
      )}
      {decided && (
        <div className="mt-1.5 text-xs text-muted" data-testid="plan-decision">
          {PLAN_DECIDED[decided]}
          {p.feedback && decided === "revise" ? `: ${p.feedback}` : ""}
        </div>
      )}
      {task && pending && <PlanActions key={pending.id} task={task} plan={pending} />}
    </Shell>
  );
}
