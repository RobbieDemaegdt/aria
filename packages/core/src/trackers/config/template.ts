/**
 * Argument and text templates in a tracker config (docs/trackers.md, "Templates").
 *
 * A template is a JSON value the engine fills in for a call. Strings hold placeholders `{name}`; `{{` and `}}` are
 * literal braces. Values go in by concatenation, so `$&` or `{x}` inside a value stays as it is and is never expanded
 * again. An object with a `$` key is a directive:
 *
 * | Directive | Gives |
 * | --- | --- |
 * | `{ "$json": T }` | `JSON.stringify` of `T` filled in |
 * | `{ "$each": "rows", "item": T }` | an array: `T` filled in once per row, with the row's variables |
 * | `{ "$join": "ids", "with": "," }` | the list joined into one string (`with` defaults to `,`) |
 * | `{ "$list": "ids" }` | the list as an array of strings |
 * | `{ "$if": "<variable>", "value": T }` | as an object property: left out when the variable is empty |
 * | `{ "$literal": V }` | `V` as it is (no placeholders, no directives): for a real key that starts with `$` |
 *
 * Checking refuses integer-like keys (`JSON.parse` would move them to the front, so the key order the template gives
 * wouldn't hold), `__proto__`, `constructor` and `prototype`, unknown directives, placeholders and variables, and more
 * than 8 levels or 200 values. Filling refuses an empty or missing variable outside `$if` (except the ones a spec says
 * may be empty, sent as `""`), before anything is sent.
 */
import { isPlainObject, isPrototypeKey, type JsonObject } from "./fields.ts";

export const TEMPLATE_MAX_DEPTH = 8;
export const TEMPLATE_MAX_NODES = 200;
const MAX_STRING = 2_000;
const MAX_KEY = 100;
const MAX_JOIN_WITH = 10;

/** The variables a template can use. */
export interface TemplateSpec {
  /** Single values: `{name}` placeholders and `$if`. */
  readonly scalars: readonly string[];
  /** Lists of strings: `$join` and `$list`. */
  readonly lists?: readonly string[];
  /** Lists of rows: `$each`, whose item is checked and filled with the row's own spec. */
  readonly rows?: Readonly<Record<string, TemplateSpec>>;
  /** Scalars sent as `""` when empty (a comment). Any other empty placeholder stops the call. */
  readonly mayBeEmpty?: readonly string[];
  /** Variables the template must use: a delete that names no IDs would say nothing about what it deletes. */
  readonly required?: readonly string[];
}

export interface TemplateIssue {
  path: Array<string | number>;
  message: string;
}

export interface TemplateCheck {
  issues: TemplateIssue[];
  /** Every variable the template uses, rows' own included. */
  used: Set<string>;
}

const DIRECTIVES: Readonly<Record<string, readonly string[]>> = {
  $json: [],
  $each: ["item"],
  $join: ["with"],
  $list: [],
  $if: ["value"],
  $literal: [],
};

const INTEGER_KEY = /^\d+$/;
const CONTROL = /\p{C}/u;
const PLACEHOLDER = /^\{([A-Za-z][A-Za-z0-9]{0,39})\}/;

type Segment = { text: string } | { variable: string };

/** A template string's literal text and placeholders, or the first problem with its braces. */
function parseString(text: string): { segments: Segment[] } | { error: string } {
  const segments: Segment[] = [];
  let literal = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "{" && text[i + 1] === "{") {
      literal += "{";
      i += 2;
    } else if (ch === "}" && text[i + 1] === "}") {
      literal += "}";
      i += 2;
    } else if (ch === "{") {
      const m = PLACEHOLDER.exec(text.slice(i));
      if (!m) return { error: `a "{" at character ${i + 1} doesn't start a placeholder such as {name}; write {{ for a brace` };
      if (literal) segments.push({ text: literal });
      literal = "";
      segments.push({ variable: m[1]! });
      i += m[0].length;
    } else if (ch === "}") {
      return { error: `a "}" at character ${i + 1} doesn't end a placeholder; write }} for a brace` };
    } else {
      literal += ch;
      i++;
    }
  }
  if (literal) segments.push({ text: literal });
  return { segments };
}

const list = (names: readonly string[]) => (names.length > 0 ? names.map((n) => `{${n}}`).join(", ") : "none");

/** Checks a text template (a hint, a step, a message): its braces and its placeholders. */
export function checkTextTemplate(text: string, variables: readonly string[]): string | undefined {
  const parsed = parseString(text);
  if ("error" in parsed) return parsed.error;
  for (const s of parsed.segments) {
    if ("variable" in s && !variables.includes(s.variable)) return `uses {${s.variable}}, which isn't known here (known: ${list(variables)})`;
  }
  return undefined;
}

interface CheckState {
  issues: TemplateIssue[];
  used: Set<string>;
  nodes: number;
  tooBig: boolean;
}

