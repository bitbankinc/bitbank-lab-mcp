# bitbank Private REST API フィールド一覧（社内一次ソース）

bitbank REST API（主に Private `/v1/user/*`、手数料率源の public `/v1/spot/pairs` を含む）
レスポンスの実フィールドを、**公式 docs を ground truth** として逐語ミラーし、コード（Raw 型・
Zod スキーマ・フィクスチャ）との P4「外部 API 契約整合」照合をネット無し・要約無し・確定判定で
回せるようにする社内一次ソース。

## なぜこの doc が必要か

- サンドボックスからは `api.bitbank.cc` / `api.github.com`（公式 docs）が **ネットワーク allowlist
  外 or rate limit** で、P4「外部 API 契約整合」診断を verbatim 実行できない。本ミラーがあれば診断を
  オフラインで完結でき、結果が「要追加確認」に落ちない。
- 過去に `get_margin_status` が実在しないフィールド（`losscut_rate` 等）を参照し、本番で
  `undefined%` / `NaN円` を出すバグがあった。ユニットテストはフィクスチャがコードに合わせて
  作られていたため緑だった（自己整合テスト）。**フィールド一覧をコードと独立した一次ソースに
  固定**することで、この種のドリフトを照合で検知できるようにする。
- ただしミラーは古くなる＝放置すると「自己整合だが実 API と乖離した偽の ground truth」になり、
  上記 `get_margin_status` バグと同型の罠になる。よって **鮮度管理（lock.json + ドリフト検知 CI）を
  同梱**し、`live > ミラー` の優先順位を常に明示する。

> 暦日・タイムゾーン仕様（Public `/candlestick`）の一次ソースは姉妹 doc
> [`bitbank-candle-tz.md`](./bitbank-candle-tz.md) を参照。

## 出典・鮮度

| 項目 | 値 |
|---|---|
| source | `bitbankinc/bitbank-api-docs`（`rest-api_JP.md` / `rest-api.md`） |
| upstream commit | `71980979d7da6c0fc591d5031d54e4469a8ede2f`（両ファイル共通・取得時点の per-file 最新コミット） |
| 取得日 | 2026-06-08 (JST) |
| 取得方法 | ローカル取得。本文は `raw.githubusercontent.com/.../master/rest-api_JP.md`、commit SHA は `git clone --filter=blob:none` 後の per-file `git log -1 --format=%H -- <file>`（= API `commits?path=` と同値）。サンドボックスから `api.github.com` は rate limit のため git/raw 経由 |
| 機械可読 lock | [`bitbank-api-docs.lock.json`](./bitbank-api-docs.lock.json)（ドリフト検知 CI が参照） |
| 照合方法 | P4「外部 API 契約整合」診断（docs のフィールド/パラメータを実コードへ逐語照合） |
| 対象コード | `src/private/schemas.ts`（Zod 単一ソース）, `src/handlers/portfolio/types.ts`（Raw 型）, `tools/private/*.ts` |

確度の凡例: **verbatim** = 公式 docs の Name/Type 表と JSON 例の両方を逐語確認 / **table-verbatim** =
Name/Type 表のみ逐語確認（JSON 例なし）/ **params-verbatim** = パラメータ表のみ逐語確認。

> **行番号は locked commit（`71980979…`）時点の `rest-api_JP.md` に対応する。** docs 改訂で行は動くため、
> スナップショットの正は SHA。行番号がズレたら本ミラーが古い兆候 → 鮮度ゲート / CI を参照。
> 英語版 `rest-api.md` も同一 SHA で相互確認できる（lock の 2 ファイルは同コミット）。

## ミラー鮮度ゲート（P4 プロンプト前置きに追記する文言）

> P4「外部 API 契約整合」プロンプトは別途共有のメンテプロンプト一式に含まれ、本リポジトリ外にある。
> その**前置きに以下のブロックをそのまま貼る**。診断側に fetch は持たせない（鮮度維持はネットのある
> CI、診断はオフラインのミラー、と分離する）。

```text
【ミラー鮮度ゲート】docs/internal/bitbank-api-docs.lock.json の commit / fetched_at を冒頭で確認する。
- オフライン時: ミラー（docs/internal/bitbank-api-fields.md）で判定してよいが、全指摘に
  「ミラー基準日 YYYY-MM-DD」を必ず付す（live を騙らない）。
- ネット利用可 or CI: upstream 該当ファイルの最新コミットと照合。差分あり →
  「⚠️ ミラー要更新（lock <old> → upstream <new>）」を冒頭に出し、
  該当エンドポイントの判定を「確定」から「要追加確認」へ降格する。
（ground truth の優先順位は live > ミラー。ミラーは常に snapshot として扱い、live を名乗らせない。）
```

