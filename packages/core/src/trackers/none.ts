/**
 * No task tracker: a null object that stands where the tracker would be, so the
 * parts of ARIA that ask "the tracker" for something keep working with nothing to give. It matches no server, finds
 * no task reference, has no tools, no time logs and no projects, and puts nothing into the Timekeeper's prompt. The
 * places that must behave differently with no tracker ask `isNoTracker`; none of its own words ever reaches the
 * user, so its id, label and placeholder are strings nothing else says.
 */
import type { TaskTracker, TrackerTimekeeperReader } from "./types.ts";

/** What a refusal says when something needs a tracker and there is none. */
export const NO_TRACKER_SET_UP = "No task tracker is set up.";

const reader: TrackerTimekeeperReader = {
  tasks: () => "empty",
  timeLogs: () => "empty",
  projects: () => "empty",
  backfillTaskCache: () => undefined,
  unknownProjectNames: () => [],
};

export const NO_TRACKER: TaskTracker = {
  id: "none",
  label: "Null Tracker",
  info: { id: "none", label: "Null Tracker", taskUrlTemplate: "", taskRefPlaceholder: "Null Tracker task", capabilities: { timeLogs: false, projects: false } },
  matchesServer: () => false,
  serverPreference: () => 0,
  reservedTools: new Set(),
  confirmTools: new Set(),
  parseTaskRef: () => undefined,
  extractTaskRef: () => undefined,
  taskRefFromBranch: () => undefined,
  taskUrl: () => "",
  messages: {
    invalidTaskRef: () => `${NO_TRACKER_SET_UP} Pick one in Customize › Integrations to link tasks.`,
    invalidRuleTaskRef: () => `${NO_TRACKER_SET_UP} Pick one in Customize › Integrations to map work to tasks.`,
  },
  tasks: {
    myTasks: [],
    parse: () => [],
    lastSeenFields: () => ({}),
    isClosedStatus: () => false,
    statusRank: () => 0,
  },
  timekeeper: {
    routes: [],
    createReader: () => reader,
    steps: () => [],
    taskUpdatesName: "",
  },
};

/** Whether this is the null object: there is no task tracker. */
export const isNoTracker = (tracker: TaskTracker): boolean => tracker === NO_TRACKER;
