/**
 * Phone push notifications while away (Phase 8B, PLAN.md §4.7, §10 Phase 8B, D73):
 * Dispatches sanitized plain-text push notifications via ntfy (ntfy.sh or self-hosted) or Pushover when you are away
 * from your desk (including while the PC screen is locked). Secrets live only in `PhoneSecretStore` (OS keychain via
 * Electron's `safeStorage` in the desktop app).
 */
import type { AttentionSettings } from "@aria/protocol";
import { isLoopbackHost } from "../integrations/config.ts";
import type { AttentionEvent, AttentionKind } from "./attention.ts";

export const DEFAULT_NTFY_SERVER_URL = "https://ntfy.sh";
export const DEFAULT_PUSHOVER_ENDPOINT = "https://api.pushover.net/1/messages.json";
const PHONE_PUSH_TIMEOUT_MS = 10_000;

const DISGUISE_CHARS = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/gu;

export interface PhonePushSecrets {
  ntfyToken?: string;
  pushoverAppToken?: string;
  pushoverUserKey?: string;
}

export interface PhoneSecretStore {
  getSecrets(): PhonePushSecrets;
  setSecrets(patch: {
    ntfyToken?: string | null;
    pushoverAppToken?: string | null;
    pushoverUserKey?: string | null;
  }): void;
  hasNtfyToken(): boolean;
  hasPushoverCredentials(): boolean;
}

/**
 * Validates and normalizes an ntfy server base URL.
 * Defaults to `https://ntfy.sh`. Requires `https://` for remote hosts and allows `http://` only for loopback
 * (`127.0.0.1`, `localhost`, `::1`) so self-hosted local instances and offline loopback tests work.
 */
export function normalizeNtfyServerUrl(raw?: string): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return DEFAULT_NTFY_SERVER_URL;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid ntfy server URL.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("The ntfy server URL must not include a username or password.");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) {
    throw new Error("The ntfy server URL must use https:// (or http:// on localhost/127.0.0.1).");
  }
  return parsed.toString().replace(/\/+$/, "");
}

/**
 * Validates an ntfy topic name.
 */
export function validateNtfyTopic(raw?: string): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    throw new Error("Configure an ntfy topic name first (e.g. aria-alerts).");
  }
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(trimmed)) {
    throw new Error("Invalid ntfy topic name: use 1–128 letters, digits, dots, dashes, or underscores.");
  }
  return trimmed;
}

