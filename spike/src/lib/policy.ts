import path from "node:path";
import type { CopilotClient, PermissionHandler, PermissionRequest } from "@github/copilot-sdk";

export function insideDir(target: string | undefined, root: string): boolean {
  if (!target) return false;
  const rel = path.relative(path.resolve(root), path.resolve(root, target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export interface PolicyOptions {
  /**
   * Shell command segments that may run without asking. Every segment of the command line (the runtime's
   * `commandSegments[].fullCommandText`, e.g. "git status --short") must match one of these, so allow exact
   * operations ("git commit", "npm test"), never a whole program like `git` or `node` (those reach the network).
   */
  shellAllowSegments?: RegExp[];
  /** Called for every request with the decision, for logging. */
  onDecision?: (request: PermissionRequest, decision: "approve" | "reject", why: string) => void;
}

/** Read-only or folder-local PowerShell/cmd segments that are safe inside a scratch folder (paths are checked separately).
 * No cmdlets that take script blocks (ForEach-Object, Where-Object): a script block can run arbitrary .NET code
 * without showing up as another command segment. */
export const LOCAL_SHELL_SEGMENTS: RegExp[] = [
  /^(Get-Content|Get-ChildItem|Test-Path|Select-String|Select-Object|Sort-Object|Measure-Object|Out-Null|Out-String|Format-Table|Format-List|Write-Output|Write-Host|echo|cat|type|ls|dir|pwd|Get-Location)(\s|$)/i,
  /^(New-Item|mkdir|md)(\s|$)/i,
];

/**
 * Text that lets an allowlisted operation reach outside its folder: variables and subexpressions ($env:…, $(…)),
 * script blocks, .NET type literals, escapes, redirection to files, and arguments that move a tool's target or
 * config (--prefix, --output, -C, --git-dir, -c, --exec, …). `2>&1` (stream merge, no file) is allowed. Quoted text is
 * ignored, except that `$` and backticks still count inside double quotes, where PowerShell expands them.
 */
const EXPANDING = /[$`]/;
const STRUCTURAL = /[{}[\]<>]/;
const TARGET_FLAGS = /(^|\s)(--prefix|--output|--output-file|-o|-C|--git-dir|--work-tree|-c|--config|--global|--system|--exec|--exec-path|--upload-pack|--receive-pack|--ext-diff)(\s|=|$)/;

export function hasEscapeHatch(commandText: string): boolean {
  const withoutSingle = commandText.replace(/'(?:[^']|'')*'/g, "''");
  const withoutQuotes = withoutSingle.replace(/"(?:[^"`]|`.)*"/g, '""').replace(/\s2>&1(?=\s|$|\|)/g, " ");
  return EXPANDING.test(withoutSingle) || STRUCTURAL.test(withoutQuotes) || TARGET_FLAGS.test(withoutQuotes);
}

/**
 * Spike policy: reads and writes only inside `root`, allowlisted shell segments only (run in `root`, no sandbox bypass,
 * no absolute paths outside `root`, no `..`, no variables/script blocks/redirection/target-moving arguments), custom
 * tools allowed, everything else (MCP, URLs, memory, ...) rejected. Not the ARIA policy engine, and NOT a sandbox:
 * an approved `npm test` still runs whatever code the agent wrote. Real confinement needs OS-level isolation.
 */
export function scratchPolicy(root: string, options: PolicyOptions = {}): PermissionHandler {
  const { shellAllowSegments = [], onDecision } = options;
  return (request) => {
    const decide = (ok: boolean, why: string) => {
      onDecision?.(request, ok ? "approve" : "reject", why);
      return ok ? ({ kind: "approve-once" } as const) : ({ kind: "reject", feedback: `Not allowed in this session: ${why}` } as const);
    };
    if ("requestSandboxBypass" in request && request.requestSandboxBypass) return decide(false, `${request.kind} asked to bypass the sandbox`);
    switch (request.kind) {
      case "read":
        return decide(insideDir(request.resolvedPath ?? request.path, root), `read ${request.path}`);
      case "write":
        return decide(insideDir(request.resolvedPath ?? request.fileName, root), `write ${request.fileName}`);
      case "shell": {
        const text = request.fullCommandText.trim();
        // Phase 0 finding: for PowerShell, commands[] holds the whole command line as one unparsed entry; the parsed
        // per-program view is commandSegments[] (identifier like "Get-Content" or "git status"). possiblePaths was empty
        // even for relative file arguments, so absolute paths in the text are checked here as a fallback.
        const segments = request.commandSegments?.length
          ? request.commandSegments
          : request.commands.map((c) => ({ identifier: c.identifier, fullCommandText: c.identifier }));
        const absolutePaths = text.match(/[A-Za-z]:[\\/][^\s"';|]*/g) ?? [];
        const ok =
          segments.length > 0 &&
          segments.every((s) => shellAllowSegments.some((re) => re.test(s.fullCommandText.trim()))) &&
          !hasEscapeHatch(text) &&
          (request.resolvedWorkingDirectory === undefined || insideDir(request.resolvedWorkingDirectory, root)) &&
          !/(^|[\s"'\\/])\.\.([\\/]|$)/.test(text) &&
          absolutePaths.every((p) => insideDir(p, root)) &&
          request.possiblePaths.every((p) => insideDir(p, root)) &&
          request.possibleUrls.length === 0;
        return decide(ok, `shell \`${text}\` (${(request as { shellType?: string }).shellType ?? "?"}: ${segments.map((s) => s.identifier).join(", ")})`);
      }
      case "custom-tool":
        return decide(true, `custom tool ${request.toolName}`);
      default:
        return decide(false, `${request.kind} requests`);
    }
  };
}

/** Names of every MCP server the runtime would load from the CLI config and plugins (to disable them in spike sessions). */
export async function realServerNames(client: CopilotClient): Promise<string[]> {
  return (await client.rpc.mcp.discover({})).servers.map((s) => s.name);
}
