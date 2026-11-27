/**
 * R1: a sandboxed task's Windows PowerShell 5.1 read UTF-8 files as Windows-1252 and wrote
 * the damage back (`→` became `â†’`). The sandbox's init script makes the shell read UTF-8, and when a task finishes
 * ARIA counts the lines that still look damaged.
 */
// The module's own object, not a named import: the tests' guard (no-network.ts) wraps its functions there.
import childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ariaDirs, prepareAriaDirs } from "../src/policy/sandbox.ts";
import { addedLines, damagedLineCount, encodingDamage, utf16Lines, type AddedLine } from "../src/tasks/worktrees.ts";
import { git, makeRepo } from "./helpers.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function tempDir(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

/** What Windows PowerShell 5.1 makes of UTF-8 it reads as Windows-1252. */
const mangle = (text: string) => new TextDecoder("windows-1252").decode(Buffer.from(text, "utf8"));
/** Text as Windows-1252 bytes (é is 0xE9), for characters it has. */
const ansi = (text: string) => Buffer.from([...text].map((c) => (c.charCodeAt(0) < 0x100 ? c.charCodeAt(0) : 0x3f)));
/** Two-, three- and four-byte characters; none has a byte Windows-1252 leaves undefined. */
const SAMPLE = "Arrow → dash — é ü © ✓ 😀 ’quoted’\n";
const utf8Lines = (...texts: string[]): AddedLine[] => texts.map((text) => ({ text, utf8: true }));
const bytes = (text: string) => Buffer.from(text, "utf8");
const NBSP = String.fromCharCode(0xa0);

const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;

describe.skipIf(process.platform !== "win32" || !existsSync(powershell))("the sandbox's shell (Windows PowerShell 5.1)", () => {
  /**
   * The task's bulk-rename pattern on a file, and a node command's output saved the same way, with the shell flags the
   * sandbox uses. `init`: how the init script runs first (the runtime sources it; `&` runs it in a scope of its own).
   */
  function run(init: "none" | "sourced" | "own scope") {
    const base = tempDir("aria-r1-ps-");
    const dirs = ariaDirs(base);
    prepareAriaDirs(dirs);
    const file = path.join(base, "notes.md");
    const out = path.join(base, "out.txt");
    writeFileSync(file, SAMPLE);
    const command = [
      ...(init === "sourced" ? [`. ${psQuote(dirs.initScript)}`] : init === "own scope" ? [`& ${psQuote(dirs.initScript)}`] : []),
      `$content = Get-Content ${psQuote(file)} -Raw`,
      `[IO.File]::WriteAllText(${psQuote(file)}, $content)`,
      `$output = & ${psQuote(process.execPath)} -e "process.stdout.write('\\u2192 \\u2014')"`,
      `[IO.File]::WriteAllText(${psQuote(out)}, ($output -join ' '))`,
    ].join("; ");
    childProcess.execFileSync(powershell, ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "RemoteSigned", "-Command", command], { windowsHide: true, timeout: 60_000 });
    return { file: readFileSync(file), output: readFileSync(out, "utf8") };
  }

  it("damages UTF-8 without the init script, which shows the test can fail", { timeout: 60_000 }, () => {
    const { file, output } = run("none");
    expect(file.toString("utf8")).toBe(mangle(SAMPLE));
    expect(output).not.toBe("→ —");
  });

  it("keeps a file's bytes and reads command output as UTF-8 with it, sourced or in a scope of its own", { timeout: 60_000 }, () => {
    for (const init of ["sourced", "own scope"] as const) {
      const { file, output } = run(init);
      expect(file.equals(Buffer.from(SAMPLE, "utf8")), init).toBe(true);
      expect(output, init).toBe("→ —");
    }
  });
});

