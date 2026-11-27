// Opening a pull request: what the worker's branch becomes, for you to check, change and confirm.
import type { CardItem } from "@aria/protocol";
import { ExternalLink, GitBranch, GitPullRequest, Workflow, RotateCcw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useAria } from "../store";
import { openPage } from "../openPage";
import { Button, Shell, useTask } from "./CardParts";
import { EncodingDamageNote } from "./CardsTask";

const repoText = (r: { owner: string; repo: string }) => `${r.owner}/${r.repo}`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The PR card (item 3): exactly what's pushed and sent, made by Open PR or by ARIA's open_pr. Only Push and open
 * here does it; the title, the body, Draft and (for a fork) which repository are yours to change. Everything from the
 * worker (its report in the body, its commit subjects, its paths) is plain text.
 */
export function PrConfirmCard({ card }: { card: Extract<CardItem, { cardType: "pr_confirm" }> }) {
  const p = card.payload;
  const task = useTask(p.taskId);
  const proposePr = useAria((s) => s.proposePr);
  const dismissPr = useAria((s) => s.dismissPr);
  const watch = useAria((s) => (p.result?.watchId !== undefined ? s.watches.find((w) => w.id === p.result!.watchId) : undefined));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (call: () => Promise<string | null>) => {
    setBusy(true);
    setError(await call());
    setBusy(false);
  };
  const kind = p.result?.draft ? "draft PR" : "PR";
  const title =
    p.status === "done"
      ? p.result?.updated
        ? `Pushed the new commits to ${kind} #${p.result.number}`
        : `Opened ${kind} #${p.result?.number ?? "?"}`
      : p.status === "pushing"
        ? "Pushing the commits…"
        : p.status === "opening"
          ? "Opening the PR…"
          : p.status === "failed"
            ? "The PR didn't open"
            : p.status === "dismissed"
              ? "PR not opened"
              : p.existing
                ? `Push the new commits to PR #${p.existing.number}?`
                : "Open a pull request?";
  const tone = p.status === "done" ? "border-ok/50" : p.status === "failed" ? "border-bad/50" : p.status === "dismissed" ? "border-line" : "border-accent/60";
  return (
    <Shell
      testId="card-pr-confirm"
      cardId={card.id}
      tone={tone}
      icon={<GitPullRequest className={`h-4 w-4 ${p.status === "done" ? "text-ok" : p.status === "failed" ? "text-bad" : "text-accent"}`} />}
      title={
        <span data-testid="pr-confirm-title" data-status={p.status}>
          {title} <span className="font-normal text-muted">· {p.taskTitle} · {p.repoName}</span>
        </span>
      }
    >
      {p.proposedBy === "aria" && p.status === "pending" && <div className="mt-1 text-xs text-muted">ARIA proposed it: nothing is pushed or opened until you click Push and open.</div>}
      <div className="mt-1.5 space-y-0.5 text-xs text-muted" data-testid="pr-confirm-what">
        <div>
          {p.status === "done" ? "Pushed" : "Pushes"} {plural(p.commits, "commit")} ({plural(p.filesChanged, "file")}, <span className="text-ok">+{p.additions}</span> <span className="text-bad">−{p.deletions}</span>) as @{p.login} to{" "}
          <span className="font-mono text-fg">{repoText(p.pushTo)}</span>, branch{" "}
          <span className="inline-flex items-center gap-0.5 font-mono text-fg">
            <GitBranch className="h-3 w-3" />
            {p.remoteBranch}
          </span>{" "}
          at <span className="font-mono">{p.tip.slice(0, 7)}</span>
        </div>
        {p.remoteBranch.endsWith(`-${p.tip.slice(0, 7)}`) && (
          <div data-testid="pr-confirm-renamed">The task's branch name is taken on GitHub by other commits (an earlier PR's?): ARIA doesn't overwrite it, so this one goes to the name above.</div>
        )}
        <div>
          {p.existing ? (
            <span data-testid="pr-confirm-existing">
              PR #{p.existing.number} is open for this branch: the push adds the commits to it, no new PR.
            </span>
          ) : (
            <>
              A PR into <span className="font-mono text-fg">{p.base}</span> on <span className="font-mono text-fg">{repoText(p.openOn)}</span>
            </>
          )}
        </div>
        {p.sandboxed !== undefined && <div>The task ran {p.sandboxed ? "in the sandbox" : "without the sandbox"}.</div>}
      </div>
      {p.notes && p.notes.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs text-warn" data-testid="pr-confirm-notes">
          {p.notes.map((note) => (
            <li key={note} className="flex items-start gap-1.5">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      )}
      {/* R1: the repair moves the branch, so it's offered only before the push (the card then says to Open PR again). */}
      {p.encodingDamage && <EncodingDamageNote damage={p.encodingDamage} task={p.status === "pending" || p.status === "failed" ? task : undefined} testId="pr-confirm-encoding" />}
      {p.uncommitted > 0 && (
        <div className="mt-1 flex items-start gap-1.5 text-xs text-warn" data-testid="pr-confirm-uncommitted">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {p.uncommitted} change{p.uncommitted === 1 ? " isn't" : "s aren't"} committed in its worktree: {p.uncommitted === 1 ? "it isn't" : "they aren't"} pushed. Continue the task to commit {p.uncommitted === 1 ? "it" : "them"} first if {p.uncommitted === 1 ? "it belongs" : "they belong"} in the PR.
          </span>
        </div>
      )}
      <details className="mt-1.5 text-xs" data-testid="pr-confirm-details">
        <summary className="cursor-pointer text-muted hover:text-fg">
          The commits and the files ({plural(p.subjects.length, "commit")}, {plural(p.filesChanged, "file")})
        </summary>
        <ul className="mt-1 space-y-0.5" data-testid="pr-confirm-subjects">
          {p.subjects.map((s, i) => (
            <li key={`${i}-${s}`} className="truncate">
              · {s}
            </li>
          ))}
        </ul>
        <ul className="mt-1 max-h-40 overflow-auto font-mono text-[11px] text-muted" data-testid="pr-confirm-paths">
          {p.paths.map((path) => (
            <li key={path} className="truncate">
              {path}
            </li>
          ))}
          {p.filesChanged > p.paths.length && <li>and {p.filesChanged - p.paths.length} more</li>}
        </ul>
      </details>
      {p.flagged.length > 0 && (
        <div className="mt-1.5 text-xs text-warn" data-testid="pr-confirm-flagged">
          <div className="flex items-center gap-1.5">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" /> These files run code in builds or CI: look at them in the diff.
          </div>
          <ul className="ml-5 font-mono text-[11px]">
            {p.flagged.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      )}
      {p.status === "pending" && <PrConfirmForm key={p.revision} card={card} busy={busy} onSubmit={(input) => act(() => useAria.getState().confirmPr(input))} />}
      {p.status !== "pending" && p.workflows.length > 0 && (
        <div className="mt-1.5 text-xs text-muted" data-testid="pr-confirm-workflows-done">
          It changes GitHub workflows: {p.workflows.join(", ")}
        </div>
      )}
      {p.status === "done" && p.result && (
        <div className="mt-1.5 text-xs text-muted" data-testid="pr-confirm-result">
          {repoText(p.openOn)} · {p.title}
          {watch && watch.state === "active" ? ` · ARIA watches its checks (${watch.shortId}).` : ""}
        </div>
      )}
      {p.error && (
        <div className={`mt-1.5 text-xs ${p.status === "done" ? "text-warn" : "text-bad"}`} data-testid="pr-confirm-error">
          {p.error}
        </div>
      )}
      {error && (
        <div className="mt-1 text-xs text-bad" data-testid="pr-confirm-action-error">
          {error}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {p.status === "done" && p.result && (
          <Button testId="pr-confirm-open" onClick={() => openPage(p.result!.url)}>
            <ExternalLink className="h-3 w-3" /> Open PR #{p.result.number}
          </Button>
        )}
        {p.status === "failed" && (
          <Button testId="pr-confirm-retry" primary disabled={busy} title="Looks at the task and GitHub again (the pushed branch, an open PR) and shows the card again" onClick={() => void act(() => proposePr(p.taskId))}>
            <RotateCcw className="h-3 w-3" /> Try again
          </Button>
        )}
        {(p.status === "pending" || p.status === "failed") && (
          <Button testId="pr-confirm-dismiss" disabled={busy} onClick={() => void act(() => dismissPr(card.id))}>
            Dismiss
          </Button>
        )}
      </div>
    </Shell>
  );
}

/** Your edits on a waiting PR card, and the click (keyed by the card's revision: a new revision starts from it). */
function PrConfirmForm({ card, busy, onSubmit }: { card: Extract<CardItem, { cardType: "pr_confirm" }>; busy: boolean; onSubmit: (input: Parameters<ReturnType<typeof useAria.getState>["confirmPr"]>[0]) => void }) {
  const p = card.payload;
  const [title, setTitle] = useState(p.title);
  const [body, setBody] = useState(p.body);
  const [draft, setDraft] = useState(p.draft);
  const [openOn, setOpenOn] = useState(`${p.openOn.owner}/${p.openOn.repo}`);
  const [checked, setChecked] = useState(false);
  const target = p.choices.find((c) => repoText(c) === openOn) ?? p.openOn;
  const extended = p.extended?.paths ?? [];
  // D43, and D52 for a task that worked from someone else's text: one tick for all of it.
  const needsTick = p.workflows.length > 0 || extended.length > 0;
  const blocked = !title.trim() || (needsTick && !checked);
  return (
    <form
      className="mt-2 space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || blocked) return;
        onSubmit({ cardId: card.id, revision: p.revision, title, body, draft, openOn: target, workflowsChecked: checked });
      }}
    >
      {p.choices.length > 1 && !p.existing && (
        <fieldset className="text-xs" data-testid="pr-confirm-open-on">
          <legend className="text-muted">Open it on (a fork's PR goes to the fork unless you pick its upstream)</legend>
          {p.choices.map((c) => (
            <label key={repoText(c)} className="mr-3 inline-flex items-center gap-1">
              <input type="radio" name={`open-on-${card.id}`} value={repoText(c)} checked={openOn === repoText(c)} onChange={() => setOpenOn(repoText(c))} data-testid="pr-confirm-open-on-choice" />
              <span className="font-mono">{repoText(c)}</span>
              {c.owner === p.pushTo.owner && c.repo === p.pushTo.repo ? <span className="text-muted">(the fork)</span> : <span className="text-muted">(upstream: head {p.pushTo.owner}:{p.remoteBranch})</span>}
            </label>
          ))}
        </fieldset>
      )}
      {!p.existing && (
        <>
          <label className="block text-xs">
            <span className="text-muted">Title</span>
            <input data-testid="pr-confirm-title-input" value={title} maxLength={1000} onChange={(e) => setTitle(e.target.value)} className="mt-0.5 block w-full rounded-md border border-line bg-canvas px-2 py-1 text-xs outline-none focus:border-accent" />
          </label>
          <label className="block text-xs">
            <span className="text-muted">Body (sent as it is; the task's report is in a code block, so nothing in it mentions, closes or links)</span>
            <textarea data-testid="pr-confirm-body" value={body} maxLength={70_000} onChange={(e) => setBody(e.target.value)} rows={6} className="mt-0.5 block w-full rounded-md border border-line bg-canvas px-2 py-1 font-mono text-[11px] outline-none focus:border-accent" />
          </label>
          <label className="inline-flex items-center gap-1.5 text-xs">
            <input type="checkbox" data-testid="pr-confirm-draft" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
            Draft (it can't be merged until it's marked ready on GitHub)
          </label>
        </>
      )}
      {needsTick && (
        <div className="rounded-md border border-warn/60 px-2 py-1.5 text-xs" data-testid="pr-confirm-workflows">
          {p.workflows.length > 0 && (
            <>
              <div className="flex items-center gap-1.5 text-warn">
                <Workflow className="h-3.5 w-3.5 shrink-0" /> The commits change GitHub workflows, which run with this repository's secrets:
              </div>
              <ul className="ml-5 font-mono text-[11px]">
                {p.workflows.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </>
          )}
          {extended.length > 0 && (
            <div data-testid="pr-confirm-extended">
              <div className="flex items-center gap-1.5 text-warn">
                <TriangleAlert className="h-3.5 w-3.5 shrink-0" /> The task worked from someone else's text ({p.extended!.from === "ci_log" ? "a CI log" : "a review"}), and these change builds, CI, packages or tests:
              </div>
              <ul className="ml-5 font-mono text-[11px]">
                {extended.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          )}
          <label className="mt-1 inline-flex items-center gap-1.5">
            <input type="checkbox" data-testid="pr-confirm-workflows-checked" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            {extended.length > 0 ? "I've checked these changes" : "I've checked these workflow changes"}
          </label>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Button testId="pr-confirm-push" type="submit" primary disabled={busy || blocked} title={blocked && needsTick && !checked ? "Tick that you've checked the changes listed above first" : `Push to ${repoText(p.pushTo)} as @${p.login}, then open it`}>
          <GitPullRequest className="h-3 w-3" /> {busy ? "On its way…" : p.existing ? "Push the commits" : draft ? "Push and open as draft" : "Push and open"}
        </Button>
      </div>
    </form>
  );
}
