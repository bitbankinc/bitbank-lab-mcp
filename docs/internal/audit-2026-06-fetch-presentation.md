# データ正確性監査レポート — 取得層・提示層（2026-06）

## メタ情報

| 項目 | 値 |
|---|---|
| 監査日 | 2026-06-16 |
| ベースコミット | `93fef38`（`origin/main` 相当, branch `claude/blissful-bell-v1uvco`） |
| 対象層 | 取得層（fetch）・提示層（presentation）。計算層は監査済み（本タスク対象外） |
| 監査手法 | 既存監査資産（`tests/market_data_audit.test.ts` 他）の通し実行 + 再現テスト（`tests/audit_layer2_probe.test.ts`） |
| 方針 | **修正は提案のみ。本タスクではコード修正を適用しない。** |

### 監査対象ファイル

- 取得層: `tools/get_ticker.ts` / `src/handlers/getTickersJpyHandler.ts` + `tools/get_tickers_jpy.ts` / `tools/get_orderbook.ts` / `tools/get_transactions.ts` / `tools/get_candles.ts` / `tools/prepare_depth_data.ts` / `lib/get-depth.ts` / `lib/candle-fetch.ts` / `lib/candle-validate.ts` / `lib/datetime.ts` / `lib/conversions.ts`
- 提示層: `tools/prepare_chart_data.ts` / `tools/prepare_depth_data.ts` / 各 `build*Text` / 各 handler の `content` / `lib/warning-propagation.ts`

### 既存監査資産の baseline（全 green を確認）

```
$ npx vitest run tests/market_data_audit.test.ts tests/validate_candle_data.test.ts tests/warning-propagation.test.ts
 Test Files  3 passed (3)
      Tests  70 passed (70)

$ npx vitest run tests/get_candles.test.ts
 Test Files  1 passed (1)
      Tests  77 passed (77)

$ npx vitest run tests/get_orderbook.test.ts tests/get_transactions.test.ts tests/validate_candle_data.test.ts
 Test Files  3 passed (3)
      Tests  78 passed (78)
```

→ 既存の防御（timestamp の `Date.now()` fallback 排除、NaN/Infinity 再帰検査、JSON 往復、TZ anchor）は **既存テストの範囲では健全**。本監査は既存テストが**触れていない経路**を再現テストで補った。

### 追加した再現テスト

`tests/audit_layer2_probe.test.ts`（11 件, 全 pass）。本レポートの F1 / P1 / P2 / P3 を characterization test として固定。

```
$ npx vitest run tests/audit_layer2_probe.test.ts
 Test Files  1 passed (1)
      Tests  11 passed (11)
```

---

## サマリ（層別）

| 区分 | 取得層 | 提示層 |
|---|---|---|
| **確認済み問題** | F1（`get_orderbook` の非数値 sanitize 欠如・mode 間不整合） | P1（`get_candles` `view=items` の warning/meta 欠落）, P2（`get_orderbook` 単位 "BTC" ハードコード） |
| **推測** | — | P3（`get_transactions` filter+summary の行欠落, 仕様の可能性）, P4（`analyzeMarketSignalHandler` 自前連結）, P5（`prependVolWarning` の `warnings[]` 非対応） |
| **要追加確認** | （なし — A1 は本監査内で解決） | — |
| **確認済み（問題なし）** | TZ（doc 一致・**ライブ再確認済 2026-06-16**）, timestamp fallback, NaN/Infinity（他ツール）, multi-day 重複/欠落, A1（軽微・設計通り） | 丸めは表示境界のみ（計算側は full precision） |

---

# 取得層

## 【確認済み問題】F1 — `get_orderbook` が非数値 price を sanitize せず、mode 間で挙動が不整合

