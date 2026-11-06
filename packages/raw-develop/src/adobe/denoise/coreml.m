// Public Core ML API bridge. No private Espresso APIs or embedded model assets.
#import <CoreML/CoreML.h>
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <sys/sysctl.h>

static void PBMessage(char *out, size_t capacity, NSString *message) {
  if (capacity) snprintf(out, capacity, "%s", (message ?: @"Core ML failed").UTF8String);
}
static NSString *PBSysctl(const char *name) {
  char value[256] = {0}; size_t length = sizeof(value);
  return sysctlbyname(name, value, &length, NULL, 0) == 0
    ? [NSString stringWithUTF8String:value] : @"unknown";
}

int pb_coreml_identity(char *out, size_t capacity) {
  @autoreleasepool {
    NSString *version = [[NSBundle bundleForClass:MLModel.class] objectForInfoDictionaryKey:@"CFBundleVersion"] ?: @"unknown";
    NSMutableArray<NSString *> *devices = [NSMutableArray new];
    for (id<MTLDevice> device in MTLCopyAllDevices()) {
      [devices addObject:[NSString stringWithFormat:@"%@:%llu", device.name, (unsigned long long)device.registryID]];
    }
    [devices sortUsingSelector:@selector(compare:)];
    PBMessage(out, capacity, [NSString stringWithFormat:@"%@:%@:%@:framework=%@:eligible-metal=%@",
      PBSysctl("hw.model"), PBSysctl("machdep.cpu.brand_string"),
      NSProcessInfo.processInfo.operatingSystemVersionString, version, [devices componentsJoinedByString:@","]]);
    return 0;
  }
}

@interface PBModel : NSObject
@property(nonatomic, strong) MLModel *model;
@property(nonatomic, strong) MLMultiArray *input;
@property(nonatomic, strong) MLArrayBatchProvider *batch;
@property(nonatomic, copy) NSString *outputName;
@property(nonatomic, copy) NSArray<NSNumber *> *outputShape;
@property(nonatomic, strong) NSURL *sourceDirectory;
@property(nonatomic, strong) NSURL *compiledURL;
@end
@implementation PBModel
- (void)dealloc {
  _batch = nil; _input = nil; _model = nil;
  if (_compiledURL) [NSFileManager.defaultManager removeItemAtURL:_compiledURL error:NULL];
  if (_sourceDirectory) [NSFileManager.defaultManager removeItemAtURL:_sourceDirectory error:NULL];
}
@end

static NSArray<NSNumber *> *PBShape(const size_t *shape) {
  return @[@(shape[0]), @(shape[1]), @(shape[2])];
}
static BOOL PBValidateFeature(MLFeatureDescription *feature, NSArray<NSNumber *> *shape) {
  return feature.type == MLFeatureTypeMultiArray
    && feature.multiArrayConstraint.dataType == MLMultiArrayDataTypeFloat32
    && [feature.multiArrayConstraint.shape isEqualToArray:shape];
}

