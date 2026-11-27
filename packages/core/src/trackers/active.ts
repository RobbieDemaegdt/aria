/**
 * Which task tracker is active: the setting that says so, how a choice becomes a
 * tracker (at start and on a switch), and the evidence of whose data the store holds. Any config of the trackers folder,
 * or none (`config: null`: the null object of `none.ts`); ARIA has no tracker of its own.
 */
import path from "node:path";
import type { Store } from "../store/store.ts";
import { loadTrackerConfig, trackersDir, type ConfigListing } from "./config/load.ts";
import { createConfigTracker } from "./config/tracker.ts";
import { SETTING_TRACKER_WATCHER, TRACKER_SETTING } from "./data-id.ts";
import { NO_TRACKER } from "./none.ts";
import type { TaskTracker } from "./types.ts";

export { TRACKER_SETTING };

export interface TrackerChoice {
  /** The config's id; null is "no tracker"; absent is the tracker of ARIA's data, if its config is there. */
  config?: string | null;
  /** The tracker's servers, preferred first; absent: the config's `servers.match`. */
  servers?: string[];
  /** The id of the last real tracker that was active: the evidence of whose data the store holds. */
  dataId?: string;
}

/** A tracker in use, and where it came from. */
export interface ActiveTracker {
  tracker: TaskTracker;
  /** A tracker the code handed the engine (`EngineOptions.tracker`: tests), a config from the trackers folder, or none (the null object). */
  source: "built-in" | "config" | "none";
  /** The config's file name (`<id>.json`) and hash. */
  file?: string;
  hash?: string;
}

export const builtInActive = (tracker: TaskTracker): ActiveTracker => ({ tracker, source: "built-in" });
export const noneActive = (): ActiveTracker => ({ tracker: NO_TRACKER, source: "none" });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The saved choice, as far as it is well formed. */
export function readTrackerChoice(db: Store): TrackerChoice {
  const raw = db.getSetting<unknown>(TRACKER_SETTING);
  if (!isRecord(raw)) return {};
  return {
    ...(typeof raw.config === "string" || raw.config === null ? { config: raw.config } : {}),
    ...(Array.isArray(raw.servers) && raw.servers.every((s) => typeof s === "string") ? { servers: raw.servers as string[] } : {}),
    ...(typeof raw.dataId === "string" && raw.dataId ? { dataId: raw.dataId } : {}),
  };
}

export function writeTrackerChoice(db: Store, choice: TrackerChoice): void {
  db.setSetting(TRACKER_SETTING, choice);
}

/**
 * The id of the tracker whose data the store holds: what was recorded when a tracker last became active, else
 * the tracker the watcher's state is stamped with, else the prefix of the newest tracker activity's external ID.
 */
export function dataTrackerId(db: Store): string | undefined {
  const choice = readTrackerChoice(db);
  if (choice.dataId) return choice.dataId;
  const stamped = db.getSetting<{ trackerId?: unknown }>(SETTING_TRACKER_WATCHER)?.trackerId;
  if (typeof stamped === "string" && stamped) return stamped;
  const prefix = db.newestActivityExternalId("tracker")?.split(":")[0];
  return prefix || undefined;
}

/** A tracker made from a loaded config. */
function configActive(config: Parameters<typeof createConfigTracker>[0], file: string, hash: string, servers?: string[]): ActiveTracker {
  return {
    tracker: createConfigTracker(config, { hash, ...(servers && servers.length > 0 ? { servers } : {}) }),
    source: "config",
    file,
    hash,
  };
}

export type Chosen = { ok: true; active: ActiveTracker } | { ok: false; error: string };

/** The tracker a config id names, loaded from the trackers folder: any config, whatever its id. */
export function chooseConfig(dataDir: string, id: string, servers?: string[]): Chosen {
  const loaded = loadTrackerConfig(dataDir, id);
  if (!loaded.ok) return { ok: false, error: `The task tracker config ${id}.json couldn't be loaded: ${loaded.errors[0] ?? "it is invalid"}.` };
  return { ok: true, active: configActive(loaded.config, `${id}.json`, loaded.hash, servers) };
}

/** The file a tracker's config is expected in, for a notice. */
export const expectedConfigFile = (dataDir: string, id: string): string => path.join(trackersDir(dataDir), `${id}.json`);

/**
 * The tracker of ARIA's data: the config whose id is `dataId`, if that file is there and valid; with
 * no data, none; with data and no usable file, none and a notice that names the file the config is expected in.
 */
export function chooseDataTracker(dataDir: string, dataId: string | undefined, servers?: string[]): { active: ActiveTracker; notice?: string; error?: string } {
  if (dataId === undefined) return { active: noneActive() };
  const chosen = chooseConfig(dataDir, dataId, servers);
  if (chosen.ok) return { active: chosen.active };
  const notice = `${chosen.error} ARIA has task data from it, so the config is expected in ${expectedConfigFile(dataDir, dataId)}. There is no task tracker until it is there.`;
  return { active: noneActive(), notice, error: chosen.error };
}

/**
 * The tracker for a saved choice at start, and a notice when the choice couldn't be had (`error` is
 * what was wrong with it, as the Integrations view says it): `config: null` is none, a config is that config and one that
 * can't be had is none with a notice, and no setting is the tracker of ARIA's data (`chooseDataTracker`).
 */
export function chooseTracker(
  dataDir: string,
  choice: TrackerChoice,
  /** The id of the tracker whose data the store holds (`dataTrackerId`). */
  dataId: string | undefined,
  /** A config id that stands in for a missing setting (`ARIA_FAKE_TRACKER`, dev and e2e only). */
  fallbackConfig?: string,
): { active: ActiveTracker; notice?: string; error?: string } {
  if (choice.config === null) return { active: noneActive() };
  const id = choice.config === undefined ? fallbackConfig : choice.config;
  if (id === undefined) return chooseDataTracker(dataDir, dataId, choice.servers);
  const chosen = chooseConfig(dataDir, id, choice.servers);
  if (chosen.ok) return { active: chosen.active };
  return { active: noneActive(), notice: `${chosen.error} There is no task tracker until it is fixed.`, error: chosen.error };
}

/** One tracker, as the notice and `/tracker` name it. */
export function describeActive(active: ActiveTracker): string {
  if (active.source === "none") return "No task tracker";
  // ("built in": a tracker the code handed the engine, which has no file)
  return active.source === "config" ? `${active.tracker.label} (${active.file}, ${active.hash})` : `${active.tracker.label} (built in)`;
}

/** The trackers folder as `/tracker` lists it: each file's label, name and hash, or what is wrong with it. */
export function describeListing(listing: readonly ConfigListing[], activeFile?: string): string[] {
  return listing.map((entry) => {
    const marker = entry.file === activeFile ? " (active)" : "";
    return entry.ok ? `- **${entry.config.label}**: ${entry.file}, ${entry.hash}${marker}` : `- ${entry.file}: ${entry.errors[0] ?? "invalid"}`;
  });
}
