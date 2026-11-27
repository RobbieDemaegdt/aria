/**
 * A second tracker: a fake "Acme Tracker", made from its config (fixtures/trackers/acme.json) by the generic config
 * tracker, with its own id, label, task URL, server match and tool names (JSON only, no projects,
 * issue keys such as ACME-1001), drives the engine end to end. The watcher's poll gives cards, toasts, digest lines and
 * activities under Acme's names; a timesheet is prepared and submitted through Acme's create tool. Another tracker,
 * loaded but not in use, leaves no word anywhere: `defineAcmeFlow` takes the words of that tracker
 * (`leftoversOf(tracker)`). The public test (tracker-acme.test.ts) names Globex Desk (fixtures/trackers/globex.json); a
 * twin kept outside this repository names another preset.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CardItem, EngineEvent } from "@aria/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FakeRuntime, AriaEngine, ManualClock, TRACKER_POLL_INTERVAL_MS, type TaskTracker } from "../../src/index.ts";
import "../no-network.ts";
import { ACME_BROWSE, acmeIssue, acmeTracker } from "./acme.ts";

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What a tracker would leave behind if anything still hard-coded it, taken from the tracker itself: its label, its
 * fallback server, its task pages' host and its tools.
 */
export function leftoversOf(tracker: TaskTracker): RegExp {
  const words = [
    tracker.label,
    tracker.fallbackServer,
    new URL(tracker.taskUrl("1")).hostname,
    ...tracker.tasks.myTasks,
    ...(tracker.tasks.byId?.tools ?? []),
    ...(tracker.timeLogs ? [...tracker.timeLogs.byRange.tools, tracker.timeLogs.create.tool, tracker.timeLogs.update.tool, tracker.timeLogs.delete.tool] : []),
    ...tracker.reservedTools,
  ].filter((word): word is string => Boolean(word));
  return new RegExp([...new Set(words)].map(escapeRe).join("|"), "i");
}

const SERVER = "Acme Tasks";
const WIRE = "Acme-Tasks-";
const DATE = "2026-10-23";
const BROWSE = ACME_BROWSE;

const dirs: string[] = [];
const engines: AriaEngine[] = [];
afterEach(async () => {
  while (engines.length > 0) await engines.pop()!.stop();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function settle(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 15));
  await new Promise((r) => setTimeout(r, 30));
}

/**
 * Acme runs the engine end to end and none of `leftovers` (the words of another tracker, loaded and not in use) shows
 * anywhere.
 */
