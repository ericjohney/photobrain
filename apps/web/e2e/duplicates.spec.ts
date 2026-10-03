import type { Page } from "@playwright/test";
import { FIXTURE_LIBRARY } from "./fixtures/photos";
import { expect, test } from "./fixtures/test";

/** Shown groups in API order (see FIXTURE_DUPLICATE_GROUPS). */
const GROUP_KEYS = [
	"duplicate:2,5,9",
	"burst:6,7,8",
	"duplicate:10,12",
	"duplicate:1,3",
];

function leftPanel(page: Page) {
	return page.getByTestId("left-panel");
}

function duplicatesItem(page: Page) {
	return leftPanel(page).getByRole("button", { name: /^Duplicates/ });
}

function kindRadio(page: Page, label: string) {
	return page
		.getByRole("radiogroup", { name: "Group kind" })
		.getByRole("radio", { name: new RegExp(`^${label}`) });
}

async function groupKeys(page: Page) {
	return page
		.getByTestId("duplicate-group")
		.evaluateAll((els) => els.map((el) => el.getAttribute("data-group-key")));
}

function group(page: Page, key: string) {
	return page.locator(
		`[data-testid="duplicate-group"][data-group-key="${key}"]`,
	);
}

function member(page: Page, key: string, id: number) {
	return group(page, key).locator(`[data-photo-id="${id}"]`);
}

function gridCell(page: Page, id: number) {
	return page.locator(`[data-testid="photo-grid"] [data-photo-id="${id}"]`);
}

/** A promise the test resolves to release a held mock response. */
function gate() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

async function openDuplicates(page: Page) {
	await page.goto("/");
	await expect(page.getByText(`${FIXTURE_LIBRARY.length} photos`)).toBeVisible();
	await expect(duplicatesItem(page)).toContainText("4");
	await duplicatesItem(page).click();
	await expect.poll(() => groupKeys(page)).toEqual(GROUP_KEYS);
}

test("Duplicates shows groups with the suggested keeper preselected", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openDuplicates(page);

	await expect(duplicatesItem(page)).toHaveAttribute("aria-pressed", "true");
	await expect(kindRadio(page, "All")).toHaveAttribute("aria-checked", "true");
	await expect(kindRadio(page, "Duplicates")).toHaveText("Duplicates(3)");
	await expect(kindRadio(page, "Bursts")).toHaveText("Bursts(1)");
	// Library filters are hidden, like in Review.
	await expect(leftPanel(page).getByText("Filter By")).toHaveCount(0);

	// The keeper (RAW portrait.arw) leads its group, preselected and badged.
	const first = group(page, "duplicate:2,5,9");
	await expect(
		first
			.locator("[data-photo-id]")
			.evaluateAll((els) =>
				els.map((el) => Number(el.getAttribute("data-photo-id"))),
			),
	).resolves.toEqual([2, 5, 9]);
	await expect(member(page, "duplicate:2,5,9", 2)).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(member(page, "duplicate:2,5,9", 5)).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await expect(first.getByTestId("suggested-badge")).toHaveCount(1);
	await expect(
		member(page, "duplicate:2,5,9", 2).getByTestId("suggested-badge"),
	).toHaveText("Suggested");
	await expect(member(page, "duplicate:2,5,9", 2)).toContainText("ARW");
	await expect(
		member(page, "duplicate:2,5,9", 5).getByTestId("duplicate-photo-details"),
	).toContainText("4000 × 6000");
	await expect(
		first.getByRole("button", { name: "Keep selected, reject 2" }),
	).toBeVisible();
	// Burst keeper is the ★4 pick.
	await expect(
		member(page, "burst:6,7,8", 8).getByTestId("suggested-badge"),
	).toBeVisible();
	await expect(
		member(page, "burst:6,7,8", 8).getByRole("img", { name: "4 stars" }),
	).toBeVisible();

	// The badge is a one-group request; the list loads one page.
	expect(calls.duplicateGroups).toContainEqual({ limit: 1 });
	// All sends no kind; the first page sends no cursor.
	expect(calls.duplicateGroups?.at(-1)).toMatchObject({ limit: 50 });
	expect(calls.duplicateGroups?.at(-1)).toEqual(
		expect.not.objectContaining({ kind: expect.anything() }),
	);
	expect(calls.duplicateGroups?.at(-1)).toEqual(
		expect.not.objectContaining({ cursor: expect.anything() }),
	);
});

