/**
 * Which task tracker is active: the choice at start, a switch while ARIA runs
 * (the window's event, the notice, the Conductor's tools, the watcher), a reload when the config's file changed, the
 * refusals, and `/tracker`. Any config of the trackers folder and none can be chosen; with no setting the tracker is the
 * one whose id is that of the data the store holds, if its config is there. The configs here are the fictional Acme Tracker's
 * (id `acme`).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatItem, EngineEvent, NoticeItem } from "@aria/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  FakeRuntime,
  AriaEngine,
  ManualClock,
  mergeCatalog,
  SETTING_TRACKER_WATCHER,
  Store,
  TrackerWatcher,
  type TaskTracker,
} from "../src/index.ts";
import { dataTrackerId, readTrackerChoice, TRACKER_SETTING, writeTrackerChoice } from "../src/trackers/active.ts";
import { configHash, parseTrackerConfig } from "../src/trackers/config/load.ts";
import { createConfigTracker } from "../src/trackers/config/tracker.ts";
import "./no-network.ts";

const ACME = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/trackers/acme.json", import.meta.url)), "utf8")) as Record<string, any>;
/** The id of the config most tests make active; its file is `acme.json`. */
const ID = "acme";
const FILE = `${ID}.json`;
const DATE = "2026-10-23";

