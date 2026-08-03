# fork ↔ upstream の乖離と view 語彙統一の移植計画（実測ログ）

`tjackiet/bitbank-lab-mcp`（fork）と `bitbankinc/bitbank-lab-mcp`（upstream）の実差分を git 上で実測し、
`docs/internal/view-vocabulary-unification.md` の成果を `bitbankinc:main` へ還元する際の移植方式を決める。
本ログはその一次ソース。**本調査ではコードを一切変更していない**（ブランチ作成・マージ・rebase なし。
upstream remote の登録と fetch のみ）。

## 結論（断定）

1. **fork main と upstream/main の実差分は 4 ファイル / `+26 -7` 行しかない。**
   しかも 4 ファイルは全て**上流が先行**している側（`src/server.ts` の version drift 修正ほか）で、
   fork 側が上流に無い変更を main に持っているわけではない。
2. **view 語彙統一が触る 14 ファイルは、fork main と upstream/main で byte 単位に一致する。**
   「upstream 側で対象ファイルが動いていて衝突する」というリスクは**ゼロ**。
3. **P1〜P7 は 7 件すべて upstream/main の現行コードで再現する。成立しなくなった指摘は無い。**
   enum 値と default も §0-2 の表のまま（行番号だけずれる）。
4. **ただし設計ドキュメント §1-3 の `compact` 行の記述は fork 専用挙動を書いている。**
   欠損区間の畳み込み（`renderCompactBucketLines`）は fork の前段作業で入ったもので、
   upstream の `compact` は素の非ゼロフィルタ。**upstream へ出す前に §1-3 の当該行の訂正が要る。**
5. **移植の難所は `get_flow_metrics` ただ 1 つ。** view 作業は fork 独自の前段作業
   （`renderCompactBucketLines` / `hasData` / `actualRange.gapMinutes` / `meta.warnings`）に
   実装レベルで依存しており、**cherry-pick では移らない。書き直しが要る。**
   残りのツール（`get_candles` / `get_transactions` / `get_volatility_metrics` / `detect_patterns` /
   `detect_macd_cross`）とスキーマ・プロンプト・ドキュメントは素直に載る。
6. **推奨は (i)**（upstream/main ベースの新ブランチに再適用）。ただし upstream 側は **2 PR に割る**（§4）。
7. **upstream の CI は fork からの PR でもそのまま回る。** `ci.yml` / `security.yml` は
   `pull_request: branches:[main]` トリガーで、**secrets 依存が無い**。

### 別途報告事項（upstream 側のリリース運用）

- **upstream/main の `package.json` の version は `0.1.1` のまま。** 公開済みの `0.3.1` と 3 世代ずれている。
  プラグインマニフェスト 4 種（`.claude-plugin` / `.codex-plugin` / `.cursor-plugin` / `gemini-extension.json`）
  と `package-lock.json` も全て `0.1.1`。**バージョン番号をコードの世代の指標に使ってはならない**という
  前提は upstream 側でも成立している。
- **一方、git tag は upstream には 4 本ある**（`v0.2.0` / `v0.2.1` / `v0.3.0` / `v0.3.1`）。
  `v0.3.1` = `31a8480` = **upstream/main の HEAD そのもの**。「tag がゼロ」なのは fork 側の話で
  （`git ls-remote --tags origin` が 0 件）、upstream では tag が世代の指標として使える。
- つまり upstream のリリース運用は「**tag は打つが version bump をコミットしない**」という形。
  `release.yml` は `push: tags:['v*']` で発火するので、tag だけで publish は回る。
  ただし `src/server.ts` が `package.json` を単一ソースにした（`31a8480`）ため、
  **`serverInfo.version` は `package.json` の値をそのまま申告する = 計測時点では `0.1.1`。**
  値は `package.json` を更新すれば当然変わるが、**bump をコミットしない運用が続く限り、
  tag を何本打っても申告値は `0.1.1` から動かない。** drift はハードコードから
  「bump し忘れ」へ移っただけで、解消していない。
  **運用要件: リリース時に `package.json`（およびプラグインマニフェスト 4 種）の version bump を
  コミットに含める。** そこまで揃えて初めて `31a8480` の修正が意図どおり効く。

## 計測条件

