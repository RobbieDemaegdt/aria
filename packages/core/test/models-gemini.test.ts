import type { CopilotClient } from "@github/copilot-sdk";
import { describe, expect, it, vi } from "vitest";
import { CopilotRuntime, findBundledCopilotRuntime, findCopilotCli, protocolMismatch } from "../src/runtime/copilot.ts";
import { describeRuntimeFallback } from "../src/runtime/fallback.ts";

/** The SDK's handshake errors, word for word (@github/copilot-sdk 1.0.22 `verifyProtocolVersion`). */
const NEWER_CLI =
  "SDK protocol version mismatch: SDK supports versions 3-3, but server reports version 4. Please update your SDK or server to ensure compatibility.";
const UNVERSIONED_CLI =
  "SDK protocol version mismatch: SDK supports versions 3-3, but server does not report a protocol version. Please update your server to ensure compatibility.";

const PATH_CLI = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\copilot.exe";
const BUNDLED = "C:\\Program Files\\ARIA\\resources\\app.asar.unpacked\\node_modules\\@github\\copilot-sdk-win32-x64\\prebuilds\\win32-x64\\copilot-runtime.exe";

/** A stand-in SDK client whose start() does what the test says; `version` is what getStatus() reports. */
function client(start: () => Promise<void>, version?: string) {
  return {
    start: vi.fn(start),
    stop: vi.fn(async () => []),
    forceStop: vi.fn(async () => {}),
    ...(version ? { getStatus: vi.fn(async () => ({ version, protocolVersion: 3 })) } : {}),
  };
}

/** A runtime whose CLI on PATH speaks `pathStart`'s answer and whose bundled runtime speaks `bundledStart`'s. */
function runtimeWith(pathStart: () => Promise<void>, bundledStart: () => Promise<void> = async () => {}, locate: { cli?: string; bundled?: string } = { cli: PATH_CLI, bundled: BUNDLED }) {
  const clients = new Map<string | undefined, ReturnType<typeof client>>();
  const factory = vi.fn((_env: Record<string, string>, cliPath?: string) => {
    const made = cliPath === locate.bundled ? client(bundledStart, "1.0.98") : client(pathStart);
    clients.set(cliPath, made);
    return made as unknown as CopilotClient;
  });
  const runtime = new CopilotRuntime(factory, { cli: () => locate.cli, bundled: () => locate.bundled });
  return { runtime, factory, clients };
}

