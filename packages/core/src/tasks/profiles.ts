/**
 * Worker profiles (PLAN.md §4.12): named model + effort presets for background tasks, chosen by you. Every model is
 * checked against the runtime's catalog in ARIA's own code (the runtime's allowedModels substitutes silently,
 * Phase 0), and the profile policy decides whether ARIA may pick a non-default profile.
 */
import { randomUUID } from "node:crypto";
import type { Profile, ProfilePolicy, TaskMode } from "@aria/protocol";
import type { RuntimeModel } from "../runtime/types.ts";
import type { Store, StoredProfile } from "../store/store.ts";

export interface ProfileInput {
  id?: string | undefined;
  name: string;
  description?: string | undefined;
  model: string;
  reasoningEffort?: string | undefined;
  agent?: string | null | undefined;
  mode: TaskMode;
  instructions?: string | undefined;
  budgetCredits?: number | null | undefined;
}

const byPrice = (a: RuntimeModel, b: RuntimeModel) =>
  (a.inputPrice ?? 1e9) + (a.outputPrice ?? 1e9) - ((b.inputPrice ?? 1e9) + (b.outputPrice ?? 1e9)) || a.id.localeCompare(b.id);
const realEfforts = (m: RuntimeModel) => m.efforts.filter((e) => e !== "none");

/** A budget that fits the model: about two million input tokens' worth, at least 5 credits. Pausing is harmless. */
const seedBudget = (m: RuntimeModel) => Math.max(5, Math.round((m.inputPrice ?? 10) * 2));

/** Whole-word, case-insensitive: does your message name this profile? */
export function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

const NON_PROFILE_WORDS = new Set([
  "deeper",
  "deepest",
  "deeply",
  "deepen",
  "deepened",
  "deepening",
  "deepness",
  "quickly",
  "quicker",
  "quickest",
  "quicken",
  "quickened",
  "quickening",
  "quickness",
  "keep",
  "keeps",
  "kept",
  "beep",
  "peep",
  "seep",
  "weep",
  "jeep",
  "deer",
  "deed",
  "deem",
  "step",
  "need",
  "feed",
  "seed",
  "weed",
  "meet",
  "feel",
  "seem",
  "been",
  "seen",
  "teen",
  "keen",
  "peer",
  "week",
  "seek",
  "peek",
  "geek",
  "leek",
  "reek",
  "meek",
  "free",
  "tree",
  "quirk",
  "quirks",
  "quirky",
  "quack",
  "quite",
  "quiet",
  "quit",
  "quiz",
  "click",
  "stick",
  "thick",
  "trick",
  "brick",
  "kick",
  "pick",
  "sick",
  "wick",
  "nick",
  "lick",
  "dock",
  "docks",
  "does",
  "dogs",
  "dots",
  "done",
  "dont",
  "code",
  "mode",
  "node",
  "load",
  "road",
  "test",
  "best",
  "rest",
  "west",
  "next",
  "text",
  "task",
  "last",
  "past",
  "cast",
  "vast",
  "mast",
  "fact",
  "fall",
  "fail",
  "fair",
  "far",
  "six",
  "mix",
  "this",
  "that",
  "with",
  "from",
  "into",
  "only",
  "some",
  "more",
  "most",
  "much",
  "many",
  "make",
  "made",
  "main",
]);

const GENERIC_MODEL_TOKENS = new Set(["fake", "model", "default", "preview", "latest", "auto", "standard"]);

const collapseRuns = (s: string) => s.replace(/(.)\1+/g, "$1");
const normalizeCompact = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

function isAdjacentSwap(a: string, b: string): boolean {
  if (a.length !== b.length || a === b) return false;
  for (let i = 0; i < a.length - 1; i++) {
    if (a[i] !== b[i]) {
      const swapped = a.slice(0, i) + a[i + 1]! + a[i]! + a.slice(i + 2);
      return swapped === b;
    }
  }
  return false;
}

function damerauLevenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, dp[i - 2]![j - 2]! + 1);
      }
      dp[i]![j] = val;
    }
  }
  return dp[m]![n]!;
}

