// token を `structuredContent` に載せる UI 実行経路は採らない。`structuredContent` をモデルコンテキストへ入れるホストが実在する（ADR-0007）。
// SEP-1865 は iframe 起源の tools/call を識別できないので、`_meta` 経路ではトークン所持そのものが認可の実体になる（ADR-0007）。

import {
	type InputRequiredResult,
	inputRequired,
	inputResponse,
	type ServerContext,
} from '@modelcontextprotocol/server';
import { toStructured } from '../../lib/result.js';
import { CONFIRMATION_META_KEY, type ConfirmationMetaPayload } from '../mcp-apps-meta.js';
import { APP_RESOURCE_MIME_TYPE, MCP_APPS_UI_EXTENSION_ID } from '../resources/app-resources.js';
import type { Result } from '../schema/types.js';
import type { McpResponse, ToolHandlerExtra } from '../tool-definition.js';
import { isAppUiExecuteEnabled } from './config.js';
import { type ConfirmRequestState, consumeNonce, digestArgs, mintConfirmState } from './request-state.js';

const CONFIRM_KEY = 'confirm';

/** 拡張の宣言だけでなく `mimeTypes` に `APP_RESOURCE_MIME_TYPE` を要求する。描画できないホストにトークンを載せても確認カードは出ず、露出面が増えるだけ。 */
function declaresAppUi(caps: unknown): boolean {
	const ext = (caps as { extensions?: Record<string, unknown> } | undefined)?.extensions;
	const ui = ext?.[MCP_APPS_UI_EXTENSION_ID];
	if (!ui || typeof ui !== 'object') return false;
	const mimeTypes = (ui as { mimeTypes?: unknown }).mimeTypes;
	if (!Array.isArray(mimeTypes)) return false;
	return mimeTypes.includes(APP_RESOURCE_MIME_TYPE);
}

/** per-request envelope に clientCapabilities があればそれだけを見て、initialize 時の宣言へは落ちない（`clientSupportsElicitation` の OR と意図的に違う）。bearer token を渡す判定なので、宣言が食い違うときは狭い側に倒す。 */
export function clientSupportsAppUi(extra: ToolHandlerExtra | undefined): boolean {
	const envelope = (extra as { mcpReq?: { envelope?: { clientCapabilities?: unknown } } } | undefined)?.mcpReq
		?.envelope;
	if (envelope && 'clientCapabilities' in envelope && envelope.clientCapabilities != null) {
		return declaresAppUi(envelope.clientCapabilities);
	}
	const server = (extra as { server?: { getClientCapabilities?: () => unknown } } | undefined)?.server;
	const initCaps = typeof server?.getClientCapabilities === 'function' ? server.getClientCapabilities() : undefined;
	return declaresAppUi(initCaps);
}

/** preview 側のトークン配送と execute ハンドラの解錠で同じ述語を使う。片方だけ緩いと「載せないのに実行できる」「載せたのに実行できない」が生まれる。 */
export function isAppUiExecuteAllowed(extra: ToolHandlerExtra | undefined): boolean {
	return isAppUiExecuteEnabled() && clientSupportsAppUi(extra);
}

function isCapabilityObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function declaresFormElicitation(caps: unknown): boolean {
	const elicitation = (caps as { elicitation?: unknown } | undefined)?.elicitation;
	if (!isCapabilityObject(elicitation)) return false;
	// 空オブジェクト = 2025 系の宣言形。モードという概念が無かった世代なので form 対応とみなす。
	if (Object.keys(elicitation).length === 0) return true;
	// 空でない = 2026-07-28 系のモード宣言。form を宣言し、かつ値が仕様の形のときだけ true。
	return isCapabilityObject(elicitation.form);
}

