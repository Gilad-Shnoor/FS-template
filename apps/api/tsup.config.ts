import { defineConfig } from 'tsup';

// Production build: bundles workspace packages (@app/*) in, keeps npm deps external.
// Output keeps the folder layout (dist/src, dist/migrations) so the db CLI finds migrations.
export default defineConfig({
  entry: ['src/index.ts', 'src/db/cli.ts', 'migrations/*.ts', 'seeds/*.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/^@app\//],
  // Without this, tsup only externalizes deps listed in THIS package.json, so deps of
  // @app/server-kit (pino, express…) got inlined and CJS requires broke in the ESM bundle.
  skipNodeModulesBundle: true,
});
