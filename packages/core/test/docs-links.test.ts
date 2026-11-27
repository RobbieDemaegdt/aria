/**
 * Nothing the repository publishes points at something it doesn't have. The test reads the files as they are on disk, so it holds in
 * the worktree and, more to the point, in an export (`git archive`), where the files left out of the public copy really are absent.
 *
 * 1. Every relative link of a Markdown file of the root, `docs/` and `spike/` resolves, and so does its `#anchor` (GitHub's slugs).
 * 2. Every `docs/…`, `spike/…` or `PLAN.md` path written in a `.ts`, `.tsx`, `.yml`, `.json` or `.md` file exists.
 * 3. Every `(docs/trackers.md, "<heading>")` that code or docs cite names a real heading of that doc.
 *
 * In a worktree `.gitattributes` is there, and its `export-ignore` paths are the files left out of the public copy: they count as absent
 * here too, so a published file that points at one fails (it would dangle in the export), and the left-out files themselves aren't read.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
/** The repository, or a copy of it (`DOCS_LINKS_ROOT`, for showing the test fail on a scratch copy). */
const root = process.env.DOCS_LINKS_ROOT ?? path.resolve(here, "../../..");

/** Paths a test writes into a temporary repository of its own: they never exist in this one. Per file, so a new one elsewhere fails. */
const TEMP_FOLDER_PATHS: Record<string, string[]> = {
  "apps/desktop/test/cards.test.tsx": ["docs/a.md"],
  "apps/desktop/test/markdown.test.tsx": ["docs/summary.md"],
  "packages/core/test/encoding-r1.test.ts": ["docs/clean.md", "docs/encodings.md", "docs/fr.md", "docs/fresh.md", "docs/old", "docs/txt.md"],
  "packages/core/test/worktrees.test.ts": ["docs/guide.md"],
};
/** Folders the spike scripts and the tests create when they run; git ignores them. */
const GENERATED = ["spike/.out", "spike/.scratch"];
const SKIP_DIRS = new Set(["node_modules", ".git", "out", "dist", ".artifacts", "test-results", "playwright-report", ".vite", ".vite-temp", ".vitest-cache"]);
const SCANNED = /\.(ts|tsx|yml|yaml|json|md)$/;

// ---------------------------------------------------------------------------------------------------------------------
// What is left out of the public copy

/** The `export-ignore` paths of `.gitattributes`, without the leading slash; none when the file isn't there (an export). */
function leftOutPaths(): string[] {
  const file = path.join(root, ".gitattributes");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .flatMap((line) => {
      const [pattern, ...attributes] = line.trim().split(/\s+/);
      return pattern && !pattern.startsWith("#") && attributes.includes("export-ignore") ? [pattern.replace(/^\/+/, "").replace(/\/+$/, "")] : [];
    });
}
const LEFT_OUT = leftOutPaths();
const isLeftOut = (rel: string): boolean => LEFT_OUT.some((p) => rel === p || rel.startsWith(`${p}/`));
/** Whether a path exists in the public copy. */
const exists = (rel: string): boolean => !isLeftOut(rel) && existsSync(path.join(root, rel));

/** The published files to read, as paths from the root with `/`. */
function publishedFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (isLeftOut(next)) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(next);
      } else if (SCANNED.test(entry.name) && entry.name !== "package-lock.json" && next !== "packages/core/test/docs-links.test.ts") out.push(next);
    }
  };
  walk("");
  return out;
}
const FILES = publishedFiles();
const read = (rel: string): string => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

// ---------------------------------------------------------------------------------------------------------------------
// Markdown: headings, slugs and links

interface Heading {
  text: string;
  slug: string;
}

/** The lines of a Markdown file that are not inside a fenced code block. */
function proseLines(markdown: string): Array<{ line: string; number: number }> {
  let fence: string | undefined;
  const out: Array<{ line: string; number: number }> = [];
  markdown.split("\n").forEach((line, i) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (fence === undefined) fence = marker[0]!;
      else if (marker[0] === fence) fence = undefined;
      return;
    }
    if (fence === undefined) out.push({ line, number: i + 1 });
  });
  return out;
}

/** GitHub's anchor for a heading: lower case, formatting dropped, punctuation but `-` and `_` dropped, spaces as `-`. */
function slugOf(heading: string): string {
  const plain = heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+#+\s*$/, "")
    .trim();
  return plain.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}

