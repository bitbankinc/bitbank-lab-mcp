/**
 * 注文確認 UI（MCP Apps / SEP-1865）
 *
 * preview_order の結果を受け取り、注文内容を表示。
 * 「注文を確定する」で `app.callServerTool('create_order', ...)` を呼び出し、
 * ホストの同一サーバー接続経由で実際の発注を行う。
 */

import {
	App as McpApp,
	applyDocumentTheme,
	applyHostFonts,
	applyHostStyleVariables,
	getDocumentTheme,
} from '@modelcontextprotocol/ext-apps';
import dayjs from 'dayjs';
import { useEffect, useMemo, useRef, useState } from 'react';

type Side = 'buy' | 'sell';
type OrderType = 'limit' | 'market' | 'stop' | 'stop_limit';
type PositionSide = 'long' | 'short';

/** 暗号資産の最大小数桁数（bitbank の表示慣行に合わせる） */
const CRYPTO_MAX_FRACTION_DIGITS = 8;
/** JPY の最大小数桁数（整数表示） */
const JPY_MAX_FRACTION_DIGITS = 0;
/** create_order 呼び出しの timeout（ms）。サーバー側のツール timeout 60s より少し短く設定 */
const CREATE_ORDER_TIMEOUT_MS = 45_000;

interface PreviewArgs {
	pair: string;
	amount: string;
	side: Side;
	type: OrderType;
	price?: string;
	trigger_price?: string;
	post_only?: boolean;
	position_side?: PositionSide;
}

interface PreviewResultData {
	confirmation_token: string;
	expires_at: number;
	preview: PreviewArgs;
}

interface PreviewResult {
	ok: boolean;
	summary?: string;
	data?: PreviewResultData;
	meta?: { action?: string };
}

type Status = 'idle' | 'submitting' | 'success' | 'error' | 'cancelled' | 'expired';

function formatPair(pair: string): string {
	return pair.toUpperCase().replace('_', '/');
}

