import type { TranscriptEntry } from "@aria/protocol";

export type PreviewKind = "markdown" | "html";

const MARKDOWN_EXT = /\.(?:md|markdown|mdx)$/i;
const HTML_EXT = /\.(?:html|htm)$/i;

/** Whether a path is a Markdown or HTML file that ARIA can render as a rich preview. */
export function previewKind(filePath?: string): PreviewKind | undefined {
  if (!filePath) return undefined;
  const clean = filePath.trim().replace(/['"`]+$/g, "");
  if (MARKDOWN_EXT.test(clean)) return "markdown";
  if (HTML_EXT.test(clean)) return "html";
  return undefined;
}

export interface FrontmatterField {
  key: string;
  value: string;
}

/**
 * Splits optional YAML frontmatter (`---\nkey: value\n---\n`) from the top of a Markdown file so the closing `---`
 * isn't parsed as a setext heading and metadata can be shown cleanly above the document.
 */
export function splitFrontmatter(markdown: string): { frontmatter: FrontmatterField[]; body: string } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) return { frontmatter: [], body: markdown };
  const rawBlock = match[1]!;
  const lines = rawBlock.split("\n").filter((line) => line.trim() && !line.trim().startsWith("#"));
  const fields: FrontmatterField[] = [];
  for (const line of lines) {
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) return { frontmatter: [], body: markdown };
    const value = kv[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
    fields.push({ key: kv[1]!, value });
  }
  if (fields.length === 0) return { frontmatter: [], body: markdown };
  return { frontmatter: fields, body: normalized.slice(match[0].length) };
}