function extractExplicitPhrases(text: string): Set<string> {
  const phrases = new Set<string>();
  const add = (raw: string | undefined) => {
    const cleaned = raw?.trim().toLowerCase().replace(/^["'`[\]()]+|["'`[\]().,!?;:]+$/g, "").trim();
    if (!cleaned) return;
    phrases.add(cleaned);
    for (const part of cleaned.split(/\s+/)) {
      if (part) phrases.add(part);
    }
  };

  for (const m of text.matchAll(/\bprofile\s*[:=-]\s*([a-z0-9_-]+(?:\s+[a-z0-9_-]+)?)/gi)) add(m[1]);
  for (const m of text.matchAll(/\b(?:the\s+|a\s+|an\s+)?([a-z0-9_-]+(?:\s+[a-z0-9_-]+)?)\s+profile\b/gi)) add(m[1]);
  for (const m of text.matchAll(/\bprofile\s+([a-z0-9_-]+(?:\s+[a-z0-9_-]+)?)\b/gi)) add(m[1]);
  for (const m of text.matchAll(/\b(?:in|on)\s+(?:the\s+|a\s+|an\s+)?([a-z0-9_.-]+(?:\s+[a-z0-9_.-]+)?)\s+(?:profile|model|preset|worker)\b/gi)) {
    add(m[1]);
  }
  for (const m of text.matchAll(
    /\b(?:use|using|with|via|pick|choose|select|run\s+with|run\s+on|run\s+in|start\s+with|start\s+on|switch\s+to)\s+(?:the\s+|a\s+|an\s+)?([a-z0-9_.-]+(?:\s+[a-z0-9_.-]+)?)(?:\s+(?:profile|model|mode|one|preset|worker|session))?(?=\s+(?:for|on|to|in|and|with|please)\b|\s*[,.!?;:)\]]|\s*$)/gi,
  )) {
    add(m[1]);
  }
  const leading = /^\s*(?:[[(]\s*(?:profile\s*[:=-]?\s*)?([a-z0-9][a-z0-9 _.-]{0,24}?)\s*(?:profile)?\s*[\])]\s*[:—–-]?|([a-z0-9][a-z0-9 _-]{0,18}?)\s*(?:profile)?\s*[:—–-])\s+\S/i.exec(text);
  if (leading) add(leading[1] ?? leading[2]);

  const trailing = /\S\s+(?:[[(]\s*(?:use\s+|with\s+|profile\s*[:=-]?\s*)?([a-z0-9][a-z0-9 _.-]{0,24}?)\s*(?:profile)?\s*[\])]|[—–-]\s*(?:use\s+|with\s+|profile\s*[:=-]?\s*)?([a-z0-9][a-z0-9 _.-]{0,20}?)(?:\s+profile)?|\/([a-z0-9_-]{2,20}))\s*[.!?;]*\s*$/i.exec(
    text,
  );
  if (trailing) add(trailing[1] ?? trailing[2] ?? trailing[3]);

  return phrases;
}

function fuzzyScoreName(candidate: string, profileName: string, inExplicitContext: boolean): number {
  const w = candidate.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  const t = profileName.toLowerCase().trim();
  if (!w || !t || NON_PROFILE_WORDS.has(w)) return 0;
  if (w === t) return inExplicitContext ? 100 : 92;

  const wCompact = normalizeCompact(w);
  const tCompact = normalizeCompact(t);
  if (!wCompact || !tCompact || NON_PROFILE_WORDS.has(wCompact)) return 0;
  if (wCompact === tCompact && tCompact.length >= 2) return inExplicitContext ? 96 : 90;
  if (tCompact.length < 3 || wCompact.length < 3) return 0;

  if (collapseRuns(wCompact) === collapseRuns(tCompact)) {
    if (wCompact.length >= tCompact.length) return inExplicitContext ? 90 : 84;
    if (inExplicitContext && wCompact.length >= tCompact.length - 1) return 84;
  }

  if (wCompact.replace(/ck/g, "k") === tCompact.replace(/ck/g, "k")) {
    return inExplicitContext ? 90 : 84;
  }

  if (isAdjacentSwap(wCompact, tCompact)) {
    return inExplicitContext ? 90 : 82;
  }

  const dist = damerauLevenshtein(wCompact, tCompact);
  if (inExplicitContext) {
    if (dist === 1 && tCompact.length >= 4 && (wCompact[0] === tCompact[0] || wCompact.at(-1) === tCompact.at(-1))) return 82;
    if (dist <= 2 && tCompact.length >= 6 && wCompact[0] === tCompact[0]) return 76;
  } else if (dist === 1 && tCompact.length >= 4 && wCompact.length >= 4 && wCompact[0] === tCompact[0] && wCompact.at(-1) === tCompact.at(-1)) {
    if (tCompact.length >= 5) return 78;
    if (wCompact.length > tCompact.length || [...wCompact].every((ch) => tCompact.includes(ch))) return 78;
  }

  return 0;
}

