// Zod の object は未宣言のキーを黙って strip するので、`meta` / `data` に足したフィールドを出力スキーマに宣言し忘れると、parse は成功したままそのフィールドだけが届かない。`parse()` を spy して入力と出力のキーパス集合が一致することを見る（値の一致は見ない）。
// 実際に 1 回走らせて出たキーしか見ないので、経路ごとにフィクスチャを持ち、フィクスチャが空振りしていないことを先にアサートする（`requiredKeys`。#189）。
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import { DetectPatternsOutputSchema } from '../src/schemas.js';
import analyzeIndicators from '../tools/analyze_indicators.js';
import detectPatterns from '../tools/detect_patterns.js';
import { asMockResult } from './_assertResult.js';
import { expectNoStrippedKeys, keyPaths } from './_schemaKeyParity.js';

type Candle = { isoTime: string; open: number; high: number; low: number; close: number; volume: number };

/** 単調な系列だと `debug.candidates` が空になり配列要素のキーを一つも検証できないので、多数の種別の候補が同時に立つ揺れの大きい価格列を使う（`tests/detect_patterns_debug.test.ts` の `buildNoisyCandles` と同じ意図）。 */
function buildNoisyCandles(): Candle[] {
	return Array.from({ length: 120 }, (_, i) => {
		const close = 100 + Math.sin(i / 3) * 12 + Math.cos(i / 7) * 8 + (i % 5);
		return {
			isoTime: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
			open: close,
			high: close + 1 + ((i * 3) % 9),
			low: close - 1 - ((i * 4) % 9),
			close,
			volume: 100,
		};
	});
}

// 右肩からブレイクまでは単調に落とし、間にピボットを作らず（#242 の経路ゲート）肩ゾーン（上限 116.5）にも戻らない。`swingDepth: 3` を明示するのは、1day のオート値 6 ではこの長さで 5 点が立たないため。
/** 完成済み strict H&S を 1 件だけ出す価格列（H&S の 6 軸 `scoreComponents` を踏む）。役割と idx：先行安値 3 / 左肩 7 / 谷1 11 / 頭 15 / 谷2 19 / 右肩 23 / ネックライン下抜け 26。 */
function buildCompletedHsCandles(): Candle[] {
	const closes = [
		90, 88, 86, 84, 92, 100, 110, 120, 112, 105, 101, 100, 108, 120, 132, 140, 130, 115, 105, 100, 106, 113, 118, 120,
		112, 104, 97, 93, 90, 88, 86, 84,
	];
	return closes.map((close, i) => ({
		isoTime: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
		open: close,
		high: close + 3,
		low: close - 3,
		close,
		volume: 100,
	}));
}