const dirs: string[] = [];
const engines: AriaEngine[] = [];
afterEach(async () => {
  while (engines.length > 0) await engines.pop()!.stop();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const configText = (over: Record<string, unknown> = {}) => JSON.stringify({ ...ACME, id: ID, ...over }, null, 2);

function setup() {
  const base = mkdtempSync(path.join(os.tmpdir(), "aria-tracker-active-"));
  dirs.push(base);
  const dataDir = path.join(base, "data");
  const trackers = path.join(dataDir, "trackers");
  mkdirSync(trackers, { recursive: true });
  const runtime = new FakeRuntime();
  const events: EngineEvent[] = [];
  const make = (options: Record<string, unknown> = {}) => {
    const engine = new AriaEngine({ dataDir, runtime, projectRoots: [], watchJitter: 0, ...options });
    engines.push(engine);
    engine.onEvent((event) => events.push(event));
    return engine;
  };
  const write = (text: string, name = FILE) => writeFileSync(path.join(trackers, name), text);
  /** What the saved choice is, read from the store once the engine has stopped. */
  const saved = async (engine: AriaEngine) => {
    await engine.stop();
    engines.splice(engines.indexOf(engine), 1);
    const store = new Store(path.join(dataDir, "aria.db"));
    try {
      return readTrackerChoice(store);
    } finally {
      store.close();
    }
  };
  return { dataDir, trackers, runtime, events, make, write, saved };
}

/** The notices about the task tracker (the others, such as the runtime's, aren't these tests' business). */
const notices = (engine: AriaEngine) =>
  engine
    .getState()
    .timeline.filter((i): i is NoticeItem => i.kind === "notice" && (i.cause === "tracker_config" || i.cause === "tracker_changed"))
    .map((i) => i.message);
const replies = (engine: AriaEngine) => engine.getState().timeline.filter((i): i is ChatItem => i.kind === "chat" && i.role === "assistant").map((i) => i.content);

describe("whose data the store holds", () => {
  it("is what was recorded, else the watcher's stamp, else the newest tracker activity's prefix, else unknown", () => {
    const db = new Store(":memory:");
    expect(dataTrackerId(db)).toBeUndefined();
    const activity = (startedAt: number, externalId: string) =>
      db.upsertActivity({ source: "tracker", kind: "task_updated", startedAt, endedAt: startedAt + 1, externalId, title: "An update" });
    activity(1, "older:7:2026-10-22");
    activity(5, "newest:8:2026-10-23");
    expect(dataTrackerId(db)).toBe("newest");
    db.setSetting(SETTING_TRACKER_WATCHER, { trackerId: "stamped" });
    expect(dataTrackerId(db)).toBe("stamped");
    writeTrackerChoice(db, { config: ID, dataId: "recorded" });
    expect(dataTrackerId(db)).toBe("recorded");
    expect(readTrackerChoice(db)).toEqual({ config: ID, dataId: "recorded" });
    // A setting that isn't well formed is read as no choice.
    db.setSetting(TRACKER_SETTING, "nonsense");
    expect(readTrackerChoice(db)).toEqual({});
    db.close();
  });
});

describe("what counts as another tracker's data", () => {
  it("is the cache, the rules that name a task, the rows with a task and the activity links of every tracker but the one kept, and the cache rows of no known tracker (a rule of minutes only is not)", () => {
    const entry = (over: Record<string, unknown> = {}) =>
      ({ id: "e1", date: DATE, start: "09:00", end: "10:00", minutes: 60, comment: "Work", sources: [], mappedBy: "suggestion", confidence: "certain", state: "draft", createdAt: 1, updatedAt: 1, ...over }) as never;
    const rule = (id: string, trackerTaskId: string) => ({ id, match: { kind: "mail_subject" as const, pattern: "Weekly", matchMode: "contains" as const }, trackerTaskId, createdFrom: "you" as const, enabled: true });
    const counts = (over: Record<string, number> = {}) => ({ cachedTasks: 0, rules: 0, draftRowsWithTasks: 0, registeredRows: 0, linkedActivities: 0, ...over });

    // Nothing, or only what is the kept tracker's or no tracker's: nothing to ask about.
    const empty = new Store(":memory:");
    expect(empty.trackerPurgeCounts("acme")).toEqual(counts());
    expect(empty.otherTrackerIds("acme")).toEqual([]);
    empty.saveTimeRule("acme", { ...rule("r1", ""), defaultMinutes: 30 });
    empty.replaceTimesheetEntriesForDate(DATE, [entry()]);
    empty.upsertTrackerTaskCache("acme", { taskId: "ACME-1", title: "Kept" });
    empty.saveTimeRule("acme", rule("r2", "ACME-1"));
    empty.replaceTimesheetEntriesForDate(DATE, [entry({ trackerTaskId: "ACME-1", trackerId: "acme" })]);
    empty.upsertActivity({ source: "git", kind: "commit", startedAt: 1, endedAt: 1, externalId: "c1", title: "A", linkedTrackerTaskId: "ACME-1", linkedTrackerId: "acme" });
    expect(empty.trackerPurgeCounts("acme")).toEqual(counts());
    empty.close();

    // Every other tracker's, one kind at a time.
    const cached = new Store(":memory:");
    cached.upsertTrackerTaskCache("other", { taskId: "7", title: "A task" });
    cached.upsertTrackerTaskCache("", { taskId: "8", title: "Of no known tracker" });
    expect(cached.trackerPurgeCounts("acme")).toEqual(counts({ cachedTasks: 2 }));
    expect(cached.otherTrackerIds("acme")).toEqual(["", "other"]);
    cached.close();

    const ruled = new Store(":memory:");
    ruled.saveTimeRule("other", rule("r3", "7"));
    ruled.saveTimeRule("other", { ...rule("r4", ""), defaultMinutes: 15 });
    expect(ruled.trackerPurgeCounts("acme")).toEqual(counts({ rules: 1 }));
    expect(ruled.trackerPurgeCounts("other")).toEqual(counts());
    ruled.close();

    const rows = new Store(":memory:");
    rows.replaceTimesheetEntriesForDate(DATE, [
      entry({ id: "d", trackerTaskId: "7", trackerId: "other" }),
      entry({ id: "s", start: "10:00", end: "11:00", trackerTaskId: "7", trackerId: "other", trackerEntryId: "9000001", state: "submitted" }),
      entry({ id: "n", start: "11:00", end: "12:00" }),
    ]);
    expect(rows.trackerPurgeCounts("acme")).toEqual(counts({ draftRowsWithTasks: 1, registeredRows: 1 }));
    rows.close();

    const links = new Store(":memory:");
    links.upsertActivity({ source: "git", kind: "commit", startedAt: 1, endedAt: 1, externalId: "c2", title: "B", linkedTrackerTaskId: "7", linkedTrackerId: "other" });
    expect(links.trackerPurgeCounts("acme")).toEqual(counts({ linkedActivities: 1 }));
    links.close();
  });
});

describe("the choice at start", () => {
  it("is no tracker with no setting and no data, and records nothing", async () => {
    const { make, saved, trackers } = setup();
    // Not even a config in the folder is a tracker: nothing chose it.
    writeFileSync(path.join(trackers, FILE), configText());
    const engine = make();
    await engine.start();
    expect(engine.getState().tracker).toBeUndefined();
    expect(engine.listTrackers().active).toMatchObject({ source: "none" });
    expect(notices(engine)).toEqual([]);
    expect(await saved(engine)).toEqual({});
  });

  it("is the tracker of the data with no setting, when its config is there and valid", async () => {
    const { make, write, dataDir, saved } = setup();
    const store = new Store(path.join(dataDir, "aria.db"));
    writeTrackerChoice(store, { dataId: ID });
    store.close();
    write(configText());
    write(configText({ id: "orbit", label: "Orbit Desk" }), "orbit.json");
    const engine = make();
    await engine.start();
    expect(engine.getState().tracker?.label).toBe("Acme Tracker");
    expect(engine.listTrackers().active).toMatchObject({ source: "config", file: FILE, hash: configHash(configText()) });
    expect(notices(engine)).toEqual([]);
    expect(await saved(engine)).toEqual({ dataId: ID });
  });

  it("is no tracker, with a notice that names the file it expects, when the data's config is missing or doesn't load", async () => {
    const { make, write, dataDir, trackers, saved } = setup();
    const store = new Store(path.join(dataDir, "aria.db"));
    writeTrackerChoice(store, { dataId: ID });
    store.close();
    const expected = path.join(trackers, FILE);

    const missing = make();
    await missing.start();
    expect(missing.getState().tracker).toBeUndefined();
    expect(notices(missing)).toEqual([
      `The task tracker config ${FILE} couldn't be loaded: there is no ${FILE} in the trackers folder. ARIA has task data from it, so the config is expected in ${expected}. There is no task tracker until it is there.`,
    ]);
    expect(missing.getState().integrations.tracker?.error).toBe(`The task tracker config ${FILE} couldn't be loaded: there is no ${FILE} in the trackers folder.`);
    // The data is still the tracker's: nothing was recorded or cleared.
    expect(await saved(missing)).toEqual({ dataId: ID });

    write("{ not json");
    const broken = make();
    await broken.start();
    expect(broken.getState().tracker).toBeUndefined();
    expect(notices(broken).at(-1)).toMatch(new RegExp(`^The task tracker config ${FILE} couldn't be loaded: the file isn't valid JSON: .*config is expected in .*${FILE}\\. There is no task tracker until it is there\\.$`));
    await saved(broken);

    // Once the file is right, the next start uses it.
    write(configText());
    const fixed = make();
    await fixed.start();
    expect(fixed.getState().tracker?.label).toBe("Acme Tracker");
    // (The two notices of the earlier starts are in the timeline still; this start added none.)
    expect(notices(fixed).filter((n) => n.includes("task data from it"))).toHaveLength(2);
  });

  it("is a tracker given in the options, whatever the setting says", async () => {
    const { make, saved } = setup();
    const parsed = parseTrackerConfig(JSON.stringify(ACME), "acme");
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    const engine = make({ tracker: createConfigTracker(parsed.config) });
    await engine.start();
    expect(engine.getState().tracker?.id).toBe("acme");
    expect(await saved(engine)).toEqual({ dataId: "acme" });
  });

  it("is the config the setting names, from the next start on, with its hash", async () => {
    const { make, write, saved } = setup();
    write(configText());
    const first = make();
    await first.start();
    expect(first.setActiveTracker({ config: ID })).toMatchObject({ ok: true });
    expect(await saved(first)).toEqual({ config: ID, dataId: ID });

    const second = make();
    await second.start();
    expect(second.getState().tracker?.label).toBe("Acme Tracker");
    expect(second.listTrackers().active).toMatchObject({ source: "config", file: FILE, hash: configHash(configText()) });
    expect(notices(second).filter((n) => n.includes("couldn't be loaded"))).toEqual([]);
  });

  it("is no tracker, with a notice, when the saved config is missing, or doesn't load", async () => {
    const { make, write, trackers, saved } = setup();
    write(configText());
    const first = make();
    await first.start();
    first.setActiveTracker({ config: ID });
    await saved(first);

    rmSync(path.join(trackers, FILE));
    const missing = make();
    await missing.start();
    expect(missing.getState().tracker).toBeUndefined();
    expect(notices(missing).filter((n) => n.includes("couldn't be loaded"))).toEqual([`The task tracker config ${FILE} couldn't be loaded: there is no ${FILE} in the trackers folder. There is no task tracker until it is fixed.`]);
    await saved(missing);

    write("{ not json");
    const broken = make();
    await broken.start();
    expect(broken.getState().tracker).toBeUndefined();
    expect(notices(broken).filter((n) => n.includes("couldn't be loaded")).at(-1)).toMatch(new RegExp(`^The task tracker config ${FILE} couldn't be loaded: the file isn't valid JSON: .*There is no task tracker until it is fixed\\.$`));
    // The choice is kept: once the file is right, the next start uses it.
    write(configText());
    expect((await saved(broken)).config).toBe(ID);
    const fixed = make();
    await fixed.start();
    expect(fixed.getState().tracker?.label).toBe("Acme Tracker");
  });

  it("uses a config id from the options when the setting has none (dev and e2e runs)", async () => {
    const { make, write } = setup();
    write(configText());
    const engine = make({ trackerConfig: ID });
    await engine.start();
    expect(engine.getState().tracker?.label).toBe("Acme Tracker");
  });
});

describe("a switch while ARIA runs", () => {
  it("tells the window, says so in a notice, refreshes the Conductor's tools, and saves the choice", async () => {
    const { make, write, runtime, events, saved } = setup();
    write(configText());
    const engine = make();
    await engine.start();
    const toolText = () => [...runtime.sessions.values()].at(-1)!.config.tools.map((t) => t.description).join("\n");
    expect(toolText()).not.toContain("Acme Tracker task");

    const result = engine.setActiveTracker({ config: ID });
    const hash = configHash(configText());
    expect(result).toEqual({ ok: true, message: `Task tracker: Acme Tracker (${FILE}, ${hash}).` });
    await new Promise((r) => setTimeout(r, 30));
    expect(engine.getState().tracker?.label).toBe("Acme Tracker");
    expect(events.filter((e) => e.type === "tracker")).toEqual([{ type: "tracker", tracker: engine.getState().tracker }]);
    expect(notices(engine)).toEqual([result.ok ? result.message : ""]);
    expect(toolText()).toContain("Acme Tracker task");

    // With no `config`, the tracker of the data: Acme's, which the first switch recorded (the setting is cleared).
    expect(engine.setActiveTracker({ config: null })).toEqual({ ok: true, message: "No task tracker." });
    expect(engine.setActiveTracker({})).toEqual({ ok: true, message: `Task tracker: Acme Tracker (${FILE}, ${hash}).` });
    expect(engine.getState().tracker?.label).toBe("Acme Tracker");
    expect(await saved(engine)).toEqual({ dataId: ID });
  });

  it("goes back to no tracker with no `config` when the store holds no data", async () => {
    const { make, write } = setup();
    write(configText());
    const engine = make();
    await engine.start();
    expect(engine.setActiveTracker({})).toEqual({ ok: true, message: "No task tracker." });
    expect(engine.getState().tracker).toBeUndefined();
  });

  it("refuses to go back to the tracker of the data when its config isn't there, naming the file", async () => {
    const { make, trackers, dataDir } = setup();
    const store = new Store(path.join(dataDir, "aria.db"));
    store.upsertTrackerTaskCache("gone", { taskId: "7", title: "A task" });
    writeTrackerChoice(store, { dataId: "gone" });
    store.close();
    const refused = make();
    await refused.start();
    const gone = path.join(trackers, "gone.json");
    expect(refused.setActiveTracker({})).toEqual({
      ok: false,
      error: `The task tracker config gone.json couldn't be loaded: there is no gone.json in the trackers folder. It is the tracker of ARIA's data: its config is expected in ${gone}.`,
    });
    expect(refused.getState().tracker).toBeUndefined();
  });

  it("refuses a config that isn't there, and a switch while the timesheet is busy", async () => {
    const { make, write, runtime } = setup();
    write(configText());
    const engine = make();
    await engine.start();
    expect(engine.setActiveTracker({ config: "nothing" })).toMatchObject({ ok: false, error: expect.stringContaining("couldn't be loaded") });
    expect(engine.getState().tracker).toBeUndefined();

    // A prepare is running: the model's session, and the ingest of what it reads, finish with the reader they started with.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = false;
    runtime.timekeeperHandler = async () => {
      started = true;
      await gate;
      return { proposal: { date: DATE, entries: [] } };
    };
    const prepare = engine.prepareTimesheet(DATE);
    for (let i = 0; i < 200 && !started; i++) await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(true);
    expect(engine.setActiveTracker({ config: ID })).toEqual({ ok: false, error: "Wait until the timesheet is done." });
    expect(engine.getState().tracker).toBeUndefined();
    release();
    await prepare;
    expect(engine.setActiveTracker({ config: ID })).toMatchObject({ ok: true });
  });

  it("swaps in a config whose file changed at the next listing, and waits for the timesheet when it is busy", async () => {
    const { make, write, runtime } = setup();
    write(configText());
    const engine = make();
    await engine.start();
    engine.setActiveTracker({ config: ID });
    expect(engine.listTrackers().notice).toBeUndefined();

    write(configText({ label: "Acme Tracker 2" }));
    const listed = engine.listTrackers();
    expect(listed.notice).toBe(`${FILE} had changed, so the new version is in use.`);
    expect(engine.getState().tracker?.label).toBe("Acme Tracker 2");
    expect(listed.active.hash).toBe(configHash(configText({ label: "Acme Tracker 2" })));
    expect(engine.listTrackers().notice).toBeUndefined();

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = false;
    runtime.timekeeperHandler = async () => {
      started = true;
      await gate;
      return { proposal: { date: DATE, entries: [] } };
    };
    const prepare = engine.prepareTimesheet(DATE);
    for (let i = 0; i < 200 && !started; i++) await new Promise((r) => setTimeout(r, 10));
    write(configText({ label: "Acme Tracker 3" }));
    expect(engine.listTrackers().notice).toBe(`${FILE} has changed; the new version is loaded the next time this list is shown. Wait until the timesheet is done.`);
    expect(engine.getState().tracker?.label).toBe("Acme Tracker 2");
    release();
    await prepare;
    expect(engine.listTrackers().notice).toBe(`${FILE} had changed, so the new version is in use.`);
    expect(engine.getState().tracker?.label).toBe("Acme Tracker 3");
  });
});

describe("another tracker, and none", () => {
  const OTHER = "orbit";

  it("is any config of the folder when the store holds no tracker's data, from the next start on, and the servers stay only with the tracker they were for", async () => {
    const { make, write, saved } = setup();
    write(configText({ id: OTHER }), OTHER + ".json");
    write(configText());
    const first = make();
    await first.start();
    const hash = configHash(configText({ id: OTHER }));
    expect(first.setActiveTracker({ config: OTHER, servers: ["Acme Cloud"] })).toEqual({ ok: true, message: `Task tracker: Acme Tracker (${OTHER}.json, ${hash}).` });
    expect(first.getState().tracker?.id).toBe(OTHER);
    expect(first.getState().integrations.tracker?.active).toMatchObject({ id: OTHER, servers: ["Acme Cloud"], explicitServers: true });
    expect(await saved(first)).toEqual({ config: OTHER, servers: ["Acme Cloud"], dataId: OTHER });

    const second = make();
    await second.start();
    expect(second.getState().tracker?.id).toBe(OTHER);
    expect(notices(second).filter((n) => n.includes("couldn't be loaded"))).toEqual([]);
    // Another config doesn't take over the servers chosen for this one: with none given, there are none.
    expect(second.setActiveTracker({ config: ID })).toMatchObject({ ok: true });
    expect(await saved(second)).toEqual({ config: ID, dataId: ID });
  });

  it("asks what to do with another tracker's data instead of refusing: it is kept, dormant, unless told to clear it; none and the same id never ask", async () => {
    const { make, write, dataDir } = setup();
    const store = new Store(path.join(dataDir, "aria.db"));
    store.upsertTrackerTaskCache(ID, { taskId: "7", title: "A task" });
    store.close();
    write(configText({ id: OTHER }), OTHER + ".json");
    write(configText());
    const engine = make();
    await engine.start();
    // The question, with whose data it is (the file of that id says what to call it) and how much.
    const preview = engine.previewTrackerChange({ config: OTHER });
    expect(preview.refusal).toBeUndefined();
    expect(preview.purge).toEqual({ from: ID, fromLabel: "Acme Tracker", counts: { cachedTasks: 1, rules: 0, draftRowsWithTasks: 0, registeredRows: 0, linkedActivities: 0 } });
    // Switching without answering "clear" keeps it all.
    expect(engine.setActiveTracker({ config: OTHER })).toMatchObject({ ok: true });
    expect(engine.getState().tracker?.id).toBe(OTHER);
    // None never asks: nothing is used, and nothing is lost. The same tracker for another server asks nothing either.
    expect(engine.previewTrackerChange({ config: null }).purge).toBeUndefined();
    expect(engine.previewTrackerChange({ config: OTHER, servers: ["Acme Cloud"] }).purge).toBeUndefined();
    // The tracker whose data it is comes back, and finds it: nothing of another's is asked about.
    expect(engine.previewTrackerChange({ config: ID }).purge).toBeUndefined();
    expect(engine.setActiveTracker({ config: ID })).toMatchObject({ ok: true });
    expect(engine.getState().tracker?.label).toBe("Acme Tracker");
    expect(engine.listTrackers().active.tracker.id).toBe(ID);
  });

  it("is none when the setting says so, and the window and the Conductor's tools follow a switch to none and back", async () => {
    const { make, write, runtime, events, saved } = setup();
    write(configText());
    const first = make();
    await first.start();
    const toolNames = () => [...runtime.sessions.values()].at(-1)!.config.tools.map((t) => t.name);
    // No setting and no data: no tracker at the start, then Acme's.
    expect(toolNames()).not.toContain("link_task_tracker");
    expect(first.setActiveTracker({ config: ID })).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(toolNames()).toContain("link_task_tracker");
    expect(first.setActiveTracker({ config: null })).toEqual({ ok: true, message: "No task tracker." });
    await new Promise((r) => setTimeout(r, 30));
    expect(first.getState().tracker).toBeUndefined();
    expect(first.getState().integrations.tracker?.active).toBeUndefined();
    expect(events.filter((e) => e.type === "tracker").at(-1)).toEqual({ type: "tracker", tracker: undefined });
    expect(notices(first).at(-1)).toBe("No task tracker.");
    expect(toolNames()).not.toContain("link_task_tracker");
    // `none` is never stored as the data's id: the last tracker's stays.
    expect(await saved(first)).toEqual({ config: null, dataId: ID });

    const second = make();
    await second.start();
    expect(second.getState().tracker).toBeUndefined();
    expect(second.listTrackers().active).toMatchObject({ source: "none" });
    expect(toolNames()).not.toContain("link_task_tracker");
    expect(second.setActiveTracker({ config: ID })).toMatchObject({ ok: true });
    expect(second.getState().tracker?.label).toBe("Acme Tracker");
    expect(toolNames()).toContain("link_task_tracker");
  });

  it("is switched to with /tracker none, and /tracker says so", async () => {
    const { make, write, saved } = setup();
    write(configText());
    const engine = make();
    await engine.start();
    const hash = configHash(configText());
    await engine.sendMessage(`/tracker ${ID}`);
    await engine.sendMessage("/tracker none");
    expect(replies(engine).at(-1)).toBe("No task tracker.");
    await engine.sendMessage("/tracker");
    expect(replies(engine).at(-1)).toContain("Active: No task tracker");
    expect(replies(engine).at(-1)).toContain("`/tracker none` to no tracker");
    // `default` is the tracker of the data (Acme's, which the first switch recorded), and the setting no longer names one.
    await engine.sendMessage("/tracker default");
    expect(replies(engine).at(-1)).toBe(`Task tracker: Acme Tracker (${FILE}, ${hash}).`);
    expect(await saved(engine)).toEqual({ dataId: ID });
  });
});

describe("/tracker", () => {
  it("lists the configs with their hashes and the active tracker, and switches", async () => {
    const { make, write, saved } = setup();
    write(configText());
    write("{ not json", "broken.json");
    const engine = make();
    await engine.start();

    await engine.sendMessage("/tracker");
    const hash = configHash(configText());
    const list = replies(engine).at(-1)!;
    expect(list).toContain("Active: No task tracker");
    expect(list).toContain(`- **Acme Tracker**: ${FILE}, ${hash}`);
    expect(list).toMatch(/- broken\.json: the file isn't valid JSON/);
    expect(list).toContain("`/tracker <id>` switches to a config");

    await engine.sendMessage(`/tracker ${ID}`);
    expect(replies(engine).at(-1)).toBe(`Task tracker: Acme Tracker (${FILE}, ${hash}).`);
    await engine.sendMessage("/tracker");
    expect(replies(engine).at(-1)).toContain(`Active: Acme Tracker (${FILE}, ${hash})`);
    expect(replies(engine).at(-1)).toContain(`- **Acme Tracker**: ${FILE}, ${hash} (active)`);

    await engine.sendMessage("/tracker missing");
    expect(replies(engine).at(-1)).toContain("couldn't be loaded");
    await engine.sendMessage("/tracker default");
    expect(replies(engine).at(-1)).toBe(`Task tracker: Acme Tracker (${FILE}, ${hash}).`);
    expect(await saved(engine)).toEqual({ dataId: ID });
  });
});

describe("the watcher when the tracker changes", () => {
  const build = (edit: (config: Record<string, any>) => void): TaskTracker => {
    const raw = structuredClone(ACME);
    edit(raw);
    const parsed = parseTrackerConfig(JSON.stringify(raw), "acme");
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    return createConfigTracker(parsed.config);
  };

  it("drops the poll of the old tracker, polls the new one at once, and lets none of the old answer land", async () => {
    const first = build(() => {});
    const second = build((c) => {
      c.label = "Second Tracker";
      c.tasks.myTasks = ["list_other_issues"];
    });
    let active = first;
    const now = Date.parse("2026-10-23T08:00:00Z");
    const clock = new ManualClock(now);
    const db = new Store(":memory:");
    const server = "Acme Tasks";
    const catalog = mergeCatalog(
      { servers: [], tools: [] },
      {
        servers: [{ name: server, status: "connected", source: "user" }] as never,
        tools: ["list_my_issues", "list_other_issues"].map((tool) => ({ name: `Acme-Tasks-${tool}`, server, tool })) as never,
      },
      now,
    );
    const calls: string[] = [];
    let release: (answer: { ok: true; result: string }) => void = () => {};
    const slow = new Promise<{ ok: true; result: string }>((resolve) => (release = resolve));
    const issues = (...keys: string[]) => JSON.stringify({ issues: keys.map((key) => ({ key, fields: { summary: `Issue ${key}`, status: { name: "To Do" } } })) });
    const cards: unknown[] = [];
    let changes = 0;
    const watcher = new TrackerWatcher({
      db: () => db,
      tracker: () => active,
      clock,
      mcpClient: () =>
        ({
          callTool: async (request: { tool: string }) => {
            calls.push(request.tool);
            return request.tool === "list_my_issues" ? slow : { ok: true, result: issues("ACME-2") };
          },
        }) as never,
      catalog: () => catalog,
      toolRules: () => [],
      mcpConfig: () => ({ keepInSync: false, pluginDirectories: [], servers: [{ name: server, transport: "http", url: "https://x.example/mcp", enabled: true, source: "aria" }] }) as never,
      canCallServerTool: () => true,
      addCard: (card) => cards.push(card),
      attention: () => {},
      digest: () => {},
      onStateChanged: () => {
        changes++;
      },
      jitter: 0,
    });

    watcher.start();
    for (let i = 0; i < 100 && calls.length < 1; i++) await new Promise((r) => setTimeout(r, 5));
    expect(calls).toEqual(["list_my_issues"]);

    // The tracker changes while the first poll waits for its answer.
    active = second;
    watcher.trackerChanged();
    for (let i = 0; i < 100 && watcher.view().tasks.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(calls).toEqual(["list_my_issues", "list_other_issues"]);
    expect(watcher.view().tasks.map((t) => t.taskId)).toEqual(["ACME-2"]);

    // The old poll's answer comes late and lands nowhere: not in the cache, the list or the cards.
    release({ ok: true, result: issues("ACME-1") });
    await new Promise((r) => setTimeout(r, 30));
    expect(db.listTrackerTaskCache(second.id).map((e) => e.taskId)).toEqual(["ACME-2"]);
    expect(watcher.view().tasks.map((t) => t.taskId)).toEqual(["ACME-2"]);
    expect(watcher.view().status).toBe("ok");
    expect(cards).toEqual([]);
    expect(changes).toBeGreaterThan(0);
    watcher.stop();
  });
});
