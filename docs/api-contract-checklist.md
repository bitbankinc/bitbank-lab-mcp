# bitbank API 契約照合チェックリスト

公式 bitbank API ドキュメントと本リポジトリ実装の対応状況を整理する。

- **対象ドキュメント**
  - Public: <https://github.com/bitbankinc/bitbank-api-docs/blob/master/public-api_JP.md>
  - Private REST: <https://github.com/bitbankinc/bitbank-api-docs/blob/master/rest-api.md>
  - エラーコード: <https://github.com/bitbankinc/bitbank-api-docs/blob/master/errors.md>
- **確認時点**: 2026-05-18（`main` = commit `c3d408e` 時点のスナップショット）
- **目的**: 実装変更前のギャップ可視化。本ドキュメントは現状把握用であり、修正は行わない。

## 凡例

| 記号 | 意味 |
|---|---|
| ✅ | 公式仕様どおり実装・検証済み |
| 🟡 | 一部実装または検証不足（TODO に詳細） |
| ❌ | 未実装（意図的に未対応の場合は注記） |
| ➖ | 該当なし |

---

## 1. メタ情報

| 項目 | 公式仕様 | 実装 | 場所 | 状態 |
|---|---|---|---|---|
| Public Base URL | `https://public.bitbank.cc` | `BITBANK_API_BASE` 定数 | `lib/http.ts:2` | ✅ |
| Private Base URL | `https://api.bitbank.cc/v1` | `BitbankPrivateClient.BASE_URL = 'https://api.bitbank.cc'`（パスは `/v1/...` を都度付与） | `src/private/client.ts:56` | ✅ |
| Public レスポンス封筒 | `{ success: 0\|1, data: ... }` | `get_ticker` / `get_tickers_jpy` のみ `success !== 1` を upstream として分類。`get_candles` / `get_transactions` / `get_orderbook` は `data?.candlestick?.[0]?.ohlcv ?? []` 等の optional chaining + 空配列フォールバックで間接的に弾いており、`success:0` を明示分類していない | `tools/get_ticker.ts:89`, `tools/get_tickers_jpy.ts:199` | 🟡 |
| Private レスポンス封筒 | 同上 | `BitbankPrivateClient.request` 内で `json.success !== 1` を分類 | `src/private/client.ts:177` | ✅ |
| Result パターン | ➖ | 全ツールで `ok()` / `fail()` を返却 | `lib/result.ts` | ✅ |

---

## 2. Public API

### 2.1 GET `/{pair}/ticker`

| 項目 | 内容 |
|---|---|
| ツール | `get_ticker` |
| 実装ファイル | `tools/get_ticker.ts` |
| 入力スキーマ | `GetTickerInputSchema` — `src/schema/market-data.ts:28` |
| 出力スキーマ | `GetTickerOutputSchema` — `src/schema/market-data.ts:27` |
| テスト | `tests/get_ticker.test.ts`（17 describe/it） |
| 状態 | ✅ |

**レスポンスフィールド対応:**

| 公式 | 型 | 実装 | normalized キー |
|---|---|---|---|
| `sell` | string | ✅ | `sell` (number) |
| `buy` | string | ✅ | `buy` (number) |
| `high` | string | ✅ | `high` (number) |
| `low` | string | ✅ | `low` (number) |
| `open` | string | ✅ | `open` (number) |
| `last` | string | ✅ | `last` (number) |
| `vol` | string | ✅ | `volume` (number) |
| `timestamp` | number(ms) | ✅ | `timestamp` + `isoTime` 派生 |

**注記**: `sell` / `buy` は通常モード以外で逆転し得る（spec 注釈）。実装は順序前提を持たず単に数値化のみ。

### 2.2 GET `/tickers`

| 項目 | 内容 |
|---|---|
| 実装 | ❌ 未実装（JPY 以外を含む全ペアの取得） |
| 影響 | 現状は JPY 建てのみ対応で十分というプロダクト方針と一致するが、`btc_usdt` 等の検証用途では取れない |
| 補足 | `tickers_jpy` で JPY 建ては取れる |

### 2.3 GET `/tickers_jpy`

| 項目 | 内容 |
|---|---|
| ツール | `get_tickers_jpy` |
| 実装ファイル | `tools/get_tickers_jpy.ts` + `src/handlers/getTickersJpyHandler.ts` |
| スキーマ | `GetTickersJpyOutputSchema` — `src/schema/market-data.ts:273` |
| テスト | `tests/get_tickers_jpy.test.ts`（32 describe/it） |
| 状態 | ✅ |

**追加機能（公式 spec の範囲外）:**
- `BITBANK_PAIRS_MODE = strict | auto | off` によるフィルタモード切替
- `auto` モードでは内部で `/tickers_jpy` を取得しキャッシュ（`PAIRS_TTL_MS` 15分）
- `change24h` / `change24hPct` を `open` / `last` から派生

**注記**: `sell` / `buy` がスキーマ上 `string | null` を許容しているが、公式 spec では `string`。null を返すケースが実在するかは未確認（circuit break 中など）。

### 2.4 GET `/{pair}/depth`

