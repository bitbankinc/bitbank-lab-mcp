/**
 * patterns/target-reach.ts — ブレイク後の target 到達判定（issue #210）
 *
 * `helpers.ts` から切り出したのは **`src/schema/patterns.ts` が閾値を読むため**。
 * `targetReachedPct` / `targetReached` の description は走査窓の本数・上限値・退化の閾値を
 * 名指しで説明するので、数値を description 側に書き写すと**振る舞いと宣言が黙ってずれる**。
 * `helpers.ts` ごと import すると dayjs / indicators までスキーマの依存に入るため、
 * 依存が `./types.js` の型だけで済むこの単位に分けてある。
 */

// **型のみ**の import（出力から消えるので実行時の循環は生じない）。理由コードの単一ソースは
// Zod 側に置いてある——詳細は `TargetReachOmissionReason` の docstring。
import type { TargetProgressOmittedReason } from '../../src/schema/patterns.js';
// 交絡フィールドの**型だけ**を借りる（単一ソースは `target-confounders.ts`）。
// `import type` なので出力から消え、スキーマ側の依存にも実行時の循環にもならない。
import type { TargetBreakoutConfounder } from './target-confounders.js';
import type { CandleData } from './types.js';

// ---------------------------------------------------------------------------
// ブレイク後の target 到達判定（high/low ベース）
//
// 最終 close ベースだと、ブレイク後に一度 target を越えてから戻ったケースで
// 未到達扱いされてしまう。実際には「ブレイク後に target を越えたか」を見たいので、
// breakoutIdx 以降のローソク足を走査して extremum
// （下方ブレイクなら min low / 上方ブレイクなら max high）を取り、その値で進捗率を計算する。
//
// 入力:
//   - candles: 全ローソク足
//   - breakoutIdx: ブレイク確定足のインデックス（このバー以降を走査）
//   - breakoutPrice: ブレイク確定時の参照価格（通常は close）
//   - target: 想定ターゲット価格
//   - direction: 'up'  → breakoutIdx 以降の最高 high で評価
//                'down' → breakoutIdx 以降の最安 low で評価
//   - patternHeight: そのパターンが投影している値幅（分母の退化判定に使う）
//
// 戻り値（issue #224 症状 2 以降、**`undefined` を返さない**）:
//   - `{ kind: 'measured', … }` — 進捗を測れた
//   - `{ kind: 'omitted', reason }` — 測れなかった。**理由コードを必ず持つ**
//
// 「測れなかった」を `undefined` で表すと、呼び出し側が `targetReachFields(undefined)` →
// `{}` と畳んだ時点で理由が消え、content から進捗行ごと消える（#224 症状 2）。
// 戻り値型から `undefined` を外してあるので、**理由を書かない畳み方は typecheck を通らない。**
// ---------------------------------------------------------------------------

