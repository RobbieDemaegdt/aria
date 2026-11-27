/**
 * The tracker as the window sees it (`AppState.tracker`): its own `info`, plus the names of the time-log tools its
 * Submit and Delete buttons call, taken from its `timeLogs` so the window never names another tracker's tools.
 */
import type { TrackerInfo } from "@aria/protocol";
import { confirmPropertyName } from "../integrations/actions.ts";
import { isNoTracker } from "./none.ts";
import type { TaskTracker } from "./types.ts";

/** Where the entry's ID goes in `deleteArgs`. */
const ENTRY_ID = "{id}";

/** `AppState.tracker`; undefined when there is no tracker, so the window shows none of its parts. */
export function windowTrackerInfo(tracker: TaskTracker): TrackerInfo | undefined {
  if (isNoTracker(tracker)) return undefined;
  const timeLogs = tracker.timeLogs;
  if (!timeLogs) return tracker.info;
  // As Delete sends it: the tracker's arguments, plus the confirmation flag a destructive call gets.
  const confirm = confirmPropertyName(tracker, timeLogs.delete.tool);
  const args: Record<string, unknown> = { ...timeLogs.delete.args([ENTRY_ID], "display"), ...(confirm ? { [confirm]: true } : {}) };
  return {
    ...tracker.info,
    timeLogTools: {
      create: timeLogs.create.tool,
      delete: timeLogs.delete.tool,
      deleteArgs: Object.entries(args)
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join(", "),
    },
  };
}
