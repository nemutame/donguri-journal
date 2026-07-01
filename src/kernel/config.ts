/**
 * Centralized configuration, resolved once from the environment. Modules read
 * config through the kernel context rather than touching process.env directly.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface JournalConfig {
  /** SQLite database file path. */
  dbPath: string;
  /** Directory for content-addressed original artifacts. */
  originalsDir: string;
  /** Max accepted size of a single original artifact (decoded bytes). */
  maxOriginalBytes: number;
  /** Directory where installed plugins live (one subdirectory per plugin id). */
  pluginsDir: string;
  /** JSON file recording which plugins are installed / enabled. */
  pluginsConfigPath: string;
  /** Host the management UI binds to. Localhost-only by default. */
  uiHost: string;
  /** Port for the management UI. 0 = an ephemeral port chosen at listen time. */
  uiPort: number;
}

const DEFAULT_MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;

function envOr(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

export function loadConfig(): JournalConfig {
  const home = homedir();
  const max = Number(process.env.JOURNAL_MAX_ORIGINAL_BYTES);
  const uiPort = Number(process.env.JOURNAL_UI_PORT);
  return {
    dbPath: envOr("JOURNAL_DB_PATH", join(home, ".journal-mcp", "journal.db")),
    originalsDir: envOr("JOURNAL_ORIGINALS_DIR", join(home, ".journal-mcp", "originals")),
    maxOriginalBytes:
      Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_MAX_ORIGINAL_BYTES,
    pluginsDir: envOr("JOURNAL_PLUGINS_DIR", join(home, ".journal-mcp", "plugins")),
    pluginsConfigPath: envOr("JOURNAL_PLUGINS_CONFIG", join(home, ".journal-mcp", "plugins.json")),
    uiHost: envOr("JOURNAL_UI_HOST", "127.0.0.1"),
    uiPort: Number.isInteger(uiPort) && uiPort >= 0 && uiPort <= 65535 ? uiPort : 0,
  };
}
