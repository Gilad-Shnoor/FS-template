import { defineConfig } from 'vitest/config';

// One run for the whole repo: every workspace is a project, and they all share the containers
// vitest.global-setup.ts starts (fresh each run). New services under apps/ are picked up as is.
export default defineConfig({
  test: {
    globalSetup: ['./vitest.global-setup.ts'],
    projects: [
      'packages/*',
      'apps/*',
      // Vitest tests for the stack CLI. (scripts/**/*.test.mjs are node:test, run by test:scripts.)
      { test: { name: 'scripts', include: ['scripts/**/*.test.ts'] } },
    ],
    passWithNoTests: true,
  },
});
