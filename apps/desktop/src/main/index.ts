/**
 * Electron main process: window, tray, toasts, IPC, and the ARIA engine (PLAN.md §4.1: the engine runs in the main
 * process at first; the window is only a view onto it). ARIA keeps running in the tray when the window is closed.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, Notification, powerMonitor, safeStorage, session, shell, Tray, type IpcMainInvokeEvent } from "electron";
import { CopilotRuntime, encodeMonoWav, ghToken, AriaEngine, ManualClock, MAX_CONFIG_BYTES, type FetchLike, type McpSecretStore, type McpServerSecrets, type PhonePushSecrets, type PhoneSecretStore, type TelegramSecretStore, type UpdateInstaller, type VoiceSecretStore } from "@aria/core";
import {
  AcceptOfferInput,
  AddMarketplaceInput,
  AnswerQuestionInput,
  BrowseMarketplaceInput,
  CardIdInput,
  CHANNELS,
  CheckRuleInput,
  CloneProjectInput,
  ConductorTranscriptInput,
  ContinueBudgetInput,
  CreateProjectInput,
  DecidePermissionInput,
  DirectoryPathInput,
  RemoveProjectInput,
  ImportCliMcpInput,
  InstallPluginInput,
  IntegrationServerInput,
  MemoryIdInput,
  MessageTaskInput,
  MoveIntegrationRulesInput,
  MyWorkInput,
  OpenExternalInput,
  ProfileIdInput,
  PromptNameInput,
  ProposalInput,
  RefreshMarketplacesInput,
  RemoveMarketplaceInput,
  RemoveMcpServerInput,
  ReplyInput,
  ReviewPlanInput,
  RevokeGrantInput,
  RollbackPromptInput,
  SaveMcpServerInput,
  SaveMemoryInput,
  SavePolicyRulesInput,
  SaveProfileInput,
  SavePromptInput,
  SendMessageInput,
  SetConductorModelInput,
  SetInboxWatchInput,
  SetIntegrationRuleInput,
  SetMcpKeepInSyncInput,
  SetMcpServerTokenInput,
  SetPluginEnabledInput,
  SetProfilePolicyInput,
  SetSkillEnabledInput,
  SetActiveTrackerInput,
  SetAttentionInput,
  SetSandboxInput,
  SetTaskAgentInput,
  SetTaskModelInput,
  StartTaskInput,
  TaskFileInput,
  TaskIdInput,
  TestMcpServerInput,
  TranscriptPageInput,
  UiPatchInput,
  UninstallPluginInput,
  UpdatePluginInput,
  WatchDefaultBranchInput,
  WatchIdInput,
  WatchPullRequestInput,
  ProposePrInput,
  ConfirmPrInput,
  DismissPrInput,
  FixInput,
  StartFixProposalInput,
  CiFixProfileInput,
  ConfirmActionInput,
  ConfirmWorkflowDispatchInput,
  SetTaskTrackerInput,
  ListActivitiesInput,
  SaveTimeRuleInput,
  DeleteTimeRuleInput,
  SetTimekeeperSettingsInput,
  PrepareTimesheetInput,
  UpdateTimesheetEntryInput,
  ConfirmTimesheetEntryInput,
  DeleteTimesheetEntryInput,
  TimesheetRuleOfferInput,
  TimeViewGetInput,
  SubmitTimesheetInput,
  UpdateRegisteredEntryInput,
  DeleteRegisteredEntriesInput,
  SearchQueryInput,
  SetUtilitySettingsInput,
  SetBudgetSettingsInput,
  SetTranscriptRetentionInput,
  SaveRoutineInput,
  ToggleRoutineInput,
  RoutineIdInput,
  CreateReminderInput,
  SnoozeReminderInput,
  ReminderIdInput,
  TranscribeAudioInput,
  SynthesizeSpeechInput,
  SetVoiceCloudApiKeyInput,
  SetPhonePushSecretsInput,
  SetTelegramBotTokenInput,
  SetOnboardingStateInput,
  OpenCliTerminalInput,
  type AttentionSettings,
  type EngineEvent,
  type Task,
  type TrackerImportResult,
} from "@aria/protocol";
import { fakeRuntime } from "./fake-runtime.ts";
import { fakeUpdateFetch } from "./fake-update.ts";
import { chromiumFetch } from "./github-fetch.ts";
import { githubOptions, isTestRun } from "./github-options.ts";
import { allowsPermission, dropDevSwitches } from "./hardening.ts";
import { APP_ID, PRODUCT_NAME, userDataDir } from "./identity.ts";
import { IMAGE_FILES } from "./image-files.ts";
import { createImages } from "./images.ts";
import { IDLE_AWAY_SECONDS, PresenceController, type IdleState, type WindowState } from "./presence.ts";
import { secretRecord, secretValue, type SecretSlots } from "./secret-settings.ts";
import { ShellSync } from "./shell-sync.ts";
import { ToastShower, type ToastEvent } from "./toasts.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

// First: nothing below may read a development switch in a packaged build.
dropDevSwitches(app.isPackaged, process.env);

// The data folder is pinned on every start (`<appData>\<product name>`), not left to Electron's own choice of a name. Tests and dev
// runs can isolate everything ARIA stores: ARIA_DATA_DIR, or ARIA_APPDATA_DIR for the folder it goes under (identity.ts).
app.setName(PRODUCT_NAME);
app.setPath("userData", userDataDir(app.getPath("appData"), PRODUCT_NAME, process.env));
app.setAppUserModelId(APP_ID);

const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.quit();

/** ARIA's own repository (in dev) is never a project. */
function selfRepo(): string[] {
  let dir = app.getAppPath();
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(dir, "PLAN.md")) && existsSync(path.join(dir, "apps", "desktop"))) return [dir];
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [];
}

// Test switches work only in a development build: a stray value in a packaged one changes nothing.
const devBuild = !app.isPackaged;
// ARIA_FAKE_RUNTIME: a scripted runtime for UI tests and demos (no model calls); never set in normal use.
const fakeScenario = devBuild ? process.env.ARIA_FAKE_RUNTIME : undefined;
// ARIA_FAKE_UPDATE=<version>[:bad-checksum]: a made-up release for UI tests and demos (fake-update.ts).
const fakeUpdate = devBuild ? process.env.ARIA_FAKE_UPDATE?.trim() : undefined;

/**
 * ARIA_E2E_HOOKS=1 (the UI tests): toasts are recorded instead of shown, the attention engine's clock moves only when
 * a test advances it, and a test can set what the window and the system report about you. Reached through
 * Playwright's `app.evaluate` as `globalThis.__ariaE2E`.
 */
