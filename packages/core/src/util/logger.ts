/**
 * Structured JSONL diagnostic file logger with size-based rotation, Windows EBUSY/EPERM retry backoff,
 * and automatic secret redaction (Phase 9, PLAN.md §4.8, §10 Phase 9, D76).
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { LogLevel } from "@aria/protocol";
import { redact, redactText } from "./redact.ts";

export type { LogLevel } from "@aria/protocol";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  subsystem: string;
  msg: string;
  data?: unknown;
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  child(subsystem: string): Logger;
}

export interface LoggerFsOps {
  existsSync(filePath: string): boolean;
  mkdirSync(dirPath: string, options?: { recursive?: boolean }): void;
  statSync(filePath: string): { size: number };
  appendFileSync(filePath: string, data: string, encoding: BufferEncoding): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(filePath: string): void;
}

export interface FileLoggerOptions {
  /** Directory where aria.log and rotated aria.1.log ... aria.N.log are stored. */
  logDir: string;
  /** Base filename (default "aria.log"). */
  fileName?: string;
  /** Minimum level to write (default "info"). */
  level?: LogLevel;
  /** Maximum size in bytes of the active log file before rotation (default 5 * 1024 * 1024 = 5 MB). */
  maxBytes?: number;
  /** Number of rotated archive files to keep (default 5: aria.1.log .. aria.5.log). */
  maxFiles?: number;
  /** Optional sink called on every recorded entry (for tests or console forwarding). */
  onEntry?: (entry: LogEntry) => void;
  /** Optional filesystem adapter for testing rotation and Windows EBUSY/EPERM retry behavior. */
  fsOps?: Partial<LoggerFsOps>;
  /** Maximum retry attempts on transient Windows EBUSY/EPERM/EACCES locks (default 4). */
  maxRetries?: number;
  /** Base backoff delay in ms for synchronous retry on Windows EBUSY/EPERM (default 5). */
  retryDelayMs?: number;
}

export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_LOG_MAX_FILES = 5;

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function parseLogLevel(raw: string | undefined, fallback: LogLevel = "info"): LogLevel {
  if (!raw) return fallback;
  const norm = raw.trim().toLowerCase();
  if (norm === "debug" || norm === "info" || norm === "warn" || norm === "error") {
    return norm;
  }
  if (norm === "warning") return "warn";
  return fallback;
}

const TRANSIENT_FS_CODES = new Set(["EBUSY", "EPERM", "EACCES", "EAGAIN"]);

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function syncSleep(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(sleepBuffer, 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      // busy wait fallback if Atomics.wait is disallowed on thread
    }
  }
}

function isTransientFsError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && TRANSIENT_FS_CODES.has(code.toUpperCase());
}

