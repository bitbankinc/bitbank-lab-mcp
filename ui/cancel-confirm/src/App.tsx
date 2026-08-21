/**
 * 注文キャンセル確認 UI（MCP Apps / SEP-1865）
 *
 * preview_cancel_order / preview_cancel_orders の結果を受け取り、
 * キャンセル対象の注文情報をプレビュー表示するのみ。
 * 実際のキャンセルは elicitation / MRTR クライアント側の確認フローでのみ実行される。
 * この iframe から cancel_order / cancel_orders を呼び出す経路はない。
 */

import {
	App as McpApp,
	applyDocumentTheme,
	applyHostFonts,
	applyHostStyleVariables,
	getDocumentTheme,
} from '@modelcontextprotocol/ext-apps';
import { useEffect, useRef, useState } from 'react';

/** ui/initialize（ホスト接続）応答待ちの診断タイムアウト（ms） */
const CONNECT_TIMEOUT_MS = 7_000;
/** 接続成立後、ツール結果通知が届かない場合に pull 復元へ切り替えるまでの時間（ms）。
 *  push 配信が正常なホストでは通常 1 秒未満で届くため、これは猶予であって遅延ではない。 */
const RESULT_WAIT_HINT_MS = 2_500;
/** この UI が対応する MCP Apps リソース URI（get_ui_snapshot の取得キー） */
const RESOURCE_URI = 'ui://cancel/confirm.html';
/** スナップショット取得（pull 型 hydration）の timeout（ms） */
const SNAPSHOT_TIMEOUT_MS = 10_000;

type Action = 'cancel_order' | 'cancel_orders';

/** 暗号資産の最大小数桁数（bitbank の表示慣行に合わせる） */
const CRYPTO_MAX_FRACTION_DIGITS = 8;
/** JPY の最大小数桁数（整数表示） */
const JPY_MAX_FRACTION_DIGITS = 0;

interface SinglePreview {
	pair: string;
	order_id: number;
}

interface BulkPreview {
	pair: string;
	order_ids: number[];
}

/** preview_cancel_order が同梱する注文詳細（任意） */
interface OrderDetail {
	order_id: number;
	pair: string;
	side: 'buy' | 'sell';
	type: string;
	start_amount: string | null;
	remaining_amount: string | null;
	executed_amount: string;
	price?: string;
	average_price: string;
	trigger_price?: string;
	status: string;
}

interface PreviewResultData {
	// confirmation_token / expires_at はサーバーが返さない。UI はプレビュー表示のみ。
	preview: SinglePreview | BulkPreview;
	order?: OrderDetail;
}

interface PreviewResult {
	ok: boolean;
	summary?: string;
	data?: PreviewResultData;
	meta?: { action?: Action };
}

type Status = 'idle' | 'error';

function formatPair(pair: string): string {
	return pair.toUpperCase().replace('_', '/');
}

function isBulkPreview(p: SinglePreview | BulkPreview): p is BulkPreview {
	return Array.isArray((p as BulkPreview).order_ids);
}

function formatAmount(value: string | null | undefined): string {
	if (value == null) return '—';
	const n = Number(value);
	if (!Number.isFinite(n)) return value;
	return n.toLocaleString('ja-JP', { maximumFractionDigits: CRYPTO_MAX_FRACTION_DIGITS });
}

function formatPrice(value: string | undefined, isJpy: boolean): string {
	if (!value) return '—';
	const n = Number(value);
	if (!Number.isFinite(n)) return value;
	if (isJpy) return `¥${n.toLocaleString('ja-JP', { maximumFractionDigits: JPY_MAX_FRACTION_DIGITS })}`;
	return n.toLocaleString('ja-JP', { maximumFractionDigits: CRYPTO_MAX_FRACTION_DIGITS });
}

function sideLabel(side: 'buy' | 'sell'): { text: string; className: string } {
	if (side === 'buy') return { text: '買い', className: 'side-buy' };
	return { text: '売り', className: 'side-sell' };
}

function typeLabel(type: string): string {
	switch (type) {
		case 'limit':
			return '指値';
		case 'market':
			return '成行';
		case 'stop':
			return '逆指値';
		case 'stop_limit':
			return '逆指値指値';
		default:
			return type;
	}
}

