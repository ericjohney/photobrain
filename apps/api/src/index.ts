import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "inngest/hono";
import { config } from "@/config";
import { functions, inngest } from "@/inngest";
import photosRouter from "@/routes/photos";
import { createContext } from "@/trpc/context";
import { appRouter } from "@/trpc/router";

const app = new Hono();

// CORS middleware
app.use("*", cors());

// Health check endpoint
app.get("/api/health", (c) => {
	return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// tRPC endpoint
app.all("/api/trpc/*", async (c) => {
	return fetchRequestHandler({
		endpoint: "/api/trpc",
		req: c.req.raw,
		router: appRouter,
		createContext,
	});
});

// Keep file serving as REST endpoint (better for streaming)
app.route("/api/photos", photosRouter);

// Inngest endpoint for background job processing
app.on(
	["GET", "PUT", "POST"],
	"/api/inngest",
	serve({ client: inngest, functions }),
);

console.log(`🚀 PhotoBrain API starting on ${config.HOST}:${config.PORT}`);
console.log(`📸 Photo directory: ${config.PHOTO_DIRECTORY}`);

// Use Bun.serve for better performance
Bun.serve({
	hostname: config.HOST,
	port: config.PORT,
	fetch: app.fetch,
	// Increase idle timeout for SSE subscriptions (default is 10s)
	idleTimeout: 120,
});
