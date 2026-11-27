import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";
import type { SessionEvent } from "@github/copilot-sdk";

export const OUT_DIR = path.resolve(import.meta.dirname, "..", "..", ".out");

const SECRET_KEY = /authorization|token|secret|password|passwd|cookie|bearer|api[-_]?key|client[-_]?secret|credential/i;
const SECRET_FLAG = /^--?(api[-_]?key|token|access[-_]?token|secret|client[-_]?secret|password|passwd|bearer|auth|authorization|key)$/i;
const SECRET_TEXT: Array<[RegExp, string]> = [
  [/\b(gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "<redacted-token>"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]+)?/g, "<redacted-jwt>"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>"],
  [/(authorization|api[-_]?key|x-api-key)(["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, "$1$2<redacted>"],
  [/([?&](?:access_token|token|key|api_key|apikey|sig|signature|code|client_secret|password)=)[^&\s"']+/gi, "$1<redacted>"],
  [/(--?(?:api[-_]?key|token|secret|password)[= ])\S+/gi, "$1<redacted>"],
];

function redactText(text: string): string {
  return SECRET_TEXT.reduce((s, [re, replacement]) => s.replace(re, replacement), text);
}

/**
 * Deep-copies a value, replacing anything that looks like a credential: values under secret-looking keys, `headers`
 * and `env` maps, the value after a secret-looking CLI flag in argument arrays, and token patterns inside any string.
 * Output in .out/ may be shared, but it can still hold personal work data: never commit it.
 */
export function redact(value: unknown, keyHint = ""): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return SECRET_KEY.test(keyHint) ? "<redacted>" : redactText(value);
  if (Array.isArray(value)) {
    return value.map((v, i) => (i > 0 && typeof value[i - 1] === "string" && SECRET_FLAG.test(value[i - 1] as string) ? "<redacted>" : redact(v, keyHint)));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "headers" || k === "env") {
        out[k] = v && typeof v === "object" ? Object.fromEntries(Object.keys(v).map((h) => [h, "<redacted>"])) : v;
      } else {
        out[k] = redact(v, k);
      }
    }
    return out;
  }
  return value;
}

export function truncate(text: string, max = 220): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export interface RunLog {
  readonly file: string;
  /** Full record to the JSONL file only. */
  record(kind: string, data: unknown): void;
  /** Console line + record. */
  info(message: string, data?: unknown): void;
  /** Section header on the console, data recorded in full. */
  section(title: string, data?: unknown): void;
  close(): Promise<void>;
}

export function createRunLog(name: string): RunLog {
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(OUT_DIR, `${name}-${stamp}.jsonl`);
  const stream: WriteStream = createWriteStream(file, { flags: "a" });
  const record = (kind: string, data: unknown) => {
    stream.write(`${JSON.stringify({ t: new Date().toISOString(), kind, data: redact(data) })}\n`);
  };
  console.log(`[log] ${file}`);
  return {
    file,
    record,
    info(message, data) {
      console.log(redactText(message));
      record("info", data === undefined ? message : { message, data });
    },
    section(title, data) {
      console.log(`\n=== ${title} ===`);
      if (data !== undefined) record(`section:${title}`, data);
    },
    close: () => new Promise<void>((resolve) => stream.end(() => resolve())),
  };
}

const QUIET_EVENTS = new Set([
  "assistant.message_delta",
  "assistant.reasoning_delta",
  "assistant.streaming_delta",
  "tool.execution_progress",
  "tool.shell_output",
  "session.usage_info",
  "session.usage_checkpoint",
]);

/** One console line per interesting event (deltas are skipped); every event is recorded in full. */
export function eventPrinter(log: RunLog, label: string) {
  return (event: SessionEvent) => {
    log.record(`event:${label}`, event);
    if (QUIET_EVENTS.has(event.type)) return;
    const agent = event.agentId ? ` (agent ${event.agentId.slice(0, 8)})` : "";
    const data = "data" in event ? JSON.stringify(redact(event.data)) : "";
    console.log(`  [${label}] ${event.type}${agent} ${truncate(data ?? "")}`);
  };
}
