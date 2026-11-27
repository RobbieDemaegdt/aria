/**
 * How a config tracker reads the answer to a create call (docs/trackers.md, "The reference"): row by row, from the
 * response and the config's `timeLogs.create.result`. A row is registered only when the response correlates it
 * unambiguously; anything else is failed (the call was blocked or rejected) or unknown (it ran, or the transport broke,
 * and the answer can't be matched to the row), and unknown makes the day need reconciling. Built from the fictional
 * Acme Tracker (fixtures/trackers/acme.json).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { TimesheetEntry } from "@aria/protocol";
import { describe, expect, it } from "vitest";
import type { McpActionOutcome } from "../src/runtime/types.ts";
import { parseTrackerConfig } from "../src/trackers/config/load.ts";
import { createConfigTracker } from "../src/trackers/config/tracker.ts";
import type { TaskTracker } from "../src/trackers/types.ts";

const ACME_TEXT = readFileSync(fileURLToPath(new URL("./fixtures/trackers/acme.json", import.meta.url)), "utf8");

function build(edit?: (config: Record<string, any>) => void): TaskTracker {
  const raw = JSON.parse(ACME_TEXT) as Record<string, any>;
  edit?.(raw);
  const parsed = parseTrackerConfig(JSON.stringify(raw), "acme");
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return createConfigTracker(parsed.config);
}

const row = (n: number, over: Partial<TimesheetEntry> = {}): TimesheetEntry => ({
  id: `r${n}`,
  date: "2026-10-23",
  start: `${String(8 + n).padStart(2, "0")}:00`,
  end: `${String(9 + n).padStart(2, "0")}:00`,
  minutes: 60,
  trackerTaskId: `ACME-${n}`,
  comment: `Work ${n}`,
  sources: [],
  mappedBy: "link",
  confidence: "certain",
  state: "draft",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const ok = (result: unknown): McpActionOutcome => ({ ok: true, result: typeof result === "string" ? result : JSON.stringify(result) });
/** The day's zone: 23 October 2026 is +02:00 in Brussels and +01:00 in London (the clocks change on the 25th). */
const BRUSSELS = { zone: "Europe/Brussels" };
const parse = (tracker: TaskTracker, rows: TimesheetEntry[], outcome: McpActionOutcome, ctx = BRUSSELS) => tracker.timeLogs!.create.parseResult(rows, outcome, ctx);
const acme = build();
const rows = [row(1), row(2)];
const statuses = (result: ReturnType<typeof parse>) => result.results.map((r) => r.status);

