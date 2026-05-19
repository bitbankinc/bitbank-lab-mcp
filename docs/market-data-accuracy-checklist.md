# market-data 精度チェックリスト

bitbank-genesis-mcp-server の market-data / 指標計算層について、
「数値の正しさ」（数式・系列 index・未確定足・出力配置等）に関わる契約を固定する。

API レスポンスのフィールド整合は `docs/api-contract-checklist.md` 側で扱う。
本ドキュメントは計算・加工層の挙動に焦点を当てる。

- **対象実装**
  - 取得層: `tools/get_candles.ts` 他
  - 計算コア: `lib/indicators.ts`
  - 集約: `tools/analyze_indicators.ts`
  - 加工: `tools/prepare_chart_data.ts` / `tools/render_chart_svg.ts` / `tools/analyze_ichimoku_snapshot.ts` 他
- **目的**: 実装変更・golden テスト追加・handler 修正の前提となる「数値契約」を固定する。

## 凡例

| 記号 | 意味 |
|---|---|
| ✅ | 契約として確定（実装が契約どおり） |
| 🟡 | 契約は確定だが実装側に既知のバグがあり別 PR で対応 |
| ❌ | 未策定 |
| ➖ | 該当なし |

---

## 1〜7

取得層・系列整合・タイムスタンプ・通貨単位等の項目は別 PR で順次整備する。
現状この checklist で確定しているのは §8 のみ。

---

## 8. 指標計算（フェーズ4）

`lib/indicators.ts` の純粋関数群と、`tools/analyze_indicators.ts` 以降の加工層を含む計算契約。
golden テスト追加（後続 PR2）と handler 修正（後続 PR3）の前提となるため、
本 PR で先に文書化する。本 PR ではコード変更を伴わない（`atr()` の 1 行コメント追加を除く）。

### 8.1 EMA ✅

| 項目 | 内容 |
|---|---|
| シード | 先頭 `period` 本の **SMA** を初期 EMA とする |
| 平滑化係数 | `k = 2 / (period + 1)` |
| 漸化式 | `next = price * k + prev * (1 - k)` |
| NaN 前 `period - 1` 個 | 先頭 `period - 1` 個は NaN |
| 非有限入力 | 内部状態をリセットし、次に `period` 個の有限値が揃った時点で再シード |
| 実装 | `lib/indicators.ts::ema()` |

### 8.2 RSI ✅

| 項目 | 内容 |
|---|---|
| 平滑化 | Wilder's Smoothing (RMA) |
| 初期窓 | 先頭 `period` 本の単純平均で `avgGain` / `avgLoss` をシード |
| 漸化式 | `avg = (prev * (period - 1) + x) / period` |
| 中立値 | `avgGain === 0 && avgLoss === 0` のとき RSI = **50**（業界標準） |
| 飽和値 | `avgLoss === 0 && avgGain > 0` のとき RSI = 100 |
| 出力範囲 | 0–100。先頭 `period` 個は NaN |
| 実装 | `lib/indicators.ts::rsi()` |

### 8.3 Bollinger Bands ✅

| 項目 | 内容 |
|---|---|
| 中央線 | `SMA(period)` |
| 標準偏差 | **population σ**（除数 N）。pandas の `ddof=1` ではない |
| 帯 | `mean ± stdDev * σ` |
| 既定値 | `period = 20`, `stdDev = 2` |
| NaN | 窓内に NaN を含む場合 upper / middle / lower すべて NaN。窓が完全に有限値で埋まった時点で計算再開 |
| 実装 | `lib/indicators.ts::bollingerBands()` |

### 8.4 Stochastic ✅

| 項目 | 内容 |
|---|---|
| Raw %K | `(Close - Low_n) / (High_n - Low_n) * 100`。`range === 0` のとき **50** |
| %K | `SMA(%K_raw, smoothK)` |
| %D | `SMA(%K, smoothD)` |
| 欠損 | **NaN 伝播**（窓内に非有限値がある間は NaN を返し、窓が満ちた時点で再開） |
| 既定値 | `kPeriod = 14`, `smoothK = 3`, `smoothD = 3` |
| 実装 | `lib/indicators.ts::stochastic()` |

