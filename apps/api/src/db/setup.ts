import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import * as sqliteVec from "sqlite-vec";
import { config } from "@/config";

/**
 * Opens and configures a SQLite database connection
 * Handles MacOS-specific SQLite library setup and loads sqlite-vec extension
 */
export function openDatabase(): Database {
	// MacOS *might* have to do this, as the builtin SQLite library on MacOS doesn't allow extensions
	const sqliteLibPath = "/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib";
	if (existsSync(sqliteLibPath)) {
		Database.setCustomSQLite(sqliteLibPath);
	}

	const sqlite = new Database(config.DATABASE_URL);

	// Load sqlite-vec extension for vector similarity search
	sqliteVec.load(sqlite);

	return sqlite;
}
