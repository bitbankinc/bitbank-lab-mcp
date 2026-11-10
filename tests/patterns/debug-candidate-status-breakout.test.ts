import { describe, expect, it, vi } from 'vitest';
import { asMockResult, assertOk } from '../_assertResult.js';

vi.mock('../../tools/analyze_indicators.js', () => ({
	default: vi.fn(),
}));

import { formatDebugView } from '../../src/handlers/detectPatternsDebugView.js';
import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
import { buildBtcJpy2026Candles } from '../fixtures/btc_jpy_1day_2026.js';

type Candle = { isoTime: string; open: number; high: number; low: number; close: number; volume: number };

/** close に対して high/low を等幅にずらす（本テストは価格構造そのものを見ない）。 */
function makeCandle(dayOffset: number, close: number): Candle {
	return {
		isoTime: new Date(Date.UTC(2026, 0, 1 + dayOffset)).toISOString(),
		open: close,
		high: close + 3,
		low: close - 3,
		close,
		volume: 100,
	};
}

function fromCloses(closes: number[]): Candle[] {
	return closes.map((close, index) => makeCandle(index, close));
}

/** tests/detect_patterns_fixtures.test.ts の同名 fixture と同じ価格列 */
const SYMMETRICAL_TRIANGLE_CLOSES = [
	120, 126, 132, 137, 130, 122, 116, 110, 104, 100, 106, 114, 120, 128, 134, 128, 120, 115, 108, 104, 110, 118, 124,
	130, 126, 120, 116, 112, 108, 114, 120, 126, 124, 120, 117, 114,
];
/** ブレイクアウトまで含む三角保ち合い（`buildDescendingTriangleInvalidBreakoutCandles` と同じ価格列） */
const BREAKOUT_TRIANGLE_CLOSES = [
	130, 140, 132, 122, 100, 118, 120, 130, 124, 116, 100, 112, 125, 118, 101, 110, 120, 114, 100, 108, 115, 110, 101,
	107, 128, 132, 130, 128, 126, 124,
];
const BULL_PENNANT_CLOSES = [
	100, 110, 122, 136, 150, 165, 158, 162, 154, 160, 155, 159, 156, 158, 157, 157.8, 157.2, 158.1, 157.4, 170, 172, 174,
];
const RISING_WEDGE_CLOSES = [
	100, 106, 112, 118, 124, 130, 119, 108, 113, 118, 124, 129, 134, 125, 116, 120, 125, 129, 134, 138, 131, 124, 128,
	131, 135, 138, 142, 137, 132, 135, 138, 140, 143, 146, 143,
];

type Candidate = {
	type: string;
	accepted: boolean;
	reason?: string;
	status?: string;
	breakoutDirection?: string | null;
	details?: Record<string, unknown>;
};

const mockedAnalyzeIndicators = vi.mocked(analyzeIndicators);

async function run(candles: Candle[], opts: Record<string, unknown> = {}) {
	mockedAnalyzeIndicators.mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	return detectPatterns('btc_jpy', '1day', candles.length, { includeForming: true, ...opts });
}

/** 候補行（`1. ✅ type …`）だけを取り出す。details 行と混ざると「どこに出たか」が見えない。 */
function candidateHeaderLines(text: string, type: string): string[] {
	return text.split('\n').filter((l) => new RegExp(`^\\d+\\. (✅|❌) ${type}\\b`).test(l));
}

function debugText(res: Parameters<typeof formatDebugView>[3] & { meta?: unknown }): string {
	return formatDebugView('hdr', (res.meta ?? {}) as never, [], res).content[0].text;
}

