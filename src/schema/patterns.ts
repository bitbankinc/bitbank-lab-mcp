import { z } from 'zod';
// target 進捗系の description は閾値を書き写さず実装から読む（書き写すと振る舞いと宣言が黙ってずれる）。
import {
	MIN_TARGET_DISTANCE_HEIGHT_RATIO,
	TARGET_REACH_MAX_BARS,
	TARGET_REACHED_PCT_CAP,
} from '../../tools/patterns/target-reach.js';
import {
	BaseMetaSchema,
	BasePairInputSchema,
	CANDLE_DATE_DESCRIPTION,
	CandleTypeEnum,
	FailResultSchema,
	toolResultSchema,
	VIEW_CONTRACT_NOTE,
	warningField,
	warningsField,
} from './base.js';

/** 'flag' / 'pennant' / 'triangle' のような umbrella alias は出力 type に含めない。 */
const PATTERN_OUTPUT_TYPES = [
	'double_top',
	'double_bottom',
	'triple_top',
	'triple_bottom',
	'head_and_shoulders',
	'inverse_head_and_shoulders',
	'triangle_ascending',
	'triangle_descending',
	'triangle_symmetrical',
	'falling_wedge',
	'rising_wedge',
	'bull_flag',
	'bear_flag',
	'bull_pennant',
	'bear_pennant',
] as const;

const PATTERN_FILTER_ALIASES = ['flag', 'pennant', 'triangle'] as const;

export const PatternTypeEnum = z.enum(PATTERN_OUTPUT_TYPES);

export const PatternFilterEnum = z.enum([...PATTERN_OUTPUT_TYPES, ...PATTERN_FILTER_ALIASES]);

// 'wedge' は候補ラベルにだけ使い、入力の絞り込みでは受け付けない（入力の型を広げずに、ウェッジの走査の棄却を三角形と分けるため）。
export const PatternCandidateTypeEnum = z.enum([...PATTERN_OUTPUT_TYPES, ...PATTERN_FILTER_ALIASES, 'wedge']);