現在の基準日は **2026-06-08**（lock 参照）。upstream との照合は週次の
[`bitbank-api-docs-drift.yml`](../../.github/workflows/bitbank-api-docs-drift.yml) が自動実行し、
drift 時に「ミラー要更新」issue を起票する。

---

## `/v1/user/assets`（資産情報）

確度: **verbatim**（表 `:197-209` / JSON `:232-280`）。パラメータ無し。
`assets[]` の各要素。**暗号資産と `jpy` で `withdrawal_fee` の構造が異なり、`jpy` は `network_list` を持たない。**

| フィールド | 型 | 単位/備考 | docs 行 |
|---|---|---|---|
| `asset` | string | 通貨コード | `:199` |
| `free_amount` | string | 利用可能な量 | `:200` |
| `amount_precision` | number | 精度 | `:201` |
| `onhand_amount` | string | 保有量（評価額計算はこれ × ticker） | `:202` |
| `locked_amount` | string | ロックされている量 | `:203` |
| `withdrawing_amount` | string | ロック中のうち出金処理中の数量 | `:204` |
| `withdrawal_fee` | `{min,max}`（暗号資産）<br>`{under,over,threshold}`（`jpy`） | 出金手数料。**手数料カテゴリ C: パススルー**（`lib/fees.ts` を通さない） | `:205` |
| `stop_deposit` | boolean | 入金停止フラグ（全ネットワーク = `true`） | `:206` |
| `stop_withdrawal` | boolean | 出金停止フラグ（全ネットワーク = `true`） | `:207` |
| `network_list` | `Array<{asset, network, stop_deposit, stop_withdrawal, withdrawal_fee:string}>` または undefined | ネットワーク別の入出金設定。**`jpy` では undefined（フィールド自体が無い）** | `:208` |
| `collateral_ratio` | string | 代用掛け目（信用取引の担保評価率） | `:209` |

### 公式 JSON 例（verbatim, `:232-280`）

```json
{
  "success": 1,
  "data": {
    "assets": [
      {
        "asset": "string",
        "free_amount": "string",
        "amount_precision": 0,
        "onhand_amount": "string",
        "locked_amount": "string",
        "withdrawing_amount": "string",
        "withdrawal_fee": { "min": "string", "max": "string" },
        "stop_deposit": false,
        "stop_withdrawal": false,
        "network_list": [
          {
            "asset": "string",
            "network": "string",
            "stop_deposit": false,
            "stop_withdrawal": false,
            "withdrawal_fee": "string"
          }
        ],
        "collateral_ratio": "string"
      },
      {
        "asset": "jpy",
        "free_amount": "string",
        "amount_precision": 0,
        "onhand_amount": "string",
        "locked_amount": "string",
        "withdrawing_amount": "string",
        "withdrawal_fee": { "under": "string", "over": "string", "threshold": "string" },
        "stop_deposit": false,
        "stop_withdrawal": false,
        "collateral_ratio": "string"
      }
    ]
  }
}
```

### コード対応

- Raw 型（単一ソース）: `src/handlers/portfolio/types.ts` `RawAsset`
  （`tools/private/get_my_assets.ts` と `analyzeMyPortfolioHandler.ts` が共有）
- 出力スキーマ: `src/private/schemas.ts` `GetMyAssetsDataSchema` / `AssetItemSchema`
- フィクスチャ: `tests/fixtures/private-api.ts` `rawAssetsResponse`
- 出力には `asset` / `amount` / `available_amount` / `locked_amount` / `jpy_value` / `allocation_pct` のみを露出
  （評価額は `onhand_amount` × ticker で算出済み）。`withdrawing_amount` / `network_list` / `collateral_ratio`
  は Raw 型・フィクスチャでは保持するが出力には含めない。信用担保評価のユースケースが生じた場合は
  `collateral_ratio` を `GetMyAssetsOutputSchema` に追加して露出する。

---

## `/v1/user/spot/order`（注文情報・単一）

確度: **verbatim**（表 `:300-318` / JSON `:346-369`）。パラメータ `pair`(YES) / `order_id`(YES)（`:293-296`）。

