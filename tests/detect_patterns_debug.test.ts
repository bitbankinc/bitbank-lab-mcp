import { afterEach, describe, expect, it, vi } from 'vitest';
import { asMockResult, assertOk } from './_assertResult.js';

vi.mock('../tools/analyze_indicators.js', () => ({
	default: vi.fn(),
}));

import { formatDebugView } from '../src/handlers/detectPatternsDebugView.js';
import analyzeIndicators from '../tools/analyze_indicators.js';
import detectPatterns from '../tools/detect_patterns.js';
import { buildBtcJpy2026Candles } from './fixtures/btc_jpy_1day_2026.js';

type Candle = { isoTime: string; open: number; high: number; low: number; close: number; volume: number };

function makeIso(dayOffset: number): string {
	return new Date(Date.UTC(2026, 0, 1 + dayOffset)).toISOString();
}

/** close と high/low を明確にずらした足（価格基準の検証に要る） */
function makeCandle(dayOffset: number, close: number): Candle {
	return {
		isoTime: makeIso(dayOffset),
		open: close,
		high: close + 3,
		low: close - 3,
		close,
		volume: 100,
	};
}

/** 足ごとにヒゲ幅を変えた足。定数ヒゲだと high / low / close が互いの平行移動になり、極値判定も回帰の傾きも基準によらず一致して、どちらの基準で見ているかをテストが識別できない（乱数は決定性のため使わない）。 */
function makeWickyCandle(dayOffset: number, close: number): Candle {
	// 振幅は「極値の位置が基準で変わる最小限」に取ってある。大きくしすぎるとスイングがヒゲのノイズで決まり、価格構造ではなく fixture の細工を測るテストになる。
	return {
		isoTime: makeIso(dayOffset),
		open: close,
		high: close + 1 + ((dayOffset * 3) % 9),
		low: close - 1 - ((dayOffset * 4) % 9),
		close,
		volume: 100,
	};
}

/** `detect_triangles` の relaxed swing（`swingDepth=1`: 前後 1 本より高い / 低い）を任意の系列で再現する。 */
function relaxedSwingIndices(candles: Candle[], kind: 'H' | 'L', pick?: (c: Candle) => number): number[] {
	const value = pick ?? ((c: Candle) => (kind === 'H' ? c.high : c.low));
	const out: number[] = [];
	for (let i = 1; i < candles.length - 1; i++) {
		const v = value(candles[i]);
		const prev = value(candles[i - 1]);
		const next = value(candles[i + 1]);
		if (kind === 'H' ? v > prev && v > next : v < prev && v < next) out.push(i);
	}
	return out;
}

function indicatorsOk(candles: Candle[]) {
	return { ok: true, summary: 'ok', data: { chart: { candles } } };
}

/** 単一パターンの fixture だと「他種別の候補が押し出す」状況自体が再現しないので、多数の種別の候補が同時に立つ揺れの大きい価格列を使う。 */
function buildNoisyCandles(): Candle[] {
	return Array.from({ length: 120 }, (_, i) =>
		makeCandle(i, 100 + Math.sin(i / 3) * 12 + Math.cos(i / 7) * 8 + (i % 5)),
	);
}

const mockedAnalyzeIndicators = vi.mocked(analyzeIndicators);

async function run(candles: Candle[], opts: Record<string, unknown>) {
	mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));
	return detectPatterns('btc_jpy', '1day', candles.length, opts);
}

/** `detect_triangles` が candidate に付けうる type ラベル（umbrella + 具体 3 種）。 */
const TRIANGLE_CANDIDATE_LABELS = [
	'triangle',
	'triangle_ascending',
	'triangle_descending',
	'triangle_symmetrical',
] as const;

/** 具体型が決まらないまま積まれる棄却理由で、いずれも umbrella ラベルで積む契約。`type_not_requested` は型が決まっているので具体型ラベルで積み、ここに含めない。 */
const PRE_CLASSIFICATION_REASONS = [
	'poor_trendline_fit',
	'excessive_outlier_removal',
	'classification_failed',
] as const;

