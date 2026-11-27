/**
 * Phase 5C UI E2E spec (`ARIA_FAKE_RUNTIME=ui-cards`, `ARIA_E2E_HOOKS=1`):
 * - Customize › Models configures the Timekeeper's model, effort, and daily settings;
 * - Asking ARIA `"prepare my timesheet for 2026-10-23"` runs the Timekeeper and renders `card-timesheet` with
 *   summary (`draft 7h of 8h · 1 gap · 1 uncertain`), gap chip (`14:00–15:00`), and rows;
 * - Confirming the uncertain Standup row offers `"Always map \"Daily Standup\" meetings to Acme Tracker task #ACME-101?"`, and
 *   clicking **Save rule** saves the rule;
 * - Telling ARIA `"the 14:00 to 15:00 block was Design sync on task ACME-456"` fills the gap and updates the card to
 *   `draft 8h of 8h` with 0 gaps and 0 uncertain rows.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { GIT_NO_FSMONITOR, GIT_TEST_ENV } from "./git-env.ts";
import { useAcmeTracker } from "./acme.ts";

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

test.beforeAll(() => {
  base = mkdtempSync(path.join(os.tmpdir(), "aria-e2e-timesheet-"));
  const repo = path.join(base, "GitHub", "Demo App");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  // The repo knows who you are, as yours does: the scan counts a commit as yours by your git name or email, not by a name that
  // happens to contain the app's name (it used to).
  git(repo, "config", "user.name", "ARIA E2E");
  git(repo, "config", "user.email", "e2e@example.invalid");
  writeFileSync(path.join(repo, "README.md"), "# Demo App\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--date=2026-10-23T11:00:00Z", "-m", "Add dark mode toggle (task ACME-123)");
  const inherited = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  env = {
    ...inherited,
    ...GIT_TEST_ENV,
    ARIA_FAKE_RUNTIME: "ui-cards",
    ARIA_E2E_HOOKS: "1",
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
  if (base) rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

test("Timekeeper model slot, Timesheet draft card, learning rule offer, and conversational correction", async () => {
  test.setTimeout(5 * 60_000);
  const page = await launch();

  // 1. Configure the Timekeeper model in Customize › Models
  await page.getByTestId("nav-customize").click();
  const tkSection = page.getByTestId("timekeeper-model");
  await expect(tkSection).toBeVisible();
  await tkSection.getByTestId("timekeeper-model-select").selectOption("fake-strong");
  await tkSection.getByTestId("timekeeper-effort-select").selectOption("high");
  // The other commit authors that count as yours: empty at first, kept one per line once saved.
  await expect(tkSection.getByTestId("timekeeper-own-authors")).toHaveValue("");
  await tkSection.getByTestId("timekeeper-own-authors").fill("Sam R.\nbot@ci.example");
  await tkSection.getByTestId("save-timekeeper-model").click();
  await expect(tkSection.getByTestId("timekeeper-saved")).toBeVisible();
  await expect(tkSection.getByTestId("timekeeper-own-authors")).toHaveValue("Sam R.\nbot@ci.example");

  // 2. Ask ARIA to prepare the timesheet for 2026-10-23
  await page.getByTestId("nav-aria").click();
  await page.getByTestId("composer").fill("prepare my timesheet for 2026-10-23");
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("msg-assistant").last()).toContainText("Prepared your timesheet draft");

  const card = page.getByTestId("card-timesheet");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("timesheet-summary")).toContainText("draft 7h of 8h · 1 gap · 1 uncertain");
  await expect(card.getByTestId("timesheet-fill-gap")).toContainText("14:00–15:00 (1h)");

  // 3. Confirm the uncertain Daily Standup row -> triggers "Always map \"Daily Standup\" meetings to Acme Tracker task #ACME-101?"
  const standupRow = card.getByTestId("timesheet-row").filter({ hasText: "Daily Standup" });
  await expect(standupRow.getByTestId("timesheet-row-uncertain")).toBeVisible();
  await standupRow.getByTestId("timesheet-row-confirm").click();
  await expect(standupRow.getByTestId("timesheet-row-uncertain")).toHaveCount(0);

  const ruleOffer = card.getByTestId("timesheet-rule-offer");
  await expect(ruleOffer).toContainText('Always map "Daily Standup" meetings to Acme Tracker task #ACME-101');
  await ruleOffer.getByTestId("timesheet-rule-accept").click();
  await expect(ruleOffer).toHaveCount(0);

  // 4. Fill the 14:00–15:00 gap conversationally through ARIA
  await page.getByTestId("composer").fill("the 14:00 to 15:00 block was Design sync on task ACME-456");
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("msg-assistant").last()).toContainText("Added 14:00–15:00");

  await expect(card.getByTestId("timesheet-summary")).toContainText("draft 8h of 8h");
  await expect(card.getByTestId("timesheet-gaps")).toHaveCount(0);
  await expect(card.getByTestId("timesheet-row")).toHaveCount(4);

  // 5. Phase 5D: Click Submit on the Timesheet draft card -> registers all 4 rows in Acme Tracker
  await expect(card.getByTestId("timesheet-submit")).toBeEnabled();
  await card.getByTestId("timesheet-submit").click();

  const regCard = page.getByTestId("card-time-registered");
  await expect(regCard).toBeVisible();
  await expect(regCard.getByTestId("time-registered-title")).toContainText("Registered 8h");
  await expect(regCard.getByTestId("time-registered-entry-id")).toHaveCount(4);
  await expect(regCard.getByTestId("time-registered-entry-id").first()).toContainText("Acme Tracker #9000000");

  // 6. Open Time view from the Time registered card -> inspect week strip, registered entries, activities, and mapping rules
  await regCard.getByTestId("time-registered-open-time-view").click();
  const timeView = page.getByTestId("time-view");
  await expect(timeView).toBeVisible();
  await expect(timeView.getByTestId("time-week-day")).toHaveCount(7);
  await expect(timeView.getByTestId("time-registered-item")).toHaveCount(4);
  await expect(timeView.getByTestId("time-rule-row")).toHaveCount(1);

  // 7. Edit registered entry #9000000 in the Time view (runs update_worklog)
  const firstReg = timeView.getByTestId("time-registered-item").filter({ hasText: "Acme Tracker #9000000" });
  await firstReg.getByTestId("time-registered-edit").click();
  const regEditor = timeView.getByTestId("time-registered-editor");
  await regEditor.getByTestId("time-reg-edit-comment").fill("Daily Standup (updated)");
  await regEditor.getByTestId("time-registered-save").click();
  await expect(timeView.getByTestId("time-registered-item").filter({ hasText: "Daily Standup (updated)" })).toBeVisible();

  // 8. Delete registered entry #9000003 after ticking the confirmation checkbox (runs delete_worklogs)
  const lastReg = timeView.getByTestId("time-registered-item").filter({ hasText: "Acme Tracker #9000003" });
  await lastReg.getByTestId("time-registered-delete").click();
  const confirmBox = timeView.getByTestId("time-delete-confirm-box");
  await expect(confirmBox).toBeVisible();
  await expect(confirmBox.getByTestId("time-delete-confirm-run")).toBeDisabled();
  await confirmBox.getByTestId("time-delete-confirm-tick").check();
  await expect(confirmBox.getByTestId("time-delete-confirm-run")).toBeEnabled();
  await confirmBox.getByTestId("time-delete-confirm-run").click();
  await expect(timeView.getByTestId("time-registered-item")).toHaveCount(3);

  // 9. Mapping rules editor CRUD in the Time view: add a branch rule, toggle it, and delete it
  await timeView.getByTestId("time-rule-new").click();
  const ruleForm = timeView.getByTestId("time-rule-form");
  await expect(ruleForm).toBeVisible();
  await ruleForm.getByTestId("time-rule-kind").selectOption("branch");
  await ruleForm.getByTestId("time-rule-pattern").fill("feature/design");
  await ruleForm.getByTestId("time-rule-task").fill("ACME-456");
  await ruleForm.getByTestId("time-rule-task-title").fill("Design sync");
  await ruleForm.getByTestId("time-rule-save").click();
  await expect(timeView.getByTestId("time-rule-row")).toHaveCount(2);

  const branchRule = timeView.getByTestId("time-rule-row").filter({ hasText: "feature/design" });
  await expect(branchRule).toBeVisible();
  await branchRule.getByTestId("time-rule-delete").click();
  await expect(timeView.getByTestId("time-rule-row")).toHaveCount(1);

  // 10. Inline gap-fill in the Time view for the freed 14:00–15:00 slot & re-submit
  await timeView.getByTestId("time-fill-gap").click();
  const draftEditor = timeView.getByTestId("time-draft-editor");
  await expect(draftEditor).toBeVisible();
  await draftEditor.getByTestId("time-draft-edit-task").fill("ACME-456");
  await draftEditor.getByTestId("time-draft-edit-comment").fill("Design follow-up");
  await draftEditor.getByTestId("time-draft-save").click();
  await expect(timeView.getByTestId("time-draft-row")).toHaveCount(1);
  await timeView.getByTestId("time-submit").click();
  await expect(timeView.getByTestId("time-registered-item")).toHaveCount(4);
});
