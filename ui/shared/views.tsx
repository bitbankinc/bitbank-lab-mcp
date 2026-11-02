import type { ReactNode } from 'react';
import type { SnapshotHydrationPhase } from '../../src/mcp-apps-hydration.js';
import type { ConnState, Status } from './confirm-app';

export function PendingView(props: {
	status: Status;
	message: string;
	connState: ConnState;
	hydrationPhase: SnapshotHydrationPhase;
	waitingText: string;
}) {
	const { status, message, connState, hydrationPhase, waitingText } = props;
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
	const text =
		connState === 'failed'
			? 'ホストとの MCP Apps 接続（ui/initialize）を確立できませんでした。このホストでは確認 UI を利用できません。プレビュー内容はチャット本文を参照してください。'
			: hydrationPhase === 'failed'
				? 'スナップショットから復元できませんでした。内容はチャット本文で確認できます。'
				: hydrationPhase === 'restoring'
					? 'ホストからツール結果（ui/notifications/tool-result）が届かないため、スナップショットからの復元を試みています。表示されない場合はプレビュー内容をチャット本文で確認してください。'
					: waitingText;
	return (
		<div className="app">
			<div className="card">
				<p className="muted">{text}</p>
			</div>
		</div>
	);
}

export function CardTitle(props: { icon: string; children: ReactNode }) {
	return (
		<h1 className="title">
			<span className="title-icon" aria-hidden="true">
				{props.icon}
			</span>
			{props.children}
		</h1>
	);
}

export function Row(props: { label: string; valueClassName?: string; children: ReactNode }) {
	return (
		<div className="row">
			<span className="row-label">{props.label}</span>
			<span className={props.valueClassName ? `row-value ${props.valueClassName}` : 'row-value'}>{props.children}</span>
		</div>
	);
}

export function StatusMessage(props: { status: Status; message: string; successExtra?: ReactNode }) {
	const { status, message, successExtra } = props;
	switch (status) {
		case 'success':
			return (
				<div className="status status-success" role="status" aria-live="polite" aria-atomic="true">
					✅ {message}
					{successExtra}
				</div>
			);
		case 'error':
			return (
				<div className="status status-error" role="alert" aria-live="assertive" aria-atomic="true">
					❌ {message}
				</div>
			);
		case 'cancelled':
			return (
				<div className="status status-cancelled" role="status" aria-live="polite" aria-atomic="true">
					{message}
				</div>
			);
		case 'expired':
			return (
				<div className="status status-error" role="alert" aria-live="assertive" aria-atomic="true">
					⏰ {message}
				</div>
			);
		default:
			return null;
	}
}

export function ConfirmActions(props: {
	status: Status;
	dismissLabel: string;
	confirmLabel: string;
	onDismiss: () => void;
	onConfirm: () => void;
}) {
	const submitting = props.status === 'submitting';
	return (
		<div className="actions">
			<button type="button" className="btn btn-secondary" onClick={props.onDismiss} disabled={submitting}>
				{props.dismissLabel}
			</button>
			<button type="button" className="btn btn-primary" onClick={props.onConfirm} disabled={submitting}>
				{submitting ? '送信中…' : props.confirmLabel}
			</button>
		</div>
	);
}