/** 候補を「ラベルを無視した中身」に落とす（ラベル変更が件数・理由を動かしていないことの検証用）。 */
function candidateShape(c: { accepted?: boolean; reason?: string; indices?: number[] }) {
	return `${c.accepted ? 'A' : 'R'}:${c.reason ?? ''}:${(c.indices ?? []).join(',')}`;
}

/** 形成中 triangle_symmetrical（tests/patterns/invariants.test.ts と同じ価格列） */
const symTriangleCloses = [
	120, 126, 132, 137, 130, 122, 116, 110, 104, 100, 106, 114, 120, 128, 134, 128, 120, 115, 108, 104, 110, 118, 124,
	130, 126, 120, 116, 112, 108, 114, 120, 126, 124, 120, 117, 114,
];

describe('detect_patterns: debug candidates の要求種別フィルタ（#124）', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('patterns=[double_bottom] の candidates は double_bottom だけになる', async () => {
		const candles = buildNoisyCandles();
		const res = await run(candles, { patterns: ['double_bottom'], includeForming: true });
		assertOk(res);
		const cands = res.meta.debug?.candidates ?? [];
		expect(cands.length).toBeGreaterThan(0);
		expect([...new Set(cands.map((c) => c.type))]).toEqual(['double_bottom']);
	});

	it('要求種別の棄却理由が理由コード付きで出る', async () => {
		const candles = buildNoisyCandles();
		const res = await run(candles, { patterns: ['double_bottom'], includeForming: true });
		assertOk(res);
		const rejected = (res.meta.debug?.candidates ?? []).filter((c) => !c.accepted);
		expect(rejected.length).toBeGreaterThan(0);
		for (const c of rejected) {
			expect(typeof c.reason, JSON.stringify(c)).toBe('string');
			expect(c.reason).not.toBe('');
		}
		// 理由コードは content にも出る（LLM は structuredContent を読めない）
		const text = formatDebugView('hdr', res.meta, [], res).content[0].text;
		expect(text).toContain('double_bottom');
		for (const c of rejected) expect(text).toContain(String(c.reason));
	});

	it('候補段階の棄却（❌）は status を持たず includeInvalid では拾えないことを content で説明する（issue #149）', async () => {
		// head_not_higher 等の候補段階の棄却と、status=invalid/expired（構造ゲート通過後の無効化）は別カテゴリで、後者だけが includeInvalid=true で拾える。この区別が content に出ていないと「includeInvalid を立てても消えた候補が出てこない」を利用者が原因不明のまま観測する。
		const candles = buildNoisyCandles();
		const opts = { patterns: ['double_bottom'], includeForming: true };

		const withoutInvalid = await run(candles, { ...opts, includeInvalid: false });
		assertOk(withoutInvalid);
		const rejected = (withoutInvalid.meta.debug?.candidates ?? []).filter((c) => !c.accepted);
		expect(rejected.length).toBeGreaterThan(0);
		// 棄却は status が決まる前の分岐で積まれるので、❌ 側（rejected）だけが status を持たないことを固定する（issue #149）。
		for (const c of rejected) expect('status' in c).toBe(false);

		const text = formatDebugView('hdr', withoutInvalid.meta, [], withoutInvalid).content[0].text;
		expect(text).toContain('候補段階の棄却');
		expect(text).toContain('includeInvalid では拾えない');

		// includeInvalid=true にしても、候補段階で棄却されたものは data.patterns に紛れ込まない（増えるのは status=invalid/expired のパターンだけ）。
		const withInvalid = await run(candles, { ...opts, includeInvalid: true });
		assertOk(withInvalid);
		const isSamePattern = (a: { type: string; range: { start: string; end: string } }, b: typeof a) =>
			a.type === b.type && a.range.start === b.range.start && a.range.end === b.range.end;
		const added = withInvalid.data.patterns.filter(
			(p: { type: string; range: { start: string; end: string } }) =>
				!withoutInvalid.data.patterns.some((q: typeof p) => isSamePattern(p, q)),
		);
		for (const p of added as Array<{ status?: string }>) expect(['invalid', 'expired']).toContain(p.status);
	});

	it('要求していない種別（wedge / triangle / flag）の候補は 1 件も出ない', async () => {
		const candles = buildNoisyCandles();
		const res = await run(candles, { patterns: ['double_bottom'], includeForming: true });
		assertOk(res);
		const types = new Set<string>((res.meta.debug?.candidates ?? []).map((c) => String(c.type)));
		for (const unwanted of ['falling_wedge', 'rising_wedge', 'triangle_symmetrical', 'flag', 'double_top']) {
			expect(types.has(unwanted), `${unwanted} が残っている`).toBe(false);
		}
	});

	it('patterns 未指定時は絞らない（他種別の候補がそのまま出る）', async () => {
		const candles = buildNoisyCandles();
		const res = await run(candles, { includeForming: true });
		assertOk(res);
		const types = new Set((res.meta.debug?.candidates ?? []).map((c) => c.type));
		expect(types.size).toBeGreaterThan(1);
		expect(types.has('double_bottom') || types.has('falling_wedge')).toBe(true);
	});

	it("エイリアス 'triangle' は 3 種と umbrella ラベルの候補を残す", async () => {
		const candles = buildNoisyCandles();
		const res = await run(candles, { patterns: ['triangle'], includeForming: true });
		assertOk(res);
		const types = new Set((res.meta.debug?.candidates ?? []).map((c) => c.type));
		expect(types.size).toBeGreaterThan(0);
		// 分類前の棄却は umbrella ラベル 'triangle' で積まれるので、`startsWith('triangle_')` だけを見ると umbrella を弾いてしまう（#129）。
		for (const t of types) expect(TRIANGLE_CANDIDATE_LABELS).toContain(t);
	});

	it('候補フィルタは data.patterns を変えない', async () => {
		const candles = buildNoisyCandles();
		const all = await run(candles, { includeForming: true });
		const filtered = await run(candles, { patterns: ['double_bottom'], includeForming: true });
		assertOk(all);
		assertOk(filtered);
		// patterns フィルタは検出結果側にも効くので「double_bottom 以外が消える」のは正しい。検証したいのは「残った double_bottom が絞り込み前と同一」であること。
		const pick = (r: typeof all) => r.data.patterns.filter((p) => p.type === 'double_bottom');
		expect(pick(filtered)).toEqual(pick(all));
	});

	it('候補ゼロのとき content は「絞り込みの結果かもしれない」ことを明示する', async () => {
		const candles = buildNoisyCandles();
		const res = await run(candles, { patterns: ['double_bottom'], includeForming: true });
		assertOk(res);
		// 0 件になる価格列は時間足依存で脆いので、meta を空候補に差し替えて、0 件表示が「パターンが無い」と読まれないことを表示だけで固定する。
		const emptyMeta = { ...res.meta, debug: { ...res.meta.debug, candidates: [] } };
		const text = formatDebugView('hdr', emptyMeta, [], { ...res, meta: emptyMeta }).content[0].text;
		expect(text).toContain('なし');
		expect(text).toContain('candidates は入力 patterns で絞り込まれる');
	});
});

