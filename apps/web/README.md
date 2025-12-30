# PhotoBrain Web Interface

A modern React photo gallery interface built with Vite, React, and shadcn/ui components.

## Features

- Modern, responsive photo grid layout
- Search functionality to filter photos by name
- Click to view photos in fullscreen lightbox
- Hover effects and smooth animations
- Dark mode support (via Tailwind CSS)
- Real-time photo scanning stats

## Getting Started

### Prerequisites

- Bun 1.1.0 or higher
- PhotoBrain API running on port 3000

### Installation

Dependencies are managed at the monorepo root level:

```bash
# From the monorepo root
bun install
```

### Development

Start the development server:

```bash
# From the monorepo root
bun run dev:web

# Or from this directory
bun run dev
```

The app will be available at http://localhost:3001

### Environment Variables

Create a `.env` file based on `.env.example`:

```env
VITE_API_URL=http://localhost:3000
```

### Building for Production

```bash
bun run build
```

The built files will be in the `dist` directory.

## Tech Stack

- **React 18** - UI framework
- **Vite** - Build tool and dev server
- **TypeScript** - Type safety
- **Tailwind CSS** - Styling
- **shadcn/ui** - UI components
- **Lucide React** - Icons

## Components

- `PhotoGrid` - Responsive grid layout with lightbox view
- `SearchBar` - Search input with icon
- `Button`, `Input`, `Card` - shadcn/ui components

## API Integration

The app connects to the PhotoBrain API at the configured `VITE_API_URL`:

- `GET /api/photos` - Fetch all photos
- `GET /api/photos?q=<query>` - Search photos
- `GET /api/image/<filename>` - Serve image files
