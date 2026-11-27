import { FileText, ImageOff } from "lucide-react";
import { createContext, memo, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { splitFrontmatter } from "../filePreview";
import { cachedHighlight, rememberHighlight } from "../highlightCache";

const PreContext = createContext(false);
const MarkdownFenceDepthContext = createContext(0);

const MARKDOWN_LANGS = new Set(["md", "markdown", "mdx"]);
const HIGHLIGHT_THEME = "github-dark";

/**
 * If an entire response is wrapped in a single outer ```markdown / ```md / ```mdx code fence (including while
 * streaming before the closing fence arrives), unwrap it so the response is processed as readable Markdown rather
 * than shown as raw syntax in a code block.
 */
export function unwrapOuterMarkdownFence(raw: string): string {
  const trimmed = raw.trim();
  const openMatch = /^(`{3,}|~{3,})[ \t]*(?:markdown|md|mdx)\b[^\r\n]*\r?\n([\s\S]*)$/i.exec(trimmed);
  if (!openMatch) return raw;
  const fence = openMatch[1]!;
  const rest = openMatch[2]!;
  const closeRegex = new RegExp(`^${fence}[ \\t]*$`, "m");

  // Check if the fence closes at the very end of the string
  const endCloseRegex = new RegExp(`\\r?\\n${fence}[ \\t]*$`);
  if (endCloseRegex.test(rest)) {
    const inner = rest.replace(endCloseRegex, "");
    if (!closeRegex.test(inner)) {
      return inner;
    }
    return raw;
  }

  // Unclosed outer fence (e.g. streaming in progress) with no inner close fence
  if (!closeRegex.test(rest)) {
    return rest;
  }
  return raw;
}

/**
 * Assistant Markdown. Raw HTML in model output is never rendered (no rehype-raw), react-markdown drops unsafe URL
 * schemes, and links open in the browser through the main process (http/https only), only when you click them.
 * Images are never fetched: loading a URL the model wrote would send data to that server without a click (the CSP
 * blocks remote images too).
 */
function CodeBlock({ language, code }: { language: string; code: string }) {
  const depth = useContext(MarkdownFenceDepthContext);
  const normLang = language.trim().toLowerCase();
  const isMarkdownFence = MARKDOWN_LANGS.has(normLang) && depth < 3;
  const [mode, setMode] = useState<"preview" | "raw">("preview");
  const lang = language || "text";
  // This block's own highlight, while its code is still what was highlighted (a streamed block keeps growing, and an
  // older highlight would hide its newest lines), else one made before for the same code, else none yet.
  const [own, setOwn] = useState<{ lang: string; code: string; html: string } | null>(null);
  const html = own && own.lang === lang && own.code === code ? own.html : (cachedHighlight(HIGHLIGHT_THEME, lang, code) ?? null);
  const highlighted = html !== null;

  useEffect(() => {
    if (highlighted || (isMarkdownFence && mode === "preview")) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      import("../highlight")
        .then(({ codeToHtml }) => codeToHtml(code, { lang, theme: HIGHLIGHT_THEME }))
        .then((out) => {
          // Kept even if this block is gone: the final message draws the same code again.
          rememberHighlight(HIGHLIGHT_THEME, lang, code, out);
          if (!cancelled) setOwn({ lang, code, html: out });
        })
        .catch(() => {
          // A language Shiki doesn't have, or a pattern its engine can't compile: the block stays plain.
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [lang, code, highlighted, isMarkdownFence, mode]);

  if (isMarkdownFence) {
    return (
      <div className="my-2 overflow-hidden rounded-md border border-line bg-canvas/70" data-testid="md-fence-block">
        <div className="flex items-center justify-between gap-2 border-b border-line bg-raised/70 px-2.5 py-1 text-[11px] text-muted">
          <span className="inline-flex items-center gap-1.5 font-medium text-fg/90">
            <FileText className="h-3 w-3 shrink-0 text-accent" />
            <span>Markdown</span>
          </span>
          <div className="inline-flex shrink-0 rounded border border-line bg-canvas p-0.5 text-[10px]" data-testid="md-fence-toggle">
            <button
              type="button"
              data-testid="md-fence-preview"
              aria-pressed={mode === "preview"}
              onClick={() => setMode("preview")}
              className={`rounded px-1.5 py-px ${mode === "preview" ? "bg-accent text-white" : "text-muted hover:text-fg"}`}
            >
              Preview
            </button>
            <button
              type="button"
              data-testid="md-fence-raw"
              aria-pressed={mode === "raw"}
              onClick={() => setMode("raw")}
              className={`rounded px-1.5 py-px ${mode === "raw" ? "bg-accent text-white" : "text-muted hover:text-fg"}`}
            >
              Raw
            </button>
          </div>
        </div>
        {mode === "preview" ? (
          <div className="px-3 py-2 text-sm" data-testid="md-fence-rendered">
            <PreContext.Provider value={false}>
              <MarkdownFenceDepthContext.Provider value={depth + 1}>
                <Markdown text={code} />
              </MarkdownFenceDepthContext.Provider>
            </PreContext.Provider>
          </div>
        ) : html ? (
          <div className="shiki-wrap" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="m-0 border-0">
            <code>{code}</code>
          </pre>
        )}
      </div>
    );
  }

  // shiki escapes the code it highlights, so its HTML is safe to insert.
  if (html) return <div className="shiki-wrap" dangerouslySetInnerHTML={{ __html: html }} />;
  return (
    <pre>
      <code>{code}</code>
    </pre>
  );
}

function MarkdownCode({ className, children }: { className?: string | undefined; children?: ReactNode }) {
  const inPre = useContext(PreContext);
  const text = String(children ?? "");
  const match = /language-([\w+-]+)/.exec(className ?? "");
  const block = inPre || match !== null || text.includes("\n");
  if (!block) return <code>{children}</code>;
  return <CodeBlock language={match?.[1] ?? "text"} code={text.replace(/\n$/, "")} />;
}

const components: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (href) void window.aria.openExternal(href);
      }}
    >
      {children}
    </a>
  ),
  code: ({ className, children }) => <MarkdownCode className={className} children={children} />,
  pre: ({ children }): ReactNode => <PreContext.Provider value={true}>{children}</PreContext.Provider>,
  img: ({ src, alt }) => (
    <span
      data-testid="md-image"
      title={typeof src === "string" && src ? `Image not loaded: ${src}` : "Image not loaded"}
      className="inline-flex items-center gap-1 rounded border border-line px-1 text-xs text-muted"
    >
      <ImageOff className="h-3 w-3" />
      {alt?.trim() || "image"}
    </span>
  ),
};

/** One list for every render: react-markdown gets the same plugins each time. */
const REMARK_PLUGINS = [remarkGfm];

/**
 * Memoized: react-markdown parses its text again on every render, so the same text is drawn once, however often
 * what's around it is drawn again (the chat holds a few hundred of these).
 */
export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const parsed = useMemo(() => {
    const unwrapped = unwrapOuterMarkdownFence(text);
    return splitFrontmatter(unwrapped);
  }, [text]);

  return (
    <div className={`md${streaming ? " cursor" : ""}`}>
      {parsed.frontmatter.length > 0 && (
        <div className="mb-2.5 flex flex-wrap gap-x-4 gap-y-1 rounded-md border border-line bg-canvas/70 px-3 py-1.5 text-xs" data-testid="md-frontmatter">
          {parsed.frontmatter.map((field) => (
            <div key={field.key} className="flex items-baseline gap-1.5">
              <span className="font-mono text-[11px] text-muted">{field.key}:</span>
              <span className="font-medium text-fg">{field.value}</span>
            </div>
          ))}
        </div>
      )}
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {parsed.body}
      </ReactMarkdown>
    </div>
  );
});