describe("Copilot CLI with a wire protocol the SDK doesn't speak", () => {
  it("finds the bundled runtime unpacked next to a packaged app's app.asar", () => {
    const found = findBundledCopilotRuntime((file) => file === BUNDLED, "win32", "C:\\Program Files\\ARIA\\resources", "x64", () => []);
    expect(found).toBe(BUNDLED);
  });

  it("finds the bundled runtime in a checkout's node_modules, and a packaged app's unpacked copy instead of the one in app.asar", () => {
    const dev = "C:\\src\\ARIA\\node_modules\\@github\\copilot-sdk-win32-x64\\prebuilds\\win32-x64\\copilot-runtime.exe";
    const searchPaths = () => ["C:\\src\\ARIA\\packages\\core\\node_modules", "C:\\src\\ARIA\\node_modules"];
    expect(findBundledCopilotRuntime((file) => file === dev, "win32", undefined, "x64", searchPaths)).toBe(dev);
    // Electron in a checkout has a resourcesPath too: its unpacked folder isn't there, so node_modules is used.
    expect(findBundledCopilotRuntime((file) => file === dev, "win32", "C:\\src\\ARIA\\node_modules\\electron\\dist\\resources", "x64", searchPaths)).toBe(dev);

    const inAsar = () => ["C:\\Program Files\\ARIA\\resources\\app.asar\\node_modules"];
    expect(findBundledCopilotRuntime((file) => file === BUNDLED, "win32", undefined, "x64", inAsar)).toBe(BUNDLED);
    expect(findBundledCopilotRuntime(() => false, "win32", undefined, "x64", inAsar)).toBeUndefined();
  });

  it.runIf(process.platform === "win32")("finds this checkout's own bundled runtime", () => {
    // The SDK's platform package is installed with it, in node_modules (as the SDK finds it to start its own runtime).
    expect(findBundledCopilotRuntime()).toMatch(/[\\/]node_modules[\\/]@github[\\/]copilot-sdk-win32-[a-z0-9]+[\\/]prebuilds[\\/]win32-[a-z0-9]+[\\/]copilot-runtime\.exe$/);
  });

  it("reads the SDK's protocol mismatch errors, and nothing else", () => {
    expect(protocolMismatch(new Error(NEWER_CLI))).toEqual({ sdk: { min: 3, max: 3 }, cli: 4 });
    expect(protocolMismatch(new Error(UNVERSIONED_CLI))).toEqual({ sdk: { min: 3, max: 3 } });
    expect(protocolMismatch(new Error("Copilot CLI isn't signed in"))).toBeUndefined();
    expect(protocolMismatch("SDK protocol version mismatch: SDK supports versions 3-4, but server reports version 2.")).toEqual({ sdk: { min: 3, max: 4 }, cli: 2 });
  });

  it("starts the bundled runtime when the CLI on PATH speaks a newer protocol, and says which and why", async () => {
    const { runtime, factory, clients } = runtimeWith(async () => {
      throw new Error(NEWER_CLI);
    });
    await runtime.start({ tempDir: "C:\\aria\\tmp" });
    expect(factory.mock.calls.map(([env, cliPath]) => [env, cliPath])).toEqual([
      [{ TEMP: "C:\\aria\\tmp", TMP: "C:\\aria\\tmp" }, PATH_CLI],
      [{ TEMP: "C:\\aria\\tmp", TMP: "C:\\aria\\tmp" }, BUNDLED],
    ]);
    expect(runtime.runtimeFallback()).toEqual({ from: PATH_CLI, to: BUNDLED, reason: NEWER_CLI, cliProtocol: 4, sdkProtocols: { min: 3, max: 3 }, version: "1.0.98" });
    // The running client is the bundled one: stopping stops that one.
    await runtime.stop();
    expect(clients.get(BUNDLED)!.stop).toHaveBeenCalledTimes(1);
    expect(runtime.runtimeFallback()).toBeUndefined();
  });

  it("uses the CLI on PATH, and says nothing, when its protocol matches", async () => {
    const { runtime, factory } = runtimeWith(async () => {});
    await runtime.start();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]![1]).toBe(PATH_CLI);
    expect(runtime.runtimeFallback()).toBeUndefined();
    await runtime.stop();
  });

  it("tries the CLI on PATH again on the next start", async () => {
    let speaks = 4;
    const { runtime, factory } = runtimeWith(async () => {
      if (speaks !== 3) throw new Error(NEWER_CLI);
    });
    await runtime.start();
    expect(runtime.runtimeFallback()?.to).toBe(BUNDLED);
    await runtime.stop();
    speaks = 3;
    await runtime.start();
    expect(factory.mock.calls.map(([, cliPath]) => cliPath)).toEqual([PATH_CLI, BUNDLED, PATH_CLI]);
    expect(runtime.runtimeFallback()).toBeUndefined();
    await runtime.stop();
  });

  it("doesn't fall back for other startup failures", async () => {
    const { runtime, factory } = runtimeWith(async () => {
      throw new Error("Copilot CLI isn't signed in");
    });
    await expect(runtime.start()).rejects.toThrow("Copilot CLI isn't signed in");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("can't fall back when there's no bundled runtime, or the mismatched runtime is the bundled one", async () => {
    const none = runtimeWith(
      async () => {
        throw new Error(NEWER_CLI);
      },
      undefined,
      { cli: PATH_CLI },
    );
    await expect(none.runtime.start()).rejects.toThrow(/protocol version mismatch/);
    expect(none.factory).toHaveBeenCalledTimes(1);

    const same = runtimeWith(
      async () => {
        throw new Error(NEWER_CLI);
      },
      undefined,
      { cli: BUNDLED.toUpperCase(), bundled: BUNDLED },
    );
    await expect(same.runtime.start()).rejects.toThrow(/protocol version mismatch/);
    expect(same.factory).toHaveBeenCalledTimes(1);
  });

  it("says both went wrong when the bundled runtime doesn't start either", async () => {
    const { runtime } = runtimeWith(
      async () => {
        throw new Error(NEWER_CLI);
      },
      async () => {
        throw new Error("copilot-runtime.exe exited with code 1");
      },
    );
    await expect(runtime.start()).rejects.toThrow(/server reports version 4.*bundled Copilot runtime .*didn't start either: copilot-runtime\.exe exited with code 1/s);
    expect(runtime.runtimeFallback()).toBeUndefined();
  });

  it("starts nothing more when it's stopped during the first handshake", async () => {
    let fail: (error: Error) => void = () => {};
    const { runtime, factory, clients } = runtimeWith(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const starting = runtime.start();
    const stopping = runtime.stop();
    fail(new Error(NEWER_CLI));
    await stopping;
    await expect(starting).rejects.toThrow(/protocol version mismatch/);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(clients.get(PATH_CLI)!.stop).toHaveBeenCalledTimes(1);
  });

  it("shuts down the bundled runtime when it's stopped during the fallback's handshake", async () => {
    let finish: () => void = () => {};
    const { runtime, clients } = runtimeWith(
      async () => {
        throw new Error(NEWER_CLI);
      },
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const starting = runtime.start();
    await vi.waitFor(() => expect(clients.get(BUNDLED)?.start).toHaveBeenCalled());
    const stopping = runtime.stop();
    finish();
    await stopping;
    await expect(starting).rejects.toThrow(/stopped while it was starting/);
    expect(clients.get(BUNDLED)!.stop).toHaveBeenCalledTimes(1);
    expect(runtime.runtimeFallback()).toBeUndefined();
  });

  it("tells you which runtime runs and why", () => {
    const newer = describeRuntimeFallback({ from: PATH_CLI, to: BUNDLED, reason: NEWER_CLI, cliProtocol: 4, sdkProtocols: { min: 3, max: 3 }, version: "1.0.98" });
    expect(newer.text).toBe(
      `The Copilot CLI at ${PATH_CLI} speaks wire protocol 4, but ARIA's Copilot SDK only speaks protocol 3, so ARIA is running on its bundled Copilot runtime 1.0.98 instead. ` +
        "Models and features that need the newer CLI aren't available until ARIA's SDK is updated; then ARIA uses your CLI again.",
    );
    const old = describeRuntimeFallback({ from: PATH_CLI, to: BUNDLED, reason: UNVERSIONED_CLI, sdkProtocols: { min: 3, max: 4 } });
    expect(old.text).toBe(
      `The Copilot CLI at ${PATH_CLI} is too old to report a wire protocol (ARIA's Copilot SDK speaks protocols 3–4), so ARIA is running on its bundled Copilot runtime instead. Update Copilot CLI to have ARIA use it again.`,
    );
    expect(describeRuntimeFallback({ from: PATH_CLI, to: BUNDLED, reason: "SDK protocol version mismatch: SDK supports versions 3-3, but server reports version 2.", cliProtocol: 2, sdkProtocols: { min: 3, max: 3 } }).why).toBe(
      "speaks wire protocol 2, older than the protocol 3 ARIA's Copilot SDK speaks",
    );
  });
});

describe("CopilotRuntime Gemini models support", () => {
  it("finds the copilot CLI executable on PATH", () => {
    const cli = findCopilotCli({ PATH: "C:\\Windows\\System32;\"C:\\Tools\"" }, (file) => file === "C:\\Tools\\copilot.exe", "win32");
    expect(cli).toBe("C:\\Tools\\copilot.exe");
  });

  it("finds copilot from custom COPILOT_CLI_PATH", () => {
    const cli = findCopilotCli({ COPILOT_CLI_PATH: "C:\\custom\\copilot.exe" }, () => true);
    expect(cli).toBe("C:\\custom\\copilot.exe");
  });

  it("falls back to the unpacked Electron SDK runtime in resources/app.asar.unpacked when PATH has no copilot", () => {
    const unpackedPath =
      "C:\\Program Files\\ARIA\\resources\\app.asar.unpacked\\node_modules\\@github/copilot-sdk-win32-x64\\prebuilds\\win32-x64\\copilot-runtime.exe";
    const cli = findCopilotCli(
      { PATH: "C:\\Windows\\System32" },
      (file) => file.replace(/\//g, "\\") === unpackedPath.replace(/\//g, "\\"),
      "win32",
      "C:\\Program Files\\ARIA\\resources",
      "x64",
    );
    expect(cli?.replace(/\//g, "\\")).toBe(unpackedPath.replace(/\//g, "\\"));
  });

  it("lists Gemini models from catalog alongside server models", async () => {
    const mockClient = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => []),
      forceStop: vi.fn(async () => {}),
      listModels: vi.fn(async () => [
        { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", supportedReasoningEfforts: ["low", "medium", "high"] },
      ]),
      rpc: {
        models: {
          list: vi.fn(async () => ({ models: [{ id: "claude-sonnet-5.5", modelPickerCategory: "versatile" }] })),
          getBuiltInCatalog: vi.fn(async () => ({
            models: [{ id: "claude-sonnet-5.5" }, { id: "gemini-3.8-flash" }, { id: "gemini-4-argon" }],
          })),
        },
      },
    };
    const runtime = new CopilotRuntime(() => mockClient as unknown as CopilotClient);
    await runtime.start();
    const models = await runtime.listModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain("gemini-3.8-flash");
    expect(ids).toContain("gemini-4-argon");
    expect(ids).toContain("claude-sonnet-5.5");

    const geminiFlash = models.find((m) => m.id === "gemini-3.8-flash")!;
    expect(geminiFlash.name).toBe("Gemini 3.8 Flash");
    expect(geminiFlash.category).toBe("lightweight");
    expect(geminiFlash.efforts).toEqual(["low", "medium", "high"]);

    const geminiArgon = models.find((m) => m.id === "gemini-4-argon")!;
    expect(geminiArgon.name).toBe("Gemini 4 Argon");
    expect(geminiArgon.category).toBe("powerful");
    expect(geminiArgon.efforts).toEqual(["low", "medium", "high"]);

    await runtime.stop();
  });
});

