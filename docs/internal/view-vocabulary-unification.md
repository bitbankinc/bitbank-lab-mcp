# `view` 語彙の統一 — 調査結果と設計提案

`view` パラメータの値がツール間で不揃いで、**同じ語が異なる重さを指している**問題の調査記録と設計提案。
起票時点では設計提案のみでコードは変更していなかった。**Phase 1（PR 0〜3）は実装済み**——
実施状況と「各 PR で実際に入ったもの」は §7 を参照すること。

対象は MCP のツール入力スキーマ（`inputSchema`）として外部クライアントに公開される `view` の enum 値。
enum 値の変更は破壊的変更になるため、移行方針まで含めて先に合意する。

> **§1〜§2 と付録は調査記録であり、現状の説明ではない。**
> 記述と行番号は本ドキュメント作成時点（PR #18 マージ時の `main` = `8a772c7`）のコードに対応する。
> 以降の実装 PR で解消された指摘もそのまま残してある——「なぜこの設計にしたか」の一次ソースであり、
> 実装後に書き換えると設計判断の根拠が失われるため（`docs/internal/bitbank-tx-archive-tz.md` と同じ扱い）。
> **どの指摘がどの PR で解消済みかは §7「実施状況」を参照すること。**
> §3 以降（設計・移行方針・PR ブリーフ）は後続セッションが仕様書として読むため、実装の進捗に追随させる。

---

## 0. 前提の訂正（調査で判明した 2 点）

### 0-1. `analyze_indicators` に `view` は無い

起票時の表では `analyze_indicators`（`src/schema/analysis.ts:23`）が `summary / detailed / full / beginner` を
持つとされていたが、**`analyze_indicators` の入力スキーマに `view` は存在しない**。

- `GetIndicatorsInputSchema`（`src/schema/indicators.ts:125-128`）は `pair` / `type` / `limit` のみ。
- ハンドラ（`src/handlers/analyzeIndicatorsHandler.ts:486`）も `{ pair, type, limit }` しか受け取らない。
- `src/schema/analysis.ts:24` の `summary / detailed / full / beginner` は **`GetVolMetricsInputSchema`**
  （ツール名 `get_volatility_metrics`）のもの。

以降、この行は `get_volatility_metrics` として扱う。

### 0-2. `view` を持つツールは 5 つではなく 7 つ

| ツール | 定義位置 | 値 | default |
|---|---|---|---|
| `get_candles` | `src/schema/market-data.ts:250` | `full` / `items` | **`full`** |
| `get_transactions` | `src/schema/market-data.ts:319` | `summary` / `items` | `summary` |
| `get_flow_metrics` | `src/schema/market-data.ts:498-504` | `summary` / `compact` / `buckets` / `full` | `summary` |
| `detect_patterns` | `src/schema/patterns.ts:65` | `summary` / `detailed` / `full` / `debug` | `detailed` |
| `get_volatility_metrics` | `src/schema/analysis.ts:24` | `summary` / `detailed` / `full` / `beginner` | `summary` |
| `get_tickers_jpy` | `src/handlers/getTickersJpyHandler.ts:58` | `items` / `ranked` | `ranked` |
| `detect_macd_cross` | `tools/detect_macd_cross.ts:609` | `summary` / `detailed` | `summary` |

`get_tickers_jpy` / `detect_macd_cross` は起票時の表に含まれていないが、同じ `view` という名前で
公開されている以上、語彙統一の対象範囲を決めるうえで無視できない。§1.6 で挙動を、§3.4 で扱いを示す。

---

## 1. 挙動表（全ツール × 全 view 値）

### 1-0. 読み方（全ツール共通の前提）

- **`content[0].text` だけが LLM に見える**（`.claude/rules/tools.md`）。`structuredContent` は
  MCP ホスト / 外部クライアント向けの契約。
- ハンドラが `{ content, structuredContent }` を返さず生の `Result` を返した場合、`src/server.ts` の
  `respond()`（`src/server.ts:33-85`）が **`content[0].text = result.summary`**、
  **`structuredContent = result` 全体**にフォールバックする。
- 行数は **ハンドラのコードから算出した値**（1 件あたりの出力行数 × 件数）。この環境からは bitbank API に
  到達できないため実 API 実測ではない。件数は各ツールの `limit` 既定値・上限から取っている。
- `JSON.stringify(x, null, 2)` の 1 要素あたり行数 = `{` + フィールド数 + `}`。
  - 正規化ローソク足 = 8 フィールド（`tools/get_candles.ts:678-687`）→ **10 行/本**
  - 正規化約定 = 6 フィールド（`TransactionItemSchema`）→ **8 行/件**

---

### 1-1. `get_candles`（`tools/get_candles.ts:882-923`）

| view | `content[0].text` の内容 | `structuredContent` | 出力規模（limit=200 の場合） |
|---|---|---|---|
| **`full`**（default） | `result.summary` 全文 **＋** 先頭 5 本の pretty JSON。`result.summary` 自体が `📋 全N件のOHLCV` として**全ローソク足を 1 行 1 本の圧縮形式**（`[i] time O: H: L: C: V:`）で含む（`tools/get_candles.ts:816-826`）。加えて価格範囲・キーポイント・出来高統計・`含まれるもの/含まれないもの/補完ツール` フッタ・`⚠️ fetchWarning` / `ℹ️ 形成中足注記` | `toStructured(result)` = `Result` 全体（`ok` / `summary` / `data.{raw, normalized, keyPoints, volumeStats}` / `meta`） | 本文 200 行 + ヘッダ/フッタ ~15 行 + サンプル JSON 52 行 ≒ **270 行** |
| `items` | **全 200 本の pretty JSON のみ**。`content[1]` に `meta.warning`、`content[2]` に形成中足注記を別ブロックで追加（`tools/get_candles.ts:900-912`）。summary 本文・価格範囲・キーポイント・出来高統計・フッタは**出ない** | **`{ items, meta }`** ← `ok` / `summary` / `data` の封筒ごと消える。`data.raw` / `data.keyPoints` / `data.volumeStats` も落ちる | 10 行/本 × 200 + 2 ≒ **2,002 行** |

**この 1 表で分かること**: `get_candles` では **`items` のほうが `full` より約 7.4 倍重い**。
「全部（full）」より「明細だけ（items）」のほうが重い、という語感と逆の関係になっている。
`items` は量ではなく**出力形式**（散文 → JSON）の指定であり、その副作用として重い。

**軽いビューが存在しない**: `get_candles` には集計だけを返す選択肢が無い。出力量を絞る手段は `limit` のみ。

---

### 1-2. `get_transactions`（`tools/get_transactions.ts:320-374`）

| view | `content[0].text` の内容 | `structuredContent` | 出力規模（limit=100 の場合） |
|---|---|---|---|
| **`summary`**（default） | ハンドラは `{ ...res, summary }` という**生の `Result`** を返し、`respond()` が `summary` を `content` に載せる。その `summary` は `📋 全N件の取引` として**返却した全約定を 1 行 1 件**で含む（`tools/get_transactions.ts:253-259`）＋ `⚠️ truncationWarning` ＋ `TX_SCOPE_FOOTER`。フィルタ指定時はハンドラが `summary` を差し替えるが、そちらも**全件行を含む**（`:357-361`） | `Result` 全体（`ok` / `summary` / `data.normalized` / `meta`） | 100 行 + ヘッダ/警告/フッタ ~12 行 ≒ **112 行** |
| `items` | **全 100 件の pretty JSON のみ**。`meta.warning` があれば `content[1]` に別ブロック追加。`TX_SCOPE_FOOTER` と件数サマリは**出ない** | `{ ...res, summary }` ← `get_candles` の `items` と違い**封筒は保持**される | 8 行/件 × 100 + 2 ≒ **802 行** |

**この表で分かること**:

1. `get_transactions` の **`summary` は「全件列挙」**。`get_candles` の `full` と実質同じ挙動に
   **違う名前**が付いている。「`get_candles` だけ default が `full`」という起票時の観測は、正確には
   **「同じ挙動に `full` と `summary` の 2 つの名前が付いている」**である（§3.5 で扱う）。
2. 同じ `items` という値なのに、`get_candles` は `structuredContent` の封筒を捨て、
   `get_transactions` は保持する。**同名の値が同じ契約を意味していない**。

---

### 1-3. `get_flow_metrics`（`tools/get_flow_metrics.ts:677-767`）

| view | `content[0].text` の内容 | `structuredContent` | 出力規模（hours=24 / bucketMs=60000 → 約 1,440 バケット） |
|---|---|---|---|
| **`summary`**（default） | `res.summary` そのまま。= baseSummary（pair / 最終値 / trades / buy% / CVD / スパイク上位3件 / 実取得範囲）＋ `⚠️` 取得層 warning ＋ `⚠️` 計算層 warnings ＋ `aggregates:` 1 行 ＋ 4 行フッタ（`含まれるもの` / `含まれないもの` / `補完ツール` / `加工契約`）。**バケット行なし** | **`series.buckets` キーを削除**した `Result`（`:715-720`） | **≒ 10 行** |
| `compact` | `res.summary`（上と同一・フッタ込み）＋ `Non-zero X/Y buckets:` ＋ **非ゼロバケット行**。欠損バケットは落とさず `⋯ 欠損 A〜B（Nバケット, データなし）` の区間 1 行に畳む（`:730-741`, `renderCompactBucketLines`） | `series.buckets` を **非ゼロ ∪ 欠損** でフィルタした `Result`（`:731-736`） | 10 + 非ゼロ件数（データ依存、**0〜1,440 行**） |
| `buckets` | **`res.summary` を使わない再構築テキスト**: `PAIR Flow Metrics (bucketMs=…) 実取得範囲…` ＋ `Totals:` ＋ warning 行 ＋ **直近 `bucketsN` 件**（既定 10 / 上限 100）（`:759-763`） | `Result` **全体（全バケット入り）** | 3 + `bucketsN` ≒ **13 行**（既定） |
| `full` | `buckets` と同じ再構築ヘッダ ＋ **全バケット行**（`:765-766`） | `Result` 全体 | 3 + 1,440 ≒ **1,443 行** |

**この表で分かること**:

1. `summary` と `full` の差は **約 144 倍**。同じ `full` という語が `get_candles` では既定表示、
   ここでは最重量を指す。
2. **重い view が軽い view の上位集合になっていない。** `buckets` / `full` は `res.summary` を
   捨てて短いヘッダを組み直すため、`summary` / `compact` にある以下が**消える**:
   最終約定価格、スパイク上位 3 件の詳細、`加工契約` を含む 4 行フッタ。
3. **`view` が `structuredContent` の契約を変える。** `summary` は `series.buckets` を削除するが、
   `GetFlowMetricsDataSchemaOut`（`src/schema/market-data.ts:379`）は `series: z.object({ buckets: ... })`
   を**必須**で宣言している。ハンドラの加工後に再 parse していないため実行時エラーにはならないが、
   **宣言スキーマを満たさない `structuredContent` が出ている**。`compact` も同様に、宣言上は全バケットの
   はずが部分集合になる。
4. **削減の実効性が無い。** `structuredContent` から `buckets` を落とす動機はトークン削減だが、
   本リポジトリの前提（§2-0、`.claude/rules/tools.md`「LLM は `structuredContent` を参照できない」）
   の下では **LLM 側のトークンは 1 つも減らない**（元から見ていない）。減るのはホストが
   `structuredContent` も文脈に載せる場合のみで、その代償として非 LLM クライアントの契約が壊れている。

---

### 1-4. `detect_patterns`（`src/handlers/detectPatternsHandler.ts:44-108` / `detectPatternsViewsHandler.ts`）

