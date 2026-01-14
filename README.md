# PhotoBrain

A modern, AI-powered self-hosted photo management and gallery application with cross-platform support (Web & Mobile).

## Features

- 🎨 **Lightroom-Inspired UI** - Professional three-panel layout with collapsible panels, filmstrip, and loupe view
- 🖼️ **Fast Photo Grid Gallery** - Dense grid layout with adjustable thumbnail sizes and multi-select support
- 🚀 **Multi-Size Thumbnails** - WebP thumbnails (tiny/small/medium/large) for 99% data reduction
- 🔍 **AI-Powered Semantic Search** - Search photos by content using CLIP embeddings
- ⌨️ **Keyboard Shortcuts** - Lightroom-style shortcuts (G=grid, E=loupe, Tab=panels, arrows=navigate)
- 📱 **Cross-Platform** - Web app and native mobile apps (iOS & Android)
- ⚡ **High Performance** - Built with Rust for image processing and metadata extraction
- 🔄 **Automatic Directory Scanning** - Detect and process new photos automatically
- 🎯 **Duplicate Detection** - Perceptual hashing for finding similar images
- 💾 **SQLite Database** - Fast, reliable local storage with vector search
- 🌓 **Light & Dark Themes** - Professional dark theme inspired by Adobe Lightroom
- 📸 **EXIF Data Extraction** - Full camera metadata including GPS coordinates

## Architecture

PhotoBrain is a **Turbo monorepo** with shared code between web and mobile platforms:

```
photobrain/
├── apps/
│   ├── api/             # tRPC backend API (Hono + Bun)
│   ├── worker/          # BullMQ job worker (scan, phash, embeddings)
│   ├── web/             # React web app (Vite)
│   └── mobile/          # React Native Expo app
└── packages/
    ├── utils/           # Shared utility functions
    ├── config/          # Shared TypeScript config
    ├── db/              # Shared database schema (Drizzle ORM)
    └── image-processing/# Rust NAPI module
```

## Prerequisites

