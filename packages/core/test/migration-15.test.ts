/**
 * The baseline and the numbering, migration 15, tracker ids, and the copy
 * of the database taken before it. A new database gets the version-14 schema in one step and then 15; one at version 14 is
 * migrated; one from before 14 is refused, naming the release that still has the whole history; one above 15 is a newer
 * ARIA's. Migration 15 stamps what the store holds with the id of the tracker it is of, from the evidence the database
 * has; an existing database is copied first, with room for it checked, and nothing changes when the copy can't be made.
 * The history before the baseline is checked against it in tests kept outside this repository. The tracker ids here
 * are made up.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/index.ts";
import { BASELINE, BASELINE_VERSION, LATEST_VERSION, MIGRATIONS } from "../src/store/migrations.ts";
import { backupRoom, type StoreOptions } from "../src/store/store.ts";
import "./no-network.ts";

const SCHEMA_V15 = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/schema-v15.json", import.meta.url)), "utf8")) as unknown;
const DATE = "2026-10-23";
const MB = 1024 * 1024;

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  vi.useRealTimers();
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aria-migration-15-"));
  dirs.push(dir);
  return dir;
}

/** What a tracker's data looks like at version 14: two cached tasks, two rules (one of minutes only), three rows, links and tasks. */
const SEED = `
  INSERT INTO tracker_tasks_cache (task_id, title, project_id, customer_id, status, last_seen_json, fetched_at)
    VALUES ('A-1', 'One', 'p1', 'c1', 'Open', '{}', 1), ('A-2', 'Two', NULL, NULL, NULL, '{}', 2);
  INSERT INTO time_rules (id, source, match_json, tracker_task_id, tracker_task_title, created_from, enabled, created_at, updated_at)
    VALUES ('r-task', 'mail_subject', '{"kind":"mail_subject","pattern":"Weekly"}', 'A-1', 'One', 'you', 1, 1, 1),
           ('r-minutes', 'mail_subject', '{"kind":"mail_subject","pattern":"Daily","defaultMinutes":30}', '', NULL, 'you', 1, 1, 1);
  INSERT INTO timesheet_entries (id, date, start_time, end_time, minutes, tracker_task_id, tracker_entry_id, comment, mapped_by, confidence, state, created_at, updated_at)
    VALUES ('e-draft', '${DATE}', '09:00', '10:00', 60, 'A-1', NULL, 'Work', 'you', 'certain', 'draft', 1, 1),
           ('e-reg', '${DATE}', '10:00', '11:00', 60, 'A-1', '9001', 'Done', 'you', 'certain', 'submitted', 1, 1),
           ('e-none', '${DATE}', '11:00', '12:00', 60, NULL, NULL, 'Nothing', 'you', 'certain', 'draft', 1, 1);
  INSERT INTO activities (id, source, kind, started_at, ended_at, external_id, title, linked_tracker_task_id, manual_link, metadata_json, created_at, updated_at)
    VALUES ('a-link', 'git', 'commit', 1, 1, 'commit:1', 'Fix A-1', 'A-1', 0, '{}', 1, 1),
           ('a-plain', 'git', 'commit', 2, 2, 'commit:2', 'Other', NULL, 0, '{}', 1, 1);
  INSERT INTO tasks (id, repo_id, state, archived, created_at, updated_at, data_json)
    VALUES ('t-linked', 1, 'done', 0, 1, 1, '{"id":"t-linked","trackerTaskId":"A-1","trackerTaskManual":true}'),
           ('t-plain', 1, 'done', 0, 1, 1, '{"id":"t-plain","title":"No link"}'),
           ('t-broken', 1, 'done', 0, 1, 1, '{"trackerTaskId": broken');
`;

