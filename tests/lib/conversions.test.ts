import { describe, expect, it } from 'vitest';
import { toNum } from '../../lib/conversions.js';

describe('toNum', () => {
	it('数値文字列を number に変換する', () => {
		expect(toNum('12345.67')).toBe(12345.67);
		expect(toNum('0')).toBe(0);
		expect(toNum('-100')).toBe(-100);
		expect(toNum('0.00000001')).toBe(0.00000001);
	});

	it('number をそのまま返す', () => {
		expect(toNum(42)).toBe(42);
		expect(toNum(0)).toBe(0);
		expect(toNum(-3.14)).toBe(-3.14);
	});

	it('null は null を返す', () => {
		expect(toNum(null)).toBeNull();
	});

	it('undefined は null を返す', () => {
		expect(toNum(undefined)).toBeNull();
	});

	// 空文字列・空白文字列（Number("") === 0, Number("  ") === 0 だが意図しない変換）
	it('空文字列・空白文字列は null を返す', () => {
		expect(toNum('')).toBeNull();
		expect(toNum('   ')).toBeNull();
		expect(toNum('\t\n')).toBeNull();
	});

	it('NaN は null を返す', () => {
		expect(toNum(NaN)).toBeNull();
	});

	it('Infinity は null を返す', () => {
		expect(toNum(Infinity)).toBeNull();
		expect(toNum(-Infinity)).toBeNull();
	});

	it('数値でない文字列は null を返す', () => {
		expect(toNum('abc')).toBeNull();
		expect(toNum('12.34.56')).toBeNull();
		expect(toNum('N/A')).toBeNull();
	});
});
