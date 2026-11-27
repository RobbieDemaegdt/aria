import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CardItem, ChatItem, ReleaseNoteEntry } from "@aria/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyCliSource,
  compareSemver,
  formatDoctorMarkdown,
  AriaEngine,
  parseLatestGitHubRelease,
  parseSemver,
  releasesSince,
  resolveOnboardingStartup,
  runDoctor,
  type EngineOptions,
} from "../src/index.ts";
import { FakeRuntime } from "../src/runtime/fake.ts";
import { acmeTracker } from "./helpers/acme.ts";
import { commitFile, makeRepo } from "./helpers.ts";

const temps: string[] = [];
const engines: AriaEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.stop()));
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const SAMPLE_RELEASES: readonly ReleaseNoteEntry[] = [
  {
    version: "0.3.0",
    date: "2026-12-01",
    headline: "ARIA 0.3 — Voice & Cloud",
    features: [{ title: "Cloud sessions", description: "Run on Mission Control" }],
    fixes: ["Fixed cloud reconnect"],
  },
  {
    version: "0.2.0",
    date: "2026-11-15",
    headline: "ARIA 0.2 — Native MCP",
    features: [{ title: "Direct MCP client", description: "Zero-model writes" }],
    fixes: ["Improved batch error display"],
  },
  {
    version: "0.1.0",
    date: "2026-11-04",
    headline: "ARIA 0.1 — Initial Release",
    features: [{ title: "Single chat", description: "Background worktrees" }],
    fixes: [],
  },
];

describe("Release version comparison and onboarding startup resolution", () => {
  it("parses and compares semantic versions accurately", () => {
    expect(parseSemver("0.1.0")).toEqual([0, 1, 0]);
    expect(parseSemver("v1.2.3-beta.1")).toEqual([1, 2, 3]);
    expect(parseSemver("invalid")).toBeNull();

    expect(compareSemver("0.2.0", "0.1.0")).toBeGreaterThan(0);
    expect(compareSemver("0.1.0", "0.1.0")).toBe(0);
    expect(compareSemver("0.1.9", "0.2.0")).toBeLessThan(0);
  });

  it("collects release notes between lastSeenVersion and currentVersion newest first", () => {
    const notes = releasesSince("0.1.0", "0.3.0", SAMPLE_RELEASES);
    expect(notes.map((n) => n.version)).toEqual(["0.3.0", "0.2.0"]);
    expect(releasesSince("0.3.0", "0.3.0", SAMPLE_RELEASES)).toEqual([]);
    expect(releasesSince(undefined, "0.3.0", SAMPLE_RELEASES)).toEqual([]);
  });

  it("distinguishes fresh install from version upgrade in resolveOnboardingStartup", () => {
    // 1. Fresh install: marks lastSeenVersion without emitting whatsNewReleases
    const first = resolveOnboardingStartup(undefined, "0.1.0", 1_000, SAMPLE_RELEASES);
    expect(first.isFirstRun).toBe(true);
    expect(first.changed).toBe(true);
    expect(first.whatsNewReleases).toHaveLength(0);
    expect(first.state.lastSeenVersion).toBe("0.1.0");
    expect(first.state.setupCompleted).toBe(false);

    // 2. Same version reopen: no change, no whatsNewReleases
    const same = resolveOnboardingStartup(first.state, "0.1.0", 2_000, SAMPLE_RELEASES);
    expect(same.isFirstRun).toBe(false);
    expect(same.changed).toBe(false);
    expect(same.whatsNewReleases).toHaveLength(0);

    // 3. Upgrade 0.1.0 -> 0.3.0: emits 0.3.0 and 0.2.0 release notes and updates lastSeenVersion
    const upgraded = resolveOnboardingStartup(
      { ...first.state, setupCompleted: true, tourCompleted: true },
      "0.3.0",
      3_000,
      SAMPLE_RELEASES,
    );
    expect(upgraded.isFirstRun).toBe(false);
    expect(upgraded.changed).toBe(true);
    expect(upgraded.previousVersion).toBe("0.1.0");
    expect(upgraded.state.lastSeenVersion).toBe("0.3.0");
    expect(upgraded.state.dismissedWhatsNewVersion).toBe("0.1.0");
    expect(upgraded.state.setupCompleted).toBe(true);
    expect(upgraded.whatsNewReleases.map((r) => r.version)).toEqual(["0.3.0", "0.2.0"]);
  });

  it("parses latest GitHub release and detects when a newer version is available", () => {
    expect(
      parseLatestGitHubRelease(
        {
          tag_name: "v0.1.0",
          name: "ARIA v0.1.0",
          html_url: "https://github.com/RobbieDemaegdt/aria/releases/tag/v0.1.0",
        },
        "0.1.0",
      ),
    ).toBeNull();

    const available = parseLatestGitHubRelease(
      {
        tag_name: "v0.2.0",
        name: "ARIA v0.2.0 — Update Popup",
        body: "Added startup update popup and sidebar project removal.",
        html_url: "https://github.com/RobbieDemaegdt/aria/releases/tag/v0.2.0",
        assets: [
          {
            name: "ARIA-Setup-0.2.0.exe",
            browser_download_url:
              "https://github.com/RobbieDemaegdt/aria/releases/download/v0.2.0/ARIA-Setup-0.2.0.exe",
          },
        ],
      },
      "0.1.0",
    );
    expect(available).toEqual({
      version: "0.2.0",
      tagName: "v0.2.0",
      headline: "ARIA v0.2.0 — Update Popup",
      notes: "Added startup update popup and sidebar project removal.",
      releaseUrl: "https://github.com/RobbieDemaegdt/aria/releases/tag/v0.2.0",
      installerName: "ARIA-Setup-0.2.0.exe",
      installerUrl:
        "https://github.com/RobbieDemaegdt/aria/releases/download/v0.2.0/ARIA-Setup-0.2.0.exe",
    });
  });
});

