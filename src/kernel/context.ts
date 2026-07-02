/**
 * Kernel context — the small, stable surface that every module is given.
 *
 * Modules depend ONLY on this (not on core internals), so the core can evolve
 * without breaking extensions. This is the basis of the "extensible by design"
 * promise; keep it small.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JournalStore, ModuleStorage } from "../db/store.js";
import type { OriginalStore } from "../originals/store.js";
import type { JournalConfig } from "./config.js";

export interface JournalContext {
  /** Register MCP tools (and, later, other capabilities). */
  readonly server: McpServer;
  readonly store: JournalStore;
  readonly originals: OriginalStore;
  readonly config: JournalConfig;
  /** Log to stderr — stdout is reserved for the MCP protocol. */
  readonly log: (...args: unknown[]) => void;
  /**
   * Namespaced module storage: a module's own `ext_<id>_*` tables in the
   * shared database. Journal FACTS stay in core entries/links (visible to
   * every lens, exported, synced); module tables hold view-owned structures
   * and rebuildable caches, referencing entries by id only — never copies of
   * entry content. Declare the `storage` capability in plugin manifests.
   */
  readonly storage: (moduleId: string) => ModuleStorage;
  /**
   * Run a cleanup callback inside every hard-delete transaction, so module
   * rows referencing a purged entry disappear atomically with it.
   */
  readonly onEntryPurged: (hook: (id: number) => void) => void;
}

export function createContext(parts: {
  server: McpServer;
  store: JournalStore;
  originals: OriginalStore;
  config: JournalConfig;
}): JournalContext {
  return {
    ...parts,
    log: (...args: unknown[]) => console.error("[donguri-journal]", ...args),
    storage: (moduleId: string) => parts.store.moduleStorage(moduleId),
    onEntryPurged: (hook: (id: number) => void) => parts.store.onEntryPurged(hook),
  };
}
