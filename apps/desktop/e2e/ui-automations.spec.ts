/**
 * Phase 6B E2E spec (PLAN.md §4.3, §4.12, §4.14, §5.1, §5.2, §5.4, §5.5, §10 Phase 6B), against the scripted runtime
 * (`ARIA_FAKE_RUNTIME=ui-cards` and `ARIA_E2E_HOOKS=1`):
 * - Utility model slot and daily draft time in Customize › Models.
 * - `remind_me` and `schedule_routine` tools in the chat, advancing the E2E clock so the Reminder card (`R-1`) fires,
 *   snoozing it (`Snooze 15m`), advancing again, and marking it `Done`.
 * - Sidebar **Automations** view (`nav-automations`): managing routines, toggling enable/disable, triggering **Run now**
 *   on Morning brief and Friday week time overview, and jumping from an unregistered workday on the Morning brief card
 *   directly into the **Time** view.
 * Run after `npm run build`:  npx playwright test ui-automations   (from apps/desktop)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { useAcmeTracker } from "./acme.ts";
import { GIT_NO_FSMONITOR, GIT_TEST_ENV } from "./git-env.ts";

const appDir = path.resolve(import.meta.dirname, "..");
let base = "";
let env: Record<string, string> = {};
let app: ElectronApplication | undefined;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...GIT_NO_FSMONITOR, "-c", "user.name=ARIA E2E", "-c", "user.email=e2e@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

async function launch(): Promise<Page> {
  app = await electron.launch({ args: [appDir], env, timeout: 60_000 });
  const page = await app.firstWindow();
  await expect(page.getByTestId("status")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  return page;
}

async function sendChat(page: Page, text: string): Promise<void> {
  await page.getByTestId("composer").fill(text);
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("status")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
}

async function advanceClock(ms: number): Promise<void> {
  await app!.evaluate((_electron, delta) => {
    const hooks = (globalThis as { __ariaE2E?: { clock: { advance: (ms: number) => void } } }).__ariaE2E;
    hooks?.clock.advance(delta);
  }, ms);
}

test.beforeAll(() => {
  base = mkdtempSync(path.join(os.tmpdir(), "aria-e2e-6b-"));
  const repo = path.join(base, "GitHub", "Demo App");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "# Demo App\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Initial commit");
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  env = {
    ...inherited,
    ...GIT_TEST_ENV,
    ARIA_FAKE_RUNTIME: "ui-cards",
    ARIA_E2E_HOOKS: "1",
    ARIA_DATA_DIR: path.join(base, "data"),
    // The morning brief's unregistered workdays need a tracker that registers time: the fictional Acme Tracker.
    ...useAcmeTracker(path.join(base, "data")),
    ARIA_PROJECT_ROOTS: path.join(base, "GitHub"),
    ARIA_WORKTREE_ROOT: path.join(base, "wt"),
  };
});

test.afterAll(async () => {
  await app?.close().catch(() => {
    // Teardown: the app may be gone already, and the test has its result.
  });
  if (base) rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

test("Automations view, reminders, routines, utility model and morning brief", async () => {
  test.setTimeout(5 * 60_000);
  const page = await launch();

  // 1. Customize › Models: enable the Utility model slot
  await page.getByTestId("nav-customize").click();
  const utilSection = page.getByTestId("utility-model");
  await expect(utilSection).toBeVisible();
  await utilSection.getByTestId("utility-enabled").check();
  await utilSection.getByTestId("utility-save").click();
  await expect(utilSection.getByTestId("utility-saved")).toBeVisible();

  // 2. Back to ARIA chat: ask to set a reminder and schedule a routine
  await page.getByTestId("nav-aria").click();
  await sendChat(page, "remind me in 10 minutes to check the deployment");
  await expect(page.getByTestId("msg-assistant").last()).toContainText("Set reminder R-1 in 10 minutes: Check the deployment.");

  await sendChat(page, "every weekday at 10:00 schedule a routine to check open PRs");
  await expect(page.getByTestId("msg-assistant").last()).toContainText("Scheduled routine “Weekday PR check”");

  // 3. Advance the E2E clock by 10 minutes -> Reminder card R-1 fires in the chat!
  await advanceClock(10 * 60_000);
  const remCard = page.getByTestId("card-reminder");
  await expect(remCard).toBeVisible();
  await expect(remCard.getByTestId("reminder-text")).toHaveText("Check the deployment");
  await expect(remCard.getByTestId("reminder-status")).toHaveText("Due now");
  await expect(page.getByTestId("nav-automations-due")).toHaveText("1");

  // Snooze for 15m -> status becomes Snoozed, then advance 15m -> fires again, then click Done
  await remCard.getByTestId("reminder-snooze-15m").click();
  await expect(remCard.getByTestId("reminder-status")).toContainText("Snoozed until");
  await advanceClock(15 * 60_000);
  await expect(remCard.getByTestId("reminder-status")).toHaveText("Due now");
  await remCard.getByTestId("reminder-done").click();
  await expect(remCard.getByTestId("reminder-status")).toHaveText("Done");

  // 4. Open Automations view from the sidebar (`nav-automations`)
  await page.getByTestId("nav-automations").click();
  const autoView = page.getByTestId("automations-view");
  await expect(autoView).toBeVisible();
  await expect(autoView.getByTestId("routine-row")).toHaveCount(4); // 3 built-in + 1 custom

  // Trigger Run now on Morning brief
  const morningRow = autoView.locator('[data-routine-id="builtin:morning-brief"]');
  await morningRow.getByTestId("routine-run-now").click();
  await expect(morningRow.getByTestId("routine-last-status")).toHaveText("last run ok");

  // Trigger Run now on Friday week time overview
  const weeklyRow = autoView.locator('[data-routine-id="builtin:weekly-time-overview"]');
  await weeklyRow.getByTestId("routine-run-now").click();
  await expect(weeklyRow.getByTestId("routine-last-status")).toHaveText("last run ok");

  // 5. Return to ARIA chat and inspect the Morning brief card + open unregistered day in Time view
  await page.getByTestId("nav-aria").click();
  const briefCard = page.getByTestId("card-morning-brief").first();
  await expect(briefCard).toBeVisible();
  await expect(briefCard.getByTestId("morning-brief-ai-summary")).toBeVisible();
  await expect(briefCard.getByTestId("morning-brief-unregistered")).toBeVisible();

  await briefCard.getByTestId("morning-brief-open-time").first().click();
  await expect(page.getByTestId("time-view")).toBeVisible();
});
