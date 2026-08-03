# `view` 語彙の統一 — 調査結果と設計提案

`view` パラメータの値がツール間で不揃いで、**同じ語が異なる重さを指している**問題の調査記録と設計提案。
本ドキュメントは**設計提案までで、コードは変更していない**。実装は本ドキュメントの合意後に別 PR で行う。

対象は MCP のツール入力スキーマ（`inputSchema`）として外部クライアントに公開される `view` の enum 値。
enum 値の変更は破壊的変更になるため、移行方針まで含めて先に合意する。

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
4. **削減の実効性が薄い。** `structuredContent` から `buckets` を落とす動機はトークン削減だが、
   本リポジトリの前提（`.claude/rules/tools.md`「LLM は `structuredContent` を参照できない」）が
   正しいなら、LLM 側のトークンは減らない。減るのはホストが `structuredContent` も文脈に載せる場合のみ。

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
| `full` | **全件列挙。常に最重量** | 上限 |

**階梯の規約（実装 PR で機械的に守らせる対象）**

1. **順序は不変**: `summary` ≤ `detailed` ≤ `full`。`full` は例外なく「そのツールの最重量」。
2. **中間の rung は省略してよい**。全ツールが 3 段すべてを実装する必要はない（例: `get_candles` は
   `summary` / `full` の 2 段）。ただし順序を飛び越えた意味づけは禁止。
3. **上位集合であること**（P3 の解消）: `detailed` の `content` は `summary` の内容を含み、
   `full` は `detailed` を含む。フッタ・警告・最終値のような定型情報を上位ビューで落とさない。
4. **`view` は `content` だけを変える**（P4 の解消）: `structuredContent` は view に依存させない。
   トークン削減のために落とす必要がある場合は、**スキーマ側を optional にしたうえで
   `meta.omitted: ['series.buckets']` のように省略を申告する**。黙って必須フィールドを消さない。
   （本リポジトリの既存方針——欠損を黙って消さない——と同じ扱い）
5. **同じ語の意味はツールを跨いで一定**。`summary` が別ツールで「全件」を意味してはならない。

### 3-3. 量以外の軸（別パラメータへ切り出す）

| 新パラメータ | 型 / 既定 | 対象ツール | 吸収する現行値 |
|---|---|---|---|
| `format` | `'text' \| 'json'` / `'text'` | `get_candles` / `get_transactions` | `items` |
| `nonZeroOnly` | `boolean` / `false` | `get_flow_metrics` | `compact` |

`format=json` は「`content` を pretty JSON にする」だけで、量は `view` が決める。
これにより現状表現できない組み合わせ（`view=summary` かつ JSON など）も自然に表現できる。

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

**default を軽いほうへ倒す変更は、語彙統一とは別の判断として切り離す。**
`get_candles` / `get_transactions` が既定で全件を `content` に載せているのは、
「LLM は `content[0].text` しか読めない」という本リポジトリの設計方針（`.claude/rules/tools.md`）に
基づく意図的な選択であり、既定を `summary` に落とすと**応答内容が変わって既存プロンプト・
外部クライアントの前提が崩れる**。語彙統一（名前の問題）と既定の軽量化（挙動の問題）を
同じ PR で混ぜない。後者は Phase 3 で独立に議論する。

### 3-6. 移行後の全体像

