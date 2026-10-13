// apple-reference: macOS-only oracle for raw-develop calibration.
//
// For one RAW file, writes Apple's (RawCamera / CIRAWFilter) intermediate and final
// renders into an output directory so raw-develop can be validated against them:
//
//   params.json        CIRAWFilter properties for the file (as-shot defaults)
//   graph.txt          CI_PRINT_TREE initial render graph (kernel parameters)
//   cfa.u16            RawCamera's decoded mosaic ("CRawImage" provider), LE u16, full sensor
//   <variant>.lin.f32  scene-linear Display P3 (pre look/tone) captured at the
//                      linearSpaceFilter hook, 4x box-downsampled, top row first
//   <variant>.crop.f32 same, full-resolution 1024x1024 centre crop
//   final.q.f32        final render (Display P3 encoded values, orientation applied), 4x box-downsampled
//   final.crop.f32     final render, full-resolution 1024x1024 centre crop
//
// .f32 files are: 16-byte header ("RDF32\0\0\0", u32 width, u32 height) then interleaved
// RGB float32 little-endian rows.
//
// Variants: "default" (as shot), "nonr" (noise reduction and sharpening off),
// "nolens" (default with lens correction off).
//
// Build: clang -fobjc-arc -O2 -framework CoreImage -framework Foundation \
//          -framework ImageIO -framework UniformTypeIdentifiers apple-reference.m -o apple-reference
// Never built in CI. Apple's code and per-camera data are only executed, never copied.

#import <CoreImage/CoreImage.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <objc/runtime.h>

static CIImage *gCfa;
static size_t gCfaW, gCfaH;
typedef id (*InitFn)(id, SEL, id, size_t, size_t, int, CGColorSpaceRef, id);
static InitFn gOrigInit;

static id hookInit(id self, SEL s, id p, size_t w, size_t h, int f, CGColorSpaceRef cs, id o) {
  id r = gOrigInit(self, s, p, w, h, f, cs, o);
  if (!gCfa && [[o objectForKey:@"kCIImageProviderName"] isEqual:@"CRawImage"]) {
    gCfa = r;
    gCfaW = w;
    gCfaH = h;
  }
  return r;
}

// Pass-through filter used as CIRAWFilter.linearSpaceFilter; records its input.
// CIRAWFilter sets inputImage, reads outputImage, then clears inputImage, so the
// image is recorded when outputImage is requested.
@interface Capture : CIFilter
@property(nonatomic, strong) CIImage *inputImage;
@property(nonatomic, strong) CIImage *captured;
@end
@implementation Capture
- (CIImage *)outputImage {
  if (self.inputImage) self.captured = self.inputImage;
  return self.inputImage;
}
@end

static CIContext *linearContext(void) {
  return [CIContext contextWithOptions:@{
    kCIContextWorkingFormat : @(kCIFormatRGBAf),
    kCIContextWorkingColorSpace : (__bridge id)CGColorSpaceCreateWithName(kCGColorSpaceExtendedLinearSRGB),
  }];
}

static float *renderRGBAf(CIContext *ctx, CIImage *img, CGRect r, CGColorSpaceRef cs) {
  size_t w = (size_t)r.size.width, h = (size_t)r.size.height;
  float *buf = malloc(w * h * 16);
  [ctx render:img toBitmap:buf rowBytes:w * 16 bounds:r format:kCIFormatRGBAf colorSpace:cs];
  return buf;
}

static void writeF32(NSString *path, const float *rgb, uint32_t w, uint32_t h) {
  NSMutableData *d = [NSMutableData dataWithCapacity:16 + (size_t)w * h * 12];
  [d appendBytes:"RDF32\0\0\0" length:8];
  [d appendBytes:&w length:4];
  [d appendBytes:&h length:4];
  [d appendBytes:rgb length:(size_t)w * h * 12];
  [d writeToFile:path atomically:YES];
}

// Box-downsample RGBA float (top row first) by `f`, emitting RGB.
static float *downsample(const float *rgba, size_t w, size_t h, size_t f, size_t *ow, size_t *oh) {
  *ow = w / f;
  *oh = h / f;
  float *out = calloc((*ow) * (*oh) * 3, sizeof(float));
  for (size_t y = 0; y < *oh; y++)
    for (size_t x = 0; x < *ow; x++) {
      double s[3] = {0, 0, 0};
      for (size_t dy = 0; dy < f; dy++)
        for (size_t dx = 0; dx < f; dx++) {
          const float *p = rgba + ((y * f + dy) * w + (x * f + dx)) * 4;
          s[0] += p[0];
          s[1] += p[1];
          s[2] += p[2];
        }
      for (int c = 0; c < 3; c++) out[(y * (*ow) + x) * 3 + c] = (float)(s[c] / (f * f));
    }
  return out;
}

