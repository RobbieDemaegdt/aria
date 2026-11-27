/**
 * Phase 3 Part B, item 3 (PLAN.md §4.8, §5.3, D26–D29): exact rules, rule scope, the bare program token, destructive
 * commands as a fixed Ask, the "Always allow this" offer, and the save checks. Against the policy engine with real
 * contexts, as policy-engine.test.ts builds them; the Part A-style suite tries to get past the fixed rules with rules.
 */
import type { PolicyRule, RuleScope, TaskGrant } from "@aria/protocol";
import { describe, expect, it } from "vitest";
import { checkRule } from "../src/policy/breadth.ts";
import { canonicalPath, parseCommand, ruleMatches, ruleShape, ruleWeight } from "../src/policy/command.ts";
import { DEFAULT_RULES } from "../src/policy/defaults.ts";
import { destructive, destructiveTogether } from "../src/policy/destructive.ts";
import { applyOffer, ruleOffer } from "../src/policy/offers.ts";
import { decideWorker, type WorkerPolicyContext } from "../src/policy/worker.ts";
import { scanCommand } from "../src/tasks/policy.ts";
import type { PermissionAsk } from "../src/runtime/types.ts";

const WT = "C:\\wt\\moonrise\\fix-login";
const open = { sandboxed: false };

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
  readTools: new Set<string>(),
  rules: DEFAULT_RULES,
  grants: [],
  defaultBranch: "main",
  ...extra,
});

const effect = (ask: PermissionAsk, extra: Partial<WorkerPolicyContext> = {}) => decideWorker(ask, ctx(extra)).effect;
let n = 0;
const rule = (match: string, effect: PolicyRule["effect"], more: Partial<PolicyRule> = {}): PolicyRule => ({ id: `r${++n}`, match, effect, ...more });
const offerOf = (ask: PermissionAsk, extra: Partial<WorkerPolicyContext> = {}) => {
  const context = ctx(extra);
  return ruleOffer(ask, context, decideWorker(ask, context));
};
/** Your rules after saving the offer as it was made. */
function saved(ask: PermissionAsk, extra: Partial<WorkerPolicyContext> = {}): PolicyRule[] {
  const result = offerOf(ask, extra);
  if (!("offer" in result)) throw new Error(`no offer: ${result.none}`);
  return applyOffer(ctx(extra).rules, result.offer, result.offer.rules, { note: "", newId: () => `saved${++n}` });
}

describe("exact rules (ruling 1)", () => {
  const exact = (match: string, segment: string) => ruleMatches(ruleShape(match, true)!, parseCommand(segment)!);
  it.each([
    ["npm install left-pad", "npm install left-pad", true],
    ["npm install left-pad", "npm install left-pad evil", false],
    ["npm install left-pad", "npm install left-pad -g", false],
    ["npm install left-pad", "npm install -g left-pad", false],
    ["npm install left-pad", "npm install Left-Pad", false],
    ["npm install left-pad", "npm install left-pad --", false],
    ["npm install left-pad", "npm.cmd install left-pad", true],
    ["npm install left-pad", "npm install", false],
    ["node --require a b", "node b --require a", false],
    ["node --require a b", "node --require a b", true],
    ["git branch -d x", "git branch -D x", false],
    ["Remove-Item -Path a", "Remove-Item -path a", false],
    ["npm run <script>", "npm run build", true],
    ["npm run <script>", "npm run --silent", false],
    ["npm run <script>", "npm run build extra", false],
    ["node $x", "node '$x'", true],
    ["node $x", "node $x", false],
  ])("`%s` vs `%s` → %s", (match, segment, expected) => {
    expect(exact(match, segment)).toBe(expected);
  });

  it("doesn't match PowerShell 7's reading with an empty argument, so that command asks", () => {
    const rules = [...DEFAULT_RULES, rule("npm install left-pad", "auto", { exact: true })];
    expect(effect(shell("npm install left-pad"), { rules })).toBe("auto");
    expect(effect(shell("npm install left-pad ''"), { rules })).toBe("ask");
  });

  it("weighs one more than the same words without placeholders; the strictest still wins among equals (ruling 4)", () => {
    expect(ruleWeight(ruleShape("npm install left-pad", true)!)).toBe(ruleWeight(ruleShape("npm install left-pad")!) + 1);
    expect(ruleWeight(ruleShape("npm run <script>", true)!)).toBe(ruleWeight(ruleShape("npm run <script>")!));
    const over = [rule("npm install left-pad", "never"), rule("npm install left-pad", "auto", { exact: true })];
    expect(effect(shell("npm install left-pad"), { rules: over })).toBe("auto");
    expect(effect(shell("npm install left-pad lodash"), { rules: over })).toBe("never");
    const tie = [rule("npm install left-pad", "auto", { exact: true }), rule("npm install left-pad", "never", { exact: true })];
    expect(effect(shell("npm install left-pad"), { rules: tie })).toBe("never");
    expect(effect(shell("npm install left-pad"), { rules: [...tie].reverse() })).toBe("never");
  });
});

