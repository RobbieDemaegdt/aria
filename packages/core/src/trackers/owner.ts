/**
 * Whose a stored task ID is: an ARIA task, a mapping rule, a timesheet row, a
 * registered entry and an activity's link each carry the id of the tracker their task ID belongs to. Only the tracker in
 * use can look such an ID up, submit it or link to it; one of another tracker is dormant (kept, never used or shown as a
 * link of this tracker's).
 */
import type { TaskTracker } from "./types.ts";

/**
 * Whether data stamped `owner` is `tracker`'s. Data with no stamp is taken as the tracker in use's: core stamps every
 * task it stores, so a missing stamp only comes from a caller that has no other tracker in mind.
 */
export const ownedBy = (tracker: Pick<TaskTracker, "id">, owner: string | null | undefined): boolean => owner === undefined || owner === null || owner === tracker.id;
