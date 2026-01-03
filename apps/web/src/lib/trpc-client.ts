import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { trpc } from "./trpc";
import { config } from "./config";

export const trpcClient = trpc.createClient({
	links: [
		httpBatchLink({
			url: `${config.apiUrl}/api/trpc`,
			transformer: superjson,
		}),
	],
});