describe('detect_patterns: triangle の分類前ラベル（#129）', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		'triangle_ascending',
		'triangle_descending',
	] as const)('patterns=[%s] でも分類前の棄却理由が届く', async (want) => {
		const candles = buildNoisyCandles();
		const res = await run(candles, { patterns: [want], includeForming: true });
		assertOk(res);
		const cands = res.meta.debug?.candidates ?? [];
		const preClassification = cands.filter((c) => PRE_CLASSIFICATION_REASONS.includes(c.reason as never));
		expect(preClassification.length, '分類前の棄却理由が 1 件も届いていない').toBeGreaterThan(0);
		// 回帰の当てはまり不足は `want` に依らず起きる棄却なので、具体型を要求しても必ず届く（`classification_failed` はこの fixture では出ないので必須にしない）。
		const reasons = new Set(preClassification.map((c) => c.reason));
		expect(reasons.has('poor_trendline_fit'), 'poor_trendline_fit が届いていない').toBe(true);
		const text = formatDebugView('hdr', res.meta, [], res).content[0].text;
		for (const r of reasons) expect(text).toContain(String(r));
	});

	// 分類判定は `want` をゲートに含むので、`triangleType === null` には「形が成立しない」と「形は成立するが要求外」が混ざる。後者を classification_failed と報告すると、正常に分類できる窓を「分類失敗」と偽って伝えることになる。
	it('要求外の型を classification_failed と偽らない', async () => {
		const candles = symTriangleCloses.map((c, i) => makeCandle(i, c));
		const sym = await run(candles, { patterns: ['triangle_symmetrical'], includeForming: true });
		const asc = await run(candles, { patterns: ['triangle_ascending'], includeForming: true });
		assertOk(sym);
		assertOk(asc);
		// 前提: この窓は対称三角形としては成立する（成立しない fixture では検証にならない）
		expect(
			sym.data.patterns.filter((p) => p.type === 'triangle_symmetrical').length,
			'対称三角形が成立しない fixture では「要求外」と「分類失敗」を区別できない',
		).toBeGreaterThan(0);
		const failed = (asc.meta.debug?.candidates ?? []).filter((c) => c.reason === 'classification_failed');
		expect(failed, `要求外の窓が classification_failed で届いている: ${JSON.stringify(failed)}`).toEqual([]);
	});

	// 具体型が決まらない棄却 ⇔ umbrella ラベル、型が決まっている棄却・採用 ⇔ 具体型で、どの `want` で呼んでも成り立つ。`type_not_requested` は要求外の型のラベルで積むので候補フィルタが落とし、出力に現れない（設計どおり）。
	it.each([
		undefined,
		['triangle'],
		['triangle_ascending'],
		['triangle_symmetrical'],
	] as const)('patterns=%j でもラベルと理由コードの対応が崩れない', async (want) => {
		// 対称三角形だけの fixture だと `patterns=['triangle_ascending']` で候補が 0 件になり、ラベル規則を 1 件も検証しないまま通ってしまうので、全 want で三角形系候補が立つ価格列を使う。
		const candles = buildNoisyCandles();
		const res = await run(candles, { includeForming: true, ...(want ? { patterns: [...want] } : {}) });
		assertOk(res);
		const cands = (res.meta.debug?.candidates ?? []).filter((c) => TRIANGLE_CANDIDATE_LABELS.includes(c.type as never));
		expect(cands.length, '三角形系の候補が 0 件では検証にならない').toBeGreaterThan(0);
		// 条件分岐の中で expect を呼ばない（vitest/no-conditional-expect）ので、違反した候補を集めてから 1 度だけ突き合わせる（落ちたときにどれが違反かも出る）。
		const mislabeled = cands.filter((c) =>
			PRE_CLASSIFICATION_REASONS.includes(c.reason as never) ? c.type !== 'triangle' : c.type === 'triangle',
		);
		expect(mislabeled, '具体型が決まらない棄却 ⇔ umbrella ラベルの対応が崩れている').toEqual([]);
		expect(
			cands.filter((c) => c.reason === 'type_not_requested'),
			'要求外の候補が届いている',
		).toEqual([]);
	});

	it('分類前の棄却は具体型ではなく umbrella ラベル triangle で積まれる', async () => {
		const candles = buildNoisyCandles();
		// `patterns` 未指定だと cap=200 のトリム（accepted 優先）で三角形の棄却が押し出されてラベルの検証にならないので、3 種すべてを要求するエイリアス 'triangle' を使う（検出器から見た want は未指定と同じ）。
		const res = await run(candles, { patterns: ['triangle'], includeForming: true });
		assertOk(res);
		const cands = res.meta.debug?.candidates ?? [];
		const preClassification = cands.filter((c) => PRE_CLASSIFICATION_REASONS.includes(c.reason as never));
		expect(preClassification.length).toBeGreaterThan(0);
		for (const c of preClassification) {
			expect(c.type, `${c.reason} が具体型で積まれている: ${JSON.stringify(c)}`).toBe('triangle');
		}
		// 逆向き: 具体型のラベルには分類前の理由が付かない。これが無いと「umbrella も具体型も両方 push している」実装を通してしまう。
		const concrete = cands.filter((c) => c.type !== 'triangle');
		expect(concrete.length, '具体型ラベルの候補が 1 件も無いと逆向きの検証にならない').toBeGreaterThan(0);
		for (const c of concrete) {
			expect(PRE_CLASSIFICATION_REASONS.includes(c.reason as never), JSON.stringify(c)).toBe(false);
		}
	});

	// エイリアス 'triangle' は検出器から見た want が未指定と同じなので、候補ストリームも同一で 1 件も落ちてはいけない。cap=200 のトリムが比較を壊さないよう、候補総数が cap に届かない小さい fixture を使う。
	it('patterns 未指定と patterns=[triangle] で三角形系候補の件数・理由コードが一致する', async () => {
		const candles = symTriangleCloses.map((c, i) => makeCandle(i, c));
		const all = await run(candles, { includeForming: true });
		const tri = await run(candles, { patterns: ['triangle'], includeForming: true });
		assertOk(all);
		assertOk(tri);
		expect(
			(all.meta.debug?.candidates ?? []).length,
			'候補が cap=200 でトリムされる fixture では未指定側と比較できない',
		).toBeLessThan(200);
		const pick = (r: typeof all) =>
			(r.meta.debug?.candidates ?? [])
				.filter((c) => TRIANGLE_CANDIDATE_LABELS.includes(c.type as never))
				.map(candidateShape);
		const fromAll = pick(all);
		expect(fromAll.length).toBeGreaterThan(0);
		expect(pick(tri)).toEqual(fromAll);
	});

	/** 交絡 2 キーは「この呼び出しが返した集合の中に他パターンのブレイクがあったか」を定義とする申告なので、`patterns` で集合を絞れば当然減る。比較から外し、振る舞いは下のテストで固定する（issue #288 Phase 2）。 */
	const CONFOUNDER_KEYS = ['targetOtherBreakoutBeforeReach', 'targetOppositeBreakoutInWindow'] as const;
	const stripConfounders = (p: Record<string, unknown>) => {
		const out = { ...p };
		for (const k of CONFOUNDER_KEYS) delete out[k];
		return out;
	};

	it('data.patterns は patterns=[triangle] の有無で変わらない（交絡 2 キーを除く）', async () => {
		const candles = buildNoisyCandles();
		const all = await run(candles, { includeForming: true });
		const tri = await run(candles, { patterns: ['triangle'], includeForming: true });
		assertOk(all);
		assertOk(tri);
		const pick = (r: typeof all) =>
			r.data.patterns
				.filter((p) => p.type.startsWith('triangle_'))
				.map((p) => stripConfounders(p as unknown as Record<string, unknown>));
		expect(pick(all).length).toBeGreaterThan(0);
		expect(pick(tri)).toEqual(pick(all));
	});

	it('交絡の基準集合は patterns で絞られる（他の検出器を呼ばなければ他ブレイクは見えない）', async () => {
		const candles = buildNoisyCandles();
		const all = await run(candles, { includeForming: true });
		const tri = await run(candles, { patterns: ['triangle'], includeForming: true });
		assertOk(all);
		assertOk(tri);
		const confounded = (r: typeof all) =>
			r.data.patterns.filter((p) => {
				const e = p as unknown as Record<string, unknown>;
				return !p.type.startsWith('triangle_')
					? false
					: CONFOUNDER_KEYS.some((k) => Array.isArray(e[k]) && (e[k] as unknown[]).length > 0);
			});
		// 全種別を検出したときは triangle にも他パターン由来の交絡が付く。
		const withAll = confounded(all);
		expect(withAll.length).toBeGreaterThan(0);
		// 三角形だけに絞ると、非 triangle のブレイクは基準集合に存在しないので減る。
		expect(confounded(tri).length).toBeLessThan(withAll.length);
	});
});

