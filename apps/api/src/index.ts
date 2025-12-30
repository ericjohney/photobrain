import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "@/config";
import healthRouter from "@/routes/health";
import photosRouter from "@/routes/photos";
import imagesRouter from "@/routes/images";
import scanRouter from "@/routes/scan";

const app = new Hono();

// CORS middleware
app.use("*", cors());

// Mount routes
app.route("/api/health", healthRouter);
app.route("/api/photos", photosRouter);
app.route("/api/image", imagesRouter);
app.route("/api/scan", scanRouter);

console.log(`🚀 PhotoBrain API starting on port ${config.PORT}`);
console.log(`📸 Photo directory: ${config.PHOTO_DIRECTORY}`);

// Use Bun.serve for better performance
Bun.serve({
	port: config.PORT,
	fetch: app.fetch,
});