test("the kind filter requests that kind and narrows the groups", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openDuplicates(page);

	await kindRadio(page, "Bursts").click();
	await expect(kindRadio(page, "Bursts")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expect.poll(() => groupKeys(page)).toEqual(["burst:6,7,8"]);
	expect(calls.duplicateGroups?.at(-1)).toMatchObject({
		kind: "burst",
		limit: 50,
	});

	await kindRadio(page, "Duplicates").click();
	await expect
		.poll(() => groupKeys(page))
		.toEqual(["duplicate:2,5,9", "duplicate:10,12", "duplicate:1,3"]);
	expect(calls.duplicateGroups?.at(-1)).toMatchObject({ kind: "duplicate" });

	await kindRadio(page, "All").click();
	await expect.poll(() => groupKeys(page)).toEqual(GROUP_KEYS);
});

test("Keep selected rejects the unselected members and removes the group", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openDuplicates(page);
	const rightPanel = page.getByTestId("right-panel");
	const first = group(page, "duplicate:2,5,9");

	// Selecting city.jpg also makes it the active photo.
	await member(page, "duplicate:2,5,9", 9).click();
	await expect(member(page, "duplicate:2,5,9", 9)).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(rightPanel.getByText("city.jpg")).toBeVisible();
	await member(page, "duplicate:2,5,9", 2).click();
	await expect(member(page, "duplicate:2,5,9", 2)).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	// The last kept photo cannot be deselected.
	await member(page, "duplicate:2,5,9", 9).click();
	await expect(member(page, "duplicate:2,5,9", 9)).toHaveAttribute(
		"aria-pressed",
		"true",
	);

	await first.getByRole("button", { name: "Keep selected, reject 2" }).click();
	await expect
		.poll(() => groupKeys(page))
		.toEqual(["burst:6,7,8", "duplicate:10,12", "duplicate:1,3"]);
	await expect(duplicatesItem(page)).toContainText("3");
	await expect(kindRadio(page, "Duplicates")).toHaveText("Duplicates(2)");
	await expect
		.poll(() => calls.resolveDuplicateGroup)
		.toEqual([{ key: "duplicate:2,5,9", action: "keep", keepIds: [9] }]);
	// The settle refetch agrees: a lone kept photo forms no group.
	await expect
		.poll(() => calls.duplicateGroups?.length ?? 0)
		.toBeGreaterThan(2);
	await expect
		.poll(() => groupKeys(page))
		.toEqual(["burst:6,7,8", "duplicate:10,12", "duplicate:1,3"]);

	// The rejected photos show as rejected back in the library.
	await page.getByRole("button", { name: "Exit duplicates" }).click();
	await expect(gridCell(page, 2)).toHaveAttribute("data-rejected", "true");
	await expect(gridCell(page, 5)).toHaveAttribute("data-rejected", "true");
	await expect(gridCell(page, 9)).not.toHaveAttribute("data-rejected");
});

test("Not duplicates dismisses the group without flagging photos", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openDuplicates(page);

	await group(page, "burst:6,7,8")
		.getByRole("button", { name: "Not duplicates" })
		.click();
	await expect
		.poll(() => groupKeys(page))
		.toEqual(["duplicate:2,5,9", "duplicate:10,12", "duplicate:1,3"]);
	await expect(kindRadio(page, "Bursts")).toHaveText("Bursts(0)");
	await expect(duplicatesItem(page)).toContainText("3");
	await expect
		.poll(() => calls.resolveDuplicateGroup)
		.toEqual([{ key: "burst:6,7,8", action: "dismiss" }]);
	await expect
		.poll(() => calls.duplicateGroups?.length ?? 0)
		.toBeGreaterThan(2);
	await expect(group(page, "burst:6,7,8")).toHaveCount(0);

	await page.getByRole("button", { name: "Exit duplicates" }).click();
	await expect(page.getByText(`${FIXTURE_LIBRARY.length} photos`)).toBeVisible();
	for (const id of [6, 7, 8]) {
		await expect(gridCell(page, id)).not.toHaveAttribute("data-rejected");
	}
});

