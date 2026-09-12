/**
 * 確認 UI（iframe）の pull 型 hydration（`get_ui_snapshot` からのスナップショット復元）を
 * 上限付きリトライ・abort 付きで駆動する。
 *
 * **サーバーと UI バンドルの両方の import 対象になりうるモジュール**なので、`src/mcp-apps-meta.ts`
 * と同じく Node 依存（`node:*` / `process`）も重い依存も持たせない。React にも依存しない
 * （純粋な関数 1 本 + タイマー注入）ので、node 環境の vitest でフェイクタイマーだけで固定できる。
 *
 * 背景: 一部ホスト（2026-07-28 ロールアウト後の Claude Desktop 等）は
 * `ui/notifications/tool-result` を iframe に配信しない。iframe は接続成立後に一定時間待って
 * 結果が届かなければ `get_ui_snapshot` を自分で呼ぶ（ADR-0007 判断事項 A）。この pull 経路が
 * **1 回しか試さず、失敗すると「復元中」の案内のまま固まる**のが issue #29 の指摘で、
 * ここに上限付きリトライと abort を入れて両 UI で共有する。
 *
 * 本モジュールは `fetchSnapshot` の結果を `apply` へ透過的に渡すだけで、**内容を読まない・
 * ログにも出さない**。確認トークンはツール結果 `_meta` で流れる（`.claude/rules/sensitive-data.md`）。
 */

/**
 * 復元の段階。UI はこれを受けて待機表示を切り替える。
 *
 * - `waiting`: 初回待ち（push 配信の猶予中。まだ `fetchSnapshot` を呼んでいない）
 * - `restoring`: 試行中（`fetchSnapshot` を呼んだ。リトライのたびに再通知される）
 * - `failed`: 上限到達（以後の試行は無い。UI は「復元できませんでした」を出す）
 */
export type SnapshotHydrationPhase = 'waiting' | 'restoring' | 'failed';

/**
 * 初回待ち（ms）の既定値。接続成立から `fetchSnapshot` の 1 回目までの猶予。
 *
 * push 配信が正常なホストでは結果は通常 1 秒未満で届くため、これは猶予であって遅延ではない。
 */
export const DEFAULT_INITIAL_DELAY_MS = 2_500;

/**
 * リトライ間隔（ms）の既定値。試行回数は `1 + DEFAULT_RETRY_DELAYS_MS.length` = 3 回。
 *
 * 待ち時間の合計は 2.5 + 2 + 4 = 8.5 秒 + 各試行のスナップショット取得 timeout
 * （UI 側 `SNAPSHOT_TIMEOUT_MS` = 10 秒）で、最悪でも 38.5 秒。UI 側の接続タイムアウト
 * （`CONNECT_TIMEOUT_MS` = 7 秒）は接続成立の判定用で hydration 開始より前に決着しており、
 * サーバー側のツール実行 timeout（60 秒）は 1 リクエスト単位なので、どちらとも矛盾しない。
 */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000];

/** 予約済みタイマーの識別子。ブラウザでは number、Node では Timeout になる。 */
export type TimerId = ReturnType<typeof globalThis.setTimeout>;

/**
 * タイマー注入の最小契約。
 *
 * `typeof globalThis.setTimeout` をそのまま要求すると、Node の型が `__promisify__` まで
 * 持つため**素の関数を渡せなくなる**（注入という目的が果たせない）。本モジュールが使うのは
 * 「関数と遅延を渡して ID を受け取る / ID で取り消す」だけなので、そこだけを型にする。
 */
export type SetTimeoutLike = (handler: () => void, timeoutMs: number) => TimerId;
export type ClearTimeoutLike = (timerId: TimerId) => void;

/**
 * 差し替え可能なタイマー実装。**予約と取り消しは必ず同じ実装で行う**ため、
 * 片方だけ差し替えられない形（1 つのオブジェクト）で受け取る。
 *
 * 混ぜると予約側が返した ID を取り消し側が知らず、**abort してもタイマーが残る**
 * （停止関数が仕事をしなくなる。CodeRabbit が #285 で指摘）。
 */
export interface SnapshotHydrationTimers {
	setTimeout: SetTimeoutLike;
	clearTimeout: ClearTimeoutLike;
}

/** 既定のタイマー。ブラウザの window.setTimeout は receiver を外すと Illegal invocation に
 *  なりうるので、メソッド呼び出しのまま包む。 */
