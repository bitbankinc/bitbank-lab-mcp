/**
 * patterns/config.ts - 時間軸に応じたパラメータ設定
 *
 * パターン検出で使用するデフォルトパラメータを時間軸ごとに提供する。
 */

import { HS_SHOULDER_MAX_PCT, MIN_DEPTH_PCT, MIN_PATTERN_HEIGHT_PCT, type SizeThresholds } from './structural.js';

/**
 * パターンごとの最小整合度（下限ゲート）。
 *
 * **triple の 2 エントリしか無い。これは意図的で、抜けではない**（issue #206）。
 * #199 までは double / H&S の 4 エントリも並んでいたが、**どの検出器も読んでいない
 * 死んだ定義**だった（`detect_doubles.ts` / `detect_hs.ts` は本モジュールを import
 * すらしていない）。#206 で「配線する / 消す」を実測してから決め、**消すほうを採った。**
 *
 * ## triple の 0.6（issue #199 候補 1 で 0.7 から変更）
 *
 * **閾値そのものを緩めたのではなく、`confidence` のスケールが変わったので同じ位置に置き直した。**
 *
 * 旧 3 軸式 `(tolMargin + symmetry + per) / 3` は 3 項のうち 2 項が実質定数
 * （`symmetry` は実測 0.9752〜0.9997、`per` は 109/109 が 0.6）で、`base ≈ (tolMargin + 1.59) / 3`。
 * 算術的な下限が 0.557、実測の下限は 0.76 だったため、**0.7 という値はほとんど何も切っていなかった**
 * （標準コーパス実測でゲート棄却は構造単位 18/148 = 12.2%）。
 *
 * 新 4 軸式では `retracement`（許容帯の中央で 1・端で 0 という定義上、実測の中央値 0.55）と
 * `duration`（0.6 固定）が平均を押し下げ、実測レンジが 0.48〜1.00 に広がる。同じ 0.7 を残すと
 * **同じ数値がまったく別の仕事をする**——ゲート棄却が構造単位 58/130 = 44.6% に跳ね上がり、
 * 「形の良さの下限」だった検査が主フィルタに化ける（合成 fixture の教科書的トリプルトップまで落ちる）。
 *
 * 0.6 を採った根拠は 3 つあり、**3 つ目が triple 固有**である点が本表の形を決めている:
 *
 * 1. `detectPatternsViewsHandler` の低 confidence 警告ラベルが `confidence < 0.6`（type 非依存）
 * 2. `detect_patterns` が LLM に出す整合度の帯が「0.6 未満 = 形状不十分」（type 非依存）
 * 3. 形成中トリプルの上限 `FORMING_MAX_CONFIDENCE = 0.59`（`detect_triples.ts`）はこの 0.6 に
 *    合わせて置かれている——完成済みの下限を 0.6 にすると forming ≤ 0.59 / completed ≥ 0.60 で
 *    隣接し、帯が重ならない。**この上限は triple にしか無い。**
 *
 * 実測の裏取り（標準コーパス 800 + 実データ B 96 + 補助スイープ、構造単位 130）:
 * 0.6 が切るのは 18 件（13.8%）で、旧ゲートの 12.2% と同じオーダー＝floor のままでいられる。
 * かつ切られる 18 件は**全件が `retracement ≤ 0.1905` かつ全件が未ブレイク**
 * （中間構成点が許容帯の端にへばりついていて、ブレイクの裏付けも無い）という 1 つのクラスに収まる。
 * `levelMargin` は 0.5858〜0.9391 とばらけており、**同水準性だけで切られてはいない**
 * （＝旧 `tolMargin` 一本足打法とは別の切り方になっている）。詳細は
 * tjackiet/bitbank-lab-mcp#199 の計測記録（Phase 2）。
 *
 * ## ⚠️ 「分布の空白に置いた線」という根拠は #199 候補 2 で崩れた（0.6 は現在つまみ）
 *
 * 上の記述は元々「分布上 0.55〜0.59 が空なので 0.55〜0.60 のどこに置いても切れ方は同じ」で
 * 締めていた。**この性質は `duration` をバー数基準に移した時点で失われている**
 * （#199 候補 2 / tjackiet/bitbank-lab-mcp#199 の計測記録）。同一の計測基盤
 * （検出器層 1,056 ケース = 24 系列 × 全 11 時間足 × `swingDepth` 4 種。ゲート到達を構造単位で集計）で:
 *
 * | | before（暦日基準） | after（バー数基準） |
 * |---|---:|---:|
 * | ゲート到達の構造 | 257 | 261 |
 * | うち confidence が 0.55〜0.59 | **1**（1 系列のみ） | **28** |
 * | 閾値 0.55 / 0.58 / 0.60 の通過数 | 227 / 226 / 226 | **251 / 236 / 223** |
 *
 * つまり **0.01 動かすと通過集合が動く**ようになった＝0.6 は「空白に置いた線」ではなく
 * **任意のつまみ**になっている。**値は本 PR では動かしていない**（0.6 を選んだ 3 つの根拠のうち
 * 空白帯以外の 2 つ——低 confidence 警告ラベルの `< 0.6`、`FORMING_MAX_CONFIDENCE = 0.59` との
 * 隣接——は今も成り立つ）が、**「非任意だから安全」という説明はもう使えない。**
 * 再評価は別 issue（本 PR では結論を出していない）。
 *
 * なお **before の時点でも厳密には空ではなかった**（`1week` / `swingDepth` 6 の 1 構造が 0.57）。
 * 「空」は #214 が用いた**より狭い検出器コーパス**（構造単位 130 件）で成り立っていた性質で、
 * 全 11 時間足へ広げると 1 件出る。本 PR の変化はその 1 件を 28 件にしたもの。
 *
 * ## なぜ double / H&S には下限を置かないのか（issue #206。**新しく足さないこと**）
 *
 * 「triple にあるなら他にも」で足したくなるが、**上の 0.6 を非任意にしていた性質が
 * double / H&S には無い。** #206 Phase 1 の実測（同じ 940 ケース。構造単位）:
 *
 * | | triple | `head_and_shoulders` | `inverse_head_and_shoulders` | `double_*` |
 * |---|---|---|---|---|
 * | 分布の空白帯 | **0.55〜0.59 が空**（#199 候補 2 で解消。上の ⚠️ 節を参照） | 0.42 から連続で空白なし | 0.45 から連続で空白なし | 実測が 0.65 以上にしか無い |
 * | 0.6 が切る集合 | 1 クラス（全件 `retracement ≤ 0.1905` かつ全件未ブレイク） | **直上の 0.60〜0.64 と全 6 軸で見分けが付かない** | 同左 | **0 件（no-op）** |
 * | 値の感度（構造単位） | 0.55〜0.60 のどこでも 18 件 | 0.58→23 / 0.60→33 / 0.62→45 件 | 0.58→49 / 0.60→72 / 0.62→95 件 | 0.65 に 5 件が同値で載る |
 *
 * つまり triple の 0.6 は**分布の空白に置いた線**（値がつまみでない）**だった**が、
 * #199 候補 2 でその非対称性は消えている（上の ⚠️ 節）。**それでも H&S / double に下限を
 * 新設しない結論は変わらない**——triple 側の根拠が 1 つ弱くなっただけで、H&S / double 側の
 * 「任意の位置で連続分布を切るつまみになり、切った集合が 1 つのクラスにもならない」は
 * そのまま成り立つ。#204 Phase 2 後の実データで
 * `head_and_shoulders` の 0.69（`timeSymmetry` 0.3111 が効いて下がった構造。旧 3 軸式では 0.95）
 * は #198 が 1hour で検出可能にしたものそのもので、**0.7 を置くと消える。**
 * 値の根拠が無いまま load-bearing な構造の 0.01 下にゲートを置くことになる。
 *
 * 下限を置かない代わりに、低整合度は**消さずにラベルを付けて出す**
 * （`detectPatternsViewsHandler` の `⚠️ 信頼度: 低い（形状不十分・単独判断不可、他指標と必ず併用）`）。
 * 「消す」か「ラベルを付ける」かは type ごとの方針の違いで、triple だけが「消す」側なのは
 * 上の 3 つ目の根拠（`FORMING_MAX_CONFIDENCE` との隣接）と棄却集合のクラス性が
 * triple にしか無いため。実測ログは tjackiet/bitbank-lab-mcp#206 の計測記録。
 */
