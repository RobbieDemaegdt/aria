/**
 * Code highlighting for Markdown's code blocks. `CodeBlock` imports this module when a block first needs it, so Shiki
 * stays out of the window's first load.
 *
 * Shiki's default regex engine is Oniguruma compiled to WebAssembly, which the renderer's Content-Security-Policy
 * refuses (`script-src 'self'`, without 'wasm-unsafe-eval'): every block stayed plain. Its JavaScript engine turns the
 * grammars' patterns into native RegExps instead, so it needs no WebAssembly and no eval, and the CSP stays as it is. It
 * compiles every pattern of Shiki's bundled grammars but one of AutoHotkey v2's (invalid in Oniguruma too). A pattern
 * it can't compile throws when the tokenizer reaches it, and that block stays plain.
 *
 * Grammars and themes are loaded the first time a block asks for them, each from its own chunk.
 */
import { createBundledHighlighter, createSingletonShorthands, guessEmbeddedLanguages } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages, type BundledLanguage } from "shiki/langs";
import { bundledThemes, type BundledTheme } from "shiki/themes";

const createHighlighter = createBundledHighlighter<BundledLanguage, BundledTheme>({
  langs: bundledLanguages,
  themes: bundledThemes,
  engine: () => createJavaScriptRegexEngine(),
});

/** Highlighted HTML for `code`; rejects for a language Shiki doesn't have. Shiki escapes the code. */
export const { codeToHtml } = createSingletonShorthands(createHighlighter, { guessEmbeddedLanguages });
