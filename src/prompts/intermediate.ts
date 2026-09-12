import { DISCLAIMER_MARKET, DISCLAIMER_SHORT } from './shared.js';
import { PromptCategory, type PromptDef, PromptLevel } from './types.js';

function userMessage(text: string) {
	return [{ role: 'user' as const, content: [{ type: 'text', text }] }];
}

const INDICATORS_TEXT = `代表的な指標を使ってBTCを分析して

【ツール】analyze_indicators(pair=btc_jpy, type=1day, limit=200)

【方針】総合判定→各指標横断→矛盾は明示→次の注目点を具体化。content の数値をそのまま使う。

【出力】Markdown見出しで区切る。補足は行頭「└」（前行行末にスペース2つで改行）。

# 📊 BTC/JPY 日足分析レポート
🔴/🟡/🟢 判定 + 現在価格（前日比）

## 📈 勢い指標
### RSI — 数値、█░ゲージ、初出1行説明、直近n日推移1行、転換サイン
### MACD — 数値、│中央の簡易バー（ヒストグラムの符号と強さ）、線・シグナル・ヒストグラム、状態・直近動き・転換サイン

## 📉 トレンド指標
### 移動平均線 — 25/75/200と乖離、配置（強気/弱気/混在）
### 一目均衡表 — 雲の上/中/下、距離・厚さ、三役の内訳3行、意味1行（大型ASCIIテンプレ不要）

## 📐 ボリンジャーバンド — ±2σ/中心、現在位置、バンド幅と状態

## 📍 重要な価格帯 — 現在価格中心の簡潔な縦リスト（BB±2σ、雲上下、SMA25/75/200）

## ⚖️ 指標の総合判断 — 矛盾時は短期vs中期を分けて説明、一致時は結論

## 🎯 次の転換サイン — 反発条件・下落継続条件

## 💡 まとめ — 2-3行

${DISCLAIMER_MARKET}`;

const SUPPORT_RESISTANCE_TEXT = `BTCのサポート・レジスタンスを分析して

【方針】テキストのみ。ツール実行後は中間説明なしで最終出力へ。

【ツール（この順）】
1. analyze_support_resistance(pair=btc_jpy, lookbackDays=90, topN=3) — ★・形成情報は content をそのまま使用。独自計算・日付推測禁止
2. get_orderbook(pair=btc_jpy, mode=raw)
3. get_orderbook(pair=btc_jpy, mode=pressure, bandsPct=[0.005, 0.01, 0.02])
4. analyze_sma_snapshot(pair=btc_jpy, type=1day, periods=[25, 75, 200]) — 任意

【板】bitbank は通常±5-6%まで。範囲内は BTC 数量を記載。範囲外は「取得範囲外（過去実績で評価）」と明記。推測・不明は禁止。★の上書きはしない（板は補足のみ）。

【表現（厳守）】
- 過去7-10日で一度でも価格がラインを割り込んだ場合:「試され」「防衛中」「疲弊」は禁止
- 使う: 接触、崩壊、再割れリスク、信頼性低下
- 直近7日以内に崩壊 → ★を1段階減格し理由を明記
- 出力前: セクション間で「試され」と「崩壊」が矛盾していないか確認

【出力】必ず「📌 分析範囲について」から開始（前置き・ツール結果の説明は不要）

📌 分析範囲について — 板は±5%程度、遠い価格帯は過去反応実績で評価

## 1. 現在の状況（要約）— 現在価格、最重要ポイント、板バランス、トレンド
## 2. サポートライン — 検出分のみ。背景・板・意義。タイプ名は出さない
## 3. レジスタンスライン — 同様
## 4. シナリオ — 下抜け/上抜け/レンジ（確率・トリガー・ターゲット・根拠）
## 5. 注意点
## 6. 構造図 — 上からレジスタンス→現在→サポートの簡潔テキスト図（★・距離%・短い注記）

数値: 価格はカンマ区切り、%は小数1桁、BTCは小数1桁。

${DISCLAIMER_MARKET}`;

