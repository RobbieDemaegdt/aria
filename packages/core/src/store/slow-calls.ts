import { Store } from "./store.ts";

/** A store call that takes longer than a frame at 60 Hz holds up the window: the engine runs on its main process (P5). */
export const SLOW_STORE_CALL_MS = 16;

/**
 * Times every call of `store`'s methods and reports each one that takes longer than `ms`. A call made from inside
 * another store call is part of that one, so it isn't reported apart. A report that throws changes nothing.
 */
export function reportSlowCalls(store: Store, report: (call: string, ms: number) => void, ms = SLOW_STORE_CALL_MS): void {
  let depth = 0;
  const methods = Store.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of Object.getOwnPropertyNames(Store.prototype)) {
    if (name === "constructor" || typeof Object.getOwnPropertyDescriptor(Store.prototype, name)?.value !== "function") continue;
    Object.defineProperty(store, name, {
      configurable: true,
      writable: true,
      value(this: Store, ...args: unknown[]): unknown {
        depth++;
        const started = performance.now();
        try {
          // Looked up at each call, so a spy put on `Store.prototype` later still sees it.
          return methods[name]!.apply(this, args);
        } finally {
          depth--;
          const took = performance.now() - started;
          if (depth === 0 && took > ms) {
            try {
              report(name, took);
            } catch {
              // Only a measurement: the call's own result stands.
            }
          }
        }
      },
    });
  }
}