// relaxed は strict がその種別を 1 件も見つけられなかったときだけ走るので、3 山を 1000 / 1000 / 958 に置き、山1-山3 の相対差 4.2% を `tolerancePct`（4%）超・`tolerancePct × 1.25`（5%）以内にして、strict を落とし relaxed 第 1 段で拾わせる。
// 山3（idx 42）からの下落は idx 44 で 845 まで落とし、ネックライン 900 をパターン高さの 64% ぶん割らせる（浅いブレイクだと `breakoutQuality` で confidence が `MIN_CONFIDENCE` を割り、relaxed 経路の検証が空振りする）。
function buildRelaxedTripleTopCandles(): Candle[] {
	// [idx, close] のアンカー。区間は線形補間する（単調区間なのでピボットはアンカー上にだけ立つ）。
	const anchors: ReadonlyArray<readonly [number, number]> = [
		[0, 990],
		[10, 850], // 先行安値（構造ゲートの先行上昇の起点 / ネックライン上抜けの証拠）
		[22, 1000], // 山1
		[27, 900], // 谷1
		[32, 1000], // 山2
		[37, 900], // 谷2
		[42, 958], // 山3 — 山1 との相対差 4.2%（strict 4% 超 / relaxed 5% 以内）
		[44, 845], // ネックライン 900 を高さの 64% ぶん割る → completed（上の「ブレイクの深さ」参照）
		[50, 860],
		[60, 880],
	];
	const lastIdx = anchors[anchors.length - 1][0];
	const closes: number[] = [];
	for (let i = 0; i <= lastIdx; i++) {
		let seg = 0;
		while (seg < anchors.length - 2 && anchors[seg + 1][0] < i) seg++;
		const [x0, y0] = anchors[seg];
		const [x1, y1] = anchors[seg + 1];
		closes.push(y0 + ((y1 - y0) * (i - x0)) / (x1 - x0));
	}
	// 高安は終値から上下対称に一定幅にして、ピボット判定（高安基準）と同水準判定（終値基準）で同じ足が極値になるようにする。
	return closes.map((close, i) => ({
		isoTime: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
		open: closes[i - 1] ?? close,
		high: close + 5,
		low: close - 5,
		close,
		volume: 100,
	}));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** spy を張る前の素の `parse`。spy の実装から呼ぶので、bind しておかないと再帰する。 */
const originalParse = DetectPatternsOutputSchema.parse.bind(DetectPatternsOutputSchema);

/** ツール側は import した同じスキーマオブジェクトのメソッドを呼び出し時に解決するので、`DetectPatternsOutputSchema.parse` を spy で差し替えれば素通しで入力と出力を取れる。 */
async function runAndCapture(opts: Record<string, unknown> = {}, candlesOverride?: Candle[]) {
	const candles = candlesOverride ?? buildNoisyCandles();
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({
			ok: true,
			summary: 'ok',
			data: { chart: { candles } },
			// 上流 warning の 2 系統（取得層 = warning / 計算層 = warnings）も meta に載る経路なので、フィクスチャで両方立てておく（落とすとキー比較の対象から外れる）。
			meta: { warning: '取得層: 一部の足が欠損しています', warnings: ['計算層: SMA_200 はデータ不足'] },
		}),
	);

	const captured: { input?: unknown; output?: unknown } = {};
	const spy = vi.spyOn(DetectPatternsOutputSchema, 'parse').mockImplementation((value: unknown) => {
		const parsed = originalParse(value);
		// ツールは最後に 1 回だけ parse する（早期 return の fail 経路は本テストでは通らない）。
		captured.input = value;
		captured.output = parsed;
		return parsed;
	});

	try {
		await detectPatterns('btc_jpy', '1day', candles.length, { includeForming: true, ...opts });
	} finally {
		spy.mockRestore();
	}

	if (!captured.input || !captured.output) throw new Error('parse が呼ばれていない');
	return captured as { input: Record<string, unknown>; output: Record<string, unknown> };
}

function metaOf(result: Record<string, unknown>): Record<string, unknown> {
	const meta = result.meta;
	if (!isPlainObject(meta)) throw new Error('meta がオブジェクトではない');
	return meta;
}

/** `data.patterns[]` 側で既に strip されていると分かっているキー（`_method` は内部フィールドとして意図的に非公開の可能性が高く、`breakout` は公開済みの `breakoutBarIndex` / `confirmation` と重複する）。新しい strip が増えれば落ち、どれかが宣言されたら「実際には strip されていない」で落ちる。 */
const KNOWN_DATA_STRIPS = [
	'patterns[].breakout',
	'patterns[].breakout.idx',
	'patterns[].breakout.price',
	'patterns[]._method',
] as const;

/** parity の対象は `data` オブジェクト全体で、`keyPaths` が配列要素をまたいで合算するので、`patterns[]._fallback` のような配列要素の中の strip もそのまま拾える。 */
function dataOf(result: Record<string, unknown>): Record<string, unknown> {
	const data = result.data;
	if (!isPlainObject(data)) throw new Error('data がオブジェクトではない');
	return data;
}

