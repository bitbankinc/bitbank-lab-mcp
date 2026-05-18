---
description: bitbank-lab-mcp を Claude Desktop に導入し、AIに市場データを分析させるまでの手順
---

# MCPサーバーを使う

bitbank-lab-mcp を AIクライアントに導入する手順を説明します。本ページでは最も利用者が多い **Claude Desktop** での導入を中心に説明します。

## 全体の流れ

1. **必須要件の確認** — Node.js 22以上 がインストールされていることを確認します
2. **AIクライアントへの設定** — Claude Desktop の設定ファイルに MCPサーバー を登録します
3. **動作確認** — AIに質問して、bitbank のデータが取得できることを確かめます
4. **（任意）API キーの設定** — 自分の資産確認や発注機能を使う場合に設定します

{% hint style="success" %}
インストール作業はありません。`npx` 経由で起動するため、設定ファイルに追記するだけで完了します。
{% endhint %}

## 必須要件

* **Node.js 22以上**（24推奨）
* **対応OS**: macOS / Linux / Windows（WSL含む）
* **Claude Desktop**（本ページの手順で使用するAIクライアント）

Node.js のバージョンは以下のコマンドで確認できます。

```bash
node -v
```

`v22.x.x` 以上が表示されればOKです。インストールしていない場合は [Node.js公式サイト](https://nodejs.org/) からダウンロードしてください。

## AIクライアントへの設定

### Claude Desktop

`claude_desktop_config.json` に以下を追加します。

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

**設定内容:**

{% tabs %}
{% tab title="Public ツールのみ（推奨・APIキー不要）" %}
市場データの取得・テクニカル分析・チャート可視化など、認証不要のツールのみを使う設定です。**まずはこちらから始めることを強く推奨します。**

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
{% endtab %}

{% tab title="Private ツールも使う（APIキーあり）" %}
自分の資産確認や発注機能も使う場合の設定です。先に [API キーを発行する](#api-キーを発行する) のセクションを読んでから設定してください。

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
{% endtabs %}

設定後、**Claude Desktop を完全終了して再起動** してください（macOSは `Cmd+Q`、Windowsはタスクトレイから完全終了）。

{% hint style="info" %}
Claude Desktop の UI に表示される名前は `mcpServers` 配下のキー名（上記の例では `bitbank-lab`）で決まります。日本語名（例: `ビットバンクMCP`）も使用できます。
{% endhint %}

## 動作確認

Claude Desktop を再起動したら、新規チャットを開いて以下のように質問してみてください。

> BTC/JPY の今の価格を教えて

bitbank-lab-mcp のツールが呼び出され、リアルタイム価格が返ってくれば成功です。

他にも以下のような質問が試せます。

* `BTC の今の市場状況を analyze_market_signal で総合判定して、根拠と寄与度も教えて。`
* `おはようレポートを出して。`
* `直近1週間でテクニカル的に上向きの仮想通貨を3つ教えて。`

## API キーを発行する

自分の資産確認や発注機能（Private ツール）を使う場合のみ必要です。

### 1. bitbank で API キーを発行

[bitbank API設定画面](https://app.bitbank.cc/account/api) で API キーを発行します。

{% hint style="danger" %}
**「出金」権限は絶対に有効化しないでください。**

本MCPサーバーは出金系ツールを実装していないため、この権限は不要です。漏洩時の資産流出リスクを避けるためにも、必要最小限の権限のみを付与してください。
{% endhint %}

### 2. 必要な権限を選ぶ

| やりたいこと | 必要な権限 |
| --- | --- |
| 資産確認・ポートフォリオ分析（読み取り専用） | **「参照」のみ** ← 最も安全、迷ったらこちら |
| 上記 + AI に発注・キャンセル操作も任せたい | 「参照」+「取引」 |

### 3. IP制限の設定（推奨）

bitbank側でAPIキーにIP制限を設定できる場合は、自宅のグローバルIPなどに制限することを推奨します。

### 4. 設定ファイルに反映

発行したキーを `claude_desktop_config.json` の `env` ブロックに記入し、Claude Desktop を再起動してください（[上記の Private ツールも使う タブ](#aiクライアントへの設定) を参照）。

## トラブルシューティング

### Claude Desktop で「サーバーに接続できません」と表示される

Claude Desktop から `npx` コマンドが見つけられていない可能性があります。ターミナルで `which npx`（Windows は `where npx`）を実行し、出力されたパスを `command` に指定してください。

```json
{
  "mcpServers": {
    "bitbank-lab": {
      "command": "<which npx の出力をここに>",
      "args": ["-y", "bitbank-lab-mcp"]
    }
  }
}
```

`which npx` の出力例:

| 出力 | インストール方法 |
| --- | --- |
| `/opt/homebrew/bin/npx` | Homebrew（Apple Silicon Mac） |
| `/usr/local/bin/npx` | Homebrew（Intel Mac）または公式インストーラ |
| `/Users/XXX/.nvm/versions/node/vXX.XX.X/bin/npx` | nvm |
| `/Users/XXX/.volta/bin/npx` | volta |

{% hint style="warning" %}
**nvm / volta ユーザーの方へ**: この方式では Node.js をバージョンアップするたびに `command` のパスを書き換える必要があります。アップデート後は `which npx` を再確認してください。
{% endhint %}

### Private ツールが表示されない

`BITBANK_API_KEY` と `BITBANK_API_SECRET` の両方が設定されているか確認してください。片方だけでは Private ツールは有効になりません。

### ログを詳細に確認したい

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

### その他

[GitHub Issues](https://github.com/tjackiet/bitbank-genesis-mcp-server/issues) にてバグ報告・機能要望を受け付けています。

## ドキュメントをAIから検索する（任意）

本ドキュメントサイトには、GitBook が提供する MCP サーバが自動で付属しています。これを Claude Desktop に追加すると、AI に「bitbank-lab-mcp のドキュメントを検索して」のように依頼して、ドキュメント横断の検索・参照ができるようになります。

{% hint style="info" %}
Claude Desktop は現時点で remote HTTP の MCP サーバを直接サポートしていないため、[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) 経由でブリッジします。
{% endhint %}

`claude_desktop_config.json` の `mcpServers` に `bitbank-lab-docs` を並べて追加します。

```json
{
  "mcpServers": {
    "bitbank-lab": {
      "command": "npx",
      "args": ["-y", "bitbank-lab-mcp"]
    },
    "bitbank-lab-docs": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://bitbank-lab.gitbook.io/bitbank-lab-docs/~gitbook/mcp"
      ]
    }
  }
}
```

Claude Desktop を再起動後、`bitbank-lab-docs` がツール一覧に表示されれば成功です。

{% hint style="success" %}
GitBook 側の MCP サーバは **読み取り専用** で、公開済みドキュメントのみを返します。資産情報やAPIキーは送信されません。
{% endhint %}

## 次のステップ

* **使えるツールの一覧** → [docs/tools.md（GitHub）](https://github.com/tjackiet/bitbank-genesis-mcp-server/blob/main/docs/tools.md)
* **Claude Code / Cursor / Codex / Gemini CLI で使う** → 各クライアント向けの `/plugin install` 方式が利用可能です（[GitHub README](https://github.com/tjackiet/bitbank-genesis-mcp-server#readme) 参照）
