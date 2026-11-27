import path from "node:path";
import type { PolicyRule, RuleScope, TaskGrant } from "@aria/protocol";
import { describe, expect, it } from "vitest";
import { canonicalPath, parseCommand } from "../src/policy/command.ts";
import { DEFAULT_RULES } from "../src/policy/defaults.ts";
import { destructive } from "../src/policy/destructive.ts";
import { decideWorker, type WorkerPolicyContext } from "../src/policy/worker.ts";
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
  readTools: new Set(["github-get_issue"]),
  rules: DEFAULT_RULES,
  grants: [],
  defaultBranch: "main",
  ...extra,
});

const effect = (ask: PermissionAsk, extra: Partial<WorkerPolicyContext> = {}) => decideWorker(ask, ctx(extra)).effect;

describe("Phase 9: Git 2.53+ and gh CLI hard rules & destructive classification (D77)", () => {
  it("parses 2-word subcommands for git maintenance/refs/reflog/commit-graph/multi-pack-index and 1-word vs 2-word gh commands", () => {
    expect(parseCommand("git maintenance register")).toMatchObject({
      program: "git",
      words: ["maintenance", "register"],
    });
    expect(parseCommand("git reflog expire --expire=now --all")).toMatchObject({
      program: "git",
      words: ["reflog", "expire"],
    });
    expect(parseCommand("git refs migrate --ref-format=reftable")).toMatchObject({
      program: "git",
      words: ["refs", "migrate"],
    });
    expect(parseCommand("gh status")).toMatchObject({
      program: "gh",
      words: ["status"],
    });
    expect(parseCommand("gh ruleset check main")).toMatchObject({
      program: "gh",
      words: ["ruleset", "check"],
      values: ["main"],
    });
  });

  it("refuses git maintenance, git hook, git --exec-path, git archive --exec/--remote, and dangerous -c / git config keys", () => {
    const blockedGitCommands = [
      "git maintenance register",
      "git maintenance start",
      "git maintenance stop",
      "git maintenance unregister",
      "git hook run pre-commit",
      "git --exec-path=/evil status",
      "git --exec-path status",
      "git archive --exec=evil HEAD",
      "git archive --remote=https://example.com/repo.git HEAD",
      "git -c core.hooksPath=/evil status",
      "git -c core.sshCommand=evil fetch",
      "git -c core.fsmonitor=evil status",
      "git -c core.askPass=evil fetch",
      "git -c credential.helper=evil fetch",
      "git -c protocol.ext.allow=always fetch",
      "git -c protocol.allow=always fetch",
      "git -c uploadpack.packObjectsHook=evil fetch",
      "git -c filter.lfs.clean=evil checkout",
      "git -c diff.external.command=evil diff",
      "git config core.hooksPath .githooks",
      "git config credential.helper store",
      "git config protocol.ext.allow always",
      "git config --global user.name ARIA",
      "git config --system user.name ARIA",
      "git config --file ../outside.cfg user.name ARIA",
      "git config -f C:\\Users\\me\\.gitconfig user.name ARIA",
    ];

    for (const cmd of blockedGitCommands) {
      expect(effect(shell(cmd), open), cmd).toBe("never");
      expect(effect(shell(cmd)), cmd).toBe("never");
    }

    // Local worktree config file inside worktree for safe keys is allowed to ask/auto
    expect(effect(shell("git config --file .gitmodules --list"))).toBe("auto");
  });

  it("refuses git replay, git update-ref, and git branch -f/-D/-M targeting the default branch", () => {
    const blockedDefaultBranchMutations = [
      "git replay --onto main feature~3..feature",
      "git replay --advance main feature~2..feature",
      "git replay --advance=refs/heads/main feature~2..feature",
      "git replay --contained --onto feature main..topic",
      "git update-ref refs/heads/main HEAD",
      "git update-ref main HEAD",
      "git update-ref -d refs/heads/main",
      "git branch -f main HEAD~1",
      "git branch --force main HEAD~1",
      "git branch -f refs/heads/main HEAD~1",
      "git branch -D main",
      "git branch -M main",
    ];

    for (const cmd of blockedDefaultBranchMutations) {
      expect(effect(shell(cmd), open), cmd).toBe("never");
      expect(effect(shell(cmd)), cmd).toBe("never");
    }

    // Non-default branch with git branch -f is allowed (or asks if -D/-M)
    expect(effect(shell("git replay --onto aria/feature topic~2..topic"))).toBe("auto");
  });

  it("enforces gh subcommand hard rules for auth, alias, config, extension, agent-task, secret/variable/keys, repo, ruleset, attestation, pr create, and gh api", () => {
    const blockedGhCommands = [
      "gh auth token",
      "gh auth login",
      "gh auth logout",
      "gh auth switch",
      "gh auth refresh",
      "gh auth setup-git",
      "gh alias set pv 'pr view'",
      "gh alias delete pv",
      "gh alias import aliases.yml",
      "gh config set editor vim",
      "gh config clear-cache",
      "gh extension install owner/gh-ext",
      "gh extension upgrade --all",
      "gh extension remove gh-ext",
      "gh extension exec some-ext",
      "gh agent-task create 'Fix bug'",
      "gh secret set MY_SECRET --body val",
      "gh secret delete MY_SECRET",
      "gh variable set MY_VAR --body val",
      "gh variable delete MY_VAR",
      "gh ssh-key add key.pub",
      "gh ssh-key delete 123",
      "gh gpg-key add key.asc",
      "gh gpg-key delete 123",
      "gh repo delete owner/repo --yes",
      "gh repo archive owner/repo",
      "gh repo unarchive owner/repo",
      "gh repo rename new-name",
      "gh repo deploy-key add key.pub",
      "gh repo autolink create PRE- https://example.com/<num>",
      "gh repo set-default owner/repo",
      "gh ruleset delete 123",
      "gh api -X PUT repos/owner/repo/branches/main/protection",
      "gh api -X POST repos/owner/repo/rulesets -f name=test",
      "gh api -X DELETE repos/owner/repo/rulesets/42",
      "gh api -X PUT repos/owner/repo/actions/secrets/MY_SECRET -f encrypted_value=abc",
      "gh api -X POST repos/owner/repo/keys -f key=ssh-rsa...",
      "gh api -X POST repos/owner/repo/hooks -f name=web",
      // Direct repo root mutations (DELETE, PATCH, POST, PUT on repos/:owner/:repo)
      "gh api -X DELETE repos/owner/repo",
      "gh api --method DELETE /repos/owner/repo",
      "gh api -X PATCH repos/owner/repo -f private=false",
      "gh api -X POST repos/owner/repo -f name=x",
      "gh api -X PUT repos/owner/repo",
    ];

    for (const cmd of blockedGhCommands) {
      expect(effect(shell(cmd), open), cmd).toBe("never");
      expect(effect(shell(cmd)), cmd).toBe("never");
    }

    // In a sandboxed task, gh pr create is refused with guidance to use ARIA's PR card
    expect(effect(shell("gh pr create --title 'Fix' --body 'Body'"))).toBe("never");
    // In an unsandboxed task, gh pr create asks
    expect(effect(shell("gh pr create --title 'Fix' --body 'Body'"), open)).toBe("ask");

    // Read-only gh subcommands are allowed in sandboxed tasks
    const allowedReadOnlyGh = [
      "gh auth status",
      "gh alias list",
      "gh config list",
      "gh config get git_protocol",
      "gh extension list",
      "gh extension search copilot",
      "gh agent-task list",
      "gh agent-task view 123",
      "gh secret list",
      "gh variable list",
      "gh ssh-key list",
      "gh gpg-key list",
      "gh ruleset list",
      "gh ruleset view 42",
      "gh ruleset check main",
      "gh attestation verify artifact.tar.gz --owner contoso",
      "gh project list",
      "gh project view 1",
      "gh api repos/owner/repo",
      "gh api -X GET repos/owner/repo/rulesets",
    ];

    for (const cmd of allowedReadOnlyGh) {
      expect(effect(shell(cmd)), cmd).toBe("auto");
    }

    // Triggering workflows asks for user approval in DEFAULT_RULES and via gh api dispatches
    expect(effect(shell("gh workflow run deploy.yml --ref main"))).toBe("ask");
    expect(effect(shell("gh run rerun 12345"))).toBe("ask");
    expect(effect(shell("gh api -X POST repos/owner/repo/actions/workflows/deploy.yml/dispatches -f ref=main"))).toBe("ask");
  });

  it("classifies new Git and gh destructive commands (including gh api -X DELETE) as everyTime Ask", () => {
    const destructiveCommands = [
      "git reflog expire --expire=now --all",
      "git reflog delete HEAD@{1}",
      "git prune",
      "git gc --prune=now",
      "git gc --prune=all",
      "git gc --force",
      "git update-ref -d refs/heads/aria/temp",
      "git update-ref --stdin",
      "git filter-branch --tree-filter 'rm -f passwords.txt' HEAD",
      "gh release delete v1.0.0",
      "gh release delete-asset v1.0.0 app.zip",
      "gh project delete 4",
      "gh project close 4",
      "gh project field-delete --id PVTSSF_1",
      "gh project item-delete 4 --id PVTI_1",
      "gh gist delete abcdef123",
      "gh codespace delete -c my-cs",
      "gh cache delete --all",
      "gh run delete 9999",
      "gh run cancel 9999",
      "gh pr close 12",
      "gh issue delete 15",
      "gh issue close 15",
      "gh api -X DELETE repos/owner/repo/issues/1/comments/99",
      "gh api --method DELETE repos/owner/repo/releases/assets/42",
      "gh api -XDELETE repos/owner/repo/issues/1/labels/bug",
    ];

    for (const cmd of destructiveCommands) {
      expect(destructive(parseCommand(cmd)), `destructive(${cmd})`).toBeDefined();
      const grant: TaskGrant[] = [
        { id: "g1", key: JSON.stringify(cmd), target: canonicalPath(WT, WT), label: cmd, at: 0 },
      ];
      const autoRules: PolicyRule[] = (["everywhere", "sandboxed"] as RuleScope[]).map((scope, idx) => ({
        id: `auto-${idx}`,
        match: cmd,
        effect: "auto",
        exact: true,
        scope,
      }));
      for (const sandboxed of [true, false]) {
        const decision = decideWorker(
          shell(cmd),
          ctx({ sandboxed, grants: grant, rules: [...DEFAULT_RULES, ...autoRules] }),
        );
        expect(decision, `${cmd} (sandboxed=${sandboxed})`).toMatchObject({
          effect: "ask",
          request: { everyTime: true, grants: [] },
        });
      }
    }
  });

  it("handles allowed local paths and extracts candidate paths from brief", async () => {
    const { extractBriefPaths, sanitizeAllowedPaths, tooBroad } = await import("../src/policy/sandbox.ts");
    const { PolicyStore } = await import("../src/policy/settings.ts");

    // tooBroad check
    expect(tooBroad("C:\\")).toBe(true);
    expect(tooBroad("/")).toBe(true);

    // sanitizeAllowedPaths
    const mockExists = (p: string) => p.includes("exists");
    const sanitized = sanitizeAllowedPaths(
      ["C:\\exists\\folder", "C:\\does-not-exist", "not-absolute", "C:\\", ' "C:\\exists\\file.txt" '],
      mockExists,
    );
    expect(sanitized).toEqual(
      expect.arrayContaining([
        path.resolve("C:\\exists\\folder"),
        path.resolve("C:\\exists\\file.txt"),
      ]),
    );
    expect(sanitized).not.toContain("C:\\does-not-exist");

    // extractBriefPaths
    const brief = `Compare schemas:
1. "C:\\Users\\sam\\Downloads\\1.3-schema.graphql"
2. 'C:\\Users\\sam\\Downloads\\1.4-schema.graphql'
Also refer to C:\\Data\\samples\\config.json, /tmp/extra.json and ignored words.`;
    const extracted = extractBriefPaths(brief);
    expect(extracted).toContain("C:\\Users\\sam\\Downloads\\1.3-schema.graphql");
    expect(extracted).toContain("C:\\Users\\sam\\Downloads\\1.4-schema.graphql");
    expect(extracted).toContain("C:\\Data\\samples\\config.json");
    expect(extracted).toContain("/tmp/extra.json");

    // PolicyStore allowedPaths
    const storeMap = new Map<string, unknown>();
    const fakeStore = {
      getSetting: <T>(k: string) => storeMap.get(k) as T,
      setSetting: (k: string, v: unknown) => {
        storeMap.set(k, v);
      },
    };
    const policyStore = new PolicyStore({ db: () => fakeStore as any });
    expect(policyStore.sandbox().allowedPaths).toEqual([]);
    policyStore.setSandbox({ allowedPaths: ["C:\\Users\\sam\\Downloads", "C:\\Data"] });
    expect(policyStore.sandbox().allowedPaths).toEqual(["C:\\Users\\sam\\Downloads", "C:\\Data"]);
  });
});
