---
description: MCP サーバーでできることの全体像。ツール名を意識せず、自然な言葉で使えます
---

# MCP サーバーでできること

## ツール名を意識する必要はありません

自由に質問してもらって構いません。「`get_orderbook` を使って〜」のように **ツール名を指定する必要はありません**。やりたいことを自然な言葉で伝えれば、AI が質問の意図から適切なツールを自動的に選びます。

各ツールの説明文には「いつ使うべきか」「他のツールとの使い分け」が書き込まれているため、AI が自律的に判断します。利用者はツールの存在を意識せず、「BTC の今の市場状況を分析して」のように話しかけるだけで構いません。

{% hint style="success" %}
まずは「**BTC の今の市場状況を分析して**」と話しかけてみてください。総合スコア（-100〜+100）で全体感をつかめます。何を聞けばよいか迷ったら [プロンプト集](prompts.md) も参考にしてください。
{% endhint %}

## おおまかにできること

bitbank の公開データをもとに、AI が次のようなことを行えます（いずれも自然文で頼めます）。

* **今の相場を知る** — 価格・板・約定・ローソク足の取得、総合スコアでの強弱判定
* **テクニカル分析** — 移動平均・RSI・ボリンジャーバンド・一目均衡表・MACD など
* **値動きの勢いを見る** — 買い/売りの勢い（フロー）・ボラティリティ
* **注目銘柄を探す** — 出来高/変化率ランキング・通貨強弱・MACD クロスのスクリーニング
* **パターンを見つける** — チャートパターン・ローソク足パターン・大口の動き
* **チャートで可視化する** — ローソク足＋指標、板の深度チャート（[チャートを表示する](charts.md)）
* **戦略を検証する** — 過去データでのバックテスト
* **資産・取引を扱う** — 資産確認・発注など（API キー設定時のみ／[Private API](../private-api/setup.md)）

{% hint style="info" %}
本サーバーは bitbank API が返す全銘柄に自動追随します（追加・廃止も即時反映）。対応銘柄は固定ではありません。
{% endhint %}

## ツールの種類（参考）

舞台裏では、目的別に用意された **48 のツール**（Public 32 + Private 16）から最適なものが自動的に選ばれています。以下は「どんな道具があるのか」を知りたい方向けの参考一覧です。**暗記する必要はありません。**（Private ツールは `BITBANK_API_KEY` + `BITBANK_API_SECRET` 設定時のみ有効）

### データ取得 — 生データ（Raw）：4

API の応答をそのまま、または軽量整形して返します。指標計算・判定は行いません。

| ツール | 概要 |
| --- | --- |
| `get_ticker` | 単一ペアの最新価格・出来高（ティッカー） |
| `get_tickers_jpy` | JPY ペアの一括取得（価格・出来高・変化率、ランキング表示可、10秒キャッシュ） |
| `get_candles` | ローソク足 OHLCV（11 時間軸: 1min〜1month、任意本数） |
| `get_transactions` | 約定履歴（直近60件 or 日付指定、サイド/アグレッサー、フィルタ可） |

### データ取得 — 加工（Processed）：3

生データに集計・統計計算を加えて返します。

| ツール | 概要 |
| --- | --- |
| `get_orderbook` | 板情報の統合ツール（`mode` で分析粒度を切替え: summary / pressure / statistics / raw） |
| `get_flow_metrics` | CVD / アグレッサー比 / スパイク検知でフロー優勢度を把握 |
| `get_volatility_metrics` | RV / ATR / Parkinson / GK / RS でボラティリティ算出・比較 |

### テクニカル分析：13

ローソク足・板データから指標計算・スナップショットを生成します。

