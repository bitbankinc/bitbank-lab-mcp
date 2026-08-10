/**
 * preview 系ツール（preview_order / preview_cancel_order / preview_cancel_orders）の
 * ユーザー確認フローを共通化するヘルパー。
 *
 * MCP 2026-07-28 (SEP-2322 MRTR) スタイルで実装する:
 *   - round 1: クライアントが elicitation を扱えるなら `input_required` 結果
 *     （confirm 要求 + 署名付き requestState）を返す
 *   - round 2: クライアントが confirm 応答つきで元のツール呼び出しを再試行してきたら、
 *     requestState を検証（action / 引数 digest / one-time nonce）した上で
 *     accept なら execute を実行する
 *   - 2025 系クライアントには SDK の legacy shim（デフォルト有効）が round 1 の
 *     `input_required` を従来の `elicitation/create` push に自動変換し、応答を
 *     `inputResponses` に詰めてハンドラを再入させる。ハンドラは一度書けば両世代で動く
 *   - elicitation 非対応 / 検証失敗時は `fallback`（実行不可通知）を返す
 *
 * 取引系 HITL（Human-in-the-Loop）の中核であり、3 箇所に散らばっていると
 * 仕様ドリフトで事故になるため、本モジュールに集約する。
 *
 * 取引系に強く紐づくため汎用 `lib/` ではなく `src/private/` 配下に置く。
 *
 * セキュリティ設計（重要）:
 *   - `confirmation_token` / `expires_at` は本ヘルパー経路のサーバープロセス内に閉じる。
 *     呼び出し側が誤って `fallback` / `declinedStructured` に token を含めても、
 *     `withElicitedConfirmation` 内の `stripConfirmationTokenFields` で必ず除去される
 *     （多層防御。caller convention だけに依存しない最終ガード）。
 *   - `requestState` は署名のみで暗号化されない（クライアント / LLM から可視）ため、
 *     token を含めない。nonce + 引数 digest のみを載せ、再入時に検証する。
 *     加えて SDK codec の `bind` で呼び出し元セッション／認証 principal と
 *     元の MCP method に束縛する（越境再利用を fail-closed で拒否）。
 *     詳細は src/private/request-state.ts と ADR-0007 を参照。
 *   - 「`structuredContent` は LLM 非可視」をホストの仕様保証として扱わない。
 *     SEP-1624 / 各ホスト挙動の詳細は docs/private-api.md「content /
 *     structuredContent / `_meta` の役割と HITL の境界」節を参照。
 *   - SEP-1865 iframe 起源の tools/call をサーバー側で識別できないため、
 *     token を structuredContent に載せる UI 実行経路（旧 trust-host モード）は
 *     採用しない。execute は elicitation / MRTR の accept のみ。
 */

import {
	type InputRequiredResult,
	inputRequired,
	inputResponse,
	type ServerContext,
} from '@modelcontextprotocol/server';
import { toStructured } from '../../lib/result.js';
import type { Result } from '../schema/types.js';
import type { McpResponse, ToolHandlerExtra } from '../tool-definition.js';
import { type ConfirmRequestState, consumeNonce, digestArgs, mintConfirmState } from './request-state.js';

/** inputResponses の confirm 応答を引くためのキー */
const CONFIRM_KEY = 'confirm';

/**
 * クライアントが elicitation を扱えるかを判定する。
 *
 * - 2025 系接続: initialize 時の client capabilities（server.getClientCapabilities()）
 * - 2026-07-28 系リクエスト: per-request の `_meta` envelope に載る clientCapabilities
 *
 * どちらにも `elicitation` が無いホストでは取引実行を行わず、呼び出し側が用意した
 * `fallback`（実行不可通知レスポンス）を返す。
 */
export function clientSupportsElicitation(extra: ToolHandlerExtra | undefined): boolean {
	const server = (extra as { server?: { getClientCapabilities?: () => unknown } } | undefined)?.server;
	const initCaps = typeof server?.getClientCapabilities === 'function' ? server.getClientCapabilities() : undefined;
	if ((initCaps as { elicitation?: unknown } | undefined)?.elicitation) return true;

	const envelope = (extra as { mcpReq?: { envelope?: { clientCapabilities?: unknown } } } | undefined)?.mcpReq
		?.envelope;
	const envCaps = envelope?.clientCapabilities;
	return Boolean((envCaps as { elicitation?: unknown } | undefined)?.elicitation);
}

/** 再入リクエストの inputResponses を ctx から取り出す。 */
function readInputResponses(extra: ToolHandlerExtra | undefined): Record<string, unknown> | undefined {
	const responses = (extra as { mcpReq?: { inputResponses?: Record<string, unknown> } } | undefined)?.mcpReq
		?.inputResponses;
	return responses && typeof responses === 'object' ? responses : undefined;
}

