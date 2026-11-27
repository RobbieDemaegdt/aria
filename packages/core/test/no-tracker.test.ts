/**
 * No task tracker: an engine on the null object, diffed against the same
 * engine with the fictional Acme Tracker. Only the tracker's parts go: two Conductor tools, the task fields of two
 * others, the tracker's lines in the prompts and replies, the task column of a draft, the rule offers, Submit, Update and
 * Delete. And nothing of the null object itself (its id, its label, its placeholder) is said anywhere.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppState, ChatItem, DoctorReport, TimesheetCardPayload } from "@aria/protocol";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityCollector, FakeRuntime, AriaEngine, NO_TRACKER, Store, isNoTracker, type TaskTracker } from "../src/index.ts";
import { parseTrackerConfig } from "../src/trackers/config/load.ts";
import { createConfigTracker } from "../src/trackers/config/tracker.ts";
import { windowTrackerInfo } from "../src/trackers/info.ts";
import "./no-network.ts";

const acmeText = readFileSync(fileURLToPath(new URL("./fixtures/trackers/acme.json", import.meta.url)), "utf8");
const parsed = parseTrackerConfig(acmeText, "acme");
if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
const ACME: TaskTracker = createConfigTracker(parsed.config, { hash: "acme-fixture" });

const DATE = "2026-10-23";
const SERVER = "Acme Cloud";
/** What the null object says of itself: it must never be said. */
const NULL_WORDS = /Null Tracker|\bnone(?:[:\-\]]|")/i;

