import type { ConductorSettings, EngineEvent, IntegrationScope, IntegrationsState, IntegrationTestResult, NoticeItem, SaveMcpServerInput, SignInState, ToolRuleEffect } from "@aria/protocol";
import type { z } from "zod";
import type { EngineOptions } from "../engine-options.ts";
import type { HelperSessions } from "../runtime/helper-sessions.ts";
import type { SignInStart } from "../runtime/types.ts";
import type { Store } from "../store/store.ts";
import type { ActiveTracker, TrackerChoice } from "../trackers/active.ts";
import type { ConfigListing } from "../trackers/config/load.ts";
import { buildTrackerSetup, type SetupContext } from "../trackers/setup.ts";
import type { TaskTracker } from "../trackers/types.ts";
import { ignoreCleanupFailure } from "../util/ignore.ts";
import { EMPTY_MCP_CONFIG, McpConfigStore, redactedServerMetadata, type McpConfigState, type McpSecretStore, type McpServerSecrets } from "./config.ts";
import { NativeMcpClient, type McpDirectClient } from "./mcp-client.ts";
import {
  computeScopes,
  duplicates,
  EMPTY_CATALOG,
  forgetServer,
  isSeen,
  loadCatalog,
  loadRules,
  mergeCatalog,
  mergeMcpConfigIntoCatalog,
  mergeServerProbeIntoCatalog,
  moveRules,
  setRule,
  signInPage,
  untrusted,
  viewTools,
  type Catalog,
  type Scopes,
  type StoredRule,
} from "./rules.ts";

/** Customize › Integrations: how often Refresh may check your setup, and how long a sign-in may take. */
const REFRESH_COOLDOWN_MS = 30_000;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface IntegrationsDeps {
  db: () => Store;
  tracker: () => TaskTracker;
  /** The tracker in use and where it came from, the saved choice, the trackers folder as last read, and what is wrong with the setting's config. */
  trackerState: () => { active: ActiveTracker | undefined; choice: TrackerChoice; listing: readonly ConfigListing[]; error?: string | undefined };
  /** Reads the trackers folder again, and swaps in the active config when its file changed (Refresh). */
  relistTrackers: () => void;
  isOpen: () => boolean;
  options: EngineOptions;
  emit: (event: EngineEvent) => void;
  log: (text: string) => void;
  logFailure: (step: string) => (error: unknown) => void;
  notice: (level: NoticeItem["level"], text: string, cause?: string) => void;
  /** The runtime has started (Refresh and Sign in need it). */
  runtimeStarted: () => boolean;
  stopped: () => boolean;
  /** Wakes the tracker and Outlook watchers: their tools come from your servers. */
  wakeTracker: () => void;
  refreshConductorTools: () => Promise<void>;
  conductorSettings: () => ConductorSettings;
  timekeeperSettings?: () => { model?: string; reasoningEffort?: string };
  helperSessions: HelperSessions;
}

/**
 * Customize › Integrations (PLAN.md §4.13, D22, D30–D34).
 * The catalog and your rules are settings rows (checked when read); the scopes come from them. A change reaches
 * ARIA's permission handler at once and its session when it reopens before your next message; tasks' handlers at
 * once, and their sessions when they open (a new task, Continue, Retry, Resume).
 */
export class Integrations {
  /** Customize › Integrations: what ARIA knows of your MCP servers and tools, your rules, and the scopes from them. */
  catalog: Catalog = EMPTY_CATALOG;
  toolRules: StoredRule[] = [];
  scopes: Scopes = computeScopes(EMPTY_CATALOG, []);
  /**
   * Sign-ins that connected a server ARIA's session uses. A session that's already open keeps the server signed out
   * (spike 16), and a server that needs signing in still lists its tools from before, so the scopes don't change: the
   * conversation reopens before your next message when this moved since it opened.
   */
  signInsConnected = 0;
  private refreshing: Promise<void> | undefined;
  private lastRefreshAt = 0;
  private refreshError: string | undefined;
  private signInState: SignInState | undefined;
  signInRun: { server: string; cancel: () => Promise<void> } | undefined;
  mcpConfigStore: McpConfigStore | undefined;
  mcpClient: McpDirectClient | undefined;
  private readonly mcpTestResults = new Map<string, IntegrationTestResult>();
  private readonly fallbackMcpSecrets = new Map<string, McpServerSecrets>();