describe('debug candidates: status / breakoutDirection の配線（issue #160）', () => {
	it('triangle の status は content から消えず、候補行に 1 回だけ出る（details 行には出さない）', async () => {
		const res = await run(fromCloses(SYMMETRICAL_TRIANGLE_CLOSES), { patterns: ['triangle'] });
		assertOk(res);
		const cands = (res.meta.debug?.candidates ?? []) as Candidate[];
		const detected = cands.filter((c) => c.accepted && c.reason === 'detected');
		expect(detected.length).toBeGreaterThan(0);
		for (const c of detected) expect(typeof c.details?.status).toBe('string');

		const text = debugText(res);
		const headers = candidateHeaderLines(text, 'triangle_symmetrical').filter((l) => l.includes('(detected)'));
		expect(headers.length).toBe(detected.length);
		for (const l of headers) expect(l).toMatch(/ status=(completed|invalid|forming|near_completion)\b/);

		expect(text).toContain('touchCount: ');
		expect(text).not.toMatch(/touchCount: [^\n]*status/);
		for (const l of text.split('\n')) expect(l.match(/status=/g)?.length ?? 0).toBeLessThanOrEqual(1);
	});

	it('triangle の breakoutDirection が候補行に出る（details.breakout.direction 由来）', async () => {
		const res = await run(fromCloses(BREAKOUT_TRIANGLE_CLOSES), { patterns: ['triangle'] });
		assertOk(res);
		const cands = (res.meta.debug?.candidates ?? []) as Candidate[];
		const withBreakout = cands.filter((c) => (c.details?.breakout as { direction?: string } | null)?.direction != null);
		expect(withBreakout.length).toBeGreaterThan(0);
		for (const c of withBreakout) expect(c.breakoutDirection).toBeUndefined();

		const text = debugText(res);
		const dirLines = text.split('\n').filter((l) => /^\d+\. .* breakoutDirection=(up|down)\b/.test(l));
		expect(dirLines.length).toBe(withBreakout.length);
	});

	it('pennant / flag の status と breakoutDirection が候補行に出る', async () => {
		const res = await run(fromCloses(BULL_PENNANT_CLOSES), { patterns: ['pennant'] });
		assertOk(res);
		const cands = (res.meta.debug?.candidates ?? []) as Candidate[];
		const detected = cands.filter((c) => c.accepted && c.reason === 'detected');
		expect(detected.length).toBeGreaterThan(0);

		const text = debugText(res);
		const headers = candidateHeaderLines(text, 'bull_pennant').filter((l) => l.includes('(detected)'));
		expect(headers.length).toBeGreaterThan(0);
		for (const l of headers) {
			expect(l).toMatch(/ status=(completed|invalid|forming|near_completion)\b/);
			expect(l).toMatch(/ breakoutDirection=(up|down)\b/);
		}
	});

	it('wedge の status / breakoutDirection は top-level にあり、候補行に出る', async () => {
		const res = await run(fromCloses(RISING_WEDGE_CLOSES), { patterns: ['rising_wedge', 'falling_wedge'] });
		assertOk(res);
		const cands = (res.meta.debug?.candidates ?? []) as Candidate[];
		const accepted = cands.filter((c) => c.accepted);
		expect(accepted.length).toBeGreaterThan(0);
		// スキーマに宣言が無いと parse で strip されるので、ここが落ちたら schema/patterns.ts の candidates を疑う。
		for (const c of accepted) expect(typeof c.status).toBe('string');

		const text = debugText(res);
		const headers = candidateHeaderLines(text, 'rising_wedge').filter((l) => l.includes('✅'));
		expect(headers.length).toBeGreaterThan(0);
		for (const l of headers) expect(l).toMatch(/ status=(completed|invalid|forming|near_completion)\b/);
	});

	it('横ばい先行の形成中 H&S は候補行で trend mismatch として出る', async () => {
		// #155 の実データ fixture は横ばい先行なので、方向ゲートで成功候補にしない。
		const res = await run(buildBtcJpy2026Candles() as Candle[], {
			patterns: ['head_and_shoulders', 'inverse_head_and_shoulders'],
			headProminencePct: 0.01,
			includeCompleted: true,
			includeInvalid: true,
		});
		assertOk(res);
		const cands = (res.meta.debug?.candidates ?? []) as Candidate[];
		const forming = cands.filter((c) => c.accepted && c.status === 'forming');
		expect(forming).toHaveLength(0);

		const text = debugText(res);
		expect(cands.some((c) => c.reason === 'prior_trend_mismatch:sideways')).toBe(true);
		expect(text).toContain('prior_trend_mismatch:sideways');
	});
});

