import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBtcJpy2026Candles } from '../fixtures/btc_jpy_1day_2026.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';

const mockedAnalyzeIndicators = vi.mocked(analyzeIndicators);
const candles = buildBtcJpy2026Candles();

function indicatorsOk() {
	return {
		ok: true as const,
		summary: 'ok',
		data: { chart: { candles, meta: { pastBuffer: 0 }, indicators: {} } },
		meta: {},
	};
}

async function run(tf: string) {
	mockedAnalyzeIndicators.mockResolvedValue(indicatorsOk() as never);
	const res = await detectPatterns('btc_jpy', tf, 90, {
		includeCompleted: true,
		includeForming: false,
		view: 'debug',
	});
	if (!res.ok) throw new Error('detectPatterns failed');
	return res;
}

const day = (iso?: string) => String(iso).slice(0, 10);

describe('issue #142 dedup の勝者選択 — BTC/JPY 日足 実データ回帰', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	describe('1day の wedge', () => {
		it('形成窓内部の遡及ブレイクだけで完成扱いだった候補は残らない', async () => {
			const res = await run('1day');
			expect(res.data.patterns.filter((p) => p.type.endsWith('_wedge'))).toEqual([]);
		});

		it('旧0.95候補の期間を completed wedge として報告しない', async () => {
			const res = await run('1day');
			const wedges = res.data.patterns
				.filter((p) => p.type.endsWith('_wedge'))
				.map((p) => `${p.type}|${p.confidence}|${day(p.range.start)}|${day(p.range.end)}`)
				.sort();
			expect(wedges).not.toContain('rising_wedge|0.95|2026-06-23|2026-07-13');
			expect(wedges).not.toContain('falling_wedge|0.95|2026-07-08|2026-08-17');
		});
	});

	describe('1hour の triangle_symmetrical', () => {
		it('confidence 0.87 の候補が残り、終端が 2 本新しい 0.86 は残らない', async () => {
			const res = await run('1hour');
			const near = res.data.patterns.filter(
				(p) => p.type === 'triangle_symmetrical' && day(p.range.start) >= '2026-07-20',
			);
			expect(near).toHaveLength(1);
			expect(near[0].confidence).toBe(0.87);
			expect(day(near[0].range.start)).toBe('2026-07-26');
			expect(day(near[0].range.end)).toBe('2026-08-14');
		});
	});

	describe('#133 / PR #135 の不変条件', () => {
		it('横ばい先行の二谷を completed として dedup の対象にしない', async () => {
			mockedAnalyzeIndicators.mockResolvedValue(indicatorsOk() as never);
			const res = await detectPatterns('btc_jpy', '1day', 90, {
				includeCompleted: true,
				includeForming: true,
				view: 'debug',
			});
			if (!res.ok) throw new Error('detectPatterns failed');
			// 構成点 8/3 → 8/10 → 8/14 は先行下降が無いため候補段階で棄却される。
			const doubleBottoms = res.data.patterns.filter((p) => p.type === 'double_bottom');
			expect(doubleBottoms.some((p) => day(p.range.end) === '2026-08-19')).toBe(false);
		});
	});
});