export const MIN_CONFIDENCE: Record<string, number> = {
	triple_top: 0.6,
	triple_bottom: 0.6,
};

/** スキーマのデフォルト値（サーバ側で埋められる値） */
export const SCHEMA_DEFAULTS = {
	swingDepth: 7,
	minBarsBetweenSwings: 5,
	tolerancePct: 0.04,
} as const;

/**
 * 時間軸に応じたスイング検出パラメータを返す
 */
export function getDefaultParamsForTf(tf: string): { swingDepth: number; minBarsBetweenSwings: number } {
	const t = String(tf);
	// 期待動作（例）の目安に基づくデフォルト
	if (t === '1hour') return { swingDepth: 3, minBarsBetweenSwings: 2 };
	if (t === '4hour') return { swingDepth: 5, minBarsBetweenSwings: 3 };
	if (t === '8hour') return { swingDepth: 5, minBarsBetweenSwings: 3 };
	if (t === '12hour') return { swingDepth: 5, minBarsBetweenSwings: 3 };
	if (t === '1day') return { swingDepth: 6, minBarsBetweenSwings: 4 };
	if (t === '1week') return { swingDepth: 7, minBarsBetweenSwings: 5 };
	if (t === '1month') return { swingDepth: 8, minBarsBetweenSwings: 6 };
	// 分足はやや緩め（ノイズ多めのため最小幅は確保）
	if (t === '30min') return { swingDepth: 3, minBarsBetweenSwings: 2 };
	if (t === '15min') return { swingDepth: 3, minBarsBetweenSwings: 2 };
	if (t === '5min') return { swingDepth: 2, minBarsBetweenSwings: 1 };
	if (t === '1min') return { swingDepth: 2, minBarsBetweenSwings: 1 };
	// フォールバック（日足相当）
	return { swingDepth: 6, minBarsBetweenSwings: 4 };
}

