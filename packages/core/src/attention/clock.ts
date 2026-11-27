/**
 * Time for the attention module (PLAN.md §4.5): the real clock, or a manual one for tests, so the 30 s coalescing window
 * and the 15-minute away threshold are tested without waiting (and without fake timers that would also stop the task
 * manager's own).
 */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** A clock that only moves when told to. `advance` runs the timers that come due, in order. */
export class ManualClock implements Clock {
  private time: number;
  private timers: Array<{ id: number; at: number; fn: () => void }> = [];
  private nextId = 0;

  constructor(start = Date.now()) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.nextId;
    this.timers.push({ id, at: this.time + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  /** Moves `now` only, without running the timers that came due: what a sleep of the PC does to relative timers. */
  jump(ms: number): void {
    this.time += ms;
  }

  advance(ms: number): void {
    const until = this.time + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = Math.max(this.time, due.at);
      due.fn();
    }
    this.time = until;
  }
}
