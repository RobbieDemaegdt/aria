/**
 * A tracker config's schema (docs/trackers.md, "The reference"): zod, strict everywhere (an unknown key is an
 * error, so a typo shows), a limit on every list and string, and the cross-checks that need the whole config.
 * The config's own words (label, hints, steps, messages) have control characters taken out; payload text is cleaned
 * where it is read (`fields.ts`).
 */
import { z } from "zod";
import { classifyTool } from "../../integrations/scope.ts";
import { isDotPath, isKey } from "./fields.ts";
import { buildTaskRefRegexes, checkUrlTemplate, idMatcher, parseIdPattern, parseUrlPattern, type IdPattern, type UrlPattern } from "./patterns.ts";
import { checkTemplate, checkTextTemplate, type TemplateSpec } from "./template.ts";

/** A config's id: its file name and the prefix of the data it leaves (`<id>:<task>:<date>`). */
export const TRACKER_ID = /^[a-z][a-z0-9-]{1,31}$/;
/** `none` is no tracker; `default` is the built-in tracker in `/tracker default`. */
const RESERVED_IDS: ReadonlySet<string> = new Set(["none", "default"]);
export const isTrackerId = (id: unknown): id is string => typeof id === "string" && TRACKER_ID.test(id) && !RESERVED_IDS.has(id);

/** The ID pattern `ids.entity` and `ids.timeLog` default to: what the update and delete calls accept today. */
export const DEFAULT_ID_PATTERN = "[^\\s,]{1,64}";

/** The variables of each argument template. */
export const ARGUMENT_SPECS = {
  byId: { scalars: [], lists: ["ids"], required: ["ids"] },
  byRange: { scalars: ["from", "until"], required: ["from"] },
  create: {
    scalars: [],
    rows: {
      rows: {
        scalars: ["taskId", "projectId", "customerId", "date", "start", "end", "minutes", "comment"],
        mayBeEmpty: ["comment"],
        required: ["taskId"],
      },
    },
    required: ["rows"],
  },
  update: {
    scalars: ["entryId", "date", "start", "end", "minutes", "comment", "taskId", "projectId", "customerId"],
    mayBeEmpty: ["comment"],
    required: ["entryId"],
  },
  delete: { scalars: [], lists: ["ids"], required: ["ids"] },
  search: { scalars: ["query"], required: ["query"] },
} as const satisfies Record<string, TemplateSpec>;

/** The variables of each text template. */
export const TEXT_VARIABLES = {
  steps: ["prefix"],
  dateRangeHint: ["date", "nextDay"],
  resolveIdsHint: ["prefix", "ids"],
  commentHint: ["prefix"],
  messages: ["input"],
} as const;

/** The config's own words: control characters become spaces, format characters go, the ends are trimmed. */
const ownText = (text: string) => text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").replace(/\p{Cf}/gu, "").trim();

const custom = (ctx: z.RefinementCtx, message: string, path: PropertyKey[] = []) => ctx.addIssue({ code: "custom", message, path });

const Key = z.string().refine(isKey, { message: "isn't a key: a letter, _ or $, then up to 63 letters, digits, _, $ or - (not __proto__, constructor or prototype)" });
const Path = z.string().refine(isDotPath, { message: "isn't a path: one to five keys joined by dots, such as fields.status" });
const Paths = z.array(Path).min(1).max(20);
const Text = (max: number) => z.string().overwrite(ownText).min(1).max(max);
const Words = (max: number, n = 20) => z.array(Text(max)).max(n);
const TextTemplate = (max: number, variables: readonly string[]) =>
  Text(max).superRefine((text, ctx) => {
    const problem = checkTextTemplate(text, variables);
    if (problem) custom(ctx, problem);
  });
const ToolName = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, { message: "isn't a tool name: 1 to 64 letters, digits, _, . or -" });
const ToolChoice = z.array(ToolName).min(1).max(4);
const Pattern = z.string().superRefine((text, ctx) => {
  const parsed = parseIdPattern(text);
  if (!parsed.ok) custom(ctx, `the ID pattern ${parsed.error}`);
});
/** An ID pattern for references found in text: also nothing that can match whitespace or `/` (the cut of `scanText`). */
const ScannedPattern = z.string().superRefine((text, ctx) => {
  const parsed = parseIdPattern(text, true);
  if (!parsed.ok) custom(ctx, `the ID pattern ${parsed.error}`);
});
const UrlPatternText = z.string().superRefine((text, ctx) => {
  const parsed = parseUrlPattern(text);
  if (!parsed.ok) custom(ctx, `the URL pattern ${parsed.error}`);
});
const Template = (spec: TemplateSpec) =>
  z.unknown().superRefine((value, ctx) => {
    for (const issue of checkTemplate(value, spec).issues) custom(ctx, issue.message, issue.path);
  });
