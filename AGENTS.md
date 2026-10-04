# AGENTS.md

Guide for AI agents (and humans) working in this repo. Read this first; it's short on purpose.

## What this is

A full-stack template that runs entirely in a local Kubernetes namespace (Docker Desktop):
React SPA (`apps/web`) → Express API (`apps/api`) → Postgres, plus optional Redis / RabbitMQ and
any number of generated services. **`stack.json` is the source of truth for the topology**; every
Kubernetes manifest and some TypeScript is generated from it.

```
stack.json                  topology: services, add-ons, db modes, calls, grants   ← edit this
apps/web                    Vite + React + TanStack Router/Query + Tailwind (SPA)
apps/api                    Express API: src/modules/<feature>/ (routes + repo), migrations/, seeds/
apps/<svc>/src/stack.gen.ts GENERATED: env schema, connectStack() (db/redis/broker + readiness), typed clients
packages/contracts          ISOMORPHIC Zod schemas, route + event definitions, typed fetch client
packages/server-kit         BACKEND-ONLY: config, logger, createApp (middleware), implement(), db, redis, rabbitmq
infra/k8s/generated         GENERATED manifests (never edit) — customize via infra/k8s/patches/
infra/docker/node.Dockerfile  one Dockerfile for every Node service (targets: dev, prod-node, prod-web)
scripts/stack.mjs           stack CLI (render, new-service, addon, link, grant, migrate…)
templates/                  what new-service copies
Tiltfile                    dev loop; reads infra/k8s/generated/tilt.json
```

## Commands

| Goal | Command |
|---|---|
| Check environment, get exact fixes | `npm run doctor` |
| Start everything (hot reload) | `npm run dev` (= `tilt up`, UI at http://localhost:10350) |
| Logs (all / one service) | `tilt logs -f` · `tilt logs api` |
| Follow one request across services | `tilt logs \| grep <x-request-id>` |
| Restart one resource | `tilt trigger api` |
| Resource status | `tilt get uiresources` |
| Show topology | `npm run stack:list` |
| New service | `npm run new:service -- billing --consumers api` |
| Enable add-on / let a service use it | `npm run addon -- redis` then `npm run stack -- use api redis` (`connectStack()` then returns `redis`) |
| Service A calls B | `npm run link -- a b` |
| DB access across schemas | `npm run db:grant -- billing reports read` |
| New migration | `npm run db:make -w apps/api -- add_tags`, write `up()`/`down()` (the draft refuses to run until then), save: Tilt applies it |
| Migrate / seed / psql | `npm run db:migrate` · `npm run db:seed` · `npm run db:shell` |
| Verify before finishing | `npm run check` (render --check, lint, typecheck, tests) |
| End-to-end check of the running stack | `npm run smoke` (gateway, auth, todo CRUD, errors, request ids) |

Unit tests don't need the cluster (`npm test`). The API tests run with auth disabled and an
in-memory repo. `npm run smoke` needs the stack up (`npm run dev` or `tilt ci`) with the default
`AUTH_ENABLED=true`; it resolves `*.localhost` itself, so no hosts-file edit is needed.

## Rules

1. **Topology changes go through `stack.json`** (or the CLI), never by hand-editing
   `infra/k8s/generated/*` or `*.gen.ts`. Tilt re-renders on save. CI fails if generated files are stale.
2. **Contracts first.** A new endpoint = add it to `packages/contracts/src/<svc>/index.ts`
   (`defineRoute`), then `implement()` it in the service, then call it via the typed client
   (`api.<route>()` in web, `serviceClients().<svc>.<route>()` between services). Never hand-write
   request/response types; infer them from the Zod schemas.
3. **Boundaries (lint-enforced):** `packages/contracts` and `apps/web/src` must not import
   `@app/server-kit`, `express`, `knex`, `pg` or `node:*`.
4. **Services talk via HTTP (typed client) or events**, not each other's tables. A DB grant is the
   explicit exception, for cases like a read-only reporting service; reference the other schema
   explicitly (`api.todos`).
5. **Errors:** throw `HttpError` helpers (`notFound()`, `badRequest()`, …) from `@app/server-kit`.
   Every error response is `{ error: { code, message, details?, requestId } }`.
6. **Config:** add env vars to the service's Zod schema (`src/config.ts`) and their local values
   to `stack.json` → `services.<svc>.env`. A missing or invalid var crashes the pod at boot with a list.
7. New feature in an existing service: copy `apps/api/src/modules/todos/` (routes.ts + repo.ts),
   register it in `src/app.ts`, add a migration.

## Debugging playbook

- **Pod crash-looping:** `tilt logs <svc>`. A config error prints every bad var. If it's the
  `migrate` init container: `kubectl -n fs-template logs deploy/<svc> -c migrate`.
- **Readiness failing:** `curl http://app.localhost/api/readyz` lists each dependency check with its error.
- **500 in dev:** the response body includes the error message and a stack excerpt
  (`NODE_ENV!=production`). `ContractViolationError` means a handler returned data that doesn't
  match its contract, and its `details` list the exact fields.
- **Breakpoints:** attach a Node debugger to `localhost:9229` (api; other services get 9230+,
  see `npm run stack:list`). `.vscode/launch.json` has a ready config.
- **DB state:** `npm run db:shell`, then `\dn` (schemas), `\dt api.*`, `set search_path=api;`.
  From the host: `postgres://postgres:postgres-dev-password@localhost:15432/app`.
- **Gateway / hostnames:** `kubectl -n fs-template get gateway,httproute`. Port 80 must be free.
  If `*.localhost` doesn't resolve for CLI tools, `npm run doctor` tells you what to add to the hosts file.
- **Stuck state:** `npm run reset` (deletes the namespace, including DB data), then `npm run dev`.
- **postgres stuck in `Init:Error` (`check-data-layout`):** the volume holds data from before the
  Postgres 18 upgrade, which 18 can't use. `npm run reset`, then `npm run dev`.
- **Removing a service:** `npm run stack -- remove-service billing` drops it from stack.json (Tilt
  deletes its workloads); then delete `apps/billing` and `packages/contracts/src/billing`, and run
  `npm install`. Its Postgres role and data are **kept**: db-provision only creates and grants,
  it never drops. To delete them, in `npm run db:shell`:
  `DROP OWNED BY billing CASCADE; DROP ROLE billing;` (works for `db: own`, where it drops the
  schema, and `db: shared`, where it drops the service's tables in `public` and its
  `knex_migrations_billing` table). Use the role name, i.e. `-` → `_`.

## Auth

Better Auth, isolated in `apps/api/src/modules/auth/`. The rest of the code only sees
`requireAuth` and `req.user`. Set `AUTH_ENABLED=false` in stack.json → api.env for a fixed dev user
(useful for quick prototyping and tests). Its tables are created by a regular Knex migration. The
API has no host of its own: the gateway serves it at `app.localhost/api/*` (stack.json `routes`),
so auth and API calls are same-origin and cookies just work. Never add `/api/*` routes to the SPA.
