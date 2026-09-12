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
| `preview_cancel_order` | キャンセル内容のプレビュー + 確認トークン発行。終端状態（全量約定 / キャンセル済み / 拒否）はトークン発行前に拒否し、`INACTIVE` / `TRIGGERED` は通す |
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
| `detect_patterns` | `debug` | 検出パターンが `content` から消え、swings / candidates の一覧に入れ替わる（**`candidates` のみ** `patterns` で絞られる。`swings` は種別に依らないので全件。後述） |
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

### スイング検出パラメータは時間軸オート（**スキーマ既定値は sentinel**）

`swingDepth` / `tolerancePct` / `minBarsBetweenSwings` は**未指定なら時間軸ごとの既定値に解決される**
（`tools/patterns/config.ts` の `getDefaultParamsForTf` / `getDefaultToleranceForTf`）。

| 時間足 | `swingDepth` | `minBarsBetweenSwings` | `tolerancePct` |
|---|---|---|---|
| `1min` / `5min` | 2 | 1 | 0.04 |
| `15min` / `30min` | 3 | 2 | 0.06 |
| `1hour` | 3 | 2 | 0.05 |
| `4hour` | 5 | 3 | 0.05 |
| `8hour` / `12hour` | 5 | 3 | 0.045 |
| `1day` | 6 | 4 | 0.04 |
| `1week` | 7 | 5 | 0.035 |
| `1month` | 8 | 6 | 0.03 |

**`swingDepth` はピボット列を通じて #242 の経路ゲートの判定も動かす。**
`peak_after_last_pivot` / `trough_after_last_pivot` と再進入チェック（`re_entered_trough_zone`）は、
パターンの構成点と**同じ `swingDepth` で取ったピボット列**で判定する。深さを増やすと小さな戻しは
ピボットにならず、ゲートも発火しない。**同じ値動きで `swingDepth=3` では `invalid`、`6` では
`completed` になりうるのは仕様**（issue #251）。実例: 実データ D（`btc_jpy` / `1hour` / 2026-09-05）の
`double_top 329-334-338` は、既定の深さ 3 では経路上の H ピボット idx 343 が `peak_after_last_pivot` を
立てるが、深さ 6 では idx 343 が極値にならない（`high[337] = 12,750,000` が上にある）ため
完成済みのまま残る。この深さ依存は `tests/patterns/breakout-path-double.test.ts` が仕様として固定している。

**同じピボット列の性質から、判定は `limit`（窓の終端位置）にも依存する。**
`detectSwingPoints` は極値判定に前後 `swingDepth` 本を要求する（ループの範囲が
`i ∈ [swingDepth, length − swingDepth)`）ので、**窓の最後の `swingDepth` 本はピボットに
なれない**（最後にピボットになりうるのは `length − swingDepth − 1`、つまり終端からちょうど
`swingDepth` 本前の足）。経路ゲートと再進入チェックはピボット列で判定するため、
**再上昇（再下落）の足がこの終端の余白に入るとゲートは発火しない**。結果として、
**同じ値動きでも `limit` の違いで `completed` / `invalid` が変わりうるのは仕様**（issue #277）。

実例: 上と同じ `double_top`（山1 `2026-09-03T21:00Z` / 谷 `2026-09-04T02:00Z` /
山2 `2026-09-04T06:00Z`、再上昇 `2026-09-04T11:00Z`、ブレイク `2026-09-04T12:00Z`）を
**`swingDepth` は既定（`1hour` の auto = 3）のまま**、窓の終端だけ動かすと:

| 窓の終端 | 再上昇の足の位置 | 結果 |
|---|---|---|
| `2026-09-04T13:00Z` | 終端の **2 本前**（余白の中） | **`completed`**（`data.patterns` に出る。`view=debug` にも `peak_after_last_pivot` の候補が無い） |
| `2026-09-04T16:00Z` | 終端の **5 本前**（ピボットになる） | **`invalid` / `peak_after_last_pivot`**（既定では消え、`includeInvalid: true` で出る） |

境界は「再上昇の足が最後の `swingDepth` 本から外れるか」で、上の例では終端が
`2026-09-04T14:00Z`（再上昇の足が終端からちょうど 3 本前 = 走査範囲の右端）になった時点で
`invalid` に変わる。

**#251 の深さ依存との違いは、利用者が選べるかどうか。** `swingDepth` は呼び出し側が明示的に
選ぶが、窓の終端はデータの取得時刻で決まる。とはいえ本質は「**窓の終端の足はまだピボットとして
確定していない**」という正しい制約で、ゲートが未確定の足を無視するのは設計どおり——問題は
それを申告していなかったことで、本節がその申告にあたる。この `limit` 依存も
`tests/patterns/breakout-path-double.test.ts` が仕様として固定している。
なお終端の余白そのものは `limit` の実効下限（下の「`limit` の実効下限」の節 §1）にも効く。

`headProminencePct`（H&S / 逆 H&S 専用。頭が両肩よりどれだけ突出すべきかの最小要求率）は
`tolerancePct` とは**独立の専用時間軸オート表**（`getHeadProminenceForTf`）を持つ
（issue #198。#149〜#197 は誤って `tolerancePct` の表を流用しており、`1hour` が `1day` より
頭の突出要求が 25% 厳しくなる逆転が起きていた）。**`tolerancePct` は大きいほど緩く、
`headProminencePct` は大きいほど厳しいので、値の意味も表も別**であることに注意。

| 時間足 | `headProminencePct` |
|---|---|
| `1min` | 0.0011 |
| `5min` | 0.0024 |
| `15min` | 0.0041 |
| `30min` | 0.0058 |
| `1hour` | 0.0083 |
| `4hour` | 0.0163 |
| `8hour` | 0.0231 |
| `12hour` | 0.0283 |
| `1day` / `1week` / `1month` | 0.04（アンカー。据え置き） |

**スキーマ既定値そのもの（`swingDepth=7` / `tolerancePct=0.04` / `minBarsBetweenSwings=5`）を
明示的に渡しても、時間軸オートに置換される。** `resolveParams` が「スキーマ既定値と等しいか」で
未指定を判定しているため、この 3 値だけは固定値として要求できない。

| 呼び出し | `1hour` | `4hour` | `1day` |
|---|---|---|---|
| `{swingDepth: 7, tolerancePct: 0.04, minBarsBetweenSwings: 5}` | 3 / 0.05 / 2 | 5 / 0.05 / 3 | 6 / 0.04 / 4 |
| `{swingDepth: 6, tolerancePct: 0.041, minBarsBetweenSwings: 4}` | 6 / 0.041 / 4 | 6 / 0.041 / 4 | 6 / 0.041 / 4 |

**1 だけずらせば通る。ちょうど既定値のときだけ通らない。** 実害は「緩めたつもりが no-op」で、
`1hour` で `tolerancePct` を 0.04 → 0.05 に変えても実効値は前後とも 0.05（issue #182）。
緩める / 締めるの判断は**上の表の時間軸オート値との比較**で行うこと。

`headProminencePct` だけがこの問題を持たない——スキーマに `.default()` を付けておらず、
`undefined` が正規の sentinel になっているため、明示値はすべてそのまま通る（#149 / PR #153）。
3 パラメータから `.default()` を外す案は本 issue のスコープ外（#182 案 B）。

### 実効パラメータは content に出る（#184）

**解決後の実効値は推測しなくていい。** 4 つの view すべて（`debug` を含む）で 1 行出る。
**位置は view で違う**（行頭ラベルが一意なので機械的な抽出には影響しない）: `debug` はヘッダの直下、
`summary` / `detailed` / `full` は期間 2 行の**下**（＝ヘッダから 4 行目）。

```text
実効パラメータ（入力値ではない）: swingDepth=3(auto) / minBarsBetweenSwings=2(auto) / tolerancePct=0.05(auto) / headProminencePct=0.0083(auto) ※auto=1hour の時間軸オート値（スキーマ既定値 7/5/0.04 の明示指定も auto。headProminencePct は tolerancePct とは別表）
```

| 表記 | 意味 |
|---|---|
| `(auto)` | 上の時間軸オート表から解決した。**「未指定」と「スキーマ既定値の明示指定」を畳んでいる**（`.default()` がある限り両者は区別できない） |
| `(指定)` | 渡した値がそのまま効いた |

`swingDepth=7` を渡して `swingDepth=3(auto)` と出るのが sentinel 置換の起きた状態。
末尾の `※` 注記は `auto` が 1 つも無い呼び出し（全パラメータ明示）では出ない。

構造化データは `meta.effective_params`（パラメータごとに `{ value, source }`）。
**#184 まで出力スキーマに宣言が無く `parse()` が黙って strip していたため、
このフィールドはどのクライアントにも届いていなかった。** `meta` のキーとスキーマ宣言の一致は
`tests/detect_patterns_meta_schema_parity.test.ts` が parse 後の実出力で固定している。

検出 0 件のときの緩和の助言も**実効値基準**になっている
（`緩めるなら tolerancePct に実効値 0.05 より大きい値を指定してください`）。
旧文言の「0.03-0.06 に緩和」は実効 0.05 の `1hour` では半分が締める方向だった。

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

