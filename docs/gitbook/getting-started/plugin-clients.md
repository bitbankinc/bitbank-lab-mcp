---
description: Claude Code / Cursor / Codex / Gemini CLI に Plugin として導入する手順
---

# Plugin 導入（Claude Code / Cursor / Codex / Gemini CLI）

これらのクライアントには plugin manifest（`.claude-plugin/plugin.json` ほか3種）を同梱しています。各クライアントの `/plugin install`（または相当のコマンド）でこのリポジトリを指定するだけでセットアップが完了します。

## クライアントごとの API キーの渡し方

**API キー入力 UI を備えているのは Claude Code と Gemini CLI のみ** です。Cursor / Codex はシェル環境変数で API キーを渡します。

| クライアント | manifest | API キーの渡し方 |
| --- | --- | --- |
| Claude Code | `.claude-plugin/plugin.json` | ✅ **GUI で入力**: `/plugin install` 直後に `userConfig` UI が表示され、OS キーチェーンに保管 |
| Gemini CLI | `gemini-extension.json` | ✅ **対話 prompt**: `settings` 配列で対話的に入力、`.env` に保管 |
| Cursor | `.cursor-plugin/plugin.json` | ⚙️ **シェル環境変数のみ**: `BITBANK_API_KEY` / `BITBANK_API_SECRET` を環境変数に設定 |
| Codex | `.codex-plugin/plugin.json` | ⚙️ **シェル環境変数のみ**: `BITBANK_API_KEY` / `BITBANK_API_SECRET` を環境変数に設定 |

{% hint style="info" %}
いずれの manifest も npm registry の [`bitbank-lab-mcp`](https://www.npmjs.com/package/bitbank-lab-mcp) を `npx -y` 経由で起動します。
{% endhint %}

## Claude Code の例

```bash
# 1. このリポジトリを marketplace として登録（初回のみ）
/plugin marketplace add bitbankinc/bitbank-lab-mcp

# 2. plugin を install
/plugin install bitbank-lab-mcp@bitbank-lab

# 3. plugin を有効化
/reload-plugins
```

`bitbank-lab` はこのリポジトリが提供する marketplace 名（`.claude-plugin/marketplace.json` の `name` フィールド）、`bitbank-lab-mcp` は plugin 名です。

実行後、bitbank API key / API secret の入力 UI が表示されます。**Public ツールだけで使う場合は両方とも空欄で OK** — Private ツールは API キーを入力したときだけ自動的に有効化されます。

{% hint style="info" %}
API キーを後から追加・変更したい場合は `/plugin` から該当 plugin の設定を開き、`api_key` / `api_secret` を更新してください。Claude Code では `sensitive: true` のため OS のキーチェーンに保管されます。
{% endhint %}

## Cursor / Codex の場合（環境変数経由）

`/plugin install` 実行後、シェルで以下のように環境変数を設定してから Cursor / Codex を起動してください（Public ツールだけ使う場合は不要）。

```bash
export BITBANK_API_KEY="your_api_key"
export BITBANK_API_SECRET="your_api_secret"
```

macOS / Linux では `~/.zshrc` や `~/.bashrc` に書いておくと永続化されます。Windows は環境変数の管理画面または `setx` を使用してください。

## 関連ページ

* API キーの発行・権限の選び方 → [Private API（取引機能）](../private-api/setup.md)
* 手動で `.json` を編集する方式 → [その他のクライアント](other-clients.md)