export const DetectPatternsInputSchema = BasePairInputSchema.extend({
	type: CandleTypeEnum.optional().default('1day'),
	limit: z
		.number()
		.int()
		.min(20)
		.max(365)
		.optional()
		.default(90)
		.describe(
			'スキャン窓の本数。**直近 limit 本がそのまま検出器に渡る**（指標 warmup 分は含まない）。\n' +
				'スイング検出で窓の前後 swingDepth 本ずつがピボット候補から外れるため、' +
				'時間足の既定 swingDepth に対して小さすぎると構造上ほぼ何も検出できない' +
				'（日足の既定 swingDepth=6 では 23 本未満）。その場合は data.warnings に ' +
				'`limit_too_small_for_timeframe` を載せ、content 先頭にも警告行を出す。\n' +
				'逆に既定の 90 は「いま形成中〜完成直後のパターンを見る」ための窓なので、' +
				'**過去のパターンの統計（data.statistics の成功率 / 平均リターン）や aftermath を調べる用途では上げる**' +
				'（上限 365）。反転系は先行履歴の検証に60本を使うため、61本未満では履歴不足候補を一律に' +
				'除外せず `limit_too_small_for_timeframe` 警告を優先する。view=summary / detailed の content 量はほぼ変わらず、増えるのは API 呼び出し回数。',
		),
	date: z
		.string()
		.optional()
		.describe(
			`${CANDLE_DATE_DESCRIPTION} limit 本を走査します。省略時は最新足を終端にします。date 指定時の requireCurrentInPattern は終端日を「現在」として判定します。`,
		),
	patterns: z
		.array(PatternFilterEnum)
		.optional()
		.describe(
			[
				'Patterns to detect. Recommended params (guideline):',
				'- double_top/double_bottom: leave swingDepth / tolerancePct / minBarsBetweenSwings unset — the ' +
					'timeframe-auto values ARE the recommendation. Passing 7 / 0.04 / 5 explicitly does not pin those ' +
					'numbers: they are the schema defaults and get replaced by the timeframe-auto values (see each param).',
				'- triple_top/triple_bottom: tolerancePct≈0.05',
				'- triangle_*: tolerancePct≈0.06',
				'- pennant: swingDepth≈5, minBarsBetweenSwings≈3',
				'- The ≈ values above are absolute targets, NOT "looser than the default". Compare them with the ' +
					'timeframe-auto table in each parameter first: tolerancePct is already 0.05 on 1hour/4hour ' +
					'(≈0.05 is a no-op there) and already 0.06 on 15min/30min (≈0.05 TIGHTENS it), and ' +
					'swingDepth / minBarsBetweenSwings are already 5 / 3 on 4hour/8hour/12hour.',
				'- head_and_shoulders/inverse_head_and_shoulders: shoulder-level tolerance is tolerancePct ' +
					'(same "bigger = looser" meaning as other types); to loosen how much the head must stand out ' +
					'above/below the shoulders, use headProminencePct instead (opposite direction: bigger = stricter).',
				"Aliases: 'flag' → bull_flag + bear_flag, 'pennant' → bull/bear pennant, 'triangle' → asc/desc/sym.",
			].join('\n'),
		),
	swingDepth: z
		.number()
		.int()
		.min(1)
		.max(10)
		.optional()
		.default(7)
		.describe(
			'スイング検出の窓の深さ。ピボット（山 / 谷）と認めるのに前後何本ぶんの比較を要求するか。' +
				'大きいほどピボットが減り、検出されるパターンも減る。窓の前後 swingDepth 本は' +
				'ピボット候補から外れるので limit の実効下限にも効く（limit の説明を参照）。\n' +
				'**未指定なら時間軸オート**: 1min/5min=2, 15min/30min/1hour=3, 4hour/8hour/12hour=5, ' +
				'1day=6, 1week=7, 1month=8。\n' +
				'**⚠ 既定値 7 を明示的に渡しても時間軸オートに置換される**（7 は「未指定」の sentinel 扱い）。' +
				'`swingDepth=7` は 1hour では 3、1day では 6 として実行される。' +
				'指定した値をそのまま効かせたいなら 7 以外を渡すこと（6 や 8 はそのまま通る）。' +
				'**深くしたい / 浅くしたいときは上の時間軸オート値と比べて選ぶ**' +
				'（例: 1hour の auto は 3 なので、7 を渡すのは「深くする」ではなく「auto に戻す」）。\n' +
				'**#242 の経路ゲート（peak_after_last_pivot / trough_after_last_pivot）と再進入チェックも' +
				'同じ swingDepth のピボット列で判定するため、深さを増やすと発火しにくくなる**' +
				'（同じ値動きで swingDepth=3 では invalid、6 では完成済みになりうる。issue #251）。' +
				'窓の終端 swingDepth 本の足はピボットになれないため、そこにある戻しは経路ゲートが見ない' +
				'（同じ値動きでも limit で completed / invalid が変わりうる。issue #277）。',
		),
	tolerancePct: z
		.number()
		.min(0)
		.max(0.1)
		.optional()
		.default(0.04)
		.describe(
			'同水準判定の許容誤差。大きいほど判定が緩くなる。head_and_shoulders / inverse_head_and_shoulders では' +
				'肩の左右差の許容誤差にのみ使う（ネックライン水平度は本パラメータに依存しない固定閾値。' +
				'頭が肩よりどれだけ突出すべきかは ' +
				'headProminencePct が別に持つ。issue #149——旧実装はここに頭の突出要求も相乗りしており、' +
				'肩では「大きいほど緩い」・頭では「大きいほど厳しい」が同じ値に同時にかかっていた）。\n' +
				'**未指定なら時間軸オート**: 1hour/4hour=0.05, 8hour/12hour=0.045, 15min/30min=0.06, ' +
				'1week=0.035, 1month=0.03, その他=0.04。\n' +
				'**⚠ 既定値 0.04 を明示的に渡しても時間軸オートに置換される**（0.04 は「未指定」の sentinel 扱い）。' +
				'1hour では `tolerancePct=0.04` が 0.05 として実行されるので、' +
				'**0.04 → 0.05 に「緩めた」つもりの再検出は 1hour では何も緩んでいない**（前後とも実効 0.05）。' +
				'指定した値をそのまま効かせたいなら 0.04 以外を渡し、' +
				'**緩める / 締めるの判断は上の時間軸オート値との比較で行うこと**' +
				'（1hour の auto は 0.05 なので、緩めるなら 0.055 以上。0.045 は auto より厳しい）。',
		),
	minBarsBetweenSwings: z
		.number()
		.int()
		.min(1)
		.max(30)
		.optional()
		.default(5)
		.describe(
			'ピボット（山 / 谷）どうしに要求する最小間隔（バー数）。大きいほど近接ピボットが排除され、' +
				'検出されるパターンも減る。\n' +
				'**未指定なら時間軸オート**: 1min/5min=1, 15min/30min/1hour=2, 4hour/8hour/12hour=3, ' +
				'1day=4, 1week=5, 1month=6（swingDepth と同じ表の別列。両者は必ず同じ時間軸オートから来る）。\n' +
				'**⚠ 既定値 5 を明示的に渡しても時間軸オートに置換される**（5 は「未指定」の sentinel 扱い）。' +
				'`minBarsBetweenSwings=5` は 1hour では 2、1day では 4 として実行される。' +
				'指定した値をそのまま効かせたいなら 5 以外を渡すこと（4 や 6 はそのまま通る）。' +
				'**広げたい / 狭めたいときは上の時間軸オート値と比べて選ぶ**' +
				'（例: 1hour の auto は 2 なので、5 を渡すのは「広げる」ではなく「auto に戻す」）。',
		),
	headProminencePct: z
		.number()
		.min(0)
		.max(0.1)
		.optional()
		.describe(
			'head_and_shoulders / inverse_head_and_shoulders 専用: 頭が両肩よりどれだけ突出していなければ' +
				'ならないかの最小要求率。**tolerancePct とは向きが逆で、大きいほど判定が厳しくなる**' +
				'（最小要求を引き上げるため）。緩めたい（=頭の突出要求を下げたい）ときは値を小さくする。\n' +
				'未指定時は本パラメータ専用の時間軸オート値（1min=0.0011, 5min=0.0024, 15min=0.0041, ' +
				'30min=0.0058, 1hour=0.0083, 4hour=0.0163, 8hour=0.0231, 12hour=0.0283, ' +
				'1day/1week/1month/その他=0.04）を使う。**この表は tolerancePct の時間軸オート表とは' +
				'別物**（issue #198。1hour は tolerancePct では 0.05 だが本パラメータでは 0.0083 —— ' +
				'両パラメータは意味の向きが逆なので同じ表を共有できない。旧実装は #198 以前、暫定的に ' +
				'tolerancePct の表を流用しており、1hour が 1day より頭の突出を 25% 厳しく要求する逆転が' +
				'起きていた）。tolerancePct を明示的に変更しても本パラメータには影響しない' +
				'（H&S の頭の判定は tolerancePct から完全に独立）。',
		),
	view: z
		.enum(['summary', 'detailed', 'full', 'debug'])
		.optional()
		.default('detailed')
		.describe(
			`${VIEW_CONTRACT_NOTE}\n` +
				'**`実効パラメータ（入力値ではない）:` 行は 4 view すべて（`debug` を含む）に出る。** ' +
				'解決後の実効値と由来（`(auto)` / `(指定)`）で、構造化データは meta.effective_params。' +
				'`swingDepth` / `minBarsBetweenSwings` / `tolerancePct` はスキーマ既定値が sentinel なので、' +
				'**渡した値と行の値が食い違うことがある**（#182 / #184）。' +
				'**位置は view で違う**（行頭ラベルが一意なので機械的な抽出には影響しない）: ' +
				'`debug` はヘッダの直下、summary / detailed / full は次の 2 行の**下**（＝ヘッダから 4 行目）。\n' +
				'summary / detailed / full では、ヘッダ直下に 2 行が出る（**別の量なので混同しないこと**）:\n' +
				'  - `スキャン範囲: <先頭足> ~ <末尾足>（N本）` — 検出器に実際に渡した足のレンジ。' +
				'1day 未満の時間足では時刻まで表示する。構造化データは meta.scan。\n' +
				'  - `検出パターン分布期間: <最古 range.start> ~ <最新 range.end>（N日間）` — ' +
				'**検出されたパターンの分布**であってスキャン窓ではない（旧ラベル「検出対象期間」）。\n' +
				'さらに summary / detailed / full には `検出経路:` 行が 1 行出る' +
				'（実効パラメータ行の次。**パターン 0 件のときは出ない**。`debug` はパターンを列挙しない view なので出さない）。' +
				'`strict N 件 / relaxed フォールバック由来 M 件（relaxed_triple_x1.25×1, …）` の形で、' +
				'relaxed 経路が拾い直した件数と段の内訳を申告する。**relaxed が 0 件でも ' +
				'`全 N 件とも strict（relaxed フォールバック由来は 0 件）` と明示する**' +
				'——行が無いことを「relaxed なし」と読ませないため（値が無いのか content に出していないのかを' +
				'呼び出し側が区別できない状態が #189 / #191 の直した欠陥）。構造化データは data.patterns[]._fallback。\n' +
				'**`検出内訳:` 行は 4 view すべて（`debug` を含む）に出る**（issue #200）。' +
				'`検出 N件 → 反転履歴不足 -H → 重複統合 -M → [現在時点フィルタ -K →] ライフサイクル除外 -L → triple×H&S排他 -X → 出力 P件` の形で、' +
				'globalDedup / requireCurrentInPattern（既定 false）/ ライフサイクル絞り込み（includeForming 等）/ ' +
				'triple×H&S の型間排他（issue #218。**減るのは triple_* だけ**）の' +
				'5 段でどれだけ減ったかを申告する。`現在時点フィルタ` は 0 のとき区間ごと省くが、' +
				'`反転履歴不足` / `重複統合` / `ライフサイクル除外` / `triple×H&S排他` は 0 でも省かない。構造化データは meta.reduction' +
				'（`detected` = `reversalHistoryExcluded + dedupMerged + currentFiltered + lifecycleExcluded + tripleHsExcluded + output`）。\n' +
				'- summary: ヘッダ ＋ 分類内訳 ＋ 直近30日/90日件数 ＋ 上記 2 行 ＋ 実効パラメータ行 ＋ 検出経路行 ＋ 検出内訳行 ＋ 検討パターン。' +
				'個々のパターンの詳細は content に出ない（**どのパターンが relaxed 由来かも出ない**——届くのは検出経路行の件数だけ）。\n' +
				'- detailed（既定）: 上位 5 件の詳細。6 件目以降は content に出ない。' +
				'検出件数が 5 件以上のときは見出し `【検出パターン】` に `N / 全 M 件（K 件省略。全件は view=full）` の' +
				'形で件数を申告する（並び順は confidence 単独ではなく status → confirmation → confidence → ' +
				'直近性の優先順。ちょうど 5 件なら `省略なし` になる）。5 件未満では省略が構造的に起こり得ないため' +
				'申告行自体を出さない。\n' +
				'relaxed 由来のパターンは見出し行の末尾に `[relaxed_triple_x1.25]` が付く' +
				'（`data.patterns[]._fallback` と同じ値。印が無ければ strict 経路で拾えた）。' +
				'structuredContent に usage_example を**足す**。\n' +
				'- full: 全件の詳細（double_top / double_bottom では山谷 3 点の pivot 行も出る）。' +
				'relaxed 由来の印は detailed と同じ。本ツールの最重量。\n' +
				'- debug（**階梯外**）: swings / candidates のみ。**検出パターンもスキャン範囲 / 検出パターン分布期間の 2 行も' +
				'検出経路行も content に出ない**（実効パラメータ行と検出内訳行だけは出る——' +
				'`accepted N件 → data.patterns M件` のような疑問が最も生じやすい view なので診断に要る）。' +
				'出力を置換する view なので full の上位集合ではない。structuredContent に data.candidates を**足す**。\n' +
				'  candidates は `patterns` で要求した種別（エイリアスは展開して照合）に**絞って**返す。' +
				'`patterns` 未指定なら全種別。絞らないと cap（200件）を要求外の種別が食い潰し、' +
				'要求した種別の棄却理由が押し出される。\n' +
				'  **cap で押し出しが起きた場合は申告する**（issue #180）。`meta.debug.candidatesTotal` が' +
				'絞り込み後の総数、`meta.debug.candidatesOmitted` が押し出された件数で、content には' +
				'`【Candidates】 200 / 全 N 件（M 件省略）` の形で出る（押し出しが無ければ「省略なし」）。' +
				'トリムは accepted を先に並べてから切るので**押し出しは棄却理由から始まる**。' +
				'`candidates` に `accepted:false` が 1 件でも残っていれば accepted は全件収まっており、' +
				'押し出されたのはすべて棄却理由（全 200 件が `accepted:true` のときだけ accepted も' +
				'押し出されうる）。' +
				'`swings` 側も同様に `swingsTotal` / `swingsOmitted` を返す（`swings` は先頭から残すので' +
				'落ちるのは直近側）。\n' +
				'  **棄却理由の集計は content 側で済ませてある（数え直さないこと。issue #191）。** ' +
				'`【Candidates】` の見出しの直後・候補の列挙より前に 3 段の集計ブロックが出る:\n' +
				'    `▼ 候補の内訳: 全 69 件 = accepted 7 件 + rejected 62 件（cap 省略なし＝全候補の内訳）`\n' +
				'    `▼ 棄却理由の内訳（type 別 → reason 別。合計は上の rejected 62 件と一致する）`\n' +
				'    `   - triple_top 40 件: three_peaks_not_level 21 / valleys_missing 12 / valley_too_shallow 7`\n' +
				'    `   - triple_bottom 22 件: peak_too_shallow 15 / peaks_missing 7`\n' +
				'  内訳は **type と reason の 2 軸**で数える（`rising_wedge:no_convergence` と ' +
				'`falling_wedge:no_convergence` を同じ行に潰さないため——' +
				'同じ reason でも type が違えば意味が違う）。type 行の合計は上の rejected 件数と、' +
				'行内の reason の合計はその type の件数と必ず一致する（多すぎる場合は残余に畳むが、畳んだ分も件数で残す）。\n' +
				'  **その下に `▼ reason 横断合計` が 1 行出る**（type を畳んで reason だけで合算したもの。issue #193）:\n' +
				'    `▼ reason 横断合計（type を跨いで reason だけで合算。…。合計は上の rejected 62 件と一致する）`\n' +
				'    `   - three_peaks_not_level 21 / peak_too_shallow 15 / valleys_missing 12 / valley_too_shallow 7 / peaks_missing 7`\n' +
				'  **横断合計を自分で足さないこと。** 「棄却理由を多い順に」を type 別行から手集計すると外れる' +
				'（別のライブ実測: type 別の数値をそのまま横断合計として提示し、続いて' +
				'`no_convergence(41) > slopes_not_same_direction(66)` という不等号が成立しない式を出力した）。' +
				'`reason` が `type` を跨ぐ実行ほど外れやすいので、跨ぎが起きうる **type が 2 種別以上のときだけ**出す' +
				'（1 種別なら type 行がそのまま横断合計なので出さない）。type 別の内訳を**置き換えるものではない**——' +
				'同じ reason でも type ごとに意味が違いうる（`no_convergence` は rising / falling で別の話）ので、' +
				'**帰属は必ず type 別行で見る。** 上限（10 種）を超えた分は type 行と同じ `他 N 種 M` に畳み、' +
				'cap 飽和時は type 別行と同じ `**全 N 件の内訳ではない**` が付く。\n' +
				'  **cap で押し出しが起きているときは分母が「表示分」に変わる**: ' +
				'`▼ 候補の内訳: 表示 200 件 = accepted 7 件 + rejected 193 件（全 289 件のうち 89 件は cap で省略されており、' +
				'**この集計に入っていない**）` となり、内訳の見出しにも「**全 289 件の内訳ではない**」が付く。' +
				'この状態の内訳から母集団（全 289 件）の傾向を語らないこと——censored な内訳からの誤帰属は' +
				'実際に起きている（#152 → #167）。全体の内訳が要るなら `patterns` で種別を絞って呼び直す。' +
				'`meta.debug.candidatesTotal` の申告が無い呼び出しでは分母が `受け取った N 件` になり、' +
				'省略の有無は不明として扱う。\n' +
				'  `accepted:false` は候補生成の時点での棄却（例: `head_not_higher`。`includeInvalid` では拾えない）で、' +
				'`status` を持たない。`accepted:true` は**検出器が候補を組み立てた**ことを示すだけで、' +
				'`data.patterns` に残ったことは意味しない（形成中パスの成功エントリは `globalDedup` より前に積むため、' +
				'重複除去で最終出力から消えることがある）。エントリが持つ `status` / `breakoutDirection` も' +
				'**組み立てた時点の観測値**であって、その後 `status=invalid`/`expired` になったかどうかは' +
				'candidates からは分からない。それを見るには `data.patterns` 側を `includeInvalid=true` で見る' +
				'（区別は includeInvalid の説明を参照）。',
		),
	requireCurrentInPattern: z.boolean().optional().default(false),
	currentRelevanceDays: z.number().int().min(1).max(365).optional().default(7),

	includeForming: z.boolean().optional().default(false).describe('形成中パターンを含める'),
	includeCompleted: z.boolean().optional().default(true).describe('完成済みパターンを含める'),
	includeInvalid: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			'無効化済み（`status=invalid`）および期限切れ（`status=expired`）のパターンを含める。' +
				'期限切れ = 第2構成点の確定から突破確認窓を過ぎてもネックラインを突破しなかった候補で、' +
				'既定ではノイズになるため出力されない。\n' +
				'**`true` にしても拾えるのは、一度パターンとして成立してから無効化された `status=invalid` / ' +
				'`expired` のものだけ。** `head_not_higher` / `shoulders_not_near:both` 等、構造要件を満たさず' +
				'**候補生成の時点で**落ちたものは `status` 自体を持たないため、`includeInvalid` では拾えない' +
				'（見るには `view=debug` の `data.candidates` を使う。`accepted:false` の `reason` に理由が入る）。',
		),
	tz: z
		.string()
		.optional()
		.default('Asia/Tokyo')
		.describe(
			'表示日時のタイムゾーン（既定: Asia/Tokyo）。get_candles の tz と揃える。' +
				'pattern の表示日時（期間 / 形成期間 / 文脈期間 / ブレイク確認 / 先行トレンド / pivot / スキャン範囲 / 検出パターン分布期間 / 構造図 等）に適用される。' +
				'intraday（1day 未満の時間足）では日付だけでなく時刻（HH:mm）まで表示する' +
				'（issue #200。24 本が同じ日付ラベルに潰れてどの足か特定できない問題への対応）。日足以上は暦日のみ。' +
				'構造化データ（data.patterns[*].range.start/end 等）は後方互換のため UTC ISO 文字列のまま不変。' +
				'空文字も Asia/Tokyo にフォールバック。',
		),
});

