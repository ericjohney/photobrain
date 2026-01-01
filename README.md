# PhotoBrain

A modern, AI-powered self-hosted photo management and gallery application with cross-platform support (Web & Mobile).

## Features

- 🖼️ **Fast Photo Grid Gallery** - Responsive grid layout with optimized image loading
- 🔍 **AI-Powered Semantic Search** - Search photos by content using CLIP embeddings
- 📱 **Cross-Platform** - Web app and native mobile apps (iOS & Android)
- ⚡ **High Performance** - Built with Rust for image processing and metadata extraction
- 🔄 **Automatic Directory Scanning** - Detect and process new photos automatically
- 🎯 **Duplicate Detection** - Perceptual hashing for finding similar images
- 💾 **SQLite Database** - Fast, reliable local storage with vector search
- 🎨 **Modern UI** - Clean, intuitive interface on all platforms

## Architecture

PhotoBrain is a **Turbo monorepo** with shared code between web and mobile platforms:

```
photobrain/
├── apps/
│   ├── api/             # Hono backend API
│   ├── web/             # React web app (Vite)
│   └── mobile/          # React Native Expo app
└── packages/
    ├── api-client/      # Shared API client
    ├── shared-types/    # Shared TypeScript types
    ├── utils/           # Shared utility functions
    ├── config/          # Shared TypeScript config
    └── image-processing/# Rust NAPI module
```

## Prerequisites

- **[Bun](https://bun.sh/)** v1.1.0+ - Fast JavaScript runtime and package manager
- **Node.js** v18+ - For Expo CLI
- **Rust** - For building the image-processing module
- **SQLite** with vector extension support

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

### 3. Start the Backend API

```bash
bun run dev:api
```

The API will be available at `http://localhost:3000`

### 4. Start the Web App

In a new terminal:

```bash
bun run dev:web
```

The web app will be available at `http://localhost:3001`

### 5. Start the Mobile App (Optional)

In a new terminal:

```bash
bun run dev:mobile
```

Scan the QR code with Expo Go on your mobile device.

## Configuration

### Backend API

Configure the API via environment variables or `apps/api/src/config.ts`:

- `PHOTOS_DIR` - Directory to scan for photos (default: `~/Pictures`)
- `DB_PATH` - SQLite database path (default: `./photobrain.db`)

### Web App

Create `apps/web/.env`:

```env
VITE_API_URL=http://localhost:3000
```

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

### `@photobrain/shared-types`

TypeScript interfaces and types used across all apps:

```typescript
import type { PhotoMetadata, PhotosResponse } from '@photobrain/shared-types';
```

### `@photobrain/api-client`

API client for communicating with the backend:

```typescript
import { PhotoBrainClient } from '@photobrain/api-client';

const client = new PhotoBrainClient('http://localhost:3000');
const photos = await client.getPhotos();
const results = await client.searchPhotos({ query: 'sunset' });
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

## Technology Stack

### Backend

- **Hono** - Lightweight, TypeScript-first web framework
- **SQLite** - Fast, embedded database with `sqlite-vec` extension
- **Drizzle ORM** - Type-safe database toolkit
- **Rust (NAPI)** - Native image processing module

### Web Frontend

- **React 18** - UI library
- **Vite** - Fast build tool
- **TailwindCSS** - Utility-first CSS framework
- **Radix UI** - Accessible component primitives
- **React Router** - Client-side routing

### Mobile Frontend

- **React Native** - Cross-platform mobile framework
- **Expo** - React Native development platform
- **React Navigation** - Native navigation
- **expo-image** - Optimized image component

## API Endpoints

- `GET /api/health` - Health check
- `GET /api/photos` - Get all photos
- `GET /api/photos/:id` - Get single photo metadata
- `GET /api/photos/:id/file` - Get photo file
- `GET /api/photos/search?q=query` - Semantic search
- `POST /api/scan` - Trigger directory scan

## Project Structure

```
photobrain/
├── apps/
│   ├── api/
│   │   └── src/
│   │       ├── db/              # Database schema and migrations
│   │       ├── routes/          # API route handlers
│   │       ├── services/        # Business logic (vector search)
│   │       ├── scanner.ts       # Directory scanning
│   │       └── index.ts         # Server entry point
│   │
│   ├── web/
│   │   └── src/
│   │       ├── components/      # React components
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
    ├── api-client/              # Shared API client
    ├── shared-types/            # Shared TypeScript types
    ├── utils/                   # Shared utilities
    ├── config/                  # Shared TS config
    └── image-processing/        # Rust NAPI module
        └── src/
            ├── clip.rs          # CLIP embeddings
            ├── metadata.rs      # EXIF extraction
            └── phash.rs         # Perceptual hashing
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

## License

MIT License - See [LICENSE](LICENSE) file for details

## Acknowledgments

- **CLIP** by OpenAI for semantic image understanding
- **sqlite-vec** for vector similarity search
- **Expo** for amazing React Native development experience
