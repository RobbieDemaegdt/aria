import type { DatabaseSync } from "node:sqlite";
import { dataTrackerIdRaw } from "../trackers/data-id.ts";

/**
 * One step of the schema. It runs in its own transaction; `notes` says what it did, for the log. `backup`: an existing
 * database is copied before the first pending step that has it (`Store.migrate`), because the step rewrites data that
 * going back would need.
 */
export interface Migration {
  name: string;
  backup?: true;
  run(db: DatabaseSync, notes: string[]): void;
}

/**
 * ARIA's schema before version 15 is one step: every database at this version has
 * the baseline schema, and a new one gets it in one step. The 14 steps that led here are history, kept outside this
 * repository; a database from before it is refused (`Store.migrate`), with no release named.
 */
export const BASELINE_VERSION = 14;

/** Creates the version-14 schema directly, with the tracker names (no history, no names of any one tracker). */
export const BASELINE: Migration = { name: "baseline", run: createBaselineSchema };

/** After the baseline: index 0 is version 15. Append-only, `PRAGMA user_version` counts them from `BASELINE_VERSION`. */
export const MIGRATIONS: readonly Migration[] = [{ name: "tracker ids", backup: true, run: migrateTrackerIds }];

/** The version a database ends at. */
export const LATEST_VERSION = BASELINE_VERSION + MIGRATIONS.length;

/**
 * The schema at version 14, table by table in the order the old history created them (and with the columns added later
 * where `ALTER TABLE ... ADD COLUMN` left them: last), with the tracker's names the 14th step gave them.
 */
const BASELINE_SQL = `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );
  CREATE TABLE timeline (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX timeline_created ON timeline (created_at);
  CREATE TABLE repos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    -- pathKey(path): one project per folder, compared the way Windows compares paths (util/paths.ts)
    path_key TEXT NOT NULL UNIQUE,
    owner TEXT,
    repo TEXT,
    default_branch TEXT,
    added_via TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    host TEXT,
    -- a fork's upstream remote, "owner/repo", only when it's on github.com
    upstream TEXT,
    -- 'folder' for a non-git local folder; NULL or 'git' for a git repository
    kind TEXT
  );
  -- Worker profiles and background tasks keep a few columns for lookups and the rest as JSON, so later phases can add
  -- fields without a migration.
  CREATE TABLE profiles (
    id TEXT PRIMARY KEY,
    -- lowercased name: profile names are unique regardless of letter case
    name_key TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    data_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    repo_id INTEGER NOT NULL,
    state TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    data_json TEXT NOT NULL
  );
  CREATE INDEX tasks_state ON tasks (state);
  CREATE INDEX tasks_repo ON tasks (repo_id, created_at);
  -- Customize › Prompts keeps every saved version; the newest one is in use.
  CREATE TABLE prompt_versions (
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    text TEXT NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (name, version)
  );
  -- "Save as memory" notes for task briefs: your own words, one line each.
  CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
    -- set for 'project'
    repo_id INTEGER,
    text TEXT NOT NULL,
    -- where it came from: { kind, taskId?, taskTitle?, at }
    source_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX memories_repo ON memories (repo_id);
  -- GitHub watches: a few columns for lookups, the rest as JSON, like tasks. No CHECK on the kind or state: they're
  -- checked when read (a later phase's kind needs no table rebuild). target_key is what's watched (watchers/types.ts);
  -- only one active watch has it.
  CREATE TABLE watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    repo_id INTEGER,
    target_key TEXT NOT NULL,
    created_by TEXT NOT NULL,
    task_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ended_at INTEGER,
    data_json TEXT NOT NULL
  );
  CREATE INDEX watches_state ON watches (state);
  CREATE UNIQUE INDEX watches_active_target ON watches (target_key) WHERE state = 'active';
  -- Work-tracking activities, the tracker's mapping rules and the tracker's tasks cache.
  CREATE TABLE activities (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    repo_id INTEGER,
    external_id TEXT NOT NULL,
    title TEXT NOT NULL,
    linked_tracker_task_id TEXT,
    manual_link INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (source, external_id)
  );
  CREATE INDEX activities_ended_started ON activities (ended_at, started_at);
  CREATE INDEX activities_repo ON activities (repo_id, started_at);
  CREATE TABLE time_rules (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    match_json TEXT NOT NULL,
    tracker_task_id TEXT NOT NULL,
    tracker_task_title TEXT,
    created_from TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE tracker_tasks_cache (
    task_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    project_id TEXT,
    customer_id TEXT,
    status TEXT,
    last_seen_json TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  CREATE TABLE timesheet_entries (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    minutes INTEGER NOT NULL,
    tracker_task_id TEXT,
    tracker_task_title TEXT,
    tracker_project_id TEXT,
    tracker_customer_id TEXT,
    comment TEXT NOT NULL,
    sources_json TEXT NOT NULL DEFAULT '[]',
    mapped_by TEXT NOT NULL,
    confidence TEXT NOT NULL,
    uncertainty_reason TEXT,
    state TEXT NOT NULL DEFAULT 'draft',
    tracker_entry_id TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX timesheet_entries_date ON timesheet_entries (date, start_time);
  -- Search across session transcripts.
  CREATE TABLE session_transcripts (
    owner_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    entry_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    search_text TEXT NOT NULL,
    entry_json TEXT NOT NULL,
    PRIMARY KEY (owner_id, entry_id)
  );
  CREATE INDEX session_transcripts_owner_seq ON session_transcripts (owner_id, seq);
  -- Routines and reminders.
  CREATE TABLE routines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    cron TEXT NOT NULL,
    prompt TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    run_on_first_open INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    last_run_at INTEGER,
    last_run_date TEXT,
    last_status TEXT,
    last_result TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE reminders (
    id TEXT PRIMARY KEY,
    short_id TEXT NOT NULL,
    text TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    snoozed_count INTEGER NOT NULL DEFAULT 0,
    card_id TEXT,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX reminders_status_due ON reminders (status, due_at);
  -- Finding cards by type, and your last message, without reading the timeline.
  CREATE INDEX timeline_card_type ON timeline (json_extract(content_json, '$.cardType'), created_at) WHERE kind = 'card';
  CREATE INDEX timeline_user_chat ON timeline (created_at) WHERE kind = 'chat' AND json_extract(content_json, '$.role') = 'user';
  -- Owners whose old tool calls, permission lines and reasoning were cleaned up, and when. A step of those kinds from
  -- before then is never saved for them again, so reading the task's session doesn't fill it back in. \`complete\` once
  -- all of them are deleted: a clean-up ARIA quit during carries on at the next one.
  CREATE TABLE transcript_pruned (
    owner_id TEXT PRIMARY KEY,
    pruned_at INTEGER NOT NULL,
    complete INTEGER NOT NULL DEFAULT 0
  );
`;

