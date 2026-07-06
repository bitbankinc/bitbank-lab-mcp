---
description: Private API で使える16ツールと、対応する注文タイプ・信用取引
---

# ツールと注文タイプ

API キー設定時に有効化される **16 の Private ツール** と、発注で使える注文タイプを説明します。

## 参照系（「参照」権限のみで使える、副作用なし）

| ツール | 説明 |
| --- | --- |
| `get_my_assets` | 保有資産一覧（JPY 評価額付き） |
| `get_my_trade_history` | 約定履歴（全ペア or 指定ペア。maker/taker・手数料付き） |
| `get_my_orders` | 注文一覧（アクティブ注文） |
| `get_order` | 注文照会（単一、`order_id` 指定） |
| `get_orders_info` | 注文照会（複数、`order_id` 配列指定） |
| `analyze_my_portfolio` | ポートフォリオ損益分析（評価損益・実現損益・口座リターン） |
| `get_my_deposit_withdrawal` | 入出金・入出庫履歴（自動ページング、最大1000件） |
| `get_margin_status` | 信用取引ステータス（保証金・ロスカット率・新規建て可能額） |
| `get_margin_positions` | 信用建玉一覧（追証・不足金アラート付き） |
| `get_margin_trade_history` | 信用約定履歴（新規建て・決済、実現損益・利息を含む） |

## 取引系（「取引」権限が必要、2ステップ確認必須）

すべて **preview → execute の2ステップ確認** が必須です（[取引の安全設計](safety.md) 参照）。

| ステップ1（Preview） | ステップ2（Execute） | 説明 |
| --- | --- | --- |
| `preview_order` | `create_order` | 注文の発注（現物・信用） |
| `preview_cancel_order` | `cancel_order` | 注文キャンセル（単一） |
| `preview_cancel_orders` | `cancel_orders` | 注文キャンセル（一括、最大30件） |

## 対応注文タイプ

`preview_order` / `create_order` で発注できる `type` は以下の4種類です。

| `type` | 説明 | 必須パラメータ |
| --- | --- | --- |
| `limit` | 指値注文 | `price` |
| `market` | 成行注文 | （なし） |
| `stop` | 逆指値注文（トリガー到達で成行発注） | `trigger_price` |
| `stop_limit` | 逆指値指値注文（トリガー到達で指値発注） | `trigger_price`, `price` |

{% hint style="info" %}
bitbank 公式 API は `take_profit` / `stop_loss` / `losscut` も列挙していますが、本 MCP サーバーでは **意図的に未対応** です（動作仕様が未定義、または利用者が入力する注文タイプではないため）。これらを指定するとバリデーションエラーで拒否されます。既存のこれらの注文を**照会**することは `get_order` 等で可能です。
{% endhint %}

## 信用取引について

`preview_order` / `create_order` に `position_side`（`long` / `short`）を指定すると信用注文として扱われます。

| 操作 | side | position_side |
| --- | --- | --- |
| ロング新規建て | `buy` | `long` |
| ロング決済 | `sell` | `long` |
| ショート新規建て | `sell` | `short` |
| ショート決済 | `buy` | `short` |

{% hint style="warning" %}
**信用取引の注意事項**

* bitbank での申込・審査が必要です（未審査の場合はエラーになります）。
* 損失が保証金を超える可能性があります。
* 利息・手数料は決済時に徴収されます。
* 建玉管理は平均法（加重平均）で行われます。
{% endhint %}

## 手数料の考え方（概要）

手数料は **見積り（estimate）** と **実績（actual）** でソースが異なります。

* **見積り**: `preview_order` が `/spot/pairs` のレートから算出します（信用は新規/決済を判定して対応レートを使用、利息は見積りに含めません）。
* **実績**: `get_my_trade_history` / `analyze_my_portfolio` 等が約定履歴の実額（手数料・利息を別建て）で計上します。

{% hint style="info" %}
手数料の詳細（3カテゴリの分類、信用レート未提供時の概算など）は GitHub の [docs/private-api.md](https://github.com/bitbankinc/bitbank-lab-mcp/blob/main/docs/private-api.md) を参照してください。
{% endhint %}
