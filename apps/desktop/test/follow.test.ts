import { describe, expect, it } from "vitest";
import { createFollow, PROGRAMMATIC_SCROLL_MS } from "../src/renderer/src/follow";

describe("keeping the chat at its newest message", () => {
  it("follows while you're at the bottom, and stops when you scroll up", () => {
    const follow = createFollow(() => 0);
    expect(follow.stick).toBe(true);
    follow.scrolled(200);
    expect(follow.stick).toBe(false);
    follow.scrolled(10);
    expect(follow.stick).toBe(true);
  });

  it("isn't turned back on by the first scroll events of a scroll to a card, which come near the bottom (round 2)", () => {
    let now = 1_000;
    const follow = createFollow(() => now);
    follow.scrollingTo();
    // The smooth scroll starts from the bottom: its first events are still near it.
    follow.scrolled(0);
    follow.scrolled(20);
    expect(follow.stick).toBe(false);
    // It ended; the card is in view. A message arriving now mustn't jump away from it, until you scroll yourself.
    follow.ended();
    expect(follow.stick).toBe(false);
    follow.scrolled(5);
    expect(follow.stick).toBe(true);

    // Without a scrollend, your scrolling counts again after a moment.
    follow.scrollingTo();
    now += PROGRAMMATIC_SCROLL_MS - 1;
    follow.scrolled(0);
    expect(follow.stick).toBe(false);
    now += 1;
    follow.scrolled(0);
    expect(follow.stick).toBe(true);
  });

  it("re-enables following the newest message when followBottom is called", () => {
    const follow = createFollow(() => 1_000);
    follow.scrollingTo();
    expect(follow.stick).toBe(false);
    follow.followBottom();
    expect(follow.stick).toBe(true);
    follow.scrolled(300);
    expect(follow.stick).toBe(false);
    follow.followBottom();
    expect(follow.stick).toBe(true);
  });
});
