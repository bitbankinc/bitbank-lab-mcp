/**
 * MCP stdio E2E テスト
 *
 * 実際にサーバーをサブプロセスで起動し、MCP クライアントから
 * tools/list, tools/call を送って応答を検証する。
 * 外部 API は mock-server-entry.ts 経由でモック。
 *
 * サブプロセスが起動直後に異常終了すると、connect() は opaque な
 * "Connection closed" を投げる。原因特定のため stderr をテスト側で
 * 収集し、connect 失敗時にエラーメッセージへ畳み込む。
 */
import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	candlesBtcJpy1day,
	candlesBtcJpy1day120,
	candlesBtcJpy5min,
	depthBtcJpy,
	tickerBtcJpy,
	tickerError,
	tickersJpy,
	transactionsBtcJpy,
} from '../fixtures/bitbank-api.js';
import { assertDescriptionQuality, assertFailQuality, assertOkQuality } from './_qualityAssertions.js';

const ENTRY = new URL('./mock-server-entry.ts', import.meta.url).pathname;
const TSX_BIN = new URL('../../node_modules/.bin/tsx', import.meta.url).pathname;

if (!existsSync(TSX_BIN)) {
	throw new Error(
		`tsx バイナリが見つかりません: ${TSX_BIN}\n\`npm install\` を実行してから E2E を再実行してください。`,
	);
}

function createTransport(mockResponses: Record<string, unknown> = {}, env: Record<string, string> = {}) {
	return new StdioClientTransport({
		command: TSX_BIN,
		args: [ENTRY],
		env: {
			...process.env,
			MOCK_RESPONSES: JSON.stringify(mockResponses),
			...env,
		},
		stderr: 'pipe',
	});
}

/**
 * transport.stderr の Readable を購読し、累積した文字列を返すクロージャを返す。
 * 子プロセスが initialize を返す前に死んだ場合、Client.connect() は
 * "Connection closed" としか言わないため、stderr バッファを必ず捕捉してエラーに添える。
 */
function captureStderr(transport: StdioClientTransport): () => string {
	const chunks: string[] = [];
	const stream = transport.stderr;
	if (stream) {
		stream.setEncoding?.('utf8');
		stream.on('data', (chunk: string | Buffer) => {
			chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
		});
	}
	return () => chunks.join('');
}

async function connectWithDiagnostics(client: Client, transport: StdioClientTransport): Promise<void> {
	const readStderr = captureStderr(transport);
	try {
		await client.connect(transport);
	} catch (err) {
		const stderr = readStderr().trim();
		const detail = stderr
			? `\n--- subprocess stderr ---\n${stderr}\n--------------------------`
			: '\n(stderr is empty)';
		throw new Error(
			`MCP stdio client.connect() に失敗しました: ${(err as Error).message}\n` +
				`command=${TSX_BIN} entry=${ENTRY}${detail}`,
		);
	}
}

/** content からテキストを抽出するヘルパー */
function extractText(result: Awaited<ReturnType<Client['callTool']>>): string {
	return (result.content as Array<{ type: string; text: string }>)
		.filter((c) => c.type === 'text')
		.map((c) => c.text)
		.join('\n');
}

