import { RSI_OVERBOUGHT, RSI_OVERSOLD } from '../../lib/indicator-config.js';
import { niceTicks } from './svg-utils.js';

const RSI_MIDLINE = 50;
const PRICE_PANEL_HEIGHT = 420;

export interface SubPanelContext {
	x: (i: number) => number;
	padding: { top: number; right: number; bottom: number; left: number };
	plotW: number;
	w: number;
	barW: number;
	effectivePrecision: number;
	pastBuffer: number;
	displayItems: Array<{ open: number; close: number; volume?: number; [k: string]: unknown }>;
	indicators: Record<string, unknown> | undefined;
}

const SUB_PANEL_HEIGHT = 120;
const SUB_PANEL_GAP = 24;
const LEGEND_H = 18;

function subPanelY(v: number, min: number, max: number, top: number, precision: number): number {
	const dataH = SUB_PANEL_HEIGHT - LEGEND_H;
	const range = Math.max(1e-10, max - min);
	return Number((top + SUB_PANEL_HEIGHT - ((v - min) * dataH) / range).toFixed(precision));
}

export function renderSubPanels(
	panelTypes: Array<'macd' | 'rsi' | 'volume'>,
	ctx: SubPanelContext,
): { svg: string; totalHeight: number } {
	if (panelTypes.length === 0) return { svg: '', totalHeight: 0 };

	const { padding, plotW, w } = ctx;
	const h = PRICE_PANEL_HEIGHT;
	const pricePanelBottom = h - padding.bottom;
	let currentTop = pricePanelBottom + SUB_PANEL_GAP;
	let svgOut = '';

	for (const panelType of panelTypes) {
		const panelBottom = currentTop + SUB_PANEL_HEIGHT;
		let pc = '';
		pc += `<rect x="${padding.left}" y="${currentTop}" width="${plotW}" height="${SUB_PANEL_HEIGHT}" fill="rgba(255,255,255,0.02)"/>`;
		pc += `<line x1="${padding.left}" y1="${currentTop}" x2="${w - padding.right}" y2="${currentTop}" stroke="#374151" stroke-width="0.5"/>`;

		if (panelType === 'macd') {
			pc += renderMacdPanel(currentTop, ctx);
		} else if (panelType === 'rsi') {
			pc += renderRsiPanel(currentTop, ctx);
		} else if (panelType === 'volume') {
			pc += renderVolumePanel(currentTop, ctx);
		}

		pc += `<line x1="${padding.left}" y1="${currentTop}" x2="${padding.left}" y2="${panelBottom}" stroke="#4b5563" stroke-width="1"/>`;
		svgOut += pc;
		currentTop = panelBottom + SUB_PANEL_GAP;
	}

	const totalHeight = panelTypes.length * SUB_PANEL_HEIGHT + panelTypes.length * SUB_PANEL_GAP;
	return { svg: svgOut, totalHeight };
}