describe('detect_patterns: wedge の分類前ラベル', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// BTC 日足（90 本）では、ウェッジの走査が上下の線の傾きの向きがそろわない窓を回帰の当てはまり不足で 4 件棄却する。
	const isWedgeScanReject = (c: { reason?: string }) => c.reason === 'r2_below_threshold';
	const WEDGE_LABEL_REASONS = ['r2_below_threshold', 'type_classification_failed', 'slopes_not_same_direction'];

	it('上下の傾きの向きがそろわない窓の棄却は umbrella ラベル wedge で積まれ、ウェッジの要求で届く', async () => {
		const res = await run(buildBtcJpy2026Candles(), { patterns: ['rising_wedge'] });
		assertOk(res);
		const rejects = (res.meta.debug?.candidates ?? []).filter((c) => c.type === 'wedge');
		expect(rejects.filter(isWedgeScanReject)).toHaveLength(4);
		expect(rejects.filter((c) => !WEDGE_LABEL_REASONS.includes(String(c.reason)))).toEqual([]);
	});

	it('ウェッジの走査の棄却は三角形の要求では届かない', async () => {
		const res = await run(buildBtcJpy2026Candles(), { patterns: ['triangle'] });
		assertOk(res);
		const cands = res.meta.debug?.candidates ?? [];
		expect(cands.length, '三角形系の候補が 0 件では検証にならない').toBeGreaterThan(0);
		expect(cands.filter(isWedgeScanReject)).toEqual([]);
	});

	/** 上の線が下がり下の線が上がる収束（対称三角形の形）。BTC 日足には、傾きの分類まで届く逆向きの窓が無い。 */
	function buildConvergingZigzag(): Candle[] {
		const n = 60;
		const period = 8;
		return Array.from({ length: n }, (_, i) => {
			const upper = 130 - (20 * i) / n;
			const lower = 90 + (16 * i) / n;
			const phase = (i % period) / period;
			const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2;
			const close = lower + (upper - lower) * tri;
			return { isoTime: makeIso(i), open: close, high: close + 0.5, low: close - 0.5, close, volume: 100 };
		});
	}

	const typeFailed = (c: { reason?: string }) => c.reason === 'type_classification_failed';
	const formingOpposite = (c: { reason?: string }) => c.reason === 'slopes_not_same_direction';

	it.each([
		'rising_wedge',
		'falling_wedge',
	] as const)('逆向きの傾きの棄却は、完成済みの走査・形成中の走査とも wedge で積まれ、patterns=[%s] で届く', async (want) => {
		const res = await run(buildConvergingZigzag(), { patterns: [want] });
		assertOk(res);
		const cands = res.meta.debug?.candidates ?? [];
		const failed = cands.filter(typeFailed);
		const forming = cands.filter(formingOpposite);
		expect(failed.length, '傾きの分類まで届く窓が無いと検証にならない').toBeGreaterThan(0);
		expect(forming.length, '形成中の走査の棄却が無いと検証にならない').toBeGreaterThan(0);
		expect([...failed, ...forming].filter((c) => c.type !== 'wedge')).toEqual([]);
		// 傾きの比ではなく、向きがそろわないことが棄却の理由
		const reasons = new Set(failed.map((c) => (c.details as { failureReason?: string } | undefined)?.failureReason));
		expect([...reasons]).toEqual(['slopes_not_same_direction']);
	});

	it('逆向きの傾きの棄却は三角形の要求では届かない', async () => {
		const res = await run(buildConvergingZigzag(), { patterns: ['triangle'] });
		assertOk(res);
		const cands = res.meta.debug?.candidates ?? [];
		expect(cands.filter((c) => typeFailed(c) || formingOpposite(c))).toEqual([]);
	});
});

