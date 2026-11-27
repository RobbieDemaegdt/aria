/**
 * Whether you're at ARIA (PLAN.md §4.5, D25): the window in front and focused, the screen unlocked, the PC awake, and
 * some input in the last 5 minutes. No Electron import: main hands it the window and `powerMonitor` as event emitters
 * and their state as getters, so it's unit-tested with stand-ins, and the E2E hooks replace the getters (Playwright
 * can't count on Windows giving a window the focus).
 */
export interface WindowState {
  exists: boolean;
  visible: boolean;
  minimized: boolean;
  focused: boolean;
}

/** `powerMonitor.getSystemIdleState(IDLE_AWAY_SECONDS)`, and the seconds since your last input when it's idle. */
export interface IdleState {
  state: "active" | "idle" | "locked" | "unknown";
  seconds: number;
}

interface Emitter {
  on(event: string, listener: () => void): unknown;
}

/** No input for this long while ARIA is in front counts as away (reading a long diff shouldn't start toasts). */
export const IDLE_AWAY_SECONDS = 300;
/** How often idleness and the lock are checked. */
const POLL_MS = 10_000;
/** The first report waits for the window's first focus, at most this long (a window that starts hidden). */
const FIRST_REPORT_MS = 5_000;

export interface PresenceDeps {
  window(): WindowState;
  idle(): IdleState;
  /**
   * `since`: when it changed (going idle started earlier than now). `locked`: away because the screen is locked, when
   * Windows drops any toast (the engine holds them until the unlock).
   */
  report(present: boolean, since: number, locked: boolean): void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export class PresenceController {
  private locked = false;
  private suspended = false;
  private idleSince: number | undefined;
  private reported: boolean | undefined;
  private reportedLocked = false;
  /** Reports wait until the window first came to the front (or the first-report delay passed): before that, the
   * engine keeps what comes in (the interrupted card at startup) for when it knows. */
  private reporting = false;
  private firstTimer: unknown;
  private pollTimer: unknown;
  private stopped = false;

  constructor(private readonly deps: PresenceDeps) {}

  attachWindow(window: Emitter): void {
    window.on("focus", () => {
      // You're plainly back: whatever a missed unlock or resume event left behind is over.
      this.locked = false;
      this.suspended = false;
      this.idleSince = undefined;
      this.reporting = true;
      this.recompute();
    });
    for (const event of ["blur", "minimize", "restore", "show", "hide"]) window.on(event, () => this.recompute());
  }

  attachPower(power: Emitter): void {
    const on = (event: string, change: () => void) =>
      power.on(event, () => {
        change();
        this.recompute();
      });
    on("lock-screen", () => (this.locked = true));
    on("unlock-screen", () => (this.locked = false));
    on("suspend", () => (this.suspended = true));
    on("resume", () => (this.suspended = false));
  }

  start(): void {
    this.firstTimer = this.deps.setTimer(() => {
      this.reporting = true;
      this.recompute();
    }, FIRST_REPORT_MS);
    this.schedulePoll();
  }

  stop(): void {
    this.stopped = true;
    this.deps.clearTimer(this.firstTimer);
    this.deps.clearTimer(this.pollTimer);
  }

  private schedulePoll(): void {
    this.pollTimer = this.deps.setTimer(() => {
      if (this.stopped) return;
      this.poll();
      this.schedulePoll();
    }, POLL_MS);
  }

  /** Idleness and the lock, from the system (a timer that runs means the PC is awake). */
  poll(): void {
    const idle = this.deps.idle();
    this.suspended = false;
    if (idle.state === "locked") this.locked = true;
    else if (idle.state !== "unknown") this.locked = false;
    if (idle.state === "idle") this.idleSince ??= this.deps.now() - idle.seconds * 1000;
    else if (idle.state !== "unknown") this.idleSince = undefined;
    this.recompute();
  }

  present(): boolean {
    const window = this.deps.window();
    return window.exists && window.visible && !window.minimized && window.focused && !this.locked && !this.suspended && this.idleSince === undefined;
  }

  recompute(): void {
    if (!this.reporting || this.stopped) return;
    const present = this.present();
    // A lock while you were already away is reported too: toasts wait for the unlock from then on.
    const locked = !present && this.locked;
    if (present === this.reported && locked === this.reportedLocked) return;
    this.reported = present;
    this.reportedLocked = locked;
    const now = this.deps.now();
    this.deps.report(present, present ? now : Math.min(now, this.idleSince ?? now), locked);
  }
}