| フィールド | 型 | 備考 | docs 行 |
|---|---|---|---|
| `order_id` | number | order id | `:302` |
| `pair` | string | 通貨ペア | `:303` |
| `side` | string | `buy` / `sell` | `:304` |
| `position_side` | string \| undefined | `long` / `short`（信用のみ） | `:305` |
| `type` | string | `limit` / `market` / `stop` / `stop_limit` / `take_profit` / `stop_loss` / `losscut` | `:306` |
| `start_amount` | string \| null | 注文時の数量 | `:307` |
| `remaining_amount` | string \| null | 未約定の数量 | `:308` |
| `executed_amount` | string | 約定済み数量 | `:309` |
| `price` | string \| undefined | 注文価格（`limit` / `stop_limit` 時のみ） | `:310` |
| `post_only` | boolean \| undefined | Post Only か（`limit` 時のみ） | `:311` |
| `user_cancelable` | boolean | ユーザがキャンセル可能か | `:312` |
| `average_price` | string | 平均約定価格 | `:313` |
| `ordered_at` | number | 注文日時（UnixTime ミリ秒） | `:314` |
| `expire_at` | number \| null | 有効期限（UnixTime ミリ秒） | `:315` |
| `triggered_at` | number \| undefined | トリガー日時（`stop` / `stop_limit` / `take_profit` / `stop_loss` 時のみ） | `:316` |
| `trigger_price` | string \| undefined | トリガー価格（同上） | `:317` |
| `status` | string | `INACTIVE` / `UNFILLED` / `PARTIALLY_FILLED` / `FULLY_FILLED` / `CANCELED_UNFILLED` / `CANCELED_PARTIALLY_FILLED` | `:318` |

> **⚠️ doc-vs-code 差分（要 live 確認）: `canceled_at` は docs（`71980979`）の表にも JSON 例にも無い。**
> しかしコードは `src/private/schemas.ts:716` `GetOrderDataSchema` に `canceled_at: z.number().optional()`
> を持ち、`tools/private/get_order.ts` / `cancel_order.ts` が参照する。キャンセル済注文照会で live が返す
> 可能性が高い（過去診断で schema 追加）。**コードの誤りとは断定せず「docs 未記載・live 要確認」として扱う**。
> live で確認できしだい本表に追記する。`active_orders` のオブジェクトには `canceled_at` は無い（アクティブ
> 注文のみ返るため）。

### 公式 JSON 例（verbatim, `:346-369`）

```json
{
  "success": 1,
  "data": {
    "order_id": 0,
    "pair": "string",
    "side": "string",
    "position_side": "string",
    "type": "string",
    "start_amount": "string",
    "remaining_amount": "string",
    "executed_amount": "string",
    "price": "string",
    "post_only": false,
    "user_cancelable": true,
    "average_price": "string",
    "ordered_at": 0,
    "expire_at": 0,
    "triggered_at": 0,
    "trigger_price": "string",
    "status": "string"
  }
}
```

コード対応: `src/private/schemas.ts` `GetOrderDataSchema`（`:997` 付近、`canceled_at` を含む）、
`tools/private/get_order.ts`。

## `/v1/user/spot/active_orders`（アクティブ注文）

確度: **verbatim**（表 `:690-692` / JSON `:715-742`）。パラメータ `pair` / `count` / `from_id` / `end_id` /
`since` / `end`（全 NO、`:679-686`）。レスポンス表は `orders | Array | [注文情報を取得する]のレスポンス
オブジェクトのリスト`（`:692`）＝ **`orders[]` の各要素は上記 `/v1/user/spot/order` のオブジェクトと同一**。

### 公式 JSON 例（verbatim, `:715-742`）

```json
{
  "success": 1,
  "data": {
    "orders": [
      {
        "order_id": 0,
        "pair": "string",
        "side": "string",
        "position_side": "string",
        "type": "string",
        "start_amount": "string",
        "remaining_amount": "string",
        "executed_amount": "string",
        "price": "string",
        "post_only": false,
        "user_cancelable": true,
        "average_price": "string",
        "ordered_at": 0,
        "expire_at": 0,
        "triggered_at": 0,
        "trigger_price": "string",
        "status": "string"
      }
    ]
  }
}
```

コード対応: `src/private/schemas.ts`（active_orders 注文オブジェクト `:141` 付近、`canceled_at` は持たない）、
`tools/private/get_active_orders.ts`。

