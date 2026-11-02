# scripts/

MCP ツールをコマンドラインから単体実行するためのスクリプト群。

## ビルド・コード生成

| スクリプト | npm script | 説明 |
|---|---|---|
| `gen_types.ts` | `npm run gen:types` | `src/schemas.ts` の Zod スキーマから `src/types/schemas.generated.d.ts` を生成 |

## ログ・レポート

| スクリプト | npm script | 説明 |
|---|---|---|
| `stat.ts` | `npm run stat` | `logs/` 配下の JSONL ログを集計し、成功率・エラー種別・処理時間の統計を表示 |
| `report.ts` | `npm run report` | 前日分のログから日次レポート (Markdown) を `reports/` に生成 |
| `verify_log_integrity.ts` | なし | 取引操作ログ（`category: "trade_action"`）のハッシュ連鎖（`_hash` / `_prevHash`）を検証する。改ざんや欠落があれば行番号を出して終了コード 1 で終わる |

```bash
# 直近 7 日間の統計
npm run stat -- --last 7d

# 取引操作ログの検証（ファイルを省略すると logs/ の最新の .jsonl）
npx tsx scripts/verify_log_integrity.ts logs/2026-11-01.jsonl
```

## CLI ツール（`*_cli.ts`）

各 MCP ツールを `npx tsx` で直接実行できるエントリポイント。
引数パースと結果出力は `cli-utils.ts` (`parseArgs`, `runCli`) で統一されている。

| スクリプト | 説明 | 使用例 |
|---|---|---|
| `get_candles_cli.ts` | ローソク足データ取得 | `npx tsx scripts/get_candles_cli.ts btc_jpy 1hour 20240511` |
| `get_tickers_jpy_cli.ts` | 全通貨ペアの JPY ティッカー取得 | `npx tsx scripts/get_tickers_jpy_cli.ts` |
| `get_transactions_cli.ts` | 約定履歴取得 | `npx tsx scripts/get_transactions_cli.ts btc_jpy 100` |
| `get_flow_metrics_cli.ts` | 資金フローメトリクス取得 | `npx tsx scripts/get_flow_metrics_cli.ts btc_jpy 100 60000` |
| `get_volatility_metrics_cli.ts` | ボラティリティ指標取得 | `npx tsx scripts/get_volatility_metrics_cli.ts btc_jpy 1day 200 --windows=14,20,30` |
| `analyze_indicators_cli.ts` | テクニカル指標分析 | `npx tsx scripts/analyze_indicators_cli.ts btc_jpy 1day` |
| `analyze_candle_patterns_cli.ts` | ローソク足パターン検出 | `npx tsx scripts/analyze_candle_patterns_cli.ts 20251115` |
| `render_chart_svg_cli.ts` | チャート SVG 描画 | `npx tsx scripts/render_chart_svg_cli.ts btc_jpy 1day 60 --sma=5,20` |
| `render_candle_pattern_diagram_cli.ts` | ローソク足パターン図解 SVG 生成 | `npx tsx scripts/render_candle_pattern_diagram_cli.ts output.svg` |

### render_chart_svg_cli.ts の主なフラグ

| フラグ | 説明 |
|---|---|
| `--sma=5,20` | SMA 期間をカンマ区切りで指定 |
| `--with-ichimoku` | 一目均衡表を表示 |
| `--bb-mode=default\|extended` | ボリンジャーバンドのモード |
| `--style=candles\|line\|depth` | チャートスタイル |
| `--sma-only` / `--bb-only` / `--ichimoku-only` / `--candles-only` | 指定インジケータのみ表示 |

## バックテスト

| スクリプト | 説明 |
|---|---|
| `run_backtest_e2e.ts` | バックテストの E2E 実行。第 1 引数は戦略（`sma_cross`, `rsi`, `macd_cross`, `bb_breakout`。省略時は `sma_cross`）、第 2 引数に `full` を渡すと詳細チャート（`chartDetail: 'full'`）で描画する |

```bash
npx tsx scripts/run_backtest_e2e.ts sma_cross
npx tsx scripts/run_backtest_e2e.ts rsi full
```

## 共通ユーティリティ

| スクリプト | 説明 |
|---|---|
| `cli-utils.ts` | CLI 共通ユーティリティ。`parseArgs` (引数パース)、`intArg` (整数引数取得)、`runCli` (エントリポイントラッパー) を提供 |
