/**
 * auth.ts の署名テストベクタ。
 *
 * 既知の入力（秘密鍵・requestTime・timeWindow・パス・ボディ）から
 * 期待される署名を検証する。実 API キーは使わない。
 *
 * ACCESS-TIME-WINDOW 方式:
 *   署名対象 = requestTime + timeWindow + path/body
 *
 * @see https://github.com/bitbankinc/bitbank-api-docs/blob/master/rest-api.md
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
	buildGetMessage,
	buildPostMessage,
	createGetAuthHeaders,
	createPostAuthHeaders,
	sign,
} from '../../src/private/auth.js';

// テストベクタ: 固定の秘密鍵から手計算した署名
// 検証方法: echo -n "<message>" | openssl dgst -sha256 -hmac "<secret>"
const TEST_SECRET = 'test_secret_key_for_signing_12345'; // gitleaks:allow（公開テストベクタ）

describe('auth.ts 署名テストベクタ', () => {
	describe('sign()', () => {
		it('HMAC-SHA256 で正しい署名を生成する', () => {
			// echo -n "hello" | openssl dgst -sha256 -hmac "test_secret_key_for_signing_12345"
			const result = sign(TEST_SECRET, 'hello');
			expect(result).toBe('660734c3a029a8c28d20d8ba3471667e260d9eafb4cd0701ca3fc04fafc9ef29');
		});

		it('空文字列の署名が正しい', () => {
			// echo -n "" | openssl dgst -sha256 -hmac "test_secret_key_for_signing_12345"
			const result = sign(TEST_SECRET, '');
			expect(result).toBe('7ed44d7d96ada1a991bab26f803a3a87428d33741a1ffb21cd4ad7fc80d42401');
		});
	});

	describe('buildGetMessage()', () => {
		it('requestTime + timeWindow + path を連結する', () => {
			const message = buildGetMessage('1721121776490', '5000', '/v1/user/assets');
			expect(message).toBe('17211217764905000/v1/user/assets');
		});

		it('クエリパラメータ付きパスも正しく連結する', () => {
			const message = buildGetMessage('1721121776490', '5000', '/v1/user/spot/trade_history?pair=btc_jpy&count=10');
			expect(message).toBe('17211217764905000/v1/user/spot/trade_history?pair=btc_jpy&count=10');
		});
	});

	describe('buildPostMessage()', () => {
		it('requestTime + timeWindow + JSON body を連結する', () => {
			const body = '{"pair":"xrp_jpy","price":"20","amount":"1","side":"buy","type":"limit"}';
			const message = buildPostMessage('1721121776490', '5000', body);
			expect(message).toBe('17211217764905000' + body);
		});
	});

	describe('公式ドキュメントのテストベクタ検証', () => {
		// 公式ドキュメント記載の例:
		// SECRET = "hoge"
		// ACCESS_REQUEST_TIME = 1721121776490
		// ACCESS_TIME_WINDOW = 1000
		// GET /v1/user/assets
		// 署名対象 = "17211217764901000/v1/user/assets"
		// 期待署名 = "9ec5745960d05573c8fb047cdd9191bd0c6ede26f07700bb40ecf1a3920abae8"
		it('GET: 公式ドキュメントの署名例と一致する', () => {
			const message = buildGetMessage('1721121776490', '1000', '/v1/user/assets');
			expect(message).toBe('17211217764901000/v1/user/assets');
			const signature = sign('hoge', message);
			expect(signature).toBe('9ec5745960d05573c8fb047cdd9191bd0c6ede26f07700bb40ecf1a3920abae8');
		});

		// POST の公式例:
		// SECRET = "hoge"
		// ACCESS_REQUEST_TIME = 1721121776490
		// ACCESS_TIME_WINDOW = 1000
		// BODY = '{"pair": "xrp_jpy", "price": "20", "amount": "1","side": "buy", "type": "limit"}'
		// 期待署名 = "7868665738ae3f8a796224e0413c1351ddd7ec2af121db12815c0a5b74b8764c"
		it('POST: 公式ドキュメントの署名例と一致する', () => {
			const body = '{"pair": "xrp_jpy", "price": "20", "amount": "1","side": "buy", "type": "limit"}';
			const message = buildPostMessage('1721121776490', '1000', body);
			expect(message).toBe('17211217764901000' + body);
			const signature = sign('hoge', message);
			expect(signature).toBe('7868665738ae3f8a796224e0413c1351ddd7ec2af121db12815c0a5b74b8764c');
		});
	});

	describe('異なる入力で異なる署名が生成される', () => {
		it('パスが異なれば署名が異なる', () => {
			const sig1 = sign(TEST_SECRET, buildGetMessage('1709000000000', '5000', '/v1/user/assets'));
			const sig2 = sign(TEST_SECRET, buildGetMessage('1709000000000', '5000', '/v1/user/spot/trade_history'));
			expect(sig1).not.toBe(sig2);
		});

		it('requestTime が異なれば署名が異なる', () => {
			const sig1 = sign(TEST_SECRET, buildGetMessage('1709000000000', '5000', '/v1/user/assets'));
			const sig2 = sign(TEST_SECRET, buildGetMessage('1709000000001', '5000', '/v1/user/assets'));
			expect(sig1).not.toBe(sig2);
		});

		it('timeWindow が異なれば署名が異なる', () => {
			const sig1 = sign(TEST_SECRET, buildGetMessage('1709000000000', '5000', '/v1/user/assets'));
			const sig2 = sign(TEST_SECRET, buildGetMessage('1709000000000', '10000', '/v1/user/assets'));
			expect(sig1).not.toBe(sig2);
		});

		it('秘密鍵が異なれば署名が異なる', () => {
			const message = buildGetMessage('1709000000000', '5000', '/v1/user/assets');
			const sig1 = sign('secret_a', message);
			const sig2 = sign('secret_b', message);
			expect(sig1).not.toBe(sig2);
		});
	});

	describe('createGetAuthHeaders / createPostAuthHeaders', () => {
		afterEach(() => {
			delete process.env.BITBANK_API_KEY;
			delete process.env.BITBANK_API_SECRET;
		});

		it('固定 requestTime を注入すると決定的な出力を返す', () => {
			process.env.BITBANK_API_KEY = 'test_key';
			process.env.BITBANK_API_SECRET = 'test_secret';
			const h1 = createGetAuthHeaders('/v1/user/assets', '1709000000000');
			const h2 = createGetAuthHeaders('/v1/user/assets', '1709000000000');
			expect(h1['ACCESS-SIGNATURE']).toBe(h2['ACCESS-SIGNATURE']);
			expect(h1['ACCESS-REQUEST-TIME']).toBe('1709000000000');
		});

		it('POST 用ヘッダーで固定 requestTime が反映される', () => {
			process.env.BITBANK_API_KEY = 'test_key';
			process.env.BITBANK_API_SECRET = 'test_secret';
			const h = createPostAuthHeaders('{"pair":"btc_jpy"}', '1709000000000');
			expect(h['ACCESS-KEY']).toBe('test_key');
			expect(h['ACCESS-REQUEST-TIME']).toBe('1709000000000');
			expect(h['ACCESS-TIME-WINDOW']).toBe('5000');
			expect(h['ACCESS-SIGNATURE']).toBeTruthy();
		});
	});
});
