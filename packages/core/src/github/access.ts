/**
 * Who ARIA reads GitHub as (PLAN.md §4.6): in v1 the token comes from `gh auth token` while ARIA runs. It lives in
 * this module's memory only: never in the database, settings, events, the window, a log line, an error message or a
 * URL. GitHubAccess keeps the access state (signed in, offline, rate limited, …), the global pauses, and the login, and
 * notices when gh's account changes. gh's token only ever goes to https://api.github.com; a test's goes to loopback.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { GitHubState, GitHubStatus } from "@aria/protocol";
import { execa } from "execa";
import type { Clock } from "../attention/clock.ts";
import { GitHubClient, GitHubFailure, type Conditional, type GetResult, type Params, type Route } from "./client.ts";
import type { FetchLike } from "./fetch.ts";
import { login as asLogin } from "./text.ts";

export type TokenResult = { ok: true; token: string; source: string; ignored?: string[] } | { ok: false; reason: "no_cli" | "signed_out"; message: string };
export type TokenSource = () => Promise<TokenResult>;
export type SwitchOutcome = { ok: true } | { ok: false; message: string };
export type AccountSwitcher = (user: string) => Promise<SwitchOutcome>;

/**
 * Where ARIA reads GitHub: github.com (the token from gh), or a test's server on loopback. There are no defaults:
 * the fetch is always given (Chromium's in the desktop app), and gh's token never comes with a test's address.
 */
export type GitHubOptions =
  | { kind: "github.com"; token: TokenSource; fetch: FetchLike; switchAccount?: AccountSwitcher }
  /**
   * A test's GitHub. `pushRoot`: a folder of bare repositories (`<owner>/<repo>.git`) a test's pushes go to, through
   * git configuration (tasks/push.ts), never another command; without it a test run can't push.
   */
  | {
      kind: "test";
      baseUrl: string;
      token: TokenSource;
      fetch: FetchLike;
      pushRoot?: string;
      /** The origins a job log's second hop may go to in a test (loopback only: github/logs.ts checks). */
      logHosts?: string[];
      switchAccount?: AccountSwitcher;
    };

export const GITHUB_API = "https://api.github.com";

/** Variables gh would take a token or a host from instead of its own sign-in (a Copilot app shell sets GH_TOKEN). */
export const GH_STRIPPED = ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
/** The ones worth telling you about when they're set: you may have set them for gh on purpose. */
const TOKEN_VARIABLES = ["GH_TOKEN", "GITHUB_TOKEN"];

/** gh's environment: ARIA's own, without the variables above and COPILOT_*, and without prompts or update checks. */
export function ghEnvironment(source: NodeJS.ProcessEnv): { env: Record<string, string>; ignored: string[] } {
  const env: Record<string, string> = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (GH_STRIPPED.includes(upper) || upper.startsWith("COPILOT_")) {
      if (TOKEN_VARIABLES.includes(upper) && value.trim() && !ignored.includes(upper)) ignored.push(upper);
      continue;
    }
    env[key] = value;
  }
  Object.assign(env, { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", NO_COLOR: "1" });
  return { env, ignored };
}

const envValue = (source: NodeJS.ProcessEnv, name: string) => Object.entries(source).find(([k]) => k.toUpperCase() === name.toUpperCase())?.[1];

/**
 * gh's program on PATH, then where it's installed when it isn't (an app started before gh was installed has an old
 * PATH): only the ones that exist, by full path. Found here, not by the command runner: on Windows, execa runs a
 * command it can't find through cmd.exe, which would make a missing gh look like a gh that failed.
 */
export function findGh(source: NodeJS.ProcessEnv, exists: (file: string) => boolean = existsSync, platform: NodeJS.Platform = process.platform): string[] {
  const p = platform === "win32" ? path.win32 : path.posix;
  const name = platform === "win32" ? "gh.exe" : "gh";
  const onPath = (envValue(source, "PATH") ?? "")
    .split(platform === "win32" ? ";" : ":")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter((dir) => dir !== "" && p.isAbsolute(dir))
    .map((dir) => p.join(dir, name));
  const found: string[] = [];
  for (const file of [...onPath, ...ghInstallPaths(source, platform)]) {
    const key = platform === "win32" ? file.toLowerCase() : file;
    if (!found.some((f) => (platform === "win32" ? f.toLowerCase() : f) === key) && exists(file)) found.push(file);
  }
  return found;
}

/** Where gh is usually installed. */
export function ghInstallPaths(source: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "win32") return ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];
  const get = (name: string) => envValue(source, name);
  const join = path.win32.join;
  const programFiles = get("ProgramFiles") ?? "C:\\Program Files";
  const programFilesX86 = get("ProgramFiles(x86)") ?? "C:\\Program Files (x86)";
  const localAppData = get("LOCALAPPDATA");
  const userProfile = get("USERPROFILE");
  const programData = get("ProgramData") ?? "C:\\ProgramData";
  return [
    join(programFiles, "GitHub CLI", "gh.exe"),
    join(programFilesX86, "GitHub CLI", "gh.exe"),
    ...(localAppData ? [join(localAppData, "Programs", "GitHub CLI", "gh.exe")] : []),
    ...(userProfile ? [join(userProfile, "scoop", "shims", "gh.exe")] : []),
    join(programData, "chocolatey", "bin", "gh.exe"),
  ];
}