## `/v1/user/margin/status`（信用取引ステータス）

確度: **verbatim**（表 `:757-785` / JSON `:807-838`）。パラメータ無し。

| フィールド | 型 | 単位/備考 | docs 行 |
|---|---|---|---|
| `status` | string | `NORMAL` 正常 / `LOSSCUT` 強制決済中 / `CALL` 追証発生中 / `DEBT` 不足金発生中 / `SETTLED` 債権売却済。未申込時も `NORMAL` | `:759` |
| `total_margin_balance_percentage` | string \| null | 保証金率%（切り捨て2桁）。建玉無=`null` | `:760` |
| `total_margin_balance` | string | 受入保証金合計額（切り捨て4桁） | `:761` |
| `margin_position_profit_loss` | string | 評価損益（-∞方向丸め4桁） | `:762` |
| `unrealized_cost` | string | 未収費用（+∞方向丸め4桁） | `:763` |
| `total_margin_position_product` | string | 建玉合計（切り捨て4桁） | `:764` |
| `open_margin_position_product` | string | 建玉の保有分 | `:765` |
| `open_margin_order_product` | string | 建玉の新規発注中 | `:766` |
| `total_position_maintenance_margin` | string | 維持必要保証金額（切り上げ4桁） | `:767` |
| `total_long_position_maintenance_margin` | string | 同・ロング分 | `:768` |
| `total_short_position_maintenance_margin` | string | 同・ショート分 | `:769` |
| `total_open_order_maintenance_margin` | string | 約定時必要保証金額（切り上げ4桁） | `:770` |
| `total_long_open_order_maintenance_margin` | string | 同・ロング分 | `:771` |
| `total_short_open_order_maintenance_margin` | string | 同・ショート分 | `:772` |
| `margin_call_percentage` | string \| null | 追加保証金率%（切り上げ0桁）。建玉無=`null` | `:773` |
| `losscut_percentage` | string \| null | 強制決済率%（切り上げ0桁）。建玉無=`null` | `:774` |
| `buy_credit` | string | 買いのご利用可能枠 | `:775` |
| `sell_credit` | string | 売りのご利用可能枠 | `:776` |
| `available_balances` | `{pair:string, long:string, short:string}[]` | 新規建てご利用可能額（`long`/`short` は切り捨て4桁） | `:777-785` |

> **`losscut_rate` 等の幻フィールドは docs にも live にも存在しない**（過去バグの再発防止チェックポイント）。
> 強制決済率は `losscut_percentage`、保証金率は `total_margin_balance_percentage`。
> `*_percentage` 系は建玉なし時に `null`（schema は `.nullable()`）。

### 公式 JSON 例（verbatim, `:807-838`）

```json
{
  "success": 1,
  "data": {
    "status": "NORMAL",
    "total_margin_balance_percentage": null,
    "total_margin_balance": "0.0000",
    "margin_position_profit_loss": "0.0000",
    "unrealized_cost": "0.0000",
    "total_margin_position_product": "0.0000",
    "open_margin_position_product": "0.0000",
    "open_margin_order_product": "0.0000",
    "total_position_maintenance_margin": "0.0000",
    "total_long_position_maintenance_margin": "0.0000",
    "total_short_position_maintenance_margin": "0.0000",
    "total_open_order_maintenance_margin": "0.0000",
    "total_long_open_order_maintenance_margin": "0.0000",
    "total_short_open_order_maintenance_margin": "0.0000",
    "margin_call_percentage": null,
    "losscut_percentage": null,
    "buy_credit": "0",
    "sell_credit": "0",
    "available_balances": [
      { "pair": "btc_jpy", "long": "0.0000", "short": "0.0000" }
    ]
  }
}
```

コード対応: `src/private/schemas.ts` `GetMarginStatusDataSchema`（逐語一致確認済）。

## `/v1/user/margin/positions`（建玉・追証・不足金額情報）

確度: **verbatim**（表 `:851-856` / JSON `:879-909`）。パラメータ無し。

| フィールド | 型 | 備考 | docs 行 |
|---|---|---|---|
| `notice` | `{what:string\|null, occurred_at:number\|null, amount:string\|null, due_date_at:number\|null}` | `追証` / `不足金` / `精算` に関する情報（内側フィールドが nullable） | `:853` |
| `payables` | `{amount:string}` | 不足金額 | `:854` |
| `positions` | `[{pair, position_side, open_amount, product, average_price, unrealized_fee_amount, unrealized_interest_amount}]`（各 string） | 建玉情報 | `:855` |
| `losscut_threshold` | `{individual:string, company:string}` | 強制決済掛け目 | `:856` |

