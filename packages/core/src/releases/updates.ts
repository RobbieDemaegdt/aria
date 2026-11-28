/**
 * ARIA's own updates (D80). The check for a newer release runs at start, then every 6 hours, and after a sleep when one
 * is due (ARIA stays in the tray for days), unless you turned it off; Check now works either way. Update now downloads
 * the release's installer and checks it (download.ts), then hands it to the shell, which quits ARIA and starts the
 * installer. Update when they're done downloads and checks it the same way, then waits until no task is in progress.
 */
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { AvailableUpdateInfo, EngineEvent, UpdateCheckResult, UpdateStatus } from "@aria/protocol";
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
  /** Whether the check runs by itself (Check for updates automatically; default: it does). */
  autoCheck?(): boolean;
  /** The tasks a restart would stop, and those queued: Update when they're done waits until there are none. */
  busyTasks?(): number;
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
  private checking: Promise<UpdateCheckResult> | undefined;
  private cleaning: Promise<void> = Promise.resolve();
  private download: AbortController | undefined;
  /** Downloaded and checked, it waits for the tasks (Update when they're done). */
  private ready: { file: string; update: InstallableUpdate } | undefined;
  private started = false;
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

  /** At start: the installers a past update left are deleted, and the first check runs (unless it's turned off). */
  start(): void {
    this.started = true;
    const installer = this.deps.installer;
    if (installer) this.cleaning = this.cleanUp(installer.dir);
    if (this.autoCheck()) void this.checkNow();
  }

  /** The PC woke up: a check that came due while it slept runs now. */
  wake(): void {
    if (!this.started || this.stopped || !this.autoCheck()) return;
    if (this.due()) void this.checkNow();
  }

  /** Check for updates automatically was turned on or off. */
  autoCheckChanged(): void {
    if (!this.started || this.stopped) return;
    if (!this.autoCheck()) {
      this.clearTimer();
      return;
    }
    if (this.checking || this.timer !== undefined) return;
    if (this.due()) void this.checkNow();
    else this.schedule(UPDATE_CHECK_INTERVAL_MS - (this.deps.clock.now() - (this.lastCheckAt ?? 0)));
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.download?.abort();
    this.ready = undefined;
  }

  /**
   * Reads GitHub's latest release now (Check now, and each check on the timer). One runs at a time, and the next
   * automatic one comes 6 hours after it.
   */
  checkNow(): Promise<UpdateCheckResult> {
    if (this.checking) return this.checking;
    this.clearTimer();
    this.checking = this.check().finally(() => {
      this.checking = undefined;
      if (this.autoCheck()) this.schedule();
    });
    return this.checking;
  }

  /**
   * Update now: starts the download of the available update's installer and returns. Its progress, and why it failed
   * if it does, come as `update_status`. Nothing happens while one is already on its way. `whenIdle`: once checked,
   * the installer waits until no task is in progress. While one waits, a call without it installs at once.
   */
  install(options: { whenIdle?: boolean } = {}): void {
    const installer = this.deps.installer;
    if (!installer) throw new Error("This build of ARIA can't install updates. Download the installer instead.");
    if (this.stopped) return;
    if (this.status.phase === "waiting") {
      if (!options.whenIdle) this.launchReady();
      return;
    }
    if (this.status.phase === "downloading" || this.status.phase === "installing") return;
    const update = this.available;
    if (!update) throw new Error("There is no update to install.");
    if (!isInstallable(update, this.deps.appVersion)) {
      const reason = installProblem(update, this.deps.appVersion) ?? "ARIA can't install this update.";
      this.setStatus({ phase: "failed", version: update.version, reason });
      return;
    }
    void this.runInstall(installer, update, options.whenIdle === true);
  }

  /** Cancel, while the installer waits for the tasks: it's deleted, and the bar is back to Update now and Later. */
  cancel(): void {
    if (this.status.phase !== "waiting") return;
    const ready = this.ready;
    this.ready = undefined;
    this.setStatus({ phase: "idle" });
    if (ready) void rm(ready.file, { force: true }).catch(ignoreCleanupFailure);
  }

  /** A task moved on: an installer that waits for the tasks starts once none is in progress or queued. */
  tasksChanged(): void {
    if (this.status.phase !== "waiting" || this.stopped || this.busy() > 0) return;
    // Not inside the task's own event: starting the installer quits ARIA.
    queueMicrotask(() => {
      if (this.status.phase === "waiting" && this.busy() === 0) this.launchReady();
    });
  }

  private autoCheck(): boolean {
    return this.deps.checkFetch !== undefined && (this.deps.autoCheck?.() ?? true);
  }

  private due(): boolean {
    return this.lastCheckAt === undefined || this.deps.clock.now() - this.lastCheckAt >= UPDATE_CHECK_INTERVAL_MS;
  }

  private busy(): number {
    return this.deps.busyTasks?.() ?? 0;
  }

  /**
   * When what GitHub says differs from what ARIA knew (a newer release, new notes, or none any more),
   * `available_update` says so. A failed request changes nothing, and the result says why.
   */
  private async check(): Promise<UpdateCheckResult> {
    const fetchFn = this.deps.checkFetch;
    if (!fetchFn) return { status: "failed", reason: "This build of ARIA doesn't check for updates." };
    if (this.stopped) return { status: "failed", reason: "ARIA is stopping." };
    this.lastCheckAt = this.deps.clock.now();
    let raw: unknown;
    try {
      const response = await fetchFn(ARIA_LATEST_RELEASE_URL, {
        method: "GET",
        headers: { accept: "application/vnd.github+json", "user-agent": "ARIA" },
        cache: "no-store",
        credentials: "omit",
      });
      if (!response.ok) {
        await response.body?.cancel().catch(ignoreCleanupFailure);
        return { status: "failed", reason: `GitHub answered ${response.status}. Try again later.` };
      }
      raw = (await response.json()) as unknown;
    } catch (error) {
      this.deps.logFailure("Checking for ARIA updates")(error);
      return { status: "failed", reason: "ARIA couldn't reach GitHub. Check your connection and try again." };
    }
    if (this.stopped) return { status: "failed", reason: "ARIA is stopping." };
    const found = parseLatestGitHubRelease(raw, this.deps.appVersion) ?? undefined;
    if (JSON.stringify(found) !== JSON.stringify(this.available)) {
      this.available = found;
      this.deps.emit({ type: "available_update", availableUpdate: found ?? null });
    }
    return found ? { status: "available", update: found } : { status: "latest" };
  }

  private async runInstall(installer: UpdateInstaller, update: InstallableUpdate, whenIdle: boolean): Promise<void> {
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
      this.ready = { file, update };
      if (whenIdle && this.busy() > 0) this.setStatus({ phase: "waiting", version });
      else this.launchReady();
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

  /** The checked installer goes to the shell, which quits ARIA and starts it. */
  private launchReady(): void {
    const ready = this.ready;
    const installer = this.deps.installer;
    if (!ready || !installer || this.stopped) return;
    this.ready = undefined;
    const { version } = ready.update;
    this.setStatus({ phase: "installing", version });
    try {
      installer.launch(ready.file);
    } catch (error) {
      this.deps.logFailure(`Starting the ARIA v${version} installer`)(error);
      this.setStatus({ phase: "failed", version, reason: "ARIA couldn't start the installer." });
    }
  }

  private setStatus(status: UpdateStatus): void {
    this.status = status;
    this.deps.emit({ type: "update_status", updateStatus: status });
  }

  /** `ms`: how long until the next check (default 6 hours, give or take the jitter). */
  private schedule(ms?: number): void {
    if (this.stopped || !this.autoCheck()) return;
    this.clearTimer();
    let wait = ms ?? UPDATE_CHECK_INTERVAL_MS;
    const jitter = this.deps.jitter ?? 0.1;
    if (ms === undefined && jitter > 0) wait = Math.round(wait * (1 + (Math.random() * 2 - 1) * jitter));
    this.timer = this.deps.clock.setTimeout(() => {
      this.timer = undefined;
      void this.checkNow();
    }, Math.max(0, wait));
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