interface E2EHooks {
  clock: ManualClock;
  toasts: Array<Extract<EngineEvent, { type: "toast" }>>;
  spoken: Array<Extract<EngineEvent, { type: "speak" }>>;
  /** Sign-in pages ARIA would have opened in the browser (none is opened under the hooks). */
  opened: string[];
  /** Pages the window asked to open (a card's Open on GitHub): recorded, never opened under the hooks. */
  external: string[];
  /** The task tracker config file Import config… picks, instead of a file dialog (none set: the import is canceled). */
  trackerImportFile?: string;
  /** What the question "replace the config that is there?" is answered, instead of a message box (default: yes). */
  trackerReplace?: boolean;
  /** The fetch ARIA's GitHub code goes through (Chromium's), for the spec's canary. */
  githubFetch: FetchLike;
  /** What the GitHub session's proxy is for a URL ("DIRECT" under the hooks). */
  githubProxy(url: string): Promise<string>;
  /** Which GitHub this run reads: "test" (a test's server) or "none"; never "github.com" under the hooks. */
  githubKind: "github.com" | "test" | "none";
  window?: WindowState;
  idle?: IdleState;
  presence: PresenceController;
  startAtLogin?: boolean;
  startMinimized?: boolean;
  loginItemArgs?: string[];
  launchedAtStartup?: boolean;
  quickPromptHotkeyRegistered?: boolean;
  fakeTranscript?: string;
  runtime?: unknown;
  /** The installer Update now would have started (ARIA_FAKE_UPDATE): never started under the hooks. */
  updateInstaller?: string;
  clickToast(id: string): void;
  openQuickPrompt(): void;
}
const launchedAtStartup = process.argv.includes("--startup") || process.argv.includes("--hidden");
const launchedHidden = process.argv.includes("--hidden");
// Every launch starts with you there and active, whatever the machine running the test does (idle, locked), unless launched with --hidden.
const hooks: E2EHooks | undefined =
  devBuild && process.env.ARIA_E2E_HOOKS === "1"
    ? ({
        clock: new ManualClock(),
        toasts: [],
        spoken: [],
        opened: [],
        external: [],
        window: { exists: true, visible: !launchedHidden, minimized: false, focused: !launchedHidden },
        idle: { state: "active", seconds: 0 },
        launchedAtStartup,
      } as unknown as E2EHooks)
    : undefined;
if (hooks) (globalThis as { __ariaE2E?: E2EHooks }).__ariaE2E = hooks;
// Under the hooks no host name resolves in Chromium's network stack (a test's servers are on 127.0.0.1), and no proxy
// is used (a proxy on this PC would resolve the names itself): nothing a spec does can reach a real host, GitHub's
// included.
if (hooks) {
  app.commandLine.appendSwitch("host-resolver-rules", "MAP * ~NOTFOUND, EXCLUDE 127.0.0.1");
  app.commandLine.appendSwitch("no-proxy-server");
}

/**
 * GitHub's requests go through Chromium's network stack (Windows' proxy settings and certificate store, as in the
 * browser), in a session of their own that keeps nothing on disk and shares no cookies (github-fetch.ts: no cache,
 * no credentials, redirects handed back to core's guard). The session is made at the first request (the app is ready);
 * under the hooks it's set to connect directly, without a proxy, before that request goes.
 */
let githubSession: Promise<Electron.Session> | undefined;
const githubSessionOf = () =>
  (githubSession ??= (async () => {
    const made = session.fromPartition("aria-github");
    if (hooks) await made.setProxy({ mode: "direct" });
    return made;
  })());
const githubFetch: FetchLike = chromiumFetch(githubSessionOf);
if (hooks) {
  hooks.githubFetch = githubFetch;
  hooks.githubProxy = async (url) => (await githubSessionOf()).resolveProxy(url);
}

// github.com with GitHub CLI's token; in a test run (the scripted runtime, the hooks, or ARIA_TEST_RUN: the
// real-runtime specs) only a test's server, or none (github-options.ts).
const testRun = isTestRun({ packaged: app.isPackaged, env: process.env });
const github = githubOptions({
  testRun,
  testServer: devBuild ? process.env.ARIA_FAKE_GITHUB : undefined,
  testPushRoot: devBuild ? process.env.ARIA_FAKE_PUSH_ROOT : undefined,
  testLogHost: devBuild ? process.env.ARIA_FAKE_LOG_HOST : undefined,
  ghToken: () => ghToken(),
  fetch: githubFetch,
});
if (hooks) hooks.githubKind = github?.kind ?? "none";

/** Said in the window's title and the log, so test switches left in a shell don't go unnoticed. */
const testModes = [fakeScenario ? "fake runtime" : "", hooks ? "test hooks" : "", testRun && !fakeScenario && !hooks ? "test run" : ""].filter(Boolean);
const windowTitle = testModes.length ? `ARIA (${testModes.join(", ")})` : "ARIA";
if (testModes.length) console.warn(`ARIA is running with ${testModes.join(" and ")} (ARIA_FAKE_RUNTIME, ARIA_E2E_HOOKS, ARIA_TEST_RUN): not for normal use.`);

let engine!: AriaEngine;

const secretSlots: SecretSlots = {
  get: (key) => engine?.getEncryptedSetting(key),
  set: (key, value) => engine.setEncryptedSetting(key, value),
};
const voiceKey = secretValue(safeStorage, secretSlots, "voiceCloudApiKey", "the cloud voice API key");
const mcpSecrets = secretRecord<Record<string, McpServerSecrets>>(safeStorage, secretSlots, "mcpSecrets", "MCP secrets", console.warn);
const phoneSecrets = secretRecord<PhonePushSecrets>(safeStorage, secretSlots, "phonePushSecrets", "phone push credentials", console.warn);
const telegramToken = secretValue(safeStorage, secretSlots, "telegramBotToken", "the Telegram bot token");

const voiceSecretStore: VoiceSecretStore = {
  hasKey: () => voiceKey.has(),
  getKey: () => voiceKey.read(),
  setKey: (key) => voiceKey.write(key),
};

const mcpSecretStore: McpSecretStore = {
  getServerSecrets(serverName: string): McpServerSecrets | undefined {
    const secrets = mcpSecrets.read()[serverName];
    return secrets ? structuredClone(secrets) : undefined;
  },
  setServerSecrets(serverName: string, secrets: McpServerSecrets | null): void {
    mcpSecrets.update((all) => {
      const next = { ...all };
      if (!secrets || (!secrets.bearerToken && !secrets.fullUrl && !Object.keys(secrets.headers ?? {}).length && !Object.keys(secrets.env ?? {}).length)) {
        delete next[serverName];
      } else {
        next[serverName] = structuredClone(secrets);
      }
      return next;
    });
  },
  hasSecrets(serverName: string): boolean {
    const s = this.getServerSecrets(serverName);
    if (!s) return false;
    return Boolean(
      s.bearerToken?.trim() ||
        (s.headers && Object.keys(s.headers).length > 0) ||
        (s.env && Object.keys(s.env).length > 0) ||
        s.fullUrl,
    );
  },
};

const phoneSecretStore: PhoneSecretStore = {
  getSecrets: () => phoneSecrets.read(),
  setSecrets(patch): void {
    phoneSecrets.update((current) => {
      const next: PhonePushSecrets = { ...current };
      for (const field of ["ntfyToken", "pushoverAppToken", "pushoverUserKey"] as const) {
        const value = patch[field];
        if (value === undefined) continue;
        if (value && value.trim()) next[field] = value.trim();
        else delete next[field];
      }
      return next;
    });
  },
  hasNtfyToken(): boolean {
    return Boolean(this.getSecrets().ntfyToken?.trim());
  },
  hasPushoverCredentials(): boolean {
    const s = this.getSecrets();
    return Boolean(s.pushoverAppToken?.trim() && s.pushoverUserKey?.trim());
  },
};

const telegramSecretStore: TelegramSecretStore = {
  hasBotToken: () => telegramToken.has(),
  getBotToken: () => telegramToken.read(),
  setBotToken: (token) => telegramToken.write(token?.trim() || null),
};