const Call = (spec: TemplateSpec) => z.object({ tools: ToolChoice, args: Template(spec) }).strict();
const Write = (spec: TemplateSpec) => z.object({ tool: ToolName, args: Template(spec) }).strict();
const Limited = <T extends z.ZodType>(record: T, max: number) =>
  record.refine((value) => Object.keys(value as object).length <= max, { message: `has more than ${max} entries` });

const Route = z
  .object({
    handler: z.enum(["tasks", "timeLogs", "projects"]),
    mode: z.enum(["history", "dateRange"]).optional(),
    /** Substrings of the bare tool name, any of which matches. */
    anyOf: Words(64).min(1).optional(),
    /** Exact tool names. */
    equals: z.array(ToolName).min(1).max(20).optional(),
    allOf: Words(64).optional(),
    noneOf: Words(64).optional(),
  })
  .strict()
  .superRefine((route, ctx) => {
    if (Boolean(route.anyOf) === Boolean(route.equals)) custom(ctx, "a route has either anyOf or equals");
    if (route.mode === "history" && route.handler !== "tasks") custom(ctx, 'mode "history" goes with the tasks handler', ["mode"]);
    if (route.mode === "dateRange" && route.handler !== "timeLogs") custom(ctx, 'mode "dateRange" goes with the timeLogs handler', ["mode"]);
  });

const Fallback = z.object({ by: Paths, id: Paths }).partial().strict();
const Comments = z
  .object({
    list: Paths.optional(),
    latest: Paths.optional(),
    single: Paths.optional(),
    text: Paths,
    by: Paths.optional(),
    id: Paths.optional(),
    taskBy: Paths.optional(),
    taskVersion: Paths.optional(),
    latestFallback: Fallback.optional(),
    singleFallback: Fallback.optional(),
  })
  .strict();

const CreateResult = z
  .object({
    perRow: z.object({ list: Paths, index: Key.optional(), id: Paths, error: Key.optional(), ok: Key.optional() }).strict().optional(),
    match: z.object({ start: Paths, end: Paths, task: Paths }).strict().optional(),
    created: z.object({ lists: z.array(Key).min(1).max(5) }).strict().optional(),
    textIds: z.object({ label: Text(20), id: Pattern }).strict().optional(),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (!result.perRow && !result.created && !result.textIds) custom(ctx, "needs at least one of perRow, created and textIds, or no create can be checked");
  });

const KeyList = z.array(Key).max(10);

