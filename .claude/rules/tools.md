---
globs: tools/**/*.ts, src/handlers/**/*.ts, src/tool-registry.ts, src/private/**/*.ts
---

# MCP ツール追加・修正

ツールは `toolDef` エクスポート → `src/tool-registry.ts` が集約 → `src/server.ts` が自動登録。
**server.ts を直接編集する必要はない。**

> 手数料を扱うツールは `.claude/rules/fees.md`（A/B 見積り=`lib/fees.ts` 経由必須、C=パススルー）に従う。

## content テキストにデータを含める（重要）

LLM は `structuredContent` を参照できない。`content[0].text` だけが LLM に見える。
`ok(summary, data, meta)` をそのまま返すと `toToolResult`（`src/server.ts`）が `summary` 一行だけを `content` に入れるため、LLM はデータを一切受け取れずハルシネーションを起こす。

**対策**: handler で `content` テキストにデータを明示的に含める。

```ts
// NG: LLM には summary しか見えない
handler: async (args) => myTool(args),

// OK: content にデータを含める（get_candles, prepare_chart_data 等と同じパターン）
handler: async (args) => {
  const result = await myTool(args);
  if (!result.ok) return result;
  const text = `${result.summary}\n${JSON.stringify(result.data, null, 2)}`;
  return {
    content: [{ type: 'text', text }],
    structuredContent: result as unknown as Record<string, unknown>,
  };
},
```

新規ツール作成・既存ツール修正時は、LLM が受け取る `content` テキストに十分な情報が含まれているか必ず確認する。

## 上流 warning の伝播（加工ツール）

`get_candles` → `analyze_indicators` → `prepare_chart_data` のように上流ツールの結果を加工する
ツールでは、上流 `meta.warning` / `meta.warnings` を必ず content / summary 先頭に連結する。
これを落とすと LLM がデータ不完全性に気づけずハルシネーションを起こす。

実装は **`lib/warning-propagation.ts`**（`prependWarnings`, `extractUpstreamWarning`, `collectUpstreamWarnings`）を使う。
横展開の確認は `tests/warning-propagation.test.ts` および加工ツールの handler テストを参照。

- **`meta.warning`（string）**: 取得層の不完全性（partial fetch / multi-day 失敗 等）。
- **`meta.warnings`（string[]）**: 計算層の不完全性（指標バー数不足 等）。
- 2 系統は混ぜず、別フィールドかつ別行で出す。

```ts
import { extractUpstreamWarning, prependWarnings } from '../lib/warning-propagation.js';

const upstream = extractUpstreamWarning(res.meta);
const summary = prependWarnings(baseSummary, upstream, { separator: '\n' });
```

### キャッシュ層を持つツールの注意

`analyze_indicators` のように結果をキャッシュするツールは、**上流 warning も cache entry に保存する。**
落とすと 2 回目以降のキャッシュヒットで warning が消える（partial fetch 状態を引きずる）。

### handler 側のチェックリスト

- [ ] `handler` で `res.summary` を差し替える場合、default view でも LLM 必須フィールド
      （window / 期間 / warning / warnings）を落とさない。
- [ ] `content[0].text` の先頭に warning 行が含まれているか目視確認。
- [ ] `JSON.stringify(data)` を含める場合は **JSON より前** に warning 行を出す。
- [ ] 加工ツールの場合、`format=json` 等の代替ビューでも warning 行が消えないようにする。

## `view` の規約（新規ツール・既存ツールとも）

`view` は**ツールを跨いで語彙を統一してある**（`docs/internal/view-vocabulary-unification.md` §3-2 / §3-3）。
`view` を持つツールを追加・修正するときは以下を守る。description の共通文言は
**`src/schema/base.ts`**（`VIEW_CONTRACT_NOTE` / `FORMAT_PARAM_NOTE` / `deprecatedViewNote()`）を使い、
ツールごとに書き起こさない。

### 1. `view` は「量」の 1 軸。`full` は常に最重量

- 階梯は `summary` < `detailed` < `full` で、**`full` はそのツールの最重量**。例外を作らない。
- 中間の段は省略してよい（`get_candles` は `full` のみ）。**順序を飛び越えた意味づけは禁止。**
- 「`full` = 全件列挙」は**主対象がレコード列のツールに限る**。主対象がスカラー値のツール
  （`get_volatility_metrics`）では `full` が全件列挙にならないが、最重量である限り規約違反ではない。
- 同じ語の意味はツールを跨いで一定にする。`summary` を「全件列挙」の意味で使わない。

### 2. `view` は `structuredContent` からフィールドを削らない

削っても LLM のトークンは 1 つも減らない（LLM は `structuredContent` を見ていない）ので、
**削る動機がそもそも無い。** 削るのは非 LLM クライアントの契約を壊すだけ。
フィールドは 3 分類で扱う:

| 分類 | 例 | 可否 |
|---|---|---|
| **削る** | `view=summary` で `data.series.buckets` を落とす | **禁止**。どうしても必要ならスキーマを optional 化し `meta.omitted: ['series.buckets']` で申告する |
| **足す** | `detect_patterns(debug)` の `data.candidates`、`detect_macd_cross(detailed)` の `data.resultsDetailed` | **許容**（階梯上か階梯外かを問わない）。**何を足すかを当該 view の description に書く** |
| **入力のエコー** | `detect_macd_cross` の `meta.view` | **許容**。値が view ごとに変わってよい（規約テストでは比較対象から除外し、理由をテスト内に明記する） |

「足す」を許容するのは、削る＝既存消費者が壊れる / 足す＝壊れない、という非対称性による。
**エコーを口実にデータを差し替えない**——入力値そのものを返すだけでなくなった時点で、
そのフィールドは *削る* か *足す* のどちらかに分類される。

### 3. 階梯上の view は下位 view の上位集合

`detailed` の `content` は `summary` の内容を含み、`full` は `detailed` を含む。
**フッタ・警告行・最終値のような定型情報を上位 view で落とさない。**
上流の `res.summary` を捨ててテキストを組み直すと、ここが黙って壊れる（実際に壊れていた）。

この規約は**階梯上の値にのみ適用する。** 階梯外の値（`detect_patterns` の `debug`、
`get_volatility_metrics` の `beginner`）は定義上「出力の置換」なので上位集合である必要はない。

### 4. 量以外の軸を `view` の値に混ぜない

| 軸 | 表現 | 例 |
|---|---|---|
| 量 | `view` | `summary` / `detailed` / `full` |
| 形式 | 別パラメータ | `format: 'text' \| 'json'` |
| 絞り込み | 別パラメータ | `nonZeroOnly: boolean` |
| 置換 | `view` の階梯外の値 | `debug` / `beginner` |

**置換だけは `view` の値、それ以外の直交軸は別パラメータ**にする。置換をブール値
（`debug: true`）に切り出すと「`view=full` + `debug=true`」が追加なのか置換なのか曖昧になるため。

### 5. 「この view では〇〇が content に出ない」を description に書く

`content[0].text` が LLM への唯一のチャネルなので、軽い view は「短い表示」ではなく
**「LLM が明細を受け取らない」**を意味する。各 view の説明に何が出ないかを明記して、
呼び出し側が選択の結果を予測できるようにする。

### 6. 規約はテストで機械的に固定する

人手のレビューに委ねない。既存の共通テストに新しいツールを追加する:

- `tests/view-structured-content-invariance.test.ts` — 規約 2（`structuredContent` の非削除）
- `tests/view-content-superset.test.ts` — 規約 3（上位集合）。**文字列長の比較は使わない**
  （フッタが消えても明細が増えれば通ってしまう）。定型要素とレコードキーの集合包含で検証する
- `tests/prompts_contract.test.ts` — プロンプトが指示する `view` が enum に存在すること

### 7. enum 値を変える場合

外部クライアントに公開されている契約なので、**改名は alias 猶予期間を置く**
（`deprecatedViewNote()` で写像先と削除目標バージョン `DEPRECATED_VIEW_REMOVAL_TARGET` を明記）。
**同じ語の意味を差し替える変更は alias では救えない**——旧値を送り続けたクライアントに黙って別の
応答が返る。一度 enum から削除して validation error を経由させ、別リリースで再導入する。

**ハンドラ引数の `view` / `format` の型はリテラルを手書きせず Zod スキーマから導出する**
（`z.infer<typeof XxxInputSchema>['view']`）。手書きだと enum から値を消しても型が変わらず、
alias 分岐が黙って生き残る。導出しておけば typecheck が `TS2367` で必ず落とす。

## Public ツール

認証不要。誰でも利用可能。

### 新規追加

1. `tools/<name>.ts` に `export const toolDef: ToolDefinition = { name, description, inputSchema, handler }`
   - ハンドラが100行超なら `src/handlers/<name>Handler.ts` に分離
2. `src/tool-registry.ts` の `allToolDefs` 配列に追加
3. `npm run gen:types && npm run typecheck`

### 既存修正

`tools/<name>.ts` か `src/handlers/<name>Handler.ts` の `toolDef` を編集するだけ。

## Private ツール

bitbank API キー（`BITBANK_API_KEY` + `BITBANK_API_SECRET`）が設定されている場合のみ有効化される。

### 仕組み

- `src/private/config.ts` の `isPrivateApiEnabled()` で環境変数の有無を判定
- `src/tool-registry.ts` が条件付きで `tools/private/*.ts` を動的 import し `allToolDefs` に追加
- キー未設定時はスキップされ、ログに `Private API tools disabled` と記録される

### 新規追加

1. `tools/private/<name>.ts` に `export const toolDef` を定義
   - ハンドラが100行超なら `src/handlers/<name>Handler.ts` に分離
   - HTTP 呼び出しは `src/private/client.ts` の `BitbankPrivateClient` を使う
2. 入出力スキーマは `src/private/schemas.ts` に追加
3. `src/tool-registry.ts` の `isPrivateApiEnabled()` ブロック内で動的 import → `allToolDefs.push`
4. `npm run gen:types && npm run typecheck`

### 既存修正

`tools/private/<name>.ts` か `src/handlers/<name>Handler.ts` の `toolDef` を編集するだけ。