/**
 * Update now (D80): the installer to start once ARIA has stopped (before-quit, below). Set when the engine has
 * downloaded and checked it.
 */
let installerOnQuit: string | undefined;

/**
 * Silently, into the folder ARIA is installed in (the installer finds it in the registry: a per-user install, no UAC
 * prompt), and ARIA starts again when it's done. %APPDATA%\ARIA isn't touched.
 */
function startInstaller(file: string): void {
  try {
    const child = spawn(file, ["--updated", "/S", "--force-run"], { detached: true, stdio: "ignore" });
    child.on("error", (error) => console.error(`ARIA couldn't start the update's installer: ${error.message}`));
    child.unref();
  } catch (error) {
    console.error(`ARIA couldn't start the update's installer: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The check for updates and Update now: GitHub's real release in a normal run, and Update now only in an installed
 * build (a development one has no installed ARIA to update). No check at all in a test run, unless it asks for the
 * made-up release (ARIA_FAKE_UPDATE), whose installer is only recorded.
 */
function updateOptions(): { updateCheckFetch?: FetchLike; updateInstaller?: UpdateInstaller } {
  if (fakeUpdate) {
    const [version = "99.0.0", mode] = fakeUpdate.split(":");
    const fetch = fakeUpdateFetch(version, mode);
    return {
      updateCheckFetch: fetch,
      updateInstaller: {
        fetch,
        dir: path.join(app.getPath("userData"), "update-downloads"),
        launch: (file) => {
          if (hooks) hooks.updateInstaller = file;
          console.log(`ARIA_FAKE_UPDATE: Update now would start ${file}`);
        },
      },
    };
  }
  if (testRun) return {};
  if (!app.isPackaged) return { updateCheckFetch: githubFetch };
  return {
    updateCheckFetch: githubFetch,
    updateInstaller: {
      fetch: githubFetch,
      dir: path.join(app.getPath("temp"), "ARIA-update"),
      launch: (file) => {
        installerOnQuit = file;
        app.quit();
      },
    },
  };
}

const activeRuntime = fakeScenario ? fakeRuntime(fakeScenario) : new CopilotRuntime();
if (hooks) hooks.runtime = activeRuntime;

engine = new AriaEngine({
  dataDir: app.getPath("userData"),
  runtime: activeRuntime,
  appVersion: (devBuild && process.env.ARIA_APP_VERSION) || app.getVersion(),
  ...(hooks ? { attentionClock: hooks.clock } : {}),
  ...(github ? { github } : {}),
  ...updateOptions(),
  // The scripted runtime's spec moves the clock itself: no jitter, so intervals are exact.
  ...(fakeScenario ? { watchJitter: 0 } : {}),
  // ARIA_FAKE_TRACKER=<config id>: with the scripted runtime only, stands in for a missing tracker setting.
  ...(fakeScenario && process.env.ARIA_FAKE_TRACKER ? { trackerConfig: process.env.ARIA_FAKE_TRACKER } : {}),
  voiceSecretStore,
  mcpSecretStore,
  phoneSecretStore,
  telegramSecretStore,
  ...(devBuild && process.env.ARIA_FAKE_PUSHOVER_URL ? { pushoverEndpoint: process.env.ARIA_FAKE_PUSHOVER_URL } : {}),
  ...(devBuild && process.env.ARIA_FAKE_TELEGRAM_URL ? { telegramApiBaseUrl: process.env.ARIA_FAKE_TELEGRAM_URL } : {}),
  ...(process.env.ARIA_CLI_MCP_CONFIG ? { cliMcpConfigPath: path.resolve(process.env.ARIA_CLI_MCP_CONFIG) } : {}),
  ...(fakeScenario
    ? {
        voiceTranscriber: async () => hooks?.fakeTranscript ?? "Check the status of Moonrise",
        voiceSynthesizer: async () => ({
          audioBase64: encodeMonoWav(new Int16Array(1600), 16_000).toString("base64"),
          mimeType: "audio/wav",
        }),
      }
    : {}),
  excludePaths: selfRepo(),
  ...(process.env.ARIA_PROJECT_ROOTS ? { projectRoots: process.env.ARIA_PROJECT_ROOTS.split(path.delimiter).filter(Boolean) } : {}),
  ...(process.env.ARIA_CONDUCTOR_ID ? { conductorSessionId: process.env.ARIA_CONDUCTOR_ID } : {}),
  ...(process.env.ARIA_MODEL ? { defaultModel: process.env.ARIA_MODEL } : {}),
  ...(process.env.ARIA_WORKTREE_ROOT ? { worktreeRoot: path.resolve(process.env.ARIA_WORKTREE_ROOT) } : {}),
});

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
/** The window icon, the tray icon and the taskbar dot (images.ts). */
const images = createImages(IMAGE_FILES);
/** Set once you really quit (tray menu, or the OS), so closing the window doesn't just hide it. */
let quitting = false;

function openExternal(raw: string): void {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    // A spec never starts a browser (at github.com or anywhere): the page is recorded.
    if (hooks) hooks.external.push(url.toString());
    else void shell.openExternal(url.toString());
  } catch {
    // Not an address: there's nothing to open.
  }
}

/**
 * A sign-in page from Customize › Integrations (the engine checked it: https, no user name in it). It goes to the
 * browser and nowhere else: not to the window, not to the log. Under the test hooks it's only recorded.
 */
function openSignInPage(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (url.protocol !== "https:" || url.username || url.password) return;
  if (hooks) hooks.opened.push(url.toString());
  else void shell.openExternal(url.toString());
}

function showWindow(): void {
  if (!win) {
    createWindow({ showOnReady: true });
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (hooks?.window && !hooks.window.visible) {
    hooks.window = { ...hooks.window, visible: true, minimized: false, focused: true };
    presence.recompute();
  }
}

function send(event: EngineEvent): void {
  if (win && !win.isDestroyed()) win.webContents.send(CHANNELS.event, event);
}

/** Global hotkey (`Ctrl+Alt+Space`, Phase 6C, PLAN.md §4.1, §5.5): brings the window up and opens the Quick prompt bar. In-window shortcut remains `Ctrl+Space`. */
function openQuickPrompt(): void {
  showWindow();
  if (!win || win.isDestroyed()) return;
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", () => send({ type: "quick_prompt" }));
  } else {
    send({ type: "quick_prompt" });
  }
}

const QUICK_PROMPT_ACCELERATOR = "CommandOrControl+Alt+Space";
const shellSync = new ShellSync({
  setLoginItem(openAtLogin, args) {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin, path: process.execPath, args: [...args] });
  },
  registerHotkey: () => globalShortcut.register(QUICK_PROMPT_ACCELERATOR, openQuickPrompt),
  unregisterHotkey: () => globalShortcut.unregister(QUICK_PROMPT_ACCELERATOR),
  now: () => Date.now(),
  warn(message) {
    // This can come before the engine is there to log it.
    const log = engine?.logger("shell");
    if (log) log.warn(message);
    else console.warn(message);
  },
});

function syncDesktopShellSettings(settings: AttentionSettings): void {
  const startAtLogin = settings.startAtLogin === true;
  const startMinimized = settings.startMinimized !== false;
  const loginItemArgs = startAtLogin ? (startMinimized ? ["--startup", "--hidden"] : ["--startup"]) : [];
  const hotkeyEnabled = settings.quickPromptHotkey !== false;
  if (hooks) {
    hooks.startAtLogin = startAtLogin;
    hooks.startMinimized = startMinimized;
    hooks.loginItemArgs = loginItemArgs;
    hooks.launchedAtStartup = launchedAtStartup;
    hooks.quickPromptHotkeyRegistered = hotkeyEnabled;
  }
  // Until the database is open these are only the defaults: applied, they'd take ARIA out of start at login on every launch.
  if (!engine.isOpen()) return;
  shellSync.apply({ startAtLogin, loginItemArgs, hotkey: hotkeyEnabled && !testRun && app.isReady() });
}

function createWindow(options: { showOnReady?: boolean } = {}): void {
  const showOnReady = options.showOnReady ?? !launchedHidden;
  const windowIcon = images.appIcon();
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    title: windowTitle,
    ...(windowIcon ? { icon: windowIcon } : {}),
    backgroundColor: "#0d1117",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(here, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: true,
      additionalArguments: fakeScenario || hooks ? ["--aria-fake-mic"] : [],
    },
  });
  if (showOnReady) {
    win.once("ready-to-show", () => win?.show());
  }
  // The page's own <title> would replace one that says test switches are on.
  if (testModes.length) win.on("page-title-updated", (event) => event.preventDefault());
  // Closing the window keeps ARIA running in the tray; Quit in the tray menu really quits.
  win.on("close", (event) => {
    if (quitting || !tray) return;
    event.preventDefault();
    win?.hide();
  });
  win.on("closed", () => {
    win = null;
  });
  presence.attachWindow(win);
  // Links from chat open in the browser; the window itself never navigates away or opens popups.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== win?.webContents.getURL()) {
      event.preventDefault();
      openExternal(url);
    }
  });
  if (devBuild && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(path.join(here, "../renderer/index.html"));
  updateAttention();
}

// ── tray, taskbar dot and toasts ────────────────────────────────────────────────────────────────────────────────

/** What needs you: a question, a permission request or a plan waiting for you, a budget pause, or an interrupted task. */
const tasks = new Map<string, Task>();
const NEEDS_YOU = new Set<Task["state"]>(["waiting_input", "waiting_permission", "waiting_plan", "waiting_budget", "interrupted"]);
const needsYou = (task: Task) => NEEDS_YOU.has(task.state);
let shownCount = -1;

let shownFocusMode: boolean | undefined;
let shownStartAtLogin: boolean | undefined;

function updateAttention(): void {
  const count = [...tasks.values()].filter(needsYou).length;
  const att = engine.attentionSettings();
  const focusMode = att.focusMode;
  const startAtLogin = att.startAtLogin === true;
  syncDesktopShellSettings(att);
  if (count === shownCount && focusMode === shownFocusMode && startAtLogin === shownStartAtLogin && win) return;
  shownCount = count;
  const label = `${count === 0 ? "ARIA" : `ARIA · ${count} need${count === 1 ? "s" : ""} you`}${focusMode ? " · focus mode" : ""}`;
  tray?.setImage(images.trayIcon(count > 0));
  tray?.setToolTip(label);
  if (tray && (focusMode !== shownFocusMode || startAtLogin !== shownStartAtLogin)) {
    tray.setContextMenu(trayMenu(focusMode, startAtLogin));
  }
  shownFocusMode = focusMode;
  shownStartAtLogin = startAtLogin;
  if (win && !win.isDestroyed()) win.setOverlayIcon(count > 0 ? images.overlayDot() : null, count > 0 ? label : "");
}

function trayMenu(focusMode: boolean, startAtLogin: boolean): Menu {
  return Menu.buildFromTemplate([
    { label: "Open ARIA", click: showWindow },
    { label: "Quick prompt (Ctrl+Alt+Space)", click: openQuickPrompt },
    {
      label: "Focus mode",
      type: "checkbox",
      checked: focusMode,
      click: (item) => {
        try {
          engine.setAttention({ focusMode: item.checked });
        } catch {
          // ARIA hasn't opened its database yet: the menu goes back to the setting as it is.
          shownFocusMode = undefined;
          updateAttention();
        }
      },
    },
    {
      label: "Start at login",
      type: "checkbox",
      checked: startAtLogin,
      click: (item) => {
        try {
          engine.setAttention({ startAtLogin: item.checked });
        } catch {
          shownStartAtLogin = undefined;
          updateAttention();
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit ARIA",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray(): void {
  try {
    tray = new Tray(images.trayIcon(false));
  } catch (error) {
    // The tray's images are files of the install. Without a tray nothing could bring a hidden window back, so closing the window quits.
    console.warn(`ARIA has no tray icon: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  tray.setToolTip("ARIA");
  tray.on("click", showWindow);
  updateAttention();
}

// ── toasts: the engine decides (D25, Focus mode, coalescing); this shows them (PLAN.md §4.7) ────────────────────────


/** Clicking a toast brings the window up at that card. */
function onToastClick(event: ToastEvent): void {
  showWindow();
  send({ type: "focus", ...(event.taskId ? { taskId: event.taskId } : {}), ...(event.cardId ? { cardId: event.cardId } : {}) });
}

const toasts = new ToastShower({
  create: (options) => (Notification.isSupported() ? new Notification(options) : undefined),
  onClick: onToastClick,
  log: (text) => console.warn(text),
});

function toast(event: ToastEvent): void {
  if (hooks) hooks.toasts.push(event);
  else toasts.show(event);
}

function onEngineEvent(event: EngineEvent): void {
  send(event);
  if (event.type === "task") {
    tasks.set(event.task.id, event.task);
    updateAttention();
  } else if (event.type === "task_removed") {
    tasks.delete(event.taskId);
    updateAttention();
  } else if (event.type === "toast") {
    toast(event);
  } else if (event.type === "speak") {
    if (hooks) hooks.spoken.push(event);
  } else if (event.type === "attention") {
    updateAttention();
  }
}

// ── whether you're there (PLAN.md §4.5, D25) ──────────────────────────────────────────────────────────────────────

const presence = new PresenceController({
  window: () =>
    hooks?.window ??
    (win && !win.isDestroyed() ? { exists: true, visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused() } : { exists: false, visible: false, minimized: false, focused: false }),
  idle: () => {
    if (hooks?.idle) return hooks.idle;
    const state = powerMonitor.getSystemIdleState(IDLE_AWAY_SECONDS);
    return { state, seconds: state === "idle" ? powerMonitor.getSystemIdleTime() : 0 };
  },
  report: (present, since, locked) => engine.setPresence(present, since, locked),
  now: () => (hooks ? hooks.clock.now() : Date.now()),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
});
if (hooks) {
  hooks.presence = presence;
  hooks.clickToast = (id) => {
    const event = hooks.toasts.find((t) => t.id === id);
    if (event) onToastClick(event);
  };
  hooks.openQuickPrompt = () => openQuickPrompt();
}

// ── IPC ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Only our own window may call the engine. */
function handle<T>(channel: string, fn: (event: IpcMainInvokeEvent, arg: unknown) => Promise<T> | T): void {
  ipcMain.handle(channel, async (event, arg: unknown) => {
    if (!win || event.sender !== win.webContents) throw new Error("Unknown sender");
    return fn(event, arg);
  });
}

const taskIdOf = (arg: unknown) => TaskIdInput.parse(arg).taskId;

/**
 * Import config… (Customize › Integrations): the file dialog is here, the checking and the copy are the engine's. The
 * picked file is read as text (at most 256 KB); when the trackers folder has one with that name already, the question
 * "replace it?" is a message box (the hooks answer it for a test).
 */
async function importTrackerConfigFile(): Promise<TrackerImportResult> {
  let file: string | undefined = hooks?.trackerImportFile;
  if (!hooks) {
    const picked = await dialog.showOpenDialog(win!, {
      title: "Import a task tracker config",
      properties: ["openFile"],
      filters: [{ name: "Task tracker config (JSON)", extensions: ["json"] }],
    });
    file = picked.canceled ? undefined : picked.filePaths[0];
  }
  if (!file) return { status: "canceled" };
  let text: string;
  try {
    if (statSync(file).size > MAX_CONFIG_BYTES) return { status: "invalid", errors: [`the file is larger than ${MAX_CONFIG_BYTES / 1024} KB`] };
    text = readFileSync(file, "utf8");
  } catch (error) {
    return { status: "failed", error: `ARIA couldn't read that file: ${error instanceof Error ? error.message : String(error)}` };
  }
  let result = engine.importTrackerConfig(text);
  if (result.status === "exists") {
    const known = result.existingHash ? ` (${result.existingHash})` : "";
    const replace = hooks
      ? hooks.trackerReplace !== false
      : (
          await dialog.showMessageBox(win!, {
            type: "question",
            title: "Replace the config?",
            message: `${result.file} is in ARIA's trackers folder already${known}.`,
            detail: `Replace it with the file you picked (${result.hash})?${result.active ? " It is the task tracker in use: ARIA loads the new one." : ""}`,
            buttons: ["Replace", "Cancel"],
            defaultId: 1,
            cancelId: 1,
          })
        ).response === 0;
    if (!replace) return { status: "canceled" };
    result = engine.importTrackerConfig(text, { replace: true });
  }
  return result.status === "exists" ? { status: "failed", error: `${result.file} is in the trackers folder already.` } : result;
}

function registerIpc(): void {
  handle(CHANNELS.getState, () => engine.getState());
  handle(CHANNELS.sendMessage, (_e, arg) => engine.sendMessage(SendMessageInput.parse(arg).text));
  handle(CHANNELS.setConductorModel, (_e, arg) => engine.setConductorModel(SetConductorModelInput.parse(arg)));
  handle(CHANNELS.reconnect, () => engine.reconnect());
  handle(CHANNELS.rescanProjects, () => engine.rescanProjects());
  handle(CHANNELS.addProjectFolder, async () => {
    const result = await dialog.showOpenDialog(win!, { title: "Add a project folder or repository", properties: ["openDirectory"] });
    const folder = result.filePaths[0];
    return result.canceled || !folder ? null : engine.addProjectFolder(folder);
  });
  handle(CHANNELS.removeProject, (_e, arg) => engine.removeProject(RemoveProjectInput.parse(arg).repoId));
  handle(CHANNELS.addProjectRoot, (_e, arg) => engine.addProjectRoot(DirectoryPathInput.parse(arg).path));
  handle(CHANNELS.removeProjectRoot, (_e, arg) => engine.removeProjectRoot(DirectoryPathInput.parse(arg).path));
  handle(CHANNELS.pickProjectRoot, async () => {
    const result = await dialog.showOpenDialog(win!, { title: "Select a project root folder", properties: ["openDirectory"] });
    const folder = result.filePaths[0];
    return result.canceled || !folder ? null : engine.addProjectRoot(folder);
  });
  handle(CHANNELS.pickFiles, async () => {
    const result = await dialog.showOpenDialog(win!, {
      title: "Select files to provide as context",
      properties: ["openFile", "multiSelections"],
    });
    return result.canceled ? [] : result.filePaths;
  });
  handle(CHANNELS.createProject, (_e, arg) => engine.createProject(CreateProjectInput.parse(arg)));
  handle(CHANNELS.cloneProject, (_e, arg) => engine.cloneProject(CloneProjectInput.parse(arg).url));
  handle(CHANNELS.setUiState, (_e, arg) => {
    engine.setUiState(UiPatchInput.parse(arg));
  });
  handle(CHANNELS.openExternal, (_e, arg) => openExternal(OpenExternalInput.parse(arg).url));

  handle(CHANNELS.startTask, (_e, arg) => engine.startTask(StartTaskInput.parse(arg)));
  handle(CHANNELS.messageTask, (_e, arg) => {
    const input = MessageTaskInput.parse(arg);
    return engine.messageTask(input.taskId, input.text, input.steer);
  });
  handle(CHANNELS.answerQuestion, (_e, arg) => {
    const input = AnswerQuestionInput.parse(arg);
    engine.answerQuestion(input.taskId, input.questionId, input.answer, input.wasFreeform);
  });
  handle(CHANNELS.cancelTask, (_e, arg) => engine.cancelTask(taskIdOf(arg)));
  handle(CHANNELS.repairEncoding, (_e, arg) => engine.repairEncoding(taskIdOf(arg)));
  handle(CHANNELS.discardTask, (_e, arg) => engine.discardTask(taskIdOf(arg)));
  handle(CHANNELS.retryTask, (_e, arg) => engine.retryTask(taskIdOf(arg)));
  handle(CHANNELS.resumeInterrupted, () => engine.resumeInterrupted());
  handle(CHANNELS.dismissInterrupted, () => engine.dismissInterrupted());
  handle(CHANNELS.continueBudget, (_e, arg) => {
    const input = ContinueBudgetInput.parse(arg);
    engine.continueBudget(input.taskId, input.addCredits);
  });
  handle(CHANNELS.setTaskModel, (_e, arg) => {
    const input = SetTaskModelInput.parse(arg);
    return engine.setTaskModel(input.taskId, input.model, input.reasoningEffort);
  });
  handle(CHANNELS.setTaskAgent, (_e, arg) => {
    const input = SetTaskAgentInput.parse(arg);
    return engine.setTaskAgent(input.taskId, input.agent);
  });
  handle(CHANNELS.getTranscript, (_e, arg) => engine.getTranscriptPage(TranscriptPageInput.parse(arg)));
  handle(CHANNELS.getTaskDiff, (_e, arg) => engine.getTaskDiff(taskIdOf(arg)));
  handle(CHANNELS.getTaskFile, (_e, arg) => {
    const input = TaskFileInput.parse(arg);
    return engine.getTaskFile(input.taskId, input.path);
  });
  handle(CHANNELS.getConductorTranscript, (_e, arg) => engine.conductorTranscript(ConductorTranscriptInput.parse(arg ?? {})));
  handle(CHANNELS.releaseConductorTranscript, () => engine.releaseConductorTranscript());
  handle(CHANNELS.openInEditor, async (_e, arg) => {
    // VS Code's own link opens the task's worktree folder; nothing goes through a shell.
    const folder = engine.taskWorktree(taskIdOf(arg));
    await shell.openExternal(`vscode://file${pathToFileURL(folder).pathname}`).catch(() => shell.openPath(folder));
  });

  handle(CHANNELS.saveProfile, (_e, arg) => engine.saveProfile(SaveProfileInput.parse(arg)));
  handle(CHANNELS.deleteProfile, (_e, arg) => engine.deleteProfile(ProfileIdInput.parse(arg).profileId));
  handle(CHANNELS.setDefaultProfile, (_e, arg) => engine.setDefaultProfile(ProfileIdInput.parse(arg).profileId));
  handle(CHANNELS.setProfilePolicy, (_e, arg) => engine.setProfilePolicy(SetProfilePolicyInput.parse(arg).policy));

  handle(CHANNELS.decidePermission, (_e, arg) => {
    const input = DecidePermissionInput.parse(arg);
    engine.decidePermission(input.taskId, input.permissionId, input.decision, input.note);
  });
  handle(CHANNELS.reviewPlan, (_e, arg) => {
    const input = ReviewPlanInput.parse(arg);
    return engine.reviewPlan(input.taskId, input.planId, input.decision, input.feedback);
  });
  handle(CHANNELS.reply, (_e, arg) => engine.reply(ReplyInput.parse(arg)));
  handle(CHANNELS.revokeGrant, (_e, arg) => {
    const input = RevokeGrantInput.parse(arg);
    engine.revokeGrant(input.taskId, input.grantId);
  });
  handle(CHANNELS.startProposal, (_e, arg) => {
    const input = ProposalInput.parse(arg);
    return engine.startProposal(input.cardId, input.profileId, input.agent);
  });
  handle(CHANNELS.dismissProposal, (_e, arg) => engine.dismissProposal(ProposalInput.parse(arg).cardId));
  handle(CHANNELS.dismissCard, (_e, arg) => engine.dismissCard(CardIdInput.parse(arg).cardId));

  handle(CHANNELS.savePolicyRules, (_e, arg) => engine.savePolicyRules(SavePolicyRulesInput.parse(arg).rules));
  handle(CHANNELS.resetPolicyRules, () => engine.resetPolicyRules());
  handle(CHANNELS.setSandbox, (_e, arg) => engine.setSandbox(SetSandboxInput.parse(arg)));
  handle(CHANNELS.checkRule, (_e, arg) => engine.checkRule(CheckRuleInput.parse(arg)));
  handle(CHANNELS.ruleOffers, (_e, arg) => engine.ruleOffers(taskIdOf(arg)));
  handle(CHANNELS.acceptOffer, (_e, arg) => engine.acceptOffer(AcceptOfferInput.parse(arg)));
  handle(CHANNELS.yourWords, (_e, arg) => engine.yourWords(taskIdOf(arg)));
  handle(CHANNELS.saveMemory, (_e, arg) => engine.saveMemory(SaveMemoryInput.parse(arg)));
  handle(CHANNELS.deleteMemory, (_e, arg) => engine.deleteMemory(MemoryIdInput.parse(arg).id));
  handle(CHANNELS.refreshIntegrations, () => engine.refreshIntegrations());
  handle(CHANNELS.setIntegrationRule, (_e, arg) => engine.setIntegrationRule(SetIntegrationRuleInput.parse(arg)));
  handle(CHANNELS.signIn, async (_e, arg) => {
    const started = await engine.signIn(IntegrationServerInput.parse(arg).server);
    if (started.url) openSignInPage(started.url);
    // The window gets the page's host only.
    return { ...(started.host ? { host: started.host } : {}), ...(started.connected ? { connected: true } : {}) };
  });
  handle(CHANNELS.cancelSignIn, () => engine.cancelSignIn());
  handle(CHANNELS.moveIntegrationRules, (_e, arg) => engine.moveIntegrationRules(MoveIntegrationRulesInput.parse(arg)));
  handle(CHANNELS.forgetIntegrationServer, (_e, arg) => engine.forgetIntegrationServer(IntegrationServerInput.parse(arg)));
  handle(CHANNELS.importCliMcp, (_e, arg) => engine.importCliMcp(ImportCliMcpInput.parse(arg ?? {})));
  handle(CHANNELS.setMcpKeepInSync, (_e, arg) => engine.setMcpKeepInSync(SetMcpKeepInSyncInput.parse(arg)));
  handle(CHANNELS.testMcpServer, (_e, arg) => engine.testMcpServer(TestMcpServerInput.parse(arg)));
  handle(CHANNELS.saveMcpServer, (_e, arg) => engine.saveMcpServer(SaveMcpServerInput.parse(arg)));
  handle(CHANNELS.removeMcpServer, (_e, arg) => engine.removeMcpServer(RemoveMcpServerInput.parse(arg)));
  handle(CHANNELS.setMcpServerToken, (_e, arg) => engine.setMcpServerToken(SetMcpServerTokenInput.parse(arg)));
  handle(CHANNELS.addMarketplace, (_e, arg) => engine.addMarketplace(AddMarketplaceInput.parse(arg)));
  handle(CHANNELS.removeMarketplace, (_e, arg) => engine.removeMarketplace(RemoveMarketplaceInput.parse(arg)));
  handle(CHANNELS.browseMarketplace, (_e, arg) => engine.browseMarketplace(BrowseMarketplaceInput.parse(arg)));
  handle(CHANNELS.refreshMarketplaces, (_e, arg) => engine.refreshMarketplaces(RefreshMarketplacesInput.parse(arg ?? {})));
  handle(CHANNELS.installPlugin, (_e, arg) => engine.installPlugin(InstallPluginInput.parse(arg)));
  handle(CHANNELS.uninstallPlugin, (_e, arg) => engine.uninstallPlugin(UninstallPluginInput.parse(arg)));
  handle(CHANNELS.updatePlugin, (_e, arg) => engine.updatePlugin(UpdatePluginInput.parse(arg ?? {})));
  handle(CHANNELS.setPluginEnabled, (_e, arg) => engine.setPluginEnabled(SetPluginEnabledInput.parse(arg)));
  handle(CHANNELS.setSkillEnabled, (_e, arg) => engine.setSkillEnabled(SetSkillEnabledInput.parse(arg)));
  handle(CHANNELS.addPluginDirectory, (_e, arg) => engine.addPluginDirectory(DirectoryPathInput.parse(arg)));
  handle(CHANNELS.removePluginDirectory, (_e, arg) => engine.removePluginDirectory(DirectoryPathInput.parse(arg)));
  handle(CHANNELS.addSkillDirectory, (_e, arg) => engine.addSkillDirectory(DirectoryPathInput.parse(arg)));
  handle(CHANNELS.removeSkillDirectory, (_e, arg) => engine.removeSkillDirectory(DirectoryPathInput.parse(arg)));
  handle(CHANNELS.addAgentDirectory, (_e, arg) => engine.addAgentDirectory(DirectoryPathInput.parse(arg)));
  handle(CHANNELS.removeAgentDirectory, (_e, arg) => engine.removeAgentDirectory(DirectoryPathInput.parse(arg)));
  // `purge` is the answer to the question a switch asks about another tracker's data, not part of the choice.
  handle(CHANNELS.setActiveTracker, (_e, arg) => {
    const { purge, ...choice } = SetActiveTrackerInput.parse(arg);
    return engine.setActiveTracker(choice, purge === undefined ? {} : { purge });
  });
  handle(CHANNELS.previewTrackerChange, (_e, arg) => {
    const { purge: _purge, ...choice } = SetActiveTrackerInput.parse(arg);
    return engine.previewTrackerChange(choice);
  });
  handle(CHANNELS.importTrackerConfig, () => importTrackerConfigFile());
  handle(CHANNELS.openTrackerFolder, async () => {
    const dir = engine.trackersFolder();
    if (hooks) {
      hooks.opened.push(`trackers:${dir}`);
      return;
    }
    mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
  });
  handle(CHANNELS.setAttention, (_e, arg) => engine.setAttention(SetAttentionInput.parse(arg)));
  handle(CHANNELS.unwatch, (_e, arg) => engine.unwatch(WatchIdInput.parse(arg).watchId));
  handle(CHANNELS.retryGitHub, () => engine.retryGitHub());
  handle(CHANNELS.retryInbox, () => engine.retryInbox());
  handle(CHANNELS.setInboxWatch, (_e, arg) => engine.setInboxWatch(SetInboxWatchInput.parse(arg).on));
  handle(CHANNELS.useGitHubAccount, (_e, arg) => engine.useGitHubAccount(CardIdInput.parse(arg).cardId));
  handle(CHANNELS.switchGitHubAccount, (_e, arg) => engine.switchGitHubAccount(CardIdInput.parse(arg).cardId));
  handle(CHANNELS.myWork, (_e, arg) => engine.myWork(MyWorkInput.parse(arg).refresh));
  handle(CHANNELS.watchPullRequest, (_e, arg) => engine.watchPullRequest(WatchPullRequestInput.parse(arg).key));
  handle(CHANNELS.watchDefaultBranch, (_e, arg) => engine.watchDefaultBranch(WatchDefaultBranchInput.parse(arg).repoId));
  // Item 3: the window names a task or a card, and sends your edits; everything else is the engine's own records.
  handle(CHANNELS.proposePr, (_e, arg) => engine.proposePr(ProposePrInput.parse(arg).taskId));
  handle(CHANNELS.confirmPr, (_e, arg) => engine.confirmPr(ConfirmPrInput.parse(arg)));
  handle(CHANNELS.dismissPr, (_e, arg) => engine.dismissPr(DismissPrInput.parse(arg).cardId));
  // Item 4: the window names the card (and the proposal's revision, D51's tick); the engine works out the rest.
  handle(CHANNELS.fixCi, (_e, arg) => engine.fixCi(FixInput.parse(arg).cardId));
  handle(CHANNELS.addressReview, (_e, arg) => {
    const input = FixInput.parse(arg);
    return engine.addressReview(input.cardId, input.ticked === true);
  });
  handle(CHANNELS.startFixProposal, (_e, arg) => {
    const input = StartFixProposalInput.parse(arg);
    return engine.startFixProposal(input.cardId, input.revision, input.ticked === true);
  });
  handle(CHANNELS.dismissFixProposal, (_e, arg) => engine.dismissFixProposal(CardIdInput.parse(arg).cardId));
  handle(CHANNELS.setCiFixProfile, (_e, arg) => engine.setCiFixProfile(CiFixProfileInput.parse(arg).profileId));
  handle(CHANNELS.confirmAction, (_e, arg) => engine.confirmAction(ConfirmActionInput.parse(arg)));
  handle(CHANNELS.cancelAction, (_e, arg) => engine.cancelAction(CardIdInput.parse(arg).cardId));
  handle(CHANNELS.confirmWorkflowDispatch, (_e, arg) => engine.confirmWorkflowDispatch(ConfirmWorkflowDispatchInput.parse(arg)));
  handle(CHANNELS.dismissWorkflowDispatch, (_e, arg) => engine.dismissWorkflowDispatch(CardIdInput.parse(arg).cardId));
  handle(CHANNELS.setTaskTracker, (_e, arg) => {
    const input = SetTaskTrackerInput.parse(arg);
    return engine.setTaskTracker(input.taskId, input.trackerTaskId);
  });
  handle(CHANNELS.listActivities, (_e, arg) => engine.listActivities(ListActivitiesInput.parse(arg ?? {})));
  handle(CHANNELS.saveTimeRule, (_e, arg) => engine.saveTimeRule(SaveTimeRuleInput.parse(arg)));
  handle(CHANNELS.deleteTimeRule, (_e, arg) => engine.deleteTimeRule(DeleteTimeRuleInput.parse(arg).id));
  handle(CHANNELS.setTimekeeperSettings, (_e, arg) => engine.setTimekeeperSettings(SetTimekeeperSettingsInput.parse(arg)));
  handle(CHANNELS.prepareTimesheet, (_e, arg) => engine.prepareTimesheet(PrepareTimesheetInput.parse(arg ?? {}).date));
  handle(CHANNELS.updateTimesheetEntry, async (_e, arg) => {
    const input = UpdateTimesheetEntryInput.parse(arg);
    const payload = engine.updateTimesheetEntry(input);
    return engine.resolveTimesheetTasks(input.date).catch((error: unknown) => {
      engine.logger("timesheet")?.warn(`Resolving the timesheet's tasks failed: ${error instanceof Error ? error.message : String(error)}`);
      return payload;
    });
  });
  handle(CHANNELS.confirmTimesheetEntry, async (_e, arg) => {
    const input = ConfirmTimesheetEntryInput.parse(arg);
    const payload = engine.confirmTimesheetEntry(input.date, input.entryId);
    return engine.resolveTimesheetTasks(input.date).catch((error: unknown) => {
      engine.logger("timesheet")?.warn(`Resolving the timesheet's tasks failed: ${error instanceof Error ? error.message : String(error)}`);
      return payload;
    });
  });
  handle(CHANNELS.deleteTimesheetEntry, (_e, arg) => {
    const input = DeleteTimesheetEntryInput.parse(arg);
    return engine.deleteTimesheetEntry(input.date, input.entryId);
  });
  handle(CHANNELS.acceptTimesheetRuleOffer, async (_e, arg) => {
    const input = TimesheetRuleOfferInput.parse(arg);
    const payload = engine.acceptTimesheetRuleOffer(input.date, input.offerId);
    return engine.resolveTimesheetTasks(input.date).catch((error: unknown) => {
      engine.logger("timesheet")?.warn(`Resolving the timesheet's tasks failed: ${error instanceof Error ? error.message : String(error)}`);
      return payload;
    });
  });
  handle(CHANNELS.dismissTimesheetRuleOffer, (_e, arg) => {
    const input = TimesheetRuleOfferInput.parse(arg);
    return engine.dismissTimesheetRuleOffer(input.date, input.offerId);
  });
  handle(CHANNELS.getTimeView, async (_e, arg) => {
    const date = TimeViewGetInput.parse(arg ?? {}).date;
    await engine.resolveTimesheetTasks(date).catch((error: unknown) => {
      // The view still opens, with what's recorded.
      engine.logger("timesheet")?.warn(`Resolving the timesheet's tasks failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return engine.getTimeView(date);
  });
  handle(CHANNELS.submitTimesheet, (_e, arg) => {
    const input = SubmitTimesheetInput.parse(arg);
    return engine.submitTimesheet(input.date, input.entryIds);
  });
  handle(CHANNELS.updateRegisteredEntry, (_e, arg) => engine.updateRegisteredEntry(UpdateRegisteredEntryInput.parse(arg)));
  handle(CHANNELS.deleteRegisteredEntries, (_e, arg) => engine.deleteRegisteredEntries(DeleteRegisteredEntriesInput.parse(arg)));
  handle(CHANNELS.search, (_e, arg) => engine.search(SearchQueryInput.parse(arg)));
  handle(CHANNELS.setUtilitySettings, (_e, arg) => engine.setUtilitySettings(SetUtilitySettingsInput.parse(arg)));
  handle(CHANNELS.setBudgetSettings, (_e, arg) => engine.setBudgetSettings(SetBudgetSettingsInput.parse(arg ?? {})));
  handle(CHANNELS.getDataState, () => engine.dataState());
  handle(CHANNELS.setTranscriptRetention, (_e, arg) => engine.setTranscriptRetention(SetTranscriptRetentionInput.parse(arg ?? {})));
  handle(CHANNELS.cleanUpTranscripts, () => engine.cleanUpTranscripts());
  handle(CHANNELS.saveRoutine, (_e, arg) => engine.saveRoutine(SaveRoutineInput.parse(arg)));
  handle(CHANNELS.toggleRoutine, (_e, arg) => engine.toggleRoutine(ToggleRoutineInput.parse(arg)));
  handle(CHANNELS.runRoutine, (_e, arg) => engine.runRoutine(RoutineIdInput.parse(arg).id));
  handle(CHANNELS.deleteRoutine, (_e, arg) => engine.deleteRoutine(RoutineIdInput.parse(arg).id));
  handle(CHANNELS.createReminder, (_e, arg) => engine.createReminder(CreateReminderInput.parse(arg)));
  handle(CHANNELS.snoozeReminder, (_e, arg) => {
    const input = SnoozeReminderInput.parse(arg);
    return engine.snoozeReminder(input.reminderId, input.minutes);
  });
  handle(CHANNELS.dismissReminder, (_e, arg) => engine.dismissReminder(ReminderIdInput.parse(arg).reminderId));
  handle(CHANNELS.deleteReminder, (_e, arg) => engine.deleteReminder(ReminderIdInput.parse(arg).reminderId));
  handle(CHANNELS.transcribeAudio, (_e, arg) => engine.transcribeAudio(TranscribeAudioInput.parse(arg)));
  handle(CHANNELS.synthesizeSpeech, (_e, arg) => engine.synthesizeSpeech(SynthesizeSpeechInput.parse(arg)));
  handle(CHANNELS.setVoiceCloudApiKey, (_e, arg) => engine.setVoiceCloudApiKey(SetVoiceCloudApiKeyInput.parse(arg).apiKey));
  handle(CHANNELS.setPhonePushSecrets, (_e, arg) => engine.setPhonePushSecrets(SetPhonePushSecretsInput.parse(arg ?? {})));
  handle(CHANNELS.testPhonePush, () => engine.testPhonePush());
  handle(CHANNELS.setTelegramBotToken, (_e, arg) => engine.setTelegramBotToken(SetTelegramBotTokenInput.parse(arg).botToken));
  handle(CHANNELS.testTelegramRelay, () => engine.testTelegramRelay());

  handle(CHANNELS.listPrompts, () => engine.listPrompts());
  handle(CHANNELS.promptHistory, (_e, arg) => engine.promptHistory(PromptNameInput.parse(arg).name));
  handle(CHANNELS.savePrompt, (_e, arg) => {
    const input = SavePromptInput.parse(arg);
    return engine.savePrompt(input.name, input.text, input.note);
  });
  handle(CHANNELS.rollbackPrompt, (_e, arg) => {
    const input = RollbackPromptInput.parse(arg);
    return engine.rollbackPrompt(input.name, input.version);
  });
  handle(CHANNELS.resetPrompt, (_e, arg) => engine.resetPrompt(PromptNameInput.parse(arg).name));

  handle(CHANNELS.runDoctor, () => engine.runDoctor());
  handle(CHANNELS.setOnboardingState, (_e, arg) => engine.setOnboardingState(SetOnboardingStateInput.parse(arg ?? {})));
  handle(CHANNELS.installUpdate, () => engine.installUpdate());
  handle(CHANNELS.snoozeUpdate, () => engine.snoozeUpdate());
  handle(CHANNELS.openCliTerminal, (_e, arg) => {
    const { target } = OpenCliTerminalInput.parse(arg);
    if (hooks) {
      hooks.opened.push(`terminal:${target}`);
      return { launched: true };
    }
    try {
      if (process.platform === "win32") {
        const title = target === "copilot" ? "Copilot CLI Sign-In" : "GitHub CLI Sign-In";
        const cmd = target === "copilot" ? "copilot" : "gh auth login";
        const child = spawn("cmd.exe", ["/c", "start", title, "cmd.exe", "/k", cmd], {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        });
        child.unref();
        return { launched: true };
      }
      return {
        launched: false,
        error: `Run "${target === "copilot" ? "copilot" : "gh auth login"}" in your terminal, then click Reconnect.`,
      };
    } catch (error) {
      return {
        launched: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  handle(CHANNELS.openLogsFolder, async () => {
    const dir = engine.logDir();
    if (hooks) {
      hooks.opened.push(`logs:${dir}`);
      return;
    }
    mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
  });
}

app.on("second-instance", showWindow);

app.whenReady().then(() => {
  // A second launch has told the first to show itself ("second-instance"), and is on its way out: quitting doesn't stop this from running.
  if (!firstInstance) return;
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(allowsPermission(permission, "mediaTypes" in details ? details.mediaTypes : undefined));
  });
  engine.onEvent(onEngineEvent);
  registerIpc();
  createTray();
  createWindow();
  presence.attachPower(powerMonitor);
  presence.start();
  // Timers drift across a sleep: GitHub's watchers look at what's due as soon as the PC is back.
  powerMonitor.on("resume", () => engine.systemResumed());
  powerMonitor.on("unlock-screen", () => engine.systemResumed());
  const starting = engine.start();
  // Its first step opens the database, which the rest of the start can take a while after (the runtime, projects, models).
  syncDesktopShellSettings(engine.attentionSettings());
  starting.then(
    () => {
      for (const task of engine.getState().tasks) tasks.set(task.id, task);
      engine.logger("shell")?.info(images.describe());
      // The settings are known now that the database is open.
      shownFocusMode = undefined;
      updateAttention();
    },
    (error: unknown) => {
      // No database, no ARIA: a window that stays empty wouldn't say why.
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`ARIA couldn't start: ${detail}`);
      if (!testRun) dialog.showErrorBox("ARIA couldn't start", detail);
      app.quit();
    },
  );
});

app.on("window-all-closed", () => {
  // The tray keeps ARIA running without a window (with no tray, the window's closing is the end).
  if (!tray) app.quit();
});
app.on("will-quit", () => {
  try {
    globalShortcut.unregisterAll();
  } catch {
    // ARIA is quitting: its shortcuts go with it.
  }
});

let stopping = false;
app.on("before-quit", (event) => {
  quitting = true;
  if (stopping || !firstInstance) return;
  stopping = true;
  event.preventDefault();
  presence.stop();
  void engine.stop().finally(() => {
    tray?.destroy();
    tray = null;
    // Update now: the installer starts once the tasks and the runtime have stopped, so it finds ARIA gone (D80).
    if (installerOnQuit) startInstaller(installerOnQuit);
    app.quit();
  });
});
