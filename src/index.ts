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
import { createOriginalStore } from "./originals/store.js";
import { surfacePatterns } from "./review/patterns.js";
import { generateReview } from "./review/review.js";

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

const originalStore = createOriginalStore();

/** Max accepted size of a single original artifact (decoded bytes). */
const MAX_ORIGINAL_BYTES = (() => {
  const v = Number(process.env.JOURNAL_MAX_ORIGINAL_BYTES);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 25 * 1024 * 1024;
})();

const server = new McpServer({ name: "donguri-journal", version: "0.1.0" });

function jsonResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

/** Decode strict, canonical base64; returns null for malformed input. */
function decodeBase64Strict(input: string): Buffer | null {
  const cleaned = input.replace(/\s+/g, "");
  if (cleaned.length === 0 || cleaned.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
    return null;
  }
  const buf = Buffer.from(cleaned, "base64");
  return buf.toString("base64") === cleaned ? buf : null;
}

/** Result with an optional PNG chart followed by the structured JSON payload. */
function richResult(png: Buffer | null, payload: unknown) {
  const content: Array<
    { type: "image"; data: string; mimeType: string } | { type: "text"; text: string }
  > = [];
  if (png) {
    content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
  }
  content.push({ type: "text", text: JSON.stringify(payload, null, 2) });
  return { content };
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
      "the original (file path / URL) in `original_ref`. When the user shares an actual file " +
      "(an attached image, an audio clip), ALSO send the raw bytes as base64 in `original_data` " +
      "(with `original_mime` / `original_filename`): the server stores the verbatim original " +
      "locally and sets `original_ref` for you, so it can be re-viewed later via get_original. " +
      "Set `occurred_at` when the event happened at a different time than now (e.g. 'yesterday', " +
      "'last week'); otherwise it defaults to the capture time. Identical captures are " +
      "de-duplicated automatically.",
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
        .describe(
          "Pointer to an externally-held original (file path or URL). Omit when sending " +
            "`original_data` — the server fills this in with the stored reference.",
        ),
      original_data: z
        .string()
        .optional()
        .describe(
          "Base64-encoded raw bytes of the original artifact (image/audio/file). When present, " +
            "the server saves it verbatim and overwrites `original_ref` with the stored ref.",
        ),
      original_mime: z
        .string()
        .optional()
        .describe("MIME type of `original_data`, e.g. 'image/png', 'audio/mpeg'."),
      original_filename: z
        .string()
        .optional()
        .describe("Optional original filename; used to pick the stored file extension."),
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
    const { original_data, original_mime, original_filename, ...entry } = args;
    if (original_data && original_data.length > 0) {
      // Reject oversized payloads before allocating the decoded buffer.
      if (Math.ceil((original_data.length * 3) / 4) > MAX_ORIGINAL_BYTES) {
        return errorResult(
          `original_data exceeds the maximum allowed size (${MAX_ORIGINAL_BYTES} bytes)`,
        );
      }
      const bytes = decodeBase64Strict(original_data);
      if (!bytes) {
        return errorResult("original_data is not valid base64");
      }
      const saved = await originalStore.save({
        data: bytes,
        mime: original_mime,
        filename: original_filename,
      });
      entry.original_ref = saved.ref;
    }
    const result = await store.insert(entry);
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

server.registerTool(
  "generate_review",
  {
    title: "Generate a time-window review",
    description:
      "Produce a reflective review of a period — call this when the user wants to look back " +
      "('how was my week?', 'review this month', daily/weekly/monthly check-ins, BuJo-style " +
      "migration). Returns structured aggregates (totals, busiest day, source kinds, top tags), " +
      "presentation hints, and — when there are entries to plot — an attached PNG chart of " +
      "activity over time (otherwise structured data only). Show the chart if present and weave " +
      "the aggregates into a short reflective summary — do not just dump the numbers. Pick " +
      "`period` (day/week/month), or pass BOTH `since` and `until` for an explicit custom range " +
      "(one without the other is an error). `time_field` selects when-captured vs when-it-happened.",
    inputSchema: {
      period: z
        .enum(["day", "week", "month"])
        .optional()
        .describe(
          "Calendar window containing `anchor`. Defaults to 'week'. Ignored if since+until given.",
        ),
      anchor: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe("ISO-8601 point in time the period is computed around. Defaults to now."),
      since: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe("ISO-8601 lower bound for an explicit custom window (use with `until`)."),
      until: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe("ISO-8601 upper bound for an explicit custom window (use with `since`)."),
      time_field: z
        .enum(["created_at", "occurred_at"])
        .optional()
        .describe("Which timestamp to window by. Defaults to 'created_at'."),
    },
  },
  async (args) => {
    const out = await generateReview(store, args);
    return richResult(out.chartPng, {
      structured: out.structured,
      presentation_hints: out.presentation_hints,
    });
  },
);

server.registerTool(
  "surface_patterns",
  {
    title: "Surface recurring themes (echoes)",
    description:
      "Detect recurring themes — recent entries that echo something the user wrote BEFORE. Call " +
      "this when the user reflects on habits or patterns ('do I keep coming back to this?', " +
      "'am I in a rut?') or proactively during reviews. For each recent entry it finds " +
      "semantically similar older entries; returns the echo clusters (with distances), " +
      "presentation hints, and — when any echoes are found — an attached PNG chart of the " +
      "strongest echoes (otherwise structured data only). Each echo is a CANDIDATE recurrence — " +
      "judge relevance yourself and present gently, don't over-claim.",
    inputSchema: {
      lookback_days: z
        .number()
        .int()
        .optional()
        .describe("How far back to treat entries as 'recent' (1-3650, default 30)."),
      max_recent: z
        .number()
        .int()
        .optional()
        .describe("Max recent entries to examine (1-200, default 50)."),
      per_entry: z
        .number()
        .int()
        .optional()
        .describe("Neighbours considered per recent entry (1-20, default 5)."),
      max_distance: z
        .number()
        .optional()
        .describe(
          "Distance cutoff; only closer echoes are kept (default 1.3, smaller = stricter).",
        ),
    },
  },
  async (args) => {
    const out = await surfacePatterns(store, args);
    return richResult(out.chartPng, {
      structured: out.structured,
      presentation_hints: out.presentation_hints,
    });
  },
);

server.registerTool(
  "reindex",
  {
    title: "Rebuild the semantic search index",
    description:
      "Maintenance operation: rebuild the vector index from the original entries using the " +
      "current embedding backend. Use this after switching the embedding model — the server " +
      "logs a warning on startup when the active model no longer matches what the index was " +
      "built with, because vectors from different models are not comparable. Originals are " +
      "never touched; only the disposable index is rebuilt, then re-recall works again. May " +
      "take a while for large journals. Not part of normal capture/recall — only run it when " +
      "the user asks to reindex or after a backend change.",
    inputSchema: {},
  },
  async () => {
    const result = await store.reindex();
    return jsonResult(result);
  },
);

server.registerTool(
  "get_original",
  {
    title: "Fetch a stored original artifact (re-view the acorn)",
    description:
      "Retrieve the verbatim original (image / audio / file) that was saved at capture time, by " +
      "its `original_ref` (e.g. 'local:<sha256>' from an entry). Images are returned inline " +
      "so you (the multimodal LLM) can look again and, if needed, RE-EXTRACT text from them; " +
      "other types return the local file path and metadata. Use this after recall_related / " +
      "query_entries surfaces an entry whose original you want to actually see again.",
    inputSchema: {
      original_ref: z.string().min(1).describe("The entry's original_ref, e.g. 'local:<sha256>'."),
    },
  },
  async ({ original_ref }) => {
    const loaded = await originalStore.get(original_ref);
    if (!loaded) {
      return jsonResult({ found: false, original_ref });
    }
    const base = { found: true, original_ref, mime: loaded.mime, bytes: loaded.data.length };
    const content: Array<
      { type: "image"; data: string; mimeType: string } | { type: "text"; text: string }
    > = [];
    if (loaded.mime?.startsWith("image/")) {
      // Image bytes are returned inline; the local path is withheld to avoid
      // leaking filesystem details (home dir / username).
      content.push({ type: "image", data: loaded.data.toString("base64"), mimeType: loaded.mime });
      content.push({ type: "text", text: JSON.stringify(base, null, 2) });
    } else {
      // Non-renderable types: return the local path so the artifact can be opened.
      content.push({ type: "text", text: JSON.stringify({ ...base, path: loaded.path }, null, 2) });
    }
    return { content };
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
