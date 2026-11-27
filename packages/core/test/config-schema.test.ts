/**
 * The tracker config's schema (docs/trackers.md, "The reference" and "What the loader refuses"): valid configs and their defaults, every
 * kind of error, strictness, limits and the cross-checks. The tracker here is fictional ("Example Tracker").
 */
import { describe, expect, it } from "vitest";
import {
  configPatterns,
  derivedRoutes,
  isTrackerId,
  routeMatches,
  TrackerConfigSchema,
  type ConfigRoute,
  type TrackerConfig,
} from "../src/trackers/config/schema.ts";

function example(): Record<string, any> {
  return {
    schema: 1,
    id: "example",
    label: "Example Tracker",
    info: { urlTemplate: "https://tracker.example/ticket/{id}", taskRefPlaceholder: "Ticket number or link", serverHint: "Example Cloud" },
    servers: { match: ["example"], fallback: "Example" },
    taskRef: { id: "[1-9]\\d{3,8}", idInText: "[1-9]\\d{4,8}", prefixes: ["ticket"], keywords: ["ticket", "bug"], urls: ["tracker.example/ticket/{id}"] },
    ids: { task: "[1-9]\\d{0,11}", entity: "[1-9]\\d{0,11}" },
    tools: {
      testConnection: "get_status",
      reserved: ["log_hours", "edit_hours", "remove_hours"],
      confirm: ["remove_hours"],
      rawCompanions: { list_tickets_json: "list_tickets" },
    },
    tasks: {
      myTasks: ["list_tickets_json"],
      byId: { tools: ["get_tickets"], args: { ids: { $join: "ids", with: "," } } },
      lists: ["tickets"],
      emptyText: ["no tickets"],
      fields: {
        id: ["id"],
        title: ["title"],
        status: ["status"],
        projectId: ["projectId", "project"],
        projectName: ["project", "projectName"],
        customerId: ["customerId"],
        modifiedAt: ["updatedAt"],
      },
      comments: { list: ["comments"], text: ["body"], by: ["author"], id: ["id"] },
      closedStatuses: ["closed"],
      statusRank: ["in progress", "open"],
    },
    timeLogs: {
      byRange: { tools: ["get_hours_by_date_range"], args: { from: "{from}", to: "{until}" } },
      lists: ["hours"],
      fields: { id: ["id"], taskId: ["ticketId"], start: ["start"], end: ["end"], projectId: ["projectId"], customerId: ["customerId"], comment: ["note"] },
      requiresProjectCustomer: true,
      create: {
        tool: "log_hours",
        args: {
          entries: { $json: { $each: "rows", item: { ticket: "{taskId}", project: "{projectId}", customer: "{customerId}", start: "{start}", end: "{end}", note: "{comment}" } } },
        },
        result: { perRow: { list: ["results"], index: "index", id: ["id"], error: "error" } },
      },
      update: { tool: "edit_hours", args: { id: "{entryId}", start: "{start}", end: "{end}", note: "{comment}", ticket: { $if: "taskId", value: "{taskId}" } } },
      delete: { tool: "remove_hours", args: { ids: { $list: "ids" } } },
    },
    projects: { search: { tool: "find_projects", args: { query: "{query}" } }, lists: ["projects"], fields: { id: ["id"], name: ["name"] } },
    knownIds: { customers: { "in-house": "1" } },
    timekeeper: {
      routes: [{ handler: "timeLogs", mode: "dateRange", anyOf: ["hours"], allOf: ["date_range"] }],
      steps: ["The user's open tickets ({prefix}list_tickets_json)."],
      dateRangeHint: 'Use from "{date}" and to "{nextDay}".',
      resolveIdsHint: "Resolve {ids} with {prefix}get_tickets.",
      commentHint: "use {prefix}get_comments to read it",
      taskUpdatesName: "Example updates",
    },
    messages: { invalidTaskRef: '"{input}" isn\'t an Example ticket.' },
  };
}

