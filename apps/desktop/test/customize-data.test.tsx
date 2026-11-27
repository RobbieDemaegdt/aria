/** D1: Customize › Data, rendered from its state. */
import type { DataState } from "@aria/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DataPanel, parseKeepDays, sizeText } from "../src/renderer/src/components/CustomizeData";

const MB = 1024 * 1024;
const base: DataState = { retention: { enabled: true, keepDays: 30 }, fileBytes: 175 * MB, freeBytes: 0, cleaning: false, compactPending: false };
const render = (state: Partial<DataState>, { saving = false, cleaning = false } = {}) =>
  renderToStaticMarkup(
    <DataPanel state={{ ...base, ...state }} saving={saving} cleaning={cleaning} onRetention={() => Promise.resolve(true)} onCleanUp={() => undefined} />,
  );

describe("Customize › Data (D1)", () => {
  it("shows the database's size, the setting, and that there's been no clean-up yet", () => {
    const html = render({});
    expect(html).toContain('data-testid="data-file-size">175 MB<');
    expect(html).not.toContain("free space");
    expect(html).toMatch(/data-testid="data-retention-enabled" checked=""/);
    expect(html).toContain('value="30"');
    expect(html).toContain("No clean-up yet.");
    expect(html).toContain(">Clean up now<");
    expect(html).not.toContain("data-compact-pending");
    expect(html).not.toContain("data-keep-days-error");
  });

  it("says what the last clean-up did, the free space, and the compact at the next start", () => {
    const at = Date.UTC(2026, 11, 17, 12);
    const html = render({
      freeBytes: 96 * MB,
      compactPending: true,
      lastCleanup: { at, tasks: 34, steps: 16_399, freeBytes: 96 * MB },
      lastCompact: { at, beforeBytes: 175 * MB, afterBytes: 78 * MB, ms: 654 },
    });
    expect(html).toContain("of which 96 MB is free space");
    expect(html).toContain("data-compact-pending");
    expect(html).toContain("16,399 steps from 34 tasks.");
    expect(html).toContain("175 MB to 78 MB, in 0.7 s.");
  });

  it("says when nothing was old enough, a compact that failed, and while it's cleaning up", () => {
    const at = Date.UTC(2026, 11, 17, 12);
    const html = render(
      { cleaning: true, retention: { enabled: false, keepDays: 7 }, lastCleanup: { at, tasks: 0, steps: 0, freeBytes: 0 }, lastCompact: { at, beforeBytes: 1, afterBytes: 1, ms: 3, error: "disk full" } },
      { cleaning: true },
    );
    expect(html).toContain("nothing was old enough.");
    expect(html).toContain("didn&#x27;t work: disk full");
    expect(html).toContain(">Cleaning up…<");
    expect(html).toMatch(/data-testid="data-clean-up"[^>]*disabled=""/);
    expect(html).not.toMatch(/data-testid="data-retention-enabled" checked=""/);
    expect(html).toContain('value="7"');
    // Cleaning up doesn't stop you changing the setting.
    expect(html).not.toMatch(/data-testid="data-keep-days"[^>]*disabled=""/);
  });

  it("leaves Clean up now enabled while the daily clean-up runs, and disables the setting while it's saved", () => {
    const daily = render({ cleaning: true });
    expect(daily).toContain("A clean-up is running.");
    expect(daily).toContain(">Clean up now<");
    expect(daily).not.toMatch(/data-testid="data-clean-up"[^>]*disabled=""/);
    const saving = render({}, { saving: true });
    expect(saving).toMatch(/data-testid="data-keep-days"[^>]*disabled=""/);
    expect(saving).toMatch(/data-testid="data-retention-enabled"[^>]*disabled=""/);
    expect(saving).not.toMatch(/data-testid="data-clean-up"[^>]*disabled=""/);
  });

  it("reads days and sizes", () => {
    expect(parseKeepDays("30")).toBe(30);
    expect(parseKeepDays(" 7 ")).toBe(7);
    for (const bad of ["", "0", "3651", "2.5", "-1", "ten", "1e3"]) expect(parseKeepDays(bad)).toBeUndefined();
    expect(sizeText(512)).toBe("512 bytes");
    expect(sizeText(820 * 1024)).toBe("820 KB");
    expect(sizeText(175 * MB)).toBe("175 MB");
    expect(sizeText(2.5 * 1024 * MB)).toBe("2.5 GB");
  });
});