function effectiveParam<T extends z.ZodTypeAny>(valueSchema: T, note: string) {
	return z
		.object({
			value: valueSchema.describe(`実効値。${note}`),
			source: z
				.enum(['auto', 'explicit'])
				.describe(
					'`explicit` = 渡した値がそのまま効いた / `auto` = 時間軸オート表から解決した' +
						'（未指定とスキーマ既定値の明示指定を畳んだ値）。',
				),
		})
		.describe(note);
}

/** `optional()` だが `ok` の出力では常に埋まる。optional なのはハンドラを直接叩く古い経路を通すためで、欠損は「申告前の実装」を意味する。 */
const EffectiveParamsSchema = z
	.object({
		swingDepth: effectiveParam(
			z.number().int(),
			'スイング検出の窓の深さ。スキーマ既定値 7 は sentinel で、時間軸オート値に置換される。',
		),
		minBarsBetweenSwings: effectiveParam(
			z.number().int(),
			'ピボット間の最小バー数。スキーマ既定値 5 は sentinel で、時間軸オート値に置換される。',
		),
		tolerancePct: effectiveParam(
			z.number(),
			'同水準判定の許容誤差。スキーマ既定値 0.04 は sentinel で、時間軸オート値に置換される。',
		),
		headProminencePct: effectiveParam(
			z.number(),
			'H&S / 逆 H&S の頭の最小突出率（#149）。`.default()` が無いので明示値はそのまま通る。',
		),
	})
	.optional()
	.describe(
		'**解決後の実効パラメータ。入力値ではない。** 時間軸オートとスキーマ既定値の sentinel 置換' +
			'（#182）を適用したあとの値なので、**入力値と一致しないことがある**' +
			'（`swingDepth=7` / `minBarsBetweenSwings=5` / `tolerancePct=0.04` は sentinel。' +
			'`1hour` ではそれぞれ 3 / 2 / 0.05 として実行される）。' +
			'各パラメータの `source` が `explicit` なら渡した値がそのまま効いており、' +
			'`auto` なら時間軸オート表から解決している（`auto` は未指定と既定値の明示指定を畳んだ値）。' +
			'content には「実効パラメータ:」行として全 view に出る。',
	);

const ReductionSchema = z
	.object({
		detected: z.number().int().describe('globalDedup 前の検出件数（全検出器の合計、重複排除前）。'),
		reversalHistoryExcluded: z
			.number()
			.int()
			.optional()
			.describe(
				'反転系で先行トレンド／ネックライン交差を評価する履歴が不足し、窓の先頭60本以内を開始点とするため除外された件数（issue #297 項目1(b)）。',
			),
		dedupMerged: z.number().int().describe('globalDedup で統合されて減った件数。'),
		currentFiltered: z
			.number()
			.int()
			.describe('requireCurrentInPattern（既定 false）で除外された件数。フィルタ無効時は 0。'),
		lifecycleExcluded: z
			.number()
			.int()
			.describe('includeForming / includeCompleted / includeInvalid のライフサイクル絞り込みで除外された件数。'),
		tripleHsExcluded: z
			.number()
			.int()
			.describe(
				'triple × H&S の型間排他（issue #218 Phase 2）で除外された件数。**減るのは triple_* だけ**' +
					'——H&S 系と主構成点（triple は 3 点すべて / H&S は左肩・頭・右肩）を 2 点以上共有する ' +
					'triple を落とす段で、H&S 側は 1 件も落とさない。落とした triple の理由は ' +
					'view=debug の candidates に reason=excluded_by_hs_main_point_overlap として残り、' +
					'details にどの H&S と何点共有したかが入る。' +
					'**0 は 2 通りある**（issue #224 症状 1）: 出力集合に H&S があって比較したが該当が無かった / ' +
					'H&S が出力集合に 1 件も無く比較そのものが起きなかった。区別は `tripleHsCandidateCount` を見る。',
			),
		tripleHsCandidateCount: z
			.number()
			.int()
			.describe(
				'triple × H&S 排他の段で**比較対象になった H&S の件数**（ライフサイクル絞り込み後の出力集合に' +
					'残った H&S 系で、主構成点が取れたもの）。**0 なら `tripleHsExcluded` の 0 は' +
					"「検査して該当なし」ではなく「比較対象が無かった」を意味する**——`patterns: ['triple_bottom']` の" +
					'ように H&S を要求しない呼び出しでは H&S 検出器が走らず、必ずこの状態になる（排他の根拠は' +
					'呼び出し側が実際に受け取る H&S に限る仕様。`tools/patterns/mutual-exclusion.ts` 冒頭）。' +
					'1 以上なら `tripleHsExcluded` は実際に比較した結果。件数の減少ではないので waterfall の等式' +
					'（`detected = reversalHistoryExcluded + dedupMerged + currentFiltered + lifecycleExcluded + tripleHsExcluded + output`）には入らない。' +
					'content の「検出内訳:」行は 0 のときだけ `triple×H&S排他 -0（比較対象 H&S 無し）` と注記する。',
			),
		output: z.number().int().describe('最終的に data.patterns へ残った件数（meta.count と同値）。'),
	})
	.optional()
	.describe(
		'検出結果が縮小する 5 段（反転履歴不足 → globalDedup → requireCurrentInPattern → ライフサイクル絞り込み → ' +
			'triple×H&S 排他）の件数内訳。**入力フィルタの結果を変えるものではなく、既存の縮小を可視化するだけ**。' +
			'content には「検出内訳:」行として summary / detailed / full / debug に出る。',
	);

