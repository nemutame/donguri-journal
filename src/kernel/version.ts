/**
 * The running server's version, read from package.json at startup so the MCP
 * handshake and storage_stats always report the truth (a hardcoded string
 * silently goes stale). Agents compare this against the published npm version
 * to suggest updates (docs/SETUP.md "Keep it updated").
 */
import { readFileSync } from "node:fs";

export const SERVER_VERSION: string = (() => {
  try {
    // src/kernel/ and dist/kernel/ are both one level below the package root.
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" && version.length > 0 ? version : "unknown";
  } catch (err) {
    // Never let version discovery break server startup — but leave a trace
    // on stderr (stdout is reserved for the MCP protocol).
    console.error("[donguri-journal] could not read package.json version:", err);
    return "unknown";
  }
})();
