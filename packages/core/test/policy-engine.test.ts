import { realpathSync } from "node:fs";
import path from "node:path";
import type { PolicyRule, TaskGrant } from "@aria/protocol";
import { describe, expect, it } from "vitest";
import { ghConfigFile, gitSplit, parseGhAliases, shlexSplit } from "../src/policy/aliases.ts";
import { canonicalPath, commandIdentity, parseCommand, ruleMatches, ruleShape } from "../src/policy/command.ts";
import { DEFAULT_RULES } from "../src/policy/defaults.ts";
import { decideWorker, type WorkerPolicyContext } from "../src/policy/worker.ts";
import type { PermissionAsk } from "../src/runtime/types.ts";

const WT = "C:\\wt\\moonrise\\fix-login";

const shell = (command: string, extra: Partial<Extract<PermissionAsk, { kind: "shell" }>> = {}): PermissionAsk => ({
  kind: "shell",
  command,
  segments: command.split(/\s*(?:\||;|&&)\s*/).filter(Boolean),
  cwd: WT,
  possiblePaths: [],
  possibleUrls: [],
  ...extra,
});

const ctx = (extra: Partial<WorkerPolicyContext> = {}): WorkerPolicyContext => ({
  worktree: WT,
  sandboxed: true,
  readTools: new Set(["github-get_issue"]),
  rules: DEFAULT_RULES,
  grants: [],
  defaultBranch: "main",
  ...extra,
});

const effect = (ask: PermissionAsk, extra: Partial<WorkerPolicyContext> = {}) => decideWorker(ask, ctx(extra)).effect;

/** "Approve for this task" on the card for this request (D21). */
function grantsFor(ask: PermissionAsk, extra: Partial<WorkerPolicyContext> = {}): TaskGrant[] {
  const decision = decideWorker(ask, ctx(extra));
  if (decision.effect !== "ask") throw new Error(`expected ask, got ${decision.effect}`);
  return decision.request.grants.map((g, i) => ({ ...g, id: `g${i}`, at: 0 }));
}

describe("parseCommand", () => {
  it.each([
    ["git push origin aria/x", { program: "git", words: ["push"], values: ["origin", "aria/x"] }],
    ["git -C ../other push", { program: "git", words: ["push"], options: ["-C", "../other"] }],
    ["& 'C:\\Program Files\\Git\\cmd\\git.exe' status", { program: "git", words: ["status"] }],
    ["rm -r build", { program: "remove-item", cmdlet: true, options: ["-r"], values: ["build"] }],
    ["dotnet add package Foo --version 1.2", { program: "dotnet", words: ["add", "package"], values: ["Foo", "1.2"] }],
    ["npm.cmd install lodash", { program: "npm", words: ["install"], values: ["lodash"] }],
    ["npm test -- --watch=false", { program: "npm", words: ["test"], values: ["--watch=false"] }],
  ])("`%s`", (segment, expected) => {
    expect(parseCommand(segment)).toMatchObject(expected);
  });
});

describe("rules", () => {
  const matches = (rule: string, segment: string) => ruleMatches(ruleShape(rule)!, parseCommand(segment)!);
  it.each([
    ["npm install <package>", "npm install lodash", true],
    ["npm install <package>", "npm install", false],
    ["npm install <package>", "npm install --no-audit", false],
    ["npm i <package>", "npm i -D lodash", true],
    ["git push", "git push", true],
    ["git push", "git log --grep push", false],
    ["git push", "git -c user.name=x push origin", true],
    ["git clean -f", "git clean -fdx", true],
    ["git clean -f", "git clean -n", false],
    ["git reset --hard", "git reset --hard HEAD~1", true],
    ["git reset --hard", "git reset --soft HEAD~1", false],
    ["Remove-Item -Recurse", "Remove-Item -r build", true],
    ["Remove-Item -Recurse", "rm -Recurse build", true],
    ["Remove-Item -Recurse", "del -rec build", true],
    ["Remove-Item -Recurse", "Remove-Item build", false],
    ["dotnet add package", "dotnet add package Foo", true],
    ["dotnet add package", "dotnet add reference ../x.csproj", false],
    ["dotnet add <project> package", "dotnet add App.csproj package Dapper", true],
    ["dotnet add <project> package", "dotnet add package Dapper", false],
    ["git push --force", "git push --force-with-lease origin x", true],
    ["del /s", "del /S *.tmp", true],
  ])("`%s` vs `%s` → %s", (rule, segment, expected) => {
    expect(matches(rule, segment)).toBe(expected);
  });

  it("identifies a command by its exact text and the folder it runs in", () => {
    const id = (command: string, cwd = WT) => commandIdentity(parseCommand(command)!, cwd);
    expect(id("npm install lodash -D")).toEqual({ key: JSON.stringify("npm install lodash -D"), target: canonicalPath(WT, WT) });
    expect(id("  npm install lodash  ")).toEqual(id("npm install lodash"));
    // Which option a value belongs to counts (it says what gets deleted), and so does letter case.
    expect(id("Remove-Item -Recurse -Path scratch -Exclude source")).not.toEqual(id("Remove-Item -Recurse -Exclude scratch -Path source"));
    expect(id("git branch -d aria/x")).not.toEqual(id("git branch -D aria/x"));
    expect(id("git reset --hard", WT)).not.toEqual(id("git reset --hard", "C:\\Users\\me\\repo"));
    // Nothing is read as a path: what looks like one can be code.
    expect(id(`node -e "console.log('SAFE')//../console.log('DIFFERENT')"`)).not.toEqual(id(`node -e "console.log('DIFFERENT')//."`));
    expect(id("Remove-Item -Recurse .\\dist\\temp")).not.toEqual(id("Remove-Item -Recurse dist/temp"));
    // The program as typed: a script next to it isn't the program.
    expect(id("& 'C:\\Program Files\\nodejs\\node.exe' --version")).not.toEqual(id("& '.\\node.cmd' --version"));
    // Quotes stay: '$(x)' is text, "$(x)" runs x. A line break can end a comment where a space doesn't.
    expect(id("cmd /c 'echo $(Remove-Item -Recurse src)'")).not.toEqual(id('cmd /c "echo $(Remove-Item -Recurse src)"'));
    expect(id("ForEach-Object { [Console]::WriteLine('FIRST') # note [Console]::WriteLine('SECOND') }")).not.toEqual(
      id("ForEach-Object { [Console]::WriteLine('FIRST') # note\n[Console]::WriteLine('SECOND') }"),
    );
    expect(id("npm  install lodash")).not.toEqual(id("npm install lodash"));
  });

  it("reads arguments the way PowerShell passes them: quotes removed, backtick escapes decoded", () => {
    expect(parseCommand("g`it pu`sh origin HEAD:main")).toMatchObject({ program: "git", words: ["push"], values: ["origin", "HEAD:main"] });
    expect(parseCommand("git 'push' \"or`igin\" 'HEAD:ma`in'")).toMatchObject({ program: "git", words: ["push"], values: ["origin", "HEAD:ma`in"] });
    expect(parseCommand("Write-Output a` b `nc")).toMatchObject({ args: ["a b", "\nc"] });
  });
});

