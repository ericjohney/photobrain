import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { config } from "@/config";
import * as schema from "@/db/schema";
import { openDatabase } from "@/db/setup";

// Run migrations on startup if configured
if (config.RUN_DB_INIT) {
	console.log("🔄 Initializing database...");
	const tempDb = openDatabase();
	const drizzleDb = drizzle(tempDb);

	console.log("🔄 Running database migrations...");
	migrate(drizzleDb, { migrationsFolder: "./drizzle" });
	console.log("✅ Database migrations complete!");

	tempDb.close();
}

// Create main database connection
const sqlite = openDatabase();

export const db = drizzle(sqlite, { schema });