### 公式 JSON 例（verbatim, `:879-909`）

```json
{
  "success": 1,
  "data": {
    "notice": {
      "what": "string",
      "occurred_at": 0,
      "amount": "0",
      "due_date_at": 0
    },
    "payables": { "amount": "0" },
    "positions": [
      {
        "pair": "string",
        "position_side": "string",
        "open_amount": "0",
        "product": "0",
        "average_price": "0",
        "unrealized_fee_amount": "0",
        "unrealized_interest_amount": "0"
      }
    ],
    "losscut_threshold": { "individual": "0", "company": "0" }
  }
}
```

コード対応: `src/private/schemas.ts` `GetMarginPositionsDataSchema`。`notice` 全体を `null` 許容として
扱うコードは docs の「内側 nullable」より緩い（建玉ゼロ時の挙動は live 要確認）。

## `/v1/user/spot/trade_history`（約定履歴）

確度: **verbatim**（表 `:933-949` / JSON `:972-996`）。パラメータ `pair` / `count`(≤1000) / `order_id` /
`since`(ms) / `end`(ms) / `order`(`asc`/`desc`、既定 `desc`)（`:922-929`）。

| フィールド | 型 | 備考 | docs 行 |
|---|---|---|---|
| `trade_id` | number | trade id | `:935` |
| `pair` | string | 通貨ペア | `:936` |
| `order_id` | number | 注文ID | `:937` |
| `side` | string | `buy` / `sell` | `:938` |
| `position_side` | string \| undefined | `long` / `short`（信用のみ） | `:939` |
| `type` | string | `limit` / `market` / `stop` / `stop_limit` / `take_profit` / `stop_loss` / `losscut` | `:940` |
| `amount` | string | 注文量 | `:941` |
| `price` | string | 価格 | `:942` |
| `maker_taker` | string | `maker` / `taker` | `:943` |
| `fee_amount_base` | string | base 手数料 | `:944` |
| `fee_amount_quote` | string | quote 手数料 | `:945` |
| `fee_occurred_amount_quote` | string | quote 発生手数料。後ほど徴収される。**現物取引では `fee_amount_quote` と同値** | `:946` |
| `profit_loss` | string \| undefined | 実現損益 | `:947` |
| `interest` | string \| undefined | 利息 | `:948` |
| `executed_at` | number | 約定日時（UnixTime ミリ秒） | `:949` |

> **doc 内不整合（記録）: `fee_occurred_amount_quote` は Name/Type 表（`:946`）には在るが JSON 例
> （`:972-996`）には無い。** コードは正しく表に従い `fee_occurred_amount_quote` を採用する
> （`src/private/schemas.ts:83`, `src/handlers/portfolio/types.ts:56,73`, `calc.ts:301`）。
> 実績の手数料・利息はここ（`fee_occurred_amount_quote` + `interest`）が正。見積りは `lib/fees.ts`。

### 公式 JSON 例（verbatim, `:972-996`。`fee_occurred_amount_quote` は表のみで JSON 例には未掲載）

```json
{
  "success": 1,
  "data": {
    "trades": [
      {
        "trade_id": 0,
        "pair": "string",
        "order_id": 0,
        "side": "string",
        "position_side": "string",
        "type": "string",
        "amount": "string",
        "price": "string",
        "maker_taker": "string",
        "fee_amount_base": "string",
        "fee_amount_quote": "string",
        "profit_loss": "string",
        "interest": "string",
        "executed_at": 0
      }
    ]
  }
}
```

コード対応: `GetMyTradeHistoryDataSchema` / `RawTrade` / `RawMarginTrade`。現物約定では `position_side` /
`profit_loss` / `interest` は通常 undefined。

## `/v1/user/deposit_history`（入金履歴）

確度: **verbatim**（表 `:1017-1027` / JSON `:1056-1073`）。パラメータ `asset` / `count`(≤100) /
`since`(ms) / `end`(ms)（`:1008-1013`）。