describe("addedLines", () => {
  const texts = (diff: string | Buffer) => addedLines(diff).map(({ added, ...file }) => ({ ...file, added: added.map((l) => l.text) }));

  it("reads each file's added lines by the hunk counts, with its path on the base, and the binary files", () => {
    const diff = [
      "diff --git a/old.md b/new.md",
      "similarity index 90%",
      "rename from old.md",
      "rename to new.md",
      "--- a/old.md",
      "+++ b/new.md",
      "@@ -2 +2,3 @@",
      "-removed",
      "+++ an added line that looks like a header →",
      "+--- and another?",
      "+plain ASCII can't be damaged, so it's left out",
      "diff --git a/fresh.md b/fresh.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/fresh.md",
      "@@ -0,0 +1 @@",
      "+only line, café",
      "\\ No newline at end of file",
      "diff --git a/gone.md b/gone.md",
      "deleted file mode 100644",
      "--- a/gone.md",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/my img.png b/my img.png",
      "Binary files a/my img.png and b/my img.png differ",
      "diff --git a/new.bin b/new.bin",
      "new file mode 100644",
      "Binary files /dev/null and b/new.bin differ",
      "diff --git a/old.ico b/icons/app.ico",
      "rename from old.ico",
      "rename to icons/app.ico",
      "Binary files a/old.ico and b/icons/app.ico differ",
      "",
    ].join("\n");
    expect(texts(diff)).toEqual([
      { path: "new.md", basePath: "old.md", added: ["++ an added line that looks like a header →", "--- and another?"] },
      { path: "fresh.md", added: ["only line, café"] },
      { path: "my img.png", basePath: "my img.png", added: [], binary: true },
      { path: "new.bin", added: [], binary: true },
      { path: "icons/app.ico", basePath: "old.ico", added: [], binary: true },
    ]);
  });

  it("stops at a diff cut off inside a hunk and reads the next file's headers", () => {
    const diff = ["--- a/a.md", "+++ b/a.md", "@@ -1,3 +1,3 @@", "+one →", "diff --git a/b.md b/b.md", "--- a/b.md", "+++ b/b.md", "@@ -1 +1 @@", "-x", "+two →"].join("\n");
    expect(texts(diff)).toEqual([
      { path: "a.md", basePath: "a.md", added: ["one →"] },
      { path: "b.md", basePath: "b.md", added: ["two →"] },
    ]);
  });

  it("reads an empty line in a hunk as an empty context line, and pairs the lines on each side of it", () => {
    // diff.interHunkContext fuses hunks even with -U0, and diff.suppressBlankEmpty drops the space of an empty one.
    const diff = ["--- a/a.md", "+++ b/a.md", "@@ -1,4 +1,5 @@", "-café", "+caf?", "", "-one →", "-two", "+one ?", "+two", "+three →"].join("\n");
    expect(addedLines(diff)).toEqual([
      {
        path: "a.md",
        basePath: "a.md",
        added: [{ text: "caf?", utf8: true, was: "café" }, { text: "one ?", utf8: true }, { text: "three →", utf8: true }],
      },
    ]);
  });

  it("takes a copy's base from its copy-from line", () => {
    const diff = ["diff --git a/a.md b/b.md", "similarity index 90%", "copy from a.md", "copy to b.md", "Binary files a/a.md and b/b.md differ"].join("\n");
    expect(texts(diff)).toEqual([{ path: "b.md", basePath: "a.md", added: [], binary: true }]);
  });

  it("says which added lines weren't UTF-8, and pairs a rewritten line with the one it replaced", () => {
    const diff = Buffer.concat([bytes("--- a/a.md\n+++ b/a.md\n@@ -1,2 +1,2 @@\n-caf\u00e9\n-Arrow \u2192\n+caf"), Buffer.from([0xe9]), bytes("\r\n+Arrow ?\n")]);
    expect(addedLines(diff)).toEqual([
      {
        path: "a.md",
        basePath: "a.md",
        added: [
          { text: "caf\uFFFD", utf8: false, was: "caf\u00e9" },
          { text: "Arrow ?", utf8: true, was: "Arrow \u2192" },
        ],
      },
    ]);
  });
});

