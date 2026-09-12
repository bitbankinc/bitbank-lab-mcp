# Changelog

本プロジェクトの主な変更履歴です。
形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠しています。

---

## [Unreleased]

`detect_patterns` 系の変更は #114 を起点とする一連の作業で、下の表に時系列で載せる（番号が大きいほど新しい）。各行の判断根拠と計測の記録は fork（tjackiet/bitbank-lab-mcp）の各 issue と PR に残る。

### `detect_patterns`（#114 以降）

| # | issue | 変更 | 検出への影響 |
|---|---|---|---|
| 1 | #114 | **起点。** スキャン窓を `limit + 199` 本から直近 `limit` 本に一致させた。以降の「窓が狭い」系の問題はすべてここから派生する | 減る |
| 2 | #117 | 窓が構造上狭すぎるとき `limit_too_small_for_timeframe` を申告 | 変わらない |
| 3 | #119 | ツール description に検出の意味論を明記 | 変わらない |
| 4 | #120 | 検出器ごとの最小要求バー数を単一ソース化し、到達性を機械的に固定 | 変わらない |
| 5 | #121 | 閾値のプリミティブを日数からバー数に統一し、上限クランプを入れた | 変わる |
| 6 | #122 | 形成中 double / H&S の手書き `daysPerBar` を廃止しバー基準に統一 | 変わる |
| 7 | #123 | `limit` を**上げる**方向の使い分けをツール表面に明記 | 変わらない |
| 8 | #128 | `view=debug` の可観測性（#124）と pivot の価格基準の透明化（#125 前半）、用語の陳腐化（#127 の一部） | 変わらない |
| 9 | #131 | ダブルトップ / ボトムの構造ゲート、`status='expired'`、`include*` の独立化、実データ回帰 fixture | 変わる |
| 10 | #132 | ダブルボトムの偽陰性を 3 つの原因ごとに解消 | 増える |
| 11 | #135 | dedup の勝者選択を `statusScore` 最優先に揃えた | 変わる |
| 12 | #136 | 構造的ピボット間隔の床（`= 5`）の妥当性を実測で判定し据え置きを確定 | 変わらない |
| 13 | #137 | 三角形の分類前 candidate ラベルを umbrella 化（#129）、`limit=180` の判定と CI ジョブ名の注記（#127 の残り） | 変わらない |
| 14 | #139 | triple / H&S にサイズ検査を横展開（#138 欠陥 2-2） | 減る |
| 15 | #140 | triple / H&S に構造ゲートを横展開（#138 欠陥 2-1） | 減る |
| 16 | #141 | 三角形の外れ値除去に除去率の上限を入れた | 実データで**減る**（合成 fixture は変わらない） |
| 17 | #148 | H&S の窓生成から交互列要求を外した（#146） | 実データで**増える**（合成 fixture は変わらない） |
| 18 | #153 | H&S の `tolerancePct` が頭の突出率としても使われ意味が反転していたのを `headProminencePct` に分離（#149） | **変わらない**（既定値のまま） |
| 19 | #156 | 形成中 H&S / 逆 H&S の頭を窓全体の極値 1 点に決め打ちしていたのを総当たりに変えた（#154） | 合成 fixture は**変わらない** / 実データは窓を広げたときだけ**増える**（＝狭い窓で出ていたものが戻る） |
| 20 | #159 | 形成中 H&S / 逆 H&S の成功候補を `debug.candidates` に積む（#155） | **変わらない** |
| 21 | #161 | candidates の `status` / `breakoutDirection` を content と出力スキーマに届ける（#160） | **変わらない** |
| 22 | #164 | 完成済みウェッジの `status` / `breakoutDirection` が候補行に出ていなかったのを修正（#162） | **変わらない** |
| 23 | #166 | 形成中 double top / bottom・triple top / bottom の成功候補を `debug.candidates` に積む（#158。 | **変わらない** |
| 24 | #168 | サイズ検査の 2 定数（`MIN_DEPTH_PCT` / `MIN_PATTERN_HEIGHT_PCT`）を時間足別のテーブルにした（#152） | 合成 fixture は**変わらない** / 実データは 1day 未満の時間足で**増える**（+8 / 800。 |
| 25 | #170 | 形成中 double top / bottom のサイズ検査を完成済みと揃えた（#169） | 回帰コーパス（合成 704 + 実データ 96）は**変わらない**（0 / 800）/ 新 fixture では**減る** |
| 26 | #142 | 検出器内 dedup の勝者選択を `globalDedup` と同じ confidence 優先に揃えた | 実データ・合成とも**変わる**（48 / 800。 |
| 27 | #172 | `shoulders_not_near` を 2 つの conjunct ごとに分け、`HS_SHOULDER_MAX_PCT` の役割を docstring に書いた | **変わらない**（理由コード文字列と docstring のみ） |
| 28 | #174 | #172 の docstring が relaxed 経路について誤っていたのを訂正し、relaxed の肩落ちを `debug.candidates` に積む | **変わらない**（0 / 800） |
| 29 | #138 | triple の「同水準」判定に**高さ相対の hard gate**（`MAX_LEVEL_SPREAD_RATIO`）を足し、無音だった 3 点同水準の棄却を可観測化した | 実データで**減る**（−20 / 800。 |
| 30 | #180 | cap で切られた `debug.candidates` / `debug.swings` の総数と省略件数を申告する（cap の値もトリム戦略も変えない） | **変わらない**（0 / 800） |
| 31 | #182 | `swingDepth` / `tolerancePct` / `minBarsBetweenSwings` の description に**時間軸オートとスキーマ既定値の sentinel 置換**を明記した（`resolveParams` も `.default()` も触っていない） | **変わらない**（description のみ） |
| 32 | #184 | `meta.effective_params` が**出力スキーマ未宣言で毎回 strip されていた**のを宣言し、実効パラメータ行を全 view の `content` に出した。 | **変わらない**（`meta` / `content` のみ） |
| 33 | #187 | `MAX_VALLEY_SPREAD`（1.5%）を削除した（#178 項目 2）。 | **変わらない**（0 / 896） |
| 34 | #186 | strict triple のネックライン水平性が**同じ式を 2 つの名前で 2 回**測っていたのを `NECKLINE_SLOPE_LIMIT` 1 本に畳んだ。 | **変わらない**（0 / 896。既定パス）/ `tolerancePct < 0.02` を明示したときだけ**緩む** |
| 35 | #189 | relaxed / strict の provenance `patterns[]._fallback` が**出力スキーマ未宣言で毎回 strip され、一度もクライアントに届いていなかった**のを宣言した（#155 / #160 / #184 に続く 4 回目）。 | **変わらない**（検出結果は不変。消えていたフィールドが `structuredContent` に残るだけ） |
| 36 | #191 | `view=debug` に**棄却理由の集計ブロック**を出し（LLM の手集計が実測で外れていた）、`_fallback` の provenance を `content` に届け（#189 の残り半分）、`view` description の並び順の食い違いを実装に合わせた | **変わらない**（表示層と description のみ） |
| 37 | #193 | #191 / PR #192 が `view` description に持ち込んだ**実在しない理由コードの例 2 箇所**を実装に合わせ、集計ブロックに **reason 単独の横断合計行**を足した（横断合計で LLM が実測 2 回外していた） | **変わらない**（表示層と description のみ） |
| 38 | #178 | double の「同水準」判定に**高さ相対の hard gate** を足した（項目 4）。 | **変わらない**（0 / 896。現行コーパスでは 1 件も発火しない**潜在ガード**） |
| 39 | #200 | 縮小段（globalDedup / requireCurrentInPattern / ライフサイクル絞り込み）の件数内訳を `meta.reduction` と content 行に申告。 | **変わらない**（表示層のみ。`structureDiagram.svg` / `.artifact.title` を除き完全一致を回帰テストで固定） |
| 40 | #198 | `headProminencePct`（H&S / 逆H&S の頭の最小突出率）が未指定時に `tolerancePct` の時間軸オート表を誤って流用していたのを、専用の時間軸オート表（`getHeadProminenceForTf`）に切り離した | 実データ 1hour で**増える**（+4 / 14。 |
| 41 | #199 | triple の整合度から `symmetry`（= 1 − 最大 relDev。 | 実データで**減る**（−20 / 896。 |
| 42 | #208 | H&S / 逆 H&S の `breakoutTarget` の**高さ**を「ブレイク足時点の（外挿した）ネックライン」から「**頭の真下のネックライン**」に戻した。 | **変わらない**（0 / 896。`confidence` も全件不変。動くのは `breakoutTarget` / `targetReached` / `targetReachedPct` 系のみ） |
| 43 | #210 | `targetReachedPct` の 3 つの欠陥（到達側に上限が無い / 分母が潰れる / 走査が系列末尾まで無制限）を同時に直した。 | **変わらない**（1,456 行を全フィールド突き合わせて target **進捗**系以外は 0 行。 |
| 44 | #204 | H&S / 逆 H&S の整合度から `tolMargin` を捨て（`symmetry` と**同じ `relDev(左肩, 右肩)` 由来**で実質 2 軸だった）、`headProminence` / `timeSymmetry` / `retracement` / `breakoutQuality` を足して 6 軸平均にした。 | type 別の件数はほぼ不変 |
| 45 | #206 | `MIN_CONFIDENCE` から**どの検出器も読んでいなかった 4 エントリ**（`double_top` / `double_bottom` / `head_and_shoulders` / `inverse_head_and_shoulders`）を削除した。 | **変わらない**（940 ケース全件で `data.patterns` が完全一致） |
| 46 | #199 候補 2 | triple の期間スコア `duration` を**暦日基準から バー数基準**に移した（`periodScoreBars`）。 | **変わらない**（940 ケース全件で件数・構造キーとも一致。 |
| 47 | #218 Phase 2 | `triple_*` と H&S 系が**主構成点を 2 点以上共有**していたら triple を落とす型間排他を入れた。 | **減る**（940 ケースで `triple_bottom` −25 / 1,968 → 1,943。 |
| 48 | #216 Phase 2 | `triple_*` / `double_*` の**主構成点がすべてネックラインの正しい側にある**ことを要求する構造ゲートを入れた。 | **減る**（940 ケースで −60 / 1,943 → 1,883。 |
| 49 | #224 症状 2 | target 進捗を出さなかった**全経路**に理由コードを付けた。 | **変わらない**（940 ケース全件で `data.patterns` が完全一致。 |
| 51 | #228 | triple の**完成済み 4 経路**（strict / relaxed × top / bottom）に `computeTargetReach` を配線した。 | **判定は変わらない**（940 ケースで `detectTriples()` の 200 パターンが target 進捗系 5 キーを除いてバイト単位で完全一致。 |
| 50 | #224 症状 3 | `triple_*` の `pivots` に**ネックライン定義点 v1 / v2 を含めた**（完成済み 4 経路は 3 → 5 点、形成中 2 経路は 2 → 4 点。 | **判定は変わらない**（940 ケース全件で件数・`confidence` / `status` / `neckline` / `breakoutTarget` / `aftermath` / … |
| 52 | #227 Phase 2 | relaxed フォールバックの `headProminence` 軸を、**緩めた側のゲート**（`headProminencePct × factors.head`）ではなく **strict のゲート**で採点するようにした。 | **件数は変わらない**（1,248 ケースで延べ 4,070 → 4,070。 |
| 53 | #242 PR 1/2 | `double_*` の**完成済み 4 経路**に「最終構成点（山2 / 谷2）とネックライン突破バーの**間**に同種のピボットがあれば `invalid`」という経路検証を足した。 | 実データ C / D で**減る**（1,088 ケースで `double_top` 延べ −16（C・1 構造）/ −24（D・2 構造）。 |
| 54 | #242 PR 2/2 | 同じ経路検証を `triple_*` / H&S 系の**完成済み 4 経路ずつ**へ配線し、あわせて double にしかなかった**谷（山）ゾーン再進入チェック**（`detectTroughZoneReentry`）を triple / H&S へ横展開した（#131 → #138 の構造ゲート横展開から漏れていた分の回収） | 実データ C / D で**減る**（どちらの窓でも `head_and_shoulders` 延べ −56 / `triple_top` −12。 |
| 55 | #244 Phase 2 | H&S / 逆 H&S の**肩の同水準判定**を時間足別にした（`getHsShoulderMaxPctForTf`。 | `1day` 未満で**減る**（1,344 ケースで `inverse_head_and_shoulders` **構造単位で −23**。 |
| 56 | #261 | `validateMainPointsNecklineSide`（#216 Phase 2）を**形成中**の triple / double 4 経路へ配線した。 | 実データ 1hour で**減る**（12,104 ケースで accepted な形成中 triple が延べ 7,581 → 5,818 / 実体 48 → 43）。 |
| 57 | #263 | 形成中 triple の**単調性ゲートを両向き**にした（`triple_top` の切り下がり / `triple_bottom` の切り上がりが素通りしていた）。 | 実データ 1hour で**わずかに減る**（12,104 ケースで accepted な形成中 triple が延べ 5,818 → 5,763 / 実体 43 のまま）。 |
| 58 | #178 項目 1 | 形成中 triple への高さ相対ゲートは案 C（不採用）で決着。文書化のみ | **変わらない**（docstring / docs / 内部メモのみ。 |
| 59 | #262 Phase 1 | 形成中 double の「形成中」の定義が top / bottom で違う件の計測。コード変更なし | **変わらない**（計測スクリプトと内部メモのみ。 |
| 60 | #262 Phase 2 | double の「構造完成・ブレイク待ち」を `near_completion` で出すようにし、誤ラベルだった `tryFormingDoubleBottom` を削除した | 既定（`includeForming: false`）は 544 ケース全件で完全一致 |
| 61 | #268 Phase 1 | 形成中 `double_top` の左の山の探索を「パターン長」基準に変える ablation の計測。コード変更なし | **変わらない**（計測スクリプトと内部メモのみ） |
| 62 | #268 案 C | `tryFormingDoubleTop` を削除し、double は `forming` を持たないパターンにした | 既定（`includeForming: false`）は変わらない |
| 63 | #252 | `wedge_*` に `pivots`（構成点）を出すようにした | **判定は変わらない**（実データ 1hour の回帰 fixture 10 件を全フィールド突き合わせて、**差分は `wedge_*` 4 件に `pivots` が増えたぶんだけ**。 |
| 64 | #245 Phase 1 | 「ヒゲだけの山2（谷2）」が accepted に混ざるかの計測。コード変更なし | **変わらない**（計測スクリプトと内部メモのみ。 |
| 65 | #245 案 B | double の `content` に「山2 / 谷2 の位置」行を常に出すようにした（表示層のみ） | **変わらない**（`structuredContent` / `data.patterns` が 1 バイトも動かない。 |
| 66 | #277 | 窓の終端 `swingDepth` 本の余白でゲートが発火しないことを仕様として明文化した。docs / docstring / テストのみで検出器は 1 行も変えていない | **変わらない**（`tools/` / `src/` の変更は `swing.ts` の JSDoc と `swingDepth` の description 1 文だけ） |
| 67 | #274 Phase 1 | `wedge_*` の `pivots` 点数を案 A 相当の絞り方ごとに計測。コード変更なし（`preparePivots` の `export` 追加のみ） | **変わらない**（計測スクリプトと内部メモのみ。 |
| 68 | #281 | `wedge_*` の `pivots` から | **判定は変わらない**（実データ 1hour の回帰 fixture 10 件を全フィールド突き合わせて**バイト単位で完全一致**——本 fixture の `wedge_*` 4 件はブレイク足より 3 〜 13 … |
| 69 | #28 | （`detect_patterns` 系ではない。読む順の連番だけ引き継ぐ） | **対象外**（`detect_patterns` は 1 行も触っていない） |
| 70 | #27 | （`detect_patterns` 系ではない。読む順の連番だけ引き継ぐ） | **対象外**（`detect_patterns` は 1 行も触っていない） |
| 71 | #29 | （`detect_patterns` 系ではない。読む順の連番だけ引き継ぐ） | **対象外**（`detect_patterns` は 1 行も触っていない） |
| 72 | #286 | `content` の状態行を `status` × 理由コードの表引きにした（表示層のみ） | **変わらない**（`tools/` / `src/schema/` は無変更。 |
| 73 | #288 Phase 1 | ターゲット到達の走査窓（`TARGET_REACH_MAX_BARS` = 60）の境界を実データで計測。コード変更なし | **変わらない**（計測スクリプトと内部メモのみ。 |
| 74 | #288 Phase 2 | ターゲット進捗の表示を「事実の記述」に改め、`content` から 100% 超の百分率を消した（`TARGET_REACH_MAX_BARS` = 60 と `targetReachedPct` の計算は据え置き） | **判定は変わらない**（実データ 1hour の回帰 fixture 10 件を全キー突き合わせて、**既存キーで値が変わったもの 0 / 消えたキー 0**。 |
| 75 | #291 | 継続系（`triangle_ascending` / `triangle_descending` / pennant / flag）の `status: 'invalid'` に `invalidReason: 'breakout_against_expectation'` を足した（additive） | **変わらない**（採否・`status`・`outcome` は無変更。 |
| 76 | 整理 | 計測メモ（`docs/internal/*.md` 29 本）と計測スクリプト（`scripts/measure_*.ts` 15 本）をリポジトリから外した | **変わらない**（検出器のコード変更は `detect_wedges.ts` の計測専用 `export` 2 つを非公開に戻しただけ） |

