/**
 * ARIA's own updates (D80). The check for a newer release runs at start, then every 6 hours, and after a sleep when one
 * is due (ARIA stays in the tray for days). Update now downloads the release's installer and checks it
 * (download.ts), then hands it to the shell, which quits ARIA and starts the installer.
 */
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { AvailableUpdateInfo, EngineEvent, UpdateStatus } from "@aria/protocol";
import type { Clock } from "../attention/clock.ts";
import type { FetchLike } from "../github/fetch.ts";
import { ignoreCleanupFailure } from "../util/ignore.ts";
import { DownloadError, downloadInstaller, installProblem, isInstallable, type InstallableUpdate } from "./download.ts";
import { ARIA_LATEST_RELEASE_URL, parseLatestGitHubRelease } from "./releases.ts";

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** How long Later hides the update bar. */
export const UPDATE_SNOOZE_MS = 24 * 60 * 60 * 1000;

/** From the shell, in an installed build only: where installers are downloaded to, and how one is started. */
export interface UpdateInstaller {
  fetch: FetchLike;
  /** ARIA's own download folder: the installers left in it are deleted at start. */
  dir: string;
  /** The installer is downloaded and checked: quit ARIA and start it. */
  launch(file: string): void;
}

export interface AppUpdatesDeps {
  appVersion: string;
  clock: Clock;
  /** No fetch, no check (tests, and a development switch). */
  checkFetch?: FetchLike;
  installer?: UpdateInstaller;
  /** How much the interval varies (default 10%). */
  jitter?: number;
  emit(event: EngineEvent): void;
  logFailure(step: string): (error: unknown) => void;
}

/** An installer, or what's left of one, that ARIA downloaded. */
const DOWNLOADED = /^ARIA-Setup-[0-9A-Za-z.-]+\.exe(?:\.partial)?$/;

export class AppUpdates {
  private available: AvailableUpdateInfo | undefined;
  private status: UpdateStatus = { phase: "idle" };
  private timer: unknown;
  private lastCheckAt: number | undefined;
  private checking: Promise<void> | undefined;
  private cleaning: Promise<void> = Promise.resolve();
  private download: AbortController | undefined;
  private stopped = false;

  constructor(private readonly deps: AppUpdatesDeps) {}

  get canInstall(): boolean {
    return this.deps.installer !== undefined;
  }

  availableUpdate(): AvailableUpdateInfo | undefined {
    return this.available;
  }

  updateStatus(): UpdateStatus {
    return this.status;
  }

  /** At start: the installers a past update left are deleted, and the first check runs. */
  start(): void {
    const installer = this.deps.installer;
    if (installer) this.cleaning = this.cleanUp(installer.dir);
    if (this.deps.checkFetch) void this.checkNow();
  }

  /** The PC woke up: a check that came due while it slept runs now. */
  wake(): void {
    if (!this.deps.checkFetch || this.stopped) return;
    if (this.lastCheckAt === undefined || this.deps.clock.now() - this.lastCheckAt >= UPDATE_CHECK_INTERVAL_MS) void this.checkNow();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.download?.abort();
  }

  /**
   * Reads GitHub's latest release. When what it says differs from what ARIA knew (a newer release, new notes, or none
   * any more), `available_update` says so. A failed request changes nothing.
   */
  async check(): Promise<AvailableUpdateInfo | null> {
    const fetchFn = this.deps.checkFetch;
    if (!fetchFn || this.stopped) return null;
    this.lastCheckAt = this.deps.clock.now();
    const response = await fetchFn(ARIA_LATEST_RELEASE_URL, {
      method: "GET",
      headers: { accept: "application/vnd.github+json", "user-agent": "ARIA" },
      cache: "no-store",
      credentials: "omit",
    });
    if (!response.ok || this.stopped) {
      await response.body?.cancel().catch(ignoreCleanupFailure);
      return null;
    }
    const raw = (await response.json()) as unknown;
    if (this.stopped) return null;
    const found = parseLatestGitHubRelease(raw, this.deps.appVersion) ?? undefined;
    if (JSON.stringify(found) !== JSON.stringify(this.available)) {
      this.available = found;
      this.deps.emit({ type: "available_update", availableUpdate: found ?? null });
    }
    return found ?? null;
  }

  /**
   * Update now: starts the download of the available update's installer and returns. Its progress, and why it failed
   * if it does, come as `update_status`. Nothing happens while one is already on its way.
   */
  install(): void {
    const installer = this.deps.installer;
    if (!installer) throw new Error("This build of ARIA can't install updates. Download the installer instead.");
    if (this.stopped || this.status.phase === "downloading" || this.status.phase === "installing") return;
    const update = this.available;
    if (!update) throw new Error("There is no update to install.");
    if (!isInstallable(update, this.deps.appVersion)) {
      const reason = installProblem(update, this.deps.appVersion) ?? "ARIA can't install this update.";
      this.setStatus({ phase: "failed", version: update.version, reason });
      return;
    }
    void this.runInstall(installer, update);
  }

  private async runInstall(installer: UpdateInstaller, update: InstallableUpdate): Promise<void> {
    const controller = new AbortController();
    this.download = controller;
    const { version } = update;
    let shown = 0;
    this.setStatus({ phase: "downloading", version, received: 0, total: update.installerSize });
    try {
      await this.cleaning;
      const file = await downloadInstaller({
        fetch: installer.fetch,
        update,
        dir: installer.dir,
        signal: controller.signal,
        onProgress: (received, total) => {
          // One event per percent, not one per chunk.
          const percent = Math.floor((received / total) * 100);
          if (percent === shown) return;
          shown = percent;
          this.setStatus({ phase: "downloading", version, received, total });
        },
      });
      if (this.stopped) return;
      // Once more, right before it runs: never a version that isn't newer.
      const problem = installProblem(update, this.deps.appVersion);
      if (problem) throw new DownloadError(problem);
      this.setStatus({ phase: "installing", version });
      installer.launch(file);
    } catch (error) {
      if (this.stopped) return;
      this.deps.logFailure(`Downloading the ARIA v${version} update`)(error);
      const reason =
        error instanceof DownloadError ? error.message : "The download failed. Check your connection and try again.";
      this.setStatus({ phase: "failed", version, reason });
    } finally {
      if (this.download === controller) this.download = undefined;
    }
  }

  private setStatus(status: UpdateStatus): void {
    this.status = status;
    this.deps.emit({ type: "update_status", updateStatus: status });
  }

  /** One check at a time; the next is scheduled when it ends, however it ended. */
  private checkNow(): Promise<void> {
    if (this.checking) return this.checking;
    this.clearTimer();
    this.checking = this.check()
      .then(
        () => undefined,
        (error: unknown) => this.deps.logFailure("Checking for ARIA updates")(error),
      )
      .finally(() => {
        this.checking = undefined;
        this.schedule();
      });
    return this.checking;
  }

  private schedule(): void {
    if (this.stopped || !this.deps.checkFetch) return;
    const jitter = this.deps.jitter ?? 0.1;
    let ms = UPDATE_CHECK_INTERVAL_MS;
    if (jitter > 0) ms = Math.round(ms * (1 + (Math.random() * 2 - 1) * jitter));
    this.timer = this.deps.clock.setTimeout(() => {
      this.timer = undefined;
      void this.checkNow();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    this.deps.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * Deletes the installers ARIA downloaded, and only those: right after an update the one that ran may still be
   * finishing, so one that can't go yet is left for the next start.
   */
  private async cleanUp(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (DOWNLOADED.test(name)) await rm(path.join(dir, name), { force: true }).catch(ignoreCleanupFailure);
    }
  }
}