describe("rule scope (D27)", () => {
  it("a rule for sandboxed tasks doesn't apply to a task without the sandbox", () => {
    const sandboxedOnly = [...DEFAULT_RULES, rule("node build.js", "auto", { exact: true, scope: "sandboxed" })];
    expect(effect(shell("node build.js"), { ...open, rules: sandboxedOnly })).toBe("ask");
    const everywhere = [...DEFAULT_RULES, rule("node build.js", "auto", { exact: true, scope: "everywhere" })];
    expect(effect(shell("node build.js"), { ...open, rules: everywhere })).toBe("auto");
    const legacy = [...DEFAULT_RULES, rule("node build.js", "auto", { exact: true })];
    expect(effect(shell("node build.js"), { ...open, rules: legacy })).toBe("auto");
    // Ask and Never rules alike.
    const never = [rule("npm install <package>", "never", { scope: "sandboxed" })];
    expect(effect(shell("npm install lodash"), { rules: never })).toBe("never");
    expect(effect(shell("npm install lodash"), { ...open, rules: never })).toBe("ask");
  });
});

describe("an Auto rule only for a program named alone (duck concern 1)", () => {
  it("never matches a program named by its folder; Ask and Never rules still do", () => {
    const rules = [...DEFAULT_RULES, rule("vitest", "auto"), rule("npm install left-pad", "auto", { exact: true })];
    expect(effect(shell("vitest run"), { ...open, rules })).toBe("auto");
    expect(effect(shell(".\\node_modules\\.bin\\vitest run"), { ...open, rules })).toBe("ask");
    expect(effect(shell("& './node_modules/.bin/vitest.cmd' run"), { ...open, rules })).toBe("ask");
    expect(effect(shell(`${WT}\\vitest.cmd run`), { ...open, rules })).toBe("ask");
    expect(effect(shell("C:vitest run"), { ...open, rules })).toBe("ask");
    expect(effect(shell("npm.cmd install left-pad"), { rules })).toBe("auto");
    expect(effect(shell(".\\npm.cmd install left-pad"), { rules })).toBe("ask");
    const never = [rule("vitest", "never")];
    expect(effect(shell(".\\node_modules\\.bin\\vitest run"), { rules: never })).toBe("never");
  });
});

