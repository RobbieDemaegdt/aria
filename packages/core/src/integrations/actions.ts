/**
 * Phase 5A: Approved MCP writes, the exact-payload check, and Action-request cards (PLAN.md §0.3 D10, D16, D19, D22,
 * D30, D31, D33, D34; §0.4 #4, #5; §4.3; §4.13; §4.14; §5.4).
 *
 * - ARIA's own session stays read-only: it discovers `ask` tools with `list_action_tools` and proposes them with
 *   `request_action`, which only creates a pending `action_request` card in the chat.
 * - Nothing runs until your click on the card (`confirmAction`).
 * - The execution runs in a short-lived session with only `mcp:<wireName>` enabled and every other server disabled.
 * - `checkExactPayload` in the permission handler (and `onPreToolUse`) compares the call's arguments with the approved
 *   payload before the tool runs; any mismatch or second attempt aborts the session immediately.
 * - The outcome comes from `tool.execution_complete`, never from what the model writes afterwards.
 */
import { randomUUID } from "node:crypto";
import type { CardItem, ConductorSettings, ToolClass } from "@aria/protocol";
import { digestText } from "../github/text.ts";
import type { AgentRuntime, McpActionOutcome } from "../runtime/types.ts";
import { cleanText, cleanTitle } from "../tasks/pr.ts";
import { within } from "../tasks/manager.ts";
import type { TaskTracker } from "../trackers/types.ts";
import type { McpDirectClient } from "./mcp-client.ts";
import { duplicates, githubFixed, isSeen, untrusted, viewTools, type Catalog, type StoredRule, type ToolView } from "./rules.ts";
import { classifyTool, serverWirePrefix } from "./scope.ts";

export type ActionCard = Extract<CardItem, { cardType: "action_request" }>;

export const MAX_ACTION_ARGS = 20_000;
export const MAX_ACTION_RESULT = 20_000;
export const MAX_ACTION_DEPTH = 20;
const MAX_ACTION_TITLE = 160;
const MAX_ACTION_NOTE = 600;
const CONFIRM_KEY = /^confirm(?:ed)?$/i;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/** Control, bidi and invisible format characters (except \n, \r, \t) that could disguise what an action card shows. */
export const DISGUISE_CHARS = /[^\P{Cc}\n\r\t]|[\p{Cf}\p{Zl}\p{Zp}]/u;

/** The tracker's tool sets the action checks read: by tool name on every server, as before. */
export type ActionTracker = Pick<TaskTracker, "reservedTools" | "confirmTools">;

/**
 * The tracker's time-log write tools are reserved for Phase 5D's Timesheet card and Time view so plain-code checks
 * (times, rounding, overlaps, totals, duplicates, and task → project/customer lookup) always run first (PLAN.md §4.3,
 * §4.14).
 */
export const isReservedTimeLogTool = (tracker: ActionTracker, tool: string) => tracker.reservedTools.has(tool.trim().toLowerCase());

/**
 * Scans a syntactically valid JSON string for:
 * 1. duplicate object keys at the same object level, or `__proto__` / `constructor` / `prototype` keys (so V8's
 *    last-key-wins `JSON.parse` cannot hide a duplicate key that another MCP server runtime reads as first-key-wins);
 * 2. number literals that lose precision or change representation when parsed as an IEEE-754 double in JavaScript
 *    (such as `0.100000000000000005` rounding to `0.1`, `9007199254740993`, or `-0`), so a decimal-precise MCP server
 *    never receives a number different from what JavaScript compared.
 * Returns a description of the problem, or `undefined` when clean.
 */
