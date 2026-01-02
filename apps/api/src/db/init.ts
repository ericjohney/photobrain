import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as sqliteVec from "sqlite-vec";
import { existsSync } from "node:fs";
import { config } from "@/config";

export async function initializeDatabase() {
	console.log("🔄 Initializing database...");

	// MacOS *might* have to do this, as the builtin SQLite library on MacOS doesn't allow extensions
	const sqliteLibPath = "/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib";
	if (existsSync(sqliteLibPath)) {
		Database.setCustomSQLite(sqliteLibPath);
	}

	const sqlite = new Database(config.DATABASE_URL);

	// Load sqlite-vec extension for vector similarity search
	sqliteVec.load(sqlite);

	const db = drizzle(sqlite);

	console.log("🔄 Running database migrations...");
	migrate(db, { migrationsFolder: "./drizzle" });
	console.log("✅ Database migrations complete!");

	sqlite.close();
}
