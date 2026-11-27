/**
 * The config tracker's create-result parser (docs/trackers.md, "The reference"): how a create call went, row by
 * row, from the response and the config's `timeLogs.create.result`. A row is `registered` only when the response
 * correlates it unambiguously: by its `index`, by its start, end and task, or as an exact N-for-N success with no error.
 * Anything else is `failed` (the call was blocked, or rejected) or `unknown` (the call ran, or the transport broke, and
 * the response can't be matched to the row), and `unknown` makes the day need reconciling with the tracker before a retry.
 */
import type { TimeRegisteredEntryResult, TimesheetEntry } from "@aria/protocol";
import type { McpActionOutcome } from "../../runtime/types.ts";
import { cleanTitle } from "../../tasks/pr.ts";
import { extractJsonPayloads } from "../../util/mcp-payloads.ts";
import type { CreateTimeLogsResult, TimeLogContext } from "../types.ts";
import { firstValid, isPlainObject, readId, type JsonObject, type ObjectKeys } from "./fields.ts";
import { parseIdPattern } from "./patterns.ts";
import type { TrackerConfig } from "./schema.ts";
import { formatTrackerTime } from "./time.ts";

type ParseResult = (rows: readonly TimesheetEntry[], outcome: McpActionOutcome, ctx: TimeLogContext) => CreateTimeLogsResult;

type Correlation = { status: "registered" | "failed" | "unknown"; id?: string; error?: string };

/** Transport failures that leave the outcome open: the call may have gone through (ARIA's own MCP client's wording). */
const AMBIGUOUS_TRANSPORT = /check whether|interrupted|timed out|closed while/i;

const escapeRegex = (text: string) => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

