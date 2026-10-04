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
export type CountryOption = FilterOptions["countries"][number];
export type PlaceOption = FilterOptions["places"][number];

// Place types
export type PhotoPlace = NonNullable<RouterOutputs["photoPlace"]["place"]>;

// Collection types
export type Collection = RouterOutputs["collections"]["collections"][number];

// Smart album types
export type SmartAlbum = RouterOutputs["smartAlbums"]["albums"][number];
export type SmartAlbumFilters = RouterInputs["createSmartAlbum"]["filters"];

// Junk review types
export type JunkReviewResponse = RouterOutputs["junkReview"];
export type ReviewPhoto = JunkReviewResponse["photos"][number];
export type JunkReason = ReviewPhoto["junkReasons"][number];
export type JunkCounts = JunkReviewResponse["counts"];
export type JunkAction = RouterInputs["resolveJunk"]["action"];

// Duplicate and burst types
export type DuplicateGroupsResponse = RouterOutputs["duplicateGroups"];
export type DuplicateGroup = DuplicateGroupsResponse["groups"][number];
export type DuplicateKind = DuplicateGroup["kind"];
export type DuplicateCounts = DuplicateGroupsResponse["counts"];

// Map types
export type PhotoLocationsResponse = RouterOutputs["photoLocations"];
export type PhotoLocation = PhotoLocationsResponse["points"][number];
export type PhotoBounds = NonNullable<
	Extract<RouterInputs["photos"], object>["bounds"]
>;

// On this day types
export type OnThisDayYear = RouterOutputs["onThisDay"]["years"][number];

// Event types
export type EventSummary = RouterOutputs["events"]["events"][number];

// Gear stats types
export type GearStats = RouterOutputs["gearStats"];
export type GearCount = GearStats["cameras"][number];
export type GearBucket = GearStats["focalLengths"][number];
export type CameraYear = GearStats["cameraYears"][number];

// Face grouping types
export type Person = RouterOutputs["people"]["people"][number];
export type PhotoFace = RouterOutputs["photoFaces"]["faces"][number];
export type FaceBox = PhotoFace["box"];
