/**
 * Phase 4 item 1, GitHub's watchers (PLAN.md §4.6, D36, D37), against the scripted runtime with the test hooks and a
 * local mock GitHub (packages/core/test/mock-github.ts) that this spec runs and points ARIA at (ARIA_FAKE_GITHUB).
 * Requests go through Chromium's network stack, as in normal use; under the hooks no host name resolves there, so
 * nothing can reach a real host (a canary checks it). Covers: the inbox on from the start, ARIA watching a run (a
 * card and a toast when it finishes, also a red one with its job), a PR (its checks, a review, a renamed repository's
 * redirect, the merge), Chromium's cache never answering a poll, a restart, Open on GitHub recorded (never opened),
 * Customize › Notifications' GitHub section, and the away card's GitHub group.
 * Run after `npm run build`:  npx playwright test ui-github   (from apps/desktop)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppState, AriaApi } from "@aria/protocol";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { GIT_NO_FSMONITOR, GIT_TEST_ENV } from "./git-env.ts";
import { MockGitHub } from "../../../packages/core/test/mock-github.ts";
import { TEST_GITHUB_TOKEN } from "../src/main/github-options.ts";

const appDir = path.resolve(import.meta.dirname, "..");
const shots = path.join(appDir, "e2e", ".artifacts");
let base = "";
let env: Record<string, string> = {};
let app: ElectronApplication | undefined;
const mock = new MockGitHub();
const MIN = 60_000;

interface RecordedToast {
  id: string;
  priority: string;
  title: string;
  body: string;
  cardId?: string;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", [...GIT_NO_FSMONITOR, "-c", "user.name=ARIA E2E", "-c", "user.email=e2e@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();

async function launch(): Promise<Page> {
  // A proxy on this PC (a dead port here): under the hooks GitHub's session must not use it.
  app = await electron.launch({ args: [appDir, "--proxy-server=http://127.0.0.1:9"], env, timeout: 60_000 });
  const page = await app.firstWindow();
  await expect(page.getByTestId("status")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  return page;
}

type Hooks = {
  toasts: RecordedToast[];
  external: string[];
  clock: { advance(ms: number): void };
  window: unknown;
  githubFetch(url: string, init?: RequestInit): Promise<Response>;
  githubProxy(url: string): Promise<string>;
  githubKind: string;
};
const hooks = <T>(fn: (h: Hooks, arg: never) => T, arg?: unknown): Promise<Awaited<T>> =>
  app!.evaluate((_electron, [source, value]) => new Function("h", "arg", `return (${source})(h, arg)`)((globalThis as unknown as { __ariaE2E: Hooks }).__ariaE2E, value), [fn.toString(), arg] as const) as Promise<Awaited<T>>;
const toasts = () => hooks((h) => h.toasts);
const external = () => hooks((h) => h.external);
const advance = (ms: number) => hooks((h, by: number) => h.clock.advance(by), ms);
/** The clock moves in steps until `check` holds (each step lets the polls answer). */
async function advanceUntil(check: () => Promise<boolean>, stepMs = 5_000, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await advance(stepMs);
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("condition not met");
}
const setPresent = (present: boolean) =>
  app!.evaluate(({ BrowserWindow }, there) => {
    (globalThis as unknown as { __ariaE2E: { window: unknown } }).__ariaE2E.window = { exists: true, visible: true, minimized: false, focused: there };
    BrowserWindow.getAllWindows()[0]!.emit(there ? "focus" : "blur");
  }, present);
const state = (page: Page) => page.evaluate(() => (window as unknown as { aria: AriaApi }).aria.getState()) as Promise<AppState>;
/** A message to ARIA without touching the window (a click could give it a real focus event). */
const say = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { aria: AriaApi }).aria.sendMessage(t), text);
const cardCount = async (page: Page, testId: string, text?: string) => (text ? page.getByTestId(testId).filter({ hasText: text }) : page.getByTestId(testId)).count();

test.beforeAll(async () => {
  mkdirSync(shots, { recursive: true });
  base = mkdtempSync(path.join(os.tmpdir(), "aria-e2e-github-"));
  const repo = path.join(base, "GitHub", "Demo App");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "# Demo App\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Initial commit");
  // Only the remote's address: nothing is fetched from it.
  git(repo, "remote", "add", "origin", "https://github.com/demo/demo-app.git");
  await mock.start();
  // A test run's own fake token (main/github-options.ts): GitHub CLI's is never fetched in a test run.
  mock.token = TEST_GITHUB_TOKEN;
  mock.addRepo("demo", "demo-app");
  mock.addWorkflow("demo", "demo-app", "deploy", "deploy.yml");
  const inherited = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  env = {
    ...inherited,
    ...GIT_TEST_ENV,
    ARIA_FAKE_RUNTIME: "ui-cards",
    ARIA_E2E_HOOKS: "1",
    ARIA_FAKE_GITHUB: mock.baseUrl,
    ARIA_DATA_DIR: path.join(base, "data"),
    ARIA_PROJECT_ROOTS: path.join(base, "GitHub"),
    ARIA_WORKTREE_ROOT: path.join(base, "wt"),
  };
});

