# Changelog

本プロジェクトの主な変更履歴です。
形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠しています。

---

## [Unreleased]

### Fixed（欠損バケットの扱い）
- **`get_flow_metrics` のバケットで「約定ゼロ」と「データなし」が区別できるようになった**。バケット分割は欠損区間をゼロ埋めするため、旧実装では `totalVolume: 0` のバケットが「その1分間に約定が無かった」のか「その区間を取得できていない」のか応答から判別できなかった。`FlowBucketSchema` に `hasData`（boolean, 必須）を追加し、欠損区間に完全に含まれるバケットを `false` でマークする。`view=compact` は従来「非ゼロバケットのみ」でフィルタしており**欠損区間が黙って消えていた**が、欠損バケットは残すようにした（content テキストでは連続分を `⋯ 欠損 HH:MM〜HH:MM（Nバケット, データなし）` の 1 行に畳む）。
- **Z スコア / スパイク判定の母集団から欠損バケットを除外**。旧実装は欠損区間のゼロ埋めを観測値として平均・分散に含めており、平均が押し下げられて**欠損明けの通常バケットが偽スパイクとして検出されていた**。全バケットが同一出来高のフィクスチャで、欠損明けバケットの Z スコアが 0.13 → 0.72（約5.5倍）に膨らみ `spike=warning` が誤検出されることを確認済み。欠損バケットの `zscore` / `spike` は `0` や負値ではなく `null`（観測が無い区間に Z スコアは定義できない）。
- **`analyze_market_signal` の CVD 傾きが欠損バケットを観測として扱っていた問題を修正**。欠損バケットは CVD が据え置きで引き継がれるため、直近 `horizonBuckets` 本が全て欠損だと傾き 0 ＝「フロー中立」と読まれていた（進行中 UTC 日の欠損区間が長い JST 夕方以降に発生しうる）。観測のあるバケットのみを対象にする。

### Added
- **`get_flow_metrics` / `analyze_volume_profile` にカバレッジ申告を追加**: `get_flow_metrics` の `meta.actualRange` に `coveredMinutes`（実データがある区間の合計）/ `gapMinutes` / `segments` / `requestedMinutes` / `coveragePct` / `gaps`（欠損区間を長い順に最大 3 件）を追加。`analyze_volume_profile` の `data.params.timeRange` にも `coveredMin` / `gapMin` / `segments` / `requestedMin` を追加。既存の `durationMinutes` / `durationMin` は**先頭〜末尾のスパン**（欠損区間を含む）の意味のまま残し、単独では出さず必ず実カバー時間と並記する。欠損の事実は取得層 `meta.warning`、「集計値がカバー区間のみ由来」は計算層 `meta.warnings` に分けて載せる（`.claude/rules/tools.md` の 2 系統ルール）。
- **`getTransactions` に内部呼び出し用オプション `{ unlimited: true }` を追加**（`GetTransactionsOptions`）。`limit` を適用せず取得・正規化した全件を返す。集計ツール専用の経路で、MCP public ツールとしての応答上限（1000 件）は変更していない。
- **`lib/tx-fetch.ts`**: `get_flow_metrics` / `analyze_volume_profile` に重複していた約定取得層を集約（`mergeTxResults` / `txDedupKey` / `sortTxsAsc` / `fetchTxTimeRange` / `fetchLatestTxs` / `fetchSupplementTxs` / `formatTxFailures` / `partialFailureWarning` / `computeTxCoverage`）。失敗ハンドリングの方針（全滅 fail / 過半数 fail / 部分失敗 warning）は `lib/candle-fetch.ts` と同じくツール側に残し、lib は判定材料を返すに留める。上流 fetch は `TxFetcher` として注入し、lib が `tools/` に依存しないようにした。
- **`get_transactions` に切り捨て（truncation）メタデータを追加**: `meta.totalFetched`（取得全件数・不正行 drop 除外後）/ `matched`（フィルタ後件数）/ `returned`（返却件数）/ `truncated`（limit による切り捨て発生）/ `actualRange`（返却ウィンドウの実カバー範囲・Asia/Tokyo）/ `fetchedRange`（取得できた全約定の範囲）。切り捨て発生時は `meta.warning` と content テキスト（約定行列挙より前）で明示され、「該当期間に約定がなかった」と「limit で切れた」が応答上区別可能になった。

