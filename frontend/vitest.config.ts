import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Default environment stays 'node' -- switching it globally to 'jsdom' breaks
    // protocol.test.ts's `new URL('./fixtures/...', import.meta.url)` fixture loading (jsdom
    // gives import.meta.url a non-file `location`, and fileURLToPath then rejects it: "The URL
    // must be of scheme file"). panel.test.ts, which genuinely needs a DOM, opts into jsdom
    // per-file instead via a `// @vitest-environment jsdom` pragma at its own top -- see that
    // file.
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