/**
 * Smart-matches a worker profile from the user's message using exact names, normalized/hyphenated names,
 * typo-tolerant fuzzy matching, prefix/suffix tags, semantic intent keywords/aliases, and model names/families.
 * Returns undefined when no profile matches with high confidence or when the top matches are ambiguous.
 */
export function matchProfile(text: string, profiles: readonly Profile[], models: readonly RuntimeModel[] = []): Profile | undefined {
  if (!text?.trim() || profiles.length === 0) return undefined;

  const explicitPhrases = extractExplicitPhrases(text);
  const rawTokens = Array.from(text.matchAll(/[\p{L}\p{N}]+(?:[-_.][\p{L}\p{N}]+)*/gu), (m) => m[0].toLowerCase());
  const wordTokens = Array.from(text.matchAll(/[\p{L}\p{N}]+/gu), (m) => m[0].toLowerCase());
  const bigrams: string[] = [];
  for (let i = 0; i < wordTokens.length - 1; i++) {
    bigrams.push(`${wordTokens[i]!} ${wordTokens[i + 1]!}`);
  }

  const scores = new Map<string, number>();
  const bump = (profile: Profile | undefined, score: number) => {
    if (!profile || score <= 0) return;
    const prev = scores.get(profile.id) ?? 0;
    if (score > prev) scores.set(profile.id, score);
  };

  // 1. Profile name matching (exact, normalized, prefix/suffix, and typo/fuzzy).
  for (const profile of profiles) {
    const lowerName = profile.name.toLowerCase().trim();
    if (mentions(text, profile.name)) {
      const isExplicit = explicitPhrases.has(lowerName) || explicitPhrases.has(normalizeCompact(lowerName));
      bump(profile, isExplicit ? 100 : 92);
    }
    for (const phrase of explicitPhrases) {
      bump(profile, fuzzyScoreName(phrase, profile.name, true));
    }
    for (const token of rawTokens) {
      bump(profile, fuzzyScoreName(token, profile.name, explicitPhrases.has(token)));
    }
    for (const token of wordTokens) {
      bump(profile, fuzzyScoreName(token, profile.name, explicitPhrases.has(token)));
    }
    for (const bg of bigrams) {
      bump(profile, fuzzyScoreName(bg, profile.name, explicitPhrases.has(bg)));
    }
  }

  // Identify canonical profiles for semantic intent & model-tier fallbacks.
  const modelById = new Map(models.map((m) => [m.id, m]));
  const nonDefault = profiles.filter((p) => !p.isDefault);
  const quickProfile =
    profiles.find((p) => p.name.toLowerCase() === "quick") ??
    nonDefault.find((p) => modelById.get(p.model)?.category === "lightweight" || p.reasoningEffort === "low");
  const deepProfile =
    profiles.find((p) => p.name.toLowerCase() === "deep") ??
    nonDefault.find((p) => modelById.get(p.model)?.category === "powerful" || p.reasoningEffort === "high" || p.reasoningEffort === "xhigh");
  const ciProfile = profiles.find((p) => normalizeCompact(p.name) === "cifix" || p.name.toLowerCase() === "ci");

  // 2. Semantic intent keywords & aliases.
  if (quickProfile) {
    if (
      /\b(?:fast|quick|speedy|rapid|lightweight|brief|cheap)\s+(?:profile|mode|model|worker|session|preset)\b/i.test(text) ||
      /\blight\s+(?:profile|model|worker|session|preset)\b/i.test(text) ||
      /\bprofile\s*[:=-]?\s*(?:fast|quick|speedy|rapid|lightweight|light|speed|low)\b/i.test(text) ||
      /\b(?:use|using|with|in|on)\s+(?:a\s+|the\s+)?(?:fast|speedy|rapid|lightweight)\b/i.test(text) ||
      /\b(?:low|minimal)\s+(?:effort|reasoning|thinking)\b/i.test(text) ||
      /\b(?:effort|reasoning)\s*[:=-]?\s*low\b/i.test(text) ||
      ["fast", "speed", "speedy", "rapid", "lightweight", "low effort", "low reasoning"].some((k) => explicitPhrases.has(k))
    ) {
      bump(quickProfile, 82);
    } else if (
      /\b(?:fast|speedy|lightweight|rapid)\b(?!\s*[-–]?\s*forward\b)/i.test(text) ||
      /\b(?:for\s+speed|with\s+speed|prioritize\s+speed)\b/i.test(text)
    ) {
      bump(quickProfile, 68);
    }
  }

  if (deepProfile) {
    if (
      /\b(?:deep|thorough|heavy|complex|intensive|exhaustive|rigorous|careful|powerful|strong|hard)\s+(?:profile|mode|model|worker|session|preset)\b/i.test(text) ||
      /\b(?:deep|high|xhigh|max|maximum|extra|extended|thorough|heavy|strong|intensive)\s+(?:reasoning|effort|thinking|thought|analysis)\b/i.test(text) ||
      /\b(?:reasoning|effort)\s*[:=-]?\s*(?:high|xhigh|max|deep)\b/i.test(text) ||
      /\bprofile\s*[:=-]?\s*(?:deep|thorough|heavy|complex|strong|powerful|high|xhigh|max)\b/i.test(text) ||
      /\b(?:use|using|with|in|on)\s+(?:a\s+|the\s+)?(?:thorough|heavy|powerful|strong|intensive|rigorous|exhaustive|in-depth|indepth)\b/i.test(text) ||
      /\b(?:think\s+hard|think\s+deeply|be\s+thorough|in-depth|indepth)\b/i.test(text) ||
      ["thorough", "heavy", "complex", "powerful", "strong", "intensive", "rigorous", "exhaustive", "high reasoning", "deep reasoning", "high effort"].some((k) =>
        explicitPhrases.has(k),
      )
    ) {
      bump(deepProfile, 82);
    } else if (
      /\b(?:thorough|thoroughly|exhaustive|rigorous)\b/i.test(text) ||
      /\b(?:heavy|complex)\s+(?:refactor|refactoring|task|analysis|investigation|audit|architecture|migration)\b/i.test(text)
    ) {
      bump(deepProfile, 68);
    }
  }

  if (ciProfile) {
    if (
      /\b(?:ci|ci\s*fix|cifix|bug\s*fix|bugfix|hotfix)\s+(?:profile|mode|worker|session|preset)\b/i.test(text) ||
      /\bprofile\s*[:=-]?\s*(?:ci|ci\s*fix|cifix|bugfix|bug\s*fix|hotfix)\b/i.test(text) ||
      /\b(?:use|using|with|in|on)\s+(?:the\s+|a\s+)?(?:ci|ci\s*fix|cifix|bugfix|hotfix)\b/i.test(text) ||
      ["ci", "ci fix", "cifix", "ci-fix", "bugfix", "bug fix", "hotfix"].some((k) => explicitPhrases.has(k))
    ) {
      bump(ciProfile, 82);
    } else if (
      /\b(?:bugfix|hotfix)\b/i.test(text) ||
      /\b(?:fix\s+(?:the\s+)?(?:failing\s+|red\s+|broken\s+)?ci|failing\s+ci|red\s+ci|broken\s+ci|ci\s+failure)\b/i.test(text)
    ) {
      bump(ciProfile, 68);
    }
  }

  // 3. Model ID, display name, and model family matching.
  const defaultProfile = profiles.find((p) => p.isDefault);
  const isInheritedCiModel = (p: Profile) => p.id === ciProfile?.id && defaultProfile !== undefined && p.model === defaultProfile.model;

  const profilesByModel = new Map<string, Profile[]>();
  for (const p of profiles) {
    if (isInheritedCiModel(p)) continue;
    const list = profilesByModel.get(p.model) ?? [];
    list.push(p);
    profilesByModel.set(p.model, list);
  }

  const catalogTokens = new Map<string, Profile[]>();
  for (const p of profiles) {
    if (isInheritedCiModel(p)) continue;
    const rm = modelById.get(p.model);
    const exactNames = [p.model, rm?.name].filter((v): v is string => Boolean(v));
    for (const exact of exactNames) {
      if (mentions(text, exact) || rawTokens.some((t) => normalizeCompact(t) === normalizeCompact(exact))) {
        const owners = profilesByModel.get(p.model) ?? [p];
        const nonDefaultOwners = owners.filter((o) => !o.isDefault);
        if (owners.length === 1) bump(p, 84);
        else if (nonDefaultOwners.length === 1 && !p.isDefault) bump(p, 76);
      }
    }
    const parts = new Set(
      exactNames
        .flatMap((n) => n.toLowerCase().split(/[-_.\s/]+/))
        .filter((tok) => tok.length >= 2 && !GENERIC_MODEL_TOKENS.has(tok) && !/^\d+$/.test(tok)),
    );
    for (const tok of parts) {
      const list = catalogTokens.get(tok) ?? [];
      if (!list.some((x) => x.id === p.id)) list.push(p);
      catalogTokens.set(tok, list);
    }
  }

  const AMBIGUOUS_ADJECTIVE_TOKENS = new Set(["strong", "light", "fast", "deep", "quick"]);
  for (const [tok, owners] of catalogTokens) {
    if (tok === "light" && /\blight\s+(?:mode|theme)\b/i.test(text)) continue;
    const isAdjective = AMBIGUOUS_ADJECTIVE_TOKENS.has(tok);
    const mentionedInContext =
      explicitPhrases.has(tok) ||
      new RegExp(`\\b(?:use|using|with)\\s+(?:the\\s+|a\\s+)?${tok}(?!\\s+(?:mode|theme)\\b)\\b`, "i").test(text) ||
      new RegExp(`\\b${tok}\\s+(?:model|profile|worker)\\b`, "i").test(text);
    const mentionedStandalone = !isAdjective && (mentions(text, tok) || rawTokens.some((r) => r.startsWith(`${tok}-`) || r.startsWith(`${tok}_`)));
    if (!mentionedInContext && !mentionedStandalone) continue;

    const nonDefaultOwners = owners.filter((o) => !o.isDefault);
    if (owners.length === 1) {
      bump(owners[0], mentionedInContext ? 80 : 74);
    } else if (nonDefaultOwners.length === 1) {
      bump(nonDefaultOwners[0], mentionedInContext ? 74 : 68);
    }
  }

  // Fallback well-known model family/tier names when not present as distinct models in the catalog.
  const hasCatalogFamily = (family: string[]) => family.some((f) => catalogTokens.has(f));
  if (deepProfile && !hasCatalogFamily(["opus", "sonnet", "claude", "gpt", "codex", "o1", "o3"])) {
    if (
      /\b(?:claude[-\s]?(?:opus|sonnet)|(?:opus|sonnet)(?:[-\s]?\d+(?:\.\d+)?)?|gpt[-\s]?5(?:\.\d+)?|o1|o3)\b/i.test(text) ||
      /\b(?:use|using|with|on|in)\s+(?:the\s+|a\s+)?(?:claude|sonnet|opus|codex)\b/i.test(text) ||
      /\b(?:claude|sonnet|opus|codex)\s+(?:model|profile|mode|worker)\b/i.test(text) ||
      ["claude", "sonnet", "opus", "codex", "o1", "o3", "gpt-5"].some((k) => explicitPhrases.has(k))
    ) {
      bump(deepProfile, 78);
    }
  }
  if (quickProfile && !hasCatalogFamily(["haiku", "flash", "mini", "nano"])) {
    if (
      /\b(?:claude[-\s]?haiku|haiku(?:[-\s]?\d+(?:\.\d+)?)?|gemini[-\s]?flash|gpt[-\s]?4o?[-\s]?mini|o4[-\s]?mini)\b/i.test(text) ||
      /\b(?:use|using|with|on|in)\s+(?:the\s+|a\s+)?(?:haiku|flash|mini|nano)\b/i.test(text) ||
      /\b(?:haiku|flash|mini|nano)\s+(?:model|profile|mode|worker)\b/i.test(text) ||
      ["haiku", "flash", "mini", "nano"].some((k) => explicitPhrases.has(k))
    ) {
      bump(quickProfile, 78);
    }
  }

  // 4. Thresholding & disambiguation.
  const THRESHOLD = 65;
  const MIN_MARGIN = 15;
  const ranked = profiles
    .map((profile) => ({ profile, score: scores.get(profile.id) ?? 0 }))
    .filter((entry) => entry.score >= THRESHOLD)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) return undefined;
  const best = ranked[0]!;
  const second = ranked[1];
  if (second && best.score - second.score < MIN_MARGIN) return undefined;
  return best.profile;
}

