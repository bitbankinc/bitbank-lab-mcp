import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../tools/get_volatility_metrics.js', () => ({
	default: vi.fn(),
	// Handler が description 文字列で参照するため named export も mock に含める
	WILDER_ATR_PERIOD: 14,
}));

import {
	buildVolatilityBeginnerText,
	buildVolatilityDetailedText,
	buildVolatilitySummaryText,
	prependVolWarning,
	toolDef,
	type VolDetailedInput,
	type VolViewInput,
} from '../../src/handlers/getVolatilityMetricsHandler.js';
import getVolatilityMetrics from '../../tools/get_volatility_metrics.js';

const mockedGetVolatilityMetrics = vi.mocked(getVolatilityMetrics);

afterEach(() => {
	vi.clearAllMocks();
});

// ─── 共通フィクスチャ ─────────────────────────────────────────────────────────

function makeViewInput(overrides: Partial<VolViewInput> = {}): VolViewInput {
	return {
		pair: 'btc_jpy',
		type: '1day',
		lastClose: 10_000_000,
		ann: true,
		annFactor: Math.sqrt(365),
		annFactorFull: Math.sqrt(365),
		sampleSize: 100,
		rvAnn: 0.6,
		pkAnn: 0.55,
		gkAnn: 0.58,
		rsAnn: 0.52,
		atrAbs: 300_000,
		atrPct: 0.03,
		tagsAll: ['high_vol'],
		rolling: [
			{ window: 7, rv_std: 0.03, rv_std_ann: 0.57 },
			{ window: 30, rv_std: 0.028, rv_std_ann: 0.53 },
		],
		...overrides,
	};
}

// ─── buildVolatilityBeginnerText ──────────────────────────────────────────────

describe('buildVolatilityBeginnerText', () => {
	it('ペア名と時間軸が含まれる', () => {
		const text = buildVolatilityBeginnerText(makeViewInput());
		expect(text).toContain('BTC_JPY');
		expect(text).toContain('[1day]');
	});

	it('年間の動き・1日の動きのラベルが含まれる', () => {
		const text = buildVolatilityBeginnerText(makeViewInput());
		expect(text).toContain('年間のおおよその動き');
		expect(text).toContain('1日の平均的な動き');
	});

	it('tagsAll が空のときタグ行が出ない', () => {
		const text = buildVolatilityBeginnerText(makeViewInput({ tagsAll: [] }));
		expect(text).not.toContain('今の傾向');
	});

	it('tagsAll がある時タグ行が出る', () => {
		const text = buildVolatilityBeginnerText(makeViewInput({ tagsAll: ['high_vol', 'expanding_vol'] }));
		expect(text).toContain('今の傾向');
		expect(text).toContain('high vol');
	});
});

// ─── buildVolatilitySummaryText ───────────────────────────────────────────────

describe('buildVolatilitySummaryText', () => {
	it('全メトリクス（RV/ATR/PK/GK/RS）が含まれる', () => {
		const text = buildVolatilitySummaryText(makeViewInput());
		expect(text).toContain('RV=');
		expect(text).toContain('ATR=');
		expect(text).toContain('PK=');
		expect(text).toContain('GK=');
		expect(text).toContain('RS=');
	});

	it('Tags が含まれる', () => {
		const text = buildVolatilitySummaryText(makeViewInput({ tagsAll: ['low_vol'] }));
		expect(text).toContain('Tags: low_vol');
	});

	it('sampleSize が含まれる', () => {
		const text = buildVolatilitySummaryText(makeViewInput({ sampleSize: 200 }));
		expect(text).toContain('samples=200');
	});
});

// ─── buildVolatilityDetailedText ─────────────────────────────────────────────

