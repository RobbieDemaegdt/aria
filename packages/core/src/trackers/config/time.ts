/**
 * The wire format of a time (docs/trackers.md, "The reference"): how a tracker's config writes a row's start and end
 * in a call, from the row's date and `HH:mm` and the day's time zone. The rows hold no formatted times of their own.
 *
 * - `local`: the local wall time with no offset, `YYYY-MM-DDTHH:mm:00`.
 * - `offset`: the same wall time plus the zone's offset at that moment, `YYYY-MM-DDTHH:mm:00+01:00`.
 * - `utc`: the same moment in UTC, `YYYY-MM-DDTHH:mm:00Z`.
 *
 * An end of `24:00` is the last second of the day (`T23:59:59`) in all three.
 */
import { hhmmToMinutes, minutesToHHMM, normalizeTimeZone, parseDateTimeInZone, zoneOffsetMs } from "../../timekeeper/checks.ts";

export type TimeFormat = "local" | "offset" | "utc";

/** Formats `date` (`YYYY-MM-DD`) and `hhmm` (`HH:mm`) as an offset-free ISO 8601 `YYYY-MM-DDTHH:mm:00` (`local`). */
export function toLocalDateTime(date: string, hhmm: string): string {
  const mins = hhmmToMinutes(hhmm);
  if (mins === 1440) return `${date}T23:59:59`;
  return `${date}T${minutesToHHMM(mins)}:00`;
}

/** `+01:00` or `-05:30`: an offset in milliseconds, east of UTC positive. */
function formatOffset(offsetMs: number): string {
  const total = Math.round(Math.abs(offsetMs) / 60_000);
  const hours = String(Math.floor(total / 60)).padStart(2, "0");
  const minutes = String(total % 60).padStart(2, "0");
  return `${offsetMs < 0 ? "-" : "+"}${hours}:${minutes}`;
}

/**
 * A row's time as the call writes it. `zone` is the day's time zone (an IANA name or a Windows one: `local` ignores it);
 * on a day the clocks change, the offset is the one in force at that moment, so a row before and a row after the change
 * carry different offsets.
 */
export function formatTrackerTime(format: TimeFormat, date: string, hhmm: string, zone?: string | null): string {
  const local = toLocalDateTime(date, hhmm);
  if (format === "local") return local;
  const iana = normalizeTimeZone(zone);
  const epochMs = parseDateTimeInZone(local, iana);
  if (epochMs === undefined) throw new Error(`"${date} ${hhmm}" isn't a time in ${iana}.`);
  if (format === "utc") return `${new Date(epochMs).toISOString().slice(0, 19)}Z`;
  return `${local}${formatOffset(zoneOffsetMs(epochMs, iana))}`;
}