`summary` / `detailed` / `full` の `content` にはヘッダ直下に 2 行が出る（`debug` では出ない。
実効パラメータ行だけは 4 view 共通で、この 2 行の**下**に来る）。**別の量**なので混同しないこと。

| 行 | 何を指すか | 構造化データ |
|---|---|---|
| `スキャン範囲` | 検出器に**実際に渡した足**の先頭 / 末尾 / 本数。 | `meta.scan` |
| `検出パターン分布期間` | 検出された**パターンの分布**（全 `range.start` の最小 〜 全 `range.end` の最大）。 | `data.patterns[*].range` |

旧ラベル「検出対象期間」は後者を指していたが、名前がスキャン窓を指しているように読めるため
「1時間足で直近1日分がスキャンされていない」という誤読を招いていた（分布期間の終端は
最後に検出されたパターンの終わりであって、データの終端ではない）。

`debug` view は出力を置換する階梯外の view なので、この 2 行は出ない。

### スキャン窓 = 直近 `limit` 本

`analyze_indicators` は「表示窓 `limit` 本」の前に指標の warmup 分を足した配列を返す
（`SMA_200` / `EMA_200` のぶん `fetchCount = limit + 199`）。先頭の warmup 本数は
`chart.meta.pastBuffer` で伝えられ、**表示窓が必要な側が `slice(pastBuffer)` する契約**
（`render_chart_svg` の `items.slice(pastBuffer)` が同じ idiom）。

`detect_patterns` はこの slice を忘れて全件を走査していたため、`limit=200` の要求に対し
399 本を走査し、ヘッダの `{limit}本から` が虚偽表示になっていた。現在は `pastBuffer` 分を
落としてから検出器に渡すので、ヘッダ・`スキャン範囲`・`meta.scan` の 3 者が一致する。

`pastBuffer` が取れない場合は 0 に畳んで全件走査にフォールバックする（上流の形が変わっても
検出を落とさないため）。データが `limit` に満たない場合はヘッダの要求本数と `スキャン範囲` の
実本数が食い違うが、実際に走査した本数は常に `スキャン範囲` / `meta.scan` が示す。

#### インデックスの基準（スキャン窓相対）

出力に現れるローソク足インデックスは **`meta.scan` が示すスキャン窓を基準とした 0 始まりの位置**。

| フィールド | 基準 |
|---|---|
| `data.patterns[*].pivots[].idx` | スキャン窓 |
| `data.patterns[*].breakoutBarIndex` | スキャン窓 |
| `data.patterns[*].confirmation.idx` | スキャン窓 |
| `meta.debug.swings[].idx` / `meta.debug.candidates[].indices` / `…points[].idx` | スキャン窓 |

`analyze_indicators` の `chart.candles` は warmup 分（`chart.meta.pastBuffer` 本）を先頭に含む
**別配列**なので、これらをそのまま添字として使ってはいけない（使うなら `pastBuffer` を足す）。

### `pivots` は種別混在の構造点リスト（主構成点は `kind` で取る）

`data.patterns[*].pivots` は**主構成点とネックライン定義点が混在した**リストで、主構成点は
位置ではなく `kind` で識別する（`triple_top` / H&S は `H`、`triple_bottom` / 逆 H&S は `L`。
`tools/patterns/mutual-exclusion.ts` の `mainPointIdxs` が同じ取り方をしている）。
反転系は**すべて**ネックライン定義点を含む（#224 症状 3 で triple を他に揃えた）:

| 検出器 | `pivots` の並び | ネックライン定義点 | 水平ネックラインの `y` |
|---|---|---|---|
| H&S / 逆 H&S | `[p0, p1, p2, p3, p4]` | `p1` / `p3` | — （H&S は傾きあり。`neckline` を参照） |
| double（完成済み / near_completion） | `[a, b, c]` | `b` | `b.price` |
| triple（完成済み / near_completion） | `[a, v1, b, v2, c]` | `v1` / `v2` | `(v1.price + v2.price) / 2` |
| triple（形成中） | `[a, v1, b, v2]` | `v1` / `v2` | 同上 |

形成中 triple の 3 点目は現在価格の暫定値なので `pivots` に入らない
（content の「3 山目は現在価格を暫定」注記がそれを言う）。
**double 2 型に形成中は無い**——`double_bottom` は #262、`double_top` は #268 案 C で
形成中経路を削除した。構造が揃ってブレイクを待つ段階は `near_completion` として
完成済み経路が 3 点で出すので、**double の `pivots` は常に 3 点**。**消費者は `pivots.length` で構成を判定しないこと**——
主構成点が要るなら `kind` で絞る。`view=debug` の `candidates[].points[].role` も同じ表から
`main` / `neckline` を決めている。

#### 継続系（`triangle_*` / `wedge_*`）の `pivots`

継続系も `pivots` を出すが、**上の表とは性質が違う**（`wedge_*` は issue #252 から）。

| 検出器 | `pivots` の中身 | 点数 |
|---|---|---:|
| `triangle_*` | 上下トレンドラインの回帰に使った relaxed swing（peaks / valleys） | 可変 |
| `wedge_*` | 上下トレンドラインの**非ブレイクタッチ点すべて**（ブレイク足は含めない。**ブレイク足以降は線を問わず除外**。#281） | 可変 |

- **役割ラベルが無い。** 点数が可変で「山1 / 谷 / 山2」のような位置の意味づけができないため、
  `view=full` の content に構成点の明細行は**出ない**（`src/handlers/detectPatternsViewsHandler.ts` の
  表引きが該当なしで抜ける。issue #234）。使うなら `structuredContent` 側を `kind` と `idx` で読むこと。
- **ネックライン定義点という概念が無い。** 継続系の水準はトレンドライン（`neckline` は
  `triangle_*` のみ、ブレイク側の線）であって構成点の平均ではない。
- **`price` は高安**（`extremePrice` と同値）。下の「`pivots[].price` は終値、`extremePrice` が判定値」を参照。
- **点数は窓の長さとタッチの多さに比例する。** `wedge_*` は 0.5% 以内をタッチとみなす
  （`helpers.ts` の `evaluateTouchesEx`）ので、収束が進んで上下の幅が 0.5% を切った区間では
  ほぼ全バーが構成点になる（BTC/JPY 1hour の実測で 31〜107 点）。**件数を「形の良さ」の
  代理指標に使わないこと**——整合度は `confidence` を見る。
- **ブレイク足以降は線を問わず除外する**（#281）。`evaluateTouchesEx` は「線を割った / 抜けた」を
  **線ごとに独立に**判定するので、下方ブレイクの足は下側ラインについてはブレイク扱いでも、
  高値が上側ラインの 0.5% 以内にあれば**上側の非ブレイクタッチ点として残っていた**
  （実データで実体 8 / 59、うち 7 件が `rising_wedge`。PR #280 §5-1）。
  いまは `breakoutBarIndex` 以降の点を上下どちらの線からも落とすので、**`pivots` の
  `idx` は必ず `breakoutBarIndex` より小さい**。未ブレイクのウェッジには打ち切りが無い。
  **タッチ数・`confidence`・採否は変わっていない**——除外は出力用の構成点にだけ効く。
- `wedge_*` の構造図（`structureDiagram`）が描く点は `pivots` とは**別に組んでいる**。
  図は 6 点まで間引いたうえで `price` に終値を入れているので、**同じ `idx` でも価格が違う**。

### `pivots[].price` は終値、`extremePrice` が判定値

スイング検出（`tools/patterns/swing.ts`）は**極値判定を高値 / 安値で行い、`price` には終値を入れる**。
ヒゲ 1 本で同水準判定やネックラインが動くのを避けるための意図的な設計だが、`price` だけを見ると
「終値基準で極値を取っている」と読めてしまう（実際にそう誤読された）。

| フィールド | 中身 |
|---|---|
| `data.patterns[*].pivots[].price` | その足の**終値**。構造比較（同水準判定・ネックライン）に使う値 |
| `data.patterns[*].pivots[].kind` | `H`（山 / 高値側）または `L`（谷 / 安値側） |
| `data.patterns[*].pivots[].extremePrice` | **極値判定に実際に使った値**。`kind=H` なら `high`、`kind=L` なら `low` |

`view=full` の `content` では double_top / double_bottom の構成点 3 行に両方が出る
（例: `谷1: 2026-08-03 終値 10,002,960円 / 安値 9,752,246円（判定は安値基準）`）。

**`price` の基準は検出器ごとに違う。全ツール共通で不変なのは `extremePrice` の方だけ。**

| 構成点の出どころ | `price` | `extremePrice` |
|---|---|---|
| `detectSwingPoints`（double / triple / H&S） | 終値 | 判定に使った `high` / `low` |
| `detect_triangles` の relaxed swing（`triangle_*`） | **`high` / `low`** | 同左（`price` と同値） |
| `detect_wedges` のトレンドラインタッチ点（`wedge_*`） | **`high` / `low`** | 同左（`price` と同値） |
| 形成中 H&S / 逆 H&S の暫定右肩 | 最新足の終値 | 同左（極値判定を通っていない） |

