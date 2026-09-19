import type { WebSocketRoute } from "@playwright/test";
import { DEFAULT_HANDLERS, FIXTURE_JOB_ID } from "./fixtures/handlers";
import { FIXTURE_PHOTOS } from "./fixtures/photos";
import { expect, test } from "./fixtures/test";

test("clicking refresh triggers scan mutation", async ({
	page,
	mockBackend,
}) => {
	let scanCalled = false;
	await mockBackend({
		scan: () => {
			scanCalled = true;
			return { success: true, jobId: FIXTURE_JOB_ID };
		},
	});
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
	await page.getByRole("button", { name: /scan for new photos/i }).click();
	await expect.poll(() => scanCalled).toBe(true);
});

test("refresh stays disabled from mutation through queued and running until terminal", async ({
	page,
	mockBackend,
}) => {
	let resolveScan!: () => void;
	const pendingScan = new Promise<void>((resolve) => {
		resolveScan = resolve;
	});
	let status = { phase: "queued", status: "queued", current: 0, total: 10 };
	await mockBackend({
		scan: () =>
			pendingScan.then(() => ({ success: true, jobId: FIXTURE_JOB_ID })),
		scanStatus: () => ({
			id: FIXTURE_JOB_ID,
			...status,
			error: null,
			updatedAt: new Date(),
		}),
	});
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
	const button = page.getByRole("button", { name: /scan for new photos/i });
	await button.click();
	await expect(button).toBeDisabled();
	resolveScan();
	const activity = page.getByRole("region", { name: "Activity" });
	await expect(activity.getByText("Queued", { exact: true })).toBeVisible();
	await expect(button).toBeDisabled();

	status = { phase: "processing", status: "running", current: 2, total: 10 };
	await expect(activity.getByText("2/10", { exact: true })).toBeVisible();
	await expect(activity).toHaveAttribute("aria-busy", "true");
	await expect(button).toBeDisabled();

	status = {
		phase: "scan-complete",
		status: "running",
		current: 10,
		total: 10,
	};
	await expect(activity.getByText("10/10", { exact: true })).toBeVisible();
	await expect(activity).toHaveAttribute("aria-busy", "true");
	await expect(button).toBeDisabled();

	status = { phase: "completed", status: "completed", current: 10, total: 10 };
	await expect(activity).toHaveAttribute("aria-busy", "false");
	await expect(button).toBeEnabled();
});

test("self-hosted Realtime updates scan progress after starting a job", async ({
	page,
	mockBackend,
}) => {
	let socket: WebSocketRoute | undefined;
	await page.routeWebSocket(
		"wss://realtime.example.test/v1/realtime/connect*",
		(connection) => {
			socket = connection;
		},
	);
	await mockBackend({
		realtimeToken: () => ({
			baseUrl: "https://realtime.example.test",
			token: {
				channel: `job:${FIXTURE_JOB_ID}`,
				topics: ["progress"],
				key: "test-token",
			},
		}),
	});
	await page.goto("/");
	await page.getByRole("button", { name: /scan for new photos/i }).click();
	await expect.poll(() => Boolean(socket)).toBe(true);

	const publish = (phase: string, current: number) =>
		socket?.send(
			JSON.stringify({
				kind: "data",
				channel: `job:${FIXTURE_JOB_ID}`,
				topic: "progress",
				data: { phase, current, total: 10 },
			}),
		);
	publish("processing", 2);
	await expect(
		page.getByTestId("left-panel").getByText("2/10", { exact: true }),
	).toBeVisible();
	publish("completed", 10);
	await expect(page.getByRole("region", { name: "Activity" })).toHaveAttribute(
		"aria-busy",
		"false",
	);
	await expect(
		page.getByTestId("left-panel").getByText("10/10", { exact: true }),
	).toBeVisible();
});