| 項目 | 内容 |
|---|---|
| ツール | `get_orderbook`（mode = summary/pressure/statistics/raw） |
| 実装ファイル | `tools/get_orderbook.ts` |
| 入力スキーマ | `GetOrderbookInputSchema` — `src/schema/market-data.ts:48` |
| 出力スキーマ | `GetOrderbookOutputSchema`, `GetDepthOutputSchema` — `src/schema/market-data.ts:46,165` |
| テスト | `tests/get_orderbook.test.ts`（34 describe/it） |
| 状態 | 🟡 |

**レスポンスフィールド対応:**

| 公式 | 型 | 実装 | 注記 |
|---|---|---|---|
| `asks` | `[string, string][]` | ✅ | mode=raw でそのまま保持 / 他 mode は `[number, number]` 化 |
| `bids` | `[string, string][]` | ✅ | 同上 |
| `asks_over` | string | 🟡 | raw mode の `data.asks_over` に保持。`GetDepthDataSchemaOut` で optional |
| `bids_under` | string | 🟡 | raw mode のみ。statistics / pressure mode には流れていない |
| `asks_under` | string | 🟡 | raw mode のみ |
| `bids_over` | string | 🟡 | raw mode のみ |
| `ask_market` | string | 🟡 | raw mode のみ。market order 待ち数量 |
| `bid_market` | string | 🟡 | raw mode のみ |
| `timestamp` | number | ✅ | `timestamp` (number) として保持 |
| `sequenceId` | number | 🟡 | raw mode のみ。`sequence_id` snake_case も拾うフォールバックがある (`tools/get_orderbook.ts:432`) |

**注記**
- 公式仕様: circuit_break_info.mode が `NONE` でない時、BBO ではなく見積価格基準で上下 200 件ずつ（最大 400 件）配信される。実装は `maxLevels: 200` で先頭から切り出すのみで、circuit break 由来の特殊配信形態を明示的にハンドリングしていない。
- pressure / statistics mode は深度の `*_over` / `*_under` / `*_market` を捨てている。流動性スコアに加算すれば真の depth を反映できる余地あり。

### 2.5 GET `/{pair}/transactions[/YYYYMMDD]`

| 項目 | 内容 |
|---|---|
| ツール | `get_transactions` |
| 実装ファイル | `tools/get_transactions.ts` |
| 入力スキーマ | `GetTransactionsInputSchema` — `src/schema/market-data.ts:129` |
| 出力スキーマ | `GetTransactionsOutputSchema` — `src/schema/market-data.ts:127` |
| テスト | `tests/get_transactions.test.ts`（6 describe/it、81 行） |
| 状態 | 🟡 |

**レスポンスフィールド対応:**

| 公式 | 型 | 実装 |
|---|---|---|
| `transaction_id` | number | ❌ 捨てている（normalized に含まれない） |
| `side` | "buy" \| "sell" | ✅ `side` |
| `price` | string | ✅ `price` (number) |
| `amount` | string | ✅ `amount` (number)（`size` フォールバック付き） |
| `executed_at` | number(ms) | ✅ `timestampMs` / `isoTime` |

**注記**
- `t.amount ?? t.size` / `t.executed_at ?? t.timestamp ?? t.date` といったフォールバックは公式 spec にないキーまでサポートしているが、実害は無く upstream の表記揺れに対する保険。
- `transaction_id` を捨てているため重複検出や上流との突合が不可能。最新60件 vs YYYYMMDD 指定の境界で重複しうる。
- 入力スキーマの `limit` は max=1000 だが、公式 API はデフォルト 60 件 or 日付指定で日次分のみ返す。1000 件を要求しても 60 件しか得られない可能性あり、ユーザーへのヒントが summary に出ない。
- テストカバレッジが薄い（81 行・6 ケース）: API 異常系、空配列、日付フォーマット境界、フィルタ未指定/指定の summary 差し替えロジックがほぼ未検証。

### 2.6 GET `/{pair}/candlestick/{candle-type}/{YYYYMMDD|YYYY}`

| 項目 | 内容 |
|---|---|
| ツール | `get_candles` |
| 実装ファイル | `tools/get_candles.ts` |
| 入力スキーマ | `GetCandlesInputSchema` — `src/schema/market-data.ts:95` |
| 出力スキーマ | `GetCandlesOutputSchema` — `src/schema/market-data.ts:93` |
| テスト | `tests/get_candles.test.ts`（16 describe/it） |
| 状態 | 🟡 |

**candle-type 一覧:** 1min / 5min / 15min / 30min / 1hour / 4hour / 8hour / 12hour / 1day / 1week / 1month
- `YEARLY_TYPES` = 4hour 以上は YYYY 形式
- `DAILY_TYPES` = 1hour 以下は YYYYMMDD 形式
- 実装は `TYPES` セットで全 11 値を正確にカバー（`tools/get_candles.ts:11-23`）

**レスポンスフィールド対応:**

| 公式 | 実装 |
|---|---|
| `type` (string) | ✅ meta.type に格納 |
| `ohlcv: [O,H,L,C,V,ts][]` | ✅ `normalized: { open, high, low, close, volume, isoTime, isoTimeLocal? }` |
| `timestamp` (公開日時) | ❌ 上流 timestamp は破棄。各 ohlcv の ts は保持 |

