# Plan: Update now or later

> Status: phases 1 and 2 built · 2026-11-28 · phase 3 (the extras) is open. Decision
> [D80](../PLAN.md#03-decisions-log).

## Context

ARIA already knew when a newer release existed. At start the engine read GitHub's `releases/latest` and parsed it with
`parseLatestGitHubRelease` ([releases.ts](../packages/core/src/releases/releases.ts)). If the release was newer, the
window opened the What's New modal with an "Update available" banner, and the sidebar footer showed an orange dot and
`v0.1.0 → v0.2.0` ([Onboarding.tsx](../apps/desktop/src/renderer/src/components/Onboarding.tsx)).

What was missing:

1. **ARIA only checked once, at start.** It stays in the tray for days, so a release that came out while it ran was
   never seen.
2. **"Download" wasn't "update".** The button opened the installer link in the browser. You then had to quit ARIA
   from the tray, find the file and run the installer yourself.
3. **There was no "Later".** Closing the modal set `dismissedAvailableUpdateVersion`, so that version never prompted
   again.
4. **The update sat inside the release notes.** It shared a modal with the notes of the version you already run.

## What changes for the user

**An update bar** across the top of the window, shown when an update is available and you haven't picked Later
([UpdateBar.tsx](../apps/desktop/src/renderer/src/components/UpdateBar.tsx)):

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ⬇  ARIA v0.2.0 is available (you have v0.1.0).        [What's new]  [Later]  [Update now] │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

- **Update now**: ARIA downloads the installer and the bar shows its progress (`Downloading ARIA v0.2.0… 42%`). If
  tasks are in progress, ARIA asks before it restarts:

  ```
  ⚠ 2 tasks are in progress. Updating restarts ARIA: they stop, and you can resume them after the restart.
                                                                        [Cancel]  [Update and restart]
  ```

  Then the bar says `Restarting ARIA to install v0.2.0…`, the installer runs silently and ARIA starts again on the
  new version. The What's New card for the new version appears in the chat, as it did before
  (`resolveOnboardingStartup` in [releases.ts](../packages/core/src/releases/releases.ts)).
- **Later**: hides the bar for 24 hours. The orange dot and `v0.1.0 → v0.2.0` in the sidebar footer stay, so the
  update is still easy to find. A newer release (v0.3.0) brings the bar back right away.
- **What's new**: opens the modal with the update's notes. The modal's banner has the same Update now and Later, and
  a Release page button.
- **If something fails** (no network, a checksum mismatch), the bar says so in one line and offers **Download
  instead** (the browser, as before), **Later** and **Try again**.
- **A development build** can't install itself, so its bar offers **Download** in place of Update now.

The bar replaces the modal that opened by itself at start. The modal still opens by itself after ARIA was updated, to
show what's new.

## How "Update now" works

### ARIA's own updater, not `electron-updater`

Detection was already ARIA's own code, and the release workflow already publishes `ARIA-Setup-<version>.exe` to GitHub
Releases ([installer.yml](../.github/workflows/installer.yml)). What was left was to download one file, check it and
run it.

`electron-updater` would also work, but it doesn't fit ARIA well:

- It has its own feed: a `latest.yml` file and a `publish` config. ARIA has `publish: null`
  ([electron-builder.yml](../apps/desktop/electron-builder.yml)), and the workflow would have to upload one more file.
- It uses its own HTTP client. ARIA sends its network requests through Chromium's stack, so the Windows proxy, PAC
  and certificate store apply ([github-fetch.ts](../apps/desktop/src/main/github-fetch.ts)), and through allowlists.
- Its main protection on Windows is a signature check, and the installer isn't signed, so that check does nothing
  here.

### The steps

The download and its checks are in core ([download.ts](../packages/core/src/releases/download.ts)), the check, the
progress and the hand-over in [updates.ts](../packages/core/src/releases/updates.ts). The main process only supplies
the fetch and the folder, and starts the installer ([index.ts](../apps/desktop/src/main/index.ts)).

1. **The window sends no URL.** `window.aria.installUpdate()` takes no arguments. The engine uses the release it
   found, so a page can't make ARIA download or run anything else.
2. **Check the release.** The installer must be the asset named `ARIA-Setup-<version>.exe` at
   `https://github.com/RobbieDemaegdt/aria/releases/download/<tag>/ARIA-Setup-<version>.exe`, GitHub's API must state
   its `size` and a `sha256:` `digest`, and `<version>` must be newer than the running version. Otherwise Update now
   isn't offered, and the bar offers Download.
3. **Download** through the same Chromium fetch as GitHub's other requests: no cookies, no GitHub token (the release
   is public), `cache: "no-store"`. Redirects are followed by hand, at most 5, and only to `github.com`,
   `objects.githubusercontent.com` and `release-assets.githubusercontent.com`, over https. The file is written to
   `%TEMP%\ARIA-update\ARIA-Setup-<version>.exe.partial`, and the download stops as soon as it's larger than the
   stated size.
4. **Verify.** The SHA-256 is computed while the file downloads. The size and the hash must match what GitHub's API
   says, or the file is deleted and the bar says why. Only then is it renamed to `.exe`, and the version is checked
   once more.
5. **Install.** ARIA quits through its normal path: `before-quit` → `engine.stop()`, which marks working tasks
   interrupted. Just before the final `app.quit()`, the main process starts the installer, detached:

   ```
   ARIA-Setup-0.2.0.exe --updated /S --force-run
   ```

   `/S` installs silently into the existing folder (the installer finds it in the registry), `--updated` marks it as
   an update, and `--force-run` starts ARIA when it's done. The install is per user (`perMachine: false`), so there's
   no UAC prompt. `%APPDATA%\ARIA` stays as it is (`deleteAppDataOnUninstall: false`).
6. **Clean up.** At the next start, ARIA deletes the installers it downloaded from `%TEMP%\ARIA-update`, and only
   those. One that is still running is left for the start after.

### Progress reaches the window

A new `update_status` event goes through the existing event channel, and `getState()` carries the latest one, so a
reopened window shows it too:

```ts
type UpdateStatus =
  | { phase: "idle" }
  | { phase: "downloading"; version: string; received: number; total: number }
  | { phase: "installing"; version: string }
  | { phase: "failed"; version: string; reason: string };
```

There is one event per percent, not one per chunk. The store keeps it next to `availableUpdate`, and the bar and the
modal banner draw from it.

## Checking more often

- The engine checks at start, then every 6 hours (±10%, on the attention clock so tests can move it). After the PC
  wakes or is unlocked, it checks if a check came due while it slept. Four checks a day stay far below GitHub's limit
  for requests without a token (60 an hour).
- It emits `available_update` only when what GitHub says changes. When the latest release is no longer newer, the
  update is forgotten; a failed request changes nothing.

## Later, stored

`OnboardingState` gets `updateSnooze?: { version: string; until: number }`, set by `snoozeUpdate()` with the engine's
clock. The bar is hidden while `snooze.version === update.version && now < snooze.until`, and comes back when it ends,
also while ARIA runs. While Update now is downloading or has failed, the bar stays whatever the snooze says.

Closing the modal doesn't count as Later: you open it from the bar to read the notes, and that shouldn't hide the
bar. `dismissedAvailableUpdateVersion` stays in the schema, so stored settings still load, but nothing writes it any
more.

## Safety

- The window can't choose what is downloaded or run: no URL or path crosses IPC.
- Downloads use https only, a fixed list of hosts (redirects included), and no cookies or token.
- The size and SHA-256 must match what GitHub's API says for the asset, and ARIA never installs a version that isn't
  newer (checked again right before the install).
- A file that ARIA downloads has no "mark of the web", so SmartScreen doesn't ask, as it does for a manual download.
  The checksum stands in for it. The trust is the same as a manual download: whoever can publish a release on the
  repository. **Code signing** is the real fix for that and is out of scope here.
- A development build can't install updates: it only links to the download.

## What was built

| File | Change |
| --- | --- |
| `packages/protocol/src/index.ts` | `AvailableUpdateInfo` gets `installerSize` and `installerSha256`; `OnboardingState` gets `updateSnooze`; `UpdateStatus` and the `update_status` event; `AppState` gets `updateStatus` and `canInstallUpdates`; `AriaApi` gets `installUpdate` and `snoozeUpdate` |
| `packages/protocol/src/channels.ts` | The two new channels |
| `packages/core/src/releases/releases.ts` | Only the exact installer name and link; its `size` and `digest` |
| `packages/core/src/releases/download.ts` (new) | `installProblem`, `downloadInstaller`: the redirects, the size, the checksum |
| `packages/core/src/releases/updates.ts` (new) | `AppUpdates`: the 6-hour check, the wake, Update now's progress, the clean-up |
| `packages/core/src/engine.ts` | Uses `AppUpdates`; `installUpdate()`, `snoozeUpdate()`; the state |
| `apps/desktop/src/main/index.ts` | The installer options (installed build only), the IPC handlers, the installer start in the quit path |
| `apps/desktop/src/main/fake-update.ts` (new) | `ARIA_FAKE_UPDATE`, a development switch: a made-up release, with no network |
| `apps/desktop/src/preload/index.ts` | The two new calls |
| `apps/desktop/src/renderer/src/components/UpdateBar.tsx` (new) | The bar |
| `apps/desktop/src/renderer/src/components/Onboarding.tsx` | The modal banner's Update now and Later |
| `apps/desktop/src/renderer/src/store.ts` | `updateStatus`, the question before a restart, Later; no startup popup for an available update |
| `apps/desktop/src/renderer/src/App.tsx` | The bar above the panels |
| `README.md`, `PLAN.md` | The Install section; decision D80 |

## Tests

- **Core** ([app-updates.test.ts](../packages/core/test/app-updates.test.ts)): the installer a release names (wrong
  name, wrong host, no digest, no size, not newer); the download (the redirect, no credentials, a checksum mismatch,
  a size announced, larger or cut short, a host off the list, http, a user name or port, six redirects, an error
  answer); the 6-hour check, the wake, an event only on a change; Update now's progress, its failure and Try again;
  the clean-up; Later in the engine's state.
- **Renderer** ([store.test.ts](../apps/desktop/test/store.test.ts),
  [onboarding.test.tsx](../apps/desktop/test/onboarding.test.tsx)): no popup at start for an available update; the
  bar's visibility with Later; Update now or Download; the question when tasks are in progress; each phase drawn.
- **E2E** ([ui-update.spec.ts](../apps/desktop/e2e/ui-update.spec.ts)), with `ARIA_FAKE_UPDATE`: the bar, What's new,
  Later (also after a restart); Update now's question with a running task, then the download and the hand-over (the
  hooks record the installer instead of starting it); a checksum mismatch.
- **Still to do by hand, once**: install a real older version from an installer, publish a test release, and update
  it from the bar. Only that run starts the real installer.

## Phases

1. **See it and pick Later.** Built: the 6-hour check, the bar, the snooze, the modal's buttons.
2. **Update now.** Built: the download and its checks, the progress, the question when tasks are in progress, the
   restart.
3. **Extras.** Open: a tray item (`Update to v0.2.0…`), a Check for updates button, "Update when they're done" (wait
   for the tasks, then restart), and a setting to turn the automatic check off.

## Open questions

- **How long is Later?** Built as 24 hours. "Until ARIA next starts" is the other common choice.
- **Skip this version?** A third choice that hides one version for good. It's left out to keep the bar to two
  buttons.
- **Download in the background before asking?** Update now would then be instant, but it downloads about 100 MB
  you may not want. Not built.
