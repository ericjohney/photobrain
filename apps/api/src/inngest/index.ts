import { inngest } from "./client";
import { generateEmbeddingsFunction } from "./functions/embeddings";
import { scanPhotosFunction } from "./functions/scan";
import { tagPhotosFunction } from "./functions/tags";

export { inngest };

export const functions = [
	scanPhotosFunction,
	generateEmbeddingsFunction,
	tagPhotosFunction,
];
