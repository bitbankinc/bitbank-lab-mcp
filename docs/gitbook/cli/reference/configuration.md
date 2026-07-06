---
description: bitbank CLI の設定リファレンス。環境変数、認証情報の保存場所、ペーパートレードの状態ファイル、出力フォーマット、終了コードをまとめます。
---

# 設定・環境変数

## 環境変数

| 変数 | 用途 |
|---|---|
| `BITBANK_API_KEY` | API キー（Private / Trade 用。プロファイル未登録時のフォールバック） |
| `BITBANK_API_SECRET` | API シークレット（同上） |
| `BITBANK_PROFILE` | 使用するプロファイル名（`--profile` フラグの代わり） |
| `XDG_CONFIG_HOME` | `profiles.json` の保存先ベース（未設定時は `~/.bitbank`） |
| `XDG_DATA_HOME` | `paper-state.json` の保存先ベース（未設定時は `~/.bitbank`） |

認証情報の解決順序は `--profile` フラグ → `BITBANK_PROFILE` → default プロファイル → レガシー環境変数の順です。詳しくは [API キーの設定](../getting-started/api-keys.md) を参照してください。

{% hint style="warning" %}
secret は CLI フラグでは渡せません（shell 履歴・`ps` 出力に残るため）。env か対話 hidden 入力のみです。`--api-secret=...` のようなフラグは実装していません。
{% endhint %}

## ファイルの保存場所

| ファイル | 場所 | 内容 |
|---|---|---|
| `profiles.json` | `$XDG_CONFIG_HOME/bitbank/`（未設定時 `~/.bitbank/`） | API キー切替プロファイル。パーミッション **0600** / atomic write |
| `paper-state.json` | `$XDG_DATA_HOME/bitbank/`（未設定時 `~/.bitbank/`） | ペーパートレードの仮想残高・注文・履歴 |

いずれもリポジトリ外（ホームディレクトリ配下）に保存されるため、リポジトリには含まれません。

## 出力フォーマット

| オプション | 説明 |
|---|---|
| `--format=json` | デフォルト。プログラム処理・`jq` 向け |
| `--format=table` | 人が読みやすい整形テーブル |
| `--format=csv` | パイプ・表計算ソフトへのインポート向け |
| `--machine` | `{ success, data, partial?, meta? }` envelope を 1 行で出力（Skill / スクリプト向け） |
| `--raw` | `data` のみを compact 出力（envelope なし。`jq` パイプ向け） |

全出力は LF（`\n`）固定です。CSV も LF 固定で、現代の Excel / LibreOffice / pandas は問題なく解釈できます。

## 終了コード

終了コードは `cli/exit-codes.ts` の `EXIT` 定数で定義されています。

| コード | 名前 | 意味 |
|:-:|---|---|
| 0 | `SUCCESS` | 成功 |
| 1 | `GENERAL` | 一般エラー |
| 2 | `AUTH` | 認証エラー |
| 3 | `RATE_LIMIT` | レートリミット（HTTP 429） |
| 4 | `PARAM` | パラメータエラー |
| 5 | `NETWORK` | ネットワークエラー（`watch` の再接続上限到達など） |

{% hint style="info" %}
Public（認証不要）コマンドが HTTP 403 を受けた場合、原因は鍵ではなく IP / 地域 / ネットワーク制限の可能性が高いため、`AUTH`(2) ではなく `GENERAL`(1) を返します。Private / Trade の 403 は本物の権限失敗として `AUTH`(2) のままです。
{% endhint %}

## 日付キーのタイムゾーン

candlestick で使う `YYYYMMDD` / `YYYY`（`--date` の値）は **UTC 基準**です。たとえば `--type=1hour --date=20260101` は UTC の 2026-01-01 00:00〜23:00 を指します。JST のつもりで指定するとずれるため注意してください。

## API エラーコード

bitbank API が返すエラーコードの分類と再試行指針は、リポジトリの [`agents/error-catalog.json`](https://github.com/bitbankinc/bitbank-lab-cli/blob/main/agents/error-catalog.json) に機械可読な形でまとまっています。「rate_limit はどう待つか」「POST はなぜ自動再送しないか」もここで確認できます。