### Added

- `detect_patterns` の `status` に `expired`、整合度にサブスコア。
- `detect_patterns` の pivot に判定価格を併記した。
- 検出器ごとの最小要求バー数を単一ソース化し、到達性を機械的に固定した
- `detect_patterns` が時間足に対して `limit` が小さすぎる窓を申告する
- `analyze_my_portfolio` が販売所取引の不可視性を検出・申告する
- `analyze_my_portfolio` に売り切り銘柄の実現損益の銘柄別内訳を露出
- `analyze_my_portfolio` に数量不変条件の判定入力を露出
- `analyze_my_portfolio` に原価へ算入できなかった入庫の件数を露出
- `analyze_my_portfolio` の信用コスト項を `_cost` サフィックスへリネーム
- `analyze_my_portfolio` の資産推移に入出金フローマーカー
- `analyze_my_portfolio` の数量不変条件: 復元数量 vs 実残高の突き合わせ
- `lib/calendar.ts`: 暦日プリミティブの集約
- since / until による絶対時刻区間指定
- `get_flow_metrics` / `analyze_volume_profile` にカバレッジ申告を追加
- `getTransactions` に内部呼び出し用オプション `{ unlimited: true }` を追加
- `lib/tx-fetch.ts`
- `get_transactions` に切り捨て（truncation）メタデータを追加