export function checkJsonRawTokens(text: string): string | undefined {
  type Frame = { kind: "object"; keys: Set<string>; wantKey: boolean } | { kind: "array" };
  const stack: Frame[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === "{") {
      stack.push({ kind: "object", keys: new Set(), wantKey: true });
      i++;
      continue;
    }
    if (ch === "[") {
      stack.push({ kind: "array" });
      i++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      stack.pop();
      i++;
      continue;
    }
    if (ch === ",") {
      const top = stack.at(-1);
      if (top?.kind === "object") top.wantKey = true;
      i++;
      continue;
    }
    if (ch === ":") {
      i++;
      continue;
    }
    if (ch === '"') {
      let end = i + 1;
      while (end < n) {
        if (text[end] === "\\") {
          end += 2;
          continue;
        }
        if (text[end] === '"') break;
        end++;
      }
      const rawToken = text.slice(i, end + 1);
      i = end + 1;
      while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
      const top = stack.at(-1);
      if (top?.kind === "object" && top.wantKey && text[i] === ":") {
        let key: string;
        try {
          key = JSON.parse(rawToken) as string;
        } catch {
          return "contains an invalid object key";
        }
        if (FORBIDDEN_KEYS.has(key) || top.keys.has(key)) return `contains duplicate or forbidden object key "${key}"`;
        top.keys.add(key);
        top.wantKey = false;
      }
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let end = i + 1;
      while (end < n && /[0-9.eE+-]/.test(text[end]!)) end++;
      const rawNum = text.slice(i, end);
      const parsed = Number(rawNum);
      if (!Number.isFinite(parsed) || Object.is(parsed, -0) || String(parsed) !== rawNum) {
        return `contains a number literal (${rawNum}) that cannot be represented losslessly as a plain JSON number`;
      }
      if (Number.isInteger(parsed) && !Number.isSafeInteger(parsed)) {
        return `contains an integer (${rawNum}) outside the safe JSON range`;
      }
      i = end;
      continue;
    }
    i++;
  }
  return undefined;
}

export function hasDuplicateJsonKeys(text: string): boolean {
  const problem = checkJsonRawTokens(text);
  return problem !== undefined && problem.includes("duplicate or forbidden");
}

/** Checks that a value is plain JSON (no circular refs, BigInt, functions, undefined, unsafe integers, disguise chars, or forbidden keys) within `maxDepth`. */
function validatePlainJson(value: unknown, depth = 0, seen = new Set<object>()): string | undefined {
  if (depth > MAX_ACTION_DEPTH) return `nested deeper than ${MAX_ACTION_DEPTH} levels`;
  if (value === null || typeof value === "boolean") return undefined;
  if (typeof value === "string") {
    if (DISGUISE_CHARS.test(value)) return "contains invisible or control characters (such as bidi overrides)";
    return undefined;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "contains a non-finite number";
    if (Object.is(value, -0)) return "contains -0";
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) return "contains an integer outside the safe JSON range (pass large IDs as strings)";
    return undefined;
  }
  if (typeof value !== "object") return `contains a non-JSON value (${typeof value})`;
  if (seen.has(value)) return "contains a circular reference";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) {
        const problem = validatePlainJson(item, depth + 1, seen);
        if (problem) return problem;
      }
      return undefined;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return "contains a non-plain object";
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) return `contains a forbidden property name (${key})`;
      if (DISGUISE_CHARS.test(key)) return "contains invisible or control characters in a property name";
      const problem = validatePlainJson((value as Record<string, unknown>)[key], depth + 1, seen);
      if (problem) return problem;
    }
    return undefined;
  } finally {
    seen.delete(value);
  }
}

