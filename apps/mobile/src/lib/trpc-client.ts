import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { API_URL } from "@/config";
import { trpc } from "./trpc";

export const trpcClient = trpc.createClient({
	links: [
		httpBatchLink({
			url: `${API_URL}/api/trpc`,
			transformer: superjson,
		}),
	],
});
