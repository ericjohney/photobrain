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
│   │       ├── db/          # Drizzle ORM migrations
│   │       ├── routes/      # REST endpoints (photos, health)
│   │       ├── services/    # Business logic
│   │       │   └── vector-search.ts  # CLIP similarity search
│   │       ├── trpc/        # tRPC router and context
│   │       ├── config.ts    # Environment configuration
│   │       └── index.ts     # Server entry point
│   │
│   ├── worker/              # BullMQ job worker (Bun)
│   │   └── src/
│   │       ├── queues/      # Queue definitions (scan, phash, embedding)
│   │       ├── workers/     # Job processors
│   │       ├── activities/  # Shared activities (scan, phash, embedding)
│   │       └── index.ts     # Worker entry point
│   │
│   ├── web/                 # React web app (Vite)
│   │   └── src/
│   │       ├── components/  # React components
│   │       │   ├── panels/  # Panel system (PanelLayout, MetadataPanel)
│   │       │   ├── ui/      # shadcn/ui primitives
│   │       │   ├── PhotoGrid.tsx    # Thumbnail grid with selection
│   │       │   ├── Filmstrip.tsx    # Horizontal thumbnail strip
│   │       │   ├── LoupeView.tsx    # Single photo view with zoom
│   │       │   └── Toolbar.tsx      # Top toolbar with controls
│   │       ├── hooks/       # State management hooks
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
│   │       ├── thumbnails.ts  # Thumbnail size configuration
│   │       └── tasks.ts       # Task type definitions for job progress
│   │
│   ├── config/              # Shared TypeScript configuration
│   │
│   ├── db/                  # Shared database schema (Drizzle ORM)
│   │   ├── drizzle/           # Database migrations
│   │   └── src/
│   │       ├── schema.ts      # Table definitions
│   │       └── index.ts       # Database connection
│   │
│   └── image-processing/    # Rust NAPI native module
│       └── src/
│           ├── lib.rs       # Module entry point
│           ├── batch.rs     # Unified photo processing (all types)
│           ├── raw.rs       # RAW image processing (LibRaw)
│           ├── clip.rs      # CLIP text/image embeddings
│           ├── exif.rs      # EXIF metadata extraction
│           ├── heif.rs      # HEIF/HEIC image decoding
│           ├── metadata.rs  # Photo metadata extraction
│           ├── phash.rs     # Perceptual hashing
│           └── thumbnails.rs # WebP thumbnail generation (parallel)
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
- **BullMQ** v5.x - Job queue for async processing
- **Redis/Valkey** - Queue storage backend
- **Bun** - JavaScript runtime (server execution)

### Worker (`apps/worker`)
- **BullMQ** v5.x - Job queue processing
- **Bun** - JavaScript runtime
- Processes scan, phash, and embedding jobs asynchronously
- Shares database schema via `@photobrain/db` package

### Web Frontend (`apps/web`)
- **React** v18.3 - UI library
- **Vite** v6.0 - Build tool and dev server
- **TailwindCSS** v3.4 - Utility-first CSS framework
- **Radix UI** - Accessible component primitives (shadcn/ui)
- **React Router** v7.11 - Client-side routing
- **React Query** v5.62 - Data fetching and caching
- **react-resizable-panels** v4.3 - Resizable panel layout

### Mobile Frontend (`apps/mobile`)
- **React Native** v0.81 - Cross-platform mobile framework
- **Expo** v54 - React Native development platform
- **React Navigation** v7 - Native navigation
- **expo-image** v3.0 - Optimized image component

### Image Processing (`packages/image-processing`)
- **Rust** with NAPI bindings
- **rsraw** v0.1 - RAW image processing (LibRaw bindings)
- **rayon** v1.10 - Parallel processing
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
bun run dev:worker   # BullMQ job worker
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

## Web UI Design System

The web app uses an **Adobe Lightroom-inspired design** with a professional photo management layout.

