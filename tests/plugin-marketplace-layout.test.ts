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
 *   5. Cursor / Codex の manifest の `skills` が、移動後の skill の置き場所を指している（#408）
 */

import fs from 'node:fs';
import os from 'node:os';
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
		describe(`plugin: ${entry.name}`, () => {
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

// Codex は manifest に skills が無いと plugin 直下の skills/ だけを探す。直下には無いので、指定が欠けると Skill が 1 つも読み込まれない。
describe('Cursor / Codex の manifest の skills', () => {
	const claudeSkillDirs = ENTRIES.map((e) => path.resolve(PACKAGE_ROOT, String(e.source), 'skills'));

	for (const manifestRel of ['.cursor-plugin/plugin.json', '.codex-plugin/plugin.json']) {
		describe(`manifest: ${manifestRel}`, () => {
			const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, manifestRel), 'utf8')) as {
				skills?: unknown;
			};
			const raw = manifest.skills;
			const values = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];

			it('文字列か文字列の配列で、./ で始まり .. を含まない', () => {
				expect(values.length, `${manifestRel} に skills が無い`).toBeGreaterThan(0);
				for (const v of values) {
					expect(typeof v).toBe('string');
					expect(v, 'Codex は ./ で始まらないパスを無視する').toMatch(/^\.\/./);
					expect(String(v).split('/'), 'Codex は .. を含むパスを無視する').not.toContain('..');
				}
			});

			it('Claude Code の plugin と同じ skill の置き場所を指し、そこに SKILL.md のある skill がある', () => {
				const dirs = values.map((v) => path.resolve(PACKAGE_ROOT, String(v)));
				for (const expected of claudeSkillDirs) {
					expect(dirs, `${manifestRel} の skills が ${path.relative(PACKAGE_ROOT, expected)} を指していない`).toContain(
						expected,
					);
				}
				for (const dir of dirs) {
					const skills = fs
						.readdirSync(dir, { withFileTypes: true })
						.filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'SKILL.md')));
					expect(skills.length, `${path.relative(PACKAGE_ROOT, dir)} に SKILL.md のある skill が無い`).toBeGreaterThan(
						0,
					);
				}
			});
		});
	}
});

// core.symlinks=false の Windows では、git が symlink をリンク先のパスを書いた普通のファイルとして置く。
function skillLinks(dir: string): Array<{ name: string; target: string }> {
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((d) => !d.name.startsWith('.') && (d.isSymbolicLink() || d.isFile()))
		.map((d) => ({
			name: d.name,
			target: d.isSymbolicLink()
				? path.join(dir, d.name)
				: path.resolve(dir, fs.readFileSync(path.join(dir, d.name), 'utf8').trim()),
		}));
}

describe('.claude/skills のシンボリックリンク', () => {
	const skillsDir = path.join(PACKAGE_ROOT, '.claude/skills');
	const links = skillLinks(skillsDir);

	it('リンクが 1 つ以上ある', () => {
		expect(links.length).toBeGreaterThan(0);
	});

	for (const { name, target } of links) {
		it(`${name} が SKILL.md のある skill を指している`, () => {
			expect(fs.existsSync(path.join(target, 'SKILL.md')), `.claude/skills/${name} のリンク切れ`).toBe(true);
		});
	}

	it('symlink の代わりにリンク先のパスを書いたファイル（core.symlinks=false）もリンクとしてたどり、.DS_Store などの隠しファイルは数えない', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-links-'));
		try {
			fs.mkdirSync(path.join(tmp, 'real/skill-a'), { recursive: true });
			fs.writeFileSync(path.join(tmp, 'real/skill-a/SKILL.md'), '');
			fs.mkdirSync(path.join(tmp, 'links'));
			fs.writeFileSync(path.join(tmp, 'links/skill-a'), '../real/skill-a');
			fs.writeFileSync(path.join(tmp, 'links/.DS_Store'), '');
			const links = skillLinks(path.join(tmp, 'links'));
			expect(links.map((l) => l.name)).toEqual(['skill-a']);
			const [link] = links;
			expect(fs.existsSync(path.join(link?.target ?? '', 'SKILL.md'))).toBe(true);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
