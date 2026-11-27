/**
 * Phase 0 · 00 harness self-test (no runtime, no model calls): replays known-bad and known-good permission requests
 * through the spike policy, edge cases through the "settled" rule, and credentials through redact().
 *
 *   npm run selftest
 */
import assert from "node:assert/strict";
import type { PermissionRequest, SessionEvent } from "@github/copilot-sdk";
import { redact } from "./lib/log.ts";
import { LOCAL_SHELL_SEGMENTS, scratchPolicy } from "./lib/policy.ts";
import { waitForSettled } from "./lib/wait.ts";

const ROOT = "C:\\wt\\_aria-spike\\wt\\task-1";
const policy = scratchPolicy(ROOT, {
  shellAllowSegments: [
    ...LOCAL_SHELL_SEGMENTS,
    /^git (status|add|commit|diff|log|show|ls-files|rev-parse)(\s|$)/i,
    /^npm (test|run test)(\s|$)/i,
    /^node --test(\s|$)/i,
  ],
});

/** Shapes a shell request the way runtime 1.0.98 sends one for PowerShell (segments split on `;` and `|`). */
function shell(fullCommandText: string, extra: Record<string, unknown> = {}): PermissionRequest {
  const segments = fullCommandText.split(/;|\|/).map((s) => s.trim()).filter(Boolean);
  return {
    kind: "shell",
    fullCommandText,
    intention: "test",
    commands: [{ identifier: fullCommandText, readOnly: false }],
    commandSegments: segments.map((s) => ({ identifier: s.split(/\s+/).slice(0, s.startsWith("git ") ? 2 : 1).join(" "), fullCommandText: s })),
    possiblePaths: [],
    possibleUrls: [],
    hasWriteFileRedirection: false,
    canOfferSessionApproval: false,
    ...extra,
  } as unknown as PermissionRequest;
}

const decide = async (r: PermissionRequest) => (await policy(r, { sessionId: "selftest" })) as { kind: string };
let passed = 0;
async function expect(label: string, request: PermissionRequest, kind: "approve-once" | "reject") {
  assert.equal((await decide(request)).kind, kind, label);
  passed++;
}

// Must be rejected: network, other repos, script blocks, variables, target-moving arguments, sandbox bypass.
await expect("git push to any URL", shell("git push git@github.com:someone/repo.git main"), "reject");
await expect("node runs arbitrary code", shell(`node -e "fetch('https://example.com', {method:'POST'})"`), "reject");
await expect("script block .NET write", shell("Get-ChildItem | ForEach-Object { [IO.File]::WriteAllText('C:\\x.txt','x') }"), "reject");
await expect("npm --prefix via env var", shell('npm test --prefix "$env:USERPROFILE\\Documents\\GitHub\\OtherRepo"'), "reject");
await expect("git log --output", shell("git log --output=$env:TEMP\\x.txt"), "reject");
await expect("git -C other repo", shell('git -C "C:\\Users\\sam\\Documents\\GitHub\\Moonrise" status'), "reject");
await expect("cd ..", shell("Get-ChildItem ..\\..\\"), "reject");
await expect("absolute path outside", shell("Get-Content C:\\Users\\sam\\.copilot\\config.json"), "reject");
await expect("redirect to file", shell("Get-ChildItem > C:\\temp\\out.txt"), "reject");
await expect("sandbox bypass", shell("git status", { requestSandboxBypass: true }), "reject");
await expect("cwd outside", shell("git status", { resolvedWorkingDirectory: "C:\\Users\\sam\\Documents\\GitHub\\Moonrise" }), "reject");
await expect("url in command", shell("git status", { possibleUrls: [{ url: "https://example.com" }] }), "reject");
await expect("read outside", { kind: "read", path: "C:\\Windows\\win.ini", intention: "x" } as unknown as PermissionRequest, "reject");
await expect("mcp call", { kind: "mcp", serverName: "Acme", toolName: "Acme-create_issue", toolTitle: "x", readOnly: false } as unknown as PermissionRequest, "reject");

// Must be approved: what the 05 workers legitimately ran.
await expect("npm test piped", shell("npm test 2>&1 | Select-Object -Last 12"), "approve-once");
await expect("git add + commit with trailer", shell('git add -A; git commit -m "Add power" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"'), "approve-once");
await expect("local reads", shell("Get-Content src\\math.js; git status --short"), "approve-once");
await expect("deep mkdir", shell('New-Item -ItemType Directory -Force -Path "deep\\a\\b\\c"'), "approve-once");
await expect("write inside", { kind: "write", fileName: `${ROOT}\\src\\math.js`, diff: "", intention: "x" } as unknown as PermissionRequest, "approve-once");

// "Settled" rule.
const ts = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const ev = (type: string, data: Record<string, unknown> = {}, msAgo = 0) => ({ type, data, id: type, parentId: null, timestamp: ts(msAgo) }) as unknown as SessionEvent;

assert.equal((await waitForSettled([ev("assistant.turn_start"), ev("session.idle", { mode: "interactive" })], 0, { timeoutMs: 1000 })).outcome, "idle");
passed++;
assert.equal((await waitForSettled([ev("session.task_complete", { success: true }), ev("session.idle", { mode: "autopilot" })], 0, { timeoutMs: 1000 })).outcome, "task_complete");
passed++;
// An old autopilot idle followed by new work must not settle, however long the new work stays quiet.
await assert.rejects(
  waitForSettled([ev("session.idle", { mode: "autopilot" }, 120_000), ev("assistant.turn_start", {}, 119_000), ev("tool.execution_start", {}, 118_000)], 0, { timeoutMs: 600, autopilotGraceMs: 100 }),
  /not settled/,
);
passed++;
// A task_complete from an earlier, reopened cycle doesn't count for the latest idle.
assert.equal(
  (
    await waitForSettled(
      [ev("session.task_complete", {}, 9000), ev("session.idle", { mode: "autopilot" }, 8000), ev("assistant.turn_start", {}, 7000), ev("session.idle", { mode: "autopilot" }, 5000)],
      0,
      { timeoutMs: 1000, autopilotGraceMs: 100 },
    )
  ).outcome,
  "autopilot_idle_without_task_complete",
);
passed++;
// Sub-agent idles are ignored.
await assert.rejects(waitForSettled([ev("assistant.turn_start"), { ...ev("session.idle", { mode: "interactive" }), agentId: "sub" } as SessionEvent], 0, { timeoutMs: 400 }), /not settled/);
passed++;

// Redaction. The fake token is assembled at runtime so the source never contains a token-shaped literal.
const fakeGitHubToken = ["gh", "p_", "a".repeat(36)].join("");
const r = JSON.stringify(
  redact({
    args: ["--api-key", "opaque-credential-1234"],
    text: "Authorization: Bearer abcdefghijklmnop12345",
    url: "https://x.example/mcp?token=supersecretvalue&mode=a",
    headers: { Authorization: "Bearer zzz" },
    note: `token ${fakeGitHubToken} in text`,
  }),
);
for (const secret of ["opaque-credential-1234", "abcdefghijklmnop12345", "supersecretvalue", "Bearer zzz", fakeGitHubToken]) {
  assert.ok(!r.includes(secret), `redact leaked ${secret}`);
  passed++;
}

console.log(`selftest: ${passed} checks passed`);