describe('buildVolatilityDetailedText', () => {
	function makeDetailed(overrides: Partial<VolDetailedInput> = {}): VolDetailedInput {
		return {
			...makeViewInput(),
			series: {
				ts: [1700000000000, 1700086400000],
				close: [9_900_000, 10_000_000],
				ret: [0.01, 0.005],
			},
			...overrides,
		};
	}

	it('detailed view: Volatility Metrics ブロックが出る', () => {
		const text = buildVolatilityDetailedText(makeDetailed(), 'detailed');
		expect(text).toContain('Volatility Metrics');
		expect(text).toContain('RV (std)');
		expect(text).toContain('Parkinson');
	});

	it('detailed view: Rolling Trends ブロックが出る', () => {
		const text = buildVolatilityDetailedText(makeDetailed(), 'detailed');
		expect(text).toContain('Rolling Trends');
		expect(text).toContain('7-day RV');
		expect(text).toContain('30-day RV');
	});

	it('full view: Series ブロックが追加される', () => {
		const text = buildVolatilityDetailedText(makeDetailed(), 'full');
		expect(text).toContain('Series');
		expect(text).toContain('Total:');
	});

	it('detailed view: Series ブロックが出ない', () => {
		const text = buildVolatilityDetailedText(makeDetailed(), 'detailed');
		expect(text).not.toContain('【Series】');
	});

	it('ローリングウィンドウのトレンド矢印が含まれる', () => {
		const text = buildVolatilityDetailedText(makeDetailed(), 'detailed');
		// 短期(7d)の rv_std_ann=0.57 > 長期(30d)の rv_std_ann=0.53 → ⬆ か ⬆⬆
		expect(text).toMatch(/7-day RV:.*⬆/);
	});

	it('annualize=false の場合ラベルに (annualized) が付かない', () => {
		const text = buildVolatilityDetailedText(makeDetailed({ ann: false }), 'detailed');
		expect(text).not.toContain('(annualized)');
	});
});

// ─── handler: タグ導出ロジック ────────────────────────────────────────────────

describe('toolDef handler - タグ導出', () => {
	function mockVolRes(opts: {
		rvStd?: number;
		rvStdAnn?: number;
		rolling?: Array<{ window: number; rv_std: number; rv_std_ann?: number }>;
		tags?: string[];
	}) {
		return {
			ok: true,
			summary: 'ok',
			data: {
				aggregates: {
					rv_std: opts.rvStd ?? 0.03,
					rv_std_ann: opts.rvStdAnn,
					atr: 300_000,
				},
				rolling: opts.rolling ?? [
					{ window: 7, rv_std: 0.03, rv_std_ann: 0.57 },
					{ window: 30, rv_std: 0.028, rv_std_ann: 0.53 },
				],
				tags: opts.tags ?? [],
				series: {
					ts: [1700000000000],
					close: [10_000_000],
					ret: [0.01],
				},
				meta: {
					annualize: true,
					baseIntervalMs: 86_400_000,
					sampleSize: 100,
				},
			},
			meta: {},
		};
	}

	it('short RV > long RV × 1.05 → expanding_vol タグが追加される', async () => {
		mockedGetVolatilityMetrics.mockResolvedValueOnce(
			mockVolRes({
				rolling: [
					{ window: 7, rv_std: 0.04, rv_std_ann: 0.76 }, // 短期高い
					{ window: 30, rv_std: 0.028, rv_std_ann: 0.53 }, // 長期低い
				],
			}) as never,
		);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 100, view: 'summary' });
		const sc = (res as { structuredContent: { data: { tags: string[] } } }).structuredContent;
		expect(sc.data.tags).toContain('expanding_vol');
	});

	it('short RV < long RV × 0.95 → contracting_vol タグが追加される', async () => {
		mockedGetVolatilityMetrics.mockResolvedValueOnce(
			mockVolRes({
				rolling: [
					{ window: 7, rv_std: 0.01, rv_std_ann: 0.19 }, // 短期低い
					{ window: 30, rv_std: 0.04, rv_std_ann: 0.76 }, // 長期高い
				],
			}) as never,
		);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 100, view: 'summary' });
		const sc = (res as { structuredContent: { data: { tags: string[] } } }).structuredContent;
		expect(sc.data.tags).toContain('contracting_vol');
	});

	it('rvAnnForTags > 0.5 → high_vol タグが追加される', async () => {
		mockedGetVolatilityMetrics.mockResolvedValueOnce(mockVolRes({ rvStdAnn: 0.6 }) as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 100, view: 'summary' });
		const sc = (res as { structuredContent: { data: { tags: string[] } } }).structuredContent;
		expect(sc.data.tags).toContain('high_vol');
	});

	it('rvAnnForTags < 0.2 → low_vol タグが追加される', async () => {
		mockedGetVolatilityMetrics.mockResolvedValueOnce(mockVolRes({ rvStdAnn: 0.1 }) as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 100, view: 'summary' });
		const sc = (res as { structuredContent: { data: { tags: string[] } } }).structuredContent;
		expect(sc.data.tags).toContain('low_vol');
	});

	it('annualize=false でも tags は年率換算値で判定される（annFactorFull を使用）', async () => {
		// rv_std=0.03 で baseIntervalMs=1day → annFactorFull=sqrt(365)≈19.1
		// rv_std_ann = 0.03 * 19.1 ≈ 0.573 > 0.5 → high_vol
		mockedGetVolatilityMetrics.mockResolvedValueOnce(mockVolRes({ rvStd: 0.03, rvStdAnn: undefined }) as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 100, annualize: false, view: 'summary' });
		const sc = (res as { structuredContent: { data: { tags: string[] } } }).structuredContent;
		expect(sc.data.tags).toContain('high_vol');
	});
});

