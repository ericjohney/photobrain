import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { trpc } from "./trpc";
import { API_URL } from "../config";

export const trpcClient = trpc.createClient({
	links: [
		httpBatchLink({
			url: `${API_URL}/api/trpc`,
			transformer: superjson,
		}),
	],
});
