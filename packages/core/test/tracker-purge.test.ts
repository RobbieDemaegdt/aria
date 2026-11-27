/**
 * Another tracker's data when the tracker changes: it is dormant, never
 * used or linked as the new tracker's, and the switch asks whether to keep it or clear it. Clearing is one transaction
 * after a copy of the whole database, and it is refused, with the data untouched, when the copy can't be made. Registered
 * entries stay as history either way. The trackers are the fictional Acme Tracker and Orbit Desk (the same config under
 * another id and label); their ids are made up.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { TimesheetEntry } from "@aria/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FakeRuntime, AriaEngine, SETTING_TRACKER_WATCHER, Store } from "../src/index.ts";
import { writeTrackerChoice } from "../src/trackers/active.ts";
import "./no-network.ts";

const ACME = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/trackers/acme.json", import.meta.url)), "utf8")) as Record<string, any>;
const DATE = "2026-10-23";
const SERVER = "Acme Tasks";
const WIRE = "Acme-Tasks-";

const dirs: string[] = [];
const engines: AriaEngine[] = [];
afterEach(async () => {
  while (engines.length > 0) await engines.pop()!.stop();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const configText = (id: string, label: string) => JSON.stringify({ ...ACME, id, label }, null, 2);
const entry = (over: Partial<TimesheetEntry>): TimesheetEntry => ({
  id: "e",
  date: DATE,
  start: "09:00",
  end: "10:00",
  minutes: 60,
  comment: "Work",
  sources: [],
  mappedBy: "you",
  confidence: "certain",
  state: "draft",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const rule = (id: string, trackerTaskId: string) => ({ id, match: { kind: "mail_subject" as const, pattern: id }, trackerTaskId, createdFrom: "you" as const, enabled: true });

/** A data folder where Orbit Desk is the tracker in use and has left data of every kind; Acme Tracker's config is in the trackers folder. */
function orbitData() {
  const base = mkdtempSync(path.join(os.tmpdir(), "aria-purge-"));
  dirs.push(base);
  const dataDir = path.join(base, "data");
  const trackers = path.join(dataDir, "trackers");
  mkdirSync(trackers, { recursive: true });
  writeFileSync(path.join(trackers, "acme.json"), configText("acme", "Acme Tracker"));
  writeFileSync(path.join(trackers, "orbit.json"), configText("orbit", "Orbit Desk"));
  const file = path.join(dataDir, "aria.db");
  const store = new Store(file);
  writeTrackerChoice(store, { config: "orbit", dataId: "orbit" });
  seedOrbit(store);
  store.close();
  return { base, dataDir, file };
}

/** What Orbit Desk left: the cache, a rule that names a task, a rule of minutes only, a draft row with a task, a registered entry, links. */
function seedOrbit(store: Store): void {
  store.upsertTrackerTaskCache("orbit", { taskId: "ACME-1", title: "Orbit's task one" });
  store.upsertTrackerTaskCache("orbit", { taskId: "ACME-2", title: "Orbit's task two" });
  store.saveTimeRule("orbit", rule("r-task", "ACME-1"));
  store.saveTimeRule("orbit", { ...rule("r-minutes", ""), defaultMinutes: 30 });
  store.replaceTimesheetEntriesForDate(DATE, [
    entry({ id: "draft", trackerTaskId: "ACME-1", trackerId: "orbit", trackerTaskTitle: "Orbit's task one", comment: "Draft with a task" }),
    entry({ id: "reg", start: "10:00", end: "11:00", trackerTaskId: "ACME-2", trackerId: "orbit", trackerEntryId: "9001", state: "submitted", comment: "Registered" }),
    entry({ id: "plain", start: "11:00", end: "12:00", comment: "No task" }),
  ]);
  store.upsertActivity({ source: "git", kind: "commit", startedAt: 1, endedAt: 1, externalId: "commit:1", title: "Fix the first thing", linkedTrackerTaskId: "ACME-1", linkedTrackerId: "orbit" });
  store.upsertActivity({ source: "git", kind: "commit", startedAt: 2, endedAt: 2, externalId: "commit:2", title: "Plain" });
}

const backups = (file: string) => readdirSync(path.dirname(file)).filter((name) => /\.pre-purge\.\d{8}-\d{6}\.bak$/.test(name));

/** The data folder's store as it is once the engine has stopped. */
async function after<T>(engine: AriaEngine, file: string, read: (store: Store) => T): Promise<T> {
  await engine.stop();
  engines.splice(engines.indexOf(engine), 1);
  const store = new Store(file);
  try {
    return read(store);
  } finally {
    store.close();
  }
}