describe("gh aliases", () => {
  it("reads the aliases block gh writes, with names of several words, quoted values and block scalars", () => {
    const yaml = [
      "# What protocol to use when performing git operations.",
      "git_protocol: https",
      "# Aliases allow you to create nicknames for gh commands",
      "aliases:",
      "    co: pr checkout",
      "    pr finish: pr merge",
      "    'its': 'issue list --search ''is:open'''",
      '    ship: "!gh pr merge --auto \\"$1\\""',
      "    long: |-",
      "        !f() {",
      "          gh pr merge $1",
      "        }; f",
      "# The path to a unix socket",
      "http_unix_socket:",
    ].join("\n");
    expect([...parseGhAliases(yaml)!]).toEqual([
      ["co", "pr checkout"],
      ["pr finish", "pr merge"],
      ["its", "issue list --search 'is:open'"],
      ["ship", '!gh pr merge --auto "$1"'],
      ["long", "!f() {\ngh pr merge $1\n}; f"],
    ]);
    expect(parseGhAliases("version: 1\naliases: {}\n")).toEqual(new Map());
    expect(parseGhAliases("version: 1\n")).toEqual(new Map());
    expect(parseGhAliases("\uFEFFaliases:\n    pr finish: pr merge\n")).toEqual(new Map([["pr finish", "pr merge"]]));
    expect(parseGhAliases('"aliases":\n    pr finish: pr merge\n')).toEqual(new Map([["pr finish", "pr merge"]]));
    // Anything else isn't guessed at.
    expect(parseGhAliases("aliases: {co: pr merge}\n")).toBeUndefined();
    expect(parseGhAliases("aliases:\n    - co\n")).toBeUndefined();
    expect(parseGhAliases('{"version": "1", "aliases": {"pr finish": "pr merge"}}')).toBeUndefined();
    expect(parseGhAliases("aliases:\n    co: pr checkout\nversion: 1\naliases:\n    co: pr merge\n")).toBeUndefined();
    expect(parseGhAliases("aliases:\n    co: pr checkout\nversion: 1\naliases:\n    x: pr merge\n")).toBeUndefined();
    // Keys and values YAML reads as something else than they're written aren't guessed at.
    expect(parseGhAliases('{"version":"1","ali\\u0061ses":{"pr finish":"pr merge"}}')).toBeUndefined();
    expect(parseGhAliases('"ali\\u0061ses":\n    pr finish: pr merge\n')).toBeUndefined();
    expect(parseGhAliases("---\naliases:\n    co: pr merge\n")).toBeUndefined();
    expect(parseGhAliases("  aliases:\n      co: pr merge\n")).toBeUndefined();
    expect(parseGhAliases("&a aliases:\n    co: pr merge\n")).toBeUndefined();
    expect(parseGhAliases("aliases:\n    &a pr finish: pr merge\n")).toBeUndefined();
    expect(parseGhAliases("aliases:\n    x: !!str |\n        pr merge --subject=a: b\n")).toBeUndefined();
    expect(parseGhAliases("aliases:\n    x: *anchor\n")).toBeUndefined();
    expect(parseGhAliases("aliases:\n    x: [pr, merge]\n")).toBeUndefined();
    expect(parseGhAliases("aliases:\n    ? pr finish\n    : pr merge\n")).toBeUndefined();
    // Two of the same name: gh uses one of them.
    expect(parseGhAliases("aliases:\n    pr finish: pr merge\n    pr finish: pr view\n")).toBeUndefined();
    expect(parseGhAliases("aliases:\n    pr finish: pr merge\n    'pr finish': pr view\n")).toBeUndefined();
    // What gh itself writes.
    expect([
      ...parseGhAliases(
        [
          "version: 1",
          "aliases:",
          "    co: pr checkout",
          "    sx: '!gh pr list --json number | jq ''.[]'''",
          "    pr fin: pr view",
          '    mine: issue list --assignee "@me"',
          "    multi: |-",
          "        !echo one",
          "        echo two",
          "# The path to a unix socket",
          "http_unix_socket:",
        ].join("\r\n"),
      )!,
    ]).toEqual([
      ["co", "pr checkout"],
      ["sx", "!gh pr list --json number | jq '.[]'"],
      ["pr fin", "pr view"],
      ["mine", 'issue list --assignee "@me"'],
      ["multi", "!echo one\necho two"],
    ]);
  });

  it("finds gh's config where gh does", () => {
    expect(ghConfigFile({ GH_CONFIG_DIR: "C:\\gh", XDG_CONFIG_HOME: "C:\\xdg", APPDATA: "C:\\AppData" })).toBe(path.join("C:\\gh", "config.yml"));
    expect(ghConfigFile({ XDG_CONFIG_HOME: "C:\\xdg", APPDATA: "C:\\AppData" })).toBe(path.join("C:\\xdg", "gh", "config.yml"));
    if (process.platform === "win32") expect(ghConfigFile({ APPDATA: "C:\\AppData" })).toBe(path.join("C:\\AppData", "GitHub CLI", "config.yml"));
  });

  it.each([
    ["push origin", ["push", "origin"]],
    ["pu\\sh", ["push"]],
    ["'pu\\sh' \"a b\" c\\ d", ["pu\\sh", "a b", "c d"]],
    ["'push", undefined],
    ["push\\", undefined],
  ])("git splits `%s` like git", (text, expected) => {
    expect(gitSplit(text)).toEqual(expected);
  });

  it.each([
    ["pr merge --auto", ["pr", "merge", "--auto"]],
    ["pr mer\\ge 'a b' \"c \\\"d\\\"\"", ["pr", "merge", "a b", 'c "d"']],
    ["pr list # a comment", ["pr", "list"]],
    ["pr 'merge", undefined],
  ])("gh splits `%s` like gh", (text, expected) => {
    expect(shlexSplit(text)).toEqual(expected);
  });
});