const headingCache = new Map<string, Heading[]>();
/** The headings of a Markdown file, with their anchors (a repeated heading gets `-1`, `-2`, as on GitHub). */
function headingsOf(rel: string): Heading[] {
  const cached = headingCache.get(rel);
  if (cached) return cached;
  const seen = new Map<string, number>();
  const headings = proseLines(read(rel)).flatMap(({ line }) => {
    const match = /^ {0,3}#{1,6}\s+(.*?)\s*$/.exec(line);
    if (!match) return [];
    const text = match[1]!.replace(/\s+#+\s*$/, "");
    const base = slugOf(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return [{ text: text.replace(/[`*]/g, ""), slug: count === 0 ? base : `${base}-${count}` }];
  });
  headingCache.set(rel, headings);
  return headings;
}

/** The link targets of a Markdown file: inline links and images outside code, and reference definitions. */
function linksOf(rel: string): Array<{ target: string; line: number }> {
  const out: Array<{ target: string; line: number }> = [];
  for (const { line, number } of proseLines(read(rel))) {
    const text = line.replace(/`[^`]*`/g, "");
    for (const match of text.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]*)[^)]*\)/g)) out.push({ target: match[1]!.replace(/^<|>$/g, ""), line: number });
    const definition = /^ {0,3}\[[^\]]+\]:\s*(\S+)/.exec(text);
    if (definition) out.push({ target: definition[1]!, line: number });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------

describe("the links of the published files", () => {
  it("resolve: every relative link of a Markdown file of the root, docs/ and spike/, and its #anchor", () => {
    const markdown = FILES.filter((f) => f.endsWith(".md") && (!f.includes("/") || f.startsWith("docs/") || f.startsWith("spike/")));
    expect(markdown.length, "no Markdown files were found; is the root right?").toBeGreaterThan(0);
    const problems: string[] = [];
    for (const file of markdown) {
      for (const { target, line } of linksOf(file)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) continue; // http:, https:, mailto: …
        const [pathPart = "", anchor] = target.split("#") as [string, string | undefined];
        let resolved: string;
        try {
          resolved = pathPart === "" ? file : path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(pathPart)));
        } catch {
          problems.push(`${file}:${line}: ${target} isn't a link that can be read`);
          continue;
        }
        if (resolved.startsWith("../") || !exists(resolved)) {
          problems.push(`${file}:${line}: the link ${target} points at ${resolved}, which isn't in the public copy`);
          continue;
        }
        if (anchor !== undefined && anchor !== "" && resolved.endsWith(".md") && statSync(path.join(root, resolved)).isFile()) {
          const wanted = decodeURIComponent(anchor).toLowerCase();
          if (!headingsOf(resolved).some((h) => h.slug === wanted)) problems.push(`${file}:${line}: the link ${target} has no heading #${anchor} in ${resolved}`);
        }
      }
    }
    expect(problems, `links that don't resolve:\n${problems.join("\n")}`).toEqual([]);
  });

  it("name files that exist: every docs/…, spike/… or PLAN.md path written in a .ts, .tsx, .yml, .json or .md file", () => {
    const mention = /(?<![\w./-])((?:docs|spike)\/[A-Za-z0-9_./-]*[A-Za-z0-9_/]|PLAN\.md)/g;
    const problems: string[] = [];
    for (const file of FILES) {
      const allowed = new Set([...(TEMP_FOLDER_PATHS[file] ?? []), ...GENERATED]);
      read(file).split("\n").forEach((line, i) => {
        for (const match of line.matchAll(mention)) {
          const rel = match[1]!.replace(/\.+$/, "").replace(/\/+$/, "");
          if (allowed.has(rel) || exists(rel)) continue;
          problems.push(`${file}:${i + 1}: ${rel} isn't in the public copy${isLeftOut(rel) ? " (it is left out of it)" : ""}`);
        }
      });
    }
    expect(problems, `paths that point at nothing:\n${problems.join("\n")}`).toEqual([]);
  });

  it("cite docs/trackers.md by a heading it has: every (docs/trackers.md, \"…\")", () => {
    const headings = new Set(headingsOf("docs/trackers.md").map((h) => h.text));
    const citation = /\(docs\/trackers\.md, ((?:"[^"]+"(?: and )?)+)\)/g;
    const problems: string[] = [];
    let cited = 0;
    for (const file of FILES) {
      read(file).split("\n").forEach((line, i) => {
        for (const match of line.matchAll(citation)) {
          for (const name of match[1]!.matchAll(/"([^"]+)"/g)) {
            cited++;
            if (!headings.has(name[1]!)) problems.push(`${file}:${i + 1}: docs/trackers.md has no heading "${name[1]}"`);
          }
        }
      });
    }
    expect(cited, "no citation of docs/trackers.md was found; is the pattern right?").toBeGreaterThan(0);
    expect(problems, `citations of docs/trackers.md that name no heading:\n${problems.join("\n")}`).toEqual([]);
  });
});
