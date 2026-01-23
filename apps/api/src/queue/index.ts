import {
	type EmbeddingJobData,
	type PhashJobData,
	QUEUE_NAMES,
	type QueueName,
	type ScanJobData,
} from "@photobrain/utils";
import type { JobsOptions } from "bullmq";
import { Queue, QueueEvents } from "bullmq";
import IORedis from "ioredis";

// Re-export for convenience
export {
	QUEUE_NAMES,
	type QueueName,
	type ScanJobData,
	type PhashJobData,
	type EmbeddingJobData,
};

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// Shared Redis connection
export const redis = new IORedis(REDIS_URL, {
	maxRetriesPerRequest: null,
});

// Default job options
const defaultJobOptions: JobsOptions = {
	removeOnComplete: { count: 100 },
	removeOnFail: { count: 50 },
	attempts: 3,
	backoff: {
		type: "exponential",
		delay: 1000,
	},
};

// Create queues
export const scanQueue = new Queue(QUEUE_NAMES.SCAN, {
	connection: redis,
	defaultJobOptions,
});

export const phashQueue = new Queue(QUEUE_NAMES.PHASH, {
	connection: redis,
	defaultJobOptions,
});

export const embeddingQueue = new Queue(QUEUE_NAMES.EMBEDDING, {
	connection: redis,
	defaultJobOptions,
});

// Queue events for real-time monitoring
export const scanQueueEvents = new QueueEvents(QUEUE_NAMES.SCAN, {
	connection: redis,
});

export const phashQueueEvents = new QueueEvents(QUEUE_NAMES.PHASH, {
	connection: redis,
});

export const embeddingQueueEvents = new QueueEvents(QUEUE_NAMES.EMBEDDING, {
	connection: redis,
});

// Helper to get queue by name
export function getQueue(name: QueueName): Queue {
	switch (name) {
		case QUEUE_NAMES.SCAN:
			return scanQueue;
		case QUEUE_NAMES.PHASH:
			return phashQueue;
		case QUEUE_NAMES.EMBEDDING:
			return embeddingQueue;
	}
}

// Helper to get queue events by name
export function getQueueEvents(name: QueueName): QueueEvents {
	switch (name) {
		case QUEUE_NAMES.SCAN:
			return scanQueueEvents;
		case QUEUE_NAMES.PHASH:
			return phashQueueEvents;
		case QUEUE_NAMES.EMBEDDING:
			return embeddingQueueEvents;
	}
}

// Add a scan job
export async function addScanJob(data: ScanJobData) {
	const job = await scanQueue.add("scan-directory", data, {
		jobId: `scan-${Date.now()}`,
	});
	return job;
}

// Add phash job for a photo
export async function addPhashJob(data: PhashJobData) {
	const job = await phashQueue.add("generate-phash", data, {
		jobId: `phash-${data.photoId}`,
	});
	return job;
}

// Add embedding job for a photo
export async function addEmbeddingJob(data: EmbeddingJobData) {
	const job = await embeddingQueue.add("generate-embedding", data, {
		jobId: `embedding-${data.photoId}`,
	});
	return job;
}

// Get all active/waiting jobs across all queues
export async function getAllActiveJobs() {
	const [scanJobs, phashJobs, embeddingJobs] = await Promise.all([
		scanQueue.getJobs(["active", "waiting", "delayed"]),
		phashQueue.getJobs(["active", "waiting", "delayed"]),
		embeddingQueue.getJobs(["active", "waiting", "delayed"]),
	]);

	return {
		scan: scanJobs,
		phash: phashJobs,
		embedding: embeddingJobs,
	};
}

// Get job counts for all queues
export async function getJobCounts() {
	const [scanCounts, phashCounts, embeddingCounts] = await Promise.all([
		scanQueue.getJobCounts("active", "waiting", "completed", "failed"),
		phashQueue.getJobCounts("active", "waiting", "completed", "failed"),
		embeddingQueue.getJobCounts("active", "waiting", "completed", "failed"),
	]);

	return {
		scan: scanCounts,
		phash: phashCounts,
		embedding: embeddingCounts,
	};
}

console.log("📫 BullMQ queues initialized");