test("committed photos stream during processing and refreshes are coalesced", async ({
	page,
	mockBackend,
}) => {
	let socket: WebSocketRoute | undefined;
	let committed = 0;
	const requests = { photos: 0, folders: 0, filterOptions: 0 };
	const photoRequestTimes: number[] = [];
	await page.routeWebSocket(
		"wss://realtime.example.test/v1/realtime/connect*",
		(connection) => {
			socket = connection;
		},
	);
	await mockBackend({
		photos: () => {
			requests.photos++;
			photoRequestTimes.push(Date.now());
			const photos = FIXTURE_PHOTOS.slice(0, committed);
			return {
				photos,
				total: photos.length,
				rawCount: photos.filter((photo) => photo.isRaw).length,
			};
		},
		folders: (input) => {
			requests.folders++;
			return DEFAULT_HANDLERS.folders(input);
		},
		filterOptions: (input) => {
			requests.filterOptions++;
			return DEFAULT_HANDLERS.filterOptions(input);
		},
		realtimeToken: () => ({
			baseUrl: "https://realtime.example.test",
			token: {
				channel: `job:${FIXTURE_JOB_ID}`,
				topics: ["progress"],
				key: "test-token",
			},
		}),
	});
	await page.goto("/");
	await page.getByRole("button", { name: /scan for new photos/i }).click();
	await expect.poll(() => Boolean(socket)).toBe(true);
	await expect
		.poll(() => requests)
		.toEqual({
			photos: 1,
			folders: 1,
			filterOptions: 1,
		});
	const activity = page.getByRole("region", { name: "Activity" });
	const publish = (phase: string, current: number, jobId = FIXTURE_JOB_ID) =>
		socket?.send(
			JSON.stringify({
				kind: "data",
				channel: `job:${jobId}`,
				topic: "progress",
				data: { phase, current, total: 10 },
			}),
		);

	committed = 2;
	publish("processing", 2);
	await expect(activity.getByText("2/10", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("img", { name: "sunset.jpg", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("img", { name: "portrait.arw", exact: true }),
	).toBeVisible();
	await expect(activity).toHaveAttribute("aria-busy", "true");
	await expect
		.poll(() => requests)
		.toEqual({
			photos: 2,
			folders: 2,
			filterOptions: 2,
		});

	committed = 3;
	publish("processing", 3);
	await expect(activity.getByText("3/10", { exact: true })).toBeVisible();
	committed = 4;
	publish("processing", 4);
	await expect(activity.getByText("4/10", { exact: true })).toBeVisible();
	// Let real timers carry the trailing refresh through tRPC batching and
	// React Query notifications; advancing a frozen clock can strand either.
	await expect(
		page.getByRole("img", { name: "landscape.jpg", exact: true }),
	).toBeVisible();
	await expect(page.getByText("4 photos", { exact: true })).toBeVisible();
	await expect
		.poll(() => requests)
		.toEqual({
			photos: 3,
			folders: 3,
			filterOptions: 3,
		});
	// Two accepted processing updates produce only one trailing library fetch,
	// no earlier than the one-second cadence (allowing request transport jitter).
	expect(photoRequestTimes[2] - photoRequestTimes[1]).toBeGreaterThanOrEqual(
		900,
	);

	publish("processing", 4);
	publish("processing", 1);
	publish("completed", 10, "22222222-2222-4222-8222-222222222222");
	// Observe a full refresh/poll window so ignored messages cannot refresh later.
	await page.waitForTimeout(1600);
	await expect(activity.getByText("4/10", { exact: true })).toBeVisible();
	await expect(activity).toHaveAttribute("aria-busy", "true");
	expect(requests).toEqual({ photos: 3, folders: 3, filterOptions: 3 });

	publish("scan-complete", 10);
	await expect(activity.getByText("10/10", { exact: true })).toBeVisible();
	await expect.poll(() => requests.photos).toBe(4);
	await expect(activity).toHaveAttribute("aria-busy", "true");
	publish("embedding", 0);
	await expect(activity.getByText("0/10", { exact: true })).toBeVisible();
	await expect.poll(() => requests.photos).toBe(5);
	publish("embedding", 5);
	await expect(activity.getByText("5/10", { exact: true })).toBeVisible();
	await page.waitForTimeout(1600);
	expect(requests.photos).toBe(5);

	publish("completed", 10);
	await expect(activity).toHaveAttribute("aria-busy", "false");
	await expect.poll(() => requests.photos).toBe(6);
	publish("processing", 2);
	publish("completed", 10);
	await page.waitForTimeout(1600);
	await expect(activity).toHaveAttribute("aria-busy", "false");
	expect(requests.photos).toBe(6);
});

test("durable progress streams photos without a socket and failures end activity", async ({
	page,
	mockBackend,
}) => {
	let committed = 0;
	let status = { phase: "queued", status: "queued", current: 0, total: 10 };
	let photoRequests = 0;
	let statusRequests = 0;
	await page.routeWebSocket(
		"wss://realtime.example.test/v1/realtime/connect*",
		(connection) => connection.close(),
	);
	await mockBackend({
		photos: () => {
			photoRequests++;
			const photos = FIXTURE_PHOTOS.slice(0, committed);
			return {
				photos,
				total: photos.length,
				rawCount: photos.filter((photo) => photo.isRaw).length,
			};
		},
		scanStatus: () => {
			statusRequests++;
			return {
				id: FIXTURE_JOB_ID,
				...status,
				error: status.status === "failed" ? "Import failed" : null,
				updatedAt: new Date(),
			};
		},
		realtimeToken: () => ({
			baseUrl: "https://realtime.example.test",
			token: {
				channel: `job:${FIXTURE_JOB_ID}`,
				topics: ["progress"],
				key: "test-token",
			},
		}),
	});
	await page.goto("/");
	await page.getByRole("button", { name: /scan for new photos/i }).click();
	await expect.poll(() => statusRequests).toBeGreaterThan(0);
	const activity = page.getByRole("region", { name: "Activity" });
	await expect(activity).toHaveAttribute("aria-busy", "true");
	await expect(activity.getByText("Queued", { exact: true })).toBeVisible();

	committed = 2;
	status = { phase: "processing", status: "running", current: 2, total: 10 };
	await expect(activity.getByText("2/10", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("img", { name: "sunset.jpg", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("img", { name: "portrait.arw", exact: true }),
	).toBeVisible();
	await expect(activity.getByText("2/10", { exact: true })).toBeVisible();
	await expect(activity).toHaveAttribute("aria-busy", "true");
	const afterBatch = photoRequests;
	const afterBatchStatusRequests = statusRequests;
	await expect
		.poll(() => statusRequests)
		.toBeGreaterThanOrEqual(afterBatchStatusRequests + 2);
	expect(photoRequests).toBe(afterBatch);

	committed = 3;
	status = { phase: "failed", status: "failed", current: 2, total: 10 };
	await expect(activity).toHaveAttribute("aria-busy", "false");
	await expect(
		page.getByRole("img", { name: "landscape.jpg", exact: true }),
	).toBeVisible();
	const afterFailure = photoRequests;
	const terminalStatusRequests = statusRequests;
	// No further durable polls or library refreshes after a failed terminal row.
	await page.waitForTimeout(3200);
	expect(photoRequests).toBe(afterFailure);
	expect(statusRequests).toBe(terminalStatusRequests);
});
