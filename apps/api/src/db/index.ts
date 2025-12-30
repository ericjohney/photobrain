import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as sqliteVec from "sqlite-vec";
import * as schema from "./schema";
import { existsSync } from "node:fs";

// MacOS *might* have to do this, as the builtin SQLite library on MacOS doesn't allow extensions
const sqliteLibPath = "/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib";
if (existsSync(sqliteLibPath)) {
  Database.setCustomSQLite(sqliteLibPath);
}

const sqlite = new Database(process.env.DATABASE_URL || "./photobrain.db");

// Load sqlite-vec extension for vector similarity search
sqliteVec.load(sqlite);

export const db = drizzle(sqlite, { schema });
