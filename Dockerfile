# ============================================================================
# STAGE 1 — deps: install dependencies
# ============================================================================
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# ============================================================================
# STAGE 2 — runner: image final yang ringan untuk menjalankan script/worker
# ============================================================================
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Salin node_modules dan file project yang dibutuhkan
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY prisma ./prisma
COPY scripts ./scripts
COPY lib ./lib

# Generate Prisma client agar siap dipakai saat runtime
RUN npx prisma generate

CMD ["node"]