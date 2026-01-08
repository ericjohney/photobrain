# PhotoBrain Development Roadmap

## Vision

PhotoBrain aims to be a fast, AI-powered self-hosted photo management solution that combines the best features of PhotoPrism and Immich with a focus on performance and semantic search capabilities.

## Current State (v0.1.0)

**Completed:**
- ✅ Monorepo architecture with Turbo + Bun
- ✅ Rust-based image processing (NAPI module)
- ✅ CLIP embeddings for semantic search
- ✅ Perceptual hashing (pHash) for duplicate detection
- ✅ Basic photo gallery with responsive grid
- ✅ RESTful API with Hono.js
- ✅ SQLite database with Drizzle ORM
- ✅ Vector similarity search (sqlite-vec)
- ✅ Directory scanning with metadata extraction
- ✅ Basic lightbox viewer

---

## 🚀 Next Sessions: Bite-Sized Tasks

These tasks are broken down into small, session-sized chunks that can each be completed in a single Claude Code session. Focus on delivering working, tested features incrementally.

### Session 1: EXIF Data Extraction 📸 ✅ **COMPLETED**
**Goal:** Extract and display camera metadata from existing photos

**Deliverables:**
- [x] Add `kamadak-exif` crate to Rust image-processing package
- [x] Create `extract_exif()` function in Rust that returns JSON with:
  - Camera make/model
  - Lens information
  - Exposure settings (ISO, aperture, shutter speed)
  - Focal length
  - Date taken
  - GPS coordinates (latitude/longitude)
- [x] Update database schema with EXIF fields
- [x] Migrate existing photos to populate EXIF data
- [x] Update API to return EXIF data with photo metadata
- [x] Display EXIF in lightbox photo detail view

**Completed!** All EXIF data is now extracted during scanning and displayed in the lightbox.
**Files modified:** `packages/image-processing/src/exif.rs`, `apps/api/src/db/schema.ts`, `apps/web/src/components/Lightbox.tsx`

---

### Session 2: Multi-Size Thumbnail Generation 🖼️ ✅ **COMPLETED**
**Goal:** Generate and serve multiple thumbnail sizes for faster loading

**Deliverables:**
- [x] Add `image` crate resizing to Rust NAPI module with WebP support
- [x] Create `generate_thumbnails()` function that produces:
  - Tiny: 150px (grid previews)
  - Small: 400px (modal previews)
  - Medium: 800px (lightbox)
  - Large: 1600px (full view)
- [x] Store thumbnails in `/thumbnails/{size}/{photo-id}.webp` structure (WebP format for 30% size reduction)
- [x] Deterministic thumbnail paths (no database columns needed)
- [x] Add API endpoint: `GET /api/photos/:id/thumbnail/:size` with fallback to full image
- [x] Update frontend to use appropriate thumbnail sizes based on context
- [x] Add responsive srcset for web lightbox
- [x] Add progressive loading for mobile with expo-image caching

**Completed!** All thumbnails are now generated as WebP during scanning with 99% data reduction for mobile.
**Files modified:**
- `packages/image-processing/src/thumbnails.rs` (new)
- `packages/utils/src/thumbnails.ts` (new - shared config)
- `apps/api/src/config.ts` (added THUMBNAILS_DIRECTORY)
- `apps/api/src/routes/photos.ts` (added thumbnail endpoint)
- `apps/api/src/routes/scan.ts` (thumbnail generation integration)
- `apps/web/src/lib/thumbnails.ts` (new - helper functions)
- `apps/web/src/components/PhotoGrid.tsx` (uses tiny thumbnails)
- `apps/web/src/components/Lightbox.tsx` (responsive srcset)
- `apps/mobile/src/components/PhotoGrid.tsx` (uses tiny thumbnails)
- `apps/mobile/src/components/PhotoModal.tsx` (progressive loading)

---

### Session 3: Async Processing Pipeline with Temporal 🔄 **HIGH PRIORITY**
**Goal:** Move image processing off the main thread using Temporal workflows

