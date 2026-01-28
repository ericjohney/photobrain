// Browser/non-Node stub for @photobrain/image-processing
// Native Rust NAPI functions are not available in browser environments.
// This stub prevents Metro/webpack from crashing when resolving the package.

const notAvailable = (name) => () => {
	throw new Error(`${name}() is not available in the browser`);
};

module.exports.batchGenerateClipEmbeddings = notAvailable("batchGenerateClipEmbeddings");
module.exports.clipTextEmbedding = notAvailable("clipTextEmbedding");
module.exports.discoverPhotos = notAvailable("discoverPhotos");
module.exports.extractExif = notAvailable("extractExif");
module.exports.generatePhash = notAvailable("generatePhash");
module.exports.generateThumbnailsFromFile = notAvailable("generateThumbnailsFromFile");
module.exports.getSupportedExtensions = notAvailable("getSupportedExtensions");
module.exports.isSupportedImage = notAvailable("isSupportedImage");
module.exports.perceptualHash = notAvailable("perceptualHash");
module.exports.processPhoto = notAvailable("processPhoto");
module.exports.processPhotosBatch = notAvailable("processPhotosBatch");
module.exports.processPhotosWithCallback = notAvailable("processPhotosWithCallback");
