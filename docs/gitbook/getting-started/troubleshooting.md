---
description: 導入時によくあるトラブルと対処法
---

# トラブルシューティング

導入時によくある症状と対処法をまとめます。

| 症状 | 原因・対処 |
| --- | --- |
| Claude Desktop にツールが表示されない | `claude_desktop_config.json` の JSON 構文が壊れている / Claude Desktop を `Cmd+Q`（Windows は完全終了）で再起動していない |
| 「サーバーに接続できません」エラー（npx 方式） | Claude Desktop から `npx` が見つからない可能性。[方式B（npx 絶対パス）](claude-desktop.md) に切り替える |
| `spawn npx ENOENT` エラー | `which npx` の結果が異なるパスを指している。`command` を正しいパスに書き換える |
| Node.js アップデート後に MCP が動かなくなった | nvm / volta の場合、Node.js バージョンが変わると絶対パスも変わる。`which npx` を再確認して `command` を更新するか、方式A（`npx` 名指し）に切り替える |
| `Cannot find package 'tsx'` エラー | 古い版（v0.1.0）でこの問題が発生。`npx -y bitbank-lab-mcp@latest` で最新版に更新するか、設定を再起動 |
| ツール実行時にタイムアウト | ネットワーク接続を確認 / [bitbank API の状態](https://status.bitbank.cc/) を確認 |
| Private API ツールが表示されない | `BITBANK_API_KEY` と `BITBANK_API_SECRET` の両方が設定されているか確認（→ [Private API](../private-api/setup.md)） |
| ログを詳細に確認したい | `env` に `"LOG_LEVEL": "debug"` を追加して再起動 |
| Plugin install で「Marketplace not found」 | `/plugin marketplace add tjackiet/bitbank-lab-mcp` を先に実行してから `/plugin install bitbank-lab-mcp@bitbank-lab` |

## ログを詳細に確認する

`env` ブロックに `"LOG_LEVEL": "debug"` を追加して再起動すると詳細ログが出力されます。

```json
{
  "mcpServers": {
    "bitbank-lab": {
      "command": "npx",
      "args": ["-y", "bitbank-lab-mcp"],
      "env": {
        "LOG_LEVEL": "debug"
      }
    }
  }
}
```

## それでも解決しない場合

[GitHub Issues](https://github.com/tjackiet/bitbank-lab-mcp/issues) にてバグ報告・機能要望を受け付けています。Issue テンプレートを用意していますので、用途に合ったものを選択してください。
