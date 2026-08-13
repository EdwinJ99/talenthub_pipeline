# ============================================================================
# STAGE 1 — deps: install dependencies saja (di-cache terpisah biar build
# ulang nggak perlu install ulang semua package kalau cuma source code yang
# berubah)
# ============================================================================
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# ============================================================================
# STAGE 2 — builder: generate Prisma client + build Next.js
# ============================================================================
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Prisma client di-generate saat build, bukan saat runtime
RUN npx prisma generate

# WAJIB: next.config.js/mjs kamu harus punya `output: "standalone"` biar
# hasil build-nya minimal (cuma file yang benar-benar dipakai runtime,
# bukan seluruh node_modules)
RUN npm run build

# ============================================================================
# STAGE 3 — runner: image final yang beneran dipakai di VPS, seringan
# mungkin (nggak ada source code mentah / devDependencies)
# ============================================================================
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Hasil build standalone Next.js
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Prisma client hasil generate + schema (dibutuhkan Prisma di runtime)
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/prisma ./prisma

# Worker script (background job scraper) — ikut di-copy karena image yang
# sama dipakai buat 2 service (web & worker), tinggal beda command
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/lib ./lib

USER nextjs

EXPOSE 3000
ENV PORT=3000

# Default command = jalanin web app. Untuk service worker, command-nya
# di-override lewat docker-compose.yml (lihat file itu).
CMD ["node", "server.js"]