`meta.debug.swings` / `meta.debug.candidates` はいずれも **cap=200 でトリム済み**（`tools/detect_patterns.ts:282-291`。
candidates は `accepted` 優先で 200 件まで）。全 view で `meta.debug` は付く。

| view | `content[0].text` の内容 | `structuredContent` | 出力規模 |
|---|---|---|---|
| `summary` | ヘッダ 1 行（`PAIR 日足（1day） 180本からN件を検出`）＋ 分類内訳・直近30日/90日件数 ＋ 期間行 ＋ 検討パターン ＋ `※形成中は includeForming=true` ヒント（`:689-707`）。**個々のパターンは出ない** | `toStructured(res)` = `Result` 全体（`data.patterns` 全件） | **≒ 5 行** |
| **`detailed`**（default） | ヘッダ ＋ 期間行 ＋ **上位 5 件のみ**（`pats.slice(0, 5)`、`:743`）の詳細ブロック ＋ 0 件時の代替文 ＋ overlays 案内 ＋ 整合度の凡例 6 行 ＋ `usage_example` 3 行 | **`{ ...res, usage_example }`** ← `usage_example` を追加した独自 shape（`:764-774`） | 5 件 × 8〜15 行 + 定型 ~14 行 ≒ **60〜90 行** |
| `full` | ヘッダ ＋ 期間行 ＋ **全件**の詳細ブロック（`:720`）。`double_top` / `double_bottom` では山谷 3 点の pivot 行が追加される（`formatPatternLine` の `view === 'full'` 分岐、`:481-493`）＋ overlays 案内 ＋ 整合度の凡例 | `toStructured(res)` = `Result` 全体 | 検出件数 × 10〜17 行 + 定型 ~10 行（検出 20 件で **≒ 300 行**） |
| `debug` | **パターンを 1 件も出さない。** ヘッダ ＋ `【Swings】`（≤200 行）＋ `【Candidates】`（≤200 件、各 1〜3 行）のみ（`:295-345`） | **`{ data: { ...res.data, candidates }, meta, ok, summary }`** ← `data.candidates` を追加した独自 shape | 最大 **≒ 450 行** |

**この表で分かること**: `debug` は階梯の最上段ではない。`full` の上位集合ではなく、
**出力そのものを別物に置換する**（検出パターンが本文から消える）。量の語彙とは直交する。

---

### 1-5. `get_volatility_metrics`（`src/handlers/getVolatilityMetricsHandler.ts:137-263`）

`structuredContent` は **全 view で同一**（`{ ...res, data: { ...res.data, tags: tagsAll } }`）。
`data.series.{ts,close,ret}`（limit 上限 500 本）は view に関係なく常に入る。

| view | `content[0].text` の内容 | 出力規模（windows 既定 `[14,20,30]`） |
|---|---|---|
| `beginner` | 平易な日本語 4 行（現在価格 / 年間のおおよその動き / 1日の平均的な動き / 今の傾向）（`:55-69`） | **≒ 4 行** |
| **`summary`**（default） | **上流 `res.summary` をそのまま流す**（`:240-245`）。= baseSummary ＋ `aggregates:` 1 行 ＋ `📊 ローリング分析` 3 行 ＋ 4 行フッタ（`含まれるもの` / `含まれないもの` / `ATR の定義` / `補完ツール`） | **≒ 12 行** |
| `detailed` | 再構築テキスト: ヘッダ ＋ `【Volatility Metrics】` 6 行 ＋ `【Rolling Trends】` 3 行 ＋ `【Assessment】` 1 行（`:88-118`）。**4 行フッタは消える** | **≒ 14 行** |
| `full` | `detailed` ＋ `【Series】` ブロック 5 行（件数 / First・Last ISO / Close range / Returns mean・std）（`:119-129`）。**系列そのものは出さない** | **≒ 20 行** |

**この表で分かること**:

1. ここでの `full` は「集計＋系列の統計値」であり、**全件列挙ではない**。`get_flow_metrics` の `full`
   （全バケット列挙）とも `get_candles` の `full`（全ローソク足）とも意味が違う。**同じ語の 3 つ目の意味**。
2. 階梯としてほぼ平坦（4 / 12 / 14 / 20 行）。`summary` → `full` で 1.7 倍にしかならない。
3. ここでも `detailed` / `full` / `beginner` は `summary` の上位集合ではない（4 行フッタが消える）。

---

### 1-6. 参考: 起票時の表に含まれていない 2 ツール

#### `get_tickers_jpy`（`src/handlers/getTickersJpyHandler.ts:64-154`）

| view | `content[0].text` | `structuredContent` | 規模 |
|---|---|---|---|
| **`ranked`**（default） | ソート条件 ＋ 上位 `limit` 件（既定 5、上限 50） | `{ data: { items: 全ペア, ranked } }` | ≒ 8 行 |
| `items` | `全Nペア取得` ＋ **先頭 5 件**＋ `... 他N ペア`（`:40-54`） | `{ data: { items: 全ペア } }`（`ranked` なし） | ≒ 8 行 |

**text の量はほぼ同じ**で、違うのは並び順と `structuredContent.data.ranked` の有無。
つまりここでの `view` は量でも形式でもなく、**射影（どの並びを見せるか）**を指している。4 つ目の意味。

#### `detect_macd_cross`（`tools/detect_macd_cross.ts:609, 665-690`）

| view | `content[0].text` | `structuredContent` | 規模 |
|---|---|---|---|
| **`summary`**（default） | スクリーニング結果のテキスト | `Result`（`data.results`） | 検出件数に比例 |
| `detailed` | `summary` ＋ 1 クロス 1 行の明細 | `data.resultsDetailed` / `data.screenedDetailed` を追加（`:388-391`） | `summary` ＋ 検出件数行 |

**`view` は複数銘柄スクリーニングモード（`pair` 省略時）でのみ効く。** `pair` 指定の単一ペア深掘りモードは
`singlePairMode()` に分岐し `view` を一切参照しない（`:659-668`）。`inputSchema` にも
`handler` の型にもその条件は書かれていない。

---

### 1-7. 挙動表のまとめ — `full` / `summary` / `items` が何を指しているか

| 語 | `get_candles` | `get_transactions` | `get_flow_metrics` | `detect_patterns` | `get_volatility_metrics` |
|---|---|---|---|---|---|
| `summary` | — | **全件列挙**（既定） | 集計のみ・系列なし（既定） | ヘッダと件数のみ | 集計＋ローリング（既定） |
| `detailed` | — | — | — | 上位 5 件（既定） | 集計＋ローリング（フッタ欠落） |
| `full` | **既定の通常表示**（全件） | — | **最重量**（全バケット） | 全件＋pivot | 集計＋系列の統計値 |
| `items` | **最重量**（全件 JSON） | 全件 JSON | — | — | — |

`summary` は 3 つの意味（全件列挙 / 集計のみ / 集計＋ローリング）、
`full` は 3 つの意味（既定表示 / 最重量 / 集計＋統計値）を持っている。

---

## 2. 構造的な問題（設計判断の根拠）

### 2-0. 前提: `content` が LLM への唯一のチャネル

`view` の設計を議論する前に、本リポジトリが既に採用している制約を明示しておく。
**`view` の階梯は「表示密度のつまみ」ではなく「LLM に届く情報量のつまみ」である。**

`.claude/rules/tools.md`（「content テキストにデータを含める（重要）」）:

> LLM は `structuredContent` を参照できない。`content[0].text` だけが LLM に見える。
> `ok(summary, data, meta)` をそのまま返すと `summary` 一行だけを `content` に入れるため、
> LLM はデータを一切受け取れずハルシネーションを起こす。

これはルール文書だけの話ではなく、実装側にも同じ判断が横断的に残っている。

| 箇所 | コメント |
|---|---|
| `tools/get_candles.ts:807-808` | テキスト summary に全ローソク足データを含める（MCP クライアントが `structuredContent.data` を読めない場合に対応） |
| `tools/get_transactions.ts:248` | テキスト summary に全取引データを含める（LLM が `structuredContent.data` を読めない対策） |
| `tools/get_volatility_metrics.ts:331` | テキスト summary にボラティリティ詳細を含める（同上） |
| `tools/get_orderbook.ts:448` | raw mode: 全レベルをテキストに含める（同上） |
| `tools/get_tickers_jpy.ts:24` | テキスト summary にティッカー全件を含める（同上） |
| `tools/detect_patterns.ts:295, 445` | LLM が `content` から読み取れるように詳細を含める |

**決定的な痕跡**: `get_volatility_metrics` には軽量な一行要約 `buildVolatilitySummaryText()`
（`src/handlers/getVolatilityMetricsHandler.ts:72-77`）が実装されているが、
**`view=summary` はそれを使わず上流の重い `res.summary` をそのまま流している**（`:237-245`）。
コメントに理由が残っている——「LLM が default view で rolling window 別 RV/ATR を読めるようにするため」。
`buildVolatilitySummaryText` は現在テストからしか参照されておらず、本番経路では実質デッドコード。
**一度作った軽量 rung が「LLM に情報が届かなくなる」という理由で差し戻された実例**である。

（リポジトリ履歴はスカッシュ済み（168 commits、初期化コミットに集約）で、この判断の commit 単位の
経緯は追えない。上記のルール文書・コード内コメント・差し戻しの痕跡が一次ソースになる。）

#### 設計への帰結（3 点）

1. **軽い view は「同じ情報を短く」ではなく「情報が減る」。** したがって
   **生データ系ツール（`get_candles` / `get_transactions`）の既定を軽いほうへ倒してはならない。**
   §3-5 の「既定を変えない」は消極的な互換性配慮ではなく、この制約からの積極的な帰結。
2. **`structuredContent` を削ってもトークンは減らない。** §1-3 の
   `get_flow_metrics(view=summary)` による `series.buckets` 削除は、LLM 側のトークンを 1 つも減らさず
   （LLM は元から見ていない）、**非 LLM クライアントの契約だけを壊している**（P4）。
   削減の目的と手段が噛み合っていない。
3. **`format=json` はトークン削減オプションではない。** 同じデータを pretty JSON にすると
   散文の圧縮形式より必ず増える（§1-1 の実測比 7.4 倍）。`format` は
   「機械可読性のために**トークンを払う**オプション」として description に書く。

### 2-1. 問題一覧

| # | 問題 | 根拠 |
|---|---|---|
| **P1** | **`full` が「既定」と「最重量」の両方を指す** | §1-1（既定・270 行）と §1-3（最重量・1,443 行）。LLM が `view=full` のトークン量を見積れない |
| **P2** | **`items` は量ではなく形式の指定で、しかも最重量** | §1-1（`full` の 7.4 倍）、§1-2（`summary` の 7.2 倍）。量の語彙に混ざっているため「明細だけ = 軽い」と誤読される |
| **P3** | **重い view が軽い view の上位集合になっていない** | §1-3（`buckets`/`full` でフッタ・スパイク詳細・最終値が消失）、§1-5（`detailed`/`full`/`beginner` でフッタ消失）。「view を上げれば情報は減らない」が成り立たない |
| **P4** | **`view` が `structuredContent` の契約を変える。1 件は宣言スキーマ違反** | §1-3-3（`get_flow_metrics` `summary` の `series.buckets` 削除）、§1-1（`get_candles` `items` の封筒消失）、§1-4（`detailed`/`debug` の独自 shape）。外部クライアントの契約に直結 |
| **P5** | **同名の値が同じ契約を意味していない** | §1-2-2（`items` の `structuredContent` 封筒が `get_candles` と `get_transactions` で違う） |
| **P6** | **既にリポジトリ内で誤った値が使われている** | `src/prompts/intermediate.ts:90` が `get_flow_metrics(..., view=detailed)` を指示。`detailed` は同ツールの enum（`summary`/`compact`/`buckets`/`full`）に**存在しない**。Zod enum は未知の値を validation error にするため、この指示どおりに呼ぶとツール呼び出しが失敗する（本 PR はドキュメントのみのため未修正。§6 の follow-up） |
| **P7** | **default が揃っていない** | `full` / `summary` / `detailed` / `ranked` の 4 種。ただし §3-5 のとおり、これは「同じ挙動に違う名前」の帰結であって、default 自体が不揃いなわけではない |

