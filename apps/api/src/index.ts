import { Hono } from "hono";
import { cors } from "hono/cors";
import healthRouter from "./routes/health";
import photosRouter from "./routes/photos";
import imagesRouter from "./routes/images";
import scanRouter from "./routes/scan";

const app = new Hono();

// CORS middleware
app.use("*", cors());

// Mount routes
app.route("/api/health", healthRouter);
app.route("/api/photos", photosRouter);
app.route("/api/image", imagesRouter);
app.route("/api/scan", scanRouter);

const PORT = process.env.PORT || 3000;
const PHOTO_DIRECTORY = process.env.PHOTO_DIRECTORY || "../../temp-photos";

console.log(`🚀 PhotoBrain API starting on port ${PORT}`);
console.log(`📸 Photo directory: ${PHOTO_DIRECTORY}`);

// Use Bun.serve for better performance
Bun.serve({
	port: Number(PORT),
	fetch: app.fetch,
});
