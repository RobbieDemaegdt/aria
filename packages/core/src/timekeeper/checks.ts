/**
 * Phase 5C: Plain-code timesheet checks, time-zone & DST math, boundary-aware rounding, overlap & duplicate detection,
 * gap calculation, and deterministic activity clustering (PLAN.md §0.3 D7, D12; §4.14; §10 Phase 5C).
 */
import { randomUUID } from "node:crypto";
import type {
  Activity,
  TrackerTaskCacheEntry,
  TimeRule,
  TimesheetConfidence,
  TimesheetEntry,
  TimesheetGap,
  TimesheetMappedBy,
  TimesheetOverlapDetail,
  TimesheetRegisteredEntry,
  TimesheetRounding,
  TimesheetSourceRef,
} from "@aria/protocol";
import { cleanTitle } from "../tasks/pr.ts";
import { isNoTracker } from "../trackers/none.ts";
import { ownedBy } from "../trackers/owner.ts";
import type { TaskTracker } from "../trackers/types.ts";
import { resolveActivityDuration, resolveActivityTask } from "./rules.ts";

/** Common Windows time zone names returned by Microsoft Graph / Outlook mapped to IANA time zone identifiers. */
const WINDOWS_TO_IANA: Record<string, string> = {
  utc: "UTC",
  "etc/utc": "UTC",
  "gmt standard time": "Europe/London",
  "greenwich standard time": "Atlantic/Reykjavik",
  "w. europe standard time": "Europe/Berlin",
  "romance standard time": "Europe/Brussels",
  "central europe standard time": "Europe/Budapest",
  "central european standard time": "Europe/Warsaw",
  "gtb standard time": "Europe/Bucharest",
  "fle standard time": "Europe/Helsinki",
  "turkey standard time": "Europe/Istanbul",
  "israel standard time": "Asia/Jerusalem",
  "south africa standard time": "Africa/Johannesburg",
  "india standard time": "Asia/Kolkata",
  "china standard time": "Asia/Shanghai",
  "singapore standard time": "Asia/Singapore",
  "tokyo standard time": "Asia/Tokyo",
  "korea standard time": "Asia/Seoul",
  "aus eastern standard time": "Australia/Sydney",
  "new zealand standard time": "Pacific/Auckland",
  "eastern standard time": "America/New_York",
  "us eastern standard time": "America/Indianapolis",
  "central standard time": "America/Chicago",
  "mountain standard time": "America/Denver",
  "us mountain standard time": "America/Phoenix",
  "pacific standard time": "America/Los_Angeles",
  "alaskan standard time": "America/Anchorage",
  "hawaiian standard time": "Pacific/Honolulu",
  "atlantic standard time": "America/Halifax",
  "e. south america standard time": "America/Sao_Paulo",
};

const VALIDATED_ZONES = new Map<string, string>();

/** Resolves a Windows or IANA time zone string to a valid IANA time zone supported by `Intl.DateTimeFormat`. */
export function normalizeTimeZone(raw?: string | null): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (!raw || !raw.trim()) return fallback;
  const trimmed = raw.trim();
  const cached = VALIDATED_ZONES.get(trimmed);
  if (cached) return cached;

  const mapped = WINDOWS_TO_IANA[trimmed.toLowerCase()] ?? trimmed;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: mapped });
    VALIDATED_ZONES.set(trimmed, mapped);
    return mapped;
  } catch {
    return fallback;
  }
}

function getZoneParts(epochMs: number, ianaZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ianaZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** Exact UTC offset (in ms) of `ianaZone` at `epochMs` (positive east of UTC, e.g. +7_200_000 for CEST). */
export function zoneOffsetMs(epochMs: number, ianaZone: string): number {
  const p = getZoneParts(epochMs, ianaZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncatedEpoch = Math.floor(epochMs / 1000) * 1000;
  return asUtc - truncatedEpoch;
}

/**
 * Parses a wall-clock date/time string (`"2026-10-23T09:00:00.0000000"`, `"2026-10-23T09:00:00Z"`, or
 * `"2026-10-23T09:00:00+02:00"`) with an optional Graph `timeZone` (`"Romance Standard Time"`, `"UTC"`,
 * `"Europe/Brussels"`) into exact UTC epoch milliseconds, independent of the host OS time zone.
 */
export function parseDateTimeInZone(dateTimeStr: string, timeZone?: string | null): number | undefined {
  const trimmed = dateTimeStr.trim();
  if (!trimmed) return undefined;
  // Normalize >3 fractional second digits from Graph (`.0000000` -> `.000`)
  const normalizedIso = trimmed.replace(/\.(\d{3})\d+/, ".$1");

  // If the string already carries an explicit Z or ±HH:MM offset, Date.parse is exact.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalizedIso)) {
    const ms = Date.parse(normalizedIso);
    return Number.isFinite(ms) ? ms : undefined;
  }

  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(normalizedIso);
  if (!m) {
    const fallback = Date.parse(normalizedIso);
    return Number.isFinite(fallback) ? fallback : undefined;
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6] ?? 0);
  const msPart = Number((m[7] ?? "0").padEnd(3, "0"));

  const zone = normalizeTimeZone(timeZone);
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second, msPart);
  const offset1 = zoneOffsetMs(utcGuess, zone);
  const candidate = utcGuess - offset1;
  const offset2 = zoneOffsetMs(candidate, zone);
  return utcGuess - offset2;
}

