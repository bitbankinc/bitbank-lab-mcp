---
description: Claude Desktop に登録して、AIに bitbank のデータを分析させるまでの最短手順（約5分）
---

# クイックスタート（5分）

bitbank-lab-mcp を **Claude Desktop** に登録し、AIに市場データを分析させるまでの最短手順です。API キーは不要（Public ツールのみ）で始められます。

{% hint style="success" %}
インストール作業はありません。`npx` 経由で起動するため、設定ファイルに数行追記するだけで完了します。
{% endhint %}

## 前提

* **Node.js 22 以上**（24 推奨）。`node -v` で確認できます。未導入の場合は [Node.js 公式サイト](https://nodejs.org/) から入手してください。
* **Claude Desktop**（本ページで使う AIクライアント）

## 1. 設定ファイルに追記する

`claude_desktop_config.json` を開き、以下を追記します。

**設定ファイルの場所:**

{% tabs %}
{% tab title="macOS" %}
```plaintext
~/Library/Application Support/Claude/claude_desktop_config.json
```
{% endtab %}

{% tab title="Windows" %}
```plaintext
%APPDATA%\Claude\claude_desktop_config.json
```
{% endtab %}
{% endtabs %}

**設定内容（Public ツールのみ・API キー不要）:**

```json
{
  "mcpServers": {
    "bitbank-lab": {
      "command": "npx",
      "args": ["-y", "bitbank-lab-mcp"]
    }
  }
}
```

## 2. Claude Desktop を再起動する

設定を反映するため、**Claude Desktop を完全終了して再起動** してください（macOS は `Cmd+Q`、Windows はタスクトレイから完全終了）。

## 3. 動作確認

新規チャットを開いて、次のように話しかけてみてください。

> BTC/JPY の今の価格を教えて

リアルタイム価格が返ってくれば成功です。他にも以下が試せます。

* `BTC の今の市場状況を analyze_market_signal で総合判定して、根拠と寄与度も教えて。`
* `おはようレポートを出して。`
* `直近1週間でテクニカル的に上向きの仮想通貨を3つ教えて。`

{% hint style="info" %}
うまく動かない場合は [トラブルシューティング](troubleshooting.md) を参照してください。`npx` が見つからない場合の対処などをまとめています。
{% endhint %}

## 次のステップ

* **他のクライアントで使いたい / 詳しい設定** → [セットアップ詳細](setup.md)
* **何を聞けばいいかわからない** → [プロンプト集](../guides/prompts.md)
* **何ができる？** → [MCP サーバーでできること](../guides/tools.md)
* **自分の資産確認や発注を使いたい** → [Private API（取引機能）](../private-api/setup.md)
