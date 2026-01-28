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
COPY apps/mobile/package.json apps/mobile/

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
# Stage 6: Mobile Expo Dev Server
# Runs the Expo dev server so Expo Go on Android can connect to it.
# =============================================================================
FROM oven/bun:1.3.5-debian AS mobile

WORKDIR /app

# Copy package files for dependency installation
COPY package.json bun.lock turbo.json ./
COPY packages/utils/package.json packages/utils/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/image-processing/package.json packages/image-processing/
COPY apps/mobile/package.json apps/mobile/

# Install dependencies
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install

# Copy workspace packages needed by the mobile app
COPY packages/utils packages/utils
COPY packages/config packages/config
COPY packages/db packages/db
COPY packages/image-processing/browser.js packages/image-processing/browser.js

# Copy mobile app source
COPY apps/mobile apps/mobile

WORKDIR /app/apps/mobile

EXPOSE 8081
CMD ["bunx", "expo", "start", "--non-interactive", "--port", "8081"]
