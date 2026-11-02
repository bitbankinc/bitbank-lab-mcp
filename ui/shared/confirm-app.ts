// トークンは `_meta` からしか読まない。`content` / `structuredContent` には載っておらず、それが「LLM には見えないがこの iframe には見える」という認可の根拠になっている（ADR-0007）。

import {
	App as McpApp,
	applyDocumentTheme,
	applyHostFonts,
	applyHostStyleVariables,
	getDocumentTheme,
} from '@modelcontextprotocol/ext-apps';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { type SnapshotHydrationPhase, startSnapshotHydration } from '../../src/mcp-apps-hydration.js';

const CONNECT_TIMEOUT_MS = 7_000;
const SNAPSHOT_TIMEOUT_MS = 10_000;

export type ConnState = 'connecting' | 'connected' | 'failed';

export type Status = 'idle' | 'submitting' | 'success' | 'error' | 'cancelled' | 'expired';

/** 送信後の終端状態。ボタンを引っ込めて二重実行を防ぐ。 */
export const TERMINAL_STATUSES: ReadonlySet<Status> = new Set<Status>(['success', 'cancelled', 'expired']);

/** preview を取り込んだら true を返す。preview 未受領の iframe に来た ok:false の表示も呼び出し側で行う。 */
export type ApplyToolResult = (structured: unknown, meta: unknown, hasPreview: boolean) => boolean;

export function useConfirmApp(
	appName: string,
	resourceUri: string,
	applyToolResult: ApplyToolResult,
): { appRef: RefObject<McpApp | null>; connState: ConnState; hydrationPhase: SnapshotHydrationPhase } {
	const appRef = useRef<McpApp | null>(null);
	// ontoolresult は useEffect([]) 内で作られ state がマウント時の値に固定される（stale closure）ので、受領済みかの判定は ref で行う。
	const hasPreviewRef = useRef(false);
	// 無言の「待機中…」で固まらせず、どの段階（ui/initialize / tool-result 配信）で止まっているかを表示するための状態。
	const [connState, setConnState] = useState<ConnState>('connecting');
	const [hydrationPhase, setHydrationPhase] = useState<SnapshotHydrationPhase>('waiting');

	useEffect(() => {
		const mcpApp = new McpApp({ name: appName, version: '0.1.0' });
		appRef.current = mcpApp;

		const applyPreviewResult = (structured: unknown, meta: unknown) => {
			if (applyToolResult(structured, meta, hasPreviewRef.current)) {
				hasPreviewRef.current = true;
				setHydrationPhase('waiting');
			}
		};

		mcpApp.ontoolresult = (params) => {
			applyPreviewResult(params?.structuredContent, params?._meta);
		};

		mcpApp.onhostcontextchanged = (ctx) => {
			if (ctx.theme) applyDocumentTheme(ctx.theme);
			if (ctx.styles) applyHostStyleVariables(ctx.styles);
			if (ctx.fontCss) applyHostFonts(ctx.fontCss);
		};

		const connectTimeoutId = setTimeout(() => {
			setConnState((s) => (s === 'connecting' ? 'failed' : s));
		}, CONNECT_TIMEOUT_MS);
		let stopHydration: (() => void) | undefined;
		// connect() が pending のままアンマウントされると .then() は cleanup の後に走るので、破棄済みなら hydration を開始しない（#29）。
		let disposed = false;

		mcpApp
			.connect()
			.then(() => {
				clearTimeout(connectTimeoutId);
				setConnState('connected');
				const ctx = mcpApp.getHostContext();
				applyDocumentTheme(ctx?.theme ?? getDocumentTheme());
				if (ctx?.styles) applyHostStyleVariables(ctx.styles);
				if (ctx?.fontCss) applyHostFonts(ctx.fontCss);
				if (disposed) return;
				// 一部ホストは ui/notifications/tool-result を配信しないので、get_ui_snapshot から直近の preview 応答を取得して復元する。
				stopHydration = startSnapshotHydration({
					fetchSnapshot: () =>
						mcpApp.callServerTool(
							{ name: 'get_ui_snapshot', arguments: { resource_uri: resourceUri } },
							{ timeout: SNAPSHOT_TIMEOUT_MS },
						),
					isHydrated: () => hasPreviewRef.current,
					apply: (result) => {
						// get_ui_snapshot も同じ `_meta` 契約でトークンを返す（有効化ゲートはサーバー側で再判定される）。
						const snapshot = result as { structuredContent?: unknown; _meta?: unknown };
						applyPreviewResult(snapshot.structuredContent, snapshot._meta);
						// 取り込めなかったら失敗として throw する。resolve したまま終わるとリトライも failed 表示も起きず「復元中」のまま固まる（#29）。
						if (!hasPreviewRef.current) {
							throw new Error('snapshot did not contain a usable preview');
						}
					},
					onPhase: setHydrationPhase,
				});
			})
			.catch(() => {
				clearTimeout(connectTimeoutId);
				setConnState('failed');
			});

		return () => {
			disposed = true;
			clearTimeout(connectTimeoutId);
			stopHydration?.();
			const current = appRef.current;
			appRef.current = null;
			void current?.close().catch(() => {
				// close 自体の失敗は無視（既に切断済み等）
			});
		};
	}, []);

	return { appRef, connState, hydrationPhase };
}

export interface ExecuteTexts {
	expired: string;
	failed: string;
	succeeded: string;
	unexpected: string;
}

export type ExecuteOutcome =
	| { status: 'expired' | 'error'; message: string }
	| { status: 'success'; message: string; structured: unknown };

export async function executeConfirmed(opts: {
	app: McpApp | null;
	expiresAt: number;
	call: { name: string; arguments: Record<string, unknown> };
	timeoutMs: number;
	texts: ExecuteTexts;
	onSubmitting: () => void;
}): Promise<ExecuteOutcome> {
	const { app, expiresAt, call, timeoutMs, texts, onSubmitting } = opts;
	// クライアント側の期限チェックは UX のため。認可上の期限判定はサーバーの validateToken が行う。
	if (Date.now() > expiresAt) return { status: 'expired', message: texts.expired };
	if (!app) return { status: 'error', message: 'ホストに接続していません。' };
	onSubmitting();
	try {
		const result = await app.callServerTool(call, { timeout: timeoutMs });
		if (result.isError) {
			return { status: 'error', message: result.content?.find((c) => c.type === 'text')?.text ?? texts.failed };
		}
		const structured = result.structuredContent as { ok?: boolean; summary?: string } | undefined;
		if (structured?.ok === false) return { status: 'error', message: structured.summary ?? texts.failed };
		return { status: 'success', message: structured?.summary ?? texts.succeeded, structured };
	} catch (err) {
		return { status: 'error', message: err instanceof Error ? err.message : texts.unexpected };
	}
}
