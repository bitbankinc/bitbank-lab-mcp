# 開発者向けガイド（ソースから起動）

このページは「自分で MCP サーバーをいじりたい」「PR を送りたい」という開発者向けです。**通常の利用者は [README のセクション 1](../README.md#1-claude-desktop-に登録) の `npx -y bitbank-lab-mcp` 方式で OK** です（こちらは clone 不要）。

## セットアップ

```bash
git clone https://github.com/bitbankinc/bitbank-lab-mcp.git
cd bitbank-lab-mcp
npm ci
```

`package-lock.json` 通りに依存をインストールするため、ローカル開発でも `npm install` ではなく `npm ci` を推奨します（CI も `npm ci` を使用）。

ビルドステップは不要です（tsx で TypeScript を直接実行します）。

⚠️ **最初の commit の前に** [CONTRIBUTING.md](../CONTRIBUTING.md) を読んでください。pre-commit フックが **gitleaks のインストールを必須**にしています（未導入だと commit が失敗します）。なお `npm ci` は `CI` 環境変数が真でないときだけフックを自動導入するので、`CI` が設定された環境では `npx lefthook install` を実行してください。

## ディレクトリマップ

| 場所 | 役割 |
|---|---|
| `src/` | サーバー本体（server / registry / handlers / schema / private） |
| `tools/` | MCP ツールの実装（`toolDef` を export し、`src/tool-registry.ts` に import と `allToolDefs` への追加が必要） |
| `lib/` | 共通ユーティリティ（ツールをまたぐ処理はここに置く） |
| `tests/` | vitest（`tests/e2e/` は別コマンド） |
| `docs/` | ドキュメント（[索引](README.md)） |
| `plugins/` / `skills/` | Claude Code / claude.ai 向け plugin の配布物 |
| `lab/` | 研究用の起動口（npm には同梱されない。ADR-0008） |
| `ui/` | 注文/取消の確認カード（vite ビルド。`dist/` はコミット対象） |
| `assets/`, `cache/`, `logs/`, `output/`, `reports/`, `coverage/` | 実行時に生成（git 対象外。`assets/lightweight-charts.standalone.js` のみ同梱） |

## よくある変更の手順

- **コマンド一覧とアーキテクチャ境界の正本**: [CLAUDE.md](../CLAUDE.md)
- **ツールの追加・修正**（`toolDef` を export → `src/tool-registry.ts` に import と `allToolDefs` 追加、content 可視性、view 規約）: [.claude/rules/tools.md](../.claude/rules/tools.md)
- **スキーマ変更**: `src/schema/` の Zod 定義が単一ソース。変更後に `npm run gen:types`
- **テストの書き方**（エッジケース優先順位・fetch モック規約）: [.claude/rules/testing.md](../.claude/rules/testing.md)
- **手数料を扱うコード**: [.claude/rules/fees.md](../.claude/rules/fees.md)

`.claude/rules/` はコーディングエージェント向けの規約置き場ですが、人間が読んでも同じ内容が正本です。

## STDIO モード（Claude Desktop / Claude Code 向け）

ローカルの開発版を Claude Desktop から使いたい場合、`claude_desktop_config.json` に、`node` とクローン先の `tsx`・サーバーを絶対パスで登録します。Claude Desktop はサーバーをクローン先以外のフォルダから、ターミナルとは違う `PATH` で起動するので、`npx tsx` ではクローン先の `tsx` が使われず、`node` が見つからないこともあります：

```json
{
  "mcpServers": {
    "bitbank-dev": {
      "command": "/ABS/PATH/to/node",
      "args": [
        "/ABS/PATH/to/project/node_modules/tsx/dist/cli.mjs",
        "/ABS/PATH/to/project/src/server.ts"
      ],
      "env": { "LOG_LEVEL": "debug", "NO_COLOR": "1" }
    }
  }
}
```

`/ABS/PATH/to/node` は `which node` の出力に、`/ABS/PATH/to/project` は実際のクローン先パス（`pwd` で確認）に置き換えてください。nvm / volta では、Node.js を更新すると `node` のパスが変わります。**npm 公開版（`bitbank-lab`）と区別するため、サーバー名は `bitbank-dev` 等にしておくと両立できます**。

Inspector で動作確認する場合:

```bash
npx @modelcontextprotocol/inspector -- tsx src/server.ts
```

## Windows でローカル開発する場合

パスの書き方だけが変わります。`node` の場所は `where.exe node` で確認してください（PowerShell では `where` だけだと別のコマンドになる）：

```json
{
  "mcpServers": {
    "bitbank-dev": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\Users\\<USERNAME>\\bitbank-lab-mcp\\node_modules\\tsx\\dist\\cli.mjs",
        "C:\\Users\\<USERNAME>\\bitbank-lab-mcp\\src\\server.ts"
      ],
      "env": { "LOG_LEVEL": "debug", "NO_COLOR": "1" }
    }
  }
}
```

## CI / 型生成 / リンター

開発時のコマンド一覧は [CLAUDE.md](../CLAUDE.md) を参照してください（`npm test` / `npm run lint:fix` / `npm run gen:types` 等）。
