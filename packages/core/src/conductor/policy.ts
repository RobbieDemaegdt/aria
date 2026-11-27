import path from "node:path";
import { classifyTool, serverWirePrefix } from "../integrations/scope.ts";
import type { McpRule } from "../integrations/rules.ts";
import type { PermissionAsk, PermissionVerdict, PolicyDecider } from "../runtime/types.ts";

export function insideDir(target: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(root, target));
  // Only a real parent step leaves the folder: `...` or `..foo` are names inside it (Go's `./...` pattern).
  return rel === "" || (!/^\.\.(?:[\\/]|$)/.test(rel) && !path.isAbsolute(rel));
}

const READ_ONLY_VERSION = "ARIA's chat can only read in this version. Changes arrive with background tasks in a later version.";

/**
 * The Conductor's permission rules (PLAN.md §4.3, §4.13, D22), behind the PolicyDecider interface. Second line of
 * defense: the scope (`availableTools`) already leaves out every tool that could change something.
 *
 * An MCP tool runs only when your rule for it is Auto **and** its own name reads, checked here from the request alone:
 * the tool's name is the wire name without the prefix of the server the request names (not split by the catalog), and
 * that server and wire name have to be the catalog's. So no rule, catalog or scope can let a write through (D22).
 */
export class ConductorPolicy implements PolicyDecider {
  constructor(
    private readonly deps: {
      /** Your rule for an MCP tool for ARIA, by its server and wire name (Customize › Integrations). */
      mcp: (server: string, wireName: string) => McpRule | undefined;
      /** Folders the Conductor may read: the registered projects. */
      readableRoots: () => string[];
    },
  ) {}

  decide(ask: PermissionAsk): PermissionVerdict {
    switch (ask.kind) {
      case "custom-tool":
        return { approve: true };
      case "mcp":
        return this.mcp(ask);
      case "read":
        return this.deps.readableRoots().some((root) => insideDir(ask.path, root))
          ? { approve: true }
          : { approve: false, reason: "ARIA only reads files inside your registered projects." };
      default:
        return { approve: false, reason: READ_ONLY_VERSION };
    }
  }

  private mcp(ask: Extract<PermissionAsk, { kind: "mcp" }>): PermissionVerdict {
    const prefix = serverWirePrefix(ask.server);
    const tool = ask.tool.startsWith(prefix) ? ask.tool.slice(prefix.length) : undefined;
    const rule = tool !== undefined ? this.deps.mcp(ask.server, ask.tool) : undefined;
    if (tool === undefined || !rule || rule.tool !== tool) return { approve: false, reason: `${ask.tool} isn't one of ARIA's read tools. ${READ_ONLY_VERSION}` };
    // The backstop, from the name alone (D22): whatever a rule says, ARIA's own session only reads; writes go through request_action.
    if (classifyTool(tool) !== "read") return { approve: false, reason: `${ask.tool} changes things, which ARIA can't do on its own: use request_action to propose it on an action card.` };
    if (rule.effect === "auto") return { approve: true };
    if (rule.effect === "ask") return { approve: false, reason: `${ask.tool} needs an action card: use request_action to propose it so the user can confirm.` };
    return { approve: false, reason: `The user turned ${ask.tool} off for ARIA in Customize › Integrations.` };
  }
}
