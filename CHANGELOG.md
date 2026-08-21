# Changelog

本プロジェクトの主な変更履歴です。
形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠しています。

---

## [Unreleased]

### Changed（**挙動変更**: `analyze_my_portfolio` の暗号資産入出庫を「入出庫日の価格」で評価する）
- **暗号資産の入出庫を入出庫日（入庫: `confirmed_at` / 出庫: `requested_at`）の 1day open で JPY 換算するようにした。** 従来は現在価格での仮評価だったため、誤差が相場と連動して動く系統的バイアスになっていた（取引ゼロでも相場上昇だけで報告損益が悪化する）。対象は `deposit_withdrawal_summary.crypto_deposit_estimated_jpy` / `net_jpy_invested` / 口座全体リターン、`yearly_dw_summary` / `monthly_dw_summary` の `crypto_{deposit,withdrawal}_estimated_jpy`、`*_performance` の `net_flow_jpy` / `withdrawal_fee_jpy` / `adjusted_change_jpy`。出庫手数料も元本と同じ単価で換算する（元本だけ入出庫日・手数料だけ現在価格の混成にしない）。
- **入出庫日価格が直近 400 日窓の外にある場合は (資産, 年) 単位で 1day chunk を追加取得する。** 追加取得は入出庫が実在する組だけに絞り、上限（`MAX_FLOW_PRICE_YEAR_CHUNKS = 12`）を超えた分と取得に失敗した分は現在価格にフォールバックする。**フォールバックは黙って混ぜず件数で申告する**（下記）。
- **価格解決の下限時刻は入庫と出庫で別々。** 入庫は入出金分析セクション（純投入額・口座全体リターン）が全履歴を換算するのに対し、**出庫を金額換算する消費者は期間集計だけ**（`*_dw_summary` / 期間ネットフロー）で、`deposit_withdrawal_summary` は暗号資産出庫を `crypto_withdrawal_count` として件数しか出さない。年初より前の出庫は換算しても反映先が無いため対象外にする（`FlowValuationScope`）。
- **価格解決は換算結果を出力するセクションがあるときだけ走る。** 入出金分析セクション（全履歴）と期間ネットフロー（年初来）のどちらも消費しない構成——`include_deposit_withdrawal: false` かつ入出金履歴の部分失敗・打ち切りで純入出金が未計測になるケース——では追加取得も `*_valuation` / `meta.flowValuationBasis` の申告も行わない（どの出力にも載っていない評価額を申告しない）。
- **`include_pnl: false` + `include_deposit_withdrawal: true` でも candle を取得するようになった。** 入出金分析セクションの暗号資産入庫を入庫日価格で評価するために必要（従来この構成では candle を一切取得していなかった）。取得は入庫が実在する (資産, 年) の組のみで、上限は上記と同じ。`include_deposit_withdrawal: false` の構成では期間ネットフローに要る年初以降の入出庫だけに絞る。
- **`*_valuation`（`FlowValuation`）を追加した**: `deposit_withdrawal_summary.crypto_deposit_valuation` / `yearly_dw_summary` / `monthly_dw_summary` の `crypto_deposit_valuation` / `crypto_withdrawal_valuation` / `*_performance.flow_valuation`。`deposit_date_price_count` / `current_price_fallback_count` / `basis`（`deposit_date_price` / `current_price_fallback` / `mixed`）を持つ。暗号資産の入出庫が無い、または全件で価格を解決できなかった場合はキーごと落ちる（従来出力と JSON 一致）。
- **`meta.flowValuationBasis` / `meta.flowValuationFallbackCount` を追加した。** レスポンス全体で換算した入出庫の集計値。現在価格フォールバックが 1 件でもあると `meta.warnings` と summary 先頭に「n 件は現在価格で仮評価」を出す（各セクションの内訳は互いに部分集合なので、件数は母集合を 1 度だけ数える）。
- **`*_performance.note`（`PERFORMANCE_NOTE`）と summary の注記行の文言を更新した。** 「暗号資産入出庫は現在価格で仮評価」→「入出庫日の始値で JPY 換算し、その日の価格を取得できなかった分のみ現在価格で仮評価」。
- **「入庫時点の相場で取得した」という仮定であることは引き続き注記する**（真の取得原価ではない）。`calcPnl` への入庫原価算入（#57 (b)）は本変更に含まれないため、入庫のある銘柄の `cost_basis` は #56 の数量不変条件で従来どおり抑止される。

### Added（`analyze_my_portfolio` の数量不変条件: 復元数量 vs 実残高の突き合わせ）
- **`holdings[].cost_basis_reliable`（boolean）を追加した。** `calcPnl` が約定・出庫リプレイで復元した保有数量と assets API の実残高（`onhand_amount`）を恒久的に突き合わせ、許容誤差 `max(10^-amount_precision × 5, 実残高 × 0.1%)`（絶対項 = 端数処理・ダスト、相対項 = 浮動小数点誤差の許容）を超えて乖離した銘柄は `false` になる。乖離時は `cost_basis` / `avg_buy_price` / `unrealized_pnl` / `unrealized_pnl_pct` を確定値として出さず（#54 の null 化経路）、`total_cost_basis` / `total_unrealized_pnl` の集計からも除外して銘柄名のみを `meta.warnings` と summary の警告行で申告する。原価計算の対象外（JPY / `include_pnl=false`）では省略。フィードバックの ETH 型（約 1000 倍乖離）が確定値のまま素通りしていた検知の穴を塞ぐ。
- **理由コード enum を拡張した**（`holdings[].cost_basis_unavailable_reason`）: `has_crypto_deposits`（該当銘柄に DONE の暗号資産入庫があり原価計算に入っていない。原価算入は #57 のスコープ）/ `history_truncated`（約定履歴の件数上限打ち切り）/ `unknown`（原因を特定できない。例: 履歴に現れない出庫）。入出金取得起因の既存 2 値（`dw_fetch_failed` / `dw_history_incomplete`）と同一フィールドで返し、取得起因の抑止が掛かる場合はそちらが優先される。数量乖離側の 3 値は銘柄単位でのみ立ち、`total_cost_basis_unavailable_reason` / `*_performance.flow_unavailable_reason` / `meta.flowDataUnavailableReason` には現れない。

