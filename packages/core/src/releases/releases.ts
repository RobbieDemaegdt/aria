import type { AvailableUpdateInfo, OnboardingState, ReleaseNoteEntry } from "@aria/protocol";

export const DEFAULT_APP_VERSION = "0.1.0";
export const ARIA_GITHUB_REPO = "RobbieDemaegdt/aria";
export const ARIA_LATEST_RELEASE_URL = `https://api.github.com/repos/${ARIA_GITHUB_REPO}/releases/latest`;

/**
 * Structured release history (newest first).
 * When ARIA starts with a version newer than `onboarding.lastSeenVersion`, all releases in `(lastSeenVersion, currentVersion]`
 * are surfaced on a `whats_new` timeline card with interactive deep-links.
 */
export const RELEASES: readonly ReleaseNoteEntry[] = [
  {
    version: "0.1.0",
    date: "2026-11-27",
    headline: "Welcome to ARIA",
    features: [
      {
        title: "One Chat, Many Hands",
        description:
          "Tell ARIA what you want in one conversation. It starts background tasks, each in its own git worktree and, where your PC can run it, in a sandbox. Cards, toasts and a focus mode keep progress noise out of the chat: only what is done, needs you or went wrong reaches it, and you answer questions and approvals in place.",
        action: { kind: "tour", label: "Take the 1-minute tour" },
      },
      {
        title: "GitHub Awareness",
        description:
          "Watches on pull requests and CI, a My work view, and flows for opening a pull request and fixing a red CI. They use the GitHub CLI, signed in with gh auth login.",
        action: { kind: "view", view: "customize", customizePage: "notifications", label: "GitHub settings" },
      },
      {
        title: "MCP Servers, Plugins and Skills",
        description:
          "Everything your Copilot CLI setup has. Each session gets only the servers and tools in its scope, and anything that changes things asks first.",
        action: { kind: "view", view: "customize", customizePage: "integrations", label: "Open Integrations" },
      },
      {
        title: "Work Tracking and a Daily Timesheet Draft",
        description:
          "A task tracker you configure, if you use one: none is needed. ARIA drafts your day from your git commits, GitHub pull requests, its own tasks and, with the Work IQ plugin, your Outlook and Teams, for you to check and submit with a click.",
        action: { kind: "view", view: "time", label: "Open Time view" },
      },
      {
        title: "Everyday Helpers",
        description:
          "Memory and search, routines, reminders and a morning brief, plus optional push to your phone (ntfy, Pushover or Telegram) and voice input (whisper.cpp).",
        action: { kind: "view", view: "automations", label: "Open Automations" },
      },
      {
        title: "Check Your Setup",
        description:
          "On first start a Getting Started checklist says what is missing: the Copilot runtime, the GitHub CLI, your projects, the sandbox. /doctor runs the checks again at any time.",
        action: { kind: "prefill", text: "/doctor", label: "Run /doctor" },
      },
    ],
    fixes: [],
    newSettings: [
      {
        title: "Models, Worker Profiles & Daily Budget Cap",
        description: "Pick the model and reasoning effort for ARIA, worker profiles and the Timekeeper, and set a daily credit cap.",
        customizePage: "models",
      },
      {
        title: "Permissions",
        description: "Choose what tasks may do on their own, with rules for the commands that ask, run or never run.",
        customizePage: "permissions",
      },
      {
        title: "Notifications",
        description: "Choose how ARIA reaches you: GitHub notifications, toasts and push to your phone.",
        customizePage: "notifications",
      },
    ],
  },
];

export function parseSemver(version: string): [number, number, number] | null {
  const cleaned = version.trim().replace(/^v/i, "").split("-")[0] ?? "";
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(cleaned);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return a.trim().localeCompare(b.trim());
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  }
  return 0;
}

/**
 * Returns all release note entries with `version > lastSeenVersion` and `version <= currentVersion`, newest first.
 */
export function releasesSince(
  lastSeenVersion: string | undefined,
  currentVersion: string,
  releases: readonly ReleaseNoteEntry[] = RELEASES,
): ReleaseNoteEntry[] {
  if (!lastSeenVersion || compareSemver(currentVersion, lastSeenVersion) <= 0) return [];
  const matching = releases.filter(
    (r) => compareSemver(r.version, lastSeenVersion) > 0 && compareSemver(r.version, currentVersion) <= 0,
  );
  if (matching.length > 0) {
    return [...matching].sort((a, b) => compareSemver(b.version, a.version));
  }
  const exactCurrent = releases.find((r) => compareSemver(r.version, currentVersion) === 0);
  return exactCurrent ? [exactCurrent] : [];
}

export interface OnboardingStartupResolution {
  state: OnboardingState;
  changed: boolean;
  isFirstRun: boolean;
  previousVersion?: string;
  whatsNewReleases: ReleaseNoteEntry[];
}