const TrackerConfigShape = z
  .object({
    schema: z.literal(1),
    id: z.string().refine(isTrackerId, { message: "isn't an id: 2 to 32 lower-case letters, digits or -, starting with a letter (not none or default)" }),
    label: Text(40),
    info: z
      .object({
        urlTemplate: z.string().superRefine((text, ctx) => {
          const problem = checkUrlTemplate(text);
          if (problem) custom(ctx, `the task link ${problem}`);
        }),
        taskRefPlaceholder: Text(120).optional(),
        serverHint: Text(60).optional(),
      })
      .strict(),
    servers: z
      .object({
        /** Substrings of a server's name, at least 3 characters. */
        match: z.array(z.string().overwrite(ownText).min(3).max(64)).max(10).default([]),
        /** Exact names, case-insensitive, preferred first. */
        prefer: Words(64, 10).default([]),
        fallback: Text(64).optional(),
      })
      .strict()
      .prefault({}),
    taskRef: z
      .object({
        /** Explicit references. */
        id: ScannedPattern,
        /** Free text and branch names; default: `id`. */
        idInText: ScannedPattern.optional(),
        /** Before an explicit ID: "task 123". */
        prefixes: Words(40).default([]),
        /** Before an ID in free text. */
        keywords: Words(40).default([]),
        /** IDs in free text without a keyword (self-describing keys such as ACME-12). */
        bare: z.boolean().default(false),
        urls: z.array(UrlPatternText).max(5).default([]),
        /** For the ID itself; prefixes, keywords and URLs always are. */
        caseInsensitive: z.boolean().default(false),
        normalize: z.enum(["none", "upper", "lower"]).default("none"),
      })
      .strict(),
    ids: z.object({ task: Pattern.optional(), entity: Pattern.optional(), timeLog: Pattern.optional() }).strict().prefault({}),
    objectKeys: z
      .object({ id: KeyList.default(["id"]), text: KeyList.default(["value", "name"]), name: KeyList.default(["name"]) })
      .strict()
      .prefault({}),
    tools: z
      .object({
        testConnection: ToolName.optional(),
        reserved: z.array(ToolName).max(20).default([]),
        confirm: z.array(ToolName).max(20).default([]),
        /** A raw read tool → its formatted twin: a server filter that names the twin allows the raw tool. */
        rawCompanions: Limited(z.record(ToolName, ToolName), 20).default({}),
      })
      .strict()
      .prefault({}),
    tasks: z
      .object({
        myTasks: ToolChoice,
        byId: Call(ARGUMENT_SPECS.byId).optional(),
        lists: KeyList.default([]),
        emptyText: Words(80, 10).default([]),
        fields: z
          .object({
            id: Paths,
            title: Paths,
            status: Paths.optional(),
            priority: Paths.optional(),
            taskType: Paths.optional(),
            projectId: Paths.optional(),
            projectName: Paths.optional(),
            customerId: Paths.optional(),
            customerName: Paths.optional(),
            dueDate: Paths.optional(),
            modifiedAt: Paths.optional(),
          })
          .strict(),
        comments: Comments.optional(),
        closedStatuses: Words(40).default([]),
        statusRank: Words(40, 30).default([]),
      })
      .strict(),
    timeLogs: z
      .object({
        byRange: Call(ARGUMENT_SPECS.byRange),
        lists: KeyList.default([]),
        emptyText: Words(80, 10).default([]),
        fields: z
          .object({
            id: Paths,
            taskId: Paths,
            start: Paths,
            end: Paths,
            taskTitle: Paths.optional(),
            projectId: Paths.optional(),
            customerId: Paths.optional(),
            comment: Paths.optional(),
          })
          .strict(),
        /** How `{start}` and `{end}` are written (`time.ts`): local wall time, with the zone's offset, or in UTC. */
        time: z.enum(["local", "offset", "utc"]).default("local"),
        requiresProjectCustomer: z.boolean().default(false),
        create: z.object({ tool: ToolName, args: Template(ARGUMENT_SPECS.create), result: CreateResult }).strict(),
        update: Write(ARGUMENT_SPECS.update),
        delete: Write(ARGUMENT_SPECS.delete),
      })
      .strict()
      .optional(),
    projects: z
      .object({
        search: Write(ARGUMENT_SPECS.search).optional(),
        lists: KeyList.default([]),
        fields: z.object({ id: Paths, name: Paths, customerId: Paths.optional(), customerName: Paths.optional() }).strict(),
      })
      .strict()
      .optional(),
    /** Customer names the tracker never resolves to an ID, by lower-cased name: a last resort. */
    knownIds: z
      .object({ customers: Limited(z.record(Text(120), z.string().min(1).max(64)), 50) })
      .partial()
      .strict()
      .optional(),
    timekeeper: z
      .object({
        routes: z.array(Route).max(20).default([]),
        steps: z.array(TextTemplate(600, TEXT_VARIABLES.steps)).max(6).default([]),
        dateRangeHint: TextTemplate(300, TEXT_VARIABLES.dateRangeHint).optional(),
        resolveIdsHint: TextTemplate(300, TEXT_VARIABLES.resolveIdsHint).optional(),
        commentHint: TextTemplate(200, TEXT_VARIABLES.commentHint).optional(),
        taskUpdatesName: Text(60).optional(),
      })
      .strict()
      .prefault({}),
    messages: z
      .object({ invalidTaskRef: TextTemplate(300, TEXT_VARIABLES.messages), invalidRuleTaskRef: TextTemplate(300, TEXT_VARIABLES.messages) })
      .partial()
      .strict()
      .prefault({}),
  })
  .strict();

export type TrackerConfig = z.output<typeof TrackerConfigShape>;
export type ConfigRoute = TrackerConfig["timekeeper"]["routes"][number];

export const TrackerConfigSchema = TrackerConfigShape.superRefine((config, ctx) => crossChecks(config, ctx));