StochRSI は RSI 値列に対して同じ計算を行う（`lib/indicators.ts::stochRSI()`）。

### 8.5 一目均衡表: 系列の index 意味 ✅

`lib/indicators.ts::ichimokuSeries()` が返す `tenkan / kijun / spanA / spanB / chikou` は
**全て計算バーと同じ index** で値を保持する（先行 / 遅行シフトは適用しない）。

- `tenkan[i]` = i 本目を含む過去 9 本の `(maxHigh + minLow) / 2`
- `kijun[i]`  = i 本目を含む過去 26 本の `(maxHigh + minLow) / 2`
- `spanA[i]`  = `(tenkan[i] + kijun[i]) / 2`（**プロット時に i + 26 へ移すのは描画層の責務**）
- `spanB[i]`  = i 本目を含む過去 52 本の `(maxHigh + minLow) / 2`（**プロット時に i + 26 へ移すのは描画層の責務**）
- `chikou[i]` = `closes[i]`（**プロット時に i - 26 へ移すのは描画層の責務**）

### 8.6 一目均衡表: シフト責務の分担 ✅

| 層 | 責務 | 実装位置 |
|---|---|---|
| 計算層 | シフトせず計算バーと同じ index に値を埋める | `lib/indicators.ts::ichimokuSeries()` |
| 描画層 (`render_chart_svg`) | spanA / spanB を `+ICHIMOKU_SHIFT (= 26)` だけ前方にオフセットして描画。chikou は `-ICHIMOKU_SHIFT` だけ後方にオフセット | `tools/render_chart_svg.ts:516-522` |
| 解釈層 (`analyze_ichimoku_snapshot`) | 「今日の雲」を取りたいときは `series.spanA[len - 26]` / `series.spanB[len - 26]` を参照 | `tools/analyze_ichimoku_snapshot.ts:273-280` |
| 加工層 (`analyze_indicators` → `prepare_chart_data`) | `ICHI_chikou` のみ計算層側で `shiftChikou()` 適用済みを渡す。`ICHI_spanA / ICHI_spanB` はシフト前の生系列を渡す | `tools/analyze_indicators.ts:282-294` |

`ICHIMOKU_SHIFT = 26` は `lib/indicator-config.ts:34`。

### 8.7 一目均衡表 snapshot スカラー 🟡

`analyze_indicators` が `latestIndicators` に詰める
`ICHIMOKU_spanA` / `ICHIMOKU_spanB` は、`lib/indicators.ts::ichimokuSnapshot()` が返す
**「今日計算された先行スパン」= 26 本先にプロットされる値**。

⚠️ **「今日の雲」（現在価格との上下判定）にこのスカラーを使ってはならない。**
正しくは時系列の `ichi_series.spanA[len - 26]` / `ichi_series.spanB[len - 26]` を参照する
（`analyze_ichimoku_snapshot` がこの方式を採用済み）。

現状の誤用箇所（**本 PR では文書化のみ、修正は PR3 で対応**）:

- `src/handlers/analyzeIndicatorsHandler.ts:564-569`
  `cloudTop` / `cloudBot` を `ind.ICHIMOKU_spanA` / `ind.ICHIMOKU_spanB` から直接組み立てている。
- `src/handlers/analyzeMarketSignalHandler.ts:137-153`
  補足指標ブロックで `spanA = ICHIMOKU_spanA` / `spanB = ICHIMOKU_spanB` をそのまま「今日の雲」として
  `cloudTop / cloudBottom` を計算し、現在価格との位置関係を出している。

### 8.8 丸め ✅

- 計算コア (`lib/indicators.ts`) は丸めを **行わない**（NaN 埋めのみ）。
- 表示用の 2 桁 / JPY 整数丸めは `toNumericSeries(values, decimals)` または handler 層で実施する。
- golden / unit テストは `lib/indicators` を直叩きし、未丸めの `number[]` で検証する。
  浮動小数の差分は `expect.closeTo` / `toFixed` 等でテスト側が吸収する。

