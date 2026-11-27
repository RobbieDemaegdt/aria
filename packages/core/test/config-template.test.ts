/**
 * Argument and text templates (docs/trackers.md, "Templates"): directives, `$literal`, `{{`, key order,
 * refused keys, unset variables, and values that hold `{x}` or `$&`. All tools and fields are fictional.
 */
import { describe, expect, it } from "vitest";
import {
  checkTemplate,
  checkTextTemplate,
  fillTemplate,
  fillText,
  TemplateValueError,
  type TemplateSpec,
} from "../src/trackers/config/template.ts";

const ROW: TemplateSpec = { scalars: ["taskId", "projectId", "start", "end", "comment"], mayBeEmpty: ["comment"], required: ["taskId"] };
const SPEC: TemplateSpec = {
  scalars: ["entryId", "start", "end", "comment", "taskId", "query"],
  lists: ["ids"],
  rows: { rows: ROW },
  mayBeEmpty: ["comment"],
};

const problems = (template: unknown, spec: TemplateSpec = SPEC) => checkTemplate(template, spec).issues.map((i) => `${i.path.join(".")}: ${i.message}`);

function filled(template: unknown, values: Record<string, unknown>, spec: TemplateSpec = SPEC): unknown {
  expect(problems(template, spec)).toEqual([]);
  return fillTemplate(template, spec, values as never);
}

