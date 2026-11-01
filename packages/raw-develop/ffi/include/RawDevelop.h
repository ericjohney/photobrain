#ifndef PHOTOBRAIN_RAW_DEVELOP_H
#define PHOTOBRAIN_RAW_DEVELOP_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

typedef struct PBRAWSession PBRAWSession;
/* Smart-preview bytes are borrowed for this call only. The returned session owns
 * decoded state. Same cancellation/error/image ownership as pbraw_open/render. */

typedef struct PBRAWCancel PBRAWCancel;
typedef struct PBRAWImage PBRAWImage;
/* Initialise to zero. Each failed call owns message until pbraw_error_clear.
   Codes: 1 failure, 2 unsupported, 3 invalid settings, 4 cancelled, 5 panic. */
typedef struct { int32_t code; char *message; } PBRAWError;
void pbraw_error_clear(PBRAWError *error);

PBRAWCancel *pbraw_cancel_new(void);
/* Safe concurrently with open/render. Keep the token alive until they return. */
void pbraw_cancel_request(const PBRAWCancel *cancel);
void pbraw_cancel_free(PBRAWCancel *cancel);

/* Opens and prepares Preview-quality pixels, capped at 2048, with a second
   1024-edge drag preview. UTF-8 path; errors/panics return NULL. */
PBRAWSession *pbraw_open(const char *path, const PBRAWCancel *cancel, PBRAWError *error);
/* Session operations must be serialised. Do not free during a render. */
void pbraw_session_free(PBRAWSession *session);
/* refined=0 uses 1024; refined=1 uses 2048 (no upscaling). No encoding or I/O.
   Output is oriented RGBA8, opaque, transfer-encoded Display P3. */
PBRAWImage *pbraw_render(const PBRAWSession *session, double exposure, int32_t refined,
                        const PBRAWCancel *cancel, PBRAWError *error);
size_t pbraw_image_width(const PBRAWImage *image);
size_t pbraw_image_height(const PBRAWImage *image);
size_t pbraw_image_len(const PBRAWImage *image);
/* Borrowed until image_free. Copy or transfer through an owner before freeing. */
const uint8_t *pbraw_image_pixels(const PBRAWImage *image);
void pbraw_image_free(PBRAWImage *image);


PBRAWSession *pbraw_open_smart_preview(const uint8_t *bytes, size_t len, const PBRAWCancel *cancel, PBRAWError *error);
PBRAWImage *pbraw_render_basic(const PBRAWSession *session, double exposure, int32_t contrast, int32_t highlights, int32_t shadows, int32_t whites, int32_t blacks, int32_t refined, const PBRAWCancel *cancel, PBRAWError *error);
#ifdef __cplusplus
}
#endif
#endif