**追加機能:**
- 複数年/複数日にまたがる取得を並列化（`needsMultiYear` / `needsMultiDay` 分岐）
- バッチ間ディレイ 500ms、3 並列、レート制限を意識した実装
- `keyPoints` (today, 7日前, 30日前, 90日前) / `volumeStats` の派生指標

**注記**:
- 公式 spec の `candlestick[].timestamp`（公開日時、各 ohlcv の ts とは別）は破棄しており、契約照合上は不完全。
- 公式 spec では `ohlcv` 配列の volume が「base 通貨建ての合算」であり、買い/売り内訳は無い。実装も同前提でコメント済み (`tools/get_candles.ts:275-276`)。
- multi-year 取得（4hour 以上の type）は `date` パラメータで指定された年（または YYYYMMDD の YYYY 部分）を起点に過去年へ遡る。`date` 未指定時のみ現在年起点。`tests/get_candles.test.ts` の `multi-year: date パラメータを起点に取得する` describe で検証済み。

### 2.7 GET `/{pair}/circuit_break_info`

| 項目 | 内容 |
|---|---|
| 実装 | ❌ **未実装** |
| 影響 | 高 |

**未実装の理由(推定)**: プロダクトでは「異常時の挙動」を chart / depth ツールにフックしていないため。

**TODO**: 「⚠️ 板情報の特殊配信は circuit break 中に発生」「成行が制限される (`70020`)」など、Private API 側エラーと密接に関係する。少なくとも以下のフィールド可視化が望ましい:
- `mode`: NONE / CIRCUIT_BREAK / FULL_RANGE_CIRCUIT_BREAK / RESUMPTION / LISTING
- `estimated_itayose_price`, `itayose_upper_price`, `itayose_lower_price`
- `fee_type`: NORMAL / SELL_MAKER / BUY_MAKER / DYNAMIC
- `reopen_timestamp`

---

## 3. Private API

### 3.1 認証層

| 項目 | 公式仕様 | 実装 | 場所 | 状態 |
|---|---|---|---|---|
| Header `ACCESS-KEY` | API キー | ✅ | `src/private/auth.ts:70` | ✅ |
| Header `ACCESS-REQUEST-TIME` | unix ms | ✅ | `src/private/auth.ts:71` | ✅ |
| Header `ACCESS-TIME-WINDOW` | デフォルト 5000ms / 最大 60000ms | ✅ デフォルト 5000、上限チェックなし | `src/private/auth.ts:15` | 🟡 |
| Header `ACCESS-SIGNATURE` | HMAC-SHA256 | ✅ | `src/private/auth.ts:44` | ✅ |
| Header `ACCESS-NONCE`（旧方式） | 代替 | ❌ ACCESS-TIME-WINDOW 方式のみ実装 | — | 🟡（意図的） |
| GET 署名対象 | `requestTime + timeWindow + path（クエリ込み）` | ✅ `buildGetMessage` | `src/private/auth.ts:28` | ✅ |
| POST 署名対象 | `requestTime + timeWindow + body` | ✅ `buildPostMessage` | `src/private/auth.ts:36` | ✅ |
| 公式テストベクタ検証 | SECRET=hoge / requestTime=1721121776490 / timeWindow=1000 | ✅ GET / POST 共に一致 | `tests/private/auth.test.ts:65-95` | ✅ |
| `Content-Type` ヘッダ | (明示なし) | ✅ `application/json` を常時付与 | `src/private/client.ts:89,108` | ✅ |
| クエリパラメータの URLEncode | URLSearchParams 経由 | ✅ | `src/private/client.ts:78` | ✅ |

**TODO**: `ACCESS-TIME-WINDOW` の上限 60000ms バリデーションを `auth.ts` に追加検討。現状はテスト用に固定値を注入可能だが、誤って 60000 超を渡すと bitbank 側で 400。

### 3.2 GET `/v1/user/assets`

| 項目 | 内容 |
|---|---|
| ツール | `get_my_assets` |
| 実装ファイル | `tools/private/get_my_assets.ts` |
| スキーマ | `GetMyAssetsOutputSchema` — `src/private/schemas.ts:43` |
| テスト | `tests/private/get_my_assets.test.ts`（115 行） |
| 状態 | 🟡 |

**レスポンスフィールド対応:**

| 公式 | 型 | 実装 |
|---|---|---|
| `asset` | string | ✅ |
| `free_amount` | string | ✅ → `available_amount` |
| `amount_precision` | number | ❌ 捨てている |
| `onhand_amount` | string | ✅ → `amount` |
| `locked_amount` | string | ✅ |
| `withdrawing_amount` | string | ❌ 捨てている |
| `withdrawal_fee` | object \| string | ❌ 捨てている |
| `stop_deposit` | boolean | ❌ 捨てている |
| `stop_withdrawal` | boolean | ❌ 捨てている |
| `network_list` | array（暗号資産のみ） | ❌ 捨てている |
| `collateral_ratio` | string | ❌ 捨てている |

**追加機能:**
- `tickers_jpy` 連携で JPY 評価額・構成比を自動算出。失敗時は warning 付与で graceful degrade。