### Changed

- `detect_patterns` の `view=debug` の配線 4 件。
- `detect_patterns` の三角形の分類前 candidate ラベルを umbrella 化した。
- #127 の残り: プロンプトの `limit` 判定と CI ジョブ名の注記。
- 構造的ピボット間隔の床（`STRUCTURAL_PIVOT_GAP_FLOOR_BARS = 5`）の妥当性を実測で判定し、据え置きを確定した。
- `detect_patterns` のダブルトップ / ボトムに構造ゲートを入れた。
- `detect_patterns` の `debug` 可観測性と価格基準を透明化した。
- `detect_patterns` の `limit` に「上げる」方向の使い分けを明記
- **挙動変更**: `detect_doubles` / `detect_hs` の手書き `daysPerBar` を廃止し、バー基準に統一した
- **挙動変更**: パターン閾値のプリミティブを日数からバー数に統一し、上限クランプを入れた
- `detect_patterns` の description に検出の意味論を明記
- `analyze_my_portfolio` の期間損益の入庫件数を `_all_time` で全履歴と明示
- **挙動変更**: `analyze_my_portfolio` が入庫日価格を取得できない銘柄の実現損益を出さない
- **挙動変更**: `analyze_my_portfolio` の暗号資産入庫を取得原価に算入する
- **挙動変更**: `analyze_my_portfolio` の暗号資産入出庫を「入出庫日の価格」で評価する
- **挙動変更**: `analyze_my_portfolio` の入出金履歴取得を `include_pnl` に紐づけた
- **挙動変更**: `get_flow_metrics` の `date` 指定で `limit` を適用しない
- `date` パラメータの暦基準を明記
- カバレッジのギャップ閾値
- `get_transactions` の `minAmount` / `maxAmount` / `minPrice` / `maxPrice` フィルタを `limit` 適用前に移動

