---
paths:
  - "tools/render_*.ts"
  - "tools/prepare_*.ts"
  - "src/handlers/*chart*.ts"
  - "src/handlers/*render*.ts"
  - "src/prompts.ts"
---

# チャート・可視化ポリシー

## 描画パス

### 1. Visualizer 描画（Claude 会話内インライン表示）

- `prepare_chart_data` — 計算済みの指標データを Visualizer 描画用に整形して返す。
  一目均衡表の先行スパン・遅行スパンのシフトも適用済み。
- `prepare_depth_data` — 板の累積 volume データ（[price, cumulativeVolume][]）を返す。
  Visualizer で板の深度チャートを描画する際の第一選択。mid・spread・band 集計も同梱。

### 2. サーバー側 SVG 生成（ファイル保存・Cursor 向け）

- `render_chart_svg` — ローソク足・ライン・BB・一目均衡表・SMA 等
- `render_depth_svg` — 板の深度チャート（クライアント側で描画可能な場合は `prepare_depth_data` を優先）
- `render_candle_pattern_diagram` — ローソク足パターン図解

Cursor では `savePng: true` + ワークスペース内の `outputDir` を推奨。

## 開発ルール

- 独自に可視化コード（D3 / Chart.js / Canvas / SVG 等）をツール実装内に生成しない
- テクニカル指標の計算は `lib/indicators.ts` に集約する

## 例外

- おはようレポート（`src/prompts.ts` の ohayo）では `<svg><polyline>` 簡易スパークラインをインライン生成してよい