### Changed（**挙動変更**: `analyze_my_portfolio` の入出金履歴取得を `include_pnl` に紐づけた）
- **`include_deposit_withdrawal` は入出金分析セクションの表示制御だけになった。** 従来は同フラグが入出金履歴の取得可否まで握っており、`false` にすると暗号資産の出庫履歴が `calcPnl` に渡らず取得原価が過大化し、期初評価額・資産推移シリーズも入出金を巻き戻せていなかった（`include_pnl` との偽の直交性）。今後は `include_pnl: true` なら同フラグの値に関わらず入出金履歴を取得して損益計算に供給する。`false` で抑止されるのは `deposit_withdrawal_summary` / `yearly_dw_summary` / `monthly_dw_summary` / 口座全体リターンの出力のみ。
- **`include_pnl: true` のとき入出金 API の呼び出しが増える**（暗号資産入庫 / JPY 入金 / 暗号資産出庫 / JPY 出金 の最大 4 チャネル × ページネーション）。既存の並列 `Promise.all` に載せてあるためレイテンシ増は最小。`include_pnl: false` では従来どおり `include_deposit_withdrawal` が取得可否を決める。
- **`meta.dwFetchedForPnl`（boolean）を追加した。** `meta.depositWithdrawalStatus` は分析**セクション**の状態を表すため、`include_deposit_withdrawal: false` では履歴を取得済みでも `not_requested` になる。内部取得の成否はこの新フィールドで申告する。
- **理由コード `withdrawal_history_not_fetched` を削除した**（`holdings[].cost_basis_unavailable_reason` / `data.total_cost_basis_unavailable_reason` / `*_performance.flow_unavailable_reason` / `meta.flowDataUnavailableReason`）。入出金履歴を「取得していない」状態が損益出力と併存しなくなったため。取得が落ちた場合は `dw_fetch_failed` に落ちる。

### Security
- **取引系 HITL の trust-host 経路を撤去した。** `BITBANK_TRUST_HOST_APPROVAL=1` でも `confirmation_token` を `structuredContent` に載せない。SEP-1865 iframe 起源の `tools/call` をサーバー側で識別できないため、token 露出は HITL バイパスになる。execute は elicitation / MRTR のユーザー明示 accept のみ。`create_order` / `cancel_order` / `cancel_orders` の MCP handler は常に `direct_execute_forbidden` で拒否する。環境変数は設定しても無視される（後方互換のため `isHostApprovalTrusted()` は常に `false` を返す）。

### Schema (breaking)（`view` の語彙をツール間で統一）
- **`view` の語彙をツール間で統一した。** `view` は**出力量の 1 軸**のみを表し、`summary` < `detailed` < `full` の順序で、**`full` は常にそのツールの最重量**を意味する。従来は同じ語が別の重さを指していた（`get_candles` の `full` は既定の通常表示、`get_flow_metrics` の `full` は全バケット列挙で約 1,440 行、`get_transactions` の `summary` は全件列挙）。LLM が `view` からトークン量を見積れず、`src/prompts/intermediate.ts` は `get_flow_metrics` に存在しない `view=detailed` を指示していた（この 1 件は先行して修正済み）。
- **旧値は deprecated alias として受理し続ける。** ハンドラ入口で新しい指定へ正規化するので、**旧値経由の既定挙動は変わらない**。**`0.4.0` で削除予定**（最低 1 リリース かつ 3 ヶ月の猶予）。写像は以下のとおり。

  > **表の「不変」の基準は、下記「`view` は `content` のみを変え、`structuredContent` を変えない」の修正を適用した後の挙動**（= 旧値と写像先を同一リリース内で突き合わせたときに一致する、の意）。**前リリースからの wire 契約の差分は別にある**——同リリースで `get_flow_metrics(view=summary)`（**既定値**）の `structuredContent` に `data.series.buckets` が戻り、`view=compact` の `series.buckets` が全バケットになる。`structuredContent` を読むクライアントは、語彙統一の表だけでなくそちらの項も確認すること。

  | ツール | 旧値 | 新しい指定 | `content` | `structuredContent` |
  |---|---|---|---|---|
  | `get_candles` | `items` | `view=full` + `format=json` | 不変 | **変わる**（下記） |
  | `get_transactions` | `summary`（旧既定） | `view=full` | 不変 | 不変 |
  | `get_transactions` | `items` | `view=full` + `format=json` | 不変 | 不変 |
  | `get_flow_metrics` | `compact` | `view=full` + `nonZeroOnly=true` | **バケット行は不変。ヘッダ 2 行が増える** | 不変 |
  | `get_flow_metrics` | `buckets` | `view=detailed` | 不変 | 不変 |

  `compact` で増える 2 行は `PAIR Flow Metrics (bucketMs=…)` と `Totals: …`。上の「上位ビューは下位ビューの上位集合」の修正で `full` に入ったヘッダで、**減る要素は無い**。バケット行——どのバケットを出すか / 欠損の連続区間の 1 行への畳み込み（`⋯ 欠損 A〜B（Nバケット, データなし）`）/ 真のゼロの除外——は 1 バイトも変わらない。
- **量以外の軸を別パラメータへ切り出した**: `format`（`text` / `json`、`get_candles` / `get_transactions`）、`nonZeroOnly`（boolean、`get_flow_metrics`）。切り出したことで、旧 enum では表現できなかった組み合わせ（`view=detailed` + `nonZeroOnly=true` など）も表現できるようになった。`debug`（`detect_patterns`）と `beginner`（`get_volatility_metrics`）は出力を**置換**する**階梯外の値**として `view` に残す。
- **`format=json` はトークン削減オプションではない。** 同じデータを pretty JSON にすると散文の圧縮形式より必ず増える（`get_candles` の実測で約 7.4 倍）。「機械可読性のために**トークンを払う**」オプションであることを description に明記した。
- **`get_candles(view=items)` の `structuredContent` shape が変わる（本リリース唯一の shape 破壊）。** **旧 `items` だけが逸脱していたのを解消するもので、`format` が `structuredContent` を変えるようになったわけではない。** 移行後は `view` / `format` のどの組み合わせでも同一の `Result` 封筒を返す。

  | 指定 | `content[0].text` | `structuredContent` |
  |---|---|---|
  | `view=full` + `format=text`（既定） | サマリ本文 ＋ 先頭 5 本の JSON サンプル | `Result` 封筒（`ok` / `summary` / `data.{raw,normalized,keyPoints,volumeStats}` / `meta`） |
  | `view=full` + `format=json` | 全件の pretty JSON | **同上（同一）** |
  | `view=items`（deprecated alias） | 同上 | **同上（同一）** |

  **旧 `items` は `{ items, meta }` を返し `ok` / `summary` / `data.{raw,keyPoints,volumeStats}` を落としていた。旧 shape に依存するクライアントは `structuredContent.items` → `structuredContent.data.normalized` の読み替えが必要。** この 3 通りが deep-equal であることは `tests/view-structured-content-invariance.test.ts` で固定してある。（`get_transactions(view=items)` は元から封筒を保持しており、こちらは不変）
