/**
 * A task's own folder in the shared .git (`worktreeAdminDir`), found however its worktree's path is spelled: GitHub's
 * Windows runners hand out TEMP as a short 8.3 name, while git writes the long one.
 */
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { worktreeAdminDir } from "../src/policy/sandbox.ts";
import { commitFile, git, makeRepo } from "./helpers.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function setup() {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "aria-admin-")));
  temps.push(base);
  const repo = makeRepo(base, "Moonrise");
  commitFile(repo, "README.md", "# Moonrise\n", "Initial commit");
  const add = (name: string) => {
    const worktree = path.join(base, "wt", name);
    git(repo, "worktree", "add", "-q", "-b", `aria/${name}`, worktree);
    return worktree;
  };
  return { base, common: path.join(repo, ".git"), add };
}

describe("worktreeAdminDir", () => {
  it("finds the folder through another spelling of the worktree's path (a link, like a short name)", () => {
    const { base, common, add } = setup();
    const one = add("one");
    add("two");
    const admin = worktreeAdminDir(common, one);
    expect(admin).toBe(path.join(common, "worktrees", "one"));

    const alias = path.join(base, "alias");
    symlinkSync(path.join(base, "wt"), alias, "junction");
    expect(worktreeAdminDir(common, path.join(alias, "one"))).toBe(admin);
  });

  it("never follows the worktree's .git link, which a task could point at another worktree's", () => {
    const { common, add } = setup();
    const one = add("one");
    const two = add("two");
    const link = path.join(one, ".git");
    rmSync(link);
    let linked = false;
    try {
      symlinkSync(path.join(two, ".git"), link, "file");
      linked = true;
    } catch {
      // Windows without Developer Mode may disallow file symlinks.
    }
    if (linked) {
      expect(worktreeAdminDir(common, one)).toBe(path.join(common, "worktrees", "one"));
    }
  });

  it("reads a relative gitdir (worktree.useRelativePaths) from the worktree's folder in .git", () => {
    const { common, add } = setup();
    const one = add("one");
    const admin = path.join(common, "worktrees", "one");
    writeFileSync(path.join(admin, "gitdir"), `${path.relative(admin, path.join(one, ".git")).replaceAll("\\", "/")}\n`);
    expect(worktreeAdminDir(common, one)).toBe(admin);
  });
});
