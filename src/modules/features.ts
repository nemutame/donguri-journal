/**
 * Feature toggles — opt-in BUILT-IN modules (as opposed to installed plugins).
 *
 * Lenses and other optional built-ins ship with the core but stay off until
 * the owner enables them in conversation. Enabling registers the feature's
 * tools live (`tools/list_changed`), disabling removes them live — no restart
 * either way. The enabled set persists in the same config file as plugins.
 *
 * Unlike install_plugin this runs no third-party code, so no consent ceremony
 * is needed — it only turns first-party tools on and off.
 */
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { JournalContext } from "../kernel/context.js";
import type { JournalModule } from "../kernel/module.js";
import { loadPluginConfig, savePluginConfig } from "../kernel/plugin.js";
import { errorResult, jsonResult } from "../kernel/result.js";
import { registerBujoTools } from "./bujo.js";

interface BuiltinFeature {
  title: string;
  description: string;
  register: (ctx: JournalContext) => RegisteredTool[];
}

const BUILTIN_FEATURES: Record<string, BuiltinFeature> = {
  bujo: {
    title: "Bullet Journal lens",
    description:
      "Read-only BuJo views over the journal: bujo_day / bujo_month / bujo_future / " +
      "bujo_reconcile (daily, monthly and future logs + the migration ritual).",
    register: registerBujoTools,
  },
};

/** Live tool handles per enabled feature (per-process; the server is per-process). */
const active = new Map<string, RegisteredTool[]>();

/**
 * Own-property lookup only: a config key like "constructor" must not reach
 * Object.prototype and come back truthy.
 */
function getFeature(id: string): BuiltinFeature | undefined {
  return Object.hasOwn(BUILTIN_FEATURES, id) ? BUILTIN_FEATURES[id] : undefined;
}

/** Register every feature enabled in config. Never throws — the server must start. */
export async function loadEnabledFeatures(ctx: JournalContext): Promise<void> {
  let features: Record<string, boolean>;
  try {
    features = (await loadPluginConfig(ctx.config.pluginsConfigPath)).features;
  } catch (err) {
    ctx.log("plugin config unreadable; enabling no features:", err);
    return;
  }
  for (const [id, enabled] of Object.entries(features)) {
    if (!enabled) continue;
    const feature = getFeature(id);
    if (!feature) {
      ctx.log(`ignoring unknown feature in config: ${id}`);
      continue;
    }
    if (!active.has(id)) {
      try {
        active.set(id, feature.register(ctx));
        ctx.log(`feature enabled: ${id}`);
      } catch (err) {
        // A broken feature must not take the whole server down at startup.
        active.delete(id);
        ctx.log(`failed to enable feature ${id}:`, err);
      }
    }
  }
}

export const featuresModule: JournalModule = {
  id: "features",
  register(ctx: JournalContext): void {
    const { server, config } = ctx;

    server.registerTool(
      "list_features",
      {
        title: "List built-in opt-in features",
        description:
          "List the built-in opt-in features (e.g. lens views like the Bullet Journal lens) " +
          "with their enabled state. Use this when the user asks what views/extras are " +
          "available, then enable_feature to turn one on.",
        inputSchema: {},
      },
      async () => {
        const features = Object.entries(BUILTIN_FEATURES).map(([id, f]) => ({
          id,
          title: f.title,
          description: f.description,
          enabled: active.has(id),
        }));
        return jsonResult({ count: features.length, features });
      },
    );

    server.registerTool(
      "enable_feature",
      {
        title: "Enable a built-in feature",
        description:
          "Turn on a built-in opt-in feature by id (see list_features). Its tools register " +
          "immediately — no restart — and the choice persists across sessions. First-party " +
          "code only; this is not plugin installation.",
        inputSchema: {
          id: z.string().min(1).describe("The feature id, e.g. 'bujo'."),
        },
      },
      async ({ id }) => {
        const feature = getFeature(id);
        if (!feature) {
          return errorResult(
            `unknown feature '${id}' — available: ${Object.keys(BUILTIN_FEATURES).join(", ")}`,
          );
        }
        try {
          const cfg = await loadPluginConfig(config.pluginsConfigPath);
          await savePluginConfig(config.pluginsConfigPath, {
            ...cfg,
            features: { ...cfg.features, [id]: true },
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
        const alreadyLive = active.has(id);
        if (!alreadyLive) {
          active.set(id, feature.register(ctx));
        }
        return jsonResult({
          enabled: id,
          already_enabled: alreadyLive,
          message: `${feature.title} is active — its tools are available now.`,
        });
      },
    );

    server.registerTool(
      "disable_feature",
      {
        title: "Disable a built-in feature",
        description:
          "Turn off a built-in opt-in feature by id. Its tools disappear immediately and it " +
          "stays off across sessions. Journal data is untouched — a lens is only a view, so " +
          "disabling one loses nothing.",
        inputSchema: {
          id: z.string().min(1).describe("The feature id, e.g. 'bujo'."),
        },
      },
      async ({ id }) => {
        if (!getFeature(id)) {
          return errorResult(
            `unknown feature '${id}' — available: ${Object.keys(BUILTIN_FEATURES).join(", ")}`,
          );
        }
        try {
          const cfg = await loadPluginConfig(config.pluginsConfigPath);
          await savePluginConfig(config.pluginsConfigPath, {
            ...cfg,
            features: { ...cfg.features, [id]: false },
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
        const handles = active.get(id) ?? [];
        for (const handle of handles) {
          handle.remove();
        }
        active.delete(id);
        return jsonResult({ disabled: id, removed_tools: handles.length });
      },
    );
  },
};
