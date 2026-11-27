/**
 * Reading tracker objects by config paths (docs/trackers.md, "The reference"): dot paths of own properties, the
 * value kinds, first valid wins, the name fields and the comment reader. All payloads are fictional.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OBJECT_KEYS,
  firstValid,
  isDotPath,
  readComment,
  readDate,
  readEntityName,
  readId,
  readNameField,
  readPath,
  readPerson,
  readPlain,
  readScalar,
  readText,
  readTime,
  type CommentPaths,
  type ObjectKeys,
} from "../src/trackers/config/fields.ts";
import { idMatcher, parseIdPattern } from "../src/trackers/config/patterns.ts";

const KEYS: ObjectKeys = { id: ["id", "key"], text: ["value", "name", "label"], name: ["displayName", "name"] };

function matcher(source: string): RegExp {
  const parsed = parseIdPattern(source);
  if (!parsed.ok) throw new Error(parsed.error);
  return idMatcher(parsed.value, false);
}

describe("paths", () => {
  it.each(["a", "fields.status", "a.b.c.d.e", "$x", "_a-b", "A1.b_2.$c"])("accepts %s", (path) => expect(isDotPath(path)).toBe(true));

  it.each(["", "a..b", ".a", "a.", "a.b.c.d.e.f", "a[0]", "a.*", "__proto__", "a.constructor", "prototype.x", "1a", "a b", "a.é", `a${"b".repeat(200)}`])(
    "refuses %j",
    (path) => expect(isDotPath(path)).toBe(false),
  );

  it("reads own properties of plain objects only", () => {
    const obj = { a: { b: { c: 1 } }, list: [{ x: 1 }], nil: null, zero: 0 };
    expect(readPath(obj, "a.b.c")).toBe(1);
    expect(readPath(obj, "a.b")).toEqual({ c: 1 });
    expect(readPath(obj, "a.x")).toBeUndefined();
    expect(readPath(obj, "list.x")).toBeUndefined();
    expect(readPath(obj, "nil")).toBeNull();
    expect(readPath(obj, "nil.x")).toBeUndefined();
    expect(readPath(obj, "zero")).toBe(0);
    expect(readPath(Object.create({ inherited: 1 }), "inherited")).toBeUndefined();
    expect(readPath({}, "toString")).toBeUndefined();
    expect(readPath(JSON.parse('{"__proto__": {"x": 1}}'), "__proto__.x")).toBeUndefined();
    expect(readPath(JSON.parse('{"a": {"constructor": {"x": 1}}}'), "a.constructor.x")).toBeUndefined();
    expect(readPath("text", "length")).toBeUndefined();
  });

  it("reads an object's ID, text and name keys (objectKeys) as own properties only", () => {
    const keys: ObjectKeys = { id: ["toString", "id"], text: ["toString", "label"], name: ["toString", "title"] };
    // Keys held by the prototype: nothing, not even under a key named like a method of every object.
    const inherited = Object.create({ id: "from the prototype", label: "from the prototype", title: "from the prototype", toString: "x" });
    expect(readId(inherited, keys)).toBeUndefined();
    expect(readText(inherited, 80, keys)).toBeUndefined();
    expect(readEntityName(inherited, 80, keys)).toBeUndefined();
    expect(readPerson(inherited, 80, keys)).toBeUndefined();
    // A plain object has `toString` from its prototype: a key that names it is passed over, not read.
    expect(readId({ id: "7" }, keys)).toBe("7");
    expect(readText({ label: "L" }, 80, keys)).toBe("L");
    expect(readEntityName({ title: "T" }, 80, keys)).toBe("T");
    // An own key named like one still reads.
    expect(readId({ toString: "9" }, keys)).toBe("9");
  });
});

describe("value kinds", () => {
  it("id: a trimmed string or finite number, an object's first present id key, three objects deep, then the pattern", () => {
    const digits = { pattern: matcher("[1-9]\\d{0,11}"), max: 64 };
    expect(readId("  41358 ", KEYS)).toBe("41358");
    expect(readId(41358, KEYS)).toBe("41358");
    expect(readId(1.5, KEYS)).toBe("1.5");
    expect(readId(1.5, KEYS, digits)).toBeUndefined();
    expect(readId(Number.NaN, KEYS)).toBeUndefined();
    expect(readId(Number.POSITIVE_INFINITY, KEYS)).toBeUndefined();
    expect(readId("", KEYS)).toBeUndefined();
    expect(readId("   ", KEYS)).toBeUndefined();
    expect(readId(true, KEYS)).toBeUndefined();
    expect(readId(["41358"], KEYS)).toBeUndefined();
    expect(readId({ id: "41358" }, KEYS)).toBe("41358");
    expect(readId({ key: 7 }, KEYS)).toBe("7");
    expect(readId({ id: null, key: "k1" }, KEYS)).toBe("k1");
    expect(readId({ id: "", key: "k1" }, KEYS)).toBeUndefined(); // first present, as `a ?? b` reads it
    expect(readId({ id: { id: { id: "3" } } }, KEYS)).toBe("3");
    expect(readId({ id: { id: { id: { id: "4" } } } }, KEYS)).toBeUndefined();
    expect(readId({ ID: "41358" }, KEYS)).toBeUndefined();
    expect(readId("0", KEYS, digits)).toBeUndefined();
    expect(readId("ACME-1", KEYS, digits)).toBeUndefined();
    expect(readId("9".repeat(65), KEYS, { max: 64 })).toBeUndefined();
    expect(readId("9".repeat(65), KEYS)).toBe("9".repeat(65));
  });

  it("scalar: a string, finite number or boolean, cleaned; nothing for objects", () => {
    expect(readScalar("  Dark   mode <b>toggle</b> ", 200)).toBe("Dark mode toggle");
    expect(readScalar("R&amp;D", 200)).toBe("R&D");
    expect(readScalar(42, 200)).toBe("42");
    expect(readScalar(true, 200)).toBe("true");
    expect(readScalar({ value: "x" }, 200)).toBeUndefined();
    expect(readScalar(["x"], 200)).toBeUndefined();
    expect(readScalar("", 200)).toBeUndefined();
    expect(readScalar("abcdef", 4)).toBe("abc…");
  });

  it("text: a string or finite number, or an object's first present text key", () => {
    expect(readText(" In  progress ", 80, KEYS)).toBe("In progress");
    expect(readText(3, 80, KEYS)).toBe("3");
    expect(readText(true, 80, KEYS)).toBeUndefined();
    expect(readText({ value: "High" }, 80, KEYS)).toBe("High");
    expect(readText({ name: "n", label: "l" }, 80, KEYS)).toBe("n");
    expect(readText({ value: "", name: "n" }, 80, KEYS)).toBeUndefined();
    expect(readText({ value: false }, 80, KEYS)).toBe("false");
    expect(readText({ other: "x" }, 80, KEYS)).toBeUndefined();
    expect(readText([], 80, KEYS)).toBeUndefined();
  });

  it("entityName: a string that isn't all digits, or an object's first present name key", () => {
    expect(readEntityName(" Orbit  Desk ", 120, KEYS)).toBe("Orbit Desk");
    expect(readEntityName("60294", 120, KEYS)).toBeUndefined();
    expect(readEntityName(" 811 ", 120, KEYS)).toBeUndefined();
    expect(readEntityName(60294, 120, KEYS)).toBeUndefined();
    expect(readEntityName({ displayName: "Shown", name: "n" }, 120, KEYS)).toBe("Shown");
    expect(readEntityName({ value: "v" }, 120, KEYS)).toBeUndefined();
    expect(readEntityName({ name: 5 }, 120, KEYS)).toBe("5");
  });

  it("person: the name, else the text, of the same value", () => {
    expect(readPerson("Eva", 80, KEYS)).toBe("Eva");
    expect(readPerson("1234", 80, KEYS)).toBe("1234");
    expect(readPerson(7, 80, KEYS)).toBe("7");
    expect(readPerson({ displayName: "Bob", value: "v" }, 80, KEYS)).toBe("Bob");
    expect(readPerson({ value: "v" }, 80, KEYS)).toBe("v");
    expect(readPerson({ label: "l" }, 80, KEYS)).toBe("l");
    expect(readPerson(true, 80, KEYS)).toBeUndefined();
  });

  it("date: placeholder dates dropped, an ISO date prefix kept, other text as it is", () => {
    expect(readDate("2026-11-15T00:00:00Z")).toBe("2026-11-15");
    expect(readDate("0001-01-01")).toBeUndefined();
    expect(readDate("1900-01-01 00:00")).toBeUndefined();
    expect(readDate("1970-01-01")).toBeUndefined();
    // Kept as today: `\b` sees no word edge between the date and a `T`, so a placeholder date with a time stays.
    expect(readDate("0001-01-01T00:00:00")).toBe("0001-01-01");
    expect(readDate("next week")).toBe("next week");
    expect(readDate(20261115)).toBe("20261115");
    expect(readDate(true)).toBe("true");
    expect(readDate({ value: "2026-11-15" })).toBeUndefined();
    expect(readDate("x".repeat(50))).toBe(`${"x".repeat(39)}…`);
  });

  it("plain: strings only, without HTML decoding; a comment keeps an empty string", () => {
    expect(readPlain("Fix R&amp;D <b>", 200)).toBe("Fix R&amp;D <b>");
    expect(readPlain("line\nbreak", 200)).toBe("line break");
    expect(readPlain(5, 200)).toBeUndefined();
    expect(readPlain("", 200)).toBeUndefined();
    expect(readPlain("", 200, true)).toBe("");
    expect(readPlain(null, 200, true)).toBeUndefined();
  });

  it("time: a string in the day's zone, or epoch milliseconds", () => {
    expect(readTime("2026-10-23T09:00:00Z")).toBe(Date.parse("2026-10-23T09:00:00Z"));
    expect(readTime("2026-10-23T09:00:00", "UTC")).toBe(Date.parse("2026-10-23T09:00:00Z"));
    expect(readTime("2026-10-23T09:00:00", "Europe/Brussels")).toBe(Date.parse("2026-10-23T07:00:00Z"));
    expect(readTime(1_761_210_000_000)).toBe(1_761_210_000_000);
    expect(readTime(Number.NaN)).toBeUndefined();
    expect(readTime({})).toBeUndefined();
  });
});

describe("first valid wins", () => {
  it("takes the first path whose value the kind can read, skipping null and malformed values", () => {
    const read = (v: unknown) => readId(v, KEYS, { pattern: matcher("[1-9]\\d{0,11}") });
    expect(firstValid({ id: "", key: "41358" }, ["id", "key"], read)).toBe("41358");
    expect(firstValid({ id: null, key: "41358" }, ["id", "key"], read)).toBe("41358");
    expect(firstValid({ id: "ACME-1", key: 41358 }, ["id", "key"], read)).toBe("41358");
    expect(firstValid({ id: "1", key: "2" }, ["id", "key"], read)).toBe("1");
    expect(firstValid({ issue: { key: "7" } }, ["issue.key", "issue"], read)).toBe("7");
    expect(firstValid({}, ["id"], read)).toBeUndefined();
    expect(firstValid({ id: "1" }, undefined, read)).toBeUndefined();
  });

  it("reads a name field's paths shared with the entity's ID paths as the entity, the others as its name", () => {
    const names = ["project", "projectName"];
    const ids = ["projectId", "project"];
    const read = (obj: Record<string, unknown>) => readNameField(obj, names, ids, 120, KEYS);
    expect(read({ project: { id: "60294", displayName: "Orbit Desk" } })).toBe("Orbit Desk");
    expect(read({ project: "Orbit Desk" })).toBe("Orbit Desk");
    expect(read({ project: "60294", projectName: "Orbit Desk" })).toBe("Orbit Desk");
    expect(read({ project: 60294, projectName: "Orbit Desk" })).toBe("Orbit Desk");
    expect(read({ project: "60294" })).toBeUndefined();
    expect(read({ projectName: "811" })).toBe("811");
    expect(read({ projectName: 811 })).toBe("811");
    expect(read({ projectName: { value: "V", displayName: "D" } })).toBe("V");
    expect(read({ project: { value: "V", displayName: "D" } })).toBe("D");
    expect(read({ project: { label: "L" }, projectName: "N" })).toBe("N");
  });
});

describe("the comment reader", () => {
  const PATHS: CommentPaths = {
    list: ["comments", "notes"],
    latest: ["latestComment"],
    single: ["comment"],
    text: ["body", "text"],
    by: ["author"],
    id: ["id", "version"],
    taskBy: ["commentBy"],
    taskVersion: ["commentVersion", "version"],
    latestFallback: { by: ["commentBy"], id: ["version"] },
    singleFallback: { id: ["version"] },
  };
  const read = (task: Record<string, unknown>, paths: CommentPaths = PATHS) => readComment(task, paths, KEYS);

  it("takes a list's last item: a string, keyed by the count", () => {
    expect(read({ comments: ["first", "second &amp; last"] })).toEqual({ comment: "second & last", commentKey: "2:second & last" });
    expect(read({ comments: ["first", ""], latestComment: "not read" })).toEqual({});
  });

  it("takes a list's last item: an object, keyed by count, ID and text", () => {
    expect(read({ comments: [{ id: "c1", body: "One" }, { id: "c2", author: { displayName: "Bob" }, body: "<p>Two</p>" }] })).toEqual({
      comment: "Two",
      commentBy: "Bob",
      commentKey: "2:c2:Two",
    });
    expect(read({ comments: [{ author: "Ann", text: "No id" }] })).toEqual({ comment: "No id", commentBy: "Ann", commentKey: "1:No id" });
    expect(read({ comments: [{ version: 3, author: "Ann" }] })).toEqual({ commentBy: "Ann", commentKey: "1:3:" });
    expect(read({ comments: [{ author: "Ann" }] })).toEqual({ commentBy: "Ann" });
    expect(read({ comments: [{ id: "c1", author: "1234", body: "x" }] })).toEqual({ comment: "x", commentBy: "1234", commentKey: "1:c1:x" });
  });

  it("passes over a list that is empty or ends in something else, and takes the first valid list (D6)", () => {
    expect(read({ comments: [], latestComment: "Latest" })).toEqual({ comment: "Latest", commentKey: "Latest" });
    expect(read({ comments: ["a", ["nested"]], latestComment: "Latest" })).toEqual({ comment: "Latest", commentKey: "Latest" });
    expect(read({ comments: [], notes: ["from notes"] })).toEqual({ comment: "from notes", commentKey: "1:from notes" });
  });

  it("takes the latest comment as a string, with the task's author and version", () => {
    expect(read({ latestComment: "Latest", commentVersion: "v1", commentBy: "Eva" })).toEqual({ comment: "Latest", commentBy: "Eva", commentKey: "v1:Latest" });
    expect(read({ latestComment: "Latest", version: 6, commentBy: { value: "Lee" } })).toEqual({ comment: "Latest", commentBy: "Lee", commentKey: "6:Latest" });
    expect(read({ latestComment: "", version: "5", comment: "not read" })).toEqual({});
  });

  it("takes the latest comment as an object, falling back to the task's author and version", () => {
    expect(read({ latestComment: { id: "c99", author: "QA", body: "Verified &amp; ready." } })).toEqual({
      comment: "Verified & ready.",
      commentBy: "QA",
      commentKey: "c99:Verified & ready.",
    });
    expect(read({ latestComment: { body: "x" }, commentBy: "Task level", version: "9" })).toEqual({ comment: "x", commentBy: "Task level", commentKey: "9:x" });
    expect(read({ latestComment: { id: "c1" } })).toEqual({ commentKey: "c1:" });
    expect(read({ latestComment: {} })).toEqual({});
  });

  it("takes a single comment last: a string like the latest, an object with only the version as its fallback", () => {
    expect(read({ comment: "Direct", commentVersion: "d1", commentBy: "Ann" })).toEqual({ comment: "Direct", commentBy: "Ann", commentKey: "d1:Direct" });
    expect(read({ comment: { body: "x" }, version: "11", commentBy: "Not used" })).toEqual({ comment: "x", commentKey: "11:x" });
    expect(read({ comment: 5 })).toEqual({});
    expect(read({ latestComment: ["x"], comment: "Direct" })).toEqual({ comment: "Direct", commentKey: "Direct" });
  });

  it("cleans and caps the text at 600 characters, and reads nothing without paths", () => {
    expect(read({ comment: "x".repeat(700) }).comment).toBe(`${"x".repeat(599)}…`);
    expect(read({ comment: "x" }, { text: ["body"] })).toEqual({});
  });

  it("uses the default object keys when a config names none", () => {
    expect(readComment({ comments: [{ id: 1, author: { name: "Ann" }, body: "b" }] }, PATHS, DEFAULT_OBJECT_KEYS)).toEqual({
      comment: "b",
      commentBy: "Ann",
      commentKey: "1:1:b",
    });
  });
});