/**
 * ブレイク足から何本先まで target 到達を探すか（issue #210 (3)）。
 *
 * **上限が無いと `targetReached` / `targetReachedPct` が「いつ問い合わせたか」に依存する。**
 * 走査は元々 `candles.length` まで無制限だったので、同じ構造・同じブレイク足のパターンでも
 * 系列が伸びるほど extremum が更新されて値が動いた。実データ B（`btc_jpy` 1hour）で系列末尾を
 * 240 本 / 365 本に切り替えた実測:
 *
 * | パターン | 240 本で | 365 本で |
 * |---|---:|---:|
 * | `falling_wedge`（ブレイク 08-17T15:00Z） | 4,473% | 5,102% |
 * | `inverse_head_and_shoulders`（同 08-17T18:00Z） | 209,921% | 240,033% |
 * | `triangle_ascending`（target 10,387,692） | 1,507% | 1,719% |
 *
 * 実データ A（1day 90 本）では系列を 60 本 / 75 本で切ると `targetReached` **そのもの**が
 * false → true に反転した（`double_bottom` 8% → 330%、`triangle_symmetrical` 31% → 207%）。
 * #154（窓を広げたのに検出が減る）と同じ「同じ構造なのに窓次第で答えが変わる」欠陥だが、
 * **軸は窓の大きさではなく観測時点**——`limit`（＝先頭の切り詰め）では動かない（総当たりで差分 0）。
 *
 * **60 の根拠**（標準コーパス 896 ケース / `computeTargetReach` の生の呼び出し 5,000 行）:
 * 到達済み 2,576 行の「初到達までのバー数」は p50 = 12 / p75 = 37 / p95 = 52 / p99 = 72 で、
 * **60 本以内が 96.3%**。60 本にすると `targetReached` は構造単位 75 → 72 件（−3）しか動かない。
 * 90 本にすれば構造単位の増減は 0 になるが、90 本ぶんの先が揃う行が 29.4% しかなく
 * （60 本なら 39.5%）「値が固まるまでの待ち」が長くなるので採らない。
 *
 * ## **96.3% は到達率ではない**（issue #288 Phase 1。読み違えを固定するために書く）
 *
 * 上の 96.3% は**到達済みケースの条件付き分布**——「届いたものは何本目で届いたか」であって、
 * 「届くか」ではない。**届かなかったブレイクは分母に入っていない。**
 * 実データで到達率そのものを測ると、**どの N（5〜60）でもパターン起点の到達率は帰無
 * （同じ距離のターゲットを任意のバーに置いたとき）を上回らない**（主表 n = 38 / 帰無 m = 11,590 で
 * 差は N = 5 / 10 / 20 / 30 / 60 とも −5.2 / −8.5 / −0.8 / −4.9 / −8.3 pt の**全部負**）。
 * 走査窓に他パターンのブレイクが入る実体が **94.7%** で、60 本超の到達も実在する（max 101 本）。
 *
 * **したがって本定数は「取りこぼし防止の走査幅」であって「成績の窓」ではない。**
 * `targetReachedPct` / `targetReached` を「このパターンだから届いた」の証拠として読ませないこと。
 * N を短縮する根拠となる値もコーパスに無いため **60 のまま据え置く**（#288 Phase 2 の決定）。
 *
 * **1day では評価できていない。** 実データ A（1day 90 本）はブレイク足の後に 60 本残る実体が
 * **0 件**なので母集団に 1 つも入らない（#228 / #227 と同じ但し書きで、「1day でも問題ない」ではない）。
 * 詳細は tjackiet/bitbank-lab-mcp#288 の計測記録。
 *
 * **時間足別のテーブルにしない。** バー数のまま持つ（`HS_BREAKOUT_MAX_BARS` と同じ扱い）。
 * 時間足別テーブルの流用は #198 で事故になっている。
 *
 * **triple を配線した後の実測（#228。940 ケース / 完成済み triple 13 構造）でも 60 のまま。**
 * triple の構成バー数（`periodScoreBars` の入力）は実データ B ネイティブで 30〜42（p50 36）、
 * 補助スイープ込みで 23〜42。ブレイク足の後ろに取れる足数は実データ B で p50 84 本あり、
 * **60 本ぶんの先が揃う構造が 100%（2/2、補助スイープ込みで 11/11）**。初到達までのバー数は
 * 実データ B の全構造で **0 本**（ブレイク足自身の high が target を越えている）ので、
 * 窓を伸ばしても縮めても `targetReached` は動かない。合成 fixture 側は系列がブレイクの
 * 3 本先で終わるため 0%（2 件とも）だが、こちらは窓ではなく fixture の長さの制約。
 */
export const TARGET_REACH_MAX_BARS = 60;

