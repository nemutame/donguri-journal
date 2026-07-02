# 🐿️ donguri-journal

[English](README.md) | **日本語**

[![npm](https://img.shields.io/npm/v/donguri-journal)](https://www.npmjs.com/package/donguri-journal)

> ローカルファースト・時間軸対応の「**記憶**」MCP サーバー（AI エージェント向け）。

リスは掘り返すよりずっと多くのドングリ（donguri）を埋めます——ためらわず、ひたすら
貯め込みます。donguri-journal も同じ姿勢です。マルチモーダル LLM（Claude など）が
コンパニオン兼 UI となり、このサーバーはその背後にある永続的な「記憶器官」です。核となる
仕事は、会話の流れの中で気軽に **capture（捕捉）** し何ひとつ失わないこと、そして時間を
越えて **recall（想起）** できるようにすることです。貯め込んだ山を*うまく*掘り返すこと
——より豊かな振り返り・再浮上・新しい切り口——はもっと難しく開かれた部分で、そこを
**プラグイン**が拡張します。

> 設計思想と全体ロードマップは **[docs/DESIGN.ja.md](docs/DESIGN.ja.md)** にあります。

---

## これは何か

- **ローカルファースト。** すべてが手元の SQLite ファイル1つ＋ローカルの originals
  ディレクトリに収まります。クラウドもアカウントも必要ありません。
- **時間が第一級。** すべてのエントリが `created_at`（捕捉した時刻）と `occurred_at`
  （出来事が実際に起きた時刻）の両方を持ちます。「3か月前は何を考えていた？」週次/月次
  レビュー、BuJo 的なマイグレーションなど、人間の振り返りのための設計です。
- **マルチモーダルは委譲。** サーバーは vision/音声モデルを動かしません。あなたの
  マルチモーダル LLM が画像/音声/URL から忠実なテキストを抽出して渡し、**原本のバイト
  はそのまま保存**されます（破壊しません）。
- **ゼロセットアップの埋め込み。** 意味検索はインプロセスの
  [transformers.js](https://github.com/xenova/transformers.js)
  （`Xenova/all-MiniLM-L6-v2`, 384 次元）で標準動作します。Ollama も手動のモデル取得も
  不要です。バックエンドは上級者向けに差し替え可能です。

> **現状:** Phase 1（capture / recall）＋ Phase 1.5（レビュー/インサイト）、ローカル
> 原本保存、エントリ管理、プラグイン読み込み、そして**読み取り専用の管理コンソール**が
> 実装済み。UI からの削除/エクスポート、アルバム表示、キュレーション済みプラグイン
> レジストリ、ローカルファースト同期は計画中です——[docs/DESIGN.md](docs/DESIGN.md) を参照。

## 必要環境

- **Node.js 22 以上**
- **MCP を話せるマルチモーダル LLM クライアント**（例: Claude Desktop）。これは必須
  要件です——サーバー自体は UI を持たず、メディアの処理もしません。

## セットアップ

### インストール（推奨）

一度だけグローバルにインストールし、MCP クライアントからはそのコマンドを指すだけで
使えます。**インストールは一度きり**（起動のたびに走らない）なので、どのクライアント
（Claude Desktop / Claude Code / Codex / Cursor …）でも即起動する、いちばん確実な方法です:

```bash
npm install -g donguri-journal
```

**Claude Desktop**（`claude_desktop_config.json`）:

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

MCP クライアントを再起動してください。初回利用時に埋め込みモデルが一度だけ
ダウンロード・キャッシュされます（ネットワーク必要）。以降はすべてローカルで動作します。

### お試し（npx・インストール不要）

何もインストールせず試すなら、`npx` がその場で取得して実行します:

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

注意: **初回**起動は依存ツリー全体をダウンロードするため重く、**Windows + Claude
Desktop** ではクライアントの起動待ちを超えて *「Server disconnected」* になることが
あります。その場合は上のグローバルインストールを使ってください。`npx` は macOS/Linux や
CLI エージェント（Claude Code / Codex）では概ね快適です。

### AI エージェントで導入

エージェントに任せたい場合は、**[セットアップ手順書（docs/SETUP.ja.md）](docs/SETUP.ja.md)**
を参照させてください——冒頭に「AI エージェント向け」の注意書き（自分のクライアントだけ設定・
他アプリの設定に触れない、という原則）があり、続けて前提チェック・インストール・クライアント別
設定・トラブルシューティングまで一通り載っています。シェルを実行できるエージェント（例:
**Codex** / **Claude Code** / **Cursor**）に下を貼り付けてください:

```text
donguri-journal MCP サーバーを、次のガイド（冒頭の「AI エージェント向け」注意書きも含めて）に
沿ってセットアップして:
https://github.com/nemutame/donguri-journal/blob/main/docs/SETUP.ja.md
```

エージェントが Web を開けない場合は、**[docs/SETUP.ja.md](docs/SETUP.ja.md)** を開いて中身を
チャットに貼り付けてください。

### ソースから（開発向け）

コントリビュートや未リリース版の実行には、チェックアウトからビルドして、ビルド済みの
エントリをクライアントに指定します。

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

MCP クライアントがシェルの `PATH` を引き継がない場合（nvm でよく起きます）は、`node` を
絶対パスで指定してください。例: `/home/you/.nvm/versions/node/v22.x.y/bin/node`

### 任意: PNG チャート

`generate_review` と `surface_patterns` は [`sharp`](https://www.npmjs.com/package/sharp)
で描画した PNG チャートを添付できます。sharp は**任意（optional）依存**で、既定では
インストールされません（大きなネイティブバイナリが基本インストールを重く・不安定に
するため）。無くても両ツールは構造化データとヒントを通常どおり返し、画像だけが省かれます。
チャートを有効にするには、サーバーと同じスコープに sharp を入れてください——例えば
グローバルインストールなら `npm install -g sharp`、ソースからなら `npm install sharp`。

### 設定

| 環境変数 | 既定値 | 意味 |
| --- | --- | --- |
| `JOURNAL_DB_PATH` | `~/.journal-mcp/journal.db` | SQLite データベースファイルのパス。 |
| `JOURNAL_ORIGINALS_DIR` | `~/.journal-mcp/originals` | 原本（画像/音声/ファイル）を content-addressed で保存するディレクトリ。 |
| `JOURNAL_MAX_ORIGINAL_BYTES` | `26214400`（25 MiB） | 1 つの原本の最大サイズ。これを超える `original_data` は拒否されます。 |
| `JOURNAL_PLUGINS_DIR` | `~/.journal-mcp/plugins` | 導入済みプラグインを置くディレクトリ（プラグインごとにサブディレクトリ）。 |
| `JOURNAL_PLUGINS_CONFIG` | `~/.journal-mcp/plugins.json` | どのプラグインが導入/有効かを記録する JSON ファイル。 |

`stdout` は MCP プロトコル専用です。ログはすべて `stderr` に出力されます。

## ツール

ツールの説明文は、フロントエンド LLM への指示書として書かれています（いつ各ツールを
呼ぶか）。

| ツール | 役割 |
| --- | --- |
| `capture` | いま記憶を貯める。低摩擦。メディアの場合、LLM は抽出テキストに加えて原本のバイト（`original_data`）を渡し、サーバーがそのまま保存。自動で重複排除。 |
| `update_entry_status` | エントリのビュー中立注釈を更新——アクションを `done` / `dropped` / 再オープンに、`due` / `priority` / `delegated_to` を設定。変わるのは `meta` だけ（本文とタイムスタンプは不変）。 |
| `link_entries` | 2つのエントリ間に型付きの関係を追加（常に新→旧）: `continues`（未完アクションの持ち越し/書き直し）または `references`（一般の関連）。冪等。 |
| `query_entries` | 日付範囲 / タグ / 種別による**構造化**検索。正確で絞り込み可能な問いやレビュー向け。 |
| `recall_related` | **意味**ベクトル検索。言い回しが違っても、意味的に関連する過去のエントリを見つける。 |
| `generate_review` | 日 / 週 / 月（または任意範囲）の振り返り。**PNG のアクティビティチャート**＋構造化集計（合計・最多日・種別・上位タグ）＋提示ヒントを返す。 |
| `surface_patterns` | 再発テーマ——最近のエントリが**過去のどれと「こだま」するか**。距離付きのクラスタ＋ PNG チャート＋提示ヒントを返す。 |
| `get_original` | `original_ref` で保存済みの原本を取得。画像はインラインで返し（LLM が再閲覧・再抽出可能）、それ以外はメタデータのみ返す。 |
| `reindex` | 保守——現在の埋め込みバックエンドで原本からベクトルインデックスを再構築。バックエンド変更後に実行（不一致時は起動時に警告）。原本は一切触らない。 |
| `storage_stats` | 容量: エントリ数（有効/ソフト削除）・ベクトル数・種別/月別・原本の件数とバイト・DB サイズ。 |
| `delete_entry` | エントリ削除——`mode: soft`（復元可能な tombstone）/ `hard`（entry＋ベクトル＋孤児原本を完全消去し VACUUM）。 |
| `open_management_ui` | 所有者が LLM 会話の外で直接、閲覧・フィルタ・意味検索・容量統計を見るための **localhost 限定** Web コンソールを起動。ブラウザで開くトークン付き URL を返す。 |
| `list_features` / `enable_feature` / `disable_feature` | 組み込みの opt-in 機能（ファーストパーティ・インストールの儀式不要）: 一覧とライブなトグル——有効化で即ツール登録、無効化で即削除。選択は永続化。 |
| `bujo_day` / `bujo_month` / `bujo_future` / `bujo_reconcile` | **Bullet Journal レンズ**（`enable_feature: bujo` で opt-in・読み取り専用）: 記号（`•` `x` `>` `<` `○` `–`）を導出したデイリー/マンスリー/フューチャーログと、open なアクションを 完了 / 破棄 / 持ち越し で裁く棚卸ビュー。 |
| `list_installed_plugins` | 導入済みプラグインを一覧（有効状態・バージョン・宣言ケイパビリティ）。 |
| `install_plugin` | ローカルのプラグインを導入。2段階: 提案（マニフェスト＋権限を確認）→ `confirm: true`。再起動なしで即有効。 |
| `uninstall_plugin` | 導入済みプラグインをディスクとレジストリから削除。既に登録済みのツールはサーバー再起動まで残ります。 |

`query_entries` と `recall_related` は意図的に別経路です（LLM が問いに応じて、正確な
絞り込みか意味かを選ぶ）。`generate_review` と `surface_patterns` は、描画済みの PNG
チャートに加えて構造化データと提示ヒントを返すので、LLM は素の一覧ではなく豊かな
振り返りとして提示できます。

## 保存のしくみ

2 層構造により、インデックスは常に再構築可能で、原本は失われません。

- **`entries`** — インデックス対象テキスト（`body`）、原本への参照（`original_ref`）、
  各種タイムスタンプ、タグ、メタデータ。`extraction_state` は `body` の生成方法を記録し、
  ロスのある抽出を後でやり直せるようにします。
- **`vec_entries`** — 使い捨ての
  [sqlite-vec](https://github.com/asg017/sqlite-vec) ベクトルインデックス。有効な埋め込み
  モデル/次元を記録し、バックエンド切替時に再インデックスを促せます。
- **originals（原本）** — LLM が原本のバイトを送ると、ローカルの content-addressed
  ストア（`OriginalStore`、既定はローカルディレクトリ）にそのまま保存され、
  `original_ref` がそれを指します。バックエンドは差し替え可能で、サーバーは中身を
  解釈しません。埋め込みは常に抽出テキストから作られ、メディア自体からは作りません。

## コントリビュート

コントリビュートはいつでも歓迎です——**Issue / PR は日本語でも大丈夫です**。大きめの
変更を提案される前に、設計意図を [docs/DESIGN.ja.md](docs/DESIGN.ja.md)（英語版:
[docs/DESIGN.md](docs/DESIGN.md)）でご確認いただけると嬉しいです。

```bash
npm run lint        # Biome（lint + フォーマットチェック）
npm run lint:fix    # 自動修正
npm run typecheck   # tsc（src + テスト）
npm test            # tsx 経由の node:test
npm run build       # tsc -> dist/
```

ワークフロー:

- Node 22 は `.nvmrc` で固定しています（`nvm use`）。
- `main` は保護されています——ブランチを切って Pull Request を作成してください。
- すべての PR は **CI**（lint + typecheck + build + テスト）と **CodeRabbit** レビューでゲート
  され、両方の通過後にマージできます。

## ライセンス

[MIT](./LICENSE) © Nemutame
