/**
 * The start-at-login entry and the quick prompt's hotkey follow the settings, which are looked at on every task event
 * but rarely change. Setting them writes to the registry or asks the OS for a hotkey another app may hold, so only a
 * change does that, and a hotkey that's taken is tried again now and then. Pure (no Electron), so its unit test holds it
 * to that.
 */

/** How long a hotkey that's taken is left before trying again. */
export const HOTKEY_RETRY_MS = 60_000;

export type ShellSettings = {
  startAtLogin: boolean;
  loginItemArgs: readonly string[];
  hotkey: boolean;
};

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class ShellSync {
  private loginItem: string | undefined;
  private hotkeyHeld = false;
  private nextHotkeyTry = 0;

  constructor(
    private readonly deps: {
      setLoginItem(openAtLogin: boolean, args: readonly string[]): void;
      /** False when another app holds it. */
      registerHotkey(): boolean;
      unregisterHotkey(): void;
      now(): number;
      /** The app runs on without it, but you asked for it: the log says why it isn't there. */
      warn(message: string): void;
    },
  ) {}

  apply(settings: ShellSettings): void {
    const loginItem = JSON.stringify([settings.startAtLogin, settings.loginItemArgs]);
    if (loginItem !== this.loginItem) {
      this.loginItem = loginItem;
      try {
        this.deps.setLoginItem(settings.startAtLogin, settings.loginItemArgs);
      } catch (error) {
        // Tried again only when the settings change.
        this.deps.warn(`Couldn't set ARIA to start at login: ${reason(error)}`);
      }
    }
    try {
      if (settings.hotkey) this.holdHotkey();
      else this.releaseHotkey();
    } catch (error) {
      this.deps.warn(`Couldn't set the quick prompt's hotkey: ${reason(error)}`);
    }
  }

  private holdHotkey(): void {
    const now = this.deps.now();
    if (this.hotkeyHeld || now < this.nextHotkeyTry) return;
    this.nextHotkeyTry = now + HOTKEY_RETRY_MS;
    this.hotkeyHeld = this.deps.registerHotkey();
  }

  private releaseHotkey(): void {
    // Turning it on again tries at once.
    this.nextHotkeyTry = 0;
    if (!this.hotkeyHeld) return;
    this.hotkeyHeld = false;
    this.deps.unregisterHotkey();
  }
}
