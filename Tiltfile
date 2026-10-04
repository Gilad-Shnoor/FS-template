# -*- mode: Python -*-
# Dev loop for the whole stack. Run `tilt up` (or `npm run dev`); UI at http://localhost:10350.
#
# Nothing here is service-specific: all topology comes from stack.json, rendered by
# `node scripts/stack.mjs render` into infra/k8s/ (manifests) and infra/k8s/generated/tilt.json
# (this file's plan). Edit stack.json and Tilt reloads itself.

version_settings(constraint='>=0.33.0')
update_settings(max_parallel_updates=4, k8s_upsert_timeout_secs=180)
# Every Secret here holds a fixed dev-only value (e.g. POSTGRES_USER=postgres). Scrubbing them
# rewrote every occurrence of "postgres" in the logs (pod names, images) to "[redacted secret …]".
secret_settings(disable_scrub=True)

# 1. Render manifests from stack.json (fails loudly with a readable list if stack.json is invalid).
local('node scripts/stack.mjs render', quiet=True)
watch_file('stack.json')
watch_file('scripts/lib')
plan = read_json('infra/k8s/generated/tilt.json')

# Safety: never deploy this to a real cluster by accident.
allow_k8s_contexts(plan['kubeContext'])
if k8s_context() != plan['kubeContext']:
    fail('kubectl context is "%s" but stack.json expects "%s". Run: kubectl config use-context %s' % (
        k8s_context(), plan['kubeContext'], plan['kubeContext']))

k8s_yaml(kustomize('infra/k8s'))
ns = plan['namespace']

# 2. Infrastructure
k8s_resource('postgres', labels=['infra'], port_forwards=['%d:5432' % plan['postgresLocalPort']])
k8s_resource('db-provision', labels=['infra'], resource_deps=['postgres'])
k8s_resource(new_name='networking', objects=plan['networkingObjects'], labels=['infra'])
k8s_resource(new_name='config', objects=plan['configObjects'], labels=['infra'])
for addon in plan['addons']:
    k8s_resource(addon['name'], labels=['infra'], port_forwards=addon['portForwards'], links=addon['links'])

# 3. Services: one image per service from the shared Dockerfile, with live sync instead of rebuilds.
# Every image syncs apps/ and packages/ (shared code changes reach every service); each service's
# dev server only reloads for files it actually imports. package.json changes trigger a rebuild.
ignore = ['**/node_modules', '**/dist', '.git', 'infra', 'scripts', 'templates', '**/*.md', '**/*.test.ts']

for svc in plan['services']:
    name = svc['name']
    docker_build(
        svc['image'],
        context='.',
        dockerfile='infra/docker/node.Dockerfile',
        target='dev',
        build_args={'SERVICE': name},
        # Only what the image needs. Without this, editing any root file (stack.json, eslint config,
        # an editor's temp file) matched no sync rule and forced a full rebuild of every image.
        only=['apps', 'packages', 'package.json', 'package-lock.json', 'tsconfig.base.json'],
        ignore=ignore,
        live_update=[
            fall_back_on(['package.json', 'package-lock.json', 'apps/%s/package.json' % name, 'packages/contracts/package.json', 'packages/server-kit/package.json']),
            sync('apps', '/repo/apps'),
            sync('packages', '/repo/packages'),
        ],
    )
    k8s_resource(
        name,
        labels=['services'],
        resource_deps=svc['deps'],
        links=svc['links'],
        # Attach a debugger (VS Code "Attach to Node", or chrome://inspect) to localhost:<port>.
        port_forwards=['%d:9229' % svc['debugPort']] if svc['debugPort'] else [],
    )

    if svc['migrate']:
        # Migrations run automatically in an initContainer on every rollout. This resource also
        # re-runs them whenever a migration file changes, without restarting the pod.
        local_resource(
            '%s-migrate' % name,
            cmd='kubectl --context %s -n %s exec deploy/%s -c %s -- npm run db:migrate -w apps/%s' % (plan['kubeContext'], ns, name, name, name),
            deps=['apps/%s/migrations' % name],
            resource_deps=[name],
            labels=['db'],
        )
        local_resource(
            '%s-seed' % name,
            cmd='kubectl --context %s -n %s exec deploy/%s -c %s -- npm run db:seed -w apps/%s' % (plan['kubeContext'], ns, name, name, name),
            resource_deps=[name],
            trigger_mode=TRIGGER_MODE_MANUAL,
            auto_init=False,
            labels=['db'],
        )

# 4. Host-side helpers
# Regenerates apps/web/src/routeTree.gen.ts on the host (the in-container copy isn't synced back),
# so your editor and `npm run typecheck` see new routes immediately.
if 'web' in [s['name'] for s in plan['services']]:
    local_resource('web-routes', serve_cmd='npm run routes:watch -w apps/web', labels=['tools'])

local_resource('typecheck', cmd='npm run typecheck', trigger_mode=TRIGGER_MODE_MANUAL, auto_init=False, labels=['tools'])
local_resource('test', cmd='npm test', trigger_mode=TRIGGER_MODE_MANUAL, auto_init=False, labels=['tools'])
