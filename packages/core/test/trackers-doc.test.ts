/**
 * docs/trackers.md says what the config format is, and this test keeps it saying so. The doc can't drift from the code:
 *
 * 1. Every fenced block marked `json config` loads (`parseTrackerConfig`), and the two examples are the fixtures every tracker
 *    test uses, as they are.
 * 2. Field by field: the key paths of `TrackerConfigSchema` (read through zod 4's public `def`) are the rows of the reference
 *    tables, no more and no fewer. A key renamed in the schema or in the doc fails here, with its path in the message.
 * 3. Every template variable and directive, and every limit, is in the doc, with the number the code has.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { MAX_ID_LENGTH, MAX_AMBIGUITY, MAX_PATTERN_LENGTH } from "../src/trackers/config/patterns.ts";
import { MAX_PATH_LENGTH, MAX_PATH_SEGMENTS } from "../src/trackers/config/fields.ts";
import { MAX_CONFIG_BYTES, MAX_ERROR_LINE_CHARS, MAX_ERROR_LINES, parseTrackerConfig } from "../src/trackers/config/load.ts";
import { ARGUMENT_SPECS, TEXT_VARIABLES, TrackerConfigSchema } from "../src/trackers/config/schema.ts";
import { checkTemplate, TEMPLATE_MAX_DEPTH, TEMPLATE_MAX_NODES, type TemplateSpec } from "../src/trackers/config/template.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
/** The doc this test reads; `TRACKERS_DOC` points it at another copy (a deliberate break, in a scratch folder). */
const DOC = process.env.TRACKERS_DOC ?? path.resolve(here, "../../../docs/trackers.md");
const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(here, "fixtures", "trackers", name), "utf8"));
const doc = readFileSync(DOC, "utf8").replace(/\r\n/g, "\n");

// ---------------------------------------------------------------------------------------------------------------------
// Reading the doc

/** The text of each fenced block whose info string is `json config`. */
function configBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^```json config\s*$/.test(lines[i]!)) continue;
    const body: string[] = [];
    for (i++; i < lines.length && !/^```\s*$/.test(lines[i]!); i++) body.push(lines[i]!);
    blocks.push(body.join("\n"));
  }
  return blocks;
}

/** The lines of a `## ` section, by its exact heading text. */
function section(markdown: string, heading: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line === `## ${heading}`);
  if (start < 0) throw new Error(`docs/trackers.md has no "## ${heading}" section`);
  const end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/** The cells of a table row, trimmed; undefined for a line that isn't a row, or is the separator. */
function cells(line: string): string[] | undefined {
  if (!line.startsWith("|")) return undefined;
  const parts = line.replace(/^\|/, "").replace(/\|\s*$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim());
  return parts.every((cell) => /^:?-{3,}:?$/.test(cell)) ? undefined : parts;
}

