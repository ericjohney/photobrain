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

## Phase 1: RAW Support & Image Processing 🎯 **IMMEDIATE PRIORITY**

### 1.1 RAW Image Support
**Goal:** Enable viewing, processing, and conversion of RAW image formats

**Tasks:**
- [ ] Evaluate RawTherapee CLI vs Darktable CLI for batch processing
  - RawTherapee: Better for simple conversion, faster on lower-end hardware
  - Darktable: More advanced features, GPU acceleration, selective editing with masks
  - **Recommendation:** Start with RawTherapee CLI for simplicity, add Darktable as advanced option later
- [ ] Add system dependencies detection (rawtherapee-cli installation check)
- [ ] Implement RAW format detection (.CR2, .NEF, .ARW, .DNG, .RAF, etc.)
- [ ] Create RAW converter service in Rust
  - Use `std::process::Command` to invoke rawtherapee-cli
  - Generate JPEG previews for gallery display
  - Store both RAW originals and converted versions
- [ ] Add thumbnail generation for RAW files
  - Small thumbnails (200px) for grid view
  - Medium previews (1200px) for lightbox
  - Large exports (full resolution) on demand
- [ ] Update database schema to track RAW files
  - Add `isRaw: boolean` field
  - Add `rawFormat: text` field (CR2, NEF, etc.)
  - Add `convertedPath: text` for JPEG preview location
- [ ] Add RAW file upload endpoint
- [ ] Update frontend to display RAW badge/indicator
- [ ] Add RAW processing settings (PP3 profiles for RawTherapee)
  - Default profile for quick conversion
  - Custom profiles for advanced users

**Technical Notes:**
- RawTherapee CLI: `rawtherapee-cli -c <input.raw> -o <output.jpg> -p <profile.pp3>`
- Darktable CLI: `darktable-cli <input.raw> <xmp-file> <output.jpg>`
- Process conversions asynchronously (job queue)
- Cache converted previews to avoid re-processing

### 1.2 Enhanced Image Metadata
- [ ] EXIF data extraction (camera model, settings, lens, GPS)
  - Integrate with Rust using `kamadak-exif` or `rexiv2` crate
- [ ] XMP sidecar support for non-destructive edits
- [ ] Display full EXIF in photo detail view
- [ ] Parse IPTC metadata (keywords, copyright, descriptions)
- [ ] GPS coordinate extraction for maps integration

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
  - Batch processing queue (BullMQ or similar)

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

Last Updated: 2025-12-30
