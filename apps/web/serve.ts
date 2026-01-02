const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT || '3001', 10);

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    let filePath = url.pathname;

    // Serve index.html for root or paths without extensions (SPA routing)
    if (filePath === '/' || !filePath.includes('.')) {
      filePath = '/index.html';
    }

    const file = Bun.file(`./dist${filePath}`);

    // Check if file exists
    if (await file.exists()) {
      return new Response(file);
    }

    // Fallback to index.html for SPA routing
    const indexFile = Bun.file('./dist/index.html');
    if (await indexFile.exists()) {
      return new Response(indexFile);
    }

    return new Response('Not Found', { status: 404 });
  },
});

console.log(`Server running at http://${HOST}:${PORT}`);