export interface ExecOutcome {
  exitCode?: number;
  stdout: string;
  /** The program isn't there. */
  notFound: boolean;
  timedOut: boolean;
}
export type ExecLike = (file: string, args: string[], options: { env: Record<string, string>; timeoutMs: number }) => Promise<ExecOutcome>;

/**
 * Runs gh with exactly `env` (not merged with ARIA's), no stdin, no window. Never throws; its output stays here.
 * Exported for its own test (which runs node, never gh).
 */
export const execGh: ExecLike = async (file, args, { env, timeoutMs }) => {
  const result = await execa(file, args, { env, extendEnv: false, timeout: timeoutMs, reject: false, windowsHide: true, stdin: "ignore" });
  const code = (result as { code?: unknown }).code;
  return { ...(typeof result.exitCode === "number" ? { exitCode: result.exitCode } : {}), stdout: typeof result.stdout === "string" ? result.stdout : "", notFound: code === "ENOENT", timedOut: result.timedOut === true };
};

const NO_CLI =
  "ARIA can't find GitHub CLI (gh) on PATH or in its usual folders. Install it and sign in with `gh auth login`. Trying again only finds it in its usual folders (Program Files, scoop, Chocolatey); installed anywhere else, restart ARIA so it sees the new PATH.";
const SIGNED_OUT = "GitHub CLI isn't signed in. Run `gh auth login` in a terminal, then press Try again.";
const TOKEN_SHAPE = /^[A-Za-z0-9_]{20,255}$/;

/**
 * `gh auth token --hostname github.com`, by gh's full path (on PATH, then gh's usual folders). Only the token's text is
 * kept; gh's output and execa's error text (which holds the output) never reach a message.
 */
export function ghToken(deps: { exec?: ExecLike; env?: NodeJS.ProcessEnv; exists?: (file: string) => boolean; platform?: NodeJS.Platform } = {}): TokenSource {
  return async () => {
    const source = deps.env ?? process.env;
    const { env, ignored } = ghEnvironment(source);
    const exec = deps.exec ?? execGh;
    const candidates = findGh(source, deps.exists ?? existsSync, deps.platform);
    for (const file of candidates) {
      let outcome: ExecOutcome;
      try {
        outcome = await exec(file, ["auth", "token", "--hostname", "github.com"], { env, timeoutMs: 15_000 });
      } catch {
        continue;
      }
      if (outcome.notFound) continue;
      if (outcome.timedOut) return { ok: false, reason: "signed_out", message: "GitHub CLI didn't answer within 15 seconds. Check `gh auth status` in a terminal, then press Try again." };
      if (outcome.exitCode !== 0) return { ok: false, reason: "signed_out", message: SIGNED_OUT };
      const token = outcome.stdout.trim();
      if (!TOKEN_SHAPE.test(token)) return { ok: false, reason: "signed_out", message: "GitHub CLI gave ARIA something that isn't a token. Check `gh auth status` in a terminal, then press Try again." };
      return { ok: true, token, source: "GitHub CLI's sign-in", ...(ignored.length ? { ignored } : {}) };
    }
    return { ok: false, reason: "no_cli", message: NO_CLI };
  };
}