/**
 * 時間軸に応じた許容誤差（`tolerancePct`）を返す。
 *
 * ## ⚠️ 短い足ほど**緩い**のは意図（#244 中間決定 2。動かさないこと）
 *
 * 表は `1day` 4% に対し `1hour` 5% / `15min` `30min` 6% と、**短い足ほど緩くなっている**。
 * ATR で正規化すると `1hour` の 5% は **8.8 ATR**（`1day` の 4% は 1.5 ATR）で、#152 が
 * サイズ下限に入れた ATR 比補正とは**向きが逆**。これは #244 で明示的に検討したうえで
 * **動かさないと決めた**（issue #244 の中間決定コメント 2）。理由は 3 つ:
 *
 * 1. **公開スキーマパラメータ**（`detect_patterns` の `tolerancePct`）で、値の意味を
 *    時間足ごとに差し替えると外部クライアントの契約が黙って変わる
 * 2. **同水準判定以外へ波及する。** triple の `confidence` の採点軸（`levelMargin`）・
 *    形成中パターンの倍率（`FORMING_TOLERANCE_MULTIPLIER` 等）・他検出器の `near` に
 *    そのまま入っており、締めると `confidence_below_min` で落ちる構造が出る
 *    （#244 Phase 1 結果 9(a)）。#198 の「向きの逆な表の無検証流用」と同じ形になりうる
 * 3. **同水準判定の時間足追従は本関数の仕事ではない。** H&S の肩については
 *    {@link getHsShoulderMaxPctForTf} が担い（#244 Phase 2）、double / triple については
 *    高さ相対の無次元ゲート（`MAX_LEVEL_SPREAD_RATIO`）が実データ 1hour で律速している
 *    （#178 / PR #176 / PR #195。#244 Phase 1 結果 1 で 8/8 構造）
 *
 * つまり本関数は**上限側の天井**（{@link getHsShoulderMaxPctForTf} /
 * `HS_SHOULDER_MAX_PCT` / `DOUBLE_LEVEL_MAX_PCT`）と `min` を取られる側で、
 * **緩さの実効値はそちらが決める**。本関数を締めても同水準判定は締まらず、
 * 採点軸と forming だけが動く。
 */
export function getDefaultToleranceForTf(tf: string): number {
	const t = String(tf);
	if (t === '1hour' || t === '4hour') return 0.05; // 5%
	if (t === '8hour' || t === '12hour') return 0.045; // 4.5%
	if (t === '15min' || t === '30min') return 0.06; // 6%
	if (t === '1week') return 0.035; // 3.5%
	if (t === '1month') return 0.03; // 3.0%
	return 0.04; // 1day 他
}

/**
 * 時間軸に応じたサイズ検査の下限（パターン高さ / 戻りの深さ）を返す（issue #152）。
 *
 * `structural.ts` の {@link MIN_PATTERN_HEIGHT_PCT} / {@link MIN_DEPTH_PCT} は時間足に
 * 依らない固定パーセンテージだったため、**ボラティリティに対する難易度が時間足間で
 * まったく揃っていなかった**。ATR で正規化すると BTC/JPY で:
 *
 * | | 1day（ATR 2.75%） | 1hour（ATR 0.57%） |
 * |---|---|---|
 * | `MIN_DEPTH_PCT = 5%` | 1.82 ATR | **8.77 ATR** |
 * | `MIN_PATTERN_HEIGHT_PCT = 3%` | 1.09 ATR | **5.26 ATR** |
 *
 * 結果として 1hour では H&S が実質的に検出不能で（`limit=365` / `headProminencePct=0.01`
 * でも 0 件）、棄却理由の 39% がサイズ検査（`valley_too_shallow` / `peak_too_shallow`）だった。
 *
 * **設計上の約束が 3 つある。**
 *
 * 1. **実行時に ATR へ連動させない。** 値の導出にだけ ATR を使い、テーブルは凍結する。
 *    閾値が実データ（＝`limit`）の関数になると #154 の「窓を広げたのに検出が減る」を
 *    再導入する（#154 / PR #156 の結論。`getTriangleWindowSize` 等と同じく静的テーブル）。
 * 2. **アンカーは 1day で、現行値を据え置く。** `MIN_PATTERN_HEIGHT_PCT = 3%` /
 *    `MIN_DEPTH_PCT = 5%` がそのまま 1day の値になる。両方とも下限なので、下位時間足を
 *    緩める変更は**単調に検出が増えるか不変**にしかならない。
 * 3. **種別ごとに分けない。** double / triple / H&S が同じ値を共有する（#139 の共通化。
 *    値が割れていたせいで BTC/JPY 1時間足の高さ 1.66% のレンジ往復が `triple_top` と
 *    `triple_bottom` に同時に化けた）。時間足依存にするだけで、共有は維持する。
 *
 * ## 導出
 *
 * 1day を 1.0 とした ATR 比を各時間足に掛ける。**1day 以上は現行値のまま据え置く**
 * （1week / 1month はボラが 1day より大きいので √t を適用すると**締まる**方向になり、
 * 「緩める方向のみ」という本変更の前提に反する）。
 *
 * | 時間足 | ATR 比 | 由来 | `heightPct` | `depthPct` |
 * |---|---|---|---|---|
 * | `1min` | 0.0264 | √t 推定 | 0.08% | 0.13% |
 * | `5min` | 0.0589 | √t 推定 | 0.18% | 0.29% |
 * | `15min` | 0.1021 | √t 推定 | 0.31% | 0.51% |
 * | `30min` | 0.1443 | √t 推定 | 0.43% | 0.72% |
 * | `1hour` | 0.2073 | **実測**（ATR 0.57% / 2.75%） | **0.62%** | **1.04%** |
 * | `4hour` | 0.4082 | **√t 推定**（未実測） | **1.22%** | **2.04%** |
 * | `8hour` | 0.5774 | √t 推定 | 1.73% | 2.89% |
 * | `12hour` | 0.7071 | √t 推定 | 2.12% | 3.54% |
 * | `1day` | 1.0 | **実測**（アンカー） | **3%（据え置き）** | **5%（据え置き）** |
 * | `1week` / `1month` | — | 据え置き | 3% | 5% |
 *
 * **`4hour` は実測ではない。** BTC/JPY の 4hour ATR は測っておらず、1day の 2.75% から
 * √t で `2.75 / √6 = 1.12%` と推定した値を使っている（比にすると `1/√6 = 0.4082`）。
 * `1hour` の 0.57% は実測で、√t 整合も取れている（`0.57 × √24 = 2.79 ≈ 2.75`）。
 * 4hour の ATR を実測したら比を差し替えること。
 *
 * `1min` / `5min` / `15min` / `30min` / `8hour` / `12hour` も同じ √t 規則で導出した推定値。
 * 現行値のまま据え置く案もあったが、**据え置くとこれらの時間足には issue #152 の欠陥が
 * そのまま残る**（1hour より短い足はさらに ATR 比が小さいので、5% はより極端に厳しい）。
 * 下限を下げるだけなので検出は単調に増える方向にしか動かない。
 */
