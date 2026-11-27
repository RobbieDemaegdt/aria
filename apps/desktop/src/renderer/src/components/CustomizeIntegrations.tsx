import type {
  IntegrationScope,
  IntegrationServer,
  IntegrationTool,
  MarketplaceCatalogPlugin,
  McpServerTransport,
  ToolRuleEffect,
} from "@aria/protocol";
import { Activity, ChevronDown, ChevronRight, Download, KeyRound, LogIn, Play, Plus, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useFocusLater } from "../focus";
import { canSignIn, effectLabel, filterTools, noteShown, orderedServers, runningTasks, shortDate, sourceLabel, statusLabel, workDataWarning, yourRules } from "../integrations";
import { useAria, useTracker } from "../store";
import { stopChoice } from "../trackerSetup";
import { TrackerSection, UseAsTrackerDialog } from "./CustomizeTracker";

const button = "inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-fg disabled:opacity-40";
const field = "rounded-md border border-line bg-canvas px-2 py-1 text-xs outline-none focus:border-accent";
const CLASS_TONE: Record<IntegrationTool["cls"], string> = { read: "text-ok", write: "text-warn", destructive: "text-bad", unrestricted: "text-bad" };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function SignIn({ server }: { server: IntegrationServer }) {
  const state = useAria((s) => s.integrations.signIn);
  const runtimeUp = useAria((s) => s.integrations.runtimeUp);
  const signIn = useAria((s) => s.signIn);
  const cancelSignIn = useAria((s) => s.cancelSignIn);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Its own flag: Cancel works while the Sign in click is still on its way (the runtime is starting the sign-in).
  const [cancelling, setCancelling] = useState(false);
  const mine = state?.server === server.name ? state : undefined;
  const open = (s: typeof state) => s?.state === "starting" || s?.state === "waiting";
  const busyElsewhere = open(state) && !mine;
  const act = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setError(await action());
    setBusy(false);
  };
  const cancel = async () => {
    setCancelling(true);
    setError(await cancelSignIn());
    setCancelling(false);
  };
  if (open(mine)) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="sign-in-state" data-state={mine!.state}>
        <span className="text-muted">
          {mine!.state === "starting" ? "Starting the sign-in…" : `Finish signing in in your browser${mine!.host ? ` (${mine!.host})` : ""}.`}
        </span>
        <button data-testid="sign-in-cancel" className={button} disabled={cancelling} onClick={() => void cancel()}>
          Cancel
        </button>
        {error && <span className="text-bad">{error}</span>}
      </div>
    );
  }
  if (mine?.state === "connected") {
    return (
      <span className="text-xs text-ok" data-testid="sign-in-state" data-state="connected">
        Signed in.
      </span>
    );
  }
  if (!canSignIn(server)) return null;
  const ended = mine ? { failed: "Sign-in failed", timed_out: "Sign-in timed out", cancelled: "Sign-in cancelled" }[mine.state as "failed" | "timed_out" | "cancelled"] : undefined;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {ended && (
        <span className="text-warn" data-testid="sign-in-state" data-state={mine!.state}>
          {ended}
          {mine!.message ? `: ${mine!.message}` : ""}
        </span>
      )}
      <button
        data-testid="sign-in"
        className={button}
        disabled={busy || busyElsewhere || !runtimeUp}
        title={busyElsewhere ? "Another sign-in is waiting" : "Opens the sign-in page in your browser"}
        onClick={() => void act(() => signIn(server.name))}
      >
        <LogIn className="h-3 w-3" /> {ended ? "Try again" : "Sign in"}
      </button>
      {error && <span className="text-bad">{error}</span>}
    </div>
  );
}

const scopeName = (scope: IntegrationScope) => (scope === "aria" ? "ARIA" : "Tasks");

/**
 * A server that's no longer in your setup (renamed or removed in the CLI): your rules for it are kept until you move them
 * to another server or forget it. What a move did is said here, under the server.
 */
function GoneServer({ server, others }: { server: IntegrationServer; others: IntegrationServer[] }) {
  const tools = useAria((s) => s.integrations.tools);
  const moveIntegrationRules = useAria((s) => s.moveIntegrationRules);
  const forgetIntegrationServer = useAria((s) => s.forgetIntegrationServer);
  const [to, setTo] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keep, focusKeep] = useFocusLater<HTMLButtonElement>();
  const [forget, focusForget] = useFocusLater<HTMLButtonElement>();
  const mine = yourRules(tools, server.name);
  const move = async () => {
    const target = to;
    const before = yourRules(useAria.getState().integrations.tools, server.name).length;
    setBusy(true);
    setError(null);
    setMoved(null);
    const failed = await moveIntegrationRules(server.name, target);
    setBusy(false);
    if (failed) {
      setError(failed);
      return;
    }
    // The page's state is the engine's answer by now (its event comes before the reply).
    const left = yourRules(useAria.getState().integrations.tools, server.name);
    const count = before - left.length;
    const stayed = left.map((r) => `${r.tool} (${scopeName(r.scope)})`).join(", ");
    setMoved(`Moved ${count} of your rules to ${target}.${left.length ? ` Still here, because ${target} has no tool of that name: ${stayed}.` : ""}`);
    setTo("");
  };
  return (
    <div className="space-y-1 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-warn">
          Renamed in the CLI? {mine.length ? "Your rules for it are kept: move them to its new name, or forget it." : "None of your rules are for it: you can forget it."}
        </span>
        {mine.length > 0 && (
          <>
            <select aria-label="Move its rules to" data-testid="move-rules-to" className={field} value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Move its rules to…</option>
              {others.map((o) => (
                <option key={o.name} value={o.name}>
                  {o.name}
                </option>
              ))}
            </select>
            <button data-testid="move-rules" className={button} disabled={!to || busy} onClick={() => void move()}>
              Move
            </button>
          </>
        )}
        {confirm ? (
          <>
            <button
              ref={keep}
              data-testid="forget-server-keep"
              className={button}
              onClick={() => {
                focusForget();
                setConfirm(false);
              }}
            >
              Keep
            </button>
            <button data-testid="forget-server-confirm" className={`${button} border-bad/60 text-bad hover:border-bad`} onClick={async () => setError(await forgetIntegrationServer(server.name))}>
              Forget it and its rules
            </button>
          </>
        ) : (
          <button
            ref={forget}
            data-testid="forget-server"
            className={button}
            onClick={() => {
              focusKeep();
              setConfirm(true);
            }}
          >
            Forget…
          </button>
        )}
      </div>
      {moved && (
        <div className="text-ok" data-testid="move-rules-result">
          {moved}
        </div>
      )}
      {error && <div className="text-bad">{error}</div>}
    </div>
  );
}