describe("create results: per row", () => {
  it("registers every row an index names, with the entry's ID", () => {
    const result = parse(acme, rows, ok({ created: [{ index: 0, id: "9001" }, { index: 1, id: "9002" }] }));
    expect(statuses(result)).toEqual(["registered", "registered"]);
    expect(result.results.map((r) => r.trackerEntryId)).toEqual(["9001", "9002"]);
    expect(result).toMatchObject({ allRegistered: true, anyRegistered: true, needsReconcile: false });
    expect(result.rawResponse).toBeUndefined();
    expect(result.results[0]).toMatchObject({ entryId: "r1", start: "09:00", end: "10:00", minutes: 60, trackerTaskId: "ACME-1", comment: "Work 1" });
  });

  it("fails a row the answer gives an error for, keeps the others, and keeps the response", () => {
    const result = parse(acme, rows, ok({ created: [{ index: 0, id: "9001" }, { index: 1, error: "Issue is closed" }] }));
    expect(statuses(result)).toEqual(["registered", "failed"]);
    expect(result.results[1]?.error).toBe("Issue is closed");
    expect(result).toMatchObject({ allRegistered: false, anyRegistered: true, needsReconcile: false });
    expect(result.rawResponse).toContain("Issue is closed");
  });

  it("leaves a row unknown when the answer names it but gives no ID and no error, and asks for a reconcile", () => {
    const result = parse(acme, rows, ok({ created: [{ index: 0, id: "9001" }, { index: 1 }] }));
    expect(statuses(result)).toEqual(["registered", "unknown"]);
    expect(result.results[1]?.error).toBe("Acme Tracker did not return a created entry ID for this row.");
    expect(result.needsReconcile).toBe(true);
  });

  it("matches rows by start, end and task when the answer has no usable index", () => {
    const answer = [
      { id: "9002", started: "2026-10-23T10:00:00+02:00", ended: "2026-10-23T11:00:00+02:00", issueKey: "ACME-2" },
      { index: 7, id: "9001", started: "2026-10-23T09:00:00+02:00", ended: "2026-10-23T10:00:00+02:00", issueKey: "ACME-1" },
    ];
    const result = parse(acme, rows, ok({ created: answer }));
    expect(result.results.map((r) => [r.entryId, r.status, r.trackerEntryId])).toEqual([
      ["r1", "registered", "9001"],
      ["r2", "registered", "9002"],
    ]);
  });

  it("compares the times the call wrote: in the config's format and the day's zone, not as the row holds them", () => {
    const answerFor = (started: string, ended: string) => ok({ created: [{ id: "9001", started, ended, issueKey: "ACME-1" }] });
    const one = [row(1)];
    // The default Acme config writes `offset`: the same time in another offset, or without one, isn't the row's.
    expect(statuses(parse(acme, one, answerFor("2026-10-23T09:00:00+02:00", "2026-10-23T10:00:00+02:00")))).toEqual(["registered"]);
    expect(statuses(parse(acme, one, answerFor("2026-10-23T09:00:00+02:00", "2026-10-23T10:00:00+02:00"), { zone: "Europe/London" }))).toEqual(["unknown"]);
    expect(statuses(parse(acme, one, answerFor("2026-10-23T09:00:00", "2026-10-23T10:00:00")))).toEqual(["unknown"]);
    expect(statuses(parse(acme, one, answerFor("2026-10-23T09:00:00+01:00", "2026-10-23T10:00:00+01:00"), { zone: "Europe/London" }))).toEqual(["registered"]);
    // `local` writes no offset, whatever the zone; `utc` writes the moment in UTC.
    const local = build((c) => {
      c.timeLogs.time = "local";
    });
    expect(statuses(parse(local, one, answerFor("2026-10-23T09:00:00", "2026-10-23T10:00:00")))).toEqual(["registered"]);
    expect(statuses(parse(local, one, answerFor("2026-10-23T09:00:00", "2026-10-23T10:00:00"), { zone: "Asia/Tokyo" }))).toEqual(["registered"]);
    expect(statuses(parse(local, one, answerFor("2026-10-23T09:00:00+02:00", "2026-10-23T10:00:00+02:00")))).toEqual(["unknown"]);
    const utc = build((c) => {
      c.timeLogs.time = "utc";
    });
    expect(statuses(parse(utc, one, answerFor("2026-10-23T07:00:00Z", "2026-10-23T08:00:00Z")))).toEqual(["registered"]);
    expect(statuses(parse(utc, one, answerFor("2026-10-23T09:00:00", "2026-10-23T10:00:00")))).toEqual(["unknown"]);
  });

  it("doesn't take two answers for one row, or an answer for a row that isn't there", () => {
    const result = parse(acme, rows, ok({ created: [{ index: 0, id: "9001" }, { index: 0, id: "9999" }, { index: 5, id: "9998" }] }));
    expect(result.results.map((r) => [r.status, r.trackerEntryId])).toEqual([
      ["registered", "9001"],
      ["unknown", undefined],
    ]);
  });
});

