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
PR #489 で本セクションを契約として文書化し、PR #490 で golden / contract テスト、
PR #491 で §8.7 の handler 誤用修正、PR #492 で `get_volatility_metrics` の
`lib/indicators.ts::atr()` への統合を完了した（フェーズ4 終了）。
本セクションは契約として固定し、以降の指標変更はここを更新してから行う。

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

### 8.7 一目均衡表 snapshot スカラー ✅

`analyze_indicators` が `latestIndicators` に詰める
`ICHIMOKU_spanA` / `ICHIMOKU_spanB` は、`lib/indicators.ts::ichimokuSnapshot()` が返す
**「今日計算された先行スパン」= 26 本先にプロットされる値**。

⚠️ **「今日の雲」（現在価格との上下判定）にこのスカラーを使ってはならない。**
正しくは時系列の `ichi_series.spanA[len - 26]` / `ichi_series.spanB[len - 26]` を参照する
（`analyze_ichimoku_snapshot` がこの方式を採用済み）。

PR #491 で修正済み。修正前の誤用箇所と修正方針を以下に履歴として残す:

- `src/handlers/analyzeIndicatorsHandler.ts:564-569`
  `cloudTop` / `cloudBot` を `ind.ICHIMOKU_spanA` / `ind.ICHIMOKU_spanB` から直接組み立てていた。
  修正済み: `series.spanA[len - 26]` / `series.spanB[len - 26]` を参照する形に変更。
- `src/handlers/analyzeMarketSignalHandler.ts:137-153`
  補足指標ブロックで `spanA = ICHIMOKU_spanA` / `spanB = ICHIMOKU_spanB` をそのまま「今日の雲」として
  `cloudTop / cloudBottom` を計算し、現在価格との位置関係を出していた。
  修正済み: `series.spanA[len - 26]` / `series.spanB[len - 26]` を参照する形に変更。

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
- プロダクト上の ATR も `lib/indicators.ts::atr()` を直接利用する（PR #492 で統合）。
  `tools/get_volatility_metrics.ts` から自前の SMA-of-TR 経路は撤去済み。
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

### 8.13 ライブ spot check（任意・推奨） ✅

unit golden（§8.1–§8.12）と契約文書まで揃っても、「実 bitbank API + 未確定足を
含む最終値」が外部チャートとずれないかは別途確認が必要。手動 spot check の
手順をここに固定し、実施結果を「実施履歴」に追記していくことで、フェーズ毎に
再現可能な生存確認（regression safety net）として機能させる。

#### 目的

unit golden では捕まらない「実 API レスポンス + 未確定足を含む最終値」が、
外部チャート（TradingView / bitbank アプリ等）と一致することを手動確認する。
取得層 + 計算層 + 加工層を通したエンドツーエンドの数値契約に対する
生存確認として、phase 単位で 1 回以上記録する。

#### 実行コマンド

```bash
npx tsx scripts/analyze_indicators_cli.ts btc_jpy 1day 200
```

- ペアは `btc_jpy` / `eth_jpy` など主要 2 つで OK
- timeframe は `1day` 推奨（未確定足の影響が小さい）
- 200 本あれば EMA(200) まで安定する

#### 比較項目（最低 3 つ）

- `RSI(14)` 最終値
- `BB(20, 2)` の `upper / middle / lower` 最終値
- `MACD(12, 26, 9)` の `line / signal / hist` 最終値

#### 許容差

- **丸め**: 表示桁数 ±2 桁
- **最終足**: bitbank と外部チャートで確定タイミングが異なる場合があるため、
  最終値が外れる場合は最終-1 本目で再比較する
- それでも合わない場合は **実装側のバグ可能性あり** として記録する

#### 記録テンプレート

下の「### 実施履歴」に、以下の形式で 1 ラン 1 エントリ追加する。

```markdown
#### YYYY-MM-DD: <pair> <timeframe>
- 実行: `npx tsx scripts/analyze_indicators_cli.ts <pair> <timeframe> 200`
- 比較対象: bitbank アプリ（<PAIR> <timeframe> チャート）vs CLI（同一 API 系列）
- RSI(14): CLI=XX.XX / app=XX.XX / 差=±X.XX → OK
- BB(20,2) upper: CLI=XXXXXXX / app=XXXXXXX / 差=±X → OK
- BB(20,2) middle: ... → OK
- BB(20,2) lower: ... → OK
- MACD line: ... → OK
- MACD signal: ... → OK
- MACD hist: ... → OK
- 備考: 最終足は未確定のため最終-1 本目で比較
```

### 実施履歴

§8.13 ライブ spot check の手動実行ログ。phase ごとに最低 1 回追記する。