/** The evidence of whose data it is, kinds that rank in this order: the recorded id, the watcher's stamp, the newest tracker activity. */
const RECORDED = `INSERT INTO settings (key, value_json) VALUES ('integrations.tracker', '{"config":"globex","dataId":"globex"}');`;
const STAMPED = `INSERT INTO settings (key, value_json) VALUES ('watchers.trackerState', '{"baselined":true,"trackerId":"acme"}');`;
const ACTIVITIES = `
  INSERT INTO activities (id, source, kind, started_at, ended_at, external_id, title, manual_link, metadata_json, created_at, updated_at)
    VALUES ('u-old', 'tracker', 'task_updated', 3, 4, 'older:7:updated:2026-10-22', 'Old update', 0, '{}', 1, 1),
           ('u-new', 'tracker', 'task_updated', 5, 6, 'newest:8:updated:2026-10-23', 'New update', 0, '{}', 1, 1);
`;

/** A version-14 database: the baseline, as the app writes it, and `extraSql` on it. */
function baselineDb(file: string, extraSql = ""): void {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  BASELINE.run(db, []);
  db.exec(`PRAGMA user_version = ${BASELINE_VERSION}`);
  if (extraSql) db.exec(extraSql);
  db.close();
}

function open(file: string, options?: StoreOptions): Store {
  const store = new Store(file, options);
  stores.push(store);
  return store;
}

/** The error `new Store(file, options)` throws. */
function openError(file: string, options?: StoreOptions): Error {
  try {
    new Store(file, options).close();
  } catch (error) {
    return error as Error;
  }
  throw new Error("the store opened");
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The backups next to `file` that took a name of their own (`<file>.pre-v15.<yyyyMMdd-HHmmss>.bak`). */
const namedBackups = (file: string): string[] =>
  readdirSync(path.dirname(file))
    .filter((name) => new RegExp(`^${escapeRe(path.basename(file))}\\.pre-v15\\.\\d{8}-\\d{6}\\.bak$`).test(name))
    .map((name) => path.join(path.dirname(file), name));

function readOnly<T>(file: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

const userVersion = (file: string): number => readOnly(file, (db) => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);

/** Every row of every table, by table, as SQLite returns it. */
const dump = (file: string): Record<string, Array<Record<string, unknown>>> =>
  readOnly(file, (db) => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    return Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all() as Array<Record<string, unknown>>]));
  });

