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
/** ui/initialize（ホスト接続）応答待ちの診断タイムアウト（ms） */
const CONNECT_TIMEOUT_MS = 7_000;
/** 接続成立後、ツール結果通知が届かない場合に pull 復元へ切り替えるまでの時間（ms） */
const RESULT_WAIT_HINT_MS = 8_000;
/** この UI が対応する MCP Apps リソース URI（get_ui_snapshot の取得キー） */
const RESOURCE_URI = 'ui://order/confirm.html';
/** スナップショット取得（pull 型 hydration）の timeout（ms） */
const SNAPSHOT_TIMEOUT_MS = 10_000;

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
	// confirmation_token / expires_at は server 側の BITBANK_TRUST_HOST_APPROVAL=1
	// オプトインモードでのみ含まれる。デフォルト（無効化時）と elicitation 経路の
	// fallback では server が strip するため undefined になりうる。
	// 詳細は docs/adr/0007-hitl-confirmation-token-delivery.md。
	confirmation_token?: string;
	expires_at?: number;
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
	// ontoolresult は useEffect([]) 内でクロージャ生成され、preview state は
	// マウント時の値（null）に固定される（stale closure）。preview 受領済みかどうかの
	// 判定は ref で行い、最新値を参照する。
	const hasPreviewRef = useRef(false);
	// ホスト接続・結果受信の診断用状態。無言の「待機中…」で固まらせず、
	// どの段階（ui/initialize / tool-result 配信）で止まっているかを表示する。
	const [connState, setConnState] = useState<'connecting' | 'connected' | 'failed'>('connecting');
	const [resultWaitHint, setResultWaitHint] = useState(false);

	useEffect(() => {
		const mcpApp = new McpApp({ name: 'bitbank-order-confirm', version: '0.1.0' });
		appRef.current = mcpApp;

		// preview 応答の取り込み処理。push 通知（ontoolresult）と pull 復元
		// （get_ui_snapshot）の両経路で共通に使う。
		//
		// preview_order の結果のみ取り込む。他ツール（特に create_order）の結果で
		// state をリセットしないよう data.preview の存在でフィルタする
		// （preview フィールドは preview_* の Result にのみ存在し、create_order 等の
		// 他ツール応答には含まれないため安全）。
		//
		// confirmation_token は意図的に structuredContent には含めない設計
		// （docs/private-api.md「confirmation_token の受け渡し」参照）。
		// SEP-1865 経由の UI 実行経路は pending action store 整備後に解禁予定で、
		// 現状 token が来ないホスト（Claude.ai web 等）では preview 内容のみ表示し、
		// 「このホストでは確認 UI 未対応」案内を出す。
		const applyPreviewStructured = (structured: PreviewResult | undefined) => {
			if (structured?.ok && structured.data?.preview) {
				hasPreviewRef.current = true;
				setResultWaitHint(false);
				setPreview(structured.data.preview);
				if (structured.data.confirmation_token && structured.data.expires_at != null) {
					setToken(structured.data.confirmation_token);
					setTokenExpiresAt(structured.data.expires_at);
				} else {
					setToken(null);
					setTokenExpiresAt(null);
				}
				setStatus('idle');
				setMessage('');
				setOrderId(null);
				return;
			}
			// preview 未受領（preview == null）の iframe に ok:false が来た場合は、
			// その summary をエラーとして描画する（「待機中…」のまま固まらせない）。
			// 例: 最小単位違反などの validation_error で preview_order が失敗したケース。
			//
			// preview 受領後の ok:false は従来どおり無視する。create_order 失敗は
			// handleConfirm 側で表示しており、ここで state をリセットしないためのガード。
			if (structured?.ok === false && !hasPreviewRef.current) {
				setStatus('error');
				setMessage(structured.summary ?? '注文プレビューに失敗しました。');
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
				// 初期テーマ・スタイル適用
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
			// Strict Mode / HMR / アンマウント時に transport・pending request・timeout を解放する
			clearTimeout(connectTimeoutId);
			if (resultWaitTimerId) clearTimeout(resultWaitTimerId);
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
		// preview を受け取る前に preview_order が失敗した場合は、空の「待機中…」では
		// なくエラー内容を描画する（validation_error などで iframe が固まらないように）。
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
					: 'preview_order の結果を待機中…';
		return (
			<div className="app">
				<div className="card">
					<p className="muted">{waitingText}</p>
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

				{!isTerminal && token != null && (
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

				{!isTerminal && token == null && (
					<div className="warn">
						このホストでは注文確定 UI が未対応のため、プレビュー表示のみです。実際に発注するには
						Claude Desktop など elicitation 対応クライアントで同じ操作を実行してください。
					</div>
				)}

				{tokenExpiresAt != null && !isTerminal && (
					<p className="muted">確認トークン有効期限: {dayjs(tokenExpiresAt).format('HH:mm:ss')}</p>
				)}
			</div>
		</div>
	);
}
