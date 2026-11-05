export interface CloudContext {
	x: (i: number) => number;
	y: (v: number) => number;
	pastBuffer: number;
	displayLength: number;
	forwardShift: number;
}

export function createCloudPaths(
	spanA: Array<number | null> | undefined,
	spanB: Array<number | null> | undefined,
	offset: number,
	ctx: CloudContext,
): { greenCloudPath: string; redCloudPath: string } {
	let greenCloudPath = '';
	let redCloudPath = '';
	let currentTop: Array<{ x: number; y: number }> = [];
	let currentBottom: Array<{ x: number; y: number }> = [];
	let currentIsGreen: boolean | null = null;

	const minPosIndex = -1;
	const maxPosIndex = ctx.displayLength + ctx.forwardShift + 1;

	const pushPolygon = () => {
		if (currentTop.length < 2 || currentBottom.length < 2) return;
		const polygon = `M ${[...currentTop, ...currentBottom.slice().reverse()].map((p) => `${p.x},${p.y}`).join(' L ')} Z`;
		if (currentIsGreen) greenCloudPath += polygon;
		else redCloudPath += polygon;
	};

	const getPosIndex = (i: number) => i - ctx.pastBuffer + offset;
	const toPoint = (i: number, yVal: number) => ({ x: ctx.x(getPosIndex(i)), y: ctx.y(yVal) });

	const len = Math.max(spanA?.length || 0, spanB?.length || 0);
	for (let i = 0; i < len - 1; i++) {
		const a0 = spanA?.[i] as number | null;
		const b0 = spanB?.[i] as number | null;
		const a1 = spanA?.[i + 1] as number | null;
		const b1 = spanB?.[i + 1] as number | null;
		if (
			a0 == null ||
			b0 == null ||
			a1 == null ||
			b1 == null ||
			!Number.isFinite(a0) ||
			!Number.isFinite(b0) ||
			!Number.isFinite(a1) ||
			!Number.isFinite(b1)
		) {
			pushPolygon();
			currentTop = [];
			currentBottom = [];
			currentIsGreen = null;
			continue;
		}

		const posIndex0 = getPosIndex(i);
		const posIndex1 = getPosIndex(i + 1);
		if (posIndex1 < minPosIndex || posIndex0 > maxPosIndex) {
			pushPolygon();
			currentTop = [];
			currentBottom = [];
			currentIsGreen = null;
			continue;
		}

		const isGreen0 = a0 >= b0;
		const isGreen1 = a1 >= b1;
		if (currentIsGreen === null) {
			currentIsGreen = isGreen0;
			currentTop.push(toPoint(i, currentIsGreen ? a0 : b0));
			currentBottom.push(toPoint(i, currentIsGreen ? b0 : a0));
		}
		if (isGreen0 === isGreen1) {
			currentTop.push(toPoint(i + 1, currentIsGreen ? a1 : b1));
			currentBottom.push(toPoint(i + 1, currentIsGreen ? b1 : a1));
			continue;
		}
		const da = a1 - a0;
		const db = b1 - b0;
		const denom = da - db;
		const t = denom === 0 ? 0 : (a0 - b0) / denom;
		const tClamped = Math.max(0, Math.min(1, t));
		const xi = i + tClamped;
		const yi = a0 + tClamped * da;
		const pInt = toPoint(xi, yi);
		currentTop.push(pInt);
		currentBottom.push(pInt);
		pushPolygon();
		currentIsGreen = isGreen1;
		currentTop = [pInt, toPoint(i + 1, currentIsGreen ? a1 : b1)];
		currentBottom = [pInt, toPoint(i + 1, currentIsGreen ? b1 : a1)];
	}
	pushPolygon();
	return { greenCloudPath, redCloudPath };
}