export function getSizeThresholdsForTf(tf: string): SizeThresholds {
	const t = String(tf);
	// 1day より短い足は ATR 比（1day = 1.0）で緩める。1hour のみ実測、他は √t 推定。
	if (t === '1min') return { heightPct: 0.0008, depthPct: 0.0013 };
	if (t === '5min') return { heightPct: 0.0018, depthPct: 0.0029 };
	if (t === '15min') return { heightPct: 0.0031, depthPct: 0.0051 };
	if (t === '30min') return { heightPct: 0.0043, depthPct: 0.0072 };
	if (t === '1hour') return { heightPct: 0.0062, depthPct: 0.0104 };
	if (t === '4hour') return { heightPct: 0.0122, depthPct: 0.0204 }; // 推定（4hour の ATR は未実測）
	if (t === '8hour') return { heightPct: 0.0173, depthPct: 0.0289 };
	if (t === '12hour') return { heightPct: 0.0212, depthPct: 0.0354 };
	// 1day / 1week / 1month / 未知の時間足: アンカーの現行値を据え置く
	return { heightPct: MIN_PATTERN_HEIGHT_PCT, depthPct: MIN_DEPTH_PCT };
}

/**
 * 時間軸に応じた H&S / 逆 H&S の**左右肩の同水準判定の上限**を返す（issue #244）。
 *
 * `structural.ts` の {@link HS_SHOULDER_MAX_PCT}（5% 固定）は時間足に依らない価格相対の
 * 上限だったため、ATR で正規化すると 1day の 1.8 ATR に対し **1hour では 8.8 ATR** に
 * 相当し、**同水準判定が実質機能していなかった**（#244 Phase 1 結果 3。accepted な
 * 逆 H&S の肩 `relDiff` は実データ 1hour で max 2.719% = 4.77 ATR ＝ 現行閾値の 54%）。
 * サイズ下限（{@link getSizeThresholdsForTf}）と頭の突出（{@link getHeadProminenceForTf}）は
 * #152 / #198 で ATR 比カーブに乗ったが、肩の同水準判定だけがこのカーブから漏れていた。
 *
 * **導出は {@link getSizeThresholdsForTf} と同じ ATR 比テーブルを、アンカー 0.05
 * （{@link HS_SHOULDER_MAX_PCT} の現行値 = 1day の値）に掛けただけ。** ATR を新たに
 * 測り直してはいない——#152 が「1day を 1.0 とした ATR 比」を既に測定 / 推定済み
 * （{@link getSizeThresholdsForTf} の docstring の表）で、本関数もそれをそのまま使う。
 * #152 の 3 つの設計上の約束をそのまま踏襲する:
 *
 * 1. **実行時に ATR へ連動させない。** 値の導出にだけ ATR を使い、テーブルは凍結する
 * 2. **アンカーは 1day で、現行値（5%）を据え置く。** 1day / 1week / 1month / 未知は不変
 * 3. **種別ごとに分けない。** H&S / 逆 H&S が同じ値を共有する
 *
 * ## 表
 *
 * | 時間足 | ATR 比 | 由来 | 値 |
 * |---|---|---|---|
 * | `1min` | 0.0264 | √t 推定 | 0.13% |
 * | `5min` | 0.0589 | √t 推定 | 0.29% |
 * | `15min` | 0.1021 | √t 推定 | 0.51% |
 * | `30min` | 0.1443 | √t 推定 | 0.72% |
 * | `1hour` | 0.2073 | **実測**（ATR 0.57% / 2.75%） | **1.04%** |
 * | `4hour` | 0.4082 | **√t 推定**（未実測） | **2.04%** |
 * | `8hour` | 0.5774 | √t 推定 | 2.89% |
 * | `12hour` | 0.7071 | √t 推定 | 3.54% |
 * | `1day` | 1.0 | **実測**（アンカー） | **5%（据え置き）** |
 * | `1week` / `1month` / 未知 | — | 据え置き | 5% |
 *
 * **`4hour` 以降は実測ではない。** BTC/JPY の 4hour ATR は測っておらず、1day の 2.75% から
 * √t で推定した比（`1/√6 = 0.4082`）を使っている。`1hour` の 0.57% は実測で、√t 整合も
 * 取れている（`0.57 × √24 = 2.79 ≈ 2.75`）。4hour の ATR を実測したら比を差し替えること。
 * `1min` / `5min` / `15min` / `30min` / `8hour` / `12hour` も同じ √t 規則で導出した推定値で、
 * この限界は {@link getSizeThresholdsForTf} 自身の `1hour` 以外の行と同じ位置づけ。
 *
 * ## ⚠️ 非恣意性は主張しない——値は「つまみ」
 *
 * **本関数の値が分布の空白帯に落ちているという主張はしていない**（`MIN_CONFIDENCE` の
 * ⚠️ 節と同じ扱い）。#244 Phase 1 §9 が実データ 1hour の accepted な逆 H&S について
 * 観測した隙間（B は肩 `relDiff` 0.460% と 1.356% の間の **0.896% 幅**、C / D は 0.460% と
 * 2.473% の間の **2.013% 幅**）は、**標本が 10〜14 構造しかないための空き**であって
 * 「ゼロから離れた集団」を分ける谷ではない。#214 の非恣意性テストの意味では**不合格**。
 *
 * 正当化は分布ではなく**次元の一貫性**にある: 同じ形の判定を全時間足で同じ ATR 本数で
 * 行う、という #152 の方針を肩の同水準判定にも適用しただけ。落ちる集合が構造として
 * 失格であることは #244 Phase 1.5 で**目視により**確認した（延べ 14 構造すべて「呼べない」。
 * tjackiet/bitbank-lab-mcp#244 の計測記録 §10）——値の非恣意性ではなく、**この値で落ちるものの
 * 妥当性**が根拠。
 *
 * ## 適用先は肩ゲートだけ。窓生成（`outerShoulderOk`）は 5% のまま
 *
 * {@link HS_SHOULDER_MAX_PCT} は `detect_hs.ts` の 2 箇所で使われている:
 *
 * | 使用箇所 | 本関数を適用するか |
 * |---|---|
 * | 肩ゲート（strict 2 経路 + relaxed 2 経路の `shouldersWithinCap`） | **する** |
 * | 窓生成（`enumerateHsWindows` → `outerShoulderOk`） | **しない**（5% 固定のまま） |
 *
 * **理由は診断性**（#244 決定コメントの宿題 1）。窓生成で落とすと `view=debug` に候補が
 * 現れず**無音**になるが、肩ゲートで落とせば `shoulders_not_near:cap` の理由コードが残る。
 * #178 の「誤って弾けば理由コードが出るが、誤って通せば無音」の非対称と同じ判断で、
 * **窓生成は緩く、肩ゲートで落として理由コードを残す**。
 *
 * **この分離は出力にも効く**（＝ 純粋に診断性だけの話ではない）。#244 Phase 1 の ablation は
 * 定数リテラルを差し替えたので両方が同時に締まり、**肩ゲートは通るのに窓生成で消える構造**が
 * 出ていた（結果 9(b) / §9 の `btc_jpy_1day_2026` / `4hour` / `20-24-27-53-80`。肩 1.228% <
 * `4hour` の閾値 2.040%）。窓生成を据え置いた本実装ではこの構造は**残る**——Phase 2 の
 * 再計測（§11）で ablation と食い違う唯一の点として確認してある。
 *
 * ## `getSizeThresholdsForTf(tf).depthPct` と数値が一致するのは偶然
 *
 * アンカーが {@link MIN_DEPTH_PCT} と同じ 5% なので、本関数の返り値は全時間足で
 * `getSizeThresholdsForTf(tf).depthPct` と**数値が一致する**。**流用しないこと。**
 * 測っている量が違う:
 *
 * - `depthPct`: 山と山に挟まれた**谷の深さ**の下限（大きいほど厳しい）
 * - 本関数: 左右**肩の同水準**の上限（大きいほど緩い）
 *
 * 極性すら逆なので、片方のアンカーを動かしたときにもう片方が黙って追従すると
 * #198 と同じ「向きの逆な表の無検証流用」になる。**別関数として持つ。**
 */
