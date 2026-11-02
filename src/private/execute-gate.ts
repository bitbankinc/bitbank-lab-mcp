import { fail } from '../../lib/result.js';
import type { ToolHandlerExtra } from '../tool-definition.js';
import {
	DIRECT_EXECUTE_FORBIDDEN_ERROR_TYPE,
	DIRECT_EXECUTE_FORBIDDEN_MESSAGE,
	isAppUiExecuteAllowed,
} from './elicitation.js';

// preview_* の elicitation accept は実行関数を直接呼ぶので、ここを通らない。
export async function runAppUiExecute<A, R>(
	args: unknown,
	extra: ToolHandlerExtra | undefined,
	outputSchema: { parse(value: unknown): R },
	execute: (args: A, route: 'ui-button', scope: { sessionId?: string }) => Promise<R>,
): Promise<R> {
	if (!isAppUiExecuteAllowed(extra)) {
		return outputSchema.parse(fail(DIRECT_EXECUTE_FORBIDDEN_MESSAGE, DIRECT_EXECUTE_FORBIDDEN_ERROR_TYPE));
	}
	const tokenArgs = args as { confirmation_token?: unknown; token_expires_at?: unknown } | undefined;
	// トークン欠落は preview を経ていない直接呼び出しとして拒否し、値の正当性は実行関数内の validateToken に任せる。
	if (!tokenArgs?.confirmation_token || typeof tokenArgs.token_expires_at !== 'number') {
		return outputSchema.parse(fail(DIRECT_EXECUTE_FORBIDDEN_MESSAGE, DIRECT_EXECUTE_FORBIDDEN_ERROR_TYPE));
	}
	return execute(args as A, 'ui-button', {
		sessionId: (extra as { sessionId?: string } | undefined)?.sessionId,
	});
}
