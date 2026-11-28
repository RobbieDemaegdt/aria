/**
 * Update now or later (D80): the installer a release names, its download (redirects, size, checksum), the check at
 * start and every 6 hours, Later, and the hand-over of the checked installer to the shell. Nothing reaches the
 * network: every fetch here is a fake.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AvailableUpdateInfo, EngineEvent, UpdateStatus } from "@aria/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  AppUpdates,
  ARIA_LATEST_RELEASE_URL,
  AriaEngine,
  DownloadError,
  downloadInstaller,
  installProblem,
  ManualClock,
  parseLatestGitHubRelease,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_SNOOZE_MS,
  type FetchLike,
  type InstallableUpdate,
} from "../src/index.ts";
import { FakeRuntime } from "../src/runtime/fake.ts";
import { commitFile, makeRepo } from "./helpers.ts";

const temps: string[] = [];
const engines: AriaEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.stop()));
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aria-update-"));
  temps.push(dir);
  return dir;
};

const BYTES = new TextEncoder().encode("not a real installer\n".repeat(5000));
const SHA = createHash("sha256").update(BYTES).digest("hex");
const ASSET_URL = "https://github.com/RobbieDemaegdt/aria/releases/download/v0.2.0/ARIA-Setup-0.2.0.exe";
const CDN_URL = "https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sig=x";

const release = (over: Record<string, unknown> = {}, asset: Record<string, unknown> = {}) => ({
  tag_name: "v0.2.0",
  name: "ARIA v0.2.0",
  body: "Notes.",
  html_url: "https://github.com/RobbieDemaegdt/aria/releases/tag/v0.2.0",
  assets: [
    { name: "ARIA-Setup-0.2.0.exe.blockmap", browser_download_url: `${ASSET_URL}.blockmap`, size: 10, digest: `sha256:${"1".repeat(64)}` },
    { name: "ARIA-Setup-0.2.0.exe", browser_download_url: ASSET_URL, size: BYTES.byteLength, digest: `sha256:${SHA.toUpperCase()}`, ...asset },
  ],
  ...over,
});

const installable: InstallableUpdate = {
  version: "0.2.0",
  tagName: "v0.2.0",
  releaseUrl: "https://github.com/RobbieDemaegdt/aria/releases/tag/v0.2.0",
  installerName: "ARIA-Setup-0.2.0.exe",
  installerUrl: ASSET_URL,
  installerSize: BYTES.byteLength,
  installerSha256: SHA,
};

/** GitHub as Update now meets it: the release, a redirect from the asset to its host, then the bytes in pieces. */
function github(options: { bytes?: Uint8Array; length?: string | null; release?: unknown; to?: string; status?: number } = {}) {
  const asked: string[] = [];
  const inits: Array<RequestInit | undefined> = [];
  const fetch: FetchLike = async (input, init) => {
    asked.push(input);
    inits.push(init);
    if (input === ARIA_LATEST_RELEASE_URL) return Response.json(options.release ?? release());
    if (input === ASSET_URL) return new Response(null, { status: 302, headers: { location: options.to ?? CDN_URL } });
    if (input === CDN_URL) {
      if (options.status) return new Response("no", { status: options.status });
      const bytes = options.bytes ?? BYTES;
      let at = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (at >= bytes.byteLength) return controller.close();
          controller.enqueue(bytes.subarray(at, at + 10_000));
          at += 10_000;
        },
      });
      const headers: Record<string, string> = {};
      const length = options.length === undefined ? String(bytes.byteLength) : options.length;
      if (length !== null) headers["content-length"] = length;
      return new Response(body, { headers });
    }
    return new Response(null, { status: 404 });
  };
  return { fetch, asked, inits };
}