**TODO**:
- `stop_deposit` / `stop_withdrawal` は LLM が「入出金できないアセット」を判別するのに有用。output に追加検討。
- `collateral_ratio` は信用取引の担保価値を示し `get_margin_status` と組み合わせると便利。
- `network_list`（多ネットワーク対応コイン）は将来の入金ハンドリングに必要。

### 3.3 GET `/v1/user/spot/order` (注文照会・単一)

| 項目 | 内容 |
|---|---|
| ツール | `get_order` |
| 実装ファイル | `tools/private/get_order.ts` |
| スキーマ | `GetOrderOutputSchema` / `OrderResponseSchema` — `src/private/schemas.ts:617` |
| テスト | `tests/private/get_order.test.ts`（251 行） |
| 状態 | ✅ |

**レスポンスフィールド対応 (OrderResponseSchema 経由):**

| 公式 | 型 | 実装 |
|---|---|---|
| `order_id` | number | ✅ |
| `pair` | string | ✅ |
| `side` | "buy"\|"sell" | ✅ |
| `position_side` | "long"\|"short"\|undef | 🟡 OrderResponseSchema に未定義（現物前提）。`tools/private/get_my_orders.ts:18` の RawOrder には optional で存在 |
| `type` | string | ✅ |
| `start_amount` | string \| null | ✅ |
| `remaining_amount` | string \| null | ✅ |
| `executed_amount` | string | ✅ |
| `price` | string \| undef | ✅ |
| `post_only` | boolean \| undef | ✅ |
| `user_cancelable` | boolean | ✅ |
| `average_price` | string | ✅ |
| `ordered_at` | number(ms) | ✅ |
| `expire_at` | number \| null | ✅ |
| `triggered_at` | number \| undef | ✅（`number \| string` を許容） |
| `trigger_price` | string \| undef | ✅ |
| `canceled_at` | number(ms) | ✅ |
| `status` | enum | ✅ `OrderStatusEnum` で受ける（8 値を網羅） |

**注記**:
- `OrderStatusEnum` は `src/private/schemas.ts` で定義済み（`INACTIVE` / `UNFILLED` / `PARTIALLY_FILLED` / `FULLY_FILLED` / `CANCELED_UNFILLED` / `CANCELED_PARTIALLY_FILLED` / `REJECTED` / `TRIGGERED`）で、`OrderResponseSchema.status` も `OrderStatusEnum` を採用。`MarginAccountStatus` と同じ strict enum 方式。
- `get_my_orders` の `ACTIVE_STATUSES`（`INACTIVE` / `UNFILLED` / `PARTIALLY_FILLED` / `TRIGGERED`）は `OrderStatusEnum` の部分集合として整合。
- bitbank が将来未知のステータスを追加すると `parse()` が ZodError を投げて `upstream_error` を返す。誤値検出を強める設計（loud failure）として意図的に許容。tests/private/get_order.test.ts に未知ステータスの fail を検証するケースあり。
- 3 ヶ月以上前の注文は `50009` エラーで取得不可。ドキュコメントあり (`tools/private/get_order.ts:8`)。

**TODO**:
- `OrderResponseSchema` に `position_side` を追加（信用取引時の取得結果対応）。

### 3.4 POST `/v1/user/spot/order` (注文発注)

| 項目 | 内容 |
|---|---|
| ツール | `create_order`（事前 `preview_order` 必須） |
| 実装ファイル | `tools/private/create_order.ts`, `tools/private/preview_order.ts` |
| スキーマ | `CreateOrderInputSchema` — `src/private/schemas.ts:689` / `PreviewOrderInputSchema` — `src/private/schemas.ts:641` |
| テスト | `tests/private/create_order.test.ts`（718 行）/ `preview_order.test.ts`（553 行） |
| 状態 | 🟡 |

**リクエストパラメータ対応:**

| 公式 | 必須 | 実装 |
|---|---|---|
| `pair` | 必須 | ✅ |
| `amount` | 条件付き | ✅ |
| `price` | limit / stop_limit で必須 | ✅（preview_order 側でバリデーション） |
| `side` | 必須 | ✅ "buy"\|"sell" enum |
| `type` | 必須 | ✅ "limit"\|"market"\|"stop"\|"stop_limit" enum |
| `trigger_price` | stop / stop_limit で必須 | ✅ |
| `post_only` | 任意（limit のみ） | ✅ |
| `position_side` | 信用取引で指定 | ✅ "long"\|"short" enum |

**追加機能（公式 spec の範囲外）:**
- 2 段階確認（preview → create）。HMAC-SHA256 確認トークンで改ざん検知。
- 注文監査ログ（チェーンハッシュ付き）。
- bitbank エラーコード補足メッセージ: 50058〜50078（信用）/ 60001〜60016（数量制限）/ 70004〜70020（取引制限）。

**注記**:
- 公式 spec の `POST /user/spot/order` は注文 `type` として `limit` / `market` / `stop` / `stop_limit` に加え **`take_profit` / `stop_loss` / `losscut`** も列挙している（`losscut` はシステム発生だが `take_profit` / `stop_loss` はユーザー入力可）。実装の `SpotOrderTypeEnum` は前 4 種のみで、`take_profit` / `stop_loss` を意図せず受け付けない。`losscut` は明らかにシステム側のみだが、`take_profit` / `stop_loss` は入力サポート可否を要再検討。
- OrderResponseSchema 側の `type` は `z.string()` で受けているため、これらタイプの注文を**取得**することはできる（`get_order` / `get_my_orders`）。

