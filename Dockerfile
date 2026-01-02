FROM oven/bun:1.3.5 AS base
WORKDIR /app
RUN apt-get update && apt-get install -y curl build-essential pkg-config libssl-dev && \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable && \
    rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.cargo/bin:${PATH}"
COPY . ./
# RUN bun install --frozen-lockfile
RUN bun install
RUN bun run build --filter=@photobrain/image-processing

# API
FROM base AS api
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["bun", "run", "dev"]

# Web
FROM base AS web
WORKDIR /app
RUN bun run build --filter=@photobrain/web
WORKDIR /app/apps/web
EXPOSE 3001
CMD ["bun", "run", "serve.ts"]