// ---------------------------------------------------------------------------------------------------------------------
// Derived parts

/** The config's ID patterns, parsed, with their defaults: `ids.task` and `taskRef.idInText` default to `taskRef.id`. */
export interface ConfigPatterns {
  ref: IdPattern;
  refInText: IdPattern;
  task: IdPattern;
  entity: IdPattern;
  timeLog: IdPattern;
}

function pattern(text: string): IdPattern {
  const parsed = parseIdPattern(text);
  if (!parsed.ok) throw new Error(`Unchecked ID pattern: ${parsed.error}`);
  return parsed.value;
}

/** For a config the schema accepted. */
export function configPatterns(config: Pick<TrackerConfig, "taskRef" | "ids">): ConfigPatterns {
  return {
    ref: pattern(config.taskRef.id),
    refInText: pattern(config.taskRef.idInText ?? config.taskRef.id),
    task: pattern(config.ids.task ?? config.taskRef.id),
    entity: pattern(config.ids.entity ?? DEFAULT_ID_PATTERN),
    timeLog: pattern(config.ids.timeLog ?? DEFAULT_ID_PATTERN),
  };
}

export function configUrlPatterns(config: Pick<TrackerConfig, "taskRef">): UrlPattern[] {
  return config.taskRef.urls.map((text) => {
    const parsed = parseUrlPattern(text);
    if (!parsed.ok) throw new Error(`Unchecked URL pattern: ${parsed.error}`);
    return parsed.value;
  });
}

/**
 * The exact-name routes the engine appends after the config's own: `tasks` for `myTasks` and `byId.tools`,
 * `timeLogs`/`dateRange` for `byRange.tools`, `projects` for `projects.search.tool`.
 */
export function derivedRoutes(config: Pick<TrackerConfig, "tasks" | "timeLogs" | "projects">): ConfigRoute[] {
  const tasks = [...config.tasks.myTasks, ...(config.tasks.byId?.tools ?? [])];
  return [
    { handler: "tasks", equals: tasks },
    ...(config.timeLogs ? [{ handler: "timeLogs" as const, mode: "dateRange" as const, equals: [...config.timeLogs.byRange.tools] }] : []),
    ...(config.projects?.search ? [{ handler: "projects" as const, equals: [config.projects.search.tool] }] : []),
  ];
}

/** What a route matches on, read-only: a config's routes and a tracker's (`TrackerRoute`) both fit. */
export interface RouteTerms {
  readonly equals?: readonly string[];
  readonly anyOf?: readonly string[];
  readonly allOf?: readonly string[];
  readonly noneOf?: readonly string[];
}

/** Whether a route matches a bare tool name (no server prefix), case-insensitively. */
export function routeMatches<R extends RouteTerms>(route: R, toolName: string): boolean {
  const name = toolName.toLowerCase();
  const has = (s: string) => name.includes(s.toLowerCase());
  const hit = route.equals ? route.equals.some((e) => e.toLowerCase() === name) : (route.anyOf ?? []).some(has);
  return hit && (route.allOf ?? []).every(has) && !(route.noneOf ?? []).some(has);
}

// ---------------------------------------------------------------------------------------------------------------------
// Cross-checks

