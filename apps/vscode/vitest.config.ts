import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Builds dist/ once and refuses a stale frontend/dist, before any file starts. See the file.
    globalSetup: ['test/globalSetup.ts'],
    testTimeout: 10_000,
  },
})