const globalTimers: SnapshotHydrationTimers = {
	setTimeout: (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs),
	clearTimeout: (timerId) => globalThis.clearTimeout(timerId),
};

export interface SnapshotHydrationOptions {
	/** get_ui_snapshot を呼ぶ。UI 側で mcpApp.callServerTool を包んで渡す */
	fetchSnapshot: () => Promise<unknown>;
	/** push 配信等で既に復元済みなら true。true なら以後の試行を止める */
	isHydrated: () => boolean;
	/** 取得できた結果を UI に適用する。isHydrated() が false のときだけ呼ばれる */
	apply: (result: unknown) => void;
	/** 段階の通知: 'waiting'（初回待ち）→ 'restoring'（試行中）→ 'failed'（上限到達） */
	onPhase?: (phase: SnapshotHydrationPhase) => void;
	/** 初回待ち（既定 2_500ms） */
	initialDelayMs?: number;
	/** リトライ間隔（既定 [2_000, 4_000]。試行回数は 1 + この配列の長さ = 3） */
	retryDelaysMs?: readonly number[];
	/** テスト注入用。予約と取り消しの取り違えを防ぐため**ペアでのみ**差し替えられる */
	timers?: SnapshotHydrationTimers;
}

/**
 * スナップショット復元を開始し、**止める関数**を返す。cleanup（アンマウント）で必ず呼ぶ。
 *
 * 止めた後は `apply` も `onPhase` も一切呼ばれない。実行中の `fetchSnapshot` の
 * resolve / reject、予約済みタイマーの発火、次のリトライ予約のすべての入口で `aborted` を見る
 * （issue #29 の指摘 2: cleanup がタイマーしか解放せず promise チェーンが生き残っていた）。
 *
 * リトライ経路に乗るのは **`fetchSnapshot` の reject** と **`apply` が投げた例外**の両方。
 * 上限に達したら `onPhase('failed')` をちょうど 1 回呼び、タイマーを残さず終了する。
 * 途中で `isHydrated()` が true になった場合は黙って終了する（`failed` は出さない）。
 */
export function startSnapshotHydration(opts: SnapshotHydrationOptions): () => void {
	const {
		fetchSnapshot,
		isHydrated,
		apply,
		onPhase,
		initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
		retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
	} = opts;
	// 既定は globalThis のタイマー。参照はここで解決するのではなく呼び出しのたびに辿るので、
	// テスト側がフェイクタイマーを入れてから呼べばそれが使われる。
	const { setTimeout: setTimer, clearTimeout: clearTimer } = opts.timers ?? globalTimers;

	let aborted = false;
	let timerId: TimerId | undefined;

	/** 段階を UI へ通知する。abort 後は一切通知しない（停止の唯一の出口をここに閉じる）。 */
	const notify = (phase: SnapshotHydrationPhase): void => {
		if (aborted) return;
		onPhase?.(phase);
	};

	/** 次の処理を予約する。発火時にも abort を見るので、停止関数が間に合わなくても走らない。 */
	const schedule = (delayMs: number, run: () => void): void => {
		timerId = setTimer(() => {
			timerId = undefined;
			if (aborted) return;
			run();
		}, delayMs);
	};

	/** 試行 `index` が失敗した。次の間隔があれば予約し、無ければ `failed` で終わる。 */
	const retryOrFail = (index: number): void => {
		if (aborted) return;
		// 失敗している間に push 配信が届いていたら、復元は済んでいるので黙って終わる。
		if (isHydrated()) return;
		const delayMs = retryDelaysMs[index];
		if (delayMs == null) {
			notify('failed');
			return;
		}
		schedule(delayMs, () => attempt(index + 1));
	};

	/** 試行 `index` を実行する。resolve / reject / 同期 throw のすべてを `retryOrFail` に集約する。 */
	const attempt = (index: number): void => {
		if (aborted) return;
		// 各試行の前に見る。push 配信が先に届いていれば 1 回も呼ばない。
		if (isHydrated()) return;
		notify('restoring');
		let pending: Promise<unknown>;
		try {
			pending = Promise.resolve(fetchSnapshot());
		} catch {
			// fetchSnapshot が同期的に投げた場合も reject と同じ経路に乗せる。
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
					// apply の例外は握りつぶさず次の試行へ（最後まで失敗なら failed）。
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
