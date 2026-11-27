/**
 * The fictional Acme Tracker for the tests: its config
 * (fixtures/trackers/acme.json) read through the real loader into the generic config tracker, the server it runs on, and
 * small builders for what its tools answer. Acme's tools: `list_my_issues` and `get_issues` (issues as
 * `{ key, fields: { summary, status, … } }`), `list_worklogs`, `add_worklogs`, `update_worklog` and `delete_worklogs`
 * (worklogs as `{ id, issueKey, started, ended, comment }`); `get_current_user` tests the connection.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTrackerConfig } from "../../src/trackers/config/load.ts";
import { createConfigTracker } from "../../src/trackers/config/tracker.ts";
import type { TaskTracker } from "../../src/trackers/types.ts";

export const ACME_CONFIG_FILE = fileURLToPath(new URL("../fixtures/trackers/acme.json", import.meta.url));

/** A config file of the fixtures folder, read through the loader as ARIA reads one from `<data dir>/trackers/`. */
export function loadTrackerFixture(file: string, id: string): TaskTracker {
  const parsed = parseTrackerConfig(readFileSync(file, "utf8"), id);
  if (!parsed.ok) throw new Error(`${file} doesn't load:\n${parsed.errors.join("\n")}`);
  return createConfigTracker(parsed.config, { hash: `${id}-fixture` });
}

/** The fictional Acme Tracker. */
export const acmeTracker: TaskTracker = loadTrackerFixture(ACME_CONFIG_FILE, "acme");

/** Acme's config edited by `edit` (the tests' own change), read through the loader, as the config tests do. */
export function acmeVariant(edit: (config: Record<string, any>) => void): TaskTracker {
  const raw = JSON.parse(readFileSync(ACME_CONFIG_FILE, "utf8")) as Record<string, any>;
  edit(raw);
  const parsed = parseTrackerConfig(JSON.stringify(raw), "acme");
  if (!parsed.ok) throw new Error(`The edited Acme config doesn't load:\n${parsed.errors.join("\n")}`);
  return createConfigTracker(parsed.config, { hash: "acme-variant" });
}

/**
 * Acme as a tracker that wants a project and a customer with every worklog (`requiresProjectCustomer`): the worklogs
 * carry `projectKey` and `accountId`, and changing a worklog's issue needs both. The Acme issues of the tests have
 * them (ACME_LEDGER). The rule is the config's, not Acme's: the shipped acme.json asks for neither.
 */
export const acmeProjectTracker: TaskTracker = acmeVariant((c) => {
  const timeLogs = c.timeLogs;
  timeLogs.requiresProjectCustomer = true;
  timeLogs.fields.projectId = ["projectKey"];
  timeLogs.fields.customerId = ["accountId"];
  timeLogs.create.args.worklogs.item.projectKey = "{projectId}";
  timeLogs.create.args.worklogs.item.accountId = "{customerId}";
  timeLogs.update.args.projectKey = { $if: "projectId", value: "{projectId}" };
  timeLogs.update.args.accountId = { $if: "customerId", value: "{customerId}" };
});

/** The MCP server the tests run Acme on, and the prefix its tools carry on the wire (`Acme-list_my_issues`). */
export const ACME_SERVER = "Acme";
export const ACME_WIRE = `${ACME_SERVER}-`;
/** Acme's address, for tests that give a server one. */
export const ACME_URL = "https://acme.example/mcp";
/** Where an Acme issue's page is. */
export const ACME_BROWSE = "https://acme.example/browse";

/** Acme's tools by what they do. */
export const ACME_TOOLS = {
  myTasks: "list_my_issues",
  byId: "get_issues",
  worklogs: "list_worklogs",
  create: "add_worklogs",
  update: "update_worklog",
  delete: "delete_worklogs",
  testConnection: "get_current_user",
} as const;

export interface AcmeIssueOptions {
  status?: string;
  priority?: string;
  type?: string;
  /** The project's key and name; default: the first three letters of the name, upper-cased. */
  project?: string | { key: string; name: string };
  account?: { id: string; name: string };
  due?: string;
  updated?: string;
  comments?: Array<{ id: string; author: string; body: string }>;
}

/** The project and account most of the tests' issues belong to: the project `LED` (Ledger) of the account `ACC7`. */
export const ACME_LEDGER: Pick<AcmeIssueOptions, "project" | "account"> = {
  project: { key: "LED", name: "Ledger" },
  account: { id: "ACC7", name: "Northwind Ltd" },
};

