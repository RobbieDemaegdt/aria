import { describe, expect, it } from "vitest";
import { allowsPermission, dropDevSwitches } from "../src/main/hardening";

describe("dropDevSwitches", () => {
  const env = () => ({
    ELECTRON_RENDERER_URL: "https://attacker.example",
    ARIA_DATA_DIR: "C:\\elsewhere",
    ARIA_CLI_MCP_CONFIG: "C:\\elsewhere\\mcp.json",
    ARIA_PROJECT_ROOTS: "C:\\elsewhere",
    ARIA_FAKE_RUNTIME: "ui-cards",
    aria_model: "other-case",
    ARIA_LOG_LEVEL: "debug",
    ARIA_WHISPER_BIN: "C:\\whisper\\main.exe",
    ARIA_WHISPER_MODEL: "C:\\whisper\\model.bin",
    PATH: "C:\\bin",
  });

  it("removes every development switch from a packaged build, in any letter case", () => {
    const packaged = env();
    dropDevSwitches(true, packaged);
    expect(packaged).toEqual({
      ARIA_LOG_LEVEL: "debug",
      ARIA_WHISPER_BIN: "C:\\whisper\\main.exe",
      ARIA_WHISPER_MODEL: "C:\\whisper\\model.bin",
      PATH: "C:\\bin",
    });
  });

  it("leaves a development build's environment alone", () => {
    const dev = env();
    dropDevSwitches(false, dev);
    expect(dev).toEqual(env());
  });
});

describe("allowsPermission", () => {
  it("gives the microphone and nothing else", () => {
    expect(allowsPermission("media", ["audio"])).toBe(true);
    expect(allowsPermission("media", ["video"])).toBe(false);
    expect(allowsPermission("media", ["audio", "video"])).toBe(false);
    expect(allowsPermission("media", [])).toBe(false);
    expect(allowsPermission("media")).toBe(false);
    for (const other of ["geolocation", "notifications", "clipboard-read", "openExternal", "fileSystem", "hid", "serial", "usb"]) {
      expect(allowsPermission(other)).toBe(false);
    }
  });
});
