/**
 * Phase 4 item 2, My work and watch rows (PLAN.md §5.1, §5.2, D36, D38–D40), against the scripted runtime with the
 * test hooks and the local mock GitHub (packages/core/test/mock-github.ts) that this spec runs and points ARIA at
 * (ARIA_FAKE_GITHUB). Covers: My work in the session pane (your project only, "searched as"), Watch on a PR (twice:
 * one watch) and its row under the project, a watch row without a card opening My work at its item, the project menu's
 * Watch default-branch CI with a red main (its card, a ✗ row, no red dot, the quiet ✗ when collapsed), the live strip's
 * chip for it (gone once seen), Stop from a row, Open on GitHub recorded (never opened), SSO partial results said.
 * Run after `npm run build`:  npx playwright test ui-mywork   (from apps/desktop)
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
let base = "";
let env: Record<string, string> = {};
let app: ElectronApplication | undefined;
const mock = new MockGitHub();

const git = (cwd: string, ...args: string[]) => execFileSync("git", [...GIT_NO_FSMONITOR, "-c", "user.name=ARIA E2E", "-c", "user.email=e2e@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();

type Hooks = { external: string[]; clock: { advance(ms: number): void } };
const hooks = <T>(fn: (h: Hooks, arg: never) => T, arg?: unknown): Promise<Awaited<T>> =>
  app!.evaluate((_electron, [source, value]) => new Function("h", "arg", `return (${source})(h, arg)`)((globalThis as unknown as { __ariaE2E: Hooks }).__ariaE2E, value), [fn.toString(), arg] as const) as Promise<Awaited<T>>;
const state = (page: Page) => page.evaluate(() => (window as unknown as { aria: AriaApi }).aria.getState()) as Promise<AppState>;

test.beforeAll(async () => {
  base = mkdtempSync(path.join(os.tmpdir(), "aria-e2e-mywork-"));
  const repo = path.join(base, "GitHub", "Demo App");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "# Demo App\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Initial commit");
  // Only the remote's address: nothing is fetched from it.
  git(repo, "remote", "add", "origin", "https://github.com/demo/demo-app.git");
  await mock.start();
  mock.token = TEST_GITHUB_TOKEN;
  mock.addRepo("demo", "demo-app");
  mock.addWorkflow("demo", "demo-app", "deploy", "deploy.yml");
  mock.addPull("demo", "demo-app", 12, { title: "Add dark mode", author: "sam-test" });
  mock.addPull("demo", "demo-app", 13, { title: "Fix login", author: "alice", reviewers: ["sam-test"] });
  mock.addIssue("demo", "demo-app", 20, { title: "Crash on start", assignees: ["sam-test"] });
  mock.addPull("stranger", "elsewhere", 1, { title: "Not one of yours", author: "bob", reviewers: ["sam-test"] });
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

test("My work, Watch, watch rows, the project menu's CI, the live strip", async () => {
  test.setTimeout(4 * 60_000);
  app = await electron.launch({ args: [appDir], env, timeout: 60_000 });
  const page = await app.firstWindow();
  await expect(page.getByTestId("status")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  const project = page.locator('[data-testid="project"][data-project="Demo App"]');
  await expect(project).toBeVisible();

  // My work, from the sidebar (no count on its entry, D40): your project's items only (D38).
  await expect(page.getByTestId("nav-my-work")).toHaveText("My work");
  await page.getByTestId("nav-my-work").click();
  const myWork = page.getByTestId("my-work");
  await expect(myWork).toBeVisible();
  await expect(page.getByTestId("my-work-searched")).toContainText("Searched as @sam-test");
  await expect(page.getByTestId("my-work-review_requested")).toContainText("Fix login");
  await expect(page.getByTestId("my-work-authored")).toContainText("Add dark mode");
  await expect(page.getByTestId("my-work-assigned")).toContainText("Crash on start");
  await expect(myWork).not.toContainText("Not one of yours");
  await expect(page.getByTestId("my-work-ci-section")).toHaveCount(0);

  // Open on GitHub is recorded under the hooks, never opened.
  await page.locator('[data-testid="my-work-item"][data-key="demo/demo-app#13"]').getByTestId("my-work-open").click();
  await expect.poll(() => hooks((h) => h.external)).toContain("https://github.com/demo/demo-app/pull/13");

  // Watch, clicked twice quickly: one watch, and its row under the project.
  const watchButton = page.getByTestId("my-work-watch-pr");
  await watchButton.dblclick();
  await expect(page.getByTestId("my-work-watch")).toBeVisible();
  await expect(project.getByTestId("watch-row")).toHaveCount(1);
  expect((await state(page)).watches.filter((w) => w.kind === "pr" && w.state === "active")).toHaveLength(1);
  // Its title and status are both visible on the row, not crushed to 0px when status text is long.
  await expect(project.getByTestId("watch-row-title")).toBeVisible();
  await expect(project.getByTestId("watch-row-status")).not.toBeEmpty();
  const titleBox = await project.getByTestId("watch-row-title").first().boundingBox();
  expect(titleBox?.width ?? 0).toBeGreaterThan(20);

  // A watch row with no card of its own opens My work at its item (D39).
  await page.getByTestId("my-work-close").click();
  await expect(myWork).toBeHidden();
  await project.getByTestId("watch-row").first().locator("button").first().click();
  await expect(myWork).toBeVisible();
  await expect(page.locator('[data-testid="my-work-item"][data-key="demo/demo-app#12"]')).toHaveClass(/bg-accent/);

  // The project menu (right-click): Watch default-branch CI. main is red already: its card, a ✗ row, no red dot (D36).
  mock.addRun("demo", "demo-app", { name: "deploy", status: "completed", conclusion: "failure", head_branch: "main" });
  const header = project.locator(":scope > div").first();
  const toggle = header.locator("button").first();
  await header.click({ button: "right" });
  await expect(page.getByTestId("project-menu")).toBeVisible();
  await expect(page.getByTestId("project-menu-ci")).toHaveAttribute("aria-checked", "false");
  await page.getByTestId("project-menu-ci").click();
  await expect(project.locator('[data-testid="watch-row"][data-tone="bad"]')).toHaveCount(1);
  await expect(page.getByTestId("card-ci").filter({ hasText: "main" })).toHaveCount(1);
  await expect(project.getByTestId("project-needs-you")).toHaveCount(0);
  // The menu (its ⋯ button, shown on hover or keyboard focus) shows it's on.
  await header.hover();
  await project.getByTestId("project-menu-button").click();
  await expect(page.getByTestId("project-menu-ci")).toHaveAttribute("aria-checked", "true");
  // A menu for the keyboard: the focus is in it, ↓ moves, Escape closes it and gives the focus back to ⋯.
  await expect(page.getByTestId("project-menu-ci")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("project-menu-open")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("project-menu")).toHaveCount(0);
  await expect(project.getByTestId("project-menu-button")).toBeFocused();
  // A click elsewhere closes it too.
  await project.getByTestId("project-menu-button").click();
  await expect(page.getByTestId("project-menu")).toBeVisible();
  await page.getByTestId("composer").click();
  await expect(page.getByTestId("project-menu")).toHaveCount(0);
  // Collapsed, the project shows a quiet ✗ (still no red dot).
  await toggle.click();
  await expect(project.getByTestId("project-ci-red")).toBeVisible();
  await expect(project.getByTestId("project-needs-you")).toHaveCount(0);
  await toggle.click();

  // The live strip, with the sidebar collapsed: a chip for the red watch, gone once you've looked at its card.
  await page.getByTestId("my-work-close").click();
  await page.getByTestId("toggle-sidebar").click();
  const chip = page.locator('[data-testid="live-watch-chip"][data-tone="bad"]');
  await expect(chip).toHaveCount(1);
  await chip.click();
  await expect(chip).toHaveCount(0);
  await page.getByTestId("toggle-sidebar").click();

  // Stop, from the row: it ends, and moves behind "Show older".
  const red = project.locator('[data-testid="watch-row"][data-tone="bad"]');
  await red.hover();
  await red.getByTestId("watch-row-stop").click();
  await expect(red).toHaveCount(0);
  expect((await state(page)).watches.find((w) => w.kind === "branch")).toMatchObject({ state: "ended", endedReason: "unwatched" });

  // GitHub leaves out an organisation's repositories (SSO): My work says so after its next search.
  mock.searchSsoPartial = true;
  await hooks((h, ms: number) => h.clock.advance(ms), 61_000);
  await page.evaluate(() => (window as unknown as { aria: AriaApi }).aria.myWork({ refresh: true }));
  await page.getByTestId("nav-my-work").click();
  await expect(page.getByTestId("my-work-partial")).toContainText("single sign-on");

  // Every request was a GET with the test token; the searches named only the project's repository.
  expect(mock.requests.every((r) => r.method === "GET" && r.authorized)).toBe(true);
  const searched = mock.requests.filter((r) => r.path === "/search/issues").map((r) => r.query.q ?? "");
  expect(searched.length).toBeGreaterThan(0);
  expect(searched.every((q) => / repo:demo\/demo-app$/.test(q))).toBe(true);
});
