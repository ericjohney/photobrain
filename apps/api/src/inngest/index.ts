import { inngest } from "./client";
import { generateEmbeddingsFunction } from "./functions/embeddings";
import { scanPhotosFunction } from "./functions/scan";

export { inngest };

export const functions = [scanPhotosFunction, generateEmbeddingsFunction];