/** The schema as `fixtures/schema-v15.json` describes it: tables, columns (name, type, not null, default, key) and indexes. */
const describeSchema = (file: string): unknown =>
  readOnly(file, (db) => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    return {
      version: (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      tables: tables.map((name) => ({
        name,
        columns: (db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>).map((c) => ({
          name: c.name,
          type: c.type,
          notNull: c.notnull === 1,
          default: c.dflt_value,
          primaryKey: c.pk,
        })),
        indexes: (db.prepare(`PRAGMA index_list("${name}")`).all() as Array<{ name: string; unique: number; origin: string; partial: number }>)
          .map((index) => ({
            name: index.name,
            unique: index.unique === 1,
            origin: index.origin,
            partial: index.partial === 1,
            columns: (db.prepare(`PRAGMA index_info("${index.name}")`).all() as Array<{ name: string | null }>).map((c) => c.name),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      })),
    };
  });

/** The size of a copy of the database: its pages but the free ones. */
const copyBytes = (file: string): number =>
  readOnly(file, (db) => {
    const pragma = (name: string) => (db.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[name]!;
    return (pragma("page_count") - pragma("freelist_count")) * pragma("page_size");
  });

/** The room the backup asks for: the copy, plus 10% of it and at least 16 MB for the migration's WAL. */
const roomBytes = (file: string): number => {
  const copy = copyBytes(file);
  return copy + Math.max(16 * MB, Math.ceil(copy / 10));
};

const driveName = (file: string): string => (process.platform === "win32" ? `on ${path.parse(file).root.slice(0, 2).toUpperCase()}` : `on the drive with ${path.dirname(file)}`);

/** The start error for a drive without that room. */
const noRoom = (file: string): string =>
  `ARIA needs about ${Math.ceil(roomBytes(file) / MB)} MB free ${driveName(file)} to back up its database before updating it. Free some space and start ARIA again; your data hasn't changed.`;

describe("the baseline and the numbering", () => {
  it("is version 14 with one step after it, so the latest is 15", () => {
    expect(BASELINE_VERSION).toBe(14);
    expect(MIGRATIONS.map((m) => [m.name, m.backup])).toEqual([["tracker ids", true]]);
    expect(LATEST_VERSION).toBe(15);
  });

  it("gives a new database the version-15 schema in one go: every table, column and index, with no backup", () => {
    const file = path.join(tempDir(), "aria.db");
    const store = open(file);
    expect(describeSchema(file)).toEqual(SCHEMA_V15);
    expect(userVersion(file)).toBe(15);
    expect(existsSync(`${file}.pre-v15.bak`)).toBe(false);
    expect(namedBackups(file)).toEqual([]);
    // Nothing to stamp: no tracker was ever used.
    expect(store.migrationNotes).toEqual(['Tracker ids: no evidence of whose tracker data this is: 0 cached tasks, 0 rules, 0 timesheet rows, 0 linked activities, 0 ARIA tasks.']);
  });

  it("gives an in-memory database the same schema", () => {
    const file = path.join(tempDir(), "memory-check.db");
    const memory = new Store(":memory:");
    memory.setSetting("kept", true);
    memory.close();
    // The file one is the reference; the in-memory one must open at all, with the same steps.
    open(file);
    expect(describeSchema(file)).toEqual(SCHEMA_V15);
  });

  it("migrates a version-14 database the baseline wrote to 15, keeping what is in it (not read as a newer ARIA's)", () => {
    const file = path.join(tempDir(), "aria.db");
    baselineDb(file, `INSERT INTO settings (key, value_json) VALUES ('kept', '{"yes":true}'); INSERT INTO memories (id, scope, text, created_at, updated_at) VALUES ('m', 'global', 'kept', 1, 1);`);
    const store = open(file);
    expect(userVersion(file)).toBe(15);
    expect(store.getSetting("kept")).toEqual({ yes: true });
    expect(store.listMemories()).toMatchObject([{ id: "m", scope: "global", text: "kept" }]);
    expect(describeSchema(file)).toEqual(SCHEMA_V15);
  });

  it.each([1, 3, 7, 13])("refuses a version-%i database, which this version can't update, naming no release, and leaves it as it was", (version) => {
    const file = path.join(tempDir(), "aria.db");
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL); INSERT INTO settings VALUES ('kept', '1'); PRAGMA user_version = ${version}`);
    db.close();
    const before = dump(file);
    const message = openError(file).message;
    expect(message).toBe(`This database is version ${version}, and this version of ARIA can't update it.`);
    expect(message).not.toMatch(/v\d+\.\d+|release|Open it once/i);
    expect(userVersion(file)).toBe(version);
    expect(dump(file)).toEqual(before);
    expect(existsSync(`${file}.pre-v14.bak`) || existsSync(`${file}.pre-v15.bak`)).toBe(false);
  });

  it("refuses a database from a newer ARIA, naming the version this one knows", () => {
    const file = path.join(tempDir(), "aria.db");
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA user_version = ${LATEST_VERSION + 1}`);
    db.close();
    expect(openError(file).message).toBe(
      `This database is version 16, written by a newer ARIA (this one knows up to version 15). Update ARIA, or restore a backup from before the update.`,
    );
    expect(userVersion(file)).toBe(16);
  });

  it("leaves a database at 15 as it is", () => {
    const file = path.join(tempDir(), "aria.db");
    open(file).close();
    stores.pop();
    const before = dump(file);
    const store = open(file);
    expect(store.migrationNotes).toEqual([]);
    expect(dump(file)).toEqual(before);
    expect(existsSync(`${file}.pre-v15.bak`)).toBe(false);
  });
});

describe("migration 15: tracker ids", () => {
  /** What the store says of the seed once it is migrated, for the tracker `id` (or nobody's, `""`). */
  function stamped(file: string, id: string | null) {
    const store = open(file);
    const owner = id ?? "none";
    const raw = readOnly(file, (db) => ({
      rules: db.prepare("SELECT id, tracker_id FROM time_rules ORDER BY id").all() as Array<{ id: string; tracker_id: string | null }>,
      tasks: db.prepare("SELECT id, data_json FROM tasks ORDER BY id").all() as Array<{ id: string; data_json: string }>,
    }));
    return {
      store,
      cache: store.listTrackerTaskCache(id ?? "").map((e) => e.taskId).sort(),
      otherCache: store.listTrackerTaskCache(`not-${owner}`),
      rules: raw.rules,
      rows: store.listTimesheetEntries(DATE).map((e) => [e.id, e.trackerId]),
      links: store.listActivities({ source: "git" }).map((a) => [a.id, a.linkedTrackerId]),
      tasks: raw.tasks.map((t) => [t.id, t.data_json.includes('"trackerId"') ? (JSON.parse(t.data_json) as { trackerId?: string }).trackerId : undefined]),
    };
  }

  it.each([
    ["the id recorded when a tracker last became active", RECORDED, "globex"],
    ["the id the watcher's state is stamped with", STAMPED, "acme"],
    ["the prefix of the newest tracker activity's external ID", ACTIVITIES, "newest"],
  ])("stamps everything with %s", (_what, evidence, id) => {
    const file = path.join(tempDir(), "aria.db");
    baselineDb(file, SEED + evidence);
    const result = stamped(file, id);
    // The cache moves under the id; a task of no other tracker's is found under it only.
    expect(result.cache).toEqual(["A-1", "A-2"]);
    expect(result.otherCache).toEqual([]);
    expect(result.store.listTrackerTaskCache("")).toEqual([]);
    // A rule that names a task, a row with a task or a registered entry, a link and an ARIA task get it; what names no task doesn't.
    expect(result.rules).toEqual([
      { id: "r-minutes", tracker_id: null },
      { id: "r-task", tracker_id: id },
    ]);
    expect(result.rows).toEqual([
      ["e-draft", id],
      ["e-reg", id],
      ["e-none", undefined],
    ]);
    expect(result.links).toEqual([
      ["a-link", id],
      ["a-plain", undefined],
    ]);
    expect(result.tasks).toEqual([
      ["t-broken", undefined],
      ["t-linked", id],
      ["t-plain", undefined],
    ]);
    expect(result.store.migrationNotes.at(-1)).toBe(
      `Tracker ids: stamped with "${id}": 2 cached tasks, 1 rule, 2 timesheet rows, 1 linked activity, 1 ARIA task, 1 unreadable task row left as they are.`,
    );
    // A task keeps the rest of its JSON, and a task with an id already keeps that one.
    const [, linked] = result.tasks.map((t) => t);
    expect(linked).toEqual(["t-linked", id]);
  });

  it("takes the recorded id before the watcher's stamp, and that before the newest activity", () => {
    const first = path.join(tempDir(), "first.db");
    baselineDb(first, SEED + ACTIVITIES + STAMPED + RECORDED);
    expect(stamped(first, "globex").cache).toEqual(["A-1", "A-2"]);
    const second = path.join(tempDir(), "second.db");
    baselineDb(second, SEED + ACTIVITIES + STAMPED);
    expect(stamped(second, "acme").cache).toEqual(["A-1", "A-2"]);
    // A stamp or a setting that isn't readable is no evidence.
    const third = path.join(tempDir(), "third.db");
    baselineDb(third, SEED + ACTIVITIES + `INSERT INTO settings (key, value_json) VALUES ('watchers.trackerState', 'not json'), ('integrations.tracker', '{"dataId": 7}');`);
    expect(stamped(third, "newest").cache).toEqual(["A-1", "A-2"]);
  });

  it("with no evidence, leaves the cache under no tracker's id, the rest unstamped, and says so", () => {
    const file = path.join(tempDir(), "aria.db");
    baselineDb(file, SEED);
    const result = stamped(file, null);
    expect(result.cache).toEqual(["A-1", "A-2"]);
    expect(result.rules).toEqual([
      { id: "r-minutes", tracker_id: null },
      { id: "r-task", tracker_id: null },
    ]);
    expect(result.rows.map(([, id]) => id)).toEqual([undefined, undefined, undefined]);
    expect(result.links.map(([, id]) => id)).toEqual([undefined, undefined]);
    expect(result.tasks.map(([, id]) => id)).toEqual([undefined, undefined, undefined]);
    // Nobody's: the cache and the rule belong to no tracker, so one that is chosen later asks what to do with them.
    expect(result.store.listTimeRules("acme").map((r) => r.id)).toEqual(["r-minutes"]);
    expect(result.store.trackerPurgeCounts("acme")).toMatchObject({ cachedTasks: 2, rules: 1 });
    expect(result.store.otherTrackerIds("acme")).toEqual([""]);
    // The note counts what has a tracker's data and got no id (an ARIA task isn't touched without one).
    expect(result.store.migrationNotes.at(-1)).toBe(
      "Tracker ids: no evidence of whose tracker data this is: 2 cached tasks, 1 rule, 2 timesheet rows, 1 linked activity, 0 ARIA tasks.",
    );
  });

  it("keeps a task's own id when it has one, and the rest of its JSON, in order", () => {
    const file = path.join(tempDir(), "aria.db");
    baselineDb(
      file,
      RECORDED +
        `INSERT INTO tasks (id, repo_id, state, archived, created_at, updated_at, data_json) VALUES
           ('t-own', 1, 'done', 0, 1, 1, '{"id":"t-own","trackerTaskId":"X-1","trackerId":"other","title":"Mine"}'),
           ('t-new', 1, 'done', 0, 1, 1, '{"id":"t-new","title":"Linked","trackerTaskId":"A-1"}');`,
    );
    open(file);
    const rows = readOnly(file, (db) => db.prepare("SELECT id, data_json FROM tasks ORDER BY id").all() as Array<{ id: string; data_json: string }>);
    expect(rows.map((r) => r.data_json)).toEqual([
      '{"id":"t-new","title":"Linked","trackerTaskId":"A-1","trackerId":"globex"}',
      '{"id":"t-own","trackerTaskId":"X-1","trackerId":"other","title":"Mine"}',
    ]);
  });

  it("keeps two trackers' tasks with the same ID apart, and a rule of minutes only belongs to none", () => {
    const store = new Store(":memory:");
    store.upsertTrackerTaskCache("acme", { taskId: "7", title: "Acme's" });
    store.upsertTrackerTaskCache("globex", { taskId: "7", title: "Globex's", status: "Open" });
    store.upsertTrackerTaskCache("acme", { taskId: "7", title: "Acme's, renamed" });
    expect(store.listTrackerTaskCache("acme").map((e) => [e.taskId, e.title, e.status])).toEqual([["7", "Acme's, renamed", undefined]]);
    expect(store.listTrackerTaskCache("globex").map((e) => [e.taskId, e.title, e.status])).toEqual([["7", "Globex's", "Open"]]);
    expect(store.getTrackerTaskCache("acme", "8")).toBeUndefined();
    const rule = (id: string, trackerTaskId: string) => ({ id, match: { kind: "mail_subject" as const, pattern: id }, trackerTaskId, createdFrom: "you" as const, enabled: true });
    store.saveTimeRule("acme", rule("r-acme", "7"));
    store.saveTimeRule("globex", rule("r-globex", "7"));
    store.saveTimeRule("acme", { ...rule("r-minutes", ""), defaultMinutes: 30 });
    expect(store.listTimeRules("acme").map((r) => [r.id, r.trackerId])).toEqual([
      ["r-minutes", undefined],
      ["r-acme", "acme"],
    ]);
    expect(store.listTimeRules("globex").map((r) => r.id).sort()).toEqual(["r-globex", "r-minutes"]);
    store.close();
  });
});

describe("the copy before migration 15", () => {
  it("is made of an existing database before it is migrated, and not again once it is", () => {
    const file = path.join(tempDir(), "aria.db");
    baselineDb(file, SEED + RECORDED);
    open(file).close();
    stores.pop();
    const backup = `${file}.pre-v15.bak`;
    expect(userVersion(backup)).toBe(14);
    expect(dump(backup).tracker_tasks_cache).toHaveLength(2);
    expect(Object.keys(dump(backup).tracker_tasks_cache![0]!)).not.toContain("tracker_id");
    expect(existsSync(`${backup}.tmp`)).toBe(false);

    // A migrated database isn't backed up again: the backup stays the copy from before.
    writeFileSync(backup, "the backup from before");
    expect(open(file).migrationNotes).toEqual([]);
    expect(readFileSync(backup, "utf8")).toBe("the backup from before");
  });

  it("notes where it is", () => {
    const file = path.join(tempDir(), "aria.db");
    baselineDb(file, SEED + RECORDED);
    const store = open(file);
    expect(store.migrationNotes[0]).toBe(`Backed up the database to ${file}.pre-v15.bak before migration 15.`);
  });

  it("replaces whatever is at the backup's path: a cut-off copy, or an older backup", () => {
    // What a killed `VACUUM INTO` can leave: a file that opens, with no tables and version 0.
    const file = path.join(tempDir(), "aria.db");
    baselineDb(file, SEED);
    const backup = `${file}.pre-v15.bak`;
    new DatabaseSync(backup).close();
    expect(Object.keys(dump(backup))).toEqual([]);
    const store = open(file);
    expect(userVersion(backup)).toBe(14);
    expect(dump(backup).tracker_tasks_cache).toHaveLength(2);
    expect(store.migrationNotes[0]).toBe(`Backed up the database to ${backup} before migration 15, replacing the older backup there.`);

    // A backup from an earlier try, before a week back on the old build: the newest copy replaces it.
    const other = path.join(tempDir(), "aria.db");
    baselineDb(other, `INSERT INTO settings (key, value_json) VALUES ('done.after.going.back', 'true');`);
    writeFileSync(`${other}.pre-v15.bak`, "an older backup");
    open(other);
    expect(dump(`${other}.pre-v15.bak`).settings!.map((r) => r.key)).toContain("done.after.going.back");
  });

  it("removes an unfinished copy an earlier start left, and copies again", () => {
    const file = path.join(tempDir(), "aria.db");
    baselineDb(file, SEED);
    const backup = `${file}.pre-v15.bak`;
    writeFileSync(`${backup}.tmp`, "half a database");
    const store = open(file);
    expect(existsSync(`${backup}.tmp`)).toBe(false);
    expect(userVersion(backup)).toBe(14);
    expect(store.migrationNotes.slice(0, 2)).toEqual([`Removed an unfinished backup at ${backup}.tmp.`, `Backed up the database to ${backup} before migration 15.`]);
  });

  it("keeps the copy under a name of its own when the old backup can't be replaced, and migrates", () => {
    const file = path.join(tempDir(), "aria.db");
    baselineDb(file, SEED);
    // Nothing can be renamed over a folder that has something in it (EPERM on Windows, EISDIR elsewhere).
    const backup = `${file}.pre-v15.bak`;
    mkdirSync(path.join(backup, "inside"), { recursive: true });
    const store = open(file);
    expect(userVersion(file)).toBe(15);
    const [named, ...more] = namedBackups(file);
    expect(more).toEqual([]);
    expect(userVersion(named!)).toBe(14);
    expect(dump(named!).tracker_tasks_cache).toHaveLength(2);
    expect(existsSync(`${backup}.tmp`)).toBe(false);
    expect(readdirSync(backup)).toEqual(["inside"]);
    expect(store.migrationNotes[0]).toMatch(new RegExp(`^Backed up the database to ${escapeRe(named!)} before migration 15, since ${escapeRe(backup)} couldn't be replaced: .+\\.$`));
  });

  it.runIf(process.platform === "win32")("keeps the copy under a name of its own when the old backup is read-only or open in another program", () => {
    // Windows doesn't replace a read-only file.
    const file = path.join(tempDir(), "aria.db");
    baselineDb(file, SEED);
    const backup = `${file}.pre-v15.bak`;
    writeFileSync(backup, "an older backup");
    chmodSync(backup, 0o444);
    try {
      const store = open(file);
      expect(userVersion(file)).toBe(15);
      expect(readFileSync(backup, "utf8")).toBe("an older backup");
      const [named] = namedBackups(file);
      expect(userVersion(named!)).toBe(14);
      expect(store.migrationNotes[0]).toMatch(new RegExp(`^Backed up the database to ${escapeRe(named!)} before migration 15, since ${escapeRe(backup)} couldn't be replaced: EPERM`));
    } finally {
      chmodSync(backup, 0o666);
    }

    // Nor one another program has open without letting it be deleted (as SQLite opens its files).
    const other = path.join(tempDir(), "aria.db");
    baselineDb(other, SEED);
    const holder = new DatabaseSync(`${other}.pre-v15.bak`);
    try {
      holder.exec("CREATE TABLE older (x)");
      const store = open(other);
      expect(userVersion(other)).toBe(15);
      const [named] = namedBackups(other);
      expect(userVersion(named!)).toBe(14);
      expect(store.migrationNotes[0]).toMatch(new RegExp(`^Backed up the database to ${escapeRe(named!)} before migration 15, since .+ couldn't be replaced: `));
    } finally {
      holder.close();
    }
  });

  it("leaves the complete copy as the .tmp when it can't take a name of its own either, and migrates", () => {
    const file = path.join(tempDir(), "aria.db");
    baselineDb(file, SEED);
    const backup = `${file}.pre-v15.bak`;
    const named = `${file}.pre-v15.20261118-093005.bak`;
    for (const blocked of [backup, named]) mkdirSync(path.join(blocked, "inside"), { recursive: true });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 18, 9, 30, 5));
    const store = (() => {
      try {
        return open(file);
      } finally {
        vi.useRealTimers();
      }
    })();
    expect(userVersion(file)).toBe(15);
    expect(userVersion(`${backup}.tmp`)).toBe(14);
    expect(dump(`${backup}.tmp`).tracker_tasks_cache).toHaveLength(2);
    expect(store.migrationNotes[0]).toMatch(
      new RegExp(
        `^Backed up the database to ${escapeRe(`${backup}.tmp`)} before migration 15; it's a complete copy, left under that name since ` +
          `${escapeRe(backup)} couldn't be replaced: .+, and it couldn't be renamed to ${escapeRe(named)} either: .+\\.$`,
      ),
    );
    // The next start leaves it: the database is migrated, so nothing is backed up again.
    store.close();
    stores.pop();
    expect(open(file).migrationNotes).toEqual([]);
    expect(userVersion(`${backup}.tmp`)).toBe(14);
  });

  it("asks for room for the copy and the migration's own writes: 10% of the copy more, at least 16 MB", () => {
    expect(backupRoom(0)).toBe(16 * MB);
    expect(backupRoom(100 * MB)).toBe(116 * MB);
    expect(backupRoom(160 * MB)).toBe(176 * MB);
    expect(backupRoom(500 * MB)).toBe(550 * MB);
    expect(backupRoom(1000 * MB + 1)).toBe(1000 * MB + 1 + Math.ceil((1000 * MB + 1) / 10));
  });

  it("doesn't start a backup the drive has no room for, with the migration after it, says how much to free, and doesn't migrate", () => {
    const file = path.join(tempDir(), "aria.db");
    baselineDb(file, SEED);
    const before = dump(file);
    const asked: string[] = [];
    // Room for the copy alone isn't enough: migration 15 writes its WAL after it.
    const error = openError(file, { backup: { freeBytes: (folder) => (asked.push(folder), copyBytes(file) + MB) } });
    expect(error.message).toBe(noRoom(file));
    expect(error.message).toContain(`about ${Math.ceil((copyBytes(file) + 16 * MB) / MB)} MB free`);
    expect(asked).toEqual([path.dirname(file)]);
    expect(userVersion(file)).toBe(14);
    expect(dump(file)).toEqual(before);
    expect(existsSync(`${file}.pre-v15.bak.tmp`)).toBe(false);

    // A byte short of that room isn't enough either; that room is.
    expect(openError(file, { backup: { freeBytes: () => roomBytes(file) - 1 } }).message).toBe(noRoom(file));
    expect(open(file, { backup: { freeBytes: () => roomBytes(file) } }).migrationNotes[0]).toBe(`Backed up the database to ${file}.pre-v15.bak before migration 15.`);
    expect(userVersion(file)).toBe(15);
  });

  it("says how much to free when migration 15 fills the drive after the backup, and rolls it back", () => {
    const file = path.join(tempDir(), "aria.db");
    // Stands in for a drive that fills up inside the migration: stamping a rule fails with SQLite's disk-full message.
    baselineDb(file, SEED + RECORDED + "CREATE TRIGGER fill_up BEFORE UPDATE ON time_rules BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END;");
    const error = openError(file);
    expect(error.message).toBe(noRoom(file));
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toBe("database or disk is full");
    expect(userVersion(file)).toBe(14);
    // Rolled back: the old cache table, whole, and no new columns.
    expect(dump(file).tracker_tasks_cache).toHaveLength(2);
    expect(Object.keys(dump(file).tracker_tasks_cache![0]!)).not.toContain("tracker_id");
    expect(readOnly(file, (db) => (db.prepare("PRAGMA table_info(time_rules)").all() as Array<{ name: string }>).map((c) => c.name))).not.toContain("tracker_id");
    // The backup was made before it, and stays.
    expect(userVersion(`${file}.pre-v15.bak`)).toBe(14);
  });

  it("copies when the drive has room for it, or when the system can't tell", () => {
    for (const freeBytes of [() => 1024 ** 4, () => undefined]) {
      const file = path.join(tempDir(), "aria.db");
      baselineDb(file, SEED);
      expect(open(file, { backup: { freeBytes } }).migrationNotes[0]).toBe(`Backed up the database to ${file}.pre-v15.bak before migration 15.`);
      expect(userVersion(file)).toBe(15);
    }
  });

  it("says how much to free when the copy fills the drive, removes what it wrote, and doesn't migrate", () => {
    const file = path.join(tempDir(), "aria.db");
    baselineDb(file, SEED);
    const full = Object.assign(new Error("database or disk is full"), { code: "ERR_SQLITE_ERROR", errcode: 13 });
    const copy = (target: string): void => {
      writeFileSync(target, "half a database");
      throw full;
    };
    const error = openError(file, { backup: { freeBytes: () => 1024 ** 4, copy } });
    expect(error.message).toBe(noRoom(file));
    expect(error.cause).toBe(full);
    expect(userVersion(file)).toBe(14);
    expect(existsSync(`${file}.pre-v15.bak.tmp`)).toBe(false);
    expect(existsSync(`${file}.pre-v15.bak`)).toBe(false);
  });

  it("says what went wrong when the backup fails for another reason, and doesn't migrate", () => {
    const file = path.join(tempDir(), "aria.db");
    baselineDb(file, SEED);
    // An unfinished copy that can't be removed: a folder with something in it.
    const partial = `${file}.pre-v15.bak.tmp`;
    mkdirSync(path.join(partial, "inside"), { recursive: true });
    expect(openError(file).message).toMatch(
      new RegExp(
        "^ARIA couldn't back up its database before updating it, so it didn't update it; your data hasn't changed\\. " +
          `Details: backing it up to ${escapeRe(partial)} before migration 15 failed: .+`,
      ),
    );
    expect(userVersion(file)).toBe(14);
    expect(dump(file).tracker_tasks_cache).toHaveLength(2);
    expect(namedBackups(file)).toEqual([]);
  });

  it("rolls a failing migration back and names it", () => {
    const file = path.join(tempDir(), "aria.db");
    // The rebuild can't happen: a table already has the name the new cache is made under.
    baselineDb(file, SEED + RECORDED + "CREATE TABLE tracker_tasks_cache_v15 (x);");
    expect(openError(file).message).toMatch(/^Migration 15 \(tracker ids\) failed: .*tracker_tasks_cache_v15/);
    expect(userVersion(file)).toBe(14);
    const columns = readOnly(file, (db) => (db.prepare("PRAGMA table_info(tracker_tasks_cache)").all() as Array<{ name: string }>).map((c) => c.name));
    expect(columns).not.toContain("tracker_id");
    expect(dump(file).tracker_tasks_cache).toHaveLength(2);
    // The copy made before it stays.
    expect(userVersion(`${file}.pre-v15.bak`)).toBe(14);
  });
});