| 項目 | 値 |
|---|---|
| 計測日 | 2026-08-03 |
| fork main | `f8ac35f`（2026-07-29 21:50 +0900） |
| upstream/main | `31a8480`（2026-07-31 17:24 +0900）= tag `v0.3.1` |
| 作業ブランチ HEAD | `6794ef1`（view 語彙統一 PR #24 マージ後） |
| upstream 取得 | `https://github.com/bitbankinc/bitbank-lab-mcp.git` を `upstream` remote に登録 → `git fetch upstream`（下記注記） |
| 衝突判定 | `git merge-tree --merge-base=<base> <ours> <theirs>`（in-memory。ワークツリー・ブランチとも不変） |

> **注記（プロキシ経由の到達）**: 本調査はサンドボックス環境で実施したため、実際の fetch は origin と同じ
> セッションローカルな git プロキシ（`http://local_proxy@127.0.0.1:<port>/git/bitbankinc/bitbank-lab-mcp`）
> 経由で行った。**ポート番号はセッションごとに変わり、他の環境からは再利用できない。**
> upstream は public リポジトリなので、通常の環境では上記の GitHub URL をそのまま使えばよい。

---

## 1. 分岐点と差分規模

### 1-1. merge-base と ahead カウント

| 項目 | 値 |
|---|---|
| merge-base(main, upstream/main) | `2c28e03`（2026-07-15 16:33 +0900）= tag `v0.2.1` |
| merge-base → upstream/main | **3 commits** |
| merge-base → fork main | **16 commits** |
| merge-base → 作業ブランチ HEAD | **90 commits**（うち fork main 以降が 74） |

### 1-2. upstream の 3 commit

```text
31a8480 2026-07-31 fix: serverInfo.version を package.json 由来にし 0.4.2 の drift を解消 (#24)
4cea084 2026-07-30 docs: .coderabbit.yaml 冒頭コメントを実態に合わせて是正（機能変更なし） (#20)
e47e54d 2026-07-30 sync: MCP 2026-07-28 対応一式（SDK v2 + MRTR / UI 自己復元 / HITL 強化） (#22)
```

merge-base からの diff は 38 ファイル / `+1757 -939` と大きく見えるが、**その大半（`e47e54d`）は
fork の PR #1〜#6 が upstream に取り込まれたもの**で、fork main 側にも同内容が入っている。
`git cherry -v main upstream/main` は 3 件とも「未取り込み」と判定するが、これは squash/rebase により
patch-id が変わっているためで、内容差ではない。

### 1-3. 真の乖離（`git diff main upstream/main`）

**4 ファイル / `+26 -7` 行。**

| ファイル | numstat | 内容 |
|---|---:|---|
| `src/server.ts` | `+9 -1` | `serverInfo.version` を `'0.4.2'` ハードコードから `createRequire` 経由の `package.json` 参照へ |
| `tests/server_smoke.test.ts` | `+8 -1` | 上記の期待値をリテラルから `package.json` 参照へ |
| `.coderabbit.yaml` | `+6 -5` | 冒頭コメントの是正のみ（設定値は不変） |
| `CHANGELOG.md` | `+3 -0` | 上記の `### Fixed` エントリ |

**npm tarball に含まれない領域（`tests/` / `docs/` / `.github/` / `scripts/`）に差分は集中していない。**
`.github/` は**完全一致**（`git diff main upstream/main -- .github/` が空）。`docs/` も差分なし。
`tests/` の差分は上記 `server_smoke.test.ts` の 8 行だけ。

→ 事前の tarball 比較（「`src/server.ts` の 12 行のみ」）は git 側でもほぼそのまま成立する。
git 側で追加で見えたのは `.coderabbit.yaml` / `CHANGELOG.md` / `tests/server_smoke.test.ts` の 3 ファイルで、
いずれも移植の障害にならない。

---

## 2. view 語彙統一が触る箇所の衝突見込み

### 2-1. 対象 14 ファイルの upstream 差分 — **全て変更なし**

`git diff main upstream/main -- <file>` が空であることを 1 ファイルずつ確認した。