export class Profiles {
  constructor(
    private readonly deps: {
      db: () => Store;
      models: () => RuntimeModel[];
    },
  ) {}

  list(): Profile[] {
    const defaultId = this.defaultId();
    return this.deps
      .db()
      .listProfiles()
      .map((p) => ({ ...p, isDefault: p.id === defaultId }));
  }

  get(id: string): Profile | undefined {
    return this.list().find((p) => p.id === id);
  }

  byName(name: string): Profile | undefined {
    const key = name.trim().toLowerCase();
    return this.list().find((p) => p.name.toLowerCase() === key);
  }

  default(): Profile | undefined {
    return this.list().find((p) => p.isDefault);
  }

  private defaultId(): string | undefined {
    const db = this.deps.db();
    const all = db.listProfiles();
    const stored = db.getSetting<string>("profiles.defaultId");
    return all.some((p) => p.id === stored) ? stored : all[0]?.id;
  }

  policy(): ProfilePolicy {
    return this.deps.db().getSetting<ProfilePolicy>("profiles.policy") ?? "me";
  }

  setPolicy(policy: ProfilePolicy): void {
    this.deps.db().setSetting("profiles.policy", policy);
  }

  /** "Fix it uses" (D47): the profile you picked for Fix it's new tasks, if it's still there. */
  ciFixId(): string | undefined {
    const stored = this.deps.db().getSetting<string>("profiles.ciFixId");
    return stored && this.deps.db().listProfiles().some((p) => p.id === stored) ? stored : undefined;
  }