export const intermediatePrompts: PromptDef[] = [
	{
		name: '中級：主要指標でBTCを分析して',
		description: '中級者向け：RSI/MACD/ボリンジャーバンド/一目均衡表/移動平均線を一括取得して総合的に分析',
		messages: userMessage(INDICATORS_TEXT),
		metadata: {
			level: PromptLevel.INTERMEDIATE,
			category: PromptCategory.ANALYSIS,
			estimatedTime: '1分',
			tags: ['intermediate', 'indicators', 'comprehensive', 'rsi', 'macd', 'bb', 'ichimoku', 'sma'],
		},
	},
	{
		name: '中級：BTCのフロー分析をして',
		description: '中級者向け：直近の売買フロー（CVD/aggressor ratio）からマーケットの方向性を分析',
		messages: userMessage(`BTCのフロー分析をやって

【ツール】
1) get_flow_metrics(pair=btc_jpy, limit=300, bucketMs=60000, view=full, nonZeroOnly=true)
2) get_transactions(pair=btc_jpy, limit=200, view=full) — 必要時

【用途】デイトレ〜短期スイングの地合い確認。
        執行タイミング判断（数秒～数分の売買）には鮮度が不足するため非推奨。

【方針】CVDトレンド、Aggressor Ratio（50%基準）、Volume Spike（z>2）、直近1-3時間重視

【出力】冒頭に 📸 YYYY/MM/DD HH:MM:SS JST 時点
- 結論（買い/売り/拮抗）
- CVD推移
- スパイク（あれば）
- 価格との連動状況

---
⚠️ 免責事項：この分析は参考情報であり、解釈には誤差が含まれる場合があります。
市況は刻々と変動するため、実際のトレード前には最新状況を再確認してください。
投資判断はご自身の責任でお願いします。`),
		metadata: {
			level: PromptLevel.INTERMEDIATE,
			category: PromptCategory.ANALYSIS,
			estimatedTime: '1分',
			tags: ['intermediate', 'flow', 'cvd', 'volume', 'transactions', 'short-term'],
		},
	},
	// `limit=180` は据え置き（#127）。
	//
	// #114 でスキャン窓が「直近 limit 本」に修正されるまで、この呼び出しは指標 warmup 込みの
	// 379 本を走査していた。実効的な観測期間が 379 → 180 本に半減したため、
	// 180 のままでよいかを `limit=180` / `limit=360` の比較で判定した。
	//
	// **このプロンプトのオプションでは両者の出力が一致する。** 決め手は
	// `requireCurrentInPattern=true` + `currentRelevanceDays=80` で、`range.end` が
	// 80 日以内のパターンしか残らないこと。1day で検出されうるパターンの最大 span は
	// 有界で（形成中 double 148 本 / 形成中ウェッジ 138 本 / 完成済みウェッジ・三角形の窓 90 本 /
	// flag・pennant 46 本。`patterns/bar-thresholds.ts`）、
	//
	//   - 形成中は定義上 `range.end` = 最終足なので必要な窓は最大 149 本
	//   - 完成済みは「80 日の経過分 + 窓 90 本」= 170 本（+ ブレイク確認の数本）
	//
	// のいずれも 180 本に収まる。**span が有界な種別については 360 本にしても結果は増えない**
	// ——増える検出は `range.end` が 80 日より古く、このプロンプト自身の relevance フィルタが
	// 落とすため（合成系列 6 本で実測。フィルタを外すと 360 側だけ 241 本前のパターンが 1 件増える）。
	//
	// **ただし「360 でも必ず同じ答え」ではない。** 完成済み double / triple / H&S は構成点間隔に
	// 上限が無く、relevance フィルタが見るのは `range.end` だけなので、**構成点が 180 本超に
	// またがっていて `range.end` が直近 80 日以内**というパターンは 360 でだけ出る。
	// 180 に対する 360 の増分はここに限られる。
	//
	// それでも据え置くのは、そのマクロなパターンがこのプロンプトの対象ではないため
	// （「完成後80日超 → 無視」「完成後40日超 → 最大🟡中」という核心ルールは直近の形を見る設計で、
	// 数ヶ月にまたがる構成点の大型パターンを扱うなら `currentRelevanceDays` ごと設計し直す話になる）。
	// 全呼び出しの API 取得コストを倍にして得られるのがその一種類だけなら、割に合わない。
	{
		name: '中級：BTCのパターン分析をして',
		description: '中級者向け：短期（1〜3本足）から中長期（大型パターン）まで、複数の時間軸でパターンを検出',
		messages: userMessage(`BTCのチャートパターン分析

【核心ルール】
- 完成後80日超 → 無視
- ターゲット到達済み（100%超）→ ⚪低
- 完成後40日超 → 最大🟡中
- ネック/ターゲットから10%超離れ → ⚪低
- 中間処理の説明は出さない

【ツール】
1) detect_patterns(pair=btc_jpy, type=1day, limit=180, view=detailed, includeForming=true, includeCompleted=true, requireCurrentInPattern=true, currentRelevanceDays=80)
2) analyze_candle_patterns(pair=btc_jpy, type=1day, allow_partial_patterns=false)
   ※検出時は render_candle_pattern_diagram でSVG表示

【重要度】整合度0.8+/0.7-0.8/0.7未満。±10%以内+高評価=🔴、+中=🟡、それ以外=⚪

【出力】
## 1. 形成中（切迫性順、なければ検出なし）
## 2. 完成済み（80日未満、重要度順）
## 3. 短期ローソク足（なければ検出なし）
## 4. 総合解釈
## 5. シナリオ（強気/弱気/中立）

${DISCLAIMER_SHORT}`),
		metadata: {
			level: PromptLevel.INTERMEDIATE,
			category: PromptCategory.ANALYSIS,
			estimatedTime: '1分',
			tags: ['intermediate', 'patterns', 'chart-patterns'],
		},
	},
	{
		name: '中級：BTCのサポレジを分析して',
		description: '中級者向け：過去の反応×板の厚み×直近の攻防から、価格帯の強弱を統合的に分析',
		messages: userMessage(SUPPORT_RESISTANCE_TEXT),
		metadata: {
			level: PromptLevel.INTERMEDIATE,
			category: PromptCategory.ANALYSIS,
			estimatedTime: '1-2分',
			tags: ['intermediate', 'support', 'resistance', 'price-levels', 'orderbook', 'candles', 'comprehensive'],
		},
	},
];
