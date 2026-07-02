# donguri-journal — セットアップガイド

[English](SETUP.md) | **日本語**

donguri-journal をインストールし、MCP クライアントに登録するための手順書です。
どの MCP クライアントでも使えます（Claude Desktop / Claude Code / Codex / Cursor …）。

> **AI エージェント向け:** このチェックリストを上から順に、各チェックを自分で実行しながら
> 進めてください。設定するのは **今ユーザーが使っている MCP クライアントだけ**にして、
> **他のアプリの設定ファイルは読んだり変更したりしない**でください。どのクライアントを
> 設定すべきか分からなければ、勝手に別アプリを触らず確認してください。既存の MCP サーバー
> 設定は必ず保持してください。

## 1. 前提条件 — まず確認

- **Node.js 22 以上** — `node -v` で確認。
  - 無い/古い場合は [nvm](https://github.com/nvm-sh/nvm)（macOS/Linux）または
    [nvm-windows](https://github.com/coreybutler/nvm-windows)（Windows）で導入し、
    `nvm install 22 && nvm use 22`。
  - **Node 24 でも OK** — donguri-journal **0.1.2 以降**はプリビルドのネイティブ
    バイナリを同梱しています。
- **npm** — Node に同梱。`npm -v` で確認。
- **MCP クライアント** — Claude Desktop / Claude Code / Codex / Cursor など、stdio で
  MCP を話すもの。

**C/C++ コンパイラは不要**です。唯一のネイティブ依存（`better-sqlite3`）は Node 22〜24 用の
**プリビルド**バイナリを取得します。

## 2. インストール（推奨: グローバル）

```bash
npm install -g donguri-journal
```

一度だけ入れておけば、クライアントは**起動時にダウンロードせず**インストール済みの
コマンドを起動します（どの OS でも最も確実です）。`npm ls -g donguri-journal` で確認できます。

> `donguri-journal` を直接実行して「動作確認」するのは避けてください——これは stdio
> サーバーなので、入力待ちで止まってしまうだけです。MCP クライアントから起動されるものです。

**インストール不要の代替:** この手順を飛ばし、手順3の command を `npx -y donguri-journal`
にします。注意: 初回起動は依存ツリー全体をダウンロードするため重く、**Windows + Claude
Desktop** では起動待ちを超えて *「Server disconnected」* になることがあります。その環境では
グローバルインストールを推奨します。

## 3. MCP クライアントに登録

ローカル（stdio）サーバー `donguri-journal`、command `donguri-journal`（引数なし）を
追加します。**実際に使うクライアントだけ**を編集し、既存の設定は保持してください。

**Claude Desktop** — `claude_desktop_config.json`
（macOS: `~/Library/Application Support/Claude/`、Windows: `%APPDATA%\Claude\`）:

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

**Cursor** — その MCP 設定（`~/.cursor/mcp.json` またはプロジェクトの `.cursor/mcp.json`）に
同じ `command` を設定してください。

クライアントがシェルの `PATH` を引き継がない場合（nvm で頻発）は、bin の**絶対パス**を
指定してください（`which donguri-journal` / `where donguri-journal` で確認）。

## 4. クライアントを再起動

完全に終了して開き直します。Claude Desktop は**タスクトレイから Quit** してください
（ウィンドウを閉じるだけでは不十分です）。MCP サーバーは起動時に読み込まれます。

## 5. 動作確認

短いメモを capture して、あとで recall してみてください:

- 「これ覚えておいて: 〇〇」→ **capture** が呼ばれる
- 「〇〇について何かメモした？」→ **recall_related** が呼ばれる

初回の capture/recall で埋め込みモデルが一度だけダウンロードされます（ネットワーク必要）。
以降はすべてローカルで動作します。

## 6. 最新に保つ（エージェント向け）

グローバルインストールは自動では更新されません。シェルを使えるエージェントは、次のルーチンを
採用してください——そして、ユーザー自身の指示ファイル（`AGENTS.md` / `CLAUDE.md` 等）への
コピーを提案してください（以降のすべてのセッションで実行されるように）:

> donguri-journal を使うセッションでは、最初のツール呼び出しが成功した後に**セッション中
> 一度だけ**、動作中のバージョン（`storage_stats` の `version`）と公開されている最新
> （`npm view donguri-journal version`）を比較します。新しい版があれば「donguri-journal
> vX.Y.Z が出ています」と**短く**伝え、作業は中断しません。更新は**ユーザーが承認したとき
> だけ**: `npm i -g donguri-journal@latest` を実行し、MCP クライアントの再起動を案内します。
> オフラインや npm の失敗時は黙ってスキップします（次のセッションでまた試せます）。

大切な原則は3つです: チェックは**セッションに一度だけ**行うこと、**無断で更新しない**こと
（グローバルインストールはシステム状態の変更です）、そして**オフラインでは静かにスキップする**
ことです。

## トラブルシューティング

| 症状 | 主な原因 | 対処 |
| --- | --- | --- |
| 起動直後に *「Server disconnected」* | `npx` の初回起動が重い/不安定（特に Windows） | **グローバルインストール**（手順2）にして起動時 DL をなくす |
| ネイティブビルドエラー *「no prebuilt for Node vXX」* / Visual Studio・C++ ツールを要求 | 新しい Node に古い donguri-journal | **0.1.2 以降**へ: `npm i -g donguri-journal@latest`（または Node 22 LTS を使う） |
| *「command not found: donguri-journal」* | クライアントが `PATH` を見えていない | bin の絶対パスを指定（`which` / `where donguri-journal`） |
| ツールが出てこない | クライアントを完全再起動していない | 完全終了して開き直す |
| レビューに PNG チャートが出ない | 任意の `sharp` 未インストール | `npm i -g sharp` で有効化（無ければデータのみ返す） |

**サーバーログ**（起動に失敗したとき）:

- Claude Desktop — Windows: `%APPDATA%\Claude\logs\mcp-server-donguri-journal.log`、
  macOS: `~/Library/Logs/Claude/mcp-server-donguri-journal.log`
- Claude Code — `claude mcp list` とクライアントの MCP ログ

解決しない場合は、お気軽に Issue でご相談ください: <https://github.com/nemutame/donguri-journal/issues>
