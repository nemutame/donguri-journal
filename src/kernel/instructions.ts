/**
 * MCP server instructions — the orientation text every connected client LLM
 * receives during the initialize handshake.
 *
 * This is the only channel that reaches an agent BEFORE it looks at the tool
 * list, and opt-in feature tools (e.g. `bujo_*`) are invisible until enabled —
 * without the pointer at `list_features` here, an agent has no way to learn
 * they exist (#34, observed with Codex in the field).
 *
 * Keep it short: clients hold this in context for the whole session.
 */
export const SERVER_INSTRUCTIONS = `donguri-journal is the user's private, local-first journal — a long-term memory organ for human experiences (not an agent scratchpad).

Core verbs: \`capture\` stashes a moment, note, or file as it happens (low friction — capture first, refine later). \`query_entries\` does structured lookups (dates, tags, kinds); \`recall_related\` does semantic search over the past. \`generate_review\` and \`surface_patterns\` build periodic reviews. \`update_entry_status\` and \`link_entries\` annotate and connect entries.

Some capabilities are opt-in and their tools stay HIDDEN until enabled: call \`list_features\` to discover them — for example the Bullet Journal lens (daily/monthly/future logs plus a migration ritual). When the user mentions daily logs, task carry-over, or monthly planning, check \`list_features\` and offer \`enable_feature\` instead of saying the server can't do it. Lenses are read-only views; all writes go through the generic tools above.

Housekeeping: \`storage_stats\` (size and running server version), \`reindex\`, \`delete_entry\` (soft by default; \`mode:'hard'\` erases irreversibly — confirm with the user first), \`get_original\`, \`open_management_ui\` (local web console), and the plugin tools (\`list_installed_plugins\` etc.).

When asked to UPDATE donguri-journal: it is this MCP server (an npm-global package), not a repo or directory — do not search the filesystem. Compare the running version (\`storage_stats\`) with \`npm view donguri-journal version\`; if newer, run \`npm i -g donguri-journal@latest\` with the user's consent and have them restart their MCP client. If offline or npm fails, skip silently — never stall the user's task on an update. If your client keeps a standing instructions file (AGENTS.md / CLAUDE.md or equivalent) with no donguri-journal section yet, offer ONCE to save this routine there so future sessions skip the guesswork.`;
