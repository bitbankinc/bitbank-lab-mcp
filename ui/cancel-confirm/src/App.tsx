import { useState } from 'react';
import { type ConfirmationMetaPayload, readConfirmationMeta } from '../../../src/mcp-apps-meta.js';
import { executeConfirmed, type Status, TERMINAL_STATUSES, useConfirmApp } from '../../shared/confirm-app';
import { formatAmount, formatPair, formatPrice, sideLabel, typeLabel } from '../../shared/format';
import { CardTitle, ConfirmActions, PendingView, Row, StatusMessage } from '../../shared/views';

/** cancel_order(s) 呼び出しの timeout（ms）。サーバー側のツール timeout 60s より少し短く設定 */
const CANCEL_TIMEOUT_MS = 45_000;
/** この UI が対応する MCP Apps リソース URI（get_ui_snapshot の取得キー） */
const RESOURCE_URI = 'ui://cancel/confirm.html';

type Action = 'cancel_order' | 'cancel_orders';

interface SinglePreview {
	pair: string;
	order_id: number;
}

interface BulkPreview {
	pair: string;
	order_ids: number[];
}

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

interface PreviewResult {
	ok: boolean;
	summary?: string;
	data?: { preview: SinglePreview | BulkPreview; order?: OrderDetail };
	meta?: { action?: Action };
}

function isBulkPreview(p: SinglePreview | BulkPreview): p is BulkPreview {
	return Array.isArray((p as BulkPreview).order_ids);
}

function OrderDetailRows(props: { order: OrderDetail; isJpy: boolean }) {
	const { order, isJpy } = props;
	const side = sideLabel(order.side);
	return (
		<>
			<Row label="売買方向" valueClassName={side.className}>
				{side.text}
			</Row>
			<Row label="注文タイプ">{typeLabel(order.type)}</Row>
			<Row label="数量">
				{formatAmount(order.start_amount ?? order.executed_amount)}
				{order.remaining_amount && order.remaining_amount !== order.start_amount && (
					<>（残: {formatAmount(order.remaining_amount)}）</>
				)}
			</Row>
			<Row label="価格">{order.type === 'market' ? '成行' : formatPrice(order.price, isJpy)}</Row>
			{order.trigger_price && <Row label="トリガー価格">{formatPrice(order.trigger_price, isJpy)}</Row>}
			{order.average_price && order.average_price !== '0' && (
				<Row label="平均約定価格">{formatPrice(order.average_price, isJpy)}</Row>
			)}
			<Row label="ステータス">{order.status}</Row>
		</>
	);
}

export function App() {
	const [action, setAction] = useState<Action | null>(null);
	const [preview, setPreview] = useState<SinglePreview | BulkPreview | null>(null);
	const [order, setOrder] = useState<OrderDetail | null>(null);
	// MCP Apps 実行経路が有効なときだけ `_meta` から入る。null ならボタンを描画しない。
	const [confirmation, setConfirmation] = useState<ConfirmationMetaPayload | null>(null);
	const [status, setStatus] = useState<Status>('idle');
	const [message, setMessage] = useState<string>('');

	// preview_cancel_order(s) の結果だけ取り込む。meta.action と preview の有無でフィルタする。
	const { appRef, connState, hydrationPhase } = useConfirmApp(
		'bitbank-cancel-confirm',
		RESOURCE_URI,
		(s, meta, hasPreview) => {
			const structured = s as PreviewResult | undefined;
			const metaAction = structured?.meta?.action;
			if (
				structured?.ok &&
				structured.data?.preview &&
				(metaAction === 'cancel_order' || metaAction === 'cancel_orders')
			) {
				setAction(metaAction);
				setPreview(structured.data.preview);
				setOrder(structured.data.order ?? null);
				setConfirmation(readConfirmationMeta(meta) ?? null);
				setStatus('idle');
				setMessage('');
				return true;
			}
			if (structured?.ok === false && !hasPreview) {
				setStatus('error');
				setMessage(structured.summary ?? 'キャンセルプレビューに失敗しました。');
			}
			return false;
		},
	);

	if (!preview || !action) {
		return (
			<PendingView
				status={status}
				message={message}
				connState={connState}
				hydrationPhase={hydrationPhase}
				waitingText="preview_cancel_order(s) の結果を待機中…"
			/>
		);
	}

	const isBulk = isBulkPreview(preview);
	const isTerminal = TERMINAL_STATUSES.has(status);

	const handleConfirm = async () => {
		if (!confirmation) return;
		// preview と同じパラメータで呼ぶ。1 つでも違うとサーバー側の HMAC 検証が token_invalid で落ちる（ユーザーが見ていない対象を取り消させないための束縛）。
		const args: Record<string, unknown> = isBulk
			? { pair: preview.pair, order_ids: (preview as BulkPreview).order_ids }
			: { pair: preview.pair, order_id: (preview as SinglePreview).order_id };
		args.confirmation_token = confirmation.confirmation_token;
		args.token_expires_at = confirmation.expires_at;

		const outcome = await executeConfirmed({
			app: appRef.current,
			expiresAt: confirmation.expires_at,
			call: { name: action, arguments: args },
			timeoutMs: CANCEL_TIMEOUT_MS,
			texts: {
				expired: '確認の有効期限が切れました。もう一度プレビューを実行してください。',
				failed: 'キャンセルに失敗しました',
				succeeded: 'キャンセルを受け付けました',
				unexpected: 'キャンセル中に予期しないエラーが発生しました',
			},
			onSubmitting: () => {
				setStatus('submitting');
				setMessage('');
			},
		});
		setStatus(outcome.status);
		setMessage(outcome.message);
	};

	const handleDismiss = () => {
		setStatus('cancelled');
		setMessage('この操作は取り消されました（注文はそのまま残っています）。');
	};

	return (
		<div className="app">
			<div className="card">
				<CardTitle icon="🗑️">{isBulk ? '一括キャンセル確認' : 'キャンセル確認'}</CardTitle>

				<Row label="通貨ペア">{formatPair(preview.pair)}</Row>

				{isBulk ? (
					<>
						<Row label="対象件数">{(preview as BulkPreview).order_ids.length}件</Row>
						<Row label="注文ID">{(preview as BulkPreview).order_ids.join(', ')}</Row>
					</>
				) : (
					<>
						<Row label="注文ID">{(preview as SinglePreview).order_id}</Row>
						{order && <OrderDetailRows order={order} isJpy={preview.pair.includes('jpy')} />}
					</>
				)}

				<div className="warn">⚠️ キャンセルした注文は元に戻せません。</div>

				<StatusMessage status={status} message={message} />

				{!isTerminal && confirmation != null && (
					<ConfirmActions
						status={status}
						dismissLabel="やめる"
						confirmLabel={isBulk ? '一括キャンセルを確定する' : 'キャンセルを確定する'}
						onDismiss={handleDismiss}
						onConfirm={handleConfirm}
					/>
				)}

				{!isTerminal && confirmation == null && (
					<div className="warn">
						この iframe
						はプレビュー表示のみです。実際にキャンセルするには、確認ダイアログに対応したクライアントで同じ操作を行うか、bitbank
						アプリ/ウェブで該当注文をキャンセルしてください。
					</div>
				)}
			</div>
		</div>
	);
}