### Fixed

- 形成中 H&S / 逆 H&S の頭が「窓全体の極値」1 点に決め打ちされ、`limit` を上げると検出が消えていた。
- `detect_hs` の `tolerancePct` が頭の判定でだけ意味が反転していたのを `headProminencePct` に分離。
- `detect_hs` の**窓生成**から交互列要求を外した。
- `detect_patterns` の dedup が status を見ず、形成中が完成済みを押し出していた。
- `detect_patterns` のダブルボトム偽陰性を潰した。
- 回帰テストを実データで固定した。#126
- 用語の陳腐化。#127 の一部
- **挙動変更**: `detect_patterns` のスキャン窓を直近 `limit` 本に一致させた
- **挙動変更**: `get_candles` が上場前 chunk の 404 に巻き込まれなくなった
- 要求窓に対するカバレッジ不足の申告
- limit による切り捨ての申告
- 欠損バケットの扱い
- `get_flow_metrics` / `analyze_volume_profile` の集計が全件ベースになった（内部取得の 1000 件キャップ解除）
- `get_flow_metrics` の `meta.actualRange.durationMinutes` が欠損区間をカバー済みとして申告していた問題を修正
- `hours` 指定時の「ℹ️ 取得できた約定は直近約N分間分です。…直近フローとして扱ってください」注記を削除
- `get_transactions` の「補完ツール: get_flow_metrics」の記述が誤誘導になっていた問題を修正
- `analyze_market_signal` が上流 `get_flow_metrics` の `meta.warnings`（計算層）を落としていた問題を修正
- `get_flow_metrics` / `analyze_volume_profile` の件数ベース取得で `limit` を全パスで明示適用
- `analyze_volume_profile` の価格レンジ算出を `Math.min(...prices)` からループに変更

