import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { openDatabase } from "@/db/setup";

const sqlite = openDatabase();
const db = drizzle(sqlite);

console.log("Running migrations...");
migrate(db, { migrationsFolder: "./drizzle" });
console.log("Migrations complete!");

sqlite.close();
