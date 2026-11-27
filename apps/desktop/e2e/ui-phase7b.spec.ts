/**
 * Phase 7B UI E2E spec (`ARIA_FAKE_RUNTIME=ui-cards`, `ARIA_E2E_HOOKS=1`):
 * - Opening **My work** (`nav-my-work`) shows the **Acme Tracker tasks** section (`my-work-tracker`) alongside GitHub items,
 *   populated from the cold-start baseline poll of `Acme-list_my_issues` with zero initial `tracker_update` cards.
 * - Clicking **Open on Acme Tracker** (`my-work-tracker-open`) records `${ACME_BROWSE}/<key>`
 *   in `hooks.external`.
 * - Clicking **Ask ARIA** (`my-work-tracker-ask`) pre-fills the chat composer with
 *   `About Acme Tracker task #<id> ("<title>"): `.
 * - Advancing `hooks.clock` by 10 minutes after Acme Tracker task changes (new assignment, status change, priority change,
 *   and new comment) emits `card-tracker-update` cards in the chat timeline with working **Open task**
 *   (`tracker-update-open`) and **Ask ARIA** (`tracker-update-ask`) actions.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { GIT_NO_FSMONITOR, GIT_TEST_ENV } from "./git-env.ts";
import { ACME_BROWSE, ACME_LABEL, useAcmeTracker } from "./acme.ts";
import { MockGitHub } from "../../../packages/core/test/mock-github.ts";
import { TEST_GITHUB_TOKEN } from "../src/main/github-options.ts";

const appDir = path.resolve(import.meta.dirname, "..");
let base = "";
let env: Record<string, string> = {};
let app: ElectronApplication | undefined;
const mock = new MockGitHub();

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...GIT_NO_FSMONITOR, "-c", "user.name=ARIA E2E", "-c", "user.email=e2e@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

type Hooks = {
  external: string[];
  clock: { advance(ms: number): void };
  runtime: { mcpResults: Record<string, unknown> };
};
const hooks = <T>(fn: (h: Hooks, arg: never) => T, arg?: unknown): Promise<Awaited<T>> =>
  app!.evaluate(
    (_electron, [source, value]) =>
      new Function("h", "arg", `return (${source})(h, arg)`)(
        (globalThis as unknown as { __ariaE2E: Hooks }).__ariaE2E,
        value,
      ),
    [fn.toString(), arg] as const,
  ) as Promise<Awaited<T>>;

test.beforeAll(async () => {
  base = mkdtempSync(path.join(os.tmpdir(), "aria-e2e-phase7b-"));
  const repo = path.join(base, "GitHub", "Demo App");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "# Demo App\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Initial commit");
  git(repo, "remote", "add", "origin", "https://github.com/demo/demo-app.git");

  await mock.start();
  mock.token = TEST_GITHUB_TOKEN;
  mock.addRepo("demo", "demo-app");
  mock.addPull("demo", "demo-app", 12, { title: "Add dark mode", author: "sam-test" });

  const inherited = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  env = {
    ...inherited,
    ...GIT_TEST_ENV,
    ARIA_FAKE_RUNTIME: "ui-cards",
    ARIA_E2E_HOOKS: "1",
    ARIA_FAKE_GITHUB: mock.baseUrl,
    ARIA_DATA_DIR: path.join(base, "data"),
    ...useAcmeTracker(path.join(base, "data")),
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

test("Acme Tracker tasks in My work and tracker_update cards on 10-minute poll", async () => {
  test.setTimeout(4 * 60_000);
  app = await electron.launch({ args: [appDir], env, timeout: 60_000 });
  const page = await app.firstWindow();
  await expect(page.getByTestId("status")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });

  // Cold-start baseline: zero tracker_update cards on startup
  await expect(page.getByTestId("card-tracker-update")).toHaveCount(0);

  // Open My work and verify the Acme Tracker tasks section renders the baseline tasks alongside GitHub items
  await page.getByTestId("nav-my-work").click();
  const myWork = page.getByTestId("my-work");
  await expect(myWork).toBeVisible();

  const trackerSection = page.getByTestId("my-work-tracker");
  await expect(trackerSection).toBeVisible();
  await expect(trackerSection.getByTestId("my-work-tracker-item")).toHaveCount(2);
  await expect(trackerSection).toContainText("Dark mode toggle");
  await expect(trackerSection).toContainText("Design sync");

  // Click Open on Acme Tracker on task #ACME-123
  const firstTask = trackerSection.locator('[data-testid="my-work-tracker-item"][data-task-id="ACME-123"]');
  await firstTask.getByTestId("my-work-tracker-open").click();
  await expect.poll(() => hooks((h) => h.external)).toContain(`${ACME_BROWSE}/ACME-123`);

  // Click Ask ARIA on task #ACME-123 -> pre-fills composer
  await firstTask.getByTestId("my-work-tracker-ask").click();
  await expect(page.getByTestId("composer")).toHaveValue(`About ${ACME_LABEL} task #ACME-123 ("Dark mode toggle"): `);

  // Simulate Acme Tracker task updates on the next 10-minute poll
  const issue = (key: string, summary: string, status: string, priority: string, type: string, project: { key: string; name: string }, due: string, more: object = {}) => ({
    key,
    fields: {
      summary,
      status: { name: status },
      priority: { name: priority },
      issuetype: { name: type },
      project,
      account: { id: "ACC7", name: "Northwind Ltd" },
      duedate: due,
      ...more,
    },
  });
  const demo = { key: "DEM", name: "Demo App" };
  await hooks(
    (h, nextTasks: unknown) => {
      h.runtime.mcpResults["Acme-list_my_issues"] = nextTasks;
      h.clock.advance(10 * 60_000);
    },
    {
      issues: [
        issue("ACME-123", "Dark mode toggle", "In Progress", "High", "Feature", demo, "2026-10-30", {
          comments: [{ id: "c-1", author: "Alice", body: "Updated contrast ratios and ready for review." }],
        }),
        issue("ACME-456", "Design sync", "In Progress", "High", "Task", demo, "2026-11-05"),
        issue("ACME-789", "Usage Report Export", "To Do", "Medium", "Feature", { key: "NOR", name: "Northwind Connector" }, "2026-11-15"),
      ],
    },
  );

  // Verify tracker_update cards arrive in the chat timeline
  await expect(page.getByTestId("card-tracker-update")).toHaveCount(4);
  const newCard = page.getByTestId("card-tracker-update").filter({ hasText: "Usage Report Export" });
  await expect(newCard).toBeVisible();
  await expect(newCard.getByTestId("tracker-update-title")).toContainText(`New ${ACME_LABEL} task assigned · #ACME-789`);

  // Open task button on tracker_update card
  await newCard.getByTestId("tracker-update-open").click();
  await expect.poll(() => hooks((h) => h.external)).toContain(`${ACME_BROWSE}/ACME-789`);

  // Ask ARIA button on tracker_update card
  await newCard.getByTestId("tracker-update-ask").click();
  await expect(page.getByTestId("composer")).toHaveValue(
    `About ${ACME_LABEL} task #ACME-789 ("Usage Report Export"): `,
  );
});
