/**
 * The task tracker in Customize › Integrations, in words: what the tracker in use
 * is, which of a config's tools a server has, and the choices the buttons make. Pure; the window draws what these say.
 */
import type { SetActiveTrackerInput, TrackerChangePreview, TrackerConfigListing, TrackerSetup, TrackerToolPart, TrackerToolStatus } from "@aria/protocol";
import type { z } from "zod";

/**
 * The question a switch asks about another tracker's data: what there is, whose it is, and that registered entries
 * stay as history whatever the answer. `purge` is the preview's.
 */
export function purgeText(purge: NonNullable<TrackerChangePreview["purge"]>): string {
  const { counts } = purge;
  const count = (n: number, one: string, many: string) => (n > 0 ? [`${n} ${n === 1 ? one : many}`] : []);
  const parts = [
    ...count(counts.cachedTasks, "cached task", "cached tasks"),
    ...count(counts.rules, "rule", "rules"),
    ...count(counts.draftRowsWithTasks, "draft row with a task", "draft rows with tasks"),
    ...count(counts.linkedActivities, "activity linked to a task", "activities linked to tasks"),
  ];
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "no data");
  return `ARIA has ${list} from ${purge.fromLabel}. Keep them (used again if you switch back) or clear them? Registered entries stay as history either way.`;
}

/** What Customize calls each part of a tracker. */
export const PART_NAMES: Record<TrackerToolPart, string> = {
  myWork: "My work",
  taskDetails: "Task details",
  registered: "Registered time",
  submit: "Submit",
  update: "Update",
  delete: "Delete",
  projects: "Project search",
  test: "Connection test",
};

/** The panel when there is no task tracker. */
export const NO_TRACKER_TEXT = "None. ARIA works without one; pick an MCP server below to read tasks and register time.";

/** "Acme Tracker, through Acme Cloud — acme.json (3f2a9c1e)"; a tracker the code handed the engine (tests) has "built in" in place of a file. */
export function activeText(active: TrackerSetup["active"]): string {
  if (!active) return NO_TRACKER_TEXT;
  const through = active.servers.length > 0 ? `, through ${active.servers.join(" and ")}` : ", with no server of yours yet (use one below)";
  const source = active.file && active.hash ? ` — ${active.file} (${active.hash})` : active.builtIn ? " — built in" : "";
  return `${active.label}${through}${source}`;
}

/** The first lines of a config's error (a load error, or a validation message). */
export const errorLines = (error: string, max = 4): string[] => {
  const lines = error.split("\n").filter(Boolean);
  return lines.length > max ? [...lines.slice(0, max), `… and ${lines.length - max} more`] : lines;
};

export type PartState = "found" | "direct-only" | "missing";

/** A part's state on its server: found; found only through a formatted twin that works only when ARIA calls the server itself; or missing. */
export const partState = (part: Pick<TrackerToolStatus, "found" | "directOnly">): PartState => (part.found === undefined ? "missing" : part.directOnly ? "direct-only" : "found");

/** One server's parts. */
export const serverParts = (tools: readonly TrackerToolStatus[], server: string): TrackerToolStatus[] => tools.filter((t) => t.server === server);

/** The names of the required parts that a server is missing. */
export const missingRequired = (parts: readonly TrackerToolStatus[]): string[] => parts.filter((p) => p.required && partState(p) === "missing").map((p) => PART_NAMES[p.part]);

/** The configs that load, those whose names suit the server first, then by label. */
export function configsFor(configs: readonly TrackerConfigListing[], server: string): TrackerConfigListing[] {
  return configs
    .filter((c) => c.label !== undefined && c.error === undefined)
    .sort((a, b) => Number(b.suggestedServers.includes(server)) - Number(a.suggestedServers.includes(server)) || (a.label ?? "").localeCompare(b.label ?? ""));
}

/**
 * The config the dialog starts on: the one in use when it can be chosen again and nothing else is suggested for this
 * server (a second server of the same tracker), else the first the list gives (the suggested ones come first).
 */
export function startConfig(setup: TrackerSetup, server: string): string | undefined {
  const list = configsFor(setup.configs, server);
  const inUse = setup.active && !setup.active.builtIn ? list.find((c) => c.id === setup.active!.id) : undefined;
  const otherSuggested = list.some((c) => c !== inUse && c.suggestedServers.includes(server));
  return (inUse && !(otherSuggested && !inUse.suggestedServers.includes(server)) ? inUse : list[0])?.id;
}

type Choice = z.infer<typeof SetActiveTrackerInput>;

/** What choosing `configId` for `server` names: the servers of the config in use when it is the same config, then this one (the first chosen is preferred). */
export function choiceFor(setup: TrackerSetup, configId: string, server: string): Choice & { config: string; servers: string[] } {
  const active = setup.active;
  const same = active && !active.builtIn && active.id === configId ? active.servers : [];
  return { config: configId, servers: [...new Set([...same, server])] };
}

/** What "Stop using" makes of the choice: the tracker without this server, or no tracker when it was the last one. */
export function stopChoice(setup: TrackerSetup, server: string): Choice {
  const active = setup.active;
  if (!active) return { config: null };
  const rest = active.servers.filter((s) => s !== server);
  if (rest.length === 0) return { config: null };
  return { ...(active.builtIn ? {} : { config: active.id }), servers: rest };
}
