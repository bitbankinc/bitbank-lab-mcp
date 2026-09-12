/**
 * tests/detect_patterns_debug.test.ts
 *
 * `view=debug` の可観測性の契約（#124 / #125）。
 *
 * 1. `patterns` を指定したとき、candidates が**要求種別の棄却理由**になる
 *    （以前は各検出器が want を「分類・出力の時点」でしか見ておらず、
 *     走査中に積まれた他種別の候補が cap=200 を食い潰していた）
 * 2. `patterns` 未指定時の candidates は絞られない
 * 3. `data.patterns` は `patterns` フィルタの有無で変わらない
 *    （候補フィルタは debug 出力だけに効き、検出結果には触らない）
 * 4. 分類前の棄却は umbrella ラベル（`triangle`）で積まれ、具体型を要求した
 *    呼び出しにも届く（#129）
 * 5. pivot は極値判定に使った値（`extremePrice`）を持ち、`price` は終値
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asMockResult, assertOk } from './_assertResult.js';

vi.mock('../tools/analyze_indicators.js', () => ({
	default: vi.fn(),
}));

import { formatDebugView } from '../src/handlers/detectPatternsViewsHandler.js';
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

/**
 * 足ごとにヒゲ幅を変えた足。**定数ヒゲにしないこと**が要点で、`close ± 一定` だと
 * high / low / close が互いの平行移動になり、極値判定（前後 1 本との大小比較）も
 * 回帰の傾きも基準によらず一致してしまう。それでは「高安基準で見ているのか
 * 終値基準で見ているのか」をテストが識別できない。
 * 乱数は使わない（決定性が要る。`Math.random` は banned-patterns）。
 */
function makeWickyCandle(dayOffset: number, close: number): Candle {
	// 振幅は「極値の位置が基準で変わる最小限」に取ってある。大きくしすぎると
	// スイングがヒゲのノイズで決まり、価格構造ではなく fixture の細工を測るテストになる。
	return {
		isoTime: makeIso(dayOffset),
		open: close,
		high: close + 1 + ((dayOffset * 3) % 9),
		low: close - 1 - ((dayOffset * 4) % 9),
		close,
		volume: 100,
	};
}

/**
 * `detect_triangles` の relaxed swing（`swingDepth=1`: 前後 1 本より高い / 低い）を
 * 任意の系列で再現する。既定は検出器と同じ high / low 基準。
 */
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

/**
 * 多数の種別の候補が同時に立つ、揺れの大きい価格列。
 * 単一パターンの fixture だと「他種別の候補が押し出す」状況自体が再現しない。
 */
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

