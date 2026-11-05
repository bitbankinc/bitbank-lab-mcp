import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { dayjs } from '../lib/datetime.js';

const LOG_DIR = process.env.LOG_DIR || './logs';

const DURATION_UNITS: Record<string, 'day' | 'hour' | 'minute' | 'second'> = {
	d: 'day',
	h: 'hour',
	m: 'minute',
	s: 'second',
};

function parseDuration(durationStr: string | null): Date | null {
	if (!durationStr) return null;
	const match = durationStr.match(/^(\d+)([dhms])$/);
	if (!match) return null;
	const value = parseInt(match[1], 10);
	const unit = DURATION_UNITS[match[2]];
	if (!unit) return null;
	return dayjs().subtract(value, unit).toDate();
}

interface LogStats {
	total: number;
	success: number;
	fail: number;
	durations: number[];
	errorTypes: Record<string, number>;
	cacheHits: number;
	cacheMisses: number;
}

async function processLogFile(filePath: string, stats: LogStats, startTime: Date | null) {
	const fileStream = fs.createReadStream(filePath);
	const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
	for await (const line of rl) {
		try {
			const log = JSON.parse(line);
			if (startTime && dayjs(log.ts).toDate() < startTime) continue;
			if (log.type !== 'tool_run') continue;
			stats.total++;
			if (log.result?.ok) stats.success++;
			else {
				stats.fail++;
				const errorType = log.result?.meta?.errorType || 'unknown';
				stats.errorTypes[errorType] = (stats.errorTypes[errorType] || 0) + 1;
			}
			const cacheStatus = log.result?.meta?.cache;
			// support both legacy string ('hit'/'miss') and new object form ({ hit: boolean, key?: string })
			if (cacheStatus && typeof cacheStatus === 'object') {
				if (cacheStatus.hit === true) stats.cacheHits++;
				else if (cacheStatus.hit === false) stats.cacheMisses++;
			} else if (cacheStatus === 'hit') {
				stats.cacheHits++;
			} else if (cacheStatus === 'miss') {
				stats.cacheMisses++;
			}
			if (typeof log.ms === 'number') stats.durations.push(log.ms);
		} catch {
			// ignore
		}
	}
}

async function run() {
	const args = process.argv.slice(2);
	const lastFlagIndex = args.indexOf('--last');
	const durationStr = lastFlagIndex !== -1 ? args[lastFlagIndex + 1] : null;
	const startTime = parseDuration(durationStr);

	if (lastFlagIndex !== -1 && !startTime) {
		console.error(`Error: Invalid duration format '${durationStr}'. Use format like '7d', '24h', '30m'.`);
		process.exit(1);
	}

	if (!fs.existsSync(LOG_DIR)) {
		console.error(`Error: Log directory not found at '${LOG_DIR}'`);
		process.exit(1);
	}

	const stats: LogStats = {
		total: 0,
		success: 0,
		fail: 0,
		durations: [],
		errorTypes: {},
		cacheHits: 0,
		cacheMisses: 0,
	};

	try {
		const files = await fs.promises.readdir(LOG_DIR);
		const logFiles = files.filter((f) => f.endsWith('.jsonl'));
		if (logFiles.length === 0) {
			console.log('No log files found.');
			return;
		}
		console.log(`Processing ${logFiles.length} log file(s)...`);
		for (const file of logFiles) {
			const filePath = path.join(LOG_DIR, file);
			await processLogFile(filePath, stats, startTime);
		}

		const errRate = stats.total > 0 ? (stats.fail / stats.total) * 100 : 0;
		const avgDuration =
			stats.durations.length > 0
				? stats.durations.reduce((a: number, b: number) => a + b, 0) / stats.durations.length
				: 0;
		const maxDuration = stats.durations.length > 0 ? Math.max(...stats.durations) : 0;
		const minDuration = stats.durations.length > 0 ? Math.min(...stats.durations) : 0;
		const errorSummary =
			stats.fail > 0
				? Object.entries(stats.errorTypes)
						.map(([t, c]) => `${t}: ${c}`)
						.join(', ')
				: 'N/A';
		const totalCacheable = stats.cacheHits + stats.cacheMisses;
		const cacheHitRate = totalCacheable > 0 ? (stats.cacheHits / totalCacheable) * 100 : 0;
		const durationInfo = startTime ? ` (last ${durationStr})` : '';

		console.log(`
--- Log Statistics${durationInfo} ---
Total Runs:   ${stats.total}
Success:      ${stats.success}
Failure:      ${stats.fail}
Error Rate:   ${errRate.toFixed(2)}%
Error Types:  ${errorSummary}
Cache Hit Rate: ${cacheHitRate.toFixed(2)}% (${stats.cacheHits}/${totalCacheable})

--- Processing Time (ms) ---
Average:      ${avgDuration.toFixed(2)} ms
Min:          ${minDuration.toFixed(2)} ms
Max:          ${maxDuration.toFixed(2)} ms
--------------------
    `);
	} catch (err) {
		console.error('Failed to process logs:', err);
		process.exit(1);
	}
}

run();
