// /depth 由来の価格を出力する全経路でここを共有する（経路ごとに丸めが違うと複数ツールのクロスチェックで mid が乖離する）。計算には丸め前の生 mid を使い、出力直前に丸める。

export function isJpyPair(pair: string): boolean {
	return pair.endsWith('_jpy');
}

export function roundPrice(value: number, jpyPair: boolean): number {
	return jpyPair ? Math.round(value) : Number(value.toFixed(2));
}

// value * 10 ** digits は 2 進の乗算誤差で半刻みを取りこぼす（1.005 * 100 === 100.49999999999999）ので、10 進文字列の指数をずらして桁をシフトする。半刻みは円建て金額の Math.round と揃えて +∞ 方向。
export function roundAtDecimalDigits(value: number, digits: number): number {
	const shifted = Number(`${value}e${digits}`);
	if (Number.isFinite(shifted)) {
		const back = Number(`${Math.round(shifted)}e${-digits}`);
		if (Number.isFinite(back)) return back;
	}
	// 指数表記に化けると文字列が不正になり NaN になるので、その場合だけ素朴な乗算に落とす。
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

// 有効数字 6 桁。10 万円以上（BTC・ETH）は円の整数のまま、安いペアほど小数の桁が増える。
const PRICE_SIGNIFICANT_DIGITS = 6;
const MAX_PRICE_DECIMALS = 12;

export function priceDecimals(refPrice: number): number {
	const abs = Math.abs(refPrice);
	if (!Number.isFinite(abs) || abs === 0) return 0;
	const decimals = PRICE_SIGNIFICANT_DIGITS - 1 - Math.floor(Math.log10(abs));
	return Math.min(MAX_PRICE_DECIMALS, Math.max(0, decimals));
}

// 円の整数に丸めると、1 円前後のペアでは価格や値幅が 0 や 1 に潰れる。値幅は値幅自体ではなく価格の水準（refPrice）で桁を決める。
export function roundPriceAtLevel(value: number, refPrice: number = value, minDecimals = 0): number {
	if (!Number.isFinite(value)) return value;
	return roundAtDecimalDigits(value, Math.max(minDecimals, priceDecimals(refPrice)));
}
