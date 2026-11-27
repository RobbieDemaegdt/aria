/**
 * "Always allow this" (PLAN.md §5.3, D26–D29): the exact Auto rules that would let a command a task asked about (or
 * your rule refused) run on its own, worked out when ARIA decided it, with the task's policy context minus its
 * grants (a rule is about every task). Never for a fixed rule's refusal, a destructive command, a command a rule can't
 * name exactly, or one that reaches outside the worktree without the sandbox (a rule widens which programs run, not
 * where). The offer is checked by construction: with its rules added, the policy engine must let the same request run.
 */
import { randomUUID } from "node:crypto";
import type { PolicyRule, RuleOffer, RuleScope } from "@aria/protocol";
import type { PermissionAsk } from "../runtime/types.ts";
import { commandParts, WorkerPolicy } from "../tasks/policy.ts";
import { checkRule } from "./breadth.ts";
import { GLOBAL_VALUE_OPTIONS, parseCommand, type ParsedCommand } from "./command.ts";
import { ruleKey } from "./settings.ts";
import { decideWorker, destroysOf, fixedRefusal, namesFolder, type PolicyDecision, type WorkerPolicyContext } from "./worker.ts";

export type OfferDraft = Pick<RuleOffer, "rules" | "decided" | "scope" | "overrides">;
export type OfferResult = { offer: OfferDraft } | { none: string };

/** A word a rule can name as it is: nothing PowerShell would need quotes for, and no `@` in front (splatting). */
const plainWord = (arg: string) => /^[\w.:/\\=+%@-]+$/.test(arg) && !arg.startsWith("@");
const none = (why: string): OfferResult => ({ none: why });
const collapse = (match: string) => match.trim().replace(/\s+/g, " ");

/** An option that takes the next word as its value before the subcommand (`git -C dir`, `npm --prefix x`). */
const globalValue = (parsed: ParsedCommand) => {
  const options = GLOBAL_VALUE_OPTIONS[parsed.program] ?? [];
  const first = parsed.positionalAt[0] ?? parsed.args.length;
  return parsed.args.slice(0, first).some((arg) => options.includes(arg));
};

export function ruleOffer(ask: PermissionAsk, ctx: WorkerPolicyContext, decision: PolicyDecision): OfferResult {
  if (ask.kind !== "shell") return none("only commands have rules");
  if (decision.effect === "auto") return none("it runs on its own");
  // An offer is about every task: the task's own grants don't count.
  const base: WorkerPolicyContext = { ...ctx, grants: [] };
  // The same code that refuses it: never offered for a fixed rule's refusal.
  if (fixedRefusal(ask, base)) return none("a fixed rule refuses it");
  const texts = commandParts(ask);
  const segments: Array<{ text: string; parsed: ParsedCommand }> = [];
  for (const text of texts) {
    const parsed = parseCommand(text);
    if (!parsed) return none(`ARIA can't read \`${text}\``);
    if (parsed.unreadable) return none(`\`${text}\` can't be named exactly: ${parsed.unreadable}`);
    if (parsed.withEmpty) return none(`\`${text}\` has an empty argument`);
    if (!plainWord(parsed.programToken) || namesFolder(parsed.programToken)) return none(`\`${text}\` names its program by its folder or with quotes`);
    if (!parsed.args.every(plainWord)) return none(`\`${text}\` has an argument a rule can't name as it is (it needs quotes)`);
    if (globalValue(parsed)) return none(`\`${text}\` has an option before its command that takes a value`);
    segments.push({ text, parsed });
  }
  if (destroysOf(segments, ctx, ask.cwd ?? ctx.worktree).some((what) => what !== undefined)) return none("it's destructive: it asks every time");
  if (!ctx.sandboxed) {
    // A rule could only make the program count as allowed: its arguments are still checked.
    const why = new WorkerPolicy({ worktree: ctx.worktree, readTools: ctx.readTools, extraAllow: () => true }).check({ ...ask, segments: texts });
    if (why) return none(`a rule couldn't make it run on its own: ${why}`);
  }
  const scope: RuleScope = ctx.sandboxed ? "sandboxed" : "everywhere";
  const rules: OfferDraft["rules"] = [];
  const overrides: NonNullable<OfferDraft["overrides"]> = [];
  for (const { text, parsed } of segments) {
    // One rule per command of the line that doesn't run on its own already.
    const alone = decideWorker({ ...ask, command: text, segments: [text] }, base);
    if (alone.effect === "auto") continue;
    const match = [parsed.programToken, ...parsed.args].join(" ");
    const check = checkRule({ match, effect: "auto", exact: true, scope });
    if (check.problems.length > 0) return none(check.problems[0]!);
    if (!rules.some((r) => r.match === match)) rules.push({ match, exact: true });
    if (alone.effect === "never" && alone.rule && !overrides.some((o) => o.ruleId === alone.rule!.id)) {
      overrides.push({ ruleId: alone.rule.id, match: alone.rule.match, sameRule: alone.rule.exact === true && collapse(alone.rule.match) === match });
    }
  }
  if (rules.length === 0) return none("each command in it runs on its own already");
  const draft: OfferDraft = { rules, decided: decision.effect, scope, ...(overrides.length ? { overrides } : {}) };
  // Checked by construction: with these rules, the same request runs on its own.
  const after = decideWorker(ask, { ...base, rules: applyOffer(ctx.rules, draft, rules, { note: "" }) });
  if (after.effect !== "auto") return none(after.effect === "never" ? `it would still be refused: ${after.reason}` : "it would still ask");
  return { offer: draft };
}

/**
 * Your rules with an offer's rules saved (as you edited them): a rule with the same key is replaced (it keeps its id);
 * your Never rule for exactly this command becomes the Auto rule; any other rule is added at the end.
 */
export function applyOffer(
  existing: readonly PolicyRule[],
  offer: Pick<RuleOffer, "scope" | "overrides">,
  rules: ReadonlyArray<{ match: string; exact: boolean }>,
  options: { note: string; newId?: () => string },
): PolicyRule[] {
  const next = existing.map((rule) => ({ ...rule }));
  for (const input of rules) {
    const match = collapse(input.match);
    const made = (id: string): PolicyRule => ({ id, match, effect: "auto", ...(options.note ? { note: options.note } : {}), ...(input.exact ? { exact: true } : {}), scope: offer.scope });
    const same = input.exact ? offer.overrides?.find((o) => o.sameRule && collapse(o.match) === match) : undefined;
    const at = same ? next.findIndex((r) => r.id === same.ruleId) : -1;
    const key = ruleKey({ match, exact: input.exact, scope: offer.scope });
    const index = at >= 0 ? at : next.findIndex((r) => ruleKey(r) === key);
    if (index >= 0) next[index] = made(next[index]!.id);
    else next.push(made(options.newId?.() ?? randomUUID()));
  }
  return next;
}