test("a failed resolution restores the group and counts and shows the error", async ({
	page,
	mockBackend,
}) => {
	const release = gate();
	const calls = await mockBackend({
		resolveDuplicateGroup: async () => {
			await release.opened;
			throw new Error("Database is locked");
		},
	});
	await openDuplicates(page);

	await group(page, "duplicate:2,5,9")
		.getByRole("button", { name: "Keep selected, reject 2" })
		.click();
	await expect
		.poll(() => groupKeys(page))
		.toEqual(["burst:6,7,8", "duplicate:10,12", "duplicate:1,3"]);
	await expect(duplicatesItem(page)).toContainText("3");

	release.open();
	await expect.poll(() => groupKeys(page)).toEqual(GROUP_KEYS);
	await expect(duplicatesItem(page)).toContainText("4");
	await expect(kindRadio(page, "Duplicates")).toHaveText("Duplicates(3)");
	await expect(page.getByRole("alert")).toHaveText(
		"Couldn't reject 2 photos: Database is locked",
	);
	expect(calls.resolveDuplicateGroup).toEqual([
		{ key: "duplicate:2,5,9", action: "keep", keepIds: [2] },
	]);

	await page.getByRole("button", { name: "Dismiss error" }).click();
	await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a group that changed since listing shows a conflict and refetches", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend({
		// Another client rejects city.jpg first, so the listed key is stale.
		resolveDuplicateGroup: (input, defaults) => {
			defaults.setPhotoCuration({ photoIds: [9], flag: "reject" }, defaults);
			return defaults.resolveDuplicateGroup(input, defaults);
		},
	});
	await openDuplicates(page);
	const listRequests = calls.duplicateGroups?.length ?? 0;

	await group(page, "duplicate:2,5,9")
		.getByRole("button", { name: "Not duplicates" })
		.click();
	await expect(page.getByRole("alert")).toContainText("This group changed");
	await expect
		.poll(() => calls.duplicateGroups?.length ?? 0)
		.toBeGreaterThan(listRequests);
	// Without city.jpg the duplicate is smaller, so it moves behind the burst.
	await expect
		.poll(() => groupKeys(page))
		.toEqual([
			"burst:6,7,8",
			"duplicate:10,12",
			"duplicate:2,5",
			"duplicate:1,3",
		]);
	await expect(duplicatesItem(page)).toContainText("4");
	expect(calls.resolveDuplicateGroup).toEqual([
		{ key: "duplicate:2,5,9", action: "dismiss" },
	]);
});

test("Load more requests the next page by cursor", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend({
		// Two groups per page so the fixture library spans two pages.
		duplicateGroups: (input, defaults) => {
			const request = input as { limit?: number };
			return defaults.duplicateGroups(
				request.limit === 1 ? request : { ...request, limit: 2 },
				defaults,
			);
		},
	});
	await page.goto("/");
	await expect(duplicatesItem(page)).toContainText("4");
	await duplicatesItem(page).click();
	await expect
		.poll(() => groupKeys(page))
		.toEqual(["duplicate:2,5,9", "burst:6,7,8"]);

	await page.getByRole("button", { name: "Load more" }).click();
	await expect.poll(() => groupKeys(page)).toEqual(GROUP_KEYS);
	expect(calls.duplicateGroups?.at(-1)).toMatchObject({ cursor: "2" });
	await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
});

test("choosing a folder leaves Duplicates for the library", async ({
	page,
	mockBackend,
}) => {
	await mockBackend();
	await openDuplicates(page);

	await leftPanel(page)
		.getByRole("button", { name: /^All Photos/ })
		.click();
	await expect(page.getByTestId("duplicates-header")).toHaveCount(0);
	await expect(duplicatesItem(page)).toHaveAttribute("aria-pressed", "false");
	await expect(page.getByText(`${FIXTURE_LIBRARY.length} photos`)).toBeVisible();
	await expect(gridCell(page, 1)).toBeVisible();
});