- **`get_transactions` の default が `summary` → `full` に変わる（挙動は不変）。** 従来の `summary` は「返却した全約定を 1 行 1 件で列挙」であり、実体は `full` だった。外れ値だったのは default ではなく**名前**で、名前を階梯に合わせたことで `get_candles` と default が揃う。`summary`（集計のみ）は将来別リリースで **opt-in 専用**として新設予定（既定にはしない）。**同じ語の意味を差し替えないため、`summary` は alias 期間の削除後にのみ再導入する**——旧値を送り続けたクライアントに黙って別の応答が返るのを避けるため。
- **生データ系ツール（`get_candles` / `get_transactions`）の既定は今後も全件列挙のまま。** `content[0].text` が LLM への唯一のチャネルであり（`.claude/rules/tools.md`）、既定を軽くすることは「応答を短くする」ではなく「**LLM が OHLCV / 約定明細を一切受け取らなくなる**」を意味するため。過去に `get_volatility_metrics` で軽量な一行要約を既定にして差し戻した実例がある。
- **description を統一文言に揃えた。** 各 `view` に「この view では〇〇が `content` に出ない」を明記し、deprecated 値には写像先と削除目標バージョン（`0.4.0`）を書いた。共通文言は `src/schema/base.ts`（`VIEW_CONTRACT_NOTE` / `FORMAT_PARAM_NOTE` / `deprecatedViewNote()`）を単一ソースにしている。あわせて **`detect_macd_cross` の `view` が `pair` 省略時（スクリーニングモード）でのみ有効で、`pair` 指定の単一ペア深掘りモードでは無視される**ことを明記した（従来 `inputSchema` にもハンドラの型にも書かれていなかった）。
- **`get_tickers_jpy` の `view`（`items` / `ranked`）は対象外。** 量でも形式でもなく**射影**（並び順と `data.ranked` の有無）を指しており、`view` という名前自体が誤用のため。改名は別途扱う。
- **語彙統一そのものが既定の応答を変えるツールは無い。** 本項で変わるのは deprecated alias 経由の `get_flow_metrics(compact)` で `content` のヘッダ 2 行が増える点（減る要素は無い）と、`get_candles` の `format=json` / `view=items` の `structuredContent` shape だけ。**ただしリリース全体で見ると `get_flow_metrics(view=summary)`（既定値）の `structuredContent` は変わる**——下記「`view` は `content` のみを変え、`structuredContent` を変えない」の修正で `data.series.buckets` が戻るため。
- **再発防止**: 横断テスト `tests/view-alias-mapping.test.ts` を追加し、上の写像表どおり旧値と新しい指定の応答が一致することを固定する。`get_flow_metrics` は**真のゼロと欠損区間を両方含むフィクスチャ**で検証する——「非ゼロだけにフィルタしてから全件レンダラに渡す」素朴な実装では欠損の畳み込みが失われて N 行に展開されるため、この 2 つが同時に無いと検出できない。あわせて `tests/view-content-superset.test.ts` の階梯包含テストを `detect_patterns`（`summary` ⊆ `detailed` ⊆ `full`）へ横展開し、`tests/view-structured-content-invariance.test.ts` の `get_candles` ケースを「既知の逸脱を固定する」形から他ツールと同じ deep-equal へ置き換えた。

### Fixed（`view` の階梯: 上位ビューは下位ビューの上位集合）
- **`get_flow_metrics(view=buckets / full)` の `content` に、最終約定価格・スパイク上位 3 件の詳細・4 行フッタ（含まれるもの / 含まれないもの / 補完ツール / 加工契約）が出るようになった。** 従来は上流の `res.summary` を捨てて短いヘッダ（`PAIR Flow Metrics (bucketMs=…)` ＋ `Totals:` ＋ 警告行）を組み直していたため、**軽い view（`summary` / `compact`）には出ているこれらの定型情報が、重い view でだけ消えていた**。`res.summary` をベースにバケット行を足す形（`compact` と同じ組み立て）に変更した。バケット行の直前に置く `Flow Metrics (bucketMs=…)` ヘッダと `Totals:` 行は従来どおり出る（警告行は `res.summary` が同じ文言を含むため重複させない）。
- **`get_volatility_metrics(view=detailed / full)` の `content` に 4 行フッタ（含まれるもの / 含まれないもの / ATR の定義 / 補完ツール）が出るようになった。** 従来は本文を再構築する際にフッタを落としていた。文言は `tools/get_volatility_metrics.ts` の `VOLATILITY_METRICS_FOOTER` を単一ソースにし、`summary`（上流 `res.summary` をそのまま流す）と `detailed` / `full`（ハンドラが組み立てる）で食い違わないようにした。
- **`content[0].text` は LLM への唯一のチャネル**（`.claude/rules/tools.md`）なので、上位 view で定型情報が消えるのは「表示が変わる」ではなく「LLM が最終値・スパイク詳細・『含まれないもの』『補完ツール』『加工契約』を受け取らなくなる」に等しい。`view` を上げたら情報は減らない、を契約にした。
- **既定の `content` が変わるツールは無い。** 変わるのは `get_flow_metrics` の `buckets` / `full`（既定は `summary`）と `get_volatility_metrics` の `detailed` / `full`（既定は `summary`）だけで、いずれも**増える方向のみ**——従来の出力はそのまま残り、消えていた定型情報が加わる。`structuredContent` は全 `view` で従来どおり不変。
- **階梯外の view は対象外**: `get_volatility_metrics(beginner)` と `detect_patterns(debug)` は「出力の置換」であり上位集合である必要がない。平易な言い換えである `beginner` に専門用語のフッタを足すのはその view の目的に反するため、意図的に足していない（テストで固定した）。
- **再発防止**: 横断テスト `tests/view-content-superset.test.ts` を追加し、階梯上の各 view の `content` が下位 view の定型要素を含むことを検証する。**文字列長の比較（`len(summary) ≤ len(detailed) ≤ len(full)`）は使わない**——長さは上位集合性を検証せず（フッタが落ちても明細が増えれば通る。今回の欠陥はまさにその形）、文言を 1 語変えただけで落ちる脆いテストにもなるため。代わりに定型要素（📌 フッタ行 / ⚠️・ℹ️ 注記行 / ヘッダの pair・期間・最終値）を抽出・正規化した集合の包含と、バケット行の識別キー集合の包含で検証する。

