# =============================================================================
# Stage 1: Builder - Install dependencies and build the Rust N-API addon
# =============================================================================
FROM oven/bun:1.4.3-debian AS builder
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
COPY packages/raw-develop/package.json packages/raw-develop/
COPY packages/utils/package.json packages/utils/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# Install dependencies with cache mount
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --linker hoisted

# Copy source files
COPY packages/image-processing packages/image-processing
# Path dependency of image-processing (loupe "Developed" RAW renders).
COPY packages/raw-develop packages/raw-develop
COPY packages/utils packages/utils
COPY packages/config packages/config
COPY packages/db packages/db
COPY apps/api apps/api
COPY apps/web apps/web

# Build the Rust N-API image-processing package with Cargo cache mount
# Cache ORT beside Cargo: cached build outputs symlink into its download directory.
# napi --platform uses an explicit Rust target directory even on native Linux.
ARG DENOISE_CUDA=0
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cargo/git \
    --mount=type=cache,target=/root/.cache/ort.pyke.io \
    --mount=type=cache,target=/app/packages/image-processing/target \
    mkdir -p /app/onnxruntime/lib && \
    if [ "$DENOISE_CUDA" = "1" ]; then \
      cd packages/image-processing && \
      bun run build --features adobe-denoise-cuda && \
      cp -L target/x86_64-unknown-linux-gnu/release/libonnxruntime.so \
        target/x86_64-unknown-linux-gnu/release/libonnxruntime_providers_cuda.so \
        target/x86_64-unknown-linux-gnu/release/libonnxruntime_providers_shared.so /app/onnxruntime/lib/ && \
      ln -s libonnxruntime.so /app/onnxruntime/lib/libonnxruntime.so.1; \
    else \
      bun run build --filter=@photobrain/image-processing; \
    fi

# =============================================================================
# Stage 2: API Production Image
# =============================================================================
FROM oven/bun:1.4.3-slim AS api

# Install CA certificates (for HTTPS model downloads), exiftool, ffmpeg/ffprobe (video posters) and native module dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libimage-exiftool-perl \
    ffmpeg \
    libssl3 \
    libzstd1 \
    libheif1 \
    libvulkan1 \
    libx11-6 \
    libxext6 \
    libegl1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV RUN_DB_INIT=true

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

# Optional CUDA/cuDNN API image. Build with --target api-cuda --build-arg
# DENOISE_CUDA=1. Ordinary api/web builds retain their current runtime.
FROM nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04@sha256:8aef630a54bc5c5146ae5ce68e6af5caa3df0fb690bb91544175c91f307e4356 AS cuda-runtime
FROM api AS api-cuda
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*
# Keep the existing Debian native dependencies, including libheif >= 1.18.
# CUDA's user-space libraries do not include a driver; the NVIDIA runtime injects it.
COPY --from=cuda-runtime /usr/local/cuda/targets/x86_64-linux/lib /opt/cuda/lib
COPY --from=cuda-runtime /usr/lib/x86_64-linux-gnu/libcudnn*.so* /opt/cuda/lib/
COPY --from=builder /app/onnxruntime /opt/onnxruntime
RUN test -s /opt/onnxruntime/lib/libonnxruntime_providers_cuda.so
ENV LD_LIBRARY_PATH="/opt/onnxruntime/lib:/opt/cuda/lib:/usr/local/nvidia/lib:/usr/local/nvidia/lib64"
ENV NVIDIA_DRIVER_CAPABILITIES="compute,utility,graphics"
ENV RUN_DB_INIT=true
ENV DENOISE_BACKEND=cuda
ENV NVIDIA_TF32_OVERRIDE=0
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
FROM oven/bun:1.4.3-slim AS web

WORKDIR /app

# Copy only what's needed for the static file server
COPY --from=web-builder /app/apps/web/dist ./dist
COPY --from=web-builder /app/apps/web/serve.ts ./serve.ts
COPY --from=web-builder /app/apps/web/src/server-config.ts ./src/server-config.ts

# Create a minimal package.json for the static file server (no workspace deps)
RUN echo '{"name":"photobrain-web","type":"module","dependencies":{"zod":"^4.2.1"}}' > package.json && bun install

EXPOSE 3001
CMD ["bun", "run", "serve.ts"]