### 3.5 POST `/v1/user/spot/cancel_order`

| 項目 | 内容 |
|---|---|
| ツール | `cancel_order`（事前 `preview_cancel_order` 必須） |
| 実装ファイル | `tools/private/cancel_order.ts`, `tools/private/preview_cancel_order.ts` |
| スキーマ | `CancelOrderInputSchema` — `src/private/schemas.ts:763` |
| テスト | `tests/private/cancel_order.test.ts`（298 行）/ `preview_cancel_order.test.ts`（289 行） |
| 状態 | ✅ |

**リクエストパラメータ対応:**

| 公式 | 必須 | 実装 |
|---|---|---|
| `pair` | 必須 | ✅ |
| `order_id` | 必須 | ✅ |

**エラーマッピング**: 50009 / 50010 / 50026 / 50027 に補足メッセージあり（`tools/private/cancel_order.ts:94-99`）。

### 3.6 POST `/v1/user/spot/cancel_orders`

| 項目 | 内容 |
|---|---|
| ツール | `cancel_orders`（事前 `preview_cancel_orders` 必須） |
| 実装ファイル | `tools/private/cancel_orders.ts` |
| スキーマ | `CancelOrdersInputSchema` — `src/private/schemas.ts:823`（`order_ids: max(30)`） |
| テスト | `tests/private/cancel_orders.test.ts`（278 行）/ `preview_cancel_orders.test.ts`（183 行） |
| 状態 | ✅ |

**注記**: 公式仕様の上限 30 件を Zod スキーマで明示的に強制 (`min(1).max(30)`)。

### 3.7 POST `/v1/user/spot/orders_info`

| 項目 | 内容 |
|---|---|
| ツール | `get_orders_info` |
| 実装ファイル | `tools/private/get_orders_info.ts` |
| スキーマ | `GetOrdersInfoOutputSchema`（OrderResponseSchema を参照） |
| テスト | `tests/private/get_orders_info.test.ts`（245 行） |
| 状態 | 🟡 |

**注記**:
- 公式仕様: 3 ヶ月以上前の注文は結果に含まれない（エラーにはならない）。実装はサマリーに「3ヶ月以上前の注文のため取得できませんでした」と件数差分を表示。
- 入力 `order_ids` の上限が公式 spec で明示されていないため、スキーマで上限を強制していない。経験則として cancel_orders と同じ 30 件が妥当かは未確認。

**TODO**: `order_ids` の妥当な上限を bitbank サポートに確認。または cancel_orders と揃えて 30 件で運用するか。

### 3.8 GET `/v1/user/spot/active_orders`

| 項目 | 内容 |
|---|---|
| ツール | `get_my_orders` |
| 実装ファイル | `tools/private/get_my_orders.ts` |
| スキーマ | `GetMyOrdersOutputSchema` — `src/private/schemas.ts:143` |
| テスト | `tests/private/get_my_orders.test.ts`（368 行） |
| 状態 | 🟡 |

**リクエストパラメータ対応:**

| 公式 | 実装 |
|---|---|
| `pair`（任意） | ✅ |
| `count` | ✅（デフォルト 100、max 1000） |
| `from_id` | ❌ |
| `end_id` | ❌ |
| `since` | ✅（ISO8601 → unix ms 変換） |
| `end` | ✅ |

**追加機能:**
- レスポンスから `INACTIVE` / `UNFILLED` / `PARTIALLY_FILLED` / `TRIGGERED` のみに絞る `ACTIVE_STATUSES` フィルタ（`tools/private/get_my_orders.ts:78`）。bitbank が稀に終端ステータスを混ぜて返すケースへの保険。

**TODO**:
- `from_id` / `end_id` をサポートすれば注文 ID ベースの安定したページネーションが可能。`since` / `end` だけだと同一 ms 境界の取りこぼしリスクあり。
- `position_side` などの信用取引フィールドが `OrderItemSchema` から欠落（`get_order.ts` の OrderResponseSchema と比べて簡略化されている）。

### 3.9 GET `/v1/user/spot/trade_history`

| 項目 | 内容 |
|---|---|
| ツール | `get_my_trade_history`（現物）/ `get_margin_trade_history`（`type=margin` で信用のみ） |
| 実装ファイル | `tools/private/get_my_trade_history.ts`, `tools/private/get_margin_trade_history.ts` |
| スキーマ | `GetMyTradeHistoryOutputSchema` — `src/private/schemas.ts:98` / `GetMarginTradeHistoryOutputSchema` — `src/private/schemas.ts:588` |
| テスト | `tests/private/get_my_trade_history.test.ts`（783 行）/ `get_margin_trade_history.test.ts`（860 行） |
| 状態 | ✅ |

**リクエストパラメータ対応:**