  constructor(private readonly deps: IntegrationsDeps) {}

  /** ARIA's own MCP configuration and client, and what was known last time: once the database is open. */
  open(): void {
    // Phase 7A: Initialize ARIA's own MCP configuration store and built-in MCP client.
    this.mcpConfigStore = new McpConfigStore({
      loadState: () => this.deps.db().getSetting<unknown>("integrations.mcpConfig"),
      saveState: (state) => this.deps.db().setSetting("integrations.mcpConfig", state),
      secretStore: this.resolveMcpSecretStore(),
      ...(this.deps.options.cliMcpConfigPath ? { cliConfigPath: this.deps.options.cliMcpConfigPath } : {}),
    });
    this.mcpClient =
      this.deps.options.mcpClient ??
      new NativeMcpClient({
        tracker: () => this.deps.tracker(),
        getServerConfig: (name) => this.mcpConfigStore?.getServer(name),
        getServerSecrets: (name) => this.mcpConfigStore?.getServerSecrets(name),
        ...(this.deps.options.mcpTransportFactory ? { transportFactory: this.deps.options.mcpTransportFactory } : {}),
        ...(this.deps.options.mcpFetch ? { fetch: this.deps.options.mcpFetch } : {}),
        hasZeroModelFallback: () => typeof this.deps.options.runtime.callMcpToolDirect === "function",
        fallbackCallTool: async (req) => {
          if (this.deps.options.runtime.callMcpToolDirect) {
            return this.deps.options.runtime.callMcpToolDirect(req);
          }
          const conductor = this.deps.conductorSettings();
          const tk = this.deps.timekeeperSettings?.();
          const model = conductor.model ?? tk?.model;
          const reasoningEffort = conductor.model ? conductor.reasoningEffort : tk?.reasoningEffort;
          if (!model) {
            return { ok: false, error: "No model is configured for ARIA.", blocked: true };
          }
          const view = viewTools(this.catalog, this.toolRules).find(
            (v) => v.entry.server === req.server && (v.entry.tool === req.tool || v.entry.wireName === req.wireName),
          );
          const mcpState = this.mcpConfigStore?.getState() ?? EMPTY_MCP_CONFIG;
          const mcpServers = this.mcpConfigStore?.buildScopedServers();
          const serverCfg = mcpServers?.[req.server];
          const targetMcpServers = serverCfg ? { [req.server]: serverCfg } : undefined;
          const disabledMcpServers = this.catalog.servers
            .filter((s) => isSeen(this.catalog, s) && s.name !== req.server)
            .map((s) => s.name);
          const sessionId = this.deps.helperSessions.helperId();
          try {
            return await this.deps.options.runtime.runMcpAction({
              sessionId,
              model,
              ...(reasoningEffort ? { reasoningEffort } : {}),
              server: req.server,
              tool: req.tool,
              wireName: req.wireName,
              ...(view?.github ? { github: true } : {}),
              disabledMcpServers,
              ...(targetMcpServers ? { mcpServers: targetMcpServers } : {}),
              ...(mcpState.pluginDirectories.length ? { pluginDirectories: mcpState.pluginDirectories } : {}),
              approvedArgs: req.approvedArgs,
              ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
              ...(req.signal ? { signal: req.signal } : {}),
            });
          } finally {
            this.deps.helperSessions.helperDone(sessionId);
          }
        },
        fallbackTestServer: (name, opts) => {
          if (!this.deps.options.runtime.testMcpServerDirect) return Promise.resolve(undefined);
          const mcpState = this.mcpConfigStore?.getState() ?? EMPTY_MCP_CONFIG;
          const mcpServers = this.mcpConfigStore?.buildScopedServers();
          const targetMcpServers = mcpServers?.[name] ? { [name]: mcpServers[name] } : undefined;
          const disabledMcpServers = this.catalog.servers
            .filter((s) => s.name !== name && isSeen(this.catalog, s))
            .map((s) => s.name);
          return this.deps.options.runtime.testMcpServerDirect(name, {
            ...opts,
            ...(targetMcpServers ? { mcpServers: targetMcpServers } : {}),
            ...(mcpState.pluginDirectories.length ? { pluginDirectories: mcpState.pluginDirectories } : {}),
            ...(disabledMcpServers.length ? { disabledMcpServers } : {}),
          });
        },
        onServerNeedsAuth: (serverName) => this.markServerNeedsAuth(serverName),
      });
    // What Customize › Integrations showed last time, until the runtime has checked your setup again.
    this.loadIntegrations();
  }

