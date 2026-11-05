import {
	HS_SHOULDER_MAX_PCT,
	MIN_DEPTH_PCT,
	MIN_PATTERN_HEIGHT_PCT,
	PRIOR_TREND_LOOKBACK_MAX,
	PRIOR_TREND_LOOKBACK_MIN,
	PRIOR_TREND_SIDEWAYS_PCT,
	type PriorTrendParams,
	type SizeThresholds,
} from './structural.js';

// triple だけなのは意図的。double / H&S には下限を置かない（#206）。
// 0.6 は detect_triples.ts の FORMING_MAX_CONFIDENCE（0.59）と、detectPatternsViewsHandler の低整合度ラベル（< 0.6）にそろえている。
export const MIN_CONFIDENCE: Record<string, number> = {
	triple_top: 0.6,
	triple_bottom: 0.6,
};

// src/schema/patterns.ts の .default() と同じ値にそろえている。
export const SCHEMA_DEFAULTS = {
	swingDepth: 7,
	minBarsBetweenSwings: 5,
	tolerancePct: 0.04,
} as const;

// 1day を 1.0 とした ATR の比。1week / 1month は √t で伸ばすと締まる方向になるので入れず、1day の値を据え置く（#152）。
// 実行時の ATR には連動させない。閾値が limit の関数になると、窓を広げたのに検出が減る（#154）。
// TODO: 1hour 以外の ATR 比は √t 推定。4hour の ATR を実測したら、この表の 4hour を差し替える。
const ATR_SCALE_BY_TF: Record<string, number> = {
	'1min': 0.0264,
	'5min': 0.0589,
	'15min': 0.1021,
	'30min': 0.1443,
	'1hour': 0.2073,
	'4hour': 0.4082,
	'8hour': 0.5774,
	'12hour': Math.SQRT1_2,
};

function atrScaled(anchor: number, tf: string): number {
	return Object.hasOwn(ATR_SCALE_BY_TF, tf) ? Number((anchor * ATR_SCALE_BY_TF[tf]).toFixed(4)) : anchor;
}

// lookback は時間足で伸ばさない。伸ばすと 1hour の標準窓でほぼ全候補が insufficient_data になる（#297）。
export function getPriorTrendParamsForTf(tf: string): PriorTrendParams {
	const atrScale = ATR_SCALE_BY_TF[tf] ?? 1;
	const sidewaysPct = Number((PRIOR_TREND_SIDEWAYS_PCT * atrScale).toFixed(4));
	return {
		sidewaysPct,
		lookbackMin: PRIOR_TREND_LOOKBACK_MIN,
		lookbackMax: PRIOR_TREND_LOOKBACK_MAX,
	};
}

const DEFAULT_PARAMS_BY_TF: Record<string, { swingDepth: number; minBarsBetweenSwings: number }> = {
	'1min': { swingDepth: 2, minBarsBetweenSwings: 1 },
	'5min': { swingDepth: 2, minBarsBetweenSwings: 1 },
	'15min': { swingDepth: 3, minBarsBetweenSwings: 2 },
	'30min': { swingDepth: 3, minBarsBetweenSwings: 2 },
	'1hour': { swingDepth: 3, minBarsBetweenSwings: 2 },
	'4hour': { swingDepth: 5, minBarsBetweenSwings: 3 },
	'8hour': { swingDepth: 5, minBarsBetweenSwings: 3 },
	'12hour': { swingDepth: 5, minBarsBetweenSwings: 3 },
	'1day': { swingDepth: 6, minBarsBetweenSwings: 4 },
	'1week': { swingDepth: 7, minBarsBetweenSwings: 5 },
	'1month': { swingDepth: 8, minBarsBetweenSwings: 6 },
};

export function getDefaultParamsForTf(tf: string): { swingDepth: number; minBarsBetweenSwings: number } {
	return { ...(Object.hasOwn(DEFAULT_PARAMS_BY_TF, tf) ? DEFAULT_PARAMS_BY_TF[tf] : DEFAULT_PARAMS_BY_TF['1day']) };
}

// 短い足ほど緩いのは意図的（#244）。同水準判定の締めは getHsShoulderMaxPctForTf と MAX_LEVEL_SPREAD_RATIO が担う。
const DEFAULT_TOLERANCE_BY_TF: Record<string, number> = {
	'15min': 0.06,
	'30min': 0.06,
	'1hour': 0.05,
	'4hour': 0.05,
	'8hour': 0.045,
	'12hour': 0.045,
	'1week': 0.035,
	'1month': 0.03,
};

export function getDefaultToleranceForTf(tf: string): number {
	return Object.hasOwn(DEFAULT_TOLERANCE_BY_TF, tf) ? DEFAULT_TOLERANCE_BY_TF[tf] : 0.04;
}

