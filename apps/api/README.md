# PhotoBrain API

A Hono-based REST API for managing and serving photos with SQLite database storage.

## Tech Stack

- **Hono** - Fast, lightweight web framework
- **Drizzle ORM** - Type-safe ORM for SQLite
- **Bun SQLite** - Native SQLite driver for Bun
- **TypeScript** - Type safety

## Project Structure

```
src/
├── db/
│   ├── schema.ts      # Drizzle schema definitions
│   ├── index.ts       # Database connection
│   └── migrate.ts     # Migration runner
├── routes/
│   ├── health.ts      # Health check endpoints
│   ├── photos.ts      # Photo CRUD operations
│   ├── images.ts      # Image file serving
│   └── scan.ts        # Directory scanning
├── scanner.ts         # File system scanner
├── types.ts           # TypeScript types
└── index.ts           # Main application entry
```

## Setup

### Database Migration

Run migrations to create the database schema:

```bash
bun run db:migrate
```

### Development

Start the development server:

```bash
bun run dev
```

## API Endpoints

### Health

- `GET /api/health` - Health check

### Photos

- `GET /api/photos` - Get all photos from database
- `GET /api/photos?q=search` - Search photos by name
- `GET /api/photos/:id` - Get single photo by ID

### Scan

- `POST /api/scan` - Scan photo directory and populate database

Response:
```json
{
  "success": true,
  "scanned": 150,
  "inserted": 10,
  "updated": 5,
  "skipped": 135,
  "duration": 1250,
  "scanDuration": 850,
  "directory": "/path/to/photos"
}
```

### Images

- `GET /api/image/:filename` - Serve image file

## Environment Variables

```env
PORT=3000
PHOTO_DIRECTORY=../../temp-photos
DATABASE_URL=./photobrain.db
```

## Database Schema

### photos

| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| path | TEXT | NOT NULL, UNIQUE |
| name | TEXT | NOT NULL |
| size | INTEGER | NOT NULL |
| createdAt | INTEGER (timestamp) | NOT NULL |
| modifiedAt | INTEGER (timestamp) | NOT NULL |
| width | INTEGER | NULLABLE |
| height | INTEGER | NULLABLE |
| mimeType | TEXT | NULLABLE |

## Workflow

1. **Initial Setup**: Run `bun run db:migrate` to create the database
2. **Scan Photos**: POST to `/api/scan` to scan the photo directory and populate the database
3. **Query Photos**: GET `/api/photos` to retrieve photos from the database (no scanning on every request)
4. **Serve Images**: Access images via `/api/image/:filename`

## Database Commands

```bash
# Generate new migration
bun run db:generate

# Run migrations
bun run db:migrate

# Open Drizzle Studio (database GUI)
bun run db:studio
```

## Notes

- Photos are now stored in SQLite database instead of being scanned on every request
- The scan route intelligently updates only changed files
- Image serving remains filesystem-based for performance
- Search is now database-powered with SQL LIKE queries
