# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat

FROM base AS deps
COPY package*.json ./
RUN npm ci

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma

EXPOSE 3000

# dist/main.js, not dist/server.js.
#
# server.js starts the HTTP API and nothing else. The repeatable jobs — the
# reminder engine tick above all — are registered by worker.js, via
# startScheduledJobs(). A container running server.js alone therefore accepts
# requests, writes reminders, and never sends one: they accumulate as PENDING
# rows with nothing scheduled to claim them. That is not hypothetical; it is
# why reminders had been queued and never delivered.
#
# main.js is `import './worker'; import './server';` — both in one process,
# which is what this single-service deployment needs. If the worker is ever
# split onto its own service, that service runs dist/worker.js and this stays
# dist/server.js; until then, running only half of it silently loses reminders.
CMD ["node", "-r", "module-alias/register", "dist/main.js"]