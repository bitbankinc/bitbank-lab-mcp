// サーバーと UI バンドルの両方から import されるので、Node 依存（`node:*` / `process`）も重い依存も持たせない。
// `fetchSnapshot` の結果は `apply` へ渡すだけで、内容を読まず、ログにも出さない（確認トークンを含む `_meta` が流れる）。

export type SnapshotHydrationPhase = 'waiting' | 'restoring' | 'failed';

export const DEFAULT_INITIAL_DELAY_MS = 2_500;

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000];

export type TimerId = ReturnType<typeof globalThis.setTimeout>;

/** `typeof globalThis.setTimeout` を要求すると、Node の型が `__promisify__` まで持つので素の関数を渡せない。使う契約だけを型にする。 */
export type SetTimeoutLike = (handler: () => void, timeoutMs: number) => TimerId;
export type ClearTimeoutLike = (timerId: TimerId) => void;

/** 予約と取り消しを別々に差し替えると abort してもタイマーが残るので、1 つのオブジェクトでペアにして受け取る（#285）。 */
export interface SnapshotHydrationTimers {
	setTimeout: SetTimeoutLike;
	clearTimeout: ClearTimeoutLike;
}

/** ブラウザの window.setTimeout は receiver を外すと Illegal invocation になりうるので、メソッド呼び出しのまま包む。 */
const globalTimers: SnapshotHydrationTimers = {
	setTimeout: (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs),
	clearTimeout: (timerId) => globalThis.clearTimeout(timerId),
};

export interface SnapshotHydrationOptions {
	fetchSnapshot: () => Promise<unknown>;
	isHydrated: () => boolean;
	apply: (result: unknown) => void;
	onPhase?: (phase: SnapshotHydrationPhase) => void;
	initialDelayMs?: number;
	retryDelaysMs?: readonly number[];
	timers?: SnapshotHydrationTimers;
}

/** 止めた後は `apply` も `onPhase` も呼ばない。`fetchSnapshot` の resolve / reject、タイマーの発火、リトライの予約のすべての入口で `aborted` を見る（#29）。 */
export function startSnapshotHydration(opts: SnapshotHydrationOptions): () => void {
	const {
		fetchSnapshot,
		isHydrated,
		apply,
		onPhase,
		initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
		retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
	} = opts;
	const { setTimeout: setTimer, clearTimeout: clearTimer } = opts.timers ?? globalTimers;

	let aborted = false;
	let timerId: TimerId | undefined;

	const notify = (phase: SnapshotHydrationPhase): void => {
		if (aborted) return;
		onPhase?.(phase);
	};

	const schedule = (delayMs: number, run: () => void): void => {
		timerId = setTimer(() => {
			timerId = undefined;
			if (aborted) return;
			run();
		}, delayMs);
	};

	const retryOrFail = (index: number): void => {
		if (aborted) return;
		if (isHydrated()) return;
		const delayMs = retryDelaysMs[index];
		if (delayMs == null) {
			notify('failed');
			return;
		}
		schedule(delayMs, () => attempt(index + 1));
	};

	const attempt = (index: number): void => {
		if (aborted) return;
		if (isHydrated()) return;
		notify('restoring');
		let pending: Promise<unknown>;
		try {
			pending = Promise.resolve(fetchSnapshot());
		} catch {
			retryOrFail(index);
			return;
		}
		void pending.then(
			(result) => {
				if (aborted) return;
				if (isHydrated()) return;
				try {
					apply(result);
				} catch {
					retryOrFail(index);
				}
			},
			() => {
				if (aborted) return;
				retryOrFail(index);
			},
		);
	};

	notify('waiting');
	schedule(initialDelayMs, () => attempt(0));

	return () => {
		aborted = true;
		if (timerId !== undefined) {
			clearTimer(timerId);
			timerId = undefined;
		}
	};
}
