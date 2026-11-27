/**
 * Which MCP server is the task tracker's: one ranking, `rankTrackerServers`, that the
 * watcher (My work, task updates) and the Timekeeper both use, so they never pick different servers. Connected servers
 * come first, then the others, then those that need signing in or have failed; then the tracker's preference, then the
 * name; duplicates and servers that are turned off are out; the ones the catalog only remembers still count. The tracker
 * is the fictional Acme Tracker and the servers are made up.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ActivityCollector, DEFAULT_TIMEKEEPER_SETTINGS, FakeRuntime, ManualClock, mergeCatalog, Store, TimekeeperRunner, TrackerWatcher } from "../src/index.ts";
import { EMPTY_CATALOG, type Catalog } from "../src/integrations/rules.ts";
import { parseTrackerConfig } from "../src/trackers/config/load.ts";
import { createConfigTracker } from "../src/trackers/config/tracker.ts";
import { rankTrackerServers } from "../src/trackers/servers.ts";
import type { TaskTracker } from "../src/trackers/types.ts";
import "./no-network.ts";

const ACME = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/trackers/acme.json", import.meta.url)), "utf8")) as Record<string, any>;
const NOW = Date.parse("2026-10-23T08:00:00Z");

function build(servers?: string[]): TaskTracker {
  const parsed = parseTrackerConfig(JSON.stringify(ACME), "acme");
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return createConfigTracker(parsed.config, servers ? { servers } : {});
}

interface Server {
  name: string;
  status: string;
  url?: string;
  tools?: string[];
}

/** A catalog the runtime listed these servers in (each with its tools), after one that listed `earlier`: those are remembered, not seen. */
function catalogOf(servers: Server[], earlier: Server[] = []): Catalog {
  const inventory = (list: Server[]) => ({
    servers: list.map((s) => ({ name: s.name, status: s.status, source: "user", ...(s.url ? { url: s.url } : {}) })) as never,
    tools: list.flatMap((s) => (s.tools ?? ["list_my_issues"]).map((tool) => ({ name: `${s.name.replace(/ /g, "-")}-${tool}`, server: s.name, tool }))) as never,
  });
  const first = mergeCatalog(EMPTY_CATALOG, inventory([...earlier, ...servers]), NOW - 1000);
  return earlier.length === 0 ? first : mergeCatalog(first, inventory(servers), NOW);
}

const configured = (...names: Array<[string, boolean]>) => ({ servers: names.map(([name, enabled]) => ({ name, enabled })) });