| フィールド | 型 | 備考 | docs 行 |
|---|---|---|---|
| `uuid` | string | 入金識別 uuid | `:1019` |
| `address` | string | 入金 address（暗号資産入金のみ）。**公式は表のみ・JSON 例には未掲載**だが live 確認済み（2026-06-08, `deposits[]` キーに `address` あり / jpy 入金は無し） | `:1020` |
| `asset` | string | アセット名 | `:1021` |
| `network` | string | ネットワーク名 | `:1022` |
| `amount` | number（表）/ "string"（JSON 例） | 入金数量。**表は `number`・JSON 例は `"string"` で不一致（記録）** | `:1023` |
| `txid` | string \| null | 入金トランザクションID（暗号資産のみ） | `:1024` |
| `status` | string | `FOUND` / `CONFIRMED` / `DONE` | `:1025` |
| `found_at` | number | 検知 UnixTime（ミリ秒） | `:1026` |
| `confirmed_at` | number | 承認 UnixTime（ミリ秒、承認後のみ存在） | `:1027` |

> 注意事項（`:1033`）: 入金履歴レスポンスには宛先タグ・メモおよび銀行口座情報は含まれない。
> 他システムとの突合には `txid` を使う。

### 公式 JSON 例（verbatim, `:1056-1073`）

```json
{
  "success": 1,
  "data": {
    "deposits": [
      {
        "uuid": "string",
        "asset": "string",
        "network": "string",
        "amount": "string",
        "txid": "string",
        "status": "string",
        "found_at": 0,
        "confirmed_at": 0
      }
    ]
  }
}
```

コード対応: `GetMyDepositWithdrawalDataSchema` / `tools/private/get_my_deposit_withdrawal.ts`。

## `/v1/user/withdrawal_history`（出金履歴）

確度: **verbatim**（表 `:1504-1522` / JSON `:1550-1580`）。パラメータ `asset` / `count`(≤100) /
`since`(ms) / `end`(ms)（`:1495-1500`）。

| フィールド | 型 | 備考 | docs 行 |
|---|---|---|---|
| `uuid` | string | 出金識別ID | `:1506` |
| `asset` | string | アセット名 | `:1507` |
| `account_uuid` | string | 出金アカウントのID **（機密・出力除外）** | `:1508` |
| `amount` | string | 出金数量 | `:1509` |
| `fee` | string | 出金手数料（**カテゴリ C: パススルー**） | `:1510` |
| `label` | string | 出金先アドレスのラベル（暗号資産のみ） | `:1511` |
| `address` | string | 出金先アドレス（暗号資産のみ） | `:1512` |
| `network` | string | ネットワーク名（暗号資産のみ） | `:1513` |
| `destination_tag` | number or string | 宛先タグ/メモ（タグ/メモ指定の暗号資産出金時のみ） | `:1514` |
| `txid` | string \| null | 出金トランザクションID（暗号資産のみ） | `:1515` |
| `bank_name` | string | 出金先銀行（法定通貨のみ） | `:1516` |
| `branch_name` | string | 出金先銀行支店（法定通貨のみ）**（機密・出力除外）** | `:1517` |
| `account_type` | string | 出金先口座種別（法定通貨のみ）**（機密・出力除外）** | `:1518` |
| `account_number` | string | 出金先口座番号（法定通貨のみ）**（機密・出力除外）** | `:1519` |
| `account_owner` | string | 出金先口座名義（法定通貨のみ）**（機密・出力除外）** | `:1520` |
| `status` | string | `CONFIRMING` / `EXAMINING` / `SENDING` / `DONE` / `REJECTED` / `CANCELED` / `CONFIRM_TIMEOUT` | `:1521` |
| `requested_at` | number | リクエスト日時 UnixTime（ミリ秒） | `:1522` |

### 公式 JSON 例（verbatim, `:1550-1580`）

```json
{
  "success": 1,
  "data": {
    "withdrawals": [
      {
        "uuid": "string",
        "asset": "string",
        "account_uuid": "string",
        "amount": "string",
        "fee": "string",
        "label": "string",
        "address": "string",
        "network": "string",
        "txid": "string",
        "destination_tag": 0,
        "bank_name": "string",
        "branch_name": "string",
        "account_type": "string",
        "account_number": "string",
        "account_owner": "string",
        "status": "string",
        "requested_at": 0
      }
    ]
  }
}
```

コード対応: `GetMyDepositWithdrawalDataSchema` / `tools/private/get_my_deposit_withdrawal.ts`
（`destination_tag?: number | string | null` を保持。`account_*` / `branch_name` は出力除外）。
機密フィールドの扱いは下記「機密フィールドの取り扱い」を参照。

