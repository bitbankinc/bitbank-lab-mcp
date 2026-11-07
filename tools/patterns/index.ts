export {
	getConvergenceFactorForTf,
	getDefaultParamsForTf,
	getDefaultToleranceForTf,
	getMinFitForTf,
	getTriangleCoeffForTf,
	getTriangleWindowSize,
	resolveParams,
	SCHEMA_DEFAULTS,
} from './config.js';
export {
	clamp01,
	type LinearRegressionResult,
	type LinearRegressionWithR2Result,
	linearRegression,
	linearRegressionWithR2,
	marginFromRelDev,
	near,
	type RegressionPoint,
	relDev,
	trendlineFit,
	type XYPoint,
} from './regression.js';
export {
	type Candle,
	type DetectSwingPointsOptions,
	detectSwingPoints,
	filterPeaks,
	filterValleys,
	type Pivot,
} from './swing.js';
