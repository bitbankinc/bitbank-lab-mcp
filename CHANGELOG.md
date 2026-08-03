# Changelog

本プロジェクトの主な変更履歴です。
形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠しています。

---

## [Unreleased]

### Fixed
- **重い `view` が軽い `view` の上位集合になっていなかった問題を修正（`content` は増える方向のみ変わる）。** `get_flow_metrics` の `view=buckets` / `view=full` は上流 `res.summary` を捨てて短いヘッダを組み直しており、`view=summary` / `view=compact` にあった**最終約定価格・スパイク上位 3 件の詳細・4 行フッタ**（含まれるもの / 含まれないもの / 補完ツール / 加工契約）が上位 `view` でだけ消えていた。同様に `get_volatility_metrics` の `view=detailed` / `view=full` では 4 行フッタ（含まれるもの / 含まれないもの / ATR の定義 / 補完ツール）が消えていた。`content[0].text` は LLM への唯一のチャネルなので、これは「表示が変わる」ではなく「LLM が情報を失う」に等しい。
- `get_flow_metrics(buckets/full)` を `res.summary` ベースに変更（バケット行の直前に置く `PAIR Flow Metrics (bucketMs=…)` / `Totals:` の 2 行ヘッダは従来どおり）。取得層の warning 行は `res.summary` が既に含むため、ヘッダ側には重ねない。`get_volatility_metrics(detailed/full)` はフッタ文言を `VOLATILITY_METRICS_FOOTER`（`tools/get_volatility_metrics.ts`）に単一ソース化して維持するようにした。**既定 `view` の応答が変わるツールは無い**（`get_flow_metrics` の既定は `summary`、`get_volatility_metrics` の既定は `summary`。どちらも元からフッタを持つ）。
- 併せて `tests/view-content-superset.test.ts` を新設。**文字列長の比較は使わない**（フッタが落ちても明細が増えれば通ってしまう）——定型要素（`📌` フッタ行 / `⚠️`・`ℹ️` 注記行 / ヘッダ主要フィールド）とバケット行の識別キーの**集合包含**で検証する。階梯外の `beginner` / `debug` は「出力の置換」なので対象外であることもテストで固定した。
- **`get_flow_metrics` の `view` が `structuredContent` の契約を変えていた問題を修正。`view` は `content` だけを変え、`structuredContent` からフィールドを削らないことを契約にした。** 従来 `view=summary` は `data.series.buckets` を**キーごと削除**しており、同フィールドを必須で宣言する `GetFlowMetricsDataSchemaOut` を満たさない `structuredContent` を返していた（ハンドラ加工後に再 parse していなかったため実行時に露見していなかった）。`view=compact` も同様に、宣言上は全バケットのはずが非ゼロだけの部分集合になっていた。**修正により `view=summary` / `view=compact` でも `series.buckets` に全バケットが入る。** `content` の絞り込み（`summary` はバケット行なし / `compact` は非ゼロのみ）は従来どおりで、**全 `view` について `content` は 1 バイトも変わらない**。
- 削除の動機はトークン削減だったが、LLM は `structuredContent` を参照しない（`.claude/rules/tools.md`）ため削減量はゼロで、非 LLM クライアントの契約だけが壊れていた。再発防止としてハンドラ出口で `GetFlowMetricsOutputSchema.parse()` を通し、以後 `view` 分岐が `structuredContent` を加工したら CI で落ちるようにした。併せて `tests/view-structured-content-invariance.test.ts` を新設し、`get_flow_metrics` / `get_transactions` / `get_volatility_metrics` は全 `view` で deep-equal、`detect_patterns` / `detect_macd_cross` は「足すだけ（削らない）」を横断的に固定した。
- MCP プロンプト「中級：BTCのフロー分析をして」が `get_flow_metrics` に存在しない `view=detailed` を指示していた問題を修正（`view=compact` に差し替え）。同ツールの enum は `summary` / `compact` / `buckets` / `full` で、SDK v2 はハンドラ実行前に `inputSchema` で入力を検証するため、指示どおり呼ぶと validation error になっていた。差し替え先を `compact` にした根拠は、当該プロンプトの用途（CVD 推移・スパイク・直近 1-3 時間重視、`limit=300` / `bucketMs=60000` ＝ 最大約 300 バケット）に対し `full` は 300 行で重く、`buckets`（既定 10 件）は CVD 推移を見るには短いため。
- 併せて `tests/prompts_contract.test.ts` に、全プロンプトのツール呼び出し例が指示する `view` が各ツールの Zod enum で受理されるかを静的に突き合わせる検査を追加。プロンプトはテストで実行されないため、この種の不整合は従来どのテストにも掛からなかった。
- MCP `initialize` が返す `serverInfo.version` を `package.json` の値に統一。`src/server.ts` が `'0.4.2'` をハードコードしており、`package.json` / 各プラグインマニフェスト（`.claude-plugin` / `.codex-plugin` / `.cursor-plugin` / `gemini-extension.json`）の `0.1.1` と乖離したまま、クライアントに誤ったバージョンを申告していた。`createRequire(import.meta.url)` で `package.json` を単一ソースとして読むようにし、以後リリース時に取り残されないようにした（`bin/bitbank-lab-mcp.js` と同じ解決方式）。併せて `tests/server_smoke.test.ts` の期待値をリテラルから `package.json` 参照に変更し、同種の drift をテストで検知できるようにした。