const DEFAULT_HTML_STYLES = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:;"><style data-aria-preview-defaults>
:root { color-scheme: dark light; }
html, body {
  margin: 0;
  padding: 16px;
  background: #0d1117;
  color: #e6edf3;
  font-family: "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, sans-serif;
  font-size: 14px;
  line-height: 1.55;
}
a { color: #2f81f7; }
table { border-collapse: collapse; }
th, td { border: 1px solid #30363d; padding: 6px 10px; text-align: left; }
th { background: #161b22; }
pre, code { font-family: "Cascadia Code", Consolas, monospace; }
pre { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 10px 12px; overflow-x: auto; }
blockquote { border-left: 3px solid #30363d; margin: 0.6em 0; padding-left: 0.8em; color: #8b949e; }
hr { border: none; border-top: 1px solid #30363d; margin: 1em 0; }
</style>`;

/**
 * Prepares HTML for a sandboxed `<iframe sandbox="" srcDoc={...}>` preview:
 * - Strips `<script>` (including unclosed `<script>`), `<base>`, `<meta http-equiv="refresh">`, inline `on*` event attributes, and `javascript:`/`vbscript:`/`data:text/html` URLs.
 * - Injects a strict CSP (`default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:;`) and sensible default styles at the start of `<head>` so fragments look native in ARIA while any styles in the HTML file itself override them.
 */
export function buildHtmlSrcDoc(rawHtml: string): string {
  const cleaned = rawHtml
    .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, "")
    .replace(/<script\b[^>]*\/?>/gi, "")
    .replace(/<base\b[^>]*\/?>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*(?:"\s*(?:refresh|content-security-policy)\s*"|'\s*(?:refresh|content-security-policy)\s*'|(?:refresh|content-security-policy)\b)[^>]*\/?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(\b(?:href|src|action|formaction)\s*=\s*)(["'])\s*(?:javascript:|vbscript:|data:\s*text\/html)[^"']*\2/gi, "$1$2#$2")
    .replace(/(\b(?:href|src|action|formaction)\s*=\s*)(?:javascript:|vbscript:|data:\s*text\/html)[^\s>]*/gi, '$1"#"');

  if (/<head\b[^>]*>/i.test(cleaned)) {
    return cleaned.replace(/<head\b[^>]*>/i, (tag) => `${tag}${DEFAULT_HTML_STYLES}`);
  }
  if (/<html\b[^>]*>/i.test(cleaned)) {
    return cleaned.replace(/<html\b[^>]*>/i, (tag) => `${tag}<head>${DEFAULT_HTML_STYLES}</head>`);
  }
  return `<!doctype html><html><head>${DEFAULT_HTML_STYLES}</head><body>${cleaned}</body></html>`;
}

export interface DiffFile {
  path: string;
  lines: string[];
  additions: number;
  deletions: number;
  isNew: boolean;
  isDeleted: boolean;
}

/** Splits a unified diff into files with their +/− counts and new/deleted flags. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = / b\/(.+)$/.exec(line);
      current = { path: match?.[1] ?? line.slice(11), lines: [], additions: 0, deletions: 0, isNew: false, isDeleted: false };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode") || line === "--- /dev/null") {
      current.isNew = true;
      continue;
    }
    if (line.startsWith("deleted file mode") || line === "+++ /dev/null") {
      current.isDeleted = true;
      continue;
    }
    if (line.startsWith("+++ b/")) {
      current.path = line.slice(6);
      continue;
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("index ") || line.startsWith("similarity") || line.startsWith("rename ")) continue;
    if (line.startsWith("+")) current.additions++;
    else if (line.startsWith("-")) current.deletions++;
    current.lines.push(line);
  }
  return files;
}

/** Reconstructs the new file content available in a unified diff's `+` and context (` `) lines. */
export function diffPreviewContent(file: DiffFile): string {
  const out: string[] = [];
  for (const line of file.lines) {
    if (line.startsWith("@@") || line.startsWith("-") || line === "\\ No newline at end of file") continue;
    if (line.startsWith("+") || line.startsWith(" ")) out.push(line.slice(1));
  }
  return out.join("\n");
}

/** Unescapes a JSON string body (also works when the string was truncated before its closing quote). */
function unescapeJsonPartial(raw: string): string {
  return raw.replace(/\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g, (_m, hex: string | undefined, ch: string | undefined) => {
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    switch (ch) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "b":
        return "\b";
      case "f":
        return "\f";
      default:
        return ch ?? "";
    }
  });
}

/** Extracts a string field from JSON text, even if the JSON was cut off at `MAX_TEXT` before the closing quote. */
export function extractJsonStringField(jsonText: string, fields: readonly string[]): { value: string; truncated: boolean } | undefined {
  for (const field of fields) {
    const complete = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "s").exec(jsonText);
    if (complete) return { value: unescapeJsonPartial(complete[1]!), truncated: false };
    const partial = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)\\\\?$`, "s").exec(jsonText);
    if (partial) return { value: unescapeJsonPartial(partial[1]!), truncated: true };
  }
  return undefined;
}

/** Strips line-number prefixes (`1: …` or `   1\t…`) when a `view` tool result formats every line with sequential numbers. */
function stripViewLineNumbers(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const nonEmpty = lines.filter((l) => l.length > 0);
  if (nonEmpty.length === 0) return text;
  const linePrefix = /^\s*(\d+)(?::|\t|\s\|)\s?/;
  const matches = nonEmpty.map((l) => linePrefix.exec(l));
  if (matches.every((m, idx) => m !== null && Number(m[1]) === idx + 1)) {
    return lines.map((l) => l.replace(linePrefix, "")).join("\n");
  }
  return text;
}

const WRITE_TOOLS = new Set(["create", "write", "write_file", "edit"]);
const READ_TOOLS = new Set(["view", "read", "read_file"]);

export interface ToolFilePreview {
  path: string;
  kind: PreviewKind;
  content?: string | undefined;
  partial: boolean;
  isWrite: boolean;
}

/**
 * Inspects a transcript tool call (`create`, `edit`, `view`, …) and returns preview metadata when the target file is
 * a `.md` or `.html` document.
 */
export function extractToolFilePreview(entry: Extract<TranscriptEntry, { kind: "tool" }>): ToolFilePreview | undefined {
  const toolName = entry.name.toLowerCase();
  const isWrite = WRITE_TOOLS.has(toolName);
  const isRead = READ_TOOLS.has(toolName);
  if (!isWrite && !isRead) return undefined;
  if (!entry.args) return undefined;

  let filePath: string | undefined;
  let content: string | undefined;
  let partial = Boolean(entry.argsCut || entry.resultCut);

  try {
    const parsed = JSON.parse(entry.args) as Record<string, unknown>;
    const rawPath = parsed.path ?? parsed.file_path ?? parsed.fileName ?? parsed.file;
    if (typeof rawPath === "string") filePath = rawPath;
    if (toolName === "edit") {
      if (typeof parsed.new_str === "string") content = parsed.new_str;
      partial = true;
    } else if (isWrite) {
      const rawContent = parsed.file_text ?? parsed.content ?? parsed.text;
      if (typeof rawContent === "string") content = rawContent;
      else partial = true;
    }
  } catch {
    const extractedPath = extractJsonStringField(entry.args, ["path", "file_path", "fileName", "file"]);
    if (extractedPath) filePath = extractedPath.value;
    const extractedContent = extractJsonStringField(
      entry.args,
      toolName === "edit" ? ["new_str"] : ["file_text", "content", "text"],
    );
    if (extractedContent) content = extractedContent.value;
    partial = true;
  }

  const kind = previewKind(filePath);
  if (!filePath || !kind) return undefined;

  if (isRead && entry.result) {
    content = stripViewLineNumbers(entry.result);
  }

  return {
    path: filePath,
    kind,
    ...(content !== undefined ? { content } : {}),
    partial,
    isWrite,
  };
}
