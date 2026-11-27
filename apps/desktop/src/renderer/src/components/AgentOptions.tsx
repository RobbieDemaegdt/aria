import type { DiscoveredAgentItem } from "@aria/protocol";

export interface AgentGroup {
  label: string;
  agents: DiscoveredAgentItem[];
}

/**
 * Groups user-invocable agents by their source or plugin prefix (`<plugin>:<agent>`) so long agent lists are easy to scan.
 */
export function groupInvocableAgents(
  agents: readonly DiscoveredAgentItem[],
  filterQuery = "",
): AgentGroup[] {
  const invocable = agents.filter((a) => a.userInvocable !== false);
  const q = filterQuery.trim().toLowerCase();
  const filtered = q
    ? invocable.filter(
        (a) =>
          a.id.toLowerCase().includes(q) ||
          a.name.toLowerCase().includes(q) ||
          a.displayName.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          (a.source ?? "").toLowerCase().includes(q),
      )
    : invocable;

  const groups = new Map<string, DiscoveredAgentItem[]>();
  const add = (label: string, item: DiscoveredAgentItem) => {
    const list = groups.get(label) ?? [];
    list.push(item);
    groups.set(label, list);
  };

  for (const a of filtered) {
    if (a.source === "plugin" || a.id.includes(":")) {
      const prefix = a.id.includes(":") ? a.id.split(":")[0]! : "plugin";
      add(`Plugin · ${prefix}`, a);
    } else if (a.source === "project") {
      add("Project agents", a);
    } else if (a.source === "user" || a.source === "custom") {
      add("Custom agents", a);
    } else if (a.source === "builtin") {
      add("Built-in agents", a);
    } else {
      add(a.source ? `${a.source[0]!.toUpperCase()}${a.source.slice(1)} agents` : "Other agents", a);
    }
  }

  return [...groups.entries()].map(([label, list]) => ({
    label,
    agents: [...list].sort((x, y) =>
      (x.displayName || x.name).localeCompare(y.displayName || y.name, undefined, { sensitivity: "base" }),
    ),
  }));
}

export function formatAgentOptionLabel(agent: DiscoveredAgentItem): string {
  const title = agent.displayName || agent.name;
  return title === agent.id
    ? `${title}${agent.source ? ` (${agent.source})` : ""}`
    : `${title} (${agent.id}${agent.source ? ` · ${agent.source}` : ""})`;
}

/**
 * Renders `<option>` and `<optgroup>` elements for an agent `<select>`, preserving any custom/unlisted `currentAgent`
 * value so the controlled select never loses its selection.
 */
export function AgentSelectOptions({
  agents,
  currentAgent,
  filterQuery = "",
  defaultLabel = "Default coding agent",
}: {
  agents: readonly DiscoveredAgentItem[];
  currentAgent: string;
  filterQuery?: string;
  defaultLabel?: string;
}) {
  const invocable = agents.filter((a) => a.userInvocable !== false);
  const groups = groupInvocableAgents(agents, filterQuery);
  const shownIds = new Set(groups.flatMap((g) => g.agents.map((a) => a.id)));
  const currentInCatalog = invocable.find((a) => a.id === currentAgent);

  return (
    <>
      <option value="">{defaultLabel}</option>
      {currentAgent && !shownIds.has(currentAgent) && (
        <option value={currentAgent}>
          {currentInCatalog ? formatAgentOptionLabel(currentInCatalog) : currentAgent}
        </option>
      )}
      {groups.length <= 1
        ? groups.flatMap((g) =>
            g.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {formatAgentOptionLabel(a)}
              </option>
            )),
          )
        : groups.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {formatAgentOptionLabel(a)}
                </option>
              ))}
            </optgroup>
          ))}
    </>
  );
}
