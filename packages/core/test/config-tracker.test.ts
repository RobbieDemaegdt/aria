/**
 * The generic tracker a config describes (docs/trackers.md, "What a tracker config is"): built from the fictional Acme
 * Tracker preset (fixtures/trackers/acme.json), which is not shaped like the tracker ARIA was first written for, on
 * purpose: string keys, nested fields, object statuses, array arguments, no projects. A preset kept outside this
 * repository is tested outside it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { TimesheetEntry } from "@aria/protocol";
import { describe, expect, it } from "vitest";
import { parseTrackerConfig } from "../src/trackers/config/load.ts";
import { createConfigTracker } from "../src/trackers/config/tracker.ts";
import { windowTrackerInfo } from "../src/trackers/info.ts";
import { matchRoutes } from "../src/trackers/routes.ts";
import type { TaskTracker } from "../src/trackers/types.ts";

const ACME_TEXT = readFileSync(fileURLToPath(new URL("./fixtures/trackers/acme.json", import.meta.url)), "utf8");

function build(edit?: (config: Record<string, any>) => void, options: { servers?: string[]; hash?: string } = {}): TaskTracker {
  const raw = JSON.parse(ACME_TEXT) as Record<string, any>;
  edit?.(raw);
  const parsed = parseTrackerConfig(JSON.stringify(raw), "acme");
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return createConfigTracker(parsed.config, options);
}

const acme = build(undefined, { hash: "3f2a9c1e" });
/** The day's zone for the time-log calls: 23 October 2026 is +02:00 in Brussels. */
const BRUSSELS = { zone: "Europe/Brussels" };

describe("identity", () => {
  it("is the config's id, label and link, and says it is strict", () => {
    expect(acme.id).toBe("acme");
    expect(acme.label).toBe("Acme Tracker");
    expect(acme.info).toEqual({
      id: "acme",
      label: "Acme Tracker",
      taskUrlTemplate: "https://acme.example/browse/{id}",
      taskRefPlaceholder: "Issue key (e.g. ACME-123) or acme.example link",
      serverHint: "Acme Cloud",
      capabilities: { timeLogs: true, projects: false },
    });
    expect(acme.configHash).toBe("3f2a9c1e");
    expect(build().configHash).toBeUndefined();
    expect(acme.taskUrl("ACME-7")).toBe("https://acme.example/browse/ACME-7");
    expect(acme.taskUrl(" ACME-7 ")).toBe("https://acme.example/browse/ACME-7");
    expect(acme.taskUrl("a/b?$&")).toBe("https://acme.example/browse/a%2Fb%3F%24%26");
  });

  it("names a placeholder and the updates after the label when the config gives none, and leaves out what it has none of", () => {
    const bare = build((c) => {
      delete c.info.taskRefPlaceholder;
      delete c.info.serverHint;
      delete c.timekeeper;
      delete c.timeLogs;
    });
    expect(bare.info).toEqual({
      id: "acme",
      label: "Acme Tracker",
      taskUrlTemplate: "https://acme.example/browse/{id}",
      taskRefPlaceholder: "Acme Tracker task ID or link",
      capabilities: { timeLogs: false, projects: false },
    });
    expect(bare.timeLogs).toBeUndefined();
    expect(bare.projects).toBeUndefined();
    expect(bare.timekeeper.taskUpdatesName).toBe("Acme Tracker task updates");
    expect(bare.timekeeper.steps("Acme-")).toEqual([]);
    expect(bare.timekeeper.dateRangeHint).toBeUndefined();
    expect(bare.timekeeper.resolveIdsHint).toBeUndefined();
    expect(bare.tasks.commentHint).toBeUndefined();
  });

  it("holds the config's tool sets and words", () => {
    expect([...acme.reservedTools].sort()).toEqual(["add_worklogs", "delete_worklogs", "update_worklog"]);
    expect([...acme.confirmTools]).toEqual(["delete_worklogs"]);
    expect(acme.testConnectionTool).toBe("get_current_user");
    expect(acme.rawCompanions).toEqual({});
    expect(acme.tasks.myTasks).toEqual(["list_my_issues"]);
    expect(acme.tasks.byId?.tools).toEqual(["get_issues"]);
    expect(acme.timeLogs?.byRange.tools).toEqual(["list_worklogs"]);
    expect(acme.timekeeper.steps("Acme-")).toEqual([
      "The user's open Acme issues (Acme-list_my_issues) and any issue keys that need their details (Acme-get_issues).",
      "Worklogs already registered for the target date (Acme-list_worklogs).",
    ]);
    expect(acme.timekeeper.taskUpdatesName).toBe("Acme issue updates");
  });

  it("fills a config's hints and messages, the user's text going in as it is", () => {
    const worded = build((c) => {
      c.timekeeper.dateRangeHint = 'Use from "{date}" and to "{nextDay}".';
      c.timekeeper.resolveIdsHint = "Resolve {ids} with {prefix}get_issues.";
      c.timekeeper.commentHint = "use {prefix}get_comments";
      c.messages = { invalidTaskRef: 'No issue "{input}" here.' };
    });
    expect(worded.timekeeper.dateRangeHint?.("2026-10-23", "2026-10-24")).toBe('Use from "2026-10-23" and to "2026-10-24".');
    expect(worded.timekeeper.resolveIdsHint?.("Acme-", ["ACME-1", "ACME-2"])).toBe("Resolve ACME-1,ACME-2 with Acme-get_issues.");
    expect(worded.tasks.commentHint?.("Acme-")).toBe("use Acme-get_comments");
    expect(worded.messages.invalidTaskRef("$& {x}")).toBe('No issue "$& {x}" here.');
    expect(worded.messages.invalidRuleTaskRef("zz")).toBe(`"zz" isn't a valid Acme Tracker task ID or link.`);
  });
});