### Fixed（`view` は `content` のみを変え、`structuredContent` を変えない）
- **`get_flow_metrics(view=summary)` の `structuredContent` に `data.series.buckets` が戻った。** 従来は `buckets` を**キーごと削除**しており、`series: z.object({ buckets: ... })` を**必須**で宣言する `GetFlowMetricsDataSchemaOut` を満たさない `structuredContent` を返していた（ハンドラでの加工後に再 parse していなかったため実行時エラーにならず露見していなかった）。`data.series.buckets` を必須として読む外部クライアントは、これまで `view=summary`（**既定値**）で欠落を受け取っていたことになる。
- **`get_flow_metrics(view=compact)` の `structuredContent` が全バケットになった**（従来は「非ゼロ ∪ 欠損」でフィルタ済み）。`content` テキスト側の絞り込み表示（非ゼロバケットのみ＋欠損は `⋯ 欠損 A〜B（Nバケット, データなし）` の区間表記）は**従来どおり不変**。
- 削除・フィルタの動機はトークン削減だったが、**LLM は `structuredContent` を参照しない**（`.claude/rules/tools.md`「`content[0].text` だけが LLM に見える」）ため削減量はゼロで、非 LLM クライアント向けの契約だけが壊れていた。`view` は `content` の量を決めるパラメータであり、`structuredContent` の shape を決めるパラメータではない。
- **`content` は全 `view` で 1 バイトも変わらない。** `view=summary` / `compact` / `buckets` / `full` のテキスト出力・警告行・フッタはいずれも従来どおり。
- **再発防止**: ① `get_flow_metrics` のハンドラ出口で `GetFlowMetricsOutputSchema.parse()` を通し、以後のスキーマ drift を CI で検出する。② 横断テスト `tests/view-structured-content-invariance.test.ts` を追加し、同一入力に対し `view` を変えても `structuredContent` が deep-equal であることを `get_flow_metrics` / `get_transactions` / `get_volatility_metrics` で検証する。階梯外 view が**足す**のは許容（`detect_patterns(debug)` の `data.candidates`、`detect_patterns(detailed)` の `usage_example`、`detect_macd_cross(detailed)` の `data.resultsDetailed` / `data.screenedDetailed`）なので、これらは「既存キーが全て残っていること（下位集合でないこと）」と「足しているキーが上記に限られること」を検証する。
- **`get_candles(view=items)` の `structuredContent` 封筒（`{ items, meta }`）は本リリースでは変更しない。** `items` は後続で `view=full` + `format=json` に置き換える予定があり、そこで同時に直せば外部クライアントが受ける破壊は 1 回で済むため。現状の逸脱は上記テストで形を固定してある。

### Fixed（プロンプトが存在しない `view` 値を指示していた）
- **`中級：BTCのフロー分析をして` プロンプトが `get_flow_metrics` に存在しない `view=detailed` を指示していた問題を修正**（`view=compact` に差し替え）。同ツールの enum は `summary` / `compact` / `buckets` / `full` で `detailed` は無い。SDK v2 はハンドラ実行前に `inputSchema` で入力を検証するため、プロンプトの指示どおり呼ぶと**ツール呼び出しが validation error になる**（黙って既定値に倒れるのではなく失敗する）。差し替え先に `compact` を選んだのは、このプロンプトの用途が「CVD 推移・スパイク・直近 1-3 時間重視」で `limit=300` / `bucketMs=60000`（最大約 300 バケット）のため。`full` は 300 行で用途に対して重く、`buckets` は既定 10 件で推移を追うには短い。`compact` は非ゼロバケットのみを出しつつ欠損を区間表記で残す。
- **再発防止テストを追加**（`tests/prompts_contract.test.ts`）。全プロンプトの本文から `toolName(..., view=xxx, ...)` を抽出し、`allToolDefs` の `inputSchema` が持つ `view` の enum で受理されるかを検証する。プロンプトはテストで実行されないため、この不整合は従来どのテストにも掛からなかった。**検査対象は `view` を明示している呼び出し例に限る**（`view` を渡していない呼び出し例は対象外で、プロンプトが参照するツール名一般の実在性は検証していない）。その範囲内では、ツール名を `allToolDefs` で解決できないケースと、`view` を持たないツールに `view` を渡しているケースも失敗として報告する（黙って検査をスキップしないため）。

### Changed（プロンプトとドキュメントを新しい `view` 語彙に追従させた）
**ツールの挙動変更は無い**（旧値は alias として受理され続けるため、追従前のプロンプトもそのまま動く）。語彙は導入したが呼び出し側が旧値のまま、という状態を残さないための追従。
- **同梱プロンプトが指示する `view` を新語彙へ差し替えた。**
  - `中級：BTCのフロー分析をして`: `get_flow_metrics(view=compact)` → `view=full, nonZeroOnly=true`、`get_transactions(view=summary)` → `view=full`。いずれも上表の写像どおりで**指示内容の意味は変わらない**。
  - `detect_patterns(view=detailed)` は新語彙でも有効値のため**変更なし**。
  - `🌅 おはようレポート`: `get_candles(view="items")` → **`view="full"` のみ**（`format` は付けない）。写像表の `view=full` + `format=json` は「旧 `items` と `content` を一致させる」ための写像であって、このプロンプトが必要とするものではない。用途はスパークライン用に 24 本の close を得ることで、既定の `view=full` + `format=text` のサマリ本文が全 24 本を 1 行 1 本の圧縮形式で含む。`format=json` にすると同じ 24 本が 10 行/本の pretty JSON になり（トークン増）、しかも `content` からサマリ本文・価格レンジ・キーポイント・出来高統計・フッタが消える。**JSON を要求する理由が無く、外したほうが軽くかつ LLM が受け取る情報は多い。**
- **`docs/tools.md` に「`view` の共通語彙」節を新設した**（従来 `view` パラメータの記載はゼロだった）。階梯（`summary` < `detailed` < `full`、`full` は常に最重量）、`full` が全件列挙になるのは主対象がレコード列のツールに限ること（`get_volatility_metrics` は該当せず、`full` でも系列そのものは出ない）、`view` が `structuredContent` からフィールドを削らないこと、`format` / `nonZeroOnly` は量ではなく形式 / 絞り込みの軸であること、階梯外の値（`debug` / `beginner`）は出力の置換であること、生データ系ツールの既定が全件列挙である理由、ツール別の値と既定、**非推奨の値と写像先**を記載した。`get_tickers_jpy` の `view` が本語彙の対象外であることも明記している。
- **`.claude/rules/tools.md` に `view` の規約を追記した**（開発者向け）。新規ツール追加時に守る 7 項目——量の 1 軸であること / `structuredContent` を削らないこと（削る・足す・入力のエコーの 3 分類）/ 階梯上の view は下位の上位集合であること / 量以外の軸を `view` の値に混ぜないこと / 「この view では〇〇が `content` に出ない」を description に書くこと / 規約をテストで固定すること / enum 値を変える際の alias 手順と型導出——を、`src/schema/base.ts` の共通文言と各共通テストへの導線つきで書いた。