---

## 3. 統一語彙の設計案

### 3-1. 原則: `view` は「量」だけを表す 1 軸にする

現状の `view` は 4 つの異なる軸を 1 つの enum に詰め込んでいる。

| 軸 | 現在の値 | 例 |
|---|---|---|
| 量（verbosity） | `summary` / `detailed` / `full` / `buckets` | 何件出すか |
| 形式（format） | `items` | 散文か JSON か |
| 絞り込み（filter） | `compact` | どのバケットを出すか |
| 置換（mode） | `debug` / `beginner` / `ranked` | そもそも何を出すか |

**提案: `view` を「量」の 1 軸に限定し、他の軸は別パラメータへ切り出す。**

### 3-2. 統一語彙（量の階梯）

| 語 | 意味 | 規約 |
|---|---|---|
| `summary` | 集計値・結論のみ。明細・系列は `content` に出さない | 最軽量 |
| `detailed` | 代表的な明細（上位 N 件 / 直近 N 件） | 中段 |
| `full` | **そのツールの主対象を全件出す。常にそのツールの最重量** | 上限 |

ここでいう**主対象**は「そのツールの結論を構成するレコード列」を指す
（candles = ローソク足、transactions = 約定、flow_metrics = バケット、patterns = 検出パターン）。
**主対象がレコード列でないツールでは `full` は全件列挙にならない。**
該当するのは `get_volatility_metrics` で、同ツールの結論は `aggregates` と `rolling`（スカラー値）であり、
`data.series.{ts,close,ret}` は指標計算の入力（＝ `get_candles` の再掲）であって出力の主対象ではない。
したがって `full` は系列の**統計値**（件数 / 期間 / Close レンジ / リターンの平均・標準偏差）までを出し、
系列そのものは列挙しない（§1-5）。**これは規約違反ではなく定義どおりの帰結**で、
「`full` は常にそのツールの最重量」は満たしている。系列そのものが必要な場合は `get_candles` を使う。
（`full` で系列を列挙する案も採れるが、limit 上限 500 本 × 3 系列で `get_candles` の重複になるため
採らない。異論があれば §6-7 で扱う）

**階梯の規約（実装 PR で機械的に守らせる対象）**

1. **順序は不変**: `summary` ≤ `detailed` ≤ `full`。`full` は例外なく「そのツールの最重量」。
   「最重量」であることは全ツール共通、「全件列挙」であることは主対象がレコード列のツールに限る（上記）。
2. **中間の rung は省略してよい**。全ツールが 3 段すべてを実装する必要はない（例: `get_candles` は
   `summary` / `full` の 2 段）。ただし順序を飛び越えた意味づけは禁止。
3. **上位集合であること**（P3 の解消）: `detailed` の `content` は `summary` の内容を含み、
   `full` は `detailed` を含む。フッタ・警告・最終値のような定型情報を上位ビューで落とさない。
   **この規約は階梯上の値（`summary` / `detailed` / `full`）にのみ適用する。**
   階梯外の値（`debug` / `beginner`）は定義上「出力の置換」なので上位集合である必要はない
   （`beginner` に専門用語のフッタを足すのは、その view の目的に反する）。
4. **`view` は `structuredContent` からフィールドを削ってはならない**（P4 の解消）。
   §2-0 のとおり削っても LLM のトークンは減らないため、**そもそも view に応じて削る動機が無い**。
   一方、**その view でしか計算しないデータを*足す*のは許容する**
   （`detect_patterns(debug)` の `data.candidates`、`detect_macd_cross(detailed)` の
   `data.resultsDetailed` 等）。削る＝既存消費者が壊れる / 足す＝壊れない、の非対称性による。
   それでも落とす必要が生じた場合は、**スキーマ側を optional にしたうえで
   `meta.omitted: ['series.buckets']` のように省略を申告する**。黙って必須フィールドを消さない
   （本リポジトリの既存方針——欠損を黙って消さない——と同じ扱い）。

   **「足す」の許容は view の階梯位置を問わない。** 上記の非対称性は階梯上か階梯外かに
   依存しないため。実際、許容している 3 件のうち 2 件（`detect_patterns(detailed)` の
   `usage_example`、`detect_macd_cross(detailed)` の `data.resultsDetailed` / `screenedDetailed`）は
   **階梯上**の `detailed` である（§3-4 / §3-5 のとおり両ツールの `detailed` は階梯上）。
   規約 3（上位集合）が階梯上の値にのみ適用されるのは `content` の話であり、
   `structuredContent` を対象とする本規約とはスコープが違う。混同しないこと。

   **フィールドは 3 分類で扱う**（「削る / 足す」の 2 分類では `meta.view` を分類できない）:

   | 分類 | 例 | 可否 | 規約テストでの扱い |
   |---|---|---|---|
   | **削る** | `get_flow_metrics(summary)` の `data.series.buckets` | **禁止** | deep-equal で検出する |
   | **足す** | `detect_patterns(debug)` の `data.candidates`、`detect_patterns(detailed)` の `usage_example`、`detect_macd_cross(detailed)` の `data.resultsDetailed` / `screenedDetailed` | **許容**（階梯位置を問わない。例の後ろ 2 件は階梯上の `detailed`） | 「既存キーが全て残っていること（下位集合でないこと）」＋「足しているキーが既知のものに限られること」を検証する |
   | **入力のエコー** | `detect_macd_cross` の `meta.view` | **許容**（値が view ごとに変わってよい） | 比較対象から**除外**し、除外した事実と理由をテスト内に明記する |

   **入力のエコー**とは、要求パラメータをそのまま `meta` に返すフィールドを指す。
   データを削っても書き換えてもおらず、消費者が失うものが無いため許容する
   （むしろ「どの view の応答か」を機械可読にする点で有用）。
   ただし**規約テストでは値が view ごとに変わるため、除外しないと deep-equal が成立しない**。
   除外を暗黙にすると「なぜこのフィールドだけ緩いのか」が次のセッションで再検討対象になるので、
   テスト側に理由を書き残すところまでを規約に含める。
   実例: `tests/view-structured-content-invariance.test.ts` の `detect_macd_cross` ケース
   （`stripView()` で `meta.view` を落としてから比較し、コメントで根拠を明記している）。

   なお**エコーを口実にデータを差し替えてはならない**。`meta.view` のように
   「入力値そのものを返すだけ」でなくなった時点で、そのフィールドは *削る* か *足す* のどちらかであり、
   表の上 2 分類の規約に従う。
5. **軽い rung は情報を減らす、という自覚を description に書く**: §2-0 のとおり `content` が
   LLM への唯一のチャネルなので、`view=summary` は「短い表示」ではなく
   「LLM が明細を受け取らない」を意味する。各ツールの description に
   「この view では〇〇が `content` に出ない」を明記し、選択の結果を呼び出し側が予測できるようにする。
6. **同じ語の意味はツールを跨いで一定**。`summary` が別ツールで「全件」を意味してはならない。

### 3-3. 量以外の軸（別パラメータへ切り出す）

| 新パラメータ | 型 / 既定 | 対象ツール | 吸収する現行値 |
|---|---|---|---|
| `format` | `'text' \| 'json'` / `'text'` | `get_candles` / `get_transactions` | `items` |
| `nonZeroOnly` | `boolean` / `false` | `get_flow_metrics` | `compact` |

`format=json` は「`content` を pretty JSON にする」だけで、量は `view` が決める。
これにより現状表現できない組み合わせ（`view=summary` かつ JSON など）も自然に表現できる。

#### `nonZeroOnly` の応答契約（`get_flow_metrics` のみ）

旧 `compact` は `content` と `structuredContent` の**両方**を変えていたため、写像先の契約を
曖昧にすると「不変」を主張できない。以下を確定仕様とする。

| 対象 | `nonZeroOnly=false`（既定） | `nonZeroOnly=true` |
|---|---|---|
| `content` のバケット行 | 全バケットを 1 行ずつ。欠損は `データなし（欠損区間）` の**個別行** | 非ゼロバケットのみ 1 行ずつ。**`hasData===false` の連続区間は 1 行の区間表記に畳む**（`⋯ 欠損 A〜B（Nバケット, データなし）`）。真のゼロ（`hasData===true` かつ buy=sell=0）は出さない |
| `structuredContent.data.series.buckets` | 全バケット | **全バケット（変わらない）** ← §3-2 規約 4 |
| `meta` | 変化なし | 変化なし。**`meta.omitted` は付けない**（`structuredContent` から何も省いていないため） |
| `view=summary` との併用 | — | **no-op**（`content` にバケット行が無い）。エラーにはしない |
| `view=detailed` との併用 | 直近 `bucketsN` 件を 1 行ずつ | 直近 `bucketsN` 件に上記フィルタを適用 |

**実装上の必須要件**: `view=full` + `nonZeroOnly=true` の**バケット行**——どのバケットを出すか /
欠損の連続区間の 1 行への畳み込み / 真のゼロ（`hasData=true` かつ buy=sell=0）の除外——は
旧 `compact` と**完全一致**させる。ヘッダ・フッタ・注記行は §3-2 規約 3（上位集合）に従い、
旧 `compact` に対して**増える方向の差分のみ許容**する（**減ってはならない**）。

> **なぜ「content 全体の完全一致」ではないか。** 本節の初版はそう書いていたが、
> **PR 2（#22）以降そのままでは成立しない。** PR 2 で `full` / `buckets` が `res.summary` ベースに
> なった結果、`full` にはバケット行の直前に 2 行のヘッダ
> （`PAIR Flow Metrics (bucketMs=…) 実取得範囲…` と `Totals: …`）が入る。`compact` は元から
> `res.summary` ベースでこのヘッダを持たないため、`full` + `nonZeroOnly=true` はこの 2 行ぶん増える。
> **ヘッダを削って完全一致させるのは誤り**——今度は §3-2 規約 3 に反する。

「全バケットをフィルタしてから `full` のレンダラに渡す」という素朴な実装では
**欠損の畳み込みが失われて N 行に展開され、一致しない**（旧 compact は区間 1 行）。
既存の `renderCompactBucketLines`（`tools/get_flow_metrics.ts:65-91`）を再利用すること。
真のゼロと欠損区間を含むフィクスチャでの一致テストを PR 3 の受け入れ基準にする。

**旧 `compact` からの差分は `structuredContent` のみ**: 旧 `compact` は `series.buckets` を
「非ゼロ ∪ 欠損」でフィルタしていた（`8a772c7` 時点の `tools/get_flow_metrics.ts:731-736`）。
規約 4 によりこのフィルタは**廃止済み**（PR 1 / #20。該当コードは現在存在しない）。
つまり**この差分は PR 1 の時点で既に発生している**。
したがって §4-4 の alias 写像で「不変」と言うときは、**PR 1 適用後の挙動に対して不変**を意味する。

### 3-4. ツール固有値の判断（吸収 / 残す）と理由