  /** The profile Fix it's new tasks (an adopted branch, a red default branch) run with: yours for it, else Default. */
  ciFix(): Profile | undefined {
    const id = this.ciFixId();
    return (id ? this.get(id) : undefined) ?? this.default();
  }

  setCiFix(id: string | null): void {
    if (id !== null && !this.get(id)) throw new Error("That profile doesn't exist anymore.");
    this.deps.db().setSetting("profiles.ciFixId", id);
  }

  /** First start with a model catalog: Default, Quick and Deep from what the runtime offers (you can change them). */
  seedIfEmpty(): boolean {
    const db = this.deps.db();
    if (db.listProfiles().length > 0) return false;
    const enabled = this.deps.models().filter((m) => m.enabled).sort(byPrice);
    if (enabled.length === 0) return false;
    const inCategory = (category: string) => enabled.filter((m) => m.category === category);
    const pick = (model: RuntimeModel, prefer: string[], fallback: "low" | "high") => {
      const efforts = realEfforts(model);
      return prefer.find((e) => efforts.includes(e)) ?? (fallback === "low" ? efforts[0] : efforts.at(-1));
    };
    const everyday = inCategory("versatile")[0] ?? enabled[0]!;
    const quick = inCategory("lightweight")[0] ?? enabled[0]!;
    const deep = inCategory("powerful")[0] ?? enabled.at(-1)!;
    const seeds: Array<{ name: string; description: string; model: RuntimeModel; effort: string | undefined }> = [
      { name: "Default", description: "Everyday tasks.", model: everyday, effort: pick(everyday, ["medium"], "low") },
      { name: "Quick", description: "Small fixes, docs and renames.", model: quick, effort: pick(quick, ["low"], "low") },
      { name: "Deep", description: "Features and refactors that need more thought. Costs more.", model: deep, effort: pick(deep, ["high"], "high") },
      // D47: new installs only (an existing setup gets no profile by itself); Fix it's new tasks use it.
      { name: "CI fix", description: "Fix it's new tasks: a red CI run's fix on a branch it takes over, or on a new branch from the default branch.", model: everyday, effort: pick(everyday, ["medium"], "low") },
    ];
    seeds.forEach((seed, index) => {
      db.saveProfile(
        {
          id: randomUUID(),
          name: seed.name,
          description: seed.description,
          model: seed.model.id,
          ...(seed.effort ? { reasoningEffort: seed.effort } : {}),
          mode: "autopilot",
          budgetCredits: seedBudget(seed.model),
        },
        index,
      );
    });
    db.setSetting("profiles.defaultId", db.listProfiles().find((p) => p.name === "Default")!.id);
    db.setSetting("profiles.ciFixId", db.listProfiles().find((p) => p.name === "CI fix")!.id);
    return true;
  }

