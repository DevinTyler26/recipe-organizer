#!/bin/sh
set -e

if [ -z "${DATABASE_URL}" ]; then
  if [ -z "${POSTGRES_USER}" ] || [ -z "${POSTGRES_PASSWORD}" ] || [ -z "${POSTGRES_DB}" ]; then
    echo "DATABASE_URL is not set and POSTGRES_* vars are missing. Set DATABASE_URL or POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB."
    exit 1
  fi
  DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:${POSTGRES_PORT:-5432}/${POSTGRES_DB}?schema=public"
  export DATABASE_URL
fi

npx prisma migrate deploy
npm run start
