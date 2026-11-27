/**
 * The wire format of a time (docs/trackers.md, "The reference"): `local`, `offset` and `utc`, from a row's date and
 * `HH:mm` and the day's zone, with 24:00 as the last second of the day and the clocks changing in the middle of a day.
 */
import { describe, expect, it } from "vitest";
import { formatTrackerTime, toLocalDateTime } from "../src/trackers/config/time.ts";

describe("toLocalDateTime", () => {
  it("is the wall time with no offset, and 24:00 as the last second of the day", () => {
    expect(toLocalDateTime("2026-10-23", "09:15")).toBe("2026-10-23T09:15:00");
    expect(toLocalDateTime("2026-10-23", "00:00")).toBe("2026-10-23T00:00:00");
    expect(toLocalDateTime("2026-10-23", "24:00")).toBe("2026-10-23T23:59:59");
  });

  it("refuses a time that isn't HH:mm", () => {
    expect(() => toLocalDateTime("2026-10-23", "9")).toThrow('Invalid HH:mm time: "9".');
    expect(() => toLocalDateTime("2026-10-23", "25:00")).toThrow("Invalid HH:mm time");
  });
});

describe("formatTrackerTime", () => {
  it("writes `local` the same in every zone", () => {
    for (const zone of ["Europe/Brussels", "Asia/Tokyo", "America/Los_Angeles", "UTC", undefined]) {
      expect(formatTrackerTime("local", "2026-10-23", "09:00", zone)).toBe("2026-10-23T09:00:00");
    }
  });

  it("writes `offset` as the wall time and the zone's offset, half hours included", () => {
    expect(formatTrackerTime("offset", "2026-10-23", "09:00", "Europe/Brussels")).toBe("2026-10-23T09:00:00+02:00");
    expect(formatTrackerTime("offset", "2026-12-04", "09:00", "Europe/Brussels")).toBe("2026-12-04T09:00:00+01:00");
    expect(formatTrackerTime("offset", "2026-10-23", "09:00", "UTC")).toBe("2026-10-23T09:00:00+00:00");
    expect(formatTrackerTime("offset", "2026-10-23", "09:00", "Asia/Kolkata")).toBe("2026-10-23T09:00:00+05:30");
    expect(formatTrackerTime("offset", "2026-10-23", "09:00", "America/New_York")).toBe("2026-10-23T09:00:00-04:00");
    expect(formatTrackerTime("offset", "2026-10-23", "09:00", "America/St_Johns")).toBe("2026-10-23T09:00:00-02:30");
  });

  it("writes `utc` as the same moment in UTC, with no milliseconds", () => {
    expect(formatTrackerTime("utc", "2026-10-23", "09:00", "Europe/Brussels")).toBe("2026-10-23T07:00:00Z");
    expect(formatTrackerTime("utc", "2026-12-04", "09:00", "Europe/Brussels")).toBe("2026-12-04T08:00:00Z");
    expect(formatTrackerTime("utc", "2026-10-23", "09:00", "Asia/Kolkata")).toBe("2026-10-23T03:30:00Z");
    expect(formatTrackerTime("utc", "2026-10-23", "01:00", "Asia/Tokyo")).toBe("2026-10-22T16:00:00Z");
    expect(formatTrackerTime("utc", "2026-10-23", "09:00", "UTC")).toBe("2026-10-23T09:00:00Z");
  });

  it("writes 24:00 as the last second of the day in each format", () => {
    expect(formatTrackerTime("local", "2026-10-23", "24:00", "Europe/Brussels")).toBe("2026-10-23T23:59:59");
    expect(formatTrackerTime("offset", "2026-10-23", "24:00", "Europe/Brussels")).toBe("2026-10-23T23:59:59+02:00");
    expect(formatTrackerTime("utc", "2026-10-23", "24:00", "Europe/Brussels")).toBe("2026-10-23T21:59:59Z");
  });

  it("takes the offset in force at that moment on the day the clocks change", () => {
    // Brussels, 29 March 2026: 02:00 became 03:00.
    expect(formatTrackerTime("offset", "2026-03-29", "01:00", "Europe/Brussels")).toBe("2026-03-29T01:00:00+01:00");
    expect(formatTrackerTime("offset", "2026-03-29", "04:00", "Europe/Brussels")).toBe("2026-03-29T04:00:00+02:00");
    expect(formatTrackerTime("utc", "2026-03-29", "04:00", "Europe/Brussels")).toBe("2026-03-29T02:00:00Z");
    // Brussels, 25 October 2026: 03:00 became 02:00, so the day is 25 hours long.
    expect(formatTrackerTime("offset", "2026-10-25", "01:00", "Europe/Brussels")).toBe("2026-10-25T01:00:00+02:00");
    expect(formatTrackerTime("offset", "2026-10-25", "09:00", "Europe/Brussels")).toBe("2026-10-25T09:00:00+01:00");
    expect(formatTrackerTime("offset", "2026-10-25", "24:00", "Europe/Brussels")).toBe("2026-10-25T23:59:59+01:00");
    expect(formatTrackerTime("utc", "2026-10-25", "09:00", "Europe/Brussels")).toBe("2026-10-25T08:00:00Z");
  });

  it("takes a Windows zone name as Outlook gives it, and this computer's zone when there is none", () => {
    expect(formatTrackerTime("offset", "2026-10-23", "09:00", "Romance Standard Time")).toBe("2026-10-23T09:00:00+02:00");
    expect(formatTrackerTime("offset", "2026-10-23", "09:00", "Pacific Standard Time")).toBe("2026-10-23T09:00:00-07:00");
    expect(formatTrackerTime("offset", "2026-10-23", "09:00")).toMatch(/^2026-10-23T09:00:00[+-]\d{2}:\d{2}$/);
  });

  it("refuses a time that isn't HH:mm", () => {
    expect(() => formatTrackerTime("offset", "2026-10-23", "9am", "Europe/Brussels")).toThrow("Invalid HH:mm time");
  });
});
