/**
 * No task tracker and the scheduler: nothing is ever registered, so no workday
 * is "unregistered": the morning brief leaves them out (and its headline doesn't mention them), and the Friday week
 * overview has nothing to check. With a tracker both are as before (the 6B tests pin that; the control here too).
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CardItem } from "@aria/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_MORNING_BRIEF_ID, BUILTIN_WEEKLY_OVERVIEW_ID, FakeRuntime, AriaEngine, ManualClock, NO_TRACKER, type TaskTracker } from "../src/index.ts";
import "./no-network.ts";
import { acmeTracker } from "./helpers/acme.ts";

const dirs: string[] = [];
const engines: AriaEngine[] = [];
afterEach(async () => {
  while (engines.length > 0) await engines.pop()!.stop();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** An engine on a Friday morning (2026-10-23 09:00 local) with no work to brief on, with the given tracker. */
async function start(tracker: TaskTracker): Promise<AriaEngine> {
  const base = mkdtempSync(path.join(os.tmpdir(), "aria-sched-none-"));
  dirs.push(base);
  const engine = new AriaEngine({
    dataDir: path.join(base, "data"),
    runtime: new FakeRuntime(),
    projectRoots: [],
    attentionClock: new ManualClock(new Date(2026, 9, 23, 9, 0, 0, 0).getTime()),
    tracker,
  });
  engines.push(engine);
  await engine.start();
  return engine;
}

const briefs = (engine: AriaEngine) =>
  engine.getState().timeline.filter((i): i is Extract<CardItem, { cardType: "morning_brief" }> => i.kind === "card" && i.cardType === "morning_brief");

describe("the scheduler with no task tracker", () => {
  it("leaves unregistered workdays out of the morning brief, and says all is clear without mentioning them", async () => {
    const engine = await start(NO_TRACKER);
    const routine = await engine.runRoutine(BUILTIN_MORNING_BRIEF_ID);
    expect(routine.lastStatus).toBe("ok");
    const [card] = briefs(engine);
    expect(card?.payload.variant).toBe("morning_brief");
    expect(card?.payload.unregisteredDays).toEqual([]);
    expect(card?.payload.headline).toBe("All clear: no pending tasks.");
    expect(routine.lastResult).toBe("All clear: no pending tasks.");
  });

  it("runs the Friday week overview without a card, and says why", async () => {
    const engine = await start(NO_TRACKER);
    const routine = await engine.runRoutine(BUILTIN_WEEKLY_OVERVIEW_ID);
    expect(routine.lastStatus).toBe("ok");
    expect(routine.lastResult).toBe("No task tracker registers your time, so there is no week to check.");
    expect(briefs(engine).filter((c) => c.payload.variant === "weekly_time_overview")).toEqual([]);
  });

  it("is as before with a tracker: the workdays with nothing registered, in the brief and the week overview", async () => {
    const engine = await start(acmeTracker);
    await engine.runRoutine(BUILTIN_MORNING_BRIEF_ID);
    const brief = briefs(engine).find((c) => c.payload.variant === "morning_brief")!;
    expect(brief.payload.unregisteredDays.length).toBe(5);
    expect(brief.payload.headline).toBe("5 unregistered workdays");
    await engine.runRoutine(BUILTIN_WEEKLY_OVERVIEW_ID);
    const weekly = briefs(engine).find((c) => c.payload.variant === "weekly_time_overview")!;
    expect(weekly.payload.unregisteredDays).toHaveLength(5);
  });
});
