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
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.cargo/bin:${PATH}"

# Copy package files first for better layer caching
COPY package.json bun.lock turbo.json ./
COPY packages/image-processing/package.json packages/image-processing/
COPY packages/utils/package.json packages/utils/
COPY packages/config/package.json packages/config/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# Install dependencies
RUN bun install

# Copy source files
COPY packages/image-processing packages/image-processing
COPY packages/utils packages/utils
COPY packages/config packages/config
COPY apps/api apps/api
COPY apps/web apps/web

# Build the image-processing package (Rust/WASM)
RUN bun run build --filter=@photobrain/image-processing

# =============================================================================
# Stage 2: API Production Image
# =============================================================================
FROM oven/bun:1.3.5-slim AS api

WORKDIR /app

# Copy package files
COPY --from=builder /app/package.json /app/bun.lock /app/turbo.json ./

# Copy node_modules
COPY --from=builder /app/node_modules ./node_modules

# Copy image-processing built artifacts only (not the Rust source/target)
COPY --from=builder /app/packages/image-processing/dist ./packages/image-processing/dist
COPY --from=builder /app/packages/image-processing/package.json ./packages/image-processing/

# Copy other packages
COPY --from=builder /app/packages/utils ./packages/utils
COPY --from=builder /app/packages/config ./packages/config

# Copy API app
COPY --from=builder /app/apps/api ./apps/api

WORKDIR /app/apps/api
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]

# =============================================================================
# Stage 3: Web Builder - Build the Vite frontend
# =============================================================================
FROM builder AS web-builder

# Build the web app
RUN bun run build --filter=@photobrain/web

# =============================================================================
# Stage 4: Web Production Image
# =============================================================================
FROM oven/bun:1.3.5-slim AS web

WORKDIR /app

# Copy only what's needed for the static file server
COPY --from=web-builder /app/apps/web/dist ./dist
COPY --from=web-builder /app/apps/web/serve.ts ./serve.ts
COPY --from=web-builder /app/apps/web/src/server-config.ts ./src/server-config.ts
COPY --from=web-builder /app/apps/web/package.json ./package.json

# Install only production dependencies for the server (just zod for config)
RUN bun add zod

EXPOSE 3001
CMD ["bun", "run", "serve.ts"]