function formatAmount(value: string): string {
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

function estimateTotal(preview: PreviewArgs): string | null {
	if (!preview.price) return null;
	const p = Number(preview.price);
	const a = Number(preview.amount);
	if (!Number.isFinite(p) || !Number.isFinite(a)) return null;
	const isJpy = preview.pair.includes('jpy');
	const total = p * a;
	if (isJpy) return `¥${total.toLocaleString('ja-JP', { maximumFractionDigits: JPY_MAX_FRACTION_DIGITS })}`;
	return total.toLocaleString('ja-JP', { maximumFractionDigits: CRYPTO_MAX_FRACTION_DIGITS });
}

function sideLabel(side: Side, positionSide?: PositionSide): { text: string; className: string } {
	const base = side === 'buy' ? '買い' : '売り';
	const cls = side === 'buy' ? 'side-buy' : 'side-sell';
	if (!positionSide) return { text: base, className: cls };
	const posLabel = positionSide === 'long' ? 'ロング' : 'ショート';
	const isOpen = (side === 'buy' && positionSide === 'long') || (side === 'sell' && positionSide === 'short');
	return { text: `${base}（信用${isOpen ? '新規' : '決済'}・${posLabel}）`, className: cls };
}

function typeLabel(type: OrderType): string {
	switch (type) {
		case 'limit':
			return '指値';
		case 'market':
			return '成行';
		case 'stop':
			return '逆指値';
		case 'stop_limit':
			return '逆指値指値';
	}
}

export function App() {
	const [preview, setPreview] = useState<PreviewArgs | null>(null);
	const [token, setToken] = useState<string | null>(null);
	const [tokenExpiresAt, setTokenExpiresAt] = useState<number | null>(null);
	const [status, setStatus] = useState<Status>('idle');
	const [message, setMessage] = useState<string>('');
	const [orderId, setOrderId] = useState<number | null>(null);
	const appRef = useRef<McpApp | null>(null);

	useEffect(() => {
		const mcpApp = new McpApp({ name: 'bitbank-order-confirm', version: '0.1.0' });
		appRef.current = mcpApp;

		mcpApp.ontoolresult = (params) => {
			// preview_order の結果のみ取り込む。他ツール（特に create_order）の結果で
			// state をリセットしないよう data.preview / confirmation_token の存在で
			// フィルタする（PreviewOrderMetaSchema は action: z.literal('create_order')、
			// 他ツール応答に preview / confirmation_token は含まれないため安全）。
			const structured = params?.structuredContent as PreviewResult | undefined;
			if (structured?.ok && structured.data?.preview && structured.data.confirmation_token) {
				setPreview(structured.data.preview);
				setToken(structured.data.confirmation_token);
				setTokenExpiresAt(structured.data.expires_at);
				setStatus('idle');
				setMessage('');
				setOrderId(null);
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
				// 初期テーマ・スタイル適用
				const ctx = mcpApp.getHostContext();
				applyDocumentTheme(ctx?.theme ?? getDocumentTheme());
				if (ctx?.styles) applyHostStyleVariables(ctx.styles);
				if (ctx?.fontCss) applyHostFonts(ctx.fontCss);
			})
			.catch(() => {
				// 非対応ホスト or スタンドアロン表示。UI だけ表示する。
			});

		return () => {
			// Strict Mode / HMR / アンマウント時に transport・pending request・timeout を解放する
			const current = appRef.current;
			appRef.current = null;
			void current?.close().catch(() => {
				// close 自体の失敗は無視（既に切断済み等）
			});
		};
	}, []);

	const isJpy = useMemo(() => (preview ? preview.pair.includes('jpy') : false), [preview]);

	const handleConfirm = async () => {
		if (!preview || !token || tokenExpiresAt == null) return;
		if (Date.now() > tokenExpiresAt) {
			setStatus('expired');
			setMessage('確認トークンの有効期限が切れました。もう一度 preview_order を実行してください。');
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
				amount: preview.amount,
				side: preview.side,
				type: preview.type,
				confirmation_token: token,
				token_expires_at: tokenExpiresAt,
			};
			if (preview.price) args.price = preview.price;
			if (preview.trigger_price) args.trigger_price = preview.trigger_price;
			if (preview.post_only != null) args.post_only = preview.post_only;
			if (preview.position_side) args.position_side = preview.position_side;

			const result = await app.callServerTool(
				{ name: 'create_order', arguments: args },
				{ timeout: CREATE_ORDER_TIMEOUT_MS },
			);
			if (result.isError) {
				const text = result.content?.find((c) => c.type === 'text')?.text ?? '注文に失敗しました';
				setStatus('error');
				setMessage(text);
				return;
			}
			const structured = result.structuredContent as
				| { ok?: boolean; summary?: string; data?: { order?: { order_id?: number } } }
				| undefined;
			if (structured?.ok === false) {
				setStatus('error');
				setMessage(structured.summary ?? '注文に失敗しました');
				return;
			}
			setStatus('success');
			setMessage(structured?.summary ?? '注文を受け付けました');
			setOrderId(structured?.data?.order?.order_id ?? null);
		} catch (err) {
			setStatus('error');
			setMessage(err instanceof Error ? err.message : '注文中に予期しないエラーが発生しました');
		}
	};

	const handleCancel = () => {
		setStatus('cancelled');
		setMessage('この注文はキャンセルされました。');
	};

	if (!preview) {
		return (
			<div className="app">
				<div className="card">
					<p className="muted">preview_order の結果を待機中…</p>
				</div>
			</div>
		);
	}

	const side = sideLabel(preview.side, preview.position_side);
	const total = estimateTotal(preview);
	const isTerminal = status === 'success' || status === 'cancelled' || status === 'expired';

	return (
		<div className="app">
			<div className="card">
				<h1 className="title">
					<span className="title-icon" aria-hidden="true">
						📋
					</span>
					注文確認
				</h1>

				<div className="row">
					<span className="row-label">通貨ペア</span>
					<span className="row-value">{formatPair(preview.pair)}</span>
				</div>
				<div className="row">
					<span className="row-label">売買方向</span>
					<span className={`row-value ${side.className}`}>{side.text}</span>
				</div>
				<div className="row">
					<span className="row-label">注文タイプ</span>
					<span className="row-value">{typeLabel(preview.type)}</span>
				</div>
				<div className="row">
					<span className="row-label">数量</span>
					<span className="row-value">{formatAmount(preview.amount)}</span>
				</div>
				<div className="row">
					<span className="row-label">価格</span>
					<span className="row-value">
						{preview.type === 'market' ? '成行' : formatPrice(preview.price, isJpy)}
					</span>
				</div>
				{preview.trigger_price && (
					<div className="row">
						<span className="row-label">トリガー価格</span>
						<span className="row-value">{formatPrice(preview.trigger_price, isJpy)}</span>
					</div>
				)}
				{total && (
					<div className="row">
						<span className="row-label">合計概算</span>
						<span className="row-value">{total}</span>
					</div>
				)}
				{preview.post_only && (
					<div className="row">
						<span className="row-label">Post Only</span>
						<span className="row-value">有効</span>
					</div>
				)}

				{preview.position_side && (
					<div className="warn">⚠️ 信用取引です。損失が保証金を超える可能性があります。</div>
				)}

				{status === 'success' && (
					<div className="status status-success" role="status" aria-live="polite" aria-atomic="true">
						✅ {message}
						{orderId != null && (
							<>
								<br />
								注文ID: {orderId}
							</>
						)}
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
							onClick={handleCancel}
							disabled={status === 'submitting'}
						>
							キャンセル
						</button>
						<button
							type="button"
							className="btn btn-primary"
							onClick={handleConfirm}
							disabled={status === 'submitting'}
						>
							{status === 'submitting' ? '送信中…' : '注文を確定する'}
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
