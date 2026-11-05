import type { z } from 'zod';
import { formatPair } from '../../lib/formatter.js';
import analyzeFibonacci from '../../tools/analyze_fibonacci.js';
import { AnalyzeFibonacciInputSchema, AnalyzeFibonacciOutputSchema } from '../schemas.js';
import type { ToolDefinition } from '../tool-definition.js';

type FibOutput = z.infer<typeof AnalyzeFibonacciOutputSchema>;

export const toolDef: ToolDefinition = {
	name: 'analyze_fibonacci',
	description: `[Fibonacci / Retracement / Extension] フィボナッチ分析（fibonacci / retracement / extension / swing high-low）。スイング自動検出→リトレースメント/エクステンション水準を算出。過去の反応実績（反発率・リターン）付き。

複数タイムフレーム分析には analyze_mtf_fibonacci を使用。`,
	inputSchema: AnalyzeFibonacciInputSchema,
	handler: async (args: Record<string, unknown>) => {
		const result = await analyzeFibonacci(args);
		const res: FibOutput = AnalyzeFibonacciOutputSchema.parse(result);
		if (!res.ok) return res;

		const data = res.data;
		const meta = res.meta;
		const pair = String(data.pair || (args as Record<string, unknown>).pair || 'btc_jpy');
		const pairLabel = formatPair(pair);

		const contentArr = res.content ?? [];
		const existingText = contentArr.length > 0 ? contentArr[0].text : '';

		return {
			content: [{ type: 'text', text: existingText }],
			structuredContent: {
				ok: true,
				type: 'fibonacci',
				summary: res.summary ?? `${pairLabel} フィボナッチ分析`,
				data: {
					pair: data.pair,
					timeframe: data.timeframe,
					currentPrice: data.currentPrice,
					trend: data.trend,
					swingHigh: data.swingHigh,
					swingLow: data.swingLow,
					range: data.range,
					levels: data.levels ?? [],
					extensions: data.extensions ?? [],
					position: data.position ?? {},
					levelStats: data.levelStats ?? [],
				},
				meta,
			} as Record<string, unknown>,
		};
	},
};