| ファイル | upstream の変更 |
|---|---|
| `src/schema/market-data.ts` | **なし** |
| `src/schema/base.ts` | **なし** |
| `src/schema/analysis.ts` | **なし** |
| `src/schema/patterns.ts` | **なし** |
| `tools/get_flow_metrics.ts` | **なし** |
| `tools/get_candles.ts` | **なし** |
| `tools/get_transactions.ts` | **なし** |
| `tools/get_volatility_metrics.ts` | **なし** |
| `tools/detect_macd_cross.ts` | **なし** |
| `src/handlers/getVolatilityMetricsHandler.ts` | **なし** |
| `src/handlers/detectPatternsHandler.ts` | **なし** |
| `src/prompts/intermediate.ts` | **なし** |
| `src/prompts/reports.ts` | **なし** |
| `tests/prompts_contract.test.ts` | **なし** |

`tests/view-*.test.ts` は 3 本とも view 作業で新規追加したファイルで、upstream にも fork main にも存在しない
（`tests/view-alias-mapping.test.ts` / `tests/view-content-superset.test.ts` /
`tests/view-structured-content-invariance.test.ts`）。新規ファイルなので衝突しない。

**→ 「upstream が対象ファイルを動かしていた」型の衝突は 1 件も無い。**

### 2-2. 実際の衝突は upstream 起因ではなく **fork 自身の前段作業**起因

view 作業（`f646835..HEAD`、PR #18〜#24）を upstream/main へ 3-way で載せると 5 ファイルが衝突する。

```text
git merge-tree --merge-base=f646835 upstream/main HEAD
  CONFLICT (content): CHANGELOG.md
  CONFLICT (content): src/schema/base.ts
  CONFLICT (content): src/schema/market-data.ts
  CONFLICT (content): tests/get_flow_metrics.test.ts
  CONFLICT (content): tools/get_flow_metrics.ts
  （その他 19 ファイルは Auto-merging で衝突なし）
```

原因は upstream ではなく、**fork main から view 作業開始点（`f646835`）までの 47 commit（PR #7〜#17）**が
同じファイルを書き換えていること。この前段作業は upstream に入っていない。

| ファイル | 前段作業 `main..f646835` | view 作業 `f646835..HEAD` |
|---|---:|---:|
| `CHANGELOG.md` | `+94 -0` | `+63 -1` |
| `src/schema/base.ts` | `+86 -0` | `+45 -0` |
| `src/schema/market-data.ts` | `+124 -20` | `+53 -5` |
| `tests/get_flow_metrics.test.ts` | `+38 -4` | `+18 -9` |
| `tools/get_flow_metrics.ts` | `+393 -251` | `+97 -37` |

前段作業の中身は `lib/tx-fetch.ts` / `lib/calendar.ts` の新設、`since` / `until` の絶対区間指定、
暦日計算の集約、カバレッジ warning の追加など。**view 語彙統一とは無関係**な機能追加・リファクタである。

### 2-3. 衝突 5 件の性質（機械的 / 要書き直し）

| ファイル | 性質 | 解消コスト |
|---|---|---|
| `CHANGELOG.md` | **機械的**。両者が `## [Unreleased]` 直下に別エントリを足す add/add | 低。view 分のエントリだけ残す |
| `src/schema/base.ts` | **機械的**。前段が `ISO8601_WITH_OFFSET_PATTERN` 等を、view が `VIEW_CONTRACT_NOTE` 等を同じ末尾に足す add/add。**view 側のブロックは前段のシンボルを一切参照しない**（自己完結） | 低。view 側のブロックをそのまま置く |
| `src/schema/market-data.ts` | **ほぼ機械的**。import 文の context に前段由来の `TX_RANGE_SINCE_SCHEMA` / `TX_RANGE_UNTIL_SCHEMA` が挟まるための衝突。ただし `nonZeroOnly` の description が fork 専用挙動（`hasData=false` の欠損畳み込み）を説明しているので**文言の書き直しが要る** | 中 |
| `tests/get_flow_metrics.test.ts` | 前段のテスト追加と重なる | 中 |
| `tools/get_flow_metrics.ts` | **要書き直し**（下記 2-4） | **高** |

### 2-4. `get_flow_metrics` だけは cherry-pick では移らない

view 作業が `tools/get_flow_metrics.ts` に入れたコードは、**upstream に存在しない識別子を参照する**。