- **[Bun](https://bun.sh/)** v1.1.0+ - Fast JavaScript runtime and package manager
- **Node.js** v18+ - For Expo CLI
- **Rust** - For building the image-processing module
- **SQLite** with vector extension support
- **Redis/Valkey** - For BullMQ job queues (can run via Docker)

### For Mobile Development

- **[Expo CLI](https://docs.expo.dev/get-started/installation/)** - `npm install -g expo-cli`
- **[Expo Go](https://expo.dev/client)** app on your mobile device
- For iOS: Xcode (Mac only)
- For Android: Android Studio

## Quick Start

### 1. Install Dependencies

```bash
bun install
```

### 2. Build the Image Processing Module

```bash
cd packages/image-processing
bun run build
cd ../..
```

### 3. Start Redis

```bash
docker run -p 6379:6379 valkey/valkey:8-alpine
```

Redis is required for the BullMQ job queue system.

### 4. Start the Backend API

```bash
bun run dev:api
```

The API will be available at `http://localhost:3000`

### 5. Start the Worker

In a new terminal:

```bash
bun run dev:worker
```

The worker processes scan, phash, and embedding jobs asynchronously.

### 6. Start the Web App

In a new terminal:

```bash
bun run dev:web
```

The web app will be available at `http://localhost:3001`

### 7. Start the Mobile App (Optional)

In a new terminal:

```bash
bun run dev:mobile
```

Scan the QR code with Expo Go on your mobile device.

## Configuration

### Backend API

Configure the API via environment variables or `apps/api/src/config.ts`:

- `PHOTO_DIRECTORY` - Directory to scan for photos (default: `../../temp-photos`)
- `THUMBNAILS_DIRECTORY` - Directory to store thumbnails (default: `./thumbnails`)
- `DATABASE_URL` - SQLite database path (default: `./photobrain.db`)
- `REDIS_URL` - Redis connection URL (default: `redis://localhost:6379`)
- `PORT` - Server port (default: `3000`)

### Worker

Configure the worker via environment variables:

- `REDIS_URL` - Redis connection URL (default: `redis://localhost:6379`)
- `DATABASE_PATH` - SQLite database path (default: `../api/photobrain.db`)
- `THUMBNAILS_DIR` - Directory to store thumbnails (default: `../api/thumbnails`)

### Web App

The web app supports runtime configuration via environment variables when running in production with `serve.ts`.

**Development** (Vite dev server) - Create `apps/web/.env`:

```env
VITE_API_URL=http://localhost:3000
```

**Production** - Set environment variables when running the server:

```bash
API_URL=https://api.example.com bun run serve.ts
```

Available environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `API_URL` | `http://localhost:3000` | Backend API URL |
| `HOST` | `0.0.0.0` | Server hostname |
| `PORT` | `3001` | Server port |

Configuration is injected at runtime, so you can change the API URL without rebuilding the app.

### Mobile App

Create `apps/mobile/.env`:

```env
# For iOS Simulator
EXPO_PUBLIC_API_URL=http://localhost:3000

# For Android Emulator
# EXPO_PUBLIC_API_URL=http://10.0.2.2:3000

# For Physical Device (replace with your computer's IP)
# EXPO_PUBLIC_API_URL=http://192.168.1.100:3000
```

## Development Scripts

### Monorepo Commands

```bash
bun run dev              # Start all apps in parallel
bun run build            # Build all packages and apps
bun run typecheck        # Type check all packages
bun run lint             # Lint all packages
bun run format           # Format code with Biome
bun run check            # Check and fix code with Biome
```

### Individual App Commands

```bash
bun run dev:api          # Start backend API
bun run dev:worker       # Start BullMQ worker
bun run dev:web          # Start web app
bun run dev:mobile       # Start mobile app (Expo)
```

### Mobile Specific Commands

```bash
cd apps/mobile
bun run start            # Start Expo dev server
bun run ios              # Run on iOS simulator
bun run android          # Run on Android emulator
bun run web              # Run in web browser
```

## Shared Packages

PhotoBrain uses workspace packages to share code between platforms:

### `@photobrain/api` (tRPC)

End-to-end type-safe API using tRPC. Types are automatically inferred from the backend router:

```typescript
// Web app - using React Query hooks
import { trpc } from '@/lib/trpc';

function MyComponent() {
  const photosQuery = trpc.photos.useQuery();
  const scanMutation = trpc.scan.useMutation();

  // Types are automatically inferred!
  const photos = photosQuery.data?.photos; // TypeScript knows the shape
}

// Import types
import type { AppRouter } from '@photobrain/api';
import type { inferRouterOutputs } from '@trpc/server';

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];
```

### `@photobrain/utils`

Shared utility functions:

```typescript
import { formatFileSize, formatDate, debounce } from '@photobrain/utils';

const size = formatFileSize(1024000); // "1.0 MB"
```

### `@photobrain/image-processing`

Rust NAPI module for high-performance image operations:

- CLIP embeddings (text & image)
- Metadata extraction (EXIF, dimensions, etc.)
- Perceptual hashing for duplicate detection
- Multi-size thumbnail generation (WebP format)

## Technology Stack

### Backend

- **Hono** - Lightweight, TypeScript-first web framework
- **SQLite** - Fast, embedded database with `sqlite-vec` extension
- **Drizzle ORM** - Type-safe database toolkit
- **BullMQ** - Job queue for async processing (scan, phash, embeddings)
- **Redis/Valkey** - Queue storage backend
- **Rust (NAPI)** - Native image processing module

### Web Frontend

- **React 18** - UI library
- **Vite** - Fast build tool
- **TailwindCSS** - Utility-first CSS framework
- **Radix UI** - Accessible component primitives
- **React Router** - Client-side routing
- **react-resizable-panels** - Panel layout system

### Mobile Frontend

- **React Native** - Cross-platform mobile framework
- **Expo** - React Native development platform
- **React Navigation** - Native navigation
- **expo-image** - Optimized image component

## API Endpoints

- `GET /api/health` - Health check
- `GET /api/photos` - Get all photos
- `GET /api/photos/:id` - Get single photo metadata
- `GET /api/photos/:id/file` - Get full-resolution photo file
- `GET /api/photos/:id/thumbnail/:size` - Get thumbnail (sizes: tiny, small, medium, large)
- `GET /api/photos/search?q=query` - Semantic search
- `POST /api/scan` - Trigger directory scan

## Web UI

The web app features a professional Lightroom-inspired interface with a three-panel layout:

```
+------------------+------------------------+------------------+
|  Left Panel      |     Center Content     |   Right Panel    |
|  (Navigation)    |     (Photo Grid/       |   (Metadata)     |
|  Collapsible     |      Loupe View)       |   Collapsible    |
+------------------+------------------------+------------------+
|                      Filmstrip                               |
+--------------------------------------------------------------+
```

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `G` | Switch to grid view |
| `E` | Switch to loupe (single photo) view |
| `Tab` | Toggle all panels |
| `←` / `→` | Navigate previous/next photo |
| `Escape` | Deselect all / close loupe view |
| `Shift+Click` | Range select photos |
| `Ctrl/Cmd+Click` | Toggle individual photo selection |

### View Modes

- **Grid View**: Dense thumbnail grid with adjustable sizes (50-300px)
- **Loupe View**: Full-size photo with zoom controls (Fit/Fill/1:1)

### Panel Controls

- Left and right panels can be collapsed via toolbar buttons
- Filmstrip at the bottom shows all photos with active selection indicator
- Panel states persist in localStorage

## Project Structure

```
photobrain/
├── apps/
│   ├── api/
│   │   └── src/
│   │       ├── db/              # Database migrations
│   │       ├── routes/          # API route handlers
│   │       ├── services/        # Business logic (vector search)
│   │       └── index.ts         # Server entry point
│   │
│   ├── worker/
│   │   └── src/
│   │       ├── queues/          # BullMQ queue definitions
│   │       ├── workers/         # Job processors
│   │       ├── activities/      # Shared job activities
│   │       └── index.ts         # Worker entry point
│   │
│   ├── web/
│   │   └── src/
│   │       ├── components/
│   │       │   ├── panels/      # Panel layout components
│   │       │   │   ├── PanelLayout.tsx    # Three-panel resizable layout
│   │       │   │   └── MetadataPanel.tsx  # EXIF metadata display
│   │       │   ├── ui/          # shadcn/ui components
│   │       │   ├── PhotoGrid.tsx     # Photo grid with selection
│   │       │   ├── Filmstrip.tsx     # Horizontal thumbnail strip
│   │       │   ├── LoupeView.tsx     # Single photo view with zoom
│   │       │   └── Toolbar.tsx       # Top toolbar with controls
│   │       ├── hooks/
│   │       │   ├── use-library-state.ts    # View mode, selection state
│   │       │   ├── use-panel-state.ts      # Panel visibility state
│   │       │   └── use-keyboard-shortcuts.ts # Keyboard navigation
│   │       ├── pages/           # Route pages
│   │       ├── lib/             # Utilities
│   │       └── main.tsx         # App entry point
│   │
│   └── mobile/
│       ├── src/
│       │   ├── components/      # React Native components
│       │   ├── screens/         # Main screens
│       │   ├── navigation/      # Navigation setup
│       │   └── config.ts        # App configuration
│       └── App.tsx              # App entry point
│
└── packages/
    ├── utils/                   # Shared utilities
    │   └── src/
    │       ├── thumbnails.ts    # Thumbnail configuration
    │       └── tasks.ts         # Task type definitions
    ├── config/                  # Shared TS config
    ├── db/                      # Shared database schema
    │   ├── drizzle/             # Database migrations
    │   └── src/
    │       ├── schema.ts        # Drizzle ORM table definitions
    │       └── index.ts         # Database connection
    └── image-processing/        # Rust NAPI module
        └── src/
            ├── clip.rs          # CLIP embeddings
            ├── exif.rs          # EXIF extraction
            ├── metadata.rs      # Photo metadata
            ├── phash.rs         # Perceptual hashing
            └── thumbnails.rs    # Thumbnail generation
```

## Building for Production

### Web App

```bash
cd apps/web
bun run build
```

Output will be in `apps/web/dist/`

### Mobile App

For iOS and Android, use [EAS Build](https://docs.expo.dev/build/introduction/):

```bash
cd apps/mobile
eas build --platform ios
eas build --platform android
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Code Quality

This project uses:

- **Biome** for linting and formatting
- **TypeScript** for type safety
- **Turbo** for efficient monorepo builds

Run checks before committing:

```bash
bun run check      # Auto-fix issues
bun run typecheck  # Type checking
```

## Troubleshooting

### Mobile App Can't Connect to API

1. Ensure the API is running on port 3000
2. Check your `.env` file has the correct API URL:
   - iOS Simulator: `http://localhost:3000`
   - Android Emulator: `http://10.0.2.2:3000`
   - Physical Device: `http://<your-computer-ip>:3000`
3. Ensure your phone and computer are on the same network (for physical devices)

### Images Not Loading

1. Verify photos exist in the configured `PHOTOS_DIR`
2. Run a scan: Click the refresh button or POST to `/api/scan`
3. Check API logs for errors

### Build Errors

1. Ensure all dependencies are installed: `bun install`
2. Build the Rust module: `cd packages/image-processing && bun run build`
3. Clear build cache: `rm -rf node_modules/.cache`

### Scan Not Working

1. Ensure Redis is running: `docker run -p 6379:6379 valkey/valkey:8-alpine`
2. Ensure the worker is running: `bun run dev:worker`
3. Check worker logs for errors
4. Verify `REDIS_URL` environment variable is set correctly in both API and worker

## License

MIT License - See [LICENSE](LICENSE) file for details

## Acknowledgments

- **CLIP** by OpenAI for semantic image understanding
- **sqlite-vec** for vector similarity search
- **Expo** for amazing React Native development experience
