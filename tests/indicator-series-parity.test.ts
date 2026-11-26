/**
 * lib/indicator-series.ts（単一ソース）と公開契約（schema の flat キー・chart の系列キー・enum）の
 * 一致を固定する。テーブルに行を足したのに schema を更新し忘れる（またはその逆）と、ここが落ちる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIXED_FETCH_BARS, FIXED_MIN_BARS, MA_SERIES } from '../lib/indicator-series.js';
import { ChartIndicatorGroupEnum, IndicatorsInternalSchema, RenderChartSvgIndicatorEnum } from '../src/schemas.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chartSchemaSource = fs.readFileSync(path.join(PACKAGE_ROOT, 'src/schema/chart.ts'), 'utf8');

describe('indicator-series parity', () => {
	it('MA_SERIES の flat キーと系列キーが IndicatorsInternalSchema に存在する', () => {
		const shapeKeys = new Set(Object.keys(IndicatorsInternalSchema.shape));
		for (const s of MA_SERIES) {
			expect(shapeKeys, `schema に ${s.key} が無い`).toContain(s.key);
			expect(shapeKeys, `schema に ${s.seriesKey} が無い`).toContain(s.seriesKey);
		}
	});

	it('MA_SERIES の flat キーが chart の enum（Group / RenderChartSvg）に存在する', () => {
		for (const s of MA_SERIES) {
			expect(ChartIndicatorGroupEnum.options, `ChartIndicatorGroupEnum に ${s.key} が無い`).toContain(s.key);
			expect(RenderChartSvgIndicatorEnum.options, `RenderChartSvgIndicatorEnum に ${s.key} が無い`).toContain(s.key);
		}
	});

	// superRefine の seriesKeys はクロージャ内でエクスポートされないので、ソース文字列で一致を見る
	// （ソースを読むテストの前例は .claude/rules/comments.md 参照）。
	it('MA_SERIES の flat キーが chart.ts の superRefine seriesKeys と ChartIndicators の z.object に存在する', () => {
		for (const s of MA_SERIES) {
			expect(chartSchemaSource, `chart.ts の seriesKeys / schema に ${s.key} が無い`).toContain(`'${s.key}'`);
			expect(chartSchemaSource, `chart.ts の z.object に ${s.key}: が無い`).toMatch(
				new RegExp(`${s.key}:\\s*NumericSeriesSchema`),
			);
		}
	});

	it('テーブルの値が自明に壊れていない（期間とキーの対応・重複なし）', () => {
		const keys = MA_SERIES.map((s) => s.key);
		expect(new Set(keys).size).toBe(keys.length);
		for (const s of MA_SERIES) {
			expect(s.key).toBe(`${s.kind.toUpperCase()}_${s.period}`);
			expect(s.seriesKey).toBe(`${s.kind}_${s.period}_series`);
		}
		for (const { minBars } of FIXED_MIN_BARS) {
			expect(Number.isInteger(minBars) && minBars > 0).toBe(true);
		}
		for (const bars of Object.values(FIXED_FETCH_BARS)) {
			expect(Number.isInteger(bars) && bars > 0).toBe(true);
		}
	});
});
