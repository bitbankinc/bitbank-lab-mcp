import type { CumulativeStep } from '../../lib/depth-analysis.js';

type Scale = (value: number) => number;

function toStepPath(steps: ReadonlyArray<CumulativeStep>, x: Scale, y: Scale): string {
	if (!steps.length) return '';
	const pts = steps.map(([p, q]) => `${x(p)},${y(q)}`);
	return `M ${pts.join(' L ')}`;
}

function toFillPath(steps: ReadonlyArray<CumulativeStep>, side: 'bid' | 'ask', x: Scale, y: Scale): string {
	if (!steps.length) return '';
	const head = steps[0];
	const tail = steps[steps.length - 1];
	const baseY = y(0);
	const poly = ['M', `${x(head[0])},${baseY}`, 'L']
		.concat(steps.map(([p, q]) => `${x(p)},${y(q)}`))
		.concat(['L', `${x(tail[0])},${baseY}`, 'Z'])
		.join(' ');
	const fill = side === 'bid' ? 'rgba(16,185,129,0.12)' : 'rgba(249,115,22,0.12)';
	return `<path d="${poly}" fill="${fill}" stroke="none"/>`;
}

// 座標の丸めと余白は呼び出し側の x / y が持つ（render_depth_svg と render_chart_svg で違う）。
export function buildDepthPaths(
	bidSteps: ReadonlyArray<CumulativeStep>,
	askSteps: ReadonlyArray<CumulativeStep>,
	x: Scale,
	y: Scale,
): { bidPath: string; askPath: string; bidFill: string; askFill: string } {
	return {
		bidPath: toStepPath(bidSteps, x, y),
		askPath: toStepPath(askSteps, x, y),
		bidFill: toFillPath(bidSteps, 'bid', x, y),
		askFill: toFillPath(askSteps, 'ask', x, y),
	};
}