export function clientSupportsElicitation(extra: ToolHandlerExtra | undefined): boolean {
	const server = (extra as { server?: { getClientCapabilities?: () => unknown } } | undefined)?.server;
	const initCaps = typeof server?.getClientCapabilities === 'function' ? server.getClientCapabilities() : undefined;
	if (declaresFormElicitation(initCaps)) return true;

	const envelope = (extra as { mcpReq?: { envelope?: { clientCapabilities?: unknown } } } | undefined)?.mcpReq
		?.envelope;
	return declaresFormElicitation(envelope?.clientCapabilities);
}

function readInputResponses(extra: ToolHandlerExtra | undefined): Record<string, unknown> | undefined {
	const responses = (extra as { mcpReq?: { inputResponses?: Record<string, unknown> } } | undefined)?.mcpReq
		?.inputResponses;
	return responses && typeof responses === 'object' ? responses : undefined;
}

function readConfirmState(extra: ToolHandlerExtra | undefined): ConfirmRequestState | undefined {
	const accessor = (extra as { mcpReq?: { requestState?: unknown } } | undefined)?.mcpReq?.requestState;
	if (typeof accessor !== 'function') return undefined;
	let value: unknown;
	try {
		value = (accessor as () => unknown)();
	} catch {
		return undefined;
	}
	if (!value || typeof value !== 'object') return undefined;
	const state = value as Partial<ConfirmRequestState>;
	if (typeof state.action !== 'string' || typeof state.argsDigest !== 'string' || typeof state.nonce !== 'string') {
		return undefined;
	}
	return state as ConfirmRequestState;
}

function stripConfirmationTokenFields(value: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...value };
	delete result.confirmation_token;
	delete result.expires_at;
	const data = result.data;
	if (data && typeof data === 'object' && !Array.isArray(data)) {
		const sanitizedData: Record<string, unknown> = { ...(data as Record<string, unknown>) };
		delete sanitizedData.confirmation_token;
		delete sanitizedData.expires_at;
		result.data = sanitizedData;
	}
	return result;
}

/** 「有効なトークンなら通る」とも「elicitation でのみ実行される」とも書かない。前者はプロンプトインジェクションへの手順書になり、後者はオプトイン時に事実に反する（ADR-0007）。 */
export const DIRECT_EXECUTE_FORBIDDEN_MESSAGE =
	'このツールは MCP tools/call から直接実行できません。発注・取消は preview_* 系ツールから始まるユーザー確認フローを経由してのみ実行されます。';

export const DIRECT_EXECUTE_FORBIDDEN_ERROR_TYPE = 'direct_execute_forbidden';

/** 原因を返すと攻撃者に requestState の当たり判定を与えるので、引数の差し替え・別 action への流用・replay・期限切れを同じ文言に畳む。 */
export const CONFIRM_STATE_INVALID_MESSAGE =
	'確認情報が無効なため実行しませんでした（引数の変更・再利用・期限切れの可能性）。preview からやり直してください。';

/** 容量超過では nonce を消費しておらず空きが出れば回復するので、恒久的な失敗と文言を分ける（同じ文言だと preview のやり直しを繰り返させる）。 */
export const CONFIRM_CAPACITY_EXCEEDED_MESSAGE =
	'確認処理が一時的に受け付けられないため実行しませんでした（確認待ちの記録が上限に達しています）。しばらく時間をおいてから preview をやり直してください。';

export interface WithElicitedConfirmationOptions {
	extra: ToolHandlerExtra | undefined;
	action: string;
	bindArgs: Record<string, unknown>;
	summary: string;
	confirmTitle: string;
	onConfirmed: () => Promise<Result>;
	onDeclinedText: string;
	declinedStructured: Record<string, unknown>;
	/** `structuredContent` の token は本ヘルパーが剥がすが、`content[0].text` は剥がさないので caller が token を含めないこと。 */
	fallback: McpResponse;
	metaConfirmation?: ConfirmationMetaPayload;
	/** 経路 2（確認カードのボタンで実行できる）と経路 3（このホストでは実行不可）で案内が正反対になるので、`fallback` とは別に持つ。トークンは含めないこと。 */
	appUiFallbackText?: string;
}