  integrationsState(): IntegrationsState {
    const views = viewTools(this.catalog, this.toolRules);
    const dupes = duplicates(this.catalog);
    const count = new Map<string, number>();
    for (const v of views) if (v.seen) count.set(v.entry.server, (count.get(v.entry.server) ?? 0) + 1);
    const mcpState: McpConfigState = this.mcpConfigStore?.getState() ?? EMPTY_MCP_CONFIG;
    const configuredByName = new Map(mcpState.servers.map((s) => [s.name, s]));
    return {
      servers: this.catalog.servers.map((s) => {
        const duplicateOf = dupes.get(s.name);
        const cfg = configuredByName.get(s.name);
        const secrets = cfg ? this.mcpConfigStore?.getServerSecrets(s.name) : undefined;
        const meta = cfg ? redactedServerMetadata(cfg, secrets) : {};
        const testResult = this.mcpTestResults.get(s.name);
        return {
          name: s.name,
          ...(s.displayName ? { displayName: s.displayName } : {}),
          status: cfg && !cfg.enabled ? "disabled" : s.status,
          ...(s.source ? { source: s.source } : {}),
          ...(s.sourcePlugin ? { sourcePlugin: s.sourcePlugin } : {}),
          ...(s.error ? { error: s.error } : {}),
          seen: isSeen(this.catalog, s),
          lastSeen: s.lastSeen,
          toolCount: count.get(s.name) ?? 0,
          ...(duplicateOf ? { duplicateOf } : {}),
          github: s.github === true || /github/i.test(s.name),
          ...(this.deps.tracker().matchesServer(s.name) ? { tracker: true } : {}),
          ...meta,
          ...(testResult ? { testResult } : {}),
        };
      }),
      tools: views.map((v) => ({
        server: v.entry.server,
        tool: v.entry.tool,
        wireName: v.entry.wireName,
        ...(v.entry.description ? { description: v.entry.description } : {}),
        cls: v.cls,
        github: v.github,
        seen: v.seen,
        lastSeen: v.entry.lastSeen,
        rules: v.rules,
      })),
      ...(this.catalog.checkedAt !== undefined ? { checkedAt: this.catalog.checkedAt } : {}),
      runtimeUp: this.deps.runtimeStarted(),
      refreshing: this.refreshing !== undefined,
      ...(this.refreshError ? { refreshError: this.refreshError } : {}),
      ...(this.signInState ? { signIn: this.signInState } : {}),
      tracker: buildTrackerSetup({ ...this.trackerContext(), ...this.deps.trackerState() }),
      keepInSync: mcpState.keepInSync,
      ...(mcpState.lastImportedAt !== undefined ? { lastImportedAt: mcpState.lastImportedAt } : {}),
      configuredServerCount: mcpState.servers.length,
      ...(mcpState.pluginDirectories.length > 0 ? { pluginDirectories: mcpState.pluginDirectories } : {}),
      ...(mcpState.skillDirectories?.length ? { skillDirectories: mcpState.skillDirectories } : {}),
      ...(mcpState.agentDirectories?.length ? { agentDirectories: mcpState.agentDirectories } : {}),
      ...(mcpState.disabledSkills?.length ? { disabledSkills: mcpState.disabledSkills } : {}),
      ...(this.catalog.marketplaces ? { marketplaces: this.catalog.marketplaces } : {}),
      ...(this.catalog.plugins ? { plugins: this.catalog.plugins } : {}),
      ...(this.catalog.agents ? { agents: this.catalog.agents } : {}),
      ...(this.catalog.skills
        ? {
            skills: this.catalog.skills.map((s) => ({
              ...s,
              enabled: s.enabled !== false && !(mcpState.disabledSkills ?? []).includes(s.name),
            })),
          }
        : {}),
    };
  }

  /** What the task tracker's setup is read from: the catalog, your rules, ARIA's MCP config, and which servers ARIA calls itself. */
  trackerContext(): SetupContext {
    return {
      catalog: this.catalog,
      toolRules: this.toolRules,
      mcpConfig: this.mcpConfigStore?.getState() ?? EMPTY_MCP_CONFIG,
      // As the watcher decides: the client's own say, else a client at all.
      canCallDirectly: (server) => (this.mcpClient?.canCallDirectly ? this.mcpClient.canCallDirectly(server) : Boolean(this.mcpClient)),
    };
  }