### ① 該当箇所
- `tools/get_orderbook.ts:514-515` — `bidsNum`/`asksNum` を `Number(p)` で変換するが**有限値フィルタ無し**（`prepare_depth_data.ts:39-55` の `toFiniteTuples` 相当が無い）。
- `tools/get_orderbook.ts:223-225`（statistics）— `Math.max(...bidsNum.map([p]))` は要素に NaN があると全体 NaN。
- `tools/get_orderbook.ts:61-68`（summary）— `bids[i].price` が NaN のまま出力配列に載る。
- スキーマ: `src/schema/market-data.ts:34` `OrderbookLevelSchema = z.object({ price: z.number(), size: z.number() })`（Zod v4 の `z.number()` は NaN を reject）。
- 対照（正しい実装）: `tools/prepare_depth_data.ts:131-132, 190-200`（drop + `meta.droppedRows` + `⚠️` warning）。
- 既存規約: `tools/get_candles.ts:528-531` は「Number 変換失敗（NaN）は Zod parse で reject され outer catch で 'network' 誤分類される。実態は上流データ品質なので明示的に 'upstream' 分類する」と**同じ罠を回避済み**。`get_orderbook` は未対応。

### ② 実行コマンド
```
npx vitest run tests/audit_layer2_probe.test.ts -t "F1"
```

### ③ 観測した出力（bids 先頭 price を `"abc"` に差し替えた `/depth` モック）
```
=== mode=summary ===
ok: false | errorType: network
summary: Error: [ { "code": "invalid_union", ... "expected": "number", "received": "NaN", "path": ["data","normalized","bestBid"] ...

=== mode=statistics ===
ok: false | errorType: network
summary: Error: [ ... "received": "NaN", "path": ["data","basic","currentPrice"] ...

=== mode=raw ===
ok: true | errorType: -
summary: 📸 ... BTC/JPY 中値=NaN円 ... 🟢 買い板 (全2層): 1. NaN円 0.3 2. 5,000,000円 0.5 ...
raw.data.bids[0]: ["abc","0.3"]

=== mode=pressure ===
ok: true | errorType: -
summary: ... ±0.10%: 買い 0.00 BTC / 売り 0.00 BTC (圧力: 0.0%) ... 💡 総合評価: 均衡
pressure.bands[0]: {"baseMid":null,"baseBidSize":0,...,"netDeltaPct":null,"tag":null}
```

### 評価
- **summary / statistics**: 上流データ品質の問題が **`errorType:'network'` に誤分類**され、Zod の生エラー（`invalid_type / received NaN`）が LLM 可視 `summary` に漏出する。`get_candles` が明示的に避けた罠（`get_candles.ts:528-531`）と同型。
- **raw**: 破損値 `"abc"` が drop されず `data.bids[0]` にそのまま残り、テキストに `NaN円` / `中値=NaN円` が出る（提示層にも波及）。warning/droppedRows 無し。
- **pressure**: 最良気配が破損すると `baseMid=null` に**黙って退行**し、全 band ゼロ＝「総合評価: 均衡」と提示する（誤った安心情報）。
- **層をまたぐ事故**: 同じ `/depth` レスポンスに対し `prepare_depth_data` は「drop + warning」、`get_orderbook` は「mode により crash / NaN 流出 / 無言退行」と**4 通りに分岐**。データ正確性契約が tool 間で不統一。

### 修正案（適用しない）
1. `get_orderbook` の `/depth` 正規化に `prepare_depth_data.ts` の `toFiniteTuples` 相当を導入し、非有限 level を drop。
2. drop 件数を `meta.droppedRows` + `⚠️` warning として surface（`prepare_depth_data` と対称化）。
3. 全件 drop / best 気配欠損は `fail(..., 'upstream')` に明示分類（`get_candles.ts:528-570` のパターンを踏襲）。

---

## 【確認済み・問題なし】取得層のその他観点

