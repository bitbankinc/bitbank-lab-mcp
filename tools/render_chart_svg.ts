import { dayjs } from '../lib/datetime.js';
import { formatPair } from '../lib/formatter.js';
import { ICHIMOKU_MIN_BARS_FOR_CLOUD, ICHIMOKU_SHIFT } from '../lib/indicator-config.js';
import { isJpyQuotedPair } from '../lib/pair-code.js';
import { fail, ok } from '../lib/result.js';
import { extractUpstreamWarning, prependWarnings } from '../lib/warning-propagation.js';
import {
	type CandleType,
	type ChartPayload,
	type Pair,
	RENDER_CHART_SVG_DEFAULT_LIMIT,
	type RenderChartSvgOptions,
	type Result,
} from '../src/schemas.js';
import analyzeIndicators from './analyze_indicators.js';

const CHART_WIDTH = 860;
const CHART_HEIGHT = 420;
const PADDING_TIGHT = { top: 36, right: 12, bottom: 32 } as const;
const PADDING_NORMAL = { top: 48, right: 16, bottom: 40 } as const;
const Y_HEADROOM_PCT = 0.02;
const LABEL_CHAR_WIDTH_PX = 8;
const LABEL_EXTRA_PADDING = 16;
const HEAVY_CHART_THRESHOLD = 500;

import { createCloudPaths } from './chart/ichimoku-cloud.js';
import { renderDepthChart } from './chart/render-depth.js';
import { renderSubPanels } from './chart/render-sub-panels.js';
import {
	bbColors,
	emaColors,
	formatYLabel,
	niceTicks,
	type Pt,
	sanitizeSvg,
	simplifyPts,
	smaColors,
} from './chart/svg-utils.js';

type RenderChartSvgInternalOpts = RenderChartSvgOptions & {
	debug?: boolean;
	forceLayers?: boolean;
	noAutoLighten?: boolean;
};

type RenderData = { svg?: string; filePath?: string; legend?: Record<string, string> };
type RenderMeta = {
	pair: Pair;
	type: CandleType | string;
	limit?: number;
	indicators?: string[];
	bbMode: 'default' | 'extended';
	range?: { start: string; end: string };
	sizeBytes?: number;
	layerCount?: number;
	truncated?: boolean;
	fallback?: string;
	warning?: string;
	warnings?: string[];
	/** 上流 warnings とは別系統のレンダリング層の警告（雲のデータ不足等）。 */
	renderWarnings?: string[];
	debug?: Record<string, unknown>;
};

