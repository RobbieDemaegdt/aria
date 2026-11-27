function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]{1,6});/gi, (_m, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : " ";
    })
    .replace(/&#(\d{1,7});/g, (_m, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : " ";
    })
    .replace(/&amp;/gi, "&");
}


/**
 * Sanitizes untrusted text (a task tracker's or a mail's) into a single plain-text line:
 * 1. Decodes HTML entities BEFORE stripping HTML tags so entity-encoded markup (e.g. `&lt;script&gt;`) is also stripped.
 * 2. Replaces block/line-break HTML tags with spaces and strips all remaining `<[^>]+>` tags.
 * 3. Strips format/disguise characters (`\u202A–\u202E`, `\u2066–\u2069`, `\u200B–\u200F`, `\uFEFF`, `\uFFFD`, etc.)
 *    without leaving `\uFFFD` visual artifacts, and converts control/line-separator characters to spaces.
 * 4. Collapses whitespace and truncates to `maxLen`.
 */
export function cleanUntrustedText(raw: unknown, maxLen = 200): string {
  if (raw === undefined || raw === null) return "";
  let text: string;
  if (typeof raw === "string") text = raw;
  else if ((typeof raw === "number" && Number.isFinite(raw)) || typeof raw === "boolean") text = String(raw);
  else return "";

  const decoded = decodeHtmlEntities(text);
  const withoutTags = decoded
    .replace(/<\s*\/?\s*(?:br|p|div|li|ul|ol|tr|td|th|h[1-6]|blockquote|pre)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const cleaned = withoutTags
    .replace(/[\p{Cf}\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB\uFFFD]/gu, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length <= maxLen) return cleaned;
  return maxLen <= 1 ? cleaned.slice(0, maxLen) : `${cleaned.slice(0, maxLen - 1).trimEnd()}…`;
}

