/**
 * What the performance specs count in the window (perf-session, perf-chat): React commits and component renders,
 * through `__REACT_DEVTOOLS_GLOBAL_HOOK__`, and long tasks. Install before React loads:
 *   await page.addInitScript(installCounters, { log: true });
 *   await page.reload();
 */
import type { Page } from "@playwright/test";

/** One React commit (with `{ log: true }`). */
export interface Commit {
  /** Animation frames started before it: commits with the same number came between the same two frames. */
  frame: number;
  renders: number;
  /** Timeline items drawn (a component with an `item` prop drew it). */
  items: number;
  /** Whether it drew the reply being written (a component with `streaming: true`, the reply's Markdown). */
  streaming: boolean;
}

export interface Perf {
  commits: number;
  renders: number;
  /** The most transcript steps drawn in one commit (a component with an `entry` prop drew it). */
  mostSteps: number;
  longTasks: number;
  longMs: number;
  /** Each commit since the last reset, with `{ log: true }`. */
  log?: Commit[];
  /** Each long task since the last reset (when it started, in the page's time, and how long it took), with `{ log: true }`. */
  longs?: Array<{ at: number; ms: number }>;
}

export interface CounterOptions {
  /** Log each commit and long task, and count animation frames for the commits (a frame loop runs while the page is open). */
  log?: boolean;
}

/**
 * Runs in the page before React loads: React calls this hook on every commit. A component rendered in a commit when
 * React marked it PerformedWork (flag 1); a subtree React didn't clone (its child is still the old one) wasn't visited.
 * Serialized into the page by `addInitScript`, so it uses nothing from outside itself.
 */
export function installCounters(options?: CounterOptions): void {
  const perf: Perf = { commits: 0, renders: 0, mostSteps: 0, longTasks: 0, longMs: 0, ...(options?.log ? { log: [], longs: [] } : {}) };
  (window as unknown as { __perf: Perf }).__perf = perf;
  let frame = 0;
  if (options?.log) {
    // Registered before anything the page books for a frame, so each frame's count goes up before the page's own frame
    // callbacks run: a commit from one of them counts in that frame.
    const tick = () => {
      frame++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  // Function, class, forwardRef and simple memo components.
  const components = new Set([0, 1, 11, 15]);
  type Props = { entry?: { id?: unknown }; item?: { id?: unknown }; streaming?: unknown } | null;
  type Fiber = { tag: number; flags: number; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null; memoizedProps?: Props };
  type Seen = { renders: number; steps: Set<unknown>; items: Set<unknown>; streaming: boolean };
  const walk = (first: Fiber | null, seen: Seen) => {
    for (let fiber = first; fiber; fiber = fiber.sibling) {
      if (components.has(fiber.tag) && (fiber.flags & 1) === 1) {
        seen.renders++;
        const props = fiber.memoizedProps;
        if (props?.entry?.id !== undefined) seen.steps.add(props.entry.id);
        if (props?.item?.id !== undefined) seen.items.add(props.item.id);
        if (props?.streaming === true) seen.streaming = true;
      }
      if (fiber.child && !(fiber.alternate && fiber.child === fiber.alternate.child)) walk(fiber.child, seen);
    }
  };
  const renderers = new Map<number, unknown>();
  (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers,
    inject(renderer: unknown) {
      renderers.set(renderers.size + 1, renderer);
      return renderers.size;
    },
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      const seen: Seen = { renders: 0, steps: new Set(), items: new Set(), streaming: false };
      walk(root.current, seen);
      perf.commits++;
      perf.renders += seen.renders;
      perf.mostSteps = Math.max(perf.mostSteps, seen.steps.size);
      perf.log?.push({ frame, renders: seen.renders, items: seen.items.size, streaming: seen.streaming });
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    checkDCE() {},
  };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      perf.longTasks++;
      perf.longMs += entry.duration;
      perf.longs?.push({ at: Math.round(entry.startTime), ms: Math.round(entry.duration) });
    }
  }).observe({ type: "longtask", buffered: false });
}

export const readPerf = (page: Page): Promise<Perf> => page.evaluate(() => structuredClone((window as unknown as { __perf: Perf }).__perf));

export const resetPerf = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const perf = (window as unknown as { __perf: Perf }).__perf;
    perf.commits = 0;
    perf.renders = 0;
    perf.mostSteps = 0;
    perf.longTasks = 0;
    perf.longMs = 0;
    if (perf.log) perf.log = [];
    if (perf.longs) perf.longs = [];
  });
