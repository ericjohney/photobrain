import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabase } from "@/db/setup";

export async function initializeDatabase() {
	console.log("🔄 Initializing database...");

	const sqlite = createDatabase();
	const db = drizzle(sqlite);

	console.log("🔄 Running database migrations...");
	migrate(db, { migrationsFolder: "./drizzle" });
	console.log("✅ Database migrations complete!");

	sqlite.close();
}
