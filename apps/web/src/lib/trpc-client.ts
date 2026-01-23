import {
	httpBatchLink,
	splitLink,
	unstable_httpSubscriptionLink,
} from "@trpc/client";
import superjson from "superjson";
import { config } from "./config";
import { trpc } from "./trpc";

export const trpcClient = trpc.createClient({
	links: [
		splitLink({
			condition: (op) => op.type === "subscription",
			true: unstable_httpSubscriptionLink({
				url: `${config.apiUrl}/api/trpc`,
				transformer: superjson,
			}),
			false: httpBatchLink({
				url: `${config.apiUrl}/api/trpc`,
				transformer: superjson,
			}),
		}),
	],
});
