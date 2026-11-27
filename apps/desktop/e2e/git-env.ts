/**
 * git in the specs, and in the ARIA they start (review round 1 of item 3, finding 6): fsmonitor off, whatever your
 * global config says (with `core.fsmonitor=true`, a plain add or commit in a temp repository starts a daemon that holds
 * the folder), and git's own proxy setting at a dead loopback port, so an https request a spec might make fails before
 * any credential is asked. ARIA's push takes every GIT_* variable out of its own environment; it pushes to the specs'
 * bare repositories over the file protocol only.
 */
export const DEAD_PROXY = "http://127.0.0.1:9";

/** For the launch env of every spec's ARIA (its scripted workers commit with git too). */
export const GIT_TEST_ENV: Record<string, string> = {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "core.fsmonitor",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "http.proxy",
  GIT_CONFIG_VALUE_1: DEAD_PROXY,
};

/** For a spec's own git calls. */
export const GIT_NO_FSMONITOR = ["-c", "core.fsmonitor=false"];
