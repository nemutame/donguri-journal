/**
 * Kernel context — the small, stable surface that every module is given.
 *
 * Modules depend ONLY on this (not on core internals), so the core can evolve
 * without breaking extensions. This is the basis of the "extensible by design"
 * promise; keep it small.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JournalStore } from "../db/store.js";
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
  };
}
