import { existsSync } from "node:fs";
import path from "node:path";
import type {
  ConductorSettings,
  ConductorStatus,
  DoctorCheck,
  DoctorReport,
  GitHubState,
  IntegrationsState,
  ModelOption,
  SandboxStatus,
} from "@aria/protocol";
import { findGh } from "../github/access.ts";
import { findCopilotCli } from "../runtime/copilot.ts";
import { describeRuntimeFallback } from "../runtime/fallback.ts";
import type { RuntimeFallback } from "../runtime/types.ts";
import { isNoTracker } from "../trackers/none.ts";
import type { TaskTracker } from "../trackers/types.ts";

const STRIPPED_ENV_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_HOST",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "COPILOT_GITHUB_TOKEN",
];

export interface DoctorDeps {
  /** The task tracker the integrations check names. */
  tracker: () => TaskTracker;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
  platform?: NodeJS.Platform;
  resourcesPath?: string | undefined;
  arch?: string;
  status: () => ConductorStatus;
  conductorSettings: () => ConductorSettings;
  models: () => ModelOption[];
  runtimeAlive: () => Promise<boolean>;
  /** Set while the runtime runs the bundled runtime instead of the CLI found first (a protocol the SDK doesn't speak). */
  runtimeFallback?: () => RuntimeFallback | undefined;
  worktreeRoot: () => { path?: string; error?: string };
  projectsCount: () => number;
  sandbox: () => SandboxStatus;
  github: () => GitHubState;
  integrations: () => IntegrationsState;
  logDir?: string;
}

export function classifyCliSource(
  cliPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): "env" | "path" | "bundled" | "missing" {
  if (!cliPath) return "missing";
  if (env.COPILOT_CLI_PATH && path.normalize(cliPath).toLowerCase() === path.normalize(env.COPILOT_CLI_PATH).toLowerCase()) {
    return "env";
  }
  if (/app\.asar\.unpacked/i.test(cliPath) || /copilot-runtime(?:\.exe)?$/i.test(cliPath)) {
    return "bundled";
  }
  return "path";
}

function classifyRuntimeError(detail: string | undefined): {
  summary: string;
  remediation: string;
  action: NonNullable<DoctorCheck["action"]>;
} {
  const text = (detail ?? "").trim();
  if (/not logged in|sign[\s-]?in|auth|unauthorized|401|403|entitlement|subscription|login/i.test(text)) {
    return {
      summary: "Copilot CLI needs you to sign in with your GitHub Copilot account.",
      remediation: "Open a terminal and run `copilot` once to finish signing in, then click Reconnect.",
      action: "open_copilot_login",
    };
  }
  if (/no model is available/i.test(text)) {
    return {
      summary: "Connected to the Copilot runtime, but no enabled models were returned for your account.",
      remediation: "Verify your GitHub Copilot subscription and sign-in in the `copilot` CLI, then click Reconnect.",
      action: "open_copilot_login",
    };
  }
  return {
    summary: text ? `Copilot runtime connection failed: ${text}` : "ARIA couldn't connect to the Copilot runtime.",
    remediation: "Run `copilot` in a terminal to verify it starts and is signed in, then click Reconnect.",
    action: "open_copilot_login",
  };
}

