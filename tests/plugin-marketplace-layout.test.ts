/**
 * Claude Code / claude.ai 向け plugin の置き場所を固定する。
 *
 * marketplace の plugin `source` をリポジトリ直下（`"./"`）にしていた時期があり、npm 用の
 * `bin/bitbank-lab-mcp.js` まで plugin に含まれていた。Claude Code は通るが、claude.ai の
 * 組織同期（Claude Desktop / claude.ai への配布）は plugin の top-level `bin/` を拒否する
 * （`marketplace_sync_bin_directory_not_allowed`。https://claude.com/docs/plugins/org-sync）。
 * そのため plugin 本体は `plugins/<name>/` に分け、`source` はそのサブディレクトリを指す。
 *
 * 見ること:
 *   1. 各 plugin の `source` が `./` で始まるサブディレクトリで、リポジトリ直下ではない
 *   2. そのディレクトリに `.claude-plugin/plugin.json` があり、`name` がエントリ名と一致する
 *      （食い違うと `Plugin "<name>" not found in marketplace` になる）
 *   3. そのディレクトリに top-level `bin/` が無い
 *   4. `.claude/skills/` のシンボリックリンクが、移動後の skill（`SKILL.md`）を指している
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type MarketplaceEntry = { name: string; source: unknown };

const ENTRIES = (
	JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, '.claude-plugin/marketplace.json'), 'utf8')) as {
		plugins: MarketplaceEntry[];
	}
).plugins;

describe('marketplace の plugin の置き場所', () => {
	it('plugin が 1 つ以上ある', () => {
		expect(ENTRIES.length).toBeGreaterThan(0);
	});

	for (const entry of ENTRIES) {
		describe(entry.name, () => {
			const source = typeof entry.source === 'string' ? entry.source : '';
			const dir = path.resolve(PACKAGE_ROOT, source);

			it('source は ./ で始まるサブディレクトリで、リポジトリ直下ではない', () => {
				expect(source, 'source は相対パスの文字列にする').toMatch(/^\.\//);
				expect(
					dir,
					'リポジトリ直下を plugin にすると npm 用の bin/ が含まれ、claude.ai の組織同期で拒否される',
				).not.toBe(PACKAGE_ROOT);
				expect(dir.startsWith(PACKAGE_ROOT + path.sep), 'source がリポジトリの外を指している').toBe(true);
			});

			it('.claude-plugin/plugin.json があり、name がエントリ名と一致する', () => {
				const manifestPath = path.join(dir, '.claude-plugin/plugin.json');
				expect(fs.existsSync(manifestPath), `${source}/.claude-plugin/plugin.json が無い`).toBe(true);
				const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { name?: unknown };
				expect(manifest.name).toBe(entry.name);
			});

			it('top-level bin/ が無い（claude.ai の組織同期が拒否する）', () => {
				expect(fs.existsSync(path.join(dir, 'bin')), `${source}/bin が存在する`).toBe(false);
			});
		});
	}
});

describe('.claude/skills のシンボリックリンク', () => {
	const skillsDir = path.join(PACKAGE_ROOT, '.claude/skills');
	const links = fs
		.readdirSync(skillsDir, { withFileTypes: true })
		.filter((d) => d.isSymbolicLink())
		.map((d) => d.name);

	it('リンクが 1 つ以上ある', () => {
		expect(links.length).toBeGreaterThan(0);
	});

	for (const name of links) {
		it(`${name} が SKILL.md のある skill を指している`, () => {
			expect(fs.existsSync(path.join(skillsDir, name, 'SKILL.md')), `.claude/skills/${name} のリンク切れ`).toBe(true);
		});
	}
});
