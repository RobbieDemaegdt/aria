/**
 * What the Timekeeper learns from a config tracker's tool results (docs/trackers.md, "The reference"): the task
 * cache, the names and IDs learned, update activities, and the day's registered entries, read from the fictional Acme
 * Tracker's JSON (fixtures/trackers/acme.json). A preset kept outside this repository is tested outside it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { TimesheetRegisteredEntry } from "@aria/protocol";
import { describe, expect, it } from "vitest";
import { extractJsonPayloads, Store } from "../src/index.ts";
import { parseTrackerConfig } from "../src/trackers/config/load.ts";
import { createConfigTracker } from "../src/trackers/config/tracker.ts";
import type { ReadOutcome, ReaderInput, RecordTrackerActivityInput, TaskTracker, TimekeeperReaderContext } from "../src/trackers/types.ts";

const ACME_TEXT = readFileSync(fileURLToPath(new URL("./fixtures/trackers/acme.json", import.meta.url)), "utf8");
const DATE = "2026-10-23";
const ZONE = "Europe/Brussels";

function build(edit?: (config: Record<string, any>) => void): TaskTracker {
  const raw = JSON.parse(ACME_TEXT) as Record<string, any>;
  edit?.(raw);
  const parsed = parseTrackerConfig(JSON.stringify(raw), "acme");
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return createConfigTracker(parsed.config);
}

/** A reader on an in-memory store, with what it tells the Timekeeper recorded. */
function setup(tracker: TaskTracker = build(), overrides: Partial<TimekeeperReaderContext> = {}) {
  const db = new Store(":memory:");
  const updates: RecordTrackerActivityInput[] = [];
  const registered = new Map<string, TimesheetRegisteredEntry[]>();
  const registeredCalls: Array<{ date: string; entries: TimesheetRegisteredEntry[]; mode: { clearNeedsReconcile: boolean; reconcileStored: boolean } }> = [];
  const ctx: TimekeeperReaderContext = {
    db: () => db,
    zone: () => ZONE,
    recordTaskUpdate: (input) => {
      updates.push(input);
    },
    registered: (date) => registered.get(date),
    setRegistered: (date, entries, mode) => {
      registered.set(date, entries);
      registeredCalls.push({ date, entries, mode });
    },
    ...overrides,
  };
  const reader = tracker.timekeeper.createReader(ctx);
  const input = (rawResult: unknown, toolName = "acme-list_my_issues", date = DATE): ReaderInput => ({
    date,
    toolName,
    rawResult,
    payloads: extractJsonPayloads(rawResult),
    items: [],
  });
  const json = (value: unknown) => JSON.stringify(value);
  const cache = () => db.listTrackerTaskCache("acme").sort((a, b) => a.taskId.localeCompare(b.taskId));
  return { db, reader, updates, registered, registeredCalls, input, json, cache };
}

const issue = (key: string, fields: Record<string, unknown> = {}) => ({
  key,
  fields: {
    summary: `Issue ${key}`,
    status: { name: "To Do" },
    project: { key: "LED", name: "Ledger" },
    account: { id: "ACC1", name: "Acme Corp" },
    ...fields,
  },
});

const at = (iso: string) => Date.parse(iso);

