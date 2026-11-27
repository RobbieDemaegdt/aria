/**
 * What Customize › Integrations shows about the task tracker: the configs in
 * the trackers folder with the servers that suit them, which of a config's tools each of its servers has (found,
 * missing, reachable only with direct access), what choosing a config would do, importing a file, and the reserved and
 * confirm tools being the union over every config in the folder. Fictional trackers only: Acme Tracker (the fixture)
 * and Orbit Desk (made from it).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineEvent, IntegrationsState } from "@aria/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FakeRuntime, AriaEngine, NO_TRACKER } from "../src/index.ts";
import { configHash, listTrackerConfigs, parseTrackerConfig } from "../src/trackers/config/load.ts";
import { createConfigTracker } from "../src/trackers/config/tracker.ts";
import { unionToolSets } from "../src/trackers/tool-sets.ts";
import type { TaskTracker } from "../src/trackers/types.ts";
import "./no-network.ts";

const ACME_TEXT = readFileSync(fileURLToPath(new URL("./fixtures/trackers/acme.json", import.meta.url)), "utf8");
const ACME = JSON.parse(ACME_TEXT) as Record<string, any>;
/** The id of the config the tests make active (its file is `acme.json`). */
const ID = "acme";
const FILE = `${ID}.json`;
const SERVER = "Acme Cloud";

/** Orbit Desk: Acme's config under another name, with its own write tools. */
const orbit = (): Record<string, any> => {
  const text = JSON.stringify(ACME)
    .replaceAll("add_worklogs", "file_orbit_hours")
    .replaceAll("update_worklog", "amend_orbit_hours")
    .replaceAll("delete_worklogs", "remove_orbit_hours");
  return { ...JSON.parse(text), id: "orbit", label: "Orbit Desk", servers: { match: ["orbit"], fallback: "Orbit" } };
};
const asText = (config: Record<string, unknown>) => JSON.stringify(config, null, 2);
const acmeTracker = (): TaskTracker => {
  const parsed = parseTrackerConfig(ACME_TEXT, "acme");
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return createConfigTracker(parsed.config, { hash: configHash(ACME_TEXT) });
};

