import { describe, expect, it } from "vitest";
import { IDLE_AWAY_SECONDS, PresenceController, type IdleState, type WindowState } from "../src/main/presence";

/** Stands in for a BrowserWindow or powerMonitor: only `on` and `emit`. */
class EventEmitter {
  private readonly listeners = new Map<string, Array<() => void>>();
  on(event: string, listener: () => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

/** The window and powerMonitor as plain emitters, their state as values a test sets, and timers a test runs. */
function setup() {
  const window = new EventEmitter();
  const power = new EventEmitter();
  const state: { window: WindowState; idle: IdleState; now: number } = {
    window: { exists: true, visible: true, minimized: false, focused: true },
    idle: { state: "active", seconds: 0 },
    now: 1_000_000,
  };
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let ids = 0;
  const reports: Array<[boolean, number]> = [];
  /** Whether each report said the screen is locked. */
  const locks: boolean[] = [];
  const presence = new PresenceController({
    window: () => state.window,
    idle: () => state.idle,
    report: (present, since, locked) => {
      reports.push([present, since]);
      locks.push(locked);
    },
    now: () => state.now,
    setTimer: (fn, ms) => {
      timers.push({ at: state.now + ms, fn, id: ++ids });
      return ids;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  presence.attachWindow(window);
  presence.attachPower(power);
  /** Moves time on, running the timers that come due. */
  const advance = (ms: number) => {
    const until = state.now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      state.now = due.at;
      due.fn();
    }
    state.now = until;
  };
  const blur = () => {
    state.window = { ...state.window, focused: false };
    window.emit("blur");
  };
  const focus = () => {
    state.window = { ...state.window, focused: true };
    window.emit("focus");
  };
  return { window, power, state, reports, locks, presence, advance, blur, focus };
}

describe("whether you're at ARIA (PLAN.md §4.5, D25)", () => {
  it("first reports at the window's first focus, or what it sees after 5 seconds", () => {
    const shown = setup();
    shown.presence.start();
    shown.window.emit("show");
    expect(shown.reports).toEqual([]);
    shown.focus();
    expect(shown.reports).toEqual([[true, 1_000_000]]);

    const hidden = setup();
    hidden.state.window = { exists: true, visible: false, minimized: false, focused: false };
    hidden.presence.start();
    hidden.advance(4_999);
    expect(hidden.reports).toEqual([]);
    hidden.advance(1);
    expect(hidden.reports).toEqual([[false, 1_005_000]]);
  });

  it("follows the window: blurred, minimized, hidden to the tray, back", () => {
    const { presence, reports, state, window, blur, focus } = setup();
    presence.start();
    focus();
    blur();
    focus();
    state.window = { ...state.window, minimized: true };
    window.emit("minimize");
    state.window = { ...state.window, minimized: false };
    window.emit("restore");
    state.window = { ...state.window, visible: false };
    window.emit("hide");
    expect(reports.map(([present]) => present)).toEqual([true, false, true, false, true, false]);
  });

  it("counts a locked screen and sleep as away, and a missed unlock doesn't keep you away", () => {
    const { presence, reports, locks, power, focus } = setup();
    presence.start();
    focus();
    power.emit("lock-screen");
    power.emit("unlock-screen");
    power.emit("suspend");
    power.emit("resume");
    // The unlock event never came: the window coming to the front again means you're back.
    power.emit("lock-screen");
    focus();
    expect(reports.map(([present]) => present)).toEqual([true, false, true, false, true, false, true]);
    // Which of those were the lock (toasts wait for the unlock: Windows drops them meanwhile).
    expect(locks).toEqual([false, true, false, false, false, true, false]);
  });

  it("reports a lock while you were already away from ARIA, and the unlock", () => {
    const { presence, reports, locks, power, focus, blur } = setup();
    presence.start();
    focus();
    blur();
    power.emit("lock-screen");
    power.emit("unlock-screen");
    expect(reports.map(([present]) => present)).toEqual([true, false, false, false]);
    expect(locks).toEqual([false, false, true, false]);
  });

  it("polls idleness: away from your last input after 5 minutes without any, back on the next poll after input", () => {
    const { presence, reports, state, advance, focus } = setup();
    presence.start();
    focus();
    state.idle = { state: "idle", seconds: IDLE_AWAY_SECONDS + 7 };
    advance(10_000);
    expect(reports.at(-1)).toEqual([false, state.now - (IDLE_AWAY_SECONDS + 7) * 1000]);
    const since = reports.at(-1)![1];
    // Still idle: the start of it doesn't move.
    state.idle = { state: "idle", seconds: IDLE_AWAY_SECONDS + 17 };
    advance(10_000);
    expect(reports).toHaveLength(2);
    state.idle = { state: "active", seconds: 0 };
    advance(10_000);
    expect(reports.at(-1)).toEqual([true, state.now]);
    expect(since).toBe(1_000_000 + 10_000 - (IDLE_AWAY_SECONDS + 7) * 1000);
  });

  it("corrects the lock and a missed resume from the polls, and ignores an unknown idle state", () => {
    const { presence, reports, state, power, advance, focus } = setup();
    presence.start();
    focus();
    state.idle = { state: "locked", seconds: 0 };
    advance(10_000);
    expect(reports.at(-1)![0]).toBe(false);
    // Unlocked without an event: the next poll says so.
    state.idle = { state: "active", seconds: 0 };
    advance(10_000);
    expect(reports.at(-1)![0]).toBe(true);
    // A missed resume: a poll that runs means the PC is awake.
    power.emit("suspend");
    expect(reports.at(-1)![0]).toBe(false);
    advance(10_000);
    expect(reports.at(-1)![0]).toBe(true);
    expect(reports.map(([present]) => present)).toEqual([true, false, true, false, true]);
    state.idle = { state: "unknown", seconds: 0 };
    advance(10_000);
    expect(reports).toHaveLength(5);
  });

  it("reports nothing after stop", () => {
    const { presence, reports, state, advance, focus, blur } = setup();
    presence.start();
    focus();
    presence.stop();
    blur();
    state.idle = { state: "idle", seconds: 900 };
    advance(60_000);
    expect(reports).toEqual([[true, 1_000_000]]);
  });
});
