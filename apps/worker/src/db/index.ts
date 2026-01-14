import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "@photobrain/db/schema";

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL || resolve(__dirname, "../../../../apps/api/photobrain.db");

console.log(`📁 Worker DB path: ${DATABASE_URL}`);
const sqlite = new Database(DATABASE_URL);
export const db = drizzle(sqlite, { schema });

// Re-export schema from shared package
export * from "@photobrain/db/schema";
