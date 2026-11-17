// トークンは本文（contents[0].text）に載せる。ホストが結果 `_meta` を iframe に渡さなくなったため（ADR-0007 の 2026-11-11 追記）。
// 渡す条件は get_ui_snapshot の `_meta` とまったく同じにする。条件を満たさなければ、内容もトークンも返さない。

import { log } from '../../lib/logger.js';
import { appResourceUriFor, readConfirmationMeta } from '../mcp-apps-meta.js';
import { isAppUiExecuteEnabled } from '../private/config.js';
import { clientSupportsAppUi, clientSupportsElicitation, describeConfirmationGate } from '../private/elicitation.js';
import type { ToolHandlerExtra } from '../tool-definition.js';
import { getUiSnapshotWithMeta } from '../ui-snapshot-cache.js';
import { appResourceRegistry } from './app-resources.js';

export interface ConfirmationResourceResult {
	[key: string]: unknown;
	contents: Array<{ uri: string; mimeType: string; text: string }>;
}

type GateReason = 'unknown_app' | 'apps_execute_disabled' | 'no_app_ui' | 'elicitation';

// isAppUiExecuteAllowed（= オプトイン && UI 宣言）を分解しているだけなので、条件を足すときは get_ui_snapshot 側とそろえる。
function gateReason(appUri: string | undefined, extra: ToolHandlerExtra | undefined): GateReason | null {
	if (appUri == null || !appResourceRegistry.some((r) => r.uri === appUri)) return 'unknown_app';
	if (!isAppUiExecuteEnabled()) return 'apps_execute_disabled';
	if (!clientSupportsAppUi(extra)) return 'no_app_ui';
	if (clientSupportsElicitation(extra)) return 'elicitation';
	return null;
}

export function readConfirmationResource(
	uri: string,
	app: unknown,
	extra: ToolHandlerExtra | undefined,
): ConfirmationResourceResult {
	const appUri = typeof app === 'string' ? appResourceUriFor(app) : undefined;
	const sessionId = (extra as { sessionId?: string } | undefined)?.sessionId;
	const closed = gateReason(appUri, extra);
	const openUri = closed == null ? appUri : undefined;
	const found = openUri ? getUiSnapshotWithMeta(openUri, { sessionId }) : null;
	const structuredContent = found?.structuredContent ?? null;
	const confirmation = found ? readConfirmationMeta(found.meta) : undefined;
	// トークンそのものは記録しない。実機で「カードが読んだか・渡したか・渡さなかった理由」を確かめるための記録。
	log('info', {
		type: 'confirmation_resource_read',
		app: typeof app === 'string' ? app : null,
		delivered: !!confirmation,
		reason: closed ?? (!structuredContent ? 'no_snapshot' : !confirmation ? 'no_token' : null),
		gate: describeConfirmationGate(extra),
	});
	const body = confirmation ? { structuredContent, confirmation } : {};
	return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(body) }] };
}
