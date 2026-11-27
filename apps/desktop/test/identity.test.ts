/**
 * The app's identity is written in a few places that must agree: `identity.ts`, `index.ts`, `electron-builder.yml`, the installer
 * workflow. These tests read the files, so a name changed in one place and not the others fails here, whatever the name is.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dropDevSwitches } from "../src/main/hardening";
import { APP_ID, PRODUCT_NAME, userDataDir } from "../src/main/identity";

const appDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(appDir, "..", "..");
const read = (...p: string[]) => readFileSync(path.join(repoRoot, ...p), "utf8");
const builder = read("apps", "desktop", "electron-builder.yml");
const indexTs = read("apps", "desktop", "src", "main", "index.ts");
const installer = read(".github", "workflows", "installer.yml");
/** A value of a key in `electron-builder.yml`, at any depth. */
const yml = (key: string): string => {
  const m = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m").exec(builder);
  if (!m) throw new Error(`electron-builder.yml has no ${key}`);
  return m[1]!.replace(/^["']|["']$/g, "");
};

describe("what the app is called, in every place that says it", () => {
  it("has one product name and one app id, the same in electron-builder.yml", () => {
    expect(yml("appId")).toBe(APP_ID);
    expect(yml("productName")).toBe(PRODUCT_NAME);
    expect(yml("executableName")).toBe(PRODUCT_NAME);
    expect(yml("shortcutName")).toBe(PRODUCT_NAME);
    expect(yml("uninstallDisplayName")).toBe(PRODUCT_NAME);
  });

  it("uses both in index.ts, and nowhere sets the data folder or the id another way", () => {
    expect(indexTs).toContain("app.setName(PRODUCT_NAME);");
    expect(indexTs).toContain("app.setAppUserModelId(APP_ID);");
    expect(indexTs).toContain('app.setPath("userData", userDataDir(app.getPath("appData"), PRODUCT_NAME, process.env));');
    expect(indexTs.match(/setPath\("userData"/g)).toHaveLength(1);
    expect(indexTs.match(/setAppUserModelId\(/g)).toHaveLength(1);
    expect(indexTs.match(/setName\(/g)).toHaveLength(1);
    expect(indexTs).not.toContain(APP_ID);
  });

  it("names the installer after the product, in the builder and in the workflow that finds and uploads it", () => {
    expect(yml("artifactName")).toBe("${productName}-Setup-${version}.${ext}");
    const globs = [...installer.matchAll(/apps\/desktop\/dist\/([^"'\s]*)/g)].map((m) => m[1]!);
    expect(globs.length).toBeGreaterThanOrEqual(2);
    for (const glob of globs) expect(glob.startsWith(`${PRODUCT_NAME}-Setup-`)).toBe(true);
  });

  it("keeps the workspace packages out of the installer, whatever their scope is called", () => {
    const rootPkg = JSON.parse(read("package.json")) as { workspaces: string[] };
    const scopes = new Set<string>();
    let workspaces = 0;
    for (const pattern of rootPkg.workspaces) {
      const dir = pattern.replace(/\/\*$/, "");
      for (const entry of readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
        if (!entry.isDirectory() || !existsSync(path.join(repoRoot, dir, entry.name, "package.json"))) continue;
        const pkg = JSON.parse(read(dir, entry.name, "package.json")) as { name: string };
        workspaces++;
        const scope = /^(@[^/]+)\//.exec(pkg.name)?.[1];
        if (scope) scopes.add(scope);
      }
    }
    expect(workspaces).toBe(4);
    expect([...scopes]).toHaveLength(1);
    const scope = [...scopes][0]!;
    expect(builder).toContain(`"!node_modules/${scope}/**"`);
    expect(builder).toContain(`"!**/node_modules/${scope}/**"`);
  });
});

describe("userDataDir: where everything the app stores goes", () => {
  const appData = path.join("C:", "Users", "sam", "AppData", "Roaming");

  it("is <appData>\\<product name> on every start", () => {
    expect(userDataDir(appData, PRODUCT_NAME, {})).toBe(path.join(appData, PRODUCT_NAME));
    expect(path.basename(userDataDir(appData, PRODUCT_NAME, {}))).toBe(yml("productName"));
    expect(userDataDir(appData, "Two Words", {})).toBe(path.join(appData, "Two Words"));
  });

  it("lets a test name the data folder, or the folder it goes under, and the first wins", () => {
    const dir = path.join("D:", "tmp", "data");
    expect(userDataDir(appData, PRODUCT_NAME, { ARIA_DATA_DIR: dir })).toBe(dir);
    expect(userDataDir(appData, PRODUCT_NAME, { ARIA_APPDATA_DIR: path.join("D:", "tmp", "appdata") })).toBe(path.join("D:", "tmp", "appdata", PRODUCT_NAME));
    expect(userDataDir(appData, PRODUCT_NAME, { ARIA_DATA_DIR: dir, ARIA_APPDATA_DIR: path.join("D:", "tmp", "appdata") })).toBe(dir);
    expect(userDataDir(appData, PRODUCT_NAME, { ARIA_DATA_DIR: "", ARIA_APPDATA_DIR: "" })).toBe(path.join(appData, PRODUCT_NAME));
  });

  it("is never moved by a packaged build's environment (both switches are dropped first)", () => {
    const env: NodeJS.ProcessEnv = { ARIA_DATA_DIR: "D:\\elsewhere", ARIA_APPDATA_DIR: "D:\\elsewhere", PATH: "C:\\bin" };
    dropDevSwitches(true, env);
    expect(env).toEqual({ PATH: "C:\\bin" });
    expect(userDataDir(appData, PRODUCT_NAME, env)).toBe(path.join(appData, PRODUCT_NAME));
  });

  it("refuses a product name that isn't a plain folder name", () => {
    for (const bad of ["", ".", "..", "a\\b", "a/b", "C:", "..\\x", "a*b", 'a"b']) expect(() => userDataDir(appData, bad, {})).toThrow(/can't be the name of a data folder/);
  });
});