### Changed（**挙動変更**: `get_flow_metrics` の `date` 指定で `limit` を適用しない）
- **`get_flow_metrics(date=YYYYMMDD)` が当該 UTC 暦日の全件を集計するようになった**（従来は「その UTC 日の最新側 `limit` 件」）。`since` / `until` の導入で区間指定パラメータが 3 系統になった際、`limit` の扱いが `date` だけ不揃いになっていた（`hours` は「`limit` は無視」、`since`・`until` は「指定時は `limit` を適用しない（区間の全件を集計）」、`date` のみ適用）。既定 `limit` は 100 なので `get_flow_metrics(date=20260801)` は末尾約 20 分ぶんを返しており、日付を指定した意図とはまず一致しなかった。切り捨て自体は `meta.truncated` / `meta.totalAvailable` / warning で申告されていた（黙って壊れてはいない）が、既定の挙動として不適切だった。
  - **`date` + `limit` で少数サンプルを取っていた利用は結果が変わる。** 直近 N 件が欲しい場合は `date` を外して件数ベース取得（`date` / `hours` / `since`・`until` をどれも指定しない呼び出し）を使うこと。
  - **上限引き上げではなく `limit` の適用除外を選んだ理由**: 1 UTC 日は BTC/JPY で実測 5,609〜8,040 件あり、`limit` 上限 2000 に上げても 6〜8.5 時間分にしか届かない。上限を「1 日の最大約定数」に追随させるのは上流の出来高次第で破綻する追いかけっこであり、しかも `date` 以外の区間指定（`hours` / `since`・`until`）は既に `limit` 非適用なので、上限を上げても `date` だけが不揃いなまま残る。区間を指定したら区間の全件、という 1 本のルールに揃えた。
  - 切り捨てが起きなくなった経路では `meta.totalAvailable` / `meta.truncated` を**付けない**（`hours` / `since`・`until` と同じ）。切り捨て warning も出ない。
  - `meta.actualRange.requestedMinutes` は従来どおり当該 UTC 暦日の 1440 分。全件を集計するので `coveragePct` は通常ほぼ 100% になり、下回った場合はアーカイブ側の欠損を意味する（旧実装では `limit` による切り捨てとアーカイブ欠損が同じ数値に混ざっていた）。
  - **アーカイブ未公開（進行中・未来の UTC 日）→ latest フォールバックでも `limit` は適用しない**（= latest の全件、約60件）。ここだけ効かせると、同じ `date` 指定でもアーカイブが公開済みか否か——つまり呼んだ時刻と上流の公開タイミング——で `limit` が効いたり効かなかったりし、呼び出し側から区別できない非決定的な挙動になる。実害も無く、latest は約60件で既定 `limit`（100）を下回るため適用しても通常は何も切れず、小さい `limit` を渡したときにだけ「未公開日の警告付き結果がさらに黙って削られる」方向にしか働かない。warning には「要求した UTC 暦日の全件ではありません」を明示する。
  - **`limit` 上限 2000 は据え置き**（再評価のうえ）。`date` が `limit` から解放されたことで `limit` の用途は「直近 N 件」だけになったが、2,000 件 ≒ BTC/JPY で 6〜8.5 時間分と件数指定としては十分に長く、これより長い窓は件数ではなく時間で指定するほうが要求が一意になる。上限を上げると件数ベースの補完（`lib/tx-fetch.ts` の `fetchSupplementTxs` は `limit > 500` で 2 日ぶん = 約 11,000〜16,000 件）を超えて 3 日目以降のアーカイブ取得が必要になり、リクエスト数と rate limit を消費する割に同じ範囲は `since`・`until` で切り捨てなく取れる。下げても応答はバケット / 価格帯の集計でトークン量が件数に比例しないため実益が無く、既存の呼び出しを壊すだけ。根拠は `MAX_TX_COUNT_LIMIT`（`src/schema/base.ts`）のコメントに集約し、`get_flow_metrics` / `analyze_volume_profile` 両方の `.max()` をこの定数に寄せた（値は不変）。
  - `date` の description から「`limit` 上限より 1 日の約定数が多いので 1 日全体をカバーできない」という**自分の欠陥を回避手段で説明する**文面を削除し、「当該 UTC 暦日の全件を集計する（`limit` は適用しない）」に書き換えた。`since`/`until` への誘導は残している（複数日にまたがる区間や、UTC 暦日の境界に揃わない区間——JST の 1 日など——は `date` では表現できないため）。`limit` の description には適用範囲（件数ベース取得でのみ有効）を明記した。`analyze_volume_profile` の `limit` も同じ文面に揃えている（同ツールに `date` は無いので対象は `hours` / `since`・`until` のみ）。
  - `analyze_volume_profile` に `date` パラメータは無く、挙動変更はない（`limit` の description のみ）。

### Added（`lib/calendar.ts`: 暦日プリミティブの集約）
- **`lib/calendar.ts` を新設**。暦日（カレンダーデー）の計算がリポジトリ内に分散しており、lib-first ルールに反していた（`lib/tx-archive.ts` = UTC 暦日キーの生成・範囲列挙、`tools/get_candles.ts` = tz 暦日 window ↔ UTC chunk key 変換で約320行、`tools/analyze_candle_patterns.ts` = UTC 暦日の終端、`tools/trading_process/lib/fetch_candles.ts` と `src/handlers/portfolio/calc.ts` ほか計4ファイル = JST ハードコードの暦日境界）。分散の実害として `date` パラメータの暦基準がツール間で割れており（`get_transactions` 系は UTC 暦日、`get_candles` 系は `tz` 引数の暦日）、実機テストで取得区間の取り違えが起きている（緩和として #10 で description に明記済み）。
  - 提供する操作: 境界（`startOfDayMs` / `endOfDayMs` / `startOfYearMs` / `endOfYearMs`）、キーの生成とパース（`toDayKey` / `toYearKey` / `isDayKeyFormat` / `isYearKeyFormat` / `parseDayKey` / `parseYearKey` / `shiftDayKey`）、範囲列挙（`enumerateDayKeys` / `enumerateYearKeys`）、完了判定（`isDayKeyCompleted` / `recentCompletedDayKeys`）、tz 検証（`isSupportedTimeZone`）。
  - **tz は必ず明示引数**で受ける（`'UTC'` も普通の tz として渡す）。既定値を暗黙に `'Asia/Tokyo'` にすると、現在起きている「同じ関数名で暦の基準が違う」問題を lib 側に持ち込むことになるため。不正 tz を既定値へ倒すかは呼び出し側のポリシーなので、lib は `isSupportedTimeZone()` で判定手段だけを提供する。
  - **範囲列挙はキーの日付演算で進める**（ミリ秒に 24h を足さない）。DST で 23 時間 / 25 時間になる日、DST 開始が 00:00 で「その日の 0 時が存在しない」tz（`America/Sao_Paulo` 2017-10-15）、オフセットが 30 分だけ動く tz（`Australia/Lord_Howe`）、月末・年末・閏日を跨いでも日が飛ばず重複もしない。
  - **`parseDayKey` は実在日を検証する**。`dayjs.tz('2026-02-30', tz)` は例外を投げずに 3/2 へ繰り上げるため、tz を当てる前に UTC の strict parse で弾く。一方 `isDayKeyFormat` は形式（`/^\d{8}$/`）のみを見る（既存 `isArchiveExpectedPublished` と同じ粒度を保つため）。
  - **不正 tz / 非有限 ms は `TypeError`**。`NaN` や `'Invalid Date'` を黙って伝播させると原因の遠い場所で壊れる。キー文字列の形式不正はユーザー入力由来なので throw せず `null` / `false` を返す。