/**
 * `gh auth switch --hostname github.com --user <login>`, by gh's full path, with the same stripped environment as
 * `ghToken` so `GH_TOKEN` / `GITHUB_TOKEN` in ARIA's environment never block switching keyring accounts.
 */
export function ghSwitchAccount(deps: { exec?: ExecLike; env?: NodeJS.ProcessEnv; exists?: (file: string) => boolean; platform?: NodeJS.Platform } = {}): AccountSwitcher {
  return async (rawUser: string) => {
    const target = asLogin(rawUser.trim().replace(/^@/, ""));
    if (!target) return { ok: false, message: "Give a valid GitHub username (for example 'octocat-work')." };
    const source = deps.env ?? process.env;
    const { env } = ghEnvironment(source);
    const exec = deps.exec ?? execGh;
    const candidates = findGh(source, deps.exists ?? existsSync, deps.platform);
    for (const file of candidates) {
      let outcome: ExecOutcome;
      try {
        outcome = await exec(file, ["auth", "switch", "--hostname", "github.com", "--user", target], { env, timeoutMs: 15_000 });
      } catch {
        continue;
      }
      if (outcome.notFound) continue;
      if (outcome.timedOut) {
        return { ok: false, message: "GitHub CLI didn't answer within 15 seconds. Check `gh auth status` in a terminal." };
      }
      if (outcome.exitCode !== 0) {
        return {
          ok: false,
          message: `GitHub CLI couldn't switch to @${target}. Make sure @${target} is signed in on github.com (\`gh auth status\`).`,
        };
      }
      return { ok: true };
    }
    return { ok: false, message: NO_CLI };
  };
}

/** A test's server: http(s) on loopback only, nothing after the origin. */
function loopback(raw: string): string {
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("A test's GitHub has to be on this PC (127.0.0.1, localhost or [::1]).");
  if (url.pathname !== "/" || url.search || url.username || url.password) throw new Error("A test's GitHub address is an origin, with nothing after it.");
  return url.origin;
}

/** How often gh is asked again (another account after `gh auth switch`), and after a problem. */
const TOKEN_CHECK_MS = 30 * 60_000;
const RETRY_GH_MS = 10 * 60_000;
/** A 404 on a watch that worked asks gh again, at most this often (it may be another account now). */
const NOT_FOUND_RECHECK_MS = 5 * 60_000;
const OFFLINE_STEPS = [30_000, 60_000, 120_000, 300_000];
/** Which rate limit a request counts against: My work's searches have their own (30 a minute). */
export type Resource = "core" | "search";
export const resourceOf = (route: Route): Resource => (route.startsWith("GET /search/") ? "search" : "core");

/** GitHub didn't confirm whose token it is (a 5xx, a proxy's 403 page): gh and GET /user are asked again after these. */
const CHECK_STEPS = [30_000, 60_000, 120_000, 300_000];
/** Failures that are GitHub's state as a whole, with their own pause and status (noteFailure). */
const GLOBAL_FAILURES = new Set(["auth", "rate_limited", "secondary_limit", "offline", "stopped"]);
/** Under this many requests left, every interval is four times as long until the reset. */
export const SLOW_BELOW = 500;

export interface AccessDeps {
  clock: Clock;
  log: (line: string) => void;
  /** The state (status, login, pause) changed. */
  changed: () => void;
  /** gh's login is known for the first time (`previous` undefined) or changed. */
  loginChanged: (login: string, previous: string | undefined) => void;
  /** The login ARIA saw last time it ran. */
  storedLogin: () => string | undefined;
  retryBaseMs?: number;
  timeoutMs?: number;
  /** The repositories My work may search (your projects, lowercased "owner/name"): the fetch guard checks every query. */
  searchRepos?: () => ReadonlySet<string>;
  /** Tests: false turns off the throttling plugin's real-time spacing (client.ts). */
  throttle?: boolean;
}

