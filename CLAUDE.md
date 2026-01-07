# CLAUDE.md - AI Assistant Guide for PhotoBrain

This document provides essential context for AI assistants working with the PhotoBrain codebase.

## Project Overview

**PhotoBrain** is a modern, AI-powered self-hosted photo management application with cross-platform support (Web & Mobile). It combines semantic search capabilities using CLIP embeddings, efficient Rust-based image processing, and a responsive React UI.

- **Version:** 0.1.0
- **Package Manager:** Bun 1.1.0+
- **Build System:** Turbo (monorepo orchestration)
- **Code Quality:** Biome (linting/formatting), TypeScript

## Repository Structure

```
photobrain/
├── apps/
│   ├── api/                 # Backend API (Hono + tRPC + Bun)
│   │   └── src/
│   │       ├── db/          # Drizzle ORM schema and migrations
│   │       ├── routes/      # REST endpoints (photos, health, scan)
│   │       ├── services/    # Business logic
│   │       │   ├── vector-search.ts  # CLIP similarity search
│   │       │   ├── raw-converter.ts  # darktable CLI wrapper
│   │       │   └── raw-formats.ts    # RAW extension detection
│   │       ├── trpc/        # tRPC router and context
│   │       ├── config.ts    # Environment configuration
│   │       ├── scanner.ts   # Directory scanning orchestration
│   │       └── index.ts     # Server entry point
│   │
│   ├── web/                 # React web app (Vite)
│   │   └── src/
│   │       ├── components/  # React components (PhotoGrid, Lightbox, etc.)
│   │       ├── pages/       # Route pages
│   │       ├── lib/         # Utilities (trpc client, thumbnails)
│   │       └── main.tsx     # App entry point
│   │
│   └── mobile/              # React Native Expo app
│       └── src/
│           ├── components/  # React Native components
│           ├── screens/     # Main screens
│           ├── navigation/  # Navigation setup
│           └── config.ts    # App configuration
│
├── packages/
│   ├── utils/               # Shared TypeScript utilities
│   │   └── src/
│   │       └── thumbnails.ts  # Thumbnail size configuration
│   │
│   ├── config/              # Shared TypeScript configuration
│   │
│   └── image-processing/    # Rust NAPI native module
│       └── src/
│           ├── lib.rs       # Module entry point
│           ├── clip.rs      # CLIP text/image embeddings
│           ├── exif.rs      # EXIF metadata extraction
│           ├── heif.rs      # HEIF/HEIC image decoding
│           ├── metadata.rs  # Photo metadata extraction
│           ├── phash.rs     # Perceptual hashing
│           └── thumbnails.rs # WebP thumbnail generation
│
├── biome.json               # Code formatter/linter config
├── turbo.json               # Monorepo build orchestration
├── Dockerfile               # Multi-stage production builds
└── .github/workflows/       # CI/CD pipeline
```

## Tech Stack

### Backend (`apps/api`)
- **Hono** v4.11 - Lightweight TypeScript-first web framework
- **tRPC** v11 - End-to-end type-safe API layer
- **Drizzle ORM** v0.45 - Type-safe database toolkit
- **SQLite** with `sqlite-vec` - Vector similarity search
- **Bun** - JavaScript runtime (server execution)

### Web Frontend (`apps/web`)
- **React** v18.3 - UI library
- **Vite** v6.0 - Build tool and dev server
- **TailwindCSS** v3.4 - Utility-first CSS framework
- **Radix UI** - Accessible component primitives
- **React Router** v7.11 - Client-side routing
- **React Query** v5.62 - Data fetching and caching

### Mobile Frontend (`apps/mobile`)
- **React Native** v0.81 - Cross-platform mobile framework
- **Expo** v54 - React Native development platform
- **React Navigation** v7 - Native navigation
- **expo-image** v3.0 - Optimized image component

### Image Processing (`packages/image-processing`)
- **Rust** with NAPI bindings
- **fastembed** v4.4 - CLIP embeddings
- **image** v0.25 - Image decoding and resizing
- **image_hasher** v2.0 - Perceptual hashing
- **kamadak-exif** v0.5 - EXIF metadata extraction
- **libheif-rs** v0.22 - HEIF/HEIC image decoding

## System Dependencies

For local development, the following system packages are required:

### Linux (Debian/Ubuntu)
```bash
# Required for Rust native module compilation
apt-get install -y build-essential pkg-config libssl-dev libheif-dev libclang-dev

# Required for RAW image conversion
apt-get install -y darktable

# Install Bun
curl -fsSL https://bun.sh/install | bash

# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### Docker Build Dependencies
The Dockerfile requires these packages in the builder stage:
- `libheif-dev` - HEIF/HEIC encoding/decoding headers
- `libclang-dev` - Required by bindgen for FFI generation

The API runtime stage requires:
- `libheif1` - HEIF runtime library
- `darktable` - RAW image conversion (provides darktable-cli)

## Development Commands

```bash
# Install dependencies
bun install

# Build Rust image-processing module (required first time)
cd packages/image-processing && bun run build && cd ../..

# Start all apps in parallel
bun run dev

# Start individual apps
bun run dev:api      # Backend API (port 3000)
bun run dev:web      # Web frontend (port 3001)
bun run dev:mobile   # Expo dev server

# Code quality
bun run typecheck    # Type check all packages
bun run check        # Biome check and auto-fix
bun run lint         # Lint all packages
bun run format       # Format with Biome

# Build for production
bun run build
```

## Code Style & Conventions

### Formatting (Biome)
- **Indentation:** Tabs (not spaces)
- **Quotes:** Double quotes for JavaScript/TypeScript
- **Imports:** Auto-organized on save
- **TailwindCSS:** Directives enabled in CSS parser

Run `bun run check` to auto-fix formatting issues before committing.

### TypeScript
- Strict mode enabled
- Use explicit types for function parameters and return values
- Prefer `type` over `interface` for object types (project convention)
- Export types from `apps/api/src/types.ts` for client consumption

### File Naming
- Components: PascalCase (e.g., `PhotoGrid.tsx`)
- Utilities/services: camelCase (e.g., `vector-search.ts`)
- Config files: lowercase with dashes (e.g., `biome.json`)

### Component Patterns
- React components use functional style with hooks
- Data fetching via tRPC hooks (`trpc.photos.useQuery()`)
- Styling with TailwindCSS utility classes
- Icons from `lucide-react`

## Database Schema

Two main tables in SQLite:

### `photos` table
```typescript
{
  id: integer (PRIMARY KEY, auto-increment)
  path: text (UNIQUE, relative path)
  name: text (filename)
  size: integer (bytes)
  width: integer (pixels)
  height: integer (pixels)
  mimeType: text
  phash: text (64-char hex, perceptual hash)
  clipEmbedding: blob (Float32Array, 512 dimensions)
  createdAt: timestamp
  modifiedAt: timestamp
  // RAW file support
  isRaw: boolean (default false)
  rawFormat: text (e.g., "CR2", "NEF", "ARW")
  rawStatus: text ("converted", "failed", "no_converter")
  rawError: text (error message if conversion failed)
}
```

### `photo_exif` table
```typescript
{
  id: integer (PRIMARY KEY)
  photoId: integer (FOREIGN KEY → photos.id, CASCADE delete)
  cameraMake, cameraModel: text
  lensMake, lensModel: text
  focalLength: integer (mm)
  iso, aperture, shutterSpeed, exposureBias: text/integer
  dateTaken: text (ISO 8601)
  gpsLatitude, gpsLongitude, gpsAltitude: text
}
```

**Vector Search:** Uses `sqlite-vec` extension with L2 distance for CLIP embeddings.

## API Structure

### tRPC Endpoints (type-safe)
| Endpoint | Type | Purpose |
|----------|------|---------|
| `photos` | Query | Get all photos with EXIF |
| `photo` | Query | Get single photo by ID |
| `searchPhotos` | Query | Semantic search with CLIP |
| `scan` | Mutation | Trigger directory scan |

### REST Endpoints (file streaming)
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/health` | GET | Health check |
| `/api/photos/:id/file` | GET | Stream full-resolution photo |
| `/api/photos/:id/thumbnail/:size` | GET | Get thumbnail (tiny/small/medium/large) |

### Thumbnail Sizes
```typescript
tiny:   150px,  80% quality  // Grid views
small:  400px,  85% quality  // Modal previews
medium: 800px,  85% quality  // Lightbox
large:  1600px, 90% quality  // Full view
```

## Key Patterns

