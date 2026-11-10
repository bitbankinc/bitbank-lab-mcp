// 表示層だけを直したつもりで検出器側の数え方（初到達 vs 極値）がずれたら落ちるよう、実データ B（365 本・既定パラメータ）で到達済み / 未到達の行を本数・日時込みで固定する（#288 Phase 2）。
// 期待値は `data.patterns` のベースライン（`tests/fixtures/detect_patterns_1hour_data_patterns_baseline.json`）と同じ呼び出しから出る。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asMockResult, assertOk } from '../_assertResult.js';
import { detectPatternsContent } from '../helpers/detect-patterns.js';

vi.mock('../../tools/analyze_indicators.js', () => ({ default: vi.fn() }));

import analyzeIndicators from '../../tools/analyze_indicators.js';
import detectPatterns from '../../tools/detect_patterns.js';
import { buildBtcJpy1hour202608Candles } from '../fixtures/btc_jpy_1hour_2026_08.js';

afterEach(() => {
	vi.restoreAllMocks();
});

function liveContent(view: string): Promise<string> {
	return detectPatternsContent(buildBtcJpy1hour202608Candles(), { view });
}

/** `   - ターゲット: …` 行だけを取り出す（`ターゲット価格:` 行とは別）。 */
function targetLines(text: string): string[] {
	return text.split('\n').filter((line) => line.startsWith('   - ターゲット: '));
}

const TARGET_LABEL = '   - ターゲット: ';

describe('#288 Phase 2 のターゲット行（実データ B / 365 本 / 既定パラメータ）', () => {
	// `formatPatternLine` を呼ぶのは階梯上の 2 view（`summary` は明細を列挙しない）で、`detailed` は上位 5 件までなので、全 10 件が並ぶのは `full` だけ。

	it('view=full: 到達済みの triangle が初到達の本数と日時を出す', async () => {
		const text = await liveContent('full');
		expect(text).toContain(`${TARGET_LABEL}到達（ブレイク後 47 本目、2026-08-19 23:00）`);
	});

	it('view=full: 別の到達済み triangle も初到達日時を分まで出す', async () => {
		const text = await liveContent('full');
		expect(text).toContain(`${TARGET_LABEL}到達（ブレイク後 16 本目、2026-08-21 09:00）`);
	});

	it('view=full: 未到達（走査完了）は接近度だけを出す', async () => {
		const text = await liveContent('full');
		// ブレイク足 idx=297。系列末尾まで 67 本あるので走査は上限の 60 本で完了。
		expect(text).toContain(`${TARGET_LABEL}未到達（走査 60 本完了、目標幅の 7% まで接近）`);
	});

	it('view=full: 期待と逆向きに抜けた wedge は標準ターゲットを出さない', async () => {
		const text = await liveContent('full');
		expect(text).toContain(
			`${TARGET_LABEL}出力なし（期待方向と逆のブレイクで、標準的なパターン目標値を適用しないため）`,
		);
	});

	it('view=full: 履歴不足で除外された反転候補は交絡対象にも残らない', async () => {
		const text = await liveContent('full');
		expect(text).toContain(`${TARGET_LABEL}到達（ブレイク後 47 本目、2026-08-19 23:00）`);
		expect(text).not.toContain('inverse_head_and_shoulders 上方 +3 本');
		expect(text).not.toContain('triple_bottom 上方 +42 本');
		// 反転候補は履歴不足段で除外されるため、残る交絡は rising_wedge の 1 件だけ。
		const lines = targetLines(text);
		expect(lines).toHaveLength(6);
		expect(lines.filter((l) => l.includes('ブレイクあり（'))).toHaveLength(1);
	});

	it.each(['detailed', 'full'])('view=%s: ターゲット行に 100 以上の百分率が 1 つも出ない', async (view) => {
		const text = await liveContent(view);
		const lines = targetLines(text);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			for (const [, pct] of line.matchAll(/(\d+)%/g)) {
				expect(Number(pct), line).toBeLessThan(100);
			}
		}
	});

	it('view=full: 100 超の pct を持つ 2 件の数字が content に出ない（530 / 999）', async () => {
		const text = await liveContent('full');
		// `targetReachedPct` は 530（`triangle_ascending`）と 999（`falling_wedge`）。値そのものは `structuredContent` に残っている（契約は変えていない）が、content には出さない。
		expect(text).not.toContain('530%');
		expect(text).not.toContain('999%');
		expect(text).not.toContain('ターゲット進捗');
	});

	// `res.summary` は views handler と別実装で、日時の粒度も別々に決まる。暦日に潰すと 1hour では 24 本が同じラベルになり、初到達の足を特定できない。
	it('res.summary（別実装）も intraday の初到達を分まで出す', async () => {
		const candles = buildBtcJpy1hour202608Candles();
		vi.mocked(analyzeIndicators).mockResolvedValueOnce(
			asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
		);
		const res = await detectPatterns('btc_jpy', '1hour', candles.length, {});
		assertOk(res);
		expect(res.summary).toContain(`${TARGET_LABEL}到達（ブレイク後 47 本目、2026-08-19 23:00）`);
		expect(res.summary).not.toContain('到達（ブレイク後 47 本目、2026-08-19）');
	});

	it('view=full: 進捗を出さなかったパターンは理由を名乗る', async () => {
		const text = await liveContent('full');
		const omitted = targetLines(text).filter((l) => l.includes('出力なし'));
		expect(omitted).toHaveLength(1);
		expect(omitted.filter((line) => line.includes('残り距離が短く進捗率が意味を持たないため'))).toHaveLength(0);
		expect(
			omitted.filter((line) => line.includes('期待方向と逆のブレイクで、標準的なパターン目標値を適用しないため')),
		).toHaveLength(1);
	});
});
