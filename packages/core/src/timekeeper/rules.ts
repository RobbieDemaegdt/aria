/**
 * Phase 5B: Mapping rules (`time_rules`) and tracker task resolution (PLAN.md §4.14, §8, §10 Phase 5B).
 *
 * Resolution order (`resolveActivityTask`):
 * 1. Explicit link on the activity (`linkedTrackerTaskId`, or extracted from its branch / title / metadata unless
 *    `manualLink` is set with no ID, meaning you deliberately cleared the link).
 * 2. Your enabled `time_rules`, ordered by specificity:
 *    - `branch` > `repo` for code/git/GitHub/ARIA activities;
 *    - `meeting_title` > `meeting_organizer` for calendar activities;
 *    - `teams_channel` for Teams activities;
 *    - within the same kind: `exact` > `prefix` > `contains`, then longer pattern > shorter, then newest `updatedAt`.
 */
import type { Activity, TimeRule, TimeRuleKind, TimeRuleMatch, TimeRuleMatchMode } from "@aria/protocol";
import { untrusted } from "../integrations/rules.ts";
import { isNoTracker } from "../trackers/none.ts";
import { ownedBy } from "../trackers/owner.ts";
import type { TaskTracker } from "../trackers/types.ts";

export const MAX_TIME_RULES = 500;
const MAX_PATTERN_LEN = 200;
const MAX_TITLE_LEN = 200;

const KIND_WEIGHT: Record<TimeRuleKind, number> = {
  branch: 30,
  meeting_title: 20,
  teams_channel: 20,
  mail_subject: 20,
  meeting_organizer: 10,
  mail_recipient: 10,
  repo: 10,
};

const MODE_WEIGHT: Record<TimeRuleMatchMode, number> = {
  exact: 3,
  prefix: 2,
  contains: 1,
};

export function defaultMatchMode(kind: TimeRuleKind): TimeRuleMatchMode {
  switch (kind) {
    case "repo":
      return "exact";
    case "branch":
    case "meeting_title":
    case "meeting_organizer":
    case "teams_channel":
    case "mail_subject":
    case "mail_recipient":
      return "contains";
  }
}

export interface ValidatedTimeRuleInput {
  match: TimeRuleMatch;
  trackerTaskId: string;
  trackerTaskTitle?: string;
  defaultMinutes?: number;
  createdFrom: "you" | "correction";
  enabled: boolean;
}

/** Validates and normalizes a `TimeRule` input before saving to SQLite. */
export function validateTimeRuleInput(tracker: TaskTracker, input: {
  kind: TimeRuleKind;
  repoId?: number;
  pattern: string;
  matchMode?: TimeRuleMatchMode;
  trackerTaskId?: string;
  trackerTaskTitle?: string;
  defaultMinutes?: number | null;
  createdFrom?: "you" | "correction";
  enabled?: boolean;
}): ValidatedTimeRuleInput {
  let defaultMinutes: number | undefined;
  if (input.defaultMinutes !== undefined && input.defaultMinutes !== null) {
    if (!Number.isInteger(input.defaultMinutes) || input.defaultMinutes < 15 || input.defaultMinutes > 480) {
      throw new Error("Default duration must be between 15 and 480 minutes.");
    }
    defaultMinutes = input.defaultMinutes;
  }
  const rawTaskId = input.trackerTaskId?.trim() ?? "";
  let trackerTaskId = "";
  if (rawTaskId) {
    const parsed = tracker.parseTaskRef(rawTaskId);
    if (!parsed) {
      throw new Error(tracker.messages.invalidRuleTaskRef(input.trackerTaskId ?? ""));
    }
    trackerTaskId = parsed;
  } else if (defaultMinutes === undefined) {
    throw new Error(tracker.messages.invalidRuleTaskRef(input.trackerTaskId ?? ""));
  }
  const pattern = untrusted(input.pattern, MAX_PATTERN_LEN).trim();
  if (!pattern) {
    throw new Error("Give a non-empty pattern for the mapping rule.");
  }
  if (input.kind === "repo" && input.repoId !== undefined && (!Number.isInteger(input.repoId) || input.repoId <= 0)) {
    throw new Error("Invalid project id for repo mapping rule.");
  }
  const matchMode = input.matchMode ?? defaultMatchMode(input.kind);
  const trackerTaskTitle = input.trackerTaskTitle ? untrusted(input.trackerTaskTitle, MAX_TITLE_LEN).trim() : undefined;
  return {
    match: {
      kind: input.kind,
      ...(input.kind === "repo" && input.repoId !== undefined ? { repoId: input.repoId } : {}),
      pattern,
      matchMode,
      ...(defaultMinutes !== undefined ? { defaultMinutes } : {}),
    },
    trackerTaskId,
    ...(trackerTaskTitle ? { trackerTaskTitle } : {}),
    ...(defaultMinutes !== undefined ? { defaultMinutes } : {}),
    createdFrom: input.createdFrom ?? "you",
    enabled: input.enabled ?? true,
  };
}

