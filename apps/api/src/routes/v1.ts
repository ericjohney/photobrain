import { Hono } from "hono";
import type { ZodType, ZodTypeDef } from "zod";
import {
	addPhotosToCollection,
	CollectionError,
	collectionsForPhoto,
	createCollection,
	deleteCollection,
	listCollections,
	removePhotosFromCollection,
	renameCollection,
} from "../services/collections";
import {
	DuplicateGroupError,
	duplicateGroups,
	resolveDuplicateGroup,
} from "../services/duplicates";
import { listEvents } from "../services/events";
import {
	assignFace,
	FaceError,
	getPerson,
	getPhotoFaces,
	listPeople,
	mergePeople,
	updatePerson,
} from "../services/faces";
import { gearStats } from "../services/gear-stats";
import { junkReview, resolveJunk } from "../services/junk-review";
import { onThisDay } from "../services/on-this-day";
import type { ApiDatabase } from "../services/photo-catalog";
import {
	getPhoto,
	listFilterOptions,
	listFolders,
	listPhotoLocations,
	listPhotos,
} from "../services/photo-catalog";
import { updatePhotoCuration } from "../services/photo-curation";
import { getPhotoPlace } from "../services/photo-places";
import type { PhotoSearchProvider } from "../services/photo-search";
import { searchPhotoCatalog } from "../services/photo-search";
import { getPhotoTags } from "../services/photo-tagging";
import type { ScanEventDispatcher } from "../services/scan-jobs";
import { getScan, listActiveScans, startScan } from "../services/scan-jobs";
import {
	createSmartAlbum,
	deleteSmartAlbum,
	listSmartAlbums,
	SmartAlbumError,
	updateSmartAlbum,
} from "../services/smart-albums";
import { findSimilarToPhoto } from "../services/vector-search";
import {
	activeScansResponseSchema,
	addCollectionPhotosResponseSchema,
	assignFaceRequestSchema,
	collectionIdSchema,
	collectionPhotosRequestSchema,
	collectionSchema,
	collectionsResponseSchema,
	createCollectionRequestSchema,
	createSmartAlbumRequestSchema,
	duplicateGroupsQuerySchema,
	duplicateGroupsResponseSchema,
	errorResponseSchema,
	eventsQuerySchema,
	eventsResponseSchema,
	faceIdSchema,
	faceSchema,
	filterOptionsQuerySchema,
	filterOptionsResponseSchema,
	foldersResponseSchema,
	gearStatsResponseSchema,
	junkReviewQuerySchema,
	junkReviewResponseSchema,
	mergePeopleRequestSchema,
	onThisDayQuerySchema,
	onThisDayResponseSchema,
	PUBLIC_SCAN_START_ERROR,
	peopleQuerySchema,
	peopleResponseSchema,
	personIdSchema,
	personSchema,
	photoCollectionsResponseSchema,
	photoCurationPatchSchema,
	photoFacesResponseSchema,
	photoFiltersSchema,
	photoIdSchema,
	photoLocationsResponseSchema,
	photoPlaceResponseSchema,
	photoSchema,
	photosResponseSchema,
	photoTagsResponseSchema,
	removeCollectionPhotosResponseSchema,
	renameCollectionRequestSchema,
	resolveDuplicateGroupRequestSchema,
	resolveDuplicateGroupResponseSchema,
	resolveJunkRequestSchema,
	resolveJunkResponseSchema,
	scanIdSchema,
	scanStatusResponseSchema,
	searchRequestSchema,
	searchResponseSchema,
	serializeCollection,
	serializeDuplicateGroupsResponse,
	serializeEvents,
	serializeJunkReviewResponse,
	serializeOnThisDay,
	serializePhoto,
	serializePhotosResponse,
	serializeScan,
	serializeSearchResponse,
	serializeSimilarPhotosResponse,
	serializeSmartAlbum,
	similarPhotosQuerySchema,
	similarPhotosResponseSchema,
	smartAlbumIdSchema,
	smartAlbumSchema,
	smartAlbumsResponseSchema,
	startScanRequestSchema,
	startScanResponseSchema,
	updatePersonRequestSchema,
	updateSmartAlbumRequestSchema,
} from "./v1-schemas";