const dirs: string[] = [];
const engines: AriaEngine[] = [];
afterEach(async () => {
  while (engines.length > 0) await engines.pop()!.stop();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const tool = (server: string, name: string) => ({ name: `${server.replace(/ /g, "-")}-${name}`, server, tool: name });

function setup(tools: string[] = ["list_my_issues", "get_issues", "list_worklogs", "add_worklogs", "update_worklog", "delete_worklogs", "get_current_user"]) {
  const base = mkdtempSync(path.join(os.tmpdir(), "aria-integrations-tracker-"));
  dirs.push(base);
  const dataDir = path.join(base, "data");
  const folder = path.join(dataDir, "trackers");
  mkdirSync(folder, { recursive: true });
  const runtime = new FakeRuntime();
  runtime.inventoryResult = {
    servers: [
      { name: SERVER, status: "connected", source: "user" },
      { name: "Orbit Desk", status: "connected", source: "user" },
      { name: "GitHub", status: "connected", source: "builtin" },
    ],
    tools: [{ name: "view" }, ...tools.map((t) => tool(SERVER, t)), tool("GitHub", "get_issue")],
  };
  const events: EngineEvent[] = [];
  const make = (options: Record<string, unknown> = {}) => {
    const engine = new AriaEngine({ dataDir, runtime, projectRoots: [], watchJitter: 0, ...options });
    engines.push(engine);
    engine.onEvent((event) => events.push(event));
    return engine;
  };
  const write = (text: string, name = FILE) => writeFileSync(path.join(folder, name), text);
  return { base, dataDir, folder, runtime, events, make, write };
}

const trackerOf = (engine: AriaEngine) => engine.getState().integrations.tracker!;
const part = (setup: IntegrationsState["tracker"], p: string, server = SERVER) => setup!.tools.find((t) => t.server === server && t.part === p)!;

describe("the trackers folder as the Integrations view lists it", () => {
  it("lists each file with its label, hash or error, and the servers whose names suit it", async () => {
    const { make, write } = setup();
    write(ACME_TEXT, "acme.json");
    write(asText(orbit()), "orbit.json");
    write("{ not json", "broken.json");
    const engine = make({ tracker: acmeTracker() });
    await engine.start();
    const configs = trackerOf(engine).configs;
    expect(configs.map((c) => c.file)).toEqual(["acme.json", "broken.json", "orbit.json"]);
    expect(configs[0]).toEqual({ id: "acme", label: "Acme Tracker", file: "acme.json", hash: configHash(ACME_TEXT), suggestedServers: [SERVER] });
    expect(configs[2]).toMatchObject({ id: "orbit", label: "Orbit Desk", suggestedServers: ["Orbit Desk"] });
    expect(configs[1]).toMatchObject({ id: "broken", suggestedServers: [] });
    expect(configs[1]!.error).toMatch(/isn't valid JSON/);
    expect(configs[1]).not.toHaveProperty("hash");
  });

  it("is read again by Refresh, which shows a config put there by hand (and says so in an event) even when the check itself is too soon", async () => {
    const { make, write, events } = setup();
    const engine = make({ tracker: acmeTracker() });
    await engine.start();
    expect(trackerOf(engine).configs).toEqual([]);
    write(asText(orbit()), "orbit.json");
    events.length = 0;
    await expect(engine.refreshIntegrations()).rejects.toThrow(/a moment ago/);
    expect(trackerOf(engine).configs.map((c) => c.id)).toEqual(["orbit"]);
    const shown = events.filter((e): e is Extract<EngineEvent, { type: "integrations" }> => e.type === "integrations");
    expect(shown.at(-1)?.integrations.tracker?.configs.map((c) => c.id)).toEqual(["orbit"]);
  });
});

describe("which of a config's tools each of its servers has", () => {
  it("says found, or missing, for every part (My work and Submit, Update and Delete are the required ones)", async () => {
    const { make } = setup(["list_my_issues", "get_issues", "list_worklogs", "add_worklogs", "update_worklog"]);
    const engine = make({ tracker: acmeTracker() });
    await engine.start();
    const setupState = trackerOf(engine);
    expect(setupState.active).toEqual({ id: "acme", label: "Acme Tracker", builtIn: true, servers: [SERVER], explicitServers: false });
    expect(setupState.tools.map((t) => [t.part, t.found ?? null, t.required])).toEqual([
      ["myWork", "list_my_issues", true],
      ["taskDetails", "get_issues", false],
      ["registered", "list_worklogs", false],
      ["submit", "add_worklogs", true],
      ["update", "update_worklog", true],
      ["delete", null, true],
      ["test", null, false],
    ]);
    expect(part(setupState, "delete").tools).toEqual(["delete_worklogs"]);
    // The tool lists of the other servers aren't counted: GitHub and Orbit Desk aren't Acme's.
    expect(new Set(setupState.tools.map((t) => t.server))).toEqual(new Set([SERVER]));
  });

  it("shows the config in use with its file and hash, and the servers chosen for it", async () => {
    const { make, write } = setup();
    write(asText({ ...ACME, id: ID }));
    const engine = make();
    await engine.start();
    expect(engine.setActiveTracker({ config: ID, servers: [SERVER] })).toMatchObject({ ok: true });
    expect(trackerOf(engine).active).toEqual({ id: ID, label: "Acme Tracker", file: FILE, hash: configHash(asText({ ...ACME, id: ID })), servers: [SERVER], explicitServers: true });
    expect(trackerOf(engine).tools.every((t) => t.server === SERVER)).toBe(true);
    expect(trackerOf(engine).error).toBeUndefined();
  });

  it("says a read is reachable only with direct access when the server's filter allows it only through its formatted twin, until ARIA can call the server itself", async () => {
    const { base, make, write } = setup(["list_my_issues", "get_issues", "list_worklogs", "add_worklogs", "update_worklog", "delete_worklogs"]);
    const config = structuredClone(ACME);
    config.id = ID;
    config.tasks.myTasks = ["list_my_issues_raw"];
    config.tools.rawCompanions = { list_my_issues_raw: "list_my_issues" };
    write(asText(config));
    // A server of your Copilot CLI setup, with a tools filter that names the formatted read: ARIA reaches it through the runtime.
    const cliConfig = path.join(base, "mcp-config.json");
    writeFileSync(cliConfig, JSON.stringify({ mcpServers: { [SERVER]: { type: "http", url: "https://acme.example/mcp", tools: ["list_my_issues", "get_issues", "list_worklogs", "add_worklogs", "update_worklog", "delete_worklogs"] } } }));
    const engine = make({ cliMcpConfigPath: cliConfig });
    await engine.start();
    await engine.importCliMcp();
    expect(engine.setActiveTracker({ config: ID })).toMatchObject({ ok: true });
    // Found through the twin the catalog lists; the runtime's own tool list doesn't have the raw tool.
    expect(part(trackerOf(engine), "myWork")).toEqual({ server: SERVER, part: "myWork", tools: ["list_my_issues_raw"], found: "list_my_issues_raw", required: true, directOnly: true });
    expect(part(trackerOf(engine), "submit").directOnly).toBeUndefined();
    // A saved token: ARIA calls the server itself, so nothing is hidden from it.
    engine.setMcpServerToken({ server: SERVER, bearerToken: "test-token" });
    expect(part(trackerOf(engine), "myWork")).toEqual({ server: SERVER, part: "myWork", tools: ["list_my_issues_raw"], found: "list_my_issues_raw", required: true });
  });

  it("doesn't find a raw read when its formatted twin isn't listed", async () => {
    const { make, write } = setup(["get_issues"]);
    const config = structuredClone(ACME);
    config.id = ID;
    config.tasks.myTasks = ["list_my_issues_raw"];
    config.tools.rawCompanions = { list_my_issues_raw: "list_my_issues" };
    write(asText(config));
    const engine = make();
    await engine.start();
    expect(engine.setActiveTracker({ config: ID })).toMatchObject({ ok: true });
    expect(part(trackerOf(engine), "myWork").found).toBeUndefined();
  });
});

describe("why the config the setting names isn't the one in use", () => {
  it("says it didn't load at start, and that a file has gone wrong since", async () => {
    const { make, write, folder } = setup();
    write(asText({ ...ACME, id: ID }));
    const first = make();
    await first.start();
    first.setActiveTracker({ config: ID });
    await first.stop();
    engines.splice(engines.indexOf(first), 1);

    write("{ not json");
    const broken = make();
    await broken.start();
    // No tracker: a config that doesn't load isn't replaced by another one.
    expect(trackerOf(broken).active).toBeUndefined();
    expect(trackerOf(broken).error).toMatch(new RegExp(`^The task tracker config ${FILE} couldn't be loaded: the file isn't valid JSON`));
    await broken.stop();
    engines.splice(engines.indexOf(broken), 1);

    write(asText({ ...ACME, id: ID }));
    const fixed = make();
    await fixed.start();
    expect(trackerOf(fixed).error).toBeUndefined();
    expect(trackerOf(fixed).active).toMatchObject({ label: "Acme Tracker", file: FILE });
    // An edit that doesn't load: the version that was loaded stays in use, and the view says so.
    write("{ not json");
    fixed.listTrackers();
    expect(trackerOf(fixed).active).toMatchObject({ label: "Acme Tracker" });
    expect(trackerOf(fixed).error).toMatch(new RegExp(`^${FILE} has an error: .*The version that was loaded stays in use\\.$`));
    rmSync(path.join(folder, FILE));
    fixed.listTrackers();
    expect(trackerOf(fixed).error).toBe(`${FILE} is no longer in the trackers folder. The version that was loaded stays in use.`);
  });
});

describe("what choosing a config would do", () => {
  it("lists its tools on the servers it would use, and what ARIA would call without asking", async () => {
    const { make, write } = setup(["list_my_issues", "get_issues", "list_worklogs", "add_worklogs"]);
    write(asText({ ...ACME, id: ID }));
    const engine = make();
    await engine.start();
    const preview = engine.previewTrackerChange({ config: ID, servers: [SERVER] });
    expect(preview).toMatchObject({ label: "Acme Tracker" });
    expect(preview.refusal).toBeUndefined();
    expect(preview.tools.map((t) => [t.server, t.part, t.found ?? null])).toEqual([
      [SERVER, "myWork", "list_my_issues"],
      [SERVER, "taskDetails", "get_issues"],
      [SERVER, "registered", "list_worklogs"],
      [SERVER, "submit", "add_worklogs"],
      [SERVER, "update", null],
      [SERVER, "delete", null],
      [SERVER, "test", null],
    ]);
    expect(preview.reads).toEqual(["list_my_issues", "get_issues", "list_worklogs", "get_current_user"]);
    expect(preview.reserved).toEqual(["add_worklogs", "update_worklog", "delete_worklogs"]);
    // Nothing changed.
    expect(engine.getState().tracker).toBeUndefined();
    // Without servers named, the ones the config's own names find.
    expect(engine.previewTrackerChange({ config: ID }).tools.every((t) => t.server === SERVER)).toBe(true);
  });

  it("says why it would be refused, as the switch itself would", async () => {
    const { make, runtime } = setup();
    const engine = make();
    await engine.start();
    expect(engine.previewTrackerChange({ config: "nothing" }).refusal).toMatch(/couldn't be loaded/);
    expect(engine.previewTrackerChange({ config: "nothing" })).toMatchObject({ tools: [], reads: [], reserved: [] });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = false;
    runtime.timekeeperHandler = async () => {
      started = true;
      await gate;
      return { proposal: { date: "2026-10-23", entries: [] } };
    };
    const prepare = engine.prepareTimesheet("2026-10-23");
    for (let i = 0; i < 200 && !started; i++) await new Promise((r) => setTimeout(r, 10));
    expect(engine.previewTrackerChange({}).refusal).toBe("Wait until the timesheet is done.");
    release();
    await prepare;
    expect(engine.previewTrackerChange({}).refusal).toBeUndefined();
  });
});

describe("importing a config", () => {
  it("copies a valid file into the trackers folder as <id>.json and lists it, with what ARIA would call without asking", async () => {
    const { make, folder, events } = setup();
    const engine = make();
    await engine.start();
    events.length = 0;
    const text = asText(orbit());
    expect(engine.importTrackerConfig(text)).toEqual({
      status: "imported",
      id: "orbit",
      label: "Orbit Desk",
      file: "orbit.json",
      hash: configHash(text),
      replaced: false,
      reads: ["list_my_issues", "get_issues", "list_worklogs", "get_current_user"],
      reserved: ["file_orbit_hours", "amend_orbit_hours", "remove_orbit_hours"],
    });
    expect(readFileSync(path.join(folder, "orbit.json"), "utf8")).toBe(text);
    expect(readdirSync(folder)).toEqual(["orbit.json"]);
    expect(trackerOf(engine).configs).toEqual([{ id: "orbit", label: "Orbit Desk", file: "orbit.json", hash: configHash(text), suggestedServers: ["Orbit Desk"] }]);
    expect(events.some((e) => e.type === "integrations")).toBe(true);
  });

  it("refuses a file that doesn't check, naming what is wrong, and writes nothing", async () => {
    const { make, folder } = setup();
    const engine = make();
    await engine.start();
    expect(engine.importTrackerConfig("{ not json")).toMatchObject({ status: "invalid", errors: [expect.stringMatching(/isn't valid JSON/)] });
    const bad = engine.importTrackerConfig(asText({ ...orbit(), id: "none" }));
    expect(bad).toMatchObject({ status: "invalid" });
    expect(bad.status === "invalid" ? bad.errors.join("\n") : "").toMatch(/id/);
    expect(engine.importTrackerConfig(asText({ ...orbit(), extra: true }))).toMatchObject({ status: "invalid", errors: [expect.stringContaining("unknown key")] });
    expect(readdirSync(folder)).toEqual([]);
  });

  it("asks before it replaces a file, and replaces it only when told to", async () => {
    const { make, write, folder } = setup();
    write(asText(orbit()), "orbit.json");
    const engine = make();
    await engine.start();
    const newer = asText({ ...orbit(), label: "Orbit Desk 2" });
    const asked = engine.importTrackerConfig(newer);
    expect(asked).toEqual({ status: "exists", id: "orbit", label: "Orbit Desk 2", file: "orbit.json", hash: configHash(newer), existingHash: configHash(asText(orbit())), active: false });
    expect(readFileSync(path.join(folder, "orbit.json"), "utf8")).toBe(asText(orbit()));
    expect(engine.importTrackerConfig(newer, { replace: true })).toMatchObject({ status: "imported", replaced: true, label: "Orbit Desk 2" });
    expect(readFileSync(path.join(folder, "orbit.json"), "utf8")).toBe(newer);
    expect(readdirSync(folder)).toEqual(["orbit.json"]);
  });

  it("loads the new version when it replaces the file the tracker in use came from", async () => {
    const { make, write } = setup();
    write(asText({ ...ACME, id: ID }));
    const engine = make();
    await engine.start();
    engine.setActiveTracker({ config: ID });
    expect(engine.getState().tracker?.label).toBe("Acme Tracker");
    const newer = asText({ ...ACME, id: ID, label: "Acme Tracker 2" });
    expect(engine.importTrackerConfig(newer)).toMatchObject({ status: "exists", active: true });
    expect(engine.getState().tracker?.label).toBe("Acme Tracker");
    expect(engine.importTrackerConfig(newer, { replace: true })).toMatchObject({ status: "imported", replaced: true, note: `${FILE} had changed, so the new version is in use.` });
    expect(engine.getState().tracker?.label).toBe("Acme Tracker 2");
    expect(trackerOf(engine).active).toMatchObject({ label: "Acme Tracker 2", hash: configHash(newer) });
  });

  it("names the trackers folder under the data folder", async () => {
    const { make, folder } = setup();
    const engine = make();
    expect(engine.trackersFolder()).toBe(folder);
    expect(existsSync(folder)).toBe(true);
  });
});

describe("the reserved and confirm tools", () => {
  it("are the union over every config in the folder, active or not, and the tracker in use's own", () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "aria-tool-sets-"));
    dirs.push(base);
    const folder = path.join(base, "trackers");
    mkdirSync(folder, { recursive: true });
    // Acme is in use but its config isn't in the folder: its own sets count all the same.
    writeFileSync(path.join(folder, "orbit.json"), asText(orbit()));
    writeFileSync(path.join(folder, "broken.json"), "{ not json");
    const listing = listTrackerConfigs(base);
    const inUse = acmeTracker();
    const sets = unionToolSets([inUse], listing);
    for (const name of [...inUse.reservedTools, "add_worklogs", "update_worklog", "delete_worklogs", "file_orbit_hours", "amend_orbit_hours", "remove_orbit_hours"]) expect(sets.reservedTools.has(name), name).toBe(true);
    for (const name of [...inUse.confirmTools, "delete_worklogs", "remove_orbit_hours"]) expect(sets.confirmTools.has(name), name).toBe(true);
    expect(sets.reservedTools.has("list_my_issues")).toBe(false);
    // Compared in lower case, as the checks do.
    const mixed = parseTrackerConfig(asText(orbit()).replaceAll("file_orbit_hours", "File_Orbit_Hours"), "orbit");
    expect(mixed.ok).toBe(true);
    expect(unionToolSets([], mixed.ok ? [{ file: "orbit.json", id: "orbit", ok: true, config: mixed.config, hash: mixed.hash }] : []).reservedTools.has("file_orbit_hours")).toBe(true);
  });

  it.each([
    ["another tracker", () => acmeTracker()],
    ["no tracker", () => NO_TRACKER],
  ])("keep another tracker's write tools off ARIA's action cards while its config is in the folder, with %s in use", async (_name, tracker) => {
    const { make, write, folder, runtime } = setup();
    // The tracker in use's own write tool (none with no tracker), on another server: reserved while it is in use.
    const ownTool = [...tracker().reservedTools][0];
    runtime.inventoryResult.tools.push(
      ...["list_orbit_hours", "file_orbit_hours", "amend_orbit_hours", "create_orbit_note", ...(ownTool ? [ownTool] : [])].map((t) => tool("Orbit Desk", t)),
    );
    write(asText(orbit()), "orbit.json");
    const engine = make({ tracker: tracker() });
    await engine.start();
    const listed = async () => {
      const conductor = [...runtime.sessions.values()][0]!;
      const listTool = conductor.config.tools.find((t) => t.name === "list_action_tools")!;
      const answer = (await listTool.handler({ server: "Orbit Desk" })) as { tools: Array<{ tool: string }> };
      return answer.tools.map((t) => t.tool).sort();
    };
    // Orbit Desk's own write tools, and the tracker in use's, are reserved; a note isn't.
    expect(await listed()).toEqual(["create_orbit_note"]);
    // Its config leaves the folder: its tools are ordinary writes again (the tracker in use's still aren't).
    rmSync(path.join(folder, "orbit.json"));
    engine.listTrackers();
    expect(await listed()).toEqual(["amend_orbit_hours", "create_orbit_note", "file_orbit_hours"]);
  });
});