describe("damagedLineCount", () => {
  it("counts text that went through Windows-1252, whatever the character's length", () => {
    for (const text of ["→", "—", "é", "ü", "©", "\u00A0", "✓", "😀", "’", "“", "…", "€", "Á", "\uFEFF", "中文", "हिन्दी"]) {
      expect(damagedLineCount(utf8Lines(`x ${mangle(text)} y`)), text).toBe(1);
    }
  });

  it("leaves real text alone: other languages' letters next to punctuation, and French spacing", () => {
    const real = [
      "Arrow → dash — café naïve Ärger ©",
      "„Fuß“ und «déjà-vu»",
      "Le statut est passé à «\u00A0Terminé\u00A0».",
      "voilà\u00A0» café”— café—“ Touché…” hyvä…” Nestlé®™",
      "SÃO PAULO",
      "ÂGE",
      `«${NBSP}Hawaï${NBSP}» et «${NBSP}Hanoï${NBSP}»`,
      "plain ascii",
    ];
    expect(damagedLineCount(utf8Lines(...real))).toBe(0);
  });

  it("counts a replacement character, and bytes that aren't UTF-8 in a file that was UTF-8", () => {
    expect(damagedLineCount(utf8Lines("caf\uFFFD"))).toBe(1);
    expect(damagedLineCount([{ text: "caf\uFFFD", utf8: false }], bytes("# Notes\n"))).toBe(1);
    // A file kept in a legacy encoding may mean them, and so may a new file.
    expect(damagedLineCount([{ text: "caf\uFFFD", utf8: false }], ansi("// caf\u00e9\n"))).toBe(0);
    expect(damagedLineCount([{ text: "caf\uFFFD", utf8: false }])).toBe(0);
    // A legacy file read as UTF-8 and written back: real replacement characters, which it didn't have.
    expect(damagedLineCount(utf8Lines("// caf\uFFFD"), ansi("// caf\u00e9\n"))).toBe(1);
  });

  it("counts a line that came back with its non-ASCII characters as question marks", () => {
    expect(damagedLineCount([{ text: "Arrow ? here", utf8: true, was: "Arrow → here" }], bytes("Arrow → here\n"))).toBe(1);
    expect(damagedLineCount([{ text: "Smile ??", utf8: true, was: "Smile 😀" }], bytes("Smile 😀\n"))).toBe(1);
    expect(damagedLineCount([{ text: "What? Yes.", utf8: true, was: "What → Yes." }], bytes("What → Yes.\n"))).toBe(0);
  });

  it("doesn't count what the base already had, but still counts new damage beside it", () => {
    const base = bytes(`An example of damage: ${mangle("é")}\n`);
    expect(damagedLineCount(utf8Lines(`see ${mangle("é")}`), base)).toBe(0);
    expect(damagedLineCount(utf8Lines(`see ${mangle("→")}`), base)).toBe(1);
    expect(damagedLineCount(utf8Lines("caf\uFFFD"), bytes("a replacement character: \uFFFD\n"))).toBe(0);
  });

  it("counts a byte-order mark only in a file that was there without one", () => {
    expect(damagedLineCount(utf8Lines("\uFEFFusing System;"), bytes("using System;\n"))).toBe(1);
    expect(damagedLineCount(utf8Lines("\uFEFFusing System;"), bytes("\uFEFFusing System;\n"))).toBe(0);
    // A new file may want one (a Visual Studio solution has one).
    expect(damagedLineCount(utf8Lines("\uFEFFMicrosoft Visual Studio Solution File"))).toBe(0);
  });
});

describe("utf16Lines", () => {
  const le = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);

  it("counts the lines of a text file turned into UTF-16, and nothing else", () => {
    expect(utf16Lines(le("one\r\ntwo → three\r\n"), bytes("one\ntwo → three\n"))).toBe(2);
    // Already UTF-16, or binary, on the base; or not UTF-16 now.
    expect(utf16Lines(le("one\n"), le("one\n"))).toBe(0);
    expect(utf16Lines(le("one\n"), Buffer.from([0x89, 0x50, 0x00, 0x01]))).toBe(0);
    expect(utf16Lines(Buffer.from([0x89, 0x50, 0x00]), bytes("text\n"))).toBe(0);
  });
});