| 値 | 判断 | 理由 |
|---|---|---|
| `buckets`（flow） | **吸収 → `detailed`** | 「直近 N バケット」は階梯の中段そのもの。`bucketsN` が件数を制御する構造も `detailed` の定義（代表的な明細）と一致する。固有語を残す理由がない |
| `compact`（flow） | **吸収しない → `nonZeroOnly` へ切り出し** | 出力量が**入力データ依存**（非ゼロ率が高ければ `full` と同量）で、階梯に固定順位を付けられない。§3-2 規約 1（順序は不変）を満たせないため階梯に置けない。一方で「全件のうち非ゼロだけ」は `full` の部分集合なので、絞り込みの直交軸として素直に表現できる。切り出せば `detailed`+`nonZeroOnly` も表現可能になり、表現力は増える |
| `items`（candles / transactions） | **吸収しない → `format` へ切り出し** | 量ではなく形式（散文 → JSON）。しかも現状は最重量（§1-1）なので、量の語彙に置くと必ず誤読される。切り出せば `view` の階梯が実際の重さと一致する |
| `debug`（patterns） | **固有のまま残す（階梯外）** | 出力を**置換**する（検出パターンが本文から消え、swings / candidates に入れ替わる）。`full` の上位集合ではないので階梯に乗らない。また `debug: true` のようなブール値に切り出すと「`view=full` + `debug=true`」が「追加なのか置換なのか」曖昧になる。**置換は `view` の値、絞り込みは別パラメータ**という切り分けを原則にする |
| `beginner`（volatility） | **固有のまま残す（階梯外）** | 量ではなく**読者向けレジスタ**の指定（専門用語を出さない言い換え）。量としては最小だが、これを `summary` や新設の軽量語に吸収すると「軽い = 平易」という誤った含意が全ツールに伝播する。他ツールへ展開する予定もない |
| `ranked` / `items`（tickers_jpy） | **統一対象外（別途検討）** | 量でも形式でもなく**射影**（並び順と `data.ranked` の有無）。text 量は両者ほぼ同じ（§1-6）。`view` という名前が誤りで、`sortBy` / `limit` が既にあることを踏まえると `includeRanked: boolean` 等への改名が筋。ただし本設計の対象（量の語彙）とは別問題なので、実装 PR のスコープからは外す |
| `summary` / `detailed`（macd_cross） | **そのまま適合** | 既に階梯どおり（`detailed` が `summary` の上位集合）。変更不要。ただし「`pair` 指定時は `view` が無視される」旨を description に明記する（§1-6） |

### 3-5. 各ツールの移行後の値と default

**最重要の判断: 語彙の統一で既定の挙動を 1 つも変えない。**

「`get_candles` だけ default が `full`」という観測は、正確には
**「同じ『全件列挙』という挙動に、`get_candles` は `full`、`get_transactions` は `summary` という
別の名前を付けている」**（§1-2-1）。つまり外れ値なのは default ではなく**名前**。
名前を階梯に合わせれば、両ツールの default は同じ `full` に揃う。

| ツール | 現在の値 / default | 移行後の値 | 移行後 default | 既定挙動の変化 |
|---|---|---|---|---|
| `get_candles` | `full`(既定) / `items` | `full`（+ `summary` は Phase 3） / `format` | **`full`** | **なし** |
| `get_transactions` | `summary`(既定) / `items` | `full`（+ `summary` は Phase 3） / `format` | **`full`** | **なし**（名前のみ変更） |
| `get_flow_metrics` | `summary`(既定) / `compact` / `buckets` / `full` | `summary` / `detailed` / `full` + `nonZeroOnly` | **`summary`** | **なし** |
| `detect_patterns` | `summary` / `detailed`(既定) / `full` / `debug` | `summary` / `detailed` / `full` / `debug`（階梯外） | **`detailed`** | **なし**（変更なし） |
| `get_volatility_metrics` | `summary`(既定) / `detailed` / `full` / `beginner` | `summary` / `detailed` / `full` / `beginner`（階梯外） | **`summary`** | **なし**（P3 のフッタ欠落だけ修正） |
| `detect_macd_cross` | `summary`(既定) / `detailed` | 変更なし | `summary` | **なし** |
| `get_tickers_jpy` | `ranked`(既定) / `items` | 対象外（§3-4） | `ranked` | **なし** |

**生データ系ツールの default は、語彙統一の後も軽いほうへ倒さない。**
`get_candles` / `get_transactions` が既定で全件を `content` に載せているのは、
§2-0 の制約——`content[0].text` が LLM への唯一のチャネル——からの意図的な帰結であり、
「重すぎる既定」ではなく「LLM がデータを受け取れる唯一の既定」である。既定を `summary` に
落とすと、応答が短くなるのではなく**LLM が OHLCV / 約定明細を一切受け取らなくなる**
（`get_volatility_metrics` で一度差し戻された失敗と同じ道をたどる、§2-0）。

したがって Phase 3 で新設する `summary` は **opt-in 専用**とし、既定にはしない。
用途は「明細が要らないと呼び出し側が分かっている場合」に限られる——例えば
価格レンジ・出来高統計だけが欲しい場合や、別ツールへ渡す前の存在確認。

**例外は `get_flow_metrics` の既定 `summary`。** ここだけは既定で系列（バケット）を
`content` に載せないが、これは妥当である。同ツールの結論は `aggregates`（CVD / アグレッサー比 /
スパイク上位 3 件）に集約されており、バケット列はそこから導かれた中間データだからである。
「明細が結論を持つツール（candles / transactions）」と「集計が結論を持つツール（flow_metrics）」で
既定が分かれるのは不整合ではなく、**どちらも『既定で LLM に結論が届く』という同じ基準の帰結**。
統一語彙の description にはこの基準を書き、既定値だけを見比べて不揃いと誤読されないようにする。

### 3-6. 移行後の全体像

```text
view（量の 1 軸・全ツール共通）
  summary  <  detailed  <  full          ← full は常に最重量
    ├ 上位ビューは下位ビューの上位集合
    └ structuredContent は view に依存しない

format（形式）        : text | json                   … get_candles / get_transactions
nonZeroOnly（絞り込み）: boolean                       … get_flow_metrics
階梯外の view 値（置換）: debug (patterns) / beginner (volatility)
```

---

## 4. 移行方針

### 4-1. 結論: **alias 猶予期間を置く**（一括切り替えはしない）

理由:

- `bitbank-lab-mcp` は **npm 公開パッケージ**であり、外部の MCP クライアントが存在しうる。
  `view` の enum 値は `inputSchema` として公開されている契約。
- Zod enum は未知の値を**黙ってフォールバックせず validation error にする**。一括削除すると
  旧値を送るクライアントは即座にツール呼び出しが失敗する（サイレント破壊ではないが、無警告の停止）。
- 一方で alias 期間は「enum に旧値が残る = LLM が旧値を選びうる」コストを伴う。これは
  description で非推奨を明記し、新値を enum の先頭に置くことで緩和する。

### 4-2. 語の意味を変える移行は alias ではなく「削除 → 再導入」で行う

移行の中で唯一危険なのが **`get_transactions` の `summary`**。現在は「全件列挙」、
統一語彙では「集計のみ」。**同じ語の意味を差し替える**変更は alias では救えない
（旧値を送り続けたクライアントに、黙って別の応答が返る = サイレント破壊）。

原則として:

- **alias が使えるのは「語の追加」と「改名」のみ**（旧値 → 新値へ写像でき、挙動が変わらない場合）。
- **語の意味を変える場合は、一度 enum から削除して validation error を経由させ、
  別リリースで新しい意味として再導入する。** エラーになれば呼び出し側が気づける。

これに従い、`get_transactions` の `summary` は Phase 1 で `full` への alias（挙動不変）、
Phase 2 で削除、Phase 3 以降で「集計のみ」として再導入する。

### 4-3. フェーズ計画

**Phase は「リリース単位」であって PR 単位ではない。** Phase 1（次のマイナー）には
**PR 1 / PR 2 / PR 3 が全て入る**（§5-0）。したがって「Phase 1 で P3 と P4 を修正」は
PR 2 が P3 を、PR 1 が P4 を担当するという意味で、PR 3 の担当（P1 / P2 / P5 / P7）とは矛盾しない。
§5-5 の見出し「PR 3 — 語彙統一 Phase 1」は **Phase 1 のうち語彙変更を担う PR** の意であり、
「PR 3 ＝ Phase 1 の全体」ではない。PR と指摘の対応は §7 の表を唯一のソースとすること。

| Phase | リリース目安 | 内容 | 破壊性 |
|---|---|---|---|
| **1** | 次のマイナー（例 `0.2.0`） | 統一語彙を導入。旧値は **deprecated alias** として受理し、ハンドラ入口で新値に正規化。`format` / `nonZeroOnly` を追加。P3（上位集合）と P4（`structuredContent` 非依存）を修正。description を統一文言に | **互換性に影響あり**（`content` は既定・旧値経由とも不変。ただし `structuredContent` は変わる → §4-5） |
| **2** | 次の次のマイナー（例 `0.3.0`、Phase 1 から最低 1 リリース かつ 3 ヶ月以上あける） | 旧 alias を enum から削除 | **破壊的**（旧値は validation error） |
| **3** | 需要ベース（別議論） | `get_candles` / `get_transactions` に軽量 `summary` を **opt-in 専用**で新設（既定は `full` のまま。§3-5） | **非破壊**（enum 値の追加のみ） |

`0.x` 系なので SemVer 上はマイナーで破壊的変更を出せるが、**Phase 1 と Phase 2 を同一リリースに
畳まない**ことを条件とする（alias 期間があること自体が移行方針の実体であるため）。

### 4-4. Phase 1 の alias 写像表

**`content` と `structuredContent` を分けて記載する。**「不変」を一語で片付けると、
旧 `compact` / 旧 `items` のように `structuredContent` も変えていた値で嘘になる。

| ツール | 旧値 | 新しい指定 | `content` | `structuredContent` |
|---|---|---|---|---|
| `get_candles` | `items` | `view=full` + `format=json` | 不変 | **変わる**: `{ items, meta }` → `Result` 封筒（`ok`/`summary`/`data`/`meta`）。Phase 1 唯一の shape 破壊 |
| `get_transactions` | `summary`（既定） | `view=full` | 不変 | 不変 |
| `get_transactions` | `items` | `view=full` + `format=json` | 不変 | 不変（元から `Result` 封筒） |
| `get_flow_metrics` | `compact` | `view=full` + `nonZeroOnly=true` | **バケット行は不変。ヘッダ 2 行が増える**（`PAIR Flow Metrics (bucketMs=…)` / `Totals:`。PR 2 で `full` に入ったもの）。§3-3 の必須要件を満たす実装であること | **PR 1 で変更済み**: 「非ゼロ ∪ 欠損」フィルタを廃止し全バケット。Phase 1 での追加変更なし |
| `get_flow_metrics` | `buckets` | `view=detailed` | 不変 | 不変 |
| `detect_patterns` | — | 変更なし | 不変 | 不変 |
| `get_volatility_metrics` | — | 変更なし | PR 2 でフッタが**増える** | 不変 |

### 4-5. 破壊的変更の影響範囲

影響はフェーズと消費対象（`content` / `structuredContent`）で分かれる。
**「Phase 1 は非破壊、Phase 2 が破壊的」という単純な二分ではない。**

**Phase 1 で影響が出るもの（`structuredContent` の消費者のみ）**

- `get_flow_metrics(view=summary)` に `series.buckets` が**戻る**（従来はキーごと欠落。PR 1）。
  `view=compact` の `series.buckets` が全バケットになる（従来は「非ゼロ ∪ 欠損」フィルタ済み。PR 1）。
- `get_candles` の旧 `view=items` → `view=full` + `format=json` で `structuredContent` が
  `{ items, meta }` から `Result` 封筒に変わる（PR 3）。**旧 shape に依存するクライアントは要修正。**
  `structuredContent.items` → `structuredContent.data.normalized` の読み替えが必要。
- `content` は既定・旧値経由とも**減らない**（§4-4）。増える方向の差分は 2 つある——
  `get_volatility_metrics` の `detailed` / `full` でフッタ 4 行が復活し（PR 2）、
  `get_flow_metrics` の旧 `compact`（→ `full` + `nonZeroOnly=true`）でヘッダ 2 行が増える（PR 2）。
  既定の `view` で `content` が変わるツールは無い。

