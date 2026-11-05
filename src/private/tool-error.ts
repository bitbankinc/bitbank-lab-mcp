// throw せず `fail(err.message)` を Result として返すと `server.ts` の `toPublicError` を経由せず内部 message が LLM / クライアントへ漏れるので、`PrivateApiError` 以外の message は汎用文に置き換える。

import { fail } from '../../lib/result.js';
import { getBitbankErrorMessage } from '../lib/bitbank-errors.js';
import { PrivateApiError } from './client.js';

export interface FailPrivateToolErrorOptions {
	remapBitbankCode?: boolean;
}

export function failPrivateToolError(
	err: unknown,
	fallbackMessage: string,
	opts: FailPrivateToolErrorOptions = {},
): ReturnType<typeof fail> {
	if (err instanceof PrivateApiError) {
		const message =
			opts.remapBitbankCode && err.bitbankCode != null
				? (getBitbankErrorMessage(err.bitbankCode) ?? err.message)
				: err.message;
		return fail(message, err.errorType);
	}
	return fail(fallbackMessage, 'upstream_error');
}
