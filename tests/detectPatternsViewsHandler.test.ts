import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDebugView, REJECTION_CROSS_TOTAL_LABEL } from '../src/handlers/detectPatternsDebugView.js';
import {
	buildDetectionRouteLine,
	buildTypeSummary,
	formatDetailedView,
	formatFullView,
	formatPatternLine,
	formatStatusLine,
	formatSummaryView,
} from '../src/handlers/detectPatternsViewsHandler.js';
import { DetectedPatternSchema, PatternTypeEnum } from '../src/schema/patterns.js';
import type { BreakoutPathRejectReason, ContinuationInvalidReason } from '../tools/patterns/structural.js';
import { TARGET_REACH_MAX_BARS, TARGET_REACHED_PCT_CAP } from '../tools/patterns/target-reach.js';
import type { PatternEntry } from '../tools/patterns/types.js';

afterEach(() => {
	vi.resetAllMocks();
});

function makePattern(overrides: Partial<PatternEntry> = {}): PatternEntry {
	return {
		type: 'double_top',
		confidence: 0.75,
		range: { start: '2026-01-01T00:00:00.000Z', end: '2026-01-20T00:00:00.000Z' },
		pivots: [
			{ idx: 0, price: 100000, kind: 'H', extremePrice: 101000 },
			{ idx: 5, price: 90000, kind: 'L', extremePrice: 89000 },
			{ idx: 10, price: 100000, kind: 'H', extremePrice: 101000 },
		],
		...overrides,
	};
}

// `effective_params` は入力値ではなく解決後の実効値を持つ。
const emptyMeta = {
	debug: { swings: [], candidates: [] },
	effective_params: {
		swingDepth: { value: 6, source: 'auto' as const },
		minBarsBetweenSwings: { value: 4, source: 'auto' as const },
		tolerancePct: { value: 0.04, source: 'auto' as const },
		headProminencePct: { value: 0.04, source: 'auto' as const },
	},
};

const emptyRes = {
	ok: true,
	summary: 'ok',
	data: { patterns: [], overlays: null },
	meta: {},
};

describe('buildTypeSummary', () => {
	it('種別別カウントを返す', () => {
		const pats = [makePattern(), makePattern({ type: 'bull_pennant' }), makePattern()];
		const result = buildTypeSummary(pats);
		expect(result).toContain('double_top×2');
		expect(result).toContain('bull_pennant×1');
	});

	it('type が undefined のとき unknown にグループ化する', () => {
		const pats = [{} as PatternEntry];
		expect(buildTypeSummary(pats)).toContain('unknown×1');
	});
});

function makeDebugViewRes() {
	return {
		ok: true as const,
		summary: 'debug',
		data: { patterns: [], overlays: null },
		meta: {},
	};
}

// biome-ignore lint/suspicious/noExplicitAny: test fixture
function makeMeta(candidates: any[]) {
	return {
		debug: {
			swings: [{ kind: 'peak', idx: 3, price: 100000, isoTime: '2026-01-03T00:00:00.000Z' }],
			candidates,
		},
	};
}

describe('formatDebugView / formatCandidateDetails', () => {
	it('details がない候補を "details: none" と表示する', () => {
		const meta = makeMeta([{ type: 'wedge', accepted: false, reason: 'probe_window' }]);
		const res = formatDebugView('hdr', meta, [], makeDebugViewRes());
		const text = res.content[0].text;
		expect(text).toContain('details: none');
	});

	it('type_classification_failed の詳細を表示する', () => {
		const meta = makeMeta([
			{
				type: 'wedge',
				accepted: false,
				reason: 'type_classification_failed',
				details: { failureReason: 'slope diverges', slopeHigh: 0.001, slopeLow: -0.002, slopeRatio: 0.5 },
			},
		]);
		const res = formatDebugView('hdr', meta, [], makeDebugViewRes());
		const text = res.content[0].text;
		expect(text).toContain('failureReason: slope diverges');
		expect(text).toContain('slopeRatio: 0.500');
	});

	it('probe_window の詳細を表示する', () => {
		const meta = makeMeta([
			{
				type: 'triangle',
				accepted: false,
				reason: 'probe_window',
				details: {
					slopeHigh: 0.002,
					slopeLow: 0.001,
					priceRange: 5000,
					barsSpan: 20,
					minMeaningfulSlope: 0.0005,
					highsIn: [{ index: 0, price: 100000 }],
					lowsIn: [{ index: 2, price: 95000 }],
				},
			},
		]);
		const res = formatDebugView('hdr', meta, [], makeDebugViewRes());
		const text = res.content[0].text;
		expect(text).toContain('upper.slope');
		expect(text).toContain('barsSpan');
	});

	it('declining_highs の詳細を表示する', () => {
		const meta = makeMeta([
			{
				type: 'wedge',
				accepted: false,
				reason: 'declining_highs',
				details: { highsCount: 5, firstAvg: 102000, secondAvg: 98000, ratio: 0.96 },
			},
		]);
		const res = formatDebugView('hdr', meta, [], makeDebugViewRes());
		const text = res.content[0].text;
		expect(text).toContain('declining_highs: true');
		expect(text).toContain('1st half avg');
	});

	it('詳細の価格もスイングと同じ桁で出し、1 円未満のペアで 0 に潰さない', () => {
		const meta = {
			debug: {
				swings: [{ kind: 'peak', idx: 3, price: 0.0512345, isoTime: '2026-01-03T00:00:00.000Z' }],
				candidates: [
					{
						type: 'wedge',
						accepted: false,
						reason: 'declining_highs',
						details: { highsCount: 5, firstAvg: 0.0512345, secondAvg: 0.0498765, ratio: 0.96 },
					},
				],
			},
		};
		const text = formatDebugView('hdr', meta, [], makeDebugViewRes()).content[0].text;
		expect(text).toContain('1st half avg: 0.0512345');
		expect(text).toContain('2nd half avg: 0.0498765');
	});

	it('declining_highs_probe の詳細を表示する', () => {
		const meta = makeMeta([
			{
				type: 'wedge',
				accepted: false,
				reason: 'declining_highs_probe',
				details: { highsCount: 4, firstAvg: 101000, secondAvg: 99000, ratio: 0.98 },
			},
		]);
		const res = formatDebugView('hdr', meta, [], makeDebugViewRes());
		const text = res.content[0].text;
		expect(text).toContain('declining_highs_probe: metrics');
	});

	it('rising_probe の詳細を表示する', () => {
		const meta = makeMeta([
			{
				type: 'wedge',
				accepted: false,
				reason: 'rising_probe',
				details: {
					r2High: 0.9,
					r2Low: 0.85,
					slopeHigh: 0.001234,
					slopeLow: 0.000567,
					slopeRatioLH: 2.1,
					priceRange: 10000,
					barsSpan: 30,
					minMeaningfulSlope: 0.00012,
					highsIn: [],
					lowsIn: [],
					firstAvg: 100000,
					secondAvg: 105000,
					ratio: 1.05,
				},
			},
		]);
		const res = formatDebugView('hdr', meta, [], makeDebugViewRes());
		const text = res.content[0].text;
		expect(text).toContain('r2: hi=');
		expect(text).toContain('slopeRatioLH');
	});

	it('post_filter_rising_highs_not_declining の詳細を表示する', () => {
		const meta = makeMeta([
			{
				type: 'wedge',
				accepted: false,
				reason: 'post_filter_rising_highs_not_declining',
				details: { highsCount: 6, firstAvg: 98000, secondAvg: 103000, ratio: 1.05 },
			},
		]);
		const res = formatDebugView('hdr', meta, [], makeDebugViewRes());
		const text = res.content[0].text;
		expect(text).toContain('post_filter: rising highs not declining');
	});

	it('post_filter_falling_lows_not_rising の詳細を表示する', () => {
		const meta = makeMeta([
			{
				type: 'wedge',
				accepted: false,
				reason: 'post_filter_falling_lows_not_rising',
				details: { lowsCount: 5, firstAvg: 99000, secondAvg: 94000, ratio: 0.95 },
			},
		]);
		const res = formatDebugView('hdr', meta, [], makeDebugViewRes());
		const text = res.content[0].text;
		expect(text).toContain('post_filter: falling lows not rising');
	});

	it('default ケース: details の実フィールドを列挙する', () => {
		const meta = makeMeta([
			{
				type: 'rising_wedge',
				accepted: false,
				reason: 'r2_below_threshold',
				details: { r2High: 0.31, r2Low: 0.42, slopeHigh: 0.001, slopeLow: -0.001, r2MinRequired: 0.5 },
			},
		]);
		const res = formatDebugView('hdr', meta, [], makeDebugViewRes());
		const text = res.content[0].text;
		expect(text).toContain('r2High: 0.31');
		expect(text).toContain('r2Low: 0.42');
		expect(text).toContain('r2MinRequired: 0.5');
		expect(text).toContain('slopeHigh: 0.001');
	});

	it('default ケース: 存在しないフィールドを n/a として捏造しない', () => {
		const meta = makeMeta([
			{
				type: 'rising_wedge',
				accepted: false,
				reason: 'insufficient_touches',
				details: { upperTouches: 1, lowerTouches: 2, minRequired: 3 },
			},
		]);
		const text = formatDebugView('hdr', meta, [], makeDebugViewRes()).content[0].text;
		expect(text).toContain('upperTouches: 1');
		expect(text).not.toContain('spread');
		expect(text).not.toContain('n/a');
	});

	it('default ケース: details が空オブジェクトなら (no fields)', () => {
		const meta = makeMeta([{ type: 'rising_wedge', accepted: false, reason: 'unknown_reason', details: {} }]);
		const text = formatDebugView('hdr', meta, [], makeDebugViewRes()).content[0].text;
		expect(text).toContain('details: (no fields)');
	});

	it('default ケース: 価格スケールの値は丸めて表示し、ネストは短縮 JSON にする', () => {
		const meta = makeMeta([
			{
				type: 'rising_wedge',
				accepted: false,
				reason: 'score_below_threshold',
				details: { priceRange: 1234567.891, components: { fit: 0.4, touch: 0.2 } },
			},
		]);
		const text = formatDebugView('hdr', meta, [], makeDebugViewRes()).content[0].text;
		expect(text).toContain('priceRange: 1,234,568');
		expect(text).toContain('components: {"fit":0.4,"touch":0.2}');
	});

	it('accepted=true の候補に ✅ を付与する', () => {
		const meta = makeMeta([
			{ type: 'wedge', accepted: true, reason: 'ok', points: [{ role: 'hi', idx: 3, price: 100000 }] },
		]);
		const res = formatDebugView('hdr', meta, [], makeDebugViewRes());
		expect(res.content[0].text).toContain('✅');
	});

	it('スイングなし・候補なしのとき "なし" を表示する', () => {
		const meta = { debug: { swings: [], candidates: [] } };
		const res = formatDebugView('hdr', meta, [], makeDebugViewRes());
		const text = res.content[0].text;
		expect(text).toContain('なし');
	});
});

describe('formatDebugView: cap トリムの申告行（#180）', () => {
	const cands = [
		{ type: 'triple_bottom', accepted: true },
		{ type: 'triple_bottom', accepted: false, reason: 'peaks_missing_relaxed' },
	];

	it('省略があるとき「N / 全 M 件（K 件省略）」と落ちた側の説明を出す', () => {
		const meta = {
			debug: {
				swings: [{ kind: 'peak', idx: 3, price: 100000, isoTime: '2026-01-03T00:00:00.000Z' }],
				candidates: cands,
				candidatesTotal: 289,
				candidatesOmitted: 287,
				swingsTotal: 5,
				swingsOmitted: 4,
			},
		};
		const text = formatDebugView('hdr', meta, [], makeDebugViewRes()).content[0].text;
		// candidates は accepted 優先で残すので落ちるのは棄却理由、swings は先頭から残すので落ちるのは直近側。逆向きであることまで出す。
		expect(text).toContain(
			'【Candidates】 2 / 全 289 件（287 件省略。accepted は全件残っているため省略分はすべて棄却理由）',
		);
		expect(text).toContain('【Swings】 1 / 全 5 件（4 件省略。先頭から残すため省略分はすべて直近側のスイング）');
	});

	// トリムは `[...accepted, ...rejected]` を先頭から cap 件残すだけなので、accepted が cap を超えれば accepted も押し出される。
	it('返却分が全件 accepted のときは「棄却理由だけ」と言い切らない', () => {
		const meta = {
			debug: {
				swings: [],
				candidates: [
					{ type: 'triple_bottom', accepted: true },
					{ type: 'triple_top', accepted: true },
				],
				candidatesTotal: 300,
				candidatesOmitted: 298,
				swingsTotal: 0,
				swingsOmitted: 0,
			},
		};
		const text = formatDebugView('hdr', meta, [], makeDebugViewRes()).content[0].text;
		expect(text).toContain(
			'【Candidates】 2 / 全 300 件（298 件省略。accepted が cap を埋めており省略分に accepted も含まれうる）',
		);
		expect(text).not.toContain('すべて棄却理由');
	});

	it('省略が 0 のとき「省略なし」と明示する', () => {
		const meta = {
			debug: {
				swings: [],
				candidates: cands,
				candidatesTotal: 2,
				candidatesOmitted: 0,
				swingsTotal: 0,
				swingsOmitted: 0,
			},
		};
		const text = formatDebugView('hdr', meta, [], makeDebugViewRes()).content[0].text;
		expect(text).toContain('【Candidates】 2 / 全 2 件（省略なし）');
		expect(text).toContain('【Swings】 0 / 全 0 件（省略なし）');
	});

	// 件数が分からないときに「省略なし」と書くと、切られたのに切られたと分からない嘘になるので、申告フィールドが無い meta では行ごと出さない。
	it('申告フィールドが無い meta では件数行を出さない', () => {
		const meta = makeMeta(cands);
		const text = formatDebugView('hdr', meta, [], makeDebugViewRes()).content[0].text;
		expect(text).toContain('【Candidates】\n');
		expect(text).toContain('【Swings】\n');
		expect(text).not.toContain('省略なし');
		expect(text).not.toContain('件省略');
	});
});

