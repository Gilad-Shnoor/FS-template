# syntax=docker/dockerfile:1.7
# One Dockerfile for every Node workspace (api, web, generated services). Build context = repo root.
#   docker build -f infra/docker/node.Dockerfile --build-arg SERVICE=api --target dev .
# Tilt builds the `dev` target and then live-syncs source files into the running container.

ARG NODE_IMAGE=node:24-alpine

# ---------------------------------------------------------------------------------------------
# manifests: collect only package.json files (+ lockfile) so the install layer below is cached
# until dependencies actually change, no matter how many workspaces exist.
FROM ${NODE_IMAGE} AS manifests
WORKDIR /src
COPY . .
RUN mkdir /out && cp package.json /out/ && (cp package-lock.json /out/ 2>/dev/null || true) \
  && find apps packages -maxdepth 2 -name package.json -not -path '*/node_modules/*' \
     -exec sh -c 'mkdir -p "/out/$(dirname "$1")" && cp "$1" "/out/$1"' _ {} \;

# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /repo
COPY --from=manifests /out/ ./
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

# ---------------------------------------------------------------------------------------------
# dev: full source + dev server with file watching (tsx watch / vite). Used by Tilt.
FROM deps AS dev
ARG SERVICE
ENV SERVICE=${SERVICE} NODE_ENV=development
COPY . .
EXPOSE 3000 5173 9229
CMD ["sh", "-c", "exec npm run dev -w apps/$SERVICE"]

# ---------------------------------------------------------------------------------------------
# Production images (not used by Tilt). Build with --target prod-node or --target prod-web.
FROM dev AS build
RUN npm run build -w apps/$SERVICE

FROM ${NODE_IMAGE} AS prod-node
ARG SERVICE
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=manifests /out/ ./
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi
COPY --from=build /repo/apps/${SERVICE}/dist ./apps/${SERVICE}/dist
WORKDIR /repo/apps/${SERVICE}
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/src/index.js"]

FROM nginx:1.30-alpine AS prod-web
ARG SERVICE=web
COPY --from=build /repo/apps/${SERVICE}/dist /usr/share/nginx/html
RUN printf 'server {\n  listen 80;\n  root /usr/share/nginx/html;\n  location / { try_files $uri /index.html; }\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 80
