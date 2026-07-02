# donguri-journal — Setup guide

**English** | [日本語](SETUP.ja.md)

A step-by-step runbook to install donguri-journal and register it with your MCP client.
It works for any MCP client (Claude Desktop, Claude Code, Codex, Cursor, …).

> **For AI agents:** work through this checklist top to bottom and run each check
> yourself. Configure **only the MCP client the user is currently using** — do **not**
> read or modify any other application's config files. If you can't tell which client to
> configure, ask. Always preserve MCP servers that are already configured.

## 1. Prerequisites — check these first

- **Node.js ≥ 22** — check with `node -v`.
  - Missing or older? Install via [nvm](https://github.com/nvm-sh/nvm) (macOS/Linux) or
    [nvm-windows](https://github.com/coreybutler/nvm-windows) (Windows), then
    `nvm install 22 && nvm use 22`.
  - **Node 24 is fine** — prebuilt native binaries are available from donguri-journal
    **0.1.2+**.
- **npm** — bundled with Node; check with `npm -v`.
- **An MCP client** — Claude Desktop, Claude Code, Codex, Cursor, or anything that speaks
  MCP over stdio.

No C/C++ compiler is required: the one native dependency (`better-sqlite3`) installs a
**prebuilt** binary for Node 22–24.

## 2. Install (recommended: global)

```bash
npm install -g donguri-journal
```

Installing once means your client launches the installed command with **no per-start
download** — the most reliable option on every OS. Verify it landed with
`npm ls -g donguri-journal`.

> Don't run `donguri-journal` directly to "test" it — it's a stdio server and will just
> sit waiting for input. It's meant to be launched by your MCP client.

**Zero-install alternative:** skip this step and use `npx -y donguri-journal` as the
command in step 3. Caveat: the first launch downloads the whole dependency tree and can be
slow; on **Windows + Claude Desktop** it may exceed the startup window and show *"Server
disconnected"* — prefer the global install there.

## 3. Register with your MCP client

Add a local (stdio) server named `donguri-journal`, command `donguri-journal` (no
arguments). **Only edit the client you actually use**, and keep existing servers intact.

**Claude Desktop** — `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "donguri-journal": { "command": "donguri-journal" }
  }
}
```

**Claude Code:**

```bash
claude mcp add donguri-journal -- donguri-journal
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.donguri-journal]
command = "donguri-journal"
```

**Cursor** — its MCP config (`~/.cursor/mcp.json` or a project `.cursor/mcp.json`), same
`command`.

If your client doesn't inherit your shell `PATH` (common with nvm), use the **absolute
path** to the bin — find it with `which donguri-journal` (macOS/Linux) or
`where donguri-journal` (Windows).

## 4. Restart the client

Fully quit and reopen. For Claude Desktop, **quit from the system tray** — just closing
the window is not enough. MCP servers are loaded at startup.

## 5. Verify

Ask the assistant to capture a note, then recall it:

- *"Remember this: &lt;something&gt;."* → should call **capture**.
- *"What did I note about &lt;something&gt;?"* → should call **recall_related**.

The first capture/recall downloads the embedding model once (needs network); everything
after runs locally.

## 6. Keep it updated (for agents)

A global install does not update itself. If you are an agent with shell access, adopt this
routine — and offer to copy it into the user's own instructions file (`AGENTS.md`,
`CLAUDE.md`, or equivalent) so every future session follows it:

> In a session where donguri-journal is used: after its first successful tool call, ONCE
> per session, compare the running version (`version` in the `storage_stats` result) with
> the published one (`npm view donguri-journal version`). If a newer version exists, tell
> the user briefly — "donguri-journal vX.Y.Z is available" — without interrupting the
> task. Update ONLY when the user approves: `npm i -g donguri-journal@latest`, then ask
> them to restart the MCP client. If offline or npm fails, skip silently; the next session
> will try again.

Three rules matter: check **once per session** (not on every call), **never update without
consent** (a global install changes system state), and **fail silently offline**.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| *"Server disconnected"* right after start | `npx` first launch too slow/flaky (esp. Windows) | Use the **global install** (step 2) — no per-launch download |
| Native build error: *"no prebuilt for Node vXX"* / asks for Visual Studio / a C++ toolset | Old donguri-journal on a newer Node | Upgrade to **≥ 0.1.2**: `npm i -g donguri-journal@latest` (or use Node 22 LTS) |
| *"command not found: donguri-journal"* | client doesn't see your `PATH` | Use the absolute bin path (`which` / `where donguri-journal`) |
| Tools don't appear | client wasn't fully restarted | Quit completely and reopen |
| No PNG chart in reviews | optional `sharp` not installed | `npm i -g sharp` to enable charts; otherwise reviews return data only |

**Server logs** (when a server fails to start):

- Claude Desktop — Windows: `%APPDATA%\Claude\logs\mcp-server-donguri-journal.log`;
  macOS: `~/Library/Logs/Claude/mcp-server-donguri-journal.log`
- Claude Code — `claude mcp list`, and the client's MCP logs

Still stuck? Open an issue: <https://github.com/nemutame/donguri-journal/issues>.