/** 文言ではなく数字の整合（行の合計 = 上に書いた rejected 件数）を検証するための parser（#191）。 */
function parseRejectionRows(text: string): Array<{ type: string; count: number; reasons: Array<[string, number]> }> {
	const rows: Array<{ type: string; count: number; reasons: Array<[string, number]> }> = [];
	for (const line of text.split('\n')) {
		const m = line.match(/^\s+- (\S+) (\d+) 件: (.+)$/u);
		if (!m) continue;
		const reasons = m[3].split(' / ').map((part) => {
			const r = part.match(/^(.+) (\d+)$/u);
			return [r ? r[1] : part, r ? Number(r[2]) : Number.NaN] as [string, number];
		});
		rows.push({ type: m[1], count: Number(m[2]), reasons });
	}
	return rows;
}

/** 残余行（`- （他 N 種別）M 件`）。畳んだ分も合計に入れ続けることの検証に使う。 */
function parseRestRow(text: string): { types: number; count: number } | null {
	const m = text.match(/^\s+- （他 (\d+) 種別）(\d+) 件$/mu);
	return m ? { types: Number(m[1]), count: Number(m[2]) } : null;
}

/** 行が無ければ `null` を返し、「出していない」と「合計が 0」を呼び出し側で区別できるようにする。 */
function parseCrossTotalRow(text: string): Array<[string, number]> | null {
	const lines = text.split('\n');
	const i = lines.findIndex((line) => line.startsWith(REJECTION_CROSS_TOTAL_LABEL));
	if (i < 0) return null;
	const m = lines[i + 1]?.match(/^\s+- (.+)$/u);
	if (!m) return null;
	return m[1].split(' / ').map((part) => {
		const r = part.match(/^(.+) (\d+)$/u);
		return [r ? r[1] : part, r ? Number(r[2]) : Number.NaN] as [string, number];
	});
}

const rejects = (type: string, reason: string | undefined, n: number) =>
	Array.from({ length: n }, () => ({ type, accepted: false, ...(reason === undefined ? {} : { reason }) }));

describe('formatDebugView: 棄却理由の集計ブロック（#191 A）', () => {
	it('cap 省略なし: 分母を書き切り、type 別 → reason 別の内訳の合計が rejected と一致する', () => {
		const candidates = [
			{ type: 'triple_top', accepted: true },
			...rejects('triple_top', 'peaks_not_equal', 5),
			...rejects('triple_top', 'valleys_missing', 3),
			...rejects('double_bottom', 'no_breakout', 2),
		];
		const meta = {
			debug: { swings: [], candidates, candidatesTotal: 11, candidatesOmitted: 0, swingsTotal: 0, swingsOmitted: 0 },
		};
		const text = formatDebugView('hdr', meta, [], makeDebugViewRes()).content[0].text;

		// 分母は 3 つとも書く。読み手に引き算をさせない（#191 要件 1）
		expect(text).toContain('▼ 候補の内訳: 全 11 件 = accepted 1 件 + rejected 10 件（cap 省略なし＝全候補の内訳）');
		expect(text).toContain('▼ 棄却理由の内訳（type 別 → reason 別。合計は上の rejected 10 件と一致する）');
		expect(text).toContain('   - triple_top 8 件: peaks_not_equal 5 / valleys_missing 3');
		expect(text).toContain('   - double_bottom 2 件: no_breakout 2');

		const rows = parseRejectionRows(text);
		// 件数の多い type が先。同数なら type 名の昇順（並びは実装で固定してある）
		expect(rows.map((r) => r.type)).toEqual(['triple_top', 'double_bottom']);
		expect(rows.reduce((sum, r) => sum + r.count, 0)).toBe(10);
		for (const row of rows) expect(row.reasons.reduce((sum, [, n]) => sum + n, 0)).toBe(row.count);

		// 集計ブロックは列挙より前（長いリストを読み切る前に全体像が要る）
		expect(text.indexOf('▼ 候補の内訳')).toBeGreaterThan(text.indexOf('【Candidates】'));
		expect(text.indexOf('▼ 棄却理由の内訳')).toBeLessThan(text.indexOf('❌ = 候補段階の棄却'));
	});

	// 「棄却理由の内訳 183 件」とだけ書くと 289 件の内訳だと誤読されるので、cap 飽和時は集計が表示分のみであることを明記する（#191）。
	it('cap 飽和: 集計が「表示分のみ」であることを明記し、見出しの申告値と食い違わない', () => {
		const candidates = [
			...Array.from({ length: 17 }, () => ({ type: 'triple_top', accepted: true })),
			...rejects('rising_wedge', 'no_convergence', 100),
			...rejects('rising_wedge', 'r2_below_threshold', 43),
			...rejects('triple_bottom', 'peaks_missing', 40),
		];
		expect(candidates).toHaveLength(200);
		const meta = {
			debug: {
				swings: [],
				candidates,
				candidatesTotal: 289,
				candidatesOmitted: 89,
				swingsTotal: 0,
				swingsOmitted: 0,
			},
		};
		const text = formatDebugView('hdr', meta, [], makeDebugViewRes()).content[0].text;

		// 見出し（#180）と集計（#191）は同じ申告値から組む。数字が食い違って見えないこと
		expect(text).toContain(
			'【Candidates】 200 / 全 289 件（89 件省略。accepted は全件残っているため省略分はすべて棄却理由）',
		);
		expect(text).toContain(
			'▼ 候補の内訳: 表示 200 件 = accepted 17 件 + rejected 183 件（全 289 件のうち 89 件は cap で省略されており、**この集計に入っていない**）',
		);
		expect(text).toContain(
			'▼ 棄却理由の内訳（type 別 → reason 別。合計は上の rejected 183 件と一致する。**全 289 件の内訳ではない**）',
		);

		// 合計は 200 − accepted であって 289 ではない（#191 要件 3）
		const rows = parseRejectionRows(text);
		expect(rows.reduce((sum, r) => sum + r.count, 0)).toBe(183);
		expect(text).not.toContain('全 289 件 = accepted');
	});

	// 総数の申告が無いときに「全 N 件」と書くと censored な内訳の誤帰属を再導入するので、`formatTrimNote` が見出し行ごと落とすのと同じく省略の有無を断定しない。
	it('総数の申告が無い meta では「受け取った N 件」と書き、省略の有無を断定しない', () => {
		const text = formatDebugView('hdr', makeMeta(rejects('triple_top', 'peaks_not_equal', 3)), [], makeDebugViewRes())
			.content[0].text;
		expect(text).toContain(
			'▼ 候補の内訳: 受け取った 3 件 = accepted 0 件 + rejected 3 件（総数の申告が無いため cap 省略の有無は不明。この集計は受け取った分のみ）',
		);
		expect(text).not.toContain('全 3 件 =');
		expect(text).not.toContain('cap 省略なし');
	});

	it('rejected が 0 件のとき「なし（rejected 0 件）」と明示する（集計を出していないのと区別する）', () => {
		const meta = makeMeta([
			{ type: 'triple_top', accepted: true },
			{ type: 'triple_bottom', accepted: true },
		]);
		const text = formatDebugView('hdr', meta, [], makeDebugViewRes()).content[0].text;
		expect(text).toContain('▼ 候補の内訳: 受け取った 2 件 = accepted 2 件 + rejected 0 件');
		expect(text).toContain('▼ 棄却理由の内訳: なし（rejected 0 件）');
	});

	// `reason` だけに畳むと `triple_bottom:valleys_missing` と `double_bottom:valleys_missing` が同じ行に潰れて帰属が読めなくなる（#191 要件 4）。
	it('type が違えば同じ reason でも行を分ける', () => {
		const meta = makeMeta([
			...rejects('triple_bottom', 'valleys_missing', 4),
			...rejects('double_bottom', 'valleys_missing', 2),
		]);
		const text = formatDebugView('hdr', meta, [], makeDebugViewRes()).content[0].text;
		expect(text).toContain('   - triple_bottom 4 件: valleys_missing 4');
		expect(text).toContain('   - double_bottom 2 件: valleys_missing 2');
	});

	it('type 行が上限（20）を超えたら残余行に畳み、合計は rejected と一致し続ける', () => {
		// 25 種別 × それぞれ件数を変える（件数降順で 20 種が残り、5 種が畳まれる）
		const candidates = Array.from({ length: 25 }, (_, i) =>
			rejects(`type_${String(i).padStart(2, '0')}`, 'r', 25 - i),
		).flat();
		const total = candidates.length;
		const text = formatDebugView('hdr', makeMeta(candidates), [], makeDebugViewRes()).content[0].text;

		const rows = parseRejectionRows(text);
		expect(rows).toHaveLength(20);
		const rest = parseRestRow(text);
		expect(rest?.types).toBe(5);
		// 畳んだ分を落とすと合計が合わなくなる（まさに本 issue が消したい失敗）
		expect(rows.reduce((sum, r) => sum + r.count, 0) + (rest?.count ?? 0)).toBe(total);
	});

	it('reason が上限（10）を超えたら行内で畳み、合計は type の件数と一致し続ける', () => {
		const candidates = Array.from({ length: 13 }, (_, i) =>
			rejects('triple_top', `reason_${String(i).padStart(2, '0')}`, 13 - i),
		).flat();
		const text = formatDebugView('hdr', makeMeta(candidates), [], makeDebugViewRes()).content[0].text;
		const [row] = parseRejectionRows(text);
		expect(row.reasons).toHaveLength(11); // 10 種 + 残余 1
		expect(row.reasons.at(-1)?.[0]).toBe('他 3 種');
		expect(row.reasons.reduce((sum, [, n]) => sum + n, 0)).toBe(row.count);
	});

	it('reason を持たない棄却も (reason なし) として数に入れる', () => {
		const meta = makeMeta([...rejects('triple_top', undefined, 2), ...rejects('triple_top', 'peaks_not_equal', 1)]);
		const text = formatDebugView('hdr', meta, [], makeDebugViewRes()).content[0].text;
		expect(text).toContain('   - triple_top 3 件: (reason なし) 2 / peaks_not_equal 1');
	});

	it('候補 0 件のときは集計ブロックごと出さない（列挙側の「なし（…）」と二重に言わない）', () => {
		const meta = { debug: { swings: [], candidates: [], candidatesTotal: 0, candidatesOmitted: 0 } };
		const text = formatDebugView('hdr', meta, [], makeDebugViewRes()).content[0].text;
		expect(text).not.toContain('▼ 候補の内訳');
		expect(text).not.toContain('▼ 棄却理由の内訳');
		expect(text).not.toContain(REJECTION_CROSS_TOTAL_LABEL);
		expect(text).toContain('なし（この窓では要求種別の候補が 1 つも組まれていない');
	});
});

// LLM が横断集計を外す条件は「reason が type を跨ぐこと」なので、跨ぎが起きうるときだけ横断合計を出す（#193 B-1）。
describe('formatDebugView: reason 単独の横断合計（#193 B-1）', () => {
	/** cap を埋める 200 件で、両ウェッジに 3 reason が跨る候補列。 */
	const liveLikeCandidates = [
		...Array.from({ length: 38 }, () => ({ type: 'rising_wedge', accepted: true })),
		...rejects('falling_wedge', 'slopes_not_same_direction', 58),
		...rejects('rising_wedge', 'slopes_not_same_direction', 8),
		...rejects('rising_wedge', 'weaker_slope_ratio_low', 28),
		...rejects('falling_wedge', 'weaker_slope_ratio_low', 19),
		...rejects('falling_wedge', 'no_convergence', 25),
		...rejects('rising_wedge', 'no_convergence', 16),
		...rejects('triple_top', 'valleys_missing', 8),
	];

	it('type を跨ぐ reason を合算し、合計が rejected と一致する', () => {
		const meta = makeMeta(liveLikeCandidates);
		const text = formatDebugView('hdr', meta, [], makeDebugViewRes()).content[0].text;

		// type 別行は残したまま（B-1 は「足す」であって「置き換える」ではない）
		expect(text).toContain(
			'   - falling_wedge 102 件: slopes_not_same_direction 58 / no_convergence 25 / weaker_slope_ratio_low 19',
		);
		expect(text).toContain(
			'   - rising_wedge 52 件: weaker_slope_ratio_low 28 / no_convergence 16 / slopes_not_same_direction 8',
		);

		const cross = parseCrossTotalRow(text);
		// 件数降順。58 でも 28 でもなく 66 / 47
		expect(cross).toEqual([
			['slopes_not_same_direction', 66],
			['weaker_slope_ratio_low', 47],
			['no_convergence', 41],
			['valleys_missing', 8],
		]);
		// 不変条件: 横断合計の合計 = rejected 件数（type 別行と同じ分母）
		expect(cross?.reduce((sum, [, n]) => sum + n, 0)).toBe(162);
		expect(text).toContain('rejected 162 件');

		// 帰属は type 別行で見る、を content 側に書く（同じ reason が rising / falling で意味が違うため）
		expect(text).toContain('同じ reason でも type ごとに意味が違いうるので帰属は上の type 別行で見る');
		// 位置は type 別行の後（「上の type 別行」が指す先が実際に上にある）
		expect(text.indexOf(REJECTION_CROSS_TOTAL_LABEL)).toBeGreaterThan(text.indexOf('▼ 棄却理由の内訳'));
		expect(text.indexOf(REJECTION_CROSS_TOTAL_LABEL)).toBeLessThan(text.indexOf('❌ = 候補段階の棄却'));
	});

	// 横断合計行だけを読んだ人に「母集団の内訳」と誤読させないよう、type 別行と同じ censored 警告を横断合計行にも付ける。
	it('cap 飽和: 横断合計行にも「**全 N 件の内訳ではない**」が付く', () => {
		const meta = {
			debug: {
				swings: [],
				candidates: liveLikeCandidates,
				candidatesTotal: 2058,
				candidatesOmitted: 2058 - liveLikeCandidates.length,
			},
		};
		const text = formatDebugView('hdr', meta, [], makeDebugViewRes()).content[0].text;

		expect(text).toContain(
			`${REJECTION_CROSS_TOTAL_LABEL}（type を跨いで reason だけで合算。同じ reason でも type ごとに意味が違いうるので帰属は上の type 別行で見る。合計は上の rejected 162 件と一致する。**全 2058 件の内訳ではない**）`,
		);
		// 合計は表示分（162）であって母集団（2,058）ではない
		expect(parseCrossTotalRow(text)?.reduce((sum, [, n]) => sum + n, 0)).toBe(162);
	});

	// 跨ぎが起こりえない実行（type 1 種別）では、type 行がそのまま横断合計になり、出しても同じ数字を 2 度書くだけなので出さない（#193 要件 4）。
	it('type が 1 種別のときは出さない（type 行がそのまま横断合計）', () => {
		const meta = makeMeta([
			...rejects('triple_top', 'three_peaks_not_level', 21),
			...rejects('triple_top', 'valleys_missing', 12),
		]);
		const text = formatDebugView('hdr', meta, [], makeDebugViewRes()).content[0].text;
		expect(text).toContain('   - triple_top 33 件: three_peaks_not_level 21 / valleys_missing 12');
		expect(text).not.toContain(REJECTION_CROSS_TOTAL_LABEL);
	});

	it('rejected が 0 件のときは出さない（「なし（rejected 0 件）」だけ出す）', () => {
		const meta = makeMeta([
			{ type: 'triple_top', accepted: true },
			{ type: 'double_bottom', accepted: true },
		]);
		const text = formatDebugView('hdr', meta, [], makeDebugViewRes()).content[0].text;
		expect(text).toContain('▼ 棄却理由の内訳: なし（rejected 0 件）');
		expect(text).not.toContain(REJECTION_CROSS_TOTAL_LABEL);
	});

	it('reason が上限（10）を超えたら `他 N 種 M` に畳み、合計は rejected と一致し続ける', () => {
		// 13 種の reason を 2 type に散らす（どの reason も両 type に跨る = 横断合計が意味を持つ形）
		const candidates = Array.from({ length: 13 }, (_, i) => [
			...rejects('rising_wedge', `reason_${String(i).padStart(2, '0')}`, 13 - i),
			...rejects('falling_wedge', `reason_${String(i).padStart(2, '0')}`, 1),
		]).flat();
		const text = formatDebugView('hdr', makeMeta(candidates), [], makeDebugViewRes()).content[0].text;

		const cross = parseCrossTotalRow(text);
		expect(cross).toHaveLength(11); // 10 種 + 残余 1
		expect(cross?.at(-1)?.[0]).toBe('他 3 種');
		// 畳んだ分を落とすと合計が rejected と合わなくなる（#193 要件 3）
		expect(cross?.reduce((sum, [, n]) => sum + n, 0)).toBe(candidates.length);
	});

	// 横断合計は `byType` ではなく全 rejected から独立に数える（type 行の残余から reason を拾い直す実装にすると、ここが黙って合わなくなる）。
	it('type 行が残余に畳まれても横断合計は rejected と一致する', () => {
		// 25 種別 × 共通の reason 'r'（type 行は 20 + 残余 1 に畳まれる）
		const candidates = Array.from({ length: 25 }, (_, i) =>
			rejects(`type_${String(i).padStart(2, '0')}`, 'r', 25 - i),
		).flat();
		const text = formatDebugView('hdr', makeMeta(candidates), [], makeDebugViewRes()).content[0].text;

		expect(parseRestRow(text)?.types).toBe(5); // type 行は畳まれている
		expect(parseCrossTotalRow(text)).toEqual([['r', candidates.length]]);
	});

	it('reason を持たない棄却も (reason なし) として横断合計に入れる', () => {
		const meta = makeMeta([...rejects('triple_top', undefined, 2), ...rejects('double_bottom', 'no_breakout', 1)]);
		const text = formatDebugView('hdr', meta, [], makeDebugViewRes()).content[0].text;
		expect(parseCrossTotalRow(text)).toEqual([
			['(reason なし)', 2],
			['no_breakout', 1],
		]);
	});
});

