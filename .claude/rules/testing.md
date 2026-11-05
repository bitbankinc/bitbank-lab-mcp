---
paths:
  - "tests/**/*.test.ts"
---

# テスト作成ガイド

## エッジケースの優先順位（迷ったらこの順）

1. 空配列
2. `null` / 欠損値
3. 重複入力
4. 単一要素
5. 最小値 / 最大値 / off-by-one

## テスト観点

- 入力バリデーション（Zod スキーマ）
- `ok` / `fail` の分岐
- API 異常系（ネットワークエラー、レスポンス不正）
- エッジケース（上記の優先順位に従う）

## モック規約

`fetch` モックは `vi.spyOn(globalThis, 'fetch')` を基本とする。
テストごとに戻し忘れを防ぐため、`afterEach` で `vi.restoreAllMocks()` を実行する。

```ts
afterEach(() => {
  vi.restoreAllMocks();
});

it('ネットワークエラー', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new TypeError('fetch failed'),
  );
  // ...
});
```

内部ツール呼び出しのモックは `vi.mock` を優先する:

```ts
vi.mock('../xxx.js', () => ({ default: vi.fn() }));
```
