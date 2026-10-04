import { inngest } from "./client";
import { generateEmbeddingsFunction } from "./functions/embeddings";
import { detectEventsFunction } from "./functions/events";
import { detectFacesFunction } from "./functions/faces";
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
	detectEventsFunction,
	detectFacesFunction,
];
