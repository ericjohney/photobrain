import type { WebSocketRoute } from "@playwright/test";
import { expect, test } from "./fixtures/test";

test("clicking refresh triggers scan mutation", async ({
	page,
	mockBackend,
}) => {
	let scanCalled = false;
	await mockBackend({
		scan: () => {
			scanCalled = true;
			return { success: true, jobId: "test-job-123" };
		},
	});
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
	await page.getByRole("button", { name: /scan for new photos/i }).click();
	await expect.poll(() => scanCalled).toBe(true);
});

test("refresh button is disabled while scan pending", async ({
	page,
	mockBackend,
}) => {
	let resolveScan: ((v: unknown) => void) | null = null;
	await mockBackend({
		scan: () =>
			new Promise((r) => {
				resolveScan = r;
			}).then(() => ({ success: true, jobId: "test-job-123" })),
	});
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
	const button = page.getByRole("button", { name: /scan for new photos/i });
	await button.click();
	await expect(button).toBeDisabled();
	resolveScan?.(null);
	// Wait for mutation to settle
	await expect(button).toBeEnabled({ timeout: 5000 });
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
				channel: "job:test-job-123",
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
				channel: "job:test-job-123",
				topic: "progress",
				data: { phase, current, total: 10 },
			}),
		);
	publish("processing", 2);
	await expect(
		page.getByText("Processing Photos", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByTestId("left-panel").getByText("2/10", { exact: true }),
	).toBeVisible();
	publish("completed", 10);
	await expect(page.getByText("Complete", { exact: true })).toBeVisible();
	await expect(
		page.getByTestId("left-panel").getByText("10/10", { exact: true }),
	).toBeVisible();
});
