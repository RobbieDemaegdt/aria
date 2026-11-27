import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "@aria/lint-typescript";

// No type-aware rules: typescript-eslint only runs on TypeScript 6 (tools/lint), so it parses here and doesn't type-check.
export default [
  { ignores: ["**/node_modules/**", "**/out/**", "**/dist/**", "**/.artifacts/**", "spike/**", "docs/**", "test-results/**", "tools/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    name: "sources",
    files: ["packages/**/*.{ts,tsx}", "apps/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Stripping control characters from untrusted text is deliberate wherever this fires.
      "no-control-regex": "off",
      // A closure declared before the assignment may read it first: as a `const` there, that would throw.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      // A comment inside counts as not empty, so a `.catch(() => {})` has to say why ignoring is safe.
      "@typescript-eslint/no-empty-function": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  {
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    // The classic two only: the React Compiler rules assume a compiler this repo doesn't use.
    rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "error" },
  },
  {
    files: ["apps/desktop/src/preload/**/*.ts", "apps/desktop/e2e/**/*.ts"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    // Stubs and loose fixtures are fine in tests.
    files: ["**/test/**/*.{ts,tsx}", "**/e2e/**/*.ts"],
    rules: {
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
