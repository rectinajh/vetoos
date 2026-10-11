# syntax=docker/dockerfile:1
#
# shadowd — the read-only shadow report service.
#
# WHY one stage: the runtime is the TypeScript source itself (tsx), so a build
# stage would only duplicate the workspace. node_modules is installed exactly
# once and the pnpm store is deleted in the same layer, which is what keeps the
# image small. No key can exist in this image: .dockerignore keeps every .env
# out of the build context, and the process strips key-shaped variables at boot.

FROM node:22-alpine

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=development \
    PORT=4477 \
    HOST=0.0.0.0

# pnpm comes from corepack, so the image needs no global install step.
RUN corepack enable

WORKDIR /app

# .dockerignore drops node_modules, .git, logs, .env and .pnpm-store, so this is
# a single source copy; the install below is the only thing that writes modules.
COPY . .

# The committed lockfile has no importer for this package until a maintainer runs
# pnpm install in the repo, so the image resolves the workspace itself instead of
# failing on --frozen-lockfile.
RUN pnpm install --no-frozen-lockfile --prod=false --config.store-dir=/tmp/pnpm-store \
 && rm -rf /tmp/pnpm-store \
 && chown -R node:node /app

# Anything that can write is a liability this service does not need.
USER node

EXPOSE 4477

# busybox wget: a GET on /healthz is the cheapest honest proof the process is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD wget -q -O - "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["pnpm", "exec", "tsx", "apps/shadowd/src/server.ts"]