/** An issue as Acme's tools answer it: `{ key, fields: { summary, status: { name }, … } }`. */
export function acmeIssue(key: string, summary: string, options: AcmeIssueOptions = {}): Record<string, unknown> {
  const project = typeof options.project === "string" ? { key: options.project.slice(0, 3).toUpperCase(), name: options.project } : options.project ?? { key: "LED", name: "Ledger" };
  return {
    key,
    fields: {
      summary,
      status: { name: options.status ?? "In Progress" },
      priority: { name: options.priority ?? "Medium" },
      ...(options.type ? { issuetype: { name: options.type } } : {}),
      project,
      ...(options.account ? { account: options.account } : {}),
      ...(options.due ? { duedate: options.due } : {}),
      ...(options.updated ? { updated: options.updated } : {}),
      ...(options.comments ? { comments: options.comments } : {}),
    },
  };
}

/** What `list_my_issues` answers: `{ issues: [...] }`. */
export const acmeIssues = (...issues: Array<Record<string, unknown>>): { issues: Array<Record<string, unknown>> } => ({ issues });

/** A worklog's `started` and `ended`: local time plus the day's offset (Acme's `time` is `offset`). */
export const acmeStamp = (date: string, hhmm: string, offset = "+02:00"): string => `${date}T${hhmm}:00${offset}`;

export interface AcmeWorklogInput {
  id: string;
  issueKey: string;
  issueSummary?: string;
  start: string;
  end: string;
  comment?: string;
}

/** What `list_worklogs` answers for a date: `{ worklogs: [{ id, issueKey, issueSummary, started, ended, comment }] }`. */
export function acmeWorklogs(date: string, entries: readonly AcmeWorklogInput[] = [], offset = "+02:00"): { worklogs: Array<Record<string, unknown>> } {
  return {
    worklogs: entries.map((e) => ({
      id: e.id,
      issueKey: e.issueKey,
      ...(e.issueSummary ? { issueSummary: e.issueSummary } : {}),
      started: acmeStamp(date, e.start, offset),
      ended: acmeStamp(date, e.end, offset),
      comment: e.comment ?? "",
    })),
  };
}

/** A worklog as Acme keeps it, and as `add_worklogs` receives it (`started` and `ended` carry the day and the offset). */
interface AcmeStoredWorklog {
  id: string;
  issueKey: string;
  started: string;
  ended: string;
  comment: string;
  [extra: string]: unknown;
}

/**
 * Acme's worklogs, kept the way the tracker keeps them: `add`, `update` and `remove` are what its three write tools do,
 * and `list(date)` is what `list_worklogs` answers afterwards. A test that submits a timesheet and reads the day again
 * needs the tracker to remember what it was sent (ARIA reads the day before a submit).
 */
export class AcmeLedger {
  private rows: AcmeStoredWorklog[] = [];
  private nextId: number;

  constructor(firstId = 8_000_000) {
    this.nextId = firstId;
  }

  /** `add_worklogs`: an id for each row, or an error for a row `refuse` gives a reason for. */
  add(worklogs: ReadonlyArray<{ issueKey: string; started: string; ended: string; comment?: string }>, refuse?: (row: { issueKey: string }) => string | undefined): ReturnType<typeof acmeCreated> {
    return acmeCreated(
      worklogs.map((row) => {
        const reason = refuse?.(row);
        if (reason) return { error: reason };
        const id = String(this.nextId++);
        this.rows.push({ ...row, id, comment: row.comment ?? "" });
        return id;
      }),
    );
  }

  /** `update_worklog`: the fields it was given change. */
  update(args: { id: string; started?: string; ended?: string; comment?: string; issueKey?: string }): { updated: boolean } {
    const row = this.rows.find((r) => r.id === args.id);
    if (!row) return { updated: false };
    for (const [key, value] of Object.entries(args)) if (key !== "id" && value !== undefined) row[key] = value;
    return { updated: true };
  }

  /** `delete_worklogs`. */
  remove(ids: readonly string[]): { deleted: number } {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !ids.includes(r.id));
    return { deleted: before - this.rows.length };
  }

  /** `list_worklogs` for a day. */
  list(date: string): { worklogs: Array<Record<string, unknown>> } {
    return { worklogs: this.rows.filter((r) => r.started.startsWith(date)).map((r) => ({ ...r })) };
  }
}

/**
 * What `add_worklogs` answers: one `{ index, id }` for each row it made, or `{ index, error }` for a row it refused.
 * An id is a string; `{ error }` marks a refusal.
 */
export function acmeCreated(rows: ReadonlyArray<string | { error: string }>): { created: Array<Record<string, unknown>> } {
  return { created: rows.map((row, index) => (typeof row === "string" ? { index, id: row } : { index, error: row.error })) };
}