export function createCreateResultParser(config: TrackerConfig): ParseResult {
  const label = config.label;
  const keys = config.objectKeys as ObjectKeys;
  const spec = config.timeLogs?.create.result;
  const textIds = spec?.textIds;
  const idSource = textIds ? parseIdPattern(textIds.id) : undefined;
  const textIdPattern = textIds && idSource?.ok ? new RegExp(`\\b${escapeRegex(textIds.label)}\\s*[:=]\\s*"?(${idSource.value.source})"?`, "gi") : undefined;

  const idOf = (item: JsonObject, paths: readonly string[] | undefined) => firstValid(item, paths, (v) => readId(v, keys));
  const stringOf = (item: JsonObject, paths: readonly string[] | undefined) => firstValid(item, paths, (v) => (typeof v === "string" ? v : undefined));
  const errorKey = spec?.perRow?.error ?? "error";

  const timeFormat = config.timeLogs?.time ?? "local";

  /**
   * The submitted row an item with these start, end and task belongs to, among those not taken. The item's times are
   * compared with the rows' as the call wrote them (`wire`, the format of `timeLogs.time`).
   */
  const matchRow = (item: JsonObject, submitted: readonly TimesheetEntry[], wire: ReadonlyArray<{ start: string; end: string }>, used: ReadonlySet<number>): number => {
    const match = spec?.match;
    if (!match) return -1;
    const start = stringOf(item, match.start);
    const end = stringOf(item, match.end);
    const task = idOf(item, match.task);
    if (!start || !end || !task) return -1;
    return submitted.findIndex((e, i) => !used.has(i) && wire[i]!.start === start && wire[i]!.end === end && e.trackerTaskId === task);
  };

  return (submitted, outcome, ctx) => {
    // Only a config that matches items by their times needs them (`matchRow` stops first without `spec.match`).
    const wire = spec?.match
      ? submitted.map((e) => ({
          start: formatTrackerTime(timeFormat, e.date, e.start, ctx.zone),
          end: formatTrackerTime(timeFormat, e.date, e.end, ctx.zone),
        }))
      : [];
    const rawBody = outcome.ok ? outcome.result : outcome.error;
    const fullText = rawBody.trim();
    const payloads = extractJsonPayloads(rawBody);
    const correlated = new Map<number, Correlation>();

    for (const payload of payloads) {
      // Per-row results: the row's own index, else its start, end and task.
      const perRow = spec?.perRow;
      if (perRow && isPlainObject(payload)) {
        const list = firstValid(payload, perRow.list, (v) => (Array.isArray(v) ? v : undefined));
        if (list) {
          const used = new Set<number>();
          for (const raw of list) {
            if (!isPlainObject(raw)) continue;
            const given = perRow.index ? raw[perRow.index] : undefined;
            let index = typeof given === "number" && Number.isInteger(given) ? given : -1;
            if (index < 0 || index >= submitted.length || used.has(index)) index = matchRow(raw, submitted, wire, used);
            if (index >= 0 && index < submitted.length && !used.has(index)) {
              used.add(index);
              const id = idOf(raw, perRow.id);
              const rawError = raw[errorKey];
              const error = typeof rawError === "string" && rawError.trim() ? rawError.trim() : undefined;
              const failed = (perRow.ok ? raw[perRow.ok] === false : false) || Boolean(error);
              const ok = !failed && Boolean(id);
              correlated.set(index, {
                status: ok ? "registered" : failed ? "failed" : "unknown",
                ...(id ? { id } : {}),
                ...(error ? { error } : !ok ? { error: `${label} did not return a created entry ID for this row.` } : {}),
              });
            }
          }
        }
      }

      // A list of created entries: matched by start, end and task, or an exact N-for-N success.
      const created = spec?.created;
      const arr: unknown[] | undefined = !created
        ? undefined
        : Array.isArray(payload)
          ? payload
          : isPlainObject(payload)
            ? created.lists.map((key) => (Object.hasOwn(payload, key) ? payload[key] : undefined)).find((v): v is unknown[] => Array.isArray(v))
            : undefined;
      if (arr && correlated.size === 0) {
        const used = new Set<number>();
        for (const raw of arr) {
          if (!isPlainObject(raw)) continue;
          const id = idOf(raw, spec?.perRow?.id);
          if (!id) continue;
          const index = matchRow(raw, submitted, wire, used);
          if (index >= 0) {
            used.add(index);
            correlated.set(index, { status: "registered", id });
          }
        }
        if (
          outcome.ok &&
          correlated.size === 0 &&
          arr.length === submitted.length &&
          arr.every((x) => isPlainObject(x) && Boolean(idOf(x, spec?.perRow?.id)) && !x[errorKey])
        ) {
          arr.forEach((x, index) => correlated.set(index, { status: "registered", id: idOf(x as JsonObject, spec?.perRow?.id)! }));
        }
      }
    }

    // Text that says the entries' IDs, when the call ran and mentions no failure.
    if (outcome.ok && correlated.size === 0 && fullText && textIdPattern && !/\b(?:failed|error)\b/i.test(fullText)) {
      const ids = [...fullText.matchAll(textIdPattern)].map((m) => m[1]!);
      if (ids.length === submitted.length) ids.forEach((id, index) => correlated.set(index, { status: "registered", id }));
    }

    // A row the response doesn't settle: blocked or rejected (failed), or the call ran or the transport broke (unknown).
    const ambiguous = outcome.ok || (!outcome.blocked && AMBIGUOUS_TRANSPORT.test(outcome.error));
    const defaultStatus: "failed" | "unknown" = ambiguous ? "unknown" : "failed";
    const defaultReason =
      !outcome.ok && outcome.error
        ? cleanTitle(outcome.error, 240)
        : !outcome.ok
          ? `${label} rejected the time-log batch; see full server response.`
          : `Could not verify whether ${label} registered this entry; refresh your timesheet to check ${label} before retrying.`;

    const results: TimeRegisteredEntryResult[] = submitted.map((entry, index) => {
      const found = correlated.get(index);
      if (found?.status === "registered" && found.id) {
        return {
          entryId: entry.id,
          start: entry.start,
          end: entry.end,
          minutes: entry.minutes,
          trackerTaskId: entry.trackerTaskId!,
          ...(entry.trackerTaskTitle ? { trackerTaskTitle: entry.trackerTaskTitle } : {}),
          trackerProjectId: entry.trackerProjectId!,
          trackerCustomerId: entry.trackerCustomerId!,
          comment: entry.comment,
          status: "registered",
          trackerEntryId: found.id,
        };
      }
      return {
        entryId: entry.id,
        start: entry.start,
        end: entry.end,
        minutes: entry.minutes,
        trackerTaskId: entry.trackerTaskId ?? "",
        ...(entry.trackerTaskTitle ? { trackerTaskTitle: entry.trackerTaskTitle } : {}),
        trackerProjectId: entry.trackerProjectId ?? "",
        trackerCustomerId: entry.trackerCustomerId ?? "",
        comment: entry.comment,
        status: found?.status ?? defaultStatus,
        error: found?.error ?? defaultReason,
      };
    });

    const allRegistered = results.length > 0 && results.every((r) => r.status === "registered");
    return {
      results,
      allRegistered,
      anyRegistered: results.some((r) => r.status === "registered"),
      needsReconcile: results.some((r) => r.status === "unknown"),
      ...(!allRegistered && fullText ? { rawResponse: fullText } : {}),
    };
  };
}