test.afterAll(async () => {
  await app?.close().catch(() => {
    // Teardown: the app may be gone already, and the test has its result.
  });
  await mock.stop();
  if (base) rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

test("GitHub's watchers: a run, a red run, a PR, a restart, the inbox", async () => {
  test.setTimeout(6 * 60_000);
  let page = await launch();

  // The canary: under the hooks no host name resolves in Chromium's network stack. This one would reach the mock.
  const canary = await hooks(async (h, port: string) => {
    try {
      await h.githubFetch(`http://aria-canary.localhost:${port}/user`);
      return "reached";
    } catch (error) {
      return `refused: ${(error as Error).message}`;
    }
  }, new URL(mock.baseUrl).port);
  expect(canary).toMatch(/^refused/);
  // (The canary sends no token: nothing without one reached the mock.)
  expect(mock.requests.some((r) => !r.hadAuth)).toBe(false);
  // Under the hooks: a test's GitHub only, never github.com, and GitHub's session uses no proxy (one on this PC would
  // resolve names itself), not even the one on the command line. Asking the session which proxy it would use sends
  // nothing.
  expect(await hooks((h) => h.githubKind)).toBe("test");
  expect(await hooks((h, url: string) => h.githubProxy(url), "https://api.aria-guard.invalid/user")).toBe("DIRECT");
  // The mock itself (127.0.0.1) is reachable the same way.
  const direct = await hooks(async (h, url: string) => {
    try {
      return `status ${(await h.githubFetch(url, { cache: "no-store", credentials: "omit", redirect: "manual" })).status}`;
    } catch (error) {
      return `failed: ${(error as Error).message}`;
    }
  }, `${mock.baseUrl}/user`);
  expect(direct).toBe("status 401");
  mock.requests.splice(0);

  // D37: the inbox is on from the first start, with one notice; Customize › Notifications shows who ARIA reads GitHub as.
  await expect(page.locator('[data-testid="notice"][data-cause="github_inbox"]')).toHaveCount(1);
  await page.getByTestId("nav-customize").click();
  await page.getByTestId("customize-notifications").click();
  await expect(page.getByTestId("github-access")).toHaveAttribute("data-status", "ok");
  await expect(page.getByTestId("github-access")).toContainText("@sam-test");
  await expect(page.getByTestId("github-inbox")).toBeChecked();
  await page.getByTestId("nav-aria").click();

  // ARIA watches the deploy workflow's run; it finishes while you're away: a card, and a milestone toast.
  const deploy = mock.addRun("demo", "demo-app", { name: "deploy", status: "in_progress" });
  await setPresent(false);
  await say(page, "tell me when the deploy workflow finishes");
  await expect(page.getByTestId("msg-assistant").filter({ hasText: "Watching it (W-" })).toBeVisible();
  const runPolls = mock.count(new RegExp(`/actions/runs/${deploy.id}$`));
  // Finished within GitHub's max-age=60: a cached answer would still say in progress (the poll goes out no-store).
  mock.finishRun(deploy.id, "success");
  await advance(30_000);
  await expect(page.getByTestId("card-ci").filter({ hasText: "deploy #1 succeeded" })).toBeVisible();
  expect(mock.count(new RegExp(`/actions/runs/${deploy.id}$`))).toBe(runPolls + 1);
  expect((await toasts()).filter((t) => t.title.startsWith("CI ·"))).toEqual([expect.objectContaining({ priority: "milestone", title: "CI · Demo App · deploy #1 succeeded" })]);
  // Open on GitHub: recorded, never opened in a browser here.
  await page.getByTestId("card-ci").filter({ hasText: "deploy #1" }).getByTestId("ci-open").click();
  await expect.poll(external).toEqual([`https://github.com/demo/demo-app/actions/runs/${deploy.id}`]);

  // A red run: its card has the job that failed.
  const red = mock.addRun("demo", "demo-app", { name: "deploy", status: "in_progress" });
  mock.jobs.set(red.id, [
    { id: 8801, name: "test (windows)", status: "completed", conclusion: "failure" },
    { id: 8802, name: "lint", status: "completed", conclusion: "success" },
  ]);
  await say(page, `watch run ${red.id}`);
  await expect(page.getByTestId("msg-assistant").filter({ hasText: "Watching it (W-" })).toHaveCount(2);
  // Its finished answer is cut off after the headers once (through Chromium's streaming fetch): it isn't taken, nor
  // its ETag, so the poll made again still tells it (item 4's review, finding 1).
  mock.cutAfterHeaders.push(new RegExp(`/actions/runs/${red.id}$`));
  mock.finishRun(red.id, "failure");
  await advance(30_000);
  const redCard = page.getByTestId("card-ci").filter({ hasText: "deploy #2 failed" });
  await expect(redCard).toBeVisible();
  await expect(redCard.getByTestId("ci-failed")).toContainText("test (windows)");
  await expect(redCard.getByTestId("ci-failed")).not.toContainText("lint");

  // A PR: its checks finish red, and bob asks for changes; then the repository is renamed (GitHub answers 301 to
  // its id, which ARIA's own code follows within GitHub's API) and the PR is merged.
  const sha = "5".repeat(40);
  mock.addPull("demo", "demo-app", 7, { title: "Dark mode toggle", headSha: sha });
  mock.setChecks("demo", "demo-app", sha, [{ name: "test", status: "in_progress" }]);
  await say(page, "watch PR 7");
  await expect(page.getByTestId("msg-assistant").filter({ hasText: "Watching it (W-" })).toHaveCount(3);
  mock.setChecks("demo", "demo-app", sha, [{ name: "test", status: "completed", conclusion: "failure" }]);
  mock.addReview("demo", "demo-app", 7, { by: "bob", state: "CHANGES_REQUESTED", body: "Please rename the toggle." });
  await advanceUntil(async () => (await cardCount(page, "card-pr", "changes requested by bob")) === 1 && (await cardCount(page, "card-ci", "Checks on PR #7 failed")) === 1, 20_000);
  await expect(page.getByTestId("card-pr").filter({ hasText: "changes requested by bob" }).getByTestId("pr-body")).toHaveText("Please rename the toggle.");
  const renamedId = mock.repos.get("demo/demo-app")!.id;
  mock.renamed.set("demo/demo-app", renamedId);
  Object.assign(mock.pull("demo", "demo-app", 7), { state: "closed", merged: true, merged_by: { login: "alice" } });
  await advanceUntil(async () => (await cardCount(page, "card-pr", "PR #7 was merged")) === 1, 20_000);
  const moved = mock.requests.findIndex((r) => r.path === "/repos/demo/demo-app/pulls/7" && r.status === 301);
  expect(moved).toBeGreaterThanOrEqual(0);
  expect(mock.requests[moved + 1]).toMatchObject({ path: `/repositories/${renamedId}/pulls/7`, authorized: true });
  mock.renamed.clear();
  expect((await state(page)).watches.find((w) => w.kind === "pr")).toMatchObject({ state: "ended", endedReason: "merged" });

  // A redirect to another origin is never followed (nor the token sent there): the other server gets nothing.
  const elsewhere = new MockGitHub();
  await elsewhere.start();
  try {
    mock.failures.push({ path: /^\/notifications$/, status: 302, headers: { location: `${elsewhere.baseUrl}/notifications` } });
    await advanceUntil(async () => !mock.failures.some((f) => f.status === 302), 20_000);
    await advance(5_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(elsewhere.requests).toEqual([]);
  } finally {
    await elsewhere.stop();
  }

  // A review request in your inbox: a card and a toast (D37: only review requests toast).
  mock.addNotification({ repo: "demo/demo-app", reason: "review_requested", title: "Fix the scoring", number: 9 });
  mock.addNotification({ repo: "demo/demo-app", reason: "mention", title: "You were mentioned", number: 10 });
  await advanceUntil(async () => (await cardCount(page, "card-pr", "Review requested: PR #9")) === 1, 20_000);
  expect((await toasts()).map((t) => t.title)).toContain("Review requested · Demo App PR #9");
  expect((await toasts()).some((t) => t.body.includes("mentioned"))).toBe(false);

  // Back after a while: the away card has a GitHub group.
  await advance(16 * MIN);
  await setPresent(true);
  const away = page.getByTestId("card-away");
  await expect(away).toBeVisible();
  await expect(away.locator('[data-testid="away-group"][data-kind="github"]')).toContainText("deploy #1 succeeded");
  await page.screenshot({ path: path.join(shots, "ui-github.png"), fullPage: true });

  // A restart while a run is in progress; it finishes while ARIA is closed: one card at the start.
  const later = mock.addRun("demo", "demo-app", { name: "deploy", status: "in_progress" });
  await say(page, `watch run ${later.id}`);
  await expect(page.getByTestId("msg-assistant").filter({ hasText: "Watching it (W-" })).toHaveCount(4);
  await app!.close();
  mock.finishRun(later.id, "success");
  page = await launch();
  // This start's clock is another one (behind the last one's): nothing waits more than 15 minutes from now.
  await advanceUntil(async () => (await cardCount(page, "card-ci", `deploy #${later.run_number} succeeded`)) === 1, 60_000, 20);
  await advance(2 * MIN);
  expect(await cardCount(page, "card-ci", `deploy #${later.run_number} succeeded`)).toBe(1);
  // The inbox is still on (its notice came once), and every request was a GET with the (fake) token.
  await expect(page.locator('[data-testid="notice"][data-cause="github_inbox"]')).toHaveCount(1);
  expect(mock.requests.every((r) => r.method === "GET")).toBe(true);
});