const PATTERN_INDEX_NOTE =
	'**meta.scan が示すスキャン窓（= 直近 limit 本）を基準とした 0 始まりの位置**。' +
	'analyze_indicators の chart.candles は指標 warmup 分（chart.meta.pastBuffer 本）を先頭に含む' +
	'別配列なので、そちらへ直接添字として使わないこと（使うなら pastBuffer を足す）。' +
	'日時で突き合わせるなら range / date 等の ISO 文字列を使う。';

/** 実装側の `TargetReachOmissionReason`（`tools/patterns/target-reach.ts`）はこの enum から型として導出している。別々に持つと `parse()` が宣言漏れを黙って剥がす。 */
export const TargetProgressOmittedReasonEnum = z.enum([
	'not_broken_out',
	'no_target',
	'breakout_against_expectation',
	'invalid_breakout_price',
	'no_bars_after_breakout',
	'degenerate_target_distance',
	'not_computed_by_detector',
]);

export type TargetProgressOmittedReason = z.infer<typeof TargetProgressOmittedReasonEnum>;

/** 範囲を宣言側に書き切る。判定を変えたとき `parse()` が落ちて気づける。 */
const TargetBreakoutConfounderSchema = z.object({
	// `unknown` は `toBreakoutRef` が `type` を読めなかったときの防御分岐。`PatternTypeEnum` に混ぜず literal で足し、「列挙外の種別」と「読めなかった」を区別する。
	type: z
		.union([PatternTypeEnum, z.literal('unknown')])
		.describe('他パターンの種別。`unknown` は種別を読み取れなかったことの申告。'),
	direction: z.enum(['up', 'down']).describe('他パターンのブレイク方向。'),
	barsAfterBreakout: z
		.number()
		.int()
		.min(1)
		.describe('自分のブレイク足を 0 本目として何本後にそのブレイクがあったか（常に 1 以上）。'),
});

export type TargetBreakoutConfounder = z.infer<typeof TargetBreakoutConfounderSchema>;

