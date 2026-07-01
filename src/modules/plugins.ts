/**
 * Plugins module — agent-driven plugin lifecycle over MCP (no user CLI).
 *
 * Local install is supported now: point install_plugin at a plugin directory,
 * review the declared capabilities, then confirm. On confirm the plugin is
 * copied in, recorded as enabled, and loaded at runtime — because registering
 * tools emits `tools/list_changed`, its tools appear without restarting the
 * client. A hosted registry (list_available_plugins) comes in a later step.
 */
import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { z } from "zod";
import type { JournalContext } from "../kernel/context.js";
import type { JournalModule } from "../kernel/module.js";
import {
  type PluginConfig,
  assertAbsoluteDir,
  isValidPluginId,
  loadPluginConfig,
  loadPluginModule,
  pluginDir,
  readManifest,
  savePluginConfig,
} from "../kernel/plugin.js";
import { errorResult, jsonResult } from "../kernel/result.js";

export const pluginsModule: JournalModule = {
  id: "plugins",
  register(ctx: JournalContext): void {
    const { server, config } = ctx;

    server.registerTool(
      "list_installed_plugins",
      {
        title: "List installed plugins",
        description:
          "List the plugins installed into this journal, with their enabled state, version, and " +
          "declared capabilities. Use this to see what extra tools are available or to check " +
          "before installing/uninstalling.",
        inputSchema: {},
      },
      async () => {
        let cfg: PluginConfig;
        try {
          cfg = await loadPluginConfig(config.pluginsConfigPath);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
        const plugins: Array<{
          id: string;
          enabled: boolean;
          invalid?: boolean;
          name?: string;
          version?: string;
          capabilities?: string[];
        }> = [];
        for (const entry of cfg.plugins) {
          if (!isValidPluginId(entry.id)) {
            plugins.push({ id: entry.id, enabled: entry.enabled, invalid: true });
            continue;
          }
          let name: string | undefined;
          let version: string | undefined;
          let capabilities: string[] = [];
          try {
            const manifest = await readManifest(pluginDir(ctx, entry.id));
            name = manifest.name;
            version = manifest.version;
            capabilities = manifest.capabilities;
          } catch {
            // Manifest unreadable (dir removed manually): still list the id.
          }
          plugins.push({ id: entry.id, enabled: entry.enabled, name, version, capabilities });
        }
        return jsonResult({ count: plugins.length, plugins });
      },
    );

    server.registerTool(
      "install_plugin",
      {
        title: "Install a plugin",
        description:
          "Install a donguri-journal plugin from a local directory. This runs third-party code " +
          "in-process, so it is a TWO-STEP, consented action: first call with just `source` to " +
          "get the plugin's manifest and DECLARED CAPABILITIES; present those to the user; only " +
          "after they approve, call again with `confirm: true`. On confirm the plugin is copied " +
          "in, enabled, and loaded immediately (its tools become available without a restart).",
        inputSchema: {
          source: z
            .string()
            .min(1)
            .describe("Absolute path to the plugin directory (contains donguri.plugin.json)."),
          confirm: z
            .boolean()
            .optional()
            .describe("Set true ONLY after the user approves the manifest + capabilities."),
        },
      },
      async ({ source, confirm }) => {
        try {
          assertAbsoluteDir(source);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
        let manifest: Awaited<ReturnType<typeof readManifest>>;
        try {
          manifest = await readManifest(source);
        } catch (err) {
          return errorResult(`invalid plugin: ${err instanceof Error ? err.message : String(err)}`);
        }

        if (!confirm) {
          return jsonResult({
            requires_confirmation: true,
            manifest: {
              id: manifest.id,
              name: manifest.name,
              version: manifest.version,
              description: manifest.description,
              capabilities: manifest.capabilities,
            },
            message:
              "Show the user the name, version and capabilities. Install runs third-party code — " +
              "call install_plugin again with confirm: true only after they approve.",
          });
        }

        const dest = pluginDir(ctx, manifest.id);
        if (existsSync(dest)) {
          return errorResult(`plugin '${manifest.id}' is already installed; uninstall it first`);
        }

        let cfgBefore: PluginConfig;
        try {
          cfgBefore = await loadPluginConfig(config.pluginsConfigPath);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }

        try {
          await mkdir(config.pluginsDir, { recursive: true });
          await cp(source, dest, { recursive: true });
          const next: PluginConfig = {
            plugins: [
              ...cfgBefore.plugins.filter((p) => p.id !== manifest.id),
              { id: manifest.id, enabled: true },
            ],
          };
          await savePluginConfig(config.pluginsConfigPath, next);
          const mod = await loadPluginModule(dest, manifest);
          await mod.register(ctx);
        } catch (err) {
          // Full rollback covering mkdir/cp/save/load: remove any copied files
          // and restore the prior config.
          await rm(dest, { recursive: true, force: true }).catch(() => {});
          await savePluginConfig(config.pluginsConfigPath, cfgBefore).catch(() => {});
          ctx.log(`install failed for ${manifest.id}:`, err);
          return errorResult(
            `failed to install plugin: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        return jsonResult({
          installed: manifest.id,
          version: manifest.version,
          message: "Installed and active — its tools are now available.",
        });
      },
    );

    server.registerTool(
      "uninstall_plugin",
      {
        title: "Uninstall a plugin",
        description:
          "Remove an installed plugin by id: deletes it from disk and the plugin registry. Note: " +
          "tools it already registered stay available until the server restarts.",
        inputSchema: {
          id: z.string().min(1).describe("The plugin id to uninstall."),
        },
      },
      async ({ id }) => {
        if (!isValidPluginId(id)) {
          return errorResult("invalid plugin id");
        }
        let cfg: PluginConfig;
        try {
          cfg = await loadPluginConfig(config.pluginsConfigPath);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
        const wasInstalled = cfg.plugins.some((p) => p.id === id);
        try {
          // Delete from disk BEFORE updating the registry, so a failed rm can't
          // leave an unlisted-but-present directory that blocks reinstall.
          await rm(pluginDir(ctx, id), { recursive: true, force: true });
          await savePluginConfig(config.pluginsConfigPath, {
            plugins: cfg.plugins.filter((p) => p.id !== id),
          });
        } catch (err) {
          ctx.log(`uninstall failed for ${id}:`, err);
          return errorResult(
            `failed to uninstall plugin: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return jsonResult({
          uninstalled: id,
          was_installed: wasInstalled,
          note: "Removed from disk. Any already-registered tools remain until the server restarts.",
        });
      },
    );
  },
};
