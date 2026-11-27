/**
 * The task tracker as the window paints it.
 * Pure and total: until the state arrives (no `tracker` yet) they paint neutral words and no link. `useTracker` (in the
 * store) reads the active one.
 */
import { trackerTaskUrl, type TrackerInfo } from "@aria/protocol";
import { openPage } from "./openPage";

/** What the UI calls the tracker ("Tracker" until the state arrives). */
export const trackerLabel = (tracker: TrackerInfo | undefined): string => tracker?.label ?? "Tracker";

/** "<label> #<id>" ("Task #<id>" until the state arrives). */
export const trackerRef = (tracker: TrackerInfo | undefined, id: string): string => `${tracker?.label ?? "Task"} #${id}`;

/**
 * Whether a stored task ID is of the tracker in use: an ARIA task's, a timesheet row's or a registered entry's
 * `trackerId`, or the tracker a card's ID starts with. Only then does the window build a link from the tracker's page
 * template; an ID of another tracker (or one that says nothing) is shown as plain text. Until the state arrives there is no
 * tracker and no link to build, so the words paint as they do then (neutral).
 */
export const ownsTask = (tracker: TrackerInfo | undefined, owner: string | undefined): boolean => tracker === undefined || (owner !== undefined && owner === tracker.id);

/** A task's page on the tracker; undefined (no link) until the state arrives. */
export const trackerTaskLink = (tracker: TrackerInfo | undefined, taskId: string): string | undefined =>
  tracker ? trackerTaskUrl(tracker, taskId) : undefined;

/** Opens a task's page on the tracker; nothing until the state arrives. */
export function openTrackerTask(tracker: TrackerInfo | undefined, taskId: string): void {
  const url = trackerTaskLink(tracker, taskId);
  if (url) openPage(url);
}

/** The placeholder of a task-reference input. */
export const trackerTaskRefPlaceholder = (tracker: TrackerInfo | undefined): string => tracker?.taskRefPlaceholder ?? "Task ID";

/** What setup hints call the tracker's MCP server: its own name for it, else its label. */
export const trackerServerHint = (tracker: TrackerInfo | undefined): string => tracker?.serverHint ?? trackerLabel(tracker);

/** " via <its create tool>" for a Submit button's tooltip; nothing when the tracker names no time-log tools. */
export const viaCreateTool = (tracker: TrackerInfo | undefined): string => (tracker?.timeLogTools ? ` via ${tracker.timeLogTools.create}` : "");

/**
 * The call Delete makes for one entry, as the confirmation box shows it; undefined when the tracker names no time-log tools.
 * The ID goes in through a function, so a `$&` or `$'` in it is put in as it is, not read as a replacement pattern.
 */
export const deleteCall = (tracker: TrackerInfo | undefined, entryId: string): { tool: string; args: string } | undefined =>
  tracker?.timeLogTools ? { tool: tracker.timeLogTools.delete, args: tracker.timeLogTools.deleteArgs.replaceAll("{id}", () => entryId) } : undefined;

/** How an ask-about-a-task prefill starts: `About <label> task #` (`About task #` until the state arrives). */
export const askAboutTaskPrefix = (tracker: TrackerInfo | undefined): string => `About ${tracker ? `${tracker.label} ` : ""}task #`;

/** The Chat prefill that asks ARIA about a task: `About <label> task #<id> ("<title>"): `. */
export const askAboutTaskPrefill = (tracker: TrackerInfo | undefined, taskId: string, title: string): string =>
  `${askAboutTaskPrefix(tracker)}${taskId} ("${title}"): `;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** An earlier ask-about-a-task prefill at the start of the composer's text, which a new one replaces. */
export const askAboutTaskPattern = (tracker: TrackerInfo | undefined): RegExp =>
  new RegExp(`^${escapeRegExp(askAboutTaskPrefix(tracker))}[^\\s(]+\\s*\\([\\s\\S]*?\\):\\s*`);

/**
 * The composer's text with `prefill` put in: as it is when it already starts with it; an ask-about-a-task prefill in place
 * of an earlier one; else in front. The prefill goes in through a function, so a `$&` in a task's title stays as it is.
 */
export const prefilledText = (tracker: TrackerInfo | undefined, current: string, prefill: string): string => {
  if (current.startsWith(prefill)) return current;
  const asked = askAboutTaskPattern(tracker);
  if (prefill.startsWith(askAboutTaskPrefix(tracker)) && asked.test(current)) return current.replace(asked, () => prefill);
  return prefill + current;
};