### TZ（一次ソース `docs/internal/bitbank-candle-tz.md` と突合）
- `tools/get_candles.ts:135-149`（`computeAnchorEndMs`, tz 暦日終端）, `307-343`（sub-day の UTC key 導出）, `351-368`（YEARLY tz window）は doc の「UTC fetch key + tz anchor filter」二段構えと一致。
- 証拠: `npx vitest run tests/get_candles.test.ts`（77 pass）。`tests/get_candles.test.ts:864-901` が `tz='Asia/Tokyo'` / `tz='UTC'` で `keyPoints.date` が変わること（doc の §6 と一致）、`:843` が `isoTimeLocal='2024-01-01T09:00:00'`（JST 表示）を固定。
- `1day`+`YYYY` の「UTC 00:00 基準 daily」も doc §7 の限界どおり（厳密 JST 日足ではない旨は doc 明記済）。
- **ライブ再確認済み（2026-06-16, `btc_jpy`, public API 直叩き）**。サンドボックスは `public.bitbank.cc` が許可リスト外のため、ローカル `curl`+`jq` で実測（doc の測定は 2026-05-22 / `d5b1fff`）:
  - `GET /candlestick/1hour/20260615` → `count=24, first=2026-06-15T00:00:00Z, last=2026-06-15T23:00:00Z`（= JST 06-15 09:00〜06-16 08:00）→ **UTC 暦日グルーピング**（doc §1）と一致。
  - `GET /candlestick/1day/2026` → `count=167, first=2026-01-01T00:00:00Z`（UTC 00:00 基準 / 経過日数）→ doc §2 と一致。
  - `GET /candlestick/1hour/{20100101,20991231}` → ともに `HTTP 404`（取引開始前・未来）→ doc §3-5 と一致。
  - → doc の前提（UTC fetch key + tz anchor filter）は今日時点でも有効。**TZ は問題なし（ライブ確定）**。

### timestamp 欠損 → `Date.now()` fallback 排除
- `lib/get-depth.ts:80-83`, `tools/get_orderbook.ts:508-511`, `tools/prepare_depth_data.ts:164-166`（getDepth 保証に委譲）, `tools/get_candles.ts:563-569` いずれも欠損/≤0/非有限を `upstream` fail に倒す。
- 証拠: `tests/market_data_audit.test.ts`「4. timestamp fallback inventory」全 pass（baseline 70 に含む）。

### NaN/Infinity（他ツール）・JSON 往復
- `get_ticker` / `get_transactions` / `get_candles` / `prepare_depth_data` / `get_tickers_jpy` は `tests/market_data_audit.test.ts`「2. JSON safety」「3. round-trip」で再帰検査済み。`toNum`（`lib/conversions.ts:20-25`）が `''`/`NaN`/`Infinity` を null 化。
- 例外は上記 F1（`get_orderbook` のみ未防御）。

### multi-day/multi-year の欠落・重複・整合
- 重複: `lib/candle-fetch.ts:202-223` `dedupeByTimestamp`（同一 ts の全 0 プレースホルダ除去、volume 優先）。
- 整合: `mergeChunks`（`:124-161`）が ts 昇順マージ + `failedKeys` 返却。`get_candles.ts:407-415, 446-453` が「過半数失敗→fail / 一部失敗→`meta.warning`」。
- 欠落検出: `lib/candle-validate.ts:123-157` `checkCompleteness`（`tools/validate_candle_data.ts` 起点）。証拠: `tests/validate_candle_data.test.ts` pass。
- → 取得層の集約ロジック自体は健全（**ただし** 一部失敗時の `meta.warning` が提示層 `view=items` で落ちる → P1 参照）。

## 【確認済み・軽微】A1 — `formatDateWithDayOfWeek` が UTC 暦日で曜日を出す
- `lib/datetime.ts:169-177` は `.utc()` 固定で `M/D(曜日)` を生成。
- **利用箇所を確定**: `src/handlers/analyzeCandlePatternsHandler.ts:156-157, 215-217, 310, 351`（ローソク足パターンの日付ラベル）。`get_*` 取得層では未使用。
- **評価**: 日足（ts=UTC 00:00）では UTC 暦日 == 表示意図の日付で問題なし（本リポジトリの daily=UTC 基準の方針と整合）。**intraday（1hour 等）でパターン検出した場合のみ**、他ツールの JST 表記（`isoTimeLocal`）と UTC 深夜帯で最大 1 日/曜日ずれる余地。`tests/lib/datetime.test.ts:153-163` が UTC 挙動を固定（= 意図的）。
- → 当初「要追加確認」だったが本監査内で解決。**軽微**（intraday パターンの日付ラベルのみ、設計通り）。修正は任意（intraday で JST 揃えにするなら tz 引数化）。