describe("destructive commands ask every time (D28, D29)", () => {
  const anywhere = [
    "Remove-Item -Recurse dist",
    "Remove-Item dist -Recurse",
    "rm -r dist",
    "rm -rf dist",
    "del -rec dist",
    "ri -R dist",
    "rd /s /q build",
    "del /S *.tmp",
    "cmd /c rd /s /q build",
    'cmd /c "del /s *.tmp"',
    'pwsh -NoProfile -Command "Remove-Item -Recurse dist"',
    "bash -c 'rm -rf dist'",
    "git reset --hard",
    "git reset --ha HEAD~1",
    "git -C sub reset --hard",
    "git clean -fdx",
    "git clean -f",
    "git clean -fen",
    "git branch -D aria/old",
    "git branch -df aria/old",
    "git branch --delete --force aria/old",
    // The user's decision (D29): the whole worktree, like reset --hard; and the other ways to throw away work (round 1).
    "git checkout .",
    "git checkout -- .",
    "git checkout HEAD -- .",
    "git checkout :/",
    "git checkout -- *",
    "git restore .",
    "git restore",
    "git restore -- *",
    "git restore --source HEAD~1 :/",
    "git restore --staged --worktree .",
    "git restore ':(top)'",
    "git checkout -f main",
    "git checkout --force main",
    "git switch --discard-changes main",
    "git switch -f main",
    "git stash clear",
    "git stash drop",
    "git branch -M main2",
    "git branch --move --force old new",
    "Get-ChildItem dist -Recurse | Remove-Item -Force",
    "gci -r *.tmp | rm",
    "ls -Recurse | ForEach-Object { Remove-Item $_ }",
    "npx rimraf dist",
    "npx -y rimraf@5 dist",
    "rimraf dist",
    "npm exec rimraf dist",
    "pnpm dlx rimraf dist",
    "yarn rimraf dist",
    "robocopy empty dist /MIR",
    "robocopy a b /purge",
    'pwsh -NoProfile -Command "gci -r | rm"',
    'cmd /c "if exist build rd /s /q build"',
    "bash -c 'for d in a b; do rm -rf $d; done'",
    "cmd /c \"git stash clear\"",
    // Round 2: cmd's switches written together, a program by its Unix path, find and xargs, paths from a file.
    'cmd /c "rd /s/q out"',
    "cmd /c rd/s/q out",
    'cmd /c "rmdir /S/Q out"',
    'cmd /c "del /s/q *.tmp"',
    "rd /s/q out",
    "bash -c '/bin/rm -rf dist'",
    "wsl /bin/rm -rf dist",
    "sh -c '/usr/bin/git reset --hard'",
    "bash -c 'find . -name node_modules -exec rm -rf {} +'",
    "bash -c 'ls | xargs rm -rf'",
    "bash -c 'ls | xargs -n 1 rm -rf'",
    "bash -c 'find . -name x -delete'",
    "git checkout --pathspec-from-file=paths.txt",
  ];
  const pushes = ["git push --force origin aria/x", "git push --for origin aria/x", "git push -f origin aria/x", "git push -uf origin aria/x", "git push --force-with-lease origin aria/x", "git push --force-if-includes origin aria/x", "git push origin +aria/x"];
  const grant = (command: string): TaskGrant[] => [{ id: "g", key: JSON.stringify(command), target: canonicalPath(WT, WT), label: command, at: 0 }];
  const autoRules = (command: string): PolicyRule[] => {
    const words = command.split(" ");
    return [
      ...DEFAULT_RULES.filter((r) => r.effect !== "ask"),
      ...(["everywhere", "sandboxed"] as RuleScope[]).flatMap((scope) => [
        rule(command, "auto", { exact: true, scope }),
        rule(words.slice(0, 2).join(" "), "auto", { scope }),
        rule(words[0]!, "auto", { scope }),
      ]),
    ];
  };

  it.each(anywhere)("`%s`: asks, sandboxed or not, whatever Auto rules and grants say", (command) => {
    // On its own, or with the other commands of its line (a recursive listing piped to Remove-Item).
    expect(destructive(parseCommand(command)) ?? destructiveTogether(scanCommand(command).map((s) => parseCommand(s.text)))).toBeDefined();
    for (const sandboxed of [true, false]) {
      const decision = decideWorker(shell(command), ctx({ sandboxed, rules: autoRules(command), grants: grant(command) }));
      expect(decision, `sandboxed: ${sandboxed}`).toMatchObject({ effect: "ask", request: { everyTime: true, grants: [] } });
    }
    // A Never rule still refuses (the stricter counts).
    expect(effect(shell(command), { rules: [rule(command.split(" ")[0]!, "never")] })).toBe("never");
  });

  it.each(pushes)("`%s`: a force push asks every time (a sandboxed task can't push at all)", (command) => {
    expect(decideWorker(shell(command), ctx({ ...open, rules: autoRules(command), grants: grant(command) }))).toMatchObject({ effect: "ask", request: { everyTime: true, grants: [] } });
    expect(effect(shell(command))).toBe("never");
  });

  it.each([
    ["git restore src/a.ts", "auto", "auto"],
    ["git restore --staged src/a.ts", "auto", "auto"],
    ["git checkout -- src/a.ts", "auto", "ask"],
    ["git restore --staged .", "auto", "auto"],
    ["git checkout main", "auto", "ask"],
    ["git checkout -b clean-up-styles", "auto", "ask"],
    ["git checkout src/a.ts", "auto", "ask"],
    ["git switch main", "auto", "ask"],
    ["git stash", "auto", "ask"],
    ["git stash pop", "auto", "ask"],
    ["git branch -m old new", "auto", "ask"],
    ["npm install rimraf", "ask", "ask"],
    ["robocopy a b /E", "auto", "ask"],
    ["Get-ChildItem -Recurse", "auto", "auto"],
    ["git push --fo origin aria/x", "never", "ask"],
    // Wrapped commands that only mention the words (round 1): read as commands, they aren't destructive.
    ["bash -c 'git commit -m \"clean up\"'", "auto", "ask"],
    ['cmd /c "git commit -m ""Clean up the styles"""', "auto", "ask"],
    ["bash -c 'git checkout -b clean-up-styles'", "auto", "ask"],
    ["bash -c 'git add src/clean.ts'", "auto", "ask"],
    ["bash -c 'git rm -r --cached dist'", "auto", "ask"],
    // Read as commands, a mention in quoted text is only text; the words count only where ARIA can't read the line.
    ["bash -c \"echo 'rm -rf dist'\"", "auto", "ask"],
    ["pwsh -Command \"Write-Output 'git stash clear'\"", "auto", "ask"],
    // A listing that isn't recursive, piped to Remove-Item, deletes only what it lists.
    ["Get-ChildItem *.tmp | Remove-Item", "auto", "ask"],
    // What a printing command is given is its text (round 2).
    ["cmd /c echo git reset --hard", "auto", "ask"],
    ["pwsh -Command Write-Host git reset --hard", "auto", "ask"],
    ["bash -c 'find . -name x -print'", "auto", "ask"],
    ["bash -c 'ls | xargs echo rm -rf'", "auto", "ask"],
    ["git clean -n", "auto", "ask"],
    ["git clean --dry-run -d", "auto", "ask"],
    // The default rule `git clean -f` asks about this one (as rules do: it can be approved for the task).
    ["git clean -nfd", "ask", "ask"],
    ["git clean -e node_modules -n", "auto", "ask"],
    ["git branch -d aria/old", "auto", "ask"],
    ["git reset --soft HEAD~1", "auto", "ask"],
    ["git reset HEAD src/a.ts", "auto", "ask"],
    ["Remove-Item dist\\a.txt", "auto", "ask"],
    ["rm a.txt", "auto", "ask"],
    ["git push origin aria/x", "never", "ask"],
  ] as const)("`%s` isn't destructive (D29): %s in the sandbox, %s without it, never every time", (command, sandboxed, unsandboxed) => {
    expect(destructive(parseCommand(command))).toBeUndefined();
    for (const [extra, expected] of [
      [{}, sandboxed],
      [open, unsandboxed],
    ] as const) {
      const decision = decideWorker(shell(command), ctx(extra));
      expect(decision.effect, JSON.stringify(extra)).toBe(expected);
      if (decision.effect === "ask") expect(decision.request.everyTime).toBeUndefined();
    }
  });

  it("follows git aliases, and reads what a shell or a shell alias is given", () => {
    const gitAliases = new Map([
      ["rh", "reset --hard"],
      ["wipe", "!git clean -fdx"],
      ["st", "status"],
    ]);
    expect(decideWorker(shell("git rh"), ctx({ gitAliases }))).toMatchObject({ effect: "ask", request: { everyTime: true } });
    expect(decideWorker(shell("git wipe"), ctx({ gitAliases }))).toMatchObject({ effect: "ask", request: { everyTime: true } });
    expect(effect(shell("git st"), { gitAliases })).toBe("auto");
    expect(effect(shell('pwsh -NoProfile -Command "npm run build"'))).toBe("auto");
    // Shell switches that take a value come before the command (round 1): it's read from every argument.
    const more = new Map([...gitAliases, ["nuke", "clean -fdx"]]);
    for (const command of ['pwsh -ExecutionPolicy Bypass -Command "git rh"', 'powershell -WorkingDirectory sub -Command "git nuke"', 'pwsh -ep Bypass -wd sub "git rh"']) {
      for (const sandboxed of [true, false]) {
        expect(decideWorker(shell(command), ctx({ gitAliases: more, sandboxed })), `${command}, sandboxed: ${sandboxed}`).toMatchObject({ effect: "ask", request: { everyTime: true, grants: [] } });
      }
    }
  });

  it("counts a path naming the whole worktree from where the command runs (round 2)", () => {
    const src = `${WT}\\src`;
    for (const [command, cwd] of [
      ["git restore ..", src],
      ["git checkout -- ..", src],
      ["git restore ../..", `${src}\\app`],
      [`git checkout -- ${WT}`, WT],
      [`git checkout -- ${WT.toUpperCase()}\\`, WT],
      ["git restore C:\\wt", WT],
      ["git -C src restore ..", WT],
    ] as const) {
      for (const sandboxed of [true, false]) {
        expect(decideWorker(shell(command, { cwd }), ctx({ sandboxed })), `${command} in ${cwd}, sandboxed: ${sandboxed}`).toMatchObject({ effect: "ask", request: { everyTime: true } });
      }
    }
    // A folder inside it is only that folder.
    expect(effect(shell("git restore ..", { cwd: `${src}\\app` }))).toBe("auto");
    expect(effect(shell("git checkout -- src", { cwd: WT }))).toBe("auto");
    expect(effect(shell(`git checkout -- ${WT}\\src`, { cwd: WT }))).toBe("auto");
    expect(effect(shell("git -C src restore app", { cwd: WT }))).toBe("auto");
    // git's own -C moves where its paths are read from: `..` from src\app is src.
    expect(effect(shell("git -C src\\app restore ..", { cwd: WT }))).toBe("auto");
  });

  it("names a wrapped force push by the command, not by its words (`--follow-tags` isn't `--force`)", () => {
    expect(destructive(parseCommand("pwsh -Command 'git push --follow-tags origin aria/x'"))).toBeUndefined();
    expect(destructive(parseCommand("pwsh -Command 'git push --for origin aria/x'"))).toMatch(/force push/);
    // A wrapped push is refused by the fixed rules anyway.
    expect(effect(shell("pwsh -Command 'git push --follow-tags origin aria/x'"), open)).toBe("never");
  });

  it("names it on the card, and a rule's note when it has one", () => {
    const plain = decideWorker(shell("git branch -D aria/old"), ctx());
    expect(plain.effect === "ask" && plain.request.reason).toBe("`git branch -D aria/old` deletes a branch even if it isn't merged.");
    const noted = decideWorker(shell("git reset --hard"), ctx());
    expect(noted.effect === "ask" && noted.request.reason).toBe("Throws away uncommitted work.");
  });
});