describe("clearing another tracker's data", () => {
  it("takes the cache, the rules that name a task, the tasks of draft rows and the activity links of every other tracker in one go, and leaves the rest", () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "aria-purge-store-"));
    dirs.push(base);
    const file = path.join(base, "aria.db");
    const store = new Store(file);
    seedOrbit(store);
    // Acme's own, and a state the watcher saved for Orbit.
    store.upsertTrackerTaskCache("acme", { taskId: "ACME-9", title: "Acme's own" });
    store.saveTimeRule("acme", rule("r-acme", "ACME-9"));
    store.replaceTimesheetEntriesForDate("2026-10-24", [entry({ id: "own", date: "2026-10-24", trackerTaskId: "ACME-9", trackerId: "acme" })]);
    store.upsertActivity({ source: "git", kind: "commit", startedAt: 3, endedAt: 3, externalId: "commit:3", title: "Own", linkedTrackerTaskId: "ACME-9", linkedTrackerId: "acme" });
    store.setSetting(SETTING_TRACKER_WATCHER, { trackerId: "orbit", baselined: true });
    const before = store.trackerPurgeCounts("acme");
    expect(before).toEqual({ cachedTasks: 2, rules: 1, draftRowsWithTasks: 1, registeredRows: 1, linkedActivities: 1 });

    expect(store.purgeTrackerData("acme")).toEqual(before);

    expect(store.listTrackerTaskCache("orbit")).toEqual([]);
    expect(store.listTrackerTaskCache("acme").map((e) => e.taskId)).toEqual(["ACME-9"]);
    // Acme's rule and the rule of minutes only stay; Orbit's rule is gone, not only dormant.
    expect(store.listTimeRules("acme").map((r) => r.id).sort()).toEqual(["r-acme", "r-minutes"]);
    expect(store.listTimeRules("orbit").map((r) => r.id)).toEqual(["r-minutes"]);
    // The draft row stays, with its time and comment and no task; the registered entry and the row with no task are as they were.
    const rows = store.listTimesheetEntries(DATE);
    expect(rows.map((r) => [r.id, r.trackerTaskId, r.trackerId, r.trackerEntryId, r.comment])).toEqual([
      ["draft", undefined, undefined, undefined, "Draft with a task"],
      ["reg", "ACME-2", "orbit", "9001", "Registered"],
      ["plain", undefined, undefined, undefined, "No task"],
    ]);
    expect(rows[0]).not.toHaveProperty("trackerTaskTitle");
    expect(store.listTimesheetEntries("2026-10-24")[0]).toMatchObject({ trackerTaskId: "ACME-9", trackerId: "acme" });
    // Links: Orbit's cleared, Acme's kept.
    const links = Object.fromEntries(store.listActivities({}).map((a) => [a.externalId, [a.linkedTrackerTaskId, a.linkedTrackerId]]));
    expect(links).toEqual({ "commit:1": [undefined, undefined], "commit:2": [undefined, undefined], "commit:3": ["ACME-9", "acme"] });
    // Orbit's watcher state goes (it is another tracker's); Acme's would have stayed.
    expect(store.getSetting(SETTING_TRACKER_WATCHER)).toBeUndefined();
    store.setSetting(SETTING_TRACKER_WATCHER, { trackerId: "acme", baselined: true });
    store.purgeTrackerData("acme");
    expect(store.getSetting(SETTING_TRACKER_WATCHER)).toEqual({ trackerId: "acme", baselined: true });
    expect(store.trackerPurgeCounts("acme")).toEqual({ cachedTasks: 0, rules: 0, draftRowsWithTasks: 0, registeredRows: 1, linkedActivities: 0 });
    store.close();
  });

  it("copies the whole database first, as a file of its own, and a purge with nothing to clear still copies", () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "aria-purge-store-"));
    dirs.push(base);
    const file = path.join(base, "aria.db");
    const store = new Store(file);
    seedOrbit(store);
    store.purgeTrackerData("acme");
    const [name] = backups(file);
    expect(backups(file)).toHaveLength(1);
    expect(store.migrationNotes.at(-1)).toBe(`Backed up the database to ${path.join(base, name!)} before clearing another tracker's data.`);
    const copy = new DatabaseSync(path.join(base, name!), { readOnly: true });
    try {
      // What was there before: Orbit's cache, rule and links, and the version the database was at.
      expect((copy.prepare("SELECT COUNT(*) AS n FROM tracker_tasks_cache WHERE tracker_id = 'orbit'").get() as { n: number }).n).toBe(2);
      expect((copy.prepare("SELECT COUNT(*) AS n FROM time_rules WHERE tracker_id = 'orbit'").get() as { n: number }).n).toBe(1);
      expect((copy.prepare("SELECT COUNT(*) AS n FROM activities WHERE linked_tracker_id = 'orbit'").get() as { n: number }).n).toBe(1);
      expect((copy.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(15);
    } finally {
      copy.close();
    }
    store.close();
  });

  it("does nothing, and says why, when the copy can't be made: no room, or another failure; and clears all or nothing", () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "aria-purge-store-"));
    dirs.push(base);
    const file = path.join(base, "aria.db");
    const store = new Store(file, { backup: { freeBytes: () => 0 } });
    seedOrbit(store);
    const counts = store.trackerPurgeCounts("acme");
    // No room: said as the one before a migration says it, for what is being done.
    let error: Error | undefined;
    try {
      store.purgeTrackerData("acme");
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).toMatch(/^ARIA needs about \d+ MB free .+ to back up its database before clearing another tracker's data\. Free some space and try again; your data hasn't changed\.$/);
    expect(store.trackerPurgeCounts("acme")).toEqual(counts);
    expect(backups(file)).toEqual([]);
    expect(existsSync(`${file}.pre-purge.tmp`)).toBe(false);
    store.close();

    // The copy fails for another reason (the drive says it has room): the reason, and nothing cleared.
    const other = new Store(file, {
      backup: {
        freeBytes: () => 1024 ** 4,
        copy: () => {
          throw new Error("the disk went away");
        },
      },
    });
    expect(() => other.purgeTrackerData("acme")).toThrow(/^ARIA couldn't back up its database before clearing another tracker's data, so it didn't clear it; your data hasn't changed\. Details: .*the disk went away/);
    expect(other.trackerPurgeCounts("acme")).toEqual(counts);
    other.close();

    // Once the copy is made the clearing is one transaction: a statement that fails undoes the ones before it.
    const failing = new Store(file);
    const raw = new DatabaseSync(file);
    raw.exec("CREATE TRIGGER stop_it BEFORE UPDATE ON activities BEGIN SELECT RAISE(ABORT, 'no activity may change'); END;");
    raw.close();
    expect(() => failing.purgeTrackerData("acme")).toThrow("no activity may change");
    expect(failing.trackerPurgeCounts("acme")).toEqual(counts);
    expect(failing.listTrackerTaskCache("orbit")).toHaveLength(2);
    failing.close();
  });

  it("clears without a copy for an in-memory store (tests), and says what it cleared", () => {
    const store = new Store(":memory:");
    seedOrbit(store);
    expect(store.purgeTrackerData("acme")).toMatchObject({ cachedTasks: 2, rules: 1 });
    expect(store.listTrackerTaskCache("orbit")).toEqual([]);
    store.close();
  });
});