### Layout Architecture
```
+------------------+------------------------+------------------+
|  Left Panel      |     Center Content     |   Right Panel    |
|  (Navigation)    |     (Grid/Loupe)       |   (Metadata)     |
+------------------+------------------------+------------------+
|                      Filmstrip                               |
+--------------------------------------------------------------+
```

### Color Palette (CSS Variables in `index.css`)
- **Light mode**: Clean professional look (light gray backgrounds)
- **Dark mode**: Lightroom-style dark theme (`#1d1d1d` backgrounds)
- **Accent color**: Blue (`hsl(210 100% 50%)`) for selection states
- Custom tokens: `--panel`, `--toolbar`, `--filmstrip`, `--selection`

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| `PanelLayout` | `components/panels/PanelLayout.tsx` | Three-panel resizable layout |
| `MetadataPanel` | `components/panels/MetadataPanel.tsx` | EXIF display with collapsible sections |
| `PhotoGrid` | `components/PhotoGrid.tsx` | Dense thumbnail grid with selection |
| `Filmstrip` | `components/Filmstrip.tsx` | Horizontal thumbnail navigation |
| `LoupeView` | `components/LoupeView.tsx` | Full-bleed single photo view |
| `Toolbar` | `components/Toolbar.tsx` | View controls, search, actions |

### State Management Hooks

| Hook | File | Purpose |
|------|------|---------|
| `useLibraryState` | `hooks/use-library-state.ts` | View mode, selection, thumbnail size |
| `usePanelState` | `hooks/use-panel-state.ts` | Panel visibility with localStorage |
| `useKeyboardShortcuts` | `hooks/use-keyboard-shortcuts.ts` | Lightroom-style shortcuts |

### Keyboard Shortcuts
- `G` - Grid view
- `E` - Loupe view
- `Tab` - Toggle all panels
- `Shift+Space` - Toggle filmstrip
- `Arrow keys` - Navigate photos
- `Escape` - Return to grid / clear selection
- `Ctrl/Cmd+A` - Select all

### Selection Behavior
- **Single click**: Select photo
- **Shift+click**: Range selection
- **Ctrl/Cmd+click**: Toggle selection
- **Double-click**: Open in loupe view

## Database Schema

The database uses SQLite with sidecar tables for computed data (embeddings, hashes).

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
  createdAt: timestamp
  modifiedAt: timestamp
  // RAW file support
  isRaw: boolean (default false)
  rawFormat: text (e.g., "CR2", "NEF", "ARW")
  rawStatus: text ("converted", "failed", "no_converter")
  rawError: text (error message if conversion failed)
  // Processing status tracking
  thumbnailStatus: text ("pending", "completed", "failed")
  embeddingStatus: text ("pending", "completed", "failed")
  phashStatus: text ("pending", "completed", "failed")
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

### `photo_embedding` table (sidecar)
```typescript
{
  id: integer (PRIMARY KEY)
  photoId: integer (FOREIGN KEY → photos.id, CASCADE delete, UNIQUE)
  embedding: blob (Float32Array, 512 dimensions)
  modelVersion: text (default "clip-vit-b32")
  createdAt: timestamp
}
```

### `photo_phash` table (sidecar)
```typescript
{
  id: integer (PRIMARY KEY)
  photoId: integer (FOREIGN KEY → photos.id, CASCADE delete, UNIQUE)
  hash: text (64-char hex)
  algorithm: text (default "double_gradient_8x8")
  createdAt: timestamp
}
```

**Vector Search:** Uses `sqlite-vec` extension with L2 distance querying `photo_embedding` table.

## API Structure

### tRPC Endpoints (type-safe)
| Endpoint | Type | Purpose |
|----------|------|---------|
| `photos` | Query | Get all photos with EXIF |
| `photo` | Query | Get single photo by ID |
| `searchPhotos` | Query | Semantic search with CLIP |
| `scan` | Mutation | Start async scan job (BullMQ) |
| `onTaskProgress` | Subscription | SSE stream for job progress (scan, phash, embedding) |

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

