#!/usr/bin/env tsx

import * as fs from 'fs';
import renderCandlePatternDiagram from '../tools/render_candle_pattern_diagram.js';
import { parseArgs } from './cli-utils.js';

async function main() {
	const { positional } = parseArgs();
	const outputPath = positional[0] || 'candle_pattern_diagram.svg';

	console.log('🎨 Rendering candle pattern diagram...\n');

	const result = await renderCandlePatternDiagram({
		candles: [
			{ date: '11/6(木)', open: 16047419, high: 16080000, low: 15360000, close: 15538401, type: 'bearish' },
			{ date: '11/7(金)', open: 15538439, high: 15970000, low: 15213240, close: 15850570, type: 'bullish' },
			{ date: '11/8(土)', open: 15855255, high: 15855564, low: 15566345, close: 15716258, type: 'bearish' },
			{ date: '11/9(日)', open: 15716258, high: 16224640, low: 15589168, close: 16129907, type: 'bullish' },
			{ date: '11/10(月)', open: 16129906, high: 16449899, low: 16055001, close: 16365023, type: 'bullish' },
		],
		pattern: {
			name: '陽線包み線',
			nameEn: 'bullish_engulfing',
			confirmedDate: '11/9(日)',
			involvedIndices: [2, 3],
			direction: 'bullish',
		},
	});

	if (result.ok && result.data.svg) {
		console.log('✅ Success!');
		console.log(`   Size: ${result.meta.width}x${result.meta.height}px`);
		console.log(`   Candles: ${result.meta.candleCount}`);
		console.log(`   Pattern: ${result.meta.patternName || 'none'}`);

		fs.writeFileSync(outputPath, result.data.svg, 'utf-8');
		console.log(`\n📁 Saved to: ${outputPath}`);
		console.log('\n💡 Open the SVG file in a browser to view the diagram.');
	} else {
		console.error('❌ Error:', result.summary);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
