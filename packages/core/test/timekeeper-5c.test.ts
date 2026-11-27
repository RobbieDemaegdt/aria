/**
 * Phase 5C unit tests:
 * - Time-zone conversion (`normalizeTimeZone`, `parseDateTimeInZone` across Windows time zone names and DST
 *   transitions, `epochToLocalWallTime`, `toLocalDateTime`),
 * - Calendar event filtering (`isEligibleCalendarEvent`),
 * - Boundary-aware rounding (`checkTimesheetEntries`), overlap detection, tracker duplicate detection, working-hour
 *   gaps, and task → project/customer resolution from `tracker_tasks_cache`,
 * - `timekeeperScope` and `TimekeeperPolicy` (§4.13: the tracker's read tools except `api_get`, Work IQ Calendar & Teams read
 *   tools, excluding `Work IQ Mail` and write tools),
 * - `TimekeeperRunner` and `AriaEngine`: `prepareTimesheet`, preserving `mappedBy: "you"` on re-preparation, inline
 *   and conversational edits (`updateTimesheetEntry`), confirming uncertain rows, and the "Always map X to task Y?"
 *   learning offer.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkTimesheetEntries,
  epochToLocalWallTime,
  FakeRuntime,
  isEligibleCalendarEvent,
  AriaEngine,
  normalizeTimeZone,
  parseDateTimeInZone,
  TimekeeperPolicy,
  timekeeperScope,
  toLocalDateTime,
} from "../src/index.ts";
import type { TrackerTaskCacheEntry } from "@aria/protocol";
import { EMPTY_CATALOG, mergeCatalog } from "../src/integrations/rules.ts";
import type { ServerEntry, ToolEntry } from "../src/integrations/scope.ts";
import { ACME_LEDGER, acmeIssue, acmeIssues, acmeTracker } from "./helpers/acme.ts";
import "./no-network.ts";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aria-5c-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("Time-zone math, DST transitions, and calendar filtering (checks.ts)", () => {
  it("maps Windows time zone names to IANA and parses Graph offset-less dateTime strings across DST transitions", () => {
    expect(normalizeTimeZone("Romance Standard Time")).toBe("Europe/Brussels");
    expect(normalizeTimeZone("W. Europe Standard Time")).toBe("Europe/Berlin");
    expect(normalizeTimeZone("UTC")).toBe("UTC");

    // 2026-10-23 is in CEST (UTC+2) in Europe/Brussels: 09:00 local = 07:00 UTC
    const cestMs = parseDateTimeInZone("2026-10-23T09:00:00.0000000", "Romance Standard Time")!;
    expect(new Date(cestMs).toISOString()).toBe("2026-10-23T07:00:00.000Z");
    expect(epochToLocalWallTime(cestMs, "Romance Standard Time")).toEqual({
      date: "2026-10-23",
      minutes: 9 * 60,
      hhmm: "09:00",
    });

    // 2026-10-26 is in CET (UTC+1, after Oct 25 DST fall-back) in Europe/Brussels: 09:00 local = 08:00 UTC
    const cetMs = parseDateTimeInZone("2026-10-26T09:00:00.0000000", "Romance Standard Time")!;
    expect(new Date(cetMs).toISOString()).toBe("2026-10-26T08:00:00.000Z");
    expect(epochToLocalWallTime(cetMs, "Europe/Brussels")).toEqual({
      date: "2026-10-26",
      minutes: 9 * 60,
      hhmm: "09:00",
    });

    expect(toLocalDateTime("2026-10-23", "09:15")).toBe("2026-10-23T09:15:00");
  });

  it("filters out cancelled, all-day, declined, and free/tentative/workingElsewhere/oof calendar events", () => {
    expect(isEligibleCalendarEvent({ showAs: "busy", responseStatus: { response: "accepted" } })).toBe(true);
    expect(isEligibleCalendarEvent({ isCancelled: true })).toBe(false);
    expect(isEligibleCalendarEvent({ isAllDay: true })).toBe(false);
    expect(isEligibleCalendarEvent({ responseStatus: { response: "declined" } })).toBe(false);
    expect(isEligibleCalendarEvent({ showAs: "free" })).toBe(false);
    expect(isEligibleCalendarEvent({ showAs: "tentative" })).toBe(false);
    expect(isEligibleCalendarEvent({ showAs: "workingElsewhere" })).toBe(false);
    expect(isEligibleCalendarEvent({ showAs: "oof" })).toBe(false);
  });
});

describe("Boundary-aware rounding, overlaps, tracker duplicates, and gaps (checkTimesheetEntries)", () => {
  it("snaps contiguous boundaries together, resolves project/customer from cache, and detects overlaps, duplicates, and gaps", () => {
    const taskCache = new Map([
      [
        "ACME-123",
        {
          taskId: "ACME-123",
          title: "Dark mode toggle",
          projectId: "LED",
          customerId: "ACC7",
          lastSeen: {},
          fetchedAt: 1000,
        },
      ],
      [
        "ACME-101",
        {
          taskId: "ACME-101",
          title: "Squad meetings",
          projectId: "LED",
          customerId: "ACC7",
          lastSeen: {},
          fetchedAt: 1000,
        },
      ],
    ]);

    // Contiguous blocks 09:00–09:23 and 09:23–11:00 snap cleanly at 09:30 without overlap or phantom gap
    const result = checkTimesheetEntries({
      tracker: acmeTracker,
      date: "2026-10-23",
      rawEntries: [
        {
          start: "09:00",
          end: "09:23",
          trackerTaskId: "ACME-101",
          trackerProjectId: "OLD", // Model guessed wrong project ID -> cache overrides with LED
          comment: "Daily Standup",
          mappedBy: "suggestion",
          sources: [{ source: "calendar", title: "Daily Standup" }],
        },
        {
          start: "09:23",
          end: "11:00",
          comment: "Dark mode work",
          mappedBy: "suggestion",
          // Source has an explicit branch link -> plain code upgrades mappedBy to "link" and task to ACME-123
          sources: [{ source: "git", branch: "aria/ACME-123-dark-mode", title: "Commit" }],
        },
      ],
      registered: [
        {
          id: "88001",
          start: "11:00",
          end: "12:00",
          minutes: 60,
          trackerTaskId: "ACME-123",
          comment: "Already logged",
        },
      ],
      rules: [],
      taskCache,
      roundingMinutes: 15,
      expectedMinutes: 480,
      workStart: "09:00",
      workEnd: "17:00",
    });

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({
      start: "09:00",
      end: "09:30",
      minutes: 30,
      trackerTaskId: "ACME-101",
      trackerProjectId: "LED",
      trackerCustomerId: "ACC7",
      mappedBy: "suggestion",
      confidence: "uncertain",
    });
    expect(result.entries[1]).toMatchObject({
      start: "09:30",
      end: "11:00",
      minutes: 90,
      trackerTaskId: "ACME-123",
      trackerProjectId: "LED",
      trackerCustomerId: "ACC7",
      mappedBy: "link",
      confidence: "certain",
    });
    expect(result.overlapCount).toBe(0);
    expect(result.draftMinutes).toBe(120);
    expect(result.registeredMinutes).toBe(60);
    expect(result.dayTotalMinutes).toBe(180);
    // Uncovered gap from 12:00 to 17:00
    expect(result.gaps).toEqual([{ start: "12:00", end: "17:00", minutes: 300 }]);
  });

  it("populates detailed overlap metadata for draft-draft, draft-registered, and registered-registered collisions", () => {
    const taskCache = new Map<string, TrackerTaskCacheEntry>([
      ["ACME-101", { taskId: "ACME-101", title: "Daily Standup", projectId: "LED", customerId: "ACC7", lastSeen: {}, fetchedAt: 1000 }],
      ["ACME-123", { taskId: "ACME-123", title: "Dark mode", projectId: "LED", customerId: "ACC7", lastSeen: {}, fetchedAt: 1000 }],
    ]);

    const result = checkTimesheetEntries({
      tracker: acmeTracker,
      date: "2026-10-23",
      rawEntries: [
        {
          id: "draft-1",
          start: "09:00",
          end: "10:30",
          trackerTaskId: "ACME-101",
          comment: "Standup and sync",
          mappedBy: "you",
        },
        {
          id: "draft-2",
          start: "10:00",
          end: "11:30",
          trackerTaskId: "ACME-123",
          comment: "Feature coding",
          mappedBy: "you",
        },
      ],
      registered: [
        {
          id: "reg-1",
          start: "11:00",
          end: "12:00",
          minutes: 60,
          trackerTaskId: "ACME-123",
          comment: "Earlier log",
        },
        {
          id: "reg-2",
          start: "11:45",
          end: "12:45",
          minutes: 60,
          trackerTaskId: "ACME-101",
          comment: "Overlapping registered log",
        },
      ],
      rules: [],
      taskCache,
      roundingMinutes: 15,
      expectedMinutes: 480,
      workStart: "09:00",
      workEnd: "17:00",
    });

    expect(result.overlapCount).toBe(2);

    // draft-1 overlaps draft-2 by 30 mins (10:00-10:30)
    const d1 = result.entries.find((e) => e.id === "draft-1")!;
    expect(d1.overlap).toBe(true);
    expect(d1.overlapDetails).toEqual([
      {
        targetId: "draft-2",
        targetType: "draft",
        targetStart: "10:00",
        targetEnd: "11:30",
        targetLabel: "Feature coding",
        overlapStart: "10:00",
        overlapEnd: "10:30",
        overlapMinutes: 30,
      },
    ]);

    // draft-2 overlaps draft-1 (10:00-10:30) and registered reg-1 (11:00-11:30)
    const d2 = result.entries.find((e) => e.id === "draft-2")!;
    expect(d2.overlap).toBe(true);
    expect(d2.overlapsTrackerId).toBe("reg-1");
    expect(d2.overlapDetails).toHaveLength(2);
    expect(d2.overlapDetails![0]).toMatchObject({
      targetId: "draft-1",
      targetType: "draft",
      overlapStart: "10:00",
      overlapEnd: "10:30",
      overlapMinutes: 30,
    });
    expect(d2.overlapDetails![1]).toMatchObject({
      targetId: "reg-1",
      targetType: "tracker",
      overlapStart: "11:00",
      overlapEnd: "11:30",
      overlapMinutes: 30,
    });

    // Registered reg-1 overlaps draft-2 (11:00-11:30) and reg-2 (11:45-12:00)
    const r1 = result.registered.find((r) => r.id === "reg-1")!;
    expect(r1.overlap).toBe(true);
    expect(r1.overlapDetails).toHaveLength(2);
    expect(r1.overlapDetails![0]).toMatchObject({
      targetId: "draft-2",
      targetType: "draft",
      overlapStart: "11:00",
      overlapEnd: "11:30",
      overlapMinutes: 30,
    });
    expect(r1.overlapDetails![1]).toMatchObject({
      targetId: "reg-2",
      targetType: "tracker",
      overlapStart: "11:45",
      overlapEnd: "12:00",
      overlapMinutes: 15,
    });

    // Registered reg-2 overlaps reg-1 (11:45-12:00)
    const r2 = result.registered.find((r) => r.id === "reg-2")!;
    expect(r2.overlap).toBe(true);
    expect(r2.overlapDetails).toHaveLength(1);
    expect(r2.overlapDetails![0]).toMatchObject({
      targetId: "reg-1",
      targetType: "tracker",
      overlapStart: "11:45",
      overlapEnd: "12:00",
      overlapMinutes: 15,
    });
  });
});

describe("Timekeeper scope and policy (scope.ts)", () => {
  it("allows only the tracker's read tools (except api_get) and Work IQ Calendar/Teams/Mail read tools (excluding Mail write tools and workiq plugin tools)", () => {
    const servers: ServerEntry[] = [
      { name: "Acme", status: "connected", source: "user", url: "https://tracker.example/mcp" },
      { name: "AcmeApi", status: "connected", source: "user", url: "https://tracker.example/mcp" },
      { name: "Work IQ Calendar", status: "connected", source: "plugin", sourcePlugin: "workiq" },
      { name: "Work IQ Teams", status: "connected", source: "plugin", sourcePlugin: "workiq" },
      { name: "Work IQ Mail", status: "connected", source: "plugin", sourcePlugin: "workiq" },
      { name: "workiq", status: "connected", source: "plugin", sourcePlugin: "workiq" },
    ];
    const tools: ToolEntry[] = [
      { name: "Acme-list_my_issues", server: "Acme", tool: "list_my_issues" },
      { name: "Acme-list_worklogs", server: "Acme", tool: "list_worklogs" },
      { name: "Acme-add_worklogs", server: "Acme", tool: "add_worklogs" },
      { name: "Acme-api_get", server: "Acme", tool: "api_get" },
      { name: "AcmeApi-list_my_issues", server: "AcmeApi", tool: "list_my_issues" },
      { name: "Work-IQ-Calendar-GetUserDateAndTimeZoneSettings", server: "Work IQ Calendar", tool: "GetUserDateAndTimeZoneSettings" },
      { name: "Work-IQ-Calendar-ListCalendarView", server: "Work IQ Calendar", tool: "ListCalendarView" },
      { name: "Work-IQ-Calendar-AcceptEvent", server: "Work IQ Calendar", tool: "AcceptEvent" },
      { name: "Work-IQ-Teams-ListChats", server: "Work IQ Teams", tool: "ListChats" },
      { name: "Work-IQ-Mail-SearchMessages", server: "Work IQ Mail", tool: "SearchMessages" },
      { name: "Work-IQ-Mail-SendDraftMessage", server: "Work IQ Mail", tool: "SendDraftMessage" },
      { name: "workiq-ask", server: "workiq", tool: "ask" },
    ];

    const catalog = mergeCatalog(EMPTY_CATALOG, { servers, tools }, 100);
    const scope = timekeeperScope(acmeTracker, catalog, []);

    expect(scope.availableTools).toEqual([
      "custom:*",
      "mcp:Acme-list_my_issues",
      "mcp:Acme-list_worklogs",
      "mcp:Work-IQ-Calendar-GetUserDateAndTimeZoneSettings",
      "mcp:Work-IQ-Calendar-ListCalendarView",
      "mcp:Work-IQ-Teams-ListChats",
      "mcp:Work-IQ-Mail-SearchMessages",
    ]);
    expect(scope.disabledMcpServers).toEqual(["AcmeApi", "workiq"]);

    const policy = new TimekeeperPolicy(scope.readTools);
    expect(policy.decide({ kind: "custom-tool", tool: "propose_timesheet" }).approve).toBe(true);
    expect(policy.decide({ kind: "custom-tool", tool: "other_tool" }).approve).toBe(false);
    expect(policy.decide({ kind: "mcp", server: "Acme", tool: "Acme-list_my_issues", args: {} }).approve).toBe(true);
    expect(policy.decide({ kind: "mcp", server: "Acme", tool: "Acme-api_get", args: {} }).approve).toBe(false);
    expect(policy.decide({ kind: "mcp", server: "Acme", tool: "Acme-add_worklogs", args: {} }).approve).toBe(false);
    expect(policy.decide({ kind: "mcp", server: "Work IQ Mail", tool: "Work-IQ-Mail-SearchMessages", args: {} }).approve).toBe(true);
    expect(policy.decide({ kind: "mcp", server: "Work IQ Mail", tool: "Work-IQ-Mail-SendDraftMessage", args: {} }).approve).toBe(false);
    expect(policy.decide({ kind: "shell", command: "ls", segments: ["ls"], possiblePaths: [], possibleUrls: [] }).approve).toBe(false);
  });
});

describe("TimekeeperRunner and AriaEngine end-to-end", () => {
  it("prepares a timesheet draft, preserves user edits on re-prepare, and generates/saves a learning rule offer", async () => {
    const dataDir = makeTempDir();
    const runtime = new FakeRuntime();
    runtime.inventoryResult = {
      servers: [
        { name: "Acme", status: "connected", source: "user", url: "https://tracker.example/mcp" },
        { name: "Work IQ Calendar", status: "connected", source: "plugin", sourcePlugin: "workiq" },
      ],
      tools: [
        { name: "Acme-list_my_issues", server: "Acme", tool: "list_my_issues" },
        { name: "Work-IQ-Calendar-ListCalendarView", server: "Work IQ Calendar", tool: "ListCalendarView" },
      ],
    };

    runtime.timekeeperHandler = () => ({
      mcpCalls: [
        {
          server: "Acme",
          wireName: "Acme-list_my_issues",
          result: acmeIssues(
            acmeIssue("ACME-123", "Dark mode toggle", ACME_LEDGER),
            acmeIssue("ACME-456", "Design sync", ACME_LEDGER),
            acmeIssue("ACME-101", "Squad meetings", ACME_LEDGER),
          ),
        },
        {
          server: "Work IQ Calendar",
          wireName: "Work-IQ-Calendar-ListCalendarView",
          result: {
            value: [
              {
                id: "ev-1",
                subject: "Architecture Review",
                start: { dateTime: "2026-10-23T09:00:00.0000000", timeZone: "Europe/Brussels" },
                end: { dateTime: "2026-10-23T10:00:00.0000000", timeZone: "Europe/Brussels" },
                showAs: "busy",
                responseStatus: { response: "accepted" },
              },
              {
                id: "ev-cancelled",
                subject: "Cancelled sync",
                isCancelled: true,
                start: { dateTime: "2026-10-23T11:00:00.0000000", timeZone: "Europe/Brussels" },
                end: { dateTime: "2026-10-23T12:00:00.0000000", timeZone: "Europe/Brussels" },
              },
            ],
          },
        },
      ],
          proposal: {
        date: "2026-10-23",
        timeZone: "Europe/Brussels",
        entries: [
          {
            start: "09:00",
            end: "10:00",
            trackerTaskId: "ACME-123",
            comment: "Architecture Review",
            mappedBy: "suggestion",
            sources: [{ source: "calendar", title: "Architecture Review" }],
          },
          {
            // Model tries to include the cancelled event -> plain code filters it out!
            start: "11:00",
            end: "12:00",
            trackerTaskId: "ACME-101",
            comment: "Cancelled sync",
            mappedBy: "suggestion",
            sources: [{ source: "calendar", title: "Cancelled sync" }],
          },
          {
            start: "10:00",
            end: "17:00",
            trackerTaskId: "ACME-123",
            comment: "Dark mode toggle, PR #37",
            mappedBy: "link",
            sources: [{ source: "git", repoName: "Moonrise", branch: "aria/ACME-123-dark-mode", title: "Add dark mode (task ACME-123)" }],
          },
        ],
      },
    });

    const engine = new AriaEngine({ dataDir, runtime, projectRoots: [], tracker: acmeTracker });
    await engine.start();
    try {
      // Seed a real git commit activity on 2026-10-23 for Moonrise so the 10:00–17:00 block is backed by a stored activity
      const commitAt = parseDateTimeInZone("2026-10-23T11:30:00", "Europe/Brussels")!;
      (engine as any).db.upsertActivity({
        source: "git",
        kind: "commit",
        startedAt: commitAt,
        endedAt: commitAt + 60 * 60_000,
        externalId: "commit:abc1234",
        title: "Add dark mode (task ACME-123)",
        linkedTrackerTaskId: "ACME-123",
        metadata: { repoName: "Moonrise", branch: "aria/ACME-123-dark-mode" },
      });

      // Configure Timekeeper settings
      const settings = engine.setTimekeeperSettings({
        model: "fake-strong",
        reasoningEffort: "medium",
        expectedMinutes: 480,
        roundingMinutes: 15,
      });
      expect(settings).toMatchObject({ model: "fake-strong", reasoningEffort: "medium", expectedMinutes: 480 });

      // Prepare timesheet for 2026-10-23 (the cancelled 11:00–12:00 meeting is filtered out!)
      const draft = await engine.prepareTimesheet("2026-10-23");
      expect(runtime.timekeeperCalls).toHaveLength(1);
      expect(runtime.timekeeperCalls[0]?.model).toBe("fake-strong");
      expect(draft.entries).toHaveLength(2);
      expect(draft.entries.map((e) => e.comment)).not.toContain("Cancelled sync");
      expect(draft.draftMinutes).toBe(480);
      expect(draft.uncertainCount).toBe(1); // The 09:00–10:00 suggestion row is uncertain

      const meetingRow = draft.entries[0]!;
      expect(meetingRow).toMatchObject({
        start: "09:00",
        end: "10:00",
        trackerTaskId: "ACME-123",
        trackerProjectId: "LED",
        trackerCustomerId: "ACC7",
        mappedBy: "suggestion",
        confidence: "uncertain",
      });

      // Updating comment only (without trackerTaskId) preserves the existing trackerTaskId; wrong date entryId is rejected
      expect(() =>
        engine.updateTimesheetEntry({
          date: "2026-10-24",
          entryId: meetingRow.id,
          start: "09:00",
          end: "10:00",
          comment: "Wrong date",
        }),
      ).toThrow(/doesn't exist on this date/);

      const commentOnly = engine.updateTimesheetEntry({
        date: "2026-10-23",
        entryId: meetingRow.id,
        start: "09:00",
        end: "10:00",
        comment: "Architecture Review (updated)",
      });
      expect(commentOnly.entries[0]?.trackerTaskId).toBe("ACME-123");

      // User corrects the meeting row's task from ACME-123 to ACME-101 ("Squad meetings")
      const afterEdit = engine.updateTimesheetEntry({
        date: "2026-10-23",
        entryId: meetingRow.id,
        start: "09:00",
        end: "10:00",
        trackerTaskId: "ACME-101",
        comment: "Architecture Review",
      });
      expect(afterEdit.uncertainCount).toBe(0);
      expect(afterEdit.entries[0]).toMatchObject({
        trackerTaskId: "ACME-101",
        trackerTaskTitle: "Squad meetings",
        mappedBy: "you",
        confidence: "certain",
      });
      // A learning offer is generated for "Architecture Review" -> ACME-101!
      expect(afterEdit.ruleOffers).toHaveLength(1);
      expect(afterEdit.ruleOffers[0]).toMatchObject({
        kind: "meeting_title",
        pattern: "Architecture Review",
        trackerTaskId: "ACME-101",
      });

      // Accept the learning offer -> saves a TimeRule
      const afterAccept = engine.acceptTimesheetRuleOffer("2026-10-23", afterEdit.ruleOffers[0]!.id);
      expect(afterAccept.ruleOffers).toHaveLength(0);
      expect(engine.listTimeRules()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            match: { kind: "meeting_title", pattern: "Architecture Review", matchMode: "contains" },
            trackerTaskId: "ACME-101",
            createdFrom: "correction",
          }),
        ]),
      );

      // Re-prepare the same day -> preserves the user-edited 09:00–10:00 row!
      const reprepared = await engine.prepareTimesheet("2026-10-23");
      expect(reprepared.entries[0]).toMatchObject({
        id: meetingRow.id,
        trackerTaskId: "ACME-101",
        mappedBy: "you",
        confidence: "certain",
      });
    } finally {
      await engine.stop();
    }
  });

  it("ingests sent emails and tracker task updates, consolidates per-task buckets rounded to ±15m, and shifts slots on ±15m duration steps without overlap", async () => {
    const dataDir = makeTempDir();
    const runtime = new FakeRuntime();
    runtime.inventoryResult = {
      servers: [
        { name: "Acme", status: "connected", source: "user", url: "https://tracker.example/mcp" },
        { name: "Work IQ Calendar", status: "connected", source: "plugin", sourcePlugin: "workiq" },
        { name: "Work IQ Mail", status: "connected", source: "plugin", sourcePlugin: "workiq" },
      ],
      tools: [
        { name: "Acme-list_my_issues", server: "Acme", tool: "list_my_issues" },
        { name: "Work-IQ-Calendar-ListCalendarView", server: "Work IQ Calendar", tool: "ListCalendarView" },
        { name: "Work-IQ-Mail-SearchMessages", server: "Work IQ Mail", tool: "SearchMessages" },
      ],
    };

    runtime.timekeeperHandler = () => ({
      mcpCalls: [
        {
          server: "Acme",
          wireName: "Acme-list_my_issues",
          result: acmeIssues(
            acmeIssue("ACME-123", "Dark mode toggle", { ...ACME_LEDGER, status: "In Progress", updated: "2026-10-23T14:20:00Z" }),
            acmeIssue("ACME-456", "Design sync", { ...ACME_LEDGER, status: "In Progress" }),
          ),
        },
        {
          server: "Work IQ Mail",
          wireName: "Work-IQ-Mail-SearchMessages",
          result: {
            value: [
              {
                id: "msg-1",
                subject: "Re: Dark mode toggle (task ACME-123)",
                sentDateTime: "2026-10-23T13:10:00Z",
                toRecipients: [{ emailAddress: { name: "Alice", address: "alice@example.com" } }],
                bodyPreview: "Here is the update for task ACME-123.",
              },
            ],
          },
        },
      ],
      // Omit model proposal so deterministic draft builder (buildDeterministicDraft) runs on collected activities
    });

    const engine = new AriaEngine({ dataDir, runtime, projectRoots: [], tracker: acmeTracker });
    await engine.start();
    try {
      engine.setTimekeeperSettings({
        model: "fake-strong",
        expectedMinutes: 480,
        roundingMinutes: 15,
      });

      // Seed morning and afternoon commits on task ACME-123 (previously would have created separate fragmented rows)
      const morningMs = parseDateTimeInZone("2026-10-23T09:30:00", "Europe/Brussels")!;
      const afternoonMs = parseDateTimeInZone("2026-10-23T15:30:00", "Europe/Brussels")!;
      (engine as any).db.upsertActivity({
        source: "git",
        kind: "commit",
        startedAt: morningMs,
        endedAt: morningMs,
        externalId: "commit:1111111",
        title: "Morning dark mode work (task ACME-123)",
        linkedTrackerTaskId: "ACME-123",
        metadata: { repoName: "Moonrise", branch: "aria/ACME-123-dark-mode" },
      });
      (engine as any).db.upsertActivity({
        source: "git",
        kind: "commit",
        startedAt: afternoonMs,
        endedAt: afternoonMs,
        externalId: "commit:2222222",
        title: "Afternoon dark mode work (task ACME-123)",
        linkedTrackerTaskId: "ACME-123",
        metadata: { repoName: "Moonrise", branch: "aria/ACME-123-dark-mode" },
      });

      const draft = await engine.prepareTimesheet("2026-10-23");
      const tv = engine.getTimeView("2026-10-23");

      // Both sent email and tracker update were recorded as activities on 2026-10-23
      expect(tv.activities.some((a) => a.source === "mail" && a.linkedTrackerTaskId === "ACME-123")).toBe(true);
      expect(tv.activities.some((a) => a.source === "tracker" && a.linkedTrackerTaskId === "ACME-123")).toBe(true);

      // All work on task ACME-123 (morning commit, sent email, tracker update, afternoon commit) is consolidated into ONE task bucket!
      const acme123Rows = draft.entries.filter((e) => e.trackerTaskId === "ACME-123");
      expect(acme123Rows).toHaveLength(1);
      expect(acme123Rows[0]!.minutes % 15).toBe(0);
      expect(acme123Rows[0]!.sources.map((s) => s.source)).toEqual(
        expect.arrayContaining(["git", "mail", "tracker"]),
      );

      // Add a second task using duration-only (`minutes: 45`) and then step the first row by +15m -> no overlap!
      const withSecond = engine.updateTimesheetEntry({
        date: "2026-10-23",
        minutes: 45,
        trackerTaskId: "ACME-456",
        comment: "Design sync",
      });
      expect(withSecond.entries).toHaveLength(2);
      expect(withSecond.overlapCount).toBe(0);

      const firstId = withSecond.entries[0]!.id;
      const firstMin = withSecond.entries[0]!.minutes;
      const afterStep = engine.updateTimesheetEntry({
        date: "2026-10-23",
        entryId: firstId,
        minutes: firstMin + 15,
        comment: withSecond.entries[0]!.comment,
      });
      expect(afterStep.entries.find((e) => e.id === firstId)?.minutes).toBe(firstMin + 15);
      expect(afterStep.overlapCount).toBe(0);

      // Duplicate the second entry into the next free time slot -> creates a 3rd non-overlapping row for the same work
      const secondRow = afterStep.entries.find((e) => e.trackerTaskId === "ACME-456")!;
      const afterDuplicate = engine.updateTimesheetEntry({
        date: "2026-10-23",
        minutes: secondRow.minutes,
        trackerTaskId: secondRow.trackerTaskId!,
        ...(secondRow.trackerTaskTitle ? { trackerTaskTitle: secondRow.trackerTaskTitle } : {}),
        ...(secondRow.trackerProjectId ? { trackerProjectId: secondRow.trackerProjectId } : {}),
        ...(secondRow.trackerCustomerId ? { trackerCustomerId: secondRow.trackerCustomerId } : {}),
        comment: secondRow.comment,
      });
      expect(afterDuplicate.entries).toHaveLength(3);
      expect(afterDuplicate.overlapCount).toBe(0);
      expect(afterDuplicate.entries.filter((e) => e.trackerTaskId === "ACME-456" && e.comment === "Design sync")).toHaveLength(2);

      // Add a row with only an uncached tracker task ID (no projectId/customerId) and resolve via Acme's get_issues
      // (including $id / $ref back-references)
      runtime.mcpResults["Acme-get_issues"] = JSON.stringify({
        issues: [
          {
            $id: "1",
            key: "ACME-801",
            fields: {
              summary: "Template task",
              project: { $id: "2", key: "AUT", name: "Auto Resolved Project" },
              account: { $id: "3", id: "ACC4", name: "Northwind Ltd" },
            },
          },
          {
            $id: "4",
            key: "ACME-802",
            fields: {
              summary: "Uncached task resolved via $ref",
              project: { $ref: "2" },
              account: { $ref: "3" },
            },
          },
        ],
      });

      const uncachedAdded = engine.updateTimesheetEntry({
        date: "2026-10-23",
        minutes: 30,
        trackerTaskId: "ACME-802",
        comment: "Auto-resolve task test",
      });
      // Even before resolveTimesheetTasks runs, user-entered row with a taskId is certain (not blocked in UI)
      const addedRowBefore = uncachedAdded.entries.find((e) => e.trackerTaskId === "ACME-802")!;
      expect(addedRowBefore.confidence).toBe("certain");

      const resolvedDraft = await engine.resolveTimesheetTasks("2026-10-23");
      const addedRowAfter = resolvedDraft.entries.find((e) => e.trackerTaskId === "ACME-802")!;
      expect(addedRowAfter).toMatchObject({
        trackerTaskId: "ACME-802",
        trackerTaskTitle: "Uncached task resolved via $ref",
        trackerProjectId: "AUT",
        trackerCustomerId: "ACC4",
        confidence: "certain",
      });
    } finally {
      await engine.stop();
    }
  });
});