static void dumpImage(CIContext *ctx, CIImage *img, CGColorSpaceRef cs, NSString *dir, NSString *stem) {
  CGRect e = img.extent;
  size_t w = (size_t)e.size.width, h = (size_t)e.size.height;
  float *full = renderRGBAf(ctx, img, e, cs);
  size_t ow, oh;
  float *q = downsample(full, w, h, 4, &ow, &oh);
  writeF32([dir stringByAppendingPathComponent:[stem stringByAppendingString:@".q.f32"]], q, (uint32_t)ow, (uint32_t)oh);
  free(q);
  size_t cw = MIN((size_t)1024, w), ch = MIN((size_t)1024, h);
  size_t cx = (w - cw) / 2, cy = (h - ch) / 2;
  float *crop = malloc(cw * ch * 12);
  for (size_t y = 0; y < ch; y++)
    for (size_t x = 0; x < cw; x++)
      for (int c = 0; c < 3; c++) crop[(y * cw + x) * 3 + c] = full[((cy + y) * w + cx + x) * 4 + c];
  writeF32([dir stringByAppendingPathComponent:[stem stringByAppendingString:@".crop.f32"]], crop, (uint32_t)cw, (uint32_t)ch);
  free(crop);
  free(full);
}

static NSDictionary *filterParams(CIRAWFilter *f) {
  return @{
    @"decoderVersion" : f.decoderVersion ?: @"",
    @"neutralTemperature" : @(f.neutralTemperature),
    @"neutralTint" : @(f.neutralTint),
    @"baselineExposure" : @(f.baselineExposure),
    @"exposure" : @(f.exposure),
    @"boostAmount" : @(f.boostAmount),
    @"boostShadowAmount" : @(f.shadowBias),
    @"luminanceNoiseReductionAmount" : @(f.luminanceNoiseReductionAmount),
    @"colorNoiseReductionAmount" : @(f.colorNoiseReductionAmount),
    @"sharpnessAmount" : @(f.sharpnessAmount),
    @"detailAmount" : @(f.detailAmount),
    @"contrastAmount" : @(f.contrastAmount),
    @"localToneMapAmount" : @(f.localToneMapAmount),
    @"lensCorrectionEnabled" : @(f.lensCorrectionEnabled),
    @"lensCorrectionSupported" : @(f.lensCorrectionSupported),
    @"nativeWidth" : @(f.nativeSize.width),
    @"nativeHeight" : @(f.nativeSize.height),
    @"orientation" : @(f.orientation),
  };
}