| 識別子 | fork（`f646835` 以降） | upstream/main | 出自 |
|---|---|---|---|
| `renderCompactBucketLines` | あり | **無し** | 前段作業（欠損区間の畳み込み） |
| バケットの `hasData` | あり | **無し** | 前段作業 |
| `actualRange.gapMinutes` | あり | **無し**（`start` / `end` / `durationMinutes` のみ。`src/schema/market-data.ts:352-358`） | 前段作業 |
| `actualRange.requestedMinutes` | あり | **無し** | 前段作業 |
| `meta.warnings`（計算層 `string[]`） | あり（`src/schema/market-data.ts:471`） | **無し**（`warning: string` のみ、`:359`） | 前段作業 |
| `GetFlowMetricsOutputSchema` | あり | **あり**（`:362`） | 共通 |

具体的には、view 作業で新設した `renderNonZeroSection()` が

> **必ず `renderCompactBucketLines` を通す。** 素朴な実装では欠損の連続区間が区間 1 行に畳まれず……

という前提で書かれている。upstream の `compact`（`tools/get_flow_metrics.ts:594-605`）は
`buckets.filter((b) => b.buyVolume > 0 || b.sellVolume > 0)` の**素の非ゼロフィルタ**で、
欠損の概念自体が無い。したがって

- alias 写像 `compact → view=full + nonZeroOnly=true` の「バケット行が 1 バイトも変わらない」という
  保証は、**upstream では upstream 自身の `compact` 出力に対して取り直す**必要がある。
- `nonZeroOnly` の description から欠損畳み込みの記述を落とす（upstream に該当挙動が無い）。
- warning 行の扱いも 1 系統（`meta.warning`）だけになる。

**これは劣化ではない。** upstream にとっては `compact` の出力が不変であることこそが互換性であり、
fork 側の欠損畳み込みは別の（前段作業の）成果として独立に還元すべきもの。

### 2-5. 新規 view テスト 3 本の移植可否

merge は通る（新規ファイルのため）が、**upstream のコードに対しては一部が実行時に落ちる**。
「merge clean ≠ テストが通る」なので個別に精査した。

| テストファイル | ケース数 | upstream でそのまま通るか |
|---|---:|---|
| `tests/view-structured-content-invariance.test.ts` | 7（1 ツール 1 ケース） | `get_flow_metrics` の 1 ケースのみ要調整。他 6 ケース（`get_candles` / `get_transactions` / `get_volatility_metrics` / `detect_patterns` / `detect_macd_cross`）は**そのまま通る見込み** |
| `tests/view-content-superset.test.ts` | 15 | `get_flow_metrics` 5 ケース中 2 ケースが要書き直し。特に「取得層 ⚠️/ℹ️ と計算層 ⚠️ の注記行が buckets / full でも残る」は fork 専用の `meta.warnings` と `ℹ️ カバレッジ` 注記に依存。`get_volatility_metrics` 4 / `detect_patterns` 5 は**そのまま通る見込み**（`detect_patterns` の `warnings[]` は upstream にも在る: `src/schema/patterns.ts:256,326`） |
| `tests/view-alias-mapping.test.ts` | 16 | `get_flow_metrics` 7 ケースのうち、`hasData` を直接検証する 2 ケース（「真のゼロを出さず、欠損の連続区間は 1 行に畳む」ほか）が要書き直し。`get_transactions` 4 / `get_candles` 4 は**そのまま通る見込み** |

**→ 3 本合計 38 ケースのうち、書き直しが要るのは `get_flow_metrics` 関連の 5〜6 ケースに限られる。**

### 2-6. view 関連 PR ごとの移植難易度

| PR | 内容 | 変更規模 | upstream への載り方 |
|---|---|---:|---|
| #18 | 設計ドキュメント新設 | 1 file `+736` | **clean**。ただし §1-3 `compact` 行と行番号の訂正が要る（§3-3） |
| #19 | PR 0: `intermediate.ts` の無効 view 修正 + 契約テスト | 3 files `+145 -2` | **clean**（#24 が最終形に上書きするので、実質 #24 に吸収される） |
| #20 | PR 1: `structuredContent` を view から切り離す | 5 files `+357 -26` | **要書き直し**（`get_flow_metrics` 本体） |
| #21 | 設計ドキュメント同期 | 1 file `+138 -22` | **clean** |
| #22 | PR 2: 上位集合の保証 | 6 files `+414 -22` | `get_volatility_metrics` は **clean** / `get_flow_metrics` は**要書き直し** |
| #23 | PR 3: 語彙統一 Phase 1（alias 導入） | 15 files `+1088 -101` | `get_candles` / `get_transactions` / `detect_macd_cross` / `patterns` / `analysis` / `base` は **clean** / `market-data` の flow 部と `get_flow_metrics` は**要書き直し** |
| #24 | PR 4: 呼び出し側とドキュメントの追従 | 7 files `+314 -15` | **clean**（`.claude/rules/tools.md` は upstream にも存在） |