export const DetectedPatternSchema = z.object({
	type: PatternTypeEnum,
	confidence: z.number().min(0).max(1),
	_fallback: z
		.string()
		.optional()
		.describe(
			'**strict 経路が拾えず、許容誤差を緩めた relaxed フォールバックが拾い直したパターン**であることを示す。' +
				'**本フィールドが無ければ strict で拾えた**（relaxed は strict がその種別を 1 件も返さなかったときだけ走る）。' +
				'値は `relaxed_<検出器>_<段の係数>` で、どの検出器のどの緩和段が拾ったかが入る: ' +
				'`relaxed_double_x1.3`（単段）/ `relaxed_triple_x1.25` `relaxed_triple_x2`（2 段）/ ' +
				'`relaxed_hs_x1.6_0.6` `relaxed_hs_x2.0_0.4` / `relaxed_ihs_x1.6_0.6` `relaxed_ihs_x2.0_0.4`' +
				'（H&S は肩と頭で別係数を持つため 2 つ並ぶ）。' +
				'**表記は検出器ごとに揃っていない**——triple は数値を文字列化するので 2.0 が `x2` になり、' +
				'H&S は固定文字列のタグなので `x2.0_0.4` のまま `.0` が残る。前方一致（`relaxed_triple_x`）で判別し、' +
				'係数の数値比較に使わないこと。' +
				'**confidence から provenance は推測できない。** relaxed で拾った候補も strict の物差しで採点するので' +
				'緩めた分だけ `levelMargin` が下がるが、一律の割引は掛けておらず、点数だけでは strict と区別できない。' +
				'**content にも出る**（issue #191 B）: summary / detailed / full の `検出経路:` 行が件数と段の内訳を申告し、' +
				'detailed / full ではパターン見出し行の末尾に `[relaxed_triple_x1.25]` として同じ値が付く' +
				'（`view` の説明を参照）。',
		),
	timeframe: CandleTypeEnum.optional(),
	timeframeLabel: z.string().optional(),
	range: z.object({
		start: z
			.string()
			.describe(
				'このパターンの開始足。UTC ISO 文字列。' +
					'表示は呼び出し側 tz（既定 Asia/Tokyo）で整形される（後方互換のため値自体は不変）。',
			),
		end: z
			.string()
			.describe(
				'**このパターンが終わった足**であって、データ末尾でもスキャン窓の末尾でもない。' +
					'最新の range.end がスキャン窓の末尾より古いのは正常——「そこから先が走査されていない」ことを意味しない' +
					'（走査範囲は meta.scan を参照）。' +
					'ブレイク確認足まで含むことがあり、構成点だけで閉じた期間が必要なら structureRange を使う。' +
					'UTC ISO 文字列。表示は呼び出し側 tz（既定 Asia/Tokyo）で整形される（後方互換のため値自体は不変）。',
			),
	}),
	/** 構成点だけで閉じる期間（range はブレイク確認日まで含むことがある）。 */
	structureRange: z
		.object({
			start: z
				.string()
				.describe('UTC ISO 文字列。表示は呼び出し側 tz（既定 Asia/Tokyo）で整形される（後方互換のため値自体は不変）。'),
			end: z
				.string()
				.describe('UTC ISO 文字列。表示は呼び出し側 tz（既定 Asia/Tokyo）で整形される（後方互換のため値自体は不変）。'),
		})
		.optional(),
	confirmation: z
		.union([
			z.object({
				type: z.literal('neckline_breakout'),
				date: z.string(),
				idx: z.number().int().describe(`ブレイクを確認した足の位置。${PATTERN_INDEX_NOTE}`),
				price: z.number(),
			}),
			z.object({ type: z.literal('not_confirmed') }),
		])
		.optional(),
	/** パターン形成直前の lookback window のトレンド（start は窓の先頭、end はパターン構成の開始点）。 */
	precedingTrend: z
		.object({
			start: z
				.string()
				.describe('UTC ISO 文字列。表示は呼び出し側 tz（既定 Asia/Tokyo）で整形される（後方互換のため値自体は不変）。'),
			end: z
				.string()
				.describe('UTC ISO 文字列。表示は呼び出し側 tz（既定 Asia/Tokyo）で整形される（後方互換のため値自体は不変）。'),
			direction: z.enum(['up', 'down', 'sideways', 'insufficient_data']),
			returnPct: z.number(),
			lookbackBars: z.number().int(),
		})
		.optional(),
	pivots: z
		.array(
			z.object({
				idx: z.number().int().describe(PATTERN_INDEX_NOTE),
				price: z
					.number()
					.describe(
						'構成点の価格。**極値判定に使った値ではない**（issue #125）。' +
							'ピボット由来の検出器（double / triple / H&S）はその足の**終値**を入れる' +
							'（ヒゲ 1 本で同水準判定・ネックラインが動くのを避けるため）。' +
							'判定に使った値そのものは `extremePrice` を見ること。',
					),
				kind: z.enum(['H', 'L']).describe('構成点の種別。H = 高値側（山）、L = 安値側（谷）。'),
				extremePrice: z
					.number()
					.describe(
						'極値判定に実際に使った値。kind=H なら `high`、kind=L なら `low`。' +
							'`price` との差がヒゲ分で、これを見れば報告値から判定を検算できる。' +
							'ただし継続系（triangle_* は独自の relaxed swing、wedge_* はトレンドラインへのタッチ点）は ' +
							'`price` が最初から high / low なので `price` と同値になる' +
							'——同値であること自体が「終値を経由していない」という情報。',
					),
			}),
		)
		.optional()
		.describe(
			'パターン構成点の位置と価格。**price（終値）と extremePrice（極値判定に使った高安）は別の値。** ' +
				'**継続系（triangle_* / wedge_*）も出す。** triangle_* は回帰に使った relaxed swing、' +
				'wedge_* は上下トレンドラインの**非ブレイクタッチ点すべて**（issue #252）で、' +
				'どちらも `price` は高安（`extremePrice` と同値）。' +
				'**点数は可変**（wedge_* は窓の長さとタッチの多さで数十点になることがある）で、' +
				'反転系のような役割（山1 / 谷 / …）は無い——位置で意味づけせず `kind` と `idx` だけを使うこと。' +
				'`view=full` の content にも継続系の構成点明細は出ない（役割ラベルが無いため）。' +
				'以下は反転系の話。' +
				'種別混在の構造点リストで、主構成点は位置ではなく `kind` で識別する（triple_top / H&S は H、' +
				'triple_bottom / 逆 H&S は L）。**反転系はネックライン定義点も含む**（H&S は p1 / p3、double は b、' +
				'triple は v1 / v2。並びは H&S `[p0,p1,p2,p3,p4]`、double `[a,b,c]`、triple `[a,v1,b,v2,c]`。' +
				'形成中 triple は 3 点目が現在価格の暫定値なので `[a,v1,b,v2]` の 4 点）。' +
				'triple の水平ネックラインの y は中間側 `kind` の 2 点の `price` の平均で再現できる' +
				'（double は `b.price` そのもの。H&S は傾きを持つので `neckline` を参照）。' +
				'**double 2 型の content に出る「山2 / 谷2 の位置」行はここから導出している**（issue #245）——' +
				'終値の位置は `(c.price − b.price) ÷ パターン高さ`、ヒゲは `|c.extremePrice − c.price| ÷ パターン高さ` で、' +
				'分母は構成点 3 点の `extremePrice` の全振幅。構造化データ側に専用フィールドは足していないので、' +
				'同じ値が要るなら本配列から再計算すること。' +
				`${PATTERN_INDEX_NOTE}`,
		),
	neckline: z
		.array(z.object({ x: z.number().int().optional(), y: z.number() }))
		.length(2)
		.optional(),
	structureDiagram: z
		.object({
			svg: z.string(),
			artifact: z.object({ identifier: z.string(), title: z.string() }),
		})
		.optional(),
	status: z
		.enum(['forming', 'near_completion', 'completed', 'invalid', 'expired'])
		.optional()
		.describe(
			'パターンの状態。' +
				'`forming` = 形成途上（最終構成点がまだ確定しておらず、ネックライン突破の余地がある）。' +
				'**double 2 型は `forming` を出さない**——最終構成点が 1 つしか無く形成中を定義できないため' +
				'（issue #268）。double は `near_completion` から始まり、' +
				'`near_completion` / `completed` / `invalid` / `expired` の 4 段を取る。' +
				'`near_completion` = **構成点は揃い、ネックライン突破を待っている**。' +
				'反転系（double / triple / H&S）はいずれもこの状態を取る' +
				'（double 2 型は issue #262 まで出しておらず、同じ段階を `forming` と呼んでいた）。' +
				'`completed` = ネックライン突破を検出器が確認済み。' +
				'`invalid` = 構成点確定後に形が崩れて無効化された（理由は `invalidReason`）。' +
				'`expired` = **期限切れ**。第2構成点の確定から突破確認窓を過ぎてもネックラインを' +
				'突破しなかったもので、以後この候補が `completed` になることはない。' +
				'`invalid` と同義ではない——形が崩れたのではなく、成立する時間を使い切った状態。' +
				'既定では出力されず、`includeInvalid: true` で `invalid` と一緒に現れる' +
				'（ただし double 2 型の `expired` / `invalid` は**未ブレイクの構造**なので' +
				'`includeForming: true` も要る）。',
		),
	invalidReason: z
		.string()
		.optional()
		.describe(
			'`status` が `invalid` / `expired` になった理由コード。' +
				'`re_entered_trough_zone` = 第2構成点の確定後、ネックライン突破前に価格が' +
				'谷（山）ゾーンへ戻った。' +
				'`peak_after_last_pivot` / `trough_after_last_pivot` = 最終構成点（山2 / 山3 / 右肩）と' +
				'ネックライン突破バーの**間**に同種のピボットがあり、最終構成点から直接ネックラインを' +
				'割っていない（水準は問わない。反転ではなく別の形——レンジ上限への 3 回目のタッチ等）。' +
				'`forming_expired` = 突破確認窓を過ぎた。' +
				'`breakout_against_expectation` = 継続系（triangle / pennant / flag）で期待と逆方向にブレイクした。' +
				'実際の方向は `breakoutDirection`。**期待方向のフィールドは pennant / flag だけが持つ**' +
				'（`expectedBreakoutDirection`。pole の向きから決まるため）——triangle は持たないので、' +
				'`type` から導出する（`triangle_ascending` = `up` / `triangle_descending` = `down`）。',
		),
	/** 構造ゲートを通過した候補どうしの形の良さの比較にだけ使う値で、構造的な妥当性はゲート（hard reject）側が担保している。 */
	scoreComponents: z
		.object({
			levelMargin: z
				.number()
				.optional()
				.describe(
					'主構成点（double は 2 山 / 2 谷、triple は 3 山 / 3 谷、H&S は左右の肩）の同水準度。' +
						'`1 − 主構成点どうしの平均 relDev ÷ strict の許容幅` で、1 = 完全一致、0 = 許容幅ちょうど以上。' +
						'許容幅は strict の判定と同じで、double / triple は `tolerancePct`、H&S は `tolerancePct` と' +
						'時間足別の肩の上限の小さいほう。relaxed 経路でも strict の幅で測るので、緩めた分だけ 0 に寄る。' +
						'**double / triple / H&S 系**',
				),
			headProminence: z
				.number()
				.optional()
				.describe(
					'頭が突出ゲート（`headProminencePct`。relaxed 経路でも strict のゲート）を' +
						'どれだけ上回っているかの余裕。`1 − ゲート ÷ 実測突出率` で、ゲートちょうど = 0、' +
						'突出率がゲートの 2 倍 = 0.5。**H&S 系のみ**',
				),
			timeSymmetry: z
				.number()
				.optional()
				.describe(
					'左肩→頭 と 頭→右肩 のバー数の釣り合い（`min ÷ max`）。1 = 左右が同じ長さ。' +
						'価格ではなく**時間軸**の対称性で、`levelMargin`（肩の水準差）とは別の量。**H&S 系のみ**',
				),
			retracement: z
				.number()
				.optional()
				.describe('中間構成点の戻り率が許容帯の中央にどれだけ近いか。1 = 帯の中央、0 = 帯の端'),
			breakoutQuality: z
				.number()
				.optional()
				.describe(
					'ネックライン突破の質。突破足の終値がネックラインをパターン高さの何割ぶん' +
						'超えたかで測る。形成中パターンには付かない',
				),
			lineFit: z
				.number()
				.optional()
				.describe(
					'上下のトレンドラインの当てはまり。線ごとに `(R² − ゲート) ÷ (1 − ゲート)` を取って平均する' +
						'（ゲートは triangle 0.6、flag / pennant 0.5、wedge 0.55）。2 点しかない線は R² が 1 に張り付くので除く' +
						'（2 点を通す線で引く形成中の wedge には付かない）。**triangle / flag / pennant / wedge**',
				),
			convergence: z
				.number()
				.optional()
				.describe(
					'上下のラインの収束の深さ。`1 − 収束比（終端の幅 ÷ 始端の幅）÷ ゲート` で、ゲートちょうど = 0、' +
						'終端で交わる = 1（ゲートは triangle 0.9、pennant / wedge 0.7。形成中の wedge も strict の 0.7 で測る）。' +
						'**triangle / pennant / wedge**',
				),
			touches: z
				.number()
				.optional()
				.describe(
					'トレンドラインに使った高値・安値の点数。`1 − ゲートの点数 ÷ 点数` で、ゲートちょうど = 0、' +
						'2 倍 = 0.5（ゲートは triangle 4 点、flag / pennant / wedge 6 点。形成中の wedge も strict の 6 点で測る）。' +
						'**triangle / flag / pennant / wedge**',
				),
			slopeSymmetry: z
				.number()
				.optional()
				.describe(
					'上下のラインの傾きの釣り合い。`1 − ||上の傾き| − |下の傾き|| ÷ (|上の傾き| + |下の傾き|)` で、' +
						'1 = 同じ角度。**triangle_symmetrical のみ**',
				),
			flatness: z
				.number()
				.optional()
				.describe(
					'水平側のラインの平らさ。`1 − |窓全体での傾き| ÷ 水平とみなす上限（3%）`。' +
						'**triangle_ascending（上側）/ triangle_descending（下側）のみ**',
				),
			pole: z
				.number()
				.optional()
				.describe(
					'ポール（旗竿）の強さ。`1 − ゲートの ATR 倍率 ÷ 実測の ATR 倍率` で、ゲートちょうど = 0、' +
						'2 倍 = 0.5（ゲートは時間足ごとに 2.0〜3.0）。**flag / pennant**',
				),
			parallelism: z
				.number()
				.optional()
				.describe(
					'保ち合いの幅の一定さ。`(spreadStability − 0.7) ÷ 0.3` で、ゲート（0.7）ちょうど = 0、' +
						'幅が一定 = 1。**flag のみ**',
				),
			alternation: z
				.number()
				.optional()
				.describe(
					'上下のラインへのタッチが交互に並ぶ度合い。`(交互率 − 0.25) ÷ 0.75` で、ゲート（0.25）ちょうど = 0、' +
						'完全に交互 = 1。**wedge のみ**',
				),
			containment: z
				.number()
				.optional()
				.describe(
					'終値が上下のラインの内側（幅の 0.3% までのはみ出しは内側）に収まる足の割合。' +
						'`(割合 − 0.85) ÷ 0.15` で、ゲート（0.85）ちょうど = 0、全部の足が内側 = 1。**wedge のみ**',
				),
		})
		.optional()
		.describe(
			'整合度の内訳。**ゲート通過を前提とした形状の良さ**であって、構造的妥当性の指標ではない' +
				'（構造ゲートは `confidence` に減点として現れず、通らなければそもそも出力されない）。',
		),
	structureGate: z
		.object({
			retracementRatio: z
				.number()
				.optional()
				.describe(
					'先行値幅に対する中間構成点（ネックライン）の戻り率。' +
						'**高安（extremePrice）基準**で算出する——終値基準では許容帯の余裕が薄く、' +
						'ヒゲを含む実際の値幅と乖離するため。1.0 超は定義上そのパターンではない',
				),
			priorExtremeIdx: z
				.number()
				.int()
				.optional()
				.describe(`先行値幅の起点（第1構成点の直前のスイング極値）の位置。${PATTERN_INDEX_NOTE}`),
			priorExtremePrice: z.number().optional().describe('先行値幅の起点の極値（high / low）'),
			necklineCrossIdx: z
				.number()
				.int()
				.optional()
				.describe(
					'第1構成点より前にネックライン水準を**終値で**抜けたバーの位置。' +
						`この事象が無い候補は棄却される。${PATTERN_INDEX_NOTE}`,
				),
			skipped: z
				.enum(['no_prior_extreme', 'insufficient_history'])
				.optional()
				.describe('構造ゲートを適用できず、先行値幅を未評価のまま通過した理由'),
		})
		.optional()
		.describe('構造ゲートが実際に計測した値、または未評価理由。呼び出し側が判定経路を検算できるようにする。'),
	apexDate: z.string().optional(), // アペックス（頂点）到達予定日
	daysToApex: z.number().int().optional(), // アペックスまでの日数
	completionPct: z.number().int().optional(), // 完成度（%）
	breakoutDate: z.string().optional(), // ブレイクアウト日
	breakoutBarIndex: z.number().int().optional().describe(`ブレイクアウトしたローソク足の位置。${PATTERN_INDEX_NOTE}`),
	daysSinceBreakout: z.number().int().optional(), // ブレイクアウトからの経過日数
	breakoutDirection: z.enum(['up', 'down']).optional(), // ブレイク方向
	outcome: z.enum(['success', 'failure']).optional(), // パターン結果（期待通り=success, 逆方向=failure）
	breakoutTarget: z.number().optional(), // 想定ターゲット価格（円）
	targetMethod: z.enum(['flagpole_projection', 'pattern_height', 'neckline_projection']).optional(), // 計算根拠
	targetReachedPct: z
		.number()
		.int()
		.optional()
		.describe(
			`ブレイク価格から breakoutTarget までを 100% としたときの到達度（%）。分子は` +
				`「ブレイク足から ${TARGET_REACH_MAX_BARS} 本以内の extremum（up=最高 high / down=最安 low）」、` +
				`分母は |breakoutTarget − ブレイク価格|。\n` +
				`値域は **0〜99（未到達）または 100〜${TARGET_REACHED_PCT_CAP}（到達済み）**。` +
				`未到達側は floor して 99 でキャップ（99.6% が 100 に丸まって下流の 100 判定を誤らせるのを防ぐ）、` +
				`到達側は round して [100, ${TARGET_REACHED_PCT_CAP}] にクランプする。` +
				`**${TARGET_REACHED_PCT_CAP} ちょうどは「${TARGET_REACHED_PCT_CAP}% 以上」を意味する**（上限で切っている）。\n` +
				`**出ない条件**: (a) ブレイクしていない、(b) breakoutTarget またはパターン高さが出ない、` +
				`(c) 分母がパターン高さの ${MIN_TARGET_DISTANCE_HEIGHT_RATIO * 100}% 未満に潰れている` +
				`（= ブレイク足が既に想定値幅の大半を走り終えていて達成度を測れない）、` +
				`(d) ブレイク足の終値が非有限、(e) ブレイク足以降に走査できる足が無い。` +
				`**(a)〜(e) いずれも targetProgressOmittedReason で申告する**（issue #224 症状 2。` +
				`#210 時点では (c) しか申告しておらず、残りは進捗行ごと無言で消えていた）。\n` +
				`**これは値動きの記述であって成績・予測の指標ではない**（issue #288 Phase 1）。` +
				`100 を超える値は「進捗」ではなく**目標幅に対する到達幅の倍率**で、到達した後の値動きを含む` +
				`（分子が走査窓の extremum なので、届いた後も伸びれば増える）。**到達率としても読まない**——` +
				`実データではどの窓幅（5〜60 本）でもパターン起点の到達率が帰無を上回っておらず、` +
				`走査窓に他パターンのブレイクが入る実体が 94.7% ある。` +
				`「いつ届いたか」は targetFirstReachBars / targetFirstReachDate を見ること。`,
		),
	// 最終 close ベースだと一度到達してから戻したケースを未到達扱いするので、extremum（up=最高 high / down=最安 low）で評価する。
	targetReached: z
		.boolean()
		.optional()
		.describe(
			`ブレイク足から **${TARGET_REACH_MAX_BARS} 本以内**に breakoutTarget へ到達したか。` +
				`「いつか到達した」ではない——走査を系列末尾まで伸ばすと同じ構造でも問い合わせ時点で値が` +
				`変わるため、窓を固定してある（issue #210）。ブレイクから ${TARGET_REACH_MAX_BARS} 本ぶんの足が` +
				`まだ無い場合は、その時点までで判定した暫定値（targetScanComplete が false）。` +
				`出ない条件は targetReachedPct と同じ。\n` +
				`**成績・予測の指標として読まないこと**（issue #288 Phase 1。到達率はどの窓幅でも帰無を上回らない）。` +
				`到達の帰属を切る他パターンのブレイクは targetOtherBreakoutBeforeReach を見ること。`,
		),
	targetReachedDate: z
		.string()
		.optional()
		.describe(`走査窓（ブレイク足から ${TARGET_REACH_MAX_BARS} 本以内）の extremum が付いた足の時刻（UTC ISO）。`),
	targetReachedPrice: z
		.number()
		.optional()
		.describe(`走査窓（ブレイク足から ${TARGET_REACH_MAX_BARS} 本以内）の extremum（up=最高 high / down=最安 low）。`),
	targetFirstReachBars: z
		.number()
		.int()
		.min(0)
		.max(TARGET_REACH_MAX_BARS)
		.optional()
		.describe(
			`**初めて breakoutTarget に届いた足**が、ブレイク足を 0 本目として何本目か` +
				`（ブレイク足自身の high / low が既に target を越えていれば 0）。
` +
				`**targetReachedDate / targetReachedPrice とは別の足を指す**——あちらは走査窓の extremum` +
				`（＝どこまで走ったか）で、届いた後にさらに伸びれば後ろの足へ動く。
` +
				`**未到達なら出さない。** 到達率・予測の指標として読まないこと` +
				`（実データでは帰属を帰無と区別できていない。issue #288 Phase 1）。`,
		),
	targetFirstReachDate: z
		.string()
		.optional()
		.describe(`targetFirstReachBars が指す足の時刻（UTC ISO）。未到達なら出さない。`),
	targetScanBars: z
		.number()
		.int()
		.min(0)
		.max(TARGET_REACH_MAX_BARS)
		.optional()
		.describe(
			`到達判定で**実際に走査した本数**（ブレイク足を 0 本目とした後続の本数）。` +
				`min(${TARGET_REACH_MAX_BARS}, 系列末尾までの本数) で、上限まで走れたときちょうど ` +
				`${TARGET_REACH_MAX_BARS}。
` +
				`**未到達がこの値より手前で打ち切られていないかを呼び出し側が検算できるようにするための値。**` +
				`${TARGET_REACH_MAX_BARS} 未満なら「届かなかった」ではなく「まだ足が無い」。`,
		),
	targetScanComplete: z
		.boolean()
		.optional()
		.describe(
			`targetScanBars === ${TARGET_REACH_MAX_BARS}。走査窓ぶんの足が揃っている（＝この先の足が` +
				`増えても targetReached / targetReachedPct が動かない）かどうか。`,
		),
	targetOtherBreakoutBeforeReach: TargetBreakoutConfounderSchema.array()
		.optional()
		.describe(
			`**到達したパターンにだけ付く。** 自分のブレイクと自分の初到達の**間**（開区間）に、` +
				`同じ結果集合の他パターンのブレイクがあったもの。**方向は問わない**——同方向の後続パターン` +
				`経由でも「このパターンだから届いた」とは言えなくなるため（Phase 1 の予備監査で 20 本超の` +
				`到達 6 件のうち 4 件が同方向）。
` +
				`**空なら出さない。** 出ていないことは「自力で届いた」の証明ではなく、` +
				`accepted 集合の中に該当が無かったという意味。\n` +
				`**patterns（種別フィルタ）で絞ると基準集合も絞られる**——絞った呼び出しでは他種別の` +
				`ブレイクがそもそも検出されていないので数えられない。includeInvalid は基準集合を動かさない。`,
		),
	targetOppositeBreakoutInWindow: TargetBreakoutConfounderSchema.array()
		.optional()
		.describe(
			`**未到達のパターンにだけ付く。** 走査窓（自分のブレイクの次の足から targetScanBars 本目まで）に` +
				`**方向が逆**の他パターンのブレイクがあったもの。同方向まで含めると実体の 94.7% に付いて` +
				`申告にならないので逆方向に限っている。
` +
				`**「逆方向へ行ったから届かなかった」とは言っていない**——順序は測っていない。` +
				`言えるのは「同じ走査窓の中で反対向きの構造も成立していた」まで。空なら出さない。`,
		),
	targetProgressOmittedReason: TargetProgressOmittedReasonEnum.optional().describe(
		`target 進捗系フィールド（targetReached / targetReachedPct / targetReachedDate / targetReachedPrice）を` +
			`**出さなかった**ことの申告。**breakoutTarget 自体は出ることがある**（進捗だけが測れない）ので、` +
			`「進捗 0%」と「測っていない」を取り違えないための唯一の手がかりになる。\n` +
			`**再問い合わせで答えが変わりうるかは 3 通りある。**\n` +
			`  (i) 足が増えれば測れるようになりうる（暫定）: 'not_broken_out' / 'no_bars_after_breakout'\n` +
			`  (ii) その構造では変わらない（確定）: 'no_target' / 'breakout_against_expectation' / 'invalid_breakout_price' / 'degenerate_target_distance'\n` +
			`  (iii) 実装ギャップ。再問い合わせでは変わらないが将来のリリースで消える: 'not_computed_by_detector'\n` +
			`- 'not_broken_out' = ブレイクが確定していない（status が near_completion / forming、` +
			`またはブレイク足を特定できない）。**最も多い経路。** (i)——後の足でネックラインを抜ければ進捗が出る。\n` +
			`- 'no_target' = ターゲット価格またはパターン高さを算出できない（ネックライン投影が解けない等）。(ii)\n` +
			`- 'breakout_against_expectation' = パターンが期待方向と逆にブレイクし、標準ターゲットを適用しない。(ii)\n` +
			`- 'invalid_breakout_price' = ブレイク足の終値が非有限（欠損足など）。(ii)——その足は後から直らない。\n` +
			`- 'no_bars_after_breakout' = ブレイク足以降に走査できるローソク足が無い。(i)\n` +
			`- 'degenerate_target_distance' = |breakoutTarget − ブレイク価格| がパターン高さの ` +
			`${MIN_TARGET_DISTANCE_HEIGHT_RATIO * 100}% 未満で進捗率の分母が潰れている。` +
			`ネックラインから投影する H&S / doubles で、ブレイク足がネックラインから値幅ぶん` +
			`走り切っているときに起きる（issue #210 (2)）。(ii)——分母はブレイク価格と target だけで決まるので` +
			`足が増えても変わらない。\n` +
			`- 'not_computed_by_detector' = **構造の性質ではなく検出器の未配線。** ` +
			`**現在このコードを返す経路は無い**（issue #228 で detect_triples.ts の完成済み 4 経路` +
			`（strict / relaxed × top / bottom）に computeTargetReach を配線したため）。` +
			`値は enum に残してあるが、これは公開スキーマの出力フィールドで、値の削除は外部クライアントへの` +
			`破壊的変更になるため（#228）。同じ実装ギャップが別の検出器で見つかったときの受け皿として使う。(iii)`,
	),
	trendlineLabel: z.string().optional(),
	poleDirection: z.enum(['up', 'down']).optional(), // フラッグポールの方向
	priorTrendDirection: z.enum(['bullish', 'bearish']).optional(), // 先行トレンド方向
	isTrendContinuation: z.boolean().optional(), // ブレイク方向が先行トレンドと一致しているか
	flagpoleHeight: z.number().optional(), // フラッグポールの値幅
	retracementRatio: z.number().optional(), // フラッグポールに対する戻し比率（0.38未満ならペナント的）
	poleStartDate: z.string().optional(), // pole 開始日（UTC ISO）
	poleEndDate: z.string().optional(), // pole 終了日（UTC ISO）
	poleChangePct: z.number().optional(), // pole の価格変化率（0.15 = +15%）
	poleBars: z.number().int().optional(), // pole のバー数
	poleATRMult: z.number().optional(), // pole の magnitude / 局所 ATR
	flagUpperSlope: z.number().optional(), // チャネル上限ラインの傾き（価格/バー）
	flagLowerSlope: z.number().optional(), // チャネル下限ラインの傾き（価格/バー）
	spreadAvg: z.number().optional(), // チャネル幅の平均
	spreadStability: z.number().optional(), // チャネル幅の安定性（0-1, 1=完全に平行）
	expectedBreakoutDirection: z.enum(['up', 'down']).optional(), // 期待されるブレイク方向（pole 方向と同じ）
	aftermath: z
		.object({
			breakoutDate: z.string().nullable().optional(),
			breakoutConfirmed: z.boolean(),
			priceMove: z
				.object({
					days3: z.object({ return: z.number(), high: z.number(), low: z.number() }).nullable().optional(),
					days7: z.object({ return: z.number(), high: z.number(), low: z.number() }).nullable().optional(),
					days14: z.object({ return: z.number(), high: z.number(), low: z.number() }).nullable().optional(),
				})
				.optional(),
			targetReached: z.boolean(),
			theoreticalTarget: z.number().nullable().optional(),
			outcome: z.string(),
			daysToTarget: z.number().int().nullable().optional(),
		})
		.optional(),
});

