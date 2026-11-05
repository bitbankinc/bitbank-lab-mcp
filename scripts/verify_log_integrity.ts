#!/usr/bin/env tsx
// Usage: npx tsx scripts/verify_log_integrity.ts [logfile]（省略時は ./logs/ 内の最新ファイル）

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function computeHash(record: Record<string, unknown>): string {
	const { _hash, ...rest } = record;
	const json = JSON.stringify(rest);
	return createHash('sha256').update(json).digest('hex');
}

function findLatestLog(dir: string): string | null {
	if (!fs.existsSync(dir)) return null;
	const files = fs
		.readdirSync(dir)
		.filter((f) => f.endsWith('.jsonl'))
		.sort();
	return files.length > 0 ? path.join(dir, files[files.length - 1]) : null;
}

function main() {
	const logFile = process.argv[2] || findLatestLog('./logs');
	if (!logFile) {
		console.error('No log file found. Usage: npx tsx scripts/verify_log_integrity.ts [logfile]');
		process.exit(1);
	}

	if (!fs.existsSync(logFile)) {
		console.error(`File not found: ${logFile}`);
		process.exit(1);
	}

	const content = fs.readFileSync(logFile, 'utf-8');
	const lines = content.split('\n').filter((l) => l.trim());

	const tradeRecords: { line: number; record: Record<string, unknown> }[] = [];
	for (let i = 0; i < lines.length; i++) {
		try {
			const record = JSON.parse(lines[i]) as Record<string, unknown>;
			if (record.category === 'trade_action' && record._hash && record._prevHash) {
				tradeRecords.push({ line: i + 1, record });
			}
		} catch {
			// JSON パースエラーは無視（通常ログ行）
		}
	}

	if (tradeRecords.length === 0) {
		console.log(`${logFile}: 取引操作ログが見つかりません`);
		process.exit(0);
	}

	console.log(`${logFile}: ${tradeRecords.length} 件の取引操作ログを検証中...`);

	let errors = 0;
	let prevHash = '0'.repeat(64); // 初期値

	for (const { line, record } of tradeRecords) {
		if (record._prevHash !== prevHash) {
			console.error(
				`  [NG] 行 ${line}: _prevHash 不一致\n` + `    期待: ${prevHash}\n` + `    実際: ${record._prevHash}`,
			);
			errors++;
		}

		const expectedHash = computeHash(record);
		if (record._hash !== expectedHash) {
			console.error(
				`  [NG] 行 ${line}: _hash 不一致（改ざんの可能性）\n` +
					`    期待: ${expectedHash}\n` +
					`    実際: ${record._hash}`,
			);
			errors++;
		}

		prevHash = record._hash as string;
	}

	if (errors === 0) {
		console.log(`  [OK] 全 ${tradeRecords.length} 件のチェーンハッシュが正常です`);
	} else {
		console.error(`  ${errors} 件の不整合が検出されました`);
		process.exit(1);
	}
}

main();