describe("decideWorker, sandboxed (D20)", () => {
  it.each([
    ["node scripts/build.js", "auto"],
    ["npm test", "auto"],
    ["npx vitest run", "auto"],
    ["curl https://example.com", "auto"],
    ["npm ci", "auto"],
    ["npm install", "auto"],
    ["npm install lodash", "ask"],
    ["npm ci; npm install lodash", "ask"],
    ["git reset --hard HEAD~1", "ask"],
    ["git clean -fdx", "ask"],
    ["rm -r dist", "ask"],
    ["git push", "never"],
    ["git push origin aria/fix-login", "never"],
    ["gh pr merge 3", "never"],
    ["gh -R owner/repo pr merge 3", "never"],
    ['cmd /c "git push origin aria/fix-login"', "never"],
    // Other programs that run a push or a merge given as text.
    [`node -e "require('child_process').execSync('git push origin aria/fix-login')"`, "never"],
    [`python -c "import os; os.system('gh pr merge 3')"`, "never"],
    ["npx -y some-tool git push origin aria/fix-login", "never"],
    ["gh issue list", "auto"],
    ["gh -R owner/repo issue list", "auto"],
    ["dotnet add package Dapper", "ask"],
    ["dotnet add App.csproj package Dapper", "ask"],
  ] as const)("`%s` → %s", (command, expected) => {
    expect(effect(shell(command))).toBe(expected);
  });

  it("says why on the card and what Approve for this task covers", () => {
    const decision = decideWorker(shell("npm install lodash", { intention: "Add lodash for the debounce" }), ctx());
    expect(decision).toMatchObject({
      effect: "ask",
      request: { kind: "shell", what: "npm install lodash", why: "Add lodash for the debounce", reason: expect.stringContaining("Adds a package"), scope: "run npm install lodash" },
    });
    // Where it runs only shows when that isn't the task's own worktree.
    expect(decision.effect === "ask" && decision.request.where).toBeUndefined();
    const elsewhere = decideWorker(shell("npm install lodash", { cwd: `${WT}\\packages\\app` }), ctx());
    expect(elsewhere.effect === "ask" && elsewhere.request.where).toBe(`${WT}\\packages\\app`);
    const push = decideWorker(shell("git push"), ctx());
    expect(push.effect === "never" && push.reason).toMatch(/ARIA pushes the branch/);
  });

  it("keeps files to the worktree and never touches its .git link", () => {
    expect(effect({ kind: "read", path: `${WT}\\src\\a.ts` })).toBe("auto");
    expect(effect({ kind: "write", path: `${WT}\\src\\a.ts` })).toBe("auto");
    expect(effect({ kind: "write", path: "C:\\Users\\me\\notes.txt" })).toBe("never");
    expect(effect({ kind: "read", path: "C:\\Users\\me\\.npmrc" })).toBe("never");
    expect(effect({ kind: "write", path: `${WT}\\.git` })).toBe("never");
    expect(effect({ kind: "url", url: "https://example.com" })).toBe("never");

    const sessionDir = "C:\\Users\\me\\.copilot\\session-state\\aria-task-1";
    expect(effect({ kind: "write", path: `${sessionDir}\\plan.md` }, { sessionDir })).toBe("auto");
    expect(effect({ kind: "read", path: `${sessionDir}\\plan.md` }, { sessionDir })).toBe("auto");
    expect(effect({ kind: "write", path: ".git" }, { sessionDir })).toBe("never");
    expect(effect({ kind: "write", path: `${WT}\\.git` }, { sessionDir })).toBe("never");
  });

  it("turns sandbox boundary blocks into narrow, repeatable permission requests", () => {
    const read: PermissionAsk = { kind: "read", path: path.resolve("package.json"), sandboxBlock: true };
    const decision = decideWorker(read, ctx());
    expect(decision).toMatchObject({
      effect: "ask",
      request: {
        sandbox: { access: "read", target: canonicalPath(realpathSync.native(path.resolve("package.json")), WT), persistent: "path" },
      },
    });
    const grants = grantsFor(read);
    expect(effect(read, { grants })).toBe("auto");
    expect(effect({ ...read, path: path.resolve("README.md") }, { grants })).toBe("ask");

    const url: PermissionAsk = { kind: "url", url: "https://docs.example.com/guide", sandboxBlock: true };
    expect(decideWorker(url, ctx())).toMatchObject({
      effect: "ask",
      request: { sandbox: { access: "network", target: "docs.example.com", persistent: "host" } },
    });
    const urlGrants = grantsFor(url);
    expect(effect(url, { grants: urlGrants })).toBe("auto");
    expect(effect({ ...url, url: "https://other.example.com/" }, { grants: urlGrants })).toBe("ask");
    expect(effect(read, { protectedDirs: [path.dirname(path.resolve("package.json"))] })).toBe("never");
  });

  it("a sandbox block cannot bypass a Never rule or make destructive commands repeatable", () => {
    const command = shell("curl https://example.com", { sandboxBlock: true });
    const rules: PolicyRule[] = [...DEFAULT_RULES, { id: "never-curl", match: "curl", effect: "never" }];
    expect(effect(command, { rules })).toBe("never");
    const destructive = shell("Remove-Item -Recurse .\\dist", { sandboxBlock: true });
    expect(decideWorker(destructive, ctx())).toMatchObject({ effect: "ask", request: { everyTime: true, grants: [] } });
  });

  it("allows the task's MCP read tools and nothing else", () => {
    expect(effect({ kind: "mcp", server: "github", tool: "github-get_issue", args: {} })).toBe("auto");
    expect(effect({ kind: "mcp", server: "Acme", tool: "Acme-create_issues", args: {} })).toBe("never");
    expect(effect({ kind: "custom-tool", tool: "anything" })).toBe("auto");
    expect(effect({ kind: "other", detail: "memory" })).toBe("never");
  });

  it("follows your rules: the most specific wins, the strictest among equals", () => {
    const rules: PolicyRule[] = [...DEFAULT_RULES, { id: "a", match: "curl", effect: "never" }, { id: "b", match: "npm install -D <package>", effect: "auto" }];
    expect(effect(shell("curl https://example.com"), { rules })).toBe("never");
    expect(effect(shell("npm install -D lodash"), { rules })).toBe("auto");
    expect(effect(shell("npm install lodash"), { rules })).toBe("ask");
    const tie: PolicyRule[] = [...DEFAULT_RULES, { id: "c", match: "npm install <package>", effect: "auto" }];
    expect(effect(shell("npm install lodash"), { rules: tie })).toBe("ask");
    expect(effect(shell("npm install lodash"), { rules: [] })).toBe("auto");
  });

  it("Approve for this task covers the same command in the same folder, and nothing else (D21)", () => {
    const grants = grantsFor(shell("npm install lodash"));
    expect(grants).toEqual([{ id: "g0", key: JSON.stringify("npm install lodash"), target: canonicalPath(WT, WT), label: "npm install lodash", at: 0 }]);
    expect(effect(shell("npm install lodash"), { grants })).toBe("auto");
    expect(effect(shell("npm  install  lodash"), { grants })).toBe("ask");
    expect(effect(shell("npm install react"), { grants })).toBe("ask");
    expect(effect(shell("npm install lodash --save-dev"), { grants })).toBe("ask");
    expect(effect(shell("npm install lodash", { cwd: `${WT}\\packages\\app` }), { grants })).toBe("ask");
    // The same words with the values swapped between options delete something else.
    const removing: PolicyRule[] = [...DEFAULT_RULES, { id: "ri", match: "Remove-Item", effect: "ask" }];
    const scratch = grantsFor(shell("Remove-Item -Path scratch -Exclude source"), { rules: removing });
    expect(effect(shell("Remove-Item -Path scratch -Exclude source"), { rules: removing, grants: scratch })).toBe("auto");
    expect(effect(shell("Remove-Item -Exclude scratch -Path source"), { rules: removing, grants: scratch })).toBe("ask");
    // A destructive command asks every time (D29): there's nothing to approve for the task.
    expect(decideWorker(shell("Remove-Item -Recurse .\\dist\\temp"), ctx())).toMatchObject({ effect: "ask", request: { everyTime: true, grants: [] } });
  });
});

