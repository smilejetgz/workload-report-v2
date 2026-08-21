// Server/CLI only — never import from client components (better-sqlite3 is native).
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = process.env.WORKLOAD_DB_PATH ?? path.join(DATA_DIR, "app.db");
const MIGRATIONS_DIR = path.join(process.cwd(), "src", "db", "migrations");

// Cache on globalThis so Next dev HMR reuses the same connection.
const globalForDb = globalThis as unknown as { __workloadDb?: Db };

function createDb(): Db {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}

export function getDb(): Db {
  if (!globalForDb.__workloadDb) {
    globalForDb.__workloadDb = createDb();
  }
  return globalForDb.__workloadDb;
}

export { schema };