describe("Always allow this: the offer (§5.3)", () => {
  it("offers an exact rule for a command your Ask rule stops in the sandbox; saved, only exactly that runs, in sandboxed tasks", () => {
    expect(offerOf(shell("npm install left-pad"))).toEqual({ offer: { rules: [{ match: "npm install left-pad", exact: true }], decided: "ask", scope: "sandboxed" } });
    const rules = saved(shell("npm install left-pad"));
    expect(rules.at(-1)).toMatchObject({ match: "npm install left-pad", effect: "auto", exact: true, scope: "sandboxed" });
    expect(effect(shell("npm install left-pad"), { rules })).toBe("auto");
    for (const other of ["npm install left-pad evil", "npm install left-pad -g", "npm install left-pad --save-dev", "npm install left-pad ''", "npm install Left-Pad", "npm install left-pad; npm install x"]) {
      expect(effect(shell(other), { rules }), other).toBe("ask");
    }
    expect(effect(shell("npm install left-pad"), { ...open, rules })).toBe("ask");
  });

  it("offers one for a program the Phase 2 list doesn't know, without the sandbox; its arguments are still checked", () => {
    expect(offerOf(shell("node build.js"), open)).toEqual({ offer: { rules: [{ match: "node build.js", exact: true }], decided: "ask", scope: "everywhere" } });
    const rules = saved(shell("node build.js"), open);
    expect(effect(shell("node build.js"), { ...open, rules })).toBe("auto");
    for (const other of ["node build.js --inspect", 'node -e "require(1)"', "node build.js ..\\x"]) expect(effect(shell(other), { ...open, rules }), other).toBe("ask");
    expect(effect(shell("node build.js", { cwd: "C:\\Users\\me\\repo" }), { ...open, rules })).toBe("ask");
  });

  it("makes one rule per command of the line that doesn't run on its own", () => {
    expect(offerOf(shell("npm ci; npm install left-pad"))).toEqual({ offer: { rules: [{ match: "npm install left-pad", exact: true }], decided: "ask", scope: "sandboxed" } });
  });

  it.each([
    ["git push origin main", open],
    ["git push --delete origin aria/old", open],
    ["git push --mirror origin", open],
    ["gh pr merge 1", open],
    ["gh api -X PUT repos/o/r/pulls/1/merge", open],
    ['git commit -m "$x"', open],
    ["cmd /c git push origin aria/x", open],
    ["git -c alias.p=push p", open],
    ["git flowx", { ...open, gitExternals: new Set(["flowx"]) }],
    ["git push origin aria/x", {}],
  ] as Array<[string, Partial<WorkerPolicyContext>]>)("offers nothing for a fixed rule's refusal: `%s`", (command, extra) => {
    expect(decideWorker(shell(command), ctx(extra)).effect).toBe("never");
    expect(offerOf(shell(command), extra)).toEqual({ none: "a fixed rule refuses it" });
  });

  it.each([
    ["npm install 'a b'", {}, /needs quotes/],
    ["npm install $pkg", {}, /can't be named exactly/],
    ["npm install @types/node", {}, /can't be named exactly/],
    ["npm --prefix x install y", {}, /option before its command/],
    [".\\npm.cmd install left-pad", {}, /by its folder/],
    ["git reset --hard", {}, /destructive/],
    ["Get-ChildItem dist -Recurse | Remove-Item -Force", {}, /destructive/],
    ["git checkout .", {}, /destructive/],
    ["npm test", {}, /^it runs on its own$/],
    ["node ..\\x.js", open, /couldn't make it run/],
    ["node x.js", { ...open, worktree: "C:\\elsewhere" }, /couldn't make it run/],
  ] as Array<[string, Partial<WorkerPolicyContext>, RegExp]>)("offers nothing a rule can't name or make run: `%s`", (command, extra, why) => {
    expect(offerOf(shell(command), extra)).toEqual({ none: expect.stringMatching(why) });
  });

  it("over your own Never rule: an exact rule that outweighs it, which you confirm; your rule stays for everything else (ruling 2)", () => {
    const never = rule("curl", "never", { note: "No downloads." });
    const rules = [...DEFAULT_RULES, never];
    const ask = shell("curl https://example.com");
    expect(offerOf(ask, { rules })).toEqual({
      offer: { rules: [{ match: "curl https://example.com", exact: true }], decided: "never", scope: "sandboxed", overrides: [{ ruleId: never.id, match: "curl", sameRule: false }] },
    });
    const after = saved(ask, { rules });
    expect(effect(ask, { rules: after })).toBe("auto");
    expect(effect(shell("curl https://example.org"), { rules: after })).toBe("never");
    expect(after.find((r) => r.id === never.id)).toEqual(never);
  });

  it("turns your Never rule for exactly this command into the one that lets it run", () => {
    const never = rule("curl https://example.com", "never", { exact: true });
    const ask = shell("curl https://example.com");
    expect(offerOf(ask, { rules: [never] })).toMatchObject({ offer: { overrides: [{ ruleId: never.id, sameRule: true }] } });
    const after = saved(ask, { rules: [never] });
    expect(after).toEqual([{ id: never.id, match: "curl https://example.com", effect: "auto", exact: true, scope: "sandboxed" }]);
  });

  it("is checked by construction: none when saving it wouldn't let the command run", () => {
    const rules = [rule("npm install left-pad", "never", { exact: true }), rule("npm install left-pad", "never", { exact: true, scope: "sandboxed" })];
    expect(offerOf(shell("npm install left-pad"), { rules })).toEqual({ none: expect.stringMatching(/still/) });
  });

  it("saving replaces a rule with the same words, exactness and scope instead of adding a second one", () => {
    const existing = rule("npm install left-pad", "ask", { exact: true, scope: "sandboxed" });
    const rules = [...DEFAULT_RULES, existing];
    const after = saved(shell("npm install left-pad"), { rules });
    expect(after).toHaveLength(rules.length);
    expect(after.at(-1)).toMatchObject({ id: existing.id, effect: "auto", exact: true, scope: "sandboxed" });
  });
});

describe("saved Auto rules never lift a fixed rule's refusal (Part A style)", () => {
  /** Auto rules for the command itself (exact), its first two words and its program, for every task and sandboxed ones. */
  const rulesFor = (command: string): PolicyRule[] =>
    command.split(/\s*;\s*/).flatMap((part) => {
      const words = part.split(/\s+/);
      return (["everywhere", "sandboxed"] as RuleScope[]).flatMap((scope) => [
        rule(part, "auto", { exact: true, scope }),
        rule(words.slice(0, 2).join(" "), "auto", { scope }),
        rule(words[0]!, "auto", { scope }),
      ]);
    });

  it.each([
    ["git push origin main", open],
    ["git push origin HEAD:refs/heads/main", open],
    ["git push --delete origin aria/old", open],
    ["git push -d origin aria/old", open],
    ["git push --mirror origin", open],
    ["git push --all origin", open],
    ["gh pr merge 3", open],
    ["gh api -X PUT repos/o/r/pulls/3/merge", open],
    ["gh api graphql -f query=mutation", open],
    ["git flowx", { ...open, gitExternals: new Set(["flowx"]) }],
    ['git commit -m "$x"', open],
    ["cmd /c git push origin aria/x", open],
    ["git p", { ...open, gitAliases: new Map([["p", "push origin HEAD:main"]]) }],
    ["git -c alias.p=push p", open],
    ["git push origin aria/x", { ...open, pushSettings: null }],
    ["git push origin aria/x", { ...open, pushSettings: { refspecs: ["HEAD:refs/heads/main"], mirror: false } }],
    ["cd ..\\other; git push origin aria/x", open],
    ["git -C ..\\other push origin aria/x", open],
    ["git push origin aria/x", {}],
  ] as Array<[string, Partial<WorkerPolicyContext>]>)("`%s` stays refused", (command, extra) => {
    const decision = decideWorker(shell(command), ctx({ ...extra, rules: [...DEFAULT_RULES, ...rulesFor(command)] }));
    expect(decision.effect).toBe("never");
    // Refused by a fixed rule, not by a rule of yours.
    expect(decision.effect === "never" && decision.rule).toBeUndefined();
  });

  it("also one only the runtime's segments show", () => {
    const ask = shell("npm test", { segments: ["git push origin main"] });
    expect(effect(ask, { ...open, rules: [...DEFAULT_RULES, ...rulesFor("git push origin main"), ...rulesFor("npm test")] })).toBe("never");
  });
});

describe("the save checks (D26, concern 5)", () => {
  const problems = (match: string, extra: Partial<Parameters<typeof checkRule>[0]> = {}) => checkRule({ match, effect: "auto", ...extra }).problems;

  it.each(["npm test", "npm t", "npm run build", "pnpm run lint", "yarn run typecheck", "bun test", "dotnet test", "cargo clippy", "go vet", "eslint", "prettier --write", "vitest run", "tsc -p ."])(
    "lets `%s` be Auto without being exact",
    (match) => {
      expect(problems(match)).toEqual([]);
    },
  );

  it.each(["git", "git push", "git status", "node", "node build.js", "npm", "npm <x>", "npm run deploy", "npm run <script>", "npx vitest", "dotnet run", "cargo run", "go run", "make deploy", "make test", "make check", "curl", "gh pr list", "<x> test"])(
    "refuses `%s` as Auto unless it's exact",
    (match) => {
      expect(problems(match).length).toBeGreaterThan(0);
    },
  );

  it("accepts exact rules, except destructive ones and ones naming the program by its folder; Ask and Never rules have no limits", () => {
    expect(problems("git push origin aria/x", { exact: true })).toEqual([]);
    expect(problems("npx vitest run", { exact: true })).toEqual([]);
    expect(problems("git reset --hard", { exact: true })[0]).toMatch(/destructive/);
    expect(problems("Remove-Item -Recurse dist", { exact: true })[0]).toMatch(/destructive/);
    expect(problems("git push --force origin aria/x", { exact: true })[0]).toMatch(/destructive/);
    expect(problems(".\\npm.cmd install left-pad", { exact: true })[0]).toMatch(/by its folder/);
    expect(problems("git checkout .", { exact: true })[0]).toMatch(/destructive/);
    expect(problems("npx rimraf dist", { exact: true })[0]).toMatch(/destructive/);
    for (const effect of ["ask", "never"] as const) expect(checkRule({ match: "git", effect }).problems).toEqual([]);
  });

  it.each(["npm <x>", "git <x>", "node <x>", "npx <x>", "curl <x>", "pwsh -Command <x>", "cmd /c <x>", "npm run <script>", "git push origin <branch>", "node build.js <arg>", "make test <x>"])(
    "refuses exact `%s`: a word in angle brackets is as broad as a rule that isn't exact (round 1)",
    (match) => {
      expect(problems(match, { exact: true })[0]).toMatch(/angle brackets would let tasks run/);
    },
  );

  it.each(["eslint <file>", "dotnet test <project>", "npm test <x>", "vitest run <file>"])("still accepts exact `%s`, which only tests, builds, lints or formats", (match) => {
    expect(problems(match, { exact: true })).toEqual([]);
  });

  it("lets nothing exact with a placeholder run what it's given (round 1 scenarios)", () => {
    for (const [rule, command] of [
      ["npm <x>", "npm publish"],
      ["pwsh -Command <x>", "pwsh -Command .\\evil.ps1"],
      ["npx <x>", "npx some-malware"],
      ["curl <x>", "curl example.com"],
    ]) {
      // Such a rule could only be in a list saved by hand outside ARIA; saving it is refused.
      expect(problems(rule!, { exact: true }).length, rule).toBeGreaterThan(0);
      expect(effect(shell(command!), { ...open, rules: [...DEFAULT_RULES] }), command).toBe("ask");
    }
  });

  it("warns about what a rule also covers, placeholders, the fixed rules, without the sandbox, and a Never rule it runs past", () => {
    const warnings = (match: string, extra: Partial<Parameters<typeof checkRule>[0]> = {}, others: PolicyRule[] = []) => checkRule({ match, effect: "auto", ...extra }, others).warnings.join(" ");
    expect(warnings("npm test")).toMatch(/more arguments or options/);
    expect(warnings("npm test", { scope: "sandboxed" })).not.toMatch(/without the sandbox/);
    expect(warnings("npm test")).toMatch(/without the sandbox/);
    expect(warnings("npm run <script>", { exact: true })).toMatch(/any one argument/);
    expect(warnings("git push origin aria/x", { exact: true })).toMatch(/stay refused/);
    expect(warnings("curl https://example.com", { exact: true }, [rule("curl", "never")])).toMatch(/runs although your Never rule `curl`/);
    expect(warnings("curl https://example.com", { exact: true }, [rule("curl https://example.com", "never", { exact: true })])).toMatch(/still refuses it/);
  });
});
