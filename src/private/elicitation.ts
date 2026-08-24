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
 *   - token を `structuredContent` に載せる UI 実行経路（旧 trust-host モード）は
 *     採用しない。`structuredContent` をモデルコンテキストへ入れるホストが実在するため。
 *   - **MCP Apps ホスト向けの `_meta` 経路（2026-08-13 追加）**: elicitation 非対応かつ
 *     運用者がオプトインしたホストに限り、token をツール結果 `_meta` にのみ載せて
 *     iframe へ配送する（`isAppUiExecuteAllowed`）。SEP-1865 は iframe 起源の
 *     tools/call を識別できないため、**トークン所持そのものが認可の実体**になる。
 *     これは「ホストが `_meta` をモデルに渡さない」という観測された挙動への依存であり
 *     仕様上の保証ではないので、既定 off。詳細と計測値は ADR-0007。
 */

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

/** inputResponses の confirm 応答を引くためのキー */
const CONFIRM_KEY = 'confirm';

/**
 * 与えられた client capabilities が MCP Apps UI（SEP-1865）を、
 * **本サーバーの UI リソースを描画できる形で**宣言しているかを判定する。
 *
 * `extensions["io.modelcontextprotocol/ui"]` の存在だけでは不十分で、
 * `mimeTypes` に `APP_RESOURCE_MIME_TYPE` が含まれることまで要求する:
 *   - 仕様上 `mimeTypes` は REQUIRED（ext-apps `specification/2026-01-26/apps.mdx`）
 *   - 本サーバーの確認 UI は `APP_RESOURCE_MIME_TYPE` で配信している。描画できないホストに
 *     トークンを載せても確認カードが出ないため、意味が無く露出面が増えるだけ
 *
 * 欠落・空配列・該当型を含まない場合はすべて false（fail-closed）。
 */
function declaresAppUi(caps: unknown): boolean {
	const ext = (caps as { extensions?: Record<string, unknown> } | undefined)?.extensions;
	const ui = ext?.[MCP_APPS_UI_EXTENSION_ID];
	if (!ui || typeof ui !== 'object') return false;
	const mimeTypes = (ui as { mimeTypes?: unknown }).mimeTypes;
	if (!Array.isArray(mimeTypes)) return false;
	return mimeTypes.includes(APP_RESOURCE_MIME_TYPE);
}

/**
 * クライアントが MCP Apps UI を扱えるかを判定する（有効化ゲートの 2 段目）。
 *
 * **取得元の優先順位は `clientSupportsElicitation` と意図的に異なる。**
 *   - こちら: per-request envelope があればそれを**権威として採用**し、無い場合のみ
 *     `initialize` 時の宣言へフォールバックする
 *   - あちら: 両者の OR
 *
 * 理由: `clientSupportsElicitation` は「elicitation を試してよいか」の判定で、
 * 広めに倒しても SDK が capability 未宣言を検知して送信を塞ぐだけ。対してこちらは
 * 「bearer token を渡してよいか」の判定なので、宣言が食い違うときは狭い側に倒す。
 * 2026-07-28 系はリクエストごとの capability 提示が前提であり、envelope が
 * 「UI 非対応」と言っているのに initialize 時の宣言を根拠に載せるのは、より新しい
 * 宣言を無視することになる。
 */
export function clientSupportsAppUi(extra: ToolHandlerExtra | undefined): boolean {
	const envelope = (extra as { mcpReq?: { envelope?: { clientCapabilities?: unknown } } } | undefined)?.mcpReq
		?.envelope;
	// envelope に clientCapabilities が載っている場合はそれだけを見る（initialize へ落ちない）。
	if (envelope && 'clientCapabilities' in envelope && envelope.clientCapabilities != null) {
		return declaresAppUi(envelope.clientCapabilities);
	}
	const server = (extra as { server?: { getClientCapabilities?: () => unknown } } | undefined)?.server;
	const initCaps = typeof server?.getClientCapabilities === 'function' ? server.getClientCapabilities() : undefined;
	return declaresAppUi(initCaps);
}