### Fixed
- **`get_flow_metrics` / `analyze_volume_profile` の集計が全件ベースになった（内部取得の 1000 件キャップ解除）**。両ツールは内部で `getTransactions(pair, 1000, date)` を UTC 日ごとに呼んでおり、BTC/JPY の 1 UTC 日は実測 5,609〜8,040 件あるため**各日の末尾 1000 件（≒4〜5 時間分）しか集計に入っていなかった**。CVD・アグレッサー比・VWAP・POC・Value Area・約定サイズ分布が全て切り捨て後サンプル由来だったうえ、その事実が出力のどこにも現れなかった。解除の根拠は (a) 出力がバケット集計・プロファイル集計なので**トークン増加はゼロ**、(b) `getTransactions` は元々レスポンス全件をパースしており `limit` は最後の `slice` でしか効いていない（キャップは応答サイズ制限であってフェッチ制限ではない）ため**通信量も不変**、(c) メモリも 1 日 8 千行程度。`hours` 指定時の `limit`（`GetFlowMetricsInputSchema` は最大 2000）も、従来は上流キャップにより 1000 を超えられなかったが要求どおり満たせるようになった。
- **`get_flow_metrics` の `meta.actualRange.durationMinutes` が欠損区間をカバー済みとして申告していた問題を修正**。先頭〜末尾の単純差分だったため、JST 17:30 時点の `hours=24` では「直近約763分間分」と申告する一方、実データがあるのは約 5 時間分だけだった。実データのある区間をセグメント化して実カバー時間・欠損時間・欠損区間を出すようにした（無約定 5 分超をギャップと判定。BTC/JPY の平均約定間隔は 11〜15 秒）。
- **`hours` 指定時の「ℹ️ 取得できた約定は直近約N分間分です。…直近フローとして扱ってください」注記を削除**。この文言は変えられない制約（進行中 UTC 日は latest 約60件のみ取得可能）と、直せる制約（アーカイブ側の 1000 件切り捨て）を同じ言い方で覆い隠していた。後者はキャップ解除で解消したため、残る欠損を実測値（要求窓 / 実カバー / 欠損区間の時刻）で出す。進行中 UTC 日のカバレッジ制約 warning は従来どおり出る。
- **`get_transactions` の「補完ツール: get_flow_metrics」の記述が誤誘導になっていた問題を修正**。実機テストで、`get_transactions` の切り捨てを正しく検出した LLM が代替手段として「`get_flow_metrics` は件数制限の影響を受けにくい」と案内したが、旧実装では同じキャップを共有していたため誤りだった。キャップ解除により正しい代替手段として成立するようになり、footer と truncation warning にその旨を明記した。
- **`analyze_market_signal` が上流 `get_flow_metrics` の `meta.warnings`（計算層）を落としていた問題を修正**。従来は `analyze_indicators` の `warnings` のみ継承していた。あわせて `warnings` にも `meta.warning` と同じ `[flow] / [indicators]` prefix を付け、由来を追えるようにした。
- **`get_flow_metrics` / `analyze_volume_profile` の件数ベース取得で `limit` を全パスで明示適用**。従来は上流キャップに依存して暗黙に効いていたため、キャップ解除に伴い明示した（`limit` の意味は不変）。
- **`analyze_volume_profile` の価格レンジ算出を `Math.min(...prices)` からループに変更**。スプレッド引数が数万件になると RangeError になり得るため（キャップ解除で 1 UTC 日 8,000 件超を扱うようになった）。