### Unified Image Processing Pipeline
All image processing happens in Rust via a single function call. The scanner collects file paths and passes them to `processPhotosBatch()` which:

1. Detects file type by extension (RAW, HEIF, or standard)
2. Routes to appropriate processor
3. Processes all files in parallel using Rayon
4. Returns unified results

**For standard images (JPEG, PNG, etc.):**
- Decode image, apply EXIF orientation
- Generate CLIP embeddings (512-dim vector)
- Compute perceptual hash
- Generate WebP thumbnails (all 4 sizes in parallel)

**For RAW images:**
- Extract EXIF from RAW file
- Demosaic using LibRaw (rsraw)
- Apply histogram matching from embedded preview for accurate colors
- Generate CLIP, phash, and thumbnails
- No temp files - all processing in memory

**Supported RAW formats:** CR2, CR3, NEF, ARW, DNG, RAF, ORF, RW2, PEF, SRW, X3F, 3FR, IIQ, RWL

**Performance:** ~586ms per photo average (mixed RAW and standard images)

**RAW file serving:** For RAW photos, `/api/photos/:id/file` serves the large thumbnail (1600px WebP) since the original RAW cannot be displayed in browsers.

### Rust NAPI Functions
Key functions exported from `@photobrain/image-processing`:

| Function | Purpose |
|----------|---------|
| `processPhotosBatch(paths, relativePaths, thumbDir)` | Process multiple photos in parallel (any type) |
| `processPhoto(path, relativePath, thumbDir)` | Process single photo (any type) |
| `getSupportedExtensions()` | Get list of supported file extensions |
| `clipTextEmbedding(text)` | Generate CLIP embedding for search query |

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
REDIS_URL=redis://localhost:6379
RUN_DB_INIT=true        # Run migrations on startup
```

### Worker (`apps/worker`)
```env
REDIS_URL=redis://localhost:6379
DATABASE_PATH=../api/photobrain.db
THUMBNAILS_DIR=../api/thumbnails
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
Multi-stage Dockerfile with 5 stages:
1. **builder** - Rust toolchain, build NAPI module
2. **api** - Bun runtime with API code
3. **worker** - Bun runtime with BullMQ job worker
4. **web-builder** - Vite frontend build
5. **web** - Static file server for frontend

### CI/CD
GitHub Actions workflow:
- Builds Docker images for api, worker, and web
- Pushes to `registry.ericj5.com`
- Updates ArgoCD for GitOps deployment

### Production Dependencies
- **Redis/Valkey** - Required for BullMQ job queues
- Worker and API must share access to the same SQLite database file
- Worker needs read access to photo directory and write access to thumbnails directory

## Common Tasks for AI Assistants

### Adding a New API Endpoint
1. Add tRPC procedure in `apps/api/src/trpc/router.ts`
2. Update types export in `apps/api/src/types.ts` if needed
3. For file streaming, add REST route in `apps/api/src/routes/`

### Adding a New Database Column
1. Update schema in `packages/db/src/schema.ts`
2. Generate migration: `cd packages/db && bun run db:generate`
3. Migration files are created in `packages/db/drizzle/`
4. Run migration: API auto-migrates on startup if `RUN_DB_INIT=true`

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
# Terminal 1: Start Redis (required for job queues)
docker run -p 6379:6379 valkey/valkey:8-alpine

# Terminal 2: Start API
bun run dev:api

# Terminal 3: Start Worker
bun run dev:worker

# Terminal 4: Start Web
bun run dev:web

# Or start API, Worker, and Web together:
bun run dev
```

## Roadmap Reference

See `ROADMAP.md` for planned features including:
- ~~Async processing with BullMQ~~ (implemented)
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
7. **Redis/Valkey required** - BullMQ needs Redis for job queues; start with `docker run -p 6379:6379 valkey/valkey:8-alpine`
8. **Worker processes jobs async** - Scan, phash, and embedding jobs run in the worker process, not the API
9. **Database schema is shared** - Schema lives in `packages/db`, used by both API and worker
