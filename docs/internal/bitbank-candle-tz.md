# bitbank `/candlestick` の暦日仕様（実測ログ）

`tools/get_candles.ts` の `date` / `tz` パラメータが bitbank Public API の candlestick キーとどう対応するかを、**実 API 実測** と **現行実装** で固定する。

## 結論（断定）

### bitbank API 側（fetch キー）

1. **`/candlestick/1hour/<YYYYMMDD>` のグルーピング基準は UTC 暦日。**
   `20251002` で返る 24 本は `1759363200000` (= 2025-10-02T00:00:00Z) から `1759446000000` (= 2025-10-02T23:00:00Z) まで。JST 基準（先頭が `1759330800000` = 2025-10-01T15:00:00Z）ではない。
2. **`/candlestick/1day/<YYYY>` の各 daily candle の timestamp は UTC 00:00。**
   `2025` の先頭バーは `1735689600000` (= 2025-01-01T00:00:00Z, JST 2025-01-01T09:00)、末尾は `1767139200000` (= 2025-12-31T00:00:00Z)。1 年 = 365 本（UTC 暦年）。
3. **取引開始前 / 未来日付は HTTP 404 + `success: 0` + `data.code: 10000`。** 空配列ではなくエラー応答。
4. **進行中の UTC 日は HTTP 200 + 部分データをリアルタイム返却する**（2026-07-07 23:42 UTC 実測:
   `/1hour/20260707` が形成中の 23:00Z 足まで 24 本返却）。当日データの取得は正当なユースケース。
5. **UTC 日の開始直後は HTTP 200 + `success: 0` (code: 10000) になる時間帯がある**（2026-07-08 実測:
   00:04 UTC は success:0、00:12 UTC には success:1 + 1 本目返却）。`get_candles` はこれを
   「進行中 UTC 期間のデータ未生成」として過半数失敗の分母分子から除外し ℹ️ 注記で許容する
   （`partitionFailedChunks`）。

### `get_candles` 側（ユーザー向け `date` / `tz`）

4. **`get_candles.date` はユーザー向けに `tz` の暦日として解釈する（既定 `Asia/Tokyo`）。**
   - `date=YYYYMMDD` → その tz における暦日の終端 `23:59:59.999` を anchor とし、それ以前の `limit` 本を返す。
   - `tz=UTC` を明示すれば UTC 暦日として同じルールが適用される。
5. **実装は「UTC API key を必要範囲だけ fetch → tz 暦日終端 anchor で filter → limit 本を返す」二段構え。**
   - サブ日次（`1min`〜`1hour`）: tz 暦日が UTC 2 日にまたがるため、隣接 UTC 日キー（例: `/20251001` + `/20251002`）を fetch し、anchor 以前に絞る。
   - 年 chunk（`4hour`〜`1month` 等）: tz 暦 window と交差する **UTC 年** key（例: `2025` + `2026`）を fetch。`date=2025` だけでは UTC `2026` chunk が取れず tz 年末が欠ける問題を防ぐ。
   - `isoTime` は常に UTC ISO のまま。`isoTimeLocal` / summary / keyPoints / 表示日付は `tz` に揃える。
6. **例: `tz=Asia/Tokyo`, `date=20251002`, `type=1hour`, `limit=24`**
   - anchor: JST 2025-10-02 23:59:59.999（= UTC 2025-10-02T14:59:59.999Z）
   - 返却 24 本: JST 10/2 00:00〜23:00（UTC 10/1 15:00〜10/2 14:00）
7. **`1day` + `YYYY` の日足は厳密な JST 集約日足ではない。**
   bitbank API の daily candle timestamp が UTC 00:00 固定のため、「UTC 日足を tz で表示している」に留まる。JST 暦年の 1/1 始まりの日足ではない。

## 計測条件

| 項目 | 値 |
|---|---|
| 取得日 | 2026-05-22 (JST) |
| ベースコミット | `d5b1fff` (origin/main, "Merge pull request #547") |
| ペア | `btc_jpy` |
| 認証 | なし（パブリック API） |
| 実行環境 | macOS ローカル `curl` 7.x + `jq` |

