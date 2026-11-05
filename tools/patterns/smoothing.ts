// scipy.signal.savgol_filter と同じ係数を作る。
function savgolCoefficients(windowSize: number, polyOrder: number): number[] {
	const m = Math.floor(windowSize / 2);
	const order = polyOrder;

	const rows = windowSize;
	const cols = order + 1;

	const JtJ: number[][] = Array.from({ length: cols }, () => Array.from<number>({ length: cols }).fill(0));
	for (let j1 = 0; j1 < cols; j1++) {
		for (let j2 = j1; j2 < cols; j2++) {
			let sum = 0;
			for (let i = 0; i < rows; i++) {
				const x = i - m;
				sum += x ** j1 * x ** j2;
			}
			JtJ[j1][j2] = sum;
			JtJ[j2][j1] = sum;
		}
	}

	const aug: number[][] = JtJ.map((row, i) => {
		const extended = Array.from<number>({ length: 2 * cols }).fill(0);
		for (let j = 0; j < cols; j++) extended[j] = row[j];
		extended[cols + i] = 1;
		return extended;
	});

	for (let col = 0; col < cols; col++) {
		let maxRow = col;
		let maxVal = Math.abs(aug[col][col]);
		for (let row = col + 1; row < cols; row++) {
			if (Math.abs(aug[row][col]) > maxVal) {
				maxVal = Math.abs(aug[row][col]);
				maxRow = row;
			}
		}
		if (maxRow !== col) {
			[aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
		}

		const pivot = aug[col][col];
		if (Math.abs(pivot) < 1e-15) continue;

		for (let j = 0; j < 2 * cols; j++) aug[col][j] /= pivot;

		for (let row = 0; row < cols; row++) {
			if (row === col) continue;
			const factor = aug[row][col];
			for (let j = 0; j < 2 * cols; j++) {
				aug[row][j] -= factor * aug[col][j];
			}
		}
	}

	const inv: number[][] = aug.map((row) => row.slice(cols));

	// 平滑化は 0 次の係数なので、(J^T J)^{-1} J^T の第 0 行を取る。
	const coeffs = Array.from<number>({ length: windowSize }).fill(0);
	for (let i = 0; i < windowSize; i++) {
		const x = i - m;
		let val = 0;
		for (let j = 0; j < cols; j++) {
			val += inv[0][j] * x ** j;
		}
		coeffs[i] = val;
	}

	return coeffs;
}

export function savgolFilter(data: number[], windowSize: number = 5, polyOrder: number = 2): number[] {
	const n = data.length;
	if (n === 0) return [];

	let ws = Math.max(3, windowSize);
	if (ws % 2 === 0) ws += 1;
	const po = Math.min(polyOrder, ws - 1);

	if (n < ws) {
		return [...data];
	}

	const coeffs = savgolCoefficients(ws, po);
	const half = Math.floor(ws / 2);
	const result = Array.from<number>({ length: n });

	for (let i = half; i < n - half; i++) {
		let sum = 0;
		for (let j = 0; j < ws; j++) {
			sum += coeffs[j] * data[i - half + j];
		}
		result[i] = sum;
	}

	// 端は境界効果を避けるため、元データをそのまま使う。
	for (let i = 0; i < half; i++) {
		result[i] = data[i];
	}
	for (let i = n - half; i < n; i++) {
		result[i] = data[i];
	}

	return result;
}

export function smoothCandleExtremes(
	candles: Array<{ high: number; low: number }>,
	windowSize: number = 5,
	polyOrder: number = 2,
): { smoothHigh: number[]; smoothLow: number[] } {
	const highs = candles.map((c) => c.high);
	const lows = candles.map((c) => c.low);

	return {
		smoothHigh: savgolFilter(highs, windowSize, polyOrder),
		smoothLow: savgolFilter(lows, windowSize, polyOrder),
	};
}
