/**
 * The generic task tracker a config describes (docs/trackers.md, "What a tracker config is"): `createConfigTracker(config)`
 * gives a `TaskTracker` whose references, task fields, comments, statuses, arguments and words all come from the
 * config's data and the engine's readers (`fields.ts`, `patterns.ts`, `template.ts`), with no code of its own for any
 * one tracker. The Timekeeper's reader and the create-result parser come in `reader.ts` and `results.ts`.
 *
 * A config tracker reads JSON only (the formatted text some trackers also give is ignored), and its tool
 * results are routed by bare tool name.
 */
import { trackerTaskUrl, type TimesheetEntry, type TrackerInfo } from "@aria/protocol";
import { extractJsonPayloads } from "../../util/mcp-payloads.ts";
import { hhmmToMinutes } from "../../timekeeper/checks.ts";
import type { TaskTracker, TimeLogContext, TrackerRoute, TrackerTask, UpdateTimeLogInput } from "../types.ts";
import { isPlainObject } from "./fields.ts";
import { buildTaskRefRegexes, firstGroup, MAX_BRANCH, MAX_SCAN_TEXT, scanText } from "./patterns.ts";
import { createReaders } from "./read.ts";
import { ARGUMENT_SPECS, configPatterns, configUrlPatterns, derivedRoutes, type TrackerConfig } from "./schema.ts";
import { checkTemplate, fillTemplate, fillText, TemplateValueError, type TemplateValues } from "./template.ts";
import { createConfigReader } from "./reader.ts";
import { createCreateResultParser } from "./results.ts";
import { formatTrackerTime } from "./time.ts";

export interface ConfigTrackerOptions {
  /** The tracker's servers, preferred first (the setting `integrations.tracker.servers`); none: the config's. */
  servers?: readonly string[];
  /** The config's hash (`load.ts`), shown by `/tracker`. */
  hash?: string;
}

/** A compact `YYYYMMDD` date (19000101–20991231) that looks like an 8-digit ID. */
const COMPACT_DATE = /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/;
/** A branch name's date segment (`2026-10-23-rc1`), which is not an ID. */
const DATE_SEGMENT = /^(?:19|20)\d{2}-\d{2}-\d{2}(?:[-_]|$)/;