describe("servers", () => {
  it("matches by the config's substrings, and ranks by its preference list", () => {
    expect(acme.matchesServer("Acme Cloud")).toBe(true);
    expect(acme.matchesServer("my-ACME")).toBe(true);
    expect(acme.matchesServer("GitHub")).toBe(false);
    expect(acme.fallbackServer).toBe("Acme");
    const ranked = build((c) => (c.servers = { match: ["acme", "tracker"], prefer: ["Acme", "Tracker Hub"], fallback: "Acme" }));
    expect(["Acme", "acme", "Tracker Hub", "tracker-x"].map((name) => ranked.serverPreference(name))).toEqual([0, 0, 1, 2]);
  });

  it("follows the setting's servers when there are some: exactly those, in that order, the first as the fallback", () => {
    const chosen = build(undefined, { servers: ["Work Tracker", "Acme"] });
    expect(chosen.matchesServer("work tracker")).toBe(true);
    expect(chosen.matchesServer("Acme Cloud")).toBe(false);
    expect(["Work Tracker", "acme", "Other"].map((name) => chosen.serverPreference(name))).toEqual([0, 1, 2]);
    expect(chosen.fallbackServer).toBe("Work Tracker");
    expect(build(undefined, { servers: [] }).matchesServer("Acme Cloud")).toBe(true);
  });
});