function createBaselineSchema(db: DatabaseSync): void {
  db.exec(BASELINE_SQL);
}

/**
 * Tracker data that knows its tracker. The id is `dataTrackerIdRaw` of the database (what was recorded when a
 * tracker last became active, else the tracker the watcher state is stamped with, else the newest tracker activity's
 * prefix), worked out before any SQL runs: no tracker is named here. With no evidence it is NULL, and cache rows get ''
 * (no tracker matches those; the purge offers to clear them).
 *
 * - the cache is keyed by `(tracker_id, task_id)`, so two trackers' tasks with the same ID are two rows;
 * - a rule that names a task, a timesheet row that has a task or a registered entry, and an activity linked to a task get
 *   `tracker_id`, `tracker_id` and `linked_tracker_id`; a rule of minutes only isn't tracker data and stays unstamped;
 * - an ARIA task that has a `trackerTaskId` gets `trackerId` in its JSON.
 *
 * Not stamped: cards (history), the Outlook watcher's messages (they expire) and the watcher state (it has `trackerId`).
 */
function migrateTrackerIds(db: DatabaseSync, notes: string[]): void {
  const id = dataTrackerIdRaw(db) ?? null;
  db.exec(`
    CREATE TABLE tracker_tasks_cache_v15 (
      tracker_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      project_id TEXT,
      customer_id TEXT,
      status TEXT,
      last_seen_json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (tracker_id, task_id)
    );
  `);
  const cached = db
    .prepare(
      `INSERT INTO tracker_tasks_cache_v15 (tracker_id, task_id, title, project_id, customer_id, status, last_seen_json, fetched_at)
       SELECT COALESCE(?, ''), task_id, title, project_id, customer_id, status, last_seen_json, fetched_at FROM tracker_tasks_cache`,
    )
    .run(id);
  db.exec("DROP TABLE tracker_tasks_cache; ALTER TABLE tracker_tasks_cache_v15 RENAME TO tracker_tasks_cache;");
  db.exec("ALTER TABLE time_rules ADD COLUMN tracker_id TEXT");
  const rules = db.prepare("UPDATE time_rules SET tracker_id = ? WHERE tracker_task_id <> ''").run(id);
  db.exec("ALTER TABLE timesheet_entries ADD COLUMN tracker_id TEXT");
  const entries = db.prepare("UPDATE timesheet_entries SET tracker_id = ? WHERE tracker_task_id IS NOT NULL OR tracker_entry_id IS NOT NULL").run(id);
  db.exec("ALTER TABLE activities ADD COLUMN linked_tracker_id TEXT");
  const activities = db.prepare("UPDATE activities SET linked_tracker_id = ? WHERE linked_tracker_task_id IS NOT NULL").run(id);

  // The JSON of ARIA's own tasks: a task linked to a tracker task says whose.
  let tasks = 0;
  let unreadable = 0;
  if (id !== null) {
    const rows = db.prepare("SELECT id, data_json FROM tasks WHERE data_json LIKE '%trackerTaskId%'").all() as Array<{ id: string; data_json: string }>;
    const update = db.prepare("UPDATE tasks SET data_json = ? WHERE id = ?");
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.data_json);
      } catch {
        unreadable++;
        continue;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      const task = parsed as Record<string, unknown>;
      if (typeof task.trackerTaskId !== "string" || !task.trackerTaskId || Object.hasOwn(task, "trackerId")) continue;
      update.run(JSON.stringify({ ...task, trackerId: id }), row.id);
      tasks++;
    }
  }
  notes.push(
    `Tracker ids: ${id === null ? "no evidence of whose tracker data this is" : `stamped with "${id}"`}: ` +
      `${Number(cached.changes)} cached task${Number(cached.changes) === 1 ? "" : "s"}, ${Number(rules.changes)} rule${Number(rules.changes) === 1 ? "" : "s"}, ` +
      `${Number(entries.changes)} timesheet row${Number(entries.changes) === 1 ? "" : "s"}, ${Number(activities.changes)} linked activit${Number(activities.changes) === 1 ? "y" : "ies"}, ` +
      `${tasks} ARIA task${tasks === 1 ? "" : "s"}` +
      (unreadable > 0 ? `, ${unreadable} unreadable task row${unreadable === 1 ? "" : "s"} left as they are` : "") +
      ".",
  );
}
