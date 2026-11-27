/**
 * Which MCP server is the tracker's, and which of its tools a configured `tools` filter allows.
 */
import { duplicates, isSeen, type Catalog } from "../integrations/rules.ts";
import type { TaskTracker } from "./types.ts";

/** What the ranking reads of ARIA's own MCP configuration: the servers it names and whether each is on. */
export interface ConfiguredServers {
  servers: ReadonlyArray<{ name: string; enabled: boolean }>;
}

/**
 * The tracker's MCP servers, best first: the one ranking the watcher (My work, task updates) and the Timekeeper
 * both use, so with the same servers in the setup they pick the same one. The candidates are the tracker's servers
 * (`matchesServer`) that are **in the setup** (the last check of the setup listed them, or ARIA's own configuration has
 * them turned on) and, unless `remembered: false`, the ones the catalog only **remembers** (an earlier check listed them,
 * the last didn't: they have left the setup, and the status the catalog kept for them is stale), minus duplicates of
 * another entry (the same address) and the ones that are turned off. Ranked by:
 *
 * 1. in the setup before remembered only, whatever their status: a stale "connected" never beats a server that is there;
 * 2. connection: connected first, then the rest (pending, unknown), then the ones that need signing in or have failed;
 * 3. the tracker's own preference (`serverPreference`: the setting's order, else the config's);
 * 4. the name.
 *
 * The Timekeeper takes the remembered ones as its last resort (before the tracker's fallback name); the watcher doesn't
 * poll a server that has left the setup (`remembered: false`), so with nothing in the setup it is off.
 */
export function rankTrackerServers(
  tracker: TaskTracker,
  catalog: Catalog,
  mcpConfig: ConfiguredServers | undefined,
  options: { remembered?: boolean } = {},
): string[] {
  const configured = mcpConfig?.servers ?? [];
  const dupes = duplicates(catalog);
  const catalogServers = catalog.servers.filter((s) => tracker.matchesServer(s.name) && !dupes.has(s.name));
  const configServers = configured.filter((s) => s.enabled && tracker.matchesServer(s.name) && !dupes.has(s.name));
  const inSetup = new Set([...catalogServers.filter((s) => isSeen(catalog, s)).map((s) => s.name), ...configServers.map((s) => s.name)]);
  const names = [...new Set([...inSetup, ...(options.remembered === false ? [] : catalogServers.map((s) => s.name))])].filter((name) => {
    const cfg = configured.find((s) => s.name === name);
    if (cfg && !cfg.enabled) return false;
    return catalog.servers.find((s) => s.name === name)?.status !== "disabled";
  });
  const connection = (name: string): number => {
    const status = catalog.servers.find((s) => s.name === name)?.status;
    return status === "connected" ? 0 : status === "needs-auth" || status === "failed" ? 2 : 1;
  };
  return names.sort(
    (a, b) =>
      Number(!inSetup.has(a)) - Number(!inSetup.has(b)) ||
      connection(a) - connection(b) ||
      tracker.serverPreference(a) - tracker.serverPreference(b) ||
      a.localeCompare(b),
  );
}

/**
 * Whether a server's `tools` filter allows `toolName`. On the tracker's servers, allowing a formatted read tool also
 * allows its raw-JSON twin (`tracker.rawCompanions`).
 */
export function isAllowedByServerToolsFilter(
  tracker: TaskTracker,
  serverName: string,
  toolsFilter: readonly string[] | undefined,
  toolName: string,
): boolean {
  if (!toolsFilter || toolsFilter.includes("*") || toolsFilter.includes(toolName)) return true;
  const companions = tracker.rawCompanions;
  if (companions && tracker.matchesServer(serverName) && Object.hasOwn(companions, toolName)) {
    const baseTool = companions[toolName];
    if (baseTool && toolsFilter.includes(baseTool)) return true;
  }
  return false;
}

/**
 * A tool choice in the order to try it: as given when the first tool is in the server's filter (or there's no filter),
 * otherwise the first tool last (the user named the others).
 */
export function orderToolChoice(choice: readonly string[], toolsFilter: readonly string[] | undefined): string[] {
  const [first, ...rest] = choice;
  if (first === undefined) return [];
  const firstInFilter = !toolsFilter || toolsFilter.includes("*") || toolsFilter.includes(first);
  return firstInFilter ? [...choice] : [...rest, first];
}