describe("the config reader: tasks", () => {
  it("caches each issue (title, status, project and customer IDs) and keeps the raw item as it was read", () => {
    const { reader, input, json, cache } = setup();
    const item = issue("ACME-1001", { summary: "Billing export", status: { name: "In Progress" } });
    expect(reader.tasks(input(json({ issues: [item] })))).toBe("read");
    expect(cache()).toMatchObject([{ taskId: "ACME-1001", title: "Billing export", status: "In Progress", projectId: "LED", customerId: "ACC1", lastSeen: item }]);
  });

  it("keeps what the cache had when an issue leaves a field out, and the cached title when it has none", () => {
    const { reader, input, json, cache } = setup();
    reader.tasks(input(json({ issues: [issue("ACME-1001", { summary: "Billing export", status: { name: "In Progress" } })] })));
    reader.tasks(input(json({ issues: [{ key: "ACME-1001", fields: {} }] })));
    expect(cache()).toMatchObject([{ taskId: "ACME-1001", title: "Billing export", status: "In Progress", projectId: "LED", customerId: "ACC1" }]);
    // An issue with neither a title nor a cached one isn't a task yet.
    const fresh = setup();
    expect(fresh.reader.tasks(fresh.input(fresh.json({ issues: [{ key: "ACME-2", fields: {} }] })))).toBe("unreadable");
    expect(fresh.cache()).toEqual([]);
  });

  it("skips an issue whose key doesn't fit the task ID pattern, and reads a bare list and a single issue", () => {
    const { reader, input, json, cache } = setup();
    expect(reader.tasks(input(json({ issues: [issue("not an id"), issue("ACME-1")] })))).toBe("read");
    expect(reader.tasks(input(json([issue("ACME-2")])))).toBe("read");
    expect(reader.tasks(input(json(issue("ACME-3"))))).toBe("read");
    expect(cache().map((e) => e.taskId)).toEqual(["ACME-1", "ACME-2", "ACME-3"]);
  });

  it("tells a result that reads, one that says there is nothing, and one it can't read apart", () => {
    const { reader, input, json } = setup();
    expect(reader.tasks(input(json({ issues: [issue("ACME-1")] })))).toBe("read");
    expect(reader.tasks(input(json({ issues: [] })))).toBe("empty");
    expect(reader.tasks(input(json([])))).toBe("empty");
    expect(reader.tasks(input(""))).toBe("empty");
    expect(reader.tasks(input("Found 3 issues: ACME-1, ACME-2, ACME-3"))).toBe("unreadable");
    expect(reader.tasks(input(json({ something: "else" })))).toBe("unreadable");
  });

  it("records an update when the issue changed on the day, as a status change when the status differs from the cache's", () => {
    const { reader, input, json, updates } = setup();
    // First sight: changed on the day, nothing to compare with.
    reader.tasks(input(json({ issues: [issue("ACME-1001", { summary: "Billing export", status: { name: "To Do" }, updated: "2026-10-23T10:15:00" })] })));
    expect(updates).toEqual([
      { taskId: "ACME-1001", title: "Billing export", event: "updated", at: at("2026-10-23T08:15:00Z"), externalKey: "acme:ACME-1001:2026-10-23", status: "To Do", statusMax: 80 },
    ]);
    // Later: a different status.
    reader.tasks(input(json({ issues: [issue("ACME-1001", { summary: "Billing export", status: { name: "In Review" }, updated: "2026-10-23T15:00:00" })] })));
    expect(updates[1]).toEqual({
      taskId: "ACME-1001",
      title: "Billing export",
      event: "status_changed",
      at: at("2026-10-23T13:00:00Z"),
      externalKey: "acme:ACME-1001:2026-10-23",
      status: "In Review",
      statusMax: 80,
      previousStatus: "To Do",
    });
    // The same status in other letters isn't a change.
    reader.tasks(input(json({ issues: [issue("ACME-1001", { summary: "Billing export", status: { name: "in review" }, updated: "2026-10-23T16:00:00" })] })));
    expect(updates[2]?.event).toBe("updated");
    expect(updates[2]?.previousStatus).toBeUndefined();
  });

  it("goes on with the other issues when one of them fails", () => {
    const { reader, input, json, cache } = setup(undefined, {
      recordTaskUpdate: (update) => {
        if (update.taskId === "ACME-2") throw new Error("the activity store is full");
      },
    });
    const changed = { updated: "2026-10-23T10:15:00" };
    expect(reader.tasks(input(json({ issues: [issue("ACME-1", changed), issue("ACME-2", changed), issue("ACME-3", changed)] })))).toBe("read");
    // ACME-2's cache row was written before its update failed; ACME-3 is read after it.
    expect(cache().map((e) => e.taskId)).toEqual(["ACME-1", "ACME-2", "ACME-3"]);
  });

  it("records no update for an issue changed on another day, or without a time", () => {
    const { reader, input, json, updates } = setup();
    reader.tasks(input(json({ issues: [issue("ACME-1", { updated: "2026-10-22T10:15:00" }), issue("ACME-2", { updated: "not a time" }), issue("ACME-3")] })));
    expect(updates).toEqual([]);
  });

  it("reads a history (a single task's) as updates only: nothing goes to the cache", () => {
    const { reader, input, json, updates, cache } = setup();
    expect(reader.tasks(input(json({ issues: [issue("ACME-1001", { summary: "Billing export", updated: "2026-10-23T10:15:00" })] })), "history")).toBe("read");
    expect(updates).toHaveLength(1);
    expect(cache()).toEqual([]);
  });

  it("learns names from the issues and fills in the IDs of an issue that gives only a project's name", () => {
    const { reader, input, json, cache } = setup();
    reader.tasks(input(json({ issues: [issue("ACME-1")] })));
    // The second issue's project is named, with no key and no account.
    reader.tasks(input(json({ issues: [issue("ACME-2", { project: { name: "Ledger" }, account: undefined })] })));
    expect(cache()).toMatchObject([
      { taskId: "ACME-1", projectId: "LED", customerId: "ACC1" },
      { taskId: "ACME-2", projectId: "LED", customerId: "ACC1" },
    ]);
  });

  it("falls back on the config's known customers when a name has no ID, whatever its case", () => {
    const { reader, input, json, cache } = setup(build((c) => (c.knownIds = { customers: { " Globex Ltd ": "ACC7" } })));
    reader.tasks(input(json({ issues: [issue("ACME-5", { account: { name: "GLOBEX LTD" } }), issue("ACME-6", { project: { key: "OTH", name: "Other" }, account: { name: "Unknown Co" } })] })));
    expect(cache().map((e) => [e.taskId, e.customerId])).toEqual([
      ["ACME-5", "ACC7"],
      ["ACME-6", undefined],
    ]);
  });

  it("cleans titles and statuses of markup", () => {
    const { reader, input, json, cache } = setup();
    reader.tasks(input(json({ issues: [issue("ACME-1", { summary: "R&amp;D <b>plan</b>", status: { name: "In &amp; out" } })] })));
    expect(cache()).toMatchObject([{ title: "R&D plan", status: "In & out" }]);
  });
});

