import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { config } from "./config";
import { trpc } from "./trpc";

export const trpcClient = trpc.createClient({
	links: [
		httpBatchLink({
			url: `${config.apiUrl}/api/trpc`,
			transformer: superjson,
		}),
	],
});
