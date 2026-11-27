/**
 * The Timekeeper's rules for a config tracker (docs/trackers.md, "The reference"), on the fictional Acme Tracker
 * (fixtures/trackers/acme.json): a tool result feeds the reader only when it comes from one of the tracker's servers,
 * routed by the bare tool name; an answer the reader can't read is a failed read (the next tool is tried); and Submit
 * stops when what is registered can't be read.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  ActivityCollector,
  DEFAULT_TIMEKEEPER_SETTINGS,
  FakeRuntime,
  AriaEngine,
  ManualClock,
  mergeCatalog,
  Store,
  TimekeeperRunner,
} from "../src/index.ts";
import { parseTrackerConfig } from "../src/trackers/config/load.ts";
import { createConfigTracker } from "../src/trackers/config/tracker.ts";
import type { TaskTracker } from "../src/trackers/types.ts";
import "./no-network.ts";

const ACME_TEXT = readFileSync(fileURLToPath(new URL("./fixtures/trackers/acme.json", import.meta.url)), "utf8");
const DATE = "2026-10-23";
const SERVER = "Acme Tasks";
const WIRE = "Acme-Tasks-";

function build(edit?: (config: Record<string, any>) => void): TaskTracker {
  const raw = JSON.parse(ACME_TEXT) as Record<string, any>;
  edit?.(raw);
  const parsed = parseTrackerConfig(JSON.stringify(raw), "acme");
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return createConfigTracker(parsed.config);
}

const issue = (key: string, summary: string) => ({ key, fields: { summary, status: { name: "To Do" }, project: { key: "LED", name: "Ledger" }, account: { id: "ACC1", name: "Acme Corp" } } });
const json = (value: unknown) => JSON.stringify(value);

describe("which tool results the reader gets", () => {
  /** A Timekeeper on an in-memory store, whose catalog lists these tools (server → tools). */
  function runnerFor(tracker: TaskTracker, catalogTools: Record<string, string[]>, configuredServers: string[] = []) {
    const now = Date.parse("2026-10-23T18:00:00Z");
    const db = new Store(":memory:");
    const collector = new ActivityCollector({ tracker: () => tracker, db: () => db, projects: () => [], tasks: () => [], now: () => now });
    const catalog = mergeCatalog(
      { servers: [], tools: [] },
      {
        servers: Object.keys(catalogTools).map((name) => ({ name, status: "connected", source: "user" })) as never,
        tools: Object.entries(catalogTools).flatMap(([server, tools]) => tools.map((tool) => ({ name: `${server.replace(/ /g, "-")}-${tool}`, server, tool }))) as never,
      },
      now,
    );
    const runner = new TimekeeperRunner({
      tracker: () => tracker,
      db: () => db,
      runtime: new FakeRuntime(),
      collector: () => collector,
      catalog: () => catalog,
      toolRules: () => [],
      mcpConfig: () =>
        ({
          keepInSync: false,
          pluginDirectories: [],
          servers: configuredServers.map((name) => ({ name, transport: "http", url: "https://x.example/mcp", enabled: true, source: "aria" })),
        }) as never,
      settings: () => DEFAULT_TIMEKEEPER_SETTINGS,
      runtimeReady: () => true,
      helperId: () => "helper",
      helperDone: () => {},
      cards: () => db.listCards("timesheet_draft") as never,
      registeredCards: () => db.listCards("time_registered") as never,
      saveCard: (card) => db.upsertTimeline(card as never),
      callReadMcpTool: async () => ({ ok: false, error: "unused" }),
      saveTimeRule: () => {
        throw new Error("not used");
      },
      digest: () => {},
      now: () => now,
    });
    return { runner, db };
  }

  it("reads a listed tool of the tracker's server by its bare name, and says what it made of the answer", () => {
    const { runner, db } = runnerFor(build(), { [SERVER]: ["list_my_issues", "get_current_user"] });
    expect(runner.ingestMcpToolResult(DATE, `${WIRE}list_my_issues`, json({ issues: [issue("ACME-1001", "Billing export")] }))).toBe("read");
    expect(db.getTrackerTaskCache("acme", "ACME-1001")?.title).toBe("Billing export");
    expect(runner.ingestMcpToolResult(DATE, `${WIRE}list_my_issues`, json({ issues: [] }))).toBe("empty");
    expect(runner.ingestMcpToolResult(DATE, `${WIRE}list_my_issues`, "You have 3 issues.")).toBe("unreadable");
    // The case of the wire name doesn't matter.
    expect(runner.ingestMcpToolResult(DATE, `${WIRE.toUpperCase()}LIST_MY_ISSUES`, json({ issues: [issue("ACME-1002", "Login")] }))).toBe("read");
  });

  it("gives the reader nothing from another server, even for a tool of the same name", () => {
    const { runner, db } = runnerFor(build(), { [SERVER]: ["list_my_issues"], "Other Tracker": ["list_my_issues"] });
    expect(runner.ingestMcpToolResult(DATE, "Other-Tracker-list_my_issues", json({ issues: [issue("ACME-1001", "Billing export")] }))).toBeUndefined();
    expect(db.listTrackerTaskCache("acme")).toEqual([]);
  });

  it("finds an unlisted tool of a configured server of the tracker by the server's wire prefix", () => {
    const { runner, db } = runnerFor(build(), {}, [SERVER]);
    expect(runner.ingestMcpToolResult(DATE, `${WIRE}list_my_issues`, json({ issues: [issue("ACME-1001", "Billing export")] }))).toBe("read");
    expect(db.getTrackerTaskCache("acme", "ACME-1001")).toBeDefined();
    // ...but not one of a server that isn't the tracker's, or of none ARIA knows.
    expect(runner.ingestMcpToolResult(DATE, "Elsewhere-list_my_issues", json({ issues: [issue("ACME-1002", "Login")] }))).toBeUndefined();
    expect(db.getTrackerTaskCache("acme", "ACME-1002")).toBeUndefined();
  });

  it("forgets the days' registered entries when the store's data changes hands, and says when it is busy", () => {
    const { runner } = runnerFor(build(), { [SERVER]: ["list_worklogs"] });
    // What the runner holds in memory (the stored rows and cards of a registered day stay).
    const inMemory = (runner as unknown as { registeredByDate: Map<string, unknown[]>; needsReconcileByDate: Set<string> });
    const worklog = { id: "9001", issueKey: "ACME-1", issueSummary: "One", started: `${DATE}T09:00:00`, ended: `${DATE}T10:00:00`, comment: "Work" };
    runner.ingestMcpToolResult(DATE, `${WIRE}list_worklogs`, json({ worklogs: [worklog] }));
    expect(inMemory.registeredByDate.get(DATE)).toHaveLength(1);
    inMemory.needsReconcileByDate.add(DATE);
    runner.forgetTrackerState();
    expect(inMemory.registeredByDate.size).toBe(0);
    expect(inMemory.needsReconcileByDate.size).toBe(0);
    expect(runner.isBusy()).toBe(false);
  });

  it("links a sent mail to a cached task by its ID in any case, when the tracker's references don't read it", () => {
    // No bare references: `acme-1001` alone isn't a reference, so the link comes from the cached task's ID in the text.
    const { runner, db } = runnerFor(build((c) => (c.taskRef.bare = false)), { [SERVER]: ["list_my_issues"] });
    runner.ingestMcpToolResult(DATE, `${WIRE}list_my_issues`, json({ issues: [issue("ACME-1001", "Billing export")] }));
    const mail = (id: string, subject: string) => ({ id, subject, sentDateTime: `${DATE}T09:30:00`, bodyPreview: "Thanks" });
    runner.ingestMcpToolResult(DATE, "Work-IQ-Mail-SearchMessages", json([mail("m1", "Re: acme-1001 follow-up"), mail("m2", "Re: acme-10011 follow-up")]));
    const linked = (id: string) => db.listActivities().find((a) => a.externalId === `mail:${id}`)?.linkedTrackerTaskId;
    expect(linked("m1")).toBe("ACME-1001");
    expect(linked("m2")).toBeUndefined();
  });

  it("matches the tracker's tools by their exact names, not by a part of the wire name", () => {
    const { runner } = runnerFor(build(), { [SERVER]: ["list_worklogs", "list_worklogs_export", "get_current_user"] });
    expect(runner.ingestMcpToolResult(DATE, `${WIRE}list_worklogs_export`, json({ worklogs: [] }))).toBeUndefined();
    expect(runner.ingestMcpToolResult(DATE, `${WIRE}get_current_user`, json({ issues: [issue("ACME-1", "One")] }))).toBeUndefined();
    expect(runner.ingestMcpToolResult(DATE, `${WIRE}list_worklogs`, json({ worklogs: [] }))).toBe("empty");
  });
});

