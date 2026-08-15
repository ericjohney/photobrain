# PhotoBrain Development Roadmap

> **Accuracy note:** This file contains future work and historical implementation notes. Several older session sections describe an earlier BullMQ/worker/LibRaw design that is not present in the current checkout. The current implementation uses Inngest functions registered by `apps/api`, `exiftool` for EXIF and embedded RAW previews, and a native Rust N-API addon. Use `CLAUDE.md` and the scoped `AGENTS.md` guides as the source of truth for current behavior.

## Vision

PhotoBrain aims to be a fast, AI-powered self-hosted photo management solution that combines the best features of PhotoPrism and Immich with a focus on performance and semantic search capabilities.

## Current State (v0.1.0)

**Completed:**
- ✅ Monorepo architecture with Turbo + Bun
- ✅ Rust-based image processing (NAPI module)
- ✅ CLIP embeddings for semantic search (deferred batch generation)
- ✅ Perceptual hash storage for future duplicate detection
- ✅ Lightroom-inspired UI with three-panel layout, filmstrip, and loupe view
- ✅ RESTful + tRPC hybrid API with Hono.js
- ✅ SQLite database with Drizzle ORM
- ✅ Vector similarity search (sqlite-vec)
- ✅ Async directory scanning with Inngest functions registered by the API
- ✅ RAW preview support for 14+ formats via native Rust processing and `exiftool`
- ✅ HEIF/HEIC support with magic byte detection
- ✅ EXIF metadata extraction and display
- ✅ Mobile app with core browsing, search, filters, loupe, and metadata features (React Native + Expo)
- ✅ Expo web export capability for the mobile app
- ✅ Docker multi-stage builds and CI/CD pipeline
- ✅ Folder navigation
- ✅ Light & dark theme support

---

## Current Priorities

These are the next product and production-readiness priorities for the current checkout:

1. **Albums & Collections** - build the currently placeholder web and mobile screens.
2. **Duplicate detection** - add pHash similarity queries, grouped results, comparison, and safe deletion.
3. **Photo map** - use the already extracted GPS coordinates to add a map and photo markers.
4. **Mobile backup** - add camera-roll access, background upload, and offline thumbnail handling.
5. **Production hardening** - add authentication, database/file backups, deleted-file reconciliation, rate limiting, and REST/Inngest coverage.

The older RAW, worker, and queue plans below are historical. Do not select them as current work unless the architecture is deliberately changed.

---

## Historical Session Notes

The following session records preserve earlier plans and implementation notes. They are historical and may describe code that was later replaced or removed. Use the source tree and `CLAUDE.md`/`AGENTS.md` guides for current behavior.

These tasks are broken down into small, session-sized chunks that can each be completed in a single Claude Code session. Focus on delivering working, tested features incrementally.

### Historical Session 1: EXIF Data Extraction 📸 ✅ **COMPLETED**
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

### Historical Session 2: Multi-Size Thumbnail Generation 🖼️ ✅ **COMPLETED**
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

### Historical: Session 3 Async Processing Pipeline with BullMQ (superseded)
**Goal:** Move image processing off the main thread using async job queues

**Completed Implementation:**
- [x] BullMQ-based job queue system (replaced Temporal approach with simpler BullMQ)
- [x] Separate worker process (`apps/worker`) for job processing
- [x] Queue definitions for scan, phash, and embedding jobs
- [x] SSE-based real-time progress reporting (`onTaskProgress` tRPC subscription)
- [x] Frontend live progress updates during scan/processing
- [x] Redis/Valkey backend for job persistence
- [x] Deferred CLIP embeddings — generated as post-scan batch job (~70% faster scanning)

**Architecture:** API enqueues jobs → Redis → Worker dequeues and processes → SSE streams progress to frontend

**Files created:** `apps/worker/` (entire worker app), queue/worker definitions
**Files modified:** `apps/api/src/trpc/router.ts` (scan mutation, progress subscription)

---

### Historical: Session 4 RAW Image Support (superseded)
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

### Historical Session 5: HEIF/HEIC Support 🍎 ✅ **COMPLETED**
**Goal:** Support Apple's HEIF/HEIC image format

**Deliverables:**
- [x] Add `libheif-rs` crate for HEIF decoding
- [x] Detect `.heic` and `.heif` extensions
- [x] Decode HEIF images to RGB for processing
- [x] Generate thumbnails and CLIP embeddings for HEIF files
- [x] Unified with standard image pipeline

**Files created:** `packages/image-processing/src/heif.rs`

---

### Historical Session 6: Lens Corrections 🔍 **FUTURE**
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

### Historical Session 7: EXIF-Based Filtering 🔍 ✅ **COMPLETED**
**Goal:** Filter photos by camera metadata

