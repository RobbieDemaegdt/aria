/**
 * What Customize › Integrations shows about the task tracker: the active
 * tracker, the configs in the trackers folder, and which of a config's tools each of its servers has, part by part.
 * Pure: the engine hands it what it knows (the catalog, your rules, ARIA's MCP config, the trackers folder).
 */
import type { TrackerConfigListing, TrackerSetup, TrackerToolPart, TrackerToolStatus } from "@aria/protocol";
import type { McpConfigState } from "../integrations/config.ts";
import { duplicates, isSeen, viewTools, type Catalog, type StoredRule } from "../integrations/rules.ts";
import type { ActiveTracker, TrackerChoice } from "./active.ts";
import type { ConfigListing } from "./config/load.ts";
import { createConfigTracker } from "./config/tracker.ts";
import { isAllowedByServerToolsFilter } from "./servers.ts";
import type { TaskTracker } from "./types.ts";

/** What the setup is read from. */
export interface SetupContext {
  catalog: Catalog;
  toolRules: readonly StoredRule[];
  mcpConfig: McpConfigState;
  /** Whether ARIA calls this server's tools itself (a saved token, a key in the address, a local process), not only through the runtime. */
  canCallDirectly(server: string): boolean;
}

interface PartSpec {
  part: TrackerToolPart;
  tools: readonly string[];
  required: boolean;
}

/** The parts a tracker has and the tools each one tries, in order. My work and Submit, Update and Delete are required. */
export function trackerParts(tracker: TaskTracker): PartSpec[] {
  const parts: PartSpec[] = [{ part: "myWork", tools: tracker.tasks.myTasks, required: true }];
  if (tracker.tasks.byId) parts.push({ part: "taskDetails", tools: tracker.tasks.byId.tools, required: false });
  const logs = tracker.timeLogs;
  if (logs) {
    parts.push({ part: "registered", tools: logs.byRange.tools, required: false });
    parts.push({ part: "submit", tools: [logs.create.tool], required: true });
    parts.push({ part: "update", tools: [logs.update.tool], required: true });
    parts.push({ part: "delete", tools: [logs.delete.tool], required: true });
  }
  if (tracker.projects) parts.push({ part: "projects", tools: [tracker.projects.search.tool], required: false });
  if (tracker.testConnectionTool) parts.push({ part: "test", tools: [tracker.testConnectionTool], required: false });
  return parts;
}

/** The read tools ARIA calls on its own for this tracker (no rule of yours is asked), without repeats. */
export function trackerReads(tracker: TaskTracker): string[] {
  const names = [
    ...tracker.tasks.myTasks,
    ...(tracker.tasks.byId?.tools ?? []),
    ...(tracker.timeLogs?.byRange.tools ?? []),
    ...(tracker.projects ? [tracker.projects.search.tool] : []),
    ...(tracker.testConnectionTool ? [tracker.testConnectionTool] : []),
  ];
  return [...new Set(names)];
}

/** The write tools only the Time view calls. */
export const trackerReserved = (tracker: TaskTracker): string[] => [...tracker.reservedTools];

/** The servers of your setup a tracker could read from: the ones the last check saw and the ones in ARIA's MCP config, without duplicates of each other. */
function candidateServers(ctx: Pick<SetupContext, "catalog" | "mcpConfig">): string[] {
  const dupes = duplicates(ctx.catalog);
  const names = new Set([...ctx.catalog.servers.filter((s) => isSeen(ctx.catalog, s)).map((s) => s.name), ...ctx.mcpConfig.servers.map((s) => s.name)]);
  return [...names].filter((name) => !dupes.has(name));
}

/** The names of the servers the tracker reads from, in its order of preference: the ones in your setup that it matches. */
export function trackerServers(tracker: TaskTracker, ctx: Pick<SetupContext, "catalog" | "mcpConfig">, candidates: readonly string[] = candidateServers(ctx)): string[] {
  return candidates.filter((name) => tracker.matchesServer(name)).sort((a, b) => tracker.serverPreference(a) - tracker.serverPreference(b) || a.localeCompare(b));
}

