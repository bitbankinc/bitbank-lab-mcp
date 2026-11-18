import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import dayjs from 'dayjs';

const ALLOWLIST_PATH = path.join(process.cwd(), '.github/npm-audit-allowlist.json');
const GATE_SEVERITIES = new Set(['high', 'critical']);

interface AllowlistEntry {
	id: string;
	package: string;
	reason: string;
	expires: string;
}

interface AuditAdvisory {
	source: number;
	name: string;
	title: string;
	url?: string;
	severity: string;
}

interface AuditVulnerability {
	name: string;
	severity: string;
	via: Array<AuditAdvisory | string>;
}

function fail(lines: string[]): never {
	console.error(lines.join('\n'));
	process.exit(1);
}

function loadAllowlist(): AllowlistEntry[] {
	const raw = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8')) as {
		allowlist?: AllowlistEntry[];
	};
	if (!Array.isArray(raw.allowlist)) {
		fail([`${ALLOWLIST_PATH}: "allowlist" が配列ではありません`]);
	}
	for (const entry of raw.allowlist) {
		const valid =
			typeof entry.id === 'string' &&
			entry.id.startsWith('GHSA-') &&
			typeof entry.package === 'string' &&
			entry.package.length > 0 &&
			typeof entry.reason === 'string' &&
			entry.reason.length > 0 &&
			typeof entry.expires === 'string' &&
			/^\d{4}-\d{2}-\d{2}$/.test(entry.expires) &&
			// dayjs は 02-30 を 03-02 に正規化して isValid が true になるので、往復一致で実在日だけ通す
			dayjs(entry.expires).format('YYYY-MM-DD') === entry.expires;
		if (!valid) {
			fail([
				`${ALLOWLIST_PATH}: 不正なエントリ: ${JSON.stringify(entry)}`,
				'必須フィールド: id (GHSA-...), package, reason, expires (YYYY-MM-DD)',
			]);
		}
	}
	return raw.allowlist;
}

function runAudit(): Record<string, AuditVulnerability> {
	// npm audit は脆弱性があると exit 1 になるが、JSON レポートは stdout に出る
	const res = spawnSync('npm', ['audit', '--json'], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
	});
	if (res.error) {
		fail([`npm audit の起動に失敗: ${res.error.message}`]);
	}
	let parsed: {
		auditReportVersion?: number;
		error?: { summary?: string };
		vulnerabilities?: Record<string, AuditVulnerability>;
	};
	try {
		parsed = JSON.parse(res.stdout);
	} catch {
		fail(['npm audit --json の出力を parse できませんでした', res.stderr ?? '']);
	}
	if (parsed.error) {
		fail([`npm audit がエラーを返しました: ${parsed.error.summary ?? JSON.stringify(parsed.error)}`]);
	}
	if (parsed.auditReportVersion !== 2) {
		fail([`未対応の auditReportVersion: ${parsed.auditReportVersion}`]);
	}
	return parsed.vulnerabilities ?? {};
}

const allowlist = loadAllowlist();
const vulnerabilities = runAudit();

const found = new Map<string, { severity: string; title: string; packages: Set<string> }>();
for (const [pkgName, vuln] of Object.entries(vulnerabilities)) {
	for (const via of vuln.via) {
		if (typeof via === 'string') continue;
		if (!GATE_SEVERITIES.has(via.severity)) continue;
		const id = via.url?.split('/').at(-1) ?? `npm-advisory-${via.source}`;
		const adv = found.get(id) ?? { severity: via.severity, title: via.title, packages: new Set<string>() };
		adv.packages.add(pkgName);
		found.set(id, adv);
	}
}

const today = dayjs();
const errors: string[] = [];
const allowlistRelPath = path.relative(process.cwd(), ALLOWLIST_PATH);

for (const entry of allowlist) {
	if (!found.has(entry.id)) {
		errors.push(
			`不要になった allowlist エントリ: ${entry.id}（${entry.package}）は npm audit の high/critical に出なくなりました。` +
				`${allowlistRelPath} から削除してください。`,
		);
	}
}

for (const [id, adv] of found) {
	const entry = allowlist.find((e) => e.id === id);
	if (!entry) {
		errors.push(
			`allowlist に無い ${adv.severity}: ${id} — ${adv.title}（経路: ${[...adv.packages].join(', ')}）。` +
				'依存を修正版へ更新してください。修正版が無い場合のみ、理由と expires を付けて ' +
				`${allowlistRelPath} に追加します。`,
		);
	} else if (today.isAfter(dayjs(entry.expires), 'day')) {
		errors.push(
			`期限切れの allowlist エントリ: ${id}（expires: ${entry.expires}）がまだ npm audit に出ています。` +
				'修正版が出ていれば依存を更新し、まだ無ければ再評価のうえ expires を延長してください。',
		);
	}
}

if (errors.length > 0) {
	fail(['npm audit gate: NG', ...errors.map((e) => `- ${e}`)]);
}

if (found.size === 0) {
	console.log('npm audit gate: OK（high/critical なし。allowlist も空です）');
} else {
	console.log('npm audit gate: OK（以下は allowlist 済みの advisory）');
	for (const [id, adv] of found) {
		const entry = allowlist.find((e) => e.id === id);
		console.log(`- ${id} [${adv.severity}] ${adv.title}（expires: ${entry?.expires}）`);
	}
}
