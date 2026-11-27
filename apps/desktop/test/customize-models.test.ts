/** Customize › Models: the Timekeeper's box of other commit authors that count as yours. */
import { SetTimekeeperSettingsInput } from "@aria/protocol";
import { describe, expect, it } from "vitest";
import { authorLines, authorLinesOk } from "../src/renderer/src/components/CustomizeModels";

describe("the Timekeeper's other commit authors", () => {
  it("reads one name or email per line, trimmed, without blank lines", () => {
    expect(authorLines("")).toEqual([]);
    expect(authorLines("  Sam R.  \r\n\r\nbot@ci.example\n   \n")).toEqual(["Sam R.", "bot@ci.example"]);
    expect(authorLines("Rivera, Sam")).toEqual(["Rivera, Sam"]);
  });

  it("allows what the engine accepts: at most 50 lines of at most 200 characters", () => {
    expect(authorLinesOk(Array.from({ length: 50 }, (_, i) => `a${i}`))).toBe(true);
    expect(authorLinesOk(Array.from({ length: 51 }, (_, i) => `a${i}`))).toBe(false);
    expect(authorLinesOk(["x".repeat(200)])).toBe(true);
    expect(authorLinesOk(["x".repeat(201)])).toBe(false);
    const accepted = authorLines(Array.from({ length: 50 }, (_, i) => `a${i}`).join("\n"));
    expect(SetTimekeeperSettingsInput.safeParse({ ownAuthors: accepted }).success).toBe(true);
    expect(SetTimekeeperSettingsInput.safeParse({ ownAuthors: authorLines("x".repeat(201)) }).success).toBe(false);
  });
});
