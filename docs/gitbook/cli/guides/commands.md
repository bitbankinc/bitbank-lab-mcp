---
description: bitbank CLI の全コマンド一覧。Public・Private・Trade・Paper・WebSocket の各カテゴリを、用途と使用例つきで掲載します。
---

# コマンド一覧

bitbank CLI のコマンドをカテゴリ別にまとめます。`--format=json|table|csv` はすべての取得系コマンドで使えます（デフォルト `json`）。

## Public（認証不要）

マーケットデータを取得するコマンドです。API キーは不要です。

| コマンド | 説明 | 使用例 |
|---|---|---|
| `ticker` | 単一ペアのティッカー | `bitbank ticker btc_jpy` |
| `tickers` | 全ペア一括ティッカー | `bitbank tickers` |
| `tickers-jpy` | 全 JPY ペア一括 | `bitbank tickers-jpy` |
| `depth` | 板情報（asks / bids） | `bitbank depth btc_jpy` |
| `transactions` | 約定履歴 | `bitbank transactions btc_jpy` |
| `candles` | ローソク足 OHLCV | `bitbank candles btc_jpy --type=1day` |
| `circuit-break` | サーキットブレーカー | `bitbank circuit-break btc_jpy` |
| `status` | 取引所ステータス | `bitbank status` |
| `pairs` | ペア設定情報 | `bitbank pairs` |

## Private（要認証）

口座情報を**読み取る**コマンドです。API キーが必要です（[API キーの設定](../getting-started/api-keys.md) を参照）。

| コマンド | 説明 | 使用例 |
|---|---|---|
| `assets` | 保有資産一覧 | `bitbank assets --format=table` |
| `order` | 注文情報照会 | `bitbank order --pair=btc_jpy --order-id=123` |
| `orders-info` | 複数注文照会 | `bitbank orders-info --pair=btc_jpy --order-ids=1,2,3` |
| `active-orders` | アクティブ注文 | `bitbank active-orders --pair=btc_jpy` |
| `trade-history` | 約定履歴（`--all` で全件ページング） | `bitbank trade-history --pair=btc_jpy --all` |
| `deposit-history` | 入金履歴 | `bitbank deposit-history --asset=btc` |
| `unconfirmed-deposits` | 未確認入金 | `bitbank unconfirmed-deposits` |
| `deposit-originators` | 入金元情報 | `bitbank deposit-originators --asset=btc` |
| `withdrawal-accounts` | 出金先一覧 | `bitbank withdrawal-accounts --asset=btc` |
| `withdrawal-history` | 出金履歴 | `bitbank withdrawal-history --asset=btc` |
| `margin-status` | 証拠金ステータス | `bitbank margin-status` |
| `margin-positions` | ポジション情報 | `bitbank margin-positions --pair=btc_jpy` |

{% hint style="info" %}
`trade-history --all`（または `trade-history-all`）は自動でページングします。既定の上限は `--max-pages=1000` で、上限到達時は途中までのデータと `partial: true` / `meta.truncated: true` を返します。
{% endhint %}

## Trade（資金操作 — ドライランがデフォルト）

資金に影響するコマンドです。`bitbank trade <subcommand>` の形で呼び出します（誤爆防止のため public / private とは階層を分けています）。

| コマンド | 説明 | 使用例 |
|---|---|---|
| `trade create-order` | 新規注文 | `bitbank trade create-order --pair=btc_jpy --side=buy --type=limit --price=9000000 --amount=0.001` |
| `trade cancel-order` | 注文キャンセル | `bitbank trade cancel-order --pair=btc_jpy --order-id=123` |
| `trade cancel-orders` | 一括キャンセル | `bitbank trade cancel-orders --pair=btc_jpy --order-ids=1,2,3` |
| `trade confirm-deposits` | 入金確認 | `bitbank trade confirm-deposits --id=456` |
| `trade confirm-deposits-all` | 全入金確認 | `bitbank trade confirm-deposits-all` |

