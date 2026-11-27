import type { RuleCheck, RuleOffer, RuleScope, SaveMemoryInput } from "@aria/protocol";
import { BookmarkPlus, ShieldCheck } from "lucide-react";
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import type { z } from "zod";
import { memoryHint, memoryPrefill } from "../flow";
import { useFocusLater } from "../focus";
import { useAria } from "../store";

type From = NonNullable<z.infer<typeof SaveMemoryInput>["from"]>;

const small = "inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-fg disabled:opacity-40";
const primary = "inline-flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs text-white hover:bg-accent/90 disabled:opacity-40";
const field = "min-w-0 rounded-md border border-line bg-canvas px-2 py-1 font-mono text-xs outline-none focus:border-accent";

/** What the engine would say about these rules if they were saved now (D26), checked a moment after you stop typing. */
export function useRuleChecks(rules: ReadonlyArray<{ match: string; effect: "auto" | "ask" | "never"; exact?: boolean | undefined; scope?: RuleScope | undefined }> | null): Array<RuleCheck | null> {
  const checkRule = useAria((s) => s.checkRule);
  const [checks, setChecks] = useState<Array<RuleCheck | null>>([]);
  const key = JSON.stringify(rules);
  useEffect(() => {
    if (!rules) return;
    let live = true;
    const timer = setTimeout(() => {
      void Promise.all(
        rules.map((r) => (r.match.trim() ? checkRule({ match: r.match, effect: r.effect, ...(r.exact ? { exact: true } : {}), ...(r.scope ? { scope: r.scope } : {}) }) : Promise.resolve(null))),
      ).then((results) => {
        if (live) setChecks(results);
      });
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `key` stands for the rules' contents (a new array each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, checkRule]);
  return checks;
}

/** A rule's problems (it can't be saved) and warnings, under its row. */
export function RuleCheckLines({ check, kept }: { check: RuleCheck | null | undefined; kept?: boolean }) {
  if (!check || (check.problems.length === 0 && check.warnings.length === 0)) return null;
  return (
    <div className="space-y-0.5 text-[11px]" data-testid="rule-check">
      {check.problems.map((p) => (
        <div key={p} className={kept ? "text-warn" : "text-bad"} data-testid={kept ? "rule-kept" : "rule-problem"}>
          {kept ? `Saved before, so it's kept as it is, but it wouldn't be accepted as a new rule: ${p}` : p}
        </div>
      ))}
      {check.warnings.map((w) => (
        <div key={w} className="text-muted" data-testid="rule-warning">
          {w}
        </div>
      ))}
    </div>
  );
}

const scopeWords = (scope: RuleScope) => (scope === "sandboxed" ? "in every sandboxed task" : "in every task");

/** Escape in one of these small forms cancels it, rather than closing the session view it's in (App's Escape). */
const escapeCancels = (cancel: () => void) => (e: KeyboardEvent) => {
  if (e.key !== "Escape") return;
  e.preventDefault();
  cancel();
};

/**
 * "Always allow this" (§5.3): the exact rules ARIA worked out when it decided the command, editable, saved to
 * Customize › Permissions. Only where an offer exists: never for a fixed rule's refusal or a destructive command.
 */
export function AlwaysAllow({ taskId, offerId, offer: given }: { taskId: string; offerId?: string | undefined; offer?: RuleOffer | undefined }) {
  const offers = useAria((s) => s.offers[taskId]);
  const loadOffers = useAria((s) => s.loadOffers);
  const acceptOffer = useAria((s) => s.acceptOffer);
  const usesDefaults = useAria((s) => s.policy.usesDefaults === true);
  const setCustomizePage = useAria((s) => s.setCustomizePage);
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<Array<{ match: string; exact: boolean }> | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  // The focus goes back to "Always allow…" on Cancel, and to the saved line's link after Save.
  const [trigger, focusTrigger] = useFocusLater<HTMLButtonElement>();
  const [savedLink, focusSavedLink] = useFocusLater<HTMLButtonElement>();
  const offer = given ?? offers?.find((o) => o.id === offerId);
  const checks = useRuleChecks(open && offer && rules ? rules.map((r) => ({ match: r.match, effect: "auto" as const, exact: r.exact, scope: offer.scope })) : null);

  useEffect(() => {
    if (open && !offer) void loadOffers(taskId);
  }, [open, offer, taskId, loadOffers]);
  useEffect(() => {
    if (open && offer && !rules) setRules(offer.rules.map((r) => ({ ...r })));
  }, [open, offer, rules]);

  if (saved) {
    return (
      <div className="mt-1.5 flex items-center gap-1.5 text-xs text-ok" data-testid="always-allow-saved">
        <ShieldCheck className="h-3.5 w-3.5" /> Saved to your rules: it runs on its own {offer ? scopeWords(offer.scope) : ""} from the next request on.
        <button ref={savedLink} className="text-accent hover:underline" onClick={() => setCustomizePage("permissions")}>
          Customize › Permissions
        </button>
      </div>
    );
  }
  if (!open) {
    return (
      <button ref={trigger} data-testid="always-allow" className={`${small} mt-1.5`} title="Save a rule so this exact command runs on its own from now on" onClick={() => setOpen(true)}>
        <ShieldCheck className="h-3 w-3" /> Always allow…
      </button>
    );
  }
  if (!offer || !rules) {
    return <div className="mt-1.5 text-xs text-muted">{offers ? "This suggestion isn't kept anymore: add a rule in Customize › Permissions." : "Loading…"}</div>;
  }
  const overrides = offer.overrides ?? [];
  const blocked = rules.some((r) => !r.match.trim()) || checks.some((c) => (c?.problems.length ?? 0) > 0) || (overrides.length > 0 && !confirm);
  const save = async () => {
    setBusy(true);
    setError(null);
    const failed = await acceptOffer(taskId, offer.id, rules, confirm);
    setBusy(false);
    if (failed) setError(failed);
    else {
      focusSavedLink();
      setSaved(true);
    }
  };
  const cancel = () => {
    focusTrigger();
    setOpen(false);
  };
  return (
    <form
      className="mt-2 space-y-2 rounded-md border border-line bg-canvas/50 p-2 text-xs"
      data-testid="always-allow-form"
      onKeyDown={escapeCancels(cancel)}
      onSubmit={(e) => {
        e.preventDefault();
        if (!blocked && !busy) void save();
      }}
    >
      <div className="text-muted">A rule that lets this run on its own {scopeWords(offer.scope)}. ARIA's fixed rules still apply.</div>
      {rules.map((rule, i) => (
        <div key={i} className="space-y-1" data-testid="offer-rule">
          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label="Command"
              data-testid="offer-match"
              // Opened from the keyboard or the mouse, the form is where the focus goes.
              autoFocus={i === 0}
              className={`${field} w-72 flex-1`}
              value={rule.match}
              maxLength={200}
              onChange={(e) => setRules(rules.map((r, k) => (k === i ? { ...r, match: e.target.value } : r)))}
            />
            <label className="inline-flex items-center gap-1 text-muted">
              <input type="checkbox" data-testid="offer-exact" checked={rule.exact} onChange={(e) => setRules(rules.map((r, k) => (k === i ? { ...r, exact: e.target.checked } : r)))} />
              Only exactly this
            </label>
            <span className="text-muted">Runs on its own</span>
          </div>
          <RuleCheckLines check={checks[i]} />
        </div>
      ))}
      {overrides.map((o) => (
        <div key={o.ruleId} className="text-warn" data-testid="offer-override">
          {o.sameRule
            ? `Your rule \`${o.match}\` says Never for exactly this command: saving turns it into a rule that lets it run.`
            : `Your rule \`${o.match}\` (Never) stays for everything else; only this exact command runs on its own.`}
        </div>
      ))}
      {overrides.length > 0 && (
        <label className="flex items-center gap-1.5 text-warn">
          <input type="checkbox" data-testid="offer-confirm" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          Yes, let it run although my Never rule refuses it now
        </label>
      )}
      {usesDefaults && <div className="text-muted">Your rules are still the defaults: saving one makes the list yours, so it no longer follows new defaults.</div>}
      {error && (
        <div className="text-bad" data-testid="offer-error">
          {error}
        </div>
      )}
      <div className="flex gap-1.5">
        <button type="submit" data-testid="offer-save" className={primary} disabled={blocked || busy}>
          Save rule
        </button>
        <button type="button" className={small} onClick={cancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * "Save as memory" (§5.3, D23): a one-line note from your own words, for the task's project or every project. The
 * engine works out where it came from (\`from\`) and checks it again.
 */
export function SaveMemory({ text, from, taskId, children }: { text: string; from: From; taskId: string; children?: ReactNode }) {
  const task = useAria((s) => s.tasks.find((t) => t.id === taskId));
  const usesTemplate = useAria((s) => s.memory.templateUsesMemory);
  const saveMemory = useAria((s) => s.saveMemory);
  const setCustomizePage = useAria((s) => s.setCustomizePage);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(() => memoryPrefill(text));
  const [scope, setScope] = useState<"project" | "global">(task ? "project" : "global");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  // The focus goes back to "Save as memory" on Cancel, and to the saved line's link after Save.
  const [trigger, focusTrigger] = useFocusLater<HTMLButtonElement>();
  const [savedLink, focusSavedLink] = useFocusLater<HTMLButtonElement>();
  if (saved) {
    return (
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ok" data-testid="memory-saved">
        {saved}
        <button ref={savedLink} className="text-accent hover:underline" onClick={() => setCustomizePage("memory")}>
          Customize › Memory
        </button>
      </div>
    );
  }
  if (!open) {
    return (
      <button ref={trigger} data-testid="save-memory" className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-muted hover:text-fg" title="Keep this as a note for the next tasks' briefs" onClick={() => setOpen(true)}>
        <BookmarkPlus className="h-3 w-3" /> Save as memory
        {children}
      </button>
    );
  }
  const hint = memoryHint(note);
  const save = async () => {
    setBusy(true);
    setError(null);
    const result = await saveMemory({ text: note, scope, ...(scope === "project" && task ? { repoId: task.repoId } : {}), from });
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    const where = scope === "project" && task ? `the next tasks in ${task.repoName}` : "the next tasks in every project";
    focusSavedLink();
    setSaved(usesTemplate ? `Saved: ${where} get it in their brief.` : "Saved. Your brief template doesn't use {{memory}}, so tasks don't get it yet.");
  };
  const cancel = () => {
    focusTrigger();
    setOpen(false);
  };
  return (
    <form
      className="mt-1 w-full max-w-xl space-y-1.5 rounded-md border border-line bg-panel p-2 text-xs"
      data-testid="memory-form"
      onKeyDown={escapeCancels(cancel)}
      onSubmit={(e) => {
        e.preventDefault();
        if (!hint && !busy) void save();
      }}
    >
      <input aria-label="The note" data-testid="memory-text" autoFocus className={`${field} w-full font-sans`} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="For which tasks" data-testid="memory-scope" className={field} value={scope} onChange={(e) => setScope(e.target.value as "project" | "global")}>
          {task && <option value="project">This project ({task.repoName})</option>}
          <option value="global">Every project</option>
        </select>
        <span className={hint && note.trim() ? "text-warn" : "text-muted"}>{hint && note.trim() ? hint : `${note.trim().length}/300`}</span>
      </div>
      {error && (
        <div className="text-bad" data-testid="memory-error">
          {error}
        </div>
      )}
      <div className="flex gap-1.5">
        <button type="submit" data-testid="memory-save" className={primary} disabled={Boolean(hint) || busy}>
          Save note
        </button>
        <button type="button" className={small} onClick={cancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
