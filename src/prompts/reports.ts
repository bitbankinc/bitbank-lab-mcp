import { DISCLAIMER_MARKET, VISUALIZER_MODE_ARG, VISUALIZER_OUTPUT_BLOCK } from './shared.js';
import { PromptCategory, type PromptDef, PromptLevel } from './types.js';

function userMessage(text: string) {
	return [{ role: 'user' as const, content: [{ type: 'text', text }] }];
}

const OHAYO_TEXT = `今朝の BTC/JPY を「なんとなく把握」する軽量レポートを作成してください。トレード判断用ではありません。5 秒で「今こういう感じか」と分かる密度に絞ります。

【速度（重要）】
- 必要ツールは最初に 1 回でまとめてロードする（tool_search を何度も呼ばない）。
- 下記 3 ツールは互いに依存しないので **必ず並列で** 呼ぶ（直列にしない）。状態ファイル等の読み書きは不要。

【ツール（この 3 つだけ。追加呼び出し禁止）】
1. get_ticker(pair="btc_jpy") — 現在値(last)・24h 始値(open)・24h 高安・取得時刻。前日比(24h) はこの 24h変動 (last−open)/open を使う
2. get_candles(pair="btc_jpy", type="1hour", limit=24, view="items") — 直近 24h（24 本）の close。ミニスパークライン用（view="items" で 24 本すべて取得）
3. analyze_market_signal(pair="btc_jpy") — 地合い判定。総合スコア（-100〜+100）と bullish/neutral/bearish を 1 行に要約する用途のみ（数値テーブルは展開しない）

【前日比（24h・データ由来。状態保存はしない）】
- 前日比(24h) = get_ticker が算出済みの 24h変動 (last−open)/open をそのまま転記する。
- ラベルは「前日比(24h)」と明記（暦日の前日比ではなく 24 時間前比であることを正直に）。
- 毎回データから算出するため初回・別環境でも N/A にならない。前回値の保存/読込は行わない。

【データ誠実性】
- 各数値に取得時刻・カバー期間をツールレスポンスのまま明記（推測・「直近8時間」等のハードコード禁止）。
- ツールの content / summary に warning・カバー率があれば隠さずそのまま表示する。

${VISUALIZER_OUTPUT_BLOCK}

【レイアウト（最小構成）】
- 上段: 結論（大きめ 1 行＋補足 1 行）
- 中段: ミニスパークライン（横長・小）
- 下段: 地合い 1 行＋（任意）主要ライン 2 本を small text
- mockup モジュール想定。カードを敷き詰めず余白を活かす。「テキスト＋スパークライン 1 個」を超えて盛らない。

【セクション（この 3 つだけ）】
1. 結論（最上段・1〜2 行）— 結論先行。例:「今朝 ¥10,600,000、前日比(24h) −0.2%（ほぼ横ばい）。地合いは弱気寄り。」価格の質感を言葉で（じり安 / 横ばい / 急騰 等）。これだけ読めば把握が完了する密度にする。
2. ミニスパークライン — get_candles 直近 24 本（24h）の close をインライン SVG（<svg><polyline>）で描く。render_chart_svg は使わない。
   ▼上下の見切れ防止（必須・スケーリング規則）:
   - Y ドメインは描画データ自身の min/max から取る（固定値で決め打ちしない）→ 全点が必ず枠内に収まる。
   - viewBox と上下マージン（パディング）で min/max が枠線に接しないようにする。例: viewBox="0 0 240 48"、上下マージン M=8。
     ・点 i の x = 4 + i/(n−1) × (240 − 8)
     ・点 i の y = M + (1 − (close_i − min)/(max − min)) × (48 − 2M)
     ・max == min（無変化）のときは全点 y = 24 の水平線にする（ゼロ除算回避）
   - <svg> に overflow="visible"、<polyline> は fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"。
   - 線色は方向で（任意）: 上げ=緑 / 下げ=赤 / 横ばい=グレー。
   - 始点(≈24h前)・終点(≈現在)の close 値だけ数値で添える。装飾はこれ以上盛らない。
3. 地合い 1 行 — analyze_market_signal を「強気 / 弱気 / 方向感なし」＋ごく短い根拠（スコア・信頼度）1 行に要約。数値テーブルは出さない。
（任意・下段に小さく）主要ライン 2 本 — get_ticker の 24h 高安で代用可。上下各 1 本だけ small text。S/R ツールは追加しない（速度優先）。

【出さないもの】イベントタイムライン / 板圧力 ±0.5・1・2% の 3 段 / MTF 25・75・200 数値テーブル / 一目均衡表の詳細・三役判定 / trigger price・シナリオ分岐。

${DISCLAIMER_MARKET}`;

const PORTFOLIO_TEXT = `私の bitbank 口座の資産状況を視覚化してください。

${VISUALIZER_OUTPUT_BLOCK}

【ツール（1つのみ）】
analyze_my_portfolio(include_pnl=true, include_technical=true, include_deposit_withdrawal=true)

【データ】ツール content テキストのみ参照（structuredContent は見えない）。末尾 JSON の data を使う:
- グラフ: **monthly_equity_series**（月次タブ・日次全点）/ **yearly_equity_series**（年次タブ・月次全点）
- 月初比/年初比の2点（monthly_performance / yearly_performance の start→current）だけで折れ線を描かない
- equity_series は include_pnl=true なら常に populated。summary 先頭の「※ 資産推移シリーズ:...」警告行（jpy_only / fallback_only / partial_fallback）はそのままユーザー向け注記に転載する
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
		description:
			'今朝の BTC/JPY をサッと把握する軽量レポート（価格＋前日比(24h)・ミニスパークライン・地合い1行）。Visualizer（デフォルト）または HTML 出力。',
		arguments: [VISUALIZER_MODE_ARG],
		messages: userMessage(OHAYO_TEXT),
		metadata: {
			level: PromptLevel.INTERMEDIATE,
			category: PromptCategory.ANALYSIS,
			estimatedTime: '15秒',
			tags: ['intermediate', 'btc', 'overnight', 'lightweight', 'visual', 'visualizer', 'html'],
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
