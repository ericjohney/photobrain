import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { config } from "@/config";
import * as schema from "@/db/schema";
import { openDatabase } from "@/db/setup";

const sqlite = openDatabase();
const db = drizzle(sqlite, { schema });

// Run migrations on startup if configured
if (config.RUN_DB_INIT) {
	console.log("🔄 Initializing database...");
	console.log("🔄 Running database migrations...");
	migrate(db, { migrationsFolder: "./drizzle" });
	console.log("✅ Database migrations complete!");
}

export { db };