  emitIntegrations(): IntegrationsState {
    const integrations = this.integrationsState();
    this.deps.emit({ type: "integrations", integrations });
    return integrations;
  }

  private resolveMcpSecretStore(): McpSecretStore {
    if (this.deps.options.mcpSecretStore) return this.deps.options.mcpSecretStore;
    const readMap = (): Record<string, McpServerSecrets> => {
      const out: Record<string, McpServerSecrets> = {};
      for (const [k, v] of this.fallbackMcpSecrets.entries()) {
        out[k] = structuredClone(v);
      }
      return out;
    };
    const writeMap = (map: Record<string, McpServerSecrets>): void => {
      this.fallbackMcpSecrets.clear();
      for (const [k, v] of Object.entries(map)) {
        this.fallbackMcpSecrets.set(k, v);
      }
    };
    return {
      getServerSecrets: (serverName: string): McpServerSecrets | undefined => {
        const all = readMap();
        return all[serverName] ? structuredClone(all[serverName]) : undefined;
      },
      setServerSecrets: (serverName: string, secrets: McpServerSecrets | null): void => {
        const all = readMap();
        if (!secrets || (!secrets.bearerToken && !secrets.fullUrl && !Object.keys(secrets.headers ?? {}).length && !Object.keys(secrets.env ?? {}).length)) {
          delete all[serverName];
        } else {
          all[serverName] = structuredClone(secrets);
        }
        writeMap(all);
      },
      hasSecrets: (serverName: string): boolean => {
        const s = readMap()[serverName];
        if (!s) return false;
        return Boolean(
          s.bearerToken?.trim() ||
            (s.headers && Object.keys(s.headers).length > 0) ||
            (s.env && Object.keys(s.env).length > 0) ||
            s.fullUrl,
        );
      },
    };
  }

  private markServerNeedsAuth(serverName: string): void {
    if (!this.deps.isOpen()) return;
    const existing = this.catalog.servers.find((s) => s.name === serverName);
    if (!existing || existing.status === "needs-auth") return;
    this.catalog = {
      ...this.catalog,
      servers: this.catalog.servers.map((s) => (s.name === serverName ? { ...s, status: "needs-auth" } : s)),
    };
    this.saveIntegrations();
    this.deps.wakeTracker();
    this.emitIntegrations();
  }

  private loadIntegrations(): void {
    this.catalog = loadCatalog(this.deps.db().getSetting<unknown>("integrations.catalog"));
    this.toolRules = loadRules(this.deps.db().getSetting<unknown>("integrations.rules"));
    if (this.mcpConfigStore) {
      this.mcpConfigStore.reload(this.deps.db().getSetting<unknown>("integrations.mcpConfig"));
      const mcpState = this.mcpConfigStore.getState();
      if (mcpState.servers.length > 0) {
        this.catalog = mergeMcpConfigIntoCatalog(this.catalog, mcpState, Date.now());
      }
    }
    this.applyScopes();
  }

  /** The scopes follow the catalog, your rules, and ARIA's MCP config (ARIA's session reopens when what it opens with changed: ensureCurrentPrompt). */
  private applyScopes(): void {
    this.scopes = computeScopes(this.catalog, this.toolRules, this.mcpConfigStore?.getState());
  }

  /** What ARIA's session opens with from the scopes and MCP config: its tools, disabled servers, and scoped mcpServers/pluginDirectories. */
  ariaOpensWith(): string {
    const sorted = (list: readonly string[]) => [...list].sort();
    const mcpFp = this.mcpConfigStore?.fingerprint(this.scopes.aria.disabledMcpServers) ?? "";
    return JSON.stringify([
      sorted(this.scopes.aria.availableTools),
      sorted(this.scopes.aria.disabledMcpServers),
      mcpFp,
    ]);
  }

  saveIntegrations(): void {
    this.deps.db().setSetting("integrations.catalog", this.catalog);
    this.deps.db().setSetting("integrations.rules", this.toolRules);
    this.applyScopes();
  }

