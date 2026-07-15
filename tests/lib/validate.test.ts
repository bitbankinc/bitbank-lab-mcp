import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	ALLOWED_PAIRS,
	allowedOutputRoots,
	createMeta,
	DEFAULT_CHART_OUTPUT_DIR,
	ensureAllowedOutputDir,
	ensurePair,
	normalizePair,
	OUTPUT_DIR_ALLOWLIST_ENV,
	validateDate,
	validateLimit,
} from '../../lib/validate.js';

describe('normalizePair', () => {
	it('正規形式はそのまま返す', () => {
		expect(normalizePair('btc_jpy')).toBe('btc_jpy');
	});
	it('大文字を小文字に正規化する', () => {
		expect(normalizePair('BTC_JPY')).toBe('btc_jpy');
	});
	it('前後の空白を除去する', () => {
		expect(normalizePair('  eth_jpy  ')).toBe('eth_jpy');
	});
	it('null/undefined/空文字は null を返す', () => {
		expect(normalizePair(null)).toBeNull();
		expect(normalizePair(undefined)).toBeNull();
		expect(normalizePair('')).toBeNull();
	});
	it('スラッシュ区切り (BTC/JPY) は null を返す', () => {
		expect(normalizePair('BTC/JPY')).toBeNull();
	});
	it('不正形式は null を返す', () => {
		expect(normalizePair('btcjpy')).toBeNull();
		expect(normalizePair('btc-jpy')).toBeNull();
	});
});

describe('ensurePair', () => {
	it('有効なペアで ok: true を返す', () => {
		const res = ensurePair('btc_jpy');
		expect(res).toEqual({ ok: true, pair: 'btc_jpy' });
	});
	it('ALLOWED_PAIRS に含まれる全ペアが通る', () => {
		for (const pair of ALLOWED_PAIRS) {
			const res = ensurePair(pair);
			expect(res.ok).toBe(true);
		}
	});
	it('不正形式で ok: false を返す', () => {
		const res = ensurePair('invalid');
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error.type).toBe('user');
	});
	it('存在しないペアで ok: false を返す', () => {
		const res = ensurePair('zzz_jpy');
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error.message).toContain('未対応');
	});
	it('null で ok: false を返す', () => {
		const res = ensurePair(null);
		expect(res.ok).toBe(false);
	});
});

describe('ALLOWED_PAIRS は JPY 建てのみ（表示層が円前提のガード）', () => {
	// 表示層（lib/formatter.ts ほか多数）が価格に「円」を直書きしているため、
	// ALLOWED_PAIRS は現状すべて JPY クォート（*_jpy）でなければならない。
	// 非JPYペア（例: eth_btc）を追加すると表示層が一斉に誤表記になる「サイレントな潜在バグ」。
	// Pair 型は `${string}_${string}` で非JPYも型上は通るため、型では防げない。
	// → 非JPYペアの追加には表示層の quote 通貨対応が先に必要。このテストがその番人。
	it('quote 通貨が空（空集合）でないこと（番人の空振り防止）', () => {
		expect(ALLOWED_PAIRS.size).toBeGreaterThan(0);
	});
	it('全ペアの quote 通貨（pair.split("_")[1]）が jpy であること', () => {
		for (const pair of ALLOWED_PAIRS) {
			const quote = pair.split('_')[1];
			expect(quote, `${pair} は非JPY建て。追加には表示層の quote 通貨対応が先に必要`).toBe('jpy');
		}
	});
});

describe('validateLimit', () => {
	it('範囲内の整数で ok: true を返す', () => {
		expect(validateLimit(100)).toEqual({ ok: true, value: 100 });
	});
	it('最小値で ok: true を返す', () => {
		expect(validateLimit(1)).toEqual({ ok: true, value: 1 });
	});
	it('最大値で ok: true を返す', () => {
		expect(validateLimit(1000)).toEqual({ ok: true, value: 1000 });
	});
	it('カスタム範囲で動作する', () => {
		expect(validateLimit(50, 10, 100)).toEqual({ ok: true, value: 50 });
		const res = validateLimit(5, 10, 100);
		expect(res.ok).toBe(false);
	});
	it('範囲外で ok: false を返す', () => {
		expect(validateLimit(0).ok).toBe(false);
		expect(validateLimit(1001).ok).toBe(false);
		expect(validateLimit(-1).ok).toBe(false);
	});
	it('小数で ok: false を返す', () => {
		expect(validateLimit(1.5).ok).toBe(false);
	});
	it('文字列数値は変換される', () => {
		expect(validateLimit('100')).toEqual({ ok: true, value: 100 });
	});
	it('非数値で ok: false を返す', () => {
		expect(validateLimit('abc').ok).toBe(false);
		expect(validateLimit(NaN).ok).toBe(false);
	});
});