/**
 * 具体型が決まらないまま積まれる棄却理由。いずれも umbrella ラベルで積む契約。
 * - `poor_trendline_fit`: 回帰の当てはまり不足。分類に入る前の棄却
 * - `excessive_outlier_removal`: 外れ値除去が上限を超えた。分類に入る前の棄却（#141）
 * - `classification_failed`: 3 種のどの形にも当てはまらない（`want` と無関係に成立しない）
 *
 * **`type_not_requested` はここに含めない。** あれは「形は成立するが要求外」で型が決まって
 * いるため、具体型ラベルで積む（`detect_wedges` の同名 reason と同じ idiom）。
 */
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
		// head_not_higher 等の候補段階の棄却と、status=invalid/expired（構造ゲート通過後の無効化）は
		// 別カテゴリで、後者だけが includeInvalid=true で拾える。この区別自体が content に出ていないと
		// 「includeInvalid を立てても消えた候補が出てこない」を利用者が原因不明のまま観測することになる。
		const candles = buildNoisyCandles();
		const opts = { patterns: ['double_bottom'], includeForming: true };

		const withoutInvalid = await run(candles, { ...opts, includeInvalid: false });
		assertOk(withoutInvalid);
		const rejected = (withoutInvalid.meta.debug?.candidates ?? []).filter((c) => !c.accepted);
		expect(rejected.length).toBeGreaterThan(0);
		// `CandDebugEntry` には元から `status` があり、#155 以降は `accepted:true` のエントリ
		// （形成中パスの成功候補）が実際に値を持つ。ここが依然 rejected 限定で通るのは
		// 「型に無いから」ではなく、**棄却は status が決まる前の分岐で積まれる**ため。
		// この非対称（❌ は status なし / ✅ は持ちうる）が issue #149 の区別そのものなので、
		// ❌ 側だけを固定する。
		for (const c of rejected) expect('status' in c).toBe(false);

		const text = formatDebugView('hdr', withoutInvalid.meta, [], withoutInvalid).content[0].text;
		expect(text).toContain('候補段階の棄却');
		expect(text).toContain('includeInvalid では拾えない');

		// includeInvalid=true にしても、候補段階で棄却されたものが data.patterns に紛れ込まないことを確認する。
		// 増える（もしあれば）のは status=invalid/expired のパターンだけのはず。
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
		// 分類前の棄却は umbrella ラベル 'triangle' で積まれる（#129）。
		// `startsWith('triangle_')` だけを見ると umbrella を弾いてしまう。
		for (const t of types) expect(TRIANGLE_CANDIDATE_LABELS).toContain(t);
	});

	it('候補フィルタは data.patterns を変えない', async () => {
		const candles = buildNoisyCandles();
		const all = await run(candles, { includeForming: true });
		const filtered = await run(candles, { patterns: ['double_bottom'], includeForming: true });
		assertOk(all);
		assertOk(filtered);
		// patterns フィルタは検出結果側にも効くので「double_bottom 以外が消える」のは正しい。
		// 検証したいのは「残った double_bottom が絞り込み前と同一」であること。
		const pick = (r: typeof all) => r.data.patterns.filter((p) => p.type === 'double_bottom');
		expect(pick(filtered)).toEqual(pick(all));
	});

	it('候補ゼロのとき content は「絞り込みの結果かもしれない」ことを明示する', async () => {
		const candles = buildNoisyCandles();
		const res = await run(candles, { patterns: ['double_bottom'], includeForming: true });
		assertOk(res);
		// 絞り込み後に 0 件になりうるので、0 件表示が「パターンが無い」と読まれないようにする。
		// ここでは meta を空候補に差し替えて表示だけを固定する（0 件になる価格列は時間足依存で脆い）。
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

	// `detect_triangles` は 3 種（ascending / descending / symmetrical）の分類が確定する前にも
	// 候補を棄却する。かつてその push が `type: 'triangle_symmetrical'` をハードコードしていたため、
	// `patterns=['triangle_ascending']` を指定すると候補フィルタが全部落とし、
	// **検出器は実際に走査・棄却しているのに理由が 1 件も届かなかった**。
	// push を umbrella ラベル `'triangle'` に変えて解消した（#129）。

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
		// 回帰の当てはまり不足は `want` に依らず起きる棄却なので、具体型を要求しても必ず届く。
		// （`classification_failed` は「どの形にも当てはまらない」窓が要る。この fixture では
		//  出ないので必須にしない——要求外を分類失敗と偽っていた頃はここが常に真だった。）
		const reasons = new Set(preClassification.map((c) => c.reason));
		expect(reasons.has('poor_trendline_fit'), 'poor_trendline_fit が届いていない').toBe(true);
		// 理由コードは content にも出る（LLM は structuredContent を読めない）
		const text = formatDebugView('hdr', res.meta, [], res).content[0].text;
		for (const r of reasons) expect(text).toContain(String(r));
	});

	// 分類判定は `want` をゲートに含む（`flatThreshold` > `moveThreshold` で分岐条件が重なるため、
	// 外すと選ばれる型が変わる = 検出結果が変わる）。その結果 `triangleType === null` には
	// 「形が成立しない」と「形は成立するが要求外」が混ざる。**後者を classification_failed と
	// 報告すると、正常に分類できる窓を「分類失敗」と偽って伝えることになる。**
	// umbrella ラベル化でそれがフィルタを通過して届くようになったため、理由コードを分けた。
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
		// その窓を ascending 要求時に「分類失敗」として報告しない
		const failed = (asc.meta.debug?.candidates ?? []).filter((c) => c.reason === 'classification_failed');
		expect(failed, `要求外の窓が classification_failed で届いている: ${JSON.stringify(failed)}`).toEqual([]);
	});

	// ラベルの契約: 具体型が決まらない棄却 ⇔ umbrella ラベル、型が決まっている棄却・採用 ⇔ 具体型。
	// どの `want` で呼んでも成り立つ（`want` は届く範囲を変えるだけでラベルの規則を変えない）。
	//
	// `type_not_requested` が出力に現れないのは**設計どおり**。要求外の型のラベルで積むので
	// 候補フィルタが落とす（規約「`want` に含まれない種別の candidate が出ない」）。
	// `detect_wedges` の同名 reason と同じ挙動で、要求した型のノイズにしないためのもの。
	it.each([
		undefined,
		['triangle'],
		['triangle_ascending'],
		['triangle_symmetrical'],
	] as const)('patterns=%j でもラベルと理由コードの対応が崩れない', async (want) => {
		// 全 want で三角形系候補が立つ価格列を使う。対称三角形だけの fixture だと
		// `patterns=['triangle_ascending']` で候補が 0 件になり（要求外が届かないのは正しい挙動）、
		// ラベル規則を 1 件も検証しないまま通ってしまう。
		const candles = buildNoisyCandles();
		const res = await run(candles, { includeForming: true, ...(want ? { patterns: [...want] } : {}) });
		assertOk(res);
		const cands = (res.meta.debug?.candidates ?? []).filter((c) => TRIANGLE_CANDIDATE_LABELS.includes(c.type as never));
		expect(cands.length, '三角形系の候補が 0 件では検証にならない').toBeGreaterThan(0);
		// 条件分岐の中で expect を呼ばない（vitest/no-conditional-expect）。
		// 違反した候補を集めてから 1 度だけ突き合わせる——落ちたときにどれが違反かも出る。
		const mislabeled = cands.filter((c) =>
			PRE_CLASSIFICATION_REASONS.includes(c.reason as never) ? c.type !== 'triangle' : c.type === 'triangle',
		);
		expect(mislabeled, '具体型が決まらない棄却 ⇔ umbrella ラベルの対応が崩れている').toEqual([]);
		// 要求外の棄却は候補フィルタで落ちるので、呼び出し側には届かない
		expect(
			cands.filter((c) => c.reason === 'type_not_requested'),
			'要求外の候補が届いている',
		).toEqual([]);
	});

	it('分類前の棄却は具体型ではなく umbrella ラベル triangle で積まれる', async () => {
		const candles = buildNoisyCandles();
		// `patterns` 未指定だと cap=200 のトリム（accepted 優先）で三角形の棄却が押し出されて
		// しまい、ラベルの検証にならない（それ自体が #124 の症状）。エイリアス 'triangle' は
		// 3 種すべてを要求するので、検出器から見た want は未指定と同じになる。
		const res = await run(candles, { patterns: ['triangle'], includeForming: true });
		assertOk(res);
		const cands = res.meta.debug?.candidates ?? [];
		const preClassification = cands.filter((c) => PRE_CLASSIFICATION_REASONS.includes(c.reason as never));
		expect(preClassification.length).toBeGreaterThan(0);
		for (const c of preClassification) {
			expect(c.type, `${c.reason} が具体型で積まれている: ${JSON.stringify(c)}`).toBe('triangle');
		}
		// 逆向き: 具体型のラベルには分類前の理由が付かない（= ラベルが実際の型と一致している）。
		// これが無いと「umbrella も具体型も両方 push している」実装を通してしまう。
		const concrete = cands.filter((c) => c.type !== 'triangle');
		expect(concrete.length, '具体型ラベルの候補が 1 件も無いと逆向きの検証にならない').toBeGreaterThan(0);
		for (const c of concrete) {
			expect(PRE_CLASSIFICATION_REASONS.includes(c.reason as never), JSON.stringify(c)).toBe(false);
		}
	});

	// #129 の受け入れ条件: ラベル以外は何も動かさない。
	// エイリアス 'triangle' は 3 種すべてを要求するので、検出器から見た want は未指定と同じ。
	// つまり候補ストリームも同一で、絞り込みで 1 件も落ちてはいけない。
	// cap=200 のトリムが比較を壊さないよう、**候補総数が cap に届かない小さい fixture**を使う。
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

	/**
	 * ラベルは debug 出力の話でしかない。検出結果に触れていないことを直接固定する。
	 *
	 * **交絡 2 キーだけは比較から外す**（issue #288 Phase 2）。`targetOtherBreakoutBeforeReach` /
	 * `targetOppositeBreakoutInWindow` は「**この呼び出しが返した集合の中に**他パターンの
	 * ブレイクがあったか」を定義とする申告なので、`patterns` で集合を絞れば当然減る
	 * （下の「基準集合は `patterns` で絞られる」が仕様として固定している）。
	 * **判定フィールドはここで全件突き合わせたまま**——絞り込みで `confidence` / `status` /
	 * `targetReachedPct` 等が動いていないことは引き続きこのテストが保証する。
	 */
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

	// 上で比較から外した 2 キーの振る舞いを**仕様として**押さえる（黙って落とさない）。
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

	// `price` の基準は検出器ごとに違う。三角形はトレンドライン（upperLine / lowerLine）を
	// この高安列に回帰させ、`neckline` もその線から取るため、構成点も高安のまま持つ。
	// `price` を終値に差し替えると構成点が自分のトレンドライン上に乗らなくなり、
	// `aftermath.theoreticalTarget`（min/max(pivots[].price) 由来）も動く。
	// 不変なのは「`extremePrice` は判定に使った値」の一点だけなので、
	// 差が silent に入れ替わらないよう**現行の契約をここで固定する**（CodeRabbit review, PR #128）。
	it('triangle_* の pivot は price も extremePrice も回帰に使った高安（終値ではない）', async () => {
		const candles = symTriangleCloses.map((c, i) => makeWickyCandle(i, c));

		// この fixture が基準を識別できることを先に確かめる。
		// 定数ヒゲ（close ± 3）だと high / low / close が互いの平行移動になり、
		// 極値判定の結果も回帰の傾きも基準によらず一致するため、
		// 「終値基準に差し替えても通ってしまうテスト」になる（CodeRabbit review, PR #128）。
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
			// 値だけでなく**構成点の位置**も高安基準であることを見る。
			// 終値基準に変えるとここが真っ先に落ちる。
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

/**
 * cap トリムの申告（issue #180 案 1）。
 *
 * `debug.swings` / `debug.candidates` は cap=200 で切り詰められるが、切られたことが出力の
 * どこにも現れなかった。**削られるのは必ず `accepted: false`＝棄却理由**（accepted を優先して
 * 残すため）なので、`view=debug` の目的そのものが選択的に censored される。
 *
 * ここで固定するのは 3 点:
 * 1. 新フィールドが**出力に届く**こと。`DetectPatternsOutputSchema.parse` は宣言の無いキーを
 *    黙って落とすので（#155 / PR #159、#160 / PR #161 で 2 回踏んだ）、スキーマ宣言の
 *    回帰をここで捕まえる
 * 2. 申告値がトリムの実挙動と一致すること（`total - 配列長 === omitted`）
 * 3. 省略あり / 省略なしの**両方**で content に出ること。LLM は structuredContent を読まない
 */
describe('detect_patterns: cap トリムの申告（#180）', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** cap 未満のケース: 全件返っており、申告も「省略なし」になる。 */
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

	/**
	 * cap 超過のケース。合成 fixture では 200 に届かない（実測: 合成 704 ケースすべて 200 未満）
	 * ので、実データ fixture を `swingDepth: 2` で走らせる。
	 */
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

		// 「省略分はすべて棄却理由」が成り立つ根拠は accepted 優先のトリム順。
		// 返る配列が accepted 先頭に分割されていることを固定しておかないと、content の文言が嘘になる。
		const acceptedFlags = cands.map((c) => !!c.accepted);
		expect(acceptedFlags).toEqual([...acceptedFlags].sort((a, b) => Number(b) - Number(a)));

		const text = formatDebugView('hdr', res.meta, [], res).content[0].text;
		expect(text).toContain(`【Candidates】 200 / 全 ${total} 件（${omitted} 件省略`);
		// このケースは返却分に棄却が残っている（＝accepted は全件収まった）ので、
		// 「省略分はすべて棄却理由」を言い切ってよい側の文言になる。
		expect(cands.some((c) => !c.accepted)).toBe(true);
		expect(text).toContain('accepted は全件残っているため省略分はすべて棄却理由');
	});

	/**
	 * `swings` は先頭から cap 件を残すので、落ちるのは**直近側**（`candidates` と逆）。
	 * 本コーパスでは 200 に届かない（実測: 800 ケースで `swingsTotal` の最大 23）ので、
	 * 「届いていないこと自体」を申告として観測できることを固定する。どちらを残すかの変更は
	 * `debug.swings` の中身が変わるので #180 の対象外。
	 */
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