  private async syncCliMcpBestEffort(): Promise<void> {
    if (!this.mcpConfigStore) return;
    try {
      const runtimeCfg = await this.deps.options.runtime.readCliMcpConfig?.().catch(() => undefined);
      this.mcpConfigStore.importFromCliFile(undefined, {
        ...(runtimeCfg?.servers ? { fallbackServers: runtimeCfg.servers } : {}),
        ...(runtimeCfg?.pluginDirectories ? { fallbackPluginDirectories: runtimeCfg.pluginDirectories } : {}),
      });
    } catch (error) {
      this.deps.log(`Couldn't auto-sync Copilot CLI MCP config: ${message(error)}`);
    }
  }

  /**
   * Checks your Copilot CLI setup (a short-lived session, no model call): the catalog gets what it lists, the scopes
   * follow, and a server that's new since the last check is said in the chat (D33: ARIA gets its read tools).
   */
  async checkIntegrations(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const run = (async () => {
      const id = this.deps.helperSessions.helperId();
      try {
        if (this.mcpConfigStore?.getState().keepInSync) {
          await this.syncCliMcpBestEffort();
        }
        const mcpState = this.mcpConfigStore?.getState() ?? EMPTY_MCP_CONFIG;
        const disabledServers = mcpState.servers.filter((s) => !s.enabled).map((s) => s.name);
        const mcpServers = this.mcpConfigStore?.buildScopedServers({
          disabledMcpServers: disabledServers,
        });
        const projectPaths = this.deps.isOpen() ? this.deps.db().listRepos().filter((r) => !r.hidden).map((r) => r.path) : [];
        const inventory = await this.deps.options.runtime.inventory({
          sessionId: id,
          ...(mcpServers && Object.keys(mcpServers).length ? { mcpServers } : {}),
          ...(mcpState.pluginDirectories.length ? { pluginDirectories: mcpState.pluginDirectories } : {}),
          ...(mcpState.skillDirectories?.length ? { skillDirectories: mcpState.skillDirectories } : {}),
          ...(mcpState.agentDirectories?.length ? { agentDirectories: mcpState.agentDirectories } : {}),
          ...(mcpState.disabledSkills?.length ? { disabledSkills: mcpState.disabledSkills } : {}),
          ...(projectPaths.length ? { projectPaths } : {}),
          ...(disabledServers.length ? { disabledMcpServers: disabledServers } : {}),
        });
        if (this.deps.stopped()) return;
        const now = Date.now();
        const before = this.catalog;
        let merged = mergeCatalog(before, inventory, now);
        if (this.mcpConfigStore) {
          merged = mergeMcpConfigIntoCatalog(merged, this.mcpConfigStore.getState(), now);
        }
        this.catalog = merged;
        this.refreshError = undefined;
        if (before.checkedAt !== undefined) {
          const known = new Set(before.servers.map((s) => s.name));
          for (const server of this.catalog.servers.filter((s) => isSeen(this.catalog, s) && !known.has(s.name))) {
            this.deps.notice("info", `New in your Copilot CLI setup: “${untrusted(server.name, 60)}”. ARIA can use its read tools, tasks can't; change that in Customize › Integrations.`, "integration_new_server");
          }
        }
        this.saveIntegrations();
        this.deps.wakeTracker();
        await this.deps.refreshConductorTools().catch(this.deps.logFailure("Refreshing ARIA's tools"));
      } catch (error) {
        this.refreshError = untrusted(`Couldn't check your servers: ${message(error)}`);
        // Still the last check's catalog and your rules: the scopes are those.
        if (this.catalog.checkedAt === undefined) this.applyScopes();
      } finally {
        this.deps.helperSessions.helperDone(id);
        this.lastRefreshAt = Date.now();
      }
    })();
    this.refreshing = run;
    this.emitIntegrations();
    try {
      await run;
    } finally {
      this.refreshing = undefined;
      if (!this.deps.stopped()) this.emitIntegrations();
    }
  }

  /** Customize › Integrations' Refresh: one check at a time, not more often than every 30 seconds (each starts every server). */
  async refreshIntegrations(): Promise<IntegrationsState> {
    // The trackers folder is read again with it: a config put there by hand shows up.
    if (this.deps.isOpen()) {
      this.deps.relistTrackers();
      this.emitIntegrations();
    }
    if (!this.deps.runtimeStarted()) throw new Error("ARIA's runtime isn't running, so it can't check your servers.");
    if (this.refreshing) {
      await this.refreshing;
      return this.integrationsState();
    }
    const wait = this.lastRefreshAt + REFRESH_COOLDOWN_MS - Date.now();
    if (wait > 0) throw new Error(`Checked a moment ago: try again in ${Math.ceil(wait / 1000)} s.`);
    await this.checkIntegrations();
    return this.integrationsState();
  }