export function getHsShoulderMaxPctForTf(tf: string): number {
	const t = String(tf);
	// 1day より短い足は ATR 比（1day = 1.0、getSizeThresholdsForTf と同じ表）で締める。
	if (t === '1min') return 0.0013;
	if (t === '5min') return 0.0029;
	if (t === '15min') return 0.0051;
	if (t === '30min') return 0.0072;
	if (t === '1hour') return 0.0104;
	if (t === '4hour') return 0.0204; // 推定（4hour の ATR は未実測。getSizeThresholdsForTf と同じ限界）
	if (t === '8hour') return 0.0289;
	if (t === '12hour') return 0.0354;
	// 1day / 1week / 1month / 未知の時間足: アンカー（HS_SHOULDER_MAX_PCT）を据え置く
	return HS_SHOULDER_MAX_PCT;
}

/**
 * 時間軸に応じた H&S / 逆 H&S の頭の最小突出率を返す（issue #198）。
 *
 * 旧実装は未指定時に {@link getDefaultToleranceForTf}（`tolerancePct` の時間軸オート表）を
 * そのまま流用していた（`resolveParams` の `headProminencePct = tolAuto`）。**この 2 つは
 * 向きが逆**（schema の `headProminencePct` 説明を参照。`tolerancePct` は大きいほど緩く、
 * 本関数の値は大きいほど厳しい）ため、tolerance 表を流用すると `1hour`（5%）が `1day`（4%）
 * より 25% 厳しくなり、「下位足ほど緩める」という #152 の設計と正反対の効果になっていた。
 * サイズ下限（{@link getSizeThresholdsForTf}）は #152 / PR #168 で ATR 比カーブに乗ったが、
 * 本関数（旧: tolerance 表の流用）だけがこのカーブから漏れていた。
 *
 * **導出は {@link getSizeThresholdsForTf} と同じ ATR 比テーブルを、アンカー 0.04
 * （`tolerancePct` の 1day 既定値。旧実装が事実上使っていた値と同値）に掛けただけ。**
 * ATR を新たに測り直してはいない——#152 が「1day を 1.0 とした ATR 比」を既に測定 / 推定済み
 * （{@link getSizeThresholdsForTf} の docstring の表）で、本関数もそれをそのまま使う。
 * #152 の 3 つの設計上の約束（実行時に ATR へ連動させない・1day をアンカーに据え置く・
 * 種別ごとに分けない）をそのまま踏襲する。
 *
 * ## 実測（issue #198 Phase 1。実データ 365 本 `tests/fixtures/btc_jpy_1hour_2026_08.ts`）
 *
 * 1hour の実際の head prominence 分布は `head_and_shoulders` で min 0.055%〜max 2.571%
 * （中央値 1.848%）、`inverse_head_and_shoulders` で min 0.016%〜max 2.261%
 * （中央値 0.828%）。**現行 5% ではこの実データ上で構造的に妥当な候補
 * （肩の同水準・ネックライン水平度・先行トレンド・サイズ検査を全て通過済み）103 件が
 * 1 件残らず頭の突出だけで落ちていた**（最大でも 2.571%）。
 *
 * 0.83% に緩めると `globalDedup` 後で `head_and_shoulders` 0→2 件・
 * `inverse_head_and_shoulders` 0→2 件（他 type は 0 件変化）。4 件とも range と 5 構成点を
 * 個別に確認し、実在する構造であることを確認した。起票者が目視で妥当と判断した
 * head prominence 1.85% の実例（頭 idx 294 = 12,851,000）を含む候補群が検出可能になる
 * （`globalDedup` は同じ頭を持つ近傍の窓から 1 件を代表として残すため、最終出力の 5 点が
 * 起票者の読みと byte-for-byte 一致するとは限らない）。`1day` は 0 件変化（アンカー不変を確認）。
 *
 * **`4hour` / `8hour` / `12hour` は実測していない。** 実データが 365 本（約 15.2 日）の 1hour fixture 1 本しか
 * なく、これを 4h/8h/12h に再集計しても 91/45/30 本では H&S を構成できる期間を張れない
 * （再集計データでの実測は 0 件）。{@link getSizeThresholdsForTf} と同じ ATR 比を機械的に
 * 適用した推定値であり、実測の裏付けは無い——この限界は {@link getSizeThresholdsForTf} 自身の
 * `1hour` 以外の行（`4hour` 以降）と同じ位置づけ。
 *
 * ## relaxed フォールバックとの関係（過剰緩和の確認）
 *
 * `detect_hs.ts` の `RELAXED_FACTORS` は本関数の値に 0.6 / 0.4 を掛けるため、`1hour` では
 * 実効 0.50% / 0.33% まで下がる。実測では prominence 0.33% 未満でも肩・ネックラインが
 * 通る窓が 37 件あり、この段まで到達すると過剰緩和になり得る。ただし relaxed は
 * strict が対象 type を 1 件も見つけられなかったときにのみ発火するフォールバックで、
 * strict が既に 0.83% で `head_and_shoulders` / `inverse_head_and_shoulders` を検出できて
 * いる限り到達しない。`RELAXED_FACTORS` 自体の設計見直しは本 issue の範囲外。
 *
 * ### 実測（issue #227 Phase 1。tjackiet/bitbank-lab-mcp#227 の計測スクリプト）
 *
 * 上の「到達しない」は `btc_jpy` / `1hour` のライブ実行で崩れた（strict 0 件・段2
 * `x2.0_0.4` でだけ拾われた `head_and_shoulders` が整合度 0.79 で出力され、頭の突出は要求 0.83% の
 * 58%）。ただし**標準コーパス 800 ＋ 実データ B 96（呼び出し 1,792 回）では relaxed accepted は
 * 段1 / 段2・H&S / 逆 H&S とも 0 件**で、#204 Phase 1 の「940 ケース中 0 件」と同じ。
 * ライブで見えた構造は fixture（2026-08-12〜08-28）の外にあり、本コーパスでは再現できない。
 *
 * relaxed が発火する（= strict 0 件）割合は高いが、発火しても通らない:
 *
 * | 部分集合 | `head_and_shoulders` strict 0 件率 | `inverse_head_and_shoulders` 同 | relaxed accepted |
 * |---|---:|---:|---:|
 * | 合成 704 | 95.5% | 93.2% | 0 |
 * | 実データ A 96（`1day` 系列） | 41.7% | 58.3% | 0 |
 * | 実データ B 96（`1hour` 系列） | 33.3% | 66.7% | 0 |
 * | 実データ B × ネイティブ `1hour` | 0.0% | 0.0% | 0 |
 * | 実データ A × ネイティブ `1day` | 50.0% | 100.0% | 0 |
 *
 * 通らない理由は頭の突出ではなく**窓の形**——relaxed は連続する 5 ピボットしか見ない（strict は
 * `enumerateHsWindows` で非連続の組も見る）ため、strict 0 件の組では段2 の頭ゲートに到達する
 * 窓自体が 0 だった（肩 `tol × 2.0`・ネックライン・先行トレンド・サイズ検査まで通る窓のうち
 * 頭が肩より高いもの）。したがって「`head: 0.4` を 0.35〜0.5 で動かしたときの通過集合」は本コーパスでは
 * 全域で空で、膝も空白帯も観測できない。
 *
 * ### 実測（issue #227 Phase 1 の再計測。実データ C と窓長スイープ）
 *
 * 上の「fixture の外」は **fixture を足して解消した**（`tests/fixtures/btc_jpy_1hour_2026_09.ts`）。
 * 再計測で分かった決定的な点は、relaxed の発火可否を決めるのが**窓の左端**だということ:
 *
 * | 窓長（= `limit`） | 窓の左端 (UTC) | `head_and_shoulders` strict 0 件率 | 段2 accepted |
 * |---:|---|---:|---:|
 * | 60 / 90 | `09-02 02:00` / `08-31 20:00` | 100.0% | 0 |
 * | **120** | **`08-30 14:00`（ライブと同じ左端）** | **100.0%** | **24** |
 * | 150 以上 | `08-29 08:00` 以前 | 0.0% | 0 |
 *
 * 窓を広げると strict が別の H&S を拾い、relaxed は**評価すらされない**。実データ B が
 * 0 件だったのは期間の違いだけでなくこれが理由で、**同じ系列でも `limit` 次第で発火する**。
 *
 * 段2 で拾われた構造は `1hour` の窓長 120 で 2 件（いずれも頭は同一。突出 0.484% = 本関数の値の
 * 58%、整合度 0.79 / 0.74）で、issue #227 本文のライブ実例と全項目一致した。
 * **膝は観測できていない**——係数 `head` を 0.30〜0.58 で動かしても通過集合は完全に一定で、
 * 0.59 で 0 に落ちるだけ。これは「ゼロから離れた集団」ではなく**標本 1 点によるステップ**なので、
 * `0.4` という値の非恣意性の根拠にはならない（#214 の非恣意性テストの意味では不合格）。
 * したがって Phase 2 では**段2 を削らず**、`headProminence` 軸の採点だけを strict の閾値
 * （本関数の値）に固定した（`detect_hs.ts` の `buildHsScore` / `headProminenceGate`）。
 * 詳細は tjackiet/bitbank-lab-mcp#227 の計測記録。
 */
