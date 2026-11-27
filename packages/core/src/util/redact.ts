/**
 * Deep, circular-safe secret redaction for diagnostic logs and error output (Phase 9, PLAN.md §4.8, §10 Phase 9, D76).
 * Scrubs bearer tokens, GitHub PATs/OAuth tokens, JWTs, cloud API keys, Telegram/Pushover/ntfy credentials,
 * HTTP authentication headers, URL query secrets, CLI flags, Error causes, and Map/Headers instances.
 */

/** Exact object/header keys whose string values are always redacted in full. */
export const SECRET_KEY =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|ocp-apim-subscription-key|subscription[-_]?key|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|bot[-_]?token|ntfy[-_]?token|pushover[-_]?app[-_]?token|pushover[-_]?user[-_]?key|bearer[-_]?token|auth[-_]?token|oauth[-_]?token|secret|client[-_]?secret|password|passwd|pwd|credential|credentials|private[-_]?key|connection[-_]?string|gh[-_]?token|github[-_]?token|copilot[-_]?github[-_]?token|token)$/i;

/** Substring match for camelCase / snake_case / kebab-case secret keys (e.g. `voiceCloudApiKey`, `telegramBotToken`). */
export const SECRET_KEY_SUBSTRING =
  /(?:authorization|cookie|api[_-]?key|apikey|subscription[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|bot[_-]?token|bearer[_-]?token|auth[_-]?token|oauth[_-]?token|ntfy[_-]?token|pushover[_-]?(?:app[_-]?token|user[_-]?key)|client[_-]?secret|private[_-]?key|password|passwd|secret[_-]?key|gh[_-]?token|github[_-]?token|enterprise[_-]?token)/i;

/** Keys that contain words like "token" or "key" but hold non-secret identifiers or counts. */
const NON_SECRET_KEY =
  /^(?:has[A-Z_].*|is[A-Z_].*|.*(?:Count|Length|Status|State|Type|Kind|Scope|Mode|Provider|Endpoint|Url|Host|Path|Dir|Name|Id|At|Ms|Seconds|Minutes|Credits|Nano|Percent|Model|Effort)|targetKey|pathKey|urlKey|name_key|path_key|target_key|threadToken|replyToMessageId|toolCallId|requestId|sessionId|installationId|loginId)$/i;

/** CLI flags whose following positional argument is a secret value. */
export const SECRET_FLAG =
  /^--?(?:api[-_]?key|apikey|subscription[-_]?key|token|access[-_]?token|refresh[-_]?token|bot[-_]?token|ntfy[-_]?token|secret|client[-_]?secret|password|passwd|bearer|auth|authorization|key)$/i;

/** CLI header flags (`-H`, `--header`) whose following argument may contain `Authorization: ...` or `X-API-Key: ...`. */
const HEADER_FLAG = /^(?:-H|--header)$/i;

/** Inline string patterns replaced with `<redacted-...>` placeholders. */
const SECRET_TEXT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // GitHub classic & fine-grained PATs, OAuth, user-to-server, server-to-server, refresh tokens
  [/\b(?:gh[opusr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|v1\.[0-9a-f]{40,})\b/g, "<redacted-gh-token>"],
  // JSON Web Tokens (header.payload.signature)
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "<redacted-jwt>"],
  // OpenAI / Anthropic / cloud API keys (sk-..., sk-ant-..., sk-proj-..., sk-live-..., sk-test-...)
  [/\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g, "<redacted-api-key>"],
  // Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-, xoxs-)
  [/\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g, "<redacted-token>"],
  // Telegram bot tokens in URLs (/bot<id>:<secret>/) or standalone (<id>:<35-char secret>)
  [/(\/bot)\d{6,12}:[A-Za-z0-9_-]{24,}/g, "$1<redacted-telegram-token>"],
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, "<redacted-telegram-token>"],
  // Authorization: Bearer / Basic / Token / Digest in raw text
  [/\b(Bearer|Basic|Token|Digest)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>"],
  // URL userinfo (https://user:pass@host)
  [/(\bhttps?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1<redacted>@"],
  // URL query parameters (?token=..., &api-key=..., &subscription-key=..., &sig=..., &client_secret=...)
  [
    /([?&](?:access[-_]?token|refresh[-_]?token|id[-_]?token|bot[-_]?token|ntfy[-_]?token|auth[-_]?token|token|api[-_]?key|apikey|subscription[-_]?key|ocp-apim-subscription-key|key|sig|signature|code|client[-_]?secret|password|passwd|secret|auth)=)[^&\s"'#]+/gi,
    "$1<redacted>",
  ],
  // CLI flags with = or space (--token=xyz, --api-key xyz, --password "secret")
  [
    /(--?(?:api[-_]?key|apikey|subscription[-_]?key|token|access[-_]?token|refresh[-_]?token|bot[-_]?token|ntfy[-_]?token|secret|client[-_]?secret|password|passwd|bearer)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s"',;}\]>]+)/gi,
    "$1<redacted>",
  ],
  // Key-value assignments in text or headers (authorization: ..., api_key=..., x-api-key: ..., subscription-key: ...)
  [
    /((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|ocp-apim-subscription-key|subscription[-_]?key|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|client[-_]?secret|bot[-_]?token|ntfy[-_]?token|pushover[-_]?app[-_]?token|pushover[-_]?user[-_]?key|private[-_]?key|password|passwd|secret|token)["']?\s*[:=]\s*["']?)(?:Bearer\s+|Basic\s+|Token\s+)?(?!<redacted)[^\s"',;}\]>&]+/gi,
    "$1<redacted>",
  ],
];

/** Returns true if `key` names a secret property or header. */
export function isSecretKeyName(key: string): boolean {
  const trimmed = key.trim();
  if (!trimmed) return false;
  if (SECRET_KEY.test(trimmed)) return true;
  if (NON_SECRET_KEY.test(trimmed)) return false;
  return SECRET_KEY_SUBSTRING.test(trimmed);
}

/** Scrubs inline secret patterns from a plain string. */
export function redactText(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [pattern, replacement] of SECRET_TEXT_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function isHeadersLike(value: object): value is { entries(): IterableIterator<[string, string]> } {
  return (
    typeof Headers !== "undefined" && value instanceof Headers
  );
}

export const MAX_REDACT_DEPTH = 50;

/**
 * Recursively clones and scrubs `value`, replacing any secret strings, headers, env vars, URL query tokens,
 * CLI flag arguments, and Error messages/stacks/causes with `<redacted>` placeholders.
 * Handles circular references safely (`"[Circular]"`).
 */
export function redact(value: unknown, keyHint = "", seen: WeakSet<object> = new WeakSet<object>(), depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "bigint") return value;
  if (typeof value === "string") {
    if (keyHint && isSecretKeyName(keyHint)) return "<redacted>";
    return redactText(value);
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (typeof value !== "object") return value;

  if (depth > MAX_REDACT_DEPTH) return "[Deep Object]";

  if ( value instanceof Date) return value.toISOString();
  if (value instanceof RegExp) return value.toString();
  if (value instanceof URL) return redactText(value.toString());
  if (typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams) {
    return redactText(`?${value.toString()}`).replace(/^\?/, "");
  }

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const prev = i > 0 ? value[i - 1] : undefined;
      const item = value[i];
      if (typeof prev === "string" && SECRET_FLAG.test(prev.trim()) && typeof item === "string") {
        out.push("<redacted>");
      } else if (typeof prev === "string" && HEADER_FLAG.test(prev.trim()) && typeof item === "string") {
        out.push(redactHeaderLine(item));
      } else {
        out.push(redact(item, "", seen, depth + 1));
      }
    }
    return out;
  }

  if (value instanceof Set) {
    return [...value].map((item) => redact(item, keyHint, seen, depth + 1));
  }

  if (value instanceof Error) {
    const errObj: Record<string, unknown> = {
      name: value.name,
      message: redactText(value.message),
    };
    if (typeof value.stack === "string") {
      errObj.stack = redactText(value.stack);
    }
    const withCause = value as Error & { cause?: unknown; code?: unknown };
    if (withCause.code !== undefined) {
      errObj.code = redact(withCause.code, "code", seen, depth + 1);
    }
    if (withCause.cause !== undefined) {
      errObj.cause = redact(withCause.cause, "cause", seen, depth + 1);
    }
    for (const [k, v] of Object.entries(value as unknown as Record<string, unknown>)) {
      if (!(k in errObj)) {
        errObj[k] = redact(v, k, seen, depth + 1);
      }
    }
    return errObj;
  }

  if (isHeadersLike(value)) {
    const headersOut: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      headersOut[k] = isSecretHeader(k) ? "<redacted>" : redactText(String(v));
    }
    return headersOut;
  }

  if (value instanceof Map) {
    const mapOut: Record<string, unknown> = {};
    const inHeadersOrEnv = /^headers$/i.test(keyHint);
    for (const [ rawK, v] of value.entries()) {
      const k = String(rawK);
      if (inHeadersOrEnv && isSecretHeader(k) && typeof v === "string") {
        mapOut[k] = "<redacted>";
      } else {
        mapOut[k] = redact(v, k, seen, depth + 1);
      }
    }
    return mapOut;
  }

  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const isHeadersMap = /^headers$/i.test(keyHint);
  const isEnvMap = /^env$/i.test(keyHint);

  for (const [k, v] of Object.entries(record)) {
    if (v !== null && v !== undefined && typeof v !== "boolean" && typeof v !== "number") {
      if (isHeadersMap && isSecretHeader(k)) {
        out[k] = "<redacted>";
        continue;
      }
      if (isEnvMap && isSecretEnv(k)) {
        out[k] = "<redacted>";
        continue;
      }
      if (isSecretKeyName(k)) {
        out[k] = "<redacted>";
        continue;
      }
    }
    out[k] = redact(v, k, seen, depth + 1);
  }
  return out;
}

function isSecretHeader(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (
    lower === "accept" ||
    lower === "content-type" ||
    lower === "content-length" ||
    lower === "user-agent" ||
    lower === "cache-control" ||
    lower === "accept-encoding" ||
    lower === "accept-language" ||
    lower === "connection" ||
    lower === "host"
  ) {
    return false;
  }
  return (
    isSecretKeyName(lower) ||
    lower.includes("token") ||
    lower.includes("secret") ||
    lower.includes("key") ||
    lower.includes("auth") ||
    lower.includes("cookie") ||
    lower.includes("credential") ||
    lower.includes("session")
  );
}

function isSecretEnv(name: string): boolean {
  const upper = name.trim().toUpperCase();
  if (upper === "PATH" || upper === "HOME" || upper === "USERPROFILE" || upper === "TEMP" || upper === "TMP" || upper === "APPDATA" || upper === "LOCALAPPDATA") {
    return false;
  }
  return (
    isSecretKeyName(upper) ||
    /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL|AUTH|COOKIE|CONNECTION_STRING|SUBSCRIPTION_KEY)/.test(upper)
  );
}

function redactHeaderLine(line: string): string {
  const colon = line.indexOf(":");
  if (colon > 0) {
    const headerName = line.slice(0, colon).trim();
    if (isSecretHeader(headerName)) {
      return `${line.slice(0, colon + 1)} <redacted>`;
    }
  }
  return redactText(line);
}
