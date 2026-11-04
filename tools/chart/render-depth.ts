import fs from 'node:fs/promises';
import path from 'node:path';
import { buildCumulativeSteps } from '../../lib/depth-analysis.js';
import { formatPair } from '../../lib/formatter.js';
import getDepth from '../../lib/get-depth.js';
import { EPSILON } from '../../lib/math.js';
import { fail, ok } from '../../lib/result.js';
import type { Pair, Result } from '../../src/schemas.js';
import { buildDepthPaths } from './depth-paths.js';

type RenderData = { svg?: string; filePath?: string; legend?: Record<string, string> };
type RenderMeta = {
	pair: Pair;
	type: string;
	bbMode: 'default' | 'extended';
	[key: string]: unknown;
};

export async function renderDepthChart(
	pair: string,
	args: { depth?: { levels?: number }; type?: string },
	effectivePrecision: number,
): Promise<Result<RenderData, RenderMeta>> {
	try {
		const depth = await getDepth(pair, { maxLevels: args.depth?.levels ?? 200 });
		if (!depth.ok) return fail(depth.summary.replace(/^Error: /, ''), depth.meta?.errorType || 'internal');
		const asks: Array<[string, string]> = depth.data.asks || [];
		const bids: Array<[string, string]> = depth.data.bids || [];
		const minBid = Number(bids[bids.length - 1]?.[0] ?? bids[0]?.[0] ?? 0);
		const maxAsk = Number(asks[asks.length - 1]?.[0] ?? asks[0]?.[0] ?? 0);
		const xMinP = Math.min(minBid, Number(bids[0]?.[0] ?? minBid));
		const xMaxP = Math.max(maxAsk, Number(asks[0]?.[0] ?? maxAsk));
		const bidSteps = buildCumulativeSteps(
			bids.map(([p, s]) => [Number(p), Number(s)] as [number, number]),
			'bid',
		);
		const askSteps = buildCumulativeSteps(
			asks.map(([p, s]) => [Number(p), Number(s)] as [number, number]),
			'ask',
		);
		const maxQty = Math.max(bidSteps.at(-1)?.[1] || 0, askSteps.at(-1)?.[1] || 0) || 1;

		const w = 860,
			h = 420;
		const padding = { top: 36, right: 12, bottom: 32, left: 64 };
		const plotW = w - padding.left - padding.right;
		const plotH = h - padding.top - padding.bottom;
		const x = (price: number) =>
			Number((padding.left + ((price - xMinP) * plotW) / Math.max(EPSILON, xMaxP - xMinP)).toFixed(effectivePrecision));
		const y = (qty: number) => Number((h - padding.bottom - (qty * plotH) / maxQty).toFixed(effectivePrecision));

		const { bidPath, askPath, bidFill, askFill } = buildDepthPaths(bidSteps, askSteps, x, y);

		const mid = (Number(bids[0]?.[0] ?? 0) + Number(asks[0]?.[0] ?? 0)) / 2;
		const yAxis = `
        <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${h - padding.bottom}" stroke="#4b5563" stroke-width="1"/>
      `;
		const xAxis = `
        <line x1="${padding.left}" y1="${h - padding.bottom}" x2="${w - padding.right}" y2="${h - padding.bottom}" stroke="#4b5563" stroke-width="1"/>
      `;
		const legendDepth = `
        <g font-size="12" fill="#e5e7eb" transform="translate(${padding.left}, ${Math.max(14, padding.top - 18)})">
          <rect x="0" y="-10" width="12" height="12" fill="#10b981"></rect>
          <text x="16" y="0">買い (Bids)</text>
          <rect x="120" y="-10" width="12" height="12" fill="#f97316"></rect>
          <text x="136" y="0">売り (Asks)</text>
        </g>`;

		const svg = `
      <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" style="background-color:#1f2937;color:#e5e7eb;font-family:sans-serif;max-width:100%;height:auto;">
        <title>${formatPair(pair)} depth chart</title>
        ${legendDepth}
        <g class="axes">${yAxis}${xAxis}</g>
        <g class="plot-area">
          ${bidFill}
          ${askFill}
          <path d="${bidPath}" fill="none" stroke="#10b981" stroke-width="2"/>
          <path d="${askPath}" fill="none" stroke="#f97316" stroke-width="2"/>
          <line x1="${x(mid)}" y1="${padding.top}" x2="${x(mid)}" y2="${h - padding.bottom}" stroke="#9ca3af" stroke-width="1" stroke-dasharray="4 4"/>
        </g>
      </svg>`;
		const assetsDir = path.join(process.cwd(), 'assets');
		await fs.mkdir(assetsDir, { recursive: true });
		const outputPath = path.join(assetsDir, `depth-${pair}-${Date.now()}.svg`);
		await fs.writeFile(outputPath, svg);
		const metaOut: RenderMeta = {
			pair: pair as Pair,
			type: String(args.type || '1day'),
			bbMode: 'default',
		};
		return ok<RenderData, RenderMeta>(
			`${formatPair(pair)} depth chart saved to ${outputPath}`,
			{ filePath: outputPath, svg },
			metaOut,
		);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return fail(msg || 'failed to render depth', 'internal');
	}
}