export function getHeadProminenceForTf(tf: string): number {
	const t = String(tf);
	// 1day より短い足は ATR 比（1day = 1.0、getSizeThresholdsForTf と同じ表）で緩める。
	if (t === '1min') return 0.0011;
	if (t === '5min') return 0.0024;
	if (t === '15min') return 0.0041;
	if (t === '30min') return 0.0058;
	if (t === '1hour') return 0.0083;
	if (t === '4hour') return 0.0163; // 推定（4hour の ATR は未実測。getSizeThresholdsForTf と同じ限界）
	if (t === '8hour') return 0.0231;
	if (t === '12hour') return 0.0283;
	// 1day / 1week / 1month / 未知の時間足: アンカー（tolerancePct の旧既定値と同値）を据え置く
	return 0.04;
}

/**
 * 時間軸に応じた収束係数を返す（三角形・ウェッジ用）
 */
export function getConvergenceFactorForTf(tf: string): number {
	const t = String(tf);
	if (t === '1hour' || t === '4hour' || t === '15min' || t === '30min') return 0.6;
	return 0.8; // default
}

/**
 * 時間軸に応じた三角形の係数を返す
 */
export function getTriangleCoeffForTf(tf: string): { flat: number; move: number } {
	const t = String(tf);
	if (t === '1hour' || t === '4hour') return { flat: 1.2, move: 0.8 };
	return { flat: 0.8, move: 1.2 };
}

