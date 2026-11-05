import { failFromError } from '../lib/result.js';
import { RenderCandlePatternDiagramInputSchema, RenderCandlePatternDiagramOutputSchema } from '../src/schemas.js';
import type { ToolDefinition } from '../src/tool-definition.js';

interface DiagramCandle {
	date: string;
	open: number;
	high: number;
	low: number;
	close: number;
	type: 'bullish' | 'bearish';
	isPartial?: boolean;
}

interface DiagramPattern {
	name: string;
	nameEn?: string;
	confirmedDate: string;
	involvedIndices: [number, number];
	direction?: 'bullish' | 'bearish';
}

// 配色は bitbank に合わせている。
const COLORS = {
	dark: {
		background: '#1f2937',
		bullish: '#16a34a',
		bearish: '#ef4444',
		highlight: '#fb923c',
		arrow: '#93c5fd', // 淡いブルー（矢印・包むラベル用）
		grid: '#374151',
		text: '#e5e7eb',
		textMuted: '#9ca3af',
		descBox: '#374151',
	},
	light: {
		background: '#f8fafc',
		bullish: '#16a34a',
		bearish: '#ef4444',
		highlight: '#f97316',
		arrow: '#60a5fa', // 淡いブルー（矢印・包むラベル用）
		grid: '#e2e8f0',
		text: '#1e293b',
		textMuted: '#64748b',
		descBox: '#e2e8f0',
	},
};

// descBox の下に最低 60px のバッファを確保し、コンテナがアスペクト比で多少クリップしても説明文が切れないようにする。
const LAYOUT = {
	width: 800,
	height: 480,
	plotTop: 60,
	plotBottom: 320,
	plotLeft: 100,
	plotRight: 750,
	candleWidth: 40,
	candleSpacing: 110,
	dateLabelY: 345,
	descBoxY: 365,
	descBoxHeight: 55,
	plotSideMargin: 30,
};

function formatPriceLabel(price: number): string {
	if (price >= 10000000) {
		return `${(price / 10000).toFixed(0)}万`;
	}
	return price.toLocaleString('ja-JP');
}

function getPatternDescription(pattern: DiagramPattern): string {
	const { name } = pattern;

	const descriptions: Record<string, string> = {
		陽線包み線: '陽線包み線: 前日の陰線（赤）を翌日の陽線（緑）が完全に包む → 上昇転換のサイン',
		陰線包み線: '陰線包み線: 前日の陽線（緑）を翌日の陰線（赤）が完全に包む → 下落転換のサイン',
		陽線はらみ線: '陽線はらみ線: 前日の大陰線の中に小さな陽線が収まる → 上昇転換の予兆',
		陰線はらみ線: '陰線はらみ線: 前日の大陽線の中に小さな陰線が収まる → 下落転換の予兆',
		毛抜き天井: '毛抜き天井: 高値圏で2日連続同じ高値 → 上昇の限界、下落転換のサイン',
		毛抜き底: '毛抜き底: 安値圏で2日連続同じ安値 → 下落の限界、上昇転換のサイン',
		かぶせ線: 'かぶせ線: 高寄り後に陰線で前日陽線の中心以下 → 上昇一服、調整のサイン',
		切り込み線: '切り込み線: 安寄り後に陽線で前日陰線の中心超え → 下落一服、反発のサイン',
	};

	return descriptions[name] || `${name}パターン`;
}

