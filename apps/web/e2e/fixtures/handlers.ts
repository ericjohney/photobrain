import type { Page, Route } from "@playwright/test";
import { FIXTURE_FOLDERS, FIXTURE_PHOTOS, searchPhotosByQuery } from "./photos";
import { TINY_JPEG_BYTES, TINY_WEBP_BYTES } from "./images";

function parseTrpcBatchRequest(
	url: URL,
	method: string,
	postData: string | null,
) {
	const pathSegments = url.pathname.replace(/^.*\/trpc\//, "").split(",");
	const inputParam = url.searchParams.get("input");
	const inputs: Record<string, unknown> = inputParam
		? JSON.parse(inputParam)
		: {};
	const body: Record<string, unknown> =
		method === "POST" && postData ? JSON.parse(postData) : {};
	return pathSegments.map((path, i) => {
		const key = i.toString();
		const queryInput = inputs[key] as { json?: unknown } | undefined;
		const bodyInput = body[key] as { json?: unknown } | undefined;
		return {
			path,
			// superjson wraps inputs as { json: value }
			input:
				queryInput?.json ?? bodyInput?.json ?? queryInput ?? bodyInput ?? null,
		};
	});
}

type Handler = (input: unknown) => unknown | Promise<unknown>;

export type HandlerOverrides = Partial<Record<string, Handler>>;

export const DEFAULT_HANDLERS: Record<string, Handler> = {
	folders: () => FIXTURE_FOLDERS,
	photos: () => ({
		photos: FIXTURE_PHOTOS,
		total: FIXTURE_PHOTOS.length,
		rawCount: FIXTURE_PHOTOS.filter((p) => p.isRaw).length,
	}),
	searchPhotos: (input) => {
		const q = (input as { query?: string } | null)?.query ?? "";
		const photos = searchPhotosByQuery(q);
		return { photos, total: photos.length, query: q };
	},
	scan: () => ({ success: true, jobId: "test-job-123" }),
	realtimeToken: () => ({ token: "test-token-xyz" }),
};

export async function installTrpcHandlers(
	page: Page,
	overrides: HandlerOverrides = {},
) {
	const handlers = { ...DEFAULT_HANDLERS, ...overrides };

	await page.route(/\/trpc\//, async (route: Route) => {
		const req = route.request();
		const url = new URL(req.url());
		const calls = parseTrpcBatchRequest(url, req.method(), req.postData());
		const results = await Promise.all(
			calls.map(async ({ path, input }) => {
				const handler = handlers[path];
				if (!handler) {
					return {
						error: {
							json: { message: `No handler for ${path}`, code: -32000 },
						},
					};
				}
				// superjson response envelope: { result: { data: { json: value } } }
				return { result: { data: { json: await handler(input) } } };
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
}
