FROM node:20 AS base
RUN npm install -g pnpm@9.15.0
WORKDIR /app

FROM base AS mcp-deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/mcp/package.json ./packages/mcp/package.json
COPY packages/sdk/package.json ./packages/sdk/package.json
COPY packages/mcp/patches/ ./packages/mcp/patches/
RUN pnpm install --frozen-lockfile --filter @retaindb/mcp... --ignore-scripts \
    && cp packages/mcp/node_modules/@retaindb/mcp-server/dist/server.js /app/server.js

FROM busybox:1.36 AS mcp-client
COPY --from=mcp-deps /app/server.js /server.js

# Install dependencies
FROM base AS deps
# Build tools needed for native modules (@xenova/transformers / onnxruntime)
RUN apt-get update && apt-get install -y build-essential python3 && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/mcp/patches/ ./packages/mcp/patches/
COPY packages/server/package.json ./packages/server/package.json
RUN pnpm install --frozen-lockfile --filter @retaindb/server...

# Build
FROM deps AS builder
COPY packages/server ./packages/server
COPY packages/local/plugin/scripts/_redact.mjs ./packages/local/plugin/scripts/_redact.mjs
RUN pnpm --filter @retaindb/server run build
RUN pnpm --filter @retaindb/server exec prisma generate

# Runtime
FROM node:20-slim AS runner
# openssl for Prisma, libstdc++/libgomp for onnxruntime native bindings
RUN apt-get update && apt-get install -y openssl libstdc++6 libgomp1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=builder /app/packages/server/package.json ./packages/server/package.json
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/server/prisma ./packages/server/prisma
COPY --from=builder /app/packages/server/dashboard ./packages/server/dashboard

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["sh", "-c", "node packages/server/node_modules/prisma/build/index.js migrate deploy --schema=./packages/server/prisma/schema.prisma && exec node packages/server/dist/index.js"]