三角形が終値を経由しないのは、**トレンドライン（`upperLine` / `lowerLine`）をこの高安列に
回帰させており、`neckline` もその線から取る**ため。ウェッジも同じ論理で高安に揃えてある——
構成点がトレンドラインへの**タッチ点**で、タッチ判定自体が高安と線の距離で行われている。`price` を終値に差し替えると構成点が
自分のトレンドライン上に乗らなくなり、`aftermath.theoreticalTarget`
（`min` / `max(pivots[].price)` 由来）も動く。同値であることは欠損ではなく
「この検出器は終値を経由していない」という情報として読むこと。
契約は `tests/detect_patterns_debug.test.ts` が固定している。

### ターゲット到達（`targetReached*`）は**値動きの記述であって成績ではない**（#288）

`detect_patterns` はブレイク後の値動きが想定ターゲットに届いたかを出すが、
**これを予測力・勝率の指標として読まないこと。**

実データで到達率そのものを測ると、**どの窓幅（5〜60 本）でもパターン起点の到達率は帰無
（同じ距離のターゲットを任意のバーに置いたとき）を上回らない**。主表（母集団 n = 38 /
帰無の試行 m = 11,590）の差は N = 5 / 10 / 20 / 30 / 60 でそれぞれ
−5.2 / −8.5 / −0.8 / −4.9 / −8.3 pt で**全部負**。さらに走査窓に他パターンのブレイクが
入る実体が **94.7%** ある。計測の全文は tjackiet/bitbank-lab-mcp#288 の計測記録。

**`1day` では評価できていない**（ブレイク足の後に 60 本残る実体が 0 件。「1day でも問題ない」ではなく
「1day では測れていない」と読むこと）。

#### 「どこまで走ったか」と「いつ届いたか」は別のフィールド

| フィールド | 中身 |
|---|---|
| `targetReachedPct` | ブレイク価格から `breakoutTarget` までを 100% としたときの、**ブレイク後 60 本の値動きの記述**。分子は走査窓の extremum（up=最高 high / down=最安 low）。**100 を超える値は「進捗」ではなく、目標幅に対する到達幅の倍率**で、到達した後の値動きを含む。値域は 0〜99（未到達）または 100〜999（到達済み。999 ちょうどは「999% 以上」）。**成績・予測の指標として読まない** |
| `targetReached` | ブレイク足から 60 本以内に届いたか |
| `targetReachedDate` / `targetReachedPrice` | **extremum が付いた足**の時刻と価格。「届いた足」ではない |
| `targetFirstReachBars` | **初めて届いた足**が、ブレイク足を 0 本目として何本目か。未到達なら出ない |
| `targetFirstReachDate` | `targetFirstReachBars` が指す足の時刻（UTC ISO）。未到達なら出ない |
| `targetScanBars` | 実際に走査した本数（ブレイク足を除く後続の本数）。`min(60, 系列末尾までの本数)` |
| `targetScanComplete` | `targetScanBars === 60`。`false` なら「届かなかった」ではなく**まだ足が無い** |
| `targetProgressOmittedReason` | 進捗系を出さなかったことの申告（6 コード。スキーマの `.describe()` が単一ソース） |

**`targetReachedDate` と `targetFirstReachDate` は普通に別の足になる。** 実データ B の
`falling_wedge`（ブレイク `2026-08-17T15:00Z`）は初到達が 3 本目（`08-17T18:00Z`）だが、
extremum は 60 本後まで伸びて `08-20T01:00Z`、`targetReachedPct` は 999（上限）になる。

#### 到達の帰属を切る交絡（2 フィールド）

到達したからといって、その 60 本の間に別のパターンがブレイクしていれば、
届いた理由をこのパターンに帰属させられない。ただし**素朴に出すと 94.7% に付いて申告にならない**ので、
付ける条件を絞ってある。

| フィールド | 対象 | 区間 | 方向 |
|---|---|---|---|
| `targetOtherBreakoutBeforeReach` | **到達した**パターン | `(自分のブレイク, 自分の初到達)` の**開区間** | **問わない** |
| `targetOppositeBreakoutInWindow` | **未到達の**パターン | `(自分のブレイク, 自分のブレイク + targetScanBars]` | **逆方向のみ** |

要素は `{ type, direction, barsAfterBreakout }`（本数は自分のブレイク足を 0 本目とした相対値）。
**空ならキーごと出ない。** 出ていないことは「自力で届いた」の証明ではなく、
基準集合の中に該当が無かったという意味。

- 基準集合は **accepted のみ**（`status` が `invalid` / `expired` / `forming` / `near_completion` でないもの）。
  **`includeInvalid: true` でも変わらない**——変えると同じ値動きへの申告が呼び出しオプション次第で動く。
- **`patterns` で絞ると基準集合も絞られる。** `patterns: ['triangle']` の呼び出しでは、
  ウェッジや H&S のブレイクはそもそも検出されていないので交絡として数えられない
  （その呼び出しが返した集合の中の話、という定義そのもの）。**全種別で呼んだときより件数が減る。**
  帰属を厳しく見たいときは `patterns` で絞らずに呼ぶこと。判定フィールド
  （`confidence` / `status` / `targetReachedPct` 等）はこの絞り込みで動かない
  （`tests/detect_patterns_debug.test.ts` が両方を固定している）。
- 到達側で方向を問わないのは、**同方向の後続パターン経由でも帰属が切れる**ため
  （Phase 1 の予備監査で 20 本超の到達 6 件のうち 4 件が同方向）。
- 未到達側を逆方向に限るのは、同方向まで含めると 94.7% に付くため。
  **「逆方向へ行ったから届かなかった」とは言っていない**——順序は測っていない。

#### `content` に出る 3 形（100% 超の数字は出さない）

`content[0].text` が LLM への唯一のチャネルなので、上の事実は行の文言にも反映してある。
**「進捗 273%」のような 100 超の百分率は出さない**（到達後の超過倍率を「進捗」と読ませていたのが
issue #288 の症状）。行頭ラベルは 4 形とも `ターゲット:` で、価格は直前の `ターゲット価格:` 行が持つ。

```text
   - ターゲット価格: 12,930,667円（パターン高さ投影）
   - ターゲット: 到達（ブレイク後 12 本目、2026-08-25 11:00）

   - ターゲット価格: 10,149,705円（パターン高さ投影）
   - ターゲット: 未到達（走査 60 本完了、目標幅の 26% まで接近）。走査窓内に逆方向のブレイクあり（triangle_ascending 上方 +28 本）

   - ターゲット価格: 13,050,465円（パターン高さ投影）
   - ターゲット: 未到達（ブレイク後 25 本経過 / 走査上限 60 本、目標幅の 61% まで接近）

   - ターゲット価格: 12,602,209円（ネックライン投影）
   - ターゲット: 出力なし（ブレイク足が想定値幅の85%以上を消化済みで、残り距離が短く進捗率が意味を持たないため）
```

- 「目標幅の x% まで接近」の x は `targetReachedPct`（未到達側は 99 でキャップ済み）。
- 交絡の注記は該当があるときだけ末尾に付く（到達側は「到達前に別パターンのブレイクあり」、
  未到達側は「走査窓内に逆方向のブレイクあり」）。
- **4 形とも `view` に依らず出る**（`summary` / `detailed` / `full`。`debug` はパターン明細自体が出ない）。
- `TARGET_REACH_MAX_BARS = 60` は**取りこぼし防止の走査幅であって成績の窓ではない**。
  縮める根拠となる値がコーパスに無いため据え置いてある（#288 Phase 2 の決定）。

### double の content には「山2 / 谷2 の位置」行が必ず出る（#245）

`double_top` / `double_bottom` の明細には、**閾値を持たない 1 行**が常に付く。

```text
   - 山2 の位置: 終値はネックラインの +9.9%（パターン高さ比）/ ヒゲ 73.3%
```

**この行は上の混合基準（極値は高安・同水準は終値）の帰結を読み手が判断するためにある。**
「終値ではネックラインのすぐ上にいるだけの足でも、高安ではダブルトップとして山1 と同水準」
という形が実在する（issue #245 の発端の形が上の数値そのもの。上ヒゲがパターン高さの 73.3% で、
終値はネックラインの 9.9% 上）。`content[0].text` が LLM への唯一のチャネルなので、
この行が無いと「山2 は終値では存在せずヒゲだけだった」ことを読み取る手段が無い。
**これは棄却でも減点でもない**——`confidence` も `data.patterns` も一切動かない。

| 項目 | 中身 |
|---|---|
| 分母（パターン高さ） | 構成点 3 点の `extremePrice` の全振幅（`tools/patterns/structural.ts` の `levelSpreadMetrics().heightAbs`）。**高安基準**で、同水準ゲート（`peaks_diff_vs_height_excess`）と同じ量 |
| 終値の位置 | `(山2 / 谷2 の終値 − ネックライン) ÷ パターン高さ`。**符号は価格の向き**（`+` が上、`-` が下）なので、正常な `double_bottom` は `-x%` になる |
| ヒゲ | top は `(高値 − 終値) ÷ パターン高さ`、bottom は `(終値 − 安値) ÷ パターン高さ`。向きを持たないので符号は付かない |
| 出る条件 | `status` が `completed` / `near_completion` / `expired` / `invalid` のいずれでも出る。**`view` にも依らない**（`summary` / `detailed` / `full`。`debug` はそもそもパターン明細を出さない階梯外の view） |
| 出ない条件 | パターン高さが 0 か、`extremePrice` が欠けているとき。**`n/a` は出さず 1 行まるごと出さない**（構成点の価格が読めないことの申告ではなく、この形では量が定義できないという意味なので） |

