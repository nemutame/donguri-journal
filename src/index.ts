#!/usr/bin/env node
/**
 * donguri-journal — local-first, time-aware journaling memory server over MCP.
 *
 * A squirrel stashing acorns (capture) and digging them up later (recall).
 * The front-end multimodal LLM is the companion/UI; this server is the
 * persistent memory organ behind it.
 *
 * NOTE: stdout is reserved for the MCP protocol. All logging goes to stderr.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { JournalStore } from "./db/store.js";
import { createEmbeddingProvider } from "./embedding/provider.js";

function resolveDbPath(): string {
  const fromEnv = process.env.JOURNAL_DB_PATH;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".journal-mcp", "journal.db");
}

const dbPath = resolveDbPath();
mkdirSync(dirname(dbPath), { recursive: true });

const embedder = createEmbeddingProvider();
const store = new JournalStore(dbPath, embedder);
store.init();

const server = new McpServer({ name: "donguri-journal", version: "0.1.0" });

function jsonResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

server.registerTool(
  "capture",
  {
    title: "Capture a memory (stash an acorn)",
    description:
      "Stash something into the user's long-term journal memory. Call this PROACTIVELY and " +
      "with low friction whenever the user shares something worth remembering — a thought, an " +
      "event, a decision, a link, a photo, a voice note — without interrogating them for " +
      "details. For images / audio / URLs, YOU (the multimodal model) extract a faithful text " +
      "description and pass it as `body`; this server does not process media. Put a pointer to " +
      "the original (file path / URL) in `original_ref`. Set `occurred_at` when the event " +
      "happened at a different time than now (e.g. 'yesterday', 'last week'); otherwise it " +
      "defaults to the capture time. Identical captures are de-duplicated automatically.",
    inputSchema: {
      body: z
        .string()
        .min(1)
        .describe(
          "The text to index and recall later. For non-text sources, this is your faithful " +
            "extracted description/transcript of the original.",
        ),
      source_kind: z
        .enum(["text", "image", "audio", "url", "note"])
        .optional()
        .describe("What the memory originated from. Defaults to 'text'."),
      original_ref: z
        .string()
        .optional()
        .describe("Pointer to the verbatim original artifact (file path or URL), if any."),
      extraction_state: z
        .enum(["verbatim", "llm_extracted"])
        .optional()
        .describe(
          "'verbatim' when `body` is the original text; 'llm_extracted' when you derived it " +
            "from media/a URL (lossy, may be re-extracted later). Defaults to 'verbatim'.",
        ),
      tags: z.array(z.string()).optional().describe("Optional labels for structured lookup."),
      meta: z
        .record(z.unknown())
        .optional()
        .describe("Optional structured metadata (e.g. mood, location, people)."),
      occurred_at: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe(
          "ISO-8601 timestamp (e.g. 2026-06-20T09:00:00Z) of when the event actually " +
            "happened, if different from now. Must include a time so range queries stay correct.",
        ),
    },
  },
  async (args) => {
    const result = await store.insert(args);
    return jsonResult(result);
  },
);

server.registerTool(
  "query_entries",
  {
    title: "Query entries by time / tag / kind",
    description:
      "Structured lookup over the journal for PRECISE, filterable questions: a date or date " +
      "range, a tag, a source kind. Use this for 'what did I write last week', 'show my notes " +
      "tagged work', BuJo-style weekly/monthly reviews — anything answerable by filters rather " +
      "than meaning. Choose `time_field`: 'created_at' (when captured) or 'occurred_at' (when " +
      "the event happened). For meaning-based 'have I thought about X before' questions, use " +
      "recall_related instead.",
    inputSchema: {
      since: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe("ISO-8601 timestamp; lower bound (inclusive)."),
      until: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe("ISO-8601 timestamp; upper bound (inclusive)."),
      source_kind: z.string().optional().describe("Filter by source kind."),
      tag: z.string().optional().describe("Filter to entries carrying this tag."),
      time_field: z
        .enum(["created_at", "occurred_at"])
        .optional()
        .describe("Which timestamp to filter and sort by. Defaults to 'created_at'."),
      limit: z.number().int().optional().describe("Max rows (1-500, default 50)."),
    },
  },
  async (args) => {
    const entries = store.query(args);
    return jsonResult({ count: entries.length, entries });
  },
);

server.registerTool(
  "recall_related",
  {
    title: "Recall related memories (dig up acorns)",
    description:
      "Semantic search: find past entries related in MEANING to a query, even with different " +
      "wording. Call this PROACTIVELY when the user reflects, wonders, or revisits a topic " +
      "('have I felt this before?', 'what was that idea about...') so you can surface relevant " +
      "past memories. For exact date/tag filtering use query_entries instead. Results are " +
      "ordered by similarity (smaller `distance` = closer).",
    inputSchema: {
      query: z.string().min(1).describe("Natural-language description of what to recall."),
      k: z.number().int().optional().describe("How many neighbours to return (1-100, default 10)."),
    },
  },
  async (args) => {
    const hits = await store.recall(args.query, args.k);
    return jsonResult({ count: hits.length, hits });
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`donguri-journal MCP server running on stdio (db: ${dbPath})`);
}

main().catch((err: unknown) => {
  console.error("Fatal error starting donguri-journal:", err);
  process.exit(1);
});
