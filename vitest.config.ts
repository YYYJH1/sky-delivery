import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 并发上限固定为 4，不按核数开进程
    maxWorkers: 4,
    testTimeout: 60_000,
  },
});