| ツール | 概要 |
| --- | --- |
| `analyze_indicators` | 統合指標（SMA / EMA / RSI / BB / 一目 / MACD / Stochastic / StochRSI） |
| `analyze_bb_snapshot` | BB の広がりと終値位置（z-score・帯幅・スクイーズ判定） |
| `analyze_ichimoku_snapshot` | 一目の状態スナップショット（雲との位置関係・転換/基準線・雲の傾き） |
| `analyze_sma_snapshot` | SMA 整列/クロス分析（bullish/bearish/mixed・傾き） |
| `analyze_ema_snapshot` | EMA 整列/クロス分析（既定期間: 12, 26, 50, 200） |
| `analyze_mtf_sma` | 複数タイムフレーム SMA 一括取得・方向の合流（confluence）判定 |
| `analyze_stoch_snapshot` | Classic Stochastic（%K/%D のゾーン・クロス・ダイバージェンス。レンジ向き） |
| `analyze_volume_profile` | 約定データから VWAP・Volume Profile・約定サイズ分布を算出 |
| `analyze_currency_strength` | 通貨強弱分析（JPY ペア横断で相対的な強さを比較） |
| `analyze_fibonacci` | フィボナッチ水準を自動計算（スイング検出・最寄り水準・反応実績） |
| `analyze_mtf_fibonacci` | 複数ルックバック期間のフィボ水準を一括計算し合流ゾーンを検出 |
| `analyze_support_resistance` | サポレジ自動検出（接触回数・強度・崩壊実績） |
| `analyze_candle_patterns` | ローソク足パターン検出（1〜3本: ハンマー/包み足/三兵 等） |

### 総合判定・スクリーニング：1

複数指標を統合してスコアを算出します。まず全体感をつかむならこれです。

| ツール | 概要 |
| --- | --- |
| `analyze_market_signal` | 総合スコア（-100〜+100）。構成: buyPressure 35% / cvdTrend 25% / momentum 15% / volatility 10% / smaTrend 15%。寄与度・式付き |

### パターン検出：3

| ツール | 概要 |
| --- | --- |
| `detect_patterns` | 大型チャートパターン（ダブルトップ/H&S/三角等13種、forming/completed/invalid 状態管理） |
| `detect_macd_cross` | MACD クロス統合ツール。`pair` 指定で単一ペア深掘り、省略で複数ペアスクリーニング |
| `detect_whale_events` | 大口投資家の動向を簡易検出（板×ローソク足。蓄積/分配圧力判定） |

### Visualizer データ：2

クライアント側（Claude.ai の Visualizer 等）で描画するためのコンパクトな整形データです。LLM も数値を直接参照できます。

| ツール | 概要 |
| --- | --- |
| `prepare_chart_data` | Visualizer / チャート描画用の時系列データ。全指標は計算・シフト適用済み |
| `prepare_depth_data` | 板の深度チャート描画用の累積 volume 階段データ。mid・spread・band 集計付き |

### 可視化（SVG 生成）：3

クライアント側で描画できない場合や、ファイル保存が必要な場合のフォールバックです。

| ツール | 概要 |
| --- | --- |
| `render_chart_svg` | メインチャート（ローソク足/ライン + SMA/EMA/BB/一目）+ サブパネル（MACD / RSI / Volume） |
| `render_depth_svg` | 板の深度チャート（累積 bid/ask カーブ）。描画可能なら `prepare_depth_data` を優先 |
| `render_candle_pattern_diagram` | ローソク足パターン教育図（`analyze_candle_patterns` の結果を図解） |

### その他（データ品質 / バックテスト / メンテナンス）：各1

| ツール | 概要 |
| --- | --- |
| `validate_candle_data` | OHLCV データの品質検証（完全性・重複・整合性・異常値。0-100品質スコア） |
| `run_backtest` | 汎用バックテスト（SMA クロス / RSI / MACD / BB ブレイクアウト。P&L + チャート SVG 一括返却） |
| `refresh_pairs_cache` | `/spot/pairs` 手数料レートの TTL キャッシュを強制再取得（キャンペーン境界などで最新レートを即時反映） |

### Private API（要 API キー）：16

`BITBANK_API_KEY` + `BITBANK_API_SECRET` 設定時のみ有効化されます。資産確認・注文照会・発注・信用取引などのツールです。詳細は [Private API（取引機能）](../private-api/setup.md) を参照してください。

{% hint style="info" %}
各ツールの入力パラメータや詳細仕様（`get_candles` の日付・tz の扱い、`run_backtest` の戦略・フィルター等）は、GitHub の [docs/tools.md](https://github.com/tjackiet/bitbank-lab-mcp/blob/main/docs/tools.md) に詳細ガイドがあります。
{% endhint %}