// ============================================================
// tools/list
// ============================================================
describe('MCP stdio E2E', () => {
	describe('tools/list', () => {
		let client: Client;

		beforeAll(async () => {
			client = new Client({ name: 'e2e-test', version: '0.0.1' });
			await connectWithDiagnostics(client, createTransport());
		}, 30_000);
		afterAll(async () => {
			await client.close();
		});

		it('全 public ツールが登録されている', async () => {
			// tool-registry の allToolDefs と突合し、登録漏れを検知する
			const { allToolDefs } = await import('../../src/tool-registry.js');
			const expected = allToolDefs.map((d) => d.name);

			const result = await client.listTools();
			const actual = result.tools.map((t) => t.name);

			for (const name of expected) {
				expect(actual, `ツール "${name}" が tools/list に含まれていない`).toContain(name);
			}
		});

		it('全ツールの description が十分に具体的である', async () => {
			const result = await client.listTools();
			assertDescriptionQuality(result.tools);
		});
	});

	// ============================================================
	// get_ticker
	// ============================================================
	describe('get_ticker', () => {
		let client: Client;

		beforeAll(async () => {
			client = new Client({ name: 'e2e-test', version: '0.0.1' });
			await connectWithDiagnostics(client, createTransport({ 'btc_jpy/ticker': tickerBtcJpy }));
		}, 30_000);
		afterAll(async () => {
			await client.close();
		});

		it('正常系: btc_jpy の ticker を取得できる', async () => {
			const result = await client.callTool({ name: 'get_ticker', arguments: { pair: 'btc_jpy' } });
			const text = extractText(result);
			expect(text).toContain('BTC/JPY');
			expect(text).toContain('15,500,000');
			assertOkQuality(result);
		});

		it('バリデーションエラー: 未対応ペア', async () => {
			const result = await client.callTool({ name: 'get_ticker', arguments: { pair: 'unknown_jpy' } });
			assertFailQuality(result);
		});
	});

	describe('get_ticker — 上流エラー', () => {
		let client: Client;

		beforeAll(async () => {
			client = new Client({ name: 'e2e-test', version: '0.0.1' });
			await connectWithDiagnostics(client, createTransport({ 'btc_jpy/ticker': tickerError }));
		}, 30_000);
		afterAll(async () => {
			await client.close();
		});

		it('success:0 で ok:false を返す', async () => {
			const result = await client.callTool({ name: 'get_ticker', arguments: { pair: 'btc_jpy' } });
			assertFailQuality(result);
		});
	});

	// ============================================================
	// get_orderbook
	// ============================================================
	describe('get_orderbook', () => {
		let client: Client;

		beforeAll(async () => {
			client = new Client({ name: 'e2e-test', version: '0.0.1' });
			await connectWithDiagnostics(client, createTransport({ 'btc_jpy/depth': depthBtcJpy }));
		}, 30_000);
		afterAll(async () => {
			await client.close();
		});

		it('summary モード: 板情報が返る', async () => {
			const result = await client.callTool({ name: 'get_orderbook', arguments: { pair: 'btc_jpy', mode: 'summary' } });
			const text = extractText(result);
			expect(text).toContain('買い板');
			expect(text).toContain('売り板');
			expect(text).toContain('スプレッド');
			assertOkQuality(result);
		});

		it('pressure モード: 圧力分析が返る', async () => {
			const result = await client.callTool({ name: 'get_orderbook', arguments: { pair: 'btc_jpy', mode: 'pressure' } });
			const text = extractText(result);
			expect(text).toContain('板圧力分析');
			assertOkQuality(result);
		});

		it('バリデーションエラー: 未対応ペア', async () => {
			const result = await client.callTool({ name: 'get_orderbook', arguments: { pair: 'unknown_jpy' } });
			assertFailQuality(result);
		});
	});

	// ============================================================
	// get_candles
	// ============================================================
	describe('get_candles', () => {
		let client: Client;

		beforeAll(async () => {
			client = new Client({ name: 'e2e-test', version: '0.0.1' });
			await connectWithDiagnostics(client, createTransport({ 'btc_jpy/candlestick': candlesBtcJpy1day }));
		}, 30_000);
		afterAll(async () => {
			await client.close();
		});

		it('1day ローソク足を取得できる', async () => {
			const result = await client.callTool({
				name: 'get_candles',
				arguments: { pair: 'btc_jpy', type: '1day', limit: 5 },
			});
			const text = extractText(result);
			// OHLCV データがテキストに含まれる
			expect(text).toContain('BTC/JPY');
			expect(text).toContain('OHLCV');
			assertOkQuality(result);
		});

		it('バリデーションエラー: 不正な type は SDK 側で弾かれる', async () => {
			try {
				const result = await client.callTool({
					name: 'get_candles',
					arguments: { pair: 'btc_jpy', type: 'invalid' },
				});
				// SDK が resolve した場合（新しいバージョン）
				expect(result.isError).toBe(true);
				const text = extractText(result);
				expect(text).toMatch(/invalid/i);
			} catch (err) {
				// SDK が reject した場合（古いバージョン）
				expect(String(err)).toMatch(/invalid/i);
			}
		});
	});

	// ============================================================
	// get_transactions
	// ============================================================
	describe('get_transactions', () => {
		let client: Client;

		beforeAll(async () => {
			client = new Client({ name: 'e2e-test', version: '0.0.1' });
			await connectWithDiagnostics(client, createTransport({ 'btc_jpy/transactions': transactionsBtcJpy }));
		}, 30_000);
		afterAll(async () => {
			await client.close();
		});

		it('約定履歴を取得できる', async () => {
			const result = await client.callTool({
				name: 'get_transactions',
				arguments: { pair: 'btc_jpy' },
			});
			const text = extractText(result);
			expect(text).toContain('BTC/JPY');
			expect(text).toContain('取引');
			assertOkQuality(result);
		});

		it('買い/売り件数が正しくカウントされる', async () => {
			const result = await client.callTool({
				name: 'get_transactions',
				arguments: { pair: 'btc_jpy' },
			});
			const text = extractText(result);
			// フィクスチャ: buy 2件, sell 1件
			expect(text).toMatch(/買い.*2/);
			expect(text).toMatch(/売り.*1/);
		});
	});

	// ============================================================
	// get_tickers_jpy
	// ============================================================
	describe('get_tickers_jpy', () => {
		let client: Client;

		beforeAll(async () => {
			client = new Client({ name: 'e2e-test', version: '0.0.1' });
			await connectWithDiagnostics(client, createTransport({ tickers_jpy: tickersJpy }));
		}, 30_000);
		afterAll(async () => {
			await client.close();
		});

		it('複数ペアのティッカーを取得できる', async () => {
			const result = await client.callTool({ name: 'get_tickers_jpy', arguments: {} });
			const text = extractText(result);
			expect(text).toContain('BTC/JPY');
			expect(text).toContain('ETH/JPY');
			assertOkQuality(result);
		});
	});

	// ============================================================
	// get_flow_metrics（内部で get_transactions を呼ぶ）
	// ============================================================
	describe('get_flow_metrics', () => {
		let client: Client;

		beforeAll(async () => {
			client = new Client({ name: 'e2e-test', version: '0.0.1' });
			await connectWithDiagnostics(client, createTransport({ 'btc_jpy/transactions': transactionsBtcJpy }));
		}, 30_000);
		afterAll(async () => {
			await client.close();
		});

		it('フロー分析結果が返る', async () => {
			const result = await client.callTool({
				name: 'get_flow_metrics',
				arguments: { pair: 'btc_jpy', limit: 3 },
			});
			const text = extractText(result);
			// CVD やアグレッサー比率がテキストに含まれる
			expect(text).toContain('CVD');
			expect(text).toContain('BTC/JPY');
			assertOkQuality(result);
		});
	});

	// ============================================================
	// get_volatility_metrics（内部で get_candles を呼ぶ）
	// ============================================================
	describe('get_volatility_metrics', () => {
		let client: Client;

		beforeAll(async () => {
			client = new Client({ name: 'e2e-test', version: '0.0.1' });
			await connectWithDiagnostics(client, createTransport({ 'btc_jpy/candlestick': candlesBtcJpy1day }));
		}, 30_000);
		afterAll(async () => {
			await client.close();
		});

		it('ボラティリティ指標が返る', async () => {
			const result = await client.callTool({
				name: 'get_volatility_metrics',
				arguments: { pair: 'btc_jpy', type: '1day' },
			});
			const text = extractText(result);
			expect(text).toMatch(/BTC[_/]JPY/);
			expect(text).toContain('RV');
			expect(text).toContain('ATR');
			// デフォルト view=summary は意図的に1行凝縮フォーマット
			assertOkQuality(result, { minLines: 1 });
		});
	});

	// ============================================================
	// analyze_indicators（内部で get_candles を呼ぶ、26本以上必要）
	// ============================================================
	describe('analyze_indicators', () => {
		let client: Client;

		beforeAll(async () => {
			client = new Client({ name: 'e2e-test', version: '0.0.1' });
			await connectWithDiagnostics(client, createTransport({ 'btc_jpy/candlestick': candlesBtcJpy1day120 }));
		}, 30_000);
		afterAll(async () => {
			await client.close();
		});

		it('テクニカル指標が返る', async () => {
			const result = await client.callTool({
				name: 'analyze_indicators',
				arguments: { pair: 'btc_jpy', type: '1day' },
			});
			const text = extractText(result);
			expect(text).toMatch(/BTC[_/]JPY/);
			// RSI, MACD, SMA のいずれかが含まれる
			expect(text).toMatch(/RSI|MACD|SMA/);
			assertOkQuality(result);
		});
	});

	// ============================================================
	// detect_patterns（内部で get_candles を呼ぶ、20本以上必要）
	// ============================================================
	describe('detect_patterns', () => {
		let client: Client;

		beforeAll(async () => {
			client = new Client({ name: 'e2e-test', version: '0.0.1' });
			await connectWithDiagnostics(client, createTransport({ 'btc_jpy/candlestick': candlesBtcJpy1day120 }));
		}, 30_000);
		afterAll(async () => {
			await client.close();
		});

		it('パターン検出結果が返る', async () => {
			const result = await client.callTool({
				name: 'detect_patterns',
				arguments: { pair: 'btc_jpy', type: '1day', limit: 90 },
			});
			const text = extractText(result);
			expect(text).toMatch(/BTC[_/]JPY/);
			expect(text.length).toBeGreaterThan(30);
			assertOkQuality(result);
		});
	});

	// ============================================================
	// detect_macd_cross（内部で analyze_indicators → get_candles）
	// ============================================================
	describe('detect_macd_cross', () => {
		let client: Client;

		beforeAll(async () => {
			client = new Client({ name: 'e2e-test', version: '0.0.1' });
			await connectWithDiagnostics(client, createTransport({ 'btc_jpy/candlestick': candlesBtcJpy1day120 }));
		}, 30_000);
		afterAll(async () => {
			await client.close();
		});

		it('MACD クロス検出結果が返る', async () => {
			const result = await client.callTool({
				name: 'detect_macd_cross',
				arguments: { pair: 'btc_jpy' },
			});
			const text = extractText(result);
			expect(text).toMatch(/BTC[_/]JPY|MACD/i);
			expect(text.length).toBeGreaterThan(30);
			assertOkQuality(result);
		});
	});

	// ============================================================
	// detect_whale_events（内部で getDepth + getCandles(5min)）
	// ============================================================
	describe('detect_whale_events', () => {
		let client: Client;

		beforeAll(async () => {
			client = new Client({ name: 'e2e-test', version: '0.0.1' });
			await connectWithDiagnostics(
				client,
				createTransport({
					'btc_jpy/depth': depthBtcJpy,
					'btc_jpy/candlestick': candlesBtcJpy5min,
				}),
			);
		}, 30_000);
		afterAll(async () => {
			await client.close();
		});

		it('ホエールイベント検出結果が返る', async () => {
			const result = await client.callTool({
				name: 'detect_whale_events',
				arguments: { pair: 'btc_jpy', lookback: '1hour', minSize: 0.1 },
			});
			const text = extractText(result);
			expect(text).toMatch(/BTC[_/]JPY/i);
			expect(text.length).toBeGreaterThan(30);
			assertOkQuality(result);
		});
	});

	// ============================================================
	// analyze_market_signal（内部で candles + transactions + indicators）
	// ============================================================
	describe('analyze_market_signal', () => {
		let client: Client;

		beforeAll(async () => {
			client = new Client({ name: 'e2e-test', version: '0.0.1' });
			await connectWithDiagnostics(
				client,
				createTransport({
					'btc_jpy/candlestick': candlesBtcJpy1day120,
					'btc_jpy/transactions': transactionsBtcJpy,
				}),
			);
		}, 30_000);
		afterAll(async () => {
			await client.close();
		});

		it('市場シグナル分析結果が返る', async () => {
			const result = await client.callTool({
				name: 'analyze_market_signal',
				arguments: { pair: 'btc_jpy' },
			});
			const text = extractText(result);
			expect(text).toMatch(/BTC[_/]JPY/);
			expect(text.length).toBeGreaterThan(50);
			assertOkQuality(result);
		});
	});
});
