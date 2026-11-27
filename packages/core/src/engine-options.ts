import type { LogLevel, ReleaseNoteEntry } from "@aria/protocol";
import type { Clock } from "./attention/clock.ts";
import type { PhoneSecretStore } from "./attention/phone.ts";
import type { GitHubOptions } from "./github/access.ts";
import type { FetchLike } from "./github/fetch.ts";
import type { McpSecretStore } from "./integrations/config.ts";
import type { McpDirectClient, TransportFactory } from "./integrations/mcp-client.ts";
import type { TelegramSecretStore } from "./relay/telegram.ts";
import type { AgentRuntime } from "./runtime/types.ts";
import type { BackupHooks } from "./store/store.ts";
import type { TaskTracker } from "./trackers/types.ts";
import type { VoiceSecretStore, VoiceSynthesizer, VoiceTranscriber } from "./voice/voice.ts";

/** What the desktop app (or a test) gives AriaEngine. */
export interface EngineOptions {
  /** Folder for aria.db. */
  dataDir: string;
  runtime: AgentRuntime;
  /** The task tracker, as it is (tests). Without it `start()` chooses one: the setting, or the tracker of the data. */
  tracker?: TaskTracker;
  /** A config id (in `<dataDir>/trackers`) that stands in for a missing tracker setting: dev and e2e runs only. */
  trackerConfig?: string;
  /** Tests: stand-ins for what the store's backups ask the system (the room on the drive, the copy), as `StoreOptions.backup`. */
  storeBackup?: BackupHooks;
  /** Where projects are scanned. Default: ~/Documents/GitHub when it exists. */
  projectRoots?: string[];
  /** Folders never registered as projects (ARIA's own repo). */
  excludePaths?: string[];
  /** Overrides the stored Conductor session id (tests). */
  conductorSessionId?: string;
  /** Model used when none is stored yet (tests); otherwise the cheapest lightweight model. */
  defaultModel?: string;
  /** How long to wait after a resume for runtime warnings (interrupted tools) before opening the input. */
  resumeSettleMs?: number;
  /** Where task worktrees go. Default: C:\wt (D14), else ~/.aria-wt. */
  worktreeRoot?: string;
  /** How many tasks run at once (default 3). */
  maxConcurrentTasks?: number;
  /** Tests: how long a finished turn must stay quiet before a task counts as done. */
  taskSettleMs?: number;
  /** Tests: how long an autopilot task that went quiet without finishing waits before it counts as stopped. */
  autopilotGraceMs?: number;
  /** Tests: how long quitting waits for sessions to finish setting up and to detach (default 10 s for tasks, 5 s for ARIA). */
  shutdownWaitMs?: number;
  /** Tests: how often the runtime is asked whether it still answers (default 15 s). */
  runtimeCheckMs?: number;
  /** Tests: how long a task's session steps wait for each other and for one session call (default 60 s and 10 s). */
  sessionWaitMs?: number;
  /** Where ARIA notes something only a developer needs to see (default: the console). */
  log?: (message: string) => void;
  /** Tests: how many of your messages the inspector keeps (default and most: CONDUCTOR_TRANSCRIPT_MAX_TURNS). */
  inspectorHoldTurns?: number;
  /** The attention engine's clock (toasts, the away card); tests move a manual one. */
  attentionClock?: Clock;
  /**
   * GitHub for the watchers (PLAN.md §4.6): github.com with gh's token (the desktop app), or a test's server on
   * loopback. Left out, this run of ARIA has no GitHub at all (no gh, no request).
   */
  github?: GitHubOptions;
  /** The watchers' clock (default: the attention clock, else the real one). */
  watchClock?: Clock;
  /** Tests: the retry plugin's base wait, one request's time-out, how much intervals vary, the watchers' tick. */
  githubRetryBaseMs?: number;
  githubTimeoutMs?: number;
  /** Tests: false turns off Octokit's throttling plugin (its real-time spacing of searches and notifications). */
  githubThrottle?: boolean;
  watchJitter?: number;
  watchTickMs?: number;
  /** OS keychain / safeStorage adapter for the optional cloud voice API key (Phase 6D, PLAN.md §0.4 #6, D70). */
  voiceSecretStore?: VoiceSecretStore;
  /** Optional local push-to-talk transcriber override (used by the scripted fake runtime and unit tests). */
  voiceTranscriber?: VoiceTranscriber;
  /** Optional speech synthesizer override (used by the scripted fake runtime and unit tests). */
  voiceSynthesizer?: VoiceSynthesizer;
  /** Optional fetch override for cloud STT/TTS calls in tests. */
  voiceFetch?: typeof globalThis.fetch;
  /** Phase 7A: OS keychain / safeStorage adapter for MCP server tokens, headers, env vars, and query URLs. */
  mcpSecretStore?: McpSecretStore;
  /** Phase 7A: Optional built-in MCP client override for tests. */
  mcpClient?: McpDirectClient;
  /** Phase 7A: Optional transport factory for NativeMcpClient in tests (e.g. InMemoryTransport). */
  mcpTransportFactory?: TransportFactory;
  /** Phase 7A: Optional fetch override for HTTP/SSE MCP transports in tests. */
  mcpFetch?: typeof globalThis.fetch;
  /** Phase 7A: Optional path to Copilot CLI's mcp-config.json (defaults to ~/.copilot/mcp-config.json). */
  cliMcpConfigPath?: string;
  /** Phase 8A: Timeout in ms waiting for `session.start` (`producer === "copilot-agent"`) on cloud tasks (default 60_000). */
  cloudStartTimeoutMs?: number;
  /** Phase 8B: OS keychain / safeStorage adapter for phone push credentials (ntfy token, Pushover keys). */
  phoneSecretStore?: PhoneSecretStore;
  /** Phase 8B: Optional Pushover endpoint override for loopback tests. */
  pushoverEndpoint?: string;
  /** Phase 8B: Optional fetch override for phone push notifications in tests. */
  phoneFetch?: typeof globalThis.fetch;
  /** Phase 8B: OS keychain / safeStorage adapter for the Telegram bot token. */
  telegramSecretStore?: TelegramSecretStore;
  /** Phase 8B: Optional Telegram Bot API base URL override for loopback tests. */
  telegramApiBaseUrl?: string;
  /** Phase 8B: Optional delay in ms between empty Telegram polls in tests. */
  telegramPollIntervalMs?: number;
  /** Phase 8B: Optional long-polling timeout in seconds for Telegram getUpdates (default 25). */
  telegramLongPollTimeoutSeconds?: number;
  /** Phase 8B: Optional initial backoff in ms for Telegram polling errors in tests. */
  telegramRetryBaseMs?: number;
  /** Phase 8B: Optional fetch override for Telegram Bot API calls in tests. */
  telegramFetch?: typeof globalThis.fetch;
  /** Phase 9: Minimum diagnostic file log level (default: ARIA_LOG_LEVEL or "info"). */
  logLevel?: LogLevel;
  /** Current application version string (e.g. "0.1.0"); used for first-run onboarding and "What's new" update detection. */
  appVersion?: string;
  /** Optional override for the structured release notes catalog (tests). */
  releases?: readonly ReleaseNoteEntry[];
  /** Optional fetch function to check GitHub Releases for a newer version of ARIA on startup. */
  updateCheckFetch?: FetchLike;
}
