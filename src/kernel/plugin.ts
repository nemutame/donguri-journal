/**
 * Plugin loading.
 *
 * A plugin is a directory containing a `donguri.plugin.json` manifest and an ESM
 * entry that default-exports a JournalModule. Installed plugins live under
 * `config.pluginsDir/<id>`; which ones are enabled is recorded in
 * `config.pluginsConfigPath`.
 *
 * SECURITY: installing a plugin runs third-party code in-process with the same
 * access as the core. Installation therefore requires explicit owner
 * confirmation (see the install_plugin tool), and manifests declare the
 * capabilities they need. Capability *enforcement* (a restricted context) and
 * process isolation are later hardening steps — today the declared capabilities
 * are surfaced for consent but not yet sandboxed.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { JournalContext } from "./context.js";
import type { JournalModule } from "./module.js";

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const manifestSchema = z.object({
  id: z.string().regex(PLUGIN_ID, "id must be a lowercase slug (a-z, 0-9, -)"),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  /** Entry file relative to the plugin directory. */
  main: z.string().default("index.js"),
  /** Capabilities the plugin declares it needs (shown for consent). */
  capabilities: z.array(z.string()).default([]),
  /** Kernel API version the plugin targets (for future compatibility checks). */
  kernelApi: z.string().optional(),
});

export type PluginManifest = z.infer<typeof manifestSchema>;

const pluginConfigSchema = z.object({
  plugins: z.array(z.object({ id: z.string(), enabled: z.boolean() })).default([]),
});

export type PluginConfig = z.infer<typeof pluginConfigSchema>;

export async function loadPluginConfig(path: string): Promise<PluginConfig> {
  if (!existsSync(path)) return { plugins: [] };
  const raw = await readFile(path, "utf8");
  try {
    return pluginConfigSchema.parse(JSON.parse(raw));
  } catch (err) {
    // Do NOT silently fall back to empty: a caller that then saves would wipe
    // the enabled-plugins list. Surface it so callers can abort.
    throw new Error(
      `plugin config at ${path} is unreadable/invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function savePluginConfig(path: string, cfg: PluginConfig): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  // Write atomically (tmp + rename) so an interrupted write can't corrupt it.
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(cfg, null, 2));
  await rename(tmp, path);
}

/** Read + validate a plugin manifest from a plugin directory. */
export async function readManifest(dir: string): Promise<PluginManifest> {
  const manifestPath = join(dir, "donguri.plugin.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`no donguri.plugin.json in ${dir}`);
  }
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  // `main` must stay inside the plugin directory. Check on a path boundary (not
  // a bare prefix) so a sibling like `<dir>-evil` can't pass the guard.
  const base = resolve(dir);
  const entry = resolve(dir, manifest.main);
  if (entry !== base && !entry.startsWith(base + sep)) {
    throw new Error("manifest.main escapes the plugin directory");
  }
  return manifest;
}

/** Dynamically import a plugin's module and validate its shape. */
export async function loadPluginModule(
  dir: string,
  manifest: PluginManifest,
): Promise<JournalModule> {
  const entry = resolve(dir, manifest.main);
  const imported = (await import(pathToFileURL(entry).href)) as {
    default?: unknown;
    module?: unknown;
  };
  const candidate = imported.default ?? imported.module;
  if (!isJournalModule(candidate)) {
    throw new Error(`plugin ${manifest.id} does not export a JournalModule`);
  }
  return candidate;
}

function isJournalModule(value: unknown): value is JournalModule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as JournalModule).id === "string" &&
    typeof (value as JournalModule).register === "function"
  );
}

/** Load and register every enabled installed plugin. Never throws — a bad
 *  plugin is logged and skipped so the server still starts. */
export async function loadInstalledPlugins(ctx: JournalContext): Promise<void> {
  let cfg: PluginConfig;
  try {
    cfg = await loadPluginConfig(ctx.config.pluginsConfigPath);
  } catch (err) {
    ctx.log("plugin config unreadable; loading no plugins:", err);
    return;
  }
  for (const entry of cfg.plugins) {
    if (!entry.enabled) continue;
    if (!PLUGIN_ID.test(entry.id)) {
      ctx.log(`skipping plugin with invalid id: ${entry.id}`);
      continue;
    }
    const dir = join(ctx.config.pluginsDir, entry.id);
    try {
      const manifest = await readManifest(dir);
      const mod = await loadPluginModule(dir, manifest);
      await mod.register(ctx);
      ctx.log(`plugin loaded: ${manifest.id}@${manifest.version}`);
    } catch (err) {
      ctx.log(`failed to load plugin ${entry.id}:`, err);
    }
  }
}

export function isValidPluginId(id: string): boolean {
  return PLUGIN_ID.test(id);
}

export function pluginDir(ctx: JournalContext, id: string): string {
  return join(ctx.config.pluginsDir, id);
}

export function assertAbsoluteDir(source: string): void {
  if (!isAbsolute(source) || !existsSync(source)) {
    throw new Error("source must be an absolute path to an existing plugin directory");
  }
}