/**
 * `targetReachedPct` の分母 `|target − breakoutPrice|` が、そのパターンが投影している値幅
 * （パターン高さ）に対してこの比を下回ったら **target 進捗系フィールドを出さない**（issue #210 (2)）。
 *
 * 分母が潰れるのは **ネックラインから投影する検出器（H&S / doubles）だけ**。
 * triangles / wedges / pennants / flags は `breakoutTarget = ブレイク価格 ± patternHeight` なので
 * `targetDistance ≡ patternHeight` になり、構造上ここには掛からない（標準コーパスの実測でも
 * 比は 0.9844〜1.0103 = `Math.round` の丸めぶんしか動かない）。H&S / doubles は
 * ブレイク足がネックラインから値幅ぶん走っていると分母だけが潰れ、比が 0.0033 まで落ちる。
 *
 * **閾値は高さ相対（無次元）にする。** 価格相対にすると時間足別テーブルが要る
 * （`MAX_LEVEL_SPREAD_RATIO` が同じ理由で無次元を選んでいる。#198 も参照）。
 *
 * **0.15 の根拠**（標準コーパス 896 ケース、H&S / doubles の 1,512 行）:
 * 比の分布は p50 = 0.49 で、下側は 0.0033 / 0.0068 / 0.0121 / 0.0955 / 0.1012 / 0.1059 / 0.1379 と
 * 続き 0.2027 に飛ぶ。閾値を上げていくと **0.12 が膝**で、そこで H&S / doubles に残る
 * `targetReachedPct` の最大値が 13,928% → 817% に落ちる（0.15 でも 0.25 でも同じ 817%）。
 * 0.15 は膝のすぐ上の丸い値で、除外は 144 行（全 5,000 行の 2.9%）/ 構造単位 7 件。
 *
 * 意味としては「**ブレイク足の終値が既に想定値幅の 85% 以上を走り終えている**」状態で、
 * 残り 15% の消化を『ターゲット到達』と名乗らせない、ということ。
 *
 * ## triple も同じ族だが、**この閾値には掛からない**（#228 の実測）
 *
 * `triple_*` は H&S / doubles と同じ `neckline_projection`（＝分母が潰れうる側）なので、
 * #228 で完成済み 4 経路を配線するにあたり **triple 固有の分布を測り直した**
 * （同じ族だから同じ値でよい、は仮説。無検証の流用は #198 で事故になっている）。
 * 940 ケース・完成済み triple 13 構造の実測:
 *
 * | | 比の min | p50 | max | 発火 |
 * |---|---:|---:|---:|---:|
 * | 実データ B ネイティブ（1hour） | 0.8160 | 0.9191 | 1.0222 | **0 / 2** |
 * | 合成 fixture | 0.8807 | 0.8807 | 0.8807 | **0 / 2** |
 * | 全母集団（構造単位） | 0.8160 | 1.0222 | 3.9681 | **0 / 13** |
 *
 * **下側の裾が H&S / doubles と別物**——あちらは 0.0033 まで落ちるのに、triple は 0.82 を
 * 下回る構造が 1 つも無い。閾値を上げていっても **0.82 まで除外が 0 件**で、そこから先も
 * 残る `targetReachedPct` の最大値（623%）は動かない（0.82 / 0.89 / 1.03 で除外が
 * 5 / 7 / 12 件と増えるだけ）。**H&S / doubles で見えた「0.12 の膝」に相当するものが
 * triple には無い**ので、triple 用に別の値を置く根拠が無く、0.15 をそのまま使う。
 * 実データ A（1day）は完成済み triple が **0 件**（#227 Phase 1 と同じ）なので 1day 側の
 * 材料は無い——「1day でも問題ない」ではなく「1day では測れていない」と読むこと。
 */
export const MIN_TARGET_DISTANCE_HEIGHT_RATIO = 0.15;

/**
 * `targetReachedPct` の上限（issue #210 (1)）。**この値ちょうどは「以上」を意味する。**
 *
 * `MIN_TARGET_DISTANCE_HEIGHT_RATIO` と `TARGET_REACH_MAX_BARS` を入れた後の標準コーパスでは
 * 最大 1,572%（`falling_wedge`。比は 1.0 なので**本当に高さの 15 倍動いた**行）で、
 * 上限に当たるのは 32 行 / 構造単位 1 件。本質的な対策ではなく、
 * 上の 2 つをすり抜けた場合の安全網として置く。
 *
 * **triple を配線した後も上限に当たる行は 0**（#228。940 ケース / 完成済み triple 13 構造）。
 * `targetReachedPct` の最大は実データ B ネイティブで 289%、補助スイープ（1min ラベル）の
 * 外れ値を入れても 623% で、桁が飛ぶ行が無い。安全網としての位置づけは変わらない。
 */
export const TARGET_REACHED_PCT_CAP = 999;

/**
 * 進捗を測れたケース。
 *
 * ## 「到達の事実」4 フィールドは `targetReachedPct` とは別の量（issue #288 Phase 2）
 *
 * `targetReachedPct` / `targetReachedDate` / `targetReachedPrice` は**走査窓の extremum**を
 * 見ているので、到達した後にさらに伸びた値動きまで含む（実機で「進捗 273%」と出ていたのは
 * 到達後の超過倍率）。**いつ・何本目に初めて届いたか**はそこから読めないので、別に持つ。
 *
 * | フィールド | 中身 |
 * |---|---|
 * | `targetFirstReachBars` | ブレイク足を 0 本目とした初到達の本数。未到達なら出さない |
 * | `targetFirstReachDate` | 初到達の足の `isoTime`。未到達なら出さない |
 * | `targetScanBars` | 実際に走査した本数（ブレイク足を除く後続の本数） |
 * | `targetScanComplete` | `targetScanBars === TARGET_REACH_MAX_BARS` |
 *
 * **すべて optional にしてあるのは既存の呼び出し・テストを壊さないため**（additive）。
 * `computeTargetReach` は `measured` を返すとき `targetScanBars` / `targetScanComplete` を
 * 常に埋める（初到達 2 つは到達したときだけ）。
 */
export interface TargetReachInfo {
	kind: 'measured';
	targetReachedPct: number;
	targetReached: boolean;
	targetReachedDate?: string;
	targetReachedPrice: number;
	targetFirstReachBars?: number;
	targetFirstReachDate?: string;
	targetScanBars?: number;
	targetScanComplete?: boolean;
}

