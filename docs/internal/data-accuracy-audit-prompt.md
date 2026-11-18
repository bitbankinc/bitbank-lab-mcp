# データ正確性診断プロンプト（取得・加工系）

公開市場データの 3 層（取得層 → 計算層 → 提示層）を診断するときの再利用プロンプト。
「共通フレーム」に、診断したい層のチェックリストを 1 つ添えて投げる。

運用ルール（このファイル自体の陳腐化防止）:

- **行番号・具体的な閾値・既知バグの列挙を書かない**。位置はシンボル名（関数・schema・テスト名）で、
  期待値は「コードを一次ソースに境界の両側を probe で実測」で指定する。
- **過去の診断で修正済みの項目を再掲しない**。気になる既知問題は、先に
  `git log -S'<キーワード>'` で解消済みかを確認してから書く。
- 診断で新設した probe（`tests/*_audit_probe.test.ts`）は回帰テストとして残し、次回の監査資産に加える。

---

## 共通フレーム

```
あなたはこの MCP サーバのデータ正確性を診断する。対象は「取得・加工系」ツール。

【スコープ】公開市場データの 3 層（取得層→計算層→提示層）。
  取得層: get_ticker / get_tickers_jpy / get_orderbook / get_transactions / get_candles / lib/get-depth
  計算層: analyze_indicators / analyze_*_snapshot / detect_* / get_volatility_metrics / get_flow_metrics
  提示層: prepare_chart_data / prepare_depth_data / 各 build_*_text / handler の content
  ※手数料・ポートフォリオ（private）は対象外（必要なら別モジュール）。

【証拠ハーネス】指摘は必ず再現可能にする。空中戦（推測のみ）を禁止する。
  - 既存監査資産を起点にする:
      tests/market_data_audit.test.ts（NaN/Infinity・JSON往復・timestamp fallback・content可視性）
      tests/acquisition_audit_probe.test.ts / tests/calc_audit_probe.test.ts /
      tests/presentation_audit_probe.test.ts（過去診断の回帰 probe）
      tests/warning-propagation.test.ts / tests/mid-rounding-consistency.test.ts
      tests/view-content-superset.test.ts / tests/view-structured-content-invariance.test.ts
      tools/validate_candle_data.ts + lib/candle-validate.ts / tests/fixtures/
  - 確認は `npx vitest run <対象層の既存テストと新設 probe>` を実行し、コマンドと出力を引用する。
  - 仕様の一次ソースは docs/internal/bitbank-candle-tz.md（TZ実測ログ）と各 .claude/rules/*.md。

【根拠の様式】各指摘に: ①該当シンボル（file:関数/schema 名） ②実行コマンド ③観測した出力/エラー。
  実行できない/コードからだけの推論は「推測」、根拠不足は「要追加確認」と明記。断定しない。
  未修正と判断する前に `git log -S` で解消済みでないか確認する。

【出力】層ごとに: 確認済みの問題 / 推測 / 要追加確認 / 修正案（コードは出すが適用しない）。
最後にデータ正確性リスクスコア(0-100)と、最もリスクの高い上位3件を挙げる。
```

---

## 取得層チェックリスト

