// 確認 UI の実行の待ち時間は、両 UI のコメントにある「サーバー側のツール timeout より少し短く」をコメントでしか保っていなかったので、値の大小をここで固定する。
// UI は React を、server.ts は stdio への接続を読み込み時に始めるので import できず、ソースの定数を読む tripwire にしている。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readMsConstant(file: string, name: string): number {
	const source = fs.readFileSync(path.join(PACKAGE_ROOT, file), 'utf8');
	const match = source.match(new RegExp(`^const ${name} = ([\\d_]+);$`, 'm'));
	if (!match)
		throw new Error(`${file} に \`const ${name} = <数値>;\` が見つからない（名前か書き方を変えたらこのテストも直す）`);
	return Number(match[1].replaceAll('_', ''));
}

const SERVER_TOOL_TIMEOUT_MS = readMsConstant('src/server.ts', 'TOOL_TIMEOUT_MS');

describe('確認 UI の実行の待ち時間', () => {
	it.each([
		['ui/order-confirm/src/App.tsx', 'CREATE_ORDER_TIMEOUT_MS'],
		['ui/cancel-confirm/src/App.tsx', 'CANCEL_TIMEOUT_MS'],
	])('%s の %s はサーバーのツール実行タイムアウトより短い', (file, name) => {
		const uiTimeoutMs = readMsConstant(file, name);
		expect(
			uiTimeoutMs,
			`${name}（${uiTimeoutMs}ms）が server.ts の TOOL_TIMEOUT_MS（${SERVER_TOOL_TIMEOUT_MS}ms）以上になっている`,
		).toBeLessThan(SERVER_TOOL_TIMEOUT_MS);
	});
});
