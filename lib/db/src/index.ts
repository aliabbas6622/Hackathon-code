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

export async function ensureCoreSchema(): Promise<void> {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      name text NOT NULL,
      role text NOT NULL CHECK (role IN ('Lead', 'Contributor', 'Viewer')),
      color text NOT NULL DEFAULT '#3b82f6',
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id text PRIMARY KEY,
      session_id uuid NOT NULL,
      owner_id text,
      locked_to_role text CHECK (locked_to_role IS NULL OR locked_to_role IN ('Lead', 'Contributor', 'Viewer')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      seq_num serial UNIQUE NOT NULL,
      session_id uuid NOT NULL,
      event_type text NOT NULL,
      node_id text,
      user_id text,
      payload jsonb,
      timestamp timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS events_session_seq_idx ON events (session_id, seq_num);
    CREATE INDEX IF NOT EXISTS events_node_idx ON events (node_id);

    CREATE TABLE IF NOT EXISTS tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id uuid NOT NULL,
      node_id text NOT NULL UNIQUE,
      author_id text,
      title text NOT NULL,
      intent_type text NOT NULL CHECK (intent_type IN ('action_item', 'decision', 'open_question', 'reference')),
      confirmed_by_ai boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS tasks_session_updated_idx ON tasks (session_id, updated_at DESC);

    INSERT INTO sessions (id, name)
    VALUES ('00000000-0000-0000-0000-000000000001', 'Main Brainstorm')
    ON CONFLICT (id) DO NOTHING;
  `);
}

export * from "./schema";
