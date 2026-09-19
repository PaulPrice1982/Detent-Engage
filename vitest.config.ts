import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Isolation probes must not share module state between files.
    isolate: true,
    reporters: ['default'],
  },
});