```
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

| Phase | リリース目安 | 内容 | 破壊性 |
|---|---|---|---|
| **1** | 次のマイナー（例 `0.2.0`） | 統一語彙を導入。旧値は **deprecated alias** として受理し、ハンドラ入口で新値に正規化。`format` / `nonZeroOnly` を追加。P3（上位集合）と P4（`structuredContent` 非依存）を修正。description を統一文言に | **非破壊**（旧値は動く。既定挙動も不変） |
| **2** | 次の次のマイナー（例 `0.3.0`、Phase 1 から最低 1 リリース かつ 3 ヶ月以上あける） | 旧 alias を enum から削除 | **破壊的**（旧値は validation error） |
| **3** | 需要ベース（別議論） | `get_candles` / `get_transactions` に軽量 `summary` を新設。既定を軽いほうへ倒すかを独立に判断 | 追加は非破壊 / 既定変更は挙動変更 |

`0.x` 系なので SemVer 上はマイナーで破壊的変更を出せるが、**Phase 1 と Phase 2 を同一リリースに
畳まない**ことを条件とする（alias 期間があること自体が移行方針の実体であるため）。

### 4-4. Phase 1 の alias 写像表

| ツール | 旧値 | 新しい指定 | 挙動 |
|---|---|---|---|
| `get_candles` | `items` | `view=full` + `format=json` | 不変 |
| `get_transactions` | `summary`（既定） | `view=full` | 不変 |
| `get_transactions` | `items` | `view=full` + `format=json` | 不変 |
| `get_flow_metrics` | `compact` | `view=full` + `nonZeroOnly=true` | 不変 |
| `get_flow_metrics` | `buckets` | `view=detailed` | 不変 |
| `detect_patterns` | — | 変更なし | 不変 |
| `get_volatility_metrics` | — | 変更なし | 不変（P3 修正でフッタが増える） |

### 4-5. 破壊的変更の影響範囲

**外部（Phase 2 で影響）**

- MCP クライアントが `view` に旧値を渡している場合、validation error。
- `structuredContent` を消費するクライアント: Phase 1 の P4 修正で
  `get_flow_metrics view=summary` に `series.buckets` が**戻る**（従来キーごと欠落）。
  `get_candles view=full&format=json` は `{ items, meta }` ではなく `Result` 封筒を返すようになる
  （旧 `items` の shape に依存しているクライアントは要修正）。**この 2 点は Phase 1 時点で影響が出る**ため、
  Phase 1 を「完全非破壊」とは呼べない。CHANGELOG では Phase 1 でも明記する。

**リポジトリ内（実装 PR で同時に直す）**

| 箇所 | 内容 |
|---|---|
| `src/schema/market-data.ts` / `analysis.ts` / `patterns.ts` | enum 定義・description |
| `tools/get_candles.ts` / `get_transactions.ts` / `get_flow_metrics.ts` | ハンドラの分岐 |
| `src/handlers/detectPatternsHandler.ts` / `getVolatilityMetricsHandler.ts` | P3 のフッタ欠落修正 |
| `src/prompts/intermediate.ts:90-91` | **`get_flow_metrics(view=detailed)` は現在無効値**（P6）。`view=detailed`（新語彙では有効）になるので結果的に解消するが、意図が「直近 N バケット」なのか「全バケット」なのかを確認して直す |
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
>   `summary`（集計のみ）は将来別リリースで新設予定。
>   **同じ語の意味を差し替えないため、`summary` は alias 期間の削除後にのみ再導入する。**
> - 既定の応答内容が変わるツールは無い（`get_volatility_metrics` の `detailed` / `full` /
>   `beginner` で欠落していた 4 行フッタが復活する点を除く）。

---

## 5. 実装 PR の分割案

| PR | 内容 | 依存 |
|---|---|---|
| 1 | **P4 の修正**（`view` を `structuredContent` から切り離す）。`get_flow_metrics` の `series.buckets` 削除をやめ、`get_candles(items)` の封筒を戻す。語彙は変えない | なし |
| 2 | **P3 の修正**（上位集合の保証）。`get_flow_metrics` の `buckets` / `full`、`get_volatility_metrics` の `detailed` / `full` / `beginner` でフッタ・最終値・スパイク詳細を落とさない | なし |
| 3 | **語彙統一 Phase 1**。enum 変更 + alias + `format` / `nonZeroOnly` 追加 + description 統一 | 1, 2 |
| 4 | **リポジトリ内呼び出し側の追従**（`src/prompts/*`、`docs/tools.md` に共通語彙節を追加） | 3 |
| 5 | **Phase 2**（alias 削除）。別リリース | 3, 4 |

PR 1 / 2 を先に出すことで、語彙変更（外部契約）と挙動修正（内部バグ）をレビュー単位で分離できる。

---

## 6. レビューで決めたいこと / follow-up

1. **`format` を新パラメータとして足すか、`view` の値のまま（例 `full_json`）にするか。**
   本提案は前者。後者はパラメータが増えない代わりに、量と形式の直積が enum 値の数だけ増える。
2. **`get_transactions` の `summary` 再導入をやるか**（Phase 3）。やらないなら
   `get_transactions` は `full` のみになり、量の制御は `limit` に一本化される。
3. **`get_tickers_jpy` の `view`（`items` / `ranked`）を本統一に含めるか。**
   本提案は対象外（射影の指定であり量ではないため）。含めるなら `includeRanked: boolean` への改名を推奨。
4. **alias の猶予期間**（本提案は「最低 1 リリース かつ 3 ヶ月」）。
5. **P6 の即時修正**: `src/prompts/intermediate.ts:90` の `get_flow_metrics(view=detailed)` は
   現時点で validation error になる無効値。語彙統一を待たず単独で直す価値がある
   （本 PR はドキュメントのみのため未修正）。
6. **階梯規約の機械的な担保**: 「`full` が最重量」「上位ビューは上位集合」「`structuredContent` は
   view 非依存」をテストで固定するか（例: 各ツールの view を総当りして
   `len(summary) ≤ len(detailed) ≤ len(full)` と `structuredContent` の同一性を検証する
   共通テスト）。`.claude/hooks/post-ts-lint.sh` の banned-patterns と同じ発想で、
   規約を人手のレビューに委ねない。

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
