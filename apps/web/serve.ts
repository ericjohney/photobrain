import { clientConfig, serverConfig } from "./src/server-config";

// Script to inject runtime config into the page
const configScript = `<script>window.__CONFIG__=${JSON.stringify(clientConfig)};</script>`;

async function serveHtmlWithConfig(
	file: ReturnType<typeof Bun.file>,
): Promise<Response> {
	const html = await file.text();
	// Inject config script right after <head> tag
	const injectedHtml = html.replace("<head>", `<head>${configScript}`);
	return new Response(injectedHtml, {
		headers: { "Content-Type": "text/html" },
	});
}

const server = Bun.serve({
	port: serverConfig.PORT,
	hostname: serverConfig.HOST,
	async fetch(req) {
		const url = new URL(req.url);
		const filePath = url.pathname;

		// Serve index.html for root or paths without extensions (SPA routing)
		if (filePath === "/" || !filePath.includes(".")) {
			const indexFile = Bun.file("./dist/index.html");
			if (await indexFile.exists()) {
				return serveHtmlWithConfig(indexFile);
			}
			return new Response("Not Found", { status: 404 });
		}

		const file = Bun.file(`./dist${filePath}`);

		// Check if file exists
		if (await file.exists()) {
			return new Response(file);
		}

		// Fallback to index.html for SPA routing
		const indexFile = Bun.file("./dist/index.html");
		if (await indexFile.exists()) {
			return serveHtmlWithConfig(indexFile);
		}

		return new Response("Not Found", { status: 404 });
	},
});

console.log(
	`Server running at http://${serverConfig.HOST}:${serverConfig.PORT}`,
);
