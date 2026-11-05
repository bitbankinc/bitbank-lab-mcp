# ADR-0008: private API の接続先の差し替えを研究用の起動口に閉じ込める

- **Status**: Accepted
- **Date**: 2026-10-01

## Decision

private API（`src/private/client.ts`）の接続先 `https://api.bitbank.cc` を、研究・検証のために
ループバックのモックや中継へ差し替えられるようにする。ただし:

1. **差し替えられるのは、リポジトリの `lab/start.ts`（研究用の起動口）から起動したときだけ。**
   `lab/` は npm の配布物にも Docker イメージにも入らない
2. 配布物に足すのは、**外から有効にできない差し込み口**だけ:
   - `BitbankPrivateClient` の `origin` オプション
   - `setDefaultClient()`（既定のクライアントの差し替え。作成後は throw）
   どちらも環境変数・`.env`・設定ファイルを読まない。配布物の中からは呼ばない
3. `origin` は **ループバックの origin だけ**を受ける。不正な値は throw し、既定の接続先へ戻さない
4. 起動口の実行中は、既定のクライアントを迂回して本番の private API へ向かう fetch を止める

既定の経路で送る URL は変えない（`https://api.bitbank.cc` + パス。文字列の完全一致でテストする）。

## Context

private API の接続先を、同じマシンのモックや中継へ向けて挙動を確かめる。
中継は、要求を受けて取引 API 側へ渡す層（プロキシ）で、本リポジトリの外にある。

