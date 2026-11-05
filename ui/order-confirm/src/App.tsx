import { useMemo, useState } from 'react';
import { type ConfirmationMetaPayload, readConfirmationMeta } from '../../../src/mcp-apps-meta.js';
import { executeConfirmed, type Status, TERMINAL_STATUSES, useConfirmApp } from '../../shared/confirm-app';
import { formatAmount, formatPair, formatPrice, formatQuote, sideLabel, typeLabel } from '../../shared/format';
import { CardTitle, ConfirmActions, PendingView, Row, StatusMessage } from '../../shared/views';

type Side = 'buy' | 'sell';
type OrderType = 'limit' | 'market' | 'stop' | 'stop_limit';
type PositionSide = 'long' | 'short';

/** create_order 呼び出しの timeout（ms）。サーバー側のツール timeout 60s より少し短く設定 */
const CREATE_ORDER_TIMEOUT_MS = 45_000;
/** この UI が対応する MCP Apps リソース URI（get_ui_snapshot の取得キー） */
const RESOURCE_URI = 'ui://order/confirm.html';

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

interface PreviewResult {
	ok: boolean;
	summary?: string;
	data?: { preview: PreviewArgs };
	meta?: { action?: string };
}

function estimateTotal(preview: PreviewArgs): string | null {
	if (!preview.price) return null;
	const p = Number(preview.price);
	const a = Number(preview.amount);
	if (!Number.isFinite(p) || !Number.isFinite(a)) return null;
	return formatQuote(p * a, preview.pair.includes('jpy'));
}

export function App() {
	const [preview, setPreview] = useState<PreviewArgs | null>(null);
	// MCP Apps 実行経路が有効なときだけ `_meta` から入る。null ならボタンを描画しない。
	const [confirmation, setConfirmation] = useState<ConfirmationMetaPayload | null>(null);
	const [status, setStatus] = useState<Status>('idle');
	const [message, setMessage] = useState<string>('');
	const [orderId, setOrderId] = useState<number | null>(null);

	// 他ツールの結果で state をリセットしないよう、`ok` かつ `data.preview` を持つ結果だけを取り込む（ツール名は見ていない）。
	const { appRef, connState, hydrationPhase } = useConfirmApp(
		'bitbank-order-confirm',
		RESOURCE_URI,
		(s, meta, hasPreview) => {
			const structured = s as PreviewResult | undefined;
			if (structured?.ok && structured.data?.preview) {
				setPreview(structured.data.preview);
				setConfirmation(readConfirmationMeta(meta) ?? null);
				setStatus('idle');
				setMessage('');
				return true;
			}
			if (structured?.ok === false && !hasPreview) {
				setStatus('error');
				setMessage(structured.summary ?? '注文プレビューに失敗しました。');
			}
			return false;
		},
	);

	const isJpy = useMemo(() => (preview ? preview.pair.includes('jpy') : false), [preview]);

	const handleConfirm = async () => {
		if (!preview || !confirmation) return;
		const args: Record<string, unknown> = {
			pair: preview.pair,
			amount: preview.amount,
			side: preview.side,
			type: preview.type,
			confirmation_token: confirmation.confirmation_token,
			token_expires_at: confirmation.expires_at,
		};
		// preview と同じパラメータで呼ぶ。1 つでも違うとサーバー側の HMAC 検証が token_invalid で落ちる（ユーザーが見ていない内容を発注させないための束縛）。
		if (preview.price) args.price = preview.price;
		if (preview.trigger_price) args.trigger_price = preview.trigger_price;
		if (preview.post_only != null) args.post_only = preview.post_only;
		if (preview.position_side) args.position_side = preview.position_side;

		const outcome = await executeConfirmed({
			app: appRef.current,
			expiresAt: confirmation.expires_at,
			call: { name: 'create_order', arguments: args },
			timeoutMs: CREATE_ORDER_TIMEOUT_MS,
			texts: {
				expired: '確認の有効期限が切れました。もう一度 preview_order を実行してください。',
				failed: '注文に失敗しました',
				succeeded: '注文を受け付けました',
				unexpected: '注文中に予期しないエラーが発生しました',
			},
			onSubmitting: () => {
				setStatus('submitting');
				setMessage('');
			},
		});
		setStatus(outcome.status);
		setMessage(outcome.message);
		if (outcome.status === 'success') {
			const structured = outcome.structured as { data?: { order?: { order_id?: number } } } | undefined;
			setOrderId(structured?.data?.order?.order_id ?? null);
		}
	};

	const handleCancel = () => {
		setStatus('cancelled');
		setMessage('この注文はキャンセルされました。');
	};

	if (!preview) {
		return (
			<PendingView
				status={status}
				message={message}
				connState={connState}
				hydrationPhase={hydrationPhase}
				waitingText="preview_order の結果を待機中…"
			/>
		);
	}

	const side = sideLabel(preview.side, preview.position_side);
	const total = estimateTotal(preview);
	const isTerminal = TERMINAL_STATUSES.has(status);

	return (
		<div className="app">
			<div className="card">
				<CardTitle icon="📋">注文確認</CardTitle>

				<Row label="通貨ペア">{formatPair(preview.pair)}</Row>
				<Row label="売買方向" valueClassName={side.className}>
					{side.text}
				</Row>
				<Row label="注文タイプ">{typeLabel(preview.type)}</Row>
				<Row label="数量">{formatAmount(preview.amount)}</Row>
				<Row label="価格">{preview.type === 'market' ? '成行' : formatPrice(preview.price, isJpy)}</Row>
				{preview.trigger_price && <Row label="トリガー価格">{formatPrice(preview.trigger_price, isJpy)}</Row>}
				{total && <Row label="合計概算">{total}</Row>}
				{preview.post_only && <Row label="Post Only">有効</Row>}

				{preview.position_side && <div className="warn">⚠️ 信用取引です。損失が保証金を超える可能性があります。</div>}

				<StatusMessage
					status={status}
					message={message}
					successExtra={
						orderId != null && (
							<>
								<br />
								注文ID: {orderId}
							</>
						)
					}
				/>

				{!isTerminal && confirmation != null && (
					<ConfirmActions
						status={status}
						dismissLabel="キャンセル"
						confirmLabel="注文を確定する"
						onDismiss={handleCancel}
						onConfirm={handleConfirm}
					/>
				)}

				{!isTerminal && confirmation == null && (
					<div className="warn">
						この iframe
						はプレビュー表示のみです。実際の発注は、確認ダイアログに対応したクライアントで同じ操作を行うか、bitbank
						アプリ/ウェブで同じ内容を手動発注してください。
					</div>
				)}
			</div>
		</div>
	);
}
