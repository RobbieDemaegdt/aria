/**
 * Phase 6D E2E spec (PLAN.md §4.7, §5.5, §10 Phase 6D), against the scripted runtime
 * (`ARIA_FAKE_RUNTIME=ui-cards` and `ARIA_E2E_HOOKS=1`):
 * - Configuring **Spoken announcements** (`voice-spoken`), **Test voice** (`voice-test-tts`), and OS-keychain cloud
 *   API key storage (`voice-cloud-key`) in Customize › Notifications.
 * - Verifying ARIA speaks a short announcement when a background task finishes (`__ariaE2E.spoken` and
 *   `window.__ariaSpoken`).
 * - Using **Push-to-talk** in the chat composer (`composer-ptt`) and in the Quick prompt bar (`quick-prompt-ptt` /
 *   `Ctrl+Shift+Space`) to transcribe speech into the input box and send it.
 * Run after `npm run build`:  npx playwright test ui-phase6d   (from apps/desktop)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
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

test.beforeAll(() => {
  base = mkdtempSync(path.join(os.tmpdir(), "aria-e2e-6d-"));
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

test("Voice spoken announcements and Push-to-talk in chat and Quick prompt bar", async () => {
  test.setTimeout(5 * 60_000);
  const page = await launch();

  // 1. Configure Voice in Customize › Notifications
  await page.getByTestId("nav-customize").click();
  await page.getByTestId("customize-notifications").click();
  const voiceSection = page.getByTestId("voice-section");
  await expect(voiceSection).toBeVisible();

  await page.getByTestId("voice-spoken").selectOption("all");
  await expect(page.getByTestId("notifications-saved")).toContainText("ARIA will speak milestones and blocking items.");

  // Click Test voice -> records spoken utterance in window.__ariaSpoken
  await page.getByTestId("voice-test-tts").click();
  const testSpoken = await page.evaluate(
    () => (window as unknown as { __ariaSpoken?: Array<{ text: string; priority: string }> }).__ariaSpoken ?? [],
  );
  expect(testSpoken.length).toBeGreaterThanOrEqual(1);
  expect(testSpoken.at(-1)!.text).toContain("Dark mode toggle is done, tests pass.");

  // Switch STT provider to cloud, save an API key in OS keychain, verify status, then clear and return to whisper.cpp
  await page.getByTestId("voice-stt-provider").selectOption("cloud");
  await expect(page.getByTestId("voice-cloud-config")).toBeVisible();
  await page.getByTestId("voice-cloud-key").fill("sk-e2e-secret-key");
  await page.getByTestId("voice-cloud-key-save").click();
  await expect(page.getByTestId("notifications-saved")).toContainText("Saved cloud voice API key in OS keychain.");
  await expect(page.getByTestId("voice-cloud-key-clear")).toBeVisible();
  await page.getByTestId("voice-cloud-key-clear").click();
  await expect(page.getByTestId("notifications-saved")).toContainText("Cleared cloud voice API key.");
  await page.getByTestId("voice-stt-provider").selectOption("whisper.cpp");

  // 2. Start a task and verify ARIA speaks a short announcement when it finishes
  await page.getByTestId("nav-aria").click();
  await page.getByTestId("nav-new-session").click();
  await page.getByTestId("new-session-title").fill("Preview task");
  await page.getByTestId("new-session-brief").fill("Preview task: build HTML preview dashboard");
  await page.getByTestId("new-session-start").click();

  await expect(page.getByTestId("card-done")).toBeVisible({ timeout: 30_000 });

  await expect
    .poll(async () => {
      return app!.evaluate(() => {
        const g = globalThis as unknown as { __ariaE2E?: { spoken: Array<{ text: string; priority: string }> } };
        return g.__ariaE2E?.spoken.map((s) => s.text) ?? [];
      });
    })
    .toEqual(expect.arrayContaining([expect.stringContaining("Preview task is done.")]));

  await expect
    .poll(async () =>
      page.evaluate(() =>
        ((window as unknown as { __ariaSpoken?: Array<{ text: string }> }).__ariaSpoken ?? []).map((s) => s.text),
      ),
    )
    .toEqual(expect.arrayContaining([expect.stringContaining("Preview task is done.")]));

  // 3. Push-to-talk in the Chat composer (`composer-ptt`)
  await app!.evaluate(() => {
    const g = globalThis as unknown as { __ariaE2E?: { fakeTranscript?: string } };
    if (g.__ariaE2E) g.__ariaE2E.fakeTranscript = "/status";
  });

  const composerPtt = page.getByTestId("composer-ptt");
  await composerPtt.click();
  await expect(composerPtt).toHaveAttribute("data-recording", "true");
  await composerPtt.click();
  await expect(composerPtt).toHaveAttribute("data-recording", "false");
  await expect(page.getByTestId("composer")).toHaveValue("/status");
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("msg-assistant").last()).toContainText("ARIA status:");

  // 4. Push-to-talk in the Quick prompt bar (`Ctrl+Space` -> `Ctrl+Shift+Space`)
  await app!.evaluate(() => {
    const g = globalThis as unknown as { __ariaE2E?: { fakeTranscript?: string; openQuickPrompt(): void } };
    if (g.__ariaE2E) {
      g.__ariaE2E.fakeTranscript = "How are my tasks?";
      g.__ariaE2E.openQuickPrompt();
    }
  });

  const quickPrompt = page.getByTestId("quick-prompt");
  await expect(quickPrompt).toBeVisible();
  const qpInput = page.getByTestId("quick-prompt-input");
  const qpPtt = page.getByTestId("quick-prompt-ptt");

  await qpInput.press("Control+Shift+Space");
  await expect(qpPtt).toHaveAttribute("data-recording", "true");
  await qpInput.press("Control+Shift+Space");
  await expect(qpPtt).toHaveAttribute("data-recording", "false");
  await expect(qpInput).toHaveValue("How are my tasks?");
  await qpInput.press("Enter");
  await expect(quickPrompt).toBeHidden();
  await expect(page.getByTestId("msg-assistant").last()).toContainText("How are my tasks?");
});