static CIRAWFilter *makeFilter(NSURL *url, NSString *variant, Capture *cap) {
  CIRAWFilter *f = [CIRAWFilter filterWithImageURL:url];
  if ([variant isEqual:@"nonr"]) {
    f.luminanceNoiseReductionAmount = 0;
    f.colorNoiseReductionAmount = 0;
    f.sharpnessAmount = 0;
    f.detailAmount = 0;
  } else if ([variant isEqual:@"nolens"]) {
    f.lensCorrectionEnabled = NO;
  }
  if (cap) f.linearSpaceFilter = cap;
  return f;
}

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc < 3) {
      fprintf(stderr, "usage: apple-reference <file> <outdir>\n"
                      "       apple-reference <file> --graph <graph.txt>   (render graph only)\n");
      return 2;
    }
    if (argc >= 4 && !strcmp(argv[2], "--graph")) {
      // Only the CI_PRINT_TREE graph, for noise-table transcription.
      NSTask *t = [NSTask new];
      t.executableURL = [NSURL fileURLWithPath:[[NSProcessInfo processInfo] arguments][0]];
      t.arguments = @[ @(argv[1]), @"--graph-only" ];
      NSMutableDictionary *env = [[[NSProcessInfo processInfo] environment] mutableCopy];
      env[@"CI_PRINT_TREE"] = @"1";
      env[@"APPLE_REF_GRAPH_CHILD"] = @"1";
      t.environment = env;
      NSString *gpath = @(argv[3]);
      [[NSFileManager defaultManager] createFileAtPath:gpath contents:nil attributes:nil];
      NSFileHandle *fh = [NSFileHandle fileHandleForWritingAtPath:gpath];
      t.standardError = fh;
      t.standardOutput = fh;
      [t launchAndReturnError:nil];
      [t waitUntilExit];
      return t.terminationStatus;
    }
    NSURL *url = [NSURL fileURLWithPath:@(argv[1])];
    NSString *dir = @(argv[2]);
    if ([dir isEqual:@"--graph-only"]) {
      // Child process: render a 1024px region so CI_PRINT_TREE prints the graph.
      CIRAWFilter *f = [CIRAWFilter filterWithImageURL:url];
      CIContext *c = [CIContext contextWithOptions:nil];
      CGImageRef g = [c createCGImage:f.outputImage fromRect:CGRectMake(0, 0, 1024, 1024)];
      CGImageRelease(g);
      return 0;
    }
    [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];

    Method m = class_getInstanceMethod([CIImage class],
                                       NSSelectorFromString(@"initWithImageProvider:width:height:format:colorSpace:options:"));
    gOrigInit = (InitFn)method_setImplementation(m, (IMP)hookInit);

    CGColorSpaceRef linP3 = CGColorSpaceCreateWithName(kCGColorSpaceExtendedLinearDisplayP3);
    CGColorSpaceRef p3 = CGColorSpaceCreateWithName(kCGColorSpaceDisplayP3);
    CIContext *ctx = linearContext();

    // Default filter: params, CFA, final render.
    CIRAWFilter *f = makeFilter(url, @"default", nil);
    CIImage *out = f.outputImage;
    if (!out) {
      fprintf(stderr, "CIRAWFilter could not decode %s\n", argv[1]);
      return 1;
    }
    NSData *pj = [NSJSONSerialization dataWithJSONObject:filterParams(f)
                                                 options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys
                                                   error:nil];
    [pj writeToFile:[dir stringByAppendingPathComponent:@"params.json"] atomically:YES];

    if (gCfa) {
      size_t bpr = gCfaW * 2;
      NSMutableData *d = [NSMutableData dataWithLength:bpr * gCfaH];
      CIContext *raw = [CIContext contextWithOptions:@{
        kCIContextWorkingColorSpace : [NSNull null],
        kCIContextOutputColorSpace : [NSNull null],
        kCIContextWorkingFormat : @(kCIFormatRGBAf),
      }];
      [raw render:[gCfa imageBySamplingNearest]
           toBitmap:d.mutableBytes
           rowBytes:bpr
             bounds:CGRectMake(0, 0, gCfaW, gCfaH)
             format:kCIFormatL16
         colorSpace:nil];
      [d writeToFile:[dir stringByAppendingPathComponent:@"cfa.u16"] atomically:YES];
      NSString *meta = [NSString stringWithFormat:@"{\"width\":%zu,\"height\":%zu}\n", gCfaW, gCfaH];
      [meta writeToFile:[dir stringByAppendingPathComponent:@"cfa.json"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
    } else {
      fprintf(stderr, "warning: CRawImage provider not captured; cfa.u16 not written\n");
    }

    // Final render (P3-encoded values), downsampled and centre crop.
    dumpImage(ctx, out, p3, dir, @"final");

    // Linear captures per variant.
    for (NSString *variant in @[ @"default", @"nonr", @"nolens" ]) {
      Capture *cap = [Capture new];
      CIRAWFilter *vf = makeFilter(url, variant, cap);
      CIImage *vo = vf.outputImage;
      (void)vo;
      if (!cap.captured) {
        fprintf(stderr, "warning: linearSpaceFilter not invoked for %s\n", variant.UTF8String);
        continue;
      }
      dumpImage(ctx, cap.captured, linP3, dir, [variant stringByAppendingString:@".lin"]);
    }

    // Render graph (CI_PRINT_TREE writes to stderr); re-exec self with the env var set.
    if (!getenv("APPLE_REF_GRAPH_CHILD")) {
      NSTask *t = [NSTask new];
      t.executableURL = [NSURL fileURLWithPath:[[NSProcessInfo processInfo] arguments][0]];
      t.arguments = @[ @(argv[1]), @"--graph-only" ];
      NSMutableDictionary *env = [[[NSProcessInfo processInfo] environment] mutableCopy];
      env[@"CI_PRINT_TREE"] = @"1";
      env[@"APPLE_REF_GRAPH_CHILD"] = @"1";
      t.environment = env;
      NSString *gpath = [dir stringByAppendingPathComponent:@"graph.txt"];
      [[NSFileManager defaultManager] createFileAtPath:gpath contents:nil attributes:nil];
      NSFileHandle *fh = [NSFileHandle fileHandleForWritingAtPath:gpath];
      t.standardError = fh;
      t.standardOutput = fh;
      [t launchAndReturnError:nil];
      [t waitUntilExit];
    }
    fprintf(stderr, "wrote %s\n", dir.UTF8String);
  }
  return 0;
}