describe("decideWorker, not sandboxed", () => {
  const open = { sandboxed: false };
  it.each([
    ["npm test", "auto"],
    ["git status --short", "auto"],
    ["npm ci", "auto"],
    ["node scripts/build.js", "ask"],
    ["npm run build '--prefix=..'", "ask"],
    ["Get-Content ..\\secrets.txt", "ask"],
    ["git push origin aria/fix-login", "ask"],
    ["git push -u origin aria/fix-login", "ask"],
    ["git push --force-with-lease --progress origin aria/fix-login", "ask"],
    ["git push", "ask"],
    ["git reset --hard", "ask"],
    // never, whatever you approve
    ["git push origin main", "never"],
    ["git push origin HEAD:refs/heads/main", "never"],
    ["git push origin HEAD:heads/main", "never"],
    ["git push origin +aria/x:main", "never"],
    ["git push --repo=origin HEAD:main", "never"],
    ["git push origin :aria/old", "never"],
    ["git push --repo=origin :aria/old", "never"],
    ["git push origin 'refs/heads/*:refs/heads/*'", "never"],
    ["git push --delete origin aria/old", "never"],
    ["git push --del origin aria/old", "never"],
    ["git push -d origin aria/old", "never"],
    ["git push --mirror origin", "never"],
    ["git push --all origin", "never"],
    ["git push --branches origin", "never"],
    ["git -c remote.origin.mirror=true push origin", "never"],
    ["git -C ..\\other push origin aria/x", "never"],
    ["gh pr merge 3 --squash", "never"],
    ["gh -R owner/repo pr merge 3", "never"],
    ["gh --repo owner/repo pr merge 3", "never"],
    // Through an alias or another program
    ["git -c alias.publish=push publish origin HEAD:main", "never"],
    ["git -c alias.st=status st", "never"],
    ['cmd /c "git push origin HEAD:main"', "never"],
    ['pwsh -NoProfile -Command "gh pr merge 3"', "never"],
    ["Start-Process git -ArgumentList 'push','origin','aria/x'", "never"],
    ["gh m 3", "never"],
    ["gh api -X PUT repos/o/r/pulls/3/merge", "never"],
  ] as const)("`%s` → %s", (command, expected) => {
    expect(effect(shell(command), open)).toBe(expected);
  });

  it("reads your git aliases: an alias for push is a push", () => {
    const gitAliases = new Map([
      ["p", "push"],
      ["ship", "!git push origin HEAD:main"],
      ["st", "status --short"],
      ["first", "second -q"],
      ["second", "push"],
      ["g", "!git"],
      ["loop-a", "loop-b"],
      ["loop-b", "loop-a"],
      ["multi", "!f(){\n  git push origin HEAD:main\n}; f"],
    ]);
    expect(effect(shell("git p origin HEAD:main"), { ...open, gitAliases })).toBe("never");
    expect(effect(shell("git p --delete origin aria/old"), { ...open, gitAliases })).toBe("never");
    expect(effect(shell("git p origin aria/fix-login"), { ...open, gitAliases })).toBe("ask");
    expect(effect(shell("git 'p' origin HEAD:main"), { ...open, gitAliases })).toBe("never");
    expect(effect(shell("git -C . p origin HEAD:main"), { ...open, gitAliases })).toBe("never");
    expect(effect(shell("git first origin HEAD:main"), { ...open, gitAliases })).toBe("never");
    expect(effect(shell("git ship"), { ...open, gitAliases })).toBe("never");
    expect(effect(shell("git g push origin HEAD:main"), { ...open, gitAliases })).toBe("never");
    expect(effect(shell("git multi"), { ...open, gitAliases })).toBe("never");
    expect(effect(shell("git loop-a"), { ...open, gitAliases })).toBe("never");
    expect(effect(shell("git p origin aria/fix-login"), { gitAliases })).toBe("never");
    expect(effect(shell("git st"), { gitAliases })).toBe("auto");
    expect(effect(shell('git commit -m "fix the push button"'), { gitAliases })).toBe("auto");
  });

  it("reads gh's aliases, of one word or several, and refuses gh commands when they can't be read", () => {
    const ghAliases = new Map([
      ["pr finish", "pr merge"],
      ["co", "pr merge"],
      ["ship", "!gh pr merge $1"],
      ["mine", "issue list --assignee @me"],
    ]);
    expect(effect(shell("gh pr finish 3"), { ...open, ghAliases })).toBe("never");
    expect(effect(shell("gh co 3"), { ...open, ghAliases })).toBe("never");
    expect(effect(shell("gh ship 3"), { ...open, ghAliases })).toBe("never");
    expect(effect(shell("gh mine"), { ghAliases })).toBe("auto");
    // Without a config file, gh's own `co` checks out a pull request.
    expect(effect(shell("gh co 3"))).toBe("auto");
    expect(effect(shell("gh issue list"), { ghAliases: null })).toBe("never");
  });

  it("sees through escapes and programs written as expressions", () => {
    expect(effect(shell("g`it pu`sh origin HEAD:main"), open)).toBe("never");
    expect(effect(shell("g`it pu`sh origin aria/x"))).toBe("never");
    expect(effect(shell("& ('g'+'it') push origin HEAD:main"), open)).toBe("never");
    expect(effect(shell("& ('g'+'it') status"))).toBe("auto");
  });

  it("checks settings an alias adds, and knows git's own commands from other programs and other repositories", () => {
    // The alias defines another alias and runs it in the same call.
    const nested = new Map([["reviewouter", "-c alias.reviewship=push reviewship"]]);
    expect(effect(shell("git reviewouter origin HEAD:main"), { gitAliases: nested })).toBe("never");
    expect(effect(shell("git reviewouter origin HEAD:main"), { ...open, gitAliases: nested })).toBe("never");
    // The setting overrides an alias ARIA read as harmless (with a value that doesn't say push).
    const overriding = new Map([
      ["outer", "-c 'alias.st=!git p' st"],
      ["st", "status"],
      ["p", "push"],
    ]);
    expect(effect(shell("git outer origin HEAD:main"), { ...open, gitAliases: overriding })).toBe("never");
    // A word that isn't one of git's commands: a git-<word> program on PATH, which git runs before an alias.
    expect(effect(shell("git flow release finish -p v1"), { gitExternals: new Set(["flow"]) })).toBe("never");
    expect(effect(shell("git flow release finish"), { gitAliases: new Map([["flow", "status"]]), gitExternals: new Set(["flow"]) })).toBe("never");
    expect(effect(shell("git st"), { gitAliases: new Map([["st", "status"]]), gitExternals: null })).toBe("never");
    expect(effect(shell("git frobnicate"))).toBe("never");
    expect(effect(shell("git st"), { gitAliases: new Map([["st", "status"]]), gitExternals: new Set(["flow"]) })).toBe("auto");
    expect(effect(shell("git lfs pull"))).toBe("auto");
    // In another repository, its own aliases count, which ARIA didn't read.
    expect(effect(shell("git -C ..\\other st"), { gitAliases: new Map([["st", "status"]]) })).toBe("never");
    expect(effect(shell("git -C src status"))).toBe("auto");
  });

  it("refuses a push or a merge in a command git runs for you", () => {
    for (const command of [
      "git rebase -x 'git push origin HEAD:main' main",
      "git rebase --exec='gh pr merge 3' main",
      "git rebase -ix 'git push origin HEAD:main' main",
      "git bisect run sh -c 'git push origin HEAD:main'",
      "git submodule foreach 'git push origin HEAD:main'",
      "git filter-branch --tree-filter 'git push origin HEAD:main'",
      "git difftool -x 'gh pr merge 3'",
      "git -c core.editor=\"sh -c 'git push origin HEAD:main'\" commit",
    ]) {
      expect(effect(shell(command), open), command).toBe("never");
    }
    expect(effect(shell("git rebase -x 'npm test' main"))).toBe("auto");
    expect(effect(shell("git -c merge.conflictstyle=diff3 merge feature"))).toBe("auto");
    // git takes an option by any start of its name, and for-each-repo runs a command in other repositories.
    for (const command of [
      "git rebase --ex 'git push origin HEAD:main' main",
      "git rebase --exe='gh pr merge 3' main",
      "git difftool --ext 'gh pr merge 3'",
      "git remote add --mir=push backup https://example.com/r.git",
      "git for-each-repo --config=maintenance.repo push origin HEAD:main",
      "git for-each-repo --config=maintenance.repo status",
    ]) {
      expect(effect(shell(command)), command).toBe("never");
    }
  });

  it("applies your rules to both ways PowerShell may pass a command", () => {
    // PowerShell 7 passes the empty namespace on: this is a reset --hard. Windows PowerShell 5.1 would make `reset` the namespace.
    const rules: PolicyRule[] = [...DEFAULT_RULES, { id: "g", match: "git", effect: "auto" }, { id: "r", match: "git reset --hard", effect: "never" }];
    expect(effect(shell("git reset --hard HEAD"), { ...open, rules })).toBe("never");
    expect(effect(shell("git --namespace '' reset --hard HEAD"), { ...open, rules })).toBe("never");
    // The same for any program: PowerShell 7 makes this `npm run deploy`, 5.1 `npm deploy` (-w takes `run`).
    const npmRules: PolicyRule[] = [...DEFAULT_RULES, { id: "n", match: "npm", effect: "auto" }, { id: "d", match: "npm run deploy", effect: "never" }];
    expect(effect(shell("npm -w '' run deploy"), { ...open, rules: npmRules })).toBe("never");
    expect(effect(shell("npm -w '' run deploy"), { rules: npmRules })).toBe("never");
    // An Auto rule counts only when it allows both readings: 5.1 reads `npm build` here (-w takes `run`), 7 `npm run build`.
    const autoBuild: PolicyRule[] = [...DEFAULT_RULES, { id: "b", match: "npm build", effect: "auto" }];
    expect(effect(shell("npm -w '' run build"), { ...open, rules: autoBuild })).toBe("ask");
  });

  it("refuses a push or a merge run through a shell, and aliases or functions for git defined in the command", () => {
    expect(effect(shell('cmd /c "g^it pu^sh origin HEAD:main"'), open)).toBe("never");
    expect(effect(shell("iex ('g'+'it push origin HEAD:main')"), open)).toBe("never");
    expect(effect(shell('pwsh -NoProfile -Command "npm run build"'))).toBe("auto");
    expect(effect(shell("Set-Alias g git"), open)).toBe("never");
    expect(effect(shell("function g { git @args }"), open)).toBe("never");
    expect(effect(shell("Set-Alias ll Get-ChildItem"))).toBe("auto");
    // A program that isn't a shell may mention push for its own reasons.
    expect(effect(shell('node -e "console.log([].push(1))"'))).toBe("auto");
  });

  it("knows a push of HEAD, or without a destination, pushes the branch that's checked out", () => {
    const onMain = { ...open, checkedOut: "main" };
    expect(effect(shell("git push origin HEAD"), onMain)).toBe("never");
    expect(effect(shell("git push"), onMain)).toBe("never");
    expect(effect(shell("git push origin"), onMain)).toBe("never");
    // A repository given as a URL isn't a refspec, although it has a colon.
    expect(effect(shell("git push https://github.com/owner/repo.git"), onMain)).toBe("never");
    expect(effect(shell("git push git@github.com:owner/repo.git"), onMain)).toBe("never");
    expect(effect(shell("git push --repo=origin HEAD"), onMain)).toBe("never");
    // An argument overrides --repo= (git reads it as the repository).
    expect(effect(shell("git push --repo=elsewhere origin"), onMain)).toBe("never");
    // Values of push's own options aren't the repository.
    expect(effect(shell("git push --repo origin"), onMain)).toBe("never");
    expect(effect(shell("git push --repo origin upstream"), onMain)).toBe("never");
    expect(effect(shell("git push -o ci.skip origin"), onMain)).toBe("never");
    expect(effect(shell("git push origin -vo ci.skip"), onMain)).toBe("never");
    expect(effect(shell("git push --push-opt ci.skip origin"), onMain)).toBe("never");
    expect(effect(shell("git push --recurse-submodules check origin"), onMain)).toBe("never");
    expect(effect(shell("git push --receive-pack git-receive-pack origin"), onMain)).toBe("never");
    expect(effect(shell("git push -ofoo origin aria/fix-login"), onMain)).toBe("ask");
    expect(effect(shell("git push -o ci.skip origin aria/fix-login"), onMain)).toBe("ask");
    expect(effect(shell("git push -- origin aria/fix-login"), onMain)).toBe("ask");
    expect(effect(shell("git push https://github.com/owner/repo.git aria/fix-login"), onMain)).toBe("ask");
    expect(effect(shell("git push origin HEAD:aria/fix-login"), onMain)).toBe("ask");
    expect(effect(shell("git push origin HEAD"), { ...open, checkedOut: "aria/fix-login" })).toBe("ask");
  });

  it("reads git and gh aliases with git's and gh's own rules", () => {
    const gitAliases = new Map([
      ["p", "pu\\sh"],
      ["bad", "'push"],
      ["x", "!git pu\\sh origin HEAD:main"],
    ]);
    expect(effect(shell("git p origin HEAD:main"), { ...open, gitAliases })).toBe("never");
    expect(effect(shell("git p origin aria/x"), { gitAliases })).toBe("never");
    expect(effect(shell("git bad origin"), { ...open, gitAliases })).toBe("never");
    expect(effect(shell("git x"), { ...open, gitAliases })).toBe("never");
    expect(effect(shell("git -C..\\Other push origin HEAD:master"), open)).toBe("never");
    const ghAliases = new Map([
      ["x", "pr $1"],
      ["y", "pr $1 $2"],
      ["z", "!gh pr mer\\ge $1"],
      ["mine", "issue list --assignee $1"],
      ["do", "$1"],
      ["w", "issue $1 $2"],
    ]);
    expect(effect(shell("gh x merge 3"), { ...open, ghAliases })).toBe("never");
    expect(effect(shell("gh y merge"), { ...open, ghAliases })).toBe("never");
    expect(effect(shell("gh z 3"), { ...open, ghAliases })).toBe("never");
    expect(effect(shell("gh mine '@me'"), { ghAliases })).toBe("auto");
    // Unquoted, PowerShell splats a variable `$me` there.
    expect(effect(shell("gh mine @me"), { ghAliases })).toBe("never");
    // Like gh: the arguments left once the placeholders are filled go at the end.
    expect(effect(shell("gh do pr merge 3"), { ...open, ghAliases })).toBe("never");
    expect(effect(shell("gh w list"), { ...open, ghAliases })).toBe("never");
  });

  it("follows only the gh aliases gh itself uses", () => {
    // gh ignores an alias with the name of one of its commands or subcommands, or nested under anything else.
    const shadowing = new Map([
      ["pr", "issue"],
      ["pr merge", "pr view"],
      ["co x", "issue list"],
    ]);
    expect(effect(shell("gh pr merge 3"), { ...open, ghAliases: shadowing })).toBe("never");
    expect(effect(shell("gh pr merge 3"), { ...open, ghAliases: new Map([["pr", "issue"]]) })).toBe("never");
    expect(effect(shell("gh co x"), { ...open, ghAliases: shadowing })).toBe("never");
    // `co x` isn't under one of gh's commands, so gh runs the alias co.
    expect(effect(shell("gh co x"), { ghAliases: new Map([["co", "pr view"], ["co x", "pr merge"]]) })).toBe("auto");
    expect(effect(shell("gh pr view 3"), { ghAliases: shadowing })).toBe("auto");
    expect(parseGhAliases("aliases:\n    \"pr 'fin ish'\": pr merge\n")).toBeUndefined();
    expect(parseGhAliases("aliases:\n    'pr fin\\ish': pr merge\n")).toBeUndefined();
    expect(parseGhAliases("aliases:\n    'it''s': pr merge\n")).toBeUndefined();
  });

  it("reads push's options the way git does, also when a value looks like the end of the options", () => {
    // git takes `--` as --repo's value and goes on reading options.
    expect(effect(shell("git push --repo -- --delete origin aria/old"), open)).toBe("never");
    expect(effect(shell("git push -o -- --all origin"), open)).toBe("never");
    expect(effect(shell("git push --repo -- origin :aria/old"), open)).toBe("never");
    expect(effect(shell("git push -- origin aria/fix-login"), open)).toBe("ask");
  });

  it("finds gh's command the way gh does, flags between its words too", () => {
    expect(effect(shell("gh pr -R owner/repo merge 3"), open)).toBe("never");
    expect(effect(shell("gh pr --repo owner/repo merge 3"), open)).toBe("never");
    expect(effect(shell("gh pr --hostname h merge 3"), open)).toBe("never");
    expect(effect(shell("gh pr -R owner/repo view 3"))).toBe("auto");
    expect(effect(shell("gh pr list --state open --limit 5"))).toBe("auto");
    // gh finds `pr merge` here (--subject takes "Ship it"), and merge then reads --subject as its own.
    expect(effect(shell("gh pr --subject 'Ship it' merge 3"), open)).toBe("never");
    // Were --web one of gh pr's switches, this would merge: the reading where unknown flags take no value counts too.
    expect(effect(shell("gh pr --web merge 3"), open)).toBe("never");
    // An alias gets every argument but its own words, flags in front of them too.
    const ghAliases = new Map([
      ["pr finish", "pr merge"],
      ["x", "pr $1"],
    ]);
    expect(effect(shell("gh pr -R owner/repo finish 3"), { ...open, ghAliases })).toBe("never");
    expect(effect(shell("gh -R owner/repo x merge 3"), { ...open, ghAliases })).toBe("never");
    expect(effect(shell("gh x -R owner/repo merge"), { ...open, ghAliases })).toBe("never");
    // gh hands a shell alias those arguments as well: here $2 is "merge".
    expect(effect(shell("gh -R merge s"), { ...open, ghAliases: new Map([["s", '!gh pr "$2" 3']]) })).toBe("never");
  });

  it("knows git's own options that take a value before the command", () => {
    // Their value here is a command's name: git pushes.
    expect(effect(shell("git --shallow-file status push origin HEAD:main"), open)).toBe("never");
    expect(effect(shell("git --attr-source log push origin HEAD:main"), open)).toBe("never");
  });

  it("refuses a git or gh command whose words PowerShell computes when it runs", () => {
    for (const command of [
      'git push origin "HEAD:$branch"',
      "git push origin HEAD:ma$b",
      "git $verb origin HEAD:main",
      "git push origin ('ma'+'in')",
      "git push origin HEAD:x, HEAD:main",
      "git @args",
      "git push --% origin %BRANCH%",
      'gh pr "$(echo merge)" 3',
      "gh pr merge(1) 3",
      'git commit -m "Fix $thing"',
    ]) {
      expect(decideWorker(shell(command), ctx()), command).toMatchObject({ effect: "never", reason: expect.stringMatching(/^ARIA can't tell what this (git|gh) command does/) });
    }
    // Text PowerShell passes as it is.
    expect(effect(shell("git push origin 'HEAD:$branch'"), open)).toBe("ask");
    expect(effect(shell('git commit -m "Fix (closes #12)"'))).toBe("auto");
    expect(effect(shell("git commit -m 'Cost: $5'"))).toBe("auto");
    expect(effect(shell("gh issue list --assignee '@me' --json number,title"))).toBe("auto");
    // The sandbox's Windows PowerShell 5.1 passes 'merge" "3' to gh as "merge" "3".
    expect(effect(shell("gh pr 'merge\" \"3'"))).toBe("never");
    expect(effect(shell("gh pr view '3'"))).toBe("auto");
    expect(effect(shell("gh issue create --title 'Fix \"x\"'"), open)).toBe("ask");
  });

  it("reads comments, redirections and every command of a line the way PowerShell does", () => {
    const onMain = { ...open, checkedOut: "main" };
    // What follows # isn't passed, so these push the branch that's checked out.
    expect(effect(shell("git push origin #aria/fix-login"), onMain)).toBe("never");
    expect(effect(shell("git push origin <#HEAD:aria/x#>"), onMain)).toBe("never");
    expect(effect(shell("git push origin 2>&1"), onMain)).toBe("never");
    expect(effect(shell("git push origin >aria/fix-login"), onMain)).toBe("never");
    expect(effect(shell("git push origin ''"), onMain)).toBe("never");
    // A word that starts with a quote ends with it: two refspecs.
    expect(effect(shell("git push origin 'HEAD:aria/x'main"), open)).toBe("never");
    // Commands the runtime didn't split apart are still seen.
    expect(effect(shell("git log | git push origin HEAD:main", { segments: ["git log | git push origin HEAD:main"] }), open)).toBe("never");
    expect(effect(shell("git status\ngit push origin HEAD:main", { segments: ["git status"] }), open)).toBe("never");
    expect(effect(shell("git status #`\ngit push origin HEAD:main", { segments: ["git status"] }), open)).toBe("never");
    expect(effect(shell("git log --oneline | Select-Object -First 5"))).toBe("auto");
    // The commands inside a script block are read as commands: what the Phase 2 worker ran to test and commit.
    const testAndCommit = 'node test.js; if ($?) { git add math.js test.js; git commit -q -m "Add subtract" -m "Co-authored-by: Copilot <1+Copilot@users.noreply.github.com>"; git log --oneline -2; git status --short }';
    expect(effect(shell(testAndCommit))).toBe("auto");
    expect(effect(shell("if ($?) { git p origin HEAD:main }"), { ...open, gitAliases: new Map([["p", "push"]]) })).toBe("never");
    expect(effect(shell("git status <# what changed #> --short"))).toBe("auto");
    expect(parseCommand("git status; git push")?.unreadable).toBe("it holds more than one command");
    expect(effect(shell("git log | git push origin aria/x", { segments: ["git log | git push origin aria/x"] }), open)).toBe("ask");
  });

  it("follows git's push settings, and doesn't let a command change them", () => {
    const settings = (pushSettings: WorkerPolicyContext["pushSettings"]) => ({ ...open, pushSettings });
    expect(effect(shell("git push origin aria/fix-login"), settings(null))).toBe("never");
    expect(effect(shell("git push origin aria/fix-login"), settings({ refspecs: [], mirror: true }))).toBe("never");
    const mapped = settings({ refspecs: ["refs/heads/aria/fix-login:refs/heads/main"], mirror: false });
    expect(effect(shell("git push origin aria/fix-login"), mapped)).toBe("never");
    expect(effect(shell("git push"), mapped)).toBe("never");
    expect(effect(shell("git push origin aria/fix-login:aria/fix-login"), mapped)).toBe("ask");
    expect(effect(shell("git push"), settings({ refspecs: ["refs/heads/*:refs/heads/*"], mirror: false }))).toBe("never");
    expect(effect(shell("git push origin HEAD"), settings({ refspecs: ["HEAD:refs/for/main"], mirror: false }))).toBe("ask");
    for (const pushDefault of ["matching", "upstream", "tracking", ""]) {
      expect(effect(shell("git push"), settings({ pushDefault, refspecs: [], mirror: false })), pushDefault).toBe("never");
      expect(effect(shell("git push origin HEAD:aria/fix-login"), settings({ pushDefault, refspecs: [], mirror: false }))).toBe("ask");
    }
    expect(effect(shell("git push origin"), settings({ pushDefault: "simple", refspecs: [], mirror: false }))).toBe("ask");
    for (const command of [
      "git config alias.p push",
      "git config --global alias.p push",
      "git config set alias.p push",
      "git config remote.origin.push HEAD:main",
      "git config --add remote.origin.push HEAD:main",
      "git config remote.origin.mirror true",
      "git config push.default upstream",
      "git config branch.aria/x.merge refs/heads/main",
      "git config include.path ../x.cfg",
      "git config --rename-section foo alias",
      "git remote add --mirror=push backup https://example.com/r.git",
    ]) {
      expect(effect(shell(command)), command).toBe("never");
    }
    expect(effect(shell("git config user.name ARIA"), open)).toBe("ask");
    expect(effect(shell("git config --get-regexp alias"))).toBe("auto");
    // git takes an option by any start of its name, and short ones in a cluster.
    for (const command of ["git config --ren unsafe alias", "git config --rename unsafe alias", "git config --ed", "git config -le", "git config unsafe.ship push; git config --ren unsafe alias; git ship origin HEAD:main"]) {
      expect(effect(shell(command), open), command).toBe("never");
    }
    expect(effect(shell("git config -l"))).toBe("auto");
    // Settings for one command that define an alias, include config or change pushes, whatever the command.
    for (const command of [
      "git -c include.path=evil.cfg ship origin HEAD:main",
      "git -c includeIf.onbranch:x.path=evil.cfg status",
      "git -c push.default=matching status",
      "git -c remote.origin.push=HEAD:main fetch",
      "git --config-env=include.path=CFG status",
      "git -cALIAS.st=status st",
    ]) {
      expect(effect(shell(command), open), command).toBe("never");
    }
    expect(effect(shell("git -c user.name=ARIA commit -m x"))).toBe("auto");
    // Pushes that aren't git push.
    for (const command of ["git send-pack origin HEAD:main", "git http-push https://example.com/r.git main", "git subtree push --prefix=docs origin main"]) {
      expect(effect(shell(command), open), command).toBe("never");
    }
    expect(effect(shell("git subtree split --prefix=docs"))).toBe("auto");
  });

  it("doesn't let a command change the environment git and gh read, or push from another folder", () => {
    for (const command of [
      "$env:GIT_CONFIG_COUNT=1",
      "$env:GIT_DIR='..\\other\\.git'",
      "$env:GH_CONFIG_DIR = 'C:\\x'",
      "$env:HOME = 'C:\\x'",
      "Set-Item env:USERPROFILE C:\\x",
      "[Environment]::SetEnvironmentVariable('GIT_DIR', 'x')",
      "cd ..\\other; git push origin HEAD:aria/x",
      "Set-Location .. ; git push origin aria/x",
    ]) {
      expect(effect(shell(command), open), command).toBe("never");
    }
    expect(effect(shell("Get-ChildItem $env:USERPROFILE"), open)).toBe("ask");
    expect(effect(shell("$env:GIT_TERMINAL_PROMPT=0"))).toBe("auto");
    expect(effect(shell("cd src; npm test"))).toBe("auto");
  });

  it("doesn't let gh merge or change branches some other way", () => {
    for (const command of [
      "gh api repos/o/r/merges -f base=main -f head=aria/x",
      "gh api -X PUT repos/o/r/contents/README.md -f message=x -f content=eA==",
      "gh api --method=DELETE repos/o/r/contents/README.md",
      "gh api -XPATCH repos/o/r/git/refs/heads/main -f sha=abc",
      "gh api repos/o/r/git/refs -f ref=refs/heads/main -f sha=abc",
      "gh api -X POST repos/o/r/branches/main/rename -f new_name=old",
      "gh api -X PATCH repos/o/r -f default_branch=aria/x",
      "gh api repos/o/r/merge-upstream -f branch=main",
      "gh api graphql -f query='mutation { mergeBranch(input: {}) { clientMutationId } }'",
      "gh api graphql -F query=@query.graphql",
      "gh api graphql --input body.json",
      "gh extension exec merger",
      "gh repo sync",
      "gh repo edit --default-branch aria/x",
    ]) {
      expect(effect(shell(command), open), command).toBe("never");
    }
    expect(effect(shell("gh api repos/o/r/contents/README.md"))).toBe("auto");
    expect(effect(shell("gh api repos/o/r/pulls/3/merge"))).toBe("auto");
    expect(effect(shell("gh api -X PUT repos/o/r/pulls/3/merge -f merge_method=squash"), open)).toBe("never");
    expect(effect(shell("gh api -X GET repos/o/r/git/refs -f per_page=5"))).toBe("auto");
    expect(effect(shell("gh api graphql -f query='query { viewer { login } }'"))).toBe("auto");
    expect(effect(shell("gh api repos/o/r/issues/3/comments -f body=Thanks"))).toBe("auto");
    // Flags the way gh reads them: in a cluster, with `=`, or in the next argument.
    for (const command of [
      "gh api graphql -iFquery=@q.graphql",
      "gh api graphql -iF query=@q.graphql",
      "gh api graphql -F=query=@q.graphql",
      "gh api graphql --field=query=@q.graphql",
      "gh api graphql --field query=@q.graphql",
      "gh api -iXPUT repos/o/r/contents/README.md -f message=x",
      // GitHub's GraphQL endpoint by its path, and endpoints with percent escapes.
      "gh api /graphql -f query='mutation { mergeBranch(input: {}) { clientMutationId } }'",
      "gh api https://api.github.com/graphql -F query=@q.graphql",
      "gh api -X PUT repos/o/r/%63ontents/README.md -f message=x",
      // A field value that looks like the GraphQL endpoint doesn't make a contents write a query.
      "gh api -X PUT repos/o/r/contents/x -f note=a/graphql -f message=m",
      // A repository's settings from a body ARIA can't read.
      "gh api -X PATCH repos/o/r --input body.json",
      "gh api -X PATCH repos/o/r -F description=@d.txt",
    ]) {
      expect(effect(shell(command), open), command).toBe("never");
    }
    expect(effect(shell("gh api -X PATCH repos/o/r -f description=Tools"))).toBe("never");
    expect(effect(shell("gh api -X PATCH repos/o/r/issues/3 -f title=Tools"))).toBe("auto");
    expect(effect(shell("gh api -i repos/o/r/contents/README.md"))).toBe("auto");
  });

  it("reads an empty argument both ways: left out (Windows PowerShell 5.1) and passed on (PowerShell 7)", () => {
    // 5.1 leaves the empty here-string out, so gh gets `pr merge 3`.
    expect(effect(shell("gh pr @'\n'@ merge 3"), open)).toBe("never");
    expect(effect(shell("gh pr '' merge 3"), open)).toBe("never");
    // 7 passes it on, so the alias's $2 is "merge".
    const ghAliases = new Map([["x", "pr $2 $3"]]);
    expect(effect(shell("gh x '' merge 3 4"), { ...open, ghAliases })).toBe("never");
    expect(effect(shell("gh pr create --title x --body ''"), open)).toBe("ask");
    // For git the empty argument counts too: here 5.1 passes no refspec.
    expect(effect(shell("git push origin @'\n'@"), { ...open, checkedOut: "main" })).toBe("never");
    // gh passes over an empty argument when it looks for its command.
    expect(effect(shell("gh '' pr view 3"))).toBe("auto");
  });

  it("an approval for a command in the worktree doesn't cover it in another folder", () => {
    const grants = grantsFor(shell("node build.js"), open);
    expect(effect(shell("node build.js"), { ...open, grants })).toBe("auto");
    expect(effect(shell("node build.js", { cwd: "C:\\Users\\me\\repo" }), { ...open, grants })).toBe("ask");
    const elsewhere = decideWorker(shell("node build.js", { cwd: "C:\\Users\\me\\repo" }), ctx(open));
    expect(elsewhere.effect === "ask" && elsewhere.request.scope).toBe("run node build.js (in C:\\Users\\me\\repo)");
    // D29: a grant (made before destructive commands asked every time) never covers one.
    const old: TaskGrant[] = [{ id: "g", key: JSON.stringify("git reset --hard"), target: canonicalPath(WT, WT), label: "git reset --hard", at: 0 }];
    expect(effect(shell("git reset --hard"), { ...open, grants: old })).toBe("ask");
    expect(effect(shell("git reset --hard"), { grants: old })).toBe("ask");
  });

  it("explains with the rule's note when there is one, else with the check that failed", () => {
    const reset = decideWorker(shell("git reset --hard"), ctx(open));
    expect(reset.effect === "ask" && reset.request.reason).toBe("Throws away uncommitted work.");
    const node = decideWorker(shell("node x.js"), ctx(open));
    expect(node.effect === "ask" && node.request.reason).toMatch(/^Only tests, builds/);
  });

  it("asks for files outside the worktree, and Approve for this task covers that folder", () => {
    const write = { kind: "write", path: "C:\\work\\shared\\notes.txt" } as const;
    expect(effect(write, open)).toBe("ask");
    const grants = grantsFor(write, open);
    expect(effect({ kind: "write", path: "C:\\Work\\Shared\\other.txt" }, { ...open, grants })).toBe("auto");
    expect(effect({ kind: "write", path: "C:\\work\\shared\\sub\\x.txt" }, { ...open, grants })).toBe("ask");
    expect(effect({ kind: "read", path: "C:\\work\\shared\\notes.txt" }, { ...open, grants })).toBe("ask");
    expect(effect({ kind: "write", path: `${WT}\\.git` }, open)).toBe("never");
  });

  it("your Auto rules allow a command, but its arguments are still checked", () => {
    const rules: PolicyRule[] = [...DEFAULT_RULES, { id: "v", match: "npx vitest", effect: "auto" }];
    expect(effect(shell("npx vitest run"), { ...open, rules })).toBe("auto");
    expect(effect(shell("npx vitest run --outputFile=../x.json"), { ...open, rules })).toBe("ask");
  });

  it("asks for web addresses, approved per host", () => {
    const url = { kind: "url", url: "https://docs.example.com/a" } as const;
    const grants = grantsFor(url, open);
    expect(effect({ kind: "url", url: "https://docs.example.com/b" }, { ...open, grants })).toBe("auto");
    expect(effect({ kind: "url", url: "https://other.example.com/" }, { ...open, grants })).toBe("ask");
  });

  it("a grant never lifts a hard rule", () => {
    const grants: TaskGrant[] = [{ id: "g", key: JSON.stringify(["git", "push", "origin", "main"]), target: canonicalPath(WT, WT), label: "git push origin main", at: 0 }];
    expect(effect(shell("git push origin main"), { ...open, grants })).toBe("never");
  });

  it("allows reading from allowed readonlyRoots (folders or exact files) in sandboxed tasks", () => {
    const allowedFolder = "C:\\Users\\sam\\Downloads";
    const allowedFile = "C:\\Users\\sam\\Downloads\\1.3-schema-1.6.53-intu.graphql";
    const disallowedFile = "C:\\Users\\sam\\Secrets\\pass.txt";

    expect(
      effect(
        { kind: "read", path: "C:\\Users\\sam\\Downloads\\1.3-schema-1.6.53-intu.graphql" },
        { sandboxed: true, readonlyRoots: [allowedFolder] },
      ),
    ).toBe("auto");

    expect(
      effect(
        { kind: "read", path: "C:\\Users\\sam\\Downloads\\1.3-schema-1.6.53-intu.graphql" },
        { sandboxed: true, readonlyRoots: [allowedFile] },
      ),
    ).toBe("auto");

    expect(
      effect(
        { kind: "read", path: disallowedFile },
        { sandboxed: true, readonlyRoots: [allowedFolder] },
      ),
    ).toBe("never");

    expect(
      effect(
        { kind: "write", path: "C:\\Users\\sam\\Downloads\\evil.txt" },
        { sandboxed: true, readonlyRoots: [allowedFolder] },
      ),
    ).toBe("never");
  });
});
