---
description: Claude Desktop に登録して、AIに bitbank のデータを分析させるまでの最短手順（約5分）
---

# クイックスタート

bitbank-lab-mcp を **Claude Desktop** に登録し、AI に市場データを分析させるまでの最短手順です。\
公開データのみの場合は APIキーは不要です。

{% hint style="success" %}
インストール作業はありません。`npx` 経由で起動するため、設定ファイルに数行追記するだけで完了します。
{% endhint %}

## 前提

* **Node.js 22 以上**（24 推奨）
  * `node -v` で確認できます
  * 未導入の場合は [Node.js 公式サイト](https://nodejs.org/) から入手してください
* **Claude Desktop**
  * 利用を推奨する MCPクライアント
  * [Claude 公式サイト](https://claude.com/ja/download) からダウンロードしてください

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

**A. Public データのみ:**

価格・板・ローソク足などの公開市場データの取得と分析。API キー不要。

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

**B. Private データ参照系（要 API キー）:**

資産残高・約定履歴・注文照会・ポートフォリオ分析などの読み取り専用。発注はできません。

```json
{
  "mcpServers": {
    "bitbank-lab": {
      "command": "npx",
      "args": ["-y", "bitbank-lab-mcp"],
      "env": {
        "BITBANK_API_KEY": "your_api_key",
        "BITBANK_API_SECRET": "your_api_secret"
      }
    }
  }
}
```

{% hint style="success" %}
**bitbank API の権限は「参照」のみ設定することを推奨**
{% endhint %}

&#x20;**C. 取引注文・注文キャンセル実行（要 APIキー）:**

B に加えて、AI からの発注・注文キャンセルまで実行。実行前に必ず確認ステップが入ります。

```json
{
  "mcpServers": {
    "bitbank-lab": {
      "command": "npx",
      "args": ["-y", "bitbank-lab-mcp"],
      "env": {
        "BITBANK_API_KEY": "your_api_key",
        "BITBANK_API_SECRET": "your_api_secret",
        "BITBANK_TRUST_HOST_APPROVAL": "1"
      }
    }
  }
}
```

{% hint style="success" %}
**bitbank API の権限は「参照」および「取引」のみ設定することを推奨**
{% endhint %}

**※「出金」権限は有効化しないことを強く推奨します。本サーバは出金系ツール未実装のため不要です。**

## 2. Claude Desktop を再起動する

設定を反映するため、**Claude Desktop を完全終了して再起動**してください。\
以降、設定を修正した場合も、それを反映するために毎度再起動が必要となります。

## 3. 動作確認

新規チャットを開いて、次のように話しかけてみてください。\
ツール利用の承認を求められます。Claude Desktop の **Customize** → **Connectors** からツール使用に関する承認要否の設定を行うことができます。

> BTC/JPY の今の価格を教えて

リアルタイム価格が返ってくれば成功です。他にも以下が試せます。

* `BTC の今の市場状況を analyze_market_signal で総合判定して、根拠と寄与度も教えて。`
* `おはようレポートを出して。`
* `直近1週間でテクニカル的に上向きの仮想通貨を3つ教えて。`

{% hint style="info" %}
うまく動かない場合は [トラブルシューティング](troubleshooting.md) を参照してください。
{% endhint %}

## （任意）API キーを設定して Private API を使う

自分の資産確認・取引履歴の参照や、AI からの発注・キャンセルを使う場合は、`env` ブロックに bitbank の API キーを追加します。必要な環境変数は `BITBANK_API_KEY` と `BITBANK_API_SECRET` の **2 つだけ**で、両方が設定されていると Private ツールが自動で有効になります。キーの発行手順と権限の選び方は [Private API（取引機能）](../private-api/setup.md) を参照してください。

{% tabs %}
{% tab title="参照のみ（資産・履歴の確認）" %}
bitbank 側で **「参照」権限のみ**のキーを発行して設定します（最も安全）。

```json
{
  "mcpServers": {
    "bitbank-lab": {
      "command": "npx",
      "args": ["-y", "bitbank-lab-mcp"],
      "env": {
        "BITBANK_API_KEY": "your_api_key",
        "BITBANK_API_SECRET": "your_api_secret"
      }
    }
  }
}
```
{% endtab %}

{% tab title="取引あり（発注・キャンセル）" %}
bitbank 側で **「参照」+「取引」権限**のキーを発行します。さらに Claude Desktop で発注の確認ボタン（確認 UI）を有効にするため、`BITBANK_TRUST_HOST_APPROVAL` を追加します。

```json
{
  "mcpServers": {
    "bitbank-lab": {
      "command": "npx",
      "args": ["-y", "bitbank-lab-mcp"],
      "env": {
        "BITBANK_API_KEY": "your_api_key",
        "BITBANK_API_SECRET": "your_api_secret",
        "BITBANK_TRUST_HOST_APPROVAL": "1"
      }
    }
  }
}
```

{% hint style="warning" %}
* `BITBANK_TRUST_HOST_APPROVAL` の値は文字列の `"1"` のみ有効です（`"true"` などは無効）。
* 発注は preview → 確認ボタン → 実行の 2 段階確認を必ず経由します。取引ツールの承認ダイアログでは**「常に許可（Always allow）」を選ばず**、毎回内容を確認してください。詳細は [取引の安全設計](../private-api/safety.md) を参照してください。
* **「出金」権限は絶対に有効化しないでください**（本サーバーは出金系ツールを実装していないため不要です）。
{% endhint %}
{% endtab %}
{% endtabs %}

設定を変更したら、Claude Desktop を再起動して反映してください。

## 次のステップ

* **他のクライアントで使いたい / 詳しい設定** → [セットアップ詳細](setup.md)
* **何を聞けばいいかわからない** → [プロンプト集](../guides/prompts.md)
* **何ができる？** → [MCP サーバーでできること](../guides/tools.md)
* **自分の資産確認や発注を使いたい** → [Private API（取引機能）](../private-api/setup.md)