export default async function renderChartSvg(
	args: RenderChartSvgInternalOpts = {},
): Promise<Result<RenderData, RenderMeta>> {
	const indSet = new Set<string>(args.indicators ?? []);

	// legacy with* → indSet にマージ（後方互換）
	if (args.withIchimoku) indSet.add(args.ichimoku?.mode === 'extended' ? 'ICHIMOKU_EXTENDED' : 'ICHIMOKU');
	if (args.withBB) {
		const rawBb = String(args.bbMode ?? '').toLowerCase();
		indSet.add(rawBb === 'extended' || rawBb === 'full' ? 'BB_EXTENDED' : 'BB');
	}
	for (const p of args.withSMA ?? []) indSet.add(`SMA_${p}`);
	for (const p of args.withEMA ?? []) indSet.add(`EMA_${p}`);

	let withIchimoku = indSet.has('ICHIMOKU') || indSet.has('ICHIMOKU_EXTENDED');
	const ichimokuMode: 'default' | 'extended' = indSet.has('ICHIMOKU_EXTENDED') ? 'extended' : 'default';
	const drawChikou = ichimokuMode === 'extended' || args.ichimoku?.withChikou === true;
	let withBB = indSet.has('BB') || indSet.has('BB_EXTENDED');
	const bbMode: 'default' | 'extended' = indSet.has('BB_EXTENDED') ? 'extended' : 'default';
	let withSMA = [...indSet].filter((k) => k.startsWith('SMA_')).map((k) => Number(k.split('_')[1]));
	let withEMA = [...indSet].filter((k) => k.startsWith('EMA_')).map((k) => Number(k.split('_')[1]));

	if (withIchimoku) {
		withSMA = [];
		withEMA = [];
		withBB = false;
	}

	const style = (args.style === 'line' ? 'line' : 'candles') as 'candles' | 'line';
	const isDepth = args.style === 'depth';
	const svgPrecision = Math.max(0, Math.min(3, Number(args.svgPrecision ?? 1)));
	const effectivePrecision = Math.max(1, svgPrecision);
	const svgMinify = args.svgMinify !== false;
	const simplifyTolerance = Math.max(0, Number(args.simplifyTolerance ?? 0.5));
	const viewBoxTight = args.viewBoxTight !== false;

	const {
		pair = 'btc_jpy',
		// normalize to CandleType-like values (historically 'day' was used)
		type = '1day',
		limit = RENDER_CHART_SVG_DEFAULT_LIMIT,
		withLegend = true,
		overlays,
		tz = 'Asia/Tokyo',
	} = args;
	const debugEnabled = Boolean(args.debug);
	const debugInfo: Record<string, unknown[]> = debugEnabled ? { notes: [] } : {};
	const forceLayers = args.forceLayers === true || args.noAutoLighten === true;

	const subPanelTypes: Array<'macd' | 'rsi' | 'volume'> = ((args.subPanels || []) as string[]).filter(
		(t): t is 'macd' | 'rsi' | 'volume' => ['macd', 'rsi', 'volume'].includes(t),
	);
	const SUB_PANEL_HEIGHT = 120;
	const SUB_PANEL_GAP = 24;

	if (isDepth) {
		return renderDepthChart(pair, args, effectivePrecision);
	}

	// 重そうなら candles-only にフォールバックする事前見積もり（一目は雲＋転換線＋基準線＋先行スパン 2 本で実質 5 レイヤー）。
	const estimatedLayers =
		(withIchimoku ? 5 : 0) + (withBB ? (bbMode === 'extended' ? 3 : 1) : 0) + withSMA.length + withEMA.length + 1; // +1 for base series
	const summaryNotes: string[] = [];
	if (!forceLayers && limit * estimatedLayers > HEAVY_CHART_THRESHOLD) {
		if (withBB || withSMA.length > 0 || withEMA.length > 0 || withIchimoku) {
			withBB = false;
			withSMA = [];
			withEMA = [];
			withIchimoku = false;
			summaryNotes.push('heavy chart detected → fallback to candles-only to avoid oversized SVG');
		}
	}

	const ichimokuMinLimit = ICHIMOKU_MIN_BARS_FOR_CLOUD;
	const renderWarnings: string[] = [];

	let effectiveLimit = limit;
	if (withIchimoku && limit < ichimokuMinLimit) {
		effectiveLimit = ichimokuMinLimit;
		summaryNotes.push(`一目均衡表の雲表示のため limit を ${limit} → ${effectiveLimit} に自動調整`);
	}

	const internalLimit = withIchimoku ? effectiveLimit + ICHIMOKU_SHIFT : effectiveLimit;
	const res = await analyzeIndicators(pair, type, internalLimit);
	if (!res?.ok) {
		return fail(
			res?.summary?.replace?.(/^Error: /, '') || 'failed to fetch indicators',
			res?.meta?.errorType || 'internal',
		);
	}

	const upstream = extractUpstreamWarning(res.meta);

	const chartData = res.data?.chart as ChartPayload;
	const items = chartData?.candles || [];
	const indicators = chartData?.indicators;
	const indicatorSeries = (key: string): Array<number | null> | undefined =>
		(indicators as Record<string, unknown>)[key] as Array<number | null> | undefined;
	const pastBuffer = chartData.meta?.pastBuffer ?? 0;
	const forwardShiftMeta = chartData.meta?.shift ?? 0;
	// 一目を描画しない場合は forwardShift を 0 にする（間隔が詰まるのを防ぐ）
	const forwardShift = withIchimoku ? forwardShiftMeta : 0;
	const displayItems = items.slice(pastBuffer);

	if (!items?.length) {
		return fail('No candle data available to render SVG chart.', 'user');
	}

	if (withIchimoku) {
		const spanA = indicators?.ICHI_spanA as Array<number | null> | undefined;
		const spanB = indicators?.ICHI_spanB as Array<number | null> | undefined;
		const spanAValidCount = spanA?.filter((v) => v !== null)?.length ?? 0;
		const spanBValidCount = spanB?.filter((v) => v !== null)?.length ?? 0;

		if (spanBValidCount === 0) {
			renderWarnings.push('先行スパンBのデータが不足しています。雲が描画されません。');
		} else if (spanAValidCount < effectiveLimit || spanBValidCount < effectiveLimit) {
			const cloudCoverage = Math.min(spanAValidCount, spanBValidCount);
			const coveragePct = Math.round((cloudCoverage / effectiveLimit) * 100);
			if (coveragePct < 80) {
				renderWarnings.push(`雲のカバー率: ${coveragePct}%（${cloudCoverage}/${effectiveLimit}本）。`);
			}
		}
	}

	const isJpyPair = isJpyQuotedPair(pair);
	const fmtYLabel = (val: number) => formatYLabel(val, isJpyPair);

	const xs = displayItems.map((_, i) => i);
	const highs = displayItems.map((d) => d.high as number);
	const lows = displayItems.map((d) => d.low as number);

	const yRangeKeys: string[] = [];
	if (withIchimoku) yRangeKeys.push('ICHI_tenkan', 'ICHI_kijun', 'ICHI_spanA', 'ICHI_spanB');
	if (withBB) {
		if (bbMode === 'extended') {
			yRangeKeys.push('BB1_upper', 'BB1_lower', 'BB2_upper', 'BB2_lower', 'BB3_upper', 'BB3_lower');
		} else {
			yRangeKeys.push('BB_upper', 'BB_lower');
		}
	}
	for (const p of withSMA) yRangeKeys.push(`SMA_${p}`);
	for (const p of withEMA) yRangeKeys.push(`EMA_${p}`);

	const allYValues: number[] = [...highs, ...lows];
	for (const key of yRangeKeys) {
		const series = indicatorSeries(key)?.slice(pastBuffer) ?? [];
		for (const v of series) {
			if (v !== null) allYValues.push(v);
		}
	}

	const dataYMin = Math.min(...allYValues);
	const dataYMax = Math.max(...allYValues);
	const yPad = Math.min(0.2, Math.max(0, Number(args.yPaddingPct ?? 0.06)));
	const yRange = dataYMax - dataYMin;
	const autoHeadroom = yRange * Y_HEADROOM_PCT;
	const yAxisMinWithBuffer = yRange > 0 ? dataYMin - yRange * yPad : dataYMin * (1 - yPad);
	const yAxisMaxTarget = yRange > 0 ? dataYMax + yRange * yPad + autoHeadroom : dataYMax * (1 + yPad) + autoHeadroom;
	const yTicks = niceTicks(yAxisMinWithBuffer, yAxisMaxTarget, 6);
	const yMin = yTicks[0];
	const yMax = yTicks.at(-1) as number;

	const maxLabelWidth = Math.max(...yTicks.map((v) => fmtYLabel(v).length));
	const dynamicPaddingLeft = maxLabelWidth * LABEL_CHAR_WIDTH_PX + LABEL_EXTRA_PADDING;

	const w = CHART_WIDTH;
	const h = CHART_HEIGHT;
	const padding = viewBoxTight
		? { top: PADDING_TIGHT.top, right: PADDING_TIGHT.right, bottom: PADDING_TIGHT.bottom, left: dynamicPaddingLeft }
		: { top: PADDING_NORMAL.top, right: PADDING_NORMAL.right, bottom: PADDING_NORMAL.bottom, left: dynamicPaddingLeft };
	const plotW = w - padding.left - padding.right;
	const plotH = h - padding.top - padding.bottom;

	const subPanelsTotalH =
		subPanelTypes.length > 0 ? subPanelTypes.length * SUB_PANEL_HEIGHT + subPanelTypes.length * SUB_PANEL_GAP : 0;
	const totalH = h + subPanelsTotalH;
	const xAxisBottom = totalH - padding.bottom;

	// バー中心を (i+0.5) に置き、左右に半スロットの余白を確保して端の切れを防ぐ。
	const totalSlots = Math.max(1, xs.length + forwardShift);
	const x = (i: number) => Number((padding.left + ((i + 0.5) * plotW) / totalSlots).toFixed(effectivePrecision));
	const y = (v: number) =>
		Number((h - padding.bottom - ((v - yMin) * plotH) / Math.max(1, yMax - yMin)).toFixed(effectivePrecision));

	const legendMeta: Record<string, string> = {};
	let legendLayers = '';

	let barWidthRatio = Number(args.barWidthRatio);
	if (!Number.isFinite(barWidthRatio)) {
		const n = xs.length;
		if (n <= 30)
			barWidthRatio = 0.55; // 少本数 → やや細め（間延び防止）
		else if (n <= 45) barWidthRatio = 0.6;
		else if (n <= 60) barWidthRatio = 0.65;
		else barWidthRatio = 0.7; // 多本数 → やや太め（隙間詰め）
	}
	barWidthRatio = Math.min(0.9, Math.max(0.1, barWidthRatio));
	const barW = Math.max(2, (plotW / Math.max(1, xs.length)) * barWidthRatio);

	let sticks = '';
	let bodies = '';
	let priceLine = '';
	let wantPriceLine = false;
	if (style === 'candles') {
		sticks = displayItems
			.map((d, i: number) => {
				const cx = x(i);
				return `<line x1="${cx}" y1="${y(d.high)}" x2="${cx}" y2="${y(d.low)}" class="w"/>`;
			})
			.join('');
		bodies = displayItems
			.map((d, i: number) => {
				const cx = x(i) - barW / 2;
				const o = y(d.open);
				const c = y(d.close);
				const top = Math.min(o, c);
				const bot = Math.max(o, c);
				const up = d.close >= d.open;
				return `<rect x="${Number(cx.toFixed(effectivePrecision))}" y="${Number(top.toFixed(effectivePrecision))}" width="${Number(barW.toFixed(effectivePrecision))}" height="${Number(Math.max(1, bot - top).toFixed(effectivePrecision))}" class="${up ? 'u' : 'd'}"/>`;
			})
			.join('');
	} else if (style === 'line') {
		wantPriceLine = true;
	} else if (style === 'depth') {
		// depth は価格系列の描画を行わず、後段の overlays/axes のみ使用
	}

	const round = (v: number) => Number(v.toFixed(svgPrecision));

	const createLinePath = (
		data: Array<number | null> | undefined,
		color: string,
		options: { dash?: string; width?: string; offset?: number; simplify?: boolean } = {},
	) => {
		if (!data || data.length === 0) return '';
		let raw: Pt[] = [];
		const offset = options.offset || 0; // 先行(+26) / 遅行(-26)
		let skipped = 0;
		data.forEach((val, i) => {
			if (val !== null && typeof val === 'number') {
				const posIndex = i - pastBuffer + offset;
				// 極端に描画領域外になる点はスキップしてパス破綻を防ぐ
				if (posIndex < -1 || posIndex > xs.length + forwardShift + 1) {
					skipped++;
					return;
				}
				raw.push({ x: x(posIndex), y: y(val) });
			}
		});
		if (raw.length === 0) return '';
		if (options.simplify !== false) {
			raw = simplifyPts(raw, simplifyTolerance);
		}
		const points = raw.map((p) => `${round(p.x)},${round(p.y)}`);
		const d = `M ${points.join(' L ')}`;
		const dash = options.dash ? `stroke-dasharray="${options.dash}"` : '';
		const width = options.width || '2';
		if (debugEnabled) {
			if (!debugInfo.paths) debugInfo.paths = [];
			debugInfo.paths.push({ color, count: raw.length, skipped });
		}
		return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" ${dash}/>`;
	};

	if (wantPriceLine) {
		const closesFull: Array<number | null> = items.map((d) => (typeof d.close === 'number' ? d.close : null));
		priceLine = createLinePath(closesFull, '#60a5fa', { width: '1.5', simplify: true, offset: 0 });
	}

	const bbSeries = {
		getUpper: (mode: 'default' | 'extended') => (mode === 'extended' ? indicators?.BB2_upper : indicators?.BB_upper),
		getMiddle: (mode: 'default' | 'extended') => (mode === 'extended' ? indicators?.BB2_middle : indicators?.BB_middle),
		getLower: (mode: 'default' | 'extended') => (mode === 'extended' ? indicators?.BB2_lower : indicators?.BB_lower),
		getBand: (sigma: 1 | 2 | 3) => {
			switch (sigma) {
				case 1:
					return { upper: indicators?.BB1_upper, middle: indicators?.BB1_middle, lower: indicators?.BB1_lower };
				case 2:
					return { upper: indicators?.BB2_upper, middle: indicators?.BB2_middle, lower: indicators?.BB2_lower };
				case 3:
					return { upper: indicators?.BB3_upper, middle: indicators?.BB3_middle, lower: indicators?.BB3_lower };
				default:
					return { upper: undefined, middle: undefined, lower: undefined };
			}
		},
	} as const;

	const ichiSeries = {
		tenkan: indicators?.ICHI_tenkan as Array<number | null> | undefined,
		kijun: indicators?.ICHI_kijun as Array<number | null> | undefined,
		spanA: indicators?.ICHI_spanA as Array<number | null> | undefined,
		spanB: indicators?.ICHI_spanB as Array<number | null> | undefined,
		chikou: indicators?.ICHI_chikou as Array<number | null> | undefined,
	} as const;

	let smaLayers = '';
	for (const p of withSMA) {
		const series = indicatorSeries(`SMA_${p}`);
		if (series && series.length > 0) {
			smaLayers += createLinePath(series, smaColors[p] || '#e5e7eb', { simplify: false });
		}
	}

	let emaLayers = '';
	for (const p of withEMA) {
		const series = indicatorSeries(`EMA_${p}`);
		if (series && series.length > 0) {
			emaLayers += createLinePath(series, emaColors[p] || '#ff9f1c', { simplify: false, dash: '6,3' });
		}
	}

	let bbLayers = '';
	if (withBB) {
		const createBBPoints = (data?: Array<number | null>): Pt[] => {
			const points: Pt[] = [];
			let skipped = 0;
			data?.forEach?.((val, i) => {
				if (val !== null && val !== undefined) {
					const posIndex = i - pastBuffer;
					if (posIndex < -1 || posIndex > xs.length + forwardShift + 1) {
						skipped++;
						return;
					}
					points.push({ x: x(posIndex), y: y(val) });
				}
			});
			if (debugEnabled) {
				if (!debugInfo.bb) debugInfo.bb = [];
				debugInfo.bb.push({ count: points.length, skipped });
			}
			return points;
		};
		const createPathFromPoints = (points?: Pt[]): string => {
			if (!points || points.length === 0) return '';
			return `M ${points.map((p) => `${round(p.x)},${round(p.y)}`).join(' L ')}`;
		};

		const makeBand = (upperSeries?: Array<number | null>, lowerSeries?: Array<number | null>) => {
			const upperPoints = createBBPoints(upperSeries);
			const lowerPoints = createBBPoints(lowerSeries);
			const upperPath = createPathFromPoints(upperPoints);
			const lowerPath = createPathFromPoints(lowerPoints);
			let bandPath = '';
			if (upperPoints.length > 0 && lowerPoints.length > 0) {
				const lowerPointsReversed = [...lowerPoints].reverse();
				const allPoints = [...upperPoints, ...lowerPointsReversed];
				bandPath = `${createPathFromPoints(allPoints)} Z`;
			}
			return { upperPath, lowerPath, bandPath };
		};

		if (bbMode === 'extended') {
			const band2 = makeBand(bbSeries.getBand(2).upper, bbSeries.getBand(2).lower);
			bbLayers += `
        <path d="${band2.bandPath}" fill="${bbColors.bandFill2}" stroke="none" />
      `;
			const p1u = createPathFromPoints(createBBPoints(bbSeries.getBand(1).upper));
			const p1l = createPathFromPoints(createBBPoints(bbSeries.getBand(1).lower));
			bbLayers += `
        <path d="${p1u}" fill="none" stroke="${bbColors.line1}" stroke-width="1"/>
        <path d="${p1l}" fill="none" stroke="${bbColors.line1}" stroke-width="1"/>
      `;
			const p2u = createPathFromPoints(createBBPoints(bbSeries.getBand(2).upper));
			const p2m = createPathFromPoints(createBBPoints(bbSeries.getBand(2).middle));
			const p2l = createPathFromPoints(createBBPoints(bbSeries.getBand(2).lower));
			bbLayers += `
        <path d="${p2u}" fill="none" stroke="${bbColors.line2}" stroke-width="1"/>
        <path d="${p2l}" fill="none" stroke="${bbColors.line2}" stroke-width="1"/>
        <path d="${p2m}" fill="none" stroke="${bbColors.middle}" stroke-width="1" stroke-dasharray="4 4"/>
      `;
			const p3u = createPathFromPoints(createBBPoints(bbSeries.getBand(3).upper));
			const p3l = createPathFromPoints(createBBPoints(bbSeries.getBand(3).lower));
			bbLayers += `
        <path d="${p3u}" fill="none" stroke="${bbColors.line3}" stroke-width="1"/>
        <path d="${p3l}" fill="none" stroke="${bbColors.line3}" stroke-width="1"/>
      `;
		} else {
			const band2 = makeBand(bbSeries.getUpper('default'), bbSeries.getLower('default'));
			const mid2 = createPathFromPoints(createBBPoints(bbSeries.getMiddle('default')));
			bbLayers = `
        <path d="${band2.bandPath}" fill="${bbColors.bandFill2}" stroke="none" />
        <path d="${band2.upperPath}" fill="none" stroke="${bbColors.line2}" stroke-width="1"/>
        <path d="${band2.lowerPath}" fill="none" stroke="${bbColors.line2}" stroke-width="1"/>
        <path d="${mid2}" fill="none" stroke="${bbColors.middle}" stroke-width="1" stroke-dasharray="4 4"/>
      `;
		}
	}

	let ichimokuLayers = '';
	if (withIchimoku && ichiSeries.tenkan) {
		const tenkanPath = createLinePath(ichiSeries.tenkan, '#00a3ff', { width: '1', offset: 0 });
		const kijunPath = createLinePath(ichiSeries.kijun, '#ff4d4d', { width: '1', offset: 0 });
		const chikouPath = drawChikou
			? createLinePath(ichiSeries.chikou, '#16a34a', { width: '1', dash: '2 2', offset: -ICHIMOKU_SHIFT })
			: '';
		const spanAPath = createLinePath(ichiSeries.spanA, '#16a34a', { width: '1', offset: ICHIMOKU_SHIFT });
		const spanBPath = createLinePath(ichiSeries.spanB, '#ef4444', { width: '1', offset: ICHIMOKU_SHIFT });

		const { greenCloudPath, redCloudPath } = createCloudPaths(ichiSeries.spanA, ichiSeries.spanB, ICHIMOKU_SHIFT, {
			x,
			y,
			pastBuffer,
			displayLength: xs.length,
			forwardShift,
		});

		ichimokuLayers = `
      <path d="${greenCloudPath}" fill="rgba(16, 163, 74, 0.16)" stroke="none" />
      <path d="${redCloudPath}" fill="rgba(239, 68, 68, 0.24)" stroke="none" />
      ${tenkanPath}
      ${kijunPath}
      ${chikouPath}
      ${spanAPath}
      ${spanBPath}
    `;
	}

	const legendItems: Array<{ key: string; text: string; color: string }> = [];
	for (const p of withSMA) {
		const c = smaColors[p] || '#e5e7eb';
		legendItems.push({ key: `SMA_${p}`, text: `SMA ${p}`, color: c });
	}
	for (const p of withEMA) {
		const c = emaColors[p] || '#ff9f1c';
		legendItems.push({ key: `EMA_${p}`, text: `EMA ${p}`, color: c });
	}
	if (withBB) {
		if (bbMode === 'extended') {
			legendItems.push({ key: 'BB1', text: 'BB ±1σ', color: bbColors.line1 });
			legendItems.push({ key: 'BB2', text: 'BB ±2σ', color: bbColors.line2 });
			legendItems.push({ key: 'BB3', text: 'BB ±3σ', color: bbColors.line3 });
		} else {
			legendItems.push({ key: 'BB', text: 'BB ±2σ', color: bbColors.line2 });
		}
	}
	if (withIchimoku) {
		legendItems.push({ key: 'Ichimoku', text: '転換線', color: '#00a3ff' });
		legendItems.push({ key: 'Ichimoku_kijun', text: '基準線', color: '#ff4d4d' });
	}
	for (const item of legendItems) legendMeta[item.key] = `${item.text} (${item.color})`;

	if (withLegend) {
		const yOffset = Math.max(14, padding.top - 18);
		legendLayers =
			`<g font-size="12" fill="#e5e7eb">` +
			legendItems
				.map((item, i) => {
					const xPos = padding.left + i * 130;
					return `<g transform="translate(${xPos}, ${yOffset})">
        <rect y="-10" width="12" height="12" fill="${item.color}"></rect>
        <text x="16" y="0">${item.text}</text>
      </g>`;
				})
				.join('') +
			`</g>`;
	}

	const yAxis = `
    <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${h - padding.bottom}" stroke="#4b5563" stroke-width="1"/>
    <g font-size="12" fill="#9ca3af">
      ${yTicks
				.map((val) => {
					const yPos = y(val);
					return `<text x="${padding.left - 8}" y="${yPos}" text-anchor="end" dominant-baseline="middle">${fmtYLabel(val)}</text>`;
				})
				.join('')}
    </g>
  `;

	const toDayjs = (d: { isoTime?: string | null; time?: string | number | null; timestamp?: string | number | null }) =>
		dayjs(d?.isoTime || d?.time || d?.timestamp).tz(tz);
	const firstDate = toDayjs(displayItems[0]);
	const lastDate = toDayjs(displayItems[displayItems.length - 1]);
	const isSameDay =
		firstDate.isValid() && lastDate.isValid() && firstDate.format('YYYYMMDD') === lastDate.format('YYYYMMDD');

	const formatXLabel = (d: ReturnType<typeof dayjs>): string => {
		const tf = String(type).toLowerCase();
		if (['1min', '5min', '15min', '30min'].includes(tf)) {
			return d.format('H:mm');
		}
		if (['1hour', '4hour'].includes(tf)) {
			return isSameDay ? d.format('H:mm') : d.format('M/D H:mm');
		}
		if (['8hour', '12hour', '1day'].includes(tf)) {
			return `${d.month() + 1}/${d.date()}`;
		}
		return d.format('YYYY/M/D');
	};

	const xAxis = `
    <line x1="${padding.left}" y1="${h - padding.bottom}" x2="${w - padding.right}" y2="${h - padding.bottom}" stroke="#4b5563" stroke-width="1"/>
    ${subPanelTypes.length > 0 ? `<line x1="${padding.left}" y1="${xAxisBottom}" x2="${w - padding.right}" y2="${xAxisBottom}" stroke="#4b5563" stroke-width="1"/>` : ''}
    <g font-size="12" fill="#9ca3af">
      ${displayItems
				.map((d, i: number) => {
					const step = Math.max(1, Math.floor(displayItems.length / 5));
					if (i % step !== 0) return '';
					const xPos = x(i);
					const date = toDayjs(d);
					if (!date.isValid()) return '';
					const label = formatXLabel(date);
					return `<text x="${xPos}" y="${xAxisBottom + 16}" text-anchor="middle" fill="#9ca3af" font-size="10">${label}</text>`;
				})
				.join('')}
    </g>
  `;

	const { svg: subPanelSvg } = renderSubPanels(subPanelTypes, {
		x,
		padding,
		plotW,
		w,
		barW,
		effectivePrecision,
		pastBuffer,
		displayItems: displayItems as Array<{ open: number; close: number; volume?: number; [k: string]: unknown }>,
		indicators: indicators as Record<string, unknown> | undefined,
	});

	const createSvgString = (layers: { ichimoku: string; bb: string; sma: string; ema: string }) => `
    <svg width="${w}" height="${totalH}" viewBox="0 0 ${w} ${totalH}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" style="background-color: #1f2937; color: #e5e7eb; font-family: sans-serif; max-width: 100%; height: auto;">
      <title>${formatPair(pair)} ${type} chart</title>
      <style>.u{fill:#16a34a}.d{fill:#ef4444}.w{stroke:#9ca3af;stroke-width:${Math.max(1, Math.min(2.5, barW * 0.15)).toFixed(1)}}</style>
      <defs>
        <clipPath id="plotArea">
          <rect x="${padding.left}" y="${padding.top}" width="${plotW}" height="${plotH}"/>
        </clipPath>
      </defs>
      <g class="axes">
        ${yAxis}
        ${xAxis}
      </g>
      <g class="plot-area" clip-path="url(#plotArea)">
        ${layers.ichimoku}
        ${layers.bb}
  ${sticks}
  ${bodies}
${priceLine}
        ${layers.sma}
        ${layers.ema}
        ${(() => {
					if (!overlays?.ranges) return '';
					const mkRect = (startIso: string, endIso: string, color?: string, label?: string) => {
						const findIndexByIso = (iso: string) => displayItems.findIndex((d) => d.isoTime === iso);
						const i0 = findIndexByIso(startIso);
						const i1 = findIndexByIso(endIso);
						if (i0 < 0 || i1 < 0) return '';
						const left = Math.min(x(i0), x(i1));
						const right = Math.max(x(i0), x(i1));
						const width = Math.max(0, right - left);
						const fill = color || 'rgba(180,180,40,0.18)';
						const rect = `<rect x="${left}" y="${padding.top}" width="${width}" height="${plotH}" fill="${fill}" />`;
						const text = label
							? `<text x="${left + 4}" y="${padding.top + 12}" fill="#e5e7eb" font-size="10">${label}</text>`
							: '';
						return rect + text;
					};
					return overlays.ranges
						.map((r: { start: string; end: string; color?: string; label?: string }) =>
							mkRect(r.start, r.end, r.color, r.label),
						)
						.join('');
				})()}
        ${(() => {
					if (!overlays?.annotations) return '';
					let slot = 0;
					const mkPin = (iso: string, text: string) => {
						const findIndexByIso = (s: string) => displayItems.findIndex((d) => d.isoTime === s);
						const i = findIndexByIso(iso);
						if (i < 0) return '';
						const cx = x(i);
						const y0 = padding.top + 6 + (slot++ % 2) * 12; // 交互にオフセット
						const stemY1 = y0 + 10;
						const circle = `<circle cx="${cx}" cy="${y0}" r="3" fill="#e5e7eb" />`;
						const stem = `<line x1="${cx}" y1="${y0 + 3}" x2="${cx}" y2="${Math.min(padding.top + plotH - 6, stemY1)}" stroke="#9ca3af" stroke-width="1" stroke-dasharray="2 2" />`;
						const label = `<text x="${cx + 6}" y="${y0 + 4}" fill="#e5e7eb" font-size="10">${text}</text>`;
						return circle + stem + label;
					};
					return overlays.annotations.map((a: { isoTime: string; text: string }) => mkPin(a.isoTime, a.text)).join('');
				})()}
        ${(() => {
					if (!overlays?.depth_zones) return '';
					const mkBand = (low: number, high: number, color?: string, label?: string) => {
						const y1 = y(high);
						const y2 = y(low);
						const rect = `<rect x="${padding.left}" y="${Math.min(y1, y2)}" width="${plotW}" height="${Math.abs(y2 - y1)}" fill="${color || 'rgba(34,197,94,0.08)'}" />`;
						const text = label
							? `<text x="${padding.left + 4}" y="${Math.min(y1, y2) + 12}" fill="#e5e7eb" font-size="10">${label}</text>`
							: '';
						return rect + text;
					};
					return overlays.depth_zones
						.map((z: { low: number; high: number; color?: string; label?: string }) =>
							mkBand(z.low, z.high, z.color, z.label),
						)
						.join('');
				})()}
      </g>
      <g class="legend">
        ${legendLayers}
      </g>
      <g class="sub-panels">
        ${subPanelSvg}
      </g>
    </svg>
  `;

	let fullSvg = createSvgString({ ichimoku: ichimokuLayers, bb: bbLayers, sma: smaLayers, ema: emaLayers });
	let lightSvg = createSvgString({
		ichimoku: withIchimoku ? ichimokuLayers : '',
		bb: bbLayers,
		sma: smaLayers,
		ema: emaLayers,
	});
	if (svgMinify) {
		const minify = (s: string) => s.replace(/\s{2,}/g, ' ').replace(/>\s+</g, '><');
		fullSvg = minify(fullSvg);
		lightSvg = minify(lightSvg);
	}

	const finalSvg = sanitizeSvg(withIchimoku ? lightSvg : fullSvg);
	const sizeBytes = Buffer.byteLength(finalSvg, 'utf8');
	const layerCount = estimatedLayers;

	const title = `${formatPair(pair)} ${type} chart`;
	const rangeStart = displayItems[0]?.isoTime || '';
	const rangeEnd = displayItems.at(-1)?.isoTime || '';
	const identifier =
		`${String(pair)}-${String(type)}-${String(rangeStart).slice(0, 10)}-${String(rangeEnd).slice(0, 10)}`.replace(
			/[^a-z0-9_-]+/gi,
			'-',
		);

	const metaBase: RenderMeta & { identifier?: string; title?: string } = {
		pair: pair as Pair,
		type,
		limit: effectiveLimit,
		indicators: Object.keys(legendMeta),
		bbMode,
		range: { start: rangeStart, end: rangeEnd },
		sizeBytes,
		layerCount,
		...(identifier ? { identifier } : {}),
		...(title ? { title } : {}),
		...upstream,
		...(renderWarnings.length > 0 ? { renderWarnings } : {}),
	};
	if (debugEnabled) {
		metaBase.debug = {
			x: { count: xs.length, totalSlots, padding, plotW },
			y: { yMin, yMax, ticks: yTicks },
			data: { withBB, withSMA, withEMA, withIchimoku, forwardShift, pastBuffer },
			...debugInfo,
		};
	}

	const baseSummary = summaryNotes.length
		? `${formatPair(pair)} ${type} chart rendered (${summaryNotes.join('; ')})`
		: `${formatPair(pair)} ${type} chart rendered`;
	// renderWarnings は summary に混ぜず meta だけで返す（handler が SVG block の前に別表示する）。
	const summary = prependWarnings(baseSummary, upstream, { separator: '\n' });

	return ok<RenderData, RenderMeta>(summary, { svg: finalSvg, legend: legendMeta }, metaBase);
}
