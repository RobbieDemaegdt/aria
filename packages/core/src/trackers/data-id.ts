/**
 * Whose data the store holds, read straight from the database file. Migration 15 stamps what the database holds with it
 * before any `Store` exists, so this reads the settings and the activities with SQL on a `DatabaseSync`; the `Store`
 * version (`dataTrackerId`, `active.ts`) reads the same three things in the same order. Nothing here names a tracker: the
 * id is whatever the database recorded.
 */
import type { DatabaseSync } from "node:sqlite";

/** The setting next to `integrations.mcpConfig`: which tracker is chosen, and `dataId`, the last real tracker that was active. */
export const TRACKER_SETTING = "integrations.tracker";
/** The tracker watcher's saved state, stamped with the id of the tracker it polled (`trackerId`, migration 14). */
export const SETTING_TRACKER_WATCHER = "watchers.trackerState";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A non-empty string a setting's object holds under `key`. */
const stringAt = (value: unknown, key: string): string | undefined => {
  const found = isRecord(value) ? value[key] : undefined;
  return typeof found === "string" && found ? found : undefined;
};

/**
 * The id of the tracker whose data this database holds: what was recorded when a tracker last became active
 * (`integrations.tracker.dataId`), else the tracker the watcher's state is stamped with, else the prefix of the newest
 * tracker activity's external ID; undefined when there is no evidence (no tracker was ever used).
 */
export function dataTrackerIdRaw(db: DatabaseSync): string | undefined {
  const setting = (key: string): unknown => {
    const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value_json) as unknown;
    } catch {
      return undefined;
    }
  };
  const recorded = stringAt(setting(TRACKER_SETTING), "dataId");
  if (recorded) return recorded;
  const stamped = stringAt(setting(SETTING_TRACKER_WATCHER), "trackerId");
  if (stamped) return stamped;
  const newest = db.prepare("SELECT external_id FROM activities WHERE source = 'tracker' ORDER BY started_at DESC, created_at DESC LIMIT 1").get() as
    | { external_id: string }
    | undefined;
  return newest?.external_id.split(":")[0] || undefined;
}