サンドボックスからは `public.bitbank.cc` がネットワーク allowlist 外のためアクセス不可。ローカル端末で逐次実行（各リクエスト間 `sleep 1`）した結果を以下に転記する。

## 実行コマンド

```bash
for url in \
  "https://public.bitbank.cc/btc_jpy/candlestick/1hour/20251002" \
  "https://public.bitbank.cc/btc_jpy/candlestick/1day/2025" \
  "https://public.bitbank.cc/btc_jpy/candlestick/1hour/20251007" \
  "https://public.bitbank.cc/btc_jpy/candlestick/1hour/20100101" \
  "https://public.bitbank.cc/btc_jpy/candlestick/1hour/20991231"
do
  curl -sS --max-time 10 "$url" | jq '...'
  sleep 1
done
```

## 生データ

### 1. `GET /btc_jpy/candlestick/1hour/20251002`

`HTTP 200, success=1, count=24`

| 位置 | timestamp (ms) | ISO UTC | ISO JST |
|---|---:|---|---|
| 先頭 | `1759363200000` | `2025-10-02T00:00:00Z` | `2025-10-02T09:00:00+09:00` |
| 末尾 | `1759446000000` | `2025-10-02T23:00:00Z` | `2025-10-03T08:00:00+09:00` |

先頭 ts が `1759363200000` = UTC 00:00 → **UTC 基準**。
（JST 基準なら `1759330800000` = `2025-10-01T15:00:00Z` になる。）

先頭 3 行（参考）:
```json
[["17446934","17560000","17444089","17444089","29.6277",1759363200000],
 ["17442001","17506918","17440001","17474542","14.3396",1759366800000],
 ["17470763","17512125","17459204","17508024","7.0724",1759370400000]]
```

末尾 3 行:
```json
[["17762063","17780360","17682306","17692357","6.4990",1759438800000],
 ["17692358","17715303","17661527","17684686","5.0822",1759442400000],
 ["17684686","17737740","17684686","17729335","4.9077",1759446000000]]
```

### 2. `GET /btc_jpy/candlestick/1day/2025`

`HTTP 200, success=1, count=365`

| 位置 | timestamp (ms) | ISO UTC | ISO JST |
|---|---:|---|---|
| 先頭 | `1735689600000` | `2025-01-01T00:00:00Z` | `2025-01-01T09:00:00+09:00` |
| 末尾 | `1767139200000` | `2025-12-31T00:00:00Z` | `2025-12-31T09:00:00+09:00` |

各 daily candle の timestamp が UTC 00:00 → **UTC 00:00 基準**。
365 本（うるう年でない年は 365）= UTC 暦年で 1/1〜12/31。

末尾 3 行（参考）:
```json
[["13750000","14121429","13577103","13620599","267.2248",1766966400000],
 ["13620600","13934565","13590000","13813942","148.8865",1767052800000],
 ["13813941","13892214","13645001","13690527","260.4839",1767139200000]]
```

### 3. `GET /btc_jpy/candlestick/1hour/20251007`

`HTTP 200, success=1, count=24`

| 位置 | timestamp (ms) | ISO UTC | ISO JST |
|---|---:|---|---|
| 先頭 | `1759795200000` | `2025-10-07T00:00:00Z` | `2025-10-07T09:00:00+09:00` |
| 末尾 | `1759878000000` | `2025-10-07T23:00:00Z` | `2025-10-08T08:00:00+09:00` |

probe 1 と同じ挙動（UTC 暦日 24 本）を別日付で再確認。**UTC 基準**で一貫。

### 4. `GET /btc_jpy/candlestick/1hour/20100101`（取引開始前）

`HTTP 404, success=0, data.code=10000`

bitbank の BTC/JPY 取引開始（2017 年）より前の日付。レスポンスは空配列ではなく**エラー応答**で返る。

### 5. `GET /btc_jpy/candlestick/1hour/20991231`（未来）

`HTTP 404, success=0, data.code=10000`

未来日付。取引開始前と同じ扱い（HTTP 404 + `data.code: 10000`）。