**Phase 2 で影響が出るもの**

- MCP クライアントが `view` に旧値（`items` / `compact` / `buckets` / `get_transactions` の
  `summary`）を渡している場合、validation error。サイレントに新値へ倒れることはない。

**リポジトリ内（実装 PR で同時に直す）**

| 箇所 | 内容 |
|---|---|
| `src/schema/market-data.ts` / `analysis.ts` / `patterns.ts` | enum 定義・description |
| `tools/get_candles.ts` / `get_transactions.ts` / `get_flow_metrics.ts` | ハンドラの分岐 |
| `src/handlers/detectPatternsHandler.ts` / `getVolatilityMetricsHandler.ts` | P3 のフッタ欠落修正 |
| `src/prompts/intermediate.ts:90-91` | ~~**`get_flow_metrics(view=detailed)` は現在無効値**（P6）~~ → **PR 0 / #19 で `view=compact` に修正済み**（§7）。PR 3 では新語彙の `view=full` + `nonZeroOnly=true`（＝旧 `compact` の写像先。§4-4）へ追従させる |
| `src/prompts/reports.ts:16` | `get_candles(view="items")` → `view=full, format=json` |
| `tests/` | `view: '…'` の実引数が **14 ファイル・83 箇所**（`summary` 16 / `detailed` 16 / `items` 15 / `ranked` 12 / `full` 8 / `debug` 6 / `beginner` 5 / `buckets` 3 / `compact` 2）。加えてテスト名・コメント中の `view=…` 表記が 52 箇所 |
| `docs/tools.md` | `view` パラメータの記載は**現状ゼロ**（`view` の一致は全て `preview`）。統一後に「view の共通語彙」節を追加する |

### 4-6. `CHANGELOG.md` 記載案

`## [Unreleased]` の **`### Schema (breaking)`** に以下を追加する（Phase 1 時点）。

> - **`view` の語彙をツール間で統一した。** `view` は**出力量の 1 軸**のみを表し、
>   `summary` < `detailed` < `full` の順序で、**`full` は常にそのツールの最重量**を意味する。
>   従来は同じ語が別の重さを指していた（`get_candles` の `full` は既定の通常表示、
>   `get_flow_metrics` の `full` は全バケット列挙で約 1,440 行、`get_transactions` の `summary` は
>   全件列挙）。LLM が `view` からトークン量を見積れず、`src/prompts/intermediate.ts` は
>   `get_flow_metrics` に存在しない `view=detailed` を指示していた。
> - **旧値は deprecated alias として受理する**（`get_candles.items` / `get_transactions.summary` /
>   `get_transactions.items` / `get_flow_metrics.compact` / `get_flow_metrics.buckets`）。
>   次々回マイナーで削除予定。写像は上表のとおりで、**旧値経由の既定挙動は変わらない**。
> - **量以外の軸を別パラメータへ切り出した**: `format`（`text` / `json`、`get_candles` /
>   `get_transactions`）、`nonZeroOnly`（boolean、`get_flow_metrics`）。
>   `debug`（`detect_patterns`）と `beginner`（`get_volatility_metrics`）は出力を置換する
>   **階梯外の値**として `view` に残す。
> - **`view` は `content` のみを変え、`structuredContent` を変えないことを契約にした。**
>   従来 `get_flow_metrics(view=summary)` は `data.series.buckets` をキーごと削除しており、
>   必須フィールドを宣言する `GetFlowMetricsDataSchemaOut` を満たさない `structuredContent` を
>   返していた（実行時 parse をしていないため露見していなかった）。**修正により
>   `view=summary` でも `series.buckets` が入る。** トークン削減目的で省略する場合は
>   スキーマを optional 化し `meta.omitted` で申告する。
> - **`get_candles(view=items)` の `structuredContent` shape が変わる。** 旧 `items` は
>   `{ items, meta }` を返し `ok` / `summary` / `data.{raw,keyPoints,volumeStats}` を落としていたが、
>   `view=full` + `format=json` では他ツールと同じ `Result` 封筒を返す。
>   （`get_transactions(view=items)` は元から封筒を保持しており、こちらは不変）
> - **`get_transactions` の default が `summary` → `full` に変わる（挙動は不変）。**
>   従来の `summary` は「返却した全約定を 1 行 1 件で列挙」であり、実体は `full`。
>   `summary`（集計のみ）は将来別リリースで **opt-in 専用**として新設予定（既定にはしない）。
>   **同じ語の意味を差し替えないため、`summary` は alias 期間の削除後にのみ再導入する。**
> - **生データ系ツールの既定は今後も全件列挙のまま。** `content[0].text` が LLM への唯一の
>   チャネルであり（`.claude/rules/tools.md`）、既定を軽くすることは「短くする」ではなく
>   「LLM が明細を受け取らなくなる」を意味するため。
> - 既定の応答内容が変わるツールは無い（`get_volatility_metrics` の `detailed` / `full` /
>   `beginner` で欠落していた 4 行フッタが復活する点を除く）。

---

## 5. 実装計画（PR 分割）

**前提: 各 PR は別セッションで実施する。** セッション間で文脈は引き継がれないため、
各 PR は「本ドキュメントの指定セクションを読めば単独で着手できる」粒度に切る。
以下の各ブリーフはそのまま実装セッションへの指示として使える。

### 5-0. 全体像

```text
PR 0  prompts の無効値修正         ── 独立・即時マージ可（設計合意を待たない）   ✅ 完了 #19
PR 1  structuredContent の切り離し ─┐                                          ✅ 完了 #20
PR 2  上位集合の保証               ─┴ 同一ファイルを触るため PR 1 → PR 2 の順   ✅ 完了 #22
        ↓
   【決定ゲート】§6 の 1 / 3 / 4 をレビューで確定（実装セッションでは決められない）
                 ※ §6-6 は PR 1 で決定済み（§5-4）                             ✅ 確定（§7-2）
        ↓
PR 3  語彙統一 Phase 1（破壊的変更はここに全部集約）                            ✅ 完了
        ↓
PR 4  呼び出し側の追従 + ドキュメント                                            ✅ 完了
        ↓（1 リリース以上 かつ 3 ヶ月以上あける）
PR 5  Phase 2（alias 削除）                                                    ← 次はここ
PR 6  Phase 3（軽量 summary の opt-in 追加、需要ベース・任意）
```

**分割の原則**

1. **バグ修正（PR 0〜2）を語彙変更（PR 3）より先に出す。** 内部バグの修正と外部契約の変更を
   同じレビューに混ぜない。前者は挙動の是正、後者は互換性の判断で、レビューの観点が違う。
2. **破壊的変更を PR 3 に 1 回だけ集約する。** 特に `get_candles(view=items)` の
   `structuredContent` 封筒（§1-1）は PR 1 では**直さない**。`items` は PR 3 で
   `view=full` + `format=json` に置き換わるので、そこで一緒に変えれば
   外部クライアントが受ける破壊は 1 回で済む。PR 1 で直すと 2 回になる。
3. **PR 1 / 2 は同一ファイル（`tools/get_flow_metrics.ts`、`getVolatilityMetricsHandler.ts`）を
   触るため並行しない。** PR 0 だけは独立で、いつ出してもよい。

### 5-1. PR 0 — `src/prompts/intermediate.ts` の無効値修正

| 項目 | 内容 |
|---|---|
| **目的** | P6 の解消。現在エラーになる指示を直す |
| **読むもの** | 本ドキュメント §1-3、§2-1 の P6 |
| **触るファイル** | `src/prompts/intermediate.ts:90` |
| **内容** | `get_flow_metrics(..., view=detailed)` は同ツールの enum（`summary`/`compact`/`buckets`/`full`）に存在せず、そのまま呼ぶと validation error。**現行の**有効値へ差し替える |
| **判断が要る点** | 差し替え先。プロンプトの用途は「CVD 推移・スパイク・直近 1-3 時間重視」で `limit=300` / `bucketMs=60000`（＝最大約 300 バケット）。**`compact`（非ゼロバケットのみ、欠損は区間表記で保持）を推奨**。`full` は 300 行で用途に対して重く、`buckets`（既定 10 件）は「CVD 推移」を見るには短い |
| **受け入れ基準** | 差し替え後の値が `GetFlowMetricsInputSchema` の enum に含まれる。プロンプト経由の呼び出しが validation error にならないことをテストで固定する |
| **やらないこと** | 語彙の変更。他プロンプトの整理。PR 3 の後に PR 4 で新語彙へ再度追従させる |
| **依存** | なし。単独マージ可 |

### 5-2. PR 1 — `structuredContent` を `view` から切り離す

| 項目 | 内容 |
|---|---|
| **目的** | P4 の解消と再発防止 |
| **読むもの** | §1-3、§2-0、§3-2 の規約 4 |
| **触るファイル** | `tools/get_flow_metrics.ts:711-741`、`src/schema/market-data.ts`（必要なら） |
| **内容** | ① `view=summary` の `series.buckets` 削除をやめる（`:715-720`）② `view=compact` の `structuredContent` 側フィルタをやめる（`:731-736`）。`content` の絞り込みは維持する ③ ハンドラの出口で `GetFlowMetricsOutputSchema.parse()` を通し、以後のスキーマ drift を CI で検出できるようにする |
| **受け入れ基準** | 同一入力に対し `view` を変えても `structuredContent` が deep-equal（`get_flow_metrics` / `get_candles` / `get_transactions` / `get_volatility_metrics` を総当りする共通テストを追加）。ただし §3-2 規約 4 のとおり**階梯外 view がフィールドを足すのは許容**なので、`detect_patterns(debug)` の `data.candidates` と `detect_macd_cross(detailed)` の `data.resultsDetailed` は例外として明示する |
| **やらないこと** | `get_candles(view=items)` の封筒（`{ items, meta }`）の修正 → **PR 3 へ**（分割の原則 2）。`detect_patterns(detailed)` の `usage_example` は「足す」側なので現状維持 |
| **CHANGELOG** | `### Fixed`。`get_flow_metrics(view=summary)` の `structuredContent` に `series.buckets` が**戻る**こと、`view=compact` の `structuredContent` が全バケットになることを明記（`## [Unreleased]` の既存記述と矛盾しないよう更新する） |
| **依存** | なし |

### 5-3. PR 2 — 上位集合の保証（`content` 側）

| 項目 | 内容 |
|---|---|
| **目的** | P3 の解消 |
| **読むもの** | §1-3、§1-5、§2-0、§3-2 の規約 3 |
| **触るファイル** | `tools/get_flow_metrics.ts:745-768`、`src/handlers/getVolatilityMetricsHandler.ts:88-131, 247-262`（行番号は PR #20 マージ後の `main` = `26e7a0a` 時点） |
| **内容** | ① `get_flow_metrics` の `buckets` / `full` が `res.summary` を捨てて再構築している箇所を、`res.summary` をベースにする形に変える（最終約定価格・スパイク上位 3 件・4 行フッタが復活する）② `get_volatility_metrics` の `detailed` / `full` で 4 行フッタを維持する |
| **受け入れ基準** | 「階梯上の各 view の `content` が、下位 view の定型要素（フッタ / 警告行 / 最終値）を含む」テストを追加 |
| **やらないこと** | `beginner`（volatility）と `debug`（patterns）は**階梯外なので対象にしない**（§3-2 規約 3）。平易な言い換えである `beginner` に専門的なフッタを足すのはその view の目的に反する |
| **小項目** | `buildVolatilitySummaryText()`（`getVolatilityMetricsHandler.ts:72-77`）は本番未使用（§2-0）。**削除せず「本番未使用。PR 6 の軽量 summary の土台」というコメントを付ける**。PR 6 をやらないと決まった時点で削除する |
| **CHANGELOG** | `### Fixed`。既定の `content` が変わるツールは無いこと（増える方向のみ）を明記 |
| **依存** | PR 1（同一ファイル） |