- **`lib/tx-archive.ts` を `lib/calendar.ts` の上に載せ替えた（挙動不変）**。bitbank の約定アーカイブ仕様（UTC 暦日単位・当該日完了後に公開）というドメイン知識を持つ層としては残し、中身の暦日計算だけを委譲する。既存 export（`currentUtcDayKey` / `currentUtcDayStartMs` / `isArchiveExpectedPublished` / `recentCompletedUtcDayKeys` / `completedUtcDayKeysInRange`）のシグネチャと挙動は変えていない（`tests/lib/tx-archive.test.ts` を無改変で通すことを挙動不変の証明とした）。
- **`tools/get_candles.ts` を `lib/calendar.ts` の上に載せ替えた（挙動不変）**。tz 暦日 window ↔ UTC chunk key の変換で約320行あった暦日計算のうち、**汎用の暦計算を lib へ、bitbank API 固有の chunk 戦略を `get_candles` に**残した。この分割の判断基準は「bitbank が `/candlestick` を UTC 暦日 / UTC 暦年でしか返さない」という上流仕様に依存するかどうか。`tests/get_candles.test.ts` を無改変で通すことを挙動不変の証明とした（移行 4 コミットのいずれもテストファイルを触っていない）。
  - **lib へ移した**もの: 不正 tz の判定（`isSupportedTimeZone`）、暦日 / 暦年の区間化（`parseDayKeyAllowingOverflow` / `parseYearKey`）、window と交差するキーの列挙（`enumerateDayKeys` / `enumerateYearKeys` — 自前の cursor ループと `enumerateUtcYearsIntersectingWindow` を削除）、暦年の先頭（`startOfYearMs`）、経過暦日数（`diffCalendarDays`）、現在時刻がどの暦日 / 暦年か（`toDayKey` / `toYearKey`）。結果として `get_candles` から dayjs の直接利用が無くなった。
  - **`get_candles` に残した**もの: chunk key の形式と粒度（`YEARLY_TYPES` = `YYYY` / `DAILY_TYPES` = `YYYYMMDD`）、chunk の暦が UTC 固定であること（`FETCH_CHUNK_TZ`）、`date` の文法（`YYYYMMDD` は暦日、`YYYY` は `YEARLY_TYPES` 限定の互換形式）、本数の見積り（`BARS_PER_YEAR` / `BARS_PER_DAY` / `INTERVAL_MS` による按分と `yearsNeeded`）、公開遅延のハンドリング（進行中 UTC 期間の 404 / `success:0` を「データ未生成」として実失敗と分ける処理）、不正 tz を `Asia/Tokyo` へ倒すというフォールバック方針。
  - **`computeAnchorEndMs` / `computeAnchorStartMs` を `computeAnchorSpan` に統合**した。分岐条件が同一で終端・先頭だけが違う対の関数だったため、`CalendarSpan` を返す 1 関数にまとめている。公開 API ではなくモジュール内部の関数なので外部影響はない。
  - **`date` の解釈・limit 上限・chunk 戦略・エラーメッセージはいずれも変えていない。** 実在しない `date`（`20260230` 等）を繰り上げ解釈する現行挙動も維持した（`validateDate` は形式しか見ないためこの入力は実装まで到達する）。厳密解釈へ倒すと anchor が無効化されて「最新側 limit 本」に silent に化けるため、この一点は今回の移行では踏み込まず回帰テストで固定するに留めた。
- **`lib/calendar.ts` に 2 操作を追加**（`get_candles` の移行で C-1 の API では表現できなかったもの。tz を明示引数で受ける原則は維持）。
  - `parseDayKeyAllowingOverflow`: 実在しない日付をグレゴリオ暦の繰り上げで解釈する（`20260230` → 3/2）。`lib/validate.ts` の `validateDate` のように**形式だけ**を検証する層を通った値を扱う呼び出し側のための入口で、繰り上げるかどうかを関数の選択として明示させる。既定は実在日を要求する `parseDayKey`。
  - `diffCalendarDays`: 2 つの瞬間が属する tz 暦日の差。ミリ秒差を 86400000 で割ると DST を挟む tz で 1 日ずれる（`America/New_York` の 2025-01-01 → 06-16 は ms 差が 165 日 23 時間）ため、暦日キーの日付演算で数える。