/** Deep equality on validated plain JSON values (object key order ignored; numbers compared with `===`; strings with `===`). */
export function sameCanonicalJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameCanonicalJson(item, b[i]));
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length || !aKeys.every((k, i) => k === bKeys[i])) return false;
  return aKeys.every((k) => sameCanonicalJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export interface ExactPayloadCheck {
  ok: boolean;
  reason: string;
}

/**
 * ARIA's exact-payload check (PLAN.md §4.13, D10, spike 04): the tool call in the short-lived session must carry
 * exactly the approved arguments, nothing more and nothing less. Top-level keys ending in `Json` (such as a tracker's
 * `tasksJson` or `entriesJson`) are parsed as JSON and compared semantically (key order and whitespace inside the JSON
 * string may vary, every value and string inside must match, and duplicate keys are rejected); all other strings must
 * match character-for-character (`===`).
 */
export function checkExactPayload(actualArgs: unknown, approvedArgs: Record<string, unknown>): ExactPayloadCheck {
  const fail = (reason: string): ExactPayloadCheck => ({ ok: false, reason });
  if (actualArgs === undefined || actualArgs === null) return fail("the request carries no arguments");
  if (typeof actualArgs !== "object" || Array.isArray(actualArgs)) return fail("arguments are not a plain JSON object");
  const problem = validatePlainJson(actualArgs);
  if (problem) return fail(`arguments ${problem}`);
  let serialized: string;
  try {
    serialized = JSON.stringify(actualArgs);
  } catch {
    return fail("arguments cannot be serialized as JSON");
  }
  if (serialized.length > MAX_ACTION_ARGS) return fail(`arguments are ${serialized.length.toLocaleString("en-US")} characters (max ${MAX_ACTION_ARGS.toLocaleString("en-US")})`);

  const actualObj = actualArgs as Record<string, unknown>;
  const actualKeys = Object.keys(actualObj).sort();
  const approvedKeys = Object.keys(approvedArgs).sort();
  if (actualKeys.length !== approvedKeys.length || !actualKeys.every((k, i) => k === approvedKeys[i])) {
    return fail(`unexpected argument keys: got [${actualKeys.join(", ")}], approved [${approvedKeys.join(", ")}]`);
  }

  for (const key of approvedKeys) {
    const expected = approvedArgs[key];
    const actual = actualObj[key];
    if (/json$/i.test(key) && typeof expected === "string") {
      if (typeof actual !== "string") return fail(`${key} is not a string`);
      let parsedExpected: unknown;
      let parsedActual: unknown;
      try {
        parsedExpected = JSON.parse(expected);
        parsedActual = JSON.parse(actual);
      } catch {
        return fail(`${key} is not valid JSON`);
      }
      const tokenProblem = checkJsonRawTokens(actual) ?? checkJsonRawTokens(expected);
      if (tokenProblem) return fail(`${key} ${tokenProblem}`);
      const innerProblem = validatePlainJson(parsedActual);
      if (innerProblem) return fail(`${key} ${innerProblem}`);
      if (!sameCanonicalJson(parsedActual, parsedExpected)) return fail(`${key} does not match the approved JSON payload`);
      continue;
    }
    if (!sameCanonicalJson(actual, expected)) return fail(`argument "${key}" differs from the approved payload`);
  }
  return { ok: true, reason: "matches the approved payload" };
}

/** Finds the confirmation boolean property name for a tool (`confirm` / `Confirm`), if it uses one. */
export function confirmPropertyName(tracker: ActionTracker, tool: string, inputSchema?: Record<string, unknown>): string | undefined {
  const props = inputSchema?.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    const hit = Object.keys(props as Record<string, unknown>).find((k) => CONFIRM_KEY.test(k));
    if (hit) return hit;
  }
  // Known destructive tools that require `confirm: true` on the wire even when their schema wasn't loaded yet.
  return tracker.confirmTools.has(tool.trim().toLowerCase()) ? "confirm" : undefined;
}

/** Whether a tool card needs the explicit destructive confirmation checkbox before Send is enabled. */
export function needsConfirmTick(tracker: ActionTracker, cls: ToolClass, tool: string, inputSchema?: Record<string, unknown>): boolean {
  return cls === "destructive" || confirmPropertyName(tracker, tool, inputSchema) !== undefined;
}

/**
 * Validates and normalizes action arguments from `request_action` (`fromModel: true`) or from user edits on the card
 * (`fromModel: false`).
 * - Never allows the model to pass `confirm: true` (§0.4 #5).
 * - Strips any `confirm` / `confirmed` flag from the stored card JSON so only the user's confirmation checkbox sets it
 *   when the action runs.
 */