describe("rankTrackerServers", () => {
  it("puts connected servers first, then the others, then those that need signing in or have failed, and breaks ties by the tracker's preference and then the name", () => {
    const catalog = catalogOf([
      { name: "Acme Mirror", status: "failed" },
      { name: "Acme Login", status: "needs-auth" },
      { name: "Acme Slow", status: "pending" },
      { name: "Acme Fast", status: "connected" },
      { name: "Acme Cloud", status: "connected" },
    ]);
    expect(rankTrackerServers(build(), catalog, undefined)).toEqual(["Acme Cloud", "Acme Fast", "Acme Slow", "Acme Login", "Acme Mirror"]);
    // The preference (the setting's order) comes before the name, inside a rank.
    expect(rankTrackerServers(build(["Acme Fast", "Acme Cloud"]), catalog, undefined)).toEqual(["Acme Fast", "Acme Cloud"]);
    expect(rankTrackerServers(build(["Acme Mirror", "Acme Slow", "Acme Fast"]), catalog, undefined)).toEqual(["Acme Fast", "Acme Slow", "Acme Mirror"]);
  });

  it("prefers one still pending to one that failed or needs signing in (what the watcher ranked equal before)", () => {
    const catalog = catalogOf([
      { name: "Acme A", status: "failed" },
      { name: "Acme B", status: "pending" },
      { name: "Acme C", status: "needs-auth" },
    ]);
    expect(rankTrackerServers(build(), catalog, undefined)).toEqual(["Acme B", "Acme A", "Acme C"]);
  });

  it("takes the servers in the setup (the last check listed them, or ARIA's own configuration has them on), then the ones the catalog only remembers, and leaves out those that are off, duplicates and other servers", () => {
    const catalog = catalogOf(
      [
        { name: "Acme Cloud", status: "connected", url: "https://acme.example/mcp" },
        { name: "Acme Twin", status: "connected", url: "https://acme.example/mcp", tools: [] },
        { name: "Acme Off", status: "disabled" },
        { name: "Elsewhere", status: "connected" },
      ],
      [{ name: "Acme Old", status: "connected" }],
    );
    const mcp = configured(["Acme Own", true], ["Acme Muted", false], ["Acme Cloud", true], ["Elsewhere Own", true]);
    // The configured one the catalog doesn't list is unknown (the middle rank); the remembered one is last, whatever its status was.
    expect(rankTrackerServers(build(), catalog, mcp)).toEqual(["Acme Cloud", "Acme Own", "Acme Old"]);
    // Without the remembered ones (the watcher): only what is in the setup.
    expect(rankTrackerServers(build(), catalog, mcp, { remembered: false })).toEqual(["Acme Cloud", "Acme Own"]);
    // A server ARIA's configuration turns off is out even when the catalog lists it.
    expect(rankTrackerServers(build(), catalog, configured(["Acme Cloud", false]))).toEqual(["Acme Old"]);
    expect(rankTrackerServers(build(), catalog, configured(["Acme Cloud", false]), { remembered: false })).toEqual([]);
  });

  it("puts a server that is in the setup before one the catalog only remembers, whatever the status the catalog kept for it", () => {
    const catalog = catalogOf(
      [
        { name: "Acme Live", status: "pending" },
        { name: "Acme Down", status: "failed" },
        { name: "Acme Login", status: "needs-auth" },
      ],
      [{ name: "Acme Gone", status: "connected" }],
    );
    // "Connected" is what the catalog remembers of Acme Gone; it has left the setup, and that status is stale.
    expect(rankTrackerServers(build(), catalog, undefined)).toEqual(["Acme Live", "Acme Down", "Acme Login", "Acme Gone"]);
    expect(rankTrackerServers(build(), catalog, undefined, { remembered: false })).toEqual(["Acme Live", "Acme Down", "Acme Login"]);
    // Nor does the tracker's preference lift a remembered server over one in the setup.
    expect(rankTrackerServers(build(["Acme Gone", "Acme Login"]), catalog, undefined)).toEqual(["Acme Login", "Acme Gone"]);
  });

  it("has nothing when no server is the tracker's", () => {
    expect(rankTrackerServers(build(), catalogOf([{ name: "Elsewhere", status: "connected" }]), configured(["Elsewhere Own", true]))).toEqual([]);
    expect(rankTrackerServers(build(), EMPTY_CATALOG, undefined)).toEqual([]);
  });
});