function matchesPattern(value: string | undefined, pattern: string, mode: TimeRuleMatchMode): boolean {
  if (!value) return false;
  const hay = value.trim().toLowerCase();
  const needle = pattern.trim().toLowerCase();
  if (!hay || !needle) return false;
  switch (mode) {
    case "exact":
      return hay === needle;
    case "prefix":
      return hay.startsWith(needle);
    case "contains":
      return hay.includes(needle);
  }
}

/** Tests whether a single `TimeRule` matches an `Activity`. */
export function ruleMatchesActivity(rule: TimeRule, activity: Pick<Activity, "source" | "kind" | "repoId" | "title" | "metadata">): boolean {
  if (!rule.enabled) return false;
  const { kind, repoId, pattern, matchMode } = rule.match;
  const mode = matchMode ?? defaultMatchMode(kind);
  if (!pattern.trim()) return false;
  const meta = activity.metadata ?? {};

  switch (kind) {
    case "repo": {
      if (activity.source !== "git" && activity.source !== "github" && activity.source !== "aria") return false;
      if (repoId !== undefined && activity.repoId !== undefined) {
        return activity.repoId === repoId;
      }
      const repoName = typeof meta.repoName === "string" ? meta.repoName : undefined;
      const repoSlug = typeof meta.repo === "string" ? meta.repo : undefined;
      return matchesPattern(repoName, pattern, mode) || matchesPattern(repoSlug, pattern, mode);
    }
    case "branch": {
      if (activity.source !== "git" && activity.source !== "github" && activity.source !== "aria") return false;
      const branch = typeof meta.branch === "string" ? meta.branch : undefined;
      const cleanBranch = branch?.replace(/^refs\/heads\//i, "").replace(/^origin\//i, "");
      return matchesPattern(branch, pattern, mode) || matchesPattern(cleanBranch, pattern, mode);
    }
    case "meeting_title": {
      if (activity.source !== "calendar") return false;
      return matchesPattern(activity.title, pattern, mode);
    }
    case "meeting_organizer": {
      if (activity.source !== "calendar") return false;
      const organizer = typeof meta.organizer === "string" ? meta.organizer : undefined;
      const organizerEmail = typeof meta.organizerEmail === "string" ? meta.organizerEmail : undefined;
      return matchesPattern(organizer, pattern, mode) || matchesPattern(organizerEmail, pattern, mode);
    }
    case "teams_channel": {
      if (activity.source !== "teams") return false;
      const topic = typeof meta.topic === "string" ? meta.topic : undefined;
      const channel = typeof meta.channel === "string" ? meta.channel : undefined;
      return matchesPattern(activity.title, pattern, mode) || matchesPattern(topic, pattern, mode) || matchesPattern(channel, pattern, mode);
    }
    case "mail_subject": {
      if (activity.source !== "mail") return false;
      const subject = typeof meta.subject === "string" ? meta.subject : undefined;
      return matchesPattern(activity.title, pattern, mode) || matchesPattern(subject, pattern, mode);
    }
    case "mail_recipient": {
      if (activity.source !== "mail") return false;
      const recipient = typeof meta.recipient === "string" ? meta.recipient : undefined;
      const to = typeof meta.to === "string" ? meta.to : undefined;
      return matchesPattern(recipient, pattern, mode) || matchesPattern(to, pattern, mode);
    }
  }
}

function ruleWeight(rule: TimeRule): number {
  const mode = rule.match.matchMode ?? defaultMatchMode(rule.match.kind);
  return KIND_WEIGHT[rule.match.kind] * 10_000 + MODE_WEIGHT[mode] * 1_000 + Math.min(999, rule.match.pattern.trim().length);
}

/** Returns all enabled rules matching `activity`, ordered most-specific first. */
export function matchTimeRules(activity: Pick<Activity, "source" | "kind" | "repoId" | "title" | "metadata">, rules: readonly TimeRule[]): TimeRule[] {
  return rules
    .filter((r) => ruleMatchesActivity(r, activity))
    .sort((a, b) => ruleWeight(b) - ruleWeight(a) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

/**
 * Resolves the tracker task ID for an activity using §4.14's priority order:
 * 1. Explicit link on the activity (`linkedTrackerTaskId`), or extracted from its branch / title / metadata (unless
 *    `manualLink === true` with `linkedTrackerTaskId === undefined`, which means the user explicitly unlinked it).
 * 2. Most specific matching enabled `TimeRule`.
 */
export function resolveActivityTask(
  tracker: TaskTracker,
  activity: Pick<Activity, "source" | "kind" | "repoId" | "title" | "linkedTrackerTaskId" | "linkedTrackerId" | "manualLink" | "metadata">,
  rules: readonly TimeRule[],
): { trackerTaskId: string; mappedBy: "link" | "rule"; ruleId?: string } | undefined {
  // With no tracker a task can't be resolved: what an activity or a rule names is another tracker's, or nobody's.
  if (isNoTracker(tracker)) return undefined;
  // A link to another tracker's task is dormant: kept on the activity, not followed.
  if (activity.linkedTrackerTaskId && ownedBy(tracker, activity.linkedTrackerId)) {
    return { trackerTaskId: activity.linkedTrackerTaskId, mappedBy: "link" };
  }
  if (!activity.manualLink) {
    const meta = activity.metadata ?? {};
    const branch = typeof meta.branch === "string" ? meta.branch : undefined;
    const message = typeof meta.message === "string" ? meta.message : undefined;
    const body = typeof meta.body === "string" ? meta.body : undefined;
    const extracted = tracker.taskRefFromBranch(branch) ?? tracker.extractTaskRef(activity.title, message, body);
    if (extracted) {
      return { trackerTaskId: extracted, mappedBy: "link" };
    }
  }
  const best = matchTimeRules(activity, rules).find((r) => Boolean(r.trackerTaskId));
  if (best) {
    return { trackerTaskId: best.trackerTaskId, mappedBy: "rule", ruleId: best.id };
  }
  return undefined;
}

/**
 * Resolves the configured default duration in minutes from the most specific matching enabled `TimeRule`
 * that defines `defaultMinutes` (e.g. for an email matching a `mail_subject` or `mail_recipient` rule).
 */
export function resolveActivityDuration(
  activity: Pick<Activity, "source" | "kind" | "repoId" | "title" | "metadata">,
  rules: readonly TimeRule[],
): number | undefined {
  const best = matchTimeRules(activity, rules).find((r) => {
    const mins = r.defaultMinutes ?? r.match.defaultMinutes;
    return typeof mins === "number" && Number.isFinite(mins) && mins >= 15;
  });
  return best ? (best.defaultMinutes ?? best.match.defaultMinutes) : undefined;
}
