#!/usr/bin/env node
/**
 * donguri-journal — local-first, time-aware journaling memory server over MCP.
 *
 * Minimal skeleton: starts an MCP server over stdio with no tools registered
 * yet. Phase 1 adds the SQLite store, in-process embeddings, and the
 * capture / query_entries / recall_related tools.
 *
 * NOTE: stdout is reserved for the MCP protocol. All logging goes to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "donguri-journal",
  version: "0.0.0",
});

// Tools (capture / query_entries / recall_related) are registered in Phase 1.

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("donguri-journal MCP server running on stdio");
}

main().catch((err: unknown) => {
  console.error("Fatal error starting donguri-journal:", err);
  process.exit(1);
});
