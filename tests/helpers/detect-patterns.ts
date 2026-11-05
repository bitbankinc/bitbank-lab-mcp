import { vi } from 'vitest';
import { toolDef as detectPatternsTool } from '../../src/handlers/detectPatternsHandler.js';
import analyzeIndicators from '../../tools/analyze_indicators.js';
import type { CandleData } from '../../tools/patterns/types.js';
import { asMockResult } from '../_assertResult.js';

// 呼ぶ側のテストファイルで tools/analyze_indicators.js を vi.mock しておく。
export async function detectPatternsContent(candles: CandleData[], args: Record<string, unknown>): Promise<string> {
	vi.mocked(analyzeIndicators).mockResolvedValueOnce(
		asMockResult({ ok: true, summary: 'ok', data: { chart: { candles } } }),
	);
	const res = (await detectPatternsTool.handler({
		pair: 'btc_jpy',
		type: '1hour',
		limit: candles.length,
		...args,
	})) as {
		content?: Array<{ text?: string }>;
	};
	const text = res?.content?.[0]?.text;
	// `?? ''` で畳まない。空文字に落とすと `not.toContain` 側が「ハンドラが content を返さなかった」ときにも通ってしまう。
	if (typeof text !== 'string') throw new Error(`view=${String(args.view)} の content[0].text が取れない`);
	return text;
}