```
取得層を診断する。raw bitbank API → normalized の変換忠実性。

A. API変換: 数値化が lib/conversions.ts の toNum 経由か（散在 Number()/parseFloat の検出）。
   null / "" / 空白のみ / "abc" / 非有限 / 非 string 要素 / 行 shape（要素数・非配列）の扱い。
B. 非有限値 wire 安全性: 出力に NaN/Infinity が乗らないか（findNonFiniteNumbers パターン）。
   ゼロ除算（分母 0 の比率）が null 正規化されるか。
C. timestamp: 上流欠損を Date.now() で代用していないか。観測時刻（timestamp）と
   受信時刻（fetchedAt）の分離。0 / 負 / NaN の扱いがツール間で対称か（drop + warning か upstream fail）。
D. 日付/TZ境界: 「UTC key fetch → tz 暦日 anchor filter」の二段構え。anchor が tz 暦日終端か。
   sub-day の隣接 UTC 日 key・年跨ぎ・DST・実在しない日付の繰り上げ。
   isoTime=UTC 固定と isoTimeLocal / keyPoints.date=tz の使い分け。
E. OHLCV取得: 昇順ソート・同 ts dedupe（プレースホルダ優先規則）・anchor filter と slice(-limit) の順序・
   multi-chunk の full/majority/partial 失敗分類と fetchWarning。不正行の検出が limit 窓に依存しないか。
F. ok/fail分類: NaN行/success:0 → upstream、404・未来日・開始前 → user。network と混同しないか。
   ok 経路の schema violation が catch に落ちて network に誤分類されないか。
G. content可視性: 件数・期間・📸 時刻・drop 件数・warning が content[0].text に出るか。
   format/view の代替出力でも落ちないか。
```

## 計算層チェックリスト

```
計算層を診断する。normalized → 指標/統計の計算正確性。

A. 指標の期間/初期null/NaN: 先頭 period-1 の null 化。非有限入力の扱いが全指標で対称か
   （窓 NaN→NaN 系と リセット→period 連続有限で再シード系のどちらかに揃っているか。
   累積系は carry-forward）。RSI/ATR が Wilder 平滑か（golden 固定テストと照合）。
   シフト系（遅行スパン等）の方向と端の NaN。クロス判定のタイ値仕様（厳密不等号）とその帰結。
B. 必要本数 warnings: buildWarnings の閾値が lib の実要求本数と一致するか。
   具体値はコードを一次ソースに、境界の両側（N-1 本 / N 本）を probe で実測する。
C. warnings 伝播: 取得層 meta.warning と計算層 meta.warnings の 2 系統分離。
   lib/warning-propagation.ts 経由か（自前連結禁止）。キャッシュ entry に upstream warning が
   保存され cache hit でも消えないか。
D. 丸め: 計算は丸めず（lib/indicators.ts は丸め禁止が規約）、丸めは表示/出力境界のみか。
   分散の母集団/標本が用途と一致するか（lib/math.ts の sample opt-in の使い分け）。
E. 形成中の足: 最新足が未確定のとき provisional 判定と注記（lib/provisional-bar.ts）が出るか。
   判定が cache に乗っていないか（now 依存のため毎回判定）。
F. 決定性: 同一入力→同一出力。計算パスに Date.now()/乱数が無いか（メタデータ・注記は除く）。
```

## 提示層チェックリスト

```
提示層を診断する。data → LLM が読む content / 表示の忠実性。

A. content 可視性（最重要）: handler が data を content[0].text に含めるか。
   ok(summary,data,meta) の素返しは summary 自体がデータを運ぶ場合のみ可（.claude/rules/tools.md）。
   加工ツール全数で上流 meta.warning の伝播漏れが無いか。view 代替ビューでも warning 行が消えないか。
B. 基準時刻: latest 系（ticker/板）と history 系（candles）を併用するツールが、
   観測時刻を content に出すか。「最新値の時刻」と「最終足の時刻」の取り違え。
   キャッシュを持つツールはヒットを開示するか。
C. ツール間整合: 同じ量が 2 経路で一致するか（mid/spread・volume・価格レンジ）。
   共有丸め関数（lib/price.ts）と整合テスト（mid-rounding-consistency 等）の有無。
   無い量は fee-source-consistency.test.ts を範に新規テスト案を出す。
D. 単位・ラベル: 単位が pair から導出されるか（特定通貨の決め打ち禁止）。
   % の 0-1↔0-100（名前が Pct の値の実単位）。桁丸めで小さい値が 0 に潰れる表示が無いか。
   通貨サフィックス（円/JPY/base通貨）と k/億/万 の桁。
E. JSON往復: content/structuredContent が stringify→parse 後も schema parse 成功・意味不変か
   （market_data_audit の assertRoundTrip パターン。加工ツールも対象に含める）。
```
