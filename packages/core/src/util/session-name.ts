/**
 * Sanitizes a session name for Copilot CLI session creation:
 * - non-empty (falls back to fallback name)
 * - no leading or trailing whitespace
 * - at most 100 UTF-16 units
 * - no control characters (replaced with spaces)
 * - no double quotes (replaced with single quotes)
 */
export function sanitizeSessionName(name: string | undefined, fallback = "ARIA"): string {
  if (!name) return fallback;
  const cleaned = name
    .replace(/"/g, "'")
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return fallback;
  let sliced = cleaned.length > 100 ? cleaned.slice(0, 100) : cleaned;
  if (sliced.length > 0) {
    const code = sliced.charCodeAt(sliced.length - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      sliced = sliced.slice(0, -1);
    }
  }
  sliced = sliced.trimEnd();
  return sliced || fallback;
}
