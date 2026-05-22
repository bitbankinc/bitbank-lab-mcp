import { DISCLAIMER_MARKET, VISUALIZER_MODE_ARG, VISUALIZER_OUTPUT_BLOCK } from './shared.js';
import { PromptCategory, type PromptDef, PromptLevel } from './types.js';

function userMessage(text: string) {
	return [{ role: 'user' as const, content: [{ type: 'text', text }] }];
}

const OHAYO_TEXT = `直近の BTC/JPY の動きを視覚化してください。

各セクションにデータの取得時刻・カバー期間を明示（ツールレスポンスの時刻・実レンジをそのまま。推測・「直近8時間」等のハードコード禁止）。

${VISUALIZER_OUTPUT_BLOCK}

【ツール（この7つのみ。追加呼び出し禁止）】
1. get_ticker(pair="btc_jpy")
2. get_candles(pair="btc_jpy", type="1hour", limit=24) — 進行中足は isoTimeLocal+足種で判断。volume だけでは判定しない
3. get_flow_metrics(pair="btc_jpy", hours=8, bucketMs=60000, view="summary") — 警告・カバー率をそのまま表示
4. analyze_support_resistance(pair="btc_jpy", lookbackDays=90, topN=3)
5. get_orderbook(pair="btc_jpy", mode=pressure, bandsPct=[0.005, 0.01, 0.02])
6. analyze_mtf_sma(pair="btc_jpy") — analyze_sma_snapshot の個別呼び出し不要
7. analyze_ichimoku_snapshot(pair="btc_jpy", type="1day")

価格スパークライン: get_candles 直近8本の close からインライン SVG（render_chart_svg 不要）

【セクション】
1. ヘッダー（タイトル・get_ticker の取得時刻）
2. 価格サマリー（レンジ・変動率・高安・スパークライン）
3. イベントタイムライン（急変動 or なし）
4. 出来高 + 売買比率（縦積みカード。flow の警告・実レンジ・カバー率を表示）
5. 重要ライン（縦型: レジ→現在→サポ）
6. 板状況（スナップショット時刻・±1%圧力）
7. MTFトレンド（1h/4h/日足 + 日足一目、confluence 表示）
8. ポイント（1-2行）
9. 免責

${DISCLAIMER_MARKET}`;

const PORTFOLIO_TEXT = `私の bitbank 口座の資産状況を視覚化してください。

${VISUALIZER_OUTPUT_BLOCK}

【ツール（1つのみ）】
analyze_my_portfolio(include_pnl=true, include_technical=true, include_deposit_withdrawal=true)

【データ】ツール content テキストのみ参照（structuredContent は見えない）。末尾 JSON の data を使う:
- グラフ: **monthly_equity_series**（月次タブ・日次全点）/ **yearly_equity_series**（年次タブ・月次全点）
- 月初比/年初比の2点（monthly_performance / yearly_performance の start→current）だけで折れ線を描かない
- 現在の資産残高（total_jpy_value）、holdings_performance、technical
- トップに含み損・account_return・全履歴実現損益は出さない

【資産推移グラフ（重要）】
visualizer は「月次推移」「年次推移」2タブ。**同じ図の使い回し禁止。** JSON 配列をタブごとに別チャートへ全点プロット。

| タブ | 配列（content JSON） | 増減表示 | X軸 |
| 月次推移 | monthly_equity_series[] | monthly_performance.change_jpy / change_pct | 月初→現在 |
| 年次推移 | yearly_equity_series[] | yearly_performance.change_jpy / change_pct | 年初→現在 |

【セクション】
1. ヘッダー（取得時刻・入出金分析バッジ）
2. 現在の資産残高（大きく + JPY残高 + 前日比）
3. 資産推移グラフ（上記ルール）
4. 保有銘柄のパフォーマンス（月次・年次騰落率）
5. 資産構成比率（横棒、銘柄色分け）
6. テクニカル（technical がある場合のみ）
7. 入出金サマリー（available 時: 年次・月次2カード）
8. 注意書き（指標定義・税務免責: 所得税計算に使えない）

${DISCLAIMER_MARKET}
⚠️ 本レポートの数値は所得税計算に使用できません。`;

export const reportPrompts: PromptDef[] = [
	{
		name: '🌅 おはようレポート',
		description: '直近の BTC/JPY の動きを視覚化。Visualizer（デフォルト）または HTML ファイルで出力。',
		arguments: [VISUALIZER_MODE_ARG],
		messages: userMessage(OHAYO_TEXT),
		metadata: {
			level: PromptLevel.INTERMEDIATE,
			category: PromptCategory.ANALYSIS,
			estimatedTime: '30秒',
			tags: ['intermediate', 'btc', 'overnight', 'visual', 'visualizer', 'html'],
		},
	},
	{
		name: '💼 ポートフォリオ分析レポート',
		description:
			'口座の保有資産・月初比/年初比の資産増減・構成比・テクニカル分析を Visualizer（デフォルト）または HTML で視覚化。Private API 要。',
		arguments: [VISUALIZER_MODE_ARG],
		requiresPrivateApi: true,
		messages: userMessage(PORTFOLIO_TEXT),
		metadata: {
			level: PromptLevel.INTERMEDIATE,
			category: PromptCategory.ANALYSIS,
			estimatedTime: '30秒',
			prerequisites: ['Private API キーの設定'],
			tags: ['intermediate', 'portfolio', 'pnl', 'private-api', 'visual', 'visualizer', 'html'],
		},
	},
];
