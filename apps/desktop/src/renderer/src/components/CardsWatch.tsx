// What the watchers bring in (PLAN.md §4.6, §5.4): GitHub's cards, snapshots drawn as plain text, and the task tracker's updates.
import type { CardItem, FixRecord, Task } from "@aria/protocol";
import {
  Bell,
  Briefcase,
  Check,
  CircleAlert,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Mail,
  UserRoundCog,
  MessageSquareReply,
  Sparkles,
  TimerReset,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { useAria, useTracker } from "../store";
import { Markdown } from "./Markdown";
import { credits, duration, modelLabel } from "./tasks";
import { openPage } from "../openPage";
import { askAboutTaskPrefill, trackerLabel, trackerRef } from "../tracker";
import { Button, Shell, useTask } from "./CardParts";

const RUN_WORDS: Record<string, string> = {
  success: "succeeded",
  failure: "failed",
  cancelled: "was cancelled",
  timed_out: "timed out",
  action_required: "needs an approval",
  startup_failure: "failed to start",
  neutral: "finished",
  skipped: "was skipped",
  stale: "went stale",
};

export function CiCard({ card }: { card: Extract<CardItem, { cardType: "ci" }> }) {
  const p = card.payload;
  const watch = useAria((s) => s.watches.find((w) => w.id === p.watchId));
  const unwatch = useAria((s) => s.unwatch);
  const dismissCard = useAria((s) => s.dismissCard);
  const [error, setError] = useState<string | null>(null);
  const ok = p.outcome === "success";
  const what =
    p.source === "branch"
      ? p.summary.endsWith("green again")
        ? `${p.title} is green again`
        : ok
          ? `${p.title}: ${p.summary}`
          : `${p.title} is red`
      : p.source === "checks"
        ? `Checks on PR #${p.prNumber ?? "?"} ${ok ? "passed" : "failed"}`
        : `${p.title} ${RUN_WORDS[p.conclusion] ?? "finished"}`;
  const healthWatch = p.source === "branch" && watch?.state === "active" && watch.until === "forever";
  return (
    <Shell
      testId="card-ci"
      cardId={card.id}
      tone={ok ? "border-ok/50" : p.fix ? "border-line" : "border-bad/50"}
      icon={ok ? <Check className="h-4 w-4 text-ok" /> : <CircleAlert className={`h-4 w-4 ${p.fix ? "text-muted" : "text-bad"}`} />}
      title={
        <span data-testid="ci-title">
          CI · {what} <span className="font-normal text-muted">· {p.repoName}</span>
        </span>
      }
      right={p.durationMs !== undefined ? <span className="shrink-0 text-xs text-muted">{duration(p.durationMs)}</span> : undefined}
    >
      <div className="mt-1 text-xs text-muted" data-testid="ci-summary">
        {p.summary}
        {p.branch && p.source !== "branch" && (
          <span className="ml-2 inline-flex items-center gap-1">
            <GitBranch className="h-3 w-3" />
            {p.branch}
          </span>
        )}
      </div>
      {p.failed && p.failed.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-xs" data-testid="ci-failed">
          {p.failed.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-1.5">
              <CircleAlert className="h-3 w-3 shrink-0 text-bad" />
              <span className="truncate">{f.name}</span>
              <span className="text-muted">· {f.conclusion.replace(/_/g, " ")}</span>
              {f.url && (
                <button className="ml-1 text-accent hover:underline" onClick={() => openPage(f.url!)}>
                  Open
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!ok && <FixItRow card={card} />}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button testId="ci-open" onClick={() => openPage(p.url)}>
          <ExternalLink className="h-3 w-3" /> {p.source === "checks" ? "Open PR checks" : "Open on GitHub"}
        </Button>
        {healthWatch && (
          <Button testId="ci-unwatch" title={`Stop watching ${p.title}'s CI (${watch.shortId})`} onClick={() => void unwatch(watch.id).then(setError)}>
            Stop watching
          </Button>
        )}
        <Button testId="ci-dismiss" title="Clear this CI card from the chat" onClick={() => void dismissCard(card.id).then(setError)}>
          Dismiss
        </Button>
      </div>
      {error && <div className="mt-1 text-xs text-bad">{error}</div>}
    </Shell>
  );
}

/** The task a CI or review card's fix would go to, as the window knows it (the engine decides: D45, D46). */
function useFixOwner(p: { owner: string; repo: string; repoName: string; prNumber?: number; branch?: string }): Task | undefined {
  return useAria((s) =>
    s.tasks.find(
      (t) =>
        !t.adoptedBy &&
        ((p.prNumber !== undefined && t.pr?.number === p.prNumber && t.pr.owner.toLowerCase() === p.owner.toLowerCase() && t.pr.repo.toLowerCase() === p.repo.toLowerCase()) ||
          (p.branch !== undefined && p.branch.startsWith("aria/") && t.branch === p.branch && t.repoName === p.repoName)),
    ),
  );
}

/** What a fix did, on its card: the task (Open), how, and ARIA's notes (D49's "no log" first). */
function FixRecordLine({ fix, testId }: { fix: FixRecord; testId: string }) {
  const openTask = useAria((s) => s.openTask);
  const task = useTask(fix.taskId);
  const how = fix.how === "continue" ? "Sent to" : fix.how === "adopt" ? "A new task took over the branch:" : "A new task:";
  return (
    <div className="mt-1.5 space-y-0.5 text-xs" data-testid={testId} data-how={fix.how}>
      {fix.logs === "none" && (
        <div className="flex items-center gap-1.5 font-medium text-warn" data-testid={`${testId}-no-log`}>
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" /> No log: the task works from the failed steps' names and the code.
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-muted">
        <span>
          {how} <span className="text-fg">{task?.title ?? fix.taskTitle}</span>
          {task ? ` · ${task.profileName} · ${modelLabel(task)}${task.budgetCredits !== undefined ? ` · budget ${credits(task.budgetCredits)}` : ""}` : ""}
        </span>
        {task && (
          <Button testId={`${testId}-open`} onClick={() => openTask(task.id)}>
            Open task
          </Button>
        )}
      </div>
      {fix.notes?.map((note) => (
        <div key={note} className="text-muted">
          {note}
        </div>
      ))}
    </div>
  );
}

/** Fix it on a red CI card (D45–D49): where it would go, then the click; afterwards, where it went. */
function FixItRow({ card }: { card: Extract<CardItem, { cardType: "ci" }> }) {
  const p = card.payload;
  const fixCi = useAria((s) => s.fixCi);
  const project = useAria((s) => s.projects.find((x) => x.owner?.toLowerCase() === p.owner.toLowerCase() && x.repo?.toLowerCase() === p.repo.toLowerCase()));
  const ciFix = useAria((s) => s.profiles.find((x) => x.id === s.ciFixProfileId) ?? s.profiles.find((x) => x.isDefault));
  const owner = useFixOwner({ owner: p.owner, repo: p.repo, repoName: p.repoName, ...(p.prNumber !== undefined ? { prNumber: p.prNumber } : {}), ...(p.branch !== undefined ? { branch: p.branch } : {}) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const defaultBranch = p.branch !== undefined && project?.defaultBranch === p.branch && p.source !== "checks";
  if (!owner && !defaultBranch) {
    return (
      <div className="mt-1.5 text-xs text-muted" data-testid="ci-fix-unavailable">
        Fix it works on ARIA's own branches and your default branch.
      </div>
    );
  }
  const takesOver = owner && (owner.cleanedUp || owner.state === "waiting_budget");
  const where = owner
    ? takesOver
      ? `A new task takes over ${owner.title}'s branch · ${ciFix?.name ?? "Default"} · ${ciFix?.model ?? ""}`
      : `Continues ${owner.title} · ${owner.profileName} · ${modelLabel(owner)}${owner.budgetCredits !== undefined ? ` · budget ${credits(owner.budgetCredits)}` : ""}`
    : `A new task on a new branch from ${p.branch}${p.headSha ? ` at ${p.headSha.slice(0, 7)}` : ""} · ${ciFix?.name ?? "Default"} · ${ciFix?.model ?? ""}`;
  return (
    <div className="mt-1.5">
      {p.fix && <FixRecordLine fix={p.fix} testId="ci-fix" />}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Button
          testId="ci-fix-it"
          primary={!p.fix}
          disabled={busy}
          title="The failing jobs' logs go to the task as untrusted data; nothing is pushed (Push new commits does that)."
          onClick={async () => {
            setBusy(true);
            setError(await fixCi(card.id));
            setBusy(false);
          }}
        >
          <Sparkles className="h-3 w-3" /> {busy ? "Reading the logs…" : p.fix ? "Fix it again" : "Fix it"}
        </Button>
        <span className="text-xs text-muted" data-testid="ci-fix-where">
          {where}
        </span>
      </div>
      {!owner && <div className="mt-0.5 text-[11px] text-muted">The CI fix profile ("Fix it uses", Customize › Models) is for new tasks; a task that continues keeps its own.</div>}
      {error && (
        <div className="mt-1 text-xs text-bad" data-testid="ci-fix-error">
          {error}
        </div>
      )}
    </div>
  );
}

/** Address comments on a review card (D50, D51): the review and its inline comments go to the PR's task. */
function AddressRow({ card }: { card: Extract<CardItem, { cardType: "pr" }> }) {
  const p = card.payload;
  const addressReview = useAria((s) => s.addressReview);
  const owner = useFixOwner({ owner: p.owner, repo: p.repo, repoName: p.repoName, prNumber: p.number });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tickNeeded, setTickNeeded] = useState(false);
  const [ticked, setTicked] = useState(false);
  if (!owner) return null;
  return (
    <div className="mt-1.5">
      {p.fix && <FixRecordLine fix={p.fix} testId="pr-address" />}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Button
          testId="pr-address-comments"
          primary={!p.fix}
          disabled={busy || (tickNeeded && !ticked)}
          title="This review's text and its inline comments go to the task as untrusted data; nothing is pushed."
          onClick={async () => {
            setBusy(true);
            const failed = await addressReview(card.id, ticked);
            if (failed && /Tick that you've read/.test(failed)) setTickNeeded(true);
            setError(failed);
            setBusy(false);
          }}
        >
          <MessageSquareReply className="h-3 w-3" /> {busy ? "Reading the review…" : p.fix ? "Address again" : "Address comments"}
        </Button>
        <span className="text-xs text-muted">
          {owner.cleanedUp || owner.state === "waiting_budget" ? `A new task takes over ${owner.title}'s branch` : `Continues ${owner.title} · ${owner.profileName} · ${modelLabel(owner)}`}
        </span>
      </div>
      <div className="mt-0.5 text-[11px] text-muted">Only this review's text and its inline comments go: the PR's conversation comments don't.</div>
      {tickNeeded && (
        <label className="mt-1 inline-flex items-center gap-1.5 text-xs text-warn">
          <input type="checkbox" data-testid="pr-address-tick" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
          I've read this review: it's safe to hand to the task
        </label>
      )}
      {error && (
        <div className="mt-1 text-xs text-bad" data-testid="pr-address-error">
          {error}
        </div>
      )}
    </div>
  );
}

/** ARIA proposes Fix it or Address comments (D48): where it goes and with what (never the text); Start is yours. */
export function FixProposalCard({ card }: { card: Extract<CardItem, { cardType: "fix_proposal" }> }) {
  const p = card.payload;
  const start = useAria((s) => s.startFixProposal);
  const dismiss = useAria((s) => s.dismissFixProposal);
  const focusCard = useAria((s) => s.focusCard);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticked, setTicked] = useState(false);
  const plan = p.plan;
  const where = plan.how === "continue" ? `Continues ${plan.taskTitle}` : plan.how === "adopt" ? `A new task takes over ${plan.taskTitle}'s branch` : `A new task on a new branch from ${plan.branch}`;
  const act = async (call: () => Promise<string | null>) => {
    setBusy(true);
    setError(await call());
    setBusy(false);
  };
  return (
    <Shell
      testId="card-fix-proposal"
      cardId={card.id}
      tone={p.status === "pending" ? "border-accent/60" : p.status === "failed" ? "border-bad/50" : "border-line"}
      icon={<Sparkles className="h-4 w-4 text-accent" />}
      title={
        <span data-testid="fix-proposal-title" data-status={p.status}>
          ARIA proposes {p.kind === "ci" ? "Fix it" : "Address comments"} <span className="font-normal text-muted">· {p.target} · {p.repoName}</span>
        </span>
      }
    >
      <div className="mt-1 space-y-0.5 text-xs text-muted" data-testid="fix-proposal-plan">
        <div>
          {where} · {plan.profile} · {plan.model}
          {plan.reasoningEffort ? ` · ${plan.reasoningEffort}` : ""}
          {plan.budgetCredits !== undefined ? ` · budget ${credits(plan.budgetCredits)}` : ""}
        </div>
        <div>
          For <span className="font-mono">{plan.sha.slice(0, 7)}</span> on <span className="font-mono">{plan.branch}</span>. {p.kind === "ci" ? "The failing jobs' logs" : "The review's text and its inline comments"} go to the task as untrusted data when you press Start (they're read again then); ARIA never sees them.
        </div>
        {plan.notes.map((note) => (
          <div key={note}>{note}</div>
        ))}
      </div>
      {plan.needsTick && p.status === "pending" && (
        <label className="mt-1 inline-flex items-center gap-1.5 text-xs text-warn">
          <input type="checkbox" data-testid="fix-proposal-tick" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
          {plan.needsTick} I've read it: it's safe to hand to the task
        </label>
      )}
      {p.result && <FixRecordLine fix={p.result} testId="fix-proposal-result" />}
      {(p.error || error) && (
        <div className="mt-1 text-xs text-bad" data-testid="fix-proposal-error">
          {error ?? p.error}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {p.status === "pending" && (
          <Button testId="fix-proposal-start" primary disabled={busy || (plan.needsTick !== undefined && !ticked)} onClick={() => void act(() => start(card.id, p.revision, ticked))}>
            Start
          </Button>
        )}
        {(p.status === "pending" || p.status === "failed") && (
          <Button testId="fix-proposal-dismiss" disabled={busy} onClick={() => void act(() => dismiss(card.id))}>
            Dismiss
          </Button>
        )}
        <Button onClick={() => focusCard(p.cardId)}>Show its card</Button>
      </div>
    </Shell>
  );
}

const PR_TITLES: Record<string, (by: string, n: number) => string> = {
  approved: (by, n) => `PR #${n} approved by ${by}`,
  changes_requested: (by, n) => `PR #${n}: changes requested by ${by}`,
  commented: (by, n) => `${by} commented on PR #${n}`,
  review_requested: (_by, n) => `Review requested: PR #${n}`,
  merged: (_by, n) => `PR #${n} was merged`,
  closed: (_by, n) => `PR #${n} was closed`,
};

export function PrCard({ card }: { card: Extract<CardItem, { cardType: "pr" }> }) {
  const p = card.payload;
  const bad = p.event === "changes_requested";
  const good = p.event === "approved" || p.event === "merged";
  return (
    <Shell
      testId="card-pr"
      cardId={card.id}
      tone={bad ? "border-warn/60" : good ? "border-ok/50" : "border-line"}
      icon={<GitPullRequest className={`h-4 w-4 ${bad ? "text-warn" : good ? "text-ok" : "text-muted"}`} />}
      title={
        <span data-testid="pr-title">
          {PR_TITLES[p.event]?.(p.by ?? "someone", p.number) ?? `PR #${p.number}`}
          {p.yours ? " (by you)" : ""} <span className="font-normal text-muted">· {p.repoName}</span>
        </span>
      }
    >
      <div className="mt-1 truncate text-xs text-muted" data-testid="pr-subject">
        {p.title}
      </div>
      {p.body && (
        <div className="mt-1.5 max-h-40 overflow-auto wrap-anywhere rounded bg-canvas px-2 py-1 text-xs" data-testid="pr-body">
          <Markdown text={p.body} />
        </div>
      )}
      {(p.event === "changes_requested" || p.event === "commented") && p.reviewId !== undefined && <AddressRow card={card} />}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button testId="pr-open" onClick={() => openPage(p.url)}>
          <ExternalLink className="h-3 w-3" /> Open PR
        </Button>
      </div>
    </Shell>
  );
}

export function GitHubAccountCard({ card }: { card: Extract<CardItem, { cardType: "github_account" }> }) {
  const p = card.payload;
  const login = useAria((s) => s.github.login);
  const stillPaused = useAria((s) => (p.from ? s.watches.filter((w) => p.watchIds.includes(w.id) && w.state === "active" && w.account === p.from).length : 0));
  const rebindWatches = useAria((s) => s.useGitHubAccount);
  const switchGhAccount = useAria((s) => s.switchGitHubAccount);
  const dismissCard = useAria((s) => s.dismissCard);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (p.requested) {
    const done = p.status === "done";
    const switching = busy || p.status === "switching";
    const failed = p.status === "failed";
    const actionable = !done && p.status !== "cancelled";
    const tone = done ? "border-ok/50" : failed ? "border-bad/50" : "border-accent/60";
    return (
      <Shell
        testId="card-github-account"
        cardId={card.id}
        tone={tone}
        icon={done ? <Check className="h-4 w-4 text-ok" /> : <UserRoundCog className="h-4 w-4 text-accent" />}
        title={done ? `GitHub: Switched to @${p.to}` : `GitHub: Switch account to @${p.to}`}
      >
        <div className="mt-1 text-xs text-muted" data-testid="github-account-text">
          {done
            ? `ARIA now reads GitHub as @${p.to}${p.from && p.from !== p.to ? ` (was @${p.from})` : ""}.`
            : `${p.from ? `GitHub CLI currently uses @${p.from}. ` : ""}Switch GitHub CLI to @${p.to} (\`gh auth switch --user ${p.to}\`)?`}
        </div>
        {p.note && (
          <div className="mt-1 wrap-anywhere text-xs text-muted" data-testid="github-account-note">
            <Markdown text={p.note} />
          </div>
        )}
        {actionable && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button
              testId="github-account-switch"
              primary
              disabled={switching}
              onClick={async () => {
                setBusy(true);
                setError(await switchGhAccount(card.id));
                setBusy(false);
              }}
            >
              {switching ? "Switching…" : failed ? `Try again (@${p.to})` : `Switch to @${p.to}`}
            </Button>
            <Button
              testId="github-account-dismiss"
              disabled={switching}
              onClick={() => void dismissCard(card.id).then(setError)}
            >
              Dismiss
            </Button>
          </div>
        )}
        {(error ?? p.error) && (
          <div className="mt-1 text-xs text-bad" data-testid="github-account-error">
            {error ?? p.error}
          </div>
        )}
      </Shell>
    );
  }

  return (
    <Shell testId="card-github-account" cardId={card.id} tone={stillPaused ? "border-warn/60" : "border-line"} icon={<UserRoundCog className="h-4 w-4 text-warn" />} title={`GitHub: ARIA now reads GitHub as @${p.to}`}>
      <div className="mt-1 text-xs text-muted" data-testid="github-account-text">
        GitHub CLI used @{p.from} before. {stillPaused ? `${stillPaused} watch${stillPaused === 1 ? " started as @" + p.from + " is" : "es started as @" + p.from + " are"} paused.` : p.rebound ? `You let the watches go on as @${p.to}.` : "No watch waits for that account anymore."}
      </div>
      {stillPaused > 0 && !p.rebound && login === p.to && (
        <div className="mt-2 space-y-1">
          <div className="flex flex-wrap gap-1.5">
            <Button
              testId="github-account-use"
              primary
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(await rebindWatches(card.id));
                setBusy(false);
              }}
            >
              Use @{p.to} for them
            </Button>
            {p.from && (
              <Button
                testId="github-account-switch"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(await switchGhAccount(card.id));
                  setBusy(false);
                }}
              >
                Switch back to @{p.from}
              </Button>
            )}
          </div>
          <div className="text-[11px] text-muted">Or switch GitHub CLI back to @{p.from} (`gh auth switch`): they go on by themselves.</div>
        </div>
      )}
      {(error ?? p.error) && <div className="mt-1 text-xs text-bad">{error ?? p.error}</div>}
    </Shell>
  );
}

export function WatchEndedCard({ card }: { card: Extract<CardItem, { cardType: "watch_ended" }> }) {
  const p = card.payload;
  return (
    <Shell testId="card-watch-ended" cardId={card.id} icon={<TimerReset className="h-4 w-4 text-muted" />} title={<span>Stopped watching {p.title}{p.repoName ? <span className="font-normal text-muted"> · {p.repoName}</span> : null}</span>}>
      <div className="mt-1 text-xs text-muted" data-testid="watch-ended-text">
        {p.text}
      </div>
      {p.url && (
        <div className="mt-2">
          <Button testId="watch-ended-open" onClick={() => openPage(p.url!)}>
            <ExternalLink className="h-3 w-3" /> Open on GitHub
          </Button>
        </div>
      )}
    </Shell>
  );
}

/** Phase 7B (PLAN.md §4.6, §5.4, §10 Phase 7B): a tracker task's update card with Open task and Ask ARIA. */
export function TrackerUpdateCard({ card }: { card: Extract<CardItem, { cardType: "tracker_update" }> }) {
  const setPrefill = useAria((s) => s.setPrefill);
  const tracker = useTracker();
  const label = trackerLabel(tracker);
  const p = card.payload;

  const headerText =
    p.event === "assigned"
      ? `New ${label} task assigned · #${p.taskId}`
      : p.event === "status_changed"
        ? `${label} task #${p.taskId} · status changed`
        : p.event === "priority_changed"
          ? `${label} task #${p.taskId} · priority changed`
          : `New comment on ${label} task #${p.taskId}`;

  const contextLabel = p.projectName ?? p.customerName;

  const detailParts: string[] = [];
  if (p.taskType) detailParts.push(`[${p.taskType}]`);
  if (p.event === "status_changed") {
    detailParts.push(`Status: ${p.previousStatus ?? "unspecified"} → ${p.status ?? "unspecified"}`);
    if (p.priority) detailParts.push(`Priority: ${p.priority}`);
  } else if (p.event === "priority_changed") {
    detailParts.push(`Priority: ${p.previousPriority ?? "unspecified"} → ${p.priority ?? "unspecified"}`);
    if (p.status) detailParts.push(`Status: ${p.status}`);
  } else {
    if (p.status) detailParts.push(`Status: ${p.status}`);
    if (p.priority) detailParts.push(`Priority: ${p.priority}`);
  }

  return (
    <Shell
      testId="card-tracker-update"
      cardId={card.id}
      tone="border-accent/50"
      icon={<Briefcase className="h-4 w-4 text-accent" />}
      title={
        <span data-testid="tracker-update-title" data-event={p.event}>
          {headerText}
          {contextLabel && <span className="font-normal text-muted"> · {contextLabel}</span>}
        </span>
      }
    >
      <div className="mt-1 truncate text-xs font-medium text-fg" data-testid="tracker-update-subject">
        {p.title}
      </div>
      {detailParts.length > 0 && (
        <div className="mt-1 text-xs text-muted" data-testid="tracker-update-detail">
          {detailParts.join("  ·  ")}
        </div>
      )}
      {p.comment && (
        <div
          className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-canvas px-2 py-1 text-xs text-fg"
          data-testid="tracker-update-comment"
        >
          {p.commentBy && <span className="font-medium text-muted">{p.commentBy}: </span>}
          {p.comment}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {/* A card of another tracker (its ID starts with that tracker's id) has no link from this tracker's template. */}
        {tracker && card.id.startsWith(`${tracker.id}-`) && (
          <Button testId="tracker-update-open" onClick={() => openPage(p.url)}>
            <ExternalLink className="h-3 w-3" /> Open task
          </Button>
        )}
        <Button
          testId="tracker-update-ask"
          onClick={() => setPrefill(askAboutTaskPrefill(tracker, p.taskId, p.title))}
        >
          <MessageSquareReply className="h-3 w-3" /> Ask ARIA
        </Button>
      </div>
    </Shell>
  );
}

/** Proactive Outlook email card when an unread email needs your attention or reply. */
export function OutlookMailCard({ card }: { card: Extract<CardItem, { cardType: "outlook_mail" }> }) {
  const setPrefill = useAria((s) => s.setPrefill);
  const createReminder = useAria((s) => s.createReminder);
  const dismissCard = useAria((s) => s.dismissCard);
  const [reminded, setReminded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tracker = useTracker();
  const p = card.payload;
  const urgent = p.urgency === "urgent";

  return (
    <Shell
      testId="card-outlook-mail"
      cardId={card.id}
      tone={urgent ? "border-bad/60" : "border-accent/50"}
      icon={<Mail className={`h-4 w-4 ${urgent ? "text-bad" : "text-accent"}`} />}
      title={
        <span data-testid="outlook-mail-title" data-urgency={p.urgency}>
          {urgent ? "Urgent email" : "Email needs you"} · {p.fromName}
          {p.fromAddress && p.fromAddress !== p.fromName.toLowerCase() && (
            <span className="font-normal text-muted"> &lt;{p.fromAddress}&gt;</span>
          )}
        </span>
      }
      right={
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${urgent ? "bg-bad/15 text-bad" : "bg-accent/15 text-accent"}`}>
          {urgent ? "Urgent" : "Action needed"}
        </span>
      }
    >
      <div className="mt-1 truncate text-xs font-medium text-fg" data-testid="outlook-mail-subject">
        {p.subject}
      </div>
      <div className="mt-0.5 text-xs text-muted" data-testid="outlook-mail-reason">
        {p.reason}
        {p.trackerTaskId && <span className="ml-1.5 font-mono text-accent">· {trackerRef(tracker, p.trackerTaskId)}</span>}
      </div>
      {p.preview && (
        <div
          className="mt-1.5 max-h-36 overflow-auto whitespace-pre-wrap rounded bg-canvas px-2 py-1 text-xs text-fg"
          data-testid="outlook-mail-preview"
        >
          {p.preview}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button
          testId="outlook-mail-ask"
          primary
          onClick={() =>
            setPrefill(
              `About the email from ${p.fromName} ("${p.subject}"): `,
            )
          }
        >
          <MessageSquareReply className="h-3 w-3" /> Draft reply / Ask ARIA
        </Button>
        <Button
          testId="outlook-mail-remind"
          disabled={reminded}
          onClick={() => {
            void createReminder({
              text: `Reply to ${p.fromName}: ${p.subject}`,
              inMinutes: 60,
            }).then((res) => {
              if (res.error) setError(res.error);
              else setReminded(true);
            });
          }}
        >
          <Bell className="h-3 w-3" /> {reminded ? "Reminder set (1h)" : "Remind me in 1h"}
        </Button>
        {p.webLink && (
          <Button testId="outlook-mail-open" onClick={() => openPage(p.webLink!)}>
            <ExternalLink className="h-3 w-3" /> Open in Outlook
          </Button>
        )}
        <Button
          testId="outlook-mail-dismiss"
          onClick={() => void dismissCard(card.id).then(setError)}
        >
          Dismiss
        </Button>
      </div>
      {error && <div className="mt-1 text-xs text-bad">{error}</div>}
    </Shell>
  );
}