| 公式 | 実装 |
|---|---|
| `pair`（任意） | ✅ |
| `count` | ✅ デフォルト 100、max 10000（公式 max は 1000 だが超過時は自動ページネーション） |
| `order` | ✅ "asc" / "desc" |
| `since` | ✅ ISO8601 入力 |
| `end` | ✅ |
| `order_id`（特定注文の約定取得） | ❌ |
| ~`type`~（公式パラメータには無い） | ➖ `get_margin_trade_history` が `type=margin` を**非公式パラメータ**として送信。公式 docs には記載が無いため、API に無視される可能性に備えてレスポンス側の `position_side != null` でフィルタする実装 (`tools/private/get_margin_trade_history.ts:161-162`) |

**追加機能:**
- 自動ページネーション（最大 10 ページ）。order に応じて asc=since 前進 / desc=end 後退 でカーソル管理し、同一 ms 境界レコードを `trade_id` で重複排除（`tools/private/get_my_trade_history.ts:52-102`）。
- `isComplete` フラグで全件取得できたかを meta に格納。

**レスポンスフィールド対応:**

| 公式 | 型 | 実装 |
|---|---|---|
| `trade_id` | number | ✅ |
| `pair` | string | ✅ |
| `order_id` | number | ✅ |
| `side` | string | ✅ |
| `position_side` | string \| undef | 🟡 `MarginTradeItemSchema` には optional で含む、`TradeItemSchema`（現物）には欠落 |
| `type` | string | ✅ |
| `amount` | string | ✅ |
| `price` | string | ✅ |
| `maker_taker` | string | ✅ |
| `fee_amount_base` | string | ✅ |
| `fee_amount_quote` | string | ✅ |
| `fee_occurred_amount_quote` | string | ✅ optional |
| `profit_loss` | string \| undef | 🟡 margin のみ。現物 `TradeItemSchema` には欠落 |
| `interest` | string \| undef | 🟡 同上 |
| `executed_at` | number(ms) | ✅ ISO8601 化 |

**TODO**:
- `order_id` クエリパラメータをサポートすると、特定の注文の約定だけを引ける（今は client 側で `trades.filter(t => t.order_id === ...)` する必要あり）。
- 現物の `TradeItemSchema`（`src/private/schemas.ts:63`）に `position_side` / `profit_loss` / `interest` を optional 追加すれば、現物⇄信用混在 API 応答にも堅牢になる。

### 3.10 GET `/v1/user/margin/status`

| 項目 | 内容 |
|---|---|
| ツール | `get_margin_status` |
| 実装ファイル | `tools/private/get_margin_status.ts` |
| スキーマ | `GetMarginStatusOutputSchema` — `src/private/schemas.ts:479` |
| テスト | `tests/private/get_margin_status.test.ts`（204 行） |
| 状態 | ✅ |

**注記**: フィールドは公式 spec を全網羅。CALL / LOSSCUT / DEBT 検出時にアラートを summary に含めるロジックあり。

### 3.11 GET `/v1/user/margin/positions`

| 項目 | 内容 |
|---|---|
| ツール | `get_margin_positions` |
| 実装ファイル | `tools/private/get_margin_positions.ts` |
| スキーマ | `GetMarginPositionsOutputSchema` — `src/private/schemas.ts:532` |
| テスト | `tests/private/get_margin_positions.test.ts`（225 行） |
| 状態 | ✅ |

### 3.12 GET `/v1/user/deposit_history`

| 項目 | 内容 |
|---|---|
| ツール | `get_my_deposit_withdrawal`（type=deposit or all）/ `analyze_my_portfolio` も内部利用 |
| 実装ファイル | `tools/private/get_my_deposit_withdrawal.ts` |
| スキーマ | `GetMyDepositWithdrawalOutputSchema` — `src/private/schemas.ts:437` |
| テスト | `tests/private/get_my_deposit_withdrawal.test.ts`（355 行） |
| 状態 | ✅ |

**注記**: 100 件上限を超える場合は `paginateDeposits`（`tools/private/get_my_deposit_withdrawal.ts:87`）で `confirmed_at + 1ms` を since にして次ページ取得。最大 10 ページ。

### 3.13 GET `/v1/user/withdrawal_history`

| 項目 | 内容 |
|---|---|
| ツール | `get_my_deposit_withdrawal`（type=withdrawal or all） |
| 実装ファイル | 同上 |
| スキーマ | 同上 |
| 状態 | 🟡 |

**注記**: 公式 spec のレスポンスは口座番号 / 名義 / 支店名等の銀行情報も含むが、`.claude/rules/sensitive-data.md` の方針に従い実装の `WithdrawalItemSchema`（`src/private/schemas.ts:407`）では `account_number` / `account_owner` / `branch_name` / `account_type` を**意図的に除外**。`bank_name` のみ保持。これはセキュリティ仕様として正常。

### 3.14 GET `/v1/user/unconfirmed_deposits`

| 項目 | 内容 |
|---|---|
| 実装 | ❌ 未実装 |
| 影響 | 中 |

**TODO**: トラベルルール対応で承認待ちになっている入金を可視化したい場合に必要。

### 3.15 GET `/v1/user/deposit_originators`

| 項目 | 内容 |
|---|---|
| 実装 | ❌ 未実装 |
| 影響 | 中 |

**TODO**: 入金元情報の確認に必要。トラベルルール関連。

### 3.16 POST `/v1/user/confirm_deposits` / `/v1/user/confirm_deposits_all`