export class FileLogger implements Logger {
  readonly logDir: string;
  readonly fileName: string;
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  private minLevel: LogLevel;
  private currentBytes = 0;
  private closed = false;
  private dirCreated = false;
  private readonly onEntry: ((entry: LogEntry) => void) | undefined;
  private readonly fs: LoggerFsOps;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(options: FileLoggerOptions) {
    this.logDir = options.logDir;
    this.fileName = options.fileName ?? "aria.log";
    this.filePath = path.join(this.logDir, this.fileName);
    this.minLevel = options.level ?? "info";
    this.maxBytes = Math.max(256, options.maxBytes ?? DEFAULT_LOG_MAX_BYTES);
    this.maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_LOG_MAX_FILES);
    this.onEntry = options.onEntry;
    this.maxRetries = Math.max(0, options.maxRetries ?? 4);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 5);
    this.fs = {
      existsSync: options.fsOps?.existsSync ?? existsSync,
      mkdirSync: options.fsOps?.mkdirSync ?? ((d, o) => mkdirSync(d, o)),
      statSync: options.fsOps?.statSync ?? ((f) => statSync(f)),
      appendFileSync: options.fsOps?.appendFileSync ?? ((f, d, enc) => appendFileSync(f, d, enc)),
      renameSync: options.fsOps?.renameSync ?? ((a, b) => renameSync(a, b)),
      unlinkSync: options.fsOps?.unlinkSync ?? ((f) => unlinkSync(f)),
    };
    this.initCurrentSize();
  }

  getLevel(): LogLevel {
    return this.minLevel;
  }

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  private withRetry<T>(fn: () => T): T {
    let attempt = 0;
    for (;;) {
      try {
        return fn();
      } catch (err) {
        if (attempt >= this.maxRetries || !isTransientFsError(err)) {
          throw err;
        }
        attempt++;
        syncSleep(this.retryDelayMs * Math.pow(2, attempt - 1));
      }
    }
  }

  private ensureDir(): void {
    if (this.dirCreated) return;
    this.withRetry(() => this.fs.mkdirSync(this.logDir, { recursive: true }));
    this.dirCreated = true;
  }

  private initCurrentSize(): void {
    try {
      this.ensureDir();
      if (this.fs.existsSync(this.filePath)) {
        this.currentBytes = this.fs.statSync(this.filePath).size;
      }
    } catch {
      this.currentBytes = 0;
    }
  }

  /** Path of rotated archive `index` (1..maxFiles), e.g. `aria.1.log`. */
  archivePath(index: number): string {
    const ext = path.extname(this.fileName);
    const stem = ext ? this.fileName.slice(0, -ext.length) : this.fileName;
    return path.join(this.logDir, `${stem}.${index}${ext || ".log"}`);
  }

  private rotateIfNeeded(incomingBytes: number): void {
    if (this.currentBytes === 0) return;
    if (this.currentBytes + incomingBytes <= this.maxBytes) return;

    try {
      const oldest = this.archivePath(this.maxFiles);
      if (this.fs.existsSync(oldest)) {
        this.withRetry(() => this.fs.unlinkSync(oldest));
      }
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const src = this.archivePath(i);
        const dst = this.archivePath(i + 1);
        if (this.fs.existsSync(src)) {
          if (this.fs.existsSync(dst)) {
            this.withRetry(() => this.fs.unlinkSync(dst));
          }
          this.withRetry(() => this.fs.renameSync(src, dst));
        }
      }
      if (this.fs.existsSync(this.filePath)) {
        const firstArchive = this.archivePath(1);
        if (this.fs.existsSync(firstArchive)) {
          this.withRetry(() => this.fs.unlinkSync(firstArchive));
        }
        this.withRetry(() => this.fs.renameSync(this.filePath, firstArchive));
      }
      this.currentBytes = 0;
    } catch {
      // If rotation fails even after retries (e.g. external process holding a lock), keep appending to active log.
    }
  }

  log(level: LogLevel, subsystem: string, msg: string, data?: unknown): void {
    if (this.closed) return;
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return;

    let safeData: unknown;
    if (data !== undefined) {
      try {
        safeData = redact(data);
      } catch {
        safeData = "[Unserializable Log Data]";
      }
    }

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      subsystem: subsystem.trim() || "aria",
      msg: redactText(String(msg)),
      ...(safeData !== undefined ? { data: safeData } : {}),
    };

    try {
      this.onEntry?.(entry);
    } catch {
      // A sink that throws mustn't keep the entry from the log file.
    }

    let line: string;
    try {
      line = `${JSON.stringify(entry)}\n`;
    } catch {
      line = `${JSON.stringify({ ts: entry.ts, level: entry.level, subsystem: entry.subsystem, msg: entry.msg })}\n`;
    }

    const byteLen = Buffer.byteLength(line, "utf8");
    try {
      this.ensureDir();
      this.rotateIfNeeded(byteLen);
      this.withRetry(() => this.fs.appendFileSync(this.filePath, line, "utf8"));
      this.currentBytes += byteLen;
    } catch {
      // Never throw from diagnostic logging
    }
  }

  debug(subsystemOrMsg: string, msgOrData?: unknown, maybeData?: unknown): void {
    if (typeof msgOrData === "string") {
      this.log("debug", subsystemOrMsg, msgOrData, maybeData);
    } else {
      this.log("debug", "aria", subsystemOrMsg, msgOrData);
    }
  }

  info(subsystemOrMsg: string, msgOrData?: unknown, maybeData?: unknown): void {
    if (typeof msgOrData === "string") {
      this.log("info", subsystemOrMsg, msgOrData, maybeData);
    } else {
      this.log("info", "aria", subsystemOrMsg, msgOrData);
    }
  }

  warn(subsystemOrMsg: string, msgOrData?: unknown, maybeData?: unknown): void {
    if (typeof msgOrData === "string") {
      this.log("warn", subsystemOrMsg, msgOrData, maybeData);
    } else {
      this.log("warn", "aria", subsystemOrMsg, msgOrData);
    }
  }

  error(subsystemOrMsg: string, msgOrData?: unknown, maybeData?: unknown): void {
    if (typeof msgOrData === "string") {
      this.log("error", subsystemOrMsg, msgOrData, maybeData);
    } else {
      this.log("error", "aria", subsystemOrMsg, msgOrData);
    }
  }

  child(subsystem: string): Logger {
    return {
      debug: (msg: string, data?: unknown) => this.log("debug", subsystem, msg, data),
      info: (msg: string, data?: unknown) => this.log("info", subsystem, msg, data),
      warn: (msg: string, data?: unknown) => this.log("warn", subsystem, msg, data),
      error: (msg: string, data?: unknown) => this.log("error", subsystem, msg, data),
      child: (sub: string) => this.child(`${subsystem}:${sub}`),
    };
  }

  close(): void {
    this.closed = true;
  }
}
