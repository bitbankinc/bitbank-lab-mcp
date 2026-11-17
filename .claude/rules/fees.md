# 手数料の取り扱いポリシー

bitbank の手数料は 3 カテゴリに分かれる。混同するとハルシネーション・誤発注見積りの原因になる。

## taxonomy（3 カテゴリ）

| | カテゴリ | 見積り（estimate）のソース | 実績（actual）のソース |
|---|---|---|---|
| **A** | 取引手数料 maker/taker | `GET /v1/spot/pairs` の `taker_fee_rate_quote` / `maker_fee_rate_quote` | `trade_history` の実額（`fee_amount_*`） |
| **B** | 信用 手数料 / 利息 | pairs の `margin_{open,close}_{maker,taker}_fee_rate_quote` | `trade_history` の実額（`fee` / `interest`） |
| **C** | 入出金 / 出金手数料 | API 値パススルー（`withdrawal_fee` 等） | 同左 |

## ルール

- **A / B の見積りは必ず `lib/fees.ts` 経由**で解決する。
  - 率の解決: `resolveFeeRate(spec, role, override?)`
  - 注文 1 件の見積り: `estimateOrderFee(spec, order)`
  - role 判定: `feeRole(type, postOnly?, crossesBook?)`。`crossesBook` は指値が現在の板を跨ぐか
    （買いは best ask 以上、売りは best bid 以下。最終価格では決まらないので、該当する側が無ければ判定しない）。
    跨ぐ指値（post_only なし）は taker、判定できない（`undefined`）ときは maker 想定のまま。stop_limit は発動時の板が分からないので maker。
- **現物の取引手数料は売買とも quote（JPY）建て**。`*_fee_rate_base` は見積りに使わない
  （実約定で、買いの手数料も円で引かれることを確認済み）。約定履歴の手数料は円未満まで計上されるが、
  見積りは円未満を四捨五入した概算で、`note` にその旨を付ける。
- **C はパススルー**。API が返す値をそのまま出力する。A と混同して `lib/fees.ts` に通さない。
- **実績側は変更しない**。`portfolio/calc.ts` / `get_my_trade_history` / `get_margin_trade_history` 等は
  既に `fee_occurred_amount_quote` + `interest` を別建てで実額計上しており正しい。見積り側のみ本ルールの対象。
  - 信用の `profit_loss` は手数料控除後（実口座で確認）。口座損益の合計で `fee_occurred_amount_quote` を引かない
    （手数料は内訳として出すだけ）。`interest` を含むかは未確認なので、利息は別に引いたままにする。

## 信用（カテゴリ B）の見積り

`estimateOrderFee` に `positionSide`（`long` / `short`）を渡すと信用見積りになる。

- **open / close 判定**（`side` × `positionSide`）:

  | 操作 | side | positionSide | 解決対象 |
  |---|---|---|---|
  | ロング新規(open) | `buy` | `long` | `margin_open_{role}_fee_rate_quote` |
  | ショート新規(open) | `sell` | `short` | `margin_open_{role}_fee_rate_quote` |
  | ロング決済(close) | `sell` | `long` | `margin_close_{role}_fee_rate_quote` |
  | ショート決済(close) | `buy` | `short` | `margin_close_{role}_fee_rate_quote` |

  `role` は現物と同じく `feeRole(type, postOnly, crossesBook)` で判定する（`??` / no-clamp は共通）。
- **信用レートが null（API 未提供）の場合**: 公称 taker（`DEFAULT_TAKER_FALLBACK`）で概算し、
  `note` に「信用手数料率が API 未提供のため概算」を必ず付ける。誤った確定値を出さない。
- **利息（interest）は見積りでは扱わない**。`note` に「利息（interest）は見積りに含めない（実績は trade_history）」を
  常に付け、現物の手数料率と混同させない。利息の実績は `get_margin_trade_history` の `interest` を参照する。

## 禁止事項（banned-patterns で機械検出）

`.claude/hooks/post-ts-lint.sh` の Phase 4 が以下を検出する（除外: `lib/fees.ts` / `tests/` / 行末 `// allow-fee`）。

- 取引手数料定数 `0.0012` のハードコード。フォールバックは `DEFAULT_TAKER_FALLBACK` を使う。
- `*_fee_rate_quote` を `Number()` / `parseFloat()` で直接 parse、または `||` で処理する記述。
  - **必ず `??`（null 合体）を使う**。`||` は campaign の `0` を fallback に化けさせる。
  - **クランプ禁止**（`Math.max(0, …)`）。負の maker リベートをそのまま扱う。