function minimal(): Record<string, any> {
  return {
    schema: 1,
    id: "mini",
    label: "Mini",
    info: { urlTemplate: "https://mini.example/{id}" },
    taskRef: { id: "M-\\d{1,6}" },
    tasks: { myTasks: ["list_items"], fields: { id: ["id"], title: ["title"] } },
  };
}

function errors(config: unknown): string[] {
  const result = TrackerConfigSchema.safeParse(config);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

function parse(config: unknown): TrackerConfig {
  const result = TrackerConfigSchema.safeParse(config);
  if (!result.success) throw new Error(errors(config).join("\n"));
  return result.data;
}

/** A copy of `config` with `edit` applied. */
function changed(config: Record<string, any>, edit: (c: Record<string, any>) => void): Record<string, any> {
  const copy = structuredClone(config);
  edit(copy);
  return copy;
}

describe("valid configs", () => {
  it("accepts the example and fills in the defaults", () => {
    const config = parse(example());
    expect(config.servers).toEqual({ match: ["example"], prefer: [], fallback: "Example" });
    expect(config.taskRef).toMatchObject({ bare: false, caseInsensitive: false, normalize: "none" });
    expect(config.objectKeys).toEqual({ id: ["id"], text: ["value", "name"], name: ["name"] });
    expect(config.timeLogs?.time).toBe("local");
    expect(config.timeLogs?.emptyText).toEqual([]);
    expect(config.messages).toEqual({ invalidTaskRef: '"{input}" isn\'t an Example ticket.' });
  });

  it("takes each way of writing times, and the date and the minutes in the create and update arguments", () => {
    for (const time of ["local", "offset", "utc"]) {
      expect(parse(changed(example(), (c) => (c.timeLogs.time = time))).timeLogs?.time).toBe(time);
    }
    const config = parse(
      changed(example(), (c) => {
        c.timeLogs.create.args = { entries: { $each: "rows", item: { ticket: "{taskId}", project: "{projectId}", customer: "{customerId}", day: "{date}", start: "{start}", end: "{end}", minutes: "{minutes}" } } };
        c.timeLogs.update.args = { id: "{entryId}", day: "{date}", start: "{start}", minutes: "{minutes}" };
      }),
    );
    expect(config.timeLogs?.update.args).toEqual({ id: "{entryId}", day: "{date}", start: "{start}", minutes: "{minutes}" });
  });

  it("accepts a minimal config: no time logs, no projects", () => {
    const config = parse(minimal());
    expect(config.timeLogs).toBeUndefined();
    expect(config.projects).toBeUndefined();
    expect(config.servers).toEqual({ match: [], prefer: [] });
    expect(config.tools).toEqual({ reserved: [], confirm: [], rawCompanions: {} });
    expect(config.timekeeper).toEqual({ routes: [], steps: [] });
    expect(config.messages).toEqual({});
    expect(config.ids).toEqual({});
    expect(config.tasks).toMatchObject({ lists: [], emptyText: [], closedStatuses: [], statusRank: [] });
  });

  it("takes control characters out of the config's own words", () => {
    const config = parse(changed(example(), (c) => {
      c.label = " Example\u0007Tracker​ ";
      c.timekeeper.steps = ["Line one\nline two"];
    }));
    expect(config.label).toBe("Example Tracker");
    expect(config.timekeeper.steps).toEqual(["Line one line two"]);
  });

  it("gives the ID patterns with their defaults", () => {
    const patterns = configPatterns(parse(minimal()));
    expect(patterns.ref.source).toBe("M-\\d{1,6}");
    expect(patterns.refInText).toEqual(patterns.ref);
    expect(patterns.task).toEqual(patterns.ref);
    expect(patterns.entity.source).toBe("[^\\s,]{1,64}");
    expect(patterns.timeLog.source).toBe("[^\\s,]{1,64}");
    const full = configPatterns(parse(example()));
    expect([full.ref.source, full.refInText.source, full.task.source, full.entity.source]).toEqual(["[1-9]\\d{3,8}", "[1-9]\\d{4,8}", "[1-9]\\d{0,11}", "[1-9]\\d{0,11}"]);
  });
});

describe("errors", () => {
  it.each([
    ["at the root", (c: Record<string, any>) => (c.extra = 1), ': Unrecognized key: "extra"'],
    ["in a field list", (c: Record<string, any>) => (c.tasks.fields.titel = ["x"]), 'tasks.fields: Unrecognized key: "titel"'],
    ["in a route", (c: Record<string, any>) => (c.timekeeper.routes[0].anyof = ["x"]), 'timekeeper.routes.0: Unrecognized key: "anyof"'],
    ["in the comments", (c: Record<string, any>) => (c.tasks.comments.Text = ["x"]), 'tasks.comments: Unrecognized key: "Text"'],
    ["in info", (c: Record<string, any>) => (c.info.url = "x"), 'info: Unrecognized key: "url"'],
    ["in a create result", (c: Record<string, any>) => (c.timeLogs.create.result.perRow.indx = "i"), 'timeLogs.create.result.perRow: Unrecognized key: "indx"'],
  ])("refuses an unknown key %s", (_where, edit, error) => {
    expect(errors(changed(example(), edit))).toContain(error);
  });

  it.each(["none", "default", "A", "a", "1abc", "a_b", "ab.", "a".repeat(33), "Example"])("refuses the id %j", (id) => {
    expect(errors(changed(example(), (c) => (c.id = id)))[0]).toMatch(/^id: isn't an id/);
  });

  it.each(["ab", "my-tracker", "x2", "a".repeat(32)])("accepts the id %j", (id) => {
    expect(errors(changed(example(), (c) => (c.id = id)))).toEqual([]);
    expect(isTrackerId(id)).toBe(true);
  });

  it("checks a choice's config id the same way", () => {
    for (const id of ["none", "default", "../x", "a/b", "", 5, null, undefined]) expect(isTrackerId(id)).toBe(false);
  });

  it.each([
    ["the schema version", (c: Record<string, any>) => (c.schema = 2), "schema: Invalid input: expected 1"],
    ["an empty label", (c: Record<string, any>) => (c.label = " \u0007 "), "label: Too small"],
    ["a long label", (c: Record<string, any>) => (c.label = "x".repeat(41)), "label: Too big"],
    ["a bad path", (c: Record<string, any>) => (c.tasks.fields.title = ["a[0]"]), "tasks.fields.title.0: isn't a path"],
    ["a prototype path", (c: Record<string, any>) => (c.tasks.fields.title = ["x.__proto__"]), "tasks.fields.title.0: isn't a path"],
    ["no paths", (c: Record<string, any>) => (c.tasks.fields.title = []), "tasks.fields.title: Too small"],
    ["21 paths", (c: Record<string, any>) => (c.tasks.fields.title = Array.from({ length: 21 }, (_, i) => `p${i}`)), "tasks.fields.title: Too big"],
    ["a bad list key", (c: Record<string, any>) => (c.tasks.lists = ["constructor"]), "tasks.lists.0: isn't a key"],
    ["a bad tool name", (c: Record<string, any>) => (c.tasks.myTasks = ["list tickets"]), "tasks.myTasks.0: isn't a tool name"],
    ["five tools", (c: Record<string, any>) => (c.tasks.myTasks = ["get_a", "get_b", "get_c", "get_d", "get_e"]), "tasks.myTasks: Too big"],
    ["a bad ID pattern", (c: Record<string, any>) => (c.taskRef.id = "\\d+"), 'taskRef.id: the ID pattern at character 3: "+" isn\'t allowed'],
    ["a bad entity pattern", (c: Record<string, any>) => (c.ids.entity = "(x)"), "ids.entity: the ID pattern at character 1: groups"],
    ["a bad text-ID pattern", (c: Record<string, any>) => (c.timeLogs.create.result.textIds = { label: "ID", id: "" }), "timeLogs.create.result.textIds.id: the ID pattern is empty"],
    ["an http task link", (c: Record<string, any>) => (c.info.urlTemplate = "http://tracker.example/{id}"), "info.urlTemplate: the task link must start with https://"],
    ["a task link without {id}", (c: Record<string, any>) => (c.info.urlTemplate = "https://tracker.example/"), "info.urlTemplate: the task link needs exactly one {id}"],
    ["a URL pattern with a scheme", (c: Record<string, any>) => (c.taskRef.urls = ["https://tracker.example/{id}"]), "taskRef.urls.0: the URL pattern starts with a scheme"],
    ["six URL patterns", (c: Record<string, any>) => (c.taskRef.urls = Array.from({ length: 6 }, (_, i) => `t${i}.example/{id}`)), "taskRef.urls: Too big"],
    ["an unknown placeholder", (c: Record<string, any>) => (c.timeLogs.byRange.args = { from: "{start}" }), "timeLogs.byRange.args.from: uses {start}, which isn't known here (known: {from}, {until})"],
    ["a reference ID that can hold a space", (c: Record<string, any>) => (c.taskRef.id = "\\d{2}\\s\\d{4}"), "taskRef.id: the ID pattern can match whitespace"],
    ["a reference ID in text that can hold a slash", (c: Record<string, any>) => (c.taskRef.idInText = "[\\d/]{3,9}"), "taskRef.idInText: the ID pattern can match whitespace"],
    ["a delete without IDs", (c: Record<string, any>) => (c.timeLogs.delete.args = { all: true }), "timeLogs.delete.args: the arguments need ids ($join or $list)"],
    ["a create row without a task", (c: Record<string, any>) => delete c.timeLogs.create.args.entries.$json.item.ticket, "timeLogs.create.args.entries.$json.item: each row needs {taskId}"],
    ["missing arguments", (c: Record<string, any>) => delete c.timeLogs.update.args, "timeLogs.update.args: the arguments must be an object"],
    ["an unknown step placeholder", (c: Record<string, any>) => (c.timekeeper.steps = ["Use {date}"]), "timekeeper.steps.0: uses {date}, which isn't known here (known: {prefix})"],
    ["a hint placeholder from elsewhere", (c: Record<string, any>) => (c.timekeeper.dateRangeHint = "{prefix}"), "timekeeper.dateRangeHint: uses {prefix}"],
    ["a lone brace in a message", (c: Record<string, any>) => (c.messages.invalidRuleTaskRef = "{inp"), "messages.invalidRuleTaskRef: a \"{\" at character 1"],
    ["a route with anyOf and equals", (c: Record<string, any>) => (c.timekeeper.routes[0].equals = ["get_x"]), "timekeeper.routes.0: a route has either anyOf or equals"],
    ["a route with neither", (c: Record<string, any>) => delete c.timekeeper.routes[0].anyOf, "timekeeper.routes.0: a route has either anyOf or equals"],
    ["history on time logs", (c: Record<string, any>) => (c.timekeeper.routes[0].mode = "history"), 'timekeeper.routes.0.mode: mode "history" goes with the tasks handler'],
    ["dateRange on tasks", (c: Record<string, any>) => (c.timekeeper.routes = [{ handler: "tasks", mode: "dateRange", anyOf: ["x"] }]), 'timekeeper.routes.0.mode: mode "dateRange" goes with the timeLogs handler'],
    ["an empty create result", (c: Record<string, any>) => (c.timeLogs.create.result = {}), "timeLogs.create.result: needs at least one of perRow, created and textIds"],
    ["seven steps", (c: Record<string, any>) => (c.timekeeper.steps = Array.from({ length: 7 }, () => "s")), "timekeeper.steps: Too big"],
    ["21 raw companions", (c: Record<string, any>) => (c.tools.rawCompanions = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`get_t${i}_raw`, `get_t${i}`]))), "tools.rawCompanions: has more than 20 entries"],
    ["51 known customers", (c: Record<string, any>) => (c.knownIds.customers = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`c${i}`, "1"]))), "knownIds.customers: has more than 50 entries"],
    ["a 2-character server match", (c: Record<string, any>) => (c.servers.match = ["ex"]), "servers.match.0: Too small"],
    ["21 prefixes", (c: Record<string, any>) => (c.taskRef.prefixes = Array.from({ length: 21 }, (_, i) => `p${i}`)), "taskRef.prefixes: Too big"],
    ["31 status ranks", (c: Record<string, any>) => (c.tasks.statusRank = Array.from({ length: 31 }, (_, i) => `s${i}`)), "tasks.statusRank: Too big"],
    ["an unknown kind of time", (c: Record<string, any>) => (c.timeLogs.time = "gmt"), "timeLogs.time: Invalid option: expected one of \"local\"|\"offset\"|\"utc\""],
  ])("refuses %s", (_what, edit, error) => {
    expect(errors(changed(example(), edit)).join("\n")).toContain(error);
  });
});