function renderMacdPanel(currentTop: number, ctx: SubPanelContext): string {
	const { x, padding, w, barW, effectivePrecision, pastBuffer, displayItems, indicators } = ctx;
	const py = (v: number, yMin: number, yMax: number) => subPanelY(v, yMin, yMax, currentTop, effectivePrecision);
	let pc = '';

	const ms = indicators?.macd_series as { line?: number[]; signal?: number[]; hist?: number[] } | undefined;
	const mLine = (ms?.line || []) as Array<number | null>;
	const mSig = (ms?.signal || []) as Array<number | null>;
	const mHist = (ms?.hist || []) as Array<number | null>;
	const vals: number[] = [];
	for (const s of [mLine, mSig, mHist]) {
		const sliced = s.slice(pastBuffer);
		for (let i = 0; i < sliced.length; i++) {
			const v = sliced[i];
			if (v != null && i < displayItems.length) vals.push(v as number);
		}
	}
	if (vals.length > 0) {
		const mMin = Math.min(...vals);
		const mMax = Math.max(...vals);
		const pad = (mMax - mMin) * 0.1 || 1;
		const yMin = mMin - pad;
		const yMax = mMax + pad;

		if (yMin < 0 && yMax > 0) {
			pc += `<line x1="${padding.left}" y1="${py(0, yMin, yMax)}" x2="${w - padding.right}" y2="${py(0, yMin, yMax)}" stroke="#4b5563" stroke-width="0.5" stroke-dasharray="4 4"/>`;
		}
		const hBarW = Math.max(1, barW * 0.7);
		mHist.forEach((val, i) => {
			if (val == null) return;
			const idx = i - pastBuffer;
			if (idx < 0 || idx >= displayItems.length) return;
			const cx = x(idx);
			const topY = py(val as number, yMin, yMax);
			const zeroY = py(0, yMin, yMax);
			const color = (val as number) >= 0 ? 'rgba(34,197,94,0.6)' : 'rgba(239,68,68,0.6)';
			pc += `<rect x="${Number((cx - hBarW / 2).toFixed(1))}" y="${Math.min(topY, zeroY)}" width="${Number(hBarW.toFixed(1))}" height="${Math.max(1, Math.abs(topY - zeroY))}" fill="${color}"/>`;
		});
		const lPts: string[] = [];
		mLine.forEach((v, i) => {
			if (v != null) {
				const idx = i - pastBuffer;
				if (idx >= 0 && idx < displayItems.length) lPts.push(`${x(idx)},${py(v as number, yMin, yMax)}`);
			}
		});
		if (lPts.length > 1) pc += `<path d="M ${lPts.join(' L ')}" fill="none" stroke="#3b82f6" stroke-width="1.5"/>`;
		const sPts: string[] = [];
		mSig.forEach((v, i) => {
			if (v != null) {
				const idx = i - pastBuffer;
				if (idx >= 0 && idx < displayItems.length) sPts.push(`${x(idx)},${py(v as number, yMin, yMax)}`);
			}
		});
		if (sPts.length > 1) pc += `<path d="M ${sPts.join(' L ')}" fill="none" stroke="#f97316" stroke-width="1.5"/>`;
		const mt = niceTicks(yMin, yMax, 3);
		mt.forEach((v) => {
			pc += `<text x="${padding.left - 8}" y="${py(v, yMin, yMax)}" text-anchor="end" dominant-baseline="middle" fill="#9ca3af" font-size="10">${v}</text>`;
		});
	}
	pc += `<text x="${padding.left + 4}" y="${currentTop + 12}" fill="#9ca3af" font-size="10" font-weight="bold">MACD</text>`;
	pc += `<line x1="${padding.left + 50}" y1="${currentTop + 8}" x2="${padding.left + 62}" y2="${currentTop + 8}" stroke="#3b82f6" stroke-width="1.5"/>`;
	pc += `<text x="${padding.left + 65}" y="${currentTop + 12}" fill="#9ca3af" font-size="9">MACD</text>`;
	pc += `<line x1="${padding.left + 100}" y1="${currentTop + 8}" x2="${padding.left + 112}" y2="${currentTop + 8}" stroke="#f97316" stroke-width="1.5"/>`;
	pc += `<text x="${padding.left + 115}" y="${currentTop + 12}" fill="#9ca3af" font-size="9">Signal</text>`;
	return pc;
}

