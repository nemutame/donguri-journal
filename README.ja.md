# 🐿️ donguri-journal

[English](README.md) | **日本語**

> ローカルファースト・時間軸対応の「**記憶**」MCP サーバー（AI エージェント向け）。

リスは掘り返すよりずっと多くのドングリ（donguri）を埋めます——ためらわず、ひたすら
貯め込む。donguri-journal も同じ姿勢です。マルチモーダル LLM（Claude など）が
コンパニオン兼 UI となり、このサーバーはその背後にある永続的な「記憶器官」。核となる
仕事は、会話の流れの中で気軽に **capture（捕捉）** し何ひとつ失わないこと、そして時間を
越えて **recall（想起）** できるようにすることです。貯め込んだ山を*うまく*掘り返すこと
——より豊かな振り返り・再浮上・新しい切り口——はもっと難しく開かれた部分で、そこを
**プラグイン** が拡張します。

> 設計思想と全体ロードマップは **[docs/DESIGN.ja.md](docs/DESIGN.ja.md)** にあります。

---

## これは何か

- **ローカルファースト。** すべてが手元の SQLite ファイル1つ＋ローカルの originals
  ディレクトリに収まります。クラウド不要・アカウント不要。
- **時間が第一級。** すべてのエントリが `created_at`（捕捉した時刻）と `occurred_at`
  （出来事が実際に起きた時刻）の両方を持ちます。「3か月前は何を考えていた？」週次/月次
  レビュー、BuJo 的なマイグレーションなど、人間の振り返りのための設計です。
- **マルチモーダルは委譲。** サーバーは vision/音声モデルを動かしません。あなたの
  マルチモーダル LLM が画像/音声/URL から忠実なテキストを抽出して渡し、**原本のバイト
  はそのまま保存**されます（破壊しません）。
- **ゼロセットアップの埋め込み。** 意味検索はインプロセスの
  [transformers.js](https://github.com/xenova/transformers.js)
  （`Xenova/all-MiniLM-L6-v2`, 384 次元）で標準動作。Ollama も手動のモデル取得も不要。
  バックエンドは上級者向けに差し替え可能です。

> **現状:** Phase 1（capture / recall）＋ Phase 1.5（レビュー/インサイト）＋ ローカル
> 原本保存 が実装済み。管理 UI、エージェントが導入できるプラグイン基盤、ローカル
> ファースト同期は設計・計画済みです——[docs/DESIGN.md](docs/DESIGN.md) を参照。

## 必要環境

- **Node.js 22 以上**
- **MCP を話せるマルチモーダル LLM クライアント**（例: Claude Desktop）。これは必須
  要件です——サーバー自体は UI を持たず、メディアの処理もしません。

## セットアップ

npm 公開前は、ローカルビルドから実行します。

```bash
npm install
npm run build
```

そのうえで MCP クライアントに登録します。例（Claude Desktop の
`claude_desktop_config.json`）:

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

初回利用時に埋め込みモデル（約 90 MB）が自動でダウンロード・キャッシュされます
（一度だけネットワークが必要）。MCP クライアントがシェルの `PATH` を引き継がない場合
（nvm でよく起きます）は、`node` を絶対パスで指定してください。例:
`/home/you/.nvm/versions/node/v22.x.y/bin/node`

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
| `query_entries` | 日付範囲 / タグ / 種別による**構造化**検索。正確で絞り込み可能な問いやレビュー向け。 |
| `recall_related` | **意味**ベクトル検索。言い回しが違っても、意味的に関連する過去のエントリを見つける。 |
| `generate_review` | 日 / 週 / 月（または任意範囲）の振り返り。**PNG のアクティビティチャート**＋構造化集計（合計・最多日・種別・上位タグ）＋提示ヒントを返す。 |
| `surface_patterns` | 再発テーマ——最近のエントリが**過去のどれと「こだま」するか**。距離付きのクラスタ＋ PNG チャート＋提示ヒントを返す。 |
| `get_original` | `original_ref` で保存済みの原本を取得。画像はインラインで返し（LLM が再閲覧・再抽出可能）、それ以外はメタデータのみ返す。 |
| `reindex` | 保守——現在の埋め込みバックエンドで原本からベクトルインデックスを再構築。バックエンド変更後に実行（不一致時は起動時に警告）。原本は一切触らない。 |
| `storage_stats` | 容量: エントリ数（有効/ソフト削除）・ベクトル数・種別/月別・原本の件数とバイト・DB サイズ。 |
| `delete_entry` | エントリ削除——`mode: soft`（復元可能な tombstone）/ `hard`（entry＋ベクトル＋孤児原本を完全消去し VACUUM）。 |
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

歓迎します——**日本語での Issue / PR でも構いません**。大きめの変更を提案する前に、
設計意図を [docs/DESIGN.ja.md](docs/DESIGN.ja.md)（英語版: [docs/DESIGN.md](docs/DESIGN.md)）で確認してください。

```bash
npm run lint        # Biome（lint + フォーマットチェック）
npm run lint:fix    # 自動修正
npm run typecheck   # tsc（src + テスト）
npm test            # tsx 経由の node:test
npm run build       # tsc -> dist/
```

ワークフロー:

- Node 22 は `.nvmrc` で固定（`nvm use`）。
- `main` は保護されています——ブランチを切って Pull Request を作成してください。
- すべての PR は **CI**（lint + typecheck + build + テスト）と **CodeRabbit** レビューでゲート
  され、両方の通過後にマージできます。

## ライセンス

[MIT](./LICENSE) © Nemutame