/** Start and end UTC epoch ms of an ISO local date (`YYYY-MM-DD`) in `timeZone`. */
export function dayBoundsInZone(date: string, timeZone?: string | null): { startMs: number; endMs: number } {
  const zone = normalizeTimeZone(timeZone);
  const startMs = parseDateTimeInZone(`${date}T00:00:00.000`, zone)!;
  const endMs = parseDateTimeInZone(`${date}T23:59:59.999`, zone)!;
  return { startMs, endMs };
}

/** Converts UTC epoch ms to `{ date: "YYYY-MM-DD", minutes: 0..1439, hhmm: "HH:mm" }` in `timeZone`. */
export function epochToLocalWallTime(epochMs: number, timeZone?: string | null): { date: string; minutes: number; hhmm: string } {
  const zone = normalizeTimeZone(timeZone);
  const p = getZoneParts(epochMs, zone);
  const date = `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const minutes = p.hour * 60 + p.minute + (p.second >= 30 ? 1 : 0);
  const clamped = Math.min(1440, Math.max(0, minutes));
  return { date, minutes: clamped, hhmm: minutesToHHMM(clamped) };
}

/** Clamps an epoch interval `[startMs, endMs]` onto `[0..1440]` minutes of `targetDate` in `timeZone`, preserving elapsed minutes across DST offset changes. */
export function intervalMinutesOnDate(
  startMs: number,
  endMs: number,
  targetDate: string,
  timeZone?: string | null,
): { startMinutes: number; endMinutes: number; dstCrossed?: boolean } | undefined {
  const zone = normalizeTimeZone(timeZone);
  const { startMs: dayStart, endMs: dayEnd } = dayBoundsInZone(targetDate, zone);
  if (endMs < dayStart || startMs > dayEnd) return undefined;
  const clampedStartMs = Math.max(dayStart, startMs);
  const clampedEndMs = Math.min(dayEnd, endMs);
  const s = startMs <= dayStart ? 0 : epochToLocalWallTime(clampedStartMs, zone).minutes;
  const wallEnd = endMs >= dayEnd ? 1440 : Math.max(s, epochToLocalWallTime(clampedEndMs, zone).minutes);
  const offsetStart = zoneOffsetMs(clampedStartMs, zone);
  const offsetEnd = zoneOffsetMs(clampedEndMs, zone);
  if (offsetStart !== offsetEnd) {
    const elapsedMin = Math.max(0, Math.round((clampedEndMs - clampedStartMs) / 60_000));
    return {
      startMinutes: s,
      endMinutes: Math.min(1440, s + elapsedMin),
      dstCrossed: true,
    };
  }
  return { startMinutes: s, endMinutes: wallEnd };
}

/**
 * Whether a text mentions a tracker task's ID as a whole word. The ID is matched as written, whatever characters it has
 * (`ACME-123`, `A.B`), and in any case: for an ID of digits this is what `\bID\b` on lower-cased text always gave.
 */
export function mentionsTaskId(text: string, taskId: string): boolean {
  return new RegExp(`\\b${taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
}

export function hhmmToMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`Invalid HH:mm time: "${hhmm}".`);
  const hours = Number(m[1]);
  const mins = Number(m[2]);
  if (hours === 24 && mins === 0) return 1440;
  if (hours < 0 || hours > 23 || mins < 0 || mins > 59) throw new Error(`Invalid HH:mm time: "${hhmm}".`);
  return hours * 60 + mins;
}

export function minutesToHHMM(minutes: number): string {
  const clamped = Math.min(1440, Math.max(0, Math.round(minutes)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function formatDateLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
  return dt.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/** Adds `deltaDays` to an ISO `YYYY-MM-DD` date string in pure calendar math (DST-safe). */
export function addDaysIso(date: string, deltaDays: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + deltaDays, 12, 0, 0));
  return dt.toISOString().slice(0, 10);
}

/** ISO-8601 day of week (`1` = Monday .. `7` = Sunday). */
export function isoDayOfWeek(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return 1;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
  const day = dt.getUTCDay();
  return day === 0 ? 7 : day;
}

/** Returns the Monday (`weekStart`) and the 7 Monday–Sunday ISO dates (`YYYY-MM-DD`) of the ISO week containing `date`. */
export function isoWeekDates(date: string): { weekStart: string; dates: string[] } {
  const dow = isoDayOfWeek(date);
  const weekStart = addDaysIso(date, -(dow - 1));
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    dates.push(addDaysIso(weekStart, i));
  }
  return { weekStart, dates };
}

export function roundMinutes(minutes: number, step: TimesheetRounding): number {
  const snapped = Math.round(minutes / step) * step;
  return Math.min(1440, Math.max(0, snapped));
}

export function roundInterval(
  startMinutes: number,
  endMinutes: number,
  step: TimesheetRounding,
): { startMinutes: number; endMinutes: number } {
  let s = roundMinutes(startMinutes, step);
  let e = roundMinutes(endMinutes, step);
  if (e <= s) {
    if (s + step <= 1440) e = s + step;
    else s = Math.max(0, e - step);
  }
  return { startMinutes: s, endMinutes: e };
}

