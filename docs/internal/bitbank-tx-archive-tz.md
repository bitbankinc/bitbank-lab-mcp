# bitbank `/transactions/{YYYYMMDD}` アーカイブの暦日仕様（実測ログ）

`/transactions/{YYYYMMDD}` 日付アーカイブの日付境界と公開タイミングを **実 API 実測** で固定する。
`lib/tx-archive.ts` の日付キー導出、および `get_flow_metrics` / `analyze_volume_profile` /
`get_transactions` の取得戦略の一次ソース。

## 結論（断定）

1. **`/transactions/{YYYYMMDD}` のグルーピング基準は UTC 暦日。**
   `20260706` のアーカイブは `2026-07-06T00:00:02.604Z` 〜 `2026-07-06T23:58:52.801Z`（JST 7/6 09:00 〜 7/7 08:58）の 8040 件。JST 暦日ではない。
2. **アーカイブは当該 UTC 日が完了するまで 404。** 進行中の UTC 日（例: 23:42 UTC 時点の当日）を要求すると
   `HTTP 404 + success:0 + data.code:10000`。
3. **UTC 日完了後も即時公開ではない（公開遅延あり）。** UTC 日完了から 12 分後の時点でも前日分は 404 のまま
   （正確な公開時刻は未計測。少なくとも「00:00 UTC を過ぎれば即取得できる」とは仮定できない）。
4. **進行中の UTC 日の約定は `/transactions`（latest）でのみ取得可能。直近約 60 件。**
   したがって「進行中 UTC 日の全約定」はパブリック API では取得不能（構造的なカバレッジギャップ）。

### 実装への帰結

- 日付キーは **完了済み UTC 暦日** から導出する（`lib/tx-archive.ts`）。
  JST 基準で「今日 / 昨日」を組むと、JST 早朝（00:00〜09:00 JST = UTC 日付更新前）に
  進行中の UTC 日を要求して必ず 404 になる（2026-07-08 08:31 JST の障害の原因）。
- 完了済み UTC 日でも公開遅延で 404 になり得るため、**補完アーカイブの取得は best-effort**。
  latest が成功していれば全体 fail せず、warning で失敗と件数不足を明示する。
- 進行中 UTC 日の区間は latest（直近約 60 件）でしか埋められない。時間範囲取得ではこの
  カバレッジ制約を warning で常に明示する。

## 計測条件

| 項目 | 値 |
|---|---|
| 取得日時 | 2026-07-07 23:42 UTC 〜 2026-07-08 00:12 UTC（= JST 7/8 08:42〜09:12） |
| ペア | `btc_jpy` |
| 認証 | なし（パブリック API） |
| 実行環境 | macOS ローカル `curl` |

## 生データ

### 1. `GET /btc_jpy/transactions/20260706`（完了済み UTC 日）@23:42 UTC

`HTTP 200, success=1, count=8040`

| 位置 | executed_at (ms) | ISO UTC | ISO JST |
|---|---:|---|---|
| 先頭 | `1783296002604` | `2026-07-06T00:00:02.604Z` | `2026-07-06T09:00:02+09:00` |
| 末尾 | `1783382332801` | `2026-07-06T23:58:52.801Z` | `2026-07-07T08:58:52+09:00` |

先頭・末尾とも UTC 暦日 7/6 に収まる → **UTC 基準**。

### 2. `GET /btc_jpy/transactions/20260707`（進行中の UTC 日）@23:42 UTC

`HTTP 404, success=0, data.code=10000`

実行時点（23:42 UTC）は UTC 7/7 の進行中。JST では 7/8 08:42 で、7/7 は「JST の昨日」だが未公開。

### 3. `GET /btc_jpy/transactions/20260707`（完了直後の UTC 日）@00:04 UTC / @00:12 UTC

いずれも `HTTP 404`。UTC 日完了から 12 分経過しても未公開 → **公開遅延あり**。

### 4. `GET /btc_jpy/transactions`（latest）@23:43 UTC

`HTTP 200, success=1, count=60`

`2026-07-07T23:16:23Z` 〜 `2026-07-07T23:43:54Z` の直近約 28 分・60 件のみ。

## 障害との対応（2026-07-08 08:31 JST）

| 観測 | 原因 |
|---|---|
| `analyze_market_signal(flowLimit=300)` が「supplement-1 404 (`/transactions/20260707`)」で過半数失敗 | 補完日付を JST の「昨日」で導出 → JST 早朝はそれが進行中の UTC 日 → 必ず 404。latest は成功していたのに過半数ルールで全体 fail |
| `flowLimit=60` だと成功 | latest の約 60 件で足り、補完 fetch 自体が走らないため |
| 09:00 JST（= 00:00 UTC）以降に自然回復 | UTC 日付が更新され「JST の昨日」が完了済み UTC 日になる（ただし公開遅延分のずれは残る） |

## 関連

- 実装: `lib/tx-archive.ts`（日付キー導出）、`tools/get_flow_metrics.ts` / `tools/analyze_volume_profile.ts`（取得戦略）、`tools/get_transactions.ts`（404 ヒント）
- テスト: `tests/lib/tx-archive.test.ts`, `tests/get_flow_metrics.test.ts`（JST 早朝回帰）, `tests/get_transactions.test.ts`
- candlestick 側の暦日仕様: `docs/internal/bitbank-candle-tz.md`
- 公式ドキュメント (`bitbankinc/bitbank-api-docs`) はアーカイブの暦日基準・公開タイミングを明記していないため、本実測ログを社内一次ソースとする。
