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

export interface BuiltinFeature {
  title: string;
  description: string;
  /**
   * Agent-facing markdown playbook: the multi-step workflow the feature's
   * tools are primitives FOR (e.g. the BuJo morning ritual). Tool descriptions
   * can't carry a workflow — they are size-constrained and always in context —
   * so the playbook rides along in the enable_feature result instead, with a
   * hint to install it into the client's own skill mechanism.
   */
  playbook?: string;
  register: (ctx: JournalContext) => RegisteredTool[];
}

/**
 * How the agent should handle a playbook it just received. Mirrors the
 * client-scope rule from docs/SETUP.md: only your own client's files, and the
 * server stays the single source of truth (re-fetch instead of hand-editing).
 */
export const PLAYBOOK_INSTALL_HINT =
  "This playbook is how the feature is meant to be driven. Follow it now, and offer to " +
  "save it into the user's agent-instructions mechanism (a skill, a rules file, " +
  "AGENTS.md / CLAUDE.md — whatever YOUR client uses) so future sessions follow it " +
  "without re-fetching. Touch only your own client's files; if unsure which client that " +
  "is, ask. The server copy is canonical — re-run enable_feature anytime to re-read it.";

/** The playbook fields of an enable_feature result — empty when there is none. */
export function playbookPayload(feature: Pick<BuiltinFeature, "playbook">): {
  playbook?: string;
  playbook_hint?: string;
} {
  if (!feature.playbook) return {};
  return { playbook: feature.playbook, playbook_hint: PLAYBOOK_INSTALL_HINT };
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
          "with their enabled state. Feature tools stay hidden until enabled, so this list is " +
          "the only way to discover them — check it before concluding the server lacks a " +
          "capability, and when the user asks what views/extras are available. Then " +
          "enable_feature to turn one on.",
        inputSchema: {},
      },
      async () => {
        const features = Object.entries(BUILTIN_FEATURES).map(([id, f]) => ({
          id,
          title: f.title,
          description: f.description,
          enabled: active.has(id),
          has_playbook: f.playbook !== undefined,
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
          "code only; this is not plugin installation. If the feature ships a playbook " +
          "(agent workflow guide), the result includes it — calling this again on an " +
          "already-enabled feature is harmless and simply re-reads the playbook.",
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
          ...playbookPayload(feature),
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
