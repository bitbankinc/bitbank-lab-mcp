// private API の接続先の差し替えを研究用の起動口（`lab/`）だけに閉じ込める（ADR-0008）。配布物に入るのは外から有効にできない差し込み口（ループバックの origin しか受けない `BitbankPrivateClient` の `origin` オプションと、配布物の中からは呼ばない `setDefaultClient()`）だけで、環境変数・`.env`・設定ファイルからは接続先を変えられない。
// 起動口が差し替えるのは `getDefaultClient()` が返すクライアントだけなので、配布物のどこかが自前でクライアントを作ったり認証ヘッダを組んだりすると、その要求は差し替え先ではなく本番へ直行する（中継を挟む構成なら中継の迂回になる）。
// 証明ではなく tripwire（別名の import や文字列連結で組んだ呼び出しは検知できない）。実行時には `lab/main.ts` の `guardProductionPrivateApi` が迂回した要求を止める。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_FILE = 'src/private/client.ts';

/** npm の配布物に入るソースのディレクトリ（`package.json` の `files` と下のテストで突き合わせる） */
const DISTRIBUTED_SOURCE_DIRS = ['bin', 'src', 'tools', 'lib'];

/** `files` のうち、ソースのディレクトリ以外のもの（ビルド済みの UI・静的ファイル・メタデータ） */
const DISTRIBUTED_NON_SOURCE = [
	'assets/lightweight-charts.standalone.js',
	'ui/order-confirm/dist/',
	'ui/cancel-confirm/dist/',
	'package.json',
	'tsconfig.json',
];

const REQUIREMENT = [
	'',
	'private API の接続先を差し替える経路が、研究用の起動口（lab/）の外に広がっています（ADR-0008）。',
	'',
	'  - 配布物の中で BitbankPrivateClient を作るのは getDefaultClient()（src/private/client.ts）だけにする',
	'  - 配布物の中で認証ヘッダ（createGetAuthHeaders / createPostAuthHeaders）を使うのは client.ts だけにする',
	'  - setDefaultClient() は配布物の中から呼ばない（呼ぶのは lab/ だけ）',
	'  - src/private/client.ts は環境変数を読まない（接続先を設定から変えられるようにしない）',
	'',
	'崩れると、lab/ で差し替えても一部の要求が本番へ直行し、差し替え先（モックや中継）を迂回します。',
	'',
].join('\n');

function listSourceFiles(dir: string): string[] {
	const abs = path.join(PACKAGE_ROOT, dir);
	return fs
		.readdirSync(abs, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile() && /\.(ts|js|mjs|cjs)$/.test(e.name) && !e.name.endsWith('.d.ts'))
		.map((e) => path.relative(PACKAGE_ROOT, path.join(e.parentPath, e.name)).split(path.sep).join('/'));
}

/** ブロックコメントと、行頭からのコメント行を落とす（説明文中の言及で誤検知しないため） */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.filter((line) => !line.trimStart().startsWith('//'))
		.join('\n');
}

const DISTRIBUTED_FILES = DISTRIBUTED_SOURCE_DIRS.flatMap(listSourceFiles);

function filesMatching(pattern: RegExp): string[] {
	return DISTRIBUTED_FILES.filter((rel) =>
		pattern.test(stripComments(fs.readFileSync(path.join(PACKAGE_ROOT, rel), 'utf8'))),
	).sort();
}

describe('private API の接続先の tripwire（ADR-0008）', () => {
	it('走査対象のディレクトリが package.json の files と一致している', () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { files: string[] };
		const expected = [...DISTRIBUTED_SOURCE_DIRS.map((d) => `${d}/`), ...DISTRIBUTED_NON_SOURCE].sort();

		expect(
			[...pkg.files].sort(),
			'package.json の files が変わりました。新しく配布物に入るソースがあれば DISTRIBUTED_SOURCE_DIRS に足してください',
		).toEqual(expected);
		expect(DISTRIBUTED_FILES).toContain(CLIENT_FILE);
	});

	it('配布物の中で BitbankPrivateClient を作るのは client.ts だけ', () => {
		expect(filesMatching(/\bnew\s+BitbankPrivateClient\s*\(/), REQUIREMENT).toEqual([CLIENT_FILE]);
	});

	it('配布物の中で認証ヘッダを組むのは client.ts だけ', () => {
		// 定義（`function createGetAuthHeaders(`）は除き、呼び出しだけを見る
		expect(filesMatching(/(?<!function\s+)\bcreate(Get|Post)AuthHeaders\s*\(/), REQUIREMENT).toEqual([CLIENT_FILE]);
	});

	it('配布物の中から setDefaultClient() を呼ばない', () => {
		expect(filesMatching(/(?<!function\s+)\bsetDefaultClient\s*\(/), REQUIREMENT).toEqual([]);
	});

	it('src/private/client.ts は環境変数を読まない', () => {
		const source = stripComments(fs.readFileSync(path.join(PACKAGE_ROOT, CLIENT_FILE), 'utf8'));
		expect(source, REQUIREMENT).not.toMatch(/\bprocess\s*\.\s*env\b/);
	});
});

describe('lab/ は配布物に入らない（ADR-0008）', () => {
	it('npm pack の結果に lab/ が無い', () => {
		const res = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
			cwd: PACKAGE_ROOT,
			encoding: 'utf8',
			// Windows では npm が .cmd のため shell 経由でないと起動できない
			shell: process.platform === 'win32',
		});
		expect(res.status, res.stderr).toBe(0);
		const [pack] = JSON.parse(res.stdout) as Array<{ files: Array<{ path: string }> }>;
		const paths = pack.files.map((f) => f.path);

		// 空振りで通らないよう、配布物に入るべきものが入っていることも確かめる
		expect(paths).toContain(CLIENT_FILE);
		expect(paths.filter((p) => p === 'lab' || p.startsWith('lab/'))).toEqual([]);
	});

	it('Docker イメージに lab/ を COPY しない', () => {
		const dockerfile = fs.readFileSync(path.join(PACKAGE_ROOT, 'Dockerfile'), 'utf8');
		const copies = dockerfile.split('\n').filter((line) => /^\s*(COPY|ADD)\b/i.test(line));

		expect(copies.length).toBeGreaterThan(0);
		expect(copies.filter((line) => /(^|[\s/])lab(\/|\s|$)/.test(line) || /\s\.\s/.test(line))).toEqual([]);
	});
});

describe('lab/start.ts の起動順（ADR-0008）', () => {
	const START = fs.readFileSync(path.join(PACKAGE_ROOT, 'lab', 'start.ts'), 'utf8');

	it('最初の import は src/env.js（src/server.ts と同じ順で .env を読む）', () => {
		const firstImport = START.match(/^import\s+[^;]*?['"]([^'"]+)['"]/m);
		expect(firstImport?.[1]).toBe('../src/env.js');
	});

	it('src/server.js を静的 import しない（差し替えより先にサーバーが起動するため）', () => {
		expect(START).not.toMatch(/^\s*import\s[^;(]*?['"]\.\.\/src\/server\.js['"]/m);
		expect(START).toMatch(/import\(\s*['"]\.\.\/src\/server\.js['"]\s*\)/);
	});
});
