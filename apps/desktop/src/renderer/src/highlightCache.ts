/**
 * Highlighted HTML for code blocks, by theme, language and code, so a block that is drawn again starts highlighted.
 * The reply being written and the final message are different elements: without this, a streamed reply's blocks were
 * drawn plain again when it turned final, and highlighted again 120 ms later. Oldest out first, past 2 million
 * characters of keys and HTML (about 4 MB). It imports nothing from Shiki: `Markdown` reads it on every draw, and
 * Shiki stays out of the first load.
 */
const MAX_CHARS = 2_000_000;
const entries = new Map<string, string>();
let chars = 0;

const keyOf = (theme: string, lang: string, code: string) => `${theme}\u0000${lang}\u0000${code}`;

export function cachedHighlight(theme: string, lang: string, code: string): string | undefined {
  return entries.get(keyOf(theme, lang, code));
}

export function rememberHighlight(theme: string, lang: string, code: string, html: string): void {
  const key = keyOf(theme, lang, code);
  // One block bigger than all of it would push out everything else, then itself.
  if (key.length + html.length > MAX_CHARS) return;
  const old = entries.get(key);
  if (old !== undefined) {
    entries.delete(key);
    chars -= key.length + old.length;
  }
  entries.set(key, html);
  chars += key.length + html.length;
  for (const [oldestKey, oldestHtml] of entries) {
    if (chars <= MAX_CHARS) break;
    entries.delete(oldestKey);
    chars -= oldestKey.length + oldestHtml.length;
  }
}
