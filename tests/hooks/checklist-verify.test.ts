/**
 * checklist-verify.sh の動作確認テスト
 *
 * 一時ディレクトリにチェックリストを配置し、
 * シェルスクリプトの各チェックタイプが正しく動作するかを検証する。
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '../../.claude/hooks/checklist-verify.sh');

// 失敗レポートの JSON 出力はスクリプト内で jq を使う。
// jq が無い環境（Windows の Git Bash 標準構成 等）では失敗レポート系テストを skip する。
const hasJq = (() => {
	try {
		execSync('bash -c "command -v jq"', { stdio: 'pipe', timeout: 10_000 });
		return true;
	} catch {
		return false;
	}
})();
const itWithJq = it.skipIf(!hasJq);

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
			const stdout = execSync(`bash "${SCRIPT}"`, {
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
		const stdout = execSync(`bash "${SCRIPT}"`, {
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

	itWithJq('file_exists: ファイルが存在しなければ FAIL', () => {
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

	itWithJq('file_not_empty: 空ファイルなら FAIL', () => {
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

	itWithJq('grep_in: パターンが見つからなければ FAIL', () => {
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

	itWithJq('grep_not_in: パターンがあれば FAIL', () => {
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

	itWithJq('cmd: コマンドが失敗すれば FAIL', () => {
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
	itWithJq('不明なチェックタイプはエラーとして報告する', () => {
		const { stdout } = run('unknown_check foo');
		const ctx = extractContext(stdout);
		expect(ctx).toContain('不明なチェックタイプ');
		expect(ctx).toContain('unknown_check');
	});

	// ── 複数チェック ──
	itWithJq('複数チェックで一部失敗した場合、失敗のみ報告する', () => {
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

	it('失敗があるとチェックリストは残る', () => {
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