/**
 * 進捗を測れなかった理由（issue #210 で 1 コード、#224 症状 2 で 5 コード追加）。
 *
 * **`targetReachedPct` が出ない経路はここに列挙されたコードのどれかを必ず名乗る。**
 *
 * **単一ソースは `src/schema/patterns.ts` の `TargetProgressOmittedReasonEnum`**（Zod）で、
 * この型はそこから導出している。TypeScript のユニオンを別に持つと、型上は正しい理由を
 * 返しても Zod 側の宣言漏れで `parse()` が黙って剥がす——#155 / #160 / #184 / #189 / #199 で
 * **5 回起きている事故**なので、片方だけ足せない形にしてある。実行時の依存は
 * `src/schema/patterns.ts` → 本ファイル（閾値 3 定数）の一方向のままで、
 * 逆向きは `import type` のみ（出力から消える）。
 *
 * コードを足すときは Zod enum に足し、`TARGET_PROGRESS_OMISSION_NOTE` に content 文言を書く。
 * 文言の書き忘れは `Record<TargetReachOmissionReason, string>` が typecheck で落とす。
 *
 * ## 再問い合わせで答えが変わりうるか（3 通り。**混ぜない**）
 *
 * 消費側が知りたいのは「時間を置けば値が出るのか」なので、そこを取り違えさせない。
 *
 * | 区分 | コード | 意味 |
 * |---|---|---|
 * | **(i) 暫定** | `not_broken_out` / `no_bars_after_breakout` | **足が増えれば測れるようになりうる。** 形成中のパターンが後の足でネックラインを抜ければ進捗が出る |
 * | **(ii) 確定** | `no_target` / `invalid_breakout_price` / `degenerate_target_distance` | **その構造では変わらない。** 分母はブレイク価格と target だけで決まり、欠損したブレイク足は後から直らない |
 * | **(iii) 実装ギャップ** | `not_computed_by_detector` | 再問い合わせでは変わらないが、**将来のリリースで消える**（配線されたら進捗が出る） |
 *
 * 初版は (i) と (ii) をまとめて「データ条件 = 問い合わせ直しても変わらない」と書いていたが、
 * **`not_broken_out` は変わりうる**（PR #225 のレビュー指摘）。最多の経路をここで
 * 取り違えさせると、「もう一度呼んでも無駄」と読ませてしまう。
 *
 * ## 標準コーパス 940 ケースでの発生件数（構造単位。#224 症状 2 の実測）
 *
 * | reason | 生の行数 | 構造単位 | 内訳（構造単位） |
 * |---|---:|---:|---|
 * | `not_broken_out` | 2,625 | **547** | `head_and_shoulders` 266 / `inverse_head_and_shoulders` 245 / `triple_top` 9 / `double_bottom` 8 / `triple_bottom` 8 / `triangle_ascending` 4 / `rising_wedge` 3 / `falling_wedge` 2 / `triangle_symmetrical` 2 |
 * | `degenerate_target_distance` | 278 | 60 | `inverse_head_and_shoulders` 59 / `double_bottom` 1（#210 から不変） |
 * | `not_computed_by_detector` | 72 → **0** | 13 → **0** | `triple_bottom` 11 / `triple_top` 2 だったが、**#228 の配線で全件が進捗を出す側に移った** |
 * | `no_target` | 0 | **0** | — |
 * | `invalid_breakout_price` | 0 | **0** | — |
 * | `no_bars_after_breakout` | 0 | **0** | — |
 *
 * **下 3 つは本コーパスで 1 件も出ない。** それでもコードを置くのは、
 * `undefined` を返せなくした結果 **`computeTargetReach` と呼び出し側ガードのすべての早期
 * return が名前を要求される**からで、名前が無いとその経路だけがまた無言に戻る。
 * 到達性の見立て:
 *
 * - `no_target` — H&S 4 経路の `target === undefined || height === undefined` と
 *   `computeTargetReach` の `!Number.isFinite(target)`。`necklineProjectionTarget` が
 *   `undefined` を返すのは添字またはネックライン値が非有限のときだけで、検出器経由では
 *   ピボット添字が常に有限（`detect_hs.ts` の `necklineProjectionHeight` と同じ理由で
 *   **検出器経由では到達不能に近い**）。
 * - `invalid_breakout_price` — doubles 4 経路 / wedges 2 経路の `Number.isFinite(bp)` false。
 *   ブレイク足の `close` が欠損した系列でのみ起きるので、正常な OHLC では出ない。
 * - `no_bars_after_breakout` — `breakoutIdx >= candles.length` または走査窓に有限な
 *   high/low が 1 本も無い。検出器はブレイク足を系列内から取るので前者は起きず、
 *   後者は欠損足の系列でのみ起きる。
 *
 * **`degenerate_target_distance` の 60 構造は #210 から動いていない**（今回の変更は
 * `undefined` 経路に名前を付けただけで、判定を 1 つも変えていない）。
 *
 * 各コードの意味は Zod 側の `.describe()` が単一ソース（`src/schema/patterns.ts`）。
 * **`not_computed_by_detector` を返す経路は #228 で無くなった**（`detect_triples.ts` の完成済み
 * 4 経路が `computeTargetReach` を呼ぶようになり、上表の 13 構造はすべて進捗を出す側に移った）。
 * enum からは消していない——公開スキーマの出力フィールドの値なので削除は破壊的変更で、
 * かつ同じ実装ギャップが別の検出器で見つかったときの受け皿が要る。
 */
