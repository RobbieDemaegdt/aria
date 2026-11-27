/** Routing a tool result to the tracker reader's handlers. */
import type { TrackerRoute } from "./types.ts";

export interface MatchedRoute {
  handler: TrackerRoute["handler"];
  mode?: TrackerRoute["mode"];
}

const routeMatches = (route: TrackerRoute, lowerToolName: string): boolean =>
  (route.equals ? route.equals.some((name) => name.toLowerCase() === lowerToolName) : (route.anyOf ?? []).some((s) => lowerToolName.includes(s))) &&
  (route.allOf ?? []).every((s) => lowerToolName.includes(s)) &&
  !(route.noneOf ?? []).some((s) => lowerToolName.includes(s));

/**
 * The handlers a tool result goes to, in route order: the first matching route per handler wins. The name is the
 * lower-cased bare tool name (no server prefix).
 */
export function matchRoutes(routes: readonly TrackerRoute[], lowerToolName: string): MatchedRoute[] {
  const matched: MatchedRoute[] = [];
  for (const route of routes) {
    if (matched.some((m) => m.handler === route.handler)) continue;
    if (!routeMatches(route, lowerToolName)) continue;
    matched.push({ handler: route.handler, ...(route.mode ? { mode: route.mode } : {}) });
  }
  return matched;
}