describe("the config reader: time logs", () => {
  const worklog = (id: string, started: string, ended: string, extra: Record<string, unknown> = {}) => ({
    id,
    issueKey: "ACME-1001",
    issueSummary: "Billing export",
    started,
    ended,
    comment: "Worked on it",
    ...extra,
  });

  it("replaces the day's registered entries from a date-range read, and clears the reconcile flag and the stored rows", () => {
    const { reader, input, json, registeredCalls } = setup();
    const outcome = reader.timeLogs(
      input(json({ worklogs: [worklog("9001", "2026-10-23T09:00:00", "2026-10-23T11:30:00"), worklog("9002", "2026-10-23T13:00:00", "2026-10-23T14:00:00", { comment: "" })] }), "acme-list_worklogs"),
      "dateRange",
    );
    expect(outcome).toBe("read");
    expect(registeredCalls).toEqual([
      {
        date: DATE,
        mode: { clearNeedsReconcile: true, reconcileStored: true },
        entries: [
          { id: "9001", start: "09:00", end: "11:30", minutes: 150, trackerTaskId: "ACME-1001", trackerTaskTitle: "Billing export", comment: "Worked on it" },
          { id: "9002", start: "13:00", end: "14:00", minutes: 60, trackerTaskId: "ACME-1001", trackerTaskTitle: "Billing export", comment: "" },
        ],
      },
    ]);
  });

  it("registers only what falls on the day, once per ID, and only with a task and a valid ID", () => {
    const { reader, input, json, registeredCalls } = setup();
    reader.timeLogs(
      input(
        json([
          worklog("9001", "2026-10-22T09:00:00", "2026-10-22T10:00:00"),
          worklog("9002", "2026-10-23T09:00:00", "2026-10-23T10:00:00"),
          worklog("9002", "2026-10-23T09:00:00", "2026-10-23T10:30:00"),
          worklog("log 3", "2026-10-23T11:00:00", "2026-10-23T12:00:00"),
          worklog("9004", "2026-10-23T12:00:00", "2026-10-23T12:00:00"),
          worklog("9005", "2026-10-23T13:00:00", "2026-10-23T14:00:00", { issueKey: "no task" }),
        ]),
        "acme-list_worklogs",
      ),
      "dateRange",
    );
    expect(registeredCalls).toHaveLength(1);
    expect(registeredCalls[0]!.entries.map((e) => [e.id, e.end])).toEqual([["9002", "10:30"]]);
  });

  it("gives the tasks a time log names to the cache, and leaves the day's entries alone outside a date-range read", () => {
    const { reader, input, json, registeredCalls, cache } = setup();
    expect(reader.timeLogs(input(json({ worklogs: [worklog("9001", "2026-10-23T09:00:00", "2026-10-23T11:30:00")] }), "acme-list_worklogs"))).toBe("read");
    expect(registeredCalls).toEqual([]);
    // The cache learns the task only when the log tells it something about it: a title or a project (Acme's has a title).
    expect(cache()).toMatchObject([{ taskId: "ACME-1001", title: "Billing export" }]);
  });

  it("reads an empty list, and words that say the day is empty, as an empty day", () => {
    const { reader, input, json, registeredCalls, registered } = setup();
    expect(reader.timeLogs(input(json({ worklogs: [] }), "acme-list_worklogs"), "dateRange")).toBe("empty");
    expect(reader.timeLogs(input("No worklogs.", "acme-list_worklogs"), "dateRange")).toBe("empty");
    expect(registeredCalls.map((c) => c.entries)).toEqual([[], []]);
    expect(registered.get(DATE)).toEqual([]);
  });

  it("can't read other text: the registered list isn't touched", () => {
    const { reader, input, registeredCalls } = setup();
    expect(reader.timeLogs(input("Worklogs for 2026-10-23: 9001 ACME-1001 09:00-11:30", "acme-list_worklogs"), "dateRange")).toBe("unreadable");
    expect(reader.timeLogs(input(JSON.stringify({ unrelated: true }), "acme-list_worklogs"), "dateRange")).toBe("unreadable");
    expect(registeredCalls).toEqual([]);
  });
});

