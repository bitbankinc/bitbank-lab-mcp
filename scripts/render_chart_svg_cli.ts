#!/usr/bin/env tsx
import type { ChartStyle, Pair, RenderChartSvgOptions } from '../src/schemas.js';
import renderChartSvg from '../tools/render_chart_svg.js';
import { intArg, parseArgs } from './cli-utils.js';

async function main() {
	const { positional, flags } = parseArgs();

	const pair = (positional[0] || 'btc_jpy') as Pair;
	const type = positional[1] || '1day';
	const limit = intArg(positional[2], 60);

	const indicators: string[] = [];

	if (typeof flags.sma === 'string' && flags.sma.length > 0) {
		for (const v of flags.sma.split(',')) {
			const n = parseInt(v.trim(), 10);
			if (Number.isFinite(n) && n > 0) indicators.push(`SMA_${n}`);
		}
	}

	if (flags['with-ichimoku'] === true || typeof flags['ichimoku-mode'] === 'string') {
		const mode = String(flags['ichimoku-mode'] ?? 'default').toLowerCase();
		indicators.push(mode === 'extended' ? 'ICHIMOKU_EXTENDED' : 'ICHIMOKU');
	}

	// --bb-mode=default|extended (後方互換: light→default, full→extended)
	if (typeof flags['bb-mode'] === 'string') {
		const raw = flags['bb-mode'].toLowerCase();
		const ext = raw === 'extended' || raw === 'full';
		indicators.push(ext ? 'BB_EXTENDED' : 'BB');
	}

	// 単独表示フラグ（排他的に上書き）
	if (flags['candles-only'] === true) indicators.length = 0;
	if (flags['ichimoku-only'] === true) {
		indicators.length = 0;
		indicators.push('ICHIMOKU');
	}
	if (flags['bb-only'] === true) {
		indicators.length = 0;
		indicators.push('BB');
	}
	if (flags['sma-only'] === true) {
		const smaOnly = indicators.filter((i) => i.startsWith('SMA_'));
		indicators.length = 0;
		indicators.push(...smaOnly);
	}

	const options: RenderChartSvgOptions & Record<string, unknown> = {
		pair,
		type,
		limit,
		indicators,
	};

	if (flags['force-layers'] === true || flags['no-auto-lighten'] === true) {
		options.forceLayers = true;
	}

	if (typeof flags.style === 'string') {
		const style = flags.style;
		if (style === 'candles' || style === 'line' || style === 'depth') {
			options.style = style as ChartStyle;
		}
	}

	if (typeof flags['depth-levels'] === 'string') {
		const levels = parseInt(flags['depth-levels'], 10);
		if (Number.isFinite(levels)) {
			options.depth = { levels };
		}
	}

	const result = await renderChartSvg(options);
	if (result.ok) {
		const data = result.data as Record<string, unknown>;
		if (data.filePath) {
			console.error(`Chart saved to ${data.filePath}`);
		}
		console.log(data.svg);
	} else {
		console.error('Failed to generate chart:', result.summary);
		process.exit(1);
	}
}

main();
