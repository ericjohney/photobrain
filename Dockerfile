# =============================================================================
# Stage 1: Builder - Install dependencies and build Rust/WASM
# =============================================================================
FROM oven/bun:1.3.5-debian AS builder
WORKDIR /app

# Install Rust toolchain and build dependencies
RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
    pkg-config \
    libssl-dev \
    libclang-dev \
    libheif-dev \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.cargo/bin:${PATH}"

# Copy package files first for better layer caching
COPY package.json bun.lock turbo.json ./
COPY packages/image-processing/package.json packages/image-processing/
COPY packages/utils/package.json packages/utils/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/

# Install dependencies with cache mount
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install

# Copy source files
COPY packages/image-processing packages/image-processing
COPY packages/utils packages/utils
COPY packages/config packages/config
COPY packages/db packages/db
COPY apps/api apps/api
COPY apps/web apps/web

# Build the image-processing package (Rust/WASM) with Cargo cache mount
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cargo/git \
    --mount=type=cache,target=/app/packages/image-processing/target \
    bun run build --filter=@photobrain/image-processing

# =============================================================================
# Stage 2: API Production Image
# =============================================================================
FROM oven/bun:1.3.5-slim AS api

# Install CA certificates (for HTTPS model downloads), exiftool and native module dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libimage-exiftool-perl \
    libssl3 \
    libzstd1 \
    libheif1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY --from=builder /app/package.json /app/bun.lock /app/turbo.json ./

# Copy node_modules (will prune after)
COPY --from=builder /app/node_modules ./node_modules

# Copy image-processing - only the linux binary (not darwin)
COPY --from=builder /app/packages/image-processing/dist/index.js ./packages/image-processing/dist/
COPY --from=builder /app/packages/image-processing/dist/index.d.ts ./packages/image-processing/dist/
COPY --from=builder /app/packages/image-processing/dist/*.linux-*.node ./packages/image-processing/dist/
COPY --from=builder /app/packages/image-processing/package.json ./packages/image-processing/

# Copy other packages
COPY --from=builder /app/packages/utils ./packages/utils
COPY --from=builder /app/packages/config ./packages/config
COPY --from=builder /app/packages/db ./packages/db

# Copy API app source (not dist)
COPY --from=builder /app/apps/api/src ./apps/api/src
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/apps/api/tsconfig.json ./apps/api/

# Remove darwin native modules from node_modules
RUN find /app/node_modules -name "*.darwin-*.node" -delete 2>/dev/null || true

WORKDIR /app/apps/api
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]

# =============================================================================
# Stage 3: Worker Production Image (BullMQ worker with Bun)
# =============================================================================
FROM oven/bun:1.3.5-slim AS worker

# Install CA certificates (for HTTPS model downloads), exiftool and native module dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libimage-exiftool-perl \
    libssl3 \
    libzstd1 \
    libheif1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY --from=builder /app/package.json /app/bun.lock /app/turbo.json ./

# Copy node_modules
COPY --from=builder /app/node_modules ./node_modules

# Copy image-processing - only the linux binary
COPY --from=builder /app/packages/image-processing/dist/index.js ./packages/image-processing/dist/
COPY --from=builder /app/packages/image-processing/dist/index.d.ts ./packages/image-processing/dist/
COPY --from=builder /app/packages/image-processing/dist/*.linux-*.node ./packages/image-processing/dist/
COPY --from=builder /app/packages/image-processing/package.json ./packages/image-processing/

# Copy other packages
COPY --from=builder /app/packages/utils ./packages/utils
COPY --from=builder /app/packages/config ./packages/config
COPY --from=builder /app/packages/db ./packages/db

# Copy worker app source (runs directly with Bun, no build step)
COPY apps/worker ./apps/worker

# Remove darwin native modules
RUN find /app/node_modules -name "*.darwin-*.node" -delete 2>/dev/null || true

WORKDIR /app/apps/worker

ENV REDIS_URL=redis://redis:6379
ENV DATABASE_PATH=/data/photobrain.db

CMD ["bun", "run", "src/index.ts"]

# =============================================================================
# Stage 4: Web Builder - Build the Vite frontend
# =============================================================================
FROM builder AS web-builder

# Build the web app
RUN bun run build --filter=@photobrain/web

# =============================================================================
# Stage 5: Web Production Image
# =============================================================================
FROM oven/bun:1.3.5-slim AS web

WORKDIR /app

# Copy only what's needed for the static file server
COPY --from=web-builder /app/apps/web/dist ./dist
COPY --from=web-builder /app/apps/web/serve.ts ./serve.ts
COPY --from=web-builder /app/apps/web/src/server-config.ts ./src/server-config.ts

# Create a minimal package.json for the static file server (no workspace deps)
RUN echo '{"name":"photobrain-web","type":"module","dependencies":{"zod":"^4.2.1"}}' > package.json && bun install

EXPOSE 3001
CMD ["bun", "run", "serve.ts"]

# =============================================================================
# Stage 6: Mobile Web Builder - Build the Expo web app
# =============================================================================
FROM builder AS mobile-builder

WORKDIR /app

# Copy mobile app source
COPY apps/mobile ./apps/mobile

# Build mobile web export
RUN cd apps/mobile && bun run build:web

# =============================================================================
# Stage 7: Mobile Web Production Image
# =============================================================================
FROM oven/bun:1.3.5-slim AS mobile

WORKDIR /app

# Copy the Expo web build output
COPY --from=mobile-builder /app/apps/mobile/dist ./dist

# Create a simple static file server
RUN echo '{"name":"photobrain-mobile","type":"module","dependencies":{"zod":"^4.2.1"}}' > package.json && bun install

# Create the serve script
RUN cat > serve.ts << 'EOF'
import { z } from "zod";

const configSchema = z.object({
  PORT: z.coerce.number().default(3002),
  HOST: z.string().default("0.0.0.0"),
});

const config = configSchema.parse(process.env);

const server = Bun.serve({
  port: config.PORT,
  hostname: config.HOST,
  async fetch(req) {
    const url = new URL(req.url);
    let pathname = url.pathname;

    // Try to serve the file directly
    let file = Bun.file(`./dist${pathname}`);

    // If the path doesn't have an extension, try adding .html
    if (!pathname.includes(".") || !(await file.exists())) {
      file = Bun.file(`./dist${pathname}/index.html`);
    }

    // Fallback to index.html for SPA routing
    if (!(await file.exists())) {
      file = Bun.file("./dist/index.html");
    }

    if (await file.exists()) {
      const contentType = getContentType(file.name || "");
      return new Response(file, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": pathname.includes("/_expo/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

function getContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    html: "text/html",
    js: "application/javascript",
    css: "text/css",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
  };
  return types[ext || ""] || "application/octet-stream";
}

console.log(`Mobile web server running at http://${config.HOST}:${config.PORT}`);
EOF

EXPOSE 3002
CMD ["bun", "run", "serve.ts"]
