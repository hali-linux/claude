# syntax=docker/dockerfile:1
# ── 1) 의존성 설치 ───────────────────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci

# ── 2) 빌드 ──────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# ── 3) 마이그레이션 전용 이미지 (docker compose의 migrate 서비스) ──
FROM builder AS migrate
# photos 볼륨을 처음 마운트하는 컨테이너가 이 단계이므로, 실행 이미지의 nextjs(1001) 사용자가
# 쓸 수 있도록 소유자를 미리 맞춰둔다(named volume은 최초 마운트 시 소유권을 복사함).
RUN mkdir -p /app/storage && chown 1001:1001 /app/storage
CMD ["npx", "prisma", "migrate", "deploy"]

# ── 4) 실행 이미지 (standalone 출력만 포함 → 작은 이미지) ────────
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    TZ=Asia/Seoul \
    STORAGE_LOCAL_DIR=/app/storage

# 루트가 아닌 사용자로 실행 (컨테이너 탈출 시 피해 최소화)
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs nextjs \
 && mkdir -p /app/storage && chown nextjs:nodejs /app/storage

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
