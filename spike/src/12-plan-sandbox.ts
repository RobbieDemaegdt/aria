/**
 * Phase 3 · 12 plan mode in a sandboxed worker. In plan mode the agent writes its plan to its session folder
 * (`session.workspacePath`/plan.md, outside the worktree) and then calls exit_plan_mode (spike 06). Does that work with
 * ARIA's worker tool allowlist and the sandbox (D20)?
 *
 * Two sessions in a throwaway worktree, both sandboxed to it, in plan mode, every permission request approved (so only
 * the allowlist and the sandbox decide): A with exit_plan_mode in the allowlist, B without it. A cheap model call or
 * three each. With --revise, one session C instead: its first plan is sent back with feedback (ARIA's Revise), the
 * second approved. Does the worker revise within its turn, or end the turn?
 *
 *   npx tsx src/12-plan-sandbox.ts [--revise] [--keep]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExitPlanModeRequest, PermissionRequest, SessionEvent } from "@github/copilot-sdk";
import { createRunLog, OUT_DIR, truncate } from "./lib/log.ts";
import { realServerNames } from "./lib/policy.ts";
import { describeModel, hasFlag, pickModel, sleep, startClient, stopClient } from "./lib/runtime.ts";
import { waitForSettled } from "./lib/wait.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Probe", "-c", "user.email=probe@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();

const wtRootExisted = existsSync("C:\\wt");
const base = "C:\\wt\\_aria-plan-probe";
const repo = path.join(base, "repo");
const ownTemp = path.join(base, "tmp");
const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
const bundledGit = readdirSync(localAppData, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith("github-copilot-git-"))
  .map((d) => path.join(localAppData, d.name));
const gitconfig = path.join(os.homedir(), ".gitconfig");

rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
for (const dir of [repo, ownTemp]) mkdirSync(dir, { recursive: true });
git(repo, "init", "-q", "-b", "main");
writeFileSync(path.join(repo, "README.md"), "# plan probe\n");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "init");

const WORKER_TOOLS = ["view", "glob", "grep", "create", "edit", "powershell", "read_powershell", "stop_powershell", "list_powershell", "sql", "task", "read_agent", "list_agents", "write_agent", "task_complete", "ask_user"];

const log = createRunLog("12-plan-sandbox");
const variants = hasFlag("--revise") ? ["C-revise"] : ["A-with-exit_plan_mode", "B-without"];
const REVISION = "Also put a second line 'Bye from ARIA' in NOTES.md.";
const client = await startClient({ extraEnv: { TEMP: ownTemp, TMP: ownTemp } });
const out: Record<string, unknown> = {};
const sessions: string[] = [];
try {
  const choice = await pickModel(client);
  const realServers = await realServerNames(client);
  log.info(`model ${describeModel(choice)}`);

  for (const variant of variants) {
    log.section(variant);
    const wt = path.join(base, "wt", variant);
    git(repo, "worktree", "add", "--quiet", "-b", `aria/${variant}`, wt, "main");
    const events: SessionEvent[] = [];
    const permissions: Array<{ kind: string; what: string; bypass?: boolean }> = [];
    const plans: ExitPlanModeRequest[] = [];
    const tools = [...WORKER_TOOLS, ...(variant.startsWith("B") ? [] : ["exit_plan_mode"])].map((t) => `builtin:${t}`);
    const session = await client.createSession({
      clientName: "aria-spike",
      name: `aria-spike plan probe ${variant}`,
      model: choice.model,
      ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}),
      workingDirectory: wt,
      infiniteSessions: { enabled: true },
      availableTools: tools,
      disabledMcpServers: realServers,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "session.warning" || event.type === "session.error") log.info(`  ${event.type}: ${JSON.stringify(event.data)}`);
      },
      onPermissionRequest: async (request: PermissionRequest) => {
        const bypass = "requestSandboxBypass" in request && request.requestSandboxBypass === true;
        const what =
          request.kind === "shell" ? request.fullCommandText : request.kind === "write" ? (request.resolvedPath ?? request.fileName) : request.kind === "read" ? (request.resolvedPath ?? request.path) : request.kind;
        permissions.push({ kind: request.kind, what, ...(bypass ? { bypass } : {}) });
        log.info(`  permission ${request.kind}${bypass ? " (bypass)" : ""}: ${truncate(what, 200)}`);
        return bypass ? { kind: "reject", feedback: "No bypass." } : { kind: "approve-once" };
      },
      onExitPlanModeRequest: async (request) => {
        plans.push(request);
        log.info(`  exit_plan_mode: ${truncate(request.summary, 200)}`);
        if (variant.startsWith("C") && plans.length === 1) return { approved: false, feedback: REVISION };
        return { approved: true, selectedAction: "autopilot" };
      },
      onUserInputRequest: async () => ({ answer: "Go ahead with your best judgement.", wasFreeform: true }),
      onAutoModeSwitchRequest: () => "no",
    });
    sessions.push(session.sessionId);
    const workspace = session.workspacePath;
    const update = await session.rpc.options.update({
      sandboxConfig: {
        enabled: true,
        addCurrentWorkingDirectory: true,
        allowBypass: false,
        allowDevToolAccess: true,
        sandboxMcpServers: false,
        userPolicy: {
          filesystem: { readwritePaths: [wt], readonlyPaths: [...(existsSync(gitconfig) ? [gitconfig] : []), ...bundledGit, path.join(repo, ".git")] },
          network: { allowOutbound: false },
        },
      },
      sandboxConfigSource: "session_flag",
      shell: { processFlags: ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "RemoteSigned"] },
    });
    await session.rpc.mode.set({ mode: "plan" });
    log.info(`  workspace ${workspace}; sandbox ${JSON.stringify(update)}`);
    const start = events.length;
    await session.send({ prompt: "Add a file NOTES.md to this folder containing the single line 'Hello from ARIA'. Keep the plan to two steps." });
    let outcome: string;
    try {
      outcome = (await waitForSettled(events, start, { timeoutMs: 300_000, autopilotGraceMs: 20_000 })).outcome;
    } catch (error) {
      outcome = `error: ${(error as Error).message}`;
    }
    await sleep(1000);
    const calls = new Map<string, { tool: string; arg?: string; success?: boolean; sandboxed?: boolean; error?: string }>();
    for (const e of events) {
      if (e.agentId) continue;
      if (e.type === "tool.execution_start") {
        const args = (e.data.arguments ?? {}) as Record<string, unknown>;
        calls.set(e.data.toolCallId, { tool: e.data.toolName, ...(typeof args.path === "string" ? { arg: args.path } : typeof args.command === "string" ? { arg: args.command } : {}) });
      } else if (e.type === "tool.execution_complete") {
        const call = calls.get(e.data.toolCallId);
        if (call) Object.assign(call, { success: e.data.success, sandboxed: e.data.sandboxed, ...(e.data.error ? { error: truncate(e.data.error.message, 300) } : {}) });
      }
    }
    const metrics = await session.rpc.usage.getMetrics();
    const notesPath = path.join(wt, "NOTES.md");
    out[variant] = {
      workspace,
      outcome,
      modeAfter: await session.rpc.mode.get(),
      planRequests: plans.map((p) => ({ summary: truncate(p.summary, 200), actions: p.actions, hasPlanContent: Boolean(p.planContent) })),
      // When the turns ended, relative to the plan requests: an idle between two plans means the rejection ended the turn.
      timeline: events
        .filter((e) => !e.agentId && ["session.idle", "exit_plan_mode.requested", "exit_plan_mode.completed", "session.mode_changed", "session.task_complete"].includes(e.type))
        .map((e) => (e.type === "session.idle" ? `idle(${e.data.mode})` : e.type === "session.mode_changed" ? `mode(${JSON.stringify(e.data)})` : e.type)),
      planFile: workspace ? existsSync(path.join(workspace, "plan.md")) : "no workspace",
      notes: existsSync(notesPath) ? readFileSync(notesPath, "utf8") : false,
      calls: [...calls.values()],
      permissions,
      lastMessage: truncate(events.filter((e) => e.type === "assistant.message").map((e) => (e.type === "assistant.message" ? e.data.content : "")).at(-1) ?? "", 300),
      credits: Number(metrics.totalNanoAiu ?? 0) / 1e9,
    };
    log.section(`${variant} result`, out[variant]);
    await session.disconnect().catch(() => {});
  }
} finally {
  if (!hasFlag("--keep")) for (const id of sessions) await client.deleteSession(id).catch(() => {});
  await stopClient(client);
  const report = path.join(OUT_DIR, `12-plan-sandbox${hasFlag("--revise") ? "-revise" : ""}.json`);
  writeFileSync(report, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 1).slice(0, 12000));
  if (!hasFlag("--keep")) {
    for (const variant of variants) {
      try {
        git(repo, "worktree", "remove", "--force", path.join(base, "wt", variant));
      } catch {}
    }
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (!wtRootExisted && existsSync("C:\\wt") && readdirSync("C:\\wt").length === 0) rmSync("C:\\wt", { recursive: true, force: true });
  }
  await log.close();
}