export function validateActionArgs(
  rawArgs: unknown,
  options: { fromModel: boolean; inputSchema?: Record<string, unknown> },
): { args: Record<string, unknown>; argsJson: string } {
  if (rawArgs === undefined || rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    throw new Error("The action's arguments must be a plain JSON object.");
  }
  const problem = validatePlainJson(rawArgs);
  if (problem) throw new Error(`The action's arguments can't be used: ${problem}.`);

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawArgs as Record<string, unknown>)) {
    if ( value === undefined ) continue;
    if (CONFIRM_KEY.test(key)) {
      if (options.fromModel && value !== false && value !== null) {
        throw new Error("Never set confirm=true yourself (PLAN.md §0.4): leave confirm out, and the user's confirmation tick on the card will set it.");
      }
      // Stripped from the card's stored args: the checkbox on the card controls confirmation at execution time.
      continue;
    }
    if (/json$/i.test(key) && typeof value === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error(`The "${key}" argument must be a valid JSON string.`);
      }
      const tokenProblem = checkJsonRawTokens(value);
      if (tokenProblem) throw new Error(`The "${key}" argument ${tokenProblem}.`);
      const innerProblem = validatePlainJson(parsed);
      if (innerProblem) throw new Error(`Inside "${key}": ${innerProblem}.`);
    }
    cleaned[key] = value;
  }

  const schema = options.inputSchema;
  if (schema) {
    const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : [];
    for (const req of required) {
      if (CONFIRM_KEY.test(req)) continue;
      if (!Object.hasOwn(cleaned, req)) throw new Error(`Missing required argument "${req}".`);
    }
    const props = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) ? (schema.properties as Record<string, unknown>) : undefined;
    if (props && Object.keys(props).length > 0 && schema.additionalProperties === false) {
      const unknown = Object.keys(cleaned).filter((k) => !Object.hasOwn(props, k));
      if (unknown.length > 0) throw new Error(`Unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
    }
  }

  const argsJson = JSON.stringify(cleaned, null, 2);
  if (argsJson.length > MAX_ACTION_ARGS) {
    throw new Error(`The arguments are ${argsJson.length.toLocaleString("en-US")} characters, more than the ${MAX_ACTION_ARGS.toLocaleString("en-US")} a card can show: send less in one call.`);
  }
  return { args: cleaned, argsJson };
}

/**
 * Checks whether a tool in the catalog can be proposed or confirmed as an ARIA action (Phase 5A, D19, D22, D31, D34).
 * `allowTimeLogTools` is false for `request_action` and action cards, and true only for Phase 5D's Timesheet runner.
 */
export function checkActionTool(
  tracker: ActionTracker,
  catalog: Catalog,
  storedRules: readonly StoredRule[],
  server: string,
  toolOrWire: string,
  options: { mode: "propose" | "confirm"; allowTimeLogTools?: boolean },
): ToolView {
  const srv = server.trim();
  const target = toolOrWire.trim();
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\ufffd]/u.test(srv) || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\ufffd]/u.test(target)) {
    throw new Error("Tool and server names cannot contain control or invisible characters.");
  }
  const serverEntry = catalog.servers.find((s) => s.name === srv);
  if (!serverEntry || !isSeen(catalog, serverEntry)) {
    throw new Error(`The MCP server "${srv}" isn't in your current Copilot CLI setup.`);
  }
  const dupes = duplicates(catalog);
  if (dupes.has(srv)) {
    throw new Error(`"${srv}" is a duplicate of "${dupes.get(srv)}": use "${dupes.get(srv)}" instead.`);
  }
  const prefix = serverWirePrefix(srv);
  const views = viewTools(catalog, storedRules);
  const view = views.find((v) => v.entry.server === srv && (v.entry.tool === target || v.entry.wireName === target || `${prefix}${v.entry.tool}` === target));
  if (!view || !view.seen || view.entry.wireName !== `${prefix}${view.entry.tool}`) {
    throw new Error(`"${target}" isn't an available tool of "${srv}". Use list_action_tools to see the tools you can propose.`);
  }
  const cls = classifyTool(view.entry.tool);
  if (cls === "unrestricted" || view.cls === "unrestricted") {
    throw new Error(`Generic API write tools (${view.entry.tool}) are never allowed in ARIA.`);
  }
  if (view.fixed || githubFixed(view.entry.tool, cls, view.github)) {
    throw new Error(`${view.entry.wireName} merges pull requests or writes branches, files, commits or refs on GitHub, which ARIA never runs through MCP tools (D31): use background tasks and Open PR instead.`);
  }
  if (!options.allowTimeLogTools && isReservedTimeLogTool(tracker, view.entry.tool)) {
    throw new Error(`${view.entry.wireName} is reserved for the Timesheet card and Time view so plain-code checks always run first (PLAN.md §4.14).`);
  }
  const effect = view.rules.aria.effect;
  if (effect === "never") {
    throw new Error(`The user turned ${view.entry.wireName} off for ARIA in Customize › Integrations.`);
  }
  if (options.mode === "propose" && effect === "auto") {
    throw new Error(`${view.entry.wireName} is set to Auto for ARIA: call the tool directly instead of proposing an action card.`);
  }
  if (options.mode === "confirm" && cls !== "read" && effect !== "ask") {
    throw new Error(`${view.entry.wireName} isn't allowed for ARIA.`);
  }
  return view;
}

