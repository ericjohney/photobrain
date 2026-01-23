import type { AppRouter } from "@photobrain/api";
import type { inferRouterOutputs } from "@trpc/server";

/**
 * Inferred types from tRPC router outputs
 * Centralized here to avoid repeating the inference pattern in multiple files
 */
type RouterOutputs = inferRouterOutputs<AppRouter>;

// Photo types
export type PhotoMetadata = RouterOutputs["photos"]["photos"][number];
export type PhotosResponse = RouterOutputs["photos"];
export type SearchResponse = RouterOutputs["searchPhotos"];