### Removed

- 計測メモ・計測スクリプトをリポジトリから外した。

### Security

- `vitest` / `@vitest/coverage-v8` を 4.1.9 → 4.1.11 に揃えて上げた。
- `sharp` を 0.35.2 → 0.35.4 に上げた。
- `fast-uri` を 3.1.5 → 3.1.6 に上げた。

### Schema (breaking)

- `GetTransactionsDataSchemaOut` から `raw` を削除。
- `AnalyzeVolumeProfileDataSchemaOut` の `params.timeRange` に `coveredMin` / `gapMin` / `segments` を**必須**で追加（`requestedMin` は optional）。
- `GetFlowMetricsMetaSchemaOut` / `AnalyzeVolumeProfileMetaSchemaOut` に `totalAvailable`（number, optional）/ `truncated`（boolean, optional）を追加。
- `FlowBucketSchema` に `hasData`（boolean）を**必須**で追加。
- `GetFlowMetricsMetaSchemaOut.actualRange` を `TxCoverageRangeSchema` に差し替え（`coveredMinutes` / `gapMinutes` / `segments` が必須、`requestedMinutes` / `coveragePct` / `gaps` が …

### Docs

- CHANGELOG の `[Unreleased]` を要約形式に圧縮した（6,388 行 → 約 250 行）。`detect_patterns` の索引表は 1 セル 1 文に、それ以外のエントリは見出し 1 行に畳んだ。issue ごとの判断根拠と計測の全文は fork（tjackiet/bitbank-lab-mcp）の issue・PR・git 履歴（圧縮前の `main`）に残る

## [0.4.0] - 2026-08-21

### Added
- **MCP Apps 対応ホスト限定・オプトインで、確認カードのボタンからの発注・取消を再導入した**（`BITBANK_MCP_APPS_EXECUTE=1`、既定 off）。elicitation / MRTR 非対応のホスト（Claude Desktop 等）では実行経路が無く、プレビューまでしかできなかった。確認トークンをツール結果の `_meta` にのみ載せて iframe へ渡し、`structuredContent` には載せない。有効化はオプトインとクライアントの MCP Apps UI 宣言（MIME 型込み）の 2 段 AND で、elicitation 対応ホストでは従来経路を優先する。既存の束縛（HMAC パラメータ束縛 / TTL 60 秒 / ワンタイム / `requestState` の session bind）は 1 つも緩めておらず、署名鍵に per-process nonce を追加してプロセス再起動・複数プロセスでの replay も塞いだ。
  - **安全性はホストが `_meta` をモデルコンテキストに渡さないという前提に依存する。仕様上の保証ではない。**また UI 宣言はクライアントの自己申告で検証できないため、認可の実体はトークン所持のみである。有効化前に README の警告と ADR-0007 を必ず読むこと。

