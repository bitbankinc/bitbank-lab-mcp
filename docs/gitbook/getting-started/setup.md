---
description: AIクライアント別の詳細なセットアップ手順への案内
---

# セットアップ詳細

[クイックスタート](quickstart.md) では Claude Desktop の最短手順だけを紹介しました。このセクションでは、各 AIクライアント別の詳しい設定方法を説明します。お使いのクライアントのページに進んでください。

## 対応クライアントと導入方法

| クライアント | 推奨される導入方法 | 詳細ページ |
| --- | --- | --- |
| Claude Desktop | `claude_desktop_config.json` に手動追記 | [Claude Desktop](claude-desktop.md) |
| Claude Code | `/plugin install`（GUI でキー入力） | [Plugin 導入](plugin-clients.md) |
| Gemini CLI | extension install（対話でキー入力） | [Plugin 導入](plugin-clients.md) |
| Cursor | Plugin install＋環境変数、または `.cursor/mcp.json` | [Plugin 導入](plugin-clients.md) / [その他のクライアント](other-clients.md) |
| Codex | Plugin install＋環境変数 | [Plugin 導入](plugin-clients.md) |
| Windsurf ほか汎用 MCP クライアント | `mcp.json` に手動追記 | [その他のクライアント](other-clients.md) |

{% hint style="info" %}
いずれの方法でも npm に公開された [`bitbank-lab-mcp`](https://www.npmjs.com/package/bitbank-lab-mcp) を `npx -y` 経由で起動します。**ソースコードのクローンは不要** です。
{% endhint %}

## API キーは必要？

公開データの取得・テクニカル分析・チャート生成だけなら **API キーは不要** です。自分の資産確認や発注機能（Private ツール）を使う場合のみ必要になります。詳細は [Private API（取引機能）](../private-api/setup.md) を参照してください。

## オプション環境変数

| 変数 | 既定 | 用途 |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | `debug` を指定すると詳細ログを出力。トラブル調査時に使用。 |
| `BITBANK_TRUST_HOST_APPROVAL` | unset（無視） | **撤去済み。** 設定しても効果なし。旧 iframe に token を載せる妥協モードはセキュリティ上無効化した。取引実行は elicitation / MRTR のみ。詳細は [取引の安全設計](../private-api/safety.md)。 |
| `BITBANK_API_KEY` / `BITBANK_API_SECRET` | unset | Private ツールを有効化する API キー。両方そろって初めて有効になる。 |