---

# 提示層

## 【確認済み問題】P1 — `get_candles` の `view=items` が summary（先頭の fetchWarning）と meta を丸ごと落とす

### ① 該当箇所
- `tools/get_candles.ts:786-792` — `view==='items'` 分岐は `content=[items の JSON のみ]`, `structuredContent={ items }` を返す。`result.summary`（先頭に `fetchWarning` を連結, `:708-715`）と `result.meta`（`meta.warning=fetchWarning`, `:719`）が**両方とも欠落**。
- 規約違反: `.claude/rules/tools.md`「加工ツールの場合、`view=items` 等の代替ビューでも warning 行が消えないようにする」。
- 対照: `tools/get_transactions.ts:244-253` は `view=items` で `content.push(res.meta.warning)` と warning を保持している。

### ② 実行コマンド
```
npx vitest run tests/audit_layer2_probe.test.ts -t "P1"
```

### ③ 観測した出力（multi-day の最古 chunk のみ `success:0` にして fetchWarning を発生）
```
[P1] full.hasWarning=true items.hasWarning=false
     items.structuredContent.keys=["items"] items.hasMeta=false
[P1] items.content[0].text head="[ { "open": 5000000, "high": 5000100, "low": 4..."
```
- full view: content に `⚠️ …日中…日の取得に失敗しました…` が出る。
- items view: 同条件で warning が消失。`structuredContent` は `{ items }` のみ（meta/summary 無し）。

### 評価
multi-day/multi-year の**一部失敗は実運用で起こり得る**（レート制限・一時的 404）。その状態で LLM が `view=items` を使うと、データが不完全であることに気づけず、欠落区間を「データなし＝平穏」と誤解しハルシネーションを起こす。取得層の防御（`meta.warning`）が提示層で握り潰される典型的な「層をまたぐ事故」。

### 修正案（適用しない）
`view==='items'` 分岐で `result.meta.warning` があれば `content` に別 text として push（`get_transactions.ts:244-253` と同じ形）。`structuredContent` にも `meta` を含める。

---

## 【確認済み問題】P2 — `get_orderbook` の pressure / statistics が出来高単位 "BTC" を全ペアでハードコード

### ① 該当箇所
- `tools/get_orderbook.ts:197`（pressure）— `買い ${b.baseBidSize.toFixed(2)} BTC / 売り ${...} BTC`
- `tools/get_orderbook.ts:360`（statistics 板の厚み）— `買い ${r.bidVolume} BTC / 売り ${r.askVolume} BTC`
- `tools/get_orderbook.ts:371, 375`（statistics 大口注文）— `…円に${o.size} BTC`
- いずれも `pair` に依存せず `BTC` 固定。`get_ticker.ts:30`・`get_candles.ts:701`・`prepare_depth_data.ts:188` は `pair.split('_')[0].toUpperCase()` でベース通貨を導出しており不整合。

### ② 実行コマンド
```
npx vitest run tests/audit_layer2_probe.test.ts -t "P2"
```

### ③ 観測した出力（`pair='eth_jpy'`）
```
[P2 summary] eth_jpy hasBTC=false hasETH=true
[P2 pressure] eth_jpy hasBTC=true  hasETH=true   ← ETH 板なのに "BTC"
[P2 statistics] eth_jpy hasBTC=true hasETH=false ← "BTC"
[P2 raw] eth_jpy hasBTC=false hasETH=true
```

### 評価
非 BTC ペア（`eth_jpy`, `xrp_jpy`, `sol_jpy` 等＝**全 JPY ペアの大半**）で、LLM 可視テキストの出来高単位が一律 "BTC" と誤表示。数値自体は正しいが単位語が誤りで、LLM がそのまま「○○ BTC の売り板」とユーザーに伝達し得る。発生頻度が高い（pressure/statistics を非 BTC ペアで使う度）。

### 修正案（適用しない）
`getOrderbook` 冒頭で `const baseCcy = chk.pair.split('_')[0].toUpperCase();` を導出し、`buildPressure` / `buildStatistics` に渡してテキストの `BTC` を `baseCcy` に置換。