describe("the watcher and the Timekeeper pick the same server", () => {
  const timekeeperServer = (tracker: TaskTracker, catalog: Catalog, mcp: ReturnType<typeof configured>): string => {
    const db = new Store(":memory:");
    const collector = new ActivityCollector({ tracker: () => tracker, db: () => db, projects: () => [], tasks: () => [], now: () => NOW });
    const runner = new TimekeeperRunner({
      tracker: () => tracker,
      db: () => db,
      runtime: new FakeRuntime(),
      collector: () => collector,
      catalog: () => catalog,
      toolRules: () => [],
      mcpConfig: () => ({ keepInSync: false, pluginDirectories: [], servers: mcp.servers.map((s) => ({ ...s, transport: "http", url: "https://x.example/mcp", source: "aria" })) }) as never,
      settings: () => DEFAULT_TIMEKEEPER_SETTINGS,
      runtimeReady: () => true,
      helperId: () => "helper",
      helperDone: () => {},
      cards: () => [],
      registeredCards: () => [],
      saveCard: () => {},
      callReadMcpTool: async () => ({ ok: false, error: "unused" }),
      saveTimeRule: () => {
        throw new Error("not used");
      },
      digest: () => {},
      now: () => NOW,
    });
    const server = (runner as unknown as { resolveTrackerServer(): string }).resolveTrackerServer();
    db.close();
    return server;
  };

  const watcherTarget = (tracker: TaskTracker, catalog: Catalog, mcp: ReturnType<typeof configured>) => {
    const db = new Store(":memory:");
    const watcher = new TrackerWatcher({
      db: () => db,
      tracker: () => tracker,
      clock: new ManualClock(NOW),
      mcpClient: () => ({ callTool: async () => ({ ok: true, result: "{}" }) }) as never,
      catalog: () => catalog,
      toolRules: () => [],
      mcpConfig: () => ({ keepInSync: false, pluginDirectories: [], servers: mcp.servers.map((s) => ({ ...s, transport: "http", url: "https://x.example/mcp", source: "aria" })) }) as never,
      canCallServerTool: () => true,
      addCard: () => {},
      attention: () => {},
      digest: () => {},
      onStateChanged: () => {},
      jitter: 0,
    });
    const target = watcher.resolveTarget();
    db.close();
    return target;
  };
  const watcherServer = (tracker: TaskTracker, catalog: Catalog, mcp: ReturnType<typeof configured>): string | undefined => {
    const target = watcherTarget(tracker, catalog, mcp);
    return "server" in target ? target.server : undefined;
  };

  const cases: Array<[string, Server[], Server[], ReturnType<typeof configured>, string]> = [
    ["a failed server that sorts first and a pending one", [{ name: "Acme A", status: "failed" }, { name: "Acme B", status: "pending" }], [], configured(), "Acme B"],
    ["a server that needs signing in and a connected one", [{ name: "Acme A", status: "needs-auth" }, { name: "Acme B", status: "connected" }], [], configured(), "Acme B"],
    ["two connected servers", [{ name: "Acme B", status: "connected" }, { name: "Acme A", status: "connected" }], [], configured(), "Acme A"],
    ["a server turned off in ARIA's configuration", [{ name: "Acme A", status: "connected" }, { name: "Acme B", status: "pending" }], [], configured(["Acme A", false]), "Acme B"],
    // The remembered one has left the setup and its "connected" is stale: the live one wins for both, pending or failed.
    ["a server the catalog remembers as connected and one in the setup that is pending", [{ name: "Acme B", status: "pending" }], [{ name: "Acme A", status: "connected" }], configured(), "Acme B"],
    ["a server the catalog remembers as connected and one in the setup that failed", [{ name: "Acme B", status: "failed" }], [{ name: "Acme A", status: "connected" }], configured(), "Acme B"],
    ["a remembered server and one only ARIA's configuration has", [{ name: "Acme Z", status: "connected" }], [{ name: "Acme A", status: "connected" }], configured(["Acme Z", false], ["Acme M", true]), "Acme M"],
  ];
  it.each(cases)("%s", (_what, servers, earlier, mcp, expected) => {
    const tracker = build();
    const catalog = catalogOf(servers, earlier);
    expect(timekeeperServer(tracker, catalog, mcp)).toBe(expected);
    expect(watcherServer(tracker, catalog, mcp)).toBe(expected);
    expect(rankTrackerServers(tracker, catalog, mcp)[0]).toBe(expected);
  });

  it("part only for a server that has left the setup: the watcher is off, the Timekeeper keeps it as its last resort, before the fallback", () => {
    const tracker = build();
    const catalog = catalogOf([], [{ name: "Acme Gone", status: "connected" }]);
    // The catalog remembers Acme Gone from an earlier check; the last one didn't list it.
    expect(watcherTarget(tracker, catalog, configured())).toEqual({ kind: "off" });
    expect(timekeeperServer(tracker, catalog, configured())).toBe("Acme Gone");
    // With a server in the setup again, both take that one.
    const back = catalogOf([{ name: "Acme Back", status: "pending" }], [{ name: "Acme Gone", status: "connected" }]);
    expect(watcherServer(tracker, back, configured())).toBe("Acme Back");
    expect(timekeeperServer(tracker, back, configured())).toBe("Acme Back");
    // A remembered server that is turned off in ARIA's configuration is no one's.
    expect(timekeeperServer(tracker, catalog, configured(["Acme Gone", false]))).toBe("Acme");
  });

  it("agree under the setting's order too, and the Timekeeper names the tracker's fallback server when none is a candidate", () => {
    const catalog = catalogOf([
      { name: "Acme A", status: "connected" },
      { name: "Acme B", status: "connected" },
    ]);
    const tracker = build(["Acme B", "Acme A"]);
    expect(timekeeperServer(tracker, catalog, configured())).toBe("Acme B");
    expect(watcherServer(tracker, catalog, configured())).toBe("Acme B");
    // The config's own fallback ("Acme") when no server matches; the watcher is off then and says no server.
    expect(timekeeperServer(build(), EMPTY_CATALOG, configured())).toBe("Acme");
    expect(watcherServer(build(), EMPTY_CATALOG, configured())).toBeUndefined();
  });
});