export function createConfigTracker(config: TrackerConfig, options: ConfigTrackerOptions = {}): TaskTracker {
  const label = config.label;
  const patterns = configPatterns(config);
  const caseInsensitive = config.taskRef.caseInsensitive;
  const readers = createReaders(config);
  const { taskIdMatcher, timeLogIdMatcher } = readers;
  const regexes = buildTaskRefRegexes({
    id: patterns.ref,
    idInText: patterns.refInText,
    prefixes: config.taskRef.prefixes,
    keywords: config.taskRef.keywords,
    bare: config.taskRef.bare,
    urls: configUrlPatterns(config),
    caseInsensitive,
  });

  const info: TrackerInfo = {
    id: config.id,
    label,
    taskUrlTemplate: config.info.urlTemplate,
    taskRefPlaceholder: config.info.taskRefPlaceholder ?? `${label} task ID or link`,
    ...(config.info.serverHint ? { serverHint: config.info.serverHint } : {}),
    capabilities: { timeLogs: config.timeLogs !== undefined, projects: config.projects !== undefined },
  };

  // -------------------------------------------------------------------------------------------------------------------
  // References

  const normalize = (id: string): string => (config.taskRef.normalize === "upper" ? id.toUpperCase() : config.taskRef.normalize === "lower" ? id.toLowerCase() : id);
  const accept = (candidate: string | undefined, matcher: RegExp): string | undefined => (candidate !== undefined && matcher.test(candidate) ? normalize(candidate) : undefined);

  const parseTaskRef = (raw: string | undefined | null): string | undefined => {
    if (!raw) return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const fromUrl = accept(regexes.urlExact ? firstGroup(regexes.urlExact.exec(trimmed)) : undefined, regexes.id);
    if (fromUrl) return fromUrl;
    return accept(regexes.directId.exec(trimmed)?.[1], regexes.id);
  };

  const extractTaskRef = (...texts: Array<string | undefined | null>): string | undefined => {
    for (const raw of texts) {
      if (!raw) continue;
      const text = scanText(raw, MAX_SCAN_TEXT);
      if (regexes.urlInText) {
        for (const match of text.matchAll(regexes.urlInText)) {
          // A link holds the explicit ID (`taskRef.id`), not the shorter-lived free-text one.
          const found = accept(firstGroup(match), regexes.id);
          if (found) return found;
        }
      }
      for (const re of [regexes.keywordInText, regexes.bare]) {
        if (!re) continue;
        for (const match of text.matchAll(re)) {
          const candidate = match[1];
          if (candidate === undefined || COMPACT_DATE.test(candidate)) continue;
          const found = accept(candidate, regexes.idInText);
          if (found) return found;
        }
      }
    }
    return undefined;
  };

  const taskRefFromBranch = (branch: string | undefined | null): string | undefined => {
    if (!branch) return undefined;
    const trimmed = scanText(branch, MAX_BRANCH).trim();
    if (!trimmed) return undefined;
    const explicit = extractTaskRef(trimmed);
    if (explicit) return explicit;
    const cleaned = trimmed.replace(/^refs\/heads\//i, "").replace(/^refs\/remotes\/[^/]+\//i, "").replace(/^origin\//i, "");
    for (const segment of cleaned.split("/").filter(Boolean)) {
      if (DATE_SEGMENT.test(segment)) continue;
      const candidate = regexes.branchSegment.exec(segment)?.[1];
      if (candidate !== undefined && !COMPACT_DATE.test(candidate)) {
        const found = accept(candidate, regexes.idInText);
        if (found) return found;
      }
    }
    return undefined;
  };

  const defaultMessage = (input: string) => `"${input}" isn't a valid ${label} task ID or link.`;
  const message = (template: string | undefined) => (input: string) => (template === undefined ? defaultMessage(input) : fillText(template, { input }));

  // -------------------------------------------------------------------------------------------------------------------
  // Tasks

  const readTask = (item: unknown): TrackerTask | undefined => {
    if (!isPlainObject(item)) return undefined;
    const taskId = readers.taskId(item);
    const title = readers.title(item);
    if (!taskId || !title) return undefined;
    const projectId = readers.projectId(item);
    const customerId = readers.customerId(item);
    const read = readers.fields(item);
    return {
      taskId,
      title,
      ...(read.status ? { status: read.status } : {}),
      ...(read.priority ? { priority: read.priority } : {}),
      ...(read.taskType ? { taskType: read.taskType } : {}),
      ...(projectId ? { projectId } : {}),
      ...(read.projectName ? { projectName: read.projectName } : {}),
      ...(customerId ? { customerId } : {}),
      ...(read.customerName ? { customerName: read.customerName } : {}),
      ...(read.dueDate ? { dueDate: read.dueDate } : {}),
      ...(read.comment ? { comment: read.comment } : {}),
      ...(read.commentBy ? { commentBy: read.commentBy } : {}),
      ...(read.commentKey ? { commentKey: read.commentKey } : {}),
      ...(readers.isClosedStatus(read.status) ? { closed: true } : {}),
      raw: item,
    };
  };

  const parse = (rawResult: unknown): TrackerTask[] => {
    const byId = new Map<string, TrackerTask>();
    for (const payload of extractJsonPayloads(rawResult)) {
      for (const item of readers.taskItems(payload)) {
        const task = readTask(item);
        if (task && !byId.has(task.taskId)) byId.set(task.taskId, task);
      }
    }
    if (byId.size === 0 && !readers.isEmptyTasksAnswer(rawResult)) throw new Error(`Unrecognized response from ${label} tasks API.`);
    return [...byId.values()];
  };

  // -------------------------------------------------------------------------------------------------------------------
  // Arguments

  /** A refusal that names what is missing: any variable but a comment that is empty stops the call. */
  const fill = (template: unknown, spec: (typeof ARGUMENT_SPECS)[keyof typeof ARGUMENT_SPECS], values: TemplateValues, what: string, where?: string) => {
    try {
      return fillTemplate(template, spec, values);
    } catch (error) {
      if (error instanceof TemplateValueError) {
        throw new Error(`The ${label} config's ${what} arguments need ${error.variable}${where ? `, which ${where} doesn't have` : ""}.`, { cause: error });
      }
      throw error;
    }
  };

  const idsOf = (ids: readonly string[], matcher: RegExp) => ids.filter((id) => matcher.test(id));

  const timeLogs = config.timeLogs;
  const timeLogTools: TaskTracker["timeLogs"] = timeLogs
    ? {
        byRange: {
          tools: timeLogs.byRange.tools,
          args: (from, until) => fill(timeLogs.byRange.args, ARGUMENT_SPECS.byRange, { from, until }, "date-range"),
        },
        create: {
          tool: timeLogs.create.tool,
          args: (rows: readonly TimesheetEntry[], ctx: TimeLogContext) => {
            const used = checkTemplate(timeLogs.create.args, ARGUMENT_SPECS.create).used;
            const values = rows.map((row) => ({
              taskId: row.trackerTaskId ?? "",
              projectId: row.trackerProjectId ?? "",
              customerId: row.trackerCustomerId ?? "",
              date: row.date,
              start: formatTrackerTime(timeLogs.time, row.date, row.start, ctx.zone),
              end: formatTrackerTime(timeLogs.time, row.date, row.end, ctx.zone),
              minutes: String(row.minutes),
              comment: row.comment.trim(),
            }));
            values.forEach((row, i) => {
              for (const variable of ["taskId", "projectId", "customerId", "start", "end"] as const) {
                if (used.has(variable) && !row[variable]) {
                  throw new Error(`The ${label} config's create arguments need ${variable}, which row ${rows[i]!.start}–${rows[i]!.end} doesn't have.`);
                }
              }
            });
            return fill(timeLogs.create.args, ARGUMENT_SPECS.create, { rows: values }, "create");
          },
          parseResult: createCreateResultParser(config),
        },
        update: {
          tool: timeLogs.update.tool,
          args: (input: UpdateTimeLogInput, ctx: TimeLogContext) =>
            fill(
              timeLogs.update.args,
              ARGUMENT_SPECS.update,
              {
                entryId: input.entryId,
                date: input.date,
                start: formatTrackerTime(timeLogs.time, input.date, input.start, ctx.zone),
                end: formatTrackerTime(timeLogs.time, input.date, input.end, ctx.zone),
                minutes: String(hhmmToMinutes(input.end) - hhmmToMinutes(input.start)),
                comment: input.comment,
                ...(input.task ? { taskId: input.task.taskId, projectId: input.task.projectId, customerId: input.task.customerId } : {}),
              },
              "update",
            ),
        },
        delete: {
          tool: timeLogs.delete.tool,
          args: (entryIds, mode) => {
            if (mode !== "display") {
              const bad = entryIds.find((id) => !timeLogIdMatcher.test(id));
              if (bad !== undefined) throw new Error(`"${bad}" isn't a valid ${label} time-log ID.`);
            }
            return fill(timeLogs.delete.args, ARGUMENT_SPECS.delete, { ids: [...entryIds] }, "delete");
          },
        },
        requiresProjectCustomer: timeLogs.requiresProjectCustomer,
      }
    : undefined;

  const search = config.projects?.search;
  const byId = config.tasks.byId;
  const tk = config.timekeeper;

  const tracker: TaskTracker = {
    id: config.id,
    label,
    info,
    matchesServer: (serverName) => {
      const name = serverName.toLowerCase();
      if (options.servers && options.servers.length > 0) return options.servers.some((server) => server.toLowerCase() === name);
      return config.servers.match.some((part) => name.includes(part.toLowerCase()));
    },
    serverPreference: (serverName) => {
      const name = serverName.toLowerCase();
      const order = options.servers && options.servers.length > 0 ? options.servers : config.servers.prefer;
      const index = order.findIndex((server) => server.toLowerCase() === name);
      return index === -1 ? order.length : index;
    },
    ...(options.servers?.[0] ?? config.servers.fallback ? { fallbackServer: options.servers?.[0] ?? config.servers.fallback } : {}),
    rawCompanions: config.tools.rawCompanions,
    ...(config.tools.testConnection ? { testConnectionTool: config.tools.testConnection } : {}),
    reservedTools: new Set(config.tools.reserved),
    confirmTools: new Set(config.tools.confirm),

    parseTaskRef,
    extractTaskRef,
    taskRefFromBranch,
    taskUrl: (taskId) => trackerTaskUrl(info, taskId),
    messages: { invalidTaskRef: message(config.messages.invalidTaskRef), invalidRuleTaskRef: message(config.messages.invalidRuleTaskRef) },

    tasks: {
      myTasks: config.tasks.myTasks,
      ...(byId
        ? {
            byId: {
              tools: byId.tools,
              // The IDs that don't fit `ids.task` are left out (every caller passes `parseTaskRef`'s, so none are).
              args: (ids: readonly string[]) => fill(byId.args, ARGUMENT_SPECS.byId, { ids: idsOf(ids, taskIdMatcher) }, "task-lookup"),
            },
          }
        : {}),
      parse,
      lastSeenFields: (lastSeen) => readers.fields(lastSeen),
      isClosedStatus: readers.isClosedStatus,
      statusRank: readers.statusRank,
      ...(tk.commentHint ? { commentHint: (prefix: string) => fillText(tk.commentHint!, { prefix }) } : {}),
    },
    ...(timeLogTools ? { timeLogs: timeLogTools } : {}),
    ...(search ? { projects: { search: { tool: search.tool, args: (query: string) => fill(search.args, ARGUMENT_SPECS.search, { query }, "project-search") } } } : {}),
    timekeeper: {
      routes: [...tk.routes, ...derivedRoutes(config)] as readonly TrackerRoute[],
      createReader: (ctx) => createConfigReader(config, ctx),
      steps: (prefix) => tk.steps.map((step) => fillText(step, { prefix })),
      ...(tk.dateRangeHint ? { dateRangeHint: (date: string, nextDay: string) => fillText(tk.dateRangeHint!, { date, nextDay }) } : {}),
      ...(tk.resolveIdsHint ? { resolveIdsHint: (prefix: string, ids: readonly string[]) => fillText(tk.resolveIdsHint!, { prefix, ids: ids.join(",") }) } : {}),
      taskUpdatesName: tk.taskUpdatesName ?? `${label} task updates`,
    },
    ...(options.hash ? { configHash: options.hash } : {}),
  };
  return tracker;
}