---

## 【推測】P3 — `get_transactions` の filter + 既定 `view=summary` が個別約定行を落とす

### ① 該当箇所
- `tools/get_transactions.ts:224-243` — handler。`hasFilter` 真かつ `view='summary'`（既定）のとき、summary を `フィルタ後 N件 (buy=… sell=…)` に**差し替え**、本体の `txLines`（`:147-156` の `📋 全N件の取引`）を含めない。
- フィルタ無し時は `res.summary`（個別行入り）をそのまま返す（`:243`）。

### ② 実行コマンド
```
npx vitest run tests/audit_layer2_probe.test.ts -t "P3"
```

### ③ 観測した出力
```
[P3] noFilter.hasRows=true filtered.hasRows=false
[P3] filtered.summary="BTC/JPY フィルタ後 1件 (buy=0 sell=1)"
```

### 評価（推測）
`minAmount` 等でフィルタすると、LLM 可視 content は件数のみで、どの約定がヒットしたか（時刻・価格・数量）が見えない（`structuredContent` には入るが LLM は読めない）。「大口約定を見せて」系の用途で詳細が欠落する。一方で `view=items` を使えば JSON が返るため、**仕様（summary=件数のみ）の可能性**もある。意図確認が必要なため「推測」。断定しない。

### 修正案（適用しない）
filter 時の summary にもフィルタ後の `txLines` を付す、または filter 指定時は既定 view を `items` に寄せる。

---

## 【推測】P4 / P5 — 上流 warning 伝播の自前実装（規約逸脱・低リスク）

### P4: `analyzeMarketSignalHandler.ts:283-295`
- `meta.warning` / `meta.warnings` を `split('\n')` → `⚠️` 付与 → join と**手書き**で連結（`lib/warning-propagation.ts` の `prependWarnings` 不使用）。
- 現状は `prependWarnings(baseText, m, {separator:'\n'})` と**機能等価**（両系統を処理）。データ正確性バグではないが、`prependWarnings` 仕様変更時に drift する DRY リスク。**規約**（`.claude/rules/tools.md`「実装は `lib/warning-propagation.ts` を使う」）逸脱。

### P5: `getVolatilityMetricsHandler.ts:20-25` `prependVolWarning`
- `meta.warning`（string）のみ処理し、`meta.warnings[]`（計算層）を**処理しない**。
- 現状 `get_volatility_metrics.ts:343` は `metaExtra.warning` しか設定せず `warnings[]` を出さないため**実害なし**。ただし将来 `warnings[]` を足すと無言で落ちる潜在リスク。コードからの推論であり、現行データでの実害は未観測 → 「推測（低リスク）」。

### 修正案（適用しない）
両者とも `prependWarnings`（`{separator:'\n'}`）へ置換し、`warning`/`warnings` 両系統を一元処理。

---

## 【確認済み・問題なし】提示層のその他観点

### 上流 warning 伝播（主要加工ツールは規約準拠）
- `prepare_chart_data.ts:250-256, 275`（`extractUpstreamWarning` + `prependWarnings`、自動切り詰め warning も同 channel に統合）, `render_chart_svg` / `detect_patterns` / `analyze_*_snapshot` / `analyze_mtf_*` / `analyze_indicators` handler 等は `lib/warning-propagation.ts` 経由（Explore 走査で確認、`prepend_warnings`/`extractUpstreamWarning` の import 群）。
- `get_volatility_metrics` の `view=summary`（`getVolatilityMetricsHandler.ts:247-252`）は `res.summary` をそのまま返すが、tool 側（`get_volatility_metrics.ts:337-343`）で warning を summary 先頭へ連結済みのため **保持される**。

