import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import sharp from 'sharp';
import { dayjs } from '../../../lib/datetime.js';

export async function svgToPng(
	svg: string,
	outputPath: string,
	options: {
		width?: number;
		height?: number;
		density?: number; // DPI for SVG rendering
	} = {},
): Promise<string> {
	const { density = 150 } = options;

	const dir = dirname(outputPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const svgBuffer = Buffer.from(svg, 'utf-8');

	let pipeline = sharp(svgBuffer, { density });

	if (options.width || options.height) {
		pipeline = pipeline.resize(options.width, options.height, {
			fit: 'inside',
			withoutEnlargement: true,
		});
	}

	await pipeline.png().toFile(outputPath);

	return outputPath;
}

// pair は上流で検証済みだが、ファイル名の安全性を上流バリデーションに依存させない防御。
function sanitizeFilenamePart(part: string): string {
	return part.replace(/[^a-zA-Z0-9_-]/g, '');
}

export function generateBacktestChartFilename(
	pair: string,
	timeframe: string,
	strategy: string,
	format: 'png' | 'svg' = 'png',
): string {
	const timestamp = dayjs().format('YYYY-MM-DDTHH-mm-ss');
	const safePair = sanitizeFilenamePart(pair.replace('_', ''));
	return `backtest_${safePair}_${sanitizeFilenamePart(timeframe)}_${sanitizeFilenamePart(strategy)}_${timestamp}.${format}`;
}