| 項目 | 内容 |
|---|---|
| 実装 | ❌ 未実装 |
| 影響 | 中 |

**TODO**: トラベルルール関連の入金承認 API。HITL（confirmation_token）フローと統合する必要があるため設計コストあり。

### 3.17 GET `/v1/user/withdrawal_account`

| 項目 | 内容 |
|---|---|
| 実装 | ❌ 意図的に未実装 |
| 影響 | — |

**注記**: 出金関連の API キー権限を一切要求しないという `docs/private-api.md:17` の方針に整合。実装しない。

### 3.18 POST `/v1/user/request_withdrawal`

| 項目 | 内容 |
|---|---|
| 実装 | ❌ 意図的に未実装 |
| 影響 | — |

**注記**: 同上。`.claude/rules/sensitive-data.md` で「出金は実装しない」と明示。

### 3.19 GET `/spot/status` (認証不要)

| 項目 | 内容 |
|---|---|
| 実装 | ❌ 未実装 |
| 影響 | 中 |

**TODO**: ペア単位の取引可否ステータスを返すエンドポイント。circuit break / maintenance を事前検知できる。

### 3.20 GET `/spot/pairs` (認証不要)

| 項目 | 内容 |
|---|---|
| 実装 | 🟡 部分的 |

**注記**: `BITBANK_PAIRS_MODE=auto` で `tickers_jpy` を自動取得して pair list 化しているため、JPY ペアだけは間接的に動的化。`/spot/pairs` を直接叩けば最小数量 / 価格刻み / 手数料率なども取れるが現状未利用。

**TODO**:
- 最小注文数量 / 価格刻みを `/spot/pairs` から取得し、`preview_order` での事前バリデーションに活用すれば bitbank 側で 60003 / 60004 / 60005 / 60006 になる前にユーザーに知らせられる。

### 3.21 GET `/v1/user/subscribe` (Private Stream トークン)

| 項目 | 内容 |
|---|---|
| 実装 | ❌ 未実装 |
| 影響 | — |

**注記**: ストリーミング（WebSocket）は本リポジトリのスコープ外（`docs/private-api.md:163`）。

---

## 4. クロスカット観点

### 4.1 レート制限

| 項目 | 公式仕様 | 実装 | 場所 | 状態 |
|---|---|---|---|---|
| QUERY 系（取得） | 10 req/sec | ✅ public は `fetchJsonWithRateLimit` で X-RateLimit-* ヘッダを読み出し meta.rateLimit に反映 | `lib/http.ts` | ✅ |
| UPDATE 系（注文・キャンセル） | 6 req/sec | ✅ private は `BitbankPrivateClient.lastRateLimit` に保持 | `src/private/client.ts:174` | ✅ |
| HTTP 429 | Retry-After 準拠 | ✅ Retry-After ヘッダを尊重し最大 2 回リトライ | `src/private/client.ts:129-140` | ✅ |
| `10009` (レート制限エラーコード) | リトライ対象 | ✅ 1秒 × 2^attempt の指数バックオフ | `src/private/client.ts:181-187` | ✅ |
| candlestick 複数日取得時のスロットリング | (実装側裁量) | ✅ バッチ 3 並列、バッチ間 500ms ディレイ | `tools/get_candles.ts:204-226` | ✅ |

### 4.2 エラーコード分類

| カテゴリ | コード範囲 | 実装 | 状態 |
|---|---|---|---|
| システム | 10000 番台 | 10007 (メンテ) / 10008 (過負荷) / 10009 (レート) を識別 | ✅ |
| 認証 | 20001〜20005 | `AUTH_ERROR_CODES` で全マッピング | ✅ |
| 必須パラ不足 | 30000 番台 | デフォルト分類 | 🟡 |
| パラメータ不正 | 40000 番台 | デフォルト分類 | 🟡 |
| データ | 50000 番台 | 50009 / 50010 / 50026 / 50027 / 50058〜50078 個別メッセージ | ✅ |
| 数値制限 | 60000 番台 | 60001 / 60002 / 60003 / 60004 / 60005 / 60006 / 60011 / 60016 個別メッセージ | ✅ |
| 取引制限 | 70000 番台 | 70004 / 70005 / 70006 / 70009 / 70020 個別メッセージ | ✅ |

**TODO**:
- 30000 / 40000 番台のうち頻出するコード（例: 30001=parameter required, 40001=invalid type）に人間可読メッセージを追加。

### 4.3 機密情報の取り扱い

| 項目 | ポリシー | 実装 | 状態 |
|---|---|---|---|
| API キー漏洩防止 | ログ・エラーに含めない | ✅ `client.ts` の認証エラーは固定文言 | ✅ |
| 出金 API 非実装 | `request_withdrawal` を実装しない | ✅ 未実装 | ✅ |
| 出力フィールド除外 | `account_number`, `account_owner`, `branch_name`, `account_type` を出力に含めない | ✅ `WithdrawalItemSchema` で意図的に欠落させ、`getMyDepositWithdrawal` の整形でも `bank_name` のみ抽出 | ✅ |
| confirmation_token のマスク | `SENSITIVE_KEYS` でログマスク | ✅ `lib/logger.ts` で `confirmation_token` / `token` をマスク | ✅ |

---

## 5. TODO サマリ（優先度別）

