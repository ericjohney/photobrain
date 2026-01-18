export {
	discoverPhotos,
	quickProcessPhoto,
	savePhotoToDb,
	getPhotosNeedingPhash,
	getPhotosNeedingEmbedding,
	type QuickProcessResult,
	type SavePhotoResult,
} from "./scan";

export { generatePhash, savePhashToDb } from "./phash";

export { generateClipEmbedding, saveEmbeddingToDb } from "./embedding";