#### 2026-05-19: btc_jpy 1day（初回）
- 実行: `npx tsx scripts/analyze_indicators_cli.ts btc_jpy 1day 200`
- 比較対象: bitbank アプリ（BTC/JPY 1day）vs CLI
- RSI(14): CLI=47.27 / app=47.27 / 差=0.00 → OK
- BB(20,2) upper: CLI=12980216.44 / app=12980216.44 / 差=0.00 → OK
- BB(20,2) middle: CLI=12522253.70 / app=12522253.70 / 差=0.00 → OK
- BB(20,2) lower: CLI=12064290.96 / app=12064290.96 / 差=0.00 → OK
- MACD line: CLI=78470.06 / app=78470.06 / 差=0.00 → OK
- MACD signal: CLI=164547.24 / app=164547.24 / 差=0.00 → OK
- MACD hist: CLI=-86077.18 / app=-86077.18 / 差=0.00 → OK
- 備考: 同一タイミングで bitbank アプリ表示と CLI 出力が一致（未確定足含む）

---

## 9. 総合シグナルとデータ品質（フェーズ5）

`analyze_market_signal` のように複数の上流ツール（`get_flow_metrics` /
`get_volatility_metrics` / `analyze_indicators`）の結果を加工する「総合判断ツール」が、
データ不完全性を正しく伝播するための契約。LLM がデータ品質を誤認したまま
判断を出すのを防ぐ。

### 9.1 warning 系統の 2 分離 ✅

| field | 意味 | 例 |
|---|---|---|
| `meta.warning` (string) | 取得層の不完全性 | `get_candles` の multi-year / multi-day 部分失敗、partial fetch |
| `meta.warnings` (string[]) | 計算層の不完全性 | `SMA_200` がデータ不足、MACD signal の有限値不足 |

2 系統は **同じ field に混ぜない**。混ぜると LLM 側で「取得層 / 計算層」のどちらに
原因があるか判別できなくなり、ユーザー向け説明やトラブルシュートが破綻する。

根拠実装: `tools/analyze_indicators.ts:687-690`（`warning` と `warnings` を別系統で meta に詰める）。

### 9.2 加工ツールが上流 warning を必ず継承する義務 ✅

`analyze_market_signal` のような 2 段以上の加工ツールは、上流ツール
（`get_flow_metrics` / `get_volatility_metrics` / `analyze_indicators`）の
`meta.warning` / `meta.warnings` を **自分の meta に展開する**:

- `meta.warning`: 上流のうち取得層 warning を持つものを集めて連結（複数あれば改行区切り、または上流名を prefix）。
- `meta.warnings`: 上流の計算層 warnings をすべて連結する（同一文字列は重複排除して良い）。

参照実装: `tools/prepare_chart_data.ts:246-279`
（`analyze_indicators` → `prepare_chart_data` の 1 段加工で確立済みのパターン。
`upstreamWarning` / `upstreamWarnings` を切り出し、meta に展開する型紙）。

`analyze_market_signal` 実装位置: `tools/analyze_market_signal.ts:244-258`
（`collectSourceWarning` で上流 3 ツールの `meta.warning` を
`[flow] / [volatility] / [indicators]` prefix 付きで集約し、
`indRes.meta.warnings` を `upstreamWarnings` として継承。
`meta.warning` / `meta.warnings` は L685-686 で別系統で詰める）。

### 9.3 content 先頭の `⚠️` 行連結義務 ✅

handler が独自に `content` テキストを組む場合でも、tool 層の `summary` 先頭に出した
`⚠️` 行を handler 側でも **content の先頭に再連結する**。落とすと LLM は警告を
見ない（`structuredContent` の meta.warning を LLM は参照できない）。

実装方針: `tools/prepare_chart_data.ts:266-279` に倣い、`baseSummary` の前に
`upstreamWarning` / `upstreamWarnings` から組み立てた `⚠️` 行群を連結する。
`JSON.stringify(data)` を含める場合も **JSON より前** に warning 行を置く
（`.claude/rules/tools.md` の handler チェックリスト参照）。

`analyze_market_signal` 実装位置: `src/handlers/analyzeMarketSignalHandler.ts:280-295`
（`warningLines` で `meta.warning` / `meta.warnings` を `⚠️` 付きで組み立て、
`baseText` の前に連結したものを `content[0].text` に出す）。

### 9.4 `confidence` の降格契約 ✅

`analyze_market_signal` の `confidence` レベル（`high` / `medium` / `low`）は
データ品質に応じて降格する:

| 条件 | 降格後の上限 |
|---|---|
| 取得層 `meta.warning` を上流のいずれかが持っている | `confidence` は **最大 `medium`**（`high` にしない） |
| 主要要素のいずれかが null / データ不足で寄与計算不能 | `confidence = low` 固定 |

主要要素の定義（`tools/analyze_market_signal.ts:481-489` の `missingCoreFactors`）:

- `latestClose`: 最新終値が null
- `SMA_200`: `sma200` が null
- `SMA_75`: `sma75` が null
- `SMA_25`: `sma25` が null
- `RSI_14`: `rsi` が null

`smaTrendFactor`（重み 35%）の寄与計算は `latestClose` / `sma25` / `sma75` の
3 つすべてを必要とする（`tools/analyze_market_signal.ts:287` のガード）。
`sma200` は alignment bonus に加えて `dist / 0.05` 補正項にも使うため core 扱い。
`momentumFactor`（重み 30%）は `rsi` が null の場合に 0 になる。
いずれかが欠損していると `missingCoreFactors` に積まれ、`calculateConfidence` 冒頭で
`low` 固定 + 理由文に列挙される。

実装位置: `tools/analyze_market_signal.ts:363-401`（`calculateConfidence` 本体）
／ `tools/analyze_market_signal.ts:479-489`（`missingCoreFactors` の組み立てと呼び出し）。

---

## 10. パターン検出（フェーズ5）

`tools/detect_patterns.ts`（チャートパターン）と
`tools/analyze_candle_patterns.ts`（ローソク足パターン）の検出ツールについて、
出力の不変条件と再現性を契約として固定する。テスト（タスクC）はこの契約を
fixture ベースで検証する。

### 10.1 `candle_range_index` の barIndex 整合 ✅

`analyze_candle_patterns` が返す各パターンの `candle_range_index = [start, end]` は
以下の不変条件を満たす:

- `0 <= start <= end < windowCandles.length`
- 各値は `int`

実装: `tools/analyze_candle_patterns.ts:730`（`[i - config.span + 1, i]` 形式で生成）。

### 10.2 決定性 ✅

同一入力（同じ pair / type / limit / fixture）に対する出力は **決定的**。
再実行で `recent_patterns` / `data.patterns` が deep equal になる。

- 乱数・現在時刻に依存するロジックを混入させない
- 並列処理の order が出力順に出る場合はソート後に格納する

### 10.3 `status` enum 制約 ✅

許可される `status` 値:

| ツール | 許可される `status` | schema |
|---|---|---|
| `detect_patterns` | `forming` / `near_completion` / `completed` / `invalid` | `src/schema/patterns.ts:76` |
| `analyze_candle_patterns` | `forming` / `confirmed` | `src/schema/patterns.ts:286` |

上記以外の文字列は出さない。フェーズ5 では両ツールの status 集合は
`{ forming, near_completion, completed, confirmed, invalid }` のみで構成される。

### 10.4 `status` の意味的不変条件 ✅

- `completed` は **breakout 成立済み fixture** でのみ出る。形成途中の fixture では出ない。
- **whipsaw fixture**（一度ブレイクしたあと反対側に戻る価格列）では
  `completed` にならない — 三角形系（triangles / wedges / pennants）と
  doubles 系（double top / bottom）どちらも対象。
- `includeForming=false` で `forming` / `near_completion` のパターンは
  出力から **除外**される（`tools/detect_patterns.ts:194-205` のフィルタ）。

### 10.5 `allow_partial_patterns` 契約 ✅

- `allow_partial_patterns=false` の場合、`uses_partial_candle=true` のパターンは
  検出ループ段階で **skip** され、`recent_patterns` に含まれない。
- 既定値は実装側の安全側に倒す（未確定足を含むパターンを表示しない）。

実装: `tools/analyze_candle_patterns.ts:697`
（`if (usesPartial && !allowPartial) { continue; }`）。

---

## フェーズ4 実施履歴

| PR | 内容 | 状態 |
|---|---|---|
| #489 | §8 の契約を文書化 | ✅ Merged |
| #490 | §8 の各項目に golden / contract テストを追加 | ✅ Merged |
| #491 | §8.7 の誤用 2 箇所を修正 | ✅ Merged |
| #492 | `get_volatility_metrics` を `lib/indicators.ts::atr()` に統合 | ✅ Merged |
| #493 | §8.3 / §8.4 の golden テスト追加（Bollinger / Stochastic） | ✅ Merged |
| #494 | §8 をフェーズ4 merge 状態に同期 | ✅ Merged |
| #495 | §8.13 ライブ spot check 手順 + 初回実施記録 | ✅ Merged |

---

## フェーズ5 実施履歴

| PR | 内容 | 状態 |
|---|---|---|
| #496 | §9（総合シグナルとデータ品質）+ §パターン検出 を契約として追加 | ✅ Merged |
| #497 | `analyze_market_signal` 上流 warning 集約 + confidence 降格 | ✅ Merged |
| #498 | パターン検出の横断不変条件テスト追加 | ✅ Merged |
| #501 | §9.2–9.4 を実装済みに同期 + invariants テスト修正 | 🔄 Open |
