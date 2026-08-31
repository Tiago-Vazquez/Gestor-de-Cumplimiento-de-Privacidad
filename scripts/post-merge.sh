#!/bin/bash
# Post-merge: install + apply pending Drizzle migrations.
# db:migrate is idempotent and only applies reviewed, versioned SQL from
# lib/db/drizzle/. Never use drizzle-kit push here: it diffs the schema
# against the live database and can emit destructive DDL. It requires the
# DATABASE_URL provided by the environment (Replit provisions it).
set -e
pnpm install --frozen-lockfile
pnpm --filter @workspace/db run db:migrate
