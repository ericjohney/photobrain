import type { AppRouter } from "@photobrain/api";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

/**
 * Inferred types from tRPC router inputs/outputs
 * Centralized here to avoid repeating the inference pattern in multiple files
 */
type RouterInputs = inferRouterInputs<AppRouter>;
type RouterOutputs = inferRouterOutputs<AppRouter>;

// Photo types
export type PhotoMetadata = RouterOutputs["photos"]["photos"][number];
export type PhotosResponse = RouterOutputs["photos"];
export type SearchResponse = RouterOutputs["searchPhotos"];

// Curation types
export type PhotoFlag = NonNullable<PhotoMetadata["flag"]>;
export type FlagFilter = NonNullable<
	Extract<RouterInputs["photos"], object>["flag"]
>;

// Collection types
export type Collection = RouterOutputs["collections"]["collections"][number];