- 取引 API の代わりにモック（[tjackiet/bitbank-lab-mock](https://github.com/tjackiet/bitbank-lab-mock)。`127.0.0.1:14000`）を使う
- 変更前は接続先が `private static readonly BASE_URL` に固定で、モックや中継へ向けられなかった

**最優先の条件は、本番に接続して使っている既存の利用者に一切影響を与えないこと。**

配布の経路は次のとおりで、判断はこれを前提にしている。

- npm の `bitbank-lab-mcp` は、本家（bitbankinc/bitbank-lab-mcp）の `release.yml` がタグで公開する
  （OIDC / Trusted Publishing。npm の provenance で 0.2.0 以降すべて本家製であることを確認）
- フォーク（tjackiet/bitbank-lab-mcp）の main は、`sync:` PR で本家に一括で取り込まれる。
  **main に入れたものは、いずれ npm に届く**
- プラグイン（Claude / Cursor / Codex / Gemini）はどれも `npx -y bitbank-lab-mcp` で起動する
- Docker イメージは `src/` / `tools/` / `lib/` だけを `COPY` する

## 却下した案

### 環境変数のオプトイン（`BITBANK_MCP_APPS_EXECUTE` と同じ作法）

`'1'` だけを受けるオプトインと接続先の 2 つが揃ったときだけ差し替える案。研究での起動は最も簡単だが、却下した。

- **配布物に「API キーの送り先を変えるスイッチ」が載る。** ホスト設定の env、継承した env、`.env`
  （`src/env.ts` は cwd の `.env` を最初に読む）のどれでも有効になり、設定を書き換えさせる手口が成立する
- `BITBANK_MCP_APPS_EXECUTE` は利用者のための機能なので、利用者が設定できる必要があった。
  今回の差し替えは研究専用で、利用者にとっての利点が無い。同じ種類のリスクを、利点なしに負うことになる
- 環境変数の解析が、オプトインしていない全員の起動経路で走る

### 研究用ブランチ

main には何も入れない案。配布物への影響は無いが、却下した。

- ブランチは main からずれていき、CI も通らない。研究が「リリースされるコード」と別物の上で動く
- 研究の成果（起動口で確かめたこと）を本家に取り込むときに、作り直しになる

### 起動口から `globalThis.fetch` を書き換える（配布物の変更ゼロ）

`tests/e2e/mock-server-entry.ts` と同じく、起動口で fetch を包み、本番の URL を差し替え先へ書き換える案。
配布物を一切変えないのは魅力だが、却下した。

- 正しさが URL のパターン一致に依存する。クライアントが fetch の使い方を変えると、**黙って本番へ直行する**
  （fail-open）。差し替え先の迂回になる
- 差し替えの規則（origin だけ・ループバックだけ）が配布物の外にあり、lint とカバレッジの対象外になる

この案は向きを反転させて採用した（下記「実行時の遮断」）。書き換えではなく遮断なら、壊れたときに止まる側に倒れる。

### 研究用の起動口で確認を外すオプション（トークン無しで `create_order` を実行させる）

人が居ない状態で流すために、起動口から確認（preview → 実行。ADR-0007）を外し、`create_order` などを
直接実行させる案。却下した。

- **起動口が `lab/` に閉じていても、トークンの検査を外す分岐は `create_order` などの配布物側のコードに入る。**
  ADR-0007 の前提（直接実行の禁止）に例外が生まれ、その分岐を既存の利用者と同じコードが通る
- クライアント側で確認に応えれば（elicitation を宣言し、確認要求に自動で応える）、MCP を変えずに同じ実験ができる
  （`lab/README.md`「確認（preview → 実行）の扱い」）
- MCP の確認は差し替え先に届かない。差し替え先が受け取るのは bitbank の REST 要求そのもので、確認を経たかどうかの
  情報は含まれない。外しても外さなくても、差し替え先の側の検査には影響しない

## Decision の詳細

### 差し込み口（配布物）

`src/private/client.ts`:

- `origin === undefined` のときだけ既定（`https://api.bitbank.cc`）を使う。空文字や `null` も検査に通して落とす
- 検査は `assertLoopbackOrigin()` の 1 か所:
  - **入力が `new URL(入力).origin` と完全一致すること。** パス・末尾の `/`・クエリ・フラグメント・userinfo・
    大文字・`127.1` のような非正規の表記をまとめて落とす。パスの接頭辞を受けないのは、GET の署名が
    「パス + クエリ」に対して作られるため（`auth.ts`）。接頭辞を付けると、署名したパスと送るパスがずれる
  - **scheme は `http:` / `https:`、ホスト名は `127.0.0.1` / `[::1]` / `localhost` のどれかと完全一致。**
    `127.0.0.2`・`0.0.0.0`・`[::ffff:127.0.0.1]`・`localhost.`・`*.localhost` は落とす
  - エラーメッセージに入力値を載せない（userinfo に秘密が入っていても残さない）
- **差し替え時は、差し替え先からのリダイレクトに従わない**（fetch に `redirect: 'error'`）。fetch は既定で
  リダイレクトに従い、307 / 308 では POST の本文も `ACCESS-*` ヘッダーも転送先へそのまま送る。従うと、
  検査したのは最初の送り先だけで、差し替え先がループバックの外へ迂回させられる。既定の接続先への要求には
  この設定を足さない（既定の経路は変えない）
- `setDefaultClient()` は、既定のクライアントが既に作られていたら throw する。同じプロセスの中で
  送り先が途中で変わらないようにするため

ループバックに限る理由: 差し替え先（モックや中継）は MCP サーバーと同じマシンで動かす前提で、
遠隔を許すべき理由がコードにも運用にも無い。遠隔に置く必要が出たら、SSH のポート転送などでループバックに
見せる。その場合の転送路の暗号化と認証は、転送路の側が担う。

### 起動口（`lab/`。配布物に入らない）

`lab/start.ts` → `lab/main.ts` の `runLab()`:

1. `src/env.js` を最初に読む（`src/server.ts` と同じ順）
2. `--private-api-origin=<origin>` を 1 回だけ受ける。欠落・重複・未知の引数は止める
3. キーが未設定なら止める（private ツールが無効で、差し替えても何も効かないため）
4. `new BitbankPrivateClient({ origin })` で検査し、通らなければ止める
5. 実行時の遮断を入れる
6. `setDefaultClient()` で差し替える
7. 接続先を stderr と JSONL ログ（`private_api_origin_override`）に記録する
8. `src/server.js` を**動的 import** する（`src/server.ts` は import した時点でサーバーを起動するため、
   静的 import だと差し替えより先に起動する）

2〜4 で止めるときは、サーバーを読み込まずに終了コード 2 で終わる。**黙って本番へ戻すことはしない。**
出力は stderr だけ（stdio トランスポートでは stdout が JSON-RPC そのもの）。

### 実行時の遮断

起動口の実行中は、`https://api.bitbank.cc` への fetch のうち `/v1/spot/pairs`（認証不要のペア情報。パスの完全一致）以外を止める。
接頭辞ではなく完全一致にするのは、`/v1/spot/` 配下の未知のパスも止める（許可する側を列挙する）ため。
private API の要求はすべて既定のクライアントを通って差し替え先へ行くはずなので、ここに来るのは迂回した要求だけ。
差し替え先を迂回して本番へ直行する要求を、MCP の側で fail-closed に止める。

### 差し替えないもの

- 公開 API（`lib/http.ts` の `https://public.bitbank.cc`）
- ペア情報（`lib/pairs.ts` の `https://api.bitbank.cc/v1/spot/pairs`）。取得に失敗しても
  `preview_order` / `create_order` は警告を出して続行する
- 既存の挙動（POST を再試行しない、GET は 429 で Retry-After に従う、確認トークンによる 2 段階確認）。
  確認を外す案は却下した（「却下した案」の「研究用の起動口で確認を外すオプション」）

## 想定リスクの境界

| リスク | 既定の起動（npm・プラグイン・Docker） | 研究用の起動口 |
|---|---|---|
| 設定（env / `.env` / ホスト設定の env）で送り先が変わる | × 読む経路が無い | × 送り先は引数でだけ決まる |
| API キーのヘッダーと署名付きの要求が遠隔へ出る | × 送り先は `https://api.bitbank.cc` 固定 | × ループバック以外は throw |
| 差し替え先がリダイレクトで外へ転送させる | 該当なし（既定の挙動のまま） | × リダイレクトに従わず失敗する（`redirect: 'error'`） |
| 不正な値で本番へ黙って戻る | 該当なし | × サーバーを起動せずに終了 |
| 一部の要求だけが本番へ直行する（中継の迂回） | 該当なし | × 静的な tripwire と実行時の遮断 |
| 差し替え先が要求を再送して二重発注 | 該当なし | △ 署名は ACCESS-TIME-WINDOW（既定 5 秒）で要求ごとの一意値を含まない。差し替え先（中継）が時間窓の内に再送しないことが前提 |
| 差し替え先の応答（残高・注文状態）を本物として扱う | 該当なし | △ 差し替え先を信頼する前提。ループバックに限るのはこのため |
| シークレットの流出 | × | × シークレットは送らない（送るのは ACCESS-KEY と署名だけ） |

## テストで固定する不変条件

- `tests/private/client-origin.test.ts`
  - 既定の GET（クエリ無し・有り）と POST の URL が、文字列として完全一致する
  - ループバックの origin なら origin + パスへ送る。不正な origin（上の各ケース・空文字・`null`・本番の origin・遠隔）は throw し、送信しない
  - エラーメッセージに入力値を含めない
  - 同じ時刻・同じパスなら、差し替えても署名ヘッダーが既定と一致する
  - 差し替えても、POST は 5xx で再試行せず、GET は 429 で再試行する
  - 差し替え先が 302 / 307 / 308 を返したら失敗し、転送先（別のループバックで代用）には何も届かない。
    既定の接続先への要求の設定（fetch に渡すキー）は変わらない
  - `setDefaultClient()` は作成後・2 回目で throw する
- `tests/private-api-origin-tripwire.test.ts`（tripwire。証明ではない）
  - 配布物（`package.json` の `files` のソース）の中で `new BitbankPrivateClient(` と認証ヘッダの生成を使うのは `client.ts` だけ
  - 配布物の中から `setDefaultClient()` を呼ばない
  - `client.ts` は環境変数を読まない
  - `npm pack --dry-run` の結果と Dockerfile の `COPY` に `lab/` が無い
  - `lab/start.ts` は `src/env.js` を最初に読み、`src/server.js` を動的 import する
- `tests/lab/main.test.ts`: 引数・キー・origin の各誤りで、サーバーを読み込まずに終了コード 2。正常時は差し替えてからサーバーを起動する。実行時の遮断。stdout に書かない
- `tests/e2e/lab-private-origin.test.ts`（nightly）: 子プロセスとして起動し、`get_my_orders` の要求がループバックの HTTP サーバーへパスそのまま・認証ヘッダ付きで届く。引数が無ければ終了コード 2

`lab/` は `tsconfig.json` の include にも lint の対象にも入っていない。処理を `lab/main.ts` に寄せて
テストから import することで、型検査とテストの対象に入れている。`lab/start.ts` は数行の入口に留める。

## 既知の制約

- `localhost` は hosts ファイルに依存する。`lab/README.md` では `127.0.0.1` を勧める
- モック（`e60aac9` 以降）は、既定では認証ヘッダを検証しない。テスト用のキーとシークレット
  （`BITBANK_MOCK_API_KEY` と `BITBANK_MOCK_API_SECRET`）を両方渡して起動したときだけ検証する。
  どちらの場合も、モックに向けるときはダミーのキーを使う（`lab/README.md`）
- 中継の構成について: MCP にダミーのキーを渡し、中継が本物のキーで署名し直す構成にすれば、MCP から本番への
  迂回が構造的に不可能になり、再送の問題も中継の内側に閉じる。本 ADR の差し込み口はどちらの構成でも使える

## 関連

- ADR-0007（取引系 HITL の確認トークン受け渡し設計）。確認トークンは差し替え後もそのまま効く。
  確認は差し替え先には届かない（`lab/README.md`「確認（preview → 実行）の扱い」）
- `.claude/rules/sensitive-data.md`（`BITBANK_API_KEY` は CRITICAL。HTTP ヘッダーの送り先が本 ADR の対象）
- `lab/README.md`（起動のしかた・確認の扱い・注意）

## 実装マップ

| ファイル | 役割 |
|---|---|
| `src/private/client.ts` | `origin` オプション、`assertLoopbackOrigin()`、`setDefaultClient()` |
| `lab/main.ts` | 引数の解析、キーの確認、実行時の遮断、差し替え、記録、サーバーの起動 |
| `lab/start.ts` | 副作用のある入口（`src/env.js` → `runLab()`） |
| `lab/README.md` | 起動のしかた・確認の扱い・注意 |
| `tests/private/client-origin.test.ts` | 差し込み口の不変条件 |
| `tests/private-api-origin-tripwire.test.ts` | 差し替えの経路を lab/ に閉じ込める tripwire |
| `tests/lab/main.test.ts` | 起動口の不変条件 |
| `tests/e2e/lab-private-origin.test.ts` | 子プロセスでの起動（nightly） |