function RuleSelect({ tool, scope, onChanged }: { tool: IntegrationTool; scope: IntegrationScope; onChanged: (scope: IntegrationScope) => void }) {
  const setIntegrationRule = useAria((s) => s.setIntegrationRule);
  const [error, setError] = useState<string | null>(null);
  const [why, setWhy] = useState(false);
  const rule = tool.rules[scope];
  // The general rules are said once above the list; this row's own note shows when it's different here. Where the select
  // has no Auto, "Why?" opens it (D34: the page says why a tool can't be set to Auto).
  const shown = noteShown(scope, tool);
  const askWhy = Boolean(rule.note) && !shown && !rule.allowed.includes("auto");
  const change = async (effect: ToolRuleEffect | null) => {
    const failed = await setIntegrationRule(tool.server, tool.wireName, scope, effect);
    setError(failed);
    if (!failed) onChanged(scope);
  };
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="flex items-center gap-1">
        {/* Narrow: the column headings are gone, so each select says whose it is. */}
        <span className="w-12 shrink-0 text-muted @3xl:hidden">{scopeName(scope)}</span>
        <select
          aria-label={`${scopeName(scope)}: ${tool.tool}`}
          data-testid={`rule-${scope}`}
          className={`${field} min-w-0`}
          value={rule.effect}
          disabled={rule.allowed.length === 1}
          onChange={(e) => void change(e.target.value as ToolRuleEffect)}
        >
          {rule.allowed.map((effect) => (
            <option key={effect} value={effect}>
              {effectLabel(effect, scope, tool.cls)}
            </option>
          ))}
        </select>
        {rule.isDefault ? (
          <span className="shrink-0 text-[11px] text-muted">default</span>
        ) : (
          <button data-testid={`rule-${scope}-reset`} className="shrink-0 text-[11px] text-accent hover:underline" onClick={() => void change(null)}>
            Reset
          </button>
        )}
        {askWhy && (
          <button data-testid={`rule-${scope}-why`} aria-expanded={why} className="shrink-0 text-[11px] text-muted underline decoration-dotted hover:text-fg" onClick={() => setWhy(!why)}>
            Why?
          </button>
        )}
      </div>
      {rule.note && (shown || (askWhy && why)) && (
        <div className="text-[11px] text-muted" data-testid={`rule-${scope}-note`}>
          {rule.note}
        </div>
      )}
      {error && <div className="text-[11px] text-bad">{error}</div>}
    </div>
  );
}

function ToolRow({ tool, server, onChanged }: { tool: IntegrationTool; server: IntegrationServer; onChanged: (scope: IntegrationScope) => void }) {
  const tracker = useTracker();
  const warning = workDataWarning(tool, server, tracker);
  return (
    // Wide: a row of its group's grid, so the ARIA and Tasks columns line up down the list. Narrow: stacked.
    <div className="grid gap-y-1 border-t border-line/60 py-1.5 text-xs @3xl:col-span-3 @3xl:grid-cols-subgrid @3xl:items-start" data-testid="integration-tool" data-wire={tool.wireName}>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-mono" title={tool.wireName}>
            {tool.tool}
          </span>
          <span className={`shrink-0 ${CLASS_TONE[tool.cls]}`} data-testid="tool-class">
            {tool.cls}
          </span>
          {!tool.seen && <span className="shrink-0 text-warn">not seen since {shortDate(tool.lastSeen)}</span>}
        </div>
        {tool.description && <div className="line-clamp-2 text-[11px] text-muted">{tool.description}</div>}
        {warning && (
          <div className="mt-0.5 flex items-start gap-1 text-[11px] text-warn" data-testid="rule-warning">
            <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
            {warning}
          </div>
        )}
      </div>
      <RuleSelect tool={tool} scope="aria" onChanged={onChanged} />
      <RuleSelect tool={tool} scope="tasks" onChanged={onChanged} />
    </div>
  );
}