### Changed
- **`get_volatility_metrics` の実現ボラ `rv_std` / `rolling[].rv_std`（および年率換算 `rv_std_ann`）が母集団分散(n) から標本分散(n-1, Bessel 補正)ベースに変わったため出力数値が変化する。破壊的変更ではない**（型・フィールド・契約は不変、同一データで `rv_std` が僅かに大きくなるのみ）。上振れ幅は**小窓ほど大きく**、aggregate は標準 limit=200 で約 +0.25%、rolling は w=14 で約 +3.78%、w=20 で約 +2.60%、w=30 で約 +1.71%。
- 上記に伴い `volatile`(≥0.8) / `calm`(≤0.3) 判定閾値および下流参照（`getVolatilityMetricsHandler` の `high_vol`/`low_vol`/`expanding_vol`/`contracting_vol`/`high_short_term_vol`、`analyze_market_signal` の `volatilityFactor` / `recommendedTimeframes`）の閾値を**再評価のうえ据え置き**。根拠: 閾値は全て年率実現ボラを基準に判定しており、(a) aggregate ベースの閾値は標本数が大きく Bessel 補正が無視可能（最小 20 本でも +2.74%）、(b) `expanding/contracting_vol` の short/long 比は Bessel 係数が相殺し残差が ±5% 中立バンド内、(c) `high_short_term_vol` の最大上振れ（w=14, +3.78%）もヒューリスティックな許容範囲内のため、いずれも判定境界を実質的に跨がない。volatile/calm の閾値は `VOLATILE_RV_ANN_THRESHOLD` / `CALM_RV_ANN_THRESHOLD` 定数として明示し、判定を純粋関数 `classifyRealizedVolTags` に集約した（挙動は不変）。

### Security
- `run_backtest` の `savePng: true` 時の `outputDir` を許可 root 配下のみに制限（`/mnt/user-data/outputs`・サーバー作業ディレクトリ配下、および環境変数 `BACKTEST_OUTPUT_DIR_ALLOWLIST` で運用側が追加した root）。許可外パスはバックテスト実行前にエラーを返す。判定は `..`・シンボリックリンクを解決した実パスで行うためトラバーサル・symlink では迂回できない。**既定設定の動作は不変**で、許可外ディレクトリへ出力していた場合のみ環境変数での明示許可が必要（#15）。
- チャートファイル名生成（`generateBacktestChartFilename`）に、パス区切り・ドット等を除去する防御的サニタイズを追加。ファイル名の安全性を上流の pair バリデーションに依存させないための多層防御（#15）。

### Schema (breaking)
- `GetOrderbookDataSchemaOut` を `{ raw, normalized }` 固定の object から `z.discriminatedUnion('mode', [Summary, Pressure, Statistics, Raw])` に変更。実装 (`tools/get_orderbook.ts`) は元々 mode 別に完全に異なる shape の `data` を返していたが、スキーマ側が追従していなかったため `z.infer<typeof GetOrderbookDataSchemaOut>` を消費する外部クライアントには契約不一致だった。これに合わせて `data.mode` を必須の discriminator として明示。`get_orderbook` 末尾で `GetOrderbookOutputSchema.parse()` 経由のリターンに切り替え、スキーマ drift が CI で検出されるようにした。
- 併せて `GetOrderbookMetaSchemaOut` の `count`（実装で一度もセットされていなかった）を削除し、実装で実際に常設している `mode` を必須フィールドに追加。
- `get_orderbook` statistics mode の `ranges[].ratio` を `number | null` に変更（旧: `number`、その後一時的に `number | Infinity`）。`askVolume === 0 && bidVolume > 0` のとき `Infinity` を返していたが `JSON.stringify(Infinity)` が `null` になり MCP wire format と乖離するため、実装側 (`tools/get_orderbook.ts` `buildStatistics`) で `null` に正規化。「買い優勢 / strong / 売り板=0 で算出不能」の意味は `interpretation` / `summary.overall` / `summary.strength` / `content` テキストで保持する。schema は `z.number().nullable()`。

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