export function defineAcmeFlow(title: string, leftovers: RegExp): void {
  describe(title, () => {
    it("polls Acme's tasks into cards, toasts, digest lines and activities, and submits a timesheet through Acme's create tool", async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "aria-acme-"));
      dirs.push(dir);
      const clock = new ManualClock(1_700_000_000_000);

      let issues = [
        acmeIssue("ACME-1001", "Billing export", { status: "In Progress", priority: "High", project: "Ledger" }),
        acmeIssue("ACME-1002", "Login page", { status: "To Do", priority: "Low", project: "Portal" }),
      ];
      let polls = 0;
      const writes: Array<{ tool: string; args: Record<string, unknown> }> = [];
      const updates: Array<Record<string, unknown>> = [];
      const mcpServer = new Server({ name: "acme-test", version: "1.0.0" }, { capabilities: { tools: {} } });
      mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          { name: "list_my_issues", description: "Your open Acme issues as JSON.", inputSchema: { type: "object", properties: {} } },
          { name: "list_worklogs", description: "Worklogs for a date range.", inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } } } },
          { name: "add_worklogs", description: "Adds worklogs.", inputSchema: { type: "object", properties: { worklogs: { type: "array" } } } },
          { name: "update_worklog", description: "Changes a worklog.", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
        ],
      }));
      mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
        const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
        if (req.params.name === "list_my_issues") {
          polls++;
          return text({ issues });
        }
        if (req.params.name === "list_worklogs") return text({ worklogs: [] });
        if (req.params.name === "add_worklogs") {
          const args = req.params.arguments ?? {};
          writes.push({ tool: req.params.name, args });
          return text({ created: (args.worklogs as unknown[]).map((_, index) => ({ index, id: String(9001 + index) })) });
        }
        if (req.params.name === "update_worklog") {
          updates.push(req.params.arguments ?? {});
          return text({ updated: true });
        }
        throw new Error(`Unexpected tool: ${req.params.name}`);
      });

      const runtime = new FakeRuntime();
      const tool = (name: string, description: string, inputSchema?: unknown) => ({ name: `${WIRE}${name}`, server: SERVER, tool: name, description, ...(inputSchema ? { inputSchema: inputSchema as never } : {}) });
      runtime.inventoryResult = {
        servers: [{ name: SERVER, status: "connected", source: "user" }],
        tools: [
          tool("list_my_issues", "Your open Acme issues."),
          tool("list_worklogs", "Worklogs for a date range."),
          tool("add_worklogs", "Adds worklogs.", { type: "object", properties: { worklogs: { type: "array" } }, required: ["worklogs"], additionalProperties: false }),
          tool("update_worklog", "Changes a worklog.", { type: "object", properties: { id: { type: "string" } }, required: ["id"] }),
        ],
      };
      const timekeeperRequests: Array<{ systemPrompt: string; tools: string }> = [];
      runtime.timekeeperHandler = (request) => {
        timekeeperRequests.push({ systemPrompt: request.systemPrompt, tools: request.tools.map((t) => `${t.name}: ${t.description}`).join("\n") });
        return {
          mcpCalls: [{ server: SERVER, wireName: `${WIRE}list_my_issues`, result: JSON.stringify({ issues }) }],
          proposal: {
            date: DATE,
            // The day's zone, which Acme's `offset` times are written in: +02:00 on this date.
            timeZone: "Europe/Brussels",
            entries: [
              { start: "09:00", end: "12:00", trackerTaskId: "ACME-1001", comment: "Billing export" },
              { start: "13:00", end: "15:00", trackerTaskId: "ACME-1002", comment: "Login page" },
            ],
          },
        };
      };

      const events: EngineEvent[] = [];
      const engine = new AriaEngine({
        dataDir: path.join(dir, "data"),
        runtime,
        projectRoots: [],
        tracker: acmeTracker,
        attentionClock: clock,
        watchClock: clock,
        watchJitter: 0,
        mcpTransportFactory: async () => {
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          await mcpServer.connect(serverTransport);
          return clientTransport;
        },
      });
      engines.push(engine);
      engine.onEvent((e) => events.push(e));
      await engine.start();

      // The window's tracker (with the tools its Submit and Delete call), and the server the UI says reads Acme's tasks.
      expect(engine.getState().tracker).toEqual({
        id: "acme",
        label: "Acme Tracker",
        taskUrlTemplate: `${BROWSE}/{id}`,
        taskRefPlaceholder: "Issue key (e.g. ACME-123) or acme.example link",
        serverHint: "Acme Cloud",
        capabilities: { timeLogs: true, projects: false },
        timeLogTools: { create: "add_worklogs", delete: "delete_worklogs", deleteArgs: 'ids: ["{id}"], confirm: true' },
      });
      expect(engine.getState().integrations.servers.find((s) => s.name === SERVER)?.tracker).toBe(true);

      // 1. Cold start: one poll through Acme's tool, a baseline, no cards.
      await settle(() => polls > 0);
      expect(polls).toBe(1);
      const myWork = await engine.myWork(false);
      expect(myWork.tracker).toMatchObject({ status: "ok", server: SERVER });
      expect(myWork.tracker?.tasks.map((t) => [t.taskId, t.url])).toEqual([
        ["ACME-1001", `${BROWSE}/ACME-1001`],
        ["ACME-1002", `${BROWSE}/ACME-1002`],
      ]);
      const updateCards = () =>
        engine.getState().timeline.filter((i): i is Extract<CardItem, { cardType: "tracker_update" }> => i.kind === "card" && i.cardType === "tracker_update");
      expect(updateCards()).toHaveLength(0);

      // 2. Away; the next poll brings a status change, a comment and a new assignment.
      engine.setPresence(false, clock.now());
      issues = [
        acmeIssue("ACME-1001", "Billing export", { status: "In Review", priority: "High", project: "Ledger", comments: [{ id: "c-1", author: "Dana", body: "Looks good" }] }),
        acmeIssue("ACME-1002", "Login page", { status: "To Do", priority: "Low", project: "Portal" }),
        acmeIssue("ACME-1003", "Audit trail", { status: "To Do", priority: "Medium", project: "Ledger" }),
      ];
      clock.advance(TRACKER_POLL_INTERVAL_MS);
      await settle(() => polls > 1);
      expect(polls).toBe(2);
      const cards = updateCards();
      expect(cards.map((c) => `${c.payload.taskId}:${c.payload.event}`).sort()).toEqual(["ACME-1001:comment_added", "ACME-1001:status_changed", "ACME-1003:assigned"]);
      for (const c of cards) {
        expect(c.id.startsWith(`acme-${c.payload.taskId}-`)).toBe(true);
        expect(c.payload.url).toBe(`${BROWSE}/${c.payload.taskId}`);
      }
      const toasts = events.filter((e): e is Extract<EngineEvent, { type: "toast" }> => e.type === "toast").map((e) => e.title);
      expect(toasts).toEqual(["Acme Tracker #ACME-1001 · status → In Review"]);

      // Activities from the cards carry Acme's external IDs.
      const activities = await engine.listActivities({ source: "tracker" });
      expect(activities.length).toBeGreaterThanOrEqual(3);
      expect(activities.every((a) => a.externalId.startsWith("acme:"))).toBe(true);

      // 3. Back, and a message: the digest has Acme's tag and label, and no comment hint (Acme has none).
      clock.advance(60_000);
      engine.setPresence(true, clock.now());
      runtime.replies.push({ text: "Noted." });
      await engine.sendMessage("What changed?");
      await new Promise((r) => setTimeout(r, 30));
      const userChat = engine.getState().timeline.find((i) => i.kind === "chat" && i.role === "user" && i.content === "What changed?");
      const digest = userChat?.kind === "chat" ? (userChat.digest ?? "") : "";
      expect(digest).toContain('[acme] Task #ACME-1001 ("Billing export") status changed from "In Progress" to "In Review".');
      expect(digest).toContain('[acme] New comment on Acme Tracker task #ACME-1001 ("Billing export").');
      expect(digest).toContain('[acme] Task #ACME-1003 ("Audit trail") was assigned to you ["To Do"].');

      // 4. A timesheet through Acme: the Timekeeper's prompt names Acme's tool, rows need no project or customer, and the
      //    submit calls Acme's create tool (on Acme's server, through ARIA's own MCP client) with Acme's payload.
      const draft = await engine.prepareTimesheet(DATE);
      expect(draft.entries.map((e) => e.trackerTaskId)).toEqual(["ACME-1001", "ACME-1002"]);
      expect(timekeeperRequests[0]?.systemPrompt).toContain(`${WIRE}list_my_issues`);
      expect(timekeeperRequests[0]?.systemPrompt).toContain("Acme");
      for (const row of draft.entries) engine.confirmTimesheetEntry(DATE, row.id);
      writes.length = 0;
      const registered = await engine.submitTimesheet(DATE);
      expect(registered.status).toBe("registered");
      expect(registered.entries.map((e) => e.trackerEntryId)).toEqual(["9001", "9002"]);
      expect(writes.map((c) => c.tool)).toEqual(["add_worklogs"]);
      expect(writes[0]!.args).toEqual({
        worklogs: [
          { issueKey: "ACME-1001", started: `${DATE}T09:00:00+02:00`, ended: `${DATE}T12:00:00+02:00`, comment: "Billing export" },
          { issueKey: "ACME-1002", started: `${DATE}T13:00:00+02:00`, ended: `${DATE}T15:00:00+02:00`, comment: "Login page" },
        ],
      });
      // Changing a registered entry writes its times the same way: Acme's `offset`, in the day's zone.
      await engine.updateRegisteredEntry({ date: DATE, trackerEntryId: "9001", start: "09:30", end: "12:00", trackerTaskId: "ACME-1001", comment: "Billing export, part one" });
      expect(updates).toEqual([{ id: "9001", started: `${DATE}T09:30:00+02:00`, ended: `${DATE}T12:00:00+02:00`, comment: "Billing export, part one" }]);
      // A row needs only its task: Acme has no project or customer to ask for.
      engine.updateTimesheetEntry({ date: DATE, addNew: true, start: "16:00", end: "17:00", comment: "Review" });
      await expect(engine.submitTimesheet(DATE)).rejects.toThrow("Row 16:00–17:00 needs a Acme Tracker task ID before submitting.");
      expect(writes).toHaveLength(1);

      // 5. The other tracker's name is nowhere: state (cards, notices, My work, integrations), events, digests, the
      //    Conductor's and the Timekeeper's prompts and tool descriptions, and the tool calls.
      const conductor = [...runtime.sessions.values()][0]!;
      const seen = [
        JSON.stringify(engine.getState()),
        JSON.stringify(await engine.myWork(false)),
        JSON.stringify(events),
        conductor.config.systemPrompt,
        conductor.config.tools.map((t) => `${t.name}: ${t.description}`).join("\n"),
        JSON.stringify(timekeeperRequests),
        JSON.stringify(writes),
        JSON.stringify(activities),
      ].join("\n");
      expect(seen).not.toMatch(leftovers);
      // ...and Acme's label is where the tracker is named: the Conductor's tools and the Timekeeper's prompt.
      expect(conductor.config.tools.map((t) => t.description).join("\n")).toContain("Acme Tracker task");
      expect(timekeeperRequests[0]!.systemPrompt).toContain("Acme issue updates");
      await mcpServer.close();
    });
  });
}
