import { describe, expect, it } from 'vitest';
import {
	formatCurrency,
	formatCurrencyShort,
	formatDeviation,
	formatFixed,
	formatInt,
	formatPair,
	formatPctFromRatio,
	formatPercent,
	formatPrice,
	formatPriceAtLevel,
	formatPriceDecimals,
	formatPriceJPY,
	formatRounded,
	formatSummary,
	formatTrendArrow,
	formatTrendSymbol,
	formatVolumeJPY,
	formatYenAmount,
} from '../../lib/formatter.js';

describe('formatPair', () => {
	it('アンダースコアをスラッシュに変換し大文字化する', () => {
		expect(formatPair('btc_jpy')).toBe('BTC/JPY');
	});
	it('空文字は空文字を返す（アンダースコアなし）', () => {
		expect(formatPair('')).toBe('');
	});
});

describe('formatPrice', () => {
	it('100 円以上は従来どおり小数 3 桁まで、100 円未満は刻み（0.0001 円）まで出す', () => {
		expect(formatPrice(15_234_567.891234)).toBe('¥15,234,567.891');
		expect(formatPrice(2500.123)).toBe('¥2,500.123');
		expect(formatPrice(31.2345)).toBe('¥31.2345');
	});
	it('JPY ペアは ¥ プレフィックス付きで返す', () => {
		const result = formatPrice(100000, 'btc_jpy');
		expect(result).toContain('¥');
		expect(result).toContain('100,000');
	});
	it('非 JPY ペアは ¥ なしで返す', () => {
		const result = formatPrice(0.05, 'eth_btc');
		expect(result).not.toContain('¥');
	});
	it('pair 省略時は JPY として扱う', () => {
		const result = formatPrice(50000);
		expect(result).toContain('¥');
	});
	it('null/undefined は N/A を返す', () => {
		expect(formatPrice(null)).toBe('N/A');
		expect(formatPrice(undefined)).toBe('N/A');
	});
	it('Infinity は N/A を返す', () => {
		expect(formatPrice(Infinity)).toBe('N/A');
	});
});

describe('formatPriceJPY', () => {
	it('計算した価格は価格の水準の桁で出す（10 万円以上は円の整数）', () => {
		expect(formatPriceJPY(15_234_567.6)).toBe('15,234,568円');
		expect(formatPriceJPY(31.234567)).toBe('31.2346円');
	});
	it('値幅は refPrice の水準で桁を決める', () => {
		expect(formatPriceJPY(45_678.9, 15_000_000)).toBe('45,679円');
		expect(formatPriceJPY(0.987654, 31.2345)).toBe('0.9877円');
	});
	it('円サフィックス付きで四捨五入する', () => {
		expect(formatPriceJPY(123456.7)).toBe('123,457円');
	});
	it('null は n/a を返す', () => {
		expect(formatPriceJPY(null)).toBe('n/a');
	});
});

describe('formatYenAmount', () => {
	it('金額は円の整数で出す', () => {
		expect(formatYenAmount(1234.56)).toBe('1,235円');
		expect(formatYenAmount(null)).toBe('n/a');
	});
});

describe('formatPriceAtLevel', () => {
	it('価格の水準の桁で出し、円は付けない', () => {
		expect(formatPriceAtLevel(15_234_567.6)).toBe('15,234,568');
		expect(formatPriceAtLevel(0.987654, 31.2345)).toBe('0.9877');
	});
});

describe('formatPriceDecimals', () => {
	it('0 桁では円の整数に丸めて桁区切りを付ける', () => {
		expect(formatPriceDecimals(15_234_567.6, 0)).toBe('15,234,568');
	});
	it('指定の桁で丸め、末尾の 0 は出さない', () => {
		expect(formatPriceDecimals(0.0512345678, 7)).toBe('0.0512346');
		expect(formatPriceDecimals(1.5, 5)).toBe('1.5');
	});
	it('負の値も同じ桁で出す', () => {
		expect(formatPriceDecimals(-0.0012345678, 7)).toBe('-0.0012346');
	});
});

describe('formatCurrency', () => {
	it('JPY ペアは JPY サフィックス付きで返す', () => {
		const result = formatCurrency(50000, 'btc_jpy');
		expect(result).toContain('JPY');
	});
	it('非 JPY ペアは小数2桁で返す', () => {
		expect(formatCurrency(0.123, 'eth_btc')).toBe('0.12');
	});
	it('null は n/a を返す', () => {
		expect(formatCurrency(null)).toBe('n/a');
	});
});

describe('formatCurrencyShort', () => {
	it('1000以上の JPY は k 表記する', () => {
		expect(formatCurrencyShort(12000, 'btc_jpy')).toBe('12k JPY');
	});
	it('1000未満の JPY はそのまま表示する', () => {
		const result = formatCurrencyShort(500, 'btc_jpy');
		expect(result).toContain('500');
		expect(result).toContain('JPY');
	});
	it('null は n/a を返す', () => {
		expect(formatCurrencyShort(null)).toBe('n/a');
	});
});

describe('formatPercent', () => {
	it('デフォルトは小数1桁の % 表記', () => {
		expect(formatPercent(1.5)).toBe('1.5%');
	});
	it('sign: true で正数に + を付ける', () => {
		expect(formatPercent(1.5, { sign: true })).toBe('+1.5%');
	});
	it('負数は + なし', () => {
		expect(formatPercent(-2.3, { sign: true })).toBe('-2.3%');
	});
	it('multiply: true で 100 倍する', () => {
		expect(formatPercent(0.05, { multiply: true })).toBe('5.0%');
	});
	it('digits で小数桁数を変更できる', () => {
		expect(formatPercent(1.234, { digits: 2 })).toBe('1.23%');
	});
	it('null は n/a を返す', () => {
		expect(formatPercent(null)).toBe('n/a');
	});
});