---

## 3. 設計ドキュメント §1〜§2 の結論が upstream/main で成立するか

**7 件すべて再現。成立しなくなった指摘は無い。**
以下の行番号は **upstream/main（`31a8480`）** 実測値。設計ドキュメントの行番号は fork の `f646835` 基準
なので、`src/schema/market-data.ts` と `tools/get_flow_metrics.ts` で最大 100 行以上ずれる。

### 3-1. §0-2 の view enum / default 表 — **7 ツールすべて一致**

| ツール | upstream/main の定義位置 | 値 | default | §0-2 と一致 |
|---|---|---|---|---|
| `get_candles` | `src/schema/market-data.ts:246`（doc: 250） | `full` / `items` | `full` | ✅ |
| `get_transactions` | `src/schema/market-data.ts:288`（doc: 319） | `summary` / `items` | `summary` | ✅ |
| `get_flow_metrics` | `src/schema/market-data.ts:394-397`（doc: 498-504） | `summary` / `compact` / `buckets` / `full` | `summary` | ✅ |
| `detect_patterns` | `src/schema/patterns.ts:65`（doc: 65） | `summary` / `detailed` / `full` / `debug` | `detailed` | ✅ |
| `get_volatility_metrics` | `src/schema/analysis.ts:21`（doc: 24） | `summary` / `detailed` / `full` / `beginner` | `summary` | ✅ |
| `get_tickers_jpy` | `src/handlers/getTickersJpyHandler.ts:58`（doc: 58） | `items` / `ranked` | `ranked` | ✅ |
| `detect_macd_cross` | `tools/detect_macd_cross.ts:609`（doc: 609） | `summary` / `detailed` | `summary` | ✅ |

`get_flow_metrics` の description も `'summary: 集計値のみ (buckets 省略) / compact: 非ゼロバケットのみ /
buckets: 直近 N バケット / full: 全バケット'` のままで、§1-3 の前提と一致する。

### 3-2. P1〜P7 の再現状況

| # | 指摘 | upstream/main での確認 | 再現 |
|---|---|---|---|
| **P1** | `full` が「既定」と「最重量」の両方を指す | `get_candles` の default が `full`（`market-data.ts:246`）／`get_flow_metrics` の `full` が全バケット列挙（`get_flow_metrics.ts:623`） | ✅ |
| **P2** | `items` は形式指定でしかも最重量 | `get_candles(items)` は `JSON.stringify(items, null, 2)` を content に出す（`get_candles.ts:932-946`）。`limit` 既定 200 本 × 10 行 = `full` より重い | ✅ |
| **P3** | 重い view が軽い view の上位集合でない | `get_flow_metrics` の `buckets` / `full` は `res.summary` を**使わず**、`${pair} Flow Metrics …` / `Totals: …` を組み直す（`get_flow_metrics.ts:607-624`）。`get_volatility_metrics` は `view==='summary'` だけが `res.summary` を流し（`getVolatilityMetricsHandler.ts:240-245`）、`detailed` / `full` は `buildVolatilityDetailedText` で再構築（`:257`）してフッタが消える | ✅ |
| **P4** | `view` が `structuredContent` の契約を変える／1 件は宣言スキーマ違反 | `get_flow_metrics.ts:587` に `const { buckets: _omit, ...restSeries } = (res.data.series ?? {})` が**そのまま在る**。一方 `GetFlowMetricsDataSchemaOut` は `series: z.object({ buckets: z.array(FlowBucketSchema) })` を**必須**で宣言（`market-data.ts:341`）。`get_candles(items)` の `structuredContent: { items, meta: result.meta }`（封筒消失）も `get_candles.ts:944` に在る | ✅ |
| **P5** | 同名の値が同じ契約を意味していない | `get_transactions(items)` は `structuredContent: { ...res, summary, data: {...} }` で**封筒を保持**（`get_transactions.ts:276-279`）。同じ `items` で `get_candles` は封筒を捨てる | ✅ |
| **P6** | リポジトリ内で既に無効な view 値が使われている | `src/prompts/intermediate.ts:90` が `get_flow_metrics(pair=btc_jpy, limit=300, bucketMs=60000, view=detailed)` を指示。`detailed` は同ツールの enum に**無い**（`summary`/`compact`/`buckets`/`full`） | ✅ |
| **P7** | default が揃っていない | `full` / `summary` / `detailed` / `ranked` の 4 種（§3-1 の表） | ✅ |

