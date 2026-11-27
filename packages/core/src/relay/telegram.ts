/**
 * Two-way Telegram relay into the single ARIA chat (Phase 8B, PLAN.md §4.7, §10 Phase 8B, D74):
 * - Long-polls `getUpdates` (`timeout: 25`) with `AbortController`, exponential backoff on network errors, and HTTP 429 `retry_after` sleep.
 * - Fast-forwards `getUpdates` offset on first enable (setting offset = 0 when history is empty) so stale history is never replayed.
 * - Enforces strict private-chat authorization (`chat.type === "private"`, `!from.is_bot`, `from.id === chat.id === telegramChatId`).
 * - Forwards inbound messages into `engine.sendMessage(text, { via: "telegram" })`, replying with an error message if processing fails.
 * - Relays blocking items (with short IDs and choices), milestones, and assistant replies in plain-text mode.
 */
import type { AttentionSettings, TelegramRelayStatus } from "@aria/protocol";
import type { AttentionEvent, WaitingItem } from "../attention/attention.ts";
import { formatPhonePushPayload } from "../attention/phone.ts";
import { isLoopbackHost } from "../integrations/config.ts";

export const DEFAULT_TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const TELEGRAM_MAX_MESSAGE_CHARS = 4_000;
const TELEGRAM_INBOUND_MAX_CHARS = 50_000;
const TELEGRAM_SEND_TIMEOUT_MS = 10_000;

export interface TelegramSecretStore {
  getBotToken(): string | undefined;
  setBotToken(token: string | null): void;
  hasBotToken(): boolean;
}

export function createMemoryTelegramSecretStore(initialToken?: string): TelegramSecretStore {
  let token = initialToken?.trim() || undefined;
  return {
    getBotToken: () => token,
    setBotToken: (next) => {
      token = next?.trim() || undefined;
    },
    hasBotToken: () => Boolean(token),
  };
}