### 5-4. 決定ゲート（レビューで確定させる）— **全て確定済み**

PR 3 の着手前に §6 の以下を確定させる。**実装セッションでは決められない**（外部契約の判断のため）。
**PR 3 着手前のレビューで 1 / 3 / 4 が確定した**（結論は §6 の各項に追記済み）。

| # | 決めること | 未確定だと困ること | 結論 |
|---|---|---|---|
| §6-1 | `format` を新パラメータにするか、`view` の値（例 `full_json`）のままにするか | PR 3 の入力スキーマ全体が変わる | **新パラメータにする** |
| §6-3 | `get_tickers_jpy` の `view` を対象に含めるか | PR 3 の対象ツール数が変わる | **対象外**（改名は別 issue） |
| §6-4 | alias の猶予期間（本提案は「最低 1 リリース かつ 3 ヶ月」） | PR 5 の実施時期が決まらない | **最低 1 リリース かつ 3 ヶ月。`0.2.0` 導入 → `0.4.0` 削除** |
| ~~§6-6~~ | ~~階梯規約をテストで機械的に固定するか~~ | **決定済み → 下記** | **固定する** |

§6-2（軽量 `summary` を新設するか）は PR 6 の要否であり、PR 3 は待たない。

**§6-6 は決定済み。PR 3 前に残る決定ゲートは §6-1 / §6-3 / §6-4 の 3 つ。**
§6-6（階梯規約をテストで機械的に固定するか）は本表に「PR 3 前」として置いていたが、
**PR 1 の受け入れ基準そのものに含まれていた**ため、実際には PR 1 着手前に決まっている必要があった
（§5-2 の「`view` を変えても `structuredContent` が deep-equal な共通テストを追加」）。
PR 1 / #20 で「機械的に固定する」方針が `tests/view-structured-content-invariance.test.ts` として
実装済みなので、以後は決定済みとして扱う。PR 3 の階梯包含テスト（§6-6 の要素包含方式）も
この方針に従って書くこと——**再検討の対象ではない**。

この取りこぼし自体の教訓: **決定ゲートは「最初にその決定に依存する PR」の前に置く。**
§6-6 は「PR 1〜3 のテスト設計が変わる」と自ら書いていたのに、ゲートを PR 3 の前に置いていた。

### 5-5. PR 3 — 語彙統一 Phase 1

| 項目 | 内容 |
|---|---|
| **目的** | P1 / P2 / P5 / P7 の解消。**破壊的変更はこの PR に集約する** |
| **読むもの** | 本ドキュメント全体（特に §3 と §4）＋ 決定ゲートの結論 |
| **触るファイル** | `src/schema/market-data.ts:250, 319, 498-505`、`src/schema/patterns.ts:65`、`src/schema/analysis.ts:24`、`tools/get_candles.ts:882-923`、`tools/get_transactions.ts:320-374`、`tools/get_flow_metrics.ts:677-769`、`tools/detect_macd_cross.ts:609`（description のみ）。加えて PR 1 で追加した `tests/view-structured-content-invariance.test.ts` の `get_candles` ケース（下記⑤で逸脱が解消するため、他ツールと同じ deep-equal 検証に置き換える）。**行番号は PR #20 マージ後の `main` = `26e7a0a` 時点** |
| **内容** | ① enum を統一語彙に変更（§3-5 の表）② 旧値を deprecated alias として受理し、ハンドラ入口で正規化（§4-4 の写像表）③ `format` / `nonZeroOnly` を追加（§3-3）④ `get_transactions` の default を `full` に（挙動不変）⑤ `get_candles(view=full, format=json)` の `structuredContent` を `Result` 封筒に統一（**唯一の shape 破壊。PR 1 から持ち越した分**）⑥ description を統一文言に。「この view では〇〇が `content` に出ない」「`full` は常に最重量」「`detect_macd_cross` の `view` は `pair` 省略時のみ有効」を明記 |
| **受け入れ基準** | ① §4-4 の写像表どおり、旧値と新値で `content` / `structuredContent` が一致するテスト（`compact` → `full`+`nonZeroOnly` は**真のゼロと欠損区間を含むフィクスチャ**で**バケット行**の一致を検証し、差分がヘッダ 2 行ちょうどで**旧 `compact` の要素が消えていない**ことも見る。§3-3 の必須要件）② 階梯の包含テスト（§6-6 の方式。**文字列長の比較では検証しない**）③ 既定の応答が変わらないこと（既存テストを無改変で通すことを挙動不変の証明とする。`tests/get_candles.test.ts` / `get_transactions.test.ts` / `get_flow_metrics*.test.ts`） |
| **やらないこと** | 既定を軽いほうへ倒す（§3-5）。alias の削除（PR 5）。軽量 `summary` の新設（PR 6） |
| **CHANGELOG** | `### Schema (breaking)`。文面案は §4-6 |
| **依存** | PR 1、PR 2、決定ゲート |

### 5-6. PR 4 — 呼び出し側の追従とドキュメント

| 項目 | 内容 |
|---|---|
| **触るファイル** | `src/prompts/intermediate.ts:90-91, 128`、`src/prompts/reports.ts:16`、`docs/tools.md`、`.claude/rules/tools.md` |
| **内容** | ① PR 0 で直したプロンプトを新語彙へ ② `reports.ts` の `get_candles(view="items")` を `view=full, format=json` へ ③ `docs/tools.md` に「view の共通語彙」節を新設（現在 `view` の記載はゼロ）④ `.claude/rules/tools.md` に規約を追記——「`view` は量の 1 軸」「`full` は常に最重量」「`view` は `structuredContent` からフィールドを削らない」「階梯上の view は下位の上位集合」 |
| **受け入れ基準** | リポジトリ内に旧値の参照が残っていない（`view: 'items'` / `'compact'` / `'buckets'` の grep がテスト以外でゼロ） |
| **依存** | PR 3 |

### 5-7. PR 5 — Phase 2（alias 削除）

| 項目 | 内容 |
|---|---|
| **実施時期** | PR 3 のリリースから**最低 1 リリース かつ 3 ヶ月**後（§4-1）。同一リリースに畳まない |
| **内容** | 旧 alias を enum から削除。`get_transactions` の `summary` もここで消える（意味の差し替えを避けるため、再導入は PR 6 以降。§4-2） |
| **受け入れ基準** | 旧値を渡すと validation error になることをテストで固定（サイレントに新値へ倒れないこと） |
| **CHANGELOG** | `### Schema (breaking)` |
| **依存** | PR 3、PR 4 |

### 5-8. PR 6 — Phase 3（軽量 `summary` の opt-in 追加、任意）

| 項目 | 内容 |
|---|---|
| **前提** | §6-2 で「用意する」と決まった場合のみ。需要ベース |
| **内容** | `get_candles` / `get_transactions` に集計のみの `summary` を追加。**既定にはしない**（§2-0 / §3-5） |
| **受け入れ基準** | 既定（`full`）の応答が 1 バイトも変わらないこと |
| **依存** | PR 5（`get_transactions` の `summary` は alias 削除後にのみ再導入可能） |

### 5-9. 実施順のまとめ

| # | PR | 破壊性 | 決定ゲート後か | 並行可否 |
|---|---|---|---|---|
| 0 | prompts 無効値修正 | なし | 不要 | いつでも単独 |
| 1 | structuredContent 切り離し | なし（フィールドが戻る） | 不要 | PR 0 と並行可 |
| 2 | 上位集合の保証 | なし（`content` が増える） | 不要 | PR 1 の後 |
| 3 | 語彙統一 Phase 1 | **あり**（enum / `get_candles` の shape） | **必要** | PR 2 の後 |
| 4 | 呼び出し側追従 + docs | なし | — | PR 3 の後 |
| 5 | Phase 2（alias 削除） | **あり** | — | PR 4 の 1 リリース + 3 ヶ月後 |
| 6 | Phase 3（軽量 summary） | なし（追加のみ） | §6-2 次第 | PR 5 の後 |

---

## 6. レビューで決めたいこと / follow-up

**1 / 3 / 4 は PR 3 着手前のレビューで確定済み**（下記の各項に結論を追記した）。
2 は PR 6 の要否であり PR 3 は待たない。**5 と 6 は対応済み**（それぞれ PR 0 / #19、PR 1 / #20。§7）。

1. **`format` を新パラメータとして足すか、`view` の値のまま（例 `full_json`）にするか。**
   本提案は前者。後者はパラメータが増えない代わりに、量と形式の直積が enum 値の数だけ増える。
   → **決定: 新パラメータにする（PR 3 で実装済み）。** `view` を量の 1 軸に保つため。
   `full_json` 方式は量×形式の直積が enum に載り、`summary_json` が要る時点で破綻する。
2. **`get_candles` / `get_transactions` に軽量 `summary` を新設するか**（Phase 3）。
   §2-0 の制約により**既定にはしない**ことは確定なので、争点は「opt-in の rung を用意する価値が
   あるか」だけ。やらないなら両ツールは `full` のみになり、量の制御は `limit` に一本化される
   （`view` パラメータ自体を廃止して `format` だけ残す選択肢もある）。
3. **`get_tickers_jpy` の `view`（`items` / `ranked`）を本統一に含めるか。**
   本提案は対象外（射影の指定であり量ではないため）。含めるなら `includeRanked: boolean` への改名を推奨。
   → **決定: 対象外。** `ranked` / `items` は射影であり量でも形式でもない。
   `view` という名前自体が誤用なので、**改名は別 issue として切り出す**（PR 3 では変更しない）。
4. **alias の猶予期間**（本提案は「最低 1 リリース かつ 3 ヶ月」）。
   → **決定: 最低 1 リリース かつ 3 ヶ月。** `0.2.0` で導入し **`0.4.0` で削除**を目標とし、
   この目標バージョンを各 deprecated 値の description に明記する
   （実装は `DEPRECATED_VIEW_REMOVAL_TARGET`（`src/schema/base.ts`）を単一ソースにした）。
5. ~~**P6 の即時修正**~~ → **対応済み（PR 0 / #19）。決定不要だった項目。**
   `src/prompts/intermediate.ts:90` の `get_flow_metrics(view=detailed)` は validation error に
   なる無効値だったため、`view=compact` に差し替えた。あわせて再発防止テスト
   （`tests/prompts_contract.test.ts`）で、全プロンプト中の `view=…` が各ツールの enum で
   受理されるかを検証している。差し替え先の根拠は §5-1 を参照。