describe("the config reader: projects and the name index", () => {
  it("has no project lookup when the config has no projects", () => {
    const { reader, input, json } = setup();
    expect(reader.projects(input(json({ projects: [{ id: "LED", name: "Ledger" }] }), "acme-find_projects"))).toBe("unreadable" satisfies ReadOutcome);
  });

  it("learns project names and customers from a lookup, and fills in the cache from them", () => {
    const tracker = build((c) => {
      c.projects = {
        search: { tool: "find_projects", args: { query: "{query}" } },
        lists: ["projects"],
        fields: { id: ["id"], name: ["name"], customerId: ["customer.id"], customerName: ["customer.name"] },
      };
    });
    const { reader, input, json, cache, db } = setup(tracker);
    reader.tasks(input(json({ issues: [issue("ACME-9", { project: { name: "Harbour" }, account: undefined })] })));
    expect(cache()[0]?.projectId).toBeUndefined();
    expect(reader.unknownProjectNames(["ACME-9"])).toEqual(["Harbour"]);
    expect(reader.projects(input(json({ projects: [{ id: "HAR", name: "Harbour", customer: { id: "ACC9", name: "Dock Co" } }] }), "acme-find_projects"))).toBe("read");
    expect(db.getTrackerTaskCache("acme", "ACME-9")).toMatchObject({ projectId: "HAR", customerId: "ACC9" });
    expect(reader.unknownProjectNames(["ACME-9"])).toEqual([]);
    expect(reader.projects(input(json({ projects: [] }), "acme-find_projects"))).toBe("empty");
  });
});
