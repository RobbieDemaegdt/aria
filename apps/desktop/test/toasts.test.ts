import { describe, expect, it } from "vitest";
import { ToastShower, TOASTS_KEPT, type ShownToast, type ToastEvent } from "../src/main/toasts";

/** Stands in for Electron's Notification: the test fires its events. */
class FakeToast implements ShownToast {
  readonly listeners = new Map<string, (...args: never[]) => void>();
  shown = false;
  closed = 0;
  constructor(readonly options: { title: string; body: string; silent: boolean }) {}
  on(event: string, listener: (...args: never[]) => void): this {
    this.listeners.set(event, listener);
    return this;
  }
  show(): void {
    this.shown = true;
  }
  close(): void {
    this.closed++;
  }
  fire(event: "click" | "close" | "failed", ...args: unknown[]): void {
    (this.listeners.get(event) as (...a: unknown[]) => void)(...args);
  }
}

function setup(supported = true) {
  const made: FakeToast[] = [];
  const clicks: string[] = [];
  const logs: string[] = [];
  const shower = new ToastShower({
    create: (options) => {
      if (!supported) return undefined;
      const toast = new FakeToast(options);
      made.push(toast);
      return toast;
    },
    onClick: (event) => clicks.push(event.id),
    log: (text) => logs.push(text),
  });
  return { shower, made, clicks, logs };
}

const toast = (id: string, extra: Partial<ToastEvent> = {}): ToastEvent => ({ type: "toast", id, priority: "milestone", title: `${id} is done`, body: "No commits", silent: true, ...extra });

describe("showing toasts (PLAN.md §4.7, D24)", () => {
  it("keeps a toast that timed out, so the combined one still takes its place in the Action Center", () => {
    const { shower, made } = setup();
    shower.show(toast("a"));
    expect(made[0]!.shown).toBe(true);
    // Windows takes it off the screen after a few seconds: it stays in the Action Center.
    made[0]!.fire("close", { reason: "timedOut" });
    shower.show(toast("both", { title: "2 tasks finished", replaces: "a" }));
    expect(made[0]!.closed).toBe(1);
    expect(made[1]!.options).toEqual({ title: "2 tasks finished", body: "No commits", silent: true });
    expect(shower.kept).toEqual(["both"]);
  });

  it("forgets a toast you closed, clicked, or that failed, and logs a failure once", () => {
    const { shower, made, clicks, logs } = setup();
    shower.show(toast("closed"));
    made[0]!.fire("close", { reason: "userCanceled" });
    shower.show(toast("clicked"));
    made[1]!.fire("click");
    shower.show(toast("failed"));
    made[2]!.fire("failed", {}, "no app id");
    shower.show(toast("failed again"));
    made[3]!.fire("failed", {}, "no app id");
    expect(shower.kept).toEqual([]);
    expect(clicks).toEqual(["clicked"]);
    expect(logs).toEqual(["ARIA couldn't show a toast: no app id"]);
    // Nothing left to close for a toast that replaces a forgotten one.
    shower.show(toast("later", { replaces: "closed" }));
    expect(made[0]!.closed).toBe(0);
  });

  it("keeps at most the newest 50, and shows nothing where toasts aren't supported", () => {
    const { shower } = setup();
    for (let i = 0; i < TOASTS_KEPT + 5; i++) shower.show(toast(`t${i}`));
    expect(shower.kept).toHaveLength(TOASTS_KEPT);
    expect(shower.kept[0]).toBe("t5");
    const none = setup(false);
    none.shower.show(toast("a"));
    expect(none.shower.kept).toEqual([]);
  });
});
