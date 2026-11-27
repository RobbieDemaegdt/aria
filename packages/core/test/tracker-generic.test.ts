/**
 * The places that assumed a numeric task ID: the Timekeeper's mail matcher
 * and the watcher's attention event. Each gives what it always gave for an ID of digits, and now works for IDs such as
 * `ACME-123` (the fictional Acme Tracker, fixtures/trackers/acme.json). The window's ask-about-a-task pattern is
 * proved in apps/desktop/test/tracker.test.ts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ManualClock, mergeCatalog, mentionsTaskId, Store, TrackerWatcher, type TaskTracker } from "../src/index.ts";
import type { AttentionEvent } from "../src/attention/attention.ts";
import { parseTrackerConfig } from "../src/trackers/config/load.ts";
import { createConfigTracker } from "../src/trackers/config/tracker.ts";

const ACME = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/trackers/acme.json", import.meta.url)), "utf8")) as Record<string, any>;

function build(edit: (config: Record<string, any>) => void): TaskTracker {
  const raw = structuredClone(ACME);
  edit(raw);
  const parsed = parseTrackerConfig(JSON.stringify(raw), "acme");
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return createConfigTracker(parsed.config);
}

describe("the mail matcher", () => {
  /** What the Timekeeper did before: the ID in a pattern as it was, on lower-cased text. */
  const before = (text: string, id: string) => new RegExp(`\\b${id}\\b`).test(text.toLowerCase());

  it("gives what it gave for an ID of digits, on any text", () => {
    const ids = ["100123", "4", "0042", "55516", "1234567890123", "7"];
    const texts: string[] = [];
    for (const id of ids) {
      for (const around of ["", " ", "x", "-", "#", ".", ",", "_", "a ", " b", "1", "0", "(", ")", "\n", "é"]) {
        texts.push(`${around}${id}`, `${id}${around}`, `${around}${id}${around}`, `re: ${around}${id}${around} status`, `RE: TASK ${around}${id}`);
      }
      texts.push(`${id}${id}`, `${id} ${id}`, `x${id}y`, `1${id}`, `${id}2`, `see #${id}, please`, `ID=${id};`, `task-${id}`, `${id}-task`);
    }
    texts.push("", "no ids here", "100123100123", "Re: 1001239");
    let found = 0;
    for (const text of texts) {
      for (const id of ids) {
        expect(mentionsTaskId(text.toLowerCase(), id), `${id} in ${JSON.stringify(text)}`).toBe(before(text, id));
        // Case doesn't matter for digits, so the text needn't be lower-cased.
        expect(mentionsTaskId(text, id), `${id} in ${JSON.stringify(text)} as written`).toBe(before(text, id));
        if (before(text, id)) found++;
      }
    }
    expect(found).toBeGreaterThan(100);
  });

  it("finds an ID that has letters, in any case, as a whole word", () => {
    expect(mentionsTaskId("re: acme-123 follow-up", "ACME-123")).toBe(true);
    expect(mentionsTaskId("Re: ACME-123 follow-up", "ACME-123")).toBe(true);
    expect(mentionsTaskId("(acme-123)", "ACME-123")).toBe(true);
    expect(mentionsTaskId("acme-1234", "ACME-123")).toBe(false);
    expect(mentionsTaskId("xacme-123", "ACME-123")).toBe(false);
    expect(mentionsTaskId("acme-12", "ACME-123")).toBe(false);
  });

  it("reads the characters of an ID as they are, not as a pattern", () => {
    expect(mentionsTaskId("see a.b-2 now", "A.B-2")).toBe(true);
    expect(mentionsTaskId("see axb-2 now", "A.B-2")).toBe(false);
    expect(mentionsTaskId("see ab-2 now", "A+B-2")).toBe(false);
    expect(mentionsTaskId("see a+b-2 now", "A+B-2")).toBe(true);
    expect(() => mentionsTaskId("anything", "(unclosed")).not.toThrow();
    expect(mentionsTaskId("a [b] c", "[b]")).toBe(false);
  });
});

describe("the watcher's attention event", () => {
  /** Polls twice on one store (the first baselines) and gives the attention events of the second, which brings a new task. */
  async function run(tracker: TaskTracker, first: string[], second: string[]): Promise<AttentionEvent[]> {
    const now = Date.parse("2026-10-23T08:00:00Z");
    const server = "Acme Tasks";
    const db = new Store(":memory:");
    const catalog = mergeCatalog(
      { servers: [], tools: [] },
      { servers: [{ name: server, status: "connected", source: "user" }] as never, tools: [{ name: "Acme-Tasks-list_my_issues", server, tool: "list_my_issues" }] as never },
      now,
    );
    const answers = [first, second];
    let call = 0;
    const issues = (keys: string[]) => JSON.stringify({ issues: keys.map((key) => ({ key, fields: { summary: `Issue ${key}`, status: { name: "To Do" } } })) });
    const events: AttentionEvent[] = [];
    const watcher = new TrackerWatcher({
      db: () => db,
      tracker: () => tracker,
      clock: new ManualClock(now),
      mcpClient: () => ({ callTool: async () => ({ ok: true, result: issues(answers[Math.min(call++, 1)]!) }) }) as never,
      catalog: () => catalog,
      toolRules: () => [],
      mcpConfig: () => ({ keepInSync: false, pluginDirectories: [], servers: [{ name: server, transport: "http", url: "https://x.example/mcp", enabled: true, source: "aria" }] }) as never,
      canCallServerTool: () => true,
      addCard: () => {},
      attention: (event) => events.push(event),
      digest: () => {},
      jitter: 0,
    });
    watcher.start();
    await watcher.poll({ force: true });
    expect(events).toEqual([]);
    await watcher.poll({ force: true });
    watcher.stop();
    return events;
  }

  it("carries the task's number as the watch ID for an ID of digits, as it always did", async () => {
    const numeric = build((c) => {
      c.taskRef = { id: "[1-9]\\d{3,8}", prefixes: ["task"], bare: true, urls: ["acme.example/browse/{id}"] };
      c.ids.task = "[1-9]\\d{3,8}";
    });
    const events = await run(numeric, ["4001"], ["4001", "4002"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("tracker_update");
    expect(events[0]?.watch).toEqual({ id: 4002, title: "#4002", repoName: "Acme Tracker" });
  });

  it("carries no watch ID for an ID that isn't a number, instead of 0", async () => {
    const events = await run(build(() => {}), ["ACME-1"], ["ACME-1", "ACME-2"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.watch).toEqual({ title: "#ACME-2", repoName: "Acme Tracker" });
    expect(Object.hasOwn(events[0]!.watch!, "id")).toBe(false);
  });
});
