// Process entrypoint: serves the shared HTTP app (`./app`) after startup maintenance.
import { app } from "./app";
import { config } from "./config";
import { cleanIncomingUploads } from "./services/uploads";

console.log(`🚀 PhotoBrain API starting on ${config.HOST}:${config.PORT}`);
console.log(`📸 Photo directory: ${config.PHOTO_DIRECTORY}`);

// Remove upload bodies abandoned by a crash before accepting new uploads.
try {
	const removed = await cleanIncomingUploads(config.PHOTO_DIRECTORY);
	if (removed > 0) console.log(`🧹 Removed ${removed} stale incoming uploads`);
} catch (error) {
	console.error("Incoming upload cleanup failed:", error);
}

// Use Bun.serve for better performance
Bun.serve({
	hostname: config.HOST,
	port: config.PORT,
	fetch: app.fetch,
	// Increase idle timeout for SSE subscriptions (default is 10s)
	idleTimeout: 120,
	// Uploads stream bodies up to this size; the route checks Content-Length first.
	maxRequestBodySize: config.UPLOAD_MAX_BYTES,
});