describe("encodingDamage", () => {
  function setup() {
    const base = tempDir("aria-r1-git-");
    const repo = makeRepo(base, "Moonrise");
    git(repo, "config", "core.autocrlf", "false");
    const write = (file: string, content: string | Buffer) => {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      writeFileSync(path.join(repo, file), content);
    };
    write("docs/clean.md", "# Notes\n\nArrow → here.\nDash — there.\n");
    write("docs/encodings.md", `Damage looks like ${mangle("→")}.\n`);
    // A space in the name: git ends its diff headers with a tab, and the base must still be found by that name.
    write("docs/old notes.md", `Kept as found: ${mangle("é")}\n`);
    write("src/Program.cs", "using System;\n");
    write("src/Legacy.cs", ansi("// Café, in Windows-1252\n"));
    write("src/Ansi.cs", "// Café → bar\n// Arrow → only\n");
    write("README.txt", "Read me → now\n");
    write("unchanged.md", "café\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "Base");
    return { repo, write, baseCommit: git(repo, "rev-parse", "HEAD") };
  }

  it("is undefined for a diff without damage", async () => {
    const { repo, write, baseCommit } = setup();
    write("docs/clean.md", "# Notes\n\nArrow → here.\nDash — there, and é.\n");
    git(repo, "commit", "-q", "-am", "Clean change");
    // A legacy file edited in its own encoding, and a new file in French.
    write("src/Legacy.cs", ansi("// Café, in Windows-1252\n// Thé\n"));
    write("docs/fr.md", "Le statut est passé à «\u00A0Terminé\u00A0».\n");
    expect(await encodingDamage(repo, baseCommit)).toBeUndefined();
  });

  it("counts damaged lines in committed, uncommitted and new files, and none that were there before", async () => {
    const { repo, write, baseCommit } = setup();
    // Committed: the bulk-rename pattern on a whole file (two damaged lines of four).
    write("docs/clean.md", mangle("# Notes\n\nArrow → here.\nDash — there.\n"));
    git(repo, "commit", "-q", "-am", "Rename things");
    // Damage the base already had: not counted.
    write("docs/encodings.md", `Damage looks like ${mangle("→")}.\nAgain: ${mangle("→")}.\n`);
    write("docs/old notes.md", `Kept as found: ${mangle("é")}\nAnd again: ${mangle("é")}\n`);
    // Uncommitted: a byte-order mark the file didn't have.
    write("src/Program.cs", "\uFEFFusing System;\n");
    // A legacy file read as UTF-8 and written back: a real replacement character.
    write("src/Legacy.cs", "// Caf\uFFFD, in Windows-1252\n");
    // Set-Content in 5.1: é as one Windows-1252 byte, → as `?` (two lines).
    write("src/Ansi.cs", ansi("// Café → bar\n// Arrow → only\n"));
    // Out-File or > in 5.1: the file is now UTF-16 (one line).
    write("README.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Read me → now\r\n", "utf16le")]));
    // New, not added: damaged text; a solution with its own byte-order mark, a binary file, a Latin-1 file.
    write("docs/fresh.md", `ok\n${mangle("✓ done")}\n`);
    write("App.sln", "\uFEFF\nMicrosoft Visual Studio Solution File\n");
    write("logo.bin", Buffer.from([0x89, 0x50, 0x00, 0xc3, 0xa2]));
    write("messages.properties", ansi("greeting=Café\n"));
    expect(await encodingDamage(repo, baseCommit)).toEqual({
      lines: 8,
      files: 6,
      paths: ["docs/clean.md", "src/Ansi.cs", "src/Legacy.cs", "src/Program.cs", "README.txt", "docs/fresh.md"],
      base: baseCommit,
    });
  });

  it("names at most 20 files and counts them all", async () => {
    const { write, repo, baseCommit } = setup();
    for (let i = 0; i < 25; i++) write(`many/file-${String(i).padStart(2, "0")}.md`, `${mangle("é")}\n`);
    const damage = await encodingDamage(repo, baseCommit);
    expect(damage).toMatchObject({ lines: 25, files: 25 });
    expect(damage!.paths).toHaveLength(20);
  });

  it("leaves control and format characters out of the names it shows", async () => {
    const { write, repo, baseCommit } = setup();
    write("docs/\u202Etxt.md", `${mangle("é")}\n`);
    expect((await encodingDamage(repo, baseCommit))!.paths).toEqual(["docs/txt.md"]);
  });
});