### High（公式仕様との差分が実害を生む可能性）

- [x] **`transaction_id` を `get_transactions` の normalized に含める** — 重複検出 / 突合が不可能な現状を解消。✅ PR #462 で実装済み（`TransactionItemSchema` に optional 追加）。
- [x] **`get_transactions` テスト拡充** — 81 行・6 ケースは薄い。日付フォーマット境界、空配列、API 異常系、`maxAmount` / `maxPrice` フィルタ未検証。✅ PR #462 で 24 ケースに拡充済み。
- [ ] **Public 全取得系で `success:0` fixture テスト追加** — `get_candles` / `get_orderbook` は `data` 構造で間接的に弾いているのみ。fixture でレスポンス封筒 `success:0` を返した時の挙動を検証する必要あり（`get_transactions` は PR #462 で対応済み）。
- [x] **`get_candles` multi-year の起点を `date` パラメータ基準に修正、または明示的に「current year 起点」と仕様化** — ✅ `date` 指定時は YYYY 部分を起点、未指定時は現在年起点に修正。`tools/get_candles.ts` の `anchorYear` で分岐し、`tests/get_candles.test.ts` の `multi-year: date パラメータを起点に取得する` describe で 1day / 4hour / 1week / 1month / YYYYMMDD 入力 / multi-day 非干渉を検証済み。
- [x] **`70020`（circuit break 中の market 拒否）のエラーマッピング** — ✅ `create_order` の `codeMessages` に追加済み。`tests/private/create_order.test.ts` の「サーキットブレイク中の成行注文制限（70020）」で検証。
- [x] **`OrderStatusEnum` に `REJECTED` / `TRIGGERED` を追加し `OrderResponseSchema.status` を enum 化** — ✅ `OrderStatusEnum` を 8 値（公式 spec 完全準拠）に拡張し、`OrderResponseSchema.status` を strict enum 化。未知ステータスは `parse()` が ZodError → catch ブロックで `upstream_error` を返す（loud failure）。`OrderItemSchema`（`get_my_orders`）の `status` は ACTIVE_STATUSES フィルタを通った後の出力スキーマのため `z.string()` のまま維持。
- [ ] **`SpotOrderTypeEnum` に `take_profit` / `stop_loss` 入力サポート可否を再検討** — 公式 spec の `POST /user/spot/order` に列挙されているが実装は 4 種のみ。bitbank が現物で本当に受け付けるか動作確認の上、対応 or 「意図的に未対応」として明文化。

### Medium（機能拡張・将来の堅牢性）

- [ ] **`circuit_break_info` エンドポイントの実装** — market order や depth 解釈と密接に関連。最低でも `mode` / `fee_type` / `reopen_timestamp` を取得できるツールを追加。
- [ ] **`/spot/pairs` を取り込み `preview_order` で最小注文数量 / 価格刻みバリデーション** — 60003 / 60004 / 60005 / 60006 を未然に防止。
- [ ] **`/spot/status` の取り込み** — 取引可否を事前確認できる。
- [ ] **`assets` レスポンスに `stop_deposit` / `stop_withdrawal` / `collateral_ratio` を含める** — ユーザーへの情報量増加。
- [ ] **`TradeItemSchema`（現物）に `position_side` / `profit_loss` / `interest` を optional 追加** — 現物⇄信用混在応答への堅牢性。
- [ ] **`OrderItemSchema`（get_my_orders）に `position_side` / `post_only` / `user_cancelable` / `trigger_price` を追加** — `OrderResponseSchema` と粒度が乖離している。
- [ ] **`get_my_orders` / `get_my_trade_history` に `from_id` / `order_id` クエリサポート** — ID ベース安定ページネーション。
- [ ] **depth の `*_over` / `*_under` / `*_market` を pressure / statistics mode にも反映** — 流動性スコアに加算。

### Low（運用ガード）

- [ ] **`ACCESS-TIME-WINDOW` の上限 60000ms バリデーション** — `auth.ts` で安全弁を追加。
- [ ] **30000 / 40000 番台エラーコードに頻出パターンの個別メッセージを追加** — UX 改善。
- [ ] **`unconfirmed_deposits` / `deposit_originators` / `confirm_deposits` 系の実装検討** — トラベルルール関連。HITL フロー再設計が必要なため工数大。

### 意図的に未対応（修正不要）

- ❌ `request_withdrawal` / `withdrawal_account` — セキュリティポリシー（`docs/private-api.md`）
- ❌ `/v1/user/subscribe`（Private Stream） — ストリーミングはスコープ外
- ❌ `ACCESS-NONCE` 認証方式 — `ACCESS-TIME-WINDOW` 方式のみ採用

---

## 6. 検証コマンド

```bash
npm test                                        # 全テスト
npm test tests/private                          # Private API のみ
npm test tests/get_transactions.test.ts         # 個別
npm run typecheck                               # 型チェック
npm run gen:types                               # Zod → 型再生成
```

公式テストベクタの再検証:

```bash
echo -n "17211217764901000/v1/user/assets" | openssl dgst -sha256 -hmac "hoge"
# 期待: 9ec5745960d05573c8fb047cdd9191bd0c6ede26f07700bb40ecf1a3920abae8
```