### Hybrid API Design
- **tRPC** for typed RPC calls (metadata, search)
- **REST** for binary file streaming (tRPC doesn't handle streaming well)

### Image Processing Pipeline
The scanner processes standard images in a single pass:
1. Read image file
2. Extract metadata (dimensions, MIME type)
3. Extract EXIF data
4. Generate CLIP embeddings (512-dim vector)
5. Compute perceptual hash
6. Generate WebP thumbnails (all sizes)
7. Save to database

### RAW Image Processing
RAW files follow a modified pipeline:
1. Extract EXIF from RAW file directly (before conversion)
2. Convert RAW to temp JPEG via `darktable-cli` (max 1600px)
3. Process temp JPEG through Rust pipeline (embeddings, phash)
4. Generate thumbnails using original RAW relative path
5. Delete temp JPEG
6. Save to database with `isRaw=true`, `rawFormat`, `rawStatus`

**Supported RAW formats:** CR2, CR3, NEF, ARW, DNG, RAF, ORF, RW2, PEF, SRW, X3F, 3FR, IIQ, RWL

**RAW file serving:** For RAW photos, `/api/photos/:id/file` serves the large thumbnail (1600px WebP) since the original RAW cannot be displayed in browsers.

### Deterministic Thumbnail Paths
Thumbnails use predictable paths: `/thumbnails/{size}/{photo-path-hash}.webp`
- No database column needed
- Paths computed from photo path + size
- Enables cache-friendly URLs

### Type Sharing
API types are exported from `@photobrain/api` and consumed by clients:
```typescript
import type { AppRouter } from "@photobrain/api";
import type { inferRouterOutputs } from "@trpc/server";
```

## Environment Configuration

### API (`apps/api`)
```env
HOST=localhost          # Server host
PORT=3000               # Server port
DATABASE_URL=./photobrain.db
PHOTO_DIRECTORY=../../temp-photos
THUMBNAILS_DIRECTORY=./thumbnails
RUN_DB_INIT=true        # Run migrations on startup
```

### Web (`apps/web`)
```env
VITE_API_URL=http://localhost:3000
```

### Mobile (`apps/mobile`)
```env
EXPO_PUBLIC_API_URL=http://localhost:3000
```

## Testing

Currently no test suite is implemented. Validation is done via:
- `bun run typecheck` - Type checking
- `bun run check` - Biome code quality
- Manual testing via dev servers

## Deployment

### Docker
Multi-stage Dockerfile with 4 stages:
1. **builder** - Rust toolchain, build NAPI module
2. **api** - Bun runtime with API code
3. **web-builder** - Vite frontend build
4. **web** - Static file server for frontend

### CI/CD
GitHub Actions workflow:
- Builds Docker images for api and web
- Pushes to `registry.ericj5.com`
- Updates ArgoCD for GitOps deployment

## Common Tasks for AI Assistants

### Adding a New API Endpoint
1. Add tRPC procedure in `apps/api/src/trpc/router.ts`
2. Update types export in `apps/api/src/types.ts` if needed
3. For file streaming, add REST route in `apps/api/src/routes/`

### Adding a New Database Column
1. Update schema in `apps/api/src/db/schema.ts`
2. Create migration in `apps/api/src/db/migrations/`
3. Run migration: API auto-migrates on startup if `RUN_DB_INIT=true`

### Adding a New React Component
1. Create component in `apps/web/src/components/`
2. Use TailwindCSS for styling
3. Use tRPC hooks for data fetching
4. Follow existing component patterns

### Adding Rust Image Processing
1. Add function in `packages/image-processing/src/`
2. Export from `lib.rs`
3. Rebuild: `cd packages/image-processing && bun run build`
4. Import in API: `import { newFunction } from "@photobrain/image-processing"`

### Running the Full Stack
```bash
# Terminal 1: Start API
bun run dev:api

# Terminal 2: Start Web
bun run dev:web

# Or start both:
bun run dev
```

## Roadmap Reference

See `ROADMAP.md` for planned features including:
- Async processing with Temporal workflows
- ~~RAW format support~~ (implemented)
- EXIF-based filtering
- Map view with GPS data
- Duplicate detection UI
- Favorites/starring system

## Important Notes

1. **Always rebuild Rust module** after changes: `cd packages/image-processing && bun run build`
2. **Run `bun run check`** before committing to fix formatting
3. **Thumbnail paths are deterministic** - no database migration needed for path changes
4. **tRPC types are auto-inferred** - no manual type definitions needed for API calls
5. **SQLite file** is at `apps/api/photobrain.db` by default
6. **Thumbnails directory** is at `apps/api/thumbnails/` by default