describe("Copilot CLI & System Doctor (runDoctor)", () => {
  it("reports all checks ok when Copilot CLI, runtime, worktrees, sandbox, GitHub CLI and MCP servers are ready", async () => {
    const cliExe = "C:\\Program Files\\GitHub Copilot\\copilot.exe";
    const ghExe = "C:\\Program Files\\GitHub CLI\\gh.exe";
    const report = await runDoctor({
      tracker: () => acmeTracker,
      now: () => 5_000,
      env: { PATH: "C:\\Program Files\\GitHub Copilot;C:\\Program Files\\GitHub CLI" },
      exists: (f) => f === cliExe || f === ghExe,
      platform: "win32",
      status: () => ({ state: "ready", model: "claude-haiku-5.5", reasoningEffort: "low" }),
      conductorSettings: () => ({ model: "claude-haiku-5.5", reasoningEffort: "low" }),
      models: () => [{ id: "claude-haiku-5.5", name: "Claude Haiku 5.5", efforts: ["low", "medium"], enabled: true }],
      runtimeAlive: async () => true,
      worktreeRoot: () => ({ path: "C:\\wt" }),
      projectsCount: () => 3,
      sandbox: () => ({ supported: true, enabled: true, allowedHosts: ["registry.npmjs.org"], allowedPaths: [] }),
      github: () => ({ status: "ok", login: "sam", inbox: true }),
      integrations: () => ({
        servers: [
          { name: "Acme", status: "connected", seen: true, lastSeen: 5_000, toolCount: 56, github: false },
        ],
        tools: [
          {
            server: "Acme",
            tool: "list_my_issues",
            wireName: "Acme-list_my_issues",
            cls: "read",
            github: false,
            seen: true,
            lastSeen: 5_000,
            rules: {
              aria: { effect: "auto", isDefault: true, allowed: ["auto", "ask", "never"] },
              tasks: { effect: "never", isDefault: true, allowed: ["auto", "ask", "never"] },
            },
          },
        ],
        runtimeUp: true,
        refreshing: false,
      }),
      logDir: "C:\\Users\\sam\\AppData\\Roaming\\ARIA\\logs",
    });

    expect(report.overallStatus).toBe("ok");
    expect(report.cliPath).toBe(cliExe);
    expect(report.cliSource).toBe("path");
    expect(report.checks.every((c) => c.status === "ok")).toBe(true);

    const md = formatDoctorMarkdown(report);
    expect(md).toContain("All required checks passed");
    expect(md).toContain("Signed in as @sam");
  });

  it("diagnoses missing or signed-out Copilot CLI, stripped env tokens, needs-auth MCP servers, and missing GitHub CLI", async () => {
    const unpackedExe =
      "C:\\App\\resources\\app.asar.unpacked\\node_modules\\@github\\copilot-sdk-win32-x64\\prebuilds\\win32-x64\\copilot-runtime.exe";
    expect(classifyCliSource(unpackedExe, {})).toBe("bundled");

    const report = await runDoctor({
      tracker: () => acmeTracker,
      now: () => 9_000,
      env: { PATH: "C:\\Windows\\System32", GH_TOKEN: "ghp_secret123", COPILOT_GITHUB_TOKEN: "ghu_secret456" },
      exists: () => false,
      platform: "win32",
      status: () => ({ state: "error", detail: "Copilot CLI isn't signed in." }),
      conductorSettings: () => ({}),
      models: () => [],
      runtimeAlive: async () => false,
      worktreeRoot: () => ({ path: "C:\\wt" }),
      projectsCount: () => 0,
      sandbox: () => ({ supported: true, enabled: false, allowedHosts: [], allowedPaths: [] }),
      github: () => ({ status: "no_cli", inbox: false }),
      integrations: () => ({
        servers: [
          {
            name: "Work IQ Mail",
            status: "needs-auth",
            seen: true,
            lastSeen: 9_000,
            toolCount: 0,
            github: false,
          },
        ],
        tools: [],
        runtimeUp: false,
        refreshing: false,
      }),
    });

    expect(report.overallStatus).toBe("error");
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.copilot_cli?.status).toBe("error");
    expect(byId.copilot_runtime?.status).toBe("error");
    expect(byId.copilot_runtime?.action).toBe("open_copilot_login");
    expect(byId.environment?.status).toBe("info");
    expect(byId.environment?.summary).toContain("GH_TOKEN");
    expect(byId.git_worktree?.status).toBe("warning");
    expect(byId.sandbox?.status).toBe("warning");
    expect(byId.github_cli?.status).toBe("warning");
    expect(byId.mcp_integrations?.status).toBe("warning");
    expect(byId.mcp_integrations?.summary).toContain("Work IQ Mail");
  });
});