## `get_candles` 実装との対応（現仕様）

| レイヤ | 役割 |
|---|---|
| bitbank API | `/candlestick/<type>/<UTC-key>` で OHLCV chunk を返す |
| `fetchCandleChunk` / multi-day merge | 必要な UTC キー集合だけ並列 fetch |
| `computeAnchorEndMs(date, type, tz)` | `date` を **tz 暦日終端**（`23:59:59.999 in tz`）に変換 |
| filter + `slice(-limit)` | anchor 以前の足だけ残し、本数 `limit` で切る |
| 表示 | `isoTime` = UTC ISO、`isoTimeLocal` / `keyPoints.date` / summary 日付 = `tz` |

**注意:** 「UTC anchor 仕様」ではなく **「tz anchor 仕様」** が正確。`tz=UTC` を渡したときだけ anchor が UTC 暦日終端になる。

### コード参照

- `computeAnchorEndMs`: `tools/get_candles.ts`（tz 暦日終端）
- sub-day の UTC key 導出と fetch: `tools/get_candles.ts` 付近（`sub-day` / multi-day 経路）
- スキーマ・利用者向け説明: `src/schema/market-data.ts`, `docs/tools.md`

### `1day` 日足の限界（再掲）

- API の daily bar timestamp は UTC 00:00 固定。
- `tz=Asia/Tokyo` で `date=2025` 等を指定しても、返るのは **UTC 暦年の日足** を tz 表示したもの。
- JST 0:00 区切りの厳密な日足が必要な場合は、サブ日次足からの再集約が別途必要（本 MCP では未提供）。

### 404 / 未来日

取引開始前・未来の `date` は `404 + data.code: 10000`（実測）。`get_candles` は anchor 計算後に未来日を早期 `user` fail する（PR-5）。

未来日判定は **期間の開始（tz 暦日の 00:00）> now** で行う（2026-07-08 改修）。旧実装は期間の
終端（23:59:59）で判定していたため、進行中の当日（部分データが取得できる正当なケース）を
「未来」として誤拒否していた。同改修で fetch key 列挙も現在時刻でクランプし、JST 早朝に
「UTC ではまだ始まっていない日」を要求して過半数失敗する問題を解消した
（回帰テスト: `tests/get_candles.test.ts` の「JST 早朝の当日データ取得」）。

### 上場前 chunk の 404 と部分失敗の扱い（#84）

**症状**: 上場初年度の銘柄をその年で取得すると、データが存在する年ごと取得失敗になっていた。
JST 1 年の窓は UTC 年 chunk 2 本に割れる（JST 年頭は UTC 前年）ため、上場初年度は古い側が必ず
上場前になり 404 が返る。旧実装はこれを実失敗に数え、2 年中 1 年の失敗で全体を `fail` にしていた。
確率的な失敗ではなく**構造的な確定失敗**で、該当銘柄はその年を永久に取得できなかった。

#### 判定基準: 「同じリクエストの他 chunk が実データを返したか」

「上場前だから 404」と「本来あるはずのデータが 404」は**上流応答だけでは区別できない**
（どちらも `404 + code 10000`）。区別できない以上、代理指標を置くしかない。採用したのは
**同じ pair / type が同じリクエストで実データを返せたか**。

| 状況 | 分類 | 根拠 |
|---|---|---|
| 進行中・未来の期間キーが 404 / `success:0` | `pendingGap`（ℹ️） | 時間が解決する。従来どおり |
| **過去**の期間キーが 404 で、**他 chunk に行がある** | `absentGap`（ℹ️） | 上流は生きていて経路も正しい。隣接 chunk の 404 は「その期間に足が無い」の表明と読める |
| 過去の期間キーが 404 で、**どの chunk にも行が無い** | 実失敗 | 判断材料が無い。全 chunk 失敗として従来どおり `fail`（`classifyAllChunksFailure` / 空応答 fail） |
| 過去の期間キーが `200 + success:0` | 実失敗（⚠️） | 実測上これは「期間は在るが集計が未了」の応答。過去期間で出たら本物の異常 |
| 5xx / タイムアウト / ネットワーク | 実失敗（⚠️） | 一時的な失敗。リトライ対象でもある |