### Fixed
- **過去保有の復元（`reconstructHoldingsAtDate`）が期初の保有を過大に出す問題を修正。** 巻き戻しは「約定 → 入庫 → 出庫」の 3 相で同一時点の状態に加算を積むが、約定相と入庫相が途中経過ゼロ以下の資産をその場で削除していた。3 相は独立した加算なので本来は順序に依存しないが、途中でクランプすると負の繰り越しが失われて順序依存になる（現在 BTC 1 / ウィンドウ内に「BTC 2 買い → BTC 1 出庫」がある口座で、期初は BTC 0 であるべきところ BTC 1 になる）。途中のクランプをやめ、実質ゼロの掃除は全相を終えた後の既存 cleanup 1 回だけにした。`buildEquitySeries` の過去の点と、期初評価額を使う期間パフォーマンス（調整後増減）が同じ向きにずれていたが、系列は滑らかなままなので読み手からは見えなかった。
- **売り約定の巻き戻しが base 建て手数料を戻していなかった問題を修正**（`current + qty` → `current + qty + feeBase`）。base 手数料は売りでも base から引かれる。買い側の `qty - feeBase` と対称になる。実口座では売り行の `fee_amount_base` が全てゼロのため出力は変わらない。
- **重い `view` が軽い `view` の上位集合になっていなかった問題を修正（`content` は増える方向のみ変わる）。** `get_flow_metrics` の `view=buckets` / `view=full` は上流 `res.summary` を捨てて短いヘッダを組み直しており、`view=summary` / `view=compact` にあった**最終約定価格・スパイク上位 3 件の詳細・4 行フッタ**（含まれるもの / 含まれないもの / 補完ツール / 加工契約）が上位 `view` でだけ消えていた。同様に `get_volatility_metrics` の `view=detailed` / `view=full` では 4 行フッタ（含まれるもの / 含まれないもの / ATR の定義 / 補完ツール）が消えていた。`content[0].text` は LLM への唯一のチャネルなので、これは「表示が変わる」ではなく「LLM が情報を失う」に等しい。
- `get_flow_metrics(buckets/full)` を `res.summary` ベースに変更（バケット行の直前に置く `PAIR Flow Metrics (bucketMs=…)` / `Totals:` の 2 行ヘッダは従来どおり）。取得層の warning 行は `res.summary` が既に含むため、ヘッダ側には重ねない。`get_volatility_metrics(detailed/full)` はフッタ文言を `VOLATILITY_METRICS_FOOTER`（`tools/get_volatility_metrics.ts`）に単一ソース化して維持するようにした。**既定 `view` の応答が変わるツールは無い**（`get_flow_metrics` の既定は `summary`、`get_volatility_metrics` の既定は `summary`。どちらも元からフッタを持つ）。
- 併せて `tests/view-content-superset.test.ts` を新設。**文字列長の比較は使わない**（フッタが落ちても明細が増えれば通ってしまう）——定型要素（`📌` フッタ行 / `⚠️`・`ℹ️` 注記行 / ヘッダ主要フィールド）とバケット行の識別キーの**集合包含**で検証する。階梯外の `beginner` / `debug` は「出力の置換」なので対象外であることもテストで固定した。
- **`get_flow_metrics` の `view` が `structuredContent` の契約を変えていた問題を修正。`view` は `content` だけを変え、`structuredContent` からフィールドを削らないことを契約にした。** 従来 `view=summary` は `data.series.buckets` を**キーごと削除**しており、同フィールドを必須で宣言する `GetFlowMetricsDataSchemaOut` を満たさない `structuredContent` を返していた（ハンドラ加工後に再 parse していなかったため実行時に露見していなかった）。`view=compact` も同様に、宣言上は全バケットのはずが非ゼロだけの部分集合になっていた。**修正により `view=summary` / `view=compact` でも `series.buckets` に全バケットが入る。** `content` の絞り込み（`summary` はバケット行なし / `compact` は非ゼロのみ）は従来どおりで、**全 `view` について `content` は 1 バイトも変わらない**。
- 削除の動機はトークン削減だったが、LLM は `structuredContent` を参照しない（`.claude/rules/tools.md`）ため削減量はゼロで、非 LLM クライアントの契約だけが壊れていた。再発防止としてハンドラ出口で `GetFlowMetricsOutputSchema.parse()` を通し、以後 `view` 分岐が `structuredContent` を加工したら CI で落ちるようにした。併せて `tests/view-structured-content-invariance.test.ts` を新設し、`get_flow_metrics` / `get_transactions` / `get_volatility_metrics` は全 `view` で deep-equal、`detect_patterns` / `detect_macd_cross` は「足すだけ（削らない）」を横断的に固定した。
- MCP プロンプト「中級：BTCのフロー分析をして」が `get_flow_metrics` に存在しない `view=detailed` を指示していた問題を修正（`view=compact` に差し替え）。同ツールの enum は `summary` / `compact` / `buckets` / `full` で、SDK v2 はハンドラ実行前に `inputSchema` で入力を検証するため、指示どおり呼ぶと validation error になっていた。差し替え先を `compact` にした根拠は、当該プロンプトの用途（CVD 推移・スパイク・直近 1-3 時間重視、`limit=300` / `bucketMs=60000` ＝ 最大約 300 バケット）に対し `full` は 300 行で重く、`buckets`（既定 10 件）は CVD 推移を見るには短いため。
- 併せて `tests/prompts_contract.test.ts` に、全プロンプトのツール呼び出し例が指示する `view` が各ツールの Zod enum で受理されるかを静的に突き合わせる検査を追加。プロンプトはテストで実行されないため、この種の不整合は従来どのテストにも掛からなかった。
- MCP `initialize` が返す `serverInfo.version` を `package.json` の値に統一。`src/server.ts` が `'0.4.2'` をハードコードしており、`package.json` / 各プラグインマニフェスト（`.claude-plugin` / `.codex-plugin` / `.cursor-plugin` / `gemini-extension.json`）の `0.1.1` と乖離したまま、クライアントに誤ったバージョンを申告していた。`createRequire(import.meta.url)` で `package.json` を単一ソースとして読むようにし、以後リリース時に取り残されないようにした（`bin/bitbank-lab-mcp.js` と同じ解決方式）。併せて `tests/server_smoke.test.ts` の期待値をリテラルから `package.json` 参照に変更し、同種の drift をテストで検知できるようにした。