export class GitHubAccess {
  readonly baseUrl: string;
  private token: string | undefined;
  private client: GitHubClient | undefined;
  private status: GitHubStatus = "starting";
  private message: string | undefined;
  private source: string | undefined;
  private ignored: string[] = [];
  private currentLogin: string | undefined;
  /** The global pause: a core limit (or one GitHub didn't say the resource of), a secondary limit, offline, unconfirmed. */
  private pausedUntil: number | undefined;
  /** The search limit's own pause (item 2): My work waits, the watchers don't. */
  private searchPausedUntil: number | undefined;
  private slowUntil: number | undefined;
  private offlineStreak = 0;
  private secondaryStreak = 0;
  private checkStreak = 0;
  private lastTokenAt = Number.NEGATIVE_INFINITY;
  private lastRecheckAt = Number.NEGATIVE_INFINITY;
  private ensuring: Promise<boolean> | undefined;
  private stopped = false;

  constructor(
    private readonly options: GitHubOptions,
    private readonly deps: AccessDeps,
  ) {
    this.baseUrl = options.kind === "github.com" ? GITHUB_API : loopback(options.baseUrl);
  }

  /** A test's origins for a job log's second hop (loopback only); none in normal use (github/logs.ts's own list). */
  get testLogHosts(): readonly string[] | undefined {
    return this.options.kind === "test" ? (this.options.logHosts ?? []).map((origin) => loopback(origin)) : undefined;
  }

  /** The fetch under everything (Chromium's in the app): the log's second hop goes through it, with no token. */
  get rawFetch(): FetchLike {
    return this.options.fetch;
  }

  get login(): string | undefined {
    return this.currentLogin;
  }

  view(): Omit<GitHubState, "inbox"> {
    return {
      status: this.status,
      ...(this.currentLogin ? { login: this.currentLogin } : {}),
      ...(this.source ? { source: this.source } : {}),
      ...(this.ignored.length ? { ignored: [...this.ignored] } : {}),
      ...(this.message ? { message: this.message } : {}),
      ...(this.pausedUntil !== undefined && this.pausedUntil > this.deps.clock.now() ? { pausedUntil: this.pausedUntil } : {}),
    };
  }

  /**
   * Whether a request may go out now: a token that works, and no pause. `search`: My work's searches, which also wait
   * for their own limit (30 a minute); everything else is `core`.
   */
  ready(now = this.deps.clock.now(), resource: Resource = "core"): boolean {
    if (this.stopped || !this.client || this.currentLogin === undefined) return false;
    if (this.status === "token_refused" || this.status === "no_cli" || this.status === "signed_out") return false;
    if (this.pausedUntil !== undefined && this.pausedUntil > now) return false;
    return !(resource === "search" && this.searchPausedUntil !== undefined && this.searchPausedUntil > now);
  }

  /** Until when the search limit is used up (My work says so), if it is. */
  searchPause(now = this.deps.clock.now()): number | undefined {
    return this.searchPausedUntil !== undefined && this.searchPausedUntil > now ? this.searchPausedUntil : undefined;
  }

  /** Few requests left: intervals stretch until the reset. */
  slow(now = this.deps.clock.now()): boolean {
    return this.slowUntil !== undefined && this.slowUntil > now;
  }