この基準を選んだ理由は「取りこぼしの向きが安全側」だから。1 本でもデータが返っていれば
呼び出し側は返ってきた期間を見て判断でき、欠けた期間は ℹ️ 注記で申告される。逆に 1 本も
返っていない場合に成功を騙ると、呼び出し側は「その期間に足が無い」と「上流が壊れている」を
区別できなくなるので、そこは従来どおり落とす。

`absentGap` / `pendingGap` はどちらも過半数判定の**分母・分子の両方から外す**。

#### 閾値は「半数以上」ではなく「半数超」（過半数）

旧実装は `hardFailedKeys.length >= totalChunks / 2` で発火しながら、メッセージは「過半数が失敗」と
言っていた（過半数 = 50% 超なので**文言が誤り**）。**文言ではなく閾値の方を過半数に寄せた**。理由:

- YEARLY_TYPES の 1 年ぶんの要求は JST/UTC のずれで**常に UTC 年 chunk 2 本**になる。`>=` では
  片方が落ちただけで必ず全体 `fail` になり、取得できた 1 年ぶんの足ごと捨てる。上の #84 と
  同じ「部分成功を握り潰す」失敗モードを閾値側にも抱えていた。
- 実際に失われる量は小さい。JST 2023 の窓で UTC 2022 chunk が落ちても、欠けるのは
  UTC 2022-12-31 の 1 本（= JST 2023-01-01 09:00）だけで、残り 365 本は取得できている。
- 半数の欠損は ⚠️ 警告（失敗 key と原因を `describeFailedChunks` で列挙）で申告すれば、
  呼び出し側はデータと欠損の両方を受け取れる。捨てるより情報量が多い。
- 全滅は手前の `classifyAllChunksFailure` / 空応答 fail が拾うので、緩めても「何も無いのに
  成功を返す」経路は生まれない。

**副作用（意図したもの）**: `analyze_my_portfolio` の入出庫日価格取得（`fetchFlowDatePrices`）では、
2 chunk のうち片方だけが一時的に落ちたケースが `chunkFetchFailed` に載らなくなり、#80 の抑止が
発動しなくなる。年のほぼ全域が取得できている状態なので、入出庫日が欠けた側の chunk に入って
いなければ価格は解決する。解決できなかった場合は従来どおり現在価格へフォールバックし
`current_price_fallback_count` で申告される。#80 の抑止の粒度自体はこの変更では触っていない。

#### 404 はリトライしない

404 は何度叩いても 404 なので、`lib/http.ts` の HTTP リトライ対象から外した
（`HttpStatusError` + `isRetriableHttpStatus`）。408 / 429 / 5xx / タイムアウトは従来どおり
リトライする。上場前 chunk 1 本につきリクエストが 3 倍になり、レート制限を自分で誘発して
**同時に走っている他 chunk の成功率まで下げる**のを避けるため。
`fetchFlowDatePrices` の chunk 単位リトライ（#81）側は、上場前の年が `errorType='user'` で
返る（全 chunk 404 → outer catch → user fail）ので元から再試行しない。

**実装**: `tools/get_candles.ts` の `partitionFailedChunks` / `isMajorityChunkFailure` /
`buildChunkWarnLines`、`lib/http.ts` の `isRetriableHttpStatus`。
**回帰テスト**: `tests/get_candles.test.ts` の「上場前 chunk の 404 に巻き込まれない（#84）」、
`tests/lib/http.test.ts` の「HTTP ステータス由来のリトライ判定（#84）」。

## 関連

- 実装: `tools/get_candles.ts` (`computeAnchorEndMs`, sub-day fetch window)
- テスト: `tests/get_candles.test.ts`（tz anchor・UTC API key・multi-day window）
- 利用者向け: `docs/tools.md`, `src/schema/market-data.ts`
- 公式ドキュメント (`bitbankinc/bitbank-api-docs/master/public-api.md`) はタイムゾーンを明記していないため、本実測ログを社内一次ソースとする。
