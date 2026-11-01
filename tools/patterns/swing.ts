export interface Candle {
	open: number;
	close: number;
	high: number;
	low: number;
	isoTime?: string;
}

// detectSwingPoints は極値を high / low で判定し、price には終値を入れる（ヒゲ 1 本で同水準判定やネックラインが動かないように）。
// price の基準は検出器ごとに違う（三角形とウェッジは high / low）。不変なのは extremePrice が判定に使った値であることだけ（docs/tools.md に表）。
export interface Pivot {
	idx: number;
	price: number;
	kind: 'H' | 'L';
	extremePrice: number;
}

export interface DetectSwingPointsOptions {
	swingDepth: number;
	/** 厳格モード: 全ての前後バーより高い/低い必要がある（false: 60%投票制） */
	strictPivots?: boolean;
}

// 窓の前後 swingDepth 本はピボットにならないので、終端の余白にある戻しは #242 の経路ゲートに見えず、limit で結果が変わりうる（#277）。
export function detectSwingPoints(candles: Candle[], options: DetectSwingPointsOptions): Pivot[] {
	const { swingDepth, strictPivots = true } = options;

	const highs = candles.map((c) => c.high);
	const lows = candles.map((c) => c.low);
	const pivots: Pivot[] = [];

	for (let i = swingDepth; i < candles.length - swingDepth; i++) {
		let isHigh = true;
		let isLow = true;

		if (strictPivots) {
			for (let k = 1; k <= swingDepth; k++) {
				if (!(highs[i] > highs[i - k] && highs[i] > highs[i + k])) isHigh = false;
				if (!(lows[i] < lows[i - k] && lows[i] < lows[i + k])) isLow = false;
				if (!isHigh && !isLow) break;
			}
		} else {
			let votesHigh = 0;
			let votesLow = 0;
			for (let k = 1; k <= swingDepth; k++) {
				votesHigh += highs[i] > highs[i - k] && highs[i] > highs[i + k] ? 1 : 0;
				votesLow += lows[i] < lows[i - k] && lows[i] < lows[i + k] ? 1 : 0;
			}
			const need = Math.ceil(swingDepth * 0.6);
			isHigh = votesHigh >= need;
			isLow = votesLow >= need;
		}

		if (isHigh) {
			pivots.push({ idx: i, price: candles[i].close, kind: 'H', extremePrice: highs[i] });
		} else if (isLow) {
			pivots.push({ idx: i, price: candles[i].close, kind: 'L', extremePrice: lows[i] });
		}
	}

	return pivots;
}

export function filterPeaks(pivots: Pivot[]): Pivot[] {
	return pivots.filter((p) => p.kind === 'H');
}

export function filterValleys(pivots: Pivot[]): Pivot[] {
	return pivots.filter((p) => p.kind === 'L');
}

export function detectRelaxedSwings(candles: ReadonlyArray<Pick<Candle, 'high' | 'low'>>): {
	peaks: Array<{ idx: number; price: number }>;
	valleys: Array<{ idx: number; price: number }>;
} {
	const peaks: Array<{ idx: number; price: number }> = [];
	const valleys: Array<{ idx: number; price: number }> = [];
	for (let i = 1; i < candles.length - 1; i++) {
		const c = candles[i];
		const prev = candles[i - 1];
		const next = candles[i + 1];
		if (c.high > prev.high && c.high > next.high) {
			peaks.push({ idx: i, price: c.high });
		}
		if (c.low < prev.low && c.low < next.low) {
			valleys.push({ idx: i, price: c.low });
		}
	}
	return { peaks, valleys };
}
