/**
 * What the app is called, as a start shows it. Two things, in one run of the app (the scripted runtime: no model calls, no credits):
 *
 *  1. The window never says the old name. Every view (the chat, My work, Automations, Time, Search, the New session dialog and each
 *     Customize page) is read for its text, the text boxes' contents, the tooltips and labels, the window's title and the names of
 *     every file the app made in its own folder, and none may hold the old name; the product's own name must be there.
 *  2. A fresh start writes only to the product's own folder under the app-data folder, and leaves its neighbours alone. The app is
 *     given a throwaway stand-in for the system's per-user data folder (ARIA_APPDATA_DIR, development builds only) with two planted
 *     folders in it: `Other`, and one named after the old product, which can only exist because the app has a new name. Each
 *     holds a marker file that must be byte for byte and modification time the same afterwards, and nothing else may appear.
 *
 * The old name is spelled from two pieces, so this spec never holds it. The product's name is read from electron-builder.yml.
 * Run after `npm run build`:  npx playwright test ui-identity   (from apps/desktop)
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { GIT_TEST_ENV } from "./git-env.ts";

const appDir = path.resolve(import.meta.dirname, "..");
const productName = /^productName:\s*(.+?)\s*$/m.exec(readFileSync(path.join(appDir, "electron-builder.yml"), "utf8"))![1]!;
const OLD = ["Jar", "vis"].join("");
const oldName = new RegExp(OLD, "i");
const PLANTED = ["Other", OLD];
let base = "";
let appData = "";
let app: ElectronApplication | undefined;
let page: Page;
/** What each planted file was before the app started. */
const plantedBefore = new Map<string, { bytes: Buffer; modified: number }>();

test.describe.configure({ mode: "serial" });

async function launch(env: Record<string, string>): Promise<Page> {
  app = await electron.launch({ args: [appDir], env, timeout: 60_000 });
  const first = await app.firstWindow();
  await expect(first.getByTestId("status")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
  return first;
}

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Every file and folder under a folder, as paths relative to it. */
const listAll = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => [e.name, ...(e.isDirectory() ? listAll(path.join(dir, e.name)).map((c) => path.join(e.name, c)) : [])]);

/** All the text a person could read in the window now: the page's text, the text boxes' contents, the options, and the labels, tooltips and placeholders. */
const readWindow = (): Promise<string> =>
  page.evaluate(() => {
    const parts: string[] = [document.title, document.body.innerText];
    for (const el of Array.from(document.querySelectorAll("input, textarea, select"))) parts.push((el as HTMLInputElement).value ?? "");
    for (const el of Array.from(document.querySelectorAll("option"))) parts.push(el.textContent ?? "");
    for (const el of Array.from(document.querySelectorAll("[aria-label], [title], [placeholder], [alt]"))) {
      for (const attribute of ["aria-label", "title", "placeholder", "alt"]) {
        const value = el.getAttribute(attribute);
        if (value) parts.push(value);
      }
    }
    return parts.join("\n");
  });

test.beforeAll(() => {
  base = mkdtempSync(path.join(os.tmpdir(), "identity-e2e-"));
  appData = path.join(base, "appdata");
  mkdirSync(path.join(base, "GitHub"), { recursive: true });
  for (const folder of PLANTED) {
    mkdirSync(path.join(appData, folder), { recursive: true });
    const file = path.join(appData, folder, "marker.txt");
    writeFileSync(file, `planted in ${folder} before the app starts\n`);
    plantedBefore.set(file, { bytes: readFileSync(file), modified: statSync(file).mtimeMs });
  }
});