describe('buildDetectionRouteLine', () => {
	it('relaxed が 0 件でも行を出す（「行が無い = relaxed なし」を推論させない）', () => {
		const pats = [makePattern(), makePattern(), makePattern()];
		expect(buildDetectionRouteLine(pats)).toBe('検出経路: 全 3 件とも strict（relaxed フォールバック由来は 0 件）');
	});

	it('relaxed 由来があるとき strict / relaxed の件数と段の内訳を出す', () => {
		const pats = [
			makePattern(),
			makePattern({ type: 'triple_top', _fallback: 'relaxed_triple_x1.25' }),
			makePattern({ type: 'triple_bottom', _fallback: 'relaxed_triple_x1.25' }),
			makePattern({ type: 'head_and_shoulders', _fallback: 'relaxed_hs_x1.6_0.6' }),
		];
		const line = buildDetectionRouteLine(pats);
		// 件数は 3 つとも書く（strict / relaxed / 段ごと）。読み手に引き算をさせない
		expect(line).toContain('検出経路: strict 1 件 / relaxed フォールバック由来 3 件');
		// 件数降順 → 値の昇順で固定（表記揺れはそのまま出す。揃えるのは別件。#190）
		expect(line).toContain('（relaxed_triple_x1.25×2, relaxed_hs_x1.6_0.6×1）');
		expect(line).toContain('summary はパターン行を出さないので件数のみ');
	});

	it('パターン 0 件では行を出さない（帰属の対象が無く、ヘッダが 0 件と言う）', () => {
		expect(buildDetectionRouteLine([])).toBe('');
	});

	it('_fallback が空文字 / 非文字列のエントリは relaxed に数えない', () => {
		const pats = [makePattern({ _fallback: '  ' }), makePattern({ _fallback: undefined })];
		expect(buildDetectionRouteLine(pats)).toBe('検出経路: 全 2 件とも strict（relaxed フォールバック由来は 0 件）');
	});
});

describe('検出経路行と provenance の view 別の出方（#191 B / 規約 §3）', () => {
	const relaxedPats = [
		makePattern({ type: 'triple_top', _fallback: 'relaxed_triple_x1.25' }),
		makePattern({ type: 'double_top' }),
	];

	it('summary / detailed / full に同一文言の検出経路行が出る（summary に出さないと §3 違反）', () => {
		const line = buildDetectionRouteLine(relaxedPats);
		const summary = formatSummaryView('hdr', relaxedPats, '', '', undefined, false, emptyRes).content[0].text;
		const detailed = formatDetailedView('hdr', relaxedPats, '', '', emptyMeta, undefined, emptyRes).content[0].text;
		const full = formatFullView('hdr', relaxedPats, '', '', emptyMeta, emptyRes).content[0].text;
		for (const [view, text] of [
			['summary', summary],
			['detailed', detailed],
			['full', full],
		] as const) {
			expect(text, `view=${view} に検出経路行が無い`).toContain(line);
		}
	});

	it('detailed / full ではパターン見出し行の末尾に provenance が付き、summary には行そのものが無い', () => {
		const detailed = formatDetailedView('hdr', relaxedPats, '', '', emptyMeta, undefined, emptyRes).content[0].text;
		const full = formatFullView('hdr', relaxedPats, '', '', emptyMeta, emptyRes).content[0].text;
		for (const text of [detailed, full]) {
			expect(text).toContain('1. triple_top (パターン整合度: 0.75) [relaxed_triple_x1.25]');
			// strict 由来には印を付けない（印の無さは検出経路行の件数が裏づける）
			expect(text).toContain('2. double_top (パターン整合度: 0.75)\n');
		}
		// summary はパターン行を出さない view なので、印は付きようがなく、届くのは件数の集計だけ（§3 は下位 view に無いものを上位が足すのを許す。逆は不可）。
		const summary = formatSummaryView('hdr', relaxedPats, '', '', undefined, false, emptyRes).content[0].text;
		expect(summary).not.toContain('[relaxed_triple_x1.25]');
		expect(summary).not.toContain('パターン整合度');
		expect(summary).toContain('検出経路: strict 1 件 / relaxed フォールバック由来 1 件（relaxed_triple_x1.25×1）');
	});

	it('debug には検出経路行を出さない（パターンを列挙しない view なので帰属の対象が出ない）', () => {
		const text = formatDebugView('hdr', emptyMeta, relaxedPats, makeDebugViewRes()).content[0].text;
		expect(text).not.toContain('検出経路');
	});
});