describe("the installer a release names (D80)", () => {
  it("takes the exact installer, with its size and its SHA-256 in lowercase", () => {
    expect(parseLatestGitHubRelease(release(), "0.1.0")).toMatchObject({
      version: "0.2.0",
      installerName: "ARIA-Setup-0.2.0.exe",
      installerUrl: ASSET_URL,
      installerSize: BYTES.byteLength,
      installerSha256: SHA,
    });
    expect(installProblem(parseLatestGitHubRelease(release(), "0.1.0")!, "0.1.0")).toBeUndefined();
  });

  it("takes no installer whose name or link isn't the one the release workflow publishes", () => {
    for (const asset of [
      { name: "ARIA-Setup-0.3.0.exe" },
      { name: "aria-setup-0.2.0.exe" },
      { browser_download_url: "https://example.com/RobbieDemaegdt/aria/releases/download/v0.2.0/ARIA-Setup-0.2.0.exe" },
      { browser_download_url: "https://github.com/someone/aria/releases/download/v0.2.0/ARIA-Setup-0.2.0.exe" },
    ]) {
      const found = parseLatestGitHubRelease(release({}, asset), "0.1.0")!;
      expect(found.installerUrl).toBeUndefined();
      expect(installProblem(found, "0.1.0")).toBe("The release has no installer ARIA can download.");
    }
  });

  it("needs a size and a SHA-256 digest for Update now (the Download link stays)", () => {
    const noDigest = parseLatestGitHubRelease(release({}, { digest: undefined }), "0.1.0")!;
    expect(noDigest.installerUrl).toBe(ASSET_URL);
    expect(installProblem(noDigest, "0.1.0")).toBe("The release has no checksum for its installer.");
    const md5 = parseLatestGitHubRelease(release({}, { digest: `md5:${"a".repeat(32)}` }), "0.1.0")!;
    expect(installProblem(md5, "0.1.0")).toBe("The release has no checksum for its installer.");
    const noSize = parseLatestGitHubRelease(release({}, { size: 0 }), "0.1.0")!;
    expect(installProblem(noSize, "0.1.0")).toBe("The release doesn't say how large its installer is.");
  });

  it("never installs a version that isn't newer", () => {
    expect(installProblem(installable, "0.2.0")).toBe("ARIA v0.2.0 isn't newer than this version.");
    expect(installProblem(installable, "0.3.0")).toBe("ARIA v0.2.0 isn't newer than this version.");
    expect(installProblem(undefined, "0.1.0")).toBe("There is no update to install.");
  });
});

