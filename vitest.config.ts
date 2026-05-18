import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // テストファイルのパターン
    include: ['tests/**/*.test.ts'],
    // - chaos / security: ローカル専用 (public CI には載せない)
    // - e2e: サブプロセス + tsx 起動が必要。`npm run test:e2e` (vitest.config.e2e.ts) で実行
    exclude: ['tests/chaos/**', 'tests/e2e/**', 'tests/private/security.test.ts', 'node_modules/**'],
    // タイムアウト（ネットワーク系テストがある場合を考慮）
    testTimeout: 10_000,
    // ESM 対応
    pool: 'forks',
    // カバレッジ設定
    coverage: {
      provider: 'v8',
      // CI でカバレッジ低下を検出するための閾値（現状ベースライン基準）
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 80,
        lines: 80,
      },
    },
  },
});