- **残る 5 ファイル 6 箇所の暦日計算を `lib/calendar.ts` に載せ替えた**（暦日計算そのものは挙動不変。唯一の挙動変更は後述の深夜跨ぎ修正）。これで `startOf('day')` / `endOf('day')` の直書きは `lib/calendar.ts` の中だけになった。`date` パラメータの暦基準の統一（破壊的変更）と当日損益の計算基準日の変更は本変更に含まない。
  - **`tools/analyze_candle_patterns.ts`**: `as_of` / `date` 指定時に「その日までの足」を切り出す UTC 暦日終端を `parseDayKeyAllowingOverflow` に委譲し、暦基準を `AS_OF_FILTER_TZ` という名前付き定数にした。繰り上げ許容版を選んだのは `normalizeDateToYYYYMMDD` が形式しか見ず実在しない日付が到達しうるため（従来の `dayjs.utc('2026-02-30')` は 3/2 へ繰り上げていた）。**この箇所の暦基準が UTC のままである点も現行維持**で、`get_candles` は同じ日付キーを `tz` 引数の暦日（既定 Asia/Tokyo）として解釈しており基準がずれているが、揃えると「どの足まで含めるか」が変わる仕様変更になるため踏み込まず、定数のコメントに残した。
  - **`tools/trading_process/lib/fetch_candles.ts`**: `start_date` / `end_date` の JST 暦日終端を `endOfDayMs` に、「今日から `start_date` まで遡る日数」を `diffCalendarDays` に委譲し、2 箇所にハードコードされていた `'Asia/Tokyo'` を `BACKTEST_CALENDAR_TZ` に集約した。遡る日数は「今日の 23:59:59.999 との ms 差を 86400000 で割って切り上げ」＝暦日差 + 1 であり、JST は DST が無いため結果は一致するが、この割り算は `diffCalendarDays` が明示的に禁じている形なので暦日差に置き換えて当日ぶんの +1 を式として見えるようにした（JST 00:00 ちょうど / 直前 / 直後を含む 8 つの現在時刻 × `start_date` -6000〜+5 日、および JST 0:00 以外の `start` の計 48,088 ケースで新旧一致を確認）。不正な日付を「Invalid date format」で弾く順序も維持している（`lib/calendar.ts` は非有限 ms に `TypeError` を投げるため、暦日終端を当てる前にチェックする）。
  - **`analyze_my_portfolio` の「JST 当日の開始」3 実装を共通化**。当日損益の起点（`portfolio/calc.ts`）、日次価格マップのキー正規化（`portfolio/fetch.ts`）、資産推移の日次点の打ち止め（`analyzeMyPortfolioHandler.ts`）が同じ計算を別々に持っていた。この 3 つは**同じ暦日境界でなければ壊れる**（日次価格は JST 0:00 の ms をキーに持ち資産推移側がその ms で lookup するため、片方だけずれると全点が現在価格フォールバックに落ちて `equitySeriesQuality` が実態と乖離する）。`src/handlers/portfolio/calendar.ts` を新設し、暦日計算は `lib/calendar.ts` に委譲したうえで基準の共有をこのモジュールに集約した。
    - **tz は定数（`PORTFOLIO_CALENDAR_TZ`）のままにした**。当日損益の計算基準は仕様であって呼び出し側の自由度ではなく、外出しするには上流 `fetchCandlePriceData` が `getCandles` に渡す tz（＝日足の区切り）と出力 ISO のオフセット前提まで一貫して通す必要があり、「当日損益の計算基準日の変更」という仕様変更とセットになるため。判断理由はモジュール冒頭のコメントに残し、`getCandles` に渡していた `'Asia/Tokyo'` リテラルも同じ定数に寄せて暦を変えるときの起点を 1 箇所にした。
    - **リクエスト中に JST 00:00 を跨ぐと資産推移に幽霊の 1 点が入る問題を修正**（本 PR で唯一の挙動変更。既存バグで、移行で持ち込んだものではない）。資産推移の日次点・月次点の終端だけが、リクエスト開始時に確定した `boundaries` ではなく**時計を読み直して**決まっていた。`boundaries` は `fetchCandlePriceData` に渡す取得条件そのものなので、API 応答を待っている間に日付が変わると「取得済みの日次価格に存在しない翌日」が 1 点増え、その点だけ現在価格フォールバックに落ちる（JST 00:00 を跨いだ瞬間に発生し、月跨ぎでは月次点にも同じことが起きる）。終端を `boundaries.dayStartMs` / `boundaries.monthStartMs` から導くようにして、ハンドラ側の 2 度目の時計読みを削除した。JST 23:59:59.9 に処理を開始し candlestick 応答中に日付を跨がせる回帰テストを追加している（修正前は日次点に `2026-08-03T00:00:00+09:00` が余分に現れることを確認済み）。
    - **当日損益の起点に境界時刻の回帰テストを追加**（従来は `getJstPeriodBoundaries` のテストが 1 件も無く、暦日境界がずれても既存テストは緑のままだった）。JST 00:00 ちょうど / 1ms 前 / 1ms 後 / 23:59:59.999、UTC 日付の変わり目（JST 09:00）の前後、JST 深夜（UTC ではまだ前日）、元日、実行環境 TZ = UTC を固定クロックで検証する。日次価格マップのキーが JST 暦日 0:00 になることも `JST 09:00 = UTC 00:00` の足で判別できる形で固定した。`PORTFOLIO_CALENDAR_TZ` を `'UTC'` に変えると 10 件落ちることを確認済み。
  - **対象外**と判定した箇所（暦日計算ではないため）: `tools/prepare_chart_data.ts`（ISO 文字列のミリ秒パース）、`tools/render_chart_svg.ts`（表示用の同日判定）、`lib/provisional-bar.ts`（月単位の加算）。

### Added（since / until による絶対時刻区間指定）
- **`get_flow_metrics` / `analyze_volume_profile` に `since` / `until` を追加**。過去の特定区間を**全件**集計できるようになった。従来は「過去の任意区間を取り切る手段が無い」状態だった: `hours`（最大24）は**現在時刻起点**の相対窓なので過去区間を指定できず、`date`（UTC 暦日）は `limit` 上限 2000 で切り捨てられる（実測 2026-08-02: `get_flow_metrics(date=20260801, limit=2000)` は UTC 8/1 の 4,781 件のうち末尾 2,000 件＝8.3 時間分のみを返した）。切り捨て自体は `meta.truncated` / warning で申告されるようになっていたが、**申告されるだけで取得する手段が無かった**。実機テストではこの制約下で LLM が「翌日 JST 09:00 以降に `date=20260802` で取り直せば全件取れる」と誤案内している（実際に返るのは UTC 8/2 の末尾 2,000 件＝JST 8/3 早朝で、欲しかった JST 8/2 午前〜午後とは重ならない）。
  - **形式はオフセット付き ISO8601 のみ**（例: `since=2026-08-01T00:00:00Z`, `until=2026-08-02T09:00:00+09:00`）。秒とミリ秒は省略可。`YYYYMMDD` を採らなかったのは、同じ `date: 'YYYYMMDD'` でも暦の基準がツール間で割れており（`get_transactions` / `get_flow_metrics` は UTC 暦日、`get_candles` / `validate_candle_data` は `tz` 引数の暦日）、実機で取得区間の取り違えが起きたため。オフセット必須にすると「どの暦で解釈されるか」が入力そのものから一意に決まる。
  - **`until` は排他**（`[since, until)`）。`since=2026-08-01T00:00:00Z, until=2026-08-02T00:00:00Z` がちょうど UTC 8/1 の 1 日で、隣接区間を続けて要求しても境界の約定が二重計上されない。省略時は現在時刻まで。
  - **`hours` / `date` とは排他**（併用は user エラー）。暗黙の優先順位を置くと、要求と異なる区間の集計値が返っても応答から気づけない。
  - **`limit` は適用しない**（`hours` 指定時と同じ）。区間の全件が `CVD` / アグレッサー比 / VWAP / POC / Value Area に入る。
  - **最大範囲は 7 日**（`MAX_TX_RANGE_DAYS`）。1 日 = 1 リクエスト・BTC/JPY で 5,600〜8,000 件のため、7 日で最大 8 リクエスト・約 56,000 件の並列取得と dedup になる。超過は user エラーで、期間の分割を案内する。
  - カバレッジ申告は**既存機構をそのまま再利用**する。`meta.actualRange.requestedMinutes` に `(until - since) / 60000` が入り、`coveragePct` / `buildTxCoverageWarning` / `buildAggregateCoverageNote` が従来どおり機能する。完了済み UTC 日のみの区間ならカバー率はほぼ 100% で警告は出ず（誤検知しない）、進行中 UTC 日にかかる区間では latest 約60件ぶんまで落ちて既存の warning が発火する。
  - `meta.mode='absolute_range'` と `meta.range`（要求区間の UTC ISO8601）を追加。`hours` 指定時の `mode='time_range'` / `meta.hours` は従来どおり。