  /** Takes the token (and anything shaped like one) out of a text. */
  redact = (text: string): string => {
    let out = text;
    if (this.token && this.token.length >= 8) out = out.split(this.token).join("[token]");
    return out.replace(/\b(?:gh[opsu]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, "[token]");
  };

  /** `always`: tell even when only the pause moved. */
  private set(status: GitHubStatus, message?: string, always = false): void {
    const changed = status !== this.status || message !== this.message;
    this.status = status;
    this.message = message;
    if (changed || always) this.deps.changed();
  }

  /**
   * Makes sure there's a token that works: asks gh when there's none yet, every 30 minutes, or when `force`d (Try
   * again, a 401, a 404 recheck). A missing gh is only looked for again when forced: no timer can install it.
   */
  ensure(force = false): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    if (this.ensuring) return this.ensuring;
    const now = this.deps.clock.now();
    if (!force) {
      if (this.status === "no_cli") return Promise.resolve(false);
      // Offline or rate limited: nothing is asked until the pause is over.
      if (this.pausedUntil !== undefined && this.pausedUntil > now) return Promise.resolve(false);
      if ((this.status === "signed_out" || this.status === "token_refused") && now - this.lastTokenAt < RETRY_GH_MS) return Promise.resolve(false);
      if (this.client && this.currentLogin !== undefined && now - this.lastTokenAt < TOKEN_CHECK_MS && this.status !== "token_refused") return Promise.resolve(true);
    }
    const run = this.refresh(now).finally(() => {
      if (this.ensuring === run) this.ensuring = undefined;
    });
    this.ensuring = run;
    return run;
  }

  private async refresh(now: number): Promise<boolean> {
    this.lastTokenAt = now;
    let result: TokenResult;
    try {
      result = await this.options.token();
    } catch {
      result = { ok: false, reason: "signed_out", message: SIGNED_OUT };
    }
    if (this.stopped) return false;
    if (!result.ok) {
      this.token = undefined;
      this.client = undefined;
      this.set(result.reason, result.message);
      return false;
    }
    this.source = result.source;
    this.ignored = result.ignored ?? [];
    const sameToken = result.token === this.token && this.client !== undefined;
    if (sameToken && this.currentLogin !== undefined && this.status !== "token_refused") return true;
    if (!sameToken) {
      this.token = result.token;
      this.client = new GitHubClient({
        token: result.token,
        baseUrl: this.baseUrl,
        fetch: this.options.fetch,
        log: this.deps.log,
        redact: this.redact,
        ...(this.deps.retryBaseMs !== undefined ? { retryBaseMs: this.deps.retryBaseMs } : {}),
        ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
        ...(this.deps.searchRepos ? { searchRepos: this.deps.searchRepos } : {}),
        ...(this.deps.throttle === false ? { throttle: false } : {}),
      });
    }
    // Who the token belongs to (and whether GitHub takes it at all).
    try {
      const user = await this.client!.get("GET /user", {});
      if (this.stopped) return false;
      const name = user.status === 200 ? asLogin((user.data as { login?: unknown } | null)?.login) : this.currentLogin;
      if (!name) {
        this.set("token_refused", "GitHub didn't say whose token this is. Run `gh auth status` in a terminal, then press Try again.");
        return false;
      }
      const previous = this.currentLogin ?? this.deps.storedLogin();
      const loginMoved = this.currentLogin !== name;
      // The login first: the state the window hears says who ARIA reads GitHub as.
      this.currentLogin = name;
      this.noteSuccess(user.rate);
      this.set("ok", undefined, loginMoved);
      if (previous !== name) this.deps.loginChanged(name, previous);
      return true;
    } catch (error) {
      if (this.stopped) return false;
      // Whose token this is isn't known (the first check, or gh gave a new token): nothing is read with it until it is.
      this.currentLogin = undefined;
      if (error instanceof GitHubFailure && GLOBAL_FAILURES.has(error.type)) this.noteFailure(error);
      else this.unconfirmed(error);
      return false;
    }
  }

  /** GitHub didn't say whose token this is, for no reason of its state as a whole: asked again in a while, not every tick. */
  private unconfirmed(error: unknown): void {
    const now = this.deps.clock.now();
    this.pausedUntil = now + CHECK_STEPS[Math.min(this.checkStreak, CHECK_STEPS.length - 1)]!;
    this.checkStreak++;
    const why = error instanceof GitHubFailure ? error.message : "Its answer couldn't be read.";
    this.set("unavailable", `ARIA couldn't check GitHub CLI's sign-in with GitHub: ${why}`, true);
  }

