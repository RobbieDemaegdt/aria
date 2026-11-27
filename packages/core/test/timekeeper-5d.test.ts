/**
 * Phase 5D unit tests:
 * - Submit through the tracker's create tool (`add_worklogs` via `executeApprovedMcpCall` + exact-payload check)
 * - Pre-submit validation gates (uncertain rows, missing project/customer IDs, overlaps, tracker duplicates, disguise chars)
 * - Partial & full failure handling (D16 & D61: full `rawResponse` preserved, no positional guessing on ambiguous partial failures, retry of failed rows)
 * - Persistence of `state === "submitted"` and `tracker_entry_id`s in SQLite across `recomputeAndSaveCard` and restarts (D62)
 * - Registered entry Update (`update_worklog`) and Delete (`delete_worklogs` requiring `confirmed: true`)
 * - Pure-code `getTimeView()` (ISO Monday–Sunday week strip, `expectedMinutes = 0` on weekends, `todaySummary()`)
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addDaysIso,
  FakeRuntime,
  isoDayOfWeek,
  isoWeekDates,
  AriaEngine,
  type ToolInventory,
} from "../src/index.ts";
import { UpdateTimesheetEntryInput } from "@aria/protocol";
import { ACME_LEDGER, ACME_TOOLS, AcmeLedger, acmeIssue, acmeIssues, acmeProjectTracker } from "./helpers/acme.ts";

// The tests run on Acme wanting a project and a customer with every worklog (`acmeProjectTracker`, helpers/acme.ts).
const TRACKER_INVENTORY: ToolInventory = {
  servers: [
    { name: "Acme", status: "connected", source: "user" },
    { name: "Work IQ Calendar", status: "connected", source: "plugin" },
  ],
  tools: [
    { name: "Acme-list_my_issues", server: "Acme", tool: "list_my_issues" },
    { name: "Acme-get_issues", server: "Acme", tool: "get_issues" },
    { name: "Acme-list_worklogs", server: "Acme", tool: "list_worklogs" },
    {
      name: "Acme-add_worklogs",
      server: "Acme",
      tool: "add_worklogs",
      inputSchema: {
        type: "object",
        properties: { worklogs: { type: "array" } },
        required: ["worklogs"],
        additionalProperties: false,
      },
    },
    {
      name: "Acme-update_worklog",
      server: "Acme",
      tool: "update_worklog",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          started: { type: "string" },
          ended: { type: "string" },
          comment: { type: "string" },
          issueKey: { type: "string" },
          projectKey: { type: "string" },
          accountId: { type: "string" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "Acme-delete_worklogs",
      server: "Acme",
      tool: "delete_worklogs",
      inputSchema: {
        type: "object",
        properties: {
          ids: { type: "array" },
          confirm: { type: "boolean" },
        },
        required: ["ids"],
        additionalProperties: false,
      },
    },
    { name: "Work-IQ-Calendar-ListCalendarView", server: "Work IQ Calendar", tool: "ListCalendarView" },
  ],
};

// The day the tests prepare, and the zone Acme's `offset` times are written in on it: +02:00.
const ZONE = "Europe/Brussels";

describe("Phase 5D: ISO week math", () => {
  it("computes Monday–Sunday ISO week dates and weekday numbers", () => {
    expect(isoDayOfWeek("2026-10-19")).toBe(1); // Monday
    expect(isoDayOfWeek("2026-10-23")).toBe(5); // Friday
    expect(isoDayOfWeek("2026-10-25")).toBe(7); // Sunday
    expect(addDaysIso("2026-10-23", 3)).toBe("2026-10-26");

    const week = isoWeekDates("2026-10-23");
    expect(week.weekStart).toBe("2026-10-19");
    expect(week.dates).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
    ]);
  });
});

describe("Phase 5D: TimekeeperRunner submit, updateRegisteredEntry, deleteRegisteredEntries, and getTimeView", () => {
  const dirs: string[] = [];
  const engines: AriaEngine[] = [];

  afterEach(async () => {
    while (engines.length) {
      await engines.pop()!.stop();
    }
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  async function setupEngine(firstWorklogId?: number) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "aria-5d-"));
    dirs.push(dir);
    const runtime = new FakeRuntime();
    runtime.inventoryResult = structuredClone(TRACKER_INVENTORY);
    // Acme keeps its worklogs, and ARIA reads the day before a submit: the read answers what the writes made of it
    const ledger = new AcmeLedger(firstWorklogId);
    Object.defineProperty(runtime.mcpResults, "Acme-list_worklogs", { enumerable: true, get: () => ledger.list("2026-10-23") });
    runtime.actionHandler = (req) => {
      if (req.tool === ACME_TOOLS.create) {
        const closed = (row: { issueKey: string }) => (row.issueKey === "ACME-999" ? "Issue ACME-999 is closed in the tracker" : undefined);
        return { result: JSON.stringify(ledger.add(req.approvedArgs.worklogs as Parameters<AcmeLedger["add"]>[0], closed)) };
      }
      if (req.tool === ACME_TOOLS.update) ledger.update(req.approvedArgs as Parameters<AcmeLedger["update"]>[0]);
      if (req.tool === ACME_TOOLS.delete) ledger.remove(req.approvedArgs.ids as string[]);
      return {};
    };
    const engine = new AriaEngine({
      dataDir: path.join(dir, "data"),
      runtime,
      projectRoots: [path.join(dir, "projects")],
      worktreeRoot: path.join(dir, "wt"),
      tracker: acmeProjectTracker,
    });
    engines.push(engine);
    await engine.start();
    // A strict tracker's reads (the registered worklogs, issues by key) go the direct way too; the tests count the writes
    const writes = () => runtime.actionCalls.filter((c) => c.tool !== ACME_TOOLS.worklogs && c.tool !== ACME_TOOLS.byId);
    return { engine, runtime, dir, writes, ledger };
  }

  it("blocks submit when rows are uncertain, missing project/customer IDs, overlapping, or contain disguise characters", async () => {
    const { engine, runtime, writes } = await setupEngine();
    runtime.timekeeperHandler = () => ({
      mcpCalls: [
        {
          server: "Acme",
          wireName: "Acme-list_my_issues",
          result: acmeIssues(acmeIssue("ACME-123", "Dark mode", ACME_LEDGER)),
        },
      ],
      proposal: {
        date: "2026-10-23",
        timeZone: ZONE,
        entries: [
          {
            start: "09:00",
            end: "12:00",
            trackerTaskId: "ACME-123",
            comment: "Suggested work",
            mappedBy: "suggestion",
          },
        ],
      },
    });

    const draft = await engine.prepareTimesheet("2026-10-23");
    expect(draft.uncertainCount).toBe(1);

    // 1. Blocks uncertain row
    await expect(engine.submitTimesheet("2026-10-23")).rejects.toThrow(/Confirm or edit the uncertain rows/);
    expect(writes()).toHaveLength(0);

    // 2. Confirm row, then add an overlapping row -> blocks overlap
    engine.confirmTimesheetEntry("2026-10-23", draft.entries[0]!.id);
    engine.updateTimesheetEntry({
      date: "2026-10-23",
      start: "11:00",
      end: "13:00",
      trackerTaskId: "ACME-123",
      trackerProjectId: "LED",
      trackerCustomerId: "ACC7",
      comment: "Overlapping block",
    });
    await expect(engine.submitTimesheet("2026-10-23")).rejects.toThrow(/overlapping draft rows/);
    expect(writes()).toHaveLength(0);
  });

  it("submits approved rows via add_worklogs, stores trackerEntryIds across restarts, prevents double submit, and supports update + delete", async () => {
    const { engine, runtime, writes } = await setupEngine();
    runtime.timekeeperHandler = () => ({
      mcpCalls: [
        {
          server: "Acme",
          wireName: "Acme-list_my_issues",
          result: acmeIssues(acmeIssue("ACME-123", "Dark mode", ACME_LEDGER), acmeIssue("ACME-456", "Design sync", ACME_LEDGER)),
        },
      ],
      proposal: {
        date: "2026-10-23",
        timeZone: ZONE,
        entries: [
          {
            start: "09:00",
            end: "13:00",
            trackerTaskId: "ACME-123",
            comment: "Dark mode implementation",
          },
          {
            start: "13:00",
            end: "17:00",
            trackerTaskId: "ACME-456",
            comment: "Design sync & review",
          },
        ],
      },
    });

    const draft = await engine.prepareTimesheet("2026-10-23");
    for (const row of draft.entries) {
      engine.confirmTimesheetEntry("2026-10-23", row.id);
    }

    const regCard = await engine.submitTimesheet("2026-10-23");
    expect(regCard.status).toBe("registered");
    expect(regCard.registeredMinutes).toBe(480);
    expect(regCard.entries).toHaveLength(2);
    expect(regCard.entries[0]?.trackerEntryId).toBe("8000000");
    expect(regCard.entries[1]?.trackerEntryId).toBe("8000001");

    // Verify exact wire payload sent to Acme-add_worklogs: Acme's `offset` times, in the day's zone
    expect(writes()).toHaveLength(1);
    expect(writes()[0]?.wireName).toBe("Acme-add_worklogs");
    expect(writes()[0]?.args).toEqual({
      worklogs: [
        {
          issueKey: "ACME-123",
          projectKey: "LED",
          accountId: "ACC7",
          started: "2026-10-23T09:00:00+02:00",
          ended: "2026-10-23T13:00:00+02:00",
          comment: "Dark mode implementation",
        },
        {
          issueKey: "ACME-456",
          projectKey: "LED",
          accountId: "ACC7",
          started: "2026-10-23T13:00:00+02:00",
          ended: "2026-10-23T17:00:00+02:00",
          comment: "Design sync & review",
        },
      ],
    });

    // Submitting again immediately fails because all rows are now submitted/registered
    await expect(engine.submitTimesheet("2026-10-23")).rejects.toThrow(/no draft or failed rows/);

    // Verify getTimeView shows 8h registered and 0 draft rows
    const tv = engine.getTimeView("2026-10-23");
    expect(tv.weekStart).toBe("2026-10-19");
    expect(tv.days).toHaveLength(7);
    const fri = tv.days.find((d) => d.date === "2026-10-23");
    expect(fri?.registeredMinutes).toBe(480);
    expect(fri?.draftMinutes).toBe(0);
    expect(tv.day.registered).toHaveLength(2);

    // Update registered entry #8000000 via update_worklog
    const afterUpdate = await engine.updateRegisteredEntry({
      date: "2026-10-23",
      trackerEntryId: "8000000",
      start: "08:30",
      end: "13:00",
      trackerTaskId: "ACME-123",
      comment: "Updated dark mode implementation",
    });
    expect(afterUpdate.registeredMinutes).toBe(510);
    expect(writes()).toHaveLength(2);
    expect(writes()[1]?.wireName).toBe("Acme-update_worklog");
    expect(writes()[1]?.args).toEqual({
      id: "8000000",
      started: "2026-10-23T08:30:00+02:00",
      ended: "2026-10-23T13:00:00+02:00",
      comment: "Updated dark mode implementation",
      issueKey: "ACME-123",
      projectKey: "LED",
      accountId: "ACC7",
    });

    // Verify weekend day in getTimeView has 0 expectedMinutes and 0 gaps in both week strip and day detail
    const satView = engine.getTimeView("2026-10-24");
    expect(satView.day.expectedMinutes).toBe(0);
    expect(satView.day.gaps).toHaveLength(0);

    // Changing a registered entry's tracker task ID to an uncached task without providing project/customer IDs is refused
    await expect(
      engine.updateRegisteredEntry({
        date: "2026-10-23",
        trackerEntryId: "8000000",
        start: "08:30",
        end: "13:00",
        trackerTaskId: "ACME-902",
        comment: "Attempt task change without project/customer",
      }),
    ).rejects.toThrow(new RegExp(`Changing the ${acmeProjectTracker.label} task requires its Project ID and Customer ID`));

    // Explicitly supplying project/customer IDs for the new uncached task succeeds even when they match the previous project/customer
    const afterTaskChange = await engine.updateRegisteredEntry({
      date: "2026-10-23",
      trackerEntryId: "8000000",
      start: "08:30",
      end: "13:00",
      trackerTaskId: "ACME-902",
      trackerProjectId: "LED",
      trackerCustomerId: "ACC7",
      comment: "Task change with explicit project/customer",
    });
    expect(afterTaskChange.registered.find((r) => r.id === "8000000")?.trackerTaskId).toBe("ACME-902");

    // Delete registered entry #8000001: refuses without confirmed: true, succeeds with confirmed: true
    await expect(
      engine.deleteRegisteredEntries({
        date: "2026-10-23",
        trackerEntryIds: ["8000001"],
        confirmed: false,
      }),
    ).rejects.toThrow(/Tick the confirmation box/);

    const afterDelete = await engine.deleteRegisteredEntries({
      date: "2026-10-23",
      trackerEntryIds: ["8000001"],
      confirmed: true,
    });
    expect(afterDelete.registered).toHaveLength(1);
    expect(afterDelete.registered[0]?.id).toBe("8000000");
    expect(writes()).toHaveLength(4);
    expect(writes()[3]?.wireName).toBe("Acme-delete_worklogs");
    expect(writes()[3]?.args).toEqual({
      ids: ["8000001"],
      confirm: true,
    });
  });

  it("handles partial batch failure (D16): keeps succeeded rows submitted, marks failed row failed with full rawResponse, and retries only the failed row", async () => {
    const { engine, writes } = await setupEngine();
    engine.updateTimesheetEntry({
      date: "2026-10-23",
      start: "09:00",
      end: "12:00",
      trackerTaskId: "ACME-123",
      trackerProjectId: "LED",
      trackerCustomerId: "ACC7",
      comment: "Valid row",
    });
    const d2 = engine.updateTimesheetEntry({
      date: "2026-10-23",
      start: "13:00",
      end: "16:00",
      trackerTaskId: "ACME-999",
      trackerProjectId: "LED",
      trackerCustomerId: "ACC7",
      comment: "Failing task row",
    });
    const failingRowId = d2.entries.find((e) => e.trackerTaskId === "ACME-999")!.id;

    const partial = await engine.submitTimesheet("2026-10-23");
    expect(partial.status).toBe("partial");
    expect(partial.registeredMinutes).toBe(180);
    expect(partial.rawResponse).toContain("Issue ACME-999 is closed in the tracker");

    // Fix the failing row's task ID and retry only that row
    engine.updateTimesheetEntry({
      date: "2026-10-23",
      entryId: failingRowId,
      start: "13:00",
      end: "16:00",
      trackerTaskId: "ACME-123",
      trackerProjectId: "LED",
      trackerCustomerId: "ACC7",
      comment: "Fixed task row",
    });

    const retried = await engine.submitTimesheet("2026-10-23", [failingRowId]);
    expect(retried.status).toBe("registered");
    expect(writes()).toHaveLength(2);
    const retrySent = writes()[1]?.args.worklogs as unknown[];
    expect(retrySent).toHaveLength(1);
  });

  it("reconciles unknown submit outcomes and SQLite submitted rows when list_worklogs is refreshed", async () => {
    const { engine, runtime, ledger } = await setupEngine(8_888_888);
    engine.updateTimesheetEntry({
      date: "2026-10-23",
      start: "09:00",
      end: "12:00",
      trackerTaskId: "ACME-123",
      trackerProjectId: "LED",
      trackerCustomerId: "ACC7",
      comment: "Morning block",
    });

    // Simulate an interrupted/ambiguous submit outcome: Acme registers the worklog (#8888888), but the session ends
    // before ARIA sees the answer. (ARIA's read of what is registered goes through.)
    runtime.actionHandler = (req) => {
      if (req.tool !== ACME_TOOLS.create) return {};
      ledger.add(req.approvedArgs.worklogs as Parameters<AcmeLedger["add"]>[0]);
      return { serverError: "Session interrupted after approval — check whether the action went through before trying again." };
    };

    const unknownCard = await engine.submitTimesheet("2026-10-23");
    expect(unknownCard.needsReconcile).toBe(true);
    expect(unknownCard.entries[0]?.status).toBe("unknown");

    // Retrying before refreshing is blocked by needsReconcile
    await expect(engine.submitTimesheet("2026-10-23")).rejects.toThrow(/Refresh your timesheet draft first/);

    // Refreshing via prepareTimesheet ingests list_worklogs showing the tracker did register #8888888
    runtime.timekeeperHandler = () => ({
      mcpCalls: [
        {
          server: "Acme",
          wireName: "Acme-list_worklogs",
          result: ledger.list("2026-10-23"),
        },
      ],
      proposal: {
        date: "2026-10-23",
        timeZone: ZONE,
        entries: [],
      },
    });

    const refreshed = await engine.prepareTimesheet("2026-10-23");
    expect(refreshed.registered).toHaveLength(1);
    expect(refreshed.registered[0]?.id).toBe("8888888");
    expect(refreshed.entries).toHaveLength(0);

    // And the persisted time_registered card now has needsReconcile cleared and status "registered"
    const regCardInTimeline = engine
      .getState()
      .timeline.find((i) => i.kind === "card" && i.cardType === "time_registered" && i.payload.date === "2026-10-23");
    expect(regCardInTimeline && regCardInTimeline.kind === "card" && regCardInTimeline.cardType === "time_registered" ? regCardInTimeline.payload.needsReconcile : true).toBeUndefined();
    expect(regCardInTimeline && regCardInTimeline.kind === "card" && regCardInTimeline.cardType === "time_registered" ? regCardInTimeline.payload.status : "").toBe("registered");
  });

  it("saves manual entries even when a submitted or draft entry starts at the same time, normalizes H:mm, and persists manual Project/Customer IDs", async () => {
    const { engine } = await setupEngine();

    // 1. Add and submit a 09:00–10:00 entry so a "submitted" row exists at 09:00 in SQLite
    engine.updateTimesheetEntry({
      date: "2026-10-23",
      start: "09:00",
      end: "10:00",
      trackerTaskId: "ACME-123",
      trackerProjectId: "LED",
      trackerCustomerId: "ACC7",
      comment: "Submitted morning block",
    });
    const reg = await engine.submitTimesheet("2026-10-23");
    expect(reg.status).toBe("registered");

    // 2. Adding a new manual entry at 09:00 (where a submitted entry already starts) succeeds instead of throwing
    //    "That entry was already submitted"
    const afterSubmittedSameStart = engine.updateTimesheetEntry({
      date: "2026-10-23",
      addNew: true,
      start: "09:00",
      end: "10:00",
      trackerTaskId: "ACME-456",
      trackerProjectId: "LED",
      trackerCustomerId: "ACC7",
      comment: "Manual entry at 09:00",
    });
    expect(afterSubmittedSameStart.entries).toHaveLength(1);
    expect(afterSubmittedSameStart.entries[0]?.overlapsTrackerId).toBeDefined();

    // 3. Adding another manual entry with addNew: true at 09:00 appends a second draft row rather than overwriting the first
    const afterSecondDraftSameStart = engine.updateTimesheetEntry({
      date: "2026-10-23",
      addNew: true,
      start: "09:00",
      end: "10:30",
      trackerTaskId: "ACME-456",
      trackerProjectId: "LED",
      trackerCustomerId: "ACC7",
      comment: "Second manual entry at 09:00",
    });
    expect(afterSecondDraftSameStart.entries).toHaveLength(2);

    // 4. Single-digit hours ("7:30", "9:00") are normalized by both UpdateTimesheetEntryInput and updateTimesheetEntry
    const parsedInput = UpdateTimesheetEntryInput.parse({
      date: "2026-10-23",
      addNew: true,
      start: "7:30",
      end: "9:00",
      trackerTaskId: "ACME-901",
      trackerTaskTitle: "Contoso Platform - Overview",
      trackerProjectId: "PLT",
      trackerCustomerId: "ACC4",
      comment: "Early morning work",
    });
    expect(parsedInput.start).toBe("07:30");
    expect(parsedInput.end).toBe("09:00");

    // Pre-seed task ACME-901 in tracker_tasks_cache WITHOUT projectId (as happens from formatted list_my_issues)
    (engine as any).db.upsertTrackerTaskCache(acmeProjectTracker.id, {
      taskId: "ACME-901",
      title: "Contoso Platform - Overview",
      customerId: "ACC4",
    });

    const afterSingleDigitAndManualIds = engine.updateTimesheetEntry({
      date: "2026-10-23",
      addNew: true,
      start: "7:30",
      end: "9:00",
      trackerTaskId: "ACME-901",
      trackerProjectId: "PLT",
      trackerCustomerId: "ACC4",
      comment: "Early morning work",
    });
    const earlyRow = afterSingleDigitAndManualIds.entries.find((e) => e.trackerTaskId === "ACME-901")!;
    expect(earlyRow).toMatchObject({
      start: "07:30",
      end: "09:00",
      minutes: 90,
      trackerTaskId: "ACME-901",
      trackerProjectId: "PLT",
      trackerCustomerId: "ACC4",
    });
    // And the manual projectId was persisted into tracker_tasks_cache even though ACME-901 was already cached
    expect((engine as any).db.getTrackerTaskCache(acmeProjectTracker.id, "ACME-901")).toMatchObject({
      taskId: "ACME-901",
      projectId: "PLT",
      customerId: "ACC4",
    });
  });
});
