/**
 * Who ARIA reads GitHub as (github/access.ts, PLAN.md §4.6): gh's token (with a stand-in for gh: tests never run it),
 * the access state, the global pauses, and a changed account. GitHub is the local mock; a github.com access gets a
 * fetch that records and never networks.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManualClock } from "../src/attention/clock.ts";
import { execGh, findGh, GitHubAccess, ghEnvironment, ghInstallPaths, ghSwitchAccount, ghToken, type ExecLike, type TokenResult } from "../src/github/access.ts";
import type { FetchLike } from "../src/github/fetch.ts";
import { MOCK_TOKEN, MockGitHub } from "./mock-github.ts";
import { waitMs } from "./helpers.ts";

const TOKEN_TEXT = "gho_aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gH3j";

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > waitMs(ms)) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function stubExec(outcomes: Record<string, { exitCode?: number; stdout?: string; notFound?: boolean; timedOut?: boolean } | "throw">) {
  const calls: Array<{ file: string; args: string[]; env: Record<string, string> }> = [];
  const exec: ExecLike = async (file, args, { env }) => {
    calls.push({ file, args, env });
    const outcome = outcomes[file] ?? { notFound: true };
    if (outcome === "throw") throw new Error(`Command failed with exit code 1: gh auth token\n\n${TOKEN_TEXT}`);
    return { stdout: outcome.stdout ?? "", notFound: outcome.notFound ?? false, timedOut: outcome.timedOut ?? false, ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}) };
  };
  return { calls, exec };
}

describe("ghToken: GitHub CLI's token, from gh itself (a stand-in here)", () => {
  const env = { PATH: "C:\\bin", GH_TOKEN: "ghp_fromAShell", GITHUB_TOKEN: "x", GH_HOST: "ghe.example", gh_enterprise_token: "y", COPILOT_AGENT_TOKEN: "z", USERPROFILE: "C:\\Users\\me", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", ProgramFiles: "C:\\Program Files" };

  const onPath = "C:\\bin\\gh.exe";

  it("runs gh by its full path on PATH (auth token --hostname github.com), without the variables gh would take a token or host from", async () => {
    const { calls, exec } = stubExec({ [onPath]: { exitCode: 0, stdout: `${TOKEN_TEXT}\n` } });
    const result = await ghToken({ exec, env, exists: (f) => f === onPath, platform: "win32" })();
    expect(result).toEqual({ ok: true, token: TOKEN_TEXT, source: "GitHub CLI's sign-in", ignored: ["GH_TOKEN", "GITHUB_TOKEN"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe(onPath);
    expect(calls[0]!.args).toEqual(["auth", "token", "--hostname", "github.com"]);
    const sent = calls[0]!.env;
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "gh_enterprise_token", "COPILOT_AGENT_TOKEN"]) expect(sent).not.toHaveProperty(key);
    expect(sent).toMatchObject({ PATH: "C:\\bin", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" });
  });

  it("looks in gh's usual folders when it isn't on PATH (an app started before gh was installed)", async () => {
    const program = "C:\\Program Files\\GitHub CLI\\gh.exe";
    const { calls, exec } = stubExec({ [program]: { exitCode: 0, stdout: TOKEN_TEXT } });
    const result = await ghToken({ exec, env, exists: (f) => f === program, platform: "win32" })();
    expect(result).toMatchObject({ ok: true, token: TOKEN_TEXT });
    expect(calls.map((c) => c.file)).toEqual([program]);
    expect(ghInstallPaths(env, "win32")).toEqual([
      "C:\\Program Files\\GitHub CLI\\gh.exe",
      "C:\\Program Files (x86)\\GitHub CLI\\gh.exe",
      "C:\\Users\\me\\AppData\\Local\\Programs\\GitHub CLI\\gh.exe",
      "C:\\Users\\me\\scoop\\shims\\gh.exe",
      "C:\\ProgramData\\chocolatey\\bin\\gh.exe",
    ]);
  });

  it("findGh: PATH first (quoted folders too, relative ones never), then the usual folders, each once, only what exists", () => {
    const there = new Set(["C:\\Tools\\gh.exe", "C:\\Program Files\\GitHub CLI\\gh.exe"]);
    const found = findGh({ PATH: '.;relative\\dir;"C:\\Tools";C:\\Missing;C:\\Program Files\\GitHub CLI', ProgramFiles: "C:\\Program Files" }, (f) => there.has(f), "win32");
    expect(found).toEqual(["C:\\Tools\\gh.exe", "C:\\Program Files\\GitHub CLI\\gh.exe"]);
  });

  it("no gh anywhere: nothing runs, and it says that trying again only finds it in its usual folders", async () => {
    const { calls, exec } = stubExec({});
    const result = await ghToken({ exec, env, exists: () => false, platform: "win32" })();
    expect(result).toMatchObject({ ok: false, reason: "no_cli" });
    expect((result as { message: string }).message).toMatch(/restart ARIA/);
    expect(calls).toEqual([]);
  });

  it.each([
    ["signed out (exit 1)", { exitCode: 1, stdout: "" }],
    ["too slow", { timedOut: true }],
    ["something that isn't a token", { exitCode: 0, stdout: "Welcome to GitHub CLI\nline two" }],
  ])("%s: signed_out, with ARIA's own words (never gh's output)", async (_what, outcome) => {
    const { exec } = stubExec({ [onPath]: outcome });
    const result = await ghToken({ exec, env, exists: (f) => f === onPath, platform: "win32" })();
    expect(result).toMatchObject({ ok: false, reason: "signed_out" });
    expect(JSON.stringify(result)).not.toContain("Welcome");
  });

  it("an exec that throws (its message holds gh's output) goes on to the next place, and its text goes nowhere", async () => {
    const { exec } = stubExec({ [onPath]: "throw" });
    const result = await ghToken({ exec, env, exists: (f) => f === onPath, platform: "win32" })();
    expect(result).toMatchObject({ ok: false, reason: "no_cli" });
    expect(JSON.stringify(result)).not.toContain(TOKEN_TEXT);
  });

  it("the runner gives the program exactly that environment (ARIA's own isn't merged back), and says when it's missing or slow (node here, never gh)", async () => {
    const before = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_setInAriaEnvironment0000000000";
    try {
      const { env: clean } = ghEnvironment(process.env);
      const listed = await execGh(process.execPath, ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], { env: clean, timeoutMs: 20_000 });
      expect(listed.exitCode).toBe(0);
      const keys = JSON.parse(listed.stdout) as string[];
      expect(keys.map((k) => k.toUpperCase())).not.toContain("GH_TOKEN");
      expect(keys).toContain("GH_PROMPT_DISABLED");
    } finally {
      if (before === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = before;
    }
    // (A missing program isn't the runner's to find: execa would run it through cmd.exe; findGh looks first.)
    expect(await execGh(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }, timeoutMs: 300 })).toMatchObject({ timedOut: true });
  });

  it("ghEnvironment: letter case doesn't hide a variable", () => {
    const { env: out, ignored } = ghEnvironment({ Gh_Token: "a", github_token: "b", Path: "p" });
    expect(out).not.toHaveProperty("Gh_Token");
    expect(out).not.toHaveProperty("github_token");
    expect(ignored).toEqual(["GH_TOKEN", "GITHUB_TOKEN"]);
  });

  it("ghSwitchAccount: runs gh auth switch --hostname github.com --user <login> without GH_TOKEN and validates the login", async () => {
    const { calls, exec } = stubExec({ [onPath]: { exitCode: 0, stdout: "" } });
    const switcher = ghSwitchAccount({ exec, env, exists: (f) => f === onPath, platform: "win32" });
    expect(await switcher("@octocat-work")).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe(onPath);
    expect(calls[0]!.args).toEqual(["auth", "switch", "--hostname", "github.com", "--user", "octocat-work"]);
    expect(calls[0]!.env).not.toHaveProperty("GH_TOKEN");

    expect(await switcher("not a valid login!")).toMatchObject({ ok: false, message: expect.stringMatching(/valid GitHub username/) });
    const failing = ghSwitchAccount({
      exec: stubExec({ [onPath]: { exitCode: 1, stdout: "" } }).exec,
      env,
      exists: (f) => f === onPath,
      platform: "win32",
    });
    expect(await failing("octocat-work")).toMatchObject({
      ok: false,
      message: expect.stringMatching(/couldn't switch to @octocat-work/),
    });
  });
});

describe("GitHubAccess", () => {
  let mock: MockGitHub;
  let clock: ManualClock;
  beforeEach(async () => {
    mock = new MockGitHub();
    await mock.start();
    clock = new ManualClock(Date.now());
  });
  afterEach(() => mock.stop());

  function access(tokens: TokenResult[], stored?: string) {
    const logins: Array<[string, string | undefined]> = [];
    const views: Array<ReturnType<GitHubAccess["view"]>> = [];
    let asked = 0;
    const a: GitHubAccess = new GitHubAccess(
      { kind: "test", baseUrl: mock.baseUrl, fetch: (url, init) => fetch(url, init), token: async () => tokens[Math.min(asked++, tokens.length - 1)]! },
      { clock, log: () => {}, changed: () => views.push(a.view()), loginChanged: (login, previous) => logins.push([login, previous]), storedLogin: () => stored, retryBaseMs: 1, searchRepos: () => new Set(["me/moonrise"]), throttle: false },
    );
    return { a, logins, views, asked: () => asked };
  }
  const ok = (token = MOCK_TOKEN): TokenResult => ({ ok: true, token, source: "test" });

  it("checks the token with GET /user and knows the login (the window hears ok with the login, never without)", async () => {
    const { a, logins, views } = access([ok()]);
    expect(a.ready()).toBe(false);
    expect(await a.ensure()).toBe(true);
    expect(a.ready()).toBe(true);
    expect(a.view()).toMatchObject({ status: "ok", login: "sam-test", source: "test" });
    expect(views.filter((v) => v.status === "ok")).not.toHaveLength(0);
    expect(views.filter((v) => v.status === "ok").every((v) => v.login === "sam-test")).toBe(true);
    expect(logins).toEqual([["sam-test", undefined]]);
    // Within 30 minutes gh isn't asked again.
    expect(await a.ensure()).toBe(true);
    expect(mock.count(/^\/user$/)).toBe(1);
  });

  it("a 401 asks gh again once; a new token is used and the request tried again", async () => {
    const { a, asked } = access([ok(), ok("gho_secondTokenAfterLogin00000000000000")]);
    await a.ensure();
    mock.token = "gho_secondTokenAfterLogin00000000000000";
    const answer = await a.get("GET /user", {}, {});
    expect(answer.status).toBe(200);
    expect(asked()).toBe(2);
    expect(a.view().status).toBe("ok");
  });

  it("a 401 for a request sent with the old token, answered after gh's new one is in: tried again with the new one, not 'refused'", async () => {
    const NEW = "gho_secondTokenAfterLogin00000000000000";
    const { a } = access([ok(), ok(NEW)]);
    await a.ensure();
    mock.addRepo("me", "moonrise");
    // GitHub takes only the new token now; a request goes out with the old one (its 401 takes 300 ms), and meanwhile
    // gh is asked again (Try again) and gives the new one, which is in place when that 401 comes.
    mock.token = NEW;
    mock.delayMs = 300;
    const slow = a.get("GET /repos/{owner}/{repo}", { owner: "me", repo: "moonrise" }, {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    const retried = a.retry();
    expect((await slow).status).toBe(200);
    expect(await retried).toBe(true);
    mock.delayMs = 0;
    expect(a.view()).toMatchObject({ status: "ok", login: "sam-test" });
  });

  it("a 401 answered after gh switched account: not made again as the other account, and the new token isn't 'refused'", async () => {
    const WORK = "gho_workAccountToken000000000000000000";
    const { a } = access([ok(), ok(WORK)]);
    await a.ensure();
    mock.addRepo("me", "moonrise");
    mock.token = WORK;
    mock.login = "sam-work";
    const repoReads = () => mock.count(/^\/repos\/me\/moonrise$/);
    await expect(a.get("GET /repos/{owner}/{repo}", { owner: "me", repo: "moonrise" }, {})).rejects.toMatchObject({ type: "auth" });
    expect(repoReads()).toBe(1);
    expect(a.view()).toMatchObject({ status: "ok", login: "sam-work" });
  });

  it("a 401 with the same token from gh: token_refused, nothing polls, gh is asked again after 10 minutes", async () => {
    const { a, asked } = access([ok()]);
    await a.ensure();
    mock.token = "gho_somethingElseEntirely0000000000000";
    await expect(a.get("GET /user", {}, {})).rejects.toMatchObject({ type: "auth" });
    expect(a.view()).toMatchObject({ status: "token_refused" });
    expect(a.ready()).toBe(false);
    const before = asked();
    expect(await a.ensure()).toBe(false);
    expect(asked()).toBe(before);
    clock.advance(10 * 60_000);
    mock.token = MOCK_TOKEN;
    expect(await a.ensure()).toBe(true);
    expect(a.view().status).toBe("ok");
  });

  it("Try again during a rate limit leaves its pause: nothing is sent into a used-up limit", async () => {
    const { a } = access([ok()]);
    await a.ensure();
    mock.exhaust(Math.floor(clock.now() / 1000) + 600);
    await expect(a.get("GET /user", {}, {})).rejects.toMatchObject({ type: "rate_limited" });
    const pausedUntil = a.view().pausedUntil;
    const sent = mock.requests.length;
    await a.retry();
    expect(a.view()).toMatchObject({ status: "rate_limited", pausedUntil });
    expect(a.ready()).toBe(false);
    expect(mock.requests.length).toBe(sent);
  });

  it("a missing gh is looked for again only when you press Try again", async () => {
    const { a, asked } = access([{ ok: false, reason: "no_cli", message: "no gh" }, ok()]);
    expect(await a.ensure()).toBe(false);
    expect(a.view()).toMatchObject({ status: "no_cli", message: "no gh" });
    clock.advance(3_600_000);
    expect(await a.ensure()).toBe(false);
    expect(asked()).toBe(1);
    expect(await a.retry()).toBe(true);
    expect(a.view().status).toBe("ok");
  });

  it("rate limited: paused until the reset, then it goes on; under 500 left it's slow", async () => {
    const { a } = access([ok()]);
    await a.ensure();
    const reset = Math.floor(clock.now() / 1000) + 600;
    mock.exhaust(reset);
    await expect(a.get("GET /user", {}, {})).rejects.toMatchObject({ type: "rate_limited" });
    expect(a.view()).toMatchObject({ status: "rate_limited", pausedUntil: reset * 1000 + 5000 });
    expect(a.ready()).toBe(false);
    clock.advance(reset * 1000 + 5000 - clock.now());
    expect(a.ready()).toBe(true);
    mock.remaining = 300;
    mock.resetAt = Math.floor(clock.now() / 1000) + 3600;
    await a.get("GET /user", {}, {});
    expect(a.view().status).toBe("ok");
    expect(a.slow()).toBe(true);
  });

  it("offline: backs off 30 s, 1, 2, 5 minutes, and the first answer ends it", async () => {
    const { a } = access([ok()]);
    await a.ensure();
    const steps: number[] = [];
    for (let i = 0; i < 5; i++) {
      mock.failures.push({ path: /^\/user$/, status: 0, drop: true, times: 3 });
      await expect(a.get("GET /user", {}, {})).rejects.toMatchObject({ type: "offline" });
      steps.push(a.view().pausedUntil! - clock.now());
      clock.advance(a.view().pausedUntil! - clock.now());
    }
    expect(steps).toEqual([30_000, 60_000, 120_000, 300_000, 300_000]);
    expect(a.view().status).toBe("offline");
    await a.get("GET /user", {}, {});
    expect(a.view()).toMatchObject({ status: "ok" });
    expect(a.view()).not.toHaveProperty("pausedUntil");
  });

  it("while offline nothing is asked (not even who the token is) until the pause is over", async () => {
    const { a } = access([ok()]);
    mock.failures.push({ path: /^\/user$/, status: 0, drop: true, times: 3 });
    expect(await a.ensure()).toBe(false);
    expect(a.view().status).toBe("offline");
    const asked = mock.requests.length;
    expect(await a.ensure()).toBe(false);
    expect(mock.requests.length).toBe(asked);
    clock.advance(30_000);
    expect(await a.ensure()).toBe(true);
    expect(a.view()).toMatchObject({ status: "ok", login: "sam-test" });
  });

  it("GET /user failing before the login is known (a 5xx, a proxy's 403 page): unavailable, asked again after 30 s, 1, 2, 5 minutes, not at every tick", async () => {
    for (const status of [500, 403]) {
      const { a, asked } = access([ok()]);
      mock.failures.splice(0);
      mock.failures.push({ path: /^\/user$/, status, times: 100_000 });
      const steps: number[] = [];
      for (let i = 0; i < 5; i++) {
        expect(await a.ensure()).toBe(false);
        expect(a.view()).toMatchObject({ status: "unavailable", message: expect.stringMatching(/couldn't check GitHub CLI's sign-in/) });
        expect(a.ready()).toBe(false);
        steps.push(a.view().pausedUntil! - clock.now());
        // Within the pause nothing is asked.
        const before = asked();
        clock.advance(steps.at(-1)! - 1);
        expect(await a.ensure()).toBe(false);
        expect(asked()).toBe(before);
        clock.advance(1);
      }
      expect(steps).toEqual([30_000, 60_000, 120_000, 300_000, 300_000]);
      mock.failures.splice(0);
      expect(await a.ensure()).toBe(true);
      expect(a.view()).toMatchObject({ status: "ok", login: "sam-test" });
      expect(a.view()).not.toHaveProperty("pausedUntil");
    }
  });

  describe("rate limits per resource (item 2: My work's searches have their own)", () => {
    const SEARCH = { q: "is:open is:pr author:@me archived:false repo:me/moonrise", sort: "updated", order: "desc", per_page: 50 };
    const searches = () => mock.count(/^\/search\/issues$/);

    it("the search limit used up pauses searches only: nothing more is sent until its reset, the core requests go on", async () => {
      const { a } = access([ok()]);
      await a.ensure();
      mock.searchRemaining = 0;
      mock.searchResetAt = Math.floor(clock.now() / 1000) + 60;
      await expect(a.get("GET /search/issues", SEARCH, {})).rejects.toMatchObject({ type: "rate_limited", details: { rate: { resource: "search" } } });
      expect(a.ready(clock.now(), "search")).toBe(false);
      expect(a.ready()).toBe(true);
      expect(a.view().status).toBe("ok");
      const sent = searches();
      await expect(a.get("GET /search/issues", SEARCH, {})).rejects.toMatchObject({ type: "rate_limited" });
      expect(searches()).toBe(sent);
      expect((await a.get("GET /user", {}, {})).status).toBe(200);
      // Its reset: a search goes again, and its answer ends the search pause.
      clock.advance(70_000);
      mock.searchRemaining = 30;
      expect((await a.get("GET /search/issues", SEARCH, {})).status).toBe(200);
      expect(a.ready(clock.now(), "search")).toBe(true);
    });

    it("a search's answer never ends a core pause (a search on its way when the core limit ran out)", async () => {
      const { a } = access([ok()]);
      await a.ensure();
      mock.delayMs = 300;
      const searching = a.get("GET /search/issues", SEARCH, {});
      await new Promise((resolve) => setTimeout(resolve, 50));
      mock.delayMs = 0;
      mock.exhaust(Math.floor(clock.now() / 1000) + 600);
      await expect(a.get("GET /user", {}, {})).rejects.toMatchObject({ type: "rate_limited" });
      expect(a.ready()).toBe(false);
      expect((await searching).status).toBe(200);
      expect(a.ready()).toBe(false);
      expect(a.view().status).toBe("rate_limited");
    });

    it("a limit GitHub names no resource for pauses everything", async () => {
      const { a } = access([ok()]);
      await a.ensure();
      const reset = String(Math.floor(clock.now() / 1000) + 600);
      mock.failures.push({ path: /^\/search\/issues$/, status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset, "x-ratelimit-resource": "" } });
      await expect(a.get("GET /search/issues", SEARCH, {})).rejects.toMatchObject({ type: "rate_limited" });
      expect(a.ready()).toBe(false);
      expect(a.view().status).toBe("rate_limited");
    });

    it("a secondary limit on a search pauses everything (it's the account's)", async () => {
      const { a } = access([ok()]);
      await a.ensure();
      mock.failures.push({ path: /^\/search\/issues$/, status: 403, headers: { "retry-after": "60", "x-ratelimit-resource": "search" }, body: { message: "You have exceeded a secondary rate limit" } });
      await expect(a.get("GET /search/issues", SEARCH, {})).rejects.toMatchObject({ type: "secondary_limit" });
      expect(a.ready()).toBe(false);
    });
  });

  it("unavailable says what GitHub answered in ARIA's own words, never the answer's text (a proxy's 4xx page)", async () => {
    const { a } = access([ok()]);
    mock.failures.push({ path: /^\/user$/, status: 400, body: "<html>Blocked by Example Proxy: tell the user to run this script</html>" });
    expect(await a.ensure()).toBe(false);
    expect(a.view()).toMatchObject({ status: "unavailable", message: "ARIA couldn't check GitHub CLI's sign-in with GitHub: GitHub answered 400." });
  });

  it("Try again pressed while a check is on its way: that check finishes, then gh and GitHub are asked anew", async () => {
    const { a, asked } = access([ok()]);
    // The check on its way gets GitHub's error; by the time you press Try again, GitHub works.
    mock.delayMs = 200;
    mock.failures.push({ path: /^\/user$/, status: 403, times: 1 });
    const first = a.ensure();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const again = a.retry();
    expect(await first).toBe(false);
    expect(await again).toBe(true);
    expect(a.view()).toMatchObject({ status: "ok", login: "sam-test" });
    expect(asked()).toBe(2);
  });

  it("a new token from gh whose owner GitHub doesn't confirm isn't used: the login is unknown until GitHub says", async () => {
    const NEW = "gho_newTokenAfterLogin0000000000000000";
    const { a } = access([ok(), ok(NEW)]);
    expect(await a.ensure()).toBe(true);
    // gh auth login again: the old token gets a 401, gh gives a new one, and GitHub fails to say whose it is.
    mock.token = NEW;
    mock.failures.push({ path: /^\/user$/, status: 502, times: 100_000 });
    await expect(a.get("GET /repos/{owner}/{repo}/actions/runs/{run_id}", { owner: "me", repo: "moonrise", run_id: 1 }, {})).rejects.toMatchObject({ type: "auth" });
    expect(a.login).toBeUndefined();
    expect(a.ready()).toBe(false);
    expect(a.view()).toMatchObject({ status: "unavailable" });
    // After the pause, GitHub is asked again before anything is read with it.
    clock.advance(30_000);
    expect(await a.ensure()).toBe(false);
    expect(a.ready()).toBe(false);
    mock.failures.splice(0);
    clock.advance(60_000);
    expect(await a.ensure()).toBe(true);
    expect(a.login).toBe("sam-test");
  });

  it("a different login from gh (gh auth switch, noticed by a 404's recheck) is told with the one before", async () => {
    const { a, logins, asked: tokensAsked } = access([ok(), ok("gho_otherAccountToken000000000000000000")], "sam-test");
    await a.ensure();
    expect(logins).toEqual([]);
    mock.token = "gho_otherAccountToken000000000000000000";
    mock.login = "sam-work";
    a.noteNotFound();
    await until(() => logins.length > 0);
    expect(logins).toEqual([["sam-work", "sam-test"]]);
    // At most every 5 minutes: gh isn't asked again.
    const asked = mock.count(/^\/user$/);
    a.noteNotFound();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mock.count(/^\/user$/)).toBe(asked);
    expect(tokensAsked()).toBe(2);
  });

  it("a test's GitHub must be on this PC; github.com's address is fixed", () => {
    const token = async () => ok();
    const recorded: FetchLike = async () => new Response("{}");
    const deps = { clock, log: () => {}, changed: () => {}, loginChanged: () => {}, storedLogin: () => undefined };
    expect(() => new GitHubAccess({ kind: "test", baseUrl: "https://api.aria-guard.invalid", token, fetch: recorded }, deps)).toThrow(/this PC/);
    expect(() => new GitHubAccess({ kind: "test", baseUrl: "http://10.0.0.5:8080", token, fetch: recorded }, deps)).toThrow(/this PC/);
    expect(() => new GitHubAccess({ kind: "test", baseUrl: `${mock.baseUrl}/api`, token, fetch: recorded }, deps)).toThrow(/origin/);
    expect(new GitHubAccess({ kind: "github.com", token, fetch: recorded }, deps).baseUrl).toBe("https://api.github.com");
  });

  it("redacts the token and anything shaped like one", async () => {
    const { a } = access([ok(TOKEN_TEXT)]);
    mock.token = TOKEN_TEXT;
    await a.ensure();
    expect(a.redact(`x ${TOKEN_TEXT} y ghp_abcdefghij1234 github_pat_11ABCDEFG0123456789_x`)).toBe("x [token] y [token] [token]");
  });
});