**Deliverables:**
- [ ] Install `@temporalio/worker` and `@temporalio/client` packages
- [ ] Set up Temporal development server (local Docker or Temporal Cloud)
- [ ] Create workflow definitions in `apps/api/src/workflows/`:
  - `scanDirectoryWorkflow` - Orchestrates directory scanning
  - `processPhotoWorkflow` - Processes individual photos (metadata + thumbnails + embeddings)
  - `generateThumbnailsWorkflow` - Generate thumbnails for existing photos
- [ ] Create activity functions in `apps/api/src/activities/`:
  - `scanDirectory` - List files in directory
  - `extractMetadata` - Call Rust NAPI for metadata/EXIF
  - `generateThumbnails` - Call Rust NAPI for thumbnail generation
  - `generateEmbeddings` - Call Rust NAPI for CLIP embeddings
  - `saveToDatabase` - Persist photo data
- [ ] Create Temporal worker service (`apps/api/src/temporal/worker.ts`)
- [ ] Update scan endpoint to start Temporal workflows instead of blocking
- [ ] Add workflow status endpoint: `GET /api/workflows/:id/status`
- [ ] Add frontend polling for workflow progress with live updates
- [ ] Display processing status in UI (queued, running, completed, failed)
- [ ] Add workflow retry policies for resilience

**Temporal Benefits:**
- Durable execution (survives server restarts)
- Built-in retry logic with exponential backoff
- Workflow versioning for safe updates
- Observable execution with Temporal UI
- Easy to add complex orchestration later (parallel processing, conditionals)

**Estimated time:** 3-4 hours (includes Temporal setup)
**Files to create:**
- `apps/api/src/workflows/scanDirectory.ts`
- `apps/api/src/workflows/processPhoto.ts`
- `apps/api/src/activities/photoActivities.ts`
- `apps/api/src/temporal/worker.ts`
- `apps/api/src/temporal/client.ts`

**Files to modify:** `apps/api/src/routes/scan.ts`, `apps/web/src/pages/Dashboard.tsx`

**Setup:**
```bash
# Start Temporal dev server (in Docker)
temporal server start-dev

# Or use Temporal Cloud for production
```

---

### Session 4: RAW Image Support 📷 ✅ **COMPLETED**
**Goal:** Full RAW image processing with native Rust pipeline

**Deliverables:**
- [x] Add `rsraw` crate for RAW demosaicing (libraw bindings)
- [x] Detect common RAW extensions: `.cr2`, `.cr3`, `.nef`, `.arw`, `.dng`, `.raf`, `.orf`, `.rw2`, `.pef`, `.srw`, `.x3f`, `.3fr`, `.iiq`, `.rwl`
- [x] Update database schema with `isRaw`, `rawFormat`, `rawStatus`, `rawError` fields
- [x] Per-channel histogram matching to match camera's embedded preview (corrects tone AND white balance)
- [x] Unified processing pipeline in Rust (`batch.rs`) - handles RAW, HEIF, and standard images
- [x] Generate thumbnails from processed RAW
- [x] Generate CLIP embeddings for RAW files
- [x] Memory-efficient parallel processing (limited to 4 threads for large RAW files)
- [x] Reprocess RAW endpoint for failed conversions
- [x] Filter photos by type (all/raw/standard)

**Files created:** `packages/image-processing/src/raw.rs`, `packages/image-processing/src/batch.rs`
**Files modified:** `apps/api/src/db/schema.ts`, `apps/api/src/scanner.ts`, `apps/api/src/trpc/router.ts`

---

### Session 5: HEIF/HEIC Support 🍎 ✅ **COMPLETED**
**Goal:** Support Apple's HEIF/HEIC image format

**Deliverables:**
- [x] Add `libheif-rs` crate for HEIF decoding
- [x] Detect `.heic` and `.heif` extensions
- [x] Decode HEIF images to RGB for processing
- [x] Generate thumbnails and CLIP embeddings for HEIF files
- [x] Unified with standard image pipeline

**Files created:** `packages/image-processing/src/heif.rs`

---

