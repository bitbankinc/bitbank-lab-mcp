# bitbank `/candlestick` の暦日仕様（実測ログ）

`tools/get_candles.ts` の `date` / `tz` パラメータが bitbank Public API の candlestick キーとどう対応するかを、**実 API 実測** と **現行実装** で固定する。

## 結論（断定）

### bitbank API 側（fetch キー）

1. **`/candlestick/1hour/<YYYYMMDD>` のグルーピング基準は UTC 暦日。**
   `20251002` で返る 24 本は `1759363200000` (= 2025-10-02T00:00:00Z) から `1759446000000` (= 2025-10-02T23:00:00Z) まで。JST 基準（先頭が `1759330800000` = 2025-10-01T15:00:00Z）ではない。
2. **`/candlestick/1day/<YYYY>` の各 daily candle の timestamp は UTC 00:00。**
   `2025` の先頭バーは `1735689600000` (= 2025-01-01T00:00:00Z, JST 2025-01-01T09:00)、末尾は `1767139200000` (= 2025-12-31T00:00:00Z)。1 年 = 365 本（UTC 暦年）。
3. **取引開始前 / 未来日付は HTTP 404 + `success: 0` + `data.code: 10000`。** 空配列ではなくエラー応答。

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

## 関連

- 実装: `tools/get_candles.ts` (`computeAnchorEndMs`, sub-day fetch window)
- テスト: `tests/get_candles.test.ts`（tz anchor・UTC API key・multi-day window）
- 利用者向け: `docs/tools.md`, `src/schema/market-data.ts`
- 公式ドキュメント (`bitbankinc/bitbank-api-docs/master/public-api.md`) はタイムゾーンを明記していないため、本実測ログを社内一次ソースとする。