export type V1Dependencies = {
	database: ApiDatabase;
	searchPhotos: PhotoSearchProvider;
	dispatchScan: ScanEventDispatcher;
	photoDirectory: string;
	thumbnailsDirectory: string;
	nativeScanMutationsEnabled: boolean;
};

type ErrorStatus = 400 | 404 | 409 | 500 | 503;

function jsonResponse<T>(schema: ZodType<T>, value: unknown, status = 200) {
	const body = schema.parse(value);
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=UTF-8" },
	});
}

function errorResponse(
	code: string,
	message: string,
	status: ErrorStatus,
): Response {
	return jsonResponse(
		errorResponseSchema,
		{ error: { code, message } },
		status,
	);
}

async function readJsonBody(request: Request, allowEmpty: boolean) {
	const text = await request.text();
	if (allowEmpty && text.trim().length === 0) return {};
	return JSON.parse(text) as unknown;
}

function invalidRequest(): Response {
	return errorResponse("INVALID_REQUEST", "Request validation failed", 400);
}

function internalError(error: unknown): Response {
	console.error("API v1 request failed:", error);
	return errorResponse(
		"INTERNAL_ERROR",
		"The request could not be completed",
		500,
	);
}

/** Maps collection domain errors to stable envelopes; anything else is a 500. */
function collectionError(error: unknown): Response {
	if (error instanceof CollectionError) {
		return error.code === "NAME_TAKEN"
			? errorResponse(
					"COLLECTION_NAME_TAKEN",
					"A collection with that name already exists",
					409,
				)
			: errorResponse("COLLECTION_NOT_FOUND", "Collection not found", 404);
	}
	return internalError(error);
}

/** Maps smart album domain errors to stable envelopes; anything else is a 500. */
function smartAlbumError(error: unknown): Response {
	if (error instanceof SmartAlbumError) {
		switch (error.code) {
			case "NAME_TAKEN":
				return errorResponse(
					"SMART_ALBUM_NAME_TAKEN",
					"A smart album with that name already exists",
					409,
				);
			case "NOT_FOUND":
				return errorResponse(
					"SMART_ALBUM_NOT_FOUND",
					"Smart album not found",
					404,
				);
			case "EMPTY":
				return invalidRequest();
		}
	}
	return internalError(error);
}

/** Maps duplicate-group domain errors to stable envelopes; anything else is a 500. */
function duplicateGroupError(error: unknown): Response {
	if (error instanceof DuplicateGroupError) {
		return error.code === "GROUP_CHANGED"
			? errorResponse(
					"DUPLICATE_GROUP_CHANGED",
					"The group changed since it was listed",
					409,
				)
			: invalidRequest();
	}
	return internalError(error);
}

/** Maps face/person domain errors to stable 404 envelopes; anything else is a 500. */
function faceError(error: unknown): Response {
	if (error instanceof FaceError) {
		return error.code === "FACE_NOT_FOUND"
			? errorResponse("FACE_NOT_FOUND", "Face not found", 404)
			: errorResponse("PERSON_NOT_FOUND", "Person not found", 404);
	}
	return internalError(error);
}

/** Parses a required JSON body against a strict schema; `null` means 400. */
async function parseJsonBody<T>(
	request: Request,
	schema: ZodType<T, ZodTypeDef, unknown>,
): Promise<T | null> {
	let body: unknown;
	try {
		body = await readJsonBody(request, false);
	} catch {
		return null;
	}
	const parsed = schema.safeParse(body);
	return parsed.success ? parsed.data : null;
}

