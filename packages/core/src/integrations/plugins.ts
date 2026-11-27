import type { InstalledPluginItem, IntegrationsState, MarketplaceCatalogPlugin, NoticeItem } from "@aria/protocol";
import type { EngineOptions } from "../engine-options.ts";
import type { Integrations } from "./integrations.ts";
import { untrusted } from "./rules.ts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface PluginsDeps {
  integrations: Integrations;
  options: EngineOptions;
  runtimeStarted: () => boolean;
  projectRoots: () => string[];
  refreshConductorTools: () => Promise<void>;
  logFailure: (step: string) => (error: unknown) => void;
  notice: (level: NoticeItem["level"], text: string, cause?: string) => void;
}

/** Customize › Integrations' marketplaces, plugins, agents and skills: through the runtime, then your setup is checked again. */
export class Plugins {
  constructor(private readonly deps: PluginsDeps) {}

  async addMarketplace(input: { source: string } | string): Promise<{ state: IntegrationsState; name: string }> {
    if (!this.deps.runtimeStarted()) throw new Error("ARIA's runtime isn't running.");
    if (!this.deps.options.runtime.addMarketplace) throw new Error("This runtime does not support adding marketplaces.");
    const source = (typeof input === "string" ? input : input.source).trim();
    if (!source) throw new Error("Enter a marketplace source (owner/repo, URL, or local path).");
    const workingDirectory = this.deps.projectRoots()[0] ?? this.deps.options.dataDir;
    const res = await this.deps.options.runtime.addMarketplace(source, workingDirectory);
    await this.deps.integrations.checkIntegrations().catch(this.deps.logFailure("Checking integrations"));
    return { state: this.deps.integrations.emitIntegrations(), name: res.name };
  }

  async removeMarketplace(input: { name: string; force?: boolean }): Promise<{
    state: IntegrationsState;
    removed: boolean;
    dependentPlugins?: string[];
  }> {
    if (!this.deps.runtimeStarted()) throw new Error("ARIA's runtime isn't running.");
    if (!this.deps.options.runtime.removeMarketplace) throw new Error("This runtime does not support removing marketplaces.");
    const name = input.name.trim();
    if (!name) throw new Error("Specify the marketplace name to remove.");
    const res = await this.deps.options.runtime.removeMarketplace(name, input.force);
    if (res.removed) {
      await this.deps.integrations.checkIntegrations().catch(this.deps.logFailure("Checking integrations"));
    }
    return {
      state: this.deps.integrations.emitIntegrations(),
      removed: res.removed,
      ...(res.dependentPlugins?.length ? { dependentPlugins: res.dependentPlugins } : {}),
    };
  }

  async browseMarketplace(input: { name: string } | string): Promise<{ plugins: MarketplaceCatalogPlugin[] }> {
    if (!this.deps.runtimeStarted()) throw new Error("ARIA's runtime isn't running.");
    if (!this.deps.options.runtime.browseMarketplace) throw new Error("This runtime does not support browsing marketplaces.");
    const name = (typeof input === "string" ? input : input.name).trim();
    if (!name) throw new Error("Specify the marketplace name to browse.");
    const plugins = await this.deps.options.runtime.browseMarketplace(name);
    return { plugins };
  }

  async refreshMarketplaces(input: { name?: string } = {}): Promise<IntegrationsState> {
    if (!this.deps.runtimeStarted()) throw new Error("ARIA's runtime isn't running.");
    if (this.deps.options.runtime.refreshMarketplaces) {
      await this.deps.options.runtime.refreshMarketplaces(input.name?.trim() || undefined);
    }
    await this.deps.integrations.checkIntegrations();
    return this.deps.integrations.emitIntegrations();
  }

