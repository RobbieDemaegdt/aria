import type { PolicyRule, RuleEffect, RuleScope } from "@aria/protocol";
import { Folder, FolderPlus, Plus, RefreshCw, ShieldCheck, ShieldOff, Trash } from "lucide-react";
import { useEffect, useState } from "react";
import { useAria } from "../store";
import { RuleCheckLines, useRuleChecks } from "./Flow";

type DraftRule = Omit<PolicyRule, "exact" | "scope"> & { exact?: boolean | undefined; scope?: RuleScope | undefined; fresh?: boolean };

const EFFECTS: Array<{ value: RuleEffect; label: string }> = [
  { value: "auto", label: "Runs on its own" },
  { value: "ask", label: "Asks you" },
  { value: "never", label: "Never" },
];

/** Customize › Permissions (PLAN.md §4.8, D20): the sandbox for tasks, and rules for the commands they run. */
export function CustomizePermissions() {
  const policy = useAria((s) => s.policy);
  const projectRoots = useAria((s) => s.projectRoots);
  const addProjectRoot = useAria((s) => s.addProjectRoot);
  const removeProjectRoot = useAria((s) => s.removeProjectRoot);
  const pickProjectRoot = useAria((s) => s.pickProjectRoot);
  const rescanProjects = useAria((s) => s.rescanProjects);
  const savePolicyRules = useAria((s) => s.savePolicyRules);
  const resetPolicyRules = useAria((s) => s.resetPolicyRules);
  const setSandbox = useAria((s) => s.setSandbox);
  const actionError = useAria((s) => s.actionError);
  const clearError = useAria((s) => s.clearError);
  const [rules, setRules] = useState<DraftRule[]>(policy.rules);
  const [hosts, setHosts] = useState(policy.sandbox.allowedHosts.join("\n"));
  const [paths, setPaths] = useState((policy.sandbox.allowedPaths ?? []).join("\n"));
  const [newRootInput, setNewRootInput] = useState("");
  const [rootError, setRootError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    clearError();
  }, [clearError]);
  // Drafts follow what's saved only when that changes: toggling the sandbox mustn't throw away rules you're editing.
  const savedRules = JSON.stringify(policy.rules);
  const savedHosts = policy.sandbox.allowedHosts.join("\n");
  const savedPaths = (policy.sandbox.allowedPaths ?? []).join("\n");
  useEffect(() => setRules(JSON.parse(savedRules) as PolicyRule[]), [savedRules]);
  useEffect(() => setHosts(savedHosts), [savedHosts]);
  useEffect(() => setPaths(savedPaths), [savedPaths]);

  const sandbox = policy.sandbox;
  const hostList = hosts
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const pathList = paths
    .split(/[\r\n]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const hostsChanged = hostList.join("\n") !== sandbox.allowedHosts.join("\n");
  const pathsChanged = pathList.join("\n") !== (sandbox.allowedPaths ?? []).join("\n");
  const rulesChanged = JSON.stringify(rules.map(({ fresh: _f, ...r }) => r)) !== JSON.stringify(policy.rules);
  const blank = rules.some((r) => !r.match.trim());
  // D26: a new or changed Auto rule has to pass the checks; one saved before and unchanged is kept with its warnings.
  const checks = useRuleChecks(rules.map((r) => ({ match: r.match, effect: r.effect, exact: r.exact === true, scope: r.scope })));
  const unchanged = (rule: DraftRule) =>
    policy.rules.some((s) => s.id === rule.id && s.match === rule.match.trim().replace(/\s+/g, " ") && s.effect === rule.effect && (s.exact === true) === (rule.exact === true) && (s.scope ?? "everywhere") === (rule.scope ?? "everywhere"));
  const refused = rules.some((rule, i) => (checks[i]?.problems.length ?? 0) > 0 && !unchanged(rule));
  const set = (id: string, patch: Partial<DraftRule>) => setRules((all) => all.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const run = async (action: () => Promise<boolean>, done: string) => {
    setBusy(true);
    setSaved(null);
    if (await action()) setSaved(done);
    setBusy(false);
  };
  const field = "rounded-md border border-line bg-canvas px-2 py-1 text-sm outline-none focus:border-accent";

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-5 p-6">
        <section className="space-y-3 rounded-lg border border-line bg-panel p-4" data-testid="project-folders-settings">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="font-medium">Project folders</div>
              <div className="text-xs text-muted">
                Root directories where ARIA scans for your git repositories and clones or creates new projects. The first folder is used as the default target for cloning and creating repositories.
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                data-testid="project-root-browse"
                onClick={async () => {
                  const err = await pickProjectRoot();
                  setRootError(err);
                }}
                className="inline-flex items-center gap-1 rounded-md border border-line bg-canvas px-2.5 py-1 text-xs text-muted hover:text-fg"
              >
                <FolderPlus className="h-3.5 w-3.5" /> Browse folder…
              </button>
              <button
                type="button"
                data-testid="project-root-rescan"
                onClick={() => void rescanProjects()}
                className="inline-flex items-center gap-1 rounded-md border border-line bg-canvas px-2.5 py-1 text-xs text-muted hover:text-fg"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Rescan
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            {projectRoots.length === 0 && (
              <div className="text-xs text-muted">No project folder configured yet. Add a folder below or click Browse folder.</div>
            )}
            {projectRoots.map((root, idx) => (
              <div
                key={root}
                data-testid="project-root-row"
                className="flex items-center gap-2 rounded-md border border-line bg-canvas px-3 py-1.5 text-xs"
              >
                <Folder className="h-3.5 w-3.5 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate font-mono">{root}</span>
                {idx === 0 && (
                  <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-accent">
                    Default target
                  </span>
                )}
                <button
                  type="button"
                  data-testid="project-root-remove"
                  onClick={async () => {
                    const err = await removeProjectRoot(root);
                    setRootError(err);
                  }}
                  className="rounded p-1 text-muted hover:text-bad"
                  title="Remove project folder"
                >
                  <Trash className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>

          <form
            className="flex items-center gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!newRootInput.trim()) return;
              const err = await addProjectRoot(newRootInput.trim());
              setRootError(err);
              if (!err) setNewRootInput("");
            }}
          >
            <input
              data-testid="project-root-input"
              value={newRootInput}
              onChange={(e) => setNewRootInput(e.target.value)}
              placeholder="C:\Users\...\Documents\GitHub"
              className={`${field} min-w-0 flex-1 font-mono text-xs`}
            />
            <button
              type="submit"
              data-testid="project-root-add"
              disabled={!newRootInput.trim()}
              className="rounded-md bg-accent px-3 py-1 text-sm text-white disabled:opacity-40"
            >
              Add folder
            </button>
          </form>
          {rootError && (
            <div className="text-xs text-bad" data-testid="project-root-error">
              {rootError}
            </div>
          )}
        </section>

        <section className="space-y-3 rounded-lg border border-line bg-panel p-4" data-testid="sandbox-settings">
          <div className="flex items-start gap-2">
            {sandbox.supported && sandbox.enabled ? <ShieldCheck className="mt-0.5 h-4 w-4 text-ok" /> : <ShieldOff className="mt-0.5 h-4 w-4 text-warn" />}
            <div>
              <div className="font-medium">Sandbox for background tasks</div>
              <div className="text-xs text-muted" data-testid="sandbox-status">
                {sandbox.supported
                  ? "This PC can run the sandbox: a task can only change its own worktree, and its network only reaches the hosts below."
                  : `This PC can't run the sandbox${sandbox.reason ? ` (${sandbox.reason})` : ""}. Tasks run without it, and commands outside the safe list ask you first.`}
              </div>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="sandbox-enabled"
              disabled={!sandbox.supported || busy}
              checked={sandbox.enabled}
              onChange={(e) => void run(() => setSandbox({ enabled: e.target.checked }), "Saved. Applies to tasks that start or continue from now on.")}
            />
            Run tasks in the sandbox
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted">Hosts sandboxed tasks may reach (one per line; *.example.com for its subdomains)</span>
            <textarea data-testid="sandbox-hosts" rows={4} className={`${field} w-full resize-y font-mono text-xs`} value={hosts} onChange={(e) => setHosts(e.target.value)} />
            {hostList.length === 0 && <span className="block text-xs text-warn">No hosts: sandboxed tasks get no network at all, so installs that download fail.</span>}
            {hostList.some((h) => /github/i.test(h)) && (
              <span className="block text-xs text-warn" data-testid="sandbox-hosts-github">
                With GitHub in this list, tasks can reach your repositories there. ARIA's rules against pushing to a default branch and merging only catch
                commands they can read; without GitHub here, the sandbox stops every push.
              </span>
            )}
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted">Local folders or files sandboxed tasks may read (one per line, e.g. C:\Users\sam\Downloads)</span>
            <textarea
              data-testid="sandbox-paths"
              rows={3}
              className={`${field} w-full resize-y font-mono text-xs`}
              value={paths}
              onChange={(e) => setPaths(e.target.value)}
              placeholder="C:\Users\...\Downloads"
            />
            <span className="block text-xs text-muted">
              Sandboxed tasks can read reference files and schemas from these paths. Drive roots (e.g. C:\) and entire user profile folders are blocked.
            </span>
          </label>
          <div className="flex gap-2">
            <button
              data-testid="sandbox-hosts-save"
              disabled={busy || !hostsChanged}
              onClick={() => void run(() => setSandbox({ allowedHosts: hostList }), "Saved hosts. Applies to tasks that start or continue from now on.")}
              className="rounded-md bg-accent px-3 py-1 text-sm text-white disabled:opacity-40"
            >
              Save hosts
            </button>
            <button
              data-testid="sandbox-paths-save"
              disabled={busy || !pathsChanged}
              onClick={() => void run(() => setSandbox({ allowedPaths: pathList }), "Saved paths. Applies to tasks that start or continue from now on.")}
              className="rounded-md bg-accent px-3 py-1 text-sm text-white disabled:opacity-40"
            >
              Save paths
            </button>
          </div>
        </section>

        <section className="space-y-3 rounded-lg border border-line bg-panel p-4" data-testid="policy-rules">
          <div>
            <div className="font-medium">Commands</div>
            <div className="text-xs text-muted">
              What a task may run. <b>Runs on its own</b>: no question (a task that isn't sandboxed still only runs it inside its worktree). <b>Asks you</b>: a card
              waits for your approval. <b>Never</b>: refused, and the task carries on without it. A word in angle brackets, like <code>&lt;package&gt;</code>, stands
              for any one argument (<code>dotnet add &lt;project&gt; package</code>); more may follow. The most specific rule wins. <b>Only exactly this</b>: just that
              command, with exactly those arguments in that order (letter case counts). A rule can apply to all tasks or only to sandboxed ones.
            </div>
            <div className="mt-1 text-xs text-muted">
              A rule that runs on its own has to be exact, unless it's for tests, builds, linters or formatters (<code>npm test</code>, <code>npm run build</code>,{" "}
              <code>dotnet test</code>, <code>eslint</code>…), and a word in angle brackets counts as broad. Destructive commands (<code>Remove-Item -Recurse</code>,{" "}
              <code>rimraf</code>, <code>robocopy /MIR</code>, <code>git reset --hard</code>, <code>git checkout .</code>, <code>git restore .</code>, <code>git clean</code>,{" "}
              <code>git stash clear</code>, force pushes, <code>git branch -D</code>…) ask every time, whatever a rule says.
            </div>
            <div className="mt-1 text-xs text-muted" data-testid="rules-unlisted">
              A command no rule covers runs on its own in the sandbox. Without the sandbox, only commands on ARIA's built-in safe list (like{" "}
              <code>git status</code>, <code>npm test</code> or <code>dotnet build</code>) run on their own, inside the worktree; anything else asks you.
            </div>
            <div className="mt-1 text-xs text-muted">
              Always, whatever these say: no pushing to a default branch, no deleting or mirroring remote branches, no merging pull requests, and a sandboxed task
              can't push at all.
            </div>
          </div>
          <div className="space-y-1.5">
            {rules.map((rule, i) => (
              <div key={rule.id} className="space-y-0.5" data-testid="policy-rule">
              {/* Narrow: what doesn't fit (the note, then exactness, scope and delete together) goes onto the next line. */}
              <div className="flex flex-wrap items-center gap-1.5">
                <input
                  aria-label="Command"
                  data-testid="rule-match"
                  className={`${field} w-48 shrink-0 font-mono text-xs`}
                  value={rule.match}
                  placeholder="npm install <package>"
                  maxLength={200}
                  onChange={(e) => set(rule.id, { match: e.target.value })}
                />
                <select aria-label="What happens" data-testid="rule-effect" className={field} value={rule.effect} onChange={(e) => set(rule.id, { effect: e.target.value as RuleEffect })}>
                  {EFFECTS.map((e) => (
                    <option key={e.value} value={e.value}>
                      {e.label}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Why (shown on the card)"
                  className={`${field} min-w-40 flex-1 text-xs`}
                  value={rule.note ?? ""}
                  title={rule.note}
                  placeholder="Why (shown on the card)"
                  maxLength={300}
                  onChange={(e) => set(rule.id, { note: e.target.value })}
                />
                <span className="flex shrink-0 items-center gap-1.5">
                  <label className="inline-flex shrink-0 items-center gap-1 text-xs text-muted" title="Only this command, with exactly these arguments in this order">
                    <input type="checkbox" data-testid="rule-exact" checked={rule.exact === true} onChange={(e) => set(rule.id, { exact: e.target.checked || undefined })} />
                    Only exactly this
                  </label>
                  <select
                    aria-label="Which tasks"
                    data-testid="rule-scope"
                    className={`${field} text-xs`}
                    value={rule.scope ?? "everywhere"}
                    onChange={(e) => set(rule.id, { scope: e.target.value === "sandboxed" ? ("sandboxed" as RuleScope) : undefined })}
                  >
                    <option value="everywhere">All tasks</option>
                    <option value="sandboxed">Sandboxed tasks</option>
                  </select>
                  <button aria-label={`Delete the rule for ${rule.match || "this command"}`} onClick={() => setRules((all) => all.filter((r) => r.id !== rule.id))} className="rounded p-1 text-muted hover:text-bad">
                    <Trash className="h-3.5 w-3.5" />
                  </button>
                </span>
              </div>
              <RuleCheckLines check={checks[i]} kept={unchanged(rule)} />
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              data-testid="rule-add"
              onClick={() => setRules((all) => [...all, { id: `new-${Date.now()}-${all.length}`, match: "", effect: "ask", fresh: true }])}
              className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-muted hover:text-fg"
            >
              <Plus className="h-3 w-3" /> Add a rule
            </button>
            <button
              data-testid="rules-save"
              disabled={busy || !rulesChanged || blank || refused}
              title={blank ? "Every rule needs a command" : refused ? "A rule can't be saved like this: see under it" : undefined}
              onClick={() =>
                void run(
                  () =>
                    savePolicyRules(
                      rules.map(({ fresh, id, ...r }) => ({
                        ...(fresh ? {} : { id }),
                        match: r.match,
                        effect: r.effect,
                        ...(r.note?.trim() ? { note: r.note.trim() } : {}),
                        ...(r.exact ? { exact: true } : {}),
                        ...(r.scope ? { scope: r.scope } : {}),
                      })),
                    ),
                  "Saved. Applies to the next request of every task.",
                )
              }
              className="rounded-md bg-accent px-3 py-1 text-sm text-white disabled:opacity-40"
            >
              Save rules
            </button>
            {confirmReset ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                Replace all your rules with the defaults?
                <button
                  data-testid="rules-reset-confirm"
                  disabled={busy}
                  onClick={() => {
                    setConfirmReset(false);
                    void run(() => resetPolicyRules(), "Back to the default rules.");
                  }}
                  className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:border-bad hover:text-bad disabled:opacity-40"
                >
                  Reset rules
                </button>
                <button onClick={() => setConfirmReset(false)} className="rounded-md px-2 py-1 text-xs text-muted hover:text-fg">
                  Back
                </button>
              </span>
            ) : (
              <button data-testid="rules-reset" disabled={busy} onClick={() => setConfirmReset(true)} className="rounded-md px-2 py-1 text-xs text-muted hover:text-fg">
                Reset to the defaults…
              </button>
            )}
          </div>
        </section>
        {saved && (
          <div className="text-xs text-ok" data-testid="permissions-saved">
            {saved}
          </div>
        )}
        {actionError && <div className="text-xs text-bad">{actionError}</div>}
      </div>
    </div>
  );
}