/**
 * 時間軸に応じた最小フィット値を返す
 */
export function getMinFitForTf(tf: string): number {
	const t = String(tf);
	if (t === '1hour' || t === '4hour') return 0.6;
	if (t === '1day') return 0.7;
	return 0.75;
}

/**
 * 時間軸に応じた三角形のウィンドウサイズを返す
 */
export function getTriangleWindowSize(tf: string): number {
	const t = String(tf);
	// 長期: 大きなパターン
	if (t === '1month') return 30;
	if (t === '1week') return 40;
	// 中期
	if (t === '1day') return 50;
	// 短期
	if (t === '4hour') return 30;
	if (t === '1hour') return 40;
	if (t === '30min') return 30;
	if (t === '15min') return 30;
	return 20;
}

/**
 * パラメータの実効値がどこから来たか。
 *
 * - `explicit`: 呼び出し側が渡した値がそのまま効いた
 * - `auto`: 時間軸オート表（{@link getDefaultParamsForTf} / {@link getDefaultToleranceForTf}）から解決した
 *
 * **`auto` は「未指定」と「スキーマ既定値（= sentinel）を明示指定」を畳んでいる。**
 * `swingDepth=7` / `minBarsBetweenSwings=5` / `tolerancePct=0.04` には `.default()` が
 * 付いているため、`resolveParams` に届いた時点で両者は同一の値であり区別できない（#182 / #184）。
 * どちらでも実効値は同じなので、見せたいほう（実効値）は失われない。
 * 区別が要るなら `.default()` の除去（#182 案 B）が前提になる。
 */
