import "dotenv/config";
import { defineConfig } from "prisma/config";

const envUrl = process.env["DATABASE_URL"];
const user = process.env["POSTGRES_USER"];
const password = process.env["POSTGRES_PASSWORD"];
const db = process.env["POSTGRES_DB"];
const port = process.env["POSTGRES_PORT"] ?? "5432";

const fallbackUrl =
  user && password && db
    ? `postgresql://${user}:${password}@postgres:${port}/${db}?schema=public`
    : undefined;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: envUrl ?? fallbackUrl,
  },
});