/** `expectNoStrippedKeys` はそもそも載っていないキーについては何も言わないので、1 つのフィクスチャでしか踏めない経路のフィールドは `requiredKeys` で存在を先に固定する（#189）。 */
const DATA_PARITY_FIXTURES = [
	{
		label: 'noisy（strict 経路中心。relaxed は踏まない）',
		build: buildNoisyCandles,
		// 本フィクスチャで `patterns[].breakout` を持つのは `status: 'invalid'` の `double_top`（83-92-98）だけで既定では `data.patterns` に出ないので、`includeInvalid: true` で経路を戻す（見たいのは parse で strip されないかであって検出の是非ではない）。
		opts: { includeInvalid: true },
		requiredKeys: ['patterns[].confidence', 'patterns[].breakout.idx', 'patterns[]._method'],
	},
	{
		label: '完成済み H&S（strict。6 軸の scoreComponents を踏む唯一の入力）',
		build: buildCompletedHsCandles,
		opts: { swingDepth: 3 },
		// `patterns[]._method` は完成済み経路では載らない（形成中の 6 経路だけが付ける）ので、要求もしないし allowlist からも外す（allowlist は「挙げたのに strip されていない」でも落ちる）。
		knownStrips: KNOWN_DATA_STRIPS.filter((k) => k !== 'patterns[]._method'),
		requiredKeys: [
			'patterns[].confidence',
			'patterns[].breakout.idx',
			// `headProminence` / `timeSymmetry` は H&S にしか付かないので、踏むフィクスチャで別途固定しないと宣言漏れを検出できない。
			'patterns[].scoreComponents.symmetry',
			'patterns[].scoreComponents.headProminence',
			'patterns[].scoreComponents.timeSymmetry',
			'patterns[].scoreComponents.retracement',
			'patterns[].scoreComponents.breakoutQuality',
			'patterns[].scoreComponents.duration',
		],
	},
	{
		label: 'relaxed triple（strict が落ちて relaxed が拾う）',
		build: buildRelaxedTripleTopCandles,
		requiredKeys: [
			'patterns[].confidence',
			'patterns[].breakout.idx',
			'patterns[]._method',
			// ここが false になったら relaxed 経路を踏めておらず、`_fallback` の宣言漏れを検出できなくなる（#189）。
			'patterns[]._fallback',
			// triple の整合度の内訳は double 系の `symmetry` とは別フィールドなので、triple を踏むフィクスチャで別途固定しないと宣言漏れを検出できない（#199）。
			'patterns[].scoreComponents.levelMargin',
			'patterns[].scoreComponents.retracement',
			'patterns[].scoreComponents.breakoutQuality',
			'patterns[].scoreComponents.duration',
		],
	},
] as const;

