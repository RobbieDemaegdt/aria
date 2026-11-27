/**
 * Runs before every test file (vitest `setupFiles`): no test reaches anything off this PC, and none runs GitHub CLI
 * (PLAN.md §0.4: no real GitHub calls while developing; the token from `gh auth token` is never fetched by a test).
 * `fetch`, every TCP connection and every DNS lookup or query for a host that isn't loopback throw before anything goes
 * out, and spawning `gh` (by any path, `gh.exe` too, or through a shell: cmd, PowerShell, bash, sh, Node's `shell`
 * option) throws, also through execa (every asynchronous spawn goes through `ChildProcess.prototype.spawn`).
 *
 * The wrappers sit on the modules' own objects (`import childProcess from "node:child_process"`), which a named ESM
 * import of a builtin doesn't see (it's a copy made when the module loads): no-network.test.ts checks that no code under
 * test imports the synchronous child_process functions or dns that way.
 */
import childProcess from "node:child_process";
import dns from "node:dns";
import net from "node:net";
import path from "node:path";

/**
 * git, for every process a test starts (they inherit this environment; ARIA's push takes GIT_* out of its own and
 * keeps the proxies): fsmonitor off whatever your global config says (with `core.fsmonitor=true`, a plain add or commit
 * in a temp repository starts a daemon that holds the folder), and every proxy setting at a dead loopback port, git's own
 * included, so an https request git might make in a test fails at the proxy before any credential is asked. Node's
 * guards below can't see git's connections. NO_PROXY goes: it could exempt github.com.
 */
export const DEAD_PROXY = "http://127.0.0.1:9";
Object.assign(process.env, {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "core.fsmonitor",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "http.proxy",
  GIT_CONFIG_VALUE_1: DEAD_PROXY,
  HTTPS_PROXY: DEAD_PROXY,
  HTTP_PROXY: DEAD_PROXY,
  ALL_PROXY: DEAD_PROXY,
});
for (const name of Object.keys(process.env)) if (/^(?:https?_proxy|all_proxy)$/i.test(name)) process.env[name] = DEAD_PROXY;
for (const name of Object.keys(process.env)) if (/^no_proxy$/i.test(name)) delete process.env[name];

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);
export const isLoopback = (host: string | undefined) => host === undefined || host === "" || LOOPBACK.has(host.toLowerCase());

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(raw).hostname;
  if (!isLoopback(host)) throw new Error(`no-network: tests make no request off this PC (${host}).`);
  return realFetch(input, init);
}) as typeof fetch;

/**
 * Where a socket would connect, from any of the ways `connect` is called: `(options)`, `(port, host)`, `(path)`, and
 * the array `net.connect` itself passes (`socket.connect([options, callback])`, Node's normalized arguments).
 */
function target(args: unknown[]): { pipe: boolean; host: string | undefined } {
  let first = args[0];
  if (Array.isArray(first)) {
    args = first;
    first = first[0];
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return { pipe: true, host: undefined };
  if (typeof first === "object" && first !== null) {
    const options = first as { host?: unknown; path?: unknown };
    if (typeof options.path === "string") return { pipe: true, host: undefined };
    return { pipe: false, host: typeof options.host === "string" ? options.host : undefined };
  }
  return { pipe: false, host: typeof args[1] === "string" ? args[1] : undefined };
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const { pipe, host } = target(args);
  if (!pipe && !isLoopback(host)) throw new Error(`no-network: tests open no connection off this PC (${host}).`);
  return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

// DNS: a lookup (the system's resolver: hosts file first) of anything but loopback, and any query to the DNS servers
// (resolve*, reverse: even for loopback they'd ask the network's DNS server).
const dnsRefused = (name: unknown) => new Error(`no-network: tests resolve no name off this PC (${String(name)}).`);
const viaSystem = (name: string) => name === "lookup" || name === "lookupService";
const asksDns = (name: string) => viaSystem(name) || name === "reverse" || name.startsWith("resolve");
const methods = (object: object) => Object.getOwnPropertyNames(object).filter((name) => asksDns(name) && typeof (object as Record<string, unknown>)[name] === "function");
function guardDns(object: object, promised: boolean): void {
  const target = object as Record<string, (...args: unknown[]) => unknown>;
  for (const name of methods(object)) {
    const original = target[name]!;
    const local = viaSystem(name);
    target[name] = function (this: unknown, host: unknown, ...rest: unknown[]) {
      if (!local || typeof host !== "string" || !isLoopback(host)) {
        if (promised) return Promise.reject(dnsRefused(host));
        throw dnsRefused(host);
      }
      return original.call(this, host, ...rest);
    };
  }
}
guardDns(dns, false);
guardDns(dns.Resolver.prototype, false);
guardDns(dns.promises, true);
guardDns(dns.promises.Resolver.prototype, true);

export const isGh = (file: unknown) => typeof file === "string" && /^gh(?:\.exe)?$/i.test(path.basename(file.trim().replace(/^"|"$/g, "")));
/** gh as a word of a command line (`gh auth token`, `& 'C:\…\gh.exe' …`), not inside another word (`gh-pages`). */
export const GH_WORD = /(?:^|[\s"'`&|;(\\/])gh(?:\.exe)?(?=$|[\s"'`&|;)])/i;
const SHELL = /^(?:cmd|pwsh|powershell|bash|sh|zsh|dash|wsl)(?:\.exe)?$/i;
const isShell = (file: unknown) => typeof file === "string" && SHELL.test(path.basename(file.trim().replace(/^"|"$/g, "")));
const line = (args: unknown) => (Array.isArray(args) ? args.map(String).join(" ") : "");
/** gh by its own name, or through a shell (one by name, or Node's `shell` option) whose command line has it. */
export const runsGh = (file: unknown, args: unknown, shell: unknown) => isGh(file) || ((isShell(file) || Boolean(shell)) && GH_WORD.test(`${String(file ?? "")} ${line(args)}`));
const GH_REFUSED = "no-network: tests never run GitHub CLI (gh).";

// Every asynchronous spawn (child_process's own functions and execa's) goes through ChildProcess.prototype.spawn, with
// a shell already resolved to its program and arguments. (An internal method, not in Node's typings.)
const prototype = childProcess.ChildProcess.prototype as unknown as { spawn: (this: unknown, options: { file?: unknown; args?: unknown[] }) => unknown };
const spawn = prototype.spawn;
prototype.spawn = function (this: unknown, options: { file?: unknown; args?: unknown[] }) {
  if (runsGh(options?.file, options?.args, false)) throw new Error(GH_REFUSED);
  return spawn.call(this, options);
};
// The synchronous ones don't: they're wrapped where they're exported.
const patched = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>;
for (const name of ["spawnSync", "execFileSync"]) {
  const original = patched[name]!;
  patched[name] = function (this: unknown, file: unknown, ...rest: unknown[]) {
    const args = Array.isArray(rest[0]) ? rest[0] : [];
    const options = (Array.isArray(rest[0]) ? rest[1] : rest[0]) as { shell?: unknown } | undefined;
    if (runsGh(file, args, options?.shell)) throw new Error(GH_REFUSED);
    return original.call(this, file, ...rest);
  };
}
{
  const original = patched.execSync!;
  patched.execSync = function (this: unknown, command: unknown, ...rest: unknown[]) {
    if (typeof command === "string" && GH_WORD.test(command)) throw new Error(GH_REFUSED);
    return original.call(this, command, ...rest);
  };
}