describe("the question a switch asks (through the engine)", () => {
  async function start(options: Record<string, unknown> = {}) {
    const data = orbitData();
    const engine = new AriaEngine({ dataDir: data.dataDir, runtime: new FakeRuntime(), projectRoots: [], watchJitter: 0, ...options });
    engines.push(engine);
    await engine.start();
    expect(engine.getState().tracker?.id).toBe("orbit");
    return { ...data, engine };
  }

  it("names whose data it is and how much, and is the only thing the preview adds", async () => {
    const { engine } = await start();
    const preview = engine.previewTrackerChange({ config: "acme" });
    expect(preview.refusal).toBeUndefined();
    expect(preview.label).toBe("Acme Tracker");
    expect(preview.purge).toEqual({ from: "orbit", fromLabel: "Orbit Desk", counts: { cachedTasks: 2, rules: 1, draftRowsWithTasks: 1, registeredRows: 1, linkedActivities: 1 } });
    // None never asks, and neither does the tracker the data is of.
    expect(engine.previewTrackerChange({ config: null }).purge).toBeUndefined();
    expect(engine.previewTrackerChange({ config: "orbit", servers: ["Orbit Cloud"] }).purge).toBeUndefined();
  });

  it("keeps it, dormant, when the answer is keep (or nothing): not listed, not linked, and back in use when its tracker returns", async () => {
    const { engine, file } = await start();
    const shown = () => (engine.getState().timeRules ?? []).map((r) => r.id).sort();
    expect(shown()).toEqual(["r-minutes", "r-task"]);
    expect(engine.setActiveTracker({ config: "acme" })).toMatchObject({ ok: true });
    expect(engine.getState().tracker?.id).toBe("acme");
    // Orbit's rule is dormant: kept, not in the list the window shows, nor used.
    expect(shown()).toEqual(["r-minutes"]);
    expect(engine.listTimeRules().map((r) => r.id)).toEqual(["r-minutes"]);
    // ...and back with Orbit.
    expect(engine.setActiveTracker({ config: "orbit" })).toMatchObject({ ok: true });
    expect(shown()).toEqual(["r-minutes", "r-task"]);
    expect(engine.setActiveTracker({ config: "acme" }, { purge: false })).toMatchObject({ ok: true });
    const stored = await after(engine, file, (store) => ({
      cache: store.listTrackerTaskCache("orbit").length,
      counts: store.trackerPurgeCounts("acme"),
    }));
    expect(stored).toEqual({ cache: 2, counts: { cachedTasks: 2, rules: 1, draftRowsWithTasks: 1, registeredRows: 1, linkedActivities: 1 } });
    expect(backups(file)).toEqual([]);
  });

  it("clears it when the answer is clear, says what it cleared, and keeps the registered entry as history", async () => {
    const { engine, file } = await start();
    const result = engine.setActiveTracker({ config: "acme" }, { purge: true });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.message).toMatch(/^Task tracker: Acme Tracker \(acme\.json, [0-9a-f]{8}\)\. Cleared 2 cached tasks, 1 rule, 1 draft row's task, 1 activity link from Orbit Desk; a backup of the database was made first\.$/);
    expect(engine.getState().tracker?.id).toBe("acme");
    expect((engine.getState().timeRules ?? []).map((r) => r.id)).toEqual(["r-minutes"]);
    const stored = await after(engine, file, (store) => ({
      other: store.trackerPurgeCounts("acme"),
      orbit: store.listTrackerTaskCache("orbit").length,
      draft: store.listTimesheetEntries(DATE).map((r) => [r.id, r.trackerTaskId, r.trackerEntryId]),
      choice: store.getSetting<{ config?: string; dataId?: string }>("integrations.tracker"),
    }));
    expect(stored.orbit).toBe(0);
    expect(stored.other).toEqual({ cachedTasks: 0, rules: 0, draftRowsWithTasks: 0, registeredRows: 1, linkedActivities: 0 });
    expect(stored.draft).toEqual([
      ["draft", undefined, undefined],
      ["reg", "ACME-2", "9001"],
      ["plain", undefined, undefined],
    ]);
    expect(stored.choice).toMatchObject({ config: "acme", dataId: "acme" });
    expect(backups(file)).toHaveLength(1);
  });

  it("refuses the switch when the copy can't be made, with the tracker and the data as they were", async () => {
    const { engine, file } = await start({ storeBackup: { freeBytes: () => 0 } });
    const result = engine.setActiveTracker({ config: "acme" }, { purge: true });
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/^ARIA needs about \d+ MB free .+ to back up its database before clearing another tracker's data\. Free some space and try again; your data hasn't changed\.$/),
    });
    expect(engine.getState().tracker?.id).toBe("orbit");
    // Keeping it doesn't need a copy: the same switch goes ahead with the answer keep.
    expect(engine.setActiveTracker({ config: "acme" }, { purge: false })).toMatchObject({ ok: true });
    const stored = await after(engine, file, (store) => store.trackerPurgeCounts("acme"));
    expect(stored).toEqual({ cachedTasks: 2, rules: 1, draftRowsWithTasks: 1, registeredRows: 1, linkedActivities: 1 });
    expect(backups(file)).toEqual([]);
  });

  it("clears nothing when there is nothing to clear, whatever the answer", async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "aria-purge-"));
    dirs.push(base);
    const dataDir = path.join(base, "data");
    mkdirSync(path.join(dataDir, "trackers"), { recursive: true });
    writeFileSync(path.join(dataDir, "trackers", "acme.json"), configText("acme", "Acme Tracker"));
    const engine = new AriaEngine({ dataDir, runtime: new FakeRuntime(), projectRoots: [], watchJitter: 0 });
    engines.push(engine);
    await engine.start();
    expect(engine.previewTrackerChange({ config: "acme" }).purge).toBeUndefined();
    expect(engine.setActiveTracker({ config: "acme" }, { purge: true })).toMatchObject({ ok: true, message: expect.not.stringContaining("Cleared") });
    expect(backups(path.join(dataDir, "aria.db"))).toEqual([]);
  });
});

