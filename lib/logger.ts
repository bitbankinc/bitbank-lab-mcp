import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowIso, today } from './datetime.js';

// package.json の files が bin / src / lib を並列に含むので、publish 後もこの相対関係は変わらない。
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// cwd 相対にしない。ホストが spawn するので cwd は / になりうり、作成失敗を下の catch が握り潰して取引監査ログごと消える。
const LOG_DIR = process.env.LOG_DIR || path.join(PACKAGE_ROOT, 'logs');
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

/** 書き込み失敗の通知は 1 回だけ出す（失敗が続く環境で stderr を埋めないため） */
let writeFailureNotified = false;

// 出力先は必ず stderr（stdio では stdout が JSON-RPC ストリーム）。ログレコード本文は載せない（sensitive-data）。
function notifyWriteFailure(file: string, err: unknown): void {
	if (writeFailureNotified) return;
	writeFailureNotified = true;
	const reason = err instanceof Error ? err.message : String(err);
	process.stderr.write(
		`[bitbank-lab-mcp] ログを書き込めません: ${file} (${reason})\n` +
			'  LOG_DIR で書き込み可能なディレクトリを指定してください。以降この警告は表示されません。\n',
	);
}

export function _resetWriteFailureNotice(): void {
	writeFailureNotified = false;
}

let lastTradeHash = '0'.repeat(64);

function writeTradeJsonl(file: string, record: Record<string, unknown>) {
	ensureDir(path.dirname(file));
	const withChain = { ...record, _prevHash: lastTradeHash };
	const json = JSON.stringify(withChain);
	const hash = createHash('sha256').update(json).digest('hex');
	fs.appendFileSync(file, `${JSON.stringify({ ...withChain, _hash: hash })}\n`);
	// 追記が成功したときだけチェーンを進める。先に進めると、失敗したレコードを指す _prevHash で verify_log_integrity が断絶を誤検出する。
	lastTradeHash = hash;
}

export function log(level: 'error' | 'warn' | 'info' | 'debug', event: Record<string, unknown>): void {
	if ((LEVELS[level] ?? 2) > THRESH) return;
	const date = today('YYYY-MM-DD');
	const file = path.join(LOG_DIR, `${date}.jsonl`);
	const record = { ts: nowIso(), level, ...event } as const;
	try {
		writeJsonl(file, record);
	} catch (err) {
		// best-effort: ログ失敗でツール実行は止めない。ただし黙って捨てず初回だけ stderr に出す。
		notifyWriteFailure(file, err);
	}
}

// SENSITIVE_KEYS は認証・署名・確認トークン系だけを対象にし、amount / price は管理者の監査用に平文で残す（logTradeAction はチェーンハッシュ付きの別レーン）。
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
	/** 二重発注や意図しないキャンセルの原因特定に使う監査用ラベル。 */
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
	} catch (err) {
		// 監査ログの失敗で発注・取消は止めないが、証跡が残っていないことに気づけるよう必ず通知する。
		notifyWriteFailure(file, err);
	}
}