export type TargetReachOmissionReason = TargetProgressOmittedReason;

/** 進捗を測れないケース。**黙って落とさず呼び出し側が申告する。** */
export interface TargetReachOmitted {
	kind: 'omitted';
	reason: TargetReachOmissionReason;
}

export type TargetReachResult = TargetReachInfo | TargetReachOmitted;

/**
 * 呼び出し側のガード（ブレイク未確定 / target 未算出 等）で `computeTargetReach` を
 * そもそも呼ばないときに使う。**`undefined` の代わりにこれを返す**ことで、
 * 理由を書かない畳み方が型で潰れる。
 */
export function omittedTargetReach(reason: TargetReachOmissionReason): TargetReachOmitted {
	return { kind: 'omitted', reason };
}

export function computeTargetReach(
	candles: readonly CandleData[],
	breakoutIdx: number,
	breakoutPrice: number,
	target: number,
	direction: 'up' | 'down',
	patternHeight: number,
): TargetReachResult {
	// **入力不正も理由を名乗る**（#224 症状 2）。呼び出し側ガードの `invalid_breakout_price` /
	// `no_target` と同じコードに寄せてあるので、ガードの手前で落ちたか中で落ちたかで
	// 申告が変わらない。
	if (!Number.isFinite(breakoutPrice)) return omittedTargetReach('invalid_breakout_price');
	if (!Number.isFinite(target)) return omittedTargetReach('no_target');
	const targetDistance = Math.abs(target - breakoutPrice);
	const startIdx = Math.max(0, breakoutIdx);
	if (startIdx >= candles.length) return omittedTargetReach('no_bars_after_breakout');

	// 分母の退化ガード（#210 (2)）。**距離ゼロもここに含まれる**——
	// 以前は `targetDistance <= EPSILON` を「既に到達」として pct=100 で返していたが、
	// 「ブレイク時点で target と一致」は達成度が測れない状態そのものなので、
	// 比が小さいケースと分けて扱う理由が無い。`patternHeight` が正でない場合も
	// 比を判定できないので測らない（高さが出ない形は target 自体が出ない経路が大半）。
	if (!(patternHeight > 0) || targetDistance < patternHeight * MIN_TARGET_DISTANCE_HEIGHT_RATIO) {
		return omittedTargetReach('degenerate_target_distance');
	}

	// 走査はブレイク足から `TARGET_REACH_MAX_BARS` 本先まで（#210 (3)）。
	// 系列末尾までではないので、同じ構造には**問い合わせ時点に依らず同じ値**が出る
	// （ブレイクから上限本数ぶんの足が揃った後は不変。揃うまでは暫定値）。
	const lastIdx = Math.min(startIdx + TARGET_REACH_MAX_BARS, candles.length - 1);
	let extremePrice = direction === 'down' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
	let extremeIdx = -1;
	// **初到達の足は極値の足とは別に記録する**（issue #288 Phase 2）。
	// `targetReachedDate` / `targetReachedPrice` は走査窓の extremum が付いた足なので、
	// 「いつ届いたか」ではなく「どこまで走ったか」を指す。表示に要るのは初到達の方で、
	// 両者は実データでも普通に別の足になる（届いた後もさらに伸びれば extremum は後ろへ動く）。
	// **極値の走査には一切触らない**——`targetReachedPct` / `targetReached` /
	// `targetReachedDate` / `targetReachedPrice` を 1 バイトも動かさないため。
	let firstReachIdx = -1;
	for (let i = startIdx; i <= lastIdx; i++) {
		const candle = candles[i];
		if (!candle) continue;
		if (direction === 'down') {
			const lo = Number(candle.low ?? NaN);
			if (!Number.isFinite(lo)) continue;
			if (lo < extremePrice) {
				extremePrice = lo;
				extremeIdx = i;
			}
			if (firstReachIdx < 0 && lo <= target) firstReachIdx = i;
		} else {
			const hi = Number(candle.high ?? NaN);
			if (!Number.isFinite(hi)) continue;
			if (hi > extremePrice) {
				extremePrice = hi;
				extremeIdx = i;
			}
			if (firstReachIdx < 0 && hi >= target) firstReachIdx = i;
		}
	}
	if (extremeIdx < 0 || !Number.isFinite(extremePrice)) return omittedTargetReach('no_bars_after_breakout');

	const targetReached = direction === 'down' ? extremePrice <= target : extremePrice >= target;
	// pct はブレイク価格から target 方向へどれだけ進んだかを 100% スケールで返す。
	// 分母を Math.abs にしておくことで、ブレイク足が既に target を越えていた場合の
	// 符号反転（reached=true なのに pct<0）を防ぐ。
	//
	// 丸めは reached/unreached で非対称にする:
	//   - reached=true:  round して [100, TARGET_REACHED_PCT_CAP] にクランプ
	//     （下側はオーバーシュート時の符号反転防止、上側は #210 (1) の安全網）
	//   - reached=false: floor して 99 にキャップ（99.6% などが 100 に丸まって
	//     下流の `pct >= 100` 判定を誤らせるのを防ぐ）
	const moveDistance = direction === 'down' ? breakoutPrice - extremePrice : extremePrice - breakoutPrice;
	const rawPct = (moveDistance / targetDistance) * 100;
	const targetReachedPct = targetReached
		? Math.min(TARGET_REACHED_PCT_CAP, Math.max(100, Math.round(rawPct)))
		: Math.min(99, Math.max(0, Math.floor(rawPct)));
	const targetReachedDate = candles[extremeIdx]?.isoTime;
	// **走査した本数は「ブレイク足を 0 本目とした後続の本数」**（`TARGET_REACH_MAX_BARS` と同じ
	// 数え方）。ブレイク足自身は含めないので、上限まで走れたときちょうど 60 になる。
	const targetScanBars = lastIdx - startIdx;
	const targetFirstReachDate = firstReachIdx >= 0 ? candles[firstReachIdx]?.isoTime : undefined;
	return {
		kind: 'measured',
		targetReachedPct,
		targetReached,
		...(targetReachedDate ? { targetReachedDate } : {}),
		targetReachedPrice: extremePrice,
		...(firstReachIdx >= 0 ? { targetFirstReachBars: firstReachIdx - startIdx } : {}),
		...(targetFirstReachDate ? { targetFirstReachDate } : {}),
		targetScanBars,
		targetScanComplete: targetScanBars === TARGET_REACH_MAX_BARS,
	};
}

