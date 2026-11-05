import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { dayjs } from '../lib/datetime.js';

const LOG_DIR = process.env.LOG_DIR || './logs';
const REPORT_DIR = './reports';

type Stats = {
	total: number;
	success: number;
	fail: number;
	durations: number[];
	errorTypes: Record<string, number>;
};

async function generateReport(): Promise<void> {
	const dateStr = dayjs().subtract(1, 'day').format('YYYY-MM-DD');

	console.log(`Generating report for ${dateStr}...`);

	const stats: Stats = {
		total: 0,
		success: 0,
		fail: 0,
		durations: [],
		errorTypes: {},
	};

	try {
		if (!fs.existsSync(LOG_DIR)) {
			console.error(`Log directory not found at ${LOG_DIR}. No report generated.`);
			return;
		}

		const files = await fs.promises.readdir(LOG_DIR);
		const logFiles = files.filter((f) => f.endsWith('.jsonl'));

		for (const file of logFiles) {
			const filePath = path.join(LOG_DIR, file);
			const fileStream = fs.createReadStream(filePath);
			const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

			for await (const line of rl) {
				try {
					const log = JSON.parse(line);
					if (log.ts && typeof log.ts === 'string' && log.ts.startsWith(dateStr) && log.type === 'tool_run') {
						stats.total++;
						if (log.result?.ok) stats.success++;
						else {
							stats.fail++;
							const type = log.result?.meta?.errorType || 'unknown';
							stats.errorTypes[type] = (stats.errorTypes[type] || 0) + 1;
						}
						if (typeof log.ms === 'number') stats.durations.push(log.ms);
					}
				} catch {
					// ignore parse errors
				}
			}
		}

		if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR);
		const reportFile = path.join(REPORT_DIR, `${dateStr}.md`);

		const avg = stats.durations.length
			? (stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length).toFixed(1)
			: 0;
		const min = stats.durations.length ? Math.min(...stats.durations) : 0;
		const max = stats.durations.length ? Math.max(...stats.durations) : 0;
		const errRate = stats.total > 0 ? ((stats.fail / stats.total) * 100).toFixed(2) : 0;

		const errorTypesSummary = Object.entries(stats.errorTypes)
			.map(([type, count]) => `- ${type}: ${count}`)
			.join('\n');

		const reportContent = `
# Daily Report (${dateStr})

- **Total Runs**: ${stats.total}
- **Success**: ${stats.success}
- **Failure**: ${stats.fail}
- **Error Rate**: ${errRate}%

## Error Types
${stats.fail > 0 ? errorTypesSummary : '- No errors'}

## Processing Time (ms)
- **Average**: ${avg}
- **Min**: ${min}
- **Max**: ${max}
`.trim();

		fs.writeFileSync(reportFile, reportContent, 'utf8');
		console.log(`✔ Report generated successfully: ${reportFile}`);
	} catch (error) {
		console.error('Failed to generate report:', error);
	}
}

generateReport();