---

## `/v1/spot/pairs`（銘柄詳細・public・手数料率の源）

確度: **verbatim**（表 `:1649-1687` / JSON `:1705-1751`）。**認証不要**・パラメータ無し。
**手数料 taxonomy（`.claude/rules/fees.md`）の見積りソース**: 取引手数料（A）と信用手数料（B）の率は
すべてここから解決する（`lib/fees.ts` 経由必須。`||` 禁止・`??` 必須・クランプ禁止）。

| フィールド | 型 | 単位/備考（fees taxonomy） | docs 行 |
|---|---|---|---|
| `name` | string | 通貨ペア | `:1651` |
| `base_asset` | string | 原資産 | `:1652` |
| `quote_asset` | string | クオート資産（**表のみ。JSON 例には未掲載**） | `:1653` |
| `maker_fee_rate_base` | string | メイカー手数料率(原資産) | `:1654` |
| `taker_fee_rate_base` | string | テイカー手数料率(原資産) | `:1655` |
| `maker_fee_rate_quote` | string | メイカー手数料率(クオート資産)。**A: maker 見積り源** | `:1656` |
| `taker_fee_rate_quote` | string | テイカー手数料率(クオート資産)。**A: taker 見積り源** | `:1657` |
| `margin_open_maker_fee_rate_quote` | string \| null | 新規建て maker 手数料率。**B: open/maker** | `:1658` |
| `margin_open_taker_fee_rate_quote` | string \| null | 新規建て taker 手数料率。**B: open/taker** | `:1659` |
| `margin_close_maker_fee_rate_quote` | string \| null | 決済 maker 手数料率。**B: close/maker** | `:1660` |
| `margin_close_taker_fee_rate_quote` | string \| null | 決済 taker 手数料率。**B: close/taker**（docs の説明文は「決済maker」と誤記だがフィールド名は taker） | `:1661` |
| `margin_long_interest` | string \| null | ロング利息率/日（**見積りでは扱わない**。実績は `trade_history.interest`） | `:1662` |
| `margin_short_interest` | string \| null | ショート利息率/日（同上） | `:1663` |
| `margin_current_individual_ratio` | string \| null | 現在の個人のリスク想定比率 | `:1664` |
| `margin_current_individual_until` | number \| null | 同・適用終了日時（UnixTime ミリ秒） | `:1665` |
| `margin_current_company_ratio` | string \| null | 現在の法人のリスク想定比率 | `:1666` |
| `margin_current_company_until` | number \| null | 同・適用終了日時 | `:1667` |
| `margin_next_individual_ratio` | string \| null | 次の個人のリスク想定比率 | `:1668` |
| `margin_next_individual_until` | number \| null | 同・適用終了日時 | `:1669` |
| `margin_next_company_ratio` | string \| null | 次の法人のリスク想定比率 | `:1670` |
| `margin_next_company_until` | number \| null | 同・適用終了日時 | `:1671` |
| `unit_amount` | string | 最小注文数量 | `:1672` |
| `limit_max_amount` | string | 最大注文数量 | `:1673` |
| `market_max_amount` | string | 成行注文時の最大数量 | `:1674` |
| `market_allowance_rate` | string | 成行買注文時の余裕率 | `:1675` |
| `price_digits` | number | 価格切り捨て対象桁数(0起点) | `:1676` |
| `amount_digits` | number | 数量切り捨て対象桁数(0起点) | `:1677` |
| `is_enabled` | boolean | 通貨ペアステータス(有効/無効) | `:1678` |
| `stop_order` | boolean | 注文停止ステータス | `:1679` |
| `stop_order_and_cancel` | boolean | 注文および注文キャンセル停止 | `:1680` |
| `stop_market_order` | boolean | 成行注文停止 | `:1681` |
| `stop_stop_order` | boolean | 逆指値(成行)注文停止 | `:1682` |
| `stop_stop_limit_order` | boolean | 逆指値(指値)注文停止 | `:1683` |
| `stop_margin_long_order` | boolean | ロング新規建て注文停止 | `:1684` |
| `stop_margin_short_order` | boolean | ショート新規建て注文停止 | `:1685` |
| `stop_buy_order` | boolean | 買い注文停止 | `:1686` |
| `stop_sell_order` | boolean | 売り注文停止 | `:1687` |

