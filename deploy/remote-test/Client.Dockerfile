FROM node:24.18.1-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ openssl libnss3-tools ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --no-audit --no-fund
# The bundled ARM64 glibc prebuild may target a newer glibc than Bookworm.
# Compile against this image and prove native loading before running tests.
RUN cd node_modules/better-sqlite3 \
    && node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild --release --force_build=1
# better-sqlite3 prefers bundled prebuilds over its freshly compiled binding.
RUN rm -rf node_modules/better-sqlite3/prebuilds
RUN node -e "const db = require('better-sqlite3')(':memory:'); db.prepare('SELECT 1').get(); db.close()"
RUN npx playwright install --with-deps chromium
COPY . .
RUN npm run build
CMD ["node", "scripts/remote-test/client.mjs"]
