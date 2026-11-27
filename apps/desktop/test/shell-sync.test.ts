import { describe, expect, it } from "vitest";
import { HOTKEY_RETRY_MS, ShellSync, type ShellSettings } from "../src/main/shell-sync";

function setup() {
  const calls = { login: [] as Array<[boolean, readonly string[]]>, register: 0, unregister: 0, warnings: [] as string[] };
  const state = { now: 1_000, hotkeyFree: true, throwing: false };
  const sync = new ShellSync({
    setLoginItem(openAtLogin, args) {
      calls.login.push([openAtLogin, args]);
      if (state.throwing) throw new Error("unsupported");
    },
    registerHotkey() {
      calls.register++;
      if (state.throwing) throw new Error("headless");
      return state.hotkeyFree;
    },
    unregisterHotkey() {
      calls.unregister++;
    },
    now: () => state.now,
    warn(message) {
      calls.warnings.push(message);
    },
  });
  return { sync, calls, state };
}

const settings = (over: Partial<ShellSettings> = {}): ShellSettings => ({ startAtLogin: false, loginItemArgs: [], hotkey: false, ...over });

describe("ShellSync", () => {
  it("writes the login item once, and again only when it changes", () => {
    const { sync, calls } = setup();
    for (let i = 0; i < 50; i++) sync.apply(settings({ startAtLogin: true, loginItemArgs: ["--startup", "--hidden"] }));
    expect(calls.login).toEqual([[true, ["--startup", "--hidden"]]]);

    sync.apply(settings({ startAtLogin: true, loginItemArgs: ["--startup"] }));
    sync.apply(settings({ startAtLogin: true, loginItemArgs: ["--startup"] }));
    sync.apply(settings());
    expect(calls.login).toEqual([
      [true, ["--startup", "--hidden"]],
      [true, ["--startup"]],
      [false, []],
    ]);
  });

  it("registers the hotkey once and leaves it held", () => {
    const { sync, calls, state } = setup();
    for (let i = 0; i < 50; i++) {
      sync.apply(settings({ hotkey: true }));
      state.now += HOTKEY_RETRY_MS;
    }
    expect(calls.register).toBe(1);
    expect(calls.unregister).toBe(0);
  });

  it("tries a hotkey another app holds only once a minute", () => {
    const { sync, calls, state } = setup();
    state.hotkeyFree = false;
    for (let i = 0; i < 50; i++) sync.apply(settings({ hotkey: true }));
    expect(calls.register).toBe(1);

    state.now += HOTKEY_RETRY_MS - 1;
    sync.apply(settings({ hotkey: true }));
    expect(calls.register).toBe(1);

    state.now += 1;
    state.hotkeyFree = true;
    sync.apply(settings({ hotkey: true }));
    expect(calls.register).toBe(2);

    state.now += HOTKEY_RETRY_MS;
    sync.apply(settings({ hotkey: true }));
    expect(calls.register).toBe(2);
  });

  it("gives the hotkey back when it's turned off, and tries at once when it's turned on again", () => {
    const { sync, calls, state } = setup();
    sync.apply(settings({ hotkey: true }));
    sync.apply(settings());
    sync.apply(settings());
    expect(calls.unregister).toBe(1);

    sync.apply(settings({ hotkey: true }));
    expect(calls.register).toBe(2);

    // Never held: nothing to give back, and turning it on doesn't wait out the retry either.
    state.hotkeyFree = false;
    sync.apply(settings());
    expect(calls.unregister).toBe(2);
    sync.apply(settings({ hotkey: true }));
    expect(calls.register).toBe(3);
    sync.apply(settings());
    expect(calls.unregister).toBe(2);
  });

  it("carries on when the OS refuses, and says so", () => {
    const { sync, calls, state } = setup();
    state.throwing = true;
    expect(() => sync.apply(settings({ startAtLogin: true, hotkey: true }))).not.toThrow();
    expect(calls.login).toHaveLength(1);
    expect(calls.register).toBe(1);

    // Not retried for the login item until it changes; the hotkey has its minute.
    sync.apply(settings({ startAtLogin: true, hotkey: true }));
    expect(calls.login).toHaveLength(1);
    expect(calls.register).toBe(1);
    expect(calls.warnings).toEqual(["Couldn't set ARIA to start at login: unsupported", "Couldn't set the quick prompt's hotkey: headless"]);
  });
});