describe("filling in", () => {
  it("puts values into placeholders by concatenation, never expanding them again", () => {
    expect(filled({ q: "{query}" }, { query: "Orbit Desk" })).toEqual({ q: "Orbit Desk" });
    expect(filled({ q: "id={entryId}&x={query}" }, { entryId: "7", query: "$& {query} $1 {{x}}" })).toEqual({ q: "id=7&x=$& {query} $1 {{x}}" });
    expect(filled({ q: "{{literal}} {{{query}}} }}" }, { query: "v" })).toEqual({ q: "{literal} {v} }" });
  });

  it("$json, $each, $join, $list and $if", () => {
    const template = {
      entries: { $json: { $each: "rows", item: { issue: { key: "{taskId}" }, started: "{start}", ended: "{end}", note: "{comment}", project: { $if: "projectId", value: "{projectId}" } } } },
      ids: { $join: "ids", with: ";" },
      idsDefault: { $join: "ids" },
      list: { $list: "ids" },
    };
    const rows = [
      { taskId: "ACME-1", start: "2026-10-23T09:00:00", end: "2026-10-23T10:00:00", comment: " Stand-up ", projectId: "P1" },
      { taskId: "ACME-2", start: "s", end: "e", comment: "" },
    ];
    expect(filled(template, { rows, ids: ["1", "2"] })).toEqual({
      entries:
        '[{"issue":{"key":"ACME-1"},"started":"2026-10-23T09:00:00","ended":"2026-10-23T10:00:00","note":" Stand-up ","project":"P1"},' +
        '{"issue":{"key":"ACME-2"},"started":"s","ended":"e","note":""}]',
      ids: "1;2",
      idsDefault: "1,2",
      list: ["1", "2"],
    });
    expect(filled({ list: { $list: "ids" } }, { ids: [] })).toEqual({ list: [] });
    expect(filled({ entries: { $each: "rows", item: { k: "{taskId}" } } }, { rows: [] })).toEqual({ entries: [] });
  });

  it("keeps the template's key order, $if properties included", () => {
    const template = {
      worklogs: { $json: [{ id: "{entryId}", started: "{start}", ended: "{end}", note: "{comment}", issue: { $if: "taskId", value: { key: "{taskId}" } }, zLast: 1 }] },
    };
    const out = filled(template, { entryId: "9", start: "s", end: "e", comment: "", taskId: "ACME-3" }) as { worklogs: string };
    expect(out.worklogs).toBe('[{"id":"9","started":"s","ended":"e","note":"","issue":{"key":"ACME-3"},"zLast":1}]');
    const without = filled(template, { entryId: "9", start: "s", end: "e", comment: "" }) as { worklogs: string };
    expect(without.worklogs).toBe('[{"id":"9","started":"s","ended":"e","note":"","zLast":1}]');
    expect(Object.keys(filled({ b: 1, a: 2, c: { $if: "taskId", value: 3 }, d: 4 }, {}) as object)).toEqual(["b", "a", "d"]);
  });

  it("$literal gives its value as it is", () => {
    expect(filled({ filter: { $literal: { $top: 10, q: "{query}", nested: [{ $each: "rows" }] } } }, {})).toEqual({
      filter: { $top: 10, q: "{query}", nested: [{ $each: "rows" }] },
    });
  });

  it("keeps constants and nulls", () => {
    expect(filled({ n: 1, t: true, f: false, z: null, list: ["a", 2] }, {})).toEqual({ n: 1, t: true, f: false, z: null, list: ["a", 2] });
  });

  it("stops on an empty or missing variable, except one that may be empty", () => {
    const fill = (values: Record<string, unknown>) => () => fillTemplate({ id: "{entryId}", note: "{comment}" }, SPEC, values as never);
    expect(fill({ entryId: "1", comment: "" })()).toEqual({ id: "1", note: "" });
    expect(fill({ entryId: "1" })()).toEqual({ id: "1", note: "" });
    expect(fill({ entryId: "" })).toThrow(TemplateValueError);
    expect(fill({})).toThrow(/entryId/);
    try {
      fill({ comment: "x" })();
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateValueError);
      expect((error as TemplateValueError).variable).toBe("entryId");
    }
    const rows = { rows: [{ taskId: "ACME-1", start: "s", end: "e" }, { taskId: "ACME-2", start: "s" }] };
    expect(() => fillTemplate({ e: { $each: "rows", item: { a: "{start}", b: "{end}" } } }, SPEC, rows as never)).toThrow(/end/);
    expect(() => fillTemplate({ ids: { $join: "ids" } }, SPEC, {})).toThrow(/ids/);
    expect(() => fillTemplate({ e: { $each: "rows", item: {} } }, SPEC, {})).toThrow(/rows/);
  });

  it("text templates", () => {
    expect(fillText("prefer {prefix}list_issues over {{x}}", { prefix: "Acme-" })).toBe("prefer Acme-list_issues over {x}");
    expect(fillText("{a}{b}", { a: "$&", b: "" })).toBe("$&");
    expect(() => fillText("{a}", {})).toThrow(TemplateValueError);
    expect(checkTextTemplate("use {prefix}x", ["prefix"])).toBeUndefined();
    expect(checkTextTemplate("use {date}", ["prefix"])).toContain("uses {date}, which isn't known here (known: {prefix})");
    expect(checkTextTemplate("a { b", ["prefix"])).toContain('doesn\'t start a placeholder');
    expect(checkTextTemplate("a } b", ["prefix"])).toContain("doesn't end a placeholder");
    expect(checkTextTemplate("{1x}", ["prefix"])).toContain("doesn't start a placeholder");
    expect(checkTextTemplate("{{1x}}", [])).toBeUndefined();
  });
});

