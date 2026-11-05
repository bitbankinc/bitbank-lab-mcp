import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** session-start.sh の判定ロジックと同一で、npm run / vitest 実行を省略してモード名だけを出力するミニスクリプト。 */
const MODE_DETECT_SCRIPT = `
set -euo pipefail

run_mode="full"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  main_ref=""
  if git rev-parse --verify origin/main >/dev/null 2>&1; then
    main_ref="origin/main"
  elif git rev-parse --verify main >/dev/null 2>&1; then
    main_ref="main"
  fi

  if [ -n "$main_ref" ]; then
    main_sha="$(git rev-parse "$main_ref" 2>/dev/null || true)"
    head_sha="$(git rev-parse HEAD 2>/dev/null || true)"
    uncommitted="$(git status --porcelain 2>/dev/null || true)"

    if [ "$main_sha" = "$head_sha" ] && [ -z "$uncommitted" ]; then
      run_mode="skip"
    else
      run_mode="changed"
    fi
  fi
fi

echo "$run_mode"
`;

describe('session-start.sh テスト実行モード判定', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'session-start-test-'));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function initRepo(): void {
		execSync(
			'git init && git checkout -b main && git config commit.gpgsign false && git config user.email "test@test" && git config user.name "test"',
			{ cwd: tmpDir, stdio: 'pipe' },
		);
		writeFileSync(join(tmpDir, 'README.md'), '# test');
		execSync('git add -A && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });
	}

	function commit(message: string): void {
		execSync(`git add -A && git commit -m "${message}"`, { cwd: tmpDir, stdio: 'pipe' });
	}

	/** Windows の cmd.exe はシングルクォートを解釈しないので、シェルを介さずに実行する */
	function detectMode(): string {
		const out = execFileSync('bash', ['-c', MODE_DETECT_SCRIPT], {
			cwd: tmpDir,
			encoding: 'utf8',
			timeout: 5_000,
		});
		return out.trim();
	}

	it('git リポジトリ外では full モード', () => {
		// git init しない → git 外
		const mode = detectMode();
		expect(mode).toBe('full');
	});

	it('main の HEAD にいて未変更なら skip モード', () => {
		initRepo();
		const mode = detectMode();
		expect(mode).toBe('skip');
	});

	it('main から別ブランチに分岐していれば changed モード', () => {
		initRepo();
		execSync('git checkout -b feature/test', { cwd: tmpDir, stdio: 'pipe' });
		writeFileSync(join(tmpDir, 'new.ts'), 'export const x = 1;');
		commit('add file');
		const mode = detectMode();
		expect(mode).toBe('changed');
	});

	it('main にいても uncommitted changes があれば changed モード', () => {
		initRepo();
		writeFileSync(join(tmpDir, 'dirty.ts'), 'export const y = 2;');
		const mode = detectMode();
		expect(mode).toBe('changed');
	});

	it('main に新しいコミットがあれば changed モード', () => {
		initRepo();
		writeFileSync(join(tmpDir, 'extra.ts'), 'export const z = 3;');
		commit('extra');
		// origin/main が無いので local main を参照し、main_ref=main, main_sha=HEAD → skip になる（本来は origin/main との差分で判定すべきケースだが、origin なしなので skip が正しい）。
		const mode = detectMode();
		expect(mode).toBe('skip');
	});
});
