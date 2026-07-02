#!/usr/bin/env node
/**
 * donguri-journal — local-first, time-aware journaling memory server over MCP.
 *
 * A squirrel stashing acorns (capture) and digging them up later (recall).
 * The front-end multimodal LLM is the companion/UI; this server is the
 * persistent memory organ behind it.
 *
 * This entrypoint is deliberately thin: it builds the kernel context and
 * registers a list of modules. The core tools live in the `core` module; opt-in
 * features plug in the same way.
 *
 * NOTE: stdout is reserved for the MCP protocol. All logging goes to stderr.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JournalStore } from "./db/store.js";
import { createEmbeddingProvider } from "./embedding/provider.js";
import { loadConfig } from "./kernel/config.js";
import { createContext } from "./kernel/context.js";
import { SERVER_INSTRUCTIONS } from "./kernel/instructions.js";
import { type JournalModule, registerModules } from "./kernel/module.js";
import { loadInstalledPlugins } from "./kernel/plugin.js";
import { SERVER_VERSION } from "./kernel/version.js";
import { managementModule } from "./management/module.js";
import { coreModule } from "./modules/core.js";
import { featuresModule, loadEnabledFeatures } from "./modules/features.js";
import { pluginsModule } from "./modules/plugins.js";
import { createOriginalStore } from "./originals/store.js";

const config = loadConfig();
mkdirSync(dirname(config.dbPath), { recursive: true });

const store = new JournalStore(config.dbPath, createEmbeddingProvider());
store.init();
const originals = createOriginalStore(config.originalsDir);

const server = new McpServer(
  { name: "donguri-journal", version: SERVER_VERSION },
  { instructions: SERVER_INSTRUCTIONS },
);
const ctx = createContext({ server, store, originals, config });

// Built-in modules. Installed plugins and opt-in features load separately (below).
const modules: JournalModule[] = [coreModule, managementModule, pluginsModule, featuresModule];

async function main(): Promise<void> {
  await registerModules(ctx, modules);
  await loadInstalledPlugins(ctx);
  await loadEnabledFeatures(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  ctx.log(`running on stdio (db: ${config.dbPath})`);
}

main().catch((err: unknown) => {
  console.error("Fatal error starting donguri-journal:", err);
  process.exit(1);
});
