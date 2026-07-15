# --- builder: install all deps, compile TS -> dist/ ---
FROM node:25-slim AS builder
WORKDIR /app

RUN npm install -g pnpm@10.24.0

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build          # tsc -> dist/ (also fails the image on type errors)

# --- runner: prod deps + compiled output only ---
FROM node:25-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN npm install -g pnpm@10.24.0

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/dist ./dist
# SQL migrations aren't compiled by tsc — copy them for node-pg-migrate at boot
COPY src/db/migrations ./src/db/migrations

EXPOSE 3000
# migrate, then boot the compiled local entrypoint (see package.json "start")
CMD ["pnpm", "start"]