describe("references", () => {
  it("reads an explicit reference: a key, with # or a prefix, or a link, normalized to upper case", () => {
    const read = (s: string) => acme.parseTaskRef(s);
    expect(["ACME-123", "acme-123", " #ACME-123 ", "issue ACME-123", "Issue: acme-123", "https://acme.example/browse/acme-123?x=1#c", "acme.example/browse/ACME-123"].map(read)).toEqual(
      Array.from({ length: 7 }, () => "ACME-123"),
    );
    expect(["ACME-0", "ACME-12345678", "ACMEE-1", "task 123", "123", "", "https://other.example/browse/ACME-1", "https://acme.example/projects/ACME-1"].map(read)).toEqual(
      Array.from({ length: 8 }, () => undefined),
    );
    expect(acme.parseTaskRef(undefined)).toBeUndefined();
  });

  it("finds a reference in free text: a link first, then a bare key at word edges, never from the middle of a word", () => {
    expect(acme.extractTaskRef("Fix login (acme-42)")).toBe("ACME-42");
    expect(acme.extractTaskRef("ACME-3 and https://acme.example/browse/ACME-9")).toBe("ACME-9");
    expect(acme.extractTaskRef("XACME-4", "ACME-5x", "see ACME-6.")).toBe("ACME-6");
    expect(acme.extractTaskRef(undefined, "", "nothing", "[ACME-77]")).toBe("ACME-77");
    expect(acme.extractTaskRef("ACME-0 ACME-12345678")).toBeUndefined();
    expect(acme.extractTaskRef()).toBeUndefined();
  });

  it("reads a link's ID by the explicit pattern and a bare one in text by the free-text pattern", () => {
    const narrow = build((c) => (c.taskRef.idInText = "ACME-[1-9]\\d{2,6}"));
    expect(narrow.extractTaskRef("see https://acme.example/browse/ACME-12 now")).toBe("ACME-12");
    expect(narrow.extractTaskRef("see ACME-12 now")).toBeUndefined();
    expect(narrow.extractTaskRef("see ACME-123 now")).toBe("ACME-123");
    expect(narrow.parseTaskRef("ACME-12")).toBe("ACME-12");
  });

  it("finds a reference in a branch name, as a key anywhere or the start of a segment", () => {
    expect(["feature/ACME-88-login", "refs/heads/acme-5-x", "origin/ACME-9", "ACME-1", "user/acme-2_fix"].map((b) => acme.taskRefFromBranch(b))).toEqual([
      "ACME-88",
      "ACME-5",
      "ACME-9",
      "ACME-1",
      "ACME-2",
    ]);
    expect(["main", "release/2026-10-23-rc1", "", undefined].map((b) => acme.taskRefFromBranch(b))).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe("tasks", () => {
  const payload = {
    issues: [
      {
        key: "ACME-12",
        fields: {
          summary: "Fix <b>login</b> &amp; logout",
          status: { name: "In Progress" },
          priority: { name: "High" },
          issuetype: { name: "Bug" },
          project: { key: "WEB", name: "Web Shop" },
          account: { id: "AC-1", name: "Globex" },
          duedate: "2026-12-01T00:00:00Z",
          updated: "2026-11-02T09:00:00",
          comments: [{ id: "c1", body: "Looks good", author: { name: "Eva" } }],
        },
      },
      { key: "ACME-13", fields: { summary: "Second", status: "Done" } },
      { key: "ACME-12", fields: { summary: "A duplicate" } },
      { key: "nope", fields: { summary: "Not a key" } },
    ],
  };

  it("reads the config's fields, cleaned, with the first of a key winning", () => {
    const tasks = acme.tasks.parse(JSON.stringify(payload));
    expect(tasks.map((t) => t.taskId)).toEqual(["ACME-12", "ACME-13"]);
    const { raw, ...first } = tasks[0]!;
    expect(raw).toEqual(payload.issues[0]);
    expect(first).toEqual({
      taskId: "ACME-12",
      title: "Fix login & logout",
      status: "In Progress",
      priority: "High",
      taskType: "Bug",
      projectId: "WEB",
      projectName: "Web Shop",
      customerId: "AC-1",
      customerName: "Globex",
      dueDate: "2026-12-01",
      comment: "Looks good",
      commentBy: "Eva",
      commentKey: "1:c1:Looks good",
    });
    expect(tasks[1]).toMatchObject({ taskId: "ACME-13", title: "Second", status: "Done", closed: true });
  });

  it("gives the same fields from a cached object (lastSeenFields)", () => {
    expect(acme.tasks.lastSeenFields(payload.issues[0]!)).toEqual({
      status: "In Progress",
      priority: "High",
      taskType: "Bug",
      projectName: "Web Shop",
      customerName: "Globex",
      dueDate: "2026-12-01",
      comment: "Looks good",
      commentBy: "Eva",
      commentKey: "1:c1:Looks good",
    });
  });

  it("reads a list, an envelope or a single task, and says when it can't read the answer", () => {
    const one = { key: "ACME-1", fields: { summary: "One" } };
    expect(acme.tasks.parse([one]).map((t) => t.taskId)).toEqual(["ACME-1"]);
    expect(acme.tasks.parse({ issues: [one] }).map((t) => t.taskId)).toEqual(["ACME-1"]);
    expect(acme.tasks.parse(JSON.stringify(one)).map((t) => t.taskId)).toEqual(["ACME-1"]);
    expect(acme.tasks.parse({ content: [{ type: "text", text: JSON.stringify([one]) }] }).map((t) => t.taskId)).toEqual(["ACME-1"]);
    for (const empty of ["[]", "", "  ", { issues: [] }, { content: [] }, null, undefined]) expect(acme.tasks.parse(empty)).toEqual([]);
    // As the code adapter did, an empty envelope that arrives as text isn't recognized as empty (only an object is).
    for (const unreadable of ["something went wrong", JSON.stringify({ error: "denied" }), JSON.stringify([{ key: "nope" }]), JSON.stringify({ issues: [] }), "No issues."]) {
      expect(() => acme.tasks.parse(unreadable)).toThrow("Unrecognized response from Acme Tracker tasks API.");
    }
  });

  it("knows the empty phrases of the config, and nothing else", () => {
    const phrased = build((c) => (c.tasks.emptyText = ["no issues", "nothing here"]));
    expect(phrased.tasks.parse("No issues.")).toEqual([]);
    expect(phrased.tasks.parse(" nothing here ")).toEqual([]);
    expect(() => phrased.tasks.parse("no issues at all")).toThrow("Unrecognized response");
  });

  it("closes a task on the config's words at a word edge, and ranks statuses by the config's list", () => {
    expect(["Done", "done ", "Won't do", "Done - shipped", "Doneness", "Open", "", undefined].map((s) => acme.tasks.isClosedStatus(s))).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(["In Progress", " in review ", "To Do", "Backlog", "Whatever", "", undefined].map((s) => acme.tasks.statusRank(s))).toEqual([0, 1, 2, 3, 4, 4, 4]);
  });
});

describe("arguments", () => {
  const row = (over: Partial<TimesheetEntry> = {}): TimesheetEntry => ({
    id: "r1",
    date: "2026-10-23",
    start: "09:00",
    end: "10:00",
    minutes: 60,
    trackerTaskId: "ACME-5",
    comment: "  Review  ",
    sources: [],
    mappedBy: "link",
    confidence: "certain",
    state: "draft",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });

  it("builds a lookup, a date range and the writes from the config's templates", () => {
    expect(acme.tasks.byId?.args(["ACME-1", "ACME-2"])).toEqual({ keys: ["ACME-1", "ACME-2"] });
    expect(acme.tasks.byId?.args(["ACME-1", "bad", "acme-3 "])).toEqual({ keys: ["ACME-1"] });
    expect(acme.timeLogs?.byRange.args("2026-10-23", "2026-10-24")).toEqual({ from: "2026-10-23", to: "2026-10-24" });
    // Acme writes `offset` times (its config's `timeLogs.time`): the wall time and the day's zone offset.
    expect(acme.timeLogs?.create.args([row(), row({ trackerTaskId: "ACME-6", comment: "" })], BRUSSELS)).toEqual({
      worklogs: [
        { issueKey: "ACME-5", started: "2026-10-23T09:00:00+02:00", ended: "2026-10-23T10:00:00+02:00", comment: "Review" },
        { issueKey: "ACME-6", started: "2026-10-23T09:00:00+02:00", ended: "2026-10-23T10:00:00+02:00", comment: "" },
      ],
    });
    const input = { entryId: "9100001", date: "2026-10-23", start: "09:00", end: "10:00", comment: " Edited " };
    const wire = { started: "2026-10-23T09:00:00+02:00", ended: "2026-10-23T10:00:00+02:00" };
    expect(acme.timeLogs?.update.args(input, BRUSSELS)).toEqual({ id: "9100001", ...wire, comment: " Edited " });
    expect(acme.timeLogs?.update.args({ ...input, task: { taskId: "ACME-8" } }, BRUSSELS)).toEqual({ id: "9100001", ...wire, comment: " Edited ", issueKey: "ACME-8" });
    expect(acme.timeLogs?.delete.args(["101", "102"])).toEqual({ ids: ["101", "102"] });
  });

  it("writes times as the config's `time` says, in the day's zone, and gives its templates the date and the minutes", () => {
    const worklog = (time: string | undefined) =>
      build((c) => {
        if (time) c.timeLogs.time = time;
        else delete c.timeLogs.time; // not said: `local`
        c.timeLogs.create.args = { worklogs: { $each: "rows", item: { when: "{date} {start}/{end} {minutes}min", issueKey: "{taskId}" } } };
        c.timeLogs.update.args = { id: "{entryId}", when: "{date} {start}/{end} {minutes}min" };
      });
    const update = { entryId: "9100001", date: "2026-10-23", start: "09:30", end: "11:00", comment: "x" };
    const cases: Array<[string | undefined, { zone: string }, string]> = [
      ["local", BRUSSELS, "2026-10-23 2026-10-23T09:00:00/2026-10-23T10:00:00 60min"],
      [undefined, BRUSSELS, "2026-10-23 2026-10-23T09:00:00/2026-10-23T10:00:00 60min"],
      ["offset", BRUSSELS, "2026-10-23 2026-10-23T09:00:00+02:00/2026-10-23T10:00:00+02:00 60min"],
      ["utc", BRUSSELS, "2026-10-23 2026-10-23T07:00:00Z/2026-10-23T08:00:00Z 60min"],
      ["offset", { zone: "Asia/Kolkata" }, "2026-10-23 2026-10-23T09:00:00+05:30/2026-10-23T10:00:00+05:30 60min"],
      ["utc", { zone: "America/New_York" }, "2026-10-23 2026-10-23T13:00:00Z/2026-10-23T14:00:00Z 60min"],
    ];
    for (const [time, zone, expected] of cases) {
      expect(worklog(time).timeLogs?.create.args([row()], zone)).toEqual({ worklogs: [{ when: expected, issueKey: "ACME-5" }] });
    }
    // `local` ignores the zone; an update has the same variables, with the minutes worked out from its times.
    expect(worklog("local").timeLogs?.update.args(update, { zone: "Pacific/Auckland" })).toEqual({ id: "9100001", when: "2026-10-23 2026-10-23T09:30:00/2026-10-23T11:00:00 90min" });
    expect(worklog("offset").timeLogs?.update.args(update, BRUSSELS)).toEqual({ id: "9100001", when: "2026-10-23 2026-10-23T09:30:00+02:00/2026-10-23T11:00:00+02:00 90min" });
    // 24:00 is the last second of the day, in each format.
    const lastRow = row({ start: "23:00", end: "24:00", minutes: 60 });
    expect(worklog("local").timeLogs?.create.args([lastRow], BRUSSELS)).toEqual({ worklogs: [{ when: "2026-10-23 2026-10-23T23:00:00/2026-10-23T23:59:59 60min", issueKey: "ACME-5" }] });
    expect(worklog("offset").timeLogs?.create.args([lastRow], BRUSSELS)).toEqual({ worklogs: [{ when: "2026-10-23 2026-10-23T23:00:00+02:00/2026-10-23T23:59:59+02:00 60min", issueKey: "ACME-5" }] });
    expect(worklog("utc").timeLogs?.create.args([lastRow], BRUSSELS)).toEqual({ worklogs: [{ when: "2026-10-23 2026-10-23T21:00:00Z/2026-10-23T21:59:59Z 60min", issueKey: "ACME-5" }] });
  });

  it("keeps values that look like placeholders or replacement patterns as they are", () => {
    expect(acme.timeLogs?.create.args([row({ comment: "cost $& and {taskId} and {{x}}" })], BRUSSELS)).toEqual({
      worklogs: [{ issueKey: "ACME-5", started: "2026-10-23T09:00:00+02:00", ended: "2026-10-23T10:00:00+02:00", comment: "cost $& and {taskId} and {{x}}" }],
    });
  });

  it("stops before anything is sent when a value the template needs is missing, saying which row lacks what", () => {
    expect(() => acme.timeLogs?.create.args([row(), row({ trackerTaskId: undefined })], BRUSSELS)).toThrow(
      "The Acme Tracker config's create arguments need taskId, which row 09:00–10:00 doesn't have.",
    );
    expect(() => acme.timeLogs?.update.args({ entryId: "", date: "2026-10-23", start: "09:00", end: "10:00", comment: "" }, BRUSSELS)).toThrow(
      "The Acme Tracker config's update arguments need entryId.",
    );
  });

  it("refuses an entry ID that doesn't fit, naming it, unless the text is only for display", () => {
    expect(() => acme.timeLogs?.delete.args(["101", "10 2"])).toThrow('"10 2" isn\'t a valid Acme Tracker time-log ID.');
    expect(() => acme.timeLogs?.delete.args(["0"])).toThrow('"0" isn\'t a valid');
    expect(acme.timeLogs?.delete.args(["{id}"], "display")).toEqual({ ids: ["{id}"] });
    const info = windowTrackerInfo(acme);
    expect(info?.timeLogTools).toEqual({ create: "add_worklogs", delete: "delete_worklogs", deleteArgs: 'ids: ["{id}"], confirm: true' });
  });
});

describe("routes", () => {
  it("derives an exact-name route for each tool the config reads with, and routes by the lower-cased bare name", () => {
    const route = (name: string) => matchRoutes(acme.timekeeper.routes, name);
    expect(route("list_my_issues")).toEqual([{ handler: "tasks" }]);
    expect(route("get_issues")).toEqual([{ handler: "tasks" }]);
    expect(route("list_worklogs")).toEqual([{ handler: "timeLogs", mode: "dateRange" }]);
    expect(route("list_worklogs_old")).toEqual([]);
    expect(route("add_worklogs")).toEqual([]);
  });

  it("puts the config's own routes first", () => {
    const routed = build((c) => (c.timekeeper.routes = [{ handler: "tasks", mode: "history", anyOf: ["issue_history"] }]));
    expect(matchRoutes(routed.timekeeper.routes, "get_issue_history")).toEqual([{ handler: "tasks", mode: "history" }]);
    expect(matchRoutes(routed.timekeeper.routes, "list_my_issues")).toEqual([{ handler: "tasks" }]);
  });
});