describe("through the engine: reads, failed reads and Submit", () => {
  const dirs: string[] = [];
  const engines: AriaEngine[] = [];
  afterEach(async () => {
    while (engines.length > 0) await engines.pop()!.stop();
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  interface Options {
    /** The answer to the date-range read. */
    worklogs: string;
    /** The answers to the by-ID reads, one per call (the last repeats). */
    byId?: string[];
    /** The tracker's by-ID tools (default: Acme's one). */
    byIdTools?: string[];
    /** The server's `tools` filter in ARIA's config. */
    filter?: string[];
    /** Whether the catalog lists the server's tools. */
    listed?: boolean;
  }

  async function scenario(options: Options) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "aria-config-session-"));
    dirs.push(dir);
    const clock = new ManualClock(Date.parse(`${DATE}T16:00:00Z`));
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    let byIdCalls = 0;
    const tools = ["list_my_issues", "get_issues", "get_issues_json", "list_worklogs", "add_worklogs", "update_worklog", "delete_worklogs", "get_current_user"];
    const server = new Server({ name: "acme-test", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map((name) => ({ name, inputSchema: { type: "object", properties: {} } as never })) }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      calls.push({ tool: req.params.name, args });
      const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
      switch (req.params.name) {
        case "list_my_issues":
          return text(json({ issues: [issue("ACME-1002", "Login page")] }));
        case "get_issues":
        case "get_issues_json": {
          const answers = options.byId ?? [json({ issues: [issue("ACME-1001", "Billing export")] })];
          return text(answers[Math.min(byIdCalls++, answers.length - 1)]!);
        }
        case "list_worklogs":
          return text(options.worklogs);
        case "add_worklogs":
          return text(json({ created: [{ index: 0, id: "9001" }] }));
        default:
          return text("OK");
      }
    });

    const runtime = new FakeRuntime();
    runtime.inventoryResult =
      options.listed === false
        ? { servers: [], tools: [] }
        : { servers: [{ name: SERVER, status: "connected", source: "user" }], tools: tools.map((tool) => ({ name: `${WIRE}${tool}`, server: SERVER, tool, inputSchema: { type: "object", properties: {} } as never })) };
    runtime.timekeeperHandler = () => ({
      mcpCalls: [{ server: SERVER, wireName: `${WIRE}list_my_issues`, result: json({ issues: [issue("ACME-1002", "Login page")] }) }],
      proposal: { date: DATE, entries: [{ start: "09:00", end: "10:00", trackerTaskId: "ACME-1001", comment: "Billing export" }] },
    });
    const engine = new AriaEngine({
      tracker: build((c) => {
        if (options.byIdTools) c.tasks.byId.tools = options.byIdTools;
      }),
      dataDir: path.join(dir, "data"),
      runtime,
      projectRoots: [],
      attentionClock: clock,
      watchClock: clock,
      watchJitter: 0,
      mcpTransportFactory: async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        return clientTransport;
      },
    });
    engines.push(engine);
    await engine.start();
    engine.saveMcpServer({ name: SERVER, transport: "http", url: "https://acme.example/mcp", enabled: true, ...(options.filter ? { tools: options.filter } : {}) });
    await new Promise((r) => setTimeout(r, 30));
    calls.length = 0;

    const draft = await engine.prepareTimesheet(DATE);
    const prepareCalls = calls.map((c) => c.tool);
    for (const row of draft.entries) engine.confirmTimesheetEntry(DATE, row.id);
    calls.length = 0;
    let submitted: { status: string } | { error: string };
    try {
      submitted = { status: (await engine.submitTimesheet(DATE)).status };
    } catch (error) {
      submitted = { error: (error as Error).message };
    }
    return { draft, prepareCalls, submitCalls: calls.map((c) => c.tool), submitted, calls };
  }

  const EMPTY_DAY = json({ worklogs: [] });

  it("reads the day and the missing task, and registers the day through Acme's create tool", async () => {
    const run = await scenario({ worklogs: EMPTY_DAY });
    expect(run.prepareCalls).toEqual(["list_worklogs", "get_issues"]);
    expect(run.draft.entries.map((e) => [e.trackerTaskId, e.trackerTaskTitle])).toEqual([["ACME-1001", "Billing export"]]);
    expect(run.submitCalls).toEqual(["list_worklogs", "add_worklogs"]);
    expect(run.submitted).toEqual({ status: "registered" });
  });

  it("tries the next by-ID tool when the answer can't be read, and stops at the first that can", async () => {
    const answers = ["Sorry, I could not look that up.", json({ issues: [issue("ACME-1001", "Billing export")] })];
    const next = await scenario({ worklogs: EMPTY_DAY, byIdTools: ["get_issues", "get_issues_json"], byId: answers });
    expect(next.prepareCalls).toEqual(["list_worklogs", "get_issues", "get_issues_json"]);
    expect(next.draft.entries[0]?.trackerTaskTitle).toBe("Billing export");
    const first = await scenario({ worklogs: EMPTY_DAY, byIdTools: ["get_issues", "get_issues_json"] });
    expect(first.prepareCalls).toEqual(["list_worklogs", "get_issues"]);
  });

  it("goes on when the day's answer says there is nothing, in JSON or in the config's words", async () => {
    for (const worklogs of [EMPTY_DAY, "[]", "No worklogs."]) {
      const run = await scenario({ worklogs });
      expect(run.submitted, worklogs).toEqual({ status: "registered" });
    }
  });

  it("stops Submit before anything is created when the day's answer can't be read", async () => {
    for (const worklogs of ["Something went wrong on our side.", json({ unrelated: true })]) {
      const run = await scenario({ worklogs });
      expect(run.submitted, worklogs).toEqual({ error: "Could not check existing time logs in Acme Tracker: its answer to list_worklogs wasn't a list of time logs" });
      expect(run.submitCalls).toEqual(["list_worklogs"]);
    }
  });

  it("stops Submit when the server's tools filter leaves ARIA no tool to read the day with", async () => {
    const run = await scenario({ worklogs: EMPTY_DAY, filter: ["list_my_issues", "get_issues", "add_worklogs"] });
    expect(run.prepareCalls).toEqual(["get_issues"]);
    expect(run.submitted).toEqual({ error: "Could not check existing time logs in Acme Tracker: none of its time-log tools is available to ARIA" });
    expect(run.submitCalls).toEqual([]);
  });

  it("reads with the tools the server's filter allows although the catalog lists nothing yet, and then only the create is refused", async () => {
    const run = await scenario({ worklogs: EMPTY_DAY, listed: false });
    expect(run.prepareCalls).toEqual(["list_worklogs", "get_issues"]);
    expect(run.submitCalls).toEqual(["list_worklogs"]);
    expect(run.submitted).toMatchObject({ status: "failed" });
  });
});