### Session 6: Lens Corrections 🔍 **FUTURE**
**Goal:** Apply optical corrections (distortion, vignette, chromatic aberration)

**Background:**
Lens corrections compensate for optical imperfections in camera lenses:
- **Distortion** - barrel/pincushion warping
- **Vignette** - corner darkening
- **Chromatic aberration** - color fringing at edges
- **Sharpness falloff** - edge softness

**Implementation Options:**

| Option | Effort | Pros | Cons |
|--------|--------|------|------|
| **lensfun FFI bindings** | High (1-2 weeks) | Industry standard, 10k+ lens profiles, what darktable/RawTherapee use | No Rust bindings exist, need to create FFI, bundle ~50MB database |
| **Embedded corrections** | Medium | Some cameras embed correction data in RAW | Only works for Sony, some Canon; not universal |
| **darktable-cli** | Low | Full correction support | Slow, adds external dependency |
| **Skip for browsing** | None | Corrections matter more for final exports | May look slightly off for wide-angle lenses |

**Technical Notes:**
- [lensfun](https://github.com/lensfun/lensfun) is the open-source standard used by darktable, RawTherapee, GIMP
- Database contains profiles for thousands of camera/lens combinations
- Uses EXIF data (camera model, lens model, focal length, aperture) to look up corrections
- Sony cameras often apply corrections in-camera (EXIF shows "Distortion Correction: Auto fixed by lens")
- libraw/rsraw has no built-in lens correction support

**Potential Deliverables:**
- [ ] Create Rust FFI bindings for lensfun C library
- [ ] Bundle lensfun database with application
- [ ] Look up lens profile from EXIF metadata
- [ ] Apply distortion correction during RAW processing
- [ ] Apply vignette correction
- [ ] Apply chromatic aberration correction
- [ ] Add toggle in settings to enable/disable corrections
- [ ] Cache correction parameters per lens/focal length combination

**References:**
- [lensfun GitHub](https://github.com/lensfun/lensfun)
- [lensfun usage docs](https://lensfun.github.io/usage/)
- [Lens calibration tutorial](https://wilson.bronger.org/lens_calibration_tutorial/)

---

### Session 7: EXIF-Based Filtering 🔍
**Goal:** Filter photos by camera metadata

**Deliverables:**
- [ ] Add filter UI components (dropdowns for camera, lens, ISO range)
- [ ] Create API endpoint: `GET /api/photos?camera=...&lens=...&isoMin=...&isoMax=...`
- [ ] Add database query filters
- [ ] Show unique cameras/lenses in filter options
- [ ] Add date range picker
- [ ] Combine filters with existing search

**Estimated time:** 2-3 hours
**Files to modify:** `apps/api/src/routes/photos.ts`, `apps/web/src/components/FilterPanel.tsx`

---

### Session 8: GPS Coordinate Extraction 🗺️ ✅ **PARTIALLY COMPLETED**
**Goal:** Extract and display photo locations

**Deliverables:**
- [x] Parse GPS EXIF data (latitude, longitude, altitude)
- [x] Add GPS fields to database
- [x] Display coordinates in photo detail
- [ ] Add basic map view using Leaflet.js
- [ ] Show photo markers on map
- [ ] Click marker to view photo

**Status:** GPS data extraction and display is complete. Map view functionality remains to be implemented.
**Files modified:** `packages/image-processing/src/exif.rs`, `apps/api/src/db/schema.ts`, `apps/web/src/components/Lightbox.tsx`

---

### Session 9: Duplicate Detection UI 🔎
**Goal:** Use existing pHash to find and manage duplicates

**Deliverables:**
- [ ] Create similarity search query using pHash
- [ ] Add API endpoint: `GET /api/photos/:id/similar`
- [ ] Build duplicates page showing groups of similar photos
- [ ] Side-by-side comparison view
- [ ] Batch delete functionality
- [ ] Configurable similarity threshold slider

**Estimated time:** 2-3 hours
**Files to create:** `apps/web/src/pages/Duplicates.tsx`

---

### Session 10: Favorites & Starring ⭐
**Goal:** Mark and filter favorite photos

**Deliverables:**
- [ ] Add `isFavorite: boolean` to database
- [ ] Add star icon to photo grid items
- [ ] Toggle favorite on click
- [ ] Add favorites filter/view
- [ ] Show favorite count in sidebar
- [ ] Keyboard shortcut for starring (F key)

**Estimated time:** 1-2 hours
**Files to modify:** `apps/api/src/db/schema.ts`, `apps/web/src/components/PhotoGrid.tsx`

---

## Phase 1: RAW Support & Image Processing ✅ **COMPLETED**

### 1.1 RAW Image Support ✅
**Goal:** Enable viewing, processing, and conversion of RAW image formats

**Completed Implementation:**
- [x] Native Rust RAW processing using `rsraw` crate (libraw bindings) - no external CLI dependencies
- [x] Support for 14+ RAW formats: CR2, CR3, NEF, ARW, DNG, RAF, ORF, RW2, PEF, SRW, X3F, 3FR, IIQ, RWL
- [x] Per-channel histogram matching to match camera's embedded JPEG preview (tone + white balance)
- [x] Unified processing pipeline (`batch.rs`) handles RAW, HEIF, and standard images
- [x] Memory-efficient parallel processing (limited to 4 threads for large RAW files)
- [x] Database schema with `isRaw`, `rawFormat`, `rawStatus`, `rawError` fields
- [x] Thumbnail generation (tiny/small/medium/large) for RAW files
- [x] CLIP embeddings generated from processed RAW for semantic search
- [x] Reprocess RAW endpoint for failed conversions
- [x] Filter photos by type (all/raw/standard)
- [x] HEIF/HEIC support via `libheif-rs`

**Technical Implementation:**
- RAW demosaicing via rsraw (libraw)
- Histogram matching: compute per-channel CDFs, build tone curves, apply R/G/B corrections
- Thumbnails stored as WebP for 30% size reduction
- No external CLI tools required (pure Rust)

### 1.2 Enhanced Image Metadata
- [x] EXIF data extraction (camera model, settings, lens, GPS)
  - ✅ Integrated with Rust using `kamadak-exif` crate
- [ ] XMP sidecar support for non-destructive edits
- [x] Display full EXIF in photo detail view
- [ ] Parse IPTC metadata (keywords, copyright, descriptions)
- [x] GPS coordinate extraction for maps integration (extraction complete, map view pending)

---

## Phase 2: Core Photo Management

### 2.1 Organization & Filtering
- [ ] **Albums & Collections**
  - Manual album creation
  - Automatic smart albums (based on date, location, tags)
  - Nested album support
- [ ] **Favorites/Starring**
  - Mark photos as favorites
  - Filter by starred photos
- [ ] **Date-based browsing**
  - Timeline view (group by year/month/day)
  - Calendar view with photo counts
- [ ] **Advanced filtering**
  - By camera model, lens, ISO, aperture, shutter speed
  - By file type (JPEG, PNG, RAW)
  - By dimensions/orientation
  - By MIME type

### 2.2 Tagging & Classification
- [ ] **Automatic tagging with CLIP**
  - Generate tags from image content
  - Confidence scores for suggested tags
- [ ] **Manual tagging**
  - Add/remove custom tags
  - Tag autocomplete
  - Batch tagging
- [ ] **Hierarchical tags**
  - Tag categories (people, places, events, things)
- [ ] **Face detection & recognition**
  - Detect faces in photos
  - Cluster similar faces
  - Name people and find all their photos
  - Face recognition training

### 2.3 Duplicate Detection
- [ ] Use existing pHash implementation
- [ ] Build duplicate finder UI
- [ ] Show similar photos side-by-side
- [ ] Batch deletion of duplicates
- [ ] Configurable similarity threshold

---

## Phase 3: Mobile & Backup

### 3.1 Mobile Applications
**Inspired by Immich's automatic backup**

- [ ] **React Native mobile app** (iOS + Android)
  - Native camera roll access
  - Background photo upload
  - Push notifications for upload completion
- [ ] **Automatic backup service**
  - Periodic background sync
  - Only upload new photos
  - Configurable backup quality (original vs compressed)
  - WiFi-only option
- [ ] **Mobile gallery browser**
  - Offline caching of thumbnails
  - Full-resolution download on demand

### 3.2 Import & Export
- [ ] **Bulk import wizard**
  - Import from local directories
  - Import from external drives
  - Import from cloud services (Google Photos, iCloud, Dropbox)
- [ ] **Export functionality**
  - Export albums as ZIP
  - Export with original metadata
  - Export with selected quality/format

---

## Phase 4: Advanced AI & Search

### 4.1 Enhanced Search
- [ ] **Multi-modal search**
  - Text descriptions (already implemented)
  - Search by similar images (reverse image search)
  - Search within date ranges
  - Search by location radius
- [ ] **Search filters combination**
  - AND/OR logic for multiple filters
  - Saved searches
- [ ] **OCR (Optical Character Recognition)**
  - Extract text from images
  - Search photos by text content (signs, documents, screenshots)

### 4.2 AI Enhancements
- [ ] **Auto-captioning**
  - Generate natural language descriptions
  - Use vision-language models (BLIP, LLaVA)
- [ ] **Object detection**
  - Identify objects in photos
  - Searchable object database
- [ ] **Scene classification**
  - Indoor/outdoor detection
  - Landscape, portrait, food, architecture categories
- [ ] **Quality scoring**
  - Blur detection
  - Aesthetic quality scoring
  - Auto-hide low-quality photos option

---

## Phase 5: Maps & Geolocation

**Inspired by PhotoPrism's 3D Earth view**

### 5.1 Map Integration
- [ ] **Photo map view**
  - Cluster photos by location
  - Interactive map (Leaflet.js or Mapbox)
- [ ] **GPS reverse geocoding**
  - Convert coordinates to place names
  - City, country, landmark detection
- [ ] **Location-based albums**
  - Auto-group photos by location
  - Travel timeline
- [ ] **3D Earth view** (advanced)
  - Globe visualization of photo locations
  - Animated path of travels

---

## Phase 6: Sharing & Collaboration

### 6.1 Multi-User Support
**Inspired by Immich's family sharing**

- [ ] **User accounts & authentication**
  - User registration and login
  - JWT-based auth
  - Password reset flow
- [ ] **Private libraries per user**
  - Each user has isolated photo collection
  - Configurable storage quotas
- [ ] **Shared albums**
  - Share albums with specific users
  - Public/private visibility settings
  - Permissions (view-only, can contribute)

### 6.2 Public Sharing
- [ ] **Public links**
  - Generate shareable URLs for photos/albums
  - Optional password protection
  - Expiration dates
- [ ] **Embed codes**
  - Generate HTML embed codes for photos
  - Responsive iframe embeds

---

## Phase 7: Performance & Scalability

### 7.1 Optimization
- [ ] **Progressive image loading**
  - Blurhash/ThumbHash for instant placeholders
  - Lazy loading with intersection observer
- [ ] **Image CDN/caching**
  - Generate multiple thumbnail sizes
  - Browser caching headers
  - Optional S3/CloudFlare integration
- [ ] **Database optimization**
  - Proper indexing for common queries
  - Pagination improvements
  - Query result caching
- [ ] **Parallel processing**
  - Multi-threaded scanning
  - Temporal workflows for batch processing
  - Parallel activity execution in workflows

### 7.2 Storage Management
- [ ] **Storage analytics**
  - Show disk usage by user/album
  - Identify large files
- [ ] **Smart storage**
  - Automatic compression for old photos
  - Tiered storage (hot/cold)
  - Optional cloud backup integration

---

## Phase 8: Advanced Features

### 8.1 Video Support
**Already partially supported, needs enhancement**

- [ ] **Video transcoding**
  - Convert to web-friendly formats (H.264/VP9)
  - Generate video thumbnails
  - Multiple quality options
- [ ] **Video metadata**
  - Duration, codec, resolution extraction
  - Video preview generation (animated thumbnails)
- [ ] **Video player**
  - In-browser playback
  - Timeline scrubbing
  - Playback speed controls

### 8.2 Photo Editing
- [ ] **Basic edits**
  - Crop, rotate, flip
  - Brightness, contrast, saturation
  - Filters/presets
- [ ] **Non-destructive editing**
  - Store edit history
  - Revert to original
- [ ] **Advanced editing** (future)
  - Integration with external editors
  - Layer support

### 8.3 Memories & Rediscovery
**Inspired by Google Photos and Immich**

- [ ] **"On This Day" feature**
  - Show photos from same day in previous years
- [ ] **Automatic highlights**
  - AI-selected best photos from trips/events
  - Auto-generated slideshows
- [ ] **Activity timeline**
  - Show recent uploads and activity

---

## Technical Debt & Infrastructure

### DevOps
- [ ] **Docker containerization**
  - Multi-stage builds
  - Docker Compose for easy deployment
- [ ] **CI/CD pipeline**
  - Automated tests
  - Automated builds and releases
- [ ] **Documentation**
  - API documentation (OpenAPI/Swagger)
  - User guide
  - Developer guide
- [ ] **Testing**
  - Unit tests for API routes
  - Integration tests for image processing
  - E2E tests for frontend
  - Rust tests for NAPI module

### Database
- [ ] **Migration to PostgreSQL** (optional, for larger deployments)
  - Better performance at scale
  - pgvector for embeddings
- [ ] **Database backups**
  - Automated backup scripts
  - Restore procedures

### Security
- [ ] **Security audit**
  - Input validation
  - SQL injection prevention
  - XSS prevention
- [ ] **Rate limiting**
  - API rate limits
  - Upload rate limits
- [ ] **File upload security**
  - Virus scanning
  - File type validation
  - Size limits

---

## Future Considerations

### Integrations
- [ ] WebDAV support (like PhotoPrism)
- [ ] FUSE filesystem mount
- [ ] Lightroom Classic integration
- [ ] Apple Photos import
- [ ] Google Photos import tool

### Advanced AI
- [ ] Local LLM integration for advanced queries
  - "Show me all photos with dogs at the beach during sunset"
- [ ] Style transfer
- [ ] Image upscaling (super-resolution)
- [ ] Automatic image enhancement

### Platform Expansion
- [ ] Desktop app (Tauri/Electron)
- [ ] Browser extension for quick uploads
- [ ] CLI tool for power users

---

## Success Metrics

- **Performance:** Page load < 2s, search results < 500ms
- **Scalability:** Support for 100K+ photos per library
- **User Experience:** Mobile app with background sync
- **AI Accuracy:** Semantic search with >85% relevance
- **Compatibility:** Support for 20+ RAW formats

---

## Contributing

This roadmap is subject to change based on community feedback and priorities. Features may be reordered based on demand and technical feasibility.

For RAW support implementation, refer to:
- [RawTherapee CLI Documentation](https://rawpedia.rawtherapee.com/Command-Line_Options)
- [Darktable CLI Documentation](https://docs.darktable.org/usermanual/development/en/special-topics/program-invocation/darktable-cli/)

---

## Research References

**PhotoPrism Features:**
- AI-powered search and classification
- Face recognition and people grouping
- RAW format support with conversion
- WebDAV integration for direct file access
- Multi-language support
- Places with 3D Earth view
- Batch editing capabilities

**Immich Features:**
- Native mobile apps with automatic backup
- Multi-user support with private libraries
- Fast semantic search with CLIP
- Face recognition and clustering
- Album sharing with permissions
- Map view with photo clustering
- Video support with transcoding

**Key Differentiators for PhotoBrain:**
1. **Rust-powered performance** - Native speed for image processing
2. **Modern tech stack** - Bun + React + Rust for best-in-class performance
3. **Semantic-first search** - CLIP embeddings as core feature from day one
4. **Lightweight footprint** - SQLite for easy deployment
5. **RAW-first workflow** - Professional photographer focus

Last Updated: 2026-01-08