**§2-0 の「決定的な痕跡」も再現する。** `buildVolatilitySummaryText`
（`src/handlers/getVolatilityMetricsHandler.ts:72`）は本番経路から呼ばれず、`view==='summary'` は
上流 `res.summary` をそのまま流す。upstream/main の `:238` に理由コメントも残っている:

> ここでは buildVolatilitySummaryText の一行要約ではなく上流 summary をそのまま流す

参照元は同ファイルの export と `tests/build_volatility_handler_text.test.ts` /
`tests/handlers/getVolatilityMetricsHandler.test.ts` のみ = **テスト専用**。§2-0 の記述どおり。

`detect_patterns` の独自 shape も在る（`src/handlers/detectPatternsViewsHandler.ts:762,768` の
`usage_example`）。§1-4 と一致。

### 3-3. **要訂正**: §1-3 の `compact` 行は fork 専用挙動を書いている

**成立しなくなった指摘ではないが、upstream に出す前に必ず直す必要がある箇所。**

§1-3 の `compact` 行はこう書いている:

> 欠損バケットは落とさず `⋯ 欠損 A〜B（Nバケット, データなし）` の区間 1 行に畳む（`:730-741`, `renderCompactBucketLines`）

upstream/main の `compact`（`tools/get_flow_metrics.ts:594-605`）にこの挙動は**無い**。
`renderCompactBucketLines` という関数自体が upstream に存在しない。upstream の `compact` は

```ts
const nonZero = buckets.filter((b) => b.buyVolume > 0 || b.sellVolume > 0);
```

の素のフィルタで、欠損バケットは**黙って落ちる**。同様に §1-3 `summary` 行の
「⚠️ 計算層 warnings」も、upstream の `get_flow_metrics` には `meta.warnings` が無いため成立しない
（`meta.warning` の 1 系統のみ）。

これは設計判断を覆すものではない（P3 / P4 の根拠は `res.summary` を捨てる点と `buckets` を削る点にあり、
`compact` の欠損処理には依存していない）。**ドキュメントの事実記述の訂正で足りる。**

---

## 4. 移植方式の推奨

### 4-1. 推奨: **(i) upstream/main ベースの新ブランチを fork 内に作り、差分を再適用する**

理由（実測に基づく）:

1. **(ii) は前提条件に反する。** fork main に upstream/main をマージすると fork main が書き換わる。
   「fork の main は設計反復の記録として残す」という前提と両立しない。
2. **(ii) には upstream PR 混入の回避策が要るが、その回避策が結局 (i) と同じ作業になる。**
   view 作業は fork 独自の前段作業 47 commit（PR #7〜#17: `lib/tx-fetch.ts` / `lib/calendar.ts` /
   `since`・`until` 等）の**上に積まれている**。fork main を upstream/main と同期してからブランチを
   切っても、そこへ view 作業を持ってくる時点で前段作業が一緒に付いてくるため、
   `bitbankinc:main` 向けの diff に前段作業が混ざる。除くには結局 upstream/main ベースで
   view 差分だけを組み直すしかない = (i) と同じ作業。
3. **(i) のコストは小さい。** upstream 側は対象 14 ファイルを 1 行も触っていない（§2-1）ので、
   「upstream に追従する」作業は**存在しない**。実作業は fork 独自の前段作業から view 差分を
   剥がすことだけで、それも `get_flow_metrics` に集中している（§2-4）。
4. `upstream/main` は tag `v0.3.1` そのもの（`31a8480`）なので、**ベースが公開リリース点と一致する**。
   PR のレビュアーにとって差分の解釈が最も素直になる。