function withConfirmationMeta(fallback: McpResponse, opts: WithElicitedConfirmationOptions): McpResponse {
	if (!opts.metaConfirmation || !isAppUiExecuteAllowed(opts.extra)) return fallback;
	return {
		...fallback,
		...(opts.appUiFallbackText ? { content: [{ type: 'text', text: opts.appUiFallbackText }] } : {}),
		_meta: { ...fallback._meta, [CONFIRMATION_META_KEY]: opts.metaConfirmation },
	};
}

export async function withElicitedConfirmation(
	opts: WithElicitedConfirmationOptions,
): Promise<McpResponse | InputRequiredResult> {
	// fallback / declinedStructured は caller convention だけに頼らず、ここで必ず confirmation_token / expires_at を剥がす（多層防御の最終ガード）。
	const safeFallback: McpResponse = {
		...opts.fallback,
		structuredContent: stripConfirmationTokenFields(opts.fallback.structuredContent),
	};
	const safeDeclinedStructured = stripConfirmationTokenFields(opts.declinedStructured);

	const view = inputResponse(readInputResponses(opts.extra), CONFIRM_KEY);
	if (view.kind === 'elicit') {
		// 検証はユーザー応答の内容より先に行い、nonce は accept / decline を問わず消費する（拒否された確認の requestState を後から accept 付きで replay させない）。
		// action / argsDigest が一致しない再入では nonce を消費しない。消費すると他の pending 確認の nonce を第三者の再入で焼き潰せ、引数を変えるだけの再入で使用済み記録の容量も埋められる。
		const state = readConfirmState(opts.extra);
		const consumption =
			state !== undefined && state.action === opts.action && state.argsDigest === digestArgs(opts.action, opts.bindArgs)
				? consumeNonce(state.nonce)
				: undefined;
		if (consumption?.consumed !== true) {
			// 容量超過中は decline の nonce も記録できず TTL 内なら再提示され得るが、execute は通らず、生存 nonce を追い出すより安全なので許容する。
			const text =
				consumption?.reason === 'capacity_exceeded' ? CONFIRM_CAPACITY_EXCEEDED_MESSAGE : CONFIRM_STATE_INVALID_MESSAGE;
			return {
				content: [{ type: 'text', text }],
				structuredContent: safeDeclinedStructured,
			};
		}

		if (view.action !== 'accept' || view.content?.confirmed !== true) {
			return {
				content: [{ type: 'text', text: opts.onDeclinedText }],
				structuredContent: safeDeclinedStructured,
			};
		}

		const execResult = await opts.onConfirmed();
		const text = execResult.ok ? execResult.summary : `Error: ${execResult.summary}`;
		// onConfirmed の Result に confirmation_token は含まれない想定だが、念のため同じ最終ガードを通す。
		return {
			content: [{ type: 'text', text }],
			structuredContent: stripConfirmationTokenFields(toStructured(execResult)),
		};
	}

	if (!clientSupportsElicitation(opts.extra)) {
		// elicitation 非対応と確定したここでのみ `_meta` を付け、「elicitation を宣言したホストにはトークンを載せない」を条件式ではなく構造で保証する（下の mint 失敗 fallback には付かない）。
		return withConfirmationMeta(safeFallback, opts);
	}

	let requestState: string;
	try {
		// bind（method / sessionId / principal）のため、verify 時と同じ ServerContext を渡す。
		requestState = await mintConfirmState(opts.action, opts.bindArgs, (opts.extra ?? {}) as ServerContext);
	} catch {
		return safeFallback;
	}

	return inputRequired({
		inputRequests: {
			[CONFIRM_KEY]: inputRequired.elicit({
				message: opts.summary,
				requestedSchema: {
					type: 'object',
					properties: {
						confirmed: { type: 'boolean', title: opts.confirmTitle },
					},
					required: ['confirmed'],
				},
			}),
		},
		requestState,
	});
}
