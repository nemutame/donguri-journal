# 🐿️ donguri-journal

> A local-first, time-aware journaling **memory** server for AI agents, over MCP.
> ローカルファースト・時間軸対応の「記憶」MCP サーバー。

A squirrel stashes acorns (*donguri*) and digs them up later. donguri-journal does
the same for your thoughts: a multimodal LLM (Claude, etc.) is the companion and UI,
and this server is the persistent memory organ behind it — **capture** things casually
in the flow of conversation, **recall** them across time.

---

## What it is / これは何か

- **Local-first.** Everything lives in a single SQLite file on your machine. No cloud, no account.
- **Time-aware.** Every entry has both `created_at` (when captured) and `occurred_at` (when the
  event actually happened) — built for human reflection: "what was I thinking 3 months ago?",
  weekly/monthly review, BuJo-style migration.
- **Multimodal by delegation.** The server never runs vision/audio models. Your multimodal LLM
  extracts faithful text from images/audio/URLs and passes it in; the original is referenced, not destroyed.
- **Zero-setup embeddings.** Semantic search works out of the box via in-process
  [transformers.js](https://github.com/xenova/transformers.js) (`Xenova/all-MiniLM-L6-v2`, 384-dim).
  No Ollama, no manual model pull. The backend is swappable for power users.

> **Status:** Phase 1 (core capture / recall) + Phase 1.5 (review / insight tools). Local-first sync (CRDT + E2E encryption) is a later, independent phase.

## Requirements / 必要環境

- **Node.js 22+**
- A **multimodal LLM client that speaks MCP** (e.g. Claude Desktop). This is a hard requirement —
  the server has no UI of its own and does not process media itself.

## Setup / セットアップ

Until this is published to npm, run it from a local build:

```bash
npm install
npm run build
```

Then register it with your MCP client. Example (Claude Desktop, `claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "donguri-journal": {
      "command": "node",
      "args": ["/absolute/path/to/donguri-journal/dist/index.js"]
    }
  }
}
```

On first use the embedding model (~90 MB) is downloaded and cached automatically (needs network once).

### Configuration / 設定

| Env var | Default | Meaning |
| --- | --- | --- |
| `JOURNAL_DB_PATH` | `~/.journal-mcp/journal.db` | Path to the SQLite database file. |

`stdout` is reserved for the MCP protocol; all logs go to `stderr`.

## Tools / ツール

The tool descriptions are written as instructions for the front-end LLM (when to call each).

| Tool | Purpose |
| --- | --- |
| `capture` | Stash a memory now. Low-friction; for media, the LLM passes extracted text + a pointer to the original. Auto-deduplicated. |
| `query_entries` | **Structured** lookup by date range / tag / source kind. For precise, filterable questions and reviews. |
| `recall_related` | **Semantic** vector search — find past entries related in meaning, even with different wording. |
| `generate_review` | Reflective review of a day / week / month (or custom range). Returns a **PNG activity chart** + structured aggregates (totals, busiest day, source kinds, top tags) + presentation hints. |
| `surface_patterns` | Recurring themes — recent entries that **echo earlier ones**. Returns echo clusters with distances + a PNG chart + presentation hints. |
| `reindex` | Maintenance — rebuild the vector index from the originals using the current embedding backend. Run after switching the embedding backend — a different model **or** a different implementation (the server warns on startup when the index no longer matches). Originals are never touched. |

`query_entries` and `recall_related` are intentionally separate retrieval paths; the LLM picks
based on the question (precise filter vs. meaning). `generate_review` and `surface_patterns`
return rendered PNG charts alongside structured data and presentation hints, so the LLM can
present a rich, reflective summary rather than a bare list.

## How it stores things / 保存のしくみ

Two layers, so the index is always rebuildable and originals are never lost:

- **`entries`** — the indexed text (`body`), a pointer to the verbatim original (`original_ref`),
  timestamps, tags, and metadata. `extraction_state` records how `body` was produced, so lossy
  extraction can be redone later.
- **`vec_entries`** — a disposable [sqlite-vec](https://github.com/asg017/sqlite-vec) vector index.
  The active embedding model/dim is recorded so switching backends can trigger a reindex.

## Development / 開発

```bash
npm run lint        # Biome (lint + format check)
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/
```

Contributions go through a PR; CI (lint + typecheck + build) and CodeRabbit review gate `main`.

## License

[MIT](./LICENSE) © Nemutame