test.afterAll(async () => {
  await app?.close().catch(() => {
    // Teardown: the app may be gone already, and the test has its result.
  });
  if (base) rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

test("the window says the product's name and never the old one, in every view", async () => {
  test.setTimeout(4 * 60_000);
  const inherited = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  page = await launch({
    ...inherited,
    ...GIT_TEST_ENV,
    ARIA_FAKE_RUNTIME: "ui-cards",
    ARIA_APPDATA_DIR: appData,
    ARIA_PROJECT_ROOTS: path.join(base, "GitHub"),
    ARIA_WORKTREE_ROOT: path.join(base, "wt"),
  });
  await expect(page.getByTestId("nav-aria")).toBeVisible();

  const seen: string[] = [];
  const check = async (view: string) => {
    await page.waitForTimeout(300);
    const text = await readWindow();
    seen.push(view);
    const hit = oldName.exec(text);
    expect(hit, `the old name is in the window's text in "${view}": ...${hit ? text.slice(Math.max(0, hit.index - 40), hit.index + 40).replace(/\s+/g, " ") : ""}...`).toBeNull();
    return text;
  };

  // The chat, the first thing you see: it names the product.
  const chat = await check("chat");
  expect(chat).toContain(productName);

  for (const [testId, view] of [["nav-my-work", "My work"], ["nav-automations", "Automations"], ["nav-time", "Time"], ["nav-search", "Search"]] as const) {
    await page.getByTestId(testId).click();
    await check(view);
  }

  // The New session dialog, then each Customize page (the Prompts page shows the system prompt in a text box).
  await page.getByTestId("nav-new-session").click();
  await expect(page.getByTestId("new-session")).toBeVisible();
  await check("New session");
  await page.keyboard.press("Escape");
  await page.getByTestId("nav-customize").click();
  for (const customizePage of ["models", "permissions", "prompts", "notifications", "memory", "integrations", "data"]) {
    await page.getByTestId(`customize-${customizePage}`).click();
    const text = await check(`Customize › ${customizePage}`);
    if (customizePage === "prompts") expect(text).toContain(`${productName} (system prompt)`);
  }
  await page.getByTestId("nav-aria").click();
  await check("chat again");

  // The window's own title, and the names of what the app made in its own folder.
  const titles = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()));
  expect(titles.length).toBeGreaterThan(0);
  for (const title of titles) expect(title).not.toMatch(oldName);
  expect(titles.join(" ")).toContain(productName);
  const own = path.join(appData, productName);
  const made = listAll(own);
  expect(made.length).toBeGreaterThan(0);
  expect(made.filter((name) => oldName.test(name))).toEqual([]);
  console.log(`views read: ${seen.join(", ")}; files and folders the app made: ${made.length}`);
});

test("a start makes the product's own folder and nothing else under the app-data folder, and leaves the planted neighbours as they were", async () => {
  test.setTimeout(3 * 60_000);
  const planted = PLANTED.map((folder) => path.join(appData, folder, "marker.txt"));
  const own = path.join(appData, productName);

  // Every place the app keeps its own files is inside the product's folder. (`cache` is not one: Electron's "cache" is the base
  // folder caches go under, the real per-user data folder, which the app's own code never asks for. It is printed for the log only.)
  const paths = await app!.evaluate(({ app: electronApp }) => Object.fromEntries(["userData", "sessionData", "logs", "crashDumps", "cache"].map((key) => [key, electronApp.getPath(key as "userData")])));
  console.log(`app.getPath: ${JSON.stringify(paths)}`);
  for (const key of ["userData", "sessionData", "logs", "crashDumps"]) expect(inside(paths[key]!, own), `${key} is ${paths[key]}, outside ${own}`).toBe(true);
  expect(paths.userData).toBe(own);

  // The database is in it, and under the app-data folder there are the planted folders and the product's folder: nothing else.
  expect(readdirSync(appData).sort()).toEqual([...PLANTED, productName].sort());
  expect(readdirSync(own).some((name) => name.endsWith(".db"))).toBe(true);

  await app!.close();
  app = undefined;
  expect(readdirSync(appData).sort()).toEqual([...PLANTED, productName].sort());
  for (const file of planted) {
    const before = plantedBefore.get(file)!;
    expect(existsSync(file), file).toBe(true);
    expect(readFileSync(file), file).toEqual(before.bytes);
    expect(statSync(file).mtimeMs, `${file} was modified`).toBe(before.modified);
    expect(readdirSync(path.dirname(file)), path.dirname(file)).toEqual(["marker.txt"]);
  }
});
