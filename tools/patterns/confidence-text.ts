import type { PatternScoreBreakdown } from './types.js';

// 過去の実績で整合度が目標到達を予測しなかったので、確率への較正も「何点以上」の帯も置かない（#422）。
export const CONFIDENCE_NOTE =
	'パターン整合度について（軸の構成は種別で異なり、各パターンの「整合度の内訳」行に出す）:\n' +
	'  各軸は 0〜1 で、1 = 理想、0 = 検出の strict な基準ちょうど。整合度はその単純平均。\n' +
	'  緩い基準で拾った候補（relaxed・形成中）は、strict の基準に届かない軸も 0 になる（0 は「余裕が無い」で、基準ちょうどと届かないを区別しない）。\n' +
	'  整合度は形の良さの比較値で、当たりやすさ（確率）ではない。過去の実績（7 ペアの日足・4 時間足）では目標到達を予測せず、到達を左右したのは目標までの距離だった。何点以上なら信頼できるという基準は置かない。';

const AXIS_LABELS: Record<keyof PatternScoreBreakdown, string> = {
	levelMargin: '水準の揃い',
	headProminence: '頭の突出',
	timeSymmetry: '左右の時間の釣り合い',
	retracement: '戻り率',
	breakoutQuality: 'ブレイクの強さ',
	lineFit: 'ラインの当てはまり',
	convergence: '収束',
	touches: 'タッチ数',
	slopeSymmetry: '傾きの釣り合い',
	flatness: '水平側の平らさ',
	pole: 'ポールの強さ',
	parallelism: '幅の一定さ',
	alternation: 'タッチの交互さ',
	containment: '終値の包含率',
};

function axisLabel(key: string): string {
	return Object.hasOwn(AXIS_LABELS, key) ? AXIS_LABELS[key as keyof PatternScoreBreakdown] : key;
}

export function formatScoreBreakdownLines(scoreComponents: PatternScoreBreakdown | undefined): string[] {
	const entries = Object.entries(scoreComponents ?? {}).filter((entry): entry is [string, number] =>
		Number.isFinite(entry[1]),
	);
	if (entries.length === 0) return [];
	const lines = [`   - 整合度の内訳: ${entries.map(([key, v]) => `${axisLabel(key)} ${v.toFixed(2)}`).join(' / ')}`];
	// 0 は基準ちょうどでも届かなくても付く（物差しを 0 で切るため）ので、どちらかに断定しない。
	const noMargin = entries.filter(([, v]) => v === 0).map(([key]) => axisLabel(key));
	if (noMargin.length > 0) {
		lines.push(
			`   - ⚠️ 余裕が無い軸（strict の基準ちょうど、または届かない）: ${noMargin.join('、')}（検出の境目にある候補。単独では判断しない）`,
		);
	}
	return lines;
}
