import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nowIso, today } from './datetime.js';

const LOG_DIR = process.env.LOG_DIR || './logs';
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LEVELS: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const THRESH = LEVELS[LOG_LEVEL] ?? LEVELS.info;

function ensureDir(dir: string) {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJsonl(file: string, obj: unknown) {
	ensureDir(path.dirname(file));
	fs.appendFileSync(file, `${JSON.stringify(obj)}\n`);
}

// ── チェーンハッシュ（取引操作ログ専用） ──

let lastTradeHash = '0'.repeat(64);

/** チェーンハッシュ付きで取引操作ログを書き込む */
function writeTradeJsonl(file: string, record: Record<string, unknown>) {
	ensureDir(path.dirname(file));
	const withChain = { ...record, _prevHash: lastTradeHash };
	const json = JSON.stringify(withChain);
	lastTradeHash = createHash('sha256').update(json).digest('hex');
	const finalRecord = { ...withChain, _hash: lastTradeHash };
	fs.appendFileSync(file, `${JSON.stringify(finalRecord)}\n`);
}

export function log(level: 'error' | 'warn' | 'info' | 'debug', event: Record<string, unknown>): void {
	if ((LEVELS[level] ?? 2) > THRESH) return;
	const date = today('YYYY-MM-DD');
	const file = path.join(LOG_DIR, `${date}.jsonl`);
	const record = { ts: nowIso(), level, ...event } as const;
	try {
		writeJsonl(file, record);
	} catch {
		// best-effort: ignore log failures
	}
}

/** ログ出力前に機密フィールドをマスクする */
// 方針（残高・注文数量・価格）:
// - SENSITIVE_KEYS は「認証・署名・確認トークン」系のみを対象とする。bitbank API キー／シークレット／
//   confirmation_token のログ混入を防ぐのが主目的。
// - balance / amount / price / free_amount 等はマスクしていない。ツール入力（例: create_order の amount）
//   は maskSensitiveFields 後も数値文字列として jsonl に残り得る。これはサーバー管理者が MCP 利用者の
//   操作監査・障害調査のためにローカルログを読む前提の設計であり、LOG_LEVEL=debug でも現状コードは
//   `log('debug', …)` を呼ばない（閾値は THRESH のみ）。tool_run の result は ok/summary/meta のみで
//   残高や約定一覧の data 本体は載せない。
// - 取引操作の `logTradeAction` は amount/price を平文で含むが、改ざん検知用チェーンハッシュ付きの
//   監査ログであり、集計・統計目的とは別レーンとして許容している。
const SENSITIVE_KEYS = new Set(['confirmation_token', 'token', 'key', 'secret', 'apiKey', 'apiSecret']);

function maskSensitiveFields(obj: unknown): unknown {
	if (obj == null || typeof obj !== 'object') return obj;
	if (Array.isArray(obj)) return obj.map(maskSensitiveFields);
	const masked: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
		masked[key] = SENSITIVE_KEYS.has(key) && typeof value === 'string' ? '***' : maskSensitiveFields(value);
	}
	return masked;
}

export function logToolRun(args: { tool: string; input: unknown; result: unknown; ms: number }): void {
	const { tool, input, result, ms } = args;
	const r = result as Record<string, unknown> | null | undefined;
	const safeData = {
		ok: r?.ok,
		summary: r?.summary,
		meta: r?.meta,
	};
	log('info', { type: 'tool_run', tool, input: maskSensitiveFields(input), ms, result: safeData });
}

export function logError(tool: string, err: unknown, input: unknown): void {
	log('error', {
		type: 'tool_error',
		tool,
		input: maskSensitiveFields(input),
		error: (err instanceof Error ? err.message : undefined) || String(err),
	});
}

// ── 取引操作ログ（チェーンハッシュ付き） ──

export function logTradeAction(action: {
	type: 'create_order' | 'cancel_order' | 'cancel_orders';
	orderId?: number;
	orderIds?: number[];
	pair: string;
	side?: string;
	orderType?: string;
	amount?: string;
	price?: string | null;
	triggerPrice?: string | null;
	positionSide?: string | null;
	status: string;
	confirmed: boolean;
	/** どの経路から実行されたかの監査用ラベル（create_order / cancel_order / cancel_orders。二重発注や意図しないキャンセルの原因特定に使う） */
	route?: 'elicitation' | 'ui-button' | 'direct-text';
}) {
	const date = today('YYYY-MM-DD');
	const file = path.join(LOG_DIR, `${date}.jsonl`);
	const record: Record<string, unknown> = {
		ts: nowIso(),
		level: 'info',
		category: 'trade_action',
		...action,
	};
	try {
		writeTradeJsonl(file, record);
	} catch {
		// best-effort
	}
}