/**
 * MCP Apps ホスト向けの `_meta` 経由 execute 経路が、この呼び出しで有効かを返す。
 *
 * 有効化ゲート 2 段の AND:
 *   1. 運用者の明示的オプトイン（`BITBANK_MCP_APPS_EXECUTE=1`。既定 off）
 *   2. クライアントが MCP Apps UI を MIME 型込みで宣言していること
 *
 * preview 側のトークン配送と execute ハンドラの解錠で**同じ述語**を使う。片方だけ緩いと
 * 「載せないのに実行できる」「載せたのに実行できない」がすぐ生まれるため、1 箇所に集約する。
 *
 * なお「elicitation 対応ホストにはトークンを載せない」という優先順位の不変条件は、
 * 本述語ではなく `withElicitedConfirmation` の**構造**で担保する（`_meta` を付けるのは
 * elicitation 非対応と判定した後の fallback 経路だけ）。詳細は ADR-0007。
 */
export function isAppUiExecuteAllowed(extra: ToolHandlerExtra | undefined): boolean {
	return isAppUiExecuteEnabled() && clientSupportsAppUi(extra);
}

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
 * 確認フローを経ない直接実行をサーバー側で拒否する。
 *
 * 文言の設計方針（ADR-0007「拒否メッセージの扱い」）:
 *
 * このメッセージは `content[0].text` に載る = **LLM が読む唯一のチャネル**。
 * オプトイン有効時は「有効な confirmation_token を伴う呼び出しなら通る」が事実だが、
 * **それをここに書かない**。認可の実体がトークン所持である以上、手順を明記することは
 * プロンプトインジェクションの誘導面を自ら広げる行為になる（LLM はトークンを入手できないので
 * 実害には直結しないが、攻撃者に手順書を渡す必要は無い）。
 *
 * 同じ理由で「elicitation/MRTR でのみ実行される」「トークンはクライアントに返らない」とも
 * 書かない。オプトイン有効時には**事実に反する**ため。述べるのは「直接実行は不可」と
 * 「正規の入口は preview_*」の 2 点に留め、実行手段の内訳はホスト構成依存なので断定しない。
 */
export const DIRECT_EXECUTE_FORBIDDEN_MESSAGE =
	'このツールは MCP tools/call から直接実行できません。発注・取消は preview_* 系ツールから始まるユーザー確認フローを経由してのみ実行されます。';

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
	/**
	 * MCP Apps ホスト向けに、ツール結果 `_meta` へ載せる確認トークン（任意）。
	 *
	 * 渡しても**必ず載るわけではない**。`isAppUiExecuteAllowed` が真で、かつ
	 * elicitation 非対応と判定した fallback 経路に入った場合にのみ載る。
	 * elicitation 対応ホストには一切載らない（優先順位の不変条件）。
	 *
	 * `content` / `structuredContent` には決して載らない（`stripConfirmationTokenFields` は
	 * 維持したまま、それとは別に `_meta` を組み立てる）。
	 */
	metaConfirmation?: ConfirmationMetaPayload;
	/**
	 * `metaConfirmation` が実際に `_meta` へ載ったときに `content[0].text` を差し替える文言。
	 *
	 * 経路 2（確認カードのボタンで実行できる）と経路 3（このホストでは実行不可）で
	 * ユーザーへの案内が正反対になるため、caller が両方の文言を用意する。
	 * 未指定なら `fallback` の文言をそのまま使う。**トークンは含めないこと。**
	 */
	appUiFallbackText?: string;
}

/**
 * elicitation 非対応ホスト向けの fallback レスポンスに、条件を満たす場合のみ
 * 確認トークンを `_meta` として付ける。
 *
 * 付ける条件（両方必要。`isAppUiExecuteAllowed`）:
 *   1. `BITBANK_MCP_APPS_EXECUTE=1`（運用者のオプトイン）
 *   2. クライアントが MCP Apps UI を MIME 型込みで宣言している
 *
 * 条件を満たさない場合は受け取った fallback をそのまま返す（既定の挙動 = 従来どおり
 * トークン非露出）。`content` / `structuredContent` には一切手を加えない。
 */
function withConfirmationMeta(fallback: McpResponse, opts: WithElicitedConfirmationOptions): McpResponse {
	if (!opts.metaConfirmation || !isAppUiExecuteAllowed(opts.extra)) return fallback;
	return {
		...fallback,
		...(opts.appUiFallbackText ? { content: [{ type: 'text', text: opts.appUiFallbackText }] } : {}),
		_meta: { ...fallback._meta, [CONFIRMATION_META_KEY]: opts.metaConfirmation },
	};
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
		// 経路 2 / 3 の分岐点。elicitation 非対応と確定したここでのみ `_meta` を付ける。
		// これにより「elicitation を宣言したホストにはトークンを載せない」が
		// 条件式ではなく**構造**で保証される（下の mint 失敗 fallback には付かない）。
		return withConfirmationMeta(safeFallback, opts);
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
