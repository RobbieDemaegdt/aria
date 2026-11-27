import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileLogger,
  FakeRuntime,
  AriaEngine,
  parseLogLevel,
  redact,
  redactText,
  type LogEntry,
} from "../src/index.ts";

const temps: string[] = [];
const engines: AriaEngine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.stop()));
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aria-phase9-log-"));
  temps.push(dir);
  return dir;
}

describe("Phase 9: Secret redaction (redact.ts, D76)", () => {
  it("redacts GitHub tokens, JWTs, sk-* API keys, Slack tokens, and Telegram bot tokens in raw text", () => {
    const ghp = "ghp_1234567890abcdefghijklmnopqrstuv";
    const gho = "gho_abcdef1234567890abcdef1234567890";
    const finePat = "github_pat_11ABCDEF0123456789_abcdefghijklmnopqrstuvwxyz0123456789";
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const skKey = "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz";
    const antKey = "sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz";
    const tgToken = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawX";
    const tgUrl = `https://api.telegram.org/bot${tgToken}/sendMessage`;

    expect(redactText(`Token ${ghp} and ${gho} and ${finePat}`)).toBe(
      "Token <redacted-gh-token> and <redacted-gh-token> and <redacted-gh-token>",
    );
    expect(redactText(`JWT: ${jwt}`)).toBe("JWT: <redacted-jwt>");
    expect(redactText(`Keys: ${skKey}, ${antKey}`)).toBe(
      "Keys: <redacted-api-key>, <redacted-api-key>",
    );
    expect(redactText(`Bot token ${tgToken}`)).toBe("Bot token <redacted-telegram-token>");
    expect(redactText(`POST ${tgUrl}`)).toBe(
      "POST https://api.telegram.org/bot<redacted-telegram-token>/sendMessage",
    );
  });

  it("redacts Authorization headers, URL query secrets (including api-key and subscription-key), userinfo, and CLI flags", () => {
    expect(redactText(`Authorization: ${"Bearer"} secret-bearer-value-12345`)).toContain("<redacted>");
    expect(redactText(`https://${"admin"}:${"supersecret"}@github.com/org/repo.git`)).toBe(
      `https://${"<redacted>"}@github.com/org/repo.git`,
    );

    const urlWithQuery =
      "https://example.com/api?token=abc12345&api-key=key98765&subscription-key=sub55555&client_secret=cs999&safe=1";
    const scrubbedUrl = redactText(urlWithQuery);
    expect(scrubbedUrl).not.toContain("abc12345");
    expect(scrubbedUrl).not.toContain("key98765");
    expect(scrubbedUrl).not.toContain("sub55555");
    expect(scrubbedUrl).not.toContain("cs999");
    expect(scrubbedUrl).toContain("safe=1");

    const cliLine = "curl --token my-secret-token --api-key=my-api-key --password 'topsecret'";
    const scrubbedCli = redactText(cliLine);
    expect(scrubbedCli).not.toContain("my-secret-token");
    expect(scrubbedCli).not.toContain("my-api-key");
    expect(scrubbedCli).not.toContain("topsecret");

    const cliArray = ["node", "cli.js", "--token", "secret-positional-token", "-H", "Authorization: Bearer tok12345678", "--verbose"];
    expect(redact(cliArray)).toEqual([
      "node",
      "cli.js",
      "--token",
      "<redacted>",
      "-H",
      "Authorization: <redacted>",
      "--verbose",
    ]);
  });

  it("handles circular references, Error with nested cause, Map, and Headers instances without throwing", () => {
    const circular: Record<string, unknown> = {
      name: "root",
      apiKey: "super-secret-api-key",
      hasVoiceCloudApiKey: true,
      toolCount: 12,
    };
    circular.self = circular;

    const redactedCircular = redact(circular) as Record<string, unknown>;
    expect(redactedCircular.name).toBe("root");
    expect(redactedCircular.apiKey).toBe("<redacted>");
    expect(redactedCircular.hasVoiceCloudApiKey).toBe(true);
    expect(redactedCircular.toolCount).toBe(12);
    expect(redactedCircular.self).toBe("[Circular]");

    const innerError = new Error("Inner failure with token ghp_1234567890abcdefghijklmnopqrstuv");
    const outerError = new Error("Outer failure calling https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawX/getMe", {
      cause: innerError,
    });
    const redactedErr = redact(outerError) as {
      name: string;
      message: string;
      stack?: string;
      cause?: { name: string; message: string };
    };
    expect(redactedErr.name).toBe("Error");
    expect(redactedErr.message).toContain("<redacted-telegram-token>");
    expect(redactedErr.message).not.toContain("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawX");
    expect(redactedErr.cause?.message).toContain("<redacted-gh-token>");
    expect(redactedErr.cause?.message).not.toContain("ghp_1234567890abcdefghijklmnopqrstuv");

    const headers = new Headers({
      Authorization: "Bearer secret-jwt-token",
      "X-API-Key": "secret-x-api-key",
      "Ocp-Apim-Subscription-Key": "secret-sub-key",
      "Content-Type": "application/json",
    });
    const map = new Map<string, unknown>([
      ["telegramBotToken", "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawX"],
      ["normalKey", "hello"],
    ]);

    const redactedHeaders = redact(headers) as Record<string, unknown>;
    expect(redactedHeaders.authorization).toBe("<redacted>");
    expect(redactedHeaders["x-api-key"]).toBe("<redacted>");
    expect(redactedHeaders["ocp-apim-subscription-key"]).toBe("<redacted>");
    expect(redactedHeaders["content-type"]).toBe("application/json");

    const redactedMap = redact(map) as Record<string, unknown>;
    expect(redactedMap.telegramBotToken).toBe("<redacted>");
    expect(redactedMap.normalKey).toBe("hello");
  });
});

