# 開発者向けガイド（ソースから起動）

このページは「自分で MCP サーバーをいじりたい」「PR を送りたい」という開発者向けです。**通常の利用者は [README のセクション 1](../README.md#1-claude-desktop-に登録推奨) の `npx -y bitbank-lab-mcp` 方式で OK** です（こちらは clone 不要）。

## セットアップ

```bash
git clone https://github.com/bitbankinc/bitbank-lab-mcp.git
cd bitbank-lab-mcp
npm ci
```

`package-lock.json` 通りに依存をインストールするため、ローカル開発でも `npm install` ではなく `npm ci` を推奨します（CI も `npm ci` を使用）。

ビルドステップは不要です（tsx で TypeScript を直接実行します）。

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

パスの書き方だけが変わります。`node` の場所は `where node` で確認してください：

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
