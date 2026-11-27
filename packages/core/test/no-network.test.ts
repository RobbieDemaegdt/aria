/**
 * The guard every test runs under (test/no-network.ts, PLAN.md §0.4): nothing off this PC, no GitHub CLI. The hosts
 * refused here are `.invalid` names (reserved: they never resolve), so even a broken guard reaches no real host.
 */
import childProcess from "node:child_process";
import dns from "node:dns";
import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pushEnvironment, pushTarget } from "../src/tasks/push.ts";
import { DEAD_PROXY } from "./no-network.ts";

let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("no-network guard", () => {
  it("refuses fetch to any host but loopback, before anything goes out", async () => {
    await expect(fetch("https://api.aria-guard.invalid/user")).rejects.toThrow(/no-network/);
    await expect(fetch(new URL("https://aria-guard.invalid/"))).rejects.toThrow(/no-network/);
    await expect(fetch(new Request("http://aria-guard.invalid/x"))).rejects.toThrow(/no-network/);
    expect(await (await fetch(`${base}/`)).text()).toBe("ok");
  });

  it("refuses a TCP connection off this PC (every way connect is called), and lets loopback through", async () => {
    expect(() => net.connect({ host: "aria-guard.invalid", port: 443 })).toThrow(/no-network/);
    expect(() => net.connect(443, "aria-guard.invalid")).toThrow(/no-network/);
    expect(() => new net.Socket().connect({ host: "aria-guard.invalid", port: 443 })).toThrow(/no-network/);
    expect(() => new net.Socket().connect(443, "aria-guard.invalid")).toThrow(/no-network/);
    const local = net.connect({ host: "127.0.0.1", port: Number(new URL(base).port) });
    await new Promise<void>((resolve, reject) => {
      local.on("connect", () => resolve());
      local.on("error", reject);
    });
    local.destroy();
  });

  it("git in a test: fsmonitor off and every proxy at a dead loopback port, so an https request fails before credentials", async () => {
    const dir = (await execa("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
    expect((await execa("git", ["-C", dir, "config", "--get", "core.fsmonitor"])).stdout.trim()).toBe("false");
    expect((await execa("git", ["-C", dir, "config", "--get", "http.proxy"])).stdout.trim()).toBe(DEAD_PROXY);
    // A git https request (to a reserved name: even a broken guard reaches no real host) goes to the proxy, which
    // refuses: nothing is resolved, nothing is asked for credentials.
    const tried = await execa("git", ["-c", "credential.helper=", "ls-remote", "https://aria-proxy-guard.invalid/me/moonrise.git"], { reject: false, env: { GIT_TERMINAL_PROMPT: "0" }, timeout: 30_000 });
    expect(tried.exitCode).not.toBe(0);
    expect(tried.stderr).toMatch(/127\.0\.0\.1.*\b9\b|proxy/i);
    expect(tried.stderr).not.toMatch(/Could not resolve host/i);
    // ARIA's push keeps the proxies (it takes only GIT_* and gh's variables out): its git meets the same dead proxy.
    const pushEnv = pushEnvironment(process.env, pushTarget("me", "moonrise", { ghPath: "C:\\aria-guard-nonexistent\\gh.exe" }));
    expect(Object.entries(pushEnv).filter(([k]) => /^https_proxy$/i.test(k)).map(([, v]) => v)).toEqual([DEAD_PROXY]);
    expect(Object.keys(pushEnv).some((k) => /^no_proxy$/i.test(k))).toBe(false);
  });

  // A gh that isn't there (and only `--version`): even a broken guard couldn't run the real one.
  const NO_GH = "C:\\aria-guard-nonexistent\\gh.exe";
  const NO_GH_BARE = "C:\\aria-guard-nonexistent\\gh";

  it("never runs GitHub CLI, by its name at any path, also through execa and cmd; git still runs", async () => {
    expect(() => childProcess.spawn(NO_GH, ["--version"])).toThrow(/never run GitHub CLI/);
    expect(() => childProcess.spawn(NO_GH_BARE, ["--version"])).toThrow(/never run GitHub CLI/);
    expect(() => childProcess.execFileSync(NO_GH, ["--version"])).toThrow(/never run GitHub CLI/);
    expect(() => childProcess.execSync(`${NO_GH} --version`)).toThrow(/never run GitHub CLI/);
    expect(() => childProcess.spawn("cmd.exe", ["/d", "/c", NO_GH, "--version"])).toThrow(/never run GitHub CLI/);
    await expect(execa(NO_GH, ["--version"])).rejects.toThrow(/never run GitHub CLI/);
    expect((await execa("git", ["--version"])).stdout).toMatch(/^git version/);
  });

  it("nor through any shell: PowerShell, bash, sh, Node's shell option, a shell command line; a word like gh-pages isn't gh", () => {
    const quoted = `& '${NO_GH}' --version`;
    expect(() => childProcess.spawn("pwsh", ["-NoProfile", "-Command", quoted])).toThrow(/never run GitHub CLI/);
    expect(() => childProcess.spawn("powershell.exe", ["-NoProfile", "-Command", quoted])).toThrow(/never run GitHub CLI/);
    expect(() => childProcess.spawn("C:\\Program Files\\Git\\bin\\bash.exe", ["-c", `'${NO_GH}' --version`])).toThrow(/never run GitHub CLI/);
    expect(() => childProcess.spawn("sh", ["-c", `"${NO_GH_BARE}" --version`])).toThrow(/never run GitHub CLI/);
    expect(() => childProcess.spawn(`"${NO_GH}" --version`, { shell: true })).toThrow(/never run GitHub CLI/);
    expect(() => childProcess.spawnSync(`"${NO_GH}" --version`, { shell: true })).toThrow(/never run GitHub CLI/);
    expect(() => childProcess.spawnSync("pwsh", ["-NoProfile", "-Command", quoted])).toThrow(/never run GitHub CLI/);
    expect(() => childProcess.execFileSync("bash", ["-c", `'${NO_GH}' --version`])).toThrow(/never run GitHub CLI/);
    expect(() => childProcess.execSync(`pwsh -NoProfile -Command "${quoted}"`)).toThrow(/never run GitHub CLI/);
    expect(childProcess.execSync("echo gh-pages", { encoding: "utf8" })).toMatch(/gh-pages/);
  });

  it("refuses DNS for anything but loopback: lookups, queries (any resolver), reverse lookups", async () => {
    const NAME = "aria-guard.invalid";
    const ignore = () => {};
    expect(() => dns.lookup(NAME, ignore)).toThrow(/no-network/);
    await expect(dns.promises.lookup(NAME)).rejects.toThrow(/no-network/);
    expect(() => dns.resolve4(NAME, ignore)).toThrow(/no-network/);
    expect(() => dns.resolve(NAME, ignore)).toThrow(/no-network/);
    await expect(dns.promises.resolveTxt(NAME)).rejects.toThrow(/no-network/);
    expect(() => new dns.Resolver().resolve6(NAME, ignore)).toThrow(/no-network/);
    await expect(new dns.promises.Resolver().resolveAny(NAME)).rejects.toThrow(/no-network/);
    // A query asks the network's DNS server even for loopback.
    expect(() => dns.reverse("127.0.0.1", ignore)).toThrow(/no-network/);
    await expect(dns.promises.resolve4("localhost")).rejects.toThrow(/no-network/);
    // The system's resolver for loopback names still works (the hosts file).
    expect((await dns.promises.lookup("localhost")).address).toMatch(/^(?:127\.0\.0\.1|::1)$/);
  });

  // The guard wraps the modules' own objects; a named (or namespace) ESM import of a builtin is a copy made when it loads,
  // which the guard can't reach. So no code under test takes child_process's synchronous functions, dns or execa's
  // synchronous calls that way (its asynchronous spawns all go through ChildProcess.prototype.spawn, which is guarded).
  const MODULES = "(?:node:)?(child_process|dns|dns/promises)";
  // A statement at the start of a line (indented too), not the words in a comment: `import … from`, `export … from`.
  const STATEMENT = new RegExp(`^[ \\t]*(import|export)\\s+([^;]*?)\\s+from\\s+["']${MODULES}["']`, "gm");
  // `import("…")` anywhere: its namespace is the same copy (`const { execFileSync } = await import(…)`).
  const DYNAMIC = new RegExp(`\\bimport\\s*\\(\\s*["']${MODULES}["']\\s*\\)`, "g");
  const ASYNC_ONLY = new Set(["spawn", "execFile", "exec", "fork", "ChildProcess"]);
  function unseen(text: string): string[] {
    const problems: string[] = [];
    for (const match of text.matchAll(STATEMENT)) {
      const clause = match[2]!.trim();
      if (clause.startsWith("type ")) continue;
      // (`export … from` passes the same copy on: the same rule.)
      const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? "";
      // The values it takes by name (`type` ones are only types), under their own names.
      const values = named
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith("type "))
        .map((s) => s.split(/\s+as\s+/)[0]!.trim());
      const bad = clause.includes("*") || (match[3] === "child_process" ? values.some((n) => !ASYNC_ONLY.has(n)) : values.length > 0);
      if (bad) problems.push(match[0].trim());
    }
    for (const match of text.matchAll(DYNAMIC)) problems.push(match[0]);
    if (/\bexeca(?:Command)?Sync\b|\$\.sync\b/.test(text)) problems.push("execa's synchronous calls");
    return problems;
  }

  it("the check of what the guard can't see finds every way of taking those modules' functions", () => {
    const flagged = [
      'import { execFileSync } from "node:child_process";',
      'import childProcess, { spawnSync } from "child_process";',
      'import * as cp from "node:child_process";',
      '  import { execSync } from "node:child_process";',
      'export { execFileSync } from "node:child_process";',
      'export * from "node:dns";',
      'const { execFileSync } = await import("node:child_process");',
      'const dns = await import("node:dns/promises");',
      'import { lookup } from "node:dns";',
      'import { resolve4 as r } from "dns/promises";',
      'await execaSync("git", []);',
    ];
    for (const text of flagged) expect(unseen(text), text).not.toEqual([]);
    const allowed = [
      'import childProcess from "node:child_process";',
      'import { execFile, spawn } from "node:child_process";',
      'import type { ChildProcess } from "node:child_process";',
      'import dns from "node:dns";',
      "// a comment: import { execFileSync } from node's child_process module",
    ];
    for (const text of allowed) expect(unseen(text), text).toEqual([]);
  });

  it("no code under test imports what the guard can't see", () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const folders = ["packages/core/src", "packages/core/test", "packages/protocol/src", "apps/desktop/src", "apps/desktop/test"];
    const files = folders.flatMap((folder) =>
      (readdirSync(path.join(root, folder), { recursive: true }) as string[]).filter((f) => /\.(?:[cm]?[jt]sx?)$/.test(f)).map((f) => path.join(root, folder, f)),
    );
    expect(files.length).toBeGreaterThan(50);
    // Not this file: its samples above are strings (and it imports only the modules' own objects).
    const self = fileURLToPath(import.meta.url);
    const problems = files.filter((file) => path.resolve(file) !== path.resolve(self)).flatMap((file) => unseen(readFileSync(file, "utf8")).map((p) => `${path.relative(root, file)}: ${p}`));
    expect(problems).toEqual([]);
  });
});
