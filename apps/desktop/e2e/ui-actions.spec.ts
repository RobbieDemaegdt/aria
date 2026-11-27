/**
 * Phase 5A UI E2E spec (`ARIA_FAKE_RUNTIME=ui-cards`, `ARIA_E2E_HOOKS=1`):
 * - Customize › Integrations shows `Ask (action card)` for ARIA write and destructive tools;
 * - Asking ARIA to create an Acme follow-up issue proposes an `action_request` card (`A-1`) with a decoded preview
 *   of `issuesJson` and the exact JSON payload;
 * - Editing the payload on the card and clicking Send runs the short-lived session and shows the server response;
 * - Asking ARIA to remove an issue from a sprint proposes a destructive `action_request` card (`A-2`) whose Confirm
 *   and run button stays disabled until the confirmation checkbox is ticked, then injects `confirm: true`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { GIT_NO_FSMONITOR, GIT_TEST_ENV } from "./git-env.ts";
import { ACME_BROWSE, ACME_LABEL, useAcmeTracker } from "./acme.ts";

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
  base = mkdtempSync(path.join(os.tmpdir(), "aria-e2e-actions-"));
  const repo = path.join(base, "GitHub", "Demo App");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "# Demo App\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Initial commit");
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

test("Action-request cards: propose, edit JSON, exact-payload Send, and destructive confirmation tick", async () => {
  test.setTimeout(5 * 60_000);
  const page = await launch();

  // 1. Propose an Acme issue write through ARIA
  await page.getByTestId("composer").fill("create an Acme follow-up issue for the review comments");
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("msg-assistant").last()).toContainText("Proposed A-1");

  const createCard = page.getByTestId("card-action-request").filter({ hasText: "Create issue: Address review comments" });
  await expect(createCard).toBeVisible();
  await expect(createCard.getByTestId("short-id")).toHaveText("A-1");
  await expect(createCard.getByTestId("action-class")).toHaveText("(write)");
  await expect(createCard.getByTestId("action-json-preview")).toContainText("Address review comments");

  // Edit the JSON payload inline before clicking Send
  await createCard.getByTestId("action-edit").click();
  const editor = createCard.getByTestId("action-args-input");
  await expect(editor).toBeVisible();
  const currentJson = await editor.inputValue();
  await editor.fill(currentJson.replace("Address review comments", "Address PR #37 review comments"));
  await createCard.getByTestId("action-send").click();

  await expect(createCard.getByTestId("action-title")).toHaveAttribute("data-status", "done");
  await expect(createCard.getByTestId("action-status")).toContainText("Sent · edited");
  await expect(createCard.getByTestId("action-result")).toContainText("Address PR #37 review comments");

  // 2. Propose a destructive Acme call (remove_issue_from_sprint)
  await page.getByTestId("composer").fill("remove ACME-456 from sprint 440");
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("msg-assistant").last()).toContainText("Proposed A-2");

  const removeCard = page.getByTestId("card-action-request").filter({ hasText: "Remove ACME-456 from sprint 440" });
  await expect(removeCard).toBeVisible();
  await expect(removeCard.getByTestId("action-class")).toHaveText("(destructive)");
  await expect(removeCard.getByTestId("action-send")).toBeDisabled();

  await removeCard.getByTestId("action-confirm-tick").check();
  await expect(removeCard.getByTestId("action-send")).toBeEnabled();

  // Editing the arguments clears the confirmation tick until ticked again for the edited arguments
  await removeCard.getByTestId("action-edit").click();
  const removeEditor = removeCard.getByTestId("action-args-input");
  await removeEditor.fill((await removeEditor.inputValue()).replace("440", "441"));
  await expect(removeCard.getByTestId("action-confirm-tick")).not.toBeChecked();
  await expect(removeCard.getByTestId("action-send")).toBeDisabled();

  await removeCard.getByTestId("action-confirm-tick").check();
  await expect(removeCard.getByTestId("action-send")).toBeEnabled();
  await removeCard.getByTestId("action-send").click();

  await expect(removeCard.getByTestId("action-title")).toHaveAttribute("data-status", "done");
  await expect(removeCard.getByTestId("action-args")).toContainText('"sprintId": "441"');
  await expect(removeCard.getByTestId("action-args")).toContainText('"confirm": true');

  // 3. Phase 5B: start a session with an Acme task URL in the New session dialog, verify badge on card & session view, and change it inline
  await page.getByTestId("nav-new-session").click();
  const dialog = page.getByTestId("new-session");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("new-session-brief").fill("Docs task: write the docs");
  await dialog.getByTestId("new-session-tracker").fill(`${ACME_BROWSE}/ACME-123`);
  await dialog.getByTestId("new-session-start").click();
  await expect(dialog).toBeHidden();

  const sessionView = page.getByTestId("session-view");
  await expect(sessionView).toBeVisible();
  await expect(sessionView.getByTestId("session-tracker-link")).toHaveText(`${ACME_LABEL} #ACME-123`);

  // Change the Acme task ID inline in the session view
  await sessionView.getByTestId("session-tracker-edit").click();
  await sessionView.getByTestId("session-tracker-input").fill("ACME-456");
  await sessionView.getByTestId("session-tracker-save").click();
  await expect(sessionView.getByTestId("session-tracker-link")).toHaveText(`${ACME_LABEL} #ACME-456`);

  await page.getByTestId("session-close").click();
  const taskCard = page.getByTestId("card-task").filter({ hasText: "Docs task" });
  await expect(taskCard.getByTestId("task-tracker")).toHaveText(`${ACME_LABEL} #ACME-456`);
});