function MarketplacesAndPluginsSection() {
  const integrations = useAria((s) => s.integrations);
  const addMarketplace = useAria((s) => s.addMarketplace);
  const removeMarketplace = useAria((s) => s.removeMarketplace);
  const browseMarketplace = useAria((s) => s.browseMarketplace);
  const refreshMarketplaces = useAria((s) => s.refreshMarketplaces);
  const installPlugin = useAria((s) => s.installPlugin);
  const uninstallPlugin = useAria((s) => s.uninstallPlugin);
  const updatePlugin = useAria((s) => s.updatePlugin);
  const setPluginEnabled = useAria((s) => s.setPluginEnabled);
  const addPluginDirectory = useAria((s) => s.addPluginDirectory);
  const removePluginDirectory = useAria((s) => s.removePluginDirectory);

  const [mpSource, setMpSource] = useState("");
  const [mpBusy, setMpBusy] = useState(false);
  const [mpStatus, setMpStatus] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [browsed, setBrowsed] = useState<Record<string, MarketplaceCatalogPlugin[]>>({});
  const [browsing, setBrowsing] = useState<Record<string, boolean>>({});
  const [openMp, setOpenMp] = useState<Record<string, boolean>>({});
  const [forceRemoveMp, setForceRemoveMp] = useState<{ name: string; deps: string[] } | null>(null);

  const [pluginSpec, setPluginSpec] = useState("");
  const [pluginDirInput, setPluginDirInput] = useState("");
  const [pluginBusy, setPluginBusy] = useState(false);
  const [pluginStatus, setPluginStatus] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const marketplaces = integrations.marketplaces ?? [];
  const plugins = integrations.plugins ?? [];
  const pluginDirs = integrations.pluginDirectories ?? [];

  const handleAddMarketplace = async () => {
    const src = mpSource.trim();
    if (!src) return;
    setMpBusy(true);
    setMpStatus(null);
    const res = await addMarketplace(src);
    setMpBusy(false);
    if (res.error) {
      setMpStatus({ tone: "bad", text: res.error });
      return;
    }
    setMpSource("");
    setMpStatus({ tone: "ok", text: `Added marketplace “${res.name ?? src}”.` });
  };

  const handleBrowse = async (name: string) => {
    const nextOpen = !openMp[name];
    setOpenMp((prev) => ({ ...prev, [name]: nextOpen }));
    if (!nextOpen || browsed[name]) return;
    setBrowsing((prev) => ({ ...prev, [name]: true }));
    const res = await browseMarketplace(name);
    setBrowsing((prev) => ({ ...prev, [name]: false }));
    if (res.error) {
      setMpStatus({ tone: "bad", text: res.error });
      return;
    }
    setBrowsed((prev) => ({ ...prev, [name]: res.plugins ?? [] }));
  };

  const handleRemoveMarketplace = async (name: string, force?: boolean) => {
    setMpBusy(true);
    setMpStatus(null);
    const res = await removeMarketplace(name, force);
    setMpBusy(false);
    if (res.error) {
      setMpStatus({ tone: "bad", text: res.error });
      return;
    }
    if (!res.removed && res.dependentPlugins?.length) {
      setForceRemoveMp({ name, deps: res.dependentPlugins });
      return;
    }
    setForceRemoveMp(null);
    setMpStatus({ tone: "ok", text: `Removed marketplace “${name}”.` });
  };

  const handleInstallPlugin = async (spec: string) => {
    const clean = spec.trim();
    if (!clean) return;
    setPluginBusy(true);
    setPluginStatus(null);
    const res = await installPlugin(clean);
    setPluginBusy(false);
    if (res.error) {
      setPluginStatus({ tone: "bad", text: res.error });
      return;
    }
    if (spec === pluginSpec) setPluginSpec("");
    const extra = res.postInstallMessage ? ` ${res.postInstallMessage}` : "";
    setPluginStatus({
      tone: "ok",
      text: `Installed plugin “${res.plugin?.name ?? clean}” (${plural(res.skillsInstalled ?? 0, "skill")} discovered).${extra}`,
    });
  };

  const handleUpdatePlugin = async (name?: string) => {
    setPluginBusy(true);
    setPluginStatus(null);
    const res = await updatePlugin(name);
    setPluginBusy(false);
    if (res.error) {
      setPluginStatus({ tone: "bad", text: res.error });
      return;
    }
    setPluginStatus({ tone: "ok", text: res.message ?? "Updated plugins." });
  };

  return (
    <div className="space-y-5">
      <section className="space-y-2.5 rounded-lg border border-line bg-panel p-4" data-testid="integrations-marketplaces">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-medium">Plugin marketplaces</div>
            <div className="text-xs text-muted">
              Register marketplaces (GitHub `owner/repo`, URL, or local path) and browse their catalogs to install agent plugins.
            </div>
          </div>
          <button
            data-testid="marketplace-refresh-all"
            className={button}
            disabled={mpBusy || !integrations.runtimeUp}
            onClick={async () => {
              setMpBusy(true);
              const err = await refreshMarketplaces();
              setMpBusy(false);
              setMpStatus(err ? { tone: "bad", text: err } : { tone: "ok", text: "Refreshed marketplace catalogs." });
            }}
          >
            <RefreshCw className="h-3 w-3" /> Refresh catalogs
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <input
            data-testid="marketplace-add-input"
            className={`${field} w-72`}
            placeholder="e.g. microsoft/work-iq or owner/repo"
            value={mpSource}
            onChange={(e) => setMpSource(e.target.value)}
          />
          <button
            data-testid="marketplace-add-btn"
            className={button}
            disabled={mpBusy || !mpSource.trim() || !integrations.runtimeUp}
            onClick={() => void handleAddMarketplace()}
          >
            <Plus className="h-3 w-3" /> Add marketplace
          </button>
        </div>

        {mpStatus && (
          <div className={`text-xs ${mpStatus.tone === "ok" ? "text-ok" : "text-bad"}`} data-testid="marketplace-status">
            {mpStatus.text}
          </div>
        )}

        {forceRemoveMp && (
          <div className="flex flex-wrap items-center gap-2 rounded border border-warn/50 bg-warn/5 p-2 text-xs" data-testid="marketplace-force-remove">
            <span className="text-warn">
              Marketplace “{forceRemoveMp.name}” has installed plugins ({forceRemoveMp.deps.join(", ")}). Remove it and uninstall them?
            </span>
            <button
              data-testid="marketplace-force-confirm"
              className={`${button} border-bad/60 text-bad`}
              onClick={() => void handleRemoveMarketplace(forceRemoveMp.name, true)}
            >
              Remove marketplace &amp; plugins
            </button>
            <button className={button} onClick={() => setForceRemoveMp(null)}>
              Cancel
            </button>
          </div>
        )}

        {marketplaces.length === 0 ? (
          <div className="text-xs text-muted">No marketplaces registered yet.</div>
        ) : (
          <div className="space-y-1.5">
            {marketplaces.map((mp) => {
              const isOpen = Boolean(openMp[mp.name]);
              const catalog = browsed[mp.name] ?? [];
              return (
                <div key={mp.name} className="space-y-1.5 border-t border-line/60 pt-2 text-xs" data-testid="marketplace-row" data-marketplace={mp.name}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{mp.name}</span>
                    <span className="text-muted">{mp.source}</span>
                    {mp.isDefault && <span className="rounded border border-line px-1.5 py-0.5 text-[11px] text-muted">default</span>}
                    {mp.managed && <span className="rounded border border-line px-1.5 py-0.5 text-[11px] text-muted">managed</span>}
                    <div className="ml-auto flex items-center gap-1.5">
                      <button
                        data-testid="marketplace-browse"
                        className={button}
                        disabled={!integrations.runtimeUp}
                        onClick={() => void handleBrowse(mp.name)}
                      >
                        {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} Browse plugins
                      </button>
                      {!mp.isDefault && !mp.managed && (
                        <button
                          data-testid="marketplace-remove"
                          className={`${button} text-bad hover:border-bad`}
                          disabled={mpBusy || !integrations.runtimeUp}
                          onClick={() => void handleRemoveMarketplace(mp.name)}
                        >
                          <Trash2 className="h-3 w-3" /> Remove
                        </button>
                      )}
                    </div>
                  </div>
                  {isOpen && (
                    <div className="ml-4 space-y-1 rounded border border-line bg-canvas p-2.5" data-testid="marketplace-catalog">
                      {browsing[mp.name] ? (
                        <div className="text-muted">Loading marketplace catalog…</div>
                      ) : catalog.length === 0 ? (
                        <div className="text-muted">No plugins listed in this marketplace.</div>
                      ) : (
                        catalog.map((item) => {
                          const alreadyInstalled = plugins.some((p) => p.name === item.name && p.marketplace === mp.name);
                          return (
                            <div key={item.name} className="flex flex-wrap items-center justify-between gap-2 border-t border-line/40 py-1 first:border-t-0" data-testid="marketplace-catalog-item" data-plugin={item.name}>
                              <div>
                                <span className="font-mono font-medium">{item.name}</span>
                                {item.description && <span className="ml-2 text-muted">{item.description}</span>}
                              </div>
                              <button
                                data-testid="marketplace-install-plugin"
                                className={button}
                                disabled={pluginBusy || alreadyInstalled || !integrations.runtimeUp}
                                onClick={() => void handleInstallPlugin(`${item.name}@${mp.name}`)}
                              >
                                {alreadyInstalled ? "Installed" : "Install"}
                              </button>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-2.5 rounded-lg border border-line bg-panel p-4" data-testid="integrations-plugins">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-medium">Installed agent plugins</div>
            <div className="text-xs text-muted">
              Plugins can bundle custom agents, skills (`SKILL.md`), and MCP servers.
            </div>
          </div>
          {plugins.length > 0 && (
            <button
              data-testid="plugin-update-all"
              className={button}
              disabled={pluginBusy || !integrations.runtimeUp}
              onClick={() => void handleUpdatePlugin()}
            >
              <RefreshCw className="h-3 w-3" /> Update all
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <input
            data-testid="plugin-install-input"
            className={`${field} w-72`}
            placeholder="plugin@marketplace, owner/repo, or path"
            value={pluginSpec}
            onChange={(e) => setPluginSpec(e.target.value)}
          />
          <button
            data-testid="plugin-install-btn"
            className={button}
            disabled={pluginBusy || !pluginSpec.trim() || !integrations.runtimeUp}
            onClick={() => void handleInstallPlugin(pluginSpec)}
          >
            <Plus className="h-3 w-3" /> Install plugin
          </button>
        </div>

        {pluginStatus && (
          <div className={`text-xs ${pluginStatus.tone === "ok" ? "text-ok" : "text-bad"}`} data-testid="plugin-status">
            {pluginStatus.text}
          </div>
        )}

        {plugins.length === 0 ? (
          <div className="text-xs text-muted">No plugins installed yet.</div>
        ) : (
          <div className="space-y-1.5">
            {plugins.map((p) => {
              const key = `${p.name}@${p.marketplace || p.directSourceId || "local"}`;
              const spec = p.marketplace ? `${p.name}@${p.marketplace}` : p.name;
              return (
                <div key={key} className="flex flex-wrap items-center gap-2 border-t border-line/60 py-1.5 text-xs" data-testid="plugin-row" data-plugin={p.name}>
                  <span className="text-sm font-medium">{p.name}</span>
                  {p.marketplace && <span className="font-mono text-muted">@{p.marketplace}</span>}
                  {p.version && <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-muted">v{p.version}</span>}
                  <span className={p.enabled ? "text-ok" : "text-muted"} data-testid="plugin-enabled-state">
                    {p.enabled ? "enabled" : "disabled"}
                  </span>
                  {p.installedFrom && <span className="truncate font-mono text-[11px] text-muted" title={p.installedFrom}>{p.installedFrom}</span>}
                  <div className="ml-auto flex items-center gap-1.5">
                    <button
                      data-testid="plugin-toggle"
                      className={button}
                      disabled={pluginBusy || !integrations.runtimeUp}
                      onClick={async () => {
                        const err = await setPluginEnabled(spec, !p.enabled);
                        if (err) setPluginStatus({ tone: "bad", text: err });
                      }}
                    >
                      {p.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      data-testid="plugin-update"
                      className={button}
                      disabled={pluginBusy || !integrations.runtimeUp}
                      onClick={() => void handleUpdatePlugin(spec)}
                    >
                      Update
                    </button>
                    <button
                      data-testid="plugin-uninstall"
                      className={`${button} text-bad hover:border-bad`}
                      disabled={pluginBusy || !integrations.runtimeUp}
                      onClick={async () => {
                        setPluginBusy(true);
                        const err = await uninstallPlugin(spec, p.directSourceId);
                        setPluginBusy(false);
                        setPluginStatus(err ? { tone: "bad", text: err } : { tone: "ok", text: `Uninstalled plugin “${p.name}”.` });
                      }}
                    >
                      <Trash2 className="h-3 w-3" /> Uninstall
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="border-t border-line/60 pt-2.5 text-xs">
          <div className="mb-1.5 font-medium text-muted">Local plugin directories</div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              data-testid="plugin-dir-input"
              className={`${field} w-72`}
              placeholder="Absolute path to a local plugin directory"
              value={pluginDirInput}
              onChange={(e) => setPluginDirInput(e.target.value)}
            />
            <button
              data-testid="plugin-dir-add"
              className={button}
              disabled={!pluginDirInput.trim()}
              onClick={async () => {
                const err = await addPluginDirectory(pluginDirInput.trim());
                if (err) setPluginStatus({ tone: "bad", text: err });
                else setPluginDirInput("");
              }}
            >
              <Plus className="h-3 w-3" /> Add folder
            </button>
          </div>
          {pluginDirs.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {pluginDirs.map((dir) => (
                <span key={dir} className="inline-flex items-center gap-1 rounded border border-line bg-canvas px-2 py-0.5 font-mono text-[11px]" data-testid="plugin-dir-chip">
                  {dir}
                  <button
                    data-testid="plugin-dir-remove"
                    className="text-muted hover:text-bad"
                    title="Remove folder"
                    onClick={() => void removePluginDirectory(dir)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function AgentsAndSkillsSection() {
  const integrations = useAria((s) => s.integrations);
  const openNewSession = useAria((s) => s.openNewSession);
  const setSkillEnabled = useAria((s) => s.setSkillEnabled);
  const addSkillDirectory = useAria((s) => s.addSkillDirectory);
  const removeSkillDirectory = useAria((s) => s.removeSkillDirectory);
  const addAgentDirectory = useAria((s) => s.addAgentDirectory);
  const removeAgentDirectory = useAria((s) => s.removeAgentDirectory);

  const [agentFilter, setAgentFilter] = useState("");
  const [skillFilter, setSkillFilter] = useState("");
  const [agentDirInput, setAgentDirInput] = useState("");
  const [skillDirInput, setSkillDirInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const agents = integrations.agents ?? [];
  const skills = integrations.skills ?? [];
  const agentDirs = integrations.agentDirectories ?? [];
  const skillDirs = integrations.skillDirectories ?? [];

  const aq = agentFilter.trim().toLowerCase();
  const filteredAgents = aq
    ? agents.filter(
        (a) =>
          a.id.toLowerCase().includes(aq) ||
          a.name.toLowerCase().includes(aq) ||
          a.displayName.toLowerCase().includes(aq) ||
          a.description.toLowerCase().includes(aq) ||
          (a.source ?? "").toLowerCase().includes(aq),
      )
    : agents;

  const sq = skillFilter.trim().toLowerCase();
  const filteredSkills = sq
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(sq) ||
          s.description.toLowerCase().includes(sq) ||
          s.source.toLowerCase().includes(sq) ||
          (s.pluginName ?? "").toLowerCase().includes(sq),
      )
    : skills;

  return (
    <div className="space-y-5">
      {error && <div className="text-xs text-bad">{error}</div>}

      <section className="space-y-2.5 rounded-lg border border-line bg-panel p-4" data-testid="integrations-agents">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-medium">Installed agents ({agents.length})</div>
            <div className="text-xs text-muted">
              Custom, plugin, project, and built-in agents available to sessions. Select an agent in <b>+ New session</b>, bind one to a worker profile in <b>Customize › Models</b>, or ask ARIA in chat.
            </div>
          </div>
          <input
            data-testid="agents-filter"
            className={`${field} w-56`}
            placeholder="Filter agents…"
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
          />
        </div>

        {filteredAgents.length === 0 ? (
          <div className="text-xs text-muted">No agents found.</div>
        ) : (
          <div className="space-y-1.5">
            {filteredAgents.map((a) => (
              <div key={a.id} className="space-y-1 border-t border-line/60 py-1.5 text-xs" data-testid="agent-row" data-agent={a.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{a.displayName || a.name}</span>
                  <span className="font-mono text-muted">{a.id}</span>
                  {a.source && (
                    <span className="rounded border border-line px-1.5 py-0.5 text-[11px] text-muted" data-testid="agent-source">
                      {a.source}
                    </span>
                  )}
                  {a.userInvocable === false && (
                    <span className="rounded border border-line px-1.5 py-0.5 text-[11px] text-muted">sub-agent only</span>
                  )}
                  {a.model && (
                    <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-muted">
                      {a.model}
                    </span>
                  )}
                  {a.userInvocable !== false && (
                    <button
                      data-testid="agent-start-session"
                      className={`${button} ml-auto`}
                      onClick={() => openNewSession(undefined, a.id)}
                    >
                      <Play className="h-3 w-3" /> Use in new session…
                    </button>
                  )}
                </div>
                {a.description && <div className="text-muted">{a.description}</div>}
                {a.skills && a.skills.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted">
                    <span>Preloaded skills:</span>
                    {a.skills.map((s) => (
                      <span key={s} className="rounded bg-raised px-1.5 py-0.5 font-mono">
                        {s}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="border-t border-line/60 pt-2.5 text-xs">
          <div className="mb-1.5 font-medium text-muted">Additional agent directories</div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              data-testid="agent-dir-input"
              className={`${field} w-72`}
              placeholder="Absolute path to a custom agents folder"
              value={agentDirInput}
              onChange={(e) => setAgentDirInput(e.target.value)}
            />
            <button
              data-testid="agent-dir-add"
              className={button}
              disabled={!agentDirInput.trim()}
              onClick={async () => {
                const err = await addAgentDirectory(agentDirInput.trim());
                if (err) setError(err);
                else setAgentDirInput("");
              }}
            >
              <Plus className="h-3 w-3" /> Add folder
            </button>
          </div>
          {agentDirs.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {agentDirs.map((dir) => (
                <span key={dir} className="inline-flex items-center gap-1 rounded border border-line bg-canvas px-2 py-0.5 font-mono text-[11px]" data-testid="agent-dir-chip">
                  {dir}
                  <button
                    data-testid="agent-dir-remove"
                    className="text-muted hover:text-bad"
                    onClick={() => void removeAgentDirectory(dir)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="space-y-2.5 rounded-lg border border-line bg-panel p-4" data-testid="integrations-skills">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-medium">Installed skills ({skills.length})</div>
            <div className="text-xs text-muted">
              Skills (`SKILL.md`) discovered from built-in, personal (`~/.copilot/skills`), project, and plugin sources. Enabled skills can be loaded by ARIA and background tasks with the `skill` tool.
            </div>
          </div>
          <input
            data-testid="skills-filter"
            className={`${field} w-56`}
            placeholder="Filter skills…"
            value={skillFilter}
            onChange={(e) => setSkillFilter(e.target.value)}
          />
        </div>

        {filteredSkills.length === 0 ? (
          <div className="text-xs text-muted">No skills found.</div>
        ) : (
          <div className="space-y-1.5">
            {filteredSkills.map((s) => (
              <div key={s.name} className="space-y-1 border-t border-line/60 py-1.5 text-xs" data-testid="skill-row" data-skill={s.name}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-medium">{s.name}</span>
                  <span className="rounded border border-line px-1.5 py-0.5 text-[11px] text-muted" data-testid="skill-source">
                    {s.pluginName ? `plugin: ${s.pluginName}` : s.source}
                  </span>
                  <span className={s.enabled ? "text-ok" : "text-muted"} data-testid="skill-enabled-state">
                    {s.enabled ? "enabled" : "disabled"}
                  </span>
                  <button
                    data-testid="skill-toggle"
                    className={`${button} ml-auto`}
                    onClick={async () => {
                      const err = await setSkillEnabled(s.name, !s.enabled);
                      if (err) setError(err);
                    }}
                  >
                    {s.enabled ? "Disable" : "Enable"}
                  </button>
                </div>
                {s.description && <div className="text-muted">{s.description}</div>}
              </div>
            ))}
          </div>
        )}

        <div className="border-t border-line/60 pt-2.5 text-xs">
          <div className="mb-1.5 font-medium text-muted">Additional skill directories</div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              data-testid="skill-dir-input"
              className={`${field} w-72`}
              placeholder="Absolute path to a custom skills folder"
              value={skillDirInput}
              onChange={(e) => setSkillDirInput(e.target.value)}
            />
            <button
              data-testid="skill-dir-add"
              className={button}
              disabled={!skillDirInput.trim()}
              onClick={async () => {
                const err = await addSkillDirectory(skillDirInput.trim());
                if (err) setError(err);
                else setSkillDirInput("");
              }}
            >
              <Plus className="h-3 w-3" /> Add folder
            </button>
          </div>
          {skillDirs.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {skillDirs.map((dir) => (
                <span key={dir} className="inline-flex items-center gap-1 rounded border border-line bg-canvas px-2 py-0.5 font-mono text-[11px]" data-testid="skill-dir-chip">
                  {dir}
                  <button
                    data-testid="skill-dir-remove"
                    className="text-muted hover:text-bad"
                    onClick={() => void removeSkillDirectory(dir)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * Customize › Integrations (PLAN.md §4.13, Phase 7A, D22, D30–D34): ARIA's own MCP configuration (Import from
 * Copilot CLI, Keep in sync, Add/Edit server, and Test button via @modelcontextprotocol/sdk), Sign in for servers
 * that need it, and a rule per tool for ARIA and for tasks.
 */
export function CustomizeIntegrations() {
  const integrations = useAria((s) => s.integrations);
  const tasks = useAria((s) => s.tasks);
  const refreshIntegrations = useAria((s) => s.refreshIntegrations);
  const importCliMcp = useAria((s) => s.importCliMcp);
  const setMcpKeepInSync = useAria((s) => s.setMcpKeepInSync);
  const testMcpServer = useAria((s) => s.testMcpServer);
  const saveMcpServer = useAria((s) => s.saveMcpServer);
  const removeMcpServer = useAria((s) => s.removeMcpServer);
  const setActiveTracker = useAria((s) => s.setActiveTracker);

  // The server whose "Use as task tracker" dialog is open.
  const [trackerDialog, setTrackerDialog] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [changedTasks, setChangedTasks] = useState(false);
  const [importingCli, setImportingCli] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [testingServer, setTestingServer] = useState<Record<string, boolean>>({});

  // Add / Edit server form state
  const [showForm, setShowForm] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formTransport, setFormTransport] = useState<McpServerTransport>("http");
  const [formUrl, setFormUrl] = useState("");
  const [formToken, setFormToken] = useState("");
  const [formCommand, setFormCommand] = useState("");
  const [formArgs, setFormArgs] = useState("");
  const [formSaving, setFormSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const servers = orderedServers(integrations.servers);
  const seen = servers.filter((s) => s.seen);
  const shown = filterTools(integrations.tools, query, onlyChanged);
  const running = runningTasks(tasks);
  const onChanged = (scope: IntegrationScope) => {
    if (scope === "tasks") setChangedTasks(true);
  };

  const handleImportCli = async () => {
    setImportingCli(true);
    setRefreshError(null);
    setImportMessage(null);
    const res = await importCliMcp();
    setImportingCli(false);
    if (res.error) {
      setRefreshError(res.error);
      return;
    }
    const imported = res.imported ?? 0;
    const updated = res.updated ?? 0;
    if (imported > 0 && updated > 0) {
      setImportMessage(`Imported ${plural(imported, "server")} and updated ${plural(updated, "server")} from Copilot CLI.`);
    } else if (imported > 0) {
      setImportMessage(`Imported ${plural(imported, "server")} from Copilot CLI.`);
    } else if (updated > 0) {
      setImportMessage(`Updated ${plural(updated, "server")} from Copilot CLI.`);
    } else {
      setImportMessage("All servers from Copilot CLI are up to date.");
    }
  };

  const handleKeepInSync = async (checked: boolean) => {
    setRefreshError(null);
    const err = await setMcpKeepInSync(checked);
    if (err) setRefreshError(err);
  };

  const handleTestServer = async (serverName: string) => {
    setTestingServer((prev) => ({ ...prev, [serverName]: true }));
    const res = await testMcpServer(serverName);
    setTestingServer((prev) => ({ ...prev, [serverName]: false }));
    if (res.error) setRefreshError(res.error);
  };

  const openAddForm = () => {
    setEditingName(null);
    setFormName("");
    setFormTransport("http");
    setFormUrl("");
    setFormToken("");
    setFormCommand("");
    setFormArgs("");
    setFormError(null);
    setShowForm(true);
  };

  const openEditForm = (server: IntegrationServer) => {
    setEditingName(server.name);
    setFormName(server.name);
    setFormTransport(server.transport ?? "http");
    setFormUrl("");
    setFormToken("");
    setFormCommand(server.command ?? "");
    setFormArgs("");
    setFormError(null);
    setShowForm(true);
  };

  const handleSaveServer = async () => {
    setFormSaving(true);
    setFormError(null);
    const name = formName.trim();
    const existing = integrations.servers.find((s) => s.name === name);
    const argsList = formArgs
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const err = await saveMcpServer({
      name,
      transport: formTransport,
      enabled: existing ? existing.enabled !== false : true,
      ...(formTransport === "stdio"
        ? {
            ...(formCommand.trim() ? { command: formCommand.trim() } : {}),
            ...(formArgs.trim() ? { args: argsList } : {}),
          }
        : {
            ...(formUrl.trim() ? { url: formUrl.trim() } : {}),
            ...(formToken.trim() ? { bearerToken: formToken.trim() } : {}),
          }),
    });
    setFormSaving(false);
    if (err) {
      setFormError(err);
      return;
    }
    setShowForm(false);
    setEditingName(null);
  };

  const handleToggleServer = async (server: IntegrationServer) => {
    const nextEnabled = server.enabled === false;
    const err = await saveMcpServer({
      name: server.name,
      transport: server.transport ?? "http",
      enabled: nextEnabled,
    });
    if (err) setRefreshError(err);
  };

  const handleRemoveServer = async (serverName: string) => {
    const err = await removeMcpServer(serverName);
    if (err) setRefreshError(err);
  };

  // Stop using: the tracker without this server, or none when it was the last.
  const handleStopUsing = async (serverName: string) => {
    if (!integrations.tracker) return;
    setRefreshError(null);
    const res = await setActiveTracker(stopChoice(integrations.tracker, serverName));
    if (!res.ok) setRefreshError(res.error);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-5 p-6">
        <TrackerSection />

        <section className="space-y-2 rounded-lg border border-line bg-panel p-4" data-testid="integrations-servers">
          <div className="flex flex-wrap items-center gap-2">
            <div className="font-medium">Servers in your Copilot CLI setup</div>
            <button
              data-testid="integrations-refresh"
              className={button}
              disabled={integrations.refreshing || !integrations.runtimeUp}
              onClick={async () => setRefreshError(await refreshIntegrations())}
            >
              <RefreshCw className={`h-3 w-3 ${integrations.refreshing ? "animate-spin" : ""}`} /> {integrations.refreshing ? "Checking…" : "Refresh"}
            </button>
            <button
              data-testid="mcp-import-cli"
              className={button}
              disabled={importingCli}
              title="Imports MCP servers from ~/.copilot/mcp-config.json into ARIA's own configuration"
              onClick={() => void handleImportCli()}
            >
              <Download className="h-3 w-3" /> {importingCli ? "Importing…" : "Import from Copilot CLI"}
            </button>
            <label className="inline-flex items-center gap-1.5 text-xs text-muted" title="Automatically re-import from Copilot CLI on startup and Refresh">
              <input
                type="checkbox"
                data-testid="mcp-keep-in-sync"
                checked={Boolean(integrations.keepInSync)}
                onChange={(e) => void handleKeepInSync(e.target.checked)}
              />
              Keep in sync
            </label>
            <button
              data-testid="mcp-add-server-toggle"
              className={button}
              onClick={() => (showForm && !editingName ? setShowForm(false) : openAddForm())}
            >
              <Plus className="h-3 w-3" /> Add server
            </button>
            <span className="text-xs text-muted" data-testid="integrations-checked">
              {integrations.checkedAt ? `Checked ${new Date(integrations.checkedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : "Not checked yet"}
              {!integrations.runtimeUp && " · ARIA's runtime isn't running, so this may be out of date"}
            </span>
          </div>
          <div className="text-xs text-muted">
            Import servers from the Copilot CLI (/mcp, /plugin) or add them directly in ARIA. Bearer tokens and secret headers are stored encrypted in the OS keychain.
          </div>
          {importMessage && (
            <div className="text-xs text-ok" data-testid="mcp-import-result">
              {importMessage}
            </div>
          )}
          {(refreshError ?? integrations.refreshError) && <div className="text-xs text-bad">{refreshError ?? integrations.refreshError}</div>}

          {showForm && (
            <div className="space-y-2 rounded-md border border-line bg-canvas p-3 text-xs" data-testid="mcp-server-form">
              <div className="font-medium text-fg">{editingName ? `Edit MCP server: ${editingName}` : "Add MCP server"}</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <label className="space-y-1">
                  <span className="text-muted">Server name</span>
                  <input
                    data-testid="mcp-form-name"
                    className={`${field} w-full`}
                    placeholder="e.g. Work IQ Mail"
                    value={formName}
                    disabled={editingName !== null}
                    onChange={(e) => setFormName(e.target.value)}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-muted">Transport</span>
                  <select
                    data-testid="mcp-form-transport"
                    className={`${field} w-full`}
                    value={formTransport}
                    onChange={(e) => setFormTransport(e.target.value as McpServerTransport)}
                  >
                    <option value="http">HTTP (Streamable)</option>
                    <option value="sse">SSE</option>
                    <option value="stdio">Stdio (local process)</option>
                  </select>
                </label>
                {formTransport === "stdio" ? (
                  <label className="space-y-1">
                    <span className="text-muted">Command</span>
                    <input
                      data-testid="mcp-form-command"
                      className={`${field} w-full`}
                      placeholder="e.g. node or npx"
                      value={formCommand}
                      onChange={(e) => setFormCommand(e.target.value)}
                    />
                  </label>
                ) : (
                  <label className="space-y-1">
                    <span className="text-muted">{editingName ? "New URL (leave blank to keep current)" : "Server URL (https:// or http://127.0.0.1)"}</span>
                    <input
                      data-testid="mcp-form-url"
                      className={`${field} w-full`}
                      placeholder="https://example.com/mcp"
                      value={formUrl}
                      onChange={(e) => setFormUrl(e.target.value)}
                    />
                  </label>
                )}
              </div>
              {formTransport === "stdio" ? (
                <label className="block space-y-1">
                  <span className="text-muted">Arguments (space-separated)</span>
                  <input
                    data-testid="mcp-form-args"
                    className={`${field} w-full`}
                    placeholder="e.g. server.js --port 3000"
                    value={formArgs}
                    onChange={(e) => setFormArgs(e.target.value)}
                  />
                </label>
              ) : (
                <label className="block space-y-1">
                  <span className="text-muted">Bearer token (optional, encrypted in OS keychain)</span>
                  <input
                    type="password"
                    data-testid="mcp-form-token"
                    className={`${field} w-full`}
                    placeholder={editingName ? "Leave blank to keep existing token" : "Optional bearer token"}
                    value={formToken}
                    onChange={(e) => setFormToken(e.target.value)}
                  />
                </label>
              )}
              {formError && <div className="text-bad" data-testid="mcp-form-error">{formError}</div>}
              <div className="flex items-center gap-2">
                <button
                  data-testid="mcp-form-save"
                  className={button}
                  disabled={formSaving || !formName.trim()}
                  onClick={() => void handleSaveServer()}
                >
                  {formSaving ? "Saving…" : "Save server"}
                </button>
                <button
                  data-testid="mcp-form-cancel"
                  className={button}
                  onClick={() => {
                    setShowForm(false);
                    setEditingName(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {servers.length === 0 && <div className="text-xs text-muted">No servers found.</div>}
          {servers.map((server) => {
            const isTesting = Boolean(testingServer[server.name]) || server.testResult?.status === "testing";
            return (
              <div key={server.name} className="space-y-1 border-t border-line/60 py-1.5" data-testid="integrations-server" data-server={server.name}>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                  <span className="font-medium">{server.displayName ?? server.name}</span>
                  <span className="text-xs text-muted" data-testid="server-source">
                    {sourceLabel(server)}
                  </span>
                  {server.transport && (
                    <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-muted" data-testid="server-transport">
                      {server.transport}
                      {server.transport === "stdio" && server.command ? `: ${server.command}` : ""}
                    </span>
                  )}
                  {server.hasAuthToken && (
                    <span className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11px] text-ok" data-testid="server-token-badge">
                      <KeyRound className="h-2.5 w-2.5" /> Token saved
                    </span>
                  )}
                  {server.tracker && server.seen && (
                    <span className="rounded border border-accent px-1.5 py-0.5 text-[11px] text-fg" data-testid="server-tracker-badge">
                      Task tracker
                    </span>
                  )}
                  {server.seen ? (
                    <>
                      <span className={`text-xs ${server.status === "connected" ? "text-ok" : server.status === "needs-auth" || server.status === "failed" ? "text-warn" : "text-muted"}`} data-testid="server-status">
                        {statusLabel(server)}
                      </span>
                      <span className="text-xs text-muted">
                        {server.toolCount} tool{server.toolCount === 1 ? "" : "s"}
                      </span>
                    </>
                  ) : (
                    // Gone from your setup: its last status would be stale, and its tools are the ones seen before.
                    <>
                      <span className="text-xs text-muted" data-testid="server-status">
                        Not in your setup since {shortDate(server.lastSeen)}
                      </span>
                      <span className="text-xs text-muted">{plural(integrations.tools.filter((t) => t.server === server.name).length, "tool")} from before</span>
                    </>
                  )}
                  {server.duplicateOf && <span className="text-xs text-muted">Same server as {server.duplicateOf}: ARIA uses that one's tools.</span>}
                </div>
                {server.seen ? (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <SignIn server={server} />
                    <button
                      data-testid="test-server"
                      className={button}
                      disabled={isTesting || server.enabled === false}
                      title="Connect directly to this MCP server and verify its tools"
                      onClick={() => void handleTestServer(server.name)}
                    >
                      <Activity className={`h-3 w-3 ${isTesting ? "animate-pulse" : ""}`} /> {isTesting ? "Testing…" : "Test"}
                    </button>
                    {!server.duplicateOf &&
                      (server.tracker ? (
                        <button data-testid="tracker-stop" className={button} title="ARIA stops reading tasks and registering time through this server" onClick={() => void handleStopUsing(server.name)}>
                          Stop using
                        </button>
                      ) : (
                        <button data-testid="tracker-use" className={button} title="Read tasks and register time through this server" onClick={() => setTrackerDialog(server.name)}>
                          Use as task tracker
                        </button>
                      ))}
                    {server.testResult && server.testResult.status !== "testing" && (
                      <span
                        data-testid="test-server-result"
                        data-status={server.testResult.status}
                        className={server.testResult.status === "ok" ? "text-ok" : "text-bad"}
                      >
                        {server.testResult.message ?? (server.testResult.status === "ok" ? "Connected" : "Test failed")}
                      </span>
                    )}
                    {server.configuredInAria && (
                      <>
                        <button
                          data-testid="toggle-server"
                          className={button}
                          onClick={() => void handleToggleServer(server)}
                        >
                          {server.enabled === false ? "Enable" : "Disable"}
                        </button>
                        <button
                          data-testid="edit-server"
                          className={button}
                          onClick={() => openEditForm(server)}
                        >
                          Edit
                        </button>
                        <button
                          data-testid="remove-server"
                          className={`${button} text-bad hover:border-bad`}
                          onClick={() => void handleRemoveServer(server.name)}
                        >
                          <Trash2 className="h-3 w-3" /> Remove
                        </button>
                      </>
                    )}
                  </div>
                ) : (
                  <GoneServer server={server} others={seen} />
                )}
              </div>
            );
          })}
        </section>

        {/* A container: the tool list lays out by its own width (columns when there's room, stacked when not). */}
        <section className="@container space-y-2 rounded-lg border border-line bg-panel p-4" data-testid="integrations-tools">
          <div className="font-medium">Tools</div>
          <div className="space-y-1 text-xs text-muted">
            <div>
              Each tool's class comes from its name: <span className="text-ok">read</span>, <span className="text-warn">write</span>, <span className="text-bad">destructive</span> or{" "}
              <span className="text-bad">unrestricted</span> (a name that doesn't clearly read counts as a write). A rule can only make a tool stricter than its class allows, so a
              tool that changes things is never Auto.
            </div>
            <div>
              <b>ARIA</b> runs read tools on its own. Anything that changes things needs an action card (Ask), and runs only after your click on the card. <b>Tasks</b> get GitHub's read tools. For a tool that changes things, Ask shows a card every time (Approve once or Reject), and GitHub tools
              that merge or write branches, files, commits or tags are always refused.
            </div>
          </div>
          {changedTasks && running > 0 && (
            <div className="text-xs text-warn" data-testid="running-note">
              Applies to tasks that start from now on: {running} running task{running === 1 ? " keeps" : "s keep"} the tools {running === 1 ? "it has" : "they have"} until{" "}
              {running === 1 ? "it starts" : "they start"} again (a tool you turned off is refused for them at once).
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <input aria-label="Filter tools" data-testid="integrations-filter" className={`${field} w-64`} placeholder="Filter by server or tool" value={query} onChange={(e) => setQuery(e.target.value)} />
            <label className="inline-flex items-center gap-1 text-xs text-muted">
              <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> Only your rules
            </label>
          </div>
          {servers.map((server) => {
            const tools = shown.filter((t) => t.server === server.name);
            if (tools.length === 0) return null;
            const expanded = open[server.name] ?? (query.trim() !== "" || onlyChanged);
            return (
              <div key={server.name} data-testid="integrations-group" data-server={server.name}>
                <button className="flex items-center gap-1 py-1 text-sm font-medium" onClick={() => setOpen({ ...open, [server.name]: !expanded })} aria-expanded={expanded}>
                  {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  {server.name} <span className="text-xs font-normal text-muted">· {tools.length}</span>
                </button>
                {expanded && (
                  // One grid for the whole group: fixed ARIA and Tasks columns, so they line up from row to row.
                  <div className="grid grid-cols-1 @3xl:grid-cols-[minmax(10rem,1fr)_16rem_16rem] @3xl:gap-x-3" data-testid="integrations-table">
                    <div className="hidden text-[11px] text-muted @3xl:col-span-3 @3xl:grid @3xl:grid-cols-subgrid">
                      <span>Tool</span>
                      <span>ARIA</span>
                      <span>Tasks</span>
                    </div>
                    {tools.map((tool) => (
                      <ToolRow key={tool.wireName} tool={tool} server={server} onChanged={onChanged} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </section>

        <MarketplacesAndPluginsSection />

        <AgentsAndSkillsSection />
      </div>
      {trackerDialog !== null && <UseAsTrackerDialog server={trackerDialog} onClose={() => setTrackerDialog(null)} />}
    </div>
  );
}
