# FS Template

A full-stack starter that runs entirely in a local Kubernetes namespace: a React SPA, an Express
API, Postgres, and optional Redis / RabbitMQ and extra services. Everything is infrastructure as code
with hot reload. It's built for take-home assignments: fast to start, easy to extend, and easy to explain.

```mermaid
flowchart LR
  B[Browser] -->|app.localhost| G[Gateway<br/>Envoy, Gateway API]
  G -->|/| W[web<br/>Vite + React]
  G -->|/api| A[api<br/>Express]
  A --> P[(Postgres<br/>schema per service)]
  A -. stack.json calls .-> S[new service]
  A -. optional .-> R[(Redis)]
  A -. optional .-> Q[[RabbitMQ]] -.-> K[worker]
```

| | |
|---|---|
| Frontend | React 19, TanStack Router (file-based) + Query, Tailwind v4, Vite |
| Backend | Express 5, helmet, CORS, compression, rate limiting, pino JSON logs, request ids, graceful shutdown |
| Data | Postgres 17, Knex migrations/seeds, one schema + role per service |
| Contracts | Zod schemas shared by server and client, typed fetch client, typed events |
| Auth | Better Auth (email + password), isolated module, toggle with one env var |
| Infra | Docker Desktop Kubernetes, Gateway API (Envoy Gateway), Kustomize, Tilt |

## Quick start

Prerequisites: Docker Desktop with **Kubernetes enabled** (kubeadm), Node 24+, and
[Tilt](https://docs.tilt.dev/install.html). Port 80 must be free.

```bash
npm install
npm run doctor          # checks everything, prints the exact fix for anything missing
npm run cluster:setup   # one-time: installs Envoy Gateway into the cluster
npm run dev             # tilt up: builds, deploys, live-reloads
```

Open http://app.localhost. The API is served on the same host under `/api` (try http://app.localhost/api/readyz). The Tilt UI is at
http://localhost:10350. Stop with `Ctrl+C` then `npm run down`.

## Starting an assignment

1. Set `"project"` in `stack.json` to the assignment's name (it becomes the namespace and image names).
2. Replace the todos example: contract in `packages/contracts/src/api`, module in
   `apps/api/src/modules/todos`, migration, and `apps/web/src/routes/_authed/todos.tsx`.
3. Need more? `npm run addon -- redis`, `npm run new:service -- billing --consumers api`, etc.

## How it fits together

**`stack.json` is the source of truth.** It declares services, add-ons, which services call
each other, each service's database mode, and cross-service grants. `npm run stack:render` (which
Tilt runs automatically) turns it into:

- `infra/k8s/generated/*.yaml`: namespace, Postgres, DB provisioning job, Gateway, routes,
  Deployments, Services, add-ons
- `apps/<svc>/src/stack.gen.ts`: the env schema for what the service uses; `connectStack()`, which
  connects to its database / Redis / RabbitMQ and returns their `/readyz` checks and shutdown hooks
  (a resource the service doesn't declare is typed `undefined`); and typed clients for the services
  it calls
- `infra/k8s/generated/tilt.json`: the plan the `Tiltfile` executes

Generated files are committed, so diffs show infra changes, and CI fails if they're stale.
Customizations stack.json doesn't model go in `infra/k8s/patches/` as Kustomize patches.

### Stack CLI

```bash
npm run stack:list                                    # topology at a glance
npm run new:service -- billing --consumers api        # http service, own schema, api gets a typed client
npm run new:service -- emails --template worker       # queue consumer (enables rabbitmq)
npm run new:service -- reports --db shared            # db: own (default) | shared | none
npm run addon -- redis                                # enable an add-on for the namespace
npm run stack -- use api redis                        # api gets REDIS_URL (validated at boot) + a redis client and /readyz check
npm run link -- api billing                           # api calls billing (BILLING_URL + client)
npm run db:grant -- billing reports read              # reports may SELECT from billing's schema
npm run stack -- remove-service billing               # remove from stack.json (DB role + data are kept, see AGENTS.md)
```

### Service communication

- **Sync:** Kubernetes DNS (`http://billing:3000`) through a typed client generated from the
  callee's contract. `x-request-id` is propagated, so one id traces a request through every service.
- **Async:** RabbitMQ topic exchange. Events are Zod schemas in `contracts`, validated on publish and consume.
- **Database:** each service owns a schema and role. Cross-service access is opt-in via `grants`,
  rendered as declarative `GRANT`/`REVOKE` statements.

### Design decisions

| Decision | Why |
|---|---|
| Tilt for the dev loop | Live-syncs files into running pods (no rebuilds), with one UI and CLI for logs and status |
| Gateway API + Envoy Gateway | ingress-nginx was retired by Kubernetes in March 2026; the Gateway API is the successor to Ingress |
| API under `app.localhost/api`, no separate API host | `app.localhost` and `api.localhost` would be different *sites*, so `SameSite=Lax` session cookies wouldn't be sent cross-host without HTTPS. One origin means first-party cookies and no CORS. Internal services stay cluster-only |
| Schema per service (not DB per service) | Real isolation via roles, while cross-service access stays a simple `GRANT` |
| Zod contracts as the single source of truth | Request/response validation, client types and server types can't drift |
| `stack.json` + generators instead of hand-written YAML | Adding a service or add-on is one command, and the topology is readable in one file |
| Migrations in an init container | Run on every rollout; Knex's lock keeps it safe with multiple replicas |

## Testing & quality

```bash
npm run check     # render --check, eslint (with package-boundary rules), tsc, vitest, script tests
```

## Production images

`infra/docker/node.Dockerfile` also has `prod-node` (bundled with tsup, prod deps only, non-root)
and `prod-web` (static build on nginx) targets. Tilt only uses `dev`.
