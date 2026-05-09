# ─── Al-Qadhi Bot Service — Dockerfile ───
# Lightweight Telegram bot using Bun runtime
FROM oven/bun:1-alpine

WORKDIR /app

# Copy dependency manifests first (for better Docker layer caching)
COPY package.json package-lock.json bun.lock* ./

# Install dependencies and generate Prisma client
RUN bun install --frozen-lockfile 2>/dev/null || npm install

# Copy Prisma schema and generate client
COPY prisma/ ./prisma/
RUN bunx prisma generate

# Copy source code (only the bot files, not skills/upload/etc.)
COPY index.ts start.mjs tsconfig.json ./
COPY src/ ./src/

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-8080}/health || exit 1

# Expose health check port
EXPOSE 8080

# Run the bot
CMD ["bun", "run", "start.mjs"]