export const DetectPatternsOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		data: z.object({
			patterns: z.array(DetectedPatternSchema),
			overlays: z
				.object({
					ranges: z
						.array(
							z.object({
								start: z.string(),
								end: z.string(),
								color: z.string().optional(),
								label: z.string().optional(),
							}),
						)
						.optional(),
					annotations: z.array(z.object({ isoTime: z.string(), text: z.string() })).optional(),
				})
				.optional(),
			warnings: z
				.array(
					z.object({
						type: z.string(),
						message: z.string(),
						suggestedParams: z.record(z.string(), z.any()).optional(),
					}),
				)
				.optional()
				.describe(
					'本ツール自身の検出層 warning（上流の meta.warning / meta.warnings とは別系統）。\n' +
						'- `limit_too_small_for_timeframe`: スキャン窓が時間足の swingDepth に対して狭すぎ、' +
						'構造上パターンを張れない。**この type だけは content 先頭にも警告行として出る**。\n' +
						'- `low_detection_count`: 検出数が 1 件以下。content には出ない（structuredContent のみ）。',
				),
			statistics: z
				.record(
					z.string(),
					z.object({
						detected: z.number().int(),
						withAftermath: z.number().int(),
						successRate: z.number().nullable(),
						avgReturn7d: z.number().nullable(),
						avgReturn14d: z.number().nullable(),
						medianReturn7d: z.number().nullable(),
					}),
				)
				.optional(),
		}),
		meta: z.object({
			pair: z.string(),
			type: CandleTypeEnum,
			count: z.number().int(),
			scan: z
				.object({
					start: z.string().describe('スキャンした先頭足の UTC ISO 文字列。'),
					end: z.string().describe('スキャンした末尾足の UTC ISO 文字列。'),
					bars: z.number().int().describe('検出器に渡した足の本数。'),
					anchorDate: z.string().optional().describe('入力 date による終端アンカー。省略時は現在時刻基準。'),
				})
				.optional()
				.describe(
					'検出器に実際に渡した足のレンジ。入力 limit（要求本数）でも ' +
						'data.patterns の range 分布でもなく、**スキャン窓そのもの**。' +
						'機械クライアントが「どこまで見たか」を検証できるようにするためのフィールドで、' +
						'content には「スキャン範囲」行として出る。isoTime が欠けている足しか無い場合は省略される。',
				),
			effective_params: EffectiveParamsSchema,
			visualization_hints: z
				.object({
					preferred_style: z.enum(['candles', 'line']).optional(),
					highlight_patterns: z.array(PatternTypeEnum).optional(),
				})
				.optional(),
			debug: z
				.object({
					swings: z
						.array(
							z.object({
								idx: z.number().int().describe(PATTERN_INDEX_NOTE),
								price: z.number(),
								kind: z.enum(['H', 'L']),
								isoTime: z.string().optional(),
							}),
						)
						.optional(),
					candidates: z
						.array(
							z.object({
								type: PatternCandidateTypeEnum,
								accepted: z.boolean(),
								reason: z.string().optional(),
								status: z.string().optional(),
								// `PatternEntry.breakoutDirection` は成立したパターンの確定値で enum だが、こちらは候補時点の観測値（未ブレイクで null）なので揃えて enum にしない。
								breakoutDirection: z.string().nullish(),
								indices: z.array(z.number().int()).optional().describe(PATTERN_INDEX_NOTE),
								points: z
									.array(
										z.object({
											role: z.string(),
											idx: z.number().int().describe(PATTERN_INDEX_NOTE),
											price: z.number(),
											isoTime: z.string().optional(),
										}),
									)
									.optional(),
								details: z.any().optional(),
							}),
						)
						.optional(),
					candidatesTotal: z
						.number()
						.int()
						.optional()
						.describe(
							'トリム前の候補総数。**入力 `patterns` による絞り込み（#124）の後**の件数で、' +
								'走査中に積まれた全種別の候補数ではない。`candidates.length` と等しければ全件、' +
								'大きければ `candidatesOmitted` 件が cap で押し出されている。',
						),
					candidatesOmitted: z
						.number()
						.int()
						.optional()
						.describe(
							'cap で `candidates` から押し出された件数（`candidatesTotal - candidates.length`）。\n' +
								'トリムは `[...accepted, ...rejected]` を先頭から cap 件残すので、' +
								'**押し出しは棄却理由（`accepted: false`）から始まる**。\n' +
								'**「押し出されたのは全部棄却理由」と言い切れるのは `candidates` に `accepted: false` が' +
								'1 件でも残っている場合**（残っていれば accepted は全件収まったことが確定する）。' +
								'返った 200 件が全件 `accepted: true` のときは accepted 自体が cap を超えており、' +
								'押し出しに accepted も含まれうる。\n' +
								'いずれにせよ理由コードの内訳を集計するなら 0 であることを確認するか、' +
								'`patterns` で種別を絞って呼び直すこと。',
						),
					swingsTotal: z.number().int().optional().describe('トリム前のスイング総数。'),
					swingsOmitted: z
						.number()
						.int()
						.optional()
						.describe(
							'cap で `swings` から落ちた件数。**`swings` は先頭から cap 件を残す**ので、' +
								'0 より大きいとき落ちているのは**新しいほうのスイング**（＝直近）。' +
								'`candidates` と違って優先順の設計が入っていない（issue #180 で申告のみ実施）。',
						),
				})
				.optional(),
			reduction: ReductionSchema,
			...warningField,
			...warningsField,
		}),
	}),
	FailResultSchema,
]);

