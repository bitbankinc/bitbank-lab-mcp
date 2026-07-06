---
description: Claude Desktop に bitbank-lab-mcp を登録する詳細手順（方式A / 方式B / Windows）
---

# Claude Desktop

Claude Desktop は最も多くの方が使う想定の MCPクライアントです。`claude_desktop_config.json` に設定を追加して登録します。

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

設定方法は2通りあります。**まず方式A を試し、動かない場合に方式B をお試しください。**

## 方式A：`npx` 経由（推奨）

Node.js のバージョンアップで設定を書き換える必要がないため、こちらを推奨します。nvm / volta などのバージョン管理ツールをお使いの方には特におすすめです。

{% tabs %}
{% tab title="Public ツールのみ（APIキー不要）" %}
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

API キーの発行と権限の選び方は [Private API（取引機能）](../private-api/setup.md) を参照してください。
{% endtab %}
{% endtabs %}

## 方式B：`npx` の絶対パスを指定（フォールバック）

方式A で「サーバーに接続できません」エラーが出る場合、Claude Desktop から `npx` コマンドが見つけられていない可能性があります。その場合は `npx` の絶対パスを指定してください。

まずターミナルで自分の環境の `npx` パスを確認します。

```bash
which npx
```

出力例と対応するインストール方法:

| `which npx` の出力 | インストール方法 |
| --- | --- |
| `/opt/homebrew/bin/npx` | Homebrew（Apple Silicon Mac） |
| `/usr/local/bin/npx` | Homebrew（Intel Mac）または公式インストーラ |
| `/Users/XXX/.nvm/versions/node/vXX.XX.X/bin/npx` | nvm |
| `/Users/XXX/.volta/bin/npx` | volta |

`which npx` の結果を `command` に指定します。

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

{% hint style="warning" %}
**nvm / volta ユーザーへの注意**: この方式では Node.js をバージョンアップするたびに `command` のパスを書き換える必要があります（例: `v24.0.0` → `v24.1.0`）。アップデート後は `which npx` を再確認してください。
{% endhint %}

## Windows の場合

Windows でも方式A の `npx` 経由がそのまま使えます。

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

`npx` が見つからない場合は `where npx`（Windows 版の `which`）で絶対パスを確認して指定してください。

## 表示名のカスタマイズ

Claude Desktop の UI に表示される名前は `mcpServers` 配下のキー名で決まります。`bitbank-lab-mcp` のような **ASCII（英数字）の名前を推奨**します。

```json
{
  "mcpServers": {
    "bitbank-lab-mcp": {
      "command": "npx",
      "args": ["-y", "bitbank-lab-mcp"]
    }
  }
}
```

{% hint style="warning" %}
環境によって、日本語などの非 ASCII 名だと Chat でツールが見つからない事例があります。サーバーは正常に起動しているのにツールが呼ばれない場合は、キー名を ASCII 名に変更してみてください。
{% endhint %}

## 設定後の注意

* 追加後、Claude Desktop を `Cmd+Q`（Windows は完全終了）で再起動してください。
* 動作確認の手順は [クイックスタート](quickstart.md) の「動作確認」を参照してください。
* うまく動かない場合は [トラブルシューティング](troubleshooting.md) を参照してください。
