import { defineConfig } from 'tsup';

// Production build: bundles workspace packages (@app/*) in, keeps npm deps external.
// Output keeps the folder layout (dist/src, dist/migrations) so the db CLI finds migrations.
export default defineConfig({
  entry: ['src/index.ts', 'src/db/cli.ts', 'migrations/*.ts', 'seeds/*.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/^@app\//],
  // tsup otherwise only externalizes deps listed in THIS package.json, so deps of
  // @app/server-kit (pino, express…) would be inlined and their CJS requires break the ESM bundle.
  skipNodeModulesBundle: true,
});