/**
 * `computeTargetReach` の結果を `PatternEntry` に載せるフィールドへ落とす。
 *
 * 呼び出し側に同じ spread を書き写していたのを 1 箇所に寄せたもの。
 * **`omitted` を黙って `{}` に畳まない**——進捗が出ない理由を
 * `targetProgressOmittedReason` で申告する（#181 / #196 / #200 と同じ方針）。
 *
 * **引数から `undefined` を外してあるのは規約ではなく型で潰すため**（#224 症状 2）。
 * 以前は「ブレイクしていない」等のガードで `undefined` を渡せてしまい、
 * その 1 経路だけが理由を書かずに `{}` に畳んでいた（docstring は「畳まない」と宣言していた）。
 * ガードで呼ばない場合は `omittedTargetReach(reason)` を渡す。
 */
export function targetReachFields(reach: TargetReachResult): {
	targetReachedPct?: number;
	targetReached?: boolean;
	targetReachedDate?: string;
	targetReachedPrice?: number;
	targetFirstReachBars?: number;
	targetFirstReachDate?: string;
	targetScanBars?: number;
	targetScanComplete?: boolean;
	targetProgressOmittedReason?: TargetReachOmissionReason;
} {
	if (reach.kind === 'omitted') return { targetProgressOmittedReason: reach.reason };
	return {
		targetReachedPct: reach.targetReachedPct,
		targetReached: reach.targetReached,
		...(reach.targetReachedDate ? { targetReachedDate: reach.targetReachedDate } : {}),
		targetReachedPrice: reach.targetReachedPrice,
		// 到達の事実 4 フィールド（#288 Phase 2）。**`undefined` はキーごと落とす**——
		// 既存 4 フィールドと同じ扱いにしないと、素の JSON 比較で `undefined` の有無が差分になる。
		...(reach.targetFirstReachBars != null ? { targetFirstReachBars: reach.targetFirstReachBars } : {}),
		...(reach.targetFirstReachDate ? { targetFirstReachDate: reach.targetFirstReachDate } : {}),
		...(reach.targetScanBars != null ? { targetScanBars: reach.targetScanBars } : {}),
		...(reach.targetScanComplete != null ? { targetScanComplete: reach.targetScanComplete } : {}),
	};
}

