/**
 * 注文キャンセル確認 UI（MCP Apps / SEP-1865）
 *
 * preview_cancel_order / preview_cancel_orders の結果を受け取り、対象注文を表示する。
 *
 * サーバーが MCP Apps 実行経路を有効化している場合（`BITBANK_MCP_APPS_EXECUTE=1` +
 * ホストが MCP Apps UI を宣言）、ツール結果の `_meta` に確認トークンが載る。その場合のみ
 * 確定ボタンを描画し、`app.callServerTool('cancel_order' | 'cancel_orders', ...)` を呼ぶ。
 * トークンが無ければ従来どおりプレビュー表示のみ（ボタンは出さない）。
 *
 * トークンは `_meta` からしか読まない。`content` / `structuredContent` には載っておらず、
 * それが「LLM には見えないがこの iframe には見える」という認可の根拠になっている。
 * 設計の背景は docs/adr/0007-hitl-confirmation-token-delivery.md を参照。
 */

import {
	App as McpApp,
	applyDocumentTheme,
	applyHostFonts,
	applyHostStyleVariables,
	getDocumentTheme,
} from '@modelcontextprotocol/ext-apps';
import { useEffect, useRef, useState } from 'react';
import { type ConfirmationMetaPayload, readConfirmationMeta } from '../../../src/mcp-apps-meta.js';

/** cancel_order(s) 呼び出しの timeout（ms）。サーバー側のツール timeout 60s より少し短く設定 */
const CANCEL_TIMEOUT_MS = 45_000;
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
	// confirmation_token / expires_at は structuredContent には載らない（サーバーが strip する）。
	// トークンはツール結果 `_meta` から別途読み取る。
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

/** 送信後の終端状態。ボタンを引っ込めて二重キャンセルを防ぐ。 */
const TERMINAL_STATUSES: ReadonlySet<Status> = new Set<Status>(['success', 'cancelled', 'expired']);

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
	// MCP Apps 実行経路が有効なときだけ `_meta` から入る。null ならボタンを描画しない。
	const [confirmation, setConfirmation] = useState<ConfirmationMetaPayload | null>(null);
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
		// confirmation_token は `_meta` にしか載らない（structuredContent からは strip 済み）。
		// 載っていなければボタンは描画されず、従来どおりプレビュー表示のみになる。
		const applyPreviewResult = (structured: PreviewResult | undefined, meta: unknown) => {
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
				setConfirmation(readConfirmationMeta(meta) ?? null);
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
			applyPreviewResult(params?.structuredContent as PreviewResult | undefined, params?._meta);
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
							// get_ui_snapshot も同じ `_meta` 契約でトークンを返す（push 配信が
							// 効かないホスト向け。有効化ゲートはサーバー側で再判定される）。
							applyPreviewResult(result.structuredContent as PreviewResult | undefined, result._meta);
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
	const isTerminal = TERMINAL_STATUSES.has(status);

	const handleConfirm = async () => {
		if (!confirmation) return;
		// クライアント側の期限チェックは UX のため（無駄な往復を省く）。
		// 認可上の期限判定はサーバーの validateToken が行う。
		if (Date.now() > confirmation.expires_at) {
			setStatus('expired');
			setMessage('確認の有効期限が切れました。もう一度プレビューを実行してください。');
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
			// preview と同じパラメータで呼ぶ。1 つでも違うとサーバー側の HMAC 検証が
			// token_invalid で落ちる（ユーザーが見ていない対象を取り消させないための束縛）。
			const args: Record<string, unknown> = isBulk
				? { pair: preview.pair, order_ids: (preview as BulkPreview).order_ids }
				: { pair: preview.pair, order_id: (preview as SinglePreview).order_id };
			args.confirmation_token = confirmation.confirmation_token;
			args.token_expires_at = confirmation.expires_at;

			const result = await app.callServerTool({ name: action, arguments: args }, { timeout: CANCEL_TIMEOUT_MS });
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

	const handleDismiss = () => {
		setStatus('cancelled');
		setMessage('この操作は取り消されました（注文はそのまま残っています）。');
	};

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

				<div className="warn">⚠️ キャンセルした注文は元に戻せません。</div>

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

				{!isTerminal && confirmation != null && (
					<div className="actions">
						<button
							type="button"
							className="btn btn-secondary"
							onClick={handleDismiss}
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
							{status === 'submitting'
								? '送信中…'
								: isBulk
									? '一括キャンセルを確定する'
									: 'キャンセルを確定する'}
						</button>
					</div>
				)}

				{!isTerminal && confirmation == null && (
					<div className="warn">
						この iframe はプレビュー表示のみです。実際にキャンセルするには、確認ダイアログに対応したクライアントで同じ操作を行うか、bitbank
						アプリ/ウェブで該当注文をキャンセルしてください。
					</div>
				)}
			</div>
		</div>
	);
}
