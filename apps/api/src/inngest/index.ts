import { inngest } from "./client";
import { generateEmbeddingsFunction } from "./functions/embeddings";
import { placePhotosFunction } from "./functions/places";
import { analyzeQualityFunction } from "./functions/quality";
import { scanPhotosFunction } from "./functions/scan";
import { tagPhotosFunction } from "./functions/tags";

export { inngest };

export const functions = [
	scanPhotosFunction,
	generateEmbeddingsFunction,
	tagPhotosFunction,
	analyzeQualityFunction,
	placePhotosFunction,
];
