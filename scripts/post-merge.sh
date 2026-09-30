#!/bin/bash
# Post-merge: install + apply pending Drizzle migrations.
# db:migrate is idempotent and only applies reviewed, versioned SQL from
# lib/db/drizzle/. Never use drizzle-kit push here: it diffs the schema
# against the live database and can emit destructive DDL. It requires the
# superuser connection provided by the environment (Replit provisions it).
# M22: las migraciones usan ADMIN_DATABASE_URL (superusuario `privacy`); por
# compatibilidad con Replit, si solo está DATABASE_URL se mapea a la variable
# de administración (Replit la provee como superusuario).
set -e
export ADMIN_DATABASE_URL="${ADMIN_DATABASE_URL:-$DATABASE_URL}"
pnpm install --frozen-lockfile
pnpm --filter @workspace/db run db:migrate
