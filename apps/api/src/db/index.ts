import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "@/db/schema";
import { createDatabase } from "@/db/setup";

const sqlite = createDatabase();

export const db = drizzle(sqlite, { schema });
