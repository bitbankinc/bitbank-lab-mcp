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

// 取引所の価格（気配・板・ローソク足）は呼び値の刻みに乗っているので、数値の小数の桁数がそのまま刻みの桁になる。
export function fractionDigits(value: number): number {
	if (!Number.isFinite(value)) return 0;
	const [mantissa, exponent] = String(Math.abs(value)).split('e');
	const decimals = mantissa.split('.')[1]?.length ?? 0;
	return Math.max(0, decimals - Number(exponent ?? 0));
}

// 価格の水準の桁だけで丸めると、刻みの細かいペア（1,000 円台で 0.001 円刻みなど）で中値が最良気配の外に出るので、気配の桁より粗くしない。
export function midPriceDecimals(bestBid: number, bestAsk: number): number {
	return Math.max(priceDecimals((bestBid + bestAsk) / 2), fractionDigits(bestBid), fractionDigits(bestAsk));
}

// /depth 由来の中値を出す全経路でここを共有する（経路ごとに丸めが違うと複数ツールのクロスチェックで mid が乖離する）。計算には丸め前の生 mid を使い、出力直前に丸める。
export function roundMidPrice(bestBid: number, bestAsk: number): number {
	return roundAtDecimalDigits((bestBid + bestAsk) / 2, midPriceDecimals(bestBid, bestAsk));
}

export function roundSpread(bestBid: number, bestAsk: number): number {
	return roundAtDecimalDigits(bestAsk - bestBid, Math.max(fractionDigits(bestBid), fractionDigits(bestAsk)));
}
