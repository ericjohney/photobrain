import { utimes, writeFile } from "node:fs/promises";
import type { Page, Request, Route } from "@playwright/test";
import { FIXTURE_JOB_ID, FIXTURE_UPLOAD_CONFIG } from "./fixtures/handlers";
import { expect, test } from "./fixtures/test";

declare global {
	interface Window {
		/** `File {name} {size}` per `XMLHttpRequest.send` of a File. */
		__uploadBodies?: string[];
	}
}

// `capturedAt` is the file's local wall clock with this zone's offset.
test.use({ timezoneId: "America/Denver" });

const UPLOAD_CONFIG = {
	...FIXTURE_UPLOAD_CONFIG,
	enabled: true,
	maxBytes: 1024,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UPLOAD_ROUTE = /\/api\/v1\/uploads\?/;

async function enableUploads(page: Page) {
	await page.route(/\/api\/v1\/uploads\/config$/, (route) =>
		route.fulfill({ json: UPLOAD_CONFIG }),
	);
}

/** Writes a file with a fixed mtime; returns its absolute path. */
async function fixtureFile(
	path: string,
	bytes: string | Buffer,
	modified = new Date("2024-07-04T18:30:15Z"),
) {
	await writeFile(path, bytes);
	await utimes(path, modified, modified);
	return path;
}

function uploadParams(request: Request) {
	return Object.fromEntries(new URL(request.url()).searchParams);
}

const uploadButton = (page: Page) =>
	page.getByRole("button", { name: "Upload photos" });
const queue = (page: Page) => page.getByRole("dialog", { name: "Uploads" });
const itemStatus = (page: Page, name: string) =>
	queue(page)
		.getByRole("listitem", { name, exact: true })
		.getByTestId("upload-status");

test("the upload button is disabled with a tooltip when uploads are off", async ({
	page,
}) => {
	const configRequest = page.waitForRequest(/\/api\/v1\/uploads\/config$/);
	await page.goto("/");
	await configRequest;
	await expect(uploadButton(page)).toBeDisabled();
	await page.getByTestId("upload-button-wrapper").hover();
	await expect(page.getByRole("tooltip")).toHaveText(
		"Uploads are disabled on the server",
	);
	// Dropping files is ignored too.
	await expect(page.getByTestId("upload-drop-overlay")).toHaveCount(0);
});

test("picker uploads send the contract query and render each outcome", async ({
	page,
	mockBackend,
}, testInfo) => {
	const requests: Request[] = [];
	let activeJobs: { id: string }[] = [];
	let scanPhase = "queued";
	const calls = await mockBackend({
		scanStatus: () => ({
			id: FIXTURE_JOB_ID,
			status: scanPhase === "queued" ? "queued" : "running",
			phase: scanPhase,
			current: scanPhase === "queued" ? 0 : 1,
			total: 3,
			error: null,
			updatedAt: new Date(),
		}),
	});
	await enableUploads(page);
	await page.route(/\/api\/v1\/scans\/active$/, (route) =>
		route.fulfill({ json: { jobs: activeJobs } }),
	);
	await page.addInitScript(() => {
		const bodies: string[] = [];
		window.__uploadBodies = bodies;
		const send = XMLHttpRequest.prototype.send;
		XMLHttpRequest.prototype.send = function (body) {
			if (body instanceof File) {
				bodies.push(`File ${body.name} ${body.size}`);
			}
			return send.call(this, body);
		};
	});
	const outcomes: Record<string, { status: number; json: unknown }> = {
		"IMG_0001.HEIC": {
			status: 201,
			json: {
				status: "created",
				path: "Uploads/Web/2024/07/IMG_0001.HEIC",
				size: 5,
			},
		},
		"beach.jpg": {
			status: 200,
			json: {
				status: "duplicate",
				path: "photos/2024/beach.jpg",
				size: 5,
			},
		},
		"scan.png": {
			status: 415,
			json: {
				error: { code: "UNSUPPORTED_MEDIA", message: "Unsupported media" },
			},
		},
		"big.dng": {
			status: 507,
			json: {
				error: { code: "INSUFFICIENT_STORAGE", message: "Disk full" },
			},
		},
	};
	await page.route(UPLOAD_ROUTE, (route) => {
		requests.push(route.request());
		const filename = uploadParams(route.request()).filename;
		return route.fulfill(outcomes[filename]);
	});

	await page.goto("/");
	await expect(uploadButton(page)).toBeEnabled();
	await expect(page.getByTestId("upload-input")).toHaveAttribute(
		"accept",
		UPLOAD_CONFIG.extensions.join(","),
	);
	await page
		.getByTestId("upload-input")
		.setInputFiles([
			await fixtureFile(testInfo.outputPath("IMG_0001.HEIC"), "heic!"),
			await fixtureFile(testInfo.outputPath("beach.jpg"), "jpeg!"),
			await fixtureFile(testInfo.outputPath("scan.png"), "png!!"),
		]);

	await expect(itemStatus(page, "IMG_0001.HEIC")).toHaveText("Uploaded");
	await expect(itemStatus(page, "beach.jpg")).toHaveText("Already in library");
	await expect(itemStatus(page, "scan.png")).toHaveText(
		"Unsupported file type",
	);
	expect(requests).toHaveLength(3);
	const deviceId = uploadParams(requests[0]).deviceId;
	expect(deviceId).toMatch(UUID);
	expect(
		requests.map((request) => uploadParams(request)).sort((a, b) =>
			a.filename.localeCompare(b.filename),
		),
	).toEqual(
		["IMG_0001.HEIC", "beach.jpg", "scan.png"]
			.sort((a, b) => a.localeCompare(b))
			.map((filename) => ({
				deviceId,
				deviceName: "Web",
				filename,
				capturedAt: "2024-07-04T12:30:15-06:00",
			})),
	);
	for (const request of requests) {
		expect(request.method()).toBe("POST");
		expect(request.headers()["content-type"]).toBe("application/octet-stream");
	}
	// Intercepted file bodies are not exposed to Playwright; the page records
	// what it sent.
	expect(
		await page.evaluate(() => (window.__uploadBodies ?? []).sort()),
	).toEqual(["File IMG_0001.HEIC 5", "File beach.jpg 5", "File scan.png 5"]);

	// A created file announces the import, which is tracked by the scan
	// progress once the server's debounced scan appears.
	await expect(queue(page).getByRole("status")).toHaveText(
		"Import will start shortly",
	);
	const photosBefore = calls.photos?.length ?? 0;
	activeJobs = [{ id: FIXTURE_JOB_ID }];
	await expect.poll(() => calls.scanStatus?.length ?? 0).toBeGreaterThan(0);
	await expect(queue(page).getByRole("status")).toHaveCount(0);
	expect(calls.photos?.length ?? 0).toBe(photosBefore);
	scanPhase = "processing";
	await expect
		.poll(() => calls.photos?.length ?? 0)
		.toBeGreaterThan(photosBefore);
	await expect(
		page.getByRole("region", { name: "Activity" }).getByText("1/3"),
	).toBeVisible();

	// 507 is mapped to readable text; deviceId survives a reload.
	await page.reload();
	await page
		.getByTestId("upload-input")
		.setInputFiles([await fixtureFile(testInfo.outputPath("big.dng"), "raw!!")]);
	await expect(itemStatus(page, "big.dng")).toHaveText(
		"Not enough storage space on the server",
	);
	expect(requests).toHaveLength(4);
	expect(uploadParams(requests[3]).deviceId).toBe(deviceId);

	// Clear finished empties the queue (and its toggle).
	await queue(page).getByRole("button", { name: "Clear finished" }).click();
	await expect(page.getByRole("button", { name: "Upload queue" })).toHaveCount(
		0,
	);
});

test("unsupported and oversize files are rejected without a request", async ({
	page,
}) => {
	await enableUploads(page);
	let uploads = 0;
	await page.route(UPLOAD_ROUTE, (route) => {
		uploads++;
		return route.fulfill({
			status: 201,
			json: { status: "created", path: "Uploads/Web/x.jpg", size: 1 },
		});
	});
	await page.goto("/");
	await expect(uploadButton(page)).toBeEnabled();
	await page.getByTestId("upload-input").setInputFiles([
		{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") },
		{ name: "README", mimeType: "text/plain", buffer: Buffer.from("hi") },
		{
			name: "huge.jpg",
			mimeType: "image/jpeg",
			buffer: Buffer.alloc(UPLOAD_CONFIG.maxBytes + 1),
		},
		{
			name: "limit.JPG",
			mimeType: "image/jpeg",
			buffer: Buffer.alloc(UPLOAD_CONFIG.maxBytes),
		},
	]);
	await expect(itemStatus(page, "notes.txt")).toHaveText(
		"Unsupported file type (.txt)",
	);
	await expect(itemStatus(page, "README")).toHaveText("Unsupported file type");
	await expect(itemStatus(page, "huge.jpg")).toHaveText(
		"Larger than the 1 KB upload limit",
	);
	await expect(itemStatus(page, "limit.JPG")).toHaveText("Uploaded");
	expect(uploads).toBe(1);
});

test("dropping files on the library shows an overlay and uploads them", async ({
	page,
}) => {
	await enableUploads(page);
	const filenames: string[] = [];
	await page.route(UPLOAD_ROUTE, (route) => {
		filenames.push(uploadParams(route.request()).filename);
		return route.fulfill({
			status: 201,
			json: { status: "created", path: "Uploads/Web/dropped.jpg", size: 3 },
		});
	});
	await page.goto("/");
	await expect(uploadButton(page)).toBeEnabled();
	const zone = page.getByTestId("upload-drop-zone");
	const dataTransfer = await page.evaluateHandle(() => {
		const transfer = new DataTransfer();
		transfer.items.add(
			new File(["abc"], "dropped.jpg", { type: "image/jpeg" }),
		);
		transfer.items.add(new File(["abc"], "dropped.txt", { type: "text/plain" }));
		return transfer;
	});
	await zone.dispatchEvent("dragenter", { dataTransfer });
	await zone.dispatchEvent("dragover", { dataTransfer });
	await expect(page.getByTestId("upload-drop-overlay")).toBeVisible();
	await expect(page.getByTestId("upload-drop-overlay")).toHaveText(
		"Drop photos to upload",
	);
	await zone.dispatchEvent("drop", { dataTransfer });
	await expect(page.getByTestId("upload-drop-overlay")).toHaveCount(0);
	await expect(itemStatus(page, "dropped.jpg")).toHaveText("Uploaded");
	await expect(itemStatus(page, "dropped.txt")).toHaveText(
		"Unsupported file type (.txt)",
	);
	expect(filenames).toEqual(["dropped.jpg"]);
});

test("cancel aborts the upload request", async ({ page }) => {
	await enableUploads(page);
	const held: Route[] = [];
	await page.route(UPLOAD_ROUTE, (route) => {
		held.push(route);
	});
	const failed = page.waitForEvent("requestfailed", (request) =>
		UPLOAD_ROUTE.test(request.url()),
	);
	await page.goto("/");
	await expect(uploadButton(page)).toBeEnabled();
	await page.getByTestId("upload-input").setInputFiles([
		{ name: "slow.jpg", mimeType: "image/jpeg", buffer: Buffer.from("abc") },
	]);
	await expect.poll(() => held.length).toBe(1);
	await expect(itemStatus(page, "slow.jpg")).toHaveText(/%$/);
	await queue(page).getByRole("button", { name: "Cancel slow.jpg" }).click();
	expect((await failed).url()).toBe(held[0].request().url());
	await expect(itemStatus(page, "slow.jpg")).toHaveText("Cancelled");
	await expect(
		queue(page).getByRole("button", { name: "Cancel slow.jpg" }),
	).toHaveCount(0);
});

test("no more than two uploads are in flight", async ({ page }) => {
	await enableUploads(page);
	const held: Route[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	await page.route(UPLOAD_ROUTE, (route) => {
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		held.push(route);
	});
	const release = async () => {
		const route = held.shift();
		if (!route) throw new Error("No held upload");
		inFlight--;
		await route.fulfill({
			status: 201,
			json: { status: "created", path: "Uploads/Web/x.jpg", size: 3 },
		});
	};
	await page.goto("/");
	await expect(uploadButton(page)).toBeEnabled();
	await page.getByTestId("upload-input").setInputFiles(
		["a", "b", "c", "d", "e"].map((name) => ({
			name: `${name}.jpg`,
			mimeType: "image/jpeg",
			buffer: Buffer.from("abc"),
		})),
	);
	await expect.poll(() => held.length).toBe(2);
	await page.waitForTimeout(200);
	expect(held.length).toBe(2);
	await expect(itemStatus(page, "e.jpg")).toHaveText("Waiting");

	for (let released = 0; released < 5; released++) {
		await expect.poll(() => held.length).toBe(Math.min(2, 5 - released));
		await release();
	}
	for (const name of ["a", "b", "c", "d", "e"]) {
		await expect(itemStatus(page, `${name}.jpg`)).toHaveText("Uploaded");
	}
	expect(maxInFlight).toBe(2);
});