// ─── handler: ビュー切り替え ──────────────────────────────────────────────────

describe('toolDef handler - view routing', () => {
	function mockOkRes() {
		// 実際の get_volatility_metrics が buildVolatilityMetricsText で生成する
		// summary を模した文字列。view=summary 経路が res.summary をそのまま
		// content に流すようになったため、aggregates と rolling 行を含めておく。
		const summary = [
			'BTC/JPY [1day] 5,000,000円 rv=0.380(ann)',
			'',
			'aggregates: rv_std:0.022 rv_std_ann:0.38 parkinson:0.018 garmanKlass:0.016 rogersSatchell:0.012 atr:200000',
			'',
			'📊 ローリング分析:',
			'w=7 rv:0.022000 ann:0.420000 pk:0.018000',
			'w=30 rv:0.019000 ann:0.360000 pk:0.016000',
			'',
			'---',
			'📌 含まれるもの: ボラティリティ指標（RV・Parkinson・GK・RS・ATR）、ローリング分析',
		].join('\n');
		return {
			ok: true,
			summary,
			data: {
				aggregates: { rv_std: 0.02, rv_std_ann: 0.38, atr: 200_000 },
				rolling: [
					{ window: 7, rv_std: 0.022, rv_std_ann: 0.42 },
					{ window: 30, rv_std: 0.019, rv_std_ann: 0.36 },
				],
				tags: [],
				series: {
					ts: [1700000000000],
					close: [5_000_000],
					ret: [0.005],
				},
				meta: {
					annualize: true,
					baseIntervalMs: 86_400_000,
					sampleSize: 50,
				},
			},
			meta: {},
		};
	}

	it('view=beginner のテキストには 1日の平均的な動き が含まれる', async () => {
		mockedGetVolatilityMetrics.mockResolvedValueOnce(mockOkRes() as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 50, view: 'beginner' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('1日の平均的な動き');
	});

	it('view=summary のテキストには aggregates と rolling 情報が含まれる', async () => {
		const mock = mockOkRes();
		mockedGetVolatilityMetrics.mockResolvedValueOnce(mock as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 50, view: 'summary' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		// passthrough: handler は上流 summary をそのまま流す（一行要約に加工しない）
		expect(text).toBe(mock.summary);
		expect(text).toContain('aggregates:');
		expect(text).toContain('📊 ローリング分析:');
	});

	it('view=summary (default) で rolling window 別 RV / Parkinson が content に含まれる', async () => {
		mockedGetVolatilityMetrics.mockResolvedValueOnce(mockOkRes() as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 50, view: 'summary' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		// rolling window 行（複数 window）
		expect(text).toContain('w=7 rv:');
		expect(text).toContain('w=30 rv:');
		// rolling 行は Parkinson を含み、ATR は含まない
		expect(text).toMatch(/w=\d+.*pk:[\d.]+/);
		const rollingSection = text.split('📊 ローリング分析:')[1] ?? '';
		expect(rollingSection).not.toMatch(/w=\d+.*atr:/);
	});

	it('view=detailed のテキストには Rolling Trends が含まれる', async () => {
		mockedGetVolatilityMetrics.mockResolvedValueOnce(mockOkRes() as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 50, view: 'detailed' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('Rolling Trends');
	});

	it('view=full のテキストには Series が含まれる', async () => {
		mockedGetVolatilityMetrics.mockResolvedValueOnce(mockOkRes() as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 50, view: 'full' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('Series');
	});

	it('res.ok=false はそのまま返す', async () => {
		mockedGetVolatilityMetrics.mockResolvedValueOnce({ ok: false, summary: 'err' } as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 50 });
		expect((res as { ok: boolean }).ok).toBe(false);
	});
});

// ─── handler: 上流 / 自前 warning の content 伝播 ─────────────────────────────

describe('toolDef handler - meta.warning propagation', () => {
	function mockResWithWarning(warning?: string) {
		// 上流 (vol tool) が summary 先頭に warning を連結済みのケース。
		const body = [
			'BTC/JPY [1day] 5,000,000円 rv=0.380(ann)',
			'',
			'aggregates: rv_std:0.022 rv_std_ann:0.38 parkinson:0.018 garmanKlass:0.016 rogersSatchell:0.012 atr:200000',
			'',
			'📊 ローリング分析:',
			'w=7 rv:0.022000 ann:0.420000 pk:0.018000',
			'w=30 rv:0.019000 ann:0.360000 pk:0.016000',
		].join('\n');
		const summary = warning ? `${warning}\n${body}` : body;
		return {
			ok: true,
			summary,
			data: {
				aggregates: { rv_std: 0.02, rv_std_ann: 0.38, atr: 200_000 },
				rolling: [
					{ window: 7, rv_std: 0.022, rv_std_ann: 0.42 },
					{ window: 30, rv_std: 0.019, rv_std_ann: 0.36 },
				],
				tags: [],
				series: { ts: [1700000000000], close: [5_000_000], ret: [0.005] },
				meta: { annualize: true, baseIntervalMs: 86_400_000, sampleSize: 50 },
			},
			meta: warning ? { warning } : {},
		};
	}

	it('view=summary: 上流 summary に warning が含まれていれば handler content にもそのまま出る', async () => {
		const warning = '⚠️ 4年中1年の取得に失敗しました。';
		mockedGetVolatilityMetrics.mockResolvedValueOnce(mockResWithWarning(warning) as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 50, view: 'summary' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text.startsWith('⚠️')).toBe(true);
		expect(text).toContain('4年中1年の取得に失敗');
	});

	it('view=beginner: meta.warning が content[0].text の先頭に出る', async () => {
		const warning = '⚠️ 3件の不正な OHLC をスキップしました。';
		mockedGetVolatilityMetrics.mockResolvedValueOnce(mockResWithWarning(warning) as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 50, view: 'beginner' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text.startsWith('⚠️')).toBe(true);
		expect(text).toContain('3件の不正な OHLC');
		// 警告行のあとに本文（beginner 用テキスト）が続く
		const idxWarning = text.indexOf('⚠️');
		const idxBody = text.indexOf('1日の平均的な動き');
		expect(idxWarning).toBeLessThan(idxBody);
	});

	it('view=detailed: meta.warning が content[0].text の先頭に出る', async () => {
		const warning = '⚠️ 2件の isoTime 欠損ローソク足をスキップしました。';
		mockedGetVolatilityMetrics.mockResolvedValueOnce(mockResWithWarning(warning) as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 50, view: 'detailed' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text.startsWith('⚠️')).toBe(true);
		expect(text).toContain('2件の isoTime 欠損');
		// 警告行のあとに本文が続く
		const idxWarning = text.indexOf('⚠️');
		const idxBody = text.indexOf('Volatility Metrics');
		expect(idxWarning).toBeLessThan(idxBody);
	});

	it('view=full: meta.warning が content[0].text の先頭に出る', async () => {
		const warning = '⚠️ 上流 fetchWarning と自前スキップが混在';
		mockedGetVolatilityMetrics.mockResolvedValueOnce(mockResWithWarning(warning) as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 50, view: 'full' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text.startsWith('⚠️')).toBe(true);
		expect(text).toContain('上流 fetchWarning と自前スキップが混在');
	});

	it('meta.warning が無い場合は beginner/detailed view content に ⚠️ が出ない', async () => {
		mockedGetVolatilityMetrics.mockResolvedValueOnce(mockResWithWarning(undefined) as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 50, view: 'beginner' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text.startsWith('⚠️')).toBe(false);
	});
});

// ─── handler: 形成中足（meta.provisional）注記の content 伝播 ─────────────────

describe('toolDef handler - meta.provisional 注記', () => {
	function mockResProvisional(provisional?: boolean) {
		const body = [
			'BTC/JPY [1day] 5,000,000円 rv=0.380(ann)',
			'',
			'aggregates: rv_std:0.022 rv_std_ann:0.38 parkinson:0.018 garmanKlass:0.016 rogersSatchell:0.012 atr:200000',
		].join('\n');
		// summary view 用: tool が summary 先頭に注記を連結済みのケースを模す。
		const summary = provisional ? `ℹ️ 最新足は未確定（形成中）です。\n${body}` : body;
		return {
			ok: true,
			summary,
			data: {
				aggregates: { rv_std: 0.02, rv_std_ann: 0.38, atr: 200_000 },
				rolling: [
					{ window: 7, rv_std: 0.022, rv_std_ann: 0.42 },
					{ window: 30, rv_std: 0.019, rv_std_ann: 0.36 },
				],
				tags: [],
				series: { ts: [1700000000000], close: [5_000_000], ret: [0.005] },
				meta: { annualize: true, baseIntervalMs: 86_400_000, sampleSize: 50 },
			},
			meta: provisional ? { provisional: true } : {},
		};
	}

	it('view=beginner: meta.provisional=true で「未確定（形成中）」注記が content に出る', async () => {
		mockedGetVolatilityMetrics.mockResolvedValueOnce(mockResProvisional(true) as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 50, view: 'beginner' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('未確定（形成中）');
		const idxNote = text.indexOf('未確定（形成中）');
		const idxBody = text.indexOf('1日の平均的な動き');
		expect(idxNote).toBeGreaterThanOrEqual(0);
		expect(idxNote).toBeLessThan(idxBody);
	});

	it('view=detailed: meta.provisional=true で注記が content に出る', async () => {
		mockedGetVolatilityMetrics.mockResolvedValueOnce(mockResProvisional(true) as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 50, view: 'detailed' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('未確定（形成中）');
	});

	it('view=summary: 上流 summary の注記がそのまま content に出る', async () => {
		mockedGetVolatilityMetrics.mockResolvedValueOnce(mockResProvisional(true) as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 50, view: 'summary' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).toContain('未確定（形成中）');
	});

	it('meta.provisional 未設定なら注記は出ない', async () => {
		mockedGetVolatilityMetrics.mockResolvedValueOnce(mockResProvisional(undefined) as never);
		const res = await toolDef.handler({ pair: 'btc_jpy', type: '1day', limit: 50, view: 'beginner' });
		const text = (res as { content: Array<{ text: string }> }).content[0].text;
		expect(text).not.toContain('未確定（形成中）');
	});
});

// ─── prependVolWarning ユニットテスト ─────────────────────────────────────────

describe('prependVolWarning', () => {
	it('meta.warning を body の先頭に別行で連結する', () => {
		const text = prependVolWarning('BODY', { warning: '⚠️ 3件の不正な OHLC をスキップしました。' });
		expect(text.startsWith('⚠️ 3件の不正な OHLC')).toBe(true);
		expect(text).toContain('\n\nBODY');
	});

	it('⚠️ プレフィックスがなければ自動で付ける', () => {
		const text = prependVolWarning('BODY', { warning: 'partial fetch' });
		expect(text.startsWith('⚠️ partial fetch')).toBe(true);
	});

	it('meta.warning が無ければ body をそのまま返す', () => {
		expect(prependVolWarning('BODY', {})).toBe('BODY');
		expect(prependVolWarning('BODY', { warning: undefined })).toBe('BODY');
	});
});
