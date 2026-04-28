import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

let config: pg.PoolConfig;

try {
  const url = new URL(process.env.DATABASE_URL);
  config = {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    host: url.hostname,
    port: parseInt(url.port || '5432', 10),
    database: url.pathname.slice(1),
    ssl: url.searchParams.get('sslmode') !== 'disable' ? { rejectUnauthorized: false } : false
  };
} catch {
  config = { connectionString: process.env.DATABASE_URL };
}

export const pool = new Pool(config);
export const db = drizzle(pool, { schema });

export * from "./schema";