function renderRsiPanel(currentTop: number, ctx: SubPanelContext): string {
	const { x, padding, plotW, w, effectivePrecision, pastBuffer, displayItems, indicators } = ctx;
	const rMin = 0,
		rMax = 100;
	const py = (v: number) => subPanelY(v, rMin, rMax, currentTop, effectivePrecision);
	let pc = '';

	const rsiSeries = (indicators?.RSI_14_series || []) as Array<number | null>;
	pc += `<rect x="${padding.left}" y="${py(100)}" width="${plotW}" height="${Math.abs(py(RSI_OVERBOUGHT) - py(100))}" fill="rgba(239,68,68,0.06)"/>`;
	pc += `<rect x="${padding.left}" y="${py(RSI_OVERSOLD)}" width="${plotW}" height="${Math.abs(py(0) - py(RSI_OVERSOLD))}" fill="rgba(34,197,94,0.06)"/>`;
	(
		[
			{ v: RSI_OVERBOUGHT, c: '#ef4444', d: '2 2' },
			{ v: RSI_MIDLINE, c: '#4b5563', d: '4 4' },
			{ v: RSI_OVERSOLD, c: '#22c55e', d: '2 2' },
		] as const
	).forEach(({ v, c, d }) => {
		pc += `<line x1="${padding.left}" y1="${py(v)}" x2="${w - padding.right}" y2="${py(v)}" stroke="${c}" stroke-width="0.5" stroke-dasharray="${d}"/>`;
	});
	const rPts: string[] = [];
	rsiSeries.forEach((v, i) => {
		if (v != null) {
			const idx = i - pastBuffer;
			if (idx >= 0 && idx < displayItems.length) rPts.push(`${x(idx)},${py(v as number)}`);
		}
	});
	if (rPts.length > 1) pc += `<path d="M ${rPts.join(' L ')}" fill="none" stroke="#a78bfa" stroke-width="1.5"/>`;
	[0, RSI_OVERSOLD, RSI_MIDLINE, RSI_OVERBOUGHT, 100].forEach((v) => {
		pc += `<text x="${padding.left - 8}" y="${py(v)}" text-anchor="end" dominant-baseline="middle" fill="#9ca3af" font-size="10">${v}</text>`;
	});
	pc += `<text x="${padding.left + 4}" y="${currentTop + 12}" fill="#9ca3af" font-size="10" font-weight="bold">RSI (14)</text>`;
	pc += `<line x1="${padding.left + 65}" y1="${currentTop + 8}" x2="${padding.left + 77}" y2="${currentTop + 8}" stroke="#a78bfa" stroke-width="1.5"/>`;
	pc += `<text x="${padding.left + 80}" y="${currentTop + 12}" fill="#9ca3af" font-size="9">RSI</text>`;
	return pc;
}

function renderVolumePanel(currentTop: number, ctx: SubPanelContext): string {
	const { x, padding, effectivePrecision, displayItems, barW } = ctx;
	const volumes = displayItems.map((d) => (d.volume as number) || 0);
	const vMax = Math.max(...volumes) || 1;
	const py = (v: number) => subPanelY(v, 0, vMax, currentTop, effectivePrecision);
	let pc = '';

	volumes.forEach((vol, i) => {
		if (vol <= 0) return;
		const cx = x(i);
		const topY = py(vol);
		const bottomY = py(0);
		const up = displayItems[i].close >= displayItems[i].open;
		const color = up ? 'rgba(34,197,94,0.5)' : 'rgba(239,68,68,0.5)';
		const vBarW = barW;
		pc += `<rect x="${Number((cx - vBarW / 2).toFixed(1))}" y="${topY}" width="${Number(vBarW.toFixed(1))}" height="${Math.max(1, bottomY - topY)}" fill="${color}"/>`;
	});
	const vt = niceTicks(0, vMax, 3);
	vt.forEach((v) => {
		const label =
			v >= 1e9
				? `${(v / 1e9).toFixed(1)}B`
				: v >= 1e6
					? `${(v / 1e6).toFixed(1)}M`
					: v >= 1e3
						? `${(v / 1e3).toFixed(0)}K`
						: v.toFixed(0);
		pc += `<text x="${padding.left - 8}" y="${py(v)}" text-anchor="end" dominant-baseline="middle" fill="#9ca3af" font-size="10">${label}</text>`;
	});
	pc += `<text x="${padding.left + 4}" y="${currentTop + 12}" fill="#9ca3af" font-size="10" font-weight="bold">Volume</text>`;
	pc += `<rect x="${padding.left + 55}" y="${currentTop + 4}" width="8" height="8" fill="rgba(34,197,94,0.5)"/>`;
	pc += `<text x="${padding.left + 66}" y="${currentTop + 12}" fill="#9ca3af" font-size="9">Up</text>`;
	pc += `<rect x="${padding.left + 85}" y="${currentTop + 4}" width="8" height="8" fill="rgba(239,68,68,0.5)"/>`;
	pc += `<text x="${padding.left + 96}" y="${currentTop + 12}" fill="#9ca3af" font-size="9">Down</text>`;
	return pc;
}