function checkKey(key: string, path: Array<string | number>, state: CheckState): boolean {
  const problem = isPrototypeKey(key)
    ? `the key "${key}" isn't allowed`
    : INTEGER_KEY.test(key)
      ? `the key "${key}" is a number, which JSON would move to the front of the object`
      : key.length === 0 || key.length > MAX_KEY || CONTROL.test(key)
        ? `a key must be 1 to ${MAX_KEY} characters, without control characters`
        : undefined;
  if (problem) state.issues.push({ path: [...path, key], message: problem });
  return !problem;
}

function count(path: Array<string | number>, depth: number, state: CheckState): boolean {
  state.nodes++;
  if (state.nodes > TEMPLATE_MAX_NODES || depth > TEMPLATE_MAX_DEPTH) {
    if (!state.tooBig) state.issues.push({ path, message: `a template has at most ${TEMPLATE_MAX_NODES} values, ${TEMPLATE_MAX_DEPTH} levels deep` });
    state.tooBig = true;
    return false;
  }
  return true;
}

/** A `$literal` value: JSON as it is, with the same key rules and limits. */
function checkLiteral(value: unknown, path: Array<string | number>, depth: number, state: CheckState): void {
  if (!count(path, depth, state)) return;
  if (Array.isArray(value)) value.forEach((item, i) => checkLiteral(item, [...path, i], depth + 1, state));
  else if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) if (checkKey(key, path, state)) checkLiteral(child, [...path, key], depth + 1, state);
  } else if (typeof value === "string" && value.length > MAX_STRING) {
    state.issues.push({ path, message: `a string has at most ${MAX_STRING} characters` });
  }
}

function checkNode(value: unknown, spec: TemplateSpec, path: Array<string | number>, depth: number, state: CheckState, isProperty: boolean): void {
  if (!count(path, depth, state)) return;
  const issue = (message: string, at = path): void => {
    state.issues.push({ path: at, message });
  };

  if (typeof value === "string") {
    if (value.length > MAX_STRING) return issue(`a string has at most ${MAX_STRING} characters`);
    const parsed = parseString(value);
    if ("error" in parsed) return issue(parsed.error);
    for (const s of parsed.segments) {
      if (!("variable" in s)) continue;
      if (spec.scalars.includes(s.variable)) state.used.add(s.variable);
      else issue(`uses {${s.variable}}, which isn't known here (known: ${list(spec.scalars)})`);
    }
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkNode(item, spec, [...path, i], depth + 1, state, false));
    return;
  }
  if (!isPlainObject(value)) return issue("isn't a JSON value");

  const keys = Object.keys(value);
  const directives = keys.filter((k) => k.startsWith("$"));
  if (directives.length === 0) {
    for (const key of keys) if (checkKey(key, path, state)) checkNode(value[key], spec, [...path, key], depth + 1, state, true);
    return;
  }
  if (directives.length > 1) return issue(`one directive per object (${directives.join(", ")})`);
  const directive = directives[0]!;
  const allowed = DIRECTIVES[directive];
  if (!allowed) return issue(`"${directive}" isn't a directive (known: ${Object.keys(DIRECTIVES).join(", ")}; use $literal for a key that starts with $)`);
  const extra = keys.filter((k) => k !== directive && !allowed.includes(k));
  if (extra.length > 0) return issue(`${directive} doesn't take ${extra.map((k) => `"${k}"`).join(", ")}`);
  const argument = value[directive];
  const at = [...path, directive];
  const name = (kind: string, known: readonly string[]): string | undefined => {
    if (typeof argument === "string" && known.includes(argument)) return argument;
    issue(`${directive} needs the name of a ${kind} (known: ${known.length > 0 ? known.join(", ") : "none"})`, at);
    return undefined;
  };

  switch (directive) {
    case "$json":
      checkNode(argument, spec, at, depth + 1, state, false);
      return;
    case "$literal":
      checkLiteral(argument, at, depth + 1, state);
      return;
    case "$list": {
      const listName = name("list", spec.lists ?? []);
      if (listName) state.used.add(listName);
      return;
    }
    case "$join": {
      const listName = name("list", spec.lists ?? []);
      if (listName) state.used.add(listName);
      const separator = value.with;
      if (separator !== undefined && (typeof separator !== "string" || separator.length > MAX_JOIN_WITH || CONTROL.test(separator))) {
        issue(`"with" is a string of at most ${MAX_JOIN_WITH} characters`, [...path, "with"]);
      }
      return;
    }
    case "$each": {
      const rowsName = name("list of rows", Object.keys(spec.rows ?? {}));
      if (!Object.hasOwn(value, "item")) return issue('$each needs an "item"');
      if (!rowsName) return;
      state.used.add(rowsName);
      const rowSpec = spec.rows![rowsName]!;
      const rowState: CheckState = { ...state, used: new Set() };
      checkNode(value.item, rowSpec, [...path, "item"], depth + 1, rowState, false);
      state.nodes = rowState.nodes;
      state.tooBig = rowState.tooBig;
      for (const v of rowState.used) state.used.add(v);
      for (const required of rowSpec.required ?? []) {
        if (!rowState.used.has(required)) issue(`each row needs {${required}}`, [...path, "item"]);
      }
      return;
    }
    case "$if": {
      if (!isProperty) return issue("$if goes only directly under an object's key");
      const variable = name("variable", spec.scalars);
      if (variable) state.used.add(variable);
      if (!Object.hasOwn(value, "value")) return issue('$if needs a "value"');
      checkNode(value.value, spec, [...path, "value"], depth + 1, state, false);
      return;
    }
  }
}

