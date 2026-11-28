/**
 * Update now's download (D80): one installer, from GitHub's download link for it, written to ARIA's own folder and
 * kept only once it is the size GitHub's API states for it and has the SHA-256 the API states. Redirects are followed
 * here, by hand, and only to GitHub's download hosts; no cookies and no token go with the requests (the release is
 * public). The shell then starts the installer (apps/desktop/src/main/index.ts).
 */
import { createHash } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { AvailableUpdateInfo } from "@aria/protocol";
import type { FetchLike } from "../github/fetch.ts";
import { ignoreCleanupFailure } from "../util/ignore.ts";
import { ARIA_GITHUB_REPO, compareSemver, installerNameFor, installerUrlFor } from "./releases.ts";

/** Where an installer download may go: GitHub, then the hosts it redirects a release asset to. */
export const DOWNLOAD_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
export const MAX_REDIRECTS = 5;
/** Far above an installer's size (about 100 MB): a release that states more is refused. */
export const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;

/** An available update with everything Update now needs. */
export type InstallableUpdate = AvailableUpdateInfo & {
  installerUrl: string;
  installerName: string;
  installerSize: number;
  installerSha256: string;
};

/** A download that went wrong in a way worth saying in the window (the message is for you). */
export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadError";
  }
}

/** Why ARIA can't install `update` itself, or undefined when it can. */
export function installProblem(
  update: AvailableUpdateInfo | undefined,
  currentVersion: string,
  repo = ARIA_GITHUB_REPO,
): string | undefined {
  if (!update) return "There is no update to install.";
  if (compareSemver(update.version, currentVersion) <= 0) return `ARIA v${update.version} isn't newer than this version.`;
  const name = installerNameFor(update.version);
  if (update.installerName !== name || update.installerUrl !== installerUrlFor(update.tagName, name, repo)) {
    return "The release has no installer ARIA can download.";
  }
  if (!update.installerSize || !Number.isSafeInteger(update.installerSize) || update.installerSize <= 0) {
    return "The release doesn't say how large its installer is.";
  }
  if (update.installerSize > MAX_INSTALLER_BYTES) return "The release's installer is larger than ARIA downloads.";
  if (!update.installerSha256 || !/^[0-9a-f]{64}$/.test(update.installerSha256)) {
    return "The release has no checksum for its installer.";
  }
  return undefined;
}

export const isInstallable = (update: AvailableUpdateInfo | undefined, currentVersion: string): update is InstallableUpdate =>
  installProblem(update, currentVersion) === undefined;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const ELSEWHERE = "GitHub sent the download to a place ARIA doesn't download from.";

/** `raw` (against `base` when it's relative), if it's https on one of the download hosts with nothing else in it. */
function downloadUrl(raw: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw new DownloadError(ELSEWHERE);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new DownloadError(ELSEWHERE);
  }
  return url;
}

const letGo = (response: Response) => response.body?.cancel().catch(ignoreCleanupFailure);

/** The installer's response, after GitHub's redirects (each one checked). */
async function follow(fetch: FetchLike, start: string, signal: AbortSignal | undefined): Promise<Response> {
  let url = downloadUrl(start);
  if (url.hostname !== "github.com") throw new DownloadError(ELSEWHERE);
  for (let hop = 0; ; hop++) {
    const response = await fetch(url.toString(), {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      headers: { accept: "application/octet-stream", "user-agent": "ARIA" },
      ...(signal ? { signal } : {}),
    });
    if (!REDIRECTS.has(response.status)) {
      if (response.ok) return response;
      await letGo(response);
      throw new DownloadError(`GitHub answered ${response.status} to the download.`);
    }
    await letGo(response);
    if (hop >= MAX_REDIRECTS) throw new DownloadError("GitHub redirected the download too many times.");
    const location = response.headers.get("location");
    if (!location) throw new DownloadError("GitHub redirected the download without saying where to.");
    url = downloadUrl(location, url);
  }
}

export interface DownloadOptions {
  fetch: FetchLike;
  update: InstallableUpdate;
  /** ARIA's own download folder; made when it's missing. */
  dir: string;
  signal?: AbortSignal;
  onProgress?(received: number, total: number): void;
}

/**
 * Downloads `update`'s installer into `dir` and returns its path. It is written as `<name>.partial`, and renamed to
 * its name only when its size and SHA-256 are the ones GitHub states; otherwise it's deleted and this throws.
 */
export async function downloadInstaller(options: DownloadOptions): Promise<string> {
  const { update, signal } = options;
  const total = update.installerSize;
  await mkdir(options.dir, { recursive: true });
  const file = path.join(options.dir, update.installerName);
  const partial = `${file}.partial`;
  try {
    const response = await follow(options.fetch, update.installerUrl, signal);
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) !== total) {
      await letGo(response);
      throw new DownloadError("The download isn't the size GitHub states for the installer.");
    }
    if (!response.body) throw new DownloadError("GitHub sent an empty download.");
    const hash = createHash("sha256");
    let received = 0;
    const handle = await open(partial, "w");
    const reader = response.body.getReader();
    try {
      for (;;) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > total) throw new DownloadError("The download is larger than GitHub states for the installer.");
        hash.update(value);
        await handle.write(value);
        options.onProgress?.(received, total);
      }
    } catch (error) {
      await reader.cancel().catch(ignoreCleanupFailure);
      throw error;
    } finally {
      await handle.close();
    }
    if (received !== total) throw new DownloadError("The download stopped before the end.");
    if (hash.digest("hex") !== update.installerSha256) {
      throw new DownloadError("The download doesn't match the installer's checksum, so ARIA didn't keep it.");
    }
    await rename(partial, file);
    return file;
  } catch (error) {
    await rm(partial, { force: true }).catch(ignoreCleanupFailure);
    throw error;
  }
}
