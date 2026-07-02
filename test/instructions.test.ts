/**
 * Server instructions are the only pre-tool-list channel to the client LLM,
 * and the only place an agent can learn that hidden opt-in features exist
 * (#34: Codex never discovered the BuJo lens without it).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INSTRUCTIONS } from "../src/kernel/instructions.js";

describe("SERVER_INSTRUCTIONS", () => {
  it("routes agents to the hidden opt-in features", () => {
    // The load-bearing hook: without this pointer, feature tools are undiscoverable.
    assert.match(SERVER_INSTRUCTIONS, /list_features/);
    assert.match(SERVER_INSTRUCTIONS, /enable_feature/);
  });

  it("names the always-on core verbs", () => {
    for (const tool of ["capture", "query_entries", "recall_related", "storage_stats"]) {
      assert.match(SERVER_INSTRUCTIONS, new RegExp(tool));
    }
  });

  it("reaches the client through the MCP initialize handshake", async () => {
    const server = new McpServer(
      { name: "donguri-journal-test", version: "0.0.0" },
      { instructions: SERVER_INSTRUCTIONS },
    );
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