/**
 * Finds a non-overlapping slot of length `durationMinutes` snapped to `step` (default 15m), avoiding `occupied`
 * intervals. Tries `preferredStartMinutes` first, then `workStartMinutes`, then `0`.
 */
export function findNextAvailableSlot(
  durationMinutes: number,
  occupied: ReadonlyArray<{ start: number; end: number }>,
  preferredStartMinutes = 540,
  workStartMinutes = 540,
  step: TimesheetRounding = 15,
): { startMinutes: number; endMinutes: number } | undefined {
  const dur = Math.max(step, Math.min(1440, roundMinutes(durationMinutes, step)));
  const sorted = [...occupied]
    .filter((o) => o.end > o.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const tryFrom = (fromMin: number): { startMinutes: number; endMinutes: number } | undefined => {
    let cursor = roundMinutes(Math.max(0, fromMin), step);
    while (cursor + dur <= 1440) {
      const blocker = sorted.find((o) => cursor < o.end && o.start < cursor + dur);
      if (!blocker) {
        return { startMinutes: cursor, endMinutes: cursor + dur };
      }
      cursor = Math.max(cursor + step, roundMinutes(blocker.end, step));
    }
    return undefined;
  };

  return tryFrom(preferredStartMinutes) ?? tryFrom(workStartMinutes) ?? tryFrom(0);
}

/**
 * Filters Microsoft Graph / Work IQ calendar events so cancelled meetings, declined invites, all-day banners, and
 * free/tentative/out-of-office holds are excluded before placing fixed meeting blocks (Duck round finding 1).
 */
export function isEligibleCalendarEvent(event: {
  isCancelled?: boolean;
  isAllDay?: boolean;
  showAs?: string;
  responseStatus?: { response?: string } | string;
}): boolean {
  if (event.isCancelled === true || event.isAllDay === true) return false;
  const resp =
    typeof event.responseStatus === "string"
      ? event.responseStatus.toLowerCase()
      : event.responseStatus?.response?.toLowerCase();
  if (resp === "declined") return false;
  const showAs = event.showAs?.trim().toLowerCase();
  if (showAs === "free" || showAs === "tentative" || showAs === "workingelsewhere" || showAs === "oof") return false;
  return true;
}

export interface DraftRowInput {
  id?: string;
  start: string;
  end: string;
  trackerTaskId?: string;
  /** The tracker `trackerTaskId` is of: a row of another tracker's keeps its task as it is until the user picks one. Unstamped: the tracker in use's. */
  trackerId?: string;
  trackerTaskTitle?: string;
  trackerProjectId?: string;
  trackerCustomerId?: string;
  comment: string;
  sources?: TimesheetSourceRef[];
  mappedBy?: TimesheetMappedBy;
  /** True when the row came from the Timekeeper model's `propose_timesheet` call rather than deterministic code or user edits. */
  fromModel?: boolean;
  confidence?: TimesheetConfidence;
  state?: TimesheetEntry["state"];
  trackerEntryId?: string;
  error?: string;
  createdAt?: number;
}

/** Where two ranges of minutes that overlap do so. */
function overlapBetween(a: { start: number; end: number }, b: { start: number; end: number }) {
  const startMin = Math.max(a.start, b.start);
  const endMin = Math.min(a.end, b.end);
  return { overlapStart: minutesToHHMM(startMin), overlapEnd: minutesToHHMM(endMin), overlapMinutes: Math.max(0, endMin - startMin) };
}

function overlapDetail(
  target: { id: string; start: string; end: string; comment?: string | undefined; trackerTaskId?: string | undefined },
  targetType: TimesheetOverlapDetail["targetType"],
  overlap: ReturnType<typeof overlapBetween>,
): TimesheetOverlapDetail {
  return {
    targetId: target.id,
    targetType,
    targetStart: target.start,
    targetEnd: target.end,
    targetLabel: target.comment || (target.trackerTaskId ? `#${target.trackerTaskId}` : undefined),
    ...overlap,
  };
}

/**
 * Boundary-aware rounding and plain-code validation of a day's timesheet entries (§4.14, Duck round findings 2, 5, 6, 11).
 *
 * - Enforces explicit link → `TimeRule` priority over model suggestions unless `mappedBy === "you"`.
 * - Resolves `trackerProjectId`, `trackerCustomerId`, and `trackerTaskTitle` from `taskCache` (never trusting a model's
 *   guessed project or customer ID over the task cache).
 * - Snaps contiguous boundaries within 2 minutes to the same rounded boundary so rounding never creates artificial
 *   overlaps or phantom gaps.
 * - Flags overlaps between draft entries, duplicates/overlaps against `registered` tracker entries, and uncertain rows.
 * - Computes working-hour `gaps` and totals (`draftMinutes`, `registeredMinutes`, `dayTotalMinutes`).
 */
export function checkTimesheetEntries(input: {
  tracker: TaskTracker;
  date: string;
  rawEntries: readonly DraftRowInput[];
  registered: readonly TimesheetRegisteredEntry[];
  rules: readonly TimeRule[];
  taskCache: ReadonlyMap<string, TrackerTaskCacheEntry>;
  activities?: readonly Activity[];
  roundingMinutes: TimesheetRounding;
  expectedMinutes: number;
  workStart: string;
  workEnd: string;
  applyRounding?: boolean;
}): {
  entries: TimesheetEntry[];
  registered: TimesheetRegisteredEntry[];
  draftMinutes: number;
  registeredMinutes: number;
  dayTotalMinutes: number;
  uncertainCount: number;
  overlapCount: number;
  duplicateCount: number;
  gaps: TimesheetGap[];
} {
  const { tracker, date, rawEntries, registered, rules, taskCache, roundingMinutes, workStart, workEnd } = input;
  const noTracker = isNoTracker(tracker);
  const activities = input.activities ?? [];
  const hasActivityStore = input.activities !== undefined;
  const applyRounding = input.applyRounding ?? true;
  const now = Date.now();
  const byExternalId = new Map(activities.map((a) => [a.externalId, a]));

  // 1. Parse raw start/end minutes, reject reversed/zero-length intervals, apply any rule duration override, and sort chronologically
  const parsed = rawEntries
    .flatMap((row) => {
      const rawStart = hhmmToMinutes(row.start);
      let rawEnd = hhmmToMinutes(row.end);
      if (rawEnd <= rawStart) return [];
      if (row.mappedBy !== "you" && row.state !== "submitted" && row.sources?.length) {
        let maxRuleMin = 0;
        for (const src of row.sources) {
          const storedAct =
            (src.externalId ? byExternalId.get(src.externalId) : undefined) ??
            activities.find(
              (a) =>
                a.source === src.source &&
                ((src.branch !== undefined && a.metadata.branch === src.branch) ||
                  (src.title !== undefined && a.title === src.title) ||
                  (src.repoName !== undefined && a.metadata.repoName === src.repoName)),
            );
          const ruleMin = storedAct
            ? (storedAct.resolvedMinutes ?? resolveActivityDuration(storedAct, rules))
            : resolveActivityDuration(
                {
                  source: src.source,
                  kind: src.kind ?? "task",
                  ...(src.repoId !== undefined ? { repoId: src.repoId } : {}),
                  title: src.title ?? row.comment,
                  metadata: {
                    ...(src.repoName ? { repoName: src.repoName } : {}),
                    ...(src.branch ? { branch: src.branch } : {}),
                    ...(src.organizer ? { organizer: src.organizer } : {}),
                    ...(src.topic ? { topic: src.topic } : {}),
                    ...(src.recipient ? { recipient: src.recipient, to: src.recipient } : {}),
                    ...(src.title ? { subject: src.title } : {}),
                  },
                },
                rules,
              );
          if (ruleMin && ruleMin > maxRuleMin) maxRuleMin = ruleMin;
        }
        if (maxRuleMin > 0 && rawEnd - rawStart < maxRuleMin) {
          rawEnd = Math.min(1440, rawStart + maxRuleMin);
        }
      }
      return [{ row, rawStart, rawEnd }];
    })
    .sort((a, b) => a.rawStart - b.rawStart || a.rawEnd - b.rawEnd);

  // 2. Boundary-aware rounding (unless applyRounding === false or row is already submitted/edited by user)
  const roundedBounds = parsed.map((item) => {
    if (!applyRounding || item.row.state === "submitted" || item.row.mappedBy === "you") {
      const e = item.rawEnd <= item.rawStart ? Math.min(1440, item.rawStart + roundingMinutes) : item.rawEnd;
      return { startMinutes: item.rawStart, endMinutes: e };
    }
    return roundInterval(item.rawStart, item.rawEnd, roundingMinutes);
  });

  for (let i = 0; i + 1 < parsed.length; i++) {
    const curRaw = parsed[i]!;
    const nextRaw = parsed[i + 1]!;
    const curBound = roundedBounds[i]!;
    const nextBound = roundedBounds[i + 1]!;
    if (
      applyRounding &&
      curRaw.row.mappedBy !== "you" &&
      nextRaw.row.mappedBy !== "you" &&
      Math.abs(curRaw.rawEnd - nextRaw.rawStart) <= 2
    ) {
      const shared = roundMinutes(curRaw.rawEnd, roundingMinutes);
      if (shared > curBound.startMinutes && shared < nextBound.endMinutes) {
        curBound.endMinutes = shared;
        nextBound.startMinutes = shared;
      }
    }
  }

  // 3. Resolve task, project, customer, mappedBy, and confidence for each row
  const entries: TimesheetEntry[] = parsed.map((item, idx) => {
    const { row } = item;
    const { startMinutes, endMinutes } = roundedBounds[idx]!;
    const start = minutesToHHMM(startMinutes);
    const end = minutesToHHMM(endMinutes);
    const minutes = Math.max(0, endMinutes - startMinutes);
    const sources = row.sources ?? [];

    // A task of another tracker isn't this tracker's to look up: it stays as stored, with no cache lookup, until a
    // link or a rule of this tracker maps the row or the user picks a task. With no tracker a row is a time and a
    // comment: no task is resolved or asked for, and one a row already has stays as it is.
    let foreign = !noTracker && Boolean(row.trackerTaskId) && !ownedBy(tracker, row.trackerId);
    let trackerTaskId = noTracker || foreign ? row.trackerTaskId : row.trackerTaskId ? tracker.parseTaskRef(row.trackerTaskId) : undefined;
    // Model-proposed rows cannot self-certify mappedBy: "link" or "rule"; they start as "suggestion" until verified below.
    let mappedBy: TimesheetMappedBy = row.mappedBy === "you" ? "you" : row.fromModel ? "suggestion" : (row.mappedBy ?? "suggestion");
    const isUnverifiedSuggestion = row.fromModel === true || mappedBy === "suggestion";

    // Deterministic link / rule verification for non-user-edited rows
    if (mappedBy !== "you" && !noTracker) {
      let deterministic: { trackerTaskId: string; mappedBy: "link" | "rule" } | undefined;
      for (const src of sources) {
        const storedAct =
          (src.externalId ? byExternalId.get(src.externalId) : undefined) ??
          activities.find(
            (a) =>
              a.source === src.source &&
              ((src.branch !== undefined && a.metadata.branch === src.branch) ||
                (src.title !== undefined && a.title === src.title) ||
                (src.repoName !== undefined && a.metadata.repoName === src.repoName)),
          );
        if (storedAct) {
          const resolvedStored = resolveActivityTask(tracker, storedAct, rules);
          if (resolvedStored) {
            deterministic = { trackerTaskId: resolvedStored.trackerTaskId, mappedBy: resolvedStored.mappedBy };
            if (resolvedStored.mappedBy === "link") break;
          }
          continue;
        }
        // When `hasActivityStore` is true and the row is a model suggestion (`isUnverifiedSuggestion`), a source that
        // doesn't match any stored activity cannot self-promote to `link` or `rule`.
        if (hasActivityStore && isUnverifiedSuggestion) {
          continue;
        }
        const resolved = resolveActivityTask(
          tracker,
          {
            source: src.source,
            kind: src.kind ?? "task",
            ...(src.repoId !== undefined ? { repoId: src.repoId } : {}),
            title: src.title ?? row.comment,
            metadata: {
              ...(src.repoName ? { repoName: src.repoName } : {}),
              ...(src.branch ? { branch: src.branch } : {}),
              ...(src.organizer ? { organizer: src.organizer } : {}),
              ...(src.topic ? { topic: src.topic } : {}),
              ...(src.recipient ? { recipient: src.recipient, to: src.recipient } : {}),
              ...(src.title ? { subject: src.title } : {}),
            },
          },
          rules,
        );
        if (resolved) {
          deterministic = { trackerTaskId: resolved.trackerTaskId, mappedBy: resolved.mappedBy };
          if (resolved.mappedBy === "link") break;
        }
      }
      if (!deterministic && !isUnverifiedSuggestion) {
        const fromComment = tracker.extractTaskRef(row.comment);
        if (fromComment) deterministic = { trackerTaskId: fromComment, mappedBy: "link" };
      }
      if (deterministic) {
        trackerTaskId = deterministic.trackerTaskId;
        mappedBy = deterministic.mappedBy;
        foreign = false;
      }
    }

    const cachedTask = trackerTaskId && !foreign ? taskCache.get(trackerTaskId) : undefined;
    const explicitUserTitle = mappedBy === "you" && row.trackerTaskTitle ? cleanTitle(row.trackerTaskTitle, 200) : undefined;
    const trackerTaskTitle =
      explicitUserTitle ?? cachedTask?.title ?? (row.trackerTaskTitle ? cleanTitle(row.trackerTaskTitle, 200) : undefined);
    // Project and customer always come from the task cache unless explicitly entered by the user (`mappedBy === "you"`):
    // a model-guessed project or customer ID is never trusted (§4.14). A task of another tracker keeps the ones it has.
    const trackerProjectId = (mappedBy === "you" || foreign ? row.trackerProjectId?.trim() || undefined : undefined) ?? cachedTask?.projectId;
    const trackerCustomerId = (mappedBy === "you" || foreign ? row.trackerCustomerId?.trim() || undefined : undefined) ?? cachedTask?.customerId;

    let confidence: TimesheetConfidence = "certain";
    let uncertaintyReason: string | undefined;
    if (noTracker) {
      // Nothing to confirm: there is no task to be unsure of.
    } else if (!trackerTaskId) {
      confidence = "uncertain";
      uncertaintyReason = `No ${tracker.label} task selected`;
    } else if (foreign) {
      confidence = "uncertain";
      uncertaintyReason = `Task from another tracker — pick a ${tracker.label} task`;
    } else if (mappedBy === "suggestion" && row.confidence !== "certain") {
      confidence = "uncertain";
      uncertaintyReason = "Suggested by Timekeeper — confirm or change the task";
    }

    const comment = cleanTitle(row.comment || trackerTaskTitle || "Work", 300) || "Work";
    const rowTracker = noTracker || foreign ? row.trackerId : tracker.id;
    return {
      id: row.id ?? `ts-${randomUUID()}`,
      date,
      start,
      end,
      minutes,
      ...(trackerTaskId ? { trackerTaskId } : {}),
      // A row that has a task or a registered entry belongs to a tracker: this one's, unless it keeps another's task.
      ...((trackerTaskId || row.trackerEntryId) && rowTracker ? { trackerId: rowTracker } : {}),
      ...(trackerTaskTitle ? { trackerTaskTitle } : {}),
      ...(trackerProjectId ? { trackerProjectId } : {}),
      ...(trackerCustomerId ? { trackerCustomerId } : {}),
      comment,
      sources,
      mappedBy,
      confidence,
      ...(uncertaintyReason ? { uncertaintyReason } : {}),
      state: row.state ?? "draft",
      ...(row.trackerEntryId ? { trackerEntryId: row.trackerEntryId } : {}),
      ...(row.error ? { error: row.error } : {}),
      createdAt: row.createdAt ?? now,
      updatedAt: now,
    };
  });

  // 4. Detect overlaps between entries on this day
  const bounds = entries.map((e) => ({ start: hhmmToMinutes(e.start), end: hhmmToMinutes(e.end) }));
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (bounds[i]!.start < bounds[j]!.end && bounds[j]!.start < bounds[i]!.end) {
        entries[i]!.overlap = true;
        entries[j]!.overlap = true;

        const overlap = overlapBetween(bounds[i]!, bounds[j]!);
        (entries[i]!.overlapDetails ??= []).push(overlapDetail(entries[j]!, "draft", overlap));
        (entries[j]!.overlapDetails ??= []).push(overlapDetail(entries[i]!, "draft", overlap));
      }
    }
  }

  // 5. Detect duplicates and overlaps against entries already registered in the tracker
  const regItems = registered.map((r) => ({
    ...r,
    startMin: hhmmToMinutes(r.start),
    endMin: hhmmToMinutes(r.end),
    overlap: false,
    overlapDetails: [] as TimesheetOverlapDetail[],
  }));

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.state === "submitted") continue;
    const b = bounds[i]!;
    for (const reg of regItems) {
      if (b.start < reg.endMin && reg.startMin < b.end) {
        // The same task is the same task of the same tracker: another tracker's registered entry only takes the time.
        const sameTracker = (entry.trackerId ?? tracker.id) === (reg.trackerId ?? tracker.id);
        if (sameTracker && entry.trackerTaskId === reg.trackerTaskId && b.start === reg.startMin && b.end === reg.endMin) {
          entry.duplicateTrackerId = reg.id;
        } else {
          entry.overlapsTrackerId ??= reg.id;
        }

        const overlap = overlapBetween(b, { start: reg.startMin, end: reg.endMin });
        (entry.overlapDetails ??= []).push(overlapDetail(reg, "tracker", overlap));

        reg.overlap = true;
        reg.overlapDetails.push(overlapDetail(entry, "draft", overlap));
      }
    }
  }

  // Also check if any registered entries overlap each other
  for (let i = 0; i < regItems.length; i++) {
    for (let j = i + 1; j < regItems.length; j++) {
      if (regItems[i]!.startMin < regItems[j]!.endMin && regItems[j]!.startMin < regItems[i]!.endMin) {
        regItems[i]!.overlap = true;
        regItems[j]!.overlap = true;

        const overlap = overlapBetween(
          { start: regItems[i]!.startMin, end: regItems[i]!.endMin },
          { start: regItems[j]!.startMin, end: regItems[j]!.endMin },
        );
        regItems[i]!.overlapDetails.push(overlapDetail(regItems[j]!, "tracker", overlap));
        regItems[j]!.overlapDetails.push(overlapDetail(regItems[i]!, "tracker", overlap));
      }
    }
  }

  const registeredResult: TimesheetRegisteredEntry[] = regItems.map(({ startMin, endMin, ...r }) => ({
    ...r,
    ...(r.overlap ? { overlap: true } : {}),
    ...(r.overlapDetails.length > 0 ? { overlapDetails: r.overlapDetails } : {}),
  }));

  // 6. Compute working-hour gaps and totals
  const workStartMin = hhmmToMinutes(workStart);
  const workEndMin = Math.max(workStartMin, hhmmToMinutes(workEnd));
  const coveredIntervals: Array<{ start: number; end: number }> = [
    ...bounds,
    ...regItems.map((r) => ({ start: r.startMin, end: r.endMin })),
  ].sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: Array<{ start: number; end: number }> = [];
  for (const iv of coveredIntervals) {
    if (iv.end <= iv.start) continue;
    const last = merged.at(-1);
    if (last && iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end);
    } else {
      merged.push({ ...iv });
    }
  }

  const gaps: TimesheetGap[] = [];
  if (input.expectedMinutes > 0) {
    let cursor = workStartMin;
    for (const iv of merged) {
      if (iv.end <= cursor) continue;
      if (iv.start > cursor) {
        const gapEnd = Math.min(workEndMin, iv.start);
        if (gapEnd - cursor >= roundingMinutes) {
          gaps.push({
            start: minutesToHHMM(cursor),
            end: minutesToHHMM(gapEnd),
            minutes: gapEnd - cursor,
          });
        }
      }
      cursor = Math.max(cursor, iv.end);
      if (cursor >= workEndMin) break;
    }
    if (cursor < workEndMin && workEndMin - cursor >= roundingMinutes) {
      gaps.push({
        start: minutesToHHMM(cursor),
        end: minutesToHHMM(workEndMin),
        minutes: workEndMin - cursor,
      });
    }
  }

  const draftMinutes = entries.filter((e) => e.state !== "submitted").reduce((sum, e) => sum + e.minutes, 0);
  const registeredMinutes = registered.reduce((sum, r) => sum + r.minutes, 0);
  const dayTotalMinutes = merged.reduce((sum, iv) => sum + (iv.end - iv.start), 0);
  const uncertainCount = entries.filter((e) => e.confidence === "uncertain").length;
  const overlapCount = entries.filter((e) => e.overlap || e.overlapsTrackerId).length;
  const duplicateCount = entries.filter((e) => e.duplicateTrackerId !== undefined).length;

  return {
    entries,
    registered: registeredResult,
    draftMinutes,
    registeredMinutes,
    dayTotalMinutes,
    uncertainCount,
    overlapCount,
    duplicateCount,
    gaps,
  };
}