describe('formatPatternLine', () => {
	it('double_top: full view で山1/谷/山2 ラベルを出力する', () => {
		const meta = {
			debug: {
				swings: [
					{ kind: 'peak', idx: 0, price: 100000, isoTime: '2026-01-01T00:00:00.000Z' },
					{ kind: 'valley', idx: 5, price: 90000, isoTime: '2026-01-06T00:00:00.000Z' },
					{ kind: 'peak', idx: 10, price: 100000, isoTime: '2026-01-11T00:00:00.000Z' },
				],
			},
		};
		const p = makePattern({ type: 'double_top' });
		const result = formatPatternLine(p, 0, 'full', meta);
		expect(result).toContain('山1');
		expect(result).toContain('谷');
		expect(result).toContain('山2');
	});

	it('double_bottom: full view で谷1/山/谷2 ラベルを出力する', () => {
		const meta = {
			debug: {
				swings: [
					{ kind: 'valley', idx: 0, price: 90000, isoTime: '2026-01-01T00:00:00.000Z' },
					{ kind: 'peak', idx: 5, price: 100000, isoTime: '2026-01-06T00:00:00.000Z' },
					{ kind: 'valley', idx: 10, price: 90000, isoTime: '2026-01-11T00:00:00.000Z' },
				],
			},
		};
		const p = makePattern({ type: 'double_bottom' });
		const result = formatPatternLine(p, 0, 'full', meta);
		expect(result).toContain('谷1');
		expect(result).toContain('山');
		expect(result).toContain('谷2');
	});

	it('debug view でも pivot ラベルを出力する', () => {
		const p = makePattern({ type: 'double_top' });
		const result = formatPatternLine(p, 0, 'debug', emptyMeta);
		expect(result).toContain('山1');
	});

	it('summary view では pivot ラベルを出力しない', () => {
		const p = makePattern({ type: 'double_top' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).not.toContain('山1');
	});

	it('pivots が 3 未満のとき pivot ラベルなし', () => {
		const p = makePattern({
			type: 'double_top',
			pivots: [
				{ idx: 0, price: 100000, kind: 'H', extremePrice: 101000 },
				{ idx: 5, price: 90000, kind: 'L', extremePrice: 89000 },
			],
		});
		const result = formatPatternLine(p, 0, 'full', emptyMeta);
		expect(result).not.toContain('山1');
	});

	it('other type では roleLabels なし（full view）', () => {
		const p = makePattern({ type: 'bull_pennant' });
		const result = formatPatternLine(p, 0, 'full', emptyMeta);
		expect(result).not.toContain('山1');
	});

	it('breakout: idx が存在するとき "ブレイク" 行を出力する（idxToIso あり）', () => {
		const meta = {
			debug: {
				swings: [{ kind: 'peak', idx: 10, price: 95000, isoTime: '2026-01-11T00:00:00.000Z' }],
			},
		};
		const p = makePattern({ breakout: { idx: 10, price: 95000 } });
		const result = formatPatternLine(p, 0, 'full', meta);
		expect(result).toContain('ブレイク');
		expect(result).toContain('2026-01-11');
	});

	it('breakout: idxToIso が存在しないとき "n/a" を表示する', () => {
		const p = makePattern({ breakout: { idx: 99, price: 95000 } });
		const result = formatPatternLine(p, 0, 'full', emptyMeta);
		expect(result).toContain('ブレイク');
		expect(result).toContain('n/a');
	});

	it('breakout が null のとき breakout 行なし', () => {
		const p = makePattern({ breakout: null });
		const result = formatPatternLine(p, 0, 'full', emptyMeta);
		expect(result).not.toContain('ブレイク:');
	});

	it('status: completed を日本語で表示する', () => {
		const p = makePattern({ status: 'completed' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('完成（ブレイクアウト確認済み）');
	});

	// 「期待と逆方向にブレイク」に対応する理由コードは検出器に存在しないので、`invalidReason` が無いときは裸の「無効」だけにする（issue #286）。
	it('status: invalid は invalidReason が無ければ裸のラベルだけ', () => {
		const p = makePattern({ status: 'invalid' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		// 行末で固定する（`toContain('無効')` では括弧付きの文言が付いても通ってしまう）。
		expect(result).toMatch(/^ {3}- 状態: 無効$/mu);
		expect(result).not.toContain('逆方向');
	});

	it('status: forming を日本語で表示する', () => {
		const p = makePattern({ status: 'forming' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('形成中');
	});

	// `makePattern` の既定 type は `double_top`（反転系）なので「apex接近」ではない（issue #286）。
	it('status: near_completion は反転系では「構造成立・ネックライン未突破」', () => {
		const p = makePattern({ status: 'near_completion' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('ほぼ完成（構造成立・ネックライン未突破）');
		expect(result).not.toContain('apex');
	});

	it('status が未知の値のときそのまま表示する', () => {
		const p = makePattern({ status: 'custom_status' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('custom_status');
	});

	it('status が未指定のとき状態行なし', () => {
		const p = makePattern({ status: undefined });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).not.toContain('状態:');
	});

	it('falling_wedge: up breakout → 強気転換（成功）', () => {
		const p = makePattern({ type: 'falling_wedge', breakoutDirection: 'up', outcome: 'success' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('強気転換');
		expect(result).toContain('成功');
	});

	it('falling_wedge: down breakout → 上方転換シナリオ無効化（失敗）', () => {
		const p = makePattern({ type: 'falling_wedge', breakoutDirection: 'down', outcome: 'failure' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('上方転換シナリオ無効化');
		expect(result).toContain('失敗');
	});

	it('rising_wedge: up breakout → 下方転換シナリオ無効化（失敗）', () => {
		const p = makePattern({ type: 'rising_wedge', breakoutDirection: 'up', outcome: 'failure' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('下方転換シナリオ無効化');
	});

	it('rising_wedge: down breakout → 弱気転換（成功）', () => {
		const p = makePattern({ type: 'rising_wedge', breakoutDirection: 'down', outcome: 'success' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('弱気転換');
	});

	it('triangle_ascending: up breakout → 上方ブレイク（強気）', () => {
		const p = makePattern({ type: 'triangle_ascending', breakoutDirection: 'up', outcome: 'success' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('上方ブレイク（強気）');
	});

	it('triangle_ascending: down breakout → 下方ブレイク（弱気転換）', () => {
		const p = makePattern({ type: 'triangle_ascending', breakoutDirection: 'down', outcome: 'failure' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('下方ブレイク（弱気転換）');
	});

	it('triangle_descending: down success → 下方ブレイク（弱気）', () => {
		const p = makePattern({ type: 'triangle_descending', breakoutDirection: 'down', outcome: 'success' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('下方ブレイク（弱気）');
	});

	it('triangle_descending: up failure → 上方ブレイク（強気転換）', () => {
		const p = makePattern({ type: 'triangle_descending', breakoutDirection: 'up', outcome: 'failure' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('上方ブレイク（強気転換）');
	});

	it('bull_pennant: up success → トレンド継続（強気）', () => {
		const p = makePattern({ type: 'bull_pennant', breakoutDirection: 'up', outcome: 'success' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('トレンド継続（強気）');
	});

	it('bear_pennant: up failure → ダマシ（強気転換）', () => {
		const p = makePattern({ type: 'bear_pennant', breakoutDirection: 'up', outcome: 'failure' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('ダマシ（強気転換）');
	});

	it('意味の表に無い type → 方向ブレイク', () => {
		const p = makePattern({ type: 'double_top', breakoutDirection: 'up', outcome: 'success' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('パターン結果: 成功（上方ブレイク）');
	});

	it('breakoutDirection なしのとき outcome 行なし', () => {
		const p = makePattern({ breakoutDirection: undefined, outcome: undefined });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).not.toContain('パターン結果:');
	});

	it('bull_pennant: 全フィールドあり（poleDirection/priorTrendDirection/flagpoleHeight/retracementRatio/isTrendContinuation）', () => {
		const p = makePattern({
			type: 'bull_pennant',
			poleDirection: 'up',
			priorTrendDirection: 'bullish',
			flagpoleHeight: 20000,
			retracementRatio: 0.2,
			isTrendContinuation: true,
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('フラッグポール方向: 上昇');
		expect(result).toContain('先行トレンド: 強気（上昇トレンド）');
		expect(result).toContain('フラッグポール値幅');
		expect(result).toContain('戻し比率: 20%');
		expect(result).toContain('正常範囲');
		expect(result).toContain('トレンド継続: はい（成功）');
	});

	it('bear_pennant: priorTrendDirection=bearish → 弱気（下降トレンド）', () => {
		const p = makePattern({ type: 'bear_pennant', priorTrendDirection: 'bearish' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('弱気（下降トレンド）');
	});

	it('bull_pennant: retracementRatio > 0.38 → 高め（トライアングル寄り）', () => {
		const p = makePattern({ type: 'bull_pennant', retracementRatio: 0.5 });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('高め — トライアングル寄り');
	});

	it('bull_pennant: isTrendContinuation=false → いいえ（ダマシ）', () => {
		const p = makePattern({ type: 'bull_pennant', isTrendContinuation: false });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('いいえ（ダマシ）');
	});

	it('bear_pennant: poleDirection=down → 下降', () => {
		const p = makePattern({ type: 'bear_pennant', poleDirection: 'down' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('フラッグポール方向: 下降');
	});

	it('bull_pennant: フィールドなしのとき pennantLine なし', () => {
		const p = makePattern({ type: 'bull_pennant' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		// pennant line 自体が生成されないことを確認（crashしなければOK）
		expect(result).toContain('bull_pennant');
	});

	it('bull_flag: 旗竿・チャネルの詳細行（期間・ATR 倍率・傾き・幅・期待ブレイク方向）', () => {
		const p = makePattern({
			type: 'bull_flag',
			poleStartDate: '2026-01-01T00:00:00.000Z',
			poleEndDate: '2026-01-05T00:00:00.000Z',
			poleChangePct: 0.1234,
			poleBars: 4,
			poleATRMult: 3.456,
			flagUpperSlope: -12.345,
			flagLowerSlope: -10.5,
			spreadAvg: 123456.7,
			spreadStability: 0.876,
			expectedBreakoutDirection: 'up',
		});
		const lines = formatPatternLine(p, 0, 'summary', emptyMeta).split('\n');
		expect(lines).toContain('   - 旗竿期間: 2026-01-01 ~ 2026-01-05（+12.3%, 4本）');
		expect(lines).toContain('   - 旗竿 ATR 倍率: 3.46x');
		expect(lines).toContain('   - チャネル傾き: 上限=-12.35, 下限=-10.50（円/本）');
		expect(lines).toContain('   - 平均チャネル幅: 123,457円（平行度: 88%）');
		expect(lines).toContain('   - 期待ブレイク方向: 上方');
	});

	it('bear_flag: 下落の旗竿は符号なし・本数なしで、欠けた値の行は出さない', () => {
		const p = makePattern({
			type: 'bear_flag',
			poleStartDate: '2026-01-01T00:00:00.000Z',
			poleEndDate: '2026-01-05T00:00:00.000Z',
			poleChangePct: -0.05,
			expectedBreakoutDirection: 'down',
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result.split('\n')).toContain('   - 旗竿期間: 2026-01-01 ~ 2026-01-05（-5.0%）');
		expect(result.split('\n')).toContain('   - 期待ブレイク方向: 下方');
		for (const label of ['旗竿 ATR 倍率', 'チャネル傾き', '平均チャネル幅']) expect(result).not.toContain(label);
	});

	it('full view + structureDiagram.svg あり → SVG ブロックを出力する', () => {
		const p = makePattern({
			structureDiagram: {
				svg: '<svg>test</svg>',
				artifact: { identifier: 'diag-1', title: 'Test Diagram' },
			},
		});
		const result = formatPatternLine(p, 0, 'full', emptyMeta);
		expect(result).toContain('Structure Diagram (SVG)');
		expect(result).toContain('<svg>test</svg>');
		expect(result).toContain('diag-1');
	});

	it('detailed view + structureDiagram.svg あり → SVG ブロックを出力する', () => {
		const p = makePattern({
			structureDiagram: { svg: '<svg>detail</svg>' },
		});
		const result = formatPatternLine(p, 0, 'detailed', emptyMeta);
		expect(result).toContain('Structure Diagram (SVG)');
	});

	it('debug view では structureDiagram を出力しない', () => {
		const p = makePattern({
			structureDiagram: { svg: '<svg>debug</svg>' },
		});
		const result = formatPatternLine(p, 0, 'debug', emptyMeta);
		expect(result).not.toContain('Structure Diagram (SVG)');
	});

	it('structureDiagram.svg なしのとき SVG ブロックなし', () => {
		const p = makePattern({
			structureDiagram: undefined,
		});
		const result = formatPatternLine(p, 0, 'full', emptyMeta);
		expect(result).not.toContain('Structure Diagram (SVG)');
	});

	it('breakoutTarget あり → ターゲット価格を出力する', () => {
		const p = makePattern({
			breakoutTarget: 120000,
			targetMethod: 'flagpole_projection',
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('ターゲット価格');
		expect(result).toContain('フラッグポール値幅投影');
	});

	it('targetMethod: pattern_height → パターン高さ投影', () => {
		const p = makePattern({ breakoutTarget: 110000, targetMethod: 'pattern_height' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('パターン高さ投影');
	});

	it('targetMethod: neckline_projection → ネックライン投影', () => {
		const p = makePattern({ breakoutTarget: 110000, targetMethod: 'neckline_projection' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('ネックライン投影');
	});

	it('到達: 初到達の本数と日時を出す（走査窓の判定口調にしない）', () => {
		const p = makePattern({
			breakoutTarget: 110000,
			targetMethod: 'pattern_height',
			targetReachedPct: 105,
			targetReached: true,
			targetFirstReachBars: 12,
			targetFirstReachDate: '2026-08-25T02:00:00.000Z',
			targetScanBars: TARGET_REACH_MAX_BARS,
			targetScanComplete: true,
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta, 'Asia/Tokyo', '1hour');
		// intraday なので分まで出る（同ファイルの他の日時行と同じ整形）。
		expect(result).toContain('   - ターゲット: 到達（ブレイク後 12 本目、2026-08-25 11:00）');
	});

	it('未到達（走査完了）: 走査本数の完了と接近度を出す', () => {
		const p = makePattern({
			breakoutTarget: 110000,
			targetMethod: 'pattern_height',
			targetReachedPct: 60,
			targetReached: false,
			targetScanBars: TARGET_REACH_MAX_BARS,
			targetScanComplete: true,
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain(`   - ターゲット: 未到達（走査 ${TARGET_REACH_MAX_BARS} 本完了、目標幅の 60% まで接近）`);
	});

	it('未到達（走査中）: 経過本数と走査上限を並べる', () => {
		const p = makePattern({
			breakoutTarget: 110000,
			targetMethod: 'pattern_height',
			targetReachedPct: 22,
			targetReached: false,
			targetScanBars: 13,
			targetScanComplete: false,
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain(
			`   - ターゲット: 未到達（ブレイク後 13 本経過 / 走査上限 ${TARGET_REACH_MAX_BARS} 本、目標幅の 22% まで接近）`,
		);
	});

	it('targetReachedPct が 273 の到達 entry でも content に「273」が出ない', () => {
		const p = makePattern({
			breakoutTarget: 110000,
			targetMethod: 'pattern_height',
			targetReachedPct: 273,
			targetReached: true,
			targetFirstReachBars: 14,
			targetFirstReachDate: '2026-09-08T06:00:00.000Z',
			targetScanBars: TARGET_REACH_MAX_BARS,
			targetScanComplete: true,
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta, 'Asia/Tokyo', '1hour');
		expect(result).toContain('   - ターゲット: 到達（');
		expect(result).not.toContain('273');
		expect(result).not.toContain('進捗');
	});

	it('上限に当たった pct も数字を出さない（旧実装の「999%以上」は消えた）', () => {
		const p = makePattern({
			breakoutTarget: 110000,
			targetMethod: 'pattern_height',
			targetReachedPct: TARGET_REACHED_PCT_CAP,
			targetReached: true,
			targetFirstReachBars: 3,
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).not.toContain(`${TARGET_REACHED_PCT_CAP}%以上`);
		expect(result).toContain('   - ターゲット: 到達（ブレイク後 3 本目）');
	});

	it('交絡があれば末尾に申告する（到達側は方向を問わない）', () => {
		const p = makePattern({
			breakoutTarget: 110000,
			targetMethod: 'pattern_height',
			targetReachedPct: 130,
			targetReached: true,
			targetFirstReachBars: 47,
			targetOtherBreakoutBeforeReach: [{ type: 'triangle_ascending', direction: 'down', barsAfterBreakout: 25 }],
		});
		expect(formatPatternLine(p, 0, 'summary', emptyMeta)).toContain(
			'。到達前に別パターンのブレイクあり（triangle_ascending 下方 +25 本）',
		);
	});

	it('未到達の交絡は逆方向のブレイクとして申告する', () => {
		const p = makePattern({
			breakoutTarget: 110000,
			targetMethod: 'pattern_height',
			targetReachedPct: 26,
			targetReached: false,
			targetScanBars: TARGET_REACH_MAX_BARS,
			targetScanComplete: true,
			targetOppositeBreakoutInWindow: [{ type: 'triangle_descending', direction: 'down', barsAfterBreakout: 27 }],
		});
		expect(formatPatternLine(p, 0, 'summary', emptyMeta)).toContain(
			'。走査窓内に逆方向のブレイクあり（triangle_descending 下方 +27 本）',
		);
	});

	it('退化して進捗を出さなかった場合は content に理由が出る（issue #210 (2)）', () => {
		const p = makePattern({
			breakoutTarget: 110000,
			targetMethod: 'neckline_projection',
			targetProgressOmittedReason: 'degenerate_target_distance',
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('ターゲット価格');
		expect(result).toContain('ターゲット: 出力なし');
	});

	it('breakoutTarget なしのとき ターゲット価格 なし', () => {
		const p = makePattern({ breakoutTarget: undefined });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).not.toContain('ターゲット価格');
	});

	it('neckline が水平のとき（水平）を表示する', () => {
		const p = makePattern({ neckline: [{ y: 95000 }, { y: 95000 }] });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('水平');
	});

	it('neckline が傾斜のとき → を使用する', () => {
		const p = makePattern({ neckline: [{ y: 95000 }, { y: 97000 }] });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('→');
	});

	it('trendlineLabel を使用する', () => {
		const p = makePattern({ neckline: [{ y: 95000 }, { y: 95000 }], trendlineLabel: 'サポートライン' });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('サポートライン');
	});

	it('新フィールドが無いとき legacy「期間」行を表示する', () => {
		const p = makePattern({ structureRange: undefined, confirmation: undefined, precedingTrend: undefined });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('期間:');
		expect(result).not.toContain('文脈期間');
		expect(result).not.toContain('形成期間');
	});

	it('structureRange あり → 形成期間 行を出力する（日付のみ YYYY-MM-DD）', () => {
		const p = makePattern({
			structureRange: { start: '2025-09-01T00:00:00.000Z', end: '2025-09-26T00:00:00.000Z' },
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('形成期間: 2025-09-01 ~ 2025-09-26（構成点）');
	});

	it('confirmation=neckline_breakout → ブレイク確認 行に日付と価格を出力する', () => {
		const p = makePattern({
			structureRange: { start: '2025-09-01T00:00:00.000Z', end: '2025-09-26T00:00:00.000Z' },
			confirmation: {
				type: 'neckline_breakout',
				date: '2025-10-02T00:00:00.000Z',
				idx: 31,
				price: 12345,
			},
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('ブレイク確認: 2025-10-02');
		expect(result).toContain('12,345円');
		// 文脈期間: precedingTrend が無い場合は structureRange.start を起点に
		expect(result).toContain('文脈期間: 2025-09-01 ~ 2025-10-02');
	});

	it('confirmation=not_confirmed → ブレイク確認: なし を表示する', () => {
		const p = makePattern({
			type: 'head_and_shoulders',
			structureRange: { start: '2025-08-01T00:00:00.000Z', end: '2025-09-30T00:00:00.000Z' },
			confirmation: { type: 'not_confirmed' },
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('ブレイク確認: なし');
	});

	it('precedingTrend → 先行トレンド 行に方向・%変化・lookback を出力する', () => {
		const p = makePattern({
			precedingTrend: {
				start: '2025-08-22T00:00:00.000Z',
				end: '2025-09-01T00:00:00.000Z',
				direction: 'down',
				returnPct: -7.5,
				lookbackBars: 10,
			},
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('先行トレンド: 2025-08-22 ~ 2025-09-01');
		expect(result).toContain('下降');
		expect(result).toContain('-7.5%');
		expect(result).toContain('lookback=10本');
	});

	it('precedingTrend.direction=insufficient_data も表示できる', () => {
		const p = makePattern({
			precedingTrend: {
				start: '2025-01-01T00:00:00.000Z',
				end: '2025-01-05T00:00:00.000Z',
				direction: 'insufficient_data',
				returnPct: 0,
				lookbackBars: 10,
			},
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('データ不足');
	});

	it('新フィールド完備 → 期間: のみの単独行は出さない（誤読防止）', () => {
		const p = makePattern({
			structureRange: { start: '2025-09-01T00:00:00.000Z', end: '2025-09-26T00:00:00.000Z' },
			confirmation: {
				type: 'neckline_breakout',
				date: '2025-10-02T00:00:00.000Z',
				idx: 31,
				price: 12345,
			},
			precedingTrend: {
				start: '2025-08-22T00:00:00.000Z',
				end: '2025-09-01T00:00:00.000Z',
				direction: 'down',
				returnPct: -7,
				lookbackBars: 10,
			},
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('文脈期間');
		expect(result).toContain('形成期間');
		expect(result).toContain('ブレイク確認');
		expect(result).toContain('先行トレンド');
		// legacy 「- 期間:」行が単独で出ないこと
		expect(result).not.toMatch(/\n\s+- 期間: 2/);
	});

	it('scoreComponents を「整合度の内訳」行に軸の日本語名で出す（detailed / full）', () => {
		const p = makePattern({
			confidence: 0.62,
			scoreComponents: { levelMargin: 0.6154, retracement: 0.3077, breakoutQuality: 0.95 },
		});
		for (const view of ['detailed', 'full'] as const) {
			expect(formatPatternLine(p, 0, view, emptyMeta)).toContain(
				'   - 整合度の内訳: 水準の揃い 0.62 / 戻り率 0.31 / ブレイクの強さ 0.95',
			);
		}
	});

	it('0 の軸があると strict の基準に届かない軸として警告する', () => {
		const p = makePattern({
			type: 'falling_wedge',
			confidence: 0.3,
			scoreComponents: { convergence: 0, touches: 0.8, alternation: 0, containment: 0.4 },
		});
		expect(formatPatternLine(p, 0, 'detailed', emptyMeta)).toContain(
			'   - ⚠️ strict の基準に届かない軸: 収束、タッチの交互さ',
		);
	});

	it('整合度が低くても点数だけでは警告しない（何点以上という帯は置かない。#422）', () => {
		const p = makePattern({ confidence: 0.2, scoreComponents: { levelMargin: 0.1, retracement: 0.3 } });
		const result = formatPatternLine(p, 0, 'detailed', emptyMeta);
		expect(result).not.toContain('⚠️');
		expect(result).not.toMatch(/形状不十分|信頼度: 低|信頼度: 非常に低い/);
	});

	it('scoreComponents が無ければ内訳行を出さない', () => {
		expect(formatPatternLine(makePattern({ confidence: 0.75 }), 0, 'detailed', emptyMeta)).not.toContain(
			'整合度の内訳',
		);
	});

	it('表に無い軸は名前を当てず、キー名のまま出す', () => {
		const p = makePattern({ scoreComponents: { futureAxis: 0.5 } as PatternEntry['scoreComponents'] });
		expect(formatPatternLine(p, 0, 'detailed', emptyMeta)).toContain('整合度の内訳: futureAxis 0.50');
	});

	// forming triple は pivots に確定した主構成点が 2 点しか入らないので、LLM が「3 山構造」と誤読しないよう、現在価格を 3 点目に仮置きしている旨を明示する。
	// 判定は `status === 'forming'` で行い、`pivots.length` に依存しない（長さで判定すると、pivots の構成を変えた瞬間に注記が黙って消える）。

	it('forming triple_top: 検出器の実出力どおり 4 点（H-L-H-L）でも現在価格暫定マーカーを表示する', () => {
		const p = makePattern({
			type: 'triple_top',
			status: 'forming',
			pivots: [
				{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
				{ idx: 10, price: 80, kind: 'L', extremePrice: 80 },
				{ idx: 20, price: 101, kind: 'H', extremePrice: 101 },
				{ idx: 32, price: 81, kind: 'L', extremePrice: 81 },
			],
		});
		const result = formatPatternLine(p, 0, 'detailed', emptyMeta);
		expect(result).toContain('3 山目は現在価格を暫定');
		expect(result).toContain('参考材料');
	});

	it('forming triple_bottom: 4 点（L-H-L-H）でも現在価格暫定マーカーを表示する', () => {
		const p = makePattern({
			type: 'triple_bottom',
			status: 'forming',
			pivots: [
				{ idx: 0, price: 100, kind: 'L', extremePrice: 100 },
				{ idx: 10, price: 120, kind: 'H', extremePrice: 120 },
				{ idx: 20, price: 99, kind: 'L', extremePrice: 99 },
				{ idx: 32, price: 119, kind: 'H', extremePrice: 119 },
			],
		});
		const result = formatPatternLine(p, 0, 'detailed', emptyMeta);
		expect(result).toContain('3 谷目は現在価格を暫定');
	});

	it('forming triple_top: 旧形式の 2 点（主構成点のみ）でも暫定マーカーは出る（長さに依存しない）', () => {
		const p = makePattern({
			type: 'triple_top',
			status: 'forming',
			pivots: [
				{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
				{ idx: 20, price: 101, kind: 'H', extremePrice: 101 },
			],
		});
		const result = formatPatternLine(p, 0, 'detailed', emptyMeta);
		expect(result).toContain('3 山目は現在価格を暫定');
	});

	it('completed triple_top（5 点 H-L-H-L-H）には暫定マーカーを付けない', () => {
		const p = makePattern({
			type: 'triple_top',
			status: 'completed',
			pivots: [
				{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
				{ idx: 10, price: 80, kind: 'L', extremePrice: 80 },
				{ idx: 20, price: 100, kind: 'H', extremePrice: 100 },
				{ idx: 30, price: 80, kind: 'L', extremePrice: 80 },
				{ idx: 40, price: 100, kind: 'H', extremePrice: 100 },
			],
		});
		const result = formatPatternLine(p, 0, 'detailed', emptyMeta);
		expect(result).not.toContain('現在価格を暫定');
	});

	it('near_completion の triple_top（forming ではない）には暫定マーカーを付けない', () => {
		const p = makePattern({
			type: 'triple_top',
			status: 'near_completion',
			pivots: [
				{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
				{ idx: 10, price: 80, kind: 'L', extremePrice: 80 },
				{ idx: 20, price: 100, kind: 'H', extremePrice: 100 },
				{ idx: 30, price: 80, kind: 'L', extremePrice: 80 },
				{ idx: 40, price: 100, kind: 'H', extremePrice: 100 },
			],
		});
		const result = formatPatternLine(p, 0, 'detailed', emptyMeta);
		expect(result).not.toContain('現在価格を暫定');
	});

	it('価格範囲は pivots 全点の min/max（triple_top ならネックライン定義点の谷が下限に入る）', () => {
		// triple の pivots にはネックライン定義点が入るので、価格範囲は H&S / double と同じくネックライン定義点を含んだ幅になる。
		const p = makePattern({
			type: 'triple_top',
			status: 'completed',
			pivots: [
				{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
				{ idx: 10, price: 80, kind: 'L', extremePrice: 80 },
				{ idx: 20, price: 101, kind: 'H', extremePrice: 101 },
				{ idx: 30, price: 82, kind: 'L', extremePrice: 82 },
				{ idx: 40, price: 100, kind: 'H', extremePrice: 100 },
			],
		});
		const result = formatPatternLine(p, 0, 'detailed', emptyMeta);
		expect(result).toContain('価格範囲: 80円 - 101円');
	});

	// 検出器は `double_top` に `forming` を出さないので、double が実際に取る status（`near_completion`）で書く。
	it('near_completion の double_top には triple 用の暫定マーカーを付けない', () => {
		const p = makePattern({
			type: 'double_top',
			status: 'near_completion',
			pivots: [
				{ idx: 0, price: 100, kind: 'H', extremePrice: 100 },
				{ idx: 10, price: 100, kind: 'L', extremePrice: 100 },
				{ idx: 20, price: 100, kind: 'H', extremePrice: 100 },
			],
		});
		const result = formatPatternLine(p, 0, 'detailed', emptyMeta);
		expect(result).not.toContain('現在価格を暫定');
	});
});

describe('formatPatternLine: pivot 明細行の役割ラベル（issue #234）', () => {
	/** idx → isoTime。`buildIdxToIso` が読むのは `meta.debug.swings` だけなので、そこだけ埋める。 */
	function metaWithIdx(idxs: readonly number[]) {
		return {
			...emptyMeta,
			debug: {
				...emptyMeta.debug,
				// idx を 2026-09-01 からの日数として置き、時刻は 03:00Z（JST 12:00）にする（00:00Z 前後だと既定 tz（JST）で暦日が 1 日ずれ、期待値が読みにくくなる）。
				swings: idxs.map((idx) => ({
					kind: 'H',
					idx,
					price: 100,
					isoTime: new Date(Date.UTC(2026, 8, 1, 3) + idx * 86_400_000).toISOString(),
				})),
			},
		};
	}

	function pivotRoleOrder(text: string): string[] {
		const roles: string[] = [];
		for (const line of text.split('\n')) {
			const m = line.match(/^\s*-\s*(山\d?|谷\d?|左肩|頭|右肩(?:\(暫定\))?|谷（頭後）|山（頭後）):\s/u);
			if (m) roles.push(m[1]);
		}
		return roles;
	}

	function fivePivots(kinds: readonly ('H' | 'L')[]) {
		return kinds.map((kind, i) => ({
			idx: i * 10,
			price: 100 + i,
			kind,
			extremePrice: 100 + i,
		}));
	}

	const FIVE_IDXS = [0, 10, 20, 30, 40];

	it('triple_top（完成 5 点）は 山1 / 谷1 / 山2 / 谷2 / 山3 を順に出す', () => {
		const p = makePattern({ type: 'triple_top', status: 'completed', pivots: fivePivots(['H', 'L', 'H', 'L', 'H']) });
		const text = formatPatternLine(p, 0, 'full', metaWithIdx(FIVE_IDXS));
		expect(pivotRoleOrder(text)).toEqual(['山1', '谷1', '山2', '谷2', '山3']);
		// idx の日時と価格が両方出る（LLM が content だけで検算できることが本 issue の目的）
		expect(text).toContain('山1: 2026-09-01 高値 100円（判定は高値基準）');
		expect(text).toContain('山3: 2026-10-11 高値 104円（判定は高値基準）');
	});

	it('triple_top（形成中 4 点）は 5 点版の先頭 4 つと同じラベルで、山3 を出さない', () => {
		const p = makePattern({
			type: 'triple_top',
			status: 'forming',
			pivots: fivePivots(['H', 'L', 'H', 'L']).slice(0, 4),
		});
		const text = formatPatternLine(p, 0, 'full', metaWithIdx([0, 10, 20, 30]));
		expect(pivotRoleOrder(text)).toEqual(['山1', '谷1', '山2', '谷2']);
		expect(text).not.toContain('山3');
	});

	it('triple_bottom（完成 5 点 / 形成中 4 点）は 谷1 / 山1 / 谷2 / 山2 / 谷3 の並び', () => {
		const completed = makePattern({
			type: 'triple_bottom',
			status: 'completed',
			pivots: fivePivots(['L', 'H', 'L', 'H', 'L']),
		});
		expect(pivotRoleOrder(formatPatternLine(completed, 0, 'full', metaWithIdx(FIVE_IDXS)))).toEqual([
			'谷1',
			'山1',
			'谷2',
			'山2',
			'谷3',
		]);

		const forming = makePattern({
			type: 'triple_bottom',
			status: 'forming',
			pivots: fivePivots(['L', 'H', 'L', 'H']).slice(0, 4),
		});
		expect(pivotRoleOrder(formatPatternLine(forming, 0, 'full', metaWithIdx([0, 10, 20, 30])))).toEqual([
			'谷1',
			'山1',
			'谷2',
			'山2',
		]);
	});

	it('head_and_shoulders（完成 5 点）は 左肩 / 谷1 / 頭 / 谷2 / 右肩', () => {
		const p = makePattern({
			type: 'head_and_shoulders',
			status: 'completed',
			pivots: fivePivots(['H', 'L', 'H', 'L', 'H']),
		});
		const text = formatPatternLine(p, 0, 'full', metaWithIdx(FIVE_IDXS));
		expect(pivotRoleOrder(text)).toEqual(['左肩', '谷1', '頭', '谷2', '右肩']);
	});

	it('head_and_shoulders（形成中 4 点）は 2 番目を「頭」と出す（5 点版の「谷1」を流用しない）', () => {
		// 早期形成パス（tools/patterns/detect_hs.ts）の 4 点は `[左肩, 頭, 谷（頭後）, 右肩]` で kind は H, H, L, H。完成版 5 点の先頭 4 つ（左肩 / 谷1 / 頭 / 谷2）を流用すると頭が「谷1」になる。
		const p = makePattern({
			type: 'head_and_shoulders',
			status: 'forming',
			pivots: fivePivots(['H', 'H', 'L', 'H']).slice(0, 4),
		});
		const text = formatPatternLine(p, 0, 'full', metaWithIdx([0, 10, 20, 30]));
		expect(pivotRoleOrder(text)).toEqual(['左肩', '頭', '谷（頭後）', '右肩(暫定)']);
		expect(text).not.toContain('谷1');
	});

	it('inverse_head_and_shoulders（完成 5 点 / 形成中 4 点）も同じ非対称を持つ', () => {
		const completed = makePattern({
			type: 'inverse_head_and_shoulders',
			status: 'completed',
			pivots: fivePivots(['L', 'H', 'L', 'H', 'L']),
		});
		expect(pivotRoleOrder(formatPatternLine(completed, 0, 'full', metaWithIdx(FIVE_IDXS)))).toEqual([
			'左肩',
			'山1',
			'頭',
			'山2',
			'右肩',
		]);

		const forming = makePattern({
			type: 'inverse_head_and_shoulders',
			status: 'forming',
			pivots: fivePivots(['L', 'L', 'H', 'L']).slice(0, 4),
		});
		const formingText = formatPatternLine(forming, 0, 'full', metaWithIdx([0, 10, 20, 30]));
		expect(pivotRoleOrder(formingText)).toEqual(['左肩', '頭', '山（頭後）', '右肩(暫定)']);
		expect(formingText).not.toContain('山1');
	});

	it('debug でも triple / H&S の pivot 明細が出る（full と同じ条件。:1045 は変えていない）', () => {
		const p = makePattern({
			type: 'head_and_shoulders',
			status: 'completed',
			pivots: fivePivots(['H', 'L', 'H', 'L', 'H']),
		});
		expect(pivotRoleOrder(formatPatternLine(p, 0, 'debug', metaWithIdx(FIVE_IDXS)))).toEqual([
			'左肩',
			'谷1',
			'頭',
			'谷2',
			'右肩',
		]);
	});

	it('summary / detailed では triple / H&S の pivot 明細を出さない（既存の view 条件のまま）', () => {
		const p = makePattern({ type: 'triple_top', status: 'completed', pivots: fivePivots(['H', 'L', 'H', 'L', 'H']) });
		for (const view of ['summary', 'detailed'] as const) {
			expect(pivotRoleOrder(formatPatternLine(p, 0, view, metaWithIdx(FIVE_IDXS))), `view=${view}`).toEqual([]);
		}
	});

	it('double_top / double_bottom の表示は不変（先頭 3 点のまま。pivots が 5 点でも 3 行）', () => {
		const dt = makePattern({ type: 'double_top', status: 'completed', pivots: fivePivots(['H', 'L', 'H', 'L', 'H']) });
		expect(pivotRoleOrder(formatPatternLine(dt, 0, 'full', metaWithIdx(FIVE_IDXS)))).toEqual(['山1', '谷', '山2']);

		const db = makePattern({
			type: 'double_bottom',
			status: 'completed',
			pivots: fivePivots(['L', 'H', 'L', 'H', 'L']),
		});
		expect(pivotRoleOrder(formatPatternLine(db, 0, 'full', metaWithIdx(FIVE_IDXS)))).toEqual(['谷1', '山', '谷2']);
	});

	it('表に無い型（wedge 等）は pivot 明細を 1 行も出さない', () => {
		const p = makePattern({
			type: 'falling_wedge',
			status: 'completed',
			pivots: fivePivots(['H', 'L', 'H', 'L', 'H']),
		});
		expect(pivotRoleOrder(formatPatternLine(p, 0, 'full', metaWithIdx(FIVE_IDXS)))).toEqual([]);
	});

	it('idx→isoTime が引けない点も行は落とさず日付だけ n/a にする（後続のラベルがずれない）', () => {
		// `meta.debug.swings` に載っていない idx（日付が引けない点）があっても、行ごと落とすとラベルと点の対応が 1 つずれるので、日付だけ n/a にして行は出す。
		const p = makePattern({
			type: 'triple_top',
			status: 'completed',
			pivots: fivePivots(['H', 'L', 'H', 'L', 'H']),
		});
		const text = formatPatternLine(p, 0, 'full', metaWithIdx([0, 10, 20, 30]));
		expect(pivotRoleOrder(text)).toEqual(['山1', '谷1', '山2', '谷2', '山3']);
		expect(text).toContain('山3: n/a');
	});
});

describe('formatSummaryView', () => {
	it('summary テキストを生成する', () => {
		const pats = [makePattern()];
		const res = formatSummaryView('Header', pats, '期間: 2026-01-01', 'double_top×1', undefined, false, emptyRes);
		expect(res.content[0].text).toContain('Header');
		expect(res.content[0].text).toContain('double_top×1');
	});

	it('includeForming=false のとき hint を表示する', () => {
		const res = formatSummaryView('H', [], '', '', undefined, false, emptyRes);
		expect(res.content[0].text).toContain('includeForming=true');
	});

	it('includeForming=true のとき hint なし', () => {
		const res = formatSummaryView('H', [], '', '', undefined, true, emptyRes);
		expect(res.content[0].text).not.toContain('includeForming=true');
	});
});

describe('formatFullView', () => {
	it('overlays ありのとき overlay note を含む', () => {
		const res = formatFullView('Header', [makePattern()], '', 'double_top×1', emptyMeta, {
			...emptyRes,
			data: { patterns: [], overlays: { ranges: [] } },
		});
		expect(res.content[0].text).toContain('チャート連携');
	});

	it('overlays なしのとき overlay note なし', () => {
		const res = formatFullView('Header', [makePattern()], '', 'double_top×1', emptyMeta, emptyRes);
		expect(res.content[0].text).not.toContain('チャート連携');
	});

	it('複数パターンを出力する', () => {
		const pats = [makePattern(), makePattern({ type: 'bull_pennant' })];
		const res = formatFullView('H', pats, '期間', 'summary', emptyMeta, emptyRes);
		expect(res.content[0].text).toContain('double_top');
		expect(res.content[0].text).toContain('bull_pennant');
	});
});

describe('formatDetailedView', () => {
	it('パターンあり → body を出力する', () => {
		const pats = [makePattern()];
		const res = formatDetailedView('H', pats, '', 'double_top×1', emptyMeta, undefined, emptyRes);
		expect(res.content[0].text).toContain('double_top');
	});

	it('パターン 0 件 + summary="insufficient data" → insufficient data メッセージ', () => {
		const res = formatDetailedView('H', [], '', '', emptyMeta, undefined, {
			...emptyRes,
			summary: 'insufficient data',
		});
		expect(res.content[0].text).toContain('insufficient data');
		expect(res.content[0].text).not.toContain('緩めるなら');
	});

	it('パターン 0 件 → 実効値を基準にした緩和の助言を出す（生入力値は出さない）', () => {
		const res = formatDetailedView('H', [], '', '', emptyMeta, ['double_top'], emptyRes);
		const text = res.content[0].text;
		expect(text).toContain('パターンは検出されませんでした。');
		expect(text).toContain('double_top');
		// 実効値（emptyMeta は 0.04）を基準に「より大きい値」を助言する。
		expect(text).toContain('実効値 0.04 より大きい値');
		expect(text).not.toContain('0.03-0.06');
		// 0 件メッセージ自体は値のラベルを持たない（実効パラメータ行に一本化した）。
		expect(text).not.toContain('（tolerancePct=');
	});

	it('パターン 0 件 + effective_params が 0.05 → 助言の基準値も 0.05 になる', () => {
		const meta = {
			...emptyMeta,
			effective_params: { ...emptyMeta.effective_params, tolerancePct: { value: 0.05, source: 'auto' as const } },
		};
		const res = formatDetailedView('H', [], '', '', meta, undefined, emptyRes);
		expect(res.content[0].text).toContain('実効値 0.05 より大きい値');
		expect(res.content[0].text).not.toContain('実効値 0.04');
	});

	// `effective_params` を持たない meta では、実効値を知らないのだから数値を主張してはいけない（#184 欠陥 E）。
	it('パターン 0 件 + effective_params 無し → 数値を主張せず実効パラメータ行を参照させる', () => {
		const metaNoTol = { debug: { swings: [], candidates: [] } };
		const res = formatDetailedView('H', [], '', '', metaNoTol, undefined, emptyRes);
		const text = res.content[0].text;
		expect(text).toContain('パターンは検出されませんでした。');
		expect(text).toContain('実効値は上の実効パラメータ行を参照');
		expect(text).not.toMatch(/実効値 [\d.]/u);
		expect(text).not.toContain('tolerancePct=');
	});

	it('overlays ありのとき overlay note を含む', () => {
		const res = formatDetailedView('H', [makePattern()], '', '', emptyMeta, undefined, {
			...emptyRes,
			data: { patterns: [], overlays: { ranges: [] } },
		});
		expect(res.content[0].text).toContain('チャート連携');
	});

	it('overlays なしのとき overlay note なし', () => {
		const res = formatDetailedView('H', [makePattern()], '', '', emptyMeta, undefined, emptyRes);
		expect(res.content[0].text).not.toContain('チャート連携');
	});

	it('5 件超のパターンは top5 のみ出力する', () => {
		const pats = Array.from({ length: 7 }, (_, i) => makePattern({ confidence: 0.7 + i * 0.01 }));
		const res = formatDetailedView('H', pats, '', '', emptyMeta, undefined, emptyRes);
		// 6番目、7番目は含まれない（全てconfidence違いだが型は同じなので出現数で確認）
		const matches = res.content[0].text.match(/double_top/g) ?? [];
		expect(matches.length).toBeLessThanOrEqual(5);
	});

	// 見出しは 6 件以上で「N / 全 M 件（K 件省略。全件は view=full）」、ちょうど 5 件で境界の曖昧さを消すために「省略なし」を出し、5 件未満は申告行自体を出さない（issue #196）。

	it('6 件以上検出時は【検出パターン】見出しにトリム件数を申告する（issue #196）', () => {
		const pats = Array.from({ length: 7 }, () => makePattern());
		const res = formatDetailedView('H', pats, '', '', emptyMeta, undefined, emptyRes);
		expect(res.content[0].text).toContain('【検出パターン】 5 / 全 7 件（2 件省略。全件は view=full）');
	});

	it('ちょうど 5 件検出時は【検出パターン】見出しで省略なしと明示する（issue #196）', () => {
		const pats = Array.from({ length: 5 }, () => makePattern());
		const res = formatDetailedView('H', pats, '', '', emptyMeta, undefined, emptyRes);
		expect(res.content[0].text).toContain('【検出パターン】 5 / 全 5 件（省略なし）');
	});

	it('5 件未満検出時は【検出パターン】見出しにトリム申告を出さない（issue #196）', () => {
		const pats = Array.from({ length: 3 }, () => makePattern());
		const res = formatDetailedView('H', pats, '', '', emptyMeta, undefined, emptyRes);
		const text = res.content[0].text;
		// 「全 3 件」は検出経路行（`検出経路: 全 3 件とも strict…`）にも正当に出現するので存在チェックには使えず、見出し行そのものを固定して確認する。
		expect(text).toContain('【検出パターン】\n');
		expect(text).not.toContain('省略');
	});

	it('usage_example を structuredContent に含む', () => {
		const res = formatDetailedView('H', [], '', '', emptyMeta, undefined, emptyRes);
		const sc = res.structuredContent as Record<string, unknown>;
		expect(sc.usage_example).toBeDefined();
	});
});

// 構造化データ（range.start/end 等）は UTC ISO のまま不変で、表示テキストのみ tz で整形される（2026-10-01T23:30:00.000Z → JST: 2026-10-02 08:30、UTC: 2026-10-01）。

describe('表示日付の tz 整形（範囲・期間）', () => {
	const startUtcLate = '2026-10-01T23:30:00.000Z'; // UTC=10/01, JST=10/02
	const endUtcLate = '2026-10-10T23:30:00.000Z'; // UTC=10/10, JST=10/11

	it('formatPatternLine: tz 既定で legacy 期間行が JST 暦日になる', () => {
		const p = makePattern({ range: { start: startUtcLate, end: endUtcLate } });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('期間: 2026-10-02 ~ 2026-10-11');
		expect(result).not.toContain('2026-10-01');
		expect(result).not.toContain('2026-10-10');
	});

	it("formatPatternLine: tz='UTC' のとき legacy 期間行が UTC 暦日になる", () => {
		const p = makePattern({ range: { start: startUtcLate, end: endUtcLate } });
		const result = formatPatternLine(p, 0, 'summary', emptyMeta, 'UTC');
		expect(result).toContain('期間: 2026-10-01 ~ 2026-10-10');
	});

	it('formatPatternLine: structureRange が tz 既定で JST 暦日になる', () => {
		const p = makePattern({
			structureRange: { start: startUtcLate, end: endUtcLate },
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('形成期間: 2026-10-02 ~ 2026-10-11（構成点）');
	});

	it("formatPatternLine: structureRange が tz='UTC' のとき UTC 暦日になる", () => {
		const p = makePattern({
			structureRange: { start: startUtcLate, end: endUtcLate },
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta, 'UTC');
		expect(result).toContain('形成期間: 2026-10-01 ~ 2026-10-10（構成点）');
	});

	it('formatPatternLine: confirmation.date が tz 既定で JST 暦日になる', () => {
		const p = makePattern({
			structureRange: { start: '2026-09-01T00:00:00.000Z', end: '2026-09-26T00:00:00.000Z' },
			confirmation: { type: 'neckline_breakout', date: startUtcLate, idx: 31, price: 12345 },
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('ブレイク確認: 2026-10-02');
	});

	it("formatPatternLine: confirmation.date が tz='UTC' のとき UTC 暦日になる", () => {
		const p = makePattern({
			structureRange: { start: '2026-09-01T00:00:00.000Z', end: '2026-09-26T00:00:00.000Z' },
			confirmation: { type: 'neckline_breakout', date: startUtcLate, idx: 31, price: 12345 },
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta, 'UTC');
		expect(result).toContain('ブレイク確認: 2026-10-01');
	});

	it('formatPatternLine: precedingTrend が tz 既定で JST 暦日になる', () => {
		const p = makePattern({
			precedingTrend: {
				start: startUtcLate,
				end: endUtcLate,
				direction: 'down',
				returnPct: -5,
				lookbackBars: 10,
			},
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta);
		expect(result).toContain('先行トレンド: 2026-10-02 ~ 2026-10-11');
	});

	it("formatPatternLine: precedingTrend が tz='UTC' のとき UTC 暦日になる", () => {
		const p = makePattern({
			precedingTrend: {
				start: startUtcLate,
				end: endUtcLate,
				direction: 'down',
				returnPct: -5,
				lookbackBars: 10,
			},
		});
		const result = formatPatternLine(p, 0, 'summary', emptyMeta, 'UTC');
		expect(result).toContain('先行トレンド: 2026-10-01 ~ 2026-10-10');
	});

	it('formatPatternLine: pivot 日付（double_top）が tz 既定で JST 暦日になる', () => {
		const meta = {
			debug: {
				swings: [
					{ kind: 'peak', idx: 0, price: 100000, isoTime: startUtcLate },
					{ kind: 'valley', idx: 5, price: 90000, isoTime: '2026-10-05T23:30:00.000Z' },
					{ kind: 'peak', idx: 10, price: 100000, isoTime: endUtcLate },
				],
			},
		};
		const p = makePattern({ type: 'double_top' });
		const result = formatPatternLine(p, 0, 'full', meta);
		expect(result).toContain('山1: 2026-10-02');
		expect(result).toContain('谷: 2026-10-06');
		expect(result).toContain('山2: 2026-10-11');
	});

	it("formatPatternLine: pivot 日付（double_top）が tz='UTC' のとき UTC 暦日になる", () => {
		const meta = {
			debug: {
				swings: [
					{ kind: 'peak', idx: 0, price: 100000, isoTime: startUtcLate },
					{ kind: 'valley', idx: 5, price: 90000, isoTime: '2026-10-05T23:30:00.000Z' },
					{ kind: 'peak', idx: 10, price: 100000, isoTime: endUtcLate },
				],
			},
		};
		const p = makePattern({ type: 'double_top' });
		const result = formatPatternLine(p, 0, 'full', meta, 'UTC');
		expect(result).toContain('山1: 2026-10-01');
		expect(result).toContain('谷: 2026-10-05');
		expect(result).toContain('山2: 2026-10-10');
	});

	it('formatPatternLine: breakout 日付が tz 既定で JST 暦日になる', () => {
		const meta = {
			debug: {
				swings: [{ kind: 'peak', idx: 10, price: 95000, isoTime: startUtcLate }],
			},
		};
		const p = makePattern({ breakout: { idx: 10, price: 95000 } });
		const result = formatPatternLine(p, 0, 'full', meta);
		expect(result).toContain('ブレイク: 2026-10-02');
	});

	it("formatPatternLine: breakout 日付が tz='UTC' のとき UTC 暦日になる", () => {
		const meta = {
			debug: {
				swings: [{ kind: 'peak', idx: 10, price: 95000, isoTime: startUtcLate }],
			},
		};
		const p = makePattern({ breakout: { idx: 10, price: 95000 } });
		const result = formatPatternLine(p, 0, 'full', meta, 'UTC');
		expect(result).toContain('ブレイク: 2026-10-01');
	});

	it('formatDebugView: swing isoTime が tz 既定で JST 暦日になる', () => {
		const meta = {
			debug: {
				swings: [{ kind: 'peak', idx: 0, price: 100000, isoTime: startUtcLate }],
				candidates: [],
			},
		};
		const res = formatDebugView('hdr', meta, [], {
			ok: true,
			summary: 'debug',
			data: { patterns: [], overlays: null },
			meta: {},
		});
		expect(res.content[0].text).toContain('(2026-10-02)');
	});

	it("formatDebugView: swing isoTime が tz='UTC' のとき UTC 暦日になる", () => {
		const meta = {
			debug: {
				swings: [{ kind: 'peak', idx: 0, price: 100000, isoTime: startUtcLate }],
				candidates: [],
			},
		};
		const res = formatDebugView(
			'hdr',
			meta,
			[],
			{ ok: true, summary: 'debug', data: { patterns: [], overlays: null }, meta: {} },
			'UTC',
		);
		expect(res.content[0].text).toContain('(2026-10-01)');
	});
});

// 検出器 / `structuredContent` は変えず、値は `pivots` から表示層で導出する。分母は `levelSpreadMetrics([a, c], [a, b, c]).heightAbs`（issue #245）。
describe('formatPatternLine: 山2 / 谷2 の位置行（#245）', () => {
	/** 山1 `a` 終値 100,000・高値 101,000 / 谷 `b` 終値 90,000・安値 89,000 / 山2 `c` 終値 92,000・高値 100,000 → heightAbs = 12,000、closeGap = 2,000 / 12,000 = 16.7%、wickShare = 8,000 / 12,000 = 66.7%。 */
	const wickyTop = (): PatternEntry =>
		makePattern({
			type: 'double_top',
			pivots: [
				{ idx: 0, price: 100000, kind: 'H', extremePrice: 101000 },
				{ idx: 5, price: 90000, kind: 'L', extremePrice: 89000 },
				{ idx: 10, price: 92000, kind: 'H', extremePrice: 100000 },
			],
		});

	/** 上の符号反転（`double_bottom`）。谷2 の終値はネックラインの 16.7% 下。 */
	const wickyBottom = (): PatternEntry =>
		makePattern({
			type: 'double_bottom',
			pivots: [
				{ idx: 0, price: 90000, kind: 'L', extremePrice: 89000 },
				{ idx: 5, price: 100000, kind: 'H', extremePrice: 101000 },
				{ idx: 10, price: 98000, kind: 'L', extremePrice: 90000 },
			],
		});

	it('double_top: closeGap / wickShare が定義どおりに出る', () => {
		const line = formatPatternLine(wickyTop(), 0, 'full', emptyMeta);
		expect(line).toContain('   - 山2 の位置: 終値はネックラインの +16.7%（パターン高さ比）/ ヒゲ 66.7%');
	});

	it('double_bottom: 符号は価格の向き（ネックラインより下なので負）', () => {
		const line = formatPatternLine(wickyBottom(), 0, 'full', emptyMeta);
		expect(line).toContain('   - 谷2 の位置: 終値はネックラインの -16.7%（パターン高さ比）/ ヒゲ 66.7%');
	});

	it('4 つの view すべてで出る（pivot 明細行と違い view で分岐しない）', () => {
		// `debug` view の formatter は `formatPatternLine` を呼ばないが、`formatPatternLine(…, 'debug', …)` 単体は出す（view 値そのものが行を落とさないことを固定する）。
		for (const view of ['summary', 'detailed', 'full', 'debug'] as const) {
			expect(formatPatternLine(wickyTop(), 0, view, emptyMeta), `view=${view}`).toContain('山2 の位置: ');
			expect(formatPatternLine(wickyBottom(), 0, view, emptyMeta), `view=${view}`).toContain('谷2 の位置: ');
		}
	});

	it('status が付いていても出る（double の 4 段すべて）', () => {
		for (const status of ['completed', 'near_completion', 'expired', 'invalid'] as const) {
			const p = { ...wickyTop(), status } as PatternEntry;
			expect(formatPatternLine(p, 0, 'full', emptyMeta), status).toContain('山2 の位置: ');
		}
	});

	it('pivot 明細行の直後・ネックライン行の直前に出る', () => {
		const p = {
			...wickyTop(),
			neckline: [
				{ x: 0, y: 90000 },
				{ x: 10, y: 90000 },
			],
		} as PatternEntry;
		const lines = formatPatternLine(p, 0, 'full', emptyMeta).split('\n');
		const posIdx = lines.findIndex((l) => l.includes('山2 の位置: '));
		const lastPivotIdx = lines.findIndex((l) => l.trim().startsWith('- 山2:'));
		const necklineIdx = lines.findIndex((l) => l.trim().startsWith('- ネックライン:'));
		expect(lastPivotIdx).toBeGreaterThanOrEqual(0);
		expect(necklineIdx).toBeGreaterThanOrEqual(0);
		expect(posIdx).toBe(lastPivotIdx + 1);
		expect(necklineIdx).toBe(posIdx + 1);
	});

	it('pivots が 3 点でないとき出さない（2 点 / 4 点とも）', () => {
		const two = makePattern({
			type: 'double_top',
			pivots: [
				{ idx: 0, price: 100000, kind: 'H', extremePrice: 101000 },
				{ idx: 5, price: 90000, kind: 'L', extremePrice: 89000 },
			],
		});
		const four = makePattern({
			type: 'double_top',
			pivots: [...(wickyTop().pivots ?? []), { idx: 15, price: 88000, kind: 'L', extremePrice: 87000 }],
		});
		expect(formatPatternLine(two, 0, 'full', emptyMeta)).not.toContain('山2 の位置');
		expect(formatPatternLine(four, 0, 'full', emptyMeta)).not.toContain('山2 の位置');
	});

	it('extremePrice が欠けているとき出さない（n/a も出さない）', () => {
		const p = makePattern({
			type: 'double_top',
			pivots: [
				{ idx: 0, price: 100000, kind: 'H', extremePrice: 101000 },
				{ idx: 5, price: 90000, kind: 'L' } as unknown as NonNullable<PatternEntry['pivots']>[number],
				{ idx: 10, price: 92000, kind: 'H', extremePrice: 100000 },
			],
		});
		const line = formatPatternLine(p, 0, 'full', emptyMeta);
		expect(line).not.toContain('山2 の位置');
		expect(line).not.toContain('パターン高さ比');
	});

	it('heightAbs が 0 のとき出さない（ゼロ除算を n/a で報告しない）', () => {
		const p = makePattern({
			type: 'double_top',
			pivots: [
				{ idx: 0, price: 100000, kind: 'H', extremePrice: 100000 },
				{ idx: 5, price: 90000, kind: 'L', extremePrice: 100000 },
				{ idx: 10, price: 92000, kind: 'H', extremePrice: 100000 },
			],
		});
		expect(formatPatternLine(p, 0, 'full', emptyMeta)).not.toContain('山2 の位置');
	});

	it('H&S には出さない（肩の位置は別定義のため）', () => {
		const triple = makePattern({
			type: 'triple_top',
			pivots: [
				{ idx: 0, price: 100000, kind: 'H', extremePrice: 101000 },
				{ idx: 5, price: 90000, kind: 'L', extremePrice: 89000 },
				{ idx: 10, price: 100000, kind: 'H', extremePrice: 101000 },
				{ idx: 15, price: 90000, kind: 'L', extremePrice: 89000 },
				{ idx: 20, price: 92000, kind: 'H', extremePrice: 100000 },
			],
		});
		const hs = makePattern({
			type: 'head_and_shoulders',
			pivots: [
				{ idx: 0, price: 98000, kind: 'H', extremePrice: 99000 },
				{ idx: 5, price: 90000, kind: 'L', extremePrice: 89000 },
				{ idx: 10, price: 105000, kind: 'H', extremePrice: 106000 },
				{ idx: 15, price: 90000, kind: 'L', extremePrice: 89000 },
				{ idx: 20, price: 97000, kind: 'H', extremePrice: 99000 },
			],
		});
		expect(formatPatternLine(hs, 0, 'full', emptyMeta)).not.toContain('の位置: 終値はネックライン');
		expect(formatPatternLine(triple, 0, 'full', emptyMeta)).toContain('山1 の位置: 終値はネックライン');
	});

	it('triple_top / triple_bottom: 各主構成点の終値とヒゲを表示する', () => {
		const top = makePattern({
			type: 'triple_top',
			pivots: [
				{ idx: 0, price: 100000, kind: 'H', extremePrice: 101000 },
				{ idx: 5, price: 90000, kind: 'L', extremePrice: 89000 },
				{ idx: 10, price: 98000, kind: 'H', extremePrice: 100000 },
				{ idx: 15, price: 91000, kind: 'L', extremePrice: 90000 },
				{ idx: 20, price: 95000, kind: 'H', extremePrice: 99000 },
			],
		});
		const bottom = makePattern({
			type: 'triple_bottom',
			pivots: [
				{ idx: 0, price: 90000, kind: 'L', extremePrice: 89000 },
				{ idx: 5, price: 100000, kind: 'H', extremePrice: 101000 },
				{ idx: 10, price: 92000, kind: 'L', extremePrice: 90000 },
				{ idx: 15, price: 99000, kind: 'H', extremePrice: 100000 },
				{ idx: 20, price: 95000, kind: 'L', extremePrice: 91000 },
			],
		});
		const topLine = formatPatternLine(top, 0, 'summary', emptyMeta);
		const bottomLine = formatPatternLine(bottom, 0, 'summary', emptyMeta);
		expect(topLine).toContain('山1 の位置: 終値はネックラインの +79.2%（パターン高さ比）/ ヒゲ 8.3%');
		expect(topLine).toContain('山2 の位置: 終値はネックラインの +62.5%（パターン高さ比）/ ヒゲ 16.7%');
		expect(topLine).toContain('山3 の位置: 終値はネックラインの +37.5%（パターン高さ比）/ ヒゲ 33.3%');
		expect(bottomLine).toContain('谷1 の位置: 終値はネックラインの -79.2%（パターン高さ比）/ ヒゲ 8.3%');
		expect(bottomLine).toContain('谷2 の位置: 終値はネックラインの -62.5%（パターン高さ比）/ ヒゲ 16.7%');
		expect(bottomLine).toContain('谷3 の位置: 終値はネックラインの -37.5%（パターン高さ比）/ ヒゲ 33.3%');
	});

	it('triple forming: 確定済みの2主構成点だけ表示する', () => {
		const forming = makePattern({
			type: 'triple_top',
			status: 'forming',
			pivots: [
				{ idx: 0, price: 100000, kind: 'H', extremePrice: 101000 },
				{ idx: 5, price: 90000, kind: 'L', extremePrice: 89000 },
				{ idx: 10, price: 98000, kind: 'H', extremePrice: 100000 },
				{ idx: 15, price: 91000, kind: 'L', extremePrice: 90000 },
			],
		});
		const line = formatPatternLine(forming, 0, 'full', emptyMeta);
		expect(line).toContain('山1 の位置:');
		expect(line).toContain('山2 の位置:');
		expect(line).not.toContain('山3 の位置:');
	});
});

describe('formatPatternLine: 先行値幅の未評価理由', () => {
	it('structureGate.skipped を理由付きで表示する', () => {
		const noPrior = formatPatternLine(
			makePattern({ structureGate: { skipped: 'no_prior_extreme' } }),
			0,
			'summary',
			emptyMeta,
		);
		const insufficient = formatPatternLine(
			makePattern({ structureGate: { skipped: 'insufficient_history' } }),
			0,
			'summary',
			emptyMeta,
		);
		expect(noPrior).toContain('先行値幅: 窓の先頭のため未評価');
		expect(insufficient).toContain('先行値幅: 交差確認に必要な履歴が不足しているため未評価');
	});
});

/** `Record<BreakoutPathRejectReason, …>` で受けているので、`tools/patterns/structural.ts` の union に値を足すと typecheck がここで落ちる（手書きの配列にすると気づけない）。 */
const BREAKOUT_PATH_REASONS: Record<BreakoutPathRejectReason, true> = {
	peak_after_last_pivot: true,
	trough_after_last_pivot: true,
};

/** 上と同じく `Record<ContinuationInvalidReason, …>` で受け、union に値を足したら typecheck で落とす（issue #291）。 */
const CONTINUATION_INVALID_REASONS: Record<ContinuationInvalidReason, true> = {
	breakout_against_expectation: true,
};

/** `re_entered_trough_zone`（`reversal-gate.ts`）と `forming_expired`（`detect_doubles.ts`）はリテラル直書きで導出できる型が無いので手書きする。検出器に新しい理由コードを足したらここにも足すこと。 */
const ALL_INVALID_REASONS: readonly string[] = [
	...(Object.keys(BREAKOUT_PATH_REASONS) as BreakoutPathRejectReason[]),
	...(Object.keys(CONTINUATION_INVALID_REASONS) as ContinuationInvalidReason[]),
	're_entered_trough_zone',
	'forming_expired',
];

const CONTINUATION_INVALID_TYPES = [
	'triangle_ascending',
	'triangle_descending',
	'bull_flag',
	'bear_flag',
	'bull_pennant',
	'bear_pennant',
] as const;

/** `status` の全件。schema の enum から導出する（表示層が status を取りこぼさないため）。 */
const ALL_STATUSES = DetectedPatternSchema.shape.status.unwrap().options;

/** top 側 / bottom 側の反転系。`re_entered_trough_zone` のゾーン語の向きを独立に決めるのに使う。 */
const TOP_SIDE_REVERSALS = ['double_top', 'triple_top', 'head_and_shoulders'] as const;
const BOTTOM_SIDE_REVERSALS = ['double_bottom', 'triple_bottom', 'inverse_head_and_shoulders'] as const;

describe('状態行: status × 理由コードの網羅（issue #286）', () => {
	it('検出器が出す 5 つの理由コードを列挙している', () => {
		expect([...ALL_INVALID_REASONS].sort()).toEqual([
			'breakout_against_expectation',
			'forming_expired',
			'peak_after_last_pivot',
			're_entered_trough_zone',
			'trough_after_last_pivot',
		]);
	});

	it('schema の status 5 段すべてを列挙している', () => {
		expect([...ALL_STATUSES].sort()).toEqual(['completed', 'expired', 'forming', 'invalid', 'near_completion']);
	});

	const INVALID_CASES: ReadonlyArray<{
		entry: Pick<PatternEntry, 'type' | 'status' | 'invalidReason'>;
		expected: string;
	}> = [
		{
			entry: { type: 'double_top', status: 'invalid', invalidReason: 'peak_after_last_pivot' },
			expected: '   - 状態: 無効（山2 の後に別の山を作ってから割った: peak_after_last_pivot）',
		},
		{
			entry: { type: 'double_bottom', status: 'invalid', invalidReason: 'trough_after_last_pivot' },
			expected: '   - 状態: 無効（谷2 の後に別の谷を作ってから抜けた: trough_after_last_pivot）',
		},
		// 経路ゲートは triple / H&S にも掛かる（#242 の横展開）ので、最終構成点の呼び名も種別で変わる。
		{
			entry: { type: 'triple_top', status: 'invalid', invalidReason: 'peak_after_last_pivot' },
			expected: '   - 状態: 無効（山3 の後に別の山を作ってから割った: peak_after_last_pivot）',
		},
		{
			entry: { type: 'head_and_shoulders', status: 'invalid', invalidReason: 'peak_after_last_pivot' },
			expected: '   - 状態: 無効（右肩 の後に別の山を作ってから割った: peak_after_last_pivot）',
		},
		{
			entry: { type: 'inverse_head_and_shoulders', status: 'invalid', invalidReason: 'trough_after_last_pivot' },
			expected: '   - 状態: 無効（右肩 の後に別の谷を作ってから抜けた: trough_after_last_pivot）',
		},
		{
			entry: { type: 'double_top', status: 'invalid', invalidReason: 're_entered_trough_zone' },
			expected: '   - 状態: 無効（山2 の確定後、突破前に山ゾーンへ戻った: re_entered_trough_zone）',
		},
		{
			entry: { type: 'double_bottom', status: 'invalid', invalidReason: 're_entered_trough_zone' },
			expected: '   - 状態: 無効（谷2 の確定後、突破前に谷ゾーンへ戻った: re_entered_trough_zone）',
		},
		// 継続系は種別に関係なく同じ文言（継続系に最終構成点の概念が無いので、反転系の「山2 / 谷3 / 右肩」に相当する語を当てない。issue #291）。
		...CONTINUATION_INVALID_TYPES.map((type) => ({
			entry: { type, status: 'invalid' as const, invalidReason: 'breakout_against_expectation' },
			expected: '   - 状態: 無効（期待と逆方向にブレイク: breakout_against_expectation）',
		})),
		// `expired` を表引きに入れ忘れると、生の `expired` が content に出る。
		{
			entry: { type: 'double_top', status: 'expired', invalidReason: 'forming_expired' },
			expected: '   - 状態: 期限切れ（突破確認窓を過ぎてもネックラインを突破しなかった: forming_expired）',
		},
		{
			entry: { type: 'double_bottom', status: 'expired', invalidReason: 'forming_expired' },
			expected: '   - 状態: 期限切れ（突破確認窓を過ぎてもネックラインを突破しなかった: forming_expired）',
		},
	];

	for (const { entry, expected } of INVALID_CASES) {
		it(`${entry.status} × ${entry.invalidReason}（${entry.type}）の状態行を固定する`, () => {
			expect(formatStatusLine(entry)).toBe(expected);
		});
	}

	it('expired のラベルが出る（生の expired が content に出ない）', () => {
		const line = formatStatusLine({ type: 'double_top', status: 'expired', invalidReason: 'forming_expired' });
		expect(line).toContain('期限切れ');
		expect(line).not.toMatch(/状態: expired/u);
	});

	it('未知の invalidReason は日本語を当てずコードだけ出す', () => {
		expect(formatStatusLine({ type: 'double_top', status: 'invalid', invalidReason: 'some_future_reason' })).toBe(
			'   - 状態: 無効（some_future_reason）',
		);
	});

	it('invalidReason が欠損なら「無効」だけ', () => {
		expect(formatStatusLine({ type: 'double_top', status: 'invalid' })).toBe('   - 状態: 無効');
	});

	it('理由コードは必ず併記される（日本語だけにならない）', () => {
		for (const reason of ALL_INVALID_REASONS) {
			for (const type of [...TOP_SIDE_REVERSALS, ...BOTTOM_SIDE_REVERSALS, ...CONTINUATION_INVALID_TYPES]) {
				const line = formatStatusLine({ type, status: 'invalid', invalidReason: reason });
				expect(line, `${type} × ${reason}`).toContain(reason);
			}
		}
	});

	it('5 つの理由コードすべてに日本語ラベルがある（コードだけにならない）', () => {
		for (const reason of ALL_INVALID_REASONS) {
			const line = formatStatusLine({ type: 'double_top', status: 'invalid', invalidReason: reason });
			expect(line, reason).toContain(`: ${reason}）`);
		}
	});

	// `invalidReasonJa` は `REVERSAL_STATUS_WORDS` を引ける実装なので、継続系の文言に反転系の語（山2 / 谷2 / 山3 / 谷3 / 右肩 / ネックライン）を混ぜる形を機械的に禁じる（issue #291）。
	it('breakout_against_expectation は反転系の構成点の語を使わない', () => {
		for (const type of CONTINUATION_INVALID_TYPES) {
			const line = formatStatusLine({ type, status: 'invalid', invalidReason: 'breakout_against_expectation' });
			for (const word of ['山2', '山3', '谷2', '谷3', '右肩', 'ネックライン', '最終構成点']) {
				expect(line, `${type} × ${word}`).not.toContain(word);
			}
		}
	});

	// `re_entered_trough_zone` のゾーン語は実装の表と独立に side から決める（実装の表をそのまま写すと分岐漏れが両方に入って気づけない）。
	for (const type of TOP_SIDE_REVERSALS) {
		it(`re_entered_trough_zone: ${type} は山ゾーン`, () => {
			const line = formatStatusLine({ type, status: 'invalid', invalidReason: 're_entered_trough_zone' });
			expect(line).toContain('山ゾーンへ戻った');
			expect(line).not.toContain('谷ゾーンへ戻った');
		});
	}
	for (const type of BOTTOM_SIDE_REVERSALS) {
		it(`re_entered_trough_zone: ${type} は谷ゾーン`, () => {
			const line = formatStatusLine({ type, status: 'invalid', invalidReason: 're_entered_trough_zone' });
			expect(line).toContain('谷ゾーンへ戻った');
			expect(line).not.toContain('山ゾーンへ戻った');
		});
	}

	it('未知 type の re_entered_trough_zone は方向を持たない言い回しにする', () => {
		const line = formatStatusLine({
			type: 'some_future_pattern',
			status: 'invalid',
			invalidReason: 're_entered_trough_zone',
		});
		expect(line).toBe(
			'   - 状態: 無効（最終構成点の確定後、突破前に最終構成点のゾーンへ戻った: re_entered_trough_zone）',
		);
		expect(line).not.toContain('山ゾーン');
		expect(line).not.toContain('谷ゾーン');
	});

	for (const type of ['double_top', 'triple_bottom', 'inverse_head_and_shoulders'] as const) {
		it(`near_completion: 反転系 ${type} は「構造成立・ネックライン未突破」`, () => {
			expect(formatStatusLine({ type, status: 'near_completion' })).toBe(
				'   - 状態: ほぼ完成（構造成立・ネックライン未突破）',
			);
		});
	}

	for (const type of ['triangle_ascending', 'rising_wedge'] as const) {
		it(`near_completion: 継続系 ${type} は「apex接近」（現行どおり）`, () => {
			expect(formatStatusLine({ type, status: 'near_completion' })).toBe('   - 状態: ほぼ完成（apex接近）');
		});
	}

	it('near_completion: どちらの系統にも属さない type は apex とも未突破とも言わない', () => {
		expect(formatStatusLine({ type: 'some_future_pattern', status: 'near_completion' })).toBe('   - 状態: ほぼ完成');
	});

	// 新しい type を `PatternTypeEnum` に足して系統の集合へ入れ忘れると、その type の `near_completion` が裸の「ほぼ完成」に落ちるので、出力 type 全件を系統に分類できていることを機械的に固定する。
	it('near_completion: 出力 type 全件が反転系 / 継続系のどちらかに分類されている', () => {
		const unclassified = PatternTypeEnum.options.filter(
			(type) => formatStatusLine({ type, status: 'near_completion' }) === '   - 状態: ほぼ完成',
		);
		expect(unclassified).toEqual([]);
	});

	it('completed / forming は現行どおり（理由コードを持たない）', () => {
		expect(formatStatusLine({ type: 'double_top', status: 'completed' })).toBe(
			'   - 状態: 完成（ブレイクアウト確認済み）',
		);
		expect(formatStatusLine({ type: 'triple_top', status: 'forming' })).toBe('   - 状態: 形成中');
	});

	it('status 5 段すべてに日本語ラベルがある（生の status が出ない）', () => {
		for (const status of ALL_STATUSES) {
			const line = formatStatusLine({ type: 'double_top', status });
			expect(line, status).not.toContain(status);
		}
	});

	it('status が無ければ状態行を出さない', () => {
		expect(formatStatusLine({ type: 'double_top' })).toBeNull();
	});

	it('未知の status は生の値をそのまま出す', () => {
		expect(formatStatusLine({ type: 'double_top', status: 'custom_status' })).toBe('   - 状態: custom_status');
	});

	it('formatPatternLine の状態行が formatStatusLine と一致する', () => {
		const p = makePattern({ status: 'invalid', invalidReason: 'peak_after_last_pivot' });
		expect(formatPatternLine(p, 0, 'detailed', emptyMeta)).toContain(
			'   - 状態: 無効（山2 の後に別の山を作ってから割った: peak_after_last_pivot）',
		);
	});
});

describe('価格の表示桁は価格の水準で決める', () => {
	const subYenPattern = () =>
		makePattern({
			pivots: [
				{ idx: 0, price: 0.0512, kind: 'H', extremePrice: 0.05131 },
				{ idx: 5, price: 0.0461, kind: 'L', extremePrice: 0.0461 },
				{ idx: 10, price: 0.05118, kind: 'H', extremePrice: 0.05129 },
			],
			breakout: { idx: 12, price: 0.04583 },
			breakoutTarget: 0.0409876,
			targetMethod: 'pattern_height',
		});

	it('1 円未満のペアでは目標・ブレイク・山谷の価格を 0 や 1 に潰さない', () => {
		const text = formatPatternLine(subYenPattern(), 0, 'full', emptyMeta);
		expect(text).toContain('ターゲット価格: 0.0409876円');
		expect(text).toContain('(0.04583円)');
		expect(text).toContain('終値 0.0512円 / 高値 0.05131円');
		expect(text).toContain('安値 0.0461円（判定は安値基準）');
	});

	it('full view の応答でも同じ桁で出る', () => {
		const text = formatFullView('hdr', [subYenPattern()], '', '', emptyMeta, emptyRes).content[0].text;
		expect(text).toContain('ターゲット価格: 0.0409876円');
	});

	it('10 万円以上では円の整数のまま', () => {
		const p = makePattern({
			breakout: { idx: 12, price: 95_000.4 },
			breakoutTarget: 15_234_567.6,
			targetMethod: 'pattern_height',
		});
		const text = formatPatternLine(p, 0, 'full', emptyMeta);
		expect(text).toContain('ターゲット価格: 15,234,568円');
		expect(text).toContain('(95,000円)');
	});

	it('debug view のスイングと候補の点も 1 円未満の桁で出す', () => {
		const meta = {
			debug: {
				swings: [{ kind: 'peak', idx: 3, price: 0.0512345, isoTime: '2026-01-03T00:00:00.000Z' }],
				candidates: [
					{
						type: 'double_top',
						accepted: false,
						reason: 'peaks_not_equal',
						points: [{ role: 'peak1', idx: 3, price: 0.0512345 }],
					},
				],
			},
		};
		const text = formatDebugView('hdr', meta, [], makeDebugViewRes()).content[0].text;
		expect(text).toContain('price=0.0512345');
		expect(text).toContain('peak1@3:0.0512345');
	});
});