  setIntegrationRule(input: { server: string; wireName: string; scope: IntegrationScope; effect: ToolRuleEffect | null }): IntegrationsState {
    this.toolRules = setRule(this.catalog, this.toolRules, input);
    this.saveIntegrations();
    this.deps.wakeTracker();
    return this.emitIntegrations();
  }

  /**
   * Your rules for a server that's gone (renamed in the CLI) moved to another one. Customize › Integrations says under
   * the server what moved and what stayed (from the state it emits), so nothing goes to the chat.
   */
  moveIntegrationRules(input: { from: string; to: string }): IntegrationsState {
    const { rules, moved } = moveRules(this.catalog, this.toolRules, input.from, input.to);
    if (moved === 0) throw new Error(`None of your rules for that server match a tool of ${untrusted(input.to, 60)}.`);
    this.toolRules = rules;
    this.saveIntegrations();
    this.deps.wakeTracker();
    return this.emitIntegrations();
  }

  forgetIntegrationServer(input: { server: string }): IntegrationsState {
    const next = forgetServer(this.catalog, this.toolRules, input.server);
    this.catalog = next.catalog;
    this.toolRules = next.rules;
    this.mcpConfigStore?.removeServer(input.server);
    this.mcpTestResults.delete(input.server);
    this.saveIntegrations();
    this.deps.wakeTracker();
    return this.emitIntegrations();
  }

  /**
   * Phase 7A: Imports MCP servers and plugin directories from Copilot CLI (`~/.copilot/mcp-config.json` and runtime
   * config) into ARIA's own MCP configuration while preserving user rules and `"aria"`-customized servers.
   */
  async importCliMcp(input: { overwriteAriaEdits?: boolean } = {}): Promise<{
    state: IntegrationsState;
    imported: number;
    updated: number;
    skipped: number;
  }> {
    if (!this.mcpConfigStore) throw new Error("ARIA engine isn't started");
    const runtimeCfg = await this.deps.options.runtime.readCliMcpConfig?.().catch(() => undefined);
    const now = Date.now();
    const res = this.mcpConfigStore.importFromCliFile(undefined, {
      ...(input.overwriteAriaEdits !== undefined ? { overwriteAriaEdits: input.overwriteAriaEdits } : {}),
      now,
      ...(runtimeCfg?.servers ? { fallbackServers: runtimeCfg.servers } : {}),
      ...(runtimeCfg?.pluginDirectories ? { fallbackPluginDirectories: runtimeCfg.pluginDirectories } : {}),
    });
    this.catalog = mergeMcpConfigIntoCatalog(this.catalog, res.state, now);
    this.saveIntegrations();
    this.deps.wakeTracker();
    const state = this.emitIntegrations();
    return {
      state,
      imported: res.imported,
      updated: res.updated,
      skipped: res.skipped,
    };
  }

  /**
   * Phase 7A: Enables or disables automatic re-import from Copilot CLI on startup and Refresh.
   * When turned on, immediately imports from Copilot CLI so the configuration is synchronized right away.
   */
  async setMcpKeepInSync(input: { keepInSync: boolean } | boolean): Promise<IntegrationsState> {
    if (!this.mcpConfigStore) throw new Error("ARIA engine isn't started");
    const keepInSync = typeof input === "boolean" ? input : input.keepInSync;
    this.mcpConfigStore.setKeepInSync(keepInSync);
    if (keepInSync) {
      await this.importCliMcp().catch((error: unknown) => {
        this.deps.notice("warning", `Couldn't import your Copilot CLI servers (${untrusted(message(error))}). ARIA tries again on the next refresh.`, "mcp_sync_failed");
      });
    }
    this.applyScopes();
    this.deps.wakeTracker();
    return this.emitIntegrations();
  }

  /**
   * Phase 7A: Adds or updates a server in ARIA's own MCP configuration (`source: "aria"`).
   */
  saveMcpServer(input: z.infer<typeof SaveMcpServerInput>): IntegrationsState {
    if (!this.mcpConfigStore) throw new Error("ARIA engine isn't started");
    const now = Date.now();
    this.mcpConfigStore.saveServer(input, now);
    this.catalog = mergeMcpConfigIntoCatalog(this.catalog, this.mcpConfigStore.getState(), now);
    this.saveIntegrations();
    this.deps.wakeTracker();
    return this.emitIntegrations();
  }