  /** Creates or updates a profile after checking its model and effort against the catalog. */
  save(input: ProfileInput): Profile {
    const model = this.deps.models().find((m) => m.id === input.model);
    if (!model || !model.enabled) throw new Error(`${input.model} isn't an available model.`);
    let effort = input.reasoningEffort;
    if (model.efforts.length === 0) effort = undefined;
    else if (!effort || !model.efforts.includes(effort)) throw new Error(`${model.name} supports these effort levels: ${model.efforts.join(", ")}.`);
    const db = this.deps.db();
    const existing = input.id ? db.listProfiles().find((p) => p.id === input.id) : undefined;
    if (input.id && !existing) throw new Error("That profile doesn't exist anymore.");
    const agent = input.agent === null ? undefined : input.agent !== undefined ? input.agent.trim() || undefined : existing?.agent;
    const profile: StoredProfile = {
      id: existing?.id ?? randomUUID(),
      name: input.name.trim(),
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      model: model.id,
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(agent ? { agent } : {}),
      mode: input.mode,
      ...(input.instructions?.trim() ? { instructions: input.instructions.trim() } : {}),
      ...(input.budgetCredits ? { budgetCredits: input.budgetCredits } : {}),
    };
    db.saveProfile(profile, existing ? undefined : db.listProfiles().length);
    return this.get(profile.id)!;
  }