describe('detect_patterns: meta に載せたキーが出力スキーマで strip されない', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('parse の前後で meta のキーパス集合が一致する', async () => {
		const { input, output } = await runAndCapture();

		// 空集合どうしの一致は何も検証していないのと同じなので、フィクスチャが空振りしていないことを先に固定する。
		const before = keyPaths(metaOf(input));
		expect(before.has('effective_params.tolerancePct.value')).toBe(true);
		expect(before.has('debug.candidates[].type')).toBe(true);
		expect(before.has('debug.swings[].isoTime')).toBe(true);
		// 縮小段の申告（issue #200 要件 E）。
		expect(before.has('reduction.detected')).toBe(true);
		expect(before.has('reduction.tripleHsExcluded')).toBe(true);
		// #224 症状 1。`tripleHsExcluded` の 0 を「比較して該当なし / 比較対象無し」に切り分ける申告。
		expect(before.has('reduction.tripleHsCandidateCount')).toBe(true);
		expect(before.has('reduction.output')).toBe(true);
		expect(before.size).toBeGreaterThan(20);

		expectNoStrippedKeys(metaOf(input), metaOf(output), 'detect_patterns meta');
	});

	it.each(DATA_PARITY_FIXTURES)('parse の前後で data のキーパス集合も一致する（既知の欠落を除く）: $label', async ({
		label,
		build,
		requiredKeys,
		opts,
		knownStrips,
	}: (typeof DATA_PARITY_FIXTURES)[number] & {
		opts?: Record<string, unknown>;
		knownStrips?: readonly string[];
	}) => {
		// `meta` と同じ欠陥は `data` 側でも起こりうる（`data.patterns[]` のフィールドは 40 以上ある）ので、同じヘルパで固定する。
		const { input, output } = await runAndCapture({ ...opts }, build());

		const before = keyPaths(dataOf(input));
		for (const key of requiredKeys) {
			expect(before.has(key), `${label}: ${key} を踏んでいない（フィクスチャが経路に届いていない）`).toBe(true);
		}

		expectNoStrippedKeys(
			dataOf(input),
			dataOf(output),
			`detect_patterns data（${label}）`,
			knownStrips ?? KNOWN_DATA_STRIPS,
		);
	});

	it('relaxed 経路の provenance（_fallback）が parse 後も残る（#189）', async () => {
		// strict で拾えたのか relaxed が拾い直したのかは confidence からは逆算できない（ペナルティ係数が検出器ごとに 0.85 / 0.95 と不揃いで、`finalizeConf` の種別別係数と丸めも通る）。
		const { output } = await runAndCapture({}, buildRelaxedTripleTopCandles());
		const patterns = dataOf(output).patterns as Array<{ type: string; _fallback?: string }>;

		const withFallback = patterns.filter((p) => typeof p._fallback === 'string');
		expect(withFallback.length, 'parse 後に _fallback を持つパターンが 1 件も無い').toBeGreaterThan(0);

		// 値は `relaxed_<検出器>_<段の係数>`（スキーマの `.describe()` が説明している形）。
		for (const p of withFallback) {
			expect(p._fallback, `${p.type} の _fallback`).toMatch(/^relaxed_(double|triple|hs|ihs)_x[\d._]+$/);
		}
		// 2 段とも固定する。第 1 段だけを見ていると、第 2 段だけが退行しても通ってしまう（`detectTriples` の relaxed ループは `[1.25, 2.0]` を順に試す独立した段）。
		expect(patterns.find((p) => p.type === 'triple_top')?._fallback).toBe('relaxed_triple_x1.25');
		// 第 2 段は係数 2.0 だが `${2.0}` は `'2'` なので `x2`。triple_bottom は窓の先頭に先行極値がなく、履歴ゲートで除外される場合がある。
		const relaxedBottom = patterns.find((p) => p.type === 'triple_bottom');
		expect([undefined, 'relaxed_triple_x2']).toContain(relaxedBottom?._fallback);
	});

	it('effective_params の 4 パラメータが value / source ごと生き残る（#184 欠陥 D / A）', async () => {
		const { output } = await runAndCapture();
		const eff = metaOf(output).effective_params as Record<string, { value: number; source: string }>;
		expect(eff).toBeDefined();
		expect(Object.keys(eff).sort()).toEqual([
			'headProminencePct',
			'minBarsBetweenSwings',
			'swingDepth',
			'tolerancePct',
		]);
		for (const [name, entry] of Object.entries(eff)) {
			expect(typeof entry.value, `${name}.value`).toBe('number');
			expect(['auto', 'explicit'], `${name}.source`).toContain(entry.source);
		}
	});

	it('reduction の 8 フィールドが parse 後も残り、waterfall が実データで成立する（issue #200 / #297）', async () => {
		const { output } = await runAndCapture();
		const reduction = metaOf(output).reduction as Record<string, number>;
		expect(reduction).toBeDefined();
		expect(Object.keys(reduction).sort()).toEqual([
			'currentFiltered',
			'dedupMerged',
			'detected',
			'lifecycleExcluded',
			'output',
			'reversalHistoryExcluded',
			'tripleHsCandidateCount',
			'tripleHsExcluded',
		]);
		for (const [name, value] of Object.entries(reduction)) {
			expect(typeof value, name).toBe('number');
		}
		// detected = reversalHistoryExcluded + dedupMerged + currentFiltered + lifecycleExcluded + tripleHsExcluded + output が常に成り立つ。段を足したらこの式も一緒に直すこと（入れ忘れると等式が黙って崩れる）。`tripleHsCandidateCount` は件数の減少ではないので等式の外。
		expect(
			reduction.reversalHistoryExcluded +
				reduction.dedupMerged +
				reduction.currentFiltered +
				reduction.lifecycleExcluded +
				reduction.tripleHsExcluded +
				reduction.output,
		).toBe(reduction.detected);
		// meta.count（= 最終的な data.patterns 件数）と output は同値のはず。
		expect(reduction.output).toBe(metaOf(output).count);
	});

	// `ok()` を返す経路は通常経路と、足が 20 本未満のときの `'insufficient data'` 早期 return の 2 つ。後者に `effective_params` / `reduction` を足し忘れると、candle 本数依存の申告漏れになる（#184 決定事項 1「常に出す」）。
	it("'insufficient data' の早期 return でも effective_params / reduction を申告する", async () => {
		// 20 本未満 → 検出器に入る前に早期 return する
		const few = buildNoisyCandles().slice(0, 15);
		const { input, output } = await runAndCapture({}, few);

		expect(output.summary).toBe('insufficient data');
		const eff = metaOf(output).effective_params as Record<string, { value: number; source: string }>;
		expect(eff, 'insufficient data 経路で effective_params が落ちている').toBeDefined();
		expect(Object.keys(eff).sort()).toEqual([
			'headProminencePct',
			'minBarsBetweenSwings',
			'swingDepth',
			'tolerancePct',
		]);
		// 1day の時間軸オート値。通常経路と同じ解決結果になる。
		expect(eff.swingDepth).toEqual({ value: 6, source: 'auto' });
		expect(eff.tolerancePct).toEqual({ value: 0.04, source: 'auto' });
		// 検出器を一切呼ばない経路なので全段 0（waterfall は 0 = 0 + 0 + 0 + 0 で自明に成立する）。
		const reduction = metaOf(output).reduction as Record<string, number>;
		expect(reduction, 'insufficient data 経路で reduction が落ちている').toBeDefined();
		expect(reduction).toEqual({
			detected: 0,
			reversalHistoryExcluded: 0,
			dedupMerged: 0,
			currentFiltered: 0,
			lifecycleExcluded: 0,
			tripleHsExcluded: 0,
			tripleHsCandidateCount: 0,
			output: 0,
		});
		// 上流の取得層 / 計算層 warning も、検出器を呼ばない早期経路で失われない。
		expect(metaOf(output).warning).toBe('取得層: 一部の足が欠損しています');
		expect(metaOf(output).warnings).toEqual(['計算層: SMA_200 はデータ不足']);
		expectNoStrippedKeys(metaOf(input), metaOf(output), 'detect_patterns meta（insufficient data）');
	});

	it('明示指定したパラメータも parse 後に source=explicit で残る', async () => {
		// sentinel（7 / 5 / 0.04）以外を渡すと explicit になる。auto しか出ないフィクスチャだと `source` の enum が片側しか検証できない。
		const { output } = await runAndCapture({ swingDepth: 4, tolerancePct: 0.07, headProminencePct: 0.02 });
		const eff = metaOf(output).effective_params as Record<string, { value: number; source: string }>;
		expect(eff.swingDepth).toEqual({ value: 4, source: 'explicit' });
		expect(eff.tolerancePct).toEqual({ value: 0.07, source: 'explicit' });
		expect(eff.headProminencePct).toEqual({ value: 0.02, source: 'explicit' });
		// 渡していないものは時間軸オート（1day = 4）のまま
		expect(eff.minBarsBetweenSwings).toEqual({ value: 4, source: 'auto' });
	});
});
