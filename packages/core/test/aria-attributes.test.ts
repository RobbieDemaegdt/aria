/**
 * The accessibility attributes (WAI-ARIA's `aria-label`, `aria-hidden`, ...) share their letters with the app's name. This keeps them
 * safe from any rename or search-and-replace that touches those letters: every attribute written with the aria- prefix in the window's code is one
 * of the official ones (the rename tool's guard G4, kept for good; the list is WAI-ARIA 1.2's and the two braille ones), and no
 * attribute is written as a camel-case prop (`ariaLabel=`), which React doesn't know. It reads the files, so it also holds in an export.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.resolve(here, "../../..", "apps", "desktop", "src", "renderer");

const OFFICIAL = "activedescendant atomic autocomplete braillelabel brailleroledescription busy checked colcount colindex colindextext colspan controls current describedby description details disabled dropeffect errormessage expanded flowto grabbed haspopup hidden invalid keyshortcuts label labelledby level live modal multiline multiselectable orientation owns placeholder posinset pressed readonly relevant required roledescription rowcount rowindex rowindextext rowspan selected setsize sort valuemax valuemin valuenow valuetext".split(" ");

/** A name with the aria- prefix written as an attribute (followed by `=`; not part of a longer name, such as a data- attribute's). */
const attribute = /(?<![A-Za-z0-9_-])aria-([a-z]+)(?==)/g;
/** `ariaX=` followed by a value: a camel-case JSX prop. */
const camelProp = /(?<![A-Za-z0-9_.-])aria[A-Z][A-Za-z]*=(?=[{"'])/g;

/** The problems in one file's text: attributes outside the official list, and camel-case props. */
function ariaProblems(text: string): string[] {
  const problems: string[] = [];
  for (const m of text.matchAll(attribute)) if (!OFFICIAL.includes(m[1]!)) problems.push(`${m[0]} is not a WAI-ARIA attribute`);
  for (const m of text.matchAll(camelProp)) problems.push(`${m[0]} is a camel-case prop`);
  return problems;
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(p);
    else if (/\.(tsx|ts|html)$/.test(entry.name)) yield p;
  }
}

describe("WAI-ARIA attributes in the window's code", () => {
  it("knows the 53 official attribute names", () => {
    expect(OFFICIAL).toHaveLength(53);
    expect(new Set(OFFICIAL).size).toBe(53);
    for (const name of ["label", "hidden", "expanded", "pressed", "current", "haspopup", "selected", "checked", "invalid", "labelledby", "describedby", "live", "modal", "disabled"]) expect(OFFICIAL).toContain(name);
  });

  it("finds a made-up attribute and a camel-case prop, and leaves real ones and look-alikes alone", () => {
    // The made-up name is spelled from pieces, so the rename tool's own guard (which reads this file too) doesn't take it for a real one.
    const madeUp = ["aria", "task"].join("-");
    expect(ariaProblems(`<b ${madeUp}="y" aria-label="x">`)).toEqual([`${madeUp} is not a WAI-ARIA attribute`]);
    expect(ariaProblems('<b ariaLabel="x" ariaHidden={true}>')).toEqual(["ariaLabel= is a camel-case prop", "ariaHidden= is a camel-case prop"]);
    expect(ariaProblems('<b aria-label="x" aria-hidden={true} aria-expanded={open} data-aria-preview-defaults="1">')).toEqual([]);
    expect(ariaProblems("const ariaCalls = []; const x = { ariaDirs: 1 }; text.includes('aria-label')")).toEqual([]);
  });

  it("uses only official attributes in apps/desktop/src/renderer, and never a camel-case prop", () => {
    let files = 0;
    let attributes = 0;
    const problems: string[] = [];
    for (const file of sourceFiles(renderer)) {
      const text = readFileSync(file, "utf8");
      files++;
      attributes += [...text.matchAll(attribute)].length;
      for (const p of ariaProblems(text)) problems.push(`${path.relative(renderer, file)}: ${p}`);
    }
    // It did read the window's code, and found its attributes.
    expect(files).toBeGreaterThan(40);
    expect(attributes).toBeGreaterThan(50);
    expect(problems).toEqual([]);
  });
});