> **fees taxonomy 対応**: A=取引手数料 maker/taker は `*_fee_rate_quote`、B=信用は
> `margin_{open,close}_{maker,taker}_fee_rate_quote`。信用率が `null`（API 未提供）の場合は公称 taker
> （`DEFAULT_TAKER_FALLBACK`）で概算し note を付す。利息（`margin_long/short_interest`）は見積りに含めない。
> 詳細は `.claude/rules/fees.md`。
> **doc 内不整合（記録）: `quote_asset` は Name/Type 表（`:1653`）には在るが JSON 例（`:1705-1751`）には無い。**

### 公式 JSON 例（verbatim, `:1705-1751`。`quote_asset` は表のみで JSON 例には未掲載）

```json
{
  "success": 1,
  "data": {
    "pairs": [
      {
        "name": "string",
        "base_asset": "string",
        "maker_fee_rate_base": "string",
        "taker_fee_rate_base": "string",
        "maker_fee_rate_quote": "string",
        "taker_fee_rate_quote": "string",
        "margin_open_maker_fee_rate_quote": "string",
        "margin_open_taker_fee_rate_quote": "string",
        "margin_close_maker_fee_rate_quote": "string",
        "margin_close_taker_fee_rate_quote": "string",
        "margin_long_interest": "string",
        "margin_short_interest": "string",
        "margin_current_individual_ratio": "string",
        "margin_current_individual_until": 0,
        "margin_current_company_ratio": "string",
        "margin_current_company_until": 0,
        "margin_next_individual_ratio": "string",
        "margin_next_individual_until": 0,
        "margin_next_company_ratio": "string",
        "margin_next_company_until": 0,
        "unit_amount": "string",
        "limit_max_amount": "string",
        "market_max_amount": "string",
        "market_allowance_rate": "string",
        "price_digits": 0,
        "amount_digits": 0,
        "is_enabled": true,
        "stop_order": false,
        "stop_order_and_cancel": false,
        "stop_market_order": false,
        "stop_stop_order": false,
        "stop_stop_limit_order": false,
        "stop_margin_long_order": false,
        "stop_margin_short_order": false,
        "stop_buy_order": false,
        "stop_sell_order": false
      }
    ]
  }
}
```

コード対応: 率解決は `lib/fees.ts`（`resolveFeeRate` / `estimateOrderFee` / `feeRole`）。
暦日仕様の `/candlestick` は姉妹 doc [`bitbank-candle-tz.md`](./bitbank-candle-tz.md) を参照。

---

## 機密フィールドの取り扱い（出力から除外必須）

実 API は出金履歴で以下を返すが、**ツール出力に含めてはならない**（`.claude/rules/sensitive-data.md`）。
現状の `get_my_deposit_withdrawal` は出力マッピングに含めず正しく除外している。**回帰させないこと。**

- `account_number`（銀行口座番号）
- `account_owner`（口座名義）
- `branch_name`（支店名）
- `account_type`（口座種別）
- `account_uuid`（出金アカウントID）

`destination_tag` / `txid` / `address` / `bank_name` は HIGH 分類（財務・個人情報）。突合・表示で必要な
範囲のみ出力し、不要なら含めない。`/v1/user/assets` の 3 フィールド（`withdrawing_amount` /
`network_list` / `collateral_ratio`）は**公開資産メタデータであり機密ではない**（上記の禁止フィールドとは
無関係。出力露出可だが、本ミラーでは最小対応として Raw 型・フィクスチャの同期に留める）。

## 関連

- 公式 docs: <https://github.com/bitbankinc/bitbank-api-docs/blob/master/rest-api_JP.md>（英語版 `rest-api.md`）
- 鮮度 lock（CI 参照）: [`bitbank-api-docs.lock.json`](./bitbank-api-docs.lock.json)
- ドリフト検知 CI: [`.github/workflows/bitbank-api-docs-drift.yml`](../../.github/workflows/bitbank-api-docs-drift.yml)
- 姉妹 doc（暦日・TZ 実測）: [`bitbank-candle-tz.md`](./bitbank-candle-tz.md)
- Raw 型: `src/handlers/portfolio/types.ts`
- Zod スキーマ（単一ソース）: `src/private/schemas.ts`
- フィクスチャ: `tests/fixtures/private-api.ts`
- 手数料カテゴリ（A/B 見積り=`lib/fees.ts`, C=パススルー）: `.claude/rules/fees.md`
- 機密情報ポリシー: `.claude/rules/sensitive-data.md`
</content>
</invoke>
