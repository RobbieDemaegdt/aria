import { describe, expect, it } from "vitest";
import { sanitizeSessionName } from "../src/util/session-name.ts";

describe("sanitizeSessionName", () => {
  it("returns fallback for empty, whitespace-only, or undefined inputs", () => {
    expect(sanitizeSessionName(undefined)).toBe("ARIA");
    expect(sanitizeSessionName("")).toBe("ARIA");
    expect(sanitizeSessionName("   \t\n  ")).toBe("ARIA");
    expect(sanitizeSessionName("", "CustomFallback")).toBe("CustomFallback");
  });

  it("replaces double quotes with single quotes", () => {
    expect(sanitizeSessionName('ARIA · "Fix bug"')).toBe("ARIA · 'Fix bug'");
    expect(sanitizeSessionName('Why does the DepencyResolver.cs does again have the "framework-orhcestrator" being mentioned')).toBe(
      "Why does the DepencyResolver.cs does again have the 'framework-orhcestrator' being mentioned",
    );
    expect(sanitizeSessionName('"""')).toBe("'''");
  });

  it("removes control characters and collapses whitespace", () => {
    expect(sanitizeSessionName("ARIA · Task\n\rwith\ttabs\x00and\x1Fcontrols")).toBe(
      "ARIA · Task with tabs and controls",
    );
  });

  it("trims leading and trailing whitespace", () => {
    expect(sanitizeSessionName("  ARIA · Task  ")).toBe("ARIA · Task");
  });

  it("caps length at 100 UTF-16 units and trims trailing whitespace", () => {
    // Whatever the prefix is: the result is the prefix and as many letters as fit in 100 units (this used to hard-code the count).
    const prefix = "ARIA · ";
    const long = prefix + "a".repeat(120);
    const sanitized = sanitizeSessionName(long);
    expect(sanitized.length).toBe(100);
    expect(sanitized).toBe(prefix + "a".repeat(100 - prefix.length));
  });

  it("guards against cutting surrogate pairs at boundary", () => {
    // 99 chars + 2-char emoji = 101 UTF-16 units. The emoji shouldn't be split in half.
    const name = "a".repeat(99) + "🚀";
    const sanitized = sanitizeSessionName(name);
    expect(sanitized.length).toBe(99);
    expect(sanitized).toBe("a".repeat(99));
  });

  it("never contains double quotes", () => {
    const result = sanitizeSessionName('He said: "Hello", then "World"');
    expect(result).not.toContain('"');
    expect(result).toBe("He said: 'Hello', then 'World'");
  });
});