describe("another tracker's rows and entries when this tracker is in use", () => {
  /** The engine on Acme Tracker, with a server that answers its reads and takes its writes, over Orbit Desk's data. */
  async function acmeOverOrbit() {
    const data = orbitData();
    const writes: string[] = [];
    const server = new Server({ name: "acme-test", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: ["list_my_issues", "list_worklogs", "add_worklogs", "update_worklog", "delete_worklogs"].map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      if (req.params.name === "add_worklogs" || req.params.name === "update_worklog" || req.params.name === "delete_worklogs") writes.push(req.params.name);
      const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
      return text(req.params.name === "list_my_issues" ? { issues: [] } : req.params.name === "list_worklogs" ? { worklogs: [] } : { created: [] });
    });
    const runtime = new FakeRuntime();
    const tool = (name: string) => ({ name: `${WIRE}${name}`, server: SERVER, tool: name, description: name, inputSchema: { type: "object", properties: {} } as never });
    runtime.inventoryResult = { servers: [{ name: SERVER, status: "connected", source: "user" }], tools: ["list_my_issues", "list_worklogs", "add_worklogs", "update_worklog", "delete_worklogs"].map(tool) };
    const engine = new AriaEngine({
      dataDir: data.dataDir,
      runtime,
      projectRoots: [],
      watchJitter: 0,
      mcpTransportFactory: async () => {
        const [client, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        return client;
      },
    });
    engines.push(engine);
    await engine.start();
    expect(engine.setActiveTracker({ config: "acme" })).toMatchObject({ ok: true });
    return { ...data, engine, writes };
  }

  it("can't be submitted: the row waits for a task of this tracker's, and nothing is sent", async () => {
    const { engine, writes, file } = await acmeOverOrbit();
    // The row is uncertain with a reason, and keeps Orbit's task as it was stored: it isn't re-read as Acme's.
    const card = engine.getTimeView(DATE).day.entries.find((e) => e.id === "draft");
    expect(card).toMatchObject({ trackerTaskId: "ACME-1", trackerId: "orbit" });
    await expect(engine.submitTimesheet(DATE, ["draft"])).rejects.toThrow("Row 09:00–10:00 has a task from another tracker; pick a task.");
    expect(writes).toEqual([]);
    const row = await after(engine, file, (store) => store.listTimesheetEntries(DATE).find((e) => e.id === "draft"));
    expect(row).toMatchObject({ trackerTaskId: "ACME-1", trackerId: "orbit", confidence: "uncertain", uncertaintyReason: "Task from another tracker — pick a Acme Tracker task" });
  });

  it("is taken over by a task picked of this tracker's, and then can be submitted", async () => {
    const { engine, writes } = await acmeOverOrbit();
    engine.updateTimesheetEntry({ date: DATE, entryId: "draft", trackerTaskId: "ACME-5", comment: "Work" });
    const picked = engine.getTimeView(DATE).day.entries.find((e) => e.id === "draft");
    expect(picked).toMatchObject({ trackerTaskId: "ACME-5", trackerId: "acme" });
    await expect(engine.submitTimesheet(DATE, ["draft"])).resolves.toBeDefined();
    expect(writes).toEqual(["add_worklogs"]);
  });

  it("doesn't follow an activity's link to another tracker's task, or hand it to the window, and follows it again when that tracker returns", async () => {
    const { engine } = await acmeOverOrbit();
    const link = async () => (await engine.listActivities({ source: "git" })).find((a) => a.externalId === "commit:1")!;
    const dormant = await link();
    expect(dormant).not.toHaveProperty("linkedTrackerTaskId");
    expect(dormant).not.toHaveProperty("linkedTrackerId");
    expect(dormant.resolvedTask).toBeUndefined();
    expect(engine.setActiveTracker({ config: "orbit" })).toMatchObject({ ok: true });
    expect(await link()).toMatchObject({ linkedTrackerTaskId: "ACME-1", linkedTrackerId: "orbit", resolvedTask: { trackerTaskId: "ACME-1", mappedBy: "link" } });
  });

  it("keeps a registered entry of another tracker as history: it can't be changed or deleted through this one", async () => {
    const { engine, writes } = await acmeOverOrbit();
    const registered = engine.getTimeView(DATE).day.registered;
    expect(registered.map((r) => [r.id, r.trackerTaskId, r.trackerId])).toEqual([["9001", "ACME-2", "orbit"]]);
    await expect(engine.updateRegisteredEntry({ date: DATE, trackerEntryId: "9001", start: "10:00", end: "11:30", trackerTaskId: "ACME-2", comment: "More" })).rejects.toThrow(
      "That entry was registered in another tracker, so it stays as history: Acme Tracker can't change it.",
    );
    await expect(engine.deleteRegisteredEntries({ date: DATE, trackerEntryIds: ["9001"], confirmed: true })).rejects.toThrow(
      "That entry was registered in another tracker, so it stays as history: Acme Tracker can't delete it.",
    );
    expect(writes).toEqual([]);
  });
});