/**
 * Evaluates stored onboarding state against `currentVersion` at engine startup:
 * - On fresh install (`!stored?.lastSeenVersion`), marks `lastSeenVersion = currentVersion` without emitting a changelog card.
 * - On version upgrade (`compareSemver(currentVersion, stored.lastSeenVersion) > 0`), returns `whatsNewReleases` for a `whats_new` card.
 */
export function resolveOnboardingStartup(
  stored: OnboardingState | undefined,
  currentVersion: string,
  now: number,
  releases: readonly ReleaseNoteEntry[] = RELEASES,
): OnboardingStartupResolution {
  if (!stored || !stored.lastSeenVersion) {
    return {
      state: {
        ...stored,
        lastSeenVersion: currentVersion,
        dismissedWhatsNewVersion: stored?.dismissedWhatsNewVersion ?? currentVersion,
        setupCompleted: stored?.setupCompleted ?? false,
        tourCompleted: stored?.tourCompleted ?? false,
        updatedAt: now,
      },
      changed: true,
      isFirstRun: true,
      whatsNewReleases: [],
    };
  }

  if (compareSemver(currentVersion, stored.lastSeenVersion) > 0) {
    const whatsNewReleases = releasesSince(stored.lastSeenVersion, currentVersion, releases);
    return {
      state: {
        ...stored,
        lastSeenVersion: currentVersion,
        dismissedWhatsNewVersion: stored.dismissedWhatsNewVersion ?? stored.lastSeenVersion,
        updatedAt: now,
      },
      changed: true,
      isFirstRun: false,
      previousVersion: stored.lastSeenVersion,
      whatsNewReleases,
    };
  }

  return {
    state: stored,
    changed: false,
    isFirstRun: false,
    whatsNewReleases: [],
  };
}

/** The installer the release workflow publishes for a version (electron-builder.yml's `artifactName`). */
export const installerNameFor = (version: string): string => `ARIA-Setup-${version}.exe`;

/** GitHub's download link for a release asset: the only installer link ARIA takes (D80). */
export const installerUrlFor = (tagName: string, name: string, repo = ARIA_GITHUB_REPO): string =>
  `https://github.com/${repo}/releases/download/${encodeURIComponent(tagName)}/${encodeURIComponent(name)}`;

const SHA256_DIGEST = /^sha256:([0-9a-f]{64})$/i;

/**
 * Parses a GitHub `/repos/:owner/:repo/releases/latest` response and returns `AvailableUpdateInfo`
 * when the release version is strictly newer than `currentVersion`. The installer is the asset named exactly
 * `ARIA-Setup-<version>.exe` at GitHub's own download link for it; its size and SHA-256 come with it when GitHub
 * states them (D80).
 */
export function parseLatestGitHubRelease(
  raw: unknown,
  currentVersion: string,
  repo = ARIA_GITHUB_REPO,
): AvailableUpdateInfo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.draft === true || obj.prerelease === true) return null;
  const tagName = typeof obj.tag_name === "string" ? obj.tag_name.trim() : "";
  if (!tagName) return null;
  const version = tagName.replace(/^v/i, "");
  if (!parseSemver(version) || compareSemver(version, currentVersion) <= 0) return null;

  const htmlUrl = typeof obj.html_url === "string" && obj.html_url.startsWith("https://github.com/")
    ? obj.html_url
    : `https://github.com/${repo}/releases/tag/${encodeURIComponent(tagName)}`;

  let installerUrl: string | undefined;
  let installerName: string | undefined;
  let installerSize: number | undefined;
  let installerSha256: string | undefined;
  if (Array.isArray(obj.assets)) {
    const expectedName = installerNameFor(version);
    const expectedUrl = installerUrlFor(tagName, expectedName, repo);
    for (const asset of obj.assets) {
      if (!asset || typeof asset !== "object") continue;
      const a = asset as Record<string, unknown>;
      const name = typeof a.name === "string" ? a.name.trim() : "";
      const url = typeof a.browser_download_url === "string" ? a.browser_download_url.trim() : "";
      if (name !== expectedName || url !== expectedUrl) continue;
      installerName = name;
      installerUrl = url;
      if (typeof a.size === "number" && Number.isSafeInteger(a.size) && a.size > 0) installerSize = a.size;
      const digest = typeof a.digest === "string" ? SHA256_DIGEST.exec(a.digest.trim()) : null;
      if (digest) installerSha256 = digest[1]!.toLowerCase();
      break;
    }
  }

  const headline = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim().slice(0, 200) : undefined;
  const notes = typeof obj.body === "string" && obj.body.trim() ? obj.body.trim().slice(0, 2_000) : undefined;
  const publishedAt = typeof obj.published_at === "string" && obj.published_at.trim() ? obj.published_at.trim() : undefined;

  return {
    version,
    tagName,
    releaseUrl: htmlUrl,
    ...(headline ? { headline } : {}),
    ...(notes ? { notes } : {}),
    ...(installerUrl ? { installerUrl } : {}),
    ...(installerName ? { installerName } : {}),
    ...(installerSize !== undefined ? { installerSize } : {}),
    ...(installerSha256 ? { installerSha256 } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