/**
 * verify フック（server.ts の ServerOptions.requestState.verify）が復号した
 * requestState payload を ctx から読み取る。形状が想定と異なる場合は undefined。
 */
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

/**
 * structuredContent / declinedStructured から `confirmation_token` / `expires_at` を
 * 除去する。`withElicitedConfirmation` の最終ガードとして使用し、caller が誤って
 * これらのフィールドを含めて渡しても外部に漏れないことを保証する。
 *
 * preview ツールの structuredContent は `{ ok, summary, data: { confirmation_token,
 * expires_at, preview, ... }, meta }` の Result 形式をとるため、最上位と `data`
 * 配下の 2 階層を剥がす。深いネストに `confirmation_token` を埋める caller は想定して
 * いないが、最上位も対象にしておくことで形状違いの caller 追加にも耐える。
 */
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

/**
 * `create_order` / `cancel_order` / `cancel_orders` の MCP tools/call ハンドラが返す拒否メッセージ。
 * LLM / UI からの直接実行をサーバー側で拒否し、elicitation/MRTR 経路のみ許可する。
 */
export const DIRECT_EXECUTE_FORBIDDEN_MESSAGE =
	'このツールは MCP tools/call（LLM / UI）からは実行できません。preview_* 経由の elicitation/MRTR 確認でのみ実行されます。';

/** MCP tools/call 経由の直接実行を拒否するときの errorType */
export const DIRECT_EXECUTE_FORBIDDEN_ERROR_TYPE = 'direct_execute_forbidden';

/**
 * round 2 の requestState 検証に失敗したときの案内文（恒久的な失敗）。
 * 引数の差し替え・別 action への流用・nonce の replay・期限切れをまとめてこの文言にする
 * （どれが原因かを返すと、攻撃者に requestState の当たり判定を与えてしまう）。
 */
export const CONFIRM_STATE_INVALID_MESSAGE =
	'確認情報が無効なため実行しませんでした（引数の変更・再利用・期限切れの可能性）。preview からやり直してください。';

/**
 * 使用済み nonce の記録が件数上限に達していて確認を通せなかったときの案内文（一時的な失敗）。
 *
 * 上の恒久的な失敗と文言を分ける理由: 容量超過は引数の変更でも期限切れでもないため、同じ文言に
 * 畳むと「preview からやり直す」→ また同じ失敗、をユーザーが繰り返すことになる。実際には
 * nonce は消費されておらず（生存エントリは追い出さない）、期限切れ記録が purge されて空きが
 * 出れば回復するので、待って再試行するよう案内する。
 */
export const CONFIRM_CAPACITY_EXCEEDED_MESSAGE =
	'確認処理が一時的に受け付けられないため実行しませんでした（確認待ちの記録が上限に達しています）。しばらく時間をおいてから preview をやり直してください。';

export interface WithElicitedConfirmationOptions {
	/** ハンドラに渡される MCP リクエストコンテキスト */
	extra: ToolHandlerExtra | undefined;
	/**
	 * 確認対象の操作種別（'create_order' | 'cancel_order' | 'cancel_orders'）。
	 * requestState のドメイン分離に使い、別操作への accept 流用を拒否する。
	 */
	action: string;
	/**
	 * 元リクエストの引数。requestState の引数 digest にバインドし、round 2 で
	 * 引数を差し替えた再試行（ユーザーが見ていないプレビュー内容の実行）を拒否する。
	 */
	bindArgs: Record<string, unknown>;
	/** elicitation の message に渡す preview 結果サマリ */
	summary: string;
	/** elicitation スキーマの confirmed フィールドに付ける title（例: 'この注文を発注する'） */
	confirmTitle: string;
	/**
	 * accept + confirmed=true のとき呼ぶ execute 本体。
	 * `Result`（create_order / cancel_order / cancel_orders の戻り値）を返す。
	 * **例外が出た場合は捕捉せずそのまま伝播させる**（呼び出し側で扱う）。
	 */
	onConfirmed: () => Promise<Result>;
	/** decline / cancel / confirmed=false のときに content[0].text として返す案内文 */
	onDeclinedText: string;
	/**
	 * decline / cancel / confirmed=false のときに structuredContent として返すオブジェクト。
	 * preview の Result を `toStructured()` で変換したものを渡してよい。
	 * `confirmation_token` / `expires_at` は本ヘルパー内で必ず除去されるため caller 側で
	 * 取り除く必要はないが、防御的に最小限のフィールドだけ含めることを推奨する。
	 */
	declinedStructured: Record<string, unknown>;
	/**
	 * elicitation 非対応ホスト向けの「実行不可通知」レスポンス。以下のケースで返る:
	 *   - クライアントが elicitation 非対応（2025 系 capabilities / 2026 系 envelope とも無し）
	 *   - requestState の mint に失敗した
	 *
	 * セマンティクス: 取引実行は行わずプレビュー内容のみ返し、対応ホストで実行するよう
	 * ユーザー / LLM に促す。`structuredContent` 内の `confirmation_token` / `expires_at`
	 * は本ヘルパー内で必ず除去される（caller convention だけに依存しない最終ガード）。
	 * `content[0].text` 側は caller の責任で token を含めないこと。
	 */
	fallback: McpResponse;
}