// double / triple / H&S で値を分けない（#139）。
export function getSizeThresholdsForTf(tf: string): SizeThresholds {
	return { heightPct: atrScaled(MIN_PATTERN_HEIGHT_PCT, tf), depthPct: atrScaled(MIN_DEPTH_PCT, tf) };
}

// 値が getSizeThresholdsForTf の depthPct と一致するのは偶然。測る量も極性も違うので流用しない。
export function getHsShoulderMaxPctForTf(tf: string): number {
	return atrScaled(HS_SHOULDER_MAX_PCT, tf);
}

const HEAD_PROMINENCE_PCT = 0.04;

// getDefaultToleranceForTf とは向きが逆（大きいほど厳しい）なので流用しない（#198）。
export function getHeadProminenceForTf(tf: string): number {
	return atrScaled(HEAD_PROMINENCE_PCT, tf);
}

export function getConvergenceFactorForTf(tf: string): number {
	if (tf === '1hour' || tf === '4hour' || tf === '15min' || tf === '30min') return 0.6;
	return 0.8; // default
}

export function getTriangleCoeffForTf(tf: string): { flat: number; move: number } {
	if (tf === '1hour' || tf === '4hour') return { flat: 1.2, move: 0.8 };
	return { flat: 0.8, move: 1.2 };
}

export function getMinFitForTf(tf: string): number {
	if (tf === '1hour' || tf === '4hour') return 0.6;
	if (tf === '1day') return 0.7;
	return 0.75;
}

const TRIANGLE_WINDOW_SIZE_BY_TF: Record<string, number> = {
	'15min': 30,
	'30min': 30,
	'1hour': 40,
	'4hour': 30,
	'1day': 50,
	'1week': 40,
	'1month': 30,
};

export function getTriangleWindowSize(tf: string): number {
	return Object.hasOwn(TRIANGLE_WINDOW_SIZE_BY_TF, tf) ? TRIANGLE_WINDOW_SIZE_BY_TF[tf] : 20;
}

// auto は「未指定」と「スキーマ既定値の明示指定」を区別しない。.default() で届く値が同じになるため（#182）。
export type ParamSource = 'auto' | 'explicit';

export interface ResolvedParamSources {
	swingDepth: ParamSource;
	tolerancePct: ParamSource;
	minBarsBetweenSwings: ParamSource;
	headProminencePct: ParamSource;
}

export function resolveParams(
	tf: string,
	opts: Partial<{
		swingDepth: number;
		tolerancePct: number;
		minBarsBetweenSwings: number;
		headProminencePct: number;
	}>,
): {
	swingDepth: number;
	tolerancePct: number;
	minBarsBetweenSwings: number;
	headProminencePct: number;
	sources: ResolvedParamSources;
} {
	const auto = getDefaultParamsForTf(tf);
	const tolAuto = getDefaultToleranceForTf(tf);
	const headProminenceAuto = getHeadProminenceForTf(tf);
	const {
		swingDepth: swingDepthIn,
		tolerancePct: tolerancePctIn,
		minBarsBetweenSwings: minBarsIn,
		headProminencePct: headProminenceIn,
	} = opts;

	const swingDepthExplicit =
		typeof swingDepthIn === 'number' && Number.isFinite(swingDepthIn) && swingDepthIn !== SCHEMA_DEFAULTS.swingDepth;
	const swingDepth = swingDepthExplicit ? swingDepthIn : auto.swingDepth;

	// swingDepth と述語をそろえない。Number.isFinite にすると Infinity の扱いが変わり実効値が動く。
	const tolerancePctExplicit =
		typeof tolerancePctIn === 'number' &&
		!Number.isNaN(tolerancePctIn) &&
		tolerancePctIn !== SCHEMA_DEFAULTS.tolerancePct;
	const tolerancePct = tolerancePctExplicit ? tolerancePctIn : tolAuto;

	const minBarsExplicit =
		typeof minBarsIn === 'number' && Number.isFinite(minBarsIn) && minBarsIn !== SCHEMA_DEFAULTS.minBarsBetweenSwings;
	const minBarsBetweenSwings = minBarsExplicit ? minBarsIn : auto.minBarsBetweenSwings;

	// headProminencePct だけはスキーマに .default() が無いので、既定値との比較をしない。
	const headProminenceExplicit = typeof headProminenceIn === 'number' && !Number.isNaN(headProminenceIn);
	const headProminencePct = headProminenceExplicit ? headProminenceIn : headProminenceAuto;

	return {
		swingDepth,
		tolerancePct,
		minBarsBetweenSwings,
		headProminencePct,
		sources: {
			swingDepth: swingDepthExplicit ? 'explicit' : 'auto',
			tolerancePct: tolerancePctExplicit ? 'explicit' : 'auto',
			minBarsBetweenSwings: minBarsExplicit ? 'explicit' : 'auto',
			headProminencePct: headProminenceExplicit ? 'explicit' : 'auto',
		},
	};
}
