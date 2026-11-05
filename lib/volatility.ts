function safeLog(x: number): number {
	return Math.log(Math.max(x, 1e-12));
}

export function logReturns(closes: number[], useLog: boolean = true): number[] {
	const result: number[] = [];
	for (let i = 1; i < closes.length; i++) {
		const prev = closes[i - 1];
		const curr = closes[i];
		if (prev > 0 && curr > 0) {
			result.push(useLog ? safeLog(curr / prev) : (curr - prev) / prev);
		} else {
			result.push(0);
		}
	}
	return result;
}

export function parkinsonComponents(highs: number[], lows: number[]): number[] {
	const n = Math.min(highs.length, lows.length);
	const result: number[] = [];
	for (let i = 0; i < n; i++) {
		const logHL = safeLog(highs[i] / Math.max(lows[i], 1e-12));
		result.push(logHL * logHL);
	}
	return result;
}

export function garmanKlassComponents(opens: number[], highs: number[], lows: number[], closes: number[]): number[] {
	const n = Math.min(opens.length, highs.length, lows.length, closes.length);
	const result: number[] = [];
	for (let i = 0; i < n; i++) {
		const logHL = safeLog(highs[i] / Math.max(lows[i], 1e-12));
		const logCO = safeLog(closes[i] / Math.max(opens[i], 1e-12));
		const pk = logHL * logHL;
		result.push(0.5 * pk - (2 * Math.log(2) - 1) * (logCO * logCO));
	}
	return result;
}

export function rogersSatchellComponents(opens: number[], highs: number[], lows: number[], closes: number[]): number[] {
	const n = Math.min(opens.length, highs.length, lows.length, closes.length);
	const result: number[] = [];
	for (let i = 0; i < n; i++) {
		const h = highs[i];
		const l = lows[i];
		const c = closes[i];
		const o = opens[i];
		const rs =
			safeLog(h / Math.max(c, 1e-12)) * safeLog(h / Math.max(o, 1e-12)) +
			safeLog(l / Math.max(c, 1e-12)) * safeLog(l / Math.max(o, 1e-12));
		result.push(rs);
	}
	return result;
}

export function componentMeanToVol(
	componentMean: number,
	type: 'parkinson' | 'garmanKlass' | 'rogersSatchell',
): number {
	switch (type) {
		case 'parkinson':
			return Math.sqrt(Math.max(0, componentMean / (4 * Math.log(2))));
		case 'garmanKlass':
		case 'rogersSatchell':
			return Math.sqrt(Math.max(0, componentMean));
	}
}