describe('detect_patterns: pivot の価格基準（#125）', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** 完成済み double_top（tests/patterns/invariants.test.ts と同じ価格列） */
	const doubleTopCloses = [
		100, 102, 105, 110, 118, 130, 126, 122, 118, 114, 112, 110, 114, 118, 122, 126, 128, 129, 123, 116, 104, 100, 95,
		100, 99, 98,
	];

	it('全 pivot が kind と extremePrice を持つ', async () => {
		const candles = buildNoisyCandles();
		const res = await run(candles, { includeForming: true, includeInvalid: true, swingDepth: 2 });
		assertOk(res);
		const pivots = res.data.patterns.flatMap((p) => p.pivots ?? []);
		expect(pivots.length).toBeGreaterThan(0);
		for (const pv of pivots) {
			expect(['H', 'L']).toContain(pv.kind);
			expect(Number.isFinite(pv.extremePrice), JSON.stringify(pv)).toBe(true);
		}
	});

	it('ピボット由来の検出器では price=終値 / extremePrice=判定に使った高安', async () => {
		const candles = doubleTopCloses.map((c, i) => makeCandle(i, c));
		const res = await run(candles, { patterns: ['double_top'], swingDepth: 2, tolerancePct: 0.02 });
		assertOk(res);
		const dt = res.data.patterns.find((p) => p.type === 'double_top');
		expect(dt?.pivots?.length).toBeGreaterThan(0);
		for (const pv of dt?.pivots ?? []) {
			const c = candles[pv.idx];
			expect(pv.price).toBe(c.close);
			expect(pv.extremePrice).toBe(pv.kind === 'H' ? c.high : c.low);
		}
	});

	// 三角形はトレンドラインを高安列に回帰させ `neckline` もその線から取るので、構成点も高安のまま持つ（`price` を終値に差し替えると構成点が自分のトレンドライン上に乗らなくなり、`aftermath.theoreticalTarget` も動く）。
	it('triangle_* の pivot は price も extremePrice も回帰に使った高安（終値ではない）', async () => {
		const candles = symTriangleCloses.map((c, i) => makeWickyCandle(i, c));

		// この fixture が基準を識別できることを先に確かめる（定数ヒゲだと終値基準に差し替えても通ってしまう）。
		const highSwings = relaxedSwingIndices(candles, 'H');
		const closeHighSwings = relaxedSwingIndices(candles, 'H', (c) => c.close);
		const lowSwings = relaxedSwingIndices(candles, 'L');
		const closeLowSwings = relaxedSwingIndices(candles, 'L', (c) => c.close);
		expect(highSwings, '高値基準と終値基準で山の位置が変わらない fixture では基準を識別できない').not.toEqual(
			closeHighSwings,
		);
		expect(lowSwings, '安値基準と終値基準で谷の位置が変わらない fixture では基準を識別できない').not.toEqual(
			closeLowSwings,
		);

		const res = await run(candles, { patterns: ['triangle_symmetrical'], includeForming: true });
		assertOk(res);
		const tri = res.data.patterns.find((p) => p.type === 'triangle_symmetrical');
		expect(tri?.pivots?.length).toBeGreaterThan(0);
		for (const pv of tri?.pivots ?? []) {
			const c = candles[pv.idx];
			const extreme = pv.kind === 'H' ? c.high : c.low;
			expect(pv.extremePrice, `idx=${pv.idx} の extremePrice`).toBe(extreme);
			expect(pv.price, `idx=${pv.idx} の price`).toBe(extreme);
			expect(pv.price, `idx=${pv.idx} は終値ではない`).not.toBe(c.close);
			// 値だけでなく構成点の位置も高安基準であることを見る（終値基準に変えるとここが真っ先に落ちる）。
			const basisSwings = pv.kind === 'H' ? highSwings : lowSwings;
			expect(basisSwings, `idx=${pv.idx} は高安基準のスイング位置`).toContain(pv.idx);
		}
	});

	it('full view の pivot 行に採用基準が出る', async () => {
		const candles = doubleTopCloses.map((c, i) => makeCandle(i, c));
		const res = await run(candles, { patterns: ['double_top'], swingDepth: 2, tolerancePct: 0.02 });
		assertOk(res);
		const { formatPatternLine } = await import('../src/handlers/detectPatternsViewsHandler.js');
		const dt = res.data.patterns.find((p) => p.type === 'double_top');
		expect(dt).toBeDefined();
		const line = formatPatternLine(dt as NonNullable<typeof dt>, 0, 'full', res.meta);
		expect(line).toContain('山1');
		expect(line).toContain('終値');
		expect(line).toContain('判定は高値基準');
		expect(line).toContain('判定は安値基準');
	});
});