function cleanPhoneText(raw: string, maxChars: number): string {
  const cleaned = raw
    .replace(DISGUISE_CHARS, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1).trimEnd()}…`;
}

function cleanAsciiHeader(raw: string, maxChars = 120): string {
  const cleaned = cleanPhoneText(raw, maxChars).replace(/[^\x20-\x7E]/g, "");
  return cleaned.trim() || "ARIA";
}

/**
 * Formats a sanitized `{ title, body }` payload for phone push notifications (D73).
 * Strips control/disguise characters, omits raw multi-line stack traces on `failed`, and omits untrusted external
 * PR review markdown bodies on `review`, `review_request`, and `pr_closed`.
 */
export function formatPhonePushPayload(
  event: Pick<AttentionEvent, "kind" | "title" | "body" | "task" | "watch">,
  _priority: "blocking" | "milestone",
  shortId?: string,
): { title: string; body: string } {
  const rawTitle = cleanPhoneText(event.title, 110) || "ARIA";
  const prefix = shortId && !rawTitle.includes(shortId) ? `[${shortId}] ` : "";
  const title = cleanPhoneText(`${prefix}${rawTitle}`, 120);

  let body: string;
  if (event.kind === "failed") {
    const firstLine = (event.body ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !/^at\s+\S+/i.test(l));
    const cleanedLine = firstLine ? cleanPhoneText(firstLine.replace(/\s+at\s+\S+\s*\([^)]*\).*$/i, ""), 200) : "";
    body = cleanedLine || "Task failed.";
  } else if (event.kind === "review" || event.kind === "review_request" || event.kind === "pr_closed") {
    const repo = event.watch?.repoName ? cleanPhoneText(event.watch.repoName, 80) : "GitHub";
    const watchTitle = event.watch?.title ? cleanPhoneText(event.watch.title, 120) : "";
    body = watchTitle && !rawTitle.includes(watchTitle) ? `${watchTitle} · ${repo}` : repo;
  } else {
    body = cleanPhoneText(event.body || event.task?.repoName || event.watch?.repoName || "", 300) || title;
  }

  return { title, body };
}

export interface PhonePushRequest {
  id?: string;
  priority: "blocking" | "milestone";
  title: string;
  body: string;
  kind?: AttentionKind;
  taskId?: string;
  cardId?: string;
  shortId?: string;
}

export interface PhoneNotifierOptions {
  settings: () => AttentionSettings;
  secretStore?: PhoneSecretStore;
  pushoverEndpoint?: string;
  fetch?: typeof globalThis.fetch;
  log?: (msg: string) => void;
}

export function createMemoryPhoneSecretStore(initial: PhonePushSecrets = {}): PhoneSecretStore {
  let state: PhonePushSecrets = { ...initial };
  return {
    getSecrets: () => ({ ...state }),
    setSecrets: (patch) => {
      const next: PhonePushSecrets = { ...state };
      if (patch.ntfyToken !== undefined) {
        if (patch.ntfyToken && patch.ntfyToken.trim()) next.ntfyToken = patch.ntfyToken.trim();
        else delete next.ntfyToken;
      }
      if (patch.pushoverAppToken !== undefined) {
        if (patch.pushoverAppToken && patch.pushoverAppToken.trim()) next.pushoverAppToken = patch.pushoverAppToken.trim();
        else delete next.pushoverAppToken;
      }
      if (patch.pushoverUserKey !== undefined) {
        if (patch.pushoverUserKey && patch.pushoverUserKey.trim()) next.pushoverUserKey = patch.pushoverUserKey.trim();
        else delete next.pushoverUserKey;
      }
      state = next;
    },
    hasNtfyToken: () => Boolean(state.ntfyToken?.trim()),
    hasPushoverCredentials: () => Boolean(state.pushoverAppToken?.trim() && state.pushoverUserKey?.trim()),
  };
}

export class PhoneNotifier {
  private readonly secretStore: PhoneSecretStore;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(private readonly options: PhoneNotifierOptions) {
    this.secretStore = options.secretStore ?? createMemoryPhoneSecretStore();
    this.fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  setSecrets(patch: {
    ntfyToken?: string | null;
    pushoverAppToken?: string | null;
    pushoverUserKey?: string | null;
  }): void {
    this.secretStore.setSecrets(patch);
  }

  hasNtfyToken(): boolean {
    try {
      return this.secretStore.hasNtfyToken();
    } catch {
      return false;
    }
  }

  hasPushoverCredentials(): boolean {
    try {
      return this.secretStore.hasPushoverCredentials();
    } catch {
      return false;
    }
  }

  async send(request: PhonePushRequest): Promise<{ ok: boolean; error?: string }> {
    try {
      const settings = this.options.settings();
      const provider = settings.phonePushProvider ?? "off";
      if (provider === "off") {
        return { ok: false, error: "Phone push notifications are turned off." };
      }
      const formatted = formatPhonePushPayload(
        {
          kind: request.kind ?? "question",
          title: request.title,
          body: request.body,
        },
        request.priority,
        request.shortId,
      );
      if (provider === "ntfy") {
        return this.noted(await this.sendNtfy(settings, formatted.title, formatted.body, request.priority));
      }
      if (provider === "pushover") {
        return this.noted(await this.sendPushover(settings, formatted.title, formatted.body, request.priority));
      }
      return { ok: false, error: `Unknown phone push provider: ${String(provider)}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.options.log?.(`Phone push failed: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /** Alerts are sent without waiting for an answer, so the log is the only trace of a push that didn't go out. */
  private noted(sent: { ok: boolean; error?: string }): { ok: boolean; error?: string } {
    if (!sent.ok) this.options.log?.(`Phone push failed: ${sent.error}`);
    return sent;
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    const settings = this.options.settings();
    const provider = settings.phonePushProvider ?? "off";
    if (provider === "off") {
      return { ok: false, error: "Select ntfy or Pushover as your phone push provider first." };
    }
    return this.send({
      priority: "blocking",
      title: "ARIA phone push test",
      body: "Phone notifications are connected and ready for away alerts.",
    });
  }

  private async sendNtfy(
    settings: AttentionSettings,
    title: string,
    body: string,
    priority: "blocking" | "milestone",
  ): Promise<{ ok: boolean; error?: string }> {
    const serverUrl = normalizeNtfyServerUrl(settings.ntfyServerUrl);
    const topic = validateNtfyTopic(settings.ntfyTopic);
    const url = `${serverUrl}/${encodeURIComponent(topic)}`;
    const secrets = this.secretStore.getSecrets();
    const headers: Record<string, string> = {
      "Content-Type": "text/plain; charset=utf-8",
      Title: cleanAsciiHeader(title),
      Priority: priority === "blocking" ? "high" : "default",
      Tags: priority === "blocking" ? "warning" : "white_check_mark",
    };
    if (secrets.ntfyToken?.trim()) {
      headers.Authorization = `Bearer ${secrets.ntfyToken.trim()}`;
    }
    const res = await this.fetchFn(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(PHONE_PUSH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        error: `ntfy returned HTTP ${res.status}${detail.trim() ? `: ${cleanPhoneText(detail, 180)}` : ""}`,
      };
    }
    return { ok: true };
  }

  private async sendPushover(
    settings: AttentionSettings,
    title: string,
    body: string,
    priority: "blocking" | "milestone",
  ): Promise<{ ok: boolean; error?: string }> {
    const secrets = this.secretStore.getSecrets();
    const appToken = secrets.pushoverAppToken?.trim();
    const userKey = secrets.pushoverUserKey?.trim();
    if (!appToken || !userKey) {
      return { ok: false, error: "Save your Pushover application token and user key first." };
    }
    const endpoint = (this.options.pushoverEndpoint ?? DEFAULT_PUSHOVER_ENDPOINT).trim();
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      return { ok: false, error: "Invalid Pushover endpoint URL." };
    }
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) {
      return { ok: false, error: "Pushover endpoint must use https://." };
    }
    const payload: Record<string, unknown> = {
      token: appToken,
      user: userKey,
      title,
      message: body,
      priority: priority === "blocking" ? 1 : 0,
      ...(settings.pushoverDevice?.trim() ? { device: settings.pushoverDevice.trim() } : {}),
    };
    const res = await this.fetchFn(parsed.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(PHONE_PUSH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Pushover returned HTTP ${res.status}${detail.trim() ? `: ${cleanPhoneText(detail, 180)}` : ""}`,
      };
    }
    return { ok: true };
  }
}