export type ParamSource = 'auto' | 'explicit';

/** {@link resolveParams} が返す、パラメータごとの由来。 */
export interface ResolvedParamSources {
	swingDepth: ParamSource;
	tolerancePct: ParamSource;
	minBarsBetweenSwings: ParamSource;
	headProminencePct: ParamSource;
}

/**
 * オプションとスキーマデフォルトから実効パラメータを解決する。
 *
 * 実効値の**計算**は #184 でも一切変えていない（sentinel 置換のルールはそのまま）。
 * 変えたのは由来の申告だけで、旧 `autoScaled: boolean` を廃止し
 * パラメータごとの {@link ParamSource} に置き換えた（#184 欠陥 B / 案 B-2）。
 *
 * 旧 `autoScaled` は `swingDepth` / `minBarsBetweenSwings` が**どちらも未指定**のときだけ
 * `true` になる集約フラグだった。ところが MCP 経路では 3 パラメータとも `.default()` が
 * 埋まるため `opts.swingDepth` が `undefined` になる経路が存在せず、**常に `false`** を返していた
 * （`{"pair":"btc_jpy","type":"1hour"}` = 完全オートでも `false`）。
 * 集約フラグでは「どのパラメータが auto でどれが明示か」も表現できないため、
 * per-parameter の由来に作り直してある。
 */
export function resolveParams(
	tf: string,
	opts: Partial<{
		swingDepth: number;
		tolerancePct: number;
		minBarsBetweenSwings: number;
		headProminencePct: number;
	}>,
): {
	swingDepth: number;
	tolerancePct: number;
	minBarsBetweenSwings: number;
	headProminencePct: number;
	sources: ResolvedParamSources;
} {
	const auto = getDefaultParamsForTf(tf);
	const tolAuto = getDefaultToleranceForTf(tf);
	const headProminenceAuto = getHeadProminenceForTf(tf);

	// swingDepth: スキーマ既定値(7)が来た場合は時間軸オートに置換
	// （`explicit` = 「有限値が来た」かつ「それが sentinel ではない」。旧実装の入れ子三項と同値で、
	//   由来の判定を実効値の判定と同じ 1 つの述語から導くために平坦化してある）
	const swingDepthExplicit =
		Number.isFinite(opts.swingDepth as number) && (opts.swingDepth as number) !== SCHEMA_DEFAULTS.swingDepth;
	const swingDepth = swingDepthExplicit ? (opts.swingDepth as number) : auto.swingDepth;

	// tolerancePct: スキーマ既定値(0.04)が来た場合は時間軸オートを採用
	// **述語は swingDepth と揃えない。** 旧実装が `typeof === 'number' && !Number.isNaN` で
	// 判定していたため、`Number.isFinite` に揃えると `Infinity` の扱いが変わる（実効値が動く）。
	const tolerancePctExplicit =
		typeof opts.tolerancePct === 'number' &&
		!Number.isNaN(opts.tolerancePct) &&
		opts.tolerancePct !== SCHEMA_DEFAULTS.tolerancePct;
	const tolerancePct = tolerancePctExplicit ? (opts.tolerancePct as number) : tolAuto;

	// minBarsBetweenSwings: 同様に既定値(5)なら時間軸オートに置換
	const minBarsExplicit =
		Number.isFinite(opts.minBarsBetweenSwings as number) &&
		(opts.minBarsBetweenSwings as number) !== SCHEMA_DEFAULTS.minBarsBetweenSwings;
	const minBarsBetweenSwings = minBarsExplicit ? (opts.minBarsBetweenSwings as number) : auto.minBarsBetweenSwings;

	// headProminencePct（H&S / 逆H&S の頭の最小突出率、issue #149）: スキーマに .default() を
	// 付けていないため、呼び出し側が省略すれば opts.headProminencePct は確実に undefined になる
	// （tolerancePct のような「スキーマ既定値と等しいか」の判定は不要）。未指定なら
	// {@link getHeadProminenceForTf} の時間軸オート表（headProminenceAuto）を採用する——
	// tolerancePct の表とは独立（issue #198。#149 時点では新パラメータ切り出し直後で専用の
	// 時間軸オート表が無く、暫定的に tolerancePct の表（tolAuto）を流用していたが、両者は
	// 意味の向きが逆（tolerancePct は大きいほど緩い、headProminencePct は大きいほど厳しい）
	// なので流用は誤りだった。詳細は getHeadProminenceForTf の docstring）。
	// **本パラメータの `auto` だけは「未指定」と同義**（sentinel 値との衝突が無い）。
	const headProminenceExplicit = typeof opts.headProminencePct === 'number' && !Number.isNaN(opts.headProminencePct);
	const headProminencePct = headProminenceExplicit ? (opts.headProminencePct as number) : headProminenceAuto;

	return {
		swingDepth,
		tolerancePct,
		minBarsBetweenSwings,
		headProminencePct,
		sources: {
			swingDepth: swingDepthExplicit ? 'explicit' : 'auto',
			tolerancePct: tolerancePctExplicit ? 'explicit' : 'auto',
			minBarsBetweenSwings: minBarsExplicit ? 'explicit' : 'auto',
			headProminencePct: headProminenceExplicit ? 'explicit' : 'auto',
		},
	};
}
