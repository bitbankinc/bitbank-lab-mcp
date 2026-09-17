/**
 * checklist-verify.sh の動作確認テスト
 *
 * 一時ディレクトリにチェックリストを配置し、
 * シェルスクリプトの各チェックタイプが正しく動作するかを検証する。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '../../.claude/hooks/checklist-verify.sh');

// 失敗レポートの JSON 出力はスクリプト内で jq を使う。
// jq が無い環境（Windows の Git Bash 標準構成 等）では失敗レポート系テストを skip する。
const hasJq = (() => {
	try {
		execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'pipe', timeout: 10_000 });
		return true;
	} catch {
		return false;
	}
})();

// jq が CI ランナーから消えると、上の hasJq がそのまま false になり
// jq 依存テストが黙って skip される（= 検証が消えたことに誰も気づかない）。
// CI では jq を前提条件として明示的に検証し、欠けていればここで落とす。
describe('テスト環境の前提', () => {
	it.skipIf(!process.env.CI)('CI では jq が利用可能（jq 依存テストのサイレント skip 防止）', () => {
		expect(hasJq).toBe(true);
	});
});

describe('checklist-verify.sh', () => {
	let tmpDir: string;
	let checklistPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'checklist-test-'));
		mkdirSync(join(tmpDir, '.claude'), { recursive: true });
		checklistPath = join(tmpDir, '.claude/completion-checklist');
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	/** チェックリストを書き込んで検証スクリプトを実行 */
	function run(checklist: string): { stdout: string; exitCode: number } {
		writeFileSync(checklistPath, checklist, 'utf8');
		try {
			const stdout = execFileSync('bash', [SCRIPT], {
				cwd: tmpDir,
				env: { ...process.env, PATH: process.env.PATH },
				encoding: 'utf8',
				timeout: 30_000,
			});
			return { stdout, exitCode: 0 };
		} catch (err: unknown) {
			const e = err as { stdout?: string; status?: number };
			return { stdout: e.stdout ?? '', exitCode: e.status ?? 1 };
		}
	}

	/** JSON 出力から additionalContext を抽出 */
	function extractContext(stdout: string): string {
		if (!stdout.trim()) return '';
		try {
			const parsed = JSON.parse(stdout);
			return parsed?.hookSpecificOutput?.additionalContext ?? '';
		} catch {
			return '';
		}
	}

	// ── チェックリストが存在しない場合 ──
	it('チェックリストが無ければ何も出力せず終了する', () => {
		// checklistPath を作成しない
		const stdout = execFileSync('bash', [SCRIPT], {
			cwd: tmpDir,
			encoding: 'utf8',
		});
		expect(stdout.trim()).toBe('');
	});

	// ── file_exists ──
	it('file_exists: ファイルが存在すれば PASS', () => {
		writeFileSync(join(tmpDir, 'hello.txt'), 'content');
		const { stdout } = run('file_exists hello.txt');
		expect(stdout.trim()).toBe('');
		// 全パスでチェックリストが削除される
		expect(existsSync(checklistPath)).toBe(false);
	});

	it.skipIf(!hasJq)('file_exists: ファイルが存在しなければ FAIL', () => {
		const { stdout } = run('file_exists nonexistent.txt');
		const ctx = extractContext(stdout);
		expect(ctx).toContain('FAIL');
		expect(ctx).toContain('file_exists nonexistent.txt');
	});

	// ── file_not_empty ──
	it('file_not_empty: 中身があれば PASS', () => {
		writeFileSync(join(tmpDir, 'data.txt'), 'some data');
		const { stdout } = run('file_not_empty data.txt');
		expect(stdout.trim()).toBe('');
	});

	it.skipIf(!hasJq)('file_not_empty: 空ファイルなら FAIL', () => {
		writeFileSync(join(tmpDir, 'empty.txt'), '');
		const { stdout } = run('file_not_empty empty.txt');
		const ctx = extractContext(stdout);
		expect(ctx).toContain('FAIL');
	});

	// ── grep_in ──
	it('grep_in: パターンが見つかれば PASS', () => {
		writeFileSync(join(tmpDir, 'src.ts'), 'export const toolDef = {};');
		const { stdout } = run('grep_in toolDef src.ts');
		expect(stdout.trim()).toBe('');
	});

	it.skipIf(!hasJq)('grep_in: パターンが見つからなければ FAIL', () => {
		writeFileSync(join(tmpDir, 'src.ts'), 'export const foo = {};');
		const { stdout } = run('grep_in toolDef src.ts');
		const ctx = extractContext(stdout);
		expect(ctx).toContain('FAIL');
	});

	// ── grep_not_in ──
	it('grep_not_in: パターンが無ければ PASS', () => {
		writeFileSync(join(tmpDir, 'clean.ts'), 'const x = 1;');
		const { stdout } = run('grep_not_in TODO clean.ts');
		expect(stdout.trim()).toBe('');
	});

	it.skipIf(!hasJq)('grep_not_in: パターンがあれば FAIL', () => {
		writeFileSync(join(tmpDir, 'dirty.ts'), '// TODO: fix this');
		const { stdout } = run('grep_not_in TODO dirty.ts');
		const ctx = extractContext(stdout);
		expect(ctx).toContain('FAIL');
	});

	// ── cmd ──
	it('cmd: コマンドが成功すれば PASS', () => {
		const { stdout } = run('cmd true');
		expect(stdout.trim()).toBe('');
	});

	it.skipIf(!hasJq)('cmd: コマンドが失敗すれば FAIL', () => {
		const { stdout } = run('cmd false');
		const ctx = extractContext(stdout);
		expect(ctx).toContain('FAIL');
	});

	// ── コメント・空行 ──
	it('コメント行と空行は無視される', () => {
		writeFileSync(join(tmpDir, 'exists.txt'), 'ok');
		const { stdout } = run(`# これはコメント

file_exists exists.txt
  # インデント付きコメント
`);
		expect(stdout.trim()).toBe('');
	});

	// ── 不明なチェックタイプ ──
	it.skipIf(!hasJq)('不明なチェックタイプはエラーとして報告する', () => {
		const { stdout } = run('unknown_check foo');
		const ctx = extractContext(stdout);
		expect(ctx).toContain('不明なチェックタイプ');
		expect(ctx).toContain('unknown_check');
	});

	// ── 複数チェック ──
	it.skipIf(!hasJq)('複数チェックで一部失敗した場合、失敗のみ報告する', () => {
		writeFileSync(join(tmpDir, 'a.txt'), 'content');
		const { stdout } = run(`file_exists a.txt
file_exists missing.txt
cmd true
cmd false`);
		const ctx = extractContext(stdout);
		expect(ctx).toContain('file_exists missing.txt');
		expect(ctx).toContain('cmd false');
		expect(ctx).not.toContain('file_exists a.txt');
		expect(ctx).not.toContain('cmd true');
	});

	it('全チェック通過でチェックリストが自動削除される', () => {
		writeFileSync(join(tmpDir, 'ok.txt'), 'data');
		run('file_exists ok.txt');
		expect(existsSync(checklistPath)).toBe(false);
	});

	// jq が無いと 95 行目の jq でスクリプトが set -euo pipefail により異常終了し、
	// 「チェックが失敗したから残った」ではなく「異常終了して rm に到達しなかったから
	// 残った」を見ることになる。通ってしまうが検証の意味が変わるため他の失敗系と揃える。
	it.skipIf(!hasJq)('失敗があるとチェックリストは残る', () => {
		run('file_exists nonexistent.txt');
		expect(existsSync(checklistPath)).toBe(true);
	});

	// ── インラインコメント ──
	it('インラインコメントが除去される', () => {
		writeFileSync(join(tmpDir, 'target.txt'), 'ok');
		const { stdout } = run('file_exists target.txt # ファイル存在チェック');
		expect(stdout.trim()).toBe('');
	});
});
