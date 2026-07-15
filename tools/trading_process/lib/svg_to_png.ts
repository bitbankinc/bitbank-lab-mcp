/**
 * SVG to PNG conversion utility using sharp
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import sharp from 'sharp';
import { dayjs } from '../../../lib/datetime.js';

/**
 * Convert SVG string to PNG and save to file
 * @param svg - SVG string
 * @param outputPath - Output file path (should end with .png)
 * @param options - Optional settings
 * @returns Promise<string> - The output file path
 */
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

	// Ensure output directory exists
	const dir = dirname(outputPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	// Convert SVG to PNG using sharp
	const svgBuffer = Buffer.from(svg, 'utf-8');

	let pipeline = sharp(svgBuffer, { density });

	// Resize if dimensions specified
	if (options.width || options.height) {
		pipeline = pipeline.resize(options.width, options.height, {
			fit: 'inside',
			withoutEnlargement: true,
		});
	}

	await pipeline.png().toFile(outputPath);

	return outputPath;
}

/**
 * ファイル名に埋め込む値からパス区切り・ドット等を除去する。
 * pair は上流（ensurePair）で検証済みだが、ファイル名の安全性を
 * 上流バリデーションに依存させないための防御的サニタイズ。
 */
function sanitizeFilenamePart(part: string): string {
	return part.replace(/[^a-zA-Z0-9_-]/g, '');
}

/**
 * Generate a unique filename for backtest chart
 */
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