describe('validateDate', () => {
	it('YYYYMMDD 形式を受け付ける', () => {
		expect(validateDate('20250213')).toEqual({ ok: true, value: '20250213' });
	});
	it('YYYY 形式を受け付ける', () => {
		expect(validateDate('2025')).toEqual({ ok: true, value: '2025' });
	});
	it('分足タイプでは YYYYMMDD を要求する', () => {
		expect(validateDate('20250213', '1min')).toEqual({ ok: true, value: '20250213' });
		expect(validateDate('2025', '1min').ok).toBe(false);
	});
	it('時間足タイプでは YYYY に切り詰める', () => {
		expect(validateDate('20250213', '4hour')).toEqual({ ok: true, value: '2025' });
		expect(validateDate('2025', '4hour')).toEqual({ ok: true, value: '2025' });
	});
	it('不正形式で ok: false を返す', () => {
		expect(validateDate('abc').ok).toBe(false);
		expect(validateDate('2025-02-13').ok).toBe(false);
		expect(validateDate('').ok).toBe(false);
	});
});

describe('ensureAllowedOutputDir', () => {
	afterEach(() => {
		delete process.env[OUTPUT_DIR_ALLOWLIST_ENV];
	});

	it('デフォルト出力ディレクトリは許可される', () => {
		const res = ensureAllowedOutputDir(DEFAULT_CHART_OUTPUT_DIR);
		expect(res).toEqual({ ok: true, dir: resolve(DEFAULT_CHART_OUTPUT_DIR) });
	});

	it('デフォルト出力ディレクトリ配下のサブディレクトリも許可される', () => {
		const res = ensureAllowedOutputDir(join(DEFAULT_CHART_OUTPUT_DIR, 'charts', 'btc'));
		expect(res.ok).toBe(true);
	});

	it('サーバー作業ディレクトリ（cwd）と相対パスは許可される', () => {
		expect(ensureAllowedOutputDir(process.cwd()).ok).toBe(true);
		const rel = ensureAllowedOutputDir('./charts');
		expect(rel).toEqual({ ok: true, dir: join(process.cwd(), 'charts') });
	});

	it('許可 root 外の絶対パスは拒否される', () => {
		const res = ensureAllowedOutputDir('/etc/cron.d');
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error.type).toBe('user');
			expect(res.error.message).toContain('/etc/cron.d');
		}
	});

	it('.. によるトラバーサルは resolve 後のパスで拒否される', () => {
		const res = ensureAllowedOutputDir(join(DEFAULT_CHART_OUTPUT_DIR, '..', '..', '..', 'etc'));
		expect(res.ok).toBe(false);
	});

	it('許可 root のプレフィックス衝突（/mnt/user-data/outputs-evil）は拒否される', () => {
		const res = ensureAllowedOutputDir(`${DEFAULT_CHART_OUTPUT_DIR}-evil`);
		expect(res.ok).toBe(false);
	});

	it('環境変数で追加した root 配下は許可される', () => {
		process.env[OUTPUT_DIR_ALLOWLIST_ENV] = '/srv/charts:/opt/reports';
		expect(ensureAllowedOutputDir('/srv/charts/btc').ok).toBe(true);
		expect(ensureAllowedOutputDir('/opt/reports').ok).toBe(true);
		expect(ensureAllowedOutputDir('/srv/other').ok).toBe(false);
	});

	it('環境変数が空文字・空白のみの場合は root を追加しない', () => {
		process.env[OUTPUT_DIR_ALLOWLIST_ENV] = ' : ';
		expect(allowedOutputRoots()).toEqual([resolve(DEFAULT_CHART_OUTPUT_DIR), process.cwd()]);
	});
});

describe('createMeta', () => {
	it('pair と fetchedAt を含む', () => {
		const meta = createMeta('btc_jpy');
		expect(meta.pair).toBe('btc_jpy');
		expect(meta.fetchedAt).toBeDefined();
		expect(typeof meta.fetchedAt).toBe('string');
	});
	it('追加フィールドをマージする', () => {
		const meta = createMeta('btc_jpy', { candleType: '1day' });
		expect(meta).toHaveProperty('candleType', '1day');
	});
});
