/**
 * The task tracker as the window sees it: its name and how to link to a task. Core picks the tracker;
 * `AppState.tracker` carries this.
 */
export interface TrackerInfo {
  /** Stable ID, kept in stored strings (external IDs, card IDs, digest tags). */
  id: string;
  /** What the UI calls it (e.g. "Acme"). */
  label: string;
  /** A task's page, with `{id}` where the task ID goes. */
  taskUrlTemplate: string;
  /** The placeholder of a task-reference input. */
  taskRefPlaceholder: string;
  /** What setup hints call its MCP server (e.g. "Acme Cloud"); they say `label` when there's none. */
  serverHint?: string;
  /**
   * Its time-log tools, by tool name, where the window says what a button calls; set by core from the tracker's time
   * logs. `deleteArgs` is the delete call's arguments as shown (`ids: "{id}", confirm: true`), `{id}` for the entry.
   */
  timeLogTools?: { create: string; delete: string; deleteArgs: string };
  /** Which optional parts it has. */
  capabilities: { timeLogs: boolean; projects: boolean };
}

/**
 * A task's page on the tracker. The ID goes in through a function, so nothing in it is read as a replacement pattern
 * (`encodeURIComponent` escapes `$` already; this doesn't rely on that).
 */
export const trackerTaskUrl = (info: Pick<TrackerInfo, "taskUrlTemplate">, taskId: string): string => {
  const id = encodeURIComponent(taskId.trim());
  return info.taskUrlTemplate.replaceAll("{id}", () => id);
};

/** Which part of a task tracker a tool serves (Customize › Integrations). */
export type TrackerToolPart = "myWork" | "taskDetails" | "registered" | "submit" | "update" | "delete" | "projects" | "test";

/** What a tracker config's tools reach on one of its servers, for one part. */
export interface TrackerToolStatus {
  server: string;
  part: TrackerToolPart;
  /** The tools the config names for this part, in the order they are tried. */
  tools: string[];
  /** The first of them the server has (listed by it, or allowed through its formatted twin); absent: missing. */
  found?: string;
  /** My work and Submit, Update and Delete need a tool; a missing required part is a warning, never a block. */
  required: boolean;
  /** Found only through its formatted twin, which the runtime's own tool list hides: ARIA reaches it only when it calls the server itself (a saved token, a key in the address, a local process). */
  directOnly?: true;
}

/** One file of the trackers folder. */
export interface TrackerConfigListing {
  id: string;
  /** Absent when the file doesn't load. */
  label?: string;
  file: string;
  /** The first 8 hex digits of SHA-256 of the canonical JSON; absent when the file doesn't load. */
  hash?: string;
  /** Why the file can't be used (its first lines), when it can't. */
  error?: string;
  /** The servers in your setup whose names this config matches. */
  suggestedServers: string[];
}

/** The task tracker in Customize › Integrations: the one in use, the configs in the trackers folder, and the tools each server has. */
export interface TrackerSetup {
  /** The tracker in use; absent when there is none. */
  active?: {
    id: string;
    label: string;
    /** The config's file name and hash; absent for a tracker the code handed the engine (`builtIn`: tests). */
    file?: string;
    hash?: string;
    builtIn?: true;
    /** The servers it reads from, in order of preference. */
    servers: string[];
    /** The servers were chosen in Customize (else the config's own `servers.match` finds them). */
    explicitServers: boolean;
  };
  /** Why the config the setting names isn't the one in use (it didn't load at start, or its file has gone wrong since). */
  error?: string;
  configs: TrackerConfigListing[];
  /** Per tracker server: which of the active config's tools it has. */
  tools: TrackerToolStatus[];
}

/** What another tracker's data in the store comes to: what switching to a tracker with another id would leave dormant, or clear. */
export interface TrackerPurgeCounts {
  cachedTasks: number;
  /** Mapping rules that name a task of another tracker (a rule of minutes only isn't tracker data). */
  rules: number;
  /** Draft rows with a task of another tracker. */
  draftRowsWithTasks: number;
  /** Registered entries of another tracker: they stay as history whether it is kept or cleared. */
  registeredRows: number;
  /** Activities linked to a task of another tracker. */
  linkedActivities: number;
}

/** What choosing a task tracker would do (`previewTrackerChange`): why it is refused, or what it reaches. */
export interface TrackerChangePreview {
  /** Why the change would be refused now; absent when it can go ahead. */
  refusal?: string;
  /** The config's label; absent for no tracker. */
  label?: string;
  /** The config's tools on each server it would use. */
  tools: TrackerToolStatus[];
  /** The read tools ARIA would call without asking. */
  reads: string[];
  /** The write tools reserved for the Time view. */
  reserved: string[];
  /**
   * Set when the store holds another tracker's data and the choice is a tracker with another id: the question the
   * window asks, keep it or clear it. `from` is that tracker's id (empty when the data doesn't say whose it is) and `fromLabel`
   * what to call it. Choosing no tracker never asks.
   */
  purge?: { from: string; fromLabel: string; counts: TrackerPurgeCounts };
}

/** What importing a config file did. */
export type TrackerImportResult =
  | {
      status: "imported";
      id: string;
      label: string;
      file: string;
      hash: string;
      /** It took the place of a file with the same name. */
      replaced: boolean;
      /** The read tools ARIA calls without asking, and the write tools reserved for the Time view. */
      reads: string[];
      reserved: string[];
      /** More the window should say (e.g. the active config was reloaded, or couldn't be yet). */
      note?: string;
    }
  | { status: "invalid"; errors: string[] }
  | { status: "canceled" }
  | { status: "failed"; error: string };
