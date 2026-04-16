import { expect, test } from "./fixtures/test";

test("clicking refresh triggers scan mutation", async ({ page, mockBackend }) => {
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
});
