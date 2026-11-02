import { fail, toStructured } from '../../lib/result.js';
import type { Result } from '../schema/types.js';
import type { ToolHandlerExtra } from '../tool-definition.js';
import { withElicitedConfirmation } from './elicitation.js';

export interface PreviewConfirmationTexts {
	confirmTitle: string;
	declinedText: string;
	/** 経路 3（このホストでは実行不可）の 2 行目。トークンの存在は仄めかさない。 */
	unsupportedHostGuide: string;
	/** 経路 2（確認カードのボタンで実行できる）の案内。トークンは含めない。 */
	appUiGuide: readonly [string, string];
}

type PreviewOk = { summary: string; data: { confirmation_token?: string; expires_at?: number } };

export async function confirmPreview<A extends object, F>(opts: {
	extra: ToolHandlerExtra | undefined;
	action: string;
	args: A;
	result: PreviewOk;
	outputSchema: { parse(value: unknown): F };
	texts: PreviewConfirmationTexts;
	execute: (
		args: A & { confirmation_token: string; token_expires_at: number },
		route: 'elicitation',
		scope: { sessionId?: string },
	) => Promise<Result>;
}) {
	const { extra, action, args, result, outputSchema, texts, execute } = opts;
	// スキーマ上 optional だが preview 成功時は必ず生成される。万一無ければ、トークン無しで execute 経路へ進ませないよう fail-closed にする。
	const { confirmation_token, expires_at } = result.data;
	if (!confirmation_token || expires_at == null) {
		return outputSchema.parse(fail('確認トークンを生成できませんでした', 'internal'));
	}

	const fallbackText = [
		result.summary,
		'',
		'※ このホストでは取引実行に対応していません。',
		texts.unsupportedHostGuide,
	].join('\n');
	const appUiFallbackText = [result.summary, '', ...texts.appUiGuide].join('\n');

	return withElicitedConfirmation({
		extra,
		action,
		bindArgs: args as unknown as Record<string, unknown>,
		summary: result.summary,
		confirmTitle: texts.confirmTitle,
		onConfirmed: () =>
			execute({ ...args, confirmation_token, token_expires_at: expires_at }, 'elicitation', {
				sessionId: (extra as { sessionId?: string } | undefined)?.sessionId,
			}),
		onDeclinedText: texts.declinedText,
		declinedStructured: toStructured(result),
		fallback: {
			content: [{ type: 'text', text: fallbackText }],
			structuredContent: toStructured(result),
		},
		metaConfirmation: {
			confirmation_token,
			expires_at,
		},
		appUiFallbackText,
	});
}