  async installPlugin(input: { source: string } | string): Promise<{
    state: IntegrationsState;
    plugin: InstalledPluginItem;
    skillsInstalled: number;
    postInstallMessage?: string;
    deprecationWarning?: string;
  }> {
    if (!this.deps.runtimeStarted()) throw new Error("ARIA's runtime isn't running.");
    if (!this.deps.options.runtime.installPlugin) throw new Error("This runtime does not support installing plugins.");
    const source = (typeof input === "string" ? input : input.source).trim();
    if (!source) throw new Error("Enter a plugin spec (e.g. plugin@marketplace, owner/repo, or path).");
    const workingDirectory = this.deps.projectRoots()[0] ?? this.deps.options.dataDir;
    const res = await this.deps.options.runtime.installPlugin(source, workingDirectory);
    await this.deps.integrations.checkIntegrations().catch(this.deps.logFailure("Checking integrations"));
    return {
      state: this.deps.integrations.emitIntegrations(),
      plugin: res.plugin,
      skillsInstalled: res.skillsInstalled,
      ...(res.postInstallMessage ? { postInstallMessage: res.postInstallMessage } : {}),
      ...(res.deprecationWarning ? { deprecationWarning: res.deprecationWarning } : {}),
    };
  }

  async uninstallPlugin(input: { name: string; directSourceId?: string }): Promise<IntegrationsState> {
    if (!this.deps.runtimeStarted()) throw new Error("ARIA's runtime isn't running.");
    if (!this.deps.options.runtime.uninstallPlugin) throw new Error("This runtime does not support uninstalling plugins.");
    const name = input.name.trim();
    if (!name) throw new Error("Specify the plugin name to uninstall.");
    await this.deps.options.runtime.uninstallPlugin(name, input.directSourceId);
    await this.deps.integrations.checkIntegrations().catch(this.deps.logFailure("Checking integrations"));
    return this.deps.integrations.emitIntegrations();
  }

  async updatePlugin(input: { name?: string } = {}): Promise<{
    state: IntegrationsState;
    updatedCount: number;
    message?: string;
  }> {
    if (!this.deps.runtimeStarted()) throw new Error("ARIA's runtime isn't running.");
    if (!this.deps.options.runtime.updatePlugin) throw new Error("This runtime does not support updating plugins.");
    const res = await this.deps.options.runtime.updatePlugin(input.name?.trim() || undefined);
    await this.deps.integrations.checkIntegrations().catch(this.deps.logFailure("Checking integrations"));
    return {
      state: this.deps.integrations.emitIntegrations(),
      updatedCount: res.updatedCount,
      ...(res.message ? { message: res.message } : {}),
    };
  }

  async setPluginEnabled(input: { name: string; enabled: boolean }): Promise<IntegrationsState> {
    if (!this.deps.runtimeStarted()) throw new Error("ARIA's runtime isn't running.");
    if (!this.deps.options.runtime.setPluginEnabled) throw new Error("This runtime does not support toggling plugins.");
    const name = input.name.trim();
    if (!name) throw new Error("Specify the plugin name.");
    const workingDirectory = this.deps.projectRoots()[0] ?? this.deps.options.dataDir;
    await this.deps.options.runtime.setPluginEnabled(name, input.enabled, workingDirectory);
    if (this.deps.integrations.catalog.plugins) {
      const at = name.includes("@") ? name.lastIndexOf("@") : -1;
      const targetName = at > 0 ? name.slice(0, at).trim() : name;
      const targetMp = at > 0 ? name.slice(at + 1).trim() : undefined;
      this.deps.integrations.catalog = {
        ...this.deps.integrations.catalog,
        plugins: this.deps.integrations.catalog.plugins.map((p) =>
          (targetMp !== undefined ? p.name === targetName && p.marketplace === targetMp : p.name === targetName)
            ? { ...p, enabled: input.enabled }
            : p,
        ),
      };
      this.deps.integrations.saveIntegrations();
    }
    await this.deps.integrations.checkIntegrations().catch(this.deps.logFailure("Checking integrations"));
    return this.deps.integrations.emitIntegrations();
  }