6. **階梯規約の機械的な担保** → **決定済み（「固定する」。PR 1 / #20 で実装、§5-4）。**
   以下は PR 3 の階梯包含テストにもそのまま適用する方式であり、再検討の対象ではない。
   「上位ビューは上位集合」「`structuredContent` は view 非依存」を
   テストで固定する。`.claude/hooks/post-ts-lint.sh` の banned-patterns と同じ発想で、
   規約を人手のレビューに委ねない。

   **文字列長の比較（`len(summary) ≤ len(detailed) ≤ len(full)`）は使わない。**
   長さは上位集合性を検証しない——`detailed` がフッタや警告行を落としても、明細が増えていれば
   長さの条件は通ってしまう（P3 はまさにその形の欠陥だった）。逆に文言を 1 語変えただけで
   落ちる脆いテストにもなる。代わりに**要素の包含**で検証する:

   - **定型要素の包含**: 各 view の `content` から安定した要素——フッタ行（`📌` 始まり）、
     警告行（`⚠️` / `ℹ️` 始まり）、ヘッダの主要フィールド（pair / 最終値 / 期間）——を
     抽出・正規化し、`extract(summary) ⊆ extract(detailed) ⊆ extract(full)` を検証する。
   - **レコード集合の包含**: バケット / パターン / ローソク足など列挙されるレコードは、
     行から識別キー（timestamp や pattern type + range）を抽出した集合で包含を検証する。
     行の文言ではなくキー集合で比較すれば、表示形式の変更で落ちない。
   - **`structuredContent` の同一性**: 何も足さない view 同士は deep-equal。
     **フィールドを足す view は、階梯上か階梯外かを問わず**「足す」扱いなので、
     **下位集合ではなく上位集合**（既存キーが全て残っていること）＋
     **足しているキーが既知のものに限られること**を検証する（§3-2 規約 4）。
     階梯上の値だからといって deep-equal を要求しない——`detect_patterns(detailed)` の
     `usage_example` と `detect_macd_cross(detailed)` の `data.resultsDetailed` /
     `screenedDetailed` が該当する。
     入力のエコー（`meta.view` 等）は比較対象から除外する——§3-2 規約 4 の 3 分類表を参照。

7. **`get_volatility_metrics` の `full` で系列そのものを `content` に出すか。**
   本提案は出さない（§3-2。主対象がレコード列ではなく、系列は `get_candles` の再掲のため）。
   出す場合は上限本数と形式（全件か間引きか）を決める必要がある。

---

## 7. 実施状況

**§1〜§2 で挙げた指摘のうち、どれが解消済みかはこの表を唯一のソースとする。**
§1〜§2 の本文は調査記録として `8a772c7` 時点のまま据え置くので、本文だけを読むと解消済みの
問題も未解消に見える。解消状況の二重管理を避けるため、§2-1 の問題一覧には解消列を持たせない。