### Changed
- **`get_transactions` の `minAmount` / `maxAmount` / `minPrice` / `maxPrice` フィルタを `limit` 適用前に移動**（filter → limit）。従来は「最新側 limit 件を取り出してから絞る」ため条件を絞るほどカバー期間が縮み、date 指定時は UTC 日アーカイブ（約 8,000 件超）の末尾 limit 件しかフィルタ対象にならなかった（直近 24 時間の大口約定分析で約 11 時間分が無警告欠落する実害）。現在は「条件に合致した約定を最新側優先で最大 limit 件」返す。フィルタはコア関数の第 4 引数（`GetTransactionsFilters`）に移動し、フィルタ未指定の内部呼び出し（`get_flow_metrics` / `analyze_volume_profile` 等）は挙動不変。
- **`get_volatility_metrics` の実現ボラ `rv_std` / `rolling[].rv_std`（および年率換算 `rv_std_ann`）が母集団分散(n) から標本分散(n-1, Bessel 補正)ベースに変わったため出力数値が変化する。破壊的変更ではない**（型・フィールド・契約は不変、同一データで `rv_std` が僅かに大きくなるのみ）。上振れ幅は**小窓ほど大きく**、aggregate は標準 limit=200 で約 +0.25%、rolling は w=14 で約 +3.78%、w=20 で約 +2.60%、w=30 で約 +1.71%。
- 上記に伴い `volatile`(≥0.8) / `calm`(≤0.3) 判定閾値および下流参照（`getVolatilityMetricsHandler` の `high_vol`/`low_vol`/`expanding_vol`/`contracting_vol`/`high_short_term_vol`、`analyze_market_signal` の `volatilityFactor` / `recommendedTimeframes`）の閾値を**再評価のうえ据え置き**。根拠: 閾値は全て年率実現ボラを基準に判定しており、(a) aggregate ベースの閾値は標本数が大きく Bessel 補正が無視可能（最小 20 本でも +2.74%）、(b) `expanding/contracting_vol` の short/long 比は Bessel 係数が相殺し残差が ±5% 中立バンド内、(c) `high_short_term_vol` の最大上振れ（w=14, +3.78%）もヒューリスティックな許容範囲内のため、いずれも判定境界を実質的に跨がない。volatile/calm の閾値は `VOLATILE_RV_ANN_THRESHOLD` / `CALM_RV_ANN_THRESHOLD` 定数として明示し、判定を純粋関数 `classifyRealizedVolTags` に集約した（挙動は不変）。

### Security
- `run_backtest` の `savePng: true` 時の `outputDir` を許可 root 配下のみに制限（`/mnt/user-data/outputs`・サーバー作業ディレクトリ配下、および環境変数 `BACKTEST_OUTPUT_DIR_ALLOWLIST` で運用側が追加した root）。許可外パスはバックテスト実行前にエラーを返す。判定は `..`・シンボリックリンクを解決した実パスで行うためトラバーサル・symlink では迂回できない。**既定設定の動作は不変**で、許可外ディレクトリへ出力していた場合のみ環境変数での明示許可が必要（#15）。
- チャートファイル名生成（`generateBacktestChartFilename`）に、パス区切り・ドット等を除去する防御的サニタイズを追加。ファイル名の安全性を上流の pair バリデーションに依存させないための多層防御（#15）。