**Completed:**
- [x] `filterOptions` tRPC procedure returns distinct cameras, lenses, ISOs, date months
- [x] `photos` procedure extended with camera, lens, iso, dateMonth filter params
- [x] DB indexes on EXIF columns for fast filtering
- [x] Web: interactive Filter By sidebar with collapsible Camera/Lens/ISO/Date sections
- [x] Mobile: FilterSheet bottom sheet with filter icon in header
- [x] Filters combine with folder selection (AND logic), hidden during search
- [x] Web E2E tests (3) + mobile unit tests (7) for filter functionality

**Files created:** `apps/mobile/src/components/FilterSheet.tsx`, `apps/web/e2e/filter.spec.ts`
**Files modified:** `apps/api/src/trpc/router.ts`, `apps/web/src/pages/Dashboard.tsx`, `apps/web/src/components/panels/LibraryPanel.tsx`, `apps/mobile/src/screens/DashboardScreen.tsx`, `packages/db/src/schema.ts`

---

### Historical Session 8: GPS Coordinate Extraction 🗺️ ✅ **PARTIALLY COMPLETED**
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

### Historical Session 9: Duplicate Detection UI 🔎 **NOT STARTED**
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

---

## Phase 1: Image Processing & Metadata 🟡 **PARTIALLY COMPLETED**

### 1.1 RAW Image Support 🟡 **PARTIALLY COMPLETED**
**Goal:** Enable viewing, processing, and conversion of RAW image formats

**Current Implementation:**
- [x] Native Rust image-processing pipeline
- [x] Support for 14+ RAW formats: CR2, CR3, NEF, ARW, DNG, RAF, ORF, RW2, PEF, SRW, X3F, 3FR, IIQ, RWL
- [ ] RAW demosaicing and full RAW conversion (the current pipeline extracts an embedded JPEG preview with `exiftool`)
- [ ] Per-channel histogram matching to match camera's embedded JPEG preview
- [x] Unified processing pipeline (`batch.rs`) handles RAW, HEIF, and standard images
- [x] Memory-efficient parallel processing (limited to 4 threads for large RAW files)
- [x] Database schema with `isRaw`, `rawFormat`, `rawStatus`, `rawError` fields
- [x] Thumbnail generation (tiny/small/medium/large) for RAW files
- [x] CLIP embeddings generated from the RAW's large preview thumbnail
- [ ] Reprocess RAW endpoint for failed conversions
- [x] RAW/standard filtering in the API
- [ ] RAW/standard filter controls in the web and mobile clients
- [x] HEIF/HEIC support via `libheif-rs`

**Technical Implementation:**
- RAW previews are extracted with `exiftool -b -PreviewImage`, falling back to `-JpgFromRaw`
- RAW support requires an embedded JPEG preview; this checkout does not use LibRaw or `rsraw`
- Thumbnails are stored as WebP at four configured sizes
- `exiftool` is required for EXIF and RAW preview extraction

### 1.2 Enhanced Image Metadata 🟡 **PARTIALLY COMPLETED**
- [x] EXIF data extraction (camera model, settings, lens, GPS)
  - ✅ Extracted through the external `exiftool` executable
- [ ] XMP sidecar support for non-destructive edits
- [x] Display full EXIF in photo detail view
- [ ] Parse IPTC metadata (keywords, copyright, descriptions)
- [x] GPS coordinate extraction and display (map view remains pending)

---

## Phase 2: Core Photo Management 🟡 **PARTIALLY COMPLETED**

### 2.1 Organization & Filtering 🟡 **PARTIALLY COMPLETED**
- [ ] **Albums & Collections**
  - Manual album creation
  - Automatic smart albums (based on date, location, tags)
  - Nested album support
- [x] **Date-grouped browsing on mobile**
- [ ] **Timeline and calendar views on web**
- [x] **Camera, lens, ISO, and month filtering**
- [x] **RAW/standard filtering in the API**
- [ ] **RAW/standard filter controls in clients**
- [ ] **Aperture and shutter-speed filtering**
- [ ] **Dimension, orientation, and MIME-type filtering**

### 2.2 Tagging & Classification ⏳ **NOT STARTED**
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

### 2.3 Duplicate Detection 🟡 **PARTIALLY COMPLETED**
- [x] Generate and store a pHash during scanning
- [ ] Create a pHash similarity search query
- [ ] Build duplicate finder UI
- [ ] Show similar photos side-by-side
- [ ] Batch deletion of duplicates
- [ ] Configurable similarity threshold

---

## Phase 3: Mobile & Backup 🟡 **PARTIALLY COMPLETED**

### 3.1 Mobile Applications 🟡 **PARTIALLY COMPLETED**
**Inspired by Immich's automatic backup**

