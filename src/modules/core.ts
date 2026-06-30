/**
 * Core module — registers the built-in tools (capture / query / recall / review
 * / patterns / reindex / originals / management). It is just another
 * `JournalModule`; opt-in modules register the same way.
 */
import { statSync } from "node:fs";
import { z } from "zod";
import type { JournalContext } from "../kernel/context.js";
import type { JournalModule } from "../kernel/module.js";
import { surfacePatterns } from "../review/patterns.js";
import { generateReview } from "../review/review.js";

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

export const coreModule: JournalModule = {
  id: "core",
  register(ctx: JournalContext): void {
    const { server, store, originals, config } = ctx;

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
        if (!original_data || original_data.length === 0) {
          // Text-only capture (or an external original_ref passed through as-is).
          return jsonResult(await store.insert(entry));
        }
        // Coarse guard avoids decoding an absurd payload; the exact size check is
        // on the decoded length, so a valid base64 right at the limit is not
        // over-rejected.
        const tooLarge = errorResult(
          `original_data exceeds the maximum allowed size (${config.maxOriginalBytes} bytes)`,
        );
        if (original_data.length > config.maxOriginalBytes * 2) {
          return tooLarge;
        }
        const bytes = decodeBase64Strict(original_data);
        if (!bytes) {
          return errorResult("original_data is not valid base64");
        }
        if (bytes.length > config.maxOriginalBytes) {
          return tooLarge;
        }
        // Insert the entry FIRST, then save + attach the original, so a dedupe
        // (or an insert failure) can never leave a saved-but-unreferenced original.
        entry.original_ref = undefined;
        const result = await store.insert(entry);
        const existingRef = result.deduped ? store.getOriginalRef(result.id) : null;
        if (existingRef) {
          return jsonResult({ ...result, original_ref: existingRef });
        }
        const saved = await originals.save({
          data: bytes,
          mime: original_mime,
          filename: original_filename,
        });
        const attached = store.attachOriginalIfAbsent(result.id, saved.ref);
        if (attached) {
          return jsonResult({ ...result, original_ref: saved.ref });
        }
        // Not attached: either the row already had an original (return that), or
        // the row vanished between insert and save — report honestly rather than
        // claim a ref we didn't store. The unreferenced content-addressed blob is
        // left for a future orphan sweep (never wrongly deleted, as it may be shared).
        const existing = store.getOriginalRef(result.id);
        if (existing) {
          return jsonResult({ ...result, original_ref: existing });
        }
        return errorResult("The entry was removed before its original could be attached.");
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
          k: z
            .number()
            .int()
            .optional()
            .describe("How many neighbours to return (1-100, default 10)."),
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
          "other types return metadata only. Use this after recall_related / query_entries " +
          "surfaces an entry whose original you want to actually see again.",
        inputSchema: {
          original_ref: z
            .string()
            .min(1)
            .describe("The entry's original_ref, e.g. 'local:<sha256>'."),
        },
      },
      async ({ original_ref }) => {
        const loaded = await originals.get(original_ref);
        if (!loaded) {
          return jsonResult({ found: false, original_ref });
        }
        // Never return the absolute filesystem path (it leaks home dir /
        // username). Images come back inline; other types return metadata only
        // (opening non-renderable originals is the management UI's job).
        const base = { found: true, original_ref, mime: loaded.mime, bytes: loaded.data.length };
        const content: Array<
          { type: "image"; data: string; mimeType: string } | { type: "text"; text: string }
        > = [];
        if (loaded.mime?.startsWith("image/")) {
          content.push({
            type: "image",
            data: loaded.data.toString("base64"),
            mimeType: loaded.mime,
          });
        }
        content.push({ type: "text", text: JSON.stringify(base, null, 2) });
        return { content };
      },
    );

    server.registerTool(
      "delete_entry",
      {
        title: "Delete an entry",
        description:
          "Delete a journal entry by id. `mode: 'soft'` (default) sets a recoverable tombstone — the " +
          "entry stops appearing in query/recall but can be restored. `mode: 'hard'` permanently " +
          "purges the entry, its vector, and its original (when no other entry references it) and " +
          "VACUUMs the database — use this to truly erase something captured by mistake (e.g. a " +
          "secret). Hard delete is irreversible; confirm with the user before using it.",
        inputSchema: {
          id: z.number().int().describe("The entry id to delete."),
          mode: z
            .enum(["soft", "hard"])
            .optional()
            .describe("'soft' (default, recoverable) or 'hard' (permanent erase)."),
        },
      },
      async (args) => {
        const mode = args.mode ?? "soft";
        if (mode === "soft") {
          return jsonResult({ id: args.id, mode, deleted: store.softDelete(args.id) });
        }
        // Hard delete: erase the orphaned original FIRST so a failure can't leave its
        // bytes behind, then purge the row + vector and VACUUM.
        const peek = store.peekHardDelete(args.id);
        if (!peek.exists) {
          return jsonResult({ id: args.id, mode, deleted: false });
        }
        let originalErased: boolean | null = null;
        if (peek.orphan && peek.original_ref) {
          try {
            originalErased = await originals.delete(peek.original_ref);
          } catch (err) {
            // Log details to stderr; keep the tool output generic (no raw exception).
            ctx.log("failed to erase original during hard delete:", err);
            return errorResult(
              "Failed to erase the original; the entry was left intact so you can retry.",
            );
          }
        }
        // The original is already gone; if purge fails, the entry stays and the
        // operation is safely retryable (a re-run re-purges; deleting an
        // already-missing original is a no-op).
        let deleted: boolean;
        try {
          deleted = store.purgeEntry(args.id);
        } catch (err) {
          ctx.log("failed to purge entry after erasing original:", err);
          return errorResult(
            "Erased the original but failed to purge the entry; run delete again to finish.",
          );
        }
        return jsonResult({ id: args.id, mode, deleted, original_erased: originalErased });
      },
    );

    server.registerTool(
      "storage_stats",
      {
        title: "Storage statistics",
        description:
          "Report how big the journal is: entry counts (active vs soft-deleted), vector count, " +
          "breakdown by source kind and by month, the originals count + total bytes, and the database " +
          "file size. Use this for capacity questions like 'how much have I stored?'.",
        inputSchema: {},
      },
      async () => {
        const entries = store.entryStats();
        const originalsStats = await originals.stats();
        // null (not 0) distinguishes a stat error from a genuinely empty DB; the
        // absolute path is withheld to avoid leaking local filesystem details.
        let dbBytes: number | null = null;
        try {
          dbBytes = statSync(config.dbPath).size;
        } catch {
          dbBytes = null;
        }
        return jsonResult({ entries, originals: originalsStats, db_bytes: dbBytes });
      },
    );
  },
};