/**
 * 理由コード → content 1 行に出す日本語文言。
 *
 * **`Record<TargetReachOmissionReason, string>` にしてあるのは、コードを足したときに
 * 文言を書き忘れると typecheck が落ちるようにするため。** 文言を落とすと
 * `formatTargetProgressLine` が「理由はあるのに何も言わない」に戻る。
 * `degenerate_target_distance` の文言は #210 のまま——既存の content 契約を動かさない。
 */
const TARGET_PROGRESS_OMISSION_NOTE: Record<TargetReachOmissionReason, string> = {
	not_broken_out: '未ブレイクのため未算出',
	no_target: 'ターゲット価格またはパターン高さが算出できないため',
	invalid_breakout_price: 'ブレイク足の終値が取得できないため',
	no_bars_after_breakout: 'ブレイク足以降のローソク足が無いため',
	degenerate_target_distance: `ブレイク足が想定値幅の${Math.round((1 - MIN_TARGET_DISTANCE_HEIGHT_RATIO) * 100)}%以上を消化済みで、残り距離が短く進捗率が意味を持たないため`,
	// **他の 5 つと言い回しを分ける。** 他は「この構造では測れない」だが、これは
	// 「測っていない」——構造の性質ではなく検出器の未配線なので、算出していない側の言い方にする。
	// 行頭ラベルを `ターゲット:` に揃えた（#288 Phase 2）のに合わせて「ターゲット進捗」→「ターゲットへの到達」。
	// **言っていることは同じ**——算出していない側の言い方も変えていない。
	not_computed_by_detector:
		'この検出器がターゲットへの到達を算出していないため。実装の未配線であり、構造の性質ではない',
};

/**
 * content テキストの「ターゲット」行を組む（`tools/detect_patterns.ts` と
 * `src/handlers/detectPatternsViewsHandler.ts` の共通実装）。
 *
 * ## 事実の記述にする（issue #288 Phase 2。**判定口調をやめた**）
 *
 * 旧実装は `ターゲット進捗: 273%（ブレイク後60本以内に到達）` のように出していた。
 * これは 2 つの意味で読み違えを誘う:
 *
 * 1. **`targetReachedPct` の 100 超は「進捗」ではない。** 分子は走査窓の extremum なので、
 *    100 を超えた数字は**到達した後にどこまで伸びたか**の倍率。実機で「進捗 273%」が
 *    出ており、到達後の超過倍率を進捗として読ませていた（issue #288 の症状）。
 * 2. **「N 本以内に到達 / 未到達」は成績に聞こえる。** Phase 1 の実測では、どの N でも
 *    パターン起点の到達率は帰無を上回っていない（`TARGET_REACH_MAX_BARS` の docstring）。
 *
 * そこで **100% 超の数字を content に出さず**、3 形の事実だけを書く:
 *
 * | 状態 | 行 |
 * |---|---|
 * | 到達 | `ターゲット: 到達（ブレイク後 14 本目、2026-09-08 06:00）` |
 * | 未到達・走査完了 | `ターゲット: 未到達（走査 60 本完了、目標幅の 22% まで接近）` |
 * | 未到達・走査中 | `ターゲット: 未到達（ブレイク後 13 本経過 / 走査上限 60 本、目標幅の 22% まで接近）` |
 *
 * 「目標幅の x%」の x は `targetReachedPct`（未到達側は 99 でキャップ済みなので 100 を超えない）。
 * **価格は出さない**——呼び出し側が直前に `ターゲット価格: …円（投影方式）` を出しており、
 * 2 か所に書くと数字が二重になる（どちらか 1 か所に出ていれば足りる）。
 *
 * ## 交絡は限定して申告する
 *
 * 素朴に「走査窓に他パターンのブレイクがあった」と書くと **94.7% の実体に付く**（Phase 1 §5）ので、
 * 申告しているのと変わらない。付ける条件を 2 つに絞ってある（集合の定義は
 * `tools/patterns/target-confounders.ts` が単一ソース）:
 *
 * - 到達した側 — `(ブレイク, 初到達)` の**開区間**に他パターンのブレイクがあるとき。方向は問わない。
 * - 未到達の側 — 走査窓 `(ブレイク, ブレイク + targetScanBars]` に**逆方向**のブレイクがあるとき。
 *
 * ## 引数
 *
 * 行そのものを返す（先頭の `\n` は呼び出し側が付ける）。
 * **`targetProgressOmittedReason` があれば必ず 1 行返す**（#224 症状 2）。`null` を返すのは
 * 「進捗も理由も無い」＝ そもそも `computeTargetReach` の対象外だったときだけ。
 * 引数の型が緩いのは `PatternEntry` を経由せず素の JSON を渡す消費者
 * （`detect_patterns.ts` の `SummaryPattern`）があるため——**新フィールドが 1 つも無い
 * 素の JSON でも通る**ように、到達の本数・日時・走査本数はすべて optional として扱う。
 * 未知のコードが来ても**黙らせない**——コードそのものを出す。
 *
 * 日時の整形は呼び出し側の tz 整形に合わせる（`opts.formatDate`）。渡されなければ
 * UTC ISO をそのまま出す。
 */
