/**
 * The reserved and confirm tool sets the action checks read. They stay by tool
 * name on every server, and they are the union over every valid config in the trackers folder, active or not, plus the
 * trackers given (the active one and the built-in one while it exists). So a tracker's write tools stay reserved for the
 * Time view with no tracker or another tracker active, as long as its config is in the folder: the safe direction.
 */
import type { ActionTracker } from "../integrations/actions.ts";
import type { ConfigListing } from "./config/load.ts";

/** What a tracker contributes: the write tools only the Time view calls, and the ones that need `confirm: true`. */
export type ToolSetSource = Pick<ActionTracker, "reservedTools" | "confirmTools">;

/** The tool names are compared in lower case, as the action checks do. */
const lowerAll = (names: Iterable<string>, into: Set<string>): void => {
  for (const name of names) into.add(name.trim().toLowerCase());
};

/** The union of the sets of `sources` and of every valid config in `listing`. */
export function unionToolSets(sources: readonly ToolSetSource[], listing: readonly ConfigListing[]): ActionTracker {
  const reserved = new Set<string>();
  const confirm = new Set<string>();
  for (const source of sources) {
    lowerAll(source.reservedTools, reserved);
    lowerAll(source.confirmTools, confirm);
  }
  for (const entry of listing) {
    if (!entry.ok) continue;
    lowerAll(entry.config.tools.reserved, reserved);
    lowerAll(entry.config.tools.confirm, confirm);
  }
  return { reservedTools: reserved, confirmTools: confirm };
}
