import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests share one Postgres; run them in a single fork so
    // future phases' concurrency tests control their own parallelism.
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    // Container cold start includes the image pull on a fresh machine.
    testTimeout: 120_000,
    hookTimeout: 600_000,
  },
});
