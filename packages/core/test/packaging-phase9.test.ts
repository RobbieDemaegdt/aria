import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isTestRun } from "../../../apps/desktop/src/main/github-options.ts";
import { findCopilotCli } from "../src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

describe("Phase 9: Packaging, electron-builder.yml, findCopilotCli, and SDK upgrade checklist verification", () => {
  it("validates apps/desktop/electron-builder.yml configuration, asarUnpack rules, and NSIS userData preservation", () => {
    const builderPath = path.join(repoRoot, "apps", "desktop", "electron-builder.yml");
    expect(existsSync(builderPath)).toBe(true);
    const yml = readFileSync(builderPath, "utf8");

    expect(yml).toMatch(/^appId:\s*dev\.aria\.desktop/m);
    expect(yml).toMatch(/^productName:\s*ARIA/m);
    expect(yml).toMatch(/^asar:\s*true/m);

    // Unpacked native runtime binaries required by @github/copilot-sdk, koffi, and @koromix
    expect(yml).toContain("**/node_modules/@github/copilot-sdk*/**");
    expect(yml).toContain("**/node_modules/koffi/**");
    expect(yml).toContain("**/node_modules/@koromix/**");

    // NSIS per-user x64 installer preserving %APPDATA%\ARIA across updates
    expect(yml).toMatch(/target:\s*nsis/);
    expect(yml).toMatch(/perMachine:\s*false/);
    expect(yml).toMatch(/deleteAppDataOnUninstall:\s*false/);

    // Fuses: the packaged binary can't be turned into a plain Node, or made to load other code
    expect(yml).toMatch(/^electronFuses:/m);
    expect(yml).toMatch(/runAsNode:\s*false/);
    expect(yml).toMatch(/enableNodeOptionsEnvironmentVariable:\s*false/);
    expect(yml).toMatch(/enableNodeCliInspectArguments:\s*false/);
    expect(yml).toMatch(/onlyLoadAppFromAsar:\s*true/);
    expect(yml).toMatch(/enableEmbeddedAsarIntegrityValidation:\s*true/);
  });

  it("resolves findCopilotCli() in precedence order: COPILOT_CLI_PATH -> PATH -> resourcesPath/app.asar.unpacked", () => {
    const unpackedExe = path.win32.join(
      "C:\\Users\\sam\\AppData\\Local\\Programs\\ARIA\\resources",
      "app.asar.unpacked",
      "node_modules",
      "@github/copilot-sdk-win32-x64",
      "prebuilds",
      "win32-x64",
      "copilot-runtime.exe",
    );
    const pathExe = "C:\\Program Files\\GitHub Copilot\\copilot.exe";
    const customExe = "D:\\custom\\copilot.exe";

    // 1. COPILOT_CLI_PATH wins when set and existing
    expect(
      findCopilotCli(
        { COPILOT_CLI_PATH: customExe, PATH: "C:\\Program Files\\GitHub Copilot" },
        (f) => f === customExe || f === pathExe || f === unpackedExe,
        "win32",
        "C:\\Users\\sam\\AppData\\Local\\Programs\\ARIA\\resources",
        "x64",
      ),
    ).toBe(customExe);

    // 2. copilot.exe on PATH wins when COPILOT_CLI_PATH is unset
    expect(
      findCopilotCli(
        { PATH: "C:\\Windows\\System32;C:\\Program Files\\GitHub Copilot" },
        (f) => f === pathExe || f === unpackedExe,
        "win32",
        "C:\\Users\\sam\\AppData\\Local\\Programs\\ARIA\\resources",
        "x64",
      ),
    ).toBe(pathExe);

    // 3. Falls back to unpacked copilot-runtime.exe inside resourcesPath/app.asar.unpacked
    expect(
      findCopilotCli(
        { PATH: "C:\\Windows\\System32" },
        (f) => f === unpackedExe,
        "win32",
        "C:\\Users\\sam\\AppData\\Local\\Programs\\ARIA\\resources",
        "x64",
      ),
    ).toBe(unpackedExe);
  });

  it("isolates packaged builds from test environment variables (isTestRun returns false when packaged: true)", () => {
    const testEnv: NodeJS.ProcessEnv = {
      ARIA_FAKE_RUNTIME: "phase1",
      ARIA_E2E_HOOKS: "1",
      ARIA_TEST_RUN: "1",
      ARIA_FAKE_GITHUB: "http://127.0.0.1:9999",
    };

    expect(isTestRun({ packaged: false, env: testEnv })).toBe(true);
    expect(isTestRun({ packaged: true, env: testEnv })).toBe(false);
  });

  it("verifies docs/sdk-upgrade-checklist.md exists and matches the exact pinned @github/copilot-sdk version across package.json files", () => {
    const checklistPath = path.join(repoRoot, "docs", "sdk-upgrade-checklist.md");
    expect(existsSync(checklistPath)).toBe(true);
    const checklist = readFileSync(checklistPath, "utf8");

    const corePkg = JSON.parse(readFileSync(path.join(repoRoot, "packages", "core", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const desktopPkg = JSON.parse(readFileSync(path.join(repoRoot, "apps", "desktop", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const spikePkg = JSON.parse(readFileSync(path.join(repoRoot, "spike", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };

    const sdkVersion = corePkg.dependencies?.["@github/copilot-sdk"];
    expect(sdkVersion).toBe("1.0.22");
    expect(desktopPkg.dependencies?.["@github/copilot-sdk"]).toBe(sdkVersion);
    expect(spikePkg.dependencies?.["@github/copilot-sdk"]).toBe(sdkVersion);

    // Exact pin (no ^ or ~)
    expect(sdkVersion).not.toMatch(/^[\^~]/);

    // Checklist documents the pinned SDK version, RPC endpoints, 14 risk areas, and 5-stage verification protocol
    expect(checklist).toContain(sdkVersion!);
    expect(checklist).toContain("handlePendingSessionLimitsExhausted");
    expect(checklist).toContain("14 Empirical Breaking-Change Risk Areas");
    expect(checklist).toContain("5-Stage Verification Protocol");
  });
});