  /**
   * One read through the current token, with the global consequences of its failure (a pause, another token). Nothing
   * goes out while its resource is paused: the global pause (ensure says no) or, for a search, the search limit's.
   */
  async get(route: Route, params: Params, conditional: Conditional, signal?: AbortSignal): Promise<GetResult> {
    if (!(await this.ensure()) || !this.client) throw new GitHubFailure("auth", this.message ?? "GitHub isn't available.");
    const searchPause = resourceOf(route) === "search" ? this.searchPause() : undefined;
    if (searchPause !== undefined) throw new GitHubFailure("rate_limited", "GitHub's search limit is used up.", { retryAt: searchPause, rate: { remaining: 0, resetAt: searchPause, resource: "search" } });
    const client = this.client;
    // The token this request goes with: a 401 is about that one, not about one gh gave meanwhile. And the login: a
    // request isn't made again as another account (what it read would be that account's).
    const sentWith = this.token;
    const sentAs = this.currentLogin;
    try {
      const result = await client.get(route, params, conditional, signal);
      this.noteSuccess(result.rate);
      return result;
    } catch (error) {
      if (error instanceof GitHubFailure && error.type === "auth" && !this.stopped) {
        // The token may have changed (gh auth login again, or already while this request was out): ask gh once, and
        // try once more with the token it gives, when that isn't the one this request was refused with.
        const before = sentWith;
        const ok = await this.ensure(true);
        if (ok && this.client && this.token !== before) {
          // Another account now: the request isn't made again as it, and the new token isn't "refused" either.
          if (this.currentLogin !== sentAs) throw error;
          const result = await this.client.get(route, params, conditional, signal).catch((again: unknown) => {
            this.noteFailure(again);
            throw again;
          });
          this.noteSuccess(result.rate);
          return result;
        }
        // gh said why itself (signed out, missing, offline): that's the state, not "refused".
        if (!ok) throw error;
      }
      this.noteFailure(error);
      throw error;
    }
  }

  /**
   * The one write (github/write.ts: opening a PR, on your click): `run` gets gh's current token and the API's address
   * for that request, after the same checks as a read (a token that works, the login known, no pause), and keeps no
   * reference to it. GitHub's state as a whole follows from its failure as for a read.
   */
  async write<T>(run: (ctx: { baseUrl: string; token: string; fetch: FetchLike }) => Promise<T>): Promise<T> {
    return this.once(run);
  }

  /**
   * One request of ARIA's own outside the read client, with gh's token: the PR's POST (item 3) and a job log's first
   * hop (item 4). The same checks as a read first; `run` keeps no reference to the token.
   */
  async once<T>(run: (ctx: { baseUrl: string; token: string; fetch: FetchLike }) => Promise<T>): Promise<T> {
    if (!(await this.ensure()) || !this.token || !this.ready()) throw new GitHubFailure("auth", this.message ?? "GitHub isn't available.");
    try {
      return await run({ baseUrl: this.baseUrl, token: this.token, fetch: this.options.fetch });
    } catch (error) {
      if (error instanceof GitHubFailure && GLOBAL_FAILURES.has(error.type) && error.type !== "stopped") this.noteFailure(error);
      throw error;
    }
  }

  private noteSuccess(rate: { remaining: number; resetAt: number; resource?: string } | undefined): void {
    // A search's answer says nothing of the core limit: it ends the search pause only (never the global one).
    if (rate?.resource === "search") {
      if (this.searchPausedUntil !== undefined) {
        this.searchPausedUntil = undefined;
        this.deps.changed();
      }
      return;
    }
    this.offlineStreak = 0;
    this.secondaryStreak = 0;
    this.checkStreak = 0;
    const wasPaused = this.pausedUntil !== undefined;
    this.pausedUntil = undefined;
    if (rate && (rate.resource === undefined || rate.resource === "core")) this.slowUntil = rate.remaining < SLOW_BELOW ? rate.resetAt : undefined;
    if (this.status === "offline" || this.status === "rate_limited" || this.status === "starting" || this.status === "unavailable") this.set("ok");
    else if (wasPaused) this.deps.changed();
  }