describe("checking", () => {
  it("accepts a template and lists the variables it uses", () => {
    const check = checkTemplate({ a: "{entryId}", b: { $join: "ids" }, c: { $each: "rows", item: { k: "{taskId}", p: { $if: "projectId", value: "{projectId}" } } } }, SPEC);
    expect(check.issues).toEqual([]);
    expect([...check.used].sort()).toEqual(["entryId", "ids", "projectId", "rows", "taskId"]);
  });

  it.each([
    [[], ": the arguments must be an object of argument names and values"],
    ["{query}", ": the arguments must be an object of argument names and values"],
    [undefined, ": the arguments must be an object of argument names and values"],
    [{ $json: {} }, ": the arguments must be an object of argument names and values"],
    [{ q: "{nope}" }, "q: uses {nope}, which isn't known here"],
    [{ q: "a { b" }, "q: a \"{\" at character 3 doesn't start a placeholder"],
    [{ q: "a } b" }, "q: a \"}\" at character 3 doesn't end a placeholder"],
    [{ q: "x".repeat(2_001) }, "q: a string has at most 2000 characters"],
    [JSON.parse('{"__proto__": 1}'), "__proto__: the key \"__proto__\" isn't allowed"],
    [{ constructor: 1 }, "constructor: the key \"constructor\" isn't allowed"],
    [{ a: { prototype: 1 } }, "a.prototype: the key \"prototype\" isn't allowed"],
    [{ 0: "a" }, "0: the key \"0\" is a number, which JSON would move to the front of the object"],
    [{ a: { 12: "a" } }, "a.12: the key \"12\" is a number"],
    [{ "": 1 }, ": a key must be 1 to 100 characters"],
    [{ ["k".repeat(101)]: 1 }, "a key must be 1 to 100 characters"],
    [{ "a\u0000": 1 }, "a key must be 1 to 100 characters, without control characters"],
    [{ a: { $foo: 1 } }, "a: \"$foo\" isn't a directive"],
    [{ a: { $json: 1, $list: "ids" } }, "a: one directive per object"],
    [{ a: { $json: 1, extra: 2 } }, "a: $json doesn't take \"extra\""],
    [{ a: { $each: "rows" } }, "a: $each needs an \"item\""],
    [{ a: { $each: "nope", item: 1 } }, "a.$each: $each needs the name of a list of rows (known: rows)"],
    [{ a: { $each: "rows", item: { k: "{entryId}" } } }, "a.item.k: uses {entryId}, which isn't known here"],
    [{ a: { $each: "rows", item: { k: "{start}" } } }, "a.item: each row needs {taskId}"],
    [{ a: { $join: "nope" } }, "a.$join: $join needs the name of a list (known: ids)"],
    [{ a: { $join: "ids", with: 5 } }, "a.with: \"with\" is a string of at most 10 characters"],
    [{ a: { $join: "ids", with: "x".repeat(11) } }, "a.with: \"with\" is a string of at most 10 characters"],
    [{ a: { $list: "entryId" } }, "a.$list: $list needs the name of a list"],
    [{ a: [{ $if: "taskId", value: 1 }] }, "a.0: $if goes only directly under an object's key"],
    [{ a: { $json: { $if: "taskId", value: 1 } } }, "a.$json: $if goes only directly under an object's key"],
    [{ a: { $if: "nope", value: 1 } }, "a.$if: $if needs the name of a variable"],
    [{ a: { $if: "taskId" } }, "a: $if needs a \"value\""],
    [{ a: { $literal: JSON.parse('{"__proto__": 1}') } }, "a.$literal.__proto__: the key \"__proto__\" isn't allowed"],
    [{ a: { $literal: { 3: 1 } } }, "a.$literal.3: the key \"3\" is a number"],
  ])("refuses %j", (template, problem) => {
    expect(problems(template).join("\n")).toContain(problem);
  });

  it("refuses more than 8 levels or 200 values", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 9; i++) deep = { k: deep };
    expect(problems(deep)).toEqual(["k.k.k.k.k.k.k.k.k: a template has at most 200 values, 8 levels deep"]);
    let ok: unknown = "x";
    for (let i = 0; i < 8; i++) ok = { k: ok };
    expect(problems(ok)).toEqual([]);
    expect(problems({ list: Array.from({ length: 199 }, () => 1) })).toEqual(["list.198: a template has at most 200 values, 8 levels deep"]);
    expect(problems({ list: Array.from({ length: 198 }, () => 1) })).toEqual([]);
  });

  it("refuses a template that leaves out a required variable", () => {
    expect(problems({ a: 1 }, { scalars: ["from"], required: ["from"] })).toEqual([": the arguments need {from}"]);
    expect(problems({ a: 1 }, { scalars: [], lists: ["ids"], required: ["ids"] })).toEqual([": the arguments need ids ($join or $list)"]);
    expect(problems({ a: 1 }, { scalars: [], rows: { rows: ROW }, required: ["rows"] })).toEqual([": the arguments need rows ($each)"]);
    expect(problems({ a: { $if: "from", value: "{from}" } }, { scalars: ["from"], required: ["from"] })).toEqual([]);
  });
});
