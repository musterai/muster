# Stage 1: Build Frontend & Backend TypeScript. MUS-80 owns the broader Node
# support-policy change; this production image deliberately uses a maintained
# LTS line rather than extending the Node 20 image lifecycle.
FROM node:24.18.1-alpine3.23 AS builder

WORKDIR /app

# Install build tools for better-sqlite3 native compilation. Keep these in
# the builder only; the runtime image contains production dependencies only.
RUN apk add --no-cache python3 make g++ gcc

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Production Runtime
FROM node:24.18.1-alpine3.23 AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV MUSTER_PORT=6878
ENV MUSTER_HOST=0.0.0.0
ENV MUSTER_AUTH_MODE=enforced

RUN apk add --no-cache curl
RUN addgroup -S muster && adduser -S -G muster muster

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder --chown=muster:muster /app/dist ./dist
COPY --from=builder --chown=muster:muster /app/public ./public
COPY --from=builder --chown=muster:muster /app/src/db/migrations ./dist/db/migrations

# Data volume directory for SQLite database persistence
RUN mkdir -p /app/data \
  && chown -R muster:muster /app
VOLUME ["/app/data"]

USER muster

EXPOSE 6878

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:6878/api/v1/health/ready || exit 1

CMD ["node", "dist/index.js"]
