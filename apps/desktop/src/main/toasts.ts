/**
 * Shows the toasts the engine decided on (PLAN.md §4.7, D24, D25), and keeps them by id so a combined Done toast can
 * take the place of the first one. No Electron import: main gives it a factory for `Notification`s, so it's unit-tested
 * with stand-ins.
 */
import type { EngineEvent } from "@aria/protocol";

export type ToastEvent = Extract<EngineEvent, { type: "toast" }>;

/** The part of Electron's `Notification` this uses. */
export interface ShownToast {
  on(event: "click", listener: () => void): unknown;
  on(event: "close", listener: (details: { reason?: string }) => void): unknown;
  on(event: "failed", listener: (event: unknown, error: string) => void): unknown;
  show(): void;
  close(): void;
}

/** Toasts kept by id (the ones in the Action Center too); the oldest go first beyond this. */
export const TOASTS_KEPT = 50;

export class ToastShower {
  private readonly shown = new Map<string, ShownToast>();
  private failureLogged = false;

  constructor(
    private readonly deps: {
      /** A new notification, or undefined when this system can't show any. */
      create(options: { title: string; body: string; silent: boolean }): ShownToast | undefined;
      onClick(event: ToastEvent): void;
      log(text: string): void;
    },
  ) {}

  show(event: ToastEvent): void {
    if (event.replaces) {
      const earlier = this.shown.get(event.replaces);
      this.shown.delete(event.replaces);
      // Also when it timed out and sits in the Action Center: close() takes it out of there.
      earlier?.close();
    }
    const toast = this.deps.create({ title: event.title, body: event.body.slice(0, 250), silent: event.silent });
    if (!toast) return;
    const forget = () => {
      if (this.shown.get(event.id) === toast) this.shown.delete(event.id);
    };
    toast.on("click", () => {
      forget();
      this.deps.onClick(event);
    });
    // A toast that timed out is still in the Action Center: it's kept, so a combined one can take its place there.
    toast.on("close", (details) => {
      if (details?.reason !== "timedOut") forget();
    });
    toast.on("failed", (_event, error) => {
      forget();
      // On Windows an unpackaged app may need a Start Menu shortcut with its app id for toasts (PLAN.md §10 Phase 2).
      if (!this.failureLogged) this.deps.log(`ARIA couldn't show a toast: ${error}`);
      this.failureLogged = true;
    });
    this.shown.set(event.id, toast);
    for (const id of this.shown.keys()) {
      if (this.shown.size <= TOASTS_KEPT) break;
      this.shown.delete(id);
    }
    toast.show();
  }

  /** Toasts it still keeps (for tests). */
  get kept(): string[] {
    return [...this.shown.keys()];
  }
}
