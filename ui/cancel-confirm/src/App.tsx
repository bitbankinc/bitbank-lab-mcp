/**
 * 注文キャンセル確認 UI（MCP Apps / SEP-1865）
 *
 * preview_cancel_order / preview_cancel_orders の結果を受け取り、
 * キャンセル対象の注文情報を表示。
 * 「キャンセルを確定する」で `app.callServerTool('cancel_order' | 'cancel_orders', ...)`
 * を呼び出し、ホストの同一サーバー接続経由で実際のキャンセルを行う。
 */

import {
	App as McpApp,
	applyDocumentTheme,
	applyHostFonts,
	applyHostStyleVariables,
	getDocumentTheme,
} from '@modelcontextprotocol/ext-apps';
import dayjs from 'dayjs';
import { useEffect, useRef, useState } from 'react';

/** cancel_order(s) 呼び出しの timeout（ms）。サーバー側のツール timeout 60s より少し短く設定 */
const CANCEL_ORDER_TIMEOUT_MS = 45_000;

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
	confirmation_token: string;
	expires_at: number;
	preview: SinglePreview | BulkPreview;
	order?: OrderDetail;
}

interface PreviewResult {
	ok: boolean;
	summary?: string;
	data?: PreviewResultData;
	meta?: { action?: Action };
}

type Status = 'idle' | 'submitting' | 'success' | 'error' | 'cancelled' | 'expired';

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
	const [token, setToken] = useState<string | null>(null);
	const [tokenExpiresAt, setTokenExpiresAt] = useState<number | null>(null);
	const [status, setStatus] = useState<Status>('idle');
	const [message, setMessage] = useState<string>('');
	const appRef = useRef<McpApp | null>(null);

	useEffect(() => {
		const mcpApp = new McpApp({ name: 'bitbank-cancel-confirm', version: '0.1.0' });
		appRef.current = mcpApp;

		mcpApp.ontoolresult = (params) => {
			// preview_cancel_order(s) の結果のみ取り込む。
			// meta.action が cancel_order / cancel_orders のいずれかかつ preview / token が
			// 揃っているレスポンスのみを取り込み、cancel_order(s) の結果では state を
			// リセットしないようにフィルタする。
			const structured = params?.structuredContent as PreviewResult | undefined;
			const metaAction = structured?.meta?.action;
			if (
				structured?.ok &&
				structured.data?.preview &&
				structured.data.confirmation_token &&
				(metaAction === 'cancel_order' || metaAction === 'cancel_orders')
			) {
				setAction(metaAction);
				setPreview(structured.data.preview);
				setOrder(structured.data.order ?? null);
				setToken(structured.data.confirmation_token);
				setTokenExpiresAt(structured.data.expires_at);
				setStatus('idle');
				setMessage('');
			}
		};

		mcpApp.onhostcontextchanged = (ctx) => {
			if (ctx.theme) applyDocumentTheme(ctx.theme);
			if (ctx.styles) applyHostStyleVariables(ctx.styles);
			if (ctx.fontCss) applyHostFonts(ctx.fontCss);
		};

		mcpApp
			.connect()
			.then(() => {
				const ctx = mcpApp.getHostContext();
				applyDocumentTheme(ctx?.theme ?? getDocumentTheme());
				if (ctx?.styles) applyHostStyleVariables(ctx.styles);
				if (ctx?.fontCss) applyHostFonts(ctx.fontCss);
			})
			.catch(() => {
				// 非対応ホスト or スタンドアロン表示。UI だけ表示する。
			});

		return () => {
			const current = appRef.current;
			appRef.current = null;
			void current?.close().catch(() => {
				// close 自体の失敗は無視
			});
		};
	}, []);

	const handleConfirm = async () => {
		if (!preview || !token || tokenExpiresAt == null || !action) return;
		if (Date.now() > tokenExpiresAt) {
			setStatus('expired');
			setMessage(
				'確認トークンの有効期限が切れました。もう一度 preview_cancel_order(s) を実行してください。',
			);
			return;
		}
		const app = appRef.current;
		if (!app) {
			setStatus('error');
			setMessage('ホストに接続していません。');
			return;
		}
		setStatus('submitting');
		setMessage('');
		try {
			const args: Record<string, unknown> = {
				pair: preview.pair,
				confirmation_token: token,
				token_expires_at: tokenExpiresAt,
			};
			if (isBulkPreview(preview)) {
				args.order_ids = preview.order_ids;
			} else {
				args.order_id = preview.order_id;
			}

			const result = await app.callServerTool(
				{ name: action, arguments: args },
				{ timeout: CANCEL_ORDER_TIMEOUT_MS },
			);
			if (result.isError) {
				const text = result.content?.find((c) => c.type === 'text')?.text ?? 'キャンセルに失敗しました';
				setStatus('error');
				setMessage(text);
				return;
			}
			const structured = result.structuredContent as { ok?: boolean; summary?: string } | undefined;
			if (structured?.ok === false) {
				setStatus('error');
				setMessage(structured.summary ?? 'キャンセルに失敗しました');
				return;
			}
			setStatus('success');
			setMessage(structured?.summary ?? 'キャンセルを受け付けました');
		} catch (err) {
			setStatus('error');
			setMessage(err instanceof Error ? err.message : 'キャンセル中に予期しないエラーが発生しました');
		}
	};

	const handleAbort = () => {
		setStatus('cancelled');
		setMessage('このキャンセル操作は取り消されました。');
	};

	if (!preview || !action) {
		return (
			<div className="app">
				<div className="card">
					<p className="muted">preview_cancel_order(s) の結果を待機中…</p>
				</div>
			</div>
		);
	}

	const isBulk = isBulkPreview(preview);
	const isTerminal = status === 'success' || status === 'cancelled' || status === 'expired';

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
					⚠️ この操作は取り消せません。確定するとサーバーで cancel_{isBulk ? 'orders' : 'order'} が実行されます。
				</div>

				{status === 'success' && (
					<div className="status status-success" role="status" aria-live="polite" aria-atomic="true">
						✅ {message}
					</div>
				)}
				{status === 'error' && (
					<div className="status status-error" role="alert" aria-live="assertive" aria-atomic="true">
						❌ {message}
					</div>
				)}
				{status === 'cancelled' && (
					<div className="status status-cancelled" role="status" aria-live="polite" aria-atomic="true">
						{message}
					</div>
				)}
				{status === 'expired' && (
					<div className="status status-error" role="alert" aria-live="assertive" aria-atomic="true">
						⏰ {message}
					</div>
				)}

				{!isTerminal && (
					<div className="actions">
						<button
							type="button"
							className="btn btn-secondary"
							onClick={handleAbort}
							disabled={status === 'submitting'}
						>
							やめる
						</button>
						<button
							type="button"
							className="btn btn-primary"
							onClick={handleConfirm}
							disabled={status === 'submitting'}
						>
							{status === 'submitting' ? '送信中…' : 'キャンセルを確定する'}
						</button>
					</div>
				)}

				{tokenExpiresAt != null && !isTerminal && (
					<p className="muted">確認トークン有効期限: {dayjs(tokenExpiresAt).format('HH:mm:ss')}</p>
				)}
			</div>
		</div>
	);
}