describe("create results: calls that went wrong", () => {
  it("fails every row of a call that was blocked or rejected, with the reason", () => {
    for (const outcome of [{ ok: false, error: "Denied by your tool rules.", blocked: true }, { ok: false, error: "422: bad entries" }] as McpActionOutcome[]) {
      const result = parse(acme, rows, outcome);
      expect(statuses(result)).toEqual(["failed", "failed"]);
      expect(result.results[0]?.error).toBe(outcome.ok ? "" : outcome.error);
      expect(result).toMatchObject({ allRegistered: false, anyRegistered: false, needsReconcile: false });
    }
    expect(parse(acme, rows, { ok: false, error: "" }).results[0]?.error).toBe("Acme Tracker rejected the time-log batch; see full server response.");
  });

  it("leaves every row unknown when the transport broke after the call may have gone through", () => {
    for (const error of ["The connection closed while waiting", "Request timed out", "Check whether the entries were created"]) {
      const result = parse(acme, rows, { ok: false, error });
      expect(statuses(result)).toEqual(["unknown", "unknown"]);
      expect(result.needsReconcile).toBe(true);
    }
  });

  it("leaves every row unknown when the call ran and the answer says nothing about them", () => {
    for (const answer of ["Done.", JSON.stringify({ unrelated: true }), ""]) {
      const result = parse(acme, rows, ok(answer));
      expect(statuses(result)).toEqual(["unknown", "unknown"]);
      expect(result.results[0]?.error).toBe("Could not verify whether Acme Tracker registered this entry; refresh your timesheet to check Acme Tracker before retrying.");
      expect(result.needsReconcile).toBe(true);
    }
  });

  it("registers nothing for no rows", () => {
    expect(parse(acme, [], ok({ created: [] }))).toMatchObject({ results: [], allRegistered: false, anyRegistered: false, needsReconcile: false });
  });
});

describe("create results: a list of created entries, and IDs in text", () => {
  const listed = build((c) => {
    c.timeLogs.create.result = {
      perRow: { list: ["results"], id: ["id"], error: "error" },
      match: { start: ["started"], end: ["ended"], task: ["issueKey"] },
      created: { lists: ["worklogs"] },
    };
  });

  it("registers by position when the list has one created entry per row and no errors", () => {
    const result = parse(listed, rows, ok({ worklogs: [{ id: "7001" }, { id: "7002" }] }));
    expect(result.results.map((r) => [r.status, r.trackerEntryId])).toEqual([["registered", "7001"], ["registered", "7002"]]);
    expect(parse(listed, rows, ok([{ id: "7001" }, { id: "7002" }])).allRegistered).toBe(true);
  });

  it("matches a created entry by start, end and task wherever it is in the list", () => {
    const result = parse(listed, rows, ok({ worklogs: [{ id: "7002", started: "2026-10-23T10:00:00+02:00", ended: "2026-10-23T11:00:00+02:00", issueKey: "ACME-2" }] }));
    expect(result.results.map((r) => r.status)).toEqual(["unknown", "registered"]);
  });

  it("leaves rows unknown for a list of another length, or one with an error in it", () => {
    expect(statuses(parse(listed, rows, ok({ worklogs: [{ id: "7001" }] })))).toEqual(["unknown", "unknown"]);
    expect(statuses(parse(listed, rows, ok({ worklogs: [{ id: "7001" }, { id: "7002", error: "x" }] })))).toEqual(["unknown", "unknown"]);
    // ...and not from a failed call.
    expect(statuses(parse(listed, rows, { ok: false, error: "boom" }))).toEqual(["failed", "failed"]);
  });

  const texted = build((c) => {
    c.timeLogs.create.result = { textIds: { label: "worklog", id: "[1-9]\\d{0,11}" } };
  });

  it("registers by position from IDs the answer's text gives, one per row", () => {
    const result = parse(texted, rows, ok("Created worklog: 8001 and worklog = 8002."));
    expect(result.results.map((r) => [r.status, r.trackerEntryId])).toEqual([["registered", "8001"], ["registered", "8002"]]);
    expect(parse(texted, rows, ok('Created worklog: "8001", worklog: 8002')).allRegistered).toBe(true);
  });

  it("leaves rows unknown when the count differs, an ID doesn't fit, or the text mentions a failure", () => {
    expect(statuses(parse(texted, rows, ok("Created worklog: 8001")))).toEqual(["unknown", "unknown"]);
    expect(statuses(parse(texted, rows, ok("Created worklog: 8001, worklog: 0")))).toEqual(["unknown", "unknown"]);
    expect(statuses(parse(texted, rows, ok("worklog: 8001, worklog: 8002 -- one failed")))).toEqual(["unknown", "unknown"]);
  });
});