describe('formatVolumeJPY', () => {
	it('1億以上は億円表記', () => {
		expect(formatVolumeJPY(100_000_000)).toBe('1.0億円');
		expect(formatVolumeJPY(250_000_000)).toBe('2.5億円');
	});
	it('1億未満は万円表記', () => {
		expect(formatVolumeJPY(50_000_000)).toBe('5000万円');
	});
	it('null は n/a を返す', () => {
		expect(formatVolumeJPY(null)).toBe('n/a');
	});
});

describe('formatFixed', () => {
	it('8桁固定小数点で整形する', () => {
		expect(formatFixed(0.123456789)).toBe('0.12345679');
	});
	it('桁数を指定できる', () => {
		expect(formatFixed(1.5, 2)).toBe('1.50');
	});
	it('null/undefined/NaN は n/a を返す', () => {
		expect(formatFixed(null)).toBe('n/a');
		expect(formatFixed(undefined)).toBe('n/a');
		expect(formatFixed('abc')).toBe('n/a');
	});
});

describe('formatRounded', () => {
	it('四捨五入してロケール整形する', () => {
		expect(formatRounded(12345.6)).toBe('12,346');
	});
	it('null/NaN は n/a を返す', () => {
		expect(formatRounded(null)).toBe('n/a');
		expect(formatRounded('abc')).toBe('n/a');
	});
});

describe('formatInt', () => {
	it('数値を文字列化する', () => {
		expect(formatInt(42)).toBe('42');
	});
	it('null/NaN は n/a を返す', () => {
		expect(formatInt(null)).toBe('n/a');
		expect(formatInt('abc')).toBe('n/a');
	});
});

describe('formatPctFromRatio', () => {
	it('比率を百分率に変換する', () => {
		expect(formatPctFromRatio(0.05)).toBe('5.0%');
	});
	it('桁数を指定できる', () => {
		expect(formatPctFromRatio(0.1234, 2)).toBe('12.34%');
	});
	it('null/NaN は n/a を返す', () => {
		expect(formatPctFromRatio(null)).toBe('n/a');
	});
});

describe('formatTrendSymbol', () => {
	it('正の傾きは 📈 を返す', () => {
		expect(formatTrendSymbol(1)).toBe('📈');
	});
	it('負の傾きは 📉 を返す', () => {
		expect(formatTrendSymbol(-1)).toBe('📉');
	});
	it('ゼロは ➡️ を返す', () => {
		expect(formatTrendSymbol(0)).toBe('➡️');
	});
	it('null は ➡️ を返す', () => {
		expect(formatTrendSymbol(null)).toBe('➡️');
	});
});

describe('formatTrendArrow', () => {
	it('大幅に上回る場合は ⬆⬆ を返す', () => {
		expect(formatTrendArrow(1.1, 1.0)).toBe('⬆⬆');
	});
	it('やや上回る場合は ⬆ を返す', () => {
		expect(formatTrendArrow(1.03, 1.0)).toBe('⬆');
	});
	it('同等の場合は → を返す', () => {
		expect(formatTrendArrow(1.0, 1.0)).toBe('→');
	});
	it('やや下回る場合は ⬇ を返す', () => {
		expect(formatTrendArrow(0.97, 1.0)).toBe('⬇');
	});
	it('大幅に下回る場合は ⬇⬇ を返す', () => {
		expect(formatTrendArrow(0.9, 1.0)).toBe('⬇⬇');
	});
	it('null は → を返す', () => {
		expect(formatTrendArrow(null, 1.0)).toBe('→');
		expect(formatTrendArrow(1.0, null)).toBe('→');
	});
});

describe('formatDeviation', () => {
	it('上方乖離を整形する', () => {
		const result = formatDeviation(100, 102);
		expect(result).toContain('+2.0%');
		expect(result).toContain('上方');
	});
	it('下方乖離を整形する', () => {
		const result = formatDeviation(100, 98);
		expect(result).toContain('-2.0%');
		expect(result).toContain('下方');
	});
	it('close が null の場合は n/a を返す', () => {
		expect(formatDeviation(null, 100)).toBe('n/a');
	});
	it('ref が null の場合は n/a を返す', () => {
		expect(formatDeviation(100, null)).toBe('n/a');
	});
	it('close が 0 の場合は n/a を返す（ゼロ除算防止）', () => {
		expect(formatDeviation(0, 100)).toBe('n/a');
	});
	it('ref が 0 でも close が非ゼロなら計算する', () => {
		const result = formatDeviation(100, 0);
		expect(result).toContain('下方');
	});
});

describe('formatSummary', () => {
	it('pair のみで基本サマリーを生成する', () => {
		const result = formatSummary({ pair: 'btc_jpy' });
		expect(result).toContain('BTC/JPY');
	});
	it('totalItems 指定でローソク足取得サマリーを生成する', () => {
		const result = formatSummary({ pair: 'btc_jpy', timeframe: '1day', totalItems: 30 });
		expect(result).toContain('ローソク足30本取得');
		expect(result).toContain('1day');
	});
	it('latest 指定で中値を表示する', () => {
		const result = formatSummary({ pair: 'btc_jpy', latest: 15000000 });
		expect(result).toContain('中値=');
	});
	it('extra を末尾に追加する', () => {
		const result = formatSummary({ pair: 'btc_jpy', extra: '追加情報' });
		expect(result).toContain('追加情報');
	});
});
