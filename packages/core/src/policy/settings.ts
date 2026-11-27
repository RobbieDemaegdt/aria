/** Your worker permission rules and sandbox settings (Customize › Permissions; PLAN.md §4.8, D20, D26, D27). */
import { randomUUID } from "node:crypto";
import type { PolicyRule, RuleEffect, RuleScope } from "@aria/protocol";
import type { Store } from "../store/store.ts";
import { checkRule } from "./breadth.ts";
import { ruleShape } from "./command.ts";
import { DEFAULT_ALLOWED_HOSTS, DEFAULT_RULES } from "./defaults.ts";

const RULES_KEY = "policy.rules";
const SANDBOX_KEY = "sandbox.settings";
const LEGACY_DEFAULT_HOSTS = ["registry.npmjs.org", "registry.yarnpkg.com", "repo.yarnpkg.com", "api.nuget.org", "*.nuget.org"];

function isLegacyDefaultHosts(hosts: readonly string[] | undefined): boolean {
  if (!hosts || hosts.length !== LEGACY_DEFAULT_HOSTS.length) return false;
  return LEGACY_DEFAULT_HOSTS.every((h) => hosts.includes(h));
}

export interface SandboxSettings {
  /** Run tasks in the runtime's sandbox when the PC can. */
  enabled: boolean;
  /** Hosts sandboxed tasks may reach. */
  allowedHosts: string[];
  /** Local directories or files sandboxed tasks may read outside their worktrees. */
  allowedPaths: string[];
}

export interface RuleInput {
  id?: string | undefined;
  match: string;
  effect: RuleEffect;
  note?: string | undefined;
  exact?: boolean | undefined;
  scope?: RuleScope | undefined;
}

const collapse = (match: string) => match.trim().replace(/\s+/g, " ");

/**
 * Two rules with the same key are the same rule: the same words (an exact rule's letter case counts, as it does when
 * it matches), the same exactness and the same scope.
 */
export const ruleKey = (rule: { match: string; exact?: boolean | undefined; scope?: RuleScope | undefined }) =>
  `${rule.scope ?? "everywhere"}|${rule.exact ? `exact|${collapse(rule.match)}` : collapse(rule.match).toLowerCase()}`;

/** The same rule as saved before: nothing about what it allows changed (its note may have). */
const unchanged = (a: PolicyRule, b: PolicyRule) =>
  a.id === b.id && a.match === b.match && a.effect === b.effect && (a.exact === true) === (b.exact === true) && (a.scope ?? "everywhere") === (b.scope ?? "everywhere");

export class PolicyStore {
  constructor(private readonly deps: { db: () => Store }) {}

  /** Yours, or the defaults until you change them (so new defaults reach you until then). */
  rules(): PolicyRule[] {
    return this.deps.db().getSetting<PolicyRule[]>(RULES_KEY) ?? DEFAULT_RULES.map((rule) => ({ ...rule }));
  }

  /** Whether your rules are still the defaults (saving any rule makes the list yours). */
  usesDefaults(): boolean {
    return this.deps.db().getSetting<PolicyRule[] | null>(RULES_KEY) == null;
  }

  /**
   * Saves the whole list. A new or changed Auto rule has to pass the save checks (D26: breadth, destructive commands);
   * one saved before and unchanged is kept as it is, so an old rule never blocks an unrelated save.
   */
  saveRules(input: readonly RuleInput[]): PolicyRule[] {
    const stored = this.rules();
    const seen = new Set<string>();
    const rules = input.map((rule): PolicyRule => {
      const match = collapse(rule.match);
      const shape = ruleShape(match);
      if (!shape || /^[<-]/.test(shape.program) || shape.program.startsWith("/")) throw new Error(`\`${match}\` doesn't start with a command.`);
      const key = ruleKey({ match, exact: rule.exact, scope: rule.scope });
      if (seen.has(key)) throw new Error(`There are two rules for \`${match}\`.`);
      seen.add(key);
      const next: PolicyRule = {
        id: rule.id ?? randomUUID(),
        match,
        effect: rule.effect,
        ...(rule.note?.trim() ? { note: rule.note.trim() } : {}),
        ...(rule.exact ? { exact: true } : {}),
        ...(rule.scope ? { scope: rule.scope } : {}),
      };
      if (next.effect === "auto" && !stored.some((s) => unchanged(s, next))) {
        const { problems } = checkRule(next);
        if (problems.length > 0) throw new Error(`\`${match}\`: ${problems[0]}`);
      }
      return next;
    });
    this.deps.db().setSetting(RULES_KEY, rules);
    return rules;
  }

  resetRules(): PolicyRule[] {
    this.deps.db().setSetting(RULES_KEY, null);
    return this.rules();
  }

  sandbox(): SandboxSettings {
    const stored = this.deps.db().getSetting<Partial<SandboxSettings>>(SANDBOX_KEY) ?? {};
    const allowedHosts = !stored.allowedHosts || isLegacyDefaultHosts(stored.allowedHosts) ? [...DEFAULT_ALLOWED_HOSTS] : stored.allowedHosts;
    const allowedPaths = Array.isArray(stored.allowedPaths) ? stored.allowedPaths.map((p) => p.trim()).filter(Boolean) : [];
    return { enabled: stored.enabled ?? true, allowedHosts, allowedPaths };
  }

  setSandbox(patch: Partial<SandboxSettings>): SandboxSettings {
    const hosts = patch.allowedHosts ? [...new Set(patch.allowedHosts.map((h) => h.trim().toLowerCase()).filter(Boolean))] : undefined;
    const paths = patch.allowedPaths ? [...new Set(patch.allowedPaths.map((p) => p.trim()).filter(Boolean))] : undefined;
    const next: SandboxSettings = {
      ...this.sandbox(),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(hosts ? { allowedHosts: hosts } : {}),
      ...(paths ? { allowedPaths: paths } : {}),
    };
    this.deps.db().setSetting(SANDBOX_KEY, next);
    return next;
  }
}