export const CandlePatternTypeEnum = z.enum([
	'bullish_engulfing',
	'bearish_engulfing',
	'bullish_harami',
	'bearish_harami',
	'tweezer_top',
	'tweezer_bottom',
	'dark_cloud_cover',
	'piercing_line',
	'hammer',
	'shooting_star',
	'doji',
	'morning_star',
	'evening_star',
	'three_white_soldiers',
	'three_black_crows',
]);

export const AnalyzeCandlePatternsInputSchema = z.object({
	pair: z.string().optional().default('btc_jpy'),
	timeframe: z.literal('1day').optional().default('1day'),
	as_of: z
		.string()
		.optional()
		.describe('Date to analyze (ISO "2025-11-05" or YYYYMMDD "20251105"). If omitted, uses latest data.'),
	// date: 互換性のため残す（as_of が優先）
	date: z
		.string()
		.regex(/^\d{8}$/)
		.optional()
		.describe('DEPRECATED: Use as_of instead. YYYYMMDD format.'),
	window_days: z.number().int().min(3).max(10).optional().default(5),
	focus_last_n: z.number().int().min(2).max(5).optional().default(5),
	patterns: z
		.array(CandlePatternTypeEnum)
		.optional()
		.describe('Patterns to detect. If omitted, all patterns are checked.'),
	history_lookback_days: z.number().int().min(30).max(365).optional().default(180),
	history_horizons: z.array(z.number().int().min(1).max(10)).optional().default([1, 3, 5]),
	allow_partial_patterns: z.boolean().optional().default(true),
});