export function createV1Router(dependencies: V1Dependencies) {
	const router = new Hono();

	router.get("/folders", async () => {
		try {
			return jsonResponse(
				foldersResponseSchema,
				await listFolders(dependencies.database),
			);
		} catch (error) {
			return internalError(error);
		}
	});

	router.get("/filter-options", async (context) => {
		const input = filterOptionsQuerySchema.safeParse(context.req.query());
		if (!input.success) return invalidRequest();
		try {
			return jsonResponse(
				filterOptionsResponseSchema,
				await listFilterOptions(dependencies.database, input.data, {
					normalizeDateMonths: true,
				}),
			);
		} catch (error) {
			return internalError(error);
		}
	});

	router.get("/photos", async (context) => {
		const input = photoFiltersSchema.safeParse(context.req.query());
		if (!input.success) return invalidRequest();
		try {
			const result = await listPhotos(dependencies.database, input.data, {
				normalizeDateMonths: true,
			});
			return jsonResponse(
				photosResponseSchema,
				serializePhotosResponse(result),
			);
		} catch (error) {
			return internalError(error);
		}
	});

	router.get("/locations", (context) => {
		const input = photoFiltersSchema.safeParse(context.req.query());
		if (!input.success) return invalidRequest();
		try {
			return jsonResponse(
				photoLocationsResponseSchema,
				listPhotoLocations(dependencies.database, input.data, {
					normalizeDateMonths: true,
				}),
			);
		} catch (error) {
			return internalError(error);
		}
	});

	router.get("/gear-stats", (context) => {
		const input = photoFiltersSchema.safeParse(context.req.query());
		if (!input.success) return invalidRequest();
		try {
			return jsonResponse(
				gearStatsResponseSchema,
				gearStats(dependencies.database, input.data, {
					normalizeDateMonths: true,
				}),
			);
		} catch (error) {
			return internalError(error);
		}
	});

	router.get("/on-this-day", (context) => {
		const input = onThisDayQuerySchema.safeParse(context.req.query());
		if (!input.success) return invalidRequest();
		try {
			return jsonResponse(
				onThisDayResponseSchema,
				serializeOnThisDay(onThisDay(dependencies.database, input.data.date)),
			);
		} catch (error) {
			return internalError(error);
		}
	});

	router.get("/events", (context) => {
		const input = eventsQuerySchema.safeParse(context.req.query());
		if (!input.success) return invalidRequest();
		try {
			return jsonResponse(
				eventsResponseSchema,
				serializeEvents(listEvents(dependencies.database, input.data)),
			);
		} catch (error) {
			return internalError(error);
		}
	});

	router.get("/photos/:id/similar", async (context) => {
		const id = photoIdSchema.safeParse(context.req.param("id"));
		const query = similarPhotosQuerySchema.safeParse(context.req.query());
		if (!id.success || !query.success) return invalidRequest();
		try {
			const { limit, ...filters } = query.data;
			const result = await findSimilarToPhoto(
				dependencies.database,
				id.data,
				limit,
				filters,
			);
			if (!result) {
				return errorResponse("PHOTO_NOT_FOUND", "Photo not found", 404);
			}
			return jsonResponse(
				similarPhotosResponseSchema,
				serializeSimilarPhotosResponse(result),
			);
		} catch (error) {
			return internalError(error);
		}
	});

	router.get("/photos/:id", async (context) => {
		const id = photoIdSchema.safeParse(context.req.param("id"));
		if (!id.success) return invalidRequest();
		try {
			const photo = await getPhoto(dependencies.database, id.data);
			if (!photo) {
				return errorResponse("PHOTO_NOT_FOUND", "Photo not found", 404);
			}
			return jsonResponse(photoSchema, serializePhoto(photo));
		} catch (error) {
			return internalError(error);
		}
	});

	router.get("/photos/:id/collections", (context) => {
		const id = photoIdSchema.safeParse(context.req.param("id"));
		if (!id.success) return invalidRequest();
		try {
			const result = collectionsForPhoto(dependencies.database, id.data);
			if (!result) {
				return errorResponse("PHOTO_NOT_FOUND", "Photo not found", 404);
			}
			return jsonResponse(photoCollectionsResponseSchema, result);
		} catch (error) {
			return internalError(error);
		}
	});

	router.get("/photos/:id/tags", (context) => {
		const id = photoIdSchema.safeParse(context.req.param("id"));
		if (!id.success) return invalidRequest();
		try {
			const result = getPhotoTags(dependencies.database, id.data);
			if (!result) {
				return errorResponse("PHOTO_NOT_FOUND", "Photo not found", 404);
			}
			return jsonResponse(photoTagsResponseSchema, result);
		} catch (error) {
			return internalError(error);
		}
	});

	router.get("/photos/:id/place", (context) => {
		const id = photoIdSchema.safeParse(context.req.param("id"));
		if (!id.success) return invalidRequest();
		try {
			const result = getPhotoPlace(dependencies.database, id.data);
			if (!result) {
				return errorResponse("PHOTO_NOT_FOUND", "Photo not found", 404);
			}
			return jsonResponse(photoPlaceResponseSchema, result);
		} catch (error) {
			return internalError(error);
		}
	});

	router.get("/photos/:id/faces", (context) => {
		const id = photoIdSchema.safeParse(context.req.param("id"));
		if (!id.success) return invalidRequest();
		try {
			const result = getPhotoFaces(dependencies.database, id.data);
			if (!result) {
				return errorResponse("PHOTO_NOT_FOUND", "Photo not found", 404);
			}
			return jsonResponse(photoFacesResponseSchema, result);
		} catch (error) {
			return internalError(error);
		}
	});

	router.get("/people", (context) => {
		const input = peopleQuerySchema.safeParse(context.req.query());
		if (!input.success) return invalidRequest();
		try {
			return jsonResponse(
				peopleResponseSchema,
				listPeople(dependencies.database, input.data),
			);
		} catch (error) {
			return internalError(error);
		}
	});

	router.get("/people/:id", (context) => {
		const id = personIdSchema.safeParse(context.req.param("id"));
		if (!id.success) return invalidRequest();
		try {
			const person = getPerson(dependencies.database, id.data);
			if (!person) {
				return errorResponse("PERSON_NOT_FOUND", "Person not found", 404);
			}
			return jsonResponse(personSchema, person);
		} catch (error) {
			return internalError(error);
		}
	});

	router.patch("/people/:id", async (context) => {
		const id = personIdSchema.safeParse(context.req.param("id"));
		if (!id.success) return invalidRequest();
		const input = await parseJsonBody(
			context.req.raw,
			updatePersonRequestSchema,
		);
		if (!input) return invalidRequest();
		try {
			return jsonResponse(
				personSchema,
				updatePerson(dependencies.database, id.data, input),
			);
		} catch (error) {
			return faceError(error);
		}
	});

	router.post("/people/:id/merge", async (context) => {
		const id = personIdSchema.safeParse(context.req.param("id"));
		if (!id.success) return invalidRequest();
		const input = await parseJsonBody(
			context.req.raw,
			mergePeopleRequestSchema,
		);
		if (
			!input ||
			new Set(input.sourceIds).size !== input.sourceIds.length ||
			input.sourceIds.includes(id.data)
		) {
			return invalidRequest();
		}
		try {
			return jsonResponse(
				personSchema,
				mergePeople(dependencies.database, id.data, input.sourceIds),
			);
		} catch (error) {
			return faceError(error);
		}
	});

	router.put("/faces/:id/person", async (context) => {
		const id = faceIdSchema.safeParse(context.req.param("id"));
		if (!id.success) return invalidRequest();
		const input = await parseJsonBody(context.req.raw, assignFaceRequestSchema);
		if (!input) return invalidRequest();
		try {
			return jsonResponse(
				faceSchema,
				assignFace(dependencies.database, id.data, input),
			);
		} catch (error) {
			return faceError(error);
		}
	});

	router.get("/review/junk", async (context) => {
		const input = junkReviewQuerySchema.safeParse(context.req.query());
		if (!input.success) return invalidRequest();
		try {
			return jsonResponse(
				junkReviewResponseSchema,
				serializeJunkReviewResponse(
					await junkReview(dependencies.database, input.data),
				),
			);
		} catch (error) {
			return internalError(error);
		}
	});

	router.post("/review/junk/resolve", async (context) => {
		const input = await parseJsonBody(
			context.req.raw,
			resolveJunkRequestSchema,
		);
		if (!input) return invalidRequest();
		try {
			return jsonResponse(
				resolveJunkResponseSchema,
				resolveJunk(dependencies.database, input.photoIds, input.action),
			);
		} catch (error) {
			return internalError(error);
		}
	});

	router.get("/duplicates", async (context) => {
		const input = duplicateGroupsQuerySchema.safeParse(context.req.query());
		if (!input.success) return invalidRequest();
		try {
			return jsonResponse(
				duplicateGroupsResponseSchema,
				serializeDuplicateGroupsResponse(
					await duplicateGroups(dependencies.database, input.data),
				),
			);
		} catch (error) {
			return internalError(error);
		}
	});

	router.post("/duplicates/resolve", async (context) => {
		const input = await parseJsonBody(
			context.req.raw,
			resolveDuplicateGroupRequestSchema,
		);
		if (!input) return invalidRequest();
		try {
			return jsonResponse(
				resolveDuplicateGroupResponseSchema,
				resolveDuplicateGroup(dependencies.database, input),
			);
		} catch (error) {
			return duplicateGroupError(error);
		}
	});

	router.get("/collections", () => {
		try {
			return jsonResponse(collectionsResponseSchema, {
				collections: listCollections(dependencies.database).map(
					serializeCollection,
				),
			});
		} catch (error) {
			return internalError(error);
		}
	});

	router.post("/collections", async (context) => {
		const input = await parseJsonBody(
			context.req.raw,
			createCollectionRequestSchema,
		);
		if (!input) return invalidRequest();
		try {
			const collection = createCollection(
				dependencies.database,
				input.name,
				input.photoIds,
			);
			return jsonResponse(
				collectionSchema,
				serializeCollection(collection),
				201,
			);
		} catch (error) {
			return collectionError(error);
		}
	});

	router.patch("/collections/:id", async (context) => {
		const id = collectionIdSchema.safeParse(context.req.param("id"));
		if (!id.success) return invalidRequest();
		const input = await parseJsonBody(
			context.req.raw,
			renameCollectionRequestSchema,
		);
		if (!input) return invalidRequest();
		try {
			return jsonResponse(
				collectionSchema,
				serializeCollection(
					renameCollection(dependencies.database, id.data, input.name),
				),
			);
		} catch (error) {
			return collectionError(error);
		}
	});

	router.delete("/collections/:id", (context) => {
		const id = collectionIdSchema.safeParse(context.req.param("id"));
		if (!id.success) return invalidRequest();
		try {
			deleteCollection(dependencies.database, id.data);
			return new Response(null, { status: 204 });
		} catch (error) {
			return collectionError(error);
		}
	});

	router.post("/collections/:id/photos", async (context) => {
		const id = collectionIdSchema.safeParse(context.req.param("id"));
		if (!id.success) return invalidRequest();
		const input = await parseJsonBody(
			context.req.raw,
			collectionPhotosRequestSchema,
		);
		if (!input) return invalidRequest();
		try {
			return jsonResponse(
				addCollectionPhotosResponseSchema,
				addPhotosToCollection(dependencies.database, id.data, input.photoIds),
			);
		} catch (error) {
			return collectionError(error);
		}
	});

	router.post("/collections/:id/photos/remove", async (context) => {
		const id = collectionIdSchema.safeParse(context.req.param("id"));
		if (!id.success) return invalidRequest();
		const input = await parseJsonBody(
			context.req.raw,
			collectionPhotosRequestSchema,
		);
		if (!input) return invalidRequest();
		try {
			return jsonResponse(
				removeCollectionPhotosResponseSchema,
				removePhotosFromCollection(
					dependencies.database,
					id.data,
					input.photoIds,
				),
			);
		} catch (error) {
			return collectionError(error);
		}
	});

	router.get("/smart-albums", () => {
		try {
			return jsonResponse(smartAlbumsResponseSchema, {
				albums: listSmartAlbums(dependencies.database, {
					normalizeDateMonths: true,
				}).map(serializeSmartAlbum),
			});
		} catch (error) {
			return internalError(error);
		}
	});

	router.post("/smart-albums", async (context) => {
		const input = await parseJsonBody(
			context.req.raw,
			createSmartAlbumRequestSchema,
		);
		if (!input) return invalidRequest();
		try {
			const album = createSmartAlbum(dependencies.database, input, {
				normalizeDateMonths: true,
			});
			return jsonResponse(smartAlbumSchema, serializeSmartAlbum(album), 201);
		} catch (error) {
			return smartAlbumError(error);
		}
	});

	router.patch("/smart-albums/:id", async (context) => {
		const id = smartAlbumIdSchema.safeParse(context.req.param("id"));
		if (!id.success) return invalidRequest();
		const input = await parseJsonBody(
			context.req.raw,
			updateSmartAlbumRequestSchema,
		);
		if (!input) return invalidRequest();
		try {
			return jsonResponse(
				smartAlbumSchema,
				serializeSmartAlbum(
					updateSmartAlbum(dependencies.database, id.data, input, {
						normalizeDateMonths: true,
					}),
				),
			);
		} catch (error) {
			return smartAlbumError(error);
		}
	});

	router.delete("/smart-albums/:id", (context) => {
		const id = smartAlbumIdSchema.safeParse(context.req.param("id"));
		if (!id.success) return invalidRequest();
		try {
			deleteSmartAlbum(dependencies.database, id.data);
			return new Response(null, { status: 204 });
		} catch (error) {
			return smartAlbumError(error);
		}
	});

	router.patch("/photos/:id", async (context) => {
		const id = photoIdSchema.safeParse(context.req.param("id"));
		if (!id.success) return invalidRequest();
		const patch = await parseJsonBody(
			context.req.raw,
			photoCurationPatchSchema,
		);
		if (!patch) return invalidRequest();
		try {
			const { updated } = updatePhotoCuration(
				dependencies.database,
				[id.data],
				patch,
			);
			const photo =
				updated.length > 0
					? await getPhoto(dependencies.database, id.data)
					: undefined;
			if (!photo) {
				return errorResponse("PHOTO_NOT_FOUND", "Photo not found", 404);
			}
			return jsonResponse(photoSchema, serializePhoto(photo));
		} catch (error) {
			return internalError(error);
		}
	});

	router.post("/search", async (context) => {
		const input = await parseJsonBody(context.req.raw, searchRequestSchema);
		if (!input) return invalidRequest();
		try {
			const result = await searchPhotoCatalog(
				dependencies.searchPhotos,
				input,
				{ normalizeDateMonths: true },
			);
			return jsonResponse(
				searchResponseSchema,
				serializeSearchResponse(result),
			);
		} catch (error) {
			return internalError(error);
		}
	});

	router.post("/scans", async (context) => {
		if (!dependencies.nativeScanMutationsEnabled) {
			return errorResponse(
				"NATIVE_SCAN_DISABLED",
				"Native scan mutations are disabled",
				503,
			);
		}

		let body: unknown;
		try {
			body = await readJsonBody(context.req.raw, true);
		} catch {
			return invalidRequest();
		}
		const input = startScanRequestSchema.safeParse(body);
		if (!input.success) return invalidRequest();

		try {
			const result = await startScan(
				dependencies.database,
				dependencies.dispatchScan,
				{
					force: input.data.force,
					photoDirectory: dependencies.photoDirectory,
					thumbnailsDirectory: dependencies.thumbnailsDirectory,
				},
			);
			if (result.success) {
				return jsonResponse(startScanResponseSchema, result);
			}
			return jsonResponse(startScanResponseSchema, {
				success: false,
				error: PUBLIC_SCAN_START_ERROR,
				...(result.jobId ? { jobId: result.jobId } : {}),
			});
		} catch (error) {
			return internalError(error);
		}
	});

	router.get("/scans/active", async () => {
		try {
			const jobs = await listActiveScans(dependencies.database);
			return jsonResponse(activeScansResponseSchema, {
				jobs: jobs.map(serializeScan),
			});
		} catch (error) {
			return internalError(error);
		}
	});

	router.get("/scans/:jobId", async (context) => {
		const jobId = scanIdSchema.safeParse(context.req.param("jobId"));
		if (!jobId.success) return invalidRequest();
		try {
			const job = await getScan(dependencies.database, jobId.data);
			return jsonResponse(
				scanStatusResponseSchema,
				job ? serializeScan(job) : null,
			);
		} catch (error) {
			return internalError(error);
		}
	});

	router.notFound(() =>
		errorResponse("NOT_FOUND", "API v1 route not found", 404),
	);

	return router;
}
