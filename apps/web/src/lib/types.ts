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

// Filter option types
export type FilterOptions = RouterOutputs["filterOptions"];

// Collection types
export type Collection = RouterOutputs["collections"]["collections"][number];

// Junk review types
export type JunkReviewResponse = RouterOutputs["junkReview"];
export type ReviewPhoto = JunkReviewResponse["photos"][number];
export type JunkReason = ReviewPhoto["junkReasons"][number];
export type JunkCounts = JunkReviewResponse["counts"];
export type JunkAction = RouterInputs["resolveJunk"]["action"];