- **値は `pivots` から導出しているので `structuredContent` には無い。** `data.patterns[*].pivots` の
  `price` / `extremePrice` から同じ式で再計算できる（上の表がその式）。
- **`triple_*` / H&S 系には出ない。** H&S はパターン高さの端点が頭と谷で肩が端点にならないため、
  同じ比が肩について何も言わない（#178 項目 3）。`triple_*` は実測で該当が 0 件だった。
- 分布の実測（accepted な double 19 値動きで終値の位置が 3.0%〜74.1%、ヒゲが 7.2%〜73.3%）は
  tjackiet/bitbank-lab-mcp#245 の計測記録。**閾値を置かないと決めた根拠**もそこにある。

### double_top / double_bottom の構造ゲート（hard reject）

`double_top` / `double_bottom` は、形の良し悪しを整合度で減点する前に、
**構造として成立していない候補を検出結果から落とす層**を通る。落ちた候補は整合度が
低く出るのではなく **1 件も出力されない**（理由は `view=debug` の `candidates` に理由コード付きで残る）。

| 理由コード | 意味 |
|---|---|
| `neckline_above_pre_decline_high` | (bottom) ネックラインが先行下落の起点より上。戻り率 > 1.0 で、下抜けという事象が存在しない |
| `neckline_below_pre_decline_low` | (top) 同上の符号反転 |
| `no_neckline_cross_before_trough1` | (bottom) 谷1 より前に、ネックライン水準を**終値で**下抜けたバーが無い |
| `no_neckline_cross_before_peak1` | (top) 同上の符号反転 |
| `retracement_out_of_band` | 戻り率が許容帯（0.20〜0.90）の外 |
| `re_entered_trough_zone` | 谷2 確定後、ネックライン突破前に終値が谷ゾーンへ戻った。`status=invalid` として出る |
| `reclassified_as_triple_bottom` / `_top` | 上記に加えて同水準の第3構成点があるため、triple 側に委ねた |
| `peak_after_last_pivot` / `trough_after_last_pivot` | 最終構成点（山2 / 谷2）とネックライン突破バーの**間**に同種のピボットがある。最終構成点から直接割っておらず、途中でもう 1 つ山（谷）を作っている。**水準は問わない**（同水準でなくても落とす）。**判定に使うピボット列は `swingDepth` に依存する**——深さを増やすと間のピボットが極値でなくなり、ゲートも発火しなくなる（上の「スイング検出パラメータは時間軸オート」の節を参照。issue #251）。`status=invalid` として出る（issue #242） |

**戻り率は `extremePrice`（高安）基準で測る。** `price`（終値）基準は検出器ごとに意味が違う
（上表）だけでなく、実データで帯の余裕が消える——BTC/JPY 日足 2026-08-03 → 08-10 の実在パターンで
高安基準 0.528 に対し終値基準 0.222 と、下限 0.20 まで 2 ポイントしか残らない。

**ネックラインの「線」だけは終値基準**（`neckline` 配列・ブレイク判定と同じ値）。値幅の評価と
線の位置は別問題で、後でブレイクを判定するのと同じ線を検査しないと意味が無いため。

契約は `tests/patterns/structural-gates-btcjpy.test.ts`（実データ fixture）が固定している。

### 形成中 triple の単調性ゲート（#263）

`triple_top` / `triple_bottom` の**形成中**経路は、主構成点 3 点（確定 2 点 ＋ 最新足の終値）が
**単調な階段**に並んでいたら落とす。水平な水準への反復接触ではなくトレンドの継続だから。

| 3 点の並び | 読み | 理由コード |
|---|---|---|
| `main1 < main2 < current` | 上昇継続（`triple_top`）/ 上昇トレンドの押し安値の連続（`triple_bottom`） | `forming_stair_step_up` |
| `main1 > main2 > current` | 下降トレンドの戻り高値の連続（`triple_top`）/ 下降継続（`triple_bottom`） | `forming_stair_step_down` |

**理由コードは向きの名前で、type の名前ではない。** `triple_top` に `forming_stair_step_down` が、
`triple_bottom` に `forming_stair_step_up` が出る。**#263 以前はその 2 通りが出なかった**
（`triple_top` は切り上がりだけ、`triple_bottom` は切り下がりだけを見ていた）。

- 閾値は `FORMING_STAIR_STEP_LIMIT`（2%）を**両向きで共有**する。累積ステップの定義も向きで変えず
  `|current − main1| / main1`。中間点は単調性の判定にだけ使い、大きさには入れない。
- **同水準判定（`forming_peaks_not_level` / `forming_valleys_not_level`）より前に評価する。**
  単調な階段は同水準判定でも落ちうるが、「ばらつきが大きい」より「単調に切り下がっている」の
  ほうが形を言い当てているため。`view=debug` で理由コードを集計するときはこの順序が見える。
- **完成済み経路（`near_completion` を含む）にはこのゲートは無い**
  （3 点すべてが確定ピボットで `tolerancePct` と高さ相対の 2 段が掛かるため）。
  **double にはそもそも形成中経路が無い**——`double_bottom` は #262、`double_top` は #268 案 C で
  削除され、同じ 3 点は完成済み経路が `near_completion` として組む（上と同じ理由でゲートは無い）。
  形成中 `double_top` が残っていた頃は「主構成点が 2 点なので階段が定義できない」ことが
  例外の理由だったが、その例外ごと消えた。

契約は `tests/patterns/detect_triples.test.ts`（合成 fixture の最小対）と
`tests/patterns/stair-step-both-directions-263.test.ts`（実データの実例）が固定している。

### 主構成点とネックラインの位置関係（#216 / #261）

反転パターンは、上の構造ゲートとは別に**主構成点がネックラインの正しい側にあるか**を見る。
`top` は全主構成点が `price > necklinePrice`、`bottom` は `price < necklinePrice` を要求する。
**等号は失格**で、許容幅（つまみ）は無い。

#### 配線されている経路

| 種別 | 完成済み | 形成中 | 比較相手 |
|---|---|---|---|
| `double_*` / `triple_*` | ✅（#216 Phase 2。`near_completion` も同じ検査を通る） | ✅（#261。形成中経路は `triple_*` の 2 つだけ。double に形成中は無い） | **水平スカラー** 1 つ（`validateMainPointsNecklineSide`） |
| `head_and_shoulders` / `inverse_head_and_shoulders` | ✅（#216 の H&S 分。#211 マージ後） | **未配線** | **点ごとの線の値** `necklineAt(idx)`（`validateMainPointsAgainstNecklineAt`） |

**H&S 系だけ比較相手が違うのは、ネックラインが傾きを持ち、肩が定義 2 点の外側に来て外挿が
かかるため。** triple / double のネックラインは水平なので線として評価しても同じ値になり、
スカラー 1 つで足りる。#216 Phase 2 の時点では #211（`necklineAt` の外挿クランプ）の是非が
決まっておらず H&S 系を保留していたが、**#211 マージ後に線基準の別関数で配線済み**。
**形成中 H&S / 逆 H&S は今も未配線**（暫定右肩が確定していないため。`detect_hs.ts` に呼び出しが
無いことを `tests/patterns/neckline-side-hs.test.ts` のトリップワイヤが固定している）。

#### 理由コード

| 理由コード | 経路 | 意味 |
|---|---|---|
| `peaks_below_neckline` | 完成済み（double / triple / H&S 系） | (top) 主構成点（山）のいずれかがネックライン以下 |
| `valleys_above_neckline` | 完成済み（同上） | (bottom) 主構成点（谷）のいずれかがネックライン以上 |
| `forming_peaks_below_neckline` | 形成中（`triple_top`） | 同上（`view=debug` の `▼ reason 横断合計` で完成済みと混ざらないよう語彙を分けてある） |
| `forming_valleys_above_neckline` | 形成中（`triple_bottom`） | 同上 |

**`forming_*` の 2 コードに double が出ない**のは、形成中 `double_bottom` の経路を #262 で、
形成中 `double_top` の経路を #268 案 C で削除したから。同じ 3 点の棄却は完成済み経路の
`valleys_above_neckline` / `peaks_below_neckline` として出る（strict と relaxed の 2 件が並ぶ）。

完成済みの 2 コードは**スカラー版と線版で共通**（判定の意味が同じなので分けていない）。

#### `details`（`view=debug`）

**どの点がどれだけ外れたか**が 1 点ずつ載る（`offenders[].deviation` / `deviationPct` /
`maxDeviation`）。ネックライン水準の出方だけがスカラー版と線版で違う。

| | `necklinePrice` |
|---|---|
| スカラー版（double / triple） | **トップレベルに 1 つ** |
| 線版（H&S 系） | **offender ごと**（点ごとに比較相手が違うので、代表値 1 つを載せると誤読される） |

#### そのほか

- **価格基準は `price`（終値）。** ネックライン自体が終値から作られており、ブレイク判定も終値なので、
  高安を突き合わせると基準が混ざる。