const dirs: string[] = [];
const engines: AriaEngine[] = [];
afterEach(async () => {
  while (engines.length > 0) await engines.pop()!.stop();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

interface ToolShape {
  description: string;
  properties: Record<string, unknown>;
}

interface Observed {
  engine: AriaEngine;
  runtime: FakeRuntime;
  state: AppState;
  tools: Record<string, ToolShape>;
  conductorPrompt: string;
  setup: string;
  tour: string;
  tracker: string;
  doctor: DoctorReport;
  doctorText: string;
  keeper: { systemPrompt: string; prompt: string; propose: Record<string, unknown>; availableTools: string[] };
  card: TimesheetCardPayload;
  /** What every text of the run says, one line each, to scan. */
  lines: string[];
}

const lines = (...texts: string[]) => texts.flatMap((t) => t.split("\n"));
const pretty = (value: unknown) => JSON.stringify(value, null, 1);

async function observe(tracker: TaskTracker): Promise<Observed> {
  const base = mkdtempSync(path.join(os.tmpdir(), "aria-no-tracker-"));
  dirs.push(base);
  const dataDir = path.join(base, "data");
  mkdirSync(dataDir, { recursive: true });
  const runtime = new FakeRuntime();
  runtime.inventoryResult = {
    servers: [{ name: SERVER, status: "connected", source: "user" }],
    tools: [
      { name: "view" },
      ...["list_my_issues", "get_issues", "list_worklogs", "add_worklogs", "update_worklog", "delete_worklogs", "get_current_user"].map((tool) => ({ name: `Acme-Cloud-${tool}`, server: SERVER, tool })),
    ],
  };
  const withTask = !isNoTracker(tracker);
  let keeper: Observed["keeper"] | undefined;
  runtime.timekeeperHandler = (request) => {
    const propose = request.tools.find((t) => t.name === "propose_timesheet")!;
    keeper = { systemPrompt: request.systemPrompt, prompt: request.prompt, propose: z.toJSONSchema(propose.parameters) as Record<string, unknown>, availableTools: [...request.availableTools] };
    return {
      proposal: {
        date: DATE,
        entries: [
          { start: "09:00", end: "10:00", comment: "Daily standup", sources: [{ source: "calendar", title: "Daily standup meeting", organizer: "Pat" }] },
          { start: "10:00", end: "11:30", comment: "Orbit review", ...(withTask ? { trackerTaskId: "ACME-1" } : {}) },
        ],
      },
    };
  };
  const engine = new AriaEngine({ dataDir, runtime, projectRoots: [], watchJitter: 0, tracker });
  engines.push(engine);
  await engine.start();

  const conductor = [...runtime.sessions.values()][0]!;
  const tools = Object.fromEntries(
    conductor.config.tools.map((t) => {
      const schema = z.toJSONSchema(t.parameters) as { properties?: Record<string, unknown> };
      return [t.name, { description: t.description, properties: schema.properties ?? {} }];
    }),
  );
  const reply = async (command: string): Promise<string> => {
    await engine.sendMessage(command);
    return engine.getState().timeline.filter((i): i is ChatItem => i.kind === "chat" && i.role === "assistant").at(-1)!.content;
  };
  const setup = await reply("/setup");
  const tour = await reply("/tour");
  const trackerReply = await reply("/tracker");
  const doctor = await engine.runDoctor();
  const card = await engine.prepareTimesheet(DATE);
  const state = engine.getState();
  const doctorText = pretty(doctor.checks.map((c) => ({ id: c.id, title: c.title, status: c.status, summary: c.summary, remediation: c.remediation })));
  const observed: Observed = {
    engine,
    runtime,
    state,
    tools,
    conductorPrompt: conductor.config.systemPrompt,
    setup,
    tour,
    tracker: trackerReply,
    doctor,
    doctorText,
    keeper: keeper!,
    card,
    lines: [],
  };
  observed.lines = lines(
    pretty(tools),
    observed.conductorPrompt,
    setup,
    tour,
    trackerReply,
    doctorText,
    observed.keeper.systemPrompt,
    observed.keeper.prompt,
    pretty(observed.keeper.propose),
    pretty(card),
    pretty({ ...state, timeline: state.timeline.filter((i) => i.kind !== "chat") }),
  );
  return observed;
}

const only = (a: readonly string[], b: readonly string[]) => a.filter((line) => !b.includes(line));
const TRACKER_FIELDS = ["trackerTaskId", "trackerTaskTitle", "trackerProjectId", "trackerCustomerId"];

describe("the null object", () => {
  it("matches no server, finds no reference, has no tools, no time logs and no projects, and has no window info", () => {
    expect(isNoTracker(NO_TRACKER)).toBe(true);
    expect(isNoTracker(ACME)).toBe(false);
    expect(NO_TRACKER.matchesServer("Acme Cloud")).toBe(false);
    expect(NO_TRACKER.parseTaskRef("ACME-1")).toBeUndefined();
    expect(NO_TRACKER.extractTaskRef("see ACME-1 and task 77")).toBeUndefined();
    expect(NO_TRACKER.taskRefFromBranch("aria/ACME-1-fix")).toBeUndefined();
    expect(NO_TRACKER.tasks.myTasks).toEqual([]);
    expect(NO_TRACKER.tasks.parse({ issues: [] })).toEqual([]);
    expect(NO_TRACKER.timeLogs).toBeUndefined();
    expect(NO_TRACKER.projects).toBeUndefined();
    expect(NO_TRACKER.timekeeper.steps("Acme-Cloud-")).toEqual([]);
    expect(NO_TRACKER.timekeeper.routes).toEqual([]);
    expect(windowTrackerInfo(NO_TRACKER)).toBeUndefined();
    expect(windowTrackerInfo(ACME)?.label).toBe("Acme Tracker");
  });
});

describe("an engine with no task tracker, against the same engine with one", () => {
  it("has no tracker in its state, and no tracker in the Integrations view", async () => {
    const [none, acme] = [await observe(NO_TRACKER), await observe(ACME)];
    expect(acme.state.tracker?.label).toBe("Acme Tracker");
    expect(none.state).not.toHaveProperty("tracker");
    expect(none.state.integrations.tracker).toBeDefined();
    expect(none.state.integrations.tracker?.active).toBeUndefined();
    expect(none.state.integrations.tracker?.tools).toEqual([]);
    expect(none.state.integrations.servers.every((s) => s.tracker === undefined)).toBe(true);
    expect(acme.state.integrations.servers.find((s) => s.name === SERVER)?.tracker).toBe(true);
    // The rest of the state has the same keys.
    expect(Object.keys(none.state).sort()).toEqual(Object.keys(acme.state).filter((k) => k !== "tracker").sort());
    // My work has no tracker part: the watcher is off.
    const myWork = await none.engine.myWork(false);
    expect(myWork).not.toHaveProperty("tracker");
  });

  it("drops only the tracker's tools and task fields from the Conductor's tools, and says nothing of a tracker where they were", async () => {
    const [none, acme] = [await observe(NO_TRACKER), await observe(ACME)];
    expect(Object.keys(acme.tools).filter((name) => !(name in none.tools)).sort()).toEqual(["link_task_tracker", "save_time_rule"]);
    expect(Object.keys(none.tools).filter((name) => !(name in acme.tools))).toEqual([]);
    const reworded: string[] = [];
    for (const [name, tool] of Object.entries(none.tools)) {
      const before = acme.tools[name]!;
      if (tool.description !== before.description) reworded.push(name);
      // Its parameters are the same but for the task fields.
      const keep = Object.fromEntries(Object.entries(before.properties).filter(([key]) => !TRACKER_FIELDS.includes(key)));
      expect(tool.properties, name).toEqual(keep);
      for (const field of TRACKER_FIELDS) expect(tool.properties, name).not.toHaveProperty(field);
    }
    expect(reworded.sort()).toEqual(["list_action_tools", "list_activities", "list_time_rules", "request_action", "update_timesheet_entry"]);
    expect(Object.keys(acme.tools["start_task"]!.properties)).toContain("trackerTaskId");
    expect(Object.keys(acme.tools["update_timesheet_entry"]!.properties)).toEqual(expect.arrayContaining(TRACKER_FIELDS));
    expect(none.conductorPrompt).toBe(acme.conductorPrompt);
  });

  it("says 'pick a task tracker' in /setup and /tour where they named the tracker, and /tracker names none", async () => {
    const [none, acme] = [await observe(NO_TRACKER), await observe(ACME)];
    expect(only(acme.setup.split("\n"), none.setup.split("\n"))).toEqual([expect.stringContaining("**Acme Tracker** for automated timesheets")]);
    expect(only(none.setup.split("\n"), acme.setup.split("\n"))).toEqual([expect.stringContaining("pick a task tracker there too (optional)")]);
    expect(only(acme.tour.split("\n"), none.tour.split("\n"))).toEqual([expect.stringContaining("Track GitHub PRs + Acme Tracker tasks")]);
    expect(only(none.tour.split("\n"), acme.tour.split("\n"))).toEqual([expect.stringContaining("pick a task tracker in Customize › Integrations: optional")]);
    expect(none.tracker).toContain("Active: No task tracker");
    expect(none.tracker).toContain("`/tracker none` to no tracker");
  });

  it("leaves the tracker out of the Timekeeper's prompt and of its proposal, and gives it no tracker tools", async () => {
    const [none, acme] = [await observe(NO_TRACKER), await observe(ACME)];
    // The system prompt: the tracker's steps, its hints, its mapping and its task-updates name go; nothing else.
    // (Work IQ's steps follow the tracker's, so their numbers move: compared without them.)
    const unnumbered = (text: string) => text.split("\n").map((line) => line.replace(/^\s+\d+\.\s/, ""));
    const gone = only(unnumbered(acme.keeper.systemPrompt), unnumbered(none.keeper.systemPrompt));
    expect(gone.every((line) => /Acme|trackerTaskId/.test(line))).toBe(true);
    expect(gone.length).toBeGreaterThanOrEqual(4);
    const added = only(unnumbered(none.keeper.systemPrompt), unnumbered(acme.keeper.systemPrompt));
    expect(added.join("\n")).not.toMatch(/Acme|trackerTaskId/);
    expect(none.keeper.systemPrompt).toContain("There is no task tracker: do not map blocks to tasks");
    expect(none.keeper.systemPrompt).toContain("Work-IQ-Calendar-ListCalendarView");
    // The user prompt carries no tracker hint either (it has none of the tracker's words).
    expect(only(none.keeper.prompt.split("\n"), acme.keeper.prompt.split("\n"))).toEqual([]);
    // The proposal: no task fields, no "tracker" source.
    const fields = (schema: Record<string, unknown>) => {
      const entry = ((schema.properties as Record<string, any>).entries.items ?? {}) as { properties: Record<string, any> };
      return { keys: Object.keys(entry.properties), sources: entry.properties.sources.items.properties.source.enum as string[] };
    };
    expect(fields(acme.keeper.propose).keys).toEqual(expect.arrayContaining(TRACKER_FIELDS));
    expect(fields(acme.keeper.propose).sources).toContain("tracker");
    expect(fields(none.keeper.propose).keys).toEqual(fields(acme.keeper.propose).keys.filter((k) => !TRACKER_FIELDS.includes(k)));
    expect(fields(none.keeper.propose).sources).toEqual(["github", "git", "aria", "calendar", "teams", "mail"]);
    // The session's tools: none of the tracker's.
    expect(acme.keeper.availableTools.some((t) => t.includes("Acme-Cloud-list_my_issues"))).toBe(true);
    expect(none.keeper.availableTools.some((t) => t.startsWith("mcp:Acme-Cloud"))).toBe(false);
  });

  it("drafts rows with times and comments only: no task, no uncertainty about one, no rule offer", async () => {
    const [none, acme] = [await observe(NO_TRACKER), await observe(ACME)];
    expect(acme.card.entries.map((e) => e.uncertaintyReason)).toEqual(["No Acme Tracker task selected", "Suggested by Timekeeper — confirm or change the task"]);
    expect(none.card.entries.map((e) => [e.start, e.end, e.comment])).toEqual(acme.card.entries.map((e) => [e.start, e.end, e.comment]));
    expect(none.card.entries.every((e) => e.confidence === "certain" && e.uncertaintyReason === undefined && e.trackerTaskId === undefined)).toBe(true);
    expect(none.card.uncertainCount).toBe(0);
    expect(acme.card.uncertainCount).toBeGreaterThan(0);
    // A task named for a row anyway is left out, and a rule is never offered for it.
    const row = none.card.entries[0]!;
    const updated = none.engine.updateTimesheetEntry({ date: DATE, entryId: row.id, comment: "Daily standup", trackerTaskId: "ACME-5" });
    expect(updated.entries.find((e) => e.id === row.id)?.trackerTaskId).toBeUndefined();
    expect(updated.ruleOffers).toEqual([]);
    const offered = acme.engine.updateTimesheetEntry({ date: DATE, entryId: acme.card.entries[0]!.id, comment: "Daily standup", trackerTaskId: "ACME-5" });
    expect(offered.ruleOffers.length).toBeGreaterThan(0);
  });

  it("refuses Submit, Update and Delete with the same words, and records nothing of a tracker", async () => {
    const none = await observe(NO_TRACKER);
    await expect(none.engine.submitTimesheet(DATE)).rejects.toThrow("No task tracker is set up.");
    await expect(none.engine.updateRegisteredEntry({ date: DATE, trackerEntryId: "5", start: "09:00", end: "10:00", trackerTaskId: "ACME-1", comment: "x" })).rejects.toThrow("No task tracker is set up.");
    await expect(none.engine.deleteRegisteredEntries({ date: DATE, trackerEntryIds: ["5"], confirmed: true })).rejects.toThrow("No task tracker is set up.");
    // Looking tasks up is a no-op, not an error.
    await expect(none.engine.resolveTimesheetTasks(DATE)).resolves.toMatchObject({ date: DATE });
  });

  it("is told in the doctor that a tracker is optional, as information and not as a warning", async () => {
    const [none, acme] = [await observe(NO_TRACKER), await observe(ACME)];
    const check = none.doctor.checks.find((c) => c.id === "task_tracker");
    expect(check).toMatchObject({ title: "Task tracker", category: "optional", status: "info", summary: "No task tracker (optional)." });
    expect(acme.doctor.checks.some((c) => c.id === "task_tracker")).toBe(false);
    expect(none.doctor.checks.find((c) => c.id === "mcp_integrations")?.title).toBe("MCP integrations (Work IQ)");
    expect(acme.doctor.checks.find((c) => c.id === "mcp_integrations")?.title).toBe("MCP integrations (Acme Tracker & Work IQ)");
    expect(none.doctor.overallStatus).toBe(acme.doctor.overallStatus);
  });

  it("says nothing of the null object anywhere: not its id, not its label, not its placeholder", async () => {
    const [none, acme] = [await observe(NO_TRACKER), await observe(ACME)];
    const fresh = only(none.lines, acme.lines);
    expect(fresh.filter((line) => NULL_WORDS.test(line))).toEqual([]);
    expect(none.lines.filter((line) => /Null Tracker/i.test(line))).toEqual([]);
    // Nor does it say the other tracker's name (the server in the user's setup keeps its own).
    expect(none.lines.filter((line) => /Acme Tracker|acme\.example/.test(line))).toEqual([]);
    // The baseline does say its own tracker's words, so the scan can fail.
    expect(acme.lines.some((line) => /Acme Tracker/.test(line))).toBe(true);
  });
});

describe("what the collector does with no tracker", () => {
  it("refuses to record a task update (its external ID would carry no tracker's id), and leaves recorded ones out of the day's work", () => {
    const db = new Store(":memory:");
    const make = (tracker: TaskTracker) => new ActivityCollector({ tracker: () => tracker, db: () => db, projects: () => [], tasks: () => [], now: () => Date.parse("2026-10-23T12:00:00Z") });
    const update = { taskId: "ACME-1", title: "Ship it", event: "updated" as const };
    expect(() => make(NO_TRACKER).recordTrackerActivity(update)).toThrow("No task tracker is set up");
    expect(db.listActivities()).toEqual([]);
    make(ACME).recordTrackerActivity(update);
    expect(db.listActivities()).toHaveLength(1);
    expect(make(ACME).listActivities()).toHaveLength(1);
    expect(make(NO_TRACKER).listActivities()).toEqual([]);
    db.close();
  });
});
