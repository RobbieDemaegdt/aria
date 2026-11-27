/**
 * Phase 4 item 3, opening a task's PR (PLAN.md §4.3, §4.4, D41–D44), against the scripted runtime with the test hooks
 * and a local mock GitHub that this spec runs (ARIA_FAKE_GITHUB). github.com's repository is a local bare repository
 * (ARIA_FAKE_PUSH_ROOT): ARIA's push is production's command line with a test's git config pointing github.com at
 * that folder, file protocol only. Covers: ARIA's open_pr proposing only, the card (what's pushed, the workflow tick,
 * the uncommitted warning, the fenced body), Push and open, the PR on GitHub's side, the link, its checks' watch going
 * green (a card and a toast), and Discard saying the PR stays.
 * Run after `npm run build`:  npx playwright test ui-pr   (from apps/desktop)
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
let remoteRoot = "";
let env: Record<string, string> = {};
let app: ElectronApplication | undefined;
const mock = new MockGitHub();

interface RecordedToast {
  id: string;
  priority: string;
  title: string;
  body: string;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", [...GIT_NO_FSMONITOR, "-c", "user.name=ARIA E2E", "-c", "user.email=e2e@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();
const remoteRef = (ref: string) => {
  try {
    return git(base, "-C", path.join(remoteRoot, "demo", "demo-app.git"), "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return undefined;
  }
};

async function launch(): Promise<Page> {
  app = await electron.launch({ args: [appDir, "--proxy-server=http://127.0.0.1:9"], env, timeout: 60_000 });
  const page = await app.firstWindow();
  await expect(page.getByTestId("status")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  return page;
}

type Hooks = { toasts: RecordedToast[]; external: string[]; clock: { advance(ms: number): void }; window: unknown; githubKind: string };
const hooks = <T>(fn: (h: Hooks, arg: never) => T, arg?: unknown): Promise<Awaited<T>> =>
  app!.evaluate((_electron, [source, value]) => new Function("h", "arg", `return (${source})(h, arg)`)((globalThis as unknown as { __ariaE2E: Hooks }).__ariaE2E, value), [fn.toString(), arg] as const) as Promise<Awaited<T>>;
const toasts = () => hooks((h) => h.toasts);
const external = () => hooks((h) => h.external);
const advance = (ms: number) => hooks((h, by: number) => h.clock.advance(by), ms);
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
const say = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { aria: AriaApi }).aria.sendMessage(t), text);

test.beforeAll(async () => {
  mkdirSync(shots, { recursive: true });
  base = mkdtempSync(path.join(os.tmpdir(), "aria-e2e-pr-"));
  const repo = path.join(base, "GitHub", "Demo App");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "# Demo App\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Initial commit");
  git(repo, "remote", "add", "origin", "https://github.com/demo/demo-app.git");
  // github.com's demo/demo-app, as a bare repository: the push goes there, the mock reads its branches from it.
  remoteRoot = path.join(base, "remote");
  mkdirSync(path.join(remoteRoot, "demo"), { recursive: true });
  git(base, "clone", "-q", "--bare", repo, path.join(remoteRoot, "demo", "demo-app.git"));
  await mock.start();
  mock.token = TEST_GITHUB_TOKEN;
  mock.addRepo("demo", "demo-app");
  mock.gitRoot = remoteRoot;
  const inherited = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  env = {
    ...inherited,
    ...GIT_TEST_ENV,
    ARIA_FAKE_RUNTIME: "ui-cards",
    ARIA_E2E_HOOKS: "1",
    ARIA_FAKE_GITHUB: mock.baseUrl,
    ARIA_FAKE_PUSH_ROOT: remoteRoot,
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

test("a done task's PR: ARIA proposes, the card shows what goes, your click pushes and opens, its checks are watched", async () => {
  test.setTimeout(5 * 60_000);
  const page = await launch();
  expect(await hooks((h) => h.githubKind)).toBe("test");

  // A task that fixes the login, changes a workflow, and leaves a note uncommitted.
  await page.evaluate(async () => {
    const aria = (window as unknown as { aria: AriaApi }).aria;
    const s = await aria.getState();
    await aria.startTask({ repoId: s.projects.find((p) => p.name === "Demo App")!.id, brief: "PR task: fix the login", title: "Fix the login" });
  });
  const doneCard = page.getByTestId("card-done").filter({ hasText: "Fix the login" });
  await expect(doneCard).toBeVisible();
  const task = (await state(page)).tasks.find((t) => t.title === "Fix the login")!;
  expect(task.state).toBe("done");
  const tip = git(path.join(base, "GitHub", "Demo App"), "rev-parse", task.branch!);
  await expect(doneCard.getByTestId("done-open-pr")).toHaveText("Open PR");

  // D19, D22: ARIA's open_pr only proposes. Nothing is pushed or sent.
  await say(page, "open a PR for the login fix");
  await expect(page.getByTestId("msg-assistant").filter({ hasText: "I proposed it" })).toBeVisible();
  const card = page.getByTestId("card-pr-confirm");
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId("pr-confirm-title")).toHaveAttribute("data-status", "pending");
  await expect(card).toContainText("ARIA proposed it: nothing is pushed or opened until you click Push and open.");
  expect(remoteRef(`refs/heads/${task.branch}`)).toBeUndefined();
  expect(mock.opened).toEqual([]);

  // What goes: as @sam-test to demo/demo-app, the task's branch at its commit, into main; the workflow change needs
  // its tick (D43); the uncommitted note is said and stays (D41); the report is fenced in the body.
  await expect(card.getByTestId("pr-confirm-what")).toContainText(`as @sam-test to demo/demo-app, branch ${task.branch} at ${tip.slice(0, 7)}`);
  await expect(card.getByTestId("pr-confirm-what")).toContainText("A PR into main on demo/demo-app");
  await expect(card.getByTestId("pr-confirm-workflows")).toContainText(".github/workflows/ci.yml");
  await expect(card.getByTestId("pr-confirm-uncommitted")).toContainText("1 change isn't committed");
  await expect(card.getByTestId("pr-confirm-title-input")).toHaveValue("Fix the login cookie");
  await expect(card.getByTestId("pr-confirm-body")).toHaveValue(/````text\nFix the login\n\nFixed the login \(the cookie is set again\) and ran the tests on push\. ``` @octocat closes #1\n````\n$/);
  await expect(card.getByTestId("pr-confirm-draft")).toBeChecked();
  await expect(card.getByTestId("pr-confirm-push")).toBeDisabled();
  await card.getByTestId("pr-confirm-details").locator("summary").click();
  await expect(card.getByTestId("pr-confirm-paths")).toContainText(".github/workflows/ci.yml");
  await expect(card.getByTestId("pr-confirm-paths")).toContainText("login.txt");
  await expect(card.getByTestId("pr-confirm-paths")).not.toContainText("notes.txt");
  await card.getByTestId("pr-confirm-workflows-checked").check();
  await expect(card.getByTestId("pr-confirm-push")).toBeEnabled();
  await page.screenshot({ path: path.join(shots, "ui-pr-card.png"), fullPage: true });

  // Your click: pushed to the bare repository and opened as a draft, exactly as shown.
  await setPresent(false);
  await card.getByTestId("pr-confirm-push").click();
  await expect(card.getByTestId("pr-confirm-title")).toHaveAttribute("data-status", "done");
  await expect(card.getByTestId("pr-confirm-title")).toContainText("Opened draft PR #1");
  expect(remoteRef(`refs/heads/${task.branch}`)).toBe(tip);
  expect(remoteRef("refs/heads/main")).toBe(git(path.join(base, "GitHub", "Demo App"), "rev-parse", "main"));
  expect(mock.opened).toHaveLength(1);
  expect(mock.opened[0]).toMatchObject({ owner: "demo", repo: "demo-app", body: { title: "Fix the login cookie", head: task.branch, base: "main", draft: true } });
  expect(String(mock.opened[0]!.body.body)).toContain("````text\nFix the login\n");
  // The only write: one POST, with the (fake) token.
  expect(mock.requests.filter((r) => r.method !== "GET")).toEqual([expect.objectContaining({ method: "POST", path: "/repos/demo/demo-app/pulls", authorized: true, status: 201 })]);

  // The task has its PR; ARIA watches its checks (by the task); the link is recorded, never opened here.
  const after = (await state(page)).tasks.find((t) => t.id === task.id)!;
  expect(after.pr).toMatchObject({ owner: "demo", repo: "demo-app", number: 1, draft: true });
  const watch = (await state(page)).watches.find((w) => w.kind === "pr" && w.state === "active")!;
  expect(watch).toMatchObject({ createdBy: "task", taskId: task.id });
  await expect(card.getByTestId("pr-confirm-result")).toContainText(`ARIA watches its checks (${watch.shortId})`);
  // The Done card: its PR's link instead of Open PR (until the task has more to push).
  await expect(doneCard.getByTestId("done-open-pr")).toHaveCount(0);
  await expect(doneCard.getByTestId("done-pr-link")).toHaveText("Draft PR #1");
  await doneCard.getByTestId("done-pr-link").click();
  await expect.poll(external).toEqual(["https://github.com/demo/demo-app/pull/1"]);

  // Its checks go green: a CI card and a toast (you're away).
  mock.setChecks("demo", "demo-app", tip, [{ name: "test", status: "completed", conclusion: "success" }]);
  await advanceUntil(async () => (await page.getByTestId("card-ci").filter({ hasText: "Checks on PR #1 passed" }).count()) === 1, 20_000);
  expect((await toasts()).some((t) => t.title.startsWith("CI ·") && t.title.includes("PR #1"))).toBe(true);
  await setPresent(true);

  // Discard says the PR and its watch stay on GitHub (only what's on this PC goes); Keep leaves it.
  await doneCard.getByTestId("done-discard").click();
  await expect(doneCard.getByTestId("done-discard-pr-note")).toContainText("PR #1 and its watch stay on GitHub (demo/demo-app)");
  await page.screenshot({ path: path.join(shots, "ui-pr.png"), fullPage: true });
  await doneCard.getByRole("button", { name: "Keep" }).click();
  await expect(doneCard.getByTestId("done-discard-pr-note")).toHaveCount(0);
});