- **主構成点だけを渡す。** double の中間構成点はネックラインの定義点そのもの（`necklinePrice = b.price`）
  なので、検査に含めると必ず失格になる。triple は 3 点すべてが主構成点。
- **1 つの検査が主構成点をまとめて見る。** 形成中 `double_top` は最新足の側を
  `forming_current_at_or_below_valley` が、確定側の山を `forming_peaks_below_neckline` が見る、
  という**2 つの検査の分担**を持っていたが、#268 案 C でその経路ごと消えた。残る形成中経路
  （`triple_*`）は 3 点すべてが同じ検査を 1 回で通る。

契約は `tests/patterns/neckline-side-triple-double.test.ts`（完成済み double / triple）、
`tests/patterns/neckline-side-forming-triple-double.test.ts`（形成中 triple）、
`tests/patterns/neckline-side-hs.test.ts`（H&S 系。形成中に配線が無いことのトリップワイヤを含む）が
固定している。

### 形成中 triple の同水準判定に高さ相対のゲートは無い（#178 項目 1。意図的）

形成中 `triple_top` / `triple_bottom` の同水準判定は**価格相対の 1 段だけ**
（`tolerancePct × FORMING_TOLERANCE_MULTIPLIER × FORMING_LEVEL_SPREAD_FACTOR`）で、完成済み
4 経路が持つ**高さ相対の hard gate**（`MAX_LEVEL_SPREAD_RATIO` = 0.5。`tools/patterns/structural.ts` の
`validateLevelSpread`）に当たる段が無い。**未配線ではなく実測に基づく不採用**で、
[#178 項目 1 の決定](https://github.com/tjackiet/bitbank-lab-mcp/issues/178#issuecomment-5599895375)（2026-09-09、案 C）による。
その後 #261 / #263 を配線してから測ると、accepted な形成中 triple 43 実体のうち 17 実体が 0.5 を超えるが、
うち 12 実体は他ゲートの仕事（ネックライン誤側 8 / 誤側との差 0.15% 未満 3 / 単調だが閾値の直下 1）で
別の終端窓で生き残っているものであり、配線するとそれらを「高さ相対」の理由コードで落として**帰属が誤る**。
単独で拾う残り 5 実体のうち **3 実体は目視で妥当なトリプル**なので、入れると妥当な形を落とす。
したがって**「形成中 ⊇ 完成済みの厳しさ」の破れはここに残る**が、見落としではない。再開条件は
高さ相対ゲートが単独で拾う実体に「呼べない」が積み上がる実データが出たときで、根拠と数字は
`tools/patterns/detect_triples.ts` の `FORMING_LEVEL_SPREAD_FACTOR` の docstring と
tjackiet/bitbank-lab-mcp#178 の計測記録にある。

**「形成中は完成済みより緩い」を一般則として読まないこと。** #169 / PR #170 でサイズ検査を揃えたときに
整理したとおり、緩めてよいのは**「同水準かの判定」**（3 点目が最新足の終値で暫定なぶんノイズが残る）で
あって**「形と呼べる大きさか」ではない**——形成中 double のサイズ検査は #170 で完成済みと同じに揃えた
（その後 #262 / #268 案 C で形成中 double の経路ごと無くなり、double のサイズ検査は完成済みだけになった）。
形成中 triple も単調性ゲート（#263）とネックライン側の検査（#261）は完成済みと同等以上に厳しい。
本件が緩いままなのは前者に属するからではなく、**上の実測で「配線すると帰属が誤り妥当な形を落とす」ことが
示されたから**である。

### 反転パターンのサイズ検査は高安基準（#130 / #138）

構造ゲートとは別に、`double_top` / `double_bottom` / `triple_top` / `triple_bottom` /
`head_and_shoulders` / `inverse_head_and_shoulders` は**パターンの値幅が十分か**を見る検査を通る。
**閾値は 6 種別で同一**（`tools/patterns/structural.ts` の `MIN_PATTERN_HEIGHT_PCT` /
`MIN_DEPTH_PCT` が単一ソース）。

| 検査 | 閾値 | 測る対象 |
|---|---|---|
| `pattern_too_small` | パターン高さ ≥ 3% | double: 第1構成点と中間構成点の値幅 / triple・H&S: 全構成点の最大 − 最小 |
| `valley_too_shallow` / `peak_too_shallow` | 中間の谷 / 山の深さ ≥ 5% | 中間構成点と**その両隣の平均**との値幅。中間点が複数ある triple・H&S は全点が閾値を満たすこと |

**triple / H&S には #138 まで検査そのものが無かった。** double なら弾かれる小ささでも通るため、
高さ 1.6% のレンジ往復がその上端と下端を別々に拾われて `triple_top` と `triple_bottom` として
**同時に**報告されていた（BTC/JPY 1時間足の実例）。深さを「両隣の平均」で測るのは、H&S で
頭を含む全体平均を使うと頭が平均を押し上げ、肩とネックラインの間が浅くても通ってしまうため。

**どちらも `extremePrice`（高安）基準で測る。** 値幅の評価は構造ゲートの戻り率と同じ基準に
揃えてある（上節）。終値基準ではヒゲの大きい区間で値幅が実際の 1/3 に見え、正しいパターンが
落ちる——BTC/JPY 日足 2026-08-03 → 08-10 → 08-14 の実在するダブルボトムは、高安基準の
5.87% / 5.13% に対し終値基準では 1.85% / 1.67% となり両方の閾値を割っていた（issue #130 の偽陰性）。
**同水準判定（2 つの外側構成点が同じ水準か）とネックラインの線は終値基準のまま。**
形成中パターンの暫定構成点（3 点目 / 暫定右肩）は極値判定を通っていないので、
`extremePrice` にはその足の終値がそのまま入る。

**ピボット間の最小間隔は `minBarsBetweenSwings` に従う。** 以前は double 検出だけが
ローカル定数 5 本でこのパラメータを上書きしていた（`detect_triples` / `detect_hs` は当時から
パラメータどおり）。日足の既定は 4 本・1時間足は 2 本なので、**既定パラメータでも上書きが
起きていた**。上書きを外したので、日足で 4 本間隔の構成も検出される。

**double の主構成点間の `minDist` は完成済み経路（`near_completion` を含む）で掛かる**
——形成中経路が無いので、この間隔検査に漏れる経路も無い（#269。形成中 `double_top` が
中間構成点との距離を見ていなかった件は、#268 案 C で経路ごと削除して解消した）。

### H&S / 逆 H&S の肩の同水準判定は時間足別（#244）

左右の肩が「同じ水準」かの上限は **時間足ごとに違う**（`tools/patterns/config.ts` の
`getHsShoulderMaxPctForTf`）。`1day` の 5% をアンカーに、`getSizeThresholdsForTf` と同じ
ATR 比テーブルを掛けたもの。

| 時間足 | 肩の同水準の上限 |
|---|---:|
| `1min` / `5min` | 0.13% / 0.29% |
| `15min` / `30min` | 0.51% / 0.72% |
| **`1hour`** | **1.04%** |
| `4hour` | 2.04% |
| `8hour` / `12hour` | 2.89% / 3.54% |
| `1day` / `1week` / `1month` / 未知 | 5%（据え置き） |

以前は全時間足で 5% 固定だった。ATR 換算すると `1day` の 1.8 ATR に対し **`1hour` では
8.8 ATR** で、1 時間足では同水準判定が実質機能していなかった（日足で 14% 離れた高値を
「同水準」と呼ぶのと同じ）。この表では全時間足が約 1.8 ATR に揃う。

**`1day` 以上の挙動は変わっていない。** 検出が減るのは `1day` 未満だけで、実測でも
`1day` / `1week` / `1month` は全コーパスで 0 件差。`double_*` / `triple_*` の同水準判定
（`DOUBLE_LEVEL_MAX_PCT` / `tolerancePct`）も**動かしていない**——実データの 1 時間足では
高さ相対の無次元ゲート（`MAX_LEVEL_SPREAD_RATIO`）が律速していて、価格相対の上限は効いて
いないため（#244 中間決定 1 / 2）。

**値は「つまみ」で、非恣意性は主張していない。** 分布の空白帯に置いた線ではなく、
「同じ形の判定を全時間足で同じ ATR 本数で行う」という次元の一貫性だけが根拠。
この閾値で落ちる構造が実際に H&S と呼べない形であることは目視で確認してある
（tjackiet/bitbank-lab-mcp#244 の計測記録 §10）。

#### 窓生成（候補の列挙）は 5% のまま

肩の候補窓を作る段（`enumerateHsWindows` の `outerShoulderOk`）は**全時間足で 5% 固定**で、
時間足別の値は**肩ゲートにだけ**掛かる。理由は診断性——窓生成で落とすと `view=debug` の
`candidates` に何も残らず無音になるが、肩ゲートで落とせば理由コードが残る。

そのため 1 時間足では「肩が 1.04〜5% 離れた 5 点」は**候補としては現れ、
`shoulders_not_near:cap` で落ちる**。`view=debug` で理由コードを集計するときはこれが見える。

#### 肩の棄却理由コード

肩の判定は「相対差が `tolerancePct` 以内」AND「相対差が上表の上限以内」で、
**実効閾値は 2 つの `min`**。どちらで落ちたかが接尾辞に出る。

| 理由コード | 意味 | 緩めれば通るか |
|---|---|---|
| `shoulders_not_near:tolerance` | `tolerancePct` のみ超過 | `tolerancePct` を緩めれば通る |
| `shoulders_not_near:cap` | **上表の時間足別の上限のみ超過** | パラメータでは通らない（定数側） |
| `shoulders_not_near:both` | 両方超過 | どちらを緩めても通らない |

`relaxed_*` 接頭辞の同じ 3 つが relaxed フォールバック経路にある（そちらの「許容誤差」は
`tolerancePct × 段の係数`）。

**`:cap` の出方が #244 で変わった。** 以前は `tolerancePct`（`1hour` 5% / `15min` `30min` 6%）が
5% を超える `15min` / `30min` でしか既定パスで出なかったが、上限が時間足別になった今は
**`1day` 未満の全時間足で既定パスから普通に出る**（`1hour` なら上限 1.04% < `tolerancePct` 5%）。
`1day` 以上では従来どおり、呼び出し側が `tolerancePct` を 5% 超で明示したときだけ。
`view=debug` の `details.shoulderMaxPct` にはその時間足の**実効値**が入る（`1hour` なら `0.0104`）。

### 完成済み H&S のブレイク探索窓は 30 本固定（#249）

右肩からのブレイク探索窓は `HS_BREAKOUT_MAX_BARS = 30`（`tools/patterns/detect_hs.ts`）で、
**時間足に依らない固定値**。#242 の経路ゲート（右肩とブレイクの間に同種のピボットがあれば落とす）と
組み合わさるため、**右肩とブレイクの間にピボットが立たない形しか完成済みにならない**。1 時間足では
30 本の間にピボットが 1 つも立たないことは既定の `swingDepth=3` ではほぼ無いので、実質
「右肩の直後 数本以内に割った形」だけが通る。実データ B / C / D の 1hour では完成済み
`head_and_shoulders` は **0 件**で、目視でも H&S と呼べる形は無い（#249 Phase 1 /
tjackiet/bitbank-lab-mcp#249 の計測記録）。**この状態は
「0 件が正しい」として据え置く判断を採っている**（#249 案 D。窓の値も時間足別化もしない）。

逆 H&S は右肩 → ブレイクが短く（#242 前の同コーパスで中央値 8 本 / max 9 本）、この組み合わせの
影響を受けていない。また**完成済み経路にはパターン全長の上限が無い**（形成中経路には
`getHsFormingBarParams(tf).maxBars` がある）。上限の追加（#249 案 C）は **#244 で見送り確定**
——標準コーパスと実データ B / C / D で落ちるのは実データ B の 1 構造だけで、判断材料が
増えていない（#244 中間決定 3）。

### `status` に `expired` がある

| `status` | 意味 | 既定で出るか |
|---|---|---|
| `forming` | 形成途上。まだネックライン突破の余地がある（反転系では `triple_*` / H&S 系だけ。**double 2 型は出さない**。#268 案 C） | `includeForming: true` で |
| `near_completion` | **構造は揃い、ネックライン突破を待っている**（double / triple / H&S 系。#262 で double 2 型にも出るようになった） | `includeForming: true` で |
| `completed` | 検出器がネックライン突破を確認済み | ○ |
| `invalid` | 構成点確定後に形が崩れて無効化された（理由は `invalidReason`） | `includeInvalid: true` で |
| `expired` | **突破確認窓を使い切った。**以後 `completed` になることはない | `includeInvalid: true` で |

**`content` の状態行（`- 状態: …`）は、`invalid` / `expired` で `invalidReason` があれば
理由コードを併記する**（`無効（山2 の後に別の山を作ってから割った: peak_after_last_pivot）`）。
日本語は `invalidReason` の表引きで、**表に無い未知コードには日本語を当てずコードだけを出す**
（#286。`structuredContent` は LLM から見えないので、この行が理由の唯一のチャネルになる）。

`invalidReason` に出る理由コードは以下:

| `invalidReason` | 意味 | 出る種別 |
|---|---|---|
| `re_entered_trough_zone` | 第2構成点の確定後、ネックライン突破前に価格が谷（山）ゾーンへ戻った | 反転系（double / triple / H&S） |
| `peak_after_last_pivot` / `trough_after_last_pivot` | 最終構成点（山2 / 山3 / 右肩）とネックライン突破バーの**間**に同種のピボットがあり、最終構成点から直接ネックラインを割っていない（#242） | 反転系 |
| `forming_expired` | 突破確認窓を過ぎてもネックラインを突破しなかった（`status=expired`） | 反転系 |
| `breakout_against_expectation` | **期待と逆方向にブレイクした**（#291） | 継続系（`triangle_ascending` / `triangle_descending` / pennant / flag） |

**継続系の `invalid` は方向の具体値を状態行に持たない**——`ブレイク方向` /
`パターン結果` の 2 行が「下方ブレイク（本来は上方ブレイクが期待されるパターン）」の形で持つので、
状態行は「期待と逆方向にブレイク」という条件だけを名乗る。継続系の `invalid` はこの 1 条件しか
無いため理由コードも 1 つで、`triangle_symmetrical` は期待方向が無いので `invalid` にならず、
`wedge_*` は逆方向を `outcome: 'failure'` で表して `invalid` を出さない。

`near_completion` の文言も系統で分かれる——反転系は
「構造成立・ネックライン未突破」、継続系（`triangle_*` / `wedge_*` / flag / pennant）は「apex接近」。

`expired` は `invalid` と同義ではない——形が崩れたのではなく、成立する時間を使い切った状態。
突破探索は第2構成点から 20 本しか行われないので、それを過ぎた候補が `forming` /
`near_completion` を名乗ると「まだ完成しうる」という誤った含意になる。
既定で隠すのは、既に決着した候補がノイズになるため。

**double 2 型の `expired` / `invalid` は #262 で完成済み経路（未ブレイク分岐）由来になった。**
以前は形成中 `double_bottom` 専用の経路が出していたもので、判定（`FORMING_EXPIRY_BARS` の
期限切れ / 谷ゾーン再進入）は同じまま置き場所だけが移っている。未ブレイクの構造なので
`includeForming: false` では `expired` / `invalid` も返らない（`includeInvalid: true` でも同じ）。

**double 2 型が取りうる `status` は `near_completion` / `completed` / `invalid` / `expired` の
4 つで、`forming` は含まれない**（#268 案 C）。最終構成点が 1 つしか無く「形成中」を定義できない
ためで、未配線ではなく仕様。`includeForming: true` を渡しても double に `forming` は出ない
（トリップワイヤ: `tests/patterns/no-forming-double-268.test.ts`）。

### 整合度は「ゲート通過後の形の良さ」

`confidence` は**構造ゲートを通過した候補どうしの比較値**であって、構造的妥当性の指標ではない。
構造的に無効な形は整合度が下がるのではなく、そもそも出力されない。
内訳は `data.patterns[*].scoreComponents`、ゲートが実際に計測した値は
`data.patterns[*].structureGate` にある。

`scoreComponents` の軸は**種別によって違う**（同じキーが両方に出ることはない）:

| 軸 | 出る種別 | 意味 |
|---|---|---|
| `symmetry` | double 系 | 2 構成点（谷-谷 / 山-山）の同水準度。**正規化していない生の relDev** |
| `levelMargin` | triple 系 | 3 構成点の同水準度を、その経路の許容幅（`tolerancePct`。relaxed は係数倍）で正規化した値 |
| `retracement` | 共通 | 中間構成点の戻り率が許容帯の中央にどれだけ近いか |
| `breakoutQuality` | 共通 | 突破足の終値がネックラインをパターン高さの何割ぶん超えたか。**未ブレイクでは出ない** |
| `duration` | 共通 | 形成期間スコア。**種別で基準が違う**——triple 系は**バー数基準**（外側 2 構成点の距離。< 12 本 → 0.6 / < 18 → 0.7 / < 26 → 0.8 / 26 本以上 → 0.9）、double 系と H&S 系は**暦日基準**（< 5 日 → 0.6 / < 15 → 0.8 / < 30 → 0.9 / それ以外 → 0.7） |

`duration` も**種別を跨いで横に並べない**。triple 系だけがバー数基準で、しかも単調な階梯
（長いほど高い）だが、double / H&S 系の暦日基準は最長バケットだけ 0.7 に下がる非単調な形をしている
（issue #199 候補 2。triple だけ移したのは、暦日基準では intraday で値が定数に張り付いていたため）。

`symmetry` と `levelMargin` は**別の量**なので数値を横に並べて比較しない
（`symmetry=0.9` は「10% ずれている」、`levelMargin=0.9` は「許容幅の 10% ぶんしかずれていない」）。
算出できなかった軸（未ブレイク時の `breakoutQuality` 等）は**平均から外す**——
0 として混ぜると欠測が減点になるため。

### `debug` の candidates は `patterns` で絞られる

`meta.debug.candidates` は各検出器が走査中に積んだ「候補と、その採否・理由コード」。
**入力 `patterns` を指定した場合は、要求した種別の候補だけが返る**（`patterns` 未指定なら全種別）。

**`meta.debug.swings` は絞られない。** スイング点は `detectSwingPoints` が価格列だけから出すもので
種別に紐づかないため、`patterns` の指定に関わらず全件返る（上限 200 件のトリムのみ）。

絞らないと `patterns=["double_bottom"]` を指定しても candidates が wedge / triangle で埋まる。
検出器は `patterns` を「分類・出力の時点」でしか見ておらず、走査中の候補は無条件に積まれるため、
上限 200 件のトリムで**要求した種別の棄却理由が押し出されていた**。

### トリムされたことは申告される（#180）

上限 200 件のトリムが起きたかどうかは `meta.debug` の 4 フィールドで分かる。

| フィールド | 意味 |
|---|---|
| `candidatesTotal` | トリム前の候補総数。**入力 `patterns` による絞り込みの後**の件数 |
| `candidatesOmitted` | cap で押し出された件数（`candidatesTotal - candidates.length`） |
| `swingsTotal` / `swingsOmitted` | `swings` 側の同じ 2 つ |

`content` にも見出し行として出る（省略が無ければ「省略なし」と明示する）:

```text
【Candidates】 200 / 全 289 件（89 件省略。accepted は全件残っているため省略分はすべて棄却理由）
【Swings】 23 / 全 23 件（省略なし）
```

トリムは `[...accepted, ...rejected]` を先頭から 200 件残すので、**押し出しは棄却理由から始まる**。
**「押し出されたのは全部棄却理由」と言い切れるのは `candidates` に `accepted: false` が 1 件でも
残っている場合**で、返った 200 件が全件 `accepted: true` なら accepted 自体が cap を超えており
accepted も押し出されうる（`content` はこの 2 つを区別して書き分ける）。

いずれにせよ理由コードの内訳を集計する用途では、**`candidatesOmitted` が 0 であることを確認するか
`patterns` で種別を絞って呼び直す**こと。censored な内訳から集計すると誤った帰属をする
（実例: #152 → #167）。**集計そのものはツール側で済ませてある**（次節）。

`swings` は逆に**先頭から** 200 件を残すので、`swingsOmitted > 0` のとき落ちているのは**直近側**。

### 棄却理由の内訳は content に出る（#191）

**数え直さないこと。** `【Candidates】` の見出しの直後、候補の列挙より前に集計ブロックが出る。

```text
【Candidates】 69 / 全 69 件（省略なし）
▼ 候補の内訳: 全 69 件 = accepted 7 件 + rejected 62 件（cap 省略なし＝全候補の内訳）
▼ 棄却理由の内訳（type 別 → reason 別。合計は上の rejected 62 件と一致する）
   - triple_top 40 件: peaks_not_equal 21 / valleys_missing 12 / valley_too_shallow 7
   - triple_bottom 22 件: peak_too_shallow 15 / peaks_missing 7
```

- **分母は 3 つとも書く**（総数 / accepted / rejected）。引き算をさせない。
- 内訳は **type と reason の 2 軸**で数える。`reason` だけに畳むと
  `triple_bottom:valleys_missing` と `double_bottom:valleys_missing` が同じ行に潰れて帰属が読めない。
- **合計は必ず一致する。** type 行の合計 = 上の rejected 件数、行内の reason の合計 = その type の件数。
  type が 20 種 / 1 行の reason が 10 種を超えたら残余に畳むが、**畳んだ分も件数で残す**
  （`（他 3 種別）5 件` / `他 4 種 6`）。

**cap で押し出しが起きているときは分母が「表示分」に変わる:**

```text
【Candidates】 200 / 全 289 件（89 件省略。accepted は全件残っているため省略分はすべて棄却理由）
▼ 候補の内訳: 表示 200 件 = accepted 17 件 + rejected 183 件（全 289 件のうち 89 件は cap で省略されており、**この集計に入っていない**）
▼ 棄却理由の内訳（type 別 → reason 別。合計は上の rejected 183 件と一致する。**全 289 件の内訳ではない**）
```

この状態の内訳から母集団（全 289 件）の傾向を語らないこと。全体の内訳が要るなら
`patterns` で種別を絞って呼び直す。`candidatesTotal` の申告が無い呼び出し（ハンドラ直呼び等）では
分母が `受け取った N 件` になり、省略の有無は不明として扱う。

起票の根拠は**ライブでの実測**で、候補 69 件（accepted 7 / rejected 62）を LLM に集計させたところ
「62 件」と宣言しながら提示した表の合計が 57 件になり、順位も飛んだ。集計元
（`meta.debug.candidates`）は既に手元にあるので、表示層だけで消せる失敗モードだった。

### 検出経路（strict / relaxed）は content に出る（#191）

`summary` / `detailed` / `full` の実効パラメータ行の次に 1 行出る（`debug` はパターンを列挙しないので出さない）。

```text
検出経路: 全 7 件とも strict（relaxed フォールバック由来は 0 件）
検出経路: strict 5 件 / relaxed フォールバック由来 2 件（relaxed_triple_x1.25×2）※該当パターンは見出し行の末尾に同じ値が [ ] 付きで出る（summary はパターン行を出さないので件数のみ）
```

- **relaxed が 0 件でも行を出す。** 行が無いことを「relaxed なし」と読ませると、
  値が無いのか content に出していないのかを呼び出し側が区別できない（#189 で `_fallback` が
  structuredContent に届くようになった後も、LLM 側にはこの状態が残っていた）。
- `detailed` / `full` では relaxed 由来のパターンの見出し行末尾に `[relaxed_triple_x1.25]` が付く。
  値は `data.patterns[*]._fallback` と同じで、**表記は検出器ごとに揃っていない**
  （前方一致で判別し、係数の数値比較に使わない）。
- `summary` は個々のパターン行を出さない view なので、届くのは検出経路行の**件数だけ**。

パターン 0 件のときは行そのものを出さない（帰属の対象が無く、ヘッダが `0件を検出` と言う）。

照合は入力エイリアスを展開して行う（`triangle` → 3 種、`flag` / `pennant` → 各 2 種）。
候補ラベル側にも方向・形状の分類前に付く **umbrella ラベル**があり、入力エイリアスとは
被覆が異なる:

| umbrella ラベル | 積む検出器 | 覆う具体 type |
|---|---|---|
| `flag` | `detect_pennants`（分類前の棄却をすべてこのラベルで積む） | `bull_flag` / `bear_flag` / `bull_pennant` / `bear_pennant`（flag / pennant の**両方**） |
| `triangle` | `detect_triangles`（`poor_trendline_fit` / `classification_failed` はどの三角形になりえたかが決まる前の棄却） | `triangle_ascending` / `triangle_descending` / `triangle_symmetrical` |

`detect_wedges` は umbrella ラベルを持たない。棄却の大半は `rising_wedge` / `falling_wedge` に
分類済みのラベルで積まれる。ただし `r2_below_threshold`（回帰の当てはまり不足）と
`type_classification_failed`（傾き比の条件を満たさない）の **2 箇所**は、**上下の傾きから
種別を推定して**ラベルを付けており、傾きの向きが揃わない窓は `triangle_symmetrical` として
積まれる。これはウェッジ走査の棄却であって三角形の候補ではない——ラベルと実体がずれている
既知のケース（#129 の対象外。umbrella の `wedge` が `PatternFilterEnum` に無いため別途の
検討が要る）。**2 箇所が同じ推論を持っているので、直すときは両方**。

**`candidates[].type` は「その候補がどの種別になりえたか」であって、必ずしも確定した種別ではない。**

候補が 0 件のときは「この窓で要求種別の候補が 1 つも組まれなかった」の意で、
`content` にもその旨が出る。**「パターンが無い」ではない。**
日時で突き合わせるなら `range` / `date` 等の ISO 文字列を使うのが安全。

なお slice 導入前もインデックスは `chart.candles`（= `limit + 199` 本）基準であって「直近 `limit`
本の中での位置」ではなかった。今回スキャン窓と一致したことで、`meta.scan` が示す範囲で
インデックスの意味が閉じるようになった。

#### `limit` の実効下限

スキャン窓が `limit` 本に一致した以上、**`limit` は「何本見るか」であると同時に「何が検出可能か」を決める**。
下限は 2 段ある。

**1. 構造的下限（警告あり）** — `detectSwingPoints` は窓の前後 `swingDepth` 本をピボット候補から外す。
最小構成の反転パターン（3 ピボット）を張るには
`2 × swingDepth + 2 × max(minBarsBetweenSwings, 5) + 1` 本が要る。これを下回ると
`data.warnings` に `limit_too_small_for_timeframe` が載り、**`content` の先頭にも警告行が出る**
（`data.warnings` は LLM から見えないため）。時間足既定パラメータでの下限:

| 時間足 | 既定 `swingDepth` | 構造的下限 |
|---|---|---|
| `1min` / `5min` | 2 | 15 |
| `15min` / `30min` / `1hour` | 3 | 17 |
| `4hour` / `8hour` / `12hour` | 5 | 21 |
| `1day` | 6 | 23 |
| `1week` | 7 | 25 |
| `1month` | 8 | 29 |

**この余白は下限だけでなく判定結果にも効く。** 窓の終端 `swingDepth` 本の足はピボットに
なれないので、#242 の経路ゲートと再進入チェックはその区間の戻しを見ない——同じ値動きでも
`limit` によって `completed` / `invalid` が変わりうる（issue #277。上の
「スイング検出パラメータは時間軸オート」の節に実例と根拠がある）。

> 式の `max(minBarsBetweenSwings, 5)` の **5**（`patterns/scan-window.ts` の
> `STRUCTURAL_PIVOT_GAP_FLOOR_BARS`）は**検出器の挙動の写しではない**。ピボット間隔そのものは
> 全検出器が `minBarsBetweenSwings` をそのまま使う（#130）。この床が残っているのは、同じ値が
> 下の §2「パターンサイズ由来の下限」の基準点（`bar-thresholds.ts` の `structuralFloorBars`）
> でもあるため——床を外すと `minBarsBetweenSwings < 5` の 9 時間足で §2 の表が一斉に縮み、
> double とは無関係の triangle / wedge / triple が緩む。**その判断は #130 のスコープ外**として
> **#134 に分離**してある（+72 件が真の検出漏れかノイズかは未検証）。結果として §1 の下限は
> `minBarsBetweenSwings < 5` の時間足で実際の検出器より 1〜4 本ぶん保守的
> （＝ `limit` を少し多めに勧める向き）になる。**この床の根拠は構造的必然ではなく経験的**で、
> 詳細は `patterns/scan-window.ts` の同定数の docstring を参照。

**2. パターンサイズ由来の下限（警告なし）** — 各検出器は「パターンがどれだけの大きさなら
成立するか」の閾値を持つ。窓が狭いとその要求が窓を超え、**そのパターン種別だけが静かに 0 件になる**。

閾値のプリミティブは**バー数**で、`tools/patterns/bar-thresholds.ts` が
`clamp(round(日数 × barsPerDay), 構造的下限, 構造的下限 × 2)` で決める（列見出しの日数は
値の出どころを示す注記であって、暦日数の要件ではない）。上限を構造的下限の定数倍に置いてあるので、
**既定 `limit`=90 ではどの時間足・どの種別も到達可能**。主な要求本数:

> **表の値は閾値そのものではなく「必要なスキャン窓の本数」**（`limit` と同じ単位）。上の式が返すのは
> パターンの大きさの閾値で、**表はそこに各検出器の走査ループが要求する端点ぶんを足した値**である。
> 形成中の反転 2 種と完成済み wedge は **+1**（`formationBars` / 窓サイズはいずれも添字の差なので、
> 本数としては 1 本多く要る）、flag / pennant も **+1**（旗竿と保ち合いの境界の 1 本）、三角形は **+6**。
> 例: `1day` の forming triple は式が `clamp(round(21 × 1), 23, 46) = 23`（= `formationBars` の下限）で、
> 表は **24**。`12hour` は式が `clamp(round(21 × 2), 21, 42) = 42` で表は **43**。
> **`limit` を式の値に合わせると 1 本足りない**ので、下限として使うのは表の値のほう。
> 導出は `tools/patterns/min-bars.ts` の `minBarsForDetector` にあり、端点の根拠も各 case に書いてある。

| 時間足 | forming triple（21日由来） | forming H&S（21日由来） | 完成済み wedge（25日窓由来） | flag / pennant（最小 1+2日由来） |
|---|---|---|---|---|
| `1min` | 31 | 31 | 31 | 61 |
| `5min` | 31 | 31 | 31 | 61 |
| `15min` | 35 | 35 | 35 | 69 |
| `30min` | 35 | 35 | 35 | 69 |
| `1hour` | 35 | 35 | 35 | 59 |
| `4hour` | 43 | 43 | 43 | 19 |
| `8hour` | 43 | 43 | 43 | 10 |
| `12hour` | 43 | 43 | 43 | 7 |
| `1day` | 24 | 24 | 26 | 6 |
| `1week` | 26 | 26 | 26 | 6 |
| `1month` | 30 | 30 | 30 | 6 |

`detect_triangles` も同じ換算に乗っている（最小窓 = 構造的下限。要求本数は `1min` / `5min` が 21、
`1hour` 以下が 23、`4hour`〜`12hour` が 27、`1day` 29、`1week` 31、`1month` 35）。
**形成中の反転パターン 2 種（triple / H&S）は同じ換算・同じ形の判定**で、
形成バー数（triple は `lastIdx - 左ピボット.idx`、H&S は `右肩.idx - 左肩.idx`）を
バー数レンジと突き合わせる。日数由来が同じ 21 日なので全時間足で同値になる。

**double の列は無い。** #268 案 C で形成中 double の経路が無くなり、この種別に
「パターンサイズ由来の下限」が存在しなくなった（完成済み経路＝`near_completion` を含む が
要求するのはピボット 3 点の間隔だけで、それは §1 の一般式が担う）。
14 日由来の double は `12hour` だけ他の 2 種より下側に外れる列で、消える前の値は 29 だった。

> 上の 2 つの表は手書きではない。構造的下限は `tools/patterns/scan-window.ts`（`assessScanWindow`）、
> パターンサイズ由来の下限は `tools/patterns/min-bars.ts`（`minBarsForDetector`）から導出した値で、
> `tests/patterns/min-bars.test.ts` が**本ファイルをパースして**一致を検証している。
> 閾値を動かしたら表も同時に直すこと（直さないと CI が落ちる）。
> 到達性（既定 `limit` で各検出器が窓に収まるか）は `tests/patterns/invariants.test.ts` が
> 「未到達の組み合わせがゼロ」として固定してある。

実効的な制約は `limit` そのものではなく **`meta.scan.bars`（実際に走査した本数）**。
`analyze_indicators` は `chart.meta.pastBuffer` を常に返すので `meta.scan.bars ≤ limit ≤ 365` が成り立つ。
**この表の値はすべて既定 `limit`（90）以下**なので、`limit` を既定のまま使う限りどの組み合わせも
走査窓に収まる。`limit` を既定より小さくしたときだけ、表の値を下回る種別が静かに 0 件になる。
例外は `pastBuffer` が取れなかった場合の全件走査フォールバックで、このときだけ `meta.scan.bars` が
`limit` を超えうる（上流の形が変わらない限り起きない）。
**到達可否の判断は `limit` ではなく `meta.scan.bars` を見ること。**

> バー数に統一する前は `1hour` の forming triple が 493 本・完成済み wedge が 601 本を要求しており、
> `limit` の上限 365 でも到達不能だった。`4hour` も既定 `limit=90` では両方とも出ず、`limit≥151` が
> 必要だった（#118 問題 1 / 2）。現在はいずれも既定 `limit` で到達できるので、この回避策は不要。

> 形成中 double / H&S も以前は独自の換算（`1day`→1 / `1week`→7 / **それ以外→1**）を使っており、
> この表の対象外だった（#118 問題 3）。**バー数への統一で閾値の向きが時間足ごとに変わる**:
> 最小側は全時間足で厳しくなり（例: `1day` の H&S は `formationBars` の下限が 21 → 23 本。
> スキャン窓の要求本数では 22 → 24 本）、最大側は緩む
> （旧実装は全時間足で `formationBars ≤ 90` に張り付いていた）。`1week` は旧実装の受理域が
> `formationBars ∈ [2, 12]` と構造的下限（25 本）を下回っており、**形成中 double / H&S が
> 実質検出不能**だった。詳細は CHANGELOG を参照。**double 側は #268 案 C で経路ごと消えた**ので、
> この換算が効くのは H&S / triple だけになった。

#### `limit` を上げる動機

下限の裏返しとして、**`limit` を既定より上げる判断基準**も `limit` 側にしかない。

既定の `limit`=90 は「**いま形成中〜完成直後のパターンを把握する**」ユースケースに合わせた値で、
「これ以上見ると重い」という上限ではない。次の用途では既定のままだと母数が足りないので上げる（上限 365）:

| 目的 | 効くフィールド | 既定 90 での問題 |
|---|---|---|
| パターン種別ごとの成功率・平均リターンを見る | `data.statistics[type]`（`successRate` / `avgReturn7d` / `avgReturn14d` / `medianReturn7d`） | 統計は**窓に入った同種パターンだけ**が母数。既定では 1〜2 件しか入らないことがあり、そのサンプル数の平均を「成功率」として読むと過剰に振れる（母数は同じオブジェクトの `detected` / `withAftermath` で確認する） |
| ブレイク後の典型的な値動き・target 到達までの期間を見る | `data.patterns[*].aftermath`（`priceMove` / `daysToTarget`） | 事後分析は**パターン終了足より後の足**（最大 +30 本）を使う。窓の末尾付近のパターンはその足が窓に無いので、`priceMove` が空・`breakoutConfirmed=false` のままになる |

**コストは `content` のトークンではなく API 呼び出し回数**である。`view=summary` / `detailed` の
`content` に出るのは分類内訳と上位 5 件までなので、`limit` を上げても LLM に渡る量はほとんど変わらない
（全件を出す `view=full` だけは `limit` に比例して増える）。増えるのは `analyze_indicators` が
`limit + warmup` 本を取りにいくぶんの取得コストで、**それを払うべきなのは過去分析をする呼び出しだけ**。
だからこのコストを既定値の引き上げで全呼び出しに負わせず、`limit` の明示指定に寄せている。

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