| PR | ブリーフ | 状態 | PR 番号 | 解消した指摘 |
|---|---|---|---|---|
| PR 0 | §5-1 | **完了** | [#19](https://github.com/tjackiet/bitbank-lab-mcp/pull/19) | **P6**（`src/prompts/intermediate.ts` の無効な `view=detailed` → `view=compact`） |
| PR 1 | §5-2 | **完了** | [#20](https://github.com/tjackiet/bitbank-lab-mcp/pull/20) | **P4**（`view` が `structuredContent` の契約を変える）— ただし `get_candles(view=items)` の封筒逸脱は**未解消**。§5-0 分割の原則 2 により PR 3 へ持ち越し |
| PR 2 | §5-3 | **完了** | [#22](https://github.com/tjackiet/bitbank-lab-mcp/pull/22) | **P3**（重い view が軽い view の上位集合になっていない） |
| PR 3 | §5-5 | **完了** | — | **P1 / P2 / P5 / P7** ＋ **P4 の残り**（`get_candles(view=items)` の封筒） |
| PR 4 | §5-6 | **完了** | — | （呼び出し側追従とドキュメント。指摘の解消ではない） |
| PR 5 | §5-7 | 未着手 | — | （Phase 2: alias 削除） |
| PR 6 | §5-8 | 未着手 | — | （Phase 3: 軽量 `summary` の opt-in 追加。§6-2 次第で実施しない） |

### 7-1. PR 1（#20）で実際に入ったもの

ブリーフ（§5-2）との差分を残す。PR 2 / PR 3 のセッションが前提にできる**現状**は以下:

- `get_flow_metrics` のハンドラは全 `view` で同一の `structuredContent` を返す。
  `view=summary` の `series.buckets` 削除と `view=compact` の「非ゼロ ∪ 欠損」フィルタは廃止。
- **`content` は PR 1 の前後で、全 `view` について 1 バイトも変わっていない**
  （`compact` の絞り込み表示・欠損の区間表記も従来どおり）。
  これは「`view` を跨いで `content` が同一」という意味ではない——`content` の量を決めるのは
  引き続き `view` であり（`summary` はバケット行なし / `compact` は非ゼロのみ / `full` は全件）、
  **`view` に依存しなくなったのは `structuredContent` だけ**である。
- ハンドラ出口で `GetFlowMetricsOutputSchema.parse()` を通す。以後 `view` 分岐が
  `structuredContent` を加工すると CI で落ちる。
- `tests/view-structured-content-invariance.test.ts` を新設。
  `get_flow_metrics` / `get_transactions` / `get_volatility_metrics` は deep-equal、
  `detect_patterns` / `detect_macd_cross` は上位集合＋追加キーの限定で検証する。
  `get_candles(view=items)` の逸脱（`{ items, meta }`）は**現状の形を固定**してあるので、
  PR 3 で封筒を統一する際にこのケースの書き換えが必要になる。
- `GetFlowMetricsInputSchema.view` の description を「`content` のバケット行の量だけを制御する
  （`structuredContent` には `view` に関わらず全バケットが入る）」に変更。enum 値と default は不変。
- **ブリーフに無かった追加**: §3-2 規約 4 の 3 分類（削る / 足す / 入力のエコー）。
  `detect_macd_cross` の `meta.view` が「削られても足されてもいないが値が変わる」フィールドで、
  当時の 2 分類では扱いを決められなかったため。本ドキュメント側にも反映済み。

### 7-2. PR 2（#22）で実際に入ったもの

ブリーフ（§5-3）との差分を残す。PR 3 が前提にできる**現状**は以下:

- `get_flow_metrics` の `buckets` / `full` が `res.summary` ベースになった。最終約定価格・
  スパイク上位 3 件・4 行フッタが復活する。**バケット行の直前に置く 2 行ヘッダ
  （`PAIR Flow Metrics (bucketMs=…) 実取得範囲…` / `Totals: …`）は従来どおり残る**——
  つまり `full` は `compact` に対してこの 2 行ぶん多い。これが §3-3 の
  「旧 `compact` と完全一致」を成立しなくさせた変更で、PR 3 で要件文言を訂正した（下記 7-3）。
- `get_volatility_metrics` の `detailed` / `full` で 4 行フッタを維持する。文言は
  `VOLATILITY_METRICS_FOOTER` を単一ソースにした。
- `tests/view-content-superset.test.ts` を新設。**文字列長の比較は使わない**（§6-6）。
  定型要素（`fixedElements`）とレコードキー（`bucketRowKeys`）の集合包含で検証する。
- 階梯外（`beginner` / `debug`）は対象外という判断をテストで固定した。

### 7-3. PR 3 で実際に入ったもの

ブリーフ（§5-5）との差分を残す。PR 4 以降のセッションが前提にできる**現状**は以下:

- **enum**: `get_flow_metrics` = `summary` / `detailed` / `full` /
  `compact`(dep) / `buckets`(dep)、`get_transactions` = `full`(既定) / `summary`(dep) / `items`(dep)、
  `get_candles` = `full`(既定) / `items`(dep)。新語彙を先頭、deprecated を後ろに置いている。
- **新パラメータ**: `format`（`text` / `json`。`get_candles` / `get_transactions`）、
  `nonZeroOnly`（boolean。`get_flow_metrics`）。
- **alias 正規化はハンドラ入口の 1 箇所だけ**（`normalizeFlowMetricsView()` /
  各ハンドラの `effectiveFormat`）。以降の分岐は新語彙しか見ない。
  **旧値と新パラメータを同時に渡された場合は写像先が決める値を優先する**
  （`compact` + `nonZeroOnly=false` のような自己矛盾を作らないため）。

  **PR 5（alias 削除）で触る箇所は正規化だけではない。順序も含めて以下が全部要る**——
  **enum を先に閉じないまま正規化だけ消すと、旧値が enum を通過して新語彙しか扱わない分岐に
  到達する**（`get_flow_metrics` なら `compact` が `detailed` でも `full` でもないので
  全バケット列挙に落ちる、`get_candles` なら `items` が `format=text` 扱いになる）。
  黙って別の応答が返るので、§4-2 が避けようとしたサイレント破壊そのものになる。

  | # | 対象 | 内容 |
  |---|---|---|
  | 1 | `src/schema/market-data.ts` の enum | `get_flow_metrics` から `compact` / `buckets`、`get_transactions` から `summary` / `items`、`get_candles` から `items` を削除（**これを最初に行う**） |
  | 2 | 同 description | deprecated 行を削除。`deprecatedViewNote()` の呼び出しが残っていないかで機械的に確認できる |
  | 3 | ハンドラ | `normalizeFlowMetricsView()` の alias 分岐、`get_candles` / `get_transactions` の `view === 'items' ? 'json' : …` を削除 |
  | 4 | テスト | `tests/view-alias-mapping.test.ts` を「旧値は validation error」の検証に置き換える（サイレントに新値へ倒れないこと）。`tests/view-content-superset.test.ts` の `get_flow_metrics` は旧値（`buckets` / `compact`）で呼んでいるので新語彙へ書き換える |
  | 5 | プロンプト / ドキュメント | `src/prompts/*` と `docs/tools.md` に旧値が残っていないか（PR 4 で追従済みのはずだが再確認する） |

  **順序 1 → 3 は型で強制される。** 3 ツールのハンドラ引数の `view` / `format` 型は
  リテラルを手書きせず **Zod スキーマから導出**してある
  （`NonNullable<z.infer<typeof GetFlowMetricsInputSchema>['view']>` 等）。
  enum を閉じた瞬間に alias 分岐が全て `TS2367: This comparison appears to be unintentional
  because the types … have no overlap` になるので、**消し忘れた分岐は typecheck で必ず落ちる**。
  実際に enum から `compact` / `items` を消して確認済み:

  ```
  tools/get_flow_metrics.ts(123,6): error TS2367: … 'FlowMetricsView | undefined' and '"compact"' have no overlap.
  tools/get_candles.ts(908,44):     error TS2367: … '"full" | undefined' and '"items"' have no overlap.
  tools/get_transactions.ts(372,44): error TS2367: … '"full" | undefined' and '"items"' have no overlap.
  ```

  （手書きリテラルのままだと enum を消しても typecheck が通り、alias 分岐が黙って生き残る。
  PR 3 のレビュー中にこの drift を実測して塞いだ。）
- **`nonZeroOnly=true` の行生成は `renderCompactBucketLines()` を再利用**する。
  `full` の見出しは旧 `compact` と同一文言（`Non-zero X/Y buckets{gapNote}:`）。
  `detailed` + `nonZeroOnly=true`（旧 enum では表現できなかった組み合わせ）だけは
  `Recent N buckets, non-zero M{gapNote}:` という別の見出しにしてある。
- **`get_candles` の `structuredContent` を `Result` 封筒に統一した**（Phase 1 唯一の shape 破壊）。
  これで `tests/view-structured-content-invariance.test.ts` の逸脱ケースは無くなり、
  他ツールと同じ deep-equal に置き換えた。
- **description の共通文言は `src/schema/base.ts` に集約**した
  （`VIEW_CONTRACT_NOTE` / `FORMAT_PARAM_NOTE` / `deprecatedViewNote()` /
  `DEPRECATED_VIEW_REMOVAL_TARGET = '0.4.0'`）。PR 5 の削除時はこの定数を辿れば対象が全て出る。
- **テスト**: `tests/view-alias-mapping.test.ts` を新設（§4-4 の写像表を固定）。
  `tests/view-content-superset.test.ts` に `detect_patterns`（`summary` ⊆ `detailed` ⊆ `full`）を
  ヘルパそのままで横展開し、`patternRowKeys()`（§6-6 の「pattern type + range」）を足した。
- **ブリーフに無かった変更が 2 件**（いずれも既存テストの前提が本 PR の変更対象そのものだったため）:
  - `tests/schema/market-data.test.ts` の `GetTransactionsInputSchema` の default 期待値を
    `summary` → `full` に。挙動不変（§3-5）であることをコメントに残した。
  - `tests/prompts_contract.test.ts` の「無効値の負例」を `get_flow_metrics(view=detailed)` から
    `view=verbose` に。P6 の実例だった `detailed` は語彙統一で**有効値になった**ため負例に使えない。
- **レビュー（CodeRabbit）で入れた修正**:
  - **`VIEW_CONTRACT_NOTE` から「`structuredContent` は `view` に依存しない」を削除した。**
    §3-2 規約 4 が禁じているのは*削る*ことだけで、*足す*のは許容されている。
    `detect_patterns(detailed / debug)` と `detect_macd_cross(detailed)` は実際に足しているため、
    共有文言のままでは **description が実装に対して嘘**になっていた（呼び出し側が
    「`resultsDetailed` は `view` を問わず入る」と誤解する）。「フィールドを**削る**ことはない」に
    改め、足す 2 ツールには各 view の説明で**何を足すか**を明記した。
  - CHANGELOG の写像表に「不変」の基準（どの時点との比較か）を明記し、
    `get_candles` の shape 変更は「`format` が `structuredContent` を変える」ではなく
    「旧 `items` だけの逸脱の解消」であることを 3 通りの表で一意にした。
  - 上記 PR 5 の作業範囲の表（enum を先に閉じる順序）は、この指摘を受けて追加したもの。

#### 7-3-1. PR 3 で見つけた未解消の指摘（follow-up）

- **`detect_patterns(summary)` にしか出ない情報がある。** `直近30日: N件、直近90日: N件` と
  `検討パターン: …` は `detailed` / `full` に出ない。§3-2 規約 3（上位集合）に照らすと違反だが、
  §6-6 が定めた検証方式（定型要素 = `📌` / `⚠️` / `ℹ️` 行 ＋ ヘッダ主要フィールド）の
  対象外なので新設した階梯包含テストでは落ちない。**PR 3 では直していない**——
  修正すると既定 view（`detailed`）の `content` が変わり、
  §5-5 の受け入れ基準③「既定の応答が変わらないこと」に反するため。P3 の残件として別途扱う。
- **`format=json` のとき warning / 形成中足注記だけ JSON の外に出る。** `get_candles` /
  `get_transactions` は `content[0]` を素の JSON 配列に保ち、`meta.warning` と形成中足注記を
  `content[1]` 以降の別ブロックに置く。**LLM から見えなくなっているわけではない**——`content` は
  配列で、MCP ホストは全 text ブロックをモデルに渡す（`.claude/rules/tools.md` の
  「`content[0].text` だけが LLM に見える」は `structuredContent` が見えないことの言い換え）。
  ただし「JSON を要求した呼び出しに対して warning だけ形式が違う」のは一貫性を欠くので、
  `{ items, warning?, provisional? }` のような封筒に揃える案がある。
  **本 PR ではやらない**——`content` が旧 `items` と完全一致であることが alias 写像の要件
  （§4-4）で、既存テストもその構造を固定しているため。**alias を削除する PR 5 と同時に行う**のが適切。
- **`get_tickers_jpy` の `view`（`items` / `ranked`）は名前が誤用**（射影であって量でも形式でもない）。
  §6-3 の決定どおり本統一の対象外。**当リポジトリは GitHub Issues が無効化されているため
  issue を立てられなかった**ので、切り出す内容を下記に残す（Issues を有効化した時点でそのまま起票できる）。

  > **タイトル**: `get_tickers_jpy` の `view`（items / ranked）は名前が誤用 — `includeRanked` 等へ改名する
  >
  > `view` は統一後の語彙では**出力量の 1 軸**（`summary` < `detailed` < `full`、`full` は常に最重量）だが、
  > `get_tickers_jpy` の `items` / `ranked` は**射影**（並び順と `data.ranked` の有無）を指しており
  > この定義に当てはまらない。text の量は両者ほぼ同じ（§1-6）。同じ `view` という名前で公開されている以上、
  > 呼び出し側からは「量のつまみ」に見えてしまう。
  > さらに `view=items` が `structuredContent` から `data.ranked` を落としている点は
  > §3-2 規約 4（`view` は `structuredContent` からフィールドを削ってはならない）にも反する。
  >
  > **提案**: `view` を廃止し `includeRanked: boolean`（既定 `true`）へ改名する。
  > 並び順・件数は既にある `sortBy` / `limit` が担当している。破壊的変更なので、
  > 旧 `view` 値の削除（`0.4.0`、PR 5）と足並みを揃えるのが自然。
  >
  > **PR 3 のスコープ外にした根拠**: PR 3 は「量の語彙の統一」が対象で、射影の問題は別軸。
  > 1 つの PR に混ぜるとレビューの観点（互換性の判断 vs. パラメータ設計）が混ざる。
  >
  > **参考**: 本ドキュメント §1-6（挙動）/ §3-4（判断）/ §6-3（決定）、実装は
  > `src/handlers/getTickersJpyHandler.ts`。

### 7-4. PR 4 で実際に入ったもの

ブリーフ（§5-6）との差分を残す。PR 5 以降のセッションが前提にできる**現状**は以下:

- **プロンプト**: `src/prompts/intermediate.ts` の `get_flow_metrics(view=compact)` →
  `view=full, nonZeroOnly=true`、`get_transactions(view=summary)` → `view=full`。
  `detect_patterns(view=detailed)` は新語彙でも有効値なので**変更なし**。
- **`src/prompts/reports.ts`（おはようレポート）は `view=full` のみにし、`format=json` は付けなかった。**
  ブリーフ（§5-6 ②）と §4-5 の表は写像先を `view=full` + `format=json` と書いていたが、
  これは「旧 `items` と `content` を一致させる」場合の写像であって、
  **このプロンプトが必要としているものではない**。用途はスパークライン用に 24 本の close を得ることで、
  `view=full`（既定・`format=text`）のサマリ本文が `📋 全24件のOHLCV` として全 24 本を
  1 行 1 本の圧縮形式で含む（`tools/get_candles.ts:808-822`。基準は本 PR 着手時点の `main` = `f8ac35f`）。`format=json` にすると
  同じ 24 本が 10 行/本の pretty JSON になり（§1-1）、しかも `content` からサマリ本文・
  価格レンジ・キーポイント・出来高統計・フッタが**消える**。
  §2-0 の帰結 3（`format=json` はトークン削減オプションではない）をプロンプト側に適用した結果、
  **JSON を要求する理由が無く、`format` を落とすほうが軽く、かつ LLM が受け取る情報は増える。**
  `view="full"` を明示のまま残したのは、「24 本すべてを取る」という意図を呼び出し例に残すため
  （既定値と同値なので挙動は変わらない）。
- **`tests/prompts_contract.test.ts` の正規表現は変更不要だった。** `VIEW_ARG_RE` の bare 値は
  `[\w-]+` でカンマの手前で止まるため、`view=full, nonZeroOnly=true` から `view` の値だけを
  `full` として抽出する（`nonZeroOnly` は `view=` 接頭辞が無いのでそもそも当たらない）。
  同テストの「viewBox 等の別語を誤検出しない」ケースは `view="items"` を含むテキストを
  フィクスチャに持つが、これは**抽出の検証であって値の有効性検証ではない**（`extractViewUsages`
  の戻り値を直接見ており enum を引かない）ので、alias 削除後もそのまま通る。
- **`docs/tools.md` に「`view` の共通語彙」節を新設**（従来 `view` の記載はゼロだった）。
  階梯 / `full` が全件列挙とは限らない条件 / `structuredContent` を削らない契約 /
  `format`・`nonZeroOnly` の位置づけ / 階梯外の値 / 生データ系の既定が全件列挙である理由 /
  ツール別の値と既定 / **非推奨の値と写像先の表**を書いた。
  `get_tickers_jpy` の `view` は本語彙の対象外である旨も明記した（§6-3 / §7-3-1）。
- **`.claude/rules/tools.md` に「`view` の規約」節を追記**（規約 1〜7）。§3-2 の規約と
  §6-6 のテスト方式を開発者向けに要約し、`src/schema/base.ts` の共通文言と
  各共通テストへの導線を張った。あわせて handler チェックリストの
  `view=items` という例示を `format=json` に差し替えた（旧値を規約文書に残さないため）。

**PR 5 への申し送り**: §7-3 の PR 5 作業表の項目 5（プロンプト / ドキュメント）は
「旧値が残っていないか再確認」だが、**`docs/tools.md` の「非推奨の値（`0.4.0` で削除予定）」表は
意図的に旧値を載せている**（移行ガイドのため）。PR 5 ではこの表と、`get_transactions` の
`summary` に関する注意書きを**削除する**こと。同様に `src/schema/market-data.ts` の
`bucketsN` の description にある「（および deprecated な `view=buckets`）」も PR 5 の対象。
`src/handlers/getTickersJpyHandler.ts` のコメントにある `view=items` は
**`get_tickers_jpy` の対象外の `view`** なので PR 5 でも触らない（§6-3）。

### 7-5. 完了済み PR のブリーフの扱い

§5-1 / §5-2 / §5-3 / §5-5 / §5-6（PR 0〜4）のブリーフに書かれた行番号は**着手時点の値のまま**にしてある。
実施済みの作業指示なので、追随させる意味が無いため。
**未着手 PR のブリーフ（§5-7 以降）の行番号は `main` の現在値に追随させる**——
そちらは仕様書として読まれるため。更新時は基準コミットを併記すること。

同じ理由で、完了済みブリーフ内の**規約への言及も着手時点の表現のまま**にしてある
（例: §5-2 は「階梯外 view がフィールドを足すのは許容」と書いているが、
これは §3-2 規約 4 で**階梯位置を問わない**と改めた）。
**規約の現行解釈は §3-2 を唯一のソースとすること。**

---

## 付録: 調査に使ったソース

| 対象 | ファイル:行 |
|---|---|
| `view` の enum 定義 | `src/schema/market-data.ts:250, 319, 498-504` / `src/schema/analysis.ts:24` / `src/schema/patterns.ts:65` / `src/handlers/getTickersJpyHandler.ts:58` / `tools/detect_macd_cross.ts:609` |
| ハンドラ本体 | `tools/get_candles.ts:882-923` / `tools/get_transactions.ts:313-375` / `tools/get_flow_metrics.ts:677-767` / `src/handlers/detectPatternsHandler.ts:44-108` / `src/handlers/detectPatternsViewsHandler.ts:295-345, 689-775` / `src/handlers/getVolatilityMetricsHandler.ts:137-263` / `tools/detect_macd_cross.ts:659-690` |
| テキスト組み立て | `tools/get_flow_metrics.ts:109-155` / `tools/get_volatility_metrics.ts:81-109` / `lib/formatter.ts:216-` |
| `Result` → MCP 応答の変換 | `src/server.ts:33-85`（`respond()`） |
| 出力スキーマ（契約） | `src/schema/market-data.ts:208-221, 275-293, 366-380` |
| debug 配列の cap | `tools/detect_patterns.ts:280-292`（cap=200、accepted 優先） |
| リポジトリ内の `view` 利用 | `src/prompts/intermediate.ts:90-91, 128` / `src/prompts/reports.ts:16` |
| `content` が唯一のチャネルである根拠 | `.claude/rules/tools.md`「content テキストにデータを含める（重要）」/ `tools/get_candles.ts:807-808` / `tools/get_transactions.ts:248` / `tools/get_volatility_metrics.ts:331` / `tools/get_orderbook.ts:448` / `tools/get_tickers_jpy.ts:24` / `tools/detect_patterns.ts:295, 445` |
| 軽量 rung の差し戻し痕跡 | `src/handlers/getVolatilityMetricsHandler.ts:72-77`（`buildVolatilitySummaryText`、本番未使用）と `:237-245`（上流 summary を流す判断とその理由） |