/**
 * Runs deterministic, zero-cost checks across Copilot CLI, the SDK runtime, environment variables,
 * git worktrees, the Windows sandbox, GitHub CLI, and MCP integrations.
 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const now = deps.now ? deps.now() : Date.now();
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const platform = deps.platform ?? process.platform;
  const resourcesPath =
    deps.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const arch = deps.arch ?? process.arch;

  // The program that runs: the bundled runtime when the CLI found first speaks a protocol the SDK doesn't.
  const fallback = deps.runtimeFallback?.();
  const cliPath = fallback?.to ?? findCopilotCli(env, exists, platform, resourcesPath, arch);
  const cliSource = classifyCliSource(cliPath, env);
  const status = deps.status();
  const alive = await deps.runtimeAlive().catch(() => false);
  const models = deps.models();
  const conductor = deps.conductorSettings();
  const wt = deps.worktreeRoot();
  const projectsCount = deps.projectsCount();
  const sandbox = deps.sandbox();
  const github = deps.github();
  const integrations = deps.integrations();

  const checks: DoctorCheck[] = [];

  // 1. Copilot CLI binary
  if (fallback) {
    const { why, next } = describeRuntimeFallback(fallback);
    const skipped = classifyCliSource(fallback.from, env) === "env" ? "from COPILOT_CLI_PATH" : "found on PATH";
    checks.push({
      id: "copilot_cli",
      title: "Copilot CLI binary",
      category: "required",
      status: "warning",
      summary: `Using the Copilot runtime bundled with ARIA${fallback.version ? ` (${fallback.version})` : ""}: the Copilot CLI ${skipped} ${why}.`,
      detail: `${fallback.to} (instead of ${fallback.from})`,
      remediation: next,
    });
  } else if (cliPath) {
    const sourceLabel =
      cliSource === "env"
        ? "from COPILOT_CLI_PATH"
        : cliSource === "bundled"
          ? "bundled with ARIA"
          : "found on PATH";
    checks.push({
      id: "copilot_cli",
      title: "Copilot CLI binary",
      category: "required",
      status: "ok",
      summary: `Copilot executable ${sourceLabel}.`,
      detail: cliPath,
    });
  } else {
    checks.push({
      id: "copilot_cli",
      title: "Copilot CLI binary",
      category: "required",
      status: status.state === "ready" || alive ? "ok" : "error",
      summary:
        status.state === "ready" || alive
          ? "Using the embedded Copilot SDK runtime."
          : "Copilot CLI executable was not found on PATH or in the packaged runtime.",
      ...(status.state === "ready" || alive
        ? {}
        : {
            remediation:
              "Install GitHub Copilot CLI (`winget install GitHub.Copilot` or `npm i -g @github/copilot`), then click Reconnect.",
            action: "open_copilot_login" as const,
          }),
    });
  }

  // 2. Copilot Runtime & Models
  if ((status.state === "ready" || status.state === "busy") && alive && models.length > 0) {
    const modelName = conductor.model ?? status.model ?? models[0]?.id ?? "default";
    const effort = conductor.reasoningEffort ?? status.reasoningEffort;
    checks.push({
      id: "copilot_runtime",
      title: "Copilot runtime & models",
      category: "required",
      status: "ok",
      summary: `Connected (${models.length} model${models.length === 1 ? "" : "s"} available · ARIA uses ${modelName}${effort ? ` · ${effort}` : ""}).`,
      action: "open_models",
    });
  } else if (status.state === "starting") {
    checks.push({
      id: "copilot_runtime",
      title: "Copilot runtime & models",
      category: "required",
      status: "warning",
      summary: `${status.detail ?? "Starting the Copilot runtime"}…`,
      remediation: "Wait a moment for startup to finish, or click Reconnect if it stays stuck.",
      action: "reconnect",
    });
  } else {
    const diag = classifyRuntimeError(status.detail);
    checks.push({
      id: "copilot_runtime",
      title: "Copilot runtime & models",
      category: "required",
      status: "error",
      summary: diag.summary,
      ...(status.detail ? { detail: status.detail } : {}),
      remediation: diag.remediation,
      action: diag.action,
    });
  }

  // 3. Environment hygiene
  const strippedPresent = Object.keys(env).filter((k) => {
    const upper = k.toUpperCase();
    return (
      (STRIPPED_ENV_KEYS.includes(upper) || upper.startsWith("COPILOT_")) &&
      upper !== "COPILOT_CLI_PATH" &&
      Boolean(env[k]?.trim())
    );
  });
  if (strippedPresent.length > 0) {
    checks.push({
      id: "environment",
      title: "Environment variables",
      category: "optional",
      status: "info",
      summary: `Ignored ${strippedPresent.join(", ")} from the launch environment so ARIA uses your personal CLI sign-in.`,
    });
  } else {
    checks.push({
      id: "environment",
      title: "Environment variables",
      category: "optional",
      status: "ok",
      summary: "No conflicting token variables in the environment.",
    });
  }

  // 4. Git worktree root & Projects
  if (wt.error || !wt.path) {
    checks.push({
      id: "git_worktree",
      title: "Projects & git worktree folder",
      category: "required",
      status: "error",
      summary: "ARIA couldn't create the folder for task worktrees.",
      ...(wt.error ? { detail: wt.error } : {}),
      remediation: "Ensure C:\\wt or your user home directory is writable.",
    });
  } else if (projectsCount === 0) {
    checks.push({
      id: "git_worktree",
      title: "Projects & git worktree folder",
      category: "required",
      status: "warning",
      summary: `Worktree root ready (${wt.path}), but no git repositories are registered yet.`,
      remediation: "Add a local repository folder or clone one from the + button next to PROJECTS in the sidebar.",
    });
  } else {
    checks.push({
      id: "git_worktree",
      title: "Projects & git worktree folder",
      category: "required",
      status: "ok",
      summary: `${projectsCount} project${projectsCount === 1 ? "" : "s"} registered · worktrees in ${wt.path}.`,
    });
  }

  // 5. Sandbox
  if (sandbox.supported && sandbox.enabled) {
    checks.push({
      id: "sandbox",
      title: "Task sandbox",
      category: "recommended",
      status: "ok",
      summary: "Enabled — background tasks can only modify their own worktree and reach allowed package hosts.",
      action: "open_permissions",
    });
  } else if (sandbox.supported && !sandbox.enabled) {
    checks.push({
      id: "sandbox",
      title: "Task sandbox",
      category: "recommended",
      status: "warning",
      summary: "Supported by this PC, but currently turned off.",
      remediation: "Turn on 'Run tasks in the sandbox' in Customize › Permissions for stronger isolation.",
      action: "open_permissions",
    });
  } else {
    checks.push({
      id: "sandbox",
      title: "Task sandbox",
      category: "recommended",
      status: "info",
      summary: `Host sandbox unavailable${sandbox.reason ? ` (${sandbox.reason})` : ""}; tasks use ARIA's safe-list command policy.`,
      action: "open_permissions",
    });
  }

  // 6. GitHub CLI (gh)
  const ghCandidates = findGh(env, exists, platform);
  if (github.status === "ok") {
    checks.push({
      id: "github_cli",
      title: "GitHub CLI (gh)",
      category: "recommended",
      status: "ok",
      summary: `Signed in${github.login ? ` as @${github.login}` : ""} · My Work, PR creation, and CI watches are active.`,
    });
  } else if (github.status === "off") {
    checks.push({
      id: "github_cli",
      title: "GitHub CLI (gh)",
      category: "recommended",
      status: ghCandidates.length > 0 ? "info" : "warning",
      summary:
        ghCandidates.length > 0
          ? `GitHub CLI found (${ghCandidates[0]}), not active in this mode.`
          : "GitHub CLI (gh) not found on PATH.",
      ...(ghCandidates.length === 0
        ? {
            remediation: "Install GitHub CLI (`winget install GitHub.cli`) and run `gh auth login`.",
            action: "open_gh_login" as const,
          }
        : {}),
    });
  } else if (github.status === "no_cli") {
    checks.push({
      id: "github_cli",
      title: "GitHub CLI (gh)",
      category: "recommended",
      status: "warning",
      summary: "GitHub CLI (gh) was not found on PATH or in its usual install folders.",
      remediation: "Install GitHub CLI (`winget install GitHub.cli`) and run `gh auth login` to unlock My Work and PR/CI watches.",
      action: "open_gh_login",
    });
  } else {
    checks.push({
      id: "github_cli",
      title: "GitHub CLI (gh)",
      category: "recommended",
      status: "warning",
      summary: github.message ?? `GitHub CLI status: ${github.status}.`,
      remediation: "Run `gh auth login` in a terminal, then click Try again.",
      action: "open_gh_login",
    });
  }

  // 7. MCP Integrations (the task tracker & Work IQ); with no tracker, Work IQ's, and a line that the tracker is optional
  const noTracker = isNoTracker(deps.tracker());
  const integrationsTitle = noTracker ? "MCP integrations (Work IQ)" : `MCP integrations (${deps.tracker().label} & Work IQ)`;
  const seenServers = integrations.servers.filter((s) => s.seen && s.status !== "disabled");
  const needsAuthServers = seenServers.filter((s) => s.status === "needs-auth");
  const connectedServers = seenServers.filter((s) => s.status === "connected");
  if (needsAuthServers.length > 0) {
    const names = needsAuthServers.map((s) => s.displayName ?? s.name).join(", ");
    checks.push({
      id: "mcp_integrations",
      title: integrationsTitle,
      category: "recommended",
      status: "warning",
      summary: `${needsAuthServers.length} server${needsAuthServers.length === 1 ? " needs" : "s need"} sign-in: ${names}.`,
      remediation: "Open Customize › Integrations and click Sign in next to each server.",
      action: "open_integrations",
    });
  } else if (seenServers.length === 0) {
    checks.push({
      id: "mcp_integrations",
      title: integrationsTitle,
      category: "recommended",
      status: "info",
      summary: "No MCP servers loaded yet.",
      remediation: noTracker
        ? "Open Customize › Integrations to import servers from Copilot CLI (Work IQ Mail/Calendar/Teams, or your task tracker's server)."
        : `Open Customize › Integrations to import servers from Copilot CLI (${deps.tracker().info.serverHint ?? deps.tracker().label}, Work IQ Mail/Calendar/Teams).`,
      action: "open_integrations",
    });
  } else {
    checks.push({
      id: "mcp_integrations",
      title: integrationsTitle,
      category: "recommended",
      status: "ok",
      summary: `${connectedServers.length} of ${seenServers.length} MCP server${seenServers.length === 1 ? "" : "s"} connected (${integrations.tools.filter((t) => t.seen).length} tools).`,
      action: "open_integrations",
    });
  }

  if (noTracker) {
    checks.push({
      id: "task_tracker",
      title: "Task tracker",
      category: "optional",
      status: "info",
      summary: "No task tracker (optional).",
      remediation: "Pick one in Customize › Integrations to read your tasks and register time.",
      action: "open_integrations",
    });
  }

  const hasError = checks.some((c) => c.status === "error");
  const hasWarning = checks.some((c) => c.status === "warning");

  return {
    checkedAt: now,
    overallStatus: hasError ? "error" : hasWarning ? "warning" : "ok",
    ...(cliPath ? { cliPath } : {}),
    cliSource,
    ...(wt.path ? { worktreeRoot: wt.path } : {}),
    ...(deps.logDir ? { logDir: deps.logDir } : {}),
    checks,
  };
}

export function formatDoctorMarkdown(report: DoctorReport): string {
  const icon = (status: DoctorCheck["status"]) =>
    status === "ok" ? "✓" : status === "warning" ? "⚠" : status === "error" ? "✗" : "ℹ";
  const headline =
    report.overallStatus === "ok"
      ? "**System & Copilot CLI Doctor: All required checks passed**"
      : report.overallStatus === "warning"
        ? "**System & Copilot CLI Doctor: Ready with recommendations**"
        : "**System & Copilot CLI Doctor: Action required**";

  const lines = [headline, ""];
  for (const check of report.checks) {
    lines.push(`- ${icon(check.status)} **${check.title}**: ${check.summary}`);
    if (check.detail) lines.push(`  - Detail: \`${check.detail}\``);
    if (check.remediation) lines.push(`  - Fix: ${check.remediation}`);
  }
  return lines.join("\n");
}