  async setSkillEnabled(input: { name: string; enabled: boolean }): Promise<IntegrationsState> {
    if (!this.deps.integrations.mcpConfigStore) throw new Error("ARIA engine isn't started");
    const name = input.name.trim();
    if (!name) throw new Error("Specify the skill name.");
    this.deps.integrations.mcpConfigStore.setSkillDisabled(name, !input.enabled);
    if (this.deps.runtimeStarted() && this.deps.options.runtime.setSkillEnabled) {
      await this.deps.options.runtime.setSkillEnabled(name, input.enabled).catch((error: unknown) => {
        this.deps.notice("warning", `Couldn't turn ${input.enabled ? "on" : "off"} the skill ${untrusted(name, 60)} in the sessions already open (${untrusted(message(error))}). Sessions that open from now on follow your choice.`, "skill_toggle_failed");
      });
    }
    if (this.deps.integrations.catalog.skills) {
      this.deps.integrations.catalog = {
        ...this.deps.integrations.catalog,
        skills: this.deps.integrations.catalog.skills.map((s) => (s.name === name ? { ...s, enabled: input.enabled } : s)),
      };
    }
    this.deps.integrations.saveIntegrations();
    await this.deps.refreshConductorTools().catch(this.deps.logFailure("Refreshing ARIA's tools"));
    return this.deps.integrations.emitIntegrations();
  }

  async addPluginDirectory(input: { path: string } | string): Promise<IntegrationsState> {
    if (!this.deps.integrations.mcpConfigStore) throw new Error("ARIA engine isn't started");
    const dir = (typeof input === "string" ? input : input.path).trim();
    this.deps.integrations.mcpConfigStore.addPluginDirectory(dir);
    this.deps.integrations.saveIntegrations();
    if (this.deps.runtimeStarted()) await this.deps.integrations.checkIntegrations().catch(this.deps.logFailure("Checking integrations"));
    return this.deps.integrations.emitIntegrations();
  }

  async removePluginDirectory(input: { path: string } | string): Promise<IntegrationsState> {
    if (!this.deps.integrations.mcpConfigStore) throw new Error("ARIA engine isn't started");
    const dir = (typeof input === "string" ? input : input.path).trim();
    this.deps.integrations.mcpConfigStore.removePluginDirectory(dir);
    this.deps.integrations.saveIntegrations();
    if (this.deps.runtimeStarted()) await this.deps.integrations.checkIntegrations().catch(this.deps.logFailure("Checking integrations"));
    return this.deps.integrations.emitIntegrations();
  }

  async addSkillDirectory(input: { path: string } | string): Promise<IntegrationsState> {
    if (!this.deps.integrations.mcpConfigStore) throw new Error("ARIA engine isn't started");
    const dir = (typeof input === "string" ? input : input.path).trim();
    this.deps.integrations.mcpConfigStore.addSkillDirectory(dir);
    this.deps.integrations.saveIntegrations();
    if (this.deps.runtimeStarted()) await this.deps.integrations.checkIntegrations().catch(this.deps.logFailure("Checking integrations"));
    return this.deps.integrations.emitIntegrations();
  }

  async removeSkillDirectory(input: { path: string } | string): Promise<IntegrationsState> {
    if (!this.deps.integrations.mcpConfigStore) throw new Error("ARIA engine isn't started");
    const dir = (typeof input === "string" ? input : input.path).trim();
    this.deps.integrations.mcpConfigStore.removeSkillDirectory(dir);
    this.deps.integrations.saveIntegrations();
    if (this.deps.runtimeStarted()) await this.deps.integrations.checkIntegrations().catch(this.deps.logFailure("Checking integrations"));
    return this.deps.integrations.emitIntegrations();
  }

  async addAgentDirectory(input: { path: string } | string): Promise<IntegrationsState> {
    if (!this.deps.integrations.mcpConfigStore) throw new Error("ARIA engine isn't started");
    const dir = (typeof input === "string" ? input : input.path).trim();
    this.deps.integrations.mcpConfigStore.addAgentDirectory(dir);
    this.deps.integrations.saveIntegrations();
    if (this.deps.runtimeStarted()) await this.deps.integrations.checkIntegrations().catch(this.deps.logFailure("Checking integrations"));
    return this.deps.integrations.emitIntegrations();
  }

  async removeAgentDirectory(input: { path: string } | string): Promise<IntegrationsState> {
    if (!this.deps.integrations.mcpConfigStore) throw new Error("ARIA engine isn't started");
    const dir = (typeof input === "string" ? input : input.path).trim();
    this.deps.integrations.mcpConfigStore.removeAgentDirectory(dir);
    this.deps.integrations.saveIntegrations();
    if (this.deps.runtimeStarted()) await this.deps.integrations.checkIntegrations().catch(this.deps.logFailure("Checking integrations"));
    return this.deps.integrations.emitIntegrations();
  }
}
