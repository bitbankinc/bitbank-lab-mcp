# ツール一覧と使い分け

自由にプロンプトを投げてもらって構いません。
基本的には、「get_orderbook を使って〜」等、ツール名を指定する必要もありません。

> **初めての方へ:** まずは「BTCの今の市場状況を分析して」と話しかけてみてください。`analyze_market_signal` が自動的に選ばれ、総合スコアで全体感をつかめます。もっと詳しく知りたい場合は [プロンプト集](prompts-table.md) の初級（🔰）から試すのがおすすめです。

> **Note:** 本サーバーは bitbank API が返す全銘柄に自動追随します（追加・廃止も即時反映）。
参考: [bitbank API](https://github.com/bitbankinc/bitbank-api-docs)

---

## カテゴリ別ツール（全 49 ツール：Public 33 + Private 16）

> Private ツール（16）は `BITBANK_API_KEY` + `BITBANK_API_SECRET` 設定時のみ表示されます。未設定時は Public 33 ツールのみが利用可能です。

### データ取得 — 生データ（Raw）：4 ツール

API の応答をそのまま、または軽量整形して返す。指標計算・判定は行わない。

| ツール | 概要 |
|--------|------|
| `get_ticker` | 単一ペアの最新価格・出来高（ティッカー） |
| `get_tickers_jpy` | JPYペアの一括取得（価格・出来高・変化率、ランキング表示可、10sキャッシュ） |
| `get_candles` | ローソク足 OHLCV（11 時間軸: 1min〜1month、任意本数） |
| `get_transactions` | 約定履歴（直近 60 件 or 日付指定、サイド/アグレッサー、フィルタ可） |

### データ取得 — 加工（Processed）：3 ツール

生データに集計・統計計算を加えて返す。

| ツール | 概要 |
|--------|------|
| `get_orderbook` | 板情報の統合ツール（mode で分析粒度を切替え） |
|  | mode=summary: 上位N層の正規化・累計サイズ・spread（デフォルト） |
|  | mode=pressure: 帯域別(±0.1%/0.5%/1%等)の買い/売り圧力バランス |
|  | mode=statistics: 板の厚み・流動性分布・大口注文・総合評価 |
|  | mode=raw: 生の bids/asks 配列＋壁ゾーン自動推定 |
| `get_flow_metrics` | CVD / アグレッサー比 / スパイク検知でフロー優勢度を把握 |
| `get_volatility_metrics` | RV / ATR / Parkinson / GK / RS でボラティリティ算出・比較 |

### テクニカル分析：13 ツール

ローソク足・板データから指標計算・スナップショットを生成。

| ツール | 概要 |
|--------|------|
| `analyze_indicators` | 統合指標（SMA / EMA / RSI / BB / 一目 / MACD / Stochastic / StochRSI） |
| `analyze_bb_snapshot` | BB の広がりと終値位置（z-score・帯幅・スクイーズ判定） |
| `analyze_ichimoku_snapshot` | 一目の状態スナップショット（雲との位置関係・転換/基準線・雲の傾き・`lookback` で履歴本数を指定） |
| `analyze_sma_snapshot` | SMA 整列/クロス分析（bullish/bearish/mixed・傾き） |
| `analyze_ema_snapshot` | EMA 整列/クロス分析（SMA より直近価格に敏感。デフォルト期間: 12, 26, 50, 200） |
| `analyze_mtf_sma` | 複数タイムフレーム SMA 一括取得・方向の合流（confluence）判定。analyze_sma_snapshot の個別呼び出し不要 |
| `analyze_stoch_snapshot` | Classic Stochastic Oscillator（%K/%D のゾーン判定・クロス・ダイバージェンス。レンジ相場向き。デフォルト: 14,3,3） |
| `analyze_volume_profile` | 約定データから VWAP・Volume Profile・約定サイズ分布を算出 |
| `analyze_currency_strength` | 通貨強弱分析（JPYペア横断で相対的な強さを比較） |
| `analyze_fibonacci` | フィボナッチ・リトレースメント／エクステンション水準を自動計算（スイング検出・最寄り水準・反応実績を含む） |
| `analyze_mtf_fibonacci` | 複数ルックバック期間のフィボナッチ水準を一括計算し、コンフルエンス（合流）ゾーンを検出 |
| `analyze_support_resistance` | サポレジ自動検出（接触回数・強度・崩壊実績） |
| `analyze_candle_patterns` | ローソク足パターン検出（1〜3本: ハンマー/包み足/三兵 等） |

### 総合判定・スクリーニング：1 ツール

複数指標を統合してスコアを算出。まず全体感をつかむならこれ。

| ツール | 概要 |
|--------|------|
| `analyze_market_signal` | 総合スコア（-100〜+100）。構成: buyPressure 35% / cvdTrend 25% / momentum 15% / volatility 10% / smaTrend 15%。寄与度・式付き |

### パターン検出：3 ツール

| ツール | 概要 |
|--------|------|
| `detect_patterns` | 大型チャートパターン（ダブルトップ/H&S/三角等 13 種、forming/completed/invalid 状態管理） |
| `detect_macd_cross` | MACDクロス統合ツール。pair 指定で単一ペア深掘り（forming検出・過去統計）、省略で複数ペアスクリーニング |
| `detect_whale_events` | 大口投資家の動向を簡易検出（板×ローソク足。蓄積/分配圧力判定） |

### Visualizer データ：2 ツール

クライアント側（Claude.ai の Visualizer 等）で描画するためのコンパクトな整形データ。LLM も数値を直接参照できるため、「この価格帯に買いが厚い」等の言及が可能。

| ツール | 概要 |
|--------|------|
| `prepare_chart_data` | Visualizer / チャート描画用の時系列データ。全指標は計算・シフト適用済み。{time, value}[] 形式 |
| `prepare_depth_data` | 板の深度チャート描画用の累積 volume 階段データ（[price, cumulativeVolume][]）。mid・spread・band 集計付き |

### 可視化（SVG 生成）：3 ツール

クライアント側で描画できない場合や、ファイル保存（preferFile/autoSave）が必要な場合のフォールバック。

| ツール | 概要 |
|--------|------|
| `render_chart_svg` | メインチャート（ローソク足/ライン + SMA/EMA/BB/一目オーバーレイ）+ サブパネル（MACD / RSI / Volume） |
| `render_depth_svg` | 板の深度チャート（累積 bid/ask カーブ）。クライアント描画可能な場合は `prepare_depth_data` を優先 |
| `render_candle_pattern_diagram` | ローソク足パターン教育図（analyze_candle_patterns の結果を図解） |

### データ品質：1 ツール

| ツール | 概要 |
|--------|------|
| `validate_candle_data` | OHLCVデータの品質検証（完全性・重複・整合性・価格/出来高異常値を検出。0-100品質スコア。閾値パラメータ調整可） |

### バックテスト：1 ツール

| ツール | 概要 |
|--------|------|
| `run_backtest` | 汎用バックテスト（SMA クロス / RSI / MACD / BB ブレイクアウト。フィルタ付き。P&L + チャート SVG 一括返却） |

### メンテナンス：1 ツール

| ツール | 概要 |
|--------|------|
| `refresh_pairs_cache` | /spot/pairs 手数料レートの TTL キャッシュ（既定 1h）を強制再取得。キャンペーン境界などで最新 maker/taker 率を即時反映したいときに使う |

### MCP Apps サポート：1 ツール

| ツール | 概要 |
|--------|------|
| `get_ui_snapshot` | [Internal] 確認 UI（iframe）向けに直近の preview 系ツール応答スナップショットを返す。ホストが `ui/notifications/tool-result` を配信しない場合の UI 自己復元（pull 型 hydration）用。LLM が応答生成のために呼ぶ必要はない |

### Private API：16 ツール

`BITBANK_API_KEY` + `BITBANK_API_SECRET` 環境変数が設定されている場合のみ有効化。未設定時はツール自体が MCP クライアントに表示されない。

#### 口座情報（4 ツール）

| ツール | 概要 |
|--------|------|
| `get_my_assets` | 保有資産・残高一覧（全通貨の数量・JPY評価額・構成比） |
| `get_my_trade_history` | 約定履歴（ペア・期間・件数でフィルタ可。maker/taker・手数料情報付き） |
| `get_my_deposit_withdrawal` | 入出金・入出庫履歴（JPY入出金＋暗号資産入出庫。自動ページング対応、最大1000件） |
| `analyze_my_portfolio` | ポートフォリオ総合分析（評価損益・実現損益・口座リターン・テクニカル統合オプション付き） |

#### 注文照会（3 ツール）

| ツール | 概要 |
|--------|------|
| `get_my_orders` | 未約定注文一覧（アクティブな指値/成行注文の状態確認） |
| `get_order` | 単一注文の詳細照会（order_id 指定） |
| `get_orders_info` | 複数注文の一括照会（order_id 配列指定） |

#### 取引操作（6 ツール）

すべて **preview → execute の2ステップ確認**が必須。preview が発行する確認トークン（HMAC-SHA256、デフォルト60秒有効）なしでは実行できない。

| ツール | 概要 |
|--------|------|
| `preview_order` | 注文内容のプレビュー + 確認トークン発行 |
| `create_order` | 確認トークンを検証して注文を実行 |
| `preview_cancel_order` | キャンセル内容のプレビュー + 確認トークン発行 |
| `cancel_order` | 確認トークンを検証してキャンセルを実行 |
| `preview_cancel_orders` | 一括キャンセルのプレビュー + 確認トークン発行 |
| `cancel_orders` | 確認トークンを検証して一括キャンセルを実行 |

#### 信用取引（3 ツール）

| ツール | 概要 |
|--------|------|
| `get_margin_status` | 信用取引のステータス（証拠金率・維持率等） |
| `get_margin_positions` | 信用ポジション一覧（建玉・評価損益） |
| `get_margin_trade_history` | 信用取引の約定履歴 |

---

## `view` の共通語彙

複数のツールが `view` パラメータを持ちますが、**`view` が表すのは「`content` に出す量」だけ**です。量以外の軸（形式・絞り込み）は別のパラメータに分かれています。

### 階梯

| 値 | 意味 |
|---|---|
| `summary` | 集計値・結論のみ。明細・系列は `content` に出ない（最軽量） |
| `detailed` | 代表的な明細（上位 N 件 / 直近 N 件） |
| `full` | そのツールの主対象を全部出す。**常にそのツールの最重量** |

- 順序は `summary` < `detailed` < `full` で固定。**`full` が他の値より軽いツールはありません。**
- **中間の段は無くてもよい**（`get_candles` は `full` のみ、`detect_macd_cross` は `summary` / `detailed` の 2 段）。段が欠けていても順序の意味は変わりません。
- **上位の view は下位の上位集合**です。`view` を上げてフッタ・警告行・最終値が消えることはありません。
- 同じ語の意味はツールを跨いで一定です。あるツールの `summary` が別ツールでは「全件」を指す、ということはありません。

### `full` = 全件列挙とは限らない

`full` が「全件列挙」になるのは、**そのツールの主対象がレコード列の場合だけ**です。ここでいう主対象とは「そのツールの結論を構成するレコード列」を指します。

| ツール | `full` が `content` に出すもの |
|---|---|
| `get_candles` | 全ローソク足 |
| `get_transactions` | 全約定 |
| `get_flow_metrics` | 全バケット行 |
| `detect_patterns` | 全検出パターン（`double_top` / `double_bottom` は山谷 3 点の pivot 行も） |
| `get_volatility_metrics` | **系列の統計値まで**（件数 / 期間 / Close レンジ / リターンの平均・標準偏差）。**系列そのものは出ない** |

`get_volatility_metrics` の結論は `aggregates` / `rolling`（スカラー値）で、`data.series` は指標計算の入力（＝ `get_candles` の再掲）であって出力の主対象ではありません。`full` でも系列を列挙しないのはこのためで、「`full` は常にそのツールの最重量」は満たしています。系列そのものが必要な場合は `get_candles` を使ってください。

### `view` は `structuredContent` からフィールドを削らない

`view` が `structuredContent` から**既存のフィールドを削ることはありません**。軽い `view` で呼んでも、重い `view` で得られるデータが欠けることはありません。

**追加はあります。** その view でしか計算しないデータを*足す*ツールがあります（`detect_patterns` の `detailed` / `debug`、`detect_macd_cross` の `detailed`）。何を足すかは各ツールの `view` の説明に書いてあるので、`structuredContent` を読むクライアントはそちらを確認してください。

つまり契約は**「削らない。ただし足すことはある」**であって、「`structuredContent` は `view` に依存しない」ではありません。後者だと読むと、`detect_macd_cross(view=summary)` に `data.resultsDetailed` が入ると誤解します。

**`content[0].text` は LLM に渡る唯一のチャネル**なので、軽い `view` は「短い表示」ではなく**「LLM が明細を受け取らない」**を意味します。表示を詰めるつもりで `summary` にすると、モデルは明細を見ないまま回答します。

### 量以外の軸は別パラメータ

| パラメータ | 型 / 既定 | 対象ツール | 変えるもの |
|---|---|---|---|
| `format` | `text` / `json`（既定 `text`） | `get_candles` / `get_transactions` | **形式**。`content` を pretty JSON にする |
| `nonZeroOnly` | boolean（既定 `false`） | `get_flow_metrics` | **絞り込み**。バケット行を非ゼロ（buy または sell > 0）のみにする |

- `format=json` は**トークン削減オプションではありません。** 同じデータを pretty JSON にすると散文の圧縮形式より必ず増えます（`get_candles` の実測で約 7.4 倍）。機械可読性のために**トークンを払う**オプションです。量を決めるのは `view` と `limit` です。
- `nonZeroOnly=true` は欠損バケット（`hasData=false`）を落とさず、連続区間を `⋯ 欠損 A〜B（Nバケット, データなし）` の 1 行に畳んで残します（黙って消すと「閑散だった」と誤読されるため）。`view=summary` との併用は no-op（バケット行が無いため。エラーにはなりません）。
- どちらも `view` と独立に指定できます（`view=detailed` + `nonZeroOnly=true` のような組み合わせも可）。

### 階梯外の値（出力の置換）

一部のツールには、量の階梯に乗らない `view` があります。**これらは「もっと詳しく」ではなく「別のものを出す」**もので、上位集合の規約は適用されません。

| ツール | 値 | 何に置き換わるか |
|---|---|---|
| `detect_patterns` | `debug` | 検出パターンが `content` から消え、swings / candidates の一覧に入れ替わる |
| `get_volatility_metrics` | `beginner` | 平易な日本語 4 行。専門用語・指標名・フッタは出ない（読者向けレジスタの指定） |

### 生データ系ツールの既定が全件列挙な理由

`get_candles` / `get_transactions` は**既定（`view=full`）で全件を `content` に載せます**。これは重すぎる既定ではなく意図した設計です。`content[0].text` が LLM への唯一のチャネルなので、既定を軽くすることは「応答を短くする」ではなく**「LLM が OHLCV / 約定明細を一切受け取らなくなる」**を意味します。量を絞りたい場合は `view` ではなく **`limit`** を使ってください（両ツールに集計のみの軽量 `view` は現状ありません）。

`get_flow_metrics` の既定が `summary`（バケット行なし）なのは不整合ではありません。同ツールの結論は `aggregates`（CVD / アグレッサー比 / スパイク上位 3 件）に集約されていて、バケット列はそこから導かれた中間データだからです。**どちらも「既定で LLM に結論が届く」という同じ基準の帰結**です。

### ツール別の値と既定

| ツール | 階梯上の値（**太字**が既定） | 階梯外 | 備考 |
|---|---|---|---|
| `get_candles` | **`full`** | — | 量を絞るのは `limit` |
| `get_transactions` | **`full`** | — | 量を絞るのは `limit` |
| `get_flow_metrics` | **`summary`** / `detailed` / `full` | — | `detailed` の件数は `bucketsN`（既定 10 / 上限 100） |
| `detect_patterns` | `summary` / **`detailed`** / `full` | `debug` | |
| `get_volatility_metrics` | **`summary`** / `detailed` / `full` | `beginner` | |
| `detect_macd_cross` | **`summary`** / `detailed` | — | **`pair` 省略時（複数銘柄スクリーニング）でのみ有効。** `pair` 指定の単一ペア深掘りモードでは無視される |

> `get_tickers_jpy` にも `view`（`ranked` / `items`）がありますが、これは量ではなく**射影**（並び順と `data.ranked` の有無）の指定で、**本節の語彙には含まれません。** `view` という名前自体が誤用のため改名を検討中です。並び順・件数は `sortBy` / `limit` で指定してください。

### 非推奨の値（`0.4.0` で削除予定）

移行期間中は受理されますが、下表の**写像先の挙動になります**。新しい指定へ移行してください。

| ツール | 非推奨の値 | 新しい指定 |
|---|---|---|
| `get_candles` | `items` | `view=full` + `format=json` |
| `get_transactions` | `summary` | `view=full` |
| `get_transactions` | `items` | `view=full` + `format=json` |
| `get_flow_metrics` | `compact` | `view=full` + `nonZeroOnly=true` |
| `get_flow_metrics` | `buckets` | `view=detailed` |

**`get_transactions` の `summary` は特に注意してください。** 旧既定値で実体は「全件列挙」（＝ `full`）でしたが、`summary` という語は階梯上「集計のみ」を意味します。削除後、別リリースで**集計のみの `summary`**（opt-in 専用。既定にはしない）として再導入される予定があるため、`summary` を渡し続けると将来別の応答になります。全件が必要なら今のうちに `view=full` へ移してください。

設計の経緯と判断根拠は [docs/internal/view-vocabulary-unification.md](internal/view-vocabulary-unification.md) を参照。

---

## 非推奨の出力フィールド（`0.4.0` で削除予定）

`view` の enum 値とは別に、**出力フィールドの別名**にも同じ猶予期間（最低 1 リリース かつ 3 ヶ月）を置いています。旧フィールドは移行期間中も**新フィールドと同じ値**を返すので、読み替えるだけで移行できます。

| ツール | 非推奨のフィールド | 新しいフィールド |
|---|---|---|
| `analyze_my_portfolio` | `account_pnl.margin_interest`（`yearly_account_pnl` / `monthly_account_pnl` も同様） | `margin_interest_cost` |
| `analyze_my_portfolio` | `account_pnl.margin_fee`（`yearly_account_pnl` / `monthly_account_pnl` も同様） | `margin_fee_cost` |

**信用のコスト項は `_cost` サフィックス付きが正です。** どちらの名前でも値は同じ**正値**（コスト = 正値）で、`total` では**減算**されます。

```text
total = spot_realized_pnl + margin_realized_pnl − margin_interest_cost − margin_fee_cost
```

`structuredContent` を直読みする場合、コスト項を**足すと符号が反転します**。旧名 `margin_interest` / `margin_fee` は名前から符号規約が読み取れず実際に誤加算されていたため、名前に意味を出した `_cost` へ移行してください（値・符号は変わらないので、リネームだけで済みます）。

---

## ヒント（参考）
- `analyze_market_signal` で全体を把握 → 必要に応じて各専門ツールへ
- チャートは必ず `render_chart_svg` の `data.svg` をそのまま表示（自前描画はしない）
- データ点が多い/レイヤ多い場合は `maxSvgBytes` や `--force-layers` で調整可能

### analyze_ichimoku_snapshot の補足

- `lookback` は `trend.cloudHistory` / `trend.trendStrength` の計算窓に反映されます（既定値 `10`）。
- `signals.overallSignal` は強い条件を優先して判定します。  
  例: `below_cloud` + `tenkanKijun=bearish` + `cloudSlope=falling` は `strong_bearish`。

---

## get_candles 詳細ガイド

### 日付・時刻の扱い

`get_candles` の日付・時刻は `tz` パラメータ（既定 `Asia/Tokyo`）で統一的に扱う。

| 項目 | tz の影響 | 説明 |
|---|---|---|
| `date` パラメータ | 受ける | `YYYYMMDD` は tz の暦日として解釈。指定日の終端 `23:59:59.999`（in tz）以前の `limit` 本を返す。 |
| `isoTime` | 受けない | 常に UTC ISO 文字列（例: `2025-10-02T00:00:00.000Z`）。 |
| `isoTimeLocal` | 受ける | tz のローカル時刻文字列（例: `2025-10-02T09:00:00`）。 |
| `keyPoints.date` | 受ける | tz 暦日の `YYYY-MM-DD`。 |
| `priceRange.periodStart` / `periodEnd`（summary 上） | 受ける | tz 暦日の `YYYY-MM-DD`。 |

`tz` 未指定・空文字・不正値はすべて `Asia/Tokyo` にフォールバック。UTC で扱いたい場合は明示的に `"UTC"` を渡す。

### `limit` はローソク足本数（日数ではない）

`limit` は「日数」ではなく「ローソク足本数」を指す。`date=YYYYMMDD` で指定したアンカーの終端（tz）以前で、本数を `limit` だけ遡って返す。

例: `1hour`, `date=20251002`, `limit=24`, `tz=Asia/Tokyo`
→ JST 2025-10-02 の 24 本（00:00〜23:00、JST 暦日）を返す。

サブ日次タイプ（`1min/5min/15min/30min/1hour`）の場合、bitbank API は UTC 暦日でグルーピングするため、`tz=Asia/Tokyo` の指定日は内部的に隣接 UTC 日（例: `/20251001` + `/20251002`）を fetch して tz 暦日終端で絞り込む。詳細は [docs/internal/bitbank-candle-tz.md](internal/bitbank-candle-tz.md) を参照。

### よくあるエラー

`errorType` は `user` / `upstream` / `network` の 3 系統。`user` は呼び出し側のパラメータ起因、`upstream` は bitbank API 起因、`network` は通信起因。

| 状況 | メッセージ例（抜粋） | errorType |
|---|---|---|
| 未来日付の `date` | `No candle data available for date=20991231 (date is in the future, anchor=...)` | `user` |
| bitbank サービス開始前 | `No candle data available for date=20100101 (before bitbank service start)` | `user` |
| 上流が success:0 を返した | `bitbank API がエラーを返却しました（code: 10000）` | `upstream` |
| 上流が空配列を返した | `No candle data returned from bitbank API for ${pair} / ${type} / ${date}` | `user` |
| anchor filter 後 0 件 | `No candle data available for ${pair} / ${type} on or before date=${date} (data range exists but does not include this date)` | `user` |
| 4hour/8hour/12hour に対する 404 | `HTTP 404 Not Found (${pair}/${type}). ${type} は YYYY 形式（例: 2025）が必要です。...` | `user` |
| その他の 404 | `HTTP 404 from bitbank API for ${pair} / ${type} / ${date} (unknown reason; check pair/type/date validity)` | `user` |
| 並列取得の過半数が失敗 | `ローソク足取得の過半数が失敗しました（${N}年中${M}年失敗）` | `upstream` |

---

## detect_patterns 詳細ガイド

### 表示日時の tz 化

`tz` パラメータ（既定 `Asia/Tokyo`）で表示日時を整形する。`get_candles` の `tz` と揃えるのが推奨。

| 項目 | tz の影響 | 説明 |
|---|---|---|
| summary 内の検出パターン期間表示 | 受ける | `期間: 2025-10-01 ~ 2025-11-05` 等。 |
| content 内のスキャン範囲 | 受ける | `スキャン範囲: 2026-08-05 07:00 ~ 2026-08-21 21:00（399本）`。日足未満は時刻まで表示。 |
| content 内の検出パターン分布期間 | 受ける | `検出パターン分布期間: 2025-07-01 ~ 2025-12-31`。 |
| `data.patterns[*].range.start/end` | 受けない | 後方互換のため UTC ISO 文字列のまま。 |
| `meta.scan.start/end` | 受けない | 後方互換方針に合わせ UTC ISO 文字列のまま。 |
| `data.patterns[*].structureRange.start/end` | 受けない | 同上。 |
| `data.patterns[*].precedingTrend.start/end` | 受けない | 同上。 |
| 構造化データの `isoTime`（pivots / debug 等） | 受けない | UTC ISO 文字列のまま。 |

`tz` 空文字・解決できない IANA 名（`Tokyo` / `Not/AZone` 等）は `Asia/Tokyo` にフォールバックする
（`lib/datetime.ts` の `resolveTz`）。`formatDateInTz` / `toIsoWithTz` 自体は不正 tz に対して `null` を
返す契約なので、**表示側が `resolveTz` を通す**。通さないと表示行が丸ごと消えたり日付が空文字になる。

### 期間 2 行の意味（混同注意）

`summary` / `detailed` / `full` の `content` にはヘッダ直下に 2 行が出る。**別の量**なので混同しないこと。

| 行 | 何を指すか | 構造化データ |
|---|---|---|
| `スキャン範囲` | 検出器に**実際に渡した足**の先頭 / 末尾 / 本数。 | `meta.scan` |
| `検出パターン分布期間` | 検出された**パターンの分布**（全 `range.start` の最小 〜 全 `range.end` の最大）。 | `data.patterns[*].range` |

旧ラベル「検出対象期間」は後者を指していたが、名前がスキャン窓を指しているように読めるため
「1時間足で直近1日分がスキャンされていない」という誤読を招いていた（分布期間の終端は
最後に検出されたパターンの終わりであって、データの終端ではない）。

ヘッダの `{limit}本から` は**要求本数**であってスキャン本数ではないため、`スキャン範囲` の本数と
食い違うことがある（例: `limit=200` に対し `399本`）。`debug` view は出力を置換する階梯外の
view なので、この 2 行は出ない。

### 内部仕様メモ

- bitbank `/candlestick` の UTC グルーピング実測ログ: [docs/internal/bitbank-candle-tz.md](internal/bitbank-candle-tz.md)

---

## run_backtest 詳細ガイド

### 利用可能な戦略

| 戦略 | 概要 | 主要パラメータ |
|------|------|----------------|
| sma_cross | SMAクロスオーバー | short, long + フィルター |
| rsi | RSI売られすぎ/買われすぎ | period, overbought, oversold |
| macd_cross | MACDクロスオーバー | fast, slow, signal + フィルター |
| bb_breakout | ボリンジャーバンドブレイクアウト | period, stddev |

### sma_cross エントリーフィルター

買いシグナル（ゴールデンクロス）にのみフィルターが適用されます。売り（デッドクロス）はフィルターなしで常に通します。

| パラメータ | 型 | デフォルト | 説明 |
|------------|-----|-----------|------|
| short | number | 5 | 短期SMA期間 |
| long | number | 20 | 長期SMA期間 |
| sma_filter_period | number | 0（無効） | 価格がSMA(N)より上の場合のみ買い（例: 200） |
| rsi_filter_period | number | 0（無効） | RSI計算期間（例: 14） |
| rsi_filter_max | number | 100（無効） | RSIがこの値未満の場合のみ買い（例: 70） |

フィルター有効時、チャートのオーバーレイに SMA フィルターライン（purple）/ RSI ライン（lavender）が自動追加されます。

### macd_cross エントリーフィルター

買いシグナル（ゴールデンクロス）にのみフィルターが適用されます。売り（デッドクロス）はフィルターなしで常に通します。

| パラメータ | 型 | デフォルト | 説明 |
|------------|-----|-----------|------|
| sma_filter_period | number | 0（無効） | 価格がSMA(N)より上の場合のみ買い（例: 200） |
| zero_line_filter | number | 0（なし） | -1: MACD≤0で買い（反転狙い）, 1: MACD≥0で買い（トレンド継続） |
| rsi_filter_period | number | 0（無効） | RSI計算期間（例: 14） |
| rsi_filter_max | number | 100（無効） | RSIがこの値未満の場合のみ買い（例: 70） |

フィルター有効時、チャートのオーバーレイに SMA ライン（price パネル）/ RSI ライン（indicator パネル）が自動追加されます。

### 入力例

```json
// sma_cross + SMA200トレンドフィルター
{
  "pair": "btc_jpy",
  "period": "6M",
  "strategy": {
    "type": "sma_cross",
    "params": { "short": 5, "long": 20, "sma_filter_period": 200 }
  }
}

// sma_cross + RSI70未満フィルター
{
  "pair": "btc_jpy",
  "period": "3M",
  "strategy": {
    "type": "sma_cross",
    "params": { "rsi_filter_period": 14, "rsi_filter_max": 70 }
  }
}

// macd_cross + SMA200トレンドフィルター
{
  "pair": "btc_jpy",
  "period": "6M",
  "strategy": {
    "type": "macd_cross",
    "params": { "sma_filter_period": 200 }
  }
}

// ゼロライン以下でのみ買い（反転狙い）
{
  "pair": "btc_jpy",
  "period": "6M",
  "strategy": {
    "type": "macd_cross",
    "params": { "zero_line_filter": -1 }
  }
}

// RSI70未満フィルター付き
{
  "pair": "btc_jpy",
  "period": "3M",
  "strategy": {
    "type": "macd_cross",
    "params": { "rsi_filter_period": 14, "rsi_filter_max": 70 }
  }
}

// 全部盛り
{
  "pair": "btc_jpy",
  "period": "6M",
  "strategy": {
    "type": "macd_cross",
    "params": {
      "sma_filter_period": 200,
      "zero_line_filter": -1,
      "rsi_filter_period": 14,
      "rsi_filter_max": 70
    }
  }
}
```

### 出力指標

| 指標 | 説明 |
|------|------|
| total_pnl_pct | 総損益 [%] |
| trades | トレード数 |
| win_rate | 勝率 [%] |
| max_drawdown_pct | 最大ドローダウン [%] |
| avg_pnl_pct | 1トレードあたり平均損益 [%] |
| profit_factor | Profit Factor（総利益 / 総損失）。全勝時は null |
| sharpe_ratio | 年率換算 Sharpe Ratio（日次リターン × √365） |

### チャート出力先（savePng / outputDir）

`savePng: true` 時の `outputDir` は、任意パスへの書き込みを防ぐため**許可 root 配下のみ**受け付けます
（`lib/validate.ts` の `ensureAllowedOutputDir`）。許可外のパスはバックテスト実行前にエラーで弾かれます。
判定は `..` とシンボリックリンクを解決した実パスで行うため、トラバーサルや symlink では迂回できません。

既定の許可 root:

- `/mnt/user-data/outputs`（デフォルト出力先。Claude.ai 環境）
- サーバー作業ディレクトリ配下（相対パス指定・Cursor 等でワークスペース内に書き出す場合）

それ以外のディレクトリへ書き出す場合は、サーバー起動時に環境変数
`BACKTEST_OUTPUT_DIR_ALLOWLIST` で root を追加します（`path.delimiter` 区切り。LLM 入力からは追加できません）:

```bash
export BACKTEST_OUTPUT_DIR_ALLOWLIST="/path/to/outputs:/another/dir"
```

