import { createHmac } from 'node:crypto';
import { getPrivateApiConfig } from './config.js';

/** ミリ秒。最大 60000 まで設定可能 */
const DEFAULT_TIME_WINDOW = '5000';

export interface AuthHeaders {
	'ACCESS-KEY': string;
	'ACCESS-REQUEST-TIME': string;
	'ACCESS-TIME-WINDOW': string;
	'ACCESS-SIGNATURE': string;
}

/** path はクエリパラメータを含む。 */
export function buildGetMessage(requestTime: string, timeWindow: string, path: string): string {
	return requestTime + timeWindow + path;
}

export function buildPostMessage(requestTime: string, timeWindow: string, body: string): string {
	return requestTime + timeWindow + body;
}

export function sign(secret: string, message: string): string {
	return createHmac('sha256', secret).update(message).digest('hex');
}

export function createGetAuthHeaders(
	path: string,
	requestTime?: string,
	timeWindow: string = DEFAULT_TIME_WINDOW,
): AuthHeaders {
	const config = getPrivateApiConfig();
	if (!config) {
		throw new Error('BITBANK_API_KEY / BITBANK_API_SECRET が未設定です');
	}

	const rt = requestTime ?? Date.now().toString();
	const message = buildGetMessage(rt, timeWindow, path);
	const signature = sign(config.apiSecret, message);

	return {
		'ACCESS-KEY': config.apiKey,
		'ACCESS-REQUEST-TIME': rt,
		'ACCESS-TIME-WINDOW': timeWindow,
		'ACCESS-SIGNATURE': signature,
	};
}

export function createPostAuthHeaders(
	body: string,
	requestTime?: string,
	timeWindow: string = DEFAULT_TIME_WINDOW,
): AuthHeaders {
	const config = getPrivateApiConfig();
	if (!config) {
		throw new Error('BITBANK_API_KEY / BITBANK_API_SECRET が未設定です');
	}

	const rt = requestTime ?? Date.now().toString();
	const message = buildPostMessage(rt, timeWindow, body);
	const signature = sign(config.apiSecret, message);

	return {
		'ACCESS-KEY': config.apiKey,
		'ACCESS-REQUEST-TIME': rt,
		'ACCESS-TIME-WINDOW': timeWindow,
		'ACCESS-SIGNATURE': signature,
	};
}
