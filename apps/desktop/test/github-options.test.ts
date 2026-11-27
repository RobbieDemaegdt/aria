import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchLike, TokenSource } from "@aria/core";
import { describe, expect, it } from "vitest";
import { githubOptions, isTestRun, TEST_GITHUB_TOKEN } from "../src/main/github-options";

// Nothing here fetches or runs anything: the fetch and gh's token source are stand-ins that fail the test if used.
const fetch: FetchLike = async () => {
  throw new Error("no request in this test");
};

function ghTokens() {
  let made = 0;
  const source: TokenSource = async () => {
    throw new Error("gh is never asked in this test");
  };
  return { factory: () => (made++, source), made: () => made };
}

describe("which GitHub ARIA reads (PLAN.md §0.4: no test run asks gh or reaches github.com)", () => {
  it("a test run is the scripted runtime, the test hooks, or ARIA_TEST_RUN (the real-runtime specs); never a packaged build", () => {
    const dev = (env: NodeJS.ProcessEnv) => isTestRun({ packaged: false, env });
    expect(dev({})).toBe(false);
    expect(dev({ ARIA_FAKE_RUNTIME: "ui-cards" })).toBe(true);
    expect(dev({ ARIA_E2E_HOOKS: "1" })).toBe(true);
    expect(dev({ ARIA_TEST_RUN: "1" })).toBe(true);
    expect(dev({ ARIA_TEST_RUN: "0", ARIA_E2E_HOOKS: "0" })).toBe(false);
    expect(isTestRun({ packaged: true, env: { ARIA_TEST_RUN: "1", ARIA_E2E_HOOKS: "1", ARIA_FAKE_RUNTIME: "ui-cards" } })).toBe(false);
  });

  it("in normal use: github.com with GitHub CLI's token", () => {
    const gh = ghTokens();
    const options = githubOptions({ testRun: isTestRun({ packaged: false, env: {} }), testServer: undefined, ghToken: gh.factory, fetch });
    expect(options?.kind).toBe("github.com");
    expect(gh.made()).toBe(1);
  });

  it("in a test run without a test server (the real-runtime specs: ARIA_TEST_RUN alone): no GitHub, and gh's token source isn't even made", () => {
    const gh = ghTokens();
    expect(githubOptions({ testRun: isTestRun({ packaged: false, env: { ARIA_TEST_RUN: "1" } }), testServer: undefined, ghToken: gh.factory, fetch })).toBeUndefined();
    expect(githubOptions({ testRun: true, testServer: "", ghToken: gh.factory, fetch })).toBeUndefined();
    expect(gh.made()).toBe(0);
  });

  it("in a test run with a test server: that server, with the fake token, never gh's", async () => {
    const gh = ghTokens();
    const options = githubOptions({ testRun: true, testServer: "http://127.0.0.1:4555", ghToken: gh.factory, fetch });
    expect(options).toMatchObject({ kind: "test", baseUrl: "http://127.0.0.1:4555" });
    expect(await options!.token()).toMatchObject({ ok: true, token: TEST_GITHUB_TOKEN });
    expect(gh.made()).toBe(0);
  });

  it("a test server outside a test run is ignored: github.com as in normal use", () => {
    const gh = ghTokens();
    expect(githubOptions({ testRun: false, testServer: "http://127.0.0.1:4555", ghToken: gh.factory, fetch })?.kind).toBe("github.com");
  });

  it("a test's push folder (item 3) only comes with a test server in a test run; normal use never has one", () => {
    const gh = ghTokens();
    expect(githubOptions({ testRun: true, testServer: "http://127.0.0.1:4555", testPushRoot: "C:\\t\\remote", ghToken: gh.factory, fetch })).toMatchObject({ kind: "test", pushRoot: "C:\\t\\remote" });
    expect(githubOptions({ testRun: true, testServer: "http://127.0.0.1:4555", ghToken: gh.factory, fetch })).not.toHaveProperty("pushRoot");
    expect(githubOptions({ testRun: true, testServer: undefined, testPushRoot: "C:\\t\\remote", ghToken: gh.factory, fetch })).toBeUndefined();
    const real = githubOptions({ testRun: false, testServer: undefined, testPushRoot: "C:\\t\\remote", ghToken: gh.factory, fetch });
    expect(real?.kind).toBe("github.com");
    expect(real).not.toHaveProperty("pushRoot");
  });

  it("a test's log storage (item 4) only comes with a test server in a test run; normal use has core's own list", () => {
    const gh = ghTokens();
    expect(githubOptions({ testRun: true, testServer: "http://127.0.0.1:4555", testLogHost: "http://127.0.0.1:4556", ghToken: gh.factory, fetch })).toMatchObject({ kind: "test", logHosts: ["http://127.0.0.1:4556"] });
    const real = githubOptions({ testRun: false, testServer: undefined, testLogHost: "http://127.0.0.1:4556", ghToken: gh.factory, fetch });
    expect(real).not.toHaveProperty("logHosts");
  });

  it("every spec that starts the app marks it a test run (the scripted runtime, the hooks, or ARIA_TEST_RUN for the real-runtime ones)", () => {
    const e2e = fileURLToPath(new URL("../e2e", import.meta.url));
    const specs = readdirSync(e2e).filter((f) => f.endsWith(".spec.ts"));
    expect(specs).toEqual(expect.arrayContaining(["phase1.spec.ts", "phase2.spec.ts", "ui-github.spec.ts"]));
    for (const spec of specs) {
      const text = readFileSync(path.join(e2e, spec), "utf8");
      if (!text.includes("electron.launch")) continue;
      expect(/ARIA_TEST_RUN: "1"|ARIA_E2E_HOOKS: "1"|ARIA_FAKE_RUNTIME: "[a-z-]+"/.test(text), spec).toBe(true);
    }
  });
});