/** Checks an argument template (its root an object of arguments) against the variables of its call. */
export function checkTemplate(template: unknown, spec: TemplateSpec): TemplateCheck {
  const state: CheckState = { issues: [], used: new Set(), nodes: 0, tooBig: false };
  if (!isPlainObject(template) || Object.keys(template).some((k) => k.startsWith("$"))) {
    state.issues.push({ path: [], message: "the arguments must be an object of argument names and values" });
    return { issues: state.issues, used: state.used };
  }
  checkNode(template, spec, [], 0, state, false);
  for (const required of spec.required ?? []) {
    if (state.used.has(required)) continue;
    const how = spec.scalars.includes(required) ? `{${required}}` : spec.lists?.includes(required) ? `${required} ($join or $list)` : `${required} ($each)`;
    state.issues.push({ path: [], message: `the arguments need ${how}` });
  }
  return { issues: state.issues, used: state.used };
}

// ---------------------------------------------------------------------------------------------------------------------
// Filling in

export type TemplateScalar = string | undefined;
export interface TemplateValues {
  readonly [name: string]: TemplateScalar | readonly string[] | readonly TemplateValues[];
}

/** A variable a placeholder needs is empty or missing: nothing is sent. */
export class TemplateValueError extends Error {
  constructor(readonly variable: string) {
    super(`The template needs ${variable}, which is empty.`);
    this.name = "TemplateValueError";
  }
}

function fillString(text: string, spec: TemplateSpec, values: TemplateValues): string {
  const parsed = parseString(text);
  if ("error" in parsed) throw new Error(`Unchecked template string: ${parsed.error}`);
  let out = "";
  for (const s of parsed.segments) {
    if ("text" in s) {
      out += s.text;
      continue;
    }
    const value = values[s.variable];
    if (typeof value === "string" && value !== "") out += value;
    else if ((value === undefined || value === "") && spec.mayBeEmpty?.includes(s.variable)) continue;
    else throw new TemplateValueError(s.variable);
  }
  return out;
}

function stringList(values: TemplateValues, name: string): readonly string[] {
  const value = values[name];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) throw new TemplateValueError(name);
  return value as readonly string[];
}

function fillNode(node: unknown, spec: TemplateSpec, values: TemplateValues): unknown {
  if (typeof node === "string") return fillString(node, spec, values);
  if (!isPlainObject(node)) return Array.isArray(node) ? node.map((item) => fillNode(item, spec, values)) : node;
  if (Object.hasOwn(node, "$literal")) return JSON.parse(JSON.stringify(node.$literal)) as unknown;
  if (Object.hasOwn(node, "$json")) return JSON.stringify(fillNode(node.$json, spec, values));
  if (Object.hasOwn(node, "$list")) return [...stringList(values, node.$list as string)];
  if (Object.hasOwn(node, "$join")) return stringList(values, node.$join as string).join(typeof node.with === "string" ? node.with : ",");
  if (Object.hasOwn(node, "$each")) {
    const name = node.$each as string;
    const rows = values[name];
    if (!Array.isArray(rows)) throw new TemplateValueError(name);
    return (rows as readonly TemplateValues[]).map((row) => fillNode(node.item, spec.rows![name]!, row));
  }
  const entries: Array<[string, unknown]> = [];
  for (const [key, child] of Object.entries(node)) {
    if (isPlainObject(child) && Object.hasOwn(child, "$if")) {
      const variable = values[child.$if as string];
      if (typeof variable !== "string" || variable === "") continue;
      entries.push([key, fillNode(child.value, spec, values)]);
    } else {
      entries.push([key, fillNode(child, spec, values)]);
    }
  }
  return Object.fromEntries(entries);
}

/** Fills in a checked argument template. Throws `TemplateValueError` when a needed variable is empty or missing. */
export function fillTemplate(template: unknown, spec: TemplateSpec, values: TemplateValues): JsonObject {
  return fillNode(template, spec, values) as JsonObject;
}

/** Fills in a checked text template; every placeholder's value must be given (it may be empty). */
export function fillText(text: string, values: Readonly<Record<string, string>>): string {
  const parsed = parseString(text);
  if ("error" in parsed) throw new Error(`Unchecked template text: ${parsed.error}`);
  return parsed.segments
    .map((s) => {
      if ("text" in s) return s.text;
      const value = values[s.variable];
      if (typeof value !== "string") throw new TemplateValueError(s.variable);
      return value;
    })
    .join("");
}