/** The first cell of each table row that is exactly one backticked word: a key path. */
function rowPaths(lines: string[]): string[] {
  return lines.flatMap((line) => {
    const first = cells(line)?.[0];
    const match = first && /^`([^`]+)`$/.exec(first);
    return match ? [match[1]!] : [];
  });
}

/** The rows of the tables of a section, by their first cell with its backticks taken off. */
function rows(lines: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of lines) {
    const row = cells(line);
    if (row && row.length > 1) out.set(row[0]!.replace(/^`(.*)`$/, "$1"), row);
  }
  return out;
}

/** Where two JSON values first differ, as a path with what each has there; undefined when they are the same. */
function firstDifference(shown: unknown, wanted: unknown, at: string): string | undefined {
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
  if (!isObject(shown) || !isObject(wanted)) return JSON.stringify(shown) === JSON.stringify(wanted) ? undefined : `${at || "the whole"}: the doc has ${JSON.stringify(shown)}, the fixture ${JSON.stringify(wanted)}`;
  for (const key of new Set([...Object.keys(shown), ...Object.keys(wanted)])) {
    const next = at ? `${at}.${key}` : key;
    if (!(key in shown)) return `${next}: the doc has no such key, the fixture has ${JSON.stringify(wanted[key])}`;
    if (!(key in wanted)) return `${next}: the doc has ${JSON.stringify(shown[key])}, the fixture has no such key`;
    const found = firstDifference(shown[key], wanted[key], next);
    if (found) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading the schema, through zod 4's public `def`

interface PublicDef {
  type: string;
  shape?: Record<string, z.ZodType>;
  innerType?: z.ZodType;
  element?: z.ZodType;
  valueType?: z.ZodType;
  options?: z.ZodType[];
  in?: z.ZodType;
}

/** Every key path of a schema: each key of each object, with `[]` for an item of a list that is itself an object. */
function keyPaths(schema: z.ZodType): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const walk = (node: z.ZodType, prefix: string): void => {
    const def = node.def as unknown as PublicDef;
    switch (def.type) {
      case "optional":
      case "nullable":
      case "default":
      case "prefault":
      case "nonoptional":
      case "readonly":
        return walk(def.innerType!, prefix);
      case "pipe":
        return walk(def.in!, prefix);
      case "array":
        return walk(def.element!, `${prefix}[]`);
      case "record":
        return walk(def.valueType!, `${prefix}{}`);
      case "union":
        return def.options!.forEach((option) => walk(option, prefix));
      case "object":
        for (const [key, value] of Object.entries(def.shape!)) {
          const keyPath = prefix ? `${prefix}.${key}` : key;
          if (!seen.has(keyPath)) {
            seen.add(keyPath);
            paths.push(keyPath);
          }
          walk(value, keyPath);
        }
        return;
      default:
    }
  };
  walk(schema, "");
  return paths;
}

// ---------------------------------------------------------------------------------------------------------------------

describe("docs/trackers.md", () => {
  it("has examples that load, and that are the fixtures the tracker tests use", () => {
    const blocks = configBlocks(doc);
    expect(blocks.length, "the doc needs two ```json config blocks: Acme, then Globex").toBeGreaterThanOrEqual(2);
    blocks.forEach((block, i) => {
      const parsed = parseTrackerConfig(block);
      expect(parsed.ok ? [] : parsed.errors, `the ${i + 1}. \`json config\` block of docs/trackers.md doesn't load`).toEqual([]);
    });
    for (const [i, name] of ["acme.json", "globex.json"].entries()) {
      const shown: unknown = JSON.parse(blocks[i]!);
      const difference = firstDifference(shown, fixture(name), "");
      expect(difference, `the ${i + 1}. example of docs/trackers.md must be packages/core/test/fixtures/trackers/${name} as it is`).toBeUndefined();
    }
  });

  it("has a reference row for every key path of the schema, and no row for a key the schema doesn't have", () => {
    const expected = keyPaths(TrackerConfigSchema);
    expect(expected.length, "the schema walk found no key paths").toBeGreaterThan(100);
    const documented = rowPaths(section(doc, "The reference"));
    const problems = [
      ...expected.filter((p) => !documented.includes(p)).map((p) => `no row for \`${p}\`, which is a key path of the schema`),
      ...documented.filter((p) => !expected.includes(p)).map((p) => `a row for \`${p}\`, which is not a key path of the schema`),
      ...documented.filter((p, i) => documented.indexOf(p) !== i).map((p) => `more than one row for \`${p}\``),
    ];
    expect(problems, `the reference of docs/trackers.md doesn't match the schema:\n${problems.join("\n")}`).toEqual([]);
  });

  it("names every template variable and every directive, with its limits", () => {
    const templates = rows(section(doc, "Templates"));
    const variablesCell = (key: string): string => {
      const row = templates.get(key);
      if (!row) throw new Error(`the Templates section of docs/trackers.md has no row for ${key}`);
      return row[1] ?? "";
    };

    /** The variables of a spec, with whether each is required and whether it may be empty. */
    const specVariables = (spec: TemplateSpec): Array<{ name: string; required: boolean; mayBeEmpty: boolean }> => {
      const names = [...spec.scalars, ...(spec.lists ?? [])];
      const own = names.map((name) => ({ name, required: spec.required?.includes(name) ?? false, mayBeEmpty: spec.mayBeEmpty?.includes(name) ?? false }));
      const inRows = Object.entries(spec.rows ?? {}).flatMap(([rowsName, rowSpec]) => [
        { name: rowsName, required: spec.required?.includes(rowsName) ?? false, mayBeEmpty: false },
        ...specVariables(rowSpec),
      ]);
      return [...own, ...inRows];
    };

    const argumentRows: Array<[keyof typeof ARGUMENT_SPECS, string]> = [
      ["byId", "tasks.byId.args"],
      ["byRange", "timeLogs.byRange.args"],
      ["create", "timeLogs.create.args"],
      ["update", "timeLogs.update.args"],
      ["delete", "timeLogs.delete.args"],
      ["search", "projects.search.args"],
    ];
    const problems: string[] = [];
    for (const [name, key] of argumentRows) {
      const cell = variablesCell(key);
      for (const variable of specVariables(ARGUMENT_SPECS[name])) {
        if (!cell.includes(`\`{${variable.name}}\``)) problems.push(`${key}: the variable {${variable.name}} isn't in the doc`);
        else if (variable.required && !new RegExp(`\`\\{${variable.name}\\}\` \\(required`).test(cell)) problems.push(`${key}: {${variable.name}} should be marked (required)`);
        else if (variable.mayBeEmpty && !new RegExp(`\`\\{${variable.name}\\}\` \\(may be empty`).test(cell)) problems.push(`${key}: {${variable.name}} should be marked (may be empty)`);
      }
    }
    const textRows: Array<[keyof typeof TEXT_VARIABLES, string[]]> = [
      ["steps", ["timekeeper.steps"]],
      ["dateRangeHint", ["timekeeper.dateRangeHint"]],
      ["resolveIdsHint", ["timekeeper.resolveIdsHint"]],
      ["commentHint", ["timekeeper.commentHint"]],
      ["messages", ["messages.invalidTaskRef", "messages.invalidRuleTaskRef"]],
    ];
    for (const [name, keys] of textRows) {
      for (const key of keys) {
        const cell = variablesCell(key);
        for (const variable of TEXT_VARIABLES[name]) if (!cell.includes(`\`{${variable}}\``)) problems.push(`${key}: the variable {${variable}} isn't in the doc`);
      }
    }
    expect(problems, `the Templates section of docs/trackers.md doesn't match the code:\n${problems.join("\n")}`).toEqual([]);

    // Each directive of the doc is one the code takes: a sample of its use must check clean.
    const samples: Record<string, [unknown, TemplateSpec]> = {
      $json: [{ rows: { $json: { who: "{entryId}" } } }, ARGUMENT_SPECS.update],
      $each: [{ list: { $each: "rows", item: { task: "{taskId}" } } }, ARGUMENT_SPECS.create],
      $join: [{ ids: { $join: "ids", with: "," } }, ARGUMENT_SPECS.delete],
      $list: [{ ids: { $list: "ids" } }, ARGUMENT_SPECS.delete],
      $if: [{ id: "{entryId}", task: { $if: "taskId", value: "{taskId}" } }, ARGUMENT_SPECS.update],
      $literal: [{ id: "{entryId}", odd: { $literal: { $odd: 1 } } }, ARGUMENT_SPECS.update],
    };
    const directivesText = section(doc, "Templates").join("\n");
    const directiveProblems = Object.entries(samples).flatMap(([directive, [sample, spec]]) => {
      const found = [directivesText.includes(`"${directive}"`) ? [] : [`${directive} isn't in the doc`], checkTemplate(sample, spec).issues.map((issue) => `${directive}: ${issue.message}`)];
      return found.flat();
    });
    expect(directiveProblems, `the directives of docs/trackers.md don't match the code:\n${directiveProblems.join("\n")}`).toEqual([]);

    // The limits the doc names are the ones the code has.
    const limits = rows(section(doc, "The reference"));
    const wanted: Array<[string, string]> = [
      ["The config file", `${MAX_CONFIG_BYTES / 1024} KB`],
      ["A template's depth", `${TEMPLATE_MAX_DEPTH} levels`],
      ["A template's size", `${TEMPLATE_MAX_NODES} values`],
      ["An ID pattern's length", `${MAX_PATTERN_LENGTH} characters`],
      ["The longest ID a pattern may match", `${MAX_ID_LENGTH} characters`],
      ["The ways a pattern can match (the product of its repeats' ranges)", `${MAX_AMBIGUITY}`],
      ["Keys in a path", `${MAX_PATH_SEGMENTS}`],
      ["A path's length", `${MAX_PATH_LENGTH} characters`],
      ["Lines in an error message", `${MAX_ERROR_LINES}`],
      ["A line of an error message", `${MAX_ERROR_LINE_CHARS} characters`],
    ];
    const limitProblems = wanted.flatMap(([label, value]) => {
      const row = limits.get(label);
      if (!row) return [`the Limits table has no row "${label}"`];
      return row[1] === value ? [] : [`"${label}" is ${row[1] ?? "missing"} in the doc, and ${value} in the code`];
    });
    expect(limitProblems, `the Limits table of docs/trackers.md doesn't match the code:\n${limitProblems.join("\n")}`).toEqual([]);
  });
});
