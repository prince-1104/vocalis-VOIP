import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

const dbUrl = process.env.DATABASE_URL;
const needsSsl = process.env.DATABASE_SSL === "true" || dbUrl.includes("sslmode=require") || dbUrl.includes("sslmode=verify");

export default defineConfig({
  schema: "./src/schema/*",
  dialect: "postgresql",
  dbCredentials: {
    url: dbUrl,
    ...(needsSsl ? { ssl: "require" } : {})
  },
});