- [x] **React Native mobile app** (iOS + Android) with core browsing and search
  - LoupeView with swipe navigation
  - MetadataPanel with collapsible EXIF sections
  - ActivityBar for scan/embedding progress
  - Theme system with dark/light mode
  - Semantic search via SearchBar
- [x] Expo web export capability
- [ ] Collections screen
- [ ] Functional share, favorite, delete, and overflow actions in the loupe
- [ ] Functional display and behavior preferences beyond theme
- [ ] Native camera roll access
- [ ] Background photo upload
- [ ] Push notifications for upload completion
- [ ] **Automatic backup service**
  - Periodic background sync
  - Only upload new photos
  - Configurable backup quality (original vs compressed)
  - WiFi-only option
- [ ] **Offline support**
  - [x] Basic thumbnail caching through `expo-image`
  - [ ] Offline browsing and cache management
  - Full-resolution download on demand

### 3.2 Import & Export ⏳ **NOT STARTED**
- [ ] **Bulk import wizard**
  - Import from local directories
  - Import from external drives
  - Import from cloud services (Google Photos, iCloud, Dropbox)
- [ ] **Export functionality**
  - Export albums as ZIP
  - Export with original metadata
  - Export with selected quality/format

---

## Phase 4: Advanced AI & Search 🟡 **PARTIALLY COMPLETED**

### 4.1 Enhanced Search 🟡 **PARTIALLY COMPLETED**
- [x] **Text semantic search**
- [ ] **Multi-modal search extensions**
  - Search by similar images (reverse image search)
  - Search within date ranges
  - Search by location radius
- [x] AND combination for ordinary folder and EXIF filters
- [ ] Combine EXIF/folder filters with semantic search
- [ ] OR logic for multiple filters
- [ ] Saved searches
- [ ] Debounced search input
- [ ] **OCR (Optical Character Recognition)**
  - Extract text from images
  - Search photos by text content (signs, documents, screenshots)

### 4.2 AI Enhancements ⏳ **NOT STARTED**
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

## Phase 5: Maps & Geolocation 🟡 **PARTIALLY COMPLETED**

**Inspired by PhotoPrism's 3D Earth view**

### 5.1 Map Integration
- [x] Extract and display GPS coordinates
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

## Phase 6: Sharing & Collaboration ⏳ **NOT STARTED**

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

## Phase 7: Performance & Scalability 🟡 **PARTIALLY COMPLETED**

### 7.1 Optimization 🟡 **PARTIALLY COMPLETED**
- [x] **Progressive image loading**
  - Responsive WebP thumbnail sizes and `srcset` on web
  - Lazy loading on the web grid
  - Blurhash placeholders and disk caching on mobile
- [x] **Image caching foundations**
  - Generate multiple thumbnail sizes
  - Browser caching headers and ETags
- [ ] Optional S3/Cloudflare image storage or CDN integration
- [x] **Database indexes for common EXIF filters**
- [ ] Pagination improvements for large libraries
- [ ] Query result caching
- [x] **Parallel scan processing with Rayon**
- [x] **Async scan and embedding jobs with Inngest**

### 7.2 Storage Management ⏳ **NOT STARTED**
- [ ] **Storage analytics**
  - Show disk usage by user/album
  - Identify large files
- [ ] **Smart storage**
  - Automatic compression for old photos
  - Tiered storage (hot/cold)
  - Optional cloud backup integration

---

## Phase 8: Advanced Features ⏳ **NOT STARTED**

### 8.1 Video Support ⏳ **NOT STARTED**
Video files are not currently discovered or processed by the image pipeline.

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

### 8.2 Photo Editing ⏳ **NOT STARTED**
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

### 8.3 Memories & Rediscovery ⏳ **NOT STARTED**
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
- [x] **Docker containerization**
  - Multi-stage Dockerfile with builder, API, web-builder, web, and mobile targets
  - Mobile target runs the Expo development server; it is not a static web-export image
- [x] **CI/CD pipeline**
  - GitHub Actions workflow tests web/mobile and builds API, web, and mobile images
  - Pushes to `registry.ericj5.com`
  - ArgoCD GitOps tag updates for API, web, and mobile
- [ ] **Docker Compose for easy local deployment**
- [ ] **Documentation**
  - API documentation (OpenAPI/Swagger)
  - User guide
  - [x] Developer setup and architecture guide (`README.md`, `CLAUDE.md`, and scoped `AGENTS.md` files)
- [ ] **Test coverage gaps**
  - [x] API filter integration tests
  - [x] Mobile Jest tests for core screens and hooks
  - [x] Web Playwright tests for main dashboard flows
  - [x] Rust tests for HEIF detection
  - [ ] REST, Inngest, vector-search, thumbnail, and broader fixture-based Rust coverage

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

Last reviewed: 2026-08-14 (current-status update)
