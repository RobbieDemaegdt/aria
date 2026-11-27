/**
 * What a packaged ARIA takes from outside itself. Its development switches can point the window at another page, or
 * ARIA at another database or MCP config, so a packaged build drops them before anything reads them. Pure (no
 * Electron), so its unit test holds it to that.
 */

/** Settings a packaged build keeps: nothing a test or a development run is the only reason for. */
const KEPT_IN_PACKAGED = new Set(["ARIA_LOG_LEVEL", "ARIA_WHISPER_BIN", "ARIA_WHISPER_MODEL"]);

/** Removes the development switches from a packaged build's environment (so core and child processes never see them either). */
export function dropDevSwitches(packaged: boolean, env: NodeJS.ProcessEnv): void {
  if (!packaged) return;
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (upper === "ELECTRON_RENDERER_URL" || (upper.startsWith("ARIA_") && !KEPT_IN_PACKAGED.has(upper))) delete env[name];
  }
}

/** The window only ever asks for the microphone (push-to-talk): that's all it, or a page in it, gets. */
export function allowsPermission(permission: string, mediaTypes?: readonly string[]): boolean {
  return permission === "media" && mediaTypes !== undefined && mediaTypes.length > 0 && mediaTypes.every((type) => type === "audio");
}
