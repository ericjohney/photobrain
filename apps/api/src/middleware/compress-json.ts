import type { MiddlewareHandler } from "hono";

/** Responses smaller than this are sent as is. */
const THRESHOLD_BYTES = 1024;

/**
 * gzip (or deflate) for JSON API responses, negotiated through
 * `Accept-Encoding`. The full library listing is several MB of JSON that
 * compresses roughly 10x, and it dominated the web client's load time.
 *
 * Only `application/json` is compressed: binary routes (thumbnails,
 * originals, exports, face crops) are already-compressed media or
 * Range-served files whose `Content-Length` must stay exact, and the tRPC
 * subscription stream (`text/event-stream`) must not be buffered.
 */
export function compressJson(): MiddlewareHandler {
	return async (c, next) => {
		await next();
		const res = c.res;
		const type = res.headers.get("Content-Type") ?? "";
		if (
			c.req.method === "HEAD" ||
			!res.body ||
			!type.startsWith("application/json") ||
			res.headers.has("Content-Encoding")
		) {
			return;
		}
		// Caches must key on the negotiated encoding either way.
		res.headers.append("Vary", "Accept-Encoding");
		const accepted = c.req.header("Accept-Encoding") ?? "";
		const encoding = /\bgzip\b/.test(accepted)
			? "gzip"
			: /\bdeflate\b/.test(accepted)
				? "deflate"
				: null;
		if (encoding === null) return;
		// JSON responses are fully serialized already, so buffering costs
		// nothing and gives an exact size for the threshold.
		const body = await res.arrayBuffer();
		if (body.byteLength < THRESHOLD_BYTES) {
			c.res = new Response(body, res);
			return;
		}
		const compressed = new Response(
			new Blob([body]).stream().pipeThrough(new CompressionStream(encoding)),
			res,
		);
		compressed.headers.delete("Content-Length");
		compressed.headers.set("Content-Encoding", encoding);
		c.res = compressed;
	};
}
