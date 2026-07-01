# 🐿️ donguri-journal

**English** | [日本語](README.ja.md)

[![npm](https://img.shields.io/npm/v/donguri-journal)](https://www.npmjs.com/package/donguri-journal)

> A local-first, time-aware journaling **memory** server for AI agents, over MCP.

A squirrel buries far more acorns (*donguri*) than it ever digs back up — it hoards
without hesitation. donguri-journal takes the same stance: a multimodal LLM (Claude,
etc.) is the companion and UI, and this server is the persistent memory organ behind
it. Its core job is to **capture** everything casually in the flow of conversation and
never lose it, then let you **recall** it across time. Digging the pile back up
*well* — richer review, resurfacing, new lenses on the hoard — is the harder,
open-ended part, and that's what **plugins** extend.

> Design rationale and the full roadmap live in **[docs/DESIGN.md](docs/DESIGN.md)**.

---

## What it is

- **Local-first.** Everything lives in a single SQLite file plus a local originals
  directory on your machine. No cloud, no account.
- **Time-aware.** Every entry has both `created_at` (when captured) and `occurred_at`
  (when the event actually happened) — built for human reflection: "what was I
  thinking 3 months ago?", weekly/monthly review, BuJo-style migration.
- **Multimodal by delegation.** The server never runs vision/audio models. Your
  multimodal LLM extracts faithful text from images/audio/URLs and passes it in; the
  original bytes are stored verbatim, never destroyed.
- **Zero-setup embeddings.** Semantic search works out of the box via in-process
  [transformers.js](https://github.com/xenova/transformers.js)
  (`Xenova/all-MiniLM-L6-v2`, 384-dim). No Ollama, no manual model pull. The backend
  is swappable for power users.

> **Status:** Phase 1 (capture / recall) + Phase 1.5 (review / insight), local
> originals storage, entry management, plugin loading, and a **read-only management
> console** are implemented. UI-driven delete / export, an album view, a curated
> plugin registry, and local-first sync are planned — see
> [docs/DESIGN.md](docs/DESIGN.md).

## Requirements

- **Node.js 22+**
- A **multimodal LLM client that speaks MCP** (e.g. Claude Desktop). This is a hard
  requirement — the server has no UI of its own and does not process media itself.

## Setup

### Install (recommended)

Install once, globally, then point your MCP client at the installed command. This is the
most reliable path — because the install happens **once** (not on every launch), the
server starts instantly on every client (Claude Desktop, Claude Code, Codex, Cursor, …):

```bash
npm install -g donguri-journal
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "donguri-journal": {
      "command": "donguri-journal"
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add donguri-journal -- donguri-journal
```

Restart your MCP client. On first use the embedding model is downloaded and cached once
(needs network); everything else runs locally.

### Quick try (npx, zero-install)

To try it without installing anything, `npx` fetches and runs it on demand:

```json
{
  "mcpServers": {
    "donguri-journal": {
      "command": "npx",
      "args": ["-y", "donguri-journal"]
    }
  }
}
```

Caveat: the **first** launch downloads the whole dependency tree and can be slow. On
**Windows + Claude Desktop** it may exceed the client's startup window and show *"Server
disconnected"* — use the global install above there. `npx` is smooth on macOS/Linux and
for CLI agents (Claude Code, Codex).

### Install with an AI agent

Prefer to let an agent do it? Point it at the full **[setup runbook](docs/SETUP.md)** — it
opens with a "For AI agents" section (the ground rules: configure only your client, don't
touch other apps' configs) and then walks through prerequisite checks, install, per-client
config, and troubleshooting. Paste this to any agent that can run a shell (e.g. **Codex**,
**Claude Code**, **Cursor**):

```text
Set up the donguri-journal MCP server by following this guide, including its
"For AI agents" notes at the top:
https://github.com/nemutame/donguri-journal/blob/main/docs/SETUP.md
```

If your agent can't browse the web, open **[docs/SETUP.md](docs/SETUP.md)** and paste its
contents into the chat instead.

### From source (development)

For contributing or running an unreleased build, build from a checkout and point your
client at the built entry:

```bash
npm ci
npm run build
```

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

If your MCP client does not inherit your shell `PATH` (common with nvm), use an absolute
path to `node`, e.g. `/home/you/.nvm/versions/node/v22.x.y/bin/node`.

### Optional: PNG charts

`generate_review` and `surface_patterns` can attach a PNG chart, rendered with
[`sharp`](https://www.npmjs.com/package/sharp). sharp is an **optional** dependency — it
is not installed by default (its large native binaries would make the base install heavier
and less reliable). Without it, those tools return their structured data and hints as
usual, just no image. To enable charts, install sharp in the same scope as the server —
e.g. `npm install -g sharp` for a global install, or `npm install sharp` from a source
checkout.

### Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `JOURNAL_DB_PATH` | `~/.journal-mcp/journal.db` | Path to the SQLite database file. |
| `JOURNAL_ORIGINALS_DIR` | `~/.journal-mcp/originals` | Directory where original artifacts (images/audio/files) are stored, content-addressed. |
| `JOURNAL_MAX_ORIGINAL_BYTES` | `26214400` (25 MiB) | Max accepted size of a single original artifact; larger `original_data` is rejected. |
| `JOURNAL_PLUGINS_DIR` | `~/.journal-mcp/plugins` | Directory where installed plugins live (one subdirectory per plugin). |
| `JOURNAL_PLUGINS_CONFIG` | `~/.journal-mcp/plugins.json` | JSON file recording which plugins are installed / enabled. |

`stdout` is reserved for the MCP protocol; all logs go to `stderr`.

## Tools

The tool descriptions are written as instructions for the front-end LLM (when to call
each).

| Tool | Purpose |
| --- | --- |
| `capture` | Stash a memory now. Low-friction; for media, the LLM passes extracted text plus the raw original bytes (`original_data`), which the server stores verbatim. Auto-deduplicated. |
| `query_entries` | **Structured** lookup by date range / tag / source kind. For precise, filterable questions and reviews. |
| `recall_related` | **Semantic** vector search — find past entries related in meaning, even with different wording. |
| `generate_review` | Reflective review of a day / week / month (or custom range). Returns a **PNG activity chart** + structured aggregates (totals, busiest day, source kinds, top tags) + presentation hints. |
| `surface_patterns` | Recurring themes — recent entries that **echo earlier ones**. Returns echo clusters with distances + a PNG chart + presentation hints. |
| `get_original` | Fetch a stored original artifact by its `original_ref`. Images are returned inline so the LLM can re-view / re-extract; other types return metadata only. |
| `reindex` | Maintenance — rebuild the vector index from the originals using the current embedding backend. Run after switching the embedding backend (the server warns on startup when the index no longer matches). Originals are never touched. |
| `storage_stats` | Capacity: entry counts (active vs soft-deleted), vectors, breakdown by source kind / month, originals count + bytes, and DB size. |
| `delete_entry` | Delete an entry — `mode: soft` (recoverable tombstone) or `hard` (permanent purge of entry + vector + orphaned original, with VACUUM). |
| `open_management_ui` | Start a **localhost-only** web console for the owner to browse, filter, semantically recall, and see storage stats directly — outside the LLM conversation. Returns a token-bearing URL to open in a browser. |
| `list_installed_plugins` | List installed plugins with their enabled state, version, and declared capabilities. |
| `install_plugin` | Install a local plugin. Two-step: propose (see manifest + capabilities), then `confirm: true`. Loads immediately — no restart. |
| `uninstall_plugin` | Remove an installed plugin from disk and the registry. Tools it already registered stay available until the server restarts. |

`query_entries` and `recall_related` are intentionally separate retrieval paths; the
LLM picks based on the question (precise filter vs. meaning). `generate_review` and
`surface_patterns` return rendered PNG charts alongside structured data and
presentation hints, so the LLM can present a rich, reflective summary rather than a
bare list.

## How it stores things

Two layers, so the index is always rebuildable and originals are never lost:

- **`entries`** — the indexed text (`body`), a pointer to the verbatim original
  (`original_ref`), timestamps, tags, and metadata. `extraction_state` records how
  `body` was produced, so lossy extraction can be redone later.
- **`vec_entries`** — a disposable [sqlite-vec](https://github.com/asg017/sqlite-vec)
  vector index. The active embedding model/dim is recorded so switching backends can
  trigger a reindex.
- **originals** — when the LLM sends an artifact's bytes, they're saved verbatim in a
  local content-addressed store (`OriginalStore`, default: a local directory), and
  `original_ref` points at them. The backend is pluggable; the server never interprets
  the bytes. Embeddings are always made from the extracted text, never the media
  itself.

## Contributing

Contributions are welcome — **issues and PRs in Japanese are fine too**. See
[docs/DESIGN.md](docs/DESIGN.md) for the design intent before proposing larger changes.

```bash
npm run lint        # Biome (lint + format check)
npm run lint:fix    # auto-fix
npm run typecheck   # tsc (src + tests)
npm test            # node:test via tsx
npm run build       # tsc -> dist/
```

Workflow:

- Node 22 is pinned via `.nvmrc` (`nvm use`).
- `main` is protected — work on a branch and open a pull request.
- Every PR is gated by **CI** (lint + typecheck + build + tests) and a **CodeRabbit** review;
  both must pass before merge.

## License

[MIT](./LICENSE) © Nemutame