export function App() {
	const [action, setAction] = useState<Action | null>(null);
	const [preview, setPreview] = useState<SinglePreview | BulkPreview | null>(null);
	const [order, setOrder] = useState<OrderDetail | null>(null);
	const [status, setStatus] = useState<Status>('idle');
	const [message, setMessage] = useState<string>('');
	const appRef = useRef<McpApp | null>(null);
	// ontoolresult は useEffect([]) 内のクロージャから最新 state を参照できないため、
	// preview 受領済みかどうかは ref で判定する（order-confirm と同じパターン）。
	const hasPreviewRef = useRef(false);
	// ホスト接続・結果受信の診断用状態。無言の「待機中…」で固まらせず、
	// どの段階（ui/initialize / tool-result 配信）で止まっているかを表示する。
	const [connState, setConnState] = useState<'connecting' | 'connected' | 'failed'>('connecting');
	const [resultWaitHint, setResultWaitHint] = useState(false);

	useEffect(() => {
		const mcpApp = new McpApp({ name: 'bitbank-cancel-confirm', version: '0.1.0' });
		appRef.current = mcpApp;

		// preview 応答の取り込み処理。push 通知（ontoolresult）と pull 復元
		// （get_ui_snapshot）の両経路で共通に使う。
		//
		// preview_cancel_order(s) の結果のみ取り込む。
		// meta.action と preview の存在でフィルタする。
		//
		// サーバーは confirmation_token を返さない。SEP-1865 iframe からの execute
		// 経路はなく、プレビュー表示のみ行う。
		const applyPreviewStructured = (structured: PreviewResult | undefined) => {
			const metaAction = structured?.meta?.action;
			if (
				structured?.ok &&
				structured.data?.preview &&
				(metaAction === 'cancel_order' || metaAction === 'cancel_orders')
			) {
				hasPreviewRef.current = true;
				setResultWaitHint(false);
				setAction(metaAction);
				setPreview(structured.data.preview);
				setOrder(structured.data.order ?? null);
				setStatus('idle');
				setMessage('');
				return;
			}
			if (structured?.ok === false && !hasPreviewRef.current) {
				setStatus('error');
				setMessage(structured.summary ?? 'キャンセルプレビューに失敗しました。');
			}
		};

		mcpApp.ontoolresult = (params) => {
			applyPreviewStructured(params?.structuredContent as PreviewResult | undefined);
		};

		mcpApp.onhostcontextchanged = (ctx) => {
			if (ctx.theme) applyDocumentTheme(ctx.theme);
			if (ctx.styles) applyHostStyleVariables(ctx.styles);
			if (ctx.fontCss) applyHostFonts(ctx.fontCss);
		};

		// 診断タイマー: ui/initialize が応答しない / 接続後に tool-result が届かない場合に
		// 段階別の案内へ表示を切り替える（ホスト側問題の切り分けを画面だけで可能にする）。
		const connectTimeoutId = setTimeout(() => {
			setConnState((s) => (s === 'connecting' ? 'failed' : s));
		}, CONNECT_TIMEOUT_MS);
		let resultWaitTimerId: ReturnType<typeof setTimeout> | undefined;

		mcpApp
			.connect()
			.then(() => {
				clearTimeout(connectTimeoutId);
				setConnState('connected');
				const ctx = mcpApp.getHostContext();
				applyDocumentTheme(ctx?.theme ?? getDocumentTheme());
				if (ctx?.styles) applyHostStyleVariables(ctx.styles);
				if (ctx?.fontCss) applyHostFonts(ctx.fontCss);
				resultWaitTimerId = setTimeout(() => {
					if (hasPreviewRef.current) return;
					setResultWaitHint(true);
					// pull 型 hydration: 一部ホストは ui/notifications/tool-result を配信しない
					// （2026-07-28 ロールアウト後の Claude Desktop で確認）。サーバー側の
					// スナップショット（get_ui_snapshot）から直近の preview 応答を取得して復元する。
					void mcpApp
						.callServerTool(
							{ name: 'get_ui_snapshot', arguments: { resource_uri: RESOURCE_URI } },
							{ timeout: SNAPSHOT_TIMEOUT_MS },
						)
						.then((result) => {
							if (hasPreviewRef.current) return;
							applyPreviewStructured(result.structuredContent as PreviewResult | undefined);
						})
						.catch(() => {
							// スナップショット取得失敗時は案内表示のまま（内容はチャット本文で確認可能）
						});
				}, RESULT_WAIT_HINT_MS);
			})
			.catch(() => {
				// 非対応ホスト or スタンドアロン表示。UI だけ表示する。
				clearTimeout(connectTimeoutId);
				setConnState('failed');
			});

		return () => {
			clearTimeout(connectTimeoutId);
			if (resultWaitTimerId) clearTimeout(resultWaitTimerId);
			const current = appRef.current;
			appRef.current = null;
			void current?.close().catch(() => {
				// close 自体の失敗は無視
			});
		};
	}, []);

	if (!preview || !action) {
		if (status === 'error') {
			return (
				<div className="app">
					<div className="card">
						<div className="status status-error" role="alert" aria-live="assertive" aria-atomic="true">
							❌ {message}
						</div>
					</div>
				</div>
			);
		}
		// 段階別の診断メッセージ。ホスト側の MCP Apps 実装に問題がある場合、
		// どこで止まっているか（接続 or 結果配信）をユーザーがこの表示だけで判別できる。
		const waitingText =
			connState === 'failed'
				? 'ホストとの MCP Apps 接続（ui/initialize）を確立できませんでした。このホストでは確認 UI を利用できません。プレビュー内容はチャット本文を参照してください。'
				: resultWaitHint
					? 'ホストからツール結果（ui/notifications/tool-result）が届かないため、スナップショットからの復元を試みています。表示されない場合はプレビュー内容をチャット本文で確認してください。'
					: 'preview_cancel_order(s) の結果を待機中…';
		return (
			<div className="app">
				<div className="card">
					<p className="muted">{waitingText}</p>
				</div>
			</div>
		);
	}

	const isBulk = isBulkPreview(preview);

	return (
		<div className="app">
			<div className="card">
				<h1 className="title">
					<span className="title-icon" aria-hidden="true">
						🗑️
					</span>
					{isBulk ? '一括キャンセル確認' : 'キャンセル確認'}
				</h1>

				<div className="row">
					<span className="row-label">通貨ペア</span>
					<span className="row-value">{formatPair(preview.pair)}</span>
				</div>

				{isBulk ? (
					<>
						<div className="row">
							<span className="row-label">対象件数</span>
							<span className="row-value">{(preview as BulkPreview).order_ids.length}件</span>
						</div>
						<div className="row">
							<span className="row-label">注文ID</span>
							<span className="row-value">{(preview as BulkPreview).order_ids.join(', ')}</span>
						</div>
					</>
				) : (
					<>
						<div className="row">
							<span className="row-label">注文ID</span>
							<span className="row-value">{(preview as SinglePreview).order_id}</span>
						</div>
						{order && (() => {
							const isJpy = preview.pair.includes('jpy');
							const side = sideLabel(order.side);
							return (
								<>
									<div className="row">
										<span className="row-label">売買方向</span>
										<span className={`row-value ${side.className}`}>{side.text}</span>
									</div>
									<div className="row">
										<span className="row-label">注文タイプ</span>
										<span className="row-value">{typeLabel(order.type)}</span>
									</div>
									<div className="row">
										<span className="row-label">数量</span>
										<span className="row-value">
											{formatAmount(order.start_amount ?? order.executed_amount)}
											{order.remaining_amount && order.remaining_amount !== order.start_amount && (
												<>（残: {formatAmount(order.remaining_amount)}）</>
											)}
										</span>
									</div>
									<div className="row">
										<span className="row-label">価格</span>
										<span className="row-value">
											{order.type === 'market' ? '成行' : formatPrice(order.price, isJpy)}
										</span>
									</div>
									{order.trigger_price && (
										<div className="row">
											<span className="row-label">トリガー価格</span>
											<span className="row-value">{formatPrice(order.trigger_price, isJpy)}</span>
										</div>
									)}
									{order.average_price && order.average_price !== '0' && (
										<div className="row">
											<span className="row-label">平均約定価格</span>
											<span className="row-value">{formatPrice(order.average_price, isJpy)}</span>
										</div>
									)}
									<div className="row">
										<span className="row-label">ステータス</span>
										<span className="row-value">{order.status}</span>
									</div>
								</>
							);
						})()}
					</>
				)}

				<div className="warn">
					⚠️ この操作は取り消せません。この iframe はプレビュー表示のみです。実際のキャンセルは
					elicitation / MRTR 対応クライアントでの確認フローでのみ実行されます。
				</div>
			</div>
		</div>
	);
}