  /**
   * Phase 7A: Removes a server from ARIA's own MCP configuration and deletes its encrypted secrets.
   */
  removeMcpServer(input: { server: string } | string): IntegrationsState {
    if (!this.mcpConfigStore) throw new Error("ARIA engine isn't started");
    const serverName = (typeof input === "string" ? input : input.server).trim();
    const existingCfg = this.mcpConfigStore.getServer(serverName);
    this.mcpConfigStore.removeServer(serverName);
    this.mcpTestResults.delete(serverName);
    if (existingCfg?.source === "aria") {
      this.catalog = {
        ...this.catalog,
        servers: this.catalog.servers.filter((s) => s.name !== serverName),
        tools: this.catalog.tools.filter((t) => t.server !== serverName),
      };
      this.toolRules = this.toolRules.filter((r) => r.server !== serverName);
    }
    this.saveIntegrations();
    this.deps.wakeTracker();
    return this.emitIntegrations();
  }

  /**
   * Phase 7A: Saves or clears an encrypted bearer token for an MCP server in `McpSecretStore`.
   */
  setMcpServerToken(input: { server: string; bearerToken: string | null }): IntegrationsState {
    if (!this.mcpConfigStore) throw new Error("ARIA engine isn't started");
    const now = Date.now();
    this.mcpConfigStore.setServerToken(input.server, input.bearerToken, now);
    this.catalog = mergeMcpConfigIntoCatalog(this.catalog, this.mcpConfigStore.getState(), now);
    this.saveIntegrations();
    this.deps.wakeTracker();
    return this.emitIntegrations();
  }

  /**
   * Phase 7A: Tests connectivity to `server` via ARIA's built-in MCP client (`@modelcontextprotocol/sdk`), refreshes
   * discovered tools and their `inputSchema`s in the catalog, and updates `testResult` on the server row.
   */
  async testMcpServer(input: { server: string } | string): Promise<IntegrationTestResult> {
    if (!this.mcpClient || !this.mcpConfigStore) throw new Error("ARIA engine isn't started");
    const serverName = (typeof input === "string" ? input : input.server).trim();
    const catalogServer = this.catalog.servers.find((s) => s.name === serverName);
    const configuredServer = this.mcpConfigStore.getServer(serverName);
    if (!catalogServer && !configuredServer) {
      throw new Error(`The MCP server "${serverName}" isn't in your setup.`);
    }

    const testingResult: IntegrationTestResult = {
      status: "testing",
      at: Date.now(),
    };
    this.mcpTestResults.set(serverName, testingResult);
    this.emitIntegrations();

    const probe = await this.mcpClient.testServer(serverName, { timeoutMs: 15_000 });
    const now = Date.now();
    const finalResult: IntegrationTestResult = probe.ok
      ? {
          status: "ok",
          latencyMs: probe.latencyMs,
          toolCount: probe.toolCount,
          message: `Connected (${probe.toolCount} tool${probe.toolCount === 1 ? "" : "s"}, ${probe.latencyMs} ms)`,
          at: now,
        }
      : {
          status: "failed",
          latencyMs: probe.latencyMs,
          message: untrusted(probe.error ?? "Connection failed", 240),
          at: now,
        };

    this.mcpTestResults.set(serverName, finalResult);
    this.catalog = mergeServerProbeIntoCatalog(
      this.catalog,
      serverName,
      probe,
      now,
      configuredServer,
    );
    this.saveIntegrations();
    this.deps.wakeTracker();
    this.emitIntegrations();
    return finalResult;
  }