/** Runs only on a config whose parts all passed (zod runs an object's refinement after its parts' own issues too). */
function crossChecks(config: TrackerConfig, ctx: z.RefinementCtx): void {
  if (ctx.issues.length > 0) return;
  try {
    checkWhole(config, ctx);
  } catch (error) {
    custom(ctx, `couldn't be checked: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function checkWhole(config: TrackerConfig, ctx: z.RefinementCtx): void {
  const reserved = new Set(config.tools.reserved);

  // Every tool ARIA may call without asking is named like a read and isn't reserved.
  const readTool = (tool: string, path: PropertyKey[]) => {
    if (classifyTool(tool) !== "read") custom(ctx, `${tool} isn't named like a read tool, and ARIA calls it without asking`, path);
    else if (reserved.has(tool)) custom(ctx, `${tool} is reserved, so ARIA can't read with it`, path);
  };
  config.tasks.myTasks.forEach((tool, i) => readTool(tool, ["tasks", "myTasks", i]));
  config.tasks.byId?.tools.forEach((tool, i) => readTool(tool, ["tasks", "byId", "tools", i]));
  config.timeLogs?.byRange.tools.forEach((tool, i) => readTool(tool, ["timeLogs", "byRange", "tools", i]));
  if (config.projects?.search) readTool(config.projects.search.tool, ["projects", "search", "tool"]);
  for (const raw of Object.keys(config.tools.rawCompanions)) readTool(raw, ["tools", "rawCompanions", raw]);
  // The connection test is called directly, with no arguments, when the user tests the server: it must be a read.
  const test = config.tools.testConnection;
  if (test) {
    if (classifyTool(test) !== "read") custom(ctx, `${test} isn't named like a read tool, and the connection test calls it directly`, ["tools", "testConnection"]);
    else if (reserved.has(test)) custom(ctx, `${test} is reserved`, ["tools", "testConnection"]);
  }

  // At runtime a result goes to the first matching route of every handler, so a route of another handler (or a
  // history route) matching a read tool first would read its result too, wrongly. Refused: the first route a tool name
  // reaches (the config's own routes, then the derived ones) must be the one for what it reads, as for a date-range
  // tool below.
  const allRoutes = [...config.timekeeper.routes, ...derivedRoutes(config)];
  const reaches = (tool: string) => allRoutes.find((route) => routeMatches(route, tool));
  const describeRoute = (route: ConfigRoute | undefined) => (route ? `the ${route.handler}${route.mode ? ` ${route.mode}` : ""} route` : "no route");
  const tasksTools = [
    ...config.tasks.myTasks.map((tool, i) => [tool, ["tasks", "myTasks", i]] as const),
    ...(config.tasks.byId?.tools ?? []).map((tool, i) => [tool, ["tasks", "byId", "tools", i]] as const),
  ];
  for (const [tool, path] of tasksTools) {
    const first = reaches(tool);
    if (first?.handler !== "tasks" || first.mode) {
      custom(ctx, `${tool} is read first as ${describeRoute(first)}; a task read must be read first as plain tasks (a history route doesn't cache them, and another handler would read the result as its own)`, [...path]);
    }
  }
  const search = config.projects?.search?.tool;
  if (search) {
    const first = reaches(search);
    if (first?.handler !== "projects") {
      custom(ctx, `${search} is read first as ${describeRoute(first)}; a project search must be read first by a projects route`, ["projects", "search", "tool"]);
    }
  }

  if (config.timeLogs) {
    const timeLogs = config.timeLogs;
    // The write tools stay with the Time view (its checks run first).
    for (const part of ["create", "update", "delete"] as const) {
      const tool = timeLogs[part].tool;
      if (!reserved.has(tool)) custom(ctx, `${tool} (timeLogs.${part}.tool) must be in tools.reserved, so only the Time view calls it`, ["tools", "reserved"]);
    }
    // A date-range result reaches the time-log reader in date-range mode first, or nothing reconciles.
    timeLogs.byRange.tools.forEach((tool, i) => {
      const first = reaches(tool);
      if (first?.handler !== "timeLogs" || first.mode !== "dateRange") {
        custom(ctx, `${tool} is read first as ${describeRoute(first)}; a date-range read must be read first by a timeLogs dateRange route`, ["timeLogs", "byRange", "tools", i]);
      }
    });
    if (timeLogs.requiresProjectCustomer) {
      const used = checkTemplate(timeLogs.create.args, ARGUMENT_SPECS.create).used;
      for (const variable of ["projectId", "customerId"]) {
        if (!used.has(variable)) custom(ctx, `requiresProjectCustomer needs {${variable}} in the create arguments`, ["timeLogs", "create", "args"]);
      }
    }
  }

  const patterns = configPatterns(config);
  const entity = idMatcher(patterns.entity, false);
  for (const [name, id] of Object.entries(config.knownIds?.customers ?? {})) {
    if (!entity.test(id)) custom(ctx, `"${id}" doesn't match ids.entity`, ["knownIds", "customers", name]);
  }

  // Every regex built from the config compiles.
  try {
    buildTaskRefRegexes({
      id: patterns.ref,
      idInText: patterns.refInText,
      prefixes: config.taskRef.prefixes,
      keywords: config.taskRef.keywords,
      bare: config.taskRef.bare,
      urls: configUrlPatterns(config),
      caseInsensitive: config.taskRef.caseInsensitive,
    });
    for (const p of Object.values(patterns)) idMatcher(p, true);
  } catch (error) {
    custom(ctx, `a task-reference regex doesn't compile: ${error instanceof Error ? error.message : String(error)}`, ["taskRef"]);
  }
}