/**
 * Builds a deterministic timesheet draft from fixed calendar meeting blocks, preserved user-edited rows, and clusters
 * of collected activities (ARIA tasks, local git commits, GitHub PRs/reviews, Teams chats) in the remaining gaps.
 */
export function buildDeterministicDraft(input: {
  tracker: TaskTracker;
  date: string;
  timeZone: string;
  preservedEntries: readonly TimesheetEntry[];
  registered: readonly TimesheetRegisteredEntry[];
  activities: readonly Activity[];
  rules: readonly TimeRule[];
  taskCache: ReadonlyMap<string, TrackerTaskCacheEntry>;
  roundingMinutes: TimesheetRounding;
  workStart: string;
  workEnd: string;
  defaultMailMinutes?: number;
}): DraftRowInput[] {
  const { tracker, date, timeZone, preservedEntries, registered, activities, rules, taskCache, roundingMinutes } = input;
  const rows: DraftRowInput[] = preservedEntries.map((e) => ({
    id: e.id,
    start: e.start,
    end: e.end,
    ...(e.trackerTaskId ? { trackerTaskId: e.trackerTaskId } : {}),
    ...(e.trackerTaskTitle ? { trackerTaskTitle: e.trackerTaskTitle } : {}),
    ...(e.trackerProjectId ? { trackerProjectId: e.trackerProjectId } : {}),
    ...(e.trackerCustomerId ? { trackerCustomerId: e.trackerCustomerId } : {}),
    comment: e.comment,
    sources: e.sources,
    mappedBy: e.mappedBy,
    confidence: e.confidence,
    state: e.state,
    ...(e.trackerEntryId ? { trackerEntryId: e.trackerEntryId } : {}),
    createdAt: e.createdAt,
  }));

  const occupied: Array<{ start: number; end: number }> = [
    ...preservedEntries.map((e) => ({ start: hhmmToMinutes(e.start), end: hhmmToMinutes(e.end) })),
    ...registered.map((r) => ({ start: hhmmToMinutes(r.start), end: hhmmToMinutes(r.end) })),
  ];

  const isFree = (s: number, e: number) => !occupied.some((o) => s < o.end && o.start < e);

  // 1. Place calendar meetings as fixed blocks
  const meetings = activities.filter((a) => a.source === "calendar");
  for (const m of meetings) {
    const iv = intervalMinutesOnDate(m.startedAt, m.endedAt, date, timeZone);
    if (!iv) continue;
    const rounded = roundInterval(iv.startMinutes, iv.endMinutes, roundingMinutes);
    if (!isFree(rounded.startMinutes, rounded.endMinutes)) continue;
    occupied.push({ start: rounded.startMinutes, end: rounded.endMinutes });
    const resolved = resolveActivityTask(tracker, m, rules);
    const cached = resolved ? taskCache.get(resolved.trackerTaskId) : undefined;
    rows.push({
      start: minutesToHHMM(rounded.startMinutes),
      end: minutesToHHMM(rounded.endMinutes),
      ...(resolved ? { trackerTaskId: resolved.trackerTaskId, mappedBy: resolved.mappedBy } : { mappedBy: "suggestion" }),
      ...(cached ? { trackerTaskTitle: cached.title, ...(cached.projectId ? { trackerProjectId: cached.projectId } : {}), ...(cached.customerId ? { trackerCustomerId: cached.customerId } : {}) } : {}),
      comment: m.title,
      sources: [
        {
          source: "calendar",
          kind: "meeting",
          externalId: m.externalId,
          title: m.title,
          ...(typeof m.metadata.organizer === "string" ? { organizer: m.metadata.organizer } : {}),
        },
      ],
    });
  }

  // 2. Consolidate non-meeting work activities (ARIA tasks, git commits, GitHub PRs, Teams chats, sent emails, tracker updates)
  // into one Task Bucket per task/repo with a rough duration rounded to `roundingMinutes` (±15m).
  const workStartMin = hhmmToMinutes(input.workStart);
  const workActivities = activities
    .filter((a) => a.source !== "calendar")
    .sort((a, b) => a.startedAt - b.startedAt);

  interface TaskBucket {
    key: string;
    earliestStartMin: number;
    intervals: Array<{ start: number; end: number }>;
    trackerTaskId?: string;
    mappedBy?: "link" | "rule";
    repoId?: number;
    repoName?: string;
    titles: string[];
    sources: TimesheetSourceRef[];
  }
  const bucketsByKey = new Map<string, TaskBucket>();

  for (const act of workActivities) {
    const iv = intervalMinutesOnDate(act.startedAt, act.endedAt, date, timeZone);
    if (!iv) continue;
    const resolved = resolveActivityTask(tracker, act, rules);
    const ruleMinutes = act.resolvedMinutes ?? resolveActivityDuration(act, rules);
    const pointDuration = Math.max(
      roundingMinutes,
      ruleMinutes ??
        (act.source === "mail"
          ? (input.defaultMailMinutes ?? 15)
          : act.source === "tracker" || act.source === "teams"
            ? 15
            : 30),
    );
    const currentSpan = iv.endMinutes - iv.startMinutes;
    const targetSpan =
      ruleMinutes !== undefined || act.source === "mail"
        ? Math.max(currentSpan, pointDuration)
        : currentSpan;
    const rawStart = iv.endMinutes > iv.startMinutes ? iv.startMinutes : Math.max(0, iv.startMinutes - pointDuration);
    const rawEnd =
      iv.endMinutes > iv.startMinutes
        ? Math.min(1440, rawStart + Math.max(roundingMinutes, targetSpan))
        : Math.max(rawStart + roundingMinutes, iv.startMinutes);
    const rounded = roundInterval(rawStart, rawEnd, roundingMinutes);

    const key = resolved?.trackerTaskId
      ? `task:${resolved.trackerTaskId}`
      : act.repoId !== undefined
        ? `repo:${act.repoId}`
        : typeof act.metadata.repoName === "string" && act.metadata.repoName.trim()
          ? `reponame:${act.metadata.repoName.trim().toLowerCase()}`
          : `act:${act.source}:${act.externalId}`;

    const srcRef: TimesheetSourceRef = {
      source: act.source,
      kind: act.kind,
      externalId: act.externalId,
      title: act.title,
      ...(act.repoId !== undefined ? { repoId: act.repoId } : {}),
      ...(typeof act.metadata.repoName === "string" ? { repoName: act.metadata.repoName } : {}),
      ...(typeof act.metadata.branch === "string" ? { branch: act.metadata.branch } : {}),
      ...(typeof act.metadata.topic === "string" ? { topic: act.metadata.topic } : {}),
      ...(typeof act.metadata.recipient === "string" ? { recipient: act.metadata.recipient } : {}),
    };

    const existing = bucketsByKey.get(key);
    if (existing) {
      existing.earliestStartMin = Math.min(existing.earliestStartMin, rounded.startMinutes);
      existing.intervals.push({ start: rounded.startMinutes, end: rounded.endMinutes });
      if (act.title && !existing.titles.includes(act.title)) existing.titles.push(act.title);
      existing.sources.push(srcRef);
      if (resolved && (!existing.trackerTaskId || resolved.mappedBy === "link")) {
        existing.trackerTaskId = resolved.trackerTaskId;
        existing.mappedBy = resolved.mappedBy;
      }
    } else {
      bucketsByKey.set(key, {
        key,
        earliestStartMin: rounded.startMinutes,
        intervals: [{ start: rounded.startMinutes, end: rounded.endMinutes }],
        ...(resolved ? { trackerTaskId: resolved.trackerTaskId, mappedBy: resolved.mappedBy } : {}),
        ...(act.repoId !== undefined ? { repoId: act.repoId } : {}),
        ...(typeof act.metadata.repoName === "string" ? { repoName: act.metadata.repoName } : {}),
        titles: act.title ? [act.title] : [],
        sources: [srcRef],
      });
    }
  }

  // Fallback suggestion task from taskCache if a bucket has no link or rule (with no tracker, the cache is another one's)
  const firstCachedTask = isNoTracker(tracker) ? undefined : [...taskCache.values()][0];

  for (const bucket of bucketsByKey.values()) {
    // Merge overlapping or nearby intervals (within 45m) inside this task bucket and compute rough ±15m duration
    const sortedIv = [...bucket.intervals].sort((a, b) => a.start - b.start || a.end - b.end);
    const mergedIv: Array<{ start: number; end: number }> = [];
    for (const iv of sortedIv) {
      const prev = mergedIv.at(-1);
      if (prev && iv.start <= prev.end + 45) {
        prev.end = Math.max(prev.end, iv.end);
      } else {
        mergedIv.push({ ...iv });
      }
    }
    const rawTotalMinutes = mergedIv.reduce((sum, iv) => sum + Math.max(0, iv.end - iv.start), 0);
    const totalMinutes = Math.max(roundingMinutes, Math.min(480, roundMinutes(rawTotalMinutes, roundingMinutes)));

    const slot = findNextAvailableSlot(
      totalMinutes,
      occupied,
      Math.max(workStartMin, bucket.earliestStartMin),
      workStartMin,
      roundingMinutes,
    );
    if (!slot) continue;

    occupied.push({ start: slot.startMinutes, end: slot.endMinutes });
    const taskId = bucket.trackerTaskId ?? firstCachedTask?.taskId;
    const mappedBy: TimesheetMappedBy = bucket.mappedBy ?? "suggestion";
    const cached = taskId ? taskCache.get(taskId) : undefined;
    rows.push({
      start: minutesToHHMM(slot.startMinutes),
      end: minutesToHHMM(slot.endMinutes),
      ...(taskId ? { trackerTaskId: taskId } : {}),
      ...(cached
        ? {
            trackerTaskTitle: cached.title,
            ...(cached.projectId ? { trackerProjectId: cached.projectId } : {}),
            ...(cached.customerId ? { trackerCustomerId: cached.customerId } : {}),
          }
        : {}),
      comment: bucket.titles.slice(0, 2).join("; ") || bucket.repoName || cached?.title || "Development work",
      sources: bucket.sources,
      mappedBy,
    });
  }

  return rows;
}
