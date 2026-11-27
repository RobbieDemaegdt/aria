import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The renderer's CSP refuses WebAssembly (`script-src 'self'`), so code highlighting must not need it: with it gone
 * here, Shiki's default (Oniguruma) engine would throw and every code block would stay plain, as it did before.
 */
describe("code highlighting", () => {
  let codeToHtml: typeof import("../src/renderer/src/highlight").codeToHtml;

  beforeAll(async () => {
    vi.stubGlobal("WebAssembly", undefined);
    ({ codeToHtml } = await import("../src/renderer/src/highlight"));
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  // Languages a reply's code blocks often use, besides the TypeScript the scripted replies use.
  const samples: Array<[string, string]> = [
    ["ts", "export const part: number = 1;"],
    ["tsx", "const Hello = () => <b className=\"x\">hi</b>;"],
    ["json", '{ "name": "aria", "private": true }'],
    ["powershell", "Get-ChildItem -Path $env:TEMP | Where-Object { $_.Length -gt 1MB }"],
    ["bash", 'for f in *.ts; do echo "$f"; done'],
    ["python", "def greet(name: str) -> str:\n    return f\"hi {name}\""],
    ["csharp", "public sealed record Part(int Number) { }"],
    ["diff", "--- a/x.ts\n+++ b/x.ts\n-const a = 1;\n+const a = 2;"],
    ["yaml", "jobs:\n  test:\n    runs-on: windows-latest"],
    ["sql", "SELECT id, title FROM tasks WHERE state = 'done';"],
  ];

  it.each(samples)("highlights %s without WebAssembly", async (lang, code) => {
    const html = await codeToHtml(code, { lang, theme: "github-dark" });
    expect(html).toContain('class="shiki github-dark"');
    // More than one colour: the grammar ran, not just the theme's plain foreground.
    const colours = new Set(html.match(/color:#[0-9A-Fa-f]{6}/g));
    expect(colours.size).toBeGreaterThan(1);
  });

  it("escapes the code it highlights", async () => {
    const html = await codeToHtml('const s = "<script>alert(1)</script>";', { lang: "ts", theme: "github-dark" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&#x3C;script>");
  });

  it("rejects a language it doesn't have, so the block stays plain", async () => {
    await expect(codeToHtml("whatever", { lang: "no-such-language", theme: "github-dark" })).rejects.toThrow(/not included/);
  });
});
