## Recipe Organizer

A Next.js app-directory project for saving recipes, parsing their ingredients, and syncing a smart shopping list across every device once you sign in with Google. Data is stored in Postgres via Prisma and exposed through NextAuth-protected API routes.

## Stack

- Next.js 16 (app router, React 19)
- NextAuth (Google provider) + Prisma adapter
- Prisma 5 with PostgreSQL
- Tailwind CSS 4 (vanilla extraction)

## Prerequisites

- Node.js 18+
- PostgreSQL database (local or cloud)
- Google Cloud project with OAuth credentials (Web application type)

## Environment Variables

Copy `.env.example` to `.env` and fill in the values:

| Variable               | Description                                           |
| ---------------------- | ----------------------------------------------------- |
| `DATABASE_URL`         | Postgres connection string used by Prisma.            |
| `GOOGLE_CLIENT_ID`     | OAuth client ID from Google Cloud Console.            |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret from Google Cloud Console.        |
| `AUTH_SECRET`          | Secret used by NextAuth (run `openssl rand -hex 32`). |

For local development, you can run Postgres via Docker:

```bash
docker run --name recipe-db -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16
```

Update `DATABASE_URL` so it matches your credentials/database name.

## Setup

```bash
npm install
npx prisma db push   # or prisma migrate dev if you maintain migrations
npx prisma generate
npm run dev          # launches http://localhost:3000
```

## Available Scripts

```bash
npm run dev     # start Next.js dev server
npm run build   # production build
npm run start   # serve production build
npm run lint    # run eslint across the repo
```

## Auth & Data Flow

- `app/api/recipes` stores recipes per user account.
- `app/api/shopping-list` persists normalized ingredient entries and hydrates the shopping list provider when you sign in.
- Admin accounts are tracked via the `User.isAdmin` column. Flip it to `true` (via SQL or Prisma Studio) for anyone who should manage the whitelist UI at `/whitelist`, which talks to `app/api/allowed-emails`.
- Signed-out users keep data in localStorage; signing in switches to the database-backed experience automatically.

## Running Prisma Migrations

When you update the Prisma schema:

```bash
npx prisma migrate dev --name meaningful_change
npx prisma generate
```

For deployments, use `npx prisma migrate deploy`.

## Deployment Notes

- Ensure the environment variables above are defined in your hosting platform.
- Run `npx prisma migrate deploy && npm run build` during your CI/CD pipeline.

Happy cooking! 🍳