  private noteFailure(error: unknown): void {
    if (!(error instanceof GitHubFailure)) return;
    const now = this.deps.clock.now();
    switch (error.type) {
      case "auth":
        this.set("token_refused", "GitHub refused GitHub CLI's token. Run `gh auth login` again in a terminal, then press Try again.");
        return;
      case "rate_limited":
        // The search limit (as GitHub names it) pauses My work only; any other, or one GitHub doesn't name, everything.
        if (error.details.rate?.resource === "search") {
          this.searchPausedUntil = Math.max(error.details.retryAt ?? now + 60_000, now + 5_000);
          this.deps.changed();
          return;
        }
        this.pausedUntil = Math.max(error.details.retryAt ?? now + 60_000, now + 5_000);
        this.set("rate_limited", "GitHub's rate limit is used up: ARIA waits until it resets.", true);
        return;
      // A secondary limit is the account's as a whole: everything waits.
      case "secondary_limit": {
        this.secondaryStreak++;
        const wait = Math.max(60_000, (error.details.retryAt ?? now + 60_000) - now) * 2 ** Math.min(this.secondaryStreak - 1, 5);
        this.pausedUntil = now + Math.min(wait, 3_600_000);
        this.set("rate_limited", "GitHub asked ARIA to slow down: it waits a while.", true);
        return;
      }
      case "offline":
        this.pausedUntil = now + OFFLINE_STEPS[Math.min(this.offlineStreak, OFFLINE_STEPS.length - 1)]!;
        this.offlineStreak++;
        this.set("offline", "GitHub can't be reached: ARIA tries again in a while.", true);
        return;
      default:
        return;
    }
  }

  /** A 404 on a watch that worked: gh may use another account now. Asks gh again, at most every 5 minutes. */
  noteNotFound(): void {
    const now = this.deps.clock.now();
    if (now - this.lastRecheckAt < NOT_FOUND_RECHECK_MS) return;
    this.lastRecheckAt = now;
    void this.ensure(true);
  }

  /** Try again (also for a missing gh: it may be in its usual folder by now). */
  async retry(): Promise<boolean> {
    // A check already on its way may have started before what you fixed: it finishes, then gh and GitHub are asked anew.
    if (this.ensuring) await this.ensuring;
    // A rate limit (core or secondary) waits for GitHub's reset: Try again doesn't send requests into a used-up limit.
    if (this.status !== "rate_limited") this.pausedUntil = undefined;
    this.offlineStreak = 0;
    this.checkStreak = 0;
    return this.ensure(true);
  }

  /**
   * Switches GitHub CLI's active account (`gh auth switch --hostname github.com --user <user>`) on your click on a
   * `github_account` card, then refreshes the token and login (`retry()`).
   */
  async switchAccount(rawUser: string): Promise<void> {
    if (this.stopped) throw new Error("ARIA is stopping.");
    const target = asLogin(rawUser.trim().replace(/^@/, ""));
    if (!target) throw new Error("Give a valid GitHub username (for example 'octocat-work').");
    const switcher = this.options.switchAccount ?? (this.options.kind === "github.com" ? ghSwitchAccount() : undefined);
    if (!switcher) {
      throw new Error("Switching GitHub CLI accounts isn't configured in this test run.");
    }
    const outcome = await switcher(target);
    if (!outcome.ok) {
      throw new Error(this.redact(outcome.message));
    }
    await this.retry();
  }

  /** The PC's clock was set back by `-shift` ms while ARIA ran: the pauses and the times of the last checks move with it. */
  clockMoved(shift: number): void {
    if (this.pausedUntil !== undefined) this.pausedUntil += shift;
    if (this.searchPausedUntil !== undefined) this.searchPausedUntil += shift;
    if (this.slowUntil !== undefined) this.slowUntil += shift;
    this.lastTokenAt += shift;
    this.lastRecheckAt += shift;
  }

  stop(): void {
    this.stopped = true;
    this.token = undefined;
    this.client = undefined;
  }
}
