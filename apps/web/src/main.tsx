import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { trpc } from "./lib/trpc";
import { trpcClient } from "./lib/trpc-client";
import "./index.css";
import App from "./App.tsx";

// Mutations, curation, and scan progress invalidate the queries they affect,
// so data stays fresh for a minute instead of refetching (and re-parsing the
// multi-MB library list) on every remount, view switch, or window focus.
const queryClient = new QueryClient({
	defaultOptions: { queries: { staleTime: 60_000 } },
});

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<trpc.Provider client={trpcClient} queryClient={queryClient}>
			<QueryClientProvider client={queryClient}>
				<App />
			</QueryClientProvider>
		</trpc.Provider>
	</StrictMode>,
);
