/**
 * plugin manifest の `version` がリリースと揃っていることを固定する。
 *
 * `package.json` の `version` はリリースワークフローがタグから設定する（`docs/ops.md`）が、
 * plugin manifest はワークフローが書き換えないので、手で上げ忘れるとそのまま残る。
 * 実際に 0.1.1 のまま 0.4.0 / 0.5.0 を出し、Claude Code の plugin が既存の利用者に
 * 更新されなかった（Claude Code は `plugin.json` の `version` で更新を判定し、
 * 据え置くと新しいコミットを push してもキャッシュのままになる）。
 *
 * 見ること:
 *   1. すべての manifest（`.<client>-plugin/plugin.json` と `gemini-extension.json`）の `version` が一致している
 *   2. それが CHANGELOG で最後に切ったリリース（`[Unreleased]` の次の見出し）と同じ
 *   3. `.claude-plugin/marketplace.json` の plugin エントリに `version` が無い
 *      （`plugin.json` と二重に書くと `plugin.json` が黙って優先され、食い違いの元になる）
 *
 * リリース PR で CHANGELOG を切ったのに manifest を上げ忘れると 2 が落ちる。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * plugin manifest の一覧。**名前で選ばない**——`.<client>-plugin/plugin.json` を機械的に集めるので、
 * 新しいクライアント向けの manifest を足したらこの検査も自動でそれを見る。
 * Gemini CLI だけは置き場所の規約が違う（リポジトリ直下の `gemini-extension.json`）ので足す。
 */
const PLUGIN_MANIFESTS: string[] = [
	...fs
		.readdirSync(PACKAGE_ROOT, { withFileTypes: true })
		.filter((d) => d.isDirectory() && /^\.[a-z]+-plugin$/.test(d.name))
		.map((d) => `${d.name}/plugin.json`)
		.filter((p) => fs.existsSync(path.join(PACKAGE_ROOT, p))),
	'gemini-extension.json',
];

function readJson(relPath: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, relPath), 'utf8')) as Record<string, unknown>;
}

/** CHANGELOG で最後に切ったリリースのバージョン（`## [x.y.z] - YYYY-MM-DD` の最初の 1 つ）。 */
function latestReleasedVersion(): string | undefined {
	const changelog = fs.readFileSync(path.join(PACKAGE_ROOT, 'CHANGELOG.md'), 'utf8');
	return changelog.match(/^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\] - \d{4}-\d{2}-\d{2}$/m)?.[1];
}

describe('plugin manifest の version', () => {
	it('すべての manifest で一致している', () => {
		// manifest を 1 つも拾えないと「一致」が自明に通るので、母数を先に固定する
		// （Claude Code / Cursor / Codex / Gemini の 4 つが現状）。
		expect(
			PLUGIN_MANIFESTS.length,
			`plugin manifest が集まっていない: ${PLUGIN_MANIFESTS.join(', ')}`,
		).toBeGreaterThanOrEqual(4);
		const versions = Object.fromEntries(PLUGIN_MANIFESTS.map((p) => [p, readJson(p).version]));
		const distinct = new Set(Object.values(versions));
		expect(distinct.size, `version が manifest ごとに違う: ${JSON.stringify(versions)}`).toBe(1);
	});

	it('CHANGELOG で最後に切ったリリースと同じ', () => {
		const released = latestReleasedVersion();
		// リリース見出しを 1 つも拾えないと比較が空振りするので、先に存在を確かめる。
		expect(released, 'CHANGELOG からリリース見出し（## [x.y.z] - YYYY-MM-DD）を読めない').toBeDefined();
		for (const p of PLUGIN_MANIFESTS) {
			expect(
				readJson(p).version,
				`${p} の version が CHANGELOG の最新リリース ${released} と違う（リリース PR で上げ忘れていないか。手順は docs/ops.md）`,
			).toBe(released);
		}
	});

	it('marketplace.json の plugin エントリには version を書かない', () => {
		const plugins = readJson('.claude-plugin/marketplace.json').plugins as Array<Record<string, unknown>>;
		expect(plugins.length).toBeGreaterThan(0);
		for (const entry of plugins) {
			expect(entry, `${String(entry.name)}: version は plugin.json 側だけで管理する`).not.toHaveProperty('version');
		}
	});
});