export interface TelegramMessage {
  message_id: number;
  date?: number;
  text?: string;
  from?: {
    id: number | string;
    is_bot?: boolean;
    username?: string;
  };
  chat?: {
    id: number | string;
    type?: string;
  };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramWaitingContext extends WaitingItem {
  choices?: string[];
  slug?: string;
}

export function isValidTelegramChatId(raw?: string): boolean {
  const trimmed = raw?.trim() ?? "";
  return /^\d{1,20}$/.test(trimmed);
}

/**
 * Strict authorization check (D74):
 * - Private 1:1 chats only (`chat.type === "private"`).
 * - Rejects bots (`from.is_bot !== true`).
 * - Requires both `chat.id` and `from.id` to match the configured `telegramChatId`.
 */
export function isAuthorizedTelegramMessage(
  message: TelegramMessage | undefined,
  expectedChatId: string | undefined,
): message is TelegramMessage & { text: string } {
  if (!message || typeof message.text !== "string" || !message.text.trim()) return false;
  if (!isValidTelegramChatId(expectedChatId)) return false;
  const expected = expectedChatId!.trim();
  if (message.chat?.type !== "private") return false;
  if (message.from?.is_bot === true) return false;
  if (String(message.chat?.id ?? "") !== expected) return false;
  if (String(message.from?.id ?? "") !== expected) return false;
  return true;
}

export function normalizeTelegramApiBaseUrl(raw?: string): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return DEFAULT_TELEGRAM_API_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid Telegram API base URL.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Telegram API base URL must not include credentials.");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) {
    throw new Error("Telegram API base URL must use https:// (or http:// on loopback).");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function truncateTelegramText(text: string, maxChars = TELEGRAM_MAX_MESSAGE_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1).trimEnd()}…`;
}

function cleanTelegramFragment(text: string, maxLen = 80): string {
  return text.replace(/[\r\n\0]/g, " ").replace(/[^\P{Cc}\n\r\t]|[\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim().slice(0, maxLen);
}

export function formatTelegramAttentionMessage(
  event: AttentionEvent,
  priority: "blocking" | "milestone",
  waitingItem?: TelegramWaitingContext,
): string {
  const formatted = formatPhonePushPayload(event, priority, waitingItem?.shortId);
  if (priority === "blocking") {
    const lines: string[] = [`🔴 ${formatted.title}`];
    if (formatted.body && formatted.body !== formatted.title) {
      lines.push(formatted.body);
    }
    if (waitingItem) {
      const shortId = waitingItem.shortId;
      if (waitingItem.kind === "question") {
        if (waitingItem.choices?.length) {
          const sanitizedChoices = waitingItem.choices.map((c) => cleanTelegramFragment(c, 80));
          lines.push(`Choices: ${sanitizedChoices.join(" | ")}`);
        }
        const slugHint = waitingItem.slug ? ` or "@${waitingItem.slug} <your answer>"` : "";
        lines.push(`Reply with "answer ${shortId ?? "Q-1"} <your answer>"${slugHint}.`);
      } else if (waitingItem.kind === "permission") {
        lines.push(`Reply with "approve ${shortId ?? "P-1"}" or "reject ${shortId ?? "P-1"}".`);
      } else if (waitingItem.kind === "plan") {
        lines.push(`Reply with "approve ${shortId ?? "L-1"}" or "revise ${shortId ?? "L-1"}: <feedback>".`);
      } else if (waitingItem.kind === "budget") {
        lines.push(`Reply with "/budget ${shortId ?? "B-1"} 5" to add credits.`);
      }
    }
    return truncateTelegramText(lines.join("\n"));
  }
  const icon = event.kind === "ci_failure" ? "❌" : "🟢";
  const suffix = formatted.body && formatted.body !== formatted.title ? ` — ${formatted.body}` : "";
  return truncateTelegramText(`${icon} ${formatted.title}${suffix}`);
}

export interface TelegramRelayOptions {
  settings: () => AttentionSettings;
  secretStore?: TelegramSecretStore;
  getLastUpdateId: () => number | undefined;
  setLastUpdateId: (updateId: number | undefined) => void;
  /** Delivers an authorized inbound Telegram message into the ARIA chat (`engine.sendMessage(text, { via: "telegram" })`). */
  onInboundMessage: (text: string) => Promise<void>;
  /** Looks up any pending question/permission/plan/budget short ID and choices for rich outbound formatting. */
  findWaitingForCard?: (cardId: string | undefined) => TelegramWaitingContext | undefined;
  onStatusChange?: (status: TelegramRelayStatus) => void;
  /** Base URL for the Telegram Bot API (default "https://api.telegram.org"; overrideable with loopback URL in tests). */
  apiBaseUrl?: string;
  /** Long-polling timeout parameter in seconds passed to getUpdates (default 25). */
  longPollTimeoutSeconds?: number;
  /** Delay in ms between empty poll responses (default 40). */
  pollIntervalMs?: number;
  /** Initial backoff in ms on network/5xx errors (default 500). */
  retryBaseMs?: number;
  /** Maximum backoff in ms on network/5xx errors (default 30_000). */
  retryMaxMs?: number;
  /** Delay in ms before reading a bot token again that couldn't be read (default 5_000). */
  tokenRetryMs?: number;
  fetch?: typeof globalThis.fetch;
  log?: (msg: string) => void;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class TelegramRelay {
  private readonly secretStore: TelegramSecretStore;
  private readonly fetchFn: typeof globalThis.fetch;
  private status: TelegramRelayStatus = { state: "off" };
  private pollAbort: AbortController | undefined;
  private pollLoopPromise: Promise<void> | undefined;
  private stopped = false;
  private lastTokenSeen?: string;

  constructor(private readonly options: TelegramRelayOptions) {
    this.secretStore = options.secretStore ?? createMemoryTelegramSecretStore();
    this.fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  getStatus(): TelegramRelayStatus {
    return { ...this.status };
  }

  private getBotTokenSafe(): string | undefined {
    try {
      return this.secretStore.getBotToken();
    } catch {
      return undefined;
    }
  }

  hasBotToken(): boolean {
    try {
      return this.secretStore.hasBotToken();
    } catch {
      return false;
    }
  }

  setBotToken(token: string | null): void {
    this.secretStore.setBotToken(token);
    this.sync();
  }

  private setStatus(next: TelegramRelayStatus): void {
    this.status = next;
    this.options.onStatusChange?.({ ...next });
  }

  private isConfigured(): boolean {
    if (this.stopped) return false;
    const settings = this.options.settings();
    return Boolean(
      settings.telegramEnabled === true &&
        this.hasBotToken() &&
        isValidTelegramChatId(settings.telegramChatId),
    );
  }

  /** Starts or stops the polling loop to match current settings and credentials. */
  sync(): void {
    const currentToken = this.hasBotToken() ? this.getBotTokenSafe() : undefined;
    if (currentToken && this.lastTokenSeen !== undefined && currentToken !== this.lastTokenSeen) {
      this.options.setLastUpdateId?.(undefined);
    }
    this.lastTokenSeen = currentToken;

    if (!this.isConfigured()) {
      this.stopPolling();
      if (this.status.state !== "off") {
        this.setStatus({ state: "off" });
      }
      return;
    }
    if (this.pollAbort && !this.pollAbort.signal.aborted) {
      return;
    }
    this.startPolling();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopPolling();
    if (this.pollLoopPromise) {
      await this.pollLoopPromise.catch(() => {
        // Only waiting for it to end: the loop puts its own errors in the relay's status.
      });
    }
    this.setStatus({ state: "off" });
  }

  private stopPolling(): void {
    if (this.pollAbort) {
      this.pollAbort.abort();
      this.pollAbort = undefined;
    }
  }

  private startPolling(): void {
    this.stopPolling();
    const controller = new AbortController();
    this.pollAbort = controller;
    const run = this.runLoop(controller.signal).finally(() => {
      // A loop that ended by itself isn't running: the next sync starts another.
      if (this.pollAbort === controller) {
        this.pollAbort = undefined;
      }
      if (this.pollLoopPromise === run) {
        this.pollLoopPromise = undefined;
      }
    });
    this.pollLoopPromise = run;
  }

  private apiBase(): string {
    return normalizeTelegramApiBaseUrl(this.options.apiBaseUrl);
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    this.setStatus({ ...this.status, state: "starting", error: undefined });
    const baseBackoff = this.options.retryBaseMs ?? 500;
    const maxBackoff = this.options.retryMaxMs ?? 30_000;
    const longPollTimeout = this.options.longPollTimeoutSeconds ?? 25;
    let consecutiveErrors = 0;
    let botUsername = this.status.botUsername;

    while (!signal.aborted && this.isConfigured()) {
      let token: string | undefined;
      let tokenError = "ARIA can't read the saved bot token. If this doesn't clear, save the token again.";
      try {
        token = this.secretStore.getBotToken();
      } catch (err) {
        tokenError = `Keychain error: ${err instanceof Error ? err.message : String(err)}`;
      }
      // It may read again (a locked keyring), or a new one may be saved: either is picked up from here.
      if (!token) {
        this.setStatus({
          ...this.status,
          state: "error",
          error: tokenError,
        });
        await abortableSleep(this.options.tokenRetryMs ?? 5_000, signal);
        continue;
      }
      try {
        // 1. Verify bot identity on first connect
        if (!botUsername) {
          const meRes = await this.fetchFn(`${this.apiBase()}/bot${token}/getMe`, {
            method: "GET",
            signal,
          });
          if (meRes.status === 429) {
            const retryAfter = await this.parseRetryAfter(meRes);
            await abortableSleep(retryAfter * 1000, signal);
            continue;
          }
          const meJson = (await meRes.json().catch(() => undefined)) as
            | { ok?: boolean; result?: { username?: string }; description?: string }
            | undefined;
          if (!meRes.ok || !meJson?.ok) {
            throw new Error(meJson?.description || `Telegram getMe failed (HTTP ${meRes.status})`);
          }
          botUsername = meJson.result?.username || "bot";
        }

        // 2. Establish baseline offset on first run so stale history is never replayed (D74)
        if (this.options.getLastUpdateId() === undefined) {
          const baseUrl = `${this.apiBase()}/bot${token}/getUpdates?offset=-1&timeout=0&allowed_updates=${encodeURIComponent(JSON.stringify(["message"]))}`;
          const baseRes = await this.fetchFn(baseUrl, { method: "GET", signal });
          if (baseRes.status === 429) {
            const retryAfter = await this.parseRetryAfter(baseRes);
            await abortableSleep(retryAfter * 1000, signal);
            continue;
          }
          const baseJson = (await baseRes.json().catch(() => undefined)) as
            | { ok?: boolean; result?: TelegramUpdate[]; description?: string }
            | undefined;
          if (!baseRes.ok || !baseJson?.ok || !Array.isArray(baseJson.result)) {
            throw new Error(baseJson?.description || `Telegram baseline getUpdates failed (HTTP ${baseRes.status})`);
          }
          if (baseJson.result.length > 0) {
            const maxId = Math.max(...baseJson.result.map((u) => u.update_id));
            this.options.setLastUpdateId(maxId);
          } else {
            // Empty history: set baseline offset = 0
            this.options.setLastUpdateId(0);
          }
        }

        if (signal.aborted) break;

        // 3. Long-poll getUpdates with timeout=25
        const lastId = this.options.getLastUpdateId();
        const offset = lastId === undefined || lastId <= 0 ? 0 : lastId + 1;
        const pollUrl = `${this.apiBase()}/bot${token}/getUpdates?offset=${offset}&timeout=${longPollTimeout}&allowed_updates=${encodeURIComponent(JSON.stringify(["message"]))}`;

        this.setStatus({
          ...this.status,
          state: "polling",
          ...(botUsername ? { botUsername } : {}),
          error: undefined,
        });

        const pollRes = await this.fetchFn(pollUrl, { method: "GET", signal });
        if (signal.aborted) break;

        if (pollRes.status === 429) {
          const retryAfter = await this.parseRetryAfter(pollRes);
          await abortableSleep(retryAfter * 1000, signal);
          continue;
        }

        const pollJson = (await pollRes.json().catch(() => undefined)) as
          | {
              ok?: boolean;
              error_code?: number;
              parameters?: { retry_after?: number };
              result?: TelegramUpdate[];
              description?: string;
            }
          | undefined;

        if (pollJson?.error_code === 429 && typeof pollJson.parameters?.retry_after === "number") {
          await abortableSleep(Math.max(1, pollJson.parameters.retry_after) * 1000, signal);
          continue;
        }

        if (!pollRes.ok || !pollJson?.ok || !Array.isArray(pollJson.result)) {
          throw new Error(pollJson?.description || `Telegram getUpdates failed (HTTP ${pollRes.status})`);
        }

        consecutiveErrors = 0;
        const now = Date.now();
        this.setStatus({
          ...this.status,
          state: "polling",
          ...(botUsername ? { botUsername } : {}),
          lastPollAt: now,
          error: undefined,
        });

        const updates = pollJson.result;
        for (const update of updates) {
          if (signal.aborted) break;
          if (typeof update?.update_id !== "number") continue;
          const prevId = this.options.getLastUpdateId() ?? 0;
          if (prevId > 0 && update.update_id <= prevId) continue;
          this.options.setLastUpdateId(update.update_id);

          const expectedChatId = this.options.settings().telegramChatId;
          if (!isAuthorizedTelegramMessage(update.message, expectedChatId)) {
            continue;
          }

          const inboundText = update.message.text.trim().slice(0, TELEGRAM_INBOUND_MAX_CHARS);
          if (!inboundText) continue;

          this.setStatus({
            ...this.status,
            state: "polling",
            ...(botUsername ? { botUsername } : {}),
            lastInboundAt: Date.now(),
            error: undefined,
          });

          try {
            await this.options.onInboundMessage(inboundText);
          } catch (inboundErr) {
            const errMsg = inboundErr instanceof Error ? inboundErr.message : String(inboundErr);
            await this.sendText(`⚠️ ${errMsg}`).catch(() => {
              // Telegram itself is the likely cause then, and there's nowhere else to say so from here.
            });
          }
        }

        const waitMs = updates.length > 0 ? 10 : (this.options.pollIntervalMs ?? 40);
        await abortableSleep(waitMs, signal);
      } catch (error) {
        if (signal.aborted) break;
        consecutiveErrors++;
        const errMsg = error instanceof Error ? error.message : String(error);
        this.options.log?.(`Telegram relay poll error: ${errMsg}`);
        this.setStatus({
          ...this.status,
          state: "error",
          ...(botUsername ? { botUsername } : {}),
          error: errMsg,
        });
        const delay = Math.min(maxBackoff, baseBackoff * 2 ** (consecutiveErrors - 1));
        await abortableSleep(delay, signal);
      }
    }
    // No longer configured, and no sync came to say so.
    if (!signal.aborted && !this.stopped) {
      this.setStatus({ state: "off" });
    }
  }

  private async parseRetryAfter(res: Response): Promise<number> {
    const header = res.headers.get("retry-after");
    if (header) {
      const parsed = Number(header);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    const body = (await res.json().catch(() => undefined)) as { parameters?: { retry_after?: number } } | undefined;
    const fromBody = body?.parameters?.retry_after;
    if (typeof fromBody === "number" && Number.isFinite(fromBody) && fromBody > 0) {
      return fromBody;
    }
    return 1;
  }

  /**
   * Sends a plain-text message to the authorized Telegram chat (no `parse_mode` so markdown characters never fail).
   * Alerts and replies are sent without waiting for an answer, so the log is the only trace of one that didn't go out.
   */
  async sendText(text: string): Promise<{ ok: boolean; error?: string }> {
    const sent = await this.postText(text);
    if (!sent.ok) this.options.log?.(`Telegram sendMessage failed: ${sent.error}`);
    return sent;
  }

  private async postText(text: string): Promise<{ ok: boolean; error?: string }> {
    let token: string | undefined;
    try {
      token = this.secretStore.getBotToken();
    } catch (err) {
      return { ok: false, error: `Keychain error: ${err instanceof Error ? err.message : String(err)}` };
    }
    const chatId = this.options.settings().telegramChatId?.trim();
    if (!token) return { ok: false, error: "Save a Telegram bot token first." };
    if (!isValidTelegramChatId(chatId)) {
      return { ok: false, error: "Enter a valid numeric Telegram Chat / User ID first." };
    }
    const clean = truncateTelegramText(text);
    if (!clean) return { ok: true };
    try {
      const res = await this.fetchFn(`${this.apiBase()}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: clean,
        }),
        signal: AbortSignal.timeout(TELEGRAM_SEND_TIMEOUT_MS),
      });
      const json = (await res.json().catch(() => undefined)) as { ok?: boolean; description?: string } | undefined;
      if (!res.ok || json?.ok === false) {
        return {
          ok: false,
          error: json?.description || `Telegram sendMessage returned HTTP ${res.status}`,
        };
      }
      this.setStatus({
        ...this.status,
        lastOutboundAt: Date.now(),
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async onAssistantReply(text: string): Promise<void> {
    if (!this.isConfigured()) return;
    await this.sendText(text);
  }

  async onAttentionEvent(event: AttentionEvent, priority: "blocking" | "milestone"): Promise<void> {
    if (!this.isConfigured()) return;
    const settings = this.options.settings();
    const scope = settings.telegramOutboundScope ?? "all";
    if (scope === "blocking" && priority !== "blocking") return;
    if (priority === "milestone" && settings.focusMode) return;
    const waitingItem = this.options.findWaitingForCard?.(event.cardId);
    const formatted = formatTelegramAttentionMessage(event, priority, waitingItem);
    await this.sendText(formatted);
  }

  async test(): Promise<{ ok: boolean; botUsername?: string; error?: string }> {
    const token = this.secretStore.getBotToken();
    const chatId = this.options.settings().telegramChatId?.trim();
    if (!token) return { ok: false, error: "Save a Telegram bot token in the OS keychain first." };
    if (!isValidTelegramChatId(chatId)) {
      return { ok: false, error: "Enter a valid numeric Telegram Chat / User ID first." };
    }
    try {
      const meRes = await this.fetchFn(`${this.apiBase()}/bot${token}/getMe`, {
        method: "GET",
        signal: AbortSignal.timeout(TELEGRAM_SEND_TIMEOUT_MS),
      });
      const meJson = (await meRes.json().catch(() => undefined)) as
        | { ok?: boolean; result?: { username?: string }; description?: string }
        | undefined;
      if (!meRes.ok || !meJson?.ok) {
        return {
          ok: false,
          error: meJson?.description || `Telegram getMe returned HTTP ${meRes.status}`,
        };
      }
      const botUsername = meJson.result?.username || "bot";
      const sendResult = await this.sendText("ARIA Telegram relay test: two-way chat is connected.");
      if (!sendResult.ok) {
        return { ok: false, botUsername, ...(sendResult.error ? { error: sendResult.error } : {}) };
      }
      return { ok: true, botUsername };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