- **過去区間のみの要求では `/transactions` (latest) を叩かなくなった**。latest は現在の約定しか返さないため、過去区間では区間外のデータしか得られずリクエストと rate limit の無駄になる。取得区間が進行中の UTC 日にかかる場合のみ叩く（`hours` 指定は終端＝現在時刻なので従来どおり常に叩く）。あわせて「進行中の UTC 日 (…) は latest で補完しています」という注記も、実際に latest を使った場合のみ出すようにした。
- **`lib/tx-fetch.ts` の `fetchTxTimeRange` を絶対区間 `{ sinceMs, untilMs }` に一般化**（挙動不変）。`hours` から `sinceMs` を内部計算していたため過去区間を取得できなかった。`hours` → 区間の変換は呼び出し側に移し、取得層は絶対区間だけを扱う。`completedUtcDayKeysInRange` には第3引数 `nowMs` を追加し、「進行中の UTC 日」の判定を区間の終端ではなく実時刻で行えるようにした（既定は従来どおり終端時刻。過去区間で渡さないと完了済みの日を進行中と誤判定して公開済みアーカイブを列挙しない）。

### Fixed（要求窓に対するカバレッジ不足の申告）
- **内部欠損が無い場合のカバレッジ不足が警告されなかった問題を修正**（`get_flow_metrics` / `analyze_volume_profile`）。カバレッジ warning は区間内部の欠損（gaps）にのみ反応していたため、窓の**先頭・末尾側**が未カバーのケース——実測では `hours=4` の窓が丸ごと進行中 UTC 日内にあり latest 約60件（≒34分、カバー率 14%）しか取れない状況——で、原因を述べる「進行中の UTC 日…」の行だけが出て**不足の大きさがどこにも定量表示されなかった**。#8 で削除した旧注記はこのケースで発火していた（カバー率 80% 未満で定量表示）ため、この 1 ケースに限っては退行でもあった。
  - 取得層 `meta.warning`: 要求窓の 80% 未満なら gaps が空でも発火し、カバー率と「実データ区間（開始〜終了）の外側 N分 は未カバー」を明示する。内部欠損と窓外未カバーが同時にある場合は併記。閾値 80% は旧注記と同じ値を踏襲（`COVERAGE_SHORTFALL_WARN_PCT`）。
  - 計算層 `meta.warnings`: 同条件で「集計値は要求した時間窓（N分）全体を代表する値ではありません」を追記。
  - 要求窓を 80% 以上満たしていれば従来どおり何も出ない（誤検知しない）。`hours` 未指定の件数ベース取得も従来どおり対象外。

### Fixed（limit による切り捨ての申告）
- **`get_flow_metrics` / `analyze_volume_profile` の件数ベース取得が `limit` による切り捨てを無言で行っていた問題を修正**。1 UTC 日は BTC/JPY で 5,600〜8,000 件あるのに `limit` 上限は 2000 のため、`date=YYYYMMDD` 指定では 1 日の 1/3 程度しか集計に入らない。にもかかわらず `meta.actualRange` は「実カバー = スパン」を報告しており、**完全にカバーしたように見えていた**（カバレッジ申告は欠損区間には反応するが、末尾切り捨てには反応しなかった）。実測では `date=20260801, limit=2000` が UTC 暦日 24 時間のうち末尾 8.3 時間分しか返さず、`buy%` / `finalCvd` がその区間のみの値であることが応答から分からなかった。
  - `meta.totalAvailable`（limit 適用前の件数）/ `meta.truncated` を追加（`get_transactions` の `totalFetched` / `truncated` と対応）。
  - 切り捨て時は取得層 `meta.warning` に件数・`limit`・対象スコープ・代替手段（`hours` 指定なら `limit` を適用しない）を明示。
  - `date` 指定時の `actualRange.requestedMinutes` を当該 UTC 暦日（1440 分）に設定。`coveragePct` に「1 日のうちどれだけを見たか」が現れる（実測相当のケースで 2〜35%）。
  - `hours` 指定時は `limit` を適用しないため `totalAvailable` / `truncated` は付かない（従来どおり）。

### Changed（`date` パラメータの暦基準を明記）
- **`date` の暦基準をパラメータ description に明記**。同じ `date: 'YYYYMMDD'` でもツールによって基準となる暦が異なる（`get_transactions` / `get_flow_metrics` は **UTC 暦日**＝bitbank の約定アーカイブ単位、`get_candles` / `validate_candle_data` は **`tz` 引数の暦日**＝既定 Asia/Tokyo）。ツール本体の description には UTC である旨の記載があったが、パラメータ側は `'YYYYMMDD; omit for latest'` のみで基準が分からず、片方の基準で他方を呼ぶと無言でズレる（実測: `get_candles(date=20260801)` を既定 tz で呼ぶと JST 8/1 23:59 = 8/1 14:59 UTC で打ち切られ、16:44 UTC の足が範囲外になる）。相互参照つきで両側に明記し、`tests/date-semantics-contract.test.ts` で契約として固定した。
- あわせて `get_flow_metrics` の `date` に、**`limit` 上限（2000）より 1 UTC 日の約定数（BTC/JPY で 5,600〜8,000 件）が多いため date 指定では 1 日全体をカバーできない**旨と、`hours` への誘導を追記。

### Changed（カバレッジのギャップ閾値）
- **`DEFAULT_TX_GAP_MS` を 5 分 → 15 分に変更**（`lib/tx-fetch.ts`）。5 分では BTC/JPY の閑散帯を毎晩「取得欠損」として誤検知していた。実測（2026-08-01）で (a) JST 深夜 00:00〜05:00 の無約定区間は 47 分に 1 回・それ以外は 485 分に 1 回と**発生頻度に約 10 倍の開き**があり（取得欠損なら時刻とこれほど相関しない）、(b) 最長の閑散区間 7.5 分（JST 01:43:40〜01:51:12）を別系統の `/candlestick` (1min) で確認すると **7 本連続で volume=0・OHLC が前足終値に張り付き**＝本当に約定が無かったことが裏付けられた。検出したい実欠損（UTC 日アーカイブの取得失敗 / 進行中 UTC 日が latest 約60件のみ）はいずれも時間スケールでしか起きないため、15 分でも取りこぼさない。この変更で誤検知ぶんが実カバー時間に算入され、`coveredMinutes` / `hasData` / Z スコアの母集団がより実態に近づく。

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
- `GetFlowMetricsMetaSchemaOut` / `AnalyzeVolumeProfileMetaSchemaOut` に `totalAvailable`（number, optional）/ `truncated`（boolean, optional）を追加。件数ベース取得時のみセットされる。
- `FlowBucketSchema` に `hasData`（boolean）を**必須**で追加。`false` は「約定ゼロ」ではなく「取得できていない（欠損区間）」を意味する。`data.series.buckets` を消費する外部クライアントは新フィールドを受け取る（既存フィールドは不変）。あわせて `view=compact` の `content` テキストでも欠損バケットが（区間表記で）残るようになった（従来は黙って除外されていた）。なお `structuredContent` 側の `view=compact` のフィルタは後述の「`view` は `structuredContent` を変えない」で**全廃**しており、返却バケットは欠損に限らず全件になる。
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
