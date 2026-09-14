/**
 * issue #169 の回帰テスト — double のサイズ検査。
 *
 * 反転パターンの形成中パスのうち、**double の 2 経路だけが完成済みと揃っていなかった**。
 * 形成中ダブルボトムは両脚の高さしか見ておらず深さ（`depthPct`）が無く、
 * 形成中ダブルトップは**サイズ検査そのものが無かった**（下限がゼロ）。
 * triple / H&S の形成中パスは #139 で `validatePatternSize`（高さ + 深さ）に揃っている。
 *
 * ## double の形成中パスは 2 経路とも消えた（#262 / #268 案 C）
 *
 * `tryFormingDoubleBottom` は「構造が揃ってブレイクを待っている」段階を `forming` という
 * 誤ラベルで出しており、#262 でその段階を完成済み経路の `near_completion` に付け替えて削除した。
 * `tryFormingDoubleTop` は **#268 案 C** で削除した（実データで accepted 0 件）。
 * したがって**このファイルが見ているのは完成済みパス（`near_completion` を含む）だけ**で、
 * 期待値は `forming_*` 接頭辞の理由コードから完成済みの理由コード
 * （`peak_too_shallow` / `valley_too_shallow` / `pattern_too_small`）へ移り、accepted な形の
 * `status` は `forming` から `near_completion` へ移った。
 *
 * **#169 が固定したかったのは「形成中と完成済みでサイズ判定が一致する」ことだったが、
 * double では比較対象の形成中パスが無くなったので「完成済みパスがこの 3 水準をこう落とす」
 * だけが残る。** 検査そのものは緩んでいない——`validateTopSize` / `validateBottomSize` は
 * 形成中パスでも完成済みパスでも同じ 3 点に掛かっていたので、落ちる形・通る形は変わらない
 * （このファイルの数値がそのまま残っているのがその証拠）。形成中パス専用だった検査で消えたのは
 * 両脚チェック `forming_pattern_height_below_min` だけで、完成済みの高さ検査
 * （`pattern_too_small`）が同じ役割を果たす。
 *
 * `FORMING_PEAK_TOLERANCE_PCT`（形成中ダブルトップの水準一致判定の緩和。「緩めてよいのは
 * 同水準かの判定で、形と呼べる大きさかではない」という #138 欠陥 2-2 / #139 の原則の実例）も
 * `tryFormingDoubleTop` と一緒に消えた。原則そのものは形成中 triple に残っている。
 *
 * ## この fixture が **ヒゲ無し**（`high = low = close`）なのはなぜか
 *
 * サイズ検査の価格基準は `Pivot.extremePrice`（高安）だが、`extremePrice` と終値が
 * ずれているとテストに書いた % がコードの計算と一致しなくなる。ここで固定したいのは
 * 「閾値の境界でどちらの検査が発火するか」なので、`extremePrice === close` にして
 * 期待値を素の割り算で読めるようにしてある。**`extremePrice` を使う根拠そのもの**
 * （終値基準だと値幅が実際の 1/3 に見える）は `detect_doubles.ts` の
 * `validateTopSize` の docstring と #130 / #131 が担保している。
 *
 * ## 時間足
 *
 * サイズ検査そのものの回帰はアンカーの `1day`（`heightPct` 3% / `depthPct` 5% で据え置き）で見る。
 * `1hour` は 0.62% / 1.04% なので**同じ値動きが通る**——issue #152 / PR #168 で入った
 * 時間足別テーブルとサイズ検査の関係も同じ fixture で固定してある。
 */
import { describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import { getSizeThresholdsForTf } from '../../tools/patterns/config.js';
import { asMockResult } from '../_assertResult.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';

type Candle = { isoTime: string; open: number; high: number; low: number; close: number; volume: number };

const DAY = getSizeThresholdsForTf('1day');
const HOUR = getSizeThresholdsForTf('1hour');

/** 固定の起点から i 本後。相対時刻にしないのは実行日でパターンが動かないようにするため。 */
function isoAt(i: number): string {
	return dayjs.utc('2026-01-01T00:00:00Z').add(i, 'day').toISOString();
}

/** ヒゲ無しのローソク（`extremePrice === close`）。理由はファイル冒頭の docstring を参照。 */
function mkCandle(i: number, close: number): Candle {
	return { isoTime: isoAt(i), open: close, high: close, low: close, close, volume: 100 };
}

/**
 * 形成中ダブルボトム: 谷1（idx=4, 安値 100）→ 山（idx=14, 高値 `peak`）→ 谷2（idx=24, 安値 100）
 * → 直近は上昇中。構成点 3 点はすべて確定ピボットで、最新足は構成点ではない。
 *
 * 谷2 からの反発を速くしてあるのは、谷ゾーン（谷 + パターン高さ × `TROUGH_REENTRY_FRACTION`）を
 * 1 本目で抜けないと `re_entered_trough_zone` で `invalid` になり、サイズ検査より前に
 * 別の理由で落ちてしまうため。`lastIdx = 42` は `formationBars = 38` を `1day` / `1hour` の
 * 両方のレンジに入れつつ、谷2 からの経過（18 本）を `FORMING_EXPIRY_BARS = 20` 以内に収める。
 */
function buildFormingDoubleBottom(peak: number, lastIdx = 42): Candle[] {
	const closes: number[] = [106, 104, 102, 101, 100];
	for (let i = 1; i <= 10; i++) closes.push(100 + ((peak - 100) * i) / 10); // idx 5..14 → 山は idx=14
	for (let i = 1; i <= 10; i++) closes.push(peak - ((peak - 100) * i) / 10); // idx 15..24 → 谷2 は idx=24
	const n = lastIdx - 24;
	const tail = peak - 1;
	for (let i = 1; i <= n; i++) closes.push(100 + (tail - 100) * (0.6 + (0.4 * i) / n));
	return closes.map((c, i) => mkCandle(i, c));
}

/**
 * 3 水準（山1 100 / 谷 `valley` / 山2 100）を**すべて確定ピボット**にした完成済み形状。
 *
 * **#169 当時は同じ 3 水準の形成中形状（`buildFormingDoubleTop`）との比較用だった。**
 * 形成中 `double_top` の経路が #268 案 C で消えたので比較相手が無くなり、今はこの形だけで
 * 「top 側のサイズ検査が 3 水準をどう落とすか」を固定する。
 */
function buildCompletedShapeDoubleTop(valley: number): Candle[] {
	const closes: number[] = [94, 96, 98, 100];
	for (let i = 1; i <= 5; i++) closes.push(100 - ((100 - valley) * i) / 5); // idx 4..8 → 谷は idx=8
	for (let i = 1; i <= 5; i++) closes.push(valley + ((100 - valley) * i) / 5); // idx 9..13 → 山2 は idx=13
	for (let i = 1; i <= 12; i++) closes.push(100 - i); // idx 14..25 下落
	return closes.map((c, i) => mkCandle(i, c));
}

/**
 * 1 系列を `view=debug` で流し、`data.patterns` と候補の理由コード / accepted な status を返す。
 * サイズ検査は棄却側で見るので、理由コードの配列がこのファイルの主な検査対象。
 */
async function detect(candles: Candle[], tf: string, want: 'double_top' | 'double_bottom') {
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	const res = (await detectPatterns('btc_jpy', tf, candles.length, {
		patterns: [want],
		swingDepth: 2,
		includeForming: true,
		includeCompleted: true,
		view: 'debug',
	})) as {
		ok: boolean;
		data?: { patterns?: Array<{ type: string; status?: string }> };
		meta?: { debug?: { candidates?: Array<{ type: string; accepted: boolean; reason?: string; status?: string }> } };
	};
	expect(res.ok).toBe(true);
	const candidates = res.meta?.debug?.candidates ?? [];
	return {
		patterns: res.data?.patterns ?? [],
		reasons: candidates.filter((c) => !c.accepted).map((c) => c.reason),
		acceptedStatuses: candidates.filter((c) => c.accepted).map((c) => c.status),
	};
}

describe('double のサイズ検査（issue #169 / #262 / #268）', () => {
	describe('ブレイク待ちダブルボトム: 深さ（depthPct）', () => {
		// 谷 100 / 100、山 104 → 両脚 (104-100)/104 = 3.85% ≥ 3% で高さは通り、
		// 深さ (104-100)/100 = 4% < 5% で落ちる。
		const legPct = (104 - 100) / 104;
		const depth = (104 - 100) / 100;

		it('前提: この形は 1day の heightPct を超え depthPct を割る（帯の内側）', () => {
			expect(legPct).toBeGreaterThanOrEqual(DAY.heightPct);
			expect(depth).toBeLessThan(DAY.depthPct);
		});

		// **期待値を `forming_peak_too_shallow` → `peak_too_shallow` に変えた（#262）。**
		// 同じ 3 点に同じ `validateBottomSize` が掛かる経路が完成済みパスだけになったため。
		// 落ちる値動きは変わっていない（`depth` の前提は上のテストがそのまま固定している）。
		it('1day: 高さは通るが深さで落ち、peak_too_shallow が記録される', async () => {
			const r = await detect(buildFormingDoubleBottom(104), '1day', 'double_bottom');
			expect(r.patterns).toHaveLength(0);
			expect(r.reasons).toContain('peak_too_shallow');
			// 高さの段では落ちていない
			expect(r.reasons).not.toContain('pattern_too_small');
			// 形成中パスは削除済みなので `forming_` 接頭辞の理由コードは 1 件も出ない（#262）
			expect(r.reasons).not.toContain('forming_peak_too_shallow');
			expect(r.reasons).not.toContain('forming_pattern_height_below_min');
		});

		it('1hour: 同じ値動きは閾値が緩いので検出される（時間足別テーブル / #152）', async () => {
			expect(depth).toBeGreaterThanOrEqual(HOUR.depthPct);
			const r = await detect(buildFormingDoubleBottom(104), '1hour', 'double_bottom');
			expect(r.patterns.map((p) => p.type)).toContain('double_bottom');
			// 未ブレイクなので `near_completion`（#262。旧 `forming` は誤ラベルだった）
			expect(r.patterns[0]?.status).toBe('near_completion');
			expect(r.reasons).not.toContain('peak_too_shallow');
		});

		it('1day: 深さを満たす形（山 105）はこれまでどおり検出される', async () => {
			expect((105 - 100) / 100).toBeGreaterThanOrEqual(DAY.depthPct);
			const r = await detect(buildFormingDoubleBottom(105), '1day', 'double_bottom');
			expect(r.patterns.map((p) => p.type)).toContain('double_bottom');
			expect(r.patterns[0]?.status).toBe('near_completion');
		});

		// **期待値を `forming_pattern_height_below_min` → `pattern_too_small` に変えた（#262）。**
		// 両脚チェックは形成中パス専用の検査で、同関数の削除と一緒に消えた。同じ値動きは
		// 完成済みの `validateBottomSize` の高さ検査（左脚 ≥ heightPct）が落とす——#166 が
		// 固定したかった「山 102 の形は検出されない」は据え置き。
		it('1day: 高さが足りない形（山 102）は pattern_too_small で落ちる（#166 の値動きを据え置き）', async () => {
			// 山 102 → 両脚 (102-100)/102 = 1.96% < 3%。深さの段より前に落ちる。
			expect((102 - 100) / 102).toBeLessThan(DAY.heightPct);
			const r = await detect(buildFormingDoubleBottom(102), '1day', 'double_bottom');
			expect(r.patterns).toHaveLength(0);
			expect(r.reasons).toContain('pattern_too_small');
			expect(r.reasons).not.toContain('peak_too_shallow');
		});
	});

	describe('完成済みダブルトップ: 高さ（heightPct）と深さ（depthPct）', () => {
		/**
		 * **#169 が固定した 5 ケース（形成中 `double_top` の形状を食わせるもの）を削除した（#268 案 C）。**
		 * `tryFormingDoubleTop` が消えたので、`forming_valley_too_shallow` /
		 * `forming_pattern_too_small` を出す経路そのものが無い。残すのは**同じ 3 水準を完成済み
		 * パスが落とすこと**で、#169 の関心（「形と呼べる大きさか」の下限が top 側にもあること）は
		 * こちらで保たれる。形成中パスが 1 件も出ないことは
		 * `tests/patterns/no-forming-double-268.test.ts` のトリップワイヤが別途固定する。
		 */
		it('1day: 山 100 / 谷 96 / 山2 100 は深さ 4% < 5% で valley_too_shallow に落ちる', async () => {
			expect((100 - 96) / 100).toBeGreaterThanOrEqual(DAY.heightPct);
			expect((100 - 96) / 100).toBeLessThan(DAY.depthPct);
			const r = await detect(buildCompletedShapeDoubleTop(96), '1day', 'double_top');
			expect(r.patterns).toHaveLength(0);
			expect(r.reasons).toContain('valley_too_shallow');
			// 形成中パスは削除済みなので `forming_` 接頭辞の理由コードは 1 件も出ない（#268 案 C）
			expect(r.reasons).not.toContain('forming_valley_too_shallow');
			expect(r.reasons).not.toContain('forming_pattern_too_small');
		});

		it('1day: 山 100 / 谷 98 / 山2 100 は高さ 2% < 3% で pattern_too_small に落ちる', async () => {
			expect((100 - 98) / 100).toBeLessThan(DAY.heightPct);
			const r = await detect(buildCompletedShapeDoubleTop(98), '1day', 'double_top');
			expect(r.patterns).toHaveLength(0);
			expect(r.reasons).toContain('pattern_too_small');
		});

		/**
		 * **見るのはサイズ検査の理由コードが出ないことで、`data.patterns` の件数ではない。**
		 * この形状は 3 点目の後に 12 本の下落を置いてブレイクを作っており、そのぶん最新足から
		 * 離れるので `status: 'completed'` でもライフサイクル絞り込み（`meta.reduction.lifecycleExcluded`）
		 * で出力から落ちることがある。#152 が固定したいのは**同じ値動きが時間足別テーブルで
		 * サイズ検査を通る**ことなので、そこだけを見る。
		 */
		it('1hour: 同じ値動き（谷 96 / 谷 98）はどちらもサイズ検査を通る（時間足別テーブル / #152）', async () => {
			expect((100 - 98) / 100).toBeGreaterThanOrEqual(HOUR.depthPct);
			for (const valley of [96, 98]) {
				const r = await detect(buildCompletedShapeDoubleTop(valley), '1hour', 'double_top');
				expect(r.reasons, `谷 ${valley}`).not.toContain('valley_too_shallow');
				expect(r.reasons, `谷 ${valley}`).not.toContain('pattern_too_small');
			}
		});
	});
});
