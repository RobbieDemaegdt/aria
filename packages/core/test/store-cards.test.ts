/** Finding cards and your last message without reading the timeline, however far back they are. */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CardItem, TimelineItem } from "@aria/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/store.ts";

const temps: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** In memory, so a thousand rows take milliseconds on a slow CI disk too; on disk when another connection reads it. */
function open(onDisk = false): { store: Store; file: string } {
  let file = ":memory:";
  if (onDisk) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "aria-store-cards-"));
    temps.push(dir);
    file = path.join(dir, "aria.db");
  }
  const store = new Store(file);
  stores.push(store);
  return { store, file };
}

const card = (id: string, cardType: CardItem["cardType"], createdAt: number): TimelineItem =>
  ({ kind: "card", id, cardType, createdAt, updatedAt: createdAt, payload: { shortId: id } }) as unknown as TimelineItem;
const chat = (id: string, role: "user" | "assistant", createdAt: number, via?: "telegram"): TimelineItem => ({
  kind: "chat",
  id,
  role,
  content: id,
  createdAt,
  ...(via ? { via } : {}),
});
const ids = (items: Array<{ id: string }>) => items.map((i) => i.id);

/** More rows after everything else than `listTimeline` keeps. */
function bury(store: Store, from: number): void {
  for (let i = 0; i < 1100; i++) store.upsertTimeline(chat(`later-${i}`, "assistant", from + i));
}

describe("Store.listCards", () => {
  it("gives a type's cards oldest first, and no others", () => {
    const { store } = open();
    store.upsertTimeline(card("new-ci", "ci", 300));
    store.upsertTimeline(card("old-ci", "ci", 100));
    store.upsertTimeline(card("a-pr", "pr", 200));
    store.upsertTimeline(chat("a-chat", "user", 150));
    expect(ids(store.listCards("ci"))).toEqual(["old-ci", "new-ci"]);
    expect(ids(store.listCards("ci", "pr"))).toEqual(["old-ci", "a-pr", "new-ci"]);
    expect(store.listCards("reminder")).toEqual([]);
  });

  it("finds a card further back than the timeline's window", () => {
    const { store } = open();
    store.upsertTimeline(card("buried", "ci", 100));
    bury(store, 1_000);
    expect(store.listTimeline().some((i) => i.id === "buried")).toBe(false);
    expect(ids(store.listCards("ci"))).toEqual(["buried"]);
  });

  it("sees a card's change and keeps the newest thousand", () => {
    const { store } = open();
    for (let i = 0; i < 1005; i++) store.upsertTimeline(card(`c-${i}`, "ci", 100 + i));
    const listed = store.listCards("ci");
    expect(listed).toHaveLength(1000);
    expect(listed[0]!.id).toBe("c-5");
    expect(listed.at(-1)!.id).toBe("c-1004");

    store.upsertTimeline({ ...listed[0]!, updatedAt: 9_999 });
    expect(store.listCards("ci")[0]!.updatedAt).toBe(9_999);
  });
});

describe("Store.lastUserChat", () => {
  it("is your newest message, not ARIA's", () => {
    const { store } = open();
    expect(store.lastUserChat()).toBeUndefined();
    store.upsertTimeline(chat("first", "user", 100));
    store.upsertTimeline(chat("second", "user", 200));
    store.upsertTimeline(chat("reply", "assistant", 300));
    expect(store.lastUserChat()?.id).toBe("second");
  });

  it("finds it further back than the timeline's window", () => {
    const { store } = open();
    store.upsertTimeline(chat("from-phone", "user", 100, "telegram"));
    bury(store, 1_000);
    expect(store.lastUserChat()?.via).toBe("telegram");
  });
});

describe("the timeline's indexes", () => {
  it("are what these queries use, so they don't read the timeline", () => {
    const { store, file } = open(true);
    store.upsertTimeline(card("a", "ci", 100));
    const db = new DatabaseSync(file, { readOnly: true, timeout: 5_000 });
    try {
      const plan = (sql: string, ...args: string[]) =>
        (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
      expect(plan(`SELECT content_json FROM timeline WHERE kind = 'card' AND json_extract(content_json, '$.cardType') IN (?) ORDER BY created_at DESC, rowid DESC LIMIT 1000`, "ci")).toContain("timeline_card_type");
      expect(plan(`SELECT content_json FROM timeline WHERE kind = 'chat' AND json_extract(content_json, '$.role') = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1`)).toContain("timeline_user_chat");
    } finally {
      db.close();
    }
  });
});