describe("the installer's download (D80)", () => {
  it("follows GitHub's redirect, keeps the file only once its size and checksum match, and sends no credentials", async () => {
    const dir = path.join(tempDir(), "ARIA-update");
    const gh = github();
    const progress: number[] = [];
    const file = await downloadInstaller({ fetch: gh.fetch, update: installable, dir, onProgress: (received) => progress.push(received) });
    expect(file).toBe(path.join(dir, "ARIA-Setup-0.2.0.exe"));
    expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(SHA);
    expect(readdirSync(dir)).toEqual(["ARIA-Setup-0.2.0.exe"]);
    expect(gh.asked).toEqual([ASSET_URL, CDN_URL]);
    expect(progress.at(-1)).toBe(BYTES.byteLength);
    for (const init of gh.inits) {
      expect(init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit", cache: "no-store" });
      expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/authorization/i);
    }
  });

  it("deletes a download whose checksum doesn't match", async () => {
    const dir = tempDir();
    const tampered = new Uint8Array(BYTES);
    tampered[0] = 0x21;
    const gh = github({ bytes: tampered });
    await expect(downloadInstaller({ fetch: gh.fetch, update: installable, dir })).rejects.toThrow(
      new DownloadError("The download doesn't match the installer's checksum, so ARIA didn't keep it."),
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("stops at a size that isn't the stated one: announced, larger, or cut short", async () => {
    const dir = tempDir();
    await expect(downloadInstaller({ fetch: github({ length: "12" }).fetch, update: installable, dir })).rejects.toThrow(
      "The download isn't the size GitHub states for the installer.",
    );
    const larger = new Uint8Array(BYTES.byteLength + 1);
    await expect(downloadInstaller({ fetch: github({ bytes: larger, length: null }).fetch, update: installable, dir })).rejects.toThrow(
      "The download is larger than GitHub states for the installer.",
    );
    const short = BYTES.subarray(0, 100);
    await expect(downloadInstaller({ fetch: github({ bytes: short, length: null }).fetch, update: installable, dir })).rejects.toThrow(
      "The download stopped before the end.",
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("goes nowhere but GitHub's download hosts, over https", async () => {
    const dir = tempDir();
    for (const to of ["https://evil.example/ARIA-Setup-0.2.0.exe", "http://release-assets.githubusercontent.com/x", "https://user:pw@github.com/x", "https://github.com:8443/x"]) {
      const gh = github({ to });
      await expect(downloadInstaller({ fetch: gh.fetch, update: installable, dir })).rejects.toThrow(
        "GitHub sent the download to a place ARIA doesn't download from.",
      );
      expect(gh.asked).toEqual([ASSET_URL]);
    }
    const elsewhere = { ...installable, installerUrl: CDN_URL };
    await expect(downloadInstaller({ fetch: github().fetch, update: elsewhere, dir })).rejects.toThrow(DownloadError);
  });

  it("gives up after five redirects, and on an error answer", async () => {
    const dir = tempDir();
    let hops = 0;
    const loop: FetchLike = async () => {
      hops++;
      return new Response(null, { status: 302, headers: { location: ASSET_URL } });
    };
    await expect(downloadInstaller({ fetch: loop, update: installable, dir })).rejects.toThrow("GitHub redirected the download too many times.");
    expect(hops).toBe(6);
    await expect(downloadInstaller({ fetch: github({ status: 403 }).fetch, update: installable, dir })).rejects.toThrow(
      "GitHub answered 403 to the download.",
    );
  });
});

describe("AppUpdates: the check, Update now and the clean-up (D80)", () => {
  function make(options: { fetch?: FetchLike; launch?: (file: string) => void; dir?: string; appVersion?: string } = {}) {
    const clock = new ManualClock(1_000_000);
    const events: EngineEvent[] = [];
    const failures: string[] = [];
    const gh = github();
    const fetch = options.fetch ?? gh.fetch;
    const dir = options.dir ?? path.join(tempDir(), "ARIA-update");
    const launched: string[] = [];
    const updates = new AppUpdates({
      appVersion: options.appVersion ?? "0.1.0",
      clock,
      checkFetch: fetch,
      installer: { fetch, dir, launch: options.launch ?? ((file) => launched.push(file)) },
      jitter: 0,
      emit: (event) => events.push(event),
      logFailure: (step) => (error) => failures.push(`${step}: ${error instanceof Error ? error.message : String(error)}`),
    });
    return { updates, clock, events, failures, gh, launched, dir };
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const statuses = (events: EngineEvent[]): UpdateStatus[] =>
    events.flatMap((e) => (e.type === "update_status" ? [e.updateStatus] : []));
  const checks = (asked: string[]) => asked.filter((url) => url === ARIA_LATEST_RELEASE_URL).length;
  async function until(done: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(done()).toBe(true);
  }

  it("checks at start and every 6 hours, says so only when the release changes, and checks after a sleep once one is due", async () => {
    const { updates, clock, events, gh } = make();
    updates.start();
    await flush();
    await flush();
    expect(checks(gh.asked)).toBe(1);
    expect(events.filter((e) => e.type === "available_update")).toHaveLength(1);
    expect(updates.availableUpdate()?.version).toBe("0.2.0");

    // Woken before a check is due: nothing.
    clock.jump(60_000);
    updates.wake();
    await flush();
    expect(checks(gh.asked)).toBe(1);

    clock.advance(UPDATE_CHECK_INTERVAL_MS);
    await flush();
    await flush();
    expect(checks(gh.asked)).toBe(2);
    // The same release: no second event.
    expect(events.filter((e) => e.type === "available_update")).toHaveLength(1);

    // A sleep: the timer is late, the wake catches up.
    clock.jump(UPDATE_CHECK_INTERVAL_MS + 1);
    updates.wake();
    await flush();
    await flush();
    expect(checks(gh.asked)).toBe(3);
    updates.stop();
  });

  it("forgets the update when GitHub's latest release no longer is newer, but not when a check fails", async () => {
    let answer: () => Response = () => Response.json(release());
    const { updates, events } = make({ fetch: async () => answer() });
    await updates.check();
    expect(updates.availableUpdate()?.version).toBe("0.2.0");
    answer = () => new Response("rate limited", { status: 403 });
    await updates.check();
    expect(updates.availableUpdate()?.version).toBe("0.2.0");
    answer = () => Response.json(release({ tag_name: "v0.1.0" }));
    await updates.check();
    expect(updates.availableUpdate()).toBeUndefined();
    expect(events.filter((e) => e.type === "available_update").map((e) => (e as { availableUpdate: AvailableUpdateInfo | null }).availableUpdate?.version ?? null)).toEqual([
      "0.2.0",
      null,
    ]);
  });

  it("Update now downloads, reports its progress, and hands the checked installer to the shell", async () => {
    const { updates, events, launched, dir } = make();
    await updates.check();
    updates.install();
    await until(() => launched.length === 1);
    expect(launched).toEqual([path.join(dir, "ARIA-Setup-0.2.0.exe")]);
    const seen = statuses(events);
    expect(seen[0]).toEqual({ phase: "downloading", version: "0.2.0", received: 0, total: BYTES.byteLength });
    expect(seen.filter((s) => s.phase === "downloading").length).toBeGreaterThan(2);
    expect(seen.at(-1)).toEqual({ phase: "installing", version: "0.2.0" });
    expect(updates.updateStatus()).toEqual({ phase: "installing", version: "0.2.0" });
    // Once it's installing, another click does nothing.
    updates.install();
    expect(statuses(events)).toHaveLength(seen.length);
  });

  it("says why Update now failed, keeps nothing, and can be tried again", async () => {
    const tampered = new Uint8Array(BYTES);
    tampered[5] = 0x21;
    const bad = github({ bytes: tampered });
    let fetch = bad.fetch;
    const { updates, events, launched, dir, failures } = make({ fetch: (input, init) => fetch(input, init) });
    await updates.check();
    updates.install();
    await until(() => updates.updateStatus().phase === "failed");
    expect(updates.updateStatus()).toEqual({
      phase: "failed",
      version: "0.2.0",
      reason: "The download doesn't match the installer's checksum, so ARIA didn't keep it.",
    });
    expect(launched).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
    expect(failures).toHaveLength(1);

    fetch = github().fetch;
    updates.install();
    await until(() => launched.length === 1);
    expect(statuses(events).at(-1)?.phase).toBe("installing");
  });

  it("says a network failure in plain words, and refuses a release it can't install", async () => {
    const offline: FetchLike = async (input) => {
      if (input === ARIA_LATEST_RELEASE_URL) return Response.json(release());
      throw new Error("net::ERR_INTERNET_DISCONNECTED");
    };
    const first = make({ fetch: offline });
    await first.updates.check();
    first.updates.install();
    await until(() => first.updates.updateStatus().phase === "failed");
    expect(first.updates.updateStatus()).toMatchObject({ reason: "The download failed. Check your connection and try again." });

    const noDigest = make({ fetch: async () => Response.json(release({}, { digest: undefined })) });
    await noDigest.updates.check();
    noDigest.updates.install();
    expect(noDigest.updates.updateStatus()).toEqual({ phase: "failed", version: "0.2.0", reason: "The release has no checksum for its installer." });
  });

  it("throws when there's nothing to install or this build can't install", async () => {
    const { updates } = make();
    expect(() => updates.install()).toThrow("There is no update to install.");
    const devBuild = new AppUpdates({
      appVersion: "0.1.0",
      clock: new ManualClock(),
      emit: () => undefined,
      logFailure: () => () => undefined,
    });
    expect(devBuild.canInstall).toBe(false);
    expect(() => devBuild.install()).toThrow("This build of ARIA can't install updates. Download the installer instead.");
  });

  it("deletes at start only the installers it downloaded", async () => {
    const dir = path.join(tempDir(), "ARIA-update");
    mkdirSync(dir, { recursive: true });
    for (const name of ["ARIA-Setup-0.2.0.exe", "ARIA-Setup-0.3.0.exe.partial", "notes.txt"]) writeFileSync(path.join(dir, name), "x");
    const { updates } = make({ dir, fetch: async () => new Response(null, { status: 500 }) });
    updates.start();
    await until(() => !existsSync(path.join(dir, "ARIA-Setup-0.2.0.exe")) && !existsSync(path.join(dir, "ARIA-Setup-0.3.0.exe.partial")));
    expect(readdirSync(dir)).toEqual(["notes.txt"]);
    updates.stop();
  });
});

describe("AriaEngine: Later and the update in the state (D80)", () => {
  it("puts the update, its status and Later in the state, and Later lasts a day for that version", async () => {
    const base = tempDir();
    const projects = path.join(base, "GitHub");
    commitFile(makeRepo(projects, "Moonrise"), "README.md", "# Moonrise\n", "Initial commit");
    const clock = new ManualClock(5_000_000);
    const gh = github();
    const engine = new AriaEngine({
      dataDir: path.join(base, "data"),
      runtime: new FakeRuntime(),
      projectRoots: [projects],
      resumeSettleMs: 10,
      worktreeRoot: path.join(base, "wt"),
      appVersion: "0.1.0",
      attentionClock: clock,
      watchJitter: 0,
      updateCheckFetch: gh.fetch,
      updateInstaller: { fetch: gh.fetch, dir: path.join(base, "ARIA-update"), launch: () => undefined },
    });
    engines.push(engine);
    expect(engine.snoozeUpdate().updateSnooze).toBeUndefined();
    await engine.start();
    await engine.checkForAppUpdate();

    const state = engine.getState();
    expect(state.availableUpdate?.version).toBe("0.2.0");
    expect(state.updateStatus).toEqual({ phase: "idle" });
    expect(state.canInstallUpdates).toBe(true);

    const snoozed = engine.snoozeUpdate();
    expect(snoozed.updateSnooze).toEqual({ version: "0.2.0", until: 5_000_000 + UPDATE_SNOOZE_MS });
    expect(engine.getState().onboarding?.updateSnooze).toEqual(snoozed.updateSnooze);
  });
});
