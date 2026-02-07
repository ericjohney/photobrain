import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { db } from "@/db";

export function createContext(_opts: FetchCreateContextFnOptions) {
	return {
		db,
	};
}

export type Context = Awaited<ReturnType<typeof createContext>>;
