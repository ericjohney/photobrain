import type { Page, Route } from "@playwright/test";
import superjson, { type SuperJSONResult } from "superjson";
import { TINY_JPEG_BYTES, TINY_WEBP_BYTES } from "./images";
import {
	FIXTURE_FOLDERS,
	FIXTURE_PHOTOS,
	type FixturePhoto,
	type FixturePhotoFilters,
	filterFixturePhotos,
	searchPhotosByQuery,
} from "./photos";

function parseTrpcBatchRequest(
	url: URL,
	method: string,
	postData: string | null,
) {
	const pathSegments = url.pathname.replace(/^.*\/trpc\//, "").split(",");
	const inputParam = url.searchParams.get("input");
	const inputs: Record<string, SuperJSONResult> = inputParam
		? JSON.parse(inputParam)
		: {};
	const body: Record<string, SuperJSONResult> =
		method === "POST" && postData ? JSON.parse(postData) : {};
	return pathSegments.map((path, i) => {
		const key = i.toString();
		const serializedInput = inputs[key] ?? body[key];
		return {
			path,
			input: serializedInput
				? superjson.deserialize(serializedInput)
				: undefined,
		};
	});
}

/** Overrides also receive the page's default handlers, to delegate to them. */
type Handler = (
	input: unknown,
	defaults: Record<string, Handler>,
) => unknown | Promise<unknown>;

export type HandlerOverrides = Partial<Record<string, Handler>>;

export const FIXTURE_JOB_ID = "11111111-1111-4111-8111-111111111111";

type CurationInput = {
	photoIds: number[];
	rating?: number;
	flag?: FixturePhoto["flag"];
};

/**
 * Builds handlers over a private copy of the fixture library, so
 * `setPhotoCuration` writes are visible to later reads on the same page.
 */
function createDefaultHandlers(): Record<string, Handler> {
	const library = FIXTURE_PHOTOS.map((photo) => ({ ...photo }));
	return {
		folders: () => FIXTURE_FOLDERS,
		photos: (input) => {
			const photos = filterFixturePhotos(
				library,
				(input ?? {}) as FixturePhotoFilters,
			);
			return {
				photos,
				total: photos.length,
				rawCount: photos.filter((p) => p.isRaw).length,
			};
		},
		searchPhotos: (input) => {
			const { query = "", ...filters } = (input ??
				{}) as FixturePhotoFilters & {
				query?: string;
			};
			const photos = searchPhotosByQuery(
				query,
				filterFixturePhotos(library, filters),
			);
			return { photos, total: photos.length, query };
		},
		similarPhotos: (input) => {
			const photoId =
				input && typeof input === "object" && "photoId" in input
					? input.photoId
					: undefined;
			if (!library.some((p) => p.id === photoId)) {
				throw new Error(`Photo ${photoId} not found`);
			}
			const photos = library.filter((p) => p.id !== photoId).reverse();
			return {
				photos,
				total: photos.length,
				sourcePhotoId: photoId,
				indexed: true,
			};
		},
		setPhotoCuration: (input) => {
			const { photoIds, rating, flag } = input as CurationInput;
			const updated = library
				.filter((p) => photoIds.includes(p.id))
				.map((p) => {
					if (rating !== undefined) p.rating = rating;
					if (flag !== undefined) p.flag = flag;
					return { id: p.id, rating: p.rating, flag: p.flag };
				});
			return { updated };
		},
		filterOptions: () => ({
			cameras: ["Sony A7III", "Canon EOS R5", "Fujifilm X-T5"],
			lenses: [
				"FE 24-70mm f/2.8 GM",
				"FE 85mm f/1.4 GM",
				"RF 15-35mm f/2.8L IS USM",
			],
			isos: [100, 200, 400, 800, 3200],
			dates: ["2024-06", "2024-07", "2024-08"],
		}),
		scan: () => ({ success: true, jobId: FIXTURE_JOB_ID }),
		scanStatus: (input) => ({
			id:
				typeof input === "object" && input !== null && "jobId" in input
					? input.jobId
					: FIXTURE_JOB_ID,
			status: "queued",
			phase: "queued",
			current: 0,
			total: 0,
			error: null,
			updatedAt: new Date("2024-01-01T00:00:00Z"),
		}),
		realtimeToken: () => ({
			token: {
				channel: `job:${FIXTURE_JOB_ID}`,
				topics: ["progress"],
				key: "test-token-xyz",
			},
		}),
	};
}

/** Inputs received by each mocked procedure, in request order. */
export type TrpcCallLog = Record<string, unknown[]>;

export async function installTrpcHandlers(
	page: Page,
	overrides: HandlerOverrides = {},
): Promise<TrpcCallLog> {
	const defaults = createDefaultHandlers();
	const handlers = { ...defaults, ...overrides };
	const calls: TrpcCallLog = {};

	await page.route(/\/trpc\//, async (route: Route) => {
		const req = route.request();
		const url = new URL(req.url());
		const batch = parseTrpcBatchRequest(url, req.method(), req.postData());
		const results = await Promise.all(
			batch.map(async ({ path, input }) => {
				const handler = handlers[path];
				if (!handler) {
					return {
						error: {
							json: { message: `No handler for ${path}`, code: -32000 },
						},
					};
				}
				(calls[path] ??= []).push(input);
				try {
					// superjson response envelope preserves Date/undefined/etc via meta
					const value = await handler(input, defaults);
					const serialized = superjson.serialize(value);
					return {
						result: {
							data: { json: serialized.json, meta: serialized.meta },
						},
					};
				} catch (error) {
					// A throwing handler (e.g. an override told to fail) becomes a
					// tRPC INTERNAL_SERVER_ERROR for that batch entry.
					return {
						error: {
							json: {
								message: error instanceof Error ? error.message : String(error),
								code: -32603,
								data: {
									code: "INTERNAL_SERVER_ERROR",
									httpStatus: 500,
									path,
								},
							},
						},
					};
				}
			}),
		);
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(results),
		});
	});

	await page.route(/\/api\/photos\/\d+\/thumbnail\//, (route) =>
		route.fulfill({
			status: 200,
			contentType: "image/webp",
			body: TINY_WEBP_BYTES,
		}),
	);
	await page.route(/\/api\/photos\/\d+\/file/, (route) =>
		route.fulfill({
			status: 200,
			contentType: "image/jpeg",
			body: TINY_JPEG_BYTES,
		}),
	);

	// Block Inngest Realtime SSE
	await page.route(/inngest\.com|\/api\/inngest/, (route) =>
		route.fulfill({ status: 204, body: "" }),
	);

	return calls;
}