{% hint style="danger" %}
Trade コマンドは `--execute` を付けない限り API を叩きません（ドライラン）。さらに `--execute` 単独でも POST には到達せず、コマンドごとの固定フレーズを `--confirm=<phrase>` で渡す**二段確認**が必須です。詳しくは [取引と安全ガード](trading.md) を必ず読んでください。
{% endhint %}

## Paper（ペーパートレード — 仮想資金）

`bitbank paper <subcommand>` で、ライブ価格 × 仮想資金のシミュレーションを行います。実 API は public ticker のみを叩き、private / trade エンドポイントには一切触れません。状態は `~/.bitbank/paper-state.json`（または `$XDG_DATA_HOME/bitbank/paper-state.json`）に保存されます。

| コマンド | 説明 | 使用例 |
|---|---|---|
| `paper init` | 仮想口座を初期化 | `bitbank paper init --jpy=1000000` |
| `paper assets` | 仮想残高を表示 | `bitbank paper assets` |
| `paper create-order` | 成行 / 指値で発注 | `bitbank paper create-order --pair=btc_jpy --side=buy --type=market --amount=0.001` |
| `paper active-orders` | 未約定の指値一覧 | `bitbank paper active-orders` |
| `paper cancel-order` | 指値を ID 指定でキャンセル | `bitbank paper cancel-order --id=<id>` |
| `paper tick` | 直前 tick 以降の 1m 足で指値 fill を解決 | `bitbank paper tick` |
| `paper trade-history` | 仮想約定履歴 | `bitbank paper trade-history` |
| `paper pnl` | 損益サマリ（realized + unrealized） | `bitbank paper pnl --pair=btc_jpy` |
| `paper reset` | 仮想口座をリセット（`--confirm` 必須） | `bitbank paper reset --confirm` |

詳しい挙動（指値は GTC のみ・部分約定なし・スリッページなし、lazy tick など）は [取引と安全ガード](trading.md) を参照してください。

## Profile（API キー切替）

`bitbank profile <subcommand>` で、複数の API キーを名前付きで管理します。bitbank API 自体は叩きません。

| コマンド | 説明 | 使用例 |
|---|---|---|
| `profile add` | プロファイルを追加 | `bitbank profile add main` |
| `profile list` | 一覧（secret は出ない） | `bitbank profile list` |
| `profile show` | 詳細（secret は `****` マスク） | `bitbank profile show main` |
| `profile set-default` | default を切り替え | `bitbank profile set-default main` |
| `profile remove` | 削除（`--confirm` 必須） | `bitbank profile remove sub --confirm` |

設定の詳細は [API キーの設定](../getting-started/api-keys.md) を参照してください。

## WebSocket（リアルタイム）

```bash
# Public: ティッカー・約定・板のリアルタイム配信
bitbank stream btc_jpy
bitbank stream btc_jpy --channel=transactions

# Private: ユーザーデータのリアルタイム配信（要 profile or env）
bitbank stream --private --pair=btc_jpy

# ライブ価格 watch（ticker を 1 行 JSONL で配信。停止条件・自動再接続つき）
bitbank watch ticker btc_jpy --duration=5 --format=json
bitbank watch ticker btc_jpy --count=10 --format=json
```

`watch` は終了条件（`--duration=<秒>` / `--count=<n>` / `Ctrl-C`）、切断時の指数バックオフ自動再接続、無音検出（`--idle-timeout`）を備えます。長時間動き続けるため、スクリプトや Skill から呼ぶときは必ず `--duration` か `--count` を付けてください。

## 機械可読カタログ

全コマンドのパラメータ（JSON Schema）・出力・安全フラグは、リポジトリの [`agents/tool-catalog.json`](https://github.com/bitbankinc/bitbank-lab-cli/blob/main/agents/tool-catalog.json) に機械可読な形でまとまっています。エラーコードの分類と再試行指針は [`agents/error-catalog.json`](https://github.com/bitbankinc/bitbank-lab-cli/blob/main/agents/error-catalog.json) を参照してください。これらは単一ソースから自動生成される（手書き禁止）ため、CLI を実行せずリポジトリを読むだけで全コマンドと安全フラグを把握できます。