### Changed
- **`calcPeriodNetFlow` が価格を解決できない資産を黙って落としていたのを、`unpriced_assets` として申告するようにした**（0 円計上と等価で `net_flow_jpy` が過小になり、`adjusted_change_jpy` も同じ向きにずれる）。`analyze_my_portfolio` は計算層の warning として `content` 先頭と `meta.warnings` に出す。該当なしのときはキーごと省くため、従来の出力と JSON 上で完全一致する。
- **bitbank API が返す `asset` / `pair` シンボルを取得境界で小文字に正規化するようにした**（`lib/asset-code.ts` / `lib/pair-code.ts`）。リポジトリ全体が「API は小文字を返す」前提の上に立っており、大文字が混ざると `BTC_JPY` に対して `replace('_jpy','')` が何も置換せず holdings のキーが割れる、`calcPnl` の pair 突き合わせが 0 件になり実現損益が静かに消える、といった壊れ方をする。防御的正規化で、現行 API の挙動は変わらない。消費側に `.toLowerCase()` を撒かず取得境界の 1 箇所に集約している。
- **`get_volatility_metrics` の実現ボラ `rv_std` / `rolling[].rv_std`（および年率換算 `rv_std_ann`）が母集団分散(n) から標本分散(n-1, Bessel 補正)ベースに変わったため出力数値が変化する。破壊的変更ではない**（型・フィールド・契約は不変、同一データで `rv_std` が僅かに大きくなるのみ）。上振れ幅は**小窓ほど大きく**、aggregate は標準 limit=200 で約 +0.25%、rolling は w=14 で約 +3.78%、w=20 で約 +2.60%、w=30 で約 +1.71%。
- 上記に伴い `volatile`(≥0.8) / `calm`(≤0.3) 判定閾値および下流参照（`getVolatilityMetricsHandler` の `high_vol`/`low_vol`/`expanding_vol`/`contracting_vol`/`high_short_term_vol`、`analyze_market_signal` の `volatilityFactor` / `recommendedTimeframes`）の閾値を**再評価のうえ据え置き**。根拠: 閾値は全て年率実現ボラを基準に判定しており、(a) aggregate ベースの閾値は標本数が大きく Bessel 補正が無視可能（最小 20 本でも +2.74%）、(b) `expanding/contracting_vol` の short/long 比は Bessel 係数が相殺し残差が ±5% 中立バンド内、(c) `high_short_term_vol` の最大上振れ（w=14, +3.78%）もヒューリスティックな許容範囲内のため、いずれも判定境界を実質的に跨がない。volatile/calm の閾値は `VOLATILE_RV_ANN_THRESHOLD` / `CALM_RV_ANN_THRESHOLD` 定数として明示し、判定を純粋関数 `classifyRealizedVolTags` に集約した（挙動は不変）。

### Security
- **使用済み confirmation token / requestState nonce の記録を有界化し、上限到達時を fail-closed にした。** 従来はどちらも上限のない `Map` に貯め続けており、確認フローを大量に作るクライアントが短時間でプロセスのメモリを増やせた（nonce 側は `consumeNonce` 内の全走査でしか purge されず、CPU も件数に比例して消費していた）。TTL + 件数上限つきの共通データ構造 `lib/bounded-expiring-set.ts` に載せ替え、上限に達したら **生存エントリを追い出さず** `add` を失敗させ、確認・実行を拒否する（`validateToken` は `token_store_full`、`consumeNonce` は `capacity_exceeded`）。**容量を空けるために未期限切れの記録を退避してはならない**——その token / nonce は「未使用」に巻き戻り replay が黙って通るため、メモリ上限のためにワンタイム性を犠牲にしない。件数上限は `DEFAULT_MAX_ENTRIES`（10,000 件 ≒ 2MB。環境変数 `REPLAY_GUARD_MAX_ENTRIES` で上書き可）に 1 箇所へ集約し、算出根拠（保持期間 最長 300 秒 × 想定ピーク 20 件/秒 = 6,000 件）をコメントに残した。purge はアクセス時に加えて定期タイマー（60 秒間隔・`unref` 済み）でも走り、無アクセス期間の記録が TTL 超過後に残り続けないようにした。
- **取引系 HITL の trust-host 経路を撤去した。** `BITBANK_TRUST_HOST_APPROVAL=1` でも `confirmation_token` を `structuredContent` に載せない。SEP-1865 iframe 起源の `tools/call` をサーバー側で識別できないため、token 露出は HITL バイパスになる。execute は elicitation / MRTR のユーザー明示 accept のみ。`create_order` / `cancel_order` / `cancel_orders` の MCP handler は常に `direct_execute_forbidden` で拒否する。環境変数は設定しても無視される（後方互換のため `isHostApprovalTrusted()` は常に `false` を返す）。
- `run_backtest` の `savePng: true` 時の `outputDir` を許可 root 配下のみに制限（`/mnt/user-data/outputs`・サーバー作業ディレクトリ配下、および環境変数 `BACKTEST_OUTPUT_DIR_ALLOWLIST` で運用側が追加した root）。許可外パスはバックテスト実行前にエラーを返す。判定は `..`・シンボリックリンクを解決した実パスで行うためトラバーサル・symlink では迂回できない。**既定設定の動作は不変**で、許可外ディレクトリへ出力していた場合のみ環境変数での明示許可が必要（#15）。
- チャートファイル名生成（`generateBacktestChartFilename`）に、パス区切り・ドット等を除去する防御的サニタイズを追加。ファイル名の安全性を上流の pair バリデーションに依存させないための多層防御（#15）。