### Schema (breaking)
- `GetOrderbookDataSchemaOut` を `{ raw, normalized }` 固定の object から `z.discriminatedUnion('mode', [Summary, Pressure, Statistics, Raw])` に変更。実装 (`tools/get_orderbook.ts`) は元々 mode 別に完全に異なる shape の `data` を返していたが、スキーマ側が追従していなかったため `z.infer<typeof GetOrderbookDataSchemaOut>` を消費する外部クライアントには契約不一致だった。これに合わせて `data.mode` を必須の discriminator として明示。`get_orderbook` 末尾で `GetOrderbookOutputSchema.parse()` 経由のリターンに切り替え、スキーマ drift が CI で検出されるようにした。
- 併せて `GetOrderbookMetaSchemaOut` の `count`（実装で一度もセットされていなかった）を削除し、実装で実際に常設している `mode` を必須フィールドに追加。
- `get_orderbook` statistics mode の `ranges[].ratio` を `number | null` に変更（旧: `number`、その後一時的に `number | Infinity`）。`askVolume === 0 && bidVolume > 0` のとき `Infinity` を返していたが `JSON.stringify(Infinity)` が `null` になり MCP wire format と乖離するため、実装側 (`tools/get_orderbook.ts` `buildStatistics`) で `null` に正規化。「買い優勢 / strong / 売り板=0 で算出不能」の意味は `interpretation` / `summary.overall` / `summary.strength` / `content` テキストで保持する。schema は `z.number().nullable()`。
- `GetTransactionsDataSchemaOut` から `raw` を削除。date 指定時に全 UTC 日分（約 8,000 件超）の生レスポンスが `structuredContent` に毎回同梱され、`limit` の意義を無効化していた。transactions の `data.raw` を参照する消費者がリポジトリ内に存在しないことは確認済み。あわせて `GetTransactionsMetaSchemaOut` に truncation メタ（`totalFetched` / `matched` / `returned` / `truncated` は必須、`actualRange` / `fetchedRange` は optional）を追加。
- `AnalyzeVolumeProfileDataSchemaOut` の `params.timeRange` に `coveredMin` / `gapMin` / `segments` を**必須**で追加（`requestedMin` は optional）。`data.params.timeRange` を消費する外部クライアントは新フィールドを受け取る（既存の `start` / `end` / `durationMin` は不変）。
- `FlowBucketSchema` に `hasData`（boolean）を**必須**で追加。`false` は「約定ゼロ」ではなく「取得できていない（欠損区間）」を意味する。`data.series.buckets` を消費する外部クライアントは新フィールドを受け取る（既存フィールドは不変）。あわせて `view=compact` の返却バケットに欠損バケットが含まれるようになった（従来は黙って除外されていた）。
- `GetFlowMetricsMetaSchemaOut.actualRange` を `TxCoverageRangeSchema` に差し替え（`coveredMinutes` / `gapMinutes` / `segments` が必須、`requestedMinutes` / `coveragePct` / `gaps` が optional）。既存の `start` / `end` / `durationMinutes` は不変。あわせて計算層用の `warnings`（`string[]`, optional）を追加。

## [0.1.1] - 2026-05-08

### Fixed
- bin スクリプトが `tsx` を resolve する際に CWD ではなく自身の場所を起点にするよう修正（`npx -y bitbank-lab-mcp` 経由で起動した際に `Cannot find package 'tsx'` エラーになっていた問題）。

## [0.1.0] - 2026-05-08

### Added
- 初の npm publish（[`bitbank-lab-mcp`](https://www.npmjs.com/package/bitbank-lab-mcp)）。インストールは `npx -y bitbank-lab-mcp` で完了。
- Claude Code / Cursor / Codex / Gemini CLI 向けの plugin manifest 4 種を同梱（`.claude-plugin/plugin.json` / `.cursor-plugin/plugin.json` / `.codex-plugin/plugin.json` / `gemini-extension.json`）。
- `.claude-plugin/marketplace.json` を追加して Claude Code の `/plugin install` に対応。`/plugin marketplace add tjackiet/bitbank-lab-mcp` → `/plugin install bitbank-lab-mcp@bitbank-lab` で利用可能。
- Claude Code / Gemini CLI では plugin install 時に API キー入力 UI が表示される（OS キーチェーン or `.env` に保管）。Cursor / Codex はシェル環境変数経由。

### Changed
- パッケージ名を `@tjackiet/bitbank-mcp` から `bitbank-lab-mcp` に変更（公式版 `bitbank-mcp-server` との衝突を避け、botters lab コミュニティ向け実験版である位置付けを明示）。
- README を全面再構成。Claude Desktop でのセットアップを最上段に置き、サンプルコードはすべて公開済み npm パッケージ経由（`npx -y bitbank-lab-mcp`）に統一。`git clone` ベースの手順は末尾の「開発者向け」セクションに分離。
- API キーの権限ガイドを最小権限の原則に基づいて整理。「参照のみ」「参照 + 取引」の 2 段階を明示し、「出金」権限は強い禁止表現に変更（本 MCP には出金系ツール未実装）。