### 4-2. 具体的な手順

```bash
# fork 内に upstream/main ベースのブランチを作る（fork main は触らない）
git fetch upstream
git checkout -b view-vocab/upstream-base upstream/main
```

その上で **upstream 側は 2 PR に割る**。1 PR にまとめると、機械的に載る部分と書き直しが要る部分が
同じ diff に混ざり、レビューが `get_flow_metrics` の再設計に引きずられる。

| upstream PR | 範囲 | 移植方法 | 根拠 |
|---|---|---|---|
| **PR A**（先） | `src/schema/base.ts` の共通語彙（`VIEW_CONTRACT_NOTE` / `FORMAT_PARAM_NOTE` / `deprecatedViewNote` / `DEPRECATED_VIEW_REMOVAL_TARGET`）＋ `get_candles` / `get_transactions` / `get_volatility_metrics` / `detect_patterns` / `detect_macd_cross` の view 語彙統一 ＋ プロンプト・`docs/tools.md`・`.claude/rules/tools.md` の追従 ＋ 設計ドキュメント（§1-3 訂正版） ＋ view テスト 3 本の**当該ツール分** | **cherry-pick でほぼそのまま**。`base.ts` は add/add の機械的衝突のみ | §2-3 / §2-5 / §2-6 |
| **PR B**（後） | `get_flow_metrics` の view 語彙統一（`structuredContent` 非削除、`res.summary` の上位集合化、`compact`/`buckets` alias、`nonZeroOnly` 切り出し） | **書き直し。** upstream の素の `compact` 実装に対して alias 出力の一致を取り直す。`hasData` / `gapMinutes` / `meta.warnings` への参照は落とす | §2-4 |

PR A に P6 の修正（`src/prompts/intermediate.ts:90` の無効 `view=detailed`）を含める場合、
写像先は `get_flow_metrics` の新語彙になるので **PR B より後**に回すか、
PR A では暫定的に upstream の既存 enum 内の値（`compact`）へ直す。
**fork では PR #19 が一度 `compact` に直し、PR #24 が最終形 `view=full, nonZeroOnly=true` に置き換えている**
（HEAD 時点の値）。upstream でも同じ 2 段構えが素直。

### 4-3. fork 内でのローカル動作確認

- **`npm ci` が先に要る。** この環境に `node_modules` は無い。
- **Node のバージョン差に注意。** ローカルは Node v22.22.2 / npm 10.9.7、CI は **Node 24**。
  さらに `CONTRIBUTING.md` は `.npmrc` の `min-release-age` に **npm 11.10 以上**を要求している
  （npm 10.x では黙って無視される）。`npm ci` は lockfile 厳密インストールなので
  クールダウン自体の影響は受けないが、ローカルで `npm install` を打つ場合は npm を上げること。
- 実行するのは `npm run gen:types` → `npm run typecheck` → `npm test` → `npm run test:coverage`
  （CI の `ci.yml` と同じ順序・同じコマンド）。`npm run test:e2e` は CI では PR 時に走らない（§5-2）。
- **fork へ push しただけでは CI は動かない**（§5-2）。CI を回したいなら
  `tjackiet:view-vocab/upstream-base → tjackiet:main` の **draft PR をマージせずに**開く。
  この PR の diff には view 差分に加えて §1-3 の 4 ファイル（`+26 -7` 行）が混ざるが、
  検証専用なので無害。**マージしない限り fork main は書き換わらない。**

---

## 5. upstream のコントリビュート手順

### 5-1. ドキュメント

| 項目 | 有無 | 内容 |
|---|---|---|
| `CONTRIBUTING.md` | **あり** | **依存パッケージのクールダウン運用のみ。** `.npmrc` の `min-release-age=7` と `.github/dependabot.yml` の `cooldown`、npm 11.10+ 要件、緊急パッチ時の例外手順。**PR の出し方・レビュー体制・コーディング規約・コミットメッセージ規約の記載は無い** |
| PR テンプレート | **無し** | `.github/pull_request_template.md` / `.github/PULL_REQUEST_TEMPLATE/` / ルート / `docs/` のいずれにも存在しない |
| Issue テンプレート | あり | `bug_report.yml` / `feature_request.yml` / `config.yml` |
| `.coderabbit.yaml` | あり | `inheritance: false`。レビュー観点は repository UI 設定側に置く運用（`4cea084` のコメント是正で明文化） |