/**
 * Which of the tracker's tools each of `servers` has, part by part. `found` is the first tool of a part that the
 * catalog lists for the server, or that the server's filter allows through the tracker's raw companions while its
 * formatted twin is listed (the watcher's own rule, so this says what the watcher will do). A tool found only that way
 * is called with the server's own client: through the runtime it is hidden, so `directOnly` says that.
 */
export function trackerToolStatus(tracker: TaskTracker, servers: readonly string[], ctx: SetupContext): TrackerToolStatus[] {
  const views = viewTools(ctx.catalog, ctx.toolRules).filter((v) => v.seen);
  const out: TrackerToolStatus[] = [];
  for (const server of servers) {
    const listed = (tool: string) => views.some((v) => v.entry.server === server && v.entry.tool === tool);
    const filter = ctx.mcpConfig.servers.find((s) => s.name === server)?.tools;
    const companions = tracker.rawCompanions;
    for (const spec of trackerParts(tracker)) {
      let found: string | undefined;
      let viaTwin = false;
      for (const tool of spec.tools) {
        if (listed(tool)) {
          found = tool;
          break;
        }
        const twin = companions && Object.hasOwn(companions, tool) ? companions[tool] : undefined;
        if (twin !== undefined && listed(twin) && isAllowedByServerToolsFilter(tracker, server, filter, tool)) {
          found = tool;
          viaTwin = true;
          break;
        }
      }
      out.push({
        server,
        part: spec.part,
        tools: [...spec.tools],
        ...(found !== undefined ? { found } : {}),
        required: spec.required,
        ...(viaTwin && !ctx.canCallDirectly(server) ? { directOnly: true } : {}),
      });
    }
  }
  return out;
}

/** A tracker made from a config of the trackers folder, once per listing (the listing is made again when the folder is read again). */
const configTrackers = new WeakMap<object, TaskTracker>();
export function listedTracker(entry: ConfigListing & { ok: true }): TaskTracker {
  let tracker = configTrackers.get(entry);
  if (!tracker) {
    tracker = createConfigTracker(entry.config, { hash: entry.hash });
    configTrackers.set(entry, tracker);
  }
  return tracker;
}

/** The trackers folder as the window lists it: each file's label and hash, or what is wrong with it, and the servers that suit it. */
export function listConfigs(listing: readonly ConfigListing[], ctx: Pick<SetupContext, "catalog" | "mcpConfig">): TrackerConfigListing[] {
  const candidates = candidateServers(ctx);
  return listing.map((entry): TrackerConfigListing => {
    if (!entry.ok) return { id: entry.id, file: entry.file, error: entry.errors.join("\n"), suggestedServers: [] };
    return { id: entry.id, label: entry.config.label, file: entry.file, hash: entry.hash, suggestedServers: trackerServers(listedTracker(entry), ctx, candidates) };
  });
}

export interface SetupInput extends SetupContext {
  /** The tracker in use; undefined when there is none. */
  active: ActiveTracker | undefined;
  choice: TrackerChoice;
  listing: readonly ConfigListing[];
  /** Why the config named in the setting isn't the one in use (it didn't load at start), or has gone wrong since. */
  error?: string | undefined;
}

/** `IntegrationsState.tracker`. */
export function buildTrackerSetup(input: SetupInput): TrackerSetup {
  const { active, choice, listing, error } = input;
  // The servers a config was given are the tracker's, in that order, whether or not they are in your setup now.
  const chosen = active?.source === "config" && choice.servers && choice.servers.length > 0 ? choice.servers : undefined;
  const servers = active ? (chosen ?? trackerServers(active.tracker, input)) : [];
  return {
    ...(active
      ? {
          active: {
            id: active.tracker.id,
            label: active.tracker.label,
            ...(active.source === "config" && active.file && active.hash ? { file: active.file, hash: active.hash } : { builtIn: true as const }),
            servers,
            explicitServers: (choice.servers?.length ?? 0) > 0,
          },
        }
      : {}),
    ...(error ? { error } : {}),
    configs: listConfigs(listing, input),
    tools: active ? trackerToolStatus(active.tracker, servers, input) : [],
  };
}
