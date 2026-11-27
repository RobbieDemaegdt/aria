/**
 * Where ARIA reads GitHub (PLAN.md §4.6, §0.4). In normal use github.com, with GitHub CLI's token. In any test run
 * only a test's server on loopback (ARIA_FAKE_GITHUB, with a fake token), or no GitHub at all: no test run asks gh for
 * its token or reaches github.com. A test run is the scripted runtime (ARIA_FAKE_RUNTIME), the test hooks
 * (ARIA_E2E_HOOKS, the UI specs), or ARIA_TEST_RUN (the real-runtime specs, phase1 and phase2, which use neither:
 * they test the chat and tasks, not GitHub). Only a development build reads any of them. Pure (no Electron), so its unit
 * test holds it to that.
 */
import type { FetchLike, GitHubOptions, TokenSource } from "@aria/core";

/** The fake token a test's GitHub server takes (the specs' mock is set to it). */
export const TEST_GITHUB_TOKEN = "gho_ariaScriptedRuntimeFakeToken000000";

/** Whether this run of ARIA is a test's: never in a packaged build, whatever its environment says. */
export function isTestRun({ packaged, env }: { packaged: boolean; env: NodeJS.ProcessEnv }): boolean {
  if (packaged) return false;
  return Boolean(env.ARIA_FAKE_RUNTIME) || env.ARIA_E2E_HOOKS === "1" || env.ARIA_TEST_RUN === "1";
}

export interface GitHubChoice {
  /** isTestRun(). */
  testRun: boolean;
  /** ARIA_FAKE_GITHUB: a test's server, on loopback (core refuses anything else). */
  testServer: string | undefined;
  /**
   * ARIA_FAKE_PUSH_ROOT: a test's folder of bare repositories (`<owner>/<repo>.git`) that a PR's push goes to (item
   * 3). Only with a test's server; without it a test run never pushes (core refuses: it would go to github.com).
   */
  testPushRoot?: string | undefined;
  /** ARIA_FAKE_LOG_HOST: a test's log storage (item 4: where its job logs redirect), loopback only (core checks). */
  testLogHost?: string | undefined;
  /** GitHub CLI's token source; made only for github.com. */
  ghToken: () => TokenSource;
  fetch: FetchLike;
}

export function githubOptions({ testRun, testServer, testPushRoot, testLogHost, ghToken, fetch }: GitHubChoice): GitHubOptions | undefined {
  if (!testRun) return { kind: "github.com", token: ghToken(), fetch };
  if (!testServer) return undefined;
  return {
    kind: "test",
    baseUrl: testServer,
    token: async () => ({ ok: true, token: TEST_GITHUB_TOKEN, source: "the scripted runtime's test server" }),
    fetch,
    ...(testPushRoot ? { pushRoot: testPushRoot } : {}),
    ...(testLogHost ? { logHosts: [testLogHost] } : {}),
  };
}