### Documentation
- `docs/tools.md` に「`view` の共通語彙」節を新設（従来 `view` の記載はゼロだった）。階梯 / `full` が全件列挙とは限らない条件 / `structuredContent` を削らない契約 / `format`・`nonZeroOnly` の位置づけ / 階梯外の値 / 生データ系の既定が全件列挙である理由 / ツール別の値と既定 / **非推奨の値と写像先の表**を書いた。`get_tickers_jpy` の `view` は本語彙の対象外である旨も明記。
- `.claude/rules/tools.md` に「`view` の規約」節（規約 1〜7）を追記。`src/schema/base.ts` の共通文言と各共通テストへの導線を張り、handler チェックリストの `view=items` という例示を `format=json` に差し替えた（旧値を規約文書に残さないため）。
- `docs/internal/view-vocabulary-unification.md` を追加（設計の一次ソース）。`view` 語彙の調査結果・統一設計・移行方針・alias 写像表・実施状況。
- MCP プロンプトを新語彙へ追従: 「中級：BTCのフロー分析をして」の `get_flow_metrics(view=compact)` → `view=full, nonZeroOnly=true` / `get_transactions(view=summary)` → `view=full`、「🌅 おはようレポート」の `get_candles(view="items")` → `view="full"`。**おはようレポートに `format=json` は付けていない**——用途はスパークライン用に 24 本の close を得ることで、`view=full`（既定）のサマリ本文が 24 本すべてを 1 行 1 本の圧縮形式で含む。`format=json` にすると同じ 24 本が 10 行/本の pretty JSON になり、しかも `content` からサマリ本文・価格レンジ・キーポイント・出来高統計・フッタが消える（**JSON を要求する理由が無く、付けないほうが軽く、かつ LLM が受け取る情報は増える**）。

### Schema (breaking)
- **`view` の語彙をツール間で統一した。** `view` は**出力量の 1 軸**のみを表し、`summary` < `detailed` < `full` の順序で、**`full` は常にそのツールの最重量**を意味する。従来は同じ語が別の重さを指していた（`get_candles` の `full` は既定の通常表示、`get_flow_metrics` の `full` は全バケット列挙、`get_transactions` の `summary` は全件列挙）。LLM が `view` からトークン量を見積れず、`src/prompts/intermediate.ts` は `get_flow_metrics` に存在しない `view=detailed` を指示していた。
- **旧値は deprecated alias として受理する**（`get_candles.items` / `get_transactions.summary` / `get_transactions.items` / `get_flow_metrics.compact` / `get_flow_metrics.buckets`）。写像は次のとおりで、**旧値経由の `content` はバケット行・明細とも変わらない**。削除目標バージョンは `DEPRECATED_VIEW_REMOVAL_TARGET`（`src/schema/base.ts`）を単一ソースにした。

  | ツール | 旧値 | 新しい指定 | `content` | `structuredContent` |
  |---|---|---|---|---|
  | `get_candles` | `items` | `view=full` + `format=json` | 不変 | **変わる**（下記） |
  | `get_transactions` | `summary`（旧既定） | `view=full` | 不変 | 不変 |
  | `get_transactions` | `items` | `view=full` + `format=json` | 不変 | 不変 |
  | `get_flow_metrics` | `compact` | `view=full` + `nonZeroOnly=true` | **バケット行は不変。ヘッダ 2 行が増える** | 不変 |
  | `get_flow_metrics` | `buckets` | `view=detailed` | 不変 | 不変 |

- **量以外の軸を別パラメータへ切り出した**: `format`（`text` / `json`。`get_candles` / `get_transactions`）、`nonZeroOnly`（boolean。`get_flow_metrics`）。`debug`（`detect_patterns`）と `beginner`（`get_volatility_metrics`）は出力を**置換**する**階梯外の値**として `view` に残す。`get_tickers_jpy` の `view`（`items` / `ranked`）は量でも形式でもなく**射影**なので本統一の対象外（改名は別途）。
- **`get_candles(view=items)` の `structuredContent` shape が変わる。** 旧 `items` は `{ items, meta }` を返し `ok` / `summary` / `data.{raw,keyPoints,volumeStats}` を落としていたが、`view=full` + `format=json` では他ツールと同じ `Result` 封筒を返す。**旧 shape に依存するクライアントは `structuredContent.items` → `structuredContent.data.normalized` に読み替えが必要。**（`get_transactions(view=items)` は元から封筒を保持しており不変）
- **`get_transactions` の default が `summary` → `full` に変わる（挙動は不変）。** 従来の `summary` は「返却した全約定を 1 行 1 件で列挙」であり、実体は `full` だった。集計のみの軽量 `summary` は将来別リリースで **opt-in 専用**として新設予定で、**同じ語の意味を差し替えないため alias 期間の削除後にのみ再導入する**。
- **生データ系ツール（`get_candles` / `get_transactions`）の既定は今後も全件列挙のまま。** `content[0].text` が LLM への唯一のチャネルであり（`.claude/rules/tools.md`）、既定を軽くすることは「短くする」ではなく「LLM が明細を受け取らなくなる」を意味するため。同じ理由で `format=json` は**トークン削減オプションではない**（同じデータでも pretty JSON は散文の圧縮形式より必ず増える）。この位置づけを各 description に明記した。
- **既定の応答内容が変わるツールは無い。** 各ツールのハンドラ引数の `view` / `format` 型はリテラルを手書きせず Zod スキーマから導出してあるため、alias を enum から消した時点で残った alias 分岐は `TS2367` で必ず typecheck が落ちる（消し忘れを機械的に潰せる）。
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
