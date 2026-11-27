/**
 * Phase 0 · 05 parallel workers in git worktrees on one client.
 * Phase 0 bullet 2 · §11 #1 (3–5 concurrent sessions on one CopilotClient), #8 (task_complete under load),
 * #9 (Windows: long paths in worktrees, which shell runs commands).
 *
 * Uses a throwaway repo under C:\wt\_aria-spike (never the user's repos). Workers run in autopilot, confined to their
 * worktree by the spike policy, with every real MCP server disabled.
 *
 *   npx tsx src/05-parallel-worktrees.ts [--workers 5] [--keep]
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";
import { createRunLog, eventPrinter } from "./lib/log.ts";
import { LOCAL_SHELL_SEGMENTS, realServerNames, scratchPolicy } from "./lib/policy.ts";
import { argValue, describeModel, hasFlag, pickModel, sleep, startClient, stopClient } from "./lib/runtime.ts";
import { waitForSettled } from "./lib/wait.ts";

const ROOT = "C:\\wt\\_aria-spike";
const REPO = path.join(ROOT, "sandbox");
const WT_ROOT = path.join(ROOT, "wt");
const workers = Math.min(5, Math.max(1, Number(argValue("--workers") ?? 3)));
const DEEP = Array.from({ length: 5 }, (_, i) => `very-long-directory-name-for-windows-path-limit-testing-${String(i + 1).padStart(2, "0")}`).join("/");

const TASKS = [
  { fn: "subtract", body: "a - b", extra: `Also create the file deep/${DEEP}/note.md containing the word deep.` },
  { fn: "multiply", body: "a * b", extra: "" },
  { fn: "divide", body: "b === 0 ? throws : a / b", extra: "divide must throw an Error when b is 0, and the test must cover that." },
  { fn: "power", body: "a ** b", extra: "" },
  { fn: "modulo", body: "a % b", extra: "" },
];

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const execFileAsync = promisify(execFile);

function setupRepo() {
  if (existsSync(REPO)) {
    try {
      git(REPO, "worktree", "prune");
    } catch {
      /* ignore */
    }
  }
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(path.join(REPO, "src"), { recursive: true });
  mkdirSync(path.join(REPO, "test"), { recursive: true });
  git(REPO, "init", "-q", "-b", "main");
  git(REPO, "config", "user.name", "ARIA Spike");
  git(REPO, "config", "user.email", "aria-spike@example.invalid");
  git(REPO, "config", "core.longpaths", "true");
  git(REPO, "config", "core.autocrlf", "false");
  writeFileSync(path.join(REPO, "package.json"), `${JSON.stringify({ name: "sandbox", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
  writeFileSync(path.join(REPO, "src", "math.js"), "export const add = (a, b) => a + b;\n");
  writeFileSync(
    path.join(REPO, "test", "add.test.js"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/math.js";\n\ntest("add", () => assert.equal(add(2, 3), 5));\n',
  );
  git(REPO, "add", "-A");
  git(REPO, "commit", "-q", "-m", "init");
  const trees: string[] = [];
  for (let i = 1; i <= workers; i++) {
    const wt = path.join(WT_ROOT, `task-${i}`);
    git(REPO, "worktree", "add", "-q", wt, "-b", `aria/spike-task-${i}`, "main");
    trees.push(wt);
  }
  return trees;
}

interface Sample {
  t: number;
  processes: number;
  mb: number;
  cpuPct: number;
  names: string[];
}

/** Samples memory/CPU of this process's descendants (the runtime and whatever it spawns), excluding the sampler and tsx's esbuild. */
function startSampler(rootPid: number) {
  const samples: Sample[] = [];
  // CPU is tracked per process (pid + creation time): summing lifetime counters over a changing process set would let
  // exiting processes cancel out the CPU used by the ones that keep running. CPU of processes that start and exit
  // between two samples is not seen at all, so the figures are a lower bound.
  let previous: { t: number; cpu: Map<string, number> } | undefined;
  let stop = false;
  let firstSample: () => void = () => {};
  const ready = new Promise<void>((resolve) => (firstSample = resolve));
  const script = `
$all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,WorkingSetSize,KernelModeTime,UserModeTime,CreationDate
$kids = @{}; foreach ($p in $all) { if (-not $kids.ContainsKey([int]$p.ParentProcessId)) { $kids[[int]$p.ParentProcessId] = @() }; $kids[[int]$p.ParentProcessId] += $p }
$out = @(); $queue = New-Object System.Collections.Queue; $queue.Enqueue(${rootPid})
while ($queue.Count -gt 0) { $id = $queue.Dequeue(); foreach ($c in $kids[[int]$id]) { if ($c.ProcessId -eq $PID -or $c.Name -eq 'esbuild.exe') { continue }; $out += [pscustomobject]@{ id = "$($c.ProcessId)@$($c.CreationDate.Ticks)"; n = $c.Name; ws = $c.WorkingSetSize; cpu = $c.KernelModeTime + $c.UserModeTime }; $queue.Enqueue([int]$c.ProcessId) } }
ConvertTo-Json -Compress -InputObject @($out)`;
  const loop = (async () => {
    while (!stop) {
      try {
        const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
        const list = JSON.parse(stdout.trim() || "[]") as Array<{ id: string; n: string; ws: number; cpu: number }>;
        const now = Date.now();
        const cpu = new Map(list.map((p) => [p.id, Number(p.cpu) / 1e4])); // 100 ns ticks → ms
        let usedMs = 0;
        for (const [id, ms] of cpu) usedMs += previous?.cpu.has(id) ? Math.max(0, ms - previous.cpu.get(id)!) : previous ? ms : 0;
        const cpuPct = previous ? (usedMs / (now - previous.t) / os.cpus().length) * 100 : 0;
        previous = { t: now, cpu };
        samples.push({ t: now, processes: list.length, mb: Math.round(list.reduce((s, p) => s + Number(p.ws), 0) / 1048576), cpuPct: Math.round(cpuPct * 10) / 10, names: [...new Set(list.map((p) => p.n))] });
        firstSample();
      } catch {
        /* a failed sample is skipped */
      }
      await sleep(1000);
    }
  })();
  return {
    samples,
    ready,
    async stop() {
      stop = true;
      await loop;
    },
  };
}

const log = createRunLog(`05-parallel-worktrees-${workers}`);
const trees = setupRepo();
log.info(`sandbox repo ${REPO}; ${workers} worktrees: ${trees.join(", ")}`);

const client = await startClient();
const sampler = startSampler(process.pid);
const sessions: CopilotSession[] = [];
try {
  const choice = await pickModel(client);
  const realServers = await realServerNames(client);
  log.info(`model ${describeModel(choice)}`);
  await sampler.ready;
  await sleep(2500);
  const idleBaseline = sampler.samples.at(-1);
  log.info(`idle baseline (runtime started, no sessions): ${JSON.stringify(idleBaseline)}`);

  const runs = trees.map(async (wt, index) => {
    const task = TASKS[index]!;
    const label = `w${index + 1}`;
    const events: SessionEvent[] = [];
    const decisions: string[] = [];
    const print = eventPrinter(log, label);
    const started = Date.now();
    const session = await client.createSession({
      clientName: "aria-spike",
      model: choice.model,
      ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}),
      workingDirectory: wt,
      disabledMcpServers: realServers,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "session.task_complete" || event.type === "session.idle" || event.type === "session.error" || event.type === "tool.execution_start") print(event);
        else log.record(`event:${label}`, event);
      },
      onPermissionRequest: scratchPolicy(wt, {
        // Exact operations only: a bare `git` or `node` would allow pushes or arbitrary network code.
        shellAllowSegments: [
          ...LOCAL_SHELL_SEGMENTS,
          /^git (status|add|commit|diff|log|show|ls-files|rev-parse)(\s|$)/i,
          /^npm (test|run test)(\s|$)/i,
          /^node --test(\s|$)/i,
        ],
        onDecision: (r, d, why) => {
          decisions.push(`${d}: ${why}`);
          log.info(`  [${label}] ${d} ${why}`);
        },
      }),
      onAutoModeSwitchRequest: () => "no",
    });
    sessions.push(session);
    await session.rpc.mode.set({ mode: "autopilot" });
    const prompt = [
      `Add an exported function \`${task.fn}(a, b)\` (${task.body}) to src/math.js and a test file test/${task.fn}.test.js using node:test, like test/add.test.js.`,
      task.extra,
      "Run `npm test` and make sure it passes. Then commit all changes with git (message: " + `"Add ${task.fn}"` + "). Do not push.",
    ]
      .filter(Boolean)
      .join(" ");
    const start = events.length;
    await session.send({ prompt });
    const settled = await waitForSettled(events, start, { timeoutMs: 600_000 });
    await sleep(1500);
    const metrics = await session.rpc.usage.getMetrics();
    const shellTools = [...new Set(events.filter((e) => e.type === "tool.execution_start").map((e) => (e.type === "tool.execution_start" ? e.data.toolName : "")))];
    const taskComplete = events.find((e) => e.type === "session.task_complete");
    let lastCommit = "";
    let diffStat = "";
    try {
      lastCommit = git(wt, "log", "-1", "--format=%s");
      diffStat = git(wt, "diff", "--shortstat", "main...HEAD");
    } catch (e) {
      lastCommit = `git failed: ${(e as Error).message}`;
    }
    let ourTest = "";
    try {
      execFileSync(process.execPath, ["--test"], { cwd: wt, stdio: "pipe" });
      ourTest = "pass";
    } catch {
      ourTest = "FAIL";
    }
    return {
      worker: label,
      fn: task.fn,
      seconds: Math.round((Date.now() - started) / 1000),
      outcome: settled.outcome,
      taskComplete: taskComplete && taskComplete.type === "session.task_complete" ? `${taskComplete.data.success}: ${taskComplete.data.summary?.slice(0, 100)}` : "none",
      lastCommit,
      diffStat,
      testsAfter: ourTest,
      tools: shellTools.join(","),
      // shellType is sent by runtime 1.0.98 but missing from the SDK 1.0.22 typings.
      shells: [...new Set(events.flatMap((e) => (e.type === "permission.requested" && e.data.permissionRequest.kind === "shell" ? [(e.data.permissionRequest as { shellType?: string }).shellType ?? "?"] : [])))].join(","),
      rejected: decisions.filter((d) => d.startsWith("reject")).length,
      premiumRequests: metrics.totalPremiumRequestCost,
      aiCredits: Number(((metrics.totalNanoAiu ?? 0) / 1e9).toFixed(3)),
      events: events.length,
    };
  });

  const results = await Promise.allSettled(runs);
  const ok = results.map((r, i) => (r.status === "fulfilled" ? r.value : { worker: `w${i + 1}`, error: String(r.reason) }));
  log.section("workers", ok);
  console.table(ok);

  const deepFile = path.join(trees[0]!, "deep", ...DEEP.split("/"), "note.md");
  log.info(`deep path (${deepFile.length} chars) exists: ${existsSync(deepFile)}; tracked in git: ${(() => {
    try {
      return git(trees[0]!, "ls-files", "deep").split("\n").filter(Boolean).length > 0;
    } catch (e) {
      return `git failed: ${(e as Error).message}`;
    }
  })()}`);

  await sampler.stop();
  const s = sampler.samples;
  const peak = s.reduce((m, x) => (x.mb > m.mb ? x : m), s[0] ?? { t: 0, processes: 0, mb: 0, cpuPct: 0, names: [] });
  const avgCpu = s.length ? Math.round(s.reduce((a, x) => a + x.cpuPct, 0) / s.length) : 0;
  const summary = {
    workers,
    samples: s.length,
    idleBaselineMb: idleBaseline?.mb,
    peakMb: peak.mb,
    peakProcesses: Math.max(0, ...s.map((x) => x.processes)),
    avgCpuPct: avgCpu,
    maxCpuPct: Math.max(0, ...s.map((x) => x.cpuPct)),
    processNames: [...new Set(s.flatMap((x) => x.names))],
    nodeHeapMb: Math.round(process.memoryUsage().rss / 1048576),
    cores: os.cpus().length,
  };
  log.section("resources", { summary, samples: s });
  console.log(JSON.stringify(summary));
} finally {
  await sampler.stop().catch(() => {});
  for (const session of sessions) {
    await session.disconnect().catch(() => {});
    if (!hasFlag("--keep")) await client.deleteSession(session.sessionId).catch(() => {});
  }
  await stopClient(client);
  if (!hasFlag("--keep")) {
    for (const wt of trees) {
      try {
        git(REPO, "worktree", "remove", "--force", wt);
      } catch {
        /* ignore */
      }
    }
    rmSync(ROOT, { recursive: true, force: true });
    log.info(`removed ${ROOT}`);
  }
  await log.close();
}