### 8.9 未確定足 ✅

- **指標計算には取得した全足を含める**（最終足が未確定でも除外しない）。
  - 影響: RSI / EMA / BB / Stoch / Ichimoku / ATR / MACD の最終値は未確定足を反映する。
- golden / unit テストはシステム日付に依存させないため、**合成 OHLC 固定配列** で行う。
  サブプロセス E2E（`tests/e2e/**`）に限り実 API を許容する。
- 確定足のみが必要な分析は **ツール側のフラグで除外する**。
  - 例: `tools/analyze_candle_patterns.ts:697` の `allow_partial_patterns`（未確定足を skip するか否か）。

### 8.10 ATR ✅

- `lib/indicators.ts::atr()` は **SMA-ATR**（population 窓の単純平均）。
  - `tr = trueRange(high, low, close)`、`atr[i] = mean(tr[i - period + 1 .. i])`。
  - **Wilder の RMA-ATR ではない**（RSI の RMA とは別ロジック）。
- `TR[0]` は常に NaN（前足 close が存在しないため）。シード窓は `tr[1..period]`。
- プロダクト上の ATR は `tools/get_volatility_metrics.ts` が
  `trueRange + slidingMean (= SMA)` で算出する（`tools/get_volatility_metrics.ts:198, 214`）。
- Wilder 版が必要になった場合は **別関数（例: `wilderAtr()`）** として追加し、
  既存呼び出しの挙動を変えない。

### 8.11 MACD signal ✅

- `MACD_line = EMA(close, fast) - EMA(close, slow)`。
- `MACD_signal` は **`MACD_line` のうち有限値だけを先頭から詰めた配列に対して `EMA(signal)` を取り、
  その結果を `MACD_line` が有限な index に書き戻す**。
  先頭の NaN 区間 `[0 .. validStart)` のみ欠損前提。
- `MACD_hist = MACD_line - MACD_signal`。
- 通常は途中に NaN が現れないが、現れた場合は signal 側の index が圧縮される。
  この挙動は **契約として防御テストで担保** する（アルゴリズム自体は変更しない）。
- 実装: `lib/indicators.ts::macd()` (L255-297)。

### 8.12 指標の出力配置 (`prepare_chart_data`) ✅

`tools/prepare_chart_data.ts` は指標を **price scale 系** と **独立スケール系** に振り分ける。

| 配置 | 指標グループ | 出力キー / 実装 |
|---|---|---|
| `series`（price scale 系） | `SMA_5 / 20 / 25 / 50 / 75 / 200`, `EMA_12 / 26 / 50 / 200`, `BB_upper / middle / lower`, `ICHI_tenkan / kijun / spanA / spanB / chikou` | `MAIN_SERIES_KEYS`（`tools/prepare_chart_data.ts:25-38`） |
| `subPanels`（独立スケール系） | `RSI_14`, `MACD` (line / signal / hist), `STOCH_K`, `STOCH_D` | `tools/prepare_chart_data.ts:187-227` |

⚠️ **E2E / golden で指標の存在検証を行う際は「対応する側」を見ること。**
`output.series.RSI_14` は常に `undefined` になる（RSI は独立スケール側のため）。
RSI を検証したい場合は `output.subPanels.RSI_14`、
MACD は `output.subPanels.MACD.line / signal / hist` を参照する。

---

## 後続 PR との関係

| PR | 内容 |
|---|---|
| PR1（本 PR） | §8 の契約を文書化。`lib/indicators.ts::atr()` に 1 行コメント追加 |
| PR2 | §8 の各項目に対する golden テストを追加（合成 OHLC 固定配列、丸めなし） |
| PR3 | §8.7 の誤用 2 箇所を修正（`analyzeIndicatorsHandler.ts` / `analyzeMarketSignalHandler.ts`） |
| PR4 | `get_volatility_metrics` のリファクタ（§8.10 と同系の SMA-ATR 経路を整理） |
