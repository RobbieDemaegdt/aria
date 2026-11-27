/**
 * Whether the chat keeps to its newest message (it does while you're at the bottom). A scroll ARIA starts itself (a
 * toast or a chip brought a card into view) turns that off until you scroll yourself: the scroll events of ARIA's own
 * scroll don't count until it has ended, since its first ones come while the view is still near the bottom and would
 * turn it back on, and the next message would then jump away from the card.
 */
export const NEAR_BOTTOM_PX = 48;
/** How long a scroll ARIA starts may take before scroll events count again (when `scrollend` doesn't come). */
export const PROGRAMMATIC_SCROLL_MS = 1000;

export interface Follow {
  /** Whether new messages scroll the chat to the bottom. */
  readonly stick: boolean;
  /** ARIA starts a scroll of its own (to a card). */
  scrollingTo(): void;
  /** Re-enables following the newest message (e.g. when sending a message or clicking Jump to bottom). */
  followBottom(): void;
  /** A scroll event, with how far the view is from the bottom. */
  scrolled(fromBottom: number): void;
  /** A scroll ended (`scrollend`): from now on scroll events are yours again. */
  ended(): void;
}

export function createFollow(now: () => number = () => Date.now()): Follow {
  let stick = true;
  let until = 0;
  return {
    get stick() {
      return stick;
    },
    scrollingTo() {
      stick = false;
      until = now() + PROGRAMMATIC_SCROLL_MS;
    },
    followBottom() {
      stick = true;
      until = 0;
    },
    scrolled(fromBottom) {
      if (now() < until) return;
      stick = fromBottom < NEAR_BOTTOM_PX;
    },
    ended() {
      until = 0;
    },
  };
}
