import { defineConfig } from 'tsup';

export default defineConfig({
// @if db
  entry: ['src/index.ts', 'src/db/cli.ts', 'migrations/*.ts', 'seeds/*.ts'],
// @endif
// @if !db
  entry: ['src/index.ts'],
// @endif
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/^@app\//],
});