→ **PR の体裁に関する upstream の明文規定は無い。** fork 内 PR（#1〜#24）と同じ体裁
（日本語・`type(scope): 要約` のコミットメッセージ・`CHANGELOG.md` 更新）で問題ない。
CodeRabbit のレビューは repository UI 設定で有効なので、fork と同様に自動レビューが付く。

### 5-2. CI — **fork からの PR でもそのまま回る**

| workflow | トリガー | secrets 依存 | fork PR で動くか |
|---|---|---|---|
| `ci.yml` | `push: [main]` / `pull_request: [main]` | **無し** | **動く**。typecheck / gen:types / banned-patterns（`new Date` 検出）/ Oxlint / Biome / `npm test` / `npm run test:coverage` |
| `security.yml` | `push: [main]` / `pull_request: [main]` / 週次 | **無し**（gitleaks はライセンスキー不要のバイナリ直実行に固定済み） | **動く**。`npm audit --audit-level=high` + gitleaks |
| `e2e.yml` | `workflow_dispatch` / 週次 cron のみ | 無し | **PR では動かない**（設計どおり。flaky 回避のため） |
| `bitbank-api-docs-drift.yml` | 週次 cron / `workflow_dispatch` | `secrets.GITHUB_TOKEN` | PR では動かない |
| `release.yml` | `push: tags:['v*']` / `workflow_dispatch` | `secrets.GITHUB_TOKEN` | PR では動かない |

**結論: `tjackiet:<branch> → bitbankinc:main` の PR では `ci.yml` と `security.yml` が
base リポジトリ側で実行され、secrets を必要としないため fork 由来でも完走する。**
「動作確認は fork 内のローカル実行だけが頼り」という状況にはならない。

補足 2 点:

- **fork へ push しただけでは CI は発火しない。** どちらの workflow も
  `push: branches:[main]` / `pull_request: branches:[main]` に限定されており、
  `workflow_dispatch` も持たない。fork の feature ブランチへの push は対象外。
  fork 内で CI を回すには fork の main を base にした PR を開く必要がある（§4-3）。
- **初回コントリビュータの場合、base リポジトリ側で workflow 実行の承認が要ることがある**
  （GitHub の Actions 設定依存。upstream 側の設定は本調査の範囲外）。
- カバレッジ閾値は `vitest.config.ts` で statements/lines/functions 80%・branches 70%。
  view 作業は新規テストを 1,221 行追加しているため、閾値割れのリスクは低い。

---

## 付録: 本調査で使ったコマンド

```bash
# upstream は public。通常の環境ではこの URL をそのまま使う
# （本調査ではサンドボックスのセッションローカルな git プロキシ経由。「計測条件」の注記を参照）
git remote add upstream https://github.com/bitbankinc/bitbank-lab-mcp.git
git fetch upstream

git merge-base main upstream/main                      # → 2c28e03 (= tag v0.2.1)
git diff --stat main upstream/main                     # → 4 files, +26 -7
git diff --name-only main upstream/main -- .github/    # → 空（完全一致）
git cherry -v main upstream/main
git ls-remote --tags upstream                          # → v0.2.0 / v0.2.1 / v0.3.0 / v0.3.1
git ls-remote --tags origin                            # → 0 件

# 衝突の実測（in-memory。ブランチ・ワークツリーとも不変）
git merge-tree --merge-base=f646835 upstream/main HEAD

# upstream 側コードの直接確認
git show upstream/main:tools/get_flow_metrics.ts
git grep -n '"version"' upstream/main -- ':(top)*.json'
```

## 関連

- 設計: `docs/internal/view-vocabulary-unification.md`（§1-3 の `compact` 行は要訂正 — §3-3）
- 規約: `.claude/rules/tools.md`（view の規約。upstream にも同ファイルが存在する）
- view 作業の起点: `f646835`（fork PR #17 のマージ）。fork main からここまでの 47 commit は view と無関係な前段作業（view 作業本体は以降の 27 commit）
- 上流の該当コミット: `31a8480`（= `v0.3.1`。`serverInfo.version` の drift 解消）
