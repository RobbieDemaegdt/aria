/**
 * Loading tracker configs (docs/trackers.md, "Setting one up" and "What the loader refuses"): the fictional Acme preset, the hash, errors
 * as `path: message` lines, the trackers folder's listing, and `choice.config` checked before it becomes a path.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { classifyTool } from "../src/integrations/scope.ts";
import {
  canonicalJson,
  configHash,
  listTrackerConfigs,
  loadTrackerConfig,
  MAX_CONFIG_BYTES,
  MAX_ERROR_LINE_CHARS,
  MAX_ERROR_LINES,
  parseTrackerConfig,
} from "../src/trackers/config/load.ts";
import { buildTaskRefRegexes } from "../src/trackers/config/patterns.ts";
import { configPatterns, configUrlPatterns, derivedRoutes, type TrackerConfig } from "../src/trackers/config/schema.ts";

const ACME_TEXT = readFileSync(fileURLToPath(new URL("./fixtures/trackers/acme.json", import.meta.url)), "utf8");
const acme = (): Record<string, any> => JSON.parse(ACME_TEXT);

function loaded(text: string, id?: string): TrackerConfig {
  const result = parseTrackerConfig(text, id);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.config;
}

const errorsOf = (value: unknown) => {
  const result = parseTrackerConfig(typeof value === "string" ? value : JSON.stringify(value));
  return result.ok ? [] : result.errors;
};

const dirs: string[] = [];
function dataDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aria-trackers-test-"));
  dirs.push(dir);
  if (Object.keys(files).length > 0) mkdirSync(path.join(dir, "trackers"));
  for (const [name, text] of Object.entries(files)) {
    if (name.endsWith("/")) mkdirSync(path.join(dir, "trackers", name));
    else writeFileSync(path.join(dir, "trackers", name), text, "utf8");
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Whether this machine lets the tests make links (on Windows only with developer mode or an administrator). */
function canLink(): boolean {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aria-trackers-link-"));
  try {
    writeFileSync(path.join(dir, "file"), "x", "utf8");
    symlinkSync(path.join(dir, "file"), path.join(dir, "link"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const LINKS = canLink();

describe("the Acme preset", () => {
  it("loads, with its defaults", () => {
    const config = loaded(ACME_TEXT, "acme");
    expect(config.id).toBe("acme");
    expect(config.label).toBe("Acme Tracker");
    expect(config.servers).toEqual({ match: ["acme"], prefer: [], fallback: "Acme" });
    expect(config.taskRef).toMatchObject({ keywords: [], bare: true, caseInsensitive: true, normalize: "upper" });
    expect(config.tools.rawCompanions).toEqual({});
    expect(config.tasks.emptyText).toEqual([]);
    expect(config.timeLogs?.requiresProjectCustomer).toBe(false);
    expect(config.timekeeper.routes).toEqual([]);
    expect(config.messages).toEqual({});
    expect(config.projects).toBeUndefined();
  });

  it("has read tools ARIA may call without asking, and reserved write tools", () => {
    const config = loaded(ACME_TEXT);
    const reads = [...config.tasks.myTasks, ...config.tasks.byId!.tools, ...config.timeLogs!.byRange.tools, config.tools.testConnection!];
    expect(reads.map((tool) => [tool, classifyTool(tool)])).toEqual(reads.map((tool) => [tool, "read"]));
    const writes = [config.timeLogs!.create.tool, config.timeLogs!.update.tool, config.timeLogs!.delete.tool];
    expect(writes.map(classifyTool)).toEqual(["write", "write", "destructive"]);
    expect(new Set(config.tools.reserved)).toEqual(new Set(writes));
    expect(config.tools.confirm).toEqual(["delete_worklogs"]);
  });

  it("routes by its own tool names", () => {
    expect(derivedRoutes(loaded(ACME_TEXT))).toEqual([
      { handler: "tasks", equals: ["list_my_issues", "get_issues"] },
      { handler: "timeLogs", mode: "dateRange", equals: ["list_worklogs"] },
    ]);
  });

  it("builds reference regexes that find its keys and links", () => {
    const config = loaded(ACME_TEXT);
    const patterns = configPatterns(config);
    const regexes = buildTaskRefRegexes({
      id: patterns.ref,
      idInText: patterns.refInText,
      prefixes: config.taskRef.prefixes,
      keywords: config.taskRef.keywords,
      bare: config.taskRef.bare,
      urls: configUrlPatterns(config),
      caseInsensitive: config.taskRef.caseInsensitive,
    });
    expect(regexes.directId.exec("issue acme-42")?.[1]).toBe("acme-42");
    expect(regexes.urlExact?.exec("https://acme.example/browse/ACME-7?focus=1")?.slice(1).find(Boolean)).toBe("ACME-7");
    expect([..."see ACME-12 and acme-3, not XACME-4".matchAll(regexes.bare!)].map((m) => m[1])).toEqual(["ACME-12", "acme-3"]);
    expect(regexes.branchSegment.exec("ACME-99-fix-login")?.[1]).toBe("ACME-99");
    expect(regexes.keywordInText).toBeUndefined();
  });
});

describe("the hash", () => {
  it("is the first 8 hex digits of SHA-256 of the canonical JSON", () => {
    expect(configHash(ACME_TEXT)).toMatch(/^[0-9a-f]{8}$/);
    expect(configHash('{"a":1}')).toBe("015abd7f");
    expect(parseTrackerConfig(ACME_TEXT)).toMatchObject({ ok: true, hash: configHash(ACME_TEXT) });
  });

  it("doesn't change with whitespace, line endings or a byte-order mark", () => {
    const hash = configHash(ACME_TEXT);
    const lf = ACME_TEXT.replace(/\r\n/g, "\n");
    expect(configHash(lf)).toBe(hash);
    expect(configHash(lf.replace(/\n/g, "\r\n"))).toBe(hash);
    expect(configHash(JSON.stringify(JSON.parse(ACME_TEXT)))).toBe(hash);
    expect(configHash(JSON.stringify(JSON.parse(ACME_TEXT), null, 4))).toBe(hash);
    expect(configHash(`\uFEFF${ACME_TEXT}`)).toBe(hash);
    expect(parseTrackerConfig(`\uFEFF${ACME_TEXT}`)).toMatchObject({ ok: true, hash });
    expect(canonicalJson(' { "b" : [ 1 , 2 ] ,\r\n "a" : "x" } ')).toBe('{"b":[1,2],"a":"x"}');
  });

  it("changes with any value or with key order, which is the order of the arguments sent", () => {
    const hash = configHash(ACME_TEXT);
    const changed = acme();
    changed.label = "Acme Tracker 2";
    expect(configHash(JSON.stringify(changed))).not.toBe(hash);
    const reordered = acme();
    const { started, ended, ...rest } = reordered.timeLogs.update.args;
    reordered.timeLogs.update.args = { ended, started, ...rest };
    expect(configHash(JSON.stringify(reordered))).not.toBe(hash);
  });
});

describe("errors", () => {
  it.each([
    ["not JSON", "{ nope", /^the file isn't valid JSON: /],
    ["not an object", "[]", /^the config: should be an object$/],
    ["a later schema", { ...acme(), schema: 2 }, /^schema: should be 1$/],
    ["an unknown key", { ...acme(), lable: "x" }, /^the config: unknown key "lable"$/],
    ["a missing key", { ...acme(), label: undefined }, /^label: is missing$/],
    ["an empty label", { ...acme(), label: " \u0000 " }, /^label: is empty$/],
    ["a long label", { ...acme(), label: "x".repeat(41) }, /^label: has more than 40 characters$/],
    ["a short server match", { ...acme(), servers: { match: ["ac"] } }, /^servers\.match\[0\]: needs at least 3 characters$/],
    ["a wrong type", { ...acme(), taskRef: { ...acme().taskRef, bare: "yes" } }, /^taskRef\.bare: should be a boolean$/],
    ["a bad enum", { ...acme(), taskRef: { ...acme().taskRef, normalize: "title" } }, /^taskRef\.normalize: should be one of "none", "upper", "lower"$/],
    ["no tools", { ...acme(), tasks: { ...acme().tasks, myTasks: [] } }, /^tasks\.myTasks: needs at least 1 item$/],
    ["a bad ID pattern", { ...acme(), ids: { task: "(a|b)" } }, /^ids\.task: the ID pattern /],
    ["a bad tool name", { ...acme(), tools: { ...acme().tools, testConnection: "get user" } }, /^tools\.testConnection: isn't a tool name/],
    ["a bad record key", { ...acme(), tools: { ...acme().tools, rawCompanions: { "get issues": "get_issues" } } }, /^tools\.rawCompanions\.get issues: has a key that isn't allowed: isn't a tool name/],
    ["too many record entries", { ...acme(), knownIds: { customers: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`c${i}`, `${i + 1}`])) } }, /^knownIds\.customers: has more than 50 entries$/],
    ["a bad template", { ...acme(), timeLogs: { ...acme().timeLogs, delete: { tool: "delete_worklogs", args: { ids: "{ids}" } } } }, /^timeLogs\.delete\.args\.ids: /],
    ["a write tool that isn't reserved", { ...acme(), tools: { ...acme().tools, reserved: ["add_worklogs", "update_worklog"] } }, /^tools\.reserved: delete_worklogs \(timeLogs\.delete\.tool\) must be in tools\.reserved/],
    ["a write tool as a read", { ...acme(), tasks: { ...acme().tasks, myTasks: ["assign_issue"] } }, /^tasks\.myTasks\[0\]: assign_issue isn't named like a read tool/],
  ])("%s", (_name, value, line) => {
    const errors = errorsOf(value);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(line);
  });

  it("gives at most 10 lines, the last saying how many more there are", () => {
    const many = { ...acme(), taskRef: { ...acme().taskRef, prefixes: Array.from({ length: 14 }, () => "") } };
    const errors = errorsOf(many);
    expect(errors).toHaveLength(MAX_ERROR_LINES);
    expect(errors.slice(0, 9)).toEqual(Array.from({ length: 9 }, (_, i) => `taskRef.prefixes[${i}]: is empty`));
    expect(errors[9]).toBe("… and 5 more");
    const exactly = { ...acme(), taskRef: { ...acme().taskRef, prefixes: Array.from({ length: 10 }, () => "") } };
    expect(errorsOf(exactly)).toEqual(Array.from({ length: 10 }, (_, i) => `taskRef.prefixes[${i}]: is empty`));
  });

  it("gives plain one-line text, cut at 200 characters, whatever the file puts in a key", () => {
    const long = "k".repeat(500);
    const hostile = { ...acme(), [long]: 1, tools: { ...acme().tools, rawCompanions: { "get_a\nb\u0000c": "get_issues" } } };
    const errors = errorsOf(hostile);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    for (const line of errors) {
      expect(line).not.toMatch(/\p{Cc}/u);
      expect([...line].length).toBeLessThanOrEqual(MAX_ERROR_LINE_CHARS);
    }
    const cut = errors.find((line) => line.startsWith("the config: unknown key"))!;
    expect([...cut]).toHaveLength(MAX_ERROR_LINE_CHARS);
    expect(cut.endsWith("…")).toBe(true);
    expect(errors.some((line) => line.startsWith("tools.rawCompanions.get_a b c: "))).toBe(true);
    // Invisible format characters (a right-to-left override, a zero-width space) show as U+FFFD, so a key can't look
    // different in the error than in the editor.
    const invisible = `x${String.fromCharCode(0x202e)}y${String.fromCharCode(0x200b)}z`;
    const marker = String.fromCharCode(0xfffd);
    expect(errorsOf({ ...acme(), [invisible]: 1 })).toEqual([`the config: unknown key "x${marker}y${marker}z"`]);
    // A syntax error's own text is cut and flattened too.
    const syntax = errorsOf(`{"${long}": }`);
    expect(syntax).toHaveLength(1);
    expect(syntax[0]).toMatch(/^the file isn't valid JSON: /);
    expect([...syntax[0]!].length).toBeLessThanOrEqual(MAX_ERROR_LINE_CHARS);
  });

  it("reads deeply nested JSON without running out of stack", () => {
    const deep = "[".repeat(100_000) + "]".repeat(100_000);
    expect(parseTrackerConfig(deep)).toEqual({ ok: false, errors: ["the config: should be an object"] });
    const nested = (value: string) => `{"schema":1,"id":"acme","timeLogs":{"delete":{"tool":"delete_worklogs","args":${value}}},"tasks":{"myTasks":${value}}}`;
    for (const value of [deep, '{"a":'.repeat(40_000) + "1" + "}".repeat(40_000)]) {
      const result = parseTrackerConfig(nested(value));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.errors.length).toBeLessThanOrEqual(MAX_ERROR_LINES);
      expect(result.errors.every((line) => [...line].length <= MAX_ERROR_LINE_CHARS)).toBe(true);
    }
  });

  it("refuses a file larger than 256 KB, before parsing it", () => {
    const big =`${ACME_TEXT.trimEnd()}${" ".repeat(MAX_CONFIG_BYTES)}`;
    expect(errorsOf(big)).toEqual(["the file is larger than 256 KB"]);
    const padded = `${" ".repeat(MAX_CONFIG_BYTES - Buffer.byteLength(ACME_TEXT))}${ACME_TEXT}`;
    expect(parseTrackerConfig(padded).ok).toBe(true);
  });

  it("refuses an id that isn't the file's name", () => {
    expect(parseTrackerConfig(ACME_TEXT, "acme").ok).toBe(true);
    expect(parseTrackerConfig(ACME_TEXT, "acme-2")).toEqual({
      ok: false,
      errors: ['id: is "acme", but the file is called acme-2.json; they must be the same'],
    });
  });
});

describe("the trackers folder", () => {
  it("lists nothing when there is no folder", () => {
    expect(listTrackerConfigs(dataDir())).toEqual([]);
  });

  it("lists every .json file directly in it, by name, each with its config or its errors", () => {
    const other = { ...acme(), id: "acme-two", label: "Acme Two" };
    const dir = dataDir({
      "acme.json": ACME_TEXT,
      "acme-two.json": JSON.stringify(other, null, 2),
      "broken.json": "{",
      "wrong-id.json": ACME_TEXT,
      "Upper.json": ACME_TEXT,
      "none.json": ACME_TEXT,
      "default.json": ACME_TEXT,
      "other.JSON": ACME_TEXT,
      "notes.txt": "x",
      "folder.json/": "",
    });
    const listing = listTrackerConfigs(dir);
    expect(listing.map((l) => [l.file, l.ok])).toEqual([
      ["Upper.json", false],
      ["acme-two.json", true],
      ["acme.json", true],
      ["broken.json", false],
      ["default.json", false],
      ["none.json", false],
      ["other.JSON", false],
      ["wrong-id.json", false],
    ]);
    const byFile = Object.fromEntries(listing.map((l) => [l.file, l]));
    expect(byFile["acme.json"]).toMatchObject({ id: "acme", ok: true, hash: configHash(ACME_TEXT) });
    expect(byFile["acme-two.json"]).toMatchObject({ id: "acme-two", ok: true, hash: configHash(JSON.stringify(other)) });
    expect(byFile["broken.json"]).toMatchObject({ ok: false, errors: [expect.stringMatching(/^the file isn't valid JSON/)] });
    expect(byFile["wrong-id.json"]).toMatchObject({ ok: false, errors: [expect.stringContaining("the file is called wrong-id.json")] });
    expect(byFile["Upper.json"]).toMatchObject({ ok: false, errors: [expect.stringMatching(/^the file name isn't <id>\.json/)] });
    expect(byFile["none.json"]).toMatchObject({ ok: false, errors: [expect.stringMatching(/^the file name isn't <id>\.json/)] });
    expect(byFile["default.json"]).toMatchObject({ ok: false, errors: [expect.stringMatching(/^the file name isn't <id>\.json/)] });
    // The id is the file's own name, so a different extension case is a name that can't be loaded by id.
    expect(byFile["other.JSON"]).toMatchObject({ id: "other", ok: false, errors: [expect.stringMatching(/^the file name isn't <id>\.json/)] });
  });

  it("lists a link to a folder with the error that it isn't a file", () => {
    const dir = dataDir({ "target/": "" });
    // A junction needs no privilege on Windows; elsewhere the type is ignored.
    symlinkSync(path.join(dir, "trackers", "target"), path.join(dir, "trackers", "dirlink.json"), "junction");
    expect(listTrackerConfigs(dir)).toEqual([{ file: "dirlink.json", id: "dirlink", ok: false, errors: ["dirlink.json isn't a file"] }]);
  });

  it.skipIf(!LINKS)("lists a link to a config file, so a config can live elsewhere", () => {
    const dir = dataDir({ "real.txt": ACME_TEXT });
    symlinkSync(path.join(dir, "trackers", "real.txt"), path.join(dir, "trackers", "acme.json"), "file");
    expect(listTrackerConfigs(dir)).toMatchObject([{ file: "acme.json", id: "acme", ok: true, hash: configHash(ACME_TEXT) }]);
    expect(loadTrackerConfig(dir, "acme")).toMatchObject({ ok: true, hash: configHash(ACME_TEXT) });
  });

  it("refuses a file larger than 256 KB without reading it", () => {
    const dir = dataDir({ "big.json": " ".repeat(MAX_CONFIG_BYTES + 1) });
    expect(listTrackerConfigs(dir)).toEqual([{ file: "big.json", id: "big", ok: false, errors: ["the file is larger than 256 KB"] }]);
  });

  it("loads the chosen config by its id, checked before it becomes a path", () => {
    const dir = dataDir({ "acme.json": ACME_TEXT });
    expect(loadTrackerConfig(dir, "acme")).toMatchObject({ ok: true, hash: configHash(ACME_TEXT), file: path.join(dir, "trackers", "acme.json") });
    expect(loadTrackerConfig(dir, "globex")).toMatchObject({ ok: false, errors: ["there is no globex.json in the trackers folder"] });
    for (const id of ["../acme", "acme/../acme", "..\\acme", "ACME", "a", "none", "default", "", "acme.json"]) {
      expect(loadTrackerConfig(dir, id)).toEqual({ ok: false, errors: [`${JSON.stringify(id)} isn't a tracker id`] });
    }
  });

  it("loads a file only under its exact name, as the listing does (a case-insensitive disk would open ACME.json for acme)", () => {
    const dir = dataDir({ "ACME.json": ACME_TEXT });
    expect(listTrackerConfigs(dir)).toMatchObject([{ file: "ACME.json", ok: false, errors: [expect.stringMatching(/^the file name isn't <id>\.json/)] }]);
    expect(loadTrackerConfig(dir, "acme")).toMatchObject({ ok: false, errors: ["there is no acme.json in the trackers folder"] });
    expect(loadTrackerConfig(dataDir(), "acme")).toMatchObject({ ok: false, errors: ["there is no acme.json in the trackers folder"] });
  });
});