// `debug.swings` / `debug.candidates` は cap=200 で切り詰められ、candidates は accepted を優先して残すので棄却理由から先に削られ、`view=debug` の目的そのものが選択的に censored される。申告値がトリムの実挙動と一致し、省略あり / なしの両方で content に出ることを固定する（#180）。
describe('detect_patterns: cap トリムの申告（#180）', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('省略が無いとき candidatesTotal は配列長と一致し content は「省略なし」と出る', async () => {
		const candles = buildNoisyCandles();
		const res = await run(candles, { patterns: ['double_bottom'], includeForming: true });
		assertOk(res);
		const cands = res.meta.debug?.candidates ?? [];
		const swings = res.meta.debug?.swings ?? [];
		// 種別を絞っているので 200 には届かない（届いたら前提が壊れているので気づけるように固定する）
		expect(cands.length).toBeLessThan(200);
		expect(res.meta.debug?.candidatesTotal).toBe(cands.length);
		expect(res.meta.debug?.candidatesOmitted).toBe(0);
		expect(res.meta.debug?.swingsTotal).toBe(swings.length);
		expect(res.meta.debug?.swingsOmitted).toBe(0);

		const text = formatDebugView('hdr', res.meta, [], res).content[0].text;
		// 「200 件」だけだと飽和なのか偶然なのか読めないので、省略 0 でも明示する
		expect(text).toContain(`【Candidates】 ${cands.length} / 全 ${cands.length} 件（省略なし）`);
		expect(text).toContain(`【Swings】 ${swings.length} / 全 ${swings.length} 件（省略なし）`);
		expect(text).not.toContain('件省略');
	});

	// 合成 fixture では 200 に届かないので、実データ fixture を `swingDepth: 2` で走らせる。
	it('省略があるとき総数と省略件数を申告し content に出す', async () => {
		const candles = buildBtcJpy2026Candles();
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));
		const res = await detectPatterns('btc_jpy', '1day', candles.length, { swingDepth: 2, includeForming: true });
		assertOk(res);
		const cands = res.meta.debug?.candidates ?? [];
		const total = res.meta.debug?.candidatesTotal ?? 0;
		const omitted = res.meta.debug?.candidatesOmitted ?? 0;

		expect(cands.length).toBe(200);
		expect(total).toBeGreaterThan(200);
		expect(omitted).toBe(total - cands.length);

		// 「省略分はすべて棄却理由」が成り立つ根拠は accepted 優先のトリム順なので、返る配列が accepted 先頭に分割されていることを固定する（でないと content の文言が嘘になる）。
		const acceptedFlags = cands.map((c) => !!c.accepted);
		expect(acceptedFlags).toEqual([...acceptedFlags].sort((a, b) => Number(b) - Number(a)));

		const text = formatDebugView('hdr', res.meta, [], res).content[0].text;
		expect(text).toContain(`【Candidates】 200 / 全 ${total} 件（${omitted} 件省略`);
		// このケースは返却分に棄却が残っている（accepted は全件収まった）ので、「省略分はすべて棄却理由」を言い切ってよい側の文言になる。
		expect(cands.some((c) => !c.accepted)).toBe(true);
		expect(text).toContain('accepted は全件残っているため省略分はすべて棄却理由');
	});

	// `swings` は先頭から cap 件を残すので、落ちるのは直近側（`candidates` と逆）。本コーパスでは 200 に届かないので、届いていないこと自体を申告として観測する。
	it('swings 側も総数と省略件数を申告する', async () => {
		const candles = buildBtcJpy2026Candles();
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));
		const res = await detectPatterns('btc_jpy', '1day', candles.length, { swingDepth: 2, includeForming: true });
		assertOk(res);
		const swings = res.meta.debug?.swings ?? [];
		expect(res.meta.debug?.swingsTotal).toBe(swings.length);
		expect(res.meta.debug?.swingsOmitted).toBe(0);
		const text = formatDebugView('hdr', res.meta, [], res).content[0].text;
		expect(text).toContain(`【Swings】 ${swings.length} / 全 ${swings.length} 件（省略なし）`);
	});
});