  /**
   * Sign in to a server that needs it (Customize › Integrations): one at a time, in a session of its own. Returns the
   * sign-in page for main to open (`https:` only, no user name in it); the window only ever gets its host. When it
   * connects, your setup is checked again so its tools show up.
   */
  async signIn(server: string): Promise<{ url?: string; host?: string; connected?: boolean }> {
    if (!this.deps.runtimeStarted()) throw new Error("ARIA's runtime isn't running, so it can't sign in.");
    if (this.signInRun) throw new Error("Finish or cancel the sign-in that's waiting first.");
    const entry = this.catalog.servers.find((s) => s.name === server);
    if (!entry || !isSeen(this.catalog, entry)) throw new Error("That server isn't in your setup.");
    if (entry.status !== "needs-auth" && entry.status !== "failed") throw new Error("That server doesn't need signing in.");
    const id = this.deps.helperSessions.helperId();
    // Cancel and quitting work from the click on: the runtime can take a while before there's a page (the session's
    // servers load first, up to 30 s). Either one ends it there, and returns once its session is deleted.
    const abort = new AbortController();
    let startingOver!: () => void;
    const startingDone = new Promise<void>((resolve) => (startingOver = resolve));
    const starting = {
      server,
      cancel: async () => {
        abort.abort();
        await startingDone;
      },
    };
    this.signInRun = starting;
    this.signInState = { server, state: "starting", at: Date.now() };
    this.emitIntegrations();
    let start: SignInStart;
    try {
      const mcpState = this.mcpConfigStore?.getState() ?? EMPTY_MCP_CONFIG;
      const mcpServers = this.mcpConfigStore?.buildScopedServers();
      const targetMcpServers = mcpServers?.[server] ? { [server]: mcpServers[server] } : undefined;
      const disabledMcpServers = this.catalog.servers
        .filter((s) => s.name !== server && isSeen(this.catalog, s))
        .map((s) => s.name);
      start = await this.deps.options.runtime.signIn({
        serverName: server,
        sessionId: id,
        ...(entry.installationId ? { installationId: entry.installationId } : {}),
        ...(targetMcpServers ? { mcpServers: targetMcpServers } : {}),
        ...(mcpState.pluginDirectories.length ? { pluginDirectories: mcpState.pluginDirectories } : {}),
        disabledMcpServers,
        timeoutMs: SIGN_IN_TIMEOUT_MS,
        signal: abort.signal,
      });
    } catch (error) {
      this.deps.helperSessions.helperDone(id);
      if (this.signInRun === starting) this.signInRun = undefined;
      startingOver();
      if (!this.deps.stopped()) {
        this.signInState = { server, state: "failed", message: untrusted(message(error)), at: Date.now() };
        this.emitIntegrations();
      }
      throw error;
    }
    if (abort.signal.aborted) {
      // Cancelled while it started: no page to open, and its session is gone before Cancel (or quitting) returns.
      await start.cancel().catch(ignoreCleanupFailure);
      this.deps.helperSessions.helperDone(id);
      if (this.signInRun === starting) this.signInRun = undefined;
      startingOver();
      if (!this.deps.stopped()) {
        this.signInState = { server, state: "cancelled", at: Date.now() };
        this.emitIntegrations();
      }
      return {};
    }
    startingOver();
    const page = start.url !== undefined ? signInPage(start.url) : undefined;
    if (start.url !== undefined && !page) {
      await start.cancel().catch(ignoreCleanupFailure);
      this.deps.helperSessions.helperDone(id);
      if (this.signInRun === starting) this.signInRun = undefined;
      this.signInState = { server, state: "failed", message: "The sign-in page's address isn't one ARIA opens: it has to start with https:// and have no user name in it.", at: Date.now() };
      this.emitIntegrations();
      throw new Error(this.signInState.message);
    }
    this.signInRun = { server, cancel: () => start.cancel() };
    this.signInState = { server, state: "waiting", ...(page ? { host: page.host } : {}), at: Date.now() };
    this.emitIntegrations();
    void start.done.then(async (outcome) => {
      this.deps.helperSessions.helperDone(id);
      if (this.signInRun?.server === server) this.signInRun = undefined;
      if (this.deps.stopped()) return;
      this.signInState = {
        server,
        state: outcome.status,
        ...(page ? { host: page.host } : {}),
        ...(outcome.status === "failed" ? { message: untrusted(outcome.error) } : outcome.status === "timed_out" ? { message: "The sign-in took longer than 5 minutes." } : {}),
        at: Date.now(),
      };
      this.emitIntegrations();
      if (outcome.status !== "connected") return;
      // Its tools are listed once it's connected.
      await this.checkIntegrations().catch(this.deps.logFailure("Checking integrations"));
      // ARIA's open session doesn't get the sign-in: it reopens before your next message if it uses the server.
      if (!this.deps.stopped() && !this.scopes.aria.disabledMcpServers.includes(server)) this.signInsConnected++;
    });
    return { ...(page ? { url: page.url, host: page.host } : { connected: true }) };
  }

  async cancelSignIn(): Promise<void> {
    await this.signInRun?.cancel();
  }
}
