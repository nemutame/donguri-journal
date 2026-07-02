/**
 * Feature toggles over a real MCP round-trip: list → enable (tools appear
 * live) → disable (tools vanish), plus the playbook container (#32) — a
 * feature's workflow guide rides along in the enable_feature result instead
 * of being crammed into tool descriptions.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JournalStore } from "../src/db/store.js";
import type { JournalConfig } from "../src/kernel/config.js";
import { createContext } from "../src/kernel/context.js";
import { registerModules } from "../src/kernel/module.js";
import { PLAYBOOK_INSTALL_HINT, featuresModule, playbookPayload } from "../src/modules/features.js";
import { createOriginalStore } from "../src/originals/store.js";
import { FakeEmbedder } from "./helpers/fake-embedder.js";
import { type TempDir, makeTempDir } from "./helpers/tmp.js";

describe("playbookPayload", () => {
  it("is empty for a feature without a playbook", () => {
    assert.deepEqual(playbookPayload({}), {});
    assert.deepEqual(playbookPayload({ playbook: undefined }), {});
    // An empty playbook is no playbook — same predicate as has_playbook.
    assert.deepEqual(playbookPayload({ playbook: "" }), {});
  });

  it("carries the playbook plus the install hint", () => {
    const payload = playbookPayload({ playbook: "# Morning ritual\n1. reconcile" });
    assert.equal(payload.playbook, "# Morning ritual\n1. reconcile");
    assert.equal(payload.playbook_hint, PLAYBOOK_INSTALL_HINT);
  });

  it("hint enforces client scope and server-canonical re-fetch", () => {
    // The two rules that keep playbook installs safe (#21) and fresh (#32).
    assert.match(PLAYBOOK_INSTALL_HINT, /only your own client/i);
    assert.match(PLAYBOOK_INSTALL_HINT, /enable_feature/);
  });
});

describe("feature toggles over MCP", () => {
  let tmp: TempDir;
  let store: JournalStore;
  let client: Client;
  let server: McpServer;

  function parse(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
    const [first] = result.content as Array<{ type: string; text: string }>;
    assert.ok(first, "tool result has a content block");
    return JSON.parse(first.text) as Record<string, unknown>;
  }

  before(async () => {
    tmp = makeTempDir();
    store = new JournalStore(tmp.file("features.db"), new FakeEmbedder());
    store.init();
    const config: JournalConfig = {
      dbPath: tmp.file("features.db"),
      originalsDir: tmp.file("originals"),
      maxOriginalBytes: 1024,
      pluginsDir: tmp.file("plugins"),
      pluginsConfigPath: tmp.file("plugins.json"),
      uiHost: "127.0.0.1",
      uiPort: 0,
    };
    server = new McpServer({ name: "features-test", version: "0.0.0" });
    const ctx = createContext({
      server,
      store,
      originals: createOriginalStore(config.originalsDir),
      config,
    });
    await registerModules(ctx, [featuresModule]);
    client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  after(async () => {
    await client.close();
    await server.close();
    tmp.cleanup();
  });

  it("lists bujo with enabled state and playbook presence", async () => {
    const body = parse(await client.callTool({ name: "list_features", arguments: {} }));
    const features = body.features as Array<Record<string, unknown>>;
    const bujo = features.find((f) => f.id === "bujo");
    assert.ok(bujo, "bujo feature is listed");
    assert.equal(bujo.enabled, false);
    assert.equal(typeof bujo.has_playbook, "boolean");
  });

  it("enable registers the feature's tools live; disable removes them", async () => {
    const toolNames = async () => (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!(await toolNames()).includes("bujo_day"));

    const enabled = parse(
      await client.callTool({ name: "enable_feature", arguments: { id: "bujo" } }),
    );
    assert.equal(enabled.enabled, "bujo");
    assert.ok((await toolNames()).includes("bujo_day"));

    // Idempotent re-enable: same payload shape, no duplicate registration.
    const again = parse(
      await client.callTool({ name: "enable_feature", arguments: { id: "bujo" } }),
    );
    assert.equal(again.already_enabled, true);

    const disabled = parse(
      await client.callTool({ name: "disable_feature", arguments: { id: "bujo" } }),
    );
    assert.equal(disabled.disabled, "bujo");
    assert.ok(!(await toolNames()).includes("bujo_day"));
  });

  it("rejects unknown feature ids", async () => {
    const result = await client.callTool({ name: "enable_feature", arguments: { id: "nope" } });
    assert.equal(result.isError, true);
  });
});
