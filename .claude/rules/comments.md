---
paths:
  - "src/**/*.ts"
  - "tools/**/*.ts"
  - "lib/**/*.ts"
  - "lab/**/*.ts"
  - "scripts/**/*.ts"
  - "tests/**/*.ts"
  - "ui/**/*.{ts,tsx}"
---

# コメントの基準

コードを読めば分かる説明は書かない。コードを変えたときに更新されず、食い違いの原因になる。
周囲のコードにコメントが多くても、それに合わせない。

## 書いてよいもの

コードからは読み取れず、知らないと誤った変更をしてしまう理由だけを、1 行で書く。

- 意図的な非対称・例外（「ここだけ固定値を使う」など）
- 並び順への依存（「この行は status より後ろに置く」など）
- 意図的に残している到達しないガード
- 他ファイルとそろえている値
- 名前から分からない対応関係（p0〜p4 が何を指すか など）
- TODO

理由の詳細が長くなるなら、コメントには issue 番号だけを書き、説明は issue / PR に残す。

## 書かないもの

- 関数・引数・戻り値の説明（名前と型から分かるもの）
- 経緯・変更履歴・計測値（「以前は〜だった」「〜から抽出」など）。コミットメッセージと PR に書く
- 「〜を参照」という案内だけのコメント
- 区切りコメント（`// ── xx ──`）、太字、「——」、入れ子の箇条書き
- 同じ文面の繰り返し。ファイル内で最初の 1 箇所だけに書く

## 既存コードを変更するとき

- 触った箇所のコメントがコードと食い違ったら、消すか正しい 1 行に直す
- 長いコメントを要約して残さない。上の「書いてよいもの」に当たる 1 行だけを残し、他は消す

## コメントだけを変更したときの確認

1. 差分の全行がコメント行か空行であること
2. コメントを除いたビルド出力が変更前とバイト単位で一致すること
   （出力先はリポジトリの外にし、変更前に一度出力しておく）
   - src / tools / lib / tests: `npx tsc --removeComments --noEmit false --outDir <dir>`
   - scripts（tsconfig.json の対象外）: `npx tsc --ignoreConfig --noCheck --removeComments --noEmit false
     --target ES2022 --module NodeNext --moduleResolution NodeNext --outDir <dir> scripts/*.ts`
   - lab（tsconfig.json の対象外。`lab/main.ts` はテストからの import で上の src 等の出力にも入る）:
     scripts と同じコマンドの `scripts/*.ts` を `lab/*.ts` に替えて実行する
   - ui（vite でビルド）: `npx vite build --config ui/<app>/vite.config.ts --outDir <dir>/<app> --emptyOutDir`
     を order-confirm / cancel-confirm それぞれで実行する
3. `npm test` が全件通ること。tests/ にはソースの文字列を読むテストがあるので
   （`grep -rl readFileSync tests` で確認）、コメント内の文字列が判定に影響しないか注意する
