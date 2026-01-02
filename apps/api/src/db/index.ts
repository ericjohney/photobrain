import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";
import { createDatabase } from "./setup";

const sqlite = createDatabase();

export const db = drizzle(sqlite, { schema });