export function formatTargetProgressLine(
	p: {
		targetReachedPct?: number;
		targetReached?: boolean;
		targetProgressOmittedReason?: string;
		targetFirstReachBars?: number;
		targetFirstReachDate?: string;
		targetScanBars?: number;
		targetScanComplete?: boolean;
		targetOtherBreakoutBeforeReach?: readonly TargetBreakoutConfounder[];
		targetOppositeBreakoutInWindow?: readonly TargetBreakoutConfounder[];
	},
	opts: { formatDate?: (iso: string) => string } = {},
): string | null {
	if (p.targetProgressOmittedReason) {
		const note =
			TARGET_PROGRESS_OMISSION_NOTE[p.targetProgressOmittedReason as TargetReachOmissionReason] ??
			p.targetProgressOmittedReason;
		return `${TARGET_LINE_PREFIX}出力なし（${note}）`;
	}
	if (p.targetReachedPct == null) return null;
	const pct = Number(p.targetReachedPct);
	// **`targetReached` があればそれを信じる。** 無い（素の JSON の古い消費者）ときだけ
	// `pct >= 100` に落とす——旧実装と同じ判定なので、行の分岐は 1 バイトもずれない。
	const reached = p.targetReached ?? pct >= 100;

	if (reached) {
		const bars = p.targetFirstReachBars;
		const date = p.targetFirstReachDate ? formatIso(p.targetFirstReachDate, opts.formatDate) : null;
		// 初到達の本数が無い（新フィールドを持たない素の JSON）ときは本数を騙らず、
		// **走査窓の幅までしか言わない。**
		const detail =
			bars == null ? `ブレイク後${TARGET_REACH_MAX_BARS}本以内` : `ブレイク後 ${bars} 本目${date ? `、${date}` : ''}`;
		const note = confounderNote(p.targetOtherBreakoutBeforeReach, '到達前に別パターンのブレイクあり');
		return `${TARGET_LINE_PREFIX}到達（${detail}）${note}`;
	}

	const approach = `目標幅の ${pct}% まで接近`;
	const scanBars = p.targetScanBars;
	const complete = p.targetScanComplete ?? (scanBars != null && scanBars >= TARGET_REACH_MAX_BARS);
	const detail = complete
		? `走査 ${TARGET_REACH_MAX_BARS} 本完了、${approach}`
		: scanBars == null
			? `走査上限 ${TARGET_REACH_MAX_BARS} 本、${approach}`
			: `ブレイク後 ${scanBars} 本経過 / 走査上限 ${TARGET_REACH_MAX_BARS} 本、${approach}`;
	const note = confounderNote(p.targetOppositeBreakoutInWindow, '走査窓内に逆方向のブレイクあり');
	return `${TARGET_LINE_PREFIX}未到達（${detail}）${note}`;
}

/** 行頭ラベル。3 形 + 出力なしで**同じ前置き**にする（規約 3 の上位集合テストが語で照合する）。 */
const TARGET_LINE_PREFIX = '   - ターゲット: ';

function formatIso(iso: string, formatDate?: (iso: string) => string): string {
	if (!formatDate) return iso;
	try {
		const out = formatDate(iso);
		return out && out !== 'n/a' ? out : iso;
	} catch {
		return iso;
	}
}

/**
 * 交絡の申告を行末に足す。空なら**何も足さない**（Phase 1 §5 の 94.7% を素朴に出さないため、
 * 呼び出し側が集合を絞ったうえで空配列 / 未設定にしてくる）。
 */
function confounderNote(list: readonly TargetBreakoutConfounder[] | undefined, label: string): string {
	if (!Array.isArray(list) || list.length === 0) return '';
	const body = list
		.map((c) => `${c.type} ${c.direction === 'down' ? '下方' : '上方'} +${c.barsAfterBreakout} 本`)
		.join(', ');
	return `。${label}（${body}）`;
}