describe("AriaEngine onboarding, What's New card on update, and /doctor, /setup, /tour, /whats-new slash commands", () => {
  function setup(options: Partial<EngineOptions> = {}) {
    const base = mkdtempSync(path.join(os.tmpdir(), "aria-onboard-"));
    temps.push(base);
    const projects = path.join(base, "GitHub");
    const moonrisePath = makeRepo(projects, "Moonrise");
    commitFile(moonrisePath, "README.md", "# Moonrise\n", "Initial commit");
    const runtime = new FakeRuntime();
    const make = (overrides: Partial<EngineOptions> = {}) => {
      const engine = new AriaEngine({
        dataDir: path.join(base, "data"),
        runtime,
        projectRoots: [projects],
        resumeSettleMs: 10,
        worktreeRoot: path.join(base, "wt"),
        releases: SAMPLE_RELEASES,
        ...options,
        ...overrides,
      });
      engines.push(engine);
      return engine;
    };
    return { base, runtime, make };
  }

  it("records lastSeenVersion on first install, emits a whats_new card when updated to a newer version, and runs onboarding slash commands", async () => {
    const { make, runtime } = setup({ appVersion: "0.1.0" });

    // 1. First install on v0.1.0: no whats_new card emitted
    const engine1 = make({ appVersion: "0.1.0" });
    await engine1.start();

    expect(engine1.getState().appVersion).toBe("0.1.0");
    expect(engine1.getState().onboarding?.lastSeenVersion).toBe("0.1.0");
    expect(engine1.getState().onboarding?.setupCompleted).toBe(false);
    expect(
      engine1.getState().timeline.some((i) => i.kind === "card" && i.cardType === "whats_new"),
    ).toBe(false);

    // Complete setup & tour
    const updatedOnboarding = engine1.setOnboardingState({ setupCompleted: true, tourCompleted: true });
    expect(updatedOnboarding.setupCompleted).toBe(true);
    expect(updatedOnboarding.tourCompleted).toBe(true);
    await engine1.stop();

    // 2. Upgrade to v0.2.0: emits a whats_new card for 0.2.0 and preserves setupCompleted
    const engine2 = make({ appVersion: "0.2.0" });
    await engine2.start();

    const state2 = engine2.getState();
    expect(state2.onboarding?.lastSeenVersion).toBe("0.2.0");
    expect(state2.onboarding?.setupCompleted).toBe(true);
    const whatsNewCards = state2.timeline.filter(
      (i): i is Extract<CardItem, { cardType: "whats_new" }> => i.kind === "card" && i.cardType === "whats_new",
    );
    expect(whatsNewCards).toHaveLength(1);
    expect(whatsNewCards[0]!.payload.fromVersion).toBe("0.1.0");
    expect(whatsNewCards[0]!.payload.toVersion).toBe("0.2.0");
    expect(whatsNewCards[0]!.payload.releases.map((r) => r.version)).toEqual(["0.2.0"]);

    // 3. Deterministic slash commands (/doctor, /setup, /tour, /whats-new) make zero model calls
    const conductor = [...runtime.sessions.values()].at(-1)!;
    const promptsBefore = conductor.prompts.length;

    await engine2.sendMessage("/doctor");
    await engine2.sendMessage("/setup");
    await engine2.sendMessage("/tour");
    await engine2.sendMessage("/whats-new");

    expect(conductor.prompts).toHaveLength(promptsBefore);
    const assistantReplies = engine2
      .getState()
      .timeline.filter((i): i is ChatItem => i.kind === "chat" && i.role === "assistant")
      .map((i) => i.content);

    expect(assistantReplies.some((r) => r.includes("System & Copilot CLI Doctor"))).toBe(true);
    expect(assistantReplies.some((r) => r.includes("Getting Started & Setup Checklist"))).toBe(true);
    expect(assistantReplies.some((r) => r.includes("ARIA GUI Tour"))).toBe(true);
    expect(assistantReplies.some((r) => r.includes("What's new in ARIA v0.3.0"))).toBe(true);
  });
});
