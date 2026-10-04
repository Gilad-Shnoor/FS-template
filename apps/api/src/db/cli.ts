// Usage (inside the pod, or via `npm run db:migrate` at the repo root):
//   tsx src/db/cli.ts latest | rollback | status | make <name> | seed
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbEnvSchema, loadConfig, runMain } from '@app/server-kit';
import { createDb, runDbCli } from '@app/server-kit/db';

runMain(async () => {
  await runDbCli({
    // src/db → service root (dev) | dist/src/db → dist (prod build)
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
    // Not needed by `make`, so new migrations can be created on the host.
    connect: () => {
      const config = loadConfig(dbEnvSchema);
      return {
        db: createDb({ url: config.DATABASE_URL, schema: config.DB_SCHEMA }),
        service: config.SERVICE_NAME,
        schema: config.DB_SCHEMA,
      };
    },
  });
});