export interface ActionToolSummary {
  server: string;
  tool: string;
  wireName: string;
  cls: ToolClass;
  requiresConfirmTick: boolean;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Lists all tools in the current catalog that ARIA can propose with `request_action`. */
export function listActionTools(
  tracker: ActionTracker,
  catalog: Catalog,
  storedRules: readonly StoredRule[],
  filter?: { server?: string; query?: string },
): ActionToolSummary[] {
  const dupes = duplicates(catalog);
  const serverFilter = filter?.server?.trim().toLowerCase();
  const q = filter?.query?.trim().toLowerCase();
  return viewTools(catalog, storedRules)
    .filter((v) => {
      if (!v.seen || dupes.has(v.entry.server)) return false;
      const cls = classifyTool(v.entry.tool);
      if (cls === "unrestricted" || v.cls === "unrestricted") return false;
      if (v.fixed || githubFixed(v.entry.tool, cls, v.github)) return false;
      if (isReservedTimeLogTool(tracker, v.entry.tool)) return false;
      if (v.rules.aria.effect !== "ask") return false;
      if (serverFilter && v.entry.server.toLowerCase() !== serverFilter) return false;
      if (q && !v.entry.tool.toLowerCase().includes(q) && !v.entry.server.toLowerCase().includes(q) && !(v.entry.description?.toLowerCase().includes(q) ?? false)) return false;
      return true;
    })
    .map((v) => ({
      server: v.entry.server,
      tool: v.entry.tool,
      wireName: v.entry.wireName,
      cls: v.cls,
      requiresConfirmTick: needsConfirmTick(tracker, v.cls, v.entry.tool, v.entry.inputSchema),
      ...(v.entry.description ? { description: untrusted(v.entry.description) } : {}),
      ...(v.entry.inputSchema ? { inputSchema: v.entry.inputSchema } : {}),
    }));
}

export function cleanActionText(text: string, max = MAX_ACTION_RESULT): string {
  const cleaned = cleanText(text).trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export interface ActionRunnerDeps {
  /** The tool sets the checks read: a tracker's own, or (the engine) the union over every config in the trackers folder. */
  tracker(): ActionTracker;
  mcpClient?: McpDirectClient;
  allowModelActionFallback?: boolean;
  runtime?: AgentRuntime;
  catalog(): Catalog;
  rules(): readonly StoredRule[];
  conductorSettings?(): ConductorSettings;
  runtimeReady(): boolean;
  helperId?(): string;
  helperDone?(id: string): void;
  card(cardId: string): CardItem | undefined;
  cards(): ActionCard[];
  saveCard(card: ActionCard): void;
  digest(line: string): void;
  shutdownWaitMs?: number;
}

export class ActionRunner {
  private nextNumber = 1;
  private stopped = false;
  private readonly inFlight = new Map<string, { abort: AbortController; done: Promise<void> }>();

  constructor(private readonly deps: ActionRunnerDeps) {}

  /**
   * Startup recovery: any action card that was `"running"` when ARIA closed is marked `"failed"` so the user can
   * check whether it went through before retrying, and `nextNumber` continues past existing `A-n` cards.
   */
  markInterrupted(): void {
    let highest = 0;
    for (const card of this.deps.cards()) {
      const m = /^A-(\d+)$/.exec(card.payload.shortId);
      if (m) highest = Math.max(highest, Number(m[1]));
      if (card.payload.status === "running") {
        this.deps.saveCard({
          ...card,
          payload: {
            ...card.payload,
            status: "failed",
            revision: card.payload.revision + 1,
            error: "ARIA closed while this action was running. Check whether it went through before trying again.",
          },
          updatedAt: Date.now(),
        });
      }
    }
    this.nextNumber = highest + 1;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const running = [...this.inFlight.values()];
    for (const item of running) item.abort.abort();
    if (running.length > 0) {
      await within(this.deps.shutdownWaitMs ?? 5_000, () => Promise.all(running.map((r) => r.done)));
    }
  }

  listTools(filter?: { server?: string; query?: string }): ActionToolSummary[] {
    return listActionTools(this.deps.tracker(), this.deps.catalog(), this.deps.rules(), filter);
  }

  /** Pending action cards (`status === "pending"`), for `<pending>` in the Conductor's digest. */
  pendingItems(): Array<{ shortId: string; cardId: string; server: string; tool: string; title: string }> {
    return this.deps
      .cards()
      .filter((c) => c.payload.status === "pending")
      .map((c) => ({
        shortId: c.payload.shortId,
        cardId: c.id,
        server: c.payload.server,
        tool: c.payload.tool,
        title: c.payload.title,
      }));
  }

  /** Proposes an MCP action on a card in the chat (`request_action`). Never executes the tool. */
  propose(input: { server: string; tool: string; title: string; args: Record<string, unknown>; note?: string }): ActionCard {
    const view = checkActionTool(this.deps.tracker(), this.deps.catalog(), this.deps.rules(), input.server, input.tool, { mode: "propose" });
    const title = cleanTitle(input.title, MAX_ACTION_TITLE).trim();
    if (!title) throw new Error("Give a short title for the action card.");
    const note = input.note !== undefined ? cleanText(input.note).trim().slice(0, MAX_ACTION_NOTE) : undefined;
    const { argsJson } = validateActionArgs(input.args, { fromModel: true, ...(view.entry.inputSchema ? { inputSchema: view.entry.inputSchema } : {}) });
    const requiresConfirmTick = needsConfirmTick(this.deps.tracker(), view.cls, view.entry.tool, view.entry.inputSchema);
    const shortId = `A-${this.nextNumber++}`;
    const card: ActionCard = {
      kind: "card",
      id: `action-${randomUUID()}`,
      cardType: "action_request",
      payload: {
        shortId,
        server: view.entry.server,
        tool: view.entry.tool,
        wireName: view.entry.wireName,
        cls: view.cls,
        title,
        ...(note ? { note } : {}),
        argsJson,
        ...(requiresConfirmTick ? { requiresConfirmTick: true } : {}),
        status: "pending",
        revision: 1,
      },
      createdAt: Date.now(),
    };
    this.deps.saveCard(card);
    return card;
  }

  /**
   * Executes one approved MCP tool call in a short-lived session with the exact-payload check. Shared by Action-request
   * cards (Phase 5A) and Timesheet Submit / Update / Delete (Phase 5D).
   */
  async executeApprovedMcpCall(input: {
    server: string;
    tool: string;
    args: Record<string, unknown>;
    confirmedDestructive?: boolean;
    allowTimeLogTools?: boolean;
    signal?: AbortSignal;
  }): Promise<{ approvedArgs: Record<string, unknown>; outcome: McpActionOutcome }> {
    if (this.stopped || !this.deps.runtimeReady()) throw new Error("ARIA's runtime isn't ready right now.");
    const catalog = this.deps.catalog();
    const view = checkActionTool(this.deps.tracker(), catalog, this.deps.rules(), input.server, input.tool, {
      mode: "confirm",
      ...(input.allowTimeLogTools ? { allowTimeLogTools: true } : {}),
    });
    const serverEntry = catalog.servers.find((s) => s.name === view.entry.server);
    if (serverEntry?.status === "needs-auth") {
      throw new Error(`${view.entry.server} needs signing in first (Customize › Integrations).`);
    }
    if (serverEntry?.status === "disabled") {
      throw new Error(`${view.entry.server} is disabled in Customize › Integrations.`);
    }
    const requiresTick = needsConfirmTick(this.deps.tracker(), view.cls, view.entry.tool, view.entry.inputSchema);
    if (requiresTick && input.confirmedDestructive !== true) {
      throw new Error("Tick the confirmation box first to confirm this destructive action.");
    }
    const { args: validated } = validateActionArgs(input.args, {
      fromModel: false,
      ...(view.entry.inputSchema ? { inputSchema: view.entry.inputSchema } : {}),
    });
    const confirmProp = confirmPropertyName(this.deps.tracker(), view.entry.tool, view.entry.inputSchema);
    const approvedArgs: Record<string, unknown> = confirmProp && input.confirmedDestructive === true ? { ...validated, [confirmProp]: true } : validated;

    // Phase 7A: Zero-model execution via built-in NativeMcpClient when direct transport / credentials are available.
    const useDirectClient =
      this.deps.mcpClient !== undefined &&
      this.deps.mcpClient.canCallDirectly?.(view.entry.server) === true;

    if (useDirectClient && this.deps.mcpClient) {
      const outcome = await this.deps.mcpClient.callTool({
        server: view.entry.server,
        tool: view.entry.tool,
        wireName: view.entry.wireName,
        approvedArgs,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return { approvedArgs, outcome };
    }

    if (!this.deps.runtime) {
      throw new Error(
        `${view.entry.server} needs a bearer token in Customize › Integrations to execute writes directly without a model.`,
      );
    }
    const settings = this.deps.conductorSettings?.() ?? {};
    if (!settings.model) throw new Error("No model is configured for ARIA.");
    const disabledMcpServers = catalog.servers
      .filter((s) => isSeen(catalog, s) && s.name !== view.entry.server)
      .map((s) => s.name);

    const sessionId = this.deps.helperId?.() ?? `aria-action-${randomUUID()}`;
    try {
      const outcome = await this.deps.runtime.runMcpAction({
        sessionId,
        model: settings.model,
        ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
        server: view.entry.server,
        tool: view.entry.tool,
        wireName: view.entry.wireName,
        github: view.github,
        disabledMcpServers,
        approvedArgs,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return { approvedArgs, outcome };
    } finally {
      this.deps.helperDone?.(sessionId);
    }
  }

  /** Your click on Send / Run on an `action_request` card. */
  async confirm(input: { cardId: string; revision: number; argsJson?: string; confirmedDestructive?: boolean }): Promise<void> {
    if (this.stopped || !this.deps.runtimeReady()) throw new Error("ARIA's runtime isn't ready right now.");
    const item = this.deps.card(input.cardId);
    if (!item || item.kind !== "card" || item.cardType !== "action_request") throw new Error("That action card doesn't exist anymore.");
    const card = item as ActionCard;
    if (card.payload.status === "running" || this.inFlight.has(card.id)) throw new Error("That action is already running.");
    if (card.payload.status === "done") throw new Error("That action has already been run.");
    if (card.payload.status === "cancelled") throw new Error("That action was cancelled.");
    if (card.payload.revision !== input.revision) throw new Error("That card changed since you looked at it. Check the arguments and try again.");

    const catalog = this.deps.catalog();
    const view = checkActionTool(this.deps.tracker(), catalog, this.deps.rules(), card.payload.server, card.payload.wireName, { mode: "confirm" });
    const serverEntry = catalog.servers.find((s) => s.name === view.entry.server);
    if (serverEntry?.status === "needs-auth") {
      throw new Error(`${view.entry.server} needs signing in first (Customize › Integrations).`);
    }
    if (serverEntry?.status === "disabled") {
      throw new Error(`${view.entry.server} is disabled in Customize › Integrations.`);
    }

    const requiresTick = card.payload.requiresConfirmTick === true || needsConfirmTick(this.deps.tracker(), view.cls, view.entry.tool, view.entry.inputSchema);
    if (requiresTick && input.confirmedDestructive !== true) {
      throw new Error("Tick the confirmation box first to confirm this action.");
    }

    const rawJson = input.argsJson !== undefined ? input.argsJson : card.payload.argsJson;
    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(rawJson);
    } catch {
      throw new Error("The arguments aren't valid JSON.");
    }
    const rawTokenProblem = checkJsonRawTokens(rawJson);
    if (rawTokenProblem) {
      throw new Error(`The arguments can't be used: ${rawTokenProblem}.`);
    }
    const { args: validated, argsJson: normalizedJson } = validateActionArgs(parsedArgs, {
      fromModel: false,
      ...(view.entry.inputSchema ? { inputSchema: view.entry.inputSchema } : {}),
    });
    const edited = card.payload.edited === true || normalizedJson !== card.payload.argsJson;
    const confirmProp = confirmPropertyName(this.deps.tracker(), view.entry.tool, view.entry.inputSchema);
    const shownArgs = confirmProp && input.confirmedDestructive === true ? { ...validated, [confirmProp]: true } : validated;
    const shownJson = JSON.stringify(shownArgs, null, 2);

    // Flip synchronously to "running" before any await so a double click is refused.
    const runningCard: ActionCard = {
      ...card,
      payload: {
        ...card.payload,
        argsJson: shownJson,
        ...(edited ? { edited: true } : {}),
        ...(requiresTick ? { requiresConfirmTick: true } : {}),
        status: "running",
        revision: card.payload.revision + 1,
      },
      updatedAt: Date.now(),
    };
    delete runningCard.payload.error;
    this.deps.saveCard(runningCard);

    const abort = new AbortController();
    const run = (async () => {
      try {
        const { outcome } = await this.executeApprovedMcpCall({
          server: view.entry.server,
          tool: view.entry.tool,
          args: validated,
          ...(input.confirmedDestructive !== undefined ? { confirmedDestructive: input.confirmedDestructive } : {}),
          signal: abort.signal,
        });
        if (this.stopped) return;
        const now = Date.now();
        if (outcome.ok) {
          const result = cleanActionText(outcome.result);
          this.deps.saveCard({
            ...runningCard,
            payload: {
              ...runningCard.payload,
              status: "done",
              revision: runningCard.payload.revision + 1,
              result,
              completedAt: now,
            },
            updatedAt: now,
          });
          this.deps.digest(
            `[action] You ran ${card.payload.shortId} (${card.payload.server} · ${card.payload.tool}: ${digestText(card.payload.title, 80)})${edited ? " with your edits" : ""}: succeeded.`,
          );
        } else {
          const error = cleanActionText(outcome.error);
          this.deps.saveCard({
            ...runningCard,
            payload: {
              ...runningCard.payload,
              // Restore the editable JSON without the injected confirm flag so Try again / Edit starts cleanly.
              argsJson: normalizedJson,
              status: "failed",
              revision: runningCard.payload.revision + 1,
              error,
            },
            updatedAt: now,
          });
          this.deps.digest(
            `[action] ${card.payload.shortId} (${card.payload.server} · ${card.payload.tool}: ${digestText(card.payload.title, 80)}) failed: ${digestText(error, 140)}`,
          );
        }
      } catch (error) {
        if (this.stopped) return;
        const errText = cleanActionText(error instanceof Error ? error.message : String(error), 1_000);
        this.deps.saveCard({
          ...runningCard,
          payload: {
            ...runningCard.payload,
            argsJson: normalizedJson,
            status: "failed",
            revision: runningCard.payload.revision + 1,
            error: errText,
          },
          updatedAt: Date.now(),
        });
        this.deps.digest(
          `[action] ${card.payload.shortId} (${card.payload.server} · ${card.payload.tool}: ${digestText(card.payload.title, 80)}) failed: ${digestText(errText, 140)}`,
        );
      }
    })();

    this.inFlight.set(card.id, { abort, done: run });
    try {
      await run;
    } finally {
      this.inFlight.delete(card.id);
    }
  }

  /** Cancels a pending or failed action card (from your click or ARIA's `cancel_action`). */
  cancel(ref: string, by: "you" | "aria"): ActionCard {
    const query = ref.trim();
    const card =
      this.deps.cards().find((c) => c.id === query || c.payload.shortId.toLowerCase() === query.toLowerCase()) ??
      (() => {
        const item = this.deps.card(query);
        return item?.kind === "card" && item.cardType === "action_request" ? (item as ActionCard) : undefined;
      })();
    if (!card) throw new Error(`There's no action card "${query}".`);
    if (card.payload.status === "running" || this.inFlight.has(card.id)) throw new Error("That action is currently running and can't be cancelled.");
    if (card.payload.status === "done") throw new Error("That action has already been run.");
    if (card.payload.status === "cancelled") return card;
    const next: ActionCard = {
      ...card,
      payload: { ...card.payload, status: "cancelled", revision: card.payload.revision + 1 },
      updatedAt: Date.now(),
    };
    this.deps.saveCard(next);
    if (by === "you") {
      this.deps.digest(`[action] You cancelled ${card.payload.shortId} (${card.payload.server} · ${card.payload.tool}: ${digestText(card.payload.title, 80)}).`);
    }
    return next;
  }
}