describe("Phase 9: FileLogger rotation, level filtering, and Windows EBUSY/EPERM retry (logger.ts, D76)", () => {
  it("writes redacted JSONL entries, filters by LogLevel, and supports child subsystem loggers", () => {
    const dir = makeTempDir();
    const entries: LogEntry[] = [];
    const logger = new FileLogger({
      logDir: dir,
      level: parseLogLevel("info"),
      onEntry: (e) => entries.push(e),
    });

    logger.debug("tasks", "Debug line should be filtered out");
    const ghLog = logger.child("github");
    ghLog.info("Authenticated with token ghp_1234567890abcdefghijklmnopqrstuv", {
      headers: { Authorization: "Bearer my-secret", Accept: "application/vnd.github+json" },
    });
    logger.error("engine", "Crash error", new Error("Failed with key sk-proj-1234567890abcdefghijklmnop"));

    expect(entries).toHaveLength(2);
    expect(entries[0]?.subsystem).toBe("github");
    expect(entries[0]?.msg).toContain("<redacted-gh-token>");
    expect((entries[0]?.data as any).headers.Authorization).toBe("<redacted>");
    expect((entries[0]?.data as any).headers.Accept).toBe("application/vnd.github+json");

    const rawDisk = readFileSync(path.join(dir, "aria.log"), "utf8").trim().split("\n");
    expect(rawDisk).toHaveLength(2);
    const parsed0 = JSON.parse(rawDisk[0]!) as LogEntry;
    const parsed1 = JSON.parse(rawDisk[1]!) as LogEntry;
    expect(parsed0.msg).not.toContain("ghp_1234567890abcdefghijklmnopqrstuv");
    expect(JSON.stringify(parsed1)).not.toContain("sk-proj-1234567890abcdefghijklmnop");
  });

  it("rotates aria.log -> aria.1.log .. aria.N.log when maxBytes is exceeded and retries on transient Windows EBUSY/EPERM", () => {
    const dir = makeTempDir();
    let renameFailuresRemaining = 2;

    const logger = new FileLogger({
      logDir: dir,
      maxBytes: 300,
      maxFiles: 3,
      retryDelayMs: 1,
      maxRetries: 4,
      fsOps: {
        renameSync: (oldPath, newPath) => {
          if (renameFailuresRemaining > 0) {
            renameFailuresRemaining--;
            const err = Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
            throw err;
          }
          renameSync(oldPath, newPath);
        },
      },
    });

    for (let i = 0; i < 15; i++) {
      logger.info("rotate-test", `Log entry number ${i} with padding ${"x".repeat(60)}`);
    }

    expect(renameFailuresRemaining).toBe(0);
    expect(existsSync(path.join(dir, "aria.log"))).toBe(true);
    expect(existsSync(path.join(dir, "aria.1.log"))).toBe(true);
    expect(existsSync(path.join(dir, "aria.2.log"))).toBe(true);
    expect(existsSync(path.join(dir, "aria.3.log"))).toBe(true);
    expect(existsSync(path.join(dir, "aria.4.log"))).toBe(false);
  });

  it("creates dataDir/logs/aria.log automatically when AriaEngine starts", async () => {
    const dir = makeTempDir();
    const runtime = new FakeRuntime();
    const engine = new AriaEngine({
      dataDir: dir,
      runtime,
      projectRoots: [],
      logLevel: "debug",
    });
    engines.push(engine);
    await engine.start();
    engine.logger("test")?.info("Custom engine log entry", { botToken: "secret-bot-token" });
    await engine.stop();
    engines.pop();

    const logFile = path.join(dir, "logs", "aria.log");
    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("Starting AriaEngine");
    expect(content).toContain("Custom engine log entry");
    expect(content).not.toContain("secret-bot-token");
    expect(content).toContain("Stopped AriaEngine");
  });
});