  delete(id: string): void {
    const db = this.deps.db();
    const all = db.listProfiles();
    if (!all.some((p) => p.id === id)) return;
    if (all.length === 1) throw new Error("Keep at least one profile: tasks need one.");
    const wasDefault = this.defaultId() === id;
    db.deleteProfile(id);
    if (wasDefault) db.setSetting("profiles.defaultId", db.listProfiles()[0]!.id);
  }

  setDefault(id: string): void {
    if (!this.deps.db().listProfiles().some((p) => p.id === id)) throw new Error("That profile doesn't exist anymore.");
    this.deps.db().setSetting("profiles.defaultId", id);
  }

  /** Changes only a profile's instructions (Customize › Prompts). */
  setInstructions(id: string, instructions: string): void {
    const db = this.deps.db();
    const existing = db.listProfiles().find((p) => p.id === id);
    if (!existing) throw new Error("That profile doesn't exist anymore.");
    const { instructions: _old, ...rest } = existing;
    db.saveProfile({ ...rest, ...(instructions.trim() ? { instructions: instructions.trim() } : {}) });
  }

  /** Smart-matches a profile from the user's message against the current profiles and model catalog. */
  match(text: string): Profile | undefined {
    return matchProfile(text, this.list(), this.deps.models());
  }

  /**
   * The profile for a task ARIA starts, enforced in code (PLAN.md §4.12):
   * - policy "me": the default, unless your latest message names or smart-matches a profile;
   * - policy "aria": any of your profiles, with ARIA's reason shown on the card;
   * - policy "ask": the same as "aria", but the task only starts once you press Start on ARIA's proposal.
   * Tasks you start yourself use the profile you picked.
   */
  forTask(options: { requested?: string; startedBy: "aria" | "you"; lastUserMessage?: string; reason?: string }): { profile: Profile; note?: string } {
    const fallback = this.default();
    if (!fallback) throw new Error("There are no worker profiles yet. Add one in Customize › Models.");
    const requested = options.requested ? (this.get(options.requested) ?? this.byName(options.requested)) : undefined;
    if (options.requested && !requested) {
      const names = this.list().map((p) => p.name).join(", ");
      throw new Error(`There's no profile called ${options.requested}. The profiles are: ${names}.`);
    }
    if (options.startedBy === "you") {
      return { profile: !requested || requested.id === fallback.id ? fallback : requested };
    }
    if (requested && requested.id !== fallback.id && this.policy() !== "me") {
      return { profile: requested, note: options.reason?.trim() || `ARIA picked ${requested.name}.` };
    }
    const matched = options.lastUserMessage ? this.match(options.lastUserMessage) : undefined;
    if (requested && requested.id !== fallback.id) {
      if (matched?.id === requested.id) {
        return { profile: requested, note: `You asked for ${requested.name}.` };
      }
      if (matched && matched.id !== fallback.id) {
        return { profile: matched, note: `You asked for ${matched.name}.` };
      }
      return { profile: fallback, note: `${fallback.name}: you didn't name a profile, so ARIA didn't use ${requested.name}.` };
    }
    if (matched && matched.id !== fallback.id) {
      return { profile: matched, note: `You asked for ${matched.name}.` };
    }
    return { profile: fallback };
  }
}