const HistoryHorizonStatsSchema = z.object({
	avg_return: z.number(),
	win_rate: z.number(),
	sample: z.number().int(),
});

const HistoryStatsSchema = z.object({
	lookback_days: z.number().int(),
	occurrences: z.number().int(),
	horizons: z.record(z.string(), HistoryHorizonStatsSchema),
});

const LocalContextSchema = z.object({
	trend_before: z.enum(['up', 'down', 'neutral']),
	volatility_level: z.enum(['low', 'medium', 'high']),
});

const DetectedCandlePatternSchema = z.object({
	pattern: CandlePatternTypeEnum,
	pattern_jp: z.string(),
	direction: z.enum(['bullish', 'bearish', 'neutral']),
	strength: z.number().min(0).max(1),
	candle_range_index: z.tuple([z.number().int(), z.number().int()]),
	uses_partial_candle: z.boolean(),
	status: z.enum(['confirmed', 'forming']),
	local_context: LocalContextSchema,
	history_stats: HistoryStatsSchema.nullable(),
});

const WindowCandleSchema = z.object({
	timestamp: z.string(),
	open: z.number(),
	high: z.number(),
	low: z.number(),
	close: z.number(),
	volume: z.number(),
	is_partial: z.boolean(),
});

export const AnalyzeCandlePatternsDataSchemaOut = z.object({
	pair: z.string(),
	timeframe: z.string(),
	snapshot_time: z.string(),
	window: z.object({
		from: z.string(),
		to: z.string(),
		candles: z
			.array(WindowCandleSchema)
			.describe(
				'CRITICAL: Array order is [oldest, ..., newest]. index 0 = most distant, index n-1 = latest (possibly partial).',
			),
	}),
	recent_patterns: z.array(DetectedCandlePatternSchema),
	summary: z.string(),
});

export const AnalyzeCandlePatternsMetaSchemaOut = BaseMetaSchema.extend({
	timeframe: z.string(),
	as_of: z.string().nullable().describe('Original input value (ISO or YYYYMMDD)'),
	date: z.string().nullable().describe('YYYYMMDD normalized, null for latest'),
	window_days: z.number().int(),
	patterns_checked: z.array(CandlePatternTypeEnum),
	history_lookback_days: z.number().int(),
	history_horizons: z.array(z.number().int()),
	...warningField,
});

export const AnalyzeCandlePatternsOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		content: z.array(z.object({ type: z.literal('text'), text: z.string() })).optional(),
		data: AnalyzeCandlePatternsDataSchemaOut,
		meta: AnalyzeCandlePatternsMetaSchemaOut,
	}),
	FailResultSchema,
]);

const DiagramCandleSchema = z.object({
	date: z.string().describe('Display date e.g. "11/6(木)"'),
	open: z.number(),
	high: z.number(),
	low: z.number(),
	close: z.number(),
	type: z.enum(['bullish', 'bearish']),
	isPartial: z.boolean().optional(),
});

const DiagramPatternSchema = z.object({
	name: z.string().describe('Pattern name in Japanese e.g. "陽線包み線"'),
	nameEn: z.string().optional().describe('Pattern name in English e.g. "bullish_engulfing"'),
	confirmedDate: z.string().describe('Confirmed date e.g. "11/9(日)"'),
	involvedIndices: z.tuple([z.number().int().min(0), z.number().int().min(0)]).describe('[prevIndex, confirmedIndex]'),
	direction: z.enum(['bullish', 'bearish']).optional(),
});

export const RenderCandlePatternDiagramInputSchema = z.object({
	candles: z.array(DiagramCandleSchema).min(2).max(10).describe('Candle data array (oldest first)'),
	pattern: DiagramPatternSchema.optional().describe('Pattern to highlight'),
	title: z.string().optional().describe('Chart title (default: pattern name or "ローソク足チャート")'),
	theme: z.enum(['dark', 'light']).optional().default('dark'),
});

export const RenderCandlePatternDiagramDataSchemaOut = z.object({
	svg: z.string().optional(),
	filePath: z.string().optional(),
	url: z.string().optional(),
});

export const RenderCandlePatternDiagramMetaSchemaOut = z.object({
	width: z.number().int(),
	height: z.number().int(),
	candleCount: z.number().int(),
	patternName: z.string().nullable(),
});

export const RenderCandlePatternDiagramOutputSchema = toolResultSchema(
	RenderCandlePatternDiagramDataSchemaOut,
	RenderCandlePatternDiagramMetaSchemaOut,
);
