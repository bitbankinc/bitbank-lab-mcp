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
2. get_candles(pair="btc_jpy", type="1hour", limit=24, view="full") — 直近 24h（24 本）の close。ミニスパークライン用（view="full" は既定値で、サマリ本文が 24 本すべての OHLCV を 1 行 1 本で含む）
3. analyze_market_signal(pair="btc_jpy") — 地合い判定。総合スコア（-100〜+100）と bullish/neutral/bearish を 1 行に要約する用途のみ（数値テーブルは展開しない）

【前日比（24h・データ由来。状態保存はしない）】
- 前日比(24h) = get_ticker が算出済みの 24h変動 (last−open)/open をそのまま転記する。
- ラベルは「前日比(24h)」と明記（暦日の前日比ではなく 24 時間前比であることを正直に）。
- 毎回データから算出するため初回・別環境でも N/A にならない。前回値の保存/読込は行わない。

【データ誠実性（正確に、ただし簡潔に）】
- 取得時刻・対象期間・warning は実値で示す（推測・「直近8時間」等のハードコード禁止）。warning・カバー率があれば隠さない。
- ただしメタ情報は小さくフッターに 1 箇所へまとめる。計算式・内部フィールド名・本数は出さない（例「(last−open)/open」「1時間足24本」「get_ticker 24h変動」は不可）。見せるのは結果の数値と期間だけ。
- 同じ情報を複数箇所で繰り返さない（レンジ＝参考ライン / 時刻＝フッターに 1 回）。

${VISUALIZER_OUTPUT_BLOCK}

【レイアウト（最小構成）】
- 上段: 結論（大きめ 1 行＋補足 1 行）
- 中段: ミニスパークライン（横長・小）
- 下段: 地合い — 総合判定 1 行＋5 指標の小カード（横並び / グリッド）。主要ライン 2 本は（任意）small text。
- カードは「地合いの 5 指標」に限定（敷き詰めない）。上段・中段はテキスト＋スパークラインのみで余白を活かす。

【セクション（この 3 つだけ）】
1. 結論（最上段・1〜2 行）— 結論先行。例:「今朝 ¥10,600,000、前日比(24h) −0.2%（ほぼ横ばい）。地合いは弱気寄り。」補足は価格の質感を一言だけ（じり安 / 横ばい / 急騰 等）。レンジ数値・トレンド構造・指標の話はここに入れない（カード・参考ラインに任せる）。
2. スパークライン（大きめに）— get_candles 直近 24 本（24h）の close をインライン SVG（<svg><polyline>）で描く。render_chart_svg は使わない。
   - サイズは見やすく大きめに: 横幅は枠いっぱい（width="100%"）、高さ ~140px。viewBox="0 0 480 140"、preserveAspectRatio="none" で枠に追従。
   ▼上下の見切れ防止（必須・スケーリング規則）:
   - Y ドメインは描画データ自身の min/max から取る（固定値で決め打ちしない）→ 全点が必ず枠内に収まる。
   - viewBox 内に上下マージン M=16 を確保し、min/max が枠線に接しないように:
     ・点 i の x = 16 + i/(n−1) × (480 − 32)
     ・点 i の y = M + (1 − (close_i − min)/(max − min)) × (140 − 2M)
     ・max == min（無変化）のときは全点 y = 70 の水平線にする（ゼロ除算回避）
   - <svg> に overflow="visible"、<polyline> は fill="none" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"。
   - 線色は方向で（任意）: 上げ=緑 / 下げ=赤 / 横ばい=グレー。
   - 始点(≈24h前)・終点(≈現在)の close 値だけ数値で添える。見出しは対象期間のみ簡潔に（例「直近24h（6/15 18:00→6/16 17:00 JST）」。本数・「終値」等の語は不要）。装飾はこれ以上盛らない。
3. 地合い（指標カードで整理）— analyze_market_signal を使う。専門語はかみ砕き、数値テーブルにはしない:
   - 見出しに総合判定 1 行: 「強気 / 弱気 / 方向感なし」＋方向感スコア（-100〜+100、＋＝上向き / −＝下向き、±25 超で強気・弱気）＋確からしさ（高 / 中 / 低）。
   - その下に内訳を 5 枚の小カードで（横並び / グリッド）: ①移動平均の向き〔最重視〕 ②値動きの勢い(RSI) ③売買の流れ(CVD＝買い/売りの偏り) ④値動きの荒さ ⑤買い圧力。
   - 各カード＝指標名（日常語）＋状態（🟢上向き / 🔴下向き / ⚪中立 の色・アイコン）＋一言。状態は analyze_market_signal の content（「重み X%: 値（ラベル）」や RSI 等）から転記。重み・寄与は「重要度」として小さく添える程度で、生の小数は出さない。
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
