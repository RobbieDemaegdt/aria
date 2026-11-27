// The module's own object, not a named import: the tests' guard (no-network.ts) wraps its functions there.
import childProcess from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** A real (empty) git repository on the default branch `main`, optionally with an origin remote. */
export function makeRepo(root: string, name: string, remote?: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  childProcess.execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  if (remote) childProcess.execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  return dir;
}

/** Runs git with a fixed identity, so tests don't depend on the machine's git config (line endings follow it, as ARIA's
 * own git calls do). */
export function git(dir: string, ...args: string[]): string {
  return childProcess.execFileSync("git", ["-c", "user.name=ARIA Test", "-c", "user.email=test@example.invalid", ...args], { cwd: dir, encoding: "utf8" }).trim();
}

/** How long a test waits for something: four times what it takes on an idle PC. GitHub's Windows runners run the suite
 * several times slower, and so does a PC running other test runs beside it (each task spawns git about ten times, and
 * a git start takes two to three times as long then). A wait ends as soon as its condition holds, so this costs a
 * passing test nothing. vitest.config.ts gives each test 30 s for the same reason. */
export function waitMs(ms: number): number {
  return ms * 4;
}

/** Writes a file and commits it. */
export function commitFile(dir: string, file: string, content: string, message = `Add ${file}`): void {
  const full = path.join(dir, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  git(dir, "add", "--", file);
  git(dir, "commit", "-q", "-m", message);
}
