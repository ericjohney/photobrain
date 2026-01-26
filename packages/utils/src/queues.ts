/**
 * Shared queue constants and types for BullMQ job queues
 * Used by both API and Worker packages
 */

// Queue names - must be consistent between API and Worker
export const QUEUE_NAMES = {
	SCAN: "scan",
	PHASH: "phash",
	EMBEDDING: "embedding",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// Job data types
export interface ScanJobData {
	directory: string;
	thumbnailsDir: string;
}

export interface PhashJobData {
	photoId: number;
	thumbnailsDir: string;
}

export interface BatchEmbeddingJobData {
	photoIds: number[];
	thumbnailsDir: string;
}