export default async function renderCandlePatternDiagram(opts: {
	candles: DiagramCandle[];
	pattern?: DiagramPattern;
	title?: string;
	theme?: 'dark' | 'light';
}) {
	try {
		const input = RenderCandlePatternDiagramInputSchema.parse(opts);
		const { candles, pattern, theme = 'dark' } = input;
		const colors = COLORS[theme];

		const title = input.title || (pattern?.name ? `${pattern.name}パターン` : 'ローソク足チャート');

		const allPrices = candles.flatMap((c) => [c.high, c.low]);
		const maxPrice = Math.max(...allPrices);
		const minPrice = Math.min(...allPrices);
		const priceRange = maxPrice - minPrice;

		const padding = priceRange === 0 ? Math.max(Math.abs(maxPrice) * 0.1, 1) : priceRange * 0.1;
		const yMax = maxPrice + padding;
		const yMin = minPrice - padding;

		const { plotTop, plotBottom } = LAYOUT;
		const plotHeight = plotBottom - plotTop;
		const ySpan = yMax - yMin; // padding により必ず > 0

		const priceToY = (price: number): number => {
			return plotTop + ((yMax - price) / ySpan) * plotHeight;
		};

		// candles 本数に応じて spacing を縮めて中央寄せする（N<5 で右側余白が膨らみ、N=10 で右にはみ出るのを防ぐ）。
		const usablePlotWidth = LAYOUT.plotRight - LAYOUT.plotLeft - 2 * LAYOUT.plotSideMargin;
		const candleCount = candles.length;
		const candleSpacing =
			candleCount > 1 ? Math.min(LAYOUT.candleSpacing, usablePlotWidth / (candleCount - 1)) : LAYOUT.candleSpacing;
		const totalCandleSpan = (candleCount - 1) * candleSpacing;
		const plotCenterX = (LAYOUT.plotLeft + LAYOUT.plotRight) / 2;
		const startX = plotCenterX - totalCandleSpan / 2;

		const parts: string[] = [];

		const fontFamily = `'Noto Sans JP', sans-serif`;

		// viewBox を必ず指定する（CSS で width: 100% 等が当たってもアスペクト比を保ち、下端が切れない）。
		parts.push(
			`<svg width="${LAYOUT.width}" height="${LAYOUT.height}" viewBox="0 0 ${LAYOUT.width} ${LAYOUT.height}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">`,
		);

		parts.push(`<defs>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700&amp;display=swap');
        text { font-family: ${fontFamily}; }
      </style>
    </defs>`);

		parts.push(`<rect width="${LAYOUT.width}" height="${LAYOUT.height}" fill="${colors.background}"/>`);

		parts.push(
			`<text x="${LAYOUT.width / 2}" y="35" text-anchor="middle" font-size="18" font-weight="bold" fill="${colors.text}">${escapeXml(title)}</text>`,
		);

		const gridCount = 5;
		for (let i = 0; i <= gridCount; i++) {
			const y = plotTop + (plotHeight / gridCount) * i;
			parts.push(
				`<line x1="${LAYOUT.plotLeft}" y1="${y}" x2="${LAYOUT.plotRight}" y2="${y}" stroke="${colors.grid}" stroke-width="1" stroke-dasharray="4,4"/>`,
			);
		}

		for (let i = 0; i <= gridCount; i++) {
			const y = plotTop + (plotHeight / gridCount) * i;
			const price = yMax - ((yMax - yMin) / gridCount) * i;
			parts.push(
				`<text x="${LAYOUT.plotLeft - 10}" y="${y + 4}" text-anchor="end" font-size="11" fill="${colors.textMuted}">${formatPriceLabel(price)}</text>`,
			);
		}

		for (let i = 0; i < candles.length; i++) {
			const candle = candles[i];
			const x = startX + i * candleSpacing;

			const highY = priceToY(candle.high);
			const lowY = priceToY(candle.low);
			const wickColor = candle.type === 'bullish' ? colors.bullish : colors.bearish;
			parts.push(`<line x1="${x}" y1="${highY}" x2="${x}" y2="${lowY}" stroke="${wickColor}" stroke-width="2"/>`);

			const openY = priceToY(candle.open);
			const closeY = priceToY(candle.close);
			const bodyTop = Math.min(openY, closeY);
			const bodyHeight = Math.max(Math.abs(openY - closeY), 2); // 最低2pxを保証

			const fill = candle.type === 'bullish' ? colors.bullish : colors.bearish;

			const isHighlighted = pattern?.involvedIndices.includes(i);
			const strokeAttr = isHighlighted ? `stroke="${colors.highlight}" stroke-width="3"` : '';

			parts.push(
				`<rect x="${x - LAYOUT.candleWidth / 2}" y="${bodyTop}" width="${LAYOUT.candleWidth}" height="${bodyHeight}" fill="${fill}" ${strokeAttr}/>`,
			);

			const dateColor = candle.isPartial ? colors.highlight : colors.text;
			const partialMark = candle.isPartial ? ' ⚠' : '';
			parts.push(
				`<text x="${x}" y="${LAYOUT.dateLabelY}" text-anchor="middle" font-size="12" fill="${dateColor}">${escapeXml(candle.date)}${partialMark}</text>`,
			);
		}

		if (pattern) {
			const [prevIndex, confirmedIndex] = pattern.involvedIndices;

			if (prevIndex >= 0 && prevIndex < candles.length) {
				const prevX = startX + prevIndex * candleSpacing;
				const prevY = priceToY(candles[prevIndex].high) - 20;
				parts.push(
					`<text x="${prevX}" y="${prevY}" text-anchor="middle" font-size="16" font-weight="bold" fill="${colors.highlight}">前日</text>`,
				);
			}

			if (confirmedIndex >= 0 && confirmedIndex < candles.length) {
				const confX = startX + confirmedIndex * candleSpacing;
				const confY = priceToY(candles[confirmedIndex].high) - 20;
				parts.push(
					`<text x="${confX}" y="${confY}" text-anchor="middle" font-size="16" font-weight="bold" fill="${colors.highlight}">確定日</text>`,
				);
			}

			if (pattern.name.includes('包み線') && prevIndex >= 0 && confirmedIndex >= 0) {
				const prevX = startX + prevIndex * candleSpacing;
				const confX = startX + confirmedIndex * candleSpacing;

				const prevBodyBottom = Math.max(priceToY(candles[prevIndex].open), priceToY(candles[prevIndex].close));
				const confBodyBottom = Math.max(
					priceToY(candles[confirmedIndex].open),
					priceToY(candles[confirmedIndex].close),
				);
				const maxBodyBottom = Math.max(prevBodyBottom, confBodyBottom);
				const arrowY = maxBodyBottom + 15; // 実体の下端から15px下

				// orient="auto" で線の方向に回転するので右向き三角形で定義する（右→左の線では左向きになる）。
				parts.push(`<defs>
          <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="${colors.arrow}"/>
          </marker>
        </defs>`);

				const halfWidth = LAYOUT.candleWidth / 2; // 20px
				const gap = 10; // 実体からの距離
				const confLeftEdge = confX - halfWidth; // 確定日の実体左端
				const prevRightEdge = prevX + halfWidth; // 前日の実体右端
				const arrowStartX = confLeftEdge - gap; // 確定日の左端からgap分離す
				const arrowEndX = prevRightEdge + gap; // 前日の右端からgap分離す
				parts.push(
					`<line x1="${arrowStartX}" y1="${arrowY}" x2="${arrowEndX}" y2="${arrowY}" stroke="${colors.arrow}" stroke-width="2" marker-end="url(#arrowhead)"/>`,
				);

				const labelX = (arrowStartX + arrowEndX) / 2;
				parts.push(
					`<text x="${labelX}" y="${arrowY + 30}" text-anchor="middle" font-size="16" font-weight="bold" fill="${colors.arrow}">包む</text>`,
				);
			}

			const desc = getPatternDescription(pattern);
			parts.push(
				`<rect x="50" y="${LAYOUT.descBoxY}" width="${LAYOUT.width - 100}" height="${LAYOUT.descBoxHeight}" rx="5" fill="${colors.descBox}"/>`,
			);
			// テキスト baseline を descBox の視覚的中央に合わせる（font-size 14 のメトリクス補正込み）。
			const descTextY = LAYOUT.descBoxY + LAYOUT.descBoxHeight / 2 + 5;
			parts.push(
				`<text x="${LAYOUT.width / 2}" y="${descTextY}" text-anchor="middle" font-size="14" fill="${colors.text}">${escapeXml(desc)}</text>`,
			);
		}

		parts.push('</svg>');

		const svg = parts.join('\n');

		const result = {
			ok: true as const,
			summary: `${title}のSVG図を生成しました（${candles.length}本のローソク足）`,
			data: { svg },
			meta: {
				width: LAYOUT.width,
				height: LAYOUT.height,
				candleCount: candles.length,
				patternName: pattern?.name || null,
			},
		};

		return RenderCandlePatternDiagramOutputSchema.parse(result);
	} catch (e: unknown) {
		return failFromError(e, {
			schema: RenderCandlePatternDiagramOutputSchema,
			defaultMessage: 'ローソク足パターン図の描画中にエラーが発生しました',
		});
	}
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

export const toolDef: ToolDefinition = {
	name: 'render_candle_pattern_diagram',
	description: `[Candle Pattern Diagram / Education] ローソク足パターンの教育用構造図（candle pattern diagram / education / visualization）。analyze_candle_patterns の結果を初心者向けに視覚化。

ユーザーが「図で見せて」等と明示した場合のみ使用。自発的呼び出し禁止。data.svg を受け取ったら Visualizer(show_widget) の widget_code にそのまま渡してレンダリングすること。
チャット本文へのSVGコード直接出力は禁止。`,
	inputSchema: RenderCandlePatternDiagramInputSchema,
	handler: async (args: {
		candles: {
			date: string;
			open: number;
			high: number;
			low: number;
			close: number;
			type: 'bullish' | 'bearish';
			isPartial?: boolean;
		}[];
		pattern?: {
			name: string;
			nameEn?: string;
			confirmedDate: string;
			involvedIndices: [number, number];
			direction?: 'bullish' | 'bearish';
		};
		title?: string;
		theme?: 'dark' | 'light';
	}) => {
		const res = await renderCandlePatternDiagram(args);
		if (!res?.ok) return res;
		const data = res.data || {};
		const meta = res.meta || {};
		if (data?.svg) {
			const patternName = meta?.patternName || args?.pattern?.name || 'ローソク足パターン';
			const identifier = `candle-pattern-${patternName.replace(/[^a-z0-9]+/gi, '-')}-${Date.now()}`;
			const title = `${patternName}構造図`;
			const text = [
				'--- Candle Pattern Diagram ---',
				`identifier: ${identifier}`,
				`title: ${title}`,
				'type: image/svg+xml',
				'',
				String(data.svg),
				'',
				'Chart Info:',
				`- Pattern: ${patternName}`,
				`- Size: ${meta?.width || 800}x${meta?.height || 450}px`,
				`- Candles: ${meta?.candleCount || 5}本`,
			].join('\n');
			const enriched = {
				...res,
				artifactHint: { renderHint: 'ARTIFACT_REQUIRED', displayType: 'image/svg+xml', source: 'inline_svg' },
			};
			return { content: [{ type: 'text', text }], structuredContent: enriched };
		}
		return { content: [{ type: 'text', text: res.summary || 'Diagram rendered' }], structuredContent: res };
	},
};
