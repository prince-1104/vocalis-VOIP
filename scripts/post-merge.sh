#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Committed migrations are the only schema path; the server refuses to start
# until they are applied. A database built with `drizzle-kit push` must be
# adopted once first: see docs/production-readiness/database-migrations-and-startup.md
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/api-server run db:migrate apply
