export type UpstreamWarningMeta = {
	warning?: string;
	warnings?: string[];
};

export type PrependWarningsOptions = {
	separator?: '\n' | '\n\n';
};

function ensureWarnPrefix(line: string): string {
	return line.startsWith('⚠️') ? line : `⚠️ ${line}`;
}

export function prependWarnings(
	body: string,
	meta: UpstreamWarningMeta | null | undefined,
	options: PrependWarningsOptions = {},
): string {
	const separator = options.separator ?? '\n\n';
	const lines: string[] = [];
	if (meta?.warning) {
		for (const line of meta.warning.split('\n')) {
			if (!line) continue;
			lines.push(ensureWarnPrefix(line));
		}
	}
	if (Array.isArray(meta?.warnings)) {
		for (const w of meta.warnings) {
			if (!w) continue;
			lines.push(ensureWarnPrefix(w));
		}
	}
	if (lines.length === 0) return body;
	return `${lines.join('\n')}${separator}${body}`;
}

export function extractUpstreamWarning(meta: unknown): UpstreamWarningMeta {
	if (!meta || typeof meta !== 'object') return {};
	const obj = meta as { warning?: unknown; warnings?: unknown };
	const out: UpstreamWarningMeta = {};
	if (typeof obj.warning === 'string' && obj.warning.length > 0) {
		out.warning = obj.warning;
	}
	if (Array.isArray(obj.warnings)) {
		const arr = obj.warnings.filter((w): w is string => typeof w === 'string' && w.length > 0);
		if (arr.length > 0) out.warnings = arr;
	}
	return out;
}

export function collectUpstreamWarnings(sources: Array<{ source: string; warning?: string }>): string | undefined {
	const lines: string[] = [];
	for (const { source, warning } of sources) {
		if (!warning) continue;
		for (const raw of warning.split('\n')) {
			const trimmed = raw.replace(/^⚠️\s*/, '').trim();
			if (trimmed) lines.push(`[${source}] ${trimmed}`);
		}
	}
	return lines.length > 0 ? lines.join('\n') : undefined;
}