describe('formatDebugView: status / breakoutDirection の解決規則', () => {
	const res = { ok: true as const, summary: 'debug', data: { patterns: [], overlays: null }, meta: {} };
	// biome-ignore lint/suspicious/noExplicitAny: test fixture
	const meta = (candidates: any[]) => ({ debug: { swings: [], candidates } });

	it('top-level と details のどちらに置かれていても同じ書式で出る', () => {
		const text = formatDebugView(
			'hdr',
			meta([
				{ type: 'rising_wedge', accepted: true, status: 'forming', breakoutDirection: 'up' },
				{
					type: 'triangle_ascending',
					accepted: true,
					reason: 'detected',
					details: { status: 'completed', breakout: { idx: 12, direction: 'down' }, touchCount: 5 },
				},
			]),
			[],
			res,
		).content[0].text;

		expect(text).toContain('rising_wedge status=forming breakoutDirection=up');
		expect(text).toContain('triangle_ascending (detected) status=completed breakoutDirection=down');
	});

	it('top-level が details より優先される（両方あるとき 1 回だけ出る）', () => {
		const text = formatDebugView(
			'hdr',
			meta([
				{
					type: 'triangle_ascending',
					accepted: true,
					reason: 'detected',
					status: 'forming',
					breakoutDirection: 'up',
					details: { status: 'completed', breakout: { idx: 3, direction: 'down' }, touchCount: 4 },
				},
			]),
			[],
			res,
		).content[0].text;

		const header = text.split('\n').find((l) => l.startsWith('1. ')) ?? '';
		expect(header).toContain('status=forming');
		expect(header).toContain('breakoutDirection=up');
		expect(header).not.toContain('completed');
		expect(header.match(/status=/g)).toHaveLength(1);
	});

	it('top-level の breakoutDirection: null は details 側で上書きされない', () => {
		const text = formatDebugView(
			'hdr',
			meta([
				{
					type: 'rising_wedge',
					accepted: true,
					status: 'forming',
					breakoutDirection: null,
					details: { breakout: { idx: 7, direction: 'down' } },
				},
			]),
			[],
			res,
		).content[0].text;

		const header = text.split('\n').find((l) => l.startsWith('1. ')) ?? '';
		expect(header).toContain('rising_wedge status=forming');
		expect(header).not.toContain('breakoutDirection=');
	});

	it('未ブレイク（breakout: null / breakoutDirection: null）では breakoutDirection 行を出さない', () => {
		const text = formatDebugView(
			'hdr',
			meta([
				{ type: 'falling_wedge', accepted: true, status: 'forming', breakoutDirection: null },
				{
					type: 'bull_pennant',
					accepted: true,
					reason: 'detected',
					details: { status: 'forming', breakout: null, touchCount: 6 },
				},
				// details 自体が無い候補でも落ちない
				{ type: 'head_and_shoulders', accepted: true, status: 'forming' },
			]),
			[],
			res,
		).content[0].text;

		expect(text).not.toContain('breakoutDirection=');
		expect(text).toContain('falling_wedge status=forming');
		expect(text).toContain('bull_pennant (detected) status=forming');
		expect(text).toContain('head_and_shoulders status=forming');
	});

	it('status も breakoutDirection も無い候補では余計な語を出さない', () => {
		const text = formatDebugView(
			'hdr',
			meta([{ type: 'double_top', accepted: false, reason: 'head_not_higher' }]),
			[],
			res,
		).content[0].text;

		expect(text).toContain('❌ double_top [head_not_higher]');
		expect(text).not.toContain('status=');
		expect(text).not.toContain('breakoutDirection=');
	});

	it('凡例が ✅ 側の status の意味も説明する', () => {
		const text = formatDebugView('hdr', meta([]), [], res).content[0].text;
		expect(text).toContain('候補段階の棄却');
		expect(text).toContain('✅ の status = 候補を組み立てた時点の状態');
	});
});
