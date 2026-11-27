import { describe, expect, it } from "vitest";
import { accessText, canRetry, inboxLine } from "../src/renderer/src/github";

describe("GitHub access in Customize › Notifications", () => {
  it("the inbox says why it waits whenever it does (not its last good count), and offers its own Try again", () => {
    const why = "GitHub CLI's token can't read your notifications (it needs the notifications or repo scope: `gh auth refresh -s notifications`).";
    expect(inboxLine({ status: "12 unread · 1 review request", paused: why }, true)).toEqual({ text: why, problem: true });
    expect(inboxLine({ status: "12 unread · 1 review request", error: "GitHub had a problem (502)." }, true)).toEqual({ text: "GitHub had a problem (502).", problem: true });
    expect(inboxLine({ status: "12 unread · 1 review request" }, true)).toEqual({ text: "12 unread · 1 review request.", problem: false });
    expect(inboxLine(undefined, true)).toBeUndefined();
  });

  it("while GitHub access isn't fine (a rate limit), the inbox's wait is the access's: no Try again of its own", () => {
    const access = "GitHub's rate limit is used up: ARIA waits until it resets.";
    expect(inboxLine({ status: "12 unread", paused: access }, false)).toEqual({ text: "12 unread.", problem: false });
    expect(canRetry("rate_limited")).toBe(false);
  });

  it("GitHub not confirming the token (a 5xx, a proxy's page) says why and when it tries again, with Try again", () => {
    const pausedUntil = new Date(2026, 9, 20, 10, 42).getTime();
    const text = accessText({ status: "unavailable", message: "ARIA couldn't check GitHub CLI's sign-in with GitHub: GitHub had a problem (500).", pausedUntil, inbox: true });
    expect(text).toMatch(/couldn't check GitHub CLI's sign-in with GitHub: GitHub had a problem \(500\)\./);
    expect(text).toMatch(/tries again at 10:42/);
    expect(canRetry("unavailable")).toBe(true);
  });

  it("Try again only where it can help (not while starting, working, or waiting for GitHub's reset)", () => {
    expect(["no_cli", "signed_out", "token_refused", "offline", "unavailable"].every((s) => canRetry(s as never))).toBe(true);
    expect(["off", "starting", "ok", "rate_limited"].some((s) => canRetry(s as never))).toBe(false);
  });
});