### 丸めは表示境界のみ（計算側で丸めていない）
- `prepare_chart_data.ts:47-50, 163-185` の `roundValue` は出力配列のみ。指標計算（`analyze_indicators`）は full precision。
- `prepare_depth_data.ts:146-162` の `mid`/`spread`/`spreadPct`/`bandRatio` は**生値で計算**し、出力時のみ丸め（`:171-182`）。`spreadPct`(`:148`) は生 `spread/mid`、`bandRatio`(`:162`) は生 `bandBidVol/bandAskVol`。
- `get_candles.ts:601-640` の `volumeStats.changePct` は生平均で計算し出力時 `toFixed`。`keyPoints.changePct`(`:657-673`) も生 close。
- → 計算側 round は検出されず。健全。

### content にデータが含まれる（LLM 可視性）
- `prepare_chart_data.ts:312` / `prepare_depth_data.ts:233` / `validate_candle_data.ts:254` / `get_candles`(full) / `get_transactions`(summary) / `get_orderbook`(全 mode) は `summary` または `JSON.stringify(data)` を content に含める。`tests/market_data_audit.test.ts`「5. content visibility」で件数/timestamp/warning の可視性を確認済み（baseline pass）。例外は P1（view=items のみ）。

---

# リスクスコア

評価軸: **影響度**（誤情報が分析・発注判断に与える深刻度, 1-5）× **発生/露出頻度**（実運用での到達しやすさ, 1-5）。検知難度が高い（無言）ものは影響度に +1 補正。

| ID | 指摘 | 層 | 影響度 | 頻度 | スコア | 区分 |
|---|---|---|---:|---:|---:|---|
| **P1** | `get_candles view=items` で取得層 warning/meta 欠落 | 提示 | 4 | 3 | **12** | 確認済み |
| **F1** | `get_orderbook` 非数値 sanitize 欠如・mode 不整合 | 取得 | 4 | 3 | **12** | 確認済み |
| **P2** | `get_orderbook` 単位 "BTC" ハードコード | 提示 | 3 | 4 | **12** | 確認済み |
| P3 | `get_transactions` filter+summary 行欠落 | 提示 | 3 | 2 | 6 | 推測 |
| P4 | `analyzeMarketSignalHandler` 自前 warning 連結 | 提示 | 2 | 2 | 4 | 推測 |
| A1 | `formatDateWithDayOfWeek` UTC 暦日（intraday のみ JST と差） | 提示 | 2 | 1 | 2 | 確認済み（軽微・設計通り） |
| P5 | `prependVolWarning` が `warnings[]` 非対応 | 提示 | 1 | 1 | 1 | 推測（潜在） |

## 上位 3 件

1. **P1 — `get_candles view=items` の warning/meta 欠落（提示層, score 12）**
   取得層が正しく出した「部分取得失敗」警告が提示層で握り潰される。multi-day/year の一部失敗は実運用で起こり、LLM が欠落に気づけずハルシネーションを起こす。`.claude/rules/tools.md` の明示規約違反で、修正コストも小（`get_transactions` に既存パターンあり）。**最優先。**

2. **F1 — `get_orderbook` の非数値 sanitize 欠如（取得層, score 12）**
   同一の破損 `/depth` に対し `prepare_depth_data` は drop+warning、`get_orderbook` は mode 別に「'network' 誤分類 / `NaN円` 流出 / 無言退行」と 4 分岐。`get_candles.ts:528-531` が既に回避した罠の再来で、データ正確性契約が tool 間で不統一。

3. **P2 — `get_orderbook` 単位 "BTC" ハードコード（提示層, score 12）**
   pressure/statistics で全ペアの出来高単位を "BTC" 固定。非 BTC ペア（JPY ペアの大半）で LLM に誤った単位を渡す。発生頻度が高い割に修正は局所的（ベース通貨を導出して差し込むだけ）。

---

## 付録: 監査で追加した再現テスト

`tests/audit_layer2_probe.test.ts`（11 件）。F1/P1/P2/P3 の現状挙動を固定する characterization test。修正適用時は本ファイルの期待値更新＝指摘クローズの確認に使える。P4/P5 はコード読解ベースの指摘で再現テスト未追加（必要なら別途追加提案）。A1 は `tests/lib/datetime.test.ts:153-163` が UTC 挙動を固定済み。TZ はライブ実測（2026-06-16, §TZ）で再確認済み。
