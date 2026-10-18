// Runs once per `npm test`: starts fresh Postgres, Redis and RabbitMQ containers, provisions every
// service's role and schema from stack.json (the same SQL as the cluster's db-provision Job), runs
// each service's migrations as that role, and provides the URLs to tests (@app/server-kit/testing-env).
// Teardown stops the containers; if the run is killed, testcontainers' reaper removes them.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createDb } from '@app/server-kit/db';
import {
  migrate,
  startPostgres,
  startRabbitMQ,
  startRedis,
  type ContainerUrls,
  type StartedContainer,
} from '@app/server-kit/testing';
import type { TestProject } from 'vitest/node';
import { DEV_PASSWORD, provisionSql } from './scripts/lib/render.mjs';
import { loadStack, toPgName, wiredEnv } from './scripts/lib/stack.mjs';

// Set by scripts/new-service.test.ts for its nested run, which reuses this run's containers.
const SHARED_ENV = 'TEST_SHARED_CONTAINERS';

export default async function setup(project: TestProject) {
  const root = project.vitest.config.root;
  const stack = loadStack(root);

  let started: StartedContainer[] = [];
  let containers: ContainerUrls;
  if (process.env[SHARED_ENV]) {
    containers = JSON.parse(process.env[SHARED_ENV]);
  } else {
    try {
      started = await Promise.all([startPostgres(stack.postgres.database), startRedis(), startRabbitMQ()]);
    } catch (err) {
      throw new Error(
        `Tests run against Docker containers (testcontainers), and starting them failed: ${(err as Error).message}\n` +
          '  fix: start Docker, then check your setup with: npm run doctor',
        { cause: err },
      );
    }
    const [postgres, redis, rabbitmq] = started.map((c) => c.url) as [string, string, string];
    containers = { postgres, redis, rabbitmq };
  }

  const admin = createDb({ url: containers.postgres, schema: 'public' });
  try {
    await admin.raw(provisionSql(stack).replace(/^\\set .*$/m, ''));
  } finally {
    await admin.destroy();
  }

  const serviceEnv: Record<string, Record<string, string>> = {};
  for (const svc of Object.values(stack.services).filter((s) => s.node)) {
    const env: Record<string, string> = {
      ...svc.env,
      ...wiredEnv(stack, svc),
      NODE_ENV: 'test',
      SERVICE_NAME: svc.name,
      LOG_LEVEL: 'silent',
      REDIS_URL: containers.redis,
      RABBITMQ_URL: containers.rabbitmq,
    };
    if (svc.db.mode !== 'none') {
      const role = toPgName(svc.name);
      const url = new URL(containers.postgres);
      url.username = role;
      url.password = DEV_PASSWORD(role);
      const schema = svc.db.mode === 'own' ? role : 'public';
      env.DATABASE_URL = url.toString();
      env.DB_SCHEMA = schema;
      const serviceRoot = path.join(root, 'apps', svc.name);
      if (existsSync(path.join(serviceRoot, 'migrations'))) {
        await migrate({ url: url.toString(), root: serviceRoot, service: svc.name, schema });
      }
    }
    serviceEnv[svc.name] = env;
  }

  project.provide('containers', containers);
  project.provide('serviceEnv', serviceEnv);

  return async () => {
    await Promise.all(started.map((c) => c.stop()));
  };
}