/**
 * preview 結果に対するユーザー確認（MRTR / elicitation）フローを実行する高レベルラッパー。
 *
 * 責務:
 *   1. round 判定（inputResponses の confirm 応答の有無）
 *   2. round 1: capability 判定 → `input_required` 結果の生成（requestState mint 込み）
 *   3. round 2: requestState 検証（action / 引数 digest / one-time nonce）と
 *      ユーザー応答（accept / decline / cancel / confirmed=false）による分岐返却
 *
 * 実 API 呼び出し（create_order / cancel_order / cancel_orders）は呼び出し側が
 * `onConfirmed` 内で行う。bitbank のキャンセル系は単数/複数で execute シグネチャが
 * 異なるため、ラッパーはシグネチャを縛らずクロージャに委ねる。
 *
 * 挙動の統一:
 *   - decline / cancel / accept-without-confirmed はすべて「ユーザー拒否」として
 *     同一処理にする。
 *   - `onConfirmed` の例外は捕捉せず呼び出し側に伝播させる。
 */
export async function withElicitedConfirmation(
	opts: WithElicitedConfirmationOptions,
): Promise<McpResponse | InputRequiredResult> {
	// fallback / declinedStructured は caller convention だけに依頼せず、ここで必ず
	// confirmation_token / expires_at を剥がす（多層防御の最終ガード）。
	const safeFallback: McpResponse = {
		...opts.fallback,
		structuredContent: stripConfirmationTokenFields(opts.fallback.structuredContent),
	};
	const safeDeclinedStructured = stripConfirmationTokenFields(opts.declinedStructured);

	// ── round 2: confirm 応答つき再入 ──
	const view = inputResponse(readInputResponses(opts.extra), CONFIRM_KEY);
	if (view.kind === 'elicit') {
		// requestState（verify フックで HMAC / 期限検証済み）の文脈バインドを検証する。
		// 検証はユーザー応答の内容より先に行い、nonce は accept / decline を問わず消費する
		// （拒否された確認の requestState を後から accept 付きで replay させない）。
		//
		// 短絡は意図的に維持する: action / argsDigest が一致しない再入では consumeNonce を
		// 呼ばない（= nonce を消費しない）。「accept / decline を問わず消費する」は
		// **この確認に対する応答**が対象であって、別文脈の requestState を投げ込まれたときまで
		// 消費する意図ではない。ここで消費すると (1) 他の pending 確認の nonce を第三者の再入で
		// 焼き潰せてしまい、(2) 引数を変えるだけの再入で使用済み記録の容量を埋められる。
		// どちらも拒否は変わらないので、消費しない方が安全側。
		const state = readConfirmState(opts.extra);
		const consumption =
			state !== undefined && state.action === opts.action && state.argsDigest === digestArgs(opts.action, opts.bindArgs)
				? consumeNonce(state.nonce)
				: undefined;
		if (consumption?.consumed !== true) {
			// fail-closed: 消費できなかった理由を問わず execute しない。文言だけは
			// 一時的な失敗（容量超過）と恒久的な失敗（引数変更・replay・期限切れ）で分ける。
			// どちらの経路でも nonce 本文はメッセージに含めない。
			//
			// 容量超過の残存リスク（許容する）: 上限に達している間は decline でも nonce を記録できず、
			// その requestState は TTL 内なら再提示され得る（accept 付き replay を「拒否済みだから」では
			// 弾けない）。空きが無い限り execute は一切通らないので実行そのものは起きず、記録できる
			// ようになった時点で通常どおり one-time-use に戻る。記録のために生存 nonce を追い出す方が
			// 危険（確定した replay を通す）なので、こちらを選ぶ。
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
		// onConfirmed の Result（create_order 等の戻り値）には confirmation_token は含まれない
		// 想定だが、念のため同じ最終ガードを通す。
		return {
			content: [{ type: 'text', text }],
			structuredContent: stripConfirmationTokenFields(toStructured(execResult)),
		};
	}

	// ── round 1: 確認要求の発行 ──
	if (!clientSupportsElicitation(opts.extra)) {
		return safeFallback;
	}

	let requestState: string;
	try {
		// bind（method / sessionId / principal）のため、verify 時と同じ ServerContext を渡す。
		// stdio では sessionId / principal が空でも mint↔verify で一致し既存挙動を維持する。
		requestState = await mintConfirmState(opts.action, opts.bindArgs, (opts.extra ?? {}) as ServerContext);
	} catch {
		// mint が想定外に失敗した場合はフォールバックに進む（実行不可通知）。
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