describe("cross-checks", () => {
  it.each([
    ["a write as my tasks", (c: Record<string, any>) => (c.tasks.myTasks = ["update_ticket"]), "tasks.myTasks.0: update_ticket isn't named like a read tool, and ARIA calls it without asking"],
    ["a delete as the by-ID read", (c: Record<string, any>) => (c.tasks.byId.tools = ["delete_tickets"]), "tasks.byId.tools.0: delete_tickets isn't named like a read tool"],
    ["a write as a raw companion", (c: Record<string, any>) => (c.tools.rawCompanions = { export_tickets: "list_tickets" }), "tools.rawCompanions.export_tickets: export_tickets isn't named like a read tool"],
    ["a write as the project search", (c: Record<string, any>) => (c.projects.search.tool = "create_project"), "projects.search.tool: create_project isn't named like a read tool"],
    ["a reserved read", (c: Record<string, any>) => c.tools.reserved.push("get_tickets"), "tasks.byId.tools.0: get_tickets is reserved, so ARIA can't read with it"],
    ["a destructive connection test", (c: Record<string, any>) => (c.tools.testConnection = "delete_everything"), "tools.testConnection: delete_everything isn't named like a read tool, and the connection test calls it directly"],
    ["an unrestricted connection test", (c: Record<string, any>) => (c.tools.testConnection = "api_post"), "tools.testConnection: api_post isn't named like a read tool"],
    ["a connection test that sends something", (c: Record<string, any>) => (c.tools.testConnection = "send_test_message"), "tools.testConnection: send_test_message isn't named like a read tool"],
    ["a reserved connection test", (c: Record<string, any>) => c.tools.reserved.push("get_status"), "tools.testConnection: get_status is reserved"],
    ["an unreserved write", (c: Record<string, any>) => (c.tools.reserved = ["log_hours", "remove_hours"]), "tools.reserved: edit_hours (timeLogs.update.tool) must be in tools.reserved"],
    ["a date-range tool caught by another route", (c: Record<string, any>) => (c.timekeeper.routes = [{ handler: "tasks", anyOf: ["get_"] }]), "timeLogs.byRange.tools.0: get_hours_by_date_range is read first as the tasks route; a date-range read must be read first by a timeLogs dateRange route"],
    ["a date-range tool caught without the mode", (c: Record<string, any>) => (c.timekeeper.routes = [{ handler: "timeLogs", anyOf: ["hours"] }]), "get_hours_by_date_range is read first as the timeLogs route;"],
    ["my tasks caught by a history route", (c: Record<string, any>) => (c.timekeeper.routes = [{ handler: "tasks", mode: "history", anyOf: ["list_tickets"] }]), "tasks.myTasks.0: list_tickets_json is read first as the tasks history route; a task read must be read first as plain tasks (a history route doesn't cache them, and another handler would read the result as its own)"],
    ["a by-ID read caught by a history route", (c: Record<string, any>) => (c.timekeeper.routes = [{ handler: "tasks", mode: "history", anyOf: ["get_tickets"] }]), "tasks.byId.tools.0: get_tickets is read first as the tasks history route"],
    ["a by-ID read caught by the time-log route", (c: Record<string, any>) => (c.timekeeper.routes = [{ handler: "timeLogs", anyOf: ["get_tickets"] }]), "tasks.byId.tools.0: get_tickets is read first as the timeLogs route"],
    ["a project search caught by the tasks route", (c: Record<string, any>) => (c.timekeeper.routes = [{ handler: "tasks", anyOf: ["find_projects"] }]), "projects.search.tool: find_projects is read first as the tasks route; a project search must be read first by a projects route"],
    ["project and customer required but not sent",(c: Record<string, any>) => delete c.timeLogs.create.args.entries.$json.item.customer, "timeLogs.create.args: requiresProjectCustomer needs {customerId} in the create arguments"],
    ["a known ID that isn't an entity ID", (c: Record<string, any>) => (c.knownIds.customers = { "in-house": "x1" }), 'knownIds.customers.in-house: "x1" doesn\'t match ids.entity'],
  ])("refuses %s", (_what, edit, error) => {
    expect(errors(changed(example(), edit))).toEqual([error].map((e) => expect.stringContaining(e)) as unknown as string[]);
  });

  it("derives the date-range route when the config has none", () => {
    expect(errors(changed(example(), (c) => (c.timekeeper.routes = [])))).toEqual([]);
    expect(errors(changed(example(), (c) => (c.timeLogs.requiresProjectCustomer = false)))).toEqual([]);
  });

  it("holds only the IDs found in text to one word: ids.* may match whitespace or a slash", () => {
    expect(errors(changed(example(), (c) => (c.ids.timeLog = "[^,]{1,64}")))).toEqual([]);
    expect(errors(changed(example(), (c) => (c.ids.entity = "[\\w/]{1,12}")))).toEqual([]);
  });

  it("runs only when every part passed", () => {
    expect(errors(changed(example(), (c) => {
      c.label = "";
      c.tasks.myTasks = ["update_ticket"];
    }))).toEqual(["label: Too small: expected string to have >=1 characters"]);
  });
});

describe("routes", () => {
  it("derives exact-name routes after the config's own", () => {
    expect(derivedRoutes(parse(example()))).toEqual([
      { handler: "tasks", equals: ["list_tickets_json", "get_tickets"] },
      { handler: "timeLogs", mode: "dateRange", equals: ["get_hours_by_date_range"] },
      { handler: "projects", equals: ["find_projects"] },
    ]);
    expect(derivedRoutes(parse(minimal()))).toEqual([{ handler: "tasks", equals: ["list_items"] }]);
  });

  it("matches a bare tool name case-insensitively", () => {
    const route: ConfigRoute = { handler: "timeLogs", anyOf: ["Hours"], allOf: ["date"], noneOf: ["task"] };
    expect(routeMatches(route, "get_hours_by_date_range")).toBe(true);
    expect(routeMatches(route, "GET_HOURS_BY_DATE")).toBe(true);
    expect(routeMatches(route, "get_hours")).toBe(false);
    expect(routeMatches(route, "get_task_hours_by_date")).toBe(false);
    expect(routeMatches({ handler: "tasks", equals: ["List_Items"] }, "list_items")).toBe(true);
    expect(routeMatches({ handler: "tasks", equals: ["list_items"] }, "list_items_raw")).toBe(false);
  });
});
