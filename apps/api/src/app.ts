import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "inngest/hono";
import { config } from "./config";
import { db } from "./db";
import { functions, inngest } from "./inngest";
import { createExportsRouter } from "./routes/exports";
import { createFacesRouter } from "./routes/faces";
import photosRouter from "./routes/photos";
import { createUploadsRouter } from "./routes/uploads";
import { createV1Router } from "./routes/v1";
import { nativeExecutor } from "./services/native-executor";
import { nativeMediaSupport, statfsFreeBytes } from "./services/uploads";
import { searchPhotosByText } from "./services/vector-search";
import { createContext } from "./trpc/context";
import { appRouter } from "./trpc/router";

/** The complete HTTP surface; `index.ts` serves it, the iOS UI-test server wraps it. */
export const app = new Hono();

// CORS middleware
app.use("*", cors());

// Health check endpoint
app.get("/api/health", (c) => {
	return c.json({ status: "ok", timestamp: new Date().toISOString() });
});
// Phone backup uploads (binary bodies; unsuitable for tRPC). Mounted before the
// generic v1 router so its not-found handler never shadows these routes.
app.route(
	"/api/v1/uploads",
	createUploadsRouter({
		database: db,
		photoDirectory: config.PHOTO_DIRECTORY,
		enabled: config.UPLOADS_ENABLED,
		maxBytes: config.UPLOAD_MAX_BYTES,
		media: nativeMediaSupport,
		freeBytes: statfsFreeBytes,
		notifyUploaded: () => inngest.send({ name: "photos/uploaded", data: {} }),
	}),
);
app.route(
	"/api/v1",
	createV1Router({
		database: db,
		searchPhotos: (query, limit, filters, representation) =>
			searchPhotosByText(db, query, limit, filters, representation),
		dispatchScan: (event) => inngest.send(event),
		photoDirectory: config.PHOTO_DIRECTORY,
		thumbnailsDirectory: config.THUMBNAILS_DIRECTORY,
		nativeScanMutationsEnabled: config.V1_NATIVE_SCAN_MUTATIONS_ENABLED,
	}),
);

// tRPC endpoint
app.all("/api/trpc/*", async (c) => {
	return fetchRequestHandler({
		endpoint: "/api/trpc",
		req: c.req.raw,
		router: appRouter,
		createContext,
	});
});

// Binary downloads: single-photo exports and collection ZIPs.
app.route(
	"/api",
	createExportsRouter({
		database: db,
		photoDirectory: config.PHOTO_DIRECTORY,
		renderer: nativeExecutor,
	}),
);

// Binary face crops (people avatars).
app.route(
	"/api",
	createFacesRouter({
		database: db,
		thumbnailsDirectory: config.THUMBNAILS_DIRECTORY,
		renderer: nativeExecutor,
	}),
);

// Keep file serving as REST endpoint (better for streaming)
app.route("/api/photos", photosRouter);

// Inngest endpoint for background job processing
app.on(
	["GET", "PUT", "POST"],
	"/api/inngest",
	serve({
		client: inngest,
		functions,
		serveHost: config.INNGEST_SERVE_ORIGIN,
	}),
);