void *pb_coreml_create(const uint8_t *bytes, size_t length, bool all,
                      const size_t *inputShape, const size_t *outputShape,
                      char *errorText, size_t capacity) {
  @autoreleasepool { @try {
    NSError *error = nil;
    PBModel *state = [PBModel new];
    state.sourceDirectory = [NSURL fileURLWithPath:[NSTemporaryDirectory()
      stringByAppendingPathComponent:[@"photobrain-coreml-" stringByAppendingString:NSUUID.UUID.UUIDString]] isDirectory:YES];
    if (![NSFileManager.defaultManager createDirectoryAtURL:state.sourceDirectory
      withIntermediateDirectories:NO attributes:nil error:&error]) {
      PBMessage(errorText, capacity, error.localizedDescription); return NULL;
    }
    NSURL *source = [state.sourceDirectory URLByAppendingPathComponent:@"model.mlmodel"];
    // Compile the exact bytes that Rust hashed, avoiding a source-path race.
    if (![[NSData dataWithBytes:bytes length:length] writeToURL:source options:NSDataWritingAtomic error:&error]) {
      PBMessage(errorText, capacity, error.localizedDescription); return NULL;
    }
    state.compiledURL = [MLModel compileModelAtURL:source error:&error];
    if (!state.compiledURL) { PBMessage(errorText, capacity, error.localizedDescription); return NULL; }
    MLModelConfiguration *configuration = [MLModelConfiguration new];
    configuration.computeUnits = all ? MLComputeUnitsAll : MLComputeUnitsCPUAndGPU;
    configuration.allowLowPrecisionAccumulationOnGPU = NO;
    state.model = [MLModel modelWithContentsOfURL:state.compiledURL configuration:configuration error:&error];
    if (!state.model) { PBMessage(errorText, capacity, error.localizedDescription); return NULL; }
    NSDictionary *inputs = state.model.modelDescription.inputDescriptionsByName;
    NSDictionary *outputs = state.model.modelDescription.outputDescriptionsByName;
    NSArray *shape = PBShape(inputShape);
    state.outputShape = PBShape(outputShape);
    if (inputs.count != 1 || outputs.count != 1
      || !PBValidateFeature(inputs.allValues.firstObject, shape)
      || !PBValidateFeature(outputs.allValues.firstObject, state.outputShape)) {
      PBMessage(errorText, capacity, @"Core ML feature names/types/shapes do not match the PBDN model"); return NULL;
    }
    state.outputName = outputs.allKeys.firstObject;
    state.input = [[MLMultiArray alloc] initWithShape:shape dataType:MLMultiArrayDataTypeFloat32 error:&error];
    if (!state.input) { PBMessage(errorText, capacity, error.localizedDescription); return NULL; }
    MLDictionaryFeatureProvider *provider = [[MLDictionaryFeatureProvider alloc]
      initWithDictionary:@{inputs.allKeys.firstObject: [MLFeatureValue featureValueWithMultiArray:state.input]} error:&error];
    if (!provider) { PBMessage(errorText, capacity, error.localizedDescription); return NULL; }
    state.batch = [[MLArrayBatchProvider alloc] initWithFeatureProviderArray:@[provider]];
    return (__bridge_retained void *)state;
  } @catch (NSException *exception) {
    PBMessage(errorText, capacity, exception.reason); return NULL;
  } }
}

// MLMultiArray output can be padded/noncontiguous. Always respect its strides.
static void PBCopy(MLMultiArray *array, float *packed, BOOL toArray) {
  size_t c = array.shape[0].unsignedLongLongValue;
  size_t h = array.shape[1].unsignedLongLongValue;
  size_t w = array.shape[2].unsignedLongLongValue;
  size_t sc = array.strides[0].unsignedLongLongValue;
  size_t sh = array.strides[1].unsignedLongLongValue;
  size_t sw = array.strides[2].unsignedLongLongValue;
  float *native = array.dataPointer;
  if (sw == 1 && sh == w && sc == h * w) {
    if (toArray) memcpy(native, packed, c*h*w*sizeof(float));
    else memcpy(packed, native, c*h*w*sizeof(float));
    return;
  }
  for (size_t z=0; z<c; ++z) for (size_t y=0; y<h; ++y) for (size_t x=0; x<w; ++x) {
    size_t i=(z*h+y)*w+x, j=z*sc+y*sh+x*sw;
    if (toArray) native[j]=packed[i]; else packed[i]=native[j];
  }
}

int pb_coreml_predict(void *handle, const float *input, float *output, char *errorText, size_t capacity) {
  @autoreleasepool { @try {
    PBModel *state = (__bridge PBModel *)handle;
    PBCopy(state.input, (float *)input, YES);
    NSError *error = nil;
    id<MLBatchProvider> result = [state.model predictionsFromBatch:state.batch error:&error];
    if (!result || result.count != 1) { PBMessage(errorText, capacity, error.localizedDescription); return 1; }
    MLMultiArray *array = [[result featuresAtIndex:0] featureValueForName:state.outputName].multiArrayValue;
    if (!array || array.dataType != MLMultiArrayDataTypeFloat32 || ![array.shape isEqualToArray:state.outputShape]) {
      PBMessage(errorText, capacity, @"Core ML returned an unexpected output tensor"); return 1;
    }
    PBCopy(array, output, NO);
    return 0;
  } @catch (NSException *exception) {
    PBMessage(errorText, capacity, exception.reason); return 1;
  } }
}

void pb_coreml_destroy(void *handle) {
  @autoreleasepool { (void)CFBridgingRelease(handle); }
}
