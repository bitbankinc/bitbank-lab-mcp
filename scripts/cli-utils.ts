import { getErrorMessage } from '../lib/error.js';

export function parseArgs(argv: string[] = process.argv.slice(2)): {
	positional: string[];
	flags: Record<string, string | boolean>;
} {
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};

	for (const arg of argv) {
		if (arg.startsWith('--')) {
			const eqIndex = arg.indexOf('=');
			if (eqIndex === -1) {
				flags[arg.slice(2)] = true;
			} else {
				flags[arg.slice(2, eqIndex)] = arg.slice(eqIndex + 1);
			}
		} else {
			positional.push(arg);
		}
	}

	return { positional, flags };
}

export function intArg(value: string | undefined, defaultValue: number): number {
	if (value == null) return defaultValue;
	const n = parseInt(value, 10);
	return Number.isFinite(n) ? n : defaultValue;
}

export function runCli(fn: () => Promise<{ ok: boolean } | undefined>): void {
	fn()
		.then((result) => {
			if (result == null) return; // void 戻り値
			console.log(JSON.stringify(result, null, 2));
			if (!result.ok) process.exit(1);
		})
		.catch((err: unknown) => {
			console.error(getErrorMessage(err));
			process.exit(1);
		});
}
