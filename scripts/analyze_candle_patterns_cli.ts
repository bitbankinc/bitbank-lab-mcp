#!/usr/bin/env tsx

import analyzeCandlePatterns from '../tools/analyze_candle_patterns.js';
import { parseArgs } from './cli-utils.js';

async function main() {
	const { positional } = parseArgs();
	const dateArg = positional[0]; // YYYYMMDD, ISO, or undefined

	console.log('🕯️  Running analyze_candle_patterns...');
	if (dateArg) {
		console.log(`📅 Target date (as_of): ${dateArg}`);
	} else {
		console.log('📅 Target: Latest data');
	}
	console.log('');

	const result = await analyzeCandlePatterns({
		as_of: dateArg,
	});

	if (result.ok) {
		console.log('✅ Success!\n');
		console.log('=== Summary ===');
		console.log(result.summary);
		console.log('\n=== Content ===');
		if (result.content && result.content.length > 0) {
			console.log(result.content[0].text);
		}
		console.log('\n=== Detected Patterns ===');
		console.log(JSON.stringify(result.data.recent_patterns, null, 2));
		console.log('\n=== Window Candles ===');
		console.log(JSON.stringify(result.data.window.candles, null, 2));
		console.log('\n=== Meta ===');
		console.log(JSON.stringify(result.meta, null, 2));
	} else {
		console.error('❌ Error:', result.summary);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
