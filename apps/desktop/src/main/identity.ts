/**
 * Who the app is to the OS: the name of its data folder, shortcuts and installer, and the id Windows keys its notifications,
 * login item and install on. Written once here. `electron-builder.yml` repeats both (`productName` and `appId`), and a unit
 * test holds the two together. Pure (no Electron), so a test can use it.
 */
import path from "node:path";

export const PRODUCT_NAME = "ARIA";
export const APP_ID = "dev.aria.desktop";

/**
 * Where the app keeps everything it stores, for every start: `<appData>\<product name>`, never a folder Electron picks by itself.
 * Two development switches move it (a packaged build has dropped both, `dropDevSwitches`): ARIA_DATA_DIR names the data
 * folder itself (the UI tests), and ARIA_APPDATA_DIR stands in for the system's per-user data folder, so a test can run the
 * real naming rule and see which folders appear under it.
 */
export function userDataDir(appData: string, productName: string, env: NodeJS.ProcessEnv): string {
  if (!productName || productName === "." || productName === ".." || /[\\/:*?"<>|]/.test(productName)) {
    throw new Error(`"${productName}" can't be the name of a data folder.`);
  }
  if (env.ARIA_DATA_DIR) return path.resolve(env.ARIA_DATA_DIR);
  const root = env.ARIA_APPDATA_DIR ? path.resolve(env.ARIA_APPDATA_DIR) : appData;
  return path.join(root, productName);
}